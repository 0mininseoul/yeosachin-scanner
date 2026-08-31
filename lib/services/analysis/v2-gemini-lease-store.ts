import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    AI_GEMINI_LEASE_SECONDS,
    AI_GEMINI_MIN_REMAINING_MS,
    SUPPORTED_AI_STAGE_POLICY_VERSIONS,
    aiStagePolicySupports,
    type AiStageName,
    type AiStagePolicyVersion,
} from '@/lib/services/ai/stage-policy';
import type {
    AnalysisV2AiAttemptTerminalInput,
} from '@/lib/services/analysis/v2-ai-attempt-store';
import {
    analysisProviderAdmissionStore,
    isAnalysisProviderAdmissionEnabled,
    AnalysisProviderAdmissionFenceError,
    AnalysisProviderAdmissionCapacityPendingError,
    AnalysisProviderAdmissionClaimConflictError,
    AnalysisProviderAdmissionIdentityConflictError,
    AnalysisProviderAdmissionPersistenceError,
    AnalysisProviderAdmissionResolutionPendingError,
    type AnalysisProviderAdmissionLease,
    type AnalysisProviderAdmissionStore,
} from './provider-admission-store';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const OPERATION_KEY_PATTERN =
    /^(gender-triage|gender-resolution|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[0-9a-f]{64}$/;

/** B-lite has a shorter, explicit T+86s budget but keeps the established 240s DB lease. */
export const ANALYSIS_V2_GEMINI_BLITE_MIN_REMAINING_MS = 43_000;
export const ANALYSIS_V2_GEMINI_BLITE_LEASE_SECONDS = 240;

export const ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_gemini_leases',
    acquireRpc: 'acquire_analysis_v2_gemini_lease',
    acquireV2Rpc: 'acquire_analysis_v2_gemini_lease_v2',
    acquireSchedulerV1Rpc: 'acquire_analysis_v2_scheduler_gemini_lease_v1',
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
    /** Durable analysis_pipeline_jobs ownership; distinct from the Gemini slot claim. */
    jobClaimToken: z.string().regex(UUID_PATTERN),
    attempt: z.number().int().min(1).max(4),
    /** Handler deadline is monotonic (the same clock returned by dependencies.nowMs). */
    handlerDeadlineAtMs: z.number().finite().nonnegative(),
    /** The only deadline/lease override is the exact, audited B-lite identity. */
    leaseProfile: z.literal('precheckout_blite').optional(),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN).optional(),
    stage: z.enum([
        'genderTriage',
        'genderResolution',
        'featureAnalysis',
        'highRiskNarrative',
        'privateAccountName',
        'partnerSafety',
    ]).optional(),
    aiStagePolicyVersion: z.enum(SUPPORTED_AI_STAGE_POLICY_VERSIONS).optional(),
}).strict().superRefine((input, context) => {
    const v2 = input.aiStagePolicyVersion !== undefined
        && aiStagePolicySupports(input.aiStagePolicyVersion, 'durableGeminiLease');
    if (v2 !== Boolean(input.operationKey && input.stage)) {
        context.addIssue({
            code: 'custom',
            message: 'V2 leases require a complete operation identity.',
        });
    }
    const isExactBliteIdentity = input.jobKey === 'preflight:blite'
        && input.attempt === 1
        && input.operationKey === undefined
        && input.stage === undefined
        && input.aiStagePolicyVersion === undefined;
    if (input.leaseProfile !== undefined && !isExactBliteIdentity) {
        context.addIssue({
            code: 'custom',
            message: 'B-lite lease profile is restricted to the exact preflight identity.',
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
    /** Additive rate-budget fence; the eight-slot Gemini lease remains authoritative. */
    providerAdmissionLease?: AnalysisProviderAdmissionLease;
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
    env?: Record<string, string | undefined>;
    providerAdmissionStore?: AnalysisProviderAdmissionStore;
}

export interface AnalysisV2GeminiLeaseStore {
    acquire(input: {
        requestId: string;
        jobKey: string;
        jobClaimToken: string;
        attempt: number;
        handlerDeadlineAtMs: number;
        leaseProfile?: 'precheckout_blite';
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
        ...(input.aiStagePolicyVersion !== undefined
            && aiStagePolicySupports(input.aiStagePolicyVersion, 'durableGeminiLease') ? {
            operationKey: input.operationKey,
            stage: input.stage,
            aiStagePolicyVersion: input.aiStagePolicyVersion,
        } : {}),
    });
}

function isV2Lease(lease: AnalysisV2GeminiLease): lease is AnalysisV2GeminiLease & {
    operationKey: string;
    stage: AiStageName;
    aiStagePolicyVersion: AiStagePolicyVersion;
} {
    return lease.aiStagePolicyVersion !== undefined
        && aiStagePolicySupports(lease.aiStagePolicyVersion, 'durableGeminiLease')
        && typeof lease.operationKey === 'string'
        && typeof lease.stage === 'string';
}

async function releaseExistingLease(
    lease: AnalysisV2GeminiLease,
    dependencies: AnalysisV2GeminiLeaseDependencies,
): Promise<void> {
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
    // A release RPC may commit the slot update and lose its response. A
    // retry then returns the idempotent post-release shape (`released=false`,
    // `available`, unchanged fence). Treat that exact state as success; a
    // newer owner necessarily advances the monotonic fence and still fails
    // closed below.
    if (
        row.lease_state === 'available'
        && row.fence === lease.fence
    ) {
        return;
    }
    if (!row.released || row.lease_state !== 'available' || row.fence !== lease.fence) {
        throw new AnalysisV2GeminiLeaseFenceError();
    }
}

export function createAnalysisV2GeminiLeaseStore(
    overrides: Partial<AnalysisV2GeminiLeaseDependencies> = {}
): AnalysisV2GeminiLeaseStore {
    // Production callers may provide only environment overrides. Always merge them with the
    // real server defaults so a partial factory call cannot fail at TypeScript/runtime setup.
    const dependencies: AnalysisV2GeminiLeaseDependencies = {
        ...defaultDependencies(),
        ...overrides,
    };
    const providerAdmissions = () => dependencies.providerAdmissionStore ?? analysisProviderAdmissionStore;
    const admissionOperationKey = (input: {
        operationKey?: string;
        stage?: AiStageName;
        attempt: number;
    }): string => `gemini:${input.operationKey ?? `legacy:${input.stage ?? 'unknown'}`}:attempt:${input.attempt}`;
    const isKnownNoCommitAdmissionError = (error: unknown): error is
        AnalysisProviderAdmissionCapacityPendingError
        | AnalysisProviderAdmissionClaimConflictError
        | AnalysisProviderAdmissionIdentityConflictError =>
        error instanceof AnalysisProviderAdmissionCapacityPendingError
        || error instanceof AnalysisProviderAdmissionClaimConflictError
        || error instanceof AnalysisProviderAdmissionIdentityConflictError;
    const rejectAdmissionAndReleaseSlot = async (
        lease: AnalysisV2GeminiLease,
        denial: Error,
    ): Promise<never> => {
        try {
            await releaseExistingLease(lease, dependencies);
        } catch {
            // Do not return a slot whose release is uncertain. The caller can
            // retry the lease cleanup using its still-authoritative fence.
            throw new AnalysisV2GeminiLeasePersistenceError();
        }
        throw denial;
    };
    const attachProviderAdmission = async (
        lease: AnalysisV2GeminiLease,
        input: z.infer<typeof acquireInputSchema>,
    ): Promise<AnalysisV2GeminiLease> => {
        if (!isAnalysisProviderAdmissionEnabled(dependencies.env ?? process.env)) {
            return lease;
        }
        const admissionInput = {
                workloadRole: 'paid',
                logicalProvider: 'gemini',
                credentialSlot: `gemini-${lease.slot}`,
                budgetKey: `paid:gemini:gemini-${lease.slot}`,
                requestId: input.requestId,
                jobKey: input.jobKey,
                operationKey: admissionOperationKey(input),
                // Gemini's slot lease claim is the provider fence. The worker's
                // analysis_pipeline_jobs claim is checked separately by the DB RPC.
                claimToken: lease.claimToken,
                jobClaimToken: input.jobClaimToken,
                providerFence: lease.fence,
                leaseSeconds: input.leaseProfile === 'precheckout_blite'
                    ? ANALYSIS_V2_GEMINI_BLITE_LEASE_SECONDS
                    : AI_GEMINI_LEASE_SECONDS,
            } as const;
        let providerAdmissionLease: AnalysisProviderAdmissionLease;
        try {
            providerAdmissionLease = await providerAdmissions().acquire(admissionInput);
        } catch (firstError) {
            // Typed capacity/claim/identity denials are explicit no-commit
            // outcomes. Do not replay them: return the authoritative Gemini
            // slot before returning the original denial.
            if (isKnownNoCommitAdmissionError(firstError)) {
                return rejectAdmissionAndReleaseSlot(lease, firstError);
            }
            // Only an unknown persistence result is replayed. The first call
            // may have committed the admission before its response was lost,
            // so the same identity/claims must be retried exactly once.
            try {
                providerAdmissionLease = await providerAdmissions().acquire(admissionInput);
            } catch (secondError) {
                // A typed denial on replay proves that this identity did not
                // commit in the first attempt, so safely return the slot and
                // preserve the typed error for normal queue handling.
                if (isKnownNoCommitAdmissionError(secondError)) {
                    return rejectAdmissionAndReleaseSlot(lease, secondError);
                }
                // A second unknown result remains ambiguous. Keep the slot
                // leased (fail closed) so a committed admission cannot be
                // orphaned by cleanup here.
                if (!(firstError instanceof AnalysisProviderAdmissionPersistenceError)) {
                    throw new AnalysisV2GeminiLeasePersistenceError();
                }
                throw secondError instanceof AnalysisProviderAdmissionPersistenceError
                    ? secondError
                    : new AnalysisV2GeminiLeasePersistenceError();
            }
        }
        return Object.freeze({ ...lease, providerAdmissionLease });
    };
    const renewProviderAdmission = async (
        lease: AnalysisV2GeminiLease,
    ): Promise<AnalysisV2GeminiLease> => {
        if (!lease.providerAdmissionLease) return lease;
        const providerAdmissionLease = await providerAdmissions().renew(
            lease.providerAdmissionLease
        );
        return Object.freeze({ ...lease, providerAdmissionLease });
    };
    const releaseProviderAdmission = async (
        lease: AnalysisV2GeminiLease,
    ): Promise<void> => {
        if (!lease.providerAdmissionLease) return;
        try {
            await providerAdmissions().release(lease.providerAdmissionLease);
        } catch (error) {
            if (!(error instanceof AnalysisProviderAdmissionFenceError)) throw error;
            const recovered = await providerAdmissions().recoverExpired({
                admissionId: lease.providerAdmissionLease.admissionId,
                recoveryToken: randomUUID(),
            });
            if (!recovered) throw error;
            const resolved = await providerAdmissions().resolve({
                admissionId: lease.providerAdmissionLease.admissionId,
                resolutionToken: randomUUID(),
            });
            if (!resolved) throw new AnalysisProviderAdmissionResolutionPendingError();
        }
    };
    return {
        async acquire(rawInput) {
            const input = acquireInputSchema.safeParse(rawInput);
            if (!input.success) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            if (
                input.data.handlerDeadlineAtMs - dependencies.nowMs()
                < (
                    input.data.leaseProfile === 'precheckout_blite'
                        ? ANALYSIS_V2_GEMINI_BLITE_MIN_REMAINING_MS
                        : AI_GEMINI_MIN_REMAINING_MS
                )
            ) {
                throw new AnalysisV2AiDeadlineTooShortError();
            }
            const proposedToken = dependencies.randomUuid();
            if (!UUID_PATTERN.test(proposedToken)) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            const usesV2 = input.data.aiStagePolicyVersion !== undefined
                && aiStagePolicySupports(input.data.aiStagePolicyVersion, 'durableGeminiLease');
            const usesSchedulerV1Admission =
                input.data.aiStagePolicyVersion !== undefined
                && aiStagePolicySupports(input.data.aiStagePolicyVersion, 'inputQualityV28')
                && (
                    input.data.stage === 'genderTriage'
                    || input.data.stage === 'featureAnalysis'
                    || input.data.stage === 'privateAccountName'
                );
            const acquireRpc = usesSchedulerV1Admission
                ? ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireSchedulerV1Rpc
                : usesV2
                ? ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireV2Rpc
                : ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireRpc;
            const acquireParams = usesV2 ? {
                    p_request_id: input.data.requestId,
                    p_job_key: input.data.jobKey,
                    p_operation_key: input.data.operationKey,
                    p_stage: input.data.stage,
                    p_attempt: input.data.attempt,
                    p_claim_token: proposedToken,
                    p_lease_seconds: input.data.leaseProfile === 'precheckout_blite'
                        ? ANALYSIS_V2_GEMINI_BLITE_LEASE_SECONDS
                        : AI_GEMINI_LEASE_SECONDS,
                } : {
                    p_request_id: input.data.requestId,
                    p_job_key: input.data.jobKey,
                    p_attempt: input.data.attempt,
                    p_claim_token: proposedToken,
                    p_lease_seconds: input.data.leaseProfile === 'precheckout_blite'
                        ? ANALYSIS_V2_GEMINI_BLITE_LEASE_SECONDS
                        : AI_GEMINI_LEASE_SECONDS,
                };
            let result = await dependencies.rpc(acquireRpc, acquireParams);
            if (result.error) {
                // The slot RPC is idempotent by durable operation identity and
                // proposed claim token. Replay once with the same token when
                // the first response is unknown; this recovers a committed
                // lease without inventing a second Gemini fence.
                result = await dependencies.rpc(acquireRpc, acquireParams);
            }
            const { data, error } = result;
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
            return attachProviderAdmission(parseLease(row, input.data), input.data);
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
            return renewProviderAdmission(Object.freeze({ ...lease, expiresAt: row.expires_at }));
        },

        async release(lease) {
            await releaseProviderAdmission(lease);
            // Fail closed: an uncertain admission release must retain the
            // authoritative Gemini fence. If this second step fails, the slot
            // remains leased and prevents duplicate provider execution.
            await releaseExistingLease(lease, dependencies);
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
