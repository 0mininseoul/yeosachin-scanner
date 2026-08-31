import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type { ApifyCredentialSlot } from '@/lib/services/instagram/providers/types';
import type { AnalysisWorkloadRole } from './workload-role';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const OPERATION_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,255}$/;
const BUDGET_KEY_PATTERN = /^(?:preflight|paid):(?:apify|gemini):[a-z0-9:_-]{1,96}$/;
const CREDENTIAL_SLOT_PATTERN = /^[a-z][a-z0-9_-]{1,31}$/;

export const ANALYSIS_PROVIDER_ADMISSION_DATABASE_NAMES = Object.freeze({
    budgetsTable: 'analysis_provider_admission_budgets',
    leasesTable: 'analysis_provider_admission_leases',
    acquireRpc: 'acquire_analysis_provider_admission',
    renewRpc: 'renew_analysis_provider_admission',
    releaseRpc: 'release_analysis_provider_admission',
    recoverRpc: 'recover_expired_analysis_provider_admission',
    resolveRpc: 'resolve_analysis_provider_admission',
    listExpiredRpc: 'list_expired_analysis_provider_admissions',
    listExpiredPageRpc: 'list_expired_analysis_provider_admissions_page',
});

export type AnalysisProviderAdmissionOutcome = 'acquired' | 'already_acquired' | 'adopted';

export interface AnalysisProviderAdmissionInput {
    workloadRole: AnalysisWorkloadRole;
    logicalProvider: 'apify' | 'gemini';
    credentialSlot: ApifyCredentialSlot | `gemini-${number}` | string;
    budgetKey: string;
    requestId: string;
    jobKey: string;
    operationKey: string;
    /** Provider-ledger claim (Gemini slot claim for Gemini; provider-run claim for Apify). */
    claimToken: string;
    /** Durable analysis_pipeline_jobs claim. Gemini must supply this separately. */
    jobClaimToken: string;
    /** Authoritative provider-ledger fence; required for Gemini slot claims. */
    providerFence?: number;
    leaseSeconds: number;
}

export interface AnalysisProviderAdmissionLease extends AnalysisProviderAdmissionInput {
    readonly outcome: AnalysisProviderAdmissionOutcome;
    readonly admissionId: string;
    readonly leaseToken: string;
    readonly fence: number;
    readonly expiresAt: string;
    readonly activeCount: number;
    readonly maxActive: number;
}

export interface AnalysisProviderAdmissionRecoveryCandidate {
    readonly admissionId: string;
    readonly fence: number;
    readonly expiresAt: string;
}

export interface AnalysisProviderAdmissionRecoveryCursor {
    readonly expiresAt: string;
    readonly fence: number;
    readonly admissionId: string;
}

export interface AnalysisProviderAdmissionRecoveryPage {
    readonly candidates: readonly AnalysisProviderAdmissionRecoveryCandidate[];
    /** True when at least one eligible row remains after this bounded page. */
    readonly hasMore: boolean;
    /** Immutable keyset cursor for the next page, when hasMore is true. */
    readonly nextCursor?: AnalysisProviderAdmissionRecoveryCursor;
}

export interface AnalysisProviderAdmissionDependencies {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<{
        data: unknown;
        error: { code?: string; message?: string } | null;
    }>;
    nowMs(): number;
    randomUuid(): string;
}

export interface AnalysisProviderAdmissionStore {
    acquire(input: AnalysisProviderAdmissionInput): Promise<AnalysisProviderAdmissionLease>;
    renew(lease: AnalysisProviderAdmissionLease): Promise<AnalysisProviderAdmissionLease>;
    release(
        lease: AnalysisProviderAdmissionLease,
        reason?: 'terminal' | 'prestart_rejected',
    ): Promise<void>;
    recoverExpired(input: {
        admissionId: string;
        recoveryToken: string;
    }): Promise<boolean>;
    resolve(input: {
        admissionId: string;
        resolutionToken: string;
    }): Promise<boolean>;
    listExpired(input?: {
        limit?: number;
        cursor?: AnalysisProviderAdmissionRecoveryCursor;
    }): Promise<AnalysisProviderAdmissionRecoveryPage>;
}

