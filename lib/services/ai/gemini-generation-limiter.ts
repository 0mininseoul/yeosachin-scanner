import { AI_SHARED_CONCURRENCY_LIMIT, getAiStagePolicy, type AiStageName, type AiStagePolicyVersion } from './stage-policy';

interface GeminiSemaphoreWaiter {
    resolve: () => void;
    reject: (error: unknown) => void;
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

    tryAcquire(): (() => void) | null {
        if (this.active >= this.limit) return null;
        this.active++;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.release();
        };
    }

    private acquire(signal?: AbortSignal): Promise<void> {
        if (signal?.aborted) {
            return Promise.reject(signal.reason ?? new Error('ABORTED'));
        }
        if (this.active < this.limit) {
            this.active++;
            return Promise.resolve();
        }

        return new Promise<void>((resolve, reject) => {
            const waiter: GeminiSemaphoreWaiter = {
                resolve,
                reject,
                signal,
            };
            const onAbort = () => {
                const index = this.queue.indexOf(waiter);
                if (index >= 0) this.queue.splice(index, 1);
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
        while (this.queue.length > 0) {
            const next = this.queue.shift();
            if (!next) break;
            next.signal?.removeEventListener('abort', next.onAbort as EventListener);
            if (next.signal?.aborted) {
                next.reject(next.signal.reason ?? new Error('ABORTED'));
                continue;
            }
            next.resolve();
            return;
        }

        this.active--;
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
