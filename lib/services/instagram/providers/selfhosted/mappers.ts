import type { InstagramProfile, InstagramPost } from '@/lib/types/instagram';
import { isInstagramUsername } from '../../username';
import { normalizeInstagramTimestamp } from '../../timestamp';

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

function mapPost(node: Record<string, unknown>): InstagramPost {
    const typename = node.__typename as string | undefined;
    const type: InstagramPost['type'] =
        typename === 'GraphVideo' || node.is_video === true
            ? 'video'
            : typename === 'GraphSidecar'
              ? 'carousel'
              : 'image';

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

    return {
        id: (node.id as string) || '',
        shortCode: (node.shortcode as string) || '',
        caption,
        hashtags: extractHashtags(caption),
        imageUrl: node.display_url as string | undefined,
        videoUrl: node.video_url as string | undefined,
        type,
        likesCount: likes,
        commentsCount: count(node, 'edge_media_to_comment'),
        timestamp: normalizeInstagramTimestamp(node.taken_at_timestamp),
        taggedUsers,
        mentionedUsers: extractMentions(caption),
    };
}

export function mapUserToProfile(user: Record<string, unknown>): InstagramProfile {
    if (
        typeof user.username !== 'string' ||
        !isInstagramUsername(user.username)
    ) {
        throw new Error('SCRAPING_SCHEMA_ERROR: selfhosted profile username이 올바르지 않습니다.');
    }
    const mediaEdges = (user.edge_owner_to_timeline_media as { edges?: Array<{ node?: Record<string, unknown> }> })?.edges;
    const latestPosts: InstagramPost[] = Array.isArray(mediaEdges)
        ? mediaEdges
              .slice(0, 10)
              .map((e) => (e?.node ? mapPost(e.node) : null))
              .filter((p): p is InstagramPost => p !== null)
        : [];

    return {
        username: user.username as string,
        fullName: user.full_name as string | undefined,
        bio: user.biography as string | undefined,
        externalUrl: user.external_url as string | undefined,
        profilePicUrl: (user.profile_pic_url_hd || user.profile_pic_url) as string | undefined,
        followersCount: requiredCount(user, 'edge_followed_by'),
        followingCount: requiredCount(user, 'edge_follow'),
        postsCount: count(user, 'edge_owner_to_timeline_media'),
        isPrivate: (user.is_private as boolean) ?? false,
        isVerified: (user.is_verified as boolean) ?? false,
        latestPosts,
    };
}
