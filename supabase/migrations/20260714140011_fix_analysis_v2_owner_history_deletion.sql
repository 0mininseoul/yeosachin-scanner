-- A consumed preflight and its V2 request form one lifecycle. Deleting a terminal request must
-- remove the retained preflight tombstone in the same transaction instead of failing the deferred
-- foreign-key check at commit.
ALTER TABLE public.analysis_preflights
    DROP CONSTRAINT IF EXISTS analysis_preflights_consumed_request_id_fkey;

ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_consumed_request_id_fkey
    FOREIGN KEY (consumed_request_id)
    REFERENCES public.analysis_requests(id)
    ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED;

-- Owner history is projected through one authenticated RPC so the final V2 username can remain in
-- the RPC-only result table while request/preflight working PII stays scrubbed. Failed V2 rows are
-- intentionally represented without a username.
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
                         AND (
                            analysis_request.status = 'failed'
                            OR analysis_request.target_instagram_id LIKE 'retained.%'
                         )
                        THEN NULL
                    ELSE analysis_request.target_instagram_id
                END,
                'status', analysis_request.status,
                'createdAt', analysis_request.created_at,
                'planType', analysis_request.plan_type,
                'pipelineVersion', CASE
                    WHEN analysis_request.pipeline_version = 'v2' THEN 'v2'
                    ELSE 'v1'
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
    WHERE analysis_request.user_id = v_user_id;

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
    'Authenticated owner-only history projection. Completed V2 usernames come from the final summary; failed V2 request tombstones remain redacted.';
