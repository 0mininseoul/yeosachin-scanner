-- Apply only in the registered Dev database after live-standard-dispatch-recovery.sql
-- and the shared provider-admission recovery migrations.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF pg_catalog.to_regclass('dev_ui.runs') IS NULL
        OR pg_catalog.to_regprocedure('public.dev_live_owner_start_v4(uuid,text,uuid)') IS NULL
        OR pg_catalog.to_regprocedure('dev_live_budget.active_standard_recovery_request_v1()') IS NULL
        OR pg_catalog.to_regprocedure('public.analysis_provider_admission_gemini_no_start_proven(public.analysis_provider_admission_leases)') IS NULL
        OR pg_catalog.to_regprocedure('public.resolve_analysis_provider_admission(text,uuid)') IS NULL
        OR pg_catalog.to_regprocedure(
            'public.cutoff_analysis_v2_gender_resolution_attempt(uuid,text,uuid,text,smallint,uuid,jsonb,integer,uuid,bigint)'
        ) IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_RECOVERY_WRONG_DATABASE';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION dev_live_budget.latest_closed_standard_recovery_request_v1()
RETURNS uuid
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT request.id
    FROM public.analysis_requests AS request
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = request.preflight_id AND preflight.consumed_request_id = request.id
    JOIN dev_live_budget.grants AS approval
      ON preflight.idempotency_key = 'dev-live:owner:standard:' || approval.grant_id::text
    JOIN dev_live_budget.owner_starts AS owner_start
      ON owner_start.grant_id = approval.grant_id AND owner_start.user_id = request.user_id
    WHERE request.pipeline_version = 'v2'
      AND request.status IN ('failed', 'completed') AND request.completed_at IS NOT NULL
      AND request.selected_plan_id_snapshot = 'standard'
      AND preflight.user_id = request.user_id AND preflight.status = 'consumed'
      AND preflight.access_mode = 'test_entitlement'
      AND approval.plan_id = 'standard' AND approval.expires_at = 'infinity'::timestamptz
      AND approval.approved_at <= pg_catalog.statement_timestamp() AND NOT approval.blocked
      AND approval.standard_policy_id = dev_live_budget.standard_policy_for_owner(
          owner_start.user_id, owner_start.target_instagram_id
      )
      AND NOT EXISTS (
          SELECT 1 FROM public.analysis_requests AS active
          WHERE active.pipeline_version = 'v2' AND active.status IN ('pending', 'processing')
      )
    ORDER BY request.completed_at DESC, request.id
    LIMIT 1;
$$;

REVOKE ALL ON FUNCTION dev_live_budget.latest_closed_standard_recovery_request_v1()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION dev_live_budget.standard_provider_expiry_evidence_v1(
    p_lease public.analysis_provider_admission_leases,
    p_closed boolean
)
RETURNS text
LANGUAGE plpgsql SET search_path = ''
AS $$
DECLARE
    v_evidence text;
    v_terminal_attempt boolean;
BEGIN
    -- A terminal slot alone is insufficient when a Gemini attempt is still
    -- reserved or ambiguous. Match the durable attempt's complete identity.
    IF p_lease.logical_provider = 'gemini' AND p_lease.operation_key !~ ':attempt:[1-4]$' THEN
        RETURN NULL;
    END IF;
    v_evidence := public.analysis_provider_admission_ledger_state(p_lease);
    IF p_lease.logical_provider = 'gemini' THEN
        SELECT EXISTS (
            SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = p_lease.request_id AND attempt.job_key = p_lease.job_key
              AND p_lease.operation_key = 'gemini:' || attempt.operation_key || ':attempt:' || attempt.attempt::text
              AND attempt.terminalized_at IS NOT NULL AND attempt.status NOT IN ('reserved', 'ambiguous')
        ) INTO v_terminal_attempt;
        IF v_evidence IN ('fenced_out', 'available', 'quarantined') AND v_terminal_attempt THEN
            RETURN v_evidence;
        END IF;
        IF NOT p_closed AND v_evidence IN ('fenced_out', 'available')
           AND public.analysis_provider_admission_gemini_no_start_proven(p_lease)
           AND public.analysis_provider_admission_gemini_slot_retired(p_lease) THEN
            RETURN v_evidence;
        END IF;
        RETURN NULL;
    END IF;
    IF p_lease.logical_provider = 'apify' AND (v_evidence = 'terminal' OR (NOT p_closed AND v_evidence = 'missing')) THEN
        RETURN v_evidence;
    END IF;
    IF NOT p_closed AND p_lease.logical_provider = 'apify'
       AND p_lease.state = 'leased' AND v_evidence = 'running'
       AND EXISTS (
            SELECT 1 FROM public.analysis_v2_provider_runs AS run
            WHERE run.request_id = p_lease.request_id AND run.job_key = p_lease.job_key
              AND run.operation_key = p_lease.operation_key AND run.credential_slot = p_lease.credential_slot
              AND run.status = 'running' AND NULLIF(run.run_id, '') IS NOT NULL
       ) THEN
        -- Rotation lets the next task adopt and poll the same run ID. It
        -- cannot free the admission or authorize another provider start.
        RETURN v_evidence;
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION dev_live_budget.standard_provider_expiry_evidence_v1(
    public.analysis_provider_admission_leases, boolean
) FROM PUBLIC, anon, authenticated, service_role;

