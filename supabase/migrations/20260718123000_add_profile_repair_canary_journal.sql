-- Crash-safe, service-role-only journal for the two explicitly approved profile-repair
-- canary repetitions. The table deliberately has no provider input, username, URL,
-- dataset identifier, linkable input digest, or free-form error/message column.

CREATE TABLE public.analysis_v2_profile_repair_canary_runs (
    source_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    canary_version TEXT NOT NULL DEFAULT 'profile-repair-canary-v1',
    repetition INTEGER NOT NULL,
    actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper',
    credential_slot TEXT NOT NULL,
    requested_count INTEGER NOT NULL DEFAULT 15,
    max_charge_usd NUMERIC(18, 12) NOT NULL DEFAULT 0.050000000000,
    reservation_token UUID NOT NULL,
    state TEXT NOT NULL DEFAULT 'starting',
    run_id VARCHAR(64),
    terminal_count INTEGER,
    success_count INTEGER,
    unavailable_count INTEGER,
    incomplete_count INTEGER,
    other_failure_count INTEGER,
    critical_recovered_count INTEGER,
    latency_ms INTEGER,
    gate_passed BOOLEAN,
    actual_usage_usd NUMERIC(18, 12),
    cost_status TEXT NOT NULL DEFAULT 'conservative',
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    run_started_at TIMESTAMP WITH TIME ZONE,
    ambiguous_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (source_request_id, canary_version, repetition),
    UNIQUE (reservation_token),
    UNIQUE (run_id),
    CONSTRAINT analysis_v2_profile_repair_canary_version_check CHECK (
        canary_version = 'profile-repair-canary-v1'
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_repetition_check CHECK (
        repetition IN (1, 2)
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_actor_check CHECK (
        actor_id = 'apify/instagram-profile-scraper'
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_credential_check CHECK (
        credential_slot IN ('primary', 'secondary', 'tertiary', 'quaternary', 'quinary')
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_requested_check CHECK (
        requested_count = 15
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_charge_check CHECK (
        max_charge_usd = 0.050000000000
        AND (
            actual_usage_usd IS NULL
            OR actual_usage_usd BETWEEN 0 AND 0.050000000000
        )
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_state_value_check CHECK (
        state IN ('starting', 'running', 'succeeded', 'failed', 'ambiguous')
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_cost_status_check CHECK (
        cost_status IN ('actual', 'conservative', 'unknown')
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_run_id_check CHECK (
        run_id IS NULL OR run_id ~ '^[A-Za-z0-9]{8,64}$'
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_counts_check CHECK (
        (terminal_count IS NULL OR terminal_count = 15)
        AND (success_count IS NULL OR success_count BETWEEN 0 AND 15)
        AND (unavailable_count IS NULL OR unavailable_count BETWEEN 0 AND 15)
        AND (incomplete_count IS NULL OR incomplete_count BETWEEN 0 AND 15)
        AND (other_failure_count IS NULL OR other_failure_count BETWEEN 0 AND 15)
        AND (critical_recovered_count IS NULL OR critical_recovered_count BETWEEN 0 AND 15)
        AND (latency_ms IS NULL OR latency_ms BETWEEN 0 AND 300000)
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_state_check CHECK (
        (
            state = 'starting'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND ambiguous_at IS NULL
            AND terminalized_at IS NULL
            AND terminal_count IS NULL
            AND success_count IS NULL
            AND unavailable_count IS NULL
            AND incomplete_count IS NULL
            AND other_failure_count IS NULL
            AND critical_recovered_count IS NULL
            AND latency_ms IS NULL
            AND gate_passed IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
            AND cost_status = 'conservative'
        )
        OR (
            state = 'running'
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND ambiguous_at IS NULL
            AND terminalized_at IS NULL
            AND terminal_count IS NULL
            AND success_count IS NULL
            AND unavailable_count IS NULL
            AND incomplete_count IS NULL
            AND other_failure_count IS NULL
            AND critical_recovered_count IS NULL
            AND latency_ms IS NULL
            AND gate_passed IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
            AND cost_status = 'conservative'
        )
        OR (
            state = 'ambiguous'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND ambiguous_at IS NOT NULL
            AND terminalized_at IS NOT NULL
            AND terminal_count IS NULL
            AND success_count IS NULL
            AND unavailable_count IS NULL
            AND incomplete_count IS NULL
            AND other_failure_count IS NULL
            AND critical_recovered_count IS NULL
            AND latency_ms IS NULL
            AND gate_passed IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
            AND cost_status = 'unknown'
        )
        OR (
            state IN ('succeeded', 'failed')
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND ambiguous_at IS NULL
            AND terminalized_at IS NOT NULL
            AND terminal_count = 15
            AND success_count IS NOT NULL
            AND unavailable_count IS NOT NULL
            AND incomplete_count IS NOT NULL
            AND other_failure_count IS NOT NULL
            AND success_count + unavailable_count + incomplete_count + other_failure_count
                = terminal_count
            AND critical_recovered_count IS NOT NULL
            AND critical_recovered_count BETWEEN 0 AND success_count
            AND latency_ms IS NOT NULL
            AND gate_passed IS NOT NULL
            AND gate_passed = (
                success_count >= 14
                AND unavailable_count <= 1
                AND other_failure_count = 0
                AND critical_recovered_count >= 1
            )
            AND gate_passed = (state = 'succeeded')
            AND (
                (
                    actual_usage_usd IS NULL
                    AND usage_reconciled_at IS NULL
                    AND cost_status = 'conservative'
                )
                OR (
                    actual_usage_usd IS NOT NULL
                    AND usage_reconciled_at IS NOT NULL
                    AND cost_status = 'actual'
                )
            )
        )
    ),
    CONSTRAINT analysis_v2_profile_repair_canary_time_check CHECK (
        updated_at >= reserved_at
        AND (run_started_at IS NULL OR run_started_at >= reserved_at)
        AND (ambiguous_at IS NULL OR ambiguous_at >= reserved_at)
        AND (terminalized_at IS NULL OR terminalized_at >= reserved_at)
        AND (usage_reconciled_at IS NULL OR usage_reconciled_at >= terminalized_at)
    )
);

CREATE INDEX idx_analysis_v2_profile_repair_canary_source_state
    ON public.analysis_v2_profile_repair_canary_runs(
        source_request_id,
        state,
        repetition
    );

COMMENT ON TABLE public.analysis_v2_profile_repair_canary_runs IS
    'RPC-only, PII-free intent, terminal-count, and settled-cost journal for two bounded canary repetitions.';
COMMENT ON COLUMN public.analysis_v2_profile_repair_canary_runs.reservation_token IS
    'Opaque provider-start fence; it contains no provider credential or request content.';
COMMENT ON COLUMN public.analysis_v2_profile_repair_canary_runs.state IS
    'An ambiguous row has no confirmed provider identity and permanently blocks automatic continuation.';

ALTER TABLE public.analysis_v2_profile_repair_canary_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_repair_canary_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_profile_repair_canary_runs
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_profile_repair_canary_run_json(
    p_run public.analysis_v2_profile_repair_canary_runs
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'sourceRequestId', p_run.source_request_id,
        'canaryVersion', p_run.canary_version,
        'repetition', p_run.repetition,
        'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot,
        'requestedCount', p_run.requested_count,
        'maxChargeUsd', p_run.max_charge_usd,
        'reservationToken', p_run.reservation_token,
        'state', p_run.state,
        'runId', p_run.run_id,
        'terminalCount', p_run.terminal_count,
        'successCount', p_run.success_count,
        'unavailableCount', p_run.unavailable_count,
        'incompleteCount', p_run.incomplete_count,
        'otherFailureCount', p_run.other_failure_count,
        'criticalRecoveredCount', p_run.critical_recovered_count,
        'latencyMs', p_run.latency_ms,
        'gatePassed', p_run.gate_passed,
        'actualUsageUsd', p_run.actual_usage_usd,
        'costStatus', p_run.cost_status,
        'reservedAt', p_run.reserved_at,
        'runStartedAt', p_run.run_started_at,
        'ambiguousAt', p_run.ambiguous_at,
        'terminalizedAt', p_run.terminalized_at,
        'usageReconciledAt', p_run.usage_reconciled_at,
        'updatedAt', p_run.updated_at
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_repair_canary_run_json(
    public.analysis_v2_profile_repair_canary_runs
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_repair_canary_source(
    p_source_request_id UUID,
    p_owner_id UUID,
    p_owner_email TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_owner_email TEXT;
    v_runs JSONB;
BEGIN
    IF p_source_request_id IS NULL
       OR p_owner_id IS NULL
       OR p_owner_email IS NULL
       OR pg_catalog.btrim(p_owner_email) = ''
       OR pg_catalog.char_length(p_owner_email) > 255 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_SOURCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    JOIN public.users AS owner ON owner.id = analysis_request.user_id
    WHERE analysis_request.id = p_source_request_id
      AND analysis_request.user_id = p_owner_id
      AND pg_catalog.lower(owner.email) = pg_catalog.lower(p_owner_email)
      AND analysis_request.pipeline_version = 'v2'
      AND analysis_request.status = 'failed'
      AND analysis_request.target_instagram_id = '0_min._.00';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_SOURCE_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    SELECT owner.email
    INTO v_owner_email
    FROM public.users AS owner
    WHERE owner.id = v_request.user_id;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'jobKey', provider_run.job_key,
                'operationKey', provider_run.operation_key,
                'status', provider_run.status,
                'runId', provider_run.run_id,
                'actorId', provider_run.actor_id,
                'credentialSlot', provider_run.credential_slot,
                'maxChargeUsd', provider_run.max_charge_usd
            ) ORDER BY provider_run.job_key
        ),
        '[]'::JSONB
    )
    INTO v_runs
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_source_request_id
      AND provider_run.job_key ~ '^track:profiles:batch:(?:0|[1-9][0-9]{0,2})$'
      AND provider_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$';

    RETURN pg_catalog.jsonb_build_object(
        'request', pg_catalog.jsonb_build_object(
            'sourceRequestId', v_request.id,
            'userId', v_request.user_id,
            'ownerEmail', v_owner_email,
            'targetInstagramId', v_request.target_instagram_id,
            'pipelineVersion', v_request.pipeline_version,
            'status', v_request.status
        ),
        'runs', v_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_repair_canary_source(
    UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_repair_canary_source(
    UUID, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_repair_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_run public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL OR p_repetition NOT IN (1, 2) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.*
    INTO v_run
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN public.analysis_v2_profile_repair_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_credential_slot TEXT,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source public.analysis_requests%ROWTYPE;
    v_previous public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
    v_run public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL
       OR p_repetition NOT IN (1, 2)
       OR p_credential_slot NOT IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary'
       )
       OR p_reservation_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_source
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_source_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_source.pipeline_version IS DISTINCT FROM 'v2'
       OR v_source.status IS DISTINCT FROM 'failed'
       OR v_source.target_instagram_id IS DISTINCT FROM '0_min._.00' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF p_repetition = 2 THEN
        SELECT canary_run.*
        INTO v_previous
        FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-repair-canary-v1'
          AND canary_run.repetition = 1
        FOR UPDATE;
        IF NOT FOUND
           OR v_previous.state IS DISTINCT FROM 'succeeded'
           OR v_previous.gate_passed IS DISTINCT FROM TRUE
           OR v_previous.cost_status IS DISTINCT FROM 'actual'
           OR v_previous.actual_usage_usd IS NULL
           OR v_previous.actual_usage_usd > 0.050000000000 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT canary_run.*
    INTO v_run
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF FOUND THEN
        IF v_run.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
           OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_run.requested_count IS DISTINCT FROM 15
           OR v_run.max_charge_usd IS DISTINCT FROM 0.050000000000 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'created', FALSE,
            'run', public.analysis_v2_profile_repair_canary_run_json(v_run)
        );
    END IF;

    INSERT INTO public.analysis_v2_profile_repair_canary_runs (
        source_request_id,
        repetition,
        credential_slot,
        reservation_token
    ) VALUES (
        p_source_request_id,
        p_repetition,
        p_credential_slot,
        p_reservation_token
    )
    RETURNING * INTO v_run;

    RETURN pg_catalog.jsonb_build_object(
        'created', TRUE,
        'run', public.analysis_v2_profile_repair_canary_run_json(v_run)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, TEXT, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_repair_canary_run_started(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID,
    p_run_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL
       OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.state = 'starting' THEN
        UPDATE public.analysis_v2_profile_repair_canary_runs AS canary_run
        SET state = 'running',
            run_id = p_run_id,
            run_started_at = v_now,
            updated_at = v_now
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-repair-canary-v1'
          AND canary_run.repetition = p_repetition
        RETURNING canary_run.* INTO v_run;
    ELSIF v_run.run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_RUN_CONFLICT',
            ERRCODE = 'P0001';
    ELSIF v_run.state = 'ambiguous' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_profile_repair_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_repair_canary_run_started(
    UUID, INTEGER, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_profile_repair_canary_run_started(
    UUID, INTEGER, UUID, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_profile_repair_canary_run_ambiguous(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL
       OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.state = 'starting' THEN
        UPDATE public.analysis_v2_profile_repair_canary_runs AS canary_run
        SET state = 'ambiguous',
            cost_status = 'unknown',
            ambiguous_at = v_now,
            terminalized_at = v_now,
            updated_at = v_now
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-repair-canary-v1'
          AND canary_run.repetition = p_repetition
        RETURNING canary_run.* INTO v_run;
    ELSIF v_run.state <> 'ambiguous' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_profile_repair_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.mark_analysis_v2_profile_repair_canary_run_ambiguous(
    UUID, INTEGER, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_profile_repair_canary_run_ambiguous(
    UUID, INTEGER, UUID
) TO service_role;

CREATE OR REPLACE FUNCTION public.terminalize_analysis_v2_profile_repair_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID,
    p_run_id TEXT,
    p_state TEXT,
    p_terminal_count INTEGER,
    p_success_count INTEGER,
    p_unavailable_count INTEGER,
    p_incomplete_count INTEGER,
    p_other_failure_count INTEGER,
    p_critical_recovered_count INTEGER,
    p_latency_ms INTEGER,
    p_gate_passed BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
BEGIN
    IF p_source_request_id IS NULL
       OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_state NOT IN ('succeeded', 'failed')
       OR p_terminal_count IS DISTINCT FROM 15
       OR p_success_count NOT BETWEEN 0 AND 15
       OR p_unavailable_count NOT BETWEEN 0 AND 15
       OR p_incomplete_count NOT BETWEEN 0 AND 15
       OR p_other_failure_count NOT BETWEEN 0 AND 15
       OR p_critical_recovered_count NOT BETWEEN 0 AND p_success_count
       OR p_success_count + p_unavailable_count
            + p_incomplete_count + p_other_failure_count <> p_terminal_count
       OR p_latency_ms NOT BETWEEN 0 AND 300000
       OR p_gate_passed IS DISTINCT FROM (
            p_success_count >= 14
            AND p_unavailable_count <= 1
            AND p_other_failure_count = 0
            AND p_critical_recovered_count >= 1
       )
       OR p_gate_passed IS DISTINCT FROM (p_state = 'succeeded') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.state IN ('succeeded', 'failed') THEN
        IF v_run.state IS DISTINCT FROM p_state
           OR v_run.terminal_count IS DISTINCT FROM p_terminal_count
           OR v_run.success_count IS DISTINCT FROM p_success_count
           OR v_run.unavailable_count IS DISTINCT FROM p_unavailable_count
           OR v_run.incomplete_count IS DISTINCT FROM p_incomplete_count
           OR v_run.other_failure_count IS DISTINCT FROM p_other_failure_count
           OR v_run.critical_recovered_count IS DISTINCT FROM p_critical_recovered_count
           OR v_run.latency_ms IS DISTINCT FROM p_latency_ms
           OR v_run.gate_passed IS DISTINCT FROM p_gate_passed THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_TERMINAL_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_repair_canary_run_json(v_run);
    END IF;
    IF v_run.state <> 'running' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_profile_repair_canary_runs AS canary_run
    SET state = p_state,
        terminal_count = p_terminal_count,
        success_count = p_success_count,
        unavailable_count = p_unavailable_count,
        incomplete_count = p_incomplete_count,
        other_failure_count = p_other_failure_count,
        critical_recovered_count = p_critical_recovered_count,
        latency_ms = p_latency_ms,
        gate_passed = p_gate_passed,
        terminalized_at = v_now,
        updated_at = v_now
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition
    RETURNING canary_run.* INTO v_run;
    RETURN public.analysis_v2_profile_repair_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.terminalize_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER,
    INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.terminalize_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, UUID, TEXT, TEXT, INTEGER, INTEGER, INTEGER,
    INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN
) TO service_role;

CREATE OR REPLACE FUNCTION public.reconcile_analysis_v2_profile_repair_canary_run_usage(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_reservation_token UUID,
    p_run_id TEXT,
    p_actual_usage_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_profile_repair_canary_runs%ROWTYPE;
    v_previous_actual NUMERIC(18, 12);
BEGIN
    IF p_source_request_id IS NULL
       OR p_repetition NOT IN (1, 2)
       OR p_reservation_token IS NULL
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_actual_usage_usd IS NULL
       OR p_actual_usage_usd < 0
       OR p_actual_usage_usd > 0.050000000000
       OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT canary_run.* INTO v_run
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.run_id IS DISTINCT FROM p_run_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.state NOT IN ('succeeded', 'failed') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_STATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_run.actual_usage_usd IS NOT NULL THEN
        IF v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd
           OR v_run.cost_status IS DISTINCT FROM 'actual'
           OR v_run.usage_reconciled_at IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_RECONCILIATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_repair_canary_run_json(v_run);
    END IF;
    IF p_repetition = 2 THEN
        SELECT canary_run.actual_usage_usd
        INTO v_previous_actual
        FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
        WHERE canary_run.source_request_id = p_source_request_id
          AND canary_run.canary_version = 'profile-repair-canary-v1'
          AND canary_run.repetition = 1;
        IF v_previous_actual IS NULL
           OR v_previous_actual + p_actual_usage_usd > 0.100000000000 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PROFILE_REPAIR_CANARY_RUN_RECONCILIATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    END IF;
    UPDATE public.analysis_v2_profile_repair_canary_runs AS canary_run
    SET actual_usage_usd = p_actual_usage_usd,
        cost_status = 'actual',
        usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE canary_run.source_request_id = p_source_request_id
      AND canary_run.canary_version = 'profile-repair-canary-v1'
      AND canary_run.repetition = p_repetition
    RETURNING canary_run.* INTO v_run;
    RETURN public.analysis_v2_profile_repair_canary_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_analysis_v2_profile_repair_canary_run_usage(
    UUID, INTEGER, UUID, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_analysis_v2_profile_repair_canary_run_usage(
    UUID, INTEGER, UUID, TEXT, NUMERIC
) TO service_role;
