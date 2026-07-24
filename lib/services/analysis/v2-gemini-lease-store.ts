import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    AI_GEMINI_LEASE_SECONDS,
    AI_GEMINI_MIN_REMAINING_MS,
    AI_STAGE_POLICY_LATEST_VERSION,
    AI_STAGE_POLICY_VERSION,
    type AiStageName,
    type AiStagePolicyVersion,
} from '@/lib/services/ai/stage-policy';
import type {
    AnalysisV2AiAttemptTerminalInput,
} from '@/lib/services/analysis/v2-ai-attempt-store';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const OPERATION_KEY_PATTERN =
    /^(gender-triage|gender-resolution|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[0-9a-f]{64}$/;

export const ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_gemini_leases',
    acquireRpc: 'acquire_analysis_v2_gemini_lease',
    acquireV2Rpc: 'acquire_analysis_v2_gemini_lease_v2',
    renewRpc: 'renew_analysis_v2_gemini_lease',
    renewV2Rpc: 'renew_analysis_v2_gemini_lease_v2',
    releaseRpc: 'release_analysis_v2_gemini_lease',
    releaseV2Rpc: 'release_analysis_v2_gemini_lease_v2',
    cutoffV2Rpc: 'cutoff_analysis_v2_gemini_lease_v2',
    cutoffAttemptV2Rpc: 'cutoff_analysis_v2_gender_resolution_attempt',
    recoverCutoffAttemptsV2Rpc:
        'recover_analysis_v2_gender_resolution_cutoffs',
    reapCutoffV2Rpc: 'reap_analysis_v2_gemini_cutoff_leases_v2',
});

const acquiredRowSchema = z.object({
    outcome: z.literal('acquired'),
    slot: z.number().int().min(1).max(8),
    lease_claim_token: z.string().regex(UUID_PATTERN),
    fence: z.number().int().min(1).safe(),
    expires_at: z.string().datetime({ offset: true }),
}).strict();
const unavailableRowSchema = z.object({
    outcome: z.enum([
        'capacity_pending',
        'resolver_capacity_pending',
        'quarantine_active',
    ]),
    slot: z.number().int().min(1).max(8).nullable(),
    lease_claim_token: z.null(),
    fence: z.number().int().min(1).safe().nullable(),
    expires_at: z.string().datetime({ offset: true }).nullable(),
}).strict();
const acquireResultSchema = z.array(
    z.union([acquiredRowSchema, unavailableRowSchema])
).length(1);
const renewResultSchema = z.array(z.object({
    renewed: z.boolean(),
    lease_state: z.enum(['available', 'leased', 'quarantined']),
    expires_at: z.string().datetime({ offset: true }).nullable(),
}).strict()).length(1);
const releaseResultSchema = z.array(z.object({
    released: z.boolean(),
    lease_state: z.enum(['available', 'leased', 'quarantined']),
    fence: z.number().int().min(0).safe(),
}).strict()).length(1);
const acquireInputSchema = z.object({
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    attempt: z.number().int().min(1).max(4),
    handlerDeadlineAtMs: z.number().finite().nonnegative(),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN).optional(),
    stage: z.enum([
        'genderTriage',
        'genderResolution',
        'featureAnalysis',
        'highRiskNarrative',
        'privateAccountName',
        'partnerSafety',
    ]).optional(),
    aiStagePolicyVersion: z.enum([
        AI_STAGE_POLICY_VERSION,
        AI_STAGE_POLICY_LATEST_VERSION,
    ]).optional(),
}).strict().superRefine((input, context) => {
    const v2 = input.aiStagePolicyVersion === AI_STAGE_POLICY_LATEST_VERSION;
    if (v2 !== Boolean(input.operationKey && input.stage)) {
        context.addIssue({
            code: 'custom',
            message: 'V2 leases require a complete operation identity.',
        });
    }
});

const cutoffResultSchema = z.array(z.object({
    cutoff: z.boolean(),
    lease_state: z.enum(['available', 'leased', 'quarantined']),
    fence: z.number().int().min(0).safe(),
    expires_at: z.string().datetime({ offset: true }).nullable(),
}).strict()).length(1);
const cutoffAttemptResultSchema = z.object({
    outcome: z.enum(['cutoff', 'already_terminal']),
    attempt_status: z.enum(['cutoff', 'success']),
    lease_state: z.enum(['available', 'leased', 'quarantined']),
    fence: z.number().int().min(1).safe(),
    expires_at: z.string().datetime({ offset: true }),
}).strict();
const reapedCutoffCountSchema = z.number().int().min(0).max(8);

