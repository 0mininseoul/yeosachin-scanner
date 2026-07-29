type ReplaySignal = 'SIGINT' | 'SIGTERM';

export interface ReplaySignalProcess {
    on(signal: ReplaySignal, handler: () => void): unknown;
    off(signal: ReplaySignal, handler: () => void): unknown;
    exit(code: number): unknown;
}

/**
 * Installs bounded cleanup for the one exact artifact pair owned by the caller.
 * The cleanup callback must never perform recursive or directory deletion.
 */
export function installReplayArtifactSignalCleanup(input: {
    cleanup: () => Promise<void>;
    processLike?: ReplaySignalProcess;
}): () => void {
    const processLike = input.processLike ?? process;
    let handling = false;
    const handlers = new Map<ReplaySignal, () => void>();
    const uninstall = () => {
        for (const [signal, handler] of handlers) {
            processLike.off(signal, handler);
        }
        handlers.clear();
    };
    for (const [signal, exitCode] of [
        ['SIGINT', 130],
        ['SIGTERM', 143],
    ] as const) {
        const handler = () => {
            if (handling) return;
            handling = true;
            void input.cleanup()
                .catch(() => undefined)
                .finally(() => {
                    uninstall();
                    processLike.exit(exitCode);
                });
        };
        handlers.set(signal, handler);
        processLike.on(signal, handler);
    }
    return uninstall;
}
