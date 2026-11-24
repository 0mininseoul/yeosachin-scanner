import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashAnalysisTestEntitlementJti } from '@/lib/services/analysis/test-entitlement-jti';
import { ownerGrantFixtureSql, seedOwnerGrantAccount } from './fixtures/owner-grant';

const owner = randomUUID();
const target = 'archive_fixture';
const slotHash = 'a'.repeat(64);
type Approval = { id: string; approvedAt: string; planId: string };
let db: PGlite;

async function install(script: string) {
    await db.exec(await readFile(new URL(`../../../supabase/dev-ui/${script}.sql`, import.meta.url), 'utf8'));
}
async function start(attempt = randomUUID()) {
    return (await db.query<{ approval: Approval }>(
        'SELECT public.dev_live_owner_start_v4($1,$2,$3) AS approval', [owner, target, attempt],
    )).rows[0].approval;
}
async function replay(source: string, attempt = randomUUID(), slot = slotHash, user = owner, username = target) {
    return (await db.query<{ approval: Approval }>(
        'SELECT public.dev_live_standard_archive_replay_start_v1($1,$2,$3,$4,$5) AS approval',
        [user, username, attempt, source, slot],
    )).rows[0].approval;
}
async function lookup(grant: string) {
    return (await db.query<{ binding: unknown }>('SELECT public.dev_live_standard_archive_replay_lookup_v1($1) AS binding', [grant]))
        .rows[0].binding;
}
async function consume(grant: Approval) {
    const preflight = randomUUID();
    const request = randomUUID();
    const hash = hashAnalysisTestEntitlementJti(`dev-live-${grant.id}`);
    await db.query(`
        INSERT INTO public.analysis_preflights VALUES
            ($1,$2,$3,$4,$5,'consumed','ready','test_entitlement','standard','standard',NULL,$6)
    `, [preflight, owner, target, `dev-live:owner:standard:${grant.id}`, request, hash]);
    await db.query(`
        INSERT INTO public.analysis_requests VALUES
            ($1,$2,$3,$4,'completed','v2','standard','test_entitlement','standard',$5)
    `, [request, preflight, owner, target, hash]);
    await db.query('INSERT INTO public.analysis_v2_test_entitlement_consumptions VALUES ($1,$2,$3,$4,$5)',
        [preflight, request, owner, 'standard', hash]);
    return request;
}
async function reserve(grant: Approval, provider: string) {
    return (await db.query<{ ok: boolean }>(`
        SELECT public.dev_live_budget_reserve_v1($1,$2,'infinity',6000000,18000000,$3,$4,100) AS ok
    `, [grant.id, grant.approvedAt, randomUUID(), provider])).rows[0].ok;
}

