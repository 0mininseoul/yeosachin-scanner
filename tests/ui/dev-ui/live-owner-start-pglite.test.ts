import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashAnalysisTestEntitlementJti } from '@/lib/services/analysis/test-entitlement-jti';

type OwnerApproval = {
    id: string;
    targetInstagramId: string;
    approvedAt: string;
    expiresAt: string;
    apifyMaxCents: number;
    aiMaxCents: number;
};

type StandardOwnerApproval = OwnerApproval & { planId: 'standard' };

const ownerId = randomUUID();
const fixtureEmail = 'owner@invalid.test';
const target = 'public_fixture';
const grantParameters = '$1::uuid, $2::timestamptz, $3::timestamptz, $4::integer, $5::integer';

let db: PGlite;

async function start(attemptId = randomUUID(), username = target, userId = ownerId): Promise<OwnerApproval> {
    const result = await db.query<{ approval: OwnerApproval }>(
        'SELECT public.dev_live_owner_start_v1($1, $2, $3) AS approval',
        [userId, username, attemptId],
    );
    return result.rows[0].approval;
}

async function lookup(approval: OwnerApproval, username = target, userId = ownerId): Promise<OwnerApproval | null> {
    const result = await db.query<{ approval: OwnerApproval | null }>(
        'SELECT public.dev_live_owner_start_lookup_v1($1, $2, $3) AS approval',
        [approval.id, userId, username],
    );
    return result.rows[0].approval;
}


async function configureStandard(username = target) {
    await db.query('INSERT INTO dev_live_budget.standard_owner_policy (target_instagram_id) VALUES ($1)', [username]);
}

async function standardReady(username = target, userId = ownerId) {
    const result = await db.query<{ ready: boolean }>('SELECT public.dev_live_owner_start_ready_v2($1, $2) AS ready', [userId, username]);
    return result.rows[0].ready;
}

async function startStandard(attemptId = randomUUID(), username = target, userId = ownerId): Promise<StandardOwnerApproval> {
    const result = await db.query<{ approval: StandardOwnerApproval }>(
        'SELECT public.dev_live_owner_start_v2($1, $2, $3) AS approval', [userId, username, attemptId],
    );
    return result.rows[0].approval;
}

async function lookupStandard(grant: OwnerApproval, username = target, userId = ownerId): Promise<StandardOwnerApproval | null> {
    const result = await db.query<{ approval: StandardOwnerApproval | null }>(
        'SELECT public.dev_live_owner_start_lookup_v2($1, $2, $3) AS approval', [grant.id, userId, username],
    );
    return result.rows[0].approval;
}

function budgetValues(approval: OwnerApproval) {
    return [
        approval.id, approval.approvedAt, approval.expiresAt,
        approval.apifyMaxCents * 10_000, approval.aiMaxCents * 10_000,
    ];
}

async function reserve(approval: OwnerApproval, provider: 'apify' | 'vertex', amount: number, reservationId = randomUUID()) {
    const result = await db.query<{ reserved: boolean }>(
        `SELECT public.dev_live_budget_reserve_v1(${grantParameters}, $6, $7, $8) AS reserved`,
        [...budgetValues(approval), reservationId, provider, amount],
    );
    return result.rows[0].reserved;
}

async function readSql(name: string) {
    return readFile(new URL(`../../../supabase/dev-ui/${name}.sql`, import.meta.url), 'utf8');
}

