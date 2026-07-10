-- Fail one active analysis atomically and discard paid-pipeline staging data. Only a compact,
-- explicitly allow-listed subset of state may survive a failure for result-page continuity.
CREATE OR REPLACE FUNCTION public.fail_analysis_request_and_purge_staging(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_error_message TEXT,
    p_step_data JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_expected_step IS NULL
       OR char_length(p_expected_step) < 1
       OR char_length(p_expected_step) > 50 THEN
        RAISE EXCEPTION 'invalid expected analysis step';
    END IF;
    IF p_error_message IS NULL
       OR char_length(p_error_message) < 1
       OR char_length(p_error_message) > 1000 THEN
        RAISE EXCEPTION 'invalid analysis failure message';
    END IF;
    IF p_step_data IS NULL OR jsonb_typeof(p_step_data) <> 'object' THEN
        RAISE EXCEPTION 'invalid compact analysis step data';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_object_keys(p_step_data) AS keys(key_name)
        WHERE key_name NOT IN ('mutualFollows', 'targetProfileImage')
    ) THEN
        RAISE EXCEPTION 'compact analysis step data contains unsupported keys';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND jsonb_typeof(p_step_data->'mutualFollows') <> 'array' THEN
        RAISE EXCEPTION 'invalid compact mutual follows';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND jsonb_array_length(p_step_data->'mutualFollows') > 10 THEN
        RAISE EXCEPTION 'too many compact mutual follows';
    END IF;
    IF p_step_data ? 'mutualFollows'
       AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements(p_step_data->'mutualFollows') AS mutual(username)
           WHERE jsonb_typeof(mutual.username) <> 'string'
              OR char_length(mutual.username #>> '{}') > 30
              OR (mutual.username #>> '{}') !~ '^[a-z0-9._]{1,30}$'
       ) THEN
        RAISE EXCEPTION 'invalid compact mutual follow username';
    END IF;
    IF p_step_data ? 'targetProfileImage'
       AND jsonb_typeof(p_step_data->'targetProfileImage') <> 'string' THEN
        RAISE EXCEPTION 'invalid compact target profile image';
    END IF;
    IF p_step_data ? 'targetProfileImage'
       AND char_length(p_step_data->>'targetProfileImage') > 8192 THEN
        RAISE EXCEPTION 'compact target profile image is too long';
    END IF;

    UPDATE public.analysis_requests
    SET status = 'failed',
        current_step = 'failed',
        progress_step = '분석 처리 중 오류가 발생했습니다.',
        error_message = p_error_message,
        background_processing = FALSE,
        step_data = p_step_data,
        processing_lease_token = NULL,
        processing_lease_expires_at = NULL
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = p_expected_step;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    IF affected_rows <> 1 THEN
        RETURN FALSE;
    END IF;

    DELETE FROM public.analysis_interaction_jobs
    WHERE request_id = p_request_id;
    DELETE FROM public.analysis_interaction_evidence
    WHERE request_id = p_request_id;
    DELETE FROM public.analysis_interaction_scores
    WHERE request_id = p_request_id;
    DELETE FROM public.analysis_results
    WHERE request_id = p_request_id;
    DELETE FROM public.private_accounts
    WHERE request_id = p_request_id;

    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.fail_analysis_request_and_purge_staging(
    UUID, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_analysis_request_and_purge_staging(
    UUID, UUID, TEXT, TEXT, JSONB
) TO service_role;

COMMENT ON FUNCTION public.fail_analysis_request_and_purge_staging(
    UUID, UUID, TEXT, TEXT, JSONB
) IS 'Atomically fails one active pipeline request, compacts retained state, and purges raw interaction staging.';

-- Failed requests created before this migration may retain full follower, profile, caption, or
-- comment payloads. Remove that historical raw state and its staging rows once.
UPDATE public.analysis_requests
SET step_data = '{}'::JSONB,
    background_processing = FALSE,
    processing_lease_token = NULL,
    processing_lease_expires_at = NULL
WHERE status = 'failed';

DELETE FROM public.analysis_interaction_jobs AS interaction_job
USING public.analysis_requests AS analysis_request
WHERE interaction_job.request_id = analysis_request.id
  AND analysis_request.status = 'failed';

DELETE FROM public.analysis_interaction_evidence AS interaction_evidence
USING public.analysis_requests AS analysis_request
WHERE interaction_evidence.request_id = analysis_request.id
  AND analysis_request.status = 'failed';

DELETE FROM public.analysis_interaction_scores AS interaction_score
USING public.analysis_requests AS analysis_request
WHERE interaction_score.request_id = analysis_request.id
  AND analysis_request.status = 'failed';

DELETE FROM public.analysis_results AS analysis_result
USING public.analysis_requests AS analysis_request
WHERE analysis_result.request_id = analysis_request.id
  AND analysis_request.status = 'failed';

DELETE FROM public.private_accounts AS private_account
USING public.analysis_requests AS analysis_request
WHERE private_account.request_id = analysis_request.id
  AND analysis_request.status = 'failed';

-- Expire abandoned work whenever a user starts a new request. The partial unique index remains
-- the final concurrency guard; this trigger only recovers requests that exceeded the hard SLA.
CREATE OR REPLACE FUNCTION public.reject_concurrent_analysis_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    stale_request RECORD;
BEGIN
    FOR stale_request IN
        SELECT
            id,
            user_id,
            COALESCE(current_step, 'pending') AS expected_step
        FROM public.analysis_requests
        WHERE user_id = NEW.user_id
          AND status IN ('pending', 'processing')
          AND created_at < clock_timestamp() - INTERVAL '2 hours'
        FOR UPDATE
    LOOP
        PERFORM public.fail_analysis_request_and_purge_staging(
            stale_request.id,
            stale_request.user_id,
            stale_request.expected_step,
            '분석 처리 시간이 초과되었습니다. 새 분석을 시작해주세요.',
            '{}'::JSONB
        );
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests
        WHERE user_id = NEW.user_id
          AND status IN ('pending', 'processing')
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_ALREADY_IN_PROGRESS';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_concurrent_analysis_request()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_concurrent_analysis_request()
    TO service_role;

COMMENT ON FUNCTION public.reject_concurrent_analysis_request() IS
    'Expires abandoned analyses before rejecting a second active request for the same user.';
