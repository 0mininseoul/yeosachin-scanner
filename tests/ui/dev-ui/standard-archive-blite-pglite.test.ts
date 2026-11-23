import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const owner = randomUUID();
const sourceGrant = randomUUID();
const sourceRequest = randomUUID();
const sourcePreflight = randomUUID();
const fixtureTarget = 'archive_fixture';
const cards = Object.fromEntries(['basic', 'standard', 'plus'].map(plan => [plan, {
    launchStatus: 'test_only', selectionState: plan === 'basic' ? 'required' : 'available_upgrade',
    unavailableReason: null, detailedMutualLimit: 5, relationshipCapacity: { followers: 100, following: 100 },
}]));
const dto = {
    schemaVersion: 1, persona: { headline: '분석 결과', summary: '합성 결과입니다.' },
    signals: ['하나', '둘', '셋', '넷'].map((claim, i) => ({
        claim, category: '관계', confidence: i === 0 ? 0.6 : 0.8, band: i === 0 ? 'medium' : 'high',
    })),
    candidateRange: { min: 1, max: 2 }, genderRead: { likelyFemale: true, confidence: 0.8, reasons: ['하나','둘','셋'] },
    postCount: 0, evidenceFields: ['post.caption'],
};
const lookupKey = (grant: string) => `dev-live:owner:standard:${grant}`;
let db: PGlite;

async function destination(bind = true, ageSeconds = 0) {
    const grant = randomUUID();
    const preflight = randomUUID();
    const claim = randomUUID();
    if (bind) await db.query(`
        INSERT INTO dev_live_budget.standard_archive_replay_grants VALUES ($1,$2,now() + interval '1 hour')
    `, [grant, sourceGrant]);
    await db.query(`
        INSERT INTO public.analysis_preflights(
            id,user_id,target_instagram_id,idempotency_key,status,lease_token,lease_expires_at,
            plan_catalog_snapshot,launch_status_snapshot,created_at
        ) VALUES ($1,$2,$3,$4,'processing',$5,now()+interval '20 seconds',$6,$7,now()-$8::int*interval '1 second')
    `, [preflight, owner, fixtureTarget, lookupKey(grant), claim, cards,
        { basic: 'test_only', standard: 'test_only', plus: 'test_only' }, ageSeconds]);
    return { preflight, claim };
}

async function complete(input: { preflight: string; claim: string }, outcome: unknown, caller: string | null = owner) {
    return (await db.query<{ changed: boolean }>(`
        SELECT public.dev_live_complete_standard_archive_preflight_v1(
            $1,$2,$3,NULL,NULL,NULL,10,10,false,'basic','basic',$4,$5
        ) AS changed
    `, [input.preflight, caller, input.claim, cards, outcome])).rows[0].changed;
}
async function status(preflight: string) {
    return (await db.query<{ result: Record<string, unknown> | null }>(
        'SELECT public.read_precheckout_blite_status_v1($1) AS result', [preflight],
    )).rows[0].result;
}

