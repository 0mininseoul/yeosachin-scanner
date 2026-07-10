import { describe, expect, it, vi } from 'vitest';
import {
    createFlashApiRateLimiter,
    getFlashApiConfig,
    makeFlashApiClient,
    makeFlashApiProvider,
    parseFlashApiUserId,
    parseFlashRelationshipPage,
    type FlashApiRuntimeConfig,
} from './flashapi';
import type { ProviderUsageDelta } from './types';

function user(username: string, overrides: Record<string, unknown> = {}) {
    return {
        id: '123',
        username,
        full_name: `${username} name`,
        profile_pic_url: 'https://example.com/p.jpg',
        is_private: false,
        is_verified: false,
        ...overrides,
    };
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(data), { status, headers });
}

function config(overrides: Partial<FlashApiRuntimeConfig> = {}): FlashApiRuntimeConfig {
    return {
        key: 'key',
        host: 'flashapi1.p.rapidapi.com',
        baseUrl: 'https://flashapi1.p.rapidapi.com',
        timeoutMs: 1_000,
        retries: 0,
        retryBaseDelayMs: 0,
        minIntervalMs: 0,
        maxPages: 10,
        userIdCacheTtlMs: 60_000,
        estimatedCostPerRequestUsd: 0.00099,
        minimumUniqueRatio: 0.95,
        maxRequestsPerOperation: 30,
        maxEstimatedCostUsdPerOperation: 0.03,
        rateLimitRemainingReserve: 5,
        quotaStateTtlMs: 60_000,
        ...overrides,
    };
}

function clientWith(fetchFn: typeof fetch, overrides: Partial<FlashApiRuntimeConfig> = {}) {
    return makeFlashApiClient({
        config: config(overrides),
        fetchFn,
        limiter: createFlashApiRateLimiter(Date.now, async () => undefined),
        sleep: async () => undefined,
    });
}

describe('FlashAPI user-id schema', () => {
    it.each([
        [{ id: '123' }, '123'],
        [{ id_user: 123 }, '123'],
        [{ data: { id: '123' } }, '123'],
        [{ data: { id_user: 123 } }, '123'],
        [{ id: '123', data: { id_user: 123 } }, '123'],
    ])('accepts the explicit documented locations', (payload, expected) => {
        expect(parseFlashApiUserId(payload)).toBe(expected);
    });

    it.each([
        {},
        { user_id: '123' },
        { data: { user: { id: '123' } } },
        { id: '0' },
        { id: '12x' },
        { id: '123', data: { id_user: '456' } },
    ])('rejects missing, non-decimal, zero, heuristic, or conflicting IDs', (payload) => {
        expect(() => parseFlashApiUserId(payload)).toThrow('SCRAPING_SCHEMA_ERROR');
    });
});

describe('FlashAPI relationship schema', () => {
    it('accepts root users and exact data.users envelopes', () => {
        expect(parseFlashRelationshipPage({ users: [user('alice')], next_max_id: 'c2' }))
            .toMatchObject({ users: [{ username: 'alice' }], nextMaxId: 'c2' });
        expect(parseFlashRelationshipPage({ data: { users: [user('bob')], has_more: false } }))
            .toMatchObject({ users: [{ username: 'bob' }], hasMore: false });
    });

    it.each([
        { items: [user('alice')] },
        { users: [{ username: 'alice', is_private: false }] },
        { users: [user('alice')], next_max_id: 123 },
        { users: [user('alice')], has_more: true },
        { users: [user('alice')], has_more: false, next_max_id: 'c2' },
        { data: { items: [user('alice')] } },
        { users: [user('alice')], data: { users: [user('bob')] } },
    ])('rejects unknown envelopes and malformed fields', (payload) => {
        expect(() => parseFlashRelationshipPage(payload)).toThrow();
    });
});

