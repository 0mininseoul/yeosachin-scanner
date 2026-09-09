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
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const ANALYSIS_CANONICAL_SCHEMA_VERSION = 1 as const;
const MAX_CANONICAL_PROJECTION_COUNT = 1_000_000;

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
    'request.id',
    'source.incomplete',
    'canonical.incomplete',
    'source.evidence',
    'canonical.evidence',
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
    schemaVersion: typeof ANALYSIS_CANONICAL_SCHEMA_VERSION;
    requestId: string;
    requestStatus: string | null;
    ownership: string;
    state: string;
    counts: AnalysisCanonicalProjectionCounts;
    candidate: readonly AnalysisCanonicalCandidateProjection[];
    interaction: readonly AnalysisCanonicalInteractionProjection[];
    order: readonly AnalysisCanonicalOrderProjection[];
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
    evidence: Readonly<{
        targetManifests: readonly AnalysisCanonicalTargetEvidenceProjection[];
        targetInteractions: readonly AnalysisCanonicalTargetInteractionProjection[];
    }>;
    familyRows: Readonly<{
        jobs: readonly unknown[];
        events: readonly unknown[];
        artifacts: readonly unknown[];
        costs: readonly unknown[];
        caches: readonly unknown[];
        audits: readonly unknown[];
    }>;
}

export interface AnalysisCanonicalProjectionCounts {
    detectedMutuals: number;
    publicMutuals: number;
    privateMutuals: number;
    screenedMutuals: number;
    candidates: number;
    interactions: number;
}

export interface AnalysisCanonicalCandidateProjection {
    key: string;
    ordinal: number;
    rank: number | null;
    score: number | null;
    state: string;
    contentHash: string;
}

export interface AnalysisCanonicalInteractionProjection {
    key: string;
    candidateKey: string | null;
    signal: string;
    occurredAt: string | null;
    evidenceId: string;
    contentHash: string;
}

export interface AnalysisCanonicalOrderProjection {
    key: string;
    list: 'female' | 'private' | 'public';
    ordinal: number;
    rank: number | null;
}

export interface AnalysisCanonicalTargetEvidenceProjection {
    key: string;
    inputHash: string;
    likerSourceHash: string;
    commentSourceHash: string;
    resultHash: string;
    interactorCount: number;
    likerCount: number;
    commentCount: number;
    retention: string;
}

export interface AnalysisCanonicalTargetInteractionProjection {
    key: string;
    signal: 'target_post_like' | 'target_post_comment';
    occurredAt: string | null;
    evidenceId: string;
}

const PROJECTION_REQUIRED_FIELDS = [
    'schemaVersion',
    'requestId',
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
    'evidence',
    'familyRows',
] as const;

const FAMILY_ROW_KEYS = ['jobs', 'events', 'artifacts', 'costs', 'caches', 'audits'] as const;
const COUNT_FIELDS = [
    'detectedMutuals', 'publicMutuals', 'privateMutuals', 'screenedMutuals',
    'candidates', 'interactions',
] as const;

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    return Object.keys(value).length === keys.length
        && Object.keys(value).every(key => keys.includes(key));
}

