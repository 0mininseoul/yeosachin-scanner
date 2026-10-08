import 'server-only';

import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { assertDevUiAdministrator, assertDevUiTester } from './access';
import {
    DEV_UI_ERROR_CODES, DevUiStoreError,
    devUiCompleteCheckoutInputSchema, devUiCreateCheckoutInputSchema, devUiCreatePreflightInputSchema,
    devUiListAdminInputSchema, devUiListOwnerInputSchema, devUiOrderRowSchema,
    devUiPreflightRowSchema, devUiReadAdminInputSchema, devUiReadCheckoutInputSchema,
    devUiReadPreflightInputSchema, devUiReadRunInputSchema, devUiRunRowSchema,
    type DevUiOrderRow, type DevUiRunRow, type DevUiStore,
} from './contracts';
import { projectDevUiOrder, projectDevUiPreflight, projectDevUiRun } from './projection';

export interface DevUiRpcClient {
    rpc(name: string, arguments_: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

const createdPreflightSchema = z.object({ preflight: devUiPreflightRowSchema, created: z.boolean() });
const checkoutCreatedSchema = z.object({ order: devUiOrderRowSchema, replayed: z.boolean() });
const orderEnvelopeSchema = z.object({ order: devUiOrderRowSchema, run: devUiRunRowSchema.nullable() });
const completionSchema = orderEnvelopeSchema.extend({ replayed: z.boolean() });

function parse<T>(schema: z.ZodType<T>, value: unknown, code: 'DEV_UI_INVALID_INPUT' | 'DEV_UI_INVALID_ROW'): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new DevUiStoreError(code);
    return parsed.data;
}

function assertRow(valid: boolean): asserts valid {
    if (!valid) throw new DevUiStoreError('DEV_UI_INVALID_ROW');
}

function rpcFailure(error: unknown): DevUiStoreError {
    const message = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : '';
    const code = DEV_UI_ERROR_CODES.find(candidate => message === candidate);
    return new DevUiStoreError(code ?? 'DEV_UI_STORE_UNAVAILABLE');
}

function validateEnvelope(order: DevUiOrderRow, run: DevUiRunRow | null, ownerId?: string): void {
    assertRow(!ownerId || order.user_id === ownerId);
    if (order.status !== 'success') { assertRow(run === null); return; }
    assertRow(run !== null);
    assertRow(run.user_id === order.user_id && run.id === order.run_id && run.order_id === order.id
        && run.preflight_id === order.preflight_id && run.target_instagram_id === order.target_instagram_id
        && run.plan_id === order.plan_id && run.pricing_version === order.pricing_version
        && run.fixture_scenario === order.fixture_scenario && run.fixture_version === order.fixture_version
        && run.duration_seconds === order.duration_seconds && Date.parse(run.started_at) === Date.parse(order.completed_at!));
}

/** The client factory remains lazy; every operation repeats identity/access checks. */
export function createDevUiStore(dependencies: { getClient?: () => DevUiRpcClient; now?: () => Date } = {}): DevUiStore {
    const getClient: () => DevUiRpcClient = dependencies.getClient ?? (() => supabaseAdmin);
    const now = dependencies.now ?? (() => new Date());
    async function rpc(userId: string, name: string, arguments_: Record<string, unknown>, admin = false): Promise<unknown> {
        if (admin) assertDevUiAdministrator(userId); else assertDevUiTester(userId);
        try {
            const response = await getClient().rpc(name, arguments_);
            if (response.error) throw rpcFailure(response.error);
            return response.data;
        } catch (error) {
            if (error instanceof DevUiStoreError) throw error;
            throw new DevUiStoreError('DEV_UI_STORE_UNAVAILABLE');
        }
    }
    return {
        async createOrReplayPreflight(input) {
            assertDevUiTester(input.userId);
            const parsed = parse(devUiCreatePreflightInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.userId, 'dev_ui_create_preflight', { p_user_id: parsed.userId, p_target_instagram_id: parsed.targetInstagramId,
                p_idempotency_key: parsed.idempotencyKey, p_fixture_scenario: parsed.fixtureScenario });
            const result = parse(createdPreflightSchema, data, 'DEV_UI_INVALID_ROW');
            assertRow(result.preflight.user_id === parsed.userId && result.preflight.target_instagram_id === parsed.targetInstagramId
                && result.preflight.idempotency_key === parsed.idempotencyKey && result.preflight.fixture_scenario === parsed.fixtureScenario);
            return { preflightId: result.preflight.id, expiresAt: result.preflight.expires_at, created: result.created };
        },
        async createOrReplayCheckout(input) {
            assertDevUiTester(input.userId);
            const parsed = parse(devUiCreateCheckoutInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.userId, 'dev_ui_create_checkout', { p_user_id: parsed.userId, p_preflight_id: parsed.preflightId,
                p_plan_id: parsed.planId, p_disclosure_accepted: parsed.disclosureAccepted });
            const { order } = parse(checkoutCreatedSchema, data, 'DEV_UI_INVALID_ROW');
            assertRow(order.user_id === parsed.userId && order.preflight_id === parsed.preflightId && order.plan_id === parsed.planId);
            return { orderId: order.id, nextUrl: `/dev-ui/checkout/${order.id}`, expiresAt: order.expires_at };
        },
        async completeCheckout(input) {
            assertDevUiTester(input.userId);
            const parsed = parse(devUiCompleteCheckoutInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.userId, 'dev_ui_complete_checkout', { p_user_id: parsed.userId, p_order_id: parsed.orderId, p_outcome: parsed.outcome });
            const { order, run, replayed } = parse(completionSchema, data, 'DEV_UI_INVALID_ROW');
            validateEnvelope(order, run, parsed.userId);
            assertRow(order.id === parsed.orderId && order.status === parsed.outcome);
            if (order.status === 'success' && run) return { orderId: order.id, status: 'success', runId: run.id, replayed };
            assertRow(order.status === 'cancel' || order.status === 'failure');
            return { orderId: order.id, status: order.status, runId: null, replayed };
        },
        async readPreflight(input) {
            assertDevUiTester(input.userId);
            const parsed = parse(devUiReadPreflightInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.userId, 'dev_ui_read_preflight', { p_user_id: parsed.userId, p_preflight_id: parsed.preflightId });
            if (data === null) return null;
            const row = parse(devUiPreflightRowSchema, data, 'DEV_UI_INVALID_ROW');
            assertRow(row.user_id === parsed.userId && row.id === parsed.preflightId);
            return projectDevUiPreflight(row, now());
        },
        async readCheckout(input) {
            assertDevUiTester(input.userId);
            const parsed = parse(devUiReadCheckoutInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.userId, 'dev_ui_read_checkout', { p_user_id: parsed.userId, p_order_id: parsed.orderId });
            if (data === null) return null;
            const { order, run } = parse(orderEnvelopeSchema, data, 'DEV_UI_INVALID_ROW');
            validateEnvelope(order, run, parsed.userId); assertRow(order.id === parsed.orderId);
            return projectDevUiOrder(order, run, now());
        },
        async readRun(input) {
            assertDevUiTester(input.userId);
            const parsed = parse(devUiReadRunInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.userId, 'dev_ui_read_run', { p_user_id: parsed.userId, p_run_id: parsed.runId });
            if (data === null) return null;
            const row = parse(devUiRunRowSchema, data, 'DEV_UI_INVALID_ROW');
            assertRow(row.user_id === parsed.userId && row.id === parsed.runId);
            if (Date.parse(row.expires_at) <= now().getTime()) throw new DevUiStoreError('DEV_UI_RUN_EXPIRED');
            return projectDevUiRun(row);
        },
        async listOwnerOrders(input) {
            assertDevUiTester(input.userId);
            const parsed = parse(devUiListOwnerInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.userId, 'dev_ui_list_owner_orders', { p_user_id: parsed.userId, p_limit: parsed.limit });
            const rows = parse(z.array(orderEnvelopeSchema).max(parsed.limit), data, 'DEV_UI_INVALID_ROW');
            const instant = now();
            return rows.map(({ order, run }) => { validateEnvelope(order, run, parsed.userId); return projectDevUiOrder(order, run, instant); });
        },
        async listAdminOrders(input) {
            assertDevUiAdministrator(input.adminUserId);
            const parsed = parse(devUiListAdminInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.adminUserId, 'dev_ui_list_admin_orders', { p_limit: parsed.limit }, true);
            const rows = parse(z.array(orderEnvelopeSchema).max(parsed.limit), data, 'DEV_UI_INVALID_ROW');
            const instant = now();
            return rows.map(({ order, run }) => { validateEnvelope(order, run); return projectDevUiOrder(order, run, instant); });
        },
        async readAdminOrder(input) {
            assertDevUiAdministrator(input.adminUserId);
            const parsed = parse(devUiReadAdminInputSchema, input, 'DEV_UI_INVALID_INPUT');
            const data = await rpc(parsed.adminUserId, 'dev_ui_read_admin_order', { p_order_id: parsed.orderId }, true);
            if (data === null) return null;
            const { order, run } = parse(orderEnvelopeSchema, data, 'DEV_UI_INVALID_ROW');
            validateEnvelope(order, run); assertRow(order.id === parsed.orderId);
            return projectDevUiOrder(order, run, now());
        },
    };
}

export const devUiStore = createDevUiStore();
