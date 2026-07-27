-- A Kakao identity's creation in auth.users is the durable first-signup fact.
-- The callback only enriches and delivers this row; relogins never create another row.
CREATE TABLE public.kakao_signup_discord_outbox (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    masked_name text,
    birthyear char(4),
    gender text CHECK (gender IN ('여성', '남성') OR gender IS NULL),
    signed_up_at timestamptz NOT NULL,
    profile_staged_at timestamptz,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous_failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claim_token uuid,
    claimed_at timestamptz,
    sent_at timestamptz,
    failure_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX kakao_signup_discord_outbox_pending_idx
    ON public.kakao_signup_discord_outbox (next_attempt_at, created_at)
    WHERE status = 'pending';

ALTER TABLE public.kakao_signup_discord_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kakao_signup_discord_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.kakao_signup_discord_outbox FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enqueue_kakao_signup_discord_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.raw_app_meta_data ->> 'provider' = 'kakao' THEN
        INSERT INTO public.kakao_signup_discord_outbox (user_id, signed_up_at)
        VALUES (NEW.id, NEW.created_at)
        ON CONFLICT (user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_kakao_auth_user_created_discord_outbox ON auth.users;
CREATE TRIGGER on_kakao_auth_user_created_discord_outbox
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.enqueue_kakao_signup_discord_outbox();

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

CREATE OR REPLACE FUNCTION public.complete_kakao_signup_discord_outbox(
    p_outbox_id uuid,
    p_claim_token uuid,
    p_outcome text,
    p_failure_code text DEFAULT NULL,
    p_retry_after_seconds integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_attempts integer;
BEGIN
    SELECT attempts INTO v_attempts
    FROM public.kakao_signup_discord_outbox
    WHERE id = p_outbox_id AND status = 'sending' AND claim_token = p_claim_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'KAKAO_SIGNUP_OUTBOX_CLAIM_NOT_FOUND';
    END IF;

    UPDATE public.kakao_signup_discord_outbox
    SET status = CASE
            WHEN p_outcome = 'sent' THEN 'sent'
            WHEN p_outcome = 'retry' AND v_attempts < 3 THEN 'pending'
            WHEN p_outcome = 'ambiguous_failed' THEN 'ambiguous_failed'
            ELSE 'failed'
        END,
        next_attempt_at = CASE
            WHEN p_outcome = 'retry' AND v_attempts < 3
                THEN clock_timestamp() + make_interval(secs => LEAST(GREATEST(p_retry_after_seconds, 1), 900))
            ELSE next_attempt_at
        END,
        sent_at = CASE WHEN p_outcome = 'sent' THEN clock_timestamp() ELSE sent_at END,
        failure_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE p_failure_code END,
        claim_token = NULL,
        updated_at = clock_timestamp()
    WHERE id = p_outbox_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_kakao_signup_discord_outbox_profile(
    p_user_id uuid,
    p_masked_name text,
    p_birthyear char(4),
    p_gender text,
    p_signed_up_at timestamptz
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    UPDATE public.kakao_signup_discord_outbox
    SET masked_name = p_masked_name,
        birthyear = p_birthyear,
        gender = CASE WHEN p_gender IN ('여성', '남성') THEN p_gender ELSE NULL END,
        signed_up_at = p_signed_up_at,
        updated_at = clock_timestamp(),
        profile_staged_at = clock_timestamp()
    WHERE user_id = p_user_id
      AND status = 'pending'
      AND profile_staged_at IS NULL;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_kakao_signup_discord_outbox(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_kakao_signup_discord_outbox(uuid, uuid, text, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_kakao_signup_discord_outbox_profile(uuid, text, char, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_kakao_signup_discord_outbox(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_kakao_signup_discord_outbox(uuid, uuid, text, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_kakao_signup_discord_outbox_profile(uuid, text, char, text, timestamptz) TO service_role;
