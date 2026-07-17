import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { InstagramProfile } from '@/lib/types/instagram';
import type { ProviderCallContext } from '@/lib/services/instagram/providers/types';
import { APIFY_PROFILE_ACTOR_ID } from '@/lib/services/instagram/providers/apify';
import { makeWebProfileFetcher } from '@/lib/services/instagram/providers/selfhosted/web-client';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    PREFLIGHT_DATABASE_NAMES,
    PreflightImmutableError,
    PreflightLeaseBusyError,
    buildReadyPreflightSnapshot,
    createSupabasePreflightStore,
    processPreflight,
    publicPreflightStatusDto,
    trustedPreflightAccessMode,
    type ClaimedPreflight,
    type PreflightCatalogSnapshot,
    type PreflightStore,
    type ReadyPreflightSnapshot,
} from './preflight';
import type {
    PreflightProviderRunStore,
    StoredPreflightProviderRun,
} from './preflight-provider-run';
import { preflightTargetInputHash } from './preflight-identity';
import { PREFLIGHT_PROVIDER_DEADLINE_MS } from './preflight-runtime-policy';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const claimToken = '323e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const expiresAt = '2030-07-13T13:00:00.000Z';
const entitlementSecret = Buffer.alloc(32, 13).toString('base64url');
const preflightIdentitySecret = Buffer.alloc(32, 14).toString('base64url');
const preflightInputHash = preflightTargetInputHash('target.name', {
    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
});

beforeAll(() => {
    vi.stubEnv('ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET', preflightIdentitySecret);
});

afterAll(() => {
    vi.unstubAllEnvs();
});

function profile(overrides: Partial<InstagramProfile> = {}): InstagramProfile {
    return {
        username: 'target.name',
        fullName: 'Target',
        bio: 'bio',
        profilePicUrl: 'https://scontent.cdninstagram.com/avatar.jpg',
        followersCount: 350,
        followingCount: 300,
        postsCount: 10,
        isPrivate: false,
        isVerified: false,
        ...overrides,
    };
}

function claim(overrides: Partial<ClaimedPreflight> = {}): ClaimedPreflight {
    return {
        preflightId,
        claimToken,
        userId,
        targetInstagramId: 'target.name',
        accessMode: 'test_entitlement',
        workerAttemptCount: 1,
        catalogSnapshot: {
            plans: {
                basic: {
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 400, following: 400 },
                    detailedMutualLimit: 300,
                },
                standard: {
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 800, following: 800 },
                    detailedMutualLimit: 600,
                },
                plus: {
                    launchStatus: 'test_only',
                    relationshipCapacity: { followers: 1_200, following: 1_200 },
                    detailedMutualLimit: 900,
                },
            },
            pricingVersion: 'deferred',
            prices: {
                basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
                standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
                plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
            },
        } satisfies PreflightCatalogSnapshot,
        ...overrides,
    };
}

function providerRunStore(): PreflightProviderRunStore {
    return {
        load: vi.fn(async () => null),
        reserve: vi.fn(),
        checkpointStarted: vi.fn(),
        checkpointTerminal: vi.fn(),
    };
}

function storedRun(
    status: 'starting' | 'running' | 'succeeded' = 'running'
): StoredPreflightProviderRun {
    return {
        preflightId,
        operationKey: 'target-profile-fallback',
        inputHash: preflightInputHash,
        logicalProvider: 'apify' as const,
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot: 'quinary' as const,
        maxChargeUsd: 0.0026 as const,
        status,
        runId: status === 'starting' ? null : 'StoredRun12345678',
        actualUsageUsd: null,
        reservedAt: '2026-07-14T17:59:00.000Z',
        runStartedAt: status === 'starting' ? null : '2026-07-14T17:59:30.000Z',
        terminalizedAt: status === 'succeeded' ? '2026-07-14T18:05:00.000Z' : null,
    };
}

