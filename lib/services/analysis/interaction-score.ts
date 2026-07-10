export const INTERACTION_SCORE_WEIGHTS = {
    femaleToTargetLikes: 35,
    femaleToTargetComments: 45,
    targetToFemaleLikes: 20,
} as const;

export interface InteractionCommentEvidence {
    commentId: string;
    postId: string;
}

export interface InteractionCoverageSource {
    postId: string;
    declaredCount: number;
    returnedCount: number;
    requestedLimit: number;
}

export interface InteractionScoreInput {
    targetLikePostIds: string[];
    targetCommentPostIds: string[];
    candidatePostIds: string[];
    femaleLikedTargetPostIds: string[];
    femaleCommentsOnTarget: InteractionCommentEvidence[];
    targetLikedFemalePostIds: string[];
    targetLikeCoverage: InteractionCoverageSource[];
    targetCommentCoverage: InteractionCoverageSource[];
    candidateLikeCoverage: InteractionCoverageSource[];
}

export interface InteractionScoreResult {
    score: number;
    coverage: number;
    coverageStatus: 'high' | 'medium' | 'low';
    femaleToTargetLikesCount: number;
    femaleToTargetCommentsCount: number;
    targetToFemaleLikesCount: number;
    breakdown: {
        femaleToTargetLikes: number;
        femaleToTargetComments: number;
        targetToFemaleLikes: number;
    };
}

function boundedUniqueCount(values: string[], allowed: Set<string>, maximum: number): number {
    const unique = new Set(
        values
            .map(value => value.trim())
            .filter(value => value && allowed.has(value))
    );
    return Math.min(unique.size, maximum);
}

function commentCounts(
    comments: InteractionCommentEvidence[],
    allowedPosts: Set<string>
): { observed: number; scoringContribution: number } {
    const seenCommentIds = new Set<string>();
    const perPost = new Map<string, number>();

    for (const comment of comments) {
        const commentId = comment.commentId.trim();
        const postId = comment.postId.trim();
        if (!commentId || !allowedPosts.has(postId) || seenCommentIds.has(commentId)) continue;

        seenCommentIds.add(commentId);
        perPost.set(postId, Math.min((perPost.get(postId) ?? 0) + 1, 2));
    }

    return {
        observed: seenCommentIds.size,
        scoringContribution: [...perPost.values()].reduce((total, count) => total + count, 0),
    };
}

function componentScore(observed: number, opportunities: number, weight: number): number {
    if (opportunities <= 0) return 0;
    return weight * Math.min(observed / opportunities, 1);
}

export function interactionCoverageRatio(source: InteractionCoverageSource): number {
    if (
        !Number.isSafeInteger(source.declaredCount)
        || !Number.isSafeInteger(source.returnedCount)
        || !Number.isSafeInteger(source.requestedLimit)
        || source.declaredCount < 0
        || source.returnedCount < 0
        || source.requestedLimit < 1
        || source.returnedCount > source.requestedLimit
    ) {
        throw new Error('INTERACTION_COVERAGE_ERROR: invalid coverage source.');
    }
    if (source.declaredCount === 0) return 1;
    return Math.min(source.returnedCount / source.declaredCount, 1);
}

function averageCoverage(sources: InteractionCoverageSource[]): number {
    if (sources.length === 0) return 0;
    return sources.reduce(
        (total, source) => total + interactionCoverageRatio(source),
        0
    ) / sources.length;
}

/**
 * Score only interactions that were positively observed. Coverage is returned separately so a
 * truncated liker/comment page is never represented as proof that an interaction did not happen.
 */
export function calculateInteractionScore(input: InteractionScoreInput): InteractionScoreResult {
    const targetLikePostIds = new Set(
        input.targetLikePostIds.map(value => value.trim()).filter(Boolean)
    );
    const targetCommentPostIds = new Set(
        input.targetCommentPostIds.map(value => value.trim()).filter(Boolean)
    );
    const candidatePostIds = new Set(
        input.candidatePostIds.map(value => value.trim()).filter(Boolean)
    );

    const femaleToTargetLikesCount = boundedUniqueCount(
        input.femaleLikedTargetPostIds,
        targetLikePostIds,
        targetLikePostIds.size
    );
    const femaleToTargetCommentCounts = commentCounts(
        input.femaleCommentsOnTarget,
        targetCommentPostIds
    );
    const femaleToTargetCommentsCount = femaleToTargetCommentCounts.observed;
    const targetToFemaleLikesCount = boundedUniqueCount(
        input.targetLikedFemalePostIds,
        candidatePostIds,
        candidatePostIds.size
    );

    const breakdown = {
        femaleToTargetLikes: componentScore(
            femaleToTargetLikesCount,
            targetLikePostIds.size,
            INTERACTION_SCORE_WEIGHTS.femaleToTargetLikes
        ),
        femaleToTargetComments: componentScore(
            femaleToTargetCommentCounts.scoringContribution,
            targetCommentPostIds.size * 2,
            INTERACTION_SCORE_WEIGHTS.femaleToTargetComments
        ),
        targetToFemaleLikes: componentScore(
            targetToFemaleLikesCount,
            candidatePostIds.size,
            INTERACTION_SCORE_WEIGHTS.targetToFemaleLikes
        ),
    };

    const coverage = (
        averageCoverage(input.targetLikeCoverage)
            * INTERACTION_SCORE_WEIGHTS.femaleToTargetLikes
        + averageCoverage(input.targetCommentCoverage)
            * INTERACTION_SCORE_WEIGHTS.femaleToTargetComments
        + averageCoverage(input.candidateLikeCoverage)
            * INTERACTION_SCORE_WEIGHTS.targetToFemaleLikes
    ) / 100;

    return {
        score: Math.round(
            breakdown.femaleToTargetLikes
            + breakdown.femaleToTargetComments
            + breakdown.targetToFemaleLikes
        ),
        coverage,
        coverageStatus: coverage >= 0.8 ? 'high' : coverage >= 0.5 ? 'medium' : 'low',
        femaleToTargetLikesCount,
        femaleToTargetCommentsCount,
        targetToFemaleLikesCount,
        breakdown,
    };
}
