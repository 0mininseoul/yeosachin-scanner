import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const JOB_PART_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
const INPUT_HASH_PATTERN = /^[0-9a-f]{64}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const TASK_NAME_PATTERN = /^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/locations\/[a-z]+-[a-z]+[0-9]\/queues\/[a-z](?:[a-z0-9-]{0,98}[a-z0-9])?\/tasks\/analysis-v2-[a-z0-9-]+$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

// Keep a completion-RPC margin beyond the 300-second Cloud Tasks transport deadline.
export const ANALYSIS_V2_JOB_LEASE_SECONDS = 360;

/** RPC names are a shared contract with the additive Phase C migration. */
export const ANALYSIS_V2_DATABASE_NAMES = Object.freeze({
    table: 'analysis_pipeline_jobs',
    reserveDispatchRpc: 'reserve_analysis_v2_job_dispatch',
    rearmDispatchRpc: 'rearm_analysis_v2_job_dispatch',
    deferRecoveryRpc: 'defer_analysis_v2_job_recovery',
    markDispatchedRpc: 'mark_analysis_v2_job_dispatched',
    claimRpc: 'claim_analysis_v2_job',
    deferTerminalCleanupRpc: 'defer_analysis_v2_terminal_cleanup',
    deferAiCapacityRpc: 'defer_analysis_v2_job_for_ai_capacity',
    releaseClaimRpc: 'release_analysis_v2_job_claim',
    completeAndFanoutRpc: 'complete_analysis_v2_job_and_fanout',
    listDispatchableRpc: 'list_analysis_v2_dispatchable_jobs',
});

export const ANALYSIS_V2_JOB_STATUSES = [
    'pending',
    'processing',
    'completed',
    'failed',
    'cancelled',
] as const;

export const ANALYSIS_V2_DISPATCH_STATES = [
    'pending',
    'reserved',
    'enqueued',
    'delivered',
] as const;

export type AnalysisV2JobStatus = typeof ANALYSIS_V2_JOB_STATUSES[number];
export type AnalysisV2DispatchState = typeof ANALYSIS_V2_DISPATCH_STATES[number];

export interface AnalysisV2JobIdentity {
    requestId: string;
    jobKey: string;
}

export interface AnalysisV2JobDefinition extends AnalysisV2JobIdentity {
    track: string;
    kind: string;
    batch: number | null;
    inputHash: string;
}

/**
 * Job keys and dependency keys must be opaque, PII-free identifiers. The database also limits
 * their size, but callers remain responsible for never embedding usernames or evidence text.
 */
export interface AnalysisV2JobSuccessor {
    jobKey: string;
    track: string;
    kind: string;
    batch: number | null;
    inputHash: string;
    requiredJobKeys?: readonly string[];
}

export interface AnalysisV2JobDispatchReservation extends AnalysisV2JobIdentity {
    reserved: boolean;
    generation: number;
    reservationToken: string | null;
    status: AnalysisV2JobStatus;
    dispatchState: AnalysisV2DispatchState;
    taskName: string | null;
}

export interface AnalysisV2TaskDelivery extends AnalysisV2JobIdentity {
    generation: number;
    reservationToken: string;
}

export interface ClaimedAnalysisV2Job extends AnalysisV2JobDefinition {
    generation: number;
    reservationToken: string;
    claimToken: string;
    attemptCount: number;
}

export interface AnalysisV2DispatchableJob extends AnalysisV2JobIdentity {
    status: AnalysisV2JobStatus;
    dispatchState: AnalysisV2DispatchState;
    generation: number;
    reservationToken: string | null;
    reservedAt: string | null;
    dispatchedAt: string | null;
    taskName: string | null;
    leaseExpiresAt: string | null;
}

export interface AnalysisV2JobReleaseResult {
    released: boolean;
    status: AnalysisV2JobStatus;
    attemptCount: number;
    requestStatus: string;
}

export type AnalysisV2AiAdmissionErrorCode =
    | 'ANALYSIS_V2_AI_CAPACITY_PENDING'
    | 'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT'
    | 'ANALYSIS_V2_AI_QUARANTINE_ACTIVE';

