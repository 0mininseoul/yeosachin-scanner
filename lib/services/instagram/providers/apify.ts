import { ApifyClient } from 'apify-client';
import type { InstagramProfile, InstagramFollower, InstagramPost } from '@/lib/types/instagram';
import type { ScraperProvider } from './types';

const client = new ApifyClient({ token: process.env.APIFY_API_TOKEN });

/** latestPosts를 InstagramPost[] 형식으로 변환 (기존 scraper.ts에서 이동) */
function parseLatestPosts(rawPosts: unknown[]): InstagramPost[] {
    if (!rawPosts || !Array.isArray(rawPosts)) return [];

    return rawPosts.slice(0, 10).map((item) => {
        const post = item as Record<string, unknown>;
        const type = (post.type as string)?.toLowerCase() || 'image';

        const rawMentions = post.mentions as string[] | undefined;
        const mentionedUsers = Array.isArray(rawMentions) ? rawMentions : [];

        const taggedUsers: string[] = [];
        const rawTaggedUsers = post.taggedUsers as Array<{ username?: string }> | undefined;
        if (rawTaggedUsers && Array.isArray(rawTaggedUsers)) {
            for (const user of rawTaggedUsers) {
                if (user.username) taggedUsers.push(user.username);
            }
        }

        return {
            id: (post.id as string) || '',
            shortCode: (post.shortCode as string) || '',
            caption: post.caption as string | undefined,
            hashtags: Array.isArray(post.hashtags) ? (post.hashtags as string[]) : [],
            imageUrl: post.displayUrl as string | undefined,
            videoUrl: post.videoUrl as string | undefined,
            type: type === 'video' ? 'video' : type === 'sidecar' ? 'carousel' : 'image',
            likesCount: (post.likesCount as number) || 0,
            commentsCount: (post.commentsCount as number) || 0,
            timestamp: (post.timestamp as string) || '',
            taggedUsers,
            mentionedUsers,
        } as InstagramPost;
    });
}

async function getProfile(username: string): Promise<InstagramProfile | null> {
    try {
        const run = await client.actor('apify/instagram-profile-scraper').call({
            usernames: [username],
        });
        if (run.status === 'ABORTED') throw new Error('Scraping run aborted by user');

        const { items } = await client.dataset(run.defaultDatasetId).listItems();
        if (items.length === 0) return null;

        const profile = items[0] as Record<string, unknown>;
        return {
            username: profile.username as string,
            fullName: profile.fullName as string | undefined,
            bio: profile.biography as string | undefined,
            profilePicUrl: profile.profilePicUrl as string | undefined,
            followersCount: profile.followersCount as number,
            followingCount: profile.followsCount as number,
            postsCount: profile.postsCount as number,
            isPrivate: profile.private as boolean,
            isVerified: profile.verified as boolean,
        };
    } catch (error) {
        console.error(`Failed to get profile for ${username}:`, error);
        return null;
    }
}

async function getFollowers(username: string, limit: number = 500): Promise<InstagramFollower[]> {
    const run = await client.actor('datadoping/instagram-followers-scraper').call({
        usernames: [username],
        max_count: limit,
    });
    if (run.status === 'ABORTED') throw new Error('스크래핑이 중단되었습니다.');
    if (run.status === 'FAILED') throw new Error('SCRAPING_ERROR: 팔로워 수집에 실패했습니다.');

    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    if (items.length === 0) {
        throw new Error('SCRAPING_ERROR: 팔로워 목록을 가져올 수 없습니다. 계정 접근이 차단되었을 수 있습니다.');
    }

    return items.map((item: Record<string, unknown>) => ({
        username: item.username as string,
        fullName: item.full_name as string | undefined,
        profilePicUrl: item.profile_pic_url as string | undefined,
        isPrivate: (item.is_private as boolean) ?? false,
        isVerified: (item.is_verified as boolean) ?? false,
    }));
}

async function getProfilesBatch(usernames: string[], batchSize: number = 10): Promise<InstagramProfile[]> {
    const results: InstagramProfile[] = [];

    for (let i = 0; i < usernames.length; i += batchSize) {
        const batch = usernames.slice(i, i + batchSize);
        try {
            const run = await client.actor('apify/instagram-profile-scraper').call({ usernames: batch });
            if (run.status === 'ABORTED') throw new Error('Scraping run aborted by user');

            const { items } = await client.dataset(run.defaultDatasetId).listItems();
            for (const item of items) {
                const profile = item as Record<string, unknown>;
                results.push({
                    username: profile.username as string,
                    fullName: profile.fullName as string | undefined,
                    bio: profile.biography as string | undefined,
                    externalUrl: profile.externalUrl as string | undefined,
                    profilePicUrl: profile.profilePicUrl as string | undefined,
                    followersCount: profile.followersCount as number,
                    followingCount: profile.followsCount as number,
                    postsCount: profile.postsCount as number,
                    isPrivate: profile.private as boolean,
                    isVerified: profile.verified as boolean,
                    latestPosts: parseLatestPosts(profile.latestPosts as unknown[]),
                });
            }
        } catch (error) {
            console.error('Failed to get profiles batch:', error);
        }
    }
    return results;
}

export const apifyProvider: ScraperProvider = {
    name: 'apify',
    getProfile,
    getFollowers,
    getProfilesBatch,
};