describe('FlashAPI pagination and reliability', () => {
    it('looks up numeric id_user and follows next_max_id until the requested limit', async () => {
        const fetchFn = vi.fn<typeof fetch>(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/ig/user_id/') {
                expect(url.searchParams.get('user')).toBe('target');
                return json({ id: '999' });
            }
            expect(url.searchParams.get('id_user')).toBe('999');
            expect(url.searchParams.has('amount')).toBe(false);
            if (!url.searchParams.has('next_max_id')) {
                return json({ users: [user('a'), user('b')], next_max_id: 'p2' });
            }
            expect(url.searchParams.get('next_max_id')).toBe('p2');
            return json({ users: [user('c'), user('d')], has_more: false });
        });
        const provider = makeFlashApiProvider(clientWith(fetchFn, { userIdCacheTtlMs: 0 }));

        const result = await provider.getFollowers!('target', 3);

        expect(result.map((item) => item.username)).toEqual(['a', 'b', 'c']);
        expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('shares one in-flight ID lookup while both cursor chains progress', async () => {
        let lookupCalls = 0;
        const paths: string[] = [];
        const fetchFn = vi.fn<typeof fetch>(async (input) => {
            const url = new URL(String(input));
            paths.push(`${url.pathname}:${url.searchParams.get('next_max_id') ?? 'first'}`);
            if (url.pathname === '/ig/user_id/') {
                lookupCalls++;
                await Promise.resolve();
                return json({ id_user: '999' });
            }
            const prefix = url.pathname.includes('followers') ? 'f' : 'g';
            const cursor = url.searchParams.get('next_max_id');
            return cursor
                ? json({ users: [user(`${prefix}2`)], has_more: false })
                : json({ users: [user(`${prefix}1`)], next_max_id: `${prefix}-next` });
        });
        const provider = makeFlashApiProvider(clientWith(fetchFn, { userIdCacheTtlMs: 0 }));

        const [followers, following] = await Promise.all([
            provider.getFollowers!('target', 2),
            provider.getFollowing!('target', 2),
        ]);

        expect(lookupCalls).toBe(1);
        expect(followers.map((item) => item.username)).toEqual(['f1', 'f2']);
        expect(following.map((item) => item.username)).toEqual(['g1', 'g2']);
        expect(paths.filter((path) => path.startsWith('/ig/followers/'))).toHaveLength(2);
        expect(paths.filter((path) => path.startsWith('/ig/following/'))).toHaveLength(2);
    });

    it('retries retryable responses and accounts for each network request', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(json({ error: 'temporary' }, 500))
            .mockResolvedValueOnce(json({ id: '999' }));
        let requestCount = 0;
        const client = clientWith(fetchFn, { retries: 1 });

        await expect(client.resolveUserId('target', {
            recordUsage(delta) {
                requestCount += delta.request_count ?? 0;
            },
        })).resolves.toBe('999');
        expect(requestCount).toBe(2);
    });

    it('does not report missing rate-limit headers as zero', async () => {
        const deltas: ProviderUsageDelta[] = [];
        const client = clientWith(vi.fn<typeof fetch>(async () => json({ id: '999' })));

        await client.resolveUserId('target', {
            recordUsage(delta) {
                deltas.push(delta);
            },
        });

        expect(deltas.some((delta) =>
            Object.hasOwn(delta, 'rate_limit_limit') ||
            Object.hasOwn(delta, 'rate_limit_remaining')
        )).toBe(false);
    });

    it('captures valid rate-limit headers on rejected responses', async () => {
        const deltas: ProviderUsageDelta[] = [];
        const client = clientWith(vi.fn<typeof fetch>(async () =>
            json({ error: 'limited' }, 429, {
                'x-ratelimit-requests-limit': '1000',
                'x-ratelimit-requests-remaining': '3',
            })
        ));

        await expect(client.resolveUserId('target', {
            recordUsage(delta) {
                deltas.push(delta);
            },
        })).rejects.toThrow('HTTP 429');
        expect(deltas).toContainEqual({
            rate_limit_limit: 1000,
            rate_limit_remaining: 3,
        });
    });

    it('counts lookup, retries, and pages against one provider-operation request ceiling', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(json({ error: 'temporary' }, 500))
            .mockResolvedValueOnce(json({ id: '999' }))
            .mockResolvedValueOnce(json({ users: [user('a')], next_max_id: 'p2' }));
        const provider = makeFlashApiProvider(clientWith(fetchFn, {
            retries: 1,
            maxRequestsPerOperation: 3,
            maxEstimatedCostUsdPerOperation: 1,
            rateLimitRemainingReserve: 0,
        }));

        await expect(provider.getFollowers!('target', 2)).rejects.toThrow('request ceiling');
        expect(fetchFn).toHaveBeenCalledTimes(3);
    });

    it('stops before exceeding the per-operation estimated-cost ceiling', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => json({ id: '999' }));
        const provider = makeFlashApiProvider(clientWith(fetchFn, {
            estimatedCostPerRequestUsd: 0.001,
            maxEstimatedCostUsdPerOperation: 0.0015,
            rateLimitRemainingReserve: 0,
        }));

        await expect(provider.getFollowers!('target', 1)).rejects.toThrow('cost ceiling');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('preserves the configured remaining-quota reserve after observing headers', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () =>
            json({ id: '999' }, 200, { 'x-ratelimit-requests-remaining': '5' })
        );
        const provider = makeFlashApiProvider(clientWith(fetchFn, {
            maxEstimatedCostUsdPerOperation: 1,
            rateLimitRemainingReserve: 5,
        }));

        await expect(provider.getFollowers!('target', 1)).rejects.toThrow('quota reserve');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('shares observed remaining quota across concurrent logical operations', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () =>
            json({ id: '999' }, 200, { 'x-ratelimit-requests-remaining': '5' })
        );
        const client = clientWith(fetchFn, {
            maxEstimatedCostUsdPerOperation: 1,
            rateLimitRemainingReserve: 5,
        });

        await expect(client.resolveUserId('first')).resolves.toBe('999');
        await expect(client.resolveUserId('second')).rejects.toThrow('quota reserve');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['reset header', { 'x-ratelimit-requests-reset': '1' }, 1_001],
        ['fallback TTL', {}, 1_001],
    ])('reopens the shared quota guard after the %s expires', async (_label, headers, resumeAt) => {
        let clock = 0;
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(json(
                { id: '111' },
                200,
                { 'x-ratelimit-requests-remaining': '5', ...headers }
            ))
            .mockResolvedValueOnce(json({ id: '222' }));
        const client = makeFlashApiClient({
            config: config({
                maxEstimatedCostUsdPerOperation: 1,
                rateLimitRemainingReserve: 5,
                quotaStateTtlMs: 1_000,
            }),
            fetchFn,
            limiter: createFlashApiRateLimiter(() => clock, async () => undefined),
            sleep: async () => undefined,
            now: () => clock,
        });

        await expect(client.resolveUserId('first')).resolves.toBe('111');
        await expect(client.resolveUserId('blocked')).rejects.toThrow('quota reserve');
        clock = resumeAt;
        await expect(client.resolveUserId('after_reset')).resolves.toBe('222');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('does not let an out-of-order quota response raise shared remaining quota', async () => {
        let finishOlder!: (response: Response) => void;
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(json(
                { id: '111' },
                200,
                {
                    'x-ratelimit-requests-remaining': '8',
                    'x-ratelimit-requests-reset': '100',
                }
            ))
            .mockImplementationOnce(() => new Promise<Response>((resolve) => {
                finishOlder = resolve;
            }))
            .mockResolvedValueOnce(json(
                { id: '333' },
                200,
                {
                    'x-ratelimit-requests-remaining': '6',
                    'x-ratelimit-requests-reset': '100',
                }
            ))
            .mockResolvedValueOnce(json({ id: '444' }));
        const client = clientWith(fetchFn, {
            maxEstimatedCostUsdPerOperation: 1,
            rateLimitRemainingReserve: 5,
        });

        await expect(client.resolveUserId('seed')).resolves.toBe('111');
        const older = client.resolveUserId('older');
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
        await expect(client.resolveUserId('newer')).resolves.toBe('333');
        finishOlder(json(
            { id: '222' },
            200,
            {
                'x-ratelimit-requests-remaining': '7',
                'x-ratelimit-requests-reset': '100',
            }
        ));
        await expect(older).resolves.toBe('222');

        await expect(client.resolveUserId('last_allowed')).resolves.toBe('444');
        await expect(client.resolveUserId('blocked')).rejects.toThrow('quota reserve');
        expect(fetchFn).toHaveBeenCalledTimes(4);
    });

    it('ignores a late response from the expired quota window', async () => {
        let clock = 0;
        let finishExpired!: (response: Response) => void;
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(json(
                { id: '111' },
                200,
                {
                    'x-ratelimit-requests-remaining': '7',
                    'x-ratelimit-requests-reset': '1',
                }
            ))
            .mockImplementationOnce(() => new Promise<Response>((resolve) => {
                finishExpired = resolve;
            }))
            .mockResolvedValueOnce(json(
                { id: '333' },
                200,
                {
                    'x-ratelimit-requests-remaining': '100',
                    'x-ratelimit-requests-reset': '100',
                }
            ))
            .mockResolvedValueOnce(json({ id: '444' }));
        const client = makeFlashApiClient({
            config: config({
                maxEstimatedCostUsdPerOperation: 1,
                rateLimitRemainingReserve: 5,
            }),
            fetchFn,
            limiter: createFlashApiRateLimiter(() => clock, async () => undefined),
            sleep: async () => undefined,
            now: () => clock,
        });

        await expect(client.resolveUserId('seed')).resolves.toBe('111');
        const expired = client.resolveUserId('expired');
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
        clock = 1_001;
        await expect(client.resolveUserId('new_window')).resolves.toBe('333');
        finishExpired(json(
            { id: '222' },
            200,
            {
                'x-ratelimit-requests-remaining': '5',
                'x-ratelimit-requests-reset': '1',
            }
        ));
        await expect(expired).resolves.toBe('222');

        await expect(client.resolveUserId('still_allowed')).resolves.toBe('444');
        expect(fetchFn).toHaveBeenCalledTimes(4);
    });

    it('reserves observed quota before an overlapping request response arrives', async () => {
        let finishSecond!: (response: Response) => void;
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(
                json({ id: '111' }, 200, { 'x-ratelimit-requests-remaining': '6' })
            )
            .mockImplementationOnce(() => new Promise<Response>((resolve) => {
                finishSecond = resolve;
            }));
        const client = clientWith(fetchFn, {
            maxEstimatedCostUsdPerOperation: 1,
            rateLimitRemainingReserve: 5,
        });

        await expect(client.resolveUserId('first')).resolves.toBe('111');
        const second = client.resolveUserId('second');
        await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
        await expect(client.resolveUserId('third')).rejects.toThrow('quota reserve');
        expect(fetchFn).toHaveBeenCalledTimes(2);

        finishSecond(json(
            { id: '222' },
            200,
            { 'x-ratelimit-requests-remaining': '5' }
        ));
        await expect(second).resolves.toBe('222');
    });

    it('enforces request timeouts', async () => {
        const fetchFn = vi.fn<typeof fetch>(async (_input, init) =>
            new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('aborted', 'AbortError'));
                });
            })
        );
        const client = clientWith(fetchFn, { timeoutMs: 5 });
        await expect(client.resolveUserId('target')).rejects.toThrow('AMBIGUOUS');
    });

    it('rejects an empty page with a cursor', async () => {
        const client = clientWith(vi.fn<typeof fetch>(async () =>
            json({ users: [], next_max_id: 'next' })
        ));
        await expect(client.getRelationshipByUserId('999', 'followers', 10))
            .rejects.toThrow('INCOMPLETE');
    });

    it('rejects cursor cycles', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(json({ users: [user('a')], next_max_id: 'same' }))
            .mockResolvedValueOnce(json({ users: [user('b')], next_max_id: 'same' }));
        const client = clientWith(fetchFn, { minimumUniqueRatio: 0 });
        await expect(client.getRelationshipByUserId('999', 'followers', 10))
            .rejects.toThrow('next_max_id');
    });

    it('enforces the configured 95% unique ratio', async () => {
        const passing = Array.from({ length: 19 }, (_, index) => user(`u${index}`));
        passing.push(user('u0'));
        const passClient = clientWith(vi.fn<typeof fetch>(async () =>
            json({ users: passing, has_more: false })
        ));
        await expect(passClient.getRelationshipByUserId('999', 'followers', 19))
            .resolves.toHaveLength(19);

        const failing = Array.from({ length: 18 }, (_, index) => user(`v${index}`));
        failing.push(user('v0'), user('v1'));
        const failClient = clientWith(vi.fn<typeof fetch>(async () =>
            json({ users: failing, has_more: false })
        ));
        await expect(failClient.getRelationshipByUserId('999', 'followers', 20))
            .rejects.toThrow('중복 비율');
    });

    it('rejects pages below the production 60% unique ratio floor', async () => {
        const users = Array.from({ length: 5 }, (_, index) => user(`floor${index}`));
        while (users.length < 9) users.push(user('floor0'));
        const client = clientWith(vi.fn<typeof fetch>(async () =>
            json({ users, has_more: false })
        ), { minimumUniqueRatio: 0.6 });

        await expect(client.getRelationshipByUserId('999', 'followers', 9))
            .rejects.toThrow('중복 비율');
    });

    it('rejects advancing cursors that repeatedly add no unique users', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(json({ users: [user('a')], next_max_id: 'c1' }))
            .mockResolvedValueOnce(json({ users: [user('a')], next_max_id: 'c2' }))
            .mockResolvedValueOnce(json({ users: [user('a')], next_max_id: 'c3' }));
        const client = clientWith(fetchFn, { minimumUniqueRatio: 0 });
        await expect(client.getRelationshipByUserId('999', 'followers', 10))
            .rejects.toThrow('새 결과');
    });

    it('collects 1,000 users at the accepted 60% unique ratio within production bounds', async () => {
        let page = 0;
        let nextUnique = 0;
        const newUsersPerPage = [6, 5, 6, 5, 5];
        const fetchFn = vi.fn<typeof fetch>(async (input) => {
            const url = new URL(String(input));
            if (url.pathname === '/ig/user_id/') return json({ id: '999' });

            const newCount = newUsersPerPage[page % newUsersPerPage.length];
            const users = Array.from({ length: newCount }, () => user(`u${nextUnique++}`));
            while (users.length < 9) users.push(user('u0'));
            page++;
            return json({ users, next_max_id: `page-${page}` });
        });
        let requestCount = 0;
        const provider = makeFlashApiProvider(clientWith(fetchFn, {
            minimumUniqueRatio: 0.6,
            maxPages: 200,
            maxRequestsPerOperation: 210,
            maxEstimatedCostUsdPerOperation: 0.21,
            rateLimitRemainingReserve: 0,
        }));

        await expect(provider.getFollowing!('target', 1_000, {
            recordUsage(delta) {
                requestCount += delta.request_count ?? 0;
            },
        })).resolves.toHaveLength(1_000);
        expect(page).toBe(186);
        expect(requestCount).toBe(187);
    });
});

