import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    AnalysisV2ProviderRunAlreadyReservedError,
    AnalysisV2ProviderRunConflictError,
    AnalysisV2ProviderRunFenceError,
    ANALYSIS_V2_PROVIDER_OPERATION_KINDS,
    ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES,
    OPERATION_KEY_PATTERN,
    analysisV2ProviderInputHash,
    analysisV2ProviderOperationKey,
    createAnalysisV2ProviderRunStore,
    type AnalysisV2ProviderRunReservationInput,
    type AnalysisV2ProviderRunSupabaseClient,
} from './v2-provider-run-store';

// gitleaks:allow -- deterministic UUID fixtures
const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const reservationToken = '33333333-3333-4333-8333-333333333333';
const runId = 'AbCdEfGh12345678';
const jobKey = 'track:relationships:collect';
const inputHash = 'a'.repeat(64);
const operationKey = analysisV2ProviderOperationKey(
    'relationship-followers',
    `${requestId}\nfollowers\n0_min._.00`
);

const identity: AnalysisV2ProviderRunReservationInput = {
    requestId,
    jobKey,
    claimToken,
    operationKey,
    inputHash,
    logicalProvider: 'apify',
    actorId: 'scraping_solutions/instagram-scraper-followers-following-no-cookies',
    credentialSlot: 'primary',
    maxChargeUsd: 0.40205,
};

function storedRow(
    status: 'starting' | 'running' | 'rejected' | 'succeeded' | 'failed' | 'aborted' | 'timed_out',
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const hasRun = !['starting', 'rejected'].includes(status);
    const terminal = !['starting', 'running'].includes(status);
    return {
        requestId,
        jobKey,
        operationKey,
        inputHash,
        reservationToken,
        logicalProvider: 'apify',
        actorId: identity.actorId,
        credentialSlot: 'primary',
        maxChargeUsd: 0.40205,
        status,
        runId: hasRun ? runId : null,
        actualUsageUsd: status === 'rejected' ? 0 : null,
        reservedAt: '2026-07-13T17:20:00.000Z',
        runStartedAt: hasRun ? '2026-07-13T17:20:01.000Z' : null,
        terminalizedAt: terminal ? '2026-07-13T17:20:30.000Z' : null,
        usageReconciledAt: status === 'rejected'
            ? '2026-07-13T17:20:30.000Z'
            : null,
        ...overrides,
    };
}

function reservationResponse(
    created: boolean,
    run: Record<string, unknown>
): Record<string, unknown> {
    return { created, run };
}

function createdReservationFromParams(params: Record<string, unknown>) {
    return Promise.resolve({
        data: reservationResponse(
            true,
            storedRow('starting', {
                reservationToken: params.p_reservation_token,
                credentialSlot: params.p_credential_slot,
            })
        ),
        error: null,
    });
}

function clientWithRpc() {
    const rpc = vi.fn();
    return {
        rpc,
        client: { rpc } as AnalysisV2ProviderRunSupabaseClient,
    };
}

