import {
    assignRecentFemaleMutuals,
    type RecentFemaleMutualAssignment,
} from '@/lib/domain/analysis/recent-female-mutual-policy';
import {
    assignFeaturedRiskRanks,
    assignVerificationShortlist,
    calculateRiskPolicy,
    type AccountContext,
    type AppearanceGrade,
    type ReverseLikeStatus,
    type RiskBand,
    type RiskPolicyVersion,
    type RiskPolicyResult,
} from '@/lib/domain/analysis/risk-policy';
import {
    assignRelativeRiskTiers,
    assignRelativeRiskTiersV25,
} from '@/lib/domain/analysis/relative-risk-policy';

export interface V2FemaleCandidateEvidence {
    candidateId: string;
    username: string;
    appearanceGrade: AppearanceGrade;
    exposureScore: number;
    accountContext: AccountContext;
    hasWeakPartnerEvidence: boolean;
    hasStrongPartnerEvidence: boolean;
    uniqueTargetPostsLikedByCandidate: number;
    boundedCandidateCommentsOnTarget: number;
    hasCandidateToTargetTagOrCaptionMention: boolean;
    hasTargetToCandidateTagOrCaptionMention: boolean;
}

export interface V2PreliminaryCandidateScore extends V2FemaleCandidateEvidence {
    recentFemaleMutualRank: number | null;
    recentMutualBadgeRank: number | null;
    preScore: number;
    verificationShortlistRank: number | null;
}

export interface V2FinalCandidateScore extends V2PreliminaryCandidateScore {
    reverseLikeStatus: ReverseLikeStatus;
    risk: RiskPolicyResult;
    displayScore: number;
    riskBand: RiskBand;
    relativeTierApplied: boolean;
    featuredRank: number | null;
    relativeWatchRank: number | null;
}

function normalizedUsername(value: string): string {
    const normalized = value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(normalized)) {
        throw new Error('V2_SCORING_ERROR: invalid candidate username.');
    }
    return normalized;
}

function validateCandidateIdentities(candidates: readonly V2FemaleCandidateEvidence[]): void {
    const ids = new Set<string>();
    const usernames = new Set<string>();
    for (const candidate of candidates) {
        if (
            !/^[A-Za-z0-9._:-]{1,128}$/.test(candidate.candidateId)
            || ids.has(candidate.candidateId)
        ) {
            throw new Error('V2_SCORING_ERROR: candidate IDs must be unique and opaque.');
        }
        const username = normalizedUsername(candidate.username);
        if (usernames.has(username)) {
            throw new Error('V2_SCORING_ERROR: candidate usernames must be unique.');
        }
        ids.add(candidate.candidateId);
        usernames.add(username);
    }
}

function recentAssignmentIndex(
    candidates: readonly V2FemaleCandidateEvidence[],
    orderedMutualUsernames: readonly string[],
    excludedUsername: string | null
): Map<string, RecentFemaleMutualAssignment> {
    const assignments = assignRecentFemaleMutuals({
        orderedMutualUsernames,
        verifiedFemaleUsernames: candidates
            .filter(candidate => candidate.accountContext !== 'official_group_or_brand')
            .map(candidate => candidate.username),
        excludedUsername,
    });
    return new Map(assignments.map(assignment => [assignment.username, assignment]));
}

