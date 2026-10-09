import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildDevUiPlanSnapshot } from '@/lib/services/dev-ui/contracts';
import { createDevUiStore, type DevUiRpcClient } from '@/lib/services/dev-ui/store';
import { projectDevUiResult } from '@/lib/services/dev-ui/projection';

vi.mock('@/lib/services/dev-ui/deployment', () => ({ assertDevUiDeployment: vi.fn(() => ({})) }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: vi.fn(() => { throw new Error('Real client is forbidden'); }) } }));

const sqlFile = new URL('../../../supabase/dev-ui/control-plane.sql', import.meta.url);
const owner = '123e4567-e89b-42d3-a456-426614174000';
const other = '123e4567-e89b-42d3-a456-426614174001';
let db: PGlite;
let key = 0;
let baselineDefaultAcls: Row[];

type Row = Record<string, unknown>;
type Completion = { order: Row; run: Row | null; replayed: boolean };

async function sourceDefaultAcls(): Promise<Row[]> {
    const result = await db.query<Row>(`
        SELECT pg_get_userbyid(defaclrole) AS owner,
            CASE WHEN defaclnamespace = 0 THEN '<global>' ELSE defaclnamespace::regnamespace::text END AS schema,
            defaclobjtype::text AS type, defaclacl::text AS acl
        FROM pg_default_acl
        WHERE defaclnamespace = 0 OR defaclnamespace = 'public'::regnamespace
        ORDER BY owner, schema, type
    `);
    return result.rows;
}

async function rpc<T>(name: string, arguments_: unknown[]): Promise<T> {
    const placeholders = arguments_.map((_, index) => `$${index + 1}`).join(', ');
    const result = await db.query<{ payload: T }>(`SELECT public.${name}(${placeholders}) AS payload`, arguments_);
    return result.rows[0]!.payload;
}

async function preflight(scenario = 'complete', target = 'dev_synthetic', idempotencyKey = `synthetic-preflight-key-${++key}`) {
    return rpc<{ preflight: Row; created: boolean }>('dev_ui_create_preflight', [owner, target, idempotencyKey, scenario]);
}

async function checkout(preflightId: unknown, plan = 'basic', userId = owner) {
    return rpc<{ order: Row; replayed: boolean }>('dev_ui_create_checkout', [userId, preflightId, plan, true]);
}

async function complete(orderId: unknown, outcome = 'success', userId = owner) {
    return rpc<Completion>('dev_ui_complete_checkout', [userId, orderId, outcome]);
}

async function setExpiry(table: 'preflights' | 'orders' | 'runs', id: unknown, offset: string) {
    await db.query(`UPDATE dev_ui.${table} SET expires_at = clock_timestamp() + $2::interval WHERE id = $1::uuid`, [id, offset]);
}

