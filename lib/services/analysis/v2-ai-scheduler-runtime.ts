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

export type AnalysisV2SchedulerOperationClaim<T> =
    | Readonly<{ decision: 'execute'; claimToken: string }>
    | Readonly<{ decision: 'ready'; value: T }>
    | Readonly<{ decision: 'ambiguous' }>;

/**
 * This protocol must be implemented by the existing durable AI attempt/result stores before
 * scheduler execution is wired to production. `claim` is atomic: a repeated in-flight claim must
 * return `ambiguous`, while a committed result must return `ready`.
 */
export interface AnalysisV2SchedulerOperationStore<T> {
    claim(input: Readonly<{
        key: string;
        stage: AnalysisV2SchedulerStage;
    }>): Promise<AnalysisV2SchedulerOperationClaim<T>>;
    commitReady(input: Readonly<{
        key: string;
        stage: AnalysisV2SchedulerStage;
        claimToken: string;
        value: T;
    }>): Promise<void>;
}

interface AnalysisV2SchedulerArbiterLease {
    release(): void;
}

interface AnalysisV2SchedulerArbiter {
    tryAcquire(
        stage: AnalysisV2SchedulerStage,
        limits: Readonly<AnalysisV2SchedulerRuntimePolicy>,
    ): AnalysisV2SchedulerArbiterLease | null;
    waitForChange(maxWaitMs: number): Promise<'changed' | 'cutoff'>;
}

export interface AnalysisV2SchedulerRuntimePolicy {
    sharedConcurrency: number;
    genderTriageConcurrency: number;
    featureAnalysisConcurrency: number;
    privateAccountNameConcurrency: number;
    admissionReserveMs: number;
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
    operationStore: AnalysisV2SchedulerOperationStore<T>;
    handlerDeadlineAtMs: number;
    nowMs?: () => number;
    /**
     * Test/rollout overrides may only lower concurrency or increase the admission reserve.
     * Values are clamped against the hard scheduler-v1 ceiling.
     */
    policy?: Partial<AnalysisV2SchedulerRuntimePolicy>;
}

function stageLimit(
    stage: AnalysisV2SchedulerStage,
    policy: Readonly<AnalysisV2SchedulerRuntimePolicy>,
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

function boundedPolicy(
    override: Partial<AnalysisV2SchedulerRuntimePolicy> | undefined,
): Readonly<AnalysisV2SchedulerRuntimePolicy> {
    if (
        override
        && Object.values(override).some(value => (
            value !== undefined && (!Number.isSafeInteger(value) || value < 1)
        ))
    ) {
        throw new Error('ANALYSIS_V2_SCHEDULER_INVALID_POLICY');
    }
    const hard = ANALYSIS_V2_SCHEDULER_V1_POLICY;
    return Object.freeze({
        sharedConcurrency: Math.min(
            hard.sharedConcurrency,
            override?.sharedConcurrency ?? hard.sharedConcurrency,
        ),
        genderTriageConcurrency: Math.min(
            hard.genderTriageConcurrency,
            override?.genderTriageConcurrency ?? hard.genderTriageConcurrency,
        ),
        featureAnalysisConcurrency: Math.min(
            hard.featureAnalysisConcurrency,
            override?.featureAnalysisConcurrency ?? hard.featureAnalysisConcurrency,
        ),
        privateAccountNameConcurrency: Math.min(
            hard.privateAccountNameConcurrency,
            override?.privateAccountNameConcurrency ?? hard.privateAccountNameConcurrency,
        ),
        admissionReserveMs: Math.max(
            hard.admissionReserveMs,
            override?.admissionReserveMs ?? hard.admissionReserveMs,
        ),
    });
}

class ProcessWideAnalysisV2SchedulerArbiter implements AnalysisV2SchedulerArbiter {
    private activeTotal = 0;
    private readonly activeByStage = new Map<AnalysisV2SchedulerStage, number>();
    private readonly waiters = new Set<() => void>();

    tryAcquire(
        stage: AnalysisV2SchedulerStage,
        limits: Readonly<AnalysisV2SchedulerRuntimePolicy>,
    ): AnalysisV2SchedulerArbiterLease | null {
        const activeStage = this.activeByStage.get(stage) ?? 0;
        if (
            this.activeTotal >= Math.min(8, limits.sharedConcurrency)
            || activeStage >= Math.min(stageLimit(stage, limits), stageLimit(
                stage,
                ANALYSIS_V2_SCHEDULER_V1_POLICY,
            ))
        ) {
            return null;
        }
        this.activeTotal++;
        this.activeByStage.set(stage, activeStage + 1);
        let released = false;
        return Object.freeze({
            release: () => {
                if (released) return;
                released = true;
                this.activeTotal--;
                this.activeByStage.set(stage, this.activeByStage.get(stage)! - 1);
                const waiters = [...this.waiters];
                this.waiters.clear();
                waiters.forEach(resolve => resolve());
            },
        });
    }

    waitForChange(maxWaitMs: number): Promise<'changed' | 'cutoff'> {
        if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) {
            return Promise.resolve('cutoff');
        }
        return new Promise(resolve => {
            let settled = false;
            const done = (outcome: 'changed' | 'cutoff') => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                this.waiters.delete(changed);
                resolve(outcome);
            };
            const changed = () => done('changed');
            this.waiters.add(changed);
            const timer = setTimeout(() => done('cutoff'), maxWaitMs);
        });
    }
}

