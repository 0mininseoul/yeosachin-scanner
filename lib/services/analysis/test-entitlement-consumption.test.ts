import { describe, expect, it, vi } from 'vitest';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';
import { ANALYSIS_V2_BOOTSTRAP_JOB_KEY } from './v2-coordinator';
import {
    AnalysisV2EntitlementConsumptionError,
    consumeAnalysisV2TestEntitlement,
    hashAnalysisTestEntitlementJti,
    validatePreflightForTestEntitlement,
    type AnalysisV2PreflightRow,
    type AnalysisV2TestEntitlementRpcClient,
} from './test-entitlement-consumption';

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-42d3-b456-426614174001';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174002';
const NOW_MS = Date.UTC(2026, 6, 13, 6, 0, 0);

function preflightRow(
    overrides: Partial<AnalysisV2PreflightRow> = {}
): AnalysisV2PreflightRow {
    return {
        id: PREFLIGHT_ID,
        user_id: USER_ID,
        status: 'ready',
        expires_at: new Date(NOW_MS + 10 * 60_000).toISOString(),
        target_instagram_id: 'target.account',
        target_followers_count: 600,
        target_following_count: 700,
        access_mode: 'test_entitlement',
        capacity_required_plan_id: 'standard',
        required_plan_id: 'standard',
        launch_status_snapshot: {
            basic: 'test_only',
            standard: 'test_only',
            plus: 'test_only',
        },
        plan_cards_snapshot: {
            basic: {
                launchStatus: 'test_only',
                relationshipCapacity: { followers: 400, following: 400 },
                detailedMutualLimit: 300,
                selectionState: 'unavailable',
                unavailableReason: 'below_required_plan',
            },
            standard: {
                launchStatus: 'test_only',
                relationshipCapacity: { followers: 800, following: 800 },
                detailedMutualLimit: 600,
                selectionState: 'required',
                unavailableReason: null,
            },
            plus: {
                launchStatus: 'test_only',
                relationshipCapacity: { followers: 1_200, following: 1_200 },
                detailedMutualLimit: 900,
                selectionState: 'available_upgrade',
                unavailableReason: null,
            },
        },
        exclusion_decision: 'skip',
        excluded_instagram_id: null,
        pricing_version: 'deferred',
        pricing_snapshot: {
            basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
            standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
            plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
        },
        consumed_request_id: null,
        ...overrides,
    };
}

function clientWith(data: unknown, error: { code?: string; message?: string } | null = null) {
    const rpc = vi.fn().mockResolvedValue({ data, error });
    return { client: { rpc } as AnalysisV2TestEntitlementRpcClient, rpc };
}

function expectBoundedError(
    action: () => unknown,
    code: string
) {
    try {
        action();
        throw new Error('Expected the action to fail.');
    } catch (error) {
        expect(error).toBeInstanceOf(AnalysisV2EntitlementConsumptionError);
        expect((error as AnalysisV2EntitlementConsumptionError).code).toBe(code);
    }
}

