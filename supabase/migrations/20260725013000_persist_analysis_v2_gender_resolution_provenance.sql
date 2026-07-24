-- MIGRATION_PREDECESSOR=20260724230000
-- Forward-only provenance persistence. Required migration-history predicate:
-- version = '20260724230000'
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260724230000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GENDER_RESOLUTION_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD COLUMN baseline_classification VARCHAR(32),
    ADD COLUMN classification_source TEXT,
    ADD COLUMN gender_resolution_status TEXT,
    ADD COLUMN gender_resolution_operation_key VARCHAR(86),
    ADD COLUMN gender_resolution_result_hash VARCHAR(64);

UPDATE public.analysis_v2_candidate_feature_rows AS feature
SET baseline_classification = feature.terminal_classification,
    classification_source = CASE
        WHEN feature.terminal_classification = 'verified_non_female'
             AND feature.feature_operation_key IS NULL THEN 'triage'
        WHEN feature.terminal_classification IN ('verified_female', 'verified_non_female')
            THEN 'feature'
        WHEN feature.terminal_classification IN ('unresolved', 'unresolved_stage_conflict')
            THEN 'unknown'
        ELSE 'unavailable'
    END,
    gender_resolution_status = 'disabled';

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ALTER COLUMN baseline_classification SET NOT NULL,
    ALTER COLUMN classification_source SET NOT NULL,
    ALTER COLUMN gender_resolution_status SET NOT NULL,
    ADD CONSTRAINT analysis_v2_candidate_feature_baseline_check CHECK (
        baseline_classification IN (
            'verified_female', 'verified_non_female', 'unresolved',
            'unresolved_stage_conflict', 'fetch_unavailable',
            'media_unavailable', 'analysis_unavailable', 'unavailable'
        )
    ),
    ADD CONSTRAINT analysis_v2_candidate_feature_classification_source_check CHECK (
        classification_source IN (
            'triage', 'feature', 'gender_resolution', 'unknown', 'unavailable'
        )
    ),
    ADD CONSTRAINT analysis_v2_candidate_feature_gender_resolution_status_check CHECK (
        gender_resolution_status IN (
            'disabled', 'not_eligible', 'ready_applied', 'ready_not_needed',
            'ready_inconclusive', 'cutoff', 'capacity_skipped', 'terminal_unavailable'
        )
    ),
    ADD CONSTRAINT analysis_v2_candidate_feature_gender_resolution_identity_check CHECK (
        (
            gender_resolution_status IN (
                'ready_applied', 'ready_not_needed', 'ready_inconclusive'
            )
            AND gender_resolution_operation_key
                ~ '^gender-resolution:[a-f0-9]{64}$'
            AND gender_resolution_result_hash ~ '^[a-f0-9]{64}$'
        )
        OR (
            gender_resolution_status NOT IN (
                'ready_applied', 'ready_not_needed', 'ready_inconclusive'
            )
            AND gender_resolution_operation_key IS NULL
            AND gender_resolution_result_hash IS NULL
        )
    ),
    ADD CONSTRAINT analysis_v2_candidate_feature_resolution_change_check CHECK (
        (
            classification_source = 'gender_resolution'
            AND gender_resolution_status = 'ready_applied'
            AND baseline_classification IN ('unresolved', 'unresolved_stage_conflict')
            AND terminal_classification IN ('verified_female', 'verified_non_female')
        )
        OR (
            classification_source <> 'gender_resolution'
            AND gender_resolution_status <> 'ready_applied'
            AND terminal_classification = CASE baseline_classification
                WHEN 'fetch_unavailable' THEN 'unavailable'
                WHEN 'analysis_unavailable' THEN 'unavailable'
                ELSE baseline_classification
            END
        )
    );

