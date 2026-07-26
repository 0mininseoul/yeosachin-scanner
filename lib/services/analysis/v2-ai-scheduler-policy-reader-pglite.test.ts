import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const predecessor = readFileSync(new URL(
    '../../../supabase/migrations/20260727020000_add_analysis_v2_ai_scheduler_policy_snapshot.sql',
    import.meta.url,
), 'utf8');
const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260727030000_add_analysis_v2_policy_snapshot_reader.sql',
    import.meta.url,
), 'utf8');

const databases: PGlite[] = [];

async function database(): Promise<PGlite> {
    const db = new PGlite();
    databases.push(db);
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY,
            pipeline_version TEXT NOT NULL,
            policy_versions_snapshot JSONB NOT NULL
        );
    `);
    return db;
}

afterEach(async () => {
    await Promise.all(databases.splice(0).map(db => db.close()));
});

describe('analysis V2 scheduler policy reader migration', () => {
    it('accepts the exact predecessor and distinguishes legacy from scheduler-v1', async () => {
        const db = await database();
        await db.exec(predecessor);
        await db.exec(migration);
        const snapshots = await db.query<{ scheduler: boolean; legacy: boolean }>(`
            SELECT
                public.analysis_v2_valid_scheduler_policy_snapshot_v1(
                    '{"pipeline":"v2","risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7","scheduler":"ai-scheduler-v1"}'::JSONB
                ) AS scheduler,
                public.analysis_v2_valid_scheduler_policy_snapshot_v1(
                    '{"pipeline":"v2","risk":"risk-policy-v2.4","aiStage":"ai-stage-policy-v2.7"}'::JSONB
                ) AS legacy
        `);
        expect(snapshots.rows[0]).toEqual({ scheduler: true, legacy: false });
    });

    it('fails before creating the reader when the predecessor validator is permissive drift', async () => {
        const db = await database();
        await db.exec(`
            CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(p_snapshot JSONB)
            RETURNS BOOLEAN
            LANGUAGE sql
            IMMUTABLE
            SECURITY INVOKER
            SET search_path = ''
            AS $$ SELECT TRUE $$;
        `);
        await expect(db.exec(migration)).rejects.toThrow(
            'ANALYSIS_V2_SCHEDULER_POLICY_PREDECESSOR_DRIFT',
        );
        const reader = await db.query<{ reader: string | null }>(
            "SELECT pg_catalog.to_regprocedure('public.load_analysis_v2_policy_versions_snapshot(uuid)')::TEXT AS reader",
        );
        expect(reader.rows[0]?.reader).toBeNull();
    });
});
