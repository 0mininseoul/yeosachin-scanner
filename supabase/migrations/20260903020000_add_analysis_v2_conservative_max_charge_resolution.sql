-- MIGRATION_PREDECESSOR=20260902100000
-- Merge order: the parallel preflight repair
-- 20260902100000_ambiguous_max_charge_identity_drift_repair.sql must land
-- first; this V2-only repair is rebased directly after that migration.
--
-- A conservative max charge is accounting evidence, not provider evidence.
-- This migration never changes a provider terminal status or manufactures a
-- provider run ID.  It records the immutable basis explicitly while filling
-- actual_usage_usd with the stored upper bound so canonical V2 cost
-- aggregation can close an irrecoverable provider-missing row.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_v2_provider_runs
    ADD COLUMN manual_resolution_kind TEXT,
    ADD COLUMN manual_resolution_evidence_hash TEXT,
    ADD COLUMN manual_resolved_at TIMESTAMPTZ;

ALTER TABLE public.analysis_v2_provider_runs
    ADD CONSTRAINT analysis_v2_provider_runs_manual_resolution_contract
    CHECK (
        (
            manual_resolution_kind IS NULL
            AND manual_resolution_evidence_hash IS NULL
            AND manual_resolved_at IS NULL
        )
        OR (
            manual_resolution_kind = 'conservative_max_charge'
            AND manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'
            AND manual_resolved_at IS NOT NULL
            AND terminalized_at IS NOT NULL
            AND manual_resolved_at >= terminalized_at
            AND actual_usage_usd = max_charge_usd
            AND usage_reconciled_at IS NOT NULL
            AND manual_resolved_at = usage_reconciled_at
            AND status = 'succeeded'
            AND run_id IS NOT NULL
            AND run_started_at IS NOT NULL
            AND logical_provider = 'apify'
            AND credential_slot = 'tertiary'
        )
    );

COMMENT ON COLUMN public.analysis_v2_provider_runs.manual_resolution_kind IS
    'Immutable accounting basis; conservative_max_charge is not provider actual usage.';
COMMENT ON COLUMN public.analysis_v2_provider_runs.manual_resolution_evidence_hash IS
    'SHA-256 of the PII-free owner evidence reference for a manual resolution.';
COMMENT ON COLUMN public.analysis_v2_provider_runs.manual_resolved_at IS
    'Owner resolution timestamp; immutable together with the resolution basis and evidence hash.';