CREATE FUNCTION public.analysis_v2_validate_candidate_gender_resolution()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_job_key TEXT;
BEGIN
    IF NEW.baseline_classification IS NULL THEN
        NEW.baseline_classification := NEW.terminal_classification;
    END IF;
    IF NEW.classification_source IS NULL THEN
        NEW.classification_source := CASE
            WHEN NEW.terminal_classification = 'verified_non_female'
                 AND NEW.feature_operation_key IS NULL THEN 'triage'
            WHEN NEW.terminal_classification IN ('verified_female', 'verified_non_female')
                THEN 'feature'
            WHEN NEW.terminal_classification IN ('unresolved', 'unresolved_stage_conflict')
                THEN 'unknown'
            ELSE 'unavailable'
        END;
    END IF;
    IF NEW.gender_resolution_status IS NULL THEN
        NEW.gender_resolution_status := 'disabled';
    END IF;
    IF NEW.gender_resolution_status IN (
        'ready_applied', 'ready_not_needed', 'ready_inconclusive'
    ) THEN
        SELECT manifest.producer_job_key INTO v_job_key
        FROM public.analysis_v2_candidate_feature_manifests AS manifest
        WHERE manifest.request_id = NEW.request_id
          AND manifest.batch = NEW.batch;
        IF v_job_key IS NULL OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_result_checkpoints AS result
            WHERE result.request_id = NEW.request_id
              AND result.job_key = v_job_key
              AND result.operation_key = NEW.gender_resolution_operation_key
              AND result.stage = 'genderResolution'
              AND result.cache_scope = 'request'
              AND result.result_hash = NEW.gender_resolution_result_hash
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_GENDER_RESOLUTION_RESULT_FENCE_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_validate_candidate_gender_resolution()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER validate_analysis_v2_candidate_gender_resolution
BEFORE INSERT OR UPDATE OF
    baseline_classification,
    classification_source,
    gender_resolution_status,
    gender_resolution_operation_key,
    gender_resolution_result_hash
ON public.analysis_v2_candidate_feature_rows
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_validate_candidate_gender_resolution();

ALTER FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
) RENAME TO analysis_v2_checkpoint_candidate_features_complete_v26;

