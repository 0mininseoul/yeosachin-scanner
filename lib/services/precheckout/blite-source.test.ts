import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import {
    PRECHECKOUT_BLITE_SOURCE_SCHEMA_VERSION,
    precheckoutBliteSourceV1Schema,
    projectPrecheckoutBliteSource,
} from './blite-source';

const IMAGE_HOST = 'https://cdninstagram.com';

function imageUrl(name: string): string {
    return `${IMAGE_HOST}/v/t51/${name}.jpg`;
}

function post(index: number, overrides: Partial<InstagramPost> = {}): InstagramPost {
    return {
        id: `post-${index}`,
        shortCode: `post_${index}`,
        caption: `  recent   caption ${index}  `,
        hashtags: [`tag_${index}`],
        imageUrl: imageUrl(`post-${index}`),
        type: 'image',
        likesCount: index,
        commentsCount: index + 1,
        timestamp: '2026-08-13T00:00:00.000Z',
        taggedUsers: [`tagged_${index}`],
        mentionedUsers: [`mentioned_${index}`],
        ...overrides,
    };
}

function profile(overrides: Partial<InstagramProfile> = {}): InstagramProfile {
    return {
        username: 'target_username_must_not_escape',
        fullName: '  B-lite   Full Name  ',
        bio: 'This bio must never be persisted in the source.',
        externalUrl: 'https://outside.example/private-path',
        profilePicUrl: imageUrl('profile'),
        followersCount: 1200,
        followingCount: 900,
        postsCount: 42,
        isPrivate: false,
        isVerified: false,
        latestPosts: Array.from({ length: 11 }, (_, index) => post(index + 1)),
        ...overrides,
    };
}

function keysRecursively(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) {
        value.forEach(item => keysRecursively(item, keys));
        return keys;
    }
    if (value && typeof value === 'object') {
        Object.entries(value).forEach(([key, child]) => {
            keys.add(key);
            keysRecursively(child, keys);
        });
    }
    return keys;
}

