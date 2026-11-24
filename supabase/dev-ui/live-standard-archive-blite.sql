-- Dev only. Install after live-standard-archive-replay.sql and the B-lite baseline.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF pg_catalog.to_regclass('dev_ui.preflights') IS NULL
       OR pg_catalog.to_regclass('dev_ui.orders') IS NULL
       OR pg_catalog.to_regclass('dev_ui.runs') IS NULL
       OR pg_catalog.to_regclass('dev_live_budget.standard_archive_replay_grants') IS NULL
       OR pg_catalog.to_regprocedure('public.dev_live_standard_archive_replay_lookup_v1(uuid)') IS NULL
       OR pg_catalog.to_regprocedure('dev_live_budget.standard_archive_source_target_matches_v1(public.analysis_preflights,public.analysis_requests,uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.activate_precheckout_blite_cohort_v1(uuid,uuid)') IS NULL
       OR pg_catalog.to_regprocedure('public.complete_analysis_v2_preflight(uuid,uuid,uuid,text,text,text,integer,integer,boolean,text,text,jsonb)') IS NULL
       OR pg_catalog.to_regprocedure('public.precheckout_blite_v1_dto_is_valid(jsonb)') IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_WRONG_DATABASE';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.dev_live_complete_standard_archive_preflight_v1(
    p_preflight_id uuid, p_user_id uuid, p_claim_token uuid,
    p_target_full_name text, p_target_bio text, p_target_profile_image_url text,
    p_target_followers_count integer, p_target_following_count integer, p_target_is_private boolean,
    p_capacity_required_plan_id text, p_required_plan_id text, p_plan_cards_snapshot jsonb,
    p_blite_outcome jsonb
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    parent public.analysis_preflights%ROWTYPE;
    cached public.precheckout_blite_cache%ROWTYPE;
    terminal_state text := p_blite_outcome->>'state';
    reason text := p_blite_outcome->>'reason';
    preview jsonb := p_blite_outcome->'dto';
    completed boolean;
    terminal_at timestamptz;
BEGIN
    IF p_user_id IS NULL OR p_claim_token IS NULL OR pg_catalog.jsonb_typeof(p_blite_outcome) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE';
    END IF;
    IF terminal_state = 'complete' THEN
        IF NOT public.precheckout_blite_v1_has_exact_keys(p_blite_outcome, ARRAY['state','dto'])
           OR public.precheckout_blite_v1_dto_is_valid(preview) IS DISTINCT FROM true THEN
            RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE';
        END IF;
    ELSIF terminal_state = 'failed' THEN
        IF NOT public.precheckout_blite_v1_has_exact_keys(p_blite_outcome, ARRAY['state','reason'])
           OR reason IS NULL OR reason NOT IN (
                'source_missing','source_expired','source_invalid','source_insufficient','dispatch_failed',
                'inference_timeout','inference_rate_limited','inference_provider_failed','inference_response_invalid',
                'persistence_failed','attempts_exhausted'
           ) THEN
            RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE';
        END IF;
    ELSE
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE';
    END IF;

    SELECT preflight.* INTO parent FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id AND preflight.user_id = p_user_id
      AND preflight.access_mode = 'test_entitlement' AND preflight.analysis_entry_channel = 'standard'
      AND preflight.beta_entry_provenance IS NULL AND preflight.pii_scrubbed_at IS NULL
    FOR UPDATE;
    IF NOT FOUND OR NOT EXISTS (
        SELECT FROM dev_live_budget.standard_archive_replay_grants AS binding
        JOIN public.analysis_preflights AS source
          ON source.user_id = parent.user_id
         AND source.idempotency_key = 'dev-live:owner:standard:' || binding.source_grant_id::text
        JOIN public.analysis_requests AS request
          ON request.id = source.consumed_request_id AND request.preflight_id = source.id
         AND request.user_id = source.user_id
        WHERE parent.idempotency_key = 'dev-live:owner:standard:' || binding.grant_id::text
          AND binding.expires_at > pg_catalog.clock_timestamp()
          AND public.dev_live_owner_start_lookup_v2(binding.grant_id, parent.user_id, parent.target_instagram_id) IS NOT NULL
          AND public.dev_live_owner_start_lookup_v2(binding.source_grant_id, parent.user_id, parent.target_instagram_id) IS NOT NULL
          AND dev_live_budget.standard_archive_source_target_matches_v1(
              source, request, binding.source_grant_id, parent.target_instagram_id
          )
          AND source.status = 'consumed' AND source.precheckout_blite_cohort
          AND source.access_mode = 'test_entitlement' AND source.analysis_entry_channel = 'standard'
          AND source.beta_entry_provenance IS NULL
          AND request.status = 'completed' AND request.pipeline_version = 'v2' AND request.analysis_entry_channel = 'standard'
          AND request.selected_plan_id_snapshot = 'standard' AND request.plan_access_mode_snapshot = 'test_entitlement'
    ) THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE';
    END IF;

    -- Match the normal lock order and anchor the new cohort clock to the
    -- destination submission. After completion only its original claim can replay.
    IF parent.status = 'processing' THEN
        PERFORM public.activate_precheckout_blite_cohort_v1(parent.id, p_claim_token);
    ELSIF parent.status IS DISTINCT FROM 'ready' OR NOT parent.precheckout_blite_cohort THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BLITE_UNAVAILABLE';
    END IF;
    completed := public.complete_analysis_v2_preflight(
        parent.id, p_user_id, p_claim_token, p_target_full_name, p_target_bio, p_target_profile_image_url,
        p_target_followers_count, p_target_following_count, p_target_is_private, p_capacity_required_plan_id,
        p_required_plan_id, p_plan_cards_snapshot
    );
    IF NOT completed THEN
        SELECT cache.* INTO cached FROM public.precheckout_blite_cache AS cache WHERE cache.preflight_id = parent.id FOR SHARE;
        IF NOT FOUND OR cached.lease_token IS DISTINCT FROM p_claim_token OR cached.state IS DISTINCT FROM terminal_state
           OR cached.dto IS DISTINCT FROM preview OR cached.failure_reason IS DISTINCT FROM reason THEN
            RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BLITE_CONFLICT';
        END IF;
        RETURN false;
    END IF;

    terminal_at := pg_catalog.clock_timestamp();
    IF EXISTS (SELECT FROM public.precheckout_blite_sources WHERE preflight_id = parent.id)
       OR EXISTS (SELECT FROM public.precheckout_blite_dispatches WHERE preflight_id = parent.id)
       OR (terminal_state = 'complete' AND terminal_at >= (
           SELECT deadline_at FROM public.analysis_preflights WHERE id = parent.id
       )) THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BLITE_CONFLICT';
    END IF;
    INSERT INTO public.precheckout_blite_cache (
        preflight_id, state, lease_token, lease_expires_at, dto, failure_reason,
        completed_at, failed_at, created_at, updated_at, attempt_count
    ) VALUES (
        parent.id, terminal_state, p_claim_token, terminal_at, preview, reason,
        CASE WHEN terminal_state = 'complete' THEN terminal_at END,
        CASE WHEN terminal_state = 'failed' THEN terminal_at END, terminal_at, terminal_at, 0
    );
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.dev_live_complete_standard_archive_preflight_v1(uuid,uuid,uuid,text,text,text,integer,integer,boolean,text,text,jsonb,jsonb)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dev_live_complete_standard_archive_preflight_v1(uuid,uuid,uuid,text,text,text,integer,integer,boolean,text,text,jsonb,jsonb)
    TO service_role;
COMMIT;
