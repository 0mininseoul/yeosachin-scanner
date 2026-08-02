import { describe, expect, it, vi } from 'vitest';
import {
    BETA_APIFY_SETTLEMENT_LOG,
    bestEffortBetaApifySettlement,
    settleBetaApifyPreflightCredit,
    settleBetaApifyRequestCredit,
    refreshBetaApifyCreditSnapshots,
} from './beta-apify-credit-settlement-runtime';

const id = '123e4567-e89b-42d3-a456-426614174000';

describe('beta Apify terminal settlement runtime', () => {
    it('uses sanitized targeted RPCs only', async () => {
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: null, error: null })
            .mockResolvedValueOnce({ data: {
                allocationId: id,
                lifecycleState: 'settled',
                settledFamilies: 1,
                heldFamilies: 0,
                actualUsd: 0,
                releasedUsd: 0.0052,
            }, error: null });
        await expect(settleBetaApifyRequestCredit({ rpc }, id)).resolves.toBe(false);
        await expect(settleBetaApifyPreflightCredit({ rpc }, id)).resolves.toBe(true);
        expect(rpc.mock.calls).toEqual([
            ['settle_analysis_beta_apify_request_credit', { p_request_id: id }],
            ['settle_analysis_beta_apify_preflight_credit', { p_preflight_id: id }],
        ]);
    });

    it('bounds a hanging exact-six read and never starts the snapshot upsert', async () => {
        vi.useFakeTimers();
        const rpc = vi.fn();
        const cycle = {
            startAt: '2026-08-01T00:00:00.000Z',
            endAt: '2026-09-01T00:00:00.000Z',
        };
        const fast = {
            limits: async () => ({
                limits: { maxMonthlyUsageUsd: 5 },
                current: { monthlyUsageUsd: 1 },
                monthlyUsageCycle: cycle,
            }),
            monthlyUsage: async () => ({
                totalUsageCreditsUsdAfterVolumeDiscount: 1,
                usageCycle: cycle,
            }),
        };
        const pending = refreshBetaApifyCreditSnapshots({ rpc }, {
            now: () => Date.parse('2026-08-02T00:00:00.000Z'),
            clientForSlot: slot => slot === 'septenary'
                ? { ...fast, limits: () => new Promise(() => undefined) }
                : fast,
        });
        const rejected = expect(pending).rejects.toThrow('REFRESH_TIMEOUT');
        await vi.advanceTimersByTimeAsync(15_000);
        await rejected;
        expect(rpc).not.toHaveBeenCalled();
        vi.useRealTimers();
    });

    it('swallows a post-commit settlement fault with a fixed redacted log', async () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await expect(bestEffortBetaApifySettlement(async () => {
            throw new Error('secret provider payload');
        })).resolves.toBe(false);
        expect(spy).toHaveBeenCalledWith(BETA_APIFY_SETTLEMENT_LOG);
        expect(spy.mock.calls.flat().join(' ')).not.toContain('secret');
        spy.mockRestore();
    });
});