describe('test entitlement preflight validation', () => {
    it('accepts the required plan or an enabled upgrade from an exact snapshot', () => {
        expect(validatePreflightForTestEntitlement(
            preflightRow(),
            'standard',
            { nowMs: NOW_MS }
        )).toEqual({
            id: PREFLIGHT_ID,
            userId: USER_ID,
            selectedPlanId: 'standard',
            state: 'ready',
        });
        expect(validatePreflightForTestEntitlement(
            preflightRow(),
            'plus',
            { nowMs: NOW_MS }
        ).selectedPlanId).toBe('plus');
    });

    it('defers stale ready-plan selection to the authoritative fresh admission RPC', () => {
        expect(validatePreflightForTestEntitlement(
            preflightRow(),
            'basic',
            {
                nowMs: NOW_MS,
                deferPlanSelectionToFreshAdmission: true,
            }
        )).toEqual({
            id: PREFLIGHT_ID,
            userId: USER_ID,
            selectedPlanId: 'basic',
            state: 'ready',
        });

        expectBoundedError(
            () => validatePreflightForTestEntitlement(
                preflightRow(),
                'basic',
                { nowMs: NOW_MS }
            ),
            'ANALYSIS_V2_PLAN_NOT_ALLOWED'
        );
    });

    it('rejects a lower plan and inconsistent capacity, launch, access, or price snapshots', () => {
        for (const [row, planId] of [
            [preflightRow(), 'basic'],
            [preflightRow({ capacity_required_plan_id: 'basic' }), 'standard'],
            [preflightRow({ required_plan_id: 'plus' }), 'standard'],
            [preflightRow({ access_mode: 'production' }), 'standard'],
            [preflightRow({ pricing_snapshot: { invalid: true } }), 'standard'],
            [preflightRow({
                launch_status_snapshot: {
                    basic: 'test_only',
                    standard: 'production',
                    plus: 'test_only',
                },
            }), 'standard'],
            [preflightRow({
                launch_status_snapshot: {
                    basic: 'test_only',
                    standard: 'disabled',
                    plus: 'disabled',
                },
            }), 'standard'],
        ] as Array<[AnalysisV2PreflightRow, PlanId]>) {
            expectBoundedError(
                () => validatePreflightForTestEntitlement(row, planId, { nowMs: NOW_MS }),
                'ANALYSIS_V2_PLAN_NOT_ALLOWED'
            );
        }

        expect(validatePreflightForTestEntitlement(
            preflightRow({ pricing_version: 'immutable-older-version' }),
            'standard',
            { nowMs: NOW_MS }
        ).selectedPlanId).toBe('standard');
    });

    it('requires a ready preflight, a live expiry, and an explicit valid exclusion decision', () => {
        expectBoundedError(
            () => validatePreflightForTestEntitlement(
                preflightRow({
                    status: 'pending',
                    target_followers_count: null,
                    target_following_count: null,
                    capacity_required_plan_id: null,
                    required_plan_id: null,
                }),
                'standard',
                { nowMs: NOW_MS }
            ),
            'ANALYSIS_V2_PREFLIGHT_NOT_READY'
        );
        expectBoundedError(
            () => validatePreflightForTestEntitlement(
                preflightRow({ expires_at: new Date(NOW_MS).toISOString() }),
                'standard',
                { nowMs: NOW_MS }
            ),
            'ANALYSIS_V2_PREFLIGHT_EXPIRED'
        );
        for (const row of [
            preflightRow({ exclusion_decision: null }),
            preflightRow({ exclusion_decision: 'skip', excluded_instagram_id: 'girlfriend' }),
            preflightRow({ exclusion_decision: 'exclude', excluded_instagram_id: null }),
            preflightRow({
                exclusion_decision: 'exclude',
                excluded_instagram_id: 'target.account',
            }),
        ]) {
            expectBoundedError(
                () => validatePreflightForTestEntitlement(row, 'standard', { nowMs: NOW_MS }),
                'ANALYSIS_V2_EXCLUSION_REQUIRED'
            );
        }
    });

    it('allows an internally consistent consumed row to reach the replay RPC after expiry', () => {
        expect(validatePreflightForTestEntitlement(preflightRow({
            status: 'consumed',
            expires_at: new Date(NOW_MS - 60_000).toISOString(),
            consumed_request_id: REQUEST_ID,
            pricing_version: 'superseded-after-consumption',
            capacity_required_plan_id: 'legacy-capacity',
            required_plan_id: 'legacy-required',
            launch_status_snapshot: {
                basic: 'disabled',
                standard: 'disabled',
                plus: 'disabled',
            },
        }), 'standard', { nowMs: NOW_MS })).toMatchObject({
            state: 'consumed',
        });

        expectBoundedError(
            () => validatePreflightForTestEntitlement(preflightRow({
                status: 'consumed',
                consumed_request_id: null,
            }), 'standard', { nowMs: NOW_MS }),
            'ANALYSIS_V2_PREFLIGHT_NOT_READY'
        );
    });
});

