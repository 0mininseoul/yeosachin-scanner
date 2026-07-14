import type {
    InstagramPostMediaItem,
    InstagramProfile,
    InstagramPost,
} from '@/lib/types/instagram';
import { MAX_RECENT_POSTS } from '@/lib/domain/analysis/media-policy';
import { isInstagramUsername } from '../../username';
import { normalizeInstagramTimestamp } from '../../timestamp';

export interface SelfHostedAdmissionProfileSummary {
    username: string;
    followersCount: number;
    followingCount: number;
    isPrivate: boolean;
}

export function extractHashtags(caption?: string): string[] {
    if (!caption) return [];
    return (caption.match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => t.slice(1));
}

export function extractMentions(caption?: string): string[] {
    if (!caption) return [];
    return (caption.match(/@[A-Za-z0-9._]+/g) || []).map((m) => m.slice(1));
}

function num(value: unknown): number {
    return typeof value === 'number' ? value : 0;
}

function count(node: Record<string, unknown>, key: string): number {
    const edge = node[key] as { count?: unknown } | undefined;
    return num(edge?.count);
}

function requiredCount(node: Record<string, unknown>, key: string): number {
    const edge = node[key];
    const value = edge && typeof edge === 'object'
        ? (edge as Record<string, unknown>).count
        : undefined;
    if (!Number.isInteger(value) || (value as number) < 0) {
        throw new Error(`SCRAPING_SCHEMA_ERROR: ${key}.count가 0 이상의 정수가 아닙니다.`);
    }
    return value as number;
}

const MAX_CAROUSEL_CHILDREN = 20;
const RAW_VIDEO_EXTENSION = /\.(?:m4v|mkv|mov|mp4|mpeg|mpg|ogv|webm)$/i;

function nonEmptyString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

