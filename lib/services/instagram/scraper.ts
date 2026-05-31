import { ApifyClient } from 'apify-client';
import type { InstagramProfile, InstagramFollower, InstagramPost } from '@/lib/types/instagram';

const client = new ApifyClient({
    token: process.env.APIFY_API_TOKEN,
});

const RAPIDAPI_FOLLOWING_PATH = '/get_ig_user_followers_v2.php';

function getRapidApiConfig() {
    const key = process.env.RAPIDAPI_KEY;
    const host = process.env.RAPIDAPI_HOST;

    if (!key || !host) {
        throw new Error('SCRAPING_CONFIG_ERROR: RAPIDAPI_KEY와 RAPIDAPI_HOST가 설정되지 않았습니다.');
    }

    return {
        key,
        host,
        baseUrl: `https://${host}`,
    };
}

function extractUserList(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];

    const record = data as Record<string, unknown>;
    for (const key of ['data', 'users', 'items', 'followers', 'following']) {
        const value = record[key];
        if (Array.isArray(value)) return value;
    }

    if ('0' in record) {
        return Object.values(record);
    }

    return [];
}

function mapFollowerItem(item: unknown): InstagramFollower | null {
    if (!item || typeof item !== 'object') return null;

    const record = item as Record<string, unknown>;
    const user = record.user && typeof record.user === 'object'
        ? record.user as Record<string, unknown>
        : record;
    const username = user.username;

    if (typeof username !== 'string' || username.length === 0) {
        return null;
    }

    return {
        username,
        fullName: (user.full_name || user.fullName) as string | undefined,
        profilePicUrl: (user.profile_pic_url || user.profilePicUrl) as string | undefined,
        isPrivate: (user.is_private ?? user.isPrivate ?? false) as boolean,
        isVerified: (user.is_verified ?? user.isVerified ?? false) as boolean,
    };
}

/**
 * 인스타그램 프로필 정보를 수집합니다.
 * 공식 Actor: apify/instagram-profile-scraper
 */
