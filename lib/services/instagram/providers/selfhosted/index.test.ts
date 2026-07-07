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

    it('getFollowers는 2단계 미구현 에러를 throw한다', async () => {
        const provider = makeSelfHostedProvider({ fetchUser: vi.fn() });
        await expect(provider.getFollowers!('x', 10)).rejects.toThrow('2단계');
    });
});
