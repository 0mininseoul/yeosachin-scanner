import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_DATABASE_NAMES,
    AnalysisV2JobDispatchNotReadyError,
    AnalysisV2JobFenceError,
    AnalysisV2JobLeaseBusyError,
    createSupabaseAnalysisV2JobStore,
    type AnalysisV2JobDispatchReservation,
    type AnalysisV2JobSupabaseClient,
    type ClaimedAnalysisV2Job,
} from './v2-job-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const jobKey = 'coordinator:bootstrap';
const inputHash = 'a'.repeat(64);
const taskName = 'projects/example-project/locations/asia-northeast3/queues/analysis-v2/tasks/'
    + 'analysis-v2-123e4567-e89b-42d3-a456-426614174000-abcdef0123456789abcdef01-g1';

function rpcClient(rpc: ReturnType<typeof vi.fn>): AnalysisV2JobSupabaseClient {
    return { rpc };
}

function reservation(
    dispatchFence = randomUUID()
): AnalysisV2JobDispatchReservation & { reservationToken: string; taskName: string } {
    return {
        requestId,
        jobKey,
        reserved: true,
        generation: 1,
        reservationToken: dispatchFence,
        status: 'pending',
        dispatchState: 'reserved',
        taskName,
    };
}

function claimedJob(): ClaimedAnalysisV2Job {
    return {
        requestId,
        jobKey,
        track: 'coordinator',
        kind: 'bootstrap',
        batch: null,
        inputHash,
        generation: 1,
        reservationToken: randomUUID(),
        claimToken: randomUUID(),
        attemptCount: 1,
    };
}

