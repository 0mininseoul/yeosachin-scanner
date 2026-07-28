import { describe, expect, it, vi } from 'vitest';
import { createReplayAbortableBoundedSemaphore } from './replay-staged-ai-adapter';

describe('v2.11 replay resolver admission', () => {
    it('removes an aborted waiter before it can start a paid task', async () => {
        const run = createReplayAbortableBoundedSemaphore(1);
        let release!: () => void;
        const first = run(() => new Promise<void>(resolve => { release = resolve; }), new AbortController().signal, 100);
        const controller = new AbortController();
        const paid = vi.fn(async () => undefined);
        const queued = run(paid, controller.signal, 100);
        controller.abort();
        await expect(queued).rejects.toThrow('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
        release();
        await first;
        await run(paid, new AbortController().signal, 100);
        expect(paid).toHaveBeenCalledOnce();
    });
});
