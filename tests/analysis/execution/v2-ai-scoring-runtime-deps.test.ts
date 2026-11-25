import type { SelectedAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentDevStandardArchive, DevStandardArchiveError } from '@/lib/services/dev-ui/standard-archive-runtime';
import { archiveMediaUrlAnchor } from '@/lib/services/dev-ui/standard-archive-media-identity';
import { captureDevStandardMediaSelection, normalizeAnalysisV2MediaSelections } from '@/lib/services/analysis/v2-media-normalization';
import {
    analysisV2ProfileFetchResumeSchema,
    type AnalysisV2ProfileFetchResume,
} from '../../../lib/services/analysis/v2-profile-fetch-store';
import type { AnalysisV2ProviderRunStore } from '../../../lib/services/analysis/v2-provider-run-store';
import type { ProviderExecutionPolicy } from '../../../lib/services/analysis/authorized-test-provider-policy';
import type { AnalysisV2SelfHostedAuthRunReceipt } from '../../../lib/services/analysis/v2-selfhosted-auth-run-store';
import type { FreshProvenanceStore } from '../../../lib/services/analysis/fresh-provenance-store';
import { RevenueCostOperationStore } from '../../../lib/services/analysis/revenue-cost-operation-store';
import { AnalysisImagePreparationError } from '@/lib/services/ai/image-preprocessing';
import { SelfHostedAuthWorkerError } from '@/lib/services/instagram/providers/selfhosted-auth/client';
import {
    AnalysisV2SchedulerContinuationError,
    PROFILE_CONSUMER_READ_TIMEOUT,
} from '../../../lib/services/analysis/v2-ai-scheduler-continuation';
import {
    ANALYSIS_V2_PROFILE_CONSUMER_DATABASE_NAMES,
    createAnalysisV2MediaNormalizer,
    createAnalysisV2ProfileBatchReadModel,
    createAnalysisV2ReverseLikeCollector,
    createAnalysisV2TargetProfileReadModel,
    type AnalysisV2ProfileConsumerSupabaseClient,
} from '../../../lib/services/analysis/v2-ai-scoring-runtime-deps';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

vi.mock('@/lib/services/dev-ui/standard-archive-runtime', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/dev-ui/standard-archive-runtime')>(),
    currentDevStandardArchive: vi.fn().mockReturnValue(null),
}));

function archiveScope(mode: 'capture' | 'replay', stored: Map<string, unknown>) {
    const fail = (): never => { throw new DevStandardArchiveError(); };
    const scope = {
        mode,
        fail,
        ready: () => true,
        beginPreflightCapture: vi.fn(),
        capture: vi.fn(async (kind, identity, value) => { stored.set(JSON.stringify([kind, identity]), value); }),
        load: vi.fn(async (kind, identity) => stored.get(JSON.stringify([kind, identity])) ?? fail()),
        find: vi.fn(async (kind, identity) => {
            const key = JSON.stringify([kind, identity]);
            return stored.has(key) ? { value: stored.get(key) } : null;
        }),
        seal: vi.fn(async () => undefined),
    } satisfies NonNullable<ReturnType<typeof currentDevStandardArchive>>;
    vi.mocked(currentDevStandardArchive).mockReturnValue(scope);
    return scope;
}

afterEach(() => vi.mocked(currentDevStandardArchive).mockReturnValue(null));

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

function incompleteOutcome(username: string, source: 'selfhosted' | 'apify') {
    return {
        requestedUsername: username,
        source,
        status: 'failed' as const,
        failureCategory: 'incomplete' as const,
        httpStatus: null,
        requestCount: 1,
        latencyMs: 25,
        capturedAt,
    };
}

function schemaOutcome(username: string, source: 'selfhosted' | 'apify') {
    return {
        requestedUsername: username,
        source,
        status: 'failed' as const,
        failureCategory: 'schema' as const,
        httpStatus: null,
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

function resume(
    finalStatus: 'unavailable' | 'failed' | 'incomplete' | 'schema'
): AnalysisV2ProfileFetchResume {
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
        fallbackResults: [{
            outcome: finalStatus === 'incomplete'
                ? incompleteOutcome('terminal.one', 'apify')
                : finalStatus === 'schema'
                  ? schemaOutcome('terminal.one', 'apify')
                  : outcome('terminal.one', 'apify', finalStatus),
        }],
        primaryCapturedAt: capturedAt,
        fallbackCapturedAt: capturedAt,
    });
}

function profileClient(data: unknown) {
    const rpc = vi.fn(async () => ({ data, error: null }));
    return { rpc, client: { rpc } as AnalysisV2ProfileConsumerSupabaseClient };
}

const authorizedProviderPolicy = {
    mode: 'test_operation_split',
    policyVersion: 'authorized-free-e2e-v1',
    operationSlots: {
        'target-profile': 'tertiary',
        'relationship-followers': 'primary',
        'relationship-following': 'secondary',
        'profile-fallback': 'tertiary',
        'target-likers': 'quaternary',
        'target-comments': 'tertiary',
        'candidate-likers': 'quinary',
    },
} as const;

