import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../../supabase/migrations/20260803130000_add_betatest_free_pool_replay_source.sql',
    import.meta.url,
), 'utf8');
const policy = JSON.stringify({ pipeline: 'v2', risk: 'risk-policy-v2.5', aiStage: 'ai-stage-policy-v2.10', scheduler: 'ai-scheduler-v1' });
const slots = JSON.stringify({
    'target-profile': 'tertiary', 'relationship-followers': 'quaternary',
    'relationship-following': 'quinary', 'profile-fallback': 'tertiary',
    'profile-repair': 'senary', 'target-likers': 'septenary',
    'target-comments': 'quaternary', 'candidate-likers': 'quinary',
});
let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_requests (id UUID PRIMARY KEY, user_id UUID, status TEXT, completed_at TIMESTAMPTZ, pipeline_version TEXT, selected_plan_id_snapshot TEXT, plan_access_mode_snapshot TEXT, test_entitlement_jti_hash TEXT, analysis_entry_channel TEXT, policy_versions_snapshot JSONB, preflight_id UUID, target_instagram_id TEXT);
        CREATE TABLE public.analysis_preflights (id UUID PRIMARY KEY, user_id UUID, status TEXT, access_mode TEXT, analysis_entry_channel TEXT, beta_entry_provenance TEXT, consumed_request_id UUID, policy_versions_snapshot JSONB, pii_scrubbed_at TIMESTAMPTZ, target_instagram_id TEXT, target_full_name TEXT, target_bio TEXT, target_profile_image_url TEXT, exclusion_decision TEXT, excluded_instagram_id TEXT);
        CREATE TABLE public.analysis_v2_result_summaries (request_id UUID PRIMARY KEY, plan_id TEXT, score_policy_version TEXT);
        CREATE TABLE public.analysis_v2_provider_execution_policies (request_id UUID PRIMARY KEY, mode TEXT, policy_version TEXT, entitlement_jti_hash TEXT, operation_slot_map JSONB, target_instagram_id TEXT, policy_hash TEXT);
        CREATE TABLE public.analysis_v2_provider_runs (request_id UUID, job_key TEXT, operation_key TEXT, logical_provider TEXT, actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT, terminalized_at TIMESTAMPTZ, actual_usage_usd NUMERIC, usage_reconciled_at TIMESTAMPTZ);
        CREATE TABLE public.analysis_preflight_provider_runs (preflight_id UUID, operation_key TEXT, logical_provider TEXT, actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT, terminalized_at TIMESTAMPTZ, actual_usage_usd NUMERIC, usage_reconciled_at TIMESTAMPTZ);
        CREATE FUNCTION public.analysis_beta_valid_operation_slot_map(p_map JSONB) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT p_map ?& ARRAY['target-profile','relationship-followers','relationship-following','profile-fallback','profile-repair','target-likers','target-comments','candidate-likers'] AND NOT EXISTS (SELECT 1 FROM jsonb_each_text(p_map) AS item WHERE item.value NOT IN ('primary','tertiary','quaternary','quinary','senary','septenary')) $$;
        CREATE FUNCTION public.analysis_beta_provider_policy_hash(p_target TEXT, p_map JSONB) RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$ SELECT repeat('a', 64) $$;
    `);
    await db.exec(migration);
});
afterAll(async () => db.close());

async function seed(input: { slot?: string; provenance?: string; policyVersion?: string; requestChannel?: string } = {}) {
    const requestId = crypto.randomUUID(); const preflightId = crypto.randomUUID(); const userId = crypto.randomUUID();
    const retained = `retained.${preflightId.replaceAll('-', '').slice(0, 20)}`;
    await db.query(`INSERT INTO public.analysis_requests VALUES ($1,$2,'completed','2026-08-02T01:00:00Z','v2','standard','production',NULL,$3,$4::jsonb,$5,'target')`, [requestId, userId, input.requestChannel ?? 'betatest', policy, preflightId]);
    await db.query(`INSERT INTO public.analysis_preflights VALUES ($1,$2,'consumed','production','betatest',$3,$4,$5::jsonb,'2026-08-02T01:00:00Z',$6,NULL,NULL,NULL,'skip',NULL)`, [preflightId, userId, input.provenance ?? 'betatest_service_v1', requestId, policy, retained]);
    await db.query(`INSERT INTO public.analysis_v2_result_summaries VALUES ($1,'standard','risk-policy-v2.5')`, [requestId]);
    await db.query(`INSERT INTO public.analysis_v2_provider_execution_policies VALUES ($1,'betatest_free_pool',$2,NULL,$3::jsonb,'target',repeat('a',64))`, [requestId, input.policyVersion ?? 'betatest-free-pool-v1', slots]);
    const slot = input.slot ?? 'tertiary';
    await db.query(`INSERT INTO public.analysis_preflight_provider_runs VALUES ($1,'target-profile-fallback','apify','apify/instagram-profile-scraper',$2,'succeeded','BetaPreflight1','2026-08-02T00:00:00Z',0.01,'2026-08-02T00:01:00Z')`, [preflightId, slot]);
    await db.query(`INSERT INTO public.analysis_v2_provider_runs VALUES ($1,'profiles',$2,'apify','apify/instagram-profile-scraper','tertiary','succeeded','BetaRun1','2026-08-02T00:10:00Z',0.01,'2026-08-02T00:11:00Z')`, [requestId, `profile-fallback:${'a'.repeat(64)}`]);
    return requestId;
}
async function read(requestId: string) {
    await db.exec('SET ROLE service_role');
    try { return await db.query<{ source: Record<string, unknown> }>('SELECT public.read_analysis_v2_betatest_free_pool_replay_source($1) AS source', [requestId]); }
    finally { await db.exec('RESET ROLE'); }
}

describe('read_analysis_v2_betatest_free_pool_replay_source', () => {
    it('is stable, SELECT-only, service-role-only, and returns no target identifier', async () => {
        const body = migration.split('AS $$')[1]!.split('$$;')[0]!;
        expect(migration).toMatch(/LANGUAGE plpgsql\s+STABLE\s+SECURITY DEFINER/);
        expect(body).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|MERGE|TRUNCATE)\b/);
        expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
        const requestId = await seed(); const result = await read(requestId);
        expect(result.rows[0]!.source).toMatchObject({ requestId, selectedPlanId: 'standard' });
        expect(result.rows[0]!.source).not.toHaveProperty('target');
    });

    it.each([
        [{ slot: 'secondary' }, 'secondary credential'],
        [{ provenance: 'legacy_betatest_v1' }, 'legacy provenance'],
        [{ policyVersion: 'other' }, 'wrong policy version'],
        [{ requestChannel: 'standard' }, 'non-beta channel'],
    ] as const)('fails closed for %s', async (input, label) => {
        expect(label).toEqual(expect.any(String));
        await expect(read(await seed(input))).rejects.toThrow('ANALYSIS_V2_REPLAY_BETATEST_FREE_POOL');
    });
});
