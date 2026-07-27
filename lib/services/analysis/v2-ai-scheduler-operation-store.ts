import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    AnalysisV2SchedulerOperationStore,
    AnalysisV2SchedulerStage,
} from './v2-ai-scheduler-runtime';

const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const OPERATION_KEY_PATTERN =
    /^(gender-triage|feature-analysis|private-account-name):[0-9a-f]{64}$/;
const OPERATION_LEASE_SECONDS = 330;

export const ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_scheduler_operations',
    claimRpc: 'claim_analysis_v2_scheduler_operation',
    commitRpc: 'commit_analysis_v2_scheduler_operation',
    deferRpc: 'defer_analysis_v2_scheduler_operation',
    recoverRpc: 'recover_analysis_v2_scheduler_operations',
    reapLeasesRpc: 'reap_analysis_v2_scheduler_gemini_leases',
});

interface RpcResult {
    data: unknown;
    error: null | { code?: string; message?: string };
}

const recoveredCountSchema = z.number().int().min(0).max(32);

export async function recoverAnalysisV2SchedulerOperations(input: {
    limit?: number;
    client?: AnalysisV2SchedulerOperationSupabaseClient;
} = {}): Promise<number> {
    const limit = input.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) {
        throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_VALIDATION_ERROR');
    }
    const { data, error } = await (input.client ?? supabaseAdmin).rpc(
        ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES.recoverRpc,
        { p_limit: limit },
    );
    const parsed = recoveredCountSchema.safeParse(data);
    if (error || !parsed.success) {
        throw new Error(
            'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: '
            + `recovery failed (${error ? safeCode(error) : 'invalid'}).`,
        );
    }
    return parsed.data;
}

export async function reapAnalysisV2SchedulerGeminiLeases(input: {
    limit?: number;
    client?: AnalysisV2SchedulerOperationSupabaseClient;
} = {}): Promise<number> {
    const limit = input.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
        throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_VALIDATION_ERROR');
    }
    const { data, error } = await (input.client ?? supabaseAdmin).rpc(
        ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES.reapLeasesRpc,
        { p_limit: limit },
    );
    const parsed = recoveredCountSchema.safeParse(data);
    if (error || !parsed.success) {
        throw new Error(
            'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: '
            + `lease reap failed (${error ? safeCode(error) : 'invalid'}).`,
        );
    }
    return parsed.data;
}

export interface AnalysisV2SchedulerOperationSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

const claimRowSchema = z.object({
    decision: z.enum(['execute', 'ready', 'deferred', 'terminal_unavailable']),
    operation_claim_token: z.string().regex(UUID_PATTERN).nullable(),
    recovery_only: z.boolean(),
    result_json: z.unknown().nullable(),
    not_before_at: z.string().datetime({ offset: true }).nullable(),
}).strict().superRefine((row, context) => {
    if (
        (row.decision === 'execute' || row.decision === 'terminal_unavailable')
        && row.operation_claim_token === null
    ) {
        context.addIssue({ code: 'custom', message: 'Execute requires a claim token.' });
    }
    if (
        row.decision !== 'execute'
        && row.decision !== 'terminal_unavailable'
        && row.operation_claim_token !== null
    ) {
        context.addIssue({ code: 'custom', message: 'Only execute may return a claim token.' });
    }
    if ((row.decision === 'ready') !== (row.result_json !== null)) {
        context.addIssue({ code: 'custom', message: 'Ready requires one result.' });
    }
    if (
        row.recovery_only
        && row.decision !== 'execute'
        && row.decision !== 'terminal_unavailable'
    ) {
        context.addIssue({ code: 'custom', message: 'Recovery is an execute decision.' });
    }
    if ((row.decision === 'deferred') !== (row.not_before_at !== null)) {
        context.addIssue({ code: 'custom', message: 'Deferred requires not-before.' });
    }
});

function oneRow(data: unknown) {
    const parsed = z.union([claimRowSchema, z.array(claimRowSchema).length(1)])
        .safeParse(data);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: invalid result.');
    }
    return Array.isArray(parsed.data) ? parsed.data[0]! : parsed.data;
}

function safeCode(error: NonNullable<RpcResult['error']>): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function databaseTimestampToMonotonicMs(value: string): number {
    const epochMs = Date.parse(value);
    if (!Number.isFinite(epochMs)) {
        throw new Error(
            'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: invalid defer time.'
        );
    }
    return performance.now() + (epochMs - Date.now());
}

