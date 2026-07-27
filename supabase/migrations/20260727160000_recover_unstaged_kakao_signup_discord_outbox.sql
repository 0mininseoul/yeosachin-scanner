-- If the callback cannot persist profile staging, recover only after a bounded
-- grace period with explicit unavailable fields. This never sends before the
-- callback had a chance to stage the trusted Kakao REST response.
CREATE OR REPLACE FUNCTION public.recover_unstaged_kakao_signup_discord_outbox(
    p_grace_seconds integer DEFAULT 300
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_count integer;
BEGIN
    UPDATE public.kakao_signup_discord_outbox
    SET masked_name = NULL,
        birthyear = NULL,
        gender = NULL,
        profile_staged_at = clock_timestamp(),
        failure_code = 'PROFILE_STAGE_GRACE_EXPIRED_UNAVAILABLE',
        updated_at = clock_timestamp()
    WHERE status = 'pending'
      AND profile_staged_at IS NULL
      AND created_at < clock_timestamp()
            - make_interval(secs => LEAST(GREATEST(COALESCE(p_grace_seconds, 300), 60), 3600));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_unstaged_kakao_signup_discord_outbox(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_unstaged_kakao_signup_discord_outbox(integer) TO service_role;
