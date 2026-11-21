-- A durable Gemini attempt is required before the provider can be called.
-- Only a released admission with no attempt and two superseded ownership
-- fences may give this exact operation a new admission.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.analysis_provider_admission_gemini_no_start_proven(
    p_lease public.analysis_provider_admission_leases
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    v_identity TEXT[];
BEGIN
    IF p_lease.workload_role <> 'paid' OR p_lease.logical_provider <> 'gemini'
       OR p_lease.provider_fence IS NULL THEN
        RETURN FALSE;
    END IF;

    v_identity := pg_catalog.regexp_match(
        p_lease.operation_key, '^gemini:([a-z][a-z0-9-]*:[0-9a-f]{64}):attempt:([1-4])$'
    );
    IF v_identity IS NULL OR NOT public.analysis_v2_valid_ai_operation_key(v_identity[1]) THEN
        RETURN FALSE;
    END IF;

    -- Callers hold the request and job locks across this proof and any change.
    RETURN NOT EXISTS (
        SELECT 1 FROM public.analysis_pipeline_jobs AS job
        WHERE job.request_id = p_lease.request_id AND job.job_key = p_lease.job_key
          AND job.status = 'processing' AND job.lease_token = p_lease.job_claim_token
          AND job.lease_expires_at > pg_catalog.clock_timestamp()
    ) AND NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
        WHERE attempt.request_id = p_lease.request_id
          AND attempt.operation_key = v_identity[1]
          AND attempt.attempt = v_identity[2]::integer
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_provider_admission_gemini_no_start_proven(
    public.analysis_provider_admission_leases
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_provider_admission_gemini_slot_retired(
    p_lease public.analysis_provider_admission_leases
)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.analysis_v2_gemini_leases AS slot
        WHERE slot.slot::text = pg_catalog.substr((p_lease).credential_slot, 8)
          AND (slot.fence > (p_lease).provider_fence
               OR (slot.fence = (p_lease).provider_fence AND slot.state = 'available'
                   AND slot.lease_claim_token IS NULL))
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_provider_admission_gemini_slot_retired(
    public.analysis_provider_admission_leases
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_provider_admission_can_rearm_gemini_without_attempt(
    p_lease public.analysis_provider_admission_leases,
    p_job_claim_token UUID
)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
    -- The new claim and its slot are already locked and verified by acquire.
    SELECT (p_lease).state = 'released'
       AND (p_lease).job_claim_token <> p_job_claim_token
       AND public.analysis_provider_admission_gemini_no_start_proven(p_lease)
       AND public.analysis_provider_admission_gemini_slot_retired(p_lease);
$$;

REVOKE ALL ON FUNCTION public.analysis_provider_admission_can_rearm_gemini_without_attempt(
    public.analysis_provider_admission_leases, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.acquire_analysis_provider_admission(
    p_admission_id TEXT,
    p_workload_role TEXT,
    p_logical_provider TEXT,
    p_credential_slot TEXT,
    p_budget_key TEXT,
    p_request_id UUID,
    p_job_key TEXT,
    p_operation_key TEXT,
    p_job_claim_token UUID,
    p_claim_token UUID,
    p_provider_fence BIGINT,
    p_lease_token UUID,
    p_lease_seconds INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_expected_id TEXT;
    v_existing public.analysis_provider_admission_leases%ROWTYPE;
    v_budget public.analysis_provider_admission_budgets%ROWTYPE;
    v_budget_found BOOLEAN := FALSE;
    v_global_key TEXT := p_workload_role || ':' || p_logical_provider || ':global';
    v_slot_key TEXT := p_workload_role || ':' || p_logical_provider || ':' || p_credential_slot;
    v_relationship_key TEXT := p_workload_role || ':' || p_logical_provider || ':' || p_credential_slot || ':relationship';
    v_active_count INTEGER;
    v_max_active INTEGER := 0;
    v_rate_limited BOOLEAN := FALSE;
    v_budget_count INTEGER := 0;
    v_required_budget_count INTEGER := 2;
    v_relationship_operation BOOLEAN := p_operation_key LIKE 'relationship-%';
    v_ledger_state TEXT;
    v_reacquire BOOLEAN := FALSE;
    v_identity_lock_key TEXT := p_workload_role || ':' || p_logical_provider || ':'
        || pg_catalog.lower(p_request_id::TEXT) || ':' || p_job_key || ':' || p_operation_key;
BEGIN
    IF p_admission_id IS NULL
       OR p_admission_id !~ '^[0-9a-f]{64}$'
       OR p_workload_role NOT IN ('preflight', 'paid')
       OR p_logical_provider NOT IN ('apify', 'gemini')
       OR p_credential_slot IS NULL
       OR p_credential_slot !~ '^[a-z][a-z0-9_-]{1,31}$'
       OR p_budget_key IS NULL
       OR p_budget_key !~ '^(preflight|paid):(apify|gemini):[a-z0-9:_-]{1,96}$'
       OR p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_operation_key IS NULL
       OR pg_catalog.char_length(p_operation_key) NOT BETWEEN 1 AND 256
       OR p_operation_key !~ '^[a-z0-9][a-z0-9:._-]{0,255}$'
       OR p_job_claim_token IS NULL
       OR p_claim_token IS NULL
       OR (p_logical_provider = 'gemini' AND (p_provider_fence IS NULL OR p_provider_fence < 1))
       OR (p_logical_provider <> 'gemini' AND p_provider_fence IS NOT NULL)
       OR p_lease_token IS NULL
       OR p_lease_seconds NOT BETWEEN 10 AND 900 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    v_expected_id := public.analysis_provider_admission_expected_id(
        p_workload_role, p_logical_provider, p_credential_slot,
        p_request_id, p_job_key, p_operation_key
    );
    IF p_admission_id IS DISTINCT FROM v_expected_id THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF p_workload_role = 'preflight'
       AND (p_logical_provider <> 'apify'
            OR p_credential_slot NOT IN ('primary', 'quinary', 'senary')) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN', ERRCODE = 'P0001';
    END IF;
    IF p_logical_provider = 'gemini'
       AND p_credential_slot !~ '^gemini-[1-8]$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN', ERRCODE = 'P0001';
    END IF;
    IF p_budget_key NOT IN (v_global_key, v_slot_key, v_relationship_key) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF (v_relationship_operation AND p_budget_key <> v_relationship_key)
       OR (NOT v_relationship_operation AND p_budget_key = v_relationship_key) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_relationship_operation THEN
        v_required_budget_count := 3;
    END IF;

    PERFORM public.assert_analysis_provider_admission_claim(
        p_workload_role,
        p_logical_provider,
        p_credential_slot,
        p_request_id,
        p_job_key,
        p_operation_key,
        p_job_claim_token,
        p_claim_token,
        p_provider_fence,
        v_now
    );

    -- Serialize the durable operation identity before the first existence
    -- check. The admission id deliberately includes credential slot, so a
    -- retry that drifts slot/budget must take the same lock and be classified
    -- before it reaches the alternate-id unique identity constraint.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_identity_lock_key, 0)
    );

    -- Serialize exact-id writes as well as attempts to rekey the same
    -- operation to a safer available Gemini slot.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_admission_id, 0)
    );

    SELECT lease.* INTO v_existing
    FROM public.analysis_provider_admission_leases AS lease
    WHERE lease.workload_role = p_workload_role
      AND lease.logical_provider = p_logical_provider
      AND lease.request_id = p_request_id
      AND lease.job_key = p_job_key
      AND lease.operation_key = p_operation_key
    FOR UPDATE;
    IF FOUND AND public.analysis_provider_admission_can_rearm_gemini_without_attempt(
        v_existing, p_job_claim_token
    ) THEN
        v_reacquire := TRUE;
    ELSIF FOUND THEN
        IF v_existing.admission_id IS DISTINCT FROM p_admission_id
           OR v_existing.workload_role IS DISTINCT FROM p_workload_role
           OR v_existing.logical_provider IS DISTINCT FROM p_logical_provider
           OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_existing.budget_key IS DISTINCT FROM p_budget_key
           OR v_existing.request_id IS DISTINCT FROM p_request_id
           OR v_existing.job_key IS DISTINCT FROM p_job_key
           OR v_existing.operation_key IS DISTINCT FROM p_operation_key THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF v_existing.state = 'leased' AND v_existing.expires_at > v_now THEN
            -- A durable operation can keep the same provider fence while the
            -- queue worker claim rotates. Both claims are ownership, so any
            -- change is a takeover and must be backed by an already-running
            -- provider ledger before rotating this admission's secret/fence.
            IF v_existing.claim_token IS DISTINCT FROM p_claim_token
               OR v_existing.job_claim_token IS DISTINCT FROM p_job_claim_token THEN
                -- A takeover may only adopt an already-running provider row. A
                -- fresh/start-ambiguous row remains owned by its original claim.
                v_ledger_state := public.analysis_provider_admission_ledger_state(v_existing);
                IF v_ledger_state <> 'running' THEN
                    RAISE EXCEPTION USING
                        MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT', ERRCODE = 'P0001';
                END IF;
                UPDATE public.analysis_provider_admission_leases AS lease
                SET claim_token = p_claim_token,
                    job_claim_token = p_job_claim_token,
                    provider_fence = p_provider_fence,
                    lease_token = p_lease_token,
                    fence = lease.fence + 1,
                    updated_at = v_now
                WHERE lease.admission_id = p_admission_id
                  AND lease.state = 'leased'
                  AND lease.expires_at > v_now
                RETURNING lease.* INTO v_existing;
                IF NOT FOUND THEN
                    RAISE EXCEPTION USING
                        MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH', ERRCODE = 'P0001';
                END IF;
                SELECT pg_catalog.count(*)::INTEGER INTO v_active_count
                FROM public.analysis_provider_admission_leases AS lease
                WHERE lease.state IN ('leased', 'recovery_required')
                  AND lease.workload_role = p_workload_role
                  AND lease.logical_provider = p_logical_provider;
                SELECT budget.max_active INTO v_max_active
                FROM public.analysis_provider_admission_budgets AS budget
                WHERE budget.budget_key = p_budget_key;
                RETURN public.analysis_provider_admission_json(
                    v_existing, 'adopted', v_active_count, COALESCE(v_max_active, 1),
                    p_job_claim_token, p_claim_token
                );
            END IF;
            SELECT pg_catalog.count(*)::INTEGER INTO v_active_count
            FROM public.analysis_provider_admission_leases AS lease
            WHERE lease.state IN ('leased', 'recovery_required')
              AND lease.workload_role = p_workload_role
              AND lease.logical_provider = p_logical_provider;
            SELECT budget.max_active INTO v_max_active
            FROM public.analysis_provider_admission_budgets AS budget
            WHERE budget.budget_key = p_budget_key;
            RETURN public.analysis_provider_admission_json(
                v_existing, 'already_acquired', v_active_count, COALESCE(v_max_active, 1),
                p_job_claim_token, p_claim_token
            );
        END IF;
        IF v_existing.state = 'leased' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING', ERRCODE = 'P0001';
        END IF;
        IF v_existing.state = 'recovery_required' THEN
            -- Expiry does not prove that the provider stopped. A recovery pass
            -- may hand the same operation to a live durable task only after the
            -- provider ledger proves that the external run is still running.
            v_ledger_state := public.analysis_provider_admission_ledger_state(v_existing);
            IF v_ledger_state = 'running' THEN
                UPDATE public.analysis_provider_admission_leases AS lease
                SET state = 'leased',
                    claim_token = p_claim_token,
                    job_claim_token = p_job_claim_token,
                    provider_fence = p_provider_fence,
                    lease_token = p_lease_token,
                    fence = lease.fence + 1,
                    acquired_at = v_now,
                    expires_at = v_now + (p_lease_seconds || ' seconds')::INTERVAL,
                    recovered_at = NULL,
                    release_reason = NULL,
                    resolution_source = NULL,
                    resolution_token_hash = NULL,
                    updated_at = v_now
                WHERE lease.admission_id = p_admission_id
                  AND lease.state = 'recovery_required'
                RETURNING lease.* INTO v_existing;
                IF NOT FOUND THEN
                    RAISE EXCEPTION USING
                        MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH', ERRCODE = 'P0001';
                END IF;
                SELECT pg_catalog.count(*)::INTEGER INTO v_active_count
                FROM public.analysis_provider_admission_leases AS lease
                WHERE lease.state IN ('leased', 'recovery_required')
                  AND lease.workload_role = p_workload_role
                  AND lease.logical_provider = p_logical_provider;
                SELECT budget.max_active INTO v_max_active
                FROM public.analysis_provider_admission_budgets AS budget
                WHERE budget.budget_key = p_budget_key;
                RETURN public.analysis_provider_admission_json(
                    v_existing, 'adopted', v_active_count, COALESCE(v_max_active, 1),
                    p_job_claim_token, p_claim_token
                );
            END IF;
            -- Terminal/available/quarantined states are released by the
            -- resolver, never by an acquire retry. Pending and identity
            -- conflicts retain the row and therefore retain capacity.
            IF v_ledger_state = 'identity_conflict' THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
            END IF;
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING', ERRCODE = 'P0001';
        END IF;
        IF v_existing.state = 'released'
           AND (
               v_existing.release_reason = 'prestart_rejected'
               OR (v_existing.logical_provider = 'apify'
                   AND v_existing.release_reason = 'ledger_resolved'
                   AND v_existing.resolution_source = 'provider_ledger_absent')
           ) THEN
            v_ledger_state := public.analysis_provider_admission_ledger_state(v_existing);
            IF v_ledger_state NOT IN ('terminal', 'missing')
               OR (v_existing.release_reason = 'ledger_resolved' AND v_ledger_state <> 'missing') THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_CLAIM_CONFLICT', ERRCODE = 'P0001';
            END IF;
            v_reacquire := TRUE;
        ELSE
            -- Terminal release rows are intentionally not reusable: their
            -- provider ledger may already contain a charged run.
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
    END IF;

    -- Lock all budgets used by the role/provider in lexical order. Every caller uses
    -- this order, so concurrent slot/global claims cannot deadlock each other.
    FOR v_budget IN
        SELECT budget.*
        FROM public.analysis_provider_admission_budgets AS budget
        WHERE budget.budget_key IN (p_budget_key, v_global_key, v_slot_key)
           OR (v_relationship_operation AND budget.budget_key = v_relationship_key)
        ORDER BY budget.budget_key
        FOR UPDATE
    LOOP
        v_budget_count := v_budget_count + 1;
        IF v_budget.workload_role IS DISTINCT FROM p_workload_role
           OR v_budget.logical_provider IS DISTINCT FROM p_logical_provider
           OR (
               v_budget.budget_key = p_budget_key
               AND v_budget.credential_slot IS DISTINCT FROM
                   CASE WHEN v_budget.budget_key = v_global_key THEN NULL ELSE p_credential_slot END
           ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        v_budget_found := v_budget_found OR v_budget.budget_key = p_budget_key;
        v_max_active := CASE
            WHEN v_budget.budget_key = p_budget_key THEN v_budget.max_active
            ELSE v_max_active
        END;
        SELECT pg_catalog.count(*)::INTEGER INTO v_active_count
        FROM public.analysis_provider_admission_leases AS lease
        WHERE lease.state IN ('leased', 'recovery_required')
          AND lease.workload_role = v_budget.workload_role
          AND lease.logical_provider = v_budget.logical_provider
          AND (
              v_budget.credential_slot IS NULL
              OR lease.credential_slot = v_budget.credential_slot
          )
          AND (
              v_budget.budget_key NOT LIKE '%:relationship'
              OR lease.operation_key LIKE 'relationship-%'
          );
        IF v_active_count >= v_budget.max_active THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING', ERRCODE = 'P0001';
        END IF;
        IF v_budget.window_started_at + INTERVAL '1 minute' <= v_now THEN
            UPDATE public.analysis_provider_admission_budgets AS budget
            SET window_started_at = v_now, window_count = 0, updated_at = v_now
            WHERE budget.budget_key = v_budget.budget_key;
            v_budget.window_count := 0;
        END IF;
        IF v_budget.window_count >= v_budget.rate_limit_per_minute THEN
            v_rate_limited := TRUE;
        END IF;
    END LOOP;
    IF v_budget_count < v_required_budget_count OR NOT v_budget_found OR v_rate_limited THEN
        IF v_budget_count < v_required_budget_count OR NOT v_budget_found THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_BUDGET_NOT_FOUND', ERRCODE = 'P0001';
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING', ERRCODE = 'P0001';
    END IF;

    FOR v_budget IN
        SELECT budget.*
        FROM public.analysis_provider_admission_budgets AS budget
        WHERE budget.budget_key IN (p_budget_key, v_global_key, v_slot_key)
           OR (v_relationship_operation AND budget.budget_key = v_relationship_key)
        ORDER BY budget.budget_key
        FOR UPDATE
    LOOP
        UPDATE public.analysis_provider_admission_budgets AS budget
        SET window_count = budget.window_count + 1, updated_at = v_now
        WHERE budget.budget_key = v_budget.budget_key;
    END LOOP;

    IF v_reacquire THEN
        UPDATE public.analysis_provider_admission_leases AS lease
        SET admission_id = p_admission_id,
            credential_slot = p_credential_slot,
            budget_key = p_budget_key,
            state = 'leased',
            claim_token = p_claim_token,
            job_claim_token = p_job_claim_token,
            provider_fence = p_provider_fence,
            lease_token = p_lease_token,
            fence = lease.fence + 1,
            acquired_at = v_now,
            expires_at = v_now + (p_lease_seconds || ' seconds')::INTERVAL,
            released_at = NULL,
            recovered_at = NULL,
            release_reason = NULL,
            resolution_source = NULL,
            resolution_token_hash = NULL,
            updated_at = v_now
        WHERE lease.admission_id = v_existing.admission_id
          AND lease.fence = v_existing.fence
          AND lease.state = 'released'
        RETURNING lease.* INTO v_existing;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_FENCE_MISMATCH', ERRCODE = 'P0001';
        END IF;
    ELSE
        INSERT INTO public.analysis_provider_admission_leases (
        admission_id, workload_role, logical_provider, credential_slot, budget_key,
            request_id, job_key, operation_key, claim_token, job_claim_token,
            provider_fence,
            lease_token, fence,
        acquired_at, expires_at, created_at, updated_at
        ) VALUES (
        p_admission_id, p_workload_role, p_logical_provider, p_credential_slot, p_budget_key,
        p_request_id, p_job_key, p_operation_key, p_claim_token, p_job_claim_token,
        p_provider_fence,
        p_lease_token, 1,
        v_now, v_now + (p_lease_seconds || ' seconds')::INTERVAL, v_now, v_now
        )
        RETURNING * INTO v_existing;
    END IF;

    SELECT pg_catalog.count(*)::INTEGER INTO v_active_count
    FROM public.analysis_provider_admission_leases AS lease
    WHERE lease.state IN ('leased', 'recovery_required')
      AND lease.workload_role = p_workload_role
      AND lease.logical_provider = p_logical_provider;
    RETURN public.analysis_provider_admission_json(
        v_existing, 'acquired', v_active_count, COALESCE(v_max_active, 1),
        p_job_claim_token, p_claim_token
    );
END;
$$;
