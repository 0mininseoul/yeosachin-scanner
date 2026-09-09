import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const BACKFILL_MAX_LIMIT = 100;
const SOURCE_TABLE = 'analysis_requests';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export type AnalysisCanonicalBackfillFamily =
    | 'jobs'
    | 'events'
    | 'artifacts'
    | 'costs'
    | 'cache'
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
    or?(expression: string): BackfillQuery;
    order(column: string, options: { ascending: boolean }): BackfillQuery;
    limit(limit: number): PromiseLike<{
        data: unknown;
        error: BackfillRpcError | null;
    }>;
}

export interface AnalysisBackfillClient {
    from(table: string): BackfillQuery;
}

export interface BackfillBatch {
    rows: readonly AnalysisBackfillSourceRow[];
    checksum: string;
}

export interface AnalysisBackfillParitySummary {
    status: 'match' | 'mismatch' | 'blocked';
    mismatchPaths: string[];
}

export interface BackfillFamilyReport {
    source: { count: number; checksum: string | null; complete: boolean };
    canonical: { count: number; checksum: string | null; complete: boolean };
    parity: AnalysisBackfillParitySummary;
}

export interface BackfillReport {
    status: 'report_only' | 'blocked';
    scanned: number;
    complete: number;
    blocked: number;
    checksum: string | null;
    nextCursor: string | null;
    families: Readonly<Record<AnalysisCanonicalBackfillFamily, BackfillFamilyReport>>;
}

export interface BackfillCliArgs {
    limit: number;
    reportOnly: true;
    cursor?: string;
}

interface BackfillTableSpec {
    table: string;
    columns: string;
    timeColumn: string;
    keyColumn: string;
}

export interface AnalysisCanonicalBackfillFamilySpec {
    family: AnalysisCanonicalBackfillFamily;
    legacyTables: readonly string[];
    legacy: readonly BackfillTableSpec[];
    canonicalTable: string;
    canonical: BackfillTableSpec;
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
                columns: 'request_id, job_key, kind, status, dispatch_generation, attempt_count, created_at, updated_at',
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
            columns: 'id, request_id, job_key, kind, state, generation, attempt_count, dependency_count, completion_hash, retention_class, created_at, updated_at',
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
            columns: 'id, request_id, job_id, kind, state, content_hash, retention_class, created_at',
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
                table: 'analysis_target_interactors',
                columns: 'request_id, job_key, created_at',
                timeColumn: 'created_at',
                keyColumn: 'job_key',
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
            columns: 'id, request_id, job_id, kind, artifact_key, state, content_hash, retention_class, created_at, updated_at',
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
                columns: 'request_id, run_id, logical_provider, status, usage_total_usd, terminal_at, created_at',
                timeColumn: 'created_at',
                keyColumn: 'run_id',
            },
        ]),
        canonicalTable: 'analysis_costs',
        canonical: {
            table: 'analysis_costs',
            columns: 'id, request_id, provider, operation_key, stage, currency, amount_known, amount_conservative, usage_unknown, source_hash, retention_class, recorded_at',
            timeColumn: 'recorded_at',
            keyColumn: 'id',
        },
    },
    {
        family: 'cache',
        legacyTables: Object.freeze(['ai_analysis_cache', 'analysis_v2_ai_global_result_cache']),
        legacy: Object.freeze([
            {
                table: 'ai_analysis_cache',
                columns: 'id, created_at, updated_at',
                timeColumn: 'updated_at',
                keyColumn: 'id',
            },
            {
                table: 'analysis_v2_ai_global_result_cache',
                columns: 'cache_key, stage, result_hash, created_at, expires_at',
                timeColumn: 'created_at',
                keyColumn: 'cache_key',
            },
        ]),
        canonicalTable: 'analysis_cache',
        canonical: {
            table: 'analysis_cache',
            columns: 'id, scope, cache_key_hash, state, expires_at, created_at, updated_at',
            timeColumn: 'updated_at',
            keyColumn: 'id',
        },
    },
    {
        family: 'audit',
        legacyTables: Object.freeze([
            'analysis_order_audit_assembly_queue',
            'analysis_order_audit_bundles',
            'analysis_order_audit_candidates',
            'analysis_order_audit_interactions',
        ]),
        legacy: Object.freeze([
            {
                table: 'analysis_order_audit_assembly_queue',
                columns: 'request_id, status, created_at, updated_at',
                timeColumn: 'updated_at',
                keyColumn: 'request_id',
            },
            {
                table: 'analysis_order_audit_bundles',
                columns: 'request_id, version, bundle_hash, completeness_status, cost_status, assembled_at, created_at',
                timeColumn: 'assembled_at',
                keyColumn: 'version',
            },
            {
                table: 'analysis_order_audit_candidates',
                columns: 'request_id, version, candidate_id, final_inclusion_state, created_at',
                timeColumn: 'created_at',
                keyColumn: 'candidate_id',
            },
            {
                table: 'analysis_order_audit_interactions',
                columns: 'request_id, version, ordinal, signal, completeness_status, created_at',
                timeColumn: 'created_at',
                keyColumn: 'ordinal',
            },
        ]),
        canonicalTable: 'analysis_audit_bundles',
        canonical: {
            table: 'analysis_audit_bundles',
            columns: 'id, request_id, version, kind, candidate_key, ordinal, state, content_hash, retention_class, created_at',
            timeColumn: 'created_at',
            keyColumn: 'id',
        },
    },
]);

