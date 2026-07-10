/** 동시 실행 개수를 concurrency로 제한하는 러너를 만든다. */
export function pLimit(concurrency: number) {
    let active = 0;
    const queue: Array<() => void> = [];

    const next = () => {
        active--;
        const run = queue.shift();
        if (run) run();
    };

    return function <T>(fn: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const run = () => {
                active++;
                fn().then(resolve, reject).finally(next);
            };
            if (active < concurrency) run();
            else queue.push(run);
        });
    };
}

export interface RequestStartGate {
    schedule<T>(task: () => Promise<T>, minIntervalMs: number): Promise<T>;
}

/** Process-shared callers can serialize request starts without holding the gate for response time. */
export function createRequestStartGate(
    now: () => number = Date.now,
    wait: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
): RequestStartGate {
    let tail: Promise<void> = Promise.resolve();
    let nextStartAt = 0;

    return {
        schedule<T>(task: () => Promise<T>, minIntervalMs: number): Promise<T> {
            const gate = tail.then(async () => {
                const delayMs = Math.max(0, nextStartAt - now());
                if (delayMs > 0) await wait(delayMs);
                nextStartAt = now() + minIntervalMs;
            });
            tail = gate.then(() => undefined, () => undefined);
            return gate.then(task);
        },
    };
}

export interface RetryOptions {
    retries?: number;
    baseDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 지수 백오프 + 지터로 재시도. retries회 추가 시도. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
    const retries = opts.retries ?? 2;
    const baseDelayMs = opts.baseDelayMs ?? 500;
    let lastError: unknown;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                const jitter = Math.random() * baseDelayMs;
                await sleep(baseDelayMs * 2 ** attempt + jitter);
            }
        }
    }
    throw lastError;
}
