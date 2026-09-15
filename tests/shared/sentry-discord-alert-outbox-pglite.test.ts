import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../supabase/migrations/20260728140000_add_sentry_discord_alert_outbox.sql', import.meta.url,
), 'utf8');
const summaryMigration = readFileSync(new URL(
    '../../supabase/migrations/20260728190000_add_sentry_discord_safe_issue_summary.sql', import.meta.url,
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
    await db.exec(summaryMigration);
}, 30_000);

afterAll(async () => db.close());

describe('Sentry Discord durable outbox', () => {
    it('deduplicates concurrent retry deliveries and permits exactly one claim at a time', async () => {
        await db.exec('SET ROLE service_role');
        const [first, duplicate] = await Promise.all([
            db.query<{ enqueue_sentry_discord_alert_outbox: boolean }>(
                'SELECT public.enqueue_sentry_discord_alert_outbox($1, $2, clock_timestamp(), $3, $4, $5, $6)',
                [DEDUPE_KEY, 'web-app', 'https://sentry.io/organizations/acme/issues/1234/', 'WEB-1234', 'TypeError', 'v1.2.3'],
            ),
            db.query<{ enqueue_sentry_discord_alert_outbox: boolean }>(
                'SELECT public.enqueue_sentry_discord_alert_outbox($1, $2, clock_timestamp(), $3, $4, $5, $6)',
                [DEDUPE_KEY, 'web-app', 'https://sentry.io/organizations/acme/issues/1234/', 'WEB-1234', 'TypeError', 'v1.2.3'],
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

    it('rejects oversized error/release values and UUID-shaped releases at the RPC boundary', async () => {
        const oversizedType = `TypeError${'A'.repeat(121)}`;
        const oversizedRelease = `v${'1'.repeat(80)}`;
        const uuidRelease = '123e4567-e89b-42d3-a456-426614174000';
        await db.exec('SET ROLE service_role');
        for (const [key, errorType, release] of [
            ['d'.repeat(64), oversizedType, 'v1.2.3'],
            ['e'.repeat(64), 'TypeError', oversizedRelease],
            ['f'.repeat(64), 'TypeError', uuidRelease],
        ]) {
            await db.query(
                'SELECT public.enqueue_sentry_discord_alert_outbox($1, $2, clock_timestamp(), $3, $4, $5, $6)',
                [key, 'web-app', null, 'WEB-1234', errorType, release],
            );
        }
        await db.exec('RESET ROLE');
        const summaries = await db.query<{ dedupe_key: string; error_type: string | null; release: string | null }>(
            `SELECT dedupe_key, error_type, release FROM public.sentry_discord_alert_outbox
             WHERE dedupe_key IN ('${'d'.repeat(64)}', '${'e'.repeat(64)}', '${'f'.repeat(64)}')
             ORDER BY dedupe_key`,
        );
        expect(summaries.rows).toEqual([
            { dedupe_key: 'd'.repeat(64), error_type: null, release: 'v1.2.3' },
            { dedupe_key: 'e'.repeat(64), error_type: 'TypeError', release: null },
            { dedupe_key: 'f'.repeat(64), error_type: 'TypeError', release: null },
        ]);
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

    it('terminalizes a stale claim once the durable pre-send fence was recorded', async () => {
        const claimed = await db.query<{ id: string; claim_token: string }>(
            'SELECT id, claim_token FROM public.sentry_discord_alert_outbox WHERE dedupe_key = $1', [DEDUPE_KEY],
        );
        await db.exec('SET ROLE service_role');
        const marked = await db.query<{ mark_sentry_discord_alert_delivery_started: boolean }>(
            'SELECT public.mark_sentry_discord_alert_delivery_started($1, $2)',
            [claimed.rows[0]?.id, claimed.rows[0]?.claim_token],
        );
        await db.exec('RESET ROLE');
        await db.exec(`
            UPDATE public.sentry_discord_alert_outbox
            SET claimed_at = clock_timestamp() - interval '10 minutes'
            WHERE dedupe_key = '${DEDUPE_KEY}';
            SET ROLE service_role;
        `);
        const recovered = await db.query<{ reconcile_stale_sentry_discord_alert_claims: number }>(
            'SELECT public.reconcile_stale_sentry_discord_alert_claims(60)',
        );
        await db.exec('RESET ROLE');
        const state = await db.query<{ status: string; failure_code: string }>(
            'SELECT status, failure_code FROM public.sentry_discord_alert_outbox WHERE dedupe_key = $1', [DEDUPE_KEY],
        );
        expect(marked.rows[0]?.mark_sentry_discord_alert_delivery_started).toBe(true);
        expect(recovered.rows[0]?.reconcile_stale_sentry_discord_alert_claims).toBe(1);
        expect(state.rows[0]).toEqual({
            status: 'ambiguous_failed', failure_code: 'DISCORD_CLAIM_LEASE_EXPIRED_AMBIGUOUS',
        });
    });

    it('can claim the just-enqueued fingerprint even when an older row is pending', async () => {
        const older = 'b'.repeat(64);
        const fresh = 'c'.repeat(64);
        await db.exec('SET ROLE service_role');
        await db.query('SELECT public.enqueue_sentry_discord_alert_outbox($1, $2, clock_timestamp(), $3, $4, $5, $6)', [older, 'old-project', null, null, null, null]);
        await db.exec('RESET ROLE');
        await db.exec(`
            UPDATE public.sentry_discord_alert_outbox
            SET created_at = clock_timestamp() - interval '1 minute'
            WHERE dedupe_key = '${older}';
            SET ROLE service_role;
        `);
        await db.query('SELECT public.enqueue_sentry_discord_alert_outbox($1, $2, clock_timestamp(), $3, $4, $5, $6)', [fresh, 'fresh-project', null, null, null, null]);
        const targeted = await db.query<{ id: string }>(
            'SELECT id FROM public.claim_sentry_discord_alert_outbox(1, $1)', [fresh],
        );
        await db.exec('RESET ROLE');
        const claimedRow = await db.query<{ dedupe_key: string }>(
            'SELECT dedupe_key FROM public.sentry_discord_alert_outbox WHERE id = $1', [targeted.rows[0]?.id],
        );
        expect(claimedRow.rows).toEqual([{ dedupe_key: fresh }]);
    });
});