CREATE OR REPLACE FUNCTION public.guard_analysis_v2_provider_run_manual_resolution_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF OLD.manual_resolution_kind IS NOT NULL
       AND (
           NEW.manual_resolution_kind IS DISTINCT FROM OLD.manual_resolution_kind
           OR NEW.manual_resolution_evidence_hash IS DISTINCT FROM OLD.manual_resolution_evidence_hash
           OR NEW.manual_resolved_at IS DISTINCT FROM OLD.manual_resolved_at
           OR NEW.actual_usage_usd IS DISTINCT FROM OLD.actual_usage_usd
           OR NEW.usage_reconciled_at IS DISTINCT FROM OLD.usage_reconciled_at
           OR NEW.max_charge_usd IS DISTINCT FROM OLD.max_charge_usd
           OR NEW.input_hash IS DISTINCT FROM OLD.input_hash
           OR NEW.job_claim_token IS DISTINCT FROM OLD.job_claim_token
           OR NEW.reservation_token IS DISTINCT FROM OLD.reservation_token
           OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
           OR NEW.reserved_at IS DISTINCT FROM OLD.reserved_at
           OR NEW.request_id IS DISTINCT FROM OLD.request_id
           OR NEW.job_key IS DISTINCT FROM OLD.job_key
           OR NEW.operation_key IS DISTINCT FROM OLD.operation_key
           OR NEW.status IS DISTINCT FROM OLD.status
           OR NEW.run_id IS DISTINCT FROM OLD.run_id
           OR NEW.run_started_at IS DISTINCT FROM OLD.run_started_at
           OR NEW.terminalized_at IS DISTINCT FROM OLD.terminalized_at
           OR NEW.logical_provider IS DISTINCT FROM OLD.logical_provider
           OR NEW.credential_slot IS DISTINCT FROM OLD.credential_slot
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_MANUAL_RESOLUTION_IMMUTABLE';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS analysis_v2_provider_run_manual_resolution_immutability
    ON public.analysis_v2_provider_runs;
CREATE TRIGGER analysis_v2_provider_run_manual_resolution_immutability
    BEFORE UPDATE ON public.analysis_v2_provider_runs
    FOR EACH ROW
    EXECUTE FUNCTION public.guard_analysis_v2_provider_run_manual_resolution_immutability();

CREATE OR REPLACE FUNCTION public.list_analysis_v2_conservative_max_charge_candidates(
    p_limit INTEGER DEFAULT 64
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_candidates JSONB;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_LIMIT';
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'requestId', candidate.request_id,
                'jobKey', candidate.job_key,
                'operationKey', candidate.operation_key,
                'inputHash', candidate.input_hash,
                'jobClaimToken', candidate.job_claim_token,
                'reservationToken', candidate.reservation_token,
                'runId', candidate.run_id,
                'logicalProvider', candidate.logical_provider,
                'actorId', candidate.actor_id,
                'credentialSlot', candidate.credential_slot,
                'maxChargeUsd', candidate.max_charge_usd,
                'reservedAt', candidate.reserved_at,
                'runStartedAt', candidate.run_started_at,
                'terminalizedAt', candidate.terminalized_at,
                'status', candidate.status,
                'revenueCostChildActive', candidate.revenue_cost_child_active
            )
            ORDER BY candidate.terminalized_at, candidate.request_id,
                candidate.job_key, candidate.operation_key
        ),
        '[]'::JSONB
    )
    INTO v_candidates
    FROM (
        SELECT
            provider_run.request_id,
            provider_run.job_key,
            provider_run.operation_key,
            provider_run.input_hash,
            provider_run.job_claim_token,
            provider_run.reservation_token,
            provider_run.run_id,
            provider_run.logical_provider,
            provider_run.actor_id,
            provider_run.credential_slot,
            provider_run.max_charge_usd,
            provider_run.reserved_at,
            provider_run.run_started_at,
            provider_run.terminalized_at,
            provider_run.status,
            EXISTS (
                SELECT 1
                FROM public.analysis_revenue_cost_operations AS child
                WHERE child.request_id = provider_run.request_id
                  AND child.owner_kind = 'provider_run'
                  AND child.source_job_key = provider_run.job_key
                  AND child.source_operation_key_hash =
                      pg_catalog.encode(
                          extensions.digest(
                              pg_catalog.convert_to(provider_run.operation_key, 'UTF8'),
                              'sha256'
                          ),
                          'hex'
                      )
                  AND child.source_attempt = 0
                  AND child.status IN ('reserved', 'started', 'ambiguous')
            ) AS revenue_cost_child_active
        FROM public.analysis_v2_provider_runs AS provider_run
        JOIN public.analysis_pipeline_jobs AS job
          ON job.request_id = provider_run.request_id
         AND job.job_key = provider_run.job_key
        JOIN public.analysis_requests AS analysis_request
          ON analysis_request.id = provider_run.request_id
        WHERE analysis_request.pipeline_version = 'v2'
          AND provider_run.status = 'succeeded'
          AND provider_run.logical_provider = 'apify'
          AND provider_run.credential_slot = 'tertiary'
          AND provider_run.run_id IS NOT NULL
          AND provider_run.run_started_at IS NOT NULL
          AND provider_run.terminalized_at IS NOT NULL
          AND provider_run.actual_usage_usd IS NULL
          AND provider_run.usage_reconciled_at IS NULL
          AND provider_run.manual_resolution_kind IS NULL
          AND provider_run.manual_resolution_evidence_hash IS NULL
          AND provider_run.manual_resolved_at IS NULL
          AND provider_run.terminalized_at <= v_now - INTERVAL '7 days'
          AND (
              (job.lease_token IS NULL AND job.lease_expires_at IS NULL)
              OR (
                  job.lease_token IS NOT NULL
                  AND job.lease_expires_at IS NOT NULL
                  AND job.lease_expires_at <= v_now
              )
          )
          AND (
              (analysis_request.processing_lease_token IS NULL
               AND analysis_request.processing_lease_expires_at IS NULL)
              OR (
                  analysis_request.processing_lease_token IS NOT NULL
                  AND analysis_request.processing_lease_expires_at IS NOT NULL
                  AND analysis_request.processing_lease_expires_at <= v_now
              )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_provider_admission_leases AS admission
              WHERE admission.request_id = provider_run.request_id
                AND admission.job_key = provider_run.job_key
                AND admission.operation_key = provider_run.operation_key
                AND admission.logical_provider = provider_run.logical_provider
                AND admission.credential_slot = provider_run.credential_slot
                AND admission.state IN ('leased', 'recovery_required')
                AND (
                    admission.expires_at IS NULL
                    OR admission.expires_at > v_now
                )
          )
        ORDER BY provider_run.terminalized_at, provider_run.request_id,
            provider_run.job_key, provider_run.operation_key
        LIMIT p_limit
    ) AS candidate;

    RETURN v_candidates;
