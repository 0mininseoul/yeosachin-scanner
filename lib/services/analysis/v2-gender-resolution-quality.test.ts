import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_DATABASE_NAMES,
    AnalysisV2GenderResolutionQualityGateError,
    createAnalysisV2GenderResolutionQualityStore,
    type AnalysisV2GenderResolutionQualityRpcClient,
} from './v2-gender-resolution-quality';

const requestId = '123e4567-e89b-42d3-a456-426614174000';

function quality(overrides: Record<string, unknown> = {}) {
    return {
        screenedCount: 10,
        resolverEligibleCount: 5,
        baselineUnknownCount: 5,
        finalUnknownCount: 3,
        finalUnknownRatio: 0.3,
        readyCount: 3,
        appliedCount: 2,
        appliedWithFencedResultCount: 2,
        verifiedBaselineMutationCount: 0,
        inconclusiveCount: 1,
        cutoffCount: 1,
        capacitySkippedCount: 0,
        terminalUnavailableCount: 0,
        partialMediaAcceptedCandidateCount: 1,
        selectedMediaTotal: 25,
        normalizedMediaTotal: 24,
        failedMediaTotal: 1,
        resolverAttemptCount: 3,
        resolverUsageCompleteCount: 2,
        resolverUsageMissingCount: 1,
        resolverEstimatedCostUsd: 0.0001,
        resolverCostKnownCount: 2,
        resolverConcurrencyLimit: 2,
        sharedConcurrencyLimit: 8,
        requestCompleted: true,
        standardPlan: true,
        resultArchivePresent: true,
        requestGatePassed: true,
        unknownGateEvaluable: true,
        unknownGatePassed: true,
        provenanceGatePassed: true,
        immutabilityGatePassed: true,
        qualityGatePassed: true,
        ...overrides,
    };
}

function setup(data: unknown) {
    const rpc = vi.fn(async () => ({ data, error: null }));
    return {
        rpc,
        store: createAnalysisV2GenderResolutionQualityStore({
            rpc,
        } as AnalysisV2GenderResolutionQualityRpcClient),
    };
}

describe('analysis V2 gender resolution durable quality gate', () => {
    it('passes the inclusive unknown-at-most-30-percent boundary', async () => {
        const { rpc, store } = setup(quality());
        await expect(store.load(requestId)).resolves.toMatchObject({
            finalUnknownCount: 3,
            finalUnknownRatio: 0.3,
            unknownGatePassed: true,
            qualityGatePassed: true,
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_DATABASE_NAMES.loadRpc,
            { p_request_id: requestId }
        );
    });

    it('rejects an E2E result above 30 percent without changing classification', async () => {
        const { store } = setup(quality({
            finalUnknownCount: 4,
            finalUnknownRatio: 0.4,
            unknownGatePassed: false,
            qualityGatePassed: false,
        }));
        await expect(store.requirePassing(requestId)).rejects.toBeInstanceOf(
            AnalysisV2GenderResolutionQualityGateError
        );
    });

    it('treats zero screened rows as not evaluable rather than a fabricated pass', async () => {
        const { store } = setup(quality({
            screenedCount: 0,
            resolverEligibleCount: 0,
            baselineUnknownCount: 0,
            finalUnknownCount: 0,
            finalUnknownRatio: null,
            readyCount: 0,
            appliedCount: 0,
            appliedWithFencedResultCount: 0,
            inconclusiveCount: 0,
            cutoffCount: 0,
            partialMediaAcceptedCandidateCount: 0,
            selectedMediaTotal: 0,
            normalizedMediaTotal: 0,
            failedMediaTotal: 0,
            resolverAttemptCount: 0,
            resolverUsageCompleteCount: 0,
            resolverUsageMissingCount: 0,
            resolverEstimatedCostUsd: null,
            resolverCostKnownCount: 0,
            unknownGateEvaluable: false,
            unknownGatePassed: false,
            qualityGatePassed: false,
        }));
        await expect(store.requirePassing(requestId)).rejects.toBeInstanceOf(
            AnalysisV2GenderResolutionQualityGateError
        );
    });

    it('fails closed on derived gate drift or provenance/immutability failure', async () => {
        await expect(setup(quality({
            unknownGatePassed: false,
        })).store.load(requestId)).rejects.toThrow(
            'ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_INVALID'
        );
        await expect(setup(quality({
            appliedWithFencedResultCount: 1,
            provenanceGatePassed: false,
            qualityGatePassed: false,
        })).store.requirePassing(requestId)).rejects.toBeInstanceOf(
            AnalysisV2GenderResolutionQualityGateError
        );
        await expect(setup(quality({
            verifiedBaselineMutationCount: 1,
            immutabilityGatePassed: false,
            qualityGatePassed: false,
        })).store.requirePassing(requestId)).rejects.toBeInstanceOf(
            AnalysisV2GenderResolutionQualityGateError
        );
    });

    it('never passes a staging, non-Standard, or unarchived request', async () => {
        for (const gates of [
            { requestCompleted: false },
            { standardPlan: false },
            { resultArchivePresent: false },
        ]) {
            await expect(setup(quality({
                ...gates,
                requestGatePassed: false,
                qualityGatePassed: false,
            })).store.requirePassing(requestId)).rejects.toBeInstanceOf(
                AnalysisV2GenderResolutionQualityGateError
            );
        }
    });
});
