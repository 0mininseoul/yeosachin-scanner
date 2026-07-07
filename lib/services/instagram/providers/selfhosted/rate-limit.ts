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
