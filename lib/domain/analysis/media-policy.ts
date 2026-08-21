export const MAX_RECENT_POSTS = 8;
export const MAX_FEED_MEDIA = 10;
export const MAX_TRIAGE_FEED_MEDIA = 4;
export const MAX_FEATURE_FEED_MEDIA = 10;
export const MAX_TRIAGE_MEDIA = MAX_TRIAGE_FEED_MEDIA + 1;
export const MAX_FEATURE_MEDIA = MAX_FEATURE_FEED_MEDIA + 1;
export const MAX_CAROUSEL_MEDIA = 20;
export const MAX_PARTNER_SAFETY_CONTACT_MEDIA = MAX_CAROUSEL_MEDIA - 3;

export type AnalysisPostMediaType = 'image' | 'video' | 'carousel' | 'reel';
export type AnalysisChildMediaType = 'image' | 'video' | 'reel';

export interface AnalysisMediaItemInput {
    /** Stable provider media identifier when one is available. */
    id?: string;
    type: AnalysisChildMediaType;
    imageUrl?: string;
    thumbnailUrl?: string;
    url?: string;
}

export interface AnalysisPostMediaInput {
    id: string;
    timestamp: string | number;
    type: AnalysisPostMediaType;
    imageUrl?: string;
    thumbnailUrl?: string;
    mediaItems?: readonly AnalysisMediaItemInput[];
    /** Provider-declared carousel child count. Required to claim complete coverage. */
    declaredMediaCount?: number;
    /** True only when every declared child was normalized into mediaItems. */
    childrenComplete?: boolean;
}

export interface AnalysisProfileMediaInput {
    /** Stable profile-media identifier when one is available. */
    id?: string;
    imageUrl?: string;
}

export type SelectedAnalysisMediaRole =
    | 'profile'
    | 'post_representative'
    | 'carousel_context'
    | 'partner_safety_contact';

export interface SelectedAnalysisMedia {
    selectionId: string;
    imageUrl: string;
    role: SelectedAnalysisMediaRole;
    postId?: string;
    postType?: AnalysisPostMediaType;
    mediaIndex?: number;
}

export interface AnalysisMediaSelectionSet {
    media: SelectedAnalysisMedia[];
    /** Ordered, deterministic input for a media-selection snapshot hash. */
    selectionIds: string[];
}

export interface AnalysisMediaPolicySelection {
    selectedPostIds: string[];
    feed: AnalysisMediaSelectionSet;
    triage: AnalysisMediaSelectionSet;
    feature: AnalysisMediaSelectionSet;
    partnerSafetyContactSheetCandidates: AnalysisMediaSelectionSet;
    carouselCoverage: AnalysisCarouselCoverage;
}

/**
 * v2.8 keeps the persisted v2.6/v2.7 selection byte-for-byte, but can opt into
 * spreading the fixed feed budget across complete carousels.  This is deliberately
 * an input-quality policy rather than a larger media budget.
 */
export interface AnalysisMediaSelectionOptions {
    carouselDiversity?: boolean;
    /** Candidate-only v2.11 input quality: keep carousel first/last context. */
    carouselEnds?: boolean;
}

export interface AnalysisCarouselPostCoverage {
    postId: string;
    declaredMediaCount: number | null;
    imageCapableChildCount: number;
    childrenComplete: boolean;
    coverage: number | null;
}

export interface AnalysisCarouselCoverage {
    posts: AnalysisCarouselPostCoverage[];
    incompletePostIds: string[];
}

export class AnalysisMediaPolicyError extends Error {
    constructor(
        public readonly code:
            | 'INVALID_CAROUSEL_METADATA'
            | 'CAROUSEL_COMPLETENESS_MISMATCH'
    ) {
        super(code);
        this.name = 'AnalysisMediaPolicyError';
    }
}

interface PostCandidate {
    selectionId: string;
    imageUrl: string;
    mediaIndex?: number;
}

function trimmed(value: string | undefined): string | undefined {
    const result = value?.trim();
    return result ? result : undefined;
}

function encodedId(value: string): string {
    return encodeURIComponent(value);
}

