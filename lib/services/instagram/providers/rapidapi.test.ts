import { afterEach, describe, it, expect, vi } from 'vitest';
import { rapidApiProvider } from './rapidapi';

describe('rapidApiProvider', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
        vi.unstubAllGlobals();
    });

    function configureStableApi() {
        vi.stubEnv('STABLE_RAPIDAPI_KEY', 'key');
        vi.stubEnv('STABLE_RAPIDAPI_HOST', 'stable.example.com');
        vi.stubEnv('STABLE_RAPIDAPI_ESTIMATED_COST_PER_REQUEST_USD', '0.01');
        vi.stubEnv('STABLE_RAPIDAPI_TIMEOUT_MS', '1000');
    }

    it('getFollowing만 지원한다', () => {
        expect(rapidApiProvider.name).toBe('rapidapi');
        expect(typeof rapidApiProvider.getFollowing).toBe('function');
        expect(rapidApiProvider.getProfile).toBeUndefined();
        expect(rapidApiProvider.getFollowers).toBeUndefined();
    });

    it('legacy generic host를 사용하지 않고 Flash host를 Stable endpoint에 거부한다', async () => {
        vi.stubEnv('RAPIDAPI_KEY', 'key');
        vi.stubEnv('RAPIDAPI_HOST', 'legacy.example');
        vi.stubEnv('STABLE_RAPIDAPI_HOST', '');
        await expect(rapidApiProvider.getFollowing!('target', 1)).rejects.toThrow(
            'STABLE_RAPIDAPI_HOST'
        );

        vi.stubEnv('STABLE_RAPIDAPI_HOST', 'flashapi1.p.rapidapi.com');
        await expect(rapidApiProvider.getFollowing!('target', 1)).rejects.toThrow('FlashAPI host');

        vi.stubEnv('STABLE_RAPIDAPI_HOST', 'stable.example.com');
        await expect(rapidApiProvider.getFollowing!('target', 1)).rejects.toThrow(
            'STABLE_RAPIDAPI_ESTIMATED_COST_PER_REQUEST_USD'
        );
    });

    it('중복 username을 제거하고 raw/unique telemetry를 분리한다', async () => {
        configureStableApi();
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            users: [
                { username: 'Alice', is_private: false, is_verified: false },
                { username: 'alice', is_private: false, is_verified: false },
                { username: 'bob', is_private: true, is_verified: false },
            ],
        }), { status: 200 })));
        const recordUsage = vi.fn();

        await expect(rapidApiProvider.getFollowing!('target', 3, { recordUsage }))
            .resolves.toHaveLength(2);
        expect(recordUsage).toHaveBeenCalledWith({ raw_result_count: 3 });
        expect(recordUsage).toHaveBeenCalledWith({
            result_count: 2,
            unique_result_count: 2,
        });
    });

    it('malformed rows and transport timeouts fail closed', async () => {
        configureStableApi();
        const fetchMock = vi.fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(JSON.stringify({ users: [{ username: 'bad user' }] })))
            .mockRejectedValueOnce(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        vi.stubGlobal('fetch', fetchMock);

        await expect(rapidApiProvider.getFollowing!('target', 1)).rejects.toThrow('SCHEMA');
        await expect(rapidApiProvider.getFollowing!('target', 1)).rejects.toThrow('AMBIGUOUS');
    });
});