describe('shared FlashAPI rate gate', () => {
    it('allows the next request to start after the interval while the prior fetch is in flight', async () => {
        let clock = 0;
        const sleeps: number[] = [];
        const limiter = createFlashApiRateLimiter(
            () => clock,
            async (ms) => {
                sleeps.push(ms);
                clock += ms;
            }
        );
        let finishFirst!: () => void;
        let secondStarted = false;
        const first = limiter.schedule(() => new Promise<void>((resolve) => {
            finishFirst = resolve;
        }), 100);
        await Promise.resolve();
        await Promise.resolve();

        const second = limiter.schedule(async () => {
            secondStarted = true;
        }, 100);
        await second;

        expect(secondStarted).toBe(true);
        expect(sleeps).toEqual([100]);
        finishFirst();
        await first;
    });
});

describe('FlashAPI config', () => {
    it('uses the fixed Flash host, ignores legacy host, and has a non-zero cost estimate', () => {
        const parsed = getFlashApiConfig({ RAPIDAPI_KEY: 'key', RAPIDAPI_HOST: 'legacy.example' });
        expect(parsed.host).toBe('flashapi1.p.rapidapi.com');
        expect(parsed.estimatedCostPerRequestUsd).toBe(0.00099);
        expect(parsed.minimumUniqueRatio).toBe(0.6);
        expect(parsed.maxPages).toBe(200);
        expect(parsed.maxRequestsPerOperation).toBe(210);
        expect(parsed.maxEstimatedCostUsdPerOperation).toBe(0.21);
        expect(parsed.rateLimitRemainingReserve).toBe(5);
        expect(parsed.quotaStateTtlMs).toBe(86_400_000);
    });

    it('rejects non-integer retry/page settings and non-Flash hosts', () => {
        expect(() => getFlashApiConfig({ RAPIDAPI_KEY: 'key', FLASHAPI_RETRIES: '1.5' }))
            .toThrow('정수');
        expect(() => getFlashApiConfig({
            RAPIDAPI_KEY: 'key',
            FLASHAPI_MAX_REQUESTS_PER_OPERATION: '0',
        })).toThrow('FLASHAPI_MAX_REQUESTS_PER_OPERATION');
        expect(() => getFlashApiConfig({
            RAPIDAPI_KEY: 'key',
            FLASHAPI_RAPIDAPI_HOST: 'other.example',
        })).toThrow('flashapi1.p.rapidapi.com');
    });
});
