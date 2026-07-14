import { describe, expect, it, vi } from 'vitest';
import {
    analysisV2ProfileFetchResumeSchema,
    type AnalysisV2ProfileFetchResume,
} from './v2-profile-fetch-store';
import type { AnalysisV2ProviderRunStore } from './v2-provider-run-store';
import {
    ANALYSIS_V2_PROFILE_CONSUMER_DATABASE_NAMES,
    createAnalysisV2MediaNormalizer,
    createAnalysisV2ProfileBatchReadModel,
    createAnalysisV2ReverseLikeCollector,
    type AnalysisV2ProfileConsumerSupabaseClient,
} from './v2-ai-scoring-runtime-deps';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

// gitleaks:allow -- UUID fixture
const requestId = '7df77338-2672-4ef2-93fe-13a0683ec9b4';
// gitleaks:allow -- UUID fixture
const claimToken = '51b42f42-204d-4dfb-86f8-9658d21c78f1';
const consumerInputHash = 'a'.repeat(64);
const producerInputHash = 'b'.repeat(64);
const capturedAt = '2026-07-13T07:30:00.000Z';

function outcome(
    username: string,
    source: 'selfhosted' | 'apify',
    status: 'success' | 'unavailable' | 'failed'
) {
    if (status === 'success') {
        return {
            requestedUsername: username,
            source,
            status,
            failureCategory: null,
            httpStatus: null,
            requestCount: 1,
            latencyMs: 25,
            capturedAt,
        } as const;
    }
    if (status === 'unavailable') {
        return {
            requestedUsername: username,
            source,
            status,
            failureCategory: 'not_found' as const,
            httpStatus: 404 as const,
            requestCount: 1,
            latencyMs: 25,
            capturedAt,
        };
    }
    return {
        requestedUsername: username,
        source,
        status,
        failureCategory: 'timeout' as const,
        httpStatus: 504,
        requestCount: 1,
        latencyMs: 25,
        capturedAt,
    };
}

function profile(username: string) {
    return {
        username,
        followersCount: 10,
        followingCount: 20,
        postsCount: 0,
        isPrivate: false,
        isVerified: false,
    };
}

function resume(finalStatus: 'unavailable' | 'failed'): AnalysisV2ProfileFetchResume {
    return analysisV2ProfileFetchResumeSchema.parse({
        requestId,
        jobKey: 'track:profiles:batch:0',
        requestedUsernames: ['success.one', 'terminal.one'],
        frozenUnresolvedUsernames: ['terminal.one'],
        primaryResults: [
            {
                outcome: outcome('success.one', 'selfhosted', 'success'),
                profile: profile('success.one'),
            },
            { outcome: outcome('terminal.one', 'selfhosted', 'failed') },
        ],
        fallbackResults: [{ outcome: outcome('terminal.one', 'apify', finalStatus) }],
        primaryCapturedAt: capturedAt,
        fallbackCapturedAt: capturedAt,
    });
}

function profileClient(data: unknown) {
    const rpc = vi.fn(async () => ({ data, error: null }));
    return { rpc, client: { rpc } as AnalysisV2ProfileConsumerSupabaseClient };
}

describe('analysis V2 production profile consumer', () => {
    it('accepts a terminal unavailable outcome while preserving exact producer order', async () => {
        const fake = profileClient(resume('unavailable'));
        const reader = createAnalysisV2ProfileBatchReadModel(fake.client);

        const loaded = await reader.loadExactBatch({
            requestId,
            consumerJobKey: 'track:profile-ai:batch:0',
            consumerClaimToken: claimToken,
            consumerInputHash,
            producerJobKey: 'track:profiles:batch:0',
            batch: 0,
            expectedItemCount: 2,
            expectedProducerInputHash: producerInputHash,
        });

        expect(loaded?.requestedUsernames).toEqual(['success.one', 'terminal.one']);
        expect(loaded?.results.map(row => row.status)).toEqual(['success', 'unavailable']);
        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROFILE_CONSUMER_DATABASE_NAMES.loadRpc,
            expect.objectContaining({
                p_consumer_job_key: 'track:profile-ai:batch:0',
                p_producer_job_key: 'track:profiles:batch:0',
                p_expected_producer_input_hash: producerInputHash,
                p_expected_item_count: 2,
            })
        );
    });

    it('rejects a final retryable failure instead of silently shrinking analysis scope', async () => {
        const reader = createAnalysisV2ProfileBatchReadModel(
            profileClient(resume('failed')).client
        );

        await expect(reader.loadExactBatch({
            requestId,
            consumerJobKey: 'track:profile-ai:batch:0',
            consumerClaimToken: claimToken,
            consumerInputHash,
            producerJobKey: 'track:profiles:batch:0',
            batch: 0,
            expectedItemCount: 2,
            expectedProducerInputHash: producerInputHash,
        })).rejects.toThrow('ANALYSIS_V2_PROFILE_CONSUMER_RETRYABLE_OUTCOME');
    });

    it('rejects mismatched batch producer and consumer identities before RPC access', async () => {
        const fake = profileClient(resume('unavailable'));
        const reader = createAnalysisV2ProfileBatchReadModel(fake.client);

        await expect(reader.loadExactBatch({
            requestId,
            consumerJobKey: 'track:profile-ai:batch:1',
            consumerClaimToken: claimToken,
            consumerInputHash,
            producerJobKey: 'track:profiles:batch:0',
            batch: 0,
            expectedItemCount: 2,
            expectedProducerInputHash: producerInputHash,
        })).rejects.toThrow('ANALYSIS_V2_PROFILE_CONSUMER_SCOPE_MISMATCH');
        expect(fake.rpc).not.toHaveBeenCalled();
    });
});

