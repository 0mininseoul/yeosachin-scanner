export const PROGRESS_BASIS_POINTS_MAX = 10_000;
export const PROGRESS_TRACK_IDS = [
    'relationshipAi',
    'interactions',
    'finalization',
] as const;

export type ProgressTrackId = (typeof PROGRESS_TRACK_IDS)[number];
export type AnalysisProgressStatus =
    | 'queued'
    | 'processing'
    | 'completed'
    | 'failed'
    | 'upgrade_required';

export interface ProgressTrackWork {
    done: number;
    total: number;
}

export type ProgressTrackWorkMap = Readonly<Record<ProgressTrackId, ProgressTrackWork>>;
export type ProgressTrackWeightMap = Readonly<Record<ProgressTrackId, number>>;
export type ProgressTrackBasisPointMap = Readonly<Record<ProgressTrackId, number>>;

export const PROGRESS_TRACK_WEIGHTS_BP = Object.freeze({
    relationshipAi: 7_200,
    interactions: 1_700,
    finalization: 1_100,
} satisfies ProgressTrackWeightMap);

export interface CalculatedProgress {
    trackProgressBp: ProgressTrackBasisPointMap;
    overallProgressBp: number;
}

export interface PersistedProgress {
    revision: number;
    overallProgressBp: number;
    status: AnalysisProgressStatus;
    lastEventSeq: number;
    snapshotFingerprint: string;
}

export interface ProgressTransition extends PersistedProgress {
    calculatedProgressBp: number;
    trackProgressBp: ProgressTrackBasisPointMap;
    advanced: boolean;
    progressAdvanced: boolean;
}

const SNAPSHOT_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

function assertSafeIntegerInRange(
    value: number,
    field: string,
    minimum: number,
    maximum: number
): void {
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
        throw new RangeError(
            `${field} must be a safe integer between ${minimum} and ${maximum}.`
        );
    }
}

function validateTrackWork(
    trackId: ProgressTrackId,
    work: ProgressTrackWork | undefined
): ProgressTrackWork {
    if (!work || typeof work !== 'object') {
        throw new TypeError(`${trackId} progress work is required.`);
    }
    assertSafeIntegerInRange(work.done, `${trackId}.done`, 0, Number.MAX_SAFE_INTEGER);
    assertSafeIntegerInRange(work.total, `${trackId}.total`, 0, Number.MAX_SAFE_INTEGER);
    if (work.done > work.total) {
        throw new RangeError(`${trackId}.done cannot exceed ${trackId}.total.`);
    }
    return work;
}

function validateWeights(weights: ProgressTrackWeightMap): void {
    let totalWeight = 0;
    for (const trackId of PROGRESS_TRACK_IDS) {
        const weight = weights[trackId];
        assertSafeIntegerInRange(
            weight,
            `${trackId} weight`,
            0,
            PROGRESS_BASIS_POINTS_MAX
        );
        totalWeight += weight;
    }
    if (totalWeight !== PROGRESS_BASIS_POINTS_MAX) {
        throw new RangeError(
            `Progress track weights must total ${PROGRESS_BASIS_POINTS_MAX} basis points.`
        );
    }
}

function validateStatus(status: AnalysisProgressStatus): void {
    if (![
        'queued',
        'processing',
        'completed',
        'failed',
        'upgrade_required',
    ].includes(status)) {
        throw new TypeError('Analysis progress status is invalid.');
    }
}

function validateSnapshotFingerprint(value: string): void {
    if (!SNAPSHOT_FINGERPRINT_PATTERN.test(value)) {
        throw new TypeError('Snapshot fingerprint must be a lowercase SHA-256 hex digest.');
    }
}

function validateStatusTransition(
    previous: AnalysisProgressStatus,
    current: AnalysisProgressStatus
): void {
    if ((previous === 'completed' || previous === 'failed') && current !== previous) {
        throw new Error('PROGRESS_TRANSITION_ERROR: terminal status cannot change.');
    }
}

export function nextProgressEventSequence(previousLastEventSeq: number): number {
    assertSafeIntegerInRange(
        previousLastEventSeq,
        'previous last event sequence',
        0,
        Number.MAX_SAFE_INTEGER
    );
    if (previousLastEventSeq === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Progress event sequence cannot be incremented safely.');
    }
    return previousLastEventSeq + 1;
}

