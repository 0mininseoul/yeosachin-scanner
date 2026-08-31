import { describe, expect, it, vi } from 'vitest';
import {
    AnalysisV2JobFenceError,
    type AnalysisV2DispatchableJob,
    type AnalysisV2JobStore,
} from './v2-job-store';
import { recoverAnalysisV2Jobs } from './v2-recovery';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const reservationToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const emptyBetaRecovery = {
    betaCreditRecovered: 0,
    betaCreditArchived: 0,
    betaCreditRecoveryFailures: 0,
    betaCreditArchiveFailures: 0,
    betaCreditRefreshAttempts: 0,
    betaCreditRefreshFailures: 0,
    providerAdmissionsScanned: 0,
    providerAdmissionsRecovered: 0,
    providerAdmissionsSkipped: 0,
    providerAdmissionsFailed: 0,
    providerAdmissionsHasMore: false,
    capacityDispatchesScanned: 0,
    capacityDispatchesRecovered: 0,
    capacityDispatchesTaskPresent: 0,
    capacityDispatchesSkipped: 0,
    capacityDispatchesFailed: 0,
} as const;

function job(
    jobKey: string,
    dispatchState: AnalysisV2DispatchableJob['dispatchState']
): AnalysisV2DispatchableJob {
    const hasDelivery = dispatchState === 'enqueued' || dispatchState === 'delivered';
    return {
        requestId,
        jobKey,
        status: dispatchState === 'delivered' ? 'processing' : 'pending',
        dispatchState,
        generation: dispatchState === 'pending' ? 0 : 1,
        reservationToken: dispatchState === 'pending' ? null : reservationToken,
        reservedAt: dispatchState === 'pending' ? null : '2030-07-13T00:00:00Z',
        dispatchedAt: hasDelivery ? '2030-07-13T00:00:01Z' : null,
        taskName: hasDelivery
            ? 'projects/example-project/locations/asia-northeast3/queues/analysis-v2/tasks/analysis-v2-task'
            : null,
        leaseExpiresAt: dispatchState === 'delivered'
            ? '2030-07-13T00:05:00Z'
            : null,
    };
}

function store(jobs: AnalysisV2DispatchableJob[]): AnalysisV2JobStore {
    return {
        reserveDispatch: vi.fn(),
        rearmDispatch: vi.fn(async input => ({
            requestId: input.requestId,
            jobKey: input.jobKey,
            reserved: true,
            generation: input.expectedGeneration + 1,
            reservationToken,
            status: 'pending' as const,
            dispatchState: 'reserved' as const,
            taskName: null,
        })),
        deferRecovery: vi.fn(async () => true),
        markDispatched: vi.fn(),
        claim: vi.fn(),
        deferTerminalCleanup: vi.fn(),
        deferAiCapacity: vi.fn(),
        continueScheduler: vi.fn(),
        releaseClaim: vi.fn(),
        completeAndFanout: vi.fn(),
        listDispatchable: vi.fn(async () => jobs),
    };
}

function providerRecovery() {
    return {
        recoverGeminiCutoffAttempts: vi.fn(async () => 0),
        reapGeminiCutoffLeases: vi.fn(async () => 0),
        recoverSchedulerOperations: vi.fn(async () => 0),
        reapSchedulerGeminiLeases: vi.fn(async () => 0),
        recoverFulfillments: vi.fn(async () => ({
            reconciled: {
                scanned: 0,
                completed: 0,
                manualReview: 0,
                retryable: 0,
            },
            scanned: 0,
            advanced: 0,
            failed: 0,
        })),
        cleanupProviderRuns: vi.fn(async () => ({
            scanned: 0,
            settled: 0,
            failed: 0,
            unconfirmedStarts: 0,
            hasMore: false,
        })),
        reconcileProviderUsage: vi.fn(async () => ({
            eligible: 0,
            reconciled: 0,
            failed: 0,
            hasMore: false,
        })),
        recoverScoreAudits: vi.fn(async () => undefined),
    };
}

