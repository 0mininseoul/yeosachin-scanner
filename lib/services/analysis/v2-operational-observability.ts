import { z } from 'zod';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^(?:coordinator:(?:bootstrap|candidate-screening|finalize|join:(?:primary-evidence|final-score))|track:(?:relationships:collect|target-evidence:collect|profiles:batch:[0-9]+|profile-ai:batch:[0-9]+|private-names:batch:[0-9]+|reverse-likes:collect|partner-safety:batch:0|narratives:batch:0))$/;
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

const countSchema = z.number().int().min(0).max(SAFE_INTEGER_MAX);
const moneySchema = z.number().finite().min(0).max(100_000_000);
const timestampSchema = z.string().datetime({ offset: true });
const profileFailureCategorySchema = z.enum([
    'not_found',
    'empty_user',
    'auth',
    'rate_limit',
    'timeout',
    'incomplete',
    'schema',
    'transport',
    'http',
    'unknown',
]);

const profileOutcomeSchema = z.object({
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    source: z.enum(['cache', 'selfhosted', 'fallback', 'repair']),
    status: z.enum(['success', 'unavailable', 'failed']),
    failureCategory: profileFailureCategorySchema.nullable(),
    httpStatus: z.number().int().min(400).max(599).nullable(),
    outcomeCount: z.number().int().min(1).max(30),
    requestCount: z.number().int().min(0).max(300),
    latencyMsTotal: countSchema,
    latencyMsMax: z.number().int().min(0).max(300_000),
}).strict();

const resultCoverageSchema = z.object({
    planId: z.enum(['basic', 'standard', 'plus']),
    followersDeclared: z.number().int().min(0).max(1_200),
    followersCollected: z.number().int().min(0).max(1_200),
    followingDeclared: z.number().int().min(0).max(1_200),
    followingCollected: z.number().int().min(0).max(1_200),
    detectedMutuals: z.number().int().min(0).max(1_200),
    publicMutuals: z.number().int().min(0).max(1_200),
    privateMutuals: z.number().int().min(0).max(1_200),
    screenedMutuals: z.number().int().min(0).max(900),
    notScreenedMutuals: z.number().int().min(0).max(1_200),
    fetchUnavailableCount: z.number().int().min(0).max(900),
    mediaUnavailableCount: z.number().int().min(0).max(900),
    analysisUnavailableCount: z.number().int().min(0).max(900).default(0),
}).strict();

const jobSchema = z.object({
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    track: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    kind: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/),
    batch: z.number().int().min(0).max(100_000).nullable(),
    status: z.enum(['pending', 'processing', 'completed', 'failed', 'cancelled']),
    dispatchState: z.enum(['pending', 'reserved', 'enqueued', 'delivered']),
    attemptCount: z.number().int().min(0).max(100),
    firstStartedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    durationMs: countSchema.nullable(),
    lastErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/).nullable(),
}).strict();

const summarySchema = z.object({
    schemaVersion: z.literal(1),
    requestId: z.string().regex(UUID_PATTERN),
    requestStatus: z.enum(['pending', 'processing', 'completed', 'failed']),
    planId: z.enum(['basic', 'standard', 'plus']),
    timing: z.object({
        createdAt: timestampSchema,
        firstStartedAt: timestampSchema.nullable(),
        completedAt: timestampSchema.nullable(),
        wallTimeMs: countSchema,
        queueDelayMs: countSchema.nullable(),
        processingTimeMs: countSchema.nullable(),
        providerRuntimeMsTotal: countSchema,
        geminiLatencyMsTotal: countSchema,
    }).strict(),
    cost: z.object({
        currency: z.literal('USD'),
        providerActualUsd: moneySchema,
        providerConservativeUsd: moneySchema,
        geminiEstimatedUsd: moneySchema,
        actualPlusGeminiEstimatedUsd: moneySchema,
        conservativePlusGeminiEstimatedUsd: moneySchema,
        gcpInfrastructureIncluded: z.literal(false),
    }).strict(),
    completeness: z.object({
        costComplete: z.boolean(),
        pipelineComplete: z.boolean(),
        resultCoverageAvailable: z.boolean(),
        providerRunCount: countSchema,
        providerActiveCount: countSchema,
        providerUnreconciledCount: countSchema,
        providerActualCostCount: countSchema,
        aiAttemptCount: countSchema,
        aiReservedCount: countSchema,
        aiMissingUsageCount: countSchema,
        aiEstimatedCostCount: countSchema,
        jobCount: countSchema,
        jobPendingCount: countSchema,
        jobProcessingCount: countSchema,
        jobCompletedCount: countSchema,
        jobFailedCount: countSchema,
        jobCancelledCount: countSchema,
        jobAttemptCountTotal: countSchema,
    }).strict(),
    geminiUsage: z.object({
        promptTokens: countSchema,
        completionTokens: countSchema,
        thinkingTokens: countSchema,
    }).strict(),
    profileOutcomes: z.array(profileOutcomeSchema).max(1_000),
    resultCoverage: resultCoverageSchema.nullable(),
}).strict();

