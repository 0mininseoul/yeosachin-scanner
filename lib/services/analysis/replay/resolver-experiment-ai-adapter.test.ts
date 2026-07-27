import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    accountId: vi.fn((input: { media: { selectionId: string }[] }) =>
        `account:${input.media[0]?.selectionId}`),
    batchIdentity: vi.fn(() => ({ operationKey: `gender-triage:${'a'.repeat(64)}` })),
    batch: vi.fn(),
    analyze: vi.fn(),
}));
vi.mock('@/lib/services/ai/v2-staged-analysis', () => ({
    GENDER_TRIAGE_V29_MAX_ACCOUNTS_PER_BATCH: 2,
    createGenderTriageMicrobatchAccountId: mocks.accountId,
    createGenderTriageMicrobatchResultIdentity: mocks.batchIdentity,
    genderTriageMicrobatch: mocks.batch,
}));
vi.mock('@/lib/services/ai/gemini', () => ({
    analyzeWithGemini: mocks.analyze,
}));

import {
    createStrongUncertainResolverExperimentAdapter,
    isStrongUncertainResolverExperimentAdapter,
} from './resolver-experiment-ai-adapter';
import { runStrongUncertainResolverExperiment } from './resolver-experiment-runner';
import { deriveStrongUncertainResolverExperiment } from './resolver-experiment-artifact';
import { historicalPartialSourceUniverseDigest } from './historical-partial-available-artifact';

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

function sealedBundle(count: number) {
    const profiles = Array.from({ length: count }, (_, index) => ({
        ordinal: index + 1, isPrivate: false, username: `sealed${index + 1}`,
        fullName: null, hasProfileImage: true, bio: null,
        media: [1, 2].map(mediaIndex => ({
            selectionId: `m${index + 1}-${mediaIndex}`,
            kind: 'feed' as const, jpegBase64: '/9j/2Q==',
        })),
        triageSelectionIds: [`m${index + 1}-1`, `m${index + 1}-2`],
        featureSelectionIds: [],
        resolverSelectionIds: [`m${index + 1}-1`, `m${index + 1}-2`],
        captions: [],
        coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
    }));
    const sourceIdentities = profiles.map(profile => ({
        ordinal: profile.ordinal, username: profile.username, partition: 'public' as const,
    }));
    return deriveStrongUncertainResolverExperiment({
        schemaVersion: 2,
        createdAt: '2026-07-27T00:00:00.000Z',
        expiresAt: '2026-07-27T01:00:00.000Z',
        capture: {
            requestFingerprint: 'a'.repeat(64),
            scope: 'ai-only-historical-partial-available',
            notExact: true, fullE2eEvidence: false, noMediaSubstitution: true,
            sourceLineage: {
                selectedPlanId: 'standard',
                policyVersions: {
                    pipeline: 'v2', aiStage: 'ai-stage-policy-v2.7',
                    risk: 'risk-policy-v2.3',
                },
            },
            evaluationPolicy: {
                capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29',
                aiStage: 'ai-stage-policy-v2.9',
            },
            partial: {
                sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
                sourceIdentities, mediaUnavailable: [],
            },
        },
        profiles,
        evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
    });
}

