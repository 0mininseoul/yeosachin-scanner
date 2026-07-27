import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    accountId: vi.fn((input: { media: { selectionId: string }[] }) =>
        `account:${input.media[0]?.selectionId}`),
    batchIdentity: vi.fn(() => ({ operationKey: `gender-triage:${'a'.repeat(64)}` })),
    batch: vi.fn(),
    resolverIdentity: vi.fn((...args: unknown[]) => {
        void args;
        return { operationKey: `gender-resolution:${'b'.repeat(64)}` };
    }),
    resolver: vi.fn(),
}));
vi.mock('@/lib/services/ai/v2-staged-analysis', () => ({
    GENDER_TRIAGE_V29_MAX_ACCOUNTS_PER_BATCH: 2,
    createGenderTriageMicrobatchAccountId: mocks.accountId,
    createGenderTriageMicrobatchResultIdentity: mocks.batchIdentity,
    genderTriageMicrobatch: mocks.batch,
    createGenderResolutionResultIdentity: mocks.resolverIdentity,
    genderResolution: mocks.resolver,
}));

import {
    createStrongUncertainResolverExperimentAdapter,
    isStrongUncertainResolverExperimentAdapter,
} from './resolver-experiment-ai-adapter';
import { runStrongUncertainResolverExperiment } from './resolver-experiment-runner';

const invocationResult = (accounts: readonly { accountId: string }[]) =>
    accounts.map(account => ({
        accountId: account.accountId,
        result: {
            assessment: {
                inferredGender: 'unknown', confidence: 'low',
                ownerConsistency: 'not_visible', evidenceSelectionIds: [],
            },
            routingDecision: 'route_to_feature_analysis',
            routingReason: 'conserve_female_recall',
            analyzedSelectionIds: [],
            v29AccountContext: 'uncertain',
        },
    }));

describe('dedicated resolver experiment AI adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.batch.mockImplementation(invocationResult);
        mocks.resolver.mockResolvedValue({
            assessment: {
                inferredGender: 'unknown', confidence: 'low',
                ownerConsistency: 'not_visible', evidenceSelectionIds: [],
            },
            analyzedSelectionIds: [],
        });
    });

    it('uses the shared deterministic two-account planner and maps every result', async () => {
        const runner = createStrongUncertainResolverExperimentAdapter();
        const pending = Array.from({ length: 5 }, (_, index) => runner.triage!({
            ordinal: index + 1,
            media: [{
                selectionId: `m${index + 1}`, kind: 'feed',
                jpegBase64: '/9j/2Q==',
            }],
            accountProfile: { fullName: null, hasProfileImage: true, bio: null },
        }));
        const results = await Promise.all(pending);
        expect(mocks.batch.mock.calls.map(call => call[0].map(
            (item: { accountId: string }) => item.accountId,
        ))).toEqual([
            ['account:m1', 'account:m2'],
            ['account:m3', 'account:m4'],
            ['account:m5'],
        ]);
        expect(results).toHaveLength(5);
        expect(results.every(result => result.outcome === 'ok')).toBe(true);
        expect(Object.isFrozen(runner)).toBe(true);
        expect(isStrongUncertainResolverExperimentAdapter(runner)).toBe(true);
        expect(isStrongUncertainResolverExperimentAdapter({
            triage: runner.triage,
            resolveGender: runner.resolveGender,
        })).toBe(false);
    });

    it('fails every member of a failed batch safely without cross-batch drift', async () => {
        mocks.batch.mockRejectedValueOnce(new Error('provider failure'));
        const runner = createStrongUncertainResolverExperimentAdapter();
        const results = await Promise.all([1, 2].map(index => runner.triage!({
            ordinal: index,
            media: [{ selectionId: `m${index}`, kind: 'feed', jpegBase64: '/9j/2Q==' }],
        })));
        expect(results.map(result => result.outcome)).toEqual(['failed', 'failed']);
        expect(results.every(result => result.value === undefined)).toBe(true);
    });

    it('pins the resolver override and exposes no feature/private runner', async () => {
        const runner = createStrongUncertainResolverExperimentAdapter();
        await runner.resolveGender!({
            ordinal: 1, media: [], signal: new AbortController().signal,
        });
        expect(runner).not.toHaveProperty('feature');
        expect(runner).not.toHaveProperty('privateNames');
        expect(mocks.resolverIdentity.mock.calls[0]?.[2]).toEqual({
            model: 'gemini-3-flash-preview',
            thinkingLevel: 'HIGH',
            mediaResolution: 'HIGH',
            maxOutputTokens: 512,
        });
        expect(mocks.resolver.mock.calls[0]?.[2]).toMatchObject({
            aiStagePolicyVersion: 'ai-stage-policy-v2.9',
            experimentPolicy: {
                model: 'gemini-3-flash-preview',
                thinkingLevel: 'HIGH',
                mediaResolution: 'HIGH',
                maxOutputTokens: 512,
            },
        });
    });

    it('the experiment runner queues the complete canonical triage order before awaiting', async () => {
        const runner = createStrongUncertainResolverExperimentAdapter();
        const profiles = Array.from({ length: 5 }, (_, index) => ({
            ordinal: index + 1,
            isPrivate: false,
            username: `sealed${index + 1}`,
            fullName: null,
            hasProfileImage: true,
            bio: null,
            media: [1, 2].map(mediaIndex => ({
                selectionId: `m${index + 1}-${mediaIndex}`,
                kind: 'feed' as const,
                jpegBase64: '/9j/2Q==',
            })),
            triageSelectionIds: [`m${index + 1}-1`, `m${index + 1}-2`],
            featureSelectionIds: [],
            resolverSelectionIds: [`m${index + 1}-1`, `m${index + 1}-2`],
            captions: [],
            coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
        }));
        const report = await runStrongUncertainResolverExperiment({
            bundle: {
                schemaVersion: 3,
                capture: {
                    evaluationPolicy: {
                        capability: 'replay-only-resolver-experiment-strong-uncertain-v1',
                        aiStage: 'ai-stage-policy-v2.9',
                    },
                    experiment: {
                        id: 'strong-uncertain-v1',
                        uncertainPilotLimit: 24,
                    },
                },
                profiles,
            } as never,
            runner,
        });
        expect(mocks.batch.mock.calls.map(call => call[0].length)).toEqual([2, 2, 1]);
        expect(report).toMatchObject({
            triaged: 5,
            uncertainPilotSelected: 5,
            attempted: 5,
        });
    });
});
