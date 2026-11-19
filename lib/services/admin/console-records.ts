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
    cursorCreatedAt: timestamp,
    cursorId: z.string().uuid(),
});

export type AdminLeadInput = Omit<z.infer<typeof leadInputRowSchema>, 'cursorCreatedAt' | 'cursorId'>;

export type AdminLeadInputQuery = Readonly<{
    mappingStatus?: z.infer<typeof leadMappingStatusSchema>;
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