describe('dedicated resolver experiment AI adapter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.batch.mockImplementation(invocationResult);
        mocks.analyze.mockResolvedValue({
            inferredGender: 'unknown', confidence: 'low',
            ownerConsistency: 'not_visible', evidenceSelectionIds: [],
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

    it('coalesces duplicate account identities and resolves every waiter with metrics once', async () => {
        mocks.batch.mockImplementation(async (accounts, context) => {
            await context.onBeforeAttempt({ retryCount: 0 });
            return invocationResult(accounts);
        });
        const runner = createStrongUncertainResolverExperimentAdapter();
        const input = {
            ordinal: 1,
            media: [{ selectionId: 'same', kind: 'feed' as const, jpegBase64: '/9j/2Q==' }],
        };
        const results = await Promise.all([
            runner.triage!(input),
            runner.triage!({ ...input, ordinal: 2 }),
            runner.triage!({ ...input, ordinal: 3 }),
        ]);
        expect(mocks.batch).toHaveBeenCalledOnce();
        expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(1);
        expect(results).toHaveLength(3);
        expect(results.every(result => result.outcome === 'ok')).toBe(true);
        expect(results.filter(result => (result.calls ?? 0) > 0)).toHaveLength(1);
    });

    it('resolves every duplicate waiter when its one shared batch fails', async () => {
        mocks.batch.mockRejectedValueOnce(new Error('shared batch failed'));
        const runner = createStrongUncertainResolverExperimentAdapter();
        const input = {
            ordinal: 1,
            media: [{ selectionId: 'failed-same', kind: 'feed' as const, jpegBase64: '/9j/2Q==' }],
        };
        const results = await Promise.all([
            runner.triage!(input),
            runner.triage!({ ...input, ordinal: 2 }),
            runner.triage!({ ...input, ordinal: 3 }),
        ]);
        expect(mocks.batch).toHaveBeenCalledOnce();
        expect(results.map(result => result.outcome)).toEqual([
            'failed', 'failed', 'failed',
        ]);
    });

    it('dispatches 95 canonical batches with at most six active calls', async () => {
        let active = 0;
        let maxActive = 0;
        mocks.batch.mockImplementation(async accounts => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 1));
            active--;
            return invocationResult(accounts);
        });
        const runner = createStrongUncertainResolverExperimentAdapter();
        const results = await Promise.all(Array.from({ length: 190 }, (_, index) =>
            runner.triage!({
                ordinal: index + 1,
                media: [{
                    selectionId: `corpus-${String(index).padStart(3, '0')}`,
                    kind: 'feed',
                    jpegBase64: '/9j/2Q==',
                }],
            })));
        expect(mocks.batch).toHaveBeenCalledTimes(95);
        expect(maxActive).toBeLessThanOrEqual(6);
        expect(results).toHaveLength(190);
        expect(results.every(result => result.outcome === 'ok')).toBe(true);
        expect(results.every(result => result.outcome !== 'capacity_skipped')).toBe(true);
    });

    it('pins the resolver override and exposes no feature/private runner', async () => {
        const runner = createStrongUncertainResolverExperimentAdapter();
        await runner.resolveGender!({
            ordinal: 1, media: [], signal: new AbortController().signal,
        });
        expect(runner).not.toHaveProperty('feature');
        expect(runner).not.toHaveProperty('privateNames');
        expect(mocks.analyze.mock.calls[0]?.[2]).toMatchObject({
            model: 'gemini-3-flash-preview',
            thinkingLevel: 'HIGH',
            mediaResolution: 'HIGH',
            maxOutputTokens: 512,
            skipTokenLog: true,
            replayCapability: expect.any(Object),
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
        const sourceIdentities = profiles.map(profile => ({
            ordinal: profile.ordinal,
            username: profile.username,
            partition: 'public' as const,
        }));
        const bundle = deriveStrongUncertainResolverExperiment({
            schemaVersion: 2,
            createdAt: '2026-07-27T00:00:00.000Z',
            expiresAt: '2026-07-27T01:00:00.000Z',
            capture: {
                requestFingerprint: 'a'.repeat(64),
                scope: 'ai-only-historical-partial-available',
                notExact: true, fullE2eEvidence: false, noMediaSubstitution: true,
                sourceLineage: {
                    selectedPlanId: 'standard',
                    policyVersions: {
                        pipeline: 'v2', aiStage: 'ai-stage-policy-v2.7',
                        risk: 'risk-policy-v2.3',
                    },
                },
                evaluationPolicy: {
                    capability: 'historical-partial-available-standard-v27-risk-v23-to-ai-v29',
                    aiStage: 'ai-stage-policy-v2.9',
                },
                partial: {
                    sourceUniverseDigest: historicalPartialSourceUniverseDigest(sourceIdentities),
                    sourceIdentities, mediaUnavailable: [],
                },
            },
            profiles,
            evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
        });
        const report = await runStrongUncertainResolverExperiment({
            bundle,
            runner,
        });
        expect(mocks.batch.mock.calls.map(call => call[0].length)).toEqual([2, 2, 1]);
        expect(report).toMatchObject({
            triaged: 5,
            uncertainPilotSelected: 5,
            attempted: 5,
        });
    });

    it('admits exactly 40 existing plus 24 uncertain within the 256-attempt ceiling', async () => {
        mocks.batch.mockImplementation(async accounts => accounts.map((account: { accountId: string }) => {
            const ordinal = Number(/m(\d+)-/.exec(account.accountId)?.[1]);
            return {
                accountId: account.accountId,
                result: {
                    assessment: {
                        inferredGender: 'unknown', confidence: 'low',
                        ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                    },
                    routingDecision: 'route_to_feature_analysis',
                    routingReason: 'conserve_female_recall',
                    analyzedSelectionIds: [],
                    v29AccountContext: ordinal <= 40 ? 'personal' : 'uncertain',
                },
            };
        }));
        const report = await runStrongUncertainResolverExperiment({
            bundle: sealedBundle(64),
            runner: createStrongUncertainResolverExperimentAdapter(),
        });
        expect(report).toMatchObject({
            existingEligible: 40,
            uncertainPilotSelected: 24,
            attempted: 64,
            preflightPassed: true,
            limits: { maxAttempts: 256 },
        });
        expect(mocks.analyze).toHaveBeenCalledTimes(64);
    });

    it('fails closed at 41 existing candidates before any resolver call', async () => {
        mocks.batch.mockImplementation(async accounts => accounts.map((account: { accountId: string }) => ({
            accountId: account.accountId,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: [],
                v29AccountContext: 'personal',
            },
        })));
        await expect(runStrongUncertainResolverExperiment({
            bundle: sealedBundle(41),
            runner: createStrongUncertainResolverExperimentAdapter(),
        })).rejects.toThrow('ANALYSIS_V2_RESOLVER_EXPERIMENT_COST_BOUND_EXCEEDED');
        expect(mocks.analyze).not.toHaveBeenCalled();
    });

    it('stops resolver dequeue after a mid-flight abort', async () => {
        mocks.batch.mockImplementation(async accounts => accounts.map((account: { accountId: string }) => ({
            accountId: account.accountId,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: [],
                v29AccountContext: 'personal',
            },
        })));
        let release!: () => void;
        const blocked = new Promise<void>(resolve => { release = resolve; });
        mocks.analyze.mockImplementation(async () => {
            await blocked;
            return {
                inferredGender: 'unknown', confidence: 'low',
                ownerConsistency: 'not_visible', evidenceSelectionIds: [],
            };
        });
        const controller = new AbortController();
        const running = runStrongUncertainResolverExperiment({
            bundle: sealedBundle(6),
            runner: createStrongUncertainResolverExperimentAdapter(),
            signal: controller.signal,
        });
        while (mocks.analyze.mock.calls.length < 2) await Promise.resolve();
        controller.abort(new Error('operator abort'));
        release();
        await expect(running).resolves.toMatchObject({ attempted: 6, succeeded: 0 });
        expect(mocks.analyze).toHaveBeenCalledTimes(2);
    });
});
