import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    assertPiiSafeConsolidationOutput,
    adaptSupabase22CatalogRows,
    collectSupabase22CatalogEvidence,
    evaluateSupabase22Catalog,
    SUPABASE_OPERATIONAL_POLICY_SCHEMA,
    SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
    SUPABASE_OPERATIONAL_RETAINED_TABLES,
    SUPABASE_OPERATIONAL_FORBIDDEN_W1A,
    SUPABASE_OPERATIONAL_W1A_UPPER_BOUND,
    type Supabase22CatalogEvidence,
} from '../lib/services/operations/supabase-22-evidence';

const READ_ONLY_OPTIONS = new Set([
    '--execute', '--apply', '--drop', '--truncate', '--rename', '--delete', '--mutate',
]);

export type Supabase22CatalogCliOptions = Readonly<{
    reportOnly: boolean;
    manifestPath: string | null;
    projectRef: string | null;
}>;

function optionName(value: string): string {
    return value.split('=', 1)[0];
}

function isSafeProjectRef(value: string): boolean {
    return /^[a-z0-9]{20,64}$/i.test(value);
}

export function resolveSupabaseCliPath(
    override: string | undefined = process.env.SUPABASE_CLI_PATH,
    platform: NodeJS.Platform = process.platform,
): string {
    if (override && override.trim()) return override;
    if (platform === 'darwin' && existsSync('/opt/homebrew/bin/supabase')) {
        return '/opt/homebrew/bin/supabase';
    }
    return 'supabase';
}

const CATALOG_METADATA_KEYS = [
    'catalog', 'acl', 'routine', 'trigger', 'dependency', 'migration', 'rls',
    'view', 'publication', 'sequence', 'partition', 'foreignKey', 'legacyWriter',
] as const;
const CATALOG_EVIDENCE_KEYS = [
    'schemaVersion', 'sourceSha', 'status', 'publicTableCount', 'canonicalTables', 'unexpectedTables',
    'missingTables', 'dependencyClean', 'migrationHistoryClean', 'rlsClean',
    'routinesClean', 'canonicalRelationsAclClean', 'privateRoutinesAclClean',
    'serviceRpcsAclClean', 'clientRpcsAclClean', 'aclClean', 'triggersClean',
    'foreignKeysClean', 'viewsClean',
    'publicationsClean', 'sequencesClean', 'partitionsClean', 'legacyWritersClean',
    'metadataAvailability', 'retainedTables', 'forbiddenW1A', 'approvedSubset',
    'deferredReasons', 'closure', 'noCascadeAllowlistHash', 'clean', 'destructiveOperations',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, requiredKeys: readonly string[]): boolean {
    return Object.keys(value).length === requiredKeys.length
        && requiredKeys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function safeCatalogName(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= 256
        && /^[a-z][a-z0-9_.-]*$/i.test(value);
}

export function parseSupabase22CatalogCliArgs(
    args: readonly string[],
): Supabase22CatalogCliOptions {
    let reportOnly = false;
    let manifestPath: string | null = null;
    let projectRef: string | null = null;
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        if (READ_ONLY_OPTIONS.has(optionName(option))) {
            throw new Error('read-only verifier rejects destructive mode');
        }
        if (option === '--report-only') {
            if (reportOnly) throw new Error('--report-only must appear exactly once');
            reportOnly = true;
            continue;
        }
        if (option === '--manifest' || option.startsWith('--manifest=')) {
            if (manifestPath !== null) throw new Error('--manifest must appear exactly once');
            const value = option === '--manifest' ? args[index + 1] : option.slice('--manifest='.length);
            if (!value || value.startsWith('--')) throw new Error('--manifest requires a path');
            manifestPath = value;
            if (option === '--manifest') index += 1;
            continue;
        }
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
        throw new Error('unknown argument');
    }
    return { reportOnly, manifestPath, projectRef };
}

export interface Supabase22CatalogCliDependencies {
    readCatalog(): Promise<unknown>;
    queryCatalog?(sql: string): PromiseLike<unknown>;
    readManifest?(path: string): Promise<unknown>;
    writeStdout(value: string): void;
}

export function parseSupabase22CliResponse(stdout: string): { rows: readonly unknown[] } {
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.slice(jsonStart)) as unknown;
    } catch {
        throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    }
    if (!isRecord(parsed) || !Array.isArray(parsed.rows)) {
        throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    }
    // Drop CLI boundary/warning metadata before the strict catalog adapter.
    return { rows: parsed.rows };
}