async function completeFallbackRun(
    context: ProviderCallContext | undefined,
    result: InstagramProfile | null = profile()
) {
    await context?.onBeforeRunStart?.({
        logicalProvider: 'apify',
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot: 'quinary',
        maxChargeUsd: 0.0026,
    });
    await context?.onRunStarted?.('StartedRun1234567');
    await context?.onCostRunStarted?.({
        logicalProvider: 'apify',
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot: 'quinary',
        maxChargeUsd: 0.0026,
        runId: 'StartedRun1234567',
    });
    await context?.onCostRunFinished?.({
        logicalProvider: 'apify',
        actorId: APIFY_PROFILE_ACTOR_ID,
        credentialSlot: 'quinary',
        maxChargeUsd: 0.0026,
        runId: 'StartedRun1234567',
        status: 'succeeded',
        usageTotalUsd: null,
    });
    return result;
}

function workerStore(claimed: ClaimedPreflight | null = claim()) {
    return {
        createOrReplay: vi.fn(),
        findForOwner: vi.fn(),
        reserveDispatch: vi.fn(),
        markDispatched: vi.fn(),
        claim: vi.fn(async () => claimed),
        releaseClaim: vi.fn(async () => undefined),
        finalizeReady: vi.fn(async () => undefined),
        finalizeBlocked: vi.fn(async () => undefined),
        blockQueueUnavailable: vi.fn(async () => undefined),
        setExclusion: vi.fn(async () => undefined),
    } satisfies PreflightStore;
}

