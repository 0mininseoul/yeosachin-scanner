import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    assertPiiSafeConsolidationOutput,
    adaptSupabase22CatalogRows,
    collectSupabase22CatalogEvidence,
    evaluateSupabase22Catalog,
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

export function parseSupabase22CliResponse(stdout: string): { rows: readonly unknown[] } {
    const jsonStart = stdout.indexOf('{');
    if (jsonStart < 0) throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.slice(jsonStart)) as unknown;
    } catch {
        throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || !Array.isArray((parsed as { rows?: unknown }).rows)) {
        throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    }
    return { rows: (parsed as { rows: readonly unknown[] }).rows };
}

export function readSupabase22CliRows(read: () => string): { rows: readonly unknown[] } {
    try {
        return parseSupabase22CliResponse(read());
    } catch {
        throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
    }
}

export interface Supabase22CatalogCliDependencies {
    readCatalog(): Promise<unknown>;
    queryCatalog?(sql: string): PromiseLike<unknown>;
    /** Read only to establish that a historical file is descriptive; never a readiness source. */
    readManifest?(path: string): Promise<unknown>;
    writeStdout(value: string): void;
}

function defaultDependencies(projectRef: string | null): Supabase22CatalogCliDependencies {
    const queryCatalog = projectRef === null ? undefined : async (sql: string): Promise<unknown> => (
        readSupabase22CliRows(() => execFileSync(resolveSupabaseCliPath(), [
            'db', 'query', '--linked', `--project-ref=${projectRef}`,
            '--output-format', 'json', sql,
        ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }))
    );
    return {
        // Supabase JS does not expose pg_catalog. Without an injected
        // read-only catalog connection, fail closed instead of guessing.
        readCatalog: async () => {
            throw new Error('SUPABASE_22_CATALOG_READ_UNAVAILABLE');
        },
        ...(queryCatalog === undefined ? {} : { queryCatalog }),
        readManifest: async path => JSON.parse(await readFile(path, 'utf8')) as unknown,
        writeStdout: value => process.stdout.write(value),
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
            // Historical manifests are descriptive provenance only. Reading a
            // JSON file cannot establish current signatures, ACLs, dependencies,
            // or drain state, so a live independent reader is still required.
            if (!activeDependencies.readManifest) {
                throw new Error('SUPABASE_22_CATALOG_MANIFEST_READ_UNAVAILABLE');
            }
            await activeDependencies.readManifest(options.manifestPath);
            if (activeDependencies.queryCatalog) {
                evidence = await collectSupabase22CatalogEvidence({ query: activeDependencies.queryCatalog });
            } else {
                evidence = unavailableCatalogEvidence();
            }
        } else if (activeDependencies.queryCatalog) {
            evidence = await collectSupabase22CatalogEvidence({ query: activeDependencies.queryCatalog });
        } else {
            const rawCatalog = await activeDependencies.readCatalog();
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
        .then(result => { process.exitCode = result.exitCode; })
        .catch(() => {
            process.stderr.write(`${JSON.stringify({
                status: 'failed',
                errorCode: 'SUPABASE_22_CATALOG_VERIFY_FAILED',
                destructiveOperations: 'refused',
            })}\n`);
            process.exitCode = 1;
        });
}
