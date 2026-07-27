import { describe, expect, it } from 'vitest';
import {
    runAnalysisV2MicrobatchV29LifecycleFixture,
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

    it('models the v2.9 bounded-call policy below five minutes without inventing replay cost or unknown-rate evidence', () => {
        const metrics = runAnalysisV2MicrobatchV29LifecycleFixture();

        expect(metrics).toMatchObject({
            fixture: 'standard-240-public-145-private-v29-microbatch',
            modeledOnly: true,
            modeledUnderFiveMinutes: true,
            duplicatePaidCalls: 0,
            continuationDeadlineViolations: 0,
            assumptions: {
                genderAccountsPerProviderCall: 2,
                confirmedFemalePersonalProfiles: 72,
                observedPaidRetries: 0,
                observedAmbiguousPaidResponses: 0,
                costStatus: 'unknown_without_replay_token_usage',
            },
        });
        expect(metrics.stages.genderTriage).toMatchObject({
            logicalAccounts: 240,
            operations: 120,
            providerCalls: 120,
            paidRetries: 0,
        });
        expect(metrics.stages.featureAnalysis).toMatchObject({
            logicalAccounts: 72,
            providerCalls: 72,
            paidRetries: 0,
        });
        expect(metrics.stages.privateAccountName).toMatchObject({
            logicalAccounts: 145,
            providerCalls: 2,
        });
        expect(metrics.totalEndToEndWallTimeMs).toBe(265_000);
        expect(metrics.maxConcurrency).toBeLessThanOrEqual(8);
    });
});