-- Use a separate transaction from redelivery/active-request recovery. A past
-- owner approval identifies the Dev run even if a later QA target has changed.
CREATE OR REPLACE FUNCTION public.retire_dev_live_standard_gemini_slots_v1(p_limit integer DEFAULT 8)
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    candidate_request uuid;
    active_request uuid := dev_live_budget.active_standard_recovery_request_v1();
    retired integer := 0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 8 THEN
        RAISE EXCEPTION 'DEV_STANDARD_GEMINI_RETIRE_INVALID';
    END IF;

    FOR candidate_request IN
        SELECT DISTINCT request.id
        FROM public.analysis_v2_gemini_leases AS slot
        JOIN public.analysis_requests AS request ON request.id = slot.request_id
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = request.preflight_id AND preflight.consumed_request_id = request.id
        JOIN dev_live_budget.grants AS approval
          ON preflight.idempotency_key = 'dev-live:owner:standard:' || approval.grant_id::text
        JOIN dev_live_budget.owner_starts AS owner_start
          ON owner_start.grant_id = approval.grant_id AND owner_start.user_id = request.user_id
        WHERE slot.state IN ('leased', 'quarantined')
          AND slot.expires_at <= pg_catalog.statement_timestamp()
          AND request.pipeline_version = 'v2' AND request.selected_plan_id_snapshot = 'standard'
          AND ((request.status IN ('completed', 'failed') AND request.completed_at IS NOT NULL)
               OR (request.id = active_request AND request.status IN ('pending', 'processing')))
          AND preflight.user_id = request.user_id AND preflight.status = 'consumed'
          AND preflight.access_mode = 'test_entitlement' AND approval.plan_id = 'standard'
        ORDER BY request.id
    LOOP
        retired := retired + public.retire_inactive_analysis_v2_gemini_slots_v1(candidate_request, p_limit - retired);
        EXIT WHEN retired = p_limit;
    END LOOP;
    RETURN retired;
END;
$$;

REVOKE ALL ON FUNCTION public.retire_dev_live_standard_gemini_slots_v1(integer)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.retire_dev_live_standard_gemini_slots_v1(integer) TO service_role;

-- The optional resolver runs outside the scheduler. Keep its cutoff in a
-- separate RPC so the Gemini advisory lock never spans provider lease recovery.
CREATE OR REPLACE FUNCTION public.recover_dev_live_standard_resolver_cutoffs_v1()
RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '750ms'
AS $$
DECLARE
    v_request uuid := dev_live_budget.active_standard_recovery_request_v1();
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_candidate record;
    v_reply jsonb;
    v_recovered integer := 0;
