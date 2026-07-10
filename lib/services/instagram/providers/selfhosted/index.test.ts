import { describe, it, expect, vi } from 'vitest';
import fixture from './__fixtures__/web-profile-info.json';
import { getSelfHostedProfileConcurrency, makeSelfHostedProvider } from './index';

const user = (fixture as { data: { user: Record<string, unknown> } }).data.user;

describe('selfHostedProvider', () => {
    it('uses the bounded production concurrency needed for the cold-profile latency budget', () => {
        expect(getSelfHostedProfileConcurrency({})).toBe(4);
        expect(() => getSelfHostedProfileConcurrency({
            SELFHOSTED_PROFILE_CONCURRENCY: '6',
        })).toThrow('SCRAPING_CONFIG_ERROR');
    });

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

    it('getProfilesBatch는 전체 요청이 있을 때 결과를 반환한다', async () => {
        const fetchUser = vi.fn().mockResolvedValue(user);
        const provider = makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 });
        const results = await provider.getProfilesBatch!(['sample_user']);
        expect(results).toHaveLength(1);
        expect(results[0].username).toBe('sample_user');
    });

    it('getProfilesBatch는 성공한 부분 결과를 반환해 router가 누락만 보충하게 한다', async () => {
        const fetchUser = vi
            .fn()
            .mockResolvedValueOnce(user)
            .mockRejectedValueOnce(new Error('unavailable'));
        const provider = makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 });
        await expect(provider.getProfilesBatch!(['sample_user', 'missing']))
            .resolves.toHaveLength(1);
    });

    it('공개 프로필 기능만 노출한다', () => {
        const provider = makeSelfHostedProvider({ fetchUser: vi.fn() });
        expect(provider.getFollowers).toBeUndefined();
        expect(provider.getFollowing).toBeUndefined();
    });
});
