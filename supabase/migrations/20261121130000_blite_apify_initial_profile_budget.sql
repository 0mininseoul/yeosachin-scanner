-- The only writer of the higher cap is the ordinary B-lite initial collection RPC.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflight_provider_runs
    DROP CONSTRAINT analysis_preflight_provider_run_cost_check,
    ADD CONSTRAINT analysis_preflight_provider_run_cost_check CHECK (
        (max_charge_usd = 0.0026 OR (
            max_charge_usd = 0.003
            AND operation_key = 'target-profile-fallback'
            AND public.analysis_beta_valid_apify_credential_slot(credential_slot)
        ))
        AND (actual_usage_usd IS NULL OR (
            actual_usage_usd BETWEEN 0 AND 100000
            AND actual_usage_usd <= max_charge_usd + 0.000000001
        ))
    );

ALTER TABLE public.analysis_preflight_acquisition_cost_events
    DROP CONSTRAINT analysis_preflight_acquisition_cost_event_state_check,
    ADD CONSTRAINT analysis_preflight_acquisition_cost_event_state_check CHECK (
        (
            event_kind = 'provider_run'
            AND logical_provider = 'apify'
            AND actor_id = 'apify/instagram-profile-scraper'
            AND public.analysis_v2_valid_apify_credential_slot(credential_slot)
            AND terminal_status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND (max_charge_usd = 0.0026 OR (max_charge_usd = 0.003 AND public.analysis_beta_valid_apify_credential_slot(credential_slot)))
            AND actual_usage_usd BETWEEN 0 AND max_charge_usd + 0.000000001
            AND evidence_reference_hash IS NULL
        )
        OR (
            event_kind = 'manual_no_run'
            AND logical_provider = 'apify'
            AND actor_id = 'apify/instagram-profile-scraper'
            AND public.analysis_v2_valid_apify_credential_slot(credential_slot)
            AND terminal_status = 'resolved_no_run'
            AND max_charge_usd = 0
            AND actual_usage_usd = 0
            AND evidence_reference_hash ~ '^[0-9a-f]{64}$'
        )
        OR (
            event_kind = 'provider_start_rejected'
            AND logical_provider = 'apify'
            AND actor_id = 'apify/instagram-profile-scraper'
            AND public.analysis_v2_valid_apify_credential_slot(credential_slot)
            AND terminal_status = 'rejected'
            AND max_charge_usd = 0
            AND actual_usage_usd = 0
            AND evidence_reference_hash IS NULL
        )
        OR (
            event_kind = 'provider_start_identity_drift'
            AND logical_provider = 'apify'
            AND actor_id = 'apify/instagram-profile-scraper'
            AND public.analysis_v2_valid_apify_credential_slot(credential_slot)
            AND terminal_status = 'resolved_identity_drift'
            AND max_charge_usd = 0.0026
            AND actual_usage_usd = max_charge_usd
            AND evidence_reference_hash ~ '^[0-9a-f]{64}$'
        )
    );

-- Keep the individual identity, amount and claim fences. The allocator is private.
-- All ordinary/fresh reserve RPCs retain their existing 0.0026-only writer guard.
DO $patch$
DECLARE
    fn regprocedure;
    definition text;
    old_guard constant text := 'p_max_charge_usd IS DISTINCT FROM 0.002600000000';
    new_guard constant text := '(p_max_charge_usd IS NULL OR p_max_charge_usd NOT IN (0.0026, 0.003))';
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.reserve_analysis_apify_free_provider_slot(uuid,numeric)'::regprocedure,
        'public.checkpoint_analysis_preflight_provider_run_started(uuid,uuid,text,text,numeric,text)'::regprocedure,
        'public.checkpoint_analysis_preflight_provider_run_terminal(uuid,uuid,text,text,numeric,text,text,numeric)'::regprocedure,
        'public.reject_analysis_preflight_provider_run_start(uuid,uuid,text,text,numeric)'::regprocedure,
        'public.reconcile_analysis_preflight_provider_run_usage(uuid,text,text,text,text,text,numeric,text,numeric,timestamptz)'::regprocedure,
        'public.record_analysis_preflight_provider_cost_event(text,text,text,text,text,numeric,numeric,date)'::regprocedure,
        'public.resolve_analysis_preflight_provider_run_no_run(uuid,text,text,text,text,text,numeric,timestamptz,text)'::regprocedure
    ] LOOP
        definition := pg_catalog.pg_get_functiondef(fn);
        IF pg_catalog.cardinality(pg_catalog.string_to_array(definition, old_guard)) <> 2 THEN
            RAISE EXCEPTION 'Unexpected provider budget guard in %', fn;
        END IF;
        EXECUTE pg_catalog.replace(definition, old_guard, new_guard);
    END LOOP;
