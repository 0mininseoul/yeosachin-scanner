import { describe, it, expect } from 'vitest';
import fixture from './__fixtures__/web-profile-info.json';
import { mapUserToProfile, extractHashtags, extractMentions } from './mappers';

const user = (fixture as { data: { user: Record<string, unknown> } }).data.user;

describe('mapUserToProfile', () => {
    const profile = mapUserToProfile(user);

    it('프로필 스칼라 필드를 매핑한다', () => {
        expect(profile.username).toBe('sample_user');
        expect(profile.fullName).toBe('샘플 유저');
        expect(profile.followersCount).toBe(1234);
        expect(profile.followingCount).toBe(321);
        expect(profile.postsCount).toBe(87);
        expect(profile.isPrivate).toBe(false);
        expect(profile.isVerified).toBe(true);
        expect(profile.externalUrl).toBe('https://example.com');
    });

    it('profile_pic_url_hd를 우선 사용한다', () => {
        expect(profile.profilePicUrl).toBe('https://cdn.example.com/pic_hd.jpg');
    });

    it('팔로워/팔로잉 count가 누락되거나 잘못되면 거부한다', () => {
        expect(() => mapUserToProfile({ ...user, edge_followed_by: {} })).toThrow('SCHEMA');
        expect(() => mapUserToProfile({ ...user, edge_follow: { count: -1 } })).toThrow('SCHEMA');
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
        expect(p2.videoUrl).toBe('https://cdn.example.com/post2.mp4');
        expect(p2.likesCount).toBe(10);
    });

    it('캡션에서 태그된 유저, 멘션, 해시태그를 추출한다', () => {
        const [p1] = profile.latestPosts!;
        expect(p1.taggedUsers).toContain('tagged_c');
        expect(p1.mentionedUsers).toContain('friend_b');
        expect(p1.hashtags).toContain('선릉');
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
