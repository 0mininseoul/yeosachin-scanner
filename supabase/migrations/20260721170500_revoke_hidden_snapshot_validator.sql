-- The checkpoint RPCs are SECURITY DEFINER and own validation. Keep the low-level validators
-- unavailable to API roles, matching the original snapshot-validator contract.

REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot_without_hidden_counts(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
