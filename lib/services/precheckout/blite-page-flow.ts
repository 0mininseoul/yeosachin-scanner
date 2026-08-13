/**
 * The page-level B-lite flow is deliberately framework-free. The caller owns the clock and
 * feeds the reducer absolute epoch timestamps; this module never polls, schedules, or performs
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
export const BLITE_FALLBACK_LATCH_MS = 48_000;

export type BlitePageState = Readonly<{
    view: BliteView;
    pathLatch: PathLatch;
    /** Original accepted submission timestamp, in the same absolute epoch clock as events. */
    submittedAtMs: number | null;
    demoStartedAtMs: number | null;
    /** Explicitly distinguishes a finished normal demo from one still rendering. */
    demoStatus: DemoStatus;
}>;

type TimedBlitePageEvent = Readonly<{
    type: 'BLITE_COMPLETE' | 'BLITE_FAILED' | 'FALLBACK_AT_48' | 'SUCCESS_CTA';
    /** Absolute epoch timestamp from the same clock as submittedAtMs. */
    atMs: number;
}>;

export type BlitePageEvent =
    | TimedBlitePageEvent
    | Readonly<{ type: 'DEMO_COMPLETE' }>
    | Readonly<{ type: 'DEMO_ERROR' }>;

export const initialBlitePageState: BlitePageState = Object.freeze({
    view: 'legacy',
    pathLatch: null,
    submittedAtMs: null,
    demoStartedAtMs: null,
    demoStatus: 'idle',
});

/**
 * Starts a page flow from the accepted submission clock. Keeping this constructor next to the
 * reducer prevents a UI remount or polling response from inventing a newer fallback deadline.
 */
export function beginBlitePage(submittedAtMs: number): BlitePageState | null {
    if (!Number.isFinite(submittedAtMs) || submittedAtMs < 0) return null;
    return {
        view: 'blite_pending',
        pathLatch: null,
        submittedAtMs,
        demoStartedAtMs: null,
        demoStatus: 'idle',
    };
}

function transitionTimestamp(event: TimedBlitePageEvent): number | null {
    return Number.isFinite(event.atMs) && event.atMs >= 0 ? event.atMs : null;
}

function submissionCutoff(state: BlitePageState): number | null {
    if (!Number.isFinite(state.submittedAtMs) || state.submittedAtMs === null || state.submittedAtMs < 0) {
        return null;
    }
    const cutoffMs = state.submittedAtMs + BLITE_FALLBACK_LATCH_MS;
    return Number.isFinite(cutoffMs) ? cutoffMs : null;
}

function isAtOrAfterSubmission(state: BlitePageState, atMs: number): boolean {
    return state.submittedAtMs !== null && atMs >= state.submittedAtMs;
}

function fallbackDemo(
    state: BlitePageState,
    startedAtMs: number,
): BlitePageState {
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
            {
                const atMs = transitionTimestamp(event);
                const cutoffMs = submissionCutoff(state);
                if (atMs === null || cutoffMs === null || !isAtOrAfterSubmission(state, atMs)) return state;
                if (atMs >= cutoffMs) return fallbackDemo(state, cutoffMs);
            }
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
            {
                const atMs = transitionTimestamp(event);
                const cutoffMs = submissionCutoff(state);
                if (atMs === null || cutoffMs === null || !isAtOrAfterSubmission(state, atMs)) return state;
                return fallbackDemo(state, Math.min(atMs, cutoffMs));
            }

        case 'FALLBACK_AT_48':
            if (state.view !== 'blite_pending' || state.pathLatch !== null) return state;
            {
                const atMs = transitionTimestamp(event);
                const cutoffMs = submissionCutoff(state);
                if (atMs === null || cutoffMs === null || !isAtOrAfterSubmission(state, atMs) || atMs < cutoffMs) return state;
                return fallbackDemo(state, cutoffMs);
            }

        case 'SUCCESS_CTA':
            if (state.view !== 'blite_ready' || state.pathLatch !== 'normal') return state;
            const startedAtMs = transitionTimestamp(event);
            if (startedAtMs === null || !isAtOrAfterSubmission(state, startedAtMs)) return state;
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
                // The normal path remains the winner. The legacy view is an explicit atomic
                // post-demo surface for the account card + plans; keep the start timestamp for
                // deadline and telemetry consumers.
                return {
                    ...state,
                    view: 'legacy',
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
