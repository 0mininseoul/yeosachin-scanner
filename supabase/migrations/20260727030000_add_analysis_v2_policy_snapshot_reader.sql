-- Scheduler admission must derive from the request's persisted policy, never ambient rollout env.
DO $migration$
DECLARE
    v_validator OID;
    v_definition TEXT;
    v_is_immutable BOOLEAN;
    v_is_security_definer BOOLEAN;
BEGIN
    v_validator := pg_catalog.to_regprocedure(
        'public.analysis_v2_valid_policy_versions_snapshot(jsonb)'
    );
    IF v_validator IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_POLICY_PREDECESSOR_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    SELECT
        pg_catalog.pg_get_functiondef(proc.oid),
        proc.provolatile = 'i',
        proc.prosecdef
    INTO v_definition, v_is_immutable, v_is_security_definer
    FROM pg_catalog.pg_proc AS proc
    WHERE proc.oid = v_validator;

    IF NOT v_is_immutable
       OR v_is_security_definer
       OR pg_catalog.strpos(v_definition, 'p_snapshot ? ''scheduler''') = 0
       OR pg_catalog.strpos(v_definition, 'ai-scheduler-v1') = 0
       OR pg_catalog.strpos(v_definition, 'item_count > 16') = 0
       OR pg_catalog.strpos(v_definition, 'jsonb_typeof') = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_SCHEDULER_POLICY_PREDECESSOR_DRIFT',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

-- Versioned exact activation contract. The generic predecessor intentionally remains compatible
-- with legacy snapshots; only this function defines scheduler-v1 eligibility.
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_scheduler_policy_snapshot_v1(
    p_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT public.analysis_v2_valid_policy_versions_snapshot(p_snapshot)
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
      AND public.analysis_v2_valid_policy_versions_snapshot(
          analysis_request.policy_versions_snapshot
      );
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_policy_versions_snapshot(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_policy_versions_snapshot(UUID)
    TO service_role;
