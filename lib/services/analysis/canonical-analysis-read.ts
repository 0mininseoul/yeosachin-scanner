import 'server-only';

import { supabaseAdmin } from '@/lib/supabase/admin';
import {
    type AnalysisCanonicalSupabaseClient,
} from './canonical-analysis-store';

export type AnalysisCanonicalReadFamily = 'jobs' | 'evidence' | 'cost' | 'cache' | 'audit';

export const ANALYSIS_CANONICAL_READ_FLAGS: Readonly<
    Record<AnalysisCanonicalReadFamily, 'ANALYSIS_CANONICAL_JOBS_READ'
        | 'ANALYSIS_CANONICAL_EVIDENCE_READ'
        | 'ANALYSIS_CANONICAL_COST_READ'
        | 'ANALYSIS_CANONICAL_CACHE_READ'
        | 'ANALYSIS_CANONICAL_AUDIT_READ'>
> = Object.freeze({
    jobs: 'ANALYSIS_CANONICAL_JOBS_READ',
    evidence: 'ANALYSIS_CANONICAL_EVIDENCE_READ',
    cost: 'ANALYSIS_CANONICAL_COST_READ',
    cache: 'ANALYSIS_CANONICAL_CACHE_READ',
    audit: 'ANALYSIS_CANONICAL_AUDIT_READ',
});

/** Hard bound for every collection returned by the service-only family RPC. */
export const CANONICAL_READ_MAX_ROWS = 100;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

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
    cost?: unknown;
    retention?: unknown;
    unknownSource?: unknown;
    [key: string]: unknown;
}

const SANITIZED_PARITY_PATHS = new Set([
    'count',
    'checksum',
    'complete',
    'ownership',
    'state',
    'counts',
    'orderHash',
    'contentHash',
    'cost',
    'retention',
    'unknownSource',
    'candidate',
    'interaction',
    'order',
    'familyRows',
    'request.status',
    'progress',
    'result',
    'provider.operation',
    'audit.retention',
    'source.missing',
    'canonical.missing',
    'canonical.error',
    'comparison.missing',
    'comparison.error',
    'comparison.required',
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

export function nextAnalysisCanonicalAuditVersion(
    existingVersions: readonly number[],
    lateCost = false,
): number {
    const maxVersion = existingVersions.reduce((max, version) => (
        Number.isSafeInteger(version) && version > max ? version : max
    ), 0);
    // A late provider usage observation is a new immutable bundle version, never an update
    // to the prior cost/audit row. The same monotonic rule is safe for ordinary replays.
    const next = maxVersion + 1;
    if (next > 100_000) {
        throw new Error('ANALYSIS_CANONICAL_AUDIT_VERSION_EXHAUSTED');
    }
    if (lateCost) return next;
    return next;
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
        ['cost', 'cost'],
        ['retention', 'retention'],
        ['unknownSource', 'unknownSource'],
    ] as const) {
        const sourceValue = input.source[field];
        const canonicalValue = input.canonical[field];
        compare(path, sourceValue ?? null, canonicalValue ?? null);
    }
    return {
        status: mismatchPaths.length > 0 ? 'mismatch' : 'match',
        mismatchPaths,
    };
}

export interface AnalysisCanonicalNormalizedProjection {
    requestStatus: string | null;
    ownership: unknown;
    state: unknown;
    counts: unknown;
    candidate: readonly unknown[];
    interaction: readonly unknown[];
    order: readonly unknown[];
    orderHash: string | null;
    contentHash: string | null;
    progress: Readonly<{
        state: string;
        completed: number;
        total: number;
    }> | null;
    result: Readonly<{
        rank: number | null;
        score: number | null;
    }> | null;
    providerOperation: string | null;
    cost: Readonly<{
        amountKnown: number | null;
        amountConservative: number | null;
        usageUnknown: boolean;
        sourceHash: string | null;
    }>;
    retention: string | null;
    auditRetention: string | null;
    unknownSource: boolean;
    familyRows: Readonly<{
        jobs: readonly unknown[];
        events: readonly unknown[];
        artifacts: readonly unknown[];
        costs: readonly unknown[];
        caches: readonly unknown[];
        audits: readonly unknown[];
    }>;
}

const PROJECTION_REQUIRED_FIELDS = [
    'requestStatus',
    'ownership',
    'state',
    'counts',
    'candidate',
    'interaction',
    'order',
    'orderHash',
    'contentHash',
    'progress',
    'result',
    'providerOperation',
    'cost',
    'retention',
    'auditRetention',
    'unknownSource',
    'familyRows',
] as const;

const FAMILY_ROW_KEYS = ['jobs', 'events', 'artifacts', 'costs', 'caches', 'audits'] as const;

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).every(key => keys.includes(key));
}

