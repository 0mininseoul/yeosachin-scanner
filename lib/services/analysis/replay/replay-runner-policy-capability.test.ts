import { beforeEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({
    createFeatureAnalysisResultIdentity: vi.fn(),
    createGenderTriageMicrobatchAccountId: vi.fn(),
    createGenderTriageMicrobatchResultIdentity: vi.fn(),
    createGenderTriageResultIdentity: vi.fn(),
    genderTriageMicrobatch: vi.fn(),
    genderTriage: vi.fn(),
    featureAnalysis: vi.fn(),
    genderResolution: vi.fn(),
    privateNames: vi.fn(),
}));

vi.mock('@/lib/services/ai/private-name-analysis', () => ({
    analyzePrivateAccountNames: ai.privateNames,
}));

vi.mock('@/lib/services/ai/v2-staged-analysis', async importOriginal => {
    const actual = await importOriginal<
        typeof import('@/lib/services/ai/v2-staged-analysis')
    >();
    return {
        ...actual,
        createFeatureAnalysisResultIdentity:
            ai.createFeatureAnalysisResultIdentity,
        createGenderTriageMicrobatchAccountId:
            ai.createGenderTriageMicrobatchAccountId,
        createGenderTriageMicrobatchResultIdentity:
            ai.createGenderTriageMicrobatchResultIdentity,
        createGenderTriageResultIdentity: ai.createGenderTriageResultIdentity,
        genderTriageMicrobatch: ai.genderTriageMicrobatch,
        genderTriage: ai.genderTriage,
        featureAnalysis: ai.featureAnalysis,
        genderResolution: ai.genderResolution,
    };
});

import { runAnalysisV2AiReplay, type ReplayAiRunner } from './replay-runner';
import { createReplayStagedAiAdapter } from './replay-staged-ai-adapter';
import {
    HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY,
    HISTORICAL_OFFICIAL_E2E_REPLAY_V211_CAPABILITY,
    HISTORICAL_OFFICIAL_E2E_REPLAY_V212_CAPABILITY,
    REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY,
    type ReplayEvaluationPolicy,
} from './replay-source-lineage';

const v28Bundle = {
    schemaVersion: 1 as const,
    createdAt: '2026-07-27T00:00:00.000Z',
    expiresAt: '2026-07-27T01:00:00.000Z',
    capture: {
        requestFingerprint: 'a'.repeat(64),
        sourceLineage: {
            selectedPlanId: 'standard' as const,
            policyVersions: {
                pipeline: 'v2' as const,
                risk: 'risk-policy-v2.4' as const,
                aiStage: 'ai-stage-policy-v2.8' as const,
                scheduler: 'ai-scheduler-v1' as const,
            },
        },
    },
    profiles: [{
        ordinal: 1,
        isPrivate: false,
        username: 'public',
        fullName: null,
        hasProfileImage: true,
        bio: null,
        media: [{
            selectionId: 'm1',
            kind: 'feed' as const,
            postId: 'p1',
            caption: null,
            jpegBase64: '/9j/2Q==',
        }],
        triageSelectionIds: ['m1'],
        featureSelectionIds: ['m1'],
        resolverSelectionIds: ['m1'],
        captions: [],
        coverage: { selectedCount: 1, normalizedCount: 1, failures: [] },
    }],
    evidence: { relationship: [], targetInteractions: [], reverseInteractions: [] },
};

async function runPaid(runner: ReplayAiRunner) {
    return runAnalysisV2AiReplay({
        bundle: v28Bundle,
        runner,
        mode: 'paid-ai',
        paidAiOptIn: true,
    });
}

const v29EvaluationPolicy: ReplayEvaluationPolicy = {
    capability: REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.9',
};

const v28ToV29Bundle = {
    ...v28Bundle,
    capture: {
        ...v28Bundle.capture,
        evaluationPolicy: v29EvaluationPolicy,
    },
};

const historicalV210Evaluation = {
    capability: HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.10',
} as const satisfies ReplayEvaluationPolicy;

const historicalV210Bundle = {
    ...v28Bundle,
    capture: {
        ...v28Bundle.capture,
        sourceLineage: {
            selectedPlanId: 'standard' as const,
            policyVersions: {
                pipeline: 'v2' as const,
                risk: 'risk-policy-v2.3' as const,
                aiStage: 'ai-stage-policy-v2.7' as const,
            },
        },
        evaluationPolicy: historicalV210Evaluation,
    },
};

const historicalV211Evaluation = {
    capability: HISTORICAL_OFFICIAL_E2E_REPLAY_V211_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.11',
} as const satisfies ReplayEvaluationPolicy;

const historicalV211Bundle = {
    ...historicalV210Bundle,
    capture: {
        ...historicalV210Bundle.capture,
        evaluationPolicy: historicalV211Evaluation,
    },
};

const historicalV212Evaluation = {
    capability: HISTORICAL_OFFICIAL_E2E_REPLAY_V212_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.12',
} as const satisfies ReplayEvaluationPolicy;

const historicalV212Bundle = {
    ...historicalV210Bundle,
    capture: {
        ...historicalV210Bundle.capture,
        evaluationPolicy: historicalV212Evaluation,
    },
};

function v212TwoMediaBundle() {
    return {
        ...historicalV212Bundle,
        profiles: [{
            ...historicalV212Bundle.profiles[0]!,
            media: [
                historicalV212Bundle.profiles[0]!.media[0]!,
                {
                    ...historicalV212Bundle.profiles[0]!.media[0]!,
                    selectionId: 'm2',
                    postId: 'p2',
                },
            ],
            triageSelectionIds: ['m1', 'm2'],
            featureSelectionIds: ['m1', 'm2'],
            resolverSelectionIds: ['m1', 'm2'],
            coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
        }],
    };
}

