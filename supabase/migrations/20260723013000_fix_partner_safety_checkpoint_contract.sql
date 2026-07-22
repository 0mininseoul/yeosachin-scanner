-- Partner-safety generation checkpoints store the validated model response, not the
-- application-computed PartnerSafetyResult envelope. Rebuild that envelope from the raw feature
-- and partner checkpoints, and require contact-sheet evidence to have its own fenced media bundle.

CREATE OR REPLACE FUNCTION public.analysis_v2_result_partner_safety_row_matches(
    p_request_id UUID,
    p_partner_job_key TEXT,
    p_value JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    v_feature public.analysis_v2_candidate_feature_rows%ROWTYPE;
    v_feature_ai public.analysis_v2_ai_result_checkpoints%ROWTYPE;
    v_partner_ai public.analysis_v2_ai_result_checkpoints%ROWTYPE;
    v_features JSONB;
    v_assessment JSONB;
    v_feature_evidence TEXT[] := '{}'::TEXT[];
    v_contact_evidence TEXT[] := '{}'::TEXT[];
    v_expected_evidence TEXT[] := '{}'::TEXT[];
    v_row_evidence TEXT[] := '{}'::TEXT[];
    v_feature_strong BOOLEAN;
    v_feature_weak BOOLEAN;
    v_contact_strong BOOLEAN := FALSE;
    v_contact_weak BOOLEAN := FALSE;
    v_expected_strong BOOLEAN;
    v_expected_weak_raw BOOLEAN;
    v_expected_weak BOOLEAN;
    v_expected_basis TEXT;
    v_source TEXT;
    v_expected_partner_bundle_id TEXT;
BEGIN
    IF p_request_id IS NULL
       OR p_partner_job_key IS NULL
       OR p_value IS NULL
       OR pg_catalog.jsonb_typeof(p_value) <> 'object'
       OR p_value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
       OR p_value->>'source' NOT IN (
            'not_collected', 'feature_only', 'gemini', 'safe_fallback'
       )
       OR pg_catalog.jsonb_typeof(p_value->'hasStrongPartnerEvidence') <> 'boolean'
       OR pg_catalog.jsonb_typeof(p_value->'hasWeakPartnerEvidence') <> 'boolean'
       OR p_value->>'strongEvidenceBasis' NOT IN (
            'none', 'feature', 'contact_sheet', 'both'
       )
       OR pg_catalog.jsonb_typeof(p_value->'evidenceSelectionIds') <> 'array'
       OR pg_catalog.jsonb_array_length(p_value->'evidenceSelectionIds') > 8 THEN
        RETURN FALSE;
    END IF;

    SELECT feature.*
    INTO v_feature
    FROM public.analysis_v2_candidate_feature_rows AS feature
    WHERE feature.request_id = p_request_id
      AND feature.candidate_id = p_value->>'candidateId'
      AND feature.terminal_classification = 'verified_female';
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    SELECT ai_result.*
    INTO v_feature_ai
    FROM public.analysis_v2_ai_result_checkpoints AS ai_result
    JOIN public.analysis_v2_candidate_feature_manifests AS manifest
      ON manifest.request_id = v_feature.request_id
     AND manifest.batch = v_feature.batch
     AND manifest.producer_job_key = ai_result.job_key
    WHERE ai_result.request_id = p_request_id
      AND ai_result.operation_key = v_feature.feature_operation_key
      AND ai_result.stage = 'featureAnalysis'
      AND ai_result.result_hash = v_feature.feature_result_hash;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- featureAnalysis checkpoints contain the raw validated model response.
    v_features := v_feature_ai.result_json;
    IF pg_catalog.jsonb_typeof(v_features) <> 'object'
       OR v_features->>'partnerExclusionContext' NOT IN (
            'none', 'celebrity_or_public_figure', 'older_relative', 'group_or_unclear'
       )
       OR v_features->>'marriageEvidence' NOT IN (
            'none', 'possible', 'strong', 'uncertain'
       )
       OR v_features->>'partnerEvidence' NOT IN (
            'none', 'weak', 'strong', 'uncertain'
       )
       OR pg_catalog.jsonb_typeof(v_features->'evidenceSelectionIds') <> 'object'
       OR pg_catalog.jsonb_typeof(
            v_features->'evidenceSelectionIds'->'marriagePartner'
          ) <> 'array'
       OR pg_catalog.jsonb_array_length(
            v_features->'evidenceSelectionIds'->'marriagePartner'
          ) > 10
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(
                v_features->'evidenceSelectionIds'->'marriagePartner'
            ) AS evidence(value)
            WHERE pg_catalog.jsonb_typeof(evidence.value) <> 'string'
               OR evidence.value #>> '{}' !~ '^[^[:cntrl:]]{1,240}$'
               OR NOT EXISTS (
                    SELECT 1
                    FROM pg_catalog.jsonb_array_elements_text(
                        v_feature.media_context->'selectionIds'
                    ) AS selected(value)
                    WHERE selected.value = evidence.value #>> '{}'
               )
       ) THEN
        RETURN FALSE;
    END IF;

    v_feature_strong := v_features->>'partnerExclusionContext' = 'none'
        AND (
            v_features->>'marriageEvidence' = 'strong'
            OR v_features->>'partnerEvidence' = 'strong'
        );
    v_feature_weak := v_features->>'partnerExclusionContext' = 'none'
        AND (
            v_features->>'marriageEvidence' = 'possible'
            OR v_features->>'partnerEvidence' = 'weak'
        );
    IF v_feature_strong OR v_feature_weak THEN
        SELECT COALESCE(
            pg_catalog.array_agg(evidence.value ORDER BY evidence.ordinality),
            '{}'::TEXT[]
        )
        INTO v_feature_evidence
        FROM pg_catalog.jsonb_array_elements_text(
            v_features->'evidenceSelectionIds'->'marriagePartner'
        ) WITH ORDINALITY AS evidence(value, ordinality);
    END IF;

    v_source := p_value->>'source';
    IF v_source = 'gemini' THEN
        SELECT ai_result.*
        INTO v_partner_ai
        FROM public.analysis_v2_ai_result_checkpoints AS ai_result
        WHERE ai_result.request_id = p_request_id
          AND ai_result.job_key = p_partner_job_key
          AND ai_result.operation_key = p_value->>'operationKey'
          AND ai_result.stage = 'partnerSafety'
          AND ai_result.result_hash = p_value->>'aiResultHash';
        IF NOT FOUND THEN
            RETURN FALSE;
        END IF;

        -- partnerSafety checkpoints likewise contain the raw assessment object.
        v_assessment := v_partner_ai.result_json;
        IF pg_catalog.jsonb_typeof(v_assessment) <> 'object'
           OR NOT (v_assessment ?& ARRAY[
                'companionPattern', 'partnerEvidence', 'exclusionContext',
                'confidence', 'evidenceSourceSelectionIds'
           ])
           OR v_assessment - ARRAY[
                'companionPattern', 'partnerEvidence', 'exclusionContext',
                'confidence', 'evidenceSourceSelectionIds'
           ] <> '{}'::JSONB
           OR v_assessment->>'companionPattern' NOT IN (
                'none', 'single_two_person', 'repeated_same_person',
                'explicit_couple_context', 'uncertain'
           )
           OR v_assessment->>'partnerEvidence' NOT IN (
                'none', 'weak', 'strong', 'uncertain'
           )
           OR v_assessment->>'exclusionContext' NOT IN (
                'none', 'celebrity_or_public_figure', 'older_relative', 'group_or_unclear'
           )
           OR v_assessment->>'confidence' NOT IN ('low', 'medium', 'high')
           OR pg_catalog.jsonb_typeof(
                v_assessment->'evidenceSourceSelectionIds'
              ) <> 'array'
           OR pg_catalog.jsonb_array_length(
                v_assessment->'evidenceSourceSelectionIds'
              ) > 8
           OR EXISTS (
                SELECT 1
                FROM pg_catalog.jsonb_array_elements(
                    v_assessment->'evidenceSourceSelectionIds'
                ) AS evidence(value)
                WHERE pg_catalog.jsonb_typeof(evidence.value) <> 'string'
                   OR evidence.value #>> '{}' !~ '^[^[:cntrl:]]{1,240}$'
           )
           OR (
                (
                    v_assessment->>'companionPattern' <> 'none'
                    OR v_assessment->>'partnerEvidence' <> 'none'
                    OR v_assessment->>'exclusionContext' <> 'none'
                )
                <> (
                    pg_catalog.jsonb_array_length(
                        v_assessment->'evidenceSourceSelectionIds'
                    ) > 0
                )
           )
           OR (
                v_assessment->>'exclusionContext' <> 'none'
                AND v_assessment->>'partnerEvidence' <> 'none'
           )
           OR (
                v_assessment->>'partnerEvidence' = 'strong'
                AND (
                    v_assessment->>'confidence' <> 'high'
                    OR v_assessment->>'companionPattern' NOT IN (
                        'repeated_same_person', 'explicit_couple_context'
                    )
                )
           )
           OR (
                v_assessment->>'partnerEvidence' = 'weak'
                AND v_assessment->>'companionPattern' NOT IN (
                    'single_two_person', 'repeated_same_person', 'explicit_couple_context'
                )
           ) THEN
            RETURN FALSE;
        END IF;

        v_expected_partner_bundle_id := 'bundle:' || pg_catalog.encode(
            extensions.digest(
                pg_catalog.convert_to(
                    'analysis-v2-partner-safety-bundle:v1' || pg_catalog.chr(10)
                        || (p_value->>'candidateId'),
                    'UTF8'
                ),
                'sha256'
            ),
            'hex'
        );
        IF p_value->>'bundleId' IS DISTINCT FROM v_expected_partner_bundle_id
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_media_artifacts AS artifact
                WHERE artifact.request_id = p_request_id
                  AND artifact.registration_job_key = p_partner_job_key
                  AND artifact.artifact_kind = 'media_bundle'
                  AND artifact.deleted_at IS NULL
                  AND artifact.artifact_key = pg_catalog.encode(
                      extensions.digest(
                          pg_catalog.convert_to(
                              'analysis-v2-media-bundle-key:v1' || pg_catalog.chr(10)
                                  || v_expected_partner_bundle_id,
                              'UTF8'
                          ),
                          'sha256'
                      ),
                      'hex'
                  )
           ) THEN
            RETURN FALSE;
        END IF;

        v_contact_strong := v_assessment->>'exclusionContext' = 'none'
            AND v_assessment->>'partnerEvidence' = 'strong';
        v_contact_weak := v_assessment->>'exclusionContext' = 'none'
            AND v_assessment->>'partnerEvidence' = 'weak';
        IF v_contact_strong OR v_contact_weak THEN
            SELECT COALESCE(
                pg_catalog.array_agg(evidence.value ORDER BY evidence.ordinality),
                '{}'::TEXT[]
            )
            INTO v_contact_evidence
            FROM pg_catalog.jsonb_array_elements_text(
                v_assessment->'evidenceSourceSelectionIds'
            ) WITH ORDINALITY AS evidence(value, ordinality);
        END IF;
    ELSIF v_source = 'safe_fallback' THEN
        v_expected_partner_bundle_id := 'bundle:' || pg_catalog.encode(
            extensions.digest(
                pg_catalog.convert_to(
                    'analysis-v2-partner-safety-bundle:v1' || pg_catalog.chr(10)
                        || (p_value->>'candidateId'),
                    'UTF8'
                ),
                'sha256'
            ),
            'hex'
        );
        IF p_value->>'bundleId' IS DISTINCT FROM v_expected_partner_bundle_id
           OR p_value->>'operationKey' !~ '^partner-safety:[a-f0-9]{64}$'
           OR p_value->'aiResultHash' <> 'null'::JSONB
           OR NOT public.analysis_v2_ai_fallback_evidence_matches(
                p_request_id,
                p_partner_job_key,
                p_value->>'operationKey',
                'partnerSafety'
           )
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_media_artifacts AS artifact
                WHERE artifact.request_id = p_request_id
                  AND artifact.registration_job_key = p_partner_job_key
                  AND artifact.artifact_kind = 'media_bundle'
                  AND artifact.deleted_at IS NULL
                  AND artifact.artifact_key = pg_catalog.encode(
                      extensions.digest(
                          pg_catalog.convert_to(
                              'analysis-v2-media-bundle-key:v1' || pg_catalog.chr(10)
                                  || v_expected_partner_bundle_id,
                              'UTF8'
                          ),
                          'sha256'
                      ),
                      'hex'
                  )
           ) THEN
            RETURN FALSE;
        END IF;
    ELSIF p_value->'bundleId' <> 'null'::JSONB
       OR p_value->'operationKey' <> 'null'::JSONB
       OR p_value->'aiResultHash' <> 'null'::JSONB THEN
        RETURN FALSE;
    END IF;

    v_expected_strong := v_feature_strong OR v_contact_strong;
    v_expected_weak_raw := v_feature_weak OR v_contact_weak;
    v_expected_weak := v_expected_weak_raw AND NOT v_expected_strong;
    v_expected_basis := CASE
        WHEN v_feature_strong AND v_contact_strong THEN 'both'
        WHEN v_feature_strong THEN 'feature'
        WHEN v_contact_strong THEN 'contact_sheet'
        ELSE 'none'
    END;

    SELECT COALESCE(
        pg_catalog.array_agg(canonical.value ORDER BY canonical.first_ordinal),
        '{}'::TEXT[]
    )
    INTO v_expected_evidence
    FROM (
        SELECT combined.value, MIN(combined.ordinality) AS first_ordinal
        FROM (
            SELECT evidence.value, evidence.ordinality::BIGINT AS ordinality
            FROM pg_catalog.unnest(v_feature_evidence)
                WITH ORDINALITY AS evidence(value, ordinality)
            UNION ALL
            SELECT evidence.value, 1000 + evidence.ordinality::BIGINT AS ordinality
            FROM pg_catalog.unnest(v_contact_evidence)
                WITH ORDINALITY AS evidence(value, ordinality)
        ) AS combined
        GROUP BY combined.value
        ORDER BY MIN(combined.ordinality)
        LIMIT 8
    ) AS canonical;
    SELECT COALESCE(
        pg_catalog.array_agg(evidence.value ORDER BY evidence.ordinality),
        '{}'::TEXT[]
    )
    INTO v_row_evidence
    FROM pg_catalog.jsonb_array_elements_text(p_value->'evidenceSelectionIds')
        WITH ORDINALITY AS evidence(value, ordinality);

    RETURN (p_value->>'hasStrongPartnerEvidence')::BOOLEAN
            IS NOT DISTINCT FROM v_expected_strong
       AND (p_value->>'hasWeakPartnerEvidence')::BOOLEAN
            IS NOT DISTINCT FROM v_expected_weak
       AND p_value->>'strongEvidenceBasis' IS NOT DISTINCT FROM v_expected_basis
       AND v_row_evidence IS NOT DISTINCT FROM v_expected_evidence
       AND public.analysis_v2_result_valid_ref_list(v_row_evidence, 8);
EXCEPTION
    WHEN data_exception THEN
        RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_result_partner_safety_row_matches(
    UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.analysis_v2_result_partner_safety_row_matches(UUID, TEXT, JSONB)
    IS 'Rebuilds partner-safety output from raw durable AI checkpoints and a fenced contact-sheet bundle.';
