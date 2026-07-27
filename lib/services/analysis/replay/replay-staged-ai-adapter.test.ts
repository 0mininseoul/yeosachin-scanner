import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    privateNames: vi.fn(),
    createFeatureAnalysisResultIdentity: vi.fn(),
    createGenderResolutionResultIdentity: vi.fn(),
    createGenderTriageMicrobatchAccountId: vi.fn(),
    createGenderTriageMicrobatchResultIdentity: vi.fn(),
    createGenderTriageResultIdentity: vi.fn(),
    featureAnalysis: vi.fn(),
    genderResolution: vi.fn(),
    genderTriage: vi.fn(),
    genderTriageMicrobatch: vi.fn(),
}));

vi.mock('@/lib/services/ai/private-name-analysis', () => ({
    analyzePrivateAccountNames: mocks.privateNames,
}));

vi.mock('@/lib/services/ai/v2-staged-analysis', () => ({
    GENDER_TRIAGE_V29_MAX_ACCOUNTS_PER_BATCH: 2,
    createFeatureAnalysisResultIdentity: mocks.createFeatureAnalysisResultIdentity,
    createGenderResolutionResultIdentity: mocks.createGenderResolutionResultIdentity,
    createGenderTriageMicrobatchAccountId: mocks.createGenderTriageMicrobatchAccountId,
    createGenderTriageMicrobatchResultIdentity: mocks.createGenderTriageMicrobatchResultIdentity,
    createGenderTriageResultIdentity: mocks.createGenderTriageResultIdentity,
    featureAnalysis: mocks.featureAnalysis,
    genderResolution: mocks.genderResolution,
    genderTriage: mocks.genderTriage,
    genderTriageMicrobatch: mocks.genderTriageMicrobatch,
}));

import { createReplayStagedAiAdapter } from './replay-staged-ai-adapter';