export async function getInstagramProfile(username: string): Promise<InstagramProfile | null> {
    try {
        const run = await client.actor('apify/instagram-profile-scraper').call({
            usernames: [username],
        });

        if (run.status === 'ABORTED') {
            throw new Error('Scraping run aborted by user');
        }

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        if (items.length === 0) {
            return null;
        }

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

/**
 * 인스타그램 팔로워 목록을 수집합니다.
 * Actor: datadoping/instagram-followers-scraper
 */
export async function getFollowers(
    username: string,
    limit: number = 500
): Promise<InstagramFollower[]> {
    const run = await client.actor('datadoping/instagram-followers-scraper').call({
        usernames: [username],
        max_count: limit,
    });

    if (run.status === 'ABORTED') {
        throw new Error('스크래핑이 중단되었습니다.');
    }

    if (run.status === 'FAILED') {
        throw new Error('SCRAPING_ERROR: 팔로워 수집에 실패했습니다.');
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // 결과가 비어있으면 에러 (계정 접근 실패)
    if (items.length === 0) {
        throw new Error('SCRAPING_ERROR: 팔로워 목록을 가져올 수 없습니다. 계정 접근이 차단되었을 수 있습니다.');
    }

    return items.map((item: Record<string, unknown>) => ({
        username: item.username as string,
        fullName: item.full_name as string | undefined,
        profilePicUrl: item.profile_pic_url as string | undefined,
        isPrivate: item.is_private as boolean ?? false,
        isVerified: item.is_verified as boolean ?? false,
    }));
}

/**
 * 인스타그램 팔로잉 목록을 수집합니다.
 * RapidAPI 기반 수집. 개인 Instagram 쿠키는 사용하지 않습니다.
 */
export async function getFollowing(
    username: string,
    limit: number = 500
): Promise<InstagramFollower[]> {
    const { key, host, baseUrl } = getRapidApiConfig();
    const body = new URLSearchParams({
        username_or_url: username,
        data: 'following',
        amount: String(limit),
    });

    const response = await fetch(`${baseUrl}${RAPIDAPI_FOLLOWING_PATH}`, {
        method: 'POST',
        headers: {
            'x-rapidapi-key': key,
            'x-rapidapi-host': host,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    });

    const text = await response.text();
    let data: unknown = text;

    try {
        data = JSON.parse(text);
    } catch {
        // API 장애 시 HTML/text 응답이 올 수 있다.
    }

    if (!response.ok) {
        throw new Error(`SCRAPING_ERROR: 팔로잉 수집에 실패했습니다. HTTP ${response.status}`);
    }

    if (
        data &&
        typeof data === 'object' &&
        ('error' in data || 'message' in data)
    ) {
        const errorData = data as { error?: unknown; message?: unknown };
        throw new Error(`SCRAPING_ERROR: 팔로잉 수집에 실패했습니다. ${String(errorData.error || errorData.message)}`);
    }

    const items = extractUserList(data)
        .map(mapFollowerItem)
        .filter((item): item is InstagramFollower => item !== null)
        .slice(0, limit);

    if (items.length === 0) {
        throw new Error('SCRAPING_ERROR: 팔로잉 목록을 가져올 수 없습니다. 계정 접근이 제한되었을 수 있습니다.');
    }

    return items;
}

/**
 * latestPosts를 InstagramPost[] 형식으로 변환합니다.
 */
function parseLatestPosts(rawPosts: unknown[]): InstagramPost[] {
    if (!rawPosts || !Array.isArray(rawPosts)) return [];

    return rawPosts.slice(0, 10).map((item) => {
        const post = item as Record<string, unknown>;
        const type = (post.type as string)?.toLowerCase() || 'image';

        // mentions: 스크래퍼에서 이미 파싱해서 제공
        const rawMentions = post.mentions as string[] | undefined;
        const mentionedUsers = Array.isArray(rawMentions) ? rawMentions : [];

        // taggedUsers 추출
        const taggedUsers: string[] = [];
        const rawTaggedUsers = post.taggedUsers as Array<{ username?: string }> | undefined;
        if (rawTaggedUsers && Array.isArray(rawTaggedUsers)) {
            for (const user of rawTaggedUsers) {
                if (user.username) taggedUsers.push(user.username);
            }
        }

        return {
            id: post.id as string || '',
            shortCode: post.shortCode as string || '',
            caption: post.caption as string | undefined,
            hashtags: Array.isArray(post.hashtags) ? post.hashtags as string[] : [],
            imageUrl: post.displayUrl as string | undefined,
            videoUrl: post.videoUrl as string | undefined,
            type: type === 'video' ? 'video' : type === 'sidecar' ? 'carousel' : 'image',
            likesCount: post.likesCount as number || 0,
            commentsCount: post.commentsCount as number || 0,
            timestamp: post.timestamp as string || '',
            taggedUsers,
            mentionedUsers,
        } as InstagramPost;
    });
}

/**
 * 여러 계정의 프로필을 배치로 수집합니다.
 * latestPosts도 함께 반환합니다.
 */
export async function getProfilesBatch(
    usernames: string[],
    batchSize: number = 10
): Promise<InstagramProfile[]> {
    const results: InstagramProfile[] = [];

    for (let i = 0; i < usernames.length; i += batchSize) {
        const batch = usernames.slice(i, i + batchSize);

        try {
            const run = await client.actor('apify/instagram-profile-scraper').call({
                usernames: batch,
            });

            if (run.status === 'ABORTED') {
                throw new Error('Scraping run aborted by user');
            }

            const { items } = await client.dataset(run.defaultDatasetId).listItems();

            for (const item of items) {
                const profile = item as Record<string, unknown>;
                const latestPosts = parseLatestPosts(profile.latestPosts as unknown[]);

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
                    latestPosts,
                });
            }
        } catch (error) {
            console.error(`Failed to get profiles batch:`, error);
        }
    }

    return results;
}

/**
 * 맞팔 계정을 추출합니다.
 */
export function extractMutualFollows(
    followers: InstagramFollower[],
    following: InstagramFollower[]
): InstagramFollower[] {
    const followerSet = new Set(followers.map((f) => f.username));

    return following.filter((f) => followerSet.has(f.username));
}

/**
 * 공개/비공개 계정으로 분류합니다.
 */
export function classifyByPrivacy(accounts: InstagramFollower[]): {
    publicAccounts: InstagramFollower[];
    privateAccounts: InstagramFollower[];
} {
    const publicAccounts = accounts.filter((a) => !a.isPrivate);
    const privateAccounts = accounts.filter((a) => a.isPrivate);

    return { publicAccounts, privateAccounts };
}
