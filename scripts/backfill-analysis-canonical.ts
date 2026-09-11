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
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

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
            },
            {
                table: 'analysis_v2_dag_batch_topology',
                columns: 'request_id, topology_kind, batch, created_at',
                timeColumn: 'created_at',
                keyColumn: 'batch',
            },
            {
                table: 'analysis_v2_dag_batch_results',
                columns: 'request_id, result_kind, batch, created_at',
                timeColumn: 'created_at',
                keyColumn: 'batch',
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
            },
            {
                table: 'analysis_v2_relationship_rows',
                columns: 'request_id, job_key, side, created_at',
                timeColumn: 'created_at',
                keyColumn: 'job_key',
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
            },
            {
                table: 'analysis_v2_candidate_feature_manifests',
                columns: 'request_id, batch, created_at',
                timeColumn: 'created_at',
                keyColumn: 'batch',
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
            },
            {
                table: 'analysis_v2_cost_rollup_snapshots',
                columns: 'request_id, rollup_version, created_at',
                timeColumn: 'created_at',
                keyColumn: 'rollup_version',
            },
            {
                table: 'analysis_provider_cost_ledger',
                columns: 'request_id, run_id, logical_provider, operation_key, credential_slot, status, max_charge_usd, usage_total_usd, started_at, terminal_at, created_at, updated_at',
                timeColumn: 'created_at',
                keyColumn: 'run_id',
            },
        ]),
        canonicalTable: 'analysis_costs',
        canonical: {
            table: 'analysis_costs',
            columns: 'id, request_id, provider, operation_key, stage, currency, amount_known, amount_conservative, usage_unknown, source_hash, idempotency_key, payload, retention_class, recorded_at',
            timeColumn: 'recorded_at',
            keyColumn: 'id',
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

interface AnalysisBackfillCursorV4 {
    version: 4;
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

type ParsedBackfillCursor = AnalysisBackfillCursorV1 | AnalysisBackfillCursorV4;

function isSourceRow(value: unknown): value is AnalysisBackfillSourceRow {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return typeof row.id === 'string'
        && UUID_PATTERN.test(row.id)
        && typeof row.created_at === 'string'
        && row.created_at.length > 0
        && row.created_at.length <= 128
        && TIMESTAMP_PATTERN.test(row.created_at)
        && Number.isFinite(Date.parse(row.created_at))
        && typeof row.status === 'string'
        && row.status.length > 0
        && row.status.length <= 64;
}

function isSafeTimestamp(value: unknown): value is string {
    return typeof value === 'string'
        && TIMESTAMP_PATTERN.test(value)
        && Number.isFinite(Date.parse(value));
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
    if (
        row.version !== 4
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
    for (const [table, value] of Object.entries(row.positions as Record<string, unknown>)) {
        if (table.length < 1 || table.length > 256 || !isKnownBackfillPositionKey(table)) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        const position = value as Record<string, unknown>;
        if (
            Object.keys(position).length !== 4
            ||
            !isSafeTimestamp(position.createdAt)
            || typeof position.requestId !== 'string'
            || (position.requestId !== '' && !UUID_PATTERN.test(position.requestId))
            || typeof position.key !== 'string'
            || !KEY_PATTERN.test(position.key)
            || typeof position.rowHash !== 'string'
            || !/^[a-f0-9]{64}$/.test(position.rowHash)
        ) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        const sourcePosition = table === `${SOURCE_TABLE}:created_at:id`;
        if ((position.requestId === '') !== sourcePosition) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        positions[table] = {
            createdAt: position.createdAt,
            requestId: position.requestId,
            key: position.key,
            rowHash: position.rowHash,
        };
    }
    if (row.sourceHasMore === true && !positions[`${SOURCE_TABLE}:created_at:id`]) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const familyEvidence = parseFamilyEvidence(row.familyEvidence);
    return {
        version: 4,
        positions,
        requestIds: Object.freeze([...(requestIds as string[])]),
        sourceHasMore: row.sourceHasMore ?? false,
        completed: Object.freeze([...(completed as string[])]),
        familyEvidence,
    };
}

function isKnownBackfillPositionKey(value: string): boolean {
    if (value === `${SOURCE_TABLE}:created_at:id`) return true;
    return ANALYSIS_CANONICAL_BACKFILL_FAMILIES.some(spec => (
        [...spec.legacy, spec.canonical].some(table => tablePositionKey(table) === value)
    ));
}

function compareRows(left: AnalysisBackfillSourceRow, right: AnalysisBackfillSourceRow): number {
    const created = left.created_at.localeCompare(right.created_at);
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
        amountKnown: number | null;
        amountConservative: number | null;
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
        const occurredAt = textField(candidate, 'occurredAt', 'occurred_at', 'created_at');
        const evidenceId = textField(candidate, 'evidenceId', 'evidence_id', 'source_interaction_id', 'content_hash');
        if (
            !key
            || (signal !== 'target_post_like' && signal !== 'target_post_comment')
            || (occurredAt !== null && (!TIMESTAMP_PATTERN.test(occurredAt) || !Number.isFinite(Date.parse(occurredAt))))
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
    const occurredAt = textFieldFrom(
        row,
        interactionPayload,
        'occurred_at', 'occurredAt', 'created_at', 'recorded_at',
    );
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
                amountKnown: numericFieldFrom(row, payload, 'amount_known', 'cost_known_usd', 'usage_total_usd', 'amountKnown'),
                amountConservative: numericFieldFrom(row, payload, 'amount_conservative', 'cost_conservative_usd', 'amountConservative'),
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
): number | null {
    const value = row[key];
    if (value === null || value === undefined) return null;
    const raw = typeof value === 'number'
        ? value.toString()
        : typeof value === 'string'
            ? value.trim()
            : '';
    // analysis_costs is NUMERIC(18,12): reject values that would round or
    // overflow when copied instead of silently changing a source amount.
    const match = /^(\d+)(?:\.(\d{1,12}))?$/.exec(raw);
    if (!match || match[1]!.replace(/^0+/, '').length > 6) return null;
    const numeric = Number(raw);
    return Number.isFinite(numeric) && numeric >= 0 ? numeric : null;
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
    if (!position || !position.requestId) return null;
    const envelope = sourceEnvelope(table.table, row);
    if (!envelope) return null;
    return {
        requestId: position.requestId,
        sourceKey: position.key,
        sourceHash: stableHash({ sourceTable: table.table, sourceKey: position.key, row }),
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
    if (!isSafeTimestamp(createdAt) || !isSafeTimestamp(updatedAt) || Date.parse(updatedAt) < Date.parse(createdAt)) {
        return { blockedReason: 'jobs_timestamp_invalid' };
    }
    const leaseExpiresAt = row.lease_expires_at === null || row.lease_expires_at === undefined
        ? null
        : row.lease_expires_at;
    if (
        (leaseExpiresAt !== null && !isSafeTimestamp(leaseExpiresAt))
        || (status === 'processing' && leaseExpiresAt === null)
        || (leaseExpiresAt !== null && Date.parse(leaseExpiresAt) <= Date.parse(updatedAt))
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
    if (!isSafeTimestamp(createdAt) || !isSafeTimestamp(updatedAt) || Date.parse(updatedAt) < Date.parse(createdAt)) {
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
    let amountKnown: number | null;
    let amountConservative: number | null;
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
): Promise<BackfillApplyReport & { failed: number }> {
    let attempted = 0;
    let applied = 0;
    let blocked = 0;
    let failed = 0;
    const blockedReasons = new Set<string>();
    if (pages.length === 0) {
        return { attempted, applied, blocked, failed, blockedReasons: [] };
    }
    for (const page of pages) {
        // Each page is read with `limit + 1`, then reduced to at most limit.
        // Apply one row per RPC so a failed row can be retried from the same
        // input cursor without ever skipping a source row.
        for (const sourceRow of page.rows) {
            const requestId = textField(sourceRow, 'request_id', 'requestId');
            if (!requestId || !selectedRequestIds.has(requestId)) {
                blocked += 1;
                blockedReasons.add('request_identity_not_in_selected_batch');
                continue;
            }
            const mapping = mapLegacyRowForApply(family, page.table, sourceRow);
            if (!mapping.mutation) {
                blocked += 1;
                blockedReasons.add(`${page.table.table}:${mapping.blockedReason ?? 'mapping_not_proven'}`);
                continue;
            }
            attempted += 1;
            if (!client.rpc) {
                failed += 1;
                blockedReasons.add('apply_rpc_unavailable');
                return { attempted, applied, blocked, failed, blockedReasons: [...blockedReasons].sort() };
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
                return { attempted, applied, blocked, failed, blockedReasons: [...blockedReasons].sort() };
            }
            if (result.error || !isRecord(result.data) || result.data.status !== 'applied') {
                failed += 1;
                blockedReasons.add('apply_rpc_rejected');
                return { attempted, applied, blocked, failed, blockedReasons: [...blockedReasons].sort() };
            }
            applied += 1;
        }
    }
    return { attempted, applied, blocked, failed, blockedReasons: [...blockedReasons].sort() };
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
            parseBackfillCursor(next);
            cursor = next;
            continue;
        }
        if (arg.startsWith('--cursor=')) {
            const next = arg.slice('--cursor='.length);
            parseBackfillCursor(next);
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

function rowCursorPosition(row: unknown, spec: BackfillTableSpec): AnalysisBackfillCursorPosition | null {
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    const value = row as Record<string, unknown>;
    const rawCreatedAt = value[spec.timeColumn] ?? value.created_at;
    const rawKey = value[spec.keyColumn] ?? value.id;
    const requestId = spec.requestIdColumn === null
        ? ''
        : value[spec.requestIdColumn ?? 'request_id'] ?? value.request_id;
    const normalizedKey = typeof rawKey === 'number' && Number.isSafeInteger(rawKey)
        ? String(rawKey)
        : rawKey;
    if (
        !isSafeTimestamp(rawCreatedAt)
        || typeof requestId !== 'string'
        || (requestId !== '' && !UUID_PATTERN.test(requestId))
        || typeof normalizedKey !== 'string'
        || !KEY_PATTERN.test(normalizedKey)
    ) return null;
    return {
        createdAt: rawCreatedAt,
        requestId,
        key: normalizedKey,
        rowHash: stableHash(value),
    };
}

function cursorPosition(
    cursor: ParsedBackfillCursor | null,
    spec: BackfillTableSpec,
): AnalysisBackfillCursorPosition | null {
    if (!cursor || cursor.version !== 4) return null;
    return cursor.positions[tablePositionKey(spec)] ?? null;
}

function cursorTableCompleted(
    cursor: ParsedBackfillCursor | null,
    table: BackfillTableSpec,
): boolean {
    return cursor?.version === 4
        && cursor.completed.includes(tablePositionKey(table));
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
    if (selectedRequestIds.length > 0) {
        if (query.in) {
            query = query.in(requestIdColumn, selectedRequestIds);
        } else if (query.or) {
            // Lightweight adapters used by the regression suite may expose
            // only PostgREST's OR builder.  Keep the selected UUID set in the
            // expression; production clients use `in` above.
            query = query.or(`${requestIdColumn}.in.(${selectedRequestIds.join(',')})`);
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
            query = query.or(`${requestIdColumn}.eq.00000000-0000-4000-8000-000000000000`);
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
            query = query.or(`${requestIdColumn}.eq.00000000-0000-4000-8000-000000000000`);
        } else {
            throw new Error('request selection filter unavailable');
        }
    }
    if (position) {
        if (!query.or) throw new Error('keyset boundary filter unavailable');
        query = query.or(
            `${spec.timeColumn}.gt.${position.createdAt},and(${spec.timeColumn}.eq.${position.createdAt},${requestIdColumn}.gt.${position.requestId}),and(${spec.timeColumn}.eq.${position.createdAt},${requestIdColumn}.eq.${position.requestId},${spec.keyColumn}.gt.${position.key})`,
        );
    }
    // Read one sentinel row. A page with exactly `limit` rows is complete
    // because the query asked for `limit + 1`; a page with the sentinel is
    // explicitly incomplete and must never report parity.
    query = query.order(spec.timeColumn, { ascending: true });
    query = query.order(requestIdColumn, { ascending: true });
    query = query.order(spec.keyColumn, { ascending: true });
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
    for (let index = 1; index < positionsOnPage.length; index += 1) {
        const previous = positionsOnPage[index - 1]!;
        const current = positionsOnPage[index]!;
        if (
            current.createdAt < previous.createdAt
            || (current.createdAt === previous.createdAt && current.requestId < previous.requestId)
            || (current.createdAt === previous.createdAt
                && current.requestId === previous.requestId
                && current.key <= previous.key)
        ) {
            throw new Error('ambiguous analysis canonical backfill cursor order');
        }
    }
    // A `(time,request,key)` tie without a unique physical key cannot be safely
    // resumed by a PostgREST boundary. Refuse the page rather than silently
    // skipping or duplicating evidence.  The sentinel is intentionally
    // inspected before it is discarded.
    const seenComposite = new Set<string>();
    for (const positionOnPage of positionsOnPage) {
        const composite = `${positionOnPage.createdAt}\0${positionOnPage.requestId}\0${positionOnPage.key}`;
        if (seenComposite.has(composite)) {
            throw new Error('ambiguous analysis canonical backfill cursor tie');
        }
        seenComposite.add(composite);
    }
    if (hasMore) {
        const sentinel = rowCursorPosition(result.data[limit], spec);
        const last = positionsOnPage.at(-1);
        if (!sentinel || !last) throw new Error('invalid analysis canonical backfill sentinel');
        if (
            sentinel.createdAt === last.createdAt
            && sentinel.requestId === last.requestId
            && sentinel.key === last.key
        ) {
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
): Promise<{
    report: BackfillFamilyReport;
    positions: Record<string, AnalysisBackfillCursorPosition>;
    completed: readonly string[];
    legacyPages: readonly BackfillLegacyPage[];
    blocked: number;
    hasMore: boolean;
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
                hasMore: page.hasMore,
            });
            legacyRows.push(...page.rows);
            sourceHasMore ||= page.hasMore;
            if (page.hasMore && page.next) positions[tableKey] = page.next;
            if (!page.hasMore) completed.push(tableKey);
        } catch {
            sourceComplete = false;
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
        blocked += 1;
        if (canonicalPriorPosition) positions[canonicalTableKey] = canonicalPriorPosition;
    }
    }
    const source = aggregateRows(legacyRows, sourceComplete && !sourceHasMore);
    const canonical = aggregateRows(canonicalRows, canonicalComplete && !canonicalHasMore);
    const logicalSource = normalizeBackfillFamilyRows(spec.family, legacyRows, selectedRequestIds);
    const logicalCanonical = normalizeBackfillFamilyRows(spec.family, canonicalRows, selectedRequestIds);
    const parity: AnalysisBackfillParitySummary = !sourceComplete || sourceHasMore
        ? { status: 'blocked', mismatchPaths: ['source.missing'] }
        : !canonicalComplete || canonicalHasMore
            ? { status: 'blocked', mismatchPaths: ['canonical.missing'] }
            : compareNormalizedBackfillFamilyRows(
                spec.family,
                legacyRows,
                canonicalRows,
                selectedRequestIds,
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
    };
}

function invalidReport(): BackfillReport {
    return {
        status: 'blocked',
        mode: 'report_only',
        scanned: 0,
        complete: 0,
        blocked: 1,
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
    if (input.cursor !== undefined && input.cursor !== null) {
        try {
            cursor = parseBackfillCursor(input.cursor);
        } catch {
            return invalidReport();
        }
    }
    const sourcePositionKey = `${SOURCE_TABLE}:created_at:id`;
    const continuingFamilyPage = cursor?.version === 4
        && Object.keys(cursor.positions).some(key => key !== sourcePositionKey);
    const familyCursor = continuingFamilyPage && cursor?.version === 4 ? cursor : null;
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
        try {
            let sourceQuery = client.from(SOURCE_TABLE).select('id, created_at, status');
            if (cursor?.version === 1) {
                if (!sourceQuery.or) throw new Error('cursor boundary filter unavailable');
                sourceQuery = sourceQuery.or(
                    `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`,
                );
            } else if (cursor?.version === 4) {
                const position = cursor.positions[sourcePositionKey];
                if (position) {
                    if (!sourceQuery.or) throw new Error('cursor boundary filter unavailable');
                    sourceQuery = sourceQuery.or(
                        `created_at.gt.${position.createdAt},and(created_at.eq.${position.createdAt},id.gt.${position.key})`,
                    );
                }
            }
            sourceResult = await sourceQuery
                .order('created_at', { ascending: true })
                .order('id', { ascending: true })
                .limit(limit + 1);
        } catch {
            return invalidReport();
        }
        if (sourceResult.error || !Array.isArray(sourceResult.data) || sourceResult.data.length > limit + 1) {
            return invalidReport();
        }
        sourceHasMore = sourceResult.data.length > limit;
        sourcePage = sourceHasMore ? sourceResult.data.slice(0, limit) : sourceResult.data;
        const validRows = sourcePage.filter(isSourceRow);
        sourceBlocked = sourcePage.length - validRows.length;
        selectedRequestIds = validRows.map(row => row.id);
        if (selectedRequestIds.length > BACKFILL_MAX_LIMIT) return invalidReport();
        if (validRows.length > 0 && sourceHasMore) {
            const row = validRows.at(-1)!;
            positions[sourcePositionKey] = {
                createdAt: row.created_at,
                requestId: '',
                key: row.id,
                rowHash: stableHash(row),
            };
        }
    }
    const familyReports = {} as Record<AnalysisCanonicalBackfillFamily, BackfillFamilyReport>;
    let familyBlocked = 0;
    let familyHasMore = false;
    let applyFailed = false;
    let applyBlocked = 0;
    const completedTables = new Set<string>(
        familyCursor ? familyCursor.completed : [],
    );
    const priorFamilyEvidence: Readonly<Partial<Record<AnalysisCanonicalBackfillFamily, AnalysisBackfillParitySummary>>> =
        cursor?.version === 4 ? cursor.familyEvidence : {};
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
        );
        const parity = mergeParityEvidence(
            family.report.parity,
            priorFamilyEvidence[spec.family],
        );
        const report = parity === family.report.parity
            ? family.report
            : { ...family.report, parity };
        const familyApply = apply
            ? spec.deferred
                ? {
                    attempted: 0,
                    applied: 0,
                    blocked: 1,
                    failed: 0,
                    blockedReasons: ['deferred_family'],
                }
                : await applyLegacyPages(
                    client,
                    spec.family,
                    family.legacyPages,
                    new Set(selectedRequestIds),
                    input.acknowledgement!,
                )
            : undefined;
        if (familyApply) {
            familyReports[spec.family] = { ...report, apply: familyApply };
            applyFailed ||= familyApply.failed > 0;
            applyBlocked += familyApply.blocked;
        } else {
            familyReports[spec.family] = report;
        }
        if (parity.status !== 'match') familyEvidence[spec.family] = parity;
        familyBlocked += family.blocked + (familyApply?.blocked ?? 0) + (familyApply?.failed ?? 0);
        familyHasMore ||= family.hasMore;
        family.completed.forEach(table => completedTables.add(table));
        Object.assign(positions, family.positions);
    }
    const sourceRows = sourcePage.filter(isSourceRow);
    if (familyHasMore && selectedRequestIds.length > 0 && !positions[sourcePositionKey]) {
        const row = sourceRows.at(-1);
        if (row) {
            positions[sourcePositionKey] = {
                createdAt: row.created_at,
                requestId: '',
                key: row.id,
                rowHash: stableHash(row),
            };
        }
    }
    const hasContinuation = familyHasMore || sourceHasMore;
    const nextCursor = applyFailed
        ? input.cursor ?? null
        : hasContinuation && Object.keys(positions).length > 0
        ? Buffer.from(JSON.stringify({
            version: 4,
            positions,
            requestIds: familyHasMore ? selectedRequestIds : [],
            sourceHasMore,
            completed: [...completedTables],
            familyEvidence,
        } satisfies AnalysisBackfillCursorV4), 'utf8')
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
            ? (applyFailed || applyBlocked > 0 ? 'blocked' : 'applied')
            : (blockedResult ? 'blocked' : 'report_only'),
        mode: apply ? 'apply' : 'report_only',
        scanned: continuingFamilyPage ? selectedRequestIds.length : sourcePage.length,
        complete: reportComplete,
        blocked: sourceBlocked + familyBlocked,
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