export class AnalysisProviderAdmissionCapacityPendingError extends Error {
    constructor() {
        super('ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING');
        this.name = 'AnalysisProviderAdmissionCapacityPendingError';
    }
}

export class AnalysisProviderAdmissionFenceError extends Error {
    constructor() {
        super('ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH');
        this.name = 'AnalysisProviderAdmissionFenceError';
    }
}

export class AnalysisProviderAdmissionIdentityConflictError extends Error {
    constructor() {
        super('ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT');
        this.name = 'AnalysisProviderAdmissionIdentityConflictError';
    }
}

export class AnalysisProviderAdmissionClaimConflictError extends Error {
    constructor() {
        super('ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT');
        this.name = 'AnalysisProviderAdmissionClaimConflictError';
    }
}

export class AnalysisProviderAdmissionResolutionPendingError extends Error {
    constructor() {
        super('ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING');
        this.name = 'AnalysisProviderAdmissionResolutionPendingError';
    }
}

export class AnalysisProviderAdmissionPersistenceError extends Error {
    constructor(message = 'ANALYSIS_PROVIDER_ADMISSION_PERSISTENCE_ERROR') {
        super(message);
        this.name = 'AnalysisProviderAdmissionPersistenceError';
    }
}

export function isAnalysisProviderAdmissionEnabled(
    env: Record<string, string | undefined> = process.env,
): boolean {
    const value = env.ANALYSIS_PROVIDER_ADMISSION_ENABLED?.trim().toLowerCase();
    if (!value || ['0', 'false', 'off', 'no'].includes(value)) return false;
    if (['1', 'true', 'on', 'yes'].includes(value)) return true;
    throw new Error('ANALYSIS_PROVIDER_ADMISSION_CONFIG_ERROR');
}

const acquiredSchema = z.object({
    outcome: z.enum(['acquired', 'already_acquired', 'adopted']),
    admissionId: z.string().regex(HASH_PATTERN),
    workloadRole: z.enum(['preflight', 'paid']),
    logicalProvider: z.enum(['apify', 'gemini']),
    credentialSlot: z.string().regex(CREDENTIAL_SLOT_PATTERN),
    budgetKey: z.string().regex(BUDGET_KEY_PATTERN),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN),
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    leaseToken: z.string().regex(UUID_PATTERN),
    fence: z.number().int().min(1).safe(),
    expiresAt: z.string().datetime({ offset: true }),
    activeCount: z.number().int().min(0).max(100_000),
    maxActive: z.number().int().min(1).max(100_000),
}).strict();

const pendingSchema = z.object({
    outcome: z.literal('capacity_pending'),
    admissionId: z.string().regex(HASH_PATTERN),
    workloadRole: z.enum(['preflight', 'paid']),
    logicalProvider: z.enum(['apify', 'gemini']),
    credentialSlot: z.string().regex(CREDENTIAL_SLOT_PATTERN),
    budgetKey: z.string().regex(BUDGET_KEY_PATTERN),
    operationKey: z.string().regex(OPERATION_KEY_PATTERN),
    requestId: z.string().regex(UUID_PATTERN),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    leaseToken: z.null(),
    fence: z.null(),
    expiresAt: z.null(),
    activeCount: z.number().int().min(0).max(100_000),
    maxActive: z.number().int().min(1).max(100_000),
}).strict();

const acquireSchema = z.union([acquiredSchema, pendingSchema]);
const renewSchema = z.object({
    renewed: z.boolean(),
    fence: z.number().int().min(0).safe(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
}).strict();
const releaseSchema = z.object({
    released: z.boolean(),
}).passthrough();
const recoverSchema = z.object({ recovered: z.boolean() }).strict();
const resolveSchema = z.object({ resolved: z.boolean() }).strict();
const expiredCandidateSchema = z.object({
    admissionId: z.string().regex(HASH_PATTERN),
    fence: z.number().int().min(1).safe(),
    expiresAt: z.string().datetime({ offset: true }),
}).strict();
const expiredCursorSchema = z.object({
    expiresAt: z.string().datetime({ offset: true }),
    fence: z.number().int().min(1).safe(),
    admissionId: z.string().regex(HASH_PATTERN),
}).strict();
// Recovery scans a bounded page and returns an explicit continuation bit.
// The caller's default is the full approved maintenance page, so unresolved
// old rows cannot hide a later recoverable row within the bounded universe.
export const ANALYSIS_PROVIDER_ADMISSION_RECOVERY_SCAN_MAX = 64;
const expiredCandidatesSchema = z.object({
    candidates: z.array(expiredCandidateSchema)
        .max(ANALYSIS_PROVIDER_ADMISSION_RECOVERY_SCAN_MAX),
    hasMore: z.boolean(),
    nextCursor: expiredCursorSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
    // A continuation bit without an exact keyset cursor is not a drain signal:
    // accepting it would make the recovery caller stop after the first page
    // and falsely report that no rows remain.  Reject malformed responses so
    // maintenance fails closed and the next pass can retry discovery.
    if (value.hasMore && !value.nextCursor) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['nextCursor'],
            message: 'nextCursor is required when hasMore is true',
        });
    }
});

