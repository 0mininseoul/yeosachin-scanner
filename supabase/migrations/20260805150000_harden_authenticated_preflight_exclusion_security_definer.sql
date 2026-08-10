-- The authenticated owner exclusion RPC validates the caller with auth.uid()
-- and then reads the owner row. The users table is intentionally service-role
-- readable only, so the RPC must perform its narrowly scoped checks as the
-- function owner while retaining the caller identity guard.
ALTER FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    uuid,
    uuid,
    text,
    text
)
    SECURITY DEFINER;

ALTER FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    uuid,
    uuid,
    text,
    text
)
    SET search_path = '';

ALTER FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    uuid,
    uuid,
    text,
    text
)
    SET lock_timeout = '5s';

ALTER FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    uuid,
    uuid,
    text,
    text
)
    SET statement_timeout = '2min';

REVOKE ALL ON FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    uuid,
    uuid,
    text,
    text
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    uuid,
    uuid,
    text,
    text
) TO authenticated;