describe('analysis V2 reverse-like production collector', () => {
    it('uses one durable provider operation for at most ten posts and keeps per-post attribution', async () => {
        const bindAdapterCheckpoint = vi.fn(async (input: unknown) => {
            void input;
            return { stored: null, checkpoint: {} };
        });
        const load = vi.fn(async () => ({ status: 'succeeded', runId: 'RUN123456' }));
        const providerRunStore = {
            bindAdapterCheckpoint,
            load,
        } as unknown as AnalysisV2ProviderRunStore;
        const getPostLikers = vi.fn(async () => [{
            postUrl: 'https://www.instagram.com/p/POST_A/',
            id: '1',
            username: 'target.account',
            profilePicUrl: 'https://cdninstagram.com/profile.jpg',
            isPrivate: false,
            isVerified: false,
            totalLikes: 1,
        }]);
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore,
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: { ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary' },
        });

        const result = await collector.collect({
            requestId,
            jobKey: 'track:reverse-likes:collect',
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            candidates: [
                {
                    candidateId: 'candidate:a',
                    postUrl: 'https://instagram.com/p/POST_A/',
                    declaredLikesCount: 114,
                },
                {
                    candidateId: 'candidate:b',
                    postUrl: 'https://instagram.com/reel/POST_B/',
                    declaredLikesCount: 0,
                },
            ],
            limitPerPost: 100,
        });

        expect(getPostLikers).toHaveBeenCalledOnce();
        expect(getPostLikers).toHaveBeenCalledWith([
            'https://www.instagram.com/p/POST_A/',
            'https://www.instagram.com/reel/POST_B/',
        ], 100, expect.any(Object));
        expect(bindAdapterCheckpoint).toHaveBeenCalledOnce();
        expect(bindAdapterCheckpoint.mock.calls[0]![0]).toMatchObject({
            maxChargeUsd: 0.31,
            actorId: 'datadoping/instagram-likes-scraper',
            credentialSlot: 'quinary',
        });
        expect(result.operationKey).toMatch(/^candidate-likers:[a-f0-9]{64}$/);
        expect(result.results).toEqual([
            {
                candidateId: 'candidate:a',
                status: 'observed',
            },
            { candidateId: 'candidate:b', status: 'not_observed' },
        ]);
    });

    it('fails closed instead of turning an out-of-scope 109-of-114 sample into absence', async () => {
        const providerRunStore = {
            bindAdapterCheckpoint: vi.fn(async () => ({ stored: null, checkpoint: {} })),
            load: vi.fn(async () => ({ status: 'succeeded', runId: 'RUN123456' })),
        } as unknown as AnalysisV2ProviderRunStore;
        const getPostLikers = vi.fn(async () => Array.from({ length: 109 }, (_, index) => ({
            postUrl: 'https://www.instagram.com/p/POST_A/',
            id: String(index + 1),
            username: `sample.${index + 1}`,
            profilePicUrl: 'https://cdninstagram.com/profile.jpg',
            isPrivate: false,
            isVerified: false,
            totalLikes: 114,
        })));
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore,
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {},
        });

        await expect(collector.collect({
            requestId,
            jobKey: 'track:reverse-likes:collect',
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            candidates: [{
                candidateId: 'candidate:a',
                postUrl: 'https://instagram.com/p/POST_A/',
                declaredLikesCount: 114,
            }],
            limitPerPost: 100,
        })).rejects.toThrow('ANALYSIS_V2_REVERSE_LIKE_RESULT_LIMIT_EXCEEDED');
    });

    it('keeps a complete first-100 sample from a 114-like post as not_collected', async () => {
        const providerRunStore = {
            bindAdapterCheckpoint: vi.fn(async () => ({ stored: null, checkpoint: {} })),
            load: vi.fn(async () => ({ status: 'succeeded', runId: 'RUN123456' })),
        } as unknown as AnalysisV2ProviderRunStore;
        const getPostLikers = vi.fn(async () => Array.from({ length: 100 }, (_, index) => ({
            postUrl: 'https://www.instagram.com/p/POST_A/',
            id: String(index + 1),
            username: `sample.${index + 1}`,
            profilePicUrl: 'https://cdninstagram.com/profile.jpg',
            isPrivate: false,
            isVerified: false,
            totalLikes: 114,
        })));
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore,
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {},
        });

        const result = await collector.collect({
            requestId,
            jobKey: 'track:reverse-likes:collect',
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            candidates: [{
                candidateId: 'candidate:a',
                postUrl: 'https://instagram.com/p/POST_A/',
                declaredLikesCount: 114,
            }],
            limitPerPost: 100,
        });

        expect(result.results[0]?.status).toBe('not_collected');
    });

    it('confirms absence only when the complete liker population is within the sample cap', async () => {
        const bindAdapterCheckpoint = vi.fn(async () => ({ stored: null, checkpoint: {} }));
        const providerRunStore = {
            bindAdapterCheckpoint,
            load: vi.fn(async () => ({ status: 'succeeded', runId: 'RUN123456' })),
        } as unknown as AnalysisV2ProviderRunStore;
        const getPostLikers = vi.fn(async () => [
            {
                postUrl: 'https://www.instagram.com/p/POST_A/', id: '1', username: 'one',
                profilePicUrl: 'https://cdninstagram.com/one.jpg', isPrivate: false,
                isVerified: false, totalLikes: 2,
            },
            {
                postUrl: 'https://www.instagram.com/p/POST_A/', id: '2', username: 'two',
                profilePicUrl: 'https://cdninstagram.com/two.jpg', isPrivate: false,
                isVerified: false, totalLikes: 2,
            },
        ]);
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore,
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {},
        });
        const base = {
            requestId,
            jobKey: 'track:reverse-likes:collect' as const,
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            limitPerPost: 100 as const,
        };

        const complete = await collector.collect({
            ...base,
            candidates: [{
                candidateId: 'candidate:a',
                postUrl: 'https://instagram.com/p/POST_A/',
                declaredLikesCount: 2,
            }],
        });
        const firstOperationKey = complete.operationKey;
        const sampled = await collector.collect({
            ...base,
            candidates: [{
                candidateId: 'candidate:a',
                postUrl: 'https://instagram.com/p/POST_A/',
                declaredLikesCount: 3,
            }],
        });

        expect(complete.results[0]?.status).toBe('not_observed');
        expect(sampled.results[0]?.status).toBe('not_collected');
        expect(sampled.operationKey).not.toBe(firstOperationKey);
        expect(bindAdapterCheckpoint).toHaveBeenCalledTimes(2);
    });

    it('does not reserve or call a paid provider when no shortlist post is collectable', async () => {
        const bindAdapterCheckpoint = vi.fn();
        const getPostLikers = vi.fn();
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: {
                bindAdapterCheckpoint,
            } as unknown as AnalysisV2ProviderRunStore,
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {},
        });

        const result = await collector.collect({
            requestId,
            jobKey: 'track:reverse-likes:collect',
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            candidates: [],
            limitPerPost: 100,
        });

        expect(result).toEqual({ operationKey: null, results: [] });
        expect(bindAdapterCheckpoint).not.toHaveBeenCalled();
        expect(getPostLikers).not.toHaveBeenCalled();
    });
});

