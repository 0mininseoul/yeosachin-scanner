import { describe, expect, it, vi } from 'vitest';
import {
    parseEarlybirdCheckoutReconciliationCliArgs,
    runEarlybirdCheckoutReconciliationCli,
} from './reconcile-earlybird-checkout-no-sale';

const ORDER = '123e4567-e89b-42d3-a456-426614174001';
const CHECKED_AT = '2026-07-29T15:00:00.000Z';

describe('earlybird checkout reconciliation operator CLI', () => {
    it('requires exact bounded evidence flags and one valueless confirmation', () => {
        expect(parseEarlybirdCheckoutReconciliationCliArgs([
            '--order-id',
            ORDER,
            '--provider-checked-at',
            CHECKED_AT,
            '--reason',
            'provider_dashboard_no_sale',
            '--confirm-provider-dashboard-no-sale',
        ])).toEqual({
            orderId: ORDER,
            providerCheckedAt: CHECKED_AT,
            reason: 'provider_dashboard_no_sale',
        });
        for (const args of [
            ['--order-id', ORDER, '--provider-checked-at', CHECKED_AT, '--reason', 'provider_dashboard_no_sale'],
            ['--order-id', ORDER, '--provider-checked-at', CHECKED_AT, '--reason', 'other', '--confirm-provider-dashboard-no-sale'],
            ['--order-id', ORDER, '--provider-checked-at', 'not-a-date', '--reason', 'provider_dashboard_no_sale', '--confirm-provider-dashboard-no-sale'],
            ['--order-id', ORDER, '--provider-checked-at', CHECKED_AT, '--reason', 'provider_dashboard_no_sale', '--confirm-provider-dashboard-no-sale', '--confirm-provider-dashboard-no-sale'],
            ['--order-id', ORDER, '--provider-checked-at', CHECKED_AT, '--reason', 'provider_dashboard_no_sale', '--confirm-provider-dashboard-no-sale', '--target', 'private'],
        ]) {
            expect(() => parseEarlybirdCheckoutReconciliationCliArgs(args)).toThrow();
        }
    });

    it('does not call the reconciler without confirmation', async () => {
        const reconcile = vi.fn();
        await expect(runEarlybirdCheckoutReconciliationCli([
            '--order-id', ORDER,
            '--provider-checked-at', CHECKED_AT,
            '--reason', 'provider_dashboard_no_sale',
        ], { reconcile, writeStdout: vi.fn() })).rejects.toThrow();
        expect(reconcile).not.toHaveBeenCalled();
    });

    it('prints only a sanitized disposition and terminal status', async () => {
        const writeStdout = vi.fn();
        const reconcile = vi.fn(async () => ({
            disposition: 'reconciled' as const,
            status: 'payment_failed' as const,
        }));
        await expect(runEarlybirdCheckoutReconciliationCli([
            '--order-id', ORDER,
            '--provider-checked-at', CHECKED_AT,
            '--reason', 'provider_dashboard_no_sale',
            '--confirm-provider-dashboard-no-sale',
        ], { reconcile, writeStdout })).resolves.toEqual({
            disposition: 'reconciled',
            status: 'payment_failed',
        });
        expect(reconcile).toHaveBeenCalledWith({
            orderId: ORDER,
            providerCheckedAt: CHECKED_AT,
            reason: 'provider_dashboard_no_sale',
        });
        expect(writeStdout).toHaveBeenCalledWith(`${JSON.stringify({
            disposition: 'reconciled',
            status: 'payment_failed',
        })}\n`);
    });

    it('rejects identifier-bearing or unbounded RPC output before printing', async () => {
        const writeStdout = vi.fn();
        await expect(runEarlybirdCheckoutReconciliationCli([
            '--order-id', ORDER,
            '--provider-checked-at', CHECKED_AT,
            '--reason', 'provider_dashboard_no_sale',
            '--confirm-provider-dashboard-no-sale',
        ], {
            reconcile: async () => ({
                disposition: 'reconciled',
                status: 'payment_failed',
                orderId: ORDER,
            }),
            writeStdout,
        })).rejects.toThrow();
        expect(writeStdout).not.toHaveBeenCalled();
    });
});
