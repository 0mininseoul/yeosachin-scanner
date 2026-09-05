import { z } from 'zod';
import {
    genderCountsSchema,
    retentionSchema,
    riskCountsSchema,
} from './order-audit-bundle';

const uuidSchema = z.string().uuid();
const cursorAssembledAtSchema = z.string().datetime({ offset: true }).max(64);
const pageSizeSchema = z.number().int().min(1).max(50);

export const orderAuditListQuerySchema = z.object({
    pageSize: pageSizeSchema.default(25),
    cursorAssembledAt: cursorAssembledAtSchema.nullable().default(null),
    cursorRequestId: uuidSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
    if ((value.cursorAssembledAt === null) !== (value.cursorRequestId === null)) {
        context.addIssue({
            code: 'custom',
            path: ['cursor'],
            message: 'cursor must include both assembledAt and requestId',
        });
    }
});

export type OrderAuditListQuery = z.infer<typeof orderAuditListQuerySchema>;

const gapCodeSchema = z.string()
    .min(1)
    .max(96)
    .regex(/^[A-Za-z0-9_.:-]+$/);

const stageStatusSchema = z.object({
    relationships: z.boolean(),
    targetEvidence: z.boolean(),
    candidateFeatures: z.boolean(),
    riskScores: z.boolean(),
    finalized: z.boolean(),
}).strict();

const costSchema = z.object({
    status: z.enum(['complete', 'partial', 'unknown', 'not_available']),
    knownUsd: z.number().nonnegative().nullable(),
    conservativeUsd: z.number().nonnegative().nullable(),
    usageUnknown: z.boolean(),
}).strict();

export const orderAuditListRowSchema = z.object({
    requestId: uuidSchema,
    orderId: uuidSchema.nullable(),
    targetInstagramId: z.string().min(1).max(30).nullable(),
    planId: z.enum(['basic', 'standard', 'plus']),
    version: z.number().int().positive().max(100_000),
    completenessStatus: z.enum(['complete', 'partial', 'inconsistent', 'failed']),
    gapCodes: z.array(gapCodeSchema).max(32),
    cost: costSchema,
    gender: genderCountsSchema,
    risk: riskCountsSchema,
    retention: retentionSchema,
    stageStatus: stageStatusSchema,
    assembledAt: cursorAssembledAtSchema,
}).strict();

export const orderAuditListCursorSchema = z.object({
    assembledAt: cursorAssembledAtSchema,
    requestId: uuidSchema,
}).strict();

export const orderAuditListPayloadSchema = z.object({
    rows: z.array(orderAuditListRowSchema).max(50),
    nextCursor: orderAuditListCursorSchema.nullable(),
}).strict();

export type OrderAuditListRow = z.infer<typeof orderAuditListRowSchema>;
export type OrderAuditListCursor = z.infer<typeof orderAuditListCursorSchema>;
export type OrderAuditListPayload = z.infer<typeof orderAuditListPayloadSchema>;

export interface OrderAuditListRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

function parseQueryParamOnce(params: URLSearchParams, key: string): string | null {
    const values = params.getAll(key);
    if (values.length > 1) throw new Error('ANALYSIS_ORDER_AUDIT_INVALID_QUERY');
    return values[0] ?? null;
}

function parsePageSize(value: string | null): number {
    if (value === null) return 25;
    if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(value)) {
        throw new Error('ANALYSIS_ORDER_AUDIT_INVALID_QUERY');
    }
    return Number(value);
}

export function parseOrderAuditListQuery(url: string): OrderAuditListQuery {
    let params: URLSearchParams;
    try {
        params = new URL(url).searchParams;
    } catch {
        throw new Error('ANALYSIS_ORDER_AUDIT_INVALID_QUERY');
    }
    const allowed = new Set(['pageSize', 'cursorAssembledAt', 'cursorRequestId']);
    for (const key of params.keys()) {
        if (!allowed.has(key)) throw new Error('ANALYSIS_ORDER_AUDIT_INVALID_QUERY');
    }
    const parsed = orderAuditListQuerySchema.safeParse({
        pageSize: parsePageSize(parseQueryParamOnce(params, 'pageSize')),
        cursorAssembledAt: parseQueryParamOnce(params, 'cursorAssembledAt'),
        cursorRequestId: parseQueryParamOnce(params, 'cursorRequestId'),
    });
    if (!parsed.success) throw new Error('ANALYSIS_ORDER_AUDIT_INVALID_QUERY');
    return parsed.data;
}

function throwListError(code: 'ANALYSIS_ORDER_AUDIT_LIST_FAILED' | 'ANALYSIS_ORDER_AUDIT_LIST_PAYLOAD_INVALID'): never {
    throw new Error(code);
}

/** Server-only service-role RPC boundary for the immutable latest-bundle overview. */
export async function loadAnalysisOrderAuditList(
    client: OrderAuditListRpcClient,
    input: z.input<typeof orderAuditListQuerySchema>,
): Promise<OrderAuditListPayload> {
    const parsed = orderAuditListQuerySchema.safeParse(input);
    if (!parsed.success) throw new Error('ANALYSIS_ORDER_AUDIT_INVALID_QUERY');
    const { data, error } = await client.rpc('list_analysis_order_audit_bundles', {
        p_cursor_assembled_at: parsed.data.cursorAssembledAt,
        p_cursor_request_id: parsed.data.cursorRequestId,
        p_page_size: parsed.data.pageSize,
    });
    if (error) throwListError('ANALYSIS_ORDER_AUDIT_LIST_FAILED');
    const payload = orderAuditListPayloadSchema.safeParse(data);
    if (!payload.success) throwListError('ANALYSIS_ORDER_AUDIT_LIST_PAYLOAD_INVALID');
    return payload.data;
}

export const listAnalysisOrderAuditBundles = loadAnalysisOrderAuditList;
export const loadAnalysisOrderAuditBundles = loadAnalysisOrderAuditList;
