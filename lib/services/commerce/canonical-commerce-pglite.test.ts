import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { describe, expect, it } from 'vitest';
import { canonicalJson, canonicalJsonHash } from './canonical-commerce-store';

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
        const db = await PGlite.create({ extensions: { pgcrypto } });
        const sql = migrationSql()
            .replace(/^REVOKE[^;]*;\n?/gm, '')
            .replace(/^GRANT[^;]*;\n?/gm, '');
        await db.exec(`
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS uuid
            LANGUAGE SQL
            AS 'SELECT pg_catalog.gen_random_uuid()';
            CREATE FUNCTION extensions.digest(data bytea, algorithm text)
            RETURNS bytea
            LANGUAGE SQL
            AS 'SELECT pg_catalog.sha256(data)';
            CREATE TABLE public.users(id uuid PRIMARY KEY);
            CREATE TABLE public.earlybird_orders(id uuid PRIMARY KEY);
            CREATE TABLE public.analysis_requests(id uuid PRIMARY KEY);
            INSERT INTO public.earlybird_orders VALUES ('123e4567-e89b-42d3-a456-426614174000');
            INSERT INTO public.analysis_requests VALUES ('223e4567-e89b-42d3-a456-426614174000');
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
            ['123e4567-e89b-42d3-a456-426614174000', '223e4567-e89b-42d3-a456-426614174000', 'analysis_in_progress', 1, 2, null, null, '2026-09-09T00:00:00Z', null, '{}'],
        )).resolves.toMatchObject({ rows: [{ upsert_fulfillment_job_v1: expect.objectContaining({ state: 'analysis_in_progress', lease_generation: 2 }) }] });
        await expect(db.query(
            `SELECT public.upsert_fulfillment_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
            ['123e4567-e89b-42d3-a456-426614174000', null, 'admission_pending', 0, 2, null, null, '2026-09-09T00:00:00Z', null, '{}'],
        )).rejects.toThrow('FULFILLMENT_JOB_MONOTONIC_CONFLICT');

        await expect(db.query(
            `SELECT public.upsert_fulfillment_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
            ['123e4567-e89b-42d3-a456-426614174000', '223e4567-e89b-42d3-a456-426614174000', 'completed', 1, 3, null, null, '2026-09-09T00:00:00Z', null, '{}'],
        )).resolves.toMatchObject({ rows: [{ upsert_fulfillment_job_v1: expect.objectContaining({ state: 'completed', lease_generation: 3 }) }] });
        await expect(db.query(
            `SELECT public.upsert_fulfillment_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
            ['123e4567-e89b-42d3-a456-426614174000', null, 'manual_review', 1, 4, null, null, '2026-09-09T00:00:00Z', null, '{}'],
        )).rejects.toThrow('FULFILLMENT_JOB_MONOTONIC_CONFLICT');
        await expect(db.query(
            `SELECT public.upsert_fulfillment_job_v1($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)`,
            ['123e4567-e89b-42d3-a456-426614174000', '223e4567-e89b-42d3-a456-426614174000', 'retryable_failure', 2, 4, null, null, '2026-09-09T00:00:00Z', 'RETRYABLE', '{}'],
        )).rejects.toThrow('FULFILLMENT_JOB_MONOTONIC_CONFLICT');

        const raceOrderId = '323e4567-e89b-42d3-a456-426614174000';
        const raceRequestId = '423e4567-e89b-42d3-a456-426614174000';
        await db.query(`INSERT INTO public.earlybird_orders VALUES ($1)`, [raceOrderId]);
        await db.query(`INSERT INTO public.analysis_requests VALUES ($1)`, [raceRequestId]);
        const upsertRace = () => db.query(
            `SELECT public.upsert_fulfillment_job_v1($1::uuid,$2::uuid,'analysis_in_progress',1::smallint,0::bigint,NULL::uuid,NULL::timestamptz,'2026-09-09T00:00:00Z'::timestamptz,NULL::text,'{}'::jsonb)`,
            [raceOrderId, raceRequestId],
        );
        const raceResults = await Promise.allSettled([upsertRace(), upsertRace()]);
        expect(raceResults.every(result => result.status === 'fulfilled')).toBe(true);
        const raceRows = await db.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM public.fulfillment_jobs WHERE order_id = $1`,
            [raceOrderId],
        );
        expect(raceRows.rows[0]?.count).toBe(1);
        await expect(db.query(
            `SELECT public.upsert_fulfillment_job_v1($1::uuid,$2::uuid,'analysis_in_progress',1::smallint,0::bigint,NULL::uuid,NULL::timestamptz,'2026-09-09T00:00:00Z'::timestamptz,NULL::text,'{}'::jsonb)`,
            [raceOrderId, '523e4567-e89b-42d3-a456-426614174000'],
        )).rejects.toThrow('FULFILLMENT_JOB_REQUEST_CONFLICT');

        const [concurrentEnqueueOne, concurrentEnqueueTwo] = await Promise.all([
            db.query<{ enqueue_notification_v1: { duplicate: boolean } }>(
                `SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5)`,
                ['kakao', 'signup', 'dedupe-race', '{}', 'a'.repeat(64)],
            ),
            db.query<{ enqueue_notification_v1: { duplicate: boolean } }>(
                `SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5)`,
                ['kakao', 'signup', 'dedupe-race', '{}', 'a'.repeat(64)],
            ),
        ]);
        expect([
            concurrentEnqueueOne.rows[0].enqueue_notification_v1.duplicate,
            concurrentEnqueueTwo.rows[0].enqueue_notification_v1.duplicate,
        ].sort()).toEqual([false, true]);
        const [concurrentClaimOne, concurrentClaimTwo] = await Promise.all([
            db.query(`SELECT id FROM public.claim_notification_outbox_v1($1,$2,$3)`, [1, 'c'.repeat(64), 60]),
            db.query(`SELECT id FROM public.claim_notification_outbox_v1($1,$2,$3)`, [1, 'd'.repeat(64), 60]),
        ]);
        expect(concurrentClaimOne.rows.length + concurrentClaimTwo.rows.length).toBe(1);
        await db.query(
            `SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5)`,
            ['kakao', 'signup', 'dedupe-1', '{}', 'b'.repeat(64)],
        );
        const claimed = await db.query<{
            id: string;
            lease_token: string;
            lease_generation: number;
            lease_expires_at: string;
        }>(
            `SELECT id, lease_token, lease_generation, lease_expires_at FROM public.claim_notification_outbox_v1($1,$2,$3)`,
            [1, 'c'.repeat(64), 60],
        );
        expect(claimed.rows).toHaveLength(1);
        expect(claimed.rows[0].lease_expires_at).toBeTruthy();
        await expect(db.query(
            `SELECT public.finish_notification_outbox_v1($1,$2,$3,$4,$5,$6)`,
            [claimed.rows[0].id, claimed.rows[0].lease_token, claimed.rows[0].lease_generation, 'sent', null, 0],
        )).resolves.toMatchObject({ rows: [{ finish_notification_outbox_v1: { status: 'sent' } }] });
        await expect(db.query(
            `SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5)`,
            ['kakao', 'signup', 'dedupe-1', '{}', 'b'.repeat(64)],
        )).resolves.toMatchObject({ rows: [{ enqueue_notification_v1: { status: 'sent', duplicate: true } }] });

        await db.query(
            `SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5)`,
            ['kakao', 'signup', 'dedupe-dead', '{}', 'c'.repeat(64)],
        );
        const dead = await db.query<{ id: string; lease_token: string; lease_generation: number }>(
            `SELECT id, lease_token, lease_generation FROM public.claim_notification_outbox_v1($1,$2,$3)`,
            [1, 'c'.repeat(64), 60],
        );
        await db.query(
            `SELECT public.finish_notification_outbox_v1($1,$2,$3,$4,$5,$6)`,
            [dead.rows[0].id, dead.rows[0].lease_token, dead.rows[0].lease_generation, 'dead', 'DELIVERY_FAILED', 0],
        );
        await expect(db.query(
            `SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5,$6)`,
            ['kakao', 'signup', 'dedupe-dead', '{}', 'c'.repeat(64), true],
        )).resolves.toMatchObject({ rows: [{ enqueue_notification_v1: { status: 'queued', duplicate: true } }] });

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
        await expect(db.query(
            `SELECT public.enqueue_maintenance_job_v1($1,$2,$3::jsonb,$4)`,
            ['recovery', 'd'.repeat(64), '{}', 'e'.repeat(64)],
        )).resolves.toMatchObject({ rows: [{ enqueue_maintenance_job_v1: { status: 'succeeded', duplicate: true } }] });

        await db.query(
            `SELECT public.enqueue_maintenance_job_v1($1,$2,$3::jsonb,$4)`,
            ['replay', '1'.repeat(64), '{}', '2'.repeat(64)],
        );
        const blocked = await db.query<{ id: string; lease_token: string; lease_generation: number }>(
            `SELECT id, lease_token, lease_generation FROM public.claim_maintenance_jobs_v1($1,$2,$3)`,
            [1, 'f'.repeat(64), 60],
        );
        await db.query(
            `SELECT public.finish_maintenance_job_v1($1,$2,$3,$4,$5,$6)`,
            [blocked.rows[0].id, blocked.rows[0].lease_token, blocked.rows[0].lease_generation, 'blocked', 'MANUAL_REVIEW', 0],
        );
        await expect(db.query(
            `SELECT public.enqueue_maintenance_job_v1($1,$2,$3::jsonb,$4,$5)`,
            ['replay', '1'.repeat(64), '{}', '2'.repeat(64), true],
        )).resolves.toMatchObject({ rows: [{ enqueue_maintenance_job_v1: { status: 'queued', duplicate: true } }] });
        await db.close();
    });

    it('rejects empty or non-derived configuration content and bounds stale reconciliation', async () => {
        const db = await PGlite.create({ extensions: { pgcrypto } });
        const sql = migrationSql()
            .replace(/^REVOKE[^;]*;\n?/gm, '')
            .replace(/^GRANT[^;]*;\n?/gm, '');
        await db.exec(`
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS uuid LANGUAGE SQL
            AS 'SELECT pg_catalog.gen_random_uuid()';
            CREATE FUNCTION extensions.digest(data bytea, algorithm text)
            RETURNS bytea LANGUAGE SQL
            AS 'SELECT pg_catalog.sha256(data)';
            CREATE TABLE public.users(id uuid PRIMARY KEY);
            CREATE TABLE public.earlybird_orders(id uuid PRIMARY KEY);
            CREATE TABLE public.analysis_requests(id uuid PRIMARY KEY);
        `);
        await db.exec(sql);

        await expect(db.query(
            `SELECT public.record_system_configuration_v1($1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
            ['analysis.policy', 1, 'draft', '{}', 'a'.repeat(64), null],
        )).rejects.toThrow('SYSTEM_CONFIGURATION_INPUT_INVALID');
        await expect(db.query(
            `SELECT public.record_system_configuration_v1($1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
            ['analysis.policy', 1, 'draft', '{"maxAttempts":3}', 'a'.repeat(64), null],
        )).rejects.toThrow('SYSTEM_CONFIGURATION_HASH_INVALID');
        const expected = await db.query<{ hash: string }>(`
            SELECT encode(extensions.digest(
                convert_to('system-configuration' || chr(10) || public.canonical_system_configuration_json('{"maxAttempts":3}'::jsonb), 'UTF8'),
                'sha256'
            ), 'hex') AS hash
        `);
        await expect(db.query(
            `SELECT public.record_system_configuration_v1($1,$2,$3,$4::jsonb,$5,$6::timestamptz)`,
            ['analysis.policy', 1, 'draft', '{"maxAttempts":3}', expected.rows[0].hash, null],
        )).resolves.toMatchObject({ rows: [{ record_system_configuration_v1: { status: 'recorded', duplicate: false } }] });

        await db.query(`SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5)`, ['kakao', 'signup', 'stale-1', '{}', 'b'.repeat(64)]);
        await db.query(`SELECT public.enqueue_notification_v1($1,$2,$3,$4::jsonb,$5)`, ['kakao', 'signup', 'stale-2', '{}', 'c'.repeat(64)]);
        await db.query(`UPDATE public.notification_outbox SET state='leased', lease_token=extensions.gen_random_uuid(), lease_expires_at=clock_timestamp() - interval '1 second'`);
        const reconciled = await db.query<{
            reconcile_stale_notification_outbox_v1: { status: string; count: number };
        }>(`SELECT public.reconcile_stale_notification_outbox_v1(1)`);
        expect(reconciled.rows[0].reconcile_stale_notification_outbox_v1).toMatchObject({ status: 'reconciled', count: 1 });
        const remaining = await db.query<{ state: string }>(`SELECT state FROM public.notification_outbox ORDER BY dedupe_key`);
        expect(remaining.rows.filter(row => row.state === 'leased')).toHaveLength(1);

        await db.query(`SELECT public.enqueue_maintenance_job_v1($1,$2,$3::jsonb,$4)`, ['cleanup', '3'.repeat(64), '{}', '4'.repeat(64)]);
        await db.query(`SELECT public.enqueue_maintenance_job_v1($1,$2,$3::jsonb,$4)`, ['cleanup', '5'.repeat(64), '{}', '6'.repeat(64)]);
        await db.query(`UPDATE public.maintenance_jobs SET state='leased', lease_token=extensions.gen_random_uuid(), lease_expires_at=clock_timestamp() - interval '1 second'`);
        const maintenanceReconciled = await db.query<{
            reconcile_stale_maintenance_jobs_v1: { status: string; count: number };
        }>(`SELECT public.reconcile_stale_maintenance_jobs_v1(1)`);
        expect(maintenanceReconciled.rows[0].reconcile_stale_maintenance_jobs_v1).toMatchObject({ status: 'reconciled', count: 1 });
        const maintenanceRemaining = await db.query<{ state: string }>(`SELECT state FROM public.maintenance_jobs WHERE state = 'leased'`);
        expect(maintenanceRemaining.rows).toHaveLength(1);
        await db.close();
    });

    it('reproduces the TypeScript canonical bytes across whitespace, key order, and Unicode', async () => {
        const db = await PGlite.create({ extensions: { pgcrypto } });
        const sql = migrationSql()
            .replace(/^REVOKE[^;]*;\n?/gm, '')
            .replace(/^GRANT[^;]*;\n?/gm, '');
        await db.exec(`
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS uuid LANGUAGE SQL
            AS 'SELECT pg_catalog.gen_random_uuid()';
            CREATE FUNCTION extensions.digest(data bytea, algorithm text)
            RETURNS bytea LANGUAGE SQL
            AS 'SELECT pg_catalog.sha256(data)';
            CREATE TABLE public.users(id uuid PRIMARY KEY);
            CREATE TABLE public.earlybird_orders(id uuid PRIMARY KEY);
            CREATE TABLE public.analysis_requests(id uuid PRIMARY KEY);
        `);
        await db.exec(sql);

        const vectors = [
            {
                json: '{ "z": "홍\\n길동 😀", "a": { "\ud83d\ude00": "따뜻함", "가": "값" }, "list": [true, null, "a\\\"b"] }',
                value: {
                    z: '홍\n길동 😀',
                    a: { '😀': '따뜻함', '가': '값' },
                    list: [true, null, 'a"b'],
                },
            },
            {
                json: '{"list":["é","한글"],"a":{"가":"값","😀":"따뜻함"},"z":"홍\\n길동 😀"}',
                value: {
                    list: ['é', '한글'],
                    a: { '가': '값', '😀': '따뜻함' },
                    z: '홍\n길동 😀',
                },
            },
            {
                json: '{"huge":1e21,"large":100000000000000000000,"small":0.000001,"tiny":1e-7,"fraction":1.2300,"negative":-0,"precision":0.30000000000000004,"long":1.2345678901234567,"oddLarge":1000000000000000100}',
                value: {
                    huge: 1e21,
                    large: 1e20,
                    small: 0.000001,
                    tiny: 1e-7,
                    fraction: 1.23,
                    negative: -0,
                    precision: 0.30000000000000004,
                    long: 1.2345678901234567,
                    oddLarge: 1000000000000000100,
                },
            },
            {
                json: '{"10":"ten","2":"two","a":"A"}',
                value: { '10': 'ten', '2': 'two', a: 'A' },
            },
        ] as const;
        for (const vector of vectors) {
            const result = await db.query<{ canonical: string; hash: string }>(
                `SELECT public.canonical_system_configuration_json($1::jsonb) AS canonical,
                        public.canonical_json_hash_v1($2, $1::jsonb) AS hash`,
                [vector.json, 'system-configuration'],
            );
            expect(result.rows[0].canonical).toBe(canonicalJson(vector.value));
            expect(result.rows[0].hash).toBe(canonicalJsonHash('system-configuration', vector.value));
        }
        await db.close();
    });

    it('compares legacy notification family content through a bounded SQL reader', async () => {
        const db = await PGlite.create({ extensions: { pgcrypto } });
        const sql = migrationSql()
            .replace(/^REVOKE[^;]*;\n?/gm, '')
            .replace(/^GRANT[^;]*;\n?/gm, '');
        await db.exec(`
            CREATE SCHEMA extensions;
            CREATE FUNCTION extensions.gen_random_uuid()
            RETURNS uuid LANGUAGE SQL
            AS 'SELECT pg_catalog.gen_random_uuid()';
            CREATE FUNCTION extensions.digest(data bytea, algorithm text)
            RETURNS bytea LANGUAGE SQL
            AS 'SELECT pg_catalog.sha256(data)';
            CREATE TABLE public.users(id uuid PRIMARY KEY);
            CREATE TABLE public.earlybird_orders(
                id uuid PRIMARY KEY,
                plan_id text,
                actual_amount_krw integer,
                paid_at timestamptz
            );
            CREATE TABLE public.analysis_requests(id uuid PRIMARY KEY);
            CREATE TABLE public.earlybird_payment_discord_outbox(order_id uuid);
            CREATE TABLE public.kakao_signup_discord_outbox(
                user_id uuid,
                masked_name text,
                birthyear char(4),
                gender text,
                signed_up_at timestamptz,
                attribution_origin text
            );
            CREATE TABLE public.sentry_discord_alert_outbox(
                dedupe_key char(64),
                project_slug text,
                occurred_at timestamptz,
                issue_url text,
                issue_short_id text,
                error_type text,
                release text
            );
            INSERT INTO public.earlybird_orders VALUES ('123e4567-e89b-42d3-a456-426614174000', 'basic', 990, '2026-09-09T00:00:00Z');
            INSERT INTO public.earlybird_payment_discord_outbox VALUES ('123e4567-e89b-42d3-a456-426614174000');
            INSERT INTO public.kakao_signup_discord_outbox VALUES ('223e4567-e89b-42d3-a456-426614174000', '홍*동', '1990', '남성', '2026-09-09T00:00:00Z', 'https://example.com/');
            INSERT INTO public.sentry_discord_alert_outbox VALUES ('${'a'.repeat(64)}', 'yeosachin', '2026-09-09T00:00:00Z', 'https://sentry.io/organizations/example/issues/1/', 'YEOSA-1', 'Error', '2026.09.09');
        `);
        await db.exec(sql);
        const rows = await db.query<{
            dedupe_key: string;
            channel: string;
            event_kind: string;
            payload: Record<string, unknown>;
            content_hash: string;
        }>(`SELECT * FROM public.list_notification_legacy_outbox_v1(10)`);
        expect(rows.rows).toHaveLength(3);
        expect(rows.rows.map(row => row.channel).sort()).toEqual(['discord', 'kakao', 'sentry']);
        expect(rows.rows.every(row => Object.keys(row.payload).length > 0 && /^[a-f0-9]{64}$/.test(row.content_hash))).toBe(true);
        const payment = rows.rows.find(row => row.channel === 'discord');
        expect(payment?.content_hash).toBe(canonicalJsonHash(
            'payment-discord-content',
            {
                order_id: '123e4567-e89b-42d3-a456-426614174000',
                plan_id: 'basic',
                amount_krw: 990,
                paid_at: '2026-09-09T00:00:00.000Z',
            },
        ));
        const kakao = rows.rows.find(row => row.channel === 'kakao');
        const kakaoPayload = {
            user_id: '223e4567-e89b-42d3-a456-426614174000',
            masked_name: '홍*동',
            birthyear: '1990',
            gender: '남성',
            signed_up_at: '2026-09-09T00:00:00.000Z',
            attribution_origin: 'https://example.com/',
        };
        expect(kakao?.dedupe_key).toBe(`kakao-signup:${canonicalJsonHash('kakao-signup-key', kakaoPayload.user_id)}`);
        expect(kakao?.content_hash).toBe(canonicalJsonHash('kakao-signup-content', kakaoPayload));
        const sentry = rows.rows.find(row => row.channel === 'sentry');
        const sentryKeyHash = canonicalJsonHash('sentry-dedupe-key', 'a'.repeat(64));
        const sentryPayload = {
            dedupe_key_hash: sentryKeyHash,
            project_slug: 'yeosachin',
            occurred_at: '2026-09-09T00:00:00.000Z',
            issue_url: 'https://sentry.io/organizations/example/issues/1/',
            issue_short_id: 'YEOSA-1',
            error_type: 'Error',
            release: '2026.09.09',
        };
        expect(sentry?.dedupe_key).toBe(`sentry:${sentryKeyHash}`);
        expect(sentry?.content_hash).toBe(canonicalJsonHash('sentry-notification-content', sentryPayload));
        await db.close();
    });
});
