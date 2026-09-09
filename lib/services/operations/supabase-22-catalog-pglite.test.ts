import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    collectSupabase22CatalogEvidence,
} from './supabase-22-evidence';

const CANONICAL_TABLES = [
    'account_lifecycle', 'analysis_artifacts', 'analysis_audit_bundles',
    'analysis_cache', 'analysis_costs', 'analysis_events', 'analysis_jobs',
    'analysis_preflights', 'analysis_provider_runs', 'analysis_requests',
    'analysis_results', 'earlybird_orders', 'earlybird_waitlist',
    'fulfillment_jobs', 'landing_leads', 'maintenance_jobs',
    'notification_outbox', 'payment_events', 'result_feedback',
    'system_configuration', 'system_leases', 'users',
];

describe('Supabase 22 catalog collector with a disposable catalog', () => {
    let db: PGlite;

    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE TABLE public.users (id integer);
            CREATE TABLE public.analysis_requests (id integer);
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('collects catalog rows without turning SQL execution into a mutation path', async () => {
        const query = async (sql: string): Promise<unknown> => {
            expect(sql).toContain('pg_catalog');
            expect(sql.toUpperCase()).not.toMatch(/\b(DROP|TRUNCATE|ALTER|INSERT|UPDATE|DELETE)\b/);
            const result = await db.query<{ relname: string }>(sql);
            return {
                tables: result.rows.map(row => ({
                    name: row.relname,
                    relkind: 'r',
                    rlsEnabled: true,
                    forceRls: false,
                })),
                dependencies: [],
                securityDefinerFunctions: [],
                migrationHistory: [{ version: '20260905000000' }],
                legacyWriters: [],
                views: [],
                sequences: [],
                partitions: [],
                publications: [],
                triggers: [],
                policies: [],
            };
        };

        const evidence = await collectSupabase22CatalogEvidence({ query });

        expect(evidence.publicTableCount).toBe(2);
        expect(evidence.canonicalTables).toEqual(['analysis_requests', 'users']);
        expect(evidence.unexpectedTables).toEqual([]);
        expect(evidence.missingTables).toEqual(CANONICAL_TABLES.filter(
            table => !['analysis_requests', 'users'].includes(table),
        ));
        expect(evidence.dependencyClean).toBe(true);
        expect(evidence.rlsClean).toBe(true);
    });
});
