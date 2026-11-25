import { setTimeout as sleep } from 'node:timers/promises';

export type SharedPayload = Record<string, unknown>;
interface Task {
    name: string;
    due: number;
    payload: SharedPayload;
}

// Keep created names after acknowledgement, just as Cloud Tasks rejects duplicate task names.
export class StandardSharedQueue {
    private pending: Task[] = [];
    private created = new Set<string>();
    private delivered = new WeakMap<SharedPayload, Task>();
    private inFlight = new Set<string>();
    private firstAttempts = new WeakMap<SharedPayload, number>();
    private buckets = new Map<string, { tokens: number; replenishedAt: number }>();
    readonly retryPolicy;
    readonly burst = 10;

    constructor(observedTiming: boolean) {
        this.retryPolicy = {
            minBackoffSeconds: observedTiming ? 40 : 1, maxBackoffSeconds: observedTiming ? 300 : 32,
            maxDoublings: 4, maxAttempts: 8, maxRetrySeconds: 3600
        };
    }

    private attempts = new WeakMap<SharedPayload, number>();
    duplicateCreates = 0;
    peakWorkers = 0;
    readonly client = {
        queuePath: (...parts: string[]) => this.path(parts),
        taskPath: (...parts: string[]) => this.path(parts),
        createTask: async ({ task }: { task: { name: string; scheduleTime?: { seconds: number }; httpRequest: { body: string } } }) => {
            if (this.created.has(task.name)) {
                this.duplicateCreates++;
                throw Object.assign(new Error('ALREADY_EXISTS'), { code: 6 });
            }
            const payload = JSON.parse(Buffer.from(task.httpRequest.body, 'base64').toString('utf8'));
            this.created.add(task.name);
            this.pending.push({ name: task.name, due: Number(task.scheduleTime?.seconds ?? 0) * 1000, payload });
            return [{ name: task.name }];
        },
        getTask: async ({ name }: { name: string }) => {
            if (!this.inFlight.has(name) && !this.pending.some(task => task.name === name)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
            return [{ name }];
        },
    };
    private path([project, location, queue, task]: string[]) {
        return 'projects/' + project + '/locations/' + location + '/queues/' + queue + (task ? '/tasks/' + task : '');
    }
    get size() { return this.pending.length; }
    retryCount(payload: SharedPayload) { return this.attempts.get(payload) ?? 0; }
    retry(payload: SharedPayload) {
        const task = this.delivered.get(payload);
        if (!task) throw new Error('SHARED_QUEUE_RETRY_WITHOUT_DELIVERY');
        const count = this.retryCount(payload) + 1;
        // Cloud Tasks terminates when both positive limits have been reached.
        const policy = this.retryPolicy;
        const started = this.firstAttempts.get(payload)!;
        if (count >= policy.maxAttempts && Date.now() - started >= policy.maxRetrySeconds * 1000)
            throw new Error('SHARED_QUEUE_RETRY_LIMIT');
        const doubles = Math.min(count - 1, policy.maxDoublings);
        const factor = 2 ** doubles * (count - doubles);
        const seconds = Math.min(factor * policy.minBackoffSeconds, policy.maxBackoffSeconds);
        this.attempts.set(payload, count);
        this.pending.push({ ...task, due: Date.now() + seconds * 1000 });
    }
    async drain(matches: (payload: SharedPayload) => boolean, concurrency: number, deliver: (payload: SharedPayload, worker: number) => Promise<void>) {
        const running = new Set<Promise<void>>();
        const availableWorkers = Array.from({ length: concurrency }, (_, index) => index);
        let firstError: unknown;
        let deliveries = 0;
        while (!firstError) {
            const next = this.pending.filter(task => matches(task.payload)).sort((a, b) => a.due - b.due)[0];
            if (!next && running.size === 0) break;
            if (!next || running.size >= concurrency) {
                await Promise.race(running);
                continue;
            }
            if (next.due > Date.now()) {
                // Wake when a delivery adds earlier work, as well as at the next due time.
                await sleep(Math.min(next.due - Date.now(), 50));
                continue;
            }
            // A queue shares its burst across fresh admission and subsequent DAG deliveries.
            const now = performance.now();
            const queue = next.name.split('/tasks/')[0];
            const bucket = this.buckets.get(queue) ?? { tokens: this.burst, replenishedAt: now };
            this.buckets.set(queue, bucket);
            bucket.tokens = Math.min(this.burst, bucket.tokens + (now - bucket.replenishedAt) * concurrency / 1000);
            bucket.replenishedAt = now;
            if (bucket.tokens < 1) {
                await sleep(Math.ceil((1 - bucket.tokens) * 1000 / concurrency));
                continue;
            }
            bucket.tokens--;
            if (++deliveries > 50_000) { firstError = new Error('SHARED_QUEUE_DELIVERY_LIMIT'); break; }
            this.pending.splice(this.pending.indexOf(next), 1);
            this.delivered.set(next.payload, next);
            if (!this.firstAttempts.has(next.payload)) this.firstAttempts.set(next.payload, Date.now());
            const worker = availableWorkers.shift()!;
            this.inFlight.add(next.name);
            const task = deliver(next.payload, worker).catch(error => { firstError ??= error; }).finally(() => {
                this.inFlight.delete(next.name);
                availableWorkers.push(worker);
                running.delete(task);
            });
            running.add(task);
            this.peakWorkers = Math.max(this.peakWorkers, running.size);
        }
        await Promise.all(running);
        if (firstError) throw firstError;
        return deliveries;
    }
}