END;
$patch$;

CREATE FUNCTION public.reserve_analysis_blite_apify_preflight_run_v1(
    p_preflight_id uuid, p_claim_token uuid, p_input_hash text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    preflight public.analysis_preflights%ROWTYPE;
    stored public.analysis_preflight_provider_runs%ROWTYPE;
    slot text;
    budget constant numeric := 0.003;
    now_at timestamptz;
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token IS NULL OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID';
    END IF;
    SELECT p.* INTO preflight FROM public.analysis_preflights p
    WHERE p.id = p_preflight_id FOR UPDATE;
    now_at := pg_catalog.clock_timestamp();
    IF NOT FOUND OR preflight.precheckout_blite_cohort IS NOT TRUE
       OR preflight.analysis_entry_channel IS DISTINCT FROM 'standard'
       OR preflight.beta_entry_provenance IS NOT NULL
       OR preflight.status IS DISTINCT FROM 'processing'
       OR preflight.pii_scrubbed_at IS NOT NULL OR preflight.consumed_request_id IS NOT NULL
       OR preflight.lease_token IS DISTINCT FROM p_claim_token
       OR preflight.target_input_hash IS DISTINCT FROM p_input_hash
       OR preflight.deadline_at IS NULL OR preflight.lease_expires_at IS NULL
       OR LEAST(preflight.expires_at, preflight.lease_expires_at, preflight.deadline_at) <= now_at THEN
        RAISE EXCEPTION 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH';
    END IF;

    SELECT r.* INTO stored FROM public.analysis_preflight_provider_runs r
    WHERE r.preflight_id = p_preflight_id AND r.operation_key = 'target-profile-fallback'
    FOR UPDATE;
    IF FOUND THEN
        IF stored.input_hash IS DISTINCT FROM p_input_hash
           OR NOT public.analysis_beta_valid_apify_credential_slot(stored.credential_slot)
           OR stored.logical_provider IS DISTINCT FROM 'apify'
           OR stored.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper' THEN
            RAISE EXCEPTION 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT';
        END IF;
        RETURN pg_catalog.jsonb_build_object('created', false, 'run', public.analysis_preflight_provider_run_json(stored));
    END IF;

    slot := public.reserve_analysis_apify_free_provider_slot(p_preflight_id, budget);
    -- The credit allocator can wait for other preflights. Check the lease and clock
    -- again before recording a new operation under the still-locked parent.
    IF LEAST(preflight.expires_at, preflight.lease_expires_at, preflight.deadline_at) <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH';
    END IF;
    INSERT INTO public.analysis_preflight_provider_runs (
        preflight_id, operation_key, input_hash, credential_slot, max_charge_usd
    ) VALUES (p_preflight_id, 'target-profile-fallback', p_input_hash, slot, budget)
    RETURNING * INTO stored;
    RETURN pg_catalog.jsonb_build_object('created', true, 'run', public.analysis_preflight_provider_run_json(stored));
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_analysis_blite_apify_preflight_run_v1(uuid,uuid,text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_blite_apify_preflight_run_v1(uuid,uuid,text) TO service_role;

COMMIT;
