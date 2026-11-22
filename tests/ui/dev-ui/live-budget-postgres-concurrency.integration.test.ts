import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ownerGrantFixtureSql, seedOwnerGrantAccount } from './fixtures/owner-grant';

type Grant = { id: string; approvedAt: string };

// Opt in with RUN_DEV_LIVE_BUDGET_POSTGRES_TEST=1 and local initdb/pg_ctl on PATH.
describe.runIf(process.env.RUN_DEV_LIVE_BUDGET_POSTGRES_TEST === '1')('Dev live budget locking', () => {
    let directory: string;
    let cluster: string;
    let first: Client;
    let second: Client;
    let workers: Pool;
    const owner = randomUUID();
    let started = false;
    async function issue(client: Client): Promise<Grant> {
        const result = await client.query<{ grant: Grant }>(`
            SELECT public.dev_live_owner_start_v4($1, 'fixture', $2) AS grant
        `, [owner, randomUUID()]);
        return result.rows[0].grant;
    }
    async function reserve(grant: Grant, id = randomUUID()) {
        const result = await second.query<{ ok: boolean }>(`
            SELECT public.dev_live_budget_reserve_v1($1, $2, 'infinity', 6000000, 18000000, $3, 'vertex', 100) AS ok
        `, [grant.id, grant.approvedAt, id]);
        return result.rows[0].ok;
    }
    beforeAll(async () => {
        directory = mkdtempSync(join(tmpdir(), 'dev-budget-'));
        cluster = join(directory, 'pg');
        const clientOptions = { host: cluster, port: 5432, user: 'fixture', database: 'postgres' };
        first = new Client(clientOptions);
        second = new Client(clientOptions);
        workers = new Pool({ ...clientOptions, max: 8, statement_timeout: 1_000 });
        execFileSync('initdb', ['-D', cluster, '-U', 'fixture', '-A', 'trust', '--no-locale'], { stdio: 'ignore' });
        execFileSync('pg_ctl', ['-D', cluster, '-l', join(directory, 'postgres.log'), '-o',
            "-c unix_socket_directories=. -c listen_addresses='' -p 5432", '-w', 'start'], { stdio: 'ignore' });
        started = true;
        await Promise.all([first.connect(), second.connect()]);
        await first.query(ownerGrantFixtureSql);
        await first.query(`
            CREATE SCHEMA dev_ui;
            CREATE TABLE dev_ui.preflights (id uuid);
            CREATE TABLE dev_ui.orders (id uuid);
            CREATE TABLE dev_ui.runs (id uuid);
        `);
        for (const name of ['live-budget', 'live-owner-start', 'live-owner-start-standard']) {
            await first.query(readFileSync(new URL(`../../../supabase/dev-ui/${name}.sql`, import.meta.url), 'utf8'));
        }
        await seedOwnerGrantAccount((sql, values) => first.query(sql, values), owner, 'fixture@invalid.test');
        await first.query("INSERT INTO dev_live_budget.standard_owner_policy(target_instagram_id) VALUES ('fixture')");
        await second.query("SET statement_timeout = '1s'");
    }, 30_000);

    afterAll(async () => {
        await Promise.allSettled([workers.end(), first.end(), second.end()]);
        if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
        rmSync(directory, { recursive: true, force: true });
    });

    it('fences unpublished grants and revocation, and charges a rolled-back reservation exactly once', async () => {
        const existing = await issue(first);
        await first.query('BEGIN');
        const issuing = await issue(first);
        await expect(reserve(existing)).resolves.toBe(true);
        await expect(reserve(issuing)).rejects.toMatchObject({ code: 'P0001', message: 'DEV_LIVE_BUDGET_UNAVAILABLE' });
        await first.query('COMMIT');

        const reservation = randomUUID();
        await first.query('BEGIN');
        await first.query('SELECT 1 FROM dev_live_budget.grants WHERE grant_id = $1 FOR UPDATE', [issuing.id]);
        await expect(reserve(issuing, reservation)).rejects.toMatchObject({ code: '57014' });
        await first.query('ROLLBACK');
        await expect(reserve(issuing, reservation)).resolves.toBe(true);
        await expect(reserve(issuing, reservation)).rejects.toMatchObject({ code: '23505' });

        await second.query('BEGIN');
        await expect(reserve(issuing)).resolves.toBe(true);
        await first.query("SET statement_timeout = '1s'");
        await expect(first.query('UPDATE dev_live_budget.standard_owner_policy SET enabled = false'))
            .rejects.toMatchObject({ code: '57014' });
        await second.query('ROLLBACK');
        await first.query('UPDATE dev_live_budget.standard_owner_policy SET enabled = false');
        await expect(reserve(issuing)).rejects.toMatchObject({ code: 'P0001', message: 'DEV_LIVE_BUDGET_UNAVAILABLE' });
        expect((await second.query(`
            SELECT ai_committed_micros, (SELECT count(*)::integer FROM dev_live_budget.reservations
                WHERE grant_id = $1) AS reservations FROM dev_live_budget.grants WHERE grant_id = $1
        `, [issuing.id])).rows).toEqual([{ ai_committed_micros: 100, reservations: 1 }]);
        await first.query('UPDATE dev_live_budget.standard_owner_policy SET enabled = true');
    });

    async function staged(grant: Grant, id: string, amount = 100): Promise<string | null> {
        const { rows } = await workers.query<{ id: string | null }>(`
            SELECT public.dev_live_budget_reserve_vertex_attempt_v1($1, $2, 'infinity', 6000000, 18000000, $3, $4) AS id
        `, [grant.id, grant.approvedAt, id, amount]);
        return rows[0].id;
    }

    async function settle(grant: Grant, id: string, actual: number) {
        const { rows } = await workers.query<{ ok: boolean }>(
            'SELECT public.dev_live_budget_settle_vertex_v1($1, $2, $3) AS ok', [grant.id, id, actual],
        );
        return rows[0].ok;
    }

    async function releaseUnused(grant: Grant, id: string) {
        const { rows } = await workers.query<{ ok: boolean }>(
            'SELECT public.dev_live_budget_release_unused_vertex_v1($1, $2) AS ok', [grant.id, id],
        );
        return rows[0].ok;
    }

    it('allows eight same-grant workers to reserve and settle behind a foreign-key reader', async () => {
        const grant = await issue(first);
        await first.query('BEGIN');
        try {
            await first.query('SELECT 1 FROM dev_live_budget.grants WHERE grant_id = $1 FOR KEY SHARE', [grant.id]);
            await Promise.all(Array.from({ length: 8 }, async () => {
                for (let i = 0; i < 20; i++) {
                    const key = randomUUID();
                    expect(await staged(grant, key)).toBe(key);
                    expect(await settle(grant, key, 35)).toBe(true);
                }
            }));
        } finally {
            await first.query('ROLLBACK');
        }
        expect((await first.query(`
            SELECT g.ai_committed_micros, COUNT(*)::int AS receipts, SUM(r.actual_micros)::int AS cost
            FROM dev_live_budget.grants AS g JOIN dev_live_budget.reservations AS r USING (grant_id)
            WHERE g.grant_id = $1 GROUP BY g.grant_id
        `, [grant.id])).rows).toEqual([{ ai_committed_micros: 5600, receipts: 160, cost: 5600 }]);
    }, 15_000);

    it('keeps an unrelated receipt usable while settlement waits on its own receipt', async () => {
        const grant = await issue(first);
        const receipt = randomUUID();
        expect(await staged(grant, receipt)).toBe(receipt);
        await first.query('BEGIN');
        let settlement: Promise<unknown> | undefined;
        try {
            await first.query('SELECT 1 FROM dev_live_budget.reservations WHERE reservation_id=$1 FOR UPDATE', [receipt]);
            const pid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            settlement = second.query('SELECT public.dev_live_budget_settle_vertex_v1($1, $2, 50)', [grant.id, receipt]);
            const deadline = performance.now() + 500;
            let waiting = false;
            do {
                waiting = (await first.query<{ waiting: boolean }>(
                    'SELECT cardinality(pg_blocking_pids($1)) > 0 AS waiting', [pid],
                )).rows[0].waiting;
            } while (!waiting && performance.now() < deadline);
            expect(waiting).toBe(true);
            const independent = randomUUID();
            expect(await staged(grant, independent)).toBe(independent);
            expect(await settle(grant, independent, 100)).toBe(true);
        } finally {
            await first.query('ROLLBACK');
            await settlement;
        }
    });

    it('allows a single dispatcher after a rollback, and replaces only an explicitly unused receipt', async () => {
        const grant = await issue(first);
        const seed = randomUUID();
        await first.query('BEGIN');
        try {
            await first.query('SELECT 1 FROM dev_live_budget.grants WHERE grant_id = $1 FOR NO KEY UPDATE', [grant.id]);
            await expect(staged(grant, seed)).rejects.toMatchObject({ code: '57014' });
            expect((await second.query('SELECT 1 FROM dev_live_budget.reservations WHERE reservation_id = $1', [seed])).rowCount).toBe(0);
        } finally {
            await first.query('ROLLBACK');
        }
        const winners = await Promise.allSettled(Array.from({ length: 8 }, () => staged(grant, seed)));
        expect(winners.filter(result => result.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: seed }]);
        expect(await releaseUnused(grant, seed)).toBe(true);
        expect(await releaseUnused(grant, seed)).toBe(true);

        // A second rolled-back generation is still derived from the same committed receipt.
        await first.query('BEGIN');
        try {
            await first.query('SELECT 1 FROM dev_live_budget.grants WHERE grant_id = $1 FOR NO KEY UPDATE', [grant.id]);
            await expect(staged(grant, seed)).rejects.toMatchObject({ code: '57014' });
        } finally {
            await first.query('ROLLBACK');
        }
        const expected = await first.query<{ id: string }>(
            "SELECT md5('dev-live-vertex:' || $1::uuid::text || ':1')::uuid AS id", [seed],
        );
        const replacement = await staged(grant, seed);
        expect(replacement).toBe(expected.rows[0].id);
        await expect(staged(grant, seed)).rejects.toThrow();
        expect(await settle(grant, replacement!, 0)).toBe(true); // e.g. a real 429
        expect(await releaseUnused(grant, replacement!)).toBe(false);
        await expect(staged(grant, seed)).rejects.toThrow();

        const pending = randomUUID();
        const paid = randomUUID();
        expect(await staged(grant, pending)).toBe(pending);
        expect(await staged(grant, paid)).toBe(paid);
        expect(await settle(grant, paid, 50)).toBe(true);
        expect(await settle(grant, paid, 50)).toBe(true);
        await expect(staged(grant, pending)).rejects.toThrow();
        await expect(staged(grant, paid)).rejects.toThrow();
        expect((await first.query(`
            SELECT g.ai_committed_micros, count(*)::int AS receipts,
                count(*) FILTER (WHERE r.actual_micros IS NULL)::int AS pending,
                sum(r.actual_micros)::int AS cost,
                count(*) FILTER (WHERE r.unused_before_dispatch)::int AS unused
            FROM dev_live_budget.grants g JOIN dev_live_budget.reservations r USING (grant_id)
            WHERE g.grant_id = $1 GROUP BY g.grant_id
        `, [grant.id])).rows).toEqual([{ ai_committed_micros: 150, receipts: 4, pending: 1, cost: 50, unused: 1 }]);
    }, 10_000);

    it('keeps existing pending reservations fenced and the new operations service-only', async () => {
        const grant = await issue(first);
        const legacy = randomUUID();
        expect(await reserve(grant, legacy)).toBe(true);
        await expect(staged(grant, legacy)).rejects.toMatchObject({ code: '23505' });
        await expect(releaseUnused(grant, legacy)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        expect((await first.query(`
            SELECT g.ai_committed_micros, r.actual_micros, r.vertex_attempt_key, r.unused_before_dispatch
            FROM dev_live_budget.grants g JOIN dev_live_budget.reservations r USING (grant_id)
            WHERE r.reservation_id = $1
        `, [legacy])).rows).toEqual([{
            ai_committed_micros: 100, actual_micros: null, vertex_attempt_key: null, unused_before_dispatch: false,
        }]);
        expect((await first.query(`
            SELECT r.rolname, count(*) FILTER (WHERE has_function_privilege(r.oid,p.oid,'EXECUTE'))::int AS executable
            FROM pg_roles r CROSS JOIN pg_proc p
            WHERE r.rolname IN ('anon','authenticated','service_role') AND (
                p.pronamespace = 'public'::regnamespace
                AND p.proname IN ('dev_live_budget_reserve_vertex_attempt_v1','dev_live_budget_release_unused_vertex_v1')
                OR p.pronamespace = 'dev_live_budget'::regnamespace AND p.proname IN ('reserve','settle_vertex'))
            GROUP BY r.rolname ORDER BY r.rolname
        `)).rows).toEqual([
            { rolname: 'anon', executable: 0 }, { rolname: 'authenticated', executable: 0 },
            { rolname: 'service_role', executable: 2 },
        ]);
    });

    it('enforces a single exact cap under simultaneous legacy and staged writers', async () => {
        const grant = await issue(first);
        const results = await Promise.all(Array.from({ length: 16 }, async (_, i) => {
            const id = randomUUID();
            if (i % 2 === 0) return (await staged(grant, id, 3_000_000)) !== null;
            const { rows } = await workers.query<{ ok: boolean }>(`
                SELECT public.dev_live_budget_reserve_v1($1, $2, 'infinity', 6000000, 18000000, $3, 'vertex', 3000000) AS ok
            `, [grant.id, grant.approvedAt, id]);
            return rows[0].ok;
        }));
        expect(results.filter(Boolean)).toHaveLength(6);
        expect((await first.query(`
            SELECT g.ai_committed_micros, count(*)::int AS receipts FROM dev_live_budget.grants g
            JOIN dev_live_budget.reservations r USING (grant_id) WHERE g.grant_id = $1 GROUP BY g.grant_id
        `, [grant.id])).rows).toEqual([{ ai_committed_micros: 18_000_000, receipts: 6 }]);
    });
});
