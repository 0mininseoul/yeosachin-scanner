-- Paid V2 Actor cleanup is a durable, service-only lifecycle. Remote Actor
-- termination must be confirmed before either success or failure purges request staging.

CREATE TABLE public.analysis_v2_provider_cleanup_intents (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    failed_job_key VARCHAR(160) NOT NULL,
    failed_job_input_hash VARCHAR(64) NOT NULL CHECK (
        failed_job_input_hash ~ '^[a-f0-9]{64}$'
    ),
    failed_claim_token UUID NOT NULL,
    error_code VARCHAR(64) NOT NULL CHECK (error_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
    requested_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    completed_at TIMESTAMP WITH TIME ZONE,
    FOREIGN KEY (request_id, failed_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

ALTER TABLE public.analysis_v2_provider_cleanup_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_provider_cleanup_intents FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_provider_cleanup_intents
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_provider_cleanup_intents IS
    'PII-free terminal-failure intent. Recovery may stop only confirmed Actor run IDs; starting rows remain explicit blockers.';

-- This table has intentionally no service-role write path. A database owner may add one
-- row only after checking the exact credential slot, Actor, and reservation time window in
-- Apify and confirming that no active run exists. The provider row remains `starting`, so
-- unknown usage is never rewritten to zero or represented as a fabricated terminal run.
CREATE TABLE public.analysis_v2_unconfirmed_start_resolutions (
    reservation_token UUID PRIMARY KEY
        REFERENCES public.analysis_v2_provider_runs(reservation_token) ON DELETE CASCADE,
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    operation_key VARCHAR(87) NOT NULL,
    input_hash VARCHAR(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
    logical_provider VARCHAR(16) NOT NULL,
    actor_id VARCHAR(200) NOT NULL,
    credential_slot VARCHAR(16) NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    resolution VARCHAR(32) NOT NULL CHECK (resolution = 'confirmed_no_active_run'),
    audit_reason VARCHAR(256) NOT NULL CHECK (
        pg_catalog.char_length(audit_reason) BETWEEN 8 AND 256
    ),
    audit_reference VARCHAR(256) NOT NULL CHECK (
        pg_catalog.char_length(audit_reference) BETWEEN 1 AND 256
    ),
    audited_by VARCHAR(128) NOT NULL CHECK (
        pg_catalog.char_length(audited_by) BETWEEN 1 AND 128
    ),
    database_actor TEXT NOT NULL DEFAULT SESSION_USER CHECK (
        pg_catalog.char_length(database_actor) BETWEEN 1 AND 128
    ),
    confirmed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    FOREIGN KEY (request_id, job_key, operation_key)
        REFERENCES public.analysis_v2_provider_runs(request_id, job_key, operation_key)
        ON DELETE CASCADE
);

ALTER TABLE public.analysis_v2_unconfirmed_start_resolutions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_unconfirmed_start_resolutions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_unconfirmed_start_resolutions
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_validate_unconfirmed_start_resolution()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RESOLUTION_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    SELECT provider_run.* INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.reservation_token = NEW.reservation_token
    FOR UPDATE;
    IF NOT FOUND OR v_run.status <> 'starting' OR v_run.run_id IS NOT NULL
       OR v_run.request_id IS DISTINCT FROM NEW.request_id
       OR v_run.job_key IS DISTINCT FROM NEW.job_key
       OR v_run.operation_key IS DISTINCT FROM NEW.operation_key
       OR v_run.input_hash IS DISTINCT FROM NEW.input_hash
       OR v_run.logical_provider IS DISTINCT FROM NEW.logical_provider
       OR v_run.actor_id IS DISTINCT FROM NEW.actor_id
       OR v_run.credential_slot IS DISTINCT FROM NEW.credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM NEW.max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_RESOLUTION_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    NEW.database_actor := SESSION_USER;
    NEW.confirmed_at := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_validate_unconfirmed_start_resolution()
    FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER analysis_v2_unconfirmed_start_resolution_guard
BEFORE INSERT OR UPDATE ON public.analysis_v2_unconfirmed_start_resolutions
FOR EACH ROW EXECUTE FUNCTION public.analysis_v2_validate_unconfirmed_start_resolution();

COMMENT ON TABLE public.analysis_v2_unconfirmed_start_resolutions IS
    'DB-owner-only external-audit marker; preserves the original ambiguous starting row and unknown usage.';

ALTER FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) RENAME TO analysis_v2_reserve_provider_run_internal;
REVOKE ALL ON FUNCTION public.analysis_v2_reserve_provider_run_internal(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) FROM PUBLIC, anon, authenticated, service_role;

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
BEGIN
    -- Freeze the request before checking the cleanup intent. Once an intent commits,
    -- no sibling job can reserve another paid Actor start.
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

CREATE OR REPLACE FUNCTION public.request_analysis_v2_provider_run_cleanup(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_error_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_intent public.analysis_v2_provider_cleanup_intents%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_error_code IS NULL OR p_error_code !~ '^[A-Z][A-Z0-9_]{2,63}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    -- Preserve the terminal-capable preflight -> request -> job lock order.
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF v_request.id IS NULL OR v_request.status NOT IN ('pending', 'processing')
       OR v_job.request_id IS NULL OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    WHERE intent.request_id = p_request_id FOR UPDATE;
    IF FOUND THEN
        IF v_intent.failed_job_key IS DISTINCT FROM p_job_key
           OR v_intent.failed_job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_intent.error_code IS DISTINCT FROM p_error_code
           OR v_intent.completed_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_INTENT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_provider_cleanup_intents AS intent
        SET failed_claim_token = p_claim_token
        WHERE intent.request_id = p_request_id;
        RETURN TRUE;
    END IF;

    INSERT INTO public.analysis_v2_provider_cleanup_intents (
        request_id, failed_job_key, failed_job_input_hash,
        failed_claim_token, error_code
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash,
        p_claim_token, p_error_code
    );
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.request_analysis_v2_provider_run_cleanup(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_analysis_v2_provider_run_cleanup(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_provider_run_cleanup_intent(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT CASE WHEN intent.request_id IS NULL THEN NULL ELSE
        pg_catalog.jsonb_build_object(
            'requestId', intent.request_id,
            'jobKey', intent.failed_job_key,
            'jobInputHash', intent.failed_job_input_hash,
            'errorCode', intent.error_code
        )
    END
    FROM (SELECT p_request_id AS requested_id) AS requested
    LEFT JOIN public.analysis_v2_provider_cleanup_intents AS intent
      ON intent.request_id = requested.requested_id
     AND intent.completed_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent(UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
    p_request_id UUID DEFAULT NULL,
    p_limit INTEGER DEFAULT 64
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_starting_count INTEGER;
    v_runs JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    IF p_request_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER INTO v_starting_count
    FROM public.analysis_v2_provider_runs AS provider_run
    JOIN public.analysis_v2_provider_cleanup_intents AS intent
      ON intent.request_id = provider_run.request_id
     AND intent.completed_at IS NULL
    LEFT JOIN public.analysis_v2_unconfirmed_start_resolutions AS resolution
      ON resolution.reservation_token = provider_run.reservation_token
    WHERE provider_run.status = 'starting'
      AND resolution.reservation_token IS NULL
      AND (p_request_id IS NULL OR provider_run.request_id = p_request_id);

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            public.analysis_v2_provider_run_json(candidate)
            ORDER BY candidate.reserved_at, candidate.request_id,
                candidate.job_key, candidate.operation_key
        ),
        '[]'::JSONB
    ) INTO v_runs
    FROM (
        SELECT provider_run.*
        FROM public.analysis_v2_provider_runs AS provider_run
        JOIN public.analysis_v2_provider_cleanup_intents AS intent
          ON intent.request_id = provider_run.request_id
         AND intent.completed_at IS NULL
        WHERE provider_run.status = 'running'
          AND (p_request_id IS NULL OR provider_run.request_id = p_request_id)
        ORDER BY provider_run.reserved_at, provider_run.request_id,
            provider_run.job_key, provider_run.operation_key
        LIMIT p_limit
    ) AS candidate;

    RETURN pg_catalog.jsonb_build_object(
        'startingCount', v_starting_count,
        'runs', v_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
    UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
    UUID, INTEGER
) TO service_role;

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
       OR p_credential_slot NOT IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary'
       )
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

-- Result success may leave terminal usage unreconciled, but never an active Actor.
CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_profile_image_url TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF pg_catalog.to_regclass(
        'public.analysis_v2_ai_scoring_stage_checkpoints'
    ) IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
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
    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.status IN ('starting', 'running')
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_complete_result_and_purge_internal(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash,
        p_target_profile_image_url
    );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;

ALTER FUNCTION public.fail_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) RENAME TO analysis_v2_fail_result_and_purge_internal;
REVOKE ALL ON FUNCTION public.analysis_v2_fail_result_and_purge_internal(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fail_analysis_v2_result_and_purge(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_error_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_intent public.analysis_v2_provider_cleanup_intents%ROWTYPE;
    v_result JSONB;
BEGIN
    -- Freeze new starts with the same canonical lock order before checking cleanup.
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    WHERE intent.request_id = p_request_id FOR UPDATE;
    IF v_intent.request_id IS NULL
       OR v_intent.failed_job_key IS DISTINCT FROM p_job_key
       OR v_intent.failed_job_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_intent.failed_claim_token IS DISTINCT FROM p_claim_token
       OR v_intent.error_code IS DISTINCT FROM p_error_code
       OR v_intent.completed_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND (
            provider_run.status = 'running'
            OR (
                provider_run.status = 'starting'
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_unconfirmed_start_resolutions AS resolution
                    WHERE resolution.reservation_token = provider_run.reservation_token
                )
            )
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;

    v_result := public.analysis_v2_fail_result_and_purge_internal(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash, p_error_code
    );
    UPDATE public.analysis_v2_provider_cleanup_intents AS intent
    SET completed_at = pg_catalog.clock_timestamp()
    WHERE intent.request_id = p_request_id;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.list_analysis_v2_active_provider_runs_for_cleanup(
    UUID, INTEGER
) IS 'Lists bounded confirmed running IDs only for durable cleanup intents; separately reports unconfirmed starts.';
COMMENT ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) IS 'Seals a remotely confirmed terminal Actor behind immutable billing identity without a live job lease.';
COMMENT ON FUNCTION public.fail_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) IS 'Fails and purges only after every paid V2 Actor is terminal; unconfirmed starts fail closed.';
