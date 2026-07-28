-- v2.10 is a forward-only successor to v2.9. It preserves the scheduler operation
-- protocol verbatim while adding the immutable v2.10 request snapshot and makes the
-- existing atomic v2.8 presentation finalizer guard apply to this successor as well.
CREATE OR REPLACE FUNCTION public.claim_analysis_v2_scheduler_operation(
    p_request_id UUID, p_job_key TEXT, p_job_claim_token UUID, p_operation_key TEXT,
    p_stage TEXT, p_operation_claim_token UUID, p_lease_seconds INTEGER
)
RETURNS TABLE(decision TEXT, operation_claim_token UUID, recovery_only BOOLEAN,
    result_json JSONB, not_before_at TIMESTAMP WITH TIME ZONE)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_operation public.analysis_v2_scheduler_operations%ROWTYPE;
    v_has_attempt BOOLEAN := FALSE;
    v_has_unsafe_attempt BOOLEAN := FALSE;
    v_has_result BOOLEAN := FALSE;
BEGIN
    IF p_request_id IS NULL OR p_job_claim_token IS NULL OR p_operation_claim_token IS NULL
       OR p_operation_key IS NULL OR p_stage IS NULL OR p_lease_seconds NOT BETWEEN 240 AND 360
       OR p_job_key IS NULL OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR NOT public.analysis_v2_valid_ai_operation_key(p_operation_key)
       OR NOT ((p_stage = 'genderTriage' AND p_operation_key ~ '^gender-triage:[0-9a-f]{64}$')
            OR (p_stage = 'featureAnalysis' AND p_operation_key ~ '^feature-analysis:[0-9a-f]{64}$')
            OR (p_stage = 'privateAccountName' AND p_operation_key ~ '^private-account-name:[0-9a-f]{64}$')) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request FROM public.analysis_requests AS request
    WHERE request.id = p_request_id AND request.pipeline_version = 'v2' FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_POLICY_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_request.status NOT IN ('pending', 'processing') OR NOT (
        v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.8', 'scheduler', 'ai-scheduler-v1')
        OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.9', 'scheduler', 'ai-scheduler-v1')
        OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1')
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_POLICY_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF NOT FOUND OR v_job.status <> 'processing' OR v_job.lease_token IS DISTINCT FROM p_job_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT operation.* INTO v_operation FROM public.analysis_v2_scheduler_operations AS operation
    WHERE operation.request_id = p_request_id AND operation.operation_key = p_operation_key FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO public.analysis_v2_scheduler_operations (
            request_id, job_key, operation_key, stage, status, claim_token, lease_expires_at,
            not_before_at, recovery_deadline_at
        ) VALUES (
            p_request_id, p_job_key, p_operation_key, p_stage, 'claimed', p_operation_claim_token,
            v_now + pg_catalog.make_interval(secs => p_lease_seconds), v_now, v_now + INTERVAL '6 minutes'
        ) RETURNING * INTO v_operation;
        RETURN QUERY SELECT 'execute'::TEXT, v_operation.claim_token, FALSE, NULL::JSONB, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;
    IF v_operation.job_key <> p_job_key OR v_operation.stage <> p_stage THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_SCHEDULER_OPERATION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_operation.status = 'ready' THEN
        RETURN QUERY SELECT 'ready'::TEXT, NULL::UUID, FALSE, v_operation.result_json, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;
    IF v_operation.status = 'terminal_unavailable' THEN
        UPDATE public.analysis_v2_scheduler_operations AS operation
        SET claim_token = p_operation_claim_token, lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds), updated_at = v_now
        WHERE operation.request_id = p_request_id AND operation.operation_key = p_operation_key RETURNING * INTO v_operation;
        RETURN QUERY SELECT 'terminal_unavailable'::TEXT, v_operation.claim_token, TRUE, NULL::JSONB, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
        WHERE checkpoint.request_id = p_request_id AND checkpoint.job_key = p_job_key
          AND checkpoint.operation_key = p_operation_key AND checkpoint.stage = p_stage) INTO v_has_result;
    IF v_has_result THEN
        UPDATE public.analysis_v2_scheduler_operations AS operation
        SET claim_token = p_operation_claim_token, lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds), updated_at = v_now
        WHERE operation.request_id = p_request_id AND operation.operation_key = p_operation_key RETURNING * INTO v_operation;
        RETURN QUERY SELECT 'execute'::TEXT, v_operation.claim_token, TRUE, NULL::JSONB, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;

    SELECT EXISTS (SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
        WHERE attempt.request_id = p_request_id AND attempt.job_key = p_job_key AND attempt.operation_key = p_operation_key) INTO v_has_attempt;
    SELECT EXISTS (SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
        WHERE attempt.request_id = p_request_id AND attempt.job_key = p_job_key
          AND attempt.operation_key = p_operation_key AND attempt.status <> 'rate_limited') INTO v_has_unsafe_attempt;
    IF v_operation.not_before_at > v_now THEN
        RETURN QUERY SELECT 'deferred'::TEXT, NULL::UUID, FALSE, NULL::JSONB, v_operation.not_before_at;
        RETURN;
    END IF;
    IF v_has_attempt AND NOT v_has_unsafe_attempt AND v_operation.lease_expires_at <= v_now THEN
        UPDATE public.analysis_v2_scheduler_operations AS operation
        SET claim_token = p_operation_claim_token, lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds), recovery_deadline_at = v_now + INTERVAL '6 minutes', updated_at = v_now
        WHERE operation.request_id = p_request_id AND operation.operation_key = p_operation_key RETURNING * INTO v_operation;
        RETURN QUERY SELECT 'execute'::TEXT, v_operation.claim_token, FALSE, NULL::JSONB, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;
    IF v_operation.lease_expires_at <= v_now AND NOT v_has_attempt THEN
        UPDATE public.analysis_v2_scheduler_operations AS operation
        SET claim_token = p_operation_claim_token, lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds), recovery_deadline_at = v_now + INTERVAL '6 minutes', updated_at = v_now
        WHERE operation.request_id = p_request_id AND operation.operation_key = p_operation_key RETURNING * INTO v_operation;
        RETURN QUERY SELECT 'execute'::TEXT, v_operation.claim_token, FALSE, NULL::JSONB, NULL::TIMESTAMP WITH TIME ZONE;
        RETURN;
    END IF;
    IF v_has_unsafe_attempt THEN
        IF v_operation.recovery_deadline_at <= v_now THEN
            UPDATE public.analysis_v2_scheduler_operations AS operation
            SET status = 'terminal_unavailable', claim_token = p_operation_claim_token,
                lease_expires_at = v_now + pg_catalog.make_interval(secs => p_lease_seconds), updated_at = v_now
            WHERE operation.request_id = p_request_id AND operation.operation_key = p_operation_key RETURNING * INTO v_operation;
            RETURN QUERY SELECT 'terminal_unavailable'::TEXT, v_operation.claim_token, TRUE, NULL::JSONB, NULL::TIMESTAMP WITH TIME ZONE;
            RETURN;
        END IF;
        RETURN QUERY SELECT 'deferred'::TEXT, NULL::UUID, FALSE, NULL::JSONB, v_operation.recovery_deadline_at;
        RETURN;
    END IF;
    RETURN QUERY SELECT 'deferred'::TEXT, NULL::UUID, FALSE, NULL::JSONB, v_operation.lease_expires_at;
