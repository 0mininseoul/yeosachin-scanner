-- Persist an Apify API rejection only when the API definitively refused to create a run.
-- Transport ambiguity keeps the existing `starting` state and is never handled by these RPCs.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_v2_provider_runs
    DROP CONSTRAINT analysis_v2_provider_run_status_check,
    DROP CONSTRAINT analysis_v2_provider_run_state_check,
    ADD CONSTRAINT analysis_v2_provider_run_status_check CHECK (
        status IN ('starting', 'running', 'rejected', 'succeeded', 'failed', 'aborted', 'timed_out')
    ),
    ADD CONSTRAINT analysis_v2_provider_run_state_check CHECK (
        (
            status = 'starting'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND terminalized_at IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
        )
        OR (
            status = 'running'
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND terminalized_at IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
        )
        OR (
            status = 'rejected'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND terminalized_at IS NOT NULL
            AND actual_usage_usd = 0
            AND usage_reconciled_at IS NOT NULL
        )
        OR (
            status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND terminalized_at IS NOT NULL
            AND (
                (actual_usage_usd IS NULL AND usage_reconciled_at IS NULL)
                OR (actual_usage_usd IS NOT NULL AND usage_reconciled_at IS NOT NULL)
            )
        )
    );

ALTER TABLE public.analysis_preflight_provider_runs
    DROP CONSTRAINT analysis_preflight_provider_run_status_check,
    DROP CONSTRAINT analysis_preflight_provider_run_state_check,
    ADD CONSTRAINT analysis_preflight_provider_run_status_check CHECK (
        status IN (
            'starting', 'running', 'rejected', 'succeeded', 'failed', 'aborted',
            'timed_out', 'resolved_no_run'
        )
    ),
    ADD CONSTRAINT analysis_preflight_provider_run_state_check CHECK (
        (
            status = 'starting'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND terminalized_at IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
            AND usage_reconciliation_attempt_count = 0
            AND usage_reconciliation_attempted_at IS NULL
            AND manual_resolution_evidence_hash IS NULL
            AND manual_resolved_at IS NULL
        )
        OR (
            status = 'running'
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND terminalized_at IS NULL
            AND actual_usage_usd IS NULL
            AND usage_reconciled_at IS NULL
            AND manual_resolution_evidence_hash IS NULL
            AND manual_resolved_at IS NULL
        )
        OR (
            status = 'rejected'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND terminalized_at IS NOT NULL
            AND actual_usage_usd = 0
            AND usage_reconciled_at IS NOT NULL
            AND usage_reconciliation_attempt_count = 0
            AND usage_reconciliation_attempted_at IS NULL
            AND manual_resolution_evidence_hash IS NULL
            AND manual_resolved_at IS NULL
        )
        OR (
            status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND terminalized_at IS NOT NULL
            AND (
                (actual_usage_usd IS NULL AND usage_reconciled_at IS NULL)
                OR (actual_usage_usd IS NOT NULL AND usage_reconciled_at IS NOT NULL)
            )
            AND manual_resolution_evidence_hash IS NULL
            AND manual_resolved_at IS NULL
        )
        OR (
            status = 'resolved_no_run'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND terminalized_at IS NOT NULL
            AND actual_usage_usd = 0
            AND usage_reconciled_at IS NOT NULL
            AND usage_reconciliation_attempt_count = 0
            AND usage_reconciliation_attempted_at IS NULL
            AND manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'
            AND manual_resolved_at IS NOT NULL
        )
    );

DROP INDEX IF EXISTS public.idx_analysis_preflight_provider_runs_terminal;
CREATE INDEX idx_analysis_preflight_provider_runs_terminal
    ON public.analysis_preflight_provider_runs(status, terminalized_at, preflight_id)
    WHERE status IN (
        'rejected', 'succeeded', 'failed', 'aborted', 'timed_out', 'resolved_no_run'
    );

