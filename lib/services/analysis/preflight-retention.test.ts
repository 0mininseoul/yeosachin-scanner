import { describe, expect, it, vi } from 'vitest';
import {
    PREFLIGHT_RETENTION_BATCH_LIMIT,
    runPreflightRetention,
} from './preflight-retention';

describe('preflight retention maintenance', () => {
    it('reconciles bounded paid runs before both retention RPCs', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: [], error: null })
            .mockResolvedValueOnce({ data: 12, error: null })
            .mockResolvedValueOnce({ data: 4, error: null });
        await expect(runPreflightRetention({ rpc })).resolves.toEqual({
            providerCosts: { eligible: 0, finalized: 0, failed: 0, hasMore: false },
            expiredPurged: 12,
            terminalScrubbed: 4,
        });
        expect(rpc.mock.calls).toEqual([
            ['list_analysis_preflight_unreconciled_provider_runs', {
                p_limit: 17,
            }],
            ['purge_expired_analysis_v2_preflights', {
                p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
            }],
            ['scrub_terminal_analysis_v2_preflights', {
                p_limit: PREFLIGHT_RETENTION_BATCH_LIMIT,
            }],
        ]);
    });

    it('fails closed on an RPC error or an impossible count', async () => {
        await expect(runPreflightRetention({
            rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'no' } }),
        })).rejects.toThrow('PREFLIGHT_PROVIDER_RUN_PERSISTENCE_ERROR');

        await expect(runPreflightRetention({
            rpc: vi.fn()
                .mockResolvedValueOnce({ data: [], error: null })
                .mockResolvedValueOnce({ data: 9999, error: null }),
        })).rejects.toThrow('invalid purge_expired_analysis_v2_preflights result');
    });

    it('reports a failed cost read while retention safely proceeds behind the SQL delete fence', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: 1, error: null })
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
            providerCosts: { eligible: 1, finalized: 0, failed: 1, hasMore: false },
            expiredPurged: 1,
            terminalScrubbed: 2,
        });
        expect(providerRunStore.reconcileUsage).not.toHaveBeenCalled();
        expect(rpc.mock.calls.map(call => call[0])).toEqual([
            'purge_expired_analysis_v2_preflights',
            'scrub_terminal_analysis_v2_preflights',
        ]);
    });
});
