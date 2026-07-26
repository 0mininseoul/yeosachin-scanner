-- Add the immutable scheduler policy marker without changing existing canonical snapshots.
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    item RECORD;
    item_count INTEGER := 0;
BEGIN
    IF p_snapshot IS NULL
       OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
       OR p_snapshot = '{}'::JSONB
       OR pg_catalog.octet_length(p_snapshot::TEXT) > 8192 THEN
        RETURN FALSE;
    END IF;

    IF p_snapshot ? 'scheduler'
       AND p_snapshot->>'scheduler' IS DISTINCT FROM 'ai-scheduler-v1' THEN
        RETURN FALSE;
    END IF;

    FOR item IN SELECT key, value FROM pg_catalog.jsonb_each(p_snapshot) LOOP
        item_count := item_count + 1;
        IF item_count > 16
           OR item.key !~ '^[A-Za-z][A-Za-z0-9._:-]{0,63}$'
           OR pg_catalog.jsonb_typeof(item.value) <> 'string'
           OR pg_catalog.char_length(item.value #>> '{}') < 1
           OR pg_catalog.char_length(item.value #>> '{}') > 128 THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB) TO service_role;
