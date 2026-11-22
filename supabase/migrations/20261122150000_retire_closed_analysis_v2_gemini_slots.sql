-- Reclaim concurrency only after a closed request, completed job, or final
-- scheduler operation rules out replay. Attempt and cost evidence stays intact.
CREATE FUNCTION public.retire_inactive_analysis_v2_gemini_slots_v1(
    p_request_id uuid, p_limit integer DEFAULT 8
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    -- Allow the 600s paid worker request and 210s SDK deadline to drain after
    -- the durable closure evidence and expiry of both leases.
    v_before timestamptz := pg_catalog.clock_timestamp() - interval '15 minutes';
    closed_request boolean;
    candidate record;
    retired integer := 0;
BEGIN
    IF p_request_id IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 8 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_GEMINI_RETIRE_INVALID';
    END IF;

    IF NOT pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
    ) THEN
        RETURN 0;
    END IF;
    -- Ordinary job and operation claims validate the same locked parent.
    SELECT r.status IN ('failed', 'completed') INTO closed_request
    FROM public.analysis_requests AS r
    WHERE r.id = p_request_id AND r.pipeline_version = 'v2'
      AND (r.status IN ('pending', 'processing') OR
          (r.status IN ('failed', 'completed') AND r.completed_at <= v_before))
    FOR SHARE SKIP LOCKED;
    IF NOT FOUND OR (closed_request AND EXISTS (
        SELECT 1 FROM public.analysis_pipeline_jobs AS j WHERE j.request_id = p_request_id
          AND j.status NOT IN ('failed', 'cancelled', 'completed')
    )) THEN
        RETURN 0;
    END IF;

    FOR candidate IN
        SELECT s.slot, a.admission_id, a.state AS admission_state
        FROM public.analysis_v2_gemini_leases AS s
        JOIN public.analysis_pipeline_jobs AS j
          ON j.request_id = s.request_id AND j.job_key = s.job_key
        JOIN public.analysis_provider_admission_leases AS a
          ON a.request_id = s.request_id AND a.job_key = s.job_key
         AND a.operation_key = 'gemini:' || s.operation_key || ':attempt:' || s.attempt::text
         AND a.workload_role = 'paid' AND a.logical_provider = 'gemini'
         AND a.credential_slot = 'gemini-' || s.slot::text
         AND a.provider_fence = s.fence AND a.claim_token = s.lease_claim_token
         AND a.state IN ('leased', 'recovery_required', 'released') AND a.expires_at <= v_before
        JOIN public.analysis_v2_ai_attempts AS t
          ON t.request_id = s.request_id AND t.job_key = s.job_key
         AND t.operation_key = s.operation_key AND t.attempt = s.attempt
         AND t.job_claim_token = a.job_claim_token AND t.stage = s.stage
         AND t.status IN ('reserved', 'ambiguous')
        WHERE s.request_id = p_request_id AND s.state IN ('leased', 'quarantined')
          AND s.expires_at <= v_before
          AND (
              -- An ended job on a closed request has no dispatch path. A
              -- completed job with its own completion timestamp also rejects
              -- redelivery while sibling jobs on the request are still live.
              (j.lease_token IS NULL AND j.lease_expires_at IS NULL AND j.updated_at <= v_before
               AND ((closed_request AND j.status IN ('failed', 'cancelled', 'completed'))
                 OR (j.status = 'completed' AND j.completed_at <= v_before)))
              OR (
                  NOT closed_request
                  AND (j.lease_token IS DISTINCT FROM a.job_claim_token OR j.lease_expires_at <= v_before)
                  AND EXISTS (
                      -- Reclaiming this identity yields the saved result or
                      -- terminal_unavailable with recovery_only; never execute.
                      SELECT 1 FROM public.analysis_v2_scheduler_operations AS operation
                      WHERE operation.request_id = s.request_id AND operation.job_key = s.job_key
                        AND operation.operation_key = s.operation_key AND operation.stage = s.stage
                        AND operation.status IN ('terminal_unavailable', 'ready')
                        AND operation.updated_at <= v_before
                      FOR SHARE OF operation SKIP LOCKED
                  )
              )
          )
        ORDER BY s.slot LIMIT p_limit
        FOR SHARE OF j, t SKIP LOCKED
        FOR UPDATE OF s, a SKIP LOCKED
    LOOP
        -- Invalidate the old slot generation before resolving the admission.
        -- Its existing resolver will record gemini_lease_fenced. A stale
        -- callback cannot release or renew a subsequently assigned slot.
        UPDATE public.analysis_v2_gemini_leases
        SET state = 'available', fence = fence + 1, request_id = NULL, job_key = NULL,
            operation_key = NULL, stage = NULL, attempt = NULL, lease_claim_token = NULL,
            acquired_at = NULL, expires_at = NULL, quarantined_at = NULL,
            updated_at = pg_catalog.clock_timestamp()
        WHERE slot = candidate.slot;

        -- The production recovery pass can already have resolved this admission.
        -- Do not replace its receipt or count it as a second resolution.
        IF candidate.admission_state <> 'released' THEN
            IF (public.recover_expired_analysis_provider_admission(
                    candidate.admission_id, pg_catalog.gen_random_uuid()
                ) ->> 'recovered')::boolean IS DISTINCT FROM true THEN
                RAISE EXCEPTION 'ANALYSIS_V2_GEMINI_RETIRE_ADMISSION_CONFLICT';
            END IF;
            IF (public.resolve_analysis_provider_admission(
                    candidate.admission_id, pg_catalog.gen_random_uuid()
                ) ->> 'resolved')::boolean IS DISTINCT FROM true THEN
                RAISE EXCEPTION 'ANALYSIS_V2_GEMINI_RETIRE_ADMISSION_CONFLICT';
            END IF;
        END IF;
        retired := retired + 1;
    END LOOP;
    RETURN retired;