describe('replay staged AI adapter telemetry', () => {
    beforeEach(() => vi.clearAllMocks());

    it('sums retries and per-attempt latency across private-name chunks', async () => {
        mocks.privateNames.mockImplementation(async (
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
        const result = await createReplayStagedAiAdapter('ai-stage-policy-v2.7').privateNames?.([
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

    it.each(['ai-stage-policy-v2.7', 'ai-stage-policy-v2.8'] as const)(
        'pins %s into result identity and execution options',
        async aiStagePolicyVersion => {
            const identity = { operationKey: 'triage:identity' };
            mocks.createGenderTriageResultIdentity.mockReturnValue(identity);
            mocks.genderTriage.mockResolvedValue({ assessment: {}, routingDecision: 'route_to_feature_analysis' });

            await createReplayStagedAiAdapter(aiStagePolicyVersion).triage?.({
                ordinal: 1,
                media: [],
            });

            expect(mocks.createGenderTriageResultIdentity)
                .toHaveBeenCalledWith({ media: [] }, aiStagePolicyVersion);
            expect(mocks.genderTriage).toHaveBeenCalledWith(
                { media: [] },
                expect.any(Object),
                expect.objectContaining({ aiStagePolicyVersion }),
            );
        },
    );

    it('uses the v2.9 batch identity and never substitutes the ambient single-account policy', async () => {
        const identity = { operationKey: 'gender-triage:batch-identity' };
        mocks.createGenderTriageMicrobatchAccountId.mockReturnValue(`account:${'a'.repeat(64)}`);
        mocks.createGenderTriageMicrobatchResultIdentity.mockReturnValue(identity);
        mocks.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'a'.repeat(64)}`,
            source: 'checkpoint',
            result: { assessment: {}, routingDecision: 'route_to_feature_analysis' },
        }]);

        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.9');
        expect(adapter.triage).toBeUndefined();
        await adapter.triageMany?.([{
            ordinal: 1,
            media: [],
            accountProfile: {
                fullName: 'Exact Name',
                hasProfileImage: false,
                bio: 'Exact bio',
            },
        }]);

        expect(mocks.genderTriage).not.toHaveBeenCalled();
        expect(mocks.genderTriageMicrobatch).toHaveBeenCalledWith(
            [{
                accountId: `account:${'a'.repeat(64)}`,
                input: {
                    media: [],
                    accountProfile: {
                        fullName: 'Exact Name',
                        hasProfileImage: false,
                        bio: 'Exact bio',
                    },
                },
            }],
            expect.any(Object),
            expect.any(Object),
        );
    });

    it('plans stable paired v2.9 calls with an odd tail and maps reversed responses by opaque ID', async () => {
        const ids = new Map([
            ['profile:1', `account:${'e'.repeat(64)}`],
            ['profile:2', `account:${'a'.repeat(64)}`],
            ['profile:3', `account:${'d'.repeat(64)}`],
            ['profile:4', `account:${'b'.repeat(64)}`],
            ['profile:5', `account:${'c'.repeat(64)}`],
        ]);
        mocks.createGenderTriageMicrobatchAccountId.mockImplementation(
            (input: { media: Array<{ selectionId: string }> }) =>
                ids.get(input.media[0]!.selectionId),
        );
        mocks.createGenderTriageMicrobatchResultIdentity.mockImplementation(
            (accounts: Array<{ accountId: string }>) => ({
                operationKey: `batch:${accounts.map(item => item.accountId).join(',')}`,
            }),
        );
        mocks.genderTriageMicrobatch.mockImplementation(async (
            accounts: Array<{ accountId: string }>,
        ) => [...accounts].reverse().map(account => ({
            accountId: account.accountId,
            source: 'checkpoint',
            result: {
                assessment: {},
                routingDecision: 'route_to_feature_analysis',
                marker: account.accountId,
            },
        })));

        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.9') as
            ReturnType<typeof createReplayStagedAiAdapter> & {
                triageMany(inputs: Array<{
                    ordinal: number;
                    media: Array<{
                        selectionId: string;
                        kind: 'profile';
                        jpegBase64: string;
                    }>;
                }>): Promise<Array<{
                    ordinals: number[];
                    invocation: {
                        value?: Array<{ ordinal: number; result: { marker: string } }>;
                    };
                }>>;
            };
        const batches = await adapter.triageMany(Array.from(
            { length: 5 },
            (_, index) => ({
                ordinal: index + 1,
                media: Array.from({ length: 5 }, (_value, mediaIndex) => ({
                    selectionId: mediaIndex === 0
                        ? `profile:${index + 1}`
                        : `post:${index + 1}:${mediaIndex}`,
                    kind: mediaIndex === 0 ? 'profile' as const : 'feed' as const,
                    jpegBase64: '/9j/2Q==',
                })),
            }),
        ));

        expect(mocks.genderTriageMicrobatch.mock.calls.map(call => (
            call[0].map((account: { accountId: string }) => account.accountId)
        ))).toEqual([
            [`account:${'a'.repeat(64)}`, `account:${'b'.repeat(64)}`],
            [`account:${'c'.repeat(64)}`, `account:${'d'.repeat(64)}`],
            [`account:${'e'.repeat(64)}`],
        ]);
        expect(batches.map(batch => batch.ordinals)).toEqual([[2, 4], [5, 3], [1]]);
        expect(mocks.genderTriageMicrobatch.mock.calls.every(call => (
            call[0].reduce((
                count: number,
                account: { input: { media: unknown[] } },
            ) => count + account.input.media.length, 0) <= 10
        ))).toBe(true);
        expect(batches.flatMap(batch => batch.invocation.value ?? []))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({
                    ordinal: 2,
                    result: expect.objectContaining({ marker: `account:${'a'.repeat(64)}` }),
                }),
                expect.objectContaining({
                    ordinal: 4,
                    result: expect.objectContaining({ marker: `account:${'b'.repeat(64)}` }),
                }),
            ]));
        expect(mocks.genderTriage).not.toHaveBeenCalled();
    });

    it('uses the production six-call v2.9 gender concurrency ceiling', async () => {
        let active = 0;
        let maximumActive = 0;
        mocks.createGenderTriageMicrobatchAccountId.mockImplementation(
            (input: { media: Array<{ selectionId: string }> }) => {
                const ordinal = Number(input.media[0]!.selectionId.slice(1));
                return `account:${ordinal.toString(16).padStart(64, '0')}`;
            },
        );
        mocks.createGenderTriageMicrobatchResultIdentity.mockReturnValue({
            operationKey: 'batch',
        });
        mocks.genderTriageMicrobatch.mockImplementation(async (
            accounts: Array<{ accountId: string }>,
        ) => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            return accounts.map(account => ({
                accountId: account.accountId,
                source: 'checkpoint',
                result: { assessment: {}, routingDecision: 'route_to_feature_analysis' },
            }));
        });
        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.9');

        await adapter.triageMany?.(Array.from({ length: 14 }, (_, index) => ({
            ordinal: index + 1,
            media: [{
                selectionId: `m${index + 1}`,
                kind: 'profile' as const,
                jpegBase64: '/9j/2Q==',
            }],
        })));

        expect(mocks.genderTriageMicrobatch).toHaveBeenCalledTimes(7);
        expect(maximumActive).toBe(6);
    });

    it('keeps an ambiguous paired safe fallback as one provider call without split replay', async () => {
        mocks.createGenderTriageMicrobatchAccountId
            .mockReturnValueOnce(`account:${'a'.repeat(64)}`)
            .mockReturnValueOnce(`account:${'b'.repeat(64)}`);
        mocks.createGenderTriageMicrobatchResultIdentity.mockReturnValue({
            operationKey: 'ambiguous-batch',
        });
        mocks.genderTriageMicrobatch.mockImplementation(async accounts => (
            accounts.map((account: { accountId: string }) => ({
                accountId: account.accountId,
                source: 'safe_fallback',
                result: {
                    assessment: {
                        inferredGender: 'unknown',
                        confidence: 'low',
                        ownerConsistency: 'not_visible',
                        evidenceSelectionIds: [],
                    },
                    routingDecision: 'route_to_feature_analysis',
                },
            }))
        ));
        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.9');

        const batches = await adapter.triageMany?.([1, 2].map(ordinal => ({
            ordinal,
            media: [{
                selectionId: `m${ordinal}`,
                kind: 'profile' as const,
                jpegBase64: '/9j/2Q==',
            }],
        })));

        expect(mocks.genderTriageMicrobatch).toHaveBeenCalledOnce();
        expect(mocks.genderTriageMicrobatch.mock.calls[0]![0]).toHaveLength(2);
        expect(batches?.[0]?.invocation).toMatchObject({
            outcome: 'ok',
            value: [
                { ordinal: 1 },
                { ordinal: 2 },
            ],
        });
        expect(mocks.genderTriage).not.toHaveBeenCalled();
    });

    it.each(['ai-stage-policy-v2.7', 'ai-stage-policy-v2.8'] as const)(
        'pins %s into resolver identity and execution options',
        async aiStagePolicyVersion => {
            const identity = { operationKey: 'resolver:identity' };
            mocks.createGenderResolutionResultIdentity.mockReturnValue(identity);
            mocks.genderResolution.mockResolvedValue({ assessment: {} });

            await createReplayStagedAiAdapter(aiStagePolicyVersion).resolveGender?.({
                ordinal: 1,
                media: [],
                signal: new AbortController().signal,
            });

            expect(mocks.createGenderResolutionResultIdentity)
                .toHaveBeenCalledWith({ media: [] }, aiStagePolicyVersion);
            expect(mocks.genderResolution).toHaveBeenCalledWith(
                { media: [] },
                expect.any(Object),
                expect.objectContaining({ aiStagePolicyVersion }),
            );
        },
    );
});
