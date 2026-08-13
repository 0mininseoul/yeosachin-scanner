/**
 * The page-level B-lite flow is deliberately framework-free. The caller owns the clock and
 * feeds the reducer server-relative events; this module never polls, schedules, or performs
 * provider work.
 */

export type BliteView =
    | 'legacy'
    | 'preflight_failed'
    | 'blite_pending'
    | 'blite_ready'
    | 'success_demo'
    | 'fallback_demo'
    | 'fallback_legacy';

export type PathLatch = null | 'normal' | 'fallback';
export type DemoStatus = 'idle' | 'running' | 'complete' | 'error';

export type BlitePageState = Readonly<{
    view: BliteView;
    pathLatch: PathLatch;
    demoStartedAtMs: number | null;
    /** Explicitly distinguishes a finished normal demo from one still rendering. */
    demoStatus: DemoStatus;
}>;

type TimedBlitePageEvent = Readonly<{
    type: 'BLITE_FAILED' | 'FALLBACK_AT_48' | 'SUCCESS_CTA';
    /** Submission-relative or monotonic timestamp supplied by the page owner. */
    atMs: number;
}>;

export type BlitePageEvent =
    | Readonly<{ type: 'BLITE_COMPLETE' }>
    | TimedBlitePageEvent
    | Readonly<{ type: 'DEMO_COMPLETE' }>
    | Readonly<{ type: 'DEMO_ERROR' }>;

export const initialBlitePageState: BlitePageState = Object.freeze({
    view: 'legacy',
    pathLatch: null,
    demoStartedAtMs: null,
    demoStatus: 'idle',
});

function transitionTimestamp(event: TimedBlitePageEvent): number | null {
    return Number.isFinite(event.atMs) && event.atMs >= 0 ? event.atMs : null;
}

function fallbackDemo(state: BlitePageState, event: TimedBlitePageEvent): BlitePageState {
    const startedAtMs = transitionTimestamp(event);
    if (startedAtMs === null) return state;
    return {
        ...state,
        view: 'fallback_demo',
        pathLatch: 'fallback',
        demoStartedAtMs: startedAtMs,
        demoStatus: 'running',
    };
}

/**
 * Apply one page event without ever switching an already latched path. Returning the existing
 * object for ignored events also makes duplicate polls, remount effects, and late results
 * observably idempotent to a React caller.
 */
export function reduceBlitePage(
    state: BlitePageState,
    event: BlitePageEvent,
): BlitePageState {
    switch (event.type) {
        case 'BLITE_COMPLETE':
            if (state.view !== 'blite_pending' || state.pathLatch !== null) return state;
            return {
                ...state,
                view: 'blite_ready',
                pathLatch: 'normal',
                demoStartedAtMs: null,
                demoStatus: 'idle',
            };

        case 'BLITE_FAILED':
            // A business/preflight failure is intentionally not an eligible fallback path. Once
            // normal has won, a later inference failure cannot revoke the ready result either.
            if (state.view !== 'blite_pending' || state.pathLatch !== null) return state;
            return fallbackDemo(state, event);

        case 'FALLBACK_AT_48':
            if (state.view !== 'blite_pending' || state.pathLatch !== null) return state;
            return fallbackDemo(state, event);

        case 'SUCCESS_CTA':
            if (state.view !== 'blite_ready' || state.pathLatch !== 'normal') return state;
            const startedAtMs = transitionTimestamp(event);
            if (startedAtMs === null) return state;
            return {
                ...state,
                view: 'success_demo',
                demoStartedAtMs: startedAtMs,
                demoStatus: 'running',
            };

        case 'DEMO_COMPLETE':
            if (state.demoStatus !== 'running') return state;
            if (state.view === 'fallback_demo' && state.pathLatch === 'fallback') {
                return {
                    ...state,
                    view: 'fallback_legacy',
                    demoStatus: 'complete',
                };
            }
            if (state.view === 'success_demo' && state.pathLatch === 'normal') {
                // The normal path remains the winner. Keep its start timestamp for deadline and
                // telemetry consumers while the explicit status distinguishes completion.
                return {
                    ...state,
                    demoStatus: 'complete',
                };
            }
            return state;

        case 'DEMO_ERROR':
            if (state.demoStatus !== 'running') return state;
            if (state.view !== 'fallback_demo' && state.view !== 'success_demo') return state;
            // Fail-open is safe for either demo: preserve the winning latch and reveal the
            // legacy surface. In particular, fallback never waits for another timer after error.
            return {
                ...state,
                view: 'fallback_legacy',
                demoStatus: 'error',
            };
    }
}
