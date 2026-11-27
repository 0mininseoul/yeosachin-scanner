BEGIN;

-- Save an observed external start when the ordinary, claim-authorizing checkpoint
-- is blocked on a parent. This receipt cannot authorize polling or start work.
CREATE OR REPLACE FUNCTION public.record_analysis_v2_provider_run_started_receipt(
    p_request_id uuid, p_job_key text, p_claim_token uuid, p_operation_key text,
    p_input_hash text, p_reservation_token uuid, p_run_id text
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE
    recorded public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_run_id IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_RUN_INVALID';
    END IF;
    SELECT r.* INTO recorded FROM public.analysis_v2_provider_runs r
    WHERE r.request_id=p_request_id AND r.job_key=p_job_key AND r.operation_key=p_operation_key
      AND r.input_hash=p_input_hash AND r.reservation_token=p_reservation_token
      AND r.job_claim_token=p_claim_token FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH';
    END IF;
    IF recorded.run_id=p_run_id THEN RETURN true; END IF;
    IF recorded.run_id IS NOT NULL OR recorded.status<>'starting' THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_RUN_RUN_CONFLICT';
    END IF;
    -- The existing UNIQUE(run_id) serializes duplicate observations across jobs.
    -- No admission, authorization, payment, or cost fields are written.
    UPDATE public.analysis_v2_provider_runs
       SET status='running', run_id=p_run_id, run_started_at=clock_timestamp(), updated_at=clock_timestamp()
     WHERE reservation_token=p_reservation_token;
    RETURN true;
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_RUN_RUN_CONFLICT';
END;
$function$;
REVOKE ALL ON FUNCTION public.record_analysis_v2_provider_run_started_receipt(uuid,text,uuid,text,text,uuid,text)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_analysis_v2_provider_run_started_receipt(uuid,text,uuid,text,text,uuid,text)
    TO service_role;

COMMIT;
