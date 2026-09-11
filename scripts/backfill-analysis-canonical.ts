import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const BACKFILL_MAX_LIMIT = 100;
export const ANALYSIS_CANONICAL_BACKFILL_APPLY_ACKNOWLEDGEMENT =
    'I_UNDERSTAND_ANALYSIS_CANONICAL_BACKFILL_APPLY_V1';
export const ANALYSIS_CANONICAL_BACKFILL_APPLY_RPC =
    'apply_analysis_canonical_backfill_row';
const SOURCE_TABLE = 'analysis_requests';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const TRACK_PATTERN = /^[a-z][a-z0-9_]{0,49}$/;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;
const MONEY_PATTERN = /^(0|[1-9]\d{0,5})(?:\.(\d{1,12}))?$/;
const MICROSECONDS_PER_SECOND = BigInt(1_000_000);
const MICROSECONDS_PER_MINUTE = BigInt(60) * MICROSECONDS_PER_SECOND;

export type AnalysisCanonicalBackfillFamily =
    | 'jobs'
    | 'events'
    | 'artifacts'
    | 'costs'
    | 'cache'
    // Retained for normalized-row compatibility with the canonical audit
    // reader; audit source tables are not executable backfill specs.
    | 'audit';

export interface AnalysisBackfillSourceRow {
    id: string;
    created_at: string;
    status: string;
}

interface BackfillRpcError {
    code?: string;
    message?: string;
}

interface BackfillQuery {
    select(columns: string): BackfillQuery;
    eq?(column: string, value: string): BackfillQuery;
    in?(column: string, values: readonly string[]): BackfillQuery;
    or?(expression: string): BackfillQuery;
    order(column: string, options: { ascending: boolean }): BackfillQuery;
    limit(limit: number): PromiseLike<{
        data: unknown;
        error: BackfillRpcError | null;
    }>;
}

type BackfillKeyType = 'text' | 'bigint' | 'integer' | 'smallint';

interface BackfillCursorColumn {
    column: string;
    keyType?: BackfillKeyType;
    keyMinimum?: string;
    keyMaximum?: string;
}

export interface AnalysisBackfillClient {
    from(table: string): BackfillQuery;
    rpc?(
        name: string,
        params: Record<string, unknown>,
    ): PromiseLike<{
        data: unknown;
        error: BackfillRpcError | null;
    }>;
}

export interface BackfillBatch {
    rows: readonly AnalysisBackfillSourceRow[];
    checksum: string;
}

export interface AnalysisBackfillParitySummary {
    status: 'match' | 'mismatch' | 'blocked';
    mismatchPaths: readonly string[];
}

export interface BackfillFamilyReport {
    source: { count: number; checksum: string | null; complete: boolean };
    canonical: { count: number; checksum: string | null; complete: boolean };
    parity: AnalysisBackfillParitySummary;
    logical: {
        sourceCount: number;
        canonicalCount: number;
        sourceChecksum: string | null;
        canonicalChecksum: string | null;
    };
    requiredFields: readonly string[];
    targetEvidence: {
        sourceCount: number;
        canonicalCount: number;
        sourceChecksum: string | null;
        canonicalChecksum: string | null;
        sourceInteractionCount: number;
        canonicalInteractionCount: number;
        sourceInteractionChecksum: string | null;
        canonicalInteractionChecksum: string | null;
    };
    apply?: BackfillApplyReport;
}

export interface BackfillApplyReport {
    attempted: number;
    applied: number;
    blocked: number;
    failed: number;
    blockedReasons: readonly string[];
}

export interface BackfillReport {
    status: 'report_only' | 'applied' | 'blocked';
    mode: 'report_only' | 'apply';
    scanned: number;
    complete: number;
    blocked: number;
    readBarrierBlocked: boolean;
    checksum: string | null;
    nextCursor: string | null;
    families: Readonly<Record<AnalysisCanonicalBackfillFamily, BackfillFamilyReport>>;
}

export interface BackfillCliArgs {
    limit: number;
    reportOnly: boolean;
    apply?: boolean;
    acknowledgement?: string;
    cursor?: string;
}

interface BackfillTableSpec {
    table: string;
    columns: string;
    timeColumn: string;
    keyColumn: string;
    /** PostgreSQL key type; numeric keys must never be compared as strings. */
    keyType?: BackfillKeyType;
    /** Schema-level bounds for numeric key columns, retained as decimal text. */
    keyMinimum?: string;
    keyMaximum?: string;
    /**
     * Ordered identity columns after request_id.  Composite primary keys must
     * be represented in full so a timestamp tie remains strictly resumable.
     */
    cursorColumns?: readonly BackfillCursorColumn[];
    /** Mutable source tables require a row-hash freshness fence before apply. */
    freshnessFence?: 'row_hash';
    /** Null means that this legacy table has no request-safe request identity. */
    requestIdColumn?: string | null;
}

export interface AnalysisCanonicalBackfillFamilySpec {
    family: AnalysisCanonicalBackfillFamily;
    legacyTables: readonly string[];
    legacy: readonly BackfillTableSpec[];
    canonicalTable: string;
    canonical: BackfillTableSpec;
    /** A destination retained for the canonical family map without an executable Wave 1 source. */
    deferred?: boolean;
}

/**
 * Metadata-only selections keep report-only backfill from reading usernames,
 * provider payloads, cookies, or payment material while still giving each
 * family a real row/field parity surface.
 */
export const ANALYSIS_CANONICAL_BACKFILL_FAMILIES: readonly AnalysisCanonicalBackfillFamilySpec[] = Object.freeze([
    {
        family: 'jobs',
        legacyTables: Object.freeze([
            'analysis_pipeline_jobs',
            'analysis_v2_dag_scopes',
            'analysis_v2_dag_stage_manifests',
            'analysis_v2_dag_batch_topology',
            'analysis_v2_dag_batch_results',
        ]),
        legacy: Object.freeze([
            {
                table: 'analysis_pipeline_jobs',
                columns: 'request_id, job_key, track, kind, batch, required_job_keys, status, dispatch_generation, attempt_count, lease_expires_at, completion_fanout_hash, created_at, updated_at',
                timeColumn: 'created_at',
                keyColumn: 'job_key',
                // Schema PK: (request_id, job_key).
                cursorColumns: Object.freeze([{ column: 'job_key' }]),
                freshnessFence: 'row_hash' as const,
            },
            {
                table: 'analysis_v2_dag_scopes',
                columns: 'request_id, created_at',
                timeColumn: 'created_at',
                keyColumn: 'request_id',
            },
            {
                table: 'analysis_v2_dag_stage_manifests',
                columns: 'request_id, stage_kind, created_at',
                timeColumn: 'created_at',
                keyColumn: 'stage_kind',
                // Schema PK: (request_id, stage_kind).
                cursorColumns: Object.freeze([{ column: 'stage_kind' }]),
            },
            {
                table: 'analysis_v2_dag_batch_topology',
                columns: 'request_id, topology_kind, batch, created_at',
                timeColumn: 'created_at',
                keyColumn: 'batch',
                keyType: 'integer' as const,
                keyMinimum: '0',
                keyMaximum: '100000',
                // Schema PK: (request_id, topology_kind, batch).
                cursorColumns: Object.freeze([
                    { column: 'topology_kind' },
                    {
                        column: 'batch',
                        keyType: 'integer' as const,
                        keyMinimum: '0',
                        keyMaximum: '100000',
                    },
                ]),
            },
            {
                table: 'analysis_v2_dag_batch_results',
                columns: 'request_id, result_kind, batch, created_at',
                timeColumn: 'created_at',
                keyColumn: 'batch',
                keyType: 'integer' as const,
                keyMinimum: '0',
                keyMaximum: '100000',
                // Schema PK: (request_id, result_kind, batch).
                cursorColumns: Object.freeze([
                    { column: 'result_kind' },
                    {
                        column: 'batch',
                        keyType: 'integer' as const,
                        keyMinimum: '0',
                        keyMaximum: '100000',
                    },
                ]),
            },
        ]),
        canonicalTable: 'analysis_jobs',
        canonical: {
            table: 'analysis_jobs',
            columns: 'id, request_id, job_key, kind, state, generation, attempt_count, dependency_count, next_attempt_at, lease_expires_at, completion_hash, payload, retention_class, created_at, updated_at',
            timeColumn: 'created_at',
            keyColumn: 'id',
        },
    },
    {
        family: 'events',
        legacyTables: Object.freeze(['analysis_progress_state', 'analysis_progress_events', 'analysis_step_events']),
        legacy: Object.freeze([
            {
                table: 'analysis_progress_state',
                columns: 'request_id, revision, status, created_at, updated_at',
                timeColumn: 'updated_at',
                keyColumn: 'request_id',
            },
            {
                table: 'analysis_progress_events',
                columns: 'request_id, seq, event_state, event_code, aggregate_count, occurred_at',
                timeColumn: 'occurred_at',
                keyColumn: 'seq',
                keyType: 'bigint' as const,
                keyMinimum: '1',
                keyMaximum: '9007199254740991',
                // Schema PK: (request_id, seq).
                cursorColumns: Object.freeze([{
                    column: 'seq',
                    keyType: 'bigint' as const,
                    keyMinimum: '1',
                    keyMaximum: '9007199254740991',
                }]),
            },
            {
                table: 'analysis_step_events',
                columns: 'id, request_id, step, event_type, progress, created_at',
                timeColumn: 'created_at',
                keyColumn: 'id',
            },
        ]),
        canonicalTable: 'analysis_events',
        canonical: {
            table: 'analysis_events',
            columns: 'id, request_id, job_id, kind, state, payload, content_hash, retention_class, created_at',
            timeColumn: 'created_at',
            keyColumn: 'id',
            keyType: 'bigint' as const,
        },
    },
    {
        family: 'artifacts',
        legacyTables: Object.freeze([
            'analysis_v2_relationship_sides',
            'analysis_v2_relationship_rows',
            'analysis_v2_relationship_manifests',
            'analysis_v2_target_evidence_manifests',
            'analysis_target_interactors',
            'analysis_v2_candidate_feature_manifests',
            'analysis_v2_candidate_feature_rows',
            'analysis_v2_candidate_score_manifests',
            'analysis_v2_candidate_score_rows',
            'analysis_v2_media_artifacts',
        ]),
        legacy: Object.freeze([
            {
                table: 'analysis_v2_relationship_sides',
                columns: 'request_id, job_key, side, provider_run_id, created_at',
                timeColumn: 'created_at',
                keyColumn: 'job_key',
                // Schema PK: (request_id, job_key, side).
                cursorColumns: Object.freeze([
                    { column: 'job_key' },
                    { column: 'side' },
                ]),
            },
            {
                table: 'analysis_v2_relationship_rows',
                columns: 'request_id, job_key, side, username, created_at',
                timeColumn: 'created_at',
                keyColumn: 'job_key',
                // Schema PK: (request_id, job_key, side, username).
                cursorColumns: Object.freeze([
                    { column: 'job_key' },
                    { column: 'side' },
                    { column: 'username' },
                ]),
            },
            {
                table: 'analysis_v2_relationship_manifests',
                columns: 'request_id, job_key, created_at',
                timeColumn: 'created_at',
                keyColumn: 'job_key',
            },
            {
                table: 'analysis_v2_target_evidence_manifests',
                columns: 'request_id, job_key, revision, input_hash, liker_source_hash, comment_source_hash, result_hash, interactor_count, liker_count, comment_count, frozen_at, created_at, updated_at',
                timeColumn: 'created_at',
                keyColumn: 'job_key',
            },
            {
                table: 'analysis_target_interactors',
                columns: 'request_id, job_key, ordinal, post_id, signal, source_interaction_id, occurred_at, created_at',
                timeColumn: 'created_at',
                keyColumn: 'ordinal',
                keyType: 'smallint' as const,
                keyMinimum: '1',
                keyMaximum: '690',
                // Schema PK: (request_id, job_key, signal, source_interaction_id).
                // Keep ordinal as keyColumn for the pre-PR source identity.
                cursorColumns: Object.freeze([
                    { column: 'job_key' },
                    { column: 'signal' },
                    { column: 'source_interaction_id' },
                ]),
            },
            {
                table: 'analysis_v2_candidate_feature_manifests',
                columns: 'request_id, batch, created_at',
                timeColumn: 'created_at',
                keyColumn: 'batch',
                keyType: 'integer' as const,
                keyMinimum: '0',
                keyMaximum: '100000',
            },
            {
                table: 'analysis_v2_candidate_feature_rows',
                columns: 'request_id, candidate_id, created_at',
                timeColumn: 'created_at',
                keyColumn: 'candidate_id',
            },
            {
                table: 'analysis_v2_candidate_score_manifests',
                columns: 'request_id, created_at',
                timeColumn: 'created_at',
                keyColumn: 'request_id',
            },
            {
                table: 'analysis_v2_candidate_score_rows',
                columns: 'request_id, candidate_id, created_at',
                timeColumn: 'created_at',
                keyColumn: 'candidate_id',
            },
            {
                table: 'analysis_v2_media_artifacts',
                columns: 'request_id, artifact_key, artifact_kind, content_sha256, expires_at, created_at, deleted_at',
                timeColumn: 'created_at',
                keyColumn: 'artifact_key',
                // Schema PK: (request_id, artifact_key).
                cursorColumns: Object.freeze([{ column: 'artifact_key' }]),
            },
        ]),
        canonicalTable: 'analysis_artifacts',
        canonical: {
            table: 'analysis_artifacts',
            columns: 'id, request_id, job_id, kind, artifact_key, state, content_hash, payload, retention_class, created_at, updated_at',
            timeColumn: 'created_at',
            keyColumn: 'id',
        },
    },
    {
        family: 'costs',
        legacyTables: Object.freeze([
            'analysis_v2_cost_attributions',
            'analysis_v2_cost_rollup_snapshots',
            'analysis_provider_cost_ledger',
        ]),
        legacy: Object.freeze([
            {
                table: 'analysis_v2_cost_attributions',
                columns: 'request_id, source_kind, source_operation_key, source_identity_hash, attributed_at, updated_at',
                timeColumn: 'attributed_at',
                keyColumn: 'source_operation_key',
                // Schema PK: (request_id, source_kind, source_operation_key).
                cursorColumns: Object.freeze([
                    { column: 'source_kind' },
                    { column: 'source_operation_key' },
                ]),
            },
            {
                table: 'analysis_v2_cost_rollup_snapshots',
                columns: 'request_id, rollup_version, created_at',
                timeColumn: 'created_at',
                keyColumn: 'rollup_version',
            },
            {
                table: 'analysis_provider_cost_ledger',
                // PostgREST may decode NUMERIC as a JavaScript number. Cast
                // money to text in the read itself so no precision is lost
                // before validation or RPC serialization.
                columns: 'request_id, run_id, logical_provider, operation_key, credential_slot, status, max_charge_usd::text, usage_total_usd::text, started_at, terminal_at, created_at, updated_at',
                timeColumn: 'created_at',
                keyColumn: 'run_id',
            },
        ]),
        canonicalTable: 'analysis_costs',
        canonical: {
            table: 'analysis_costs',
            // Keep canonical NUMERIC values textual on parity re-read too;
            // comparing a decoded Number would reintroduce rounding.
            columns: 'id, request_id, provider, operation_key, stage, currency, amount_known::text, amount_conservative::text, usage_unknown, source_hash, idempotency_key, payload, retention_class, recorded_at',
            timeColumn: 'recorded_at',
            keyColumn: 'id',
            keyType: 'bigint' as const,
        },
    },
    {
        family: 'cache',
        // Cache sources are explicitly outside Wave 1: they do not carry a
        // request-safe identity and must not be queried, even report-only.
        legacyTables: Object.freeze([]),
        legacy: Object.freeze([]),
        canonicalTable: 'analysis_cache',
        canonical: {
            table: 'analysis_cache',
            columns: 'id, request_id, scope, cache_key_hash, state, expires_at, single_flight_token_hash, payload, created_at, updated_at',
            timeColumn: 'updated_at',
            keyColumn: 'id',
        },
        deferred: true,
    },
    {
        family: 'audit',
        // Audit evidence belongs to its own blocked wave. Keep the family in
        // the report contract, but do not make either its legacy sources or
        // canonical destination executable here.
        legacyTables: Object.freeze([]),
        legacy: Object.freeze([]),
        canonicalTable: 'analysis_audit_bundles',
        canonical: {
            table: 'analysis_audit_bundles',
            columns: 'id, request_id, version, kind, candidate_key, ordinal, state, content_hash, idempotency_key, retention_class, payload, created_at',
            timeColumn: 'created_at',
            keyColumn: 'id',
        },
        deferred: true,
    },
]);

