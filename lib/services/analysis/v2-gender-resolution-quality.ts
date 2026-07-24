import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const boundedCount = z.number().int().min(0).max(10_000_000);

export const ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_gender_resolution_metrics',
    loadRpc: 'load_analysis_v2_gender_resolution_quality',
});

const qualitySchema = z.object({
    screenedCount: boundedCount,
    resolverEligibleCount: boundedCount,
    baselineUnknownCount: boundedCount,
    finalUnknownCount: boundedCount,
    finalUnknownRatio: z.number().min(0).max(1).nullable(),
    readyCount: boundedCount,
    appliedCount: boundedCount,
    appliedWithFencedResultCount: boundedCount,
    verifiedBaselineMutationCount: boundedCount,
    inconclusiveCount: boundedCount,
    cutoffCount: boundedCount,
    capacitySkippedCount: boundedCount,
    terminalUnavailableCount: boundedCount,
    partialMediaAcceptedCandidateCount: boundedCount,
    selectedMediaTotal: boundedCount,
    normalizedMediaTotal: boundedCount,
    failedMediaTotal: boundedCount,
    resolverAttemptCount: boundedCount,
    resolverUsageCompleteCount: boundedCount,
    resolverUsageMissingCount: boundedCount,
    resolverEstimatedCostUsd: z.number().finite().min(0).max(1_000_000).nullable(),
    resolverCostKnownCount: boundedCount,
    resolverConcurrencyLimit: z.literal(2),
    sharedConcurrencyLimit: z.literal(8),
    unknownGateEvaluable: z.boolean(),
    unknownGatePassed: z.boolean(),
    provenanceGatePassed: z.boolean(),
    immutabilityGatePassed: z.boolean(),
    qualityGatePassed: z.boolean(),
}).strict().superRefine((quality, context) => {
    const countBoundsValid = (
        quality.resolverEligibleCount <= quality.screenedCount
        && quality.baselineUnknownCount <= quality.screenedCount
        && quality.finalUnknownCount <= quality.screenedCount
        && quality.readyCount <= quality.resolverEligibleCount
        && quality.appliedCount <= quality.readyCount
        && quality.appliedWithFencedResultCount <= quality.appliedCount
        && quality.verifiedBaselineMutationCount <= quality.screenedCount
        && quality.inconclusiveCount <= quality.readyCount
        && quality.cutoffCount <= quality.resolverEligibleCount
        && quality.capacitySkippedCount <= quality.resolverEligibleCount
        && quality.terminalUnavailableCount <= quality.resolverEligibleCount
        && quality.partialMediaAcceptedCandidateCount <= quality.screenedCount
        && quality.normalizedMediaTotal <= quality.selectedMediaTotal
        && quality.failedMediaTotal
            === quality.selectedMediaTotal - quality.normalizedMediaTotal
        && quality.resolverUsageCompleteCount + quality.resolverUsageMissingCount
            === quality.resolverAttemptCount
        && quality.resolverCostKnownCount <= quality.resolverAttemptCount
    );
    const evaluable = quality.screenedCount > 0;
    const unknownPassed = evaluable
        && quality.finalUnknownCount * 10 <= quality.screenedCount * 3;
    const expectedRatio = evaluable
        ? quality.finalUnknownCount / quality.screenedCount
        : null;
    const ratioValid = expectedRatio === null
        ? quality.finalUnknownRatio === null
        : quality.finalUnknownRatio !== null
            && Math.abs(quality.finalUnknownRatio - expectedRatio) <= 1e-12;
    const provenancePassed =
        quality.appliedWithFencedResultCount === quality.appliedCount;
    const immutabilityPassed = quality.verifiedBaselineMutationCount === 0;
    const overallPassed = evaluable
        && unknownPassed
        && provenancePassed
        && immutabilityPassed;
    if (
        !countBoundsValid
        || !ratioValid
        || quality.unknownGateEvaluable !== evaluable
        || quality.unknownGatePassed !== unknownPassed
        || quality.provenanceGatePassed !== provenancePassed
        || quality.immutabilityGatePassed !== immutabilityPassed
        || quality.qualityGatePassed !== overallPassed
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Durable quality aggregates or derived gates drifted.',
        });
    }
});

export type AnalysisV2GenderResolutionQuality = z.infer<typeof qualitySchema>;

interface RpcResult {
    data: unknown;
    error: unknown;
}

export interface AnalysisV2GenderResolutionQualityRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface AnalysisV2GenderResolutionQualityStore {
    load(requestId: string): Promise<AnalysisV2GenderResolutionQuality>;
    requirePassing(requestId: string): Promise<AnalysisV2GenderResolutionQuality>;
}

export class AnalysisV2GenderResolutionQualityPersistenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_PERSISTENCE_ERROR');
        this.name = 'AnalysisV2GenderResolutionQualityPersistenceError';
    }
}

export class AnalysisV2GenderResolutionQualityInvalidError extends Error {
    constructor() {
        super('ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_INVALID');
        this.name = 'AnalysisV2GenderResolutionQualityInvalidError';
    }
}

export class AnalysisV2GenderResolutionQualityGateError extends Error {
    constructor() {
        super('ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_GATE_FAILED');
        this.name = 'AnalysisV2GenderResolutionQualityGateError';
    }
}

export function createAnalysisV2GenderResolutionQualityStore(
    client: AnalysisV2GenderResolutionQualityRpcClient = supabaseAdmin
): AnalysisV2GenderResolutionQualityStore {
    const load = async (
        requestId: string
    ): Promise<AnalysisV2GenderResolutionQuality> => {
        if (!UUID_PATTERN.test(requestId)) {
            throw new AnalysisV2GenderResolutionQualityInvalidError();
        }
        const { data, error } = await client.rpc(
            ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_DATABASE_NAMES.loadRpc,
            { p_request_id: requestId }
        );
        if (error) {
            throw new AnalysisV2GenderResolutionQualityPersistenceError();
        }
        const parsed = qualitySchema.safeParse(data);
        if (!parsed.success) {
            throw new AnalysisV2GenderResolutionQualityInvalidError();
        }
        return Object.freeze(parsed.data);
    };
    return {
        load,
        async requirePassing(requestId) {
            const quality = await load(requestId);
            if (!quality.qualityGatePassed) {
                throw new AnalysisV2GenderResolutionQualityGateError();
            }
            return quality;
        },
    };
}

export const analysisV2GenderResolutionQualityStore =
    createAnalysisV2GenderResolutionQualityStore();