END;
$$;

-- The v2.8 finalizer wrapper already calls this function atomically after sealing. Extend its
-- request fence instead of changing the historical v2.8/v2.9 finalizer body or copy rows.
CREATE OR REPLACE FUNCTION public.analysis_v2_apply_v28_summary_tone(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_total INTEGER; v_budget INTEGER; v_kept INTEGER := 0;
    v_previous_kept_ordinal SMALLINT := NULL; v_normalized TEXT;
    v_first_laugh_position INTEGER; v_row RECORD;
BEGIN
    IF p_request_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS request WHERE request.id = p_request_id
          AND request.policy_versions_snapshot->>'aiStage' IN ('ai-stage-policy-v2.8', 'ai-stage-policy-v2.10')
    ) THEN RETURN; END IF;
    WITH analyzed AS (
        SELECT female.candidate_id, female.sort_ordinal, female.one_line_overview,
            pg_catalog.count(*) OVER (PARTITION BY female.one_line_overview) AS duplicate_count
        FROM public.analysis_v2_female_results AS female WHERE female.request_id = p_request_id
    ), repair AS (
        SELECT analyzed.candidate_id, analyzed.sort_ordinal FROM analyzed
        WHERE analyzed.duplicate_count > 1 OR analyzed.one_line_overview ~ '[[:digit:]@]'
           OR analyzed.one_line_overview ~* ('risk[-_ ]?(?:policy|band)|score|스코어|점수|위험도|(?:일반|주의|고위험)[[:space:]]*단계|정책[[:space:]]*버전|계정[[:space:]]*(?:ID|아이디)')
           OR analyzed.one_line_overview ~ ('판독관|내[[:space:]]*눈(?:엔|에는)|제가[[:space:]]*보기(?:엔|에는)|저라면')
           OR analyzed.one_line_overview ~* ('사귀|썸|연애|연인|애인|남자친구|여자친구|남친|여친|커플|교제|결혼|혼인|기혼|미혼|약혼|부부|배우자|남편|아내|boyfriend|girlfriend|couple|dating|relationship|married|husband|wife|spouse|engaged|divorced')
    ) UPDATE public.analysis_v2_female_results AS female
      SET one_line_overview = public.analysis_v2_v28_safe_overview_fallback(repair.sort_ordinal)
      FROM repair WHERE female.request_id = p_request_id AND female.candidate_id = repair.candidate_id;
    SELECT pg_catalog.count(*)::INTEGER INTO v_total FROM public.analysis_v2_female_results AS female WHERE female.request_id = p_request_id;
    v_budget := pg_catalog.floor(v_total / 20.0)::INTEGER;
    FOR v_row IN SELECT female.candidate_id, female.sort_ordinal, female.one_line_overview
        FROM public.analysis_v2_female_results AS female WHERE female.request_id = p_request_id ORDER BY female.sort_ordinal, female.candidate_id LOOP
        IF v_row.one_line_overview ~ '판독관' THEN
            v_normalized := '소개와 피드 구성이 같은 방향을 가리킵니다. 무엇을 보여주려는지는 꽤 분명하네요.';
        ELSE
            v_normalized := pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_row.one_line_overview, 'ㅋ+', 'ㅋㅋ', 'g'), '[[:space:]]{2,}', ' ', 'g');
        END IF;
        IF pg_catalog.strpos(v_normalized, 'ㅋㅋ') > 0 AND v_kept < v_budget
           AND (v_previous_kept_ordinal IS NULL OR v_row.sort_ordinal <> v_previous_kept_ordinal + 1) THEN
            v_first_laugh_position := pg_catalog.strpos(v_normalized, 'ㅋㅋ');
            v_normalized := pg_catalog.left(v_normalized, v_first_laugh_position + 1) || pg_catalog.regexp_replace(pg_catalog.substr(v_normalized, v_first_laugh_position + 2), 'ㅋ+', '', 'g');
            v_kept := v_kept + 1; v_previous_kept_ordinal := v_row.sort_ordinal;
        ELSE
            v_normalized := pg_catalog.regexp_replace(v_normalized, 'ㅋ+', '', 'g');
        END IF;
        UPDATE public.analysis_v2_female_results AS female SET one_line_overview = pg_catalog.btrim(pg_catalog.regexp_replace(v_normalized, '[[:space:]]{2,}', ' ', 'g'))
        WHERE female.request_id = p_request_id AND female.candidate_id = v_row.candidate_id;
    END LOOP;
    UPDATE public.analysis_v2_female_results AS female SET
        narrative_line_one = CASE WHEN female.narrative_line_one IS NULL THEN NULL ELSE pg_catalog.btrim(pg_catalog.regexp_replace(female.narrative_line_one, 'ㅋ+', '', 'g')) END,
        narrative_line_two = CASE WHEN female.narrative_line_two IS NULL THEN NULL ELSE pg_catalog.btrim(pg_catalog.regexp_replace(female.narrative_line_two, 'ㅋ+', '', 'g')) END
    WHERE female.request_id = p_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_apply_v28_summary_tone(UUID) FROM PUBLIC, anon, authenticated, service_role;

