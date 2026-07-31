import type { AiSchedulerCapability } from '@/lib/services/ai/scheduler-policy';
import { AI_GEMINI_SDK_TIMEOUT_MS } from '@/lib/services/ai/stage-policy';
import { AnalysisV2AiTerminalUnavailableError } from './v2-ai-fallback-policy';

export const ANALYSIS_V2_SCHEDULER_COMMIT_MARGIN_MS = 15_000;

export const ANALYSIS_V2_SCHEDULER_V1_POLICY = Object.freeze({
    sharedConcurrency: 8,
    genderTriageConcurrency: 6,
    featureAnalysisConcurrency: 3,
    privateAccountNameConcurrency: 2,
    /** Do not start a paid operation unless this much handler time remains. */
    // A newly admitted provider call must fit its full SDK timeout plus durable terminalization.
    admissionReserveMs: AI_GEMINI_SDK_TIMEOUT_MS + ANALYSIS_V2_SCHEDULER_COMMIT_MARGIN_MS,
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
    /** Checkpoint-only reconstruction after DB proves the paid result already exists. */
    recover?(): Promise<T>;
    /** Deterministic safe fallback after the bounded recovery window expires. */
    terminalFallback?(): Promise<T>;
}

export type AnalysisV2SchedulerOperationClaim<T> =
    | Readonly<{
        decision: 'execute';
        claimToken: string;
        recoveryOnly?: boolean;
        terminalUnavailable?: boolean;
    }>
    | Readonly<{ decision: 'ready'; value: T }>
    | Readonly<{ decision: 'deferred'; notBeforeAtMs: number }>;

/**
 * This protocol must be implemented by the existing durable AI attempt/result stores before
 * scheduler execution is wired to production. `claim` is atomic: a repeated in-flight claim must
 * return a durable `deferred` timestamp, while a committed result must return `ready`.
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
    defer?(input: Readonly<{
        key: string;
        stage: AnalysisV2SchedulerStage;
        claimToken: string;
        reason: 'ANALYSIS_V2_AI_CAPACITY_PENDING'
            | 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT'
            | 'ANALYSIS_V2_AI_QUARANTINE_ACTIVE';
    }>): Promise<number>;
}

interface AnalysisV2SchedulerArbiterLease {
    release(): void;
}

type AnalysisV2SchedulerArbiterAcquire =
    | Readonly<{ status: 'acquired'; lease: AnalysisV2SchedulerArbiterLease }>
    | Readonly<{ status: 'blocked'; generation: number }>;

interface AnalysisV2SchedulerArbiter {
    tryAcquire(
        stage: AnalysisV2SchedulerStage,
        limits: Readonly<AnalysisV2SchedulerRuntimePolicy>,
        waiter: object,
    ): AnalysisV2SchedulerArbiterAcquire;
    cancel(waiter: object): void;
    waitForChange(
        ifUnchangedGeneration: number,
        maxWaitMs: number,
    ): Promise<'changed' | 'cutoff'>;
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
    recoveryPendingKeys: readonly string[];
    terminalUnavailableKeys: readonly string[];
    continuationDelayMs: number;
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
    /** Deterministic race hook for tests; production callers must omit it. */
    onBeforeArbiterWait?: () => Promise<void> | void;
}

type SchedulerAdmissionReason =
    | 'ANALYSIS_V2_AI_CAPACITY_PENDING'
    | 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT'
    | 'ANALYSIS_V2_AI_QUARANTINE_ACTIVE';

export class AnalysisV2SchedulerAdmissionDeferredError extends Error {
    constructor(
        readonly reason: SchedulerAdmissionReason,
        readonly notBeforeAtMs: number,
    ) {
        super(reason);
        this.name = 'AnalysisV2SchedulerAdmissionDeferredError';
    }
}

