import { beforeEach, describe, expect, it, vi } from 'vitest';

const ai = vi.hoisted(() => ({
    createGenderTriageResultIdentity: vi.fn(),
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
        createGenderTriageResultIdentity: ai.createGenderTriageResultIdentity,
        genderTriage: ai.genderTriage,
        featureAnalysis: ai.featureAnalysis,
        genderResolution: ai.genderResolution,
    };
});

import { runAnalysisV2AiReplay, type ReplayAiRunner } from './replay-runner';
import { createReplayStagedAiAdapter } from './replay-staged-ai-adapter';

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

describe('replay staged AI runner policy capability', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        ai.createGenderTriageResultIdentity.mockReturnValue({
            operationKey: 'triage:identity',
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