interface AnalysisBackfillCursorPosition {
    createdAt: string;
    requestId: string;
    key: string;
    rowHash: string;
}

interface BoundedBackfillPage {
    rows: readonly Record<string, unknown>[];
    next: AnalysisBackfillCursorPosition | null;
    hasMore: boolean;
}

interface BackfillLegacyPage {
    table: BackfillTableSpec;
    rows: readonly Record<string, unknown>[];
    priorPosition: AnalysisBackfillCursorPosition | null;
    limit: number;
    hasMore: boolean;
}

interface BackfillApplyMutation {
    sourceTable: string;
    sourceKey: string;
    sourceHash: string;
    requestId: string;
    row: Record<string, unknown>;
}

interface BackfillMappingResult {
    mutation?: BackfillApplyMutation;
    blockedReason?: string;
}

interface AppliedBackfillMutation {
    family: AnalysisCanonicalBackfillFamily;
    mutation: BackfillApplyMutation;
}

interface BackfillApplyBudget {
    attempted: number;
    readonly limit: number;
}

interface BackfillApplyRun {
    budget: BackfillApplyBudget;
    appliedMutations: AppliedBackfillMutation[];
    stopped: boolean;
    stopTableKey: string | null;
    stopPosition: AnalysisBackfillCursorPosition | null;
}

interface BackfillApplyFamilyResult {
    report: BackfillApplyReport;
    lastProcessedPosition: AnalysisBackfillCursorPosition | null;
    stopped: boolean;
}

const COMPOSITE_CURSOR_VERSION = 5;

interface AnalysisBackfillCursorV4 {
    version: 4;
    positions: Record<string, AnalysisBackfillCursorPosition>;
    requestIds: readonly string[];
    sourceHasMore: boolean;
    completed: readonly string[];
    familyEvidence: Readonly<Partial<Record<AnalysisCanonicalBackfillFamily, AnalysisBackfillParitySummary>>>;
}

interface AnalysisBackfillCursorV5 {
    version: typeof COMPOSITE_CURSOR_VERSION;
    positions: Record<string, AnalysisBackfillCursorPosition>;
    requestIds: readonly string[];
    sourceHasMore: boolean;
    completed: readonly string[];
    familyEvidence: Readonly<Partial<Record<AnalysisCanonicalBackfillFamily, AnalysisBackfillParitySummary>>>;
}

interface AnalysisBackfillCursorV1 {
    version: 1;
    id: string;
    createdAt: string;
    status: string;
    sourceHash: string;
}

type ParsedBackfillCursor = AnalysisBackfillCursorV1 | AnalysisBackfillCursorV4 | AnalysisBackfillCursorV5;

class IncompatibleBackfillCursorError extends Error {
    constructor() {
        super('Analysis canonical backfill cursor version 4 cannot resume composite pagination; restarting.');
        this.name = 'IncompatibleBackfillCursorError';
    }
}

function timestampMicros(value: string): bigint | null {
    const match = TIMESTAMP_PATTERN.exec(value);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const fraction = (match[7] ?? '').padEnd(6, '0');
    const zone = match[8]!;
    if (
        month < 1 || month > 12
        || day < 1
        || hour > 23
        || minute > 59
        || second > 59
    ) return null;
    const daysInMonth = new Date(0);
    daysInMonth.setUTCFullYear(year, month, 0);
    const lastDay = daysInMonth.getUTCDate();
    if (day > lastDay) return null;
    const local = new Date(0);
    local.setUTCFullYear(year, month - 1, day);
    local.setUTCHours(hour, minute, second, 0);
    if (
        local.getUTCFullYear() !== year
        || local.getUTCMonth() !== month - 1
        || local.getUTCDate() !== day
        || local.getUTCHours() !== hour
        || local.getUTCMinutes() !== minute
        || local.getUTCSeconds() !== second
    ) return null;
    let offsetMinutes = 0;
    if (zone !== 'Z') {
        const offsetHours = Number(zone.slice(1, 3));
        const offsetMinutesPart = Number(zone.slice(4, 6));
        if (offsetHours > 23 || offsetMinutesPart > 59) return null;
        offsetMinutes = (zone[0] === '+' ? 1 : -1)
            * (offsetHours * 60 + offsetMinutesPart);
    }
    return BigInt(local.getTime()) * BigInt(1_000)
        + BigInt(fraction)
        - BigInt(offsetMinutes) * MICROSECONDS_PER_MINUTE;
}

function normalizePgTimestamp(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const micros = timestampMicros(value);
    if (micros === null) return null;
    let epochSeconds = micros / MICROSECONDS_PER_SECOND;
    let fraction = micros % MICROSECONDS_PER_SECOND;
    if (fraction < 0) {
        epochSeconds -= BigInt(1);
        fraction += MICROSECONDS_PER_SECOND;
    }
    const date = new Date(Number(epochSeconds) * 1_000);
    const year = date.getUTCFullYear();
    if (year < 0 || year > 9_999) return null;
    const pad = (part: number, width: number): string => String(part).padStart(width, '0');
    return `${pad(year, 4)}-${pad(date.getUTCMonth() + 1, 2)}-${pad(date.getUTCDate(), 2)}T`
        + `${pad(date.getUTCHours(), 2)}:${pad(date.getUTCMinutes(), 2)}:${pad(date.getUTCSeconds(), 2)}.`
        + `${pad(Number(fraction), 6)}Z`;
}

function comparePgTimestamps(left: unknown, right: unknown): number | null {
    const normalizedLeft = normalizePgTimestamp(left);
    const normalizedRight = normalizePgTimestamp(right);
    if (normalizedLeft === null || normalizedRight === null) return null;
    return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0;
}

function isSourceRow(value: unknown): value is AnalysisBackfillSourceRow {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return typeof row.id === 'string'
        && UUID_PATTERN.test(row.id)
        && typeof row.created_at === 'string'
        && row.created_at.length > 0
        && row.created_at.length <= 128
        && normalizePgTimestamp(row.created_at) !== null
        && typeof row.status === 'string'
        && row.status.length > 0
        && row.status.length <= 64;
}

function isSafeTimestamp(value: unknown): value is string {
    return normalizePgTimestamp(value) !== null;
}

function stableValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value as Record<string, unknown>).sort().map(key => [
                key,
                stableValue((value as Record<string, unknown>)[key]),
            ])
        );
    }
    return value;
}

function stableHash(value: unknown): string {
    return createHash('sha256')
        .update('analysis-canonical-backfill:v1\0', 'utf8')
        .update(JSON.stringify(stableValue(value)), 'utf8')
        .digest('hex');
}

export function sourceBackfillIdempotency(row: AnalysisBackfillSourceRow): Readonly<{
    sourceTable: typeof SOURCE_TABLE;
    sourcePk: string;
    sourceHash: string;
}> {
    return Object.freeze({
        sourceTable: SOURCE_TABLE,
        sourcePk: row.id,
        sourceHash: stableHash(row),
    });
}

export function encodeBackfillCursor(row: AnalysisBackfillSourceRow): string {
    if (!isSourceRow(row)) {
        throw new Error('Analysis canonical backfill cursor row is invalid.');
    }
    const cursor: AnalysisBackfillCursorV1 = {
        version: 1,
        id: row.id,
        createdAt: row.created_at,
        status: row.status,
        sourceHash: stableHash(sourceBackfillIdempotency(row)),
    };
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

const BACKFILL_PARITY_PATHS = new Set([
    'row.count',
    'row.order',
    'row.fields',
    'source.missing',
    'canonical.missing',
    'source.evidence',
    'canonical.evidence',
    'logical.row.count',
    'logical.row.identity',
    'logical.row.fields',
]);

function isKnownBackfillFamily(value: string): value is AnalysisCanonicalBackfillFamily {
    return ANALYSIS_CANONICAL_BACKFILL_FAMILIES.some(spec => spec.family === value);
}

function parseFamilyEvidence(value: unknown): Readonly<Partial<Record<AnalysisCanonicalBackfillFamily, AnalysisBackfillParitySummary>>> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > ANALYSIS_CANONICAL_BACKFILL_FAMILIES.length) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const evidence: Partial<Record<AnalysisCanonicalBackfillFamily, AnalysisBackfillParitySummary>> = {};
    for (const [family, raw] of entries) {
        if (!isKnownBackfillFamily(family) || !raw || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        const record = raw as Record<string, unknown>;
        if (
            Object.keys(record).length !== 2
            || (record.status !== 'mismatch' && record.status !== 'blocked')
            || !Array.isArray(record.mismatchPaths)
            || record.mismatchPaths.length < 1
            || record.mismatchPaths.length > BACKFILL_PARITY_PATHS.size
            || record.mismatchPaths.some(path => (
                typeof path !== 'string' || !BACKFILL_PARITY_PATHS.has(path)
            ))
            || new Set(record.mismatchPaths).size !== record.mismatchPaths.length
        ) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        evidence[family] = {
            status: record.status as Exclude<AnalysisBackfillParitySummary['status'], 'match'>,
            mismatchPaths: Object.freeze([...(record.mismatchPaths as string[])]),
        };
    }
    return Object.freeze(evidence);
}

function parseBackfillCursor(value: string): ParsedBackfillCursor {
    if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    } catch {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const row = parsed as Record<string, unknown>;
    if (row.version === 1) {
        if (
            Object.keys(row).length !== 5
            ||
            typeof row.id !== 'string'
            || typeof row.createdAt !== 'string'
            || typeof row.status !== 'string'
            || typeof row.sourceHash !== 'string'
            || !UUID_PATTERN.test(row.id)
            || !isSafeTimestamp(row.createdAt)
            || row.status.length < 1
            || row.status.length > 64
            || !/^[a-f0-9]{64}$/.test(row.sourceHash)
        ) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        const sourceRow: AnalysisBackfillSourceRow = {
            id: row.id,
            // v1 hashes the source row exactly as it was encoded.  Keep that
            // legacy hash input byte-for-byte stable; v4 positions normalize
            // timestamps for six-digit keyset ordering.
            created_at: row.createdAt,
            status: row.status,
        };
        if (stableHash(sourceBackfillIdempotency(sourceRow)) !== row.sourceHash) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        return {
            version: 1,
            id: row.id,
            createdAt: row.createdAt,
            status: row.status,
            sourceHash: row.sourceHash,
        };
    }
    const cursorVersion = row.version === 4 || row.version === COMPOSITE_CURSOR_VERSION
        ? row.version
        : null;
    if (
        cursorVersion === null
        || !row.positions
        || typeof row.positions !== 'object'
        || Array.isArray(row.positions)
        || (row.requestIds !== undefined && (!Array.isArray(row.requestIds) || row.requestIds.length > BACKFILL_MAX_LIMIT))
        || (row.sourceHasMore !== undefined && typeof row.sourceHasMore !== 'boolean')
        || (row.completed !== undefined && (!Array.isArray(row.completed) || row.completed.length > 512))
        || !Object.prototype.hasOwnProperty.call(row, 'familyEvidence')
        || Object.keys(row).some(key => !['version', 'positions', 'requestIds', 'sourceHasMore', 'completed', 'familyEvidence'].includes(key))
    ) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const requestIds = (Array.isArray(row.requestIds) ? row.requestIds : []) as unknown[];
    if (
        requestIds.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id))
        || new Set(requestIds).size !== requestIds.length
    ) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const completed = (Array.isArray(row.completed) ? row.completed : []) as unknown[];
    if (
        completed.some(table => (
            typeof table !== 'string'
            || table.length < 1
            || table.length > 256
            || !isKnownBackfillPositionKey(table)
        ))
        || new Set(completed).size !== completed.length
    ) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const positions: Record<string, AnalysisBackfillCursorPosition> = {};
    let incompatibleComposite = false;
    for (const [table, value] of Object.entries(row.positions as Record<string, unknown>)) {
        if (table.length < 1 || table.length > 256 || !isKnownBackfillPositionKey(table)) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        const position = value as Record<string, unknown>;
        const positionSpec = tableSpecForPositionKey(table);
        if (
            Object.keys(position).length !== 4
            ||
            !isSafeTimestamp(position.createdAt)
            || typeof position.requestId !== 'string'
            || (position.requestId !== '' && !UUID_PATTERN.test(position.requestId))
            || typeof position.key !== 'string'
            || typeof position.rowHash !== 'string'
            || !/^[a-f0-9]{64}$/.test(position.rowHash)
            || !positionSpec
        ) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        const sourcePosition = table === `${SOURCE_TABLE}:created_at:id`;
        const compositeCursor = cursorColumns(positionSpec).length > 1;
        const normalizedKey = cursorVersion === 4 && compositeCursor
            ? canonicalCursorKey(position.key, positionSpec)
                ?? canonicalCursorKey(position.key, { ...positionSpec, cursorColumns: undefined })
            : canonicalCursorKey(position.key, positionSpec);
        if (
            (position.requestId === '') !== sourcePosition
            || normalizedKey === null
            || (sourcePosition && !UUID_PATTERN.test(normalizedKey))
        ) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        incompatibleComposite ||= cursorVersion === 4 && compositeCursor;
        positions[table] = {
            createdAt: normalizePgTimestamp(position.createdAt)!,
            requestId: position.requestId,
            key: normalizedKey,
            rowHash: position.rowHash,
        };
    }
    if (row.sourceHasMore === true && !positions[`${SOURCE_TABLE}:created_at:id`]) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const familyEvidence = parseFamilyEvidence(row.familyEvidence);
    if (incompatibleComposite) throw new IncompatibleBackfillCursorError();
    const cursorState = {
        positions,
        requestIds: Object.freeze([...(requestIds as string[])]),
        sourceHasMore: row.sourceHasMore ?? false,
        completed: Object.freeze([...(completed as string[])]),
        familyEvidence,
    };
    return cursorVersion === 4
        ? { version: 4, ...cursorState }
        : { version: COMPOSITE_CURSOR_VERSION, ...cursorState };
}

function isKnownBackfillPositionKey(value: string): boolean {
    if (value === `${SOURCE_TABLE}:created_at:id`) return true;
    return ANALYSIS_CANONICAL_BACKFILL_FAMILIES.some(spec => (
        [...spec.legacy, spec.canonical].some(table => tablePositionKey(table) === value)
    ));
}

function compareRows(left: AnalysisBackfillSourceRow, right: AnalysisBackfillSourceRow): number {
    const created = (normalizePgTimestamp(left.created_at) ?? left.created_at)
        .localeCompare(normalizePgTimestamp(right.created_at) ?? right.created_at);
    if (created !== 0) return created;
    return left.id.localeCompare(right.id);
}

export function buildBackfillBatch(
    rows: readonly AnalysisBackfillSourceRow[],
    limit: number,
): BackfillBatch {
    if (!Number.isSafeInteger(limit) || limit < 1) {
        throw new Error('Analysis canonical backfill limit must be a positive integer.');
    }
    if (limit > BACKFILL_MAX_LIMIT) {
        throw new Error(`Analysis canonical backfill hard maximum is ${BACKFILL_MAX_LIMIT}.`);
    }
    const batch = [...rows].sort(compareRows).slice(0, limit);
    return {
        rows: batch,
        checksum: stableHash(batch.map(sourceBackfillIdempotency)),
    };
}

export function compareBackfillFamilyRows(
    sourceRows: readonly unknown[],
    canonicalRows: readonly unknown[],
): AnalysisBackfillParitySummary {
    if (sourceRows.length !== canonicalRows.length) {
        return { status: 'mismatch', mismatchPaths: ['row.count'] };
    }
    const sourceValues = sourceRows.map(stableValue);
    const canonicalValues = canonicalRows.map(stableValue);
    if (stableHash(sourceValues) === stableHash(canonicalValues)) {
        return { status: 'match', mismatchPaths: [] };
    }
    const sourceSorted = sourceValues.map(value => JSON.stringify(value)).sort();
    const canonicalSorted = canonicalValues.map(value => JSON.stringify(value)).sort();
    if (JSON.stringify(sourceSorted) === JSON.stringify(canonicalSorted)) {
        return { status: 'mismatch', mismatchPaths: ['row.order'] };
    }
    return { status: 'mismatch', mismatchPaths: ['row.fields'] };
}

/**
 * A single family has many physical source tables.  Raw row hashes therefore
 * cannot establish parity: a relationship manifest and a canonical artifact
 * are different physical records for the same logical evidence.  Normalize
 * both sides to this bounded, PII-free logical record before comparing them.
 */
