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
import { BETA_APIFY_FREE_CREDENTIAL_SLOTS } from './beta-apify-credit-pool';

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

    it('records aggregate refresh and settlement telemetry without changing either result', async () => {
        const emit = vi.fn();
        const rpc = vi.fn().mockResolvedValue({ data: {
            allocationId: id,
            lifecycleState: 'settled',
            settledFamilies: 1,
            heldFamilies: 0,
            actualUsd: 0.02,
            releasedUsd: 0.03,
        }, error: null });
        await expect(settleBetaApifyRequestCredit({ rpc }, id, { telemetry: { emit } }))
            .resolves.toBe(true);

        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'betatest_apify_credit.settlement_completed',
            fields: expect.objectContaining({ actual_usd: 0.02, released_usd: 0.03 }),
        }));
        expect(JSON.stringify(emit.mock.calls)).not.toContain(id);
    });

    it('emits bounded recovered settlements and aggregate health without changing recovery', async () => {
        const emit = vi.fn();
        const settlement = {
            allocationId: id, lifecycleState: 'settled', settledFamilies: 1,
            heldFamilies: 0, actualUsd: 0.02, releasedUsd: 0.03,
        };
        const pool = {
            schemaVersion: 1, observedAt: '2026-08-02T00:00:00.000Z',
            runtimeEnabled: true, totalEffectiveHeadroomUsd: 3,
            staleSnapshotCount: 0, activeAllocationCount: 1,
            settlementLagMs: 0, overcommittedSlotCount: 0,
        };
        const rpc = vi.fn()
            .mockResolvedValueOnce({ data: [settlement, settlement], error: null })
            .mockResolvedValueOnce({ data: pool, error: null });

        await expect(recoverBetaApifyCredit(
            { rpc }, 100, { telemetry: { emit }, maxSnapshotAgeSeconds: 300 }
        )).resolves.toBe(2);
        expect(emit.mock.calls.filter(([event]) => (
            event.event === 'betatest_apify_credit.settlement_completed'
        ))).toHaveLength(2);
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'betatest_apify_credit.pool_health_observed',
        }));
        expect(JSON.stringify(emit.mock.calls)).not.toContain(id);

        const throwingRpc = vi.fn()
            .mockResolvedValueOnce({ data: [settlement], error: null })
            .mockResolvedValueOnce({ data: pool, error: null });
        await expect(recoverBetaApifyCredit(
            { rpc: throwingRpc }, 100,
            { telemetry: { emit: () => { throw new Error('telemetry'); } } }
        )).resolves.toBe(1);
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
        const emit = vi.fn();
        const pending = refreshBetaApifyCreditSnapshots({ rpc }, {
            now: () => Date.parse('2026-08-02T00:00:00.000Z'),
            telemetry: { emit },
            clientForSlot: slot => slot === 'septenary'
                ? { ...fast, limits: () => new Promise(() => undefined) }
                : fast,
        });
        const rejected = expect(pending).rejects.toThrow('REFRESH_TIMEOUT');
        await vi.advanceTimersByTimeAsync(15_000);
        await rejected;
        expect(rpc).not.toHaveBeenCalled();
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'betatest_apify_credit.refresh_failed',
        }));
        vi.useRealTimers();
    });

    it('emits refresh headroom from the debit-aware persisted RPC result', async () => {
        const observedAt = '2026-08-02T00:00:00.000Z';
        const cycle = {
            startAt: '2026-08-01T00:00:00.000Z',
            endAt: '2026-09-01T00:00:00.000Z',
        };
        const persisted = BETA_APIFY_FREE_CREDENTIAL_SLOTS.map((credentialSlot, index) => ({
            credentialSlot, monthlyLimitUsd: 10, monthlyUsageUsd: 1,
            billingCycleStartAt: cycle.startAt, billingCycleEndAt: cycle.endAt,
            observedAt, healthState: 'healthy', effectiveHeadroomUsd: index + 0.25,
        }));
        const rpc = vi.fn().mockResolvedValue({ data: persisted, error: null });
        const emit = vi.fn();
        const client = {
            limits: async () => ({ limits: { maxMonthlyUsageUsd: 10 }, current: { monthlyUsageUsd: 1 }, monthlyUsageCycle: cycle }),
            monthlyUsage: async () => ({ totalUsageCreditsUsdAfterVolumeDiscount: 1, usageCycle: cycle }),
        };

        await refreshBetaApifyCreditSnapshots({ rpc }, {
            now: () => Date.parse(observedAt), clientForSlot: () => client,
            telemetry: { emit },
        });

        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'betatest_apify_credit.refresh_completed',
            fields: expect.objectContaining({ total_effective_headroom_usd: 16.5 }),
        }));
    });

    it('emits a fixed refresh failure for a provider read error and stays sanitized', async () => {
        const emit = vi.fn();
        const secret = 'provider-token-and-account-id';
        await expect(refreshBetaApifyCreditSnapshots({ rpc: vi.fn() }, {
            now: () => Date.parse('2026-08-02T00:00:00.000Z'),
            telemetry: { emit },
            clientForSlot: () => ({
                limits: async () => { throw new Error(secret); },
                monthlyUsage: async () => ({}),
            }),
        })).rejects.toThrow('ANALYSIS_BETA_APIFY_CREDIT_REFRESH_ERROR');
        expect(emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'betatest_apify_credit.refresh_failed', fields: expect.any(Object),
        }));
        expect(JSON.stringify(emit.mock.calls)).not.toContain(secret);
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
