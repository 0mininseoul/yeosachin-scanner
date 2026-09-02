-- v2.12 is a forward-only cost policy. Admit its exact snapshots at the live
-- candidate, scheduler, and Gemini lease fences without rewriting history.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- A v2.12 pre-feature skip remains valid only for the existing corroborated
-- official-account path. Preserve every older policy and add v2.12 narrowly.
DO $migration$
DECLARE
    v_constraint TEXT;
BEGIN
    SELECT pg_catalog.pg_get_constraintdef(constraint_row.oid, TRUE)
    INTO v_constraint
    FROM pg_catalog.pg_constraint AS constraint_row
    WHERE constraint_row.conrelid = 'public.analysis_v2_candidate_feature_rows'::pg_catalog.regclass
      AND constraint_row.conname = 'analysis_v2_candidate_feature_pre_feature_admission_check';
    IF v_constraint IS NULL OR pg_catalog.strpos(v_constraint, '''ai-stage-policy-v2.11''') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V212_PREFEATURE_ADMISSION_CONTRACT_DRIFT', ERRCODE = 'P0001';
    END IF;
    v_constraint := pg_catalog.replace(
        v_constraint,
        '''ai-stage-policy-v2.11''',
        '''ai-stage-policy-v2.11'', ''ai-stage-policy-v2.12'''
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
    IF v_constraint IS NULL OR pg_catalog.strpos(v_constraint, '''ai-stage-policy-v2.11''') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V212_PREFEATURE_CLASSIFICATION_CONTRACT_DRIFT', ERRCODE = 'P0001';
    END IF;
    v_constraint := pg_catalog.replace(
        v_constraint,
        '''ai-stage-policy-v2.11''',
        '''ai-stage-policy-v2.11'', ''ai-stage-policy-v2.12'''
    );
    ALTER TABLE public.analysis_v2_candidate_feature_rows
        DROP CONSTRAINT analysis_v2_candidate_feature_classification_check;
    EXECUTE 'ALTER TABLE public.analysis_v2_candidate_feature_rows ADD CONSTRAINT '
        || pg_catalog.quote_ident('analysis_v2_candidate_feature_classification_check')
        || ' ' || v_constraint;
END;
$migration$;

-- The checkpoint RPC has the same explicit policy allowlist for unfeatured
-- triage-only rows. Add v2.12 without broadening any other input contract.
DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := $old$'ai-stage-policy-v2.11'$old$;
    v_new TEXT := $new$'ai-stage-policy-v2.11',
                                'ai-stage-policy-v2.12'$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_checkpoint_candidate_features_complete(uuid,text,uuid,text,integer,integer,jsonb)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V212_PREFEATURE_CHECKPOINT_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

-- The scheduler operation claim fence admits only exact immutable snapshots.
-- Add both current risk families for v2.12 while retaining v2.4/v2.5 v2.11.
DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := $old$v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1')$old$;
    v_new TEXT := $new$v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.12', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.12', 'scheduler', 'ai-scheduler-v1')$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.claim_analysis_v2_scheduler_operation(uuid,text,uuid,text,text,uuid,integer)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V212_SCHEDULER_OPERATION_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

-- Gemini leases have a second exact snapshot fence. Keep the lease protocol
-- intact while admitting the same v2.12 v2.4/v2.5 pair.
DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := $old$OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1')$old$;
    v_new TEXT := $new$OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.11', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.12', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.12', 'scheduler', 'ai-scheduler-v1')$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V212_GEMINI_LEASE_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

-- v2.12 inherits v2.11's quality presentation. The already-installed
-- finalizer wrapper calls this helper, so broaden only its new-policy guard.
DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT := $old$AND request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.11'$old$;
    v_new TEXT := $new$AND request.policy_versions_snapshot->>'aiStage' IN ('ai-stage-policy-v2.11', 'ai-stage-policy-v2.12')$new$;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_apply_v211_summary_tone(uuid)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V212_SUMMARY_TONE_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;
