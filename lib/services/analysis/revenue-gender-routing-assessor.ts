import 'server-only';

import { z } from 'zod';
import {
    analyzeWithGemini,
    GeminiPreDispatchAdmissionError,
    type GeminiAttemptStartTelemetry,
    type GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';
import { AI_STAGE_POLICY_V29_VERSION, getAiStagePolicy } from '@/lib/services/ai/stage-policy';
import { AI_GENERATION_RESPONSE_REJECTED_ERROR_PREFIX } from '@/lib/services/ai/gemini-generation-policy';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { GenderRoutingAssessment, GenderRoutingEvidence } from './gender-routing';
import {
    createRevenueCostAiAttemptLifecycle,
    type RevenueCostAiAttemptCallbacks,
    type RevenueCostAiAttemptLifecycle,
} from './revenue-cost-ai-attempt-lifecycle';
import { RevenueCostOperationStore } from './revenue-cost-operation-store';
import type { RevenueGenderRoutingModelCandidate } from './revenue-routing-runtime';
import {
    AnalysisV2AiResultReplayBlockedError,
    createAnalysisV2AiAuditAdapter,
    createAnalysisV2AiMediaSnapshotHash,
    createAnalysisV2AiResultIdentity,
    createAnalysisV2AiResultInputHash,
    type AnalysisV2AiAuditAdapter,
    type AnalysisV2AiResultIdentity,
    type CreateAnalysisV2AiAuditAdapterOptions,
} from './v2-ai-result-store';

/**
 * This is intentionally the existing cost-audited genderTriage policy, not a
 * new free-form Gemini setting. The revenue ledger only permits this exact
 * immutable tuple for stage-one routing reservations.
 */
export const REVENUE_GENDER_ROUTING_AI_STAGE_POLICY_VERSION = AI_STAGE_POLICY_V29_VERSION;
export const REVENUE_GENDER_ROUTING_PROMPT_VERSION = 'gender-triage-microbatch-v1';
export const REVENUE_GENDER_ROUTING_SCHEMA_VERSION = 3;
export const REVENUE_GENDER_ROUTING_MAX_OUTPUT_TOKENS = 1_024;
export const REVENUE_GENDER_ROUTING_MAX_BATCH_SIZE = 10;

const RESPONSE_REJECTED_PREFIX = AI_GENERATION_RESPONSE_REJECTED_ERROR_PREFIX;
const SAFE_INPUT_HMAC = /^[a-f0-9]{64}$/;

const evidenceSchema = z.enum([
    'image_and_name',
    'image_only',
    'name_only',
    'none',
]);

const responseEntrySchema = z.object({
    index: z.number().int().min(0).max(REVENUE_GENDER_ROUTING_MAX_BATCH_SIZE - 1),
    female_score: z.number().finite().min(0).max(1),
    male_score: z.number().finite().min(0).max(1),
    uncertainty_score: z.number().finite().min(0).max(1),
    evidence: evidenceSchema,
}).strict();

interface RevenueGenderRoutingResponse {
    /**
     * The Gemini JSON envelope stays strict, while entries remain raw until
     * they are validated against the corresponding candidate below.  A bad
     * row must not discard another row that was already auditable and valid.
     */
    readonly assessments: readonly unknown[];
}

export type RevenueGenderRoutingAssessorAuditAdapter = AnalysisV2AiAuditAdapter<
    RevenueGenderRoutingResponse
>;

export type RevenueGenderRoutingAssessorAuditAdapterFactory = (
    options: CreateAnalysisV2AiAuditAdapterOptions<RevenueGenderRoutingResponse>,
) => RevenueGenderRoutingAssessorAuditAdapter;

export interface RevenueGenderRoutingAssessorFence {
    readonly requestId: string;
    readonly jobKey: 'track:relationships:collect';
    readonly jobClaimToken: string;
    readonly jobInputHash: string;
    readonly accessMode: 'production' | 'test_entitlement';
    readonly planId: 'basic' | 'standard' | 'plus';
    readonly handlerDeadlineAtMs?: number;
}

export type RevenueGenderRoutingAssessor = (
    candidates: readonly RevenueGenderRoutingModelCandidate[],
    attempt: 1 | 2,
) => Promise<ReadonlyMap<string, GenderRoutingAssessment>>;

export type RevenueGenderRoutingAssessorFactory = (
    fence: RevenueGenderRoutingAssessorFence,
) => RevenueGenderRoutingAssessor;

export interface CreateRevenueGenderRoutingAssessorFactoryOptions {
    /** Kept injectable only at the external Gemini boundary for deterministic tests. */
    readonly analyze?: typeof analyzeWithGemini;
    readonly auditAdapterFactory?: RevenueGenderRoutingAssessorAuditAdapterFactory;
    readonly costLifecycle?: RevenueCostAiAttemptLifecycle;
}

function expectedEvidence(candidate: RevenueGenderRoutingModelCandidate): GenderRoutingEvidence {
    return candidate.imageBase64 !== null
        ? candidate.fullname !== null ? 'image_and_name' : 'image_only'
        : candidate.fullname !== null ? 'name_only' : 'none';
}

function assertCandidates(
    candidates: readonly RevenueGenderRoutingModelCandidate[],
): void {
    if (candidates.length < 1 || candidates.length > REVENUE_GENDER_ROUTING_MAX_BATCH_SIZE) {
        throw new Error('REVENUE_GENDER_ROUTING_ASSESSOR_INPUT_INVALID');
    }
    const keys = new Set<string>();
    for (const candidate of candidates) {
        if (
            typeof candidate.candidateKey !== 'string'
            || !candidate.candidateKey
            || !SAFE_INPUT_HMAC.test(candidate.inputHmac)
            || (candidate.fullname !== null && (
                typeof candidate.fullname !== 'string'
                || candidate.fullname.length < 1
                || candidate.fullname.length > 200
            ))
            || (candidate.imageBase64 !== null && (
                typeof candidate.imageBase64 !== 'string'
                || candidate.imageBase64.length < 4
            ))
            || !keys.add(candidate.candidateKey)
        ) throw new Error('REVENUE_GENDER_ROUTING_ASSESSOR_INPUT_INVALID');
        if (candidate.fullname === null && candidate.imageBase64 === null) {
            throw new Error('REVENUE_GENDER_ROUTING_ASSESSOR_EMPTY_EVIDENCE');
        }
    }
}

/**
 * This prompt deliberately assigns opaque zero-based positions. Candidate
 * keys, URLs, handles, bios, and persisted profile fields never cross the
 * model boundary. `JSON.stringify` preserves missing fullname explicitly and
 * prevents a name from changing the surrounding instruction syntax.
 */
function promptFor(
    candidates: readonly RevenueGenderRoutingModelCandidate[],
): string {
    let imageIndex = 0;
    const inputs = candidates.map((candidate, index) => {
        const imageAttachment = candidate.imageBase64 === null
            ? null
            : imageIndex++;
        return {
            index,
            fullname: candidate.fullname,
            profile_image_attachment: imageAttachment,
            required_evidence: expectedEvidence(candidate),
        };
    });
    return [
        'gender-routing-assessor-v1',
        'Classify only the supplied first-pass routing evidence for each numbered record.',
        'Do not infer or request any identity beyond the supplied fullname and attached profile image.',
        'Return one assessment for every record, ordered by neither name nor identity but by its numeric index.',
        'female_score, male_score, and uncertainty_score must be finite numbers from 0 through 1 whose sum is between 0.99 and 1.01.',
        'evidence must exactly equal required_evidence. A null fullname or null profile_image_attachment is absent evidence.',
        'Do not include prose or fields outside the JSON schema.',
        `records=${JSON.stringify(inputs)}`,
    ].join('\n');
}

function responseSchemaFor(
): z.ZodType<RevenueGenderRoutingResponse> {
    return z.object({
        // A response can contain at most one row per microbatch input.  Do
        // not make the transport parser validate fields in each row here: it
        // would reject the complete batch before valid sibling rows could be
        // retained.  Individual row validation is deliberately strict in
        // mapResponse.
        assessments: z.array(z.unknown()).max(REVENUE_GENDER_ROUTING_MAX_BATCH_SIZE),
    }).strict();
}

/** Only HMACs and input-presence bits participate in durable identity material. */
function identityFor(
    candidates: readonly RevenueGenderRoutingModelCandidate[],
    routingAttempt: 1 | 2,
): AnalysisV2AiResultIdentity {
    const policy = getAiStagePolicy(REVENUE_GENDER_ROUTING_AI_STAGE_POLICY_VERSION, 'genderTriage');
    if (
        policy.model !== 'gemini-3.1-flash-lite'
        || policy.thinkingLevel !== 'MINIMAL'
        || policy.mediaResolution !== 'LOW'
        || policy.promptVersion !== REVENUE_GENDER_ROUTING_PROMPT_VERSION
        || policy.schemaVersion !== REVENUE_GENDER_ROUTING_SCHEMA_VERSION
        || policy.maxOutputTokens !== REVENUE_GENDER_ROUTING_MAX_OUTPUT_TOKENS
    ) throw new Error('REVENUE_GENDER_ROUTING_ASSESSOR_POLICY_DRIFT');

    const safeRows = candidates.map(candidate => Object.freeze({
        input_hmac: candidate.inputHmac,
        has_fullname: candidate.fullname !== null,
        has_image: candidate.imageBase64 !== null,
    }));
    const canonicalInput = JSON.stringify({
        domain: 'gender-routing-assessor-input-v1',
        routing_attempt: routingAttempt,
        rows: safeRows,
    });
    const canonicalMedia = JSON.stringify({
        domain: 'gender-routing-assessor-media-v1',
        images: safeRows.map((row, index) => row.has_image ? [index, row.input_hmac] : null),
    });
    return createAnalysisV2AiResultIdentity({
        stage: 'genderTriage',
        modelName: policy.model,
        thinkingLevel: policy.thinkingLevel,
        mediaResolution: policy.mediaResolution,
        promptVersion: policy.promptVersion,
        schemaVersion: policy.schemaVersion,
        maxOutputTokens: policy.maxOutputTokens,
        inputHash: createAnalysisV2AiResultInputHash(canonicalInput),
        mediaSnapshotHash: createAnalysisV2AiMediaSnapshotHash(canonicalMedia),
        // This identity is audit-only for the assessor. `disableResultCheckpoint`
        // ensures no routing result cache is read or written for this stage.
        cacheScope: 'request',
    });
}

function mapResponse(
    candidates: readonly RevenueGenderRoutingModelCandidate[],
    response: RevenueGenderRoutingResponse,
): ReadonlyMap<string, GenderRoutingAssessment> {
    const mapped = new Map<string, GenderRoutingAssessment>();
    const invalidIndexes = new Set<number>();
    const seenIndexes = new Set<number>();
    const indexFor = (value: unknown): number | null => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const index = (value as { index?: unknown }).index;
        return typeof index === 'number'
            && Number.isInteger(index)
            && index >= 0
            && index < candidates.length
            ? index
            : null;
    };
    const rejectIndex = (index: number | null) => {
        if (index === null) return;
        invalidIndexes.add(index);
        const candidate = candidates[index];
        if (candidate) mapped.delete(candidate.candidateKey);
    };

    for (const rawEntry of response.assessments) {
        const hintedIndex = indexFor(rawEntry);
        const parsed = responseEntrySchema.safeParse(rawEntry);
        if (!parsed.success) {
            rejectIndex(hintedIndex);
            continue;
        }
        const entry = parsed.data;
        const candidate = candidates[entry.index];
        if (!candidate || seenIndexes.has(entry.index) || invalidIndexes.has(entry.index)) {
            rejectIndex(hintedIndex);
            continue;
        }
        seenIndexes.add(entry.index);
        const total = entry.female_score + entry.male_score + entry.uncertainty_score;
        if (
            !Number.isFinite(total)
            || total < 0.99
            || total > 1.01
            || entry.evidence !== expectedEvidence(candidate)
        ) {
            rejectIndex(entry.index);
            continue;
        }
        mapped.set(candidate.candidateKey, Object.freeze({
            femaleScore: entry.female_score,
            maleScore: entry.male_score,
            uncertaintyScore: entry.uncertainty_score,
            evidence: entry.evidence,
        }));
    }
    return mapped;
}

