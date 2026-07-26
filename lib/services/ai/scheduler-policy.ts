export const AI_SCHEDULER_POLICY_ID = 'ai-scheduler-v1' as const;

export type AiSchedulerPolicyVersion = typeof AI_SCHEDULER_POLICY_ID;
export type AiSchedulerPolicyRolloutMode = 'off' | 'test_entitlement' | 'production';
export type AiSchedulerPolicyAccessMode = 'test_entitlement' | 'production';
export type AiSchedulerCapability = 'legacy' | 'scheduler-v1';

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
    const scheduler = (snapshot as Record<string, unknown>).scheduler;
    if (scheduler === undefined) return Object.freeze({ capability: 'legacy' as const });
    if (scheduler === AI_SCHEDULER_POLICY_ID) {
        return Object.freeze({ capability: 'scheduler-v1' as const });
    }
    throw new Error(`Unsupported AI scheduler policy version: ${String(scheduler)}`);
}
