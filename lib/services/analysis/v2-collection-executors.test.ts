import { describe, expect, it, vi } from 'vitest';
import type { ProfileAttemptResult } from '@/lib/services/instagram/providers/types';
import type {
    ApifyPostComment,
    ApifyPostLiker,
} from '@/lib/services/instagram/providers/apify-interactions';
import type { InstagramFollower, InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import type { AnalysisV2DagState } from './v2-dag-planner';
import type { AnalysisV2EvidenceStore } from './v2-evidence-store';
import type { AnalysisV2TargetEvidenceCheckpointInput } from './v2-evidence-store';
import type {
    AnalysisV2ProfileAttemptResultInput,
    AnalysisV2ProfileFetchCheckpointStore,
    AnalysisV2ProfileFetchResume,
} from './v2-profile-fetch-store';
import type {
    AnalysisV2ProviderRunReservationInput,
    AnalysisV2ProviderRunStore,
    StoredAnalysisV2ProviderRun,
} from './v2-provider-run-store';
import type { AnalysisV2TargetProfileReuseStore } from './v2-target-profile-reuse';
import {
    AnalysisV2CollectionContextFenceError,
    type AnalysisV2CollectionRequestContext,
    type AnalysisV2CollectionRequestContextStore,
} from './v2-request-context';
import type { AnalysisV2StageExecutorContext } from './v2-worker';
import {
    createAnalysisV2CollectionTopology,
    createAnalysisV2ProfileFetchExecutor,
    createAnalysisV2RelationshipsExecutor,
    createAnalysisV2TargetEvidenceExecutor,
} from './v2-collection-executors';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

// gitleaks:allow -- deterministic UUID fixture
const requestId = '7df77338-2672-4ef2-93fe-13a0683ec9b4';
// gitleaks:allow -- deterministic UUID fixture
const claimToken = '51b42f42-204d-4dfb-86f8-9658d21c78f1';
// gitleaks:allow -- deterministic UUID fixture
const reservationToken = 'f920fd7c-5091-42e8-9623-78be7a57dc88';
const inputHash = 'a'.repeat(64);
const resultHash = 'b'.repeat(64);
const capturedAt = '2026-07-13T07:30:00.000Z';

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

const authorizedProviderEnv = {
    APIFY_PRIMARY_API_TOKEN: 'primary-test-token',
    APIFY_SECONDARY_API_TOKEN: 'secondary-test-token',
    APIFY_TERTIARY_API_TOKEN: 'tertiary-test-token',
    APIFY_QUATERNARY_API_TOKEN: 'quaternary-test-token',
    APIFY_QUINARY_API_TOKEN: 'quinary-test-token',
};

function requestContext(
    overrides: Partial<AnalysisV2CollectionRequestContext> = {}
): AnalysisV2CollectionRequestContext {
    return {
        requestId,
        targetUsername: 'target',
        excludedUsername: 'girlfriend',
        accessMode: 'production',
        providerExecutionPolicy: null,
        planId: 'basic',
        followersDeclaredCount: 2,
        followingDeclaredCount: 2,
        detailedMutualLimit: 300,
        ...overrides,
    };
}

function contextStore(
    value: AnalysisV2CollectionRequestContext
): AnalysisV2CollectionRequestContextStore {
    return { load: vi.fn(async () => value) };
}

function state(
    overrides: Partial<AnalysisV2DagState> = {}
): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: 'c'.repeat(64),
        planId: 'basic',
        planSnapshotHash: 'd'.repeat(64),
        girlfriendExclusion: {
            decisionHash: 'e'.repeat(64),
            excludedCount: 1,
        },
        ...overrides,
    };
}

function stageContext<S extends 'relationships' | 'target_evidence' | 'profile_fetch'>(
    stage: S,
    dagState: AnalysisV2DagState,
    batch: number | null = null,
    jobInputHash = inputHash
): AnalysisV2StageExecutorContext<S> {
    const jobKey = stage === 'relationships'
        ? 'track:relationships:collect'
        : stage === 'target_evidence'
          ? 'track:target-evidence:collect'
          : `track:profiles:batch:${batch}`;
    const track = stage === 'target_evidence'
        ? 'target_evidence'
        : stage === 'profile_fetch'
          ? 'profiles'
          : 'relationships';
    const kind = stage === 'profile_fetch' ? 'profile_fetch' : 'collection';
    return {
        stage,
        claim: {
            requestId,
            jobKey,
            track,
            kind,
            batch,
            inputHash: jobInputHash,
            generation: 1,
            reservationToken,
            claimToken,
            attemptCount: 1,
        },
        job: {
            requestId,
            jobKey,
            track,
            kind,
            batch,
            inputHash: jobInputHash,
            requiredJobKeys: stage === 'profile_fetch'
                ? ['track:relationships:collect']
                : [],
        },
        state: dagState,
    } as AnalysisV2StageExecutorContext<S>;
}

function post(index: number, type: InstagramPost['type'] = 'image'): InstagramPost {
    return {
        id: `post-${index}`,
        shortCode: `code_${index}`,
        ...(type === 'image'
            ? { imageUrl: `https://images.example/${index}.jpg` }
            : { thumbnailUrl: `https://images.example/${index}.jpg` }),
        type,
        likesCount: 100 + index,
        commentsCount: 20 + index,
        timestamp: new Date(Date.UTC(2026, 6, 13, 7, index)).toISOString(),
        taggedUsers: [],
        mentionedUsers: [],
    };
}

function profile(username: string, posts: InstagramPost[] = [post(0)]): InstagramProfile {
    return {
        username,
        fullName: `${username} name`,
        bio: `${username} bio`,
        profilePicUrl: `https://images.example/${username}.jpg`,
        followersCount: 20,
        followingCount: 10,
        postsCount: posts.length,
        isPrivate: false,
        isVerified: false,
        latestPosts: posts,
    };
}

function success(username: string, source: 'selfhosted' | 'apify' = 'selfhosted') {
    return {
        outcome: {
            requestedUsername: username,
            source,
            status: 'success' as const,
            failureCategory: null,
            httpStatus: null,
            requestCount: 1,
            latencyMs: 10,
            capturedAt,
        },
        profile: profile(username),
    };
}

function failure(username: string, source: 'selfhosted' | 'apify' = 'selfhosted') {
    return {
        outcome: {
            requestedUsername: username,
            source,
            status: 'failed' as const,
            failureCategory: 'timeout' as const,
            httpStatus: 504,
            requestCount: 1,
            latencyMs: 10,
            capturedAt,
        },
    };
}

function incompleteFailure(username: string, source: 'selfhosted' | 'apify' = 'apify') {
    return {
        outcome: {
            requestedUsername: username,
            source,
            status: 'failed' as const,
            failureCategory: 'incomplete' as const,
            httpStatus: null,
            requestCount: 1,
            latencyMs: 10,
            capturedAt,
        },
    };
}

function unavailable(username: string) {
    return {
        outcome: {
            requestedUsername: username,
            source: 'apify' as const,
            status: 'unavailable' as const,
            failureCategory: 'not_found' as const,
            httpStatus: 404,
            requestCount: 1,
            latencyMs: 10,
            capturedAt,
        },
    };
}

function completedResume(
    usernames: readonly string[],
    profiles: AnalysisV2ProfileFetchResume['primaryResults'] =
        usernames.map(username => success(username))
): AnalysisV2ProfileFetchResume {
    return {
        requestId,
        jobKey: 'track:profiles:batch:0',
        requestedUsernames: [...usernames],
        frozenUnresolvedUsernames: [],
        primaryResults: profiles,
        fallbackResults: [],
        primaryCapturedAt: capturedAt,
        fallbackCapturedAt: null,
    };
}

function completedFallbackResume(
    usernames: readonly string[],
    finalFailures: readonly AnalysisV2ProfileFetchResume['fallbackResults'][number][]
): AnalysisV2ProfileFetchResume {
    const failedUsernames = new Set(finalFailures.map(result => result.outcome.requestedUsername));
    return {
        ...completedResume(usernames, usernames.map(username => (
            failedUsernames.has(username) ? failure(username) : success(username)
        ))),
        frozenUnresolvedUsernames: usernames.filter(username => failedUsernames.has(username)),
        fallbackResults: [...finalFailures],
        fallbackCapturedAt: capturedAt,
    };
}

