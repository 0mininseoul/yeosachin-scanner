-- Tail of the atomic Dev install composed by standard-cloud-six-install.mjs.
-- The source Dev allocators are hash-checked by live-standard-capacity.sql.
BEGIN;
-- The original global budget and its rate counters stay on the normal eight-slot path.
CREATE TABLE dev_cloud_six.model_budgets (LIKE public.analysis_provider_admission_budgets INCLUDING ALL);
INSERT INTO dev_cloud_six.model_budgets SELECT * FROM public.analysis_provider_admission_budgets
    WHERE workload_role='paid' AND logical_provider='gemini';
REVOKE ALL ON dev_cloud_six.model_budgets FROM PUBLIC,anon,authenticated,service_role;
DO $$
DECLARE source_oid regprocedure := 'public.acquire_dev_standard_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)'::regprocedure;
    definition text := pg_get_functiondef(source_oid);
    body text;
    split_point integer;
BEGIN
    IF to_regclass('dev_cloud_six.waves') IS NULL OR to_regnamespace('paid_standard_capacity') IS NOT NULL
       OR encode(sha256(convert_to(definition,'UTF8')),'hex') <> '3bf19ebbdda0bd66e5b10cebfe79d15390598d1c083bb8eeb5cf931efd49db28' THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_ALLOCATOR_SOURCE_DRIFT';
    END IF;
    EXECUTE replace(replace(pg_get_functiondef('dev_live_budget.acquire_standard_gemini_lease(uuid,text,text,text,integer,uuid,integer)'::regprocedure),
        'dev_live_budget.acquire_standard_gemini_lease','dev_cloud_six.acquire_direct'),
        'public.analysis_provider_admission_budgets','dev_cloud_six.model_budgets');
    EXECUTE replace(replace(pg_get_functiondef('public.acquire_analysis_provider_admission(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)'::regprocedure),
        'public.acquire_analysis_provider_admission(','dev_cloud_six.acquire_provider('),
        'public.analysis_provider_admission_budgets','dev_cloud_six.model_budgets');
    EXECUTE (SELECT src.definition FROM pg_temp.dev_six_original_provider src);
    UPDATE public.analysis_provider_admission_budgets b SET max_active=l.max_active,rate_limit_per_minute=l.rate_limit_per_minute
        FROM pg_temp.dev_six_original_limits l WHERE b.budget_key=l.budget_key
          AND (b.max_active,b.rate_limit_per_minute) IS DISTINCT FROM (l.max_active,l.rate_limit_per_minute);
    SELECT prosrc INTO STRICT body FROM pg_proc WHERE oid=source_oid;
    -- Reuse the seven-argument physical scheduler with the synthetic grant checked by its outer wrapper.
    -- Neither this private function nor the physical allocator can be called by service_role.
    split_point := strpos(body,E'    END IF;\n    IF p_request_id');
    IF split_point=0 OR strpos(left(body,split_point),'DEV_STANDARD_CAPACITY_APPROVAL_REQUIRED')=0 THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_ALLOCATOR_SOURCE_DRIFT';
    END IF;
    definition := replace(definition,'public.acquire_dev_standard_scheduler_gemini_lease_v1','dev_cloud_six.acquire_scheduled');
    EXECUTE replace(replace(definition,body,left(body,strpos(body,E'\nBEGIN\n')+length(E'\nBEGIN\n')-1)
        ||substr(body,split_point+length(E'    END IF;\n'))),'dev_live_budget.acquire_standard_gemini_lease','dev_cloud_six.acquire_direct');
END;
$$;
REVOKE ALL ON FUNCTION dev_cloud_six.acquire_direct(uuid,text,text,text,integer,uuid,integer),
    dev_cloud_six.acquire_provider(text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer),
    dev_cloud_six.acquire_scheduled(uuid,text,text,text,integer,uuid,integer),
    public.acquire_dev_standard_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer),
    public.acquire_dev_standard_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)
    FROM PUBLIC,anon,authenticated,service_role;