interface AnalysisBackfillCursorPosition {
    createdAt: string;
    key: string;
    rowHash: string;
}

interface AnalysisBackfillCursorV2 {
    version: 2;
    positions: Record<string, AnalysisBackfillCursorPosition>;
}

interface AnalysisBackfillCursorV1 {
    version: 1;
    id: string;
    createdAt: string;
    status: string;
    sourceHash: string;
}

type ParsedBackfillCursor = AnalysisBackfillCursorV1 | AnalysisBackfillCursorV2;

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
    if (row.version !== 2 || !row.positions || typeof row.positions !== 'object' || Array.isArray(row.positions)) {
        throw new Error('Analysis canonical backfill cursor is unknown.');
    }
    const positions: Record<string, AnalysisBackfillCursorPosition> = {};
    for (const [table, value] of Object.entries(row.positions as Record<string, unknown>)) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        const position = value as Record<string, unknown>;
        if (
            !isSafeTimestamp(position.createdAt)
            || typeof position.key !== 'string'
            || !KEY_PATTERN.test(position.key)
            || typeof position.rowHash !== 'string'
            || !/^[a-f0-9]{64}$/.test(position.rowHash)
        ) {
            throw new Error('Analysis canonical backfill cursor is unknown.');
        }
        positions[table] = {
            createdAt: position.createdAt,
            key: position.key,
            rowHash: position.rowHash,
        };
    }
    return { version: 2, positions };
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

export function parseBackfillCliArgs(argv: readonly string[]): BackfillCliArgs {
    let limit = BACKFILL_MAX_LIMIT;
    let reportOnly = false;
    let cursor: string | undefined;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === '--report-only') {
            reportOnly = true;
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
        if (['--apply', '--drop', '--truncate', '--delete', '--mutate'].includes(arg)) {
            throw new Error('Analysis canonical backfill is report-only; destructive/apply options are blocked.');
        }
        throw new Error('Analysis canonical backfill accepts only --limit and --report-only.');
    }
    if (!reportOnly) {
        throw new Error('Analysis canonical backfill requires --report-only.');
    }
    buildBackfillBatch([], limit);
    return cursor === undefined
        ? { limit, reportOnly: true }
        : { limit, reportOnly: true, cursor };
}

function emptyFamilyReport(): BackfillFamilyReport {
    return {
        source: { count: 0, checksum: null, complete: false },
        canonical: { count: 0, checksum: null, complete: false },
        parity: { status: 'blocked', mismatchPaths: ['source.missing'] },
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
    const normalizedKey = typeof rawKey === 'number' && Number.isSafeInteger(rawKey)
        ? String(rawKey)
        : rawKey;
    if (
        !isSafeTimestamp(rawCreatedAt)
        || typeof normalizedKey !== 'string'
        || !KEY_PATTERN.test(normalizedKey)
    ) return null;
    return {
        createdAt: rawCreatedAt,
        key: normalizedKey,
        rowHash: stableHash(value),
    };
}

function cursorPosition(
    cursor: ParsedBackfillCursor | null,
    spec: BackfillTableSpec,
): AnalysisBackfillCursorPosition | null {
    if (!cursor || cursor.version !== 2) return null;
    return cursor.positions[tablePositionKey(spec)] ?? null;
}

async function readBoundedTable(
    client: AnalysisBackfillClient,
    spec: BackfillTableSpec,
    limit: number,
    position: AnalysisBackfillCursorPosition | null,
): Promise<{
    rows: readonly Record<string, unknown>[];
    next: AnalysisBackfillCursorPosition | null;
}> {
    let query = client.from(spec.table).select(spec.columns);
    if (position) {
        if (!query.or) throw new Error('keyset boundary filter unavailable');
        query = query.or(
            `${spec.timeColumn}.gt.${position.createdAt},and(${spec.timeColumn}.eq.${position.createdAt},${spec.keyColumn}.gt.${position.key})`,
        );
    }
    const result = await query
        .order(spec.timeColumn, { ascending: true })
        .order(spec.keyColumn, { ascending: true })
        .limit(limit);
    if (result.error || !Array.isArray(result.data) || result.data.length > limit) {
        throw new Error('bounded analysis canonical backfill query failed');
    }
    const rows: Record<string, unknown>[] = [];
    for (const value of result.data) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            throw new Error('invalid analysis canonical backfill row');
        }
        rows.push(value as Record<string, unknown>);
    }
    const next = rows.length > 0 ? rowCursorPosition(rows[rows.length - 1], spec) : position;
    if (rows.length > 0 && !next) throw new Error('invalid analysis canonical backfill cursor row');
    return { rows, next };
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
): Promise<{
    report: BackfillFamilyReport;
    positions: Record<string, AnalysisBackfillCursorPosition>;
    blocked: number;
}> {
    const positions: Record<string, AnalysisBackfillCursorPosition> = {};
    const legacyRows: Record<string, unknown>[] = [];
    const canonicalRows: Record<string, unknown>[] = [];
    let sourceComplete = true;
    let canonicalComplete = true;
    let blocked = 0;
    for (const table of spec.legacy) {
        try {
            const page = await readBoundedTable(client, table, limit, cursorPosition(cursor, table));
            legacyRows.push(...page.rows);
            if (page.next) positions[tablePositionKey(table)] = page.next;
        } catch {
            sourceComplete = false;
            blocked += 1;
        }
    }
    try {
        const page = await readBoundedTable(client, spec.canonical, limit, cursorPosition(cursor, spec.canonical));
        canonicalRows.push(...page.rows);
        if (page.next) positions[tablePositionKey(spec.canonical)] = page.next;
    } catch {
        canonicalComplete = false;
        blocked += 1;
    }
    const source = aggregateRows(legacyRows, sourceComplete);
    const canonical = aggregateRows(canonicalRows, canonicalComplete);
    const parity: AnalysisBackfillParitySummary = !sourceComplete
        ? { status: 'blocked', mismatchPaths: ['source.missing'] }
        : !canonicalComplete
            ? { status: 'blocked', mismatchPaths: ['canonical.missing'] }
            : compareBackfillFamilyRows(legacyRows, canonicalRows);
    return { report: { source, canonical, parity }, positions, blocked };
}