function preDispatchRejected(
    telemetry: GeminiAttemptStartTelemetry,
): GeminiAttemptTelemetry {
    return {
        ...telemetry,
        tokenUsage: null,
        usageComplete: false,
        usageMetadataStatus: 'missing',
        latencyMs: 0,
        estimatedCostUsd: null,
        disposition: 'rejected',
        finishReason: null,
    };
}

/**
 * The callback composition is deliberately ordered rather than parallel:
 * audit intent -> cost reserve/start -> Gemini -> audit terminal -> cost
 * settlement. Once the external boundary was crossed, either terminal write
 * failure becomes a durable manual-review signal instead of a blind retry.
 */
function composeCallbacks(input: {
    readonly audit: RevenueGenderRoutingAssessorAuditAdapter;
    readonly cost: RevenueCostAiAttemptCallbacks;
}): Pick<Parameters<typeof analyzeWithGemini>[2], 'onBeforeAttempt' | 'onAttemptTelemetry'> {
    return {
        async onBeforeAttempt(telemetry) {
            try {
                await input.audit.onBeforeAttempt(telemetry);
            } catch (error) {
                // A replay-blocked reservation is the one proven no-call
                // path: the durable audit row already forbids dispatch. Any
                // other failure might be a lost response after reservation
                // commit and therefore has to enter manual review first.
                if (error instanceof AnalysisV2AiResultReplayBlockedError) {
                    throw error;
                }
                await input.cost.manualReviewAfterExternalBoundary();
                throw error;
            }
            try {
                await input.cost.onBeforeAttempt(telemetry);
            } catch {
                // The audit reservation happened but Gemini has not. Terminalize that
                // intent as a proven no-call rejection before exposing an admission error.
                try {
                    await input.audit.onAttemptTelemetry(preDispatchRejected(telemetry));
                } catch {
                    await input.cost.manualReviewAfterExternalBoundary();
                    throw new GeminiPreDispatchAdmissionError();
                }
                throw new GeminiPreDispatchAdmissionError();
            }
        },
        async onAttemptTelemetry(telemetry, parsedResult) {
            try {
                await input.audit.onAttemptTelemetry(telemetry, parsedResult);
            } catch (error) {
                await input.cost.manualReviewAfterExternalBoundary();
                throw error;
            }
            try {
                await input.cost.onAttemptTelemetry(telemetry, parsedResult);
            } catch (error) {
                await input.cost.manualReviewAfterExternalBoundary();
                throw error;
            }
        },
    };
}

