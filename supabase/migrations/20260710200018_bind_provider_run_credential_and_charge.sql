-- A resumed Actor run must use the same Apify account and billing ceiling that
-- started it. Refuse to guess these values for an in-flight row created by the
-- older schema; operations can be retried after those rows reach a terminal state.
BEGIN;

LOCK TABLE public.analysis_provider_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.analysis_provider_runs) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_RUNS_ACTIVE_RETRY_MIGRATION',
            ERRCODE = '55006';
    END IF;
END;
$$;

ALTER TABLE public.analysis_provider_runs
    ADD COLUMN credential_slot TEXT NOT NULL,
    ADD COLUMN max_charge_usd NUMERIC NOT NULL,
    ADD CONSTRAINT analysis_provider_runs_credential_slot_check
        CHECK (credential_slot IN ('primary', 'secondary')),
    ADD CONSTRAINT analysis_provider_runs_max_charge_usd_check
        CHECK (
            max_charge_usd::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
            AND max_charge_usd >= 0
            AND max_charge_usd <= 100000
        );

REVOKE ALL ON FUNCTION public.reserve_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.reserve_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT
);

CREATE FUNCTION public.reserve_analysis_provider_run(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_operation_key TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_expected_step IS NULL
       OR p_operation_key IS NULL
       OR p_operation_key !~ '^(profile:target|profiles:(0|[1-9][0-9]{0,6})|relationship:(followers|following)|interaction:(target_likers|target_comments|candidate_likers):(0|[1-9][0-9]{0,6}))$'
       OR NOT (
           (p_expected_step = 'collect' AND p_operation_key ~ '^(profile:target|relationship:)')
           OR (p_expected_step = 'profiles' AND p_operation_key ~ '^profiles:')
           OR (p_expected_step = 'interactions' AND p_operation_key ~ '^interaction:')
       )
       OR p_logical_provider IS NULL
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR p_credential_slot IS NULL
       OR p_credential_slot NOT IN ('primary', 'secondary')
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR p_max_charge_usd < 0
       OR p_max_charge_usd > 100000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_RUN_INVALID',
            ERRCODE = '22023';
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

    IF EXISTS (
        SELECT 1
        FROM public.analysis_provider_runs
        WHERE request_id = p_request_id
          AND operation_key = p_operation_key
    ) THEN
        RETURN FALSE;
    END IF;

    INSERT INTO public.analysis_provider_runs (
        request_id,
        operation_key,
        logical_provider,
        actor_id,
        credential_slot,
        max_charge_usd,
        status
    ) VALUES (
        p_request_id,
        p_operation_key,
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        p_max_charge_usd,
        'starting'
    );
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION public.checkpoint_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
);

CREATE FUNCTION public.checkpoint_analysis_provider_run(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_operation_key TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_run_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_expected_step IS NULL
       OR p_operation_key IS NULL
       OR p_operation_key !~ '^(profile:target|profiles:(0|[1-9][0-9]{0,6})|relationship:(followers|following)|interaction:(target_likers|target_comments|candidate_likers):(0|[1-9][0-9]{0,6}))$'
       OR NOT (
           (p_expected_step = 'collect' AND p_operation_key ~ '^(profile:target|relationship:)')
           OR (p_expected_step = 'profiles' AND p_operation_key ~ '^profiles:')
           OR (p_expected_step = 'interactions' AND p_operation_key ~ '^interaction:')
       )
       OR p_logical_provider IS NULL
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR p_credential_slot IS NULL
       OR p_credential_slot NOT IN ('primary', 'secondary')
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR p_max_charge_usd < 0
       OR p_max_charge_usd > 100000
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PROVIDER_RUN_INVALID',
            ERRCODE = '22023';
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

    UPDATE public.analysis_provider_runs
    SET status = 'running',
        run_id = p_run_id,
        updated_at = clock_timestamp()
    WHERE request_id = p_request_id
      AND operation_key = p_operation_key
      AND logical_provider = p_logical_provider
      AND actor_id = p_actor_id
      AND credential_slot = p_credential_slot
      AND max_charge_usd = p_max_charge_usd
      AND status = 'starting'
      AND run_id IS NULL;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT
) TO service_role;

COMMENT ON COLUMN public.analysis_provider_runs.credential_slot IS
    'Immutable Apify token slot used to start and resume this Actor run.';
COMMENT ON COLUMN public.analysis_provider_runs.max_charge_usd IS
    'Immutable bounded Actor charge ceiling used for execution and cost attribution.';

COMMIT;