describe('projectPrecheckoutBliteSource', () => {
    it('projects only the strict B-lite digest and image-reference contract', () => {
        const account = profile({
            latestPosts: Array.from({ length: 11 }, (_, index) => post(index + 1, {
                caption: `  ${'caption '.repeat(30)}${index + 1}  `,
                hashtags: Array.from({ length: 20 }, () => 'h'.repeat(120)),
                taggedUsers: Array.from({ length: 20 }, (_, item) => `tagged_${item}`),
                mentionedUsers: Array.from({ length: 20 }, (_, item) => `mentioned_${item}`),
                type: index === 1 ? 'carousel' : index === 2 ? 'video' : 'image',
                declaredMediaCount: index === 1 ? 6 : undefined,
                likesCountHidden: index === 2 ? true : undefined,
                commentsCountHidden: index === 2 ? true : undefined,
                videoUrl: index === 2 ? 'https://video.example/video.mp4' : undefined,
                thumbnailUrl: imageUrl(`thumbnail-${index + 1}`),
            })),
            fullName: `  ${'F'.repeat(70)}  `,
        });

        const source = projectPrecheckoutBliteSource(account);
        const serialized = JSON.stringify(source);

        expect(source.schemaVersion).toBe(PRECHECKOUT_BLITE_SOURCE_SCHEMA_VERSION);
        expect(source.schemaVersion).toBe(1);
        expect(source.fullName).toHaveLength(60);
        expect(source.posts).toHaveLength(10);
        expect(source.posts[0]).toEqual({
            type: 'image',
            captionExcerpt: expect.any(String),
            hashtags: Array.from({ length: 15 }, () => 'h'.repeat(100)),
            carouselDepth: null,
            likesCount: 1,
            likesHidden: false,
            commentsCount: 2,
            commentsHidden: false,
            taggedUsernames: Array.from({ length: 15 }, (_, index) => `tagged_${index}`),
            mentionedUsernames: Array.from({ length: 15 }, (_, index) => `mentioned_${index}`),
        });
        expect(source.posts[0].captionExcerpt).toHaveLength(160);
        expect(source.posts[0].captionExcerpt).not.toMatch(/\s{2,}/u);
        expect(source.posts[1].carouselDepth).toBe(6);
        expect(source.posts[2]).toMatchObject({
            type: 'video',
            likesCount: null,
            likesHidden: true,
            commentsCount: null,
            commentsHidden: true,
        });
        expect(source.media).toEqual([
            { role: 'profile', url: imageUrl('profile') },
            { role: 'post', url: imageUrl('post-1') },
            { role: 'post', url: imageUrl('post-2') },
            { role: 'post', url: imageUrl('post-3') },
        ]);
        expect(source.media).toHaveLength(4);
        expect(Buffer.byteLength(serialized, 'utf8')).toBeLessThanOrEqual(256 * 1024);

        const allowedKeys = new Set([
            'schemaVersion', 'fullName', 'posts', 'media', 'type', 'captionExcerpt', 'hashtags',
            'carouselDepth', 'likesCount', 'likesHidden', 'commentsCount', 'commentsHidden',
            'taggedUsernames', 'mentionedUsernames', 'role', 'url',
        ]);
        for (const key of keysRecursively(source)) expect(allowedKeys.has(key)).toBe(true);

        for (const forbidden of [
            account.username,
            account.bio,
            account.externalUrl,
            String(account.followersCount),
            String(account.followingCount),
            'video.example',
            'post-11',
        ]) {
            expect(serialized).not.toContain(forbidden);
        }
    });

    it('uses only an allowlisted HTTPS Instagram/Apify image reference and never leaks invalid media', () => {
        const source = projectPrecheckoutBliteSource(profile({
            profilePicUrl: 'https://outside.example/profile.jpg',
            latestPosts: [
                post(1, { imageUrl: 'https://outside.example/image.jpg', thumbnailUrl: imageUrl('fallback') }),
                post(2, { imageUrl: 'https://cdninstagram.com.evil.example/image.jpg' }),
                post(3, { imageUrl: 'http://cdninstagram.com/plain-http.jpg' }),
            ],
        }));

        expect(source.media).toEqual([{ role: 'post', url: imageUrl('fallback') }]);
        expect(JSON.stringify(source)).not.toContain('outside.example');
        expect(JSON.stringify(source)).not.toContain('evil.example');
        expect(JSON.stringify(source)).not.toContain('plain-http');
    });

    it('caps post-media references at three even when the profile image is absent or invalid', () => {
        const source = projectPrecheckoutBliteSource(profile({
            profilePicUrl: 'https://outside.example/profile.jpg',
            latestPosts: [post(1), post(2), post(3), post(4)],
        }));

        expect(source.media).toEqual([
            { role: 'post', url: imageUrl('post-1') },
            { role: 'post', url: imageUrl('post-2') },
            { role: 'post', url: imageUrl('post-3') },
        ]);
    });

    it('sorts validated provider posts newest-first before applying the ten-post and media limits', () => {
        const source = projectPrecheckoutBliteSource(profile({
            latestPosts: Array.from({ length: 11 }, (_, index) => post(index + 1, {
                timestamp: new Date(Date.UTC(2026, 7, index + 1)).toISOString(),
            })),
        }));

        expect(source.posts.map(value => value.likesCount)).toEqual([
            11, 10, 9, 8, 7, 6, 5, 4, 3, 2,
        ]);
        expect(source.media).toEqual([
            { role: 'profile', url: imageUrl('profile') },
            { role: 'post', url: imageUrl('post-11') },
            { role: 'post', url: imageUrl('post-10') },
            { role: 'post', url: imageUrl('post-9') },
        ]);
        expect(() => projectPrecheckoutBliteSource(profile({
            latestPosts: [post(1, { timestamp: 'not-a-timestamp' })],
        }))).toThrow('PRECHECKOUT_BLITE_SOURCE_INVALID');
    });

    it('rejects malformed strict source values with a bounded error that contains no source PII', () => {
        const badCaption = 'confidential-caption-that-must-not-appear-in-errors';
        const malformed = profile({
            latestPosts: [post(1, { caption: badCaption, likesCount: -1 })],
        });

        expect(() => projectPrecheckoutBliteSource(malformed)).toThrow(
            'PRECHECKOUT_BLITE_SOURCE_INVALID'
        );
        try {
            projectPrecheckoutBliteSource(malformed);
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).not.toContain(badCaption);
        }
    });

    it('enforces the strict serialized schema limits independently of the projector', () => {
        const valid = projectPrecheckoutBliteSource(profile());
        expect(precheckoutBliteSourceV1Schema.safeParse({
            ...valid,
            unexpected: 'forbidden',
        }).success).toBe(false);
        expect(precheckoutBliteSourceV1Schema.safeParse({
            ...valid,
            media: [{ role: 'profile', url: `https://cdninstagram.com/${'a'.repeat(8_193)}` }],
        }).success).toBe(false);
    });
});
