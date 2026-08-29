import {
    calculateWeightedProgress,
    type AnalysisProgressStatus,
    type ProgressTrackId,
} from '@/lib/domain/analysis/progress-policy';

/** Keep the provisional motion visibly below the next durable checkpoint. */
export const PROGRESS_DISPLAY_CHECKPOINT_GUARD_BP = 1;
/** A conservative fallback when a stage has no safely-derived next unit. */
export const PROGRESS_DISPLAY_UNKNOWN_STAGE_CAP_BP = 250;
/** The display takes this long to approach a cap, then visibly decelerates. */
export const PROGRESS_DISPLAY_EASING_TIME_MS = 12_000;

export type ProgressDisplayStatus = AnalysisProgressStatus;

export interface ProgressDisplayTrack {
    state: 'pending' | 'running' | 'completed' | 'failed';
    done: number;
    total: number;
}

export type ProgressDisplayTracks = Readonly<
    Record<ProgressTrackId, ProgressDisplayTrack>
>;

export interface ProgressDisplayInput {
    /** The latest server-persisted checkpoint, in basis points. */
    confirmedProgressBp: number;
    /** The next progress value that can only be shown after a durable checkpoint. */
    nextCheckpointBp?: number;
    status: ProgressDisplayStatus;
    nowMs: number;
    visible: boolean;
    /** Changes only when a new server signal or stage arrives. */
    signalKey?: string | null;
}

export interface ProgressDisplayState {
    displayProgressBp: number;
    targetProgressBp: number;
    capProgressBp: number;
    confirmedProgressBp: number;
    lastSignalKey: string | null;
    easingStartedAtMs: number;
    easingStartProgressBp: number;
    lastNowMs: number;
    paused: boolean;
}

function boundedBasisPoints(value: number, fallback = 0): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0, Math.min(10_000, Math.floor(value)));
}

function safeNow(value: number, fallback: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : fallback;
}

export function createProgressDisplayState(): ProgressDisplayState {
    return {
        displayProgressBp: 0,
        targetProgressBp: 0,
        capProgressBp: 0,
        confirmedProgressBp: 0,
        lastSignalKey: null,
        easingStartedAtMs: 0,
        easingStartProgressBp: 0,
        lastNowMs: 0,
        paused: false,
    };
}

/**
 * Finds the nearest next durable unit. A stage can have more than one running
 * track, so the lower candidate is the only safe cap: either track may publish
 * first. The calculation intentionally uses the canonical weighted-progress
 * operation order shared by the database and the persistence adapter.
 */
export function nextProgressCheckpointBp(
    tracks: ProgressDisplayTracks | null | undefined,
): number | undefined {
    if (!tracks) return undefined;
    const candidates: number[] = [];
    for (const trackId of ['relationshipAi', 'interactions', 'finalization'] as const) {
        const track = tracks[trackId];
        if (track.state !== 'running' || track.done >= track.total) continue;
        const work = {
            relationshipAi: { done: tracks.relationshipAi.done, total: tracks.relationshipAi.total },
            interactions: { done: tracks.interactions.done, total: tracks.interactions.total },
            finalization: { done: tracks.finalization.done, total: tracks.finalization.total },
        };
        work[trackId] = {
            done: Math.min(track.total, track.done + 1),
            total: track.total,
        };
        candidates.push(calculateWeightedProgress(work, 'processing').overallProgressBp);
    }
    return candidates.length > 0 ? Math.min(...candidates) : undefined;
}

function easingCap(
    confirmedProgressBp: number,
    nextCheckpointBp: number | undefined,
): number {
    if (nextCheckpointBp !== undefined && Number.isFinite(nextCheckpointBp)) {
        return Math.max(
            confirmedProgressBp,
            Math.min(
                9_999,
                Math.floor(nextCheckpointBp) - PROGRESS_DISPLAY_CHECKPOINT_GUARD_BP,
            ),
        );
    }
    return Math.min(
        9_999,
        confirmedProgressBp + PROGRESS_DISPLAY_UNKNOWN_STAGE_CAP_BP,
    );
}

function easedProgress(
    startProgressBp: number,
    capProgressBp: number,
    elapsedMs: number,
): number {
    if (capProgressBp <= startProgressBp || elapsedMs <= 0) return startProgressBp;
    const fraction = 1 - Math.exp(-elapsedMs / PROGRESS_DISPLAY_EASING_TIME_MS);
    return Math.min(
        capProgressBp,
        Math.floor(startProgressBp + (capProgressBp - startProgressBp) * fraction),
    );
}