describe('preflight persistence adapter', () => {
    it('keeps RPC names centralized and sends authenticated identity to create/replay', async () => {
        const rpc = vi.fn(async () => ({
            data: [{
                preflight_id: preflightId,
                expires_at: expiresAt,
                created: true,
                preflight_status: 'pending',
            }],
            error: null,
        }));
        const store = createSupabasePreflightStore({
            rpc,
            from: vi.fn() as never,
        });

        await expect(store.createOrReplay({
            userId,
            email: 'owner@example.com',
            authProvider: 'google',
            targetInstagramId: 'target.name',
            idempotencyKey: 'preflight-key-000000000000',
            accessMode: 'test_entitlement',
        })).resolves.toEqual({ preflightId, expiresAt, created: true, status: 'pending' });
        expect(rpc).toHaveBeenCalledWith(PREFLIGHT_DATABASE_NAMES.createOrReplayRpc, {
            p_user_id: userId,
            p_email: 'owner@example.com',
            p_auth_provider: 'google',
            p_target_instagram_id: 'target.name',
            p_idempotency_key: 'preflight-key-000000000000',
            p_access_mode: 'test_entitlement',
            p_launch_status_snapshot: {
                basic: 'production',
                standard: 'production',
                plus: 'production',
            },
            p_plan_catalog_snapshot: {
                basic: {
                    launchStatus: 'production',
                    relationshipCapacity: { followers: 400, following: 400 },
                    detailedMutualLimit: 300,
                },
                standard: {
                    launchStatus: 'production',
                    relationshipCapacity: { followers: 800, following: 800 },
                    detailedMutualLimit: 600,
                },
                plus: {
                    launchStatus: 'production',
                    relationshipCapacity: { followers: 1_200, following: 1_200 },
                    detailedMutualLimit: 900,
                },
            },
            p_pricing_version: 'earlybird-2026-07-v1',
            p_pricing_snapshot: {
                basic: { status: 'quoted', currency: 'KRW', amountKrw: 14_900 },
                standard: { status: 'quoted', currency: 'KRW', amountKrw: 19_900 },
                plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
            },
            p_policy_versions_snapshot: {
                pipeline: 'v2',
                risk: 'risk-policy-v2.2',
                aiStage: 'ai-stage-policy-v2.4',
            },
        });
    });

    it('owner-filters reads and reconstructs ready DTO state from decomposed columns', async () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;
        const planCards = Object.fromEntries(snapshot.plans.map(plan => [plan.planId, {
            launchStatus: plan.launchStatus,
            relationshipCapacity: plan.relationshipCapacity,
            detailedMutualLimit: plan.detailedMutualLimit,
            selectionState: plan.selectionState,
            unavailableReason: plan.unavailableReason,
        }]));
        const prices = Object.fromEntries(snapshot.plans.map(plan => [plan.planId, plan.price]));
        const launches = Object.fromEntries(
            snapshot.plans.map(plan => [plan.planId, plan.launchStatus])
        );
        const query: Record<string, ReturnType<typeof vi.fn>> = {};
        query.select = vi.fn(() => query);
        query.eq = vi.fn(() => query);
        query.maybeSingle = vi.fn(async () => ({
            data: {
                id: preflightId,
                status: 'ready',
                expires_at: expiresAt,
                error_code: null,
                target_instagram_id: snapshot.target.username,
                target_full_name: snapshot.target.fullName,
                target_bio: snapshot.target.bio,
                target_profile_image_url: snapshot.target.profileImageUrl,
                target_followers_count: snapshot.target.followersCount,
                target_following_count: snapshot.target.followingCount,
                target_is_private: false,
                access_mode: snapshot.accessMode,
                launch_status_snapshot: launches,
                capacity_required_plan_id: snapshot.capacityRequiredPlan,
                required_plan_id: snapshot.requiredPlan,
                plan_cards_snapshot: planCards,
                pricing_version: snapshot.pricingVersion,
                pricing_snapshot: prices,
                exclusion_decision: 'exclude',
            },
            error: null,
        }));
        const store = createSupabasePreflightStore({
            rpc: vi.fn() as never,
            from: vi.fn(() => query as never),
        });

        await expect(store.findForOwner(preflightId, userId)).resolves.toMatchObject({
            preflightId,
            status: 'ready',
            readySnapshot: {
                target: { username: 'target.name' },
                requiredPlan: 'basic',
                plans: [{ planId: 'basic' }, { planId: 'standard' }, { planId: 'plus' }],
            },
        });
        expect(query.eq).toHaveBeenNthCalledWith(1, 'id', preflightId);
        expect(query.eq).toHaveBeenNthCalledWith(2, 'user_id', userId);
        expect(query.select).toHaveBeenCalledWith(expect.stringContaining('exclusion_decision'));
        expect(query.select.mock.calls[0][0]).not.toContain('excluded_instagram_id');
    });

    it('uses fenced completion, blocking, and scalar exclusion RPC contracts', async () => {
        const rpc = vi.fn(async () => ({ data: true, error: null }));
        const store = createSupabasePreflightStore({
            rpc,
            from: vi.fn() as never,
        });
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;

        await store.finalizeReady(claim(), snapshot);
        await store.finalizeBlocked(claim(), 'TARGET_NOT_FOUND');
        await store.blockQueueUnavailable(preflightId, userId);
        await store.setExclusion({
            preflightId,
            userId,
            decision: 'exclude',
            excludedInstagramId: 'owner.name',
        });

        expect(rpc).toHaveBeenNthCalledWith(1, PREFLIGHT_DATABASE_NAMES.completeRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_claim_token: claimToken,
            p_target_full_name: 'Target',
            p_target_bio: 'bio',
            p_target_profile_image_url: 'https://scontent.cdninstagram.com/avatar.jpg',
            p_target_followers_count: 350,
            p_target_following_count: 300,
            p_target_is_private: false,
            p_capacity_required_plan_id: 'basic',
            p_required_plan_id: 'basic',
            p_plan_cards_snapshot: expect.objectContaining({
                basic: expect.objectContaining({
                    selectionState: 'required',
                    detailedMutualLimit: 300,
                }),
            }),
        });
        expect(rpc).toHaveBeenNthCalledWith(2, PREFLIGHT_DATABASE_NAMES.blockRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_claim_token: claimToken,
            p_error_code: 'TARGET_NOT_FOUND',
        });
        expect(rpc).toHaveBeenNthCalledWith(3, PREFLIGHT_DATABASE_NAMES.blockRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_claim_token: null,
            p_error_code: 'QUEUE_UNAVAILABLE',
        });
        expect(rpc).toHaveBeenNthCalledWith(4, PREFLIGHT_DATABASE_NAMES.exclusionRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_decision: 'exclude',
            p_excluded_instagram_id: 'owner.name',
        });
    });

    it('maps a conflicting write-once exclusion decision to an immutable error', async () => {
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async () => ({
                data: null,
                error: { code: 'P0001', message: 'PREFLIGHT_IMMUTABLE' },
            })),
            from: vi.fn() as never,
        });

        const update = store.setExclusion({
            preflightId,
            userId,
            decision: 'skip',
            excludedInstagramId: null,
        });

        await expect(update).rejects.toBeInstanceOf(PreflightImmutableError);
        await expect(update).rejects.toMatchObject({ message: 'PREFLIGHT_IMMUTABLE' });
    });

    it('reserves and marks one durable dispatch generation', async () => {
        const reservationToken = '423e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
        const rpc = vi.fn(async (...args: [string, Record<string, unknown>?]) => (
            args[0] === PREFLIGHT_DATABASE_NAMES.reserveDispatchRpc
            ? {
                data: [{
                    should_enqueue: true,
                    dispatch_generation: 2,
                    reservation_token: reservationToken,
                    preflight_status: 'pending',
                }],
                error: null,
            }
            : { data: true, error: null }
        ));
        const store = createSupabasePreflightStore({ rpc, from: vi.fn() as never });

        const reservation = await store.reserveDispatch(preflightId, userId);
        expect(reservation).toEqual({
            shouldEnqueue: true,
            generation: 2,
            reservationToken,
            status: 'pending',
        });
        expect(rpc.mock.calls[0][1]).toMatchObject({
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_dispatch_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });

        await store.markDispatched({
            preflightId,
            userId,
            generation: reservation.generation,
            reservationToken: reservation.reservationToken!,
        });
        expect(rpc).toHaveBeenNthCalledWith(2, PREFLIGHT_DATABASE_NAMES.markDispatchedRpc, {
            p_preflight_id: preflightId,
            p_user_id: userId,
            p_dispatch_generation: 2,
            p_dispatch_token: reservationToken,
        });
    });

    it('keeps an active-lease duplicate delivery retryable instead of acknowledging it', async () => {
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async () => ({
                data: [{
                    preflight_id: preflightId,
                    user_id: userId,
                    claimed: false,
                    target_instagram_id: null,
                    access_mode: 'test_entitlement',
                    worker_attempt_count: 1,
                    lease_expires_at: expiresAt,
                    preflight_status: 'processing',
                }],
                error: null,
            })),
            from: vi.fn() as never,
        });

        await expect(store.claim(preflightId)).rejects.toBeInstanceOf(
            PreflightLeaseBusyError
        );
    });

    it('claims the immutable stored catalog even when its pricing version is not current', async () => {
        const storedCatalog = claim().catalogSnapshot;
        const store = createSupabasePreflightStore({
            rpc: vi.fn(async () => ({
                data: [{
                    preflight_id: preflightId,
                    user_id: userId,
                    claimed: true,
                    target_instagram_id: 'target.name',
                    access_mode: 'test_entitlement',
                    plan_catalog_snapshot: storedCatalog.plans,
                    pricing_version: 'quoted-v1',
                    pricing_snapshot: {
                        basic: { status: 'quoted', currency: 'KRW', amountKrw: 9_900 },
                        standard: { status: 'quoted', currency: 'KRW', amountKrw: 14_900 },
                        plus: { status: 'quoted', currency: 'KRW', amountKrw: 19_900 },
                    },
                    worker_attempt_count: 1,
                    lease_expires_at: expiresAt,
                    preflight_status: 'processing',
                }],
                error: null,
            })),
            from: vi.fn() as never,
        });

        await expect(store.claim(preflightId)).resolves.toMatchObject({
            workerAttemptCount: 1,
            catalogSnapshot: {
                pricingVersion: 'quoted-v1',
                prices: {
                    standard: { status: 'quoted', amountKrw: 14_900 },
                },
            },
        });
    });
});

