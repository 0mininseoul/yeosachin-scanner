import {
    assignRecentFemaleMutuals,
    type RecentFemaleMutualAssignment,
} from '@/lib/domain/analysis/recent-female-mutual-policy';
import {
    assignFeaturedRiskRanks,
    assignVerificationShortlist,
    calculateRiskPolicy,
    type AppearanceGrade,
    type ReverseLikeStatus,
    type RiskPolicyResult,
} from '@/lib/domain/analysis/risk-policy';

export interface V2FemaleCandidateEvidence {
    candidateId: string;
    username: string;
    appearanceGrade: AppearanceGrade;
    exposureScore: number;
    isBusinessAccount: boolean;
    hasWeakPartnerEvidence: boolean;
    hasStrongPartnerEvidence: boolean;
    uniqueTargetPostsLikedByCandidate: number;
    boundedCandidateCommentsOnTarget: number;
    hasTagOrCaptionMention: boolean;
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
        verifiedFemaleUsernames: candidates.map(candidate => candidate.username),
        excludedUsername,
    });
    return new Map(assignments.map(assignment => [assignment.username, assignment]));
}

/** Freeze the global Top 10 before the three-point reverse-like lookup runs. */
export function calculateV2PreliminaryScores(input: {
    candidates: readonly V2FemaleCandidateEvidence[];
    orderedMutualUsernames: readonly string[];
    excludedUsername: string | null;
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
            hasTagOrCaptionMention: candidate.hasTagOrCaptionMention,
            recentFemaleMutualRank: recent?.rank ?? null,
            appearanceGrade: candidate.appearanceGrade,
            exposureScore: candidate.exposureScore,
            isBusinessAccount: candidate.isBusinessAccount,
            // The public preliminary checkpoint has no partner-adjustment field.
            // Preserve the signals on the candidate, but apply them only after
            // the dedicated partner-safety stage has produced its checkpoint.
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
        });
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
        .filter(candidate => !alreadyFeatured.has(candidate.candidateId))
        .slice()
        .sort((left, right) => (
            right.risk.displayScore - left.risk.displayScore
            || left.candidateId.localeCompare(right.candidateId)
        ))
        .slice(0, 2)
        .map((candidate, index) => [candidate.candidateId, index + 1]));
}

export function calculateV2FinalScores(input: {
    preliminary: readonly V2PreliminaryCandidateScore[];
    observedReverseLikeCandidateIds: ReadonlySet<string>;
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

    const scored = input.preliminary.map(candidate => {
        const reverseLikeStatus: ReverseLikeStatus = shortlistIds.has(candidate.candidateId)
            ? input.observedReverseLikeCandidateIds.has(candidate.candidateId)
                ? 'observed'
                : 'not_observed'
            : 'not_collected';
        const risk = calculateRiskPolicy({
            uniqueTargetPostsLikedByCandidate: candidate.uniqueTargetPostsLikedByCandidate,
            boundedCandidateCommentsOnTarget: candidate.boundedCandidateCommentsOnTarget,
            reverseLikeStatus,
            hasTagOrCaptionMention: candidate.hasTagOrCaptionMention,
            recentFemaleMutualRank: candidate.recentFemaleMutualRank,
            appearanceGrade: candidate.appearanceGrade,
            exposureScore: candidate.exposureScore,
            isBusinessAccount: candidate.isBusinessAccount,
            hasWeakPartnerEvidence: candidate.hasWeakPartnerEvidence,
            hasStrongPartnerEvidence: candidate.hasStrongPartnerEvidence,
        });
        return { ...candidate, reverseLikeStatus, risk };
    });
    const featured = assignFeaturedRiskRanks(scored.map(candidate => ({
        ...candidate,
        publicScore: candidate.risk.displayScore,
        riskBand: candidate.risk.riskBand,
    })));
    const withoutRelative = featured.map(({ publicScore, riskBand, ...row }) => {
        if (
            publicScore !== row.risk.displayScore
            || riskBand !== row.risk.riskBand
        ) {
            throw new Error('V2_SCORING_ERROR: featured ranking changed the absolute score band.');
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
}): boolean {
    const target = normalizedUsername(input.targetUsername);
    const candidate = normalizedUsername(input.candidateUsername);
    const mentions = (
        posts: readonly Pick<import('@/lib/types/instagram').InstagramPost, 'taggedUsers' | 'mentionedUsers'>[],
        username: string
    ) => posts.some(post => [...post.taggedUsers, ...post.mentionedUsers]
        .some(value => normalizedUsername(value) === username));
    return mentions(input.targetPosts, candidate) || mentions(input.candidatePosts, target);
}
