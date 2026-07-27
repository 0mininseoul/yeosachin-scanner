import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../../../supabase/migrations/20260727110000_add_historical_official_e2e_replay_source.sql', import.meta.url), 'utf8');
const requestId = '10000000-0000-4000-8000-000000000001';
const preflightId = '20000000-0000-4000-8000-000000000001';
const userId = '30000000-0000-4000-8000-000000000001';
const policy = '{"pipeline":"v2","risk":"risk-policy-v2.3","aiStage":"ai-stage-policy-v2.7"}';
let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
        CREATE TABLE public.analysis_requests (id UUID PRIMARY KEY, user_id UUID, target_instagram_id TEXT, status TEXT, pipeline_version TEXT, selected_plan_id_snapshot TEXT, plan_access_mode_snapshot TEXT, test_entitlement_jti_hash TEXT, preflight_id UUID, completed_at TIMESTAMPTZ, policy_versions_snapshot JSONB);
        CREATE TABLE public.analysis_preflights (id UUID PRIMARY KEY, user_id UUID, status TEXT, access_mode TEXT, consumed_request_id UUID, target_instagram_id TEXT, target_is_private BOOLEAN, policy_versions_snapshot JSONB, target_full_name TEXT, target_bio TEXT, target_profile_image_url TEXT, target_followers_count INTEGER, target_following_count INTEGER);
        CREATE TABLE public.analysis_v2_test_entitlement_consumptions (entitlement_jti_hash TEXT PRIMARY KEY, preflight_id UUID, request_id UUID, user_id UUID, selected_plan_id TEXT);
        CREATE TABLE public.analysis_v2_provider_runs (request_id UUID, job_key TEXT, operation_key TEXT, logical_provider TEXT, actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT);
        CREATE TABLE public.analysis_preflight_provider_runs (preflight_id UUID, operation_key TEXT, logical_provider TEXT, actor_id TEXT, credential_slot TEXT, status TEXT, run_id TEXT);
    `);
    await db.exec(migration);
});
afterAll(async () => db.close());

async function insertEligible(input: { id?: string; preflight?: string; accessMode?: string; preflightAccessMode?: string; policyJson?: string; linked?: string | null; includeConsumption?: boolean; consumptionUserId?: string } = {}) {
    const id = input.id ?? requestId;
    const preflight = input.preflight ?? preflightId;
    const entitlementHash = id.replaceAll('-', '').padEnd(64, '0');
    await db.query(`INSERT INTO public.analysis_requests VALUES ($1, $2, 'scrubbed_request_value_123456', 'completed', 'v2', 'standard', $3, $4, $5, '2026-07-27T00:00:00Z', $6::JSONB)`, [id, userId, input.accessMode ?? 'test_entitlement', entitlementHash, preflight, input.policyJson ?? policy]);
    await db.query(`INSERT INTO public.analysis_preflights VALUES ($1, $2, 'consumed', $3, $4, 'scrubbed_preflight_value_789', FALSE, $5::JSONB, 'Target', 'bio', 'https://example.com/profile.jpg', 10, 20)`, [preflight, userId, input.preflightAccessMode ?? 'test_entitlement', input.linked === undefined ? id : input.linked, input.policyJson ?? policy]);
    if (input.includeConsumption ?? true) {
        await db.query('INSERT INTO public.analysis_v2_test_entitlement_consumptions VALUES ($1, $2, $3, $4, $5)', [entitlementHash, preflight, id, input.consumptionUserId ?? userId, 'standard']);
    }
}

describe('read_analysis_v2_historical_official_e2e_replay_source', () => {
    it('reads only the required eligible request and returns a deterministic opaque replay target', async () => {
        await insertEligible();
        await db.exec('SET ROLE service_role');
        const first = await db.query<{ source: { targetUsername: string; requestId: string } }>('SELECT public.read_analysis_v2_historical_official_e2e_replay_source($1) AS source', [requestId]);
        const second = await db.query<{ source: { targetUsername: string } }>('SELECT public.read_analysis_v2_historical_official_e2e_replay_source($1) AS source', [requestId]);
        await db.exec('RESET ROLE');
        expect(first.rows[0]?.source.requestId).toBe(requestId);
        expect(first.rows[0]?.source.targetUsername).toMatch(/^replay_[a-f0-9]{23}$/);
        expect(first.rows[0]?.source.targetUsername).toBe(second.rows[0]?.source.targetUsername);
        expect(first.rows[0]?.source.targetUsername).not.toContain('scrubbed');
    });

    it.each([
        ['production', 'test_entitlement', policy, requestId],
        ['test_entitlement', 'production', policy, requestId],
        ['test_entitlement', 'test_entitlement', '{"pipeline":"v2","risk":"risk-policy-v2.3","aiStage":"ai-stage-policy-v2.7","scheduler":"ai-scheduler-v1"}', requestId],
        ['test_entitlement', 'test_entitlement', policy, null],
    ])('denies a non-exact entitlement lineage', async (accessMode, preflightAccessMode, policyJson, linked) => {
        const id = crypto.randomUUID(); const preflight = crypto.randomUUID();
        await insertEligible({ id, preflight, accessMode, preflightAccessMode, policyJson, linked: linked === null ? null : id });
        await db.exec('SET ROLE service_role');
        await expect(db.query('SELECT public.read_analysis_v2_historical_official_e2e_replay_source($1)', [id])).rejects.toThrow('ANALYSIS_V2_REPLAY_HISTORICAL_SOURCE_NOT_FOUND');
        await db.exec('RESET ROLE');
    });

    it('denies a test entitlement without its consumed entitlement row', async () => {
        const id = crypto.randomUUID(); const preflight = crypto.randomUUID();
        await insertEligible({ id, preflight, includeConsumption: false });
        await db.exec('SET ROLE service_role');
        await expect(db.query('SELECT public.read_analysis_v2_historical_official_e2e_replay_source($1)', [id])).rejects.toThrow('ANALYSIS_V2_REPLAY_HISTORICAL_SOURCE_NOT_FOUND');
        await db.exec('RESET ROLE');
    });

    it('denies an entitlement consumption owned by a different user', async () => {
        const id = crypto.randomUUID(); const preflight = crypto.randomUUID();
        await insertEligible({
            id, preflight,
            consumptionUserId: '30000000-0000-4000-8000-000000000002',
        });
        await db.exec('SET ROLE service_role');
        await expect(db.query('SELECT public.read_analysis_v2_historical_official_e2e_replay_source($1)', [id])).rejects.toThrow('ANALYSIS_V2_REPLAY_HISTORICAL_SOURCE_NOT_FOUND');
        await db.exec('RESET ROLE');
    });

    it.each(['anon', 'authenticated'])('does not grant %s access', async role => {
        await db.exec(`SET ROLE ${role}`);
        await expect(db.query('SELECT public.read_analysis_v2_historical_official_e2e_replay_source($1)', [requestId])).rejects.toThrow(/permission denied/i);
        await db.exec('RESET ROLE');
    });
});
