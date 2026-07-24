import { z } from 'zod';
import { AI_STAGE_POLICY_VERSION } from '@/lib/services/ai/stage-policy';
import {
    analyzePrivateAccountNames,
    createPrivateNameBatchResponseSchema,
    type PrivateNameAccountInput,
    type PrivateNameAnalysisAudit,
    type PrivateNameAnalysisResult,
} from '@/lib/services/ai/private-name-analysis';
import {
    createFeatureAnalysisResultIdentity,
    createGenderTriageResultIdentity,
    createHighRiskNarrativeResultIdentity,
    createPartnerSafetyResultIdentity,
    featureAnalysis,
    featureAnalysisModelResponseSchema,
    genderTriage,
    genderTriageModelResponseSchema,
    highRiskNarrative,
    highRiskNarrativeModelResponseSchema,
    partnerSafetyAnalysis,
    partnerSafetyModelResponseSchema,
    type FeatureAnalysisInput,
    type FeatureAnalysisResult,
    type GenderTriageInput,
    type GenderTriageResult,
    type HighRiskNarrativeInput,
    type HighRiskNarrativeResult,
    type PartnerSafetyInput,
    type PartnerSafetyResult,
} from '@/lib/services/ai/v2-staged-analysis';
import {
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

type AuditFactory = <T>(options: Parameters<typeof createAnalysisV2AiAuditAdapter<T>>[0]) =>
AnalysisV2AiAuditAdapter<T>;

export interface AnalysisV2AiStageRuntimeDependencies {
    createAudit?: AuditFactory;
    runGender?: typeof genderTriage;
    runFeatures?: typeof featureAnalysis;
    runPrivateNames?: typeof analyzePrivateAccountNames;
    runPartnerSafety?: typeof partnerSafetyAnalysis;
    runNarrative?: typeof highRiskNarrative;
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
        resultIdentity,
        resultSchema,
        handlerDeadlineAtMs: fence.handlerDeadlineAtMs,
    });
}

function assertAiStagePolicyVersion(fence: AnalysisV2AiJobFence): void {
    if (fence.aiStagePolicyVersion !== AI_STAGE_POLICY_VERSION) {
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
    const runFeatures = dependencies.runFeatures ?? featureAnalysis;
    const runPrivateNames = dependencies.runPrivateNames ?? analyzePrivateAccountNames;
    const runPartnerSafety = dependencies.runPartnerSafety ?? partnerSafetyAnalysis;
    const runNarrative = dependencies.runNarrative ?? highRiskNarrative;

    return {
        async gender(input, fence) {
            assertAiStagePolicyVersion(fence);
            const identity = createGenderTriageResultIdentity(input);
            const audit = adapter(
                createAudit,
                fence,
                identity,
                genderTriageModelResponseSchema
            );
            const result = await runGender(input, audit);
            return {
                result,
                operationKey: identity.operationKey,
                resultHash: analysisV2CanonicalAiResultHash(result.assessment),
                source: 'checkpoint',
            };
        },

        async features(input, fence) {
            assertAiStagePolicyVersion(fence);
            const identity = createFeatureAnalysisResultIdentity(input);
            const audit = adapter(
                createAudit,
                fence,
                identity,
                featureAnalysisModelResponseSchema
            );
            const result = await runFeatures(input, audit);
            return {
                result,
                operationKey: identity.operationKey,
                resultHash: analysisV2CanonicalAiResultHash(result.features),
                source: 'checkpoint',
            };
        },

        async privateNames(input, fence) {
            assertAiStagePolicyVersion(fence);
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
            const results = await runPrivateNames([...input], fence.requestId, audit);
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
            assertAiStagePolicyVersion(fence);
            const identity = createPartnerSafetyResultIdentity(input);
            if (!identity) {
                const result = await runPartnerSafety(input);
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
            const result = await runPartnerSafety(input, audit);
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
            assertAiStagePolicyVersion(fence);
            const identity = createHighRiskNarrativeResultIdentity(input);
            const audit = adapter(
                createAudit,
                fence,
                identity,
                highRiskNarrativeModelResponseSchema
            );
            const result = await runNarrative(input, audit);
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
