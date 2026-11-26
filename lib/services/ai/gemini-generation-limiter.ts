import { currentStandardResolverAdmission, observeCachedResolverLocal, observeResolverAdmission, remainingResolverAdmissionWait } from './standard-resolver-admission';
import { AI_GEMINI_MIN_REMAINING_MS, AI_GEMINI_SDK_TIMEOUT_MS, AI_SHARED_CONCURRENCY_LIMIT, getAiStagePolicy, type AiStageName, type AiStagePolicyVersion } from './stage-policy';

type PermitLimit = number | (() => number);

interface GeminiSemaphoreWaiter {
    resolve: () => void;
    reject: (error: unknown) => void;
    limit: PermitLimit;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export class AsyncSemaphore {
    private active = 0;
    private readonly queue: GeminiSemaphoreWaiter[] = [];

    constructor(private readonly limit: number, private readonly maximum = Infinity) {}

    async run<T>(task: () => Promise<T>, signal?: AbortSignal, limit: PermitLimit = this.limit): Promise<T> {
        await this.acquire(signal, limit);
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    tryAcquire(limit = this.limit): (() => void) | null {
        if (this.active >= this.effectiveLimit(limit) || this.queue.length) return null;
        this.active++;
        return this.releaseOnce();
    }

    async acquirePermit(signal: AbortSignal, limit = this.limit): Promise<() => void> {
        await this.acquire(signal, limit);
        return this.releaseOnce();
    }

    private releaseOnce() {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.release();
        };
    }

    private effectiveLimit(limit: PermitLimit): number {
        return Math.min(this.maximum, typeof limit === 'number' ? limit : limit());
    }

    private acquire(signal?: AbortSignal, limit: PermitLimit = this.limit): Promise<void> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new Error('ABORTED'));
        }
        if (this.active < this.effectiveLimit(limit) && !this.queue.length) {
            this.active++;
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const waiter: GeminiSemaphoreWaiter = {
                resolve,
                limit,
                reject,
                signal,
            };
            const onAbort = () => {
                const index = this.queue.indexOf(waiter);
                if (index >= 0) this.queue.splice(index, 1);
                this.recheckWaiters();
                signal?.removeEventListener('abort', onAbort);
                reject(signal?.reason ?? new Error('ABORTED'));
            };
            waiter.onAbort = onAbort;
            signal?.addEventListener('abort', onAbort, { once: true });
            this.queue.push(waiter);
            if (signal?.aborted) onAbort();
        });
    }

    private release(): void {
        this.active--;
        this.recheckWaiters();
    }

    recheckWaiters(): void {
        while (this.queue.length && this.active < this.effectiveLimit(this.queue[0].limit)) {
            const next = this.queue.shift();
            if (!next) break;
            next.signal?.removeEventListener('abort', next.onAbort as EventListener);
            if (next.signal?.aborted) {
                next.reject(next.signal.reason ?? new Error('ABORTED'));
                continue;
            }
            this.active++;
            next.resolve();
        }
    }
}

interface GeminiGenerationLimiterState {
    shared: AsyncSemaphore;
    featureMix: { slots: AsyncSemaphore; expandedInterest: number };
    stages: Map<string, AsyncSemaphore>;
}

export function createGeminiGenerationLimiter(): GeminiGenerationLimiterState {
    return {
        shared: new AsyncSemaphore(AI_SHARED_CONCURRENCY_LIMIT),
        featureMix: { slots: new AsyncSemaphore(AI_SHARED_CONCURRENCY_LIMIT), expandedInterest: 0 },
        stages: new Map(),
    };
}

const processScope = globalThis as typeof globalThis & {
    __AI_BARAM_GEMINI_GENERATION_LIMITER_V1__?: GeminiGenerationLimiterState;
};

export function getGeminiGenerationLimiter() {
    return processScope.__AI_BARAM_GEMINI_GENERATION_LIMITER_V1__ ??= createGeminiGenerationLimiter();
}

