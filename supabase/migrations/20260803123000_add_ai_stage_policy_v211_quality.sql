-- v2.11 is a forward-only quality policy.  It does not rewrite historical
-- request snapshots or completed results: it merely admits its exact immutable
-- snapshot at the live scheduler/checkpoint fences and gives that policy its
-- own public-summary repair.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- A v2.11 pre-feature skip is still possible for a corroborated official
-- account.  Extend the durable contract without weakening older policy rows.
DO $migration$
DECLARE
    v_constraint TEXT;
BEGIN
    SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, TRUE)
    INTO v_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.analysis_v2_candidate_feature_rows'::pg_catalog.regclass
      AND constraint_row.conname = 'analysis_v2_candidate_feature_pre_feature_admission_check';
    IF v_constraint IS NULL OR pg_catalog.strpos(v_constraint, '''ai-stage-policy-v2.10''') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_PREFEATURE_ADMISSION_CONTRACT_DRIFT', ERRCODE = 'P0001';
    END IF;
    v_constraint := pg_catalog.replace(
        v_constraint,
        '''ai-stage-policy-v2.10''',
        '''ai-stage-policy-v2.10'', ''ai-stage-policy-v2.11'''
    );
    ALTER TABLE public.analysis_v2_candidate_feature_rows
        DROP CONSTRAINT analysis_v2_candidate_feature_pre_feature_admission_check;
    EXECUTE 'ALTER TABLE public.analysis_v2_candidate_feature_rows ADD CONSTRAINT '
        || pg_catalog.quote_ident('analysis_v2_candidate_feature_pre_feature_admission_check')
        || ' ' || v_constraint;

    SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, TRUE)
    INTO v_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.analysis_v2_candidate_feature_rows'::pg_catalog.regclass
      AND constraint_row.conname = 'analysis_v2_candidate_feature_classification_check';
    IF v_constraint IS NULL OR pg_catalog.strpos(v_constraint, '''ai-stage-policy-v2.10''') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_PREFEATURE_CLASSIFICATION_CONTRACT_DRIFT', ERRCODE = 'P0001';
    END IF;
    v_constraint := pg_catalog.replace(
        v_constraint,
        '''ai-stage-policy-v2.10''',
        '''ai-stage-policy-v2.10'', ''ai-stage-policy-v2.11'''
    );
    ALTER TABLE public.analysis_v2_candidate_feature_rows
        DROP CONSTRAINT analysis_v2_candidate_feature_classification_check;
    EXECUTE 'ALTER TABLE public.analysis_v2_candidate_feature_rows ADD CONSTRAINT '
        || pg_catalog.quote_ident('analysis_v2_candidate_feature_classification_check')
        || ' ' || v_constraint;
END;
$migration$;

-- The checkpoint RPC duplicates the same narrow policy list for unfeatured,
-- triage-only rows.  Preserve every other validation byte and add v2.11 only.
DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := $old$'ai-stage-policy-v2.9',
                                'ai-stage-policy-v2.10'$old$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_checkpoint_candidate_features_complete(uuid,text,uuid,text,integer,integer,jsonb)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_PREFEATURE_CHECKPOINT_DRIFT', ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.replace(
        v_definition,
        v_old,
        $new$'ai-stage-policy-v2.9',
                                'ai-stage-policy-v2.10',
                                'ai-stage-policy-v2.11'$new$
    );
    EXECUTE v_definition;
END;
$migration$;

-- The operation claim fence admits only exact immutable snapshots.  Add both
-- current risk families for v2.11; no existing snapshot is altered.
DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := $old$(v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1') OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1'))$old$;
    v_new TEXT := $new$(v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1') OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1') OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1') OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1'))$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.claim_analysis_v2_scheduler_operation(uuid,text,uuid,text,text,uuid,integer)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_SCHEDULER_OPERATION_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

-- Gemini leases have a second exact snapshot fence.  Keep its lease protocol
-- intact while allowing the same v2.11 v2.4/v2.5 pair.
DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := $old$OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1')$old$;
    v_new TEXT := $new$OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1')$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_GEMINI_LEASE_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

CREATE OR REPLACE FUNCTION public.analysis_v2_v211_safe_overview_fallback(
    p_sort_ordinal INTEGER
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT CASE pg_catalog.mod(pg_catalog.coalesce(p_sort_ordinal, 0), 6)
        WHEN 0 THEN '소개와 피드의 장면이 자연스럽게 이어집니다. 계정이 보여주는 일상의 결이 또렷하네요.'
        WHEN 1 THEN '사진마다 취향의 방향이 꾸준히 드러납니다. 가볍게 훑어도 계정의 분위기가 선명합니다.'
        WHEN 2 THEN '일상 기록과 관심사가 자연스럽게 섞여 있습니다. 피드의 흐름이 한 사람의 리듬으로 읽힙니다.'
        WHEN 3 THEN '소개 문구와 사진의 톤이 같은 쪽을 향합니다. 보여주고 싶은 모습이 분명한 계정입니다.'
        WHEN 4 THEN '피드 전반에 취향과 활동의 흔적이 고르게 남아 있습니다. 장면마다 계정의 색이 살아 있습니다.'
        ELSE '사진의 선택과 소개가 자연스럽게 맞물립니다. 일상을 기록하는 방식이 인상적으로 남습니다.'
    END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_apply_v211_summary_tone(p_request_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS request
        WHERE request.id = p_request_id
          AND request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.11'
    ) THEN
        RETURN;
    END IF;

    UPDATE public.analysis_v2_female_results AS female
    SET one_line_overview = public.analysis_v2_v211_safe_overview_fallback(female.sort_ordinal)
    WHERE female.request_id = p_request_id
      AND female.one_line_overview ~* (
          '맥락[[:space:]]*(이|은)?[[:space:]]*(부족|없)|'
          || '(공개[[:space:]]*)?(단서|자료|정보)[[:space:]]*(가|는|이)?[[:space:]]*(부족|없)|'
          || '(단정|확정|판단)[[:space:]]*(하기[[:space:]]*)?(어렵|힘들)|'
          || '(분석|수집)[[:space:]]*(제약|한계)|제약(이|은)?[[:space:]]*있|참고[[:space:]]*(결과|용)'
      );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_apply_v211_summary_tone(UUID)
FROM PUBLIC, anon, authenticated, service_role;

-- Keep the audited v2.8/v2.10 presentation function untouched.  The existing
-- completion wrapper invokes the v2.11-only repair after its historical call.
DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := 'PERFORM public.analysis_v2_apply_v28_summary_tone(p_request_id);';
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.complete_analysis_v2_result_and_purge(uuid,text,uuid,text,text)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_FINALIZER_WRAPPER_DRIFT', ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.replace(
        v_definition,
        v_old,
        v_old || E'\n    PERFORM public.analysis_v2_apply_v211_summary_tone(p_request_id);'
    );
    EXECUTE v_definition;
END;
$migration$;

REVOKE ALL ON FUNCTION public.analysis_v2_v211_safe_overview_fallback(INTEGER)
FROM PUBLIC, anon, authenticated, service_role;
