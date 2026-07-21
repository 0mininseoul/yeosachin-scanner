import { describe, expect, it, vi } from 'vitest';

import {
    ANALYSIS_V2_OPERATIONAL_OBSERVABILITY_RPC,
    loadAnalysisV2OperationalObservability,
    type AnalysisV2OperationalObservabilityClient,
} from './v2-operational-observability';

const REQUEST_ID = '974247fa-8d0e-4ab7-b6d2-ddf256ad6bdd';

// A minimal payload that satisfies every cross-field invariant in hasValidSemantics: one
// completed profile-batch job, one profile outcome keyed to it, and zeroed cost/coverage.
function payload(source: string) {
    return {
        pipelineVersion: 'v2',
        summary: {
            schemaVersion: 1,
            requestId: REQUEST_ID,
            requestStatus: 'completed',
            planId: 'standard',
            timing: {
                createdAt: '2026-07-21T00:00:00.000Z',
                firstStartedAt: '2026-07-21T00:00:01.000Z',
                completedAt: '2026-07-21T00:05:00.000Z',
                wallTimeMs: 300000,
                queueDelayMs: 1000,
                processingTimeMs: 299000,
                providerRuntimeMsTotal: 0,
                geminiLatencyMsTotal: 0,
            },
            cost: {
                currency: 'USD',
                providerActualUsd: 0,
                providerConservativeUsd: 0,
                geminiEstimatedUsd: 0,
                actualPlusGeminiEstimatedUsd: 0,
                conservativePlusGeminiEstimatedUsd: 0,
                gcpInfrastructureIncluded: false,
            },
            completeness: {
                costComplete: true,
                pipelineComplete: true,
                resultCoverageAvailable: false,
                providerRunCount: 0,
                providerActiveCount: 0,
                providerUnreconciledCount: 0,
                providerActualCostCount: 0,
                aiAttemptCount: 0,
                aiReservedCount: 0,
                aiMissingUsageCount: 0,
                aiEstimatedCostCount: 0,
                jobCount: 1,
                jobPendingCount: 0,
                jobProcessingCount: 0,
                jobCompletedCount: 1,
                jobFailedCount: 0,
                jobCancelledCount: 0,
                jobAttemptCountTotal: 1,
            },
            geminiUsage: { promptTokens: 0, completionTokens: 0, thinkingTokens: 0 },
            profileOutcomes: [{
                jobKey: 'track:profiles:batch:0',
                source,
                status: 'failed',
                failureCategory: 'timeout',
                httpStatus: null,
                outcomeCount: 1,
                requestCount: 1,
                latencyMsTotal: 100,
                latencyMsMax: 100,
            }],
            resultCoverage: null,
        },
        jobs: [{
            jobKey: 'track:profiles:batch:0',
            track: 'profiles',
            kind: 'profile_fetch',
            batch: 0,
            status: 'completed',
            dispatchState: 'delivered',
            attemptCount: 1,
            firstStartedAt: '2026-07-21T00:00:01.000Z',
            completedAt: '2026-07-21T00:05:00.000Z',
            durationMs: 299000,
            lastErrorCode: null,
        }],
    };
}

function clientReturning(data: unknown): AnalysisV2OperationalObservabilityClient {
    return { rpc: vi.fn(async () => ({ data, error: null })) };
}

describe('analysis V2 operational observability reader', () => {
    it('accepts a repair-sourced profile outcome telemetry row', async () => {
        const result = await loadAnalysisV2OperationalObservability(
            clientReturning(payload('repair')),
            REQUEST_ID
        );
        expect(result?.summary.profileOutcomes[0]!.source).toBe('repair');
    });

    it('still accepts the pre-repair telemetry sources', async () => {
        for (const source of ['cache', 'selfhosted', 'fallback']) {
            const result = await loadAnalysisV2OperationalObservability(
                clientReturning(payload(source)),
                REQUEST_ID
            );
            expect(result?.summary.profileOutcomes[0]!.source).toBe(source);
        }
    });

    it('rejects an unknown telemetry source', async () => {
        // The outcome-level source is never surfaced raw: the trigger maps every attempt to one of
        // the four telemetry sources, so anything else is a contract violation, not a repair row.
        await expect(loadAnalysisV2OperationalObservability(
            clientReturning(payload('apify')),
            REQUEST_ID
        )).rejects.toThrow();
    });

    it('names the observability RPC the migration exposes', () => {
        expect(ANALYSIS_V2_OPERATIONAL_OBSERVABILITY_RPC)
            .toBe('load_analysis_v2_operational_observability');
    });
});
