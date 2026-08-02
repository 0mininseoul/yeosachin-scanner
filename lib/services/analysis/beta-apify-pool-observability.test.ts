import { describe, expect, it, vi } from 'vitest';
import {
    BETA_APIFY_POOL_OBSERVABILITY_RPC,
    loadBetaApifyPoolObservability,
    observeBetaApifyPoolHealth,
} from './beta-apify-pool-observability';

const payload = {
    schemaVersion: 1,
    observedAt: '2026-08-02T04:05:06.000Z',
    runtimeEnabled: false,
    totalEffectiveHeadroomUsd: 12.25,
    staleSnapshotCount: 1,
    activeAllocationCount: 2,
    settlementLagMs: 45_000,
    overcommittedSlotCount: 0,
};

describe('beta Apify pool aggregate observability', () => {
    it('loads one strict aggregate-only service RPC response', async () => {
        const rpc = vi.fn().mockResolvedValue({ data: payload, error: null });

        await expect(loadBetaApifyPoolObservability({ rpc }, 300))
            .resolves.toEqual(payload);
        expect(rpc).toHaveBeenCalledWith(BETA_APIFY_POOL_OBSERVABILITY_RPC, {
            p_max_age_seconds: 300,
        });
        expect(JSON.stringify(payload)).not.toMatch(
            /(?:request|preflight|user|account|instagram|token|cookie).*id/i
        );
    });

    it('rejects identifiers, secondary, unknown keys, invalid counts, and malformed ages', async () => {
        const invalid = [
            { ...payload, credentialSlot: 'secondary' },
            { ...payload, userId: '11111111-1111-4111-8111-111111111111' },
            { ...payload, staleSnapshotCount: 7 },
            { ...payload, overcommittedSlotCount: -1 },
            { ...payload, settlementLagMs: Number.POSITIVE_INFINITY },
        ];
        for (const data of invalid) {
            await expect(loadBetaApifyPoolObservability({
                rpc: vi.fn().mockResolvedValue({ data, error: null }),
            }, 300)).rejects.toThrow('ANALYSIS_BETA_POOL_OBSERVABILITY_PERSISTENCE_ERROR');
        }
        const rpc = vi.fn();
        await expect(loadBetaApifyPoolObservability({ rpc }, 0))
            .rejects.toThrow('ANALYSIS_BETA_POOL_OBSERVABILITY_VALIDATION_ERROR');
        expect(rpc).not.toHaveBeenCalled();
    });

    it('redacts database errors at the parser boundary', async () => {
        const rpc = vi.fn().mockResolvedValue({
            data: null,
            error: { message: 'postgres://secret-host raw-row-id' },
        });
        const error = await loadBetaApifyPoolObservability({ rpc }, 300)
            .catch((caught: unknown) => caught);
        expect(error).toEqual(new Error('ANALYSIS_BETA_POOL_OBSERVABILITY_PERSISTENCE_ERROR'));
        expect(String(error)).not.toContain('secret-host');
    });

    it('emits real aggregate health best-effort without identifiers', async () => {
        const emit = vi.fn();
        const rpc = vi.fn().mockResolvedValue({ data: payload, error: null });
        await expect(observeBetaApifyPoolHealth({ rpc }, { emit }, 300))
            .resolves.toBe(true);
        expect(emit).toHaveBeenCalledWith({
            event: 'betatest_apify_credit.pool_health_observed',
            severity: 'warn',
            fields: {
                total_effective_headroom_usd: 12.25,
                stale_snapshot_count: 1,
                settlement_lag_ms: 45_000,
                active_allocation_count: 2,
                overcommitted_slot_count: 0,
                runtime_enabled: false,
            },
        });
        expect(JSON.stringify(emit.mock.calls)).not.toMatch(/user|request|preflight|account/i);

        await expect(observeBetaApifyPoolHealth({
            rpc: vi.fn().mockRejectedValue(new Error('secret')),
        }, { emit: () => { throw new Error('logger failed'); } }, 300))
            .resolves.toBe(false);
    });
});
