-- Sealed maintenance path for one class of completed test-entitlement runs.
-- It never mutates an immutable request policy snapshot or the original finalized rows.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.analysis_v2_v211_maintenance_source_fingerprint(
    p_request_id UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                pg_catalog.concat_ws(
                    E'\n',
                    'analysis-v2-v211-maintenance-source:v1',
                    request.id::TEXT,
                    result_summary.finalizer_input_hash,
                    request.policy_versions_snapshot::TEXT,
                    COALESCE((
                        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                            'actorId', provider_run.actor_id,
                            'credentialSlot', provider_run.credential_slot,
                            'runId', provider_run.run_id,
                            'operationKey', provider_run.operation_key,
                            'status', provider_run.status,
                            'usageReconciledAt', provider_run.usage_reconciled_at
                        ) ORDER BY provider_run.job_key, provider_run.operation_key)::TEXT
                        FROM public.analysis_v2_provider_runs AS provider_run
                        WHERE provider_run.request_id = request.id
                    ), '[]'),
                    COALESCE((
                        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                            'actorId', provider_run.actor_id,
                            'credentialSlot', provider_run.credential_slot,
                            'runId', provider_run.run_id,
                            'operationKey', provider_run.operation_key,
                            'status', provider_run.status,
                            'usageReconciledAt', provider_run.usage_reconciled_at
                        ) ORDER BY provider_run.operation_key)::TEXT
                        FROM public.analysis_preflight_provider_runs AS provider_run
                        WHERE provider_run.preflight_id = request.preflight_id
                    ), '[]')
                ),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    )
    FROM public.analysis_requests AS request
    JOIN public.analysis_v2_result_summaries AS result_summary
      ON result_summary.request_id = request.id
    WHERE request.id = p_request_id;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_v211_maintenance_source_fingerprint(UUID)
FROM PUBLIC, anon, authenticated, service_role;

-- The reader returns only opaque target material and immutable provider descriptors.
CREATE FUNCTION public.read_analysis_v2_test_entitlement_v211_maintenance_source(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_provider_runs JSONB;
    v_preflight_runs JSONB;
BEGIN
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = request.preflight_id
    JOIN public.analysis_v2_result_summaries AS result_summary
      ON result_summary.request_id = request.id
    WHERE request.id = p_request_id
      AND request.status = 'completed'
      AND request.completed_at IS NOT NULL
      AND request.pipeline_version = 'v2'
      AND request.selected_plan_id_snapshot = 'standard'
      AND request.plan_access_mode_snapshot = 'test_entitlement'
      AND request.analysis_entry_channel = 'standard'
      AND request.test_entitlement_jti_hash IS NOT NULL
      AND request.policy_versions_snapshot =
          '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.10","scheduler":"ai-scheduler-v1"}'::JSONB
      AND preflight.user_id = request.user_id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'test_entitlement'
      AND preflight.analysis_entry_channel = 'standard'
      AND preflight.consumed_request_id = request.id
      AND preflight.policy_versions_snapshot = request.policy_versions_snapshot
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id = 'retained.' || pg_catalog.substr(
          pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
      )
      AND preflight.target_full_name IS NULL
      AND preflight.target_bio IS NULL
      AND preflight.target_profile_image_url IS NULL
      AND preflight.exclusion_decision = 'skip'
      AND preflight.excluded_instagram_id IS NULL
      AND result_summary.plan_id = 'standard'
      AND result_summary.score_policy_version = 'risk-policy-v2.5';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_MAINTENANCE_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_request.preflight_id;

    IF (
        SELECT pg_catalog.count(*)
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = v_request.id
    ) NOT BETWEEN 1 AND 128 OR (
        SELECT pg_catalog.count(*)
        FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.preflight_id = v_preflight.id
    ) NOT BETWEEN 1 AND 4 OR EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = v_request.id
          AND (provider_run.logical_provider <> 'apify'
            OR provider_run.status <> 'succeeded'
            OR provider_run.run_id IS NULL
            OR provider_run.terminalized_at IS NULL
            OR provider_run.actual_usage_usd IS NULL
            OR provider_run.usage_reconciled_at IS NULL
            OR provider_run.credential_slot NOT IN (
                'primary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary'
            ))
    ) OR EXISTS (
        SELECT 1 FROM public.analysis_preflight_provider_runs AS provider_run
        WHERE provider_run.preflight_id = v_preflight.id
          AND (provider_run.logical_provider <> 'apify'
            OR provider_run.status <> 'succeeded'
            OR provider_run.run_id IS NULL
            OR provider_run.terminalized_at IS NULL
            OR provider_run.actual_usage_usd IS NULL
            OR provider_run.usage_reconciled_at IS NULL
            OR provider_run.credential_slot NOT IN (
                'primary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary'
            ))
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_MAINTENANCE_PROVIDER_LEDGER_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actorId', run.actor_id, 'credentialSlot', run.credential_slot,
        'runId', run.run_id, 'status', run.status, 'operationKey', run.operation_key
    ) ORDER BY run.job_key, run.operation_key) INTO v_provider_runs
    FROM public.analysis_v2_provider_runs AS run WHERE run.request_id = v_request.id;
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actorId', run.actor_id, 'credentialSlot', run.credential_slot,
        'runId', run.run_id, 'status', run.status, 'operationKey', run.operation_key
    ) ORDER BY run.operation_key) INTO v_preflight_runs
    FROM public.analysis_preflight_provider_runs AS run WHERE run.preflight_id = v_preflight.id;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request.id,
        'preflightId', v_preflight.id,
        'targetUsername', 'replay_' || pg_catalog.substr(pg_catalog.md5(v_request.id::TEXT || ':' || v_preflight.id::TEXT), 1, 23),
        'selectedPlanId', 'standard',
        'policyVersions', v_request.policy_versions_snapshot,
        'preflightRuns', v_preflight_runs,
        'providerRuns', v_provider_runs,
        'sourceFingerprint', public.analysis_v2_v211_maintenance_source_fingerprint(v_request.id)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_analysis_v2_test_entitlement_v211_maintenance_source(UUID)
FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_analysis_v2_test_entitlement_v211_maintenance_source(UUID)
TO service_role;

CREATE TABLE public.analysis_v2_result_revisions (
    revision_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_v2_result_summaries(request_id) ON DELETE CASCADE,
    revision_number INTEGER NOT NULL CHECK (revision_number BETWEEN 1 AND 1000),
    state TEXT NOT NULL CHECK (state IN ('published', 'superseded')),
    source_ai_stage_policy TEXT NOT NULL CHECK (source_ai_stage_policy = 'ai-stage-policy-v2.10'),
    evaluation_ai_stage_policy TEXT NOT NULL CHECK (evaluation_ai_stage_policy = 'ai-stage-policy-v2.11'),
    source_fingerprint TEXT NOT NULL CHECK (source_fingerprint ~ '^[a-f0-9]{64}$'),
    original_finalizer_input_hash TEXT NOT NULL CHECK (original_finalizer_input_hash ~ '^[a-f0-9]{64}$'),
    semantic_input_fingerprint TEXT NOT NULL CHECK (semantic_input_fingerprint ~ '^[a-f0-9]{64}$'),
    payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[a-f0-9]{64}$'),
    idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[a-f0-9]{64}$'),
    male_count SMALLINT NOT NULL CHECK (male_count >= 0),
    female_count SMALLINT NOT NULL CHECK (female_count >= 0),
    unknown_count SMALLINT NOT NULL CHECK (unknown_count >= 0),
    applied_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (request_id, revision_number),
    UNIQUE (request_id, idempotency_key),
    CONSTRAINT analysis_v2_result_revisions_gender_total_check CHECK (
        male_count + female_count + unknown_count BETWEEN 0 AND 900
    )
);

CREATE UNIQUE INDEX analysis_v2_result_revisions_one_published_request
    ON public.analysis_v2_result_revisions(request_id) WHERE state = 'published';

