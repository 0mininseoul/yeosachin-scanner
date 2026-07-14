-- Durable, preflight-scoped intent ledger for the single paid Apify profile fallback.
-- A row is committed before the Actor start. If the start response is lost, the persisted
-- `starting` row intentionally remains ambiguous and can never be replaced by another intent.

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID PRIMARY KEY
        REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL DEFAULT 'target-profile-fallback',
    input_hash VARCHAR(64) NOT NULL,
    logical_provider TEXT NOT NULL DEFAULT 'apify',
    actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper',
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    run_id VARCHAR(64),
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    run_started_at TIMESTAMP WITH TIME ZONE,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    usage_reconciliation_attempt_count INTEGER NOT NULL DEFAULT 0,
    usage_reconciliation_attempted_at TIMESTAMP WITH TIME ZONE,
    manual_resolution_evidence_hash VARCHAR(64),
    manual_resolved_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (run_id),
    CONSTRAINT analysis_preflight_provider_run_operation_check CHECK (
        operation_key = 'target-profile-fallback'
    ),
    CONSTRAINT analysis_preflight_provider_run_input_hash_check CHECK (
        input_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_preflight_provider_run_provider_check CHECK (
        logical_provider = 'apify'
    ),
    CONSTRAINT analysis_preflight_provider_run_actor_check CHECK (
        actor_id = 'apify/instagram-profile-scraper'
    ),
    CONSTRAINT analysis_preflight_provider_run_credential_check CHECK (
        public.analysis_v2_valid_apify_credential_slot(credential_slot)
    ),
    CONSTRAINT analysis_preflight_provider_run_status_check CHECK (
        status IN (
            'starting', 'running', 'succeeded', 'failed', 'aborted', 'timed_out',
            'resolved_no_run'
        )
    ),
    CONSTRAINT analysis_preflight_provider_run_run_id_check CHECK (
        run_id IS NULL OR run_id ~ '^[A-Za-z0-9]{8,64}$'
    ),
    CONSTRAINT analysis_preflight_provider_run_cost_check CHECK (
        max_charge_usd = 0.002600000000
        AND (
            actual_usage_usd IS NULL
            OR (
                actual_usage_usd BETWEEN 0 AND 100000
                AND actual_usage_usd <= max_charge_usd + 0.000000001
            )
        )
    ),
    CONSTRAINT analysis_preflight_provider_run_state_check CHECK (
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
    ),
    CONSTRAINT analysis_preflight_provider_run_time_check CHECK (
        updated_at >= reserved_at
        AND (run_started_at IS NULL OR run_started_at >= reserved_at)
        AND (terminalized_at IS NULL OR terminalized_at >= run_started_at)
        AND (usage_reconciled_at IS NULL OR usage_reconciled_at >= terminalized_at)
        AND (manual_resolved_at IS NULL OR manual_resolved_at >= reserved_at)
        AND (manual_resolved_at IS NULL OR terminalized_at = manual_resolved_at)
        AND (manual_resolved_at IS NULL OR usage_reconciled_at = manual_resolved_at)
        AND (
            usage_reconciliation_attempted_at IS NULL
            OR usage_reconciliation_attempted_at >= run_started_at
        )
    ),
    CONSTRAINT analysis_preflight_provider_run_usage_attempt_count_check CHECK (
        usage_reconciliation_attempt_count BETWEEN 0 AND 100000
    )
);

CREATE INDEX idx_analysis_preflight_provider_runs_terminal
    ON public.analysis_preflight_provider_runs(status, terminalized_at, preflight_id)
    WHERE status IN ('succeeded', 'failed', 'aborted', 'timed_out', 'resolved_no_run');

CREATE INDEX idx_analysis_preflight_provider_runs_reconciliation
    ON public.analysis_preflight_provider_runs(
        usage_reconciliation_attempted_at,
        run_started_at,
        terminalized_at,
        preflight_id
    )
    WHERE status IN ('running', 'succeeded', 'failed', 'aborted', 'timed_out')
      AND actual_usage_usd IS NULL
      AND usage_reconciled_at IS NULL;

