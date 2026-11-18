import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

type OwnerApproval = {
    id: string;
    targetInstagramId: string;
    approvedAt: string;
    expiresAt: string;
    apifyMaxCents: number;
    aiMaxCents: number;
};

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

function budgetValues(approval: OwnerApproval) {
    return [
        approval.id, approval.approvedAt, approval.expiresAt,
        approval.apifyMaxCents * 10_000, approval.aiMaxCents * 10_000,
    ];
}

async function reserve(approval: OwnerApproval, provider: 'apify' | 'vertex', amount: number) {
    const result = await db.query<{ reserved: boolean }>(
        `SELECT public.dev_live_budget_reserve_v1(${grantParameters}, $6, $7, $8) AS reserved`,
        [...budgetValues(approval), randomUUID(), provider, amount],
    );
    return result.rows[0].reserved;
}

async function readSql(name: string) {
    return readFile(new URL(`../../../supabase/dev-ui/${name}.sql`, import.meta.url), 'utf8');
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
        await db.exec(ownerStartSql);
        await db.exec(ownerStartSql);
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE dev_live_budget.reservations, dev_live_budget.owner_starts, dev_live_budget.grants;
            TRUNCATE public.account_classification_audit, public.account_e2e_test_runners, auth.identities, auth.users;
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
                   has_table_privilege(rolname, 'dev_live_budget.owner_starts', 'INSERT') AS writable
            FROM pg_roles CROSS JOIN pg_proc
            WHERE rolname IN ('anon', 'authenticated', 'service_role')
              AND pronamespace = 'public'::regnamespace AND proname LIKE 'dev_live_owner_start_%'
            ORDER BY rolname, proname
        `);
        expect(rows.map(row => row.executable)).toEqual([false, false, false, false, false, false, true, true, true]);
        expect(rows.every(row => !row.writable)).toBe(true);
        await db.exec('SET ROLE service_role');
        try {
            expect((await db.query('SELECT public.dev_live_owner_start_ready_v1() AS ready')).rows)
                .toEqual([{ ready: true }]);
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
        expect((await db.query('SELECT public.dev_live_owner_start_ready_v1() AS ready')).rows)
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
});