describe('sealed Dev B-lite terminal preview', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        const read = (name: string) => readFile(new URL(`../../../supabase/dev-ui/${name}.sql`, import.meta.url), 'utf8');
        const baseline = await read('production-baseline');
        function definition(prefix: string) {
            const start = baseline.indexOf(prefix);
            const end = baseline.indexOf('\n\n\n--', start);
            if (start < 0 || end < 0) throw new Error('Missing B-lite baseline definition');
            return baseline.slice(start, end);
        }
        await db.exec(`
            CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
            CREATE SCHEMA dev_ui; CREATE TABLE dev_ui.runs(id uuid); CREATE TABLE dev_ui.orders(id uuid);
            CREATE TABLE dev_ui.preflights(id uuid); CREATE SCHEMA dev_live_budget;
            CREATE TABLE dev_live_budget.standard_archive_replay_grants(grant_id uuid PRIMARY KEY,source_grant_id uuid,expires_at timestamptz);
            CREATE FUNCTION public.dev_live_standard_archive_replay_lookup_v1(uuid) RETURNS jsonb LANGUAGE sql AS $$SELECT NULL::jsonb$$;
            CREATE FUNCTION public.dev_live_owner_start_lookup_v2(uuid,uuid,text) RETURNS jsonb LANGUAGE sql AS $$
                SELECT '{}'::jsonb FROM dev_live_budget.standard_archive_replay_grants WHERE $1 IN (grant_id,source_grant_id)
                AND $2 = '${owner}'::uuid AND $3 = 'archive_fixture' LIMIT 1
            $$;
            CREATE TABLE public.analysis_requests(id uuid,preflight_id uuid,user_id uuid,target_instagram_id text,
                status text,pipeline_version text,selected_plan_id_snapshot text,plan_access_mode_snapshot text,
                analysis_entry_channel text DEFAULT 'standard');
            CREATE TABLE public.analysis_preflights(
                id uuid PRIMARY KEY,user_id uuid,target_instagram_id text,idempotency_key text,status text,
                access_mode text DEFAULT 'test_entitlement',analysis_entry_channel text DEFAULT 'standard',
                beta_entry_provenance text,pii_scrubbed_at timestamptz,consumed_request_id uuid,
                precheckout_blite_cohort boolean DEFAULT false,created_at timestamptz DEFAULT now(),
                updated_at timestamptz,precheckout_blite_deadline_seconds integer DEFAULT 90,
                submitted_at timestamptz,deadline_at timestamptz,expires_at timestamptz DEFAULT now()+interval '30 minutes',
                lease_token uuid,lease_expires_at timestamptz,target_full_name text,target_bio text,
                target_profile_image_url text,target_followers_count integer,target_following_count integer,
                target_is_private boolean,capacity_required_plan_id text,required_plan_id text,plan_cards_snapshot jsonb,
                launch_status_snapshot jsonb,plan_catalog_snapshot jsonb,ready_at timestamptz
            );
            CREATE TABLE public.precheckout_blite_sources(preflight_id uuid);
            CREATE TABLE public.precheckout_blite_dispatches(preflight_id uuid);
        `);
        await db.exec(definition('CREATE TABLE public.precheckout_blite_cache ('));
        await db.exec('ALTER TABLE public.precheckout_blite_cache ADD PRIMARY KEY(preflight_id)');
        for (const name of [
            'precheckout_blite_v1_has_exact_keys','precheckout_blite_v1_integer_in_range','precheckout_blite_v1_confidence_is_valid',
            'precheckout_blite_v1_copy_is_valid','precheckout_blite_v1_dto_is_valid','analysis_v2_valid_plan_cards_snapshot',
            'enforce_precheckout_blite_preflight_clock_v1','activate_precheckout_blite_cohort_v1',
            'complete_analysis_v2_preflight','read_precheckout_blite_status_v1',
        ]) await db.exec(definition(`CREATE FUNCTION public.${name}(`));
        await db.exec(definition('CREATE TRIGGER enforce_precheckout_blite_preflight_clock '));
        await db.exec(await read('live-standard-archive-blite'));
        await db.exec(await read('live-standard-archive-blite'));
        await db.query(`
            INSERT INTO public.analysis_preflights(id,user_id,target_instagram_id,idempotency_key,status,
                consumed_request_id,precheckout_blite_cohort) VALUES ($1,$2,$3,$4,'consumed',$5,true)
        `, [sourcePreflight, owner, fixtureTarget, lookupKey(sourceGrant), sourceRequest]);
        await db.query(`
            INSERT INTO public.analysis_requests VALUES ($1,$2,$3,$4,'completed','v2','standard','test_entitlement')
        `, [sourceRequest, sourcePreflight, owner, fixtureTarget]);
    });
    afterAll(async () => { await db?.close(); });

    it('publishes the archived DTO and recorded failure through the usual status reader with the destination clock', async () => {
        for (const outcome of [{ state: 'complete', dto }, { state: 'failed', reason: 'source_missing' }]) {
            const input = await destination();
            await db.exec('SET ROLE service_role');
            try {
                expect(await complete(input, outcome)).toBe(true);
                expect(await complete(input, outcome)).toBe(false);
            } finally {
                await db.exec('RESET ROLE');
            }
            const result = await status(input.preflight);
            expect(result).toMatchObject({ state: outcome.state, ...(outcome.dto ? { dto } : {}) });
            expect(Date.parse(String(result?.deadlineAt)) - Date.parse(String(result?.submittedAt))).toBe(90_000);
            expect((await db.query('SELECT attempt_count, failure_reason FROM public.precheckout_blite_cache WHERE preflight_id=$1',
                [input.preflight])).rows).toEqual([{ attempt_count: 0, failure_reason: outcome.reason ?? null }]);
            await expect(complete({ ...input, claim: randomUUID() }, outcome)).rejects.toThrow('DEV_STANDARD_ARCHIVE_BLITE_CONFLICT');
            await expect(complete(input, { state: 'failed', reason: 'source_invalid' })).rejects.toThrow('DEV_STANDARD_ARCHIVE_BLITE_CONFLICT');
        }
        for (const table of ['precheckout_blite_sources','precheckout_blite_dispatches']) {
            expect((await db.query(`SELECT 1 FROM public.${table}`)).rows).toHaveLength(0);
        }
    });

    it('rejects invalid DTOs, claims, deadlines and lineage, with no one-sided finalization', async () => {
        const input = await destination();
        const outcome = { state: 'failed', reason: 'source_missing' };
        for (const invalid of [null, { state: 'complete', dto: {} }, { state: 'failed', reason: 'unrecognized' },
            { ...outcome, extra: true }]) {
            await expect(complete(input, invalid)).rejects.toThrow('DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE');
        }
        await expect(complete(input, outcome, null)).rejects.toThrow('DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE');
        await expect(complete({ ...input, claim: randomUUID() }, outcome)).rejects.toThrow('PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST');
        await expect(complete(await destination(true, 100), outcome)).rejects.toThrow('PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST');
        await expect(complete(await destination(false), outcome)).rejects.toThrow('DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE');
        await db.query("UPDATE public.analysis_requests SET status='processing' WHERE id=$1", [sourceRequest]);
        await expect(complete(input, outcome)).rejects.toThrow('DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE');
        await db.query("UPDATE public.analysis_requests SET status='completed' WHERE id=$1", [sourceRequest]);
        await db.query('INSERT INTO public.precheckout_blite_dispatches VALUES ($1)', [input.preflight]);
        await expect(complete(input, outcome)).rejects.toThrow('DEV_STANDARD_ARCHIVE_BLITE_CONFLICT');
        expect((await db.query('SELECT status,precheckout_blite_cohort FROM public.analysis_preflights WHERE id=$1', [input.preflight]))
            .rows).toEqual([{ status: 'processing', precheckout_blite_cohort: false }]);
        expect(await status(input.preflight)).toBeNull();
    });
});
