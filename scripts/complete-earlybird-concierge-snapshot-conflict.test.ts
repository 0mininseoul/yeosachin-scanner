import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    parseConciergeSnapshotConflictCompletionArgs,
    runConciergeSnapshotConflictCompletion,
    runExactConciergeRequestLocally,
} from './complete-earlybird-concierge-snapshot-conflict';

const ORDER_ID = randomUUID();
const PREFLIGHT_ID = randomUUID();
const REQUEST_ID = randomUUID();
const MANUAL_REVIEW_AT = '2026-08-13T19:00:00.000Z';
const ADMISSION_REFRESHED_AT = '2026-08-13T18:59:00.000Z';
const exactArgs = [
    '--order-id', ORDER_ID,
    '--preflight-id', PREFLIGHT_ID,
    '--expected-manual-review-at', MANUAL_REVIEW_AT,
    '--expected-admission-refreshed-at', ADMISSION_REFRESHED_AT,
    '--confirm-exact-20260812-1807-basic-snapshot-conflict',
] as const;
const pristinePrecheck = Object.freeze({
    recovered: false,
    requestId: null,
    requestStatus: null,
    fulfillmentStatus: 'manual_review' as const,
});

describe('incident-scoped concierge snapshot-conflict completion', () => {
    it('requires exactly one explicit dry-run or execute mode', () => {
        expect(parseConciergeSnapshotConflictCompletionArgs([
            ...exactArgs,
            '--dry-run',
        ])).toMatchObject({ mode: 'dry-run', orderId: ORDER_ID });
        expect(parseConciergeSnapshotConflictCompletionArgs([
            ...exactArgs,
            '--execute-once',
        ])).toMatchObject({ mode: 'execute', orderId: ORDER_ID });
        expect(() => parseConciergeSnapshotConflictCompletionArgs(exactArgs)).toThrow();
        expect(() => parseConciergeSnapshotConflictCompletionArgs([
            ...exactArgs,
            '--dry-run',
            '--execute-once',
        ])).toThrow();
    });

    it('performs a read-only precondition check in dry-run mode', async () => {
        const precheck = vi.fn(async () => pristinePrecheck);
        const recover = vi.fn();
        const writeStdout = vi.fn();
        await expect(runConciergeSnapshotConflictCompletion([
            ...exactArgs,
            '--dry-run',
        ], {
            precheck,
            recover,
            createRequest: vi.fn(),
            runRequest: vi.fn(),
            reconcileAndVerify: vi.fn(),
            writeStdout,
        })).resolves.toEqual({ status: 'ready' });
        expect(precheck).toHaveBeenCalledOnce();
        expect(recover).not.toHaveBeenCalled();
        expect(writeStdout).toHaveBeenCalledWith('{"status":"ready"}\n');
    });

    it('recovers, creates, runs, and reconciles only the returned request', async () => {
        const calls: string[] = [];
        const writeStdout = vi.fn();
        await expect(runConciergeSnapshotConflictCompletion([
            ...exactArgs,
            '--execute-once',
        ], {
            precheck: async () => {
                calls.push('precheck');
                return pristinePrecheck;
            },
            recover: async () => {
                calls.push('recover');
                return { applied: true, fulfillmentStatus: 'retryable_failure' };
            },
            createRequest: async (orderId, preflightId) => {
                expect(orderId).toBe(ORDER_ID);
                expect(preflightId).toBe(PREFLIGHT_ID);
                calls.push('create');
                return { requestId: REQUEST_ID, initialJobKey: 'coordinator:bootstrap' };
            },
            runRequest: async (orderId, requestId, initialJobKey) => {
                expect(orderId).toBe(ORDER_ID);
                expect(requestId).toBe(REQUEST_ID);
                expect(initialJobKey).toBe('coordinator:bootstrap');
                calls.push('run');
            },
            reconcileAndVerify: async input => {
                expect(input).toEqual({
                    orderId: ORDER_ID,
                    preflightId: PREFLIGHT_ID,
                    requestId: REQUEST_ID,
                });
                calls.push('verify');
            },
            writeStdout,
        })).resolves.toEqual({ status: 'completed' });
        expect(calls).toEqual(['precheck', 'recover', 'create', 'run', 'verify']);
        expect(writeStdout).toHaveBeenCalledWith('{"status":"completed"}\n');
        expect(writeStdout.mock.calls.flat().join('')).not.toContain(ORDER_ID);
        expect(writeStdout.mock.calls.flat().join('')).not.toContain(PREFLIGHT_ID);
        expect(writeStdout.mock.calls.flat().join('')).not.toContain(REQUEST_ID);
    });

    it('stops before request creation when recovery is not in the exact retryable state', async () => {
        const createRequest = vi.fn();
        await expect(runConciergeSnapshotConflictCompletion([
            ...exactArgs,
            '--execute-once',
        ], {
            precheck: async () => pristinePrecheck,
            recover: async () => ({
                applied: false,
                fulfillmentStatus: 'completed',
            }),
            createRequest,
            runRequest: vi.fn(),
            reconcileAndVerify: vi.fn(),
            writeStdout: vi.fn(),
        })).rejects.toThrow(/CONCIERGE_SNAPSHOT_COMPLETION_RECOVERY_STATE_INVALID/);
        expect(createRequest).not.toHaveBeenCalled();
    });

    it('runs only exact-request locally fanned-out jobs', async () => {
        const reserved: string[] = [];
        const processed: string[] = [];
        let generation = 0;
        const store = {
            async reserveDispatch(input: { requestId: string; jobKey: string }) {
                reserved.push(input.jobKey);
                generation += 1;
                return {
                    ...input,
                    reserved: true,
                    generation,
                    reservationToken: randomUUID(),
                    status: 'pending' as const,
                    dispatchState: 'reserved' as const,
                    taskName: null,
                };
            },
            rearmDispatch: vi.fn(),
        };
        await expect(runExactConciergeRequestLocally(
            ORDER_ID,
            REQUEST_ID,
            'coordinator:bootstrap',
            {
                store,
                loadActiveJobs: async () => [{
                    job_key: 'coordinator:bootstrap',
                    status: 'pending',
                    dispatch_state: 'pending',
                    dispatch_generation: 0,
                    dispatch_reservation_token: null,
                    dispatch_task_name: null,
                    lease_expires_at: null,
                }],
                now: () => 1,
                wait: async () => undefined,
                markLocalDispatch: async () => undefined,
                process: async (delivery, dependencies) => {
                    processed.push(delivery.jobKey);
                    if (delivery.jobKey === 'coordinator:bootstrap') {
                        await dependencies?.dispatch?.(
                            REQUEST_ID,
                            'track:relationships:collect',
                        );
                    }
                    return {
                        status: 'completed' as const,
                        successorCount: delivery.jobKey === 'coordinator:bootstrap' ? 1 : 0,
                        pendingRecoveryCount: 0,
                    };
                },
            },
        )).resolves.toBeUndefined();
        expect(reserved).toEqual([
            'coordinator:bootstrap',
            'track:relationships:collect',
        ]);
        expect(processed).toEqual(reserved);
        expect(store.rearmDispatch).not.toHaveBeenCalled();
    });

    it('rejects a local fanout that crosses the exact request boundary', async () => {
        await expect(runExactConciergeRequestLocally(
            ORDER_ID,
            REQUEST_ID,
            'coordinator:bootstrap',
            {
                store: {
                    async reserveDispatch(input) {
                        return {
                            ...input,
                            reserved: true,
                            generation: 1,
                            reservationToken: randomUUID(),
                            status: 'pending' as const,
                            dispatchState: 'reserved' as const,
                            taskName: null,
                        };
                    },
                    rearmDispatch: vi.fn(),
                },
                loadActiveJobs: async () => [{
                    job_key: 'coordinator:bootstrap',
                    status: 'pending',
                    dispatch_state: 'pending',
                    dispatch_generation: 0,
                    dispatch_reservation_token: null,
                    dispatch_task_name: null,
                    lease_expires_at: null,
                }],
                now: () => 1,
                wait: async () => undefined,
                markLocalDispatch: async () => undefined,
                process: async (_delivery, dependencies) => {
                    await dependencies?.dispatch?.(
                        randomUUID(),
                        'track:relationships:collect',
                    );
                    return {
                        status: 'completed' as const,
                        successorCount: 1,
                        pendingRecoveryCount: 0,
                    };
                },
            },
        )).rejects.toThrow(/CONCIERGE_SNAPSHOT_COMPLETION_JOB_SCOPE_CONFLICT/);
    });

    it('resumes an already-enqueued exact local job without reserving a new fence', async () => {
        const reservationToken = randomUUID();
        const reserveDispatch = vi.fn();
        const markLocalDispatch = vi.fn(async () => undefined);
        const process = vi.fn(async () => ({
            status: 'completed' as const,
            successorCount: 0,
            pendingRecoveryCount: 0,
        }));
        await expect(runExactConciergeRequestLocally(
            ORDER_ID,
            REQUEST_ID,
            'coordinator:bootstrap',
            {
                store: { reserveDispatch, rearmDispatch: vi.fn() },
                loadActiveJobs: async () => [{
                    job_key: 'track:relationships:collect',
                    status: 'pending',
                    dispatch_state: 'enqueued',
                    dispatch_generation: 3,
                    dispatch_reservation_token: reservationToken,
                    dispatch_task_name: 'manual-local/concierge-snapshot-conflict/hash/g3',
                    lease_expires_at: null,
                }],
                markLocalDispatch,
                process,
                now: () => 1,
                wait: async () => undefined,
            },
        )).resolves.toBeUndefined();
        expect(reserveDispatch).not.toHaveBeenCalled();
        expect(markLocalDispatch).toHaveBeenCalledOnce();
        expect(process).toHaveBeenCalledWith(
            expect.objectContaining({
                requestId: REQUEST_ID,
                generation: 3,
                reservationToken,
            }),
            expect.any(Object),
        );
    });

    it('resumes the exact persisted request without creating a second request', async () => {
        const createRequest = vi.fn();
        const runRequest = vi.fn(async () => undefined);
        await expect(runConciergeSnapshotConflictCompletion([
            ...exactArgs,
            '--execute-once',
        ], {
            precheck: async () => ({
                recovered: true,
                requestId: REQUEST_ID,
                requestStatus: 'processing',
                fulfillmentStatus: 'analysis_in_progress',
            }),
            recover: async () => ({
                applied: false,
                fulfillmentStatus: 'analysis_in_progress',
            }),
            createRequest,
            runRequest,
            reconcileAndVerify: vi.fn(async () => undefined),
            writeStdout: vi.fn(),
        })).resolves.toEqual({ status: 'completed' });
        expect(createRequest).not.toHaveBeenCalled();
        expect(runRequest).toHaveBeenCalledWith(
            ORDER_ID,
            REQUEST_ID,
            'coordinator:bootstrap',
        );
    });
});
