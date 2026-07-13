-- Apify Store event charges are eventually consistent. A terminal Actor can
-- initially report zero or a partial usageTotalUsd and later report its final
-- total. Finalize it only through a later authenticated run read.
ALTER TABLE public.analysis_provider_cost_ledger
    ADD COLUMN cost_finalized_at TIMESTAMP WITH TIME ZONE;

-- Historical terminal snapshots were captured from Apify's preliminary response.
UPDATE public.analysis_provider_cost_ledger
SET usage_total_usd = NULL,
    cost_finalized_at = NULL
WHERE status <> 'running';

CREATE OR REPLACE FUNCTION public.record_analysis_provider_cost_terminal(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_operation_key TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_run_id TEXT,
    p_status TEXT,
    p_max_charge_usd NUMERIC,
    p_usage_total_usd NUMERIC DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    existing public.analysis_provider_cost_ledger%ROWTYPE;
    affected_rows INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_operation_key IS NULL
       OR p_operation_key !~ '^(profile:target|profiles:(0|[1-9][0-9]{0,6})|relationship:(followers|following)|interaction:(target_likers|target_comments|candidate_likers):(0|[1-9][0-9]{0,6}))$'
       OR p_logical_provider IS NULL
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR p_credential_slot IS NULL
       OR p_credential_slot NOT IN ('primary', 'secondary')
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_status IS NULL
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR p_max_charge_usd < 0
       OR p_max_charge_usd > 100000
       OR (
           p_usage_total_usd IS NOT NULL
           AND (
               p_usage_total_usd::TEXT IN ('NaN', 'Infinity', '-Infinity')
               OR p_usage_total_usd < 0
               OR p_usage_total_usd > 100000
           )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_COST_INVALID',
            ERRCODE = '22023';
    END IF;

    IF p_expected_step IS NULL OR NOT (
        (p_expected_step = 'collect' AND p_operation_key ~ '^(profile:target|relationship:)')
        OR (p_expected_step = 'profiles' AND p_operation_key ~ '^profiles:')
        OR (p_expected_step = 'interactions' AND p_operation_key ~ '^interaction:')
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_COST_INVALID_STEP',
            ERRCODE = '22023';
    END IF;

    SELECT *
    INTO existing
    FROM public.analysis_provider_cost_ledger
    WHERE run_id = p_run_id
    FOR UPDATE;
    IF FOUND THEN
        IF (existing.request_id IS NOT NULL AND existing.request_id <> p_request_id)
           OR existing.operation_key <> p_operation_key
           OR existing.logical_provider <> p_logical_provider
           OR existing.actor_id <> p_actor_id
           OR existing.credential_slot <> p_credential_slot
           OR existing.max_charge_usd <> p_max_charge_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PROVIDER_COST_RUN_CONFLICT',
                ERRCODE = '23505';
        END IF;

        IF existing.status = 'running' THEN
            UPDATE public.analysis_provider_cost_ledger
            SET status = p_status,
                usage_total_usd = NULL,
                terminal_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE run_id = p_run_id;
            RETURN TRUE;
        END IF;

        IF existing.status <> p_status THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PROVIDER_COST_TERMINAL_CONFLICT',
                ERRCODE = '23505';
        END IF;

        RETURN TRUE;
    END IF;

    PERFORM 1
    FROM public.analysis_requests
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = p_expected_step
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    SELECT *
    INTO existing
    FROM public.analysis_provider_cost_ledger
    WHERE request_id = p_request_id
      AND operation_key = p_operation_key
    FOR UPDATE;
    IF FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_COST_OPERATION_CONFLICT',
            ERRCODE = '23505';
    END IF;

    INSERT INTO public.analysis_provider_cost_ledger (
        run_id,
        request_id,
        operation_key,
        logical_provider,
        actor_id,
        credential_slot,
        status,
        max_charge_usd,
        usage_total_usd,
        terminal_at
    ) VALUES (
        p_run_id,
        p_request_id,
        p_operation_key,
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        p_status,
        p_max_charge_usd,
        NULL,
        clock_timestamp()
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows = 1 THEN
        RETURN TRUE;
    END IF;

    SELECT *
    INTO existing
    FROM public.analysis_provider_cost_ledger
    WHERE run_id = p_run_id
       OR (request_id = p_request_id AND operation_key = p_operation_key)
    ORDER BY (run_id = p_run_id) DESC
    LIMIT 1
    FOR UPDATE;
    IF FOUND
       AND existing.run_id = p_run_id
       AND existing.request_id IS NOT DISTINCT FROM p_request_id
       AND existing.operation_key = p_operation_key
       AND existing.logical_provider = p_logical_provider
       AND existing.actor_id = p_actor_id
       AND existing.credential_slot = p_credential_slot
       AND existing.status = p_status
       AND existing.max_charge_usd = p_max_charge_usd THEN
        RETURN TRUE;
    END IF;

    RAISE EXCEPTION USING
        MESSAGE = 'ANALYSIS_PROVIDER_COST_CONFLICT',
        ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_provider_cost_terminal(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_analysis_provider_cost_terminal(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC
) TO service_role;

COMMENT ON FUNCTION public.record_analysis_provider_cost_terminal(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC
) IS 'Idempotently seals a provider run while leaving preliminary Apify usage unfinalized.';

CREATE OR REPLACE FUNCTION public.finalize_analysis_provider_cost(
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_status TEXT,
    p_usage_total_usd NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    existing public.analysis_provider_cost_ledger%ROWTYPE;
BEGIN
    IF p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR p_credential_slot NOT IN ('primary', 'secondary')
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR p_usage_total_usd IS NULL
       OR p_usage_total_usd::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR p_usage_total_usd < 0
       OR p_usage_total_usd > 100000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_COST_FINALIZE_INVALID',
            ERRCODE = '22023';
    END IF;

    SELECT *
    INTO existing
    FROM public.analysis_provider_cost_ledger
    WHERE run_id = p_run_id
    FOR UPDATE;

    IF NOT FOUND
       OR existing.logical_provider <> p_logical_provider
       OR existing.actor_id <> p_actor_id
       OR existing.credential_slot <> p_credential_slot
       OR existing.status <> p_status THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_COST_FINALIZE_CONFLICT',
            ERRCODE = '23505';
    END IF;

    IF p_usage_total_usd > existing.max_charge_usd + 0.000000001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_COST_FINALIZE_OVER_CAP',
            ERRCODE = '22023';
    END IF;

    IF existing.cost_finalized_at IS NOT NULL THEN
        IF existing.usage_total_usd IS DISTINCT FROM p_usage_total_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PROVIDER_COST_FINALIZE_MISMATCH',
                ERRCODE = '23505';
        END IF;
        RETURN TRUE;
    END IF;

    UPDATE public.analysis_provider_cost_ledger
    SET usage_total_usd = p_usage_total_usd,
        cost_finalized_at = clock_timestamp(),
        updated_at = clock_timestamp()
    WHERE run_id = p_run_id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_analysis_provider_cost(
    TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_analysis_provider_cost(
    TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

COMMENT ON COLUMN public.analysis_provider_cost_ledger.cost_finalized_at IS
    'Set only after an authenticated Apify run read at least ten seconds after terminal state.';
COMMENT ON FUNCTION public.finalize_analysis_provider_cost(
    TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) IS 'Finalizes stable Apify usage after the documented post-terminal settlement window.';