REVOKE ALL ON FUNCTION public.analysis_v2_checkpoint_candidate_features_complete_v26(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_batch INTEGER,
    p_analyzed_count INTEGER,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_stripped_rows JSONB;
    v_checkpoint JSONB;
    v_provenance_count INTEGER;
BEGIN
    IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT
        pg_catalog.jsonb_agg(
            item.value - ARRAY[
                'baselineClassification',
                'classificationSource',
                'genderResolutionStatus',
                'genderResolutionOperationKey',
                'genderResolutionResultHash'
            ]::TEXT[]
            ORDER BY item.value->>'candidateId'
        ),
        pg_catalog.count(*) FILTER (
            WHERE item.value ?& ARRAY[
                'baselineClassification',
                'classificationSource',
                'genderResolutionStatus',
                'genderResolutionOperationKey',
                'genderResolutionResultHash'
            ]
        )::INTEGER
    INTO v_stripped_rows, v_provenance_count
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);

    IF v_provenance_count NOT IN (0, p_analyzed_count)
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE (
                item.value ? 'baselineClassification'
                OR item.value ? 'classificationSource'
                OR item.value ? 'genderResolutionStatus'
                OR item.value ? 'genderResolutionOperationKey'
                OR item.value ? 'genderResolutionResultHash'
            )
            AND NOT item.value ?& ARRAY[
                'baselineClassification',
                'classificationSource',
                'genderResolutionStatus',
                'genderResolutionOperationKey',
                'genderResolutionResultHash'
            ]
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_checkpoint := public.analysis_v2_checkpoint_candidate_features_complete_v26(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_job_input_hash,
        p_batch,
        p_analyzed_count,
        v_stripped_rows
    );

    UPDATE public.analysis_v2_candidate_feature_rows AS feature
    SET baseline_classification = COALESCE(
            item.value->>'baselineClassification',
            item.value->>'classification'
        ),
        classification_source = COALESCE(
            item.value->>'classificationSource',
            CASE
                WHEN item.value->>'classification' = 'verified_non_female'
                     AND item.value->'featureOperationKey' = 'null'::JSONB THEN 'triage'
                WHEN item.value->>'classification' IN (
                    'verified_female', 'verified_non_female'
                ) THEN 'feature'
                WHEN item.value->>'classification' IN (
                    'unresolved', 'unresolved_stage_conflict'
                ) THEN 'unknown'
                ELSE 'unavailable'
            END
        ),
        gender_resolution_status = COALESCE(
            item.value->>'genderResolutionStatus',
            'disabled'
        ),
        gender_resolution_operation_key = NULLIF(
            item.value->>'genderResolutionOperationKey',
            ''
        ),
        gender_resolution_result_hash = NULLIF(
            item.value->>'genderResolutionResultHash',
            ''
        )
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
    WHERE feature.request_id = p_request_id
      AND feature.batch = p_batch
      AND feature.candidate_id = item.value->>'candidateId';

    RETURN v_checkpoint;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_v2_gender_resolution_metrics (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    policy_version VARCHAR(64) NOT NULL,
    screened_count INTEGER NOT NULL,
    resolver_eligible_count INTEGER NOT NULL,
    baseline_unknown_count INTEGER NOT NULL,
    final_unknown_count INTEGER NOT NULL,
    ready_count INTEGER NOT NULL,
    applied_count INTEGER NOT NULL,
    inconclusive_count INTEGER NOT NULL,
    cutoff_count INTEGER NOT NULL,
    capacity_skipped_count INTEGER NOT NULL,
    terminal_unavailable_count INTEGER NOT NULL,
    partial_media_accepted_candidate_count INTEGER NOT NULL,
    selected_media_total INTEGER NOT NULL,
    normalized_media_total INTEGER NOT NULL,
    failed_media_total INTEGER NOT NULL,
    resolver_attempt_count INTEGER NOT NULL,
    resolver_usage_complete_count INTEGER NOT NULL,
    resolver_usage_missing_count INTEGER NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id),
    CONSTRAINT analysis_v2_gender_resolution_metrics_counts_check CHECK (
        screened_count >= 0
        AND resolver_eligible_count BETWEEN 0 AND screened_count
        AND baseline_unknown_count BETWEEN 0 AND screened_count
        AND final_unknown_count BETWEEN 0 AND screened_count
        AND ready_count BETWEEN 0 AND resolver_eligible_count
        AND applied_count BETWEEN 0 AND ready_count
        AND inconclusive_count BETWEEN 0 AND ready_count
        AND cutoff_count BETWEEN 0 AND resolver_eligible_count
        AND capacity_skipped_count BETWEEN 0 AND resolver_eligible_count
        AND terminal_unavailable_count BETWEEN 0 AND resolver_eligible_count
        AND partial_media_accepted_candidate_count BETWEEN 0 AND screened_count
        AND selected_media_total >= 0
        AND normalized_media_total BETWEEN 0 AND selected_media_total
        AND failed_media_total = selected_media_total - normalized_media_total
        AND resolver_attempt_count >= 0
        AND resolver_usage_complete_count BETWEEN 0 AND resolver_attempt_count
        AND resolver_usage_missing_count BETWEEN 0 AND resolver_attempt_count
    )
);

ALTER TABLE public.analysis_v2_gender_resolution_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_gender_resolution_metrics FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_gender_resolution_metrics
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_refresh_gender_resolution_metrics()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_metrics RECORD;
    v_policy_version TEXT;
    v_attempt_count INTEGER;
    v_usage_complete_count INTEGER;
    v_usage_missing_count INTEGER;