BEGIN
    IF v_request IS NULL THEN
        RETURN 0;
    END IF;

    FOR v_candidate IN
        SELECT attempt.*, lease.slot, lease.lease_claim_token, lease.fence
        FROM public.analysis_v2_gemini_leases AS lease
        JOIN public.analysis_v2_ai_attempts AS attempt
          ON attempt.request_id = lease.request_id AND attempt.job_key = lease.job_key
         AND attempt.operation_key = lease.operation_key AND attempt.attempt = lease.attempt
        JOIN public.analysis_pipeline_jobs AS job
          ON job.request_id = attempt.request_id AND job.job_key = attempt.job_key
        JOIN public.analysis_provider_admission_leases AS admission
          ON admission.request_id = lease.request_id AND admission.job_key = lease.job_key
         AND admission.operation_key = 'gemini:' || lease.operation_key || ':attempt:' || lease.attempt::text
         AND admission.credential_slot = 'gemini-' || lease.slot::text
         AND admission.provider_fence = lease.fence AND admission.claim_token = lease.lease_claim_token
         AND admission.job_claim_token = attempt.job_claim_token
        WHERE lease.request_id = v_request AND lease.stage = 'genderResolution'
          -- Quarantine has already ended this generation's right to renew.
          AND lease.state = 'quarantined' AND lease.expires_at <= v_now
          AND admission.workload_role = 'paid' AND admission.logical_provider = 'gemini'
          AND admission.expires_at <= v_now
          AND attempt.stage = 'genderResolution' AND attempt.status = 'reserved'
          AND job.status IN ('pending', 'processing')
          AND job.lease_token IS DISTINCT FROM attempt.job_claim_token
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_ai_attempts AS newer
              WHERE newer.request_id = attempt.request_id AND newer.operation_key = attempt.operation_key
                AND newer.attempt > attempt.attempt
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
              WHERE checkpoint.request_id = attempt.request_id AND checkpoint.operation_key = attempt.operation_key
          )
        ORDER BY lease.slot
        LIMIT 8
    LOOP
        IF NOT pg_catalog.pg_try_advisory_xact_lock(
            pg_catalog.hashtextextended('analysis-v2-gemini-leases', 0)
        ) OR dev_live_budget.active_standard_recovery_request_v1() IS DISTINCT FROM v_request THEN
            EXIT;
        END IF;

        -- The shared cutoff verifies the original fences and preserves any
        -- recorded success. Missing usage stays unknown; no budget RPC is used.
        v_reply := public.cutoff_analysis_v2_gender_resolution_attempt(
            v_request, v_candidate.job_key, v_candidate.job_claim_token,
            v_candidate.operation_key, v_candidate.attempt::smallint, v_candidate.reservation_token,
            pg_catalog.jsonb_build_object(
                'model_name', v_candidate.model_name,
                'location', v_candidate.location,
                'stage', 'genderResolution',
                'thinking_level', v_candidate.thinking_level,
                'media_count', v_candidate.media_count,
                'media_resolution', v_candidate.media_resolution,
                'prompt_version', v_candidate.prompt_version,
                'schema_version', v_candidate.schema_version,
                'max_output_tokens', v_candidate.max_output_tokens,
                'retry_count', v_candidate.retry_count,
                'usage_metadata_status', 'missing',
                'usage_complete', FALSE,
                'prompt_tokens', NULL,
                'completion_tokens', NULL,
                'total_tokens', NULL,
                'thinking_tokens', NULL,
                'latency_ms', LEAST(3600000::numeric, GREATEST(
                    0::numeric, EXTRACT(EPOCH FROM (v_now - v_candidate.created_at)) * 1000
                ))::integer,
                'estimated_cost_usd', NULL,
                'finish_reason', NULL
            ),
            v_candidate.slot, v_candidate.lease_claim_token, v_candidate.fence
        );
        IF v_reply->>'outcome' = 'cutoff' AND v_reply->>'attempt_status' = 'cutoff' THEN
            v_recovered := v_recovered + 1;
        END IF;
    END LOOP;
    RETURN v_recovered;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_dev_live_standard_resolver_cutoffs_v1()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_dev_live_standard_resolver_cutoffs_v1() TO service_role;

