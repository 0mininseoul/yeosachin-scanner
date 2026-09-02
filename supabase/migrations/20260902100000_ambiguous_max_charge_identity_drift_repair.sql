-- MIGRATION_PREDECESSOR=20260902091001
-- Retain an anonymous preflight whose provider input cannot be reconciled with
-- the preflight target identity.  This is an owner-only, seven-day fail-closed
-- repair: it never invents a provider run and retains the original receipts.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflight_provider_runs
    DROP CONSTRAINT analysis_preflight_provider_run_status_check,
    DROP CONSTRAINT analysis_preflight_provider_run_state_check,
    ADD CONSTRAINT analysis_preflight_provider_run_status_check CHECK (
        status IN (
            'starting', 'running', 'rejected', 'succeeded', 'failed', 'aborted',
            'timed_out', 'resolved_no_run', 'resolved_identity_drift'
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
        OR (
            status = 'resolved_identity_drift'
            AND run_id IS NULL
            AND run_started_at IS NULL
            AND terminalized_at IS NOT NULL
            AND actual_usage_usd = max_charge_usd
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
        'rejected', 'succeeded', 'failed', 'aborted', 'timed_out',
        'resolved_no_run', 'resolved_identity_drift'
    );

ALTER TABLE public.analysis_preflight_acquisition_cost_events
    DROP CONSTRAINT analysis_preflight_acquisition_cost_event_kind_check,
    DROP CONSTRAINT analysis_preflight_acquisition_cost_event_state_check,
    ADD CONSTRAINT analysis_preflight_acquisition_cost_event_kind_check CHECK (
        event_kind IN (
            'provider_run', 'manual_no_run', 'provider_start_rejected',
            'provider_start_identity_drift'
        )
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
        OR (
            event_kind = 'provider_start_identity_drift'
            AND logical_provider = 'apify'
            AND actor_id = 'apify/instagram-profile-scraper'
            AND public.analysis_v2_valid_apify_credential_slot(credential_slot)
            AND terminal_status = 'resolved_identity_drift'
            AND max_charge_usd = 0.002600000000
            AND actual_usage_usd = max_charge_usd
            AND evidence_reference_hash ~ '^[0-9a-f]{64}$'
        )
    );

CREATE OR REPLACE FUNCTION public.record_analysis_preflight_identity_drift_cost_event(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reserved_at TIMESTAMP WITH TIME ZONE,
    p_evidence_reference_hash TEXT,
    p_resolution_date DATE
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
       OR p_operation_key IS DISTINCT FROM 'target-profile-fallback'
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_reserved_at IS NULL
       OR p_evidence_reference_hash IS NULL
       OR p_evidence_reference_hash !~ '^[0-9a-f]{64}$'
       OR p_resolution_date IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_COST_EVENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_billing_identity_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'provider_start_identity_drift:v1:'
                    || p_preflight_id::TEXT || ':'
                    || p_operation_key || ':'
                    || p_input_hash || ':'
                    || p_logical_provider || ':'
                    || p_actor_id || ':'
                    || p_credential_slot || ':'
                    || p_max_charge_usd::TEXT || ':'
                    || pg_catalog.to_char(
                        p_reserved_at AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US'
                    ) || ':'
                    || p_evidence_reference_hash || ':'
                    || p_resolution_date::TEXT,
                'UTF8'
            ),
            'sha256'
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
        'provider_start_identity_drift',
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        'resolved_identity_drift',
        p_max_charge_usd,
        p_max_charge_usd,
        p_evidence_reference_hash,
        p_resolution_date
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

    -- The event contract intentionally records actual_usage_usd = max_charge_usd.
    IF NOT FOUND
       OR v_event.billing_identity_hash IS DISTINCT FROM v_billing_identity_hash
       OR v_event.event_kind IS DISTINCT FROM 'provider_start_identity_drift'
       OR v_event.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_event.actor_id IS DISTINCT FROM p_actor_id
       OR v_event.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_event.terminal_status IS DISTINCT FROM 'resolved_identity_drift'
       OR v_event.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_event.actual_usage_usd IS DISTINCT FROM p_max_charge_usd
       OR v_event.evidence_reference_hash IS DISTINCT FROM p_evidence_reference_hash
       OR v_event.event_date IS DISTINCT FROM p_resolution_date THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_preflight_identity_drift_cost_event(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE, TEXT, DATE
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_analysis_preflight_ambiguous_identity_drift_candidates(
    p_limit INTEGER DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_candidates JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    WITH candidates AS (
        SELECT provider_run.*
        FROM public.analysis_preflight_provider_runs AS provider_run
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = provider_run.preflight_id
        WHERE provider_run.status = 'starting'
          AND provider_run.run_id IS NULL
          AND preflight.user_id IS NULL
          AND preflight.provider_selector = 'anonymous_apify'
          AND preflight.status = 'expired'
          AND preflight.pii_scrubbed_at IS NOT NULL
          AND preflight.expires_at <= v_now - INTERVAL '7 days'
          AND preflight.updated_at <= v_now - INTERVAL '7 days'
          AND preflight.target_input_hash IS NOT NULL
          AND provider_run.input_hash IS DISTINCT FROM preflight.target_input_hash
          AND provider_run.operation_key = 'target-profile-fallback'
          AND provider_run.reserved_at <= v_now - INTERVAL '7 days'
          AND provider_run.updated_at <= v_now - INTERVAL '7 days'
          AND (preflight.lease_expires_at IS NULL OR preflight.lease_expires_at <= v_now)
          AND (
              preflight.admission_lease_expires_at IS NULL
              OR preflight.admission_lease_expires_at <= v_now
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_provider_admission_leases AS admission
              WHERE admission.request_id = provider_run.preflight_id
                AND admission.logical_provider = provider_run.logical_provider
                AND admission.credential_slot = provider_run.credential_slot
                AND admission.state IN ('leased', 'recovery_required')
                AND admission.expires_at > v_now
          )
          AND EXISTS (
              SELECT 1
              FROM public.analysis_preflight_failures AS failure
              WHERE failure.preflight_id = provider_run.preflight_id
                AND failure.error_code = 'INTERNAL_ERROR'
          )
        ORDER BY provider_run.reserved_at,
            provider_run.preflight_id,
            provider_run.operation_key
        LIMIT p_limit
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'preflightId', candidate.preflight_id,
                'operationKey', candidate.operation_key,
                'inputHash', candidate.input_hash,
                'logicalProvider', candidate.logical_provider,
                'actorId', candidate.actor_id,
                'credentialSlot', candidate.credential_slot,
                'maxChargeUsd', candidate.max_charge_usd,
                'reservedAt', candidate.reserved_at
            ) ORDER BY candidate.reserved_at,
                candidate.preflight_id,
                candidate.operation_key
        ),
        '[]'::JSONB
    ) INTO v_candidates
    FROM candidates AS candidate;
    RETURN v_candidates;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_preflight_ambiguous_identity_drift_candidates(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_analysis_preflight_provider_run_identity_drift(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reserved_at TIMESTAMP WITH TIME ZONE,
    p_evidence_reference_hash TEXT
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
       OR p_operation_key IS DISTINCT FROM 'target-profile-fallback'
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_reserved_at IS NULL
       OR p_evidence_reference_hash IS NULL
       OR p_evidence_reference_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_INVALID',
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

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.operation_key IS DISTINCT FROM p_operation_key
       OR v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_run.reserved_at IS DISTINCT FROM p_reserved_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.user_id IS NOT NULL
       OR v_preflight.provider_selector IS DISTINCT FROM 'anonymous_apify'
       OR v_preflight.status IS DISTINCT FROM 'expired'
       OR v_preflight.pii_scrubbed_at IS NULL
       OR v_preflight.target_input_hash IS NULL
       OR v_run.input_hash IS NOT DISTINCT FROM v_preflight.target_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_CANDIDATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_preflight_failures AS failure
        WHERE failure.preflight_id = v_run.preflight_id
          AND failure.error_code = 'INTERNAL_ERROR'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_CANDIDATE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'resolved_identity_drift' THEN
        IF v_run.run_id IS NOT NULL
           OR v_run.run_started_at IS NOT NULL
           OR v_run.terminalized_at IS NULL
           OR v_run.actual_usage_usd IS DISTINCT FROM v_run.max_charge_usd
           OR v_run.usage_reconciled_at IS NULL
           OR v_run.usage_reconciliation_attempt_count IS DISTINCT FROM 0
           OR v_run.usage_reconciliation_attempted_at IS NOT NULL
           OR v_run.manual_resolution_evidence_hash IS DISTINCT FROM p_evidence_reference_hash
           OR v_run.manual_resolved_at IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_RESOLUTION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        IF v_run.status IS DISTINCT FROM 'starting'
           OR v_run.run_id IS NOT NULL
           OR v_run.run_started_at IS NOT NULL
           OR v_run.terminalized_at IS NOT NULL
           OR v_run.actual_usage_usd IS NOT NULL
           OR v_run.usage_reconciled_at IS NOT NULL
           OR v_run.usage_reconciliation_attempt_count IS DISTINCT FROM 0
           OR v_run.usage_reconciliation_attempted_at IS NOT NULL
           OR v_run.manual_resolution_evidence_hash IS NOT NULL
           OR v_run.manual_resolved_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_STATE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        IF NOT (
            v_preflight.expires_at <= v_now - INTERVAL '7 days'
            AND v_preflight.updated_at <= v_now - INTERVAL '7 days'
            AND v_run.reserved_at <= v_now - INTERVAL '7 days'
            AND v_run.updated_at <= v_now - INTERVAL '7 days'
            AND (v_preflight.lease_expires_at IS NULL OR v_preflight.lease_expires_at <= v_now)
            AND (
                v_preflight.admission_lease_expires_at IS NULL
                OR v_preflight.admission_lease_expires_at <= v_now
            )
            AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_provider_admission_leases AS admission
                WHERE admission.request_id = v_run.preflight_id
                  AND admission.logical_provider = v_run.logical_provider
                  AND admission.credential_slot = v_run.credential_slot
                  AND admission.state IN ('leased', 'recovery_required')
                  AND admission.expires_at > v_now
            )
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_IDENTITY_DRIFT_NOT_READY',
                ERRCODE = 'P0001';
        END IF;

        UPDATE public.analysis_preflight_provider_runs AS provider_run
        SET status = 'resolved_identity_drift',
            actual_usage_usd = v_run.max_charge_usd,
            terminalized_at = v_now,
            usage_reconciled_at = v_now,
            manual_resolution_evidence_hash = p_evidence_reference_hash,
            manual_resolved_at = v_now,
            updated_at = v_now
        WHERE provider_run.preflight_id = p_preflight_id
          AND provider_run.operation_key = p_operation_key
        RETURNING provider_run.* INTO v_run;
    END IF;

    PERFORM public.record_analysis_preflight_identity_drift_cost_event(
        v_run.preflight_id,
        v_run.operation_key,
        v_run.input_hash,
        v_run.logical_provider,
        v_run.actor_id,
        v_run.credential_slot,
        v_run.max_charge_usd,
        v_run.reserved_at,
        v_run.manual_resolution_evidence_hash,
        (v_run.manual_resolved_at AT TIME ZONE 'UTC')::DATE
    );
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_preflight_provider_run_identity_drift(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.list_analysis_preflight_ambiguous_start_candidates(
    p_limit INTEGER DEFAULT 20
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_candidates JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_INVALID',
            ERRCODE = 'P0001';
    END IF;
    WITH candidates AS (
        SELECT provider_run.*
        FROM public.analysis_preflight_provider_runs AS provider_run
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = provider_run.preflight_id
        WHERE provider_run.status = 'starting'
          AND provider_run.run_id IS NULL
          AND provider_run.reserved_at <= v_now - INTERVAL '30 minutes'
          AND provider_run.updated_at <= v_now - INTERVAL '30 minutes'
          AND preflight.expires_at <= v_now
          AND (preflight.lease_expires_at IS NULL OR preflight.lease_expires_at <= v_now)
          AND (
              preflight.admission_lease_expires_at IS NULL
              OR preflight.admission_lease_expires_at <= v_now
          )
          AND NOT (
              preflight.user_id IS NULL
              AND preflight.provider_selector = 'anonymous_apify'
              AND preflight.target_input_hash IS NOT NULL
              AND provider_run.input_hash IS DISTINCT FROM preflight.target_input_hash
          )
        ORDER BY provider_run.reserved_at,
            provider_run.preflight_id,
            provider_run.operation_key
        LIMIT p_limit
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'preflightId', candidate.preflight_id,
                'operationKey', candidate.operation_key,
                'inputHash', candidate.input_hash,
                'logicalProvider', candidate.logical_provider,
                'actorId', candidate.actor_id,
                'credentialSlot', candidate.credential_slot,
                'maxChargeUsd', candidate.max_charge_usd,
                'reservedAt', candidate.reserved_at
            ) ORDER BY candidate.reserved_at,
                candidate.preflight_id,
                candidate.operation_key
        ),
        '[]'::JSONB
    ) INTO v_candidates
    FROM candidates AS candidate;
    RETURN v_candidates;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_preflight_ambiguous_start_candidates(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_preflight_ambiguous_start_candidates(INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.resolve_analysis_preflight_provider_run_no_run(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reserved_at TIMESTAMP WITH TIME ZONE,
    p_evidence_reference_hash TEXT
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
       OR NOT (
            p_operation_key = 'target-profile-fallback'
            OR p_operation_key ~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$'
       )
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_reserved_at IS NULL
       OR p_evidence_reference_hash IS NULL
       OR p_evidence_reference_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_INVALID',
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

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_run.reserved_at IS DISTINCT FROM p_reserved_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.user_id IS NULL
       AND v_preflight.provider_selector = 'anonymous_apify'
       AND v_preflight.target_input_hash IS NOT NULL
       AND v_run.input_hash IS DISTINCT FROM v_preflight.target_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_IDENTITY_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'resolved_no_run' THEN
        IF v_run.run_id IS NOT NULL
           OR v_run.actual_usage_usd IS DISTINCT FROM 0
           OR v_run.manual_resolution_evidence_hash IS DISTINCT FROM p_evidence_reference_hash
           OR v_run.manual_resolved_at IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_RESOLUTION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        IF v_run.status IS DISTINCT FROM 'starting'
           OR v_run.run_id IS NOT NULL
           OR v_run.run_started_at IS NOT NULL
           OR v_run.terminalized_at IS NOT NULL
           OR v_run.actual_usage_usd IS NOT NULL
           OR v_run.usage_reconciled_at IS NOT NULL
           OR v_run.manual_resolution_evidence_hash IS NOT NULL
           OR v_run.manual_resolved_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_STATE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        IF v_run.reserved_at > v_now - INTERVAL '30 minutes'
           OR v_run.updated_at > v_now - INTERVAL '30 minutes'
           OR v_preflight.expires_at > v_now
           OR (v_preflight.lease_expires_at IS NOT NULL AND v_preflight.lease_expires_at > v_now)
           OR (
                v_preflight.admission_lease_expires_at IS NOT NULL
                AND v_preflight.admission_lease_expires_at > v_now
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_NOT_READY',
                ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_preflight_provider_runs AS provider_run
        SET status = 'resolved_no_run',
            actual_usage_usd = 0,
            terminalized_at = v_now,
            usage_reconciled_at = v_now,
            manual_resolution_evidence_hash = p_evidence_reference_hash,
            manual_resolved_at = v_now,
            updated_at = v_now
        WHERE provider_run.preflight_id = p_preflight_id
          AND provider_run.operation_key = p_operation_key
        RETURNING provider_run.* INTO v_run;
    END IF;

    IF v_run.operation_key = 'target-profile-fallback' THEN
        PERFORM public.record_analysis_preflight_manual_no_run_cost_event(
            v_run.preflight_id, v_run.manual_resolution_evidence_hash,
            v_run.logical_provider, v_run.actor_id, v_run.credential_slot,
            (v_run.manual_resolved_at AT TIME ZONE 'UTC')::DATE
        );
    ELSE
        PERFORM public.record_analysis_preflight_manual_no_run_cost_event_for_operation(
            v_run.preflight_id, v_run.operation_key,
            v_run.manual_resolution_evidence_hash, v_run.logical_provider,
            v_run.actor_id, v_run.credential_slot,
            (v_run.manual_resolved_at AT TIME ZONE 'UTC')::DATE
        );
    END IF;
    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_preflight_provider_run_no_run(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.resolve_analysis_preflight_provider_run_identity_drift(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE, TEXT
) IS
    'Owner-only seven-day fail-closed repair for retained anonymous provider identity drift.';

COMMIT;
