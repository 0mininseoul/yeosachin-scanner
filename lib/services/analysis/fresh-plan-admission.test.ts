import { describe, expect, it, vi } from 'vitest';
import type { InstagramProfile } from '@/lib/types/instagram';
import type { ProviderCallContext } from '@/lib/services/instagram/providers/types';
import {
    ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES,
    AnalysisV2FreshAdmissionError,
    AnalysisV2FreshAdmissionLeaseBusyError,
    processAnalysisV2FreshAdmission,
    markAnalysisV2FreshAdmissionDispatched,
    releaseAnalysisV2FreshAdmissionDispatch,
    reserveAnalysisV2FreshAdmission,
    type AnalysisV2FreshAdmissionRpcClient,
} from './fresh-plan-admission';
import { PreflightWorkerRetryError } from './preflight';
import type {
    PreflightProviderRunStore,
    StoredPreflightProviderRun,
} from './preflight-provider-run';
import { PREFLIGHT_PROVIDER_DEADLINE_MS } from './preflight-runtime-policy';

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-42d3-b456-426614174001';
const ADMISSION_TOKEN = '123e4567-e89b-42d3-a456-426614174003';
const CLAIM_TOKEN = '123e4567-e89b-42d3-a456-426614174004';
const DISPATCH_TOKEN = '123e4567-e89b-42d3-a456-426614174005';
const DISPATCH_GENERATION = 3;
const ENTITLEMENT_JTI_HASH = 'a'.repeat(64);
const REFRESHED_AT = '2026-07-14T01:00:00.000Z';
const FRESH_ENV = Object.freeze({
    ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary',
    ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET: Buffer.alloc(32, 7).toString('base64'),
});

const pricing = {
    basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
    standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
    plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
} as const;

function cards(required: 'basic' | 'standard' | 'plus' = 'standard') {
    const order = ['basic', 'standard', 'plus'] as const;
    const capacities = {
        basic: { followers: 400, following: 400 },
        standard: { followers: 800, following: 800 },
        plus: { followers: 1_200, following: 1_200 },
    };
    const limits = { basic: 300, standard: 600, plus: 900 };
    return Object.fromEntries(order.map((planId, index) => {
        const requiredIndex = order.indexOf(required);
        return [planId, {
            launchStatus: 'test_only',
            relationshipCapacity: capacities[planId],
            detailedMutualLimit: limits[planId],
            selectionState: index < requiredIndex
                ? 'unavailable'
                : index === requiredIndex ? 'required' : 'available_upgrade',
            unavailableReason: index < requiredIndex ? 'below_required_plan' : null,
        }];
    }));
}

function pendingRow(overrides: Record<string, unknown> = {}) {
    return {
        admission_status: 'pending',
        should_enqueue: true,
        admission_generation: 2,
        dispatch_generation: DISPATCH_GENERATION,
        dispatch_token: DISPATCH_TOKEN,
        selected_plan_id: 'standard',
        selected_plan_allowed: null,
        admission_token: null,
        admission_refreshed_at: null,
        target_followers_count: null,
        target_following_count: null,
        capacity_required_plan_id: null,
        required_plan_id: null,
        plan_cards_snapshot: null,
        pricing_version: 'deferred',
        pricing_snapshot: pricing,
        admission_error_code: null,
        ...overrides,
    };
}

function readyRow(overrides: Record<string, unknown> = {}) {
    return {
        ...pendingRow(),
        admission_status: 'ready',
        should_enqueue: false,
        selected_plan_allowed: true,
        admission_token: ADMISSION_TOKEN,
        dispatch_token: null,
        admission_refreshed_at: REFRESHED_AT,
        target_followers_count: 620,
        target_following_count: 710,
        capacity_required_plan_id: 'standard',
        required_plan_id: 'standard',
        plan_cards_snapshot: cards(),
        ...overrides,
    };
}

function profile(overrides: Partial<InstagramProfile> = {}): InstagramProfile {
    return {
        username: 'target.account',
        followersCount: 620,
        followingCount: 710,
        postsCount: 8,
        isPrivate: false,
        isVerified: false,
        ...overrides,
    };
}

function clientWith(handler: (
    name: string,
    params: Record<string, unknown>
) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>) {
    const rpc = vi.fn(handler);
    return { client: { rpc } as AnalysisV2FreshAdmissionRpcClient, rpc };
}