const responseSchema = z.object({
    pipelineVersion: z.literal('v2'),
    summary: summarySchema,
    jobs: z.array(jobSchema).max(1_000),
}).strict();

export type AnalysisV2OperationalObservability = z.infer<typeof responseSchema>;

interface RpcResult {
    data: unknown;
    error: { code?: string; message?: string } | null;
}

export interface AnalysisV2OperationalObservabilityClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export const ANALYSIS_V2_OPERATIONAL_OBSERVABILITY_RPC =
    'load_analysis_v2_operational_observability';

function moneyMatches(left: number, right: number): boolean {
    return Math.abs(left - right) <= 0.000000000001;
}

function hasValidSemantics(value: AnalysisV2OperationalObservability): boolean {
    const { summary, jobs } = value;
    const { cost, completeness, resultCoverage } = summary;
    if (
        cost.providerConservativeUsd < cost.providerActualUsd
        || !moneyMatches(
            cost.actualPlusGeminiEstimatedUsd,
            cost.providerActualUsd + cost.geminiEstimatedUsd
        )
        || !moneyMatches(
            cost.conservativePlusGeminiEstimatedUsd,
            cost.providerConservativeUsd + cost.geminiEstimatedUsd
        )
        || completeness.resultCoverageAvailable !== (resultCoverage !== null)
        || (resultCoverage !== null && resultCoverage.planId !== summary.planId)
        || (resultCoverage !== null && (
            resultCoverage.fetchUnavailableCount
            + resultCoverage.mediaUnavailableCount
            + resultCoverage.analysisUnavailableCount
        ) > resultCoverage.screenedMutuals)
        || completeness.jobCount !== jobs.length
        || completeness.jobCount !== (
            completeness.jobPendingCount
            + completeness.jobProcessingCount
            + completeness.jobCompletedCount
            + completeness.jobFailedCount
            + completeness.jobCancelledCount
        )
        || completeness.providerRunCount !== (
            completeness.providerActiveCount
            + completeness.providerUnreconciledCount
            + completeness.providerActualCostCount
        )
        || completeness.aiAttemptCount !== (
            completeness.aiReservedCount
            + completeness.aiMissingUsageCount
            + completeness.aiEstimatedCostCount
        )
    ) {
        return false;
    }
    const jobKeys = new Set(jobs.map(job => job.jobKey));
    return summary.profileOutcomes.every(row => {
        if (!jobKeys.has(row.jobKey)) return false;
        if (row.status === 'success') {
            return row.failureCategory === null && row.httpStatus === null;
        }
        if (row.status === 'unavailable') {
            return (row.failureCategory === 'not_found' || row.failureCategory === 'empty_user')
                && (row.httpStatus === null || row.httpStatus === 404);
        }
        return row.failureCategory !== null
            && row.failureCategory !== 'not_found'
            && row.failureCategory !== 'empty_user';
    });
}

export async function loadAnalysisV2OperationalObservability(
    client: AnalysisV2OperationalObservabilityClient,
    requestId: string
): Promise<AnalysisV2OperationalObservability | null> {
    if (!UUID_PATTERN.test(requestId)) {
        throw new Error('ANALYSIS_V2_OBSERVABILITY_VALIDATION_ERROR');
    }
    const { data, error } = await client.rpc(
        ANALYSIS_V2_OPERATIONAL_OBSERVABILITY_RPC,
        { p_request_id: requestId.toLowerCase() }
    );
    if (error) {
        throw new Error('ANALYSIS_V2_OBSERVABILITY_PERSISTENCE_ERROR');
    }
    if (data === null) return null;

    const parsed = responseSchema.parse(data);
    if (
        parsed.summary.requestId.toLowerCase() !== requestId.toLowerCase()
        || !hasValidSemantics(parsed)
    ) {
        throw new Error('ANALYSIS_V2_OBSERVABILITY_PERSISTENCE_ERROR');
    }
    return parsed;
}