beforeAll(async () => {
    db = await PGlite.create();
    // Model Supabase's inherited default grants, rather than starting with a
    // permissive grant-free toy schema. Only synthetic Auth identifiers exist.
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN BYPASSRLS;
        CREATE SCHEMA auth;
        CREATE TABLE auth.users (id uuid PRIMARY KEY);
        INSERT INTO auth.users VALUES ('${owner}'), ('${other}');
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
    `);
    baselineDefaultAcls = await sourceDefaultAcls();
    await db.exec(readFileSync(sqlFile, 'utf8'));
});
afterAll(async () => { await db?.close(); vi.unstubAllEnvs(); });

describe('Dev UI persisted control plane', () => {
    it('creates no run before payment and commits one started run together with success', async () => {
        const prepared = await preflight();
        const order = await checkout(prepared.preflight.id);
        expect(order.order).toMatchObject({ fixture_version: 'dev-ui-synthetic-v1', fixture_scenario: 'complete', duration_seconds: 45 });
        const before = await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM dev_ui.runs');
        expect(before.rows[0]!.count).toBe(0);
        await expect(complete(order.order.id)).resolves.toMatchObject({
            order: { id: order.order.id, status: 'success' }, run: { order_id: order.order.id, user_id: owner }, replayed: false,
        });
        const committed = await rpc<Completion>('dev_ui_read_checkout', [owner, order.order.id]);
        expect(committed.run?.started_at).toBe(committed.order.completed_at);
        expect(new Date(String(committed.run!.expires_at)).getTime() - new Date(String(committed.run!.started_at)).getTime())
            .toBe(7 * 24 * 60 * 60_000);
    });

    it.each(['cancel', 'failure'])('%s is terminal, starts no run and extends no TTL', async outcome => {
        const prepared = await preflight();
        const order = await checkout(prepared.preflight.id);
        const result = await complete(order.order.id, outcome);
        expect(result).toMatchObject({ order: { status: outcome, expires_at: order.order.expires_at }, run: null, replayed: false });
        expect(await complete(order.order.id, outcome)).toMatchObject({ run: null, replayed: true });
        await expect(complete(order.order.id)).rejects.toThrow('DEV_UI_COMPLETION_CONFLICT');
        expect((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM dev_ui.runs WHERE order_id = $1', [order.order.id])).rows[0]!.count).toBe(0);
    });

    it('replays a preflight payload and rejects another target or scenario under the same key', async () => {
        const idempotencyKey = `synthetic-replay-key-${++key}`;
        const first = await preflight('partial', 'dev_synthetic', idempotencyKey);
        const replay = await preflight('partial', 'dev_synthetic', idempotencyKey);
        expect(replay).toEqual({ preflight: first.preflight, created: false });
        await expect(preflight('complete', 'dev_synthetic', idempotencyKey)).rejects.toThrow('DEV_UI_IDEMPOTENCY_CONFLICT');
        await expect(preflight('partial', 'dev_other', idempotencyKey)).rejects.toThrow('DEV_UI_IDEMPOTENCY_CONFLICT');
        await expect(preflight('unexpected')).rejects.toThrow('DEV_UI_INVALID_INPUT');
    });

    it('keeps one owner/preflight order, its original plan snapshot and its expiry', async () => {
        const prepared = await preflight();
        const first = await checkout(prepared.preflight.id, 'standard');
        expect(await checkout(prepared.preflight.id, 'standard')).toEqual({ order: first.order, replayed: true });
        await expect(checkout(prepared.preflight.id, 'basic')).rejects.toThrow('DEV_UI_PLAN_CONFLICT');
        await expect(checkout(prepared.preflight.id, 'plus')).rejects.toThrow('DEV_UI_INVALID_INPUT');
        expect(first.order.plan_snapshot).toMatchObject({ planId: 'standard', pricingVersion: 'earlybird-2026-08-v5', price: { amountKrw: 19_900, currency: 'KRW', status: 'quoted' } });
        const invalid = await rpc<unknown>('dev_ui_create_checkout', [owner, prepared.preflight.id, 'standard', false]).catch(error => error);
        expect(invalid).toBeInstanceOf(Error);
    });

    it('denies another owner for every detail and mutation boundary', async () => {
        const prepared = await preflight();
        const order = await checkout(prepared.preflight.id);
        await expect(checkout(prepared.preflight.id, 'basic', other)).rejects.toThrow('DEV_UI_NOT_FOUND');
        await expect(complete(order.order.id, 'success', other)).rejects.toThrow('DEV_UI_NOT_FOUND');
        expect(await rpc('dev_ui_read_preflight', [other, prepared.preflight.id])).toBeNull();
        expect(await rpc('dev_ui_read_checkout', [other, order.order.id])).toBeNull();
        const completed = await complete(order.order.id);
        expect(await rpc('dev_ui_read_run', [other, completed.run!.id])).toBeNull();
        expect(await rpc('dev_ui_list_owner_orders', [other, 100])).toEqual([]);
    });

    it('accepts unpaid completion just before expiry and denies at/after expiry without a run', async () => {
        const before = await preflight();
        const beforeOrder = await checkout(before.preflight.id);
        await setExpiry('orders', beforeOrder.order.id, '1 second');
        await expect(complete(beforeOrder.order.id)).resolves.toMatchObject({ order: { status: 'success' } });
        const after = await preflight();
        const afterOrder = await checkout(after.preflight.id);
        await setExpiry('orders', afterOrder.order.id, '-1 millisecond');
        await expect(complete(afterOrder.order.id)).rejects.toThrow('DEV_UI_EXPIRED');
        const expired = await preflight();
        await setExpiry('preflights', expired.preflight.id, '-1 millisecond');
        await expect(checkout(expired.preflight.id)).rejects.toThrow('DEV_UI_EXPIRED');
        const replayKey = String(expired.preflight.idempotency_key);
        await expect(preflight('complete', 'dev_synthetic', replayKey)).rejects.toThrow('DEV_UI_EXPIRED');
    });

    it('checks preflight expiry and matching plan snapshots under the completion lock', async () => {
        const prepared = await preflight();
        const order = await checkout(prepared.preflight.id);
        await setExpiry('preflights', prepared.preflight.id, '-1 millisecond');
        await expect(complete(order.order.id)).rejects.toThrow('DEV_UI_EXPIRED');
        const intact = await preflight();
        const intactOrder = await checkout(intact.preflight.id);
        await db.query(`UPDATE dev_ui.orders SET plan_snapshot = jsonb_set(plan_snapshot, '{price,amountKrw}', '1') WHERE id = $1`, [intactOrder.order.id]);
        await expect(complete(intactOrder.order.id)).rejects.toThrow('DEV_UI_SNAPSHOT_MISMATCH');
        expect((await rpc<{ order: Row; run: Row | null }>('dev_ui_read_checkout', [owner, intactOrder.order.id]))!.run).toBeNull();
    });

    it('recovers the same run/start after a lost response, parallel completion and a delay beyond 30 minutes', async () => {
        const prepared = await preflight('empty');
        const order = await checkout(prepared.preflight.id);
        // The first response is deliberately not delivered to the caller.
        await complete(order.order.id);
        const [firstReplay, secondReplay] = await Promise.all([complete(order.order.id), complete(order.order.id)]);
        expect(secondReplay).toEqual(firstReplay);
        expect(firstReplay.replayed).toBe(true);
        await setExpiry('orders', order.order.id, '-31 minutes');
        await setExpiry('preflights', prepared.preflight.id, '-31 minutes');
        const delayed = await complete(order.order.id);
        expect(delayed.run).toEqual(firstReplay.run);
        expect(delayed).toMatchObject({ replayed: true, order: { id: firstReplay.order.id, completed_at: firstReplay.order.completed_at } });
        expect(await checkout(prepared.preflight.id)).toEqual({ order: delayed.order, replayed: true });
        expect((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM dev_ui.runs WHERE order_id = $1', [order.order.id])).rows[0]!.count).toBe(1);
    });

    it('serializes initially concurrent success requests into one run and one start', async () => {
        const prepared = await preflight();
        const order = await checkout(prepared.preflight.id);
        const completions = await Promise.all(Array.from({ length: 8 }, () => complete(order.order.id)));
        expect(completions.filter(result => !result.replayed)).toHaveLength(1);
        expect(new Set(completions.map(result => result.run!.id)).size).toBe(1);
        expect(new Set(completions.map(result => result.run!.started_at)).size).toBe(1);
    });

    it('uses the separate completed retention TTL and never generates a replacement run', async () => {
        const prepared = await preflight('failed');
        const order = await checkout(prepared.preflight.id);
        const result = await complete(order.order.id);
        await setExpiry('runs', result.run!.id, '-1 millisecond');
        await expect(complete(order.order.id)).rejects.toThrow('DEV_UI_RUN_EXPIRED');
        await expect(rpc('dev_ui_read_run', [owner, result.run!.id])).rejects.toThrow('DEV_UI_RUN_EXPIRED');
        expect((await db.query<{ count: number }>('SELECT count(*)::integer AS count FROM dev_ui.runs WHERE order_id = $1', [order.order.id])).rows[0]!.count).toBe(1);
    });

    it('validates actual SQL JSONB/quotes/timestamps through the owner store and restores the consumed preflight', async () => {
        vi.stubEnv('DEV_UI_TEST_USER_IDS', owner);
        vi.stubEnv('DEV_UI_ADMIN_USER_IDS', owner);
        const client: DevUiRpcClient = { async rpc(name, arguments_) {
            const parameters = Object.entries(arguments_).map(([parameter, value], index) => ({ parameter, value, index }));
            const placeholders = parameters.map(({ parameter, index }) => `${parameter} => $${index + 1}`).join(', ');
            const response = await db.query<{ payload: unknown }>(`SELECT public.${name}(${placeholders}) AS payload`, parameters.map(parameter => parameter.value));
            return { data: response.rows[0]!.payload, error: null };
        } };
        const subject = createDevUiStore({ getClient: () => client });
        const prepared = await subject.createOrReplayPreflight({ userId: owner, targetInstagramId: 'DEV_INTEGRATION', idempotencyKey: `synthetic-store-integration-${++key}`, fixtureScenario: 'partial' });
        const ready = (await subject.readPreflight({ userId: owner, preflightId: prepared.preflightId }))!;
        expect(ready.status).toBe('ready');
        expect(ready.snapshot).not.toHaveProperty('demo');
        const databaseSnapshot = await db.query<{ snapshot: unknown }>('SELECT dev_ui.plan_snapshot() AS snapshot');
        expect(databaseSnapshot.rows[0]!.snapshot).toEqual(buildDevUiPlanSnapshot());
        const order = await subject.createOrReplayCheckout({ userId: owner, preflightId: prepared.preflightId, planId: 'standard', disclosureAccepted: true });
        const paid = await subject.completeCheckout({ userId: owner, orderId: order.orderId, outcome: 'success' });
        expect(paid.status).toBe('success');
        const consumed = (await subject.readPreflight({ userId: owner, preflightId: prepared.preflightId }))!;
        expect(consumed.snapshot).toMatchObject({ status: 'consumed', requestId: paid.runId });
        const run = (await subject.readRun({ userId: owner, runId: paid.runId! }))!;
        const page = projectDevUiResult(run, { now: new Date(Date.parse(run.startedAt) + 45_000), femaleCursor: null, privateCursor: null, pageSize: 24 });
        expect(page.summary.planId).toBe('standard');
        expect(page.summary.followers.exactCountMatch).toBe(false);
        expect((await subject.readCheckout({ userId: owner, orderId: order.orderId }))?.run?.runId).toBe(paid.runId);
        const adminOrder = await subject.readAdminOrder({ adminUserId: owner, orderId: order.orderId });
        expect(adminOrder?.orderId).toBe(order.orderId);
        expect(JSON.stringify(adminOrder)).not.toContain(owner);
    });

    it('preserves source global/public default ACLs while revoking inherited access on every Dev wrapper/internal function', async () => {
        expect(await sourceDefaultAcls()).toEqual(baselineDefaultAcls);
        for (const role of ['anon', 'authenticated', 'service_role']) {
            const functions = await db.query<{ allowed: boolean }>(`
                SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS allowed
                FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname LIKE 'dev_ui_%'
            `, [role]);
            expect(functions.rows).toHaveLength(9);
            expect(functions.rows.every(row => row.allowed === (role === 'service_role'))).toBe(true);
            if (role !== 'service_role') {
                const internal = await db.query<{ allowed: boolean }>(`
                    SELECT has_function_privilege($1, p.oid, 'EXECUTE') AS allowed
                    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'dev_ui'
                `, [role]);
                expect(internal.rows).toHaveLength(1);
                expect(internal.rows.every(row => !row.allowed)).toBe(true);
            }
            const tables = await db.query<{ allowed: boolean; rls: boolean }>(`
                SELECT has_table_privilege($1, c.oid, 'SELECT') AS allowed, c.relrowsecurity AS rls
                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'dev_ui' AND c.relkind = 'r'
            `, [role]);
            expect(tables.rows).toHaveLength(3);
            expect(tables.rows.every(row => row.rls && row.allowed === (role === 'service_role'))).toBe(true);
        }
        await db.exec('CREATE FUNCTION public.baseline_default_acl_probe() RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;');
        for (const role of ['anon', 'authenticated']) {
            const privileges = await db.query<{ allowed: boolean }>(`SELECT has_function_privilege($1, 'public.baseline_default_acl_probe()', 'EXECUTE') AS allowed`, [role]);
            expect(privileges.rows[0]!.allowed).toBe(true);
        }
        await db.exec('SET ROLE anon');
        try {
            await expect(db.query('SELECT public.dev_ui_read_preflight($1, gen_random_uuid())', [owner])).rejects.toThrow(/permission denied/);
            await expect(db.query('SELECT * FROM dev_ui.preflights')).rejects.toThrow(/permission denied/);
        } finally { await db.exec('RESET ROLE'); }
    });
});
