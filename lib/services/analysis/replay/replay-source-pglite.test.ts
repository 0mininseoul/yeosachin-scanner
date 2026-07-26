import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(
    new URL('../../../../supabase/migrations/20260727010000_add_analysis_v2_replay_capture_source.sql', import.meta.url),
    'utf8',
);
let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_requests (
            id UUID PRIMARY KEY, target_instagram_id TEXT, status TEXT,
            pipeline_version TEXT, selected_plan_id_snapshot TEXT,
            plan_access_mode_snapshot TEXT, preflight_id UUID,
            completed_at TIMESTAMPTZ, policy_versions_snapshot JSONB
        );
        CREATE TABLE public.analysis_preflights (
            id UUID PRIMARY KEY, status TEXT, access_mode TEXT,
            consumed_request_id UUID, target_instagram_id TEXT,
            target_is_private BOOLEAN, policy_versions_snapshot JSONB,
            target_full_name TEXT, target_bio TEXT, target_profile_image_url TEXT,
            target_followers_count INTEGER, target_following_count INTEGER
        );
        CREATE TABLE public.analysis_v2_provider_runs (
            request_id UUID, job_key TEXT, operation_key TEXT, logical_provider TEXT,
            actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT
        );
        CREATE TABLE public.analysis_preflight_provider_runs (
            preflight_id UUID, operation_key TEXT, logical_provider TEXT,
            actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT
        );
    `);
    await db.exec(migration);
    await db.exec(`
        INSERT INTO public.analysis_requests VALUES (
            '10000000-0000-4000-8000-000000000001', 'target', 'completed', 'v2',
            'standard', 'production', '20000000-0000-4000-8000-000000000001',
            '2026-07-27T00:00:00Z',
            '{"pipeline":"v2","risk":"risk-policy-v2.3","aiStage":"ai-stage-policy-v2.7"}'
        );
        INSERT INTO public.analysis_preflights VALUES (
            '20000000-0000-4000-8000-000000000001', 'consumed', 'production',
            '10000000-0000-4000-8000-000000000001', 'target', FALSE,
            '{"pipeline":"v2","risk":"risk-policy-v2.3","aiStage":"ai-stage-policy-v2.7"}',
            'Target', 'bio', 'https://example.com/profile.jpg', 10, 20
        );
        INSERT INTO public.analysis_v2_provider_runs VALUES (
            '10000000-0000-4000-8000-000000000001', 'track:relationships',
            'relationship-followers:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'apify', 'actor/name', 'secondary', 'succeeded', 'RUNID001'
        );
        INSERT INTO public.analysis_preflight_provider_runs VALUES (
            '20000000-0000-4000-8000-000000000001', 'target-profile-fallback',
            'apify', 'apify/instagram-profile-scraper', 'secondary', 'succeeded', 'RUNID002'
        );
    `);
});

afterAll(async () => db.close());

describe('read_analysis_v2_replay_capture_source', () => {
    it('returns only the newest exact completed production Standard source and bounded ledgers', async () => {
        await db.exec('SET ROLE service_role');
        const result = await db.query<{ source: Record<string, unknown> }>(
            `SELECT public.read_analysis_v2_replay_capture_source(
                'TARGET', NULL
            ) AS source`,
        );
        await db.exec('RESET ROLE');
        expect(result.rows[0]?.source).toMatchObject({
            targetUsername: 'target',
            providerRuns: [{ credentialSlot: 'secondary', runId: 'RUNID001' }],
            preflightRuns: [{ runId: 'RUNID002' }],
        });
    });

    it('grants execute only to service_role', async () => {
        const result = await db.query<{ service: boolean; anon: boolean; authenticated: boolean }>(`
            SELECT
              has_function_privilege('service_role',
                'public.read_analysis_v2_replay_capture_source(text,uuid)', 'EXECUTE') AS service,
              has_function_privilege('anon',
                'public.read_analysis_v2_replay_capture_source(text,uuid)', 'EXECUTE') AS anon,
              has_function_privilege('authenticated',
                'public.read_analysis_v2_replay_capture_source(text,uuid)', 'EXECUTE') AS authenticated
        `);
        expect(result.rows[0]).toEqual({ service: true, anon: false, authenticated: false });
    });
});