export interface AnalysisBackfillLogicalRow {
    schemaVersion: 1;
    requestId: string;
    logicalKey: string;
    state: string | null;
    counts: Readonly<{
        declared: number | null;
        collected: number | null;
    }>;
    candidate: Readonly<{
        key: string | null;
        ordinal: number | null;
        rank: number | null;
        score: number | null;
        inclusionState: string | null;
        contentHash: string | null;
    }> | null;
    interaction: Readonly<{
        key: string | null;
        signal: string | null;
        occurredAt: string | null;
        evidenceId: string | null;
        contentHash: string | null;
    }> | null;
    order: Readonly<{
        ordinal: number | null;
        key: string | null;
        rank: number | null;
    }> | null;
    retention: string | null;
    cost: Readonly<{
        amountKnown: string | null;
        amountConservative: string | null;
        usageUnknown: boolean | null;
        sourceHash: string | null;
    }> | null;
    evidence: Readonly<{
        targetManifest: boolean;
        inputHash: string | null;
        likerSourceHash: string | null;
        commentSourceHash: string | null;
        resultHash: string | null;
        sourceHash: string | null;
        interactorCount: number | null;
        likerCount: number | null;
        commentCount: number | null;
        retention: string | null;
        targetInteractions: readonly Readonly<{
            key: string;
            signal: string;
            occurredAt: string | null;
            evidenceId: string;
        }>[];
    }>;
}

const SYNTHETIC_EVIDENCE_KEYS = new Set([
    'synthetic', 'placeholder', 'partialEvidence', 'partial_evidence',
    'sourceSensitive', 'source_sensitive', 'rawProviderPayload', 'raw_provider_payload',
    'targetUsername', 'target_username', 'likerSource', 'liker_source',
    'commentSource', 'comment_source',
]);
const SYNTHETIC_EVIDENCE_KEYS_LOWER = new Set(
    [...SYNTHETIC_EVIDENCE_KEYS].map(key => key.toLowerCase()),
);

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textField(row: Record<string, unknown>, ...keys: string[]): string | null {
    for (const key of keys) {
        const value = row[key];
        if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
}

function hasSyntheticEvidence(value: unknown): boolean {
    if (Array.isArray(value)) return value.some(hasSyntheticEvidence);
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value as Record<string, unknown>).some(([key, child]) => (
        SYNTHETIC_EVIDENCE_KEYS.has(key)
        || SYNTHETIC_EVIDENCE_KEYS_LOWER.has(key.toLowerCase())
        || hasSyntheticEvidence(child)
    ));
}

function keyField(row: Record<string, unknown>, ...keys: string[]): string | null {
    for (const key of keys) {
        const value = row[key];
        if (typeof value === 'string' && value.length > 0) return value;
        if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    }
    return null;
}

function nestedRecord(row: Record<string, unknown>, key: string): Record<string, unknown> {
    return isRecord(row[key]) ? row[key] : {};
}

function fieldValue(row: Record<string, unknown>, payload: Record<string, unknown>, ...keys: string[]): unknown {
    for (const key of keys) {
        if (row[key] !== undefined) return row[key];
        if (payload[key] !== undefined) return payload[key];
    }
    return undefined;
}

function numericFieldFrom(
    row: Record<string, unknown>,
    payload: Record<string, unknown>,
    ...keys: string[]
): number | null {
    const value = fieldValue(row, payload, ...keys);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
}

function canonicalMoneyString(value: unknown): string | null {
    if (typeof value !== 'string' || !MONEY_PATTERN.test(value)) return null;
    const [whole, fraction = ''] = value.split('.');
    const normalizedFraction = fraction.replace(/0+$/, '');
    return `${whole}${normalizedFraction ? `.${normalizedFraction}` : ''}`;
}

function moneyFieldFrom(
    row: Record<string, unknown>,
    payload: Record<string, unknown>,
    ...keys: string[]
): string | null {
    return canonicalMoneyString(fieldValue(row, payload, ...keys));
}

function textFieldFrom(
    row: Record<string, unknown>,
    payload: Record<string, unknown>,
    ...keys: string[]
): string | null {
    const value = fieldValue(row, payload, ...keys);
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function normalizedCount(value: number | null): number | null {
    return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function targetInteractionRows(value: unknown): readonly Readonly<{
    key: string;
    signal: string;
    occurredAt: string | null;
    evidenceId: string;
}>[] | null {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value) || value.length > BACKFILL_MAX_LIMIT) return null;
    const rows: Array<Readonly<{
        key: string;
        signal: string;
        occurredAt: string | null;
        evidenceId: string;
    }>> = [];
    for (const candidate of value) {
        if (!isRecord(candidate)) return null;
        const key = keyField(candidate, 'key', 'interactionKey', 'interaction_key', 'source_interaction_id', 'id');
        const signal = textField(candidate, 'signal', 'eventCode', 'event_code', 'eventType');
        const rawOccurredAt = textField(candidate, 'occurredAt', 'occurred_at', 'created_at');
        const evidenceId = textField(candidate, 'evidenceId', 'evidence_id', 'source_interaction_id', 'content_hash');
        const occurredAt = rawOccurredAt === null ? null : normalizePgTimestamp(rawOccurredAt);
        if (
            !key
            || (signal !== 'target_post_like' && signal !== 'target_post_comment')
            || (rawOccurredAt !== null && occurredAt === null)
            || !evidenceId
        ) return null;
        rows.push(Object.freeze({
            key,
            signal,
            occurredAt,
            evidenceId,
        }));
    }
    return Object.freeze(rows);
}

function normalizeBackfillRow(
    family: AnalysisCanonicalBackfillFamily,
    row: Record<string, unknown>,
    selectedRequestIds: ReadonlySet<string>,
): AnalysisBackfillLogicalRow | null {
    const requestId = textField(row, 'request_id', 'requestId');
    if (!requestId || !UUID_PATTERN.test(requestId) || !selectedRequestIds.has(requestId)) return null;
    if (hasSyntheticEvidence(row)) return null;
    const payload = nestedRecord(row, 'payload');
    const targetManifest = Object.keys(nestedRecord(row, 'targetManifest')).length > 0
        ? nestedRecord(row, 'targetManifest')
        : nestedRecord(payload, 'targetManifest');
    const candidatePayload = Object.keys(nestedRecord(row, 'candidate')).length > 0
        ? nestedRecord(row, 'candidate') : nestedRecord(payload, 'candidate');
    const interactionPayload = Object.keys(nestedRecord(row, 'interaction')).length > 0
        ? nestedRecord(row, 'interaction') : nestedRecord(payload, 'interaction');
    const orderPayload = Object.keys(nestedRecord(row, 'order')).length > 0
        ? nestedRecord(row, 'order') : nestedRecord(payload, 'order');
    const logicalKey = keyField(
        row,
        'logicalKey', 'logical_key', 'source_interaction_id', 'candidate_id', 'candidate_key',
        'artifact_key', 'operation_key', 'source_operation_key', 'job_key', 'version', 'id', 'request_id',
    );
    if (!logicalKey) return null;
    const declared = numericFieldFrom(
        row, payload, 'declared_count', 'declared', 'interactor_count', 'aggregate_count',
        'candidate_declared', 'interaction_declared', 'usage_declared',
    );
    const collected = numericFieldFrom(
        row, payload, 'collected_count', 'collected', 'liker_count', 'comment_count',
        'candidate_collected', 'interaction_collected', 'aggregate_count',
    );
    const candidateKey = keyField(row, 'candidate_id', 'candidate_key')
        ?? keyField(candidatePayload, 'key', 'candidateId', 'candidate_id', 'candidateKey');
    const interactionKey = keyField(row, 'source_interaction_id', 'interaction_key')
        ?? keyField(interactionPayload, 'key', 'interactionKey', 'interaction_key', 'id');
    const sourceHash = textFieldFrom(row, payload, 'source_hash', 'source_identity_hash');
    const rawOccurredAt = textFieldFrom(
        row,
        interactionPayload,
        'occurred_at', 'occurredAt', 'created_at', 'recorded_at',
    );
    const occurredAt = rawOccurredAt === null ? null : normalizePgTimestamp(rawOccurredAt);
    if (rawOccurredAt !== null && occurredAt === null) return null;
    const interactionSignal = textFieldFrom(
        row,
        interactionPayload,
        'signal', 'event_code', 'eventCode', 'event_type', 'eventType',
    );
    const interactionContentHash = textFieldFrom(
        row,
        interactionPayload,
        'content_hash', 'contentHash', 'result_hash', 'resultHash',
    );
    const candidateOrdinal = numericFieldFrom(
        row,
        candidatePayload,
        'ordinal', 'final_rank', 'featured_rank', 'sort_ordinal',
    );
    const candidateScore = numericFieldFrom(
        row,
        candidatePayload,
        'final_score', 'display_score', 'public_score', 'raw_score', 'score',
    );
    const candidateRank = numericFieldFrom(
        row,
        candidatePayload,
        'rank', 'final_rank', 'featured_rank', 'sort_ordinal', 'ordinal',
    );
    const candidateContentHash = textFieldFrom(
        row,
        candidatePayload,
        'content_hash', 'contentHash', 'result_hash', 'resultHash',
    );
    const inclusionState = textFieldFrom(
        row,
        candidatePayload,
        'final_inclusion_state', 'inclusionState', 'state',
    );
    const targetSource = Object.keys(nestedRecord(row, 'targetEvidence')).length > 0
        ? nestedRecord(row, 'targetEvidence') : nestedRecord(payload, 'targetEvidence');
    const targetManifestValue = family === 'artifacts' && (
        Object.keys(targetManifest).length > 0
        || row.input_hash !== undefined
        || row.liker_source_hash !== undefined
        || row.comment_source_hash !== undefined
        || row.interactor_count !== undefined
    );
    const targetResultHash = textFieldFrom(
        row,
        targetManifest,
        'result_hash', 'resultHash', 'content_hash', 'bundle_hash',
    );
    const targetInputHash = textFieldFrom(row, targetManifest, 'input_hash', 'inputHash');
    const targetLikerSourceHash = textFieldFrom(
        row,
        targetManifest,
        'liker_source_hash', 'likerSourceHash',
    );
    const targetCommentSourceHash = textFieldFrom(
        row,
        targetManifest,
        'comment_source_hash', 'commentSourceHash',
    );
    const targetRetention = textFieldFrom(row, targetManifest, 'retention_class', 'retention');
    const directTargetInteraction = (
        (row.signal === 'target_post_like' || row.signal === 'target_post_comment')
        && row.source_interaction_id !== undefined
    ) ? [row] : undefined;
    const targetInteractions = targetInteractionRows(
        row.targetInteractions
            ?? payload.targetInteractions
            ?? targetManifest.targetInteractions
            ?? directTargetInteraction,
    );
    if (targetInteractions === null) return null;
    if (targetManifestValue) {
        const targetInteractors = normalizedCount(numericFieldFrom(
            row,
            targetSource,
            'interactor_count', 'interactorCount',
        ) ?? numericFieldFrom(row, targetManifest, 'interactor_count', 'interactorCount'));
        const targetLikers = normalizedCount(numericFieldFrom(
            row,
            targetSource,
            'liker_count', 'likerCount',
        ) ?? numericFieldFrom(row, targetManifest, 'liker_count', 'likerCount'));
        const targetComments = normalizedCount(numericFieldFrom(
            row,
            targetSource,
            'comment_count', 'commentCount',
        ) ?? numericFieldFrom(row, targetManifest, 'comment_count', 'commentCount'));
        if (
            targetInputHash === null
            || targetLikerSourceHash === null
            || targetCommentSourceHash === null
            || targetResultHash === null
            || !HASH_PATTERN.test(targetInputHash)
            || !HASH_PATTERN.test(targetLikerSourceHash)
            || !HASH_PATTERN.test(targetCommentSourceHash)
            || !HASH_PATTERN.test(targetResultHash)
            || targetInteractors === null
            || targetLikers === null
            || targetComments === null
        ) return null;
    }
    return {
        schemaVersion: 1,
        requestId,
        logicalKey,
        state: textFieldFrom(
            row,
            payload,
            'state', 'status', 'event_state', 'completeness_status', 'final_inclusion_state',
        ),
        counts: { declared: normalizedCount(declared), collected: normalizedCount(collected) },
        candidate: candidateKey || family === 'audit'
            ? {
                key: candidateKey,
                ordinal: candidateOrdinal,
                rank: candidateRank,
                score: candidateScore,
                inclusionState,
                contentHash: candidateContentHash,
            }
            : null,
        interaction: interactionKey || family === 'events'
            ? {
                key: interactionKey ?? `${logicalKey}:${occurredAt ?? 'unknown'}`,
                signal: interactionSignal,
                occurredAt,
                evidenceId: textFieldFrom(row, interactionPayload, 'source_interaction_id', 'evidenceId', 'content_hash'),
                contentHash: interactionContentHash,
            }
            : null,
        order: family === 'audit' || row.ordinal !== undefined || row.version !== undefined
            ? {
                ordinal: numericFieldFrom(row, orderPayload, 'ordinal', 'final_rank', 'featured_rank', 'sort_ordinal'),
                key: keyField(row, 'candidate_id', 'candidate_key')
                    ?? keyField(orderPayload, 'key', 'candidateKey', 'candidate_id')
                    ?? logicalKey,
                rank: numericFieldFrom(
                    row,
                    orderPayload,
                    'rank', 'final_rank', 'featured_rank', 'sort_ordinal', 'ordinal',
                ),
            }
            : null,
        retention: textFieldFrom(row, payload, 'retention_class', 'retention')
            ?? (targetManifestValue ? targetRetention : null),
        cost: family === 'costs' || row.amount_known !== undefined || row.usage_unknown !== undefined
            ? {
                amountKnown: moneyFieldFrom(row, payload, 'amount_known', 'cost_known_usd', 'usage_total_usd', 'amountKnown'),
                amountConservative: moneyFieldFrom(row, payload, 'amount_conservative', 'cost_conservative_usd', 'amountConservative'),
                usageUnknown: typeof row.usage_unknown === 'boolean' ? row.usage_unknown : null,
                sourceHash,
            }
            : null,
        evidence: {
            targetManifest: targetManifestValue,
            inputHash: targetManifestValue ? targetInputHash : textFieldFrom(row, payload, 'input_hash', 'inputHash'),
            likerSourceHash: targetManifestValue
                ? targetLikerSourceHash : textFieldFrom(row, payload, 'liker_source_hash', 'likerSourceHash'),
            commentSourceHash: targetManifestValue
                ? targetCommentSourceHash : textFieldFrom(row, payload, 'comment_source_hash', 'commentSourceHash'),
            resultHash: targetManifestValue ? targetResultHash : textFieldFrom(row, payload, 'result_hash', 'content_hash', 'bundle_hash'),
            sourceHash,
            interactorCount: normalizedCount(numericFieldFrom(
                row,
                targetSource,
                'interactor_count', 'interactorCount',
            ) ?? numericFieldFrom(row, targetManifest, 'interactor_count', 'interactorCount')),
            likerCount: normalizedCount(numericFieldFrom(
                row,
                targetSource,
                'liker_count', 'likerCount',
            ) ?? numericFieldFrom(row, targetManifest, 'liker_count', 'likerCount')),
            commentCount: normalizedCount(numericFieldFrom(
                row,
                targetSource,
                'comment_count', 'commentCount',
            ) ?? numericFieldFrom(row, targetManifest, 'comment_count', 'commentCount')),
            retention: targetRetention,
            targetInteractions,
        },
    };
}

export function normalizeBackfillFamilyRows(
    family: AnalysisCanonicalBackfillFamily,
    rows: readonly Record<string, unknown>[],
    selectedRequestIds: readonly string[],
): readonly AnalysisBackfillLogicalRow[] {
    if (selectedRequestIds.length > BACKFILL_MAX_LIMIT
        || selectedRequestIds.some(id => !UUID_PATTERN.test(id))) {
        return Object.freeze([]);
    }
    const selected = new Set(selectedRequestIds);
    const normalized: AnalysisBackfillLogicalRow[] = [];
    for (const row of rows) {
        const value = normalizeBackfillRow(family, row, selected);
        if (!value) return Object.freeze([]);
        normalized.push(value);
    }
    const sorted = normalized.sort((left, right) => (
        left.requestId.localeCompare(right.requestId)
        || left.logicalKey.localeCompare(right.logicalKey)
    ));
    for (let index = 1; index < sorted.length; index += 1) {
        const previous = sorted[index - 1]!;
        const current = sorted[index]!;
        if (previous.requestId === current.requestId && previous.logicalKey === current.logicalKey) {
            return Object.freeze([]);
        }
    }
    return Object.freeze(sorted);
}

