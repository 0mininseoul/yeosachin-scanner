import { z } from 'zod';
import { apifyCredentialSlotSchema } from '@/lib/contracts/apify-account-credit-inventory';

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
    'public_female',
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

const countSchema = z.number().int().min(0).max(100_000);
const nullableCountSchema = countSchema.nullable();
const nullableTextSchema = (max: number) => z.string().max(max).nullable();
const nullableHashSchema = hashSchema.nullable();
const gapCodeSchema = z.string().min(1).max(96).regex(/^[A-Za-z0-9_.:-]+$/);

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
}).strict();

const declaredCollectedSchema = z.object({
    declared: nullableCountSchema,
    collected: nullableCountSchema,
}).strict();

const keyCoverageSchema = z.object({
    expected: z.array(z.string().min(1).max(30)).max(100_000),
    observed: z.array(z.string().min(1).max(30)).max(100_000),
    missing: z.array(z.string().min(1).max(30)).max(100_000),
    extra: z.array(z.string().min(1).max(30)).max(100_000),
    complete: z.boolean(),
}).strict();

const providerRunSchema = z.object({
    stage: z.string().min(1).max(64),
    logicalProvider: z.string().min(1).max(32),
    credentialSlot: apifyCredentialSlotSchema.nullable(),
    runId: z.string().min(1).max(255),
    operationKey: z.string().min(1).max(255).nullable(),
    inputHash: nullableHashSchema,
    resultHash: nullableHashSchema,
}).strict();

const stageStatusSchema = z.object({
    relationships: z.boolean(),
    targetEvidence: z.boolean(),
    candidateFeatures: z.boolean(),
    riskScores: z.boolean(),
    finalized: z.boolean(),
    cost: z.enum(['complete', 'partial', 'unknown', 'not_available']),
    costSourceHash: nullableHashSchema,
    candidateKeyCoverage: keyCoverageSchema,
    targetLikes: z.boolean(),
    targetComments: z.boolean(),
    candidateLikes: z.boolean(),
    tags: z.boolean(),
    mentions: z.boolean(),
    retainedEvidenceSourceSetHash: nullableHashSchema,
}).strict();

export const retentionSchema = z.object({
    state: z.enum(['retained', 'pending', 'fenced', 'unknown']),
    queueStatus: z.enum(['queued', 'processing', 'completed', 'failed']).nullable(),
    version: z.number().int().positive().max(100_000),
    assembledAt: z.string().datetime({ offset: true }).max(64),
    purgeFencedAt: z.string().datetime({ offset: true }).max(64).nullable(),
    purgeFenceReason: nullableTextSchema(96),
    purgedAt: z.string().datetime({ offset: true }).max(64).nullable(),
    queueUpdatedAt: z.string().datetime({ offset: true }).max(64).nullable(),
}).strict();

export const genderCountsSchema = z.object({
    initialResolved: countSchema,
    finalResolved: countSchema,
}).strict();

export const riskCountsSchema = z.object({
    declared: countSchema,
    collected: countSchema,
}).strict();

export const orderAuditSummarySchema = z.object({
    requestId: uuidSchema,
    version: z.number().int().positive().max(100_000),
    bundleHash: hashSchema,
    previousVersionHash: nullableHashSchema,
    sourceSetHash: hashSchema,
    status: z.enum(['complete', 'partial', 'inconsistent', 'failed']),
    completeness: z.enum(['complete', 'partial', 'inconsistent', 'failed']),
    gapCodes: z.array(gapCodeSchema).max(32),
    pipelineVersion: z.literal('v2'),
    pipelinePolicy: z.record(z.string(), z.unknown()),
    riskPolicyVersion: nullableTextSchema(64),
    aiPolicyVersion: nullableTextSchema(64),
    schedulerPolicyVersion: nullableTextSchema(64),
    planId: z.enum(['basic', 'standard', 'plus']),
    accessMode: z.enum(['production', 'test_entitlement']),
    orderId: uuidSchema.nullable(),
    targetInstagramId: z.string().min(1).max(30).nullable(),
    targetProfileAvailable: z.boolean(),
    targetPostsAvailable: z.boolean(),
    targetPostCount: nullableCountSchema,
    followers: declaredCollectedSchema,
    following: declaredCollectedSchema,
    mutuals: z.object({
        total: countSchema,
        public: countSchema,
        private: countSchema,
        screened: countSchema,
        declared: countSchema,
        collected: countSchema,
        listHash: hashSchema,
        keyCoverage: keyCoverageSchema,
    }).strict(),
    gender: genderCountsSchema,
    risk: riskCountsSchema,
    interactions: z.object({
        declared: countSchema,
        collected: countSchema,
        targetLikes: declaredCollectedSchema,
        targetComments: declaredCollectedSchema,
        candidateLikes: z.object({
            declared: nullableCountSchema,
            collected: nullableCountSchema,
            evidenceCollected: nullableCountSchema,
        }).strict(),
        tags: declaredCollectedSchema,
        mentions: declaredCollectedSchema,
    }).strict(),
    providerRuns: z.array(providerRunSchema).max(16),
    stageStatus: stageStatusSchema,
    retention: retentionSchema,
    assembledAt: z.string().datetime({ offset: true }).max(64),
    cost: costSchema,
    usageUnknown: z.boolean(),
}).strict();