function isFiniteNullableNumber(value: unknown): value is number | null {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isProjectionRows(value: unknown): value is readonly unknown[] {
    return Array.isArray(value) && value.every(row => isRecord(row) && Object.keys(row).length > 0);
}

function isProjection(value: unknown): value is AnalysisCanonicalNormalizedProjection {
    if (!isRecord(value)) return false;
    if (PROJECTION_REQUIRED_FIELDS.some(field => !Object.prototype.hasOwnProperty.call(value, field))) {
        return false;
    }
    if (!hasOnlyKeys(value, PROJECTION_REQUIRED_FIELDS)) return false;
    const cost = value.cost;
    const familyRows = value.familyRows;
    const progress = value.progress;
    const result = value.result;
    return (
        (value.requestStatus === null || typeof value.requestStatus === 'string')
        && typeof value.state === 'string'
        && value.ownership !== undefined
        && isRecord(value.counts)
        && isProjectionRows(value.candidate)
        && isProjectionRows(value.interaction)
        && isProjectionRows(value.order)
        && (value.orderHash === null || (typeof value.orderHash === 'string' && HASH_PATTERN.test(value.orderHash)))
        && (value.contentHash === null || (typeof value.contentHash === 'string' && HASH_PATTERN.test(value.contentHash)))
        && (value.providerOperation === null || typeof value.providerOperation === 'string')
        && (value.retention === null || typeof value.retention === 'string')
        && (value.auditRetention === null || typeof value.auditRetention === 'string')
        && typeof value.unknownSource === 'boolean'
        && (progress === null || (
            isRecord(progress)
            && hasOnlyKeys(progress, ['state', 'completed', 'total'])
            && typeof progress.state === 'string'
            && typeof progress.completed === 'number'
            && Number.isSafeInteger(progress.completed)
            && progress.completed >= 0
            && typeof progress.total === 'number'
            && Number.isSafeInteger(progress.total)
            && progress.total >= 0
        ))
        && (result === null || (
            isRecord(result)
            && hasOnlyKeys(result, ['rank', 'score'])
            && isFiniteNullableNumber(result.rank)
            && isFiniteNullableNumber(result.score)
        ))
        && isRecord(cost)
        && hasOnlyKeys(cost, ['amountKnown', 'amountConservative', 'usageUnknown', 'sourceHash'])
        && typeof cost.usageUnknown === 'boolean'
        && isFiniteNullableNumber(cost.amountKnown)
        && isFiniteNullableNumber(cost.amountConservative)
        && (cost.sourceHash === null
            || (typeof cost.sourceHash === 'string' && HASH_PATTERN.test(cost.sourceHash)))
        && isRecord(familyRows)
        && FAMILY_ROW_KEYS.every(key => isProjectionRows(familyRows[key]))
        && Object.keys(familyRows).every(key => FAMILY_ROW_KEYS.includes(key as typeof FAMILY_ROW_KEYS[number]))
    );
}

export function compareAnalysisCanonicalProjection(
    source: unknown,
    canonical: unknown,
): AnalysisParitySummary {
    if (!source) return { status: 'blocked', mismatchPaths: ['source.missing'] };
    if (!canonical) return { status: 'blocked', mismatchPaths: ['canonical.missing'] };
    if (!isProjection(source) || !isProjection(canonical)) {
        return { status: 'blocked', mismatchPaths: ['comparison.required'] };
    }
    // An unknown source is an evidence gap, not a value that can establish
    // parity. Even equal synthetic placeholders must remain fail-open and
    // blocked until both sides carry the required concrete rows.
    if (source.unknownSource && canonical.unknownSource) {
        return { status: 'blocked', mismatchPaths: ['unknownSource'] };
    }
    const mismatchPaths: string[] = [];
    const compare = (path: string, left: unknown, right: unknown): void => {
        if (stableCompareValue(left) !== stableCompareValue(right)) mismatchPaths.push(path);
    };
    compare('ownership', source.ownership ?? null, canonical.ownership ?? null);
    compare('state', source.state ?? null, canonical.state ?? null);
    compare('counts', source.counts ?? null, canonical.counts ?? null);
    compare('candidate', source.candidate, canonical.candidate);
    compare('interaction', source.interaction, canonical.interaction);
    compare('order', source.order, canonical.order);
    compare('orderHash', source.orderHash ?? null, canonical.orderHash ?? null);
    compare('contentHash', source.contentHash ?? null, canonical.contentHash ?? null);
    compare('request.status', source.requestStatus ?? null, canonical.requestStatus ?? null);
    compare('progress', source.progress ?? null, canonical.progress ?? null);
    compare('result', source.result ?? null, canonical.result ?? null);
    compare('provider.operation', source.providerOperation ?? null, canonical.providerOperation ?? null);
    compare('cost', source.cost ?? null, canonical.cost ?? null);
    compare('retention', source.retention ?? null, canonical.retention ?? null);
    compare('audit.retention', source.auditRetention ?? null, canonical.auditRetention ?? null);
    compare('unknownSource', source.unknownSource ?? null, canonical.unknownSource ?? null);
    compare('familyRows', source.familyRows, canonical.familyRows);
    return {
        status: mismatchPaths.length > 0 ? 'mismatch' : 'match',
        mismatchPaths,
    };
}

export interface AnalysisCanonicalReadBundle {
    jobs: readonly unknown[];
    events: readonly unknown[];
    artifacts: readonly unknown[];
    costs: readonly unknown[];
    caches: readonly unknown[];
    audits: readonly unknown[];
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
    artifacts: [
        'id', 'request_id', 'job_id', 'kind', 'artifact_key', 'state', 'content_hash',
        'payload', 'retention_class', 'created_at', 'updated_at',
    ],
    costs: [
        'id', 'request_id', 'provider', 'operation_key', 'stage', 'currency',
        'amount_known', 'amount_conservative', 'usage_unknown', 'source_hash',
        'payload', 'retention_class', 'recorded_at',
    ],
    caches: [
        'id', 'scope', 'cache_key_hash', 'state', 'expires_at', 'single_flight_token_hash',
        'payload', 'created_at', 'updated_at',
    ],
    audits: [
        'id', 'request_id', 'version', 'kind', 'candidate_key', 'ordinal', 'state',
        'content_hash', 'retention_class', 'payload', 'created_at',
    ],
};

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

function isNullableTimestamp(value: unknown): value is string | null {
    return value === null || isTimestamp(value);
}

function isCanonicalRowShape(key: keyof AnalysisCanonicalReadBundle, value: unknown): boolean {
    if (!isRecord(value)) return false;
    const fields = REQUIRED_CANONICAL_ROW_FIELDS[key];
    if (fields.some(field => !Object.prototype.hasOwnProperty.call(value, field))) return false;
    if (Object.keys(value).some(field => !fields.includes(field))) return false;
    if (key !== 'caches' && !(typeof value.request_id === 'string' && UUID_PATTERN.test(value.request_id))) {
        return false;
    }
    if (!isRecord(value.payload)) return false;
    if (key !== 'caches' && (typeof value.retention_class !== 'string' || value.retention_class.length < 1)) {
        return false;
    }
    if (key === 'jobs') {
        return UUID_PATTERN.test(String(value.id))
            && typeof value.job_key === 'string'
            && ['coordinator', 'collection', 'ai', 'finalize', 'recovery'].includes(String(value.kind))
            && ['queued', 'leased', 'running', 'succeeded', 'failed', 'blocked'].includes(String(value.state))
            && Number.isSafeInteger(value.generation)
            && Number.isSafeInteger(value.attempt_count)
            && Number.isSafeInteger(value.dependency_count)
            && isTimestamp(value.next_attempt_at)
            && isNullableTimestamp(value.lease_expires_at)
            && isNullableHash(value.completion_hash)
            && isTimestamp(value.created_at)
            && isTimestamp(value.updated_at);
    }
    if (key === 'events') {
        return Number.isSafeInteger(value.id)
            && isNullableUuid(value.job_id)
            && ['progress', 'lifecycle', 'operational'].includes(String(value.kind))
            && typeof value.state === 'string'
            && HASH_PATTERN.test(String(value.content_hash))
            && isTimestamp(value.created_at);
    }
    if (key === 'artifacts') {
        return UUID_PATTERN.test(String(value.id))
            && isNullableUuid(value.job_id)
            && ['evidence', 'manifest', 'media_ref', 'replay'].includes(String(value.kind))
            && typeof value.artifact_key === 'string'
            && ['staged', 'retained', 'expired', 'blocked'].includes(String(value.state))
            && HASH_PATTERN.test(String(value.content_hash))
            && isTimestamp(value.created_at)
            && isTimestamp(value.updated_at);
    }
    if (key === 'costs') {
        return Number.isSafeInteger(value.id)
            && typeof value.provider === 'string'
            && typeof value.operation_key === 'string'
            && typeof value.stage === 'string'
            && typeof value.currency === 'string'
            && isFiniteNullableNumber(value.amount_known)
            && isFiniteNullableNumber(value.amount_conservative)
            && typeof value.usage_unknown === 'boolean'
            && HASH_PATTERN.test(String(value.source_hash))
            && isTimestamp(value.recorded_at);
    }
    if (key === 'caches') {
        return UUID_PATTERN.test(String(value.id))
            && ['ai', 'profile', 'anonymous', 'blite'].includes(String(value.scope))
            && HASH_PATTERN.test(String(value.cache_key_hash))
            && ['pending', 'ready', 'failed', 'expired'].includes(String(value.state))
            && isTimestamp(value.expires_at)
            && isNullableHash(value.single_flight_token_hash)
            && isTimestamp(value.created_at)
            && isTimestamp(value.updated_at);
    }
    return UUID_PATTERN.test(String(value.id))
        && Number.isSafeInteger(value.version)
        && ['bundle', 'candidate', 'interaction'].includes(String(value.kind))
        && (value.candidate_key === null || typeof value.candidate_key === 'string')
        && (value.ordinal === null || Number.isSafeInteger(value.ordinal))
        && ['complete', 'partial', 'inconsistent', 'failed'].includes(String(value.state))
        && HASH_PATTERN.test(String(value.content_hash))
        && isTimestamp(value.created_at);
}

function asRows(value: unknown, key: keyof AnalysisCanonicalReadBundle): readonly unknown[] {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid canonical response.');
    }
    const rows = (value as Record<string, unknown>)[key];
    if (!Array.isArray(rows)) {
        throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: invalid canonical ${key} collection.`);
    }
    if (rows.length > CANONICAL_READ_MAX_ROWS) {
        throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: oversized canonical ${key} collection.`);
    }
    for (const row of rows) {
        if (!isCanonicalRowShape(key, row)) {
            throw new Error(`ANALYSIS_CANONICAL_READ_ERROR: invalid or missing required canonical ${key} field.`);
        }
    }
    return Object.freeze([...rows]);
}

