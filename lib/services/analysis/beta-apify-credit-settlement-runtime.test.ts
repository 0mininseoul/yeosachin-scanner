import { describe, expect, it, vi } from 'vitest';
import {
    BETA_APIFY_SETTLEMENT_LOG,
    bestEffortBetaApifySettlement,
    settleBetaApifyPreflightCredit,
    settleBetaApifyRequestCredit,
} from './beta-apify-credit-settlement-runtime';

const id = '123e4567-e89b-42d3-a456-426614174000';

describe('beta Apify terminal settlement runtime', () => {
    it('uses sanitized targeted RPCs only', async () => {
        const rpc = vi.fn(async () => ({ data: null, error: null }));
        await settleBetaApifyRequestCredit({ rpc }, id);
        await settleBetaApifyPreflightCredit({ rpc }, id);
        expect(rpc.mock.calls).toEqual([
            ['settle_analysis_beta_apify_request_credit', { p_request_id: id }],
            ['settle_analysis_beta_apify_preflight_credit', { p_preflight_id: id }],
        ]);
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
