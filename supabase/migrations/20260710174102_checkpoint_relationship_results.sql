-- Merge one paid relationship result into pipeline state as soon as its parallel Actor finishes.
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_relationship_list(
    p_request_id UUID,
    p_user_id UUID,
    p_kind TEXT,
    p_rows JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_kind NOT IN ('followers', 'following') THEN
        RAISE EXCEPTION 'invalid relationship checkpoint kind';
    END IF;
    IF p_rows IS NULL
       OR jsonb_typeof(p_rows) <> 'array'
       OR jsonb_array_length(p_rows) > 1000 THEN
        RAISE EXCEPTION 'invalid relationship checkpoint rows';
    END IF;

    UPDATE public.analysis_requests
    SET step_data = jsonb_set(
        jsonb_set(
            COALESCE(step_data, '{}'::JSONB),
            '{relationshipCheckpoint}',
            COALESCE(step_data->'relationshipCheckpoint', '{}'::JSONB),
            TRUE
        ),
        ARRAY['relationshipCheckpoint', p_kind],
        p_rows,
        TRUE
    )
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = 'collect';

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_relationship_list(
    UUID, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_relationship_list(
    UUID, UUID, TEXT, JSONB
) TO service_role;

COMMENT ON FUNCTION public.checkpoint_analysis_relationship_list(UUID, UUID, TEXT, JSONB) IS
    'Atomically checkpoints one paid relationship list without clobbering its parallel sibling.';
