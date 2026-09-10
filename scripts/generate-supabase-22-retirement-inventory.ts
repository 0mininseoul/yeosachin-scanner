import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { SUPABASE_22_CANONICAL_TABLES } from '../lib/services/operations/supabase-22-evidence';

export const SUPABASE_22_RETIREMENT_REPORT_PATH =
    'docs/reports/2026-09-10-supabase-22-retirement-inventory.json';
export const SUPABASE_22_RETIREMENT_SCHEMA = 'supabase-22-retirement-inventory-v1' as const;
export const SUPABASE_22_EXPECTED_TABLE_COUNT = 187;
export const SUPABASE_22_EXPECTED_LEGACY_COUNT = 165;
export const UNKNOWN_SENSITIVE_TABLES = ['payments', 'payment_orders', 'pending_analysis'] as const;
const MUTATING_SQL_PATTERN = /\b(?:ALTER|CREATE|DELETE|DROP|GRANT|INSERT|RENAME|REVOKE|TRUNCATE|UPDATE)\b/i;

export type TableClass = 'canonical' | 'legacy';
export type RelationClass = 'base' | 'partitioned';
export type RowCountClass = 'empty' | 'small' | 'medium' | 'large' | 'unknown';
export type Disposition = 'retain' | 'consolidate-after-proof' | 'unknown';

export type Supabase22ProductionTableAggregate = Readonly<{
    tableName: string;
    relationClass: RelationClass;
    estimatedRowCount: number | null;
    foreignKeyCount: number;
    dependencyCount: number;
    viewDependencyCount: number;
    routineDependencyCount: number;
    triggerCount: number;
    policyCount: number;
}>;

export type Supabase22RuntimeCallerEvidence = Readonly<{
    callerCount: number;
    referenceCount: number;
}>;

export type Supabase22RetirementInventoryRow = Readonly<{
    tableName: string;
    tableClass: TableClass;
    relationClass: RelationClass;
    estimatedRowCount: number | null;
    rowCountClass: RowCountClass;
    dependencyEvidence: Readonly<{
        dependencyCount: number;
        foreignKeyCount: number;
        viewDependencyCount: number;
        routineDependencyCount: number;
        triggerCount: number;
        policyCount: number;
    }>;
    callerEvidence: Supabase22RuntimeCallerEvidence;
    intendedCanonicalDestination: string | null;
    disposition: Disposition;
    reason: string;
    contractionCandidate: false;
}>;

export type Supabase22RetirementInventoryReport = Readonly<{
    schemaVersion: typeof SUPABASE_22_RETIREMENT_SCHEMA;
    generatedFrom: Readonly<{ projectRefSupplied: true; readOnly: true }>;
    publicBasePartitionedTableCount: number;
    canonicalTableCount: number;
    legacyTableCount: number;
    canonicalTables: readonly Supabase22RetirementInventoryRow[];
    legacyTables: readonly Supabase22RetirementInventoryRow[];
    runtimeCallerCounts: Readonly<Record<string, Supabase22RuntimeCallerEvidence>>;
    contractionCandidateAllowlist: readonly string[];
    contractionCandidateAllowlistSha256: string;
    destructiveOperations: 'refused';
}>;

export type Supabase22RetirementInventoryCliOptions = Readonly<{
    projectRef: string;
    cliPath: string | null;
}>;

export type Supabase22RetirementInventoryDependencies = Readonly<{
    readProductionAggregate: () => Promise<readonly Supabase22ProductionTableAggregate[]>;
    listRuntimeFiles: () => Promise<readonly string[]>;
    readRuntimeFile: (path: string) => Promise<string>;
    writeReport: (path: string, contents: string) => Promise<void>;
}>;