function isFiniteNullableNumber(value: unknown): value is number | null {
    return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isBoundedString(value: unknown, max = 512): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function isExactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    return isRecord(value)
        && Object.keys(value).length === keys.length
        && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

const PROJECTION_JSON_SAFE_KEYS = [
    'schemaVersion', 'requestId', 'requestStatus', 'ownership', 'state', 'counts',
    'candidate', 'interaction', 'order', 'orderHash', 'contentHash', 'progress', 'result',
    'providerOperation', 'cost', 'retention', 'auditRetention', 'unknownSource', 'familyRows',
    'evidence', 'targetManifests', 'targetInteractions', 'finalized', 'lateCost', 'provider',
    'projection', 'resultStatus', 'planId', 'targetManifest',
    'operationKey', 'runId', 'status', 'maxChargeUsd', 'credentialSlot', 'amountKnown',
    'amountConservative', 'usageUnknown', 'sourceHash', 'key', 'candidateKey', 'signal',
    'occurredAt', 'evidenceId', 'list', 'ordinal', 'rank', 'score', 'targetManifest',
    'resultHash', 'inputHash', 'likerSourceHash', 'commentSourceHash', 'interactorCount', 'likerCount', 'commentCount', 'retention', 'counts',
    'detectedMutuals', 'publicMutuals', 'privateMutuals', 'screenedMutuals', 'candidates',
    'interactions', 'jobs', 'events', 'artifacts', 'costs', 'caches', 'audits', 'id',
    'request_id', 'job_id', 'job_key', 'kind', 'generation', 'attempt_count', 'dependency_count',
    'next_attempt_at', 'lease_expires_at', 'completion_hash', 'payload', 'retention_class',
    'created_at', 'updated_at', 'artifact_key', 'scope', 'cache_key_hash', 'expires_at',
    'single_flight_token_hash', 'version', 'candidate_key', 'content_hash', 'idempotency_key',
    'recorded_at', 'currency', 'provider_operation', 'stage', 'operation_key', 'source_hash',
    'ok', 'message', 'errorCode', 'details', 'track', 'batch', 'jobKey', 'generation',
    'successorCount', 'eventCode', 'copyCode', 'aggregateCount', 'tracks', 'lateCost',
    'family', 'retryKey', 'resultStatus', 'projection', 'planId',
    'inputHash', 'likerSourceHash', 'commentSourceHash', 'frozenAt', 'relationshipAi', 'finalization',
    'stageCode', 'done', 'total', 'completed', 'lowSeconds', 'highSeconds', 'orderHash',
    'auditRetention', 'providerOperation', 'familyRows',
];

const PROJECTION_FORBIDDEN_KEYS = new Set([
    'rawProviderPayload', 'raw_provider_payload', 'providerToken', 'provider_token',
    'accessToken', 'access_token', 'cookie', 'cookies', 'authorization', 'secret',
    'synthetic', 'placeholder', 'partialEvidence', 'partial_evidence',
    'targetUsername', 'target_username', 'likerSource', 'liker_source',
    'commentSource', 'comment_source', 'sourceSensitive', 'source_sensitive',
]);

const CANONICAL_NESTED_EXACT_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    counts: [
        'detectedMutuals', 'publicMutuals', 'privateMutuals', 'screenedMutuals',
        'candidates', 'interactions',
    ],
    candidate: ['key', 'ordinal', 'rank', 'score', 'state', 'contentHash'],
    interaction: ['key', 'candidateKey', 'signal', 'occurredAt', 'evidenceId', 'contentHash'],
    order: ['key', 'list', 'ordinal', 'rank'],
    cost: ['amountKnown', 'amountConservative', 'usageUnknown', 'sourceHash'],
    tracks: ['relationshipAi', 'interactions', 'finalization'],
    relationshipAi: ['state', 'stageCode', 'done', 'total'],
    interactions: ['state', 'stageCode', 'done', 'total'],
    finalization: ['state', 'stageCode', 'done', 'total'],
    progress: ['state', 'completed', 'total'],
    result: ['rank', 'score'],
    evidence: ['targetManifests', 'targetInteractions'],
    targetManifests: [
        'key', 'inputHash', 'likerSourceHash', 'commentSourceHash', 'resultHash',
        'interactorCount', 'likerCount', 'commentCount', 'retention',
    ],
    targetInteractions: ['key', 'signal', 'occurredAt', 'evidenceId'],
    targetManifest: [
        'key', 'inputHash', 'likerSourceHash', 'commentSourceHash', 'resultHash',
        'interactorCount', 'likerCount', 'commentCount', 'retention',
    ],
    jobs: [
        'id', 'request_id', 'job_key', 'kind', 'state', 'generation', 'attempt_count',
        'dependency_count', 'next_attempt_at', 'lease_expires_at', 'completion_hash',
        'payload', 'retention_class', 'created_at', 'updated_at',
    ],
    events: ['id', 'request_id', 'job_id', 'kind', 'state', 'payload', 'content_hash', 'retention_class', 'created_at'],
    artifacts: [
        'id', 'request_id', 'job_id', 'kind', 'artifact_key', 'state', 'content_hash',
        'payload', 'retention_class', 'created_at', 'updated_at',
    ],
    costs: [
        'id', 'request_id', 'provider', 'operation_key', 'stage', 'currency', 'amount_known',
        'amount_conservative', 'usage_unknown', 'source_hash', 'idempotency_key', 'payload',
        'retention_class', 'recorded_at',
    ],
    caches: [
        'id', 'request_id', 'scope', 'cache_key_hash', 'state', 'expires_at',
        'single_flight_token_hash', 'payload', 'created_at', 'updated_at',
    ],
    audits: [
        'id', 'request_id', 'version', 'kind', 'candidate_key', 'ordinal', 'state',
        'content_hash', 'idempotency_key', 'retention_class', 'payload', 'created_at',
    ],
    projection: [
        'schemaVersion', 'requestId', 'requestStatus', 'ownership', 'state', 'counts',
        'candidate', 'interaction', 'order', 'orderHash', 'contentHash', 'progress', 'result',
        'providerOperation', 'cost', 'retention', 'auditRetention', 'unknownSource', 'evidence',
        'familyRows',
    ],
    familyRows: ['jobs', 'events', 'artifacts', 'costs', 'caches', 'audits'],
});

