import 'server-only';

import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { withCanonicalMirrorTimeout } from '@/lib/services/operations/canonical-operations-store';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_DOMAIN = 'analysis-canonical:v1\0';

/** Retained execution is intentionally limited to the durable job/event pair. */
export type AnalysisCanonicalWriteFamily = 'jobs' | 'events';

export const ANALYSIS_CANONICAL_WRITE_FLAGS: Readonly<
    Record<AnalysisCanonicalWriteFamily, 'ANALYSIS_CANONICAL_JOBS_WRITE' | 'ANALYSIS_CANONICAL_EVENTS_WRITE'>
> = Object.freeze({
    jobs: 'ANALYSIS_CANONICAL_JOBS_WRITE',
    events: 'ANALYSIS_CANONICAL_EVENTS_WRITE',
});

export type AnalysisCanonicalWriteStatus =
    | 'disabled'
    | 'appended'
    | 'retry_queued'
    | 'blocked';

export type AnalysisCanonicalWriteResult =
    | Readonly<{ status: 'disabled' }>
    | Readonly<{ status: 'appended' }>
    | Readonly<{ status: 'retry_queued'; family: AnalysisCanonicalWriteFamily }>
    | Readonly<{ status: 'blocked'; family: AnalysisCanonicalWriteFamily }>;

export type AnalysisCanonicalPayload = Record<string, unknown>;

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisCanonicalSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export type AnalysisCanonicalJobKind =
    | 'coordinator'
    | 'collection'
    | 'ai'
    | 'finalize'
    | 'recovery';

export type AnalysisCanonicalJobState =
    | 'queued'
    | 'leased'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'blocked';

export interface RecordAnalysisCanonicalJobInput {
    requestId: string;
    jobKey: string;
    kind: AnalysisCanonicalJobKind;
    state: AnalysisCanonicalJobState;
    generation?: number;
    attemptCount?: number;
    dependencyCount?: number;
    nextAttemptAt?: Date | string;
    leaseExpiresAt?: Date | string | null;
    completionHash?: string | null;
    payload?: AnalysisCanonicalPayload;
    retentionClass?: string;
}

export interface AppendAnalysisCanonicalEventInput {
    requestId: string;
    jobId?: string | null;
    kind: 'progress' | 'lifecycle' | 'operational';
    state: string;
    payload?: AnalysisCanonicalPayload;
    contentHash?: string;
    retentionClass?: string;
}

export interface AnalysisCanonicalStore {
    recordJob(input: RecordAnalysisCanonicalJobInput): Promise<AnalysisCanonicalWriteResult>;
    appendEvent(input: AppendAnalysisCanonicalEventInput): Promise<AnalysisCanonicalWriteResult>;
    enqueueRetry(
        requestId: string,
        family: AnalysisCanonicalWriteFamily,
    ): Promise<Readonly<{
        status: 'retry_queued' | 'blocked';
        family: AnalysisCanonicalWriteFamily;
    }>>;
}

const FORBIDDEN_PAYLOAD_KEYS = new Set([
    'providerToken',
    'provider_token',
    'accessToken',
    'access_token',
    'cookie',
    'cookies',
    'rawProviderPayload',
    'raw_provider_payload',
    'authorization',
    'secret',
    'raw',
    'rawSource',
    'raw_source',
    'sourceSensitive',
    'source_sensitive',
    'synthetic',
    'placeholder',
    'partialEvidence',
    'partial_evidence',
    'targetUsername',
    'target_username',
]);

/**
 * These are execution payload keys only. The former evidence/cost/cache/audit
 * payload branches deliberately do not have a compatibility entry here: a
 * retained jobs/events writer must not be able to smuggle a retired family
 * back into the shared validator.
 */
const CANONICAL_PAYLOAD_KEYS: Readonly<Record<AnalysisCanonicalWriteFamily, readonly string[]>> = {
    jobs: [
        'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey', 'generation',
        'attemptCount', 'dependencyCount', 'completionHash', 'requestStatus', 'state', 'counts',
    ],
    events: [
        'schemaVersion', 'jobKey', 'generation', 'successorCount', 'eventCode', 'copyCode',
        'aggregateCount', 'tracks', 'kind', 'state', 'progress', 'result', 'counts',
    ],
};

const CANONICAL_NESTED_PAYLOAD_KEYS = new Set([
    'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey', 'generation',
    'attemptCount', 'dependencyCount', 'completionHash', 'requestStatus', 'state', 'counts',
    'eventCode', 'copyCode', 'aggregateCount', 'tracks', 'kind', 'progress', 'result',
    'relationshipAi', 'interactions', 'finalization', 'stageCode', 'done', 'total',
    'completed', 'lowSeconds', 'highSeconds', 'retryKey', 'family', 'rank', 'score',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isBoundedString(value: unknown, max = 512): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function assertUuid(value: string, label: string): void {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid ${label}.`);
    }
}

function assertHash(value: string, label: string): void {
    if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid ${label}.`);
    }
}

