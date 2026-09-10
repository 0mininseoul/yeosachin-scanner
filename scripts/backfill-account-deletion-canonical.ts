import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ACCOUNT_DELETION_ARCHIVE_SCHEMA =
    'supabase-22-account-deletion-archive-restore-v1' as const;
export const ACCOUNT_DELETION_SOURCE_TABLE = 'account_deletion_jobs' as const;
export const ACCOUNT_DELETION_CANONICAL_TABLE = 'maintenance_jobs' as const;
export const ACCOUNT_DELETION_BATCH_LIMIT = 100;

export const ACCOUNT_DELETION_STATES = [
    'requested',
    'objects_purged',
    'database_purged',
    'completed',
] as const;

type CanonicalScalarObject = Readonly<Record<string, string | null>>;

/**
 * This report-only script intentionally stays dependency-free from the
 * server-only Supabase client. Its inputs are restricted to strings/nulls, so
 * this is the fixed-width subset of the shared canonical JSON hash contract.
 */
function canonicalJsonHash(namespace: string, value: CanonicalScalarObject): string {
    const serialized = `{${Object.entries(value)
        .sort(([left], [right]) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')))
        .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`)
        .join(',')}}`;
    return createHash('sha256')
        .update(`${namespace}\n${serialized}`, 'utf8')
        .digest('hex');
}

export type AccountDeletionState = typeof ACCOUNT_DELETION_STATES[number];

export type AccountDeletionSourceRow = Readonly<{
    accountId: string;
    state: AccountDeletionState;
    requestedAt: string;
    objectsPurgedAt: string | null;
    databasePurgedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
}>;

export type AccountDeletionCanonicalProjection = Readonly<{
    key: string;
    kind: 'purge';
    canonicalState: 'queued' | 'succeeded';
    targetKeyHash: string;
    contentHash: string;
    payload: Readonly<{
        source_table: typeof ACCOUNT_DELETION_SOURCE_TABLE;
        source_key_hash: string;
        legacy_state: AccountDeletionState;
        requested_at: string;
        objects_purged_at: string | null;
        database_purged_at: string | null;
        completed_at: string | null;
        source_updated_at: string;
    }>;
}>;

export type AccountDeletionParity = Readonly<{
    status: 'match' | 'mismatch' | 'blocked';
    sourceCount: number;
    canonicalCount: number;
    mismatchFields: readonly string[];
    sourceChecksum: string | null;
    canonicalChecksum: string | null;
}>;

export type AccountDeletionArchiveRestoreManifest = Readonly<{
    schemaVersion: typeof ACCOUNT_DELETION_ARCHIVE_SCHEMA;
    sourceTable: typeof ACCOUNT_DELETION_SOURCE_TABLE;
    canonicalTable: typeof ACCOUNT_DELETION_CANONICAL_TABLE;
    sourceCount: number;
    sourceChecksum: string | null;
    canonicalCount: number;
    canonicalChecksum: string | null;
    archiveStatus: 'not_run';
    restoreStatus: 'not_run';
    destructiveAllowlist: readonly [];
}>;

export type AccountDeletionBackfillReadResult<T> =
    | readonly T[]
    | Readonly<{ records: readonly T[]; truncated?: boolean }>;

export type AccountDeletionBackfillOptions = Readonly<{
    limit?: number;
    cursor?: string | null;
    reportOnly: boolean;
    readSource: (
        limit: number,
        cursor: string | null,
    ) => Promise<AccountDeletionBackfillReadResult<AccountDeletionSourceRow>>;
    readCanonical?: (
        limit: number,
        cursor: string | null,
    ) => Promise<AccountDeletionBackfillReadResult<AccountDeletionCanonicalProjection>>;
    apply?: boolean;
    drop?: boolean;
    truncate?: boolean;
    delete?: boolean;
    mutate?: boolean;
    activate?: boolean;
    cutover?: boolean;
}>;

export type AccountDeletionBackfillReport = Readonly<{
    schemaVersion: typeof ACCOUNT_DELETION_ARCHIVE_SCHEMA;
    status: 'ready' | 'blocked';
    mode: 'report_only';
    processed: number;
    batchSize: number;
    nextCursorHash: string | null;
    sourceCount: number;
    canonicalCount: number;
    sourceChecksum: string | null;
    canonicalChecksum: string | null;
    parity: AccountDeletionParity;
    blockedReasons: readonly string[];
    destructiveAllowlist: readonly [];
}>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function normalizeTimestamp(value: string | null, required: boolean): string | null {
    if (value === null) {
        if (required) throw new Error('ACCOUNT_DELETION_TIMESTAMP_INVALID');
        return null;
    }
    const parsed = new Date(value);
    if (value.trim() === '' || Number.isNaN(parsed.getTime())) {
        throw new Error('ACCOUNT_DELETION_TIMESTAMP_INVALID');
    }
    return parsed.toISOString();
}

function assertSourceShape(row: AccountDeletionSourceRow): void {
    if (
        !UUID_PATTERN.test(row.accountId)
        || !ACCOUNT_DELETION_STATES.includes(row.state)
        || typeof row.requestedAt !== 'string'
        || typeof row.updatedAt !== 'string'
    ) {
        throw new Error('ACCOUNT_DELETION_SOURCE_INVALID');
    }
    const requestedAt = normalizeTimestamp(row.requestedAt, true);
    const objectsPurgedAt = normalizeTimestamp(row.objectsPurgedAt, row.state !== 'requested');
    const databasePurgedAt = normalizeTimestamp(row.databasePurgedAt, row.state === 'database_purged' || row.state === 'completed');
    const completedAt = normalizeTimestamp(row.completedAt, row.state === 'completed');
    const updatedAt = normalizeTimestamp(row.updatedAt, true);
    if (!requestedAt || !updatedAt) throw new Error('ACCOUNT_DELETION_SOURCE_INVALID');
    const requestedMs = Date.parse(requestedAt);
    const updatedMs = Date.parse(updatedAt);
    const objectsMs = objectsPurgedAt ? Date.parse(objectsPurgedAt) : null;
    const databaseMs = databasePurgedAt ? Date.parse(databasePurgedAt) : null;
    const completedMs = completedAt ? Date.parse(completedAt) : null;
    if (
        updatedMs < requestedMs
        || (objectsMs !== null && objectsMs < requestedMs)
        || (databaseMs !== null && (objectsMs === null || databaseMs < objectsMs))
        || (completedMs !== null && (databaseMs === null || completedMs < databaseMs))
    ) {
        throw new Error('ACCOUNT_DELETION_TIMESTAMP_ORDER_INVALID');
    }
    if (
        (row.state === 'requested' && (objectsPurgedAt !== null || databasePurgedAt !== null || completedAt !== null))
        || (row.state === 'objects_purged' && (objectsPurgedAt === null || databasePurgedAt !== null || completedAt !== null))
        || (row.state === 'database_purged' && (objectsPurgedAt === null || databasePurgedAt === null || completedAt !== null))
        || (row.state === 'completed' && (objectsPurgedAt === null || databasePurgedAt === null || completedAt === null))
    ) {
        throw new Error('ACCOUNT_DELETION_STATE_SHAPE_INVALID');
    }
}

function normalizeSourceRow(row: AccountDeletionSourceRow): AccountDeletionSourceRow {
    assertSourceShape(row);
    return {
        accountId: row.accountId.toLowerCase(),
        state: row.state,
        requestedAt: normalizeTimestamp(row.requestedAt, true) as string,
        objectsPurgedAt: normalizeTimestamp(row.objectsPurgedAt, row.state !== 'requested'),
        databasePurgedAt: normalizeTimestamp(row.databasePurgedAt, row.state === 'database_purged' || row.state === 'completed'),
        completedAt: normalizeTimestamp(row.completedAt, row.state === 'completed'),
        updatedAt: normalizeTimestamp(row.updatedAt, true) as string,
    };
}

export function buildAccountDeletionCanonicalProjection(
    source: AccountDeletionSourceRow,
): AccountDeletionCanonicalProjection {
    const normalized = normalizeSourceRow(source);
    const targetKeyHash = canonicalJsonHash('account-deletion-target', {
        account_id: normalized.accountId,
    });
    const payload = {
        source_table: ACCOUNT_DELETION_SOURCE_TABLE,
        source_key_hash: targetKeyHash,
        legacy_state: normalized.state,
        requested_at: normalized.requestedAt,
        objects_purged_at: normalized.objectsPurgedAt,
        database_purged_at: normalized.databasePurgedAt,
        completed_at: normalized.completedAt,
        source_updated_at: normalized.updatedAt,
    } as const;
    return {
        key: targetKeyHash,
        kind: 'purge',
        canonicalState: normalized.state === 'completed' ? 'succeeded' : 'queued',
        targetKeyHash,
        contentHash: canonicalJsonHash('account-deletion-maintenance-content', payload),
        payload,
    };
}

function projectionChecksum(rows: readonly AccountDeletionCanonicalProjection[]): string | null {
    if (rows.length === 0) return null;
    const digest = createHash('sha256');
    for (const row of [...rows].sort((left, right) => left.key.localeCompare(right.key))) {
        digest.update(`${row.key.length}:${row.key}\n`);
        digest.update(`${row.kind}\n${row.canonicalState}\n`);
        digest.update(`${row.contentHash.length}:${row.contentHash}\n`);
    }
    return digest.digest('hex');
}

export function compareAccountDeletionParity(
    sourceRows: readonly AccountDeletionCanonicalProjection[],
    canonicalRows: readonly AccountDeletionCanonicalProjection[],
): AccountDeletionParity {
    const mismatchFields = new Set<string>();
    const sourceByKey = new Map(sourceRows.map(row => [row.key, row]));
    const canonicalByKey = new Map(canonicalRows.map(row => [row.key, row]));
    if (sourceByKey.size !== sourceRows.length || canonicalByKey.size !== canonicalRows.length) {
        mismatchFields.add('duplicate_key');
    }
    for (const [key, source] of sourceByKey) {
        const canonical = canonicalByKey.get(key);
        if (!canonical) {
            mismatchFields.add('missing_record');
            continue;
        }
        if (source.kind !== canonical.kind) mismatchFields.add('kind');
        if (source.canonicalState !== canonical.canonicalState) mismatchFields.add('state');
        if (source.contentHash !== canonical.contentHash) mismatchFields.add('content_hash');
        if (JSON.stringify(source.payload) !== JSON.stringify(canonical.payload)) {
            mismatchFields.add('payload');
        }
    }
    for (const key of canonicalByKey.keys()) {
        if (!sourceByKey.has(key)) mismatchFields.add('missing_record');
    }
    if (sourceByKey.size !== canonicalByKey.size) mismatchFields.add('record_count');
    const sortedMismatchFields = [...mismatchFields].sort();
    const hasBlockingRecordIssue = sortedMismatchFields.includes('missing_record')
        || sortedMismatchFields.includes('duplicate_key');
    return {
        status: hasBlockingRecordIssue
            ? 'blocked'
            : sortedMismatchFields.length === 0 ? 'match' : 'mismatch',
        sourceCount: sourceRows.length,
        canonicalCount: canonicalRows.length,
        mismatchFields: sortedMismatchFields,
        sourceChecksum: projectionChecksum(sourceRows),
        canonicalChecksum: projectionChecksum(canonicalRows),
    };
}

export function buildAccountDeletionArchiveRestoreManifest(input: {
    sourceCount: number;
    sourceChecksum: string | null;
    canonicalCount: number;
    canonicalChecksum: string | null;
}): AccountDeletionArchiveRestoreManifest {
    if (
        !Number.isSafeInteger(input.sourceCount)
        || input.sourceCount < 0
        || !Number.isSafeInteger(input.canonicalCount)
        || input.canonicalCount < 0
        || (input.sourceChecksum !== null && !HASH_PATTERN.test(input.sourceChecksum))
        || (input.canonicalChecksum !== null && !HASH_PATTERN.test(input.canonicalChecksum))
    ) {
        throw new Error('ACCOUNT_DELETION_ARCHIVE_MANIFEST_INVALID');
    }
    return {
        schemaVersion: ACCOUNT_DELETION_ARCHIVE_SCHEMA,
        sourceTable: ACCOUNT_DELETION_SOURCE_TABLE,
        canonicalTable: ACCOUNT_DELETION_CANONICAL_TABLE,
        sourceCount: input.sourceCount,
        sourceChecksum: input.sourceChecksum,
        canonicalCount: input.canonicalCount,
        canonicalChecksum: input.canonicalChecksum,
        archiveStatus: 'not_run',
        restoreStatus: 'not_run',
        destructiveAllowlist: [],
    };
}

function boundedLimit(value: number | undefined): number {
    if (value === undefined) return ACCOUNT_DELETION_BATCH_LIMIT;
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('LIMIT_INVALID');
    return Math.min(value, ACCOUNT_DELETION_BATCH_LIMIT);
}

function unpack<T>(result: AccountDeletionBackfillReadResult<T>): {
    records: readonly T[];
    truncated: boolean;
} {
    if (Array.isArray(result)) return { records: result, truncated: false };
    if (!result || typeof result !== 'object' || !('records' in result)) {
        throw new Error('BACKFILL_READ_RESULT_INVALID');
    }
    const objectResult = result as Readonly<{ records: readonly T[]; truncated?: boolean }>;
    if (!Array.isArray(objectResult.records)) throw new Error('BACKFILL_READ_RESULT_INVALID');
    return { records: objectResult.records, truncated: objectResult.truncated === true };
}

function sourceCursorHash(rows: readonly AccountDeletionSourceRow[]): string | null {
    const last = rows.at(-1);
    return last
        ? canonicalJsonHash('account-deletion-cursor', {
            account_id: last.accountId.toLowerCase(),
        })
        : null;
}

function blockedReport(
    limit: number,
    reason: string,
): AccountDeletionBackfillReport {
    const parity = compareAccountDeletionParity([], []);
    return {
        schemaVersion: ACCOUNT_DELETION_ARCHIVE_SCHEMA,
        status: 'blocked',
        mode: 'report_only',
        processed: 0,
        batchSize: limit,
        nextCursorHash: null,
        sourceCount: 0,
        canonicalCount: 0,
        sourceChecksum: null,
        canonicalChecksum: null,
        parity,
        blockedReasons: [reason],
        destructiveAllowlist: [],
    };
}

export async function backfillAccountDeletionCanonical(
    options: AccountDeletionBackfillOptions,
): Promise<AccountDeletionBackfillReport> {
    const limit = boundedLimit(options.limit);
    if (options.reportOnly !== true) throw new Error('REPORT_ONLY_REQUIRED');
    if (
        options.apply === true
        || options.drop === true
        || options.truncate === true
        || options.delete === true
        || options.mutate === true
        || options.activate === true
        || options.cutover === true
    ) throw new Error('DESTRUCTIVE_OPTION_FORBIDDEN');

    let sourceRead: { records: readonly AccountDeletionSourceRow[]; truncated: boolean };
    try {
        const result = unpack(await options.readSource(limit + 1, options.cursor ?? null));
        sourceRead = {
            records: result.records.slice(0, limit).map(normalizeSourceRow),
            truncated: result.truncated || result.records.length > limit,
        };
    } catch {
        return blockedReport(limit, 'source_read_failed');
    }

    const blockedReasons = new Set<string>();
    let canonicalRows: readonly AccountDeletionCanonicalProjection[] = [];
    let canonicalTruncated = false;
    if (!options.readCanonical) {
        blockedReasons.add('canonical_read_not_configured');
    } else {
        try {
            const result = unpack(await options.readCanonical(limit + 1, options.cursor ?? null));
            canonicalRows = result.records.slice(0, limit);
            canonicalTruncated = result.truncated || result.records.length > limit;
        } catch {
            blockedReasons.add('canonical_read_failed');
        }
    }

    const sourceRows = sourceRead.records.map(buildAccountDeletionCanonicalProjection);
    const parity = compareAccountDeletionParity(sourceRows, canonicalRows);
    if (parity.status !== 'match') blockedReasons.add('canonical_parity_mismatch');
    if (sourceRead.truncated) blockedReasons.add('source_tail_truncated');
    if (canonicalTruncated) blockedReasons.add('canonical_tail_truncated');

    return {
        schemaVersion: ACCOUNT_DELETION_ARCHIVE_SCHEMA,
        status: blockedReasons.size === 0 ? 'ready' : 'blocked',
        mode: 'report_only',
        processed: sourceRows.length,
        batchSize: limit,
        nextCursorHash: sourceCursorHash(sourceRead.records),
        sourceCount: sourceRows.length,
        canonicalCount: canonicalRows.length,
        sourceChecksum: parity.sourceChecksum,
        canonicalChecksum: parity.canonicalChecksum,
        parity,
        blockedReasons: [...blockedReasons].sort(),
        destructiveAllowlist: [],
    };
}

function parseCliArguments(argv: readonly string[]): { limit: number; reportOnly: boolean } {
    let limit = ACCOUNT_DELETION_BATCH_LIMIT;
    let reportOnly = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--report-only') {
            reportOnly = true;
            continue;
        }
        if (argument === '--limit') {
            limit = boundedLimit(Number(argv[index + 1]));
            index += 1;
            continue;
        }
        if (argument.startsWith('--limit=')) {
            limit = boundedLimit(Number(argument.slice('--limit='.length)));
            continue;
        }
        if (/^--(?:apply|drop|truncate|delete|mutate|activate|cutover)$/.test(argument)) {
            throw new Error('DESTRUCTIVE_OPTION_FORBIDDEN');
        }
        throw new Error('UNKNOWN_OPTION');
    }
    return { limit, reportOnly };
}

export async function runAccountDeletionBackfillCli(
    argv: readonly string[] = process.argv.slice(2),
): Promise<void> {
    const { limit, reportOnly } = parseCliArguments(argv);
    const report = await backfillAccountDeletionCanonical({
        limit,
        reportOnly,
        readSource: async () => [],
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
    runAccountDeletionBackfillCli().catch(error => {
        const message = error instanceof Error ? error.message : 'BACKFILL_FAILED';
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    });
}