function defaultDependencies(): AnalysisProviderAdmissionDependencies {
    return {
        rpc: (name, params) => supabaseAdmin.rpc(name, params),
        nowMs: () => Date.now(),
        randomUuid: randomUUID,
    };
}

function admissionId(input: AnalysisProviderAdmissionInput): string {
    return createHash('sha256')
        .update([
            'analysis-provider-admission-v1',
            input.workloadRole,
            input.logicalProvider,
            input.credentialSlot,
            input.requestId.toLowerCase(),
            input.jobKey,
            input.operationKey,
        ].join('\n'))
        .digest('hex');
}

function validateInput(input: AnalysisProviderAdmissionInput): void {
    if (
        (input.workloadRole !== 'preflight' && input.workloadRole !== 'paid')
        || (input.logicalProvider !== 'apify' && input.logicalProvider !== 'gemini')
        || !CREDENTIAL_SLOT_PATTERN.test(input.credentialSlot)
        || !BUDGET_KEY_PATTERN.test(input.budgetKey)
        || !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !OPERATION_KEY_PATTERN.test(input.operationKey)
        || !UUID_PATTERN.test(input.claimToken)
        || !UUID_PATTERN.test(input.jobClaimToken)
        || (input.providerFence !== undefined
            && (!Number.isSafeInteger(input.providerFence) || input.providerFence < 1))
        || !Number.isSafeInteger(input.leaseSeconds)
        || input.leaseSeconds < 10
        || input.leaseSeconds > 900
    ) {
        throw new AnalysisProviderAdmissionPersistenceError();
    }
    const expectedPrefix = `${input.workloadRole}:${input.logicalProvider}:`;
    if (!input.budgetKey.startsWith(expectedPrefix)) {
        throw new AnalysisProviderAdmissionIdentityConflictError();
    }
    if (input.logicalProvider === 'gemini' && !input.credentialSlot.startsWith('gemini-')) {
        throw new AnalysisProviderAdmissionIdentityConflictError();
    }
    if (input.logicalProvider === 'gemini' && input.providerFence === undefined) {
        throw new AnalysisProviderAdmissionIdentityConflictError();
    }
    if (input.logicalProvider === 'apify' && input.providerFence !== undefined) {
        throw new AnalysisProviderAdmissionIdentityConflictError();
    }
}

