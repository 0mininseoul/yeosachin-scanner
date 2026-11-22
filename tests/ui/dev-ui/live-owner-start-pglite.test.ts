import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ownerGrantFixtureSql, seedOwnerGrantAccount } from './fixtures/owner-grant';
import { PGlite } from '@electric-sql/pglite';
import { MediaResolution, type GenerateContentParameters } from '@google/genai';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashAnalysisTestEntitlementJti } from '@/lib/services/analysis/test-entitlement-jti';
import { estimateDevLiveVertexReservation } from '@/lib/services/dev-ui/live-vertex-reservation';

type OwnerApproval = {
    id: string;
    targetInstagramId: string;
    approvedAt: string;
    expiresAt: string;
    apifyMaxCents: number;
    aiMaxCents: number;
};

type StandardOwnerApproval = OwnerApproval & { planId: 'standard' };
type DurableStandardOwnerApproval = Omit<StandardOwnerApproval, 'expiresAt'> & { expiresAt: null };
type BudgetApproval = OwnerApproval | DurableStandardOwnerApproval;

const ownerId = randomUUID();
const fixtureEmail = 'owner@invalid.test';
const target = 'public_fixture';
const grantParameters = '$1::uuid, $2::timestamptz, $3::timestamptz, $4::integer, $5::integer';

const featurePrompt = '한글 "평가"\nﷺ';
const featureSchema = { type: 'object', properties: { summary: { type: 'string', description: '후보 평가' } } };

function featureRequest(imageCount = 2) {
    return {
        model: 'gemini-3.7-flash',
        contents: [{
            role: 'user',
            parts: [
                { text: featurePrompt },
                ...Array.from({ length: imageCount }, () => ({ inlineData: { mimeType: 'image/jpeg', data: '/9j/2Q==' } })),
            ],
        }],
        config: {
            candidateCount: 1,
            responseMimeType: 'application/json',
            responseJsonSchema: featureSchema,
            httpOptions: { retryOptions: { attempts: 1 } },
            mediaResolution: MediaResolution.MEDIA_RESOLUTION_MEDIUM,
            maxOutputTokens: 8_192,
        },
    } satisfies GenerateContentParameters;
}

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
    const result = await db.query<{ ready: boolean }>('SELECT public.dev_live_owner_start_ready_v4($1, $2) AS ready', [userId, username]);
    return result.rows[0].ready;
}

async function startStandard(attemptId = randomUUID(), username = target, userId = ownerId, version: 2 | 3 = 3): Promise<StandardOwnerApproval> {
    const result = await db.query<{ approval: StandardOwnerApproval }>(
        `SELECT public.dev_live_owner_start_v${version}($1, $2, $3) AS approval`, [userId, username, attemptId],
    );
    return result.rows[0].approval;
}

async function startDurableStandard(attemptId = randomUUID(), username = target, userId = ownerId): Promise<DurableStandardOwnerApproval> {
    const result = await db.query<{ approval: DurableStandardOwnerApproval }>(
        'SELECT public.dev_live_owner_start_v4($1, $2, $3) AS approval', [userId, username, attemptId],
    );
    return result.rows[0].approval;
}

async function lookupStandard(grant: BudgetApproval, username = target, userId = ownerId): Promise<StandardOwnerApproval | DurableStandardOwnerApproval | null> {
    const result = await db.query<{ approval: StandardOwnerApproval | DurableStandardOwnerApproval | null }>(
        'SELECT public.dev_live_owner_start_lookup_v2($1, $2, $3) AS approval', [grant.id, userId, username],
    );
    return result.rows[0].approval;
}

function budgetValues(approval: BudgetApproval) {
    return [
        approval.id, approval.approvedAt, approval.expiresAt ?? 'infinity',
        approval.apifyMaxCents * 10_000, approval.aiMaxCents * 10_000,
    ];
}

