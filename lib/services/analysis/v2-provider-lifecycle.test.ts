import { describe, expect, it, vi } from 'vitest';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import {
    prepareAnalysisV2ProviderRunsForTerminalFailure,
    reconcileAnalysisV2ProviderUsage,
    settleActiveAnalysisV2ProviderRuns,
} from './v2-provider-lifecycle';
import type {
    AnalysisV2ProviderRunStore,
    StoredAnalysisV2ProviderRun,
} from './v2-provider-run-store';

const requestId = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const inputHash = 'a'.repeat(64);

function run(
    index: number,
    overrides: Partial<StoredAnalysisV2ProviderRun> = {}
): StoredAnalysisV2ProviderRun {
    return {
        requestId,
        jobKey: `track:profiles:batch:${index}`,
        operationKey: `profile-fallback:${String(index).padStart(64, '0')}`,
        inputHash,
        reservationToken: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
        logicalProvider: 'apify',
        actorId: 'apify/instagram-profile-scraper',
        credentialSlot: index % 2 === 0 ? 'quinary' : 'tertiary',
        maxChargeUsd: 0.5,
        status: 'running',
        runId: `RunAbcd${String(index).padStart(8, '0')}`,
        actualUsageUsd: null,
        reservedAt: '2026-07-14T00:00:00.000Z',
        runStartedAt: '2026-07-14T00:00:01.000Z',
        terminalizedAt: null,
        usageReconciledAt: null,
        ...overrides,
    };
}

function store(overrides: Partial<AnalysisV2ProviderRunStore> = {}) {
    return {
        reserve: vi.fn(),
        checkpointStarted: vi.fn(),
        checkpointTerminal: vi.fn(),
        load: vi.fn(),
        listUnreconciled: vi.fn(async () => []),
        reconcileUsage: vi.fn(),
        requestCleanup: vi.fn(async () => undefined),
        loadCleanupIntent: vi.fn(async () => null),
        listActiveForCleanup: vi.fn(async () => ({ startingCount: 0, runs: [] })),
        settleForCleanup: vi.fn(async input => run(1, {
            status: input.status,
            runId: input.runId,
            reservationToken: input.reservationToken,
            credentialSlot: input.credentialSlot,
            actualUsageUsd: input.actualUsageUsd,
            terminalizedAt: '2026-07-14T00:01:00.000Z',
            usageReconciledAt: input.actualUsageUsd === null
                ? null
                : '2026-07-14T00:01:00.000Z',
        })),
        bindAdapterCheckpoint: vi.fn(),
        ...overrides,
    } as AnalysisV2ProviderRunStore;
}

