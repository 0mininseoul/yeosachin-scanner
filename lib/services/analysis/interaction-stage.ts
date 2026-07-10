import { z } from 'zod';
import type {
    ApifyPostComment,
    ApifyPostLiker,
} from '@/lib/services/instagram/providers/apify-interactions';
import type { InstagramPost } from '@/lib/types/instagram';
import {
    calculateInteractionScore,
    type InteractionCoverageSource,
    type InteractionScoreResult,
} from './interaction-score';
import { instagramPostUrl, selectRecentInteractionPosts } from './interaction-posts';

export const TARGET_COMMENT_POST_LIMIT = 6;
export const TARGET_LIKER_POST_LIMIT = 4;
/** @deprecated Select provider-specific target post limits instead. */
export const TARGET_INTERACTION_POST_LIMIT = TARGET_COMMENT_POST_LIMIT;
export const TARGET_COMMENT_LIMIT_PER_POST = 15;
export const TARGET_LIKER_LIMIT_PER_POST = 150;
export const CANDIDATE_INTERACTION_POST_LIMIT = 1;
export const CANDIDATE_LIKER_LIMIT_PER_POST = 100;
export const MAX_INTERACTION_CANDIDATES = 10;
export const CANDIDATE_INTERACTION_BATCH_SIZE = MAX_INTERACTION_CANDIDATES;

export type InteractionSignal =
    | 'female_target_like'
    | 'female_target_comment'
    | 'target_female_like';

export interface InteractionEvidenceRow {
    candidateUsername: string;
    postId: string;
    signal: InteractionSignal;
    sourceInteractionId: string;
    occurredAt?: string;
    content?: string;
}

export interface StoredInteractionCoverage extends InteractionCoverageSource {
    candidateUsername?: string;
}

export interface TargetInteractionExtraction {
    evidence: InteractionEvidenceRow[];
    candidateUsernames: string[];
    likerCoverage: StoredInteractionCoverage[];
    commentCoverage: StoredInteractionCoverage[];
}

export interface CandidateAccountPosts {
    username: string;
    posts: InstagramPost[];
}

export interface CandidateInteractionExtraction {
    evidence: InteractionEvidenceRow[];
    coverage: StoredInteractionCoverage[];
}

export interface InteractionCandidateIntermediateScore {
    username: string;
    intermediateScore: number;
}

const coverageSchema = z.object({
    postId: z.string().min(1).max(100),
    candidateUsername: z.string().regex(/^[a-z0-9._]{1,30}$/).optional(),
    declaredCount: z.number().int().nonnegative(),
    returnedCount: z.number().int().nonnegative(),
    requestedLimit: z.number().int().positive().max(200),
}).strict();

export function parseStoredInteractionCoverage(value: unknown): StoredInteractionCoverage[] {
    const parsed = z.array(coverageSchema).max(40).safeParse(value);
    if (!parsed.success) {
        throw new Error('INTERACTION_COVERAGE_ERROR: persisted coverage is invalid.');
    }
    return parsed.data;
}

function usernameKey(username: string): string {
    return username.trim().replace(/^@/, '').toLowerCase();
}

function boundedCommentText(value: string): string | undefined {
    const normalized = value
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized ? normalized.slice(0, 1_000) : undefined;
}

/**
 * Select only positively observed women for the paid follow-up. Higher intermediate feature
 * scores win, with a normalized username tie-breaker so retries always select the same ten.
 */
export function rankObservedInteractionCandidates(
    candidates: readonly InteractionCandidateIntermediateScore[],
    observedUsernames: Iterable<string>
): string[] {
    const observed = new Set([...observedUsernames].map(usernameKey).filter(Boolean));
    const scores = new Map<string, number>();

    for (const candidate of candidates) {
        const username = usernameKey(candidate.username);
        if (!username || !observed.has(username)) continue;
        if (!Number.isFinite(candidate.intermediateScore) || candidate.intermediateScore < 0) {
            throw new Error('INTERACTION_CANDIDATE_ERROR: intermediate score is invalid.');
        }
        scores.set(
            username,
            Math.max(scores.get(username) ?? Number.NEGATIVE_INFINITY, candidate.intermediateScore)
        );
    }

    return [...scores.entries()]
        .sort(([usernameA, scoreA], [usernameB, scoreB]) => {
            if (scoreA !== scoreB) return scoreB - scoreA;
            return usernameA < usernameB ? -1 : usernameA > usernameB ? 1 : 0;
        })
        .slice(0, MAX_INTERACTION_CANDIDATES)
        .map(([username]) => username);
}

function postIndex(posts: InstagramPost[]) {
    return new Map(posts.map(post => [instagramPostUrl(post), post]));
}

function returnedCounts<T extends { postUrl: string }>(rows: T[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of rows) {
        counts.set(row.postUrl, (counts.get(row.postUrl) ?? 0) + 1);
    }
    return counts;
}

function targetCoverage(
    posts: InstagramPost[],
    returned: Map<string, number>,
    requestedLimit: number,
    declared: (post: InstagramPost) => number
): StoredInteractionCoverage[] {
    return posts.map(post => ({
        postId: post.id,
        declaredCount: Math.max(0, declared(post)),
        returnedCount: returned.get(instagramPostUrl(post)) ?? 0,
        requestedLimit,
    }));
}

