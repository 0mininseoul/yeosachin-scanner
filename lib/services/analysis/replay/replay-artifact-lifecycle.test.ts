import { describe, expect, it, vi } from 'vitest';
import { installReplayArtifactSignalCleanup } from './replay-artifact-lifecycle';

describe('replay artifact signal lifecycle', () => {
    it.each([
        ['SIGINT', 130],
        ['SIGTERM', 143],
    ] as const)('cleans the exact owned pair before exiting on %s', async (signal, code) => {
        const handlers = new Map<string, () => void>();
        const cleanup = vi.fn(async () => undefined);
        const exit = vi.fn();
        const processLike = {
            once: vi.fn((name: string, handler: () => void) => {
                handlers.set(name, handler);
                return processLike;
            }),
            off: vi.fn((name: string) => {
                handlers.delete(name);
                return processLike;
            }),
            exit,
        };
        const uninstall = installReplayArtifactSignalCleanup({
            cleanup,
            processLike,
        });

        handlers.get(signal)?.();
        await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(code));
        expect(cleanup).toHaveBeenCalledOnce();
        expect(processLike.off).toHaveBeenCalledWith('SIGINT', expect.any(Function));
        expect(processLike.off).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
        uninstall();
    });
});