describe('test entitlement consumption RPC', () => {
    it('hashes only the nonce with a domain separator and never sends the raw credential', async () => {
        const nonce = 'abcdefghijklmnop';
        const entitlementJtiHash = hashAnalysisTestEntitlementJti(nonce);
        const { client, rpc } = clientWith([{
            request_id: REQUEST_ID,
            created: true,
            initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            request_status: 'pending',
            background_processing: false,
        }]);

        await expect(consumeAnalysisV2TestEntitlement(client, {
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            selectedPlanId: 'standard',
            entitlementJtiHash,
        })).resolves.toEqual({
            requestId: REQUEST_ID,
            created: true,
            initialJobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            requestStatus: 'pending',
            backgroundProcessing: false,
        });
        expect(entitlementJtiHash).toMatch(/^[a-f0-9]{64}$/);
        expect(entitlementJtiHash).not.toContain(nonce);
        expect(rpc).toHaveBeenCalledWith('consume_analysis_v2_test_entitlement', {
            p_preflight_id: PREFLIGHT_ID,
            p_user_id: USER_ID,
            p_selected_plan_id: 'standard',
            p_entitlement_jti_hash: entitlementJtiHash,
            p_admission_token: null,
        });
        expect(JSON.stringify(rpc.mock.calls)).not.toContain(nonce);
    });

    it('strictly accepts one created or replayed request row', async () => {
        const hash = hashAnalysisTestEntitlementJti('abcdefghijklmnop');
        const replay = clientWith([{
            request_id: REQUEST_ID,
            created: false,
            initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            request_status: 'processing',
            background_processing: true,
        }]);
        await expect(consumeAnalysisV2TestEntitlement(replay.client, {
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            selectedPlanId: 'standard',
            entitlementJtiHash: hash,
        })).resolves.toEqual({
            requestId: REQUEST_ID,
            created: false,
            initialJobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            requestStatus: 'processing',
            backgroundProcessing: true,
        });

        for (const data of [
            [],
            [{ request_id: REQUEST_ID, created: true }],
            [
                {
                    request_id: REQUEST_ID,
                    created: true,
                    initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                    request_status: 'pending',
                    background_processing: false,
                },
                {
                    request_id: REQUEST_ID,
                    created: false,
                    initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                    request_status: 'processing',
                    background_processing: true,
                },
            ],
            [{
                request_id: 'not-a-uuid',
                created: true,
                initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            }],
            [{
                request_id: REQUEST_ID,
                created: 'yes',
                initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            }],
            [{
                request_id: REQUEST_ID,
                created: true,
                initial_job_key: 'profile:target',
            }],
            [{
                request_id: REQUEST_ID,
                created: true,
                initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                request_status: 'pending',
                background_processing: false,
                leaked: 'value',
            }],
            [{
                request_id: REQUEST_ID,
                created: false,
                initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                request_status: 'queued',
                background_processing: true,
            }],
            [{
                request_id: REQUEST_ID,
                created: false,
                initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                request_status: 'completed',
                background_processing: 'no',
            }],
        ]) {
            const malformed = clientWith(data);
            await expect(consumeAnalysisV2TestEntitlement(malformed.client, {
                preflightId: PREFLIGHT_ID,
                userId: USER_ID,
                selectedPlanId: 'standard',
                entitlementJtiHash: hash,
            })).rejects.toThrow('RPC result schema is invalid');
        }
    });

    it('maps only bounded database messages and redacts arbitrary database details', async () => {
        const hash = hashAnalysisTestEntitlementJti('abcdefghijklmnop');
        const input = {
            preflightId: PREFLIGHT_ID,
            userId: USER_ID,
            selectedPlanId: 'standard' as const,
            entitlementJtiHash: hash,
        };
        for (const code of [
            'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
            'ANALYSIS_V2_PREFLIGHT_NOT_READY',
            'ANALYSIS_V2_PREFLIGHT_EXPIRED',
            'ANALYSIS_V2_EXCLUSION_REQUIRED',
            'ANALYSIS_V2_PLAN_NOT_ALLOWED',
            'ANALYSIS_V2_ENTITLEMENT_CONFLICT',
            'ANALYSIS_ALREADY_IN_PROGRESS',
        ]) {
            const bounded = clientWith(null, { code: 'P0001', message: code });
            await expect(consumeAnalysisV2TestEntitlement(bounded.client, input))
                .rejects.toMatchObject({ code });
        }

        const arbitrary = clientWith(null, {
            code: 'XX000',
            message: 'secret database detail',
        });
        await expect(consumeAnalysisV2TestEntitlement(arbitrary.client, input))
            .rejects.toThrow('request creation failed (XX000)');
        await expect(consumeAnalysisV2TestEntitlement(arbitrary.client, input))
            .rejects.not.toThrow('secret database detail');
    });
});