function inMemoryProfileStore(initial: AnalysisV2ProfileFetchResume | null) {
    let current = initial;
    const store: AnalysisV2ProfileFetchCheckpointStore = {
        load: vi.fn(async () => current),
        checkpointPrimary: vi.fn(async (input: {
            requestId: string;
            jobKey: string;
            claimToken: string;
            jobInputHash: string;
            requestedUsernames: readonly string[];
            results: readonly AnalysisV2ProfileAttemptResultInput[];
        }) => {
            const unresolved = input.results
                .filter(result => result.outcome.status !== 'success')
                .map(result => result.outcome.requestedUsername);
            current = {
                requestId: input.requestId,
                jobKey: input.jobKey,
                requestedUsernames: [...input.requestedUsernames],
                frozenUnresolvedUsernames: unresolved,
                primaryResults: input.results as AnalysisV2ProfileFetchResume['primaryResults'],
                fallbackResults: [],
                primaryCapturedAt: capturedAt,
                fallbackCapturedAt: null,
            };
            return current;
        }),
        checkpointFallback: vi.fn(async (input: {
            results: readonly AnalysisV2ProfileAttemptResultInput[];
        }) => {
            if (!current) throw new Error('missing primary');
            current = {
                ...current,
                fallbackResults: input.results as AnalysisV2ProfileFetchResume['fallbackResults'],
                fallbackCapturedAt: capturedAt,
            };
            return current;
        }),
        purgeTerminal: vi.fn(async () => 0),
    };
    return { store, current: () => current };
}

function storedRun(
    input: AnalysisV2ProviderRunReservationInput,
    status: StoredAnalysisV2ProviderRun['status'] = 'succeeded'
): StoredAnalysisV2ProviderRun {
    return {
        requestId: input.requestId,
        jobKey: input.jobKey,
        operationKey: input.operationKey,
        inputHash: input.inputHash,
        logicalProvider: 'apify',
        actorId: input.actorId,
        credentialSlot: input.credentialSlot,
        maxChargeUsd: input.maxChargeUsd,
        reservationToken,
        status,
        runId: status === 'starting' ? null : `run${input.operationKey.slice(-8)}`,
        actualUsageUsd: status === 'succeeded' ? 0.01 : null,
        reservedAt: capturedAt,
        runStartedAt: status === 'starting' ? null : capturedAt,
        terminalizedAt: status === 'succeeded' ? capturedAt : null,
        usageReconciledAt: status === 'succeeded' ? capturedAt : null,
    };
}

function providerStore(callOrder: string[] = []) {
    const runs = new Map<string, StoredAnalysisV2ProviderRun>();
    const bindAdapterCheckpoint = vi.fn(async (input: AnalysisV2ProviderRunReservationInput) => {
        callOrder.push(`bind:${input.operationKey.split(':', 1)[0]}`);
        runs.set(input.operationKey, storedRun(input));
        return {
            stored: null,
            checkpoint: {
                logicalProvider: input.logicalProvider,
                actorId: input.actorId,
                credentialSlot: input.credentialSlot,
                maxChargeUsd: input.maxChargeUsd,
                onBeforeRunStart: vi.fn(),
                onRunStarted: vi.fn(),
            },
        };
    });
    const load = vi.fn(async (input: { operationKey: string }) => runs.get(input.operationKey) ?? null);
    return {
        bindAdapterCheckpoint,
        load,
        value: {
            bindAdapterCheckpoint,
            load,
        } as unknown as AnalysisV2ProviderRunStore,
    };
}

function reusableTargetProfileRunStore(
    value: Awaited<ReturnType<AnalysisV2TargetProfileReuseStore['load']>> = {
        runId: 'FreshAdmissionRun123',
        inputHash: 'f'.repeat(64),
        logicalProvider: 'apify',
        actorId: 'apify/instagram-profile-scraper',
        credentialSlot: 'quinary',
        maxChargeUsd: 0.0026,
    }
) {
    const load = vi.fn(async () => value);
    return { load, value: { load } as AnalysisV2TargetProfileReuseStore };
}