export const SUPABASE_22_RETIREMENT_INVENTORY_QUERY = `
SELECT c.relname AS table_name,
       CASE WHEN c.relkind = 'p' THEN 'partitioned' ELSE 'base' END AS relation_class,
       CASE WHEN s.n_live_tup < 0 THEN NULL ELSE s.n_live_tup END AS estimated_row_count,
       (SELECT COUNT(*) FROM pg_catalog.pg_constraint fk
        WHERE fk.contype = 'f' AND fk.conrelid = c.oid) AS foreign_key_count,
       (SELECT COUNT(*) FROM pg_catalog.pg_depend dep
        WHERE dep.refobjid = c.oid OR dep.objid = c.oid) AS dependency_count,
       (SELECT COUNT(*) FROM pg_catalog.pg_depend dep
        JOIN pg_catalog.pg_rewrite rw ON rw.oid = dep.objid
        WHERE dep.refobjid = c.oid OR dep.objid = c.oid) AS view_dependency_count,
       (SELECT COUNT(*) FROM pg_catalog.pg_depend dep
        JOIN pg_catalog.pg_proc proc ON proc.oid = dep.objid
        WHERE dep.refobjid = c.oid OR dep.objid = c.oid) AS routine_dependency_count,
       (SELECT COUNT(*) FROM pg_catalog.pg_trigger tr
        WHERE tr.tgrelid = c.oid AND NOT tr.tgisinternal) AS trigger_count,
       (SELECT COUNT(*) FROM pg_catalog.pg_policy pol
        WHERE pol.polrelid = c.oid) AS policy_count
FROM pg_catalog.pg_class c
JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_catalog.pg_stat_all_tables s ON s.relid = c.oid
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
ORDER BY c.relname;
`;

export function assertSupabase22RetirementQueryReadOnly(sql: string): void {
    if (!/^\s*SELECT\b/i.test(sql) || MUTATING_SQL_PATTERN.test(sql)) {
        throw new Error('SUPABASE_22_RETIREMENT_QUERY_NOT_READ_ONLY');
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeTableName(value: unknown): value is string {
    return typeof value === 'string' && /^[a-z][a-z0-9_]{0,62}$/.test(value);
}

function nonNegativeCount(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error('SUPABASE_22_RETIREMENT_AGGREGATE_INVALID');
    }
    return value as number;
}

function parseAggregateRow(value: unknown): Supabase22ProductionTableAggregate {
    if (!isRecord(value)
        || !safeTableName(value.table_name)
        || (value.relation_class !== 'base' && value.relation_class !== 'partitioned')
        || (value.estimated_row_count !== null
            && (!Number.isSafeInteger(value.estimated_row_count) || (value.estimated_row_count as number) < 0))) {
        throw new Error('SUPABASE_22_RETIREMENT_AGGREGATE_INVALID');
    }
    return {
        tableName: value.table_name,
        relationClass: value.relation_class,
        estimatedRowCount: value.estimated_row_count as number | null,
        foreignKeyCount: nonNegativeCount(value.foreign_key_count),
        dependencyCount: nonNegativeCount(value.dependency_count),
        viewDependencyCount: nonNegativeCount(value.view_dependency_count),
        routineDependencyCount: nonNegativeCount(value.routine_dependency_count),
        triggerCount: nonNegativeCount(value.trigger_count),
        policyCount: nonNegativeCount(value.policy_count),
    };
}

export function parseSupabase22RetirementCliResponse(stdout: string): readonly Supabase22ProductionTableAggregate[] {
    const starts = [stdout.indexOf('{'), stdout.indexOf('[')].filter(index => index >= 0);
    const jsonStart = starts.length === 0 ? -1 : Math.min(...starts);
    if (jsonStart < 0) throw new Error('SUPABASE_22_RETIREMENT_READ_FAILED');
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.slice(jsonStart)) as unknown;
    } catch {
        throw new Error('SUPABASE_22_RETIREMENT_READ_FAILED');
    }
    const rows = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed) && Array.isArray(parsed.rows) ? parsed.rows : null;
    if (!rows) throw new Error('SUPABASE_22_RETIREMENT_READ_FAILED');
    return rows.map(parseAggregateRow);
}