function invalidReport(): BackfillReport {
    return {
        status: 'blocked',
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
    reportOnly: true;
}): Promise<BackfillReport> {
    const limit = input.limit ?? BACKFILL_MAX_LIMIT;
    buildBackfillBatch([], limit);
    const client = input.client ?? (supabaseAdmin as unknown as AnalysisBackfillClient);
    let cursor: ParsedBackfillCursor | null = null;
    if (input.cursor !== undefined && input.cursor !== null) {
        try {
            cursor = parseBackfillCursor(input.cursor);
        } catch {
            return invalidReport();
        }
    }
    let sourceResult: { data: unknown; error: BackfillRpcError | null };
    try {
        let sourceQuery = client.from(SOURCE_TABLE).select('id, created_at, status');
        if (cursor?.version === 1) {
            if (!sourceQuery.or) throw new Error('cursor boundary filter unavailable');
            sourceQuery = sourceQuery.or(
                `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`,
            );
        } else if (cursor?.version === 2) {
            const position = cursor.positions[`${SOURCE_TABLE}:created_at:id`];
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
            .limit(limit);
    } catch {
        return invalidReport();
    }
    if (sourceResult.error || !Array.isArray(sourceResult.data) || sourceResult.data.length > limit) {
        return invalidReport();
    }
    const validRows = sourceResult.data.filter(isSourceRow);
    const sourceBlocked = sourceResult.data.length - validRows.length;
    const batch = buildBackfillBatch(validRows, limit);
    const positions: Record<string, AnalysisBackfillCursorPosition> = {};
    if (batch.rows.length > 0) {
        const row = batch.rows[batch.rows.length - 1]!;
        positions[`${SOURCE_TABLE}:created_at:id`] = {
            createdAt: row.created_at,
            key: row.id,
            rowHash: stableHash(row),
        };
    }
    const familyReports = {} as Record<AnalysisCanonicalBackfillFamily, BackfillFamilyReport>;
    let familyBlocked = 0;
    for (const spec of ANALYSIS_CANONICAL_BACKFILL_FAMILIES) {
        const family = await readFamily(client, spec, limit, cursor);
        familyReports[spec.family] = family.report;
        familyBlocked += family.blocked;
        Object.assign(positions, family.positions);
    }
    const nextCursor = Object.keys(positions).length > 0
        ? Buffer.from(JSON.stringify({ version: 2, positions } satisfies AnalysisBackfillCursorV2), 'utf8')
            .toString('base64url')
        : null;
    return {
        status: sourceBlocked > 0 || familyBlocked > 0 || Object.values(familyReports).some(
            report => report.parity.status !== 'match',
        ) ? 'blocked' : 'report_only',
        scanned: sourceResult.data.length,
        complete: batch.rows.length,
        blocked: sourceBlocked + familyBlocked,
        checksum: sourceBlocked > 0 || batch.rows.length === 0 ? null : batch.checksum,
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
