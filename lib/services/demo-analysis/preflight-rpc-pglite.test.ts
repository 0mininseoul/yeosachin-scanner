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
                '${userId}', 'junho_dem', '${idempotencyKey}', 75
            )
        `);
        const replay = await db.query<{ id: string; created: boolean }>(`
            SELECT id, created FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', '${idempotencyKey}', 75
            )
        `);
        await db.exec('RESET ROLE');

        expect(first.rows).toHaveLength(1);
        expect(first.rows[0]).toMatchObject({
            user_id: userId,
            target_instagram_id: 'junho_dem',
            fixture_version: 'synthetic-fixture-v1',
            idempotency_key: idempotencyKey,
            duration_seconds: 75,
            started_at: null,
            created: true,
        });
        expect(replay.rows).toEqual([{ id: first.rows[0]!.id, created: false }]);
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
