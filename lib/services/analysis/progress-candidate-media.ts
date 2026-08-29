import { z } from 'zod';
import type { AnalysisV2CheckpointProfile } from './v2-profile-fetch-store';

const MAX_FEED_IMAGES = 3;
const RAW_VIDEO_EXTENSION = /\.(?:3g2|3gp|avi|flv|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|ogv|ts|webm|wmv)$/i;

const candidateMediaUrlSchema = z.string().trim().min(1).max(8_192);
const candidateMediaItemSchema = z.object({
    type: z.enum(['image', 'video', 'reel']),
    imageUrl: candidateMediaUrlSchema.optional(),
    thumbnailUrl: candidateMediaUrlSchema.optional(),
    videoUrl: candidateMediaUrlSchema.optional(),
}).strict();
const candidateMediaPostSchema = z.object({
    type: z.enum(['image', 'video', 'carousel', 'reel']),
    imageUrl: candidateMediaUrlSchema.optional(),
    thumbnailUrl: candidateMediaUrlSchema.optional(),
    videoUrl: candidateMediaUrlSchema.optional(),
    mediaItems: z.array(candidateMediaItemSchema).max(20).optional(),
}).strict();

/**
 * The owner progress history only needs image-bearing fields. Keeping this
 * projection separate from the full checkpoint profile prevents the loader
 * from parsing or serializing names, bios, counts, and interaction data.
 */
export const analysisV2ProgressCandidateMediaProfileSchema = z.object({
    profilePicUrl: candidateMediaUrlSchema.optional(),
    latestPosts: z.array(candidateMediaPostSchema).max(8).optional(),
}).strict();

export type AnalysisV2ProgressCandidateMediaProfile = z.infer<
    typeof analysisV2ProgressCandidateMediaProfileSchema
>;

export interface AnalysisV2ProgressCandidateMediaPreview {
    profilePicUrl?: string;
    feedImageUrls: string[];
}

function displayImageUrl(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const candidate = value.trim();
    if (!candidate) return undefined;
    try {
        const url = new URL(candidate);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
        if (RAW_VIDEO_EXTENSION.test(decodeURIComponent(url.pathname))) return undefined;
        return candidate;
    } catch {
        return undefined;
    }
}

function canonicalUrlKey(value: string): string | undefined {
    try {
        const url = new URL(value);
        url.hash = '';
        url.searchParams.sort();
        return url.toString();
    } catch {
        return undefined;
    }
}

function displayImageCandidate(
    videoUrl: unknown,
    ...values: unknown[]
): string | undefined {
    const rawVideoUrlKey = typeof videoUrl === 'string'
        ? canonicalUrlKey(videoUrl.trim())
        : undefined;
    for (const value of values) {
        const candidate = displayImageUrl(value);
        const candidateKey = candidate ? canonicalUrlKey(candidate) : undefined;
        if (candidate && (!rawVideoUrlKey || candidateKey !== rawVideoUrlKey)) return candidate;
    }
    return undefined;
}

function carouselChildDisplayImage(
    post: NonNullable<AnalysisV2ProgressCandidateMediaProfile['latestPosts']>[number]
):
string | undefined {
    for (const item of post.mediaItems ?? []) {
        const imageUrl = item.type === 'video' || item.type === 'reel'
            ? displayImageCandidate(item.videoUrl, item.thumbnailUrl, item.imageUrl)
            : displayImageCandidate(item.videoUrl, item.imageUrl);
        if (imageUrl) return imageUrl;
    }
    return undefined;
}

function postDisplayImage(post: NonNullable<AnalysisV2ProgressCandidateMediaProfile['latestPosts']>[number]):
string | undefined {
    if (post.type === 'carousel') {
        return carouselChildDisplayImage(post)
            ?? displayImageCandidate(post.videoUrl, post.imageUrl, post.thumbnailUrl);
    }
    return post.type === 'video' || post.type === 'reel'
        ? displayImageCandidate(post.videoUrl, post.thumbnailUrl, post.imageUrl)
        : displayImageCandidate(post.videoUrl, post.imageUrl, post.thumbnailUrl);
}

/**
 * A bounded presentation-only projection of profile-fetch checkpoint data.
 * This mirrors the canonical policy's display-image preference: videos and
 * reels use thumbnails first and raw video URLs are never emitted.
 */
export function selectAnalysisV2ProgressCandidateMedia(
    profile: Pick<AnalysisV2CheckpointProfile, 'profilePicUrl' | 'latestPosts'>
        | AnalysisV2ProgressCandidateMediaProfile
        | null
        | undefined
): AnalysisV2ProgressCandidateMediaPreview {
    const profilePicUrl = displayImageUrl(profile?.profilePicUrl);
    const seen = new Set(profilePicUrl ? [canonicalUrlKey(profilePicUrl) ?? profilePicUrl] : []);
    const feedImageUrls: string[] = [];

    for (const post of profile?.latestPosts ?? []) {
        if (feedImageUrls.length === MAX_FEED_IMAGES) break;
        const imageUrl = postDisplayImage(post);
        const imageUrlKey = imageUrl ? canonicalUrlKey(imageUrl) : undefined;
        if (!imageUrl || !imageUrlKey || seen.has(imageUrlKey)) continue;
        seen.add(imageUrlKey);
        feedImageUrls.push(imageUrl);
    }

    return {
        ...(profilePicUrl ? { profilePicUrl } : {}),
        feedImageUrls,
    };
}
