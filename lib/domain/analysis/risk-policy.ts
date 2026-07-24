export const RISK_POLICY_VERSION = 'risk-policy-v2.3' as const;

export const RISK_BANDS = ['normal', 'caution', 'high_risk'] as const;

export const RISK_COMPONENT_WEIGHTS = Object.freeze({
    candidateToTargetLikes: 20,
    candidateToTargetComments: 26,
    targetToCandidateLike: 3,
    tagOrCaptionMention: 14,
    recentMutual: 17,
    appearanceExposure: 20,
} as const);

export const APPEARANCE_GRADE_POINTS = Object.freeze({
    1: 0,
    2: 3,
    3: 7,
    4: 10,
    5: 13,
} as const);

export const RECENT_FEMALE_MUTUAL_POINTS = Object.freeze([
    17,
    16,
    15,
    14,
    13,
    12,
    10,
    8,
    6,
    4,
] as const);

export const RISK_DISPLAY_THRESHOLDS = Object.freeze({
    caution: 4.2,
    high: 6.8,
} as const);

export const FEATURED_RISK_LIMITS = Object.freeze({
    high_risk: 3,
    caution: 15,
} as const);

export const STRONG_PARTNER_PUBLIC_SCORE_CAP = 3.4;
export const WEAK_PARTNER_RAW_ADJUSTMENT = -5;
export const ACCOUNT_CONTEXTS = [
    'personal',
    'individual_creator',
    'official_group_or_brand',
    'uncertain',
] as const;
export type AccountContext = typeof ACCOUNT_CONTEXTS[number];

export const ACCOUNT_CONTEXT_SOFT_MULTIPLIERS = Object.freeze({
    personal: 1,
    individual_creator: 0.5,
    official_group_or_brand: 0,
    uncertain: 1,
} satisfies Record<AccountContext, 0 | 0.5 | 1>);
/** @deprecated Use ACCOUNT_CONTEXT_SOFT_MULTIPLIERS.individual_creator. */
export const BUSINESS_SOFT_CONTEXT_MULTIPLIER = 0.5;
export const APPEARANCE_EXPOSURE_NORMALIZER = 20 / 18;
export const PRE_SCORE_MAX = 97;
export const RAW_SCORE_MAX = 100;
export const VERIFICATION_SHORTLIST_LIMIT = 10;

const TARGET_LIKE_POST_OPPORTUNITIES = 4;
const TARGET_COMMENT_OPPORTUNITIES = 12;

export type AppearanceGrade = 1 | 2 | 3 | 4 | 5;
export type ReverseLikeStatus = 'observed' | 'not_observed' | 'not_collected';
export type RiskBand = typeof RISK_BANDS[number];

export interface RiskPolicyInput {
    uniqueTargetPostsLikedByCandidate: number;
    boundedCandidateCommentsOnTarget: number;
    reverseLikeStatus: ReverseLikeStatus;
    hasTagOrCaptionMention: boolean;
    recentFemaleMutualRank: number | null;
    appearanceGrade: AppearanceGrade;
    exposureScore: number;
    accountContext: AccountContext;
    hasWeakPartnerEvidence: boolean;
    hasStrongPartnerEvidence: boolean;
}

export interface RiskPolicyComponents {
    candidateToTargetLikes: number;
    candidateToTargetComments: number;
    targetToCandidateLike: number;
    tagOrCaptionMention: number;
    recentMutual: number;
    appearanceExposure: number;
}

export interface RiskPolicyResult {
    policyVersion: typeof RISK_POLICY_VERSION;
    components: Readonly<RiskPolicyComponents>;
    softContextBeforeBusinessAdjustment: Readonly<{
        recentMutual: number;
        appearanceExposure: number;
    }>;
    softContextMultiplier: 0 | 0.5 | 1;
    weakPartnerAdjustment: 0 | typeof WEAK_PARTNER_RAW_ADJUSTMENT;
    preScore: number;
    rawScore: number;
    possibleUpperBound: number;
    publicScore: number;
    displayScore: number;
    possibleUpperPublicScore: number;
    possibleUpperDisplayScore: number;
    riskBand: RiskBand;
    partnerCapApplied: boolean;
}

