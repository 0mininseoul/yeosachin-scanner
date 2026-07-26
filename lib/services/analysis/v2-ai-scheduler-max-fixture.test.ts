import { describe, expect, it } from 'vitest';
import {
    runAnalysisV2SchedulerLifecycleFixture,
} from './v2-ai-scheduler-max-fixture';

describe('analysis V2 Standard lifecycle scheduler fixture', () => {
    it('models the full 240/145 DAG, observed retries, caps, and continuations', () => {
        const metrics = runAnalysisV2SchedulerLifecycleFixture();

        expect(metrics.topology).toEqual({
            profileBatches: 8,
            publicProfiles: 240,
            privateBatches: 2,
            privateProfiles: 145,
        });
        expect(metrics.stages.genderTriage).toMatchObject({
            operations: 240,
            providerCalls: 450,
            rateLimited: 210,
            retries: 210,
        });
        expect(metrics.stages.featureAnalysis).toMatchObject({
            operations: 240,
            providerCalls: 359,
            rateLimited: 119,
            retries: 119,
            terminalUnavailable: 1,
        });
        expect(metrics.stages.privateAccountName).toMatchObject({
            operations: 2,
            providerCalls: 2,
        });
        expect(metrics.maxConcurrency).toBeLessThanOrEqual(8);
        expect(metrics.maxConcurrencyByStage).toEqual({
            genderTriage: 6,
            featureAnalysis: 3,
            privateAccountName: 2,
        });
        expect(metrics.continuations).toBeGreaterThan(0);
        expect(metrics.duplicatePaidCalls).toBe(0);
        expect(metrics.admissionDeferrals).toBe(1);
        expect(metrics.terminalUnavailableRecoveries).toBe(1);
        expect(metrics.assumptions.ambiguousRecoveryMs).toBe(360_000);
        expect(metrics.modeledUnderFiveMinutes).toBe(false);
        expect(metrics.totalEndToEndWallTimeMs).toBeGreaterThan(300_000);
    });

    it('is deterministic and responds to provider latency assumptions', () => {
        const first = runAnalysisV2SchedulerLifecycleFixture();
        expect(runAnalysisV2SchedulerLifecycleFixture()).toEqual(first);
        const faster = runAnalysisV2SchedulerLifecycleFixture({
            genderProviderLatencyMs: 500,
            featureProviderLatencyMs: 1_000,
            privateProviderLatencyMs: 1_000,
        });
        expect(faster.totalEndToEndWallTimeMs)
            .toBeLessThan(first.totalEndToEndWallTimeMs);
    });
});
