-- The confirmed attack starts only after OAuth, on a user-owned row. The
-- existing owner-update RLS policy is the sole browser path that can select
-- such a row for UPDATE. Drop only that policy: anonymous create/replay,
-- claim, exclusion and dispatch stay SECURITY INVOKER and retain their
-- established signed-claim GUC policies and broad legacy grants. The owner
-- exclusion capability already runs as a separately hardened SECURITY
-- DEFINER function with its own auth.uid()/state checks.
DROP POLICY IF EXISTS analysis_preflights_authenticated_owner_update
    ON public.analysis_preflights;

-- The four-argument readiness signature is still reached by the previously
-- deployed reserve/consume wrappers.  It intentionally cannot manufacture a
-- missing target identity from provider evidence.  Only the new service-only
-- five-argument overload may bind NULL, and only when the server recomputes
-- the target HMAC from the current raw target.
CREATE OR REPLACE FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission_internal_v2(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT,
    p_server_target_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_fallback public.analysis_preflight_provider_runs%ROWTYPE;
    v_fresh public.analysis_preflight_provider_runs%ROWTYPE;
    v_count INTEGER;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard')
       OR p_entitlement_jti_hash IS NULL
       OR p_entitlement_jti_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_ENTITLEMENT_INPUT',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status = 'consumed'
       AND v_preflight.admission_generation IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status = 'consumed'
       AND v_preflight.consumed_request_id IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'replayable');
    END IF;

    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id
       OR v_preflight.admission_entitlement_jti_hash
            IS DISTINCT FROM p_entitlement_jti_hash THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'not_applicable');
    END IF;

    IF v_preflight.admission_generation IS DISTINCT FROM 1
       OR v_preflight.admission_token IS NULL
       OR v_preflight.admission_refreshed_at IS NULL
       OR v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_EXPIRED',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_fallback
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
    FOR UPDATE;
    SELECT provider_run.*
    INTO v_fresh
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fresh-admission:g1'
    FOR UPDATE;
    SELECT pg_catalog.count(*)::INTEGER
    INTO v_count
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id;

    IF v_count <> 2
       OR v_fallback.preflight_id IS NULL
       OR v_fresh.preflight_id IS NULL
       OR v_fallback.status IS DISTINCT FROM 'succeeded'
       OR v_fresh.status IS DISTINCT FROM 'succeeded'
       OR v_fallback.input_hash IS NULL
       OR v_fresh.input_hash IS NULL
       OR v_fallback.input_hash !~ '^[a-f0-9]{64}$'
       OR v_fresh.input_hash !~ '^[a-f0-9]{64}$'
       OR v_fallback.input_hash IS DISTINCT FROM v_fresh.input_hash
       OR v_fallback.terminalized_at IS NULL
       OR v_fresh.terminalized_at IS NULL
       OR (v_fallback.actual_usage_usd IS NULL)
            <> (v_fallback.usage_reconciled_at IS NULL)
       OR (v_fresh.actual_usage_usd IS NULL)
            <> (v_fresh.usage_reconciled_at IS NULL) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    IF v_fallback.usage_reconciled_at IS NULL
       OR v_fresh.usage_reconciled_at IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'pending');
    END IF;

    -- Provider input hashes prove their own immutable source, but cannot prove
    -- which mutable preflight target generated it.  A NULL preflight hash is
    -- therefore bindable only from the server-recomputed HMAC of the target
    -- currently stored on the locked row, with both provider rows agreeing.
    IF v_preflight.target_input_hash IS NULL THEN
        IF p_server_target_input_hash IS NULL
           OR p_server_target_input_hash !~ '^[a-f0-9]{64}$'
           OR v_fallback.input_hash IS DISTINCT FROM p_server_target_input_hash
           OR v_fresh.input_hash IS DISTINCT FROM p_server_target_input_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_preflights AS preflight
        SET target_input_hash = p_server_target_input_hash,
            updated_at = v_now
        WHERE preflight.id = v_preflight.id
          AND preflight.user_id = p_user_id
          AND preflight.target_input_hash IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                ERRCODE = 'P0001';
        END IF;
        v_preflight.target_input_hash := p_server_target_input_hash;
    ELSIF v_preflight.target_input_hash !~ '^[a-f0-9]{64}$'
       OR v_fallback.input_hash IS DISTINCT FROM v_preflight.target_input_hash
       OR v_fresh.input_hash IS DISTINCT FROM v_preflight.target_input_hash
       OR (
           p_server_target_input_hash IS NOT NULL
           AND p_server_target_input_hash IS DISTINCT FROM v_preflight.target_input_hash
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes' THEN
        UPDATE public.analysis_preflights AS preflight
        SET admission_refreshed_at = v_now,
            updated_at = v_now
        WHERE preflight.id = v_preflight.id
          AND preflight.user_id = p_user_id
          AND preflight.status = 'ready'
          AND preflight.access_mode = 'test_entitlement'
          AND preflight.admission_status = 'ready'
          AND preflight.admission_selected_plan_id = p_selected_plan_id
          AND preflight.admission_entitlement_jti_hash = p_entitlement_jti_hash
          AND preflight.admission_token = v_preflight.admission_token;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'ready',
        'admissionToken', v_preflight.admission_token
    );
END;
$$;

ALTER FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission_internal_v2(
    UUID, UUID, TEXT, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission_internal_v2(
    UUID, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN public.prepare_analysis_v2_authorized_revenue_settlement_admission_internal_v2(
        p_preflight_id,
        p_user_id,
        p_selected_plan_id,
        p_entitlement_jti_hash,
        NULL
    );
END;
$$;

ALTER FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT
) TO service_role;

CREATE FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT,
    p_server_target_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN public.prepare_analysis_v2_authorized_revenue_settlement_admission_internal_v2(
        p_preflight_id,
        p_user_id,
        p_selected_plan_id,
        p_entitlement_jti_hash,
        p_server_target_input_hash
    );
END;
$$;

ALTER FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT, TEXT
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT, TEXT
) IS 'Service-only strict authorized-test fence: only a server-recomputed target HMAC may bind a legacy NULL target hash after fallback/g1 reconciliation.';

NOTIFY pgrst, 'reload schema';
