import { describe, expect, it, vi } from 'vitest';
import {
    VertexAiBudgetExceededError,
    type VertexAiBudgetLimits,
    type VertexAiBudgetReservationInput,
} from './vertex-ai-cost-policy';
import {
    createSupabaseVertexAiBudgetStore,
    type VertexAiBudgetRpcClient,
} from './vertex-ai-budget-store';

const input: VertexAiBudgetReservationInput = {
    reservationKey: 'run-1:feature:1',
    runId: 'run-1',
    orderId: 'order-1',
    operationKey: 'feature:1',
    attempt: 1,
    route: 'high_value',
    modelName: 'gemini-3.7-flash',
    location: 'global',
    inputTokens: 1_000,
    maxOutputTokens: 1_000,
};

const row = {
    reservation_id: 'b9f0f21d-7f4f-45a5-b3a8-0b3a7be9b43f',
    reservation_key: input.reservationKey,
    run_id: input.runId,
    order_id: input.orderId,
    day_key: '2026-09-02',
    route: input.route,
    model_name: input.modelName,
    attempt: input.attempt,
    estimated_cost_usd: 0.009,
    actual_cost_usd: null,
};

describe('Supabase Vertex AI budget store adapter', () => {
    it('sends strict pre-dispatch estimates and maps settlement telemetry', async () => {
        const calls: Array<{ name: string; args: Readonly<Record<string, unknown>> }> = [];
        const client: VertexAiBudgetRpcClient = {
            rpc: vi.fn(async (name, args) => {
                calls.push({ name, args });
                if (name === 'reserve_vertex_ai_budget') {
                    return { data: [row], error: null };
                }
                if (name === 'settle_vertex_ai_budget') {
                    return { data: [{ ...row, actual_cost_usd: 0.004 }], error: null };
                }
                if (name === 'cancel_vertex_ai_budget') return { data: null, error: null };
                return {
                    data: {
                        run: { 'run-1': 0.004 },
                        order: { 'order-1': 0.004 },
                        day: { '2026-09-02': 0.004 },
                    },
                    error: null,
                };
            }),
        };
        const limits: VertexAiBudgetLimits = {
            perRunUsd: 1.25,
            perOrderUsd: 2.5,
            dailyUsd: 12.5,
        };
        const store = createSupabaseVertexAiBudgetStore(client, limits);

        const reservation = await store.reserve(input);
        expect(reservation.estimatedCostUsd).toBe(0.009);
        expect(calls[0]).toMatchObject({
            name: 'reserve_vertex_ai_budget',
            args: expect.objectContaining({
                p_reservation_key: input.reservationKey,
                p_order_id: input.orderId,
                p_estimated_cost_usd: 0.009,
                p_per_run_limit_usd: limits.perRunUsd,
                p_per_order_limit_usd: limits.perOrderUsd,
                p_daily_limit_usd: limits.dailyUsd,
            }),
        });
        const settled = await store.settle(reservation, { actualCostUsd: 0.004 });
        expect(settled.actualCostUsd).toBe(0.004);
        await store.cancel(reservation);
        expect(await store.snapshot()).toEqual({
            run: { 'run-1': 0.004 },
            order: { 'order-1': 0.004 },
            day: { '2026-09-02': 0.004 },
        });
    });

    it('maps a database budget denial to a typed fail-closed error', async () => {
        const client: VertexAiBudgetRpcClient = {
            rpc: async () => ({
                data: null,
                error: { message: 'VERTEX_AI_BUDGET_EXCEEDED:day:2026-09-02' },
            }),
        };
        await expect(createSupabaseVertexAiBudgetStore(client).reserve(input))
            .rejects.toBeInstanceOf(VertexAiBudgetExceededError);
    });
});
