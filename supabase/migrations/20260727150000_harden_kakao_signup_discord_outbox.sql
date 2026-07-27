-- Do not send an un-staged row. A profile failure stages explicit NULLs instead.
CREATE OR REPLACE FUNCTION public.claim_kakao_signup_discord_outbox(
    p_user_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 1
)
RETURNS TABLE (
    id uuid,
    claim_token uuid,
    masked_name text,
    birthyear char(4),
    gender text,
    signed_up_at timestamptz,
    attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT outbox.id
        FROM public.kakao_signup_discord_outbox AS outbox
        WHERE outbox.status = 'pending'
          AND outbox.profile_staged_at IS NOT NULL
          AND outbox.next_attempt_at <= clock_timestamp()
          AND (p_user_id IS NULL OR outbox.user_id = p_user_id)
        ORDER BY outbox.created_at
        FOR UPDATE SKIP LOCKED
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 10)
    ), claimed AS (
        UPDATE public.kakao_signup_discord_outbox AS outbox
        SET status = 'sending',
            attempts = outbox.attempts + 1,
            claim_token = uuid_generate_v4(),
            claimed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.*
    )
    SELECT claimed.id, claimed.claim_token, claimed.masked_name, claimed.birthyear,
           claimed.gender, claimed.signed_up_at, claimed.attempts
    FROM claimed;
END;
$$;

-- A stale sending lease may already have reached Discord. Terminalize it without another POST.
CREATE OR REPLACE FUNCTION public.reconcile_stale_kakao_signup_discord_claims(
    p_lease_seconds integer DEFAULT 900
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
    SET status = 'ambiguous_failed',
        failure_code = 'DISCORD_CLAIM_LEASE_EXPIRED_AMBIGUOUS',
        claim_token = NULL,
        updated_at = clock_timestamp()
    WHERE status = 'sending'
      AND claimed_at < clock_timestamp()
            - make_interval(secs => LEAST(GREATEST(COALESCE(p_lease_seconds, 900), 60), 3600));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_stale_kakao_signup_discord_claims(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_kakao_signup_discord_claims(integer) TO service_role;
