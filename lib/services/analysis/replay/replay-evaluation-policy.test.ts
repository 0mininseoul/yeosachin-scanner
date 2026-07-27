import { describe, expect, it } from 'vitest';
import {
    REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY,
    replayEvaluationPolicySchema,
    resolveReplayAiStagePolicyVersion,
    type ReplaySourceLineage,
} from './replay-source-lineage';

const evaluation = {
    capability: REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.9' as const,
};
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
