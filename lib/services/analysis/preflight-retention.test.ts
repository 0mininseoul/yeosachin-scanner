import { describe, expect, it, vi } from 'vitest';
import {
    PREFLIGHT_RETENTION_BATCH_LIMIT,
    runPreflightRetention,
} from './preflight-retention';

const emptyBetaRetention = {
    providerCostReconciliationFailures: 0,
    bliteSourcesPurged: 0,
    betaCreditRecovered: 0,
    betaCreditArchived: 0,
    betaCreditRecoveryFailures: 0,
    betaCreditArchiveFailures: 0,
    betaCreditRefreshAttempts: 0,
    betaCreditRefreshFailures: 0,
} as const;

describe('preflight retention maintenance', () => {
    it('purges bounded B-lite sources before parent and terminal preflight retention', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: [], error: null })
            .mockResolvedValueOnce({ data: 7, error: null })
            .mockResolvedValueOnce({ data: 12, error: null })
            .mockResolvedValueOnce({ data: 4, error: null });
        await expect(runPreflightRetention({ rpc })).resolves.toEqual({
            ...emptyBetaRetention,
            providerCosts: { eligible: 0, finalized: 0, failed: 0, hasMore: false },
            bliteSourcesPurged: 7,
            expiredPurged: 12,
            terminalScrubbed: 4,
        });
        expect(rpc.mock.calls).toEqual([
            ['list_analysis_preflight_unreconciled_provider_runs', {
                p_limit: 17,
            }],
            ['purge_expired_precheckout_blite_sources_v1', {
                p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
            }],
            ['purge_expired_analysis_v2_preflights', {
                p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
            }],
            ['scrub_terminal_analysis_v2_preflights', {
                p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
            }],
        ]);
    });

    it('fails closed on an impossible purge count', async () => {
        await expect(runPreflightRetention({
            rpc: vi.fn()
                .mockResolvedValueOnce({ data: [], error: null })
                .mockResolvedValueOnce({ data: 0, error: null })
                .mockResolvedValueOnce({ data: 9999, error: null }),
        })).rejects.toThrow('invalid purge_expired_analysis_v2_preflights result');
    });

    it('isolates a provider list failure and still runs purge, beta maintenance, and scrub in order', async () => {
        const events: string[] = [];
        const rpc = vi.fn(async name => {
            if (name === 'list_analysis_preflight_unreconciled_provider_runs') {
                events.push('provider');
                return { data: null, error: { message: 'provider list unavailable' } };
            }
            if (name === 'purge_expired_analysis_v2_preflights') {
                events.push('purge');
                return { data: 3, error: null };
            }
            if (name === 'purge_expired_precheckout_blite_sources_v1') {
                events.push('blite');
                return { data: 1, error: null };
            }
            events.push('scrub');
            return { data: 2, error: null };
        });

        const summary = await runPreflightRetention({ rpc }, {
            recoverBetaCredit: async () => { events.push('recover'); return 1; },
            archiveBetaCredit: async () => { events.push('archive'); return 4; },
            refreshBetaCredit: async () => { events.push('refresh'); },
        });

        expect(events).toEqual([
            'provider', 'blite', 'purge', 'recover', 'archive', 'scrub', 'refresh',
        ]);
        expect(summary).toEqual({
            providerCosts: { eligible: 0, finalized: 0, failed: 0, hasMore: false },
            providerCostReconciliationFailures: 1,
            bliteSourcesPurged: 1,
            expiredPurged: 3,
            terminalScrubbed: 2,
            betaCreditRecovered: 1,
            betaCreditArchived: 4,
            betaCreditRecoveryFailures: 0,
            betaCreditArchiveFailures: 0,
            betaCreditRefreshAttempts: 1,
            betaCreditRefreshFailures: 0,
        });
    });

    it('reports a failed cost read while retention safely proceeds behind the SQL delete fence', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: 1, error: null })
            .mockResolvedValueOnce({ data: 2, error: null })
            .mockResolvedValueOnce({ data: 2, error: null });
        const providerRunStore = {
            listUnreconciled: vi.fn(async () => [{
                preflightId: '123e4567-e89b-42d3-a456-426614174000',
                operationKey: 'target-profile-fallback',
                inputHash: 'a'.repeat(64),
                logicalProvider: 'apify' as const,
                actorId: 'apify/instagram-profile-scraper' as const,
                credentialSlot: 'primary' as const,
                maxChargeUsd: 0.0026 as const,
                status: 'succeeded' as const,
                runId: 'StoredRun12345678',
                actualUsageUsd: null,
                reservedAt: '2026-07-14T23:59:00.000Z',
                runStartedAt: '2026-07-14T23:59:30.000Z',
                terminalizedAt: null,
                usageReconciledAt: null,
            }]),
            reconcileUsage: vi.fn(),
        };

        await expect(runPreflightRetention({ rpc }, {
            providerRunStore,
            clientForSlot: () => ({
                run: () => ({
                    get: async () => ({ status: 'FAILED', usageTotalUsd: 0.0025 }),
                }),
            }),
        })).resolves.toEqual({
            ...emptyBetaRetention,
            providerCosts: { eligible: 1, finalized: 0, failed: 1, hasMore: false },
            bliteSourcesPurged: 1,
            expiredPurged: 2,
            terminalScrubbed: 2,
        });
        expect(providerRunStore.reconcileUsage).not.toHaveBeenCalled();
        expect(rpc.mock.calls.map(call => call[0])).toEqual([
            'purge_expired_precheckout_blite_sources_v1',
            'purge_expired_analysis_v2_preflights',
            'scrub_terminal_analysis_v2_preflights',
        ]);
    });

    it('keeps safe archive after a best-effort refresh failure', async () => {
        const events: string[] = [];
        const summary = await runPreflightRetention({
            rpc: vi.fn(async name => {
                events.push(name === 'purge_expired_precheckout_blite_sources_v1'
                    ? 'blite'
                    : name === 'purge_expired_analysis_v2_preflights' ? 'purge' : 'scrub');
                return { data: 0, error: null };
            }),
        }, {
            providerRunStore: {
                listUnreconciled: vi.fn(async () => []),
                reconcileUsage: vi.fn(),
            },
            recoverBetaCredit: async () => { events.push('recover'); return 1; },
            refreshBetaCredit: async () => { events.push('refresh'); throw new Error('unavailable'); },
            archiveBetaCredit: async () => { events.push('archive'); return 1; },
        });
        expect(events).toEqual(['blite', 'purge', 'recover', 'archive', 'scrub', 'refresh']);
        expect(summary).toMatchObject({
            betaCreditRecovered: 1,
            betaCreditArchived: 1,
            betaCreditRefreshAttempts: 1,
            betaCreditRefreshFailures: 1,
        });
    });

    it('refreshes all beta credit snapshots during an idle retention cycle', async () => {
        const refreshBetaCredit = vi.fn(async () => undefined);
        const summary = await runPreflightRetention({
            rpc: vi.fn(async () => ({ data: 0, error: null })),
        }, {
            providerRunStore: {
                listUnreconciled: vi.fn(async () => []),
                reconcileUsage: vi.fn(),
            },
            recoverBetaCredit: async () => 0,
            archiveBetaCredit: async () => 0,
            refreshBetaCredit,
        });

        expect(refreshBetaCredit).toHaveBeenCalledOnce();
        expect(summary).toMatchObject({
            betaCreditRecovered: 0,
            betaCreditRefreshAttempts: 1,
            betaCreditRefreshFailures: 0,
        });
    });

    it('still archives and scrubs when beta recovery fails', async () => {
        const archiveBetaCredit = vi.fn(async () => 2);
        const summary = await runPreflightRetention({
            rpc: vi.fn()
                .mockResolvedValueOnce({ data: [], error: null })
                .mockResolvedValueOnce({ data: 0, error: null })
                .mockResolvedValueOnce({ data: 0, error: null })
                .mockResolvedValueOnce({ data: 0, error: null }),
        }, {
            recoverBetaCredit: async () => { throw new Error('recover'); },
            archiveBetaCredit,
            refreshBetaCredit: vi.fn(),
        });
        expect(archiveBetaCredit).toHaveBeenCalledOnce();
        expect(summary).toMatchObject({
            terminalScrubbed: 0,
            betaCreditRecoveryFailures: 1,
            betaCreditArchived: 2,
            betaCreditRefreshAttempts: 1,
        });
    });
});