export function compareNormalizedBackfillFamilyRows(
    family: AnalysisCanonicalBackfillFamily,
    sourceRows: readonly Record<string, unknown>[],
    canonicalRows: readonly Record<string, unknown>[],
    selectedRequestIds: readonly string[],
): AnalysisBackfillParitySummary {
    const source = normalizeBackfillFamilyRows(family, sourceRows, selectedRequestIds);
    const canonical = normalizeBackfillFamilyRows(family, canonicalRows, selectedRequestIds);
    if (sourceRows.length > 0 && source.length === 0) {
        return { status: 'blocked', mismatchPaths: ['source.evidence'] };
    }
    if (canonicalRows.length > 0 && canonical.length === 0) {
        return { status: 'blocked', mismatchPaths: ['canonical.evidence'] };
    }
    if (source.length !== canonical.length) {
        return { status: 'mismatch', mismatchPaths: ['logical.row.count'] };
    }
    if (stableHash(source) === stableHash(canonical)) {
        return { status: 'match', mismatchPaths: [] };
    }
    const sourceKeys = source.map(row => `${row.requestId}:${row.logicalKey}`);
    const canonicalKeys = canonical.map(row => `${row.requestId}:${row.logicalKey}`);
    if (JSON.stringify(sourceKeys) !== JSON.stringify(canonicalKeys)) {
        return { status: 'mismatch', mismatchPaths: ['logical.row.identity'] };
    }
    return { status: 'mismatch', mismatchPaths: ['logical.row.fields'] };
}

const APPLY_COPY_CODE = 'ANALYSIS_CANONICAL_BACKFILL_V1';
const APPLY_RETENTION_CLASS = 'standard';
const APPLY_JOB_KINDS = new Set(['coordinator', 'collection', 'ai', 'finalize', 'recovery']);
const APPLY_JOB_STATES: Readonly<Record<string, string>> = Object.freeze({
    pending: 'queued',
    processing: 'running',
    completed: 'succeeded',
    failed: 'failed',
});
const APPLY_ARTIFACT_KINDS: Readonly<Record<string, 'evidence' | 'manifest' | 'media_ref'>> = Object.freeze({
    analysis_v2_relationship_sides: 'evidence',
    analysis_v2_relationship_manifests: 'manifest',
    analysis_v2_target_evidence_manifests: 'manifest',
    analysis_v2_candidate_feature_manifests: 'manifest',
    analysis_v2_candidate_score_manifests: 'manifest',
    analysis_v2_media_artifacts: 'media_ref',
});

function boundedApplyString(value: unknown, max = 512): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function applyInteger(
    row: Record<string, unknown>,
    key: string,
    min: number,
    max: number,
): number | null {
    const value = row[key];
    const numeric = typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim() !== ''
            ? Number(value)
            : null;
    return numeric !== null
        && Number.isSafeInteger(numeric)
        && numeric >= min
        && numeric <= max
        ? numeric
        : null;
}

function applyCanonicalMoney(
    row: Record<string, unknown>,
    key: string,
): string | null {
    const value = row[key];
    if (value === null || value === undefined) return null;
    // analysis_costs is NUMERIC(18,12).  Only an exact decimal string may cross
    // the RPC boundary; a JavaScript number has already lost information and
    // must be rejected instead of being rounded or re-stringified.
    return canonicalMoneyString(value);
}

function sourceEnvelope(sourceTable: string, row: Record<string, unknown>): string | null {
    // request_id and physical UUID ids already have dedicated canonical or
    // idempotency fields.  Do not duplicate them into JSON payloads.
    const fields = Object.fromEntries(
        Object.entries(row).filter(([key]) => !['request_id', 'requestId', 'id'].includes(key)),
    );
    const value = JSON.stringify(stableValue({ sourceTable, fields }));
    return value.length <= 8_192 ? value : null;
}

function applySourceIdentity(
    table: BackfillTableSpec,
    row: Record<string, unknown>,
): { requestId: string; sourceKey: string; sourceHash: string; envelope: string } | null {
    const position = rowCursorPosition(row, table);
    const sourceKey = sourceIdentityKey(row, table);
    if (!position || !position.requestId || !sourceKey) return null;
    const envelope = sourceEnvelope(table.table, row);
    if (!envelope) return null;
    return {
        requestId: position.requestId,
        sourceKey,
        sourceHash: stableHash({ sourceTable: table.table, sourceKey, row }),
        envelope,
    };
}

function mutation(
    table: BackfillTableSpec,
    row: Record<string, unknown>,
    canonicalRow: Record<string, unknown>,
): BackfillMappingResult {
    const identity = applySourceIdentity(table, row);
    if (!identity) return { blockedReason: 'required_identity_or_bounded_payload' };
    return {
        mutation: {
            sourceTable: table.table,
            sourceKey: identity.sourceKey,
            sourceHash: identity.sourceHash,
            requestId: identity.requestId,
            row: canonicalRow,
        },
    };
}

function mapJobRow(table: BackfillTableSpec, row: Record<string, unknown>): BackfillMappingResult {
    if (table.table !== 'analysis_pipeline_jobs') {
        return { blockedReason: 'jobs_source_state_not_proven' };
    }
    if (hasSyntheticEvidence(row)) return { blockedReason: 'synthetic_or_sensitive_evidence' };
    const jobKey = row.job_key;
    const kind = row.kind;
    const status = row.status;
    if (!boundedApplyString(jobKey, 160) || !JOB_KEY_PATTERN.test(jobKey)) {
        return { blockedReason: 'jobs_required_key_invalid' };
    }
    if (typeof kind !== 'string' || !APPLY_JOB_KINDS.has(kind)) {
        return { blockedReason: 'jobs_kind_not_canonical' };
    }
    if (typeof status !== 'string' || !APPLY_JOB_STATES[status]) {
        return { blockedReason: 'jobs_state_not_canonical' };
    }
    const track = row.track;
    if (!boundedApplyString(track, 50) || !TRACK_PATTERN.test(track)) {
        return { blockedReason: 'jobs_track_not_proven' };
    }
    const batch = row.batch === null || row.batch === undefined
        ? null
        : applyInteger(row, 'batch', 0, 100_000);
    if (row.batch !== null && row.batch !== undefined && batch === null) {
        return { blockedReason: 'jobs_batch_not_proven' };
    }
    const requiredJobKeys = row.required_job_keys;
    if (!Array.isArray(requiredJobKeys) || requiredJobKeys.length > 64) {
        return { blockedReason: 'jobs_dependency_keys_not_proven' };
    }
    const normalizedRequiredJobKeys = requiredJobKeys.map(value => (
        typeof value === 'string' ? value : null
    ));
    if (
        normalizedRequiredJobKeys.some(value => (
            value === null || !JOB_KEY_PATTERN.test(value) || value.length > 160
        ))
        || new Set(normalizedRequiredJobKeys).size !== normalizedRequiredJobKeys.length
        || normalizedRequiredJobKeys.includes(jobKey)
    ) {
        return { blockedReason: 'jobs_dependency_keys_not_proven' };
    }
    const generation = applyInteger(row, 'dispatch_generation', 0, 1_000);
    const attemptCount = applyInteger(row, 'attempt_count', 0, 100);
    if (generation === null || attemptCount === null) {
        return { blockedReason: 'jobs_generation_or_attempt_invalid' };
    }
    const createdAt = row.created_at;
    const updatedAt = row.updated_at;
    const updateOrder = comparePgTimestamps(updatedAt, createdAt);
    if (!isSafeTimestamp(createdAt) || !isSafeTimestamp(updatedAt) || updateOrder === null || updateOrder < 0) {
        return { blockedReason: 'jobs_timestamp_invalid' };
    }
    const leaseExpiresAt = row.lease_expires_at === null || row.lease_expires_at === undefined
        ? null
        : row.lease_expires_at;
    if (
        (leaseExpiresAt !== null && !isSafeTimestamp(leaseExpiresAt))
        || (status === 'processing' && leaseExpiresAt === null)
        || (leaseExpiresAt !== null && comparePgTimestamps(leaseExpiresAt, updatedAt) !== 1)
    ) {
        return { blockedReason: 'jobs_lease_not_proven' };
    }
    const completionHash = row.completion_fanout_hash === null || row.completion_fanout_hash === undefined
        ? null
        : row.completion_fanout_hash;
    if (
        (completionHash !== null && (typeof completionHash !== 'string' || !/^[a-f0-9]{32}$/.test(completionHash)))
        || (status === 'completed' && completionHash === null)
        || (status !== 'completed' && completionHash !== null)
    ) {
        return { blockedReason: 'jobs_completion_not_proven' };
    }
    const identity = applySourceIdentity(table, row);
    if (!identity) return { blockedReason: 'required_identity_or_bounded_payload' };
    const canonicalState = APPLY_JOB_STATES[status];
    const payload: Record<string, unknown> = {
        schemaVersion: 1,
        jobKey,
        track,
        generation,
        attemptCount,
        dependencyCount: normalizedRequiredJobKeys.length,
        requestStatus: status,
        state: canonicalState,
        completionHash,
        source: identity.envelope,
        sourceHash: identity.sourceHash,
    };
    if (batch !== null) payload.batch = batch;
    return mutation(table, row, {
        jobKey,
        kind,
        state: canonicalState,
        generation,
        attemptCount,
        dependencyCount: normalizedRequiredJobKeys.length,
        nextAttemptAt: createdAt,
        leaseExpiresAt,
        completionHash,
        payload,
        retentionClass: APPLY_RETENTION_CLASS,
        createdAt,
        updatedAt,
    });
}

function mapEventRow(table: BackfillTableSpec, row: Record<string, unknown>): BackfillMappingResult {
    if (table.table === 'analysis_progress_state') {
        return { blockedReason: 'events_mutable_snapshot_not_append_safe' };
    }
    if (table.table !== 'analysis_progress_events' && table.table !== 'analysis_step_events') {
        return { blockedReason: 'events_source_not_proven' };
    }
    if (hasSyntheticEvidence(row)) return { blockedReason: 'synthetic_or_sensitive_evidence' };
    const createdAt = table.table === 'analysis_progress_events' ? row.occurred_at : row.created_at;
    if (!isSafeTimestamp(createdAt)) return { blockedReason: 'events_timestamp_invalid' };
    const eventState = table.table === 'analysis_progress_events' ? row.event_state : row.event_type;
    const eventCode = table.table === 'analysis_progress_events' ? row.event_code : row.step;
    if (!boundedApplyString(eventState, 64) || !boundedApplyString(eventCode, 64)) {
        return { blockedReason: 'events_state_or_code_not_proven' };
    }
    const aggregateCount = table.table === 'analysis_progress_events'
        ? (row.aggregate_count === null || row.aggregate_count === undefined
            ? null : applyInteger(row, 'aggregate_count', 0, 10_000))
        : (row.progress === null || row.progress === undefined
            ? null : applyInteger(row, 'progress', 0, 100));
    if (
        (table.table === 'analysis_progress_events' && row.aggregate_count !== null && row.aggregate_count !== undefined && aggregateCount === null)
        || (table.table === 'analysis_step_events' && row.progress !== null && row.progress !== undefined && aggregateCount === null)
    ) {
        return { blockedReason: 'events_aggregate_invalid' };
    }
    const identity = applySourceIdentity(table, row);
    if (!identity) return { blockedReason: 'required_identity_or_bounded_payload' };
    const payload: Record<string, unknown> = {
        schemaVersion: 1,
        eventCode,
        copyCode: APPLY_COPY_CODE,
        state: eventState,
        source: identity.envelope,
    };
    if (aggregateCount !== null) payload.aggregateCount = aggregateCount;
    return {
        mutation: {
            sourceTable: table.table,
            sourceKey: identity.sourceKey,
            sourceHash: identity.sourceHash,
            requestId: identity.requestId,
            row: {
                kind: table.table === 'analysis_progress_events' ? 'progress' : 'lifecycle',
                state: eventState,
                payload,
                contentHash: identity.sourceHash,
                retentionClass: APPLY_RETENTION_CLASS,
                createdAt,
            },
        },
    };
}

function artifactKeyFor(table: BackfillTableSpec, row: Record<string, unknown>, sourceKey: string): string | null {
    if (table.table === 'analysis_v2_relationship_sides') {
        const side = row.side;
        if (side !== 'followers' && side !== 'following') return null;
        return `${sourceKey}:${side}`;
    }
    if (table.table === 'analysis_v2_candidate_score_manifests') {
        return `candidate-score-manifest:${sourceKey}`;
    }
    return sourceKey;
}

function mapArtifactRow(table: BackfillTableSpec, row: Record<string, unknown>): BackfillMappingResult {
    const artifactKind = APPLY_ARTIFACT_KINDS[table.table];
    if (!artifactKind) {
        if (table.table === 'analysis_v2_relationship_rows'
            || table.table === 'analysis_target_interactors'
            || table.table === 'analysis_v2_candidate_feature_rows'
            || table.table === 'analysis_v2_candidate_score_rows') {
            return { blockedReason: 'artifacts_required_unique_key_not_in_projection' };
        }
        return { blockedReason: 'artifacts_source_not_proven' };
    }
    if (hasSyntheticEvidence(row)) return { blockedReason: 'synthetic_or_sensitive_evidence' };
    const identity = applySourceIdentity(table, row);
    if (!identity) return { blockedReason: 'required_identity_or_bounded_payload' };
    const artifactKey = artifactKeyFor(table, row, identity.sourceKey);
    if (!artifactKey || !KEY_PATTERN.test(artifactKey) || artifactKey.length > 512) {
        return { blockedReason: 'artifacts_required_key_invalid' };
    }
    const createdAt = row.created_at;
    const updatedAt = row.updated_at ?? createdAt;
    const updateOrder = comparePgTimestamps(updatedAt, createdAt);
    if (!isSafeTimestamp(createdAt) || !isSafeTimestamp(updatedAt) || updateOrder === null || updateOrder < 0) {
        return { blockedReason: 'artifacts_timestamp_invalid' };
    }
    let state: 'retained' | 'expired' = 'retained';
    if (table.table === 'analysis_v2_media_artifacts' && row.deleted_at !== null && row.deleted_at !== undefined) {
        if (!isSafeTimestamp(row.deleted_at)) return { blockedReason: 'artifacts_deleted_timestamp_invalid' };
        state = 'expired';
    }
    const contentHash = identity.sourceHash;
    const payload: Record<string, unknown> = {
        schemaVersion: 1,
        artifactKey,
        kind: artifactKind,
        state,
        copyCode: APPLY_COPY_CODE,
        source: identity.envelope,
        retention: APPLY_RETENTION_CLASS,
    };
    if (table.table === 'analysis_v2_target_evidence_manifests') {
        const inputHash = row.input_hash;
        const likerSourceHash = row.liker_source_hash;
        const commentSourceHash = row.comment_source_hash;
        const resultHash = row.result_hash;
        const interactorCount = applyInteger(row, 'interactor_count', 0, 690);
        const likerCount = applyInteger(row, 'liker_count', 0, 600);
        const commentCount = applyInteger(row, 'comment_count', 0, 90);
        if (
            typeof inputHash !== 'string' || !HASH_PATTERN.test(inputHash)
            || typeof likerSourceHash !== 'string' || !HASH_PATTERN.test(likerSourceHash)
            || typeof commentSourceHash !== 'string' || !HASH_PATTERN.test(commentSourceHash)
            || typeof resultHash !== 'string' || !HASH_PATTERN.test(resultHash)
            || interactorCount === null || likerCount === null || commentCount === null
            || likerCount + commentCount !== interactorCount
            || !isSafeTimestamp(row.frozen_at)
        ) {
            return { blockedReason: 'artifacts_target_manifest_not_lossless' };
        }
        payload.targetManifest = {
            key: artifactKey,
            inputHash,
            likerSourceHash,
            commentSourceHash,
            resultHash,
            interactorCount,
            likerCount,
            commentCount,
            retention: APPLY_RETENTION_CLASS,
        };
        payload.frozenAt = row.frozen_at;
    }
    if (table.table === 'analysis_v2_media_artifacts') {
        const sourceContentHash = row.content_sha256;
        if (typeof sourceContentHash !== 'string' || !HASH_PATTERN.test(sourceContentHash)) {
            return { blockedReason: 'artifacts_content_hash_not_proven' };
        }
        payload.resultHash = sourceContentHash;
    }
    return {
        mutation: {
            sourceTable: table.table,
            sourceKey: identity.sourceKey,
            sourceHash: contentHash,
            requestId: identity.requestId,
            row: {
                artifactKey,
                kind: artifactKind,
                state,
                contentHash,
                payload,
                retentionClass: APPLY_RETENTION_CLASS,
                createdAt,
                updatedAt,
            },
        },
    };
}