-- This fingerprint of the bound preflight remains true after closure. It prevents fallback to a low-slot live request.
CREATE FUNCTION public.dev_cloud_six_capacity_lineage_v1(p_wave text,p_request_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
    SELECT EXISTS (SELECT FROM public.analysis_requests r JOIN public.analysis_preflights p
        ON p.id=r.preflight_id AND p.user_id=r.user_id JOIN dev_cloud_six.buyers b ON b.user_id=p.user_id
        WHERE r.id=p_request_id AND b.wave=p_wave AND p.idempotency_key='dev-cloud-six:'||b.wave||':'||b.slot)
$$;

CREATE FUNCTION public.dev_cloud_six_capacity_approved_v1(p_wave text,p_request_id uuid,p_job_key text,p_job_claim_token uuid)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path='' AS $$
    SELECT public.dev_cloud_six_scope_v1(p_wave,NULL,NULL,NULL,p_request_id) IS NOT NULL AND EXISTS (
        SELECT FROM public.analysis_requests r JOIN public.analysis_pipeline_jobs j ON j.request_id=r.id
        WHERE r.id=p_request_id AND r.status IN ('pending','processing') AND r.policy_versions_snapshot->>'scheduler'='ai-scheduler-v1'
            AND j.job_key=p_job_key AND j.lease_token=p_job_claim_token AND j.status='processing' AND j.lease_expires_at>clock_timestamp())
$$;

CREATE FUNCTION dev_cloud_six.lock_approved(w text,request uuid,job text,claim uuid)
RETURNS boolean LANGUAGE plpgsql VOLATILE SET search_path='' SET lock_timeout='250ms' AS $$
BEGIN
    -- These are shared row locks, so unrelated reads and concurrent winners keep running.
    -- Closing a wave or replacing/revoking the actual claim waits for any admitted transaction to finish.
    PERFORM 1 FROM dev_cloud_six.waves v WHERE v.digest=w AND v.closed_at IS NULL AND v.expires_at>clock_timestamp() FOR SHARE;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM 1 FROM public.analysis_requests r JOIN public.analysis_pipeline_jobs j ON j.request_id=r.id
        JOIN public.analysis_preflights p ON p.id=r.preflight_id JOIN public.earlybird_orders o ON o.preflight_id=p.id
        JOIN public.earlybird_fulfillments f ON f.order_id=o.id JOIN auth.users a ON a.id=r.user_id
        WHERE r.id=request AND j.job_key=job AND j.lease_token=claim FOR SHARE OF r,j,p,o,f,a;
    RETURN FOUND AND public.dev_cloud_six_capacity_approved_v1(w,request,job,claim)
        AND EXISTS(SELECT FROM dev_cloud_six.waves WHERE digest=w AND expires_at>clock_timestamp());
END;
$$;
REVOKE ALL ON FUNCTION dev_cloud_six.lock_approved(text,uuid,text,uuid) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.acquire_dev_cloud_six_gemini_lease_v1(p_wave text,p_request_id uuid,p_job_key text,p_operation_key text,
    p_stage text,p_attempt integer,p_claim_token uuid,p_lease_seconds integer,p_job_claim_token uuid)
RETURNS TABLE(outcome text,slot smallint,lease_claim_token uuid,fence bigint,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT public.dev_cloud_six_capacity_approved_v1(p_wave,p_request_id,p_job_key,p_job_claim_token) THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_CLAIM_REQUIRED';
    END IF;
    IF p_stage IN ('featureAnalysis','genderTriage','privateAccountName') THEN
        RETURN QUERY SELECT * FROM dev_cloud_six.acquire_scheduled(p_request_id,p_job_key,p_operation_key,
            p_stage,p_attempt,p_claim_token,p_lease_seconds);
    ELSIF p_stage IN ('genderResolution','partnerSafety','highRiskNarrative') THEN
        RETURN QUERY SELECT * FROM dev_cloud_six.acquire_direct(p_request_id,p_job_key,p_operation_key,
            p_stage,p_attempt,p_claim_token,p_lease_seconds);
    ELSE RAISE EXCEPTION 'DEV_CLOUD_SIX_STAGE_INVALID'; END IF;
    IF NOT dev_cloud_six.lock_approved(p_wave,p_request_id,p_job_key,p_job_claim_token) THEN
        RAISE EXCEPTION 'DEV_CLOUD_SIX_CLAIM_REQUIRED';
    END IF;
END;
$$;

CREATE FUNCTION public.acquire_dev_cloud_six_provider_admission_v1(p_wave text,p_admission_id text,p_workload_role text,p_logical_provider text,
    p_credential_slot text,p_budget_key text,p_request_id uuid,p_job_key text,p_operation_key text,p_job_claim_token uuid,
    p_claim_token uuid,p_provider_fence bigint,p_lease_token uuid,p_lease_seconds integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt jsonb; approved boolean;
BEGIN
    IF p_workload_role IS DISTINCT FROM 'paid' OR p_logical_provider IS DISTINCT FROM 'gemini' THEN
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN';
    END IF;
    IF NOT public.dev_cloud_six_capacity_approved_v1(p_wave,p_request_id,p_job_key,p_job_claim_token) THEN
        IF EXISTS(SELECT FROM public.analysis_provider_admission_leases WHERE admission_id=p_admission_id
            AND state IN ('leased','recovery_required')) THEN RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING'; END IF;
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN';
    END IF;
    receipt := dev_cloud_six.acquire_provider(p_admission_id,p_workload_role,p_logical_provider,p_credential_slot,
        p_budget_key,p_request_id,p_job_key,p_operation_key,p_job_claim_token,p_claim_token,p_provider_fence,p_lease_token,p_lease_seconds);
    IF receipt->>'outcome'='capacity_pending' THEN RETURN receipt; END IF;
    BEGIN
        approved:=dev_cloud_six.lock_approved(p_wave,p_request_id,p_job_key,p_job_claim_token);
    EXCEPTION WHEN lock_not_available THEN
        IF receipt->>'outcome' IN ('already_acquired','adopted') THEN
            RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING';
        END IF;
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING';
    END;
    IF NOT approved THEN
        IF receipt->>'outcome' IN ('already_acquired','adopted') THEN
            RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_RESOLUTION_PENDING';
        END IF;
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_ADMISSION_CREDENTIAL_FORBIDDEN';
    END IF;
    RETURN receipt;
END;
$$;

CREATE FUNCTION public.authorize_dev_cloud_six_vertex_dispatch_v1(p_wave text,p_request_id uuid,p_job_key text,p_claim_token uuid,p_job_input_hash text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
    IF NOT public.authorize_analysis_v2_vertex_dispatch_v1(p_request_id,p_job_key,p_claim_token,p_job_input_hash) THEN RETURN false; END IF;
    RETURN dev_cloud_six.lock_approved(p_wave,p_request_id,p_job_key,p_claim_token);
END;
$$;
CREATE FUNCTION public.reserve_dev_cloud_six_ai_attempt_v1(p_wave text,p_request_id uuid,p_job_key text,p_claim_token uuid,
    p_operation_key text,p_attempt smallint,p_reservation_token uuid,p_metadata jsonb,p_job_input_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE receipt jsonb;
BEGIN
    IF NOT dev_cloud_six.lock_approved(p_wave,p_request_id,p_job_key,p_claim_token) THEN RAISE EXCEPTION 'ANALYSIS_V2_VERTEX_DISPATCH_STOPPED'; END IF;
    receipt := public.reserve_analysis_v2_ai_attempt(p_request_id,p_job_key,p_claim_token,p_operation_key,p_attempt,p_reservation_token,p_metadata);
    IF (receipt->>'created')::boolean AND NOT public.authorize_dev_cloud_six_vertex_dispatch_v1(p_wave,p_request_id,p_job_key,p_claim_token,p_job_input_hash)
        THEN RAISE EXCEPTION 'ANALYSIS_V2_VERTEX_DISPATCH_STOPPED'; END IF;
    RETURN receipt;
END;
$$;
DO $$
DECLARE f regprocedure;
BEGIN
    FOREACH f IN ARRAY ARRAY[
        'public.dev_cloud_six_capacity_lineage_v1(text,uuid)'::regprocedure,
        'public.dev_cloud_six_capacity_approved_v1(text,uuid,text,uuid)'::regprocedure,
        'public.acquire_dev_cloud_six_gemini_lease_v1(text,uuid,text,text,text,integer,uuid,integer,uuid)'::regprocedure,
        'public.acquire_dev_cloud_six_provider_admission_v1(text,text,text,text,text,text,uuid,text,text,uuid,uuid,bigint,uuid,integer)'::regprocedure,
        'public.authorize_dev_cloud_six_vertex_dispatch_v1(text,uuid,text,uuid,text)'::regprocedure,
        'public.reserve_dev_cloud_six_ai_attempt_v1(text,uuid,text,uuid,text,smallint,uuid,jsonb,text)'::regprocedure] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated,service_role',f);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',f);
    END LOOP;
END;
$$;
COMMIT;
