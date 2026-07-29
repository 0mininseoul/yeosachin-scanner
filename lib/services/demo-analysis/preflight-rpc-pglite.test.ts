import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const initialMigration = readFileSync(
    new URL('../../../supabase/migrations/20260726050000_add_demo_analysis_runs.sql', import.meta.url),
    'utf8',
);
const fixMigration = readFileSync(
    new URL('../../../supabase/migrations/20260727013100_fix_demo_analysis_preflight_ambiguity.sql', import.meta.url),
    'utf8',
);
const v2Migration = readFileSync(
    new URL('../../../supabase/migrations/20260727130000_upgrade_demo_fixture_v2.sql', import.meta.url),
    'utf8',
);
const v3Migration = readFileSync(
    new URL('../../../supabase/migrations/20260727141000_upgrade_demo_fixture_v3_redacted.sql', import.meta.url),
    'utf8',
);
const v4Migration = readFileSync(
    new URL('../../../supabase/migrations/20260730020000_upgrade_demo_fixture_v4_bijective_forward.sql', import.meta.url),
    'utf8',
);

const userId = '123e4567-e89b-42d3-a456-426614174000';
const idempotencyKey = 'demo-preflight-key-000000000000';
let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id UUID PRIMARY KEY);
        INSERT INTO auth.users VALUES ('${userId}');
    `);
    await db.exec(initialMigration);
    await db.exec(fixMigration);
    await db.exec(`
        INSERT INTO public.demo_analysis_runs (
            user_id, target_instagram_id, fixture_version, plan_id, idempotency_key, duration_seconds
        ) VALUES (
            '${userId}', 'junho_dem', 'synthetic-fixture-v1', 'standard', 'legacy-demo-preflight-key-000000', 75
        )
    `);
    await db.exec(v2Migration);
    await db.exec(v3Migration);
    await db.exec(v4Migration);
});

afterAll(async () => db.close());

describe('create_demo_analysis_preflight forward fix', () => {
    it('creates and replays the exact isolated demo RPC contract without column ambiguity', async () => {
        await db.exec('SET ROLE service_role');
        const first = await db.query<{
            id: string;
            user_id: string;
            target_instagram_id: string;
            fixture_version: string;
            idempotency_key: string;
            duration_seconds: number;
            started_at: string | null;
            created: boolean;
        }>(`
            SELECT * FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', '${idempotencyKey}', 38
            )
        `);
        const replay = await db.query<{ id: string; created: boolean }>(`
            SELECT id, created FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', '${idempotencyKey}', 38
            )
        `);
        await db.exec('RESET ROLE');

        expect(first.rows).toHaveLength(1);
        expect(first.rows[0]).toMatchObject({
            user_id: userId,
            target_instagram_id: 'junho_dem',
            fixture_version: 'authorized-redacted-fixture-v4',
            idempotency_key: idempotencyKey,
            duration_seconds: 38,
            started_at: null,
            created: true,
        });
        expect(replay.rows).toEqual([{ id: first.rows[0]!.id, created: false }]);
    });

    it('retains v1/v2/v3 rows while v4 admits only its shorter server-owned bound', async () => {
        const legacy = await db.query<{ fixture_version: string; duration_seconds: number }>(`
            SELECT fixture_version, duration_seconds
            FROM public.demo_analysis_runs
            WHERE idempotency_key = 'legacy-demo-preflight-key-000000'
        `);
        expect(legacy.rows).toEqual([{ fixture_version: 'synthetic-fixture-v1', duration_seconds: 75 }]);

        const startedLegacy = await db.query<{ fixture_version: string; duration_seconds: number; started_at: string | null }>(`
            SELECT fixture_version, duration_seconds, started_at
            FROM public.start_demo_analysis_run(
                (SELECT id FROM public.demo_analysis_runs WHERE idempotency_key = 'legacy-demo-preflight-key-000000'),
                '${userId}'
            )
        `);
        expect(startedLegacy.rows[0]).toMatchObject({
            fixture_version: 'synthetic-fixture-v1',
            duration_seconds: 75,
        });
        expect(startedLegacy.rows[0]?.started_at).not.toBeNull();

        const persistedV2 = await db.query<{ fixture_version: string; duration_seconds: number }>(`
            INSERT INTO public.demo_analysis_runs (
                user_id, target_instagram_id, fixture_version, plan_id, idempotency_key, duration_seconds
            ) VALUES (
                '${userId}', 'junho_dem', 'authorized-text-fixture-v2', 'standard', 'persisted-v2-demo-preflight-key-000000', 38
            ) RETURNING fixture_version, duration_seconds
        `);
        expect(persistedV2.rows).toEqual([{ fixture_version: 'authorized-text-fixture-v2', duration_seconds: 38 }]);

        const persistedV3 = await db.query<{ fixture_version: string; duration_seconds: number }>(`
            INSERT INTO public.demo_analysis_runs (
                user_id, target_instagram_id, fixture_version, plan_id, idempotency_key, duration_seconds
            ) VALUES (
                '${userId}', 'junho_dem', 'authorized-redacted-fixture-v3', 'standard', 'persisted-v3-demo-preflight-key-000000', 38
            ) RETURNING fixture_version, duration_seconds
        `);
        expect(persistedV3.rows).toEqual([{ fixture_version: 'authorized-redacted-fixture-v3', duration_seconds: 38 }]);

        await expect(db.query(`
            SELECT * FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'invalid-v2-duration-key-0000000', 75
            )
        `)).rejects.toThrow(/invalid demo v4 run input/i);
    });

    it('keeps the exact RPC executable only by service_role', async () => {
        const privileges = await db.query<{ service: boolean; anon: boolean; authenticated: boolean }>(`
            SELECT
              has_function_privilege('service_role',
                'public.create_demo_analysis_preflight(uuid,text,text,integer)', 'EXECUTE') AS service,
              has_function_privilege('anon',
                'public.create_demo_analysis_preflight(uuid,text,text,integer)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated',
                'public.create_demo_analysis_preflight(uuid,text,text,integer)', 'EXECUTE') AS authenticated
        `);
        expect(privileges.rows[0]).toEqual({ service: true, anon: false, authenticated: false });
    });
});
