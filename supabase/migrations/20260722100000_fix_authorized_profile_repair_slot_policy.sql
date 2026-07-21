-- Profile repair is a distinct paid-provider operation identity, but intentionally shares the
-- immutable profile-fallback credential slot. The authorized-test policy stores seven public
-- operation slots and therefore has no eighth profile-repair key. Map only that internal repair
-- prefix to profile-fallback before enforcing the request-bound slot policy.

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_provider_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_operation_kind TEXT;
BEGIN
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;

    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;

    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id;
    IF FOUND THEN
        v_operation_kind := pg_catalog.split_part(p_operation_key, ':', 1);
        IF v_operation_kind = 'profile-repair' THEN
            v_operation_kind := 'profile-fallback';
        END IF;
        IF v_policy.operation_slot_map->>v_operation_kind
            IS DISTINCT FROM p_credential_slot THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN public.analysis_v2_reserve_provider_run_internal(
        p_request_id, p_job_key, p_claim_token, p_operation_key, p_input_hash,
        p_logical_provider, p_actor_id, p_credential_slot, p_max_charge_usd,
        p_reservation_token
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) TO service_role;

COMMENT ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) IS
    'Reserves an Analysis V2 provider run after enforcing the immutable request policy; profile-repair shares the profile-fallback slot.';
