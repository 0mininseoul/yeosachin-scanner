import { describe, expect, it } from 'vitest';
import {
    AI_SCHEDULER_POLICY_ID,
    parseAiSchedulerPolicySnapshot,
    selectAiSchedulerPolicyVersion,
} from './scheduler-policy';

describe('AI scheduler policy', () => {
    it('uses one immutable scheduler policy id', () => {
        expect(AI_SCHEDULER_POLICY_ID).toBe('ai-scheduler-v1');
    });

    it.each([
        ['off', 'production', undefined],
        ['test_entitlement', 'production', undefined],
        ['test_entitlement', 'test_entitlement', 'ai-scheduler-v1'],
        ['production', 'production', 'ai-scheduler-v1'],
        ['production', 'test_entitlement', 'ai-scheduler-v1'],
        [undefined, 'production', undefined],
        ['invalid', 'production', undefined],
    ] as const)('selects scheduler rollout %s for %s access', (
        rolloutMode,
        accessMode,
        expected,
    ) => {
        expect(selectAiSchedulerPolicyVersion({ rolloutMode, accessMode })).toBe(expected);
    });

    it('routes missing scheduler snapshots through the legacy capability', () => {
        expect(parseAiSchedulerPolicySnapshot({
            pipeline: 'v2',
            risk: 'risk-policy-v2.4',
            aiStage: 'ai-stage-policy-v2.7',
        })).toEqual({ capability: 'legacy' });
    });

    it('routes the exact scheduler snapshot through scheduler-v1 capability', () => {
        expect(parseAiSchedulerPolicySnapshot({
            pipeline: 'v2',
            risk: 'risk-policy-v2.4',
            aiStage: 'ai-stage-policy-v2.7',
            scheduler: 'ai-scheduler-v1',
        })).toEqual({ capability: 'scheduler-v1' });
    });

    it('rejects unknown scheduler values', () => {
        expect(() => parseAiSchedulerPolicySnapshot({ scheduler: 'ai-scheduler-v9' }))
            .toThrow('Unsupported AI scheduler policy version');
        expect(() => parseAiSchedulerPolicySnapshot({ scheduler: null }))
            .toThrow('Unsupported AI scheduler policy version');
    });
});