function mapCostRow(table: BackfillTableSpec, row: Record<string, unknown>): BackfillMappingResult {
    if (table.table === 'analysis_v2_cost_rollup_snapshots') {
        return { blockedReason: 'costs_rollup_snapshot_missing_lossless_operation' };
    }
    if (table.table !== 'analysis_v2_cost_attributions' && table.table !== 'analysis_provider_cost_ledger') {
        return { blockedReason: 'costs_source_not_proven' };
    }
    if (hasSyntheticEvidence(row)) return { blockedReason: 'synthetic_or_sensitive_evidence' };
    const identity = applySourceIdentity(table, row);
    if (!identity) return { blockedReason: 'required_identity_or_bounded_payload' };
    let provider: string;
    let operationKey: string;
    let stage: string;
    let amountKnown: string | null;
    let amountConservative: string | null;
    let usageUnknown: boolean;
    let sourceHash: string;
    const payload: Record<string, unknown> = { schemaVersion: 1 };
    if (table.table === 'analysis_v2_cost_attributions') {
        provider = row.source_kind as string;
        operationKey = row.source_operation_key as string;
        stage = provider;
        const attributionHash = row.source_identity_hash;
        if (!boundedApplyString(provider, 128) || !boundedApplyString(operationKey, 512)
            || typeof attributionHash !== 'string' || !HASH_PATTERN.test(attributionHash)) {
            return { blockedReason: 'costs_attribution_identity_not_proven' };
        }
        amountKnown = null;
        amountConservative = null;
        usageUnknown = true;
        sourceHash = attributionHash;
        payload.sourceHash = sourceHash;
        payload.operationKey = operationKey;
        payload.provider = provider;
        payload.usageUnknown = true;
    } else {
        provider = row.logical_provider as string;
        operationKey = row.operation_key as string;
        stage = 'provider';
        const status = row.status;
        const credentialSlot = row.credential_slot;
        const maxCharge = applyCanonicalMoney(row, 'max_charge_usd');
        const usage = row.usage_total_usd === null || row.usage_total_usd === undefined
            ? null : applyCanonicalMoney(row, 'usage_total_usd');
        if (!boundedApplyString(provider, 128) || !boundedApplyString(operationKey, 512)
            || !boundedApplyString(status, 64)
            || (credentialSlot !== 'primary' && credentialSlot !== 'secondary')
            || maxCharge === null
            || (row.usage_total_usd !== null && row.usage_total_usd !== undefined && usage === null)) {
            return { blockedReason: 'costs_provider_ledger_identity_not_proven' };
        }
        amountKnown = usage;
        usageUnknown = usage === null;
        amountConservative = usage ?? maxCharge;
        sourceHash = identity.sourceHash;
        payload.runId = identity.sourceKey;
        payload.status = status;
        payload.maxChargeUsd = maxCharge;
        payload.credentialSlot = credentialSlot;
        payload.usageUnknown = usageUnknown;
        payload.amountKnown = amountKnown;
        payload.amountConservative = amountConservative;
        payload.sourceHash = sourceHash;
        payload.operationKey = operationKey;
        payload.provider = provider;
    }
    const idempotencyKey = `analysis-backfill:v1:${table.table}:${identity.sourceKey}`;
    if (!KEY_PATTERN.test(idempotencyKey) || idempotencyKey.length > 256) {
        return { blockedReason: 'costs_idempotency_key_invalid' };
    }
    const recordedAt = table.table === 'analysis_v2_cost_attributions'
        ? row.attributed_at
        : row.created_at;
    if (!isSafeTimestamp(recordedAt)) return { blockedReason: 'costs_timestamp_invalid' };
    return {
        mutation: {
            sourceTable: table.table,
            sourceKey: identity.sourceKey,
            sourceHash,
            requestId: identity.requestId,
            row: {
                provider,
                operationKey,
                stage,
                currency: 'USD',
                amountKnown,
                amountConservative,
                usageUnknown,
                sourceHash,
                idempotencyKey,
                payload,
                retentionClass: 'permanent',
                recordedAt,
            },
        },
    };
}

function mapLegacyRowForApply(
    family: AnalysisCanonicalBackfillFamily,
    table: BackfillTableSpec,
    row: Record<string, unknown>,
): BackfillMappingResult {
    if (family === 'jobs') return mapJobRow(table, row);
    if (family === 'events') return mapEventRow(table, row);
    if (family === 'artifacts') return mapArtifactRow(table, row);
    if (family === 'costs') return mapCostRow(table, row);
    return { blockedReason: 'deferred_family' };
}

async function applyLegacyPages(
    client: AnalysisBackfillClient,
    family: AnalysisCanonicalBackfillFamily,
    pages: readonly BackfillLegacyPage[],
    selectedRequestIds: ReadonlySet<string>,
    acknowledgement: string,
    run: BackfillApplyRun,
): Promise<BackfillApplyFamilyResult> {
    let attempted = 0;
    let applied = 0;
    let blocked = 0;
    let failed = 0;
    const blockedReasons = new Set<string>();
    let lastProcessedPosition: AnalysisBackfillCursorPosition | null = null;
    const stoppedResult = (): BackfillApplyFamilyResult => ({
        report: { attempted, applied, blocked, failed, blockedReasons: [...blockedReasons].sort() },
        lastProcessedPosition,
        stopped: run.stopped,
    });
    if (pages.length === 0) {
        return stoppedResult();
    }
    for (const page of pages) {
        if (run.stopped) {
            blocked += 1;
            blockedReasons.add('apply_stopped');
            return stoppedResult();
        }
        lastProcessedPosition = page.priorPosition;
        try {
            await assertMutableSourcePageFreshness(client, page, [...selectedRequestIds]);
        } catch {
            blocked += 1;
            blockedReasons.add(`${page.table.table}:source_stale_before_apply`);
            run.stopped = true;
            run.stopTableKey = tablePositionKey(page.table);
            run.stopPosition = page.priorPosition;
            return stoppedResult();
        }
        // Each page is read with `limit + 1`, then reduced to at most limit.
        // Apply one row per RPC so a failed row can be retried from the same
        // input cursor without ever skipping a source row.
        for (const sourceRow of page.rows) {
            const sourcePosition = rowCursorPosition(sourceRow, page.table);
            const requestId = textField(sourceRow, 'request_id', 'requestId');
            if (!requestId || !selectedRequestIds.has(requestId)) {
                blocked += 1;
                blockedReasons.add('request_identity_not_in_selected_batch');
                if (sourcePosition) lastProcessedPosition = sourcePosition;
                continue;
            }
            const mapping = mapLegacyRowForApply(family, page.table, sourceRow);
            if (!mapping.mutation) {
                blocked += 1;
                blockedReasons.add(`${page.table.table}:${mapping.blockedReason ?? 'mapping_not_proven'}`);
                if (sourcePosition) lastProcessedPosition = sourcePosition;
                continue;
            }
            if (run.budget.attempted >= run.budget.limit) {
                blocked += 1;
                blockedReasons.add('apply_budget_exhausted');
                run.stopped = true;
                run.stopTableKey = tablePositionKey(page.table);
                run.stopPosition = lastProcessedPosition;
                return stoppedResult();
            }
            run.budget.attempted += 1;
            attempted += 1;
            if (!client.rpc) {
                failed += 1;
                blockedReasons.add('apply_rpc_unavailable');
                run.stopped = true;
                run.stopTableKey = tablePositionKey(page.table);
                run.stopPosition = lastProcessedPosition;
                return stoppedResult();
            }
            let result: { data: unknown; error: BackfillRpcError | null };
            try {
                result = await client.rpc(ANALYSIS_CANONICAL_BACKFILL_APPLY_RPC, {
                    p_acknowledgement: acknowledgement,
                    p_family: family,
                    p_source_table: mapping.mutation.sourceTable,
                    p_source_key: mapping.mutation.sourceKey,
                    p_source_hash: mapping.mutation.sourceHash,
                    p_request_id: mapping.mutation.requestId,
                    p_row: mapping.mutation.row,
                });
            } catch {
                failed += 1;
                blockedReasons.add('apply_rpc_failed');
                run.stopped = true;
                run.stopTableKey = tablePositionKey(page.table);
                run.stopPosition = lastProcessedPosition;
                return stoppedResult();
            }
            if (result.error || !isRecord(result.data) || result.data.status !== 'applied') {
                failed += 1;
                blockedReasons.add('apply_rpc_rejected');
                run.stopped = true;
                run.stopTableKey = tablePositionKey(page.table);
                run.stopPosition = lastProcessedPosition;
                return stoppedResult();
            }
            applied += 1;
            run.appliedMutations.push({ family, mutation: mapping.mutation });
            if (sourcePosition) lastProcessedPosition = sourcePosition;
        }
    }
    return stoppedResult();
}

export function parseBackfillCliArgs(argv: readonly string[]): BackfillCliArgs {
    let limit = BACKFILL_MAX_LIMIT;
    let reportOnly = true;
    let apply = false;
    let acknowledgement: string | undefined;
    let cursor: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === '--report-only') {
            if (apply) {
                throw new Error('Analysis canonical backfill cannot combine --report-only and --apply.');
            }
            reportOnly = true;
            continue;
        }
        if (arg === '--apply') {
            if (reportOnly && index > 0 && argv.includes('--report-only')) {
                throw new Error('Analysis canonical backfill cannot combine --report-only and --apply.');
            }
            apply = true;
            reportOnly = false;
            continue;
        }
        if (arg === '--acknowledge') {
            const next = argv[index + 1];
            if (!next) throw new Error('Analysis canonical backfill requires acknowledgement value.');
            index += 1;
            acknowledgement = next;
            continue;
        }
        if (arg.startsWith('--acknowledge=')) {
            acknowledgement = arg.slice('--acknowledge='.length);
            continue;
        }
        if (arg === '--limit') {
            const next = argv[index + 1];
            if (!next) throw new Error('Analysis canonical backfill requires --limit value.');
            index += 1;
            limit = Number(next);
            continue;
        }
        if (arg.startsWith('--limit=')) {
            limit = Number(arg.slice('--limit='.length));
            continue;
        }
        if (arg === '--cursor') {
            const next = argv[index + 1];
            if (!next) throw new Error('Analysis canonical backfill requires --cursor value.');
            index += 1;
            try {
                parseBackfillCursor(next);
            } catch (error) {
                if (!(error instanceof IncompatibleBackfillCursorError)) throw error;
            }
            cursor = next;
            continue;
        }
        if (arg.startsWith('--cursor=')) {
            const next = arg.slice('--cursor='.length);
            try {
                parseBackfillCursor(next);
            } catch (error) {
                if (!(error instanceof IncompatibleBackfillCursorError)) throw error;
            }
            cursor = next;
            continue;
        }
        if (['--drop', '--truncate', '--delete', '--mutate', '--rename', '--activate', '--cutover', '--execute'].includes(arg)) {
            throw new Error('Analysis canonical backfill accepts no destructive or activation options.');
        }
        throw new Error('Analysis canonical backfill accepts only --limit, --cursor, --report-only, or guarded --apply.');
    }
    if (apply && acknowledgement !== ANALYSIS_CANONICAL_BACKFILL_APPLY_ACKNOWLEDGEMENT) {
        throw new Error('Analysis canonical backfill requires the exact apply acknowledgement.');
    }
    if (!apply && acknowledgement !== undefined) {
        throw new Error('Analysis canonical backfill acknowledgement requires --apply.');
    }
    buildBackfillBatch([], limit);
    return apply
        ? {
            limit,
            reportOnly: false,
            apply: true,
            acknowledgement,
            ...(cursor === undefined ? {} : { cursor }),
        }
        : {
            limit,
            reportOnly: true,
            ...(cursor === undefined ? {} : { cursor }),
        };
}

function emptyFamilyReport(): BackfillFamilyReport {
    return {
        source: { count: 0, checksum: null, complete: false },
        canonical: { count: 0, checksum: null, complete: false },
        parity: { status: 'blocked', mismatchPaths: ['source.missing'] },
        logical: {
            sourceCount: 0,
            canonicalCount: 0,
            sourceChecksum: null,
            canonicalChecksum: null,
        },
        requiredFields: [],
        targetEvidence: {
            sourceCount: 0,
            canonicalCount: 0,
            sourceChecksum: null,
            canonicalChecksum: null,
            sourceInteractionCount: 0,
            canonicalInteractionCount: 0,
            sourceInteractionChecksum: null,
            canonicalInteractionChecksum: null,
        },
    };
}

function mergeParityEvidence(
    current: AnalysisBackfillParitySummary,
    prior: AnalysisBackfillParitySummary | undefined,
): AnalysisBackfillParitySummary {
    if (!prior || prior.status === 'match') return current;
    if (current.status === 'match') return {
        status: prior.status,
        mismatchPaths: [...prior.mismatchPaths],
    };
    return {
        status: prior.status === 'blocked' || current.status === 'blocked' ? 'blocked' : 'mismatch',
        mismatchPaths: [...new Set([...prior.mismatchPaths, ...current.mismatchPaths])],
    };
}

function tablePositionKey(table: BackfillTableSpec): string {
    return `${table.table}:${table.timeColumn}:${table.keyColumn}`;
}