async function reserve(approval: BudgetApproval, provider: 'apify' | 'vertex', amount: number, reservationId = randomUUID()) {
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
        await db.exec(ownerGrantFixtureSql);
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
        await db.exec(`
            ALTER TABLE public.analysis_preflights ADD COLUMN consumed_request_id uuid;
            CREATE TABLE public.analysis_requests (
                id uuid PRIMARY KEY, preflight_id uuid, user_id uuid, pipeline_version text,
                status text, selected_plan_id_snapshot text
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id uuid, job_key text, status text, dispatch_state text DEFAULT 'pending',
                dispatch_generation integer DEFAULT 0, dispatch_reservation_token uuid,
                dispatch_reserved_at timestamptz, dispatched_at timestamptz, dispatch_task_name text,
                lease_expires_at timestamptz, recovery_not_before timestamptz,
                scheduler_not_before_at timestamptz
            );
            CREATE FUNCTION public.list_analysis_v2_dispatchable_jobs(integer)
            RETURNS void LANGUAGE plpgsql AS $$ BEGIN NULL; END $$;
        `);
        const recoverySql = await readSql('live-standard-dispatch-recovery');
        await db.exec(recoverySql);
        await db.exec(recoverySql);
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE dev_live_budget.reservations, dev_live_budget.owner_starts, dev_live_budget.grants,
                dev_live_budget.standard_owner_policy;
            TRUNCATE public.analysis_pipeline_jobs, public.analysis_requests, public.analysis_preflights,
                public.account_classification_audit,
                public.account_e2e_test_runners, auth.identities, auth.users;
        `);
        await seedOwnerGrantAccount((sql, values) => db.query(sql, values), ownerId, fixtureEmail);
    });

    afterAll(async () => { await db?.close(); });

    it('exposes only read or owner-start RPCs to service role and leaves readiness read-only', async () => {
        const { rows } = await db.query<{ rolname: string; proname: string; executable: boolean; writable: boolean }>(`
            SELECT rolname, proname, has_function_privilege(rolname, pg_proc.oid, 'EXECUTE') AS executable,
                   (has_table_privilege(rolname, 'dev_live_budget.owner_starts', 'INSERT')
                       OR has_table_privilege(rolname, 'dev_live_budget.standard_owner_policy', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) AS writable
            FROM pg_roles CROSS JOIN pg_proc
            WHERE rolname IN ('anon', 'authenticated', 'service_role')
              AND (
                  (pronamespace = 'public'::regnamespace AND proname LIKE 'dev_live_owner_start_%')
                  OR (pronamespace = 'dev_live_budget'::regnamespace AND proname = 'start_standard_owner_run')
              )
            ORDER BY rolname, proname
        `);
        expect(rows).toHaveLength(33);
        const executable = rows.filter(row => row.executable);
        expect(executable.every(row => row.rolname === 'service_role')).toBe(true);
        expect(executable.map(row => row.proname)).toEqual([
            'dev_live_owner_start_lookup_v1', 'dev_live_owner_start_lookup_v2',
            'dev_live_owner_start_ready_v1', 'dev_live_owner_start_ready_v2', 'dev_live_owner_start_ready_v3', 'dev_live_owner_start_ready_v4',
            'dev_live_owner_start_v1', 'dev_live_owner_start_v2', 'dev_live_owner_start_v3', 'dev_live_owner_start_v4',
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
        expect(standard).toMatchObject({ planId: 'standard', targetInstagramId: target, apifyMaxCents: 600, aiMaxCents: 1_800 });
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
        await expect(reserve(grant, 'vertex', 5_000_001)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        for (const amount of [5_000_000, 5_000_000, 5_000_000]) {
            await expect(reserve(grant, 'vertex', amount)).resolves.toBe(true);
        }
        await expect(reserve(grant, 'vertex', 3_000_001)).resolves.toBe(false);
        await expect(reserve(grant, 'vertex', 2_999_999, reservationId)).resolves.toBe(true);
        await expect(reserve(grant, 'vertex', 1, reservationId)).rejects.toThrow();
        await expect(reserve(grant, 'vertex', 1)).resolves.toBe(true);
        await expect(reserve(grant, 'vertex', 1)).resolves.toBe(false);
        expect((await db.query(
            'SELECT public.dev_live_budget_settle_vertex_v1($1, $2, 2999998) AS settled',
            [grant.id, reservationId],
        )).rows).toEqual([{ settled: true }]);
        await expect(reserve(grant, 'vertex', 1)).resolves.toBe(true);
        await expect(reserve(grant, 'vertex', 1)).resolves.toBe(false);
        await expect(reserve({ ...grant, expiresAt: new Date(Date.parse(grant.expiresAt) + 1).toISOString() }, 'apify', 1))
            .rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve({ ...grant, aiMaxCents: 1_801 }, 'vertex', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
    });

    it('serializes Standard spend on its grant and preserves committed and pending reservations on reinstall', async () => {
        await configureStandard();
        const grant = await startDurableStandard();
        const pending = randomUUID();
        const settled = randomUUID();
        await db.exec('BEGIN');
        try {
            expect(await reserve(grant, 'vertex', 100_000, pending)).toBe(true);
            expect((await db.query(`
                SELECT 1 FROM pg_locks WHERE pid = pg_backend_pid() AND locktype = 'advisory'
                AND classid = 49736740 AND objid = 1 AND objsubid = 2
            `)).rows).toHaveLength(0);
            await db.exec('COMMIT');
        } catch (error) {
            await db.exec('ROLLBACK');
            throw error;
        }
        expect(await reserve(grant, 'vertex', 200_000, settled)).toBe(true);
        await db.query('SELECT public.dev_live_budget_settle_vertex_v1($1, $2, 50000)', [grant.id, settled]);
        await db.exec(await readSql('live-owner-start-standard'));

        await expect(reserve(grant, 'vertex', 100_000, pending)).rejects.toMatchObject({ code: '23505' });
        await expect(reserve(grant, 'apify', 1, settled)).rejects.toMatchObject({ code: '23505' });
        expect((await db.query(`
            SELECT reserved_micros, actual_micros FROM dev_live_budget.reservations
            WHERE grant_id = $1 ORDER BY reserved_micros
        `, [grant.id])).rows).toEqual([
            { reserved_micros: 100_000, actual_micros: null },
            { reserved_micros: 200_000, actual_micros: 50_000 },
        ]);
        expect((await db.query(`
            SELECT ai_committed_micros, apify_committed_micros FROM dev_live_budget.grants WHERE grant_id = $1
        `, [grant.id])).rows).toEqual([{ ai_committed_micros: 150_000, apify_committed_micros: 0 }]);
    });

    it('caps a burst of concurrent durable Standard Vertex reservations until usage settles', async () => {
        await configureStandard();
        const grant = await startDurableStandard();
        for (const amount of [5_000_000, 5_000_000, 5_000_000, 2_200_000]) {
            const priorId = randomUUID();
            await expect(reserve(grant, 'vertex', amount, priorId)).resolves.toBe(true);
            await db.query('SELECT public.dev_live_budget_settle_vertex_v1($1, $2, $3)', [grant.id, priorId, amount]);
        }

        const ids = Array.from({ length: 8 }, () => randomUUID());
        const admitted = await Promise.all(ids.map(id => reserve(grant, 'vertex', 153_875, id)));
        const admittedIds = ids.filter((_id, index) => admitted[index]);
        expect(admittedIds).toHaveLength(5);
        await expect(db.query(
            'SELECT ai_committed_micros FROM dev_live_budget.grants WHERE grant_id = $1',
            [grant.id],
        )).resolves.toMatchObject({ rows: [{ ai_committed_micros: 17_969_375 }] });

        await Promise.all(admittedIds.map(id => db.query(
            'SELECT public.dev_live_budget_settle_vertex_v1($1, $2, 50000)',
            [grant.id, id],
        )));
        await expect(reserve(grant, 'vertex', 153_875)).resolves.toBe(true);
        await expect(db.query(
            'SELECT ai_committed_micros FROM dev_live_budget.grants WHERE grant_id = $1',
            [grant.id],
        )).resolves.toMatchObject({ rows: [{ ai_committed_micros: 17_603_875 }] });
    });

    it('keeps new Standard approvals active beyond the old window without reopening expired grants', async () => {
        await configureStandard();
        const legacyAttempt = randomUUID();
        const legacy = await startStandard(legacyAttempt);
        const durableAttempt = randomUUID();
        const durable = await startDurableStandard(durableAttempt);
        expect(durable).toMatchObject({ expiresAt: null, apifyMaxCents: 600, aiMaxCents: 1_800 });
        await expect(startStandard(durableAttempt)).rejects.toThrow('DEV_LIVE_OWNER_START_UNAVAILABLE');
        await expect(startDurableStandard(legacyAttempt)).rejects.toThrow('DEV_LIVE_OWNER_START_UNAVAILABLE');
        const twoDaysAgo = Date.now() - 48 * 60 * 60_000;
        const expired = {
            ...legacy,
            approvedAt: new Date(twoDaysAgo).toISOString(),
            expiresAt: new Date(twoDaysAgo + 150 * 60_000).toISOString(),
        };
        await db.query(`
            UPDATE dev_live_budget.grants
            SET approved_at = $3::timestamptz,
                expires_at = CASE WHEN grant_id = $1 THEN $4::timestamptz ELSE expires_at END
            WHERE grant_id IN ($1, $2)
        `, [legacy.id, durable.id, expired.approvedAt, expired.expiresAt]);

        await db.exec(await readSql('live-owner-start-standard'));
        await expect(lookupStandard(expired)).resolves.toBeNull();
        await expect(reserve(expired, 'vertex', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        const aged = await startDurableStandard(durableAttempt);
        expect(aged).toMatchObject({ id: durable.id, approvedAt: expired.approvedAt, expiresAt: null });
        await expect(lookupStandard(aged)).resolves.toEqual(aged);
        await expect(reserve(aged, 'apify', 5_000_000)).resolves.toBe(true);
        await expect(reserve(aged, 'apify', 1_000_000)).resolves.toBe(true);
        await expect(reserve(aged, 'apify', 1)).resolves.toBe(false);
        await expect(reserve({ ...aged, expiresAt: expired.expiresAt }, 'vertex', 1))
            .rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve(aged, 'vertex', 1)).resolves.toBe(true);
        await db.exec('UPDATE dev_live_budget.standard_owner_policy SET enabled = false');
        await expect(lookupStandard(aged)).resolves.toBeNull();
        await expect(reserve(aged, 'vertex', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
    });

    it('preserves a prior $4 grant and admits the same representative feature request on a fresh $18 grant', async () => {
        await configureStandard();
        const oldAttemptId = randomUUID();
        const oldGrant = await startStandard(oldAttemptId, target, ownerId, 2);
        expect(oldGrant.aiMaxCents).toBe(400);
        await db.exec(await readSql('live-owner-start-standard'));
        await expect(lookupStandard(oldGrant)).resolves.toEqual(oldGrant);
        await expect(startStandard(oldAttemptId)).rejects.toThrow('DEV_LIVE_OWNER_START_UNAVAILABLE');

        const grant = await startStandard();
        expect(grant.aiMaxCents).toBe(1_800);
        const settled = 3_922_786;
        await expect(reserve(oldGrant, 'vertex', settled)).resolves.toBe(true);
        await expect(reserve({ ...oldGrant, aiMaxCents: grant.aiMaxCents }, 'vertex', 1))
            .rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve(grant, 'vertex', settled)).resolves.toBe(true);

        const imageCount = 11;
        const estimate = estimateDevLiveVertexReservation(featureRequest(imageCount), 'global');
        const inputTokens = Buffer.byteLength(JSON.stringify(featurePrompt).normalize('NFKD'))
            + Buffer.byteLength(JSON.stringify(featureSchema).normalize('NFKD')) + imageCount * 1_120 + 2_048;
        expect(estimate).toMatchObject({
            inputTokens,
            outputTokens: 8_192,
            totalCostUsd: (inputTokens * 1.5 + 8_192 * 7.5) / 1_000_000,
        });
        const amount = Math.ceil(estimate!.totalCostUsd * 1_000_000);
        await expect(reserve(oldGrant, 'vertex', amount)).resolves.toBe(false);
        await expect(reserve(grant, 'vertex', amount)).resolves.toBe(true);
    });

    it('rejects model, transport, and payload changes outside the Dev request envelope', () => {
        const request = featureRequest();
        const estimate = (params: GenerateContentParameters = request, location = 'global') => (
            estimateDevLiveVertexReservation(params, location)
        );
        const config = (overrides: Partial<NonNullable<GenerateContentParameters['config']>>) => ({
            ...request, config: { ...request.config, ...overrides },
        });
        const part = (overrides: typeof request.contents[0]['parts']) => ({
            ...request, contents: [{ role: 'user', parts: overrides }],
        });
        expect(estimate(request, 'us-central1')).toBeNull();
        expect(estimate({ ...request, model: 'gemini-unpriced' })).toBeNull();
        expect(estimate(config({ candidateCount: 2 }))).toBeNull();
        expect(estimate(config({ httpOptions: { retryOptions: { attempts: 2 } } }))).toBeNull();
        expect(estimate(config({
            httpOptions: { retryOptions: { attempts: 1 }, extraBody: { tools: [] } },
        }))).toBeNull();
        expect(estimate(config({ systemInstruction: 'unpriced text' }))).toBeNull();
        expect(estimate(config({ responseJsonSchema: undefined }))).toBeNull();
        for (const output of [undefined, 0, 1.5, 65_537]) {
            expect(estimate(config({ maxOutputTokens: output }))).toBeNull();
        }
        expect(estimate(part([{ text: featurePrompt }, { text: 'extra text part' }]))).toBeNull();
        expect(estimate(part([
            { text: featurePrompt }, { inlineData: { mimeType: 'audio/wav', data: 'AAAA' } },
        ]))).toBeNull();
        expect(estimate(part([
            { text: featurePrompt }, ...Array.from({ length: 12 }, () => (
                { inlineData: { mimeType: 'image/jpeg', data: '/9j/2Q==' } }
            )),
        ]))).toBeNull();
        expect(estimate(part([{ text: 'a'.repeat(1_048_576) }]))).toBeNull();
        expect(estimate(config({ mediaResolution: undefined }))).toEqual(estimate());
    });

    it('replays fresh Standard admission with the exact grant nonce and rejects a different plan, hash or revoked grant', async () => {
        await configureStandard();
        const grant = await startDurableStandard();
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

    it('recovers only due jobs fenced to the active Dev Standard approval', async () => {
        await configureStandard();
        const durable = await startDurableStandard();
        const finite = await startStandard();
        const addRequest = async (grant: BudgetApproval, consumed: boolean) => {
            const requestId = randomUUID();
            const preflightId = randomUUID();
            await db.query(`
                INSERT INTO public.analysis_preflights (
                    id, user_id, idempotency_key, target_instagram_id, access_mode, consumed_request_id
                ) VALUES ($1, $2, $3, $4, 'test_entitlement', $5)
            `, [preflightId, ownerId, `dev-live:owner:standard:${grant.id}`, target, consumed ? requestId : null]);
            await db.query(`
                INSERT INTO public.analysis_requests VALUES ($1, $2, $3, 'v2', 'processing', 'standard')
            `, [requestId, preflightId, ownerId]);
            return requestId;
        };
        const correctRequest = await addRequest(durable, true);
        const finiteRequest = await addRequest(finite, true);
        const detachedRequest = await addRequest(durable, false);
        await db.query(`
            INSERT INTO public.analysis_pipeline_jobs (
                request_id, job_key, status, recovery_not_before, scheduler_not_before_at, lease_expires_at
            ) VALUES
                ($1, 'eligible', 'pending', now() - interval '1 hour', NULL, NULL),
                ($1, 'future-recovery', 'pending', now() + interval '1 hour', NULL, NULL),
                ($1, 'future-scheduler', 'pending', now() - interval '1 hour', now() + interval '1 hour', NULL),
                ($1, 'active-lease', 'processing', now() - interval '1 hour', NULL, now() + interval '1 hour'),
                ($2, 'finite-grant', 'pending', now() - interval '1 hour', NULL, NULL),
                ($3, 'detached-preflight', 'pending', now() - interval '1 hour', NULL, NULL)
        `, [correctRequest, finiteRequest, detachedRequest]);
        const list = () => db.query(
            'SELECT request_id, job_key FROM public.list_dev_live_standard_dispatchable_jobs_v1(100)',
        );
        await db.exec('SET ROLE service_role');
        try {
            await expect(list()).resolves.toMatchObject({
                rows: [{ request_id: correctRequest, job_key: 'eligible' }],
            });
        } finally {
            await db.exec('RESET ROLE');
        }
        const secondActiveRequest = await addRequest(await startDurableStandard(), true);
        await expect(list()).resolves.toMatchObject({ rows: [] });
        await db.query("UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1", [secondActiveRequest]);
        await expect(list()).resolves.toMatchObject({ rows: [{ request_id: correctRequest, job_key: 'eligible' }] });
        await db.exec('UPDATE dev_live_budget.standard_owner_policy SET enabled = false');
        await expect(list()).resolves.toMatchObject({ rows: [] });
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
