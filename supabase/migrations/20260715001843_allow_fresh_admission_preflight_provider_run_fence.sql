-- The target-profile fallback remains one row/run per preflight. These RPCs now
-- accept either the original profile-preflight lease or the exact live
-- fresh-admission lease so checkout refresh can resume the same paid run.
CREATE OR REPLACE FUNCTION public.reserve_analysis_preflight_provider_run(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.expires_at <= v_now
       OR NOT (
            (
                v_preflight.status = 'processing'
                AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.lease_expires_at IS NOT NULL
                AND v_preflight.lease_expires_at > v_now
            )
            OR (
                v_preflight.status = 'ready'
                AND v_preflight.consumed_request_id IS NULL
                AND v_preflight.admission_status = 'processing'
                AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.admission_lease_expires_at IS NOT NULL
                AND v_preflight.admission_lease_expires_at > v_now
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_existing
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.operation_key IS DISTINCT FROM 'target-profile-fallback'
           OR v_existing.input_hash IS DISTINCT FROM p_input_hash
           OR v_existing.logical_provider IS DISTINCT FROM 'apify'
           OR v_existing.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
           OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        RETURN pg_catalog.jsonb_build_object(
            'created', FALSE,
            'run', public.analysis_preflight_provider_run_json(v_existing)
        );
    END IF;

    INSERT INTO public.analysis_preflight_provider_runs (
        preflight_id,
        input_hash,
        credential_slot,
        max_charge_usd
    ) VALUES (
        p_preflight_id,
        p_input_hash,
        p_credential_slot,
        p_max_charge_usd
    )
    RETURNING * INTO v_existing;

    RETURN pg_catalog.jsonb_build_object(
        'created', TRUE,
        'run', public.analysis_preflight_provider_run_json(v_existing)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_preflight_provider_run(
    UUID, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_preflight_provider_run(
    UUID, UUID, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_preflight_provider_run(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.expires_at <= v_now
       OR NOT (
            (
                v_preflight.status = 'processing'
                AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.lease_expires_at IS NOT NULL
                AND v_preflight.lease_expires_at > v_now
            )
            OR (
                v_preflight.status = 'ready'
                AND v_preflight.consumed_request_id IS NULL
                AND v_preflight.admission_status = 'processing'
                AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.admission_lease_expires_at IS NOT NULL
                AND v_preflight.admission_lease_expires_at > v_now
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_preflight_provider_run(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_preflight_provider_run(UUID, UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_preflight_provider_run_started(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_run_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.expires_at <= v_now
       OR NOT (
            (
                v_preflight.status = 'processing'
                AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.lease_expires_at IS NOT NULL
                AND v_preflight.lease_expires_at > v_now
            )
            OR (
                v_preflight.status = 'ready'
                AND v_preflight.consumed_request_id IS NULL
                AND v_preflight.admission_status = 'processing'
                AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.admission_lease_expires_at IS NOT NULL
                AND v_preflight.admission_lease_expires_at > v_now
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status <> 'starting' THEN
        IF v_run.run_id IS DISTINCT FROM p_run_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RUN_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET status = 'running',
        run_id = p_run_id,
        run_started_at = v_now,
        updated_at = v_now
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
    RETURNING provider_run.* INTO v_run;

    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_preflight_provider_run_started(
    UUID, UUID, TEXT, TEXT, NUMERIC, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_preflight_provider_run_started(
    UUID, UUID, TEXT, TEXT, NUMERIC, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_preflight_provider_run_terminal(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_input_hash TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_run_id TEXT,
    p_status TEXT,
    p_actual_usage_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_status IS NULL
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR (
            p_actual_usage_usd IS NOT NULL
            AND (
                p_actual_usage_usd NOT BETWEEN 0 AND 100000
                OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
                OR p_actual_usage_usd > p_max_charge_usd + 0.000000001
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_preflight.expires_at <= v_now
       OR NOT (
            (
                v_preflight.status = 'processing'
                AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.lease_expires_at IS NOT NULL
                AND v_preflight.lease_expires_at > v_now
            )
            OR (
                v_preflight.status = 'ready'
                AND v_preflight.consumed_request_id IS NULL
                AND v_preflight.admission_status = 'processing'
                AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token
                AND v_preflight.admission_lease_expires_at IS NOT NULL
                AND v_preflight.admission_lease_expires_at > v_now
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.run_id IS DISTINCT FROM p_run_id OR v_run.status = 'starting' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RUN_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out') THEN
        IF v_run.status IS DISTINCT FROM p_status
           OR (
                p_actual_usage_usd IS NOT NULL
                AND v_run.actual_usage_usd IS NOT NULL
                AND v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_TERMINAL_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        IF p_actual_usage_usd IS NOT NULL AND v_run.actual_usage_usd IS NULL THEN
            UPDATE public.analysis_preflight_provider_runs AS provider_run
            SET actual_usage_usd = p_actual_usage_usd,
                usage_reconciled_at = v_now,
                updated_at = v_now
            WHERE provider_run.preflight_id = p_preflight_id
              AND provider_run.operation_key = 'target-profile-fallback'
            RETURNING provider_run.* INTO v_run;
        END IF;
        IF v_run.actual_usage_usd IS NOT NULL THEN
            PERFORM public.record_analysis_preflight_provider_cost_event(
                v_run.run_id,
                v_run.logical_provider,
                v_run.actor_id,
                v_run.credential_slot,
                v_run.status,
                v_run.max_charge_usd,
                v_run.actual_usage_usd,
                (v_run.terminalized_at AT TIME ZONE 'UTC')::DATE
            );
        END IF;
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;

    IF v_run.status <> 'running' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_STATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET status = p_status,
        actual_usage_usd = p_actual_usage_usd,
        terminalized_at = v_now,
        usage_reconciled_at = CASE
            WHEN p_actual_usage_usd IS NULL THEN NULL
            ELSE v_now
        END,
        updated_at = v_now
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
    RETURNING provider_run.* INTO v_run;

    IF v_run.actual_usage_usd IS NOT NULL THEN
        PERFORM public.record_analysis_preflight_provider_cost_event(
            v_run.run_id,
            v_run.logical_provider,
            v_run.actor_id,
            v_run.credential_slot,
            v_run.status,
            v_run.max_charge_usd,
            v_run.actual_usage_usd,
            (v_run.terminalized_at AT TIME ZONE 'UTC')::DATE
        );
    END IF;

    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_preflight_provider_run_terminal(
    UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_preflight_provider_run_terminal(
    UUID, UUID, TEXT, TEXT, NUMERIC, TEXT, TEXT, NUMERIC
) TO service_role;