describe('replay staged AI runner policy capability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ai.createGenderTriageResultIdentity.mockReturnValue({
            operationKey: 'triage:identity',
        });
        ai.createGenderTriageMicrobatchAccountId.mockReturnValue(
            `account:${'b'.repeat(64)}`,
        );
        ai.createGenderTriageMicrobatchResultIdentity.mockReturnValue({
            operationKey: 'triage:microbatch:identity',
        });
        ai.createFeatureAnalysisResultIdentity.mockReturnValue({
            operationKey: 'feature:identity',
        });
        ai.genderTriage.mockResolvedValue({
            assessment: {
                inferredGender: 'male',
                confidence: 'high',
                ownerConsistency: 'same_person',
                evidenceSelectionIds: ['m1'],
            },
            routingDecision: 'exclude_high_confidence_male',
            routingReason: 'high_confidence_same_owner_male',
            analyzedSelectionIds: ['m1'],
        });
    });

    const highFemale = (accountContext:
        | 'personal'
        | 'individual_creator'
        | 'official_group_or_brand'
        | 'uncertain') => ({
        assessment: {
            inferredGender: 'female' as const,
            confidence: 'high' as const,
            ownerConsistency: 'same_person' as const,
            evidenceSelectionIds: ['m1', 'm2'],
        },
        routingDecision: 'route_to_feature_analysis' as const,
        routingReason: 'conserve_female_recall' as const,
        analyzedSelectionIds: ['m1'],
        v29AccountContext: accountContext,
    });

    async function runV29Triage(result: ReturnType<typeof highFemale>, profile = {}) {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result,
            source: 'checkpoint',
        }]);
        return runAnalysisV2AiReplay({
            bundle: {
                ...v28ToV29Bundle,
                profiles: [{
                    ...v28ToV29Bundle.profiles[0]!,
                    ...profile,
                }],
            },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.9'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: v29EvaluationPolicy,
        });
    }

    it('reports the authenticated v2.10 policy while preserving v2.9 capability behavior', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: highFemale('official_group_or_brand'),
            source: 'checkpoint',
        }]);

        const report = await runAnalysisV2AiReplay({
            bundle: historicalV210Bundle,
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.10'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV210Evaluation,
        });

        expect(report).toMatchObject({
            evaluationAiPolicy: 'ai-stage-policy-v2.10',
            replayAiPolicy: 'ai-stage-policy-v2.10',
        });
        expect(ai.genderTriage).not.toHaveBeenCalled();
        expect(ai.genderTriageMicrobatch).toHaveBeenCalledOnce();
        expect(ai.featureAnalysis).not.toHaveBeenCalled();
    });

    it('admits uncertain triage to feature then launches one late resolver for strict personal unresolved output', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'uncertain',
            },
            source: 'checkpoint',
        }]);
        ai.featureAnalysis.mockResolvedValue({
            features: { accountContext: 'personal' },
            finalGenderDecision: 'unresolved',
            analyzedSelectionIds: ['m1', 'm2'],
        });
        ai.genderResolution.mockResolvedValue({
            assessment: {
                inferredGender: 'female', confidence: 'high',
                ownerConsistency: 'same_person', evidenceSelectionIds: ['m1', 'm2'],
            },
            analyzedSelectionIds: ['m1', 'm2'],
        });
        let serialized = '';
        const report = await runAnalysisV2AiReplay({
            bundle: {
                ...historicalV211Bundle,
                profiles: [{
                    ...historicalV211Bundle.profiles[0]!,
                    media: [
                        historicalV211Bundle.profiles[0]!.media[0]!,
                        { ...historicalV211Bundle.profiles[0]!.media[0]!, selectionId: 'm2', postId: 'p2' },
                    ],
                    triageSelectionIds: ['m1', 'm2'],
                    featureSelectionIds: ['m1', 'm2'],
                    resolverSelectionIds: ['m1', 'm2'],
                    coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
                }],
            },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.11'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV211Evaluation,
            write: line => { serialized = line; },
        });
        expect(ai.featureAnalysis).toHaveBeenCalledOnce();
        expect(ai.genderResolution).toHaveBeenCalledOnce();
        expect(report.gender.female).toBe(1);
        expect(report.genderQuality).toMatchObject({
            resolver: { earlyAdmission: 0, lateAdmission: 1 },
            qualityGate: { observedPass: true, worstCasePass: true },
        });
        expect(serialized).toContain('gender_quality');
        expect(serialized).not.toContain('"public"');
        expect(serialized).not.toContain('"m1"');
    });

    it('serializes a v2.12 MAX_TOKENS resolver rejection as one unknown account', async () => {
        await expect(runAnalysisV2AiReplay({
            bundle: historicalV212Bundle,
            mode: 'dry-run',
            evaluationPolicy: historicalV211Evaluation,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_MISMATCH');
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'uncertain',
            },
            source: 'checkpoint',
        }]);
        ai.featureAnalysis.mockResolvedValue({
            features: { accountContext: 'personal' },
            finalGenderDecision: 'unresolved',
            analyzedSelectionIds: ['m1', 'm2'],
        });
        ai.genderResolution.mockImplementationOnce(async (
            _input: unknown,
            audit: {
                onBeforeAttempt?: (value: { attempt: number; retryCount: number }) => void;
                onAttemptTelemetry?: (value: {
                    attempt: number; retryCount: number;
                    disposition: string; latencyMs: number;
                }) => void;
            },
        ) => {
            audit.onBeforeAttempt?.({ attempt: 1, retryCount: 0 });
            audit.onAttemptTelemetry?.({
                attempt: 1,
                retryCount: 0,
                disposition: 'response_rejected',
                latencyMs: 1,
            });
            throw new Error(
                'AI_GENERATION_RESPONSE_REJECTED_ERROR: finishReason=MAX_TOKENS',
            );
        });
        let serialized = '';

        const report = await runAnalysisV2AiReplay({
            bundle: {
                ...historicalV212Bundle,
                profiles: [{
                    ...historicalV212Bundle.profiles[0]!,
                    media: [
                        historicalV212Bundle.profiles[0]!.media[0]!,
                        {
                            ...historicalV212Bundle.profiles[0]!.media[0]!,
                            selectionId: 'm2',
                            postId: 'p2',
                        },
                    ],
                    triageSelectionIds: ['m1', 'm2'],
                    featureSelectionIds: ['m1', 'm2'],
                    resolverSelectionIds: ['m1', 'm2'],
                    coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
                }],
            },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.12' as never),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV212Evaluation,
            write: line => { serialized = line; },
        });

        expect(report.gender).toEqual({ male: 0, female: 0, unknown: 1, unknownRate: 1 });
        expect(report.stages.genderResolution.failureDisposition)
            .toEqual({ response_rejected: 1 });
        expect(report.genderQuality).toMatchObject({
            resolver: { outcome: { failed: 1 } },
        });
        expect(JSON.parse(serialized)).toMatchObject({
            status: 'ok',
            gender: { unknown: 1, unknownRate: 1 },
        });
        expect(serialized).not.toContain('MAX_TOKENS');
    });

    it('propagates an unexpected v2.12 resolver fault to the replay boundary', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'uncertain',
            },
            source: 'checkpoint',
        }]);
        ai.featureAnalysis.mockResolvedValue({
            features: { accountContext: 'personal' },
            finalGenderDecision: 'unresolved',
            analyzedSelectionIds: ['m1', 'm2'],
        });
        ai.genderResolution.mockRejectedValue(
            new Error('unexpected resolver logic fault'),
        );

        await expect(runAnalysisV2AiReplay({
            bundle: {
                ...historicalV212Bundle,
                profiles: [{
                    ...historicalV212Bundle.profiles[0]!,
                    media: [
                        historicalV212Bundle.profiles[0]!.media[0]!,
                        {
                            ...historicalV212Bundle.profiles[0]!.media[0]!,
                            selectionId: 'm2',
                            postId: 'p2',
                        },
                    ],
                    triageSelectionIds: ['m1', 'm2'],
                    featureSelectionIds: ['m1', 'm2'],
                    resolverSelectionIds: ['m1', 'm2'],
                    coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
                }],
            },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.12' as never),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV212Evaluation,
        })).rejects.toThrow('unexpected resolver logic fault');
    });

    it('fails a v2.12 ordinary cutoff when an abort-ignoring raw resolver fault outlives settlement', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'uncertain',
            },
            source: 'checkpoint',
        }]);
        ai.featureAnalysis.mockResolvedValue({
            features: { accountContext: 'personal' },
            finalGenderDecision: 'unresolved',
            analyzedSelectionIds: ['m1', 'm2'],
        });
        ai.genderResolution.mockImplementation((
            _input: unknown,
            _audit: unknown,
            options: { abortSignal?: AbortSignal },
        ) => new Promise((_, reject) => {
            options.abortSignal?.addEventListener('abort', () => {
                setTimeout(() => reject(new Error('delayed raw resolver fault')), 40);
            }, { once: true });
        }));

        await expect(runAnalysisV2AiReplay({
            bundle: v212TwoMediaBundle(),
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.12' as never),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV212Evaluation,
            resolverCutoffMs: 25,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_RESOLVER_SETTLEMENT_TIMEOUT');

        // The late raw rejection remains observed after the bounded timeout.
        await new Promise(resolve => setTimeout(resolve, 50));
    });

    it('propagates a v2.12 raw resolver fault that settles after official exclusion', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'personal',
            },
            source: 'checkpoint',
        }]);
        ai.featureAnalysis.mockResolvedValue({
            features: { accountContext: 'official_group_or_brand' },
            finalGenderDecision: 'unresolved',
            analyzedSelectionIds: ['m1', 'm2'],
        });
        ai.genderResolution.mockImplementation((
            _input: unknown,
            _audit: unknown,
            options: { abortSignal?: AbortSignal },
        ) => new Promise((_, reject) => {
            options.abortSignal?.addEventListener('abort', () => {
                setTimeout(() => reject(new Error('delayed raw resolver fault')), 35);
            }, { once: true });
        }));

        await expect(runAnalysisV2AiReplay({
            bundle: v212TwoMediaBundle(),
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.12' as never),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV212Evaluation,
        })).rejects.toThrow('delayed raw resolver fault');
    });

    it('keeps a v2.12 promptly settled capacity cutoff as one unknown report', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'uncertain',
            },
            source: 'checkpoint',
        }]);
        ai.featureAnalysis.mockResolvedValue({
            features: { accountContext: 'personal' },
            finalGenderDecision: 'unresolved',
            analyzedSelectionIds: ['m1', 'm2'],
        });
        ai.genderResolution.mockImplementation((
            _input: unknown,
            _audit: unknown,
            options: { abortSignal?: AbortSignal },
        ) => new Promise((_, reject) => {
            options.abortSignal?.addEventListener('abort', () => {
                reject(new Error('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED'));
            }, { once: true });
        }));

        const report = await runAnalysisV2AiReplay({
            bundle: v212TwoMediaBundle(),
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.12' as never),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV212Evaluation,
            resolverCutoffMs: 25,
        });

        expect(report.gender).toEqual({ male: 0, female: 0, unknown: 1, unknownRate: 1 });
        expect(report.resolver).toMatchObject({ cutoff: 1, applied: 0 });
        expect(report.stages.genderResolution.failureDisposition)
            .toMatchObject({ backoff_cutoff: 1 });
    });

    it('keeps a triage-personal but deterministically collective account out of feature and resolver', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'personal',
            },
            source: 'checkpoint',
        }]);
        const report = await runAnalysisV2AiReplay({
            bundle: {
                ...historicalV211Bundle,
                profiles: [{
                    ...historicalV211Bundle.profiles[0]!,
                    fullName: 'Black Cherry Club',
                    bio: 'Single [콜드브루] Out now',
                    media: [
                        historicalV211Bundle.profiles[0]!.media[0]!,
                        { ...historicalV211Bundle.profiles[0]!.media[0]!, selectionId: 'm2', postId: 'p2' },
                    ],
                    triageSelectionIds: ['m1', 'm2'],
                    featureSelectionIds: ['m1', 'm2'],
                    resolverSelectionIds: ['m1', 'm2'],
                    coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
                }],
            },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.11'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV211Evaluation,
        });
        expect(ai.featureAnalysis).not.toHaveBeenCalled();
        expect(ai.genderResolution).not.toHaveBeenCalled();
        expect(report.genderQuality).toMatchObject({
            feature: {
                admission: { nonpersonal_or_official: 1 },
                routeTerminal: { excluded_official: 1 },
            },
        });
    });

    it('cuts off an early resolver and never applies it when feature identifies an official group', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1', 'm2'],
                v29AccountContext: 'personal',
            },
            source: 'checkpoint',
        }]);
        ai.featureAnalysis.mockResolvedValue({
            features: { accountContext: 'official_group_or_brand' },
            finalGenderDecision: 'unresolved',
            analyzedSelectionIds: ['m1', 'm2'],
        });
        ai.genderResolution.mockImplementation((
            _input: unknown,
            _audit: unknown,
            options: { abortSignal?: AbortSignal },
        ) => new Promise((_, reject) => {
            options.abortSignal?.addEventListener('abort', () => {
                reject(new Error('resolver aborted after official context'));
            }, { once: true });
        }));
        const report = await runAnalysisV2AiReplay({
            bundle: {
                ...historicalV211Bundle,
                profiles: [{
                    ...historicalV211Bundle.profiles[0]!,
                    media: [
                        historicalV211Bundle.profiles[0]!.media[0]!,
                        { ...historicalV211Bundle.profiles[0]!.media[0]!, selectionId: 'm2', postId: 'p2' },
                    ],
                    triageSelectionIds: ['m1', 'm2'],
                    featureSelectionIds: ['m1', 'm2'],
                    resolverSelectionIds: ['m1', 'm2'],
                    coverage: { selectedCount: 2, normalizedCount: 2, failures: [] },
                }],
            },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.11'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV211Evaluation,
        });
        expect(ai.featureAnalysis).toHaveBeenCalledOnce();
        expect(ai.genderResolution).toHaveBeenCalledOnce();
        expect(report.gender).toEqual({ male: 0, female: 0, unknown: 1, unknownRate: 1 });
        expect(report.genderQuality).toMatchObject({
            feature: { routeTerminal: { completed: 1 } },
            resolver: { earlyAdmission: 1, outcome: { official_excluded: 1 } },
        });
    });

    it('blocks an official high-female v2.9 account before feature and resolver', async () => {
        const report = await runV29Triage(
            highFemale('official_group_or_brand'),
            {
                fullName: 'Example Records Official',
                bio: 'New album out now. Booking and shop inquiries.',
            },
        );

        expect(ai.featureAnalysis).not.toHaveBeenCalled();
        expect(ai.genderResolution).not.toHaveBeenCalled();
        expect(report.gender).toEqual({
            male: 0, female: 0, unknown: 1, unknownRate: 1,
        });
    });

    it('preserves a v2.11 triage capacity outcome in PII-free counters and conserves public totals', async () => {
        ai.genderTriageMicrobatch.mockRejectedValueOnce(
            new Error('ANALYSIS_V2_AI_CAPACITY_PENDING'),
        );
        const report = await runAnalysisV2AiReplay({
            bundle: historicalV211Bundle,
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.11'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV211Evaluation,
        });
        expect(report.gender).toEqual({ male: 0, female: 0, unknown: 1, unknownRate: 1 });
        expect(report.genderQuality).toMatchObject({
            triage: { nonOk: 1, capacity: 1, outcome: { capacity_skipped: 1 } },
            feature: { routeTerminal: { triage_non_ok: 1 } },
            finalClassificationSource: { triage_non_ok: 1 },
        });
    });

    it('records the non-routed high-male feature cohort without invoking feature', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'male', confidence: 'high',
                    ownerConsistency: 'same_person', evidenceSelectionIds: ['m1'],
                },
                routingDecision: 'exclude_high_confidence_male',
                routingReason: 'high_confidence_same_owner_male',
                analyzedSelectionIds: ['m1'],
                v29AccountContext: 'personal',
            },
            source: 'checkpoint',
        }]);
        const report = await runAnalysisV2AiReplay({
            bundle: historicalV211Bundle,
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.11'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV211Evaluation,
        });
        expect(ai.featureAnalysis).not.toHaveBeenCalled();
        expect(report.genderQuality).toMatchObject({
            feature: { routeTerminal: { not_routed_high_male: 1 } },
        });
    });

    it('counts a non-ok admitted feature provider result in the complete cohort', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low',
                    ownerConsistency: 'not_visible', evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis',
                routingReason: 'conserve_female_recall',
                analyzedSelectionIds: ['m1'],
                v29AccountContext: 'uncertain',
            },
            source: 'checkpoint',
        }]);
        ai.featureAnalysis.mockRejectedValueOnce(new Error('feature provider unavailable'));
        const report = await runAnalysisV2AiReplay({
            bundle: historicalV211Bundle,
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.11'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: historicalV211Evaluation,
        });
        expect(report.genderQuality).toMatchObject({
            feature: {
                admission: { eligible: 1 },
                routeTerminal: { provider_non_ok: 1 },
            },
        });
    });

    it('blocks unsupported v2.9 unknown context before feature and resolver', async () => {
        const report = await runV29Triage(highFemale('uncertain'));

        expect(ai.featureAnalysis).not.toHaveBeenCalled();
        expect(ai.genderResolution).not.toHaveBeenCalled();
        expect(report.gender.unknown).toBe(1);
    });

    it('fails closed before AI when a legacy bundle lacks v2.9 profile-image evidence', async () => {
        const { hasProfileImage, ...legacyProfile } =
            v28ToV29Bundle.profiles[0]!;
        void hasProfileImage;
        await expect(runAnalysisV2AiReplay({
            bundle: {
                ...v28ToV29Bundle,
                profiles: [legacyProfile],
            },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.9'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: v29EvaluationPolicy,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_INPUT_INVALID');
        expect(ai.genderTriageMicrobatch).not.toHaveBeenCalled();
    });

    it('prevalidates every public v2.9 profile before starting private or public AI', async () => {
        const { hasProfileImage, ...legacyProfile } =
            v28ToV29Bundle.profiles[0]!;
        void hasProfileImage;
        const privateProfile = {
            ordinal: 2,
            isPrivate: true,
            username: 'private',
            fullName: 'Private',
            hasProfileImage: false,
            bio: undefined,
            media: [],
            triageSelectionIds: [],
            featureSelectionIds: [],
            resolverSelectionIds: [],
            captions: [],
            coverage: {
                selectedCount: 0,
                normalizedCount: 0,
                failures: [],
            },
        };

        await expect(runAnalysisV2AiReplay({
            bundle: {
                ...v28ToV29Bundle,
                profiles: [legacyProfile, privateProfile],
            },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.9'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: v29EvaluationPolicy,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_INPUT_INVALID');

        expect(ai.privateNames).not.toHaveBeenCalled();
        expect(ai.genderTriageMicrobatch).not.toHaveBeenCalled();
        expect(ai.featureAnalysis).not.toHaveBeenCalled();
        expect(ai.genderResolution).not.toHaveBeenCalled();
    });

    it('admits a confirmed personal female to feature without resolver', async () => {
        ai.featureAnalysis.mockResolvedValue({
            features: {
                gender: 'female',
                genderConfidence: 'high',
                ownerConsistency: 'same_person',
                appearanceGrade: 3,
                exposureScore: 1,
                businessClassification: 'personal',
                businessConfidence: 'high',
                accountContext: 'personal',
                marriageEvidence: 'none',
                partnerEvidence: 'none',
                partnerExclusionContext: 'none',
                evidenceSelectionIds: {
                    gender: ['m1'],
                    appearance: ['m1'],
                    exposure: ['m1'],
                    business: ['m1'],
                    accountContext: ['m1'],
                    marriagePartner: [],
                },
                oneLineOverview: '관찰된 단서를 바탕으로 개인 계정의 특징을 구체적으로 정리했습니다.',
            },
            finalGenderDecision: 'verified_female',
            analyzedSelectionIds: ['m1'],
        });

        const report = await runV29Triage(highFemale('personal'), {
            fullName: 'Exact Name',
            hasProfileImage: false,
            bio: 'Exact bio',
        });

        expect(ai.featureAnalysis).toHaveBeenCalledOnce();
        expect(ai.featureAnalysis.mock.calls[0]![0]).toMatchObject({
            accountProfile: {
                fullName: 'Exact Name',
                hasProfileImage: false,
                bio: 'Exact bio',
            },
        });
        expect(ai.genderResolution).not.toHaveBeenCalled();
        expect(report.gender.female).toBe(1);
    });

    it('runs the actual v2.9 microbatch adapter only for an authenticated explicit evaluation', async () => {
        ai.genderTriageMicrobatch.mockResolvedValue([{
            accountId: `account:${'b'.repeat(64)}`,
            result: {
                assessment: {
                    inferredGender: 'male',
                    confidence: 'high',
                    ownerConsistency: 'same_person',
                    evidenceSelectionIds: ['m1'],
                },
                routingDecision: 'exclude_high_confidence_male',
                routingReason: 'high_confidence_same_owner_male',
                analyzedSelectionIds: ['m1'],
            },
            source: 'checkpoint',
        }]);

        await expect(runAnalysisV2AiReplay({
            bundle: v28ToV29Bundle,
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.9'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: v29EvaluationPolicy,
        })).resolves.toMatchObject({
            sourceAiPolicy: 'ai-stage-policy-v2.8',
            evaluationAiPolicy: 'ai-stage-policy-v2.9',
            replayAiPolicy: 'ai-stage-policy-v2.9',
            gender: { male: 1 },
        });
        expect(ai.genderTriageMicrobatch).toHaveBeenCalledOnce();
        expect(ai.genderTriage).not.toHaveBeenCalled();
    });

    it('reports 120 provider calls for 240 v2.9 profiles instead of 240 logical accounts', async () => {
        const profiles = Array.from({ length: 240 }, (_, index) => ({
            ...v28Bundle.profiles[0]!,
            ordinal: index + 1,
            username: `public-${index + 1}`,
            media: [{
                ...v28Bundle.profiles[0]!.media[0]!,
                selectionId: `m${index + 1}`,
            }],
            triageSelectionIds: [`m${index + 1}`],
            featureSelectionIds: [`m${index + 1}`],
            resolverSelectionIds: [`m${index + 1}`],
        }));
        ai.createGenderTriageMicrobatchAccountId.mockImplementation(
            (input: { media: Array<{ selectionId: string }> }) => {
                const ordinal = Number(input.media[0]!.selectionId.slice(1));
                return `account:${ordinal.toString(16).padStart(64, '0')}`;
            },
        );
        ai.genderTriageMicrobatch.mockImplementation(async (
            accounts: Array<{ accountId: string; input: { media: Array<{ selectionId: string }> } }>,
            audit: {
                onBeforeAttempt(value: { attempt: number; retryCount: number }): void;
                onAttemptTelemetry(value: {
                    attempt: number;
                    retryCount: number;
                    disposition: 'success';
                    latencyMs: number;
                }): void;
            },
        ) => {
            audit.onBeforeAttempt({ attempt: 1, retryCount: 0 });
            audit.onAttemptTelemetry({
                attempt: 1,
                retryCount: 0,
                disposition: 'success',
                latencyMs: 10,
            });
            return accounts.map(account => ({
                accountId: account.accountId,
                source: 'checkpoint',
                result: {
                    assessment: {
                        inferredGender: 'male',
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: [account.input.media[0]!.selectionId],
                    },
                    routingDecision: 'exclude_high_confidence_male',
                    routingReason: 'high_confidence_same_owner_male',
                    analyzedSelectionIds: [account.input.media[0]!.selectionId],
                },
            }));
        });

        const report = await runAnalysisV2AiReplay({
            bundle: { ...v28ToV29Bundle, profiles },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.9'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: v29EvaluationPolicy,
        });

        expect(ai.genderTriageMicrobatch).toHaveBeenCalledTimes(120);
        expect(ai.genderTriageMicrobatch.mock.calls.every(call => call[0].length === 2))
            .toBe(true);
        expect(report.stages.genderTriage).toMatchObject({
            calls: 120,
            meanLatencyMs: 10,
            p50LatencyMs: 10,
            p95LatencyMs: 10,
        });
        expect(report.gender).toEqual({
            male: 240,
            female: 0,
            unknown: 0,
            unknownRate: 0,
        });
    });

    it('starts fast-batch feature work before slower sibling gender batches finish', async () => {
        const profiles = Array.from({ length: 6 }, (_, index) => ({
            ...v28Bundle.profiles[0]!,
            ordinal: index + 1,
            username: `public-${index + 1}`,
            media: [{
                ...v28Bundle.profiles[0]!.media[0]!,
                selectionId: `m${index + 1}`,
            }],
            triageSelectionIds: [`m${index + 1}`],
            featureSelectionIds: [`m${index + 1}`],
            resolverSelectionIds: [`m${index + 1}`],
        }));
        ai.createGenderTriageMicrobatchAccountId.mockImplementation(
            (input: { media: Array<{ selectionId: string }> }) => {
                const ordinal = Number(input.media[0]!.selectionId.slice(1));
                return `account:${ordinal.toString(16).padStart(64, '0')}`;
            },
        );
        const releases: Array<() => void> = [];
        let slowGenderFinished = false;
        let featureBeforeSlow = false;
        ai.genderTriageMicrobatch.mockImplementation(async accounts => {
            const firstOrdinal = Number(accounts[0].input.media[0].selectionId.slice(1));
            if (firstOrdinal > 2) {
                await new Promise<void>(resolve => releases.push(resolve));
                slowGenderFinished = true;
            }
            return accounts.map((account: {
                accountId: string;
                input: { media: Array<{ selectionId: string }> };
            }) => ({
                accountId: account.accountId,
                source: 'checkpoint',
                result: {
                    ...highFemale('personal'),
                    assessment: {
                        ...highFemale('personal').assessment,
                        evidenceSelectionIds: [
                            account.input.media[0]!.selectionId,
                            'corroborating',
                        ],
                    },
                },
            }));
        });
        ai.featureAnalysis.mockImplementation(async () => {
            featureBeforeSlow ||= !slowGenderFinished;
            return {
                features: {
                    gender: 'female',
                    genderConfidence: 'high',
                    ownerConsistency: 'same_person',
                    appearanceGrade: 3,
                    exposureScore: 1,
                    businessClassification: 'personal',
                    businessConfidence: 'high',
                    accountContext: 'personal',
                    marriageEvidence: 'none',
                    partnerEvidence: 'none',
                    partnerExclusionContext: 'none',
                    evidenceSelectionIds: {
                        gender: ['m1'], appearance: ['m1'], exposure: ['m1'],
                        business: ['m1'], accountContext: ['m1'], marriagePartner: [],
                    },
                    oneLineOverview: '관찰된 단서를 바탕으로 개인 계정의 특징을 구체적으로 정리했습니다.',
                },
                finalGenderDecision: 'verified_female',
                analyzedSelectionIds: ['m1'],
            };
        });

        const running = runAnalysisV2AiReplay({
            bundle: { ...v28ToV29Bundle, profiles },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.9'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: v29EvaluationPolicy,
        });
        await vi.waitFor(() => expect(ai.featureAnalysis).toHaveBeenCalled());
        expect(featureBeforeSlow).toBe(true);
        expect(releases).toHaveLength(2);
        releases.forEach(release => release());
        await running;
    });

    it('does not admit the seventh profile until a full pipeline slot frees', async () => {
        const profiles = Array.from({ length: 7 }, (_, index) => ({
            ...v28Bundle.profiles[0]!,
            ordinal: index + 1,
            username: `public-${index + 1}`,
            media: [{
                ...v28Bundle.profiles[0]!.media[0]!,
                selectionId: `m${index + 1}`,
            }],
            triageSelectionIds: [`m${index + 1}`],
            featureSelectionIds: [`m${index + 1}`],
            resolverSelectionIds: [`m${index + 1}`],
        }));
        ai.createGenderTriageMicrobatchAccountId.mockImplementation(
            (input: { media: Array<{ selectionId: string }> }) => {
                const ordinal = Number(input.media[0]!.selectionId.slice(1));
                return `account:${ordinal.toString(16).padStart(64, '0')}`;
            },
        );
        type Account = {
            accountId: string;
            input: { media: Array<{ selectionId: string }> };
        };
        const pending: Array<{
            accounts: Account[];
            settled: boolean;
            resolve(value: unknown): void;
        }> = [];
        ai.genderTriageMicrobatch.mockImplementation((accounts: Account[]) => (
            new Promise(resolve => pending.push({
                accounts,
                settled: false,
                resolve,
            }))
        ));
        const settle = (entry: typeof pending[number]) => {
            entry.settled = true;
            entry.resolve(entry.accounts.map(account => ({
                accountId: account.accountId,
                source: 'checkpoint',
                result: {
                    assessment: {
                        inferredGender: 'male',
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: [account.input.media[0]!.selectionId],
                    },
                    routingDecision: 'exclude_high_confidence_male',
                    routingReason: 'high_confidence_same_owner_male',
                    analyzedSelectionIds: [account.input.media[0]!.selectionId],
                },
            })));
        };

        const running = runAnalysisV2AiReplay({
            bundle: { ...v28ToV29Bundle, profiles },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.9'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: v29EvaluationPolicy,
        });
        await vi.waitFor(() => expect(pending).toHaveLength(3));
        expect(pending.flatMap(entry => entry.accounts).some(account => (
            account.input.media[0]!.selectionId === 'm7'
        ))).toBe(false);

        settle(pending[0]!);
        await vi.waitFor(() => expect(pending).toHaveLength(4));
        expect(pending[3]!.accounts[0]!.input.media[0]!.selectionId).toBe('m7');
        pending.filter(entry => !entry.settled).forEach(settle);
        await running;
    });

    it('keeps the seventh profile waiting while three features run and three hold queued slots', async () => {
        const profiles = Array.from({ length: 7 }, (_, index) => ({
            ...v28Bundle.profiles[0]!,
            ordinal: index + 1,
            username: `public-${index + 1}`,
            media: [{
                ...v28Bundle.profiles[0]!.media[0]!,
                selectionId: `m${index + 1}`,
            }],
            triageSelectionIds: [`m${index + 1}`],
            featureSelectionIds: [`m${index + 1}`],
            resolverSelectionIds: [`m${index + 1}`],
        }));
        ai.createGenderTriageMicrobatchAccountId.mockImplementation(
            (input: { media: Array<{ selectionId: string }> }) => {
                const ordinal = Number(input.media[0]!.selectionId.slice(1));
                return `account:${ordinal.toString(16).padStart(64, '0')}`;
            },
        );
        ai.genderTriageMicrobatch.mockImplementation(async accounts => (
            accounts.map((account: {
                accountId: string;
                input: { media: Array<{ selectionId: string }> };
            }) => ({
                accountId: account.accountId,
                source: 'checkpoint',
                result: {
                    ...highFemale('personal'),
                    assessment: {
                        ...highFemale('personal').assessment,
                        evidenceSelectionIds: [
                            account.input.media[0]!.selectionId,
                            'corroborating',
                        ],
                    },
                },
            }))
        ));
        const featureResult = {
            features: {
                gender: 'female',
                genderConfidence: 'high',
                ownerConsistency: 'same_person',
                appearanceGrade: 3,
                exposureScore: 1,
                businessClassification: 'personal',
                businessConfidence: 'high',
                accountContext: 'personal',
                marriageEvidence: 'none',
                partnerEvidence: 'none',
                partnerExclusionContext: 'none',
                evidenceSelectionIds: {
                    gender: ['m1'], appearance: ['m1'], exposure: ['m1'],
                    business: ['m1'], accountContext: ['m1'], marriagePartner: [],
                },
                oneLineOverview: '관찰된 단서를 바탕으로 개인 계정의 특징을 구체적으로 정리했습니다.',
            },
            finalGenderDecision: 'verified_female',
            analyzedSelectionIds: ['m1'],
        };
        let gate = true;
        const featureReleases: Array<() => void> = [];
        ai.featureAnalysis.mockImplementation(async () => {
            if (gate) {
                await new Promise<void>(resolve => featureReleases.push(resolve));
            }
            return featureResult;
        });

        const running = runAnalysisV2AiReplay({
            bundle: { ...v28ToV29Bundle, profiles },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.9'),
            mode: 'paid-ai',
            paidAiOptIn: true,
            evaluationPolicy: v29EvaluationPolicy,
        });
        await vi.waitFor(() => expect(ai.featureAnalysis).toHaveBeenCalledTimes(3));
        expect(ai.genderTriageMicrobatch).toHaveBeenCalledTimes(3);
        expect(ai.genderTriageMicrobatch.mock.calls.flatMap(call => call[0])
            .some(account => account.input.media[0]!.selectionId === 'm7'))
            .toBe(false);

        gate = false;
        featureReleases.shift()?.();
        await vi.waitFor(() => expect(ai.genderTriageMicrobatch).toHaveBeenCalledTimes(4));
        expect(ai.genderTriageMicrobatch.mock.calls[3]![0][0]!
            .input.media[0]!.selectionId).toBe('m7');
        featureReleases.forEach(release => release());
        await running;
    });

    it('rejects a missing or different runtime evaluation before any AI call', async () => {
        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.9');
        await expect(runAnalysisV2AiReplay({
            bundle: v28ToV29Bundle,
            runner: adapter,
            mode: 'paid-ai',
            paidAiOptIn: true,
        })).rejects.toThrow('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_MISMATCH');
        expect(ai.genderTriageMicrobatch).not.toHaveBeenCalled();
        expect(ai.genderTriage).not.toHaveBeenCalled();
    });

    it('accepts only the exact factory-issued policy adapter', async () => {
        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.8');
        await expect(runPaid(adapter)).resolves.toMatchObject({
            replayAiPolicy: 'ai-stage-policy-v2.8',
            gender: { male: 1 },
        });
        expect(ai.genderTriage).toHaveBeenCalledOnce();
    });

    it('keeps legacy v2.8 replay unchanged when historical bundles lack profile-image evidence', async () => {
        const { hasProfileImage, ...legacyProfile } =
            v28Bundle.profiles[0]!;
        void hasProfileImage;
        await expect(runAnalysisV2AiReplay({
            bundle: { ...v28Bundle, profiles: [legacyProfile] },
            runner: createReplayStagedAiAdapter('ai-stage-policy-v2.8'),
            mode: 'paid-ai',
            paidAiOptIn: true,
        })).resolves.toMatchObject({
            replayAiPolicy: 'ai-stage-policy-v2.8',
            gender: { male: 1 },
        });
        expect(ai.genderTriage).toHaveBeenCalledOnce();
        expect(ai.createGenderTriageResultIdentity.mock.calls[0]![0])
            .not.toHaveProperty('accountProfile');
    });

    it('cannot restamp a real v2.7 adapter as v2.8', async () => {
        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.7');
        const restamped = Object.freeze({
            ...adapter,
            policyVersion: 'ai-stage-policy-v2.8',
        }) as ReplayAiRunner;

        await expect(runPaid(adapter))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
        await expect(runPaid(restamped))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
        expect(ai.genderTriage).not.toHaveBeenCalled();
    });

    it('rejects a frozen forged runner with factory-shaped operations', async () => {
        const forged = Object.freeze({
            triage: vi.fn(),
            feature: vi.fn(),
            privateNames: vi.fn(),
            resolveGender: vi.fn(),
        }) satisfies ReplayAiRunner;

        await expect(runPaid(forged))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
        expect(forged.triage).not.toHaveBeenCalled();
    });

    it('exposes no registration capability and cannot retag a genuine adapter', async () => {
        const adapterModule = await import('./replay-staged-ai-adapter');
        expect('registerReplayAiRunnerPolicy' in adapterModule).toBe(false);
        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.7');
        expect(Reflect.set(adapter, 'policyVersion', 'ai-stage-policy-v2.8'))
            .toBe(false);

        await expect(runPaid(adapter))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
        expect(ai.genderTriage).not.toHaveBeenCalled();
    });

    it.each([
        ['raw', () => ({ triage: vi.fn() }) as ReplayAiRunner],
        ['copy', () => ({ ...createReplayStagedAiAdapter('ai-stage-policy-v2.8') })],
        ['proxy', () => new Proxy(
            createReplayStagedAiAdapter('ai-stage-policy-v2.8'),
            {},
        )],
        ['wrapper', () => {
            const issued = createReplayStagedAiAdapter('ai-stage-policy-v2.8');
            return { triage: input => issued.triage!(input) } satisfies ReplayAiRunner;
        }],
        ['rebound', () => {
            const issued = createReplayStagedAiAdapter('ai-stage-policy-v2.8');
            return { triage: issued.triage!.bind(issued) } satisfies ReplayAiRunner;
        }],
        ['replaced-operation proxy', () => {
            const issued = createReplayStagedAiAdapter('ai-stage-policy-v2.8');
            const replacement = vi.fn();
            return new Proxy(issued, {
                get(target, property, receiver) {
                    if (property === 'triage') return replacement;
                    return Reflect.get(target, property, receiver);
                },
            });
        }],
    ] as const)('rejects a %s runner before any AI call', async (_label, makeRunner) => {
        await expect(runPaid(makeRunner()))
            .rejects.toThrow('ANALYSIS_V2_REPLAY_AI_RUNNER_POLICY_MISMATCH');
        expect(ai.genderTriage).not.toHaveBeenCalled();
        expect(ai.featureAnalysis).not.toHaveBeenCalled();
        expect(ai.genderResolution).not.toHaveBeenCalled();
    });

    it('freezes a factory-issued adapter so operations cannot be replaced', () => {
        const adapter = createReplayStagedAiAdapter('ai-stage-policy-v2.8');
        expect(Object.isFrozen(adapter)).toBe(true);
        expect(Reflect.set(adapter, 'triage', vi.fn())).toBe(false);
        expect(ai.genderTriage).not.toHaveBeenCalled();
    });
});