function isSafeJsonPayload(value: unknown, depth = 0, parentKey: string | null = null): boolean {
    if (depth > 8) return false;
    if (value === null || typeof value === 'boolean') return true;
    if (typeof value === 'string') return value.length <= 8_192;
    if (typeof value === 'number') return Number.isFinite(value);
    if (Array.isArray(value)) return value.length <= 100 && value.every(item => isSafeJsonPayload(item, depth + 1, parentKey));
    if (!isRecord(value) || Object.keys(value).length > 64) return false;
    const exactKeys = parentKey ? CANONICAL_NESTED_EXACT_KEYS[parentKey] : undefined;
    if (exactKeys && (
        Object.keys(value).length !== exactKeys.length
        || Object.keys(value).some(key => !exactKeys.includes(key))
    )) return false;
    return Object.entries(value).every(([key, child]) => (
        (key !== 'schemaVersion' || child === ANALYSIS_CANONICAL_SCHEMA_VERSION)
        &&
        !PROJECTION_FORBIDDEN_KEYS.has(key)
        && !PROJECTION_FORBIDDEN_KEYS.has(key.toLowerCase())
        && PROJECTION_JSON_SAFE_KEYS.includes(key)
        && isSafeJsonPayload(child, depth + 1, key)
    ));
}

function isProjectionRows(
    value: unknown,
    type: 'candidate' | 'interaction' | 'order' | 'family',
): boolean {
    if (!Array.isArray(value) || value.length > CANONICAL_READ_MAX_ROWS) return false;
    return value.every(row => {
        if (!isRecord(row) || !isSafeJsonPayload(row)) return false;
        if (type === 'family') return isAnyCanonicalFamilyRow(row);
        if (type === 'candidate') {
            const ordinal = row.ordinal;
            return isExactObject(row, ['key', 'ordinal', 'rank', 'score', 'state', 'contentHash'])
                && isBoundedString(row.key, 256)
                && Number.isSafeInteger(ordinal)
                && (ordinal as number) >= 1
                && (ordinal as number) <= 1200
                && isFiniteNullableNumber(row.rank)
                && isFiniteNullableNumber(row.score)
                && isBoundedString(row.state, 64)
                && typeof row.contentHash === 'string'
                && HASH_PATTERN.test(row.contentHash);
        }
        if (type === 'interaction') {
            return isExactObject(row, ['key', 'candidateKey', 'signal', 'occurredAt', 'evidenceId', 'contentHash'])
                && isBoundedString(row.key, 256)
                && (row.candidateKey === null || isBoundedString(row.candidateKey, 256))
                && isBoundedString(row.signal, 64)
                && (row.occurredAt === null || isTimestamp(row.occurredAt))
                && isBoundedString(row.evidenceId, 256)
                && typeof row.contentHash === 'string'
                && HASH_PATTERN.test(row.contentHash);
        }
        const ordinal = row.ordinal;
        return isExactObject(row, ['key', 'list', 'ordinal', 'rank'])
            && isBoundedString(row.key, 256)
            && (row.list === 'female' || row.list === 'private' || row.list === 'public')
            && Number.isSafeInteger(ordinal)
            && (ordinal as number) >= 1
            && (ordinal as number) <= 1200
            && isFiniteNullableNumber(row.rank);
    });
}

