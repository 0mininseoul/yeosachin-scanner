/**
 * Frozen v2.3 scorer used only to drain persisted v2.3 checkpoints. New requests
 * must use the v2.4 scorer. Values mirror origin/main's v2.3 policy verbatim.
 */
import type { AccountContext, AppearanceGrade, RiskBand } from '@/lib/domain/analysis/risk-policy';

export const LEGACY_RISK_POLICY_VERSION = 'risk-policy-v2.3' as const;
type ReverseLikeStatus = 'observed' | 'not_observed' | 'not_collected';

export interface LegacyV23PreliminaryCandidate {
    candidateId: string;
    username: string;
    appearanceGrade: AppearanceGrade;
    exposureScore: number;
    accountContext: AccountContext;
    hasWeakPartnerEvidence: boolean;
    hasStrongPartnerEvidence: boolean;
    uniqueTargetPostsLikedByCandidate: number;
    boundedCandidateCommentsOnTarget: number;
    hasTagOrCaptionMention: boolean;
    recentFemaleMutualRank: number | null;
    recentMutualBadgeRank: number | null;
    preScore: number;
    verificationShortlistRank: number | null;
}

export interface LegacyV23RiskResult {
    policyVersion: typeof LEGACY_RISK_POLICY_VERSION;
    components: Readonly<{
        candidateToTargetLikes: number;
        candidateToTargetComments: number;
        targetToCandidateLike: number;
        tagOrCaptionMention: number;
        recentMutual: number;
        appearanceExposure: number;
    }>;
    softContextBeforeBusinessAdjustment: Readonly<{ recentMutual: number; appearanceExposure: number }>;
    softContextMultiplier: 0 | 0.5 | 1;
    weakPartnerAdjustment: -5 | 0;
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

export interface LegacyV23FinalCandidate extends LegacyV23PreliminaryCandidate {
    reverseLikeStatus: ReverseLikeStatus;
    risk: LegacyV23RiskResult;
    displayScore: number;
    riskBand: RiskBand;
    relativeTierApplied: boolean;
    featuredRank: number | null;
    relativeWatchRank: number | null;
}

const recentPoints = [17, 16, 15, 14, 13, 12, 10, 8, 6, 4] as const;
const multipliers: Readonly<Record<AccountContext, 0 | 0.5 | 1>> = {
    personal: 1, individual_creator: 0.5, official_group_or_brand: 0, uncertain: 1,
};
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const round = (value: number) => Math.round((value + Number.EPSILON) * 10) / 10;
const scoreBand = (publicScore: number): RiskBand => publicScore < 4.2
    ? 'normal' : publicScore < 6.8 ? 'caution' : 'high_risk';
const publicScore = (rawScore: number, strong: boolean) => strong
    ? Math.min(1 + 9 * clamp(rawScore, 0, 100) / 100, 3.4)
    : 1 + 9 * clamp(rawScore, 0, 100) / 100;

function calculateRisk(candidate: LegacyV23PreliminaryCandidate, reverseLikeStatus: ReverseLikeStatus): LegacyV23RiskResult {
    if (candidate.hasWeakPartnerEvidence && candidate.hasStrongPartnerEvidence) {
        throw new Error('ANALYSIS_V2_LEGACY_POLICY_INVALID');
    }
    const candidateToTargetLikes = 20 * Math.min(candidate.uniqueTargetPostsLikedByCandidate / 4, 1);
    const candidateToTargetComments = 26 * Math.min(candidate.boundedCandidateCommentsOnTarget / 12, 1);
    const targetToCandidateLike = reverseLikeStatus === 'observed' ? 3 : 0;
    const tagOrCaptionMention = candidate.hasTagOrCaptionMention ? 14 : 0;
    const recentBefore = candidate.recentFemaleMutualRank === null
        ? 0 : recentPoints[candidate.recentFemaleMutualRank - 1] ?? 0;
    const appearanceBefore = Math.min((([0, 0, 3, 7, 10, 13][candidate.appearanceGrade] ?? 0)
        + candidate.exposureScore) * (20 / 18), 20);
    const multiplier = multipliers[candidate.accountContext];
    const recentMutual = recentBefore * multiplier;
    const appearanceExposure = appearanceBefore * multiplier;
    const weakPartnerAdjustment = candidate.hasWeakPartnerEvidence ? -5 : 0;
    const preScore = clamp(candidateToTargetLikes + candidateToTargetComments + tagOrCaptionMention
        + recentMutual + appearanceExposure + weakPartnerAdjustment, 0, 97);
    const rawScore = clamp(preScore + targetToCandidateLike, 0, 100);
    const possibleUpperBound = reverseLikeStatus === 'not_collected' ? clamp(preScore + 3, 0, 100) : rawScore;
    const naturalPublic = publicScore(rawScore, candidate.hasStrongPartnerEvidence);
    const possiblePublic = publicScore(possibleUpperBound, candidate.hasStrongPartnerEvidence);
    return {
        policyVersion: LEGACY_RISK_POLICY_VERSION,
        components: { candidateToTargetLikes, candidateToTargetComments, targetToCandidateLike,
            tagOrCaptionMention, recentMutual, appearanceExposure },
        softContextBeforeBusinessAdjustment: { recentMutual: recentBefore, appearanceExposure: appearanceBefore },
        softContextMultiplier: multiplier, weakPartnerAdjustment, preScore, rawScore,
        possibleUpperBound, publicScore: naturalPublic, displayScore: round(naturalPublic),
        possibleUpperPublicScore: possiblePublic, possibleUpperDisplayScore: round(possiblePublic),
        riskBand: scoreBand(naturalPublic),
        partnerCapApplied: candidate.hasStrongPartnerEvidence && publicScore(rawScore, false) > 3.4,
    };
}

function relativeAssignments(candidates: readonly Omit<LegacyV23FinalCandidate, 'featuredRank' | 'relativeWatchRank'>[]) {
    const eligible = candidates.filter(row => !row.hasStrongPartnerEvidence).slice().sort((a, b) =>
        b.risk.publicScore - a.risk.publicScore || a.candidateId.localeCompare(b.candidateId));
    const assignments = new Map<string, { displayScore: number; riskBand: RiskBand; relativeTierApplied: boolean }>();
    if (eligible.length >= 3) {
        const highCount = Math.max(1, Math.min(eligible.length - 2,
            eligible.filter(row => row.risk.riskBand === 'high_risk').length));
        const cautionCount = Math.min(eligible.length - highCount, Math.max(2,
            eligible.filter(row => row.risk.riskBand !== 'normal').length - highCount));
        eligible.forEach((row, index) => {
            const riskBand: RiskBand = index < highCount ? 'high_risk' : index < highCount + cautionCount ? 'caution' : 'normal';
            const [min, max] = riskBand === 'high_risk' ? [6.8, 10] : riskBand === 'caution' ? [4.2, 6.7] : [1, 4.1];
            assignments.set(row.candidateId, { displayScore: round(clamp(row.risk.displayScore, min, max)), riskBand, relativeTierApplied: true });
        });
    }
    return candidates.map(row => assignments.get(row.candidateId) ?? ({
        displayScore: row.risk.displayScore, riskBand: row.risk.riskBand, relativeTierApplied: false,
    }));
}

function relativeWatchAssignments(
    candidates: readonly Omit<LegacyV23FinalCandidate, 'relativeWatchRank'>[]
): Map<string, number> {
    if (candidates.length < 20) return new Map();
    const featured = new Set(candidates
        .filter(candidate => candidate.featuredRank !== null)
        .map(candidate => candidate.candidateId));
    return new Map(candidates
        .filter(candidate => !featured.has(candidate.candidateId))
        .slice()
        .sort((left, right) => right.displayScore - left.displayScore
            || left.candidateId.localeCompare(right.candidateId))
        .slice(0, 2)
        .map((candidate, index) => [candidate.candidateId, index + 1]));
}

export function calculateLegacyV23FinalScores(input: {
    preliminary: readonly LegacyV23PreliminaryCandidate[];
    observedReverseLikeCandidateIds: ReadonlySet<string>;
    notCollectedCandidateIds?: ReadonlySet<string>;
}): LegacyV23FinalCandidate[] {
    const shortlist = new Set(input.preliminary.filter(row => row.verificationShortlistRank !== null).map(row => row.candidateId));
    const notCollected = input.notCollectedCandidateIds ?? new Set<string>();
    const scored = input.preliminary.map(candidate => {
        const reverseLikeStatus: ReverseLikeStatus = notCollected.has(candidate.candidateId) || !shortlist.has(candidate.candidateId)
            ? 'not_collected' : input.observedReverseLikeCandidateIds.has(candidate.candidateId) ? 'observed' : 'not_observed';
        const risk = calculateRisk(candidate, reverseLikeStatus);
        return { ...candidate, reverseLikeStatus, risk, displayScore: risk.displayScore, riskBand: risk.riskBand, relativeTierApplied: false };
    });
    const calibrated = relativeAssignments(scored).map((assignment, index) => ({ ...scored[index]!, ...assignment }));
    const rankFor = (band: RiskBand, limit: number) => new Map(calibrated.filter(row => row.riskBand === band)
        .slice().sort((a, b) => b.displayScore - a.displayScore || a.candidateId.localeCompare(b.candidateId))
        .slice(0, limit).map((row, index) => [row.candidateId, index + 1]));
    const high = rankFor('high_risk', 3);
    const caution = rankFor('caution', 15);
    const ranked = calibrated.map(candidate => ({ ...candidate,
        featuredRank: high.get(candidate.candidateId) ?? caution.get(candidate.candidateId) ?? null,
    }));
    const relativeWatch = relativeWatchAssignments(ranked);
    return ranked.map(candidate => ({
        ...candidate,
        relativeWatchRank: relativeWatch.get(candidate.candidateId) ?? null,
    }));
}