describe('preflight worker domain', () => {
    it('uses only the self-hosted profile provider without fallback and stores a ready quote', async () => {
        const store = workerStore();
        const getProfile = vi.fn<(
            username: string,
            options?: { invocationDeadlineAtMs?: number }
        ) => Promise<InstagramProfile>>(async () => profile());
        const workerStartedAt = Date.now();

        await expect(processPreflight(preflightId, {
            store,
            getProfile,
            providerRunStore: providerRunStore(),
        }))
            .resolves.toBe('ready');
        expect(getProfile).toHaveBeenCalledWith('target.name', {
            invocationDeadlineAtMs: expect.any(Number),
        });
        const invocationDeadlineAtMs = getProfile.mock.calls[0][1]?.invocationDeadlineAtMs;
        expect(invocationDeadlineAtMs).toBeGreaterThanOrEqual(
            workerStartedAt + PREFLIGHT_PROVIDER_DEADLINE_MS
        );
        expect(invocationDeadlineAtMs).toBeLessThanOrEqual(
            Date.now() + PREFLIGHT_PROVIDER_DEADLINE_MS
        );
        expect(store.finalizeReady).toHaveBeenCalledWith(
            expect.objectContaining({ preflightId, claimToken }),
            expect.objectContaining({
                accessMode: 'test_entitlement',
                capacityRequiredPlan: 'basic',
                requiredPlan: 'basic',
                plans: expect.arrayContaining([
                    expect.objectContaining({ planId: 'basic', launchStatus: 'test_only' }),
                ]),
            })
        );
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it.each([
        ['missing target', null, 'TARGET_NOT_FOUND'],
        ['private target', profile({ isPrivate: true }), 'TARGET_PRIVATE'],
        [
            'over Plus target',
            profile({ followersCount: 1_201, followingCount: 1 }),
            'OVER_PLUS_CAPACITY',
        ],
    ] as const)('terminalizes a %s with a bounded code', async (_name, result, code) => {
        const store = workerStore();
        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => result),
            providerRunStore: providerRunStore(),
        })).resolves.toBe('blocked');
        expect(store.finalizeBlocked).toHaveBeenCalledWith(
            expect.objectContaining({ preflightId }),
            code
        );
        expect(store.finalizeReady).not.toHaveBeenCalled();
    });

    it('blocks a production quote while the static catalog remains test-only', async () => {
        const store = workerStore(claim({ accessMode: 'production' }));
        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => profile()),
            providerRunStore: providerRunStore(),
        })).resolves.toBe('blocked');
        expect(store.finalizeBlocked).toHaveBeenCalledWith(
            expect.anything(),
            'TARGET_UNSUPPORTED'
        );
    });

    it('does nothing when an idempotent worker delivery cannot claim the row', async () => {
        const store = workerStore(null);
        const getProfile = vi.fn();
        await expect(processPreflight(preflightId, {
            store,
            getProfile,
            providerRunStore: providerRunStore(),
        }))
            .resolves.toBe('noop');
        expect(getProfile).not.toHaveBeenCalled();
    });

    it('blocks an unclassified primary failure without starting paid work', async () => {
        const store = workerStore();
        const runs = providerRunStore();
        const failure = new Error('transient self-hosted failure');
        const fallback = vi.fn();
        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => { throw failure; }),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('blocked');
        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.releaseClaim).not.toHaveBeenCalled();
        expect(store.finalizeReady).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(expect.anything(), 'ANALYSIS_FAILED');
    });

    it('falls back exactly once for a self-hosted 429 and persists the paid run', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const store = workerStore();
        const runs = providerRunStore();
        vi.mocked(runs.reserve).mockResolvedValue({ created: true, run: storedRun('starting') });
        vi.mocked(runs.checkpointStarted).mockResolvedValue({
            ...storedRun('running'),
            runId: 'StartedRun1234567',
        });
        vi.mocked(runs.checkpointTerminal).mockResolvedValue({
            ...storedRun('succeeded'),
            runId: 'StartedRun1234567',
        });
        const fetchProfile = makeWebProfileFetcher({
            env: {
                SELFHOSTED_PROFILE_TIMEOUT_MS: '1000',
                SELFHOSTED_PROFILE_RETRIES: '0',
                SELFHOSTED_PROFILE_RETRY_BASE_DELAY_MS: '0',
                SELFHOSTED_PROFILE_MIN_INTERVAL_MS: '0',
                SELFHOSTED_PROFILE_CIRCUIT_COOLDOWN_MS: '1000',
                SELFHOSTED_PROFILE_SCHEMA_FAILURE_THRESHOLD: '2',
                SELFHOSTED_PROFILE_TRANSIENT_FAILURE_THRESHOLD: '3',
                SELFHOSTED_PROFILE_MAX_RETRY_AFTER_MS: '60000',
            },
            fetchFn: vi.fn<typeof fetch>(async () => new Response('', {
                status: 429,
                headers: { 'content-type': 'text/plain' },
            })),
        });
        const fallback = vi.fn(async (
            _username: string,
            context?: ProviderCallContext
        ) => {
            expect(context?.invocationWaitLimitSecs).toBeGreaterThan(0);
            expect(context?.invocationWaitLimitSecs).toBeLessThanOrEqual(75);
            expect(context?.invocationDeadlineAtMs).toBeGreaterThan(Date.now());
            return completeFallbackRun(context);
        });

        await expect(processPreflight(preflightId, {
            store,
            getProfile: async username => {
                await fetchProfile(username);
                return null;
            },
            getFallbackProfile: fallback,
            providerRunStore: runs,
            env: {
                ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary',
                ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: preflightIdentitySecret,
            },
        })).resolves.toBe('ready');

        expect(fallback).toHaveBeenCalledOnce();
        expect(runs.reserve).toHaveBeenCalledOnce();
        expect(runs.checkpointStarted).toHaveBeenCalledOnce();
        expect(runs.checkpointTerminal).toHaveBeenCalledOnce();
        expect(JSON.stringify(vi.mocked(runs.reserve).mock.calls[0])).not.toContain('target.name');
        const record = String(info.mock.calls[0]?.[0]);
        expect(JSON.parse(record)).toEqual({
            event: 'preflight_profile_fallback_entered',
            operation: 'profile',
            category: 'rate_limit',
            httpStatus: 429,
            existingRun: false,
        });
        expect(record).not.toContain('target.name');
        expect(record).not.toContain('StartedRun1234567');
        info.mockRestore();
    });

    it('resumes an existing paid run without calling self-hosted or starting another Actor', async () => {
        const store = workerStore(claim({ workerAttemptCount: 2 }));
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('running'));
        const primary = vi.fn();
        const fallback = vi.fn(async (
            _username: string,
            context?: ProviderCallContext
        ) => {
            expect(context).toMatchObject({
                resumeRunId: 'StoredRun12345678',
                credentialSlot: 'quinary',
                maxChargeUsd: 0.0026,
            });
            return profile();
        });

        await expect(processPreflight(preflightId, {
            store,
            getProfile: primary,
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('ready');

        expect(primary).not.toHaveBeenCalled();
        expect(fallback).toHaveBeenCalledOnce();
        expect(runs.reserve).not.toHaveBeenCalled();
    });

    it('releases only a checkpointed RUN_PENDING result for same-run task retry', async () => {
        const store = workerStore(claim({ workerAttemptCount: 3 }));
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('running'));

        const result = processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: vi.fn(async () => {
                throw new Error('SCRAPING_RUN_PENDING_ERROR: still running');
            }),
            providerRunStore: runs,
        });

        await expect(result).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'run_pending',
                workerAttemptCount: 3,
            },
        });
        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it.each([
        'SCRAPING_CONFIG_ERROR: local configuration is invalid.',
        'PREFLIGHT_TASKS_CONFIG_ERROR: runtime budget is invalid.',
        'PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: invalid stored run.',
    ])('never starts paid work for deterministic local failure: %s', async message => {
        const store = workerStore();
        const runs = providerRunStore();
        const fallback = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => { throw new Error(message); }),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
    });

    it.each([
        'PREFLIGHT_PERSISTENCE_ERROR: finalize failed (08006).',
        'PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: load failed (08006).',
        'ANALYSIS_PERSISTENCE_ERROR: provider checkpoint is temporarily unavailable.',
    ])('releases transient persistence failures without paid fallback: %s', async message => {
        const store = workerStore(claim({ workerAttemptCount: 4 }));
        const runs = providerRunStore();
        const fallback = vi.fn();

        const result = processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => { throw new Error(message); }),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        });

        await expect(result).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'persistence',
                retryable: true,
                workerAttemptCount: 4,
            },
        });
        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('releases a transient provider-ledger load failure before self-hosted work', async () => {
        const store = workerStore();
        const runs = providerRunStore();
        vi.mocked(runs.load).mockRejectedValue(
            new Error('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: load failed (08006).')
        );
        const primary = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: primary,
            providerRunStore: runs,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: { category: 'persistence' },
        });

        expect(primary).not.toHaveBeenCalled();
        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('releases a transient finalize-ready failure instead of replacing it with blocked', async () => {
        const store = workerStore();
        vi.mocked(store.finalizeReady).mockRejectedValue(
            new Error('PREFLIGHT_PERSISTENCE_ERROR: finalize ready failed (08006).')
        );

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => profile()),
            providerRunStore: providerRunStore(),
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: { category: 'persistence' },
        });

        expect(store.releaseClaim).toHaveBeenCalledOnce();
        expect(store.finalizeBlocked).not.toHaveBeenCalled();
    });

    it('keeps an explicit self-hosted null free and terminal', async () => {
        const store = workerStore();
        const runs = providerRunStore();
        const fallback = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(async () => null),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(expect.anything(), 'TARGET_NOT_FOUND');
    });

    it('blocks a reserved start without a run id before invoking any paid provider', async () => {
        const store = workerStore(claim({ workerAttemptCount: 2 }));
        const runs = providerRunStore();
        vi.mocked(runs.load).mockResolvedValue(storedRun('starting'));
        const fallback = vi.fn();

        await expect(processPreflight(preflightId, {
            store,
            getProfile: vi.fn(),
            getFallbackProfile: fallback,
            providerRunStore: runs,
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(store.finalizeBlocked).toHaveBeenCalledWith(expect.anything(), 'ANALYSIS_FAILED');
    });
});

describe('preflight public mapping', () => {
    it('returns a signed proxy path and never the stored raw CDN URL', () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;
        const result = publicPreflightStatusDto({
            preflightId,
            status: 'ready',
            expiresAt,
            blockedCode: null,
            readySnapshot: snapshot,
            exclusionDecision: 'exclude',
        }, () => '/api/image-proxy?token=signed');

        expect(result).toMatchObject({
            status: 'ready',
            exclusionDecision: 'exclude',
            target: { profileImage: '/api/image-proxy?token=signed' },
        });
        expect(JSON.stringify(result)).not.toContain('excludedInstagramId');
        expect(JSON.stringify(result)).not.toContain('cdninstagram.com');
    });

    it('rejects a stale ready row even before a database cleanup marks it expired', () => {
        const snapshot = buildReadyPreflightSnapshot(
            profile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;

        expect(() => publicPreflightStatusDto({
            preflightId,
            status: 'ready',
            expiresAt: '2026-07-13T12:00:00.000Z',
            blockedCode: null,
            readySnapshot: snapshot,
            exclusionDecision: 'skip',
        }, () => undefined, Date.parse('2026-07-13T12:00:00.001Z'))).toThrow('PREFLIGHT_EXPIRED');
    });

    it('requires the explicit signed-test-entitlement feature gate in every environment', () => {
        expect(trustedPreflightAccessMode({})).toBe('production');
        expect(trustedPreflightAccessMode({
            NODE_ENV: 'production',
            PREFLIGHT_ACCESS_MODE: 'test_entitlement',
            ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'true',
            ANALYSIS_TEST_ENTITLEMENT_SECRET: entitlementSecret,
        })).toBe('test_entitlement');
        expect(() => trustedPreflightAccessMode({
            NODE_ENV: 'production',
            PREFLIGHT_ACCESS_MODE: 'test_entitlement',
            ANALYSIS_TEST_ENTITLEMENTS_ENABLED: 'false',
        })).toThrow('test entitlement mode is disabled');
    });
});
