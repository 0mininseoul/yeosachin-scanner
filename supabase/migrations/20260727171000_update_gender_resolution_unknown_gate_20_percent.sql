BEGIN;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_gender_resolution_quality(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_metrics public.analysis_v2_gender_resolution_metrics%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
    v_request_completed BOOLEAN;
    v_standard_plan BOOLEAN;
    v_result_archive_present BOOLEAN;
    v_request_passed BOOLEAN;
    v_unknown_evaluable BOOLEAN;
    v_unknown_passed BOOLEAN;
    v_provenance_passed BOOLEAN;
    v_immutability_passed BOOLEAN;
    v_purgeable_staging_sources_present BOOLEAN;
    v_metrics_finalized BOOLEAN;
    v_metrics_fresh BOOLEAN;
    v_all_resolver_attempts_terminal BOOLEAN;
    v_live_features RECORD;
    v_live_attempts RECORD;
    v_live_outcomes RECORD;
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_INVALID',
            ERRCODE = 'P0001';
    END IF;
    SELECT metrics.*
    INTO v_metrics
    FROM public.analysis_v2_gender_resolution_metrics AS metrics
    WHERE metrics.request_id = p_request_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_GENDER_RESOLUTION_QUALITY_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    v_purgeable_staging_sources_present := EXISTS (
        SELECT 1
        FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_candidate_feature_manifests AS manifest
        WHERE manifest.request_id = p_request_id
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_ai_scoring_stage_checkpoints AS checkpoint
        WHERE checkpoint.request_id = p_request_id
          AND checkpoint.stage_kind = 'profile_ai_batch'
    );

    SELECT
        pg_catalog.count(*)::INTEGER AS screened_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.gender_resolution_status
                NOT IN ('disabled', 'not_eligible')
        )::INTEGER AS resolver_eligible_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.baseline_classification
                NOT IN ('verified_female', 'verified_non_female')
        )::INTEGER AS baseline_unknown_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.terminal_classification
                NOT IN ('verified_female', 'verified_non_female')
        )::INTEGER AS final_unknown_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.gender_resolution_status IN (
                'ready_applied', 'ready_not_needed', 'ready_inconclusive'
            )
        )::INTEGER AS ready_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.gender_resolution_status = 'ready_applied'
        )::INTEGER AS applied_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.gender_resolution_status = 'ready_applied'
              AND feature.classification_source = 'gender_resolution'
              AND feature.gender_resolution_operation_key
                    ~ '^gender-resolution:[a-f0-9]{64}$'
              AND feature.gender_resolution_result_hash ~ '^[a-f0-9]{64}$'
        )::INTEGER AS applied_with_fenced_result_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.baseline_classification IN (
                    'verified_female', 'verified_non_female'
                )
              AND feature.terminal_classification
                    IS DISTINCT FROM feature.baseline_classification
        )::INTEGER AS verified_baseline_mutation_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.gender_resolution_status = 'ready_inconclusive'
        )::INTEGER AS inconclusive_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.gender_resolution_status = 'cutoff'
        )::INTEGER AS cutoff_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.gender_resolution_status = 'capacity_skipped'
        )::INTEGER AS capacity_skipped_count,
        pg_catalog.count(*) FILTER (
            WHERE feature.gender_resolution_status = 'terminal_unavailable'
        )::INTEGER AS terminal_unavailable_count
    INTO v_live_features
    FROM public.analysis_v2_candidate_feature_rows AS feature
    WHERE feature.request_id = p_request_id;

    SELECT
        pg_catalog.count(*)::INTEGER AS attempt_count,
        pg_catalog.count(*) FILTER (
            WHERE attempt.status = 'reserved'
        )::INTEGER AS nonterminal_count,
        pg_catalog.count(*) FILTER (
            WHERE attempt.usage_metadata_status = 'complete'
        )::INTEGER AS usage_complete_count,
        pg_catalog.count(*) FILTER (
            WHERE attempt.usage_metadata_status IS DISTINCT FROM 'complete'
        )::INTEGER AS usage_missing_count,
        COALESCE(pg_catalog.sum(attempt.prompt_tokens), 0)::BIGINT
            AS prompt_tokens,
        COALESCE(pg_catalog.sum(attempt.completion_tokens), 0)::BIGINT
            AS completion_tokens,
        COALESCE(pg_catalog.sum(attempt.total_tokens), 0)::BIGINT
            AS total_tokens,
        COALESCE(pg_catalog.sum(attempt.thinking_tokens), 0)::BIGINT
            AS thinking_tokens,
        pg_catalog.sum(attempt.estimated_cost_usd)::NUMERIC(18, 12)
            AS estimated_cost_usd,
        pg_catalog.count(attempt.estimated_cost_usd)::INTEGER
            AS cost_known_count
    INTO v_live_attempts
    FROM public.analysis_v2_ai_attempts AS attempt
    WHERE attempt.request_id = p_request_id
      AND attempt.stage = 'genderResolution';

    WITH outcomes AS (
        SELECT outcome.value
        FROM public.analysis_v2_ai_scoring_stage_checkpoints AS checkpoint
        CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
            checkpoint.payload->'outcomes'
        ) AS outcome(value)
        WHERE checkpoint.request_id = p_request_id
          AND checkpoint.stage_kind = 'profile_ai_batch'
    )
    SELECT
        pg_catalog.count(*)::INTEGER AS outcome_count,
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
    INTO v_live_outcomes
    FROM outcomes AS outcome;

    v_metrics_finalized := v_metrics.metrics_finalized_at IS NOT NULL;
    v_all_resolver_attempts_terminal := v_metrics_finalized
        AND v_metrics.resolver_nonterminal_attempt_count = 0
        AND v_live_attempts.nonterminal_count = 0;
    v_metrics_fresh := v_metrics_finalized AND (
        NOT v_purgeable_staging_sources_present
        OR (
            v_metrics.screened_count = v_live_features.screened_count
            AND v_metrics.screened_count = v_live_outcomes.outcome_count
            AND v_metrics.resolver_eligible_count =
                v_live_features.resolver_eligible_count
            AND v_metrics.baseline_unknown_count =
                v_live_features.baseline_unknown_count
            AND v_metrics.final_unknown_count =
                v_live_features.final_unknown_count
            AND v_metrics.ready_count = v_live_features.ready_count
            AND v_metrics.applied_count = v_live_features.applied_count
            AND v_metrics.applied_with_fenced_result_count =
                v_live_features.applied_with_fenced_result_count
            AND v_metrics.verified_baseline_mutation_count =
                v_live_features.verified_baseline_mutation_count
            AND v_metrics.inconclusive_count =
                v_live_features.inconclusive_count
            AND v_metrics.cutoff_count = v_live_features.cutoff_count
            AND v_metrics.capacity_skipped_count =
                v_live_features.capacity_skipped_count
            AND v_metrics.terminal_unavailable_count =
                v_live_features.terminal_unavailable_count
            AND v_metrics.partial_media_accepted_candidate_count =
                v_live_outcomes.partial_media_accepted_candidate_count
            AND v_metrics.selected_media_total =
                v_live_outcomes.selected_media_total
            AND v_metrics.normalized_media_total =
                v_live_outcomes.normalized_media_total
            AND v_metrics.failed_media_total =
                v_live_outcomes.selected_media_total
                    - v_live_outcomes.normalized_media_total
        )
    )
        AND v_metrics.resolver_attempt_count =
            v_live_attempts.attempt_count
        AND v_metrics.resolver_usage_complete_count =
            v_live_attempts.usage_complete_count
        AND v_metrics.resolver_usage_missing_count =
            v_live_attempts.usage_missing_count
        AND v_metrics.resolver_prompt_tokens =
            v_live_attempts.prompt_tokens
        AND v_metrics.resolver_completion_tokens =
            v_live_attempts.completion_tokens
        AND v_metrics.resolver_total_tokens =
            v_live_attempts.total_tokens
        AND v_metrics.resolver_thinking_tokens =
            v_live_attempts.thinking_tokens
        AND v_metrics.resolver_estimated_cost_usd
            IS NOT DISTINCT FROM v_live_attempts.estimated_cost_usd
        AND v_metrics.resolver_cost_known_count =
            v_live_attempts.cost_known_count
        AND v_metrics.resolver_nonterminal_attempt_count =
            v_live_attempts.nonterminal_count;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id;
    SELECT summary.*
    INTO v_summary
    FROM public.analysis_v2_result_summaries AS summary
    WHERE summary.request_id = p_request_id;
    v_request_completed := v_request.id IS NOT NULL
        AND v_request.pipeline_version = 'v2'
        AND v_request.status = 'completed';
    v_standard_plan := v_request.id IS NOT NULL
        AND v_request.selected_plan_id_snapshot = 'standard';
    v_result_archive_present := v_summary.request_id IS NOT NULL
        AND v_summary.plan_id = 'standard';
    v_request_passed := v_request_completed
        AND v_standard_plan
        AND v_result_archive_present;
    v_unknown_evaluable := v_metrics.screened_count > 0;
    v_unknown_passed := v_unknown_evaluable
        AND v_metrics.final_unknown_count * 10 <= v_metrics.screened_count * 2;
    v_provenance_passed :=
        v_metrics.applied_with_fenced_result_count = v_metrics.applied_count;
    v_immutability_passed := v_metrics.verified_baseline_mutation_count = 0;

    RETURN pg_catalog.jsonb_build_object(
        'screenedCount', v_metrics.screened_count,
        'resolverEligibleCount', v_metrics.resolver_eligible_count,
        'baselineUnknownCount', v_metrics.baseline_unknown_count,
        'finalUnknownCount', v_metrics.final_unknown_count,
        'finalUnknownRatio', CASE
            WHEN v_unknown_evaluable THEN
                v_metrics.final_unknown_count::NUMERIC
                    / v_metrics.screened_count::NUMERIC
            ELSE NULL
        END,
        'readyCount', v_metrics.ready_count,
        'appliedCount', v_metrics.applied_count,
        'appliedWithFencedResultCount',
            v_metrics.applied_with_fenced_result_count,
        'verifiedBaselineMutationCount',
            v_metrics.verified_baseline_mutation_count,
        'inconclusiveCount', v_metrics.inconclusive_count,
        'cutoffCount', v_metrics.cutoff_count,
        'capacitySkippedCount', v_metrics.capacity_skipped_count,
        'terminalUnavailableCount', v_metrics.terminal_unavailable_count,
        'partialMediaAcceptedCandidateCount',
            v_metrics.partial_media_accepted_candidate_count,
        'selectedMediaTotal', v_metrics.selected_media_total,
        'normalizedMediaTotal', v_metrics.normalized_media_total,
        'failedMediaTotal', v_metrics.failed_media_total,
        'resolverAttemptCount', v_metrics.resolver_attempt_count,
        'resolverUsageCompleteCount', v_metrics.resolver_usage_complete_count,
        'resolverUsageMissingCount', v_metrics.resolver_usage_missing_count,
        'resolverEstimatedCostUsd', v_metrics.resolver_estimated_cost_usd,
        'resolverCostKnownCount', v_metrics.resolver_cost_known_count,
        'resolverNonterminalAttemptCount',
            v_metrics.resolver_nonterminal_attempt_count,
        'resolverConcurrencyLimit', 2,
        'sharedConcurrencyLimit', 8,
        'allResolverAttemptsTerminal', v_all_resolver_attempts_terminal,
        'metricsFinalized', v_metrics_finalized,
        'metricsFresh', v_metrics_fresh,
        'requestCompleted', v_request_completed,
        'standardPlan', v_standard_plan,
        'resultArchivePresent', v_result_archive_present,
        'requestGatePassed', v_request_passed,
        'unknownGateEvaluable', v_unknown_evaluable,
        'unknownGatePassed', v_unknown_passed,
        'provenanceGatePassed', v_provenance_passed,
        'immutabilityGatePassed', v_immutability_passed,
        'qualityGatePassed', v_request_passed
            AND v_unknown_evaluable
            AND v_unknown_passed
            AND v_provenance_passed
            AND v_immutability_passed
            AND v_all_resolver_attempts_terminal
            AND v_metrics_fresh
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_gender_resolution_quality(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_gender_resolution_quality(UUID)
    TO service_role;

COMMIT;
