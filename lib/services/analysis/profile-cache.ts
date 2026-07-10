import type { CombinedProfileSnapshotAccount } from '@/lib/services/ai/combined-cache';
import type { InstagramProfile } from '@/lib/types/instagram';

export interface ProfileBatchAccount {
    username: string;
}

export interface ProfileStageAccount {
    profileSource: 'cache' | 'provider';
    profile: {
        username: string;
        profilePicUrl?: string;
        fullName?: string;
        bio?: string;
        isPrivate: boolean;
    };
    recentPosts: Array<{
        id: string;
        shortCode: string;
        caption?: string;
        hashtags: string[];
        imageUrl?: string;
        type: 'image' | 'video' | 'carousel' | 'reel';
        likesCount: number;
        commentsCount: number;
        timestamp: string;
        taggedUsers: string[];
        mentionedUsers: string[];
    }>;
}

function usernameKey(username: string): string {
    return username.trim().toLowerCase();
}

function assertUniqueBatch(batch: ProfileBatchAccount[]): Set<string> {
    const requested = new Set<string>();
    for (const account of batch) {
        const key = usernameKey(account.username);
        if (!/^[a-z0-9._]{1,30}$/.test(key)) {
            throw new Error('SCRAPING_CONFIG_ERROR: profiles batch username is invalid.');
        }
        if (requested.has(key)) {
            throw new Error('SCRAPING_CONFIG_ERROR: duplicate profiles batch username.');
        }
        requested.add(key);
    }
    return requested;
}

export function getProfileCacheMissUsernames(
    batch: ProfileBatchAccount[],
    cachedSnapshots: ReadonlyMap<string, CombinedProfileSnapshotAccount>
): string[] {
    assertUniqueBatch(batch);
    return batch
        .filter(account => !cachedSnapshots.has(usernameKey(account.username)))
        .map(account => account.username);
}

function mapScrapedProfile(profile: InstagramProfile): ProfileStageAccount {
    const displayBio = profile.bio || profile.externalUrl;
    return {
        profileSource: 'provider',
        profile: {
            username: profile.username,
            ...(profile.profilePicUrl ? { profilePicUrl: profile.profilePicUrl } : {}),
            ...(profile.fullName ? { fullName: profile.fullName } : {}),
            ...(displayBio ? { bio: displayBio } : {}),
            isPrivate: profile.isPrivate,
        },
        recentPosts: (profile.latestPosts ?? []).map(post => ({
            id: post.id,
            shortCode: post.shortCode,
            ...(post.caption ? { caption: post.caption } : {}),
            hashtags: post.hashtags ?? [],
            ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
            type: post.type,
            likesCount: Math.max(0, post.likesCount),
            commentsCount: Math.max(0, post.commentsCount),
            timestamp: post.timestamp,
            taggedUsers: post.taggedUsers,
            mentionedUsers: post.mentionedUsers,
        })),
    };
}

export function mergeCachedAndScrapedProfiles(
    batch: ProfileBatchAccount[],
    cachedSnapshots: ReadonlyMap<string, CombinedProfileSnapshotAccount>,
    scrapedProfiles: InstagramProfile[]
): ProfileStageAccount[] {
    const requested = assertUniqueBatch(batch);
    const missing = new Set(
        [...requested].filter(key => !cachedSnapshots.has(key))
    );
    const scrapedByUsername = new Map<string, InstagramProfile>();

    for (const profile of scrapedProfiles) {
        const key = usernameKey(profile.username);
        if (!missing.has(key)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: unexpected profiles batch result.');
        }
        if (scrapedByUsername.has(key)) {
            throw new Error('SCRAPING_SCHEMA_ERROR: duplicate profiles batch result.');
        }
        scrapedByUsername.set(key, profile);
    }

    const absent = [...missing].filter(key => !scrapedByUsername.has(key));
    if (absent.length > 0) {
        throw new Error(
            `SCRAPING_INCOMPLETE_ERROR: profiles batch omitted ${absent.length} requested account(s).`
        );
    }

    return batch.map((account) => {
        const key = usernameKey(account.username);
        const cached = cachedSnapshots.get(key);
        if (cached) {
            if (usernameKey(cached.profile.username) !== key) {
                throw new Error('CACHE_SCHEMA_ERROR: profile snapshot username mismatch.');
            }
            return { ...cached, profileSource: 'cache' };
        }

        const scraped = scrapedByUsername.get(key);
        if (!scraped) {
            throw new Error('SCRAPING_INCOMPLETE_ERROR: profile missing after merge.');
        }
        return mapScrapedProfile(scraped);
    });
}