export function extractTargetInteractions(
    posts: InstagramPost[],
    likers: ApifyPostLiker[],
    comments: ApifyPostComment[],
    femaleUsernames: Iterable<string>
): TargetInteractionExtraction {
    const likerPosts = selectRecentInteractionPosts(posts, TARGET_LIKER_POST_LIMIT);
    const commentPosts = selectRecentInteractionPosts(posts, TARGET_COMMENT_POST_LIMIT);
    const likerPostsByUrl = postIndex(likerPosts);
    const commentPostsByUrl = postIndex(commentPosts);
    const femaleSet = new Set([...femaleUsernames].map(usernameKey));
    const evidence: InteractionEvidenceRow[] = [];
    const candidates = new Set<string>();

    for (const liker of likers) {
        const post = likerPostsByUrl.get(liker.postUrl);
        const candidateUsername = usernameKey(liker.username);
        if (!post || !femaleSet.has(candidateUsername)) continue;
        candidates.add(candidateUsername);
        evidence.push({
            candidateUsername,
            postId: post.id,
            signal: 'female_target_like',
            sourceInteractionId: liker.id,
        });
    }

    for (const comment of comments) {
        const post = commentPostsByUrl.get(comment.postUrl);
        const candidateUsername = usernameKey(comment.ownerUsername);
        if (!post || !femaleSet.has(candidateUsername)) continue;
        candidates.add(candidateUsername);
        evidence.push({
            candidateUsername,
            postId: post.id,
            signal: 'female_target_comment',
            sourceInteractionId: comment.id,
            occurredAt: comment.timestamp,
            content: boundedCommentText(comment.text),
        });
    }

    const likerDeclaredByPost = new Map<string, number>();
    for (const liker of likers) {
        likerDeclaredByPost.set(
            liker.postUrl,
            Math.max(likerDeclaredByPost.get(liker.postUrl) ?? 0, liker.totalLikes)
        );
    }

    return {
        evidence,
        candidateUsernames: [...candidates],
        likerCoverage: targetCoverage(
            likerPosts,
            returnedCounts(likers),
            TARGET_LIKER_LIMIT_PER_POST,
            post => Math.max(
                post.likesCount,
                likerDeclaredByPost.get(instagramPostUrl(post)) ?? 0
            )
        ),
        commentCoverage: targetCoverage(
            commentPosts,
            returnedCounts(comments),
            TARGET_COMMENT_LIMIT_PER_POST,
            post => post.commentsCount
        ),
    };
}

export function extractCandidateInteractions(
    accounts: CandidateAccountPosts[],
    likers: ApifyPostLiker[],
    targetUsername: string
): CandidateInteractionExtraction {
    const target = usernameKey(targetUsername);
    const postsByUrl = new Map<string, { candidateUsername: string; post: InstagramPost }>();
    for (const account of accounts) {
        const candidateUsername = usernameKey(account.username);
        for (const post of selectRecentInteractionPosts(
            account.posts,
            CANDIDATE_INTERACTION_POST_LIMIT
        )) {
            postsByUrl.set(instagramPostUrl(post), { candidateUsername, post });
        }
    }

    const evidence: InteractionEvidenceRow[] = [];
    for (const liker of likers) {
        const source = postsByUrl.get(liker.postUrl);
        if (!source || usernameKey(liker.username) !== target) continue;
        evidence.push({
            candidateUsername: source.candidateUsername,
            postId: source.post.id,
            signal: 'target_female_like',
            sourceInteractionId: liker.id,
        });
    }

    const counts = returnedCounts(likers);
    const declaredByPost = new Map<string, number>();
    for (const liker of likers) {
        declaredByPost.set(
            liker.postUrl,
            Math.max(declaredByPost.get(liker.postUrl) ?? 0, liker.totalLikes)
        );
    }
    const coverage = [...postsByUrl.entries()].map(([url, source]) => ({
        candidateUsername: source.candidateUsername,
        postId: source.post.id,
        declaredCount: Math.max(
            source.post.likesCount,
            declaredByPost.get(url) ?? 0
        ),
        returnedCount: counts.get(url) ?? 0,
        requestedLimit: CANDIDATE_LIKER_LIMIT_PER_POST,
    }));

    return { evidence, coverage };
}

export function scoreCandidateInteractions(input: {
    targetPosts: InstagramPost[];
    candidatePosts: InstagramPost[];
    candidateUsername: string;
    evidence: InteractionEvidenceRow[];
    targetLikeCoverage: StoredInteractionCoverage[];
    targetCommentCoverage: StoredInteractionCoverage[];
    candidateLikeCoverage: StoredInteractionCoverage[];
}): InteractionScoreResult {
    const candidateUsername = usernameKey(input.candidateUsername);
    const candidateEvidence = input.evidence.filter(
        row => usernameKey(row.candidateUsername) === candidateUsername
    );
    const targetPosts = selectRecentInteractionPosts(
        input.targetPosts,
        TARGET_COMMENT_POST_LIMIT
    );
    const targetLikePosts = targetPosts.slice(0, TARGET_LIKER_POST_LIMIT);
    const candidatePosts = selectRecentInteractionPosts(
        input.candidatePosts,
        CANDIDATE_INTERACTION_POST_LIMIT
    );

    return calculateInteractionScore({
        targetLikePostIds: targetLikePosts.map(post => post.id),
        targetCommentPostIds: targetPosts.map(post => post.id),
        candidatePostIds: candidatePosts.map(post => post.id),
        femaleLikedTargetPostIds: candidateEvidence
            .filter(row => row.signal === 'female_target_like')
            .map(row => row.postId),
        femaleCommentsOnTarget: candidateEvidence
            .filter(row => row.signal === 'female_target_comment')
            .map(row => ({ commentId: row.sourceInteractionId, postId: row.postId })),
        targetLikedFemalePostIds: candidateEvidence
            .filter(row => row.signal === 'target_female_like')
            .map(row => row.postId),
        targetLikeCoverage: input.targetLikeCoverage,
        targetCommentCoverage: input.targetCommentCoverage,
        candidateLikeCoverage: input.candidateLikeCoverage.filter(
            source => source.candidateUsername === candidateUsername
        ),
    });
}
