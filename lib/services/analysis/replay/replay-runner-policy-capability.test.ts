import { beforeEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({
    createGenderTriageMicrobatchAccountId: vi.fn(),
    createGenderTriageMicrobatchResultIdentity: vi.fn(),
    createGenderTriageResultIdentity: vi.fn(),
    genderTriageMicrobatch: vi.fn(),
    genderTriage: vi.fn(),
    featureAnalysis: vi.fn(),
    genderResolution: vi.fn(),
}));

vi.mock('@/lib/services/ai/v2-staged-analysis', async importOriginal => {
    const actual = await importOriginal<
        typeof import('@/lib/services/ai/v2-staged-analysis')
    >();
    return {
        ...actual,
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
