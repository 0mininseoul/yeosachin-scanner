import { describe, expect, it } from 'vitest';
import type { AnalysisV2CheckpointProfile } from './v2-profile-fetch-store';
import { selectAnalysisV2ProgressCandidateMedia } from './progress-candidate-media';

function profile(overrides: Partial<AnalysisV2CheckpointProfile> = {}): AnalysisV2CheckpointProfile {
    return {
        username: 'candidate.one',
        followersCount: 1,
        followingCount: 1,
        postsCount: 4,
        isPrivate: false,
        isVerified: false,
        profilePicUrl: 'https://cdn.example/profile.jpg',
        latestPosts: [
            {
                id: 'newest-image', shortCode: 'newestimage', type: 'image',
                imageUrl: 'https://cdn.example/newest.jpg', likesCount: 0, commentsCount: 0,
                timestamp: '2026-08-01T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
            },
            {
                id: 'newest-reel', shortCode: 'newestreel', type: 'reel',
                imageUrl: 'https://cdn.example/raw-video.mp4',
                thumbnailUrl: 'https://cdn.example/reel-thumbnail.jpg',
                videoUrl: 'https://cdn.example/video.mp4', likesCount: 0, commentsCount: 0,
                timestamp: '2026-07-31T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
            },
            {
                id: 'duplicate-profile', shortCode: 'duplicateprofile', type: 'image',
                imageUrl: 'https://cdn.example/profile.jpg', likesCount: 0, commentsCount: 0,
                timestamp: '2026-07-30T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
            },
            {
                id: 'duplicate-feed', shortCode: 'duplicatefeed', type: 'image',
                imageUrl: 'https://cdn.example/newest.jpg', likesCount: 0, commentsCount: 0,
                timestamp: '2026-07-29T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
            },
            {
                id: 'fourth-image', shortCode: 'fourthimage', type: 'image',
                imageUrl: 'https://cdn.example/fourth.jpg', likesCount: 0, commentsCount: 0,
                timestamp: '2026-07-28T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
            },
            {
                id: 'fifth-image', shortCode: 'fifthimage', type: 'image',
                imageUrl: 'https://cdn.example/fifth.jpg', likesCount: 0, commentsCount: 0,
                timestamp: '2026-07-27T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
            },
        ],
        ...overrides,
    };
}

