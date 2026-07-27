/**
 * Public duration estimates are deliberately coarse.  They are planning ranges,
 * not countdowns: neither raw collection counts nor a candidate-screening scope
 * may leave the server through this module.
 */
export const ANALYSIS_DURATION_ESTIMATE_VERSION = 'v1' as const;

export type AnalysisDurationBand = 'small' | 'typical' | 'large' | 'largest';

export interface AnalysisDurationRange {
    readonly lowMinutes: 4 | 5 | 8 | 10;
    readonly highMinutes: 6 | 8 | 12 | 15;
}

export interface AnalysisDurationEstimate {
    readonly version: typeof ANALYSIS_DURATION_ESTIMATE_VERSION;
    readonly band: AnalysisDurationBand;
    readonly range: AnalysisDurationRange;
}

export interface PreflightDurationEstimateInput {
    readonly followersCount: number;
    readonly followingCount: number;
    readonly planCapacity: Readonly<{ followers: number; following: number }>;
}

/** Internal-only persisted workload summary. Do not serialize this shape to a client. */
export interface PersistedAnalysisWorkload {
    readonly mutualCount: number;
    readonly publicCount: number;
    readonly privateCount: number;
    readonly profileBatchCount: number;
    readonly privateNameBatchCount: number;
    readonly completedStageOperations: number;
}

const BANDS: Readonly<Record<AnalysisDurationBand, AnalysisDurationRange>> = Object.freeze({
    small: Object.freeze({ lowMinutes: 4, highMinutes: 6 }),
    typical: Object.freeze({ lowMinutes: 5, highMinutes: 8 }),
    large: Object.freeze({ lowMinutes: 8, highMinutes: 12 }),
    largest: Object.freeze({ lowMinutes: 10, highMinutes: 15 }),
});

function nonNegativeInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer.`);
    }
    return value;
}

function bandForProxy(proxy: number): AnalysisDurationBand {
    // The typical band is intentionally based on the smaller, capped relationship side.
    // A 474/644 account therefore remains 5–8 minutes: mutual-work discovery cannot
    // exceed its smaller side. This is conservative around the ~600-account boundary.
    if (proxy <= 200) return 'small';
    if (proxy <= 600) return 'typical';
    if (proxy <= 900) return 'large';
    return 'largest';
}

function estimate(band: AnalysisDurationBand): AnalysisDurationEstimate {
    return Object.freeze({
        version: ANALYSIS_DURATION_ESTIMATE_VERSION,
        band,
        range: BANDS[band],
    });
}

/** Stage 1: only the original preflight counts and the selected plan cap are considered. */
export function estimatePreflightAnalysisDuration(
    input: PreflightDurationEstimateInput
): AnalysisDurationEstimate {
    const followers = Math.min(
        nonNegativeInteger(input.followersCount, 'followersCount'),
        nonNegativeInteger(input.planCapacity.followers, 'planCapacity.followers'),
    );
    const following = Math.min(
        nonNegativeInteger(input.followingCount, 'followingCount'),
        nonNegativeInteger(input.planCapacity.following, 'planCapacity.following'),
    );
    return estimate(bandForProxy(Math.min(followers, following)));
}

/**
 * Stage 2: recalculates the same public bands from server-persisted DAG workload.
 * The input must stay server-only; only the returned range is safe to hydrate.
 */
export function estimatePersistedAnalysisDuration(
    input: PersistedAnalysisWorkload
): AnalysisDurationEstimate {
    const mutual = nonNegativeInteger(input.mutualCount, 'mutualCount');
    const publicCount = nonNegativeInteger(input.publicCount, 'publicCount');
    const privateCount = nonNegativeInteger(input.privateCount, 'privateCount');
    const profileBatches = nonNegativeInteger(input.profileBatchCount, 'profileBatchCount');
    const privateBatches = nonNegativeInteger(input.privateNameBatchCount, 'privateNameBatchCount');
    const stageOperations = nonNegativeInteger(
        input.completedStageOperations,
        'completedStageOperations',
    );

    // Batch and completed-stage terms cover orchestration work that raw account totals
    // do not represent. The maximum keeps the result conservative without surfacing it.
    const proxy = Math.max(
        mutual,
        publicCount,
        privateCount,
        profileBatches * 100,
        privateBatches * 100,
        stageOperations * 75,
    );
    return estimate(bandForProxy(proxy));
}

export function hasAnalysisDurationExceeded(
    startedAtMs: number | null | undefined,
    estimateValue: AnalysisDurationEstimate | null | undefined,
    nowMs: number,
): boolean {
    if (!estimateValue || !Number.isFinite(startedAtMs) || !Number.isFinite(nowMs)) return false;
    return nowMs - startedAtMs! > estimateValue.range.highMinutes * 60_000;
}

export function analysisDurationRangeLabel(range: AnalysisDurationRange): string {
    return `${range.lowMinutes}~${range.highMinutes}분`;
}