function isEvidenceProjection(value: unknown): value is AnalysisCanonicalNormalizedProjection['evidence'] {
    if (!isExactObject(value, ['targetManifests', 'targetInteractions'])) return false;
    if (!Array.isArray(value.targetManifests) || value.targetManifests.length > CANONICAL_READ_MAX_ROWS) return false;
    if (!Array.isArray(value.targetInteractions) || value.targetInteractions.length > CANONICAL_READ_MAX_ROWS) return false;
    const manifests = value.targetManifests.every(row => (
        isExactObject(row, [
            'key', 'inputHash', 'likerSourceHash', 'commentSourceHash', 'resultHash',
            'interactorCount', 'likerCount', 'commentCount', 'retention',
        ])
        && isBoundedString(row.key, 256)
        && typeof row.inputHash === 'string' && HASH_PATTERN.test(row.inputHash)
        && typeof row.likerSourceHash === 'string' && HASH_PATTERN.test(row.likerSourceHash)
        && typeof row.commentSourceHash === 'string' && HASH_PATTERN.test(row.commentSourceHash)
        && typeof row.resultHash === 'string' && HASH_PATTERN.test(row.resultHash)
        && Number.isSafeInteger(row.interactorCount as number) && (row.interactorCount as number) >= 0
        && (row.interactorCount as number) <= 690
        && Number.isSafeInteger(row.likerCount as number) && (row.likerCount as number) >= 0
        && (row.likerCount as number) <= 600
        && Number.isSafeInteger(row.commentCount as number) && (row.commentCount as number) >= 0
        && (row.commentCount as number) <= 90
        && isBoundedString(row.retention, 64)
    ));
    const interactions = value.targetInteractions.every(row => (
        isExactObject(row, ['key', 'signal', 'occurredAt', 'evidenceId'])
        && isBoundedString(row.key, 256)
        && (row.signal === 'target_post_like' || row.signal === 'target_post_comment')
        && (row.occurredAt === null || isTimestamp(row.occurredAt))
        && isBoundedString(row.evidenceId, 256)
    ));
    return manifests && interactions;
}

