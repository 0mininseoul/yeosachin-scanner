-- Surface the durable V2 aggregate in the owner history without reading terminally scrubbed candidates.
CREATE OR REPLACE FUNCTION public.load_analysis_owner_history_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_user_id UUID := auth.uid();
    v_items JSONB;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_OWNER_HISTORY_AUTH_REQUIRED',
            ERRCODE = '42501';
    END IF;

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'id', analysis_request.id,
                'targetInstagramId', CASE
                    WHEN analysis_request.pipeline_version = 'v2'
                         AND analysis_request.status = 'completed'
                        THEN result_summary.target_instagram_id
                    WHEN analysis_request.pipeline_version = 'v2'
                         AND analysis_request.target_instagram_id LIKE 'retained.%'
                        THEN NULL
                    ELSE analysis_request.target_instagram_id
                END,
                'status', analysis_request.status,
                'createdAt', analysis_request.created_at,
                'planType', analysis_request.plan_type,
                'pipelineVersion', CASE
                    WHEN analysis_request.pipeline_version = 'v2' THEN 'v2'
                    ELSE 'v1'
                END,
                'publicFemaleCount', CASE
                    WHEN analysis_request.pipeline_version = 'v2'
                         AND analysis_request.status = 'completed'
                        THEN result_summary.female_count
                    ELSE NULL
                END
            )
            ORDER BY analysis_request.created_at DESC NULLS LAST, analysis_request.id DESC
        ),
        '[]'::JSONB
    )
    INTO v_items
    FROM public.analysis_requests AS analysis_request
    LEFT JOIN public.analysis_v2_result_summaries AS result_summary
      ON result_summary.request_id = analysis_request.id
     AND analysis_request.pipeline_version = 'v2'
     AND analysis_request.status = 'completed'
    WHERE analysis_request.user_id = v_user_id
      AND analysis_request.status IN ('pending', 'processing', 'completed');

    RETURN pg_catalog.jsonb_build_object(
        'schemaVersion', 1,
        'items', v_items
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_owner_history_v1()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_owner_history_v1()
    TO authenticated;

COMMENT ON FUNCTION public.load_analysis_owner_history_v1() IS
    'Authenticated owner-only history projection. Failed requests remain retained but are excluded; completed V2 usernames and durable female aggregates come from the final summary.';