function mediaPath(value: string): string {
    try {
        return decodeURIComponent(new URL(value).pathname);
    } catch {
        return value.split(/[?#]/, 1)[0];
    }
}

function displayImageUrl(...values: unknown[]): string | undefined {
    for (const value of values) {
        const candidate = nonEmptyString(value);
        if (candidate && !RAW_VIDEO_EXTENSION.test(mediaPath(candidate))) return candidate;
    }
    return undefined;
}

function postMediaType(node: Record<string, unknown>): InstagramPost['type'] {
    const typename = nonEmptyString(node.__typename);
    const isVideo = node.is_video;
    const productType = nonEmptyString(node.product_type)?.toLowerCase();
    const isExplicitReel = productType === 'clips' || productType === 'reel' || productType === 'reels';

    if (typename === 'GraphVideo' && isVideo === false) {
        throw new Error('SCRAPING_SCHEMA_ERROR: GraphVideo의 is_video 필드가 서로 모순됩니다.');
    }
    if (typename === 'GraphImage' && isVideo === true) {
        throw new Error('SCRAPING_SCHEMA_ERROR: GraphImage의 is_video 필드가 서로 모순됩니다.');
    }
    if (typename === 'GraphSidecar') {
        if (isVideo === true || isExplicitReel) {
            throw new Error('SCRAPING_SCHEMA_ERROR: GraphSidecar의 비디오 필드가 서로 모순됩니다.');
        }
        return 'carousel';
    }

    if (typename === 'GraphVideo' || isVideo === true) {
        return isExplicitReel ? 'reel' : 'video';
    }

    if (typename === 'GraphImage' || isVideo === false) {
        if (isExplicitReel) {
            throw new Error('SCRAPING_SCHEMA_ERROR: 이미지 게시물의 product_type이 서로 모순됩니다.');
        }
        return 'image';
    }

    throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted 게시물 미디어 타입을 판별할 수 없습니다.');
}

function mapChildMedia(node: unknown): InstagramPostMediaItem | null {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
    const value = node as Record<string, unknown>;

    let type: InstagramPostMediaItem['type'];
    try {
        const mapped = postMediaType(value);
        if (mapped === 'carousel') return null;
        type = mapped;
    } catch {
        return null;
    }

    const id = nonEmptyString(value.id);
    const videoUrl = nonEmptyString(value.video_url);
    const candidateThumbnail = displayImageUrl(value.display_url, value.thumbnail_src);
    const thumbnailUrl = candidateThumbnail === videoUrl ? undefined : candidateThumbnail;
    if (!thumbnailUrl || (type === 'image' && videoUrl)) return null;
    return type === 'image'
        ? {
            ...(id ? { id } : {}),
            type,
            imageUrl: thumbnailUrl,
        }
        : {
            ...(id ? { id } : {}),
            type,
            thumbnailUrl,
            ...(videoUrl ? { videoUrl } : {}),
        };
}

function mapSidecarChildren(node: Record<string, unknown>): Pick<
    InstagramPost,
    'mediaItems' | 'declaredMediaCount' | 'childrenComplete'
> {
    const connection = node.edge_sidecar_to_children;
    if (!connection || typeof connection !== 'object' || Array.isArray(connection)) {
        return { mediaItems: [], childrenComplete: false };
    }

    const value = connection as Record<string, unknown>;
    const edges = Array.isArray(value.edges) ? value.edges : [];
    const mediaItems = edges
        .slice(0, MAX_CAROUSEL_CHILDREN)
        .map((edge) => {
            if (!edge || typeof edge !== 'object' || Array.isArray(edge)) return null;
            return mapChildMedia((edge as Record<string, unknown>).node);
        })
        .filter((item): item is InstagramPostMediaItem => item !== null);
    const count = value.count;
    const declaredMediaCount = Number.isSafeInteger(count)
        && (count as number) >= 1
        && (count as number) <= MAX_CAROUSEL_CHILDREN
        ? count as number
        : undefined;
    const childrenComplete = declaredMediaCount !== undefined
        && edges.length === declaredMediaCount
        && mediaItems.length === declaredMediaCount;

    return {
        mediaItems,
        ...(declaredMediaCount === undefined ? {} : { declaredMediaCount }),
        childrenComplete,
    };
}

function mapPost(node: Record<string, unknown>): InstagramPost {
    const type = postMediaType(node);
    const id = nonEmptyString(node.id);
    const shortCode = nonEmptyString(node.shortcode);
    if (!id || !shortCode) {
        throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted 게시물 id 또는 shortcode가 없습니다.');
    }

    const captionEdges = (node.edge_media_to_caption as { edges?: Array<{ node?: { text?: unknown } }> })?.edges;
    const caption =
        Array.isArray(captionEdges) && captionEdges[0]?.node?.text
            ? String(captionEdges[0].node.text)
            : undefined;

    const taggedEdges = (node.edge_media_to_tagged_user as { edges?: Array<{ node?: { user?: { username?: unknown } } }> })?.edges;
    const taggedUsers: string[] = [];
    if (Array.isArray(taggedEdges)) {
        for (const e of taggedEdges) {
            const u = e?.node?.user?.username;
            if (typeof u === 'string') taggedUsers.push(u);
        }
    }

    const likes = count(node, 'edge_media_preview_like') || count(node, 'edge_liked_by');
    const videoUrl = nonEmptyString(node.video_url);
    const candidateThumbnail = displayImageUrl(node.display_url, node.thumbnail_src);
    const thumbnailUrl = candidateThumbnail === videoUrl ? undefined : candidateThumbnail;
    if ((type === 'image' || type === 'carousel') && videoUrl) {
        throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted 게시물 type과 video_url이 서로 모순됩니다.');
    }
    if (!thumbnailUrl) {
        throw new Error('SCRAPING_INCOMPLETE_ERROR: selfhosted 게시물에 사용 가능한 이미지가 없습니다.');
    }

    return {
        id,
        shortCode,
        caption,
        hashtags: extractHashtags(caption),
        imageUrl: thumbnailUrl,
        ...(type === 'video' || type === 'reel' ? { thumbnailUrl } : {}),
        ...(videoUrl ? { videoUrl } : {}),
        type,
        ...(type === 'carousel' ? mapSidecarChildren(node) : {}),
        likesCount: likes,
        commentsCount: count(node, 'edge_media_to_comment'),
        timestamp: normalizeInstagramTimestamp(node.taken_at_timestamp),
        taggedUsers,
        mentionedUsers: extractMentions(caption),
    };
}

export function mapUserToProfileSummary(user: Record<string, unknown>): InstagramProfile {
    if (
        typeof user.username !== 'string' ||
        !isInstagramUsername(user.username)
    ) {
        throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted profile username이 올바르지 않습니다.');
    }
    const postsCount = requiredCount(user, 'edge_owner_to_timeline_media');
    const isPrivate = user.is_private;
    if (typeof isPrivate !== 'boolean') {
        throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted profile is_private가 boolean이 아닙니다.');
    }
    return {
        username: user.username,
        fullName: user.full_name as string | undefined,
        bio: user.biography as string | undefined,
        externalUrl: user.external_url as string | undefined,
        profilePicUrl: (user.profile_pic_url_hd || user.profile_pic_url) as string | undefined,
        followersCount: requiredCount(user, 'edge_followed_by'),
        followingCount: requiredCount(user, 'edge_follow'),
        postsCount,
        isPrivate,
        isVerified: (user.is_verified as boolean) ?? false,
    };
}

export function mapUserToAdmissionProfileSummary(
    user: Record<string, unknown>
): SelfHostedAdmissionProfileSummary {
    if (
        typeof user.username !== 'string'
        || !isInstagramUsername(user.username)
    ) {
        throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted admission username이 올바르지 않습니다.');
    }
    if (typeof user.is_private !== 'boolean') {
        throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted admission is_private가 boolean이 아닙니다.');
    }
    return {
        username: user.username,
        followersCount: requiredCount(user, 'edge_followed_by'),
        followingCount: requiredCount(user, 'edge_follow'),
        isPrivate: user.is_private,
    };
}

export function mapUserToProfile(user: Record<string, unknown>): InstagramProfile {
    const summary = mapUserToProfileSummary(user);
    const mediaEdges = (user.edge_owner_to_timeline_media as { edges?: Array<{ node?: Record<string, unknown> }> })?.edges;
    const latestPosts: InstagramPost[] = Array.isArray(mediaEdges)
        ? mediaEdges
              .slice(0, 10)
              .map((edge) => {
                  if (!edge?.node) {
                      throw new Error(
                          'SCRAPING_SCHEMA_ERROR: selfhosted timeline edge에 게시물 node가 없습니다.'
                      );
                  }
                  return mapPost(edge.node);
              })
        : [];
    if (!summary.isPrivate && summary.postsCount > 0 && latestPosts.length === 0) {
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: selfhosted public profile has posts but no usable timeline media.'
        );
    }
    const requiredRecentPosts = Math.min(summary.postsCount, MAX_RECENT_POSTS);
    if (!summary.isPrivate && latestPosts.length < requiredRecentPosts) {
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: selfhosted public profile recent-post snapshot is incomplete.'
        );
    }
    if (
        !summary.isPrivate
        && latestPosts.some(post => post.type === 'carousel' && post.childrenComplete !== true)
    ) {
        throw new Error(
            'SCRAPING_INCOMPLETE_ERROR: selfhosted public profile carousel children are incomplete.'
        );
    }

    return {
        ...summary,
        latestPosts,
    };
}
