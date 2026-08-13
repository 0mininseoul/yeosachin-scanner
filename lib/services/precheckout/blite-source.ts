import 'server-only';
import { Buffer } from 'node:buffer';
import { z } from 'zod';
import {
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    matchesAllowedHostSuffix,
} from '@/lib/services/media/secure-image-fetch';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';

export const PRECHECKOUT_BLITE_SOURCE_SCHEMA_VERSION = 1 as const;
export const PRECHECKOUT_BLITE_SOURCE_MAX_BYTES = 256 * 1024;
export const PRECHECKOUT_BLITE_SOURCE_MAX_POSTS = 10;
export const PRECHECKOUT_BLITE_SOURCE_MAX_CAPTION_LENGTH = 160;
export const PRECHECKOUT_BLITE_SOURCE_MAX_HASHTAGS = 15;
export const PRECHECKOUT_BLITE_SOURCE_MAX_HASHTAG_LENGTH = 100;
export const PRECHECKOUT_BLITE_SOURCE_MAX_USERNAMES = 15;
export const PRECHECKOUT_BLITE_SOURCE_MAX_USERNAME_LENGTH = 30;
export const PRECHECKOUT_BLITE_SOURCE_MAX_MEDIA = 4;
export const PRECHECKOUT_BLITE_SOURCE_MAX_URL_LENGTH = 8_192;
export const PRECHECKOUT_BLITE_SOURCE_MAX_FULL_NAME_LENGTH = 60;

const MAX_INSTAGRAM_COUNT = 10_000_000;
const MAX_CAROUSEL_DEPTH = 20;
const INSTAGRAM_USERNAME_PATTERN = /^[A-Za-z0-9._]+$/u;
const RAW_VIDEO_EXTENSION = /\.(?:m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/iu;

export type PrecheckoutBliteSourceErrorCode =
    | 'PRECHECKOUT_BLITE_SOURCE_INVALID'
    | 'PRECHECKOUT_BLITE_SOURCE_TOO_LARGE';

function isAllowedMediaUrl(value: string): boolean {
    if (value.length === 0 || value.length > PRECHECKOUT_BLITE_SOURCE_MAX_URL_LENGTH) {
        return false;
    }

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return false;
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, '');
    if (
        parsed.protocol !== 'https:'
        || parsed.username
        || parsed.password
        || (parsed.port && parsed.port !== '443')
        || !INSTAGRAM_MEDIA_HOST_SUFFIXES.some(suffix => matchesAllowedHostSuffix(hostname, suffix))
    ) {
        return false;
    }

    return !RAW_VIDEO_EXTENSION.test(parsed.pathname);
}

const mediaUrlSchema = z.string()
    .trim()
    .min(1)
    .max(PRECHECKOUT_BLITE_SOURCE_MAX_URL_LENGTH)
    .refine(isAllowedMediaUrl, 'media URL must use an accepted HTTPS Instagram/Apify host');

const sourceUsernameSchema = z.string()
    .trim()
    .min(1)
    .max(PRECHECKOUT_BLITE_SOURCE_MAX_USERNAME_LENGTH)
    .regex(INSTAGRAM_USERNAME_PATTERN);

const sourceCountSchema = z.number()
    .int()
    .nonnegative()
    .max(MAX_INSTAGRAM_COUNT);

const bliteSourcePostSchema = z.object({
    type: z.enum(['image', 'video', 'carousel', 'reel']),
    captionExcerpt: z.string().max(PRECHECKOUT_BLITE_SOURCE_MAX_CAPTION_LENGTH).nullable(),
    hashtags: z.array(z.string().max(PRECHECKOUT_BLITE_SOURCE_MAX_HASHTAG_LENGTH))
        .max(PRECHECKOUT_BLITE_SOURCE_MAX_HASHTAGS),
    carouselDepth: z.number().int().positive().max(MAX_CAROUSEL_DEPTH).nullable(),
    likesCount: sourceCountSchema.nullable(),
    likesHidden: z.boolean(),
    commentsCount: sourceCountSchema.nullable(),
    commentsHidden: z.boolean(),
    taggedUsernames: z.array(sourceUsernameSchema).max(PRECHECKOUT_BLITE_SOURCE_MAX_USERNAMES),
    mentionedUsernames: z.array(sourceUsernameSchema).max(PRECHECKOUT_BLITE_SOURCE_MAX_USERNAMES),
}).strict().superRefine((value, context) => {
    if (value.likesHidden !== (value.likesCount === null)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'likes hidden state must match its persisted count',
            path: ['likesCount'],
        });
    }
    if (value.commentsHidden !== (value.commentsCount === null)) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'comments hidden state must match its persisted count',
            path: ['commentsCount'],
        });
    }
    if (value.type !== 'carousel' && value.carouselDepth !== null) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'non-carousel posts cannot carry a carousel depth',
            path: ['carouselDepth'],
        });
    }
});

const bliteSourceMediaSchema = z.object({
    role: z.enum(['profile', 'post']),
    url: mediaUrlSchema,
}).strict();

