import { createHash } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabase/admin';

export const BACKFILL_MAX_LIMIT = 100;
const SOURCE_TABLE = 'analysis_requests';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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

export interface BackfillReport {
    status: 'report_only' | 'blocked';
    scanned: number;
    complete: number;
    blocked: number;
    checksum: string | null;
    nextCursor: string | null;
}

export interface BackfillCliArgs {
    limit: number;
    reportOnly: true;
}

function isSourceRow(value: unknown): value is AnalysisBackfillSourceRow {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, unknown>;
    return typeof row.id === 'string'
        && UUID_PATTERN.test(row.id)
        && typeof row.created_at === 'string'
        && row.created_at.length > 0
        && row.created_at.length <= 128
        && typeof row.status === 'string'
        && row.status.length > 0
        && row.status.length <= 64;
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

export function parseBackfillCliArgs(argv: readonly string[]): BackfillCliArgs {
    let limit = BACKFILL_MAX_LIMIT;
    let reportOnly = false;
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
        if (['--apply', '--drop', '--truncate', '--delete', '--mutate'].includes(arg)) {
            throw new Error('Analysis canonical backfill is report-only; destructive/apply options are blocked.');
        }
        throw new Error('Analysis canonical backfill accepts only --limit and --report-only.');
    }
    if (!reportOnly) {
        throw new Error('Analysis canonical backfill requires --report-only.');
    }
    buildBackfillBatch([], limit);
    return { limit, reportOnly: true };
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
    let result: { data: unknown; error: BackfillRpcError | null };
    try {
        result = await client
            .from(SOURCE_TABLE)
            .select('id, created_at, status')
            .order('created_at', { ascending: true })
            .order('id', { ascending: true })
            .limit(limit);
    } catch {
        return {
            status: 'blocked',
            scanned: 0,
            complete: 0,
            blocked: 1,
            checksum: null,
            nextCursor: null,
        };
    }
    if (result.error || !Array.isArray(result.data)) {
        return {
            status: 'blocked',
            scanned: 0,
            complete: 0,
            blocked: 1,
            checksum: null,
            nextCursor: null,
        };
    }

    const validRows = result.data.filter(isSourceRow);
    const blocked = result.data.length - validRows.length;
    let eligibleRows = validRows;
    if (input.cursor) {
        const cursorIndex = validRows.findIndex(row => (
            stableHash(sourceBackfillIdempotency(row)) === input.cursor
        ));
        if (cursorIndex < 0) {
            return {
                status: 'blocked',
                scanned: result.data.length,
                complete: 0,
                blocked: blocked + 1,
                checksum: null,
                nextCursor: null,
            };
        }
        eligibleRows = validRows.slice(cursorIndex + 1);
    }
    const batch = buildBackfillBatch(eligibleRows, limit);
    const nextCursor = batch.rows.length > 0
        ? stableHash(sourceBackfillIdempotency(batch.rows[batch.rows.length - 1]!))
        : null;
    return {
        status: blocked > 0 ? 'blocked' : 'report_only',
        scanned: result.data.length,
        complete: batch.rows.length,
        blocked,
        checksum: blocked > 0 || batch.rows.length === 0 ? null : batch.checksum,
        nextCursor,
    };
}

async function main(): Promise<void> {
    try {
        const args = parseBackfillCliArgs(process.argv.slice(2));
        const report = await backfillAnalysisCanonical(args);
        process.stdout.write(`${JSON.stringify(report)}\n`);
    } catch {
        process.stdout.write(JSON.stringify({
            status: 'blocked',
            scanned: 0,
            complete: 0,
            blocked: 1,
            checksum: null,
            nextCursor: null,
        }) + '\n');
        process.exitCode = 1;
    }
}

if (process.argv[1]?.endsWith('backfill-analysis-canonical.ts')) {
    void main();
}
