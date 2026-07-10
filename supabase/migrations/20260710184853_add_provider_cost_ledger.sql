-- Durable, PII-free billing evidence for every paid Apify Actor run. Unlike the
-- resumability table, this ledger intentionally survives analysis completion,
-- failure, and request deletion so unit economics remain measurable.
CREATE TABLE public.analysis_provider_cost_ledger (
    run_id TEXT PRIMARY KEY
        CHECK (run_id ~ '^[A-Za-z0-9]{8,64}$'),
    request_id UUID
        REFERENCES public.analysis_requests(id) ON DELETE SET NULL,
    operation_key TEXT NOT NULL
        CHECK (
            operation_key ~ '^(profile:target|profiles:(0|[1-9][0-9]{0,6})|relationship:(followers|following)|interaction:(target_likers|target_comments|candidate_likers):(0|[1-9][0-9]{0,6}))$'
        ),
    logical_provider TEXT NOT NULL
        CHECK (logical_provider IN ('apify', 'coderx')),
    actor_id TEXT NOT NULL
        CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'),
    credential_slot TEXT NOT NULL
        CHECK (credential_slot IN ('primary', 'secondary')),
    status TEXT NOT NULL
        CHECK (status IN ('running', 'succeeded', 'failed', 'aborted', 'timed_out')),
    max_charge_usd NUMERIC NOT NULL
        CHECK (
            max_charge_usd::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
            AND max_charge_usd >= 0
            AND max_charge_usd <= 100000
        ),
    usage_total_usd NUMERIC
        CHECK (
            usage_total_usd IS NULL
            OR (
                usage_total_usd::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
                AND usage_total_usd >= 0
                AND usage_total_usd <= 100000
            )
        ),
    started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    terminal_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (status = 'running' AND terminal_at IS NULL AND usage_total_usd IS NULL)
        OR (status <> 'running' AND terminal_at IS NOT NULL)
    )
);

CREATE UNIQUE INDEX analysis_provider_cost_ledger_request_operation_key
    ON public.analysis_provider_cost_ledger(request_id, operation_key)
    WHERE request_id IS NOT NULL;
CREATE INDEX analysis_provider_cost_ledger_terminal_at
    ON public.analysis_provider_cost_ledger(terminal_at DESC)
    WHERE terminal_at IS NOT NULL;
CREATE INDEX analysis_provider_cost_ledger_actor_status
    ON public.analysis_provider_cost_ledger(logical_provider, actor_id, status);

ALTER TABLE public.analysis_provider_cost_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_provider_cost_ledger
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.analysis_provider_cost_ledger TO service_role;

CREATE OR REPLACE FUNCTION public.record_analysis_provider_cost_started(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_operation_key TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_run_id TEXT,
    p_max_charge_usd NUMERIC
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
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR p_max_charge_usd < 0
       OR p_max_charge_usd > 100000 THEN
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

    -- The same run is an idempotent success even after the request advances or
    -- reaches a terminal state. Every identity field still has to match.
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
        RETURN TRUE;
    END IF;

    -- A new run may only be linked to the owner at the exact active pipeline step.
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
        IF existing.run_id <> p_run_id
           OR existing.logical_provider <> p_logical_provider
           OR existing.actor_id <> p_actor_id
           OR existing.credential_slot <> p_credential_slot
           OR existing.max_charge_usd <> p_max_charge_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PROVIDER_COST_OPERATION_CONFLICT',
                ERRCODE = '23505';
        END IF;
        RETURN TRUE;
    END IF;

    INSERT INTO public.analysis_provider_cost_ledger (
        run_id,
        request_id,
        operation_key,
        logical_provider,
        actor_id,
        credential_slot,
        status,
        max_charge_usd
    ) VALUES (
        p_run_id,
        p_request_id,
        p_operation_key,
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        'running',
        p_max_charge_usd
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows = 1 THEN
        RETURN TRUE;
    END IF;

    -- A concurrent insertion can only be accepted if it is the exact same event.
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
       AND existing.max_charge_usd = p_max_charge_usd THEN
        RETURN TRUE;
    END IF;

    RAISE EXCEPTION USING
        MESSAGE = 'ANALYSIS_PROVIDER_COST_CONFLICT',
        ERRCODE = '23505';
END;
$$;

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
                usage_total_usd = p_usage_total_usd,
                terminal_at = clock_timestamp(),
                updated_at = clock_timestamp()
            WHERE run_id = p_run_id;
            RETURN TRUE;
        END IF;

        IF existing.status <> p_status
           OR (
               existing.usage_total_usd IS NOT NULL
               AND p_usage_total_usd IS NOT NULL
               AND existing.usage_total_usd <> p_usage_total_usd
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PROVIDER_COST_TERMINAL_CONFLICT',
                ERRCODE = '23505';
        END IF;

        -- A later provider response may enrich an initially unavailable usage total.
        IF existing.usage_total_usd IS NULL AND p_usage_total_usd IS NOT NULL THEN
            UPDATE public.analysis_provider_cost_ledger
            SET usage_total_usd = p_usage_total_usd,
                updated_at = clock_timestamp()
            WHERE run_id = p_run_id;
        END IF;
        RETURN TRUE;
    END IF;

    -- Terminal upsert is permitted without a prior started write only while the
    -- exact owning request state remains active.
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
        p_usage_total_usd,
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
       AND existing.max_charge_usd = p_max_charge_usd
       AND (
           existing.usage_total_usd IS NOT DISTINCT FROM p_usage_total_usd
           OR (existing.usage_total_usd IS NOT NULL AND p_usage_total_usd IS NULL)
       ) THEN
        RETURN TRUE;
    END IF;

    RAISE EXCEPTION USING
        MESSAGE = 'ANALYSIS_PROVIDER_COST_CONFLICT',
        ERRCODE = '23505';
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_provider_cost_started(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_analysis_provider_cost_started(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

REVOKE ALL ON FUNCTION public.record_analysis_provider_cost_terminal(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_analysis_provider_cost_terminal(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC
) TO service_role;

COMMENT ON TABLE public.analysis_provider_cost_ledger IS
    'Service-role-only, PII-free Apify run cost ledger retained for unit-economics reporting.';
COMMENT ON COLUMN public.analysis_provider_cost_ledger.operation_key IS
    'Closed-set logical operation key; never contains an Instagram username or other PII.';
COMMENT ON COLUMN public.analysis_provider_cost_ledger.logical_provider IS
    'Logical application provider; every row represents an underlying Apify Actor run.';
COMMENT ON COLUMN public.analysis_provider_cost_ledger.usage_total_usd IS
    'Actual Apify run usageTotalUsd when the platform supplies it.';
COMMENT ON FUNCTION public.record_analysis_provider_cost_started(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) IS 'Idempotently records a paid Actor start after request owner/state validation.';
COMMENT ON FUNCTION public.record_analysis_provider_cost_terminal(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC
) IS 'Idempotently seals or enriches paid Actor cost data without deleting it at analysis terminal state.';