/** Freeze the global Top 10 before the five-point reverse-like lookup runs. */
export function calculateV2PreliminaryScores(input: {
    candidates: readonly V2FemaleCandidateEvidence[];
    orderedMutualUsernames: readonly string[];
    excludedUsername: string | null;
    riskPolicyVersion?: RiskPolicyVersion;
}): V2PreliminaryCandidateScore[] {
    validateCandidateIdentities(input.candidates);
    const recentByUsername = recentAssignmentIndex(
        input.candidates,
        input.orderedMutualUsernames,
        input.excludedUsername
    );
    const preliminary = input.candidates.map(candidate => {
        const recent = recentByUsername.get(normalizedUsername(candidate.username));
        const risk = calculateRiskPolicy({
            uniqueTargetPostsLikedByCandidate: candidate.uniqueTargetPostsLikedByCandidate,
            boundedCandidateCommentsOnTarget: candidate.boundedCandidateCommentsOnTarget,
            reverseLikeStatus: 'not_collected',
            hasCandidateToTargetTagOrCaptionMention:
                candidate.hasCandidateToTargetTagOrCaptionMention,
            hasTargetToCandidateTagOrCaptionMention:
                candidate.hasTargetToCandidateTagOrCaptionMention,
            recentFemaleMutualRank: recent?.rank ?? null,
            appearanceGrade: candidate.appearanceGrade,
            exposureScore: candidate.exposureScore,
            accountContext: candidate.accountContext,
            // The public preliminary checkpoint has no partner-adjustment field.
            // Preserve the signals on the candidate, but apply them only after
            // the dedicated partner-safety stage has produced its checkpoint.
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
        }, input.riskPolicyVersion);
        return {
            ...candidate,
            username: normalizedUsername(candidate.username),
            recentFemaleMutualRank: recent?.rank ?? null,
            recentMutualBadgeRank: recent?.badgeRank ?? null,
            preScore: risk.preScore,
        };
    });

    return assignVerificationShortlist(preliminary);
}

function relativeWatchAssignments(
    candidates: readonly Omit<V2FinalCandidateScore, 'relativeWatchRank'>[]
): Map<string, number> {
    if (candidates.length < 20) return new Map();
    const alreadyFeatured = new Set(
        candidates
            .filter(candidate => candidate.featuredRank !== null)
            .map(candidate => candidate.candidateId)
    );
    return new Map(candidates
        .filter(candidate => (
            candidate.accountContext !== 'official_group_or_brand'
            && !alreadyFeatured.has(candidate.candidateId)
        ))
        .slice()
        .sort((left, right) => (
            right.displayScore - left.displayScore
            || left.candidateId.localeCompare(right.candidateId)
        ))
        .slice(0, 2)
        .map((candidate, index) => [candidate.candidateId, index + 1]));
}