export function getStageGenerationSemaphore(
    state: GeminiGenerationLimiterState,
    policyVersion: AiStagePolicyVersion,
    stage: AiStageName,
): AsyncSemaphore {
    const key = `${policyVersion}:${stage}`;
    const existing = state.stages.get(key);
    if (existing) return existing;

    const concurrency = getAiStagePolicy(policyVersion, stage).concurrency;
    const maximum = stage === 'featureAnalysis' && policyVersion === 'ai-stage-policy-v2.11' ? 4 : undefined;
    const semaphore = new AsyncSemaphore(concurrency, maximum);
    state.stages.set(key, semaphore);
    return semaphore;
}

// A signed waiter joins before reserving money or auditing an attempt. Older
// legacy waiters retain FIFO priority; new ones cannot fill slots ahead of it.
export async function acquirePaidFeatureSlot(
    { featureMix }: GeminiGenerationLimiterState, handlerDeadlineAtMs: number | undefined, signal?: AbortSignal,
): Promise<() => void> {
    signal?.throwIfAborted();
    const latest = handlerDeadlineAtMs === undefined ? undefined : handlerDeadlineAtMs - AI_GEMINI_MIN_REMAINING_MS;
    if (latest !== undefined && (!Number.isFinite(latest) || latest <= performance.now())) {
        throw new Error('ANALYSIS_V2_AI_DEADLINE_TOO_SHORT');
    }
    const waitMs = latest === undefined ? 0 : Math.floor(Math.min(AI_GEMINI_SDK_TIMEOUT_MS, latest - performance.now()));
    featureMix.expandedInterest++;
    try {
        let release = featureMix.slots.tryAcquire(4);
        if (!release) {
            if (waitMs < 1) throw new Error('ANALYSIS_V2_AI_CAPACITY_PENDING');
            const timeout = AbortSignal.timeout(waitMs);
            const bounded = signal ? AbortSignal.any([signal, timeout]) : timeout;
            try {
                release = await featureMix.slots.acquirePermit(bounded, 4);
            } catch (error) {
                signal?.throwIfAborted();
                if (!timeout.aborted) throw error;
                throw new Error(latest !== undefined && performance.now() + 1 >= latest
                    ? 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT' : 'ANALYSIS_V2_AI_CAPACITY_PENDING');
            }
        }
        if (signal?.aborted || (latest !== undefined && performance.now() >= latest)) {
            release();
            signal?.throwIfAborted();
            throw new Error('ANALYSIS_V2_AI_DEADLINE_TOO_SHORT');
        }
        let returned = false;
        return () => {
            if (returned) return;
            returned = true;
            featureMix.expandedInterest--;
            release();
        };
    } catch (error) {
        featureMix.expandedInterest--;
        featureMix.slots.recheckWaiters();
        throw error;
    }
}

export async function runWithMixedFeatureSlot<T>(
    { featureMix }: GeminiGenerationLimiterState, wait: boolean, task: () => Promise<T>, signal?: AbortSignal,
): Promise<T> {
    const limit = () => featureMix.expandedInterest > 0 ? 4 : AI_SHARED_CONCURRENCY_LIMIT;
    if (wait) return featureMix.slots.run(task, signal, limit);
    const release = featureMix.slots.tryAcquire(limit());
    if (!release) throw new Error('ANALYSIS_V2_AI_CAPACITY_PENDING');
    try { return await task(); } finally { release(); }
}

/** A local slot wait ended before entering the dispatched function or reserving an AI attempt. */
export class LocalResolverPermitTimeoutError extends Error {
    constructor(readonly attempt: number) {
        super('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
    }
}

// A worker still shares one eight-call semaphore. At most four of those permits
// can be used by the admitted Standard resolver, including existing legacy calls.
export function acquireResolverPermit(
    semaphore: AsyncSemaphore,
    reason: 'worker_stage' | 'worker_shared',
    attempt: number,
    localDeadline?: number,
): (() => void) | Promise<() => void> {
    const trial = currentStandardResolverAdmission();
    const limit = reason === 'worker_stage' && trial ? 4 : undefined;
    trial?.signal.throwIfAborted();
    const immediate = semaphore.tryAcquire(limit);
    if (immediate) return immediate;
    observeResolverAdmission(reason, 'contended');
    // Physical admission keeps its original five-second contention clock.
    const normalRemaining = remainingResolverAdmissionWait();
    const remaining = localDeadline === undefined ? normalRemaining : Math.max(0, Math.ceil(localDeadline - performance.now()));
    if (trial && remaining > 0) {
        const timeout = new AbortController();
        const signal = AbortSignal.any([timeout.signal, trial.signal]);
        const timer = setTimeout(() => timeout.abort(), remaining);
        return semaphore.acquirePermit(signal, limit).then(release => {
            observeResolverAdmission(reason, 'admitted_after_wait');
            return release;
        }, error => {
            trial.signal.throwIfAborted();
            if (!timeout.signal.aborted) throw error;
            observeResolverAdmission(reason, 'skipped');
            throw new LocalResolverPermitTimeoutError(attempt);
        }).finally(() => clearTimeout(timer));
    }
    observeResolverAdmission(reason, 'skipped');
    if (trial) throw new LocalResolverPermitTimeoutError(attempt);
    throw new Error('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
}

/** Acquires one local stage permit and one worker permit, unwinding both on every failure. */
export async function acquireResolverGenerationSlots(
    state: GeminiGenerationLimiterState, policyVersion: AiStagePolicyVersion, attempt: number, localDeadline?: number,
): Promise<() => void> {
    const stage = getStageGenerationSemaphore(state, policyVersion, 'genderResolution');
    const stagePermit = acquireResolverPermit(stage, 'worker_stage', attempt, localDeadline);
    const releaseStage = typeof stagePermit === 'function' ? stagePermit : await stagePermit;
    try {
        const sharedPermit = acquireResolverPermit(state.shared, 'worker_shared', attempt, localDeadline);
        const releaseShared = typeof sharedPermit === 'function' ? sharedPermit : await sharedPermit;
        return () => { releaseShared(); releaseStage(); };
    } catch (error) {
        releaseStage();
        throw error;
    }
}

/** The cached first attempt may spend fifteen seconds in both local queues together. */
export async function acquireCachedResolverSlots(
    state: GeminiGenerationLimiterState, policyVersion: AiStagePolicyVersion, handlerDeadline: number, signal: AbortSignal,
) {
    const start = performance.now();
    const latestStart = handlerDeadline - AI_GEMINI_MIN_REMAINING_MS;
    const deadline = Math.min(start + 15_000, latestStart);
    let release: (() => void) | undefined;
    observeCachedResolverLocal('entered');
    try {
        signal.throwIfAborted();
        if (start >= latestStart) throw new Error('ANALYSIS_V2_AI_DEADLINE_TOO_SHORT');
        release = await acquireResolverGenerationSlots(state, policyVersion, 1, deadline);
        signal.throwIfAborted();
        const now = performance.now();
        if (now >= latestStart) throw new Error('ANALYSIS_V2_AI_DEADLINE_TOO_SHORT');
        if (now >= deadline) throw new LocalResolverPermitTimeoutError(1);
        observeCachedResolverLocal(now - start > 5_000 ? 'after_5s' : 'within_5s');
        return { release, latestStart };
    } catch (error) {
        release?.();
        if (signal.aborted) observeCachedResolverLocal('aborted');
        else if ((error instanceof LocalResolverPermitTimeoutError && performance.now() >= latestStart)
            || (error instanceof Error && error.message === 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT')) {
            observeCachedResolverLocal('deadline');
            throw new Error('ANALYSIS_V2_AI_DEADLINE_TOO_SHORT');
        } else observeCachedResolverLocal(error instanceof LocalResolverPermitTimeoutError ? 'timeout' : 'error');
        throw error;
    }
}
