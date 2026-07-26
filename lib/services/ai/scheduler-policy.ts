import { isAiPolicyVersion } from './policy-version';

export const AI_SCHEDULER_POLICY_ID = 'ai-scheduler-v1' as const;

export type AiSchedulerPolicyVersion = typeof AI_SCHEDULER_POLICY_ID;
export type AiSchedulerPolicyRolloutMode = 'off' | 'test_entitlement' | 'production';
export type AiSchedulerPolicyAccessMode = 'test_entitlement' | 'production';
export type AiSchedulerCapability = 'legacy' | 'scheduler-v1';

const APPLICATION_POLICY_KEYS = Object.freeze([
    'pipeline',
    'risk',
    'aiStage',
    'scheduler',
] as const);
const REQUIRED_APPLICATION_POLICY_KEYS = Object.freeze([
    'pipeline',
    'risk',
    'aiStage',
] as const);

export function selectAiSchedulerPolicyVersion({
    rolloutMode,
    accessMode,
}: {
    rolloutMode: string | undefined;
    accessMode: AiSchedulerPolicyAccessMode;
}): AiSchedulerPolicyVersion | undefined {
    if (rolloutMode === 'production') return AI_SCHEDULER_POLICY_ID;
    if (rolloutMode === 'test_entitlement' && accessMode === 'test_entitlement') {
        return AI_SCHEDULER_POLICY_ID;
    }
    return undefined;
}

export function parseAiSchedulerPolicySnapshot(snapshot: unknown): Readonly<{
    capability: AiSchedulerCapability;
}> {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
        throw new Error('Invalid AI scheduler policy snapshot');
    }
    const record = snapshot as Record<string, unknown>;
    const keys = Object.keys(record);
    if (
        keys.some(key => !APPLICATION_POLICY_KEYS.includes(
            key as typeof APPLICATION_POLICY_KEYS[number]
        ))
        || REQUIRED_APPLICATION_POLICY_KEYS.some(key => (
            !Object.prototype.hasOwnProperty.call(record, key)
            || typeof record[key] !== 'string'
            || !isAiPolicyVersion(record[key])
        ))
    ) {
        throw new Error('Invalid AI scheduler policy snapshot');
    }
    const scheduler = record.scheduler;
    if (scheduler === undefined) return Object.freeze({ capability: 'legacy' as const });
    if (scheduler === AI_SCHEDULER_POLICY_ID) {
        return Object.freeze({ capability: 'scheduler-v1' as const });
    }
    throw new Error(`Unsupported AI scheduler policy version: ${String(scheduler)}`);
}