function isCanonicalTimestamp(value: unknown): value is string {
    return typeof value === 'string'
        && value.length <= 128
        && CANONICAL_TIMESTAMP_PATTERN.test(value)
        && Number.isFinite(Date.parse(value))
        && new Date(value).toISOString() === value;
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value instanceof Date) return value.toISOString();
    if (isRecord(value)) {
        return Object.fromEntries(
            Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
        );
    }
    if (typeof value === 'bigint') return value.toString();
    return value;
}

export function stableAnalysisCanonicalJson(value: unknown): string {
    const stable = JSON.stringify(stableValue(value));
    if (stable === undefined) {
        throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: value is not serializable.');
    }
    return stable;
}

export function hashAnalysisCanonicalValue(value: unknown): string {
    return createHash('sha256')
        .update(SHA256_DOMAIN, 'utf8')
        .update(stableAnalysisCanonicalJson(value), 'utf8')
        .digest('hex');
}

function assertPayload(
    value: AnalysisCanonicalPayload | undefined,
    path: string,
    allowedKeys: readonly string[],
): AnalysisCanonicalPayload {
    const payload = value ?? {};
    if (!isRecord(payload)) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: ${path} must be an object.`);
    }
    const visit = (candidate: unknown, location: string, depth: number, root: boolean): void => {
        if (depth > 8) {
            throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: payload nesting is too deep.');
        }
        if (Array.isArray(candidate)) {
            if (candidate.length > 100) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: payload array is too large.');
            }
            candidate.forEach((item, index) => visit(item, `${location}[${index}]`, depth + 1, false));
            return;
        }
        if (candidate === null || typeof candidate === 'boolean') return;
        if (typeof candidate === 'string') {
            if (candidate.length > 8_192) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: payload string is too large.');
            }
            return;
        }
        if (typeof candidate === 'number') {
            if (!Number.isFinite(candidate)) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: payload number is not finite.');
            }
            return;
        }
        if (!isRecord(candidate) || Object.keys(candidate).length > 64) {
            throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: payload contains an unsupported value.');
        }
        for (const [key, child] of Object.entries(candidate)) {
            if (FORBIDDEN_PAYLOAD_KEYS.has(key) || FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
                throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: forbidden payload key ${key}.`);
            }
            if (root && !allowedKeys.includes(key)) {
                throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: unknown payload key ${key}.`);
            }
            if (!root && !CANONICAL_NESTED_PAYLOAD_KEYS.has(key)) {
                throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: unknown nested payload key ${key}.`);
            }
            if (key === 'schemaVersion' && child !== 1) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: unsupported payload schema version.');
            }
            visit(child, `${location}.${key}`, depth + 1, false);
        }
    };
    visit(payload, path, 0, true);
    if (Buffer.byteLength(stableAnalysisCanonicalJson(payload), 'utf8') > 32_768) {
        throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: payload is too large.');
    }
    return Object.freeze({ schemaVersion: 1, ...payload });
}

function asRpcDate(value: Date | string | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid date.');
        }
        return value.toISOString();
    }
    if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
        throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid date.');
    }
    return value;
}

function flagEnabled(value: string | undefined): boolean {
    return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes'
        || value?.toLowerCase() === 'on';
}

export function analysisCanonicalWriteEnabled(
    family: AnalysisCanonicalWriteFamily,
    env: Record<string, string | undefined> = process.env,
): boolean {
    return flagEnabled(env[ANALYSIS_CANONICAL_WRITE_FLAGS[family]]);
}

function ensureInteger(value: number | undefined, label: string, min: number, max: number): number {
    const resolved = value ?? 0;
    if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max) {
        throw new Error(`ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid ${label}.`);
    }
    return resolved;
}

function errorMessage(error: RpcError | null): string {
    return error?.message || error?.code || 'canonical RPC failed';
}

interface AnalysisCanonicalRetryMarker {
    id: number;
    request_id: string;
    kind: 'operational';
    state: 'canonical_retry';
    payload: {
        family: AnalysisCanonicalWriteFamily;
        retryKey: string;
    };
    content_hash: string;
    retention_class: 'standard';
    created_at: string;
}

function expectedRetryMarkerHash(requestId: string, family: AnalysisCanonicalWriteFamily): string {
    return createHash('sha256').update(`${requestId}:${family}`, 'utf8').digest('hex');
}