export function readSupabase22CliRows(read: () => string): { rows: readonly unknown[] } {
    try {
        return parseSupabase22CliResponse(read());
    } catch {
        throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    }
}

function defaultDependencies(projectRef: string | null): Supabase22CatalogCliDependencies {
    const queryCatalog = projectRef === null ? undefined : async (sql: string): Promise<unknown> => {
        return readSupabase22CliRows(() => execFileSync(resolveSupabaseCliPath(), [
                'db', 'query', '--linked', `--project-ref=${projectRef}`,
                '--output-format', 'json', sql,
            ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
    };
    return {
        // Supabase JS does not expose pg_catalog. A direct read-only catalog
        // connection may be injected by the operator; without one, fail closed
        // instead of guessing or calling an unprovisioned repository RPC.
        readCatalog: async () => {
            throw new Error('SUPABASE_22_CATALOG_READ_UNAVAILABLE');
        },
        ...(queryCatalog === undefined ? {} : { queryCatalog }),
        readManifest: async path => JSON.parse(await readFile(path, 'utf8')) as unknown,
        writeStdout: value => process.stdout.write(value),
    };
}

function parseManifest(value: unknown): Supabase22CatalogEvidence {
    if (!isRecord(value) || !hasOnlyKeys(value, CATALOG_EVIDENCE_KEYS)) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    const manifest = value as Partial<Supabase22CatalogEvidence>;
    if (manifest.schemaVersion !== SUPABASE_OPERATIONAL_POLICY_SCHEMA
        || manifest.sourceSha !== SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA
        || !Number.isSafeInteger(manifest.publicTableCount)
        || (manifest.publicTableCount ?? -1) < 0
        || (manifest.status !== 'ready' && manifest.status !== 'blocked')
        || !Array.isArray(manifest.canonicalTables)
        || !Array.isArray(manifest.unexpectedTables)
        || !Array.isArray(manifest.missingTables)
        || !Array.isArray(manifest.retainedTables)
        || !Array.isArray(manifest.forbiddenW1A)
        || !Array.isArray(manifest.approvedSubset)
        || !isRecord(manifest.deferredReasons)
        || !isRecord(manifest.closure)
        || (manifest.noCascadeAllowlistHash !== null
            && (typeof manifest.noCascadeAllowlistHash !== 'string'
                || !/^[0-9a-f]{64}$/i.test(manifest.noCascadeAllowlistHash)))
        || typeof manifest.dependencyClean !== 'boolean'
        || typeof manifest.migrationHistoryClean !== 'boolean'
        || typeof manifest.rlsClean !== 'boolean'
        || typeof manifest.routinesClean !== 'boolean'
        || typeof manifest.canonicalRelationsAclClean !== 'boolean'
        || typeof manifest.privateRoutinesAclClean !== 'boolean'
        || typeof manifest.serviceRpcsAclClean !== 'boolean'
        || typeof manifest.clientRpcsAclClean !== 'boolean'
        || typeof manifest.aclClean !== 'boolean'
        || typeof manifest.triggersClean !== 'boolean'
        || typeof manifest.foreignKeysClean !== 'boolean'
        || typeof manifest.viewsClean !== 'boolean'
        || typeof manifest.publicationsClean !== 'boolean'
        || typeof manifest.sequencesClean !== 'boolean'
        || typeof manifest.partitionsClean !== 'boolean'
        || typeof manifest.legacyWritersClean !== 'boolean'
        || !manifest.metadataAvailability
        || typeof manifest.clean !== 'boolean'
        || manifest.destructiveOperations !== 'refused') {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    if (manifest.canonicalTables.some(table => !safeCatalogName(table))
        || manifest.unexpectedTables.some(table => !safeCatalogName(table))
        || manifest.missingTables.some(table => !safeCatalogName(table))
        || manifest.retainedTables.some(table => !safeCatalogName(table))
        || manifest.forbiddenW1A.some(table => !safeCatalogName(table))
        || manifest.approvedSubset.some(table => !safeCatalogName(table))
        || Object.entries(manifest.deferredReasons).some(([key, value]) =>
            !safeCatalogName(key) || typeof value !== 'string' || value.trim().length === 0)) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    const retainedSet = new Set(manifest.retainedTables);
    const forbiddenSet = new Set(manifest.forbiddenW1A);
    const approvedSet = new Set(manifest.approvedSubset);
    const retainedClassificationClean = retainedSet.size === manifest.retainedTables.length
        && retainedSet.size === SUPABASE_OPERATIONAL_RETAINED_TABLES.length
        && SUPABASE_OPERATIONAL_RETAINED_TABLES.every(table => retainedSet.has(table));
    const forbiddenClassificationClean = forbiddenSet.size === manifest.forbiddenW1A.length
        && forbiddenSet.size === SUPABASE_OPERATIONAL_FORBIDDEN_W1A.length
        && SUPABASE_OPERATIONAL_FORBIDDEN_W1A.every(table => forbiddenSet.has(table));
    const approvedSubsetClean = approvedSet.size === manifest.approvedSubset.length
        && manifest.approvedSubset.every(table => SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.includes(table as never));
    const deferredReasonsComplete = SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.every(table =>
        approvedSet.has(table)
        || typeof manifest.deferredReasons?.[table] === 'string'
            && manifest.deferredReasons[table].trim().length > 0);
    const deferredReasonsClean = Object.keys(manifest.deferredReasons).every(table =>
        SUPABASE_OPERATIONAL_W1A_UPPER_BOUND.includes(table as never));
    if (!retainedClassificationClean
        || !forbiddenClassificationClean
        || !approvedSubsetClean
        || !deferredReasonsComplete
        || !deferredReasonsClean) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    const metadataAvailability = manifest.metadataAvailability;
    const metadataKeys = [
        'catalog', 'acl', 'routine', 'trigger', 'dependency', 'migration', 'rls',
        'view', 'publication', 'sequence', 'partition', 'foreignKey', 'legacyWriter',
    ] as const;
    if (!isRecord(metadataAvailability)
        || !hasOnlyKeys(metadataAvailability, CATALOG_METADATA_KEYS)
        || metadataKeys.some(key => typeof metadataAvailability[key] !== 'boolean')) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    const closureKeys = [
        'tables', 'routines', 'flags', 'indexes', 'triggers', 'policies', 'acls',
        'views', 'foreignKeys', 'sequences', 'publications', 'dependencies',
    ] as const;
    if (!hasOnlyKeys(manifest.closure!, closureKeys)
        || closureKeys.some(key => {
            const values = manifest.closure![key];
            return !Array.isArray(values)
                || values.length === 0
                || values.some(value => !safeCatalogName(value))
                || new Set(values).size !== values.length;
        })) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    const allChecksClean = manifest.dependencyClean
        && manifest.migrationHistoryClean
        && manifest.rlsClean
        && manifest.routinesClean
        && manifest.canonicalRelationsAclClean
        && manifest.privateRoutinesAclClean
        && manifest.serviceRpcsAclClean
        && manifest.clientRpcsAclClean
        && manifest.aclClean
        && manifest.triggersClean
        && manifest.foreignKeysClean
        && manifest.viewsClean
        && manifest.publicationsClean
        && manifest.sequencesClean
        && manifest.partitionsClean
        && manifest.legacyWritersClean;
    const allMetadataAvailable = metadataKeys.every(key => metadataAvailability[key] === true);
    const policyClassificationClean = retainedClassificationClean
        && forbiddenClassificationClean
        && approvedSubsetClean
        && deferredReasonsComplete
        && deferredReasonsClean
        && manifest.noCascadeAllowlistHash !== null;
    if (manifest.clean !== allChecksClean
        || manifest.clean !== allMetadataAvailable
        || manifest.clean !== policyClassificationClean
        || manifest.clean !== (manifest.status === 'ready')) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    return {
        schemaVersion: SUPABASE_OPERATIONAL_POLICY_SCHEMA,
        sourceSha: SUPABASE_OPERATIONAL_POLICY_SOURCE_SHA,
        status: manifest.clean ? 'ready' : 'blocked',
        publicTableCount: manifest.publicTableCount!,
        canonicalTables: [...manifest.canonicalTables],
        unexpectedTables: [...manifest.unexpectedTables],
        missingTables: [...manifest.missingTables],
        dependencyClean: manifest.dependencyClean,
        migrationHistoryClean: manifest.migrationHistoryClean,
        rlsClean: manifest.rlsClean,
        routinesClean: manifest.routinesClean,
        canonicalRelationsAclClean: manifest.canonicalRelationsAclClean,
        privateRoutinesAclClean: manifest.privateRoutinesAclClean,
        serviceRpcsAclClean: manifest.serviceRpcsAclClean,
        clientRpcsAclClean: manifest.clientRpcsAclClean,
        aclClean: manifest.aclClean,
        triggersClean: manifest.triggersClean,
        foreignKeysClean: manifest.foreignKeysClean,
        viewsClean: manifest.viewsClean,
        publicationsClean: manifest.publicationsClean,
        sequencesClean: manifest.sequencesClean,
        partitionsClean: manifest.partitionsClean,
        legacyWritersClean: manifest.legacyWritersClean,
        metadataAvailability: Object.fromEntries(
            metadataKeys.map(key => [key, metadataAvailability[key] === true]),
        ) as Supabase22CatalogEvidence['metadataAvailability'],
        retainedTables: [...manifest.retainedTables],
        forbiddenW1A: [...manifest.forbiddenW1A],
        approvedSubset: [...manifest.approvedSubset],
        deferredReasons: { ...manifest.deferredReasons } as Record<string, string>,
        closure: manifest.closure as Supabase22CatalogEvidence['closure'],
        noCascadeAllowlistHash: manifest.noCascadeAllowlistHash,
        clean: manifest.clean,
        destructiveOperations: 'refused',
    };
}

function unavailableCatalogEvidence(): Supabase22CatalogEvidence {
    return evaluateSupabase22Catalog({
        tables: [],
        acls: [],
        dependencies: [],
        foreignKeys: [],
        securityDefinerFunctions: [],
        migrationHistory: [],
        legacyWriters: [],
        views: [],
        sequences: [],
        partitions: [],
        publications: [],
        triggers: [],
        policies: [],
        metadataAvailability: {
            catalog: false,
            acl: false,
            routine: false,
            trigger: false,
            dependency: false,
            migration: false,
            rls: false,
            view: false,
            publication: false,
            sequence: false,
            partition: false,
            foreignKey: false,
            legacyWriter: false,
        },
    });
}

export async function runSupabase22CatalogCli(
    args: readonly string[],
    dependencies?: Supabase22CatalogCliDependencies,
): Promise<{ exitCode: 0 | 1; evidence: Supabase22CatalogEvidence }> {
    const options = parseSupabase22CatalogCliArgs(args);
    const activeDependencies = dependencies ?? defaultDependencies(options.projectRef);
    let evidence: Supabase22CatalogEvidence;
    try {
        if (options.manifestPath) {
            if (!activeDependencies.readManifest) throw new Error('SUPABASE_22_CATALOG_MANIFEST_READ_UNAVAILABLE');
            // A caller-supplied manifest is descriptive only; catalog readiness must
            // be derived from the bounded row reader below, never from booleans in JSON.
            parseManifest(await activeDependencies.readManifest(options.manifestPath));
            evidence = unavailableCatalogEvidence();
        } else if (activeDependencies.queryCatalog) {
            evidence = await collectSupabase22CatalogEvidence({ query: activeDependencies.queryCatalog });
        } else {
            if (!activeDependencies.readCatalog) throw new Error('SUPABASE_22_CATALOG_READ_UNAVAILABLE');
            const rawCatalog = await activeDependencies.readCatalog();
            // A prebuilt snapshot is not a row-to-snapshot proof and must not
            // silently become catalog readiness.
            evidence = evaluateSupabase22Catalog(adaptSupabase22CatalogRows(
                rawCatalog as Parameters<typeof adaptSupabase22CatalogRows>[0],
            ));
        }
    } catch {
        evidence = unavailableCatalogEvidence();
    }
    assertPiiSafeConsolidationOutput(evidence);
    activeDependencies.writeStdout(`${JSON.stringify(evidence, null, 2)}\n`);
    return { exitCode: evidence.clean ? 0 : 1, evidence };
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runSupabase22CatalogCli(process.argv.slice(2))
        .then(result => {
            process.exitCode = result.exitCode;
        })
        .catch(() => {
            process.stderr.write(`${JSON.stringify({
                status: 'failed',
                errorCode: 'SUPABASE_22_CATALOG_VERIFY_FAILED',
                destructiveOperations: 'refused',
            })}\n`);
            process.exitCode = 1;
        });
}