export type AnalysisV2GeminiLease = Readonly<{
    slot: number;
    claimToken: string;
    fence: number;
    expiresAt: string;
    operationKey?: string;
    stage?: AiStageName;
    aiStagePolicyVersion?: AiStagePolicyVersion;
}>;

interface RpcResult {
    data: unknown;
    error: unknown;
}

export interface AnalysisV2GeminiLeaseDependencies {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
    nowMs(): number;
    randomUuid(): string;
}

export interface AnalysisV2GeminiLeaseStore {
    acquire(input: {
        requestId: string;
        jobKey: string;
        attempt: number;
        handlerDeadlineAtMs: number;
        operationKey?: string;
        stage?: AiStageName;
        aiStagePolicyVersion?: AiStagePolicyVersion;
    }): Promise<AnalysisV2GeminiLease>;
    renew(lease: AnalysisV2GeminiLease): Promise<AnalysisV2GeminiLease>;
    release(lease: AnalysisV2GeminiLease): Promise<void>;
    cutoff(lease: AnalysisV2GeminiLease): Promise<void>;
    cutoffAttempt(input: {
        lease: AnalysisV2GeminiLease;
        attempt: AnalysisV2AiAttemptTerminalInput;
    }): Promise<'cutoff' | 'already_terminal'>;
    recoverCutoffAttempts(input?: { limit?: number }): Promise<number>;
    reapCutoff(input?: { limit?: number }): Promise<number>;
}

export class AnalysisV2AiCapacityPendingError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_CAPACITY_PENDING');
        this.name = 'AnalysisV2AiCapacityPendingError';
    }
}

export class AnalysisV2AiDeadlineTooShortError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_DEADLINE_TOO_SHORT');
        this.name = 'AnalysisV2AiDeadlineTooShortError';
    }
}

export class AnalysisV2AiQuarantineActiveError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_QUARANTINE_ACTIVE');
        this.name = 'AnalysisV2AiQuarantineActiveError';
    }
}

export class AnalysisV2AiResolverCapacitySkippedError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_RESOLVER_CAPACITY_SKIPPED');
        this.name = 'AnalysisV2AiResolverCapacitySkippedError';
    }
}

export class AnalysisV2GeminiLeaseFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_GEMINI_LEASE_FENCE_MISMATCH');
        this.name = 'AnalysisV2GeminiLeaseFenceError';
    }
}

export class AnalysisV2GeminiLeasePersistenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_GEMINI_LEASE_PERSISTENCE_ERROR');
        this.name = 'AnalysisV2GeminiLeasePersistenceError';
    }
}

function defaultDependencies(): AnalysisV2GeminiLeaseDependencies {
    return {
        rpc: (name, params) => supabaseAdmin.rpc(name, params),
        nowMs: () => performance.now(),
        randomUuid: randomUUID,
    };
}

function parseLease(
    value: z.infer<typeof acquiredRowSchema>,
    input: z.infer<typeof acquireInputSchema>,
): AnalysisV2GeminiLease {
    return Object.freeze({
        slot: value.slot,
        claimToken: value.lease_claim_token,
        fence: value.fence,
        expiresAt: value.expires_at,
        ...(input.aiStagePolicyVersion === AI_STAGE_POLICY_LATEST_VERSION ? {
            operationKey: input.operationKey,
            stage: input.stage,
            aiStagePolicyVersion: input.aiStagePolicyVersion,
        } : {}),
    });
}

function isV2Lease(lease: AnalysisV2GeminiLease): lease is AnalysisV2GeminiLease & {
    operationKey: string;
    stage: AiStageName;
    aiStagePolicyVersion: typeof AI_STAGE_POLICY_LATEST_VERSION;
} {
    return lease.aiStagePolicyVersion === AI_STAGE_POLICY_LATEST_VERSION
        && typeof lease.operationKey === 'string'
        && typeof lease.stage === 'string';
}

