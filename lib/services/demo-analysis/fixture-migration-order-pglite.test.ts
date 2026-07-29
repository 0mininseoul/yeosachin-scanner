import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import { createDemoFixture } from './demo-analysis';

const migrationPaths = [
    '20260726050000_add_demo_analysis_runs.sql',
    '20260727010100_expire_demo_analysis_runs.sql',
    '20260727013100_fix_demo_analysis_preflight_ambiguity.sql',
    '20260727130000_upgrade_demo_fixture_v2.sql',
    '20260727141000_upgrade_demo_fixture_v3_redacted.sql',
    '20260730010000_demo_analysis_editable_fixture_authority.sql',
    '20260730020000_upgrade_demo_fixture_v4_bijective_forward.sql',
    '20260730030000_restore_demo_fixture_authority_after_v4.sql',
];

const userId = '123e4567-e89b-42d3-a456-426614174000';
let db: PGlite | undefined;

function payload() {
    const fixture = createDemoFixture('pglite-migration-order-fixture');
    return JSON.stringify({
        target: {
            username: 'junho_dem', fullName: '모의 분석용 공개 계정', bio: '산책과 사진을 기록하는 데모 프로필입니다.',
            profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false,
        },
        summary: fixture.summary,
        public: fixture.publicAccounts,
        private: fixture.privateAccounts,
    }).replace(/'/g, "''");
}

async function databaseAtCurrentMigrationHead(): Promise<PGlite> {
    const database = await PGlite.create();
    await database.exec(`
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id uuid PRIMARY KEY);
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
    `);
    for (const migrationPath of migrationPaths) {
        await database.exec(readFileSync(
            new URL(`../../../supabase/migrations/${migrationPath}`, import.meta.url),
            'utf8',
        ));
    }
    await database.exec(`INSERT INTO auth.users (id) VALUES ('${userId}');`);
    return database;
}

afterEach(async () => {
    await db?.close();
    db = undefined;
});

describe('demo fixture migration history', () => {
    it('preserves editable-fixture authority after every current demo migration', async () => {
        db = await databaseAtCurrentMigrationHead();

        const signatures = await db.query<{ argument_count: number; security_definer: boolean; configuration: string }>(`
            SELECT proc.pronargs AS argument_count,
              proc.prosecdef AS security_definer,
              coalesce(array_to_string(proc.proconfig, ','), '') AS configuration
            FROM pg_proc AS proc
            INNER JOIN pg_namespace AS namespace ON namespace.oid = proc.pronamespace
            WHERE namespace.nspname = 'public'
              AND proc.proname = 'create_demo_analysis_preflight'
            ORDER BY proc.pronargs
        `);
        expect(signatures.rows).toEqual([{
            argument_count: 6,
            security_definer: true,
            configuration: 'search_path=""',
        }]);

        await expect(db.query(`
            SELECT * FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'obsolete-four-argument-key-000001', 38
            )
        `)).rejects.toThrow();

        const privileges = await db.query<{ service: boolean; public: boolean; anon: boolean; authenticated: boolean }>(`
            SELECT
              has_function_privilege('service_role', 'public.create_demo_analysis_preflight(uuid,text,text,integer,text,jsonb)', 'EXECUTE') AS service,
              has_function_privilege('public', 'public.create_demo_analysis_preflight(uuid,text,text,integer,text,jsonb)', 'EXECUTE') AS public,
              has_function_privilege('anon', 'public.create_demo_analysis_preflight(uuid,text,text,integer,text,jsonb)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.create_demo_analysis_preflight(uuid,text,text,integer,text,jsonb)', 'EXECUTE') AS authenticated
        `);
        expect(privileges.rows).toEqual([{ service: true, public: false, anon: false, authenticated: false }]);

        const fixturePayload = payload();
        await db.exec(`
            INSERT INTO public.demo_analysis_fixtures (version, status, payload)
            VALUES ('operator-editable-fixture-order', 'draft', '${fixturePayload}'::jsonb);
            SELECT public.publish_demo_analysis_fixture('operator-editable-fixture-order', '${fixturePayload}'::jsonb);
        `);
        const run = await db.query<{ fixture_version: string }>(`
            SELECT fixture_version
            FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'migration-order-dynamic-key-000001', 38,
                'operator-editable-fixture-order', '${fixturePayload}'::jsonb
            )
        `);
        expect(run.rows).toEqual([{ fixture_version: 'operator-editable-fixture-order' }]);

        const missingFixture = await db.query(`
            SELECT *
            FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'migration-order-missing-key-000001', 38,
                'operator-editable-fixture-missing', '${fixturePayload}'::jsonb
            )
        `);
        expect(missingFixture.rows).toEqual([]);

        await db.exec(`
            INSERT INTO public.demo_analysis_fixtures (version, status, payload)
            VALUES ('operator-editable-fixture-next', 'draft', '${fixturePayload}'::jsonb);
            SELECT public.publish_demo_analysis_fixture('operator-editable-fixture-next', '${fixturePayload}'::jsonb);
        `);
        const replay = await db.query<{ fixture_version: string; created: boolean }>(`
            SELECT fixture_version, created
            FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'migration-order-dynamic-key-000001', 38,
                'operator-editable-fixture-order', '${fixturePayload}'::jsonb
            )
        `);
        expect(replay.rows).toEqual([{ fixture_version: 'operator-editable-fixture-order', created: false }]);

        await db.exec(`
            INSERT INTO public.demo_analysis_runs (user_id, target_instagram_id, fixture_version, plan_id, idempotency_key, duration_seconds)
            VALUES
              ('${userId}', 'junho_dem', 'synthetic-fixture-v1', 'standard', 'legacy-v1-duration-key-000001', 60),
              ('${userId}', 'junho_dem', 'authorized-text-fixture-v2', 'standard', 'legacy-v2-duration-key-000001', 30),
              ('${userId}', 'junho_dem', 'authorized-redacted-fixture-v3', 'standard', 'legacy-v3-duration-key-000001', 45),
              ('${userId}', 'junho_dem', 'authorized-redacted-fixture-v4', 'standard', 'legacy-v4-duration-key-000001', 30);
        `);
    });
});
