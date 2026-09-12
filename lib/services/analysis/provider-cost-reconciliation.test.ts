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
        rpc: vi.fn(async (name: string) => ({
            data: name === 'enqueue_analysis_order_audit_bundle' ? null : true,
            error: null,
        })),
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
    request_id: '123e4567-e89b-42d3-a456-426614174000',
};

describe('provider cost reconciliation', () => {
    it('finalizes stable usage and retains the order-audit enqueue', async () => {
        const db = database([settledRow]);
        await expect(reconcileSettledAnalysisProviderCosts(db as never, undefined, {
            clientForSlot: () => ({
                run: () => ({ get: async () => ({ status: 'SUCCEEDED', usageTotalUsd: 0.0754 }) }),
            }),
        })).resolves.toEqual({ eligible: 1, finalized: 1, failed: 0, hasMore: false });
        expect(db.rpc).toHaveBeenCalledWith('finalize_analysis_provider_cost', expect.any(Object));
        expect(db.rpc).toHaveBeenCalledWith('enqueue_analysis_order_audit_bundle', {
            p_request_id: settledRow.request_id,
        });
        expect(db.rpc.mock.calls.map((call: unknown[]) => call[0])).toEqual([
            'finalize_analysis_provider_cost',
            'enqueue_analysis_order_audit_bundle',
        ]);
    });

    it('keeps an over-cap provider snapshot pending', async () => {
        const db = database([settledRow]);
        await expect(reconcileSettledAnalysisProviderCosts(db as never, undefined, {
            clientForSlot: () => ({
                run: () => ({ get: async () => ({ status: 'SUCCEEDED', usageTotalUsd: 0.08 }) }),
            }),
        })).resolves.toEqual({ eligible: 1, finalized: 0, failed: 1, hasMore: false });
        expect(db.rpc).not.toHaveBeenCalled();
    });

    it('reports bounded backlog without an unbounded retry or mirror branch', async () => {
        const rows = Array.from({ length: 65 }, (_, index) => ({
            ...settledRow,
            run_id: `Abcdefgh1234${String(index).padStart(4, '0')}`,
        }));
        const db = database(rows);
        await expect(reconcileSettledAnalysisProviderCosts(db as never, undefined, {
            clientForSlot: () => ({
                run: () => ({ get: async () => ({ status: 'SUCCEEDED', usageTotalUsd: 0.0754 }) }),
            }),
        })).resolves.toEqual({ eligible: 64, finalized: 64, failed: 0, hasMore: true });
        expect(db.chain.limit).toHaveBeenCalledWith(65);
    });
});
