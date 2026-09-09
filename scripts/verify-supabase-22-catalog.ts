import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { supabaseAdmin } from '../lib/supabase/admin';
import {
    assertPiiSafeConsolidationOutput,
    evaluateSupabase22Catalog,
    SUPABASE_22_CATALOG_QUERY,
    type Supabase22CatalogEvidence,
    type Supabase22CatalogSnapshot,
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
    readCatalog(): Promise<Supabase22CatalogSnapshot>;
    readManifest?(path: string): Promise<unknown>;
    writeStdout(value: string): void;
}

function defaultDependencies(): Supabase22CatalogCliDependencies {
    return {
        readCatalog: async () => {
            const { data, error } = await supabaseAdmin.rpc('read_supabase_22_catalog', {
                p_catalog_query: SUPABASE_22_CATALOG_QUERY,
            });
            if (error) throw new Error('SUPABASE_22_CATALOG_READ_FAILED');
            return data as Supabase22CatalogSnapshot;
        },
        readManifest: async path => JSON.parse(await readFile(path, 'utf8')) as unknown,
        writeStdout: value => process.stdout.write(value),
    };
}

function parseManifest(value: unknown): Supabase22CatalogEvidence {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    const manifest = value as Partial<Supabase22CatalogEvidence>;
    if (manifest.schemaVersion !== 'supabase-22-catalog-v1'
        || typeof manifest.publicTableCount !== 'number'
        || !Array.isArray(manifest.canonicalTables)
        || !Array.isArray(manifest.unexpectedTables)
        || !Array.isArray(manifest.missingTables)
        || typeof manifest.clean !== 'boolean') {
        throw new Error('SUPABASE_22_CATALOG_MANIFEST_INVALID');
    }
    return manifest as Supabase22CatalogEvidence;
}

export async function runSupabase22CatalogCli(
    args: readonly string[],
    dependencies: Supabase22CatalogCliDependencies = defaultDependencies(),
): Promise<{ exitCode: 0 | 1; evidence: Supabase22CatalogEvidence }> {
    const options = parseSupabase22CatalogCliArgs(args);
    const evidence = options.manifestPath && dependencies.readManifest
        ? parseManifest(await dependencies.readManifest(options.manifestPath))
        : evaluateSupabase22Catalog(await dependencies.readCatalog());
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
