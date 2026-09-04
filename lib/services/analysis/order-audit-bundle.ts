import { z } from 'zod';

const uuidSchema = z.string().uuid();
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const cursorSchema = z.number().int().min(0).max(100_000);
const pageSizeSchema = z.number().int().min(1).max(50);

const sectionSchema = z.enum([
    'summary',
    'mutuals',
    'gender',
    'interactions',
    'risk',
]);
const filterSchema = z.enum([
    'all',
    'public',
    'private',
    'comments',
    'likes',
    'candidate_likes',
    'tags',
    'mentions',
]);

export const orderAuditQuerySchema = z.object({
    section: sectionSchema.default('summary'),
    cursor: cursorSchema.default(0),
    pageSize: pageSizeSchema.default(25),
    filter: filterSchema.default('all'),
}).strict();

export type OrderAuditQuery = z.infer<typeof orderAuditQuerySchema>;

const costSchema = z.object({
    currency: z.string().length(3),
    status: z.enum(['complete', 'partial', 'unknown', 'not_available']),
    knownUsd: z.number().nonnegative().nullable(),
    conservativeUsd: z.number().nonnegative().nullable(),
    totalKnownCostUsd: z.number().nonnegative().nullable().optional(),
    totalConservativeCostUsd: z.number().nonnegative().nullable().optional(),
    usageUnknown: z.boolean(),
    missingSourceCodes: z.array(z.string()).optional(),
    provenance: z.unknown().optional(),
}).passthrough();

const orderAuditAssemblyPayloadSchema = z.object({
    status: z.enum(['complete', 'partial', 'inconsistent', 'failed']),
    requestId: uuidSchema,
    version: z.number().int().positive(),
    bundleHash: hashSchema,
    sourceSetHash: hashSchema,
    previousVersionHash: hashSchema.nullable().optional(),
    gapCodes: z.array(z.string()),
    cost: costSchema,
}).passthrough();

const redactedObjectSchema = z.object({}).passthrough();

const forbiddenPayloadKeys = new Set([
    'userid',
    'user_id',
    'useruuid',
    'user_uuid',
    'ownerid',
    'owner_id',
    'actorid',
    'actor_id',
    'provideraccountid',
    'provider_account_id',
    'provideraccount',
    'provider_account',
    'accountid',
    'account_id',
    'account',
    'owner',
    'providertoken',
    'provider_token',
    'accesstoken',
    'access_token',
    'cookie',
    'authorization',
    'secret',
    'token',
    'jobclaimtoken',
    'job_claim_token',
    'claimtoken',
    'claim_token',
    'reservationtoken',
    'reservation_token',
    'session',
    'sessionid',
    'session_id',
    'producerclaimtoken',
    'producer_claim_token',
    'raw',
    'rawdata',
    'raw_data',
    'rawpayload',
    'raw_payload',
    'providerpayload',
    'provider_payload',
    'providerresponse',
    'provider_response',
]);

function assertRedactedPayload(value: unknown): void {
    if (Array.isArray(value)) {
        for (const child of value) assertRedactedPayload(child);
        return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
        if (forbiddenPayloadKeys.has(key.toLowerCase())) {
            throw new Error('ANALYSIS_ORDER_AUDIT_REDACTION_VIOLATION');
        }
        assertRedactedPayload(child);
    }
}

const orderAuditLoadPayloadSchema = z.object({
    summary: redactedObjectSchema,
    section: sectionSchema,
    rows: z.array(redactedObjectSchema).max(50),
    total: z.number().int().min(0).max(100_000),
    nextCursor: cursorSchema.nullable(),
}).passthrough();

export type OrderAuditBundlePayload =
    | z.infer<typeof orderAuditAssemblyPayloadSchema>
    | z.infer<typeof orderAuditLoadPayloadSchema>;
export type OrderAuditLoadPayload = z.infer<typeof orderAuditLoadPayloadSchema>;

export interface OrderAuditBundleRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

export type OrderAuditBundleEnqueue = (requestId: string) => Promise<unknown>;

/**
 * Finalization has already committed the customer result when this hook runs. A queue/RPC
 * outage therefore stays observable and retryable without converting a successful analysis into
 * a false terminal failure.
 */
export async function enqueueFinalizedAnalysisOrderAuditBundle(
    enqueue: OrderAuditBundleEnqueue | undefined,
    requestId: string,
): Promise<void> {
    if (!enqueue) return;
    try {
        await enqueue(requestId);
    } catch {
        console.error('[analysis.order-audit] enqueue failed', {
            errorCode: 'ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED',
            retryable: true,
        });
    }
}

function parseRequestId(requestId: string): string {
    return uuidSchema.parse(requestId);
}

function throwRpcError(code: string): never {
    throw new Error(code);
}

