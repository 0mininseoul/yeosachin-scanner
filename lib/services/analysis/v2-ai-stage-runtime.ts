import { z } from 'zod';
import {
    AI_STAGE_POLICY_LATEST_VERSION,
    assertSupportedAiStagePolicyVersion,
    type AiStagePolicyVersion,
} from '@/lib/services/ai/stage-policy';
import {
    analyzePrivateAccountNames,
    createPrivateNameBatchResponseSchema,
    type PrivateNameAccountInput,
    type PrivateNameAnalysisAudit,
    type PrivateNameAnalysisResult,
} from '@/lib/services/ai/private-name-analysis';
import {
    createFeatureAnalysisResultIdentity,
    createGenderResolutionResultIdentity,
    createGenderTriageResultIdentity,
    createHighRiskNarrativeResultIdentity,
    createPartnerSafetyResultIdentity,
    featureAnalysis,
    featureAnalysisModelResponseSchema,
    genderResolution,
    genderResolutionCheckpointAssessment,
    genderResolutionModelResponseSchema,
    genderTriage,
    genderTriageModelResponseSchema,
    highRiskNarrative,
    highRiskNarrativeModelResponseSchema,
    partnerSafetyAnalysis,
    partnerSafetyModelResponseSchema,
    type FeatureAnalysisInput,
    type FeatureAnalysisResult,
    type GenderResolutionInput,
    type GenderResolutionResult,
    type GenderTriageInput,
    type GenderTriageResult,
    type HighRiskNarrativeInput,
    type HighRiskNarrativeResult,
    type PartnerSafetyInput,
    type PartnerSafetyResult,
} from '@/lib/services/ai/v2-staged-analysis';
import {
    AnalysisV2AiResultRecoveredCutoffError,
    AnalysisV2AiResultRecoveryPendingError,
    createAnalysisV2AiAuditAdapter,
    createAnalysisV2AiResultContentHash,
    type AnalysisV2AiAuditAdapter,
    type AnalysisV2AiResultIdentity,
} from './v2-ai-result-store';

export interface AnalysisV2AiJobFence {
    requestId: string;
    jobKey: string;
    claimToken: string;
    aiStagePolicyVersion: string;
    handlerDeadlineAtMs?: number;
}

export interface AnalysisV2AuditedResult<T> {
    result: T;
    operationKey: string;
    resultHash: string | null;
    source: 'checkpoint' | 'safe_fallback' | 'feature_only';
}

export interface AnalysisV2PrivateNameAuditedResult {
    results: readonly PrivateNameAnalysisResult[];
    operationKey: string;
    resultHash: string | null;
    source: 'checkpoint' | 'safe_fallback';
}

