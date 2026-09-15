import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const providerRunMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260714175411_add_preflight_apify_provider_run_ledger.sql',
        import.meta.url
    ),
    'utf8'
);
const forwardMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260721143000_fix_analysis_v2_e2e_admission_and_retention.sql',
        import.meta.url
    ),
    'utf8'
);

function functionDefinition(source: string, name: string): string {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
    if (start < 0) throw new Error(`${name} is missing`);
    const end = source.indexOf('\n$$;', start);
    if (end < 0) throw new Error(`${name} has no bounded body`);
    return source.slice(start, end + '\n$$;'.length);
}

function legacyBootstrap(includeLegacyPlanConstraint = true): string {
    const planConstraint = includeLegacyPlanConstraint
        ? `,
    CONSTRAINT analysis_requests_plan_type_check
        CHECK (plan_type IN ('basic', 'standard'))`
        : '';
    return `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    plan_type TEXT${planConstraint}
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
    preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);

CREATE TABLE public.earlybird_waitlist (
    id UUID PRIMARY KEY,
    preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);
`;
}

async function createLegacyDatabase(includeLegacyPlanConstraint = true): Promise<PGlite> {
    const db = await PGlite.create();
    await db.exec(legacyBootstrap(includeLegacyPlanConstraint));
    await db.exec(functionDefinition(
        providerRunMigration,
        'purge_expired_analysis_v2_preflights'
    ));
    return db;
}

