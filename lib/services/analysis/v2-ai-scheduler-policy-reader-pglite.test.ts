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
    }, 15_000);

    it('uses the canonical 128-character SQL policy-version boundary', async () => {
        const db = await database();
        await db.exec(migration);
        for (const length of [64, 65, 128]) {
            const value = `v${'a'.repeat(length - 1)}`;
            const accepted = await db.query<{ valid: boolean }>(
                `SELECT public.analysis_v2_scheduler_reader_valid_policy_snapshot_v1(
                    pg_catalog.jsonb_build_object(
                        'pipeline', $1::TEXT,
                        'risk', 'risk-policy-v2.4',
                        'aiStage', 'ai-stage-policy-v2.7'
                    )
                ) AS valid`,
                [value],
            );
            expect(accepted.rows[0]?.valid).toBe(true);
        }
        const rejected = await db.query<{ valid: boolean }>(
            `SELECT public.analysis_v2_scheduler_reader_valid_policy_snapshot_v1(
                pg_catalog.jsonb_build_object(
                    'pipeline', $1::TEXT,
                    'risk', 'risk-policy-v2.4',
                    'aiStage', 'ai-stage-policy-v2.7'
                )
            ) AS valid`,
            [`v${'a'.repeat(128)}`],
        );
        expect(rejected.rows[0]?.valid).toBe(false);
    });

    it('rejects malformed snapshots despite a deceptive permissive historical validator', async () => {
        const db = await database();
        await db.exec(`
            CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(p_snapshot JSONB)
            RETURNS BOOLEAN
            LANGUAGE sql
            IMMUTABLE
            SECURITY INVOKER
            SET search_path = ''
            AS $$
                SELECT TRUE
                /* deceptive markers:
                   p_snapshot ? 'scheduler'
                   ai-scheduler-v1
                   item_count > 16
                   jsonb_typeof
                */
            $$;
        `);
        await db.exec(migration);
        const requestId = '123e4567-e89b-42d3-a456-426614174000';
        await db.query(
            `INSERT INTO public.analysis_requests
                (id, pipeline_version, policy_versions_snapshot)
             VALUES ($1, 'v2', '{"scheduler":"ai-scheduler-v2"}'::JSONB)`,
            [requestId],
        );
        const reader = await db.query<{ snapshot: unknown | null }>(
            'SELECT public.load_analysis_v2_policy_versions_snapshot($1) AS snapshot',
            [requestId],
        );
        expect(reader.rows[0]?.snapshot).toBeNull();
    });

    it('rejects malformed snapshots when predecessor v2 returns TRUE with marker unchanged', async () => {
        const db = await database();
        await db.exec(predecessor);
        await db.exec(`
            CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot_v2(
                p_snapshot JSONB
            )
            RETURNS BOOLEAN
            LANGUAGE sql
            IMMUTABLE
            SECURITY INVOKER
            SET search_path = ''
            AS $$ SELECT TRUE $$;

            CREATE FUNCTION public.analysis_v2_policy_validator_contract_version()
            RETURNS TEXT
            LANGUAGE sql
            IMMUTABLE
            SECURITY INVOKER
            SET search_path = ''
            AS $$ SELECT 'analysis-v2-policy-validator-v2'::TEXT $$;
        `);
        const marker = await db.query<{ version: string }>(
            'SELECT public.analysis_v2_policy_validator_contract_version() AS version',
        );
        expect(marker.rows[0]?.version).toBe('analysis-v2-policy-validator-v2');
        await db.exec(migration);
        const requestId = '223e4567-e89b-42d3-a456-426614174000';
        await db.query(
            `INSERT INTO public.analysis_requests
                (id, pipeline_version, policy_versions_snapshot)
             VALUES ($1, 'v2', '{"scheduler":null}'::JSONB)`,
            [requestId],
        );
        const result = await db.query<{ snapshot: unknown | null; schedulable: boolean }>(
            `SELECT
                public.load_analysis_v2_policy_versions_snapshot($1) AS snapshot,
                public.analysis_v2_valid_scheduler_policy_snapshot_v1(
                    '{"pipeline":"v2","risk":"r","aiStage":"a","scheduler":null}'::JSONB
                ) AS schedulable`,
            [requestId],
        );
        expect(result.rows[0]).toEqual({ snapshot: null, schedulable: false });
    });
});