function safeRpcCode(error: { code?: string } | null): string {
    return error && typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(
    error: { code?: string; message?: string },
    operation: string,
): never {
    if (error.message === 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING') {
        throw new AnalysisProviderAdmissionCapacityPendingError();
    }
    if (
        error.message === 'ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_PROVIDER_ADMISSION_NOT_FOUND'
    ) {
        throw new AnalysisProviderAdmissionFenceError();
    }
    if (error.message === 'ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT') {
        throw new AnalysisProviderAdmissionClaimConflictError();
    }
    if (error.message === 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING') {
        throw new AnalysisProviderAdmissionResolutionPendingError();
    }
    if (error.message === 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT') {
        throw new AnalysisProviderAdmissionIdentityConflictError();
    }
    if (error.message === 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN') {
        throw new AnalysisProviderAdmissionIdentityConflictError();
    }
    throw new AnalysisProviderAdmissionPersistenceError(
        `ANALYSIS_PROVIDER_ADMISSION_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`,
    );
}

function parseAcquired(
    value: unknown,
    input: AnalysisProviderAdmissionInput,
): AnalysisProviderAdmissionLease {
    const parsed = acquireSchema.safeParse(value);
    if (!parsed.success) throw new AnalysisProviderAdmissionPersistenceError();
    if (parsed.data.outcome === 'capacity_pending') {
        throw new AnalysisProviderAdmissionCapacityPendingError();
    }
    if (
        parsed.data.admissionId !== admissionId(input)
        || parsed.data.workloadRole !== input.workloadRole
        || parsed.data.logicalProvider !== input.logicalProvider
        || parsed.data.credentialSlot !== input.credentialSlot
        || parsed.data.budgetKey !== input.budgetKey
        || parsed.data.requestId.toLowerCase() !== input.requestId.toLowerCase()
        || parsed.data.jobKey !== input.jobKey
        || parsed.data.operationKey !== input.operationKey
    ) {
        throw new AnalysisProviderAdmissionIdentityConflictError();
    }
    return Object.freeze({
        ...input,
        outcome: parsed.data.outcome,
        admissionId: parsed.data.admissionId,
        requestId: parsed.data.requestId.toLowerCase(),
        leaseToken: parsed.data.leaseToken,
        fence: parsed.data.fence,
        expiresAt: parsed.data.expiresAt,
        activeCount: parsed.data.activeCount,
        maxActive: parsed.data.maxActive,
    });
}

export function createAnalysisProviderAdmissionStore(
    dependencies: Partial<AnalysisProviderAdmissionDependencies> = {},
): AnalysisProviderAdmissionStore {
    const resolved: AnalysisProviderAdmissionDependencies = {
        ...defaultDependencies(),
        ...dependencies,
    };
    return Object.freeze({
        async acquire(input: AnalysisProviderAdmissionInput) {
            validateInput(input);
            const id = admissionId(input);
            const proposedLeaseToken = resolved.randomUuid();
            if (!UUID_PATTERN.test(proposedLeaseToken)) {
                throw new AnalysisProviderAdmissionPersistenceError();
            }
            let result: {
                data: unknown;
                error: { code?: string; message?: string } | null;
            };
            try {
                result = await resolved.rpc(
                    ANALYSIS_PROVIDER_ADMISSION_DATABASE_NAMES.acquireRpc,
                    {
                        p_admission_id: id,
                        p_workload_role: input.workloadRole,
                        p_logical_provider: input.logicalProvider,
                        p_credential_slot: input.credentialSlot,
                        p_budget_key: input.budgetKey,
                        p_request_id: input.requestId.toLowerCase(),
                        p_job_key: input.jobKey,
                        p_operation_key: input.operationKey,
                        p_job_claim_token: input.jobClaimToken.toLowerCase(),
                        p_claim_token: input.claimToken.toLowerCase(),
                        p_provider_fence: input.providerFence ?? null,
                        p_lease_token: proposedLeaseToken,
                        p_lease_seconds: input.leaseSeconds,
                    },
                );
            } catch (error) {
                if (
                    error instanceof AnalysisProviderAdmissionCapacityPendingError
                    || error instanceof AnalysisProviderAdmissionFenceError
                    || error instanceof AnalysisProviderAdmissionClaimConflictError
                    || error instanceof AnalysisProviderAdmissionResolutionPendingError
                    || error instanceof AnalysisProviderAdmissionIdentityConflictError
                    || error instanceof AnalysisProviderAdmissionPersistenceError
                ) {
                    throw error;
                }
                throw new AnalysisProviderAdmissionPersistenceError();
            }
            if (result.error) throwRpcError(result.error, 'acquire');
            return parseAcquired(result.data, input);
        },

        async renew(lease: AnalysisProviderAdmissionLease) {
            validateInput(lease);
            const result = await resolved.rpc(
                ANALYSIS_PROVIDER_ADMISSION_DATABASE_NAMES.renewRpc,
                {
                    p_admission_id: lease.admissionId,
                    p_lease_token: lease.leaseToken,
                    p_fence: lease.fence,
                    p_lease_seconds: lease.leaseSeconds,
                },
            );
            if (result.error) throwRpcError(result.error, 'renew');
            const parsed = renewSchema.safeParse(result.data);
            if (!parsed.success || !parsed.data.renewed || !parsed.data.expiresAt) {
                throw new AnalysisProviderAdmissionFenceError();
            }
            if (parsed.data.fence !== lease.fence) {
                throw new AnalysisProviderAdmissionFenceError();
            }
            return Object.freeze({ ...lease, expiresAt: parsed.data.expiresAt });
        },

        async release(
            lease: AnalysisProviderAdmissionLease,
            reason: 'terminal' | 'prestart_rejected' = 'terminal',
        ) {
            validateInput(lease);
            const result = await resolved.rpc(
                ANALYSIS_PROVIDER_ADMISSION_DATABASE_NAMES.releaseRpc,
                {
                    p_admission_id: lease.admissionId,
                    p_lease_token: lease.leaseToken,
                    p_fence: lease.fence,
                    p_release_reason: reason,
                },
            );
            if (result.error) throwRpcError(result.error, 'release');
            const parsed = releaseSchema.safeParse(result.data);
            if (!parsed.success || !parsed.data.released) {
                throw new AnalysisProviderAdmissionFenceError();
            }
        },

        async recoverExpired(input: {
            admissionId: string;
            recoveryToken: string;
        }) {
            if (!HASH_PATTERN.test(input.admissionId) || !UUID_PATTERN.test(input.recoveryToken)) {
                throw new AnalysisProviderAdmissionPersistenceError();
            }
            const result = await resolved.rpc(
                ANALYSIS_PROVIDER_ADMISSION_DATABASE_NAMES.recoverRpc,
                {
                    p_admission_id: input.admissionId,
                    p_recovery_token: input.recoveryToken,
                },
            );
            if (result.error) throwRpcError(result.error, 'recover');
            const parsed = recoverSchema.safeParse(result.data);
            if (!parsed.success) throw new AnalysisProviderAdmissionPersistenceError();
            return parsed.data.recovered;
        },

        async resolve(input: {
            admissionId: string;
            resolutionToken: string;
        }) {
            if (!HASH_PATTERN.test(input.admissionId) || !UUID_PATTERN.test(input.resolutionToken)) {
                throw new AnalysisProviderAdmissionPersistenceError();
            }
            const result = await resolved.rpc(
                ANALYSIS_PROVIDER_ADMISSION_DATABASE_NAMES.resolveRpc,
                {
                    p_admission_id: input.admissionId,
                    p_resolution_token: input.resolutionToken,
                },
            );
            if (result.error) throwRpcError(result.error, 'resolve');
            const parsed = resolveSchema.safeParse(result.data);
            if (!parsed.success) throw new AnalysisProviderAdmissionPersistenceError();
            return parsed.data.resolved;
        },

        async listExpired(input: {
            limit?: number;
            cursor?: AnalysisProviderAdmissionRecoveryCursor;
        } = {}) {
            const limit = input.limit ?? ANALYSIS_PROVIDER_ADMISSION_RECOVERY_SCAN_MAX;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) {
                throw new AnalysisProviderAdmissionPersistenceError();
            }
            const result = await resolved.rpc(
                // Always use the cursor-capable RPC, including the first page.
                // The legacy one-argument wrapper intentionally strips its
                // continuation key for old binaries and is therefore unsafe
                // for this recovery caller.
                ANALYSIS_PROVIDER_ADMISSION_DATABASE_NAMES.listExpiredPageRpc,
                {
                    p_limit: limit,
                    p_after_expires_at: input.cursor?.expiresAt ?? null,
                    p_after_fence: input.cursor?.fence ?? null,
                    p_after_admission_id: input.cursor?.admissionId ?? null,
                },
            );
            if (result.error) throwRpcError(result.error, 'list-expired');
            const parsed = expiredCandidatesSchema.safeParse(result.data);
            if (!parsed.success) throw new AnalysisProviderAdmissionPersistenceError();
            return Object.freeze({
                candidates: Object.freeze(parsed.data.candidates.map(candidate => Object.freeze(candidate))),
                hasMore: parsed.data.hasMore,
                ...(parsed.data.nextCursor
                    ? { nextCursor: Object.freeze(parsed.data.nextCursor) }
                    : {}),
            });
        },
    });
}

export const analysisProviderAdmissionStore = createAnalysisProviderAdmissionStore();

export function analysisProviderAdmissionId(input: AnalysisProviderAdmissionInput): string {
    validateInput(input);
    return admissionId(input);
}