describe('analysis V2 paid-provider lifecycle', () => {
    it('aborts confirmed active runs with bounded concurrency and their stored credential slots', async () => {
        const rows = Array.from({ length: 6 }, (_, index) => run(index + 1));
        const providerStore = store({
            listActiveForCleanup: vi.fn()
                .mockResolvedValueOnce({ startingCount: 0, runs: rows })
                .mockResolvedValueOnce({ startingCount: 0, runs: [] }),
        });
        const selectedSlots: ApifyCredentialSlot[] = [];
        let active = 0;
        let maximumActive = 0;
        const abort = vi.fn(async () => {
            active++;
            maximumActive = Math.max(maximumActive, active);
            await Promise.resolve();
            active--;
            return { status: 'ABORTED', usageTotalUsd: 0.1 };
        });

        await expect(settleActiveAnalysisV2ProviderRuns(requestId, {
            store: providerStore,
            concurrency: 2,
            clientForSlot(slot) {
                selectedSlots.push(slot);
                return {
                    run: () => ({
                        get: async () => ({ status: 'RUNNING' }),
                        abort,
                        waitForFinish: async () => ({ status: 'ABORTED' }),
                    }),
                };
            },
        })).resolves.toEqual({
            scanned: 6,
            settled: 6,
            failed: 0,
            unconfirmedStarts: 0,
            hasMore: false,
        });

        expect(maximumActive).toBeLessThanOrEqual(2);
        expect(selectedSlots).toEqual(rows.map(row => row.credentialSlot));
        expect(providerStore.settleForCleanup).toHaveBeenCalledTimes(6);
        expect(providerStore.settleForCleanup).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'aborted', actualUsageUsd: null })
        );
    });

    it('confirms already-terminal remote runs without aborting them', async () => {
        const stored = run(1);
        const providerStore = store({
            listActiveForCleanup: vi.fn(async () => ({
                startingCount: 0,
                runs: [stored],
            })),
        });
        const abort = vi.fn();

        await expect(settleActiveAnalysisV2ProviderRuns(requestId, {
            store: providerStore,
            maxBatches: 1,
            clientForSlot: () => ({
                run: () => ({
                    get: async () => ({ status: 'SUCCEEDED', usageTotalUsd: 0.2 }),
                    abort,
                    waitForFinish: vi.fn(),
                }),
            }),
        })).resolves.toMatchObject({ settled: 1, failed: 0 });
        expect(abort).not.toHaveBeenCalled();
        expect(providerStore.settleForCleanup).toHaveBeenCalledWith(
            expect.objectContaining({ status: 'succeeded', actualUsageUsd: null })
        );
    });

    it('records an intent but fails closed when a start has no confirmed run id', async () => {
        const providerStore = store({
            listActiveForCleanup: vi.fn(async () => ({ startingCount: 1, runs: [] })),
        });
        const clientForSlot = vi.fn();
        const intent = {
            requestId,
            jobKey: 'track:relationships:collect',
            claimToken,
            jobInputHash: inputHash,
            errorCode: 'JOB_ATTEMPTS_EXHAUSTED',
        };

        await expect(prepareAnalysisV2ProviderRunsForTerminalFailure(intent, {
            store: providerStore,
            clientForSlot,
        })).rejects.toThrow('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
        expect(providerStore.requestCleanup).toHaveBeenCalledWith(intent);
        expect(clientForSlot).not.toHaveBeenCalled();
        expect(providerStore.settleForCleanup).not.toHaveBeenCalled();
    });

    it('reconciles stable terminal usage with the exact stored slot and leaves drift pending', async () => {
        const stable = run(1, {
            status: 'succeeded',
            terminalizedAt: '2026-07-14T00:01:00.000Z',
        });
        const drifted = run(2, {
            status: 'aborted',
            terminalizedAt: '2026-07-14T00:01:00.000Z',
        });
        const providerStore = store({
            listUnreconciled: vi.fn(async () => [stable, drifted]),
            reconcileUsage: vi.fn(async input => run(1, {
                status: input.status,
                runId: input.runId,
                reservationToken: input.reservationToken,
                credentialSlot: input.credentialSlot,
                actualUsageUsd: input.actualUsageUsd,
                terminalizedAt: '2026-07-14T00:01:00.000Z',
                usageReconciledAt: '2026-07-14T00:02:00.000Z',
            })),
        });
        const selected: ApifyCredentialSlot[] = [];

        await expect(reconcileAnalysisV2ProviderUsage({
            store: providerStore,
            clientForSlot(slot) {
                selected.push(slot);
                return {
                    run: runId => ({
                        get: async () => runId === stable.runId
                            ? { status: 'SUCCEEDED', usageTotalUsd: 0.2 }
                            : { status: 'FAILED', usageTotalUsd: 0.1 },
                        abort: vi.fn(),
                        waitForFinish: vi.fn(),
                    }),
                };
            },
        })).resolves.toEqual({
            eligible: 2,
            reconciled: 1,
            failed: 1,
            hasMore: false,
        });
        expect(selected).toEqual([stable.credentialSlot, drifted.credentialSlot]);
        expect(providerStore.reconcileUsage).toHaveBeenCalledOnce();
        expect(providerStore.reconcileUsage).toHaveBeenCalledWith(
            expect.objectContaining({ actualUsageUsd: 0.2, status: 'succeeded' })
        );
    });
});