const schedulerProcessScope = globalThis as typeof globalThis & {
    __AI_BARAM_ANALYSIS_V2_SCHEDULER_ARBITER_V1__?: AnalysisV2SchedulerArbiter;
};
const processWideSchedulerArbiter =
    schedulerProcessScope.__AI_BARAM_ANALYSIS_V2_SCHEDULER_ARBITER_V1__
    ?? new ProcessWideAnalysisV2SchedulerArbiter();
schedulerProcessScope.__AI_BARAM_ANALYSIS_V2_SCHEDULER_ARBITER_V1__ =
    processWideSchedulerArbiter;

/**
 * A deliberately small scheduler seam used only after a request has persisted the exact
 * scheduler-v1 snapshot. Paid work is refused unless `operationStore.claim` atomically returns
 * `execute`; ready results are skipped and ambiguous operations fail closed for durable recovery.
 *
 * Fairness is deterministic round-robin over the three stage queues. A queue rotates only when a
 * slot is admitted, so completion timing cannot change result ordering.
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
    const policy = boundedPolicy(input.policy);
    const arbiter = processWideSchedulerArbiter;
    const nowMs = input.nowMs ?? (() => performance.now());
    const queues = new Map<AnalysisV2SchedulerStage, AnalysisV2SchedulerTask<T>[]>([
        ['genderTriage', []], ['featureAnalysis', []], ['privateAccountName', []],
    ]);
    const results = new Map<string, Readonly<{
        key: string;
        stage: AnalysisV2SchedulerStage;
        value: T;
    }>>();
    const remaining = new Set(input.tasks.map(task => task.key));
    input.tasks.forEach(task => queues.get(task.stage)!.push(task));

    const stages: readonly AnalysisV2SchedulerStage[] = [
        'genderTriage', 'featureAnalysis', 'privateAccountName',
    ];
    let cursor = 0;
    const active = new Set<Promise<void>>();
    const mayAdmit = () => nowMs() + policy.admissionReserveMs < input.handlerDeadlineAtMs;

    const admitOne = async (): Promise<'admitted' | 'handled' | 'blocked'> => {
        if (!mayAdmit()) return 'blocked';
        for (let offset = 0; offset < stages.length; offset++) {
            const index = (cursor + offset) % stages.length;
            const stage = stages[index]!;
            const queue = queues.get(stage)!;
            const task = queue[0];
            if (!task) continue;
            const lease = arbiter.tryAcquire(stage, policy);
            if (!lease) continue;
            const claim = await input.operationStore.claim({
                key: task.key,
                stage: task.stage,
            }).catch(error => {
                lease.release();
                throw error;
            });
            if (claim.decision === 'ambiguous') {
                lease.release();
                throw new Error('ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING');
            }
            queue.shift();
            cursor = (index + 1) % stages.length;
            if (claim.decision === 'ready') {
                results.set(task.key, {
                    key: task.key,
                    stage: task.stage,
                    value: claim.value,
                });
                remaining.delete(task.key);
                lease.release();
                return 'handled';
            }
            const execution = Promise.resolve()
                .then(task.run)
                .then(async value => {
                    await input.operationStore.commitReady({
                        key: task.key,
                        stage: task.stage,
                        claimToken: claim.claimToken,
                        value,
                    });
                    results.set(task.key, { key: task.key, stage: task.stage, value });
                    remaining.delete(task.key);
                })
                .finally(() => {
                    lease.release();
                    active.delete(execution);
                });
            active.add(execution);
            return 'admitted';
        }
        return 'blocked';
    };

    while (remaining.size > 0) {
        let admittedOrHandled = false;
        while (mayAdmit()) {
            const admission = await admitOne();
            if (admission === 'blocked') break;
            admittedOrHandled = true;
        }
        if (active.size > 0) {
            await Promise.race(active);
            continue;
        }
        if (!mayAdmit()) break;
        if (!admittedOrHandled) {
            const waitOutcome = await arbiter.waitForChange(
                input.handlerDeadlineAtMs - policy.admissionReserveMs - nowMs(),
            );
            if (waitOutcome === 'cutoff') break;
        }
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