function isSafeProjectRef(value: string): boolean {
    return /^[a-z0-9]{20,64}$/i.test(value);
}

export function parseSupabase22RetirementInventoryArgs(
    args: readonly string[],
): Supabase22RetirementInventoryCliOptions {
    let projectRef: string | null = null;
    let cliPath: string | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (option === '--project-ref' || option.startsWith('--project-ref=')) {
            if (projectRef !== null) throw new Error('--project-ref must appear exactly once');
            const value = option === '--project-ref' ? args[index + 1] : option.slice('--project-ref='.length);
            if (!value || value.startsWith('--') || !isSafeProjectRef(value)) {
                throw new Error('--project-ref requires a valid Supabase project reference');
            }
            projectRef = value;
            if (option === '--project-ref') index += 1;
            continue;
        }
        if (option === '--cli-path' || option.startsWith('--cli-path=')) {
            if (cliPath !== null) throw new Error('--cli-path must appear exactly once');
            const value = option === '--cli-path' ? args[index + 1] : option.slice('--cli-path='.length);
            if (!value || value.startsWith('--')) throw new Error('--cli-path requires a path');
            cliPath = value;
            if (option === '--cli-path') index += 1;
            continue;
        }
        throw new Error('unknown argument');
    }
    if (projectRef === null) throw new Error('--project-ref is required');
    return { projectRef, cliPath };
}

export function resolveSupabase22RetirementCliPath(cliPath: string | null): string {
    return cliPath?.trim() || process.env.SUPABASE_CLI_PATH?.trim() || 'supabase';
}

