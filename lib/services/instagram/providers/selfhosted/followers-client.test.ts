import { describe, it, expect, vi } from 'vitest';
import { fetchFollowers, fetchFollowing, mapFriendshipUser } from './followers-client';
import type { IgSession } from './session';

const sessions: IgSession[] = [{ sessionId: 's', csrfToken: 'c', userId: 'u' }];

function userItem(username: string, over: Record<string, unknown> = {}) {
    return { username, full_name: `${username} name`, is_private: false, is_verified: false, ...over };
}

describe('mapFriendshipUser', () => {
    it('friendship user JSON을 InstagramFollower로 매핑한다', () => {
        const f = mapFriendshipUser(userItem('alice', { is_private: true, profile_pic_url: 'p.jpg' }));
        expect(f).toEqual({
            username: 'alice',
            fullName: 'alice name',
            profilePicUrl: 'p.jpg',
            isPrivate: true,
            isVerified: false,
        });
    });
    it('username 없으면 null', () => {
        expect(mapFriendshipUser({ full_name: 'x' })).toBeNull();
    });
});

describe('fetchFollowers 페이지네이션', () => {
    it('next_max_id를 따라 여러 페이지를 이어붙이고 limit로 자른다', async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce({ users: [userItem('a'), userItem('b')], next_max_id: 'p2' })
            .mockResolvedValueOnce({ users: [userItem('c'), userItem('d')], next_max_id: null });
        const result = await fetchFollowers('target', 3, {
            sessions,
            resolveUserId: async () => '999',
            request,
            delayMs: 0,
        });
        expect(result.map((r) => r.username)).toEqual(['a', 'b', 'c']);
        expect(request).toHaveBeenCalledTimes(2);
        // 2번째 호출에 max_id가 전달됨
        expect(request.mock.calls[1][2]).toBe('p2');
    });

    it('limit에 도달하면 다음 페이지를 요청하지 않는다', async () => {
        const request = vi.fn().mockResolvedValue({ users: [userItem('a'), userItem('b')], next_max_id: 'p2' });
        const result = await fetchFollowers('target', 2, {
            sessions,
            resolveUserId: async () => '999',
            request,
            delayMs: 0,
        });
        expect(result).toHaveLength(2);
        expect(request).toHaveBeenCalledTimes(1);
    });
});

describe('fetchFollowing', () => {
    it('following kind로 요청한다', async () => {
        const request = vi.fn().mockResolvedValue({ users: [userItem('a')], next_max_id: null });
        await fetchFollowing('target', 10, { sessions, resolveUserId: async () => '999', request, delayMs: 0 });
        expect(request.mock.calls[0][1]).toBe('following');
    });
});

describe('에러 처리', () => {
    it('세션이 없으면 명확한 에러를 throw한다', async () => {
        await expect(
            fetchFollowers('target', 10, { sessions: [], resolveUserId: async () => '999', request: vi.fn() })
        ).rejects.toThrow('세션이 없습니다');
    });

    it('user_id 확인 실패 시 에러를 throw한다', async () => {
        await expect(
            fetchFollowers('ghost', 10, { sessions, resolveUserId: async () => null, request: vi.fn() })
        ).rejects.toThrow('user_id');
    });
});
