import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ScraperProvider, ScraperTelemetryEvent } from './providers/types';
import type { InstagramProfile } from '@/lib/types/instagram';
import {
    getInstagramProfile,
    getFollowers,
    getFollowing,
    getProfilesBatch,
    extractMutualFollows,
    classifyByPrivacy,
    __setProvidersForTest,
    __resetProvidersForTest,
} from './scraper';

afterEach(() => __resetProvidersForTest());

function providerWith(over: Partial<ScraperProvider>): ScraperProvider {
    return { name: 'selfhosted', ...over } as ScraperProvider;
}

describe('라우팅', () => {
    it('SCRAPER_PROFILE=selfhosted면 selfhosted.getProfile을 쓴다', async () => {
        const getProfile = vi.fn().mockResolvedValue({ username: 'x' });
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted' },
            { selfhosted: providerWith({ name: 'selfhosted', getProfile }) }
        );
        const p = await getInstagramProfile('x');
        expect(p).toEqual({ username: 'x' });
        expect(getProfile).toHaveBeenCalledWith('x', expect.objectContaining({
            recordUsage: expect.any(Function),
        }));
    });

    it('optional trailing options로 요청별 프로바이더를 고른다', async () => {
        const flash = vi.fn().mockResolvedValue([]);
        const apify = vi.fn().mockResolvedValue([]);
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'flashapi' },
            {
                flashapi: providerWith({ name: 'flashapi', getFollowers: flash }),
                apify: providerWith({ name: 'apify', getFollowers: apify }),
            }
        );

        await getFollowers('x', 10, { provider: 'apify', fallback: false });

        expect(apify).toHaveBeenCalledOnce();
        expect(flash).not.toHaveBeenCalled();
    });

    it('stored Apify run ID가 있으면 원래 primary 대신 같은 run을 재개한다', async () => {
        const selfhosted = vi.fn().mockResolvedValue({ username: 'selfhosted-result' });
        const apify = vi.fn().mockResolvedValue({ username: 'apify-result' });
        const onCostRunStarted = vi.fn();
        const onCostRunFinished = vi.fn();
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted', SCRAPER_FALLBACK: 'true' },
            {
                selfhosted: providerWith({ name: 'selfhosted', getProfile: selfhosted }),
                apify: providerWith({ name: 'apify', getProfile: apify }),
            }
        );

        await expect(getInstagramProfile('x', {
            providerRun: {
                resumeRunId: 'StoredRun12345678',
                logicalProvider: 'apify',
                actorId: 'apify/profile-scraper',
                credentialSlot: 'secondary',
                maxChargeUsd: 0.25,
                onRunStarted: vi.fn(),
                onCostRunStarted,
                onCostRunFinished,
            },
        })).resolves.toEqual({ username: 'apify-result' });

        expect(selfhosted).not.toHaveBeenCalled();
        expect(apify).toHaveBeenCalledWith('x', expect.objectContaining({
            resumeRunId: 'StoredRun12345678',
            credentialSlot: 'secondary',
            maxChargeUsd: 0.25,
            onCostRunStarted,
            onCostRunFinished,
        }));
    });

    it('stored CoderX run ID는 Scraping Solutions parser로 보내지 않는다', async () => {
        const apify = vi.fn().mockResolvedValue([]);
        const coderx = vi.fn().mockResolvedValue([]);
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'apify', SCRAPER_FALLBACK: 'false' },
            {
                apify: providerWith({ name: 'apify', getFollowers: apify }),
                coderx: providerWith({ name: 'coderx', getFollowers: coderx }),
            }
        );

        await getFollowers('x', 1, {
            providerRun: {
                resumeRunId: 'CoderxRun12345678',
                logicalProvider: 'coderx',
                actorId: 'coderx/instagram-followers',
                credentialSlot: 'primary',
                maxChargeUsd: 0.1,
            },
        });

        expect(coderx).toHaveBeenCalledWith('x', 1, expect.objectContaining({
            logicalProvider: 'coderx',
            resumeRunId: 'CoderxRun12345678',
            credentialSlot: 'primary',
            maxChargeUsd: 0.1,
        }));
        expect(apify).not.toHaveBeenCalled();
    });

    it('프로필 provider에 outer batch 크기를 그대로 전달할 수 있다', async () => {
        const profilesBatch = vi.fn().mockResolvedValue([
            { username: 'alice' },
            { username: 'bob' },
        ]);
        __setProvidersForTest(
            { SCRAPER_PROFILES_BATCH: 'apify', SCRAPER_FALLBACK: 'false' },
            { apify: providerWith({ name: 'apify', getProfilesBatch: profilesBatch }) }
        );

        await getProfilesBatch(['alice', 'bob'], 2);
        expect(profilesBatch).toHaveBeenCalledWith(
            ['alice', 'bob'],
            2,
            expect.objectContaining({ recordUsage: expect.any(Function) })
        );
    });
});