describe('analysis V2 provider run store', () => {
    it('builds deterministic domain-separated operation keys without leaking usernames', () => {
        const first = analysisV2ProviderOperationKey(
            'profile-fallback',
            'batch=3\nusername=0_min._.00'
        );
        const replay = analysisV2ProviderOperationKey(
            'profile-fallback',
            'batch=3\nusername=0_min._.00'
        );
        const otherKind = analysisV2ProviderOperationKey(
            'target-profile',
            'batch=3\nusername=0_min._.00'
        );

        expect(first).toBe(replay);
        expect(first).toMatch(/^profile-fallback:[0-9a-f]{64}$/);
        expect(first).not.toContain('0_min._.00');
        expect(first).not.toBe(otherKind);
        expect(analysisV2ProviderInputHash('{"username":"0_min._.00"}'))
            .toMatch(/^[0-9a-f]{64}$/);
    });

    it('registers profile-repair as a bounded operation kind inside the stored key window', () => {
        expect(ANALYSIS_V2_PROVIDER_OPERATION_KINDS).toContain('profile-repair');

        const key = analysisV2ProviderOperationKey(
            'profile-repair',
            `batch=3\nusername=0_min._.00`
        );
        const replay = analysisV2ProviderOperationKey(
            'profile-repair',
            `batch=3\nusername=0_min._.00`
        );

        expect(key).toBe(replay);
        expect(key).toHaveLength(79);
        expect(key).toMatch(/^profile-repair:[0-9a-f]{64}$/);
        expect(OPERATION_KEY_PATTERN.test(key)).toBe(true);
        expect(key).not.toContain('0_min._.00');
        // 'profile-fallback' shares no digest with 'profile-repair' for the same identity.
        expect(key).not.toBe(analysisV2ProviderOperationKey(
            'profile-fallback',
            `batch=3\nusername=0_min._.00`
        ));
    });

    it('reserves a bounded immutable identity with a proposed UUID fence', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockImplementationOnce((_name, params) => createdReservationFromParams(params));
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.reserve(identity)).resolves.toMatchObject({
            created: true,
            run: {
                status: 'starting',
                operationKey,
                inputHash,
            },
        });

        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: jobKey,
                p_claim_token: claimToken,
                p_operation_key: operationKey,
                p_input_hash: inputHash,
                p_logical_provider: 'apify',
                p_actor_id: identity.actorId,
                p_credential_slot: 'primary',
                p_max_charge_usd: 0.40205,
                p_reservation_token: expect.stringMatching(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                ),
            })
        );
    });

    it('preserves an explicitly selected extended V2 credential slot', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockImplementationOnce((_name, params) => createdReservationFromParams(params));
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.reserve({
            ...identity,
            credentialSlot: 'quinary',
        })).resolves.toMatchObject({
            run: { credentialSlot: 'quinary' },
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
            expect.objectContaining({ p_credential_slot: 'quinary' })
        );
    });

    it('exposes the selected provider identity before a new Actor start', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({ data: null, error: null });
        const store = createAnalysisV2ProviderRunStore(client);

        const binding = await store.bindAdapterCheckpoint({
            ...identity,
            credentialSlot: 'quinary',
        });

        expect(binding.stored).toBeNull();
        expect(binding.checkpoint).toMatchObject({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'quinary',
            maxChargeUsd: 0.40205,
        });
        expect(binding.checkpoint.onBeforeRunStart).toEqual(expect.any(Function));
        expect(rpc).toHaveBeenCalledTimes(1);
    });

    it('rejects a created reservation that does not echo the proposed token', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: reservationResponse(true, storedRow('starting')),
            error: null,
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.reserve(identity)).rejects.toThrow('invalid new reservation');
    });

    it('never authorizes a new Actor start when another caller won the reservation race', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({
                data: reservationResponse(false, storedRow('starting')),
                error: null,
            });
        const store = createAnalysisV2ProviderRunStore(client);
        const binding = await store.bindAdapterCheckpoint(identity);

        await expect(binding.checkpoint.onBeforeRunStart?.({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
        })).rejects.toBeInstanceOf(AnalysisV2ProviderRunAlreadyReservedError);
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('connects a new reservation, run checkpoint, and terminal fence to adapter callbacks', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockImplementationOnce((_name, params) => createdReservationFromParams(params))
            .mockImplementationOnce((_name, params) => Promise.resolve({
                data: storedRow('running', {
                    reservationToken: params.p_reservation_token,
                }),
                error: null,
            }))
            .mockImplementationOnce((_name, params) => Promise.resolve({
                data: storedRow('succeeded', {
                    reservationToken: params.p_reservation_token,
                    actualUsageUsd: 0.401,
                    usageReconciledAt: '2026-07-13T17:20:30.000Z',
                }),
                error: null,
            }));
        const store = createAnalysisV2ProviderRunStore(client);
        const binding = await store.bindAdapterCheckpoint(identity);

        expect(binding.stored).toBeNull();
        expect(binding.checkpoint.startReserved).toBeUndefined();
        await binding.checkpoint.onBeforeRunStart?.({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
        });
        await binding.checkpoint.onRunStarted?.(runId);
        await binding.checkpoint.onCostRunStarted?.({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
            runId,
        });
        await binding.checkpoint.onCostRunFinished?.({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
            runId,
            status: 'succeeded',
            usageTotalUsd: 0.401,
        });

        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.startedRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.terminalRpc,
        ]);
        expect(rpc.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
            p_reservation_token: expect.stringMatching(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            ),
            p_run_id: runId,
        }));
        expect(rpc.mock.calls[3]?.[1]).toEqual(expect.objectContaining({
            p_claim_token: claimToken,
            p_status: 'succeeded',
            p_actual_usage_usd: 0.401,
        }));
    });

    it('persists a definite start rejection against the exact reservation fence', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: null, error: null })
            .mockImplementationOnce((_name, params) => createdReservationFromParams(params))
            .mockImplementationOnce((_name, params) => Promise.resolve({
                data: storedRow('rejected', {
                    reservationToken: params.p_reservation_token,
                }),
                error: null,
            }));
        const store = createAnalysisV2ProviderRunStore(client);
        const binding = await store.bindAdapterCheckpoint(identity);

        await binding.checkpoint.onBeforeRunStart?.({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
        });
        await binding.checkpoint.onRunStartRejected?.({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
            statusCode: 402,
            errorType: 'usage-limit-exceeded',
        });

        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.rejectedRpc,
        ]);
        expect(rpc.mock.calls[2]?.[1]).toEqual({
            p_request_id: requestId,
            p_job_key: jobKey,
            p_claim_token: claimToken,
            p_operation_key: operationKey,
            p_input_hash: inputHash,
            p_reservation_token: expect.stringMatching(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            ),
            p_logical_provider: 'apify',
            p_actor_id: identity.actorId,
            p_credential_slot: 'primary',
            p_max_charge_usd: 0.40205,
        });
    });

    it('rebinds a stored running run and resumes the exact run ID', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: storedRow('running'), error: null })
            .mockResolvedValueOnce({
                data: reservationResponse(false, storedRow('running')),
                error: null,
            });
        const store = createAnalysisV2ProviderRunStore(client);

        const binding = await store.bindAdapterCheckpoint(identity);

        expect(binding.stored?.status).toBe('running');
        expect(binding.checkpoint).toMatchObject({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
            resumeRunId: runId,
        });
        expect(binding.checkpoint.startReserved).toBeUndefined();
        expect(binding.checkpoint.onBeforeRunStart).toBeUndefined();
        expect(rpc.mock.calls.map(([name]) => name)).toEqual([
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.loadRpc,
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reserveRpc,
        ]);
    });

    it('uses startReserved only for an existing intent without a run ID', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: storedRow('starting'), error: null })
            .mockResolvedValueOnce({
                data: reservationResponse(false, storedRow('starting')),
                error: null,
            });
        const store = createAnalysisV2ProviderRunStore(client);

        const binding = await store.bindAdapterCheckpoint(identity);
        expect(binding.checkpoint.startReserved).toBe(true);
        expect(binding.checkpoint.resumeRunId).toBeUndefined();
        expect(binding.checkpoint.onBeforeRunStart).toBeUndefined();
        expect(binding.checkpoint.onRunStarted).toBeUndefined();
        expect(rpc).toHaveBeenCalledTimes(2);
    });

    it('resumes a terminal run so a lost response can rebuild output without another Actor start', async () => {
        const { rpc, client } = clientWithRpc();
        rpc
            .mockResolvedValueOnce({ data: storedRow('succeeded'), error: null })
            .mockResolvedValueOnce({
                data: reservationResponse(false, storedRow('succeeded')),
                error: null,
            })
            .mockResolvedValueOnce({ data: storedRow('succeeded'), error: null });
        const store = createAnalysisV2ProviderRunStore(client);
        const binding = await store.bindAdapterCheckpoint(identity);

        expect(binding.checkpoint.resumeRunId).toBe(runId);
        await binding.checkpoint.onCostRunFinished?.({
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
            runId,
            status: 'succeeded',
            usageTotalUsd: null,
        });
        expect(rpc).toHaveBeenLastCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.terminalRpc,
            expect.objectContaining({ p_actual_usage_usd: null })
        );
    });

    it('maps a stale claim to a typed fence error without exposing database text', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: null,
            error: {
                code: 'P0001',
                message: 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH',
            },
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.reserve(identity)).rejects.toBeInstanceOf(
            AnalysisV2ProviderRunFenceError
        );
    });

    it('preserves the bounded authorized-policy slot mismatch for diagnosis', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: null,
            error: {
                code: 'P0001',
                message: 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH',
            },
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.reserve(identity)).rejects.toThrow(
            'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH'
        );
    });

    it('rejects a replay whose stored immutable identity changed', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: reservationResponse(
                false,
                storedRow('starting', { actorId: 'other/actor' })
            ),
            error: null,
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.reserve(identity)).rejects.toBeInstanceOf(
            AnalysisV2ProviderRunConflictError
        );
    });

    it('accepts one concrete terminal usage reconciliation and validates the response', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: storedRow('succeeded', {
                actualUsageUsd: '0.402050000000',
                usageReconciledAt: '2026-07-13T17:21:00.000Z',
            }),
            error: null,
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.checkpointTerminal({
            ...identity,
            reservationToken,
            runId,
            status: 'succeeded',
            actualUsageUsd: 0.40205,
        })).resolves.toMatchObject({
            status: 'succeeded',
            actualUsageUsd: 0.40205,
        });
    });

    it('lists a bounded set of terminal runs awaiting authenticated usage', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({ data: [storedRow('succeeded')], error: null });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.listUnreconciled(12)).resolves.toEqual([
            expect.objectContaining({
                reservationToken,
                runId,
                status: 'succeeded',
                actualUsageUsd: null,
            }),
        ]);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.listUnreconciledRpc,
            { p_limit: 12 }
        );
    });

    it('reconciles usage without a live job claim behind the immutable run fences', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: storedRow('succeeded', {
                actualUsageUsd: '0.401000000000',
                usageReconciledAt: '2026-07-13T17:21:00.000Z',
            }),
            error: null,
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.reconcileUsage({
            reservationToken,
            runId,
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
            status: 'succeeded',
            actualUsageUsd: 0.401,
        })).resolves.toMatchObject({
            reservationToken,
            runId,
            status: 'succeeded',
            actualUsageUsd: 0.401,
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.reconcileUsageRpc,
            {
                p_reservation_token: reservationToken,
                p_run_id: runId,
                p_logical_provider: 'apify',
                p_actor_id: identity.actorId,
                p_credential_slot: 'primary',
                p_max_charge_usd: 0.40205,
                p_status: 'succeeded',
                p_actual_usage_usd: 0.401,
            }
        );
    });

    it('persists an exact terminal-cleanup intent before remote Actor actions', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({ data: true, error: null });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.requestCleanup({
            requestId,
            jobKey,
            claimToken,
            jobInputHash: inputHash,
            errorCode: 'JOB_ATTEMPTS_EXHAUSTED',
        })).resolves.toBeUndefined();
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.requestCleanupRpc,
            {
                p_request_id: requestId,
                p_job_key: jobKey,
                p_claim_token: claimToken,
                p_job_input_hash: inputHash,
                p_error_code: 'JOB_ATTEMPTS_EXHAUSTED',
            }
        );
    });

    it('loads the original incomplete cleanup identity for retry convergence', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: {
                requestId,
                jobKey,
                jobInputHash: inputHash,
                errorCode: 'ORIGINAL_PROVIDER_FAILURE',
            },
            error: null,
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.loadCleanupIntent(requestId)).resolves.toEqual({
            requestId,
            jobKey,
            jobInputHash: inputHash,
            errorCode: 'ORIGINAL_PROVIDER_FAILURE',
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.loadCleanupIntentRpc,
            { p_request_id: requestId }
        );
    });

    it('preserves the typed cleanup freeze when a sibling tries to reserve paid work', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: null,
            error: {
                code: 'P0001',
                message: 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
            },
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.reserve(identity)).rejects.toThrow(
            'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED'
        );
    });

    it('lists confirmed cleanup runs separately from unconfirmed starts', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: { startingCount: 2, runs: [storedRow('running')] },
            error: null,
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.listActiveForCleanup({ requestId, limit: 12 }))
            .resolves.toEqual({
                startingCount: 2,
                runs: [expect.objectContaining({ runId, status: 'running' })],
            });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.listActiveCleanupRpc,
            { p_request_id: requestId, p_limit: 12 }
        );
    });

    it('seals a cleanup-confirmed terminal run without a live claim', async () => {
        const { rpc, client } = clientWithRpc();
        rpc.mockResolvedValueOnce({
            data: storedRow('aborted'),
            error: null,
        });
        const store = createAnalysisV2ProviderRunStore(client);

        await expect(store.settleForCleanup({
            reservationToken,
            runId,
            logicalProvider: 'apify',
            actorId: identity.actorId,
            credentialSlot: 'primary',
            maxChargeUsd: 0.40205,
            status: 'aborted',
            actualUsageUsd: null,
        })).resolves.toMatchObject({ status: 'aborted', actualUsageUsd: null });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_PROVIDER_RUN_DATABASE_NAMES.settleCleanupRpc,
            {
                p_reservation_token: reservationToken,
                p_run_id: runId,
                p_logical_provider: 'apify',
                p_actor_id: identity.actorId,
                p_credential_slot: 'primary',
                p_max_charge_usd: 0.40205,
                p_status: 'aborted',
                p_actual_usage_usd: null,
            }
        );
    });
});
