import { z } from 'zod';

const uuidSchema = z.string().uuid();
const cursorSchema = z.number().int().min(0).max(100_000);
const pageSizeSchema = z.number().int().min(1).max(50);

/**
 * This is deliberately an environment-only allowlist.  It is evaluated on the
 * server after Supabase has verified the current session; it is never shipped
 * to a client, accepted from a request, or written to logs.
 */
export function isAnalysisAuditOperator(
    userId: string | null | undefined,
    env: Record<string, string | undefined> = process.env,
): boolean {
    if (!userId || !uuidSchema.safeParse(userId).success) return false;
    const configured = env.ANALYSIS_AUDIT_OPERATOR_USER_IDS;
    if (!configured) return false;
    const tokens = configured.split(',').map(value => value.trim().toLowerCase());
    const parsed = z.array(uuidSchema).min(1).safeParse(tokens);
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) return false;
    // One malformed, blank, or duplicate token invalidates the entire configuration.
    return parsed.data.includes(userId.toLowerCase());
}

export const analysisAuditPageSchema = z.object({
    requestId: uuidSchema,
    cursor: cursorSchema.default(0),
    pageSize: pageSizeSchema.default(25),
}).strict();

const componentSchema = z.object({
    key: z.enum([
        'candidateToTargetLikes', 'candidateToTargetComments',
        'candidateToTargetTagOrCaptionMention', 'targetToCandidateTagOrCaptionMention',
        'targetToCandidateLike', 'recentMutual', 'appearanceExposure', 'weakPartnerAdjustment',
    ]),
    contributionUnits: z.number().int().min(-50).max(300),
}).strict();

export const analysisAuditRowSchema = z.object({
    candidateId: z.string().min(1).max(128),
    rank: z.number().int().positive(),
    instagramId: z.string().min(1).max(30),
    genderProvenance: z.enum(['triage', 'feature', 'gender_resolution', 'unknown', 'unavailable']),
    accountContext: z.enum(['personal', 'individual_creator', 'official_group_or_brand', 'uncertain']),
    officialGroupExcluded: z.boolean(),
    officialGroupReason: z.string().max(120).nullable(),
    components: z.array(componentSchema).max(8),
    signals: z.object({
        candidateLikes: z.number().int().min(0).max(4),
        candidateComments: z.number().int().min(0).max(12),
        candidateTagsTarget: z.boolean(),
        targetTagsCandidate: z.boolean(),
        targetLikedCandidate: z.enum(['observed', 'not_observed', 'not_collected']),
        recentMutualRank: z.number().int().positive().nullable(),
        appearanceGrade: z.number().int().min(1).max(5),
        exposureScore: z.number().min(0).max(5),
        hasWeakPartnerEvidence: z.boolean(),
        hasStrongPartnerEvidence: z.boolean(),
    }).strict(),
    rawScoreUnits: z.number().int().min(0).max(1000),
    naturalDisplayScore: z.number().min(1).max(10),
    displayScore: z.number().min(1).max(10),
    relativeTierApplied: z.boolean(),
    partnerCapApplied: z.boolean(),
    strongPartnerEvidence: z.boolean(),
    riskBand: z.enum(['normal', 'caution', 'high_risk']),
    featuredRank: z.number().int().positive().nullable(),
    scoreConsistent: z.boolean(),
}).strict();

export const analysisAuditPayloadSchema = z.object({
    request: z.object({
        requestId: uuidSchema,
        status: z.enum(['queued', 'processing', 'ready', 'partial', 'inconsistent', 'failed']),
        riskPolicyVersion: z.string().max(64).nullable(),
        aiPolicyVersion: z.string().max(64).nullable(),
        resultHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
        reason: z.string().max(160).nullable(),
        updatedAt: z.string().datetime({ offset: true }),
    }).strict(),
    rows: z.array(analysisAuditRowSchema).max(50),
    nextCursor: cursorSchema.nullable(),
    officialGroupCount: z.number().int().min(0).max(900),
}).strict();

export type AnalysisAuditPayload = z.infer<typeof analysisAuditPayloadSchema>;

export interface AnalysisAuditRpcClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { message?: string } | null;
    }>;
}

