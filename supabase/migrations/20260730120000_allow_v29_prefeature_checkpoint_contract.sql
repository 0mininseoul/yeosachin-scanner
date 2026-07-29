-- v2.9/v2.10 may intentionally stop after durable gender triage when feature admission
-- rejects the account. Persist that narrow reason so a missing feature result remains
-- invalid for every other request and classification.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD COLUMN pre_feature_policy_version VARCHAR(32),
    ADD COLUMN pre_feature_admission VARCHAR(32);

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD CONSTRAINT analysis_v2_candidate_feature_pre_feature_admission_check CHECK (
        (
            pre_feature_policy_version IS NULL
            AND pre_feature_admission IS NULL
        )
        OR (
            pre_feature_policy_version IN (
                'ai-stage-policy-v2.9',
                'ai-stage-policy-v2.10'
            )
            AND pre_feature_admission IN (
                'nonpersonal_or_official',
                'unsupported_unknown'
            )
        )
    );

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD CONSTRAINT analysis_v2_candidate_feature_pre_feature_shape_check CHECK (
        pre_feature_policy_version IS NULL
        OR (
            terminal_classification = 'unresolved'
            AND feature_operation_key IS NULL
            AND feature_result_hash IS NULL
            AND pg_catalog.num_nonnulls(
                appearance_grade, exposure_score, is_business_account,
                feature_partner_evidence_strong, one_line_overview
            ) = 0
            AND baseline_classification = 'unresolved'
            AND classification_source = 'unknown'
            AND gender_resolution_status = 'not_eligible'
            AND gender_resolution_operation_key IS NULL
            AND gender_resolution_result_hash IS NULL
        )
    );

ALTER TABLE public.analysis_v2_candidate_feature_rows
    DROP CONSTRAINT analysis_v2_candidate_feature_classification_check;

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD CONSTRAINT analysis_v2_candidate_feature_classification_check CHECK (
        terminal_classification IN (
            'verified_female', 'verified_non_female', 'unresolved',
            'unresolved_stage_conflict', 'media_unavailable', 'unavailable'
        )
        AND (
            (
                terminal_classification IN ('unavailable', 'media_unavailable')
                AND media_context IS NULL
                AND pg_catalog.num_nonnulls(
                    appearance_grade, exposure_score, is_business_account,
                    feature_partner_evidence_strong, one_line_overview,
                    gender_operation_key, gender_result_hash,
                    feature_operation_key, feature_result_hash,
                    pre_feature_policy_version, pre_feature_admission
                ) = 0
            )
            OR (
                terminal_classification NOT IN ('unavailable', 'media_unavailable')
                AND media_context IS NOT NULL
                AND public.analysis_v2_result_valid_media_context(media_context)
                AND gender_operation_key ~ '^gender-triage:[a-f0-9]{64}$'
                AND gender_result_hash ~ '^[a-f0-9]{64}$'
                AND (
                    (
                        terminal_classification = 'verified_non_female'
                        AND (
                            (
                                feature_operation_key IS NULL
                                AND feature_result_hash IS NULL
                            )
                            OR (
                                feature_operation_key IS NOT NULL
                                AND feature_result_hash IS NOT NULL
                                AND
                                feature_operation_key ~ '^feature-analysis:[a-f0-9]{64}$'
                                AND feature_result_hash ~ '^[a-f0-9]{64}$'
                            )
                        )
                    )
                    OR (
                        terminal_classification IN (
                            'verified_female', 'unresolved', 'unresolved_stage_conflict'
                        )
                        AND (
                            (
                                feature_operation_key IS NOT NULL
                                AND feature_result_hash IS NOT NULL
                                AND
                                feature_operation_key ~ '^feature-analysis:[a-f0-9]{64}$'
                                AND feature_result_hash ~ '^[a-f0-9]{64}$'
                            )
                            OR (
                                terminal_classification = 'unresolved'
                                AND feature_operation_key IS NULL
                                AND feature_result_hash IS NULL
                                AND pre_feature_policy_version IN (
                                    'ai-stage-policy-v2.9',
                                    'ai-stage-policy-v2.10'
                                )
                                AND pre_feature_admission IN (
                                    'nonpersonal_or_official',
                                    'unsupported_unknown'
                                )
                            )
                        )
                    )
                )
            )
        )
        AND (
            (
                terminal_classification = 'verified_female'
                AND appearance_grade BETWEEN 1 AND 5
                AND exposure_score BETWEEN 0 AND 5
                AND is_business_account IS NOT NULL
                AND feature_partner_evidence_strong IS NOT NULL
                AND public.analysis_v2_result_valid_public_copy(one_line_overview, 180)
            )
            OR (
                terminal_classification <> 'verified_female'
                AND pg_catalog.num_nonnulls(
                    appearance_grade, exposure_score, is_business_account,
                    feature_partner_evidence_strong, one_line_overview
                ) = 0
            )
        )
    );