export type OrderAuditSummary = z.infer<typeof orderAuditSummarySchema>;

export const mutualAuditRowSchema = z.object({
    candidateId: z.string().min(1).max(128),
    username: z.string().min(1).max(30),
    mutualOrdinal: nullableCountSchema,
    followingOrdinal: nullableCountSchema,
    isPrivate: z.boolean(),
    isVerified: z.boolean(),
    profileAvailable: z.boolean(),
    profileImageAvailable: z.boolean(),
    profileFailureCode: nullableTextSchema(64),
    finalInclusionState: z.enum(['included', 'excluded', 'private', 'unknown', 'unavailable']),
    completeness: z.enum(['complete', 'partial']),
}).strict();

const genderResultSchema = z.object({
    output: z.enum(['female', 'male', 'unknown', 'unavailable']).nullable(),
    model: nullableTextSchema(100),
    confidence: z.enum(['low', 'medium', 'high']).nullable(),
    reason: nullableTextSchema(160),
    operationKey: nullableTextSchema(128),
    resultHash: nullableHashSchema,
}).strict();

export const genderAuditRowSchema = z.object({
    candidateId: z.string().min(1).max(128),
    username: z.string().min(1).max(30),
    isPrivate: z.boolean(),
    initial: genderResultSchema,
    final: genderResultSchema,
    completeness: z.enum(['complete', 'partial']),
}).strict();

const auditGapCodeSchema = z.string().min(1).max(96).regex(/^[A-Za-z0-9_.:-]+$/);

export const interactionAuditRowSchema = z.object({
    ordinal: countSchema,
    candidateId: z.string().min(1).max(128).nullable(),
    username: z.string().min(1).max(30).nullable(),
    signal: z.enum(['target_post_like', 'target_post_comment', 'candidate_post_like', 'tag', 'mention']),
    sourcePostId: nullableTextSchema(255),
    evidenceId: z.string().min(1).max(255),
    occurredAt: nullableTextSchema(64),
    commentText: nullableTextSchema(1000),
    details: z.record(z.string(), z.unknown()).nullable(),
    completeness: z.enum(['complete', 'partial', 'unknown']),
    gapCodes: z.array(auditGapCodeSchema).max(32),
}).strict();

export const riskAuditRowSchema = z.object({
    candidateId: z.string().min(1).max(128),
    username: z.string().min(1).max(30),
    riskComponents: z.record(z.string(), z.unknown()).nullable(),
    riskFormulaVersion: nullableTextSchema(64),
    preScore: z.number().finite().min(0).max(100).nullable(),
    rawScore: z.number().finite().min(0).max(100).nullable(),
    publicScore: z.number().finite().min(1).max(10).nullable(),
    finalScore: z.number().finite().min(1).max(10).nullable(),
    riskBand: z.enum(['normal', 'caution', 'high_risk']).nullable(),
    finalRank: nullableCountSchema,
    featuredRank: nullableCountSchema,
    recentMutualRank: nullableCountSchema,
    partnerSafety: z.object({
        operationKey: nullableTextSchema(128),
        resultHash: nullableHashSchema,
    }).strict(),
    completeness: z.enum(['complete', 'partial']),
}).strict();

export type MutualAuditRow = z.infer<typeof mutualAuditRowSchema>;
export type GenderAuditRow = z.infer<typeof genderAuditRowSchema>;
export type InteractionAuditRow = z.infer<typeof interactionAuditRowSchema>;
export type RiskAuditRow = z.infer<typeof riskAuditRowSchema>;

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

const summaryLoadPayloadSchema = z.object({
    summary: orderAuditSummarySchema,
    section: z.literal('summary'),
    rows: z.array(z.never()).max(50),
    total: z.literal(0),
    nextCursor: z.null(),
}).strict();

const paginatedLoadFields = {
    summary: orderAuditSummarySchema,
    total: countSchema,
    nextCursor: cursorSchema.nullable(),
};

export const orderAuditLoadPayloadSchema = z.discriminatedUnion('section', [
    summaryLoadPayloadSchema,
    z.object({ ...paginatedLoadFields, section: z.literal('mutuals'), rows: z.array(mutualAuditRowSchema).max(50) }).strict(),
    z.object({ ...paginatedLoadFields, section: z.literal('gender'), rows: z.array(genderAuditRowSchema).max(50) }).strict(),
    z.object({ ...paginatedLoadFields, section: z.literal('interactions'), rows: z.array(interactionAuditRowSchema).max(50) }).strict(),
    z.object({ ...paginatedLoadFields, section: z.literal('risk'), rows: z.array(riskAuditRowSchema).max(50) }).strict(),
]);

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
