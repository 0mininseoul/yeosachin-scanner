/**
 * The page-level B-lite flow is deliberately framework-free. The caller owns the clock and
 * feeds the reducer absolute epoch timestamps; this module never polls, schedules, or performs
 * provider work.
 */

import { BLITE_FALLBACK_LATCH_MS } from './blite-deadline';

export type BliteView =
    | 'legacy'
    | 'preflight_failed'
    | 'blite_pending'
    | 'blite_ready'
    | 'success_demo'
    | 'fallback_demo'
    | 'demo_reveal'
    | 'fallback_legacy';

export type PathLatch = null | 'normal' | 'fallback';
export type DemoStatus = 'idle' | 'running' | 'complete' | 'error';
export type PrecheckoutSurface = 'awaiting' | 'preview' | 'legacy';
export type PrecheckoutSurfaceState = Readonly<{
    preflightId: string | null;
    surface: PrecheckoutSurface;
}>;
export { BLITE_FALLBACK_LATCH_MS } from './blite-deadline';

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
    /** Optional server-derived fallback cutoff, preserving legacy per-row clocks. */
    fallbackAtMs?: number;
}>;

export type BlitePageEvent =
    | TimedBlitePageEvent
    | Readonly<{ type: 'PLAN_CTA' }>
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
 * A B-lite status callback may reveal a verified preview, but its unavailable branch must not
 * release the parent page's plans surface. The immersive state machine owns that release after
 * the demo's explicit CTA.
 */
export function resolvePrecheckoutAvailabilitySurface(
    current: PrecheckoutSurface,
    available: boolean,
): PrecheckoutSurface {
    return available ? 'preview' : current;
}

/** A surface created for an earlier preflight must never bleed into the next cohort render. */
export function resolveActivePrecheckoutSurface(
    state: PrecheckoutSurfaceState,
    activePreflightId: string | null | undefined,
): PrecheckoutSurface {
    return activePreflightId && state.preflightId === activePreflightId
        ? state.surface
        : 'awaiting';
}

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

function eventCutoff(state: BlitePageState, event: TimedBlitePageEvent): number | null {
    if (
        typeof event.fallbackAtMs === 'number'
        && Number.isFinite(event.fallbackAtMs)
        && event.fallbackAtMs >= (state.submittedAtMs ?? 0)
    ) return event.fallbackAtMs;
    return submissionCutoff(state);
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
                const cutoffMs = eventCutoff(state, event);
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
                const cutoffMs = eventCutoff(state, event);
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
            if (
                (state.view === 'fallback_demo' && state.pathLatch === 'fallback')
                || (state.view === 'success_demo' && state.pathLatch === 'normal')
            ) {
                return {
                    ...state,
                    view: 'demo_reveal',
                    demoStatus: 'complete',
                };
            }
            return state;

        case 'PLAN_CTA':
            if (
                state.view !== 'demo_reveal'
                || (state.demoStatus !== 'complete' && state.demoStatus !== 'error')
            ) return state;
            if (state.pathLatch === 'fallback') {
                return { ...state, view: 'fallback_legacy' };
            }
            if (state.pathLatch === 'normal') {
                return { ...state, view: 'legacy' };
            }
            return state;

        case 'DEMO_ERROR':
            if (state.demoStatus !== 'running') return state;
            if (state.view !== 'fallback_demo' && state.view !== 'success_demo') return state;
            // Keep the gate closed even if a demo runtime failure interrupts the animation.
            // The explicit CTA is the only transition that can reveal legacy plans.
            return {
                ...state,
                view: 'demo_reveal',
                demoStatus: 'error',
            };
    }
}