describe('selectAnalysisV2ProgressCandidateMedia', () => {
    it('keeps the checkpoint profile image and up to three distinct newest-first display images', () => {
        expect(selectAnalysisV2ProgressCandidateMedia(profile())).toEqual({
            profilePicUrl: 'https://cdn.example/profile.jpg',
            feedImageUrls: [
                'https://cdn.example/newest.jpg',
                'https://cdn.example/reel-thumbnail.jpg',
                'https://cdn.example/fourth.jpg',
            ],
        });
    });

    it('returns an empty or partial preview for missing or invalid media without throwing', () => {
        expect(selectAnalysisV2ProgressCandidateMedia({
            ...profile({ profilePicUrl: 'not-a-url', latestPosts: [
                {
                    id: 'invalid', shortCode: 'invalid', type: 'video',
                    imageUrl: 'https://cdn.example/raw-video.mp4',
                    videoUrl: 'https://cdn.example/video.mp4', likesCount: 0, commentsCount: 0,
                    timestamp: '2026-08-01T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
                {
                    id: 'usable', shortCode: 'usable', type: 'image',
                    imageUrl: 'https://cdn.example/usable.jpg', likesCount: 0, commentsCount: 0,
                    timestamp: '2026-07-31T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
            ] }),
        } as unknown as AnalysisV2CheckpointProfile)).toEqual({
            feedImageUrls: ['https://cdn.example/usable.jpg'],
        });
        expect(selectAnalysisV2ProgressCandidateMedia({
            ...profile({ profilePicUrl: 'not-a-url', latestPosts: [] }),
        } as unknown as AnalysisV2CheckpointProfile)).toEqual({ feedImageUrls: [] });
    });

    it('uses the first usable carousel child when its top-level image is unavailable', () => {
        expect(selectAnalysisV2ProgressCandidateMedia(profile({
            latestPosts: [{
                id: 'carousel', shortCode: 'carousel', type: 'carousel',
                likesCount: 0, commentsCount: 0,
                timestamp: '2026-08-01T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                mediaItems: [
                    { type: 'video', videoUrl: 'https://cdn.example/raw.mp4' },
                    { type: 'image', imageUrl: 'https://cdn.example/carousel-child.jpg' },
                ],
            }],
        }))).toEqual({
            profilePicUrl: 'https://cdn.example/profile.jpg',
            feedImageUrls: ['https://cdn.example/carousel-child.jpg'],
        });
    });

    it('never emits an extensionless display URL when it equals a raw video URL', () => {
        const rawVideoUrl = 'https://cdn.example/media?id=raw-video';
        expect(selectAnalysisV2ProgressCandidateMedia(profile({
            latestPosts: [
                {
                    id: 'raw-reel', shortCode: 'rawreel', type: 'reel',
                    imageUrl: rawVideoUrl, videoUrl: rawVideoUrl,
                    likesCount: 0, commentsCount: 0,
                    timestamp: '2026-08-01T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
                {
                    id: 'raw-carousel', shortCode: 'rawcarousel', type: 'carousel',
                    likesCount: 0, commentsCount: 0,
                    timestamp: '2026-07-31T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                    mediaItems: [{
                        type: 'video', imageUrl: rawVideoUrl, videoUrl: rawVideoUrl,
                    }],
                },
                {
                    id: 'safe-image', shortCode: 'safeimage', type: 'image',
                    imageUrl: 'https://cdn.example/safe.jpg', likesCount: 0, commentsCount: 0,
                    timestamp: '2026-07-30T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
            ],
        }))).toEqual({
            profilePicUrl: 'https://cdn.example/profile.jpg',
            feedImageUrls: ['https://cdn.example/safe.jpg'],
        });
    });

    it('uses canonical URL keys for raw-video exclusion and duplicate display media', () => {
        const profilePicUrl = 'https://CDN.EXAMPLE:443/avatar/../profile.jpg?b=2&a=1#profile';
        expect(selectAnalysisV2ProgressCandidateMedia(profile({
            profilePicUrl,
            latestPosts: [
                {
                    id: 'canonical-raw-video', shortCode: 'canonicalrawvideo', type: 'reel',
                    videoUrl: 'https://CDN.EXAMPLE:443/media/./clip?b=2&a=1#raw',
                    imageUrl: 'https://cdn.example/media/clip?a=1&b=2',
                    likesCount: 0, commentsCount: 0,
                    timestamp: '2026-08-01T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
                {
                    id: 'canonical-profile-duplicate', shortCode: 'canonicalprofileduplicate',
                    type: 'image', imageUrl: 'https://cdn.example/profile.jpg?a=1&b=2',
                    likesCount: 0, commentsCount: 0,
                    timestamp: '2026-07-31T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
                {
                    id: 'first-feed', shortCode: 'firstfeed', type: 'image',
                    imageUrl: 'https://cdn.example/feed/../feed.jpg?z=1&x=2',
                    likesCount: 0, commentsCount: 0,
                    timestamp: '2026-07-30T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
                {
                    id: 'duplicate-feed', shortCode: 'duplicatefeedcanonical', type: 'image',
                    imageUrl: 'https://CDN.EXAMPLE:443/feed.jpg?x=2&z=1#duplicate',
                    likesCount: 0, commentsCount: 0,
                    timestamp: '2026-07-29T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
                {
                    id: 'safe-feed', shortCode: 'safefeed', type: 'image',
                    imageUrl: 'https://cdn.example/safe-feed.jpg', likesCount: 0, commentsCount: 0,
                    timestamp: '2026-07-28T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
                },
            ],
        }))).toEqual({
            profilePicUrl,
            feedImageUrls: [
                'https://cdn.example/feed/../feed.jpg?z=1&x=2',
                'https://cdn.example/safe-feed.jpg',
            ],
        });
    });
});