CREATE TABLE public.analysis_v2_result_revision_female_rows (
    revision_id UUID NOT NULL REFERENCES public.analysis_v2_result_revisions(revision_id) ON DELETE CASCADE,
    candidate_id VARCHAR(128) NOT NULL,
    sort_ordinal SMALLINT NOT NULL CHECK (sort_ordinal BETWEEN 1 AND 900),
    instagram_id VARCHAR(30) NOT NULL,
    full_name VARCHAR(200),
    profile_image_url TEXT,
    bio VARCHAR(2200),
    display_score NUMERIC(3, 1) NOT NULL,
    risk_band VARCHAR(16) NOT NULL,
    featured_rank SMALLINT,
    recent_mutual_rank SMALLINT,
    analysis_depth VARCHAR(16) NOT NULL,
    one_line_overview VARCHAR(180) NOT NULL,
    narrative_line_one VARCHAR(180),
    narrative_line_two VARCHAR(180),
    PRIMARY KEY (revision_id, candidate_id),
    UNIQUE (revision_id, sort_ordinal),
    UNIQUE (revision_id, instagram_id),
    CONSTRAINT analysis_v2_revision_female_identity_check CHECK (
        candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$' AND instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_revision_female_text_check CHECK (
        (full_name IS NULL OR (pg_catalog.char_length(full_name) BETWEEN 1 AND 200 AND full_name !~ '[[:cntrl:]]'))
        AND (bio IS NULL OR bio !~ '[[:cntrl:]]')
        AND public.analysis_v2_result_valid_image_path(profile_image_url)
        AND public.analysis_v2_result_valid_public_copy(one_line_overview, 180)
    ),
    CONSTRAINT analysis_v2_revision_female_score_check CHECK (
        display_score BETWEEN 1.0 AND 10.0
        AND risk_band IN ('normal', 'caution', 'high_risk')
        AND ((display_score < 4.2 AND risk_band = 'normal')
          OR (display_score = 4.2 AND risk_band IN ('normal', 'caution'))
          OR (display_score > 4.2 AND display_score < 6.8 AND risk_band = 'caution')
          OR (display_score = 6.8 AND risk_band IN ('caution', 'high_risk'))
          OR (display_score > 6.8 AND risk_band = 'high_risk'))
        AND ((risk_band = 'normal' AND featured_rank IS NULL)
          OR (risk_band = 'caution' AND (featured_rank IS NULL OR featured_rank BETWEEN 1 AND 15))
          OR (risk_band = 'high_risk' AND (featured_rank IS NULL OR featured_rank BETWEEN 1 AND 3)))
        AND (recent_mutual_rank IS NULL OR recent_mutual_rank BETWEEN 1 AND 10)
    ),
    CONSTRAINT analysis_v2_revision_female_narrative_check CHECK (
        (risk_band = 'high_risk' AND featured_rank BETWEEN 1 AND 3
            AND analysis_depth = 'narrative'
            AND public.analysis_v2_result_valid_public_copy(narrative_line_one, 180)
            AND public.analysis_v2_result_valid_public_copy(narrative_line_two, 180))
        OR (NOT (risk_band = 'high_risk' AND featured_rank BETWEEN 1 AND 3)
            AND analysis_depth = 'features'
            AND narrative_line_one IS NULL AND narrative_line_two IS NULL)
    )
);

