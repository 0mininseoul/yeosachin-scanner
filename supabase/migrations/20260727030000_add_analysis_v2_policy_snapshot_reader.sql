-- This reader owns its validation contract. It intentionally does not trust a mutable historical
-- validator or a self-attested marker function from an earlier migration.
CREATE OR REPLACE FUNCTION public.analysis_v2_scheduler_reader_valid_policy_snapshot_v1(
    p_snapshot JSONB
)
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
           OR pg_catalog.char_length(item.value #>> '{}') > 128
           OR (item.value #>> '{}') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_scheduler_reader_valid_policy_snapshot_v1(JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_v2_scheduler_reader_valid_policy_snapshot_v1(JSONB)
    TO service_role;

-- Exact scheduler-v1 activation is stricter than the generic reader contract.
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_scheduler_policy_snapshot_v1(
    p_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT public.analysis_v2_scheduler_reader_valid_policy_snapshot_v1(p_snapshot)
       AND pg_catalog.jsonb_typeof(p_snapshot) = 'object'
       AND p_snapshot ?& ARRAY['pipeline', 'risk', 'aiStage', 'scheduler']
       AND NOT EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_object_keys(p_snapshot) AS key_row(policy_key)
           WHERE key_row.policy_key <> ALL (
               ARRAY['pipeline', 'risk', 'aiStage', 'scheduler']::TEXT[]
           )
       )
       AND p_snapshot->>'scheduler' = 'ai-scheduler-v1';
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_scheduler_policy_snapshot_v1(JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_scheduler_policy_snapshot_v1(JSONB)
    TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_policy_versions_snapshot(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT analysis_request.policy_versions_snapshot
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
      AND public.analysis_v2_scheduler_reader_valid_policy_snapshot_v1(
          analysis_request.policy_versions_snapshot
      );
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_policy_versions_snapshot(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_policy_versions_snapshot(UUID)
    TO service_role;