/** Server-only service-role RPC boundary.  The route authenticates the operator first. */
export async function loadAnalysisScoreAudit(
    client: AnalysisAuditRpcClient,
    input: z.input<typeof analysisAuditPageSchema>,
): Promise<AnalysisAuditPayload | null> {
    const parsed = analysisAuditPageSchema.parse(input);
    const { data, error } = await client.rpc('load_analysis_v2_score_audit', {
        p_request_id: parsed.requestId,
        p_cursor: parsed.cursor,
        p_page_size: parsed.pageSize,
    });
    if (error) throw new Error('ANALYSIS_AUDIT_LOAD_FAILED');
    if (data === null) return null;
    return analysisAuditPayloadSchema.parse(data);
}

export function parseAnalysisAuditQuery(url: string) {
    const params = new URL(url).searchParams;
    return analysisAuditPageSchema.parse({
        requestId: params.get('requestId'),
        cursor: params.get('cursor') === null ? 0 : Number(params.get('cursor')),
        pageSize: params.get('pageSize') === null ? 25 : Number(params.get('pageSize')),
    });
}

type AuditQueueClient = Pick<AnalysisAuditRpcClient, 'rpc'>;

/** Async fallback that expands the retained final-score checkpoint into a safe source. */
export async function captureAnalysisScoreAuditSource(
    client: AuditQueueClient,
    requestId: string,
): Promise<void> {
    const parsedRequestId = uuidSchema.parse(requestId);
    const result = await client.rpc('capture_analysis_v2_score_audit_source', {
        p_request_id: parsedRequestId,
    });
    if (result.error) throw new Error('ANALYSIS_AUDIT_SOURCE_CAPTURE_FAILED');
}

/**
 * Best-effort outbox drain. It is intentionally fire-and-forget from finalization:
 * a database-triggered queued row remains for recovery if this process is stopped.
 */
export async function materializeQueuedAnalysisScoreAudit(
    client: AuditQueueClient,
    requestId: string,
): Promise<void> {
    const validRequestId = uuidSchema.parse(requestId);
    const claimed = await client.rpc('claim_analysis_v2_score_audit', {
        p_request_id: validRequestId,
    });
    if (claimed.error) throw new Error('ANALYSIS_AUDIT_CLAIM_FAILED');
    if (!claimed.data || typeof claimed.data !== 'object') return;
    const leaseToken = (claimed.data as { leaseToken?: unknown }).leaseToken;
    if (!uuidSchema.safeParse(leaseToken).success) return;
    const materialized = await client.rpc('materialize_analysis_v2_score_audit', {
        p_request_id: validRequestId,
        p_lease_token: leaseToken,
    });
    if (materialized.error) throw new Error('ANALYSIS_AUDIT_MATERIALIZE_FAILED');
}

/** Bounded recovery path for a process that died after terminal finalization. */
export async function recoverQueuedAnalysisScoreAudits(
    client: AuditQueueClient,
    limit = 5,
): Promise<void> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) {
        throw new Error('ANALYSIS_AUDIT_RECOVERY_LIMIT_INVALID');
    }
    const expired = await client.rpc(
        'purge_expired_analysis_v2_score_audit_evidence',
        { p_limit: 100 },
    );
    if (expired.error) throw new Error('ANALYSIS_AUDIT_EXPIRY_PURGE_FAILED');
    const purged = await client.rpc(
        'purge_failed_analysis_v2_score_audit_sources',
        { p_limit: limit },
    );
    if (purged.error) throw new Error('ANALYSIS_AUDIT_PURGE_FAILED');
    const { data, error } = await client.rpc('list_analysis_v2_score_audit_candidates', {
        p_limit: limit,
    });
    if (error) throw new Error('ANALYSIS_AUDIT_LIST_FAILED');
    if (!Array.isArray(data)) throw new Error('ANALYSIS_AUDIT_LIST_PAYLOAD_INVALID');
    for (const row of data) {
        const candidate = typeof row === 'object' && row !== null
            ? (row as { request_id?: unknown }).request_id
            : null;
        const parsedCandidate = uuidSchema.safeParse(candidate);
        if (parsedCandidate.success) {
            try {
                await materializeQueuedAnalysisScoreAudit(client, parsedCandidate.data);
            } catch {
                // A safe code is raised at the RPC boundary; another queued row may proceed.
            }
        }
    }
}
