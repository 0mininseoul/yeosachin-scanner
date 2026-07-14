-- Fix JSONB operator precedence in complete candidate-feature checkpoint validation.
-- Arithmetic subtraction binds more tightly than the JSON extraction operator, so the
-- extracted feature object must be parenthesized before removing its allowed keys.

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
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_rows JSONB;
    v_result_hash TEXT;
    v_existing RECORD;
BEGIN
    IF p_batch IS NULL OR p_batch NOT BETWEEN 0 AND 100000
       OR p_analyzed_count IS NULL OR p_analyzed_count NOT BETWEEN 1 AND 30
       OR p_rows IS NULL OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) <> p_analyzed_count
       OR pg_catalog.octet_length(p_rows::TEXT) > 4194304
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'instagramId', 'fullName', 'profileImageUrl', 'bio',
                    'classification', 'mediaContext', 'genderOperationKey',
                    'genderResultHash', 'featureOperationKey', 'featureResultHash', 'feature'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'instagramId', 'fullName', 'profileImageUrl', 'bio',
                    'classification', 'mediaContext', 'genderOperationKey',
                    'genderResultHash', 'featureOperationKey', 'featureResultHash', 'feature'
               ]::TEXT[] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item.value->>'instagramId' !~ '^[a-z0-9._]{1,30}$'
               OR item.value->>'classification' NOT IN (
                    'verified_female', 'verified_non_female', 'unresolved',
                    'unresolved_stage_conflict', 'media_unavailable', 'unavailable'
               )
               OR pg_catalog.jsonb_typeof(item.value->'fullName') NOT IN ('string', 'null')
               OR pg_catalog.jsonb_typeof(item.value->'profileImageUrl') NOT IN ('string', 'null')
               OR pg_catalog.jsonb_typeof(item.value->'bio') NOT IN ('string', 'null')
               OR (
                    item.value->'profileImageUrl' <> 'null'::JSONB
                    AND NOT public.analysis_v2_result_valid_image_path(
                        item.value->>'profileImageUrl'
                    )
               )
               OR (
                    item.value->>'classification' IN ('unavailable', 'media_unavailable')
                    AND (
                        item.value->'mediaContext' <> 'null'::JSONB
                        OR item.value->'genderOperationKey' <> 'null'::JSONB
                        OR item.value->'genderResultHash' <> 'null'::JSONB
                        OR item.value->'featureOperationKey' <> 'null'::JSONB
                        OR item.value->'featureResultHash' <> 'null'::JSONB
                        OR item.value->'feature' <> 'null'::JSONB
                    )
               )
               OR (
                    item.value->>'classification' NOT IN ('unavailable', 'media_unavailable')
                    AND (
                        NOT public.analysis_v2_result_valid_media_context(item.value->'mediaContext')
                        OR item.value->>'genderOperationKey'
                            !~ '^gender-triage:[a-f0-9]{64}$'
                        OR item.value->>'genderResultHash' !~ '^[a-f0-9]{64}$'
                    )
               )
               OR (
                    item.value->>'classification' IN (
                        'verified_female', 'unresolved', 'unresolved_stage_conflict'
                    )
                    AND (
                        item.value->>'featureOperationKey'
                            !~ '^feature-analysis:[a-f0-9]{64}$'
                        OR item.value->>'featureResultHash' !~ '^[a-f0-9]{64}$'
                    )
               )
               OR (
                    item.value->>'classification' = 'verified_female'
                    AND (
                        pg_catalog.jsonb_typeof(item.value->'feature') <> 'object'
                        OR NOT (item.value->'feature' ?& ARRAY[
                            'appearanceGrade', 'exposureScore', 'isBusinessAccount',
                            'featurePartnerEvidenceStrong', 'oneLineOverview'
                        ])
                        OR (item.value->'feature') - ARRAY[
                            'appearanceGrade', 'exposureScore', 'isBusinessAccount',
                            'featurePartnerEvidenceStrong', 'oneLineOverview'
                        ]::TEXT[] <> '{}'::JSONB
                        OR item.value->'feature'->>'appearanceGrade' !~ '^[1-5]$'
                        OR item.value->'feature'->>'exposureScore' !~ '^[0-5]$'
                        OR pg_catalog.jsonb_typeof(
                            item.value->'feature'->'isBusinessAccount'
                        ) <> 'boolean'
                        OR pg_catalog.jsonb_typeof(
                            item.value->'feature'->'featurePartnerEvidenceStrong'
                        ) <> 'boolean'
                        OR NOT public.analysis_v2_result_valid_public_copy(
                            item.value->'feature'->>'oneLineOverview', 180
                        )
                    )
               )
               OR (
                    item.value->>'classification' <> 'verified_female'
                    AND item.value->'feature' <> 'null'::JSONB
               )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    v_job := public.analysis_v2_assert_result_job_fence(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_job.job_key <> 'track:profile-ai:batch:' || p_batch::TEXT
       OR v_job.track <> 'profile_ai' OR v_job.kind <> 'ai'
       OR v_job.batch IS DISTINCT FROM p_batch THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.* INTO STRICT v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id;

    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_batch_topology AS topology
        WHERE topology.request_id = p_request_id
          AND topology.topology_kind = 'profile'
          AND topology.batch = p_batch
          AND topology.item_count = p_analyzed_count
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_batch_results AS batch_result
        WHERE batch_result.request_id = p_request_id
          AND batch_result.result_kind = 'profile_fetch'
          AND batch_result.batch = p_batch
          AND batch_result.item_count = p_analyzed_count
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(item.value ORDER BY item.value->>'candidateId')
    INTO v_rows
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);
    IF (
        SELECT pg_catalog.count(DISTINCT item.value->>'candidateId') <> p_analyzed_count
            OR pg_catalog.count(DISTINCT item.value->>'instagramId') <> p_analyzed_count
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value)
        WHERE item.value->>'instagramId' = pg_catalog.lower(v_request.target_instagram_id)
           OR item.value->>'instagramId' = v_request.excluded_instagram_id
           OR NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_mutual_rows AS mutual
                WHERE mutual.request_id = p_request_id
                  AND mutual.job_key = 'track:relationships:collect'
                  AND mutual.username = item.value->>'instagramId'
                  AND NOT mutual.is_private
                  AND mutual.detailed_ordinal IS NOT NULL
           )
           OR (
                item.value->>'classification' NOT IN ('unavailable', 'media_unavailable')
                AND (
                    NOT EXISTS (
                        SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                        WHERE ai_result.request_id = p_request_id
                          AND ai_result.job_key = p_job_key
                          AND ai_result.operation_key = item.value->>'genderOperationKey'
                          AND ai_result.stage = 'genderTriage'
                          AND ai_result.result_hash = item.value->>'genderResultHash'
                    )
                    OR (
                        item.value->'featureOperationKey' <> 'null'::JSONB
                        AND NOT EXISTS (
                            SELECT 1 FROM public.analysis_v2_ai_result_checkpoints AS ai_result
                            WHERE ai_result.request_id = p_request_id
                              AND ai_result.job_key = p_job_key
                              AND ai_result.operation_key = item.value->>'featureOperationKey'
                              AND ai_result.stage = 'featureAnalysis'
                              AND ai_result.result_hash = item.value->>'featureResultHash'
                        )
                    )
                    OR NOT EXISTS (
                        SELECT 1 FROM public.analysis_v2_media_artifacts AS artifact
                        WHERE artifact.request_id = p_request_id
                          AND artifact.artifact_kind = 'media_bundle'
                          AND artifact.artifact_key = pg_catalog.encode(
                              extensions.digest(
                                  pg_catalog.convert_to(
                                      'analysis-v2-media-bundle-key:v1' || pg_catalog.chr(10)
                                          || item.value->'mediaContext'->>'bundleId',
                                      'UTF8'
                                  ),
                                  'sha256'
                              ),
                              'hex'
                          )
                    )
                )
           )
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_result_hash := public.analysis_v2_result_staging_hash(
        'profile_classifications', p_batch, v_rows
    );
    SELECT manifest.* INTO v_existing
    FROM public.analysis_v2_candidate_feature_manifests AS manifest
    WHERE manifest.request_id = p_request_id AND manifest.batch = p_batch
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.producer_job_key <> p_job_key
           OR v_existing.producer_input_hash <> p_job_input_hash
           OR v_existing.producer_claim_token <> p_claim_token
           OR v_existing.item_count <> p_analyzed_count
           OR v_existing.row_count <> p_analyzed_count
           OR v_existing.result_hash <> v_result_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_result_checkpoint_json(
            p_request_id, p_job_key, p_batch, p_analyzed_count,
            p_analyzed_count, v_result_hash
        );
    END IF;

    INSERT INTO public.analysis_v2_candidate_feature_manifests (
        request_id, batch, producer_job_key, producer_input_hash,
        producer_claim_token, item_count, row_count, result_hash
    ) VALUES (
        p_request_id, p_batch, p_job_key, p_job_input_hash,
        p_claim_token, p_analyzed_count, p_analyzed_count, v_result_hash
    );
    INSERT INTO public.analysis_v2_candidate_feature_rows (
        request_id, batch, candidate_id, instagram_id, full_name, profile_image_url, bio,
        terminal_classification, media_context, appearance_grade, exposure_score,
        is_business_account, feature_partner_evidence_strong, one_line_overview,
        gender_operation_key, gender_result_hash, feature_operation_key, feature_result_hash
    )
    SELECT
        p_request_id,
        p_batch,
        item.value->>'candidateId',
        item.value->>'instagramId',
        NULLIF(item.value->>'fullName', ''),
        NULLIF(item.value->>'profileImageUrl', ''),
        NULLIF(item.value->>'bio', ''),
        item.value->>'classification',
        CASE WHEN item.value->'mediaContext' = 'null'::JSONB
            THEN NULL ELSE item.value->'mediaContext' END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE (item.value->'feature'->>'appearanceGrade')::SMALLINT END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE (item.value->'feature'->>'exposureScore')::SMALLINT END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE (item.value->'feature'->>'isBusinessAccount')::BOOLEAN END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE (item.value->'feature'->>'featurePartnerEvidenceStrong')::BOOLEAN END,
        CASE WHEN item.value->'feature' = 'null'::JSONB
            THEN NULL ELSE item.value->'feature'->>'oneLineOverview' END,
        NULLIF(item.value->>'genderOperationKey', ''),
        NULLIF(item.value->>'genderResultHash', ''),
        NULLIF(item.value->>'featureOperationKey', ''),
        NULLIF(item.value->>'featureResultHash', '')
    FROM pg_catalog.jsonb_array_elements(v_rows) AS item(value);

    RETURN public.analysis_v2_result_checkpoint_json(
        p_request_id, p_job_key, p_batch, p_analyzed_count,
        p_analyzed_count, v_result_hash
    );
END;
$$;