/**
 * Advances only a presentation value. Durable checkpoints remain the source
 * of truth: a fresh checkpoint is adopted immediately, while elapsed time can
 * only ease toward the guarded cap for the current in-flight unit.
 */
export function updateProgressDisplay(
    previous: ProgressDisplayState,
    input: ProgressDisplayInput,
): ProgressDisplayState {
    const nowMs = safeNow(input.nowMs, previous.lastNowMs);
    const confirmedProgressBp = input.status === 'completed'
        ? 10_000
        : Math.min(
            9_999,
            Math.max(
                Math.min(previous.confirmedProgressBp, 9_999),
                boundedBasisPoints(input.confirmedProgressBp),
            ),
        );
    const signalKey = input.signalKey ?? null;

    if (input.status === 'completed') {
        return {
            ...previous,
            displayProgressBp: 10_000,
            targetProgressBp: 10_000,
            capProgressBp: 10_000,
            confirmedProgressBp: 10_000,
            lastSignalKey: signalKey,
            easingStartedAtMs: nowMs,
            easingStartProgressBp: 10_000,
            lastNowMs: nowMs,
            paused: false,
        };
    }

    const checkpointJump = confirmedProgressBp > previous.displayProgressBp;
    const capProgressBp = input.status === 'processing'
        ? Math.max(
            confirmedProgressBp,
            easingCap(confirmedProgressBp, input.nextCheckpointBp),
        )
        : confirmedProgressBp;
    const signalChanged = signalKey !== previous.lastSignalKey;
    const startProgressBp = checkpointJump
        ? confirmedProgressBp
        : Math.max(previous.displayProgressBp, confirmedProgressBp);
    const targetProgressBp = input.status === 'processing'
        ? capProgressBp
        : startProgressBp;

    if (input.status !== 'processing') {
        // Failure and upgrade-required are terminal, but a previously shown
        // provisional value must not visibly regress on the error screen.
        return {
            ...previous,
            displayProgressBp: startProgressBp,
            targetProgressBp,
            capProgressBp: startProgressBp,
            confirmedProgressBp,
            lastSignalKey: signalKey,
            easingStartedAtMs: nowMs,
            easingStartProgressBp: startProgressBp,
            lastNowMs: nowMs,
            paused: false,
        };
    }

    if (!input.visible) {
        return {
            ...previous,
            displayProgressBp: startProgressBp,
            targetProgressBp,
            capProgressBp,
            confirmedProgressBp,
            lastSignalKey: signalKey,
            easingStartedAtMs: nowMs,
            easingStartProgressBp: startProgressBp,
            lastNowMs: nowMs,
            paused: true,
        };
    }

    if (previous.paused) {
        return {
            ...previous,
            displayProgressBp: startProgressBp,
            targetProgressBp,
            capProgressBp,
            confirmedProgressBp,
            lastSignalKey: signalKey,
            easingStartedAtMs: nowMs,
            easingStartProgressBp: startProgressBp,
            lastNowMs: nowMs,
            paused: false,
        };
    }

    const easingStartedAtMs = checkpointJump || signalChanged
        ? nowMs
        : previous.easingStartedAtMs;
    const easingStartProgressBp = checkpointJump || signalChanged
        ? startProgressBp
        : previous.easingStartProgressBp;
    const elapsedMs = Math.max(0, nowMs - easingStartedAtMs);
    const displayProgressBp = easedProgress(
        easingStartProgressBp,
        targetProgressBp,
        elapsedMs,
    );

    return {
        ...previous,
        displayProgressBp: Math.max(previous.displayProgressBp, displayProgressBp),
        targetProgressBp,
        capProgressBp,
        confirmedProgressBp,
        lastSignalKey: signalKey,
        easingStartedAtMs,
        easingStartProgressBp,
        lastNowMs: nowMs,
        paused: false,
    };
}

/** Pauses the monotonic clock while the browser is hidden. */
export function pauseProgressDisplay(
    previous: ProgressDisplayState,
    nowMs: number,
): ProgressDisplayState {
    const safeTimestamp = safeNow(nowMs, previous.lastNowMs);
    return {
        ...previous,
        easingStartedAtMs: safeTimestamp,
        easingStartProgressBp: previous.displayProgressBp,
        lastNowMs: safeTimestamp,
        paused: true,
    };
}
