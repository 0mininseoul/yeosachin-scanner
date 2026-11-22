-- Apply only to the registered Dev database, with no paid analysis in flight.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $dev_live$
DECLARE
    scheduler regprocedure;
    definition text;
    actual_sha text;
    before_sha constant text := '73faeec9547570fb756b76a2b06c9097807bcfe0c7b6e085516805767d6062d3';
    after_sha constant text := '985ebe6eac41b990874c816096a6066f0724c86703ac47b6ce9d8634b73ddaaa';
    -- The shared lock-order migration can run before or after this Dev override.
    ordered_before constant text := 'e91deaea73d60cd98cd13878394434717e4be7fb5525c64f418a82914392bcce';
    ordered_after constant text := '9379d945549a738a97877e05959323e7843faa3e60993052cca19ddf4d50801d';
    expected_sha text;
BEGIN
    IF pg_catalog.to_regclass('dev_ui.runs') IS NULL
       OR pg_catalog.to_regclass('dev_live_budget.standard_owner_policy') IS NULL
       OR pg_catalog.to_regprocedure('public.dev_live_owner_start_v4(uuid,text,uuid)') IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_FEATURE_CAP_WRONG_DATABASE';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
    );
    IF EXISTS (
        SELECT 1 FROM public.analysis_requests
        WHERE pipeline_version = 'v2' AND status IN ('pending', 'processing')
    ) OR (
        SELECT pg_catalog.count(*)
        FROM public.analysis_v2_gemini_leases
        WHERE state = 'available'
    ) <> 8 OR (
        SELECT pg_catalog.count(*) FROM public.analysis_v2_gemini_leases
    ) <> 8 THEN
        RAISE EXCEPTION 'DEV_LIVE_FEATURE_CAP_REQUIRES_IDLE_WORKERS';
    END IF;

    scheduler := pg_catalog.to_regprocedure(
        'public.acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)'
    );
    IF scheduler IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_FEATURE_CAP_SCHEDULER_MISSING';
    END IF;
    definition := pg_catalog.pg_get_functiondef(scheduler);
    actual_sha := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(definition, 'UTF8')), 'hex');
    IF actual_sha IN (after_sha, ordered_after) THEN
        RETURN;
    END IF;
    IF actual_sha = before_sha THEN
        expected_sha := after_sha;
    ELSIF actual_sha = ordered_before THEN
        expected_sha := ordered_after;
    ELSE
        RAISE EXCEPTION 'DEV_LIVE_FEATURE_CAP_SCHEDULER_DRIFT';
    END IF;

    EXECUTE pg_catalog.replace(definition, 'WHEN ''featureAnalysis'' THEN 3', 'WHEN ''featureAnalysis'' THEN 6');

    IF pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.pg_get_functiondef(scheduler), 'UTF8'
    )), 'hex') IS DISTINCT FROM expected_sha THEN
        RAISE EXCEPTION 'DEV_LIVE_FEATURE_CAP_VERIFICATION_FAILED';
    END IF;
END;
$dev_live$;

COMMIT;
