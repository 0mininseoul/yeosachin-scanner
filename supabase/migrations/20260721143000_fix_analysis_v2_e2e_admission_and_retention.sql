-- Keep the legacy analysis_requests plan snapshot aligned with the V2 catalog, and keep
-- restrictive commercial preflight references from poisoning the bounded retention batch.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_requests
    DROP CONSTRAINT IF EXISTS analysis_requests_plan_type_check;
ALTER TABLE public.analysis_requests
    ADD CONSTRAINT analysis_requests_plan_type_check
    CHECK (plan_type IN ('basic', 'standard', 'plus')) NOT VALID;
ALTER TABLE public.analysis_requests
    VALIDATE CONSTRAINT analysis_requests_plan_type_check;

CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_preflights(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_scrubbed_count INTEGER;
    v_deleted_count INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_MAINTENANCE_INPUT',
            ERRCODE = 'P0001';
    END IF;

    WITH expired AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status <> 'consumed'
          AND preflight.expires_at <= pg_catalog.clock_timestamp()
          AND preflight.pii_scrubbed_at IS NULL
        ORDER BY preflight.expires_at, preflight.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired',
        target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20),
        target_full_name = NULL,
        target_bio = NULL,
        target_profile_image_url = NULL,
        target_followers_count = NULL,
        target_following_count = NULL,
        target_is_private = NULL,
        capacity_required_plan_id = NULL,
        required_plan_id = NULL,
        plan_cards_snapshot = NULL,
        error_code = NULL,
        blocked_at = NULL,
        ready_at = NULL,
        exclusion_decision = 'skip',
        excluded_instagram_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        pii_scrubbed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    FROM expired
    WHERE preflight.id = expired.id;

    GET DIAGNOSTICS v_scrubbed_count = ROW_COUNT;

    WITH deletable AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status = 'expired'
          AND preflight.created_at <= pg_catalog.clock_timestamp() - INTERVAL '1 hour'
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_preflight_provider_runs AS provider_run
              WHERE provider_run.preflight_id = preflight.id
                AND (
                    provider_run.status NOT IN (
                        'succeeded', 'failed', 'aborted', 'timed_out',
                        'resolved_no_run'
                    )
                    OR provider_run.actual_usage_usd IS NULL
                    OR provider_run.usage_reconciled_at IS NULL
                )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_orders AS earlybird_order
              WHERE earlybird_order.preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_waitlist AS waitlist_entry
              WHERE waitlist_entry.preflight_id = preflight.id
          )
        ORDER BY preflight.created_at, preflight.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.analysis_preflights AS preflight
    USING deletable
    WHERE preflight.id = deletable.id;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_scrubbed_count + v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER) IS
    'Scrubs expired PII and retains tombstones for unreconciled provider usage or restrictive commercial references.';
