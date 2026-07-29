import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDemoFixture } from './demo-analysis';

const sql = (name: string) => readFileSync(new URL(`../../../supabase/migrations/${name}`, import.meta.url), 'utf8');
const userId = '123e4567-e89b-42d3-a456-426614174000';
let db: PGlite;

function v2Payload() {
    const fixture = createDemoFixture('v2-migration-runtime-fixture');
    return JSON.stringify({
        target: {
            username: 'junho_dem', fullName: '김도윤', bio: null,
            profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false,
        },
        summary: fixture.summary,
        public: fixture.publicAccounts,
        private: fixture.privateAccounts,
    });
}

function quotedPayload(payload = v2Payload()) {
    return payload.replace(/'/g, "''");
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN; CREATE SCHEMA auth; CREATE TABLE auth.users (id UUID PRIMARY KEY); INSERT INTO auth.users VALUES ('${userId}');`);
    for (const name of [
        '20260726050000_add_demo_analysis_runs.sql',
        '20260730010000_demo_analysis_editable_fixture_authority.sql',
        '20260730030000_restore_demo_fixture_authority_after_v4.sql',
        '20260730040000_upgrade_demo_fixture_v2_realism.sql',
    ]) await db.exec(sql(name));
}, 30_000);

afterAll(async () => db.close());

describe('operator fixture v2 database runtime boundary', () => {
    it('rejects invalid V2 drafts through the installed validation trigger', async () => {
        const invalidBio = JSON.parse(v2Payload());
        invalidBio.target.bio = 'should remain empty';
        const wrongAggregate = JSON.parse(v2Payload());
        wrongAggregate.summary.publicMutuals = 84;
        const publicBio = JSON.parse(v2Payload());
        publicBio.public[0].bio = 'should remain empty';
        const nonLocalImage = JSON.parse(v2Payload());
        nonLocalImage.public[0].profileImage = 'https://example.test/avatar.webp';

        for (const invalid of [invalidBio, wrongAggregate, publicBio, nonLocalImage]) {
            await expect(db.exec(`
                INSERT INTO public.demo_analysis_fixtures (version, status, payload)
                VALUES ('operator-editable-fixture-v2', 'draft', '${quotedPayload(JSON.stringify(invalid))}'::jsonb)
            `)).rejects.toThrow();
        }
    });

    it('creates and replays only a 300-second v2 run', async () => {
        const payload = quotedPayload();
        await db.exec(`
            SELECT public.create_demo_analysis_fixture_draft('operator-editable-fixture-v2', '${payload}'::jsonb);
            SELECT public.publish_demo_analysis_fixture('operator-editable-fixture-v2', '${payload}'::jsonb);
        `);
        await db.exec('SET ROLE service_role');
        const first = await db.query<{ fixture_version: string; duration_seconds: number; created: boolean }>(`
            SELECT fixture_version, duration_seconds, created FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'fixture-v2-idempotency-000000000000000000000000000000000000000000000000', 300,
                'operator-editable-fixture-v2', '${payload}'::jsonb
            )
        `);
        const replay = await db.query<{ created: boolean }>(`
            SELECT created FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'fixture-v2-idempotency-000000000000000000000000000000000000000000000000', 300,
                'operator-editable-fixture-v2', '${payload}'::jsonb
            )
        `);
        await db.exec('RESET ROLE');
        expect(first.rows).toEqual([{ fixture_version: 'operator-editable-fixture-v2', duration_seconds: 300, created: true }]);
        expect(replay.rows).toEqual([{ created: false }]);
        await expect(db.query(`SELECT * FROM public.create_demo_analysis_preflight('${userId}', 'junho_dem', 'fixture-v2-invalid-duration-000000000000000000000000000000000000000000000000', 45, 'operator-editable-fixture-v2', '${payload}'::jsonb)`)).rejects.toThrow(/invalid database demo run input/i);
    });

    it('retains service-role-only execution for the final six-argument RPC', async () => {
        const privileges = await db.query<{ service: boolean; anon: boolean; authenticated: boolean }>(`
            SELECT has_function_privilege('service_role', 'public.create_demo_analysis_preflight(uuid,text,text,integer,text,jsonb)', 'EXECUTE') AS service,
                   has_function_privilege('anon', 'public.create_demo_analysis_preflight(uuid,text,text,integer,text,jsonb)', 'EXECUTE') AS anon,
                   has_function_privilege('authenticated', 'public.create_demo_analysis_preflight(uuid,text,text,integer,text,jsonb)', 'EXECUTE') AS authenticated
        `);
        expect(privileges.rows[0]).toEqual({ service: true, anon: false, authenticated: false });
    });
});