export interface AnalysisV2JobStore {
    reserveDispatch(input: AnalysisV2JobIdentity): Promise<AnalysisV2JobDispatchReservation>;
    rearmDispatch(input: AnalysisV2JobIdentity & {
        expectedGeneration: number;
        expectedReservationToken: string;
    }): Promise<AnalysisV2JobDispatchReservation>;
    deferRecovery(input: AnalysisV2JobIdentity & {
        expectedGeneration: number;
        expectedReservationToken: string;
        expectedStatus: 'pending' | 'processing';
        expectedLeaseExpiresAt: string | null;
    }): Promise<boolean>;
    markDispatched(reservation: AnalysisV2JobDispatchReservation & {
        reservationToken: string;
        taskName: string;
    }): Promise<void>;
    claim(
        delivery: AnalysisV2TaskDelivery,
        leaseSeconds?: number,
        maxAttempts?: number
    ): Promise<ClaimedAnalysisV2Job | null>;
    deferTerminalCleanup(
        claim: ClaimedAnalysisV2Job
    ): Promise<AnalysisV2JobReleaseResult>;
    deferAiCapacity(
        claim: ClaimedAnalysisV2Job,
        errorCode: AnalysisV2AiAdmissionErrorCode
    ): Promise<AnalysisV2JobReleaseResult>;
    releaseClaim(claim: ClaimedAnalysisV2Job, failure?: {
        errorCode?: string | null;
        retryable?: boolean;
        maxAttempts?: number;
    }): Promise<AnalysisV2JobReleaseResult>;
    completeAndFanout(
        claim: ClaimedAnalysisV2Job,
        successors: readonly AnalysisV2JobSuccessor[]
    ): Promise<AnalysisV2JobIdentity[]>;
    listDispatchable(input?: {
        limit?: number;
    }): Promise<AnalysisV2DispatchableJob[]>;
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2JobSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export class AnalysisV2JobLeaseBusyError extends Error {
    constructor() {
        super('ANALYSIS_V2_JOB_LEASE_BUSY');
        this.name = 'AnalysisV2JobLeaseBusyError';
    }
}

export class AnalysisV2JobDispatchNotReadyError extends Error {
    constructor() {
        super('ANALYSIS_V2_JOB_DISPATCH_NOT_READY');
        this.name = 'AnalysisV2JobDispatchNotReadyError';
    }
}

export class AnalysisV2JobFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_JOB_FENCE_MISMATCH');
        this.name = 'AnalysisV2JobFenceError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rpcRows(data: unknown, label: string): Record<string, unknown>[] {
    if (data === null) return [];
    if (Array.isArray(data)) {
        if (!data.every(isRecord)) {
            throw new Error(`ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid ${label} result.`);
        }
        return data;
    }
    if (isRecord(data)) return [data];
    throw new Error(`ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid ${label} result.`);
}

function singleRpcRow(data: unknown, label: string): Record<string, unknown> {
    const rows = rpcRows(data, label);
    if (rows.length !== 1) {
        throw new Error(`ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid ${label} result.`);
    }
    return rows[0];
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (error.message === 'ANALYSIS_V2_JOB_LEASE_BUSY') {
        throw new AnalysisV2JobLeaseBusyError();
    }
    if (error.message === 'ANALYSIS_V2_JOB_DISPATCH_NOT_READY') {
        throw new AnalysisV2JobDispatchNotReadyError();
    }
    if (
        error.message === 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_JOB_DISPATCH_CONFLICT'
        || error.message === 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_JOB_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_JOB_LEASE_LOST'
    ) {
        throw new AnalysisV2JobFenceError();
    }
    throw new Error(
        `ANALYSIS_V2_JOB_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

export function assertAnalysisV2JobIdentity(
    input: AnalysisV2JobIdentity
): AnalysisV2JobIdentity {
    if (!UUID_PATTERN.test(input.requestId) || !JOB_KEY_PATTERN.test(input.jobKey)) {
        throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid job identity.');
    }
    return {
        requestId: input.requestId.toLowerCase(),
        jobKey: input.jobKey,
    };
}

function requiredUuid(value: unknown, field: string): string {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid ${field}.`);
    }
    return value.toLowerCase();
}

function requiredJobKey(value: unknown): string {
    if (typeof value !== 'string' || !JOB_KEY_PATTERN.test(value)) {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid job key.');
    }
    return value;
}

