import { describe, expect, it, vi } from 'vitest';
import {
    BETA_APIFY_SETTLEMENT_LOG,
    archiveSettledBetaApifyCredit,
    bestEffortBetaApifySettlement,
    recoverBetaApifyCredit,
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

    it('aborts every hanging maintenance RPC and exposes only a sanitized timeout', async () => {
        vi.useFakeTimers();
        const signals: AbortSignal[] = [];
        const rejectLate: Array<(reason?: unknown) => void> = [];
        const unhandled: unknown[] = [];
        const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
        process.on('unhandledRejection', onUnhandled);
        const rpc = vi.fn(() => {
            const pending = new Promise<{
                data: unknown;
                error: null | { message?: string };
            }>((_resolve, reject) => { rejectLate.push(reject); }) as Promise<{
                data: unknown;
                error: null | { message?: string };
            }> & {
                abortSignal(signal: AbortSignal): PromiseLike<{
                    data: unknown;
                    error: null | { message?: string };
                }>;
            };
            pending.abortSignal = (signal: AbortSignal) => {
                signals.push(signal);
                return pending;
            };
            return pending;
        });
        try {
            const operations = [
                settleBetaApifyRequestCredit({ rpc }, id),
                recoverBetaApifyCredit({ rpc }),
                archiveSettledBetaApifyCredit({ rpc }),
            ];
            const failures = operations.map(operation => (
                expect(operation).rejects.toThrow('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR')
            ));

            await vi.advanceTimersByTimeAsync(5_000);
            await Promise.all(failures);
            expect(signals).toHaveLength(3);
            expect(signals.every(signal => signal.aborted)).toBe(true);

            // A transport may reject after the caller-side timeout. Promise.race
            // must retain a rejection handler so no provider payload escapes as
            // an unhandled rejection.
            vi.useRealTimers();
            rejectLate.forEach(reject => reject(new Error('late provider secret')));
            await new Promise(resolve => setTimeout(resolve, 0));
            expect(unhandled).toEqual([]);
        } finally {
            process.off('unhandledRejection', onUnhandled);
            vi.useRealTimers();
        }
    });

    it('redacts a database lock-timeout payload at the targeted boundary', async () => {
        const rpc = vi.fn(async () => ({
            data: null,
            error: { message: 'canceling statement due to lock timeout raw-row-id' },
        }));
        await expect(settleBetaApifyRequestCredit({ rpc }, id))
            .rejects.toThrow('ANALYSIS_BETA_POOL_PERSISTENCE_ERROR');
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