ALTER TABLE public.analysis_preflight_acquisition_cost_events
    DROP CONSTRAINT analysis_preflight_acquisition_cost_event_kind_check,
    DROP CONSTRAINT analysis_preflight_acquisition_cost_event_state_check,
    ADD CONSTRAINT analysis_preflight_acquisition_cost_event_kind_check CHECK (
        event_kind IN ('provider_run', 'manual_no_run', 'provider_start_rejected')
    ),
    ADD CONSTRAINT analysis_preflight_acquisition_cost_event_state_check CHECK (
        (
            event_kind = 'provider_run'
            AND logical_provider = 'apify'
            AND actor_id = 'apify/instagram-profile-scraper'
            AND public.analysis_v2_valid_apify_credential_slot(credential_slot)
            AND terminal_status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND max_charge_usd = 0.002600000000
            AND actual_usage_usd BETWEEN 0 AND max_charge_usd + 0.000000001
            AND evidence_reference_hash IS NULL
        )
        OR (
            event_kind = 'manual_no_run'
            AND logical_provider = 'apify'
            AND actor_id = 'apify/instagram-profile-scraper'
            AND public.analysis_v2_valid_apify_credential_slot(credential_slot)
            AND terminal_status = 'resolved_no_run'
            AND max_charge_usd = 0
            AND actual_usage_usd = 0
            AND evidence_reference_hash ~ '^[0-9a-f]{64}$'
        )
        OR (
            event_kind = 'provider_start_rejected'
            AND logical_provider = 'apify'
            AND actor_id = 'apify/instagram-profile-scraper'
            AND public.analysis_v2_valid_apify_credential_slot(credential_slot)
            AND terminal_status = 'rejected'
            AND max_charge_usd = 0
            AND actual_usage_usd = 0
            AND evidence_reference_hash IS NULL
        )
    );