BEGIN
    IF NEW.stage_kind <> 'profile_ai_batch' THEN
        RETURN NEW;
    END IF;
    v_policy_version := public.load_analysis_v2_ai_stage_policy_version(NEW.request_id);
    WITH outcomes AS (
        SELECT outcome.value
        FROM public.analysis_v2_ai_scoring_stage_checkpoints AS checkpoint
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            checkpoint.payload->'outcomes'
        ) AS outcome(value)
        WHERE checkpoint.request_id = NEW.request_id
          AND checkpoint.stage_kind = 'profile_ai_batch'
    )
    SELECT
        pg_catalog.count(*)::INTEGER AS screened_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'genderResolutionStatus'
                NOT IN ('disabled', 'not_eligible')
        )::INTEGER AS resolver_eligible_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'baselineClassification'
                NOT IN ('verified_female', 'verified_non_female')
        )::INTEGER AS baseline_unknown_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'status'
                NOT IN ('verified_female', 'verified_non_female')
        )::INTEGER AS final_unknown_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'genderResolutionStatus' IN (
                'ready_applied', 'ready_not_needed', 'ready_inconclusive'
            )
        )::INTEGER AS ready_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'genderResolutionStatus' = 'ready_applied'
        )::INTEGER AS applied_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'genderResolutionStatus' = 'ready_inconclusive'
        )::INTEGER AS inconclusive_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'genderResolutionStatus' = 'cutoff'
        )::INTEGER AS cutoff_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'genderResolutionStatus' = 'capacity_skipped'
        )::INTEGER AS capacity_skipped_count,
        pg_catalog.count(*) FILTER (
            WHERE outcome.value->>'genderResolutionStatus' = 'terminal_unavailable'
        )::INTEGER AS terminal_unavailable_count,
        pg_catalog.count(*) FILTER (
            WHERE pg_catalog.jsonb_array_length(
                    outcome.value->'mediaCoverage'->'failures'
                ) > 0
              AND pg_catalog.jsonb_array_length(
                    outcome.value->'mediaCoverage'->'failures'
                ) * 5
                    <= (outcome.value->'mediaCoverage'->>'selectedCount')::INTEGER
        )::INTEGER AS partial_media_accepted_candidate_count,
        COALESCE(pg_catalog.sum(
            (outcome.value->'mediaCoverage'->>'selectedCount')::INTEGER
        ), 0)::INTEGER AS selected_media_total,
        COALESCE(pg_catalog.sum(
            (outcome.value->'mediaCoverage'->>'normalizedCount')::INTEGER
        ), 0)::INTEGER AS normalized_media_total
    INTO v_metrics
    FROM outcomes AS outcome;

    SELECT
        pg_catalog.count(*)::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE attempt.usage_metadata_status = 'complete'
        )::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE attempt.usage_metadata_status IN ('missing', 'malformed')
        )::INTEGER
    INTO v_attempt_count, v_usage_complete_count, v_usage_missing_count
    FROM public.analysis_v2_ai_attempts AS attempt
    WHERE attempt.request_id = NEW.request_id
      AND attempt.stage = 'genderResolution';

    INSERT INTO public.analysis_v2_gender_resolution_metrics (
        request_id,
        policy_version,
        screened_count,
        resolver_eligible_count,
        baseline_unknown_count,
        final_unknown_count,
        ready_count,
        applied_count,
        inconclusive_count,
        cutoff_count,
        capacity_skipped_count,
        terminal_unavailable_count,
        partial_media_accepted_candidate_count,
        selected_media_total,
        normalized_media_total,
        failed_media_total,
        resolver_attempt_count,
        resolver_usage_complete_count,
        resolver_usage_missing_count
    ) VALUES (
        NEW.request_id,
        v_policy_version,
        v_metrics.screened_count,
        v_metrics.resolver_eligible_count,
        v_metrics.baseline_unknown_count,
        v_metrics.final_unknown_count,
        v_metrics.ready_count,
        v_metrics.applied_count,
        v_metrics.inconclusive_count,
        v_metrics.cutoff_count,
        v_metrics.capacity_skipped_count,
        v_metrics.terminal_unavailable_count,
        v_metrics.partial_media_accepted_candidate_count,
        v_metrics.selected_media_total,
        v_metrics.normalized_media_total,
        v_metrics.selected_media_total - v_metrics.normalized_media_total,
        v_attempt_count,
        v_usage_complete_count,
        v_usage_missing_count
    )
    ON CONFLICT (request_id) DO UPDATE
    SET policy_version = EXCLUDED.policy_version,
        screened_count = EXCLUDED.screened_count,
        resolver_eligible_count = EXCLUDED.resolver_eligible_count,
        baseline_unknown_count = EXCLUDED.baseline_unknown_count,
        final_unknown_count = EXCLUDED.final_unknown_count,
        ready_count = EXCLUDED.ready_count,
        applied_count = EXCLUDED.applied_count,
        inconclusive_count = EXCLUDED.inconclusive_count,
        cutoff_count = EXCLUDED.cutoff_count,
        capacity_skipped_count = EXCLUDED.capacity_skipped_count,
        terminal_unavailable_count = EXCLUDED.terminal_unavailable_count,
        partial_media_accepted_candidate_count =
            EXCLUDED.partial_media_accepted_candidate_count,
        selected_media_total = EXCLUDED.selected_media_total,
        normalized_media_total = EXCLUDED.normalized_media_total,
        failed_media_total = EXCLUDED.failed_media_total,
        resolver_attempt_count = EXCLUDED.resolver_attempt_count,
        resolver_usage_complete_count = EXCLUDED.resolver_usage_complete_count,
        resolver_usage_missing_count = EXCLUDED.resolver_usage_missing_count,
        updated_at = pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_refresh_gender_resolution_metrics()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER refresh_analysis_v2_gender_resolution_metrics
