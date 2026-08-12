/**
 * Deterministic candidate-count range for the precheckout B-lite teaser.
 *
 * The real candidate count only exists after the paid pipeline collects followers/following,
 * extracts mutual follows, and runs the AI gender step. The teaser must never do (or imply) that
 * work, so this module derives a deliberately broad, non-committal range from `followersCount`
 * and `followingCount` alone, in plain TypeScript. The model never sees or produces this value,
 * and this module never renders a single "N명" figure — only a `{ min, max }` band.
 */

export interface PrecheckoutBliteCandidateRangeInput {
    readonly followersCount: number;
    readonly followingCount: number;
}

export interface PrecheckoutBliteCandidateRangeResult {
    readonly min: number;
    readonly max: number;
}

/** Fraction of the smaller follow count treated as a plausible "close circle" midpoint. */
const CIRCLE_RATIO = 0.12;
/** Spread applied below/above the midpoint; kept inside the ~35–45% band by design. */
const RANGE_LOW_SPREAD = 0.4;
const RANGE_HIGH_SPREAD = 0.4;
const MIN_MIDPOINT_FLOOR = 1;
/** Sane ceiling so very large accounts still get a bounded, non-alarming range. */
const ABSOLUTE_MAX_CANDIDATES = 400;

function assertNonNegativeInteger(value: number, label: string): void {
    if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
        throw new Error(`PRECHECKOUT_BLITE_RANGE_ERROR: ${label} must be a non-negative integer.`);
    }
}

/**
 * Pure, deterministic candidate-count range. Same inputs always produce the same output.
 */
export function computePrecheckoutBliteCandidateRange(
    followersCount: number,
    followingCount: number,
): PrecheckoutBliteCandidateRangeResult {
    assertNonNegativeInteger(followersCount, 'followersCount');
    assertNonNegativeInteger(followingCount, 'followingCount');

    // A reciprocal "close circle" cannot exceed the smaller of the two counts; an account that
    // follows no one can never produce a candidate.
    const circleCeiling = Math.min(followersCount, followingCount);
    const cappedCeiling = Math.min(circleCeiling, ABSOLUTE_MAX_CANDIDATES);
    const midpoint = circleCeiling === 0
        ? 0
        : Math.min(
            Math.max(Math.round(circleCeiling * CIRCLE_RATIO), MIN_MIDPOINT_FLOOR),
            cappedCeiling
        );

    const rawMin = Math.floor(midpoint * (1 - RANGE_LOW_SPREAD));
    const rawMax = Math.ceil(midpoint * (1 + RANGE_HIGH_SPREAD));

    const min = Math.max(0, Math.min(rawMin, cappedCeiling));
    const maxFloor = Math.max(min + 1, 1);
    const max = Math.min(Math.max(rawMax, maxFloor), Math.max(cappedCeiling, maxFloor));

    return Object.freeze({ min, max });
}