export interface AnalysisV2AiStageRuntime {
    gender(
        input: GenderTriageInput,
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2AuditedResult<GenderTriageResult>>;
    startGenderResolution(
        input: GenderResolutionInput,
        fence: AnalysisV2AiJobFence
    ): AnalysisV2GenderResolutionHandle;
    features(
        input: FeatureAnalysisInput,
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2AuditedResult<FeatureAnalysisResult>>;
    privateNames(
        input: readonly PrivateNameAccountInput[],
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2PrivateNameAuditedResult>;
    partnerSafety(
        input: PartnerSafetyInput,
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2AuditedResult<PartnerSafetyResult>>;
    narrative(
        input: HighRiskNarrativeInput,
        fence: AnalysisV2AiJobFence
    ): Promise<AnalysisV2AuditedResult<HighRiskNarrativeResult>>;
}

export type AnalysisV2GenderResolutionState =
    | { status: 'pending' }
    | {
        status: 'ready';
        value: AnalysisV2AuditedResult<GenderResolutionResult>;
    }
    | { status: 'cutoff' }
    | { status: 'recovery_pending' }
    | { status: 'capacity_skipped' }
    | { status: 'terminal_unavailable' };

export interface AnalysisV2GenderResolutionHandle {
    operationKey: string;
    completion: Promise<void>;
    peek(): AnalysisV2GenderResolutionState;
    cutoff(): Promise<void>;
}

type AuditFactory = <T>(options: Parameters<typeof createAnalysisV2AiAuditAdapter<T>>[0]) =>
AnalysisV2AiAuditAdapter<T>;

export interface AnalysisV2AiStageRuntimeDependencies {
    createAudit?: AuditFactory;
    runGender?: typeof genderTriage;
    runGenderResolution?: typeof genderResolution;
    runFeatures?: typeof featureAnalysis;
    runPrivateNames?: typeof analyzePrivateAccountNames;
    runPartnerSafety?: typeof partnerSafetyAnalysis;
    runNarrative?: typeof highRiskNarrative;
}

const GENDER_RESOLUTION_CUTOFF_BOOKKEEPING_WAIT_MS = 25;

export class AnalysisV2GenderResolutionCutoffPersistenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_GENDER_RESOLUTION_CUTOFF_PERSISTENCE_ERROR');
        this.name = 'AnalysisV2GenderResolutionCutoffPersistenceError';
    }
}

async function waitForCutoffBookkeeping(
    operation: () => Promise<void> | undefined
): Promise<void> {
    const handled = Promise.resolve()
        .then(operation)
        .then(
            () => ({ status: 'fulfilled' as const }),
            (error: unknown) => ({ status: 'rejected' as const, error }),
        );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
        handled,
        new Promise<{ status: 'timed_out' }>(resolve => {
            timer = setTimeout(
                () => resolve({ status: 'timed_out' }),
                GENDER_RESOLUTION_CUTOFF_BOOKKEEPING_WAIT_MS
            );
        }),
    ]);
    if (timer) clearTimeout(timer);
    if (
        outcome.status === 'rejected'
        && (
            outcome.error instanceof AnalysisV2AiResultRecoveryPendingError
            || outcome.error instanceof AnalysisV2AiResultRecoveredCutoffError
        )
    ) {
        throw outcome.error;
    }
    if (outcome.status !== 'fulfilled') {
        throw new AnalysisV2GenderResolutionCutoffPersistenceError();
    }
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('ANALYSIS_V2_AI_RUNTIME_INVALID_JSON');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map(canonicalJson).join(',')}]`;
    }
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => (
            `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        )).join(',')}}`;
    }
    throw new Error('ANALYSIS_V2_AI_RUNTIME_INVALID_JSON');
}

export function analysisV2CanonicalAiResultHash(value: unknown): string {
    return createAnalysisV2AiResultContentHash(canonicalJson(value));
}

function adapter<T>(
    createAudit: AuditFactory,
    fence: AnalysisV2AiJobFence,
    resultIdentity: AnalysisV2AiResultIdentity,
    resultSchema: z.ZodType<T>
): AnalysisV2AiAuditAdapter<T> {
    const { requestId, jobKey, claimToken } = fence;
    return createAudit({
        requestId,
        jobKey,
        claimToken,
        aiStagePolicyVersion: assertAiStagePolicyVersion(fence),
        resultIdentity,
        resultSchema,
        handlerDeadlineAtMs: fence.handlerDeadlineAtMs,
    });
}

function assertAiStagePolicyVersion(fence: AnalysisV2AiJobFence): AiStagePolicyVersion {
    try {
        return assertSupportedAiStagePolicyVersion(fence.aiStagePolicyVersion);
    } catch {
        throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
    }
}

function assertGenderResolutionPolicyVersion(fence: AnalysisV2AiJobFence): void {
    assertAiStagePolicyVersion(fence);
    if (fence.aiStagePolicyVersion !== AI_STAGE_POLICY_LATEST_VERSION) {
        throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
    }
}

/**
 * Production runtime for the already-defined staged AI functions. Provider calls stay behind this
 * interface, so executor tests never need Vertex credentials and retry replay remains auditable.
 */
export function createDurableAnalysisV2AiStageRuntime(
    dependencies: AnalysisV2AiStageRuntimeDependencies = {}
): AnalysisV2AiStageRuntime {
    const createAudit = dependencies.createAudit ?? createAnalysisV2AiAuditAdapter;
    const runGender = dependencies.runGender ?? genderTriage;
    const runGenderResolution = dependencies.runGenderResolution ?? genderResolution;
    const runFeatures = dependencies.runFeatures ?? featureAnalysis;
    const runPrivateNames = dependencies.runPrivateNames ?? analyzePrivateAccountNames;
    const runPartnerSafety = dependencies.runPartnerSafety ?? partnerSafetyAnalysis;
    const runNarrative = dependencies.runNarrative ?? highRiskNarrative;

    return {
        async gender(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            const identity = createGenderTriageResultIdentity(input, policyVersion);
            const audit = adapter(
                createAudit,
                fence,
                identity,
                genderTriageModelResponseSchema
            );
            const result = await runGender(input, audit, {
                aiStagePolicyVersion: policyVersion,
            });
            return {
                result,
                operationKey: identity.operationKey,
                resultHash: analysisV2CanonicalAiResultHash(result.assessment),
                source: 'checkpoint',
            };
        },

        startGenderResolution(input, fence) {
            assertGenderResolutionPolicyVersion(fence);
            const identity = createGenderResolutionResultIdentity(input);
            const audit = adapter(
                createAudit,
                fence,
                identity,
                genderResolutionModelResponseSchema,
            );
            const controller = new AbortController();
            let state: AnalysisV2GenderResolutionState = { status: 'pending' };
            let cutoffStarted: Promise<void> | null = null;
            const completion = (async () => {
                try {
                    const result = await runGenderResolution(
                        input,
                        audit,
                        { abortSignal: controller.signal },
                    );
                    if (state.status !== 'pending') return;
                    state = {
                        status: 'ready',
                        value: {
                            result,
                            operationKey: identity.operationKey,
                            resultHash: analysisV2CanonicalAiResultHash(
                                genderResolutionCheckpointAssessment(
                                    input,
                                    result.assessment
                                )
                            ),
                            source: 'checkpoint',
                        },
                    };
                } catch (error) {
                    if (state.status !== 'pending') return;
                    state = {
                        status: error instanceof AnalysisV2AiResultRecoveryPendingError
                            ? 'recovery_pending'
                            : error instanceof AnalysisV2AiResultRecoveredCutoffError
                                ? 'cutoff'
                                : error instanceof Error
                                    && error.message
                                        === 'ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED'
                                    ? 'capacity_skipped'
                                    : 'terminal_unavailable',
                    };
                }
            })();
            return {
                operationKey: identity.operationKey,
                completion,
                peek: () => state,
                cutoff() {
                    if (cutoffStarted) return cutoffStarted;
                    cutoffStarted = (async () => {
                        if (state.status !== 'pending') return;
                        state = { status: 'cutoff' };
                        controller.abort();
                        try {
                            await waitForCutoffBookkeeping(() => audit.cutoff?.());
                        } catch (error) {
                            if (error instanceof AnalysisV2AiResultRecoveryPendingError) {
                                state = { status: 'recovery_pending' };
                            }
                            if (error instanceof AnalysisV2AiResultRecoveredCutoffError) {
                                state = { status: 'cutoff' };
                                return;
                            }
                            throw error;
                        }
                    })();
                    return cutoffStarted;
                },
            };
        },

        async features(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            const identity = createFeatureAnalysisResultIdentity(input, policyVersion);
            const audit = adapter(
                createAudit,
                fence,
                identity,
                featureAnalysisModelResponseSchema
            );
            const result = await runFeatures(input, audit, {
                aiStagePolicyVersion: policyVersion,
            });
            return {
                result,
                operationKey: identity.operationKey,
                resultHash: analysisV2CanonicalAiResultHash(result.features),
                source: 'checkpoint',
            };
        },

        async privateNames(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            let operationKey: string | null = null;
            let envelopeHash: string | null = null;
            let checkpointed = false;
            const responseSchema = createPrivateNameBatchResponseSchema(
                input.map(account => account.id)
            );
            const envelopeSchema = z.object({ results: responseSchema }).strict();
            const audit: PrivateNameAnalysisAudit = {
                forChunk(identity) {
                    if (identity.chunkIndex !== 0 || operationKey !== null) {
                        throw new Error('ANALYSIS_V2_PRIVATE_NAME_BATCH_IDENTITY_DRIFT');
                    }
                    operationKey = identity.operationKey;
                    const durable = adapter(
                        createAudit,
                        fence,
                        identity.resultIdentity,
                        envelopeSchema
                    );
                    return {
                        requestId: durable.requestId,
                        operationKey: durable.operationKey,
                        resultIdentity: durable.resultIdentity,
                        async prepare() {
                            const prepared = await durable.prepare();
                            if (prepared.result) {
                                checkpointed = true;
                                envelopeHash = analysisV2CanonicalAiResultHash(prepared.result);
                            }
                            return {
                                ...prepared,
                                result: prepared.result?.results ?? null,
                            };
                        },
                        onBeforeAttempt: telemetry => durable.onBeforeAttempt(telemetry),
                        async onAttemptTelemetry(telemetry, parsedResult) {
                            const envelope = parsedResult === undefined
                                ? undefined
                                : { results: responseSchema.parse(parsedResult) };
                            await durable.onAttemptTelemetry(telemetry, envelope);
                            if (telemetry.disposition === 'success' && envelope) {
                                checkpointed = true;
                                envelopeHash = analysisV2CanonicalAiResultHash(envelope);
                            }
                        },
                    };
                },
            };
            const results = await runPrivateNames(
                [...input],
                fence.requestId,
                audit,
                { aiStagePolicyVersion: policyVersion },
            );
            if (operationKey === null) {
                throw new Error('ANALYSIS_V2_PRIVATE_NAME_OPERATION_MISSING');
            }
            return {
                results,
                operationKey,
                resultHash: checkpointed ? envelopeHash : null,
                source: checkpointed ? 'checkpoint' : 'safe_fallback',
            };
        },

        async partnerSafety(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            const identity = createPartnerSafetyResultIdentity(input, policyVersion);
            if (!identity) {
                const result = await runPartnerSafety(
                    input,
                    undefined,
                    { aiStagePolicyVersion: policyVersion },
                );
                return {
                    result,
                    operationKey: '',
                    resultHash: null,
                    source: 'feature_only',
                };
            }
            const audit = adapter(
                createAudit,
                fence,
                identity,
                partnerSafetyModelResponseSchema
            );
            const result = await runPartnerSafety(
                input,
                audit,
                { aiStagePolicyVersion: policyVersion },
            );
            return {
                result,
                operationKey: identity.operationKey,
                resultHash: result.source === 'gemini' && result.assessment
                    ? analysisV2CanonicalAiResultHash(result.assessment)
                    : null,
                source: result.source === 'safe_fallback' ? 'safe_fallback' : 'checkpoint',
            };
        },

        async narrative(input, fence) {
            const policyVersion = assertAiStagePolicyVersion(fence);
            const identity = createHighRiskNarrativeResultIdentity(input, policyVersion);
            const audit = adapter(
                createAudit,
                fence,
                identity,
                highRiskNarrativeModelResponseSchema
            );
            const result = await runNarrative(
                input,
                audit,
                { aiStagePolicyVersion: policyVersion },
            );
            const modelEnvelope = {
                lines: [
                    { text: result.lines[0], evidenceRefs: result.evidenceRefs[0] },
                    { text: result.lines[1], evidenceRefs: result.evidenceRefs[1] },
                ],
            };
            return {
                result,
                operationKey: identity.operationKey,
                resultHash: result.source === 'gemini'
                    ? analysisV2CanonicalAiResultHash(modelEnvelope)
                    : null,
                source: result.source === 'safe_fallback' ? 'safe_fallback' : 'checkpoint',
            };
        },
    };
}