const INTEGER_KEY_PATTERN = /^(?:0|[1-9][0-9]*)$/;
const CURSOR_KEY_SEPARATOR = '|';
const POSTGREST_LITERAL_QUOTE_PATTERN = /[,.:()"\\\s]/;

/**
 * `.or()` receives a raw PostgREST expression.  Keep this value un-percent-
 * encoded: postgrest-js appends it through URLSearchParams, which performs the
 * URL encoding exactly once.  PostgREST-style quotes protect reserved
 * separators inside a literal; quotes and backslashes inside the value are
 * escaped before wrapping it.
 */
function postgrestFilterLiteral(value: string): string {
    if (!POSTGREST_LITERAL_QUOTE_PATTERN.test(value)) return value;
    return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function postgrestFilterTerm(column: string, operator: string, value: string): string {
    return `${column}.${operator}.${postgrestFilterLiteral(value)}`;
}

function postgrestFilterIn(column: string, values: readonly string[]): string {
    return `${column}.in.(${values.map(postgrestFilterLiteral).join(',')})`;
}

function cursorColumns(spec: BackfillTableSpec): readonly BackfillCursorColumn[] {
    return spec.cursorColumns ?? [{
        column: spec.keyColumn,
        keyType: spec.keyType,
        keyMinimum: spec.keyMinimum,
        keyMaximum: spec.keyMaximum,
    }];
}

function integerKeyBounds(column: BackfillCursorColumn): { minimum: bigint; maximum: bigint } | null {
    const keyType = column.keyType;
    if (keyType !== 'bigint' && keyType !== 'integer' && keyType !== 'smallint') {
        return null;
    }
    const defaults: Record<'bigint' | 'integer' | 'smallint', { minimum: string; maximum: string }> = {
        bigint: { minimum: '-9223372036854775808', maximum: '9223372036854775807' },
        integer: { minimum: '-2147483648', maximum: '2147483647' },
        smallint: { minimum: '-32768', maximum: '32767' },
    };
    const bounds = defaults[keyType];
    try {
        const minimum = BigInt(column.keyMinimum ?? bounds.minimum);
        const maximum = BigInt(column.keyMaximum ?? bounds.maximum);
        return minimum <= maximum ? { minimum, maximum } : null;
    } catch {
        return null;
    }
}

/**
 * PostgreSQL numeric keys may arrive as JSON numbers or decimal strings.  Keep
 * the cursor wire representation textual, but canonicalize through BigInt so
 * ordering never falls back to lexicographic comparison or lossy Number math.
 */
function canonicalCursorColumn(value: unknown, column: BackfillCursorColumn): string | null {
    if (column.keyType === 'bigint' || column.keyType === 'integer' || column.keyType === 'smallint') {
        let numeric: bigint;
        try {
            if (typeof value === 'bigint') {
                numeric = value;
            } else if (typeof value === 'number') {
                if (!Number.isSafeInteger(value)) return null;
                numeric = BigInt(value);
            } else if (typeof value === 'string' && INTEGER_KEY_PATTERN.test(value)) {
                numeric = BigInt(value);
            } else {
                return null;
            }
        } catch {
            return null;
        }
        const bounds = integerKeyBounds(column);
        if (!bounds || numeric < bounds.minimum || numeric > bounds.maximum) return null;
        return numeric.toString();
    }
    return typeof value === 'string' && KEY_PATTERN.test(value) ? value : null;
}

function cursorKeyParts(value: unknown, spec: BackfillTableSpec): string[] | null {
    if (typeof value !== 'string') return null;
    const columns = cursorColumns(spec);
    const rawParts = columns.length === 1
        ? [value]
        : value.split(CURSOR_KEY_SEPARATOR);
    if (rawParts.length !== columns.length) return null;
    const normalized = rawParts.map((part, index) => canonicalCursorColumn(part, columns[index]!));
    if (normalized.some((part): part is null => part === null)) return null;
    return normalized as string[];
}

function canonicalCursorKey(value: unknown, spec: BackfillTableSpec): string | null {
    const columns = cursorColumns(spec);
    if (columns.length === 1) {
        const normalized = canonicalCursorColumn(value, columns[0]!);
        return normalized;
    }
    const parts = cursorKeyParts(value, spec);
    return parts ? parts.join(CURSOR_KEY_SEPARATOR) : null;
}

function sourceIdentityKey(value: Record<string, unknown>, spec: BackfillTableSpec): string | null {
    const rawKey = Object.prototype.hasOwnProperty.call(value, spec.keyColumn)
        ? value[spec.keyColumn]
        : value.id;
    // Pagination may use a schema composite, but source/RPC identity remains
    // the pre-composite keyColumn contract for every legacy source.
    return canonicalCursorKey(rawKey, { ...spec, cursorColumns: undefined });
}

function cursorKeyFromRow(value: Record<string, unknown>, spec: BackfillTableSpec): string | null {
    const columns = cursorColumns(spec);
    const rawParts = columns.map((column) => {
        if (Object.prototype.hasOwnProperty.call(value, column.column)) {
            return value[column.column];
        }
        return columns.length === 1 ? value.id : undefined;
    });
    const normalized = rawParts.map((part, index) => canonicalCursorColumn(part, columns[index]!));
    if (normalized.some((part): part is null => part === null)) return null;
    return (normalized as string[]).join(CURSOR_KEY_SEPARATOR);
}

function tableSpecForPositionKey(positionKey: string): BackfillTableSpec | null {
    if (positionKey === `${SOURCE_TABLE}:created_at:id`) {
        return {
            table: SOURCE_TABLE,
            columns: 'id, created_at, status',
            timeColumn: 'created_at',
            keyColumn: 'id',
            requestIdColumn: null,
        };
    }
    for (const family of ANALYSIS_CANONICAL_BACKFILL_FAMILIES) {
        const table = [...family.legacy, family.canonical].find(value => (
            tablePositionKey(value) === positionKey
        ));
        if (table) return table;
    }
    return null;
}

function compareCursorPositions(
    left: AnalysisBackfillCursorPosition,
    right: AnalysisBackfillCursorPosition,
    spec: BackfillTableSpec,
): number | null {
    if (!isSafeTimestamp(left.createdAt) || !isSafeTimestamp(right.createdAt)) return null;
    const leftKeys = cursorKeyParts(left.key, spec);
    const rightKeys = cursorKeyParts(right.key, spec);
    if (leftKeys === null || rightKeys === null) return null;
    const created = left.createdAt < right.createdAt ? -1 : left.createdAt > right.createdAt ? 1 : 0;
    if (created !== 0) return created;
    const request = left.requestId < right.requestId ? -1 : left.requestId > right.requestId ? 1 : 0;
    if (request !== 0) return request;
    const columns = cursorColumns(spec);
    for (let index = 0; index < columns.length; index += 1) {
        const column = columns[index]!;
        const leftKey = leftKeys[index]!;
        const rightKey = rightKeys[index]!;
        if (column.keyType === 'bigint' || column.keyType === 'integer' || column.keyType === 'smallint') {
            const leftNumeric = BigInt(leftKey);
            const rightNumeric = BigInt(rightKey);
            if (leftNumeric !== rightNumeric) {
                return leftNumeric < rightNumeric ? -1 : 1;
            }
        } else if (leftKey !== rightKey) {
            return leftKey < rightKey ? -1 : 1;
        }
    }
    return 0;
}

function rowCursorPosition(row: unknown, spec: BackfillTableSpec): AnalysisBackfillCursorPosition | null {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const value = row as Record<string, unknown>;
    const rawCreatedAt = value[spec.timeColumn] ?? value.created_at;
    const requestId = spec.requestIdColumn === null
        ? ''
        : value[spec.requestIdColumn ?? 'request_id'] ?? value.request_id;
    const normalizedKey = cursorKeyFromRow(value, spec);
    const normalizedCreatedAt = normalizePgTimestamp(rawCreatedAt);
    if (
        normalizedCreatedAt === null
        || typeof requestId !== 'string'
        || (requestId !== '' && !UUID_PATTERN.test(requestId))
        || normalizedKey === null
    ) return null;
    return {
        createdAt: normalizedCreatedAt,
        requestId,
        key: normalizedKey,
        rowHash: stableHash(value),
    };
}

function cursorPosition(
    cursor: ParsedBackfillCursor | null,
    spec: BackfillTableSpec,
): AnalysisBackfillCursorPosition | null {
    if (!cursor || (cursor.version !== 4 && cursor.version !== COMPOSITE_CURSOR_VERSION)) return null;
    return cursor.positions[tablePositionKey(spec)] ?? null;
}

function cursorTableCompleted(
    cursor: ParsedBackfillCursor | null,
    table: BackfillTableSpec,
): boolean {
    return (cursor?.version === 4 || cursor?.version === COMPOSITE_CURSOR_VERSION)
        && cursor.completed.includes(tablePositionKey(table));
}

function applyEqFilter(
    query: BackfillQuery,
    column: string,
    value: string,
): BackfillQuery {
    if (!query.eq) throw new Error('exact freshness boundary filter unavailable');
    return query.eq(column, value);
}

async function assertMutableCursorBoundaryFreshness(
    client: AnalysisBackfillClient,
    spec: BackfillTableSpec,
    position: AnalysisBackfillCursorPosition,
): Promise<void> {
    if (spec.freshnessFence !== 'row_hash') return;
    const requestIdColumn = spec.requestIdColumn === undefined
        ? 'request_id'
        : spec.requestIdColumn;
    if (requestIdColumn === null || !position.requestId) {
        throw new Error('mutable source freshness identity unavailable');
    }
    const boundaryKeys = cursorKeyParts(position.key, spec);
    const keyColumns = cursorColumns(spec);
    if (!boundaryKeys) throw new Error('mutable source cursor boundary changed');
    let query = client.from(spec.table).select(spec.columns);
    query = applyEqFilter(query, requestIdColumn, position.requestId);
    query = applyEqFilter(query, spec.timeColumn, position.createdAt);
    for (let index = 0; index < keyColumns.length; index += 1) {
        query = applyEqFilter(query, keyColumns[index]!.column, boundaryKeys[index]!);
    }
    const result = await query.limit(2);
    if (result.error || !Array.isArray(result.data) || result.data.length !== 1) {
        throw new Error('mutable source cursor boundary changed');
    }
    const boundary = rowCursorPosition(result.data[0], spec);
    if (
        !boundary
        || boundary.rowHash !== position.rowHash
        || compareCursorPositions(boundary, position, spec) !== 0
    ) {
        throw new Error('mutable source cursor boundary changed');
    }
}

function keysetBoundaryExpression(
    spec: BackfillTableSpec,
    requestIdColumn: string,
    position: AnalysisBackfillCursorPosition,
): string | null {
    const keys = cursorKeyParts(position.key, spec);
    if (!keys) return null;
    const prefix = [
        postgrestFilterTerm(spec.timeColumn, 'eq', position.createdAt),
        postgrestFilterTerm(requestIdColumn, 'eq', position.requestId),
    ];
    const clauses = [
        postgrestFilterTerm(spec.timeColumn, 'gt', position.createdAt),
        `and(${postgrestFilterTerm(spec.timeColumn, 'eq', position.createdAt)},${postgrestFilterTerm(requestIdColumn, 'gt', position.requestId)})`,
    ];
    for (let index = 0; index < keys.length; index += 1) {
        const equalPrefix = [...prefix];
        for (let prior = 0; prior < index; prior += 1) {
            equalPrefix.push(postgrestFilterTerm(
                cursorColumns(spec)[prior]!.column,
                'eq',
                keys[prior]!,
            ));
        }
        const column = cursorColumns(spec)[index]!.column;
        clauses.push(`and(${[...equalPrefix, postgrestFilterTerm(column, 'gt', keys[index]!)].join(',')})`);
    }
    return clauses.join(',');
}

function sameMutableSourcePage(
    expectedRows: readonly Record<string, unknown>[],
    expectedHasMore: boolean,
    freshPage: BoundedBackfillPage,
    spec: BackfillTableSpec,
): boolean {
    if (expectedHasMore !== freshPage.hasMore || expectedRows.length !== freshPage.rows.length) {
        return false;
    }
    for (let index = 0; index < expectedRows.length; index += 1) {
        const expectedPosition = rowCursorPosition(expectedRows[index], spec);
        const freshPosition = rowCursorPosition(freshPage.rows[index], spec);
        if (
            !expectedPosition
            || !freshPosition
            || expectedPosition.rowHash !== freshPosition.rowHash
            || compareCursorPositions(expectedPosition, freshPosition, spec) !== 0
        ) {
            return false;
        }
    }
    return true;
}

async function assertMutableSourcePageFreshness(
    client: AnalysisBackfillClient,
    page: BackfillLegacyPage,
    selectedRequestIds: readonly string[],
): Promise<void> {
    if (page.table.freshnessFence !== 'row_hash') return;
    const freshPage = await readBoundedTable(
        client,
        page.table,
        page.limit,
        page.priorPosition,
        selectedRequestIds,
    );
    if (!sameMutableSourcePage(page.rows, page.hasMore, freshPage, page.table)) {
        throw new Error('mutable source page changed before apply');
    }
}

async function readBoundedTable(
    client: AnalysisBackfillClient,
    spec: BackfillTableSpec,
    limit: number,
    position: AnalysisBackfillCursorPosition | null,
    selectedRequestIds: readonly string[],
): Promise<BoundedBackfillPage> {
    let query = client.from(spec.table).select(spec.columns);
    const requestIdColumn = spec.requestIdColumn === undefined
        ? 'request_id'
        : spec.requestIdColumn;
    if (requestIdColumn === null) {
        // A legacy table without a request identity cannot be safely included in
        // a request-scoped parity report. Never read it globally or infer
        // ownership from an untrusted cache key.
        throw new Error('request-safe identity unavailable');
    }
    if (position) {
        await assertMutableCursorBoundaryFreshness(client, spec, position);
    }
    if (selectedRequestIds.length > 0) {
        if (query.in) {
            query = query.in(requestIdColumn, selectedRequestIds);
        } else if (query.or) {
            // Lightweight adapters used by the regression suite may expose
            // only PostgREST's OR builder.  Keep the selected UUID set in the
            // expression; production clients use `in` above.
            query = query.or(postgrestFilterIn(requestIdColumn, selectedRequestIds));
        } else {
            throw new Error('request selection filter unavailable');
        }
    } else if (!position) {
        // Never issue an unscoped family read.  Adapters without an `in`
        // method are still called in tests, but production Supabase clients
        // must provide a request-safe predicate.
        if (query.in) {
            query = query.in(requestIdColumn, []);
        } else if (query.eq) {
            query = query.eq(requestIdColumn, '00000000-0000-4000-8000-000000000000');
        } else if (query.or) {
            // The fallback is still request-constrained and only contains
            // no selected IDs, so it cannot match a real request row.
            query = query.or(postgrestFilterTerm(
                requestIdColumn,
                'eq',
                '00000000-0000-4000-8000-000000000000',
            ));
        } else {
            throw new Error('request selection filter unavailable');
        }
    } else {
        // A family-only continuation can legitimately carry no selected IDs
        // when the source page was empty. Keep that continuation request-safe
        // by applying an impossible request predicate before its keyset
        // boundary; never turn a cursor into an unscoped family read.
        if (query.in) {
            query = query.in(requestIdColumn, []);
        } else if (query.eq) {
            query = query.eq(requestIdColumn, '00000000-0000-4000-8000-000000000000');
        } else if (query.or) {
            query = query.or(postgrestFilterTerm(
                requestIdColumn,
                'eq',
                '00000000-0000-4000-8000-000000000000',
            ));
        } else {
            throw new Error('request selection filter unavailable');
        }
    }
    if (position) {
        if (!query.or) throw new Error('keyset boundary filter unavailable');
        const boundary = keysetBoundaryExpression(spec, requestIdColumn, position);
        if (!boundary) throw new Error('keyset boundary cursor unavailable');
        query = query.or(boundary);
    }
    // Read one sentinel row. A page with exactly `limit` rows is complete
    // because the query asked for `limit + 1`; a page with the sentinel is
    // explicitly incomplete and must never report parity.
    query = query.order(spec.timeColumn, { ascending: true });
    query = query.order(requestIdColumn, { ascending: true });
    for (const column of cursorColumns(spec)) {
        query = query.order(column.column, { ascending: true });
    }
    const result = await query.limit(limit + 1);
    if (result.error || !Array.isArray(result.data) || result.data.length > limit + 1) {
        throw new Error('bounded analysis canonical backfill query failed');
    }
    const hasMore = result.data.length > limit;
    const pageData = hasMore ? result.data.slice(0, limit) : result.data;
    const rows: Record<string, unknown>[] = [];
    for (const value of pageData) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('invalid analysis canonical backfill row');
        }
        rows.push(value as Record<string, unknown>);
    }
    const positionsOnPage = rows
        .map(row => rowCursorPosition(row, spec))
        .filter((value): value is AnalysisBackfillCursorPosition => value !== null);
    if (positionsOnPage.length !== rows.length) {
        throw new Error('invalid analysis canonical backfill cursor row');
    }
    if (position && positionsOnPage.length > 0) {
        const firstOrder = compareCursorPositions(position, positionsOnPage[0]!, spec);
        if (firstOrder === null || firstOrder >= 0) {
            throw new Error('analysis canonical backfill cursor boundary did not advance');
        }
    }
    for (let index = 1; index < positionsOnPage.length; index += 1) {
        const previous = positionsOnPage[index - 1]!;
        const current = positionsOnPage[index]!;
        const order = compareCursorPositions(previous, current, spec);
        if (order === null || order >= 0) {
            throw new Error('ambiguous analysis canonical backfill cursor order');
        }
    }
    if (hasMore) {
        const sentinel = rowCursorPosition(result.data[limit], spec);
        const last = positionsOnPage.at(-1);
        if (!sentinel || !last) throw new Error('invalid analysis canonical backfill sentinel');
        const sentinelOrder = compareCursorPositions(last, sentinel, spec);
        if (sentinelOrder === null || sentinelOrder >= 0) {
            throw new Error('ambiguous analysis canonical backfill cursor tie');
        }
    }
    const next = rows.length > 0 ? positionsOnPage[positionsOnPage.length - 1]! : position;
    return { rows, next, hasMore };
}

function aggregateRows(rows: readonly unknown[], complete: boolean) {
    return {
        count: rows.length,
        checksum: rows.length > 0 ? stableHash(rows) : null,
        complete,
    };
}