describe('analysis V2 job store', () => {
    it('reserves a deterministic dispatch generation through the service RPC', async () => {
        const dispatchFence = randomUUID();
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                reserved: true,
                dispatch_generation: 1,
                reservation_token: dispatchFence,
                job_status: 'pending',
                dispatch_state: 'reserved',
                task_name: null,
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.reserveDispatch({ requestId, jobKey })).resolves.toEqual({
            requestId,
            jobKey,
            reserved: true,
            generation: 1,
            reservationToken: dispatchFence,
            status: 'pending',
            dispatchState: 'reserved',
            taskName: null,
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DATABASE_NAMES.reserveDispatchRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: jobKey,
                p_dispatch_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
            })
        );
    });

    it('rearms only the exact generation and reservation fence', async () => {
        const previousFence = randomUUID();
        const nextFence = randomUUID();
        const rpc = vi.fn().mockImplementation(async (_name, params) => ({
            data: [{
                rearmed: true,
                dispatch_generation: 2,
                reservation_token: params.p_new_dispatch_token ?? nextFence,
                job_status: 'pending',
                dispatch_state: 'reserved',
            }],
            error: null,
        }));
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        const result = await store.rearmDispatch({
            requestId,
            jobKey,
            expectedGeneration: 1,
            expectedReservationToken: previousFence,
        });
        expect(result).toMatchObject({
            requestId,
            jobKey,
            reserved: true,
            generation: 2,
            dispatchState: 'reserved',
        });
        expect(rpc).toHaveBeenCalledWith(ANALYSIS_V2_DATABASE_NAMES.rearmDispatchRpc, {
            p_request_id: requestId,
            p_job_key: jobKey,
            p_expected_generation: 1,
            p_expected_dispatch_token: previousFence,
            p_new_dispatch_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
        });
    });

    it('rejects a failed rearm fence instead of rotating again', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                rearmed: false,
                dispatch_generation: 1,
                reservation_token: randomUUID(),
                job_status: 'pending',
                dispatch_state: 'enqueued',
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.rearmDispatch({
            requestId,
            jobKey,
            expectedGeneration: 1,
            expectedReservationToken: randomUUID(),
        })).rejects.toBeInstanceOf(AnalysisV2JobFenceError);
    });

    it('durably defers only the exact task-present recovery fence', async () => {
        const dispatchFence = randomUUID();
        const leaseExpiresAt = '2026-07-14T01:02:03Z';
        const rpc = vi.fn().mockResolvedValue({ data: true, error: null });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.deferRecovery({
            requestId,
            jobKey,
            expectedGeneration: 2,
            expectedReservationToken: dispatchFence,
            expectedStatus: 'processing',
            expectedLeaseExpiresAt: leaseExpiresAt,
        })).resolves.toBe(true);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DATABASE_NAMES.deferRecoveryRpc,
            {
                p_request_id: requestId,
                p_job_key: jobKey,
                p_dispatch_generation: 2,
                p_dispatch_token: dispatchFence,
                p_expected_status: 'processing',
                p_expected_lease_expires_at: leaseExpiresAt,
            }
        );
        await expect(store.deferRecovery({
            requestId,
            jobKey,
            expectedGeneration: 2,
            expectedReservationToken: dispatchFence,
            expectedStatus: 'pending',
            expectedLeaseExpiresAt: leaseExpiresAt,
        })).rejects.toThrow('invalid recovery lease');
    });

    it('marks the exact task name only after queue acceptance', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                marked: true,
                job_status: 'pending',
                dispatch_state: 'enqueued',
                task_name: taskName,
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));
        const dispatch = reservation();

        await expect(store.markDispatched(dispatch)).resolves.toBeUndefined();
        expect(rpc).toHaveBeenCalledWith(ANALYSIS_V2_DATABASE_NAMES.markDispatchedRpc, {
            p_request_id: requestId,
            p_job_key: jobKey,
            p_dispatch_generation: 1,
            p_dispatch_token: dispatch.reservationToken,
            p_task_name: taskName,
        });
    });

    it('accepts an idempotent mark response after the task has already claimed', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                marked: true,
                job_status: 'processing',
                dispatch_state: 'delivered',
                task_name: taskName,
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.markDispatched(reservation())).resolves.toBeUndefined();
    });

    it('claims with both generation and reservation fences and maps nullable batch', async () => {
        const dispatchFence = randomUUID();
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                claimed: true,
                job_status: 'processing',
                attempt_count: 2,
                lease_expires_at: '2026-07-14T01:02:03Z',
                track: 'coordinator',
                job_kind: 'bootstrap',
                batch: null,
                input_hash: inputHash,
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        const claim = await store.claim({
            requestId,
            jobKey,
            generation: 1,
            reservationToken: dispatchFence,
        });
        expect(claim).toMatchObject({
            requestId,
            jobKey,
            track: 'coordinator',
            kind: 'bootstrap',
            batch: null,
            attemptCount: 2,
            reservationToken: dispatchFence,
        });
        expect(rpc).toHaveBeenCalledWith(ANALYSIS_V2_DATABASE_NAMES.claimRpc, {
            p_request_id: requestId,
            p_job_key: jobKey,
            p_dispatch_generation: 1,
            p_dispatch_token: dispatchFence,
            p_claim_token: expect.stringMatching(/^[0-9a-f-]{36}$/),
            p_lease_seconds: 360,
            p_max_attempts: 7,
        });
    });

    it('rejects false dispatch acknowledgements and non-completed fanout results', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: [{
                    marked: false,
                    job_status: 'pending',
                    dispatch_state: 'enqueued',
                    task_name: taskName,
                }],
                error: null,
            })
            .mockResolvedValueOnce({
                data: [{
                    request_id: requestId,
                    completed: true,
                    job_status: 'processing',
                    dispatchable_job_keys: [],
                }],
                error: null,
            });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.markDispatched(reservation()))
            .rejects.toThrow('invalid dispatch mark');
        await expect(store.completeAndFanout(claimedJob(), []))
            .rejects.toThrow('invalid completion status');
    });

    it('distinguishes a busy lease from a terminal idempotent delivery', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: [{ claimed: false, job_status: 'processing' }],
                error: null,
            })
            .mockResolvedValueOnce({
                data: [{ claimed: false, job_status: 'completed' }],
                error: null,
            });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));
        const delivery = {
            requestId,
            jobKey,
            generation: 1,
            reservationToken: randomUUID(),
        };

        await expect(store.claim(delivery)).rejects.toBeInstanceOf(
            AnalysisV2JobLeaseBusyError
        );
        await expect(store.claim(delivery)).resolves.toBeNull();
    });

    it('distinguishes an early same-generation delivery from a stale fence', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'P0001', message: 'ANALYSIS_V2_JOB_DISPATCH_NOT_READY' },
            })
            .mockResolvedValueOnce({
                data: null,
                error: { code: 'P0001', message: 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH' },
            });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));
        const delivery = {
            requestId,
            jobKey,
            generation: 1,
            reservationToken: randomUUID(),
        };

        await expect(store.claim(delivery)).rejects.toBeInstanceOf(
            AnalysisV2JobDispatchNotReadyError
        );
        await expect(store.claim(delivery)).rejects.toBeInstanceOf(
            AnalysisV2JobFenceError
        );
    });

    it('releases retryable failures with a bounded public error code', async () => {
        const job = claimedJob();
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                released: true,
                job_status: 'pending',
                attempt_count: 1,
                request_status: 'processing',
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.releaseClaim(job, {
            errorCode: 'UPSTREAM_TIMEOUT',
            retryable: true,
        })).resolves.toEqual({
            released: true,
            status: 'pending',
            attemptCount: 1,
            requestStatus: 'processing',
        });
        expect(rpc).toHaveBeenCalledWith(ANALYSIS_V2_DATABASE_NAMES.releaseClaimRpc, {
            p_request_id: requestId,
            p_job_key: jobKey,
            p_claim_token: job.claimToken,
            p_error_code: 'UPSTREAM_TIMEOUT',
            p_retryable: true,
            p_max_attempts: 7,
        });
    });

    it('defers an exact live claim through the cleanup-only service RPC', async () => {
        const job = { ...claimedJob(), attemptCount: 7 };
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                released: true,
                job_status: 'pending',
                attempt_count: 7,
                request_status: 'processing',
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.deferTerminalCleanup(job)).resolves.toEqual({
            released: true,
            status: 'pending',
            attemptCount: 7,
            requestStatus: 'processing',
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DATABASE_NAMES.deferTerminalCleanupRpc,
            {
                p_request_id: requestId,
                p_job_key: jobKey,
                p_claim_token: job.claimToken,
            }
        );
    });

    it('rejects a non-pending cleanup defer result', async () => {
        const job = claimedJob();
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                released: false,
                job_status: 'processing',
                attempt_count: 1,
                request_status: 'processing',
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.deferTerminalCleanup(job)).rejects.toThrow(
            'invalid terminal cleanup defer'
        );
    });

    it('defers AI capacity without consuming the claimed attempt', async () => {
        const job = { ...claimedJob(), attemptCount: 3 };
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                released: true,
                job_status: 'pending',
                attempt_count: 2,
                request_status: 'processing',
                ai_capacity_deferral_count: 4,
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.deferAiCapacity(
            job,
            'ANALYSIS_V2_AI_CAPACITY_PENDING'
        )).resolves.toEqual({
            released: true,
            status: 'pending',
            attemptCount: 2,
            requestStatus: 'processing',
        });
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DATABASE_NAMES.deferAiCapacityRpc,
            {
                p_request_id: requestId,
                p_job_key: jobKey,
                p_claim_token: job.claimToken,
                p_error_code: 'ANALYSIS_V2_AI_CAPACITY_PENDING',
            }
        );
    });

    it('completes and fans out camelCase successor contracts atomically', async () => {
        const job = claimedJob();
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                request_id: requestId,
                completed: true,
                job_status: 'completed',
                dispatchable_job_keys: ['relationship:collect', 'target:interactions'],
            }],
            error: null,
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));

        await expect(store.completeAndFanout(job, [{
            jobKey: 'score:join',
            track: 'scoring',
            kind: 'join',
            batch: null,
            inputHash,
            requiredJobKeys: ['relationship:collect', 'target:interactions'],
        }])).resolves.toEqual([
            { requestId, jobKey: 'relationship:collect' },
            { requestId, jobKey: 'target:interactions' },
        ]);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DATABASE_NAMES.completeAndFanoutRpc,
            expect.objectContaining({
                p_successors: [{
                    jobKey: 'score:join',
                    track: 'scoring',
                    kind: 'join',
                    batch: null,
                    inputHash,
                    requiredJobKeys: ['relationship:collect', 'target:interactions'],
                }],
            })
        );
    });

    it('rejects duplicate dependencies and maps only strict recovery rows', async () => {
        const store = createSupabaseAnalysisV2JobStore(rpcClient(vi.fn()));
        await expect(store.completeAndFanout(claimedJob(), [{
            jobKey: 'score:join',
            track: 'scoring',
            kind: 'join',
            batch: null,
            inputHash,
            requiredJobKeys: ['target:interactions', 'target:interactions'],
        }])).rejects.toThrow('invalid successor dependencies');

        const dispatchFence = randomUUID();
        const rpc = vi.fn().mockResolvedValue({
            data: [{
                request_id: requestId,
                job_key: jobKey,
                job_status: 'pending',
                dispatch_state: 'enqueued',
                dispatch_generation: 1,
                reservation_token: dispatchFence,
                dispatch_reserved_at: '2026-07-14T01:00:00Z',
                dispatched_at: '2026-07-14T01:00:01Z',
                task_name: taskName,
                lease_expires_at: null,
            }],
            error: null,
        });
        const recoveryStore = createSupabaseAnalysisV2JobStore(rpcClient(rpc));
        await expect(recoveryStore.listDispatchable({ limit: 20 })).resolves.toEqual([{
            requestId,
            jobKey,
            status: 'pending',
            dispatchState: 'enqueued',
            generation: 1,
            reservationToken: dispatchFence,
            reservedAt: '2026-07-14T01:00:00Z',
            dispatchedAt: '2026-07-14T01:00:01Z',
            taskName,
            leaseExpiresAt: null,
        }]);
        expect(rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_DATABASE_NAMES.listDispatchableRpc,
            { p_limit: 20 }
        );
    });

    it('does not leak database messages through unexpected RPC errors', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: { code: '42501', message: 'sensitive database detail' },
        });
        const store = createSupabaseAnalysisV2JobStore(rpcClient(rpc));
        await expect(store.reserveDispatch({ requestId, jobKey })).rejects.toThrow(
            'dispatch reserve failed (42501)'
        );
        await expect(store.reserveDispatch({ requestId, jobKey })).rejects.not.toThrow(
            'sensitive database detail'
        );
    });
});
