import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from 'pg';
import { expect, it } from 'vitest';
import { ownerGrantFixtureSql, seedOwnerGrantAccount } from './fixtures/owner-grant';

type Grant = { id: string; approvedAt: string };

// Opt in with RUN_DEV_LIVE_BUDGET_POSTGRES_TEST=1 and local initdb/pg_ctl on PATH.
it.runIf(process.env.RUN_DEV_LIVE_BUDGET_POSTGRES_TEST === '1')(
    'fences unpublished grants and revocation, and charges a rolled-back reservation exactly once',
    async () => {
        const directory = mkdtempSync(join(tmpdir(), 'dev-budget-'));
        const cluster = join(directory, 'pg');
        const owner = randomUUID();
        const clientOptions = { host: cluster, port: 5432, user: 'fixture', database: 'postgres' };
        const first = new Client(clientOptions);
        const second = new Client(clientOptions);
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
        try {
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
        } finally {
            await Promise.allSettled([first.end(), second.end()]);
            if (started) execFileSync('pg_ctl', ['-D', cluster, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
            rmSync(directory, { recursive: true, force: true });
        }
    }, 30_000,
);