function isProjection(value: unknown): value is AnalysisCanonicalNormalizedProjection {
    if (!isRecord(value)) return false;
    if (PROJECTION_REQUIRED_FIELDS.some(field => !Object.prototype.hasOwnProperty.call(value, field))) {
        return false;
    }
    if (!hasOnlyKeys(value, PROJECTION_REQUIRED_FIELDS)) return false;
    const counts = value.counts;
    const cost = value.cost;
    const familyRows = value.familyRows;
    const progress = value.progress;
    const result = value.result;
    return (
        value.schemaVersion === ANALYSIS_CANONICAL_SCHEMA_VERSION
        && typeof value.requestId === 'string' && UUID_PATTERN.test(value.requestId)
        && (value.requestStatus === null || isBoundedString(value.requestStatus, 64))
        && isBoundedString(value.state, 64)
        && isBoundedString(value.ownership, 64)
        && isExactObject(counts, COUNT_FIELDS)
        && COUNT_FIELDS.every(field => (
            typeof counts[field] === 'number'
            && Number.isSafeInteger(counts[field])
            && (counts[field] as number) >= 0
            && (counts[field] as number) <= MAX_CANONICAL_PROJECTION_COUNT
        ))
        && isProjectionRows(value.candidate, 'candidate')
        && isProjectionRows(value.interaction, 'interaction')
        && isProjectionRows(value.order, 'order')
        && counts.candidates === (value.candidate as readonly unknown[]).length
        && counts.interactions === (value.interaction as readonly unknown[]).length
        && counts.candidates === (value.order as readonly unknown[]).length
        && (value.orderHash === null || (typeof value.orderHash === 'string' && HASH_PATTERN.test(value.orderHash)))
        && (value.contentHash === null || (typeof value.contentHash === 'string' && HASH_PATTERN.test(value.contentHash)))
        && (value.providerOperation === null || isBoundedString(value.providerOperation, 256))
        && (value.retention === null || isBoundedString(value.retention, 64))
        && (value.auditRetention === null || isBoundedString(value.auditRetention, 64))
        && typeof value.unknownSource === 'boolean'
        && isEvidenceProjection(value.evidence)
        && (progress === null || (
            isRecord(progress)
            && hasOnlyKeys(progress, ['state', 'completed', 'total'])
            && isBoundedString(progress.state, 64)
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
        && FAMILY_ROW_KEYS.every(key => isProjectionRows(familyRows[key] as unknown, 'family'))
        && Object.keys(familyRows).every(key => FAMILY_ROW_KEYS.includes(key as typeof FAMILY_ROW_KEYS[number]))
    );
}

export function compareAnalysisCanonicalProjection(
    source: unknown,
    canonical: unknown,
): AnalysisParitySummary {
    if (!source) return { status: 'blocked', mismatchPaths: ['source.missing'] };
    if (!canonical) return { status: 'blocked', mismatchPaths: ['canonical.missing'] };
    // An explicitly unknown source is never allowed to be hidden behind a
    // malformed or partial projection.  Report the evidence gap first so a
    // synthetic shadow object cannot turn into a misleading schema error.
    if (
        (isRecord(source) && source.unknownSource === true)
        || (isRecord(canonical) && canonical.unknownSource === true)
    ) {
        return { status: 'blocked', mismatchPaths: ['unknownSource'] };
    }
    if (!isProjection(source) || !isProjection(canonical)) {
        return { status: 'blocked', mismatchPaths: ['comparison.required'] };
    }
    // An unknown source is an evidence gap, not a value that can establish
    // parity. Even equal synthetic placeholders must remain fail-open and
    // blocked until both sides carry the required concrete rows.
    if (source.unknownSource || canonical.unknownSource) {
        return { status: 'blocked', mismatchPaths: ['unknownSource'] };
    }
    const mismatchPaths: string[] = [];
    const compare = (path: string, left: unknown, right: unknown): void => {
        if (stableCompareValue(left) !== stableCompareValue(right)) mismatchPaths.push(path);
    };
    compare('request.id', source.requestId, canonical.requestId);
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
    compare('evidence', source.evidence, canonical.evidence);
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
        'idempotency_key', 'payload', 'retention_class', 'recorded_at',
    ],
    caches: [
        'id', 'request_id', 'scope', 'cache_key_hash', 'state', 'expires_at',
        'single_flight_token_hash', 'payload', 'created_at', 'updated_at',
    ],
    audits: [
        'id', 'request_id', 'version', 'kind', 'candidate_key', 'ordinal', 'state',
        'content_hash', 'idempotency_key', 'retention_class', 'payload', 'created_at',
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

const CANONICAL_PAYLOAD_KEYS: Readonly<Record<keyof AnalysisCanonicalReadBundle, readonly string[]>> = {
    jobs: [
        'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey', 'generation',
        'attemptCount', 'dependencyCount', 'completionHash', 'requestStatus', 'state', 'counts',
    ],
    events: [
        'schemaVersion', 'jobKey', 'generation', 'successorCount', 'eventCode', 'copyCode',
        'aggregateCount', 'tracks', 'artifactKey', 'kind', 'state', 'source', 'resultHash',
        'targetManifest', 'candidate', 'interaction', 'order', 'retention', 'counts', 'evidence',
    ],
    artifacts: [
        'schemaVersion', 'jobKey', 'generation', 'successorCount', 'eventCode', 'copyCode',
        'aggregateCount', 'tracks', 'artifactKey', 'kind', 'state', 'source', 'resultHash',
        'targetManifest', 'candidate', 'interaction', 'order', 'retention', 'counts', 'evidence',
        'inputHash', 'likerSourceHash', 'commentSourceHash', 'interactorCount',
        'likerCount', 'commentCount', 'frozenAt',
    ],
    costs: [
        'schemaVersion', 'runId', 'status', 'maxChargeUsd', 'credentialSlot', 'usageUnknown',
        'amountKnown', 'amountConservative', 'sourceHash', 'operationKey', 'provider',
    ],
    caches: [
        'schemaVersion', 'requestId', 'scope', 'cacheKeyHash', 'state', 'expiresAt',
        'singleFlightTokenHash',
    ],
    audits: [
        'schemaVersion', 'finalized', 'requestStatus', 'resultStatus', 'projection', 'lateCost',
        'provider', 'operationKey', 'cost', 'retention', 'unknownSource', 'candidate',
        'interaction', 'order', 'state',
    ],
};

function isRetryPayload(value: unknown, row?: Record<string, unknown>): boolean {
    if (!isExactObject(value, ['family', 'retryKey'])) return false;
    if (!['jobs', 'evidence', 'cost', 'cache', 'audit'].includes(String(value.family))) return false;
    if (!isBoundedString(value.retryKey, 256)) return false;
    return typeof row?.request_id === 'string'
        && value.retryKey === `${row.request_id}:${value.family}`;
}

function isCanonicalJsonPayload(
    value: unknown,
    key: keyof AnalysisCanonicalReadBundle,
    row?: Record<string, unknown>,
): value is Record<string, unknown> {
    if (!isRecord(value) || !isSafeJsonPayload(value)) return false;
    const keys = Object.keys(value);
    if (
        key === 'events'
        && row?.kind === 'operational'
        && row.state === 'canonical_retry'
        && isRetryPayload(value, row)
    ) return true;
    return value.schemaVersion === ANALYSIS_CANONICAL_SCHEMA_VERSION
        && Object.prototype.hasOwnProperty.call(value, 'schemaVersion')
        && keys.length > 0
        && keys.every(payloadKey => CANONICAL_PAYLOAD_KEYS[key].includes(payloadKey));
}

function isCanonicalRowShape(key: keyof AnalysisCanonicalReadBundle, value: unknown): boolean {
    if (!isRecord(value)) return false;
    const fields = REQUIRED_CANONICAL_ROW_FIELDS[key];
    if (fields.some(field => !Object.prototype.hasOwnProperty.call(value, field))) return false;
    if (Object.keys(value).some(field => !fields.includes(field))) return false;
    if (key !== 'caches' && !(typeof value.request_id === 'string' && UUID_PATTERN.test(value.request_id))) {
        return false;
    }
    if (!isCanonicalJsonPayload(value.payload, key, value)) return false;
    if (key !== 'caches' && (typeof value.retention_class !== 'string' || value.retention_class.length < 1)) {
        return false;
    }
    if (key === 'jobs') {
        return UUID_PATTERN.test(String(value.id))
            && isBoundedString(value.job_key, 160)
            && ['coordinator', 'collection', 'ai', 'finalize', 'recovery'].includes(String(value.kind))
            && ['queued', 'leased', 'running', 'succeeded', 'failed', 'blocked'].includes(String(value.state))
            && Number.isSafeInteger(value.generation)
            && (value.generation as number) >= 0
            && Number.isSafeInteger(value.attempt_count)
            && (value.attempt_count as number) >= 0 && (value.attempt_count as number) <= 1_000
            && Number.isSafeInteger(value.dependency_count)
            && (value.dependency_count as number) >= 0
            && isTimestamp(value.next_attempt_at)
            && isNullableTimestamp(value.lease_expires_at)
            && isNullableHash(value.completion_hash)
            && isBoundedString(value.retention_class, 64)
            && isTimestamp(value.created_at)
            && isTimestamp(value.updated_at);
    }
    if (key === 'events') {
        return Number.isSafeInteger(value.id)
            && isNullableUuid(value.job_id)
            && ['progress', 'lifecycle', 'operational'].includes(String(value.kind))
            && isBoundedString(value.state, 64)
            && HASH_PATTERN.test(String(value.content_hash))
            && isBoundedString(value.retention_class, 64)
            && (value.state !== 'canonical_retry' || value.kind === 'operational')
            && (value.state !== 'canonical_retry' || CANONICAL_TIMESTAMP_PATTERN.test(String(value.created_at)))
            && isTimestamp(value.created_at);
    }
    if (key === 'artifacts') {
        return UUID_PATTERN.test(String(value.id))
            && isNullableUuid(value.job_id)
            && ['evidence', 'manifest', 'media_ref', 'replay'].includes(String(value.kind))
            && isBoundedString(value.artifact_key, 512)
            && ['staged', 'retained', 'expired', 'blocked'].includes(String(value.state))
            && HASH_PATTERN.test(String(value.content_hash))
            && isBoundedString(value.retention_class, 64)
            && isTimestamp(value.created_at)
            && isTimestamp(value.updated_at);
    }
    if (key === 'costs') {
        return Number.isSafeInteger(value.id)
            && isBoundedString(value.provider, 128)
            && isBoundedString(value.operation_key, 512)
            && isBoundedString(value.stage, 128)
            && typeof value.currency === 'string' && value.currency.length === 3
            && isFiniteNullableNumber(value.amount_known)
            && isFiniteNullableNumber(value.amount_conservative)
            && typeof value.usage_unknown === 'boolean'
            && (!value.usage_unknown || value.amount_known === null)
            && (value.amount_known === null || value.amount_conservative === null
                || value.amount_conservative >= value.amount_known)
            && HASH_PATTERN.test(String(value.source_hash))
            && (value.idempotency_key === null || isBoundedString(value.idempotency_key, 256))
            && isBoundedString(value.retention_class, 64)
            && isTimestamp(value.recorded_at);
    }
    if (key === 'caches') {
        return UUID_PATTERN.test(String(value.id))
            && UUID_PATTERN.test(String(value.request_id))
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
        && (value.idempotency_key === null || isBoundedString(value.idempotency_key, 256))
        && (value.candidate_key === null || isBoundedString(value.candidate_key, 512))
        && (value.ordinal === null || ((value.ordinal as number) >= 1 && (value.ordinal as number) <= 100_000))
        && isBoundedString(value.retention_class, 64)
        && isTimestamp(value.created_at);
}

function isAnyCanonicalFamilyRow(value: Record<string, unknown>): boolean {
    if (value.job_key !== undefined) return isCanonicalRowShape('jobs', value);
    if (value.artifact_key !== undefined) return isCanonicalRowShape('artifacts', value);
    if (value.operation_key !== undefined) return isCanonicalRowShape('costs', value);
    if (value.cache_key_hash !== undefined) return isCanonicalRowShape('caches', value);
    if (value.version !== undefined) return isCanonicalRowShape('audits', value);
    return isCanonicalRowShape('events', value);
}

function asRows(
    value: unknown,
    key: keyof AnalysisCanonicalReadBundle,
    requestId?: string,
): readonly unknown[] {
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
        if (
            !isCanonicalRowShape(key, row)
            || (Boolean(requestId) && isRecord(row) && row.request_id !== requestId)
        ) {
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

function parseBundle(value: unknown, requestId?: string): AnalysisCanonicalReadBundle {
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
        jobs: asRows(value, 'jobs', requestId),
        events: asRows(value, 'events', requestId),
        artifacts: asRows(value, 'artifacts', requestId),
        costs: asRows(value, 'costs', requestId),
        caches: asRows(value, 'caches', requestId),
        audits: asRows(value, 'audits', requestId),
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
