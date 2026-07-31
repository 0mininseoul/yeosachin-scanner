import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';

// The retention definition that shipped before the guard, kept so the failure it
// caused stays reproducible.
const priorMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260730140000_rehydrate_earlybird_paid_preflight_snapshot.sql',
        import.meta.url
    ),
    'utf8'
);
const guardMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260731010000_guard_preflight_purge_restricted_references.sql',
        import.meta.url
    ),
    'utf8'
);

const ORDER_PREFLIGHT = '90000000-0000-4000-8000-000000000001';
const RECOVERY_PREFLIGHT = '90000000-0000-4000-8000-000000000002';
const CAPTURE_PREFLIGHT = '90000000-0000-4000-8000-000000000003';
const FREE_PREFLIGHT = '90000000-0000-4000-8000-000000000004';
const PAID_PREFLIGHT = '90000000-0000-4000-8000-000000000005';
const ORDER = '91000000-0000-4000-8000-000000000001';
const PAID_ORDER = '91000000-0000-4000-8000-000000000002';
const FAILED_REQUEST = '92000000-0000-4000-8000-000000000001';
const CAPTURE = '93000000-0000-4000-8000-000000000001';

function functionDefinition(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start < 0) throw new Error(`${name} is missing`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`${name} has no bounded body`);
    return source.slice(start, end + '\n$$;'.length);
}

// Only the columns retention reads or scrubs, plus every foreign key that points
// at analysis_preflights with ON DELETE RESTRICT — those are the references that
// can abort the purge transaction.
const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
    target_instagram_id TEXT,
    target_full_name TEXT,
    target_bio TEXT,
    target_profile_image_url TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    plan_cards_snapshot JSONB,
    error_code TEXT,
    blocked_at TIMESTAMP WITH TIME ZONE,
    ready_at TIMESTAMP WITH TIME ZONE,
    exclusion_decision TEXT,
    excluded_instagram_id TEXT,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
);

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    actual_usage_usd NUMERIC,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE
);

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    status TEXT NOT NULL,
    preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);

CREATE TABLE public.earlybird_waitlist (
    id UUID PRIMARY KEY,
    preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);

CREATE TABLE public.earlybird_schema_failure_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);

CREATE TABLE public.analysis_v2_replay_capture_authorizations (
    capture_id UUID PRIMARY KEY,
    preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);
`;

// One consumed preflight the order was bought against, plus three long-expired
// tombstones: two still referenced under RESTRICT, one free to delete.
const seed = `
INSERT INTO public.analysis_requests (id)
VALUES ('${FAILED_REQUEST}');

INSERT INTO public.analysis_preflights (
    id, status, expires_at, pii_scrubbed_at, created_at, updated_at
) VALUES
    (
        '${ORDER_PREFLIGHT}', 'consumed',
        pg_catalog.clock_timestamp() + INTERVAL '30 minutes', NULL,
        pg_catalog.clock_timestamp() - INTERVAL '3 hours',
        pg_catalog.clock_timestamp() - INTERVAL '3 hours'
    ),
    (
        '${RECOVERY_PREFLIGHT}', 'expired',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours',
        pg_catalog.clock_timestamp() - INTERVAL '3 hours',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours'
    ),
    (
        '${CAPTURE_PREFLIGHT}', 'expired',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours',
        pg_catalog.clock_timestamp() - INTERVAL '3 hours',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours'
    ),
    (
        '${FREE_PREFLIGHT}', 'expired',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours',
        pg_catalog.clock_timestamp() - INTERVAL '3 hours',
        pg_catalog.clock_timestamp() - INTERVAL '2 hours'
    );

INSERT INTO public.earlybird_orders (id, status, preflight_id)
VALUES ('${ORDER}', 'completed', '${ORDER_PREFLIGHT}');

INSERT INTO public.earlybird_schema_failure_recoveries (
    order_id, failed_request_id, recovery_preflight_id
) VALUES ('${ORDER}', '${FAILED_REQUEST}', '${RECOVERY_PREFLIGHT}');