CREATE OR REPLACE FUNCTION public.record_analysis_preflight_provider_start_rejected_cost_event(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_rejection_date DATE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_billing_identity_hash TEXT;
    v_event public.analysis_preflight_acquisition_cost_events%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_operation_key IS NULL
       OR (
            p_operation_key <> 'target-profile-fallback'
            AND p_operation_key !~ '^target-profile-fresh-admission:g(?:[1-9]|[1-9][0-9]|100)$'
       )
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_rejection_date IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_billing_identity_hash := pg_catalog.encode(
        pg_catalog.sha256(
            pg_catalog.convert_to(
                'provider_start_rejected:v1:' || p_preflight_id::TEXT || ':'
                    || p_operation_key || ':' || p_logical_provider || ':'
                    || p_actor_id || ':' || p_credential_slot,
                'UTF8'
            )
        ),
        'hex'
    );

    INSERT INTO public.analysis_preflight_acquisition_cost_events (
        billing_identity_hash,
        event_kind,
        logical_provider,
        actor_id,
        credential_slot,
        terminal_status,
        max_charge_usd,
        actual_usage_usd,
        evidence_reference_hash,
        event_date
    ) VALUES (
        v_billing_identity_hash,
        'provider_start_rejected',
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        'rejected',
        0,
        0,
        NULL,
        p_rejection_date
    )
    ON CONFLICT (billing_identity_hash) DO NOTHING
    RETURNING * INTO v_event;

    IF FOUND THEN
        RETURN;
    END IF;

    SELECT event.*
    INTO v_event
    FROM public.analysis_preflight_acquisition_cost_events AS event
    WHERE event.billing_identity_hash = v_billing_identity_hash
    FOR UPDATE;

    IF NOT FOUND
       OR v_event.event_kind IS DISTINCT FROM 'provider_start_rejected'
       OR v_event.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_event.actor_id IS DISTINCT FROM p_actor_id
       OR v_event.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_event.terminal_status IS DISTINCT FROM 'rejected'
       OR v_event.max_charge_usd IS DISTINCT FROM 0
       OR v_event.actual_usage_usd IS DISTINCT FROM 0
       OR v_event.evidence_reference_hash IS NOT NULL
       OR v_event.event_date IS DISTINCT FROM p_rejection_date THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_preflight_provider_start_rejected_cost_event(
    UUID, TEXT, TEXT, TEXT, TEXT, DATE
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reject_analysis_v2_provider_run_start(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_reservation_token UUID,
    p_logical_provider TEXT,
    p_actor_id TEXT,
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
    v_preflight_id UUID;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_operation_key IS NULL
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_reservation_token IS NULL
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL
       OR pg_catalog.char_length(p_actor_id) NOT BETWEEN 3 AND 200
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL
       OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.id
    INTO v_preflight_id
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_ACTIVE', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_run.job_claim_token IS DISTINCT FROM p_claim_token
       OR v_run.reservation_token IS DISTINCT FROM p_reservation_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'rejected' THEN
        RETURN public.analysis_v2_provider_run_json(v_run);
    END IF;
    IF v_run.status IS DISTINCT FROM 'starting' OR v_run.run_id IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET status = 'rejected',
        terminalized_at = v_now,
        actual_usage_usd = 0,
        usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    RETURNING provider_run.* INTO v_run;

    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_analysis_v2_provider_run_start(
    UUID, TEXT, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_analysis_v2_provider_run_start(
    UUID, TEXT, UUID, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.reject_analysis_preflight_provider_run_start(
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
    v_operation_key TEXT := 'target-profile-fallback';
    v_preflight public.analysis_preflights%ROWTYPE;
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status IS DISTINCT FROM 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.logical_provider IS DISTINCT FROM 'apify'
       OR v_run.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'rejected' THEN
        PERFORM public.record_analysis_preflight_provider_start_rejected_cost_event(
            p_preflight_id, v_operation_key, v_run.logical_provider, v_run.actor_id,
            v_run.credential_slot, (v_run.terminalized_at AT TIME ZONE 'UTC')::DATE
        );
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;
    IF v_run.status IS DISTINCT FROM 'starting' OR v_run.run_id IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET status = 'rejected',
        terminalized_at = v_now,
        actual_usage_usd = 0,
        usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    RETURNING provider_run.* INTO v_run;

    PERFORM public.record_analysis_preflight_provider_start_rejected_cost_event(
        p_preflight_id, v_operation_key, v_run.logical_provider, v_run.actor_id,
        v_run.credential_slot, (v_run.terminalized_at AT TIME ZONE 'UTC')::DATE
    );
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_analysis_preflight_provider_run_start(
    UUID, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_analysis_preflight_provider_run_start(
    UUID, UUID, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.reject_analysis_v2_fresh_admission_provider_run_start(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
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
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    v_operation_key := 'target-profile-fresh-admission:g'
        || p_admission_generation::TEXT;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation
       OR v_preflight.admission_status IS DISTINCT FROM 'processing'
       OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token
       OR v_preflight.admission_lease_expires_at IS NULL
       OR v_preflight.admission_lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.logical_provider IS DISTINCT FROM 'apify'
       OR v_run.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'rejected' THEN
        PERFORM public.record_analysis_preflight_provider_start_rejected_cost_event(
            p_preflight_id, v_operation_key, v_run.logical_provider, v_run.actor_id,
            v_run.credential_slot, (v_run.terminalized_at AT TIME ZONE 'UTC')::DATE
        );
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;
    IF v_run.status IS DISTINCT FROM 'starting' OR v_run.run_id IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET status = 'rejected',
        terminalized_at = v_now,
        actual_usage_usd = 0,
        usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = v_operation_key
    RETURNING provider_run.* INTO v_run;

    PERFORM public.record_analysis_preflight_provider_start_rejected_cost_event(
        p_preflight_id, v_operation_key, v_run.logical_provider, v_run.actor_id,
        v_run.credential_slot, (v_run.terminalized_at AT TIME ZONE 'UTC')::DATE
    );
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reject_analysis_v2_fresh_admission_provider_run_start(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reject_analysis_v2_fresh_admission_provider_run_start(
    UUID, INTEGER, UUID, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_preflights(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_scrubbed_count INTEGER;
    v_deleted_count INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_MAINTENANCE_INPUT', ERRCODE = 'P0001';
    END IF;

    WITH expired AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status <> 'consumed'
          AND preflight.expires_at <= pg_catalog.clock_timestamp()
          AND preflight.pii_scrubbed_at IS NULL
        ORDER BY preflight.expires_at, preflight.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired',
        target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20),
        target_full_name = NULL,
        target_bio = NULL,
        target_profile_image_url = NULL,
        target_followers_count = NULL,
        target_following_count = NULL,
        target_is_private = NULL,
        capacity_required_plan_id = NULL,
        required_plan_id = NULL,
        plan_cards_snapshot = NULL,
        error_code = NULL,
        blocked_at = NULL,
        ready_at = NULL,
        exclusion_decision = 'skip',
        excluded_instagram_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        pii_scrubbed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    FROM expired
    WHERE preflight.id = expired.id;

    GET DIAGNOSTICS v_scrubbed_count = ROW_COUNT;

    WITH deletable AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status = 'expired'
          AND preflight.created_at <= pg_catalog.clock_timestamp() - INTERVAL '1 hour'
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_preflight_provider_runs AS provider_run
              WHERE provider_run.preflight_id = preflight.id
                AND (
                    provider_run.status NOT IN (
                        'rejected', 'succeeded', 'failed', 'aborted', 'timed_out',
                        'resolved_no_run'
                    )
                    OR provider_run.actual_usage_usd IS NULL
                    OR provider_run.usage_reconciled_at IS NULL
                )
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_orders AS earlybird_order
              WHERE earlybird_order.preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_waitlist AS waitlist_entry
              WHERE waitlist_entry.preflight_id = preflight.id
          )
        ORDER BY preflight.created_at, preflight.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.analysis_preflights AS preflight
    USING deletable
    WHERE preflight.id = deletable.id;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_scrubbed_count + v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER) IS
    'Scrubs expired PII and retains tombstones only for unsettled provider usage or commercial references.';
