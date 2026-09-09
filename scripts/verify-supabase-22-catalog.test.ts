import { describe, expect, it, vi } from 'vitest';
import {
    parseSupabase22CatalogCliArgs,
    runSupabase22CatalogCli,
    type Supabase22CatalogCliDependencies,
} from './verify-supabase-22-catalog';
import { SUPABASE_22_CANONICAL_TABLES } from '../lib/services/operations/supabase-22-evidence';

describe('Supabase 22 catalog verifier CLI', () => {
    it('rejects every execute/apply/mutate mode', () => {
        for (const option of ['--execute', '--apply', '--drop', '--truncate', '--rename', '--delete', '--mutate']) {
            expect(() => parseSupabase22CatalogCliArgs([option])).toThrow('read-only');
        }
    });

    it('accepts report-only mode and optional manifest marker', () => {
        expect(parseSupabase22CatalogCliArgs(['--report-only', '--manifest', 'catalog.json']))
            .toEqual({ reportOnly: true, manifestPath: 'catalog.json' });
    });

    it('prints sanitized catalog evidence and exits non-zero when the live set is not exact', async () => {
        const writeStdout = vi.fn();
        const readCatalog = vi.fn(async () => ({
            tables: [{
                name: SUPABASE_22_CANONICAL_TABLES[0],
                relkind: 'r' as const,
                rlsEnabled: true,
                forceRls: false,
            }],
            dependencies: [],
            securityDefinerFunctions: [],
            migrationHistory: [],
            legacyWriters: [],
            views: [],
            sequences: [],
            partitions: [],
            publications: [],
            triggers: [],
            policies: [],
        }));
        const dependencies: Supabase22CatalogCliDependencies = { readCatalog, writeStdout };

        const result = await runSupabase22CatalogCli(['--report-only'], dependencies);

        expect(result.exitCode).toBe(1);
        const output = JSON.parse(writeStdout.mock.calls[0]?.[0] as string);
        expect(output).toMatchObject({ schemaVersion: 'supabase-22-catalog-v1' });
        expect(JSON.stringify(output)).not.toContain('read_supabase_22_catalog');
    });
});
