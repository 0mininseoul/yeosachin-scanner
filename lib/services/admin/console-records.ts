import { z } from 'zod';

type RpcClient = {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string; code?: string } | null;
    }>;
};

const instagramId = z.string().regex(/^[a-z0-9._]{1,30}$/);
const timestamp = z.string().datetime({ offset: true });
const attributionLabel = z.enum([
    '직접 방문', 'UTM: 카카오', 'UTM: 구글', 'UTM: 인스타그램', 'UTM: 기타',
    '외부 참조: 카카오', '외부 참조: 구글', '외부 참조: 인스타그램', '외부 참조: 기타',
]);
export const leadMappingStatusSchema = z.enum([
    'legacy_unlinked', 'anonymous_device', 'authenticated_user', 'unlinked_after_deletion',
]);

const leadInputRowSchema = z.object({
    inputAt: timestamp,
    mappingStatus: leadMappingStatusSchema,
    userName: z.string().max(255).nullable(),
    attributionLabel: attributionLabel.nullable(),
    targetInstagramId: instagramId,
    excludedInstagramId: instagramId.nullable(),
    preflightId: z.string().uuid().nullable(),
    preflightStatus: z.enum(['processing', 'completed', 'failed']).nullable(),
    preflightStage: z.enum(['request', 'profile', 'exclusion', 'preflight']).nullable(),
    preflightErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).nullable(),
    preflightOutcomeAt: timestamp.nullable(),
    preflightFollowersCount: z.number().int().nonnegative().nullable(),
    preflightFollowingCount: z.number().int().nonnegative().nullable(),
    preflightIsPrivate: z.boolean().nullable(),
    preflightRequiredPlanId: z.string().max(16).nullable(),
    preflightScreenAvailable: z.boolean(),
    cursorCreatedAt: timestamp,
    cursorId: z.string().uuid(),
});

export type AdminLeadInput = Omit<z.infer<typeof leadInputRowSchema>, 'cursorCreatedAt' | 'cursorId'>;

export const leadPreflightFilterSchema = z.enum(['processing', 'completed', 'failed', 'not_requested', 'unknown']);

export type AdminLeadInputQuery = Readonly<{
    mappingStatus?: z.infer<typeof leadMappingStatusSchema>;
    preflightStatus?: z.infer<typeof leadPreflightFilterSchema>;
    instagramId?: string;
    from?: string;
    to?: string;
    cursor?: string;
    pageSize: number;
}>;

export class AdminConsoleCursorInvalidError extends Error {
    constructor() { super('ADMIN_CONSOLE_CURSOR_INVALID'); }
}

const cursorSchema = z.object({ c: timestamp, i: z.string().uuid() }).strict();

export function encodeLeadCursor(createdAt: string, id: string): string {
    return Buffer.from(JSON.stringify({ c: createdAt, i: id })).toString('base64url');
}

export function decodeLeadCursor(value: string): { createdAt: string; id: string } {
    try {
        const parsed = cursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
        return { createdAt: parsed.c, id: parsed.i };
    } catch {
        throw new AdminConsoleCursorInvalidError();
    }
}

export async function loadAdminLeadInputs(
    client: RpcClient,
    query: AdminLeadInputQuery,
): Promise<{ rows: AdminLeadInput[]; nextCursor: string | null }> {
    const cursor = query.cursor ? decodeLeadCursor(query.cursor) : null;
    const { data, error } = await client.rpc('load_admin_lead_inputs', {
        p_mapping_status: query.mappingStatus ?? null,
        p_instagram_id: query.instagramId ?? null,
        p_from: query.from ?? null,
        p_to: query.to ?? null,
        p_cursor_created_at: cursor?.createdAt ?? null,
        p_cursor_id: cursor?.id ?? null,
        // One extra row tells us whether another page exists.
        p_page_size: query.pageSize + 1,
        p_preflight_status: query.preflightStatus ?? null,
    });
    if (error) throw new Error('ADMIN_LEAD_INPUTS_UNAVAILABLE');
    const rows = z.object({ rows: z.array(leadInputRowSchema).max(51) }).parse(data).rows;
    const page = rows.slice(0, query.pageSize);
    const last = page[page.length - 1];
    return {
        rows: page.map(row => ({
            inputAt: row.inputAt,
            mappingStatus: row.mappingStatus,
            userName: row.userName,
            attributionLabel: row.attributionLabel,
            targetInstagramId: row.targetInstagramId,
            excludedInstagramId: row.excludedInstagramId,
            preflightId: row.preflightId,
            preflightStatus: row.preflightStatus,
            preflightStage: row.preflightStage,
            preflightErrorCode: row.preflightErrorCode,
            preflightOutcomeAt: row.preflightOutcomeAt,
            preflightFollowersCount: row.preflightFollowersCount,
            preflightFollowingCount: row.preflightFollowingCount,
            preflightIsPrivate: row.preflightIsPrivate,
            preflightRequiredPlanId: row.preflightRequiredPlanId,
            preflightScreenAvailable: row.preflightScreenAvailable,
        })),
        nextCursor: rows.length > query.pageSize && last ? encodeLeadCursor(last.cursorCreatedAt, last.cursorId) : null,
    };
}

