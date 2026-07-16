-- A fresh-admission profile Actor dataset may be replayed once by target evidence only
-- after the worker has parsed the bounded full-profile snapshot schema (up to 10 latestPosts).
-- The ledger remains PII-free.

ALTER TABLE public.analysis_preflight_provider_runs
    ADD COLUMN reusable_profile_schema_version SMALLINT;

ALTER TABLE public.analysis_preflight_provider_runs
    ADD CONSTRAINT analysis_preflight_provider_run_reusable_profile_schema_check CHECK (
        reusable_profile_schema_version IS NULL
        OR reusable_profile_schema_version = 1
    );

COMMENT ON COLUMN public.analysis_preflight_provider_runs.reusable_profile_schema_version IS
    'Schema version attested only after the bounded fresh-admission profile snapshot parse; NULL is never reusable.';

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_fresh_admission_profile_run_reusable_v1(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_run_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_operation_key TEXT;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REUSABLE_TARGET_PROFILE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_operation_key :=
        'target-profile-fresh-admission:g' || p_admission_generation::TEXT;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_status IS DISTINCT FROM 'processing'
       OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token
       OR v_preflight.admission_lease_expires_at IS NULL
       OR v_preflight.admission_lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REUSABLE_TARGET_PROFILE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.logical_provider IS DISTINCT FROM 'apify'
       OR v_run.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(v_run.credential_slot)
       OR v_run.max_charge_usd IS DISTINCT FROM 0.002600000000
       OR v_run.status IS DISTINCT FROM 'succeeded'
       OR v_run.run_id IS DISTINCT FROM p_run_id
       OR v_run.terminalized_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REUSABLE_TARGET_PROFILE_RUN_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.reusable_profile_schema_version = 1 THEN
        RETURN FALSE;
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET reusable_profile_schema_version = 1,
        updated_at = v_now
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_analysis_v2_fresh_admission_profile_run_reusable_v1(
    UUID, INTEGER, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_fresh_admission_profile_run_reusable_v1(
    UUID, INTEGER, UUID, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_reusable_target_profile_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS DISTINCT FROM 'track:target-evidence:collect'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REUSABLE_TARGET_PROFILE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Preserve the terminal-capable preflight -> request -> job lock order.
    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;

    IF v_preflight.id IS NULL
       OR v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_job.request_id IS NULL
       OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REUSABLE_TARGET_PROFILE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM p_request_id
       OR v_preflight.target_instagram_id IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
       OR v_preflight.admission_generation NOT BETWEEN 1 AND 100
       OR v_preflight.admission_status IS DISTINCT FROM 'ready' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REUSABLE_TARGET_PROFILE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = v_preflight.id
      AND provider_run.operation_key = 'target-profile-fresh-admission:g'
            || v_preflight.admission_generation::TEXT;
    IF NOT FOUND OR v_run.reusable_profile_schema_version IS NULL THEN
        RETURN NULL;
    END IF;
    IF v_run.reusable_profile_schema_version <> 1
       OR v_run.logical_provider IS DISTINCT FROM 'apify'
       OR v_run.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(v_run.credential_slot)
       OR v_run.max_charge_usd IS DISTINCT FROM 0.002600000000
       OR v_run.status IS DISTINCT FROM 'succeeded'
       OR v_run.run_id IS NULL
       OR v_run.terminalized_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REUSABLE_TARGET_PROFILE_RUN_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'runId', v_run.run_id,
        'inputHash', v_run.input_hash,
        'credentialSlot', v_run.credential_slot,
        'maxChargeUsd', v_run.max_charge_usd,
        'actorId', v_run.actor_id
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_reusable_target_profile_run(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_reusable_target_profile_run(
    UUID, TEXT, UUID, TEXT
) TO service_role;
