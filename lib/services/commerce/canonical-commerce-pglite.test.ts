import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

function migrationSql(): string {
    const migration = readdirSync(join(process.cwd(), 'supabase/migrations'))
        .filter(name => name.endsWith('_add_commerce_operation_canonical_tables.sql'))
        .sort();
    if (migration.length !== 1) {
        throw new Error(
            `Expected one generated commerce migration, found ${migration.length}`,
        );
    }
    return readFileSync(
        join(process.cwd(), 'supabase/migrations', migration[0]),
        'utf8',
    );
}

describe('commerce canonical SQL smoke contract', () => {
    it('can execute the immutable guard shape in disposable PostgreSQL syntax', async () => {
        const db = new PGlite();
        await db.exec(`
            CREATE TABLE canonical_probe (id integer PRIMARY KEY, value text NOT NULL);
            CREATE FUNCTION reject_probe_mutation()
            RETURNS trigger
            LANGUAGE plpgsql
            AS $$ BEGIN RAISE EXCEPTION 'APPEND_ONLY'; END; $$;
            CREATE TRIGGER canonical_probe_immutable
            BEFORE UPDATE OR DELETE ON canonical_probe
            FOR EACH ROW EXECUTE FUNCTION reject_probe_mutation();
        `);
        await db.exec('INSERT INTO canonical_probe VALUES (1, \'ok\')');
        await expect(db.exec("UPDATE canonical_probe SET value = 'nope'"))
            .rejects.toThrow('APPEND_ONLY');
        await db.close();
    });

    it('contains the PostgreSQL constructs that the disposable smoke test protects', () => {
        const sql = migrationSql();
        expect(sql).toContain('CREATE TRIGGER payment_events_immutable');
        expect(sql).toContain('CREATE TRIGGER account_lifecycle_immutable');
        expect(sql).toContain('CREATE TRIGGER system_configuration_immutable');
        expect(sql).toContain('CREATE INDEX payment_events_order_recorded_idx');
        expect(sql).toContain('CREATE INDEX maintenance_jobs_recovery_idx');
    });

    it('executes the additive migration against disposable PostgreSQL with only legacy table stubs', async () => {
        const db = new PGlite();
        const sql = migrationSql()
            .replace(/^REVOKE[^;]*;\n?/gm, '')
            .replace(/^GRANT[^;]*;\n?/gm, '');
        await db.exec(`
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS uuid
            LANGUAGE SQL
            AS 'SELECT pg_catalog.gen_random_uuid()';
            CREATE TABLE public.users(id uuid PRIMARY KEY);
            CREATE TABLE public.earlybird_orders(id uuid PRIMARY KEY);
            CREATE TABLE public.analysis_requests(id uuid PRIMARY KEY);
        `);
        await db.exec(sql);
        const result = await db.query<{ relname: string; relforcerowsecurity: boolean }>(`
            SELECT c.relname, c.relforcerowsecurity
            FROM pg_catalog.pg_class AS c
            JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relname IN (
                'payment_events', 'fulfillment_jobs', 'notification_outbox',
                'account_lifecycle', 'system_configuration', 'system_leases',
                'maintenance_jobs'
              )
            ORDER BY c.relname
        `);
        expect(result.rows).toHaveLength(7);
        expect(result.rows.every(row => row.relforcerowsecurity)).toBe(true);
        await db.close();
    });

    it('executes payment dedupe, monotonic fulfillment, and bounded claim/finish contracts', async () => {
        const db = new PGlite();
        const sql = migrationSql()
            .replace(/^REVOKE[^;]*;\n?/gm, '')
            .replace(/^GRANT[^;]*;\n?/gm, '');
        await db.exec(`
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS uuid
            LANGUAGE SQL
            AS 'SELECT pg_catalog.gen_random_uuid()';
            CREATE TABLE public.users(id uuid PRIMARY KEY);
            CREATE TABLE public.earlybird_orders(id uuid PRIMARY KEY);
            CREATE TABLE public.analysis_requests(id uuid PRIMARY KEY);
            INSERT INTO public.earlybird_orders VALUES ('123e4567-e89b-42d3-a456-426614174000');
        `);
        await db.exec(sql);

        const eventArgs = [
            'event-1', 'idempotency-1', 'payment.completed', 'merchant-1',
            '123e4567-e89b-42d3-a456-426614174000', 'groble', 'accepted',
            'a'.repeat(64), JSON.stringify({ amount_krw: 0 }),
            '2026-09-09T00:00:00Z', 0,
        ];
        await expect(db.query(
            `SELECT public.record_payment_event_v1($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz,$11::integer)`,
            eventArgs,
        )).resolves.toMatchObject({ rows: [{ record_payment_event_v1: { status: 'recorded', duplicate: false } }] });
        await expect(db.query(
            `SELECT public.record_payment_event_v1($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz,$11::integer)`,
            eventArgs,
        )).resolves.toMatchObject({ rows: [{ record_payment_event_v1: { status: 'recorded', duplicate: true } }] });
        await expect(db.query(
            `SELECT public.record_payment_event_v1($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz,$11::integer)`,
            [...eventArgs.slice(0, 1), 'idempotency-conflict', ...eventArgs.slice(2)],
        )).rejects.toThrow('PAYMENT_EVENT_IDEMPOTENCY_CONFLICT');

        await expect(db.query(
            `SELECT public.upsert_fulfillment_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
            ['123e4567-e89b-42d3-a456-426614174000', null, 'analysis_in_progress', 1, 2, null, null, '2026-09-09T00:00:00Z', null, '{}'],
        )).resolves.toMatchObject({ rows: [{ upsert_fulfillment_job_v1: expect.objectContaining({ state: 'analysis_in_progress', lease_generation: 2 }) }] });
        await expect(db.query(
            `SELECT public.upsert_fulfillment_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
            ['123e4567-e89b-42d3-a456-426614174000', null, 'admission_pending', 0, 2, null, null, '2026-09-09T00:00:00Z', null, '{}'],
        )).rejects.toThrow('FULFILLMENT_JOB_MONOTONIC_CONFLICT');

        await db.query(
            `SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5)`,
            ['kakao', 'signup', 'dedupe-1', '{}', 'b'.repeat(64)],
        );
        const claimed = await db.query<{
            id: string;
            lease_token: string;
            lease_generation: number;
        }>(
            `SELECT id, lease_token, lease_generation FROM public.claim_notification_outbox_v1($1,$2,$3)`,
            [1, 'c'.repeat(64), 60],
        );
        expect(claimed.rows).toHaveLength(1);
        await expect(db.query(
            `SELECT public.finish_notification_outbox_v1($1,$2,$3,$4,$5,$6)`,
            [claimed.rows[0].id, claimed.rows[0].lease_token, claimed.rows[0].lease_generation, 'sent', null, 0],
        )).resolves.toMatchObject({ rows: [{ finish_notification_outbox_v1: { status: 'sent' } }] });

        await db.query(
            `SELECT public.enqueue_maintenance_job_v1($1,$2,$3::jsonb,$4)`,
            ['recovery', 'd'.repeat(64), '{}', 'e'.repeat(64)],
        );
        const maintenance = await db.query<{
            id: string;
            lease_token: string;
            lease_generation: number;
        }>(
            `SELECT id, lease_token, lease_generation FROM public.claim_maintenance_jobs_v1($1,$2,$3)`,
            [1, 'f'.repeat(64), 60],
        );
        expect(maintenance.rows).toHaveLength(1);
        await expect(db.query(
            `SELECT public.finish_maintenance_job_v1($1,$2,$3,$4,$5,$6)`,
            [maintenance.rows[0].id, maintenance.rows[0].lease_token, maintenance.rows[0].lease_generation, 'succeeded', null, 0],
        )).resolves.toMatchObject({ rows: [{ finish_maintenance_job_v1: { status: 'succeeded' } }] });
        await db.close();
    });
});