function schedulerAdmissionReason(error: unknown): SchedulerAdmissionReason | null {
    if (!(error instanceof Error)) return null;
    switch (error.message) {
    case 'ANALYSIS_V2_AI_CAPACITY_PENDING':
    case 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT':
    case 'ANALYSIS_V2_AI_QUARANTINE_ACTIVE':
        return error.message;
    default:
        return null;
    }
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
    private generation = 0;
    private sequence = 0;
    private stageCursor = 0;
    private readonly activeByStage = new Map<AnalysisV2SchedulerStage, number>();
    private readonly waiters = new Set<() => void>();
    private readonly pending = new Map<object, Readonly<{
        stage: AnalysisV2SchedulerStage;
        limits: Readonly<AnalysisV2SchedulerRuntimePolicy>;
        sequence: number;
    }>>();
    private readonly stages: readonly AnalysisV2SchedulerStage[] = [
        'genderTriage',
        'featureAnalysis',
        'privateAccountName',
    ];

    private signalChange(): void {
        this.generation++;
        const waiters = [...this.waiters];
        this.waiters.clear();
        waiters.forEach(resolve => resolve());
    }

    private canAcquire(
        stage: AnalysisV2SchedulerStage,
        limits: Readonly<AnalysisV2SchedulerRuntimePolicy>,
    ): boolean {
        return this.activeTotal < Math.min(8, limits.sharedConcurrency)
            && (this.activeByStage.get(stage) ?? 0) < Math.min(
                stageLimit(stage, limits),
                stageLimit(stage, ANALYSIS_V2_SCHEDULER_V1_POLICY),
            );
    }

    private nextPending(): object | null {
        if (this.activeTotal >= 8) return null;
        for (let offset = 0; offset < this.stages.length; offset++) {
            const stageIndex = (this.stageCursor + offset) % this.stages.length;
            const stage = this.stages[stageIndex]!;
            const candidate = [...this.pending.entries()]
                .filter(([, pending]) => (
                    pending.stage === stage
                    && this.canAcquire(pending.stage, pending.limits)
                ))
                .sort((left, right) => left[1].sequence - right[1].sequence)[0];
            if (candidate) return candidate[0];
        }
        return null;
    }

    tryAcquire(
        stage: AnalysisV2SchedulerStage,
        limits: Readonly<AnalysisV2SchedulerRuntimePolicy>,
        waiter: object,
    ): AnalysisV2SchedulerArbiterAcquire {
        if (!this.pending.has(waiter)) {
            this.pending.set(waiter, Object.freeze({
                stage,
                limits,
                sequence: this.sequence++,
            }));
            this.signalChange();
        }
        if (!this.canAcquire(stage, limits) || this.nextPending() !== waiter) {
            return Object.freeze({
                status: 'blocked' as const,
                generation: this.generation,
            });
        }
        this.pending.delete(waiter);
        const activeStage = this.activeByStage.get(stage) ?? 0;
        this.activeTotal++;
        this.activeByStage.set(stage, activeStage + 1);
        this.stageCursor = (this.stages.indexOf(stage) + 1) % this.stages.length;
        this.signalChange();
        let released = false;
        return Object.freeze({
            status: 'acquired' as const,
            lease: Object.freeze({
                release: () => {
                    if (released) return;
                    released = true;
                    this.activeTotal--;
                    this.activeByStage.set(stage, this.activeByStage.get(stage)! - 1);
                    this.signalChange();
                },
            }),
        });
    }

    cancel(waiter: object): void {
        if (this.pending.delete(waiter)) this.signalChange();
    }

    waitForChange(
        ifUnchangedGeneration: number,
        maxWaitMs: number,
    ): Promise<'changed' | 'cutoff'> {
        if (this.generation !== ifUnchangedGeneration) {
            return Promise.resolve('changed');
        }
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
 * `execute`; ready results are skipped and uncertain operations defer to bounded durable recovery.
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
    const recoveryPending = new Set<string>();
    const terminalUnavailable = new Set<string>();
    let nextNotBeforeAtMs = Number.POSITIVE_INFINITY;
    input.tasks.forEach(task => queues.get(task.stage)!.push(task));

    const stages: readonly AnalysisV2SchedulerStage[] = [
        'genderTriage', 'featureAnalysis', 'privateAccountName',
    ];
    const arbiterWaiters = new Map(
        stages.map(stage => [stage, Object.freeze({})] as const),
    );
    let cursor = 0;
    const active = new Set<Promise<void>>();
    let fatalError: unknown;
    const mayAdmit = () => nowMs() + policy.admissionReserveMs < input.handlerDeadlineAtMs;

    const admitOne = async (): Promise<
        | Readonly<{ status: 'admitted' | 'handled' }>
        | Readonly<{ status: 'blocked'; generation: number | null }>
    > => {
        if (!mayAdmit()) return { status: 'blocked', generation: null };
        let blockedGeneration: number | null = null;
        for (let offset = 0; offset < stages.length; offset++) {
            const index = (cursor + offset) % stages.length;
            const stage = stages[index]!;
            const queue = queues.get(stage)!;
            const task = queue[0];
            if (!task) continue;
            const waiter = arbiterWaiters.get(stage)!;
            const acquire = arbiter.tryAcquire(stage, policy, waiter);
            if (acquire.status === 'blocked') {
                blockedGeneration = acquire.generation;
                continue;
            }
            const { lease } = acquire;
            const claim = await input.operationStore.claim({
                key: task.key,
                stage: task.stage,
            }).catch(error => {
                lease.release();
                throw error;
            });
            if (claim.decision === 'deferred') {
                queue.shift();
                arbiter.cancel(waiter);
                recoveryPending.add(task.key);
                nextNotBeforeAtMs = Math.min(
                    nextNotBeforeAtMs,
                    claim.notBeforeAtMs,
                );
                lease.release();
                return { status: 'handled' };
            }
            queue.shift();
            arbiter.cancel(waiter);
            cursor = (index + 1) % stages.length;
            if (claim.decision === 'ready') {
                results.set(task.key, {
                    key: task.key,
                    stage: task.stage,
                    value: claim.value,
                });
                remaining.delete(task.key);
                lease.release();
                return { status: 'handled' };
            }
            if (claim.terminalUnavailable && !task.terminalFallback) {
                lease.release();
                throw new Error('ANALYSIS_V2_SCHEDULER_TERMINAL_HANDLER_MISSING');
            }
            if (claim.recoveryOnly && !claim.terminalUnavailable && !task.recover) {
                lease.release();
                throw new Error('ANALYSIS_V2_SCHEDULER_RECOVERY_HANDLER_MISSING');
            }
            const operation = claim.terminalUnavailable
                ? task.terminalFallback!
                : claim.recoveryOnly ? task.recover! : task.run;
            const execution = Promise.resolve()
                .then(operation)
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
                .catch(async error => {
                    if (
                        claim.terminalUnavailable
                        && error instanceof AnalysisV2AiTerminalUnavailableError
                    ) {
                        terminalUnavailable.add(task.key);
                        remaining.delete(task.key);
                        return;
                    }
                    const reason = schedulerAdmissionReason(error);
                    if (reason && input.operationStore.defer) {
                        const notBeforeAtMs = await input.operationStore.defer({
                            key: task.key,
                            stage: task.stage,
                            claimToken: claim.claimToken,
                            reason,
                        });
                        fatalError ??= new AnalysisV2SchedulerAdmissionDeferredError(
                            reason,
                            notBeforeAtMs,
                        );
                        return;
                    }
                    fatalError ??= error;
                })
                .finally(() => {
                    lease.release();
                    active.delete(execution);
                });
            active.add(execution);
            return { status: 'admitted' };
        }
        return { status: 'blocked', generation: blockedGeneration };
    };

    try {
        while (remaining.size > 0) {
            let admittedOrHandled = false;
            let blockedGeneration: number | null = null;
            while (mayAdmit() && fatalError === undefined) {
                const admission = await admitOne();
                if (admission.status === 'blocked') {
                    blockedGeneration = admission.generation;
                    break;
                }
                admittedOrHandled = true;
            }
            if (active.size > 0) {
                await Promise.race(active);
                continue;
            }
            if (fatalError !== undefined) throw fatalError;
            if (!mayAdmit()) break;
            if (!admittedOrHandled) {
                if (blockedGeneration === null) break;
                await input.onBeforeArbiterWait?.();
                const waitOutcome = await arbiter.waitForChange(
                    blockedGeneration,
                    input.handlerDeadlineAtMs - policy.admissionReserveMs - nowMs(),
                );
                if (waitOutcome === 'cutoff') break;
            }
        }
    } finally {
        arbiterWaiters.forEach(waiter => arbiter.cancel(waiter));
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
        recoveryPendingKeys: Object.freeze(input.tasks
            .filter(task => recoveryPending.has(task.key))
            .map(task => task.key)),
        terminalUnavailableKeys: Object.freeze(input.tasks
            .filter(task => terminalUnavailable.has(task.key))
            .map(task => task.key)),
        continuationDelayMs: Number.isFinite(nextNotBeforeAtMs)
            ? Math.min(300_000, Math.max(1_000, nextNotBeforeAtMs - nowMs()))
            : 1_000,
    });
}