END;
$$;

REVOKE ALL ON FUNCTION public.retire_inactive_analysis_v2_gemini_slots_v1(uuid, integer)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reap_analysis_v2_scheduler_gemini_leases(p_limit integer DEFAULT 8) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_reaped INTEGER := 0;
    v_request uuid;
    v_other integer;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 8 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GEMINI_LEASE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    -- Use the normal recovery budget across all requests and both reapers.
    -- At most eight physical rows seed this lookup.
    IF NOT pg_catalog.pg_try_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
    ) THEN
        RETURN 0;
    END IF;
    FOR v_request IN
        SELECT DISTINCT lease.request_id FROM public.analysis_v2_gemini_leases AS lease
        WHERE lease.state IN ('leased', 'quarantined')
          AND lease.expires_at <= v_now - interval '15 minutes'
        ORDER BY lease.request_id
    LOOP
        v_reaped := v_reaped + public.retire_inactive_analysis_v2_gemini_slots_v1(v_request, p_limit - v_reaped);
        IF v_reaped = p_limit THEN RETURN v_reaped; END IF;
    END LOOP;

    WITH expired AS (
        SELECT lease.slot
        FROM public.analysis_v2_gemini_leases AS lease
        WHERE lease.state = 'quarantined'
          AND lease.stage IN ('genderTriage', 'featureAnalysis', 'privateAccountName')
          AND lease.expires_at <= v_now
          AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_ai_attempts AS attempt
                WHERE attempt.request_id = lease.request_id
                  AND attempt.job_key = lease.job_key
                  AND attempt.operation_key = lease.operation_key
                  AND attempt.attempt = lease.attempt
                  AND attempt.status IN ('reserved', 'ambiguous')
          )
        ORDER BY lease.slot
        LIMIT (p_limit - v_reaped)
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.analysis_v2_gemini_leases AS lease
    SET state = 'available',
        request_id = NULL,
        job_key = NULL,
        operation_key = NULL,
        stage = NULL,
        attempt = NULL,
        lease_claim_token = NULL,
        acquired_at = NULL,
        expires_at = NULL,
        quarantined_at = NULL,
        updated_at = v_now
    FROM expired
    WHERE lease.slot = expired.slot;
    GET DIAGNOSTICS v_other = ROW_COUNT;
    RETURN v_reaped + v_other;
END;
$$;
