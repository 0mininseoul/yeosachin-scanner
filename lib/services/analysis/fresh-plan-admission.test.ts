import { describe, expect, it, vi } from 'vitest';
import type { InstagramProfile } from '@/lib/types/instagram';
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

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-42d3-b456-426614174001';
const ADMISSION_TOKEN = '123e4567-e89b-42d3-a456-426614174003';
const CLAIM_TOKEN = '123e4567-e89b-42d3-a456-426614174004';
const DISPATCH_TOKEN = '123e4567-e89b-42d3-a456-426614174005';
const DISPATCH_GENERATION = 3;
const ENTITLEMENT_JTI_HASH = 'a'.repeat(64);
const REFRESHED_AT = '2026-07-14T01:00:00.000Z';

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

        await expect(processAnalysisV2FreshAdmission(client, workerInput(), {
            getProfile,
            createClaimToken: () => CLAIM_TOKEN,
        })).resolves.toBe('ready');

        expect(getProfile).toHaveBeenCalledWith('target.account');
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
        })).rejects.toThrow('ANALYSIS_V2_FRESH_ADMISSION_RETRY');
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
            })).rejects.toThrow('ANALYSIS_V2_FRESH_ADMISSION_RETRY');
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
