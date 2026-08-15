import { describe, expect, it, vi } from 'vitest';
import type { StoredAnalysisV2ProviderRun } from './v2-provider-run-store';

const defaultRecoveryMocks = vi.hoisted(() => ({
    rpc: vi.fn(),
    from: vi.fn(),
    workerAvailable: vi.fn(),
    reconcile: vi.fn(),
    dispatch: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: {
        rpc: defaultRecoveryMocks.rpc,
        from: defaultRecoveryMocks.from,
    },
}));

vi.mock('./v2-execution-gate', () => ({
    isAnalysisV2WorkerAvailable: defaultRecoveryMocks.workerAvailable,
}));

vi.mock('./v2-provider-lifecycle', () => ({
    reconcileAnalysisV2ProviderUsage: defaultRecoveryMocks.reconcile,
}));

vi.mock('./v2-tasks', () => ({
    dispatchAnalysisV2Job: defaultRecoveryMocks.dispatch,
}));

import {
    runFirst15CanaryProviderRecovery,
    type First15CanaryProviderRecoveryCandidate,
    type First15CanaryProviderRecoveryDependencies,
    type First15CanaryProviderRecoveryRearm,
} from './first15-canary-provider-recovery';

const ORDER_A = '11111111-1111-4111-8111-111111111111';
const ORDER_B = '22222222-2222-4222-8222-222222222222';
const ORDER_C = '33333333-3333-4333-8333-333333333333';

function candidate(
    index: number,
    errorCode: First15CanaryProviderRecoveryCandidate['errorCode'],
    credentialSlot: First15CanaryProviderRecoveryCandidate['credentialSlot'] = 'senary',
): First15CanaryProviderRecoveryCandidate {
    const ids = [ORDER_A, ORDER_B, ORDER_C];
    return {
        orderId: ids[index - 1],
        requestId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        preflightId: `00000000-0000-4001-8000-${String(index).padStart(12, '0')}`,
        errorCode,
        credentialSlot,
    };
}

function providerRun(index: number): StoredAnalysisV2ProviderRun {
    return {
        requestId: candidate(index, 'SCRAPING_INCOMPLETE_ERROR').requestId,
        jobKey: 'track:relationships:collect',
        operationKey: `relationship-followers:${'a'.repeat(64)}`,
        inputHash: 'b'.repeat(64),
        reservationToken: `00000000-0000-4002-8000-${String(index).padStart(12, '0')}`,
        logicalProvider: 'apify',
        actorId: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
        credentialSlot: 'senary',
        maxChargeUsd: 1,
        status: 'succeeded',
        runId: `RunCanary${String(index).padStart(8, '0')}`,
        actualUsageUsd: null,
        reservedAt: '2026-08-15T00:00:00.000Z',
        runStartedAt: '2026-08-15T00:00:01.000Z',
        terminalizedAt: '2026-08-15T00:00:02.000Z',
        usageReconciledAt: null,
    };
}

function dependencies(
    overrides: Partial<First15CanaryProviderRecoveryDependencies> = {},
): First15CanaryProviderRecoveryDependencies {
    return {
        workerAvailable: () => true,
        loadCandidates: vi.fn(async () => [
            candidate(1, 'SCRAPING_INCOMPLETE_ERROR'),
            candidate(2, 'SCRAPING_PROVIDER_QUOTA_ERROR'),
            candidate(3, 'SCRAPING_PROVIDER_START_REJECTED_ERROR'),
        ]),
        loadRearms: vi.fn(async () => []),
        loadProviderRuns: vi.fn(async () => [
            providerRun(1), providerRun(2), providerRun(3),
        ]),
        reconcileProviderRuns: vi.fn(async runs => ({
            eligible: runs.length,
            reconciled: runs.length,
            failed: 0,
            hasMore: false,
        })),
        rearm: vi.fn(async input => ({
            applied: true,
            requestId: `00000000-0000-4003-8000-${input.orderId.slice(-12)}`,
            initialJobKey: 'coordinator:bootstrap' as const,
        })),
        dispatch: vi.fn(async () => 'enqueued'),
        ...overrides,
    };
}

