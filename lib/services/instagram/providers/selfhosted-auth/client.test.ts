import { describe, expect, it, vi } from 'vitest';
import {
    SelfHostedAuthWorkerError,
    createSelfHostedAuthWorkerClient,
    getSelfHostedAuthWorkerConfig,
    type SelfHostedAuthWorkerConfig,
} from './client';

const relationshipResponse = {
    schemaVersion: 1,
    runId: '0123456789abcdef0123456789abcdef',
    accountSlot: 'primary',
    items: [{
        username: 'valid.user',
        fullName: 'Valid User',
        profilePicUrl: 'https://cdn.example/avatar.jpg',
        isPrivate: false,
        isVerified: false,
    }],
};

describe('authenticated self-hosted worker config', () => {
    it('is fail-closed and accepts only a private https endpoint with bounded timeouts', () => {
        expect(() => getSelfHostedAuthWorkerConfig({})).toThrow('SELFHOSTED_AUTH_ENABLED');
        expect(() => getSelfHostedAuthWorkerConfig({
            SELFHOSTED_AUTH_ENABLED: 'true',
            SELFHOSTED_AUTH_WORKER_URL: 'http://worker.example',
        })).toThrow('SELFHOSTED_AUTH_WORKER_URL');
        expect(getSelfHostedAuthWorkerConfig({
            SELFHOSTED_AUTH_ENABLED: 'true',
            SELFHOSTED_AUTH_WORKER_URL: 'https://worker.example/',
        })).toEqual({
            enabled: true,
            audience: 'https://worker.example',
            baseUrl: 'https://worker.example',
            timeoutMs: 240_000,
            authMode: 'oidc',
        });
    });

    it('supports an explicit local bearer mode without accepting a short token', () => {
        expect(() => getSelfHostedAuthWorkerConfig({
            NODE_ENV: 'production',
            SELFHOSTED_AUTH_ENABLED: 'true',
            SELFHOSTED_AUTH_WORKER_URL: 'https://worker.example',
            SELFHOSTED_AUTH_WORKER_AUTH_MODE: 'bearer',
            SELFHOSTED_AUTH_WORKER_BEARER_TOKEN: 'x'.repeat(32),
        })).toThrow('local development');
        expect(() => getSelfHostedAuthWorkerConfig({
            SELFHOSTED_AUTH_ENABLED: 'true',
            SELFHOSTED_AUTH_WORKER_URL: 'http://127.0.0.1:8081',
            SELFHOSTED_AUTH_WORKER_AUTH_MODE: 'bearer',
            SELFHOSTED_AUTH_WORKER_BEARER_TOKEN: 'short',
        })).toThrow('SELFHOSTED_AUTH_WORKER_BEARER_TOKEN');
        expect(getSelfHostedAuthWorkerConfig({
            NODE_ENV: 'development',
            SELFHOSTED_AUTH_ENABLED: 'true',
            SELFHOSTED_AUTH_WORKER_URL: 'http://127.0.0.1:8081/',
            SELFHOSTED_AUTH_WORKER_AUTH_MODE: 'bearer',
            SELFHOSTED_AUTH_WORKER_BEARER_TOKEN: 'x'.repeat(32),
            SELFHOSTED_AUTH_WORKER_TIMEOUT_MS: '1000',
        })).toMatchObject({
            baseUrl: 'http://127.0.0.1:8081',
            timeoutMs: 1000,
            authMode: 'bearer',
            bearerToken: 'x'.repeat(32),
        });
    });
});

describe('authenticated self-hosted worker client', () => {
    const config = {
        enabled: true,
        audience: 'https://worker.example',
        baseUrl: 'https://worker.example',
        timeoutMs: 240_000,
        authMode: 'oidc' as const,
    } satisfies SelfHostedAuthWorkerConfig;

    it('sends a bounded relationship request and validates the strict response', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify(relationshipResponse), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        }));
        const getAuthorizationHeader = vi.fn(async () => 'Bearer oidc-token');
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader,
        });

        await expect(client.getRelationship('followers', 'target.user', 1200))
            .resolves.toEqual(relationshipResponse);
        expect(getAuthorizationHeader).toHaveBeenCalledWith('https://worker.example');
        expect(fetch).toHaveBeenCalledWith(
            'https://worker.example/v1/relationships/followers',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ authorization: 'Bearer oidc-token' }),
                body: JSON.stringify({ username: 'target.user', limit: 1200 }),
            })
        );
    });

    it('rejects malformed success payloads instead of passing untrusted rows downstream', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({
            ...relationshipResponse,
            items: [{ ...relationshipResponse.items[0], unexpected: true }],
        }), { status: 200 }));
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });

        await expect(client.getRelationship('followers', 'target.user', 1))
            .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    });

    it('classifies queue-full and quarantined responses for deterministic Apify fallback', async () => {
        for (const [status, code, retryable] of [
            [429, 'queue_full', true],
            [423, 'account_quarantined', false],
        ] as const) {
            const fetch = vi.fn(async () => new Response(JSON.stringify({
                schemaVersion: 1,
                code,
                retryable,
            }), { status }));
            const client = createSelfHostedAuthWorkerClient({
                config,
                fetch,
                getAuthorizationHeader: async () => 'Bearer token',
            });

            const error = await client.getRelationship('following', 'target.user', 1)
                .catch(caught => caught);
            expect(error).toBeInstanceOf(SelfHostedAuthWorkerError);
            expect(error).toMatchObject({ code, retryable, status });
        }
    });

    it('rejects interaction URLs that collide after canonicalization before network I/O', async () => {
        const fetch = vi.fn();
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });

        expect(() => client.getPostLikers([
            'https://instagram.com/reel/SameCode/',
            'https://www.instagram.com/reels/SameCode/',
        ], 10)).toThrow('post URLs are invalid');
        expect(fetch).not.toHaveBeenCalled();
    });
});
