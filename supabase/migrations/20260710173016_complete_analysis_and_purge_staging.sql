-- Finish one analysis atomically so a retry never observes purged staging with an unfinished row.
CREATE OR REPLACE FUNCTION public.complete_analysis_request_and_purge_staging(
    p_request_id UUID,
    p_user_id UUID,
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
    IF p_step_data ? 'targetProfileImage'
       AND jsonb_typeof(p_step_data->'targetProfileImage') <> 'string' THEN
        RAISE EXCEPTION 'invalid compact target profile image';
    END IF;

    UPDATE public.analysis_requests
    SET status = 'completed',
        current_step = 'completed',
        progress = 100,
        progress_step = '분석 완료!',
        completed_at = clock_timestamp(),
        background_processing = FALSE,
        step_data = p_step_data,
        processing_lease_token = NULL,
        processing_lease_expires_at = NULL
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = 'finalize';

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

    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_request_and_purge_staging(
    UUID, UUID, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_analysis_request_and_purge_staging(
    UUID, UUID, JSONB
) TO service_role;

COMMENT ON FUNCTION public.complete_analysis_request_and_purge_staging(UUID, UUID, JSONB) IS
    'Atomically compacts completed pipeline state and removes raw interaction staging.';