function reservationInput(selectedPlanId: 'basic' | 'standard' | 'plus' = 'standard') {
    return {
        preflightId: PREFLIGHT_ID,
        userId: USER_ID,
        selectedPlanId,
        entitlementJtiHash: ENTITLEMENT_JTI_HASH,
    };
}

function workerInput() {
    return {
        preflightId: PREFLIGHT_ID,
        generation: 2,
        dispatchGeneration: DISPATCH_GENERATION,
        dispatchToken: DISPATCH_TOKEN,
    };
}

function storedProviderRun(
    status: StoredPreflightProviderRun['status'] = 'succeeded'
): StoredPreflightProviderRun {
    const rejected = status === 'rejected';
    return {
        preflightId: PREFLIGHT_ID,
        operationKey: 'target-profile-fresh-admission:g4',
        inputHash: 'f'.repeat(64),
        logicalProvider: 'apify',
        actorId: 'apify/instagram-profile-scraper',
        credentialSlot: 'quinary',
        maxChargeUsd: 0.0026,
        status,
        runId: status === 'starting' || rejected ? null : 'FreshAdmissionRun123',
        actualUsageUsd: status === 'succeeded' ? 0.0026 : rejected ? 0 : null,
        reservedAt: '2026-07-14T01:00:00.000Z',
        runStartedAt: status === 'starting' || rejected
            ? null
            : '2026-07-14T01:00:01.000Z',
        terminalizedAt: ['starting', 'running'].includes(status)
            ? null
            : '2026-07-14T01:00:02.000Z',
        usageReconciledAt: status === 'succeeded' || rejected
            ? '2026-07-14T01:00:02.000Z'
            : null,
    };
}

function providerRunStore(
    existing: StoredPreflightProviderRun | null = null
): PreflightProviderRunStore & {
    markReusableProfileSchemaV1: ReturnType<typeof vi.fn>;
} {
    let current = existing;
    return {
        load: vi.fn(async input => current ? { ...current, inputHash: input.inputHash } : null),
        reserve: vi.fn(async input => {
            current = {
                ...storedProviderRun('starting'),
                inputHash: input.inputHash,
                credentialSlot: input.credentialSlot,
            };
            return { created: true, run: current };
        }),
        checkpointStarted: vi.fn(async input => {
            current = {
                ...storedProviderRun('running'),
                inputHash: input.inputHash,
                credentialSlot: input.credentialSlot,
                runId: input.runId,
            };
            return current;
        }),
        checkpointRejected: vi.fn(async input => {
            current = {
                ...storedProviderRun('rejected'),
                inputHash: input.inputHash,
                credentialSlot: input.credentialSlot,
            };
            return current;
        }),
        checkpointTerminal: vi.fn(async input => {
            current = {
                ...storedProviderRun(input.status),
                inputHash: input.inputHash,
                credentialSlot: input.credentialSlot,
                runId: input.runId,
                actualUsageUsd: input.actualUsageUsd,
            };
            return current;
        }),
        markReusableProfileSchemaV1: vi.fn(async () => 'marked' as const),
    };
}

