-- Dev QA only. This private function uses the same worker and provider fences as native recovery.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $guard$
BEGIN
    IF to_regclass('dev_ui.runs') IS NULL OR to_regclass('dev_live_budget.standard_owner_policy') IS NULL
        OR to_regnamespace('paid_standard_capacity') IS NOT NULL
        OR to_regprocedure('public.dev_cloud_six_scope_v1(text,uuid,uuid,uuid,uuid)') IS NULL THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_WRONG_DATABASE';
    END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION dev_cloud_six.reclaim_apify_admissions_v1(p_wave text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $reclaim$
DECLARE
    admission public.analysis_provider_admission_leases;
    ledger_state text;
    reclaimed integer := 0;
BEGIN
    -- Closing the wave and releasing its slots cannot race. A worker holding a row lock
    -- keeps its job/slot; a subsequent tick can reconsider it.
    PERFORM 1 FROM dev_cloud_six.waves w WHERE w.digest=p_wave AND w.closed_at IS NULL
        AND w.expires_at>clock_timestamp() FOR SHARE SKIP LOCKED;
    IF NOT FOUND THEN RETURN 0; END IF;

    FOR admission IN
        WITH cohort AS MATERIALIZED (
            SELECT o.result_request_id,o.user_id,q.slot,q.preflight_id,q.order_id
            FROM dev_cloud_six.order_receipts q JOIN public.earlybird_orders o ON o.id=q.order_id
            WHERE q.wave=p_wave AND q.actual_charge_krw=0 AND o.preflight_id=q.preflight_id
                AND o.result_request_id IS NOT NULL
        )
        SELECT l.*
        FROM cohort c JOIN public.analysis_pipeline_jobs j ON j.request_id=c.result_request_id
        JOIN public.analysis_provider_admission_leases l ON l.request_id=j.request_id AND l.job_key=j.job_key
        LEFT JOIN public.analysis_v2_provider_runs r ON r.request_id=l.request_id AND r.job_key=l.job_key
            AND r.operation_key=l.operation_key
        WHERE l.workload_role='paid' AND l.logical_provider='apify' AND l.credential_slot='secondary'
            AND l.budget_key='paid:apify:secondary' AND l.job_key NOT IN ('preflight:provider','paid:target-profile')
            AND l.state IN ('leased','recovery_required')
            AND l.expires_at<=clock_timestamp()
            AND l.admission_id=public.analysis_provider_admission_expected_id(
                'paid','apify','secondary',l.request_id,l.job_key,l.operation_key)
            -- Most ticks see only running provider work. Check lineage for candidates
            -- that can be reclaimed, before taking the job or admission lock.
            AND CASE WHEN (
                (r.request_id IS NULL AND (j.status='processing' AND j.lease_token=l.job_claim_token
                    AND j.lease_expires_at>clock_timestamp()) IS NOT TRUE)
                OR (r.logical_provider='apify' AND r.credential_slot='secondary'
                    AND r.run_id ~ '^CloudQa[a-f0-9]{48}$'
                    AND r.status IN ('succeeded','aborted','failed','timed_out') AND r.terminalized_at IS NOT NULL
                    -- Run termination frees collection capacity. Its delayed cost remains untouched.
                    AND (r.actual_usage_usd IS NULL OR r.actual_usage_usd=0))
            ) THEN public.dev_cloud_six_scope_v1(p_wave,c.user_id,c.preflight_id,c.order_id,c.result_request_id)=c.slot
              ELSE false END
        ORDER BY l.expires_at,l.admission_id LIMIT 8 FOR UPDATE OF j,l SKIP LOCKED
    LOOP
        ledger_state:=public.analysis_provider_admission_ledger_state(admission);
        IF ledger_state='missing' THEN
            -- The native missing-run resolver takes these parent locks before touching the job.
            -- We already hold j/l. Never wait for a worker that holds a parent and needs the job.
            PERFORM 1 FROM public.analysis_requests req JOIN public.analysis_preflights p ON p.id=req.preflight_id
            WHERE req.id=admission.request_id FOR SHARE OF p,req SKIP LOCKED;
        ELSIF ledger_state='terminal' THEN
            -- Cost reconciliation can update this row independently. Pin the same terminal proof
            -- through commit, including NULL usage for a finished but unbilled fixture run.
            PERFORM 1 FROM public.analysis_v2_provider_runs r
            WHERE r.request_id=admission.request_id AND r.job_key=admission.job_key AND r.operation_key=admission.operation_key
                AND r.logical_provider='apify' AND r.credential_slot='secondary' AND r.run_id ~ '^CloudQa[a-f0-9]{48}$'
                AND r.status IN ('succeeded','aborted','failed','timed_out') AND r.terminalized_at IS NOT NULL
                AND (r.actual_usage_usd IS NULL OR r.actual_usage_usd=0) FOR SHARE SKIP LOCKED;
        ELSE
            CONTINUE;
        END IF;
        IF NOT FOUND OR public.analysis_provider_admission_ledger_state(admission) IS DISTINCT FROM ledger_state THEN
            CONTINUE;
        END IF;
        IF (public.recover_expired_analysis_provider_admission(admission.admission_id,gen_random_uuid())->>'recovered')::boolean IS NOT TRUE THEN
            RAISE EXCEPTION 'DEV_CLOUD_SIX_APIFY_RECOVERY_FENCE';
        END IF;
        IF (public.resolve_analysis_provider_admission(admission.admission_id,gen_random_uuid())->>'resolved')::boolean IS NOT TRUE THEN
            RAISE EXCEPTION 'DEV_CLOUD_SIX_APIFY_RECOVERY_FENCE';
        END IF;
        reclaimed:=reclaimed+1;
    END LOOP;
    RETURN reclaimed;
END;
$reclaim$;

ALTER FUNCTION dev_cloud_six.reclaim_apify_admissions_v1(text) OWNER TO postgres;
REVOKE ALL ON FUNCTION dev_cloud_six.reclaim_apify_admissions_v1(text) FROM PUBLIC,anon,authenticated,service_role;
COMMIT;
