import { describe, expect, it } from 'vitest';
import {
    HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY,
    HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY,
    REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY,
    replayEvaluationPolicySchema,
    resolveReplayAiStagePolicyVersion,
    type ReplayEvaluationPolicy,
    type ReplaySourceLineage,
} from './replay-source-lineage';

const evaluation = {
    capability: REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.9' as const,
};
const historicalEvaluation = {
    capability: HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.9' as const,
};
const historicalV210Evaluation = {
    capability: HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.10' as const,
} satisfies ReplayEvaluationPolicy;
const standard = (aiStage: 'ai-stage-policy-v2.7' | 'ai-stage-policy-v2.8' | 'ai-stage-policy-v2.9') => ({
    selectedPlanId: 'standard' as const,
    policyVersions: {
        pipeline: 'v2' as const,
        risk: 'risk-policy-v2.4' as const,
        aiStage,
        scheduler: 'ai-scheduler-v1' as const,
    },
}) as ReplaySourceLineage;

describe('replay cross-policy evaluation capability', () => {
    it('admits only the exact historical v2.7/risk-v2.3 source without synthetic scheduler state', () => {
        const historical = {
            selectedPlanId: 'standard' as const,
            policyVersions: {
                pipeline: 'v2' as const,
                risk: 'risk-policy-v2.3' as const,
                aiStage: 'ai-stage-policy-v2.7' as const,
            },
        } satisfies ReplaySourceLineage;
        expect(resolveReplayAiStagePolicyVersion(historical, historicalEvaluation))
            .toBe('ai-stage-policy-v2.9');
        expect(() => resolveReplayAiStagePolicyVersion(historical, evaluation))
            .toThrow('ANALYSIS_V2_REPLAY_EVALUATION_SOURCE_INELIGIBLE');
    });

    it('authenticates the historical official v2.10 target with its own exact capability', () => {
        const historical = {
            selectedPlanId: 'standard' as const,
            policyVersions: {
                pipeline: 'v2' as const,
                risk: 'risk-policy-v2.3' as const,
                aiStage: 'ai-stage-policy-v2.7' as const,
            },
        } satisfies ReplaySourceLineage;

        expect(resolveReplayAiStagePolicyVersion(historical, historicalV210Evaluation))
            .toBe('ai-stage-policy-v2.10');
        expect(replayEvaluationPolicySchema.safeParse({
            capability: HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY,
            aiStage: 'ai-stage-policy-v2.10',
        }).success).toBe(false);
    });

    it.each(['ai-stage-policy-v2.7', 'ai-stage-policy-v2.8'] as const)(
        'explicitly admits exact Standard %s source into v2.9',
        source => {
            expect(resolveReplayAiStagePolicyVersion(standard(source), evaluation))
                .toBe('ai-stage-policy-v2.9');
        },
    );

    it('leaves legacy exact replay unchanged without an evaluation override', () => {
        expect(resolveReplayAiStagePolicyVersion(standard('ai-stage-policy-v2.8')))
            .toBe('ai-stage-policy-v2.8');
    });

    it.each([
        {
            ...standard('ai-stage-policy-v2.7'),
            policyVersions: {
                ...standard('ai-stage-policy-v2.7').policyVersions,
                scheduler: undefined,
            },
        },
        {
            selectedPlanId: 'plus',
            policyVersions: {
                pipeline: 'v2',
                aiStage: 'ai-stage-policy-v2.4',
                risk: 'risk-policy-v2.2',
            },
        },
        {
            ...standard('ai-stage-policy-v2.8'),
            policyVersions: {
                ...standard('ai-stage-policy-v2.8').policyVersions,
                risk: 'risk-policy-v2.3',
            },
        },
        standard('ai-stage-policy-v2.9'),
    ])('fails closed for an ineligible source lineage', lineage => {
        expect(() => resolveReplayAiStagePolicyVersion(lineage as never, evaluation))
            .toThrow('ANALYSIS_V2_REPLAY_EVALUATION_SOURCE_INELIGIBLE');
    });

    it('rejects arbitrary policy values and extra capability keys', () => {
        expect(replayEvaluationPolicySchema.safeParse({
            ...evaluation,
            aiStage: 'ai-stage-policy-v2.8',
        }).success).toBe(false);
        expect(replayEvaluationPolicySchema.safeParse({
            ...evaluation,
            extra: true,
        }).success).toBe(false);
    });
});
