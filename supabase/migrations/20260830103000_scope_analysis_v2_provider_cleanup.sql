BEGIN;

/*
 * Keep the request-wide reserve/list/settle wrappers from 20260714011500.
 * A committed cleanup intent is a request-level spend fence: every provider
 * row for the request must be reconciled before terminal failure can purge
 * staging, and no sibling provider start may be admitted in the meantime.
 *
 * The failed job identity is still needed by workers that decide whether an
 * intent belongs to their delivery. Keep that read exact to the immutable
 * job key and the current analysis_pipeline_jobs.input_hash fence. Provider
 * operation input_hash values are intentionally a different hash domain.
 */
CREATE OR REPLACE FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_input_hash TEXT
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT CASE WHEN intent.request_id IS NULL THEN NULL ELSE
        pg_catalog.jsonb_build_object(
            'requestId', intent.request_id,
            'jobKey', intent.failed_job_key,
            'jobInputHash', intent.failed_job_input_hash,
            'errorCode', intent.error_code
        )
    END
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    JOIN public.analysis_pipeline_jobs AS failed_job
      ON failed_job.request_id = intent.request_id
     AND failed_job.job_key = intent.failed_job_key
     AND failed_job.input_hash = intent.failed_job_input_hash
    WHERE intent.request_id = p_request_id
      AND intent.failed_job_key = p_job_key
      AND failed_job.input_hash = p_job_input_hash
      AND intent.completed_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job(
    UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job(
    UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_provider_run_cleanup_intent_for_job(
    UUID, TEXT, TEXT
) IS 'Returns a cleanup intent only for its exact failed job and current input fence; provider-operation input hashes are not used for cleanup scope.';

COMMIT;
