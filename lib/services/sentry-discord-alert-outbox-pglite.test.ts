import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../supabase/migrations/20260728130000_add_sentry_discord_alert_outbox.sql', import.meta.url,
), 'utf8');
let db: PGlite;
const DEDUPE_KEY = 'a'.repeat(64);

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS $$
            SELECT pg_catalog.gen_random_uuid()
        $$;
    `);
    await db.exec(migration);
}, 30_000);

afterAll(async () => db.close());

describe('Sentry Discord durable outbox', () => {
    it('deduplicates concurrent retry deliveries and permits exactly one claim at a time', async () => {
        await db.exec('SET ROLE service_role');
        const [first, duplicate] = await Promise.all([
            db.query<{ enqueue_sentry_discord_alert_outbox: boolean }>(
                'SELECT public.enqueue_sentry_discord_alert_outbox($1, $2, clock_timestamp(), $3)',
                [DEDUPE_KEY, 'web-app', 'https://sentry.io/organizations/acme/issues/1234/'],
            ),
            db.query<{ enqueue_sentry_discord_alert_outbox: boolean }>(
                'SELECT public.enqueue_sentry_discord_alert_outbox($1, $2, clock_timestamp(), $3)',
                [DEDUPE_KEY, 'web-app', 'https://sentry.io/organizations/acme/issues/1234/'],
            ),
        ]);
        const [claimOne, claimTwo] = await Promise.all([
            db.query<{ id: string }>('SELECT id FROM public.claim_sentry_discord_alert_outbox(10)'),
            db.query<{ id: string }>('SELECT id FROM public.claim_sentry_discord_alert_outbox(10)'),
        ]);
        await db.exec('RESET ROLE');
        expect(Number(first.rows[0]?.enqueue_sentry_discord_alert_outbox) + Number(duplicate.rows[0]?.enqueue_sentry_discord_alert_outbox)).toBe(1);
        expect(claimOne.rows.length + claimTwo.rows.length).toBe(1);
    }, 30_000);

    it('contains no raw Sentry payload column and uses SKIP LOCKED with bounded retry completion', async () => {
        expect(migration).toContain('FOR UPDATE SKIP LOCKED');
        expect(migration).toContain("attempts <= 3");
        expect(migration).not.toMatch(/raw_payload|request_body|stacktrace/i);
    });

    it('requeues a stale sending lease for a bounded retry instead of stranding it', async () => {
        await db.exec(`
            UPDATE public.sentry_discord_alert_outbox
            SET claimed_at = clock_timestamp() - interval '10 minutes'
            WHERE dedupe_key = '${DEDUPE_KEY}';
            SET ROLE service_role;
        `);
        const recovered = await db.query<{ reconcile_stale_sentry_discord_alert_claims: number }>(
            'SELECT public.reconcile_stale_sentry_discord_alert_claims(60)',
        );
        const claimedAgain = await db.query<{ id: string }>('SELECT id FROM public.claim_sentry_discord_alert_outbox(1)');
        await db.exec('RESET ROLE');
        expect(recovered.rows[0]?.reconcile_stale_sentry_discord_alert_claims).toBe(1);
        expect(claimedAgain.rows).toHaveLength(1);
    });
});
