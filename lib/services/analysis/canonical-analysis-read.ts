import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import { withCanonicalMirrorTimeout } from '@/lib/services/operations/canonical-operations-store';
import {
    type AnalysisCanonicalSupabaseClient,
} from './canonical-analysis-store';

/** Read access mirrors only retained execution state. */
export type AnalysisCanonicalReadFamily = 'jobs' | 'events';

export const ANALYSIS_CANONICAL_READ_FLAGS: Readonly<
    Record<AnalysisCanonicalReadFamily, 'ANALYSIS_CANONICAL_JOBS_READ' | 'ANALYSIS_CANONICAL_EVENTS_READ'>
> = Object.freeze({
    jobs: 'ANALYSIS_CANONICAL_JOBS_READ',
    events: 'ANALYSIS_CANONICAL_EVENTS_READ',
});

/** Hard bound for every collection returned by the service-only family RPC. */
export const CANONICAL_READ_MAX_ROWS = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const ANALYSIS_CANONICAL_SCHEMA_VERSION = 1 as const;

export type AnalysisParityStatus = 'match' | 'mismatch' | 'blocked';

export interface AnalysisParitySummary {
    status: AnalysisParityStatus;
    mismatchPaths: string[];
}

export interface AnalysisParityAggregate {
    count: number;
    checksum: string | null;
    complete: boolean;
    ownership?: unknown;
    state?: unknown;
    counts?: unknown;
    orderHash?: unknown;
    contentHash?: unknown;
}

