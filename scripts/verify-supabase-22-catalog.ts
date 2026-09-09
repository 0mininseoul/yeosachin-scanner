import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
    assertPiiSafeConsolidationOutput,
    adaptSupabase22CatalogRows,
    collectSupabase22CatalogEvidence,
    evaluateSupabase22Catalog,
    SUPABASE_22_CANONICAL_TABLES,
    type Supabase22CatalogEvidence,
} from '../lib/services/operations/supabase-22-evidence';

const READ_ONLY_OPTIONS = new Set([
    '--execute', '--apply', '--drop', '--truncate', '--rename', '--delete', '--mutate',
]);

export type Supabase22CatalogCliOptions = Readonly<{
    reportOnly: boolean;
    manifestPath: string | null;
}>;

function optionName(value: string): string {
    return value.split('=', 1)[0];
}

const CATALOG_METADATA_KEYS = [
    'catalog', 'acl', 'routine', 'trigger', 'dependency', 'migration', 'rls',
    'view', 'publication', 'sequence', 'partition', 'foreignKey', 'legacyWriter',
] as const;
const CATALOG_EVIDENCE_KEYS = [
    'schemaVersion', 'status', 'publicTableCount', 'canonicalTables', 'unexpectedTables',
    'missingTables', 'dependencyClean', 'migrationHistoryClean', 'rlsClean',
    'routinesClean', 'canonicalRelationsAclClean', 'privateRoutinesAclClean',
    'serviceRpcsAclClean', 'clientRpcsAclClean', 'aclClean', 'triggersClean',
    'foreignKeysClean', 'viewsClean',
    'publicationsClean', 'sequencesClean', 'partitionsClean', 'legacyWritersClean',
    'metadataAvailability', 'clean', 'destructiveOperations',
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
        throw new Error('unknown argument');
    }
    return { reportOnly, manifestPath };
}

export interface Supabase22CatalogCliDependencies {
    readCatalog(): Promise<unknown>;
    queryCatalog?(sql: string): PromiseLike<unknown>;
    readManifest?(path: string): Promise<unknown>;
    writeStdout(value: string): void;
}

function defaultDependencies(): Supabase22CatalogCliDependencies {
    return {
        // Supabase JS does not expose pg_catalog. A direct read-only catalog
        // connection may be injected by the operator; without one, fail closed
        // instead of guessing or calling an unprovisioned repository RPC.
        readCatalog: async () => {
            throw new Error('SUPABASE_22_CATALOG_READ_UNAVAILABLE');
        },
        readManifest: async path => JSON.parse(await readFile(path, 'utf8')) as unknown,
        writeStdout: value => process.stdout.write(value),
    };
}

function parseManifest(value: unknown): Supabase22CatalogEvidence {
    if (!isRecord(value) || !hasOnlyKeys(value, CATALOG_EVIDENCE_KEYS)) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    const manifest = value as Partial<Supabase22CatalogEvidence>;
    if (manifest.schemaVersion !== 'supabase-22-catalog-v1'
        || !Number.isSafeInteger(manifest.publicTableCount)
        || (manifest.publicTableCount ?? -1) < 0
        || (manifest.status !== 'ready' && manifest.status !== 'blocked')
        || !Array.isArray(manifest.canonicalTables)
        || !Array.isArray(manifest.unexpectedTables)
        || !Array.isArray(manifest.missingTables)
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
        || manifest.missingTables.some(table => !safeCatalogName(table))) {
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
    const exactCanonicalSet = manifest.publicTableCount === SUPABASE_22_CANONICAL_TABLES.length
        && [...manifest.canonicalTables].sort().join('\u0000')
        === SUPABASE_22_CANONICAL_TABLES.join('\u0000')
        && manifest.unexpectedTables.length === 0
        && manifest.missingTables.length === 0;
    const allMetadataAvailable = metadataKeys.every(key => metadataAvailability[key] === true);
    if (manifest.clean !== allChecksClean
        || manifest.clean !== allMetadataAvailable
        || (manifest.clean && !exactCanonicalSet)
        || manifest.clean !== (manifest.status === 'ready')) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    return {
        schemaVersion: 'supabase-22-catalog-v1',
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
    dependencies: Supabase22CatalogCliDependencies = defaultDependencies(),
): Promise<{ exitCode: 0 | 1; evidence: Supabase22CatalogEvidence }> {
    const options = parseSupabase22CatalogCliArgs(args);
    let evidence: Supabase22CatalogEvidence;
    try {
        if (options.manifestPath) {
            if (!dependencies.readManifest) throw new Error('SUPABASE_22_CATALOG_MANIFEST_READ_UNAVAILABLE');
            // A caller-supplied manifest is descriptive only; catalog readiness must
            // be derived from the bounded row reader below, never from booleans in JSON.
            parseManifest(await dependencies.readManifest(options.manifestPath));
            evidence = unavailableCatalogEvidence();
        } else if (dependencies.queryCatalog) {
            evidence = await collectSupabase22CatalogEvidence({ query: dependencies.queryCatalog });
        } else {
            const rawCatalog = await dependencies.readCatalog();
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
    dependencies.writeStdout(`${JSON.stringify(evidence, null, 2)}\n`);
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