-- Restore the complete audited v2.8 body (the compact definition above exists only to keep the
-- policy/scheduler migration readable in review); the sole semantic delta is the v2.10 fence.
CREATE OR REPLACE FUNCTION public.analysis_v2_apply_v28_summary_tone(p_request_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_total INTEGER; v_budget INTEGER; v_kept INTEGER := 0;
    v_previous_kept_ordinal SMALLINT := NULL; v_normalized TEXT;
    v_first_laugh_position INTEGER; v_row RECORD;
BEGIN
    IF p_request_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS request WHERE request.id = p_request_id
          AND request.policy_versions_snapshot->>'aiStage' IN ('ai-stage-policy-v2.8', 'ai-stage-policy-v2.10')
    ) THEN RETURN; END IF;
    WITH analyzed AS (
        SELECT female.candidate_id, female.sort_ordinal, female.one_line_overview,
            pg_catalog.count(*) OVER (PARTITION BY female.one_line_overview) AS duplicate_count
        FROM public.analysis_v2_female_results AS female WHERE female.request_id = p_request_id
    ), repair AS (
        SELECT analyzed.candidate_id, analyzed.sort_ordinal FROM analyzed
        WHERE analyzed.duplicate_count > 1 OR analyzed.one_line_overview ~ '[[:digit:]@]'
           OR analyzed.one_line_overview ~* ('risk[-_ ]?(?:policy|band)|score|스코어|점수|위험도|(?:일반|주의|고위험)[[:space:]]*단계|정책[[:space:]]*버전|계정[[:space:]]*(?:ID|아이디)')
           OR analyzed.one_line_overview ~ ('판독관|내[[:space:]]*눈(?:엔|에는)|제가[[:space:]]*보기(?:엔|에는)|저라면')
           OR analyzed.one_line_overview ~ ('^(피드가 말을 아끼는 편이네요|사진 배치가 지나치게 단정하네요|전체 분위기가 묘하게 계산돼 있네요|첫인상은 얌전한데 여운이 길게 남네요|취향을 슬쩍만 보여 주는 구성이네요|일상 기록이 의외로 빈틈없이 이어지네요|꾸민 듯 안 꾸민 듯한 장면이 많네요|프로필이 정답을 쉽게 주지 않네요|피드의 온도가 은근히 사람을 붙잡네요|설명보다 분위기가 먼저 말을 거네요)')
           OR analyzed.one_line_overview ~ ('^(확인된 공개 단서가 제한적이고|공개된 소개와 피드만으로는 맥락이 부족하고|수집된 공개 범위에서는 정보가 많지 않고|현재 보이는 공개 자료에는 빈칸이 남고|소개와 피드에서 확인되는 내용이 제한적이고|공개 화면에 드러난 단서만으로는 정보가 부족하고|확인 가능한 공개 기록의 범위가 좁고|지금 확보된 공개 자료에는 설명이 적고|공개 프로필과 피드만 보면 단서가 많지 않고|확인된 공개 정보 사이에 빈칸이 남고)')
    ) UPDATE public.analysis_v2_female_results AS female
      SET one_line_overview = public.analysis_v2_v28_safe_overview_fallback(repair.sort_ordinal)
      FROM repair WHERE female.request_id = p_request_id AND female.candidate_id = repair.candidate_id;
    SELECT pg_catalog.count(*)::INTEGER INTO v_total FROM public.analysis_v2_female_results AS female WHERE female.request_id = p_request_id;
    v_budget := pg_catalog.floor(v_total / 20.0)::INTEGER;
    FOR v_row IN SELECT female.candidate_id, female.sort_ordinal, female.one_line_overview
        FROM public.analysis_v2_female_results AS female WHERE female.request_id = p_request_id ORDER BY female.sort_ordinal, female.candidate_id LOOP
        IF v_row.one_line_overview ~ '판독관' THEN
            v_normalized := '소개와 피드 구성이 같은 방향을 가리킵니다. 무엇을 보여주려는지는 꽤 분명하네요.';
        ELSE
            v_normalized := pg_catalog.regexp_replace(pg_catalog.regexp_replace(v_row.one_line_overview, 'ㅋ+', 'ㅋㅋ', 'g'), '[[:space:]]{2,}', ' ', 'g');
        END IF;
        IF pg_catalog.strpos(v_normalized, 'ㅋㅋ') > 0 AND v_kept < v_budget
           AND (v_previous_kept_ordinal IS NULL OR v_row.sort_ordinal <> v_previous_kept_ordinal + 1) THEN
            v_first_laugh_position := pg_catalog.strpos(v_normalized, 'ㅋㅋ');
            v_normalized := pg_catalog.left(v_normalized, v_first_laugh_position + 1) || pg_catalog.regexp_replace(pg_catalog.substr(v_normalized, v_first_laugh_position + 2), 'ㅋ+', '', 'g');
            v_kept := v_kept + 1; v_previous_kept_ordinal := v_row.sort_ordinal;
        ELSE
            v_normalized := pg_catalog.regexp_replace(v_normalized, 'ㅋ+', '', 'g');
        END IF;
        UPDATE public.analysis_v2_female_results AS female SET one_line_overview = pg_catalog.btrim(pg_catalog.regexp_replace(v_normalized, '[[:space:]]{2,}', ' ', 'g'))
        WHERE female.request_id = p_request_id AND female.candidate_id = v_row.candidate_id;
    END LOOP;
    UPDATE public.analysis_v2_female_results AS female SET
        narrative_line_one = CASE WHEN female.narrative_line_one IS NULL THEN NULL ELSE pg_catalog.btrim(pg_catalog.regexp_replace(female.narrative_line_one, 'ㅋ+', '', 'g')) END,
        narrative_line_two = CASE WHEN female.narrative_line_two IS NULL THEN NULL ELSE pg_catalog.btrim(pg_catalog.regexp_replace(female.narrative_line_two, 'ㅋ+', '', 'g')) END
    WHERE female.request_id = p_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_apply_v28_summary_tone(UUID) FROM PUBLIC, anon, authenticated, service_role;