describe('폴백', () => {
    it('fallback=true면 selfhosted 실패 시 외부(apify)로 폴백한다', async () => {
        const selfFail = vi.fn().mockRejectedValue(new Error('SCRAPING_ERROR: blocked'));
        const apifyOk = vi.fn().mockResolvedValue({ username: 'fallback' });
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted', SCRAPER_FALLBACK: 'true' },
            {
                selfhosted: providerWith({ name: 'selfhosted', getProfile: selfFail }),
                apify: providerWith({ name: 'apify', getProfile: apifyOk }),
            }
        );
        const p = await getInstagramProfile('x');
        expect(p).toEqual({ username: 'fallback' });
        expect(selfFail).toHaveBeenCalled();
        expect(apifyOk).toHaveBeenCalled();
    });

    it('fallback=false면 selfhosted 실패가 그대로 throw된다', async () => {
        const selfFail = vi.fn().mockRejectedValue(new Error('SCRAPING_ERROR: blocked'));
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted', SCRAPER_FALLBACK: 'false' },
            { selfhosted: providerWith({ name: 'selfhosted', getProfile: selfFail }) }
        );
        await expect(getInstagramProfile('x')).rejects.toThrow('blocked');
    });

    it('수동 FlashAPI relationship 실패는 자동 폴백 없이 telemetry를 남긴다', async () => {
        const flash = vi.fn(async (_username, _limit, context) => {
            context?.recordUsage({
                request_count: 2,
                estimated_cost_usd: 0.002,
                rate_limit_limit: 100,
                rate_limit_remaining: 9,
            });
            context?.recordUsage({ rate_limit_limit: 90, rate_limit_remaining: 7 });
            throw new Error('primary failed');
        });
        const apify = vi.fn(async (_username, _limit, context) => {
            context?.recordUsage({
                request_count: 1,
                result_count: 2,
                raw_result_count: 2,
                unique_result_count: 2,
                estimated_cost_usd: 0.0017,
            });
            return [
                { username: 'a', isPrivate: false, isVerified: false },
                { username: 'b', isPrivate: false, isVerified: false },
            ];
        });
        const events: ScraperTelemetryEvent[] = [];
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'flashapi', SCRAPER_FALLBACK: 'true' },
            {
                flashapi: providerWith({ name: 'flashapi', paid: true, getFollowers: flash }),
                apify: providerWith({ name: 'apify', paid: true, getFollowers: apify }),
            }
        );

        await expect(getFollowers('x', 2, {
            provider: 'flashapi',
            requestId: 'request-1',
            onTelemetry: (event) => {
                events.push(event);
            },
        })).rejects.toThrow('primary failed');

        expect(events).toMatchObject([
            {
                provider: 'flashapi',
                fallback: false,
                status: 'error',
                request_count: 2,
                rate_limit_limit: 100,
                rate_limit_remaining: 7,
            },
        ]);
        expect(apify).not.toHaveBeenCalled();
    });

    it('provider 비용 상한 중단을 budget telemetry로 분류한다', async () => {
        const events: ScraperTelemetryEvent[] = [];
        const flash = vi.fn().mockRejectedValue(
            new Error('SCRAPING_BUDGET_ERROR: operation cost ceiling reached')
        );
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'flashapi', SCRAPER_FALLBACK: 'false' },
            { flashapi: providerWith({ name: 'flashapi', getFollowers: flash }) }
        );

        await expect(getFollowers('x', 1, {
            onTelemetry: (event) => {
                events.push(event);
            },
        }))
            .rejects.toThrow('BUDGET');
        expect(events).toMatchObject([{
            status: 'error',
            failure_category: 'budget',
        }]);
    });

    it('explicit CoderX는 실패해도 자동 폴백하지 않는다', async () => {
        const coderx = vi.fn().mockRejectedValue(new Error('coderx failed'));
        const apify = vi.fn().mockResolvedValue([]);
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'flashapi', SCRAPER_FALLBACK: 'true' },
            {
                coderx: providerWith({ name: 'coderx', getFollowers: coderx }),
                apify: providerWith({ name: 'apify', getFollowers: apify }),
            }
        );

        await expect(getFollowers('x', 10, { provider: 'coderx', fallback: true }))
            .rejects.toThrow('coderx failed');
        expect(apify).not.toHaveBeenCalled();
    });

    it('불완전 결과로 실패해도 수집된 건수를 telemetry에 보존한다', async () => {
        const flash = vi.fn(async (_username, _limit, context) => {
            context?.recordUsage({ result_count: 1 });
            return [{ username: 'a', isPrivate: false, isVerified: false }];
        });
        const events: ScraperTelemetryEvent[] = [];
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'flashapi', SCRAPER_FALLBACK: 'false' },
            { flashapi: providerWith({ name: 'flashapi', getFollowers: flash }) }
        );

        await expect(getFollowers('x', 2, {
            expectedResultCount: 2,
            onTelemetry: (event) => {
                events.push(event);
            },
        })).rejects.toThrow('INCOMPLETE');

        expect(events).toMatchObject([{
            status: 'error',
            result_count: 1,
            raw_result_count: 1,
            unique_result_count: 1,
            expected_result_count: 2,
            minimum_complete_count: 2,
            coverage_ratio: 0.5,
            failure_category: 'incomplete',
        }]);
    });

    it('Apify primary도 선언 count 대비 99% 완전성을 충족해야 한다', async () => {
        const short = Array.from({ length: 98 }, (_, index) => ({ username: `u${index}` }));
        const complete = Array.from({ length: 99 }, (_, index) => ({ username: `v${index}` }));
        const apify = vi.fn().mockResolvedValue(short);
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'apify', SCRAPER_FALLBACK: 'true' },
            {
                apify: providerWith({ name: 'apify', getFollowers: apify }),
            }
        );

        await expect(getFollowers('x', 100, { expectedResultCount: 100 }))
            .rejects.toThrow('INCOMPLETE');

        apify.mockResolvedValue(complete);
        await expect(getFollowers('x', 100, { expectedResultCount: 100 }))
            .resolves.toHaveLength(99);
        expect(apify).toHaveBeenCalledTimes(2);
    });

    it('following 완전성도 대소문자 중복을 제외한 고유 username으로 판정한다', async () => {
        const following = vi.fn().mockResolvedValue([
            ...Array.from({ length: 98 }, (_, index) => ({
                username: `user_${index}`,
                isPrivate: false,
                isVerified: false,
            })),
            { username: 'USER_0', isPrivate: false, isVerified: false },
        ]);
        __setProvidersForTest(
            { SCRAPER_FOLLOWING: 'apify', SCRAPER_FALLBACK: 'true' },
            { apify: providerWith({ name: 'apify', getFollowing: following }) }
        );

        await expect(getFollowing('x', 100, { expectedResultCount: 100 }))
            .rejects.toThrow('INCOMPLETE');
        expect(following).toHaveBeenCalledOnce();
    });

    it('선언 count로 provider limit을 낮추고 0이면 유료 네트워크 호출을 생략한다', async () => {
        const followers = vi.fn().mockResolvedValue([]);
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'apify' },
            { apify: providerWith({ name: 'apify', getFollowers: followers }) }
        );

        await getFollowers('x', 1_000, { expectedResultCount: 0 });
        expect(followers).toHaveBeenCalledWith(
            'x',
            0,
            expect.objectContaining({ recordUsage: expect.any(Function) })
        );

        followers.mockResolvedValue(Array.from({ length: 474 }, (_, index) => ({
            username: `user_${index}`,
            isPrivate: false,
            isVerified: false,
        })));
        await getFollowers('x', 1_000, { expectedResultCount: 474 });
        expect(followers).toHaveBeenLastCalledWith(
            'x',
            474,
            expect.objectContaining({ recordUsage: expect.any(Function) })
        );
    });

    it('잘못된 완전성 옵션은 유료 프로바이더를 호출하기 전에 거부한다', async () => {
        const flash = vi.fn().mockResolvedValue([]);
        __setProvidersForTest(
            { SCRAPER_FOLLOWERS: 'flashapi' },
            { flashapi: providerWith({ name: 'flashapi', getFollowers: flash }) }
        );

        await expect(getFollowers('x', 10, { expectedResultCount: 11 })).rejects.toThrow('CONFIG');
        expect(flash).not.toHaveBeenCalled();
    });

    it('프로필 배치의 primary 성공분을 보존하고 누락만 fallback으로 보충한다', async () => {
        const incomplete = vi.fn().mockResolvedValue([{ username: 'alice' }]);
        const complete = vi.fn().mockResolvedValue([{ username: 'bob' }]);
        __setProvidersForTest(
            { SCRAPER_PROFILES_BATCH: 'selfhosted', SCRAPER_FALLBACK: 'true' },
            {
                selfhosted: providerWith({ name: 'selfhosted', getProfilesBatch: incomplete }),
                apify: providerWith({ name: 'apify', getProfilesBatch: complete }),
            }
        );

        await expect(getProfilesBatch(['alice', 'bob'])).resolves.toHaveLength(2);
        expect(incomplete).toHaveBeenCalledOnce();
        expect(complete).toHaveBeenCalledOnce();
        expect(complete).toHaveBeenCalledWith(
            ['bob'],
            1,
            expect.objectContaining({ recordUsage: expect.any(Function) })
        );

        complete.mockResolvedValue([]);
        await expect(getProfilesBatch(['alice', 'bob']))
            .rejects.toThrow('SCRAPING_INCOMPLETE_ERROR');
    });

    it('durable 프로필 fallback은 재개 가능한 고정 배치 전체를 실행한다', async () => {
        const makeProfile = (username: string): InstagramProfile => ({
            username,
            followersCount: 0,
            followingCount: 0,
            postsCount: 0,
            isPrivate: false,
            isVerified: false,
        });
        const primary = vi.fn(async () => [makeProfile('first')]);
        const fallback = vi.fn(async (usernames: string[]) => usernames.map(makeProfile));
        __setProvidersForTest({
            SCRAPER_PROFILES_BATCH: 'selfhosted',
            SCRAPER_FALLBACK: 'true',
        }, {
            selfhosted: providerWith({
                name: 'selfhosted',
                paid: false,
                getProfilesBatch: primary,
            }),
            apify: providerWith({
                name: 'apify',
                paid: true,
                getProfilesBatch: fallback,
            }),
        });

        const result = await getProfilesBatch(['first', 'second'], 2, {
            providerRun: {},
        });

        expect(fallback).toHaveBeenCalledWith(
            ['first', 'second'],
            2,
            expect.any(Object)
        );
        expect(result.map(item => item.username)).toEqual(['first', 'second']);
    });
});

describe('순수 헬퍼', () => {
    it('extractMutualFollows는 교집합을 낸다', () => {
        const a = [{ username: 'u1' }, { username: 'U2' }] as never[];
        const b = [{ username: 'u2' }, { username: 'u3' }] as never[];
        expect(extractMutualFollows(a, b).map((x) => x.username)).toEqual(['u2']);
    });
    it('extractMutualFollows는 following 응답 순서를 보존한다', () => {
        const followers = [
            { username: 'third' },
            { username: 'first' },
            { username: 'second' },
        ] as never[];
        const following = [
            { username: 'first' },
            { username: 'not_mutual' },
            { username: 'second' },
            { username: 'third' },
        ] as never[];

        expect(extractMutualFollows(followers, following).map((x) => x.username))
            .toEqual(['first', 'second', 'third']);
    });
    it('classifyByPrivacy는 공개/비공개로 나눈다', () => {
        const accts = [
            { username: 'a', isPrivate: false },
            { username: 'b', isPrivate: true },
        ] as never[];
        const { publicAccounts, privateAccounts } = classifyByPrivacy(accts);
        expect(publicAccounts).toHaveLength(1);
        expect(privateAccounts).toHaveLength(1);
    });
});