async function readFamily(
    client: AnalysisBackfillClient,
    spec: AnalysisCanonicalBackfillFamilySpec,
    limit: number,
    cursor: ParsedBackfillCursor | null,
    selectedRequestIds: readonly string[],
    apply: boolean,
): Promise<{
    report: BackfillFamilyReport;
    positions: Record<string, AnalysisBackfillCursorPosition>;
    completed: readonly string[];
    legacyPages: readonly BackfillLegacyPage[];
    blocked: number;
    hasMore: boolean;
    readBlocked: boolean;
}> {
    if (spec.deferred || spec.legacy.length === 0) {
        // Keep the five-family report shape while making deferred families a
        // visible blocked result. In particular, do not read a canonical cache
        // destination without an executable, request-safe legacy source.
        return {
            report: emptyFamilyReport(),
            positions: {},
            completed: [],
            legacyPages: [],
            blocked: 1,
            hasMore: false,
            readBlocked: false,
        };
    }
    const positions: Record<string, AnalysisBackfillCursorPosition> = {};
    const completed: string[] = [];
    const legacyRows: Record<string, unknown>[] = [];
    const canonicalRows: Record<string, unknown>[] = [];
    const legacyPages: BackfillLegacyPage[] = [];
    let sourceComplete = true;
    let canonicalComplete = true;
    let sourceHasMore = false;
    let canonicalHasMore = false;
    let blocked = 0;
    let readBlocked = false;
    for (const table of spec.legacy) {
        const tableKey = tablePositionKey(table);
        if (cursorTableCompleted(cursor, table)) {
            completed.push(tableKey);
            continue;
        }
        const priorPosition = cursorPosition(cursor, table);
        try {
            const page = await readBoundedTable(
                client,
                table,
                limit,
                cursorPosition(cursor, table),
                selectedRequestIds,
            );
            legacyPages.push({
                table,
                rows: page.rows,
                priorPosition,
                limit,
                hasMore: page.hasMore,
            });
            legacyRows.push(...page.rows);
            sourceHasMore ||= page.hasMore;
            if (page.hasMore && page.next) positions[tableKey] = page.next;
            if (!page.hasMore) completed.push(tableKey);
        } catch {
            sourceComplete = false;
            readBlocked = true;
            blocked += 1;
            if (priorPosition) positions[tableKey] = priorPosition;
        }
    }
    const canonicalTableKey = tablePositionKey(spec.canonical);
    if (cursorTableCompleted(cursor, spec.canonical)) {
        completed.push(canonicalTableKey);
    } else {
    const canonicalPriorPosition = cursorPosition(cursor, spec.canonical);
    try {
        const page = await readBoundedTable(
            client,
            spec.canonical,
            limit,
            cursorPosition(cursor, spec.canonical),
            selectedRequestIds,
        );
        canonicalRows.push(...page.rows);
        canonicalHasMore = page.hasMore;
        if (page.hasMore && page.next) positions[canonicalTableKey] = page.next;
        if (!page.hasMore) completed.push(canonicalTableKey);
    } catch {
        canonicalComplete = false;
        readBlocked = true;
        blocked += 1;
        if (canonicalPriorPosition) positions[canonicalTableKey] = canonicalPriorPosition;
    }
    }
    const source = aggregateRows(legacyRows, sourceComplete && !sourceHasMore);
    const canonical = aggregateRows(canonicalRows, canonicalComplete && !canonicalHasMore);
    const logicalSource = normalizeBackfillFamilyRows(spec.family, legacyRows, selectedRequestIds);
    const logicalCanonical = normalizeBackfillFamilyRows(spec.family, canonicalRows, selectedRequestIds);
    const projection = projectLegacyPages(
        spec.family,
        legacyPages,
        new Set(selectedRequestIds),
    );
    if (!apply) blocked += projection.blockedReasons.length;
    const parity: AnalysisBackfillParitySummary = apply
        ? { status: 'blocked', mismatchPaths: ['canonical.missing'] }
        : !sourceComplete || sourceHasMore
            ? { status: 'blocked', mismatchPaths: ['source.missing'] }
            : !canonicalComplete || canonicalHasMore
                ? { status: 'blocked', mismatchPaths: ['canonical.missing'] }
                : projection.blockedReasons.length > 0
                    ? { status: 'blocked', mismatchPaths: ['source.evidence'] }
                    : compareAppliedCanonicalRows(
                        spec.family,
                        projection.expected,
                        canonicalRowsForExpected(spec.family, projection.expected, canonicalRows),
                    );
    const targetSource = logicalSource.filter(row => row.evidence.targetManifest);
    const targetCanonical = logicalCanonical.filter(row => row.evidence.targetManifest);
    const targetSourceInteractions = logicalSource.flatMap(row => row.evidence.targetInteractions);
    const targetCanonicalInteractions = logicalCanonical.flatMap(row => row.evidence.targetInteractions);
    const requiredFields = [
        'request_id', 'schemaVersion', 'state', 'counts', 'candidate', 'interaction',
        'candidate.key', 'candidate.ordinal', 'candidate.rank', 'candidate.score',
        'candidate.inclusionState', 'candidate.contentHash', 'interaction.key',
        'interaction.signal', 'interaction.occurredAt', 'interaction.evidenceId',
        'interaction.contentHash', 'order', 'order.key', 'order.ordinal', 'order.rank',
        'retention', 'cost', 'evidence.targetManifest', 'evidence.inputHash',
        'evidence.likerSourceHash', 'evidence.commentSourceHash', 'evidence.resultHash',
        'evidence.interactorCount', 'evidence.likerCount', 'evidence.commentCount',
        'evidence.targetInteractions', 'evidence.targetInteractions.key',
        'evidence.targetInteractions.signal', 'evidence.targetInteractions.occurredAt',
        'evidence.targetInteractions.evidenceId',
    ] as const;
    return {
        report: {
            source,
            canonical,
            parity,
            logical: {
                sourceCount: logicalSource.length,
                canonicalCount: logicalCanonical.length,
                sourceChecksum: logicalSource.length > 0 ? stableHash(logicalSource) : null,
                canonicalChecksum: logicalCanonical.length > 0 ? stableHash(logicalCanonical) : null,
            },
            requiredFields,
            targetEvidence: {
                sourceCount: targetSource.length,
                canonicalCount: targetCanonical.length,
                sourceChecksum: targetSource.length > 0 ? stableHash(targetSource) : null,
                canonicalChecksum: targetCanonical.length > 0 ? stableHash(targetCanonical) : null,
                sourceInteractionCount: targetSourceInteractions.length,
                canonicalInteractionCount: targetCanonicalInteractions.length,
                sourceInteractionChecksum: targetSourceInteractions.length > 0
                    ? stableHash(targetSourceInteractions) : null,
                canonicalInteractionChecksum: targetCanonicalInteractions.length > 0
                    ? stableHash(targetCanonicalInteractions) : null,
            },
        },
        positions,
        completed,
        legacyPages,
        blocked,
        hasMore: sourceHasMore || canonicalHasMore,
        readBlocked,
    };
}

interface ExpectedCanonicalMutation {
    family: AnalysisCanonicalBackfillFamily;
    mutation: BackfillApplyMutation;
    identity: string;
    lookupValue: string;
    expected: Record<string, unknown>;
}

function expectedCanonicalMutation(
    family: AnalysisCanonicalBackfillFamily,
    mutation: BackfillApplyMutation,
): ExpectedCanonicalMutation | null {
    const row = mutation.row;
    let identity: string;
    let lookupValue: string;
    let expected: Record<string, unknown>;
    if (family === 'jobs') {
        if (typeof row.jobKey !== 'string' || typeof row.generation !== 'number') return null;
        identity = `${mutation.requestId}\0${row.jobKey}\0${row.generation}`;
        lookupValue = row.jobKey;
        expected = {
            request_id: mutation.requestId,
            job_key: row.jobKey,
            kind: row.kind,
            state: row.state,
            generation: row.generation,
            attempt_count: row.attemptCount,
            dependency_count: row.dependencyCount,
            next_attempt_at: row.nextAttemptAt,
            lease_expires_at: row.leaseExpiresAt,
            completion_hash: row.completionHash,
            payload: row.payload,
            retention_class: row.retentionClass,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
        };
    } else if (family === 'events') {
        if (typeof row.contentHash !== 'string') return null;
        // analysis_events.id is database-generated; apply's deterministic
        // event identity is the reserved content hash used by its partial
        // uniqueness fence.
        identity = `${mutation.requestId}\0${row.contentHash}`;
        lookupValue = row.contentHash;
        expected = {
            request_id: mutation.requestId,
            job_id: null,
            kind: row.kind,
            state: row.state,
            payload: row.payload,
            content_hash: row.contentHash,
            retention_class: row.retentionClass,
            created_at: row.createdAt,
        };
    } else if (family === 'artifacts') {
        if (typeof row.artifactKey !== 'string' || typeof row.contentHash !== 'string') return null;
        identity = `${mutation.requestId}\0${row.artifactKey}\0${row.contentHash}`;
        lookupValue = row.artifactKey;
        expected = {
            request_id: mutation.requestId,
            job_id: null,
            kind: row.kind,
            artifact_key: row.artifactKey,
            state: row.state,
            content_hash: row.contentHash,
            payload: row.payload,
            retention_class: row.retentionClass,
            created_at: row.createdAt,
            updated_at: row.updatedAt,
        };
    } else if (family === 'costs') {
        if (typeof row.idempotencyKey !== 'string' || typeof row.sourceHash !== 'string') return null;
        identity = `${mutation.requestId}\0${row.idempotencyKey}`;
        lookupValue = row.idempotencyKey;
        expected = {
            request_id: mutation.requestId,
            provider: row.provider,
            operation_key: row.operationKey,
            stage: row.stage,
            currency: row.currency,
            amount_known: row.amountKnown,
            amount_conservative: row.amountConservative,
            usage_unknown: row.usageUnknown,
            source_hash: row.sourceHash,
            idempotency_key: row.idempotencyKey,
            payload: row.payload,
            retention_class: row.retentionClass,
            recorded_at: row.recordedAt,
        };
    } else {
        return null;
    }
    return { family, mutation, identity, lookupValue, expected };
}

interface BackfillCanonicalProjection {
    expected: readonly ExpectedCanonicalMutation[];
    blockedReasons: readonly string[];
}

/**
 * Report-only must describe the rows that the guarded apply would send to the
 * RPC, rather than comparing unrelated physical source and destination rows.
 * Keep this projection on the same mapper and identity builder as apply so
 * generated event content identities and derived artifact keys cannot drift.
 */
function projectLegacyPages(
    family: AnalysisCanonicalBackfillFamily,
    pages: readonly BackfillLegacyPage[],
    selectedRequestIds: ReadonlySet<string>,
): BackfillCanonicalProjection {
    const expectedByIdentity = new Map<string, ExpectedCanonicalMutation>();
    const blockedReasons = new Set<string>();
    for (const page of pages) {
        for (const sourceRow of page.rows) {
            const requestId = textField(sourceRow, 'request_id', 'requestId');
            if (!requestId || !selectedRequestIds.has(requestId)) {
                blockedReasons.add(`${page.table.table}:request_identity_not_in_selected_batch`);
                continue;
            }
            const mapping = mapLegacyRowForApply(family, page.table, sourceRow);
            if (!mapping.mutation) {
                blockedReasons.add(`${page.table.table}:${mapping.blockedReason ?? 'mapping_not_proven'}`);
                continue;
            }
            const projected = expectedCanonicalMutation(family, mapping.mutation);
            if (!projected) {
                blockedReasons.add(`${page.table.table}:canonical_identity_not_proven`);
                continue;
            }
            const prior = expectedByIdentity.get(projected.identity);
            if (prior) {
                if (stableHash(prior.expected) !== stableHash(projected.expected)) {
                    blockedReasons.add(`${page.table.table}:canonical_identity_conflict`);
                }
                continue;
            }
            expectedByIdentity.set(projected.identity, projected);
        }
    }
    return {
        expected: Object.freeze([...expectedByIdentity.values()].sort((left, right) => (
            left.identity.localeCompare(right.identity)
        ))),
        blockedReasons: Object.freeze([...blockedReasons].sort()),
    };
}

function canonicalLookupColumn(family: AnalysisCanonicalBackfillFamily): string | null {
    if (family === 'jobs') return 'job_key';
    if (family === 'events') return 'content_hash';
    if (family === 'artifacts') return 'artifact_key';
    if (family === 'costs') return 'idempotency_key';
    return null;
}

function canonicalRowsForExpected(
    family: AnalysisCanonicalBackfillFamily,
    expected: readonly ExpectedCanonicalMutation[],
    canonicalRows: readonly Record<string, unknown>[],
): readonly Record<string, unknown>[] {
    const lookupColumn = canonicalLookupColumn(family);
    if (!lookupColumn || expected.length === 0) return Object.freeze([]);
    const lookups = new Set(expected.map(value => `${value.mutation.requestId}\0${value.lookupValue}`));
    return Object.freeze(canonicalRows.filter(row => {
        const requestId = textField(row, 'request_id', 'requestId');
        const lookupValue = textField(row, lookupColumn);
        // The event RPC fences only its reserved backfill copy code; a normal
        // event with the same content hash does not conflict and is not the
        // row report-only is predicting.
        const isBackfillEvent = family !== 'events'
            || (isRecord(row.payload) && row.payload.copyCode === APPLY_COPY_CODE);
        return isBackfillEvent
            && requestId !== null
            && lookupValue !== null
            && lookups.has(`${requestId}\0${lookupValue}`);
    }));
}

async function readCanonicalRowsForApply(
    client: AnalysisBackfillClient,
    spec: AnalysisCanonicalBackfillFamilySpec,
    expected: readonly ExpectedCanonicalMutation[],
): Promise<readonly Record<string, unknown>[]> {
    if (expected.length === 0) return Object.freeze([]);
    const lookupColumn = canonicalLookupColumn(spec.family);
    if (!lookupColumn) throw new Error('canonical apply re-read is unavailable for deferred family');
    const requestIds = [...new Set(expected.map(value => value.mutation.requestId))];
    const lookupValues = [...new Set(expected.map(value => value.lookupValue))];
    if (requestIds.length > BACKFILL_MAX_LIMIT || lookupValues.length > BACKFILL_MAX_LIMIT) {
        throw new Error('canonical apply re-read exceeds bounded identity set');
    }
    let query = client.from(spec.canonical.table).select(spec.canonical.columns);
    const inFilter = query.in;
    if (!inFilter) throw new Error('canonical apply re-read request filter unavailable');
    query = inFilter.call(query, 'request_id', requestIds);
    query = inFilter.call(query, lookupColumn, lookupValues);
    const result = await query.limit(BACKFILL_MAX_LIMIT + 1);
    if (result.error || !Array.isArray(result.data) || result.data.length > BACKFILL_MAX_LIMIT) {
        throw new Error('bounded canonical apply re-read failed');
    }
    const rows: Record<string, unknown>[] = [];
    for (const value of result.data) {
        if (!isRecord(value)) throw new Error('invalid canonical apply re-read row');
        rows.push(value);
    }
    return Object.freeze(spec.family === 'events'
        ? rows.filter(row => isRecord(row.payload) && row.payload.copyCode === APPLY_COPY_CODE)
        : rows);
}

function canonicalFieldEqual(key: string, expected: unknown, actual: unknown): boolean {
    if (expected === undefined || actual === undefined) return expected === actual;
    const timestampFields = new Set([
        'next_attempt_at', 'lease_expires_at', 'created_at', 'updated_at', 'recorded_at',
    ]);
    if (timestampFields.has(key)) {
        if (expected === null || actual === null) return expected === actual;
        return comparePgTimestamps(expected, actual) === 0;
    }
    if (['generation', 'attempt_count', 'dependency_count'].includes(key)) {
        const left = typeof expected === 'number' ? expected : Number(expected);
        const right = typeof actual === 'number' ? actual : Number(actual);
        return Number.isSafeInteger(left) && Number.isSafeInteger(right) && left === right;
    }
    if (['amount_known', 'amount_conservative'].includes(key)) {
        if (expected === null || actual === null) return expected === actual;
        const expectedMoney = canonicalMoneyString(expected);
        const actualMoney = canonicalMoneyString(actual);
        return expectedMoney !== null && actualMoney !== null && expectedMoney === actualMoney;
    }
    return JSON.stringify(stableValue(expected)) === JSON.stringify(stableValue(actual));
}

function canonicalMutationIdentity(family: AnalysisCanonicalBackfillFamily, row: Record<string, unknown>): string | null {
    const requestId = textField(row, 'request_id', 'requestId');
    if (!requestId || !UUID_PATTERN.test(requestId)) return null;
    if (family === 'jobs') {
        const jobKey = textField(row, 'job_key', 'jobKey');
        const generation = row.generation;
        const normalizedGeneration = typeof generation === 'number' ? generation : Number(generation);
        return jobKey && Number.isSafeInteger(normalizedGeneration)
            ? `${requestId}\0${jobKey}\0${normalizedGeneration}` : null;
    }
    if (family === 'events') {
        const contentHash = textField(row, 'content_hash', 'contentHash');
        return contentHash ? `${requestId}\0${contentHash}` : null;
    }
    if (family === 'artifacts') {
        const artifactKey = textField(row, 'artifact_key', 'artifactKey');
        const contentHash = textField(row, 'content_hash', 'contentHash');
        return artifactKey && contentHash ? `${requestId}\0${artifactKey}\0${contentHash}` : null;
    }
    if (family === 'costs') {
        const idempotencyKey = textField(row, 'idempotency_key', 'idempotencyKey');
        return idempotencyKey ? `${requestId}\0${idempotencyKey}` : null;
    }
    return null;
}

