-- Scheduler admission must derive from the request's persisted policy, never ambient rollout env.
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