/** Queue assembly without exposing the provider/source tables to callers. */
export async function enqueueAnalysisOrderAuditBundle(
    client: OrderAuditBundleRpcClient,
    requestId: string,
): Promise<Record<string, unknown> | null> {
    const parsedRequestId = parseRequestId(requestId);
    const { data, error } = await client.rpc('enqueue_analysis_order_audit_bundle', {
        p_request_id: parsedRequestId,
    });
    if (error) throwRpcError('ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED');
    if (data === null) return null;
    assertRedactedPayload(data);
    const parsed = redactedObjectSchema.safeParse(data);
    if (!parsed.success) throwRpcError('ANALYSIS_ORDER_AUDIT_ENQUEUE_PAYLOAD_INVALID');
    return parsed.data;
}

/** Append one immutable source-set version through the server-side assembler RPC. */
export async function assembleAnalysisOrderAuditBundle(
    client: OrderAuditBundleRpcClient,
    requestId: string,
): Promise<OrderAuditBundlePayload | null> {
    const parsedRequestId = parseRequestId(requestId);
    const { data, error } = await client.rpc('assemble_analysis_order_audit_bundle', {
        p_request_id: parsedRequestId,
    });
    if (error) throwRpcError('ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED');
    if (data === null) return null;
    const parsed = orderAuditAssemblyPayloadSchema.parse(data);
    assertRedactedPayload(parsed);
    return parsed;
}

export function parseOrderAuditQuery(url: string): OrderAuditQuery {
    const params = new URL(url).searchParams;
    return orderAuditQuerySchema.parse({
        section: params.get('section') ?? 'summary',
        cursor: params.get('cursor') === null ? 0 : Number(params.get('cursor')),
        pageSize: params.get('pageSize') === null ? 25 : Number(params.get('pageSize')),
        filter: params.get('filter') ?? 'all',
    });
}

/** Read only the bounded, redacted projection exposed by the operator route. */
export async function loadAnalysisOrderAuditBundle(
    client: OrderAuditBundleRpcClient,
    requestId: string,
    query: OrderAuditQuery,
): Promise<OrderAuditLoadPayload | null> {
    const parsedRequestId = parseRequestId(requestId);
    const parsedQuery = orderAuditQuerySchema.parse(query);
    const { data, error } = await client.rpc('load_analysis_order_audit_bundle', {
        p_request_id: parsedRequestId,
        p_section: parsedQuery.section,
        p_cursor: parsedQuery.cursor,
        p_page_size: parsedQuery.pageSize,
        p_filter: parsedQuery.filter,
    });
    if (error) throwRpcError('ANALYSIS_ORDER_AUDIT_LOAD_FAILED');
    if (data === null) return null;
    const parsed = orderAuditLoadPayloadSchema.parse(data);
    assertRedactedPayload(parsed);
    return parsed;
}

type OrderAuditRecoveryClient = OrderAuditBundleRpcClient;

/**
 * Bounded outbox recovery. The database lease is authoritative; a failed assembler is released
 * with a stable retry code so the next recovery pass can safely claim the same request.
 */
export async function recoverQueuedAnalysisOrderAudits(
    client: OrderAuditRecoveryClient,
    limit = 5,
): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('ANALYSIS_ORDER_AUDIT_RECOVERY_LIMIT_INVALID');
    }
    if (typeof (client as { rpc?: unknown }).rpc !== 'function') return;

    const listed = await client.rpc('list_analysis_order_audit_bundle_recovery', {
        p_limit: limit,
    });
    if (listed.error) throw new Error('ANALYSIS_ORDER_AUDIT_LIST_FAILED');
    if (!Array.isArray(listed.data)) {
        throw new Error('ANALYSIS_ORDER_AUDIT_LIST_PAYLOAD_INVALID');
    }

    for (const value of listed.data) {
        const row = value && typeof value === 'object' && !Array.isArray(value)
            ? value as Record<string, unknown>
            : null;
        const candidateRequestId = row?.requestId ?? row?.request_id;
        const parsedRequestId = uuidSchema.safeParse(candidateRequestId);
        if (!parsedRequestId.success) continue;

        const claimed = await client.rpc('claim_analysis_order_audit_bundle', {
            p_request_id: parsedRequestId.data,
            p_lease_seconds: 300,
        });
        if (claimed.error || !claimed.data || typeof claimed.data !== 'object') continue;
        const lease = (claimed.data as Record<string, unknown>).leaseToken
            ?? (claimed.data as Record<string, unknown>).lease_token;
        const parsedLease = uuidSchema.safeParse(lease);
        if (!parsedLease.success) continue;

        try {
            await assembleAnalysisOrderAuditBundle(client, parsedRequestId.data);
        } catch {
            await client.rpc('release_analysis_order_audit_bundle', {
                p_request_id: parsedRequestId.data,
                p_lease_token: parsedLease.data,
                p_error_code: 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED',
                p_retryable: true,
            });
        }
    }
}