export interface FeatureableRiskCandidate {
    candidateId: string;
    publicScore: number;
    riskBand: RiskBand;
}

export type RankedRiskCandidate<T extends FeatureableRiskCandidate> = T & Readonly<{
    featuredRank: number | null;
}>;

export interface VerificationShortlistCandidate {
    candidateId: string;
    preScore: number;
}

export type VerificationShortlistAssignment<T extends VerificationShortlistCandidate> =
    T & Readonly<{ verificationShortlistRank: number | null }>;

function assertNonNegativeInteger(value: number, field: string): void {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${field} must be a non-negative safe integer.`);
    }
}

function assertFiniteRange(value: number, minimum: number, maximum: number, field: string): void {
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
        throw new RangeError(`${field} must be between ${minimum} and ${maximum}.`);
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function roundToOneDecimal(value: number): number {
    return Math.round((value + Number.EPSILON) * 10) / 10;
}

function normalizedObservedScore(observed: number, opportunities: number, weight: number): number {
    return weight * Math.min(observed / opportunities, 1);
}

export function scoreCandidateToTargetLikes(uniqueTargetPosts: number): number {
    assertNonNegativeInteger(uniqueTargetPosts, 'uniqueTargetPosts');
    return normalizedObservedScore(
        uniqueTargetPosts,
        TARGET_LIKE_POST_OPPORTUNITIES,
        RISK_COMPONENT_WEIGHTS.candidateToTargetLikes
    );
}

export function scoreCandidateToTargetComments(boundedCommentCount: number): number {
    assertNonNegativeInteger(boundedCommentCount, 'boundedCommentCount');
    return normalizedObservedScore(
        boundedCommentCount,
        TARGET_COMMENT_OPPORTUNITIES,
        RISK_COMPONENT_WEIGHTS.candidateToTargetComments
    );
}

export function scoreReverseLike(status: ReverseLikeStatus): number {
    return status === 'observed' ? RISK_COMPONENT_WEIGHTS.targetToCandidateLike : 0;
}

export function scoreTagOrCaptionMention(observed: boolean): number {
    return observed ? RISK_COMPONENT_WEIGHTS.tagOrCaptionMention : 0;
}

export function scoreRecentFemaleMutual(rank: number | null): number {
    if (rank === null) return 0;
    if (!Number.isSafeInteger(rank) || rank < 1) {
        throw new RangeError('recentFemaleMutualRank must be a positive safe integer or null.');
    }
    return RECENT_FEMALE_MUTUAL_POINTS[rank - 1] ?? 0;
}

export function scoreAppearanceExposure(
    appearanceGrade: AppearanceGrade,
    exposureScore: number
): number {
    if (!(appearanceGrade in APPEARANCE_GRADE_POINTS)) {
        throw new RangeError('appearanceGrade must be an integer from 1 through 5.');
    }
    assertFiniteRange(exposureScore, 0, 5, 'exposureScore');

    const baseScore = APPEARANCE_GRADE_POINTS[appearanceGrade] + exposureScore;
    return Math.min(
        baseScore * APPEARANCE_EXPOSURE_NORMALIZER,
        RISK_COMPONENT_WEIGHTS.appearanceExposure
    );
}

export function rawScoreToPublicScore(
    rawScore: number,
    hasStrongPartnerEvidence = false
): number {
    if (!Number.isFinite(rawScore)) {
        throw new RangeError('rawScore must be finite.');
    }

    const score = 1 + (9 * clamp(rawScore, 0, RAW_SCORE_MAX)) / RAW_SCORE_MAX;
    return hasStrongPartnerEvidence
        ? Math.min(score, STRONG_PARTNER_PUBLIC_SCORE_CAP)
        : score;
}

export function rawScoreToDisplayScore(
    rawScore: number,
    hasStrongPartnerEvidence = false
): number {
    return roundToOneDecimal(rawScoreToPublicScore(rawScore, hasStrongPartnerEvidence));
}

export function classifyRiskBandFromRawScore(
    rawScore: number,
    hasStrongPartnerEvidence = false
): RiskBand {
    const publicScore = rawScoreToPublicScore(rawScore, hasStrongPartnerEvidence);
    if (publicScore < RISK_DISPLAY_THRESHOLDS.caution) return 'normal';
    if (publicScore < RISK_DISPLAY_THRESHOLDS.high) return 'caution';
    return 'high_risk';
}

/**
 * A one-decimal display score loses the exact raw boundary. Only 4.2 and 6.8 may therefore
 * legitimately map to either adjacent band; every other displayed value has one valid band.
 */
export function isRiskBandCompatibleWithDisplayScore(
    displayScore: number,
    riskBand: RiskBand
): boolean {
    assertFiniteRange(displayScore, 1, 10, 'displayScore');
    if (displayScore < RISK_DISPLAY_THRESHOLDS.caution) return riskBand === 'normal';
    if (displayScore === RISK_DISPLAY_THRESHOLDS.caution) {
        return riskBand === 'normal' || riskBand === 'caution';
    }
    if (displayScore < RISK_DISPLAY_THRESHOLDS.high) return riskBand === 'caution';
    if (displayScore === RISK_DISPLAY_THRESHOLDS.high) {
        return riskBand === 'caution' || riskBand === 'high_risk';
    }
    return riskBand === 'high_risk';
}

export function calculateRiskPolicy(input: RiskPolicyInput): RiskPolicyResult {
    if (input.hasWeakPartnerEvidence && input.hasStrongPartnerEvidence) {
        throw new Error('RISK_POLICY_ERROR: weak and strong partner evidence are mutually exclusive.');
    }
    const candidateToTargetLikes = scoreCandidateToTargetLikes(
        input.uniqueTargetPostsLikedByCandidate
    );
    const candidateToTargetComments = scoreCandidateToTargetComments(
        input.boundedCandidateCommentsOnTarget
    );
    const targetToCandidateLike = scoreReverseLike(input.reverseLikeStatus);
    const tagOrCaptionMention = scoreTagOrCaptionMention(input.hasTagOrCaptionMention);
    const recentMutualBeforeBusiness = scoreRecentFemaleMutual(input.recentFemaleMutualRank);
    const appearanceExposureBeforeBusiness = scoreAppearanceExposure(
        input.appearanceGrade,
        input.exposureScore
    );
    const softContextMultiplier = ACCOUNT_CONTEXT_SOFT_MULTIPLIERS[input.accountContext];
    if (softContextMultiplier === undefined) {
        throw new Error('RISK_POLICY_ERROR: invalid account context.');
    }
    const recentMutual = recentMutualBeforeBusiness * softContextMultiplier;
    const appearanceExposure = appearanceExposureBeforeBusiness * softContextMultiplier;

    const weakPartnerAdjustment = input.hasWeakPartnerEvidence
        ? WEAK_PARTNER_RAW_ADJUSTMENT
        : 0;
    const preScore = clamp(
        candidateToTargetLikes
            + candidateToTargetComments
            + tagOrCaptionMention
            + recentMutual
            + appearanceExposure
            + weakPartnerAdjustment,
        0,
        PRE_SCORE_MAX
    );
    const rawScore = clamp(preScore + targetToCandidateLike, 0, RAW_SCORE_MAX);
    const possibleUpperBound = input.reverseLikeStatus === 'not_collected'
        ? clamp(preScore + RISK_COMPONENT_WEIGHTS.targetToCandidateLike, 0, RAW_SCORE_MAX)
        : rawScore;
    const publicScore = rawScoreToPublicScore(rawScore, input.hasStrongPartnerEvidence);
    const possibleUpperPublicScore = rawScoreToPublicScore(
        possibleUpperBound,
        input.hasStrongPartnerEvidence
    );

    return Object.freeze({
        policyVersion: RISK_POLICY_VERSION,
        components: Object.freeze({
            candidateToTargetLikes,
            candidateToTargetComments,
            targetToCandidateLike,
            tagOrCaptionMention,
            recentMutual,
            appearanceExposure,
        }),
        softContextBeforeBusinessAdjustment: Object.freeze({
            recentMutual: recentMutualBeforeBusiness,
            appearanceExposure: appearanceExposureBeforeBusiness,
        }),
        softContextMultiplier,
        weakPartnerAdjustment,
        preScore,
        rawScore,
        possibleUpperBound,
        publicScore,
        displayScore: roundToOneDecimal(publicScore),
        possibleUpperPublicScore,
        possibleUpperDisplayScore: roundToOneDecimal(possibleUpperPublicScore),
        riskBand: classifyRiskBandFromRawScore(rawScore, input.hasStrongPartnerEvidence),
        partnerCapApplied: input.hasStrongPartnerEvidence
            && rawScoreToPublicScore(rawScore) > STRONG_PARTNER_PUBLIC_SCORE_CAP,
    });
}

function compareFeatureCandidates(
    left: FeatureableRiskCandidate,
    right: FeatureableRiskCandidate
): number {
    if (left.publicScore !== right.publicScore) return right.publicScore - left.publicScore;
    if (left.candidateId < right.candidateId) return -1;
    if (left.candidateId > right.candidateId) return 1;
    return 0;
}

/**
 * Freezes the global reverse-like verification scope before the paid liker lookup runs.
 * This is deliberately named a shortlist because uncollected candidates can still have
 * a possible upper bound three points above their preliminary score.
 */
export function assignVerificationShortlist<T extends VerificationShortlistCandidate>(
    candidates: readonly T[]
): Array<VerificationShortlistAssignment<T>> {
    const seenCandidateIds = new Set<string>();
    for (const candidate of candidates) {
        const candidateId = candidate.candidateId.trim();
        if (
            !candidateId
            || candidateId !== candidate.candidateId
            || seenCandidateIds.has(candidateId)
        ) {
            throw new Error('RISK_POLICY_ERROR: candidateId must be non-empty and unique.');
        }
        assertFiniteRange(candidate.preScore, 0, PRE_SCORE_MAX, 'preScore');
        seenCandidateIds.add(candidateId);
    }

    const rankByCandidateId = new Map(
        candidates
            .slice()
            .sort((left, right) => (
                right.preScore - left.preScore
                || (left.candidateId < right.candidateId ? -1 : 1)
            ))
            .slice(0, VERIFICATION_SHORTLIST_LIMIT)
            .map((candidate, index) => [candidate.candidateId, index + 1] as const)
    );

    return candidates.map(candidate => Object.freeze({
        ...candidate,
        verificationShortlistRank: rankByCandidateId.get(candidate.candidateId) ?? null,
    }));
}

/**
 * Assigns ranks only inside the featured sections. Accounts outside each section's cap keep
 * their absolute risk band and receive a null featured rank.
 */
export function assignFeaturedRiskRanks<T extends FeatureableRiskCandidate>(
    candidates: readonly T[]
): Array<RankedRiskCandidate<T>> {
    const seenCandidateIds = new Set<string>();
    for (const candidate of candidates) {
        const candidateId = candidate.candidateId.trim();
        if (
            !candidateId
            || candidateId !== candidate.candidateId
            || seenCandidateIds.has(candidateId)
        ) {
            throw new Error('RISK_POLICY_ERROR: candidateId must be non-empty and unique.');
        }
        assertFiniteRange(candidate.publicScore, 1, 10, 'publicScore');
        if (
            Math.abs(candidate.publicScore * 10 - Math.round(candidate.publicScore * 10))
            >= 1e-9
        ) {
            throw new RangeError('publicScore must have at most one decimal place.');
        }
        if (!isRiskBandCompatibleWithDisplayScore(candidate.publicScore, candidate.riskBand)) {
            throw new Error(
                'RISK_POLICY_ERROR: publicScore and riskBand are incompatible.'
            );
        }
        seenCandidateIds.add(candidateId);
    }

    const featuredRankById = new Map<string, number>();
    for (const [band, limit] of [
        ['high_risk', FEATURED_RISK_LIMITS.high_risk],
        ['caution', FEATURED_RISK_LIMITS.caution],
    ] as const) {
        candidates
            .filter(candidate => candidate.riskBand === band)
            .slice()
            .sort(compareFeatureCandidates)
            .slice(0, limit)
            .forEach((candidate, index) => {
                featuredRankById.set(candidate.candidateId, index + 1);
            });
    }

    return candidates.map(candidate => Object.freeze({
        ...candidate,
        featuredRank: featuredRankById.get(candidate.candidateId) ?? null,
    }));
}
