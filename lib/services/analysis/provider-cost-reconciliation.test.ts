import { describe, expect, it, vi } from 'vitest';
import { reconcileSettledAnalysisProviderCosts } from './provider-cost-reconciliation';

function database(rows: unknown[]) {
    const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        neq: vi.fn(),
        is: vi.fn(),
        lte: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.neq.mockReturnValue(chain);
    chain.is.mockReturnValue(chain);
    chain.lte.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);
    chain.limit.mockResolvedValue({ data: rows, error: null });
    return {
        from: vi.fn(() => chain),
        rpc: vi.fn(async (name: string) => name === 'enqueue_analysis_order_audit_bundle'
            ? { data: { status: 'queued', requestId: '123e4567-e89b-42d3-a456-426614174000' }, error: null }
            : { data: true, error: null }),
        chain,
    };
}

const settledRow = {
    run_id: 'Abcdefgh12345678',
    logical_provider: 'apify',
    actor_id: 'actor/profile',
    credential_slot: 'primary',
    status: 'succeeded',
    max_charge_usd: '0.078',
};

const requestScopedSettledRow = {
    ...settledRow,
    request_id: '123e4567-e89b-42d3-a456-426614174000',
};

describe('provider cost reconciliation', () => {
    it('finalizes the authenticated stable usage after the settlement cutoff', async () => {
        const db = database([settledRow]);
        const get = vi.fn().mockResolvedValue({
            status: 'SUCCEEDED',
            usageTotalUsd: 0.0754,
        });

        await expect(reconcileSettledAnalysisProviderCosts(
            db as never,
            '123e4567-e89b-42d3-a456-426614174000',
            {
                now: new Date('2026-07-13T01:30:00.000Z'),
                clientForSlot: () => ({ run: () => ({ get }) }),
            }
        )).resolves.toEqual({ eligible: 1, finalized: 1, failed: 0, hasMore: false });

        expect(db.chain.lte).toHaveBeenCalledWith(
            'terminal_at',
            '2026-07-13T01:29:30.000Z'
        );
        expect(db.rpc).toHaveBeenCalledWith('finalize_analysis_provider_cost', {
            p_run_id: settledRow.run_id,
            p_logical_provider: 'apify',
            p_actor_id: 'actor/profile',
            p_credential_slot: 'primary',
            p_status: 'succeeded',
            p_usage_total_usd: 0.0754,
        });
    });

    it('leaves an over-cap or mismatched snapshot pending without blocking analysis', async () => {
        const db = database([settledRow]);
        const result = await reconcileSettledAnalysisProviderCosts(
            db as never,
            '123e4567-e89b-42d3-a456-426614174000',
            {
                clientForSlot: () => ({
                    run: () => ({
                        get: async () => ({ status: 'SUCCEEDED', usageTotalUsd: 0.08 }),
                    }),
                }),
            }
        );
        expect(result).toEqual({ eligible: 1, finalized: 0, failed: 1, hasMore: false });
        expect(db.rpc).not.toHaveBeenCalled();
    });

    // Free target-profile runs settle through analysis_preflight_provider_runs;
    // this legacy request cost ledger remains primary/secondary-only.
    it('rejects free-pool aliases because this ledger reconciler remains primary/secondary-only', async () => {
        const db = database([{ ...settledRow, credential_slot: 'octonary' }]);
        const selectedSlots: string[] = [];
        const get = vi.fn().mockResolvedValue({
            status: 'SUCCEEDED',
            usageTotalUsd: 0.0754,
        });

        await expect(reconcileSettledAnalysisProviderCosts(db as never, undefined, {
            clientForSlot: slot => {
                selectedSlots.push(slot);
                return { run: () => ({ get }) };
            },
        })).resolves.toEqual({ eligible: 1, finalized: 0, failed: 1, hasMore: false });

        expect(selectedSlots).toEqual([]);
        expect(db.rpc).not.toHaveBeenCalled();
    });

    it('can reconcile the oldest global rows without a request filter', async () => {
        const db = database([settledRow]);
        const get = vi.fn().mockResolvedValue({
            status: 'SUCCEEDED',
            usageTotalUsd: 0.0754,
        });

        await expect(reconcileSettledAnalysisProviderCosts(db as never, undefined, {
            clientForSlot: () => ({ run: () => ({ get }) }),
        })).resolves.toEqual({ eligible: 1, finalized: 1, failed: 0, hasMore: false });

        expect(db.chain.eq).not.toHaveBeenCalled();
        expect(db.chain.order).toHaveBeenCalledWith('terminal_at', { ascending: true });
    });

    it('reports a global backlog beyond the bounded reconciliation batch', async () => {
        const rows = Array.from({ length: 65 }, (_, index) => ({
            ...settledRow,
            run_id: `Abcdefgh1234${String(index).padStart(4, '0')}`,
        }));
        const db = database(rows);

        await expect(reconcileSettledAnalysisProviderCosts(db as never, undefined, {
            clientForSlot: () => ({
                run: () => ({
                    get: async () => ({ status: 'SUCCEEDED', usageTotalUsd: 0.0754 }),
                }),
            }),
        })).resolves.toEqual({
            eligible: 64,
            finalized: 64,
            failed: 0,
            hasMore: true,
        });
        expect(db.chain.limit).toHaveBeenCalledWith(65);
        expect(db.rpc).toHaveBeenCalledTimes(64);
    });

    it('enqueues a corrected order audit after a settled provider cost commits', async () => {
        const db = database([requestScopedSettledRow]);

        await expect(reconcileSettledAnalysisProviderCosts(db as never, undefined, {
            clientForSlot: () => ({
                run: () => ({
                    get: async () => ({ status: 'SUCCEEDED', usageTotalUsd: 0.0754 }),
                }),
            }),
        })).resolves.toEqual({ eligible: 1, finalized: 1, failed: 0, hasMore: false });

        expect(db.rpc).toHaveBeenCalledWith('enqueue_analysis_order_audit_bundle', {
            p_request_id: requestScopedSettledRow.request_id,
        });
    });
});
