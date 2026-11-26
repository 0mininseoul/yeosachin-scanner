import { currentStandardResolverAdmission, observeResolverAdmission, remainingResolverAdmissionWait } from './standard-resolver-admission';
import { AI_SHARED_CONCURRENCY_LIMIT, getAiStagePolicy, type AiStageName, type AiStagePolicyVersion } from './stage-policy';

interface GeminiSemaphoreWaiter {
    resolve: () => void;
    reject: (error: unknown) => void;
    limit: number;
    signal?: AbortSignal;
    onAbort?: () => void;
}

export class AsyncSemaphore {
    private active = 0;
    private readonly queue: GeminiSemaphoreWaiter[] = [];

    constructor(private readonly limit: number) {}

    async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
        await this.acquire(signal);
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    tryAcquire(limit = this.limit): (() => void) | null {
        if (this.active >= limit || this.queue.length) return null;
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

    private acquire(signal?: AbortSignal, limit = this.limit): Promise<void> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new Error('ABORTED'));
        }
        if (this.active < limit && !this.queue.length) {
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
                this.admitWaiters();
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
        this.admitWaiters();
    }

    private admitWaiters(): void {
        while (this.queue.length && this.active < this.queue[0].limit) {
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
    stages: Map<string, AsyncSemaphore>;
}

export function createGeminiGenerationLimiter(): GeminiGenerationLimiterState {
    return { shared: new AsyncSemaphore(AI_SHARED_CONCURRENCY_LIMIT), stages: new Map() };
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

    const semaphore = new AsyncSemaphore(getAiStagePolicy(policyVersion, stage).concurrency);
    state.stages.set(key, semaphore);
    return semaphore;
}

// A worker still shares one eight-call semaphore. At most four of those permits
// can be used by the admitted Standard resolver, including existing legacy calls.
export function acquireResolverPermit(
    semaphore: AsyncSemaphore,
    reason: 'worker_stage' | 'worker_shared',
): (() => void) | Promise<() => void> {
    const trial = currentStandardResolverAdmission();
    const limit = reason === 'worker_stage' && trial ? 4 : undefined;
    trial?.signal.throwIfAborted();
    const immediate = semaphore.tryAcquire(limit);
    if (immediate) return immediate;
    observeResolverAdmission(reason, 'contended');
    const remaining = remainingResolverAdmissionWait();
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
            throw new Error('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
        }).finally(() => clearTimeout(timer));
    }
    observeResolverAdmission(reason, 'skipped');
    throw new Error('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
}
