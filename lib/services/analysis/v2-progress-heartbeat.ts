import type { AnalysisV2ProgressReporter } from './v2-progress-reporter';

const MIN_WRITE_INTERVAL_MS = 1_000;
type HeartbeatInput = Parameters<NonNullable<AnalysisV2ProgressReporter['heartbeat']>>[0];
type ProfileSignal = Pick<HeartbeatInput, 'username' | 'preview'> &
    Required<Pick<HeartbeatInput, 'currentOrdinal' | 'callPhase'>>;
type TimedSignal = ProfileSignal & { startedAt: string };

function sameSignal(left: ProfileSignal, right: ProfileSignal): boolean {
    const leftFeed = left.preview?.feedImageUrls ?? [];
    const rightFeed = right.preview?.feedImageUrls ?? [];
    return left.username === right.username
        && left.currentOrdinal === right.currentOrdinal
        && left.callPhase === right.callPhase
        && left.preview?.profilePicUrl === right.preview?.profilePicUrl
        && leftFeed.length === rightFeed.length
        && leftFeed.every((url, index) => url === rightFeed[index]);
}

/** This is the current display signal for a job claim. The candidate history is stored separately. */
export function createAnalysisV2ProgressHeartbeat(
    persist: (signal: TimedSignal) => Promise<boolean | undefined>,
) {
    let latest: TimedSignal | undefined;
    let pending: TimedSignal | undefined;
    let failedToWriteLatest = false;
    let inFlight: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let nextWriteAt = -Infinity;
    let startedAtMs = 0;
    let closed = false;
    let failure: { error: unknown } | undefined;

    function checkFailure(): void {
        if (failure) throw failure.error;
    }

    function schedule(): void {
        if (closed || failure || inFlight || timer !== undefined || !pending) return;
        const delay = nextWriteAt - performance.now();
        if (delay > 0) {
            timer = setTimeout(() => {
                timer = undefined;
                schedule();
            }, Math.ceil(delay));
            return;
        }

        const signal = pending;
        pending = undefined;
        nextWriteAt = performance.now() + MIN_WRITE_INTERVAL_MS;
        inFlight = Promise.resolve().then(() => persist(signal)).then(
            written => {
                if (latest === signal) failedToWriteLatest = written !== true;
            },
            error => { failure = { error }; },
        ).finally(() => {
            inFlight = undefined;
            schedule();
        });
    }

    function close(): void {
        closed = true;
        if (timer !== undefined) clearTimeout(timer);
    }

    return {
        async report(signal: ProfileSignal): Promise<void> {
            if (closed) return;
            checkFailure();
            if (latest && (
                signal.currentOrdinal < latest.currentOrdinal
                || (!failedToWriteLatest && sameSignal(signal, latest))
            )) return;

            startedAtMs = Math.max(Date.now(), startedAtMs + 1);
            latest = { ...signal, startedAt: new Date(startedAtMs).toISOString() };
            pending = latest;
            failedToWriteLatest = false;
            schedule();

            // The first signal and any immediately runnable write still check the fence
            // before the executor continues. Coalesced signals are checked on flush.
            if (!pending) {
                await inFlight;
                checkFailure();
            }
        },

        async flush(): Promise<void> {
            close();
            await inFlight;
            checkFailure();
            if (pending) {
                const signal = pending;
                pending = undefined;
                await persist(signal);
            }
        },

        discard(): void {
            close();
            pending = undefined;
        },
    };
}
