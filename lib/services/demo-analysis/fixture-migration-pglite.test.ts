import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../supabase/migrations/20260730000000_demo_analysis_editable_fixture.sql', import.meta.url),
    'utf8',
);
let db: PGlite;

function payload() {
    const publicRows = Array.from({ length: 84 }, (_, index) => ({
        instagramId: `public.${index}`, fullName: '가나다', profileImage: `/demo-avatars/demo-v3-female-${String(index + 1).padStart(3, '0')}.webp`, bio: '가나다', displayScore: 1, riskBand: 'normal', featuredRank: null, recentMutualRank: null, analysisDepth: 'features', oneLineOverview: '가나다', highRiskNarrative: null,
    }));
    const privateRows = Array.from({ length: 145 }, (_, index) => ({
        instagramId: `private.${index}`, fullName: '가나다', profileImage: `/demo-avatars/demo-v3-private-${String(index + 85).padStart(3, '0')}.webp`,
    }));
    return JSON.stringify({
        target: { username: 'junho_dem', fullName: '가나다', bio: '가나다', profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false },
        summary: { targetInstagramId: 'junho_dem', targetFullName: '가나다', targetProfileImage: '/demo-avatars/demo-v3-target-000.webp', planId: 'standard', followers: {}, following: {}, detectedMutuals: 229, publicMutuals: 84, privateMutuals: 145, screenedMutuals: 84, genderStats: {}, notScreenedMutuals: 0, exclusionApplied: false, scorePolicyVersion: 'risk-policy-v2.3' },
        public: publicRows, private: privateRows,
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
        await db.exec(`INSERT INTO public.demo_analysis_fixtures (version, status, payload) VALUES ('fixture-v1', 'published', '${payload()}'::jsonb);`);
        await db.exec(`UPDATE public.demo_analysis_fixtures SET status = 'retired' WHERE version = 'fixture-v1';`);
        await expect(db.exec(`UPDATE public.demo_analysis_fixtures SET payload = payload WHERE version = 'fixture-v1';`)).rejects.toThrow(/immutable/i);
        await expect(db.exec(`DELETE FROM public.demo_analysis_fixtures WHERE version = 'fixture-v1';`)).rejects.toThrow(/immutable/i);
        await db.exec(`INSERT INTO public.demo_analysis_fixtures (version, status, payload) VALUES ('fixture-v2', 'published', '${payload()}'::jsonb);`);
        await expect(db.exec(`INSERT INTO public.demo_analysis_fixtures (version, status, payload) VALUES ('fixture-v3', 'published', '${payload()}'::jsonb);`)).rejects.toThrow();
    });

    it('fails closed before a fixture is published and persists the exact published version', async () => {
        const userId = '123e4567-e89b-42d3-a456-426614174000';
        const run = await db.query<{ fixture_version: string }>(`
            SELECT fixture_version FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'database-fixture-preflight-key-000000', 38
            )
        `);
        expect(run.rows).toEqual([{ fixture_version: 'fixture-v2' }]);
        await db.exec(`UPDATE public.demo_analysis_fixtures SET status = 'retired' WHERE version = 'fixture-v2';`);
        const unavailable = await db.query(`
            SELECT * FROM public.create_demo_analysis_preflight(
                '${userId}', 'junho_dem', 'no-published-fixture-key-0000000000', 38
            )
        `);
        expect(unavailable.rows).toEqual([]);
    });
});