export function createAnalysisV2SchedulerOperationStore<T>(input: {
    requestId: string;
    jobKey: string;
    jobClaimToken: string;
    schemas: ReadonlyMap<string, z.ZodType<T>>;
    client?: AnalysisV2SchedulerOperationSupabaseClient;
    randomUuid?: () => string;
}): AnalysisV2SchedulerOperationStore<T> {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !UUID_PATTERN.test(input.jobClaimToken)
    ) {
        throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_VALIDATION_ERROR');
    }
    const client = input.client ?? supabaseAdmin;
    const nextUuid = input.randomUuid ?? randomUUID;
    const claims = new Map<string, string>();

    return {
        async claim(operation) {
            const schema = input.schemas.get(operation.key);
            const proposedToken = nextUuid();
            if (
                !schema
                || !OPERATION_KEY_PATTERN.test(operation.key)
                || !UUID_PATTERN.test(proposedToken)
            ) {
                throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_VALIDATION_ERROR');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES.claimRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_job_claim_token: input.jobClaimToken.toLowerCase(),
                    p_operation_key: operation.key,
                    p_stage: operation.stage,
                    p_operation_claim_token: proposedToken.toLowerCase(),
                    p_lease_seconds: OPERATION_LEASE_SECONDS,
                },
            );
            if (error) {
                throw new Error(
                    'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: '
                    + `claim failed (${safeCode(error)}).`,
                );
            }
            const row = oneRow(data);
            if (row.decision === 'deferred') {
                const notBeforeAtMs = databaseTimestampToMonotonicMs(row.not_before_at!);
                return { decision: 'deferred' as const, notBeforeAtMs };
            }
            if (row.decision === 'ready') {
                const parsed = schema.safeParse(row.result_json);
                if (!parsed.success) {
                    throw new Error(
                        'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: invalid ready result.'
                    );
                }
                return { decision: 'ready' as const, value: parsed.data };
            }
            claims.set(operation.key, row.operation_claim_token!);
            return {
                decision: 'execute' as const,
                claimToken: row.operation_claim_token!,
                ...(row.recovery_only || row.decision === 'terminal_unavailable'
                    ? { recoveryOnly: true }
                    : {}),
                ...(row.decision === 'terminal_unavailable'
                    ? { terminalUnavailable: true }
                    : {}),
            };
        },

        async commitReady(operation) {
            const schema = input.schemas.get(operation.key);
            const expectedClaim = claims.get(operation.key);
            if (
                !schema
                || !expectedClaim
                || expectedClaim !== operation.claimToken
            ) {
                throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_FENCE_MISMATCH');
            }
            const value = schema.parse(operation.value);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES.commitRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_job_claim_token: input.jobClaimToken.toLowerCase(),
                    p_operation_key: operation.key,
                    p_stage: operation.stage as AnalysisV2SchedulerStage,
                    p_operation_claim_token: operation.claimToken,
                    p_result_json: value,
                },
            );
            if (error || data !== true) {
                throw new Error(
                    'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: '
                    + `commit failed (${error ? safeCode(error) : 'invalid'}).`,
                );
            }
            claims.delete(operation.key);
        },

        async defer(operation) {
            const expectedClaim = claims.get(operation.key);
            if (!expectedClaim || expectedClaim !== operation.claimToken) {
                throw new Error('ANALYSIS_V2_SCHEDULER_OPERATION_FENCE_MISMATCH');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_SCHEDULER_OPERATION_DATABASE_NAMES.deferRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_job_key: input.jobKey,
                    p_job_claim_token: input.jobClaimToken.toLowerCase(),
                    p_operation_key: operation.key,
                    p_stage: operation.stage,
                    p_operation_claim_token: operation.claimToken,
                    p_reason: operation.reason,
                },
            );
            if (error || typeof data !== 'string') {
                throw new Error(
                    'ANALYSIS_V2_SCHEDULER_OPERATION_PERSISTENCE_ERROR: '
                    + `defer failed (${error ? safeCode(error) : 'invalid'}).`,
                );
            }
            const notBeforeAtMs = databaseTimestampToMonotonicMs(data);
            claims.delete(operation.key);
            return notBeforeAtMs;
        },
    };
}