function reverseLikeContext(policy: ProviderExecutionPolicy | null = null) {
    return {
        load: vi.fn(async () => ({
            requestId,
            targetUsername: 'target.account',
            excludedUsername: null,
            accessMode: policy?.mode === 'test_operation_split'
                ? 'test_entitlement' as const
                : 'production' as const,
            providerExecutionPolicy: policy,
            planId: 'basic' as const,
            followersDeclaredCount: 1,
            followingDeclaredCount: 1,
            detailedMutualLimit: 300 as const,
        })),
    };
}

describe('analysis V2 production profile consumer', () => {
    it.each([
        {
            error: { code: '57014', message: 'canceling statement due to statement timeout' },
            shouldContinue: true,
        },
        { error: { code: '57014', message: 'canceling statement due to user request' }, shouldContinue: false },
        { error: { code: '57014' }, shouldContinue: false },
        {
            error: { code: 'PGRST000', message: 'canceling statement due to statement timeout' },
            shouldContinue: false,
        },
        {
            error: { code: 'P0001', message: 'ANALYSIS_V2_PROFILE_CONSUMER_FENCE_MISMATCH' },
            shouldContinue: false,
        },
    ])('distinguishes a confirmed consumer statement timeout from $error', async ({ error, shouldContinue }) => {
        const rpc = vi.fn().mockResolvedValue({ data: null, error });
        const reader = createAnalysisV2ProfileBatchReadModel({ rpc });
        const result = reader.loadExactBatch({
            requestId,
            consumerJobKey: 'track:profile-ai:batch:0',
            consumerClaimToken: claimToken,
            consumerInputHash,
            producerJobKey: 'track:profiles:batch:0',
            batch: 0,
            expectedItemCount: 2,
            expectedProducerInputHash: producerInputHash,
        });
        if (shouldContinue) {
            await expect(result).rejects.toBeInstanceOf(AnalysisV2SchedulerContinuationError);
            await expect(result).rejects.toMatchObject({ reason: PROFILE_CONSUMER_READ_TIMEOUT, delaySeconds: 5 });
        } else {
            await expect(result).rejects.not.toBeInstanceOf(AnalysisV2SchedulerContinuationError);
        }
        expect(rpc).toHaveBeenCalledOnce();
    });

    it('propagates the same pre-provider continuation when partner safety reads the target checkpoint', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: { code: '57014', message: 'canceling statement due to statement timeout' },
        });
        const reader = createAnalysisV2TargetProfileReadModel({ rpc });

        await expect(reader.loadTargetProfile({
            requestId,
            jobKey: 'track:partner-safety:batch:0',
            claimToken,
            jobInputHash: consumerInputHash,
        })).rejects.toMatchObject({ reason: PROFILE_CONSUMER_READ_TIMEOUT, delaySeconds: 5 });
        expect(rpc).toHaveBeenCalledExactlyOnceWith(
            ANALYSIS_V2_PROFILE_CONSUMER_DATABASE_NAMES.loadRpc,
            expect.objectContaining({ p_producer_job_key: 'track:target-evidence:collect' })
        );
    });

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

    it('projects a tolerated final incomplete failure as unavailable', async () => {
        const reader = createAnalysisV2ProfileBatchReadModel(
            profileClient(resume('incomplete')).client
        );

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

        expect(loaded?.results).toEqual([
            expect.objectContaining({ username: 'success.one', status: 'success' }),
            { username: 'terminal.one', status: 'unavailable' },
        ]);
    });

    it('projects a final schema failure as unavailable without exposing a profile', async () => {
        const reader = createAnalysisV2ProfileBatchReadModel(
            profileClient(resume('schema')).client
        );

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

        expect(loaded?.results).toEqual([
            expect.objectContaining({ username: 'success.one', status: 'success' }),
            { username: 'terminal.one', status: 'unavailable' },
        ]);
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

    it('projects a successful repair ahead of the failed fallback outcome', async () => {
        const repaired = analysisV2ProfileFetchResumeSchema.parse({
            ...resume('failed'),
            repairResults: [{
                outcome: outcome('terminal.one', 'apify', 'success'),
                profile: profile('terminal.one'),
            }],
            repairUsernames: ['terminal.one'],
            repairCapturedAt: capturedAt,
        });
        const reader = createAnalysisV2ProfileBatchReadModel(
            profileClient(repaired).client
        );

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

        expect(loaded?.results).toEqual([
            expect.objectContaining({ username: 'success.one', status: 'success' }),
            expect.objectContaining({ username: 'terminal.one', status: 'success' }),
        ]);
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
    it('rejects a strict cohort selfhosted/fallback configuration before the candidate-liker provider boundary', async () => {
        const bindAdapterCheckpoint = vi.fn();
        const getPostLikers = vi.fn();
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: { bindAdapterCheckpoint } as unknown as AnalysisV2ProviderRunStore,
            contextStore: reverseLikeContext(authorizedProviderPolicy),
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {
                SELFHOSTED_AUTH_ENABLED: 'true',
                SCRAPER_FALLBACK: 'true',
                SCRAPER_PROFILE: 'apify',
                SCRAPER_PROFILES_BATCH: 'apify',
                SCRAPER_FOLLOWERS: 'apify',
                SCRAPER_FOLLOWING: 'apify',
                SCRAPER_LIKERS: 'selfhosted_auth',
                SCRAPER_COMMENTS: 'apify',
            },
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
                declaredLikesCount: 1,
            }],
            limitPerPost: 100,
        })).rejects.toThrow('FRESH_PROVENANCE_CONFIG_ERROR');
        expect(bindAdapterCheckpoint).not.toHaveBeenCalled();
        expect(getPostLikers).not.toHaveBeenCalled();
    });

    it('injects the exact fresh store and job-input fence for strict candidate-likers', async () => {
        const bindAdapterCheckpoint = vi.fn(async () => ({ stored: null, checkpoint: {} }));
        const getPostLikers = vi.fn(async () => []);
        const freshProvenanceStore = {
            assertProviderAdmission: vi.fn(),
            recordProviderRun: vi.fn(),
            bindProviderDataset: vi.fn(),
        } as unknown as FreshProvenanceStore;
        const revenueCostOperationStore = new RevenueCostOperationStore({ rpc: vi.fn() });
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: {
                bindAdapterCheckpoint,
                load: vi.fn(async () => ({ status: 'succeeded', runId: 'RUN123456' })),
            } as unknown as AnalysisV2ProviderRunStore,
            revenueCostOperationStore,
            freshProvenanceStore,
            contextStore: reverseLikeContext(authorizedProviderPolicy),
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {
                SELFHOSTED_AUTH_ENABLED: 'false',
                SCRAPER_FALLBACK: 'false',
                SCRAPER_PROFILE: 'apify',
                SCRAPER_PROFILES_BATCH: 'apify',
                SCRAPER_FOLLOWERS: 'apify',
                SCRAPER_FOLLOWING: 'apify',
                SCRAPER_LIKERS: 'apify',
                SCRAPER_COMMENTS: 'apify',
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'primary',
                APIFY_PRIMARY_API_TOKEN: 'primary-test-token',
                APIFY_SECONDARY_API_TOKEN: 'secondary-test-token',
                APIFY_TERTIARY_API_TOKEN: 'tertiary-test-token',
                APIFY_QUATERNARY_API_TOKEN: 'quaternary-test-token',
                APIFY_QUINARY_API_TOKEN: 'quinary-test-token',
            },
        });

        await collector.collect({
            requestId,
            jobKey: 'track:reverse-likes:collect',
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            candidates: [{
                candidateId: 'candidate:a',
                postUrl: 'https://instagram.com/p/POST_A/',
                declaredLikesCount: 1,
            }],
            limitPerPost: 100,
        });

        expect(bindAdapterCheckpoint).toHaveBeenCalledWith(expect.any(Object), {
            revenueCostOperationStore,
            freshProvenanceStore,
            jobInputHash: consumerInputHash,
        });
    });

    it('rejects a beta reverse-like charge above its frozen budget before reserve or provider I/O', async () => {
        const bindAdapterCheckpoint = vi.fn();
        const getPostLikers = vi.fn();
        const betaPolicy = {
            mode: 'betatest_free_pool',
            policyVersion: 'betatest-free-pool-v1',
            operationSlots: {
                'target-profile': 'primary',
                'relationship-followers': 'tertiary',
                'relationship-following': 'quaternary',
                'profile-fallback': 'quinary',
                'profile-repair': 'senary',
                'target-likers': 'septenary',
                'target-comments': 'primary',
                'candidate-likers': 'tertiary',
            },
            operationBudgets: {
                'target-profile': 0.0052,
                'relationship-followers': 1,
                'relationship-following': 1,
                'profile-fallback': 1,
                'profile-repair': 1,
                'target-likers': 1,
                'target-comments': 1,
                'candidate-likers': 0.3,
            },
        } as const;
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: { bindAdapterCheckpoint } as unknown as AnalysisV2ProviderRunStore,
            contextStore: reverseLikeContext(betaPolicy),
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {
                APIFY_PRIMARY_API_TOKEN: 'primary-test-token',
                APIFY_TERTIARY_API_TOKEN: 'tertiary-test-token',
                APIFY_QUATERNARY_API_TOKEN: 'quaternary-test-token',
                APIFY_QUINARY_API_TOKEN: 'quinary-test-token',
                APIFY_SENARY_API_TOKEN: 'senary-test-token',
                APIFY_SEPTENARY_API_TOKEN: 'septenary-test-token',
            },
        });

        await expect(collector.collect({
            requestId,
            jobKey: 'track:reverse-likes:collect',
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            candidates: [
                { candidateId: 'candidate:a', postUrl: 'https://instagram.com/p/A/', declaredLikesCount: 1 },
                { candidateId: 'candidate:b', postUrl: 'https://instagram.com/p/B/', declaredLikesCount: 1 },
            ],
            limitPerPost: 100,
        })).rejects.toThrow('ANALYSIS_BETA_POOL_BUDGET_DRIFT');
        expect(bindAdapterCheckpoint).not.toHaveBeenCalled();
        expect(getPostLikers).not.toHaveBeenCalled();
    });

    it('pins beta reverse likes to its free Apify binding despite selfhosted_auth selectors', async () => {
        const policy = {
            mode: 'betatest_free_pool',
            policyVersion: 'betatest-free-pool-v1',
            operationSlots: {
                'target-profile': 'primary',
                'relationship-followers': 'tertiary',
                'relationship-following': 'quaternary',
                'profile-fallback': 'quinary',
                'profile-repair': 'senary',
                'target-likers': 'septenary',
                'target-comments': 'primary',
                'candidate-likers': 'tertiary',
            },
            operationBudgets: {
                'target-profile': 1,
                'relationship-followers': 1,
                'relationship-following': 1,
                'profile-fallback': 1,
                'profile-repair': 1,
                'target-likers': 1,
                'target-comments': 1,
                'candidate-likers': 1,
            },
        } as const;
        const bindAdapterCheckpoint = vi.fn(async () => ({ stored: null, checkpoint: {} }));
        const apifyLikers = vi.fn(async () => []);
        const selfHostedLikers = vi.fn(() => { throw new Error('beta must not call selfhosted'); });
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: {
                bindAdapterCheckpoint,
                load: vi.fn(async () => null),
            } as unknown as AnalysisV2ProviderRunStore,
            selfHostedAuthRunStore: {
                load: vi.fn(() => { throw new Error('beta must not load selfhosted receipt'); }),
                checkpoint: vi.fn(),
            },
            contextStore: reverseLikeContext(policy),
            adapter: { getPostLikers: apifyLikers, getPostComments: vi.fn() },
            selfHostedAuthAdapter: { getPostLikers: selfHostedLikers, getPostComments: vi.fn() },
            env: {
                SELFHOSTED_AUTH_ENABLED: 'true',
                SCRAPER_LIKERS: 'selfhosted_auth',
                SCRAPER_FALLBACK: 'false',
                APIFY_PRIMARY_API_TOKEN: 'primary-test-token',
                APIFY_TERTIARY_API_TOKEN: 'tertiary-test-token',
                APIFY_QUATERNARY_API_TOKEN: 'quaternary-test-token',
                APIFY_QUINARY_API_TOKEN: 'quinary-test-token',
                APIFY_SENARY_API_TOKEN: 'senary-test-token',
                APIFY_SEPTENARY_API_TOKEN: 'septenary-test-token',
            },
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
                declaredLikesCount: 1,
            }],
            limitPerPost: 100,
        })).rejects.toThrow('ANALYSIS_V2_REVERSE_LIKE_PROVIDER_RUN_NOT_SUCCEEDED');

        expect(apifyLikers).toHaveBeenCalledOnce();
        expect(selfHostedLikers).not.toHaveBeenCalled();
        expect(bindAdapterCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
            credentialSlot: 'tertiary',
        }));
    });

    it('uses the named Apify paid route even when the legacy liker selector requests auth', async () => {
        const bindAdapterCheckpoint = vi.fn(async () => ({ stored: null, checkpoint: {} }));
        const apifyLikers = vi.fn(async () => []);
        const selfHostedLikers = vi.fn(async () => {
            throw new Error('named Apify route must not call selfhosted auth');
        });
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: {
                bindAdapterCheckpoint,
                load: vi.fn(async () => ({ status: 'succeeded', runId: 'RUN123456' })),
            } as unknown as AnalysisV2ProviderRunStore,
            selfHostedAuthRunStore: {
                load: vi.fn(async () => null),
                checkpoint: vi.fn(),
            },
            contextStore: reverseLikeContext(),
            adapter: { getPostLikers: apifyLikers, getPostComments: vi.fn() },
            selfHostedAuthAdapter: {
                getPostLikers: selfHostedLikers,
                getPostComments: vi.fn(),
            },
            env: {
                ANALYSIS_V2_INSTAGRAM_ROUTE: 'apify_v1',
                SELFHOSTED_AUTH_ENABLED: 'true',
                SCRAPER_LIKERS: 'selfhosted_auth',
            },
        });

        await collector.collect({
            requestId,
            jobKey: 'track:reverse-likes:collect',
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            candidates: [{
                candidateId: 'candidate:a',
                postUrl: 'https://instagram.com/p/POST_A/',
                declaredLikesCount: 1,
            }],
            limitPerPost: 100,
        });

        expect(apifyLikers).toHaveBeenCalledOnce();
        expect(selfHostedLikers).not.toHaveBeenCalled();
    });

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
        const revenueRpc = vi.fn();
        const revenueCostOperationStore = new RevenueCostOperationStore({ rpc: revenueRpc });
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore,
            revenueCostOperationStore,
            contextStore: reverseLikeContext(authorizedProviderPolicy),
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {
                SELFHOSTED_AUTH_ENABLED: 'false',
                SCRAPER_FALLBACK: 'false',
                SCRAPER_PROFILE: 'apify',
                SCRAPER_PROFILES_BATCH: 'apify',
                SCRAPER_FOLLOWERS: 'apify',
                SCRAPER_FOLLOWING: 'apify',
                SCRAPER_LIKERS: 'apify',
                SCRAPER_COMMENTS: 'apify',
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'primary',
                APIFY_PRIMARY_API_TOKEN: 'primary-test-token',
                APIFY_SECONDARY_API_TOKEN: 'secondary-test-token',
                APIFY_TERTIARY_API_TOKEN: 'tertiary-test-token',
                APIFY_QUATERNARY_API_TOKEN: 'quaternary-test-token',
                APIFY_QUINARY_API_TOKEN: 'quinary-test-token',
            },
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
        expect((bindAdapterCheckpoint.mock.calls[0] as unknown as unknown[])[1]).toMatchObject({
            revenueCostOperationStore,
            jobInputHash: consumerInputHash,
        });
        expect(revenueRpc).not.toHaveBeenCalled();
        expect(result.operationKey).toMatch(/^candidate-likers:[a-f0-9]{64}$/);
        expect(result.results).toEqual([
            {
                candidateId: 'candidate:a',
                status: 'observed',
            },
            { candidateId: 'candidate:b', status: 'not_observed' },
        ]);
    });

    it('collects reverse likes through selfhosted_auth without reserving a paid run', async () => {
        const bindAdapterCheckpoint = vi.fn();
        const load = vi.fn(async () => null);
        const receiptCache = new Map<string, AnalysisV2SelfHostedAuthRunReceipt>();
        const checkpoint = vi.fn(async (receipt) => {
            const stored = {
                schemaVersion: 1 as const,
                provider: 'selfhosted_auth' as const,
                operationKey: receipt.operationKey,
                inputHash: receipt.inputHash,
                runId: receipt.runId,
                accountSlot: 'primary' as const,
                items: receipt.items,
            };
            receiptCache.set(receipt.operationKey, stored);
            return stored;
        });
        const getPostLikers = vi.fn(async (urls: string[], _limit: number, context) => {
            await context?.onSelfHostedAuthRunFinished?.({
                provider: 'selfhosted_auth',
                runId: '33333333333333333333333333333333',
                accountSlot: 'primary',
            });
            return [{
                postUrl: urls[0]!,
                id: '1',
                username: 'target.account',
                profilePicUrl: 'https://cdninstagram.com/profile.jpg',
                isPrivate: false,
                isVerified: false,
                totalLikes: 1,
            }];
        });
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: {
                bindAdapterCheckpoint: vi.fn(async () => ({ stored: null, checkpoint: {} })),
                load,
            } as unknown as AnalysisV2ProviderRunStore,
            selfHostedAuthRunStore: {
                load: vi.fn(async value => receiptCache.get(value.operationKey) ?? null),
                checkpoint,
            },
            contextStore: reverseLikeContext(),
            selfHostedAuthAdapter: { getPostLikers, getPostComments: vi.fn() },
            adapter: {
                getPostLikers: vi.fn(() => { throw new Error('unexpected Apify call'); }),
                getPostComments: vi.fn(),
            },
            env: {
                ANALYSIS_V2_INSTAGRAM_ROUTE: 'selfhosted_auth_v1',
                SELFHOSTED_AUTH_ENABLED: 'true',
            },
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
                declaredLikesCount: 1,
            }],
            limitPerPost: 100,
        });
        await collector.collect({
            requestId,
            jobKey: 'track:reverse-likes:collect',
            claimToken,
            jobInputHash: consumerInputHash,
            targetUsername: 'target.account',
            candidates: [{
                candidateId: 'candidate:a',
                postUrl: 'https://instagram.com/p/POST_A/',
                declaredLikesCount: 1,
            }],
            limitPerPost: 100,
        });

        expect(bindAdapterCheckpoint).not.toHaveBeenCalled();
        expect(checkpoint).toHaveBeenCalledOnce();
        expect(getPostLikers).toHaveBeenCalledOnce();
        expect(getPostLikers.mock.calls[0]![2]).toMatchObject({
            selfHostedAuthIdentity: {
                operationKey: expect.stringMatching(/^candidate-likers:[a-f0-9]{64}$/),
                inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            },
        });
        expect(result.operationKey).toMatch(/^candidate-likers:[a-f0-9]{64}$/);
        expect(result.results).toEqual([{ candidateId: 'candidate:a', status: 'observed' }]);
    });

    it('never falls back when the authenticated worker rejects a schema-invalid response', async () => {
        const apifyLikers = vi.fn();
        const selfHostedLikers = vi.fn(async () => {
            throw new SelfHostedAuthWorkerError('invalid_response', false, 200);
        });
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: {
                load: vi.fn(async () => null),
                bindAdapterCheckpoint: vi.fn(async () => ({ stored: null, checkpoint: {} })),
            } as unknown as AnalysisV2ProviderRunStore,
            selfHostedAuthRunStore: {
                load: vi.fn(async () => null),
                checkpoint: vi.fn(),
            },
            contextStore: reverseLikeContext(),
            adapter: { getPostLikers: apifyLikers, getPostComments: vi.fn() },
            selfHostedAuthAdapter: {
                getPostLikers: selfHostedLikers,
                getPostComments: vi.fn(),
            },
            env: {
                ANALYSIS_V2_INSTAGRAM_ROUTE: 'selfhosted_auth_v1',
                SELFHOSTED_AUTH_ENABLED: 'true',
            },
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
                declaredLikesCount: 1,
            }],
            limitPerPost: 100,
        })).rejects.toMatchObject({ code: 'invalid_response' });
        expect(selfHostedLikers).toHaveBeenCalledOnce();
        expect(apifyLikers).not.toHaveBeenCalled();
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
            contextStore: reverseLikeContext(),
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
            contextStore: reverseLikeContext(),
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
        const revenueRpc = vi.fn();
        const revenueCostOperationStore = new RevenueCostOperationStore({ rpc: revenueRpc });
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
            revenueCostOperationStore,
            contextStore: reverseLikeContext(),
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
        expect((bindAdapterCheckpoint.mock.calls as unknown as unknown[][])
            .every(call => call.length === 1)).toBe(true);
        expect(revenueRpc).not.toHaveBeenCalled();
    });

    it('never confirms absence when the provider hid the declared liker count', async () => {
        const providerRunStore = {
            bindAdapterCheckpoint: vi.fn(async () => ({ stored: null, checkpoint: {} })),
            load: vi.fn(async () => ({ status: 'succeeded', runId: 'RUN123456' })),
        } as unknown as AnalysisV2ProviderRunStore;
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore,
            contextStore: reverseLikeContext(),
            adapter: { getPostLikers: vi.fn(async () => []), getPostComments: vi.fn() },
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
                declaredLikesCount: 0,
                declaredLikesCountKnown: false,
            }],
            limitPerPost: 100,
        });

        expect(result.results).toEqual([{ candidateId: 'candidate:a', status: 'not_collected' }]);
    });

    it('does not reserve or call a paid provider when no shortlist post is collectable', async () => {
        const bindAdapterCheckpoint = vi.fn();
        const getPostLikers = vi.fn();
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: {
                bindAdapterCheckpoint,
            } as unknown as AnalysisV2ProviderRunStore,
            contextStore: reverseLikeContext(),
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

describe('Dev Standard reverse-like archive', () => {
    function createCollector() {
        const bindAdapterCheckpoint = vi.fn(async () => ({ stored: null, checkpoint: {} }));
        const getPostLikers = vi.fn(async () => [{
            postUrl: 'https://www.instagram.com/p/POST_B/',
            id: '1',
            username: 'synthetic.non_target',
            profilePicUrl: 'https://cdninstagram.com/other.jpg',
            isPrivate: false,
            isVerified: false,
            totalLikes: 114,
        }]);
        const base = reverseLikeContext();
        const collector = createAnalysisV2ReverseLikeCollector({
            providerRunStore: {
                bindAdapterCheckpoint,
                load: vi.fn(async () => ({ status: 'succeeded', runId: 'RUN123456' })),
            } as unknown as AnalysisV2ProviderRunStore,
            contextStore: {
                load: async claim => ({
                    ...await base.load(),
                    requestId: claim.requestId,
                    planId: 'standard',
                    accessMode: 'test_entitlement',
                }),
            },
            adapter: { getPostLikers, getPostComments: vi.fn() },
            env: {},
        });
        return { collector, bindAdapterCheckpoint, getPostLikers };
    }

    const archivedInput = {
        requestId,
        jobKey: 'track:reverse-likes:collect',
        claimToken,
        jobInputHash: consumerInputHash,
        targetUsername: 'target.account',
        candidates: [
            { candidateId: 'candidate:a', postUrl: 'https://instagram.com/p/POST_A/', declaredLikesCount: 0 },
            { candidateId: 'candidate:b', postUrl: 'https://instagram.com/p/POST_B/', declaredLikesCount: 114 },
        ],
        limitPerPost: 100 as const,
    };

    it('reuses verified per-post status, with no provider reservation or raw liker data', async () => {
        const stored = new Map<string, unknown>();
        const capture = archiveScope('capture', stored);
        const live = createCollector();
        const original = await live.collector.collect(archivedInput);
        expect(live.bindAdapterCheckpoint).toHaveBeenCalledOnce();
        expect(live.getPostLikers).toHaveBeenCalledOnce();
        expect(original.results).toEqual([
            { candidateId: 'candidate:a', status: 'not_observed' },
            { candidateId: 'candidate:b', status: 'not_collected' },
        ]);
        expect(capture.capture).toHaveBeenCalledExactlyOnceWith(
            'reverse-coverage-v1', ['target.account'],
            { scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/), results: original.results },
        );
        expect(JSON.stringify([...stored.values()])).not.toContain('synthetic.non_target');

        archiveScope('replay', stored);
        const replay = createCollector();
        const replayed = await replay.collector.collect({
            ...archivedInput,
            requestId: '9a9838e0-ad64-453b-8971-cb69a57b7381',
            candidates: [...archivedInput.candidates].reverse(),
        });
        expect(replayed.operationKey).toMatch(/^archive-candidate-likers:[a-f0-9]{64}$/);
        expect(replayed.results).toEqual([...original.results].reverse());
        await expect(replay.collector.collect({
            ...archivedInput,
            candidates: [{ ...archivedInput.candidates[0]!, postUrl: 'https://instagram.com/p/OTHER/' }],
        })).rejects.toBeInstanceOf(DevStandardArchiveError);
        expect(replay.bindAdapterCheckpoint).not.toHaveBeenCalled();
        expect(replay.getPostLikers).not.toHaveBeenCalled();
    });

    it('requires an observed empty scope rather than accepting a missing fragment', async () => {
        const stored = new Map<string, unknown>();
        const empty = { ...archivedInput, candidates: [] };
        const { collector, getPostLikers, bindAdapterCheckpoint } = createCollector();
        archiveScope('replay', stored);
        await expect(collector.collect(empty)).rejects.toBeInstanceOf(DevStandardArchiveError);
        archiveScope('capture', stored);
        await collector.collect(empty);
        archiveScope('replay', stored);
        await expect(collector.collect(empty)).resolves.toEqual({ operationKey: null, results: [] });
        expect(getPostLikers).not.toHaveBeenCalled();
        expect(bindAdapterCheckpoint).not.toHaveBeenCalled();
    });
});

describe('Dev Standard AI image archive', () => {
    const remainder = Array.from({ length: 3 }, (_, i) => ({
        selectionId: 'profile:offline' + i, imageUrl: 'https://cdninstagram.com/offline' + i + '.jpg', role: 'profile' as const,
    }));
    const version = 'ai-stage-policy-v2.11';
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

    it('completes an interrupted skipped selection from its saved children and replays its exact outcomes', async () => {
        const records = new Map<string, unknown>();
        const capture = archiveScope('capture', records);
        const write = capture.capture.getMockImplementation()!;
        let interrupted = false;
        capture.capture.mockImplementation(async (kind, id, value) => {
            if (kind === 'ai-image' && id[2] === 1 && !interrupted) {
                interrupted = true;
                throw new DevStandardArchiveError();
            }
            await write(kind, id, value);
        });
        const source = vi.fn(async (item: SelectedAnalysisMedia) => {
            if (item === remainder[1]) throw new AnalysisImagePreparationError('decode_failed', 'permanent');
            if (item === remainder[2]) throw new AnalysisImagePreparationError('network_failure', 'transient');
            return jpeg;
        });
        await expect(captureDevStandardMediaSelection(remainder, source, version)).rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        expect(records.size).toBe(2);
        await captureDevStandardMediaSelection(remainder, source, version);
        expect(source.mock.calls.map(([item]) => item.selectionId)).toHaveLength(5);
        expect(source.mock.calls.filter(([item]) => item === remainder[0])).toHaveLength(1);
        await captureDevStandardMediaSelection(remainder, source, version);
        expect(source).toHaveBeenCalledTimes(5);
        const replay = archiveScope('replay', records);
        const noSource = vi.fn();
        await captureDevStandardMediaSelection(remainder, noSource, version);
        expect(replay.find).not.toHaveBeenCalled();
        const normalized = await normalizeAnalysisV2MediaSelections(remainder, noSource, version);
        expect(normalized.bytes.get(remainder[0]!.selectionId)).toEqual(jpeg);
        expect(normalized.coverage.failures.map(failure => failure.disposition)).toEqual(['permanent', 'transient']);
        const marker = [...records.keys()].find(k => k.includes('ai-image-selection-v1'))!;
        const members = records.get(marker) as unknown[];
        records.set(marker, [...members].reverse());
        await expect(normalizeAnalysisV2MediaSelections(remainder, noSource, version)).rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        expect(noSource).not.toHaveBeenCalled();
    });

    it('backs up pinned bytes and failure reasons without another source download and rejects conflicts', async () => {
        const noSource = vi.fn();
        await captureDevStandardMediaSelection(remainder, noSource, version);
        expect(noSource).not.toHaveBeenCalled();
        const pinned = await normalizeAnalysisV2MediaSelections(remainder, async item => {
            if (item === remainder[1]) throw new AnalysisImagePreparationError('decode_failed', 'permanent');
            return jpeg;
        }, version);
        const records = new Map<string, unknown>();
        archiveScope('capture', records);
        await captureDevStandardMediaSelection(remainder, noSource, version, async () => pinned);
        await captureDevStandardMediaSelection(remainder, noSource, version, async () => pinned);
        const conflict = new Map(pinned.bytes);
        conflict.set(remainder[0]!.selectionId, Buffer.from([0xff, 0xd8, 0, 0xff, 0xd9]));
        await expect(captureDevStandardMediaSelection(remainder, noSource, version,
            async () => ({ ...pinned, bytes: conflict }))).rejects.toThrow('DEV_STANDARD_ARCHIVE_UNAVAILABLE');
        archiveScope('replay', records);
        await expect(normalizeAnalysisV2MediaSelections(remainder, noSource, version)).resolves.toEqual(pinned);
        expect(noSource).not.toHaveBeenCalled();
    });

    it('round-trips JPEG and observed media failures without downloading or downgrading an archive miss', async () => {
        const stored = new Map<string, unknown>();
        const jpeg = Buffer.from([0xff, 0xd8, 0x11, 0xff, 0xd9]);
        const selected = [
            { selectionId: 'profile:one', imageUrl: 'https://cdninstagram.com/one.jpg?oh=mock-signature', role: 'profile' as const },
            { selectionId: 'profile:two', imageUrl: 'https://cdninstagram.com/two.jpg', role: 'profile' as const },
        ];
        const normalize = vi.fn()
            .mockResolvedValueOnce(jpeg)
            .mockRejectedValueOnce(new AnalysisImagePreparationError('decode_failed', 'permanent'));
        archiveScope('capture', stored);
        const observed = await normalizeAnalysisV2MediaSelections(selected, normalize);
        expect(observed.coverage.failures).toEqual([{
            selectionId: 'profile:two', reason: 'decode_failed', disposition: 'permanent',
        }]);

        const retryNormalize = vi.fn();
        await expect(normalizeAnalysisV2MediaSelections(selected, retryNormalize)).resolves.toEqual(observed);
        expect(retryNormalize).not.toHaveBeenCalled();

        archiveScope('replay', stored);
        const nextNormalize = vi.fn();
        await expect(normalizeAnalysisV2MediaSelections(selected.map(item => ({
            ...item, imageUrl: archiveMediaUrlAnchor(item.imageUrl),
        })), nextNormalize)).resolves.toEqual(observed);
        await expect(normalizeAnalysisV2MediaSelections([
            selected[0]!, { ...selected[1]!, imageUrl: 'https://cdninstagram.com/unrecorded.jpg' },
        ], nextNormalize)).rejects.toBeInstanceOf(DevStandardArchiveError);
        expect(nextNormalize).not.toHaveBeenCalled();
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

    it('uses the trusted proxy download when the direct CDN download is transient', async () => {
        const download = vi.fn(async () => {
            throw new Error('upstream unavailable');
        });
        const downloadFallback = vi.fn(async () => Buffer.from('proxy-source'));
        const normalize = vi.fn(async () => Buffer.from('jpeg'));
        const normalizeMedia = createAnalysisV2MediaNormalizer({
            withSlot: task => task(),
            download,
            downloadFallback,
            normalize,
        });

        await expect(normalizeMedia({
            selectionId: 'profile:proxy',
            imageUrl: 'https://cdninstagram.com/profile.jpg',
            role: 'profile',
        })).resolves.toEqual(Buffer.from('jpeg'));
        expect(download).toHaveBeenCalledOnce();
        expect(downloadFallback).toHaveBeenCalledOnce();
        expect(normalize).toHaveBeenCalledWith(Buffer.from('proxy-source'));
    });

    it('uses a transient proxy failure when the direct source was permanently rejected', async () => {
        const normalizeMedia = createAnalysisV2MediaNormalizer({
            withSlot: task => task(),
            download: async () => {
                throw new AnalysisImagePreparationError('source_rejected', 'permanent');
            },
            downloadFallback: async () => {
                throw new AnalysisImagePreparationError('timeout', 'transient');
            },
        });

        await expect(normalizeMedia({
            selectionId: 'profile:proxy-timeout',
            imageUrl: 'https://cdninstagram.com/profile.jpg',
            role: 'profile',
        })).rejects.toMatchObject({ reason: 'timeout', disposition: 'transient' });
    });

    it('preserves a transient direct failure when the proxy rejects permanently', async () => {
        const normalizeMedia = createAnalysisV2MediaNormalizer({
            withSlot: task => task(),
            download: async () => {
                throw new AnalysisImagePreparationError('timeout', 'transient');
            },
            downloadFallback: async () => {
                throw new AnalysisImagePreparationError('blocked_source', 'permanent');
            },
        });

        await expect(normalizeMedia({
            selectionId: 'profile:proxy-rejected',
            imageUrl: 'https://cdninstagram.com/profile.jpg',
            role: 'profile',
        })).rejects.toMatchObject({ reason: 'timeout', disposition: 'transient' });
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