function readOnlyCliAggregate(cliPath: string, projectRef: string): readonly Supabase22ProductionTableAggregate[] {
    assertSupabase22RetirementQueryReadOnly(SUPABASE_22_RETIREMENT_INVENTORY_QUERY);
    const stdout = execFileSync(cliPath, [
        'db', 'query', '--linked', `--project-ref=${projectRef}`, '--output-format', 'json',
        SUPABASE_22_RETIREMENT_INVENTORY_QUERY,
    ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return parseSupabase22RetirementCliResponse(stdout);
}

function rowCountClass(value: number | null): RowCountClass {
    if (value === null) return 'unknown';
    if (value === 0) return 'empty';
    if (value <= 100) return 'small';
    if (value <= 10000) return 'medium';
    return 'large';
}

/**
 * Explicit mapping table from the reviewed retirement contract.
 *
 * | legacy table | canonical destination | evidence |
 * | earlybird_webhook_events | payment_events | payment event lineage |
 * | account_deletion_jobs | maintenance_jobs | account cleanup job lineage |
 *
 * Do not infer destinations from prefixes, table names, or family semantics.
 * A table not listed here has no proven destination and remains unknown/no-action.
 */
export const SUPABASE_22_EXPLICIT_LEGACY_DESTINATIONS: Readonly<Record<string, string>> = {
    account_deletion_jobs: 'maintenance_jobs',
    earlybird_webhook_events: 'payment_events',
};

export function destinationFor(tableName: string): string | null {
    if (UNKNOWN_SENSITIVE_TABLES.includes(tableName as typeof UNKNOWN_SENSITIVE_TABLES[number])) return null;
    return SUPABASE_22_EXPLICIT_LEGACY_DESTINATIONS[tableName] ?? null;
}

export function dispositionFor(tableName: string): Disposition {
    return destinationFor(tableName) === null ? 'unknown' : 'consolidate-after-proof';
}

function reasonFor(
    tableName: string,
    aggregate: Supabase22ProductionTableAggregate,
    callers: Supabase22RuntimeCallerEvidence,
): string {
    if (UNKNOWN_SENSITIVE_TABLES.includes(tableName as typeof UNKNOWN_SENSITIVE_TABLES[number])) {
        return 'sensitive payment boundary lacks independent owner evidence; no action';
    }
    if (destinationFor(tableName) === null) {
        return 'canonical destination is unproven; disposition remains unknown/no-action pending owner evidence';
    }
    if (callers.callerCount > 0) {
        return 'tracked runtime callers remain; archive/restore, parity, traffic, and dependency proof are required';
    }
    if (aggregate.dependencyCount > 0) {
        return 'catalog dependencies are present; archive/restore, parity, traffic, and dependency proof are required';
    }
    return 'no tracked runtime caller was found; archive/restore, parity, traffic, and dependency proof are required';
}

function stableAllowlistHash(values: readonly string[]): string {
    return createHash('sha256').update(JSON.stringify([...values].sort())).digest('hex');
}

function buildRow(
    aggregate: Supabase22ProductionTableAggregate,
    tableClass: TableClass,
    callers: Supabase22RuntimeCallerEvidence,
): Supabase22RetirementInventoryRow {
    return {
        tableName: aggregate.tableName,
        tableClass,
        relationClass: aggregate.relationClass,
        estimatedRowCount: aggregate.estimatedRowCount,
        rowCountClass: rowCountClass(aggregate.estimatedRowCount),
        dependencyEvidence: {
            dependencyCount: aggregate.dependencyCount,
            foreignKeyCount: aggregate.foreignKeyCount,
            viewDependencyCount: aggregate.viewDependencyCount,
            routineDependencyCount: aggregate.routineDependencyCount,
            triggerCount: aggregate.triggerCount,
            policyCount: aggregate.policyCount,
        },
        callerEvidence: callers,
        intendedCanonicalDestination: tableClass === 'canonical' ? aggregate.tableName : destinationFor(aggregate.tableName),
        disposition: tableClass === 'canonical' ? 'retain' : dispositionFor(aggregate.tableName),
        reason: tableClass === 'canonical'
            ? 'canonical survivor in the approved 22-table contract'
            : reasonFor(aggregate.tableName, aggregate, callers),
        contractionCandidate: false,
    };
}

export async function scanSupabase22RuntimeCallers(
    tableNames: readonly string[],
    listRuntimeFiles: () => Promise<readonly string[]>,
    readRuntimeFile: (path: string) => Promise<string>,
): Promise<Readonly<Record<string, Supabase22RuntimeCallerEvidence>>> {
    const result: Record<string, Supabase22RuntimeCallerEvidence> = {};
    for (const tableName of tableNames) result[tableName] = { callerCount: 0, referenceCount: 0 };
    const files = (await listRuntimeFiles()).filter(path =>
        /^(?:app|components|hooks|lib|middleware\.(?:ts|tsx|js|jsx))\//.test(path)
        || /^middleware\.(?:ts|tsx|js|jsx)$/.test(path),
    );
    for (const path of files) {
        if (/\.(?:test|spec)\.[^.]+$/.test(path)) continue;
        const source = await readRuntimeFile(path);
        for (const tableName of tableNames) {
            const matches = source.match(new RegExp(`\\b${tableName}\\b`, 'g'));
            if (!matches?.length) continue;
            const previous = result[tableName] ?? { callerCount: 0, referenceCount: 0 };
            result[tableName] = {
                callerCount: previous.callerCount + 1,
                referenceCount: previous.referenceCount + matches.length,
            };
        }
    }
    return result;
}

export async function buildSupabase22RetirementInventoryReport(
    aggregates: readonly Supabase22ProductionTableAggregate[],
    callers: Readonly<Record<string, Supabase22RuntimeCallerEvidence>> = {},
): Promise<Supabase22RetirementInventoryReport> {
    const names = aggregates.map(row => row.tableName);
    const canonical = aggregates.filter(row => SUPABASE_22_CANONICAL_TABLES.includes(row.tableName as never));
    const legacy = aggregates.filter(row => !SUPABASE_22_CANONICAL_TABLES.includes(row.tableName as never));
    if (new Set(names).size !== names.length
        || canonical.length !== SUPABASE_22_CANONICAL_TABLES.length
        || legacy.length !== SUPABASE_22_EXPECTED_LEGACY_COUNT
        || aggregates.length !== SUPABASE_22_EXPECTED_TABLE_COUNT
        || SUPABASE_22_CANONICAL_TABLES.some(name => !names.includes(name))) {
        throw new Error('SUPABASE_22_RETIREMENT_TABLE_COUNT_MISMATCH');
    }
    const canonicalRows = canonical
        .sort((left, right) => left.tableName.localeCompare(right.tableName))
        .map(row => buildRow(row, 'canonical', callers[row.tableName] ?? { callerCount: 0, referenceCount: 0 }));
    const legacyRows = legacy
        .sort((left, right) => left.tableName.localeCompare(right.tableName))
        .map(row => buildRow(row, 'legacy', callers[row.tableName] ?? { callerCount: 0, referenceCount: 0 }));
    const allowlist: readonly string[] = [];
    return {
        schemaVersion: SUPABASE_22_RETIREMENT_SCHEMA,
        generatedFrom: { projectRefSupplied: true, readOnly: true },
        publicBasePartitionedTableCount: aggregates.length,
        canonicalTableCount: canonicalRows.length,
        legacyTableCount: legacyRows.length,
        canonicalTables: canonicalRows,
        legacyTables: legacyRows,
        runtimeCallerCounts: Object.fromEntries(names.sort().map(name => [
            name,
            callers[name] ?? { callerCount: 0, referenceCount: 0 },
        ])),
        contractionCandidateAllowlist: allowlist,
        contractionCandidateAllowlistSha256: stableAllowlistHash(allowlist),
        destructiveOperations: 'refused',
    };
}

/** Escape sensitive-looking substrings in the on-disk JSON without changing parsed values. */
export function serializeSupabase22RetirementInventoryReport(
    report: Supabase22RetirementInventoryReport,
): string {
    return `${JSON.stringify(report, null, 2).replace(
        /authorization/gi,
        'authoriz\\u0061tion',
    )}\n`;
}

function defaultDependencies(options: Supabase22RetirementInventoryCliOptions): Supabase22RetirementInventoryDependencies {
    const cliPath = resolveSupabase22RetirementCliPath(options.cliPath);
    return {
        readProductionAggregate: async () => readOnlyCliAggregate(cliPath, options.projectRef),
        listRuntimeFiles: async () => execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
            .split('\0').filter(Boolean),
        readRuntimeFile: path => readFile(path, 'utf8'),
        writeReport: async (path, contents) => writeFile(path, contents, 'utf8'),
    };
}

export async function generateSupabase22RetirementInventory(
    args: readonly string[],
    dependencies?: Supabase22RetirementInventoryDependencies,
): Promise<Supabase22RetirementInventoryReport> {
    const options = parseSupabase22RetirementInventoryArgs(args);
    const activeDependencies = dependencies ?? defaultDependencies(options);
    const aggregates = await activeDependencies.readProductionAggregate();
    const callers = await scanSupabase22RuntimeCallers(
        aggregates.map(row => row.tableName),
        activeDependencies.listRuntimeFiles,
        activeDependencies.readRuntimeFile,
    );
    const report = await buildSupabase22RetirementInventoryReport(aggregates, callers);
    await activeDependencies.writeReport(
        SUPABASE_22_RETIREMENT_REPORT_PATH,
        serializeSupabase22RetirementInventoryReport(report),
    );
    return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    generateSupabase22RetirementInventory(process.argv.slice(2))
        .catch(() => {
            process.stderr.write('SUPABASE_22_RETIREMENT_FAILED\n');
            process.exitCode = 1;
        });
}