describe('Dev sealed Standard replay grant', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(ownerGrantFixtureSql);
        await install('live-budget');
        await expect(install('live-standard-archive-replay')).rejects.toThrow('DEV_STANDARD_ARCHIVE_WRONG_DATABASE');
        await db.exec(`
            ROLLBACK;
            CREATE SCHEMA dev_ui;
            CREATE TABLE dev_ui.runs(id uuid); CREATE TABLE dev_ui.orders(id uuid); CREATE TABLE dev_ui.preflights(id uuid);
            CREATE TABLE public.analysis_preflights(
                id uuid PRIMARY KEY, user_id uuid, target_instagram_id text, idempotency_key text UNIQUE,
                consumed_request_id uuid, status text, admission_status text, access_mode text, analysis_entry_channel text,
                admission_selected_plan_id text, beta_entry_provenance text, admission_entitlement_jti_hash text,
                consumed_at timestamptz DEFAULT now(), pii_scrubbed_at timestamptz,
                target_full_name text, target_bio text, target_profile_image_url text,
                exclusion_decision text DEFAULT 'skip', excluded_instagram_id text, updated_at timestamptz
            );
            CREATE TABLE public.analysis_requests(
                id uuid PRIMARY KEY, preflight_id uuid, user_id uuid, target_instagram_id text, status text,
                pipeline_version text, analysis_entry_channel text, plan_access_mode_snapshot text,
                selected_plan_id_snapshot text, test_entitlement_jti_hash text, completed_at timestamptz DEFAULT now(),
                exclusion_decision_snapshot text DEFAULT 'skip', excluded_instagram_id text
            );
            CREATE TABLE public.analysis_v2_test_entitlement_consumptions(
                preflight_id uuid, request_id uuid, user_id uuid, selected_plan_id text, entitlement_jti_hash text PRIMARY KEY
            );
        `);
        const baseline = await readFile(new URL('../../../supabase/dev-ui/production-baseline.sql', import.meta.url), 'utf8');
        const scrub = baseline.indexOf('CREATE FUNCTION public.analysis_v2_scrub_terminal_request_pii(');
        await db.exec(baseline.slice(scrub, baseline.indexOf('$$;', scrub) + 3));
        await install('live-owner-start');
        await install('live-owner-start-standard');
        await install('live-standard-archive-replay');
        await seedOwnerGrantAccount((sql, values) => db.query(sql, values), owner, 'owner@invalid.test');
        await db.query('INSERT INTO dev_live_budget.standard_owner_policy(target_instagram_id) VALUES ($1)', [target]);
    });
    afterAll(async () => { await db?.close(); });

    it('binds once to the completed source, blocks conversion or chaining, and never authorizes Apify', async () => {
        const source = await start();
        await consume(source);
        const attempt = randomUUID();
        const grant = await replay(source.id, attempt);
        const expected = { sourceGrantId: source.id, slotHash,
            expiresAt: new Date(Date.parse(source.approvedAt) + 86_400_000).toISOString() };
        expect(source).not.toHaveProperty('archiveReplay');
        expect(grant).toHaveProperty('archiveReplay', expected);
        expect((await db.query<{ approval: Approval | null }>('SELECT public.dev_live_owner_start_lookup_v2($1,$2,$3) AS approval',
            [grant.id, owner, target])).rows[0].approval).toEqual(grant);
        expect((await db.query<{ approval: Approval | null }>('SELECT public.dev_live_owner_start_lookup_v2($1,$2,$3) AS approval',
            [grant.id, randomUUID(), target])).rows[0].approval).toBeNull();
        expect(await lookup(source.id)).toBeNull();
        expect(await lookup(grant.id)).toEqual(expected);
        expect(await replay(source.id, attempt)).toEqual(grant);
        await expect(replay(source.id, attempt, 'b'.repeat(64))).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_CONFLICT');
        const otherSource = await start();
        await consume(otherSource);
        await expect(replay(otherSource.id, attempt)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_CONFLICT');
        const ordinaryAttempt = randomUUID();
        const ordinary = await start(ordinaryAttempt);
        await expect(replay(source.id, ordinaryAttempt)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_CONFLICT');
        expect(await lookup(ordinary.id)).toBeNull();
        await consume(grant);
        await expect(replay(grant.id)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        expect(await reserve(ordinary, 'apify')).toBe(true);
        await db.exec('SET ROLE service_role');
        try {
            await expect(reserve(grant, 'apify')).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
            expect(await reserve(grant, 'vertex')).toBe(true);
        } finally {
            await db.exec('RESET ROLE');
        }
        expect((await db.query(`
            SELECT apify_committed_micros, ai_committed_micros FROM dev_live_budget.grants WHERE grant_id = $1
        `, [grant.id])).rows).toEqual([{ apify_committed_micros: 0, ai_committed_micros: 100 }]);
        await expect(db.query('UPDATE dev_live_budget.standard_archive_replay_grants SET slot_hash = $1 WHERE grant_id = $2',
            ['b'.repeat(64), grant.id])).rejects.toThrow('DEV_STANDARD_ARCHIVE_BINDING_IMMUTABLE');
        await expect(db.query('DELETE FROM dev_live_budget.standard_archive_replay_grants WHERE grant_id = $1', [grant.id]))
            .rejects.toThrow('DEV_STANDARD_ARCHIVE_BINDING_IMMUTABLE');
        await install('live-standard-archive-replay');
        expect(await lookup(grant.id)).toEqual(expected);
    });

    it('requires the current QA identity, target, completed consumption and exact 24-hour lifetime', async () => {
        const source = await start();
        const attempt = randomUUID();
        await expect(replay(source.id, attempt)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        const request = await consume(source);
        await expect(replay(source.id, attempt, slotHash, randomUUID())).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
        await expect(replay(source.id, attempt, slotHash, owner, 'another')).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
        await expect(replay(source.id, attempt, 'malformed')).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        await db.query("UPDATE public.analysis_requests SET status = 'processing' WHERE id = $1", [request]);
        await expect(replay(source.id, attempt)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        await db.query("UPDATE public.analysis_requests SET status = 'completed', test_entitlement_jti_hash = $1 WHERE id = $2",
            ['b'.repeat(64), request]);
        await expect(replay(source.id, attempt)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        await db.query('UPDATE public.analysis_requests SET test_entitlement_jti_hash = $1 WHERE id = $2',
            [hashAnalysisTestEntitlementJti(`dev-live-${source.id}`), request]);
        await db.query("UPDATE dev_live_budget.grants SET approved_at = clock_timestamp() - interval '24 hours' WHERE grant_id = $1",
            [source.id]);
        await expect(replay(source.id, attempt)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        expect((await db.query('SELECT 1 FROM dev_live_budget.owner_starts WHERE attempt_id = $1', [attempt])).rows).toHaveLength(0);
    });

    it('accepts only the exact completed source after the terminal privacy scrub', async () => {
        const source = await start();
        const request = await consume(source);
        await db.query('SELECT public.analysis_v2_scrub_terminal_request_pii($1, clock_timestamp())', [request]);
        const sourceRow = async () => (await db.query<{ preflight_target: string }>(`
            SELECT request.target_instagram_id AS request_target, preflight.target_instagram_id AS preflight_target,
                   preflight.pii_scrubbed_at IS NOT NULL AS scrubbed
            FROM public.analysis_requests AS request
            JOIN public.analysis_preflights AS preflight ON preflight.id = request.preflight_id
            WHERE request.id = $1
        `, [request])).rows[0];
        const scrubbed = await sourceRow();
        const retainedRequest = 'retained.' + request.replaceAll('-', '').slice(0, 20);
        expect(scrubbed).toEqual({
            request_target: retainedRequest, preflight_target: expect.stringMatching(/^retained\.[a-f0-9]{20}$/),
            scrubbed: true,
        });
        const grant = await replay(source.id);
        expect(grant).toHaveProperty('archiveReplay.sourceGrantId', source.id);
        expect(await sourceRow()).toEqual(scrubbed);

        await db.query('UPDATE public.analysis_requests SET target_instagram_id=$1 WHERE id=$2', [target, request]);
        await expect(replay(source.id)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        await db.query('UPDATE public.analysis_requests SET target_instagram_id=$1 WHERE id=$2', [retainedRequest, request]);
        await db.query('UPDATE public.analysis_preflights SET target_instagram_id=$1 WHERE consumed_request_id=$2',
            [retainedRequest, request]);
        await expect(replay(source.id)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        await db.query('UPDATE public.analysis_preflights SET target_instagram_id=$1 WHERE consumed_request_id=$2',
            [scrubbed.preflight_target, request]);
        await db.query("UPDATE public.analysis_requests SET completed_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
            [request]);
        await expect(replay(source.id)).rejects.toThrow('DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE');
        await expect(replay(source.id, randomUUID(), slotHash, owner, 'different_fixture'))
            .rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
    });

    it('keeps an expired binding visible, rejects new spend, and permits settlement of a pending receipt', async () => {
        const source = await start();
        const grant = await start();
        const receipt = randomUUID();
        await db.query(`
            SELECT public.dev_live_budget_reserve_v1($1,$2,'infinity',6000000,18000000,$3,'vertex',100)
        `, [grant.id, grant.approvedAt, receipt]);
        // Install a historical binding directly in the isolated fixture to model time passing.
        await db.query(`
            INSERT INTO dev_live_budget.standard_archive_replay_grants VALUES ($1,$2,$3,clock_timestamp() - interval '1 hour')
        `, [grant.id, source.id, slotHash]);
        expect(await lookup(grant.id)).toMatchObject({ sourceGrantId: source.id, slotHash });
        await expect(reserve(grant, 'vertex')).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve(grant, 'apify')).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await db.query('SELECT public.dev_live_budget_settle_vertex_v1($1,$2,30)', [grant.id, receipt]);
        expect((await db.query<{ ai_committed_micros: number }>('SELECT ai_committed_micros FROM dev_live_budget.grants WHERE grant_id = $1',
            [grant.id])).rows[0].ai_committed_micros).toBe(30);
    });

    it('restricts both RPCs to service role and keeps the binding table private', async () => {
        for (const role of ['anon', 'authenticated', 'service_role']) {
            expect((await db.query(`
                SELECT has_function_privilege($1,'public.dev_live_standard_archive_replay_start_v1(uuid,text,uuid,uuid,text)','EXECUTE') AS start,
                    has_function_privilege($1,'public.dev_live_standard_archive_replay_lookup_v1(uuid)','EXECUTE') AS lookup,
                    has_table_privilege($1,'dev_live_budget.standard_archive_replay_grants','SELECT,INSERT,UPDATE,DELETE') AS direct,
                    has_function_privilege($1,'dev_live_budget.standard_archive_source_target_matches_v1(public.analysis_preflights,public.analysis_requests,uuid,text)','EXECUTE') AS source_match
            `, [role])).rows).toEqual([{
                start: role === 'service_role', lookup: role === 'service_role', direct: false, source_match: false,
            }]);
        }
    });
});