function compareAppliedCanonicalRows(
    family: AnalysisCanonicalBackfillFamily,
    expected: readonly ExpectedCanonicalMutation[],
    canonicalRows: readonly Record<string, unknown>[],
): AnalysisBackfillParitySummary {
    const expectedIdentities = new Set(expected.map(value => value.identity));
    const actualByIdentity = new Map<string, Record<string, unknown>>();
    for (const row of canonicalRows) {
        const identity = canonicalMutationIdentity(family, row);
        // Job lookups are bounded by job_key, while the natural key also
        // includes generation. Ignore an unrelated generation; exact identity
        // rows and artifact-key hash conflicts remain part of the comparison.
        if (family === 'jobs' && identity && !expectedIdentities.has(identity)) continue;
        if (!identity || actualByIdentity.has(identity)) {
            return { status: 'blocked', mismatchPaths: ['canonical.evidence'] };
        }
        actualByIdentity.set(identity, row);
    }
    let fieldMismatch = false;
    for (const value of expected) {
        const actual = actualByIdentity.get(value.identity);
        if (!actual) continue;
        for (const [key, expectedValue] of Object.entries(value.expected)) {
            if (!canonicalFieldEqual(key, expectedValue, actual[key])) {
                fieldMismatch = true;
                break;
            }
        }
        if (fieldMismatch) break;
    }
    if (fieldMismatch) return { status: 'mismatch', mismatchPaths: ['logical.row.fields'] };
    if (
        expectedIdentities.size !== actualByIdentity.size
        || [...expectedIdentities].some(identity => !actualByIdentity.has(identity))
    ) {
        return { status: 'mismatch', mismatchPaths: ['logical.row.identity'] };
    }
    return { status: 'match', mismatchPaths: [] };
}

function applyReadBlockedReport(reason: string): BackfillApplyReport {
    return {
        attempted: 0,
        applied: 0,
        blocked: 1,
        failed: 0,
        blockedReasons: [reason],
    };
}

function invalidReport(
    mode: 'report_only' | 'apply' = 'report_only',
    readBarrierBlocked = false,
): BackfillReport {
    return {
        status: 'blocked',
        mode,
        scanned: 0,
        complete: 0,
        blocked: 1,
        readBarrierBlocked,
        checksum: null,
        nextCursor: null,
        families: Object.fromEntries(
            ANALYSIS_CANONICAL_BACKFILL_FAMILIES.map(spec => [spec.family, emptyFamilyReport()]),
        ) as Record<AnalysisCanonicalBackfillFamily, BackfillFamilyReport>,
    };
}

export async function backfillAnalysisCanonical(input: {
    client?: AnalysisBackfillClient;
    limit?: number;
    cursor?: string | null;
    reportOnly?: boolean;
    apply?: boolean;
    acknowledgement?: string;
}): Promise<BackfillReport> {
    const limit = input.limit ?? BACKFILL_MAX_LIMIT;
    buildBackfillBatch([], limit);
    const apply = input.apply === true;
    if (apply && input.reportOnly === true) {
        throw new Error('Analysis canonical backfill cannot combine report-only and apply modes.');
    }
    if (apply && input.acknowledgement !== ANALYSIS_CANONICAL_BACKFILL_APPLY_ACKNOWLEDGEMENT) {
        throw new Error('Analysis canonical backfill requires the exact apply acknowledgement.');
    }
    if (!apply && input.reportOnly === false) {
        throw new Error('Analysis canonical backfill apply mode is explicit and acknowledgement-guarded.');
    }
    const client = input.client ?? (supabaseAdmin as unknown as AnalysisBackfillClient);
    let cursor: ParsedBackfillCursor | null = null;
    let restartedFromIncompatibleCursor = false;
    if (input.cursor !== undefined && input.cursor !== null) {
        try {
            cursor = parseBackfillCursor(input.cursor);
        } catch (error) {
            if (!(error instanceof IncompatibleBackfillCursorError)) {
                return invalidReport(apply ? 'apply' : 'report_only');
            }
            // v4 positions on a newly composite table cannot be resumed
            // without knowing the missing identity component. Restart from
            // the source page rather than guessing a boundary.
            cursor = null;
            restartedFromIncompatibleCursor = true;
        }
    }
    const sourcePositionKey = `${SOURCE_TABLE}:created_at:id`;
    const continuingFamilyPage = (cursor?.version === 4 || cursor?.version === COMPOSITE_CURSOR_VERSION)
        && (
            Object.keys(cursor.positions).some(key => key !== sourcePositionKey)
            || cursor.requestIds.length > 0
        );
    const familyCursor = continuingFamilyPage
        && (cursor?.version === 4 || cursor?.version === COMPOSITE_CURSOR_VERSION)
        ? cursor
        : null;
    let sourceHasMore = false;
    let sourcePage: unknown[] = [];
    let sourceBlocked = 0;
    let selectedRequestIds: string[] = [];
    const positions: Record<string, AnalysisBackfillCursorPosition> = {};
    if (continuingFamilyPage) {
        selectedRequestIds = [...familyCursor!.requestIds];
        sourceHasMore = familyCursor!.sourceHasMore;
        const sourcePosition = familyCursor!.positions[sourcePositionKey];
        if (sourcePosition) positions[sourcePositionKey] = sourcePosition;
    } else {
        let sourceResult: { data: unknown; error: BackfillRpcError | null };
        let incomingSourcePosition: AnalysisBackfillCursorPosition | null = null;
        const sourceSpec = tableSpecForPositionKey(sourcePositionKey)!;
        try {
            let sourceQuery = client.from(SOURCE_TABLE).select('id, created_at, status');
            if (cursor?.version === 1) {
                if (!sourceQuery.or) throw new Error('cursor boundary filter unavailable');
                incomingSourcePosition = {
                    createdAt: normalizePgTimestamp(cursor.createdAt)!,
                    requestId: '',
                    key: cursor.id,
                    rowHash: cursor.sourceHash,
                };
                sourceQuery = sourceQuery.or(
                    `${postgrestFilterTerm('created_at', 'gt', cursor.createdAt)},and(${postgrestFilterTerm('created_at', 'eq', cursor.createdAt)},${postgrestFilterTerm('id', 'gt', cursor.id)})`,
                );
            } else if (cursor?.version === 4 || cursor?.version === COMPOSITE_CURSOR_VERSION) {
                const position = cursor.positions[sourcePositionKey];
                if (position) {
                    incomingSourcePosition = position;
                    if (!sourceQuery.or) throw new Error('cursor boundary filter unavailable');
                    sourceQuery = sourceQuery.or(
                        `${postgrestFilterTerm('created_at', 'gt', position.createdAt)},and(${postgrestFilterTerm('created_at', 'eq', position.createdAt)},${postgrestFilterTerm('id', 'gt', position.key)})`,
                    );
                }
            }
            sourceResult = await sourceQuery
                .order('created_at', { ascending: true })
                .order('id', { ascending: true })
                .limit(limit + 1);
        } catch {
            return invalidReport(apply ? 'apply' : 'report_only', true);
        }
        if (sourceResult.error || !Array.isArray(sourceResult.data) || sourceResult.data.length > limit + 1) {
            return invalidReport(apply ? 'apply' : 'report_only', true);
        }
        if (incomingSourcePosition && sourceResult.data.length > 0) {
            const firstPosition = rowCursorPosition(sourceResult.data[0], sourceSpec);
            const firstOrder = firstPosition
                ? compareCursorPositions(incomingSourcePosition, firstPosition, sourceSpec)
                : null;
            if (firstOrder === null || firstOrder >= 0) {
                return invalidReport(apply ? 'apply' : 'report_only', true);
            }
        }
        sourceHasMore = sourceResult.data.length > limit;
        if (sourceHasMore && !isSourceRow(sourceResult.data[limit])) {
            return invalidReport(apply ? 'apply' : 'report_only', true);
        }
        sourcePage = sourceHasMore ? sourceResult.data.slice(0, limit) : sourceResult.data;
        const validRows = sourcePage.filter(isSourceRow);
        sourceBlocked = sourcePage.length - validRows.length;
        selectedRequestIds = validRows.map(row => row.id);
        if (selectedRequestIds.length > BACKFILL_MAX_LIMIT) {
            return invalidReport(apply ? 'apply' : 'report_only', true);
        }
        if (validRows.length > 0 && sourceHasMore) {
            const row = validRows.at(-1)!;
            positions[sourcePositionKey] = {
                createdAt: normalizePgTimestamp(row.created_at)!,
                requestId: '',
                key: row.id,
                rowHash: stableHash(row),
            };
        }
    }
    const familyReports = {} as Record<AnalysisCanonicalBackfillFamily, BackfillFamilyReport>;
    const familyResults: Array<{
        spec: AnalysisCanonicalBackfillFamilySpec;
        family: Awaited<ReturnType<typeof readFamily>>;
        parity: AnalysisBackfillParitySummary;
    }> = [];
    let familyBlocked = 0;
    let familyHasMore = false;
    let applyFailed = false;
    let applyBlocked = 0;
    let readBarrierBlocked = sourceBlocked > 0;
    const completedTables = new Set<string>(
        familyCursor ? familyCursor.completed : [],
    );
    const priorFamilyEvidence: Readonly<Partial<Record<AnalysisCanonicalBackfillFamily, AnalysisBackfillParitySummary>>> =
        (cursor?.version === 4 || cursor?.version === COMPOSITE_CURSOR_VERSION)
            ? cursor.familyEvidence
            : {};
    const familyEvidence: Partial<Record<AnalysisCanonicalBackfillFamily, AnalysisBackfillParitySummary>> = {
        ...priorFamilyEvidence,
    };
    for (const spec of ANALYSIS_CANONICAL_BACKFILL_FAMILIES) {
        const family = await readFamily(
            client,
            spec,
            limit,
            familyCursor,
            selectedRequestIds,
            apply,
        );
        const parity = apply
            ? { status: 'blocked', mismatchPaths: ['canonical.missing'] } as const
            : mergeParityEvidence(
                family.report.parity,
                priorFamilyEvidence[spec.family],
            );
        const report = parity === family.report.parity
            ? family.report
            : { ...family.report, parity };
        familyResults.push({ spec, family, parity });
        familyReports[spec.family] = report;
        if (!apply && parity.status !== 'match') familyEvidence[spec.family] = parity;
        readBarrierBlocked ||= family.readBlocked;
        familyBlocked += family.blocked;
        familyHasMore ||= family.hasMore;
        family.completed.forEach(table => completedTables.add(table));
        Object.assign(positions, family.positions);
    }
    const applyRun: BackfillApplyRun = {
        budget: { attempted: 0, limit: BACKFILL_MAX_LIMIT },
        appliedMutations: [],
        stopped: false,
        stopTableKey: null,
        stopPosition: null,
    };
    const applyResults = new Map<AnalysisCanonicalBackfillFamily, BackfillApplyFamilyResult>();
    if (apply) {
        for (const { spec, family } of familyResults) {
            let result: BackfillApplyFamilyResult;
            if (spec.deferred) {
                result = {
                    report: applyReadBlockedReport('deferred_family'),
                    lastProcessedPosition: null,
                    stopped: false,
                };
            } else if (readBarrierBlocked) {
                result = {
                    report: applyReadBlockedReport('read_blocked'),
                    lastProcessedPosition: null,
                    stopped: false,
                };
            } else {
                result = await applyLegacyPages(
                    client,
                    spec.family,
                    family.legacyPages,
                    new Set(selectedRequestIds),
                    input.acknowledgement!,
                    applyRun,
                );
            }
            applyResults.set(spec.family, result);
            familyReports[spec.family] = { ...familyReports[spec.family]!, apply: result.report };
            applyFailed ||= result.report.failed > 0;
            applyBlocked += result.report.blocked;
            familyBlocked += result.report.blocked + result.report.failed;
        }
    }

    let postParityBlocked = false;
    if (apply && !readBarrierBlocked) {
        for (const { spec } of familyResults) {
            if (spec.deferred) continue;
            const expected = applyRun.appliedMutations
                .filter(value => value.family === spec.family)
                .map(value => expectedCanonicalMutation(spec.family, value.mutation));
            const familyApply = applyResults.get(spec.family)!;
            let parity: AnalysisBackfillParitySummary;
            if (expected.some(value => value === null)) {
                parity = { status: 'blocked', mismatchPaths: ['source.evidence'] };
            } else if (expected.length === 0) {
                parity = familyApply.report.failed > 0 || familyApply.report.blocked > 0
                    ? { status: 'blocked', mismatchPaths: ['canonical.missing'] }
                    : { status: 'match', mismatchPaths: [] };
            } else {
                try {
                    const canonicalRows = await readCanonicalRowsForApply(
                        client,
                        spec,
                        expected as ExpectedCanonicalMutation[],
                    );
                    parity = compareAppliedCanonicalRows(
                        spec.family,
                        expected as ExpectedCanonicalMutation[],
                        canonicalRows,
                    );
                } catch {
                    parity = { status: 'blocked', mismatchPaths: ['canonical.evidence'] };
                }
            }
            familyReports[spec.family] = { ...familyReports[spec.family]!, parity };
            if (parity.status !== 'match') {
                familyEvidence[spec.family] = parity;
                familyBlocked += 1;
                if (expected.length > 0) postParityBlocked = true;
            }
        }
    } else if (apply) {
        for (const { spec } of familyResults) {
            if (!spec.deferred) {
                const parity: AnalysisBackfillParitySummary = {
                    status: 'blocked',
                    mismatchPaths: ['source.missing'],
                };
                familyReports[spec.family] = { ...familyReports[spec.family]!, parity };
                familyEvidence[spec.family] = parity;
            }
        }
    }
    const sourceRows = sourcePage.filter(isSourceRow);
    if (familyHasMore && selectedRequestIds.length > 0 && !positions[sourcePositionKey]) {
        const row = sourceRows.at(-1);
        if (row) {
            positions[sourcePositionKey] = {
                createdAt: normalizePgTimestamp(row.created_at)!,
                requestId: '',
                key: row.id,
                rowHash: stableHash(row),
            };
        }
    }
    if (apply && applyRun.stopped && !readBarrierBlocked && applyRun.stopTableKey) {
        let stopReached = false;
        for (const spec of ANALYSIS_CANONICAL_BACKFILL_FAMILIES) {
            for (const table of spec.legacy) {
                const tableKey = tablePositionKey(table);
                if (tableKey === applyRun.stopTableKey) {
                    stopReached = true;
                    completedTables.delete(tableKey);
                    const resumePosition = applyRun.stopPosition ?? cursorPosition(familyCursor, table);
                    if (resumePosition) positions[tableKey] = resumePosition;
                    else delete positions[tableKey];
                    continue;
                }
                if (!stopReached || cursorTableCompleted(familyCursor, table)) continue;
                completedTables.delete(tableKey);
                const priorPosition = cursorPosition(familyCursor, table);
                if (priorPosition) positions[tableKey] = priorPosition;
                else delete positions[tableKey];
            }
        }
    }
    const applyParityBlocked = apply && postParityBlocked;
    const hasContinuation = familyHasMore || sourceHasMore || (apply && applyRun.stopped);
    const hasCursorContinuation = hasContinuation && (
        Object.keys(positions).length > 0
        || (apply && applyRun.stopped && selectedRequestIds.length > 0)
    );
    const nextCursor = apply && (readBarrierBlocked || applyParityBlocked)
        ? restartedFromIncompatibleCursor ? null : input.cursor ?? null
        : hasCursorContinuation
        ? Buffer.from(JSON.stringify({
            version: COMPOSITE_CURSOR_VERSION,
            positions,
            requestIds: (familyHasMore || (apply && applyRun.stopped)) ? selectedRequestIds : [],
            sourceHasMore,
            completed: [...completedTables],
            familyEvidence,
        } satisfies AnalysisBackfillCursorV5), 'utf8')
            .toString('base64url')
        : null;
    const reportComplete = continuingFamilyPage
        ? selectedRequestIds.length
        : sourceRows.length;
    const reportChecksum = continuingFamilyPage
        ? null
        : sourceBlocked > 0 || sourceRows.length === 0
            ? null
            : stableHash(sourceRows.map(sourceBackfillIdempotency));
    const blockedResult = hasContinuation || sourceBlocked > 0 || familyBlocked > 0 || Object.values(familyReports).some(
        report => report.parity.status !== 'match',
    );
    return {
        status: apply
            ? (readBarrierBlocked || applyFailed || applyBlocked > 0 || applyParityBlocked ? 'blocked' : 'applied')
            : (blockedResult ? 'blocked' : 'report_only'),
        mode: apply ? 'apply' : 'report_only',
        scanned: continuingFamilyPage ? selectedRequestIds.length : sourcePage.length,
        complete: reportComplete,
        blocked: sourceBlocked + familyBlocked,
        readBarrierBlocked,
        checksum: reportChecksum,
        nextCursor,
        families: familyReports,
    };
}

async function main(): Promise<void> {
    try {
        const args = parseBackfillCliArgs(process.argv.slice(2));
        const report = await backfillAnalysisCanonical(args);
        process.stdout.write(`${JSON.stringify(report)}\n`);
    } catch {
        process.stdout.write(JSON.stringify(invalidReport()) + '\n');
        process.exitCode = 1;
    }
}

if (process.argv[1]?.endsWith('backfill-analysis-canonical.ts')) {
    void main();
}
