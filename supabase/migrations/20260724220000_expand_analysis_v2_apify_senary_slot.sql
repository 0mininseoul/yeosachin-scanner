-- Add one same-named credential identity to the general Analysis V2 worker.
-- The separate profile-repair microcanary retains its historical five-slot policy.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary'
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- The terminal-safety RPC predated the shared validator and retained a five-slot
-- literal. Recreate it against the helper so a failed senary-backed E2E can use
-- the same durable, service-only cleanup path without broadening any canary RPC.
CREATE OR REPLACE FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    p_reservation_token UUID,
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
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
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_reservation_token IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12)
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR (p_actual_usage_usd IS NOT NULL AND (
            p_actual_usage_usd NOT BETWEEN 0 AND 100000
            OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
       )) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.* INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.reservation_token = p_reservation_token
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.run_id IS DISTINCT FROM p_run_id
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR p_actual_usage_usd > v_run.max_charge_usd + 0.000000001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = v_run.request_id AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF v_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out') THEN
        IF v_run.status IS DISTINCT FROM p_status
           OR (p_actual_usage_usd IS NOT NULL
               AND v_run.actual_usage_usd IS NOT NULL
               AND v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF p_actual_usage_usd IS NOT NULL AND v_run.actual_usage_usd IS NULL THEN
            UPDATE public.analysis_v2_provider_runs AS provider_run
            SET actual_usage_usd = p_actual_usage_usd,
                usage_reconciled_at = v_now, updated_at = v_now
            WHERE provider_run.reservation_token = p_reservation_token
            RETURNING provider_run.* INTO v_run;
        END IF;
        RETURN public.analysis_v2_provider_run_json(v_run);
    END IF;
    IF v_run.status <> 'running' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET status = p_status,
        actual_usage_usd = p_actual_usage_usd,
        terminalized_at = v_now,
        usage_reconciled_at = CASE
            WHEN p_actual_usage_usd IS NULL THEN NULL ELSE v_now
        END,
        updated_at = v_now
    WHERE provider_run.reservation_token = p_reservation_token
    RETURNING provider_run.* INTO v_run;
    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) TO service_role;

COMMENT ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT) IS
    'Exact same-named credential identities supported by the general Analysis V2 worker; no token pooling or aliases.';
