import { describe, expect, it, vi } from 'vitest';
import {
    createReplayAbortableBoundedSemaphore,
    createReplayProviderAttemptSemaphore,
} from './replay-staged-ai-adapter';

describe('v2.11 replay resolver admission', () => {
    it('removes an aborted waiter before it can start a paid task', async () => {
        const run = createReplayAbortableBoundedSemaphore(1);
        const deadlineAtMs = performance.now() + 100;
        let release!: () => void;
        const first = run(() => new Promise<void>(resolve => { release = resolve; }), new AbortController().signal, deadlineAtMs);
        const controller = new AbortController();
        const paid = vi.fn(async () => undefined);
        const queued = run(paid, controller.signal, deadlineAtMs);
        controller.abort();
        await expect(queued).rejects.toThrow('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
        release();
        await first;
        await run(paid, new AbortController().signal, performance.now() + 100);
        expect(paid).toHaveBeenCalledOnce();
    });

    it('uses one absolute deadline and never starts a waiter after it expires', async () => {
        const run = createReplayAbortableBoundedSemaphore(1);
        let release!: () => void;
        const first = run(
            () => new Promise<void>(resolve => { release = resolve; }),
            new AbortController().signal,
            performance.now() + 1_000,
        );
        const paid = vi.fn(async () => undefined);
        await expect(run(paid, new AbortController().signal, performance.now() - 1))
            .rejects.toThrow('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
        expect(paid).not.toHaveBeenCalled();
        release();
        await first;
    });
});

describe('v2.11 replay provider-attempt fence', () => {
    it('caps parallel private chunk attempts at eight and releases after a provider failure', async () => {
        const run = createReplayProviderAttemptSemaphore(8);
        let active = 0;
        let maximum = 0;
        const attempts = Array.from({ length: 9 }, (_, index) => run(async () => {
            active++;
            maximum = Math.max(maximum, active);
            await new Promise(resolve => setTimeout(resolve, 5));
            active--;
            if (index === 0) throw new Error('provider failed');
        }));
        const settled = await Promise.allSettled(attempts);
        expect(settled.filter(item => item.status === 'rejected')).toHaveLength(1);
        await run(async () => undefined);
        expect(maximum).toBe(8);
    });
});