export function calculateV2FinalScores(input: {
    preliminary: readonly V2PreliminaryCandidateScore[];
    observedReverseLikeCandidateIds: ReadonlySet<string>;
    notCollectedCandidateIds?: ReadonlySet<string>;
    riskPolicyVersion?: RiskPolicyVersion;
}): V2FinalCandidateScore[] {
    const shortlistIds = new Set(
        input.preliminary
            .filter(candidate => candidate.verificationShortlistRank !== null)
            .map(candidate => candidate.candidateId)
    );
    for (const candidateId of input.observedReverseLikeCandidateIds) {
        if (!shortlistIds.has(candidateId)) {
            throw new Error('V2_SCORING_ERROR: reverse-like evidence is outside the frozen shortlist.');
        }
    }
    const notCollectedIds = input.notCollectedCandidateIds ?? new Set<string>();
    for (const candidateId of notCollectedIds) {
        if (input.observedReverseLikeCandidateIds.has(candidateId)) {
            throw new Error(
                'V2_SCORING_ERROR: reverse-like evidence cannot be both observed and not collected.'
            );
        }
    }

    const scored = input.preliminary.map(candidate => {
        const reverseLikeStatus: ReverseLikeStatus = (
            notCollectedIds.has(candidate.candidateId)
            || !shortlistIds.has(candidate.candidateId)
        )
            ? 'not_collected'
            : input.observedReverseLikeCandidateIds.has(candidate.candidateId)
                ? 'observed'
                : 'not_observed';
        const risk = calculateRiskPolicy({
            uniqueTargetPostsLikedByCandidate: candidate.uniqueTargetPostsLikedByCandidate,
            boundedCandidateCommentsOnTarget: candidate.boundedCandidateCommentsOnTarget,
            reverseLikeStatus,
            hasCandidateToTargetTagOrCaptionMention:
                candidate.hasCandidateToTargetTagOrCaptionMention,
            hasTargetToCandidateTagOrCaptionMention:
                candidate.hasTargetToCandidateTagOrCaptionMention,
            recentFemaleMutualRank: candidate.recentFemaleMutualRank,
            appearanceGrade: candidate.appearanceGrade,
            exposureScore: candidate.exposureScore,
            accountContext: candidate.accountContext,
            hasWeakPartnerEvidence: candidate.hasWeakPartnerEvidence,
            hasStrongPartnerEvidence: candidate.hasStrongPartnerEvidence,
        }, input.riskPolicyVersion);
        return { ...candidate, reverseLikeStatus, risk };
    });
    const relativeCandidates = scored.map(candidate => ({
        candidateId: candidate.candidateId,
        naturalPublicScore: candidate.risk.publicScore,
        naturalDisplayScore: candidate.risk.displayScore,
        naturalRiskBand: candidate.risk.riskBand,
        partnerCapApplied: candidate.hasStrongPartnerEvidence,
        isInbound: candidate.uniqueTargetPostsLikedByCandidate >= 1
            || candidate.boundedCandidateCommentsOnTarget >= 1
            || candidate.hasCandidateToTargetTagOrCaptionMention,
        personalRiskEligible: candidate.accountContext !== 'official_group_or_brand',
    }));
    const relativeAssignments = input.riskPolicyVersion === 'risk-policy-v2.4'
        ? assignRelativeRiskTiers(relativeCandidates)
        : assignRelativeRiskTiersV25(relativeCandidates);
    const relativeById = new Map(
        relativeAssignments.map(assignment => [assignment.candidateId, assignment])
    );
    const calibrated = scored.map(candidate => {
        const assignment = relativeById.get(candidate.candidateId);
        if (!assignment) {
            throw new Error('V2_SCORING_ERROR: relative risk assignment is incomplete.');
        }
        return {
            ...candidate,
            displayScore: assignment.displayScore,
            riskBand: assignment.riskBand,
            relativeTierApplied: assignment.relativeTierApplied,
        };
    });
    const featured = assignFeaturedRiskRanks(calibrated.map(candidate => ({
        ...candidate,
        publicScore: candidate.displayScore,
    })));
    const withoutRelative = featured.map(({ publicScore, ...row }) => {
        if (publicScore !== row.displayScore) {
            throw new Error('V2_SCORING_ERROR: featured ranking changed the display score.');
        }
        return row;
    });
    const relativeRanks = relativeWatchAssignments(withoutRelative);
    return withoutRelative.map(candidate => ({
        ...candidate,
        relativeWatchRank: relativeRanks.get(candidate.candidateId) ?? null,
    }));
}

export function hasCandidateTargetMention(input: {
    targetUsername: string;
    candidateUsername: string;
    targetPosts: readonly Pick<import('@/lib/types/instagram').InstagramPost, 'taggedUsers' | 'mentionedUsers'>[];
    candidatePosts: readonly Pick<import('@/lib/types/instagram').InstagramPost, 'taggedUsers' | 'mentionedUsers'>[];
}): Readonly<{
    candidateToTargetTagOrCaptionMention: boolean;
    targetToCandidateTagOrCaptionMention: boolean;
}> {
    const target = normalizedUsername(input.targetUsername);
    const candidate = normalizedUsername(input.candidateUsername);
    const mentions = (
        posts: readonly Pick<import('@/lib/types/instagram').InstagramPost, 'taggedUsers' | 'mentionedUsers'>[],
        username: string
    ) => posts.some(post => [...post.taggedUsers, ...post.mentionedUsers]
        .some(value => normalizedUsername(value) === username));
    return Object.freeze({
        candidateToTargetTagOrCaptionMention: mentions(input.candidatePosts, target),
        targetToCandidateTagOrCaptionMention: mentions(input.targetPosts, candidate),
    });
}