const SANITIZED_PARITY_PATHS = new Set([
    'count', 'checksum', 'complete', 'ownership', 'state', 'counts',
    'orderHash', 'contentHash', 'request.status', 'progress', 'result',
    'source.missing', 'canonical.missing', 'canonical.error',
    'comparison.missing', 'comparison.error', 'comparison.required',
    'request.id', 'source.incomplete', 'canonical.incomplete',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stableCompareValue(value: unknown): string {
    const normalize = (candidate: unknown): unknown => {
        if (candidate === undefined) return '__undefined__';
        if (candidate === null) return null;
        if (Array.isArray(candidate)) return candidate.map(normalize);
        if (typeof candidate === 'object') {
            return Object.fromEntries(
                Object.entries(candidate as Record<string, unknown>)
                    .sort(([left], [right]) => left.localeCompare(right))
                    .map(([key, child]) => [key, normalize(child)]),
            );
        }
        return candidate;
    };
    return JSON.stringify(normalize(value));
}

export function analysisCanonicalReadEnabled(
    family: AnalysisCanonicalReadFamily,
    env: Record<string, string | undefined> = process.env,
): boolean {
    const value = env[ANALYSIS_CANONICAL_READ_FLAGS[family]];
    return value === '1' || value?.toLowerCase() === 'true' || value?.toLowerCase() === 'yes'
        || value?.toLowerCase() === 'on';
}

export function buildAnalysisParity(input: {
    source: AnalysisParityAggregate | null;
    canonical: AnalysisParityAggregate | null;
}): AnalysisParitySummary {
    if (!input.source) return { status: 'blocked', mismatchPaths: ['source.missing'] };
    if (!input.canonical) return { status: 'blocked', mismatchPaths: ['canonical.missing'] };
    const mismatchPaths: string[] = [];
    const compare = (path: string, left: unknown, right: unknown): void => {
        if (stableCompareValue(left) !== stableCompareValue(right)) mismatchPaths.push(path);
    };
    compare('count', input.source.count, input.canonical.count);
    compare('checksum', input.source.checksum, input.canonical.checksum);
    compare('complete', input.source.complete, input.canonical.complete);
    for (const [field, path] of [
        ['ownership', 'ownership'],
        ['state', 'state'],
        ['counts', 'counts'],
        ['orderHash', 'orderHash'],
        ['contentHash', 'contentHash'],
    ] as const) {
        compare(path, input.source[field] ?? null, input.canonical[field] ?? null);
    }
    return {
        status: mismatchPaths.length > 0 ? 'mismatch' : 'match',
        mismatchPaths,
    };
}

export interface AnalysisCanonicalReadBundle {
    jobs: readonly unknown[];
    events: readonly unknown[];
}

interface CanonicalReadRpcResult {
    data: unknown;
    error: { code?: string; message?: string } | null;
}

export interface AnalysisCanonicalReadStore {
    loadRequest(requestId: string, family: AnalysisCanonicalReadFamily): Promise<AnalysisCanonicalReadBundle | null>;
    shadowRead<T>(input: {
        family: AnalysisCanonicalReadFamily;
        legacy: () => Promise<T>;
        canonical: () => Promise<T>;
        compare: (legacy: T, canonical: T) => AnalysisParitySummary;
        onMismatch?: (summary: AnalysisParitySummary) => void;
    }): Promise<T>;
}

const REQUIRED_CANONICAL_ROW_FIELDS: Readonly<Record<keyof AnalysisCanonicalReadBundle, readonly string[]>> = {
    jobs: [
        'id', 'request_id', 'job_key', 'kind', 'state', 'generation', 'attempt_count',
        'dependency_count', 'next_attempt_at', 'lease_expires_at', 'completion_hash',
        'payload', 'retention_class', 'created_at', 'updated_at',
    ],
    events: [
        'id', 'request_id', 'job_id', 'kind', 'state', 'payload', 'content_hash',
        'retention_class', 'created_at',
    ],
};

const CANONICAL_PAYLOAD_KEYS: Readonly<Record<keyof AnalysisCanonicalReadBundle, readonly string[]>> = {
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
    'completed', 'lowSeconds', 'highSeconds', 'retryKey', 'family',
]);

const PROJECTION_FORBIDDEN_KEYS = new Set([
    'rawProviderPayload', 'raw_provider_payload', 'providerToken', 'provider_token',
    'accessToken', 'access_token', 'cookie', 'cookies', 'authorization', 'secret',
    'synthetic', 'placeholder', 'partialEvidence', 'partial_evidence',
    'targetUsername', 'target_username', 'sourceSensitive', 'source_sensitive',
]);

function isBoundedString(value: unknown, max = 512): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isNullableUuid(value: unknown): boolean {
    return value === null || (typeof value === 'string' && UUID_PATTERN.test(value));
}

function isNullableHash(value: unknown): boolean {
    return value === null || (typeof value === 'string' && HASH_PATTERN.test(value));
}

function isTimestamp(value: unknown): value is string {
    return typeof value === 'string'
        && TIMESTAMP_PATTERN.test(value)
        && Number.isFinite(Date.parse(value));
}

function isNullableTimestamp(value: unknown): boolean {
    return value === null || isTimestamp(value);
}

function isSafeJsonPayload(value: unknown, depth = 0, root = false): boolean {
    if (depth > 8) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 8_192;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 100 && value.every(item => isSafeJsonPayload(item, depth + 1));
    if (!isRecord(value) || Object.keys(value).length > 64) return false;
    return Object.entries(value).every(([key, child]) => (
        !PROJECTION_FORBIDDEN_KEYS.has(key)
        && !PROJECTION_FORBIDDEN_KEYS.has(key.toLowerCase())
        && (root || CANONICAL_NESTED_PAYLOAD_KEYS.has(key))
        && (key !== 'schemaVersion' || child === ANALYSIS_CANONICAL_SCHEMA_VERSION)
        && isSafeJsonPayload(child, depth + 1)
    ));
}

function isRetryPayload(value: unknown, row?: Record<string, unknown>): boolean {
    if (!isRecord(value) || Object.keys(value).length !== 2) return false;
    if (value.family !== 'jobs' && value.family !== 'events') return false;
    return isBoundedString(value.retryKey, 256)
        && typeof row?.request_id === 'string'
        && value.retryKey === `${row.request_id}:${value.family}`;
}

function isCanonicalJsonPayload(
    value: unknown,
    key: keyof AnalysisCanonicalReadBundle,
    row?: Record<string, unknown>,
): value is Record<string, unknown> {
    if (!isRecord(value) || !isSafeJsonPayload(value, 0, true)) return false;
    if (
        key === 'events'
        && row?.kind === 'operational'
        && row.state === 'canonical_retry'
        && isRetryPayload(value, row)
    ) return true;
    return value.schemaVersion === ANALYSIS_CANONICAL_SCHEMA_VERSION
        && Object.keys(value).length > 0
        && Object.keys(value).every(payloadKey => CANONICAL_PAYLOAD_KEYS[key].includes(payloadKey));
}

function isCanonicalRowShape(key: keyof AnalysisCanonicalReadBundle, value: unknown): boolean {
    if (!isRecord(value)) return false;
    const fields = REQUIRED_CANONICAL_ROW_FIELDS[key];
    if (fields.some(field => !Object.prototype.hasOwnProperty.call(value, field))) return false;
    if (Object.keys(value).some(field => !fields.includes(field))) return false;
    if (!isCanonicalJsonPayload(value.payload, key, value)) return false;
    if (typeof value.request_id !== 'string' || !UUID_PATTERN.test(value.request_id)) return false;
    if (!isBoundedString(value.retention_class, 64)) return false;
    if (key === 'jobs') {
        return UUID_PATTERN.test(String(value.id))
            && isBoundedString(value.job_key, 160)
            && ['coordinator', 'collection', 'ai', 'finalize', 'recovery'].includes(String(value.kind))
            && ['queued', 'leased', 'running', 'succeeded', 'failed', 'blocked'].includes(String(value.state))
            && Number.isSafeInteger(value.generation)
            && (value.generation as number) >= 0
            && Number.isSafeInteger(value.attempt_count)
            && (value.attempt_count as number) >= 0
            && (value.attempt_count as number) <= 1_000
            && Number.isSafeInteger(value.dependency_count)
            && (value.dependency_count as number) >= 0
            && isTimestamp(value.next_attempt_at)
            && isNullableTimestamp(value.lease_expires_at)
            && isNullableHash(value.completion_hash)
            && isTimestamp(value.created_at)
            && isTimestamp(value.updated_at);
    }
    return Number.isSafeInteger(value.id)
        && isNullableUuid(value.job_id)
        && ['progress', 'lifecycle', 'operational'].includes(String(value.kind))
        && isBoundedString(value.state, 64)
        && HASH_PATTERN.test(String(value.content_hash))
        && (value.state !== 'canonical_retry' || value.kind === 'operational')
        && (value.state !== 'canonical_retry' || CANONICAL_TIMESTAMP_PATTERN.test(String(value.created_at)))
        && isTimestamp(value.created_at);
}

function asRows(
    value: unknown,
    key: keyof AnalysisCanonicalReadBundle,
    requestId?: string,
): readonly unknown[] {
    if (!isRecord(value)) {
        throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid canonical response.');
    }
    const rows = value[key];
    if (!Array.isArray(rows)) {
        throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: invalid canonical ${key} collection.`);
    }
    if (rows.length > CANONICAL_READ_MAX_ROWS) {
        throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: oversized canonical ${key} collection.`);
    }
    for (const row of rows) {
        if (!isCanonicalRowShape(key, row)
            || (requestId && isRecord(row) && row.request_id !== requestId)) {
            throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: invalid or missing required canonical ${key} field.`);
        }
    }
    return Object.freeze([...rows]);
}

function sanitizeParitySummary(value: unknown): AnalysisParitySummary {
    if (!isRecord(value)) throw new Error('invalid comparison result');
    if (
        (value.status !== 'match' && value.status !== 'mismatch' && value.status !== 'blocked')
        || !Array.isArray(value.mismatchPaths)
        || value.mismatchPaths.length > 32
        || value.mismatchPaths.some(path => typeof path !== 'string' || !SANITIZED_PARITY_PATHS.has(path))
        || (value.status === 'match' && value.mismatchPaths.length > 0)
    ) throw new Error('invalid comparison result');
    return { status: value.status, mismatchPaths: [...value.mismatchPaths] as string[] };
}

function parseBundle(value: unknown, requestId?: string): AnalysisCanonicalReadBundle {
    if (!isRecord(value)) throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid canonical response.');
    const unknownKeys = Object.keys(value).filter(key => key !== 'jobs' && key !== 'events');
    if (unknownKeys.length > 0) throw new Error('ANALYSIS_CANONICAL_READ_ERROR: unknown canonical collection.');
    return {
        jobs: asRows(value, 'jobs', requestId),
        events: asRows(value, 'events', requestId),
    };
}

export function createAnalysisCanonicalReadStore(
    client: AnalysisCanonicalSupabaseClient = supabaseAdmin,
    options: {
        env?: Record<string, string | undefined>;
        onMismatch?: (input: {
            family: AnalysisCanonicalReadFamily;
            summary: AnalysisParitySummary;
        }) => void;
    } = {},
): AnalysisCanonicalReadStore {
    const env = options.env ?? process.env;
    const reportMismatch = (
        family: AnalysisCanonicalReadFamily,
        summary: AnalysisParitySummary,
        callback?: (summary: AnalysisParitySummary) => void,
    ): void => {
        try { callback?.(summary); } catch { /* diagnostics are fail-open */ }
        try { options.onMismatch?.({ family, summary }); } catch { /* diagnostics are fail-open */ }
    };

    return {
        async loadRequest(requestId, family) {
            if (!UUID_PATTERN.test(requestId)) {
                throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid request id.');
            }
            if (!analysisCanonicalReadEnabled(family, env)) return null;
            const result = await withCanonicalMirrorTimeout(() => client.rpc('load_analysis_execution_family_v1', {
                p_request_id: requestId,
                p_family: family,
            })) as CanonicalReadRpcResult;
            if (result.error) throw new Error(result.error.message || result.error.code || 'canonical read failed');
            return parseBundle(result.data, requestId);
        },

        async shadowRead<T>(input: {
            family: AnalysisCanonicalReadFamily;
            legacy: () => Promise<T>;
            canonical: () => Promise<T>;
            compare: (legacy: T, canonical: T) => AnalysisParitySummary;
            onMismatch?: (summary: AnalysisParitySummary) => void;
        }) {
            const legacy = await input.legacy();
            if (!analysisCanonicalReadEnabled(input.family, env)) return legacy;
            let canonical: T;
            try {
                canonical = await withCanonicalMirrorTimeout(input.canonical);
            } catch {
                reportMismatch(input.family, { status: 'blocked', mismatchPaths: ['canonical.error'] }, input.onMismatch);
                return legacy;
            }
            if (typeof input.compare !== 'function') {
                const summary = { status: 'blocked', mismatchPaths: ['comparison.missing'] } satisfies AnalysisParitySummary;
                reportMismatch(input.family, summary, input.onMismatch);
                return legacy;
            }
            let summary: AnalysisParitySummary;
            try {
                summary = sanitizeParitySummary(input.compare(legacy, canonical));
            } catch {
                summary = { status: 'blocked', mismatchPaths: ['comparison.error'] };
            }
            if (summary.status !== 'match') {
                reportMismatch(input.family, summary, input.onMismatch);
                return legacy;
            }
            return canonical;
        },
    };
}

export const analysisCanonicalReadStore = createAnalysisCanonicalReadStore();