describe('analysis V2 media normalizer', () => {
    it('runs every secure download and decode inside the shared bounded slot', async () => {
        const events: string[] = [];
        const normalizeMedia = createAnalysisV2MediaNormalizer({
            withSlot: async task => {
                events.push('slot:start');
                const value = await task();
                events.push('slot:end');
                return value;
            },
            download: async url => {
                events.push(`download:${url}`);
                return Buffer.from('source');
            },
            normalize: async bytes => {
                events.push(`normalize:${bytes.toString()}`);
                return Buffer.from('jpeg');
            },
        });

        await expect(normalizeMedia({
            selectionId: 'profile:one',
            imageUrl: 'https://cdninstagram.com/profile.jpg',
            role: 'profile',
        })).resolves.toEqual(Buffer.from('jpeg'));
        expect(events).toEqual([
            'slot:start',
            'download:https://cdninstagram.com/profile.jpg',
            'normalize:source',
            'slot:end',
        ]);
    });

    it('sanitizes transport and decode failures into bounded retry dispositions', async () => {
        const transport = createAnalysisV2MediaNormalizer({
            withSlot: task => task(),
            download: async () => {
                throw new Error(
                    'request timeout for https://cdninstagram.com/private.jpg?signature=secret'
                );
            },
        });
        const transportFailure = await transport({
            selectionId: 'profile:transport',
            imageUrl: 'https://cdninstagram.com/private.jpg?signature=secret',
            role: 'profile',
        }).catch(error => error);
        expect(transportFailure).toMatchObject({
            reason: 'network_failure',
            disposition: 'transient',
        });
        expect(transportFailure.message).toBe('ANALYSIS_IMAGE_PREPARATION_NETWORK_FAILURE');
        expect(JSON.stringify(transportFailure)).not.toContain('signature');

        const decode = createAnalysisV2MediaNormalizer({
            withSlot: task => task(),
            download: async () => Buffer.from('source'),
            normalize: async () => {
                throw new Error('decode failed for user.name');
            },
        });
        await expect(decode({
            selectionId: 'profile:decode',
            imageUrl: 'https://cdninstagram.com/image.jpg',
            role: 'profile',
        })).rejects.toMatchObject({
            message: 'ANALYSIS_IMAGE_PREPARATION_DECODE_FAILED',
            reason: 'decode_failed',
            disposition: 'permanent',
        });
    });
});
