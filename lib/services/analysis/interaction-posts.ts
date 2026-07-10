import type { InstagramPost } from '@/lib/types/instagram';
import { instagramTimestampMs } from '@/lib/services/instagram/timestamp';

const INSTAGRAM_SHORTCODE_PATTERN = /^[A-Za-z0-9_-]{5,64}$/;

export function instagramPostUrl(post: Pick<InstagramPost, 'shortCode' | 'type'>): string {
    if (!INSTAGRAM_SHORTCODE_PATTERN.test(post.shortCode)) {
        throw new Error('INTERACTION_POST_ERROR: invalid Instagram shortcode.');
    }
    const path = post.type === 'reel' ? 'reel' : 'p';
    return `https://www.instagram.com/${path}/${post.shortCode}/`;
}

/** Sort by actual publication time so an old pinned post cannot displace a newer post. */
export function selectRecentInteractionPosts(
    posts: InstagramPost[],
    limit: number
): InstagramPost[] {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 10) {
        throw new Error('INTERACTION_POST_ERROR: post limit must be an integer from 0 to 10.');
    }

    const seen = new Set<string>();
    return posts
        .map((post, index) => ({
            post,
            index,
            timestamp: instagramTimestampMs(post.timestamp),
        }))
        .filter(({ post }) => {
            if (!post.id.trim() || !INSTAGRAM_SHORTCODE_PATTERN.test(post.shortCode)) return false;
            const key = post.shortCode.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .sort((a, b) => b.timestamp - a.timestamp || a.index - b.index)
        .slice(0, limit)
        .map(({ post }) => post);
}
