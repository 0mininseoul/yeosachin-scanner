-- Apply only in the registered Dev database after live-owner-start-standard.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF pg_catalog.to_regclass('dev_ui.runs') IS NULL
        OR pg_catalog.to_regprocedure('public.dev_live_owner_start_v4(uuid,text,uuid)') IS NULL
        OR pg_catalog.to_regprocedure('public.list_analysis_v2_dispatchable_jobs(integer)') IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_RECOVERY_WRONG_DATABASE';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.list_dev_live_standard_dispatchable_jobs_v1(p_limit integer DEFAULT 100)
RETURNS TABLE (
    request_id uuid,
    job_key text,
    job_status text,
    dispatch_state text,
    dispatch_generation integer,
    reservation_token uuid,
    dispatch_reserved_at timestamptz,
    dispatched_at timestamptz,
    task_name text,
    lease_expires_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_INVALID_JOB_SCAN_INPUT';
    END IF;

    RETURN QUERY
    WITH authorized AS (
        SELECT analysis.id, count(*) OVER () AS active_count
        FROM public.analysis_requests AS analysis
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = analysis.preflight_id AND preflight.consumed_request_id = analysis.id
        JOIN dev_live_budget.owner_starts AS owner_start
          ON owner_start.user_id = analysis.user_id AND owner_start.target_instagram_id = preflight.target_instagram_id
        JOIN dev_live_budget.grants AS approval
          ON approval.grant_id = owner_start.grant_id
         AND preflight.idempotency_key = 'dev-live:owner:standard:' || approval.grant_id::text
        WHERE analysis.pipeline_version = 'v2'
          AND analysis.status IN ('pending', 'processing')
          AND analysis.selected_plan_id_snapshot = 'standard'
          AND preflight.user_id = analysis.user_id
          AND preflight.access_mode = 'test_entitlement'
          AND approval.plan_id = 'standard' AND approval.expires_at = 'infinity'::timestamptz
          AND approval.approved_at <= pg_catalog.statement_timestamp() AND NOT approval.blocked
          AND approval.standard_policy_id = dev_live_budget.standard_policy_for_owner(
              owner_start.user_id, owner_start.target_instagram_id
          )
    )
    SELECT job.request_id, job.job_key::text, job.status::text,
           job.dispatch_state::text, job.dispatch_generation,
           job.dispatch_reservation_token, job.dispatch_reserved_at,
           job.dispatched_at, job.dispatch_task_name::text, job.lease_expires_at
    FROM public.analysis_pipeline_jobs AS job
    JOIN authorized ON authorized.id = job.request_id AND authorized.active_count = 1
    WHERE job.status IN ('pending', 'processing')
      AND job.recovery_not_before <= pg_catalog.statement_timestamp()
      AND (job.scheduler_not_before_at IS NULL OR job.scheduler_not_before_at <= pg_catalog.statement_timestamp())
      AND (job.status = 'pending' OR job.lease_expires_at <= pg_catalog.statement_timestamp())
    ORDER BY job.recovery_not_before, job.request_id, job.job_key
    LIMIT p_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.list_dev_live_standard_dispatchable_jobs_v1(integer)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_dev_live_standard_dispatchable_jobs_v1(integer) TO service_role;
COMMIT;