export function assertNextProgressEventSequence(
    previousLastEventSeq: number,
    nextSequence: number
): void {
    assertSafeIntegerInRange(
        nextSequence,
        'next progress event sequence',
        1,
        Number.MAX_SAFE_INTEGER
    );
    if (nextProgressEventSequence(previousLastEventSeq) !== nextSequence) {
        throw new Error('PROGRESS_SEQUENCE_ERROR: event sequence must be contiguous.');
    }
}

function trackBasisPoints(work: ProgressTrackWork): number {
    if (work.total === 0) return 0;
    // Match the database's exact floor even when the ratio would round down in floating point.
    return Number(BigInt(work.done) * BigInt(PROGRESS_BASIS_POINTS_MAX) / BigInt(work.total));
}

export function calculateTrackProgressBp(work: ProgressTrackWork): number {
    return trackBasisPoints(validateTrackWork('relationshipAi', work));
}

export function calculateWeightedProgress(
    tracks: ProgressTrackWorkMap,
    status: AnalysisProgressStatus,
    weights: ProgressTrackWeightMap = PROGRESS_TRACK_WEIGHTS_BP
): CalculatedProgress {
    validateStatus(status);
    validateWeights(weights);

    const trackProgressBp = {} as Record<ProgressTrackId, number>;
    let weightedProgress = 0;

    for (const trackId of PROGRESS_TRACK_IDS) {
        const work = validateTrackWork(trackId, tracks[trackId]);
        trackProgressBp[trackId] = trackBasisPoints(work);
        weightedProgress += weights[trackId] * (work.total === 0 ? 0 : work.done / work.total);
    }

    const calculated = status === 'completed'
        ? PROGRESS_BASIS_POINTS_MAX
        : Math.min(
            PROGRESS_BASIS_POINTS_MAX - 1,
            Math.floor(weightedProgress)
        );

    return Object.freeze({
        trackProgressBp: Object.freeze(trackProgressBp),
        overallProgressBp: calculated,
    });
}

export function advancePersistedProgress(input: Readonly<{
    previous: PersistedProgress;
    tracks: ProgressTrackWorkMap;
    status: AnalysisProgressStatus;
    lastEventSeq: number;
    snapshotFingerprint: string;
    weights?: ProgressTrackWeightMap;
}>): ProgressTransition {
    assertSafeIntegerInRange(
        input.previous.revision,
        'previous revision',
        0,
        Number.MAX_SAFE_INTEGER
    );
    assertSafeIntegerInRange(
        input.previous.overallProgressBp,
        'previous overall progress',
        0,
        PROGRESS_BASIS_POINTS_MAX
    );
    validateStatus(input.previous.status);
    validateStatus(input.status);
    validateStatusTransition(input.previous.status, input.status);
    assertSafeIntegerInRange(
        input.previous.lastEventSeq,
        'previous last event sequence',
        0,
        Number.MAX_SAFE_INTEGER
    );
    assertSafeIntegerInRange(
        input.lastEventSeq,
        'last event sequence',
        input.previous.lastEventSeq,
        Number.MAX_SAFE_INTEGER
    );
    validateSnapshotFingerprint(input.previous.snapshotFingerprint);
    validateSnapshotFingerprint(input.snapshotFingerprint);

    const calculated = calculateWeightedProgress(
        input.tracks,
        input.status,
        input.weights
    );
    const overallProgressBp = Math.max(
        input.previous.overallProgressBp,
        calculated.overallProgressBp
    );
    const progressAdvanced = overallProgressBp > input.previous.overallProgressBp;
    const advanced = progressAdvanced
        || input.status !== input.previous.status
        || input.lastEventSeq !== input.previous.lastEventSeq
        || input.snapshotFingerprint !== input.previous.snapshotFingerprint;

    if (advanced && input.previous.revision === Number.MAX_SAFE_INTEGER) {
        throw new RangeError('Progress revision cannot be incremented safely.');
    }

    return Object.freeze({
        revision: advanced ? input.previous.revision + 1 : input.previous.revision,
        overallProgressBp,
        status: input.status,
        lastEventSeq: input.lastEventSeq,
        snapshotFingerprint: input.snapshotFingerprint,
        calculatedProgressBp: calculated.overallProgressBp,
        trackProgressBp: calculated.trackProgressBp,
        advanced,
        progressAdvanced,
    });
}