describe('first15 terminal provider-canary recovery', () => {
    it('loads canary provider ledgers through their scoped service-role RPC', async () => {
        const candidates = [
            candidate(1, 'SCRAPING_INCOMPLETE_ERROR'),
            candidate(2, 'SCRAPING_PROVIDER_QUOTA_ERROR'),
            candidate(3, 'SCRAPING_PROVIDER_START_REJECTED_ERROR'),
        ];
        defaultRecoveryMocks.workerAvailable.mockReturnValue(true);
        defaultRecoveryMocks.reconcile.mockImplementation(async () => ({
            eligible: 3,
            reconciled: 3,
            failed: 0,
            hasMore: false,
        }));
        defaultRecoveryMocks.dispatch.mockResolvedValue('enqueued');
        defaultRecoveryMocks.rpc.mockImplementation(async (name: string) => {
            if (name === 'list_earlybird_first15_canary_provider_recovery_candidates') {
                return { data: candidates.map(row => ({
                    order_id: row.orderId,
                    request_id: row.requestId,
                    preflight_id: row.preflightId,
                    error_code: row.errorCode,
                    credential_slot: row.credentialSlot,
                })), error: null };
            }
            if (name === 'list_earlybird_first15_canary_provider_rearms') {
                return { data: [], error: null };
            }
            if (name === 'list_earlybird_first15_canary_provider_runs') {
                return { data: [providerRun(1), providerRun(2), providerRun(3)].map(row => ({
                    request_id: row.requestId,
                    job_key: row.jobKey,
                    operation_key: row.operationKey,
                    input_hash: row.inputHash,
                    reservation_token: row.reservationToken,
                    logical_provider: row.logicalProvider,
                    actor_id: row.actorId,
                    credential_slot: row.credentialSlot,
                    max_charge_usd: row.maxChargeUsd,
                    status: row.status,
                    run_id: row.runId,
                    actual_usage_usd: row.actualUsageUsd,
                    reserved_at: row.reservedAt,
                    run_started_at: row.runStartedAt,
                    terminalized_at: row.terminalizedAt,
                    usage_reconciled_at: row.usageReconciledAt,
                })), error: null };
            }
            if (name === 'rearm_earlybird_first15_canary_provider_failure') {
                return { data: [{
                    applied: true,
                    fulfillment_status: 'analysis_in_progress',
                    request_id: '00000000-0000-4003-8000-000000000001',
                    initial_job_key: 'coordinator:bootstrap',
                }], error: null };
            }
            throw new Error(`unexpected RPC ${name}`);
        });
        defaultRecoveryMocks.from.mockImplementation((table: string) => {
            throw new Error(`direct protected-ledger reads are forbidden: ${table}`);
        });

        await expect(runFirst15CanaryProviderRecovery()).resolves.toMatchObject({
            candidates: 3,
            reconciledProviderRuns: 3,
            rearmed: 3,
            dispatched: 3,
        });

        expect(defaultRecoveryMocks.rpc).toHaveBeenCalledWith(
            'list_earlybird_first15_canary_provider_rearms',
        );
        expect(defaultRecoveryMocks.rpc).toHaveBeenCalledWith(
            'list_earlybird_first15_canary_provider_runs',
            { p_request_ids: candidates.map(row => row.requestId) },
        );
    });

    it('accepts the two recorded gen2 receipt codes before scoped reconciliation', async () => {
        defaultRecoveryMocks.rpc.mockClear();
        defaultRecoveryMocks.reconcile.mockClear();
        defaultRecoveryMocks.dispatch.mockClear();
        const resumed = [
            candidate(1, 'SCRAPING_INCOMPLETE_ERROR', 'quinary'),
            candidate(3, 'SCRAPING_PROVIDER_START_REJECTED_ERROR', 'quinary'),
        ];
        const rawRearms = [
            {
                order_id: ORDER_A,
                rearmed_preflight_id: '00000000-0000-4010-8000-000000000001',
                rearm_generation: 1,
                source_failure_code: 'SCRAPING_INCOMPLETE_ERROR',
            },
            {
                order_id: ORDER_B,
                rearmed_preflight_id: '00000000-0000-4010-8000-000000000002',
                rearm_generation: 1,
                source_failure_code: 'SCRAPING_PROVIDER_QUOTA_ERROR',
            },
            {
                order_id: ORDER_C,
                rearmed_preflight_id: '00000000-0000-4010-8000-000000000003',
                rearm_generation: 1,
                source_failure_code: 'SCRAPING_PROVIDER_START_REJECTED_ERROR',
            },
            {
                order_id: ORDER_A,
                rearmed_preflight_id: resumed[0].preflightId,
                rearm_generation: 2,
                source_failure_code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            },
            {
                order_id: ORDER_B,
                rearmed_preflight_id: '00000000-0000-4011-8000-000000000002',
                rearm_generation: 2,
                source_failure_code: 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR',
            },
            {
                order_id: ORDER_C,
                rearmed_preflight_id: resumed[1].preflightId,
                rearm_generation: 2,
                source_failure_code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            },
        ];
        const rawRuns = [
            providerRun(1),
            { ...providerRun(1), operationKey: `relationship-following:${'c'.repeat(64)}` },
            providerRun(3),
            { ...providerRun(3), operationKey: `target-likers:${'d'.repeat(64)}` },
            { ...providerRun(3), operationKey: `target-comments:${'e'.repeat(64)}` },
        ].map(run => ({
            request_id: run.requestId,
            job_key: run.jobKey,
            operation_key: run.operationKey,
            input_hash: run.inputHash,
            reservation_token: run.reservationToken,
            logical_provider: run.logicalProvider,
            actor_id: run.actorId,
            credential_slot: 'quinary',
            max_charge_usd: run.maxChargeUsd,
            status: run.status,
            run_id: run.runId,
            actual_usage_usd: run.actualUsageUsd,
            reserved_at: run.reservedAt,
            run_started_at: run.runStartedAt,
            terminalized_at: run.terminalizedAt,
            usage_reconciled_at: run.usageReconciledAt,
        }));

        defaultRecoveryMocks.workerAvailable.mockReturnValue(true);
        defaultRecoveryMocks.reconcile.mockResolvedValue({
            eligible: rawRuns.length,
            reconciled: rawRuns.length,
            failed: 0,
            hasMore: false,
        });
        defaultRecoveryMocks.dispatch.mockResolvedValue('enqueued');
        defaultRecoveryMocks.rpc.mockImplementation(async (name: string) => {
            if (name === 'list_earlybird_first15_canary_provider_recovery_candidates') {
                return { data: resumed.map(row => ({
                    order_id: row.orderId,
                    request_id: row.requestId,
                    preflight_id: row.preflightId,
                    error_code: row.errorCode,
                    credential_slot: row.credentialSlot,
                })), error: null };
            }
            if (name === 'list_earlybird_first15_canary_provider_rearms') {
                return { data: rawRearms, error: null };
            }
            if (name === 'list_earlybird_first15_canary_provider_runs') {
                return { data: rawRuns, error: null };
            }
            if (name === 'rearm_earlybird_first15_canary_provider_failure') {
                return { data: null, error: { message: 'readiness rejected' } };
            }
            throw new Error(`unexpected RPC ${name}`);
        });

        await expect(runFirst15CanaryProviderRecovery()).rejects.toThrow(
            'FIRST15_CANARY_RECOVERY_REARM_FAILED',
        );
        expect(defaultRecoveryMocks.reconcile).toHaveBeenCalledOnce();
        expect(defaultRecoveryMocks.rpc).toHaveBeenCalledWith(
            'list_earlybird_first15_canary_provider_runs',
            { p_request_ids: resumed.map(row => row.requestId) },
        );
        expect(defaultRecoveryMocks.dispatch).not.toHaveBeenCalled();
    });

    it('reconciles only the three source ledgers, then rearms them on tertiary sequentially', async () => {
        const deps = dependencies();

        await expect(runFirst15CanaryProviderRecovery(deps)).resolves.toEqual({
            candidates: 3,
            reconciledProviderRuns: 3,
            rearmed: 3,
            dispatched: 3,
        });

        expect(deps.loadProviderRuns).toHaveBeenCalledWith([
            candidate(1, 'SCRAPING_INCOMPLETE_ERROR').requestId,
            candidate(2, 'SCRAPING_PROVIDER_QUOTA_ERROR').requestId,
            candidate(3, 'SCRAPING_PROVIDER_START_REJECTED_ERROR').requestId,
        ]);
        expect(deps.rearm).toHaveBeenCalledWith(expect.objectContaining({
            orderId: ORDER_A,
            fallbackCredentialSlot: 'tertiary',
        }));
        expect(deps.rearm).toHaveBeenCalledWith(expect.objectContaining({
            orderId: ORDER_B,
            fallbackCredentialSlot: 'tertiary',
        }));
        expect(deps.rearm).toHaveBeenCalledWith(expect.objectContaining({
            orderId: ORDER_C,
            fallbackCredentialSlot: 'tertiary',
        }));
        expect(deps.dispatch).toHaveBeenCalledTimes(3);
    });

    it('fails closed before provider access when the initial cohort is not the exact three errors', async () => {
        const deps = dependencies({
            loadCandidates: vi.fn(async () => [
                candidate(1, 'SCRAPING_INCOMPLETE_ERROR'),
                candidate(2, 'SCRAPING_PROVIDER_QUOTA_ERROR'),
            ]),
        });

        await expect(runFirst15CanaryProviderRecovery(deps)).rejects.toThrow(
            'FIRST15_CANARY_RECOVERY_INITIAL_SCOPE_MISMATCH',
        );
        expect(deps.loadProviderRuns).not.toHaveBeenCalled();
        expect(deps.rearm).not.toHaveBeenCalled();
    });

    it('continues only a recorded canary lineage with the next ordered free-account fallback', async () => {
        const resumed = candidate(
            1,
            'SCRAPING_PROVIDER_QUOTA_ERROR',
            'tertiary',
        );
        const deps = dependencies({
            loadCandidates: vi.fn(async () => [resumed]),
            loadRearms: vi.fn(async (): Promise<readonly First15CanaryProviderRecoveryRearm[]> => [
                {
                    orderId: resumed.orderId,
                    rearmedPreflightId: resumed.preflightId,
                    rearmGeneration: 1,
                    sourceFailureCode: 'SCRAPING_PROVIDER_QUOTA_ERROR',
                },
                {
                    orderId: ORDER_B,
                    rearmedPreflightId: '00000000-0000-4004-8000-000000000002',
                    rearmGeneration: 1,
                    sourceFailureCode: 'SCRAPING_INCOMPLETE_ERROR',
                },
                {
                    orderId: ORDER_C,
                    rearmedPreflightId: '00000000-0000-4004-8000-000000000003',
                    rearmGeneration: 1,
                    sourceFailureCode: 'SCRAPING_PROVIDER_START_REJECTED_ERROR',
                },
            ]),
            loadProviderRuns: vi.fn(async () => [providerRun(1)]),
        });

        await expect(runFirst15CanaryProviderRecovery(deps)).resolves.toEqual({
            candidates: 1,
            reconciledProviderRuns: 1,
            rearmed: 1,
            dispatched: 1,
        });
        expect(deps.rearm).toHaveBeenCalledWith(expect.objectContaining({
            fallbackCredentialSlot: 'quinary',
        }));
    });

    it('uses the existing route contract for all three recorded tertiary successors', async () => {
        const resumed = [
            candidate(1, 'SCRAPING_INCOMPLETE_ERROR', 'tertiary'),
            candidate(2, 'SCRAPING_PROVIDER_QUOTA_ERROR', 'tertiary'),
            candidate(3, 'SCRAPING_PROVIDER_START_REJECTED_ERROR', 'tertiary'),
        ];
        const deps = dependencies({
            loadCandidates: vi.fn(async () => resumed),
            loadRearms: vi.fn(async (): Promise<readonly First15CanaryProviderRecoveryRearm[]> => (
                resumed.map((row, index) => ({
                    orderId: row.orderId,
                    rearmedPreflightId: row.preflightId,
                    rearmGeneration: 1,
                    sourceFailureCode: [
                        'SCRAPING_INCOMPLETE_ERROR',
                        'SCRAPING_PROVIDER_QUOTA_ERROR',
                        'SCRAPING_PROVIDER_START_REJECTED_ERROR',
                    ][index] as First15CanaryProviderRecoveryRearm['sourceFailureCode'],
                }))
            )),
            loadProviderRuns: vi.fn(async () => [providerRun(2)]),
        });

        await expect(runFirst15CanaryProviderRecovery(deps)).resolves.toEqual({
            candidates: 3,
            reconciledProviderRuns: 1,
            rearmed: 3,
            dispatched: 3,
        });
        expect(deps.loadProviderRuns).toHaveBeenCalledWith(resumed.map(row => row.requestId));
        expect(deps.rearm).toHaveBeenCalledTimes(3);
        expect(deps.rearm).toHaveBeenNthCalledWith(1, expect.objectContaining({
            orderId: ORDER_A,
            fallbackCredentialSlot: 'quinary',
        }));
        expect(deps.rearm).toHaveBeenNthCalledWith(2, expect.objectContaining({
            orderId: ORDER_B,
            fallbackCredentialSlot: 'quinary',
        }));
        expect(deps.rearm).toHaveBeenNthCalledWith(3, expect.objectContaining({
            orderId: ORDER_C,
            fallbackCredentialSlot: 'quinary',
        }));
    });

    it('does not rearm while a scoped provider run is still active', async () => {
        const active = providerRun(1);
        active.status = 'running';
        active.terminalizedAt = null;
        const deps = dependencies({
            loadProviderRuns: vi.fn(async () => [active]),
        });

        await expect(runFirst15CanaryProviderRecovery(deps)).rejects.toThrow(
            'FIRST15_CANARY_RECOVERY_ACTIVE_PROVIDER_RUNS',
        );
        expect(deps.reconcileProviderRuns).not.toHaveBeenCalled();
        expect(deps.rearm).not.toHaveBeenCalled();
    });

    it('reports a source-slot authentication blocker without rearming any canary', async () => {
        const reconcileProviderRuns = vi.fn(async (...args: unknown[]) => {
            const runs = args[0] as readonly StoredAnalysisV2ProviderRun[];
            const report = args[1] as undefined | ((failure: {
                credentialSlot: 'senary';
                reason: 'provider_auth_failed';
            }) => void);
            report?.({ credentialSlot: 'senary', reason: 'provider_auth_failed' });
            return {
                eligible: runs.length,
                reconciled: 0,
                failed: runs.length,
                hasMore: false,
            };
        });
        const deps = dependencies({ reconcileProviderRuns });

        await expect(runFirst15CanaryProviderRecovery(deps)).rejects.toThrow(
            'FIRST15_CANARY_RECOVERY_SENARY_PROVIDER_AUTH_FAILED',
        );

        expect(reconcileProviderRuns).toHaveBeenCalledWith(
            expect.any(Array),
            expect.any(Function),
        );
        expect(deps.rearm).not.toHaveBeenCalled();
        expect(deps.dispatch).not.toHaveBeenCalled();
    });
});