describe('analysis V2 dispatch recovery', () => {
    it('dispatches pending/reserved jobs and preserves task identities that still exist', async () => {
        const jobStore = store([
            job('coordinator:pending', 'pending'),
            job('coordinator:reserved', 'reserved'),
            job('coordinator:existing', 'enqueued'),
        ]);
        const dispatch = vi.fn(async () => 'enqueued');
        const lookup = vi.fn(async () => 'exists' as const);
        const cleanupTerminalMedia = vi.fn(async () => undefined);

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: jobStore,
            dispatch,
            lookup,
            cleanupTerminalMedia,
        })).resolves.toEqual({
            ...emptyBetaRecovery,
            scanned: 3,
            dispatched: 2,
            taskPresent: 1,
            lostRace: 0,
            failed: 0,
            providerRunsSettled: 0,
            providerRunsBlocked: 0,
            providerUsageReconciled: 0,
            fulfillmentsScanned: 0,
            fulfillmentsAdvanced: 0,
            fulfillmentsCompleted: 0,
            fulfillmentsManualReview: 0,
            fulfillmentsFailed: 0,
            geminiCutoffAttemptsRecovered: 0,
            geminiCutoffLeasesReaped: 0,
            schedulerOperationsRecovered: 0,
            schedulerGeminiLeasesReaped: 0,
        });
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(jobStore.deferRecovery).toHaveBeenCalledWith({
            requestId,
            jobKey: 'coordinator:existing',
            expectedGeneration: 1,
            expectedReservationToken: reservationToken,
            expectedStatus: 'pending',
            expectedLeaseExpiresAt: null,
        });
        expect(jobStore.rearmDispatch).not.toHaveBeenCalled();
        expect(cleanupTerminalMedia).toHaveBeenCalledOnce();
    });

    it('caps the capacity-dispatch page independently of the 100-job V2 recovery page', async () => {
        const recoverCapacityDispatches = vi.fn(async (options?: { limit?: number }) => {
            expect(options?.limit).toBe(64);
            return { scanned: 0, recovered: 0, taskPresent: 0, skipped: 0, failed: 0 };
        });

        const summary = await recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            limit: 100,
            recoverCapacityDispatches,
        });
        expect(recoverCapacityDispatches).toHaveBeenCalledOnce();
        expect(summary).toMatchObject({
            scanned: 0,
            capacityDispatchesScanned: 0,
            capacityDispatchesFailed: 0,
        });
        expect(recoverCapacityDispatches).toHaveBeenCalledWith({
            limit: 64,
            env: undefined,
        });
    });

    it('rotates task-present rows so the next bounded scan reaches later work', async () => {
        const taskPresentJobs = Array.from({ length: 100 }, (_, index) => (
            job(`track:profiles:batch:${index}`, 'enqueued')
        ));
        const actionable = job('coordinator:pending', 'pending');
        const jobStore = store([...taskPresentJobs, actionable]);
        const deferred = new Set<string>();
        jobStore.listDispatchable = vi.fn(async ({ limit = 100 } = {}) => (
            [...taskPresentJobs, actionable]
                .filter(candidate => !deferred.has(candidate.jobKey))
                .slice(0, limit)
        ));
        jobStore.deferRecovery = vi.fn(async input => {
            deferred.add(input.jobKey);
            return true;
        });
        const dispatch = vi.fn(async () => 'enqueued');

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: jobStore,
            lookup: async () => 'exists',
            dispatch,
        })).resolves.toMatchObject({
            scanned: 100,
            taskPresent: 100,
            dispatched: 0,
        });
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: jobStore,
            lookup: async () => 'exists',
            dispatch,
        })).resolves.toMatchObject({
            scanned: 1,
            taskPresent: 0,
            dispatched: 1,
        });
        expect(dispatch).toHaveBeenCalledWith(requestId, actionable.jobKey);
    });

    it('rearms only after Cloud Tasks proves the exact generation is missing', async () => {
        const missing = job('coordinator:missing', 'enqueued');
        const jobStore = store([missing]);
        const dispatch = vi.fn(async () => 'enqueued');

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: jobStore,
            dispatch,
            lookup: async () => 'not_found',
        })).resolves.toMatchObject({ dispatched: 1, failed: 0 });
        expect(jobStore.rearmDispatch).toHaveBeenCalledWith({
            requestId,
            jobKey: missing.jobKey,
            expectedGeneration: 1,
            expectedReservationToken: reservationToken,
        });
        expect(dispatch).toHaveBeenCalledAfter(
            (jobStore.rearmDispatch as ReturnType<typeof vi.fn>)
        );
    });

    it('never rearms an ambiguous lookup failure and tolerates a concurrent recovery race', async () => {
        const ambiguousStore = store([job('coordinator:ambiguous', 'enqueued')]);
        const ambiguous = await recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: ambiguousStore,
            lookup: async () => { throw new Error('permission denied'); },
            dispatch: vi.fn(),
        });
        expect(ambiguous).toMatchObject({ failed: 1, dispatched: 0 });
        expect(ambiguousStore.rearmDispatch).not.toHaveBeenCalled();

        const raceStore = store([job('coordinator:race', 'enqueued')]);
        raceStore.rearmDispatch = vi.fn(async () => {
            throw new AnalysisV2JobFenceError();
        });
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: raceStore,
            lookup: async () => 'not_found',
            dispatch: vi.fn(),
        })).resolves.toMatchObject({ lostRace: 1, failed: 0 });

        const deferRaceStore = store([job('coordinator:defer-race', 'enqueued')]);
        deferRaceStore.deferRecovery = vi.fn(async () => false);
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: deferRaceStore,
            lookup: async () => 'exists',
            dispatch: vi.fn(),
        })).resolves.toMatchObject({ lostRace: 1, taskPresent: 0, failed: 0 });
    });

    it('reports a terminal media cleanup failure for the scheduler to retry', async () => {
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            cleanupTerminalMedia: async () => {
                throw new Error('temporary cleanup failure');
            },
        })).resolves.toEqual({
            ...emptyBetaRecovery,
            scanned: 0,
            dispatched: 0,
            taskPresent: 0,
            lostRace: 0,
            failed: 1,
            providerRunsSettled: 0,
            providerRunsBlocked: 0,
            providerUsageReconciled: 0,
            fulfillmentsScanned: 0,
            fulfillmentsAdvanced: 0,
            fulfillmentsCompleted: 0,
            fulfillmentsManualReview: 0,
            fulfillmentsFailed: 0,
            geminiCutoffAttemptsRecovered: 0,
            geminiCutoffLeasesReaped: 0,
            schedulerOperationsRecovered: 0,
            schedulerGeminiLeasesReaped: 0,
        });
    });

    it('repeats provider abort and usage reconciliation and reports unresolved cleanup', async () => {
        const cleanupProviderRuns = vi.fn(async () => ({
            scanned: 3,
            settled: 2,
            failed: 1,
            unconfirmedStarts: 1,
            hasMore: false,
        }));
        const reconcileProviderUsage = vi.fn(async () => ({
            eligible: 2,
            reconciled: 1,
            failed: 1,
            hasMore: false,
        }));

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            cleanupProviderRuns,
            reconcileProviderUsage,
            cleanupTerminalMedia: vi.fn(async () => undefined),
        })).resolves.toEqual({
            ...emptyBetaRecovery,
            scanned: 0,
            dispatched: 0,
            taskPresent: 0,
            lostRace: 0,
            failed: 2,
            providerRunsSettled: 2,
            providerRunsBlocked: 2,
            providerUsageReconciled: 1,
            fulfillmentsScanned: 0,
            fulfillmentsAdvanced: 0,
            fulfillmentsCompleted: 0,
            fulfillmentsManualReview: 0,
            fulfillmentsFailed: 0,
            geminiCutoffAttemptsRecovered: 0,
            geminiCutoffLeasesReaped: 0,
            schedulerOperationsRecovered: 0,
            schedulerGeminiLeasesReaped: 0,
        });
        expect(cleanupProviderRuns).toHaveBeenCalledOnce();
        expect(reconcileProviderUsage).toHaveBeenCalledOnce();
    });

    it('replays only operator-admitted fulfillments and surfaces their recovery state', async () => {
        const recoverFulfillments = vi.fn(async () => ({
            reconciled: {
                scanned: 2,
                completed: 1,
                manualReview: 1,
                retryable: 0,
            },
            scanned: 3,
            advanced: 2,
            failed: 1,
        }));
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            recoverFulfillments,
        })).resolves.toMatchObject({
            failed: 1,
            fulfillmentsScanned: 3,
            fulfillmentsAdvanced: 2,
            fulfillmentsCompleted: 1,
            fulfillmentsManualReview: 1,
            fulfillmentsFailed: 1,
        });
        expect(recoverFulfillments).toHaveBeenCalledOnce();
    });

    it('reaps expired resolver quarantines once per bounded recovery pass', async () => {
        const recoverGeminiCutoffAttempts = vi.fn(async () => 1);
        const reapGeminiCutoffLeases = vi.fn(async () => 2);

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            recoverGeminiCutoffAttempts,
            reapGeminiCutoffLeases,
        })).resolves.toMatchObject({
            failed: 0,
            geminiCutoffAttemptsRecovered: 1,
            geminiCutoffLeasesReaped: 2,
        });
        expect(recoverGeminiCutoffAttempts).toHaveBeenCalledOnce();
        expect(reapGeminiCutoffLeases).toHaveBeenCalledOnce();
        expect(recoverGeminiCutoffAttempts).toHaveBeenCalledBefore(
            reapGeminiCutoffLeases
        );
    });

    it('terminalizes expired scheduler operations before reaping their leases', async () => {
        const recoverSchedulerOperations = vi.fn(async () => 2);
        const reapSchedulerGeminiLeases = vi.fn(async () => 1);

        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            recoverSchedulerOperations,
            reapSchedulerGeminiLeases,
        })).resolves.toMatchObject({
            failed: 0,
            schedulerOperationsRecovered: 2,
            schedulerGeminiLeasesReaped: 1,
        });
        expect(recoverSchedulerOperations).toHaveBeenCalledBefore(
            reapSchedulerGeminiLeases,
        );
    });

    it('recovers expired provider admissions as a bounded maintenance step', async () => {
        const recoverProviderAdmissions = vi.fn(async () => ({
            scanned: 3,
            recovered: 2,
            resolved: 2,
            skipped: 1,
            failed: 0,
            hasMore: true,
        }));
        const summary = await recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            recoverProviderAdmissions,
        });

        expect(summary).toMatchObject({
            failed: 0,
            providerAdmissionsScanned: 3,
            providerAdmissionsRecovered: 2,
            providerAdmissionsSkipped: 1,
            providerAdmissionsFailed: 0,
            providerAdmissionsHasMore: true,
        });
        expect(recoverProviderAdmissions).toHaveBeenCalledOnce();
    });

    it('drains score audits only after media and provider safety cleanup', async () => {
        const order: string[] = [];
        await recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            cleanupTerminalMedia: vi.fn(async () => {
                order.push('media');
            }),
            cleanupProviderRuns: vi.fn(async () => {
                order.push('provider');
                return {
                    scanned: 0, settled: 0, failed: 0,
                    unconfirmedStarts: 0, hasMore: false,
                };
            }),
            reconcileProviderUsage: vi.fn(async () => {
                order.push('usage');
                return {
                    eligible: 0, reconciled: 0, failed: 0, hasMore: false,
                };
            }),
            recoverScoreAudits: vi.fn(async () => {
                order.push('audit');
            }),
        });
        expect(order).toEqual(['media', 'provider', 'usage', 'audit']);
    });

    it('bounds a hung score-audit drain without changing recovery success', async () => {
        const order: string[] = [];
        const startedAt = performance.now();
        const summary = await recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            cleanupTerminalMedia: vi.fn(async () => {
                order.push('media');
            }),
            cleanupProviderRuns: vi.fn(async () => {
                order.push('provider');
                return {
                    scanned: 0, settled: 0, failed: 0,
                    unconfirmedStarts: 0, hasMore: false,
                };
            }),
            reconcileProviderUsage: vi.fn(async () => {
                order.push('usage');
                return {
                    eligible: 0, reconciled: 0, failed: 0, hasMore: false,
                };
            }),
            recoverScoreAudits: vi.fn(() => {
                order.push('audit');
                return new Promise<void>(() => undefined);
            }),
            scoreAuditTimeoutMs: 25,
        });
        expect(order).toEqual(['media', 'provider', 'usage', 'audit']);
        expect(performance.now() - startedAt).toBeLessThan(250);
        expect(summary.failed).toBe(0);
    });

    it('isolates a score-audit failure from analysis recovery', async () => {
        await expect(recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            recoverScoreAudits: async () => {
                throw new Error('audit service unavailable');
            },
        })).resolves.toMatchObject({ failed: 0 });
    });

    it('runs provider reconciliation before required beta DB work and advisory refresh', async () => {
        const events: string[] = [];
        const dependencies = providerRecovery();
        dependencies.cleanupProviderRuns.mockImplementation(async () => {
            events.push('provider-cleanup');
            return { scanned: 0, settled: 0, failed: 0, unconfirmedStarts: 0, hasMore: false };
        });
        dependencies.reconcileProviderUsage.mockImplementation(async () => {
            events.push('provider-reconcile');
            return { eligible: 0, reconciled: 0, failed: 0, hasMore: false };
        });
        const summary = await recoverAnalysisV2Jobs({
            ...dependencies,
            store: store([]),
            recoverBetaCredit: async () => { events.push('beta-recover'); return 2; },
            archiveBetaCredit: async () => { events.push('beta-archive'); return 1; },
            refreshBetaCredit: async () => { events.push('beta-refresh'); },
        });
        expect(events).toEqual([
            'provider-cleanup', 'provider-reconcile',
            'beta-recover', 'beta-archive', 'beta-refresh',
        ]);
        expect(summary).toMatchObject({
            betaCreditRecovered: 2,
            betaCreditArchived: 1,
            betaCreditRefreshAttempts: 1,
            betaCreditRefreshFailures: 0,
        });
    });

    it('archives after recovery failure and reports an isolated refresh failure', async () => {
        const archiveBetaCredit = vi.fn(async () => 3);
        const refreshBetaCredit = vi.fn(async () => { throw new Error('refresh'); });
        const failedRecovery = await recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            recoverBetaCredit: async () => { throw new Error('recover'); },
            archiveBetaCredit,
            refreshBetaCredit,
        });
        expect(archiveBetaCredit).toHaveBeenCalledOnce();
        expect(refreshBetaCredit).not.toHaveBeenCalled();
        expect(failedRecovery).toMatchObject({
            betaCreditRecoveryFailures: 1,
            betaCreditArchived: 3,
            betaCreditRefreshAttempts: 0,
        });

        const refreshFailure = await recoverAnalysisV2Jobs({
            ...providerRecovery(),
            store: store([]),
            recoverBetaCredit: async () => 1,
            archiveBetaCredit: async () => 0,
            refreshBetaCredit,
        });
        expect(refreshFailure).toMatchObject({
            betaCreditRecovered: 1,
            betaCreditRefreshAttempts: 1,
            betaCreditRefreshFailures: 1,
        });
    });
});
