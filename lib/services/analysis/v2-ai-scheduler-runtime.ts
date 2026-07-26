import type { AiSchedulerCapability } from '@/lib/services/ai/scheduler-policy';

export const ANALYSIS_V2_SCHEDULER_V1_POLICY = Object.freeze({
    sharedConcurrency: 8,
    genderTriageConcurrency: 6,
    featureAnalysisConcurrency: 3,
    privateAccountNameConcurrency: 2,
    /** Do not start a paid operation unless this much handler time remains. */
    admissionReserveMs: 75_000,
} as const);

export type AnalysisV2SchedulerStage =
    | 'genderTriage'
    | 'featureAnalysis'
    | 'privateAccountName';

export interface AnalysisV2SchedulerTask<T> {
    /** Durable operation identity, not a display name. */
    key: string;
    stage: AnalysisV2SchedulerStage;
    /** Original deterministic topology order. */
    ordinal: number;
    run(): Promise<T>;
}

export interface AnalysisV2SchedulerCheckpoint<T> {
    hasCommitted(key: string): Promise<boolean>;
    commit(input: Readonly<{ key: string; stage: AnalysisV2SchedulerStage; value: T }>): Promise<void>;
}

export type AnalysisV2SchedulerRunResult<T> = Readonly<{
    status: 'completed' | 'continuation';
    /** Results are always returned in topology order, never completion order. */
    completed: readonly Readonly<{ key: string; stage: AnalysisV2SchedulerStage; value: T }>[];
    remainingKeys: readonly string[];
}>;

export interface AnalysisV2SchedulerRuntimeOptions<T> {
    capability: AiSchedulerCapability;
    tasks: readonly AnalysisV2SchedulerTask<T>[];
    checkpoint: AnalysisV2SchedulerCheckpoint<T>;
    handlerDeadlineAtMs: number;
    nowMs?: () => number;
    policy?: Partial<typeof ANALYSIS_V2_SCHEDULER_V1_POLICY>;
}

function stageLimit(
    stage: AnalysisV2SchedulerStage,
    policy: typeof ANALYSIS_V2_SCHEDULER_V1_POLICY,
): number {
    switch (stage) {
    case 'genderTriage': return policy.genderTriageConcurrency;
    case 'featureAnalysis': return policy.featureAnalysisConcurrency;
    case 'privateAccountName': return policy.privateAccountNameConcurrency;
    }
}

function assertTasks(tasks: readonly AnalysisV2SchedulerTask<unknown>[]): void {
    const keys = new Set<string>();
    let previousOrdinal = -1;
    for (const task of tasks) {
        if (!task.key || keys.has(task.key) || !Number.isSafeInteger(task.ordinal)
            || task.ordinal < 0 || task.ordinal < previousOrdinal) {
            throw new Error('ANALYSIS_V2_SCHEDULER_INVALID_TOPOLOGY');
        }
        keys.add(task.key);
        previousOrdinal = task.ordinal;
    }
}

/**
 * A deliberately small, in-process scheduler used only after a request has persisted the exact
 * scheduler-v1 snapshot. Checkpoint ownership is supplied by the durable stage store: this helper
 * never treats a returned model value as committed until `checkpoint.commit` resolves.
 *
 * Fairness is deterministic round-robin over the three stage queues. A queue rotates only when a
 * slot is admitted, so completion timing cannot change the next stage selection or result order.
 */
export async function runAnalysisV2FairAiScheduler<T>(
    input: AnalysisV2SchedulerRuntimeOptions<T>,
): Promise<AnalysisV2SchedulerRunResult<T>> {
    assertTasks(input.tasks);
    if (input.capability !== 'scheduler-v1') {
        throw new Error('ANALYSIS_V2_SCHEDULER_NOT_ENABLED');
    }
    if (!Number.isFinite(input.handlerDeadlineAtMs) || input.handlerDeadlineAtMs < 0) {
        throw new Error('ANALYSIS_V2_AI_DEADLINE_TOO_SHORT');
    }
    const policy = Object.freeze({ ...ANALYSIS_V2_SCHEDULER_V1_POLICY, ...input.policy });
    if (Object.values(policy).some(value => !Number.isSafeInteger(value) || value < 1)) {
        throw new Error('ANALYSIS_V2_SCHEDULER_INVALID_POLICY');
    }
    const nowMs = input.nowMs ?? (() => performance.now());
    const queues = new Map<AnalysisV2SchedulerStage, AnalysisV2SchedulerTask<T>[]>([
        ['genderTriage', []], ['featureAnalysis', []], ['privateAccountName', []],
    ]);
    const results = new Map<string, Readonly<{ key: string; stage: AnalysisV2SchedulerStage; value: T }>>();
    const remaining = new Set<string>();
    for (const task of input.tasks) {
        if (await input.checkpoint.hasCommitted(task.key)) continue;
        queues.get(task.stage)!.push(task);
        remaining.add(task.key);
    }

    const stages: readonly AnalysisV2SchedulerStage[] = [
        'genderTriage', 'featureAnalysis', 'privateAccountName',
    ];
    const activeByStage = new Map<AnalysisV2SchedulerStage, number>(
        stages.map(stage => [stage, 0]),
    );
    let activeTotal = 0;
    let cursor = 0;
    const active = new Set<Promise<void>>();

    const mayAdmit = () => nowMs() + policy.admissionReserveMs < input.handlerDeadlineAtMs;
    const admitOne = (): boolean => {
        if (!mayAdmit() || activeTotal >= policy.sharedConcurrency) return false;
        for (let offset = 0; offset < stages.length; offset++) {
            const index = (cursor + offset) % stages.length;
            const stage = stages[index]!;
            const queue = queues.get(stage)!;
            if (queue.length === 0 || activeByStage.get(stage)! >= stageLimit(stage, policy)) continue;
            const task = queue.shift()!;
            cursor = (index + 1) % stages.length;
            activeTotal++;
            activeByStage.set(stage, activeByStage.get(stage)! + 1);
            const execution = Promise.resolve()
                .then(task.run)
                .then(async value => {
                    await input.checkpoint.commit({ key: task.key, stage: task.stage, value });
                    results.set(task.key, { key: task.key, stage: task.stage, value });
                    remaining.delete(task.key);
                })
                .finally(() => {
                    activeTotal--;
                    activeByStage.set(stage, activeByStage.get(stage)! - 1);
                    active.delete(execution);
                });
            active.add(execution);
            return true;
        }
        return false;
    };

    while (true) {
        let admitted = false;
        while (admitOne()) admitted = true;
        if (active.size === 0) break;
        // Wait for one operation only; the loop immediately admits its fair successor.
        await Promise.race(active);
        if (!admitted && !mayAdmit() && active.size === 0) break;
    }

    const completed = input.tasks
        .map(task => results.get(task.key))
        .filter((value): value is NonNullable<typeof value> => Boolean(value));
    return Object.freeze({
        status: remaining.size === 0 ? 'completed' : 'continuation',
        completed: Object.freeze(completed),
        remainingKeys: Object.freeze(input.tasks
            .filter(task => remaining.has(task.key))
            .map(task => task.key)),
    });
}