export const precheckoutBliteSourceV1Schema = z.object({
    schemaVersion: z.literal(PRECHECKOUT_BLITE_SOURCE_SCHEMA_VERSION),
    fullName: z.string().max(PRECHECKOUT_BLITE_SOURCE_MAX_FULL_NAME_LENGTH).nullable(),
    posts: z.array(bliteSourcePostSchema).max(PRECHECKOUT_BLITE_SOURCE_MAX_POSTS),
    media: z.array(bliteSourceMediaSchema).max(PRECHECKOUT_BLITE_SOURCE_MAX_MEDIA),
}).strict().superRefine((value, context) => {
    const profileEntries = value.media.filter(media => media.role === 'profile');
    if (profileEntries.length > 1 || (profileEntries.length === 1 && value.media[0]?.role !== 'profile')) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'profile media must be first and unique',
            path: ['media'],
        });
    }
});

export type PrecheckoutBliteSourceV1 = z.infer<typeof precheckoutBliteSourceV1Schema>;

function sourceError(code: PrecheckoutBliteSourceErrorCode): Error {
    return new Error(code);
}

function boundedText(value: string | undefined, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const collapsed = value.replace(/\s+/gu, ' ').trim();
    if (!collapsed) return null;
    return collapsed.slice(0, maxLength);
}

function boundedHashtags(values: readonly string[] | undefined): string[] {
    return (values ?? [])
        .slice(0, PRECHECKOUT_BLITE_SOURCE_MAX_HASHTAGS)
        .map(value => boundedText(value, PRECHECKOUT_BLITE_SOURCE_MAX_HASHTAG_LENGTH))
        .filter((value): value is string => value !== null);
}

function boundedUsernames(values: readonly string[] | undefined): string[] {
    return (values ?? [])
        .slice(0, PRECHECKOUT_BLITE_SOURCE_MAX_USERNAMES)
        .map(value => typeof value === 'string' ? value.trim() : '')
        .filter(value => (
            value.length > 0
            && value.length <= PRECHECKOUT_BLITE_SOURCE_MAX_USERNAME_LENGTH
            && INSTAGRAM_USERNAME_PATTERN.test(value)
        ));
}

function carouselDepth(post: InstagramPost): number | null {
    if (post.type !== 'carousel') return null;
    return post.declaredMediaCount ?? post.mediaItems?.length ?? null;
}

function projectPost(post: InstagramPost) {
    return {
        type: post.type,
        captionExcerpt: boundedText(post.caption, PRECHECKOUT_BLITE_SOURCE_MAX_CAPTION_LENGTH),
        hashtags: boundedHashtags(post.hashtags),
        carouselDepth: carouselDepth(post),
        likesCount: post.likesCountHidden === true ? null : post.likesCount,
        likesHidden: post.likesCountHidden === true,
        commentsCount: post.commentsCountHidden === true ? null : post.commentsCount,
        commentsHidden: post.commentsCountHidden === true,
        taggedUsernames: boundedUsernames(post.taggedUsers),
        mentionedUsernames: boundedUsernames(post.mentionedUsers),
    };
}

function mediaReference(value: string | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return isAllowedMediaUrl(trimmed) ? trimmed : null;
}

function projectMedia(profile: InstagramProfile, posts: readonly InstagramPost[]) {
    const media: Array<{ role: 'profile' | 'post'; url: string }> = [];
    const seen = new Set<string>();
    const profileUrl = mediaReference(profile.profilePicUrl);
    if (profileUrl) {
        media.push({ role: 'profile', url: profileUrl });
        seen.add(profileUrl);
    }

    for (const post of posts) {
        if (media.length >= PRECHECKOUT_BLITE_SOURCE_MAX_MEDIA) break;
        const postUrl = mediaReference(post.imageUrl) ?? mediaReference(post.thumbnailUrl);
        if (!postUrl || seen.has(postUrl)) continue;
        media.push({ role: 'post', url: postUrl });
        seen.add(postUrl);
    }

    return media;
}

/**
 * Project the one collection's validated profile snapshot into the short-lived B-lite evidence
 * contract. It intentionally has no identity/lineage columns: those are fenced separately by
 * the source table RPC and never live in the JSON payload.
 */
export function projectPrecheckoutBliteSource(profile: InstagramProfile): PrecheckoutBliteSourceV1 {
    const recentPosts = (profile.latestPosts ?? []).slice(0, PRECHECKOUT_BLITE_SOURCE_MAX_POSTS);
    const parsed = precheckoutBliteSourceV1Schema.safeParse({
        schemaVersion: PRECHECKOUT_BLITE_SOURCE_SCHEMA_VERSION,
        fullName: boundedText(profile.fullName, PRECHECKOUT_BLITE_SOURCE_MAX_FULL_NAME_LENGTH),
        posts: recentPosts.map(projectPost),
        media: projectMedia(profile, recentPosts),
    });
    if (!parsed.success) throw sourceError('PRECHECKOUT_BLITE_SOURCE_INVALID');

    const bytes = Buffer.byteLength(JSON.stringify(parsed.data), 'utf8');
    if (bytes > PRECHECKOUT_BLITE_SOURCE_MAX_BYTES) {
        throw sourceError('PRECHECKOUT_BLITE_SOURCE_TOO_LARGE');
    }
    return parsed.data;
}
