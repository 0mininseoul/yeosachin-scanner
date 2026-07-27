import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const foundation = readFileSync(new URL(
    '../../../supabase/migrations/20260727140000_add_kakao_signup_discord_outbox.sql',
    import.meta.url,
), 'utf8');
const hardening = readFileSync(new URL(
    '../../../supabase/migrations/20260727150000_harden_kakao_signup_discord_outbox.sql',
    import.meta.url,
), 'utf8');
const recovery = readFileSync(new URL(
    '../../../supabase/migrations/20260727160000_recover_unstaged_kakao_signup_discord_outbox.sql',
    import.meta.url,
), 'utf8');
const KAKAO_ID = '123e4567-e89b-42d3-a456-426614174000';
let db: PGlite;

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        CREATE ROLE anon NOLOGIN;
        CREATE ROLE authenticated NOLOGIN;
        CREATE ROLE service_role NOLOGIN;
        CREATE SCHEMA auth;
        CREATE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql VOLATILE AS $$
            SELECT pg_catalog.gen_random_uuid()
        $$;
        CREATE TABLE auth.users (
            id uuid PRIMARY KEY,
            raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
            created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp()
        );
    `);
    await db.exec(foundation);
    await db.exec(hardening);
    await db.exec(recovery);
}, 30_000);

afterAll(async () => db.close());

describe('Kakao signup Discord durable outbox', () => {
    it('creates only the Kakao first-identity row and refuses un-staged delivery', async () => {
        await db.exec(`
            INSERT INTO auth.users (id, raw_app_meta_data) VALUES
                ('${KAKAO_ID}', '{"provider":"kakao"}'),
                ('223e4567-e89b-42d3-a456-426614174000', '{"provider":"google"}');
        `);
        const outbox = await db.query<{ user_id: string; status: string }>(
            'SELECT user_id, status FROM public.kakao_signup_discord_outbox ORDER BY user_id',
        );
        expect(outbox.rows).toEqual([{ user_id: KAKAO_ID, status: 'pending' }]);

        await db.exec('SET ROLE service_role');
        const beforeStage = await db.query('SELECT * FROM public.claim_kakao_signup_discord_outbox($1, 1)', [KAKAO_ID]);
        expect(beforeStage.rows).toHaveLength(0);
        await db.query(
            "SELECT public.set_kakao_signup_discord_outbox_profile($1, NULL, NULL, NULL, clock_timestamp())",
            [KAKAO_ID],
        );
        const afterStage = await db.query<{ id: string }>(
            'SELECT id FROM public.claim_kakao_signup_discord_outbox($1, 1)', [KAKAO_ID],
        );
        await db.exec('RESET ROLE');
        expect(afterStage.rows).toHaveLength(1);
    }, 30_000);

    it('concurrent claims produce one sender and stale senders terminalize without another claim', async () => {
        await db.exec(`
            INSERT INTO auth.users (id, raw_app_meta_data) VALUES
                ('323e4567-e89b-42d3-a456-426614174000', '{"provider":"kakao"}');
            SET ROLE service_role;
            SELECT public.set_kakao_signup_discord_outbox_profile(
                '323e4567-e89b-42d3-a456-426614174000', NULL, NULL, NULL, clock_timestamp()
            );
            RESET ROLE;
        `);
        await db.exec('SET ROLE service_role');
        const [first, second] = await Promise.all([
            db.query<{ id: string }>('SELECT id FROM public.claim_kakao_signup_discord_outbox($1, 1)', ['323e4567-e89b-42d3-a456-426614174000']),
            db.query<{ id: string }>('SELECT id FROM public.claim_kakao_signup_discord_outbox($1, 1)', ['323e4567-e89b-42d3-a456-426614174000']),
        ]);
        await db.exec('RESET ROLE');
        await db.exec(`
            UPDATE public.kakao_signup_discord_outbox
            SET claimed_at = clock_timestamp() - interval '20 minutes'
            WHERE user_id = '323e4567-e89b-42d3-a456-426614174000';
        `);
        await db.exec('SET ROLE service_role');
        const reconciled = await db.query<{ reconcile_stale_kakao_signup_discord_claims: number }>(
            'SELECT public.reconcile_stale_kakao_signup_discord_claims(60)',
        );
        await db.exec('RESET ROLE');
        const state = await db.query<{ status: string; failure_code: string }>(`
            SELECT status, failure_code FROM public.kakao_signup_discord_outbox
            WHERE user_id = '323e4567-e89b-42d3-a456-426614174000'
        `);
        expect(first.rows.length + second.rows.length).toBe(1);
        expect(reconciled.rows[0]?.reconcile_stale_kakao_signup_discord_claims).toBe(1);
        expect(state.rows[0]).toEqual({
            status: 'ambiguous_failed',
            failure_code: 'DISCORD_CLAIM_LEASE_EXPIRED_AMBIGUOUS',
        });
    }, 30_000);

    it('recovers a callback profile-stage failure only after its grace period, then claims once', async () => {
        const userId = '423e4567-e89b-42d3-a456-426614174000';
        await db.exec(`
            INSERT INTO auth.users (id, raw_app_meta_data) VALUES
                ('${userId}', '{"provider":"kakao"}');
            UPDATE public.kakao_signup_discord_outbox
            SET created_at = clock_timestamp() - interval '10 minutes'
            WHERE user_id = '${userId}';
            SET ROLE service_role;
        `);
        const recovered = await db.query<{ recover_unstaged_kakao_signup_discord_outbox: number }>(
            'SELECT public.recover_unstaged_kakao_signup_discord_outbox(60)',
        );
        const claimed = await db.query<{ id: string }>(
            'SELECT id FROM public.claim_kakao_signup_discord_outbox($1, 1)', [userId],
        );
        await db.exec('RESET ROLE');

        expect(recovered.rows[0]?.recover_unstaged_kakao_signup_discord_outbox).toBe(1);
        expect(claimed.rows).toHaveLength(1);
    }, 30_000);
});