CREATE OR REPLACE FUNCTION public.recover_dev_live_standard_provider_admissions_v1(p_limit integer DEFAULT 16)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_request uuid;
    v_preflight uuid;
    v_closed boolean := false;
    v_locked_jobs text[];
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_candidate record;
    v_lease public.analysis_provider_admission_leases%ROWTYPE;
    v_evidence text;
    v_resolved_this boolean;
    v_scanned integer := 0;
    v_recovered integer := 0;
    v_resolved integer := 0;
    v_skipped integer := 0;
    v_failed integer := 0;
    v_slots_reaped integer := 0;
    v_has_more boolean := false;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 64 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PROVIDER_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    v_request := dev_live_budget.active_standard_recovery_request_v1();
    IF v_request IS NULL THEN
        -- When idle, free only terminally evidenced capacity from the latest
        -- closed approval. Its scrubbed preflight target is tied by grant
        -- identity to the immutable owner-start and current policy.
        v_request := dev_live_budget.latest_closed_standard_recovery_request_v1();
        v_closed := v_request IS NOT NULL;
    END IF;
    IF v_request IS NOT NULL THEN
        SELECT request.preflight_id INTO v_preflight
        FROM public.analysis_requests AS request WHERE request.id = v_request;
        PERFORM 1 FROM public.analysis_preflights AS preflight WHERE preflight.id = v_preflight FOR SHARE;
        PERFORM 1 FROM public.analysis_requests AS request WHERE request.id = v_request FOR SHARE;
        IF (CASE WHEN v_closed THEN dev_live_budget.latest_closed_standard_recovery_request_v1()
                 ELSE dev_live_budget.active_standard_recovery_request_v1() END) IS DISTINCT FROM v_request THEN
            v_request := NULL;
        END IF;
    END IF;

    IF v_request IS NOT NULL THEN
        -- Acquire the jobs before either provider's lease rows. A busy job
        -- retains its current owner and can be reconsidered on the next pass.
        SELECT COALESCE(pg_catalog.array_agg(locked.job_key), ARRAY[]::text[]) INTO v_locked_jobs
        FROM (
            SELECT job.job_key
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request
              AND (
                EXISTS (
                    SELECT 1 FROM public.analysis_provider_admission_leases AS lease
                    WHERE lease.request_id = v_request AND lease.job_key = job.job_key
                      AND lease.workload_role = 'paid' AND lease.state IN ('leased', 'recovery_required')
                      AND lease.expires_at <= v_now
                )
                OR EXISTS (
                    SELECT 1 FROM public.analysis_v2_gemini_leases AS lease
                    WHERE lease.request_id = v_request AND lease.job_key = job.job_key
                      AND lease.state IN ('leased', 'quarantined') AND lease.expires_at <= v_now
                )
              )
            ORDER BY job.job_key
            FOR SHARE OF job SKIP LOCKED
        ) AS locked;

        -- A worker may disappear before moving its expired resolver slot to
        -- quarantine. Do that with the normal job-before-slot lock order.
        -- The separate cutoff RPC handles these rows on the next pass.
        WITH expired_resolver AS (
            SELECT lease.slot
            FROM public.analysis_v2_gemini_leases AS lease
            JOIN public.analysis_pipeline_jobs AS job
              ON job.request_id = lease.request_id AND job.job_key = lease.job_key
            JOIN public.analysis_v2_ai_attempts AS attempt
              ON attempt.request_id = lease.request_id AND attempt.job_key = lease.job_key
             AND attempt.operation_key = lease.operation_key AND attempt.attempt = lease.attempt
            WHERE NOT v_closed AND lease.request_id = v_request
              AND lease.job_key = ANY(v_locked_jobs)
              AND lease.stage = 'genderResolution' AND lease.state = 'leased' AND lease.expires_at <= v_now
              AND attempt.stage = 'genderResolution' AND attempt.status = 'reserved'
              AND job.lease_token IS DISTINCT FROM attempt.job_claim_token
            FOR UPDATE OF lease SKIP LOCKED
        )
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET state = 'quarantined', quarantined_at = v_now, updated_at = v_now
        FROM expired_resolver
        WHERE lease.slot = expired_resolver.slot AND lease.state = 'leased' AND lease.expires_at <= v_now;

        -- Same clearing semantics as the scheduler reaper, narrowed to this
        -- request and a terminal attempt or a proven pre-start owner loss.
        -- Keep uncertain provider attempts and never synthesize a cutoff.
        WITH expired AS (
            SELECT lease.slot
            FROM public.analysis_v2_gemini_leases AS lease
            WHERE lease.request_id = v_request
              AND lease.job_key = ANY(v_locked_jobs)
              AND lease.state IN ('leased', 'quarantined') AND lease.expires_at <= v_now
              AND (
                EXISTS (
                    SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
                    WHERE attempt.request_id = lease.request_id AND attempt.job_key = lease.job_key
                      AND attempt.operation_key = lease.operation_key AND attempt.attempt = lease.attempt
                      AND attempt.terminalized_at IS NOT NULL AND attempt.status NOT IN ('reserved', 'ambiguous')
                )
                OR (NOT v_closed AND EXISTS (
                    SELECT 1 FROM public.analysis_provider_admission_leases AS admission
                    WHERE admission.request_id = lease.request_id AND admission.job_key = lease.job_key
                      AND admission.operation_key = 'gemini:' || lease.operation_key || ':attempt:' || lease.attempt::text
                      AND admission.credential_slot = 'gemini-' || lease.slot::text
                      AND admission.provider_fence = lease.fence AND admission.claim_token = lease.lease_claim_token
                      AND admission.state IN ('leased', 'recovery_required', 'released')
                      AND admission.expires_at <= v_now
                      AND public.analysis_provider_admission_gemini_no_start_proven(admission)
                ))
                OR (
                    NOT v_closed AND public.analysis_v2_valid_ai_operation_key(lease.operation_key)
                    AND lease.attempt BETWEEN 1 AND 4
                    AND NOT EXISTS (
                        SELECT 1 FROM public.analysis_pipeline_jobs AS job
                        WHERE job.request_id = lease.request_id AND job.job_key = lease.job_key
                          AND job.status = 'processing' AND job.lease_expires_at > v_now
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
                        WHERE attempt.request_id = lease.request_id
                          AND attempt.operation_key = lease.operation_key AND attempt.attempt = lease.attempt
                    )
                    AND NOT EXISTS (
                        SELECT 1 FROM public.analysis_provider_admission_leases AS admission
                        WHERE admission.request_id = lease.request_id AND admission.job_key = lease.job_key
                          AND admission.operation_key = 'gemini:' || lease.operation_key || ':attempt:' || lease.attempt::text
                          AND admission.credential_slot = 'gemini-' || lease.slot::text
                          AND admission.provider_fence = lease.fence AND admission.claim_token = lease.lease_claim_token
                    )
                )
              )
            ORDER BY lease.slot
            LIMIT p_limit
            FOR UPDATE OF lease SKIP LOCKED
        )
        UPDATE public.analysis_v2_gemini_leases AS lease
        SET state = 'available', request_id = NULL, job_key = NULL, operation_key = NULL,
            stage = NULL, attempt = NULL, lease_claim_token = NULL,
            acquired_at = NULL, expires_at = NULL, quarantined_at = NULL, updated_at = v_now
        FROM expired
        WHERE lease.slot = expired.slot;
        GET DIAGNOSTICS v_slots_reaped = ROW_COUNT;

        FOR v_candidate IN
            SELECT lease.admission_id, lease.fence
            FROM public.analysis_provider_admission_leases AS lease
            WHERE lease.request_id = v_request AND lease.workload_role = 'paid'
              AND lease.job_key = ANY(v_locked_jobs)
              AND lease.state IN ('leased', 'recovery_required') AND lease.expires_at <= v_now
              AND dev_live_budget.standard_provider_expiry_evidence_v1(lease, v_closed) IS NOT NULL
            ORDER BY lease.expires_at, lease.fence, lease.admission_id
            LIMIT p_limit + 1
        LOOP
            IF v_scanned = p_limit THEN
                v_has_more := true;
                EXIT;
            END IF;
            v_scanned := v_scanned + 1;
            BEGIN
                SELECT lease.* INTO v_lease
                FROM public.analysis_provider_admission_leases AS lease
                WHERE lease.admission_id = v_candidate.admission_id AND lease.fence = v_candidate.fence
                  AND lease.request_id = v_request AND lease.workload_role = 'paid'
                  AND lease.state IN ('leased', 'recovery_required') AND lease.expires_at <= v_now
                FOR UPDATE SKIP LOCKED;
                IF NOT FOUND THEN
                    v_skipped := v_skipped + 1;
                    CONTINUE;
                END IF;
                v_evidence := dev_live_budget.standard_provider_expiry_evidence_v1(v_lease, v_closed);
                IF v_evidence IS NULL OR NOT COALESCE(
                    (public.recover_expired_analysis_provider_admission(
                        v_lease.admission_id, pg_catalog.gen_random_uuid()
                    ) ->> 'recovered')::boolean, false
                ) THEN
                    v_skipped := v_skipped + 1;
                    CONTINUE;
                END IF;

                v_resolved_this := false;
                IF v_evidence <> 'running' THEN
                    v_resolved_this := COALESCE((public.resolve_analysis_provider_admission(
                        v_lease.admission_id, pg_catalog.gen_random_uuid()
                    ) ->> 'resolved')::boolean, false);
                END IF;
                v_recovered := v_recovered + 1;
                IF v_resolved_this THEN
                    v_resolved := v_resolved + 1;
                ELSE
                    v_skipped := v_skipped + 1;
                END IF;
            EXCEPTION WHEN OTHERS THEN
                -- Keep other expired operations recoverable if one row was
                -- concurrently changed, and keep the failed scan observable.
                v_failed := v_failed + 1;
            END;
        END LOOP;
    END IF;

    -- This lease belongs to the preflight even after formal admission. A
    -- running Actor stays fenced for adoption. A terminal ledger also covers
    -- a worker lost between its terminal checkpoint and capacity release.
    FOR v_candidate IN
        SELECT lease.admission_id, run.status AS run_status
        FROM public.analysis_preflights AS preflight
        JOIN dev_live_budget.owner_starts AS owner_start
          ON owner_start.user_id = preflight.user_id
        JOIN dev_live_budget.grants AS approval
          ON approval.grant_id = owner_start.grant_id
         AND preflight.idempotency_key = 'dev-live:owner:standard:' || approval.grant_id::text
        JOIN public.analysis_preflight_provider_runs AS run
          ON run.preflight_id = preflight.id AND run.input_hash = preflight.target_input_hash
        JOIN public.analysis_provider_admission_leases AS lease
          ON lease.request_id = preflight.id AND lease.operation_key = run.operation_key
         AND lease.credential_slot = run.credential_slot AND lease.logical_provider = run.logical_provider
        WHERE preflight.access_mode = 'test_entitlement'
          AND approval.plan_id = 'standard' AND approval.approved_at <= v_now
          AND approval.expires_at = 'infinity'::timestamptz AND NOT approval.blocked
          AND approval.standard_policy_id = dev_live_budget.standard_policy_for_owner(
              owner_start.user_id, owner_start.target_instagram_id
          )
          AND lease.workload_role = 'preflight' AND lease.job_key = 'preflight:provider'
          AND lease.operation_key = 'target-profile-fallback' AND lease.logical_provider = 'apify'
          AND public.analysis_beta_valid_apify_credential_slot(lease.credential_slot)
          AND lease.expires_at <= v_now AND NULLIF(run.run_id, '') IS NOT NULL
          AND run.run_started_at IS NOT NULL
          AND (
              (lease.state = 'leased' AND run.status = 'running' AND run.terminalized_at IS NULL
               AND owner_start.target_instagram_id = preflight.target_instagram_id
               AND preflight.expires_at > v_now AND preflight.consumed_request_id IS NULL
               AND (preflight.status = 'pending'
                    OR (preflight.status = 'processing' AND preflight.lease_expires_at <= v_now))
               AND NOT EXISTS (SELECT 1 FROM public.analysis_requests AS r WHERE r.preflight_id = preflight.id))
              OR
              (lease.state IN ('leased', 'recovery_required')
               AND run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
               AND run.terminalized_at IS NOT NULL
               AND (owner_start.target_instagram_id = preflight.target_instagram_id
                    OR preflight.pii_scrubbed_at IS NOT NULL))
          )
        ORDER BY lease.expires_at, lease.admission_id
        LIMIT (p_limit - v_scanned + 1)
        FOR SHARE OF preflight, owner_start, approval, run SKIP LOCKED
        FOR UPDATE OF lease SKIP LOCKED
    LOOP
        IF v_scanned = p_limit THEN
            v_has_more := true;
            EXIT;
        END IF;
        v_scanned := v_scanned + 1;
        IF (public.recover_expired_analysis_provider_admission(
            v_candidate.admission_id, pg_catalog.gen_random_uuid()
        ) ->> 'recovered')::boolean THEN
            v_recovered := v_recovered + 1;
            IF v_candidate.run_status <> 'running' AND (public.resolve_analysis_provider_admission(
                v_candidate.admission_id, pg_catalog.gen_random_uuid()
            ) ->> 'resolved')::boolean THEN
                v_resolved := v_resolved + 1;
                CONTINUE;
            END IF;
        END IF;
        v_skipped := v_skipped + 1;
    END LOOP;

    RETURN pg_catalog.jsonb_build_object(
        'scanned', v_scanned, 'recovered', v_recovered, 'resolved', v_resolved,
        'skipped', v_skipped, 'failed', v_failed, 'hasMore', v_has_more,
        'geminiSlotsReaped', v_slots_reaped
    );
END;
$$;

REVOKE ALL ON FUNCTION public.recover_dev_live_standard_provider_admissions_v1(integer)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_dev_live_standard_provider_admissions_v1(integer) TO service_role;
COMMIT;
