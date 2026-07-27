import { describe, expect, it } from 'vitest';
import {
    MAX_FEATURE_MEDIA,
    MAX_FEATURE_FEED_MEDIA,
    MAX_FEED_MEDIA,
    MAX_PARTNER_SAFETY_CONTACT_MEDIA,
    MAX_RECENT_POSTS,
    MAX_TRIAGE_MEDIA,
    MAX_TRIAGE_FEED_MEDIA,
    selectAnalysisMedia,
    type AnalysisPostMediaInput,
} from './media-policy';

function imagePost(id: string, timestamp: string | number): AnalysisPostMediaInput {
    return {
        id,
        timestamp,
        type: 'image',
        imageUrl: `https://cdn.example/${id}.jpg`,
    };
}

describe('selectAnalysisMedia', () => {
    it('selects the latest eight posts and one representative per post', () => {
        const posts = Array.from({ length: 10 }, (_, index) => (
            imagePost(`post-${index + 1}`, index + 1)
        ));

        const result = selectAnalysisMedia({ posts });

        expect(result.selectedPostIds).toEqual([
            'post-10',
            'post-9',
            'post-8',
            'post-7',
            'post-6',
            'post-5',
            'post-4',
            'post-3',
        ]);
        expect(result.selectedPostIds).toHaveLength(MAX_RECENT_POSTS);
        expect(result.feed.media).toHaveLength(MAX_RECENT_POSTS);
        expect(result.feed.media.every(media => media.role === 'post_representative')).toBe(true);
    });

    it('prioritizes first, middle, and last images from the latest eligible carousel', () => {
        const carousel: AnalysisPostMediaInput = {
            id: 'carousel-new',
            timestamp: 100,
            type: 'carousel',
            declaredMediaCount: 5,
            childrenComplete: true,
            mediaItems: Array.from({ length: 5 }, (_, index) => ({
                id: `child-${index}`,
                type: 'image' as const,
                imageUrl: `https://cdn.example/carousel-${index}.jpg`,
            })),
        };
        const posts = [
            imagePost('newer-image', 110),
            carousel,
            ...Array.from({ length: 7 }, (_, index) => imagePost(`older-${index}`, 90 - index)),
        ];

        const first = selectAnalysisMedia({
            profile: { id: 'avatar-v1', imageUrl: 'https://cdn.example/avatar.jpg' },
            posts,
        });
        const second = selectAnalysisMedia({
            profile: { id: 'avatar-v1', imageUrl: 'https://cdn.example/avatar.jpg' },
            posts: [...posts].reverse(),
        });

        expect(first.feed.media).toHaveLength(MAX_FEED_MEDIA);
        expect(first.feed.media.filter(media => media.postId === 'carousel-new')).toMatchObject([
            { mediaIndex: 0, role: 'post_representative' },
            { mediaIndex: 2, role: 'carousel_context' },
            { mediaIndex: 4, role: 'carousel_context' },
        ]);
        expect(first.triage.media).toHaveLength(MAX_TRIAGE_MEDIA);
        expect(first.triage.media.filter(media => media.role !== 'profile'))
            .toHaveLength(MAX_TRIAGE_FEED_MEDIA);
        expect(first.triage.media.filter(media => media.role === 'carousel_context')).toHaveLength(0);
        expect(first.feature.media).toHaveLength(MAX_FEATURE_MEDIA);
        expect(first.feature.media.filter(media => media.role !== 'profile'))
            .toHaveLength(MAX_FEATURE_FEED_MEDIA);
        expect(first.feature.media.filter(media => media.postId === 'carousel-new')).toHaveLength(3);
        expect(first).toEqual(second);
        expect(first.feed.selectionIds).toEqual(first.feed.media.map(media => media.selectionId));
        expect(first.feature.selectionIds[0]).toBe('profile:avatar-v1');
    });

    it('keeps v2.7 selection unchanged while v2.8 distributes carousel context under the same cap', () => {
        const carousel = (id: string, timestamp: number): AnalysisPostMediaInput => ({
            id,
            timestamp,
            type: 'carousel',
            declaredMediaCount: 5,
            childrenComplete: true,
            mediaItems: Array.from({ length: 5 }, (_, index) => ({
                id: `${id}-${index}`,
                type: 'image' as const,
                imageUrl: `https://cdn.example/${id}-${index}.jpg`,
            })),
        });
        const posts = [
            carousel('newest', 20),
            carousel('second', 19),
            ...Array.from({ length: 6 }, (_, index) => imagePost(`image-${index}`, 18 - index)),
        ];

        const legacy = selectAnalysisMedia({ posts });
        const legacyAgain = selectAnalysisMedia({ posts });
        const v28 = selectAnalysisMedia({ posts }, { carouselDiversity: true });

        expect(legacy).toEqual(legacyAgain);
        expect(legacy.feed.media.filter(media => media.role === 'carousel_context'))
            .toMatchObject([
                { postId: 'newest', mediaIndex: 2 },
                { postId: 'newest', mediaIndex: 4 },
            ]);
        expect(v28.feed.media.filter(media => media.role === 'carousel_context'))
            .toMatchObject([
                { postId: 'newest', mediaIndex: 2 },
                { postId: 'second', mediaIndex: 2 },
            ]);
        expect(v28.feature.media).toHaveLength(MAX_FEATURE_FEED_MEDIA);
    });

    it('selects first, middle, and last from every complete carousel when the fixed cap permits', () => {
        const carousel = (id: string, timestamp: number): AnalysisPostMediaInput => ({
            id,
            timestamp,
            type: 'carousel',
            declaredMediaCount: 3,
            childrenComplete: true,
            mediaItems: Array.from({ length: 3 }, (_, index) => ({
                id: `${id}-${index}`,
                type: 'image' as const,
                imageUrl: `https://cdn.example/${id}-${index}.jpg`,
            })),
        });
        const result = selectAnalysisMedia({ posts: [carousel('a', 3), carousel('b', 2)] }, {
            carouselDiversity: true,
        });
        expect(result.feed.media.filter(media => media.postId === 'a').map(media => media.mediaIndex))
            .toEqual([0, 1, 2]);
        expect(result.feed.media.filter(media => media.postId === 'b').map(media => media.mediaIndex))
            .toEqual([0, 1, 2]);
    });

    it('uses available reel and video thumbnails instead of dropping those posts', () => {
        const result = selectAnalysisMedia({
            posts: [
                {
                    id: 'reel-1',
                    timestamp: 2,
                    type: 'reel',
                    thumbnailUrl: 'https://cdn.example/reel-thumb.jpg',
                    imageUrl: 'https://cdn.example/reel-display.jpg',
                },
                {
                    id: 'video-1',
                    timestamp: 1,
                    type: 'video',
                    thumbnailUrl: 'https://cdn.example/video-thumb.jpg',
                },
            ],
        });

        expect(result.feed.media.map(media => media.imageUrl)).toEqual([
            'https://cdn.example/reel-thumb.jpg',
            'https://cdn.example/video-thumb.jpg',
        ]);
    });

    it('keeps all ten feed images when a profile is also sent to feature analysis', () => {
        const oldestCarousel: AnalysisPostMediaInput = {
            id: 'oldest-carousel',
            timestamp: 1,
            type: 'carousel',
            declaredMediaCount: 4,
            childrenComplete: true,
            mediaItems: Array.from({ length: 4 }, (_, index) => ({
                id: `carousel-${index}`,
                type: 'image' as const,
                imageUrl: `https://cdn.example/oldest-carousel-${index}.jpg`,
            })),
        };
        const result = selectAnalysisMedia({
            profile: { id: 'profile', imageUrl: 'https://cdn.example/profile.jpg' },
            posts: [
                ...Array.from({ length: 7 }, (_, index) => imagePost(`newer-${index}`, 10 - index)),
                oldestCarousel,
            ],
        });

        expect(result.feature.media).toHaveLength(MAX_FEATURE_MEDIA);
        expect(result.feature.media[0].role).toBe('profile');
        expect(result.feature.media.filter(media => media.role !== 'profile'))
            .toHaveLength(MAX_FEATURE_FEED_MEDIA);
        expect(result.feature.media.filter(media => media.postId === 'oldest-carousel'))
            .toMatchObject([
                { mediaIndex: 0, role: 'post_representative' },
                { mediaIndex: 2, role: 'carousel_context' },
                { mediaIndex: 3, role: 'carousel_context' },
            ]);
    });

    it('deduplicates URLs across outputs and never clones media to fill a limit', () => {
        const duplicateUrl = 'https://cdn.example/same.jpg';
        const result = selectAnalysisMedia({
            profile: { imageUrl: duplicateUrl },
            posts: [
                { ...imagePost('first', 3), imageUrl: duplicateUrl },
                { ...imagePost('second', 2), imageUrl: duplicateUrl },
                imagePost('third', 1),
            ],
        });

        expect(result.feed.media.map(media => media.imageUrl)).toEqual([
            duplicateUrl,
            'https://cdn.example/third.jpg',
        ]);
        expect(result.triage.media.map(media => media.imageUrl)).toEqual([
            duplicateUrl,
            'https://cdn.example/third.jpg',
        ]);
        expect(result.feature.media.map(media => media.imageUrl)).toEqual([
            duplicateUrl,
            'https://cdn.example/third.jpg',
        ]);
        expect(new Set(result.feed.media.map(media => media.imageUrl)).size)
            .toBe(result.feed.media.length);
        expect(result.feature.media.length).toBeLessThan(MAX_FEATURE_MEDIA);
    });

    it('fills analysis limits from feed media when no profile image exists', () => {
        const carousel: AnalysisPostMediaInput = {
            id: 'carousel',
            timestamp: 20,
            type: 'carousel',
            declaredMediaCount: 3,
            childrenComplete: true,
            mediaItems: Array.from({ length: 3 }, (_, index) => ({
                type: 'image' as const,
                imageUrl: `https://cdn.example/child-${index}.jpg`,
            })),
        };
        const result = selectAnalysisMedia({
            posts: [
                carousel,
                ...Array.from({ length: 7 }, (_, index) => imagePost(`post-${index}`, 10 - index)),
            ],
        });

        expect(result.feed.media).toHaveLength(MAX_FEED_MEDIA);
        expect(result.triage.media).toHaveLength(MAX_TRIAGE_FEED_MEDIA);
        expect(result.feature.media).toHaveLength(MAX_FEATURE_FEED_MEDIA);
        expect(result.triage.media.every(media => media.role === 'post_representative')).toBe(true);
    });

    it('reports incomplete or undeclared carousels without expanding their partial children', () => {
        const result = selectAnalysisMedia({
            posts: [
                {
                    id: 'declared-partial',
                    timestamp: 3,
                    type: 'carousel',
                    declaredMediaCount: 5,
                    childrenComplete: false,
                    mediaItems: [
                        { type: 'image', imageUrl: 'https://cdn.example/partial-0.jpg' },
                        { type: 'image', imageUrl: 'https://cdn.example/partial-1.jpg' },
                    ],
                },
                {
                    id: 'metadata-missing',
                    timestamp: 2,
                    type: 'carousel',
                    mediaItems: [
                        { type: 'image', imageUrl: 'https://cdn.example/missing-0.jpg' },
                        { type: 'image', imageUrl: 'https://cdn.example/missing-1.jpg' },
                        { type: 'image', imageUrl: 'https://cdn.example/missing-2.jpg' },
                    ],
                },
                imagePost('image', 1),
            ],
        });

        expect(result.carouselCoverage).toEqual({
            posts: [
                {
                    postId: 'declared-partial',
                    declaredMediaCount: 5,
                    imageCapableChildCount: 2,
                    childrenComplete: false,
                    coverage: 0.4,
                },
                {
                    postId: 'metadata-missing',
                    declaredMediaCount: null,
                    imageCapableChildCount: 3,
                    childrenComplete: false,
                    coverage: null,
                },
            ],
            incompletePostIds: ['declared-partial', 'metadata-missing'],
        });
        expect(result.feed.media.filter(media => media.role === 'carousel_context')).toHaveLength(0);
        expect(result.partnerSafetyContactSheetCandidates.media).toHaveLength(0);
    });

    it('fails closed when a complete carousel does not match its declared child count', () => {
        expect(() => selectAnalysisMedia({
            posts: [{
                id: 'contradictory',
                timestamp: 1,
                type: 'carousel',
                declaredMediaCount: 5,
                childrenComplete: true,
                mediaItems: Array.from({ length: 4 }, (_, index) => ({
                    type: 'image' as const,
                    imageUrl: `https://cdn.example/contradictory-${index}.jpg`,
                })),
            }],
        })).toThrowError('CAROUSEL_COMPLETENESS_MISMATCH');

        expect(() => selectAnalysisMedia({
            posts: [{
                id: 'top-level-is-not-a-child',
                timestamp: 1,
                type: 'carousel',
                declaredMediaCount: 1,
                childrenComplete: true,
                imageUrl: 'https://cdn.example/top-level.jpg',
            }],
        })).toThrowError('CAROUSEL_COMPLETENESS_MISMATCH');

        expect(() => selectAnalysisMedia({
            posts: [{
                id: 'too-many-declared',
                timestamp: 1,
                type: 'carousel',
                declaredMediaCount: 21,
                childrenComplete: false,
            }],
        })).toThrowError('INVALID_CAROUSEL_METADATA');

        expect(() => selectAnalysisMedia({
            posts: [{
                id: 'extra-unusable-child',
                timestamp: 1,
                type: 'carousel',
                declaredMediaCount: 2,
                childrenComplete: true,
                mediaItems: [
                    { type: 'image', imageUrl: 'https://cdn.example/usable-1.jpg' },
                    { type: 'image', imageUrl: 'https://cdn.example/usable-2.jpg' },
                    { id: 'unexpected-empty-child', type: 'image' },
                ],
            }],
        })).toThrowError('CAROUSEL_COMPLETENESS_MISMATCH');
    });

    it('never counts raw video or a generic video URL as image evidence', () => {
        const mediaItems = [
            { type: 'image' as const, url: 'https://cdn.example/raw.MP4?token=1' },
            {
                type: 'video' as const,
                imageUrl: 'https://cdn.example/raw.webm#fragment',
                url: 'https://cdn.example/generic-poster.jpg',
            },
            { type: 'reel' as const, url: 'https://cdn.example/reel-poster.jpg' },
        ];
        const incomplete = selectAnalysisMedia({
            posts: [{
                id: 'raw-video-children',
                timestamp: 1,
                type: 'carousel',
                declaredMediaCount: 3,
                childrenComplete: false,
                mediaItems,
            }],
        });

        expect(incomplete.carouselCoverage.posts[0]).toMatchObject({
            imageCapableChildCount: 0,
            coverage: 0,
            childrenComplete: false,
        });
        expect(incomplete.feed.media).toHaveLength(0);
        expect(() => selectAnalysisMedia({
            posts: [{
                id: 'raw-video-children',
                timestamp: 1,
                type: 'carousel',
                declaredMediaCount: 3,
                childrenComplete: true,
                mediaItems,
            }],
        })).toThrowError('CAROUSEL_COMPLETENESS_MISMATCH');
    });

    it('accepts image children and verified video or reel display thumbnails', () => {
        const result = selectAnalysisMedia({
            posts: [{
                id: 'mixed-display-evidence',
                timestamp: 1,
                type: 'carousel',
                declaredMediaCount: 3,
                childrenComplete: true,
                mediaItems: [
                    { type: 'image', url: 'https://cdn.example/still.jpg' },
                    {
                        type: 'video',
                        thumbnailUrl: 'https://cdn.example/video-thumbnail.jpg',
                        url: 'https://cdn.example/video.mp4',
                    },
                    {
                        type: 'reel',
                        imageUrl: 'https://cdn.example/reel-display.jpg',
                        url: 'https://cdn.example/reel.webm',
                    },
                ],
            }],
        });

        expect(result.carouselCoverage.posts[0]).toMatchObject({
            imageCapableChildCount: 3,
            coverage: 1,
            childrenComplete: true,
        });
        expect(result.feed.media.map(media => media.imageUrl)).toEqual([
            'https://cdn.example/still.jpg',
            'https://cdn.example/video-thumbnail.jpg',
            'https://cdn.example/reel-display.jpg',
        ]);
    });

    it('keeps the twentieth frame and shortlists the other seventeen contact candidates', () => {
        const carousel: AnalysisPostMediaInput = {
            id: 'twenty-frame-carousel',
            timestamp: 100,
            type: 'carousel',
            declaredMediaCount: 20,
            childrenComplete: true,
            mediaItems: Array.from({ length: 20 }, (_, index) => ({
                id: `frame-${index + 1}`,
                type: 'image' as const,
                imageUrl: `https://cdn.example/frame-${index + 1}.jpg`,
            })),
        };

        const result = selectAnalysisMedia({ posts: [carousel] });

        expect(result.feed.media.map(media => media.mediaIndex)).toEqual([0, 10, 19]);
        expect(result.feed.media.at(-1)?.imageUrl).toBe('https://cdn.example/frame-20.jpg');
        expect(result.partnerSafetyContactSheetCandidates.media)
            .toHaveLength(MAX_PARTNER_SAFETY_CONTACT_MEDIA);
        expect(result.partnerSafetyContactSheetCandidates.media.map(media => media.mediaIndex))
            .toEqual([
                1, 2, 3, 4, 5, 6, 7, 8, 9,
                11, 12, 13, 14, 15, 16, 17, 18,
            ]);
        expect(result.partnerSafetyContactSheetCandidates.selectionIds)
            .toEqual(result.partnerSafetyContactSheetCandidates.media.map(media => media.selectionId));
    });
});