AFTER INSERT OR UPDATE OF payload
ON public.analysis_v2_ai_scoring_stage_checkpoints
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_refresh_gender_resolution_metrics();

CREATE OR REPLACE FUNCTION public.analysis_v2_result_summary_json(
    p_summary public.analysis_v2_result_summaries
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'targetInstagramId', p_summary.target_instagram_id,
        'targetProfileImageUrl', p_summary.target_profile_image_url,
        'planId', p_summary.plan_id,
        'followers', pg_catalog.jsonb_build_object(
            'declared', p_summary.followers_declared,
            'collected', p_summary.followers_collected,
            'coverageRatio', CASE WHEN p_summary.followers_declared = 0 THEN 1
                ELSE p_summary.followers_collected::DOUBLE PRECISION
                    / p_summary.followers_declared::DOUBLE PRECISION END,
            'meetsCoverageGate', p_summary.followers_declared = 0
                OR p_summary.followers_collected * 100 >= p_summary.followers_declared * 99,
            'exactCountMatch', p_summary.followers_collected = p_summary.followers_declared
        ),
        'following', pg_catalog.jsonb_build_object(
            'declared', p_summary.following_declared,
            'collected', p_summary.following_collected,
            'coverageRatio', CASE WHEN p_summary.following_declared = 0 THEN 1
                ELSE p_summary.following_collected::DOUBLE PRECISION
                    / p_summary.following_declared::DOUBLE PRECISION END,
            'meetsCoverageGate', p_summary.following_declared = 0
                OR p_summary.following_collected * 100 >= p_summary.following_declared * 99,
            'exactCountMatch', p_summary.following_collected = p_summary.following_declared
        ),
        'detectedMutuals', p_summary.detected_mutuals,
        'publicMutuals', p_summary.public_mutuals,
        'privateMutuals', p_summary.private_mutuals,
        'screenedMutuals', p_summary.screened_mutuals,
        'genderStats', pg_catalog.jsonb_build_object(
            'male', p_summary.male_count,
            'female', p_summary.female_count,
            'unknown', p_summary.unknown_count
        ),
        'notScreenedMutuals', p_summary.not_screened_mutuals,
        'exclusionApplied', p_summary.exclusion_applied,
        'scorePolicyVersion', p_summary.score_policy_version
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_result_summary_json(
    public.analysis_v2_result_summaries
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_gender_resolution_metrics IS
    'Service-only aggregate quality and cost accounting; no usernames, email, image URL, or prompt.';
