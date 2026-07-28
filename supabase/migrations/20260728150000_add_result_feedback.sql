-- 20260728150000_add_result_feedback.sql
-- 결과 페이지에서 "결과가 정확하지 않나요?"로 접수한 소유자 피드백을 저장한다.
-- landing_leads 와 동일한 경계: 클라(anon/authenticated) 접근은 전면 차단하고
-- service_role(서버 admin)만 기록한다.

CREATE TABLE public.result_feedback (
    id         UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    -- 자유 서술이라 길이를 강하게 제한한다. 프론트도 같은 상한을 건다.
    body       TEXT NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 1000),
    user_agent TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE INDEX result_feedback_request_id_created_at_idx
    ON public.result_feedback(request_id, created_at DESC);

CREATE INDEX result_feedback_created_at_idx
    ON public.result_feedback(created_at DESC);

-- 소유자는 같은 판독에 여러 건을 남길 수 있다. 접수 빈도 제한은 아직 없으므로
-- 남용이 관측되면 라우트에 추가한다.
ALTER TABLE public.result_feedback ENABLE ROW LEVEL SECURITY;

-- 정책 없음: anon/authenticated 는 접근 불가. service_role 은 RLS 를 우회한다.
REVOKE ALL ON TABLE public.result_feedback FROM anon, authenticated;
GRANT INSERT, SELECT ON TABLE public.result_feedback TO service_role;
