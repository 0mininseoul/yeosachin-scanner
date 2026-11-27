import type { StandardDatabase } from './standard-database';

// Model one unavailable non-relationship slot in the fresh local cluster.
// No synthetic historical admission, claim or cost is created.
export async function applyApifyHeadroom(db: StandardDatabase) {
    await db.transaction(async tx => {
        await tx.exec(`
            DO $$
            BEGIN
                IF current_setting('server_version_num')::int NOT BETWEEN 170000 AND 179999
                    OR current_setting('listen_addresses') <> '' OR inet_server_addr() IS NOT NULL
                    OR EXISTS (SELECT FROM public.analysis_provider_admission_leases)
                THEN RAISE EXCEPTION 'SHARED_APIFY_HEADROOM_REQUIRES_FRESH_LOCAL_PG17';
                END IF;
                IF (SELECT count(*) FROM public.analysis_provider_admission_budgets
                    WHERE workload_role='paid' AND logical_provider='apify' AND (
                        (budget_key='paid:apify:global' AND credential_slot IS NULL AND max_active=8)
                        OR (budget_key='paid:apify:secondary' AND credential_slot='secondary' AND max_active=8)
                        OR (budget_key='paid:apify:secondary:relationship' AND credential_slot='secondary' AND max_active=4)
                    )) <> 3
                THEN RAISE EXCEPTION 'SHARED_APIFY_HEADROOM_SOURCE_PROFILE_MISMATCH';
                END IF;
                UPDATE public.analysis_provider_admission_budgets SET max_active=7
                WHERE budget_key IN ('paid:apify:global','paid:apify:secondary');
            END $$;
            CREATE TABLE public.fixture_paid_apify_observations (
                global_active integer NOT NULL, secondary_active integer NOT NULL, relationship_active integer NOT NULL
            );
            CREATE FUNCTION public.fixture_sample_paid_apify_occupancy() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
                INSERT INTO public.fixture_paid_apify_observations
                SELECT count(*), count(*) FILTER (WHERE credential_slot='secondary'),
                    count(*) FILTER (WHERE credential_slot='secondary' AND operation_key LIKE 'relationship-%')
                FROM public.analysis_provider_admission_leases
                WHERE workload_role='paid' AND logical_provider='apify' AND state IN ('leased','recovery_required');
                RETURN NULL;
            END $$;
            CREATE TRIGGER fixture_paid_apify_acquired AFTER INSERT OR UPDATE OF state
                ON public.analysis_provider_admission_leases FOR EACH ROW
                WHEN (NEW.workload_role='paid' AND NEW.logical_provider='apify' AND NEW.state='leased')
                EXECUTE FUNCTION public.fixture_sample_paid_apify_occupancy();
        `);
    });
}

export async function measureApifyHeadroom(db: StandardDatabase) {
    const { rows: scopes } = await db.query<{
        scope: string; sourceLimit: number; effectiveLimit: number; ratePerMinute: number; peak: number;
        admissions: number; openAtStop: number;
    }>(`
        WITH peaks AS (
            SELECT max(global_active) AS all_paid, max(secondary_active) AS secondary,
                max(relationship_active) AS relationship FROM public.fixture_paid_apify_observations
        )
        SELECT dimensions.scope, dimensions.source_limit AS "sourceLimit", b.max_active AS "effectiveLimit",
            b.rate_limit_per_minute AS "ratePerMinute", coalesce(dimensions.peak,0)::int AS peak,
            count(l.admission_id)::int AS admissions,
            count(l.admission_id) FILTER (WHERE l.state IN ('leased','recovery_required'))::int AS "openAtStop"
        FROM peaks CROSS JOIN LATERAL (VALUES
            ('global',8,peaks.all_paid),('secondary',8,peaks.secondary),('secondary:relationship',4,peaks.relationship)
        ) dimensions(scope,source_limit,peak)
        JOIN public.analysis_provider_admission_budgets b ON b.budget_key='paid:apify:'||dimensions.scope
        LEFT JOIN public.analysis_provider_admission_leases l ON l.workload_role=b.workload_role
            AND l.logical_provider=b.logical_provider AND (b.credential_slot IS NULL OR l.credential_slot=b.credential_slot)
            AND (dimensions.scope <> 'secondary:relationship' OR l.operation_key LIKE 'relationship-%')
        GROUP BY dimensions.scope,dimensions.source_limit,b.budget_key,dimensions.peak ORDER BY dimensions.scope
    `);
    if (scopes.length !== 3 || scopes.some(row => row.effectiveLimit !== (row.scope === 'secondary:relationship' ? 4 : 7))) {
        throw new Error('SHARED_APIFY_HEADROOM_MEASURED_PROFILE_MISMATCH');
    }
    return { mode: 'local_effective_limit', option: '--apify-headroom=7',
        observation: 'transactional_after_paid_apify_acquire', scopes };
}
