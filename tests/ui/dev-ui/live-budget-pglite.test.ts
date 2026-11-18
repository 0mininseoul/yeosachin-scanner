import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

let db: PGlite;
const grantArguments = '$1::uuid, $2::timestamptz, $3::timestamptz, $4::integer, $5::integer';

function approval() {
    const now = Date.now();
    return [randomUUID(), new Date(now - 1_000).toISOString(), new Date(now + 600_000).toISOString(), 500_000, 200_000];
}

async function check(grant: ReturnType<typeof approval>) {
    const result = await db.query<{ version: number }>(
        `SELECT public.dev_live_budget_check_v1(${grantArguments}) AS version`, grant,
    );
    return result.rows[0].version;
}

async function reserve(grant: ReturnType<typeof approval>, id: string, provider: string, amount: number) {
    const result = await db.query<{ reserved: boolean }>(
        `SELECT public.dev_live_budget_reserve_v1(${grantArguments}, $6, $7, $8) AS reserved`,
        [...grant, id, provider, amount],
    );
    return result.rows[0].reserved;
}

async function settle(grant: ReturnType<typeof approval>, id: string, amount: number) {
    const result = await db.query<{ settled: boolean }>(
        'SELECT public.dev_live_budget_settle_vertex_v1($1, $2, $3) AS settled',
        [grant[0], id, amount],
    );
    return result.rows[0].settled;
}

describe('Dev live provider budget SQL', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role');
        const sql = await readFile(new URL('../../../supabase/dev-ui/live-budget.sql', import.meta.url), 'utf8');
        await db.exec(sql);
        await db.exec(sql);
    });

    beforeEach(async () => {
        await db.exec('TRUNCATE dev_live_budget.reservations, dev_live_budget.grants');
    });

    afterAll(async () => { await db?.close(); });

    it('exposes only service-role functions and does not create a grant from the read probe', async () => {
        const { rows } = await db.query<{ can_execute: boolean; can_read: boolean }>(`
            SELECT has_function_privilege(rolname, pg_proc.oid, 'EXECUTE') AS can_execute,
                   has_table_privilege(rolname, 'dev_live_budget.grants', 'SELECT') AS can_read
            FROM pg_roles CROSS JOIN pg_proc
            WHERE rolname IN ('anon', 'authenticated', 'service_role') AND proname LIKE 'dev_live_budget_%'
            ORDER BY rolname, proname
        `);
        expect(rows.map(row => row.can_execute)).toEqual([false, false, false, false, false, false, true, true, true]);
        expect(rows.every(row => !row.can_read)).toBe(true);
        await db.exec('SET ROLE service_role');
        try {
            await expect(check(approval())).resolves.toBe(1);
            await expect(db.query('SELECT 1 FROM dev_live_budget.grants')).rejects.toThrow('permission denied');
        } finally {
            await db.exec('RESET ROLE');
        }
        expect((await db.query('SELECT 1 FROM dev_live_budget.grants')).rows).toHaveLength(0);
    });

    it('bounds cumulative starts independently by provider and denies duplicate dispatch authority', async () => {
        const grant = approval();
        const first = randomUUID();
        await expect(reserve(grant, first, 'apify', 200_000)).resolves.toBe(true);
        await expect(reserve(grant, first, 'apify', 200_000)).rejects.toThrow('duplicate key');
        const attempts = await Promise.all([200_000, 100_000, 200_000].map(amount => (
            reserve(grant, randomUUID(), 'apify', amount)
        )));
        expect(attempts).toEqual([true, true, false]);
        await expect(reserve(grant, randomUUID(), 'vertex', 200_000)).resolves.toBe(true);
        await expect(reserve(grant, randomUUID(), 'vertex', 1)).resolves.toBe(false);
        await expect(settle(grant, first, 0)).rejects.toThrow();
        await expect(reserve(grant, randomUUID(), 'apify', 1)).resolves.toBe(false);
    });

    it('releases only confirmed Vertex cost once and freezes the grant on a conflicting settlement', async () => {
        const grant = approval();
        const first = randomUUID();
        await expect(reserve(grant, first, 'vertex', 180_000)).resolves.toBe(true);
        await expect(reserve(grant, randomUUID(), 'vertex', 30_000)).resolves.toBe(false);
        await expect(settle(grant, first, 20_000)).resolves.toBe(true);
        await expect(settle(grant, first, 20_000)).resolves.toBe(true);
        await expect(reserve(grant, randomUUID(), 'vertex', 180_000)).resolves.toBe(true);
        await expect(reserve(grant, randomUUID(), 'vertex', 1)).resolves.toBe(false);
        await expect(settle(grant, first, 15_000)).resolves.toBe(false);
        await expect(check(grant)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve(grant, randomUUID(), 'apify', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
    });

    it('rejects expired grants, modified caps, and a second overlapping grant', async () => {
        const expired = approval();
        expired[2] = new Date(Date.now() - 100).toISOString();
        await expect(check(expired)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        const grant = approval();
        await expect(reserve(grant, randomUUID(), 'apify', 1)).resolves.toBe(true);
        grant[3] = 1_000_000;
        await expect(check(grant)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        await expect(reserve(approval(), randomUUID(), 'vertex', 1)).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
    });
});