CREATE INDEX idx_analysis_preflight_provider_runs_ambiguous_start
    ON public.analysis_preflight_provider_runs(reserved_at, updated_at, preflight_id)
    WHERE status = 'starting' AND run_id IS NULL;

COMMENT ON TABLE public.analysis_preflight_provider_runs IS
    'RPC-only, PII-free intent and cost ledger for the single preflight Apify profile fallback.';
COMMENT ON COLUMN public.analysis_preflight_provider_runs.input_hash IS
    'SHA-256 of the canonical profile request. The username and provider input are never stored.';
COMMENT ON COLUMN public.analysis_preflight_provider_runs.status IS
    'A replayed starting row without a run ID is ambiguous and must never authorize another Actor start.';
COMMENT ON COLUMN public.analysis_preflight_provider_runs.manual_resolution_evidence_hash IS
    'SHA-256 of an external no-run evidence reference; the reference itself is never stored.';

ALTER TABLE public.analysis_preflight_provider_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_preflight_provider_runs FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_preflight_provider_runs
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_preflight_acquisition_cost_events (
    billing_identity_hash VARCHAR(64) PRIMARY KEY,
    event_kind TEXT NOT NULL,
    logical_provider TEXT,
    actor_id TEXT,
    credential_slot TEXT,
    terminal_status TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    actual_usage_usd NUMERIC(18, 12) NOT NULL,
    evidence_reference_hash VARCHAR(64),
    event_date DATE NOT NULL,
    recorded_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_preflight_acquisition_cost_event_hash_check CHECK (
        billing_identity_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_preflight_acquisition_cost_event_kind_check CHECK (
        event_kind IN ('provider_run', 'manual_no_run')
    ),
    CONSTRAINT analysis_preflight_acquisition_cost_event_state_check CHECK (
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
    )
);

CREATE INDEX idx_analysis_preflight_acquisition_cost_events_period
    ON public.analysis_preflight_acquisition_cost_events(
        event_date,
        event_kind,
        logical_provider,
        credential_slot,
        terminal_status
    );

COMMENT ON TABLE public.analysis_preflight_acquisition_cost_events IS
    'Long-lived PII-free acquisition cost facts. Provider run IDs are stored only as domain-separated SHA-256 hashes.';
COMMENT ON COLUMN public.analysis_preflight_acquisition_cost_events.billing_identity_hash IS
    'Domain-separated SHA-256 billing identity; never a raw run, preflight, user, or input identifier.';
COMMENT ON COLUMN public.analysis_preflight_acquisition_cost_events.event_date IS
    'Provider terminal date for provider_run events or operator resolution date for manual_no_run events.';
COMMENT ON COLUMN public.analysis_preflight_acquisition_cost_events.evidence_reference_hash IS
    'For manual_no_run only: SHA-256 of an external evidence reference, never the reference itself.';

ALTER TABLE public.analysis_preflight_acquisition_cost_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_preflight_acquisition_cost_events FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_preflight_acquisition_cost_events
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_analysis_preflight_provider_cost_event(
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_terminal_status TEXT,
    p_max_charge_usd NUMERIC,
    p_actual_usage_usd NUMERIC,
    p_provider_terminal_date DATE
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
    IF p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_terminal_status IS NULL
       OR p_terminal_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_actual_usage_usd IS NULL
       OR p_actual_usage_usd NOT BETWEEN 0 AND p_max_charge_usd + 0.000000001
       OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
       OR p_provider_terminal_date IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_billing_identity_hash := pg_catalog.encode(
        pg_catalog.sha256(
            pg_catalog.convert_to('provider_run:' || p_run_id, 'UTF8')
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
        event_date
    ) VALUES (
        v_billing_identity_hash,
        'provider_run',
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        p_terminal_status,
        p_max_charge_usd,
        p_actual_usage_usd,
        p_provider_terminal_date
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
       OR v_event.event_kind IS DISTINCT FROM 'provider_run'
       OR v_event.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_event.actor_id IS DISTINCT FROM p_actor_id
       OR v_event.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_event.terminal_status IS DISTINCT FROM p_terminal_status
       OR v_event.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_event.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd
       OR v_event.event_date IS DISTINCT FROM p_provider_terminal_date THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_preflight_provider_cost_event(
    TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, NUMERIC, DATE
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.record_analysis_preflight_manual_no_run_cost_event(
    p_preflight_id UUID,
    p_evidence_reference_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
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
       OR p_evidence_reference_hash IS NULL
       OR p_evidence_reference_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_resolution_date IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_billing_identity_hash := pg_catalog.encode(
        pg_catalog.sha256(
            pg_catalog.convert_to(
                'manual_no_run:' || p_preflight_id::TEXT || ':'
                    || p_evidence_reference_hash,
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
        'manual_no_run',
        p_logical_provider,
        p_actor_id,
        p_credential_slot,
        'resolved_no_run',
        0,
        0,
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

    IF NOT FOUND
       OR v_event.event_kind IS DISTINCT FROM 'manual_no_run'
       OR v_event.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_event.actor_id IS DISTINCT FROM p_actor_id
       OR v_event.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_event.terminal_status IS DISTINCT FROM 'resolved_no_run'
       OR v_event.max_charge_usd IS DISTINCT FROM 0
       OR v_event.actual_usage_usd IS DISTINCT FROM 0
       OR v_event.evidence_reference_hash IS DISTINCT FROM p_evidence_reference_hash
       OR v_event.event_date IS DISTINCT FROM p_resolution_date THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_EVENT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.record_analysis_preflight_manual_no_run_cost_event(
    UUID, TEXT, TEXT, TEXT, TEXT, DATE
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.aggregate_analysis_preflight_acquisition_costs(
    p_start_date DATE,
    p_end_date_exclusive DATE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_rows JSONB;
    v_unsettled_rows JSONB;
    v_unsettled_count INTEGER;
    v_unsettled_maximum_charge_usd NUMERIC(20, 12);
BEGIN
    IF p_start_date IS NULL
       OR p_end_date_exclusive IS NULL
       OR p_end_date_exclusive <= p_start_date
       OR p_end_date_exclusive > p_start_date + 3660 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_ACQUISITION_COST_PERIOD_INVALID',
            ERRCODE = 'P0001';
    END IF;

    WITH grouped AS (
        SELECT
            event.event_date,
            event.event_kind,
            event.logical_provider,
            event.actor_id,
            event.credential_slot,
            event.terminal_status,
            pg_catalog.count(*)::INTEGER AS event_count,
            pg_catalog.sum(event.max_charge_usd) AS maximum_charge_usd,
            pg_catalog.sum(event.actual_usage_usd) AS actual_usage_usd
        FROM public.analysis_preflight_acquisition_cost_events AS event
        WHERE event.event_date >= p_start_date
          AND event.event_date < p_end_date_exclusive
        GROUP BY
            event.event_date,
            event.event_kind,
            event.logical_provider,
            event.actor_id,
            event.credential_slot,
            event.terminal_status
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'eventDate', grouped.event_date,
                'eventKind', grouped.event_kind,
                'logicalProvider', grouped.logical_provider,
                'actorId', grouped.actor_id,
                'credentialSlot', grouped.credential_slot,
                'terminalStatus', grouped.terminal_status,
                'eventCount', grouped.event_count,
                'maximumChargeUsd', grouped.maximum_charge_usd,
                'actualUsageUsd', grouped.actual_usage_usd
            ) ORDER BY
                grouped.event_date,
                grouped.event_kind,
                grouped.logical_provider NULLS FIRST,
                grouped.credential_slot NULLS FIRST,
                grouped.terminal_status
        ),
        '[]'::JSONB
    ) INTO v_rows
    FROM grouped;

    WITH unsettled_grouped AS (
        SELECT
            provider_run.logical_provider,
            provider_run.actor_id,
            provider_run.credential_slot,
            provider_run.status,
            pg_catalog.count(*)::INTEGER AS run_count,
            pg_catalog.sum(provider_run.max_charge_usd) AS maximum_charge_usd,
            pg_catalog.min(provider_run.reserved_at) AS earliest_reserved_at,
            pg_catalog.max(provider_run.reserved_at) AS latest_reserved_at
        FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.actual_usage_usd IS NULL
          AND provider_run.status IN (
              'starting', 'running', 'succeeded', 'failed', 'aborted', 'timed_out'
          )
          AND (provider_run.reserved_at AT TIME ZONE 'UTC')::DATE >= p_start_date
          AND (provider_run.reserved_at AT TIME ZONE 'UTC')::DATE < p_end_date_exclusive
        GROUP BY
            provider_run.logical_provider,
            provider_run.actor_id,
            provider_run.credential_slot,
            provider_run.status
        ORDER BY
            provider_run.logical_provider,
            provider_run.credential_slot,
            provider_run.status
        LIMIT 30
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'logicalProvider', unsettled.logical_provider,
                'actorId', unsettled.actor_id,
                'credentialSlot', unsettled.credential_slot,
                'status', unsettled.status,
                'runCount', unsettled.run_count,
                'maximumChargeUsd', unsettled.maximum_charge_usd,
                'earliestReservedAt', unsettled.earliest_reserved_at,
                'latestReservedAt', unsettled.latest_reserved_at
            ) ORDER BY
                unsettled.logical_provider,
                unsettled.credential_slot,
                unsettled.status
        ),
        '[]'::JSONB
    ) INTO v_unsettled_rows
    FROM unsettled_grouped AS unsettled;

    SELECT
        pg_catalog.count(*)::INTEGER,
        COALESCE(pg_catalog.sum(provider_run.max_charge_usd), 0)
    INTO v_unsettled_count, v_unsettled_maximum_charge_usd
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.actual_usage_usd IS NULL
      AND provider_run.status IN (
          'starting', 'running', 'succeeded', 'failed', 'aborted', 'timed_out'
      )
      AND (provider_run.reserved_at AT TIME ZONE 'UTC')::DATE >= p_start_date
      AND (provider_run.reserved_at AT TIME ZONE 'UTC')::DATE < p_end_date_exclusive;

    RETURN pg_catalog.jsonb_build_object(
        'startDate', p_start_date,
        'endDateExclusive', p_end_date_exclusive,
        'rows', v_rows,
        'unsettledRows', v_unsettled_rows,
        'unsettledCount', v_unsettled_count,
        'unsettledMaximumChargeUsd', v_unsettled_maximum_charge_usd,
        'hasUnsettled', v_unsettled_count > 0,
        'isComplete', v_unsettled_count = 0
    );
END;
$$;

REVOKE ALL ON FUNCTION public.aggregate_analysis_preflight_acquisition_costs(DATE, DATE)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.aggregate_analysis_preflight_acquisition_costs(DATE, DATE)
    TO service_role;

CREATE OR REPLACE FUNCTION public.analysis_preflight_provider_run_json(
    p_run public.analysis_preflight_provider_runs
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'preflightId', p_run.preflight_id,
        'operationKey', p_run.operation_key,
        'inputHash', p_run.input_hash,
        'logicalProvider', p_run.logical_provider,
        'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot,
        'maxChargeUsd', p_run.max_charge_usd,
        'status', p_run.status,
        'runId', p_run.run_id,
        'actualUsageUsd', p_run.actual_usage_usd,
        'reservedAt', p_run.reserved_at,
        'runStartedAt', p_run.run_started_at,
        'terminalizedAt', p_run.terminalized_at,
        'usageReconciledAt', p_run.usage_reconciled_at,
        'usageReconciliationAttemptCount', p_run.usage_reconciliation_attempt_count,
        'usageReconciliationAttemptedAt', p_run.usage_reconciliation_attempted_at,
        'evidenceReferenceHash', p_run.manual_resolution_evidence_hash,
        'manualResolvedAt', p_run.manual_resolved_at
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_preflight_provider_run_json(
    public.analysis_preflight_provider_runs
) FROM PUBLIC, anon, authenticated, service_role;

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
    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_existing
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
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
    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id;
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
    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
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
    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
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

CREATE OR REPLACE FUNCTION public.list_analysis_preflight_unreconciled_provider_runs(
    p_limit INTEGER DEFAULT 17
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_runs JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    WITH candidate_keys AS MATERIALIZED (
        SELECT provider_run.preflight_id
        FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.actual_usage_usd IS NULL
          AND provider_run.usage_reconciled_at IS NULL
          AND (
              (
                  provider_run.status = 'running'
                  AND provider_run.run_started_at <= v_now - INTERVAL '30 seconds'
              )
              OR (
                  provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                  AND provider_run.terminalized_at <= v_now - INTERVAL '30 seconds'
              )
          )
          AND (
              provider_run.usage_reconciliation_attempted_at IS NULL
              OR provider_run.usage_reconciliation_attempted_at <= v_now - INTERVAL '30 seconds'
          )
        ORDER BY
            provider_run.usage_reconciliation_attempted_at NULLS FIRST,
            COALESCE(provider_run.terminalized_at, provider_run.run_started_at),
            provider_run.preflight_id
        FOR UPDATE SKIP LOCKED
        LIMIT p_limit
    ), attempted AS (
        UPDATE public.analysis_preflight_provider_runs AS provider_run
        SET usage_reconciliation_attempt_count = LEAST(
                provider_run.usage_reconciliation_attempt_count + 1,
                100000
            ),
            usage_reconciliation_attempted_at = v_now,
            updated_at = v_now
        FROM candidate_keys AS candidate
        WHERE provider_run.preflight_id = candidate.preflight_id
        RETURNING provider_run.*
    )
    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            public.analysis_preflight_provider_run_json(candidate)
            ORDER BY COALESCE(candidate.terminalized_at, candidate.run_started_at),
                candidate.preflight_id
        ),
        '[]'::JSONB
    ) INTO v_runs
    FROM attempted AS candidate;

    RETURN v_runs;
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_preflight_unreconciled_provider_runs(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_preflight_unreconciled_provider_runs(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.list_analysis_preflight_unreconciled_provider_runs(INTEGER) IS
    'Claims a bounded PII-free page of stale running or terminal preflight Actor identities.';

CREATE OR REPLACE FUNCTION public.reconcile_analysis_preflight_provider_run_usage(
    p_preflight_id UUID,
    p_input_hash TEXT,
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_status TEXT,
    p_actual_usage_usd NUMERIC,
    p_provider_finished_at TIMESTAMP WITH TIME ZONE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.statement_timestamp();
    v_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_run_id IS NULL
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000
       OR p_status IS NULL
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR p_actual_usage_usd IS NULL
       OR p_actual_usage_usd NOT BETWEEN 0 AND 100000
       OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
       OR p_actual_usage_usd > p_max_charge_usd + 0.000000001
       OR p_provider_finished_at IS NULL
       OR p_provider_finished_at > v_now - INTERVAL '30 seconds' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.run_id IS DISTINCT FROM p_run_id
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_run.status NOT IN ('running', 'succeeded', 'failed', 'aborted', 'timed_out')
       OR v_run.run_started_at IS NULL
       OR p_provider_finished_at < v_run.reserved_at
       OR p_provider_finished_at < v_run.run_started_at
       OR p_actual_usage_usd > v_run.max_charge_usd + 0.000000001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'running' THEN
        IF v_run.run_started_at > v_now - INTERVAL '30 seconds' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_NOT_READY',
                ERRCODE = 'P0001';
        END IF;

        UPDATE public.analysis_preflight_provider_runs AS provider_run
        SET status = p_status,
            actual_usage_usd = p_actual_usage_usd,
            terminalized_at = p_provider_finished_at,
            usage_reconciled_at = v_now,
            updated_at = v_now
        WHERE provider_run.preflight_id = p_preflight_id
        RETURNING provider_run.* INTO v_run;

        PERFORM public.record_analysis_preflight_provider_cost_event(
            v_run.run_id,
            v_run.logical_provider,
            v_run.actor_id,
            v_run.credential_slot,
            v_run.status,
            v_run.max_charge_usd,
            v_run.actual_usage_usd,
            (p_provider_finished_at AT TIME ZONE 'UTC')::DATE
        );

        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;

    IF v_run.status IS DISTINCT FROM p_status
       OR v_run.terminalized_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.terminalized_at > v_now - INTERVAL '30 seconds' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.actual_usage_usd IS NOT NULL THEN
        IF v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_RECONCILIATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        PERFORM public.record_analysis_preflight_provider_cost_event(
            v_run.run_id,
            v_run.logical_provider,
            v_run.actor_id,
            v_run.credential_slot,
            v_run.status,
            v_run.max_charge_usd,
            v_run.actual_usage_usd,
            (p_provider_finished_at AT TIME ZONE 'UTC')::DATE
        );
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;

    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET actual_usage_usd = p_actual_usage_usd,
        terminalized_at = p_provider_finished_at,
        usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE provider_run.preflight_id = p_preflight_id
    RETURNING provider_run.* INTO v_run;

    PERFORM public.record_analysis_preflight_provider_cost_event(
        v_run.run_id,
        v_run.logical_provider,
        v_run.actor_id,
        v_run.credential_slot,
        v_run.status,
        v_run.max_charge_usd,
        v_run.actual_usage_usd,
        (p_provider_finished_at AT TIME ZONE 'UTC')::DATE
    );

    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_analysis_preflight_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_analysis_preflight_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE
) TO service_role;

COMMENT ON FUNCTION public.reconcile_analysis_preflight_provider_run_usage(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC,
    TIMESTAMP WITH TIME ZONE
) IS 'Stores one authenticated terminal usage total and provider finish timestamp only when the complete PII-free billing identity matches.';

-- Manual-only recovery for an Actor start whose response was lost before a run ID could be
-- checkpointed. Automation must never call these RPCs or infer that an ambiguous start cost $0.
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
          AND (
              preflight.lease_expires_at IS NULL
              OR preflight.lease_expires_at <= v_now
          )
        ORDER BY provider_run.reserved_at, provider_run.preflight_id
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
            ) ORDER BY candidate.reserved_at, candidate.preflight_id
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

COMMENT ON FUNCTION public.list_analysis_preflight_ambiguous_start_candidates(INTEGER) IS
    'Returns a bounded PII-free manual-review list after a 30-minute ambiguous-start quiet period.';

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
            MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_run.status = 'resolved_no_run' THEN
        IF v_run.run_id IS NOT NULL
           OR v_run.actual_usage_usd IS DISTINCT FROM 0
           OR v_run.manual_resolution_evidence_hash
                IS DISTINCT FROM p_evidence_reference_hash
           OR v_run.manual_resolved_at IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PREFLIGHT_AMBIGUOUS_START_RESOLUTION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        PERFORM public.record_analysis_preflight_manual_no_run_cost_event(
            v_run.preflight_id,
            v_run.manual_resolution_evidence_hash,
            v_run.logical_provider,
            v_run.actor_id,
            v_run.credential_slot,
            (v_run.manual_resolved_at AT TIME ZONE 'UTC')::DATE
        );
        RETURN public.analysis_preflight_provider_run_json(v_run);
    END IF;

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
       OR (
            v_preflight.lease_expires_at IS NOT NULL
            AND v_preflight.lease_expires_at > v_now
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
    RETURNING provider_run.* INTO v_run;

    PERFORM public.record_analysis_preflight_manual_no_run_cost_event(
        v_run.preflight_id,
        v_run.manual_resolution_evidence_hash,
        v_run.logical_provider,
        v_run.actor_id,
        v_run.credential_slot,
        (v_run.manual_resolved_at AT TIME ZONE 'UTC')::DATE
    );

    RETURN public.analysis_preflight_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_preflight_provider_run_no_run(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMP WITH TIME ZONE, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.resolve_analysis_preflight_provider_run_no_run(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TIMESTAMP WITH TIME ZONE, TEXT
) IS 'Database-owner-only resolution of one quiet ambiguous start after external no-run evidence; automation and service_role must never call it.';

-- Cost rows are cascade-owned by the preflight. Retention may scrub PII immediately, but it
-- must not delete a tombstone until usage is reconciled or a manually evidenced no-run
-- resolution has atomically recorded its long-lived PII-free cost event.
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
            MESSAGE = 'ANALYSIS_V2_INVALID_MAINTENANCE_INPUT',
            ERRCODE = 'P0001';
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
                        'succeeded', 'failed', 'aborted', 'timed_out',
                        'resolved_no_run'
                    )
                    OR provider_run.actual_usage_usd IS NULL
                    OR provider_run.usage_reconciled_at IS NULL
                )
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
    'Scrubs expired PII and retains paid-run tombstones until usage reconciliation or evidenced manual no-run resolution.';