END;
$$;

CREATE OR REPLACE FUNCTION public.resolve_analysis_v2_provider_run_conservative_max_charge(
    p_request_id UUID,
    p_job_key TEXT,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_job_claim_token UUID,
    p_reservation_token UUID,
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reserved_at TIMESTAMPTZ,
    p_run_started_at TIMESTAMPTZ,
    p_terminalized_at TIMESTAMPTZ,
    p_status TEXT,
    p_resolution_kind TEXT,
    p_evidence_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_run public.analysis_v2_provider_runs%ROWTYPE;
    v_admission RECORD;
    v_child_state TEXT := 'absent';
    v_already_resolved BOOLEAN := FALSE;
    v_settlement JSONB;
    v_source_hash TEXT;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_operation_key IS NULL
       OR p_input_hash IS NULL
       OR p_job_claim_token IS NULL
       OR p_reservation_token IS NULL
       OR p_run_id IS NULL
       OR p_logical_provider IS NULL
       OR p_actor_id IS NULL
       OR p_credential_slot IS NULL
       OR p_max_charge_usd IS NULL
       OR p_reserved_at IS NULL
       OR p_run_started_at IS NULL
       OR p_terminalized_at IS NULL
       OR p_status IS NULL
       OR p_resolution_kind IS NULL
       OR p_evidence_hash IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_CONFLICT';
    END IF;

    IF p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_run_id !~ '^[A-Za-z0-9:_-]+$'
       OR pg_catalog.length(p_run_id) NOT BETWEEN 8 AND 256
       OR p_actor_id !~ '^[A-Za-z0-9._:/-]+$'
       OR pg_catalog.length(p_actor_id) NOT BETWEEN 1 AND 256
       OR p_logical_provider IS DISTINCT FROM 'apify'
       OR p_credential_slot IS DISTINCT FROM 'tertiary'
       OR p_max_charge_usd <= 0
       OR p_status IS DISTINCT FROM 'succeeded'
       OR p_resolution_kind IS DISTINCT FROM 'conservative_max_charge'
       OR p_evidence_hash !~ '^[0-9a-f]{64}$'
       OR p_run_started_at < p_reserved_at
       OR p_terminalized_at < p_run_started_at
       OR p_terminalized_at > v_now - INTERVAL '7 days' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_CONFLICT';
    END IF;

    -- Stable lock order is request -> exact job -> exact provider row.
    SELECT * INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_NOT_READY';
    END IF;
    IF v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_CONFLICT';
    END IF;

    SELECT * INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_NOT_READY';
    END IF;

    SELECT * INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_NOT_READY';
    END IF;

    IF v_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_run.job_claim_token IS DISTINCT FROM p_job_claim_token
       OR v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.run_id IS DISTINCT FROM p_run_id
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR v_run.reserved_at IS DISTINCT FROM p_reserved_at
       OR v_run.run_started_at IS DISTINCT FROM p_run_started_at
       OR v_run.terminalized_at IS DISTINCT FROM p_terminalized_at
       OR v_run.status IS DISTINCT FROM p_status THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_CONFLICT';
    END IF;

    IF (
           (v_request.processing_lease_token IS NULL AND v_request.processing_lease_expires_at IS NOT NULL)
           OR (v_request.processing_lease_token IS NOT NULL AND v_request.processing_lease_expires_at IS NULL)
           OR (v_request.processing_lease_token IS NOT NULL AND v_request.processing_lease_expires_at > v_now)
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_NOT_READY';
    END IF;
    IF (
           (v_job.lease_token IS NULL AND v_job.lease_expires_at IS NOT NULL)
           OR (v_job.lease_token IS NOT NULL AND v_job.lease_expires_at IS NULL)
           OR (v_job.lease_token IS NOT NULL AND v_job.lease_expires_at > v_now)
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_NOT_READY';
    END IF;

    FOR v_admission IN
        SELECT admission_id, state, expires_at
        FROM public.analysis_provider_admission_leases AS admission
        WHERE admission.request_id = p_request_id
          AND admission.job_key = p_job_key
          AND admission.operation_key = p_operation_key
          AND admission.logical_provider = p_logical_provider
          AND admission.credential_slot = p_credential_slot
        FOR UPDATE
    LOOP
        IF v_admission.state IN ('leased', 'recovery_required')
           AND (v_admission.expires_at IS NULL OR v_admission.expires_at > v_now) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_NOT_READY';
        END IF;
    END LOOP;

    IF v_run.manual_resolution_kind IS NOT NULL THEN
        IF v_run.manual_resolution_kind = 'conservative_max_charge'
           AND v_run.manual_resolution_evidence_hash = p_evidence_hash
           AND v_run.manual_resolved_at IS NOT NULL
           AND v_run.actual_usage_usd = v_run.max_charge_usd
           AND v_run.usage_reconciled_at IS NOT NULL THEN
            v_already_resolved := TRUE;
        ELSE
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_CONFLICT';
        END IF;
    ELSIF v_run.actual_usage_usd IS NOT NULL
          OR v_run.usage_reconciled_at IS NOT NULL
          OR v_run.manual_resolution_evidence_hash IS NOT NULL
          OR v_run.manual_resolved_at IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_CONFLICT';
    END IF;

    IF NOT v_already_resolved THEN
        UPDATE public.analysis_v2_provider_runs
        SET actual_usage_usd = max_charge_usd,
            usage_reconciled_at = v_now,
            manual_resolution_kind = 'conservative_max_charge',
            manual_resolution_evidence_hash = p_evidence_hash,
            manual_resolved_at = v_now,
            updated_at = v_now
        WHERE request_id = p_request_id
          AND job_key = p_job_key
          AND operation_key = p_operation_key
          AND actual_usage_usd IS NULL
          AND usage_reconciled_at IS NULL
          AND manual_resolution_kind IS NULL
          AND manual_resolution_evidence_hash IS NULL
          AND manual_resolved_at IS NULL
        RETURNING * INTO v_run;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_RESOLUTION_CONFLICT';
        END IF;
    END IF;

    v_source_hash := pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(p_operation_key, 'UTF8'), 'sha256'),
        'hex'
    );
    SELECT child.status
    INTO v_child_state
    FROM public.analysis_revenue_cost_operations AS child
    WHERE child.request_id = p_request_id
      AND child.owner_kind = 'provider_run'
      AND child.source_job_key = p_job_key
      AND child.source_operation_key_hash = v_source_hash
      AND child.source_attempt = 0
    FOR UPDATE;
    IF NOT FOUND THEN
        v_child_state := 'absent';
    ELSIF v_child_state NOT IN ('reserved', 'started', 'ambiguous', 'settled') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_SETTLEMENT_CONFLICT';
    END IF;

    IF v_child_state IN ('reserved', 'started', 'ambiguous', 'settled') THEN
        -- This is intentionally the newest authoritative settle RPC.  It
        -- validates the complete revenue lineage and sees the max charge only
        -- inside this transaction; any fence failure rolls back both writes.
        v_settlement := public.settle_analysis_revenue_cost_operation_v2(
            p_request_id, p_job_key, 'provider_run', p_operation_key, 0::SMALLINT
        );
        IF v_settlement->>'disposition' IS DISTINCT FROM 'settled' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CONSERVATIVE_SETTLEMENT_CONFLICT';
        END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'jobKey', p_job_key,
        'operationKey', p_operation_key,
        'runId', p_run_id,
        'status', p_status,
        'actualUsageUsd', p_max_charge_usd,
        'manualResolutionKind', 'conservative_max_charge',
        'manualResolutionEvidenceHash', p_evidence_hash,
        'manualResolvedAt', v_run.manual_resolved_at,
        'revenueCostSettlement', CASE WHEN v_child_state = 'absent' THEN 'absent' ELSE 'settled' END,
        'replayed', v_already_resolved
    );
END;
$$;

REVOKE ALL ON FUNCTION public.guard_analysis_v2_provider_run_manual_resolution_immutability()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_analysis_v2_conservative_max_charge_candidates(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_provider_run_conservative_max_charge(
    UUID, TEXT, TEXT, TEXT, UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC,
    TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
