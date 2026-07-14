import { describe, it, expect, vi } from 'vitest';
import fixture from './__fixtures__/web-profile-info.json';
import { getSelfHostedProfileConcurrency, makeSelfHostedProvider } from './index';

const user = (fixture as { data: { user: Record<string, unknown> } }).data.user;
const timeline = user.edge_owner_to_timeline_media as { count: number; edges: unknown[] };
const completeUser = {
    ...user,
    edge_owner_to_timeline_media: {
        ...timeline,
        count: timeline.edges.length,
    },
};

describe('selfHostedProvider', () => {
    it('uses the bounded production concurrency needed for the cold-profile latency budget', () => {
        expect(getSelfHostedProfileConcurrency({})).toBe(4);
        expect(() => getSelfHostedProfileConcurrency({
            SELFHOSTED_PROFILE_CONCURRENCY: '6',
        })).toThrow('SCRAPING_CONFIG_ERROR');
    });

    it('getProfile은 web-client 결과를 InstagramProfile로 매핑한다', async () => {
        const fetchUser = vi.fn().mockResolvedValue(completeUser);
        const provider = makeSelfHostedProvider({ fetchUser });
        const profile = await provider.getProfile!('sample_user');
        expect(profile?.username).toBe('sample_user');
        expect(profile?.latestPosts).toHaveLength(2);
        expect(fetchUser).toHaveBeenCalledWith('sample_user');
    });

    it('getProfileSummary는 피드 완전성과 무관하게 최신 계정 수를 반환한다', async () => {
        const fetchUser = vi.fn().mockResolvedValue({
            ...user,
            edge_owner_to_timeline_media: { count: 87, edges: [] },
        });
        const provider = makeSelfHostedProvider({ fetchUser });

        await expect(provider.getProfileSummary!('sample_user')).resolves.toMatchObject({
            username: 'sample_user',
            followersCount: 1234,
            followingCount: 321,
            postsCount: 87,
        });
        expect((await provider.getProfileSummary!('sample_user'))?.latestPosts).toBeUndefined();
    });

    it('getProfile은 계정 없음(null)을 그대로 null로 반환한다', async () => {
        const provider = makeSelfHostedProvider({ fetchUser: vi.fn().mockResolvedValue(null) });
        expect(await provider.getProfile!('ghost')).toBeNull();
    });

    it('getProfilesBatch는 전체 요청이 있을 때 결과를 반환한다', async () => {
        const fetchUser = vi.fn().mockResolvedValue(completeUser);
        const provider = makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 });
        const results = await provider.getProfilesBatch!(['sample_user']);
        expect(results).toHaveLength(1);
        expect(results[0].username).toBe('sample_user');
    });

    it('getProfilesBatch는 성공한 부분 결과를 반환해 router가 누락만 보충하게 한다', async () => {
        const fetchUser = vi
            .fn()
            .mockResolvedValueOnce(completeUser)
            .mockRejectedValueOnce(new Error('unavailable'));
        const provider = makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 });
        await expect(provider.getProfilesBatch!(['sample_user', 'missing']))
            .resolves.toHaveLength(1);
    });

    it('getProfilesBatchOutcomes keeps one terminal result for every requested username', async () => {
        const fetchUser = vi.fn(async (username: string) => {
            if (username === 'sample_user') return completeUser;
            if (username === 'empty') return null;
            if (username === 'broken') throw new Error('SCRAPING_SCHEMA_ERROR: invalid shape');
            throw new Error('network exploded');
        });
        const provider = makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 });

        const results = await provider.getProfilesBatchOutcomes!([
            'sample_user',
            'empty',
            'broken',
            'failed',
        ]);

        expect(results.map(result => [
            result.outcome.requestedUsername,
            result.outcome.status,
            result.outcome.failureCategory,
        ])).toEqual([
            ['sample_user', 'success', null],
            ['empty', 'unavailable', 'empty_user'],
            ['broken', 'failed', 'schema'],
            ['failed', 'failed', 'transport'],
        ]);
        expect(results.every(result =>
            result.outcome.requestCount === 1
            && result.outcome.latencyMs >= 0
            && result.outcome.latencyMs <= 300_000
        )).toBe(true);
    });

    it('emits an exact start heartbeat before each bounded profile fetch', async () => {
        const order: string[] = [];
        const provider = makeSelfHostedProvider({
            concurrency: 1,
            retries: 0,
            fetchUser: vi.fn(async username => {
                order.push(`fetch:${username}`);
                return completeUser;
            }),
        });

        await provider.getProfilesBatchOutcomes!(['first', 'second'], 2, {
            recordUsage: () => undefined,
            onProfileStart: async username => {
                order.push(`start:${username}`);
            },
            onProfileResolved: async () => {
                order.push('resolved');
            },
        });

        expect(order).toEqual([
            'start:first', 'fetch:first', 'resolved',
            'start:second', 'fetch:second', 'resolved',
        ]);
    });

    it('does not mark an unresolved primary profile as completed work', async () => {
        const onProfileResolved = vi.fn(async () => undefined);
        const provider = makeSelfHostedProvider({
            concurrency: 1,
            retries: 0,
            fetchUser: vi.fn(async () => null),
        });

        await provider.getProfilesBatchOutcomes!(['missing'], 1, {
            recordUsage: () => undefined,
            onProfileResolved,
        });

        expect(onProfileResolved).not.toHaveBeenCalled();
    });

    it('treats crawler configuration failures as a job-level error', async () => {
        const fetchUser = vi.fn().mockRejectedValue(
            new Error('SCRAPING_CONFIG_ERROR: selfhosted transport is not configured.')
        );
        const provider = makeSelfHostedProvider({ fetchUser, concurrency: 1, retries: 0 });

        await expect(provider.getProfilesBatchOutcomes!(['sample_user']))
            .rejects.toThrow('SCRAPING_CONFIG_ERROR');
        await expect(provider.getProfilesBatch!(['sample_user']))
            .rejects.toThrow('SCRAPING_CONFIG_ERROR');
    });

    it('공개 프로필 기능만 노출한다', () => {
        const provider = makeSelfHostedProvider({ fetchUser: vi.fn() });
        expect(provider.getFollowers).toBeUndefined();
        expect(provider.getFollowing).toBeUndefined();
    });
});