const orderCustomerRowSchema = z.object({
    requestId: z.string().uuid(),
    userName: z.string().max(255).nullable(),
    gender: z.string().max(20).nullable(),
    birthyear: z.string().regex(/^\d{4}$/).nullable(),
    deviceLabel: z.string().max(40).nullable(),
    attributionLabel: attributionLabel.nullable(),
    paidAmountKrw: z.number().int().positive().nullable(),
});

export type AdminOrderCustomer = z.infer<typeof orderCustomerRowSchema>;

const GENDER_LABEL: Record<string, string> = { female: '여성', male: '남성', 여성: '여성', 남성: '남성' };

/** Normalizes Kakao's gender value to 여성/남성 and drops anything else. */
export function displayGender(value: string | null): string | null {
    return value ? GENDER_LABEL[value.toLowerCase()] ?? GENDER_LABEL[value] ?? null : null;
}

export async function loadAdminOrderCustomers(
    client: RpcClient,
    requestIds: readonly string[],
): Promise<AdminOrderCustomer[]> {
    if (requestIds.length === 0) return [];
    const { data, error } = await client.rpc('load_admin_order_customers', {
        p_request_ids: [...requestIds],
    });
    if (error) throw new Error('ADMIN_ORDER_CUSTOMERS_UNAVAILABLE');
    return z.object({ rows: z.array(orderCustomerRowSchema).max(50) }).parse(data).rows
        .map(row => ({ ...row, gender: displayGender(row.gender) }));
}

/* ---------- paid order list (every paid order, bundle when present) ---------- */

const usdValue = z.coerce.number().finite().nonnegative();
const orderStatusSchema = z.enum([
    'payment_pending', 'payment_failed', 'paid', 'analysis_in_progress', 'completed',
    'overflow_refund_required', 'cancelled', 'refund_pending', 'refunded',
]);

const adminOrderRowSchema = z.object({
    orderId: z.string().uuid(),
    requestId: z.string().uuid().nullable(),
    orderStatus: orderStatusSchema,
    planId: z.string().max(16),
    targetInstagramId: z.string().max(30),
    excludedInstagramId: z.string().max(30).nullable(),
    paidAt: timestamp,
    paidAmountKrw: z.number().int().nonnegative().nullable(),
    userName: z.string().max(255).nullable(),
    gender: z.string().max(20).nullable(),
    birthyear: z.string().max(4).nullable(),
    attributionLabel: attributionLabel.nullable(),
    deviceLabel: z.string().max(40).nullable(),
    bundle: z.object({
        version: z.number().int().positive(),
        completenessStatus: z.enum(['complete', 'partial', 'inconsistent', 'failed']),
        gapCodes: z.array(z.string().max(96)).max(32),
        costStatus: z.enum(['complete', 'partial', 'unknown', 'not_available']),
        knownUsd: usdValue.nullable(),
        conservativeUsd: usdValue.nullable(),
        assembledAt: timestamp,
        retentionState: z.enum(['retained', 'pending', 'fenced', 'unknown']),
    }).nullable(),
    costSnapshot: z.object({
        knownUsd: usdValue.nullable(),
        conservativeUsd: usdValue.nullable(),
        complete: z.boolean(),
        usageUnknown: z.boolean(),
    }).nullable(),
    cursorPaidAt: timestamp,
    cursorId: z.string().uuid(),
});

export type AdminOrderRow = Omit<z.infer<typeof adminOrderRowSchema>, 'cursorPaidAt' | 'cursorId'>;

const orderCursorSchema = z.object({ p: timestamp, i: z.string().uuid() }).strict();

export function encodeOrderCursor(paidAt: string, id: string): string {
    return Buffer.from(JSON.stringify({ p: paidAt, i: id })).toString('base64url');
}

export function decodeOrderCursor(value: string): { paidAt: string; id: string } {
    try {
        const parsed = orderCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
        return { paidAt: parsed.p, id: parsed.i };
    } catch {
        throw new AdminConsoleCursorInvalidError();
    }
}

