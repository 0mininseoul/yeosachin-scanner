import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDemoFixture } from './demo-analysis';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260730000000_demo_analysis_editable_fixture.sql', import.meta.url),
    'utf8',
);
let db: PGlite;

function payload() {
    return runtimePayload();
}

function runtimePayload() {
    const fixture = createDemoFixture('pglite-runtime-fixture');
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

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.demo_analysis_runs (
            id uuid DEFAULT gen_random_uuid(), user_id uuid, target_instagram_id text, fixture_version text,
            plan_id text, idempotency_key text, duration_seconds integer, created_at timestamptz DEFAULT clock_timestamp(),
            started_at timestamptz, UNIQUE (user_id, idempotency_key)
        );
    `);
    await db.exec(migration);
});
afterAll(async () => db.close());

describe('editable demo fixture lifecycle migration', () => {
    it('allows only the published to retired status transition and preserves the payload', async () => {
        await db.exec(`INSERT INTO public.demo_analysis_fixtures (version, status, payload) VALUES ('operator-editable-fixture-v1', 'draft', '${payload()}'::jsonb);`);
        await db.exec(`SELECT public.publish_demo_analysis_fixture('operator-editable-fixture-v1', '${payload()}'::jsonb);`);
        await expect(db.exec(`UPDATE public.demo_analysis_fixtures SET payload = payload WHERE version = 'operator-editable-fixture-v1';`)).rejects.toThrow(/immutable/i);
        await expect(db.exec(`DELETE FROM public.demo_analysis_fixtures WHERE version = 'operator-editable-fixture-v1';`)).rejects.toThrow(/immutable/i);
        await db.exec(`INSERT INTO public.demo_analysis_fixtures (version, status, payload) VALUES ('operator-editable-fixture-v2', 'draft', '${payload()}'::jsonb);`);
        await db.exec(`SELECT public.publish_demo_analysis_fixture('operator-editable-fixture-v2', '${payload()}'::jsonb);`);
        await expect(db.exec(`INSERT INTO public.demo_analysis_fixtures (version, status, payload) VALUES ('operator-editable-fixture-v3', 'published', '${payload()}'::jsonb);`)).rejects.toThrow();
    });

    it('persists the exact published version on idempotent replay', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        const run = await db.query<{ fixture_version: string }>(`
            SELECT fixture_version FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'database-fixture-preflight-key-000000', 38,
                'operator-editable-fixture-v2', '${payload()}'::jsonb
            )
        `);
        expect(run.rows).toEqual([{ fixture_version: 'operator-editable-fixture-v2' }]);
        const replay = await db.query<{ fixture_version: string }>(`
            SELECT fixture_version FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'database-fixture-preflight-key-000000', 38,
                'operator-editable-fixture-v2', '${payload()}'::jsonb
            )
        `);
        expect(replay.rows).toEqual([{ fixture_version: 'operator-editable-fixture-v2' }]);
        await expect(db.exec(`
            INSERT INTO public.demo_analysis_runs (user_id, target_instagram_id, fixture_version, plan_id, idempotency_key, duration_seconds)
            VALUES ('${userId}', 'junho_dem', 'synthetic-fixture-v1', 'standard', 'reserved-static-duration-key', 38)
        `)).rejects.toThrow();
    });

    it('reserves static fixture names and rejects a SQL-shape-valid invalid risk payload', async () => {
        await expect(db.exec(`
            INSERT INTO public.demo_analysis_fixtures (version, status, payload)
            VALUES ('authorized-redacted-fixture-v4', 'draft', '${runtimePayload()}'::jsonb)
        `)).rejects.toThrow();

        const invalidRisk = JSON.parse(runtimePayload());
        invalidRisk.public[0].riskBand = 'unsafe';
        await expect(db.exec(`
            INSERT INTO public.demo_analysis_fixtures (version, status, payload)
            VALUES ('operator-editable-fixture-invalid', 'draft', '${JSON.stringify(invalidRisk).replace(/'/g, "''")}'::jsonb)
        `)).rejects.toThrow();

        const externalText = JSON.parse(runtimePayload());
        externalText.target.bio = 'www.example.test';
        await expect(db.exec(`
            INSERT INTO public.demo_analysis_fixtures (version, status, payload)
            VALUES ('operator-editable-fixture-external-text', 'draft', '${JSON.stringify(externalText).replace(/'/g, "''")}'::jsonb)
        `)).rejects.toThrow();
    });

    it('rejects a normal direct draft-to-published update', async () => {
        await db.exec(`
            INSERT INTO public.demo_analysis_fixtures (version, status, payload)
            VALUES ('operator-editable-fixture-direct', 'draft', '${runtimePayload()}'::jsonb)
        `);
        await expect(db.exec(`
            UPDATE public.demo_analysis_fixtures SET status = 'published'
            WHERE version = 'operator-editable-fixture-direct'
        `)).rejects.toThrow(/controlled publish/i);
    });

    it('fails closed when the controlled publisher receives a stale draft payload', async () => {
        await db.exec(`
            INSERT INTO public.demo_analysis_fixtures (version, status, payload)
            VALUES ('operator-editable-fixture-race', 'draft', '${runtimePayload()}'::jsonb)
        `);
        await expect(db.exec(`
            SELECT public.publish_demo_analysis_fixture(
                'operator-editable-fixture-race', '{"target":"changed"}'::jsonb
            )
        `)).rejects.toThrow(/changed or is unavailable/i);
    });
});
