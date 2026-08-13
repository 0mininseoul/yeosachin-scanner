-- Keep the collection-context v2 RPC private to the service worker. This is
-- ACL-only and leaves the function definition unchanged.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

REVOKE EXECUTE ON FUNCTION public.load_analysis_v2_collection_context_with_policy_v2(UUID,TEXT,UUID,TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.load_analysis_v2_collection_context_with_policy_v2(UUID,TEXT,UUID,TEXT) FROM anon;
REVOKE EXECUTE ON FUNCTION public.load_analysis_v2_collection_context_with_policy_v2(UUID,TEXT,UUID,TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_collection_context_with_policy_v2(UUID,TEXT,UUID,TEXT) TO service_role;

COMMIT;
