import { describe, it, expect, vi } from 'vitest';
import fixture from './__fixtures__/web-profile-info.json';
import { makeSelfHostedProvider } from './index';

const user = (fixture as { data: { user: Record<string, unknown> } }).data.user;

describe('selfHostedProvider', () => {
    it('getProfile은 web-client 결과를 InstagramProfile로 매핑한다', async () => {
        const fetchUser = vi.fn().mockResolvedValue(user);
        const provider = makeSelfHostedProvider({ fetchUser });
        const profile = await provider.getProfile!('sample_user');
        expect(profile?.username).toBe('sample_user');
        expect(profile?.latestPosts).toHaveLength(2);
        expect(fetchUser).toHaveBeenCalledWith('sample_user');
    });

    it('getProfile은 계정 없음(null)을 그대로 null로 반환한다', async () => {
        const provider = makeSelfHostedProvider({ fetchUser: vi.fn().mockResolvedValue(null) });
        expect(await provider.getProfile!('ghost')).toBeNull();
    });

    it('getProfilesBatch는 개별 실패를 건너뛰고 성공분만 모은다', async () => {
        const fetchUser = vi
            .fn()
            .mockResolvedValueOnce(user)
            .mockRejectedValueOnce(new Error('blocked'));
        const provider = makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 });
        const results = await provider.getProfilesBatch!(['a', 'b']);
        expect(results).toHaveLength(1);
        expect(results[0].username).toBe('sample_user');
    });

    it('getFollowers/getFollowing은 주입된 fetcher로 위임한다', async () => {
        const fetchFollowersFn = vi.fn().mockResolvedValue([{ username: 'f1' }]);
        const fetchFollowingFn = vi.fn().mockResolvedValue([{ username: 'g1' }]);
        const provider = makeSelfHostedProvider({ fetchUser: vi.fn(), fetchFollowersFn, fetchFollowingFn });

        const followers = await provider.getFollowers!('x', 10);
        const following = await provider.getFollowing!('x', 20);

        expect(followers).toEqual([{ username: 'f1' }]);
        expect(following).toEqual([{ username: 'g1' }]);
        expect(fetchFollowersFn).toHaveBeenCalledWith('x', 10);
        expect(fetchFollowingFn).toHaveBeenCalledWith('x', 20);
    });
});