describe('durable fresh V2 admission reservation', () => {
    it('reserves one idempotent Cloud Run refresh without fetching Instagram in-process', async () => {
        const { client, rpc } = clientWith(async () => ({
            data: [pendingRow()],
            error: null,
        }));

        await expect(reserveAnalysisV2FreshAdmission(client, reservationInput(), {
            createAdmissionToken: () => ADMISSION_TOKEN,
            createDispatchToken: () => DISPATCH_TOKEN,
        })).resolves.toEqual({
            state: 'pending',
            shouldEnqueue: true,
            generation: 2,
            dispatchGeneration: DISPATCH_GENERATION,
            dispatchToken: DISPATCH_TOKEN,
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.reserveRpc,
            {
                p_preflight_id: PREFLIGHT_ID,
                p_user_id: USER_ID,
                p_selected_plan_id: 'standard',
                p_entitlement_jti_hash: ENTITLEMENT_JTI_HASH,
                p_admission_token: ADMISSION_TOKEN,
                p_dispatch_token: DISPATCH_TOKEN,
            }
        );
    });

    it('does not request another task while the exact generation holds an active lease', async () => {
        const { client } = clientWith(async () => ({
            data: [pendingRow({
                admission_status: 'processing',
                should_enqueue: false,
                dispatch_token: null,
            })],
            error: null,
        }));

        await expect(reserveAnalysisV2FreshAdmission(client, reservationInput(), {
            createAdmissionToken: () => ADMISSION_TOKEN,
            createDispatchToken: () => DISPATCH_TOKEN,
        })).resolves.toEqual({
            state: 'pending',
            shouldEnqueue: false,
            generation: 2,
            dispatchGeneration: DISPATCH_GENERATION,
            dispatchToken: null,
        });
    });

    it('does not recreate a task after the durable dispatch is already reserved or enqueued', async () => {
        const { client } = clientWith(async () => ({
            data: [pendingRow({
                should_enqueue: false,
                dispatch_token: null,
            })],
            error: null,
        }));

        await expect(reserveAnalysisV2FreshAdmission(client, reservationInput(), {
            createAdmissionToken: () => ADMISSION_TOKEN,
            createDispatchToken: () => DISPATCH_TOKEN,
        })).resolves.toEqual({
            state: 'pending',
            shouldEnqueue: false,
            generation: 2,
            dispatchGeneration: DISPATCH_GENERATION,
            dispatchToken: null,
        });
    });

    it('marks success and releases failure with the exact owner-bound dispatch fence', async () => {
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.markDispatchedRpc) {
                return { data: true, error: null };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseDispatchRpc) {
                return { data: false, error: null };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const dispatch = {
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            generation: 2,
            dispatchGeneration: DISPATCH_GENERATION,
            dispatchToken: DISPATCH_TOKEN,
        };

        await expect(markAnalysisV2FreshAdmissionDispatched(client, dispatch))
            .resolves.toBe('marked');
        await expect(releaseAnalysisV2FreshAdmissionDispatch(client, dispatch))
            .resolves.toBe('already_settled');
        for (const [, params] of rpc.mock.calls) {
            expect(params).toEqual({
                p_preflight_id: PREFLIGHT_ID,
                p_user_id: USER_ID,
                p_admission_generation: 2,
                p_dispatch_generation: DISPATCH_GENERATION,
                p_dispatch_token: DISPATCH_TOKEN,
            });
        }
    });

    it('returns the committed latest counts and canonical plan cards before consumption', async () => {
        const { client } = clientWith(async () => ({ data: [readyRow()], error: null }));

        await expect(reserveAnalysisV2FreshAdmission(client, reservationInput(), {
            createAdmissionToken: () => ADMISSION_TOKEN,
            createDispatchToken: () => DISPATCH_TOKEN,
        })).resolves.toMatchObject({
            state: 'ready',
            selectedPlanAllowed: true,
            admissionToken: ADMISSION_TOKEN,
            snapshot: {
                followersCount: 620,
                followingCount: 710,
                capacityRequiredPlanId: 'standard',
                requiredPlanId: 'standard',
                selectedPlanId: 'standard',
                plans: [
                    { planId: 'basic', selectionState: 'unavailable' },
                    { planId: 'standard', selectionState: 'required' },
                    { planId: 'plus', selectionState: 'available_upgrade' },
                ],
            },
        });
    });

    it('accepts the stable token already reserved by the same entitlement attempt', async () => {
        const { client } = clientWith(async () => ({ data: [readyRow()], error: null }));

        await expect(reserveAnalysisV2FreshAdmission(client, reservationInput(), {
            createAdmissionToken: () => CLAIM_TOKEN,
            createDispatchToken: () => DISPATCH_TOKEN,
        })).resolves.toMatchObject({
            state: 'ready',
            admissionToken: ADMISSION_TOKEN,
        });
    });

    it('surfaces stale cheap-plan rejection with the already committed latest snapshot', async () => {
        const { client } = clientWith(async () => ({
            data: [readyRow({
                selected_plan_id: 'basic',
                selected_plan_allowed: false,
            })],
            error: null,
        }));

        await expect(reserveAnalysisV2FreshAdmission(
            client,
            reservationInput('basic'),
            {
                createAdmissionToken: () => ADMISSION_TOKEN,
                createDispatchToken: () => DISPATCH_TOKEN,
            }
        )).resolves.toMatchObject({
            state: 'ready',
            selectedPlanAllowed: false,
            snapshot: {
                followersCount: 620,
                requiredPlanId: 'standard',
                selectedPlanId: 'basic',
            },
        });
    });

    it('maps only bounded database errors and rejects inconsistent results', async () => {
        const bounded = clientWith(async () => ({
            data: null,
            error: { code: 'P0001', message: 'ANALYSIS_V2_PREFLIGHT_EXPIRED' },
        }));
        await expect(reserveAnalysisV2FreshAdmission(
            bounded.client,
            reservationInput()
        )).rejects.toEqual(
            new AnalysisV2FreshAdmissionError('ANALYSIS_V2_PREFLIGHT_EXPIRED')
        );

        const malformed = clientWith(async () => ({
            data: [readyRow({ admission_token: null })],
            error: null,
        }));
        await expect(reserveAnalysisV2FreshAdmission(
            malformed.client,
            reservationInput(),
            {
                createAdmissionToken: () => ADMISSION_TOKEN,
                createDispatchToken: () => DISPATCH_TOKEN,
            }
        )).rejects.toThrow('invalid ready result');
    });
});

describe('durable fresh V2 admission worker', () => {
    it('uses the count-only profile contract and completes the exact claimed generation', async () => {
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.completeRpc) {
                return {
                    data: [{ admission_status: 'ready', admission_error_code: null }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const getProfile = vi.fn().mockResolvedValue(profile({
            // No latestPosts: count admission is independent from media completeness.
            postsCount: 50,
        }));
        const workerStartedAt = Date.now();

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile,
            createClaimToken: () => CLAIM_TOKEN,
        })).resolves.toBe('ready');

        expect(getProfile).toHaveBeenCalledWith('target.account', {
            invocationDeadlineAtMs: expect.any(Number),
        });
        const invocationDeadlineAtMs = getProfile.mock.calls[0][1]?.invocationDeadlineAtMs;
        expect(invocationDeadlineAtMs).toBeGreaterThanOrEqual(
            workerStartedAt + PREFLIGHT_PROVIDER_DEADLINE_MS
        );
        expect(invocationDeadlineAtMs).toBeLessThanOrEqual(
            Date.now() + PREFLIGHT_PROVIDER_DEADLINE_MS
        );
        expect(rpc).toHaveBeenNthCalledWith(
            1,
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc,
            expect.objectContaining({
                p_preflight_id: PREFLIGHT_ID,
                p_admission_generation: 2,
                p_dispatch_generation: DISPATCH_GENERATION,
                p_dispatch_token: DISPATCH_TOKEN,
                p_claim_token: CLAIM_TOKEN,
            })
        );
        expect(rpc).toHaveBeenNthCalledWith(
            2,
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.completeRpc,
            expect.objectContaining({
                p_target_followers_count: 620,
                p_target_following_count: 710,
                p_target_is_private: false,
            })
        );
    });

    it.each([
        ['missing', null, 'ANALYSIS_V2_TARGET_NOT_FOUND'],
        ['private', profile({ isPrivate: true }), 'ANALYSIS_V2_TARGET_PRIVATE'],
    ] as const)('terminalizes a %s target without completing', async (_label, value, code) => {
        const { client, rpc } = clientWith(async (name, params) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.blockRpc) {
                return {
                    data: [{
                        admission_status: 'blocked',
                        admission_error_code: params.p_error_code,
                    }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockResolvedValue(value),
            createClaimToken: () => CLAIM_TOKEN,
        })).resolves.toBe('blocked');
        expect(rpc).toHaveBeenLastCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.blockRpc,
            expect.objectContaining({ p_error_code: code })
        );
    });

    it('rereads an existing successful preflight fallback without a second paid run', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const callOrder: string[] = [];
        const { client } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.completeRpc) {
                callOrder.push('complete');
                return {
                    data: [{ admission_status: 'ready', admission_error_code: null }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const runs = providerRunStore(storedProviderRun('succeeded'));
        vi.mocked(runs.markReusableProfileSchemaV1).mockImplementationOnce(async () => {
            callOrder.push('attest');
            return 'already_marked';
        });
        const fallback = vi.fn(async (
            _username: string,
            context?: ProviderCallContext
        ) => {
            expect(context).toMatchObject({
                resumeRunId: 'FreshAdmissionRun123',
                credentialSlot: 'quinary',
                maxChargeUsd: 0.0026,
            });
            return profile({
                followersCount: 621,
                followingCount: 711,
                postsCount: 0,
                latestPosts: [],
            });
        });

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockRejectedValue(
                new Error('SCRAPING_SCHEMA_ERROR: selfhosted fixture')
            ),
            getFallbackProfile: fallback,
            providerRunStore: runs,
            env: FRESH_ENV,
            createClaimToken: () => CLAIM_TOKEN,
        })).resolves.toBe('ready');

        expect(fallback).toHaveBeenCalledOnce();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(runs.checkpointStarted).not.toHaveBeenCalled();
        expect(runs.markReusableProfileSchemaV1).toHaveBeenCalledWith({
            preflightId: PREFLIGHT_ID,
            claimToken: CLAIM_TOKEN,
            inputHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            runId: 'FreshAdmissionRun123',
        });
        expect(callOrder).toEqual(['attest', 'complete']);
        const record = String(info.mock.calls[0]?.[0]);
        expect(JSON.parse(record)).toEqual({
            event: 'preflight_profile_fallback_entered',
            operation: 'fresh_admission',
            category: 'schema',
            httpStatus: null,
            existingRun: true,
        });
        expect(record).not.toContain('target.account');
        expect(record).not.toContain('FreshAdmissionRun123');
        info.mockRestore();
    });

    it('keeps a pending existing run retryable without consuming the failure budget', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseRpc) {
                return { data: true, error: null };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const runs = providerRunStore(storedProviderRun('running'));
        const fallback = vi.fn(async (
            _username: string,
            context?: ProviderCallContext
        ) => {
            expect(context?.resumeRunId).toBe('FreshAdmissionRun123');
            throw new Error('SCRAPING_RUN_PENDING_ERROR: fixture is still running');
        });

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockRejectedValue(
                new Error('SCRAPING_SCHEMA_ERROR: selfhosted fixture')
            ),
            getFallbackProfile: fallback,
            providerRunStore: runs,
            env: FRESH_ENV,
            createClaimToken: () => CLAIM_TOKEN,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'run_pending',
                retryable: true,
                workerAttemptCount: null,
            },
        });

        expect(runs.reserve).not.toHaveBeenCalled();
        expect(runs.checkpointStarted).not.toHaveBeenCalled();
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseRpc,
            expect.objectContaining({ p_claim_token: CLAIM_TOKEN })
        );
        expect(rpc).not.toHaveBeenCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc,
            expect.anything()
        );
        info.mockRestore();
    });

    it('keeps a replayed definite start rejection out of the paid provider path', async () => {
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc) {
                return {
                    data: [{
                        admission_status: 'pending',
                        failure_count: 1,
                        admission_error_code: null,
                    }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const runs = providerRunStore(storedProviderRun('rejected'));
        const fallback = vi.fn().mockRejectedValue(
            new Error('paid provider must not be re-entered')
        );

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockRejectedValue(
                new Error('SCRAPING_SCHEMA_ERROR: selfhosted fixture')
            ),
            getFallbackProfile: fallback,
            providerRunStore: runs,
            env: FRESH_ENV,
            createClaimToken: () => CLAIM_TOKEN,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'provider',
                retryable: true,
                workerAttemptCount: 1,
            },
        });

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc,
            expect.objectContaining({ p_claim_token: CLAIM_TOKEN })
        );
    });

    it('releases a transient provider-run persistence failure without consuming the budget', async () => {
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseRpc) {
                return { data: true, error: null };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const runs = providerRunStore();
        vi.mocked(runs.load).mockRejectedValueOnce(new Error(
            'PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR: transient database failure.'
        ));

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockRejectedValue(
                new Error('SCRAPING_SCHEMA_ERROR: selfhosted fixture')
            ),
            providerRunStore: runs,
            env: FRESH_ENV,
            createClaimToken: () => CLAIM_TOKEN,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'persistence',
                retryable: true,
                workerAttemptCount: null,
            },
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseRpc,
            expect.objectContaining({ p_claim_token: CLAIM_TOKEN })
        );
        expect(rpc).not.toHaveBeenCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc,
            expect.anything()
        );
    });

    it('reserves the one preflight fallback when fresh admission is its first eligible failure', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const callOrder: string[] = [];
        const { client } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.completeRpc) {
                callOrder.push('complete');
                return {
                    data: [{ admission_status: 'ready', admission_error_code: null }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const runs = providerRunStore();
        const fallback = vi.fn(async (
            _username: string,
            context?: ProviderCallContext
        ) => {
            const identity = {
                logicalProvider: 'apify' as const,
                actorId: 'apify/instagram-profile-scraper',
                credentialSlot: 'quinary' as const,
                maxChargeUsd: 0.0026 as const,
            };
            await context?.onBeforeRunStart?.(identity);
            await context?.onRunStarted?.('FreshAdmissionRun456');
            await context?.onCostRunStarted?.({
                ...identity,
                runId: 'FreshAdmissionRun456',
            });
            await context?.onCostRunFinished?.({
                ...identity,
                runId: 'FreshAdmissionRun456',
                status: 'succeeded',
                usageTotalUsd: null,
            });
            return profile({ postsCount: 0, latestPosts: [] });
        });
        vi.mocked(runs.markReusableProfileSchemaV1).mockImplementationOnce(async () => {
            callOrder.push('attest');
            return 'marked';
        });

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockRejectedValue(
                new Error('SCRAPING_SCHEMA_ERROR: selfhosted fixture')
            ),
            getFallbackProfile: fallback,
            providerRunStore: runs,
            env: FRESH_ENV,
            createClaimToken: () => CLAIM_TOKEN,
        })).resolves.toBe('ready');

        expect(runs.reserve).toHaveBeenCalledOnce();
        expect(runs.checkpointStarted).toHaveBeenCalledOnce();
        expect(runs.checkpointTerminal).toHaveBeenCalledOnce();
        expect(runs.markReusableProfileSchemaV1).toHaveBeenCalledWith(expect.objectContaining({
            runId: 'FreshAdmissionRun456',
        }));
        expect(callOrder).toEqual(['attest', 'complete']);
        expect(JSON.stringify(vi.mocked(runs.reserve).mock.calls)).not.toContain(
            'target.account'
        );
        info.mockRestore();
    });

    it('never attests or completes when the paid full-profile dataset fails schema parsing', async () => {
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc) {
                return {
                    data: [{
                        admission_status: 'pending',
                        failure_count: 1,
                        admission_error_code: null,
                    }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const runs = providerRunStore(storedProviderRun('succeeded'));

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockRejectedValue(
                new Error('SCRAPING_SCHEMA_ERROR: selfhosted fixture')
            ),
            getFallbackProfile: vi.fn().mockRejectedValue(
                new Error('SCRAPING_SCHEMA_ERROR: malformed latestPosts')
            ),
            providerRunStore: runs,
            env: FRESH_ENV,
            createClaimToken: () => CLAIM_TOKEN,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: { category: 'schema', workerAttemptCount: 1 },
        });

        expect(runs.markReusableProfileSchemaV1).not.toHaveBeenCalled();
        expect(rpc).not.toHaveBeenCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.completeRpc,
            expect.anything()
        );
    });

    it('keeps an explicit selfhosted not-found result free and terminal', async () => {
        const { client } = clientWith(async (name, params) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.blockRpc) {
                return {
                    data: [{
                        admission_status: 'blocked',
                        admission_error_code: params.p_error_code,
                    }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const runs = providerRunStore();
        const fallback = vi.fn();

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockResolvedValue(null),
            getFallbackProfile: fallback,
            providerRunStore: runs,
            env: FRESH_ENV,
            createClaimToken: () => CLAIM_TOKEN,
        })).resolves.toBe('blocked');

        expect(fallback).not.toHaveBeenCalled();
        expect(runs.load).not.toHaveBeenCalled();
        expect(runs.reserve).not.toHaveBeenCalled();
    });

    it.each([
        ['transport', new Error('transient transport failure')],
        ['identity', profile({ username: 'different.account' })],
    ])('records a bounded %s failure and leaves Cloud Tasks retryable', async (_label, failure) => {
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc) {
                return {
                    data: [{
                        admission_status: 'pending',
                        failure_count: 1,
                        admission_error_code: null,
                    }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        const getProfile = failure instanceof Error
            ? vi.fn().mockRejectedValue(failure)
            : vi.fn().mockResolvedValue(failure);

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile,
            createClaimToken: () => CLAIM_TOKEN,
        })).rejects.toMatchObject({
            message: 'PREFLIGHT_WORKER_RETRY',
            classification: {
                category: 'unknown',
                workerAttemptCount: 1,
            },
        });
        expect(rpc).toHaveBeenLastCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc,
            expect.objectContaining({ p_claim_token: CLAIM_TOKEN })
        );
        expect(rpc).not.toHaveBeenCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseRpc,
            expect.anything()
        );
    });

    it('settles the third self-hosted failure as a user-visible blocked admission', async () => {
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc) {
                return {
                    data: [{
                        admission_status: 'blocked',
                        failure_count: 3,
                        admission_error_code: 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE',
                    }],
                    error: null,
                };
            }
            throw new Error(`unexpected RPC ${name}`);
        });

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockRejectedValue(new Error('provider unavailable')),
            createClaimToken: () => CLAIM_TOKEN,
        })).resolves.toBe('blocked');
        expect(rpc).toHaveBeenLastCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc,
            expect.objectContaining({ p_claim_token: CLAIM_TOKEN })
        );
    });

    it('releases the exact claim when terminal block persistence fails', async () => {
        const { client, rpc } = clientWith(async (name) => {
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                return {
                    data: [{
                        claimed: true,
                        admission_status: 'processing',
                        target_instagram_id: 'target.account',
                    }],
                    error: null,
                };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.blockRpc) {
                return { data: null, error: { code: 'XX000', message: 'private detail' } };
            }
            if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseRpc) {
                return { data: true, error: null };
            }
            throw new Error(`unexpected RPC ${name}`);
        });

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile: vi.fn().mockResolvedValue(null),
            createClaimToken: () => CLAIM_TOKEN,
        })).rejects.toThrow('block failed');
        expect(rpc).toHaveBeenLastCalledWith(
            ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.releaseRpc,
            expect.objectContaining({ p_claim_token: CLAIM_TOKEN })
        );
    });

    it('applies the preflight runtime budget before fetching the count summary', async () => {
        const previousRetries = process.env.SELFHOSTED_PROFILE_RETRIES;
        const previousTimeout = process.env.SELFHOSTED_PROFILE_TIMEOUT_MS;
        process.env.SELFHOSTED_PROFILE_RETRIES = '3';
        process.env.SELFHOSTED_PROFILE_TIMEOUT_MS = '60000';
        try {
            const { client } = clientWith(async (name) => {
                if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.claimRpc) {
                    return {
                        data: [{
                            claimed: true,
                            admission_status: 'processing',
                            target_instagram_id: 'target.account',
                        }],
                        error: null,
                    };
                }
                if (name === ANALYSIS_V2_FRESH_ADMISSION_DATABASE_NAMES.failureRpc) {
                    return {
                        data: [{
                            admission_status: 'pending',
                            failure_count: 1,
                            admission_error_code: null,
                        }],
                        error: null,
                    };
                }
                throw new Error(`unexpected RPC ${name}`);
            });
            const getProfile = vi.fn();

            await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
                getProfile,
                createClaimToken: () => CLAIM_TOKEN,
            })).rejects.toBeInstanceOf(PreflightWorkerRetryError);
            expect(getProfile).not.toHaveBeenCalled();
        } finally {
            if (previousRetries === undefined) delete process.env.SELFHOSTED_PROFILE_RETRIES;
            else process.env.SELFHOSTED_PROFILE_RETRIES = previousRetries;
            if (previousTimeout === undefined) delete process.env.SELFHOSTED_PROFILE_TIMEOUT_MS;
            else process.env.SELFHOSTED_PROFILE_TIMEOUT_MS = previousTimeout;
        }
    });

    it('keeps an active duplicate lease retryable instead of acknowledging it', async () => {
        const { client } = clientWith(async () => ({
            data: [{
                claimed: false,
                admission_status: 'processing',
                target_instagram_id: null,
            }],
            error: null,
        }));
        await expect(processAnalysisV2FreshAdmission(
            client,
            workerInput(),
            { createClaimToken: () => CLAIM_TOKEN }
        )).rejects.toBeInstanceOf(
            AnalysisV2FreshAdmissionLeaseBusyError
        );
    });
});
