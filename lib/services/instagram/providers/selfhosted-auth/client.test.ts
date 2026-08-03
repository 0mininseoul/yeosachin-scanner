import { describe, expect, it, vi } from 'vitest';
import {
    SelfHostedAuthWorkerError,
    createSelfHostedAuthWorkerClient,
    getSelfHostedAuthWorkerConfig,
    isSelfHostedAuthFallbackEligible,
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
const identity = {
    operationKey: `relationship-followers:${'a'.repeat(64)}`,
    inputHash: 'b'.repeat(64),
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

        await expect(client.getRelationship('followers', 'target.user', 1200, identity))
            .resolves.toEqual(relationshipResponse);
        expect(getAuthorizationHeader).toHaveBeenCalledWith('https://worker.example');
        expect(fetch).toHaveBeenCalledWith(
            'https://worker.example/v1/relationships/followers',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ authorization: 'Bearer oidc-token' }),
                body: JSON.stringify({
                    ...identity,
                    username: 'target.user',
                    limit: 1200,
                }),
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

        await expect(client.getRelationship('followers', 'target.user', 1, identity))
            .rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    });

    it('keeps caller cancellation distinct from the client timeout', async () => {
        const controller = new AbortController();
        const fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                }, { once: true });
            });
        });
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });
        const pending = client.getRelationship('followers', 'target.user', 1, {
            ...identity,
            signal: controller.signal,
        });
        controller.abort();

        await expect(pending).rejects.toMatchObject({
            code: 'request_cancelled',
            retryable: false,
        });
    });

    it('sends the supplied V2 identity for interaction requests without deriving a content key', async () => {
        const response = {
            schemaVersion: 1,
            runId: relationshipResponse.runId,
            accountSlot: 'primary',
            items: [{
                postUrl: 'https://www.instagram.com/p/Abc123/',
                id: '1',
                username: 'target.user',
                profilePicUrl: 'https://cdn.example/liker.jpg',
                isPrivate: false,
                isVerified: false,
                totalLikes: 1,
            }],
        };
        const fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });
        const operationKey = `candidate-likers:${'c'.repeat(64)}`;
        const inputHash = 'd'.repeat(64);

        await expect(client.getPostLikers(
            ['https://instagram.com/p/Abc123/'],
            1,
            { operationKey, inputHash }
        )).resolves.toEqual(response);
        expect(fetch).toHaveBeenCalledWith(
            'https://worker.example/v1/interactions/likers',
            expect.objectContaining({
                body: JSON.stringify({
                    operationKey,
                    inputHash,
                    postUrls: ['https://www.instagram.com/p/Abc123/'],
                    limitPerPost: 1,
                }),
            })
        );
    });

    it('sends the bounded authenticated profile-batch contract and rejects unknown profile fields', async () => {
        const profile = {
            username: 'target.user',
            fullName: 'Target User',
            bio: 'bio',
            profilePicUrl: 'https://cdn.example/avatar.jpg',
            followersCount: 12,
            followingCount: 3,
            postsCount: 1,
            isPrivate: false,
            isVerified: true,
            latestPosts: [{
                id: 'post-1',
                shortCode: 'Abc123',
                type: 'image',
                likesCount: 7,
                commentsCount: 2,
                likesCountHidden: true,
                commentsCountHidden: true,
                timestamp: '2026-08-03T00:00:00.000Z',
                taggedUsers: [],
                mentionedUsers: [],
            }],
        };
        const response = {
            schemaVersion: 1,
            runId: relationshipResponse.runId,
            accountSlot: 'primary',
            items: [
                { username: 'target.user', status: 'available', profile },
                { username: 'missing.user', status: 'not_found' },
            ],
        };
        const fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });
        const operationKey = `profiles:${'c'.repeat(64)}`;

        await expect(client.getProfilesBatch(
            ['Target.User', 'missing.user'],
            10,
            { operationKey, inputHash: 'd'.repeat(64) }
        )).resolves.toEqual(response);
        expect(fetch).toHaveBeenCalledWith(
            'https://worker.example/v1/profiles',
            expect.objectContaining({
                body: JSON.stringify({
                    operationKey,
                    inputHash: 'd'.repeat(64),
                    usernames: ['target.user', 'missing.user'],
                    mediaLimit: 10,
                }),
            })
        );

        const malformed = createSelfHostedAuthWorkerClient({
            config,
            fetch: async () => new Response(JSON.stringify({
                ...response,
                items: [{
                    username: 'target.user',
                    status: 'available',
                    profile: { ...profile, unexpected: true },
                }],
            }), { status: 200 }),
            getAuthorizationHeader: async () => 'Bearer token',
        });
        await expect(malformed.getProfilesBatch(
            ['target.user'],
            10,
            { operationKey, inputHash: 'd'.repeat(64) }
        )).rejects.toMatchObject({ code: 'invalid_response', retryable: false });
    });

    it('permits a summary-only authenticated profile request without collecting media', async () => {
        const profile = {
            username: 'target.user',
            followersCount: 12,
            followingCount: 3,
            postsCount: 1,
            isPrivate: false,
            isVerified: false,
            latestPosts: [],
        };
        const fetch = vi.fn(async () => new Response(JSON.stringify({
            schemaVersion: 1,
            runId: relationshipResponse.runId,
            accountSlot: 'primary',
            items: [profile],
        }), { status: 200 }));
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });

        await expect(client.getProfile(
            'target.user',
            0,
            { operationKey: `target-profile:${'e'.repeat(64)}`, inputHash: 'f'.repeat(64) }
        )).resolves.toMatchObject({ items: [profile] });
        expect(fetch).toHaveBeenCalledWith(
            'https://worker.example/v1/profiles/profile',
            expect.objectContaining({
                body: JSON.stringify({
                    operationKey: `target-profile:${'e'.repeat(64)}`,
                    inputHash: 'f'.repeat(64),
                    username: 'target.user',
                    mediaLimit: 0,
                }),
            })
        );
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

            const error = await client.getRelationship('following', 'target.user', 1, {
                ...identity,
                operationKey: `relationship-following:${'a'.repeat(64)}`,
            })
                .catch(caught => caught);
            expect(error).toBeInstanceOf(SelfHostedAuthWorkerError);
            expect(error).toMatchObject({ code, retryable, status });
        }
    });

    it('allows only explicit worker availability and account-state classes to fall back', () => {
        for (const code of [
            'transport_error',
            'request_timeout',
            'queue_full',
            'queue_timeout',
            'upstream_error',
            'instagram_rate_limited',
            'instagram_challenge',
            'authentication_failed',
            'account_quarantined',
        ] as const) {
            expect(isSelfHostedAuthFallbackEligible(
                new SelfHostedAuthWorkerError(code, true, null)
            )).toBe(true);
        }
        expect(isSelfHostedAuthFallbackEligible(
            new SelfHostedAuthWorkerError('invalid_response', false, 200)
        )).toBe(false);
        expect(isSelfHostedAuthFallbackEligible(
            new SelfHostedAuthWorkerError('request_cancelled', false, null)
        )).toBe(false);
        expect(isSelfHostedAuthFallbackEligible(
            new SelfHostedAuthWorkerError('idempotency_pending', false, 409)
        )).toBe(false);
        expect(isSelfHostedAuthFallbackEligible(
            new SelfHostedAuthWorkerError('idempotency_key_reused', false, 409)
        )).toBe(false);
        expect(isSelfHostedAuthFallbackEligible(
            new Error('ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH')
        )).toBe(false);
        expect(isSelfHostedAuthFallbackEligible(
            new Error('SCRAPING_RUN_PENDING_ERROR: retry persisted run')
        )).toBe(false);
    });

    it('surfaces durable worker idempotency ambiguity without permitting fallback', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({
            schemaVersion: 1,
            code: 'idempotency_pending',
            retryable: false,
        }), { status: 409 }));
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });

        await expect(client.getRelationship('followers', 'target.user', 1, identity))
            .rejects.toMatchObject({ code: 'idempotency_pending', retryable: false, status: 409 });
    });

    it('parses durable-state outages but keeps them fail-closed outside paid fallback', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({
            schemaVersion: 1,
            code: 'durable_state_unavailable',
            retryable: true,
            retryAfterSeconds: 30,
        }), { status: 503 }));
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });

        const error = await client.getRelationship('followers', 'target.user', 1, identity)
            .then(() => null, value => value);
        expect(error).toMatchObject({
            code: 'durable_state_unavailable',
            retryable: true,
            status: 503,
        });
        expect(isSelfHostedAuthFallbackEligible(error)).toBe(false);
    });

    it('strictly preserves permanent account-operation locks and excludes them from fallback', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({
            schemaVersion: 1,
            code: 'account_operation_locked',
            retryable: false,
        }), { status: 423 }));
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });

        const error = await client.getRelationship('followers', 'target.user', 1, identity)
            .then(() => null, value => value);
        expect(error).toMatchObject({
            code: 'account_operation_locked',
            retryable: false,
            status: 423,
        });
        expect(isSelfHostedAuthFallbackEligible(error)).toBe(false);
    });

    it('strictly preserves worker schema failures and excludes them from fallback', async () => {
        const fetch = vi.fn(async () => new Response(JSON.stringify({
            schemaVersion: 1,
            code: 'worker_schema_error',
            retryable: false,
        }), { status: 502 }));
        const client = createSelfHostedAuthWorkerClient({
            config,
            fetch,
            getAuthorizationHeader: async () => 'Bearer token',
        });

        const error = await client.getRelationship('followers', 'target.user', 1, identity)
            .then(() => null, value => value);
        expect(error).toMatchObject({
            code: 'worker_schema_error',
            retryable: false,
            status: 502,
        });
        expect(isSelfHostedAuthFallbackEligible(error)).toBe(false);
    });

    it('rejects malformed fixed worker-error contracts rather than loosening fallback', async () => {
        for (const [status, payload] of [
            [423, {
                schemaVersion: 1,
                code: 'account_operation_locked',
                retryable: true,
            }],
            [502, {
                schemaVersion: 1,
                code: 'worker_schema_error',
                retryable: false,
                retryAfterSeconds: 30,
            }],
            [503, {
                schemaVersion: 1,
                code: 'worker_schema_error',
                retryable: false,
            }],
        ] as const) {
            const fetch = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
            const client = createSelfHostedAuthWorkerClient({
                config,
                fetch,
                getAuthorizationHeader: async () => 'Bearer token',
            });

            const error = await client.getRelationship('followers', 'target.user', 1, identity)
                .then(() => null, value => value);
            expect(error).toMatchObject({
                code: 'invalid_response',
                retryable: false,
                status,
            });
            expect(isSelfHostedAuthFallbackEligible(error)).toBe(false);
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
        ], 10, {
            operationKey: `target-likers:${'a'.repeat(64)}`,
            inputHash: 'b'.repeat(64),
        })).toThrow('post URLs are invalid');
        expect(fetch).not.toHaveBeenCalled();
    });
});
