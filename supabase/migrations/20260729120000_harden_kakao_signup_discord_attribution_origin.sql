ALTER TABLE public.kakao_signup_discord_outbox DROP CONSTRAINT kakao_signup_discord_outbox_attribution_origin_check;
ALTER TABLE public.kakao_signup_discord_outbox ADD CONSTRAINT kakao_signup_discord_outbox_attribution_origin_check CHECK (
    attribution_origin IS NULL OR (
        attribution_origin ~ '^https?://[a-z0-9][a-z0-9.-]{0,251}/$'
        AND attribution_origin ~ '^https?://[^/]*\.[^/]+/$'
        AND attribution_origin !~ '^https?://(?:localhost|(?:[0-9]{1,3}\.){3}[0-9]{1,3})/'
        AND attribution_origin !~ '\.(localhost|local|internal|test|example|invalid|home|lan|localdomain)/$'
    )
);
DROP FUNCTION public.set_kakao_signup_discord_outbox_profile(uuid,text,char,text,timestamptz,text,text);
CREATE FUNCTION public.set_kakao_signup_discord_outbox_profile(p_user_id uuid,p_masked_name text,p_birthyear char,p_gender text,p_signed_up_at timestamptz,p_attribution_label text DEFAULT NULL,p_attribution_origin text DEFAULT NULL) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$ BEGIN UPDATE public.kakao_signup_discord_outbox SET masked_name=p_masked_name,birthyear=p_birthyear,gender=CASE WHEN p_gender IN ('여성','남성') THEN p_gender ELSE NULL END,signed_up_at=p_signed_up_at,attribution_label=CASE WHEN p_attribution_label IN ('직접 방문','UTM: 카카오','UTM: 구글','UTM: 인스타그램','UTM: 기타','외부 참조: 카카오','외부 참조: 구글','외부 참조: 인스타그램','외부 참조: 기타') THEN p_attribution_label ELSE NULL END,attribution_origin=CASE WHEN p_attribution_origin ~ '^https?://[a-z0-9][a-z0-9.-]{0,251}/$' AND p_attribution_origin ~ '^https?://[^/]*\.[^/]+/$' AND p_attribution_origin !~ '^https?://(?:localhost|(?:[0-9]{1,3}\.){3}[0-9]{1,3})/' AND p_attribution_origin !~ '\.(localhost|local|internal|test|example|invalid|home|lan|localdomain)/$' THEN p_attribution_origin ELSE NULL END,updated_at=clock_timestamp(),profile_staged_at=clock_timestamp() WHERE user_id=p_user_id AND status='pending' AND profile_staged_at IS NULL; RETURN FOUND; END; $$;
REVOKE ALL ON FUNCTION public.set_kakao_signup_discord_outbox_profile(uuid,text,char,text,timestamptz,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.set_kakao_signup_discord_outbox_profile(uuid,text,char,text,timestamptz,text,text) TO service_role;