describe('analysis V2 concrete collection executors', () => {
    it('collects both exact preflight relationship sides concurrently and builds frozen topology', async () => {
        const starts: string[] = [];
        let release: (() => void) | undefined;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const getter = (side: string) => vi.fn(async () => {
            starts.push(side);
            if (starts.length === 2) release?.();
            await gate;
            return side === 'followers'
                ? [
                    { username: 'alice', isPrivate: false, isVerified: false },
                    { username: 'private_a', isPrivate: true, isVerified: false },
                ]
                : [
                    { username: 'alice', isPrivate: false, isVerified: false },
                    { username: 'private_a', isPrivate: true, isVerified: false },
                ];
        });
        const getFollowersMock = getter('followers');
        const getFollowingMock = getter('following');
        const providers = providerStore();
        const checkpointRelationshipSide = vi.fn(async (input) => ({
            side: input.side,
            sourceStatus: input.source.status,
            revision: 1,
            declaredCount: input.declaredCount,
            collectedCount: input.rows.length,
            coverageBps: 10_000,
            inputHash: input.source.inputHash,
            resultHash,
        }));
        const evidence = {
            checkpointRelationshipSide,
            freezeRelationships: vi.fn(async () => ({
                revision: 1,
                resultHash,
                exclusionDecisionHash: 'f'.repeat(64),
                followersResultHash: resultHash,
                followingResultHash: resultHash,
                mutualCount: 2,
                publicCount: 1,
                privateCount: 1,
                detailedPublicCount: 1,
                unscreenedPublicCount: 0,
            })),
            loadRelationshipStaging: vi.fn(async () => ({
                excludedUsername: 'girlfriend',
                detailedPublicUsernames: ['alice'],
                privateMutualUsernames: ['private_a'],
            })),
        } as unknown as AnalysisV2EvidenceStore;
        const executor = createAnalysisV2RelationshipsExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: evidence,
            providerRunStore: providers.value,
            getFollowers: getFollowersMock,
            getFollowing: getFollowingMock,
            env: {
                APIFY_API_TOKEN_SLOT: 'primary',
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'tertiary',
            },
        });

        const result = await executor(stageContext('relationships', state()));

        expect(starts).toEqual(['followers', 'following']);
        expect(getFollowersMock).toHaveBeenCalledWith('target', 2, expect.objectContaining({
            provider: 'apify',
            fallback: false,
            expectedResultCount: 2,
            providerRun: expect.objectContaining({ credentialSlot: 'tertiary' }),
        }));
        expect(getFollowingMock).toHaveBeenCalledWith('target', 2, expect.objectContaining({
            provider: 'apify',
            fallback: false,
            expectedResultCount: 2,
            providerRun: expect.objectContaining({ credentialSlot: 'tertiary' }),
        }));
        expect(checkpointRelationshipSide).toHaveBeenCalledTimes(2);
        expect(providers.bindAdapterCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({ credentialSlot: 'tertiary' })
        );
        expect(result.checkpoint.manifest.profileBatches).toHaveLength(1);
        expect(result.checkpoint.manifest.privateNameBatches).toHaveLength(1);
        const followerOptions = (
            getFollowersMock.mock.calls as unknown as Array<[
                string,
                number,
                Record<string, unknown>,
            ]>
        )[0]?.[2];
        expect(followerOptions).not.toHaveProperty('cookie');
        expect(followerOptions).not.toHaveProperty('cookies');
        expect(followerOptions).not.toHaveProperty('session');
    });

    it('waits for both relationship branches and rethrows the first failure by input order', async () => {
        const followerFailure = new Error('followers failed after following');
        const followingFailure = new Error('following failed first');
        let rejectFollowers: (reason?: unknown) => void = () => undefined;
        const getFollowersMock = vi.fn(() => new Promise<InstagramFollower[]>((_, reject) => {
            rejectFollowers = reject;
        }));
        const getFollowingMock = vi.fn(async (): Promise<InstagramFollower[]> => {
            throw followingFailure;
        });
        const freezeRelationships = vi.fn();
        const checkpointRelationshipSide = vi.fn();
        const executor = createAnalysisV2RelationshipsExecutor({
            requestContextStore: contextStore(requestContext()),
            providerRunStore: providerStore().value,
            getFollowers: getFollowersMock,
            getFollowing: getFollowingMock,
            evidenceStore: {
                checkpointRelationshipSide,
                freezeRelationships,
            } as unknown as AnalysisV2EvidenceStore,
        });

        const execution = executor(stageContext('relationships', state()));
        let outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending';
        let rejection: unknown;
        const observed = execution.then(
            () => { outcome = 'fulfilled'; },
            (reason: unknown) => {
                outcome = 'rejected';
                rejection = reason;
            }
        );

        await vi.waitFor(() => {
            expect(getFollowersMock).toHaveBeenCalledOnce();
            expect(getFollowingMock).toHaveBeenCalledOnce();
        });
        await Promise.resolve();

        expect(outcome).toBe('pending');

        rejectFollowers(followerFailure);
        await observed;

        expect(outcome).toBe('rejected');
        expect(rejection).toBe(followerFailure);
        expect(checkpointRelationshipSide).not.toHaveBeenCalled();
        expect(freezeRelationships).not.toHaveBeenCalled();
    });

    it('cancels an earlier queued relationship tuple without masking a later real failure', async () => {
        const realFailure = new Error('following provider failed');
        let followerSignal: AbortSignal | undefined;
        let rejectFollowers: (reason?: unknown) => void = () => undefined;
        let rejectFollowing: (reason?: unknown) => void = () => undefined;
        const getFollowersMock = vi.fn((_username, _limit, options) => (
            new Promise<InstagramFollower[]>((_, reject) => {
                rejectFollowers = reject;
                followerSignal = options?.providerRun?.startCancellationSignal;
                followerSignal?.addEventListener('abort', () => {
                    reject(new Error('SCRAPING_QUEUED_START_CANCELLED'));
                }, { once: true });
            })
        ));
        const getFollowingMock = vi.fn(() => new Promise<InstagramFollower[]>((_, reject) => {
            rejectFollowing = reject;
        }));
        const freezeRelationships = vi.fn();
        const checkpointRelationshipSide = vi.fn();
        const executor = createAnalysisV2RelationshipsExecutor({
            requestContextStore: contextStore(requestContext()),
            providerRunStore: providerStore().value,
            getFollowers: getFollowersMock,
            getFollowing: getFollowingMock,
            evidenceStore: {
                checkpointRelationshipSide,
                freezeRelationships,
            } as unknown as AnalysisV2EvidenceStore,
        });

        const execution = executor(stageContext('relationships', state()));
        const rejection = expect(execution).rejects.toBe(realFailure);
        await vi.waitFor(() => {
            expect(getFollowersMock).toHaveBeenCalledOnce();
            expect(getFollowingMock).toHaveBeenCalledOnce();
        });

        rejectFollowing(realFailure);
        await Promise.resolve();
        if (!followerSignal) {
            rejectFollowers(new Error('SCRAPING_QUEUED_START_CANCELLED'));
        }

        await rejection;
        expect(followerSignal?.aborted).toBe(true);
        expect(checkpointRelationshipSide).not.toHaveBeenCalled();
        expect(freezeRelationships).not.toHaveBeenCalled();
    });

    it('checkpoints a successful relationship side but never freezes after its sibling fails', async () => {
        const followerFailure = new Error('followers failed');
        let resolveFollowing: (rows: InstagramFollower[]) => void = () => undefined;
        const getFollowersMock = vi.fn(async (): Promise<InstagramFollower[]> => {
            throw followerFailure;
        });
        const getFollowingMock = vi.fn(() => new Promise<InstagramFollower[]>((resolve) => {
            resolveFollowing = resolve;
        }));
        const checkpointRelationshipSide = vi.fn(async (value: unknown) => value);
        const freezeRelationships = vi.fn();
        const executor = createAnalysisV2RelationshipsExecutor({
            requestContextStore: contextStore(requestContext()),
            providerRunStore: providerStore().value,
            getFollowers: getFollowersMock,
            getFollowing: getFollowingMock,
            evidenceStore: {
                checkpointRelationshipSide,
                freezeRelationships,
            } as unknown as AnalysisV2EvidenceStore,
        });

        const execution = executor(stageContext('relationships', state()));
        let outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending';
        let rejection: unknown;
        const observed = execution.then(
            () => { outcome = 'fulfilled'; },
            (reason: unknown) => {
                outcome = 'rejected';
                rejection = reason;
            }
        );

        await vi.waitFor(() => {
            expect(getFollowersMock).toHaveBeenCalledOnce();
            expect(getFollowingMock).toHaveBeenCalledOnce();
        });
        await Promise.resolve();

        expect(outcome).toBe('pending');
        expect(checkpointRelationshipSide).not.toHaveBeenCalled();

        resolveFollowing([
            { username: 'alice', isPrivate: false, isVerified: false },
        ]);
        await observed;

        expect(outcome).toBe('rejected');
        expect(rejection).toBe(followerFailure);
        expect(checkpointRelationshipSide).toHaveBeenCalledOnce();
        expect(checkpointRelationshipSide).toHaveBeenCalledWith(expect.objectContaining({
            side: 'following',
            rows: [expect.objectContaining({ username: 'alice' })],
        }));
        expect(freezeRelationships).not.toHaveBeenCalled();
    });

    it('freezes exact zero relationship sides without reserving or starting Actors', async () => {
        const providers = providerStore();
        const getFollowersMock = vi.fn();
        const getFollowingMock = vi.fn();
        const checkpointRelationshipSide = vi.fn(async (input) => ({
            side: input.side,
            sourceStatus: input.source.status,
            revision: 1,
            declaredCount: input.declaredCount,
            collectedCount: input.rows.length,
            coverageBps: 10_000,
            inputHash: input.source.inputHash,
            resultHash,
        }));
        const evidence = {
            checkpointRelationshipSide,
            freezeRelationships: vi.fn(async () => ({
                revision: 1,
                resultHash,
                exclusionDecisionHash: 'f'.repeat(64),
                followersResultHash: resultHash,
                followingResultHash: resultHash,
                mutualCount: 0,
                publicCount: 0,
                privateCount: 0,
                detailedPublicCount: 0,
                unscreenedPublicCount: 0,
            })),
            loadRelationshipStaging: vi.fn(async () => ({
                excludedUsername: 'girlfriend',
                detailedPublicUsernames: [],
                privateMutualUsernames: [],
            })),
        } as unknown as AnalysisV2EvidenceStore;
        const executor = createAnalysisV2RelationshipsExecutor({
            requestContextStore: contextStore(requestContext({
                followersDeclaredCount: 0,
                followingDeclaredCount: 0,
            })),
            evidenceStore: evidence,
            providerRunStore: providers.value,
            getFollowers: getFollowersMock,
            getFollowing: getFollowingMock,
        });

        const result = await executor(stageContext('relationships', state()));

        expect(providers.bindAdapterCheckpoint).not.toHaveBeenCalled();
        expect(providers.load).not.toHaveBeenCalled();
        expect(getFollowersMock).not.toHaveBeenCalled();
        expect(getFollowingMock).not.toHaveBeenCalled();
        expect(checkpointRelationshipSide).toHaveBeenCalledTimes(2);
        const sources = checkpointRelationshipSide.mock.calls.map(([input]) => input.source);
        expect(sources).toEqual([
            expect.objectContaining({ status: 'not_applicable' }),
            expect.objectContaining({ status: 'not_applicable' }),
        ]);
        expect(sources[0]?.inputHash).toMatch(/^[0-9a-f]{64}$/);
        expect(sources[0]?.inputHash).not.toBe(sources[1]?.inputHash);
        expect(JSON.stringify(sources)).not.toMatch(/provider|operation|runId/i);
        expect(result.checkpoint.manifest).toMatchObject({
            detectedMutualCount: 0,
            profileBatches: [],
            privateNameBatches: [],
        });
    });

    it('uses different immutable relationship slots only for the authorized test policy', async () => {
        const providers = providerStore();
        const rows = [{ username: 'alice', isPrivate: false, isVerified: false }];
        const checkpointRelationshipSide = vi.fn(async (input) => ({
            side: input.side,
            sourceStatus: input.source.status,
            revision: 1,
            declaredCount: input.declaredCount,
            collectedCount: input.rows.length,
            coverageBps: 10_000,
            inputHash: input.source.inputHash,
            resultHash,
        }));
        const executor = createAnalysisV2RelationshipsExecutor({
            requestContextStore: contextStore(requestContext({
                accessMode: 'test_entitlement',
                providerExecutionPolicy: authorizedProviderPolicy,
                followersDeclaredCount: 1,
                followingDeclaredCount: 1,
            })),
            providerRunStore: providers.value,
            env: authorizedProviderEnv,
            getFollowers: vi.fn(async () => rows),
            getFollowing: vi.fn(async () => rows),
            evidenceStore: {
                checkpointRelationshipSide,
                freezeRelationships: vi.fn(async () => ({
                    revision: 1,
                    resultHash,
                    exclusionDecisionHash: 'f'.repeat(64),
                    followersResultHash: resultHash,
                    followingResultHash: resultHash,
                    mutualCount: 1,
                    publicCount: 1,
                    privateCount: 0,
                    detailedPublicCount: 1,
                    unscreenedPublicCount: 0,
                })),
                loadRelationshipStaging: vi.fn(async () => ({
                    excludedUsername: 'girlfriend',
                    detailedPublicUsernames: ['alice'],
                    privateMutualUsernames: [],
                })),
            } as unknown as AnalysisV2EvidenceStore,
        });

        await executor(stageContext('relationships', state()));

        const byOperation = new Map(providers.bindAdapterCheckpoint.mock.calls.map(([call]) => [
            call.operationKey.split(':', 1)[0],
            call.credentialSlot,
        ]));
        expect(byOperation).toEqual(new Map([
            ['relationship-followers', 'primary'],
            ['relationship-following', 'secondary'],
        ]));
    });

    it('fails before provider work on stale leases and declared-count/plan drift', async () => {
        const getFollowersMock = vi.fn();
        const staleStore: AnalysisV2CollectionRequestContextStore = {
            load: vi.fn(async () => { throw new AnalysisV2CollectionContextFenceError(); }),
        };
        await expect(createAnalysisV2RelationshipsExecutor({
            requestContextStore: staleStore,
            getFollowers: getFollowersMock,
        })(stageContext('relationships', state()))).rejects.toThrow(
            'ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH'
        );
        expect(getFollowersMock).not.toHaveBeenCalled();

        await expect(createAnalysisV2RelationshipsExecutor({
            requestContextStore: contextStore(requestContext({ followersDeclaredCount: 401 })),
            getFollowers: getFollowersMock,
        })(stageContext('relationships', state()))).rejects.toThrow(
            'ANALYSIS_V2_COLLECTION_SCOPE_DRIFT'
        );
        expect(getFollowersMock).not.toHaveBeenCalled();
    });

    it('collects 4x150 likers and 6x15 comments from a durable target snapshot, including reels', async () => {
        const posts = Array.from({ length: 8 }, (_, index) => post(
            index,
            index === 7 ? 'reel' : 'image'
        ));
        const target = profile('target', posts);
        const profileStore = inMemoryProfileStore({
            ...completedResume(['target'], [{ ...success('target'), profile: target }]),
            jobKey: 'track:target-evidence:collect',
        });
        const providers = providerStore();
        const getPostLikers = vi.fn(async (
            urls: string[],
            _limit: number,
            _context?: unknown
        ): Promise<ApifyPostLiker[]> => {
            void _limit;
            void _context;
            return urls.map((url, index) => ({
                postUrl: url,
                id: `like-${index}`,
                username: `woman_${index}`,
                profilePicUrl: `https://images.example/woman-${index}.jpg`,
                isPrivate: false,
                isVerified: false,
                totalLikes: 200,
            }));
        });
        const getPostComments = vi.fn(async (
            urls: string[],
            _limit: number,
            _context?: unknown
        ): Promise<ApifyPostComment[]> => {
            void _limit;
            void _context;
            return urls.map((url, index) => ({
                postUrl: url,
                id: `comment-${index}`,
                text: `comment ${index}`,
                ownerUsername: `commenter_${index}`,
                timestamp: capturedAt,
            }));
        });
        const checkpointTargetEvidence = vi.fn(async (
            input: AnalysisV2TargetEvidenceCheckpointInput
        ) => ({
            revision: 1,
            resultHash,
            inputHash: input.inputHash,
            interactorCount: input.rows.length,
            likerCount: input.rows.filter(row => row.signal === 'target_post_like').length,
            commentCount: input.rows.filter(row => row.signal === 'target_post_comment').length,
        }));
        const executor = createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext({
                accessMode: 'test_entitlement',
                providerExecutionPolicy: authorizedProviderPolicy,
            })),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providers.value,
            env: authorizedProviderEnv,
            interactionAdapter: { getPostLikers, getPostComments },
            evidenceStore: { checkpointTargetEvidence } as unknown as AnalysisV2EvidenceStore,
            getProfilesBatchV2: vi.fn(),
        });

        await executor(stageContext('target_evidence', state()));

        expect(getPostLikers).toHaveBeenCalledWith(
            expect.arrayContaining(['https://www.instagram.com/reel/code_7/']),
            150,
            expect.any(Object)
        );
        expect(getPostLikers.mock.calls[0]![0]).toHaveLength(4);
        expect(getPostComments.mock.calls[0]![0]).toHaveLength(6);
        expect(getPostComments.mock.calls[0]![1]).toBe(15);
        const saved = checkpointTargetEvidence.mock.calls[0]![0];
        if (
            saved.likerSource.status !== 'collected'
            || saved.commentSource.status !== 'collected'
        ) throw new Error('expected collected target evidence');
        expect(saved.likerSource.coverage).toHaveLength(4);
        expect(saved.commentSource.coverage).toHaveLength(6);
        expect(saved.rows.some(row => row.content === 'comment 0')).toBe(true);
        const byOperation = new Map(providers.bindAdapterCheckpoint.mock.calls.map(([call]) => [
            call.operationKey.split(':', 1)[0],
            call.credentialSlot,
        ]));
        expect(byOperation.get('target-likers')).toBe('quaternary');
        expect(byOperation.get('target-comments')).toBe('tertiary');
    });

    it('waits for both target interaction branches and rethrows the first failure by input order', async () => {
        const likerFailure = new Error('likers failed after comments');
        const commentFailure = new Error('comments failed first');
        let rejectLikers: (reason?: unknown) => void = () => undefined;
        const getPostLikers = vi.fn(() => new Promise<ApifyPostLiker[]>((_, reject) => {
            rejectLikers = reject;
        }));
        const getPostComments = vi.fn(async (): Promise<ApifyPostComment[]> => {
            throw commentFailure;
        });
        const target = profile('target', [post(0)]);
        const profileStore = inMemoryProfileStore({
            ...completedResume(['target'], [{ ...success('target'), profile: target }]),
            jobKey: 'track:target-evidence:collect',
        });
        const checkpointTargetEvidence = vi.fn();
        const executor = createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providerStore().value,
            interactionAdapter: { getPostLikers, getPostComments },
            evidenceStore: { checkpointTargetEvidence } as unknown as AnalysisV2EvidenceStore,
            getProfilesBatchV2: vi.fn(),
        });

        const execution = executor(stageContext('target_evidence', state()));
        let outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending';
        let rejection: unknown;
        const observed = execution.then(
            () => { outcome = 'fulfilled'; },
            (reason: unknown) => {
                outcome = 'rejected';
                rejection = reason;
            }
        );

        await vi.waitFor(() => {
            expect(getPostLikers).toHaveBeenCalledOnce();
            expect(getPostComments).toHaveBeenCalledOnce();
        });
        await Promise.resolve();

        expect(outcome).toBe('pending');

        rejectLikers(likerFailure);
        await observed;

        expect(outcome).toBe('rejected');
        expect(rejection).toBe(likerFailure);
        expect(checkpointTargetEvidence).not.toHaveBeenCalled();
    });

    it('cancels an earlier queued target tuple without masking a later real failure', async () => {
        const realFailure = new Error('comments provider failed');
        let likerSignal: AbortSignal | undefined;
        let rejectLikers: (reason?: unknown) => void = () => undefined;
        let rejectComments: (reason?: unknown) => void = () => undefined;
        const getPostLikers = vi.fn((_urls, _limit, context) => (
            new Promise<ApifyPostLiker[]>((_, reject) => {
                rejectLikers = reject;
                likerSignal = context?.startCancellationSignal;
                likerSignal?.addEventListener('abort', () => {
                    reject(new Error('SCRAPING_QUEUED_START_CANCELLED'));
                }, { once: true });
            })
        ));
        const getPostComments = vi.fn(() => new Promise<ApifyPostComment[]>((_, reject) => {
            rejectComments = reject;
        }));
        const target = profile('target', [post(0)]);
        const profileStore = inMemoryProfileStore({
            ...completedResume(['target'], [{ ...success('target'), profile: target }]),
            jobKey: 'track:target-evidence:collect',
        });
        const checkpointTargetEvidence = vi.fn();
        const executor = createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providerStore().value,
            interactionAdapter: { getPostLikers, getPostComments },
            evidenceStore: { checkpointTargetEvidence } as unknown as AnalysisV2EvidenceStore,
            getProfilesBatchV2: vi.fn(),
        });

        const execution = executor(stageContext('target_evidence', state()));
        const rejection = expect(execution).rejects.toBe(realFailure);
        await vi.waitFor(() => {
            expect(getPostLikers).toHaveBeenCalledOnce();
            expect(getPostComments).toHaveBeenCalledOnce();
        });

        rejectComments(realFailure);
        await Promise.resolve();
        if (!likerSignal) {
            rejectLikers(new Error('SCRAPING_QUEUED_START_CANCELLED'));
        }

        await rejection;
        expect(likerSignal?.aborted).toBe(true);
        expect(checkpointTargetEvidence).not.toHaveBeenCalled();
    });

    it('settles a successful target source but never checkpoints aggregate evidence after sibling failure', async () => {
        const likerFailure = new Error('likers failed');
        let resolveComments: (rows: ApifyPostComment[]) => void = () => undefined;
        const getPostLikers = vi.fn(async (): Promise<ApifyPostLiker[]> => {
            throw likerFailure;
        });
        const getPostComments = vi.fn(() => new Promise<ApifyPostComment[]>((resolve) => {
            resolveComments = resolve;
        }));
        const target = profile('target', [post(0)]);
        const profileStore = inMemoryProfileStore({
            ...completedResume(['target'], [{ ...success('target'), profile: target }]),
            jobKey: 'track:target-evidence:collect',
        });
        const providers = providerStore();
        const checkpointTargetEvidence = vi.fn();
        const executor = createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providers.value,
            interactionAdapter: { getPostLikers, getPostComments },
            evidenceStore: { checkpointTargetEvidence } as unknown as AnalysisV2EvidenceStore,
            getProfilesBatchV2: vi.fn(),
        });

        const execution = executor(stageContext('target_evidence', state()));
        let outcome: 'pending' | 'fulfilled' | 'rejected' = 'pending';
        let rejection: unknown;
        const observed = execution.then(
            () => { outcome = 'fulfilled'; },
            (reason: unknown) => {
                outcome = 'rejected';
                rejection = reason;
            }
        );

        await vi.waitFor(() => {
            expect(getPostLikers).toHaveBeenCalledOnce();
            expect(getPostComments).toHaveBeenCalledOnce();
        });
        await Promise.resolve();

        expect(outcome).toBe('pending');
        expect(checkpointTargetEvidence).not.toHaveBeenCalled();

        resolveComments([{
            postUrl: 'https://www.instagram.com/p/code_0/',
            id: 'comment-0',
            text: 'comment 0',
            ownerUsername: 'commenter_0',
            timestamp: capturedAt,
        }]);
        await observed;

        expect(outcome).toBe('rejected');
        expect(rejection).toBe(likerFailure);
        expect(providers.load).toHaveBeenCalledOnce();
        expect(checkpointTargetEvidence).not.toHaveBeenCalled();
    });

    it('proves zero-post target interactions as not applicable without starting paid actors', async () => {
        const empty = profile('target', []);
        const profileStore = inMemoryProfileStore({
            ...completedResume(['target'], [{ ...success('target'), profile: empty }]),
            jobKey: 'track:target-evidence:collect',
        });
        const checkpointTargetEvidence = vi.fn(async (
            input: AnalysisV2TargetEvidenceCheckpointInput
        ) => ({
            revision: 1,
            resultHash,
            inputHash: input.inputHash,
            interactorCount: 0,
            likerCount: 0,
            commentCount: 0,
        }));
        const getPostLikers = vi.fn();
        const getPostComments = vi.fn();
        await createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providerStore().value,
            interactionAdapter: { getPostLikers, getPostComments },
            evidenceStore: { checkpointTargetEvidence } as unknown as AnalysisV2EvidenceStore,
            getProfilesBatchV2: vi.fn(),
        })(stageContext('target_evidence', state()));

        expect(getPostLikers).not.toHaveBeenCalled();
        expect(getPostComments).not.toHaveBeenCalled();
        expect(checkpointTargetEvidence.mock.calls[0]![0]).toMatchObject({
            likerSource: { status: 'not_applicable' },
            commentSource: { status: 'not_applicable' },
            rows: [],
        });
    });

    it('replays an attested fresh-admission profile after the target primary 429 without binding a V2 run', async () => {
        const profileStore = inMemoryProfileStore(null);
        const providers = providerStore();
        const reusable = reusableTargetProfileRunStore();
        const fallbackProfile = profile('target', []);
        const primary = [{
            outcome: {
                ...failure('target').outcome,
                failureCategory: 'rate_limit' as const,
                httpStatus: 429,
            },
        }] as ProfileAttemptResult[];
        const fallback = [{
            outcome: success('target', 'apify').outcome,
            profile: fallbackProfile,
        }] as ProfileAttemptResult[];
        const fetcher = vi.fn(async (
            requested: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1]
        ) => {
            await options.persistAttemptOutcomes({
                attempt: 'primary',
                source: 'selfhosted',
                requestedUsernames: requested,
                results: primary,
            });
            expect(options.providerRun).toEqual(expect.objectContaining({
                resumeRunId: 'FreshAdmissionRun123',
                logicalProvider: 'apify',
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: 'quinary',
                maxChargeUsd: 0.0026,
            }));
            expect(options.providerRun?.onBeforeRunStart).toBeUndefined();
            expect(options.providerRun?.onCostRunStarted).toBeUndefined();
            await options.persistAttemptOutcomes({
                attempt: 'fallback',
                source: 'apify',
                requestedUsernames: ['target'],
                results: fallback,
            });
            return {
                results: fallback,
                profiles: [fallbackProfile],
                primaryResults: primary,
                fallbackResults: fallback,
                frozenUnresolvedUsernames: ['target'],
            };
        });

        await createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providers.value,
            targetProfileReuseStore: reusable.value,
            getProfilesBatchV2: fetcher as unknown as typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2,
            interactionAdapter: { getPostLikers: vi.fn(), getPostComments: vi.fn() },
            evidenceStore: {
                checkpointTargetEvidence: vi.fn(async () => ({
                    revision: 1,
                    resultHash,
                    inputHash,
                    interactorCount: 0,
                    likerCount: 0,
                    commentCount: 0,
                })),
            } as unknown as AnalysisV2EvidenceStore,
        })(stageContext('target_evidence', state()));

        expect(reusable.load).toHaveBeenCalledWith({
            requestId,
            jobKey: 'track:target-evidence:collect',
            claimToken,
            jobInputHash: inputHash,
            targetUsername: 'target',
        });
        expect(providers.bindAdapterCheckpoint).not.toHaveBeenCalled();
        expect(providers.load).not.toHaveBeenCalled();
    });

    it('preserves the bound target fallback when no attested reusable run exists', async () => {
        const profileStore = inMemoryProfileStore(null);
        const providers = providerStore();
        const reusable = reusableTargetProfileRunStore(null);
        const primary = [failure('target')] as ProfileAttemptResult[];
        const fallbackProfile = profile('target', []);
        const fallback = [{
            outcome: success('target', 'apify').outcome,
            profile: fallbackProfile,
        }] as ProfileAttemptResult[];
        const fetcher = vi.fn(async (
            requested: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1]
        ) => {
            await options.persistAttemptOutcomes({
                attempt: 'primary',
                source: 'selfhosted',
                requestedUsernames: requested,
                results: primary,
            });
            expect(options.providerRun?.onBeforeRunStart).toEqual(expect.any(Function));
            await options.persistAttemptOutcomes({
                attempt: 'fallback',
                source: 'apify',
                requestedUsernames: ['target'],
                results: fallback,
            });
            return {
                results: fallback,
                profiles: [fallbackProfile],
                primaryResults: primary,
                fallbackResults: fallback,
                frozenUnresolvedUsernames: ['target'],
            };
        });

        await createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providers.value,
            targetProfileReuseStore: reusable.value,
            getProfilesBatchV2: fetcher as unknown as typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2,
            interactionAdapter: { getPostLikers: vi.fn(), getPostComments: vi.fn() },
            evidenceStore: {
                checkpointTargetEvidence: vi.fn(async () => ({
                    revision: 1,
                    resultHash,
                    inputHash,
                    interactorCount: 0,
                    likerCount: 0,
                    commentCount: 0,
                })),
            } as unknown as AnalysisV2EvidenceStore,
        })(stageContext('target_evidence', state()));

        expect(reusable.load).toHaveBeenCalledOnce();
        expect(providers.bindAdapterCheckpoint).toHaveBeenCalledOnce();
        expect(providers.bindAdapterCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
            jobKey: 'track:target-evidence:collect',
            operationKey: expect.stringMatching(/^profile-fallback:/),
        }));
    });

    it('reuses the same fresh run when a target job retries after its primary checkpoint', async () => {
        const profileStore = inMemoryProfileStore(null);
        const providers = providerStore();
        const reusable = reusableTargetProfileRunStore();
        const primary = [failure('target')] as ProfileAttemptResult[];
        const fallbackProfile = profile('target', []);
        const fallback = [{
            outcome: success('target', 'apify').outcome,
            profile: fallbackProfile,
        }] as ProfileAttemptResult[];
        const observedRunIds: Array<string | undefined> = [];
        const fetcher = vi.fn(async (
            requested: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1]
        ) => {
            if (!options.resume) {
                await options.persistAttemptOutcomes({
                    attempt: 'primary',
                    source: 'selfhosted',
                    requestedUsernames: requested,
                    results: primary,
                });
                observedRunIds.push(options.providerRun?.resumeRunId);
                throw new Error('SCRAPING_RUN_PENDING_ERROR: replay later');
            }
            observedRunIds.push(options.providerRun?.resumeRunId);
            await options.persistAttemptOutcomes({
                attempt: 'fallback',
                source: 'apify',
                requestedUsernames: ['target'],
                results: fallback,
            });
            return {
                results: fallback,
                profiles: [fallbackProfile],
                primaryResults: primary,
                fallbackResults: fallback,
                frozenUnresolvedUsernames: ['target'],
            };
        });
        const executor = createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providers.value,
            targetProfileReuseStore: reusable.value,
            getProfilesBatchV2: fetcher as unknown as typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2,
            interactionAdapter: { getPostLikers: vi.fn(), getPostComments: vi.fn() },
            evidenceStore: {
                checkpointTargetEvidence: vi.fn(async () => ({
                    revision: 1,
                    resultHash,
                    inputHash,
                    interactorCount: 0,
                    likerCount: 0,
                    commentCount: 0,
                })),
            } as unknown as AnalysisV2EvidenceStore,
        });

        await expect(executor(stageContext('target_evidence', state())))
            .rejects.toThrow('SCRAPING_RUN_PENDING_ERROR');
        await expect(executor(stageContext('target_evidence', state()))).resolves.toBeDefined();

        expect(observedRunIds).toEqual([
            'FreshAdmissionRun123',
            'FreshAdmissionRun123',
        ]);
        expect(profileStore.store.checkpointPrimary).toHaveBeenCalledOnce();
        expect(reusable.load).toHaveBeenCalledTimes(2);
        expect(providers.bindAdapterCheckpoint).not.toHaveBeenCalled();
    });

    it('seals a malformed reusable replay and never retries or binds a replacement Actor', async () => {
        const primary = [failure('target')] as AnalysisV2ProfileFetchResume['primaryResults'];
        const profileStore = inMemoryProfileStore({
            requestId,
            jobKey: 'track:target-evidence:collect',
            requestedUsernames: ['target'],
            frozenUnresolvedUsernames: ['target'],
            primaryResults: primary,
            fallbackResults: [],
            primaryCapturedAt: capturedAt,
            fallbackCapturedAt: null,
        });
        const providers = providerStore();
        const reusable = reusableTargetProfileRunStore();
        const fallbackSchemaFailure = [{
            outcome: {
                requestedUsername: 'target',
                source: 'apify' as const,
                status: 'failed' as const,
                failureCategory: 'schema' as const,
                httpStatus: null,
                requestCount: 1,
                latencyMs: 10,
                capturedAt,
            },
        }] as ProfileAttemptResult[];
        const observedProviderRuns: Array<Parameters<
            typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2
        >[1]['providerRun']> = [];
        const fetcher = vi.fn(async (
            requested: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1]
        ) => {
            observedProviderRuns.push(options.providerRun);
            await options.persistAttemptOutcomes({
                attempt: 'fallback',
                source: 'apify',
                requestedUsernames: requested,
                results: fallbackSchemaFailure,
            });
            return {
                results: fallbackSchemaFailure,
                profiles: [],
                primaryResults: primary,
                fallbackResults: fallbackSchemaFailure,
                frozenUnresolvedUsernames: ['target'],
            };
        });
        const executor = createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providers.value,
            targetProfileReuseStore: reusable.value,
            getProfilesBatchV2: fetcher as unknown as typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2,
        });

        await expect(executor(stageContext('target_evidence', state())))
            .rejects.toThrow('ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE');
        await expect(executor(stageContext('target_evidence', state())))
            .rejects.toThrow('ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE');

        expect(fetcher).toHaveBeenCalledOnce();
        expect(profileStore.store.checkpointFallback).toHaveBeenCalledOnce();
        expect(profileStore.current()?.fallbackResults).toEqual(fallbackSchemaFailure);
        expect(observedProviderRuns).toEqual([expect.objectContaining({
            resumeRunId: 'FreshAdmissionRun123',
            logicalProvider: 'apify',
            actorId: 'apify/instagram-profile-scraper',
            credentialSlot: 'quinary',
            maxChargeUsd: 0.0026,
        })]);
        expect(observedProviderRuns[0]?.startReserved).toBeUndefined();
        expect(observedProviderRuns[0]?.onBeforeRunStart).toBeUndefined();
        expect(observedProviderRuns[0]?.onRunStarted).toBeUndefined();
        expect(reusable.load).toHaveBeenCalledOnce();
        expect(providers.bindAdapterCheckpoint).not.toHaveBeenCalled();
        expect(providers.load).not.toHaveBeenCalled();
    });

    it('never loads target reuse for a non-target profile batch', async () => {
        const usernames = ['alice'];
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);
        const primary = [failure('alice')] as ProfileAttemptResult[];
        const profileStore = inMemoryProfileStore({
            requestId,
            jobKey: 'track:profiles:batch:0',
            requestedUsernames: usernames,
            frozenUnresolvedUsernames: usernames,
            primaryResults: primary as AnalysisV2ProfileFetchResume['primaryResults'],
            fallbackResults: [],
            primaryCapturedAt: capturedAt,
            fallbackCapturedAt: null,
        });
        const reusable = reusableTargetProfileRunStore();
        const fallback = [success('alice', 'apify')] as ProfileAttemptResult[];
        const fetcher = vi.fn(async (
            _requested: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1]
        ) => {
            await options.persistAttemptOutcomes({
                attempt: 'fallback',
                source: 'apify',
                requestedUsernames: usernames,
                results: fallback,
            });
            return {
                results: fallback,
                profiles: [profile('alice')],
                primaryResults: primary,
                fallbackResults: fallback,
                frozenUnresolvedUsernames: usernames,
            };
        });

        await createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providerStore().value,
            targetProfileReuseStore: reusable.value,
            evidenceStore: relationshipEvidence(usernames),
            getProfilesBatchV2: fetcher as unknown as typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2,
        })(stageContext(
            'profile_fetch',
            state({ relationships: relationshipManifest(topology) }),
            0
        ));

        expect(reusable.load).not.toHaveBeenCalled();
    });

    it('persists all primary outcomes before binding and freezes exactly unresolved fallback input', async () => {
        const usernames = ['alice', 'bob'];
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);
        const callOrder: string[] = [];
        const profileStore = inMemoryProfileStore(null);
        vi.mocked(profileStore.store.checkpointPrimary).mockImplementation(async (input) => {
            callOrder.push('primary-persisted');
            const unresolved = input.results
                .filter(result => result.outcome.status !== 'success')
                .map(result => result.outcome.requestedUsername);
            const next: AnalysisV2ProfileFetchResume = {
                requestId,
                jobKey: input.jobKey,
                requestedUsernames: [...input.requestedUsernames],
                frozenUnresolvedUsernames: unresolved,
                primaryResults: input.results as AnalysisV2ProfileFetchResume['primaryResults'],
                fallbackResults: [],
                primaryCapturedAt: capturedAt,
                fallbackCapturedAt: null,
            };
            const replacement = inMemoryProfileStore(next);
            vi.mocked(profileStore.store.load).mockImplementation(replacement.store.load);
            vi.mocked(profileStore.store.checkpointFallback).mockImplementation(
                replacement.store.checkpointFallback
            );
            return next;
        });
        const providers = providerStore(callOrder);
        const snapshots: ProfilesBatchSnapshot[] = [];
        const reportActiveProfile = vi.fn(async () => undefined);
        const fetcher = vi.fn(async (
            requested: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1]
        ) => {
            await options.onProfileStart?.('alice');
            await options.onProfileStart?.('bob');
            const primary = [success('alice'), failure('bob')] as ProfileAttemptResult[];
            snapshots.push({ attempt: 'primary', requested: [...requested] });
            await options.persistAttemptOutcomes({
                attempt: 'primary',
                source: 'selfhosted',
                requestedUsernames: requested,
                results: primary,
            });
            expect(callOrder).toEqual([
                'primary-persisted',
                'bind:profile-fallback',
            ]);
            await options.onProfileStart?.('bob');
            const fallback = [{ ...success('bob', 'apify'), profile: profile('bob') }];
            snapshots.push({ attempt: 'fallback', requested: ['bob'] });
            await options.persistAttemptOutcomes({
                attempt: 'fallback',
                source: 'apify',
                requestedUsernames: ['bob'],
                results: fallback,
            });
            return {
                results: [primary[0]!, fallback[0]!],
                profiles: [profile('alice'), profile('bob')],
                primaryResults: primary,
                fallbackResults: fallback,
                frozenUnresolvedUsernames: ['bob'],
            };
        });
        const executor = createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext({
                accessMode: 'test_entitlement',
                providerExecutionPolicy: authorizedProviderPolicy,
            })),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providers.value,
            env: authorizedProviderEnv,
            evidenceStore: relationshipEvidence(usernames),
            getProfilesBatchV2: fetcher as unknown as typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2,
        });
        const dagState = state({ relationships: relationshipManifest(topology) });

        await expect(executor({
            ...stageContext('profile_fetch', dagState, 0),
            reportActiveProfile,
        })).resolves.toMatchObject({
            checkpoint: { manifest: { itemCount: 2, producerInputHash: inputHash } },
        });
        expect(reportActiveProfile.mock.calls).toEqual([['alice'], ['bob'], ['bob']]);
        expect(snapshots).toEqual([
            { attempt: 'primary', requested: ['alice', 'bob'] },
            { attempt: 'fallback', requested: ['bob'] },
        ]);
        expect(profileStore.store.checkpointFallback).toHaveBeenCalledWith(expect.objectContaining({
            results: [expect.objectContaining({ outcome: expect.objectContaining({
                requestedUsername: 'bob',
            }) })],
        }));
        expect(profileStore.store.checkpointPrimary).toHaveBeenCalledWith(
            expect.objectContaining({
                results: expect.arrayContaining([
                    expect.objectContaining({
                        outcome: expect.objectContaining({
                            requestedUsername: 'bob',
                            status: 'failed',
                            failureCategory: 'timeout',
                            httpStatus: 504,
                        }),
                    }),
                ]),
            })
        );
        expect(providers.bindAdapterCheckpoint).toHaveBeenCalledWith(
            expect.objectContaining({ credentialSlot: 'tertiary' })
        );
    });

    it('reports only the unresolved fallback profile when resuming a durable primary attempt', async () => {
        const usernames = ['alice', 'bob'];
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);
        const primary = [success('alice'), failure('bob')] as ProfileAttemptResult[];
        const profileStore = inMemoryProfileStore({
            requestId,
            jobKey: 'track:profiles:batch:0',
            requestedUsernames: usernames,
            frozenUnresolvedUsernames: ['bob'],
            primaryResults: primary as AnalysisV2ProfileFetchResume['primaryResults'],
            fallbackResults: [],
            primaryCapturedAt: capturedAt,
            fallbackCapturedAt: null,
        });
        const reportActiveProfile = vi.fn(async () => undefined);
        const fetcher = vi.fn(async (
            requested: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1]
        ) => {
            expect(requested).toEqual(usernames);
            expect(options.resume?.frozenUnresolvedUsernames).toEqual(['bob']);
            await options.onProfileStart?.('bob');
            const fallback = [{ ...success('bob', 'apify'), profile: profile('bob') }];
            await options.persistAttemptOutcomes({
                attempt: 'fallback',
                source: 'apify',
                requestedUsernames: ['bob'],
                results: fallback,
            });
            return {
                results: [primary[0]!, fallback[0]!],
                profiles: [profile('alice'), profile('bob')],
                primaryResults: primary,
                fallbackResults: fallback,
                frozenUnresolvedUsernames: ['bob'],
            };
        });
        const executor = createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            providerRunStore: providerStore().value,
            evidenceStore: relationshipEvidence(usernames),
            getProfilesBatchV2: fetcher as unknown as typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2,
            env: { APIFY_API_TOKEN_SLOT: 'primary' },
        });

        await executor({
            ...stageContext(
                'profile_fetch',
                state({ relationships: relationshipManifest(topology) }),
                0
            ),
            reportActiveProfile,
        });

        expect(fetcher).toHaveBeenCalledOnce();
        expect(reportActiveProfile.mock.calls).toEqual([['bob']]);
        expect(profileStore.store.checkpointPrimary).not.toHaveBeenCalled();
        expect(profileStore.store.checkpointFallback).toHaveBeenCalledOnce();
    });

    it('accepts exactly 90 percent candidate coverage with three incomplete failures in 30', async () => {
        const usernames = Array.from({ length: 30 }, (_, index) => `user${index}`);
        const failures = usernames.slice(-3).map(username => incompleteFailure(username));
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);

        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: inMemoryProfileStore(
                completedFallbackResume(usernames, failures)
            ).store,
        })(stageContext(
            'profile_fetch',
            state({ relationships: relationshipManifest(topology) }),
            0
        ))).resolves.toMatchObject({
            checkpoint: { manifest: { itemCount: 30 } },
        });
    });

    it('accepts the rounded 90 percent boundary with two incomplete failures in 27', async () => {
        const usernames = Array.from({ length: 27 }, (_, index) => `user${index}`);
        const failures = usernames.slice(-2).map(username => incompleteFailure(username));
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);

        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: inMemoryProfileStore(
                completedFallbackResume(usernames, failures)
            ).store,
        })(stageContext(
            'profile_fetch',
            state({ relationships: relationshipManifest(topology) }),
            0
        ))).resolves.toMatchObject({
            checkpoint: { manifest: { itemCount: 27 } },
        });
    });

    it('rejects candidate coverage below 90 percent', async () => {
        const usernames = Array.from({ length: 30 }, (_, index) => `user${index}`);
        const failures = usernames.slice(-4).map(username => incompleteFailure(username));
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);

        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: inMemoryProfileStore(
                completedFallbackResume(usernames, failures)
            ).store,
        })(stageContext(
            'profile_fetch',
            state({ relationships: relationshipManifest(topology) }),
            0
        ))).rejects.toThrow('ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE');
    });

    it('rejects a non-incomplete candidate profile failure within the numeric bound', async () => {
        const usernames = Array.from({ length: 30 }, (_, index) => `user${index}`);
        const failedUsername = usernames.at(-1)!;
        const resume = completedFallbackResume(usernames, [
            failure(failedUsername, 'apify') as AnalysisV2ProfileFetchResume['fallbackResults'][number],
        ]);
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);

        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: inMemoryProfileStore(resume).store,
        })(stageContext(
            'profile_fetch',
            state({ relationships: relationshipManifest(topology) }),
            0
        ))).rejects.toThrow('ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE');
    });

    it('keeps target profile evidence strict for a terminal incomplete outcome', async () => {
        const profileStore = inMemoryProfileStore({
            ...completedFallbackResume(['target'], [incompleteFailure('target')]),
            jobKey: 'track:target-evidence:collect',
        });
        const getPostLikers = vi.fn();
        const getPostComments = vi.fn();

        await expect(createAnalysisV2TargetEvidenceExecutor({
            requestContextStore: contextStore(requestContext()),
            profileCheckpointStore: profileStore.store,
            interactionAdapter: { getPostLikers, getPostComments },
        })(stageContext('target_evidence', state()))).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'
        );

        expect(getPostLikers).not.toHaveBeenCalled();
        expect(getPostComments).not.toHaveBeenCalled();
    });

    it('rejects wrong batches, girlfriend leakage, ambiguous failures, and ambiguous starts', async () => {
        const usernames = ['alice', 'bob'];
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);
        const dagState = state({ relationships: relationshipManifest(topology) });
        const complete = inMemoryProfileStore(completedResume(usernames));

        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: complete.store,
        })(stageContext('profile_fetch', dagState, 1))).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_BATCH_MISMATCH'
        );

        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(['alice', 'girlfriend']),
            profileCheckpointStore: complete.store,
        })(stageContext(
            'profile_fetch',
            state({ relationships: relationshipManifest(
                createAnalysisV2CollectionTopology('profiles', ['alice', 'girlfriend'])
            ) }),
            0
        ))).rejects.toThrow('ANALYSIS_V2_GIRLFRIEND_EXCLUSION_LEAK');

        const verifiedUnavailable = inMemoryProfileStore({
            ...completedResume(usernames, [success('alice'), failure('bob')]),
            frozenUnresolvedUsernames: ['bob'],
            fallbackResults: [
                unavailable('bob') as AnalysisV2ProfileFetchResume['fallbackResults'][number],
            ],
            fallbackCapturedAt: capturedAt,
        });
        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: verifiedUnavailable.store,
        })(stageContext('profile_fetch', dagState, 0))).resolves.toMatchObject({
            checkpoint: { manifest: { itemCount: 2 } },
        });

        const ambiguousTerminal = inMemoryProfileStore({
            ...completedResume(usernames, [success('alice'), failure('bob')]),
            frozenUnresolvedUsernames: ['bob'],
            fallbackResults: [
                failure('bob', 'apify') as AnalysisV2ProfileFetchResume['fallbackResults'][number],
            ],
            fallbackCapturedAt: capturedAt,
        });
        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: ambiguousTerminal.store,
        })(stageContext('profile_fetch', dagState, 0))).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'
        );

        const primaryOnly = inMemoryProfileStore(null);
        const ambiguousFetcher = vi.fn(async (
            requested: readonly string[],
            options: Parameters<typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2>[1]
        ) => {
            await options.persistAttemptOutcomes({
                attempt: 'primary',
                source: 'selfhosted',
                requestedUsernames: requested,
                results: [success('alice'), failure('bob')],
            });
            throw new Error('SCRAPING_AMBIGUOUS_START_ERROR: unknown Actor start');
        });
        await expect(createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: primaryOnly.store,
            providerRunStore: providerStore().value,
            getProfilesBatchV2: ambiguousFetcher as unknown as typeof import('@/lib/services/instagram/scraper').getProfilesBatchV2,
        })(stageContext('profile_fetch', dagState, 0))).rejects.toThrow(
            'SCRAPING_AMBIGUOUS_START_ERROR'
        );
        expect(primaryOnly.store.checkpointPrimary).toHaveBeenCalledOnce();
        expect(primaryOnly.store.checkpointFallback).not.toHaveBeenCalled();
    });

    it('derives a stable batch result hash from the durable canonical checkpoint', async () => {
        const usernames = ['alice', 'bob'];
        const topology = createAnalysisV2CollectionTopology('profiles', usernames);
        const complete = inMemoryProfileStore(completedResume(usernames));
        const fetcher = vi.fn();
        const reportActiveProfile = vi.fn(async () => undefined);
        const executor = createAnalysisV2ProfileFetchExecutor({
            requestContextStore: contextStore(requestContext()),
            evidenceStore: relationshipEvidence(usernames),
            profileCheckpointStore: complete.store,
            getProfilesBatchV2: fetcher,
        });
        const dagState = state({ relationships: relationshipManifest(topology) });

        const first = await executor({
            ...stageContext('profile_fetch', dagState, 0),
            reportActiveProfile,
        });
        const second = await executor({
            ...stageContext('profile_fetch', dagState, 0),
            reportActiveProfile,
        });
        expect(first.checkpoint.manifest.resultHash).toBe(second.checkpoint.manifest.resultHash);
        expect(first.checkpoint.manifest.resultHash).toMatch(/^[a-f0-9]{64}$/);
        expect(fetcher).not.toHaveBeenCalled();
        expect(reportActiveProfile).not.toHaveBeenCalled();
    });
});

interface ProfilesBatchSnapshot {
    attempt: 'primary' | 'fallback';
    requested: string[];
}

function relationshipManifest(profileBatches: readonly {
    batch: number;
    itemCount: number;
    inputHash: string;
}[]) {
    return {
        revision: 1,
        resultHash,
        detectedMutualCount: profileBatches.reduce((sum, batch) => sum + batch.itemCount, 0),
        publicCount: profileBatches.reduce((sum, batch) => sum + batch.itemCount, 0),
        privateCount: 0,
        detailedSelectedPublicCount: profileBatches.reduce(
            (sum, batch) => sum + batch.itemCount,
            0
        ),
        notScreenedPublicCount: 0,
        profileBatches,
        privateNameBatches: [],
    };
}

function relationshipEvidence(usernames: readonly string[]): AnalysisV2EvidenceStore {
    return {
        loadRelationshipStaging: vi.fn(async () => ({
            detailedPublicUsernames: [...usernames],
        })),
    } as unknown as AnalysisV2EvidenceStore;
}