ALTER TABLE public.analysis_v2_result_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_revisions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_revision_female_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_result_revision_female_rows FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_result_revisions, public.analysis_v2_result_revision_female_rows
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_effective_female_results(p_request_id UUID)
RETURNS TABLE (
    candidate_id VARCHAR, sort_ordinal SMALLINT, instagram_id VARCHAR, full_name VARCHAR,
    profile_image_url TEXT, bio VARCHAR, display_score NUMERIC, risk_band VARCHAR,
    featured_rank SMALLINT, recent_mutual_rank SMALLINT, analysis_depth VARCHAR,
    one_line_overview VARCHAR, narrative_line_one VARCHAR, narrative_line_two VARCHAR
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_revision_id UUID;
BEGIN
    SELECT revision.revision_id INTO v_revision_id
    FROM public.analysis_v2_result_revisions AS revision
    WHERE revision.request_id = p_request_id AND revision.state = 'published';
    IF v_revision_id IS NULL THEN
        RETURN QUERY SELECT female.candidate_id, female.sort_ordinal, female.instagram_id,
            female.full_name, female.profile_image_url, female.bio, female.display_score,
            female.risk_band, female.featured_rank, female.recent_mutual_rank,
            female.analysis_depth, female.one_line_overview, female.narrative_line_one,
            female.narrative_line_two
        FROM public.analysis_v2_female_results AS female WHERE female.request_id = p_request_id;
    ELSE
        RETURN QUERY SELECT female.candidate_id, female.sort_ordinal, female.instagram_id,
            female.full_name, female.profile_image_url, female.bio, female.display_score,
            female.risk_band, female.featured_rank, female.recent_mutual_rank,
            female.analysis_depth, female.one_line_overview, female.narrative_line_one,
            female.narrative_line_two
        FROM public.analysis_v2_result_revision_female_rows AS female WHERE female.revision_id = v_revision_id;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_effective_female_results(UUID)
FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_effective_result_summary_json(
    p_request_id UUID,
    p_summary public.analysis_v2_result_summaries
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_revision public.analysis_v2_result_revisions%ROWTYPE;
DECLARE v_summary JSONB;
BEGIN
    v_summary := public.analysis_v2_result_summary_json(p_summary);
    SELECT revision.* INTO v_revision
    FROM public.analysis_v2_result_revisions AS revision
    WHERE revision.request_id = p_request_id AND revision.state = 'published';
    IF v_revision.revision_id IS NULL THEN RETURN v_summary; END IF;
    RETURN pg_catalog.jsonb_set(v_summary, '{genderStats}', pg_catalog.jsonb_build_object(
        'male', v_revision.male_count,
        'female', v_revision.female_count,
        'unknown', v_revision.unknown_count
    ));
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_effective_result_summary_json(
    UUID, public.analysis_v2_result_summaries
) FROM PUBLIC, anon, authenticated, service_role;

-- The only mutation entry point.  It publishes a new immutable result revision;
-- base result tables and the request's frozen policy snapshot are never updated.
CREATE FUNCTION public.apply_analysis_v2_v211_result_revision(
    p_request_id UUID,
    p_source_fingerprint TEXT,
    p_semantic_input_fingerprint TEXT,
    p_idempotency_key TEXT,
    p_expected_current_revision INTEGER,
    p_male_count SMALLINT,
    p_female_count SMALLINT,
    p_unknown_count SMALLINT,
    p_female_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
    v_current public.analysis_v2_result_revisions%ROWTYPE;
    v_existing public.analysis_v2_result_revisions%ROWTYPE;
    v_source_fingerprint TEXT;
    v_payload_hash TEXT;
    v_revision public.analysis_v2_result_revisions%ROWTYPE;
    v_row_count INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_source_fingerprint !~ '^[a-f0-9]{64}$'
       OR p_semantic_input_fingerprint !~ '^[a-f0-9]{64}$'
       OR p_idempotency_key !~ '^[a-f0-9]{64}$'
       OR p_expected_current_revision IS NULL OR p_expected_current_revision NOT BETWEEN 0 AND 999
       OR p_male_count IS NULL OR p_male_count < 0
       OR p_female_count IS NULL OR p_female_count < 0
       OR p_unknown_count IS NULL OR p_unknown_count < 0
       OR p_female_rows IS NULL OR pg_catalog.jsonb_typeof(p_female_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_female_rows) > 900
       OR pg_catalog.octet_length(p_female_rows::TEXT) > 4194304 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id FOR UPDATE;
    SELECT summary.* INTO v_summary
    FROM public.analysis_v2_result_summaries AS summary
    WHERE summary.request_id = p_request_id FOR UPDATE;
    IF NOT FOUND
       OR v_request.status <> 'completed'
       OR v_request.pipeline_version <> 'v2'
       OR v_request.selected_plan_id_snapshot <> 'standard'
       OR v_request.plan_access_mode_snapshot <> 'test_entitlement'
       OR v_request.analysis_entry_channel <> 'standard'
       OR v_request.test_entitlement_jti_hash IS NULL
       OR v_request.policy_versions_snapshot <> '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.10","scheduler":"ai-scheduler-v1"}'::JSONB
       OR v_summary.score_policy_version <> 'risk-policy-v2.5' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_SOURCE_INELIGIBLE', ERRCODE = 'P0001';
    END IF;

    v_source_fingerprint := public.analysis_v2_v211_maintenance_source_fingerprint(p_request_id);
    IF v_source_fingerprint IS NULL OR v_source_fingerprint IS DISTINCT FROM p_source_fingerprint THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_SOURCE_DRIFT', ERRCODE = 'P0001';
    END IF;

    SELECT revision.* INTO v_existing
    FROM public.analysis_v2_result_revisions AS revision
    WHERE revision.request_id = p_request_id AND revision.idempotency_key = p_idempotency_key;
    IF FOUND THEN
        IF v_existing.source_fingerprint IS DISTINCT FROM p_source_fingerprint
           OR v_existing.semantic_input_fingerprint IS DISTINCT FROM p_semantic_input_fingerprint
           OR v_existing.male_count IS DISTINCT FROM p_male_count
           OR v_existing.female_count IS DISTINCT FROM p_female_count
           OR v_existing.unknown_count IS DISTINCT FROM p_unknown_count THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'revisionId', v_existing.revision_id,
            'revisionNumber', v_existing.revision_number,
            'idempotent', true
        );
    END IF;

    SELECT revision.* INTO v_current
    FROM public.analysis_v2_result_revisions AS revision
    WHERE revision.request_id = p_request_id AND revision.state = 'published'
    FOR UPDATE;
    IF COALESCE(v_current.revision_number, 0) <> p_expected_current_revision THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_CONCURRENT_MODIFICATION', ERRCODE = 'P0001';
    END IF;
    IF p_male_count + p_female_count + p_unknown_count <> v_summary.screened_mutuals
       OR p_female_count <> pg_catalog.jsonb_array_length(p_female_rows) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_GENDER_COUNT_DRIFT', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.jsonb_array_elements(p_female_rows) AS item(value)
        WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
           OR NOT (item.value ?& ARRAY[
                'candidateId', 'sortOrdinal', 'instagramId', 'fullName', 'profileImageUrl',
                'bio', 'displayScore', 'riskBand', 'featuredRank', 'recentMutualRank',
                'analysisDepth', 'oneLineOverview', 'highRiskNarrative'
           ])
           OR item.value - ARRAY[
                'candidateId', 'sortOrdinal', 'instagramId', 'fullName', 'profileImageUrl',
                'bio', 'displayScore', 'riskBand', 'featuredRank', 'recentMutualRank',
                'analysisDepth', 'oneLineOverview', 'highRiskNarrative'
           ] <> '{}'::JSONB
           OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
           OR item.value->>'instagramId' !~ '^[a-z0-9._]{1,30}$'
           OR item.value->>'sortOrdinal' !~ '^[1-9][0-9]{0,2}$'
           OR (item.value->>'sortOrdinal')::INTEGER NOT BETWEEN 1 AND 900
           OR pg_catalog.jsonb_typeof(item.value->'fullName') NOT IN ('string', 'null')
           OR pg_catalog.jsonb_typeof(item.value->'profileImageUrl') NOT IN ('string', 'null')
           OR pg_catalog.jsonb_typeof(item.value->'bio') NOT IN ('string', 'null')
           OR pg_catalog.jsonb_typeof(item.value->'displayScore') <> 'number'
           OR item.value->>'riskBand' NOT IN ('normal', 'caution', 'high_risk')
           OR item.value->>'analysisDepth' NOT IN ('features', 'narrative')
           OR NOT public.analysis_v2_result_valid_public_copy(item.value->>'oneLineOverview', 180)
           OR (item.value->'profileImageUrl' <> 'null'::JSONB
                AND NOT public.analysis_v2_result_valid_image_path(item.value->>'profileImageUrl'))
           OR pg_catalog.jsonb_typeof(item.value->'featuredRank') NOT IN ('number', 'null')
           OR pg_catalog.jsonb_typeof(item.value->'recentMutualRank') NOT IN ('number', 'null')
           OR pg_catalog.jsonb_typeof(item.value->'highRiskNarrative') NOT IN ('array', 'null')
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_ROW_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT pg_catalog.count(*) INTO v_row_count
    FROM pg_catalog.jsonb_array_elements(p_female_rows) AS item(value);
    IF (SELECT pg_catalog.count(DISTINCT item.value->>'candidateId') FROM pg_catalog.jsonb_array_elements(p_female_rows) AS item(value)) <> v_row_count
       OR (SELECT pg_catalog.count(DISTINCT item.value->>'instagramId') FROM pg_catalog.jsonb_array_elements(p_female_rows) AS item(value)) <> v_row_count
       OR (SELECT pg_catalog.count(DISTINCT (item.value->>'sortOrdinal')::INTEGER) FROM pg_catalog.jsonb_array_elements(p_female_rows) AS item(value)) <> v_row_count
       OR EXISTS (
            SELECT 1 FROM pg_catalog.generate_series(1, v_row_count) AS expected(ordinal)
            WHERE NOT EXISTS (
                SELECT 1 FROM pg_catalog.jsonb_array_elements(p_female_rows) AS item(value)
                WHERE (item.value->>'sortOrdinal')::INTEGER = expected.ordinal
            )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_ROW_ORDER_DRIFT', ERRCODE = 'P0001';
    END IF;

    v_payload_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        pg_catalog.concat_ws(E'\n', 'analysis-v2-v211-revision-payload:v1',
            p_request_id::TEXT, p_source_fingerprint, p_semantic_input_fingerprint,
            p_male_count::TEXT, p_female_count::TEXT, p_unknown_count::TEXT,
            p_female_rows::TEXT), 'UTF8'), 'sha256'), 'hex');
    IF v_current.revision_id IS NOT NULL THEN
        UPDATE public.analysis_v2_result_revisions SET state = 'superseded'
        WHERE revision_id = v_current.revision_id;
    END IF;
    INSERT INTO public.analysis_v2_result_revisions (
        request_id, revision_number, state, source_ai_stage_policy,
        evaluation_ai_stage_policy, source_fingerprint, original_finalizer_input_hash,
        semantic_input_fingerprint, payload_hash, idempotency_key,
        male_count, female_count, unknown_count
    ) VALUES (
        p_request_id, COALESCE(v_current.revision_number, 0) + 1, 'published',
        'ai-stage-policy-v2.10', 'ai-stage-policy-v2.11', p_source_fingerprint,
        v_summary.finalizer_input_hash, p_semantic_input_fingerprint, v_payload_hash,
        p_idempotency_key, p_male_count, p_female_count, p_unknown_count
    ) RETURNING * INTO v_revision;
    INSERT INTO public.analysis_v2_result_revision_female_rows (
        revision_id, candidate_id, sort_ordinal, instagram_id, full_name,
        profile_image_url, bio, display_score, risk_band, featured_rank,
        recent_mutual_rank, analysis_depth, one_line_overview,
        narrative_line_one, narrative_line_two
    )
    SELECT v_revision.revision_id, item.value->>'candidateId',
        (item.value->>'sortOrdinal')::SMALLINT, item.value->>'instagramId',
        NULLIF(item.value->>'fullName', ''), NULLIF(item.value->>'profileImageUrl', ''),
        NULLIF(item.value->>'bio', ''), (item.value->>'displayScore')::NUMERIC,
        item.value->>'riskBand', NULLIF(item.value->>'featuredRank', '')::SMALLINT,
        NULLIF(item.value->>'recentMutualRank', '')::SMALLINT,
        item.value->>'analysisDepth', item.value->>'oneLineOverview',
        CASE WHEN item.value->'highRiskNarrative' = 'null'::JSONB THEN NULL ELSE item.value->'highRiskNarrative'->>0 END,
        CASE WHEN item.value->'highRiskNarrative' = 'null'::JSONB THEN NULL ELSE item.value->'highRiskNarrative'->>1 END
    FROM pg_catalog.jsonb_array_elements(p_female_rows) AS item(value);
    RETURN pg_catalog.jsonb_build_object(
        'revisionId', v_revision.revision_id,
        'revisionNumber', v_revision.revision_number,
        'payloadHash', v_revision.payload_hash,
        'idempotent', false
    );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_analysis_v2_v211_result_revision(
    UUID, TEXT, TEXT, TEXT, INTEGER, SMALLINT, SMALLINT, SMALLINT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.apply_analysis_v2_v211_result_revision(
    UUID, TEXT, TEXT, TEXT, INTEGER, SMALLINT, SMALLINT, SMALLINT, JSONB
) TO service_role;

-- Keep the public result contract unchanged while routing only female rows through
-- the published revision pointer.  These drift guards deliberately fail closed if a
-- later result-reader definition no longer contains the audited source relation.
DO $migration$
DECLARE v_definition TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.load_analysis_v2_result_snapshot(uuid,uuid)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, 'FROM public.analysis_v2_female_results AS female') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_SNAPSHOT_READER_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(
        v_definition,
        'FROM public.analysis_v2_female_results AS female',
        'FROM public.analysis_v2_effective_female_results(p_request_id) AS female'
    );
    SELECT pg_catalog.pg_get_functiondef(
        'public.load_analysis_v2_result_snapshot(uuid,uuid)'::pg_catalog.regprocedure
    ) INTO v_definition;
    -- Re-read the replacement definition before inserting the gender-stat overlay.
    IF pg_catalog.strpos(v_definition, '''summary'', public.analysis_v2_result_summary_json(v_summary),') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_SNAPSHOT_SUMMARY_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition,
        '''summary'', public.analysis_v2_result_summary_json(v_summary),',
        '''summary'', public.analysis_v2_effective_result_summary_json(p_request_id, v_summary),'
    );

    SELECT pg_catalog.pg_get_functiondef(
        'public.load_analysis_v2_result_page(uuid,uuid,integer,text,integer,text,integer)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, 'FROM public.analysis_v2_female_results AS female') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_PAGE_READER_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(
        v_definition,
        'FROM public.analysis_v2_female_results AS female',
        'FROM public.analysis_v2_effective_female_results(p_request_id) AS female'
    );
    SELECT pg_catalog.pg_get_functiondef(
        'public.load_analysis_v2_result_page(uuid,uuid,integer,text,integer,text,integer)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, '''summary'', public.analysis_v2_result_summary_json(v_summary),') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_PAGE_SUMMARY_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition,
        '''summary'', public.analysis_v2_result_summary_json(v_summary),',
        '''summary'', public.analysis_v2_effective_result_summary_json(p_request_id, v_summary),'
    );

    SELECT pg_catalog.pg_get_functiondef(
        'public.load_analysis_v2_result_image_url(uuid,text,text)'::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, 'FROM public.analysis_v2_female_results AS female') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_IMAGE_READER_DRIFT', ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.strpos(v_definition, E'FROM public.analysis_v2_female_results AS female\n        WHERE female.request_id = p_request_id\n          AND female.candidate_id = p_candidate_id;') = 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_V211_REVISION_IMAGE_QUERY_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(
        v_definition,
        E'FROM public.analysis_v2_female_results AS female\n        WHERE female.request_id = p_request_id\n          AND female.candidate_id = p_candidate_id;',
        E'FROM public.analysis_v2_effective_female_results(p_request_id) AS female\n        WHERE female.candidate_id = p_candidate_id;'
    );
END;
$migration$;