function timestampMs(value: string | number): number {
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(numeric)) {
        return Math.abs(numeric) < 10_000_000_000 ? numeric * 1_000 : numeric;
    }

    if (typeof value !== 'string') return Number.NEGATIVE_INFINITY;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareIds(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function selectRecentPosts(
    posts: readonly AnalysisPostMediaInput[]
): AnalysisPostMediaInput[] {
    const sorted = posts
        .filter(post => trimmed(post.id) !== undefined)
        .map(post => ({ post, id: post.id.trim(), time: timestampMs(post.timestamp) }))
        .sort((left, right) => right.time - left.time || compareIds(left.id, right.id));

    const seen = new Set<string>();
    const selected: AnalysisPostMediaInput[] = [];
    for (const item of sorted) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        selected.push({ ...item.post, id: item.id });
        if (selected.length === MAX_RECENT_POSTS) break;
    }
    return selected;
}

const RAW_VIDEO_EXTENSION = /\.(?:3g2|3gp|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|ogv|ts|webm|wmv)$/i;

function mediaPath(value: string): string {
    try {
        return decodeURIComponent(new URL(value).pathname);
    } catch {
        const path = value.split(/[?#]/, 1)[0];
        try {
            return decodeURIComponent(path);
        } catch {
            return path;
        }
    }
}

function firstDisplayImageUrl(...values: Array<string | undefined>): string | undefined {
    for (const value of values) {
        const candidate = trimmed(value);
        if (candidate && !RAW_VIDEO_EXTENSION.test(mediaPath(candidate))) return candidate;
    }
    return undefined;
}

function itemImageUrl(item: AnalysisMediaItemInput): string | undefined {
    if (item.type === 'image') {
        return firstDisplayImageUrl(item.imageUrl, item.url);
    }
    if (item.type === 'video' || item.type === 'reel') {
        return firstDisplayImageUrl(item.thumbnailUrl, item.imageUrl);
    }
    return undefined;
}

function childCandidates(post: AnalysisPostMediaInput): PostCandidate[] {
    const postId = encodedId(post.id);
    return (post.mediaItems ?? []).flatMap((item, index) => {
        const imageUrl = itemImageUrl(item);
        if (!imageUrl) return [];
        const itemId = trimmed(item.id);
        return [{
            selectionId: `post:${postId}:media:${index}:${encodedId(itemId ?? 'anonymous')}`,
            imageUrl,
            mediaIndex: index,
        }];
    });
}

function topLevelCandidate(post: AnalysisPostMediaInput): PostCandidate | undefined {
    const imageUrl = post.type === 'video' || post.type === 'reel'
        ? firstDisplayImageUrl(post.thumbnailUrl, post.imageUrl)
        : firstDisplayImageUrl(post.imageUrl, post.thumbnailUrl);
    if (!imageUrl) return undefined;
    return {
        selectionId: `post:${encodedId(post.id)}:thumbnail`,
        imageUrl,
    };
}

function postCandidates(post: AnalysisPostMediaInput): PostCandidate[] {
    const children = childCandidates(post);
    const topLevel = topLevelCandidate(post);

    if (post.type === 'carousel') {
        return children.length > 0 ? children : topLevel ? [topLevel] : [];
    }

    return topLevel ? [topLevel, ...children] : children;
}

function carouselCoverage(
    posts: readonly AnalysisPostMediaInput[]
): AnalysisCarouselCoverage {
    const coveragePosts: AnalysisCarouselPostCoverage[] = [];
    for (const post of posts) {
        if (post.type !== 'carousel') continue;
        const declaredMediaCount = post.declaredMediaCount;
        if (
            declaredMediaCount !== undefined
            && (
                !Number.isSafeInteger(declaredMediaCount)
                || declaredMediaCount < 1
                || declaredMediaCount > MAX_CAROUSEL_MEDIA
            )
        ) {
            throw new AnalysisMediaPolicyError('INVALID_CAROUSEL_METADATA');
        }

        const imageCapableChildCount = childCandidates(post).length;
        const normalizedChildCount = post.mediaItems?.length ?? 0;
        if (normalizedChildCount > MAX_CAROUSEL_MEDIA) {
            throw new AnalysisMediaPolicyError('INVALID_CAROUSEL_METADATA');
        }
        if (
            post.childrenComplete === true
            && (
                declaredMediaCount === undefined
                || declaredMediaCount !== normalizedChildCount
                || declaredMediaCount !== imageCapableChildCount
            )
        ) {
            throw new AnalysisMediaPolicyError('CAROUSEL_COMPLETENESS_MISMATCH');
        }

        const complete = post.childrenComplete === true;
        coveragePosts.push({
            postId: post.id,
            declaredMediaCount: declaredMediaCount ?? null,
            imageCapableChildCount,
            childrenComplete: complete,
            coverage: declaredMediaCount === undefined
                ? null
                : Math.min(1, imageCapableChildCount / declaredMediaCount),
        });
    }

    return {
        posts: coveragePosts,
        incompletePostIds: coveragePosts
            .filter(post => !post.childrenComplete)
            .map(post => post.postId),
    };
}

function asSelectedPostMedia(
    post: AnalysisPostMediaInput,
    candidate: PostCandidate,
    role: Exclude<SelectedAnalysisMediaRole, 'profile'>
): SelectedAnalysisMedia {
    return {
        selectionId: candidate.selectionId,
        imageUrl: candidate.imageUrl,
        role,
        postId: post.id,
        postType: post.type,
        ...(candidate.mediaIndex === undefined ? {} : { mediaIndex: candidate.mediaIndex }),
    };
}

function appendUnique(
    target: SelectedAnalysisMedia[],
    seenUrls: Set<string>,
    media: SelectedAnalysisMedia,
    limit: number
): void {
    if (target.length >= limit || seenUrls.has(media.imageUrl)) return;
    seenUrls.add(media.imageUrl);
    target.push(media);
}

function selectionSet(media: SelectedAnalysisMedia[]): AnalysisMediaSelectionSet {
    return {
        media,
        selectionIds: media.map(item => item.selectionId),
    };
}

function profileMedia(profile: AnalysisProfileMediaInput | undefined):
SelectedAnalysisMedia | undefined {
    const imageUrl = firstDisplayImageUrl(profile?.imageUrl);
    if (!imageUrl) return undefined;
    const stableId = trimmed(profile?.id) ?? imageUrl;
    return {
        selectionId: `profile:${encodedId(stableId)}`,
        imageUrl,
        role: 'profile',
    };
}

function selectForAnalysis(
    profile: SelectedAnalysisMedia | undefined,
    feedMedia: readonly SelectedAnalysisMedia[],
    feedLimit: number
): AnalysisMediaSelectionSet {
    const selected: SelectedAnalysisMedia[] = [];
    const seenUrls = new Set<string>();
    const totalLimit = feedLimit + Number(profile !== undefined);
    if (profile) appendUnique(selected, seenUrls, profile, totalLimit);

    let selectedFeedCount = 0;
    for (const media of feedMedia) {
        if (selectedFeedCount >= feedLimit || seenUrls.has(media.imageUrl)) continue;
        appendUnique(selected, seenUrls, media, totalLimit);
        selectedFeedCount += 1;
    }
    return selectionSet(selected);
}

/**
 * Applies the canonical media policy without depending on provider-specific post types.
 * Mappers may populate mediaItems later and pass their normalized shape directly here.
 */
export function selectAnalysisMedia(
    input: {
        profile?: AnalysisProfileMediaInput;
        posts: readonly AnalysisPostMediaInput[];
    },
    options: AnalysisMediaSelectionOptions = {},
): AnalysisMediaPolicySelection {
    const posts = selectRecentPosts(input.posts);
    const candidatesByPost = new Map(
        posts.map(post => [post.id, postCandidates(post)] as const)
    );
    const coverage = carouselCoverage(posts);
    const completeCarouselIds = new Set(
        coverage.posts
            .filter(post => post.childrenComplete)
            .map(post => post.postId)
    );
    const latestCarousel = posts.find(post => (
        post.type === 'carousel'
        && completeCarouselIds.has(post.id)
        && (candidatesByPost.get(post.id)?.length ?? 0) >= 3
    ));

    const representatives: SelectedAnalysisMedia[] = [];
    const representativeUrls = new Set<string>();
    for (const post of posts) {
        const representative = candidatesByPost.get(post.id)?.[0];
        if (!representative) continue;
        appendUnique(
            representatives,
            representativeUrls,
            asSelectedPostMedia(post, representative, 'post_representative'),
            MAX_RECENT_POSTS
        );
    }

    const feed: SelectedAnalysisMedia[] = [];
    const feedUrls = new Set<string>();
    for (const post of posts) {
        const candidates = candidatesByPost.get(post.id) ?? [];
        const representative = candidates[0];
        if (representative) {
            appendUnique(
                feed,
                feedUrls,
                asSelectedPostMedia(post, representative, 'post_representative'),
                MAX_FEED_MEDIA
            );
        }

        if (options.carouselEnds || options.carouselDiversity || post.id !== latestCarousel?.id) continue;
        const contextIndexes = [Math.floor(candidates.length / 2), candidates.length - 1];
        for (const index of contextIndexes) {
            const candidate = candidates[index];
            if (!candidate) continue;
            appendUnique(
                feed,
                feedUrls,
                asSelectedPostMedia(post, candidate, 'carousel_context'),
                MAX_FEED_MEDIA
            );
        }
    }

    if (options.carouselEnds || options.carouselDiversity) {
        // The representatives above preserve recency.  Fill any remaining fixed
        // capacity with carousel context views, round-robin by post recency, so a
        // meaningful person or logo later in a carousel is not systematically
        // invisible. Complete coverage is required just as it is for legacy
        // carousel context selection.
        const diverseCarousels = posts.filter(post => (
            post.type === 'carousel'
            && completeCarouselIds.has(post.id)
            && (candidatesByPost.get(post.id)?.length ?? 0) >= (options.carouselEnds ? 2 : 3)
        ));
        const diversityCandidates = [
            ...diverseCarousels.flatMap(post => {
                const candidates = candidatesByPost.get(post.id) ?? [];
                const candidate = options.carouselEnds
                    ? candidates[candidates.length - 1]
                    : candidates[Math.floor(candidates.length / 2)];
                return candidate
                    ? [asSelectedPostMedia(post, candidate, 'carousel_context')]
                    : [];
            }),
            ...(options.carouselEnds ? [] : diverseCarousels.flatMap(post => {
                const candidates = candidatesByPost.get(post.id) ?? [];
                const candidate = candidates[candidates.length - 1];
                return candidate ? [asSelectedPostMedia(post, candidate, 'carousel_context')] : [];
            })),
        ];
        for (const media of diversityCandidates) {
            appendUnique(feed, feedUrls, media, MAX_FEED_MEDIA);
        }
    }

    const profile = profileMedia(input.profile);
    const partnerSafetyContactMedia: SelectedAnalysisMedia[] = [];
    const partnerSafetyUrls = new Set<string>();
    if (latestCarousel) {
        const candidates = candidatesByPost.get(latestCarousel.id) ?? [];
        const featureIndexes = new Set([
            0,
            Math.floor(candidates.length / 2),
            candidates.length - 1,
        ]);
        for (const [index, candidate] of candidates.entries()) {
            if (featureIndexes.has(index)) continue;
            appendUnique(
                partnerSafetyContactMedia,
                partnerSafetyUrls,
                asSelectedPostMedia(latestCarousel, candidate, 'partner_safety_contact'),
                MAX_PARTNER_SAFETY_CONTACT_MEDIA
            );
        }
    }
    return {
        selectedPostIds: posts.map(post => post.id),
        feed: selectionSet(feed),
        triage: selectForAnalysis(profile, representatives, MAX_TRIAGE_FEED_MEDIA),
        feature: selectForAnalysis(profile, feed, MAX_FEATURE_FEED_MEDIA),
        partnerSafetyContactSheetCandidates: selectionSet(partnerSafetyContactMedia),
        carouselCoverage: coverage,
    };
}
