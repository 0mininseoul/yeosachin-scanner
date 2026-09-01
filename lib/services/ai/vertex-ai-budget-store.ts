import {
    estimateVertexAiPreDispatchCost,
    vertexAiBudgetLimitsFromEnv,
    VERTEX_AI_BUDGET_RPC_NAMES,
    VertexAiBudgetExceededError,
    type VertexAiBudgetLimits,
    type VertexAiBudgetReservation,
    type VertexAiBudgetSnapshot,
    type VertexAiBudgetStore,
} from './vertex-ai-cost-policy';

/** Minimal structural interface so this adapter works with Supabase without importing its client. */
export interface VertexAiBudgetRpcResponse {
    data: unknown;
    error: { message?: string; code?: string } | null;
}

export interface VertexAiBudgetRpcClient {
    rpc(
        functionName: string,
        args: Readonly<Record<string, unknown>>,
    ): PromiseLike<VertexAiBudgetRpcResponse>;
}

function firstRpcRow(value: unknown): unknown {
    return Array.isArray(value) ? value[0] : value;
}

function stringField(row: Record<string, unknown>, snake: string, camel: string): string {
    const value = row[snake] ?? row[camel];
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error('VERTEX_AI_BUDGET_RPC_RESPONSE_INVALID');
    }
    return value;
}

function numberField(row: Record<string, unknown>, snake: string, camel: string): number {
    const value = row[snake] ?? row[camel];
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error('VERTEX_AI_BUDGET_RPC_RESPONSE_INVALID');
    }
    return parsed;
}

function nullableNumberField(
    row: Record<string, unknown>,
    snake: string,
    camel: string,
): number | null {
    const value = row[snake] ?? row[camel];
    if (value === null || value === undefined) return null;
    return numberField({ value }, 'value', 'value');
}

function routeField(row: Record<string, unknown>): VertexAiBudgetReservation['route'] {
    const route = stringField(row, 'route', 'route');
    if (route !== 'default' && route !== 'high_value' && route !== 'ambiguous') {
        throw new Error('VERTEX_AI_BUDGET_RPC_RESPONSE_INVALID');
    }
    return route;
}

function reservationFromRpc(
    value: unknown,
): VertexAiBudgetReservation {
    const row = firstRpcRow(value);
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        throw new Error('VERTEX_AI_BUDGET_RPC_RESPONSE_INVALID');
    }
    const record = row as Record<string, unknown>;
    return {
        reservationId: stringField(record, 'reservation_id', 'reservationId'),
        reservationKey: stringField(record, 'reservation_key', 'reservationKey'),
        runId: stringField(record, 'run_id', 'runId'),
        orderId: stringField(record, 'order_id', 'orderId'),
        dayKey: stringField(record, 'day_key', 'dayKey'),
        route: routeField(record),
        modelName: stringField(record, 'model_name', 'modelName'),
        attempt: Math.trunc(numberField(record, 'attempt', 'attempt')),
        estimatedCostUsd: numberField(record, 'estimated_cost_usd', 'estimatedCostUsd'),
        actualCostUsd: nullableNumberField(record, 'actual_cost_usd', 'actualCostUsd'),
    };
}

function throwRpcError(error: { message?: string; code?: string }): never {
    const message = error.message?.trim() || 'VERTEX_AI_BUDGET_RPC_FAILED';
    const match = /^VERTEX_AI_BUDGET_EXCEEDED:(run|order|day)(?::([^:]+))?/.exec(message);
    if (match) {
        throw new VertexAiBudgetExceededError(
            match[1] as 'run' | 'order' | 'day',
            match[2] ?? '',
            0,
            0,
            0,
        );
    }
    throw new Error(`VERTEX_AI_BUDGET_RPC_FAILED:${message}`);
}

async function callRpc(
    client: VertexAiBudgetRpcClient,
    functionName: string,
    args: Readonly<Record<string, unknown>>,
): Promise<unknown> {
    const response = await client.rpc(functionName, args);
    if (response.error) throwRpcError(response.error);
    return response.data;
}

/**
 * Shared-store implementation for production Supabase deployments. The RPCs perform the
 * scope locks and identity checks in one database transaction; this adapter never falls back to
 * an in-process counter after an RPC error.
 */
export function createSupabaseVertexAiBudgetStore(
    client: VertexAiBudgetRpcClient,
    limits: VertexAiBudgetLimits = vertexAiBudgetLimitsFromEnv(),
): VertexAiBudgetStore {
    return {
        async reserve(input) {
            const estimate = estimateVertexAiPreDispatchCost(input).totalCostUsd;
            const data = await callRpc(client, VERTEX_AI_BUDGET_RPC_NAMES.reserve, {
                p_reservation_key: input.reservationKey,
                p_run_id: input.runId,
                // Let the RPC resolve a paid earlybird order from result_request_id when the
                // caller only has a request/run ID; explicit order IDs still win.
                p_order_id: input.orderId ?? null,
                p_operation_key: input.operationKey,
                p_attempt: input.attempt,
                p_route: input.route,
                p_model_name: input.modelName,
                p_location: input.location ?? 'global',
                p_input_tokens: input.inputTokens,
                p_max_output_tokens: input.maxOutputTokens,
                p_estimated_cost_usd: estimate,
                p_day_key: input.dayKey ?? null,
                p_per_run_limit_usd: limits.perRunUsd,
                p_per_order_limit_usd: limits.perOrderUsd,
                p_daily_limit_usd: limits.dailyUsd,
            });
            return reservationFromRpc(data);
        },

        async settle(reservation, input) {
            const data = await callRpc(client, VERTEX_AI_BUDGET_RPC_NAMES.settle, {
                p_reservation_key: reservation.reservationKey,
                p_reservation_id: reservation.reservationId,
                p_actual_cost_usd: input.actualCostUsd ?? null,
            });
            return reservationFromRpc(data);
        },

        async cancel(reservation) {
            await callRpc(client, VERTEX_AI_BUDGET_RPC_NAMES.cancel, {
                p_reservation_key: reservation.reservationKey,
                p_reservation_id: reservation.reservationId,
            });
        },

        async snapshot(): Promise<VertexAiBudgetSnapshot> {
            const data = firstRpcRow(await callRpc(
                client,
                VERTEX_AI_BUDGET_RPC_NAMES.snapshot,
                {},
            ));
            if (!data || typeof data !== 'object' || Array.isArray(data)) {
                throw new Error('VERTEX_AI_BUDGET_RPC_RESPONSE_INVALID');
            }
            const record = data as Record<string, unknown>;
            const readMap = (snake: string, camel: string): Readonly<Record<string, number>> => {
                const value = record[snake] ?? record[camel];
                if (!value || typeof value !== 'object' || Array.isArray(value)) {
                    throw new Error('VERTEX_AI_BUDGET_RPC_RESPONSE_INVALID');
                }
                return Object.fromEntries(Object.entries(value).map(([key, amount]) => {
                    const parsed = typeof amount === 'number' ? amount : Number(amount);
                    if (!Number.isFinite(parsed) || parsed < 0) {
                        throw new Error('VERTEX_AI_BUDGET_RPC_RESPONSE_INVALID');
                    }
                    return [key, parsed];
                }));
            };
            return {
                run: readMap('run', 'run'),
                order: readMap('order', 'order'),
                day: readMap('day', 'day'),
            };
        },
    };
}
