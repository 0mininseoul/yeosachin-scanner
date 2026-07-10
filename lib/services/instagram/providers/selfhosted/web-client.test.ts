import { describe, expect, it, vi } from 'vitest';
import { createRequestStartGate } from './rate-limit';
import {
    createWebProfileCircuitBreaker,
    getWebProfileConfig,
    makeWebProfileFetcher,
} from './web-client';

function response(payload: unknown, status = 200, headers?: HeadersInit): Response {
    return new Response(JSON.stringify(payload), { status, headers });
}

function env(overrides: Record<string, string> = {}) {
    return {
        SELFHOSTED_PROFILE_TIMEOUT_MS: '1000',
        SELFHOSTED_PROFILE_RETRIES: '0',
        SELFHOSTED_PROFILE_RETRY_BASE_DELAY_MS: '0',
        SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '0',
        SELFHOSTED_PROFILE_CIRCUIT_COOLDOWN_MS: '1000',
        SELFHOSTED_PROFILE_SCHEMA_FAILURE_THRESHOLD: '2',
        SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD: '3',
        SELFHOSTED_PROFILE_MAX_RETRY_AFTER_MS: '60000',
        ...overrides,
    };
}

function rawUser(username: string) {
    return {
        username,
        is_private: false,
        is_verified: false,
        edge_followed_by: { count: 1 },
        edge_follow: { count: 1 },
        edge_owner_to_timeline_media: { count: 0, edges: [] },
    };
}

describe('selfhosted web profile client', () => {
    it('keeps the default cold-profile start schedule within two minutes', () => {
        const config = getWebProfileConfig({});
        expect(config.minIntervalMs).toBe(300);
        expect((350 - 1) * config.minIntervalMs).toBeLessThan(120_000);
    });

    it('returns null only for HTTP 404 or an explicit data.user=null', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 404))
            .mockResolvedValueOnce(response({ data: { user: null } }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('missing_one')).resolves.toBeNull();
        await expect(fetchProfile('missing_two')).resolves.toBeNull();
    });

    it('rejects an unexpected successful response schema', async () => {
        const fetchProfile = makeWebProfileFetcher({
            env: env(),
            fetchFn: vi.fn<typeof fetch>(async () => response({ data: {} })),
        });

        await expect(fetchProfile('target')).rejects.toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('honors Retry-After for a bounded 429 retry while other calls see the circuit', async () => {
        let clock = 0;
        const waits: number[] = [];
        const wait = async (ms: number) => {
            waits.push(ms);
            clock += ms;
        };
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({}, 429, { 'retry-after': '2' }))
            .mockResolvedValueOnce(response({ data: { user: rawUser('target') } }));
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_RETRIES: '1' }),
            fetchFn,
            now: () => clock,
            sleep: wait,
            gate: createRequestStartGate(() => clock, wait),
            circuit: createWebProfileCircuitBreaker(() => clock),
        });

        await expect(fetchProfile('target')).resolves.toMatchObject({ username: 'target' });
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(waits).toContain(2_000);
    });

    it('opens immediately after a terminal 429 and fails the next call before fetch', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({}, 429));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('first')).rejects.toThrow('rate limited');
        await expect(fetchProfile('second')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('opens after the configured successful-response schema burst threshold', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({ data: {} }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('first')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('second')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('third')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('opens after a bounded burst of retryable provider outages', async () => {
        const fetchFn = vi.fn<typeof fetch>(async () => response({}, 503));
        const fetchProfile = makeWebProfileFetcher({
            env: env({ SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD: '2' }),
            fetchFn,
        });

        await expect(fetchProfile('first')).rejects.toThrow('HTTP 503');
        await expect(fetchProfile('second')).rejects.toThrow('HTTP 503');
        await expect(fetchProfile('third')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('counts a malformed raw profile contract and username mismatch as schema failures', async () => {
        const fetchFn = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(response({ data: { user: { username: 'target' } } }))
            .mockResolvedValueOnce(response({ data: { user: rawUser('other') } }));
        const fetchProfile = makeWebProfileFetcher({ env: env(), fetchFn });

        await expect(fetchProfile('target')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('target')).rejects.toThrow('SCHEMA');
        await expect(fetchProfile('target')).rejects.toThrow('circuit is open');
        expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('rejects invalid reliability settings before making a request', () => {
        expect(() => getWebProfileConfig({ SELFHOSTED_PROFILE_RETRIES: 'unbounded' }))
            .toThrow('SCRAPING_CONFIG_ERROR');
    });
});
