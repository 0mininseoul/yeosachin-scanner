-- Preserve an expired Apify operation's ability to make its first call after
-- the provider ledger and former job/preflight claim prove no call could start.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.resolve_analysis_provider_admission(
    p_admission_id TEXT,
    p_resolution_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_lease public.analysis_provider_admission_leases%ROWTYPE;
    v_ledger_state TEXT;
    v_source TEXT;
    v_release_reason TEXT := 'ledger_resolved';
    v_candidate public.analysis_provider_admission_leases%ROWTYPE;
    v_absent_fence BIGINT;
    v_preflight_id UUID;
BEGIN
    IF p_admission_id IS NULL OR p_admission_id !~ '^[0-9a-f]{64}$'
       OR p_resolution_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;
    -- A missing run can be retired as a retryable pre-start rejection only
    -- after serializing with the parent's provider-run reservation. Read the
    -- old fence first; take lineage locks before the admission row.
    SELECT lease.* INTO v_candidate
    FROM public.analysis_provider_admission_leases AS lease
    WHERE lease.admission_id = p_admission_id
      AND lease.logical_provider = 'apify' AND lease.state = 'recovery_required';
    IF FOUND AND public.analysis_provider_admission_ledger_state(v_candidate) = 'missing' THEN
        IF v_candidate.workload_role = 'preflight'
           OR v_candidate.job_key IN ('preflight:provider', 'paid:target-profile') THEN
            PERFORM 1 FROM public.analysis_preflights AS preflight
            WHERE preflight.id = v_candidate.request_id FOR SHARE;
        ELSE
            SELECT request.preflight_id INTO v_preflight_id
            FROM public.analysis_requests AS request WHERE request.id = v_candidate.request_id;
            IF v_preflight_id IS NOT NULL THEN
                PERFORM 1 FROM public.analysis_preflights AS preflight
                WHERE preflight.id = v_preflight_id FOR SHARE;
            END IF;
            PERFORM 1 FROM public.analysis_requests AS request
            WHERE request.id = v_candidate.request_id FOR SHARE;
            PERFORM 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_candidate.request_id AND job.job_key = v_candidate.job_key
            FOR SHARE;
        END IF;
        v_absent_fence := v_candidate.fence;
    END IF;

    SELECT lease.* INTO v_lease
    FROM public.analysis_provider_admission_leases AS lease
    WHERE lease.admission_id = p_admission_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_lease.state = 'released' THEN
        RETURN pg_catalog.jsonb_build_object('resolved', FALSE);
    END IF;
    IF v_lease.state <> 'recovery_required' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING', ERRCODE = 'P0001';
    END IF;

    v_ledger_state := public.analysis_provider_admission_ledger_state(v_lease);
    IF v_ledger_state = 'identity_conflict' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_ledger_state = 'fenced_out' THEN
        IF v_lease.logical_provider <> 'gemini' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        v_source := 'gemini_lease_fenced';
    ELSIF v_ledger_state = 'missing' THEN
        -- Admission is acquired before the provider-run reserve callback.  An
        -- expired Apify row with no provider ledger therefore proves that no
        -- external start occurred and may be retired safely.  Gemini missing
        -- rows remain ambiguous because the slot fence is authoritative.
        IF v_lease.logical_provider <> 'apify' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF v_lease.fence IS DISTINCT FROM v_absent_fence THEN
            RETURN pg_catalog.jsonb_build_object('resolved', FALSE);
        END IF;
        v_source := 'provider_ledger_absent';
        v_release_reason := 'prestart_rejected';
    ELSIF v_ledger_state NOT IN ('terminal', 'available', 'quarantined') THEN
        RETURN pg_catalog.jsonb_build_object('resolved', FALSE);
    ELSE
        v_source := CASE
            WHEN v_lease.logical_provider = 'gemini' THEN 'gemini_lease_fenced'
            ELSE 'provider_ledger_terminal'
        END;
    END IF;
    UPDATE public.analysis_provider_admission_leases AS lease
    SET state = 'released', released_at = v_now,
        release_reason = v_release_reason,
        resolution_source = v_source,
        resolution_token_hash = pg_catalog.encode(
            extensions.digest(
                pg_catalog.convert_to(p_resolution_token::TEXT, 'UTF8'), 'sha256'
            ), 'hex'
        ),
        updated_at = v_now
    WHERE lease.admission_id = p_admission_id
      AND lease.state = 'recovery_required';
    RETURN pg_catalog.jsonb_build_object('resolved', TRUE);
END;
$$;