function isResponseRejected(error: unknown): boolean {
    return error instanceof Error && error.message.startsWith(RESPONSE_REJECTED_PREFIX);
}

/**
 * Creates the actual production assessor. Its outer pass number is part of a
 * new immutable operation identity; Gemini's transport-level 429 retry keeps
 * its own exact attempt sequence inside that operation. Thus failed routing
 * candidates are charged again without pretending a response rejection was a
 * rate-limit retry.
 */
export function createRevenueGenderRoutingAssessorFactory(
    options: CreateRevenueGenderRoutingAssessorFactoryOptions = {},
): RevenueGenderRoutingAssessorFactory {
    const analyze = options.analyze ?? analyzeWithGemini;
    const auditAdapterFactory = options.auditAdapterFactory ?? createAnalysisV2AiAuditAdapter;
    const costLifecycle = options.costLifecycle ?? createRevenueCostAiAttemptLifecycle(
        new RevenueCostOperationStore(supabaseAdmin),
    );
    return fence => {
        if (
            fence.accessMode !== 'test_entitlement'
            || (fence.planId !== 'basic' && fence.planId !== 'standard')
            || fence.jobKey !== 'track:relationships:collect'
        ) throw new Error('REVENUE_GENDER_ROUTING_ASSESSOR_SCOPE_INVALID');

        return async (candidates, routingAttempt) => {
            assertCandidates(candidates);
            const schema = responseSchemaFor();
            const resultIdentity = identityFor(candidates, routingAttempt);
            const audit = auditAdapterFactory({
                requestId: fence.requestId,
                jobKey: fence.jobKey,
                claimToken: fence.jobClaimToken,
                resultIdentity,
                resultSchema: schema,
                aiStagePolicyVersion: REVENUE_GENDER_ROUTING_AI_STAGE_POLICY_VERSION,
                ...(fence.handlerDeadlineAtMs === undefined
                    ? {}
                    : { handlerDeadlineAtMs: fence.handlerDeadlineAtMs }),
                disableResultCheckpoint: true,
            });
            const prepared = await audit.prepare();
            if (prepared.result !== null || prepared.source !== null || prepared.startingAttempt !== 1) {
                throw new Error('REVENUE_GENDER_ROUTING_ASSESSOR_CACHE_FORBIDDEN');
            }
            const cost = costLifecycle.bind({
                scope: {
                    accessMode: fence.accessMode,
                    planId: fence.planId,
                },
                fence: {
                    requestId: fence.requestId,
                    jobKey: fence.jobKey,
                    jobClaimToken: fence.jobClaimToken,
                    jobInputHash: fence.jobInputHash,
                    operationKey: audit.operationKey,
                    routingAttempt,
                },
            });
            try {
                const response = await analyze(
                    promptFor(candidates),
                    candidates.flatMap(candidate => (
                        candidate.imageBase64 === null ? [] : [candidate.imageBase64]
                    )),
                    {
                        schema,
                        analysisType: 'gender_routing_assessor',
                        requestId: fence.requestId,
                        stage: 'genderTriage',
                        aiStagePolicyVersion: REVENUE_GENDER_ROUTING_AI_STAGE_POLICY_VERSION,
                        maxImages: REVENUE_GENDER_ROUTING_MAX_BATCH_SIZE,
                        startingAttempt: prepared.startingAttempt,
                        ...composeCallbacks({ audit, cost }),
                    },
                );
                return mapResponse(candidates, response);
            } catch (error) {
                // A strict parser rejection is a failed candidate set, not an
                // ambiguous boundary. The routing runtime retries only this set
                // once using its separate outer operation identity.
                if (isResponseRejected(error)) return new Map();
                throw error;
            }
        };
    };
}