CREATE OR REPLACE FUNCTION public.analysis_v2_checkpoint_candidate_features_complete(
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
    v_rows JSONB;
    v_checkpoint JSONB;
    v_request_policy_version TEXT;
BEGIN
    IF p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT request.policy_versions_snapshot->>'aiStage'
    INTO v_request_policy_version
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
           OR (item.value ? 'preFeaturePolicyVersion')
                <> (item.value ? 'preFeatureAdmission')
           OR (
                item.value ? 'preFeaturePolicyVersion'
                AND (
                    pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion')
                        <> pg_catalog.jsonb_typeof(item.value->'preFeatureAdmission')
                    OR (
                        pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
                        AND (
                            item.value->>'preFeaturePolicyVersion' NOT IN (
                                'ai-stage-policy-v2.9',
                                'ai-stage-policy-v2.10'
                            )
                            OR item.value->>'preFeatureAdmission' NOT IN (
                                'nonpersonal_or_official',
                                'unsupported_unknown'
                            )
                            OR item.value->>'preFeaturePolicyVersion'
                                IS DISTINCT FROM v_request_policy_version
                            OR item.value->>'classification' <> 'unresolved'
                            OR item.value->'featureOperationKey' <> 'null'::JSONB
                            OR item.value->'featureResultHash' <> 'null'::JSONB
                            OR item.value->'feature' <> 'null'::JSONB
                            OR NOT public.analysis_v2_result_valid_media_context(
                                item.value->'mediaContext'
                            )
                            OR item.value->>'genderOperationKey'
                                !~ '^gender-triage:[a-f0-9]{64}$'
                            OR item.value->>'genderResultHash' !~ '^[a-f0-9]{64}$'
                            OR item.value->>'baselineClassification' <> 'unresolved'
                            OR item.value->>'classificationSource' <> 'unknown'
                            OR item.value->>'genderResolutionStatus' <> 'not_eligible'
                            OR item.value->'genderResolutionOperationKey'
                                <> 'null'::JSONB
                            OR item.value->'genderResolutionResultHash'
                                <> 'null'::JSONB
                        )
                    )
                    OR pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion')
                        NOT IN ('string', 'null')
                )
            )
           OR (
                pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion')
                    IS DISTINCT FROM 'string'
                AND item.value->>'classification' IN (
                    'verified_female', 'unresolved', 'unresolved_stage_conflict'
                )
                AND (
                    (item.value->>'featureOperationKey'
                        ~ '^feature-analysis:[a-f0-9]{64}$') IS DISTINCT FROM TRUE
                    OR (item.value->>'featureResultHash' ~ '^[a-f0-9]{64}$')
                        IS DISTINCT FROM TRUE
                )
            )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM public.analysis_v2_assert_result_job_fence(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_job_input_hash
    );

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        WHERE pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
          AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_ai_result_checkpoints AS result
                WHERE result.request_id = p_request_id
                  AND result.job_key = p_job_key
                  AND result.operation_key = item.value->>'genderOperationKey'
                  AND result.stage = 'genderTriage'
                  AND result.result_hash = item.value->>'genderResultHash'
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_v2_candidate_feature_manifests AS manifest
    WHERE manifest.request_id = p_request_id
      AND manifest.batch = p_batch
    FOR UPDATE;

    IF FOUND THEN
        PERFORM 1
        FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
          AND feature.batch = p_batch
        FOR UPDATE;

        IF EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            LEFT JOIN public.analysis_v2_candidate_feature_rows AS feature
              ON feature.request_id = p_request_id
             AND feature.batch = p_batch
             AND feature.candidate_id = item.value->>'candidateId'
            WHERE pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
              AND (
                    feature.candidate_id IS NULL
                    OR feature.terminal_classification IS DISTINCT FROM 'unresolved'
                    OR feature.media_context IS DISTINCT FROM item.value->'mediaContext'
                    OR feature.gender_operation_key
                        IS DISTINCT FROM item.value->>'genderOperationKey'
                    OR feature.gender_result_hash
                        IS DISTINCT FROM item.value->>'genderResultHash'
                    OR feature.baseline_classification IS DISTINCT FROM 'unresolved'
                    OR feature.classification_source IS DISTINCT FROM 'unknown'
                    OR feature.gender_resolution_status IS DISTINCT FROM 'not_eligible'
                    OR feature.gender_resolution_operation_key IS NOT NULL
                    OR feature.gender_resolution_result_hash IS NOT NULL
                    OR feature.pre_feature_policy_version
                        IS DISTINCT FROM item.value->>'preFeaturePolicyVersion'
                    OR feature.pre_feature_admission
                        IS DISTINCT FROM item.value->>'preFeatureAdmission'
              )
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT pg_catalog.jsonb_agg(
        CASE
            WHEN pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
                THEN (
                    item.value - ARRAY[
                        'baselineClassification',
                        'classificationSource',
                        'genderResolutionStatus',
                        'genderResolutionOperationKey',
                        'genderResolutionResultHash',
                        'preFeaturePolicyVersion',
                        'preFeatureAdmission'
                    ]::TEXT[]
                ) || pg_catalog.jsonb_build_object(
                    'classification', 'media_unavailable',
                    'mediaContext', NULL,
                    'genderOperationKey', NULL,
                    'genderResultHash', NULL,
                    'featureOperationKey', NULL,
                    'featureResultHash', NULL,
                    'feature', NULL
                )
            ELSE item.value - ARRAY[
                'baselineClassification',
                'classificationSource',
                'genderResolutionStatus',
                'genderResolutionOperationKey',
                'genderResolutionResultHash',
                'preFeaturePolicyVersion',
                'preFeatureAdmission'
            ]::TEXT[]
        END
        ORDER BY item.value->>'candidateId'
    )
    INTO v_rows
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);

    v_checkpoint := public.analysis_v2_checkpoint_candidate_features_complete_v26(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_job_input_hash,
        p_batch,
        p_analyzed_count,
        v_rows
    );

    UPDATE public.analysis_v2_candidate_feature_rows AS feature
    SET terminal_classification = CASE
            WHEN pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
                THEN 'unresolved'
            ELSE feature.terminal_classification
        END,
        media_context = CASE
            WHEN pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
                THEN item.value->'mediaContext'
            ELSE feature.media_context
        END,
        gender_operation_key = CASE
            WHEN pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
                THEN item.value->>'genderOperationKey'
            ELSE feature.gender_operation_key
        END,
        gender_result_hash = CASE
            WHEN pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
                THEN item.value->>'genderResultHash'
            ELSE feature.gender_result_hash
        END,
        baseline_classification = COALESCE(
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
        ),
        pre_feature_policy_version = CASE
            WHEN pg_catalog.jsonb_typeof(item.value->'preFeaturePolicyVersion') = 'string'
                THEN item.value->>'preFeaturePolicyVersion'
            ELSE NULL
        END,
        pre_feature_admission = CASE
            WHEN pg_catalog.jsonb_typeof(item.value->'preFeatureAdmission') = 'string'
                THEN item.value->>'preFeatureAdmission'
            ELSE NULL
        END
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
