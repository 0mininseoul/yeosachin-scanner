import {
    calculateWeightedProgress,
    PROGRESS_TRACK_WEIGHTS_BP,
    type AnalysisProgressStatus,
    type ProgressTrackId,
} from '@/lib/domain/analysis/progress-policy';
import type { ProgressCallPhase } from '@/lib/contracts/analysis-v2';

/** Keep the provisional motion visibly below the next durable checkpoint. */
export const PROGRESS_DISPLAY_CHECKPOINT_GUARD_BP = 1;
/** A conservative fallback when a stage has no safely-derived next unit. */
export const PROGRESS_DISPLAY_UNKNOWN_STAGE_CAP_BP = 250;
/** The display takes this long to approach a cap, then visibly decelerates. */
export const PROGRESS_DISPLAY_EASING_TIME_MS = 12_000;

export type ProgressDisplayStatus = AnalysisProgressStatus;

export interface ProgressDisplayTrack {
    state: 'pending' | 'running' | 'completed' | 'failed';
    stageCode?: string;
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
    tracks?: ProgressDisplayTracks | null;
    status: ProgressDisplayStatus;
    nowMs: number;
    visible: boolean;
    /** The track that owns the current stage, not merely any running track. */
    activeTrackId?: ProgressTrackId | null;
    /** The concrete projector stage code for the active track. */
    activeStageCode?: string | null;
    /** Current item signals are presentation hints below the next checkpoint. */
    currentOrdinal?: number | null;
    totalCount?: number | null;
    callPhase?: ProgressCallPhase | null;
    /** Changes when a new server signal or stage arrives. */
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
    provisionalTargetProgressBp: number;
    easingRate: number;
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
        provisionalTargetProgressBp: 0,
        easingRate: 1,
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
    activeTrackId?: ProgressTrackId | null,
): number | undefined {
    if (!tracks) return undefined;
    const activeTrack = activeTrackId ? tracks[activeTrackId] : undefined;
    const trackIds = activeTrack?.state === 'running'
        ? [activeTrackId]
        : ['relationshipAi', 'interactions', 'finalization'] as const;
    const candidates: number[] = [];
    for (const trackId of trackIds) {
        if (!trackId) continue;
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

const GENERIC_RUNNING_STAGE_CODES = new Set([
    'RELATIONSHIP_AI_RUNNING',
    'INTERACTIONS_RUNNING',
    'FINALIZATION_RUNNING',
]);

/** Selects the projector's concrete active stage over historical running rails. */
export function activeProgressTrackId(
    tracks: ProgressDisplayTracks | null | undefined,
): ProgressTrackId | undefined {
    if (!tracks) return undefined;
    const concrete = (['relationshipAi', 'interactions', 'finalization'] as const)
        .find(trackId => (
            tracks[trackId].state === 'running'
            && !GENERIC_RUNNING_STAGE_CODES.has(tracks[trackId].stageCode ?? '')
        ));
    if (concrete) return concrete;
    return (['finalization', 'interactions', 'relationshipAi'] as const)
        .find(trackId => tracks[trackId].state === 'running');
}

const PHASE_PROGRESS_FRACTIONS: Readonly<Record<ProgressCallPhase, number>> = {
    fetching: 0.2,
    analyzing: 0.55,
    persisting: 0.85,
};

function boundedFraction(value: number, fallback = 0.5): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(0, Math.min(0.995, value));
}

function stageProgressFraction(
    stageCode: string | null | undefined,
    currentOrdinal: number | null | undefined,
    totalCount: number | null | undefined,
    callPhase: ProgressCallPhase | null | undefined,
): number {
    const phaseFraction = callPhase ? PHASE_PROGRESS_FRACTIONS[callPhase] : undefined;
    const hasProfileSignals = Number.isSafeInteger(currentOrdinal)
        && Number.isSafeInteger(totalCount)
        && (totalCount ?? 0) > 0
        && (currentOrdinal ?? 0) >= 1
        && (currentOrdinal ?? 0) <= (totalCount ?? 0);
    if (hasProfileSignals && (
        stageCode === 'PUBLIC_PROFILES_COLLECTING'
        || stageCode === 'PROFILE_SCREENING'
    )) {
        const ordinal = currentOrdinal as number;
        const total = totalCount as number;
        const phase = phaseFraction ?? 0.5;
        return boundedFraction((ordinal - 1 + phase) / total);
    }
    return boundedFraction(phaseFraction ?? 0.5);
}

function weightedProgressWithActiveFraction(
    tracks: ProgressDisplayTracks,
    activeTrackId: ProgressTrackId,
    fraction: number,
): number {
    let weighted = 0;
    for (const trackId of ['relationshipAi', 'interactions', 'finalization'] as const) {
        const track = tracks[trackId];
        const done = trackId === activeTrackId && track.state === 'running'
            ? Math.min(track.total, track.done + fraction)
            : track.done;
        weighted += PROGRESS_TRACK_WEIGHTS_BP[trackId]
            * (track.total === 0 ? 0 : done / track.total);
    }
    return Math.min(9_999, Math.max(0, Math.floor(weighted)));
}

/**
 * Returns a bounded, signal-derived floor. It is always inside the current
 * active work unit and therefore cannot cross the next durable checkpoint.
 */
export function provisionalProgressTargetBp(
    tracks: ProgressDisplayTracks | null | undefined,
    activeTrackId: ProgressTrackId | null | undefined,
    activeStageCode: string | null | undefined,
    currentOrdinal: number | null | undefined,
    totalCount: number | null | undefined,
    callPhase: ProgressCallPhase | null | undefined,
): number | undefined {
    if (!tracks) return undefined;
    const trackId = activeTrackId ?? activeProgressTrackId(tracks);
    if (!trackId || tracks[trackId].state !== 'running') return undefined;
    return weightedProgressWithActiveFraction(
        tracks,
        trackId,
        stageProgressFraction(activeStageCode, currentOrdinal, totalCount, callPhase),
    );
}

function signalEasingRate(
    currentOrdinal: number | null | undefined,
    totalCount: number | null | undefined,
    callPhase: ProgressCallPhase | null | undefined,
): number {
    const phase = callPhase ? PHASE_PROGRESS_FRACTIONS[callPhase] : 0.5;
    const position = Number.isFinite(currentOrdinal)
        && Number.isFinite(totalCount)
        && (totalCount ?? 0) > 0
        ? Math.max(0, Math.min(1, (currentOrdinal as number) / (totalCount as number)))
        : 0;
    return 1 + phase * 0.35 + position * 0.15;
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
    easingRate = 1,
): number {
    if (capProgressBp <= startProgressBp || elapsedMs <= 0) return startProgressBp;
    const fraction = 1 - Math.exp(
        -(elapsedMs * Math.max(1, easingRate)) / PROGRESS_DISPLAY_EASING_TIME_MS
    );
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
            provisionalTargetProgressBp: 10_000,
            easingRate: 1,
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
    const provisionalTrackTarget = input.status === 'processing'
        ? provisionalProgressTargetBp(
            input.tracks,
            input.activeTrackId,
            input.activeStageCode,
            input.currentOrdinal,
            input.totalCount,
            input.callPhase,
        )
        : undefined;
    const provisionalTargetProgressBp = input.status === 'processing'
        ? Math.max(
            confirmedProgressBp,
            Math.min(capProgressBp, provisionalTrackTarget ?? confirmedProgressBp),
        )
        : confirmedProgressBp;
    const checkpointStartProgressBp = checkpointJump
        ? confirmedProgressBp
        : Math.max(previous.displayProgressBp, confirmedProgressBp);
    const signalEasingProgressRate = input.status === 'processing'
        ? signalEasingRate(input.currentOrdinal, input.totalCount, input.callPhase)
        : 1;
    const signalChanged = signalKey !== previous.lastSignalKey;
    const isInitialState = previous.displayProgressBp === 0
        && previous.targetProgressBp === 0
        && previous.capProgressBp === 0
        && previous.confirmedProgressBp === 0;
    const startProgressBp = checkpointStartProgressBp;
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
            provisionalTargetProgressBp,
            easingRate: signalEasingProgressRate,
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
            provisionalTargetProgressBp,
            easingRate: signalEasingProgressRate,
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
            provisionalTargetProgressBp,
            easingRate: signalEasingProgressRate,
            lastNowMs: nowMs,
            paused: false,
        };
    }

    const easingStartedAtMs = checkpointJump || signalChanged || isInitialState
        ? nowMs
        : previous.easingStartedAtMs;
    const easingStartProgressBp = checkpointJump
        ? confirmedProgressBp
        : signalChanged || isInitialState
        ? startProgressBp
        : previous.easingStartProgressBp;
    const elapsedMs = Math.max(0, nowMs - easingStartedAtMs);
    const displayProgressBp = Math.max(
        startProgressBp,
        easedProgress(
            easingStartProgressBp,
            targetProgressBp,
            elapsedMs,
            signalEasingProgressRate,
        ),
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
        provisionalTargetProgressBp,
        easingRate: signalEasingProgressRate,
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
