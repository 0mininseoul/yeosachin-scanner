import { describe, it, expect } from 'vitest';
import fixture from './__fixtures__/web-profile-info.json';
import {
    mapUserToAdmissionProfileSummary,
    mapUserToProfile,
    mapUserToProfileSummary,
    extractHashtags,
    extractMentions,
} from './mappers';

const user = (fixture as { data: { user: Record<string, unknown> } }).data.user;
const fixturePosts = (
    user.edge_owner_to_timeline_media as { edges: Array<{ node: Record<string, unknown> }> }
).edges.map(edge => edge.node);

function userWithPosts(posts: Array<Record<string, unknown>>): Record<string, unknown> {
    return {
        ...user,
        edge_owner_to_timeline_media: {
            count: posts.length,
            edges: posts.map(node => ({ node })),
        },
    };
}

describe('mapUserToProfile', () => {
    const profile = mapUserToProfile(userWithPosts(fixturePosts));

    it('프로필 스칼라 필드를 매핑한다', () => {
        expect(profile.username).toBe('sample_user');
        expect(profile.fullName).toBe('샘플 유저');
        expect(profile.followersCount).toBe(1234);
        expect(profile.followingCount).toBe(321);
        expect(profile.postsCount).toBe(2);
        expect(profile.isPrivate).toBe(false);
        expect(profile.isVerified).toBe(true);
        expect(profile.externalUrl).toBe('https://example.com');
    });

    it('profile_pic_url_hd를 우선 사용한다', () => {
        expect(profile.profilePicUrl).toBe('https://cdn.example.com/pic_hd.jpg');
    });

    it('팔로워/팔로잉 count가 누락되거나 잘못되면 거부한다', () => {
        const complete = userWithPosts(fixturePosts);
        expect(() => mapUserToProfile({ ...complete, edge_followed_by: {} })).toThrow('SCHEMA');
        expect(() => mapUserToProfile({ ...complete, edge_follow: { count: -1 } })).toThrow('SCHEMA');
    });

    it('게시물을 최대 10개, 타입/좋아요/이미지와 함께 매핑한다', () => {
        expect(profile.latestPosts).toHaveLength(2);
        const [p1, p2] = profile.latestPosts!;
        expect(p1.type).toBe('image');
        expect(p1.imageUrl).toBe('https://cdn.example.com/post1.jpg');
        expect(p1.likesCount).toBe(42);
        expect(p1.commentsCount).toBe(5);
        expect(p1.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(p2.type).toBe('video');
        expect(p2.thumbnailUrl).toBe('https://cdn.example.com/post2.jpg');
        expect(p2.videoUrl).toBe('https://cdn.example.com/post2.mp4');
        expect(p2.likesCount).toBe(10);
    });

    it('공개 계정의 최신 8개 게시물 스냅샷이 덜 오면 불완전 결과로 거부한다', () => {
        expect(() => mapUserToProfile({
            ...user,
            edge_owner_to_timeline_media: {
                count: 87,
                edges: fixturePosts.map(node => ({ node })),
            },
        })).toThrow('SCRAPING_INCOMPLETE_ERROR');
    });

    it('GraphSidecar 자식을 순서대로 매핑하고 선언 개수와 일치할 때만 완전성을 표시한다', () => {
        const sidecar = {
            id: 'sidecar-1',
            shortcode: 'SIDE1',
            __typename: 'GraphSidecar',
            display_url: 'https://cdn.example.com/sidecar-cover.jpg',
            is_video: false,
            taken_at_timestamp: 1_700_000_000,
            edge_media_to_caption: { edges: [] },
            edge_media_to_tagged_user: { edges: [] },
            edge_sidecar_to_children: {
                count: 3,
                edges: [
                    { node: { id: 'child-1', __typename: 'GraphImage', is_video: false, display_url: 'https://cdn.example.com/child-1.jpg' } },
                    { node: { id: 'child-2', __typename: 'GraphVideo', is_video: true, product_type: 'clips', display_url: 'https://cdn.example.com/child-2.jpg', video_url: 'https://cdn.example.com/child-2.mp4' } },
                    { node: { id: 'child-3', __typename: 'GraphVideo', is_video: true, display_url: 'https://cdn.example.com/child-3.jpg', video_url: 'https://cdn.example.com/child-3.mp4' } },
                ],
            },
        };

        const [post] = mapUserToProfile(userWithPosts([sidecar])).latestPosts!;

        expect(post).toMatchObject({
            type: 'carousel',
            imageUrl: 'https://cdn.example.com/sidecar-cover.jpg',
            declaredMediaCount: 3,
            childrenComplete: true,
        });
        expect(post.mediaItems).toEqual([
            {
                id: 'child-1',
                type: 'image',
                imageUrl: 'https://cdn.example.com/child-1.jpg',
            },
            {
                id: 'child-2',
                type: 'reel',
                thumbnailUrl: 'https://cdn.example.com/child-2.jpg',
                videoUrl: 'https://cdn.example.com/child-2.mp4',
            },
            {
                id: 'child-3',
                type: 'video',
                thumbnailUrl: 'https://cdn.example.com/child-3.jpg',
                videoUrl: 'https://cdn.example.com/child-3.mp4',
            },
        ]);
    });

    it('공개 프로필의 carousel 선언 또는 자식이 불완전하면 성공으로 확정하지 않는다', () => {
        const childEdges = [
            { node: { id: 'child-1', __typename: 'GraphImage', is_video: false, display_url: 'https://cdn.example.com/child-1.jpg' } },
            { node: { id: 'child-2', __typename: 'GraphVideo', is_video: true, display_url: 'https://cdn.example.com/child-2.mp4', video_url: 'https://cdn.example.com/child-2.mp4' } },
        ];
        const base = {
            id: 'sidecar-incomplete',
            shortcode: 'SIDE2',
            __typename: 'GraphSidecar',
            display_url: 'https://cdn.example.com/sidecar-cover.jpg',
            is_video: false,
            taken_at_timestamp: 1_700_000_000,
            edge_media_to_caption: { edges: [] },
            edge_media_to_tagged_user: { edges: [] },
        };

        expect(() => mapUserToProfile(userWithPosts([{
            ...base,
            edge_sidecar_to_children: { edges: childEdges.slice(0, 1) },
        }]))).toThrow('SCRAPING_INCOMPLETE_ERROR');
        expect(() => mapUserToProfile(userWithPosts([{
            ...base,
            edge_sidecar_to_children: { count: 2, edges: childEdges },
        }]))).toThrow('SCRAPING_INCOMPLETE_ERROR');
    });

    it('Instagram 상한을 넘는 carousel 선언을 불완전 응답으로 거부한다', () => {
        const children = Array.from({ length: 21 }, (_, index) => ({
            node: {
                id: `child-${index}`,
                __typename: 'GraphImage',
                is_video: false,
                display_url: `https://cdn.example.com/child-${index}.jpg`,
            },
        }));
        expect(() => mapUserToProfile(userWithPosts([{
            id: 'sidecar-large',
            shortcode: 'SIDE3',
            __typename: 'GraphSidecar',
            display_url: 'https://cdn.example.com/sidecar-cover.jpg',
            is_video: false,
            taken_at_timestamp: 1_700_000_000,
            edge_media_to_caption: { edges: [] },
            edge_media_to_tagged_user: { edges: [] },
            edge_sidecar_to_children: { count: 21, edges: children },
        }]))).toThrow('SCRAPING_INCOMPLETE_ERROR');
    });

    it('clips로 명시된 GraphVideo를 reel로 구분하고 display thumbnail을 보존한다', () => {
        const [post] = mapUserToProfile(userWithPosts([{
            id: 'reel-1',
            shortcode: 'REEL1',
            __typename: 'GraphVideo',
            is_video: true,
            product_type: 'clips',
            display_url: 'https://cdn.example.com/reel-thumb.jpg',
            video_url: 'https://cdn.example.com/reel.mp4',
            taken_at_timestamp: 1_700_000_000,
            edge_media_to_caption: { edges: [] },
            edge_media_to_tagged_user: { edges: [] },
        }])).latestPosts!;

        expect(post).toMatchObject({
            type: 'reel',
            imageUrl: 'https://cdn.example.com/reel-thumb.jpg',
            thumbnailUrl: 'https://cdn.example.com/reel-thumb.jpg',
            videoUrl: 'https://cdn.example.com/reel.mp4',
        });
    });

    it('원본 비디오 URL밖에 없는 게시물을 사용 가능한 성공으로 처리하지 않는다', () => {
        expect(() => mapUserToProfile(userWithPosts([{
            id: 'video-no-thumb',
            shortcode: 'VIDEO1',
            __typename: 'GraphVideo',
            is_video: true,
            display_url: 'https://cdn.example.com/raw-video.mp4?token=test',
            video_url: 'https://cdn.example.com/raw-video.mp4?token=test',
            taken_at_timestamp: 1_700_000_000,
            edge_media_to_caption: { edges: [] },
            edge_media_to_tagged_user: { edges: [] },
        }]))).toThrow('SCRAPING_INCOMPLETE_ERROR');
    });

    it.each([
        { id: '', shortcode: 'VALID' },
        { id: 'valid-id', shortcode: '' },
    ])('게시물 식별자가 비어 있으면 스키마 오류로 거부한다', ({ id, shortcode }) => {
        expect(() => mapUserToProfile(userWithPosts([{
            id,
            shortcode,
            __typename: 'GraphImage',
            is_video: false,
            display_url: 'https://cdn.example.com/post.jpg',
            edge_media_to_caption: { edges: [] },
            edge_media_to_tagged_user: { edges: [] },
        }]))).toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('캡션에서 태그된 유저, 멘션, 해시태그를 추출한다', () => {
        const [p1] = profile.latestPosts!;
        expect(p1.taggedUsers).toContain('tagged_c');
        expect(p1.mentionedUsers).toContain('friend_b');
        expect(p1.hashtags).toContain('선릉');
    });
});

describe('mapUserToProfileSummary', () => {
    it('validates identity, privacy, and counts without parsing incomplete timeline media', () => {
        const incompleteTimeline = {
            ...user,
            edge_owner_to_timeline_media: { count: 87, edges: [] },
        };

        expect(mapUserToProfileSummary(incompleteTimeline)).toMatchObject({
            username: 'sample_user',
            followersCount: 1234,
            followingCount: 321,
            postsCount: 87,
            isPrivate: false,
        });
        expect(mapUserToProfileSummary(incompleteTimeline).latestPosts).toBeUndefined();
        expect(() => mapUserToProfile(incompleteTimeline))
            .toThrow('SCRAPING_INCOMPLETE_ERROR');
    });
});

describe('mapUserToAdmissionProfileSummary', () => {
    it('validates only identity, privacy, and relationship counts', () => {
        const admission = mapUserToAdmissionProfileSummary({
            username: 'sample_user',
            is_private: false,
            edge_followed_by: { count: 410 },
            edge_follow: { count: 390 },
            edge_owner_to_timeline_media: { count: 'schema drift' },
            is_verified: 'unknown',
            profile_pic_url: 'not a url',
        });

        expect(admission).toEqual({
            username: 'sample_user',
            followersCount: 410,
            followingCount: 390,
            isPrivate: false,
        });
        expect(() => mapUserToAdmissionProfileSummary({
            username: 'sample_user',
            is_private: false,
            edge_followed_by: {},
            edge_follow: { count: 390 },
        })).toThrow('SCHEMA');
    });
});

describe('extractHashtags / extractMentions', () => {
    it('해시태그를 # 없이 추출한다', () => {
        expect(extractHashtags('a #one 그리고 #둘_2 끝')).toEqual(['one', '둘_2']);
    });
    it('멘션을 @ 없이 추출한다', () => {
        expect(extractMentions('hi @friend_a and @b.c_1')).toEqual(['friend_a', 'b.c_1']);
    });
    it('빈 입력은 빈 배열', () => {
        expect(extractHashtags(undefined)).toEqual([]);
        expect(extractMentions(undefined)).toEqual([]);
    });
});