function requiredJobPart(value: unknown, field: string): string {
    if (typeof value !== 'string' || !JOB_PART_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid ${field}.`);
    }
    return value;
}

function requiredInputHash(value: unknown): string {
    if (typeof value !== 'string' || !INPUT_HASH_PATTERN.test(value)) {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid input hash.');
    }
    return value;
}

function requiredSafeInteger(
    value: unknown,
    field: string,
    minimum: number,
    maximum: number
): number {
    if (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < minimum
        || value > maximum
    ) {
        throw new Error(`ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid ${field}.`);
    }
    return value;
}

function nullableBatch(value: unknown): number | null {
    if (value === null) return null;
    return requiredSafeInteger(value, 'batch', 0, 100_000);
}

function requiredStatus(value: unknown): AnalysisV2JobStatus {
    if (!ANALYSIS_V2_JOB_STATUSES.includes(value as AnalysisV2JobStatus)) {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid job status.');
    }
    return value as AnalysisV2JobStatus;
}

function requiredDispatchState(value: unknown): AnalysisV2DispatchState {
    if (!ANALYSIS_V2_DISPATCH_STATES.includes(value as AnalysisV2DispatchState)) {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid dispatch state.');
    }
    return value as AnalysisV2DispatchState;
}

function nullableTimestamp(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value)) {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid dispatch timestamp.');
    }
    return value;
}

function nullableTaskName(value: unknown): string | null {
    if (value === null) return null;
    if (typeof value !== 'string' || value.length > 512 || !TASK_NAME_PATTERN.test(value)) {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid task name.');
    }
    return value;
}

function requiredTaskName(value: unknown): string {
    const taskName = nullableTaskName(value);
    if (!taskName) {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: missing task name.');
    }
    return taskName;
}

function reservationFromRow(
    row: Record<string, unknown>,
    identity: AnalysisV2JobIdentity
): AnalysisV2JobDispatchReservation {
    if (typeof row.reserved !== 'boolean') {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid dispatch reservation.');
    }
    const token = row.reservation_token === null
        ? null
        : requiredUuid(row.reservation_token, 'reservation token');
    const generation = requiredSafeInteger(
        row.dispatch_generation,
        'dispatch generation',
        0,
        1_000
    );
    if (row.reserved && (generation < 1 || token === null)) {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: incomplete dispatch reservation.');
    }
    return {
        ...identity,
        reserved: row.reserved,
        generation,
        reservationToken: token,
        status: requiredStatus(row.job_status),
        dispatchState: requiredDispatchState(row.dispatch_state),
        taskName: nullableTaskName(row.task_name),
    };
}

function dispatchableFromRow(row: Record<string, unknown>): AnalysisV2DispatchableJob {
    return {
        requestId: requiredUuid(row.request_id, 'request id'),
        jobKey: requiredJobKey(row.job_key),
        status: requiredStatus(row.job_status),
        dispatchState: requiredDispatchState(row.dispatch_state),
        generation: requiredSafeInteger(
            row.dispatch_generation,
            'dispatch generation',
            0,
            1_000
        ),
        reservationToken: row.reservation_token === null
            ? null
            : requiredUuid(row.reservation_token, 'reservation token'),
        reservedAt: nullableTimestamp(row.dispatch_reserved_at),
        dispatchedAt: nullableTimestamp(row.dispatched_at),
        taskName: nullableTaskName(row.task_name),
        leaseExpiresAt: nullableTimestamp(row.lease_expires_at),
    };
}

function claimedFromRow(
    row: Record<string, unknown>,
    delivery: AnalysisV2TaskDelivery,
    claimToken: string
): ClaimedAnalysisV2Job | null {
    if (typeof row.claimed !== 'boolean') {
        throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid job claim.');
    }
    const status = requiredStatus(row.job_status);
    if (!row.claimed) {
        if (status === 'processing') throw new AnalysisV2JobLeaseBusyError();
        if (!['completed', 'failed', 'cancelled'].includes(status)) {
            throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid unclaimed job state.');
        }
        return null;
    }
    const identity = assertAnalysisV2JobIdentity(delivery);
    return {
        ...identity,
        track: requiredJobPart(row.track, 'track'),
        kind: requiredJobPart(row.job_kind, 'kind'),
        batch: nullableBatch(row.batch),
        inputHash: requiredInputHash(row.input_hash),
        generation: delivery.generation,
        reservationToken: requiredUuid(delivery.reservationToken, 'reservation token'),
        claimToken,
        attemptCount: requiredSafeInteger(row.attempt_count, 'attempt count', 1, 100),
    };
}

function validateSuccessor(successor: AnalysisV2JobSuccessor): Record<string, unknown> {
    const jobKey = requiredJobKey(successor.jobKey);
    const requiredJobKeys = [...(successor.requiredJobKeys ?? [])].map(requiredJobKey);
    if (
        requiredJobKeys.length > 64
        || new Set(requiredJobKeys).size !== requiredJobKeys.length
        || requiredJobKeys.includes(jobKey)
    ) {
        throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid successor dependencies.');
    }
    return {
        jobKey,
        track: requiredJobPart(successor.track, 'track'),
        kind: requiredJobPart(successor.kind, 'kind'),
        batch: nullableBatch(successor.batch),
        inputHash: requiredInputHash(successor.inputHash),
        requiredJobKeys,
    };
}

export function createSupabaseAnalysisV2JobStore(
    client: AnalysisV2JobSupabaseClient
): AnalysisV2JobStore {
    return {
        async reserveDispatch(input) {
            const identity = assertAnalysisV2JobIdentity(input);
            const proposedToken = randomUUID();
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.reserveDispatchRpc,
                {
                    p_request_id: identity.requestId,
                    p_job_key: identity.jobKey,
                    p_dispatch_token: proposedToken,
                }
            );
            if (error) throwRpcError(error, 'dispatch reserve');
            return reservationFromRow(singleRpcRow(data, 'dispatch reserve'), identity);
        },

        async rearmDispatch(input) {
            const identity = assertAnalysisV2JobIdentity(input);
            const expectedGeneration = requiredSafeInteger(
                input.expectedGeneration,
                'expected dispatch generation',
                1,
                1_000
            );
            const expectedReservationToken = requiredUuid(
                input.expectedReservationToken,
                'expected reservation token'
            );
            const proposedToken = randomUUID();
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.rearmDispatchRpc,
                {
                    p_request_id: identity.requestId,
                    p_job_key: identity.jobKey,
                    p_expected_generation: expectedGeneration,
                    p_expected_dispatch_token: expectedReservationToken,
                    p_new_dispatch_token: proposedToken,
                }
            );
            if (error) throwRpcError(error, 'dispatch rearm');
            const row = singleRpcRow(data, 'dispatch rearm');
            const reservation = reservationFromRow({
                ...row,
                reserved: row.rearmed,
                task_name: null,
            }, identity);
            if (!reservation.reserved) {
                throw new AnalysisV2JobFenceError();
            }
            return reservation;
        },

        async deferRecovery(input) {
            const identity = assertAnalysisV2JobIdentity(input);
            const expectedGeneration = requiredSafeInteger(
                input.expectedGeneration,
                'expected dispatch generation',
                1,
                1_000
            );
            const expectedReservationToken = requiredUuid(
                input.expectedReservationToken,
                'expected reservation token'
            );
            const expectedStatus = requiredStatus(input.expectedStatus);
            if (!['pending', 'processing'].includes(expectedStatus)) {
                throw new Error(
                    'ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid recovery status.'
                );
            }
            const expectedLeaseExpiresAt = nullableTimestamp(
                input.expectedLeaseExpiresAt
            );
            if (
                (expectedStatus === 'pending' && expectedLeaseExpiresAt !== null)
                || (expectedStatus === 'processing' && expectedLeaseExpiresAt === null)
            ) {
                throw new Error(
                    'ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid recovery lease.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.deferRecoveryRpc,
                {
                    p_request_id: identity.requestId,
                    p_job_key: identity.jobKey,
                    p_dispatch_generation: expectedGeneration,
                    p_dispatch_token: expectedReservationToken,
                    p_expected_status: expectedStatus,
                    p_expected_lease_expires_at: expectedLeaseExpiresAt,
                }
            );
            if (error) throwRpcError(error, 'recovery defer');
            if (typeof data !== 'boolean') {
                throw new Error(
                    'ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid recovery defer result.'
                );
            }
            return data;
        },

        async markDispatched(reservation) {
            const identity = assertAnalysisV2JobIdentity(reservation);
            const token = requiredUuid(reservation.reservationToken, 'reservation token');
            const generation = requiredSafeInteger(
                reservation.generation,
                'dispatch generation',
                1,
                1_000
            );
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.markDispatchedRpc,
                {
                    p_request_id: identity.requestId,
                    p_job_key: identity.jobKey,
                    p_dispatch_generation: generation,
                    p_dispatch_token: token,
                    p_task_name: requiredTaskName(reservation.taskName),
                }
            );
            if (error) throwRpcError(error, 'dispatch mark');
            const row = singleRpcRow(data, 'dispatch mark');
            requiredStatus(row.job_status);
            if (
                row.marked !== true
                || !['enqueued', 'delivered'].includes(
                    requiredDispatchState(row.dispatch_state)
                )
                || requiredTaskName(row.task_name) !== reservation.taskName
            ) {
                throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid dispatch mark.');
            }
        },

        async claim(
            delivery,
            leaseSeconds = ANALYSIS_V2_JOB_LEASE_SECONDS,
            maxAttempts = 7
        ) {
            const identity = assertAnalysisV2JobIdentity(delivery);
            const generation = requiredSafeInteger(
                delivery.generation,
                'dispatch generation',
                1,
                1_000
            );
            const reservationToken = requiredUuid(
                delivery.reservationToken,
                'reservation token'
            );
            if (!Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
                throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid lease duration.');
            }
            if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
                throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid max attempts.');
            }
            const claimToken = randomUUID();
            const { data, error } = await client.rpc(ANALYSIS_V2_DATABASE_NAMES.claimRpc, {
                p_request_id: identity.requestId,
                p_job_key: identity.jobKey,
                p_dispatch_generation: generation,
                p_dispatch_token: reservationToken,
                p_claim_token: claimToken,
                p_lease_seconds: leaseSeconds,
                p_max_attempts: maxAttempts,
            });
            if (error) throwRpcError(error, 'claim');
            return claimedFromRow(singleRpcRow(data, 'claim'), {
                ...identity,
                generation,
                reservationToken,
            }, claimToken);
        },

        async releaseClaim(claim, failure = {}) {
            const identity = assertAnalysisV2JobIdentity(claim);
            const errorCode = failure.errorCode ?? null;
            if (errorCode !== null && !ERROR_CODE_PATTERN.test(errorCode)) {
                throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid error code.');
            }
            const retryable = failure.retryable ?? true;
            const maxAttempts = failure.maxAttempts ?? 7;
            if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
                throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid max attempts.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.releaseClaimRpc,
                {
                    p_request_id: identity.requestId,
                    p_job_key: identity.jobKey,
                    p_claim_token: requiredUuid(claim.claimToken, 'claim token'),
                    p_error_code: errorCode,
                    p_retryable: retryable,
                    p_max_attempts: maxAttempts,
                }
            );
            if (error) throwRpcError(error, 'claim release');
            const row = singleRpcRow(data, 'claim release');
            if (typeof row.released !== 'boolean') {
                throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid claim release.');
            }
            const requestStatus = row.request_status;
            if (typeof requestStatus !== 'string' || !JOB_PART_PATTERN.test(requestStatus)) {
                throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid request status.');
            }
            return {
                released: row.released,
                status: requiredStatus(row.job_status),
                attemptCount: requiredSafeInteger(
                    row.attempt_count,
                    'attempt count',
                    1,
                    100
                ),
                requestStatus,
            };
        },

        async deferTerminalCleanup(claim) {
            const identity = assertAnalysisV2JobIdentity(claim);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.deferTerminalCleanupRpc,
                {
                    p_request_id: identity.requestId,
                    p_job_key: identity.jobKey,
                    p_claim_token: requiredUuid(claim.claimToken, 'claim token'),
                }
            );
            if (error) throwRpcError(error, 'terminal cleanup defer');
            const row = singleRpcRow(data, 'terminal cleanup defer');
            const status = requiredStatus(row.job_status);
            const attemptCount = requiredSafeInteger(
                row.attempt_count,
                'attempt count',
                1,
                100
            );
            const requestStatus = row.request_status;
            if (
                row.released !== true
                || status !== 'pending'
                || attemptCount !== claim.attemptCount
                || requestStatus !== 'processing'
            ) {
                throw new Error(
                    'ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid terminal cleanup defer.'
                );
            }
            return {
                released: true,
                status,
                attemptCount,
                requestStatus,
            };
        },

        async deferAiCapacity(claim, errorCode) {
            const identity = assertAnalysisV2JobIdentity(claim);
            if (![
                'ANALYSIS_V2_AI_CAPACITY_PENDING',
                'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
                'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
            ].includes(errorCode)) {
                throw new Error(
                    'ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid AI capacity code.'
                );
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.deferAiCapacityRpc,
                {
                    p_request_id: identity.requestId,
                    p_job_key: identity.jobKey,
                    p_claim_token: requiredUuid(claim.claimToken, 'claim token'),
                    p_error_code: errorCode,
                }
            );
            if (error) throwRpcError(error, 'AI capacity defer');
            const row = singleRpcRow(data, 'AI capacity defer');
            const status = requiredStatus(row.job_status);
            const attemptCount = requiredSafeInteger(
                row.attempt_count,
                'attempt count',
                0,
                100
            );
            const requestStatus = row.request_status;
            const deferralCount = requiredSafeInteger(
                row.ai_capacity_deferral_count,
                'AI capacity deferral count',
                1,
                100_000
            );
            if (
                row.released !== true
                || status !== 'pending'
                || attemptCount !== claim.attemptCount - 1
                || typeof requestStatus !== 'string'
                || !JOB_PART_PATTERN.test(requestStatus)
                || deferralCount < 1
            ) {
                throw new Error(
                    'ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid AI capacity defer.'
                );
            }
            return {
                released: true,
                status,
                attemptCount,
                requestStatus,
            };
        },

        async completeAndFanout(claim, successors) {
            const identity = assertAnalysisV2JobIdentity(claim);
            if (successors.length > 100) {
                throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: too many successors.');
            }
            const normalizedSuccessors = successors.map(validateSuccessor);
            const keys = normalizedSuccessors.map(successor => successor.jobKey);
            if (new Set(keys).size !== keys.length) {
                throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: duplicate successor.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.completeAndFanoutRpc,
                {
                    p_request_id: identity.requestId,
                    p_job_key: identity.jobKey,
                    p_claim_token: requiredUuid(claim.claimToken, 'claim token'),
                    p_successors: normalizedSuccessors,
                }
            );
            if (error) throwRpcError(error, 'complete and fanout');
            const row = singleRpcRow(data, 'complete and fanout');
            const requestId = requiredUuid(row.request_id, 'request id');
            if (requestId !== identity.requestId || typeof row.completed !== 'boolean') {
                throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid completion.');
            }
            if (requiredStatus(row.job_status) !== 'completed') {
                throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid completion status.');
            }
            if (!Array.isArray(row.dispatchable_job_keys)) {
                throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: invalid fanout keys.');
            }
            const dispatchableJobKeys = row.dispatchable_job_keys.map(requiredJobKey);
            if (new Set(dispatchableJobKeys).size !== dispatchableJobKeys.length) {
                throw new Error('ANALYSIS_V2_JOB_PERSISTENCE_ERROR: duplicate fanout keys.');
            }
            return dispatchableJobKeys.map(dispatchableJobKey => ({
                requestId,
                jobKey: dispatchableJobKey,
            }));
        },

        async listDispatchable(input = {}) {
            const limit = input.limit ?? 100;
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
                throw new Error('ANALYSIS_V2_JOB_VALIDATION_ERROR: invalid recovery limit.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_DATABASE_NAMES.listDispatchableRpc,
                {
                    p_limit: limit,
                }
            );
            if (error) throwRpcError(error, 'dispatchable list');
            return rpcRows(data, 'dispatchable list').map(dispatchableFromRow);
        },
    };
}

export const analysisV2JobStore = createSupabaseAnalysisV2JobStore(
    supabaseAdmin as unknown as AnalysisV2JobSupabaseClient
);
