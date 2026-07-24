import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    AI_GEMINI_LEASE_SECONDS,
    AI_GEMINI_MIN_REMAINING_MS,
} from '@/lib/services/ai/stage-policy';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;

export const ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_gemini_leases',
    acquireRpc: 'acquire_analysis_v2_gemini_lease',
    renewRpc: 'renew_analysis_v2_gemini_lease',
    releaseRpc: 'release_analysis_v2_gemini_lease',
});

const acquiredRowSchema = z.object({
    outcome: z.literal('acquired'),
    slot: z.number().int().min(1).max(8),
    lease_claim_token: z.string().regex(UUID_PATTERN),
    fence: z.number().int().min(1).safe(),
    expires_at: z.string().datetime({ offset: true }),
}).strict();
const unavailableRowSchema = z.object({
    outcome: z.enum(['capacity_pending', 'quarantine_active']),
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
}).strict();

export type AnalysisV2GeminiLease = Readonly<{
    slot: number;
    claimToken: string;
    fence: number;
    expiresAt: string;
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
    }): Promise<AnalysisV2GeminiLease>;
    renew(lease: AnalysisV2GeminiLease): Promise<AnalysisV2GeminiLease>;
    release(lease: AnalysisV2GeminiLease): Promise<void>;
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

function parseLease(value: z.infer<typeof acquiredRowSchema>): AnalysisV2GeminiLease {
    return Object.freeze({
        slot: value.slot,
        claimToken: value.lease_claim_token,
        fence: value.fence,
        expiresAt: value.expires_at,
    });
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
            const { data, error } = await dependencies.rpc(
                ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.acquireRpc,
                {
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
            if (row.outcome === 'quarantine_active') {
                throw new AnalysisV2AiQuarantineActiveError();
            }
            if (row.lease_claim_token !== proposedToken) {
                throw new AnalysisV2GeminiLeasePersistenceError();
            }
            return parseLease(row);
        },

        async renew(lease) {
            const { data, error } = await dependencies.rpc(
                ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.renewRpc,
                {
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
                ANALYSIS_V2_GEMINI_LEASE_DATABASE_NAMES.releaseRpc,
                {
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
    };
}

export const analysisV2GeminiLeaseStore = createAnalysisV2GeminiLeaseStore();

export function isAnalysisV2AiAdmissionSignal(error: unknown): error is Error {
    return error instanceof AnalysisV2AiCapacityPendingError
        || error instanceof AnalysisV2AiDeadlineTooShortError
        || error instanceof AnalysisV2AiQuarantineActiveError;
}