export async function loadAdminOrders(
    client: RpcClient,
    query: { cursor?: string; pageSize: number },
): Promise<{ rows: AdminOrderRow[]; nextCursor: string | null }> {
    const cursor = query.cursor ? decodeOrderCursor(query.cursor) : null;
    const { data, error } = await client.rpc('load_admin_orders', {
        p_cursor_paid_at: cursor?.paidAt ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_page_size: query.pageSize + 1,
    });
    if (error) throw new Error('ADMIN_ORDERS_UNAVAILABLE');
    const rows = z.object({ rows: z.array(adminOrderRowSchema).max(51) }).parse(data).rows;
    const page = rows.slice(0, query.pageSize);
    const last = page[page.length - 1];
    return {
        rows: page.map(row => {
            const { cursorPaidAt, cursorId, ...rest } = row;
            void cursorPaidAt; void cursorId;
            return { ...rest, gender: displayGender(rest.gender) };
        }),
        nextCursor: rows.length > query.pageSize && last ? encodeOrderCursor(last.cursorPaidAt, last.cursorId) : null,
    };
}

/* ---------- users (every column of public.users + order/lead totals) ---------- */

const userFieldValue = z.union([z.string().max(2048), z.number(), z.boolean(), z.null()]);

const adminUserRowSchema = z.object({
    id: z.string().uuid(),
    cursor_created_at: z.string(),
}).catchall(userFieldValue);

export type AdminUserRow = Record<string, string | number | boolean | null> & { id: string };

const userCursorSchema = z.object({ c: z.string().min(1).max(64), i: z.string().uuid() }).strict();

export function encodeUserCursor(createdAt: string, id: string): string {
    return Buffer.from(JSON.stringify({ c: createdAt, i: id })).toString('base64url');
}

export function decodeUserCursor(value: string): { createdAt: string; id: string } {
    try {
        const parsed = userCursorSchema.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
        return { createdAt: parsed.c, id: parsed.i };
    } catch {
        throw new AdminConsoleCursorInvalidError();
    }
}

export async function loadAdminUsers(
    client: RpcClient,
    query: { search?: string; cursor?: string; pageSize: number },
): Promise<{ rows: AdminUserRow[]; nextCursor: string | null }> {
    const cursor = query.cursor ? decodeUserCursor(query.cursor) : null;
    const { data, error } = await client.rpc('load_admin_users', {
        p_search: query.search ?? null,
        p_cursor_created_at: cursor?.createdAt ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_page_size: query.pageSize + 1,
    });
    if (error) throw new Error('ADMIN_USERS_UNAVAILABLE');
    const rows = z.object({ rows: z.array(adminUserRowSchema).max(51) }).parse(data).rows;
    const page = rows.slice(0, query.pageSize);
    const last = page[page.length - 1];
    return {
        rows: page.map(row => {
            const { cursor_created_at: cursorCreatedAt, ...rest } = row;
            void cursorCreatedAt;
            return rest as AdminUserRow;
        }),
        nextCursor: rows.length > query.pageSize && last ? encodeUserCursor(last.cursor_created_at, last.id) : null,
    };
}

/* ---------- user demographics and daily signups ---------- */

const userStatsSchema = z.object({
    total: z.coerce.number().int().nonnegative(),
    paidUsers: z.coerce.number().int().nonnegative(),
    byGenderAge: z.array(z.object({
        gender: z.enum(['female', 'male', 'unknown']),
        ageBand: z.enum(['10s', '20_24', '25_29', '30_34', '35_39', '40_plus', 'unknown']),
        users: z.coerce.number().int().nonnegative(),
        paidUsers: z.coerce.number().int().nonnegative(),
    })),
    bySource: z.array(z.object({
        source: z.string().max(40),
        users: z.coerce.number().int().nonnegative(),
        paidUsers: z.coerce.number().int().nonnegative(),
    })),
    daily: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), signups: z.coerce.number().int().nonnegative() })),
});

export type AdminUserStats = z.infer<typeof userStatsSchema>;

export async function loadAdminUserStats(client: RpcClient, input: { now?: Date; days?: number } = {}): Promise<AdminUserStats> {
    const { data, error } = await client.rpc('load_admin_user_stats', {
        p_now: (input.now ?? new Date()).toISOString(),
        p_days: input.days ?? 30,
    });
    if (error) throw new Error('ADMIN_USER_STATS_UNAVAILABLE');
    return userStatsSchema.parse(data);
}
