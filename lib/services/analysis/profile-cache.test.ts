import { describe, expect, it } from 'vitest';
import type { CombinedProfileSnapshotAccount } from '@/lib/services/ai/combined-cache';
import type { InstagramProfile } from '@/lib/types/instagram';
import {
    getProfileCacheMissUsernames,
    mergeCachedAndScrapedProfiles,
} from './profile-cache';

const cachedAlice: CombinedProfileSnapshotAccount = {
    profile: {
        username: 'alice',
        profilePicUrl: 'https://scontent.cdninstagram.com/alice.jpg',
        fullName: 'Alice',
        bio: 'cached bio',
        isPrivate: false,
    },
    recentPosts: [{
        id: 'alice-post',
        shortCode: 'Alice_123',
        caption: 'cached caption',
        hashtags: ['cached'],
        imageUrl: 'https://scontent.cdninstagram.com/alice-post.jpg',
        type: 'image',
        likesCount: 12,
        commentsCount: 3,
        timestamp: '2026-07-09T00:00:00.000Z',
        taggedUsers: ['target.user'],
        mentionedUsers: ['other.user'],
    }],
};

function profile(username: string): InstagramProfile {
    return {
        username,
        fullName: username.toUpperCase(),
        bio: 'fresh bio',
        profilePicUrl: `https://scontent.cdninstagram.com/${username}.jpg`,
        followersCount: 10,
        followingCount: 10,
        postsCount: 1,
        isPrivate: false,
        isVerified: false,
        latestPosts: [{
            id: `${username}-post`,
            shortCode: `${username}-shortcode`,
            imageUrl: `https://scontent.cdninstagram.com/${username}-post.jpg`,
            type: 'image',
            likesCount: 1,
            commentsCount: 0,
            timestamp: '2026-07-10T00:00:00.000Z',
            taggedUsers: ['fresh.target'],
            mentionedUsers: ['fresh.mention'],
        }],
    };
}

describe('profiles-stage cache merge', () => {
    it('crawls only misses and restores the original order with tag data intact', () => {
        const batch = [{ username: 'alice' }, { username: 'bob' }, { username: 'carol' }];
        const snapshots = new Map([['alice', cachedAlice]]);

        expect(getProfileCacheMissUsernames(batch, snapshots)).toEqual(['bob', 'carol']);
        const merged = mergeCachedAndScrapedProfiles(
            batch,
            snapshots,
            [profile('carol'), profile('bob')]
        );

        expect(merged.map(account => account.profile.username))
            .toEqual(['alice', 'bob', 'carol']);
        expect(merged.map(account => account.profileSource))
            .toEqual(['cache', 'provider', 'provider']);
        expect(merged[0].recentPosts[0]).toMatchObject({
            id: 'alice-post',
            shortCode: 'Alice_123',
            likesCount: 12,
            taggedUsers: ['target.user'],
            mentionedUsers: ['other.user'],
        });
        expect(merged[1].recentPosts[0]).toMatchObject({
            id: 'bob-post',
            shortCode: 'bob-shortcode',
            likesCount: 1,
            taggedUsers: ['fresh.target'],
            mentionedUsers: ['fresh.mention'],
        });
    });

    it('treats an empty cache result as a full provider crawl', () => {
        const batch = [{ username: 'alice' }, { username: 'bob' }];
        const snapshots = new Map<string, CombinedProfileSnapshotAccount>();
        expect(getProfileCacheMissUsernames(batch, snapshots)).toEqual(['alice', 'bob']);
        expect(mergeCachedAndScrapedProfiles(
            batch,
            snapshots,
            [profile('alice'), profile('bob')]
        )).toHaveLength(2);
    });

    it('does not hide a provider result omitted from the miss set', () => {
        const batch = [{ username: 'alice' }, { username: 'bob' }];
        expect(() => mergeCachedAndScrapedProfiles(
            batch,
            new Map([['alice', cachedAlice]]),
            []
        )).toThrow('SCRAPING_INCOMPLETE_ERROR');
    });

    it('rejects duplicate requests, duplicate results, and unexpected results', () => {
        expect(() => getProfileCacheMissUsernames(
            [{ username: 'alice' }, { username: 'ALICE' }],
            new Map()
        )).toThrow('duplicate profiles batch username');
        expect(() => mergeCachedAndScrapedProfiles(
            [{ username: 'bob' }],
            new Map(),
            [profile('bob'), profile('BOB')]
        )).toThrow('duplicate profiles batch result');
        expect(() => mergeCachedAndScrapedProfiles(
            [{ username: 'bob' }],
            new Map(),
            [profile('carol')]
        )).toThrow('unexpected profiles batch result');
    });
});