INSERT INTO public.analysis_v2_replay_capture_authorizations (capture_id, preflight_id)
VALUES ('${CAPTURE}', '${CAPTURE_PREFLIGHT}');
`;

let db: PGlite | undefined;

async function createDatabase(applyGuard = true): Promise<PGlite> {
    db = await PGlite.create();
    await db.exec(bootstrap);
    await db.exec(functionDefinition(priorMigration, 'purge_expired_analysis_v2_preflights'));
    if (applyGuard) await db.exec(guardMigration);
    await db.exec(seed);
    return db;
}

async function survivingPreflightIds(database: PGlite): Promise<string[]> {
    const rows = await database.query<{ id: string }>(
        'SELECT id FROM public.analysis_preflights ORDER BY id'
    );
    return rows.rows.map((row) => row.id);
}

afterEach(async () => {
    await db?.close();
    db = undefined;
});

describe('analysis V2 preflight purge restricted reference guard', () => {
    it('purges the free tombstone while a schema failure recovery still holds one', async () => {
        const database = await createDatabase();

        const purged = await database.query<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );

        expect(purged.rows[0].result).toBe(1);
        expect(await survivingPreflightIds(database)).toEqual([
            ORDER_PREFLIGHT, RECOVERY_PREFLIGHT, CAPTURE_PREFLIGHT,
        ]);
    }, 30_000);

    it('purges the free tombstone while a replay capture authorization still holds one', async () => {
        const database = await createDatabase();
        await database.query(
            'DELETE FROM public.earlybird_schema_failure_recoveries WHERE order_id = $1',
            [ORDER]
        );
        await database.query(
            'DELETE FROM public.analysis_preflights WHERE id = $1',
            [RECOVERY_PREFLIGHT]
        );

        const purged = await database.query<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );

        expect(purged.rows[0].result).toBe(1);
        expect(await survivingPreflightIds(database)).toEqual([
            ORDER_PREFLIGHT, CAPTURE_PREFLIGHT,
        ]);
    }, 30_000);

    it('unblocks a retention batch the shipped definition aborted outright', async () => {
        const database = await createDatabase(false);

        await expect(database.query(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        )).rejects.toThrow(
            /violates foreign key constraint "earlybird_schema_failure_recoveries_recovery_preflight_id_fkey"/
        );
        expect(await survivingPreflightIds(database)).toEqual([
            ORDER_PREFLIGHT, RECOVERY_PREFLIGHT, CAPTURE_PREFLIGHT, FREE_PREFLIGHT,
        ]);

        await database.exec(guardMigration);

        const purged = await database.query<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );
        expect(purged.rows[0].result).toBe(1);
    }, 30_000);

    it('still exempts a paid checkout preflight from expiry scrubbing', async () => {
        const database = await createDatabase();
        await database.query(
            `INSERT INTO public.analysis_preflights (
                id, status, expires_at, target_instagram_id, created_at, updated_at
             ) VALUES (
                $1, 'ready', pg_catalog.clock_timestamp() - INTERVAL '30 minutes',
                'sample.account',
                pg_catalog.clock_timestamp() - INTERVAL '3 hours',
                pg_catalog.clock_timestamp() - INTERVAL '3 hours'
             )`,
            [PAID_PREFLIGHT]
        );
        await database.query(
            `INSERT INTO public.earlybird_orders (id, status, preflight_id)
             VALUES ($1, 'paid', $2)`,
            [PAID_ORDER, PAID_PREFLIGHT]
        );

        const purged = await database.query<{ result: number }>(
            'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
        );

        expect(purged.rows[0].result).toBe(1);
        expect((await database.query<{
            status: string;
            target_instagram_id: string;
            pii_scrubbed_at: string | null;
        }>(
            `SELECT status, target_instagram_id, pii_scrubbed_at
             FROM public.analysis_preflights WHERE id = $1`,
            [PAID_PREFLIGHT]
        )).rows[0]).toEqual({
            status: 'ready',
            target_instagram_id: 'sample.account',
            pii_scrubbed_at: null,
        });
    }, 30_000);
});
