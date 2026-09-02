-- MIGRATION_PREDECESSOR=20260903020000
-- Owner-only, provider-free terminalization of the one historical roleless delivery cohort.
-- This migration records an immutable receipt before changing only stale job lifecycle fields.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts (
    receipt_id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key VARCHAR(160) NOT NULL,
    input_hash VARCHAR(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    prior_status VARCHAR(16) NOT NULL CHECK (prior_status IN ('pending', 'processing')),
    prior_dispatch_state VARCHAR(16) NOT NULL CHECK (prior_dispatch_state = 'delivered'),
    prior_dispatch_generation INTEGER NOT NULL CHECK (prior_dispatch_generation BETWEEN 1 AND 1000),
    prior_dispatch_reservation_token UUID NOT NULL,
    prior_dispatch_reserved_at TIMESTAMPTZ NOT NULL,
    prior_dispatched_at TIMESTAMPTZ NOT NULL,
    prior_delivered_at TIMESTAMPTZ NOT NULL,
    prior_dispatch_task_name VARCHAR(512) NOT NULL,
    prior_dispatch_workload_role TEXT,
    prior_dispatch_contract_version SMALLINT,
    prior_claim_workload_role TEXT,
    prior_claim_contract_version SMALLINT,
    prior_lease_token UUID,
    prior_lease_expires_at TIMESTAMPTZ,
    manual_resolution_operation_key VARCHAR(87),
    manual_resolution_evidence_hash VARCHAR(64),
    terminal_status VARCHAR(16) NOT NULL CHECK (terminal_status IN ('failed', 'cancelled')),
    error_code VARCHAR(64) NOT NULL
        CHECK (error_code = 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED'),
    audit_evidence_hash VARCHAR(64) NOT NULL CHECK (audit_evidence_hash ~ '^[0-9a-f]{64}$'),
    resolved_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_identity_unique
        UNIQUE (request_id, job_key),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_provenance_check CHECK (
        prior_dispatch_workload_role IS NULL
        AND prior_dispatch_contract_version IS NULL
        AND prior_claim_workload_role IS NULL
        AND prior_claim_contract_version IS NULL
    ),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_manual_resolution_check CHECK (
        (
            manual_resolution_operation_key IS NULL
            AND manual_resolution_evidence_hash IS NULL
        )
        OR (
            manual_resolution_operation_key IS NOT NULL
            AND manual_resolution_operation_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$'
            AND manual_resolution_evidence_hash IS NOT NULL
            AND manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'
        )
    ),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_lease_check CHECK (
        (
            prior_status = 'pending'
            AND prior_lease_token IS NULL
            AND prior_lease_expires_at IS NULL
        )
        OR (
            prior_status = 'processing'
            AND prior_lease_token IS NOT NULL
            AND prior_lease_expires_at IS NOT NULL
        )
    ),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_time_check CHECK (
        prior_dispatch_reserved_at <= prior_dispatched_at
        AND prior_dispatched_at <= prior_delivered_at
    ),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE INDEX analysis_v2_historical_legacy_dispatch_receipt_resolved_idx
    ON public.analysis_v2_historical_legacy_dispatch_terminalization_receipts(resolved_at, request_id, job_key);

ALTER TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_RECEIPT_IMMUTABLE',
            ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability
BEFORE UPDATE OR DELETE ON public.analysis_v2_historical_legacy_dispatch_terminalization_receipts
FOR EACH ROW EXECUTE FUNCTION public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability();

CREATE OR REPLACE FUNCTION public.list_analysis_v2_historical_legacy_dispatch_candidates(
    p_limit INTEGER DEFAULT 64
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_INVALID',
            ERRCODE = 'P0001';
    END IF;

    RETURN COALESCE((
        SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'requestId', candidate.request_id,
                'jobKey', candidate.job_key,
                'inputHash', candidate.input_hash,
                'priorStatus', candidate.status,
                'priorDispatchState', candidate.dispatch_state,
                'priorDispatchGeneration', candidate.dispatch_generation,
                'priorDispatchReservationToken', candidate.dispatch_reservation_token,
                'priorDispatchReservedAt', candidate.dispatch_reserved_at,
                'priorDispatchedAt', candidate.dispatched_at,
                'priorDeliveredAt', candidate.delivered_at,
                'priorDispatchTaskName', candidate.dispatch_task_name,
                'priorDispatchWorkloadRole', candidate.dispatch_workload_role,
                'priorDispatchContractVersion', candidate.dispatch_contract_version,
                'priorClaimWorkloadRole', candidate.claim_workload_role,
                'priorClaimContractVersion', candidate.claim_contract_version,
                'priorLeaseToken', candidate.lease_token,
                'priorLeaseExpiresAt', candidate.lease_expires_at,
                'manualResolutionOperationKey', candidate.operation_key,
                'manualResolutionEvidenceHash', candidate.manual_resolution_evidence_hash
            )
            ORDER BY candidate.delivered_at, candidate.request_id::TEXT, candidate.job_key
        )
        FROM (
            SELECT request.id AS request_id,
                job.job_key,
                job.input_hash,
                job.status,
                job.dispatch_state,
                job.dispatch_generation,
                job.dispatch_reservation_token,
                job.dispatch_reserved_at,
                job.dispatched_at,
                job.delivered_at,
                job.dispatch_task_name,
                job.dispatch_workload_role,
                job.dispatch_contract_version,
                job.claim_workload_role,
                job.claim_contract_version,
                job.lease_token,
                job.lease_expires_at,
                manual_resolution.operation_key,
                manual_resolution.manual_resolution_evidence_hash
            FROM public.analysis_requests AS request
            JOIN public.analysis_pipeline_jobs AS job
                ON job.request_id = request.id
            LEFT JOIN LATERAL (
                SELECT provider_run.operation_key,
                    provider_run.manual_resolution_evidence_hash
                FROM public.analysis_v2_provider_runs AS provider_run
                WHERE provider_run.request_id = job.request_id
                  AND provider_run.job_key = job.job_key
                  AND provider_run.manual_resolution_kind = 'conservative_max_charge'
                ORDER BY provider_run.operation_key
                LIMIT 1
            ) AS manual_resolution ON TRUE
            WHERE request.pipeline_version = 'v2'
              AND request.status = 'failed'
              AND (
                    (request.processing_lease_token IS NULL AND request.processing_lease_expires_at IS NULL)
                    OR (
                        request.processing_lease_token IS NOT NULL
                        AND request.processing_lease_expires_at IS NOT NULL
                        AND request.processing_lease_expires_at <= v_now
                    )
              )
              AND job.dispatch_state = 'delivered'
              AND job.dispatch_generation BETWEEN 1 AND 1000
              AND job.dispatch_reservation_token IS NOT NULL
              AND job.dispatch_reserved_at IS NOT NULL
              AND job.dispatched_at IS NOT NULL
              AND job.dispatch_task_name IS NOT NULL
              AND job.delivered_at IS NOT NULL
              AND job.dispatch_workload_role IS NULL
              AND job.dispatch_contract_version IS NULL
              AND job.claim_workload_role IS NULL
              AND job.claim_contract_version IS NULL
              AND job.status IN ('pending', 'processing')
              AND (
                    (job.status = 'pending' AND job.lease_token IS NULL AND job.lease_expires_at IS NULL)
                    OR (
                        job.status = 'processing'
                        AND job.lease_token IS NOT NULL
                        AND job.lease_expires_at IS NOT NULL
                        AND job.lease_expires_at <= v_now
                    )
              )
              AND job.updated_at <= v_now - INTERVAL '7 days'
              AND job.delivered_at <= v_now - INTERVAL '7 days'
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_provider_runs AS provider_run
                    WHERE provider_run.request_id = job.request_id
                      AND provider_run.job_key = job.job_key
                      AND (
                            (
                                (
                                    provider_run.status = 'rejected'
                                    AND provider_run.run_id IS NULL
                                    AND provider_run.run_started_at IS NULL
                                    AND provider_run.terminalized_at IS NOT NULL
                                    AND provider_run.actual_usage_usd IS NOT DISTINCT FROM 0
                                    AND provider_run.usage_reconciled_at IS NOT NULL
                                )
                                OR (
                                    provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                                    AND provider_run.run_id IS NOT NULL
                                    AND provider_run.run_started_at IS NOT NULL
                                    AND provider_run.terminalized_at IS NOT NULL
                                    AND provider_run.actual_usage_usd IS NOT NULL
                                    AND provider_run.usage_reconciled_at IS NOT NULL
                                )
                            ) IS NOT TRUE
                            OR (
                                (
                                    provider_run.manual_resolution_kind IS NULL
                                    AND provider_run.manual_resolution_evidence_hash IS NULL
                                    AND provider_run.manual_resolved_at IS NULL
                                )
                                OR (
                                    provider_run.manual_resolution_kind = 'conservative_max_charge'
                                    AND provider_run.manual_resolution_evidence_hash IS NOT NULL
                                    AND provider_run.manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'
                                    AND provider_run.manual_resolved_at IS NOT NULL
                                    AND provider_run.manual_resolved_at >= provider_run.terminalized_at
                                    AND provider_run.actual_usage_usd = provider_run.max_charge_usd
                                    AND provider_run.usage_reconciled_at IS NOT NULL
                                    AND provider_run.manual_resolved_at = provider_run.usage_reconciled_at
                                    AND provider_run.status = 'succeeded'
                                    AND provider_run.run_id IS NOT NULL
                                    AND provider_run.run_started_at IS NOT NULL
                                    AND provider_run.logical_provider = 'apify'
                                    AND provider_run.credential_slot = 'tertiary'
                                )
                            ) IS NOT TRUE
                      )
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_provider_admission_leases AS admission
                    WHERE admission.request_id = request.id
                      AND admission.state IN ('leased', 'recovery_required')
                      AND (admission.expires_at IS NULL OR admission.expires_at > v_now)
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_ai_attempts AS attempt
                    WHERE attempt.request_id = request.id
                      AND (attempt.status = 'reserved' OR attempt.status = 'ambiguous')
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_gemini_leases AS lease
                    WHERE lease.request_id = request.id
                      AND lease.state = 'leased'
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.vertex_ai_budget_reservations AS reservation
                    WHERE pg_catalog.lower(reservation.run_id) = pg_catalog.lower(request.id::TEXT)
                      AND reservation.state = 'reserved'
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_revenue_cost_operations AS child
                    WHERE child.request_id = request.id
                      AND child.status IN ('reserved', 'started', 'ambiguous')
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_provider_cleanup_intents AS cleanup
                    WHERE cleanup.request_id = request.id
                      AND cleanup.completed_at IS NULL
              )
              AND NOT EXISTS (
                    SELECT 1
                FROM public.analysis_v2_scheduler_operations AS operation
                WHERE operation.request_id = request.id
                  AND operation.status = 'claimed'
                  AND operation.completed_at IS NULL
              )
              AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts AS receipt
                    WHERE receipt.request_id = request.id
                      AND receipt.job_key = job.job_key
              )
            ORDER BY job.delivered_at, request.id::TEXT, job.job_key
            LIMIT p_limit
        ) AS candidate
    ), '[]'::JSONB);
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_historical_legacy_dispatch_candidates(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.resolve_analysis_v2_historical_legacy_dispatch(
    p_request_id UUID,
    p_job_key TEXT,
    p_input_hash TEXT,
    p_prior_status TEXT,
    p_prior_dispatch_state TEXT,
    p_prior_dispatch_generation INTEGER,
    p_prior_dispatch_reservation_token UUID,
    p_prior_dispatch_reserved_at TIMESTAMPTZ,
    p_prior_dispatched_at TIMESTAMPTZ,
    p_prior_delivered_at TIMESTAMPTZ,
    p_prior_dispatch_task_name TEXT,
    p_prior_dispatch_workload_role TEXT,
    p_prior_dispatch_contract_version SMALLINT,
    p_prior_claim_workload_role TEXT,
    p_prior_claim_contract_version SMALLINT,
    p_prior_lease_token UUID,
    p_prior_lease_expires_at TIMESTAMPTZ,
    p_manual_resolution_operation_key TEXT,
    p_manual_resolution_evidence_hash TEXT,
    p_terminal_status TEXT,
    p_audit_evidence_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_receipt public.analysis_v2_historical_legacy_dispatch_terminalization_receipts%ROWTYPE;
    v_provider_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_input_hash IS NULL OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_prior_status NOT IN ('pending', 'processing')
       OR p_prior_dispatch_state IS DISTINCT FROM 'delivered'
       OR p_prior_dispatch_generation IS NULL
       OR p_prior_dispatch_generation NOT BETWEEN 1 AND 1000
       OR p_prior_dispatch_reservation_token IS NULL
       OR p_prior_dispatch_reserved_at IS NULL
       OR p_prior_dispatched_at IS NULL
       OR p_prior_delivered_at IS NULL
       OR p_prior_dispatch_task_name IS NULL
       OR pg_catalog.char_length(p_prior_dispatch_task_name) NOT BETWEEN 1 AND 512
       OR p_prior_dispatch_task_name !~ '^[A-Za-z0-9][A-Za-z0-9._:/=-]*$'
       OR p_prior_dispatch_workload_role IS NOT NULL
       OR p_prior_dispatch_contract_version IS NOT NULL
       OR p_prior_claim_workload_role IS NOT NULL
       OR p_prior_claim_contract_version IS NOT NULL
       OR (p_manual_resolution_operation_key IS NULL AND p_manual_resolution_evidence_hash IS NOT NULL)
       OR (p_manual_resolution_operation_key IS NOT NULL AND p_manual_resolution_evidence_hash IS NULL)
       OR (p_manual_resolution_operation_key IS NOT NULL
           AND p_manual_resolution_operation_key !~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$')
       OR (p_manual_resolution_evidence_hash IS NOT NULL
           AND p_manual_resolution_evidence_hash !~ '^[0-9a-f]{64}$')
       OR p_terminal_status NOT IN ('failed', 'cancelled')
       OR p_audit_evidence_hash IS NULL
       OR p_audit_evidence_hash !~ '^[0-9a-f]{64}$'
       OR p_prior_dispatch_reserved_at > p_prior_dispatched_at
       OR p_prior_dispatched_at > p_prior_delivered_at
       OR (
            p_prior_status = 'pending'
            AND (p_prior_lease_token IS NOT NULL OR p_prior_lease_expires_at IS NOT NULL)
       )
       OR (
            p_prior_status = 'processing'
            AND (p_prior_lease_token IS NULL OR p_prior_lease_expires_at IS NULL)
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status IS DISTINCT FROM 'failed' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    IF NOT (
        (v_request.processing_lease_token IS NULL AND v_request.processing_lease_expires_at IS NULL)
        OR (
            v_request.processing_lease_token IS NOT NULL
            AND v_request.processing_lease_expires_at IS NOT NULL
            AND v_request.processing_lease_expires_at <= v_now
        )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    SELECT receipt.* INTO v_receipt
    FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts AS receipt
    WHERE receipt.request_id = p_request_id
      AND receipt.job_key = p_job_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_receipt.input_hash IS DISTINCT FROM p_input_hash
           OR v_receipt.prior_status IS DISTINCT FROM p_prior_status
           OR v_receipt.prior_dispatch_state IS DISTINCT FROM p_prior_dispatch_state
           OR v_receipt.prior_dispatch_generation IS DISTINCT FROM p_prior_dispatch_generation
           OR v_receipt.prior_dispatch_reservation_token IS DISTINCT FROM p_prior_dispatch_reservation_token
           OR v_receipt.prior_dispatch_reserved_at IS DISTINCT FROM p_prior_dispatch_reserved_at
           OR v_receipt.prior_dispatched_at IS DISTINCT FROM p_prior_dispatched_at
           OR v_receipt.prior_delivered_at IS DISTINCT FROM p_prior_delivered_at
           OR v_receipt.prior_dispatch_task_name IS DISTINCT FROM p_prior_dispatch_task_name
           OR v_receipt.prior_dispatch_workload_role IS DISTINCT FROM p_prior_dispatch_workload_role
           OR v_receipt.prior_dispatch_contract_version IS DISTINCT FROM p_prior_dispatch_contract_version
           OR v_receipt.prior_claim_workload_role IS DISTINCT FROM p_prior_claim_workload_role
           OR v_receipt.prior_claim_contract_version IS DISTINCT FROM p_prior_claim_contract_version
           OR v_receipt.prior_lease_token IS DISTINCT FROM p_prior_lease_token
           OR v_receipt.prior_lease_expires_at IS DISTINCT FROM p_prior_lease_expires_at
           OR v_receipt.manual_resolution_operation_key IS DISTINCT FROM p_manual_resolution_operation_key
           OR v_receipt.manual_resolution_evidence_hash IS DISTINCT FROM p_manual_resolution_evidence_hash
           OR v_receipt.terminal_status IS DISTINCT FROM p_terminal_status
           OR v_receipt.audit_evidence_hash IS DISTINCT FROM p_audit_evidence_hash
           OR v_job.status NOT IN ('failed', 'cancelled')
           OR v_job.lease_token IS NOT NULL
           OR v_job.lease_expires_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'requestId', p_request_id,
            'jobKey', p_job_key,
            'status', v_receipt.terminal_status,
            'errorCode', v_receipt.error_code,
            'auditEvidenceHash', v_receipt.audit_evidence_hash,
            'replayed', TRUE
        );
    END IF;

    IF v_job.status = 'completed'
       OR v_job.status NOT IN ('pending', 'processing')
       OR v_job.status IS DISTINCT FROM p_prior_status
       OR v_job.input_hash IS DISTINCT FROM p_input_hash
       OR v_job.dispatch_state IS DISTINCT FROM p_prior_dispatch_state
       OR v_job.dispatch_generation IS DISTINCT FROM p_prior_dispatch_generation
       OR v_job.dispatch_reservation_token IS DISTINCT FROM p_prior_dispatch_reservation_token
       OR v_job.dispatch_reserved_at IS DISTINCT FROM p_prior_dispatch_reserved_at
       OR v_job.dispatched_at IS DISTINCT FROM p_prior_dispatched_at
       OR v_job.delivered_at IS DISTINCT FROM p_prior_delivered_at
       OR v_job.dispatch_task_name IS DISTINCT FROM p_prior_dispatch_task_name
       OR v_job.dispatch_workload_role IS DISTINCT FROM p_prior_dispatch_workload_role
       OR v_job.dispatch_contract_version IS DISTINCT FROM p_prior_dispatch_contract_version
       OR v_job.claim_workload_role IS DISTINCT FROM p_prior_claim_workload_role
       OR v_job.claim_contract_version IS DISTINCT FROM p_prior_claim_contract_version
       OR v_job.dispatch_state <> 'delivered'
       OR v_job.dispatch_workload_role IS NOT NULL
       OR v_job.dispatch_contract_version IS NOT NULL
       OR v_job.claim_workload_role IS NOT NULL
       OR v_job.claim_contract_version IS NOT NULL
       OR v_job.dispatch_generation < 1
       OR v_job.dispatch_reservation_token IS NULL
       OR v_job.dispatch_reserved_at IS NULL
       OR v_job.dispatched_at IS NULL
       OR v_job.dispatch_task_name IS NULL
       OR v_job.delivered_at IS NULL
       OR v_job.updated_at > v_now - INTERVAL '7 days'
       OR v_job.delivered_at > v_now - INTERVAL '7 days' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    IF NOT (
        (
            v_job.status = 'pending'
            AND v_job.lease_token IS NULL
            AND v_job.lease_expires_at IS NULL
            AND p_prior_lease_token IS NULL
            AND p_prior_lease_expires_at IS NULL
        )
        OR (
            v_job.status = 'processing'
            AND v_job.lease_token IS NOT NULL
            AND v_job.lease_expires_at IS NOT NULL
            AND v_job.lease_expires_at <= v_now
            AND v_job.lease_token IS NOT DISTINCT FROM p_prior_lease_token
            AND v_job.lease_expires_at IS NOT DISTINCT FROM p_prior_lease_expires_at
        )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND (
                (
                    (
                        provider_run.status = 'rejected'
                        AND provider_run.run_id IS NULL
                        AND provider_run.run_started_at IS NULL
                        AND provider_run.terminalized_at IS NOT NULL
                        AND provider_run.actual_usage_usd IS NOT DISTINCT FROM 0
                        AND provider_run.usage_reconciled_at IS NOT NULL
                    )
                    OR (
                        provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                        AND provider_run.run_id IS NOT NULL
                        AND provider_run.run_started_at IS NOT NULL
                        AND provider_run.terminalized_at IS NOT NULL
                        AND provider_run.actual_usage_usd IS NOT NULL
                        AND provider_run.usage_reconciled_at IS NOT NULL
                    )
                ) IS NOT TRUE
                OR (
                    (
                        provider_run.manual_resolution_kind IS NULL
                        AND provider_run.manual_resolution_evidence_hash IS NULL
                        AND provider_run.manual_resolved_at IS NULL
                    )
                    OR (
                        provider_run.manual_resolution_kind = 'conservative_max_charge'
                        AND provider_run.manual_resolution_evidence_hash IS NOT NULL
                        AND provider_run.manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'
                        AND provider_run.manual_resolved_at IS NOT NULL
                        AND provider_run.manual_resolved_at >= provider_run.terminalized_at
                        AND provider_run.actual_usage_usd = provider_run.max_charge_usd
                        AND provider_run.usage_reconciled_at IS NOT NULL
                        AND provider_run.manual_resolved_at = provider_run.usage_reconciled_at
                        AND provider_run.status = 'succeeded'
                        AND provider_run.run_id IS NOT NULL
                        AND provider_run.run_started_at IS NOT NULL
                        AND provider_run.logical_provider = 'apify'
                        AND provider_run.credential_slot = 'tertiary'
                    )
                ) IS NOT TRUE
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    IF p_manual_resolution_operation_key IS NULL THEN
        IF EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = p_request_id
              AND provider_run.job_key = p_job_key
              AND provider_run.manual_resolution_kind = 'conservative_max_charge'
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        SELECT provider_run.* INTO v_provider_run
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_manual_resolution_operation_key
          AND provider_run.manual_resolution_kind = 'conservative_max_charge'
          AND provider_run.manual_resolution_evidence_hash = p_manual_resolution_evidence_hash
          AND provider_run.status = 'succeeded'
          AND provider_run.logical_provider = 'apify'
          AND provider_run.credential_slot = 'tertiary'
          AND provider_run.run_id IS NOT NULL
          AND provider_run.run_started_at IS NOT NULL
          AND provider_run.terminalized_at IS NOT NULL
          AND provider_run.actual_usage_usd = provider_run.max_charge_usd
          AND provider_run.usage_reconciled_at IS NOT NULL
          AND provider_run.manual_resolved_at IS NOT NULL
          AND provider_run.manual_resolved_at = provider_run.usage_reconciled_at
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_provider_admission_leases AS admission
        WHERE admission.request_id = p_request_id
          AND admission.state IN ('leased', 'recovery_required')
          AND (admission.expires_at IS NULL OR admission.expires_at > v_now)
    )
    OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_ai_attempts AS attempt
        WHERE attempt.request_id = p_request_id
          AND (attempt.status = 'reserved' OR attempt.status = 'ambiguous')
    )
    OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_gemini_leases AS lease
        WHERE lease.request_id = p_request_id
          AND lease.state = 'leased'
    )
    OR EXISTS (
        SELECT 1
        FROM public.vertex_ai_budget_reservations AS reservation
        WHERE pg_catalog.lower(reservation.run_id) = pg_catalog.lower(p_request_id::TEXT)
          AND reservation.state = 'reserved'
    )
    OR EXISTS (
        SELECT 1
        FROM public.analysis_revenue_cost_operations AS child
        WHERE child.request_id = p_request_id
          AND child.status IN ('reserved', 'started', 'ambiguous')
    )
    OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_cleanup_intents AS cleanup
        WHERE cleanup.request_id = p_request_id
          AND cleanup.completed_at IS NULL
    )
    OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_scheduler_operations AS operation
        WHERE operation.request_id = p_request_id
          AND operation.status = 'claimed'
          AND operation.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_historical_legacy_dispatch_terminalization_receipts (
        request_id,
        job_key,
        input_hash,
        prior_status,
        prior_dispatch_state,
        prior_dispatch_generation,
        prior_dispatch_reservation_token,
        prior_dispatch_reserved_at,
        prior_dispatched_at,
        prior_delivered_at,
        prior_dispatch_task_name,
        prior_dispatch_workload_role,
        prior_dispatch_contract_version,
        prior_claim_workload_role,
        prior_claim_contract_version,
        prior_lease_token,
        prior_lease_expires_at,
        manual_resolution_operation_key,
        manual_resolution_evidence_hash,
        terminal_status,
        error_code,
        audit_evidence_hash,
        resolved_at
    ) VALUES (
        p_request_id,
        p_job_key,
        v_job.input_hash,
        v_job.status,
        v_job.dispatch_state,
        v_job.dispatch_generation,
        v_job.dispatch_reservation_token,
        v_job.dispatch_reserved_at,
        v_job.dispatched_at,
        v_job.delivered_at,
        v_job.dispatch_task_name,
        v_job.dispatch_workload_role,
        v_job.dispatch_contract_version,
        v_job.claim_workload_role,
        v_job.claim_contract_version,
        v_job.lease_token,
        v_job.lease_expires_at,
        p_manual_resolution_operation_key,
        p_manual_resolution_evidence_hash,
        p_terminal_status,
        'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED',
        p_audit_evidence_hash,
        v_now
    );

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = p_terminal_status,
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED',
        last_error_at = v_now,
        completed_at = v_now,
        updated_at = v_now
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
      AND job.status = p_prior_status
    RETURNING job.* INTO v_job;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_TERMINALIZER_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'jobKey', p_job_key,
        'status', p_terminal_status,
        'errorCode', 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED',
        'auditEvidenceHash', p_audit_evidence_hash,
        'replayed', FALSE
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_historical_legacy_dispatch(
    UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
    TEXT, TEXT, SMALLINT, TEXT, SMALLINT, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