async function installPreflightOverlays() {
    const baseline = await readSql('production-baseline');
    const create = baseline.match(/^CREATE FUNCTION public\.create_or_replay_analysis_v2_preflight\([\s\S]*?\$_\$;/m)?.[0];
    const reserveAdmission = baseline.match(/^CREATE FUNCTION public\.reserve_analysis_v2_preflight_admission\([\s\S]*?\$_\$;/m)?.[0];
    if (!create || !reserveAdmission) throw new Error('Missing Dev baseline preflight functions');
    const reserveSignature = 'uuid,uuid,text,text,uuid,uuid';
    const createSignature = 'uuid,text,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb';
    const returnType = reserveAdmission.split('\n')[0].split('RETURNS TABLE')[1];
    await db.exec(`
        CREATE TABLE public.analysis_preflights (
            id uuid PRIMARY KEY, user_id uuid, idempotency_key text, target_instagram_id text,
            access_mode text, beta_entry_provenance text, admission_generation integer,
            admission_selected_plan_id text, admission_entitlement_jti_hash text
        );
        ${create}
        ${reserveAdmission}
        CREATE FUNCTION public.analysis_v2_reserve_preflight_admission_after_settlement_internal(
            p_preflight_id uuid, p_user_id uuid, p_selected_plan_id text, p_jti text,
            p_admission_token uuid, p_dispatch_token uuid
        ) RETURNS TABLE${returnType}
        LANGUAGE sql AS $$
            SELECT 'ready'::text, false, 1, 1, NULL::uuid, p_selected_plan_id, true,
                p_admission_token, now(), 477, 641, 'standard'::text, 'standard'::text,
                NULL::jsonb, 'fixture'::text, NULL::jsonb, NULL::text
        $$;
        REVOKE ALL ON FUNCTION public.create_or_replay_analysis_v2_preflight(${createSignature}),
            public.reserve_analysis_v2_preflight_admission(${reserveSignature}) FROM PUBLIC;
        GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(${createSignature}),
            public.reserve_analysis_v2_preflight_admission(${reserveSignature}) TO service_role;
    `);
    for (const name of ['live-standard-preflight-replay', 'live-standard-fresh-admission']) {
        const script = await readSql(name);
        await db.exec(script);
        await db.exec(script);
    }
}

describe('Dev owner-start grant SQL', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(`
            CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
            CREATE SCHEMA auth;
            CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_app_meta_data jsonb);
            CREATE TABLE auth.identities (user_id uuid, provider text, identity_data jsonb);
            CREATE TABLE public.account_e2e_test_runners (
                account_id uuid PRIMARY KEY, runner_plan text UNIQUE, command_version text
            );
            CREATE TABLE public.account_classification_audit (
                account_id uuid, command_version text, reason_code text,
                next_account_class text, next_traffic_class text, next_lifecycle text
            );
            CREATE FUNCTION public.load_e2e_test_runner_v1(owner_id uuid) RETURNS TABLE(runner_plan text)
            LANGUAGE sql STABLE AS $$
                SELECT runner.runner_plan FROM public.account_e2e_test_runners AS runner
                JOIN auth.users AS owner ON owner.id = runner.account_id
                WHERE runner.account_id = owner_id AND owner.raw_app_meta_data ->> 'analysis_test_runner_v1' = runner.runner_plan
            $$;
        `);
        await db.exec(await readSql('live-budget'));
        const ownerStartSql = await readSql('live-owner-start');
        await expect(db.exec(ownerStartSql)).rejects.toThrow('DEV_LIVE_OWNER_START_WRONG_DATABASE');
        await db.exec(`
            ROLLBACK;
            CREATE SCHEMA dev_ui;
            CREATE TABLE dev_ui.preflights (id uuid);
            CREATE TABLE dev_ui.orders (id uuid);
            CREATE TABLE dev_ui.runs (id uuid);
        `);
        const standardSql = await readSql('live-owner-start-standard');
        await expect(db.exec(standardSql)).rejects.toThrow('DEV_LIVE_STANDARD_WRONG_DATABASE');
        await db.exec('ROLLBACK');
        await db.exec(ownerStartSql);
        await db.exec(ownerStartSql);
        await db.exec(`
            INSERT INTO dev_live_budget.grants (grant_id, approved_at, expires_at, apify_limit_micros, ai_limit_micros)
            VALUES (gen_random_uuid(), statement_timestamp(), statement_timestamp() + interval '30 minutes', 5000000, 2000000);
        `);
        await db.exec(standardSql);
        await db.exec(standardSql);
        expect((await db.query('SELECT plan_id, standard_policy_id FROM dev_live_budget.grants')).rows)
            .toEqual([{ plan_id: 'basic', standard_policy_id: null }]);
        expect((await db.query('SELECT 1 FROM dev_live_budget.standard_owner_policy')).rows).toHaveLength(0);
        await installPreflightOverlays();
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE dev_live_budget.reservations, dev_live_budget.owner_starts, dev_live_budget.grants,
                dev_live_budget.standard_owner_policy;
            TRUNCATE public.analysis_preflights, public.account_classification_audit,
                public.account_e2e_test_runners, auth.identities, auth.users;
        `);
        await db.query(`
            INSERT INTO auth.users VALUES ($1, $2, '{"provider":"kakao","analysis_test_runner_v1":"basic"}')
        `, [ownerId, fixtureEmail]);
        await db.query(`
            INSERT INTO auth.identities VALUES ($1, 'kakao', jsonb_build_object('email', $2::text, 'email_verified', true))
        `, [ownerId, fixtureEmail]);
        await db.query(`
            INSERT INTO public.account_e2e_test_runners VALUES ($1, 'basic', 'dev-live-basic-v1')
        `, [ownerId]);
        await db.query(`
            INSERT INTO public.account_classification_audit VALUES (
                $1, 'dev-live-basic-v1', 'DEV_LIVE_BASIC_TESTER', 'e2e_test', 'e2e_test', 'active'
            )
        `, [ownerId]);
    });

    afterAll(async () => { await db?.close(); });

    it('exposes only read or owner-start RPCs to service role and leaves readiness read-only', async () => {
        const { rows } = await db.query<{ executable: boolean; writable: boolean }>(`
            SELECT has_function_privilege(rolname, pg_proc.oid, 'EXECUTE') AS executable,
                   (has_table_privilege(rolname, 'dev_live_budget.owner_starts', 'INSERT')
                       OR has_table_privilege(rolname, 'dev_live_budget.standard_owner_policy', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) AS writable
            FROM pg_roles CROSS JOIN pg_proc
            WHERE rolname IN ('anon', 'authenticated', 'service_role')
              AND pronamespace = 'public'::regnamespace AND proname LIKE 'dev_live_owner_start_%'
            ORDER BY rolname, proname
        `);
        expect(rows.map(row => row.executable)).toEqual([
            false, false, false, false, false, false,
            false, false, false, false, false, false,
            true, true, true, true, true, true,
        ]);
        expect(rows.every(row => !row.writable)).toBe(true);
        await configureStandard();
        await db.exec('SET ROLE service_role');
        try {
            expect((await db.query('SELECT public.dev_live_owner_start_ready_v1($1::uuid) AS ready', [ownerId])).rows)
                .toEqual([{ ready: true }]);
            await expect(standardReady()).resolves.toBe(true);
            await expect(db.query('SELECT 1 FROM dev_live_budget.standard_owner_policy')).rejects.toThrow('permission denied');
            await expect(db.query('SELECT 1 FROM dev_live_budget.owner_starts')).rejects.toThrow('permission denied');
        } finally {
            await db.exec('RESET ROLE');
        }
        expect((await db.query('SELECT 1 FROM dev_live_budget.grants')).rows).toHaveLength(0);
    });

    it('creates one 30-minute grant for replayed starts and binds it to the sole owner and target', async () => {
        const attemptId = randomUUID();
        const [first, second] = await Promise.all([start(attemptId), start(attemptId)]);
        expect(first).toEqual(second);
        expect(first).toMatchObject({ targetInstagramId: target, apifyMaxCents: 500, aiMaxCents: 200 });
        expect(first.approvedAt).toMatch(/\.\d{3}Z$/);
        expect(Date.parse(first.expiresAt) - Date.parse(first.approvedAt)).toBe(30 * 60_000);
        expect((await db.query('SELECT 1 FROM dev_live_budget.owner_starts')).rows).toHaveLength(1);
        await expect(lookup(first)).resolves.toEqual(first);
        await expect(lookup(first, 'another')).resolves.toBeNull();
        await expect(lookup(first, target, randomUUID())).resolves.toBeNull();
        await expect(start(attemptId, 'another')).rejects.toThrow('DEV_LIVE_OWNER_START_TARGET_CONFLICT');
        await expect(start(attemptId, target, randomUUID())).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
    });

    it('fails closed for an unverified Kakao identity and never renews an expired attempt', async () => {
        const attemptId = randomUUID();
        const approval = await start(attemptId);
        await db.query(`
            UPDATE auth.identities
            SET identity_data = identity_data || '{"email_verified":false}'::jsonb WHERE user_id = $1
        `, [ownerId]);
        await expect(lookup(approval)).resolves.toBeNull();
        await expect(start()).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
        expect((await db.query('SELECT public.dev_live_owner_start_ready_v1($1::uuid) AS ready', [ownerId])).rows)
            .toEqual([{ ready: false }]);
        await db.query(`
            UPDATE auth.identities
            SET identity_data = identity_data || '{"email_verified":true}'::jsonb WHERE user_id = $1
        `, [ownerId]);
        await db.query(`
            UPDATE dev_live_budget.grants SET approved_at = statement_timestamp() - interval '30 minutes',
                expires_at = statement_timestamp() WHERE grant_id = $1
        `, [approval.id]);
        await expect(lookup(approval)).resolves.toBeNull();
        await expect(start(attemptId)).rejects.toThrow('DEV_LIVE_OWNER_START_UNAVAILABLE');
        expect((await start()).id).not.toBe(approval.id);
    });

    it('caps separate owner runs independently and requires exact persisted approval inputs', async () => {
        const first = await start();
        const second = await start();
        expect(first.id).not.toBe(second.id);
        await expect(reserve(first, 'apify', 5_000_000)).resolves.toBe(true);
        await expect(reserve(first, 'apify', 1)).resolves.toBe(false);
        await expect(reserve(first, 'vertex', 2_000_000)).resolves.toBe(true);
        await expect(reserve(first, 'vertex', 1)).resolves.toBe(false);
        await expect(reserve(second, 'apify', 5_000_000)).resolves.toBe(true);
        await expect(reserve(second, 'vertex', 2_000_000)).resolves.toBe(true);
        await expect(reserve({ ...second, expiresAt: first.approvedAt }, 'apify', 1))
            .rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve({ ...second, apifyMaxCents: 499 }, 'apify', 1))
            .rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve({ ...second, id: randomUUID() }, 'apify', 1))
            .rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
    });

    it('honors persisted legacy budgets while retaining one active legacy grant at a time', async () => {
        const legacy = {
            id: randomUUID(), targetInstagramId: target,
            approvedAt: new Date(Date.now() - 60_000).toISOString(),
            expiresAt: new Date(Date.now() + 60_000).toISOString(), apifyMaxCents: 25, aiMaxCents: 40,
        };
        const otherLegacy = { ...legacy, id: randomUUID() };
        const persistLegacy = (row: OwnerApproval) => db.query(`
            INSERT INTO dev_live_budget.grants (
                grant_id, approved_at, expires_at, apify_limit_micros, ai_limit_micros
            ) VALUES (${grantParameters})
        `, budgetValues(row));
        await persistLegacy(legacy);
        const owner = await start();
        await expect(reserve(legacy, 'vertex', 400_000)).resolves.toBe(true);
        await expect(reserve(owner, 'vertex', 2_000_000)).resolves.toBe(true);
        await expect(reserve(legacy, 'vertex', 1)).resolves.toBe(false);
        await persistLegacy(otherLegacy);
        await expect(reserve(legacy, 'apify', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve(otherLegacy, 'apify', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve(owner, 'apify', 1)).resolves.toBe(true);
    });

    it('requires a separately configured Standard target for the existing owner', async () => {
        await expect(standardReady()).resolves.toBe(false);
        await expect(startStandard()).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
        await configureStandard();
        await expect(standardReady()).resolves.toBe(true);
        await expect(standardReady('another')).resolves.toBe(false);
        await expect(standardReady(target, randomUUID())).resolves.toBe(false);
        await expect(startStandard(randomUUID(), 'another')).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
        await expect(startStandard(randomUUID(), target, randomUUID())).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
        await expect(startStandard('12345678-1234-1234-1234-123456789abc')).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
        expect((await db.query('SELECT 1 FROM dev_live_budget.grants')).rows).toHaveLength(0);
        expect((await db.query('SELECT runner_plan, command_version FROM public.account_e2e_test_runners')).rows)
            .toEqual([{ runner_plan: 'basic', command_version: 'dev-live-basic-v1' }]);
    });

    it('binds the Standard grant to its owner, target and attempt without exposing it as Basic', async () => {
        await configureStandard();
        const basicAttempt = randomUUID();
        const standardAttempt = randomUUID();
        const basic = await start(basicAttempt);
        const [standard, replay] = await Promise.all([startStandard(standardAttempt), startStandard(standardAttempt)]);
        expect(standard).toEqual(replay);
        expect(standard).toMatchObject({ planId: 'standard', targetInstagramId: target, apifyMaxCents: 600, aiMaxCents: 400 });
        expect(Date.parse(standard.expiresAt) - Date.parse(standard.approvedAt)).toBe(150 * 60_000);
        await expect(lookupStandard(standard)).resolves.toEqual(standard);
        await expect(lookupStandard(standard, 'another')).resolves.toBeNull();
        await expect(lookupStandard(standard, target, randomUUID())).resolves.toBeNull();
        await expect(lookupStandard(basic)).resolves.toBeNull();
        await expect(lookup(standard)).resolves.toBeNull();
        await expect(startStandard(basicAttempt)).rejects.toThrow('DEV_LIVE_OWNER_START_PLAN_CONFLICT');
        await expect(start(standardAttempt)).rejects.toThrow('DEV_LIVE_OWNER_START_UNAVAILABLE');
        await expect(start(standardAttempt, 'another')).rejects.toThrow('DEV_LIVE_OWNER_START_TARGET_CONFLICT');
        expect((await db.query('SELECT 1 FROM dev_live_budget.grants')).rows).toHaveLength(2);
    });

    it('caps each Standard provider using persisted approval and rejects duplicate reservations', async () => {
        await configureStandard();
        const grant = await startStandard();
        const reservationId = randomUUID();
        await expect(reserve(grant, 'apify', 5_000_001)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve(grant, 'apify', 5_000_000)).resolves.toBe(true);
        await expect(reserve(grant, 'apify', 1_000_001)).resolves.toBe(false);
        await expect(reserve(grant, 'apify', 1_000_000)).resolves.toBe(true);
        await expect(reserve(grant, 'apify', 1)).resolves.toBe(false);
        await expect(reserve(grant, 'vertex', 4_000_001)).resolves.toBe(false);
        await expect(reserve(grant, 'vertex', 3_999_999, reservationId)).resolves.toBe(true);
        await expect(reserve(grant, 'vertex', 1, reservationId)).rejects.toThrow();
        await expect(reserve(grant, 'vertex', 1)).resolves.toBe(true);
        await expect(reserve(grant, 'vertex', 1)).resolves.toBe(false);
        expect((await db.query(
            'SELECT public.dev_live_budget_settle_vertex_v1($1, $2, 3999998) AS settled',
            [grant.id, reservationId],
        )).rows).toEqual([{ settled: true }]);
        await expect(reserve(grant, 'vertex', 1)).resolves.toBe(true);
        await expect(reserve(grant, 'vertex', 1)).resolves.toBe(false);
        await expect(reserve({ ...grant, expiresAt: new Date(Date.parse(grant.expiresAt) + 1).toISOString() }, 'apify', 1))
            .rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve({ ...grant, aiMaxCents: 399 }, 'vertex', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
    });

    it('replays fresh Standard admission with the exact grant nonce and rejects a different plan, hash or revoked grant', async () => {
        await configureStandard();
        const grant = await startStandard();
        const preflightId = randomUUID();
        const jti = hashAnalysisTestEntitlementJti(`dev-live-${grant.id}`);
        const key = `dev-live:owner:standard:${grant.id}`;
        await db.query(`
            INSERT INTO public.analysis_preflights VALUES (
                $1, $2, $3, $4, 'test_entitlement', NULL, 1, 'standard', $5
            )
        `, [preflightId, ownerId, key, target, jti]);
        const reserveAdmission = (plan: string | null, hash: string) => db.query(`
            SELECT admission_status, selected_plan_id
            FROM public.reserve_analysis_v2_preflight_admission($1, $2, $3, $4, $5, $6)
        `, [preflightId, ownerId, plan, hash, randomUUID(), randomUUID()]);

        expect((await reserveAdmission('standard', jti)).rows)
            .toEqual([{ admission_status: 'ready', selected_plan_id: 'standard' }]);
        for (const wrongPlan of ['basic', 'plus', null]) {
            await expect(reserveAdmission(wrongPlan, jti)).rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE');
        }
        await expect(reserveAdmission('standard', '0'.repeat(64))).rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE');
        await db.exec('UPDATE dev_live_budget.standard_owner_policy SET enabled = false');
        await expect(reserveAdmission('standard', jti)).rejects.toThrow('ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE');
    });

    it('blocks Standard spending after owner, policy or expiry checks fail', async () => {
        await configureStandard();
        const attempt = randomUUID();
        const grant = await startStandard(attempt);
        await db.exec(`UPDATE auth.identities SET identity_data = identity_data || '{"email_verified":false}'::jsonb`);
        await expect(lookupStandard(grant)).resolves.toBeNull();
        await expect(reserve(grant, 'vertex', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await db.exec(`UPDATE auth.identities SET identity_data = identity_data || '{"email_verified":true}'::jsonb`);
        await db.exec('UPDATE dev_live_budget.standard_owner_policy SET enabled = false');
        await expect(standardReady()).resolves.toBe(false);
        await expect(startStandard()).rejects.toThrow('DEV_LIVE_OWNER_START_DENIED');
        await expect(lookupStandard(grant)).resolves.toBeNull();
        await expect(reserve(grant, 'apify', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await db.exec('UPDATE dev_live_budget.standard_owner_policy SET enabled = true');
        await expect(startStandard(attempt)).rejects.toThrow('DEV_LIVE_OWNER_START_UNAVAILABLE');
        const enabledGrant = await startStandard();
        await db.exec('DELETE FROM dev_live_budget.standard_owner_policy');
        await expect(lookupStandard(enabledGrant)).resolves.toBeNull();
        await expect(reserve(enabledGrant, 'vertex', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await configureStandard();
        await expect(lookupStandard(enabledGrant)).resolves.toBeNull();
        const originalTargetAttempt = randomUUID();
        const originalTargetGrant = await startStandard(originalTargetAttempt);
        await db.query('UPDATE dev_live_budget.standard_owner_policy SET target_instagram_id = $1', ['another']);
        await expect(startStandard(originalTargetAttempt, 'another')).rejects.toThrow('DEV_LIVE_OWNER_START_TARGET_CONFLICT');
        await expect(reserve(originalTargetGrant, 'apify', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await db.query('UPDATE dev_live_budget.standard_owner_policy SET target_instagram_id = $1', [target]);
        await expect(lookupStandard(originalTargetGrant)).resolves.toBeNull();
        const expiringAttempt = randomUUID();
        const expiring = await startStandard(expiringAttempt);
        await db.query(`
            UPDATE dev_live_budget.grants SET approved_at = statement_timestamp() - interval '150 minutes',
                expires_at = statement_timestamp() WHERE grant_id = $1
        `, [expiring.id]);
        await expect(lookupStandard(expiring)).resolves.toBeNull();
        await expect(startStandard(expiringAttempt)).rejects.toThrow('DEV_LIVE_OWNER_START_UNAVAILABLE');
        await expect(reserve(expiring, 'apify', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
    });
});