function parseRetryMarker(
    value: unknown,
    requestId: string,
    family: AnalysisCanonicalWriteFamily,
): AnalysisCanonicalRetryMarker {
    if (!isRecord(value)) throw new Error('invalid retry marker');
    const payload = value.payload;
    if (
        Object.keys(value).sort().join(',') !== 'content_hash,created_at,id,kind,payload,request_id,retention_class,state'
        || typeof value.id !== 'number'
        || !Number.isSafeInteger(value.id)
        || value.id < 1
        || value.request_id !== requestId
        || value.kind !== 'operational'
        || value.state !== 'canonical_retry'
        || !isRecord(payload)
        || Object.keys(payload).sort().join(',') !== 'family,retryKey'
        || payload.family !== family
        || payload.retryKey !== `${requestId}:${family}`
        || value.content_hash !== expectedRetryMarkerHash(requestId, family)
        || value.retention_class !== 'standard'
        || !isCanonicalTimestamp(value.created_at)
    ) {
        throw new Error('invalid retry marker');
    }
    return {
        id: value.id,
        request_id: value.request_id,
        kind: 'operational',
        state: 'canonical_retry',
        payload: { family, retryKey: `${requestId}:${family}` },
        content_hash: value.content_hash,
        retention_class: 'standard',
        created_at: value.created_at,
    };
}

export function createAnalysisCanonicalStore(
    client: AnalysisCanonicalSupabaseClient = supabaseAdmin,
    options: { env?: Record<string, string | undefined> } = {},
): AnalysisCanonicalStore {
    const env = options.env ?? process.env;
    const boundedRpc = (name: string, params: Record<string, unknown>): Promise<RpcResult> => (
        withCanonicalMirrorTimeout(() => client.rpc(name, params))
    );

    async function enqueueRetry(
        requestId: string,
        family: AnalysisCanonicalWriteFamily,
    ): Promise<Readonly<{
        status: 'retry_queued' | 'blocked';
        family: AnalysisCanonicalWriteFamily;
    }>> {
        assertUuid(requestId, 'request id');
        try {
            const result = await boundedRpc('enqueue_analysis_execution_retry_v1', {
                p_request_id: requestId,
                p_family: family,
            });
            if (result.error) return { status: 'blocked', family };
            parseRetryMarker(result.data, requestId, family);
            return { status: 'retry_queued', family };
        } catch {
            return { status: 'blocked', family };
        }
    }

    async function write(
        family: AnalysisCanonicalWriteFamily,
        requestId: string,
        rpcName: string,
        params: Record<string, unknown>,
    ): Promise<AnalysisCanonicalWriteResult> {
        if (!analysisCanonicalWriteEnabled(family, env)) return { status: 'disabled' };
        assertUuid(requestId, 'request id');
        try {
            const result = await boundedRpc(rpcName, params);
            if (result.error) throw new Error(errorMessage(result.error));
            return { status: 'appended' };
        } catch {
            return enqueueRetry(requestId, family);
        }
    }

    return Object.freeze({
        async recordJob(input: RecordAnalysisCanonicalJobInput) {
            assertUuid(input.requestId, 'request id');
            if (!JOB_KEY_PATTERN.test(input.jobKey)) {
                throw new Error('ANALYSIS_CANONICAL_VALIDATION_ERROR: invalid job key.');
            }
            const payload = assertPayload(input.payload, 'payload', CANONICAL_PAYLOAD_KEYS.jobs);
            const generation = ensureInteger(input.generation, 'generation', 0, 9_000_000_000);
            const attemptCount = ensureInteger(input.attemptCount, 'attempt count', 0, 1_000);
            const dependencyCount = ensureInteger(input.dependencyCount, 'dependency count', 0, 9_000_000_000);
            if (input.completionHash !== undefined && input.completionHash !== null) {
                assertHash(input.completionHash, 'completion hash');
            }
            return write('jobs', input.requestId, 'record_analysis_canonical_job', {
                p_request_id: input.requestId,
                p_job_key: input.jobKey,
                p_kind: input.kind,
                p_state: input.state,
                p_generation: generation,
                p_attempt_count: attemptCount,
                p_dependency_count: dependencyCount,
                p_next_attempt_at: asRpcDate(input.nextAttemptAt) ?? new Date().toISOString(),
                p_lease_expires_at: asRpcDate(input.leaseExpiresAt),
                p_completion_hash: input.completionHash ?? null,
                p_payload: payload,
                p_retention_class: input.retentionClass ?? 'standard',
            });
        },

        async appendEvent(input: AppendAnalysisCanonicalEventInput) {
            assertUuid(input.requestId, 'request id');
            if (input.jobId !== undefined && input.jobId !== null) assertUuid(input.jobId, 'job id');
            const payload = assertPayload(input.payload, 'payload', CANONICAL_PAYLOAD_KEYS.events);
            const contentHash = input.contentHash ?? hashAnalysisCanonicalValue({
                requestId: input.requestId,
                jobId: input.jobId ?? null,
                kind: input.kind,
                state: input.state,
                payload,
            });
            assertHash(contentHash, 'content hash');
            return write('events', input.requestId, 'append_analysis_canonical_event', {
                p_request_id: input.requestId,
                p_job_id: input.jobId ?? null,
                p_kind: input.kind,
                p_state: input.state,
                p_payload: payload,
                p_content_hash: contentHash,
                p_retention_class: input.retentionClass ?? 'standard',
            });
        },

        enqueueRetry,
    });
}

export const analysisCanonicalStore = createAnalysisCanonicalStore();
