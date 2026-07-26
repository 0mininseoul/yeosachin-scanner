import { beforeEach, describe, expect, it, vi } from 'vitest';

const privateNames = vi.hoisted(() => vi.fn());

vi.mock('@/lib/services/ai/private-name-analysis', () => ({
    analyzePrivateAccountNames: privateNames,
}));

vi.mock('@/lib/services/ai/v2-staged-analysis', () => ({
    createFeatureAnalysisResultIdentity: vi.fn(),
    createGenderResolutionResultIdentity: vi.fn(),
    createGenderTriageResultIdentity: vi.fn(),
    featureAnalysis: vi.fn(),
    genderResolution: vi.fn(),
    genderTriage: vi.fn(),
}));

import { createReplayStagedAiAdapter } from './replay-staged-ai-adapter';

describe('replay staged AI adapter telemetry', () => {
    beforeEach(() => vi.clearAllMocks());

    it('sums retries and per-attempt latency across private-name chunks', async () => {
        privateNames.mockImplementation(async (
            _accounts: unknown,
            _requestId: unknown,
            audit: {
                forChunk(identity: {
                    operationKey: string;
                    resultIdentity: { operationKey: string };
                }): {
                    onBeforeAttempt?(value: {
                        attempt: number;
                        retryCount: number;
                    }): Promise<void> | void;
                    onAttemptTelemetry?(value: {
                        attempt: number;
                        retryCount: number;
                        disposition: 'rate_limited' | 'success';
                        latencyMs: number;
                    }): Promise<void> | void;
                };
            },
        ) => {
            for (const [chunk, firstLatency] of [[0, 5], [1, 11]] as const) {
                const sink = audit.forChunk({
                    operationKey: `private:${chunk}`,
                    resultIdentity: { operationKey: `private:${chunk}` },
                });
                await sink.onBeforeAttempt?.({ attempt: 1, retryCount: 0 });
                await sink.onAttemptTelemetry?.({
                    attempt: 1,
                    retryCount: 0,
                    disposition: 'rate_limited',
                    latencyMs: firstLatency,
                });
                await sink.onBeforeAttempt?.({ attempt: 2, retryCount: 1 });
                await sink.onAttemptTelemetry?.({
                    attempt: 2,
                    retryCount: 1,
                    disposition: 'success',
                    latencyMs: firstLatency + 2,
                });
            }
            return [];
        });
        const result = await createReplayStagedAiAdapter().privateNames?.([
            { id: 'ordinal:1', username: 'private' },
        ]);

        expect(result).toMatchObject({
            outcome: 'ok',
            calls: 4,
            attempts: 4,
            retries: 2,
            rateLimited: 2,
            failureDisposition: { rate_limited: 2 },
            attemptLatenciesMs: [5, 7, 11, 13],
        });
    });
});
