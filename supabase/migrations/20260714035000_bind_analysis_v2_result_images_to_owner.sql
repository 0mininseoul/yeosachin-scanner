-- Bind V2 result image resolution to the authenticated analysis owner. The old
-- three-argument service-role RPC is removed so it cannot bypass this boundary.

DROP FUNCTION IF EXISTS public.load_analysis_v2_result_image_url(UUID, TEXT, TEXT);

CREATE FUNCTION public.load_analysis_v2_result_image_url(
    p_request_id UUID,
    p_user_id UUID,
    p_kind TEXT,
    p_candidate_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_url TEXT;
BEGIN
    IF p_request_id IS NULL OR p_user_id IS NULL
       OR p_kind NOT IN ('target', 'female', 'private')
       OR (p_kind = 'target' AND p_candidate_id IS NOT NULL)
       OR (
            p_kind <> 'target'
            AND (p_candidate_id IS NULL OR p_candidate_id !~ '^[A-Za-z0-9._:-]{1,128}$')
       ) THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.user_id = p_user_id
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.status = 'completed'
    ) THEN
        RETURN NULL;
    END IF;
    IF p_kind = 'target' THEN
        SELECT summary.target_profile_image_url INTO v_url
        FROM public.analysis_v2_result_summaries AS summary
        WHERE summary.request_id = p_request_id;
    ELSIF p_kind = 'female' THEN
        SELECT female.profile_image_url INTO v_url
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id
          AND female.candidate_id = p_candidate_id;
    ELSE
        SELECT private_result.profile_image_url INTO v_url
        FROM public.analysis_v2_private_results AS private_result
        WHERE private_result.request_id = p_request_id
          AND private_result.candidate_id = p_candidate_id;
    END IF;
    RETURN v_url;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_result_image_url(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_result_image_url(UUID, UUID, TEXT, TEXT)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_result_image_url(UUID, UUID, TEXT, TEXT) IS
    'Resolves a raw V2 result image only for the authenticated analysis owner.';