export function createAnalysisV2GeminiLeaseStore(
    dependencies: AnalysisV2GeminiLeaseDependencies = defaultDependencies()
): AnalysisV2GeminiLeaseStore {
    return {
        async acquire(rawInput) {
            const input = acquireInputSchema.safeParse(rawInput);
            if (!input.success) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            if (
                input.data.handlerDeadlineAtMs - dependencies.nowMs()
                < AI_GEMINI_MIN_REMAINING_MS
            ) {
                throw new AnalysisV2AiDeadlineTooShortError();
            }
            const proposedToken = dependencies.randomUuid();
            if (!UUID_PATTERN.test(proposedToken)) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const usesV2 = input.data.aiStagePolicyVersion === AI_STAGE_POLICY_LATEST_VERSION;
            const { data, error } = await dependencies.rpc(
                usesV2
                    ? ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireV2Rpc
                    : ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireRpc,
                usesV2 ? {
                    p_request_id: input.data.requestId,
                    p_job_key: input.data.jobKey,
                    p_operation_key: input.data.operationKey,
                    p_stage: input.data.stage,
                    p_attempt: input.data.attempt,
                    p_claim_token: proposedToken,
                    p_lease_seconds: AI_GEMINI_LEASE_SECONDS,
                } : {
                    p_request_id: input.data.requestId,
                    p_job_key: input.data.jobKey,
                    p_attempt: input.data.attempt,
                    p_claim_token: proposedToken,
                    p_lease_seconds: AI_GEMINI_LEASE_SECONDS,
                }
            );
            if (error) throw new AnalysisV2GeminiLeasePersistenceError();
            const parsed = acquireResultSchema.safeParse(data);
            if (!parsed.success) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const row = parsed.data[0];
            if (row.outcome === 'capacity_pending') {
                throw new AnalysisV2AiCapacityPendingError();
            }
            if (row.outcome === 'resolver_capacity_pending') {
                throw new AnalysisV2AiResolverCapacitySkippedError();
            }
            if (row.outcome === 'quarantine_active') {
                throw new AnalysisV2AiQuarantineActiveError();
            }
            if (row.lease_claim_token !== proposedToken) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            return parseLease(row, input.data);
        },

        async renew(lease) {
            const { data, error } = await dependencies.rpc(
                isV2Lease(lease)
                    ? ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.renewV2Rpc
                    : ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.renewRpc,
                isV2Lease(lease) ? {
                    p_slot: lease.slot,
                    p_claim_token: lease.claimToken,
                    p_fence: lease.fence,
                    p_operation_key: lease.operationKey,
                    p_lease_seconds: AI_GEMINI_LEASE_SECONDS,
                } : {
                    p_slot: lease.slot,
                    p_claim_token: lease.claimToken,
                    p_fence: lease.fence,
                    p_lease_seconds: AI_GEMINI_LEASE_SECONDS,
                }
            );
            if (error) throw new AnalysisV2GeminiLeasePersistenceError();
            const parsed = renewResultSchema.safeParse(data);
            if (!parsed.success) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const row = parsed.data[0];
            if (!row.renewed || row.lease_state !== 'leased' || !row.expires_at) {
                throw new AnalysisV2GeminiLeaseFenceError();
            }
            return Object.freeze({ ...lease, expiresAt: row.expires_at });
        },

        async release(lease) {
            const { data, error } = await dependencies.rpc(
                isV2Lease(lease)
                    ? ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.releaseV2Rpc
                    : ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.releaseRpc,
                isV2Lease(lease) ? {
                    p_slot: lease.slot,
                    p_claim_token: lease.claimToken,
                    p_fence: lease.fence,
                    p_operation_key: lease.operationKey,
                } : {
                    p_slot: lease.slot,
                    p_claim_token: lease.claimToken,
                    p_fence: lease.fence,
                }
            );
            if (error) throw new AnalysisV2GeminiLeasePersistenceError();
            const parsed = releaseResultSchema.safeParse(data);
            if (!parsed.success) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const row = parsed.data[0];
            if (
                !row.released
                || row.lease_state !== 'available'
                || row.fence !== lease.fence
            ) {
                throw new AnalysisV2GeminiLeaseFenceError();
            }
        },

        async cutoff(lease) {
            if (!isV2Lease(lease) || lease.stage !== 'genderResolution') {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const { data, error } = await dependencies.rpc(
                ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.cutoffV2Rpc,
                {
                    p_slot: lease.slot,
                    p_claim_token: lease.claimToken,
                    p_fence: lease.fence,
                    p_operation_key: lease.operationKey,
                }
            );
            if (error) throw new AnalysisV2GeminiLeasePersistenceError();
            const parsed = cutoffResultSchema.safeParse(data);
            if (!parsed.success) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const row = parsed.data[0];
            if (
                !row.cutoff
                || row.lease_state !== 'quarantined'
                || row.fence !== lease.fence
                || !row.expires_at
            ) {
                throw new AnalysisV2GeminiLeaseFenceError();
            }
        },

        async cutoffAttempt({ lease, attempt }) {
            if (
                !isV2Lease(lease)
                || lease.stage !== 'genderResolution'
                || attempt.stage !== 'genderResolution'
                || attempt.status !== 'cutoff'
                || attempt.operationKey !== lease.operationKey
                || attempt.attempt !== attempt.retryCount + 1
                || attempt.usageMetadataStatus !== 'missing'
                || attempt.usageComplete
                || attempt.tokenUsage !== null
                || attempt.estimatedCostUsd !== null
                || attempt.finishReason !== null
            ) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const { data, error } = await dependencies.rpc(
                ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.cutoffAttemptV2Rpc,
                {
                    p_request_id: attempt.requestId,
                    p_job_key: attempt.jobKey,
                    p_job_claim_token: attempt.claimToken,
                    p_operation_key: attempt.operationKey,
                    p_attempt: attempt.attempt,
                    p_reservation_token: attempt.reservationToken,
                    p_telemetry: {
                        model_name: attempt.modelName,
                        location: attempt.location,
                        stage: attempt.stage,
                        thinking_level: attempt.thinkingLevel,
                        media_count: attempt.mediaCount,
                        media_resolution: attempt.mediaResolution,
                        prompt_version: attempt.promptVersion,
                        schema_version: attempt.schemaVersion,
                        max_output_tokens: attempt.maxOutputTokens,
                        retry_count: attempt.retryCount,
                        usage_metadata_status: attempt.usageMetadataStatus,
                        usage_complete: attempt.usageComplete,
                        prompt_tokens: null,
                        completion_tokens: null,
                        total_tokens: null,
                        thinking_tokens: null,
                        latency_ms: attempt.latencyMs,
                        estimated_cost_usd: null,
                        finish_reason: null,
                    },
                    p_slot: lease.slot,
                    p_lease_claim_token: lease.claimToken,
                    p_lease_fence: lease.fence,
                }
            );
            if (error) throw new AnalysisV2GeminiLeasePersistenceError();
            const parsed = cutoffAttemptResultSchema.safeParse(data);
            if (
                !parsed.success
                || parsed.data.fence !== lease.fence
                || (
                    parsed.data.outcome === 'cutoff'
                    && (
                        parsed.data.attempt_status !== 'cutoff'
                        || parsed.data.lease_state !== 'quarantined'
                    )
                )
                || (
                    parsed.data.outcome === 'already_terminal'
                    && parsed.data.attempt_status === 'cutoff'
                    && parsed.data.lease_state !== 'quarantined'
                )
            ) {
                throw new AnalysisV2GeminiLeaseFenceError();
            }
            return parsed.data.outcome;
        },

        async reapCutoff(input = {}) {
            const limit = input.limit ?? 8;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const { data, error } = await dependencies.rpc(
                ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.reapCutoffV2Rpc,
                { p_limit: limit }
            );
            if (error) throw new AnalysisV2GeminiLeasePersistenceError();
            const parsed = reapedCutoffCountSchema.safeParse(data);
            if (!parsed.success) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            return parsed.data;
        },

        async recoverCutoffAttempts(input = {}) {
            const limit = input.limit ?? 8;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const { data, error } = await dependencies.rpc(
                ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.recoverCutoffAttemptsV2Rpc,
                { p_limit: limit }
            );
            if (error) throw new AnalysisV2GeminiLeasePersistenceError();
            const parsed = reapedCutoffCountSchema.safeParse(data);
            if (!parsed.success) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            return parsed.data;
        },
    };
}

export const analysisV2GeminiLeaseStore = createAnalysisV2GeminiLeaseStore();

export function isAnalysisV2AiAdmissionSignal(error: unknown): error is Error {
    return error instanceof AnalysisV2AiCapacityPendingError
        || error instanceof AnalysisV2AiDeadlineTooShortError
        || error instanceof AnalysisV2AiQuarantineActiveError;
}
