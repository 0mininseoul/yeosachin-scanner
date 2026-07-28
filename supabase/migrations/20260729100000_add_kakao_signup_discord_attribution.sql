-- Persist only a bounded, validated acquisition label; never a URL, query, or identifier.
ALTER TABLE public.kakao_signup_discord_outbox
    ADD COLUMN attribution_label text CHECK (attribution_label IN ('직접 방문', 'UTM: 카카오', 'UTM: 구글', 'UTM: 인스타그램', 'UTM: 기타', '외부 참조: 카카오', '외부 참조: 구글', '외부 참조: 인스타그램', '외부 참조: 기타') OR attribution_label IS NULL);

DROP FUNCTION public.set_kakao_signup_discord_outbox_profile(uuid, text, char, text, timestamptz);
CREATE FUNCTION public.set_kakao_signup_discord_outbox_profile(p_user_id uuid, p_masked_name text, p_birthyear char, p_gender text, p_signed_up_at timestamptz, p_attribution_label text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
    UPDATE public.kakao_signup_discord_outbox
    SET masked_name = p_masked_name, birthyear = p_birthyear,
        gender = CASE WHEN p_gender IN ('여성', '남성') THEN p_gender ELSE NULL END,
        signed_up_at = p_signed_up_at,
        attribution_label = CASE WHEN p_attribution_label IN ('직접 방문', 'UTM: 카카오', 'UTM: 구글', 'UTM: 인스타그램', 'UTM: 기타', '외부 참조: 카카오', '외부 참조: 구글', '외부 참조: 인스타그램', '외부 참조: 기타') THEN p_attribution_label ELSE NULL END,
        updated_at = clock_timestamp(), profile_staged_at = clock_timestamp()
    WHERE user_id = p_user_id AND status = 'pending' AND profile_staged_at IS NULL;
    RETURN FOUND;
END; $$;

DROP FUNCTION public.claim_kakao_signup_discord_outbox(uuid, integer);
CREATE FUNCTION public.claim_kakao_signup_discord_outbox(p_user_id uuid DEFAULT NULL, p_limit integer DEFAULT 1)
RETURNS TABLE (id uuid, claim_token uuid, masked_name text, birthyear char(4), gender text, signed_up_at timestamptz, attribution_label text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN RETURN QUERY WITH candidates AS (
    SELECT outbox.id FROM public.kakao_signup_discord_outbox outbox WHERE outbox.status='pending' AND outbox.profile_staged_at IS NOT NULL AND outbox.next_attempt_at <= clock_timestamp() AND (p_user_id IS NULL OR outbox.user_id=p_user_id) ORDER BY outbox.created_at FOR UPDATE SKIP LOCKED LIMIT LEAST(GREATEST(COALESCE(p_limit,1),1),10)
), claimed AS (
    UPDATE public.kakao_signup_discord_outbox outbox SET status='sending', attempts=outbox.attempts+1, claim_token=uuid_generate_v4(), claimed_at=clock_timestamp(), updated_at=clock_timestamp() FROM candidates WHERE outbox.id=candidates.id RETURNING outbox.*
) SELECT claimed.id,claimed.claim_token,claimed.masked_name,claimed.birthyear,claimed.gender,claimed.signed_up_at,claimed.attribution_label,claimed.attempts FROM claimed; END; $$;
REVOKE ALL ON FUNCTION public.set_kakao_signup_discord_outbox_profile(uuid, text, char, text, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_kakao_signup_discord_outbox(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_kakao_signup_discord_outbox_profile(uuid, text, char, text, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_kakao_signup_discord_outbox(uuid, integer) TO service_role;