function sanitizeParitySummary(value: unknown): AnalysisParitySummary {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('invalid comparison result');
    }
    const candidate = value as Record<string, unknown>;
    if (
        (candidate.status !== 'match' && candidate.status !== 'mismatch' && candidate.status !== 'blocked')
        || !Array.isArray(candidate.mismatchPaths)
        || candidate.mismatchPaths.length > 32
        || candidate.mismatchPaths.some(path => (
            typeof path !== 'string' || !SANITIZED_PARITY_PATHS.has(path)
        ))
        || (candidate.status === 'match' && candidate.mismatchPaths.length > 0)
    ) {
        throw new Error('invalid comparison result');
    }
    return {
        status: candidate.status,
        mismatchPaths: [...candidate.mismatchPaths] as string[],
    };
}

function parseBundle(value: unknown): AnalysisCanonicalReadBundle {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid canonical response.');
    }
    const unknownKeys = Object.keys(value as Record<string, unknown>)
        .filter(key => !(['jobs', 'events', 'artifacts', 'costs', 'caches', 'audits'] as const).includes(
            key as 'jobs' | 'events' | 'artifacts' | 'costs' | 'caches' | 'audits'
        ));
    if (unknownKeys.length > 0) {
        throw new Error('ANALYSIS_CANONICAL_READ_ERROR: unknown canonical collection.');
    }
    return {
        jobs: asRows(value, 'jobs'),
        events: asRows(value, 'events'),
        artifacts: asRows(value, 'artifacts'),
        costs: asRows(value, 'costs'),
        caches: asRows(value, 'caches'),
        audits: asRows(value, 'audits'),
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
        try {
            callback?.(summary);
        } catch {
            // Shadow telemetry cannot change the legacy response path.
        }
        try {
            options.onMismatch?.({ family, summary });
        } catch {
            // The injected diagnostic hook is also fail-open.
        }
    };

    return {
        async loadRequest(requestId, family) {
            if (!UUID_PATTERN.test(requestId)) {
                throw new Error('ANALYSIS_CANONICAL_READ_ERROR: invalid request id.');
            }
            if (!analysisCanonicalReadEnabled(family, env)) return null;
            const result = await client.rpc('load_analysis_canonical_family', {
                p_request_id: requestId,
                p_family: family,
            }) as CanonicalReadRpcResult;
            if (result.error) throw new Error(
                result.error.message || result.error.code || 'canonical read failed'
            );
            return parseBundle(result.data);
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
                canonical = await input.canonical();
            } catch {
                reportMismatch(input.family, {
                    status: 'blocked',
                    mismatchPaths: ['canonical.error'],
                }, input.onMismatch);
                return legacy;
            }
            if (typeof input.compare !== 'function') {
                const summary = {
                    status: 'blocked',
                    mismatchPaths: ['comparison.missing'],
                } satisfies AnalysisParitySummary;
                reportMismatch(input.family, summary, input.onMismatch);
                return legacy;
            }
            let summary: AnalysisParitySummary;
            try {
                summary = sanitizeParitySummary(input.compare(legacy, canonical));
            } catch {
                summary = {
                    status: 'blocked',
                    mismatchPaths: ['comparison.error'],
                } satisfies AnalysisParitySummary;
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
