-- 20260719160000_add_landing_leads.sql
-- 랜딩에서 로그인 벽에 막힌 익명 유저가 제출한 인스타 아이디를 attribution과 함께 수집한다.
-- 클라(anon/authenticated) 접근은 전면 차단하고 service_role(서버 admin)만 기록한다.

CREATE TABLE public.landing_leads (
    id           UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    instagram_id TEXT NOT NULL,
    raw_input    TEXT,
    utm_source   TEXT,
    utm_medium   TEXT,
    utm_campaign TEXT,
    utm_content  TEXT,
    utm_term     TEXT,
    referrer     TEXT,
    user_agent   TEXT,
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX landing_leads_instagram_id_created_at_idx
    ON public.landing_leads(instagram_id, created_at DESC);

ALTER TABLE public.landing_leads ENABLE ROW LEVEL SECURITY;

-- 정책 없음: anon/authenticated 는 접근 불가. service_role 은 RLS 를 우회한다.
REVOKE ALL ON TABLE public.landing_leads FROM anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.landing_leads TO service_role;