describe('analysis V2 E2E unblock migration PGlite regression', () => {
    it('upgrades the legacy request snapshot domain to accept Plus', async () => {
        const db = await createLegacyDatabase();
        try {
            await expect(db.query(
                `INSERT INTO public.analysis_requests (id, plan_type)
                 VALUES ('10000000-0000-4000-8000-000000000001', 'plus')`
            )).rejects.toThrow(/analysis_requests_plan_type_check/);

            await db.exec(forwardMigration);

            await expect(db.query(
                `INSERT INTO public.analysis_requests (id, plan_type)
                 VALUES ('10000000-0000-4000-8000-000000000001', 'plus')`
            )).resolves.toBeDefined();
            const stored = await db.query<{ plan_type: string }>(
                'SELECT plan_type FROM public.analysis_requests'
            );
            expect(stored.rows).toEqual([{ plan_type: 'plus' }]);
        } finally {
            await db.close();
        }
    }, 30_000);

    it('replays cleanly when the legacy plan constraint is absent from a fresh schema', async () => {
        const db = await createLegacyDatabase(false);
        try {
            await db.exec(forwardMigration);

            await expect(db.query(
                `INSERT INTO public.analysis_requests (id, plan_type)
                 VALUES ('10000000-0000-4000-8000-000000000002', 'plus')`
            )).resolves.toBeDefined();
        } finally {
            await db.close();
        }
    }, 30_000);

    it('scrubs and retains commercial or unreconciled tombstones without poisoning purge', async () => {
        const db = await createLegacyDatabase();
        try {
            const orderPreflight = '20000000-0000-4000-8000-000000000001';
            const waitlistPreflight = '20000000-0000-4000-8000-000000000002';
            const unreferencedPreflight = '20000000-0000-4000-8000-000000000003';
            const unreconciledPreflight = '20000000-0000-4000-8000-000000000004';
            await db.query(
                `INSERT INTO public.analysis_preflights (
                    id, status, expires_at, pii_scrubbed_at, target_instagram_id,
                    target_full_name, target_bio, target_profile_image_url,
                    target_followers_count, target_following_count, target_is_private,
                    capacity_required_plan_id, required_plan_id, plan_cards_snapshot,
                    error_code, blocked_at, ready_at, exclusion_decision,
                    excluded_instagram_id, lease_token, lease_expires_at,
                    created_at, updated_at
                )
                SELECT value::UUID, 'blocked',
                       pg_catalog.clock_timestamp() - INTERVAL '2 hours',
                       NULL, 'private.fixture', 'Private Fixture', 'private bio',
                       'https://private.example/avatar.jpg', 123, 456, FALSE,
                       'basic', 'standard', '{"standard": {"price": 1}}'::JSONB,
                       'PRIVATE_FAILURE', pg_catalog.clock_timestamp() - INTERVAL '2 hours',
                       pg_catalog.clock_timestamp() - INTERVAL '2 hours', 'exclude',
                       'excluded.fixture', '50000000-0000-4000-8000-000000000001'::UUID,
                       pg_catalog.clock_timestamp() - INTERVAL '90 minutes',
                       pg_catalog.clock_timestamp() - INTERVAL '2 hours',
                       pg_catalog.clock_timestamp() - INTERVAL '90 minutes'
                FROM pg_catalog.unnest($1::TEXT[]) AS value`,
                [[
                    orderPreflight,
                    waitlistPreflight,
                    unreferencedPreflight,
                    unreconciledPreflight,
                ]]
            );
            await db.query(
                `INSERT INTO public.earlybird_orders (id, preflight_id)
                 VALUES ('30000000-0000-4000-8000-000000000001', $1)`,
                [orderPreflight]
            );
            await db.query(
                `INSERT INTO public.earlybird_waitlist (id, preflight_id)
                 VALUES ('40000000-0000-4000-8000-000000000001', $1)`,
                [waitlistPreflight]
            );
            await db.query(
                `INSERT INTO public.analysis_preflight_provider_runs (
                    preflight_id, status, actual_usage_usd, usage_reconciled_at
                ) VALUES ($1, 'running', NULL, NULL)`,
                [unreconciledPreflight]
            );

            await expect(db.query(
                'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
            )).rejects.toThrow(/foreign key constraint/);

            const rolledBackScrub = await db.query<{ pii_scrubbed: boolean }>(
                `SELECT pii_scrubbed_at IS NOT NULL AS pii_scrubbed
                 FROM public.analysis_preflights
                 WHERE id = $1`,
                [orderPreflight]
            );
            expect(rolledBackScrub.rows).toEqual([{ pii_scrubbed: false }]);

            await db.exec(forwardMigration);

            const purged = await db.query<{ result: number }>(
                'SELECT public.purge_expired_analysis_v2_preflights(10) AS result'
            );
            expect(purged.rows).toEqual([{ result: 5 }]);
            const remaining = await db.query<{
                id: string;
                status: string;
                target_instagram_id: string;
                pii_scrubbed: boolean;
                scrubbed_fields: boolean;
            }>(
                `SELECT id, status, target_instagram_id,
                        pii_scrubbed_at IS NOT NULL AS pii_scrubbed,
                        target_full_name IS NULL
                            AND target_bio IS NULL
                            AND target_profile_image_url IS NULL
                            AND target_followers_count IS NULL
                            AND target_following_count IS NULL
                            AND target_is_private IS NULL
                            AND capacity_required_plan_id IS NULL
                            AND required_plan_id IS NULL
                            AND plan_cards_snapshot IS NULL
                            AND error_code IS NULL
                            AND blocked_at IS NULL
                            AND ready_at IS NULL
                            AND exclusion_decision = 'skip'
                            AND excluded_instagram_id IS NULL
                            AND lease_token IS NULL
                            AND lease_expires_at IS NULL AS scrubbed_fields
                 FROM public.analysis_preflights
                 ORDER BY id`
            );
            expect(remaining.rows).toEqual([
                {
                    id: orderPreflight,
                    status: 'expired',
                    target_instagram_id: 'retained.20000000000040008000',
                    pii_scrubbed: true,
                    scrubbed_fields: true,
                },
                {
                    id: waitlistPreflight,
                    status: 'expired',
                    target_instagram_id: 'retained.20000000000040008000',
                    pii_scrubbed: true,
                    scrubbed_fields: true,
                },
                {
                    id: unreconciledPreflight,
                    status: 'expired',
                    target_instagram_id: 'retained.20000000000040008000',
                    pii_scrubbed: true,
                    scrubbed_fields: true,
                },
            ]);
            const providerRuns = await db.query<{ preflight_id: string }>(
                'SELECT preflight_id FROM public.analysis_preflight_provider_runs'
            );
            expect(providerRuns.rows).toEqual([{ preflight_id: unreconciledPreflight }]);
        } finally {
            await db.close();
        }
    }, 30_000);
});
