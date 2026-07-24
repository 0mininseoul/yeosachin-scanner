-- Expose bounded, PII-free finalizer readiness so a retrying paid analysis can be
-- diagnosed before terminal failure purges its short-lived working set.

CREATE OR REPLACE FUNCTION public.load_analysis_v2_finalizer_readiness(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payload JSONB;
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_OBSERVABILITY_INVALID',
            ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.pipeline_version = 'v2'
    ) THEN
        RETURN NULL;
    END IF;

    WITH request_row AS (
        SELECT analysis_request.*
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
    ),
    preflight AS (
        SELECT analysis_preflight.*
        FROM public.analysis_preflights AS analysis_preflight
        WHERE analysis_preflight.consumed_request_id = p_request_id
    ),
    relationship AS (
        SELECT manifest.*
        FROM public.analysis_v2_relationship_manifests AS manifest
        WHERE manifest.request_id = p_request_id
          AND manifest.job_key = 'track:relationships:collect'
    ),
    followers AS (
        SELECT side.*
        FROM public.analysis_v2_relationship_sides AS side
        WHERE side.request_id = p_request_id
          AND side.job_key = 'track:relationships:collect'
          AND side.side = 'followers'
    ),
    following AS (
        SELECT side.*
        FROM public.analysis_v2_relationship_sides AS side
        WHERE side.request_id = p_request_id
          AND side.job_key = 'track:relationships:collect'
          AND side.side = 'following'
    ),
    counts AS (
        SELECT
            (
                SELECT pg_catalog.count(*)::INTEGER
                FROM public.analysis_v2_dag_stage_manifests AS stage
                WHERE stage.request_id = p_request_id
            ) AS stage_count,
            (
                SELECT COALESCE(pg_catalog.sum(topology.item_count), 0)::INTEGER
                FROM public.analysis_v2_dag_batch_topology AS topology
                WHERE topology.request_id = p_request_id
                  AND topology.topology_kind = 'profile'
            ) AS profile_topology_count,
            (
                SELECT COALESCE(pg_catalog.sum(topology.item_count), 0)::INTEGER
                FROM public.analysis_v2_dag_batch_topology AS topology
                WHERE topology.request_id = p_request_id
                  AND topology.topology_kind = 'private_name'
            ) AS private_topology_count,
            (
                SELECT pg_catalog.count(*)::INTEGER
                FROM public.analysis_v2_candidate_feature_rows AS feature
                WHERE feature.request_id = p_request_id
            ) AS feature_count,
            (
                SELECT pg_catalog.count(*)::INTEGER
                FROM public.analysis_v2_private_name_rows AS private_name
                WHERE private_name.request_id = p_request_id
            ) AS private_count,
            (
                SELECT pg_catalog.count(*)::INTEGER
                FROM public.analysis_v2_candidate_feature_rows AS feature
                WHERE feature.request_id = p_request_id
                  AND feature.terminal_classification = 'verified_female'
            ) AS verified_count,
            (
                SELECT pg_catalog.count(*)::INTEGER
                FROM public.analysis_v2_preliminary_score_rows AS preliminary
                WHERE preliminary.request_id = p_request_id
                  AND preliminary.verification_shortlist_rank IS NOT NULL
            ) AS shortlist_count
    ),
    checks AS (
        SELECT
            NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_provider_cleanup_intents AS intent
                WHERE intent.request_id = p_request_id
                  AND intent.completed_at IS NULL
            ) AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_provider_runs AS provider_run
                WHERE provider_run.request_id = p_request_id
                  AND provider_run.status IN ('starting', 'running')
            ) AS providerCleanupReady,
            EXISTS (
                SELECT 1
                FROM request_row
                JOIN preflight ON TRUE
                JOIN relationship ON TRUE
                JOIN followers ON TRUE
                JOIN following ON TRUE
                WHERE preflight.target_followers_count = followers.declared_count
                  AND preflight.target_following_count = following.declared_count
                  AND followers.collected_count * 100
                        >= followers.declared_count * 99
                  AND following.collected_count * 100
                        >= following.declared_count * 99
                  AND relationship.followers_result_hash = followers.result_hash
                  AND relationship.following_result_hash = following.result_hash
                  AND relationship.excluded_username
                        IS NOT DISTINCT FROM request_row.excluded_instagram_id
                  AND relationship.detailed_mutual_limit = (
                        request_row.analysis_scope_snapshot->>'detailedMutualLimit'
                  )::INTEGER
                  AND relationship.detailed_public_count = LEAST(
                        relationship.public_count,
                        relationship.detailed_mutual_limit
                  )
                  AND EXISTS (
                        SELECT 1
                        FROM public.analysis_v2_dag_scopes AS scope
                        WHERE scope.request_id = p_request_id
                          AND scope.plan_id =
                                request_row.selected_plan_id_snapshot
                          AND scope.excluded_count = CASE
                                WHEN request_row.exclusion_decision_snapshot = 'exclude'
                                THEN 1 ELSE 0
                          END
                          AND scope.exclusion_decision_hash =
                                relationship.exclusion_decision_hash
                  )
                  AND EXISTS (
                        SELECT 1
                        FROM public.analysis_v2_dag_stage_manifests AS stage
                        WHERE stage.request_id = p_request_id
                          AND stage.stage_kind = 'relationships'
                          AND stage.result_hash = relationship.result_hash
                          AND stage.detected_mutual_count =
                                relationship.mutual_count
                          AND stage.public_count = relationship.public_count
                          AND stage.private_count = relationship.private_count
                          AND stage.detailed_selected_public_count =
                                relationship.detailed_public_count
                  )
            ) AS relationshipEnvelopeReady,
            EXISTS (
                SELECT 1
                FROM public.analysis_v2_target_evidence_manifests AS evidence
                JOIN public.analysis_v2_dag_stage_manifests AS stage
                  ON stage.request_id = evidence.request_id
                 AND stage.stage_kind = 'target_evidence'
                 AND stage.result_hash = evidence.result_hash
                 AND stage.interactor_count = evidence.interactor_count
                CROSS JOIN request_row
                WHERE evidence.request_id = p_request_id
                  AND evidence.job_key = 'track:target-evidence:collect'
                  AND evidence.target_username =
                        pg_catalog.lower(request_row.target_instagram_id)
                  AND evidence.excluded_username IS NOT DISTINCT FROM
                        request_row.excluded_instagram_id
            ) AS targetEvidenceReady,
            counts.stage_count = 8 AS stageCountReady,
            counts.profile_topology_count = COALESCE(
                (SELECT relationship.detailed_public_count FROM relationship),
                -1
            )
                AND counts.profile_topology_count = counts.feature_count
                AS profileCountsReady,
            counts.private_topology_count = COALESCE(
                (SELECT relationship.private_count FROM relationship),
                -1
            )
                AND counts.private_topology_count = counts.private_count
                AS privateCountsReady,
            NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_dag_batch_topology AS topology
                LEFT JOIN public.analysis_v2_dag_batch_results AS fetch_result
                  ON fetch_result.request_id = topology.request_id
                 AND fetch_result.result_kind = 'profile_fetch'
                 AND fetch_result.batch = topology.batch
                 AND fetch_result.item_count = topology.item_count
                LEFT JOIN public.analysis_v2_dag_batch_results AS ai_result
                  ON ai_result.request_id = topology.request_id
                 AND ai_result.result_kind = 'profile_ai'
                 AND ai_result.batch = topology.batch
                 AND ai_result.item_count = topology.item_count
                LEFT JOIN public.analysis_v2_candidate_feature_manifests
                    AS feature_manifest
                  ON feature_manifest.request_id = topology.request_id
                 AND feature_manifest.batch = topology.batch
                 AND feature_manifest.item_count = topology.item_count
                 AND feature_manifest.row_count = topology.item_count
                 AND feature_manifest.producer_input_hash =
                        ai_result.producer_input_hash
                LEFT JOIN public.analysis_v2_ai_scoring_stage_checkpoints
                    AS rich_stage
                  ON rich_stage.request_id = topology.request_id
                 AND rich_stage.stage_kind = 'profile_ai_batch'
                 AND rich_stage.batch_key = topology.batch
                 AND rich_stage.producer_input_hash =
                        ai_result.producer_input_hash
                 AND rich_stage.result_hash = ai_result.result_hash
                 AND rich_stage.item_count = topology.item_count
                WHERE topology.request_id = p_request_id
                  AND topology.topology_kind = 'profile'
                  AND (
                        fetch_result.request_id IS NULL
                        OR ai_result.request_id IS NULL
                        OR feature_manifest.request_id IS NULL
                        OR rich_stage.request_id IS NULL
                  )
            ) AS profileBatchesReady,
            NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_dag_batch_topology AS topology
                LEFT JOIN public.analysis_v2_dag_batch_results AS private_result
                  ON private_result.request_id = topology.request_id
                 AND private_result.result_kind = 'private_name'
                 AND private_result.batch = topology.batch
                 AND private_result.item_count = topology.item_count
                LEFT JOIN public.analysis_v2_private_name_manifests
                    AS private_manifest
                  ON private_manifest.request_id = topology.request_id
                 AND private_manifest.batch = topology.batch
                 AND private_manifest.item_count = topology.item_count
                 AND private_manifest.producer_input_hash =
                        private_result.producer_input_hash
                 AND private_manifest.result_hash = private_result.result_hash
                WHERE topology.request_id = p_request_id
                  AND topology.topology_kind = 'private_name'
                  AND (
                        private_result.request_id IS NULL
                        OR private_manifest.request_id IS NULL
                  )
            ) AS privateBatchesReady,
            NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_candidate_feature_rows AS feature
                CROSS JOIN request_row
                WHERE feature.request_id = p_request_id
                  AND (
                    feature.candidate_id <>
                        public.analysis_v2_result_candidate_id(
                            feature.instagram_id
                        )
                    OR feature.instagram_id =
                        pg_catalog.lower(request_row.target_instagram_id)
                    OR feature.instagram_id =
                        request_row.excluded_instagram_id
                    OR NOT EXISTS (
                        SELECT 1
                        FROM public.analysis_v2_mutual_rows AS mutual
                        WHERE mutual.request_id = p_request_id
                          AND mutual.job_key = 'track:relationships:collect'
                          AND mutual.username = feature.instagram_id
                          AND NOT mutual.is_private
                          AND mutual.detailed_ordinal IS NOT NULL
                    )
                    OR NOT EXISTS (
                        SELECT 1
                        FROM public.analysis_v2_profile_fetch_batches
                            AS profile_batch
                        JOIN public.analysis_v2_profile_fetch_outcomes AS outcome
                          ON outcome.request_id = profile_batch.request_id
                         AND outcome.job_key = profile_batch.job_key
                         AND outcome.username = feature.instagram_id
                         AND outcome.attempt =
                            public.analysis_v2_profile_terminal_attempt(
                                profile_batch.request_id,
                                profile_batch.job_key,
                                feature.instagram_id,
                                profile_batch.frozen_unresolved_usernames
                            )
                        WHERE profile_batch.request_id = p_request_id
                          AND profile_batch.job_key =
                                'track:profiles:batch:' || feature.batch::TEXT
                          AND (
                            (
                                feature.terminal_classification = 'unavailable'
                                AND feature.unavailable_reason = 'profile_fetch'
                                AND outcome.status <> 'success'
                            )
                            OR (
                                feature.terminal_classification = 'unavailable'
                                AND feature.unavailable_reason = 'ai_response'
                                AND outcome.status = 'success'
                                AND EXISTS (
                                    SELECT 1
                                    FROM public.analysis_v2_ai_scoring_stage_checkpoints
                                        AS rich_stage
                                    CROSS JOIN LATERAL
                                        pg_catalog.jsonb_array_elements(
                                            rich_stage.payload->'outcomes'
                                        ) AS rich_outcome(value)
                                    WHERE rich_stage.request_id = p_request_id
                                      AND rich_stage.stage_kind =
                                            'profile_ai_batch'
                                      AND rich_stage.batch_key = feature.batch
                                      AND rich_outcome.value->>'candidateId' =
                                            feature.candidate_id
                                      AND rich_outcome.value->>'instagramId' =
                                            feature.instagram_id
                                      AND rich_outcome.value->>'status' =
                                            'analysis_unavailable'
                                )
                            )
                            OR (
                                feature.terminal_classification =
                                    'media_unavailable'
                                AND outcome.status = 'success'
                            )
                            OR (
                                feature.terminal_classification NOT IN (
                                    'unavailable', 'media_unavailable'
                                )
                                AND outcome.status = 'success'
                            )
                          )
                    )
                  )
            ) AS featureRowsReady,
            NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_private_name_rows AS private_name
                CROSS JOIN request_row
                WHERE private_name.request_id = p_request_id
                  AND (
                    private_name.candidate_id <>
                        public.analysis_v2_result_candidate_id(
                            private_name.instagram_id
                        )
                    OR private_name.instagram_id =
                        pg_catalog.lower(request_row.target_instagram_id)
                    OR private_name.instagram_id =
                        request_row.excluded_instagram_id
                    OR NOT EXISTS (
                        SELECT 1
                        FROM public.analysis_v2_mutual_rows AS mutual
                        WHERE mutual.request_id = p_request_id
                          AND mutual.job_key = 'track:relationships:collect'
                          AND mutual.username = private_name.instagram_id
                          AND mutual.is_private
                    )
                  )
            ) AS privateRowsReady,
            EXISTS (
                SELECT 1
                FROM public.analysis_v2_dag_stage_manifests AS primary_join
                JOIN public.analysis_v2_ai_scoring_stage_checkpoints
                    AS primary_rich
                  ON primary_rich.request_id = primary_join.request_id
                 AND primary_rich.stage_kind = 'primary_join'
                 AND primary_rich.batch_key = -1
                 AND primary_rich.producer_input_hash =
                        primary_join.producer_input_hash
                 AND primary_rich.result_hash = primary_join.result_hash
                JOIN public.analysis_v2_dag_stage_manifests AS screening
                  ON screening.request_id = primary_join.request_id
                 AND screening.stage_kind = 'screening'
                JOIN public.analysis_v2_ai_scoring_stage_checkpoints
                    AS screening_rich
                  ON screening_rich.request_id = screening.request_id
                 AND screening_rich.stage_kind = 'screening'
                 AND screening_rich.batch_key = -1
                 AND screening_rich.producer_input_hash =
                        screening.producer_input_hash
                 AND screening_rich.result_hash = screening.result_hash
                JOIN public.analysis_v2_preliminary_score_manifests
                    AS preliminary
                  ON preliminary.request_id = primary_join.request_id
                 AND preliminary.producer_input_hash =
                        screening.producer_input_hash
                CROSS JOIN counts
                WHERE primary_join.request_id = p_request_id
                  AND primary_join.stage_kind = 'primary_join'
                  AND primary_join.verified_female_count =
                        counts.verified_count
                  AND screening.verified_female_count =
                        counts.verified_count
                  AND preliminary.item_count = counts.verified_count
                  AND screening.shortlist_count = counts.shortlist_count
            ) AS primaryScreeningReady,
            EXISTS (
                SELECT 1
                FROM public.analysis_v2_dag_stage_manifests AS stage
                JOIN public.analysis_v2_ai_scoring_stage_checkpoints
                    AS rich_stage
                  ON rich_stage.request_id = stage.request_id
                 AND rich_stage.stage_kind = 'reverse_likes'
                 AND rich_stage.batch_key = -1
                 AND rich_stage.producer_input_hash =
                        stage.producer_input_hash
                 AND rich_stage.result_hash = stage.result_hash
                JOIN public.analysis_v2_reverse_like_manifests AS manifest
                  ON manifest.request_id = stage.request_id
                 AND manifest.producer_input_hash =
                        stage.producer_input_hash
                CROSS JOIN counts
                WHERE stage.request_id = p_request_id
                  AND stage.stage_kind = 'reverse_likes'
                  AND stage.shortlist_count = counts.shortlist_count
            ) AS reverseLikesReady,
            EXISTS (
                SELECT 1
                FROM public.analysis_v2_dag_stage_manifests AS stage
                JOIN public.analysis_v2_ai_scoring_stage_checkpoints
                    AS rich_stage
                  ON rich_stage.request_id = stage.request_id
                 AND rich_stage.stage_kind = 'partner_safety'
                 AND rich_stage.batch_key = -1
                 AND rich_stage.producer_input_hash =
                        stage.producer_input_hash
                 AND rich_stage.result_hash = stage.result_hash
                JOIN public.analysis_v2_partner_safety_manifests AS manifest
                  ON manifest.request_id = stage.request_id
                 AND manifest.producer_input_hash =
                        stage.producer_input_hash
                CROSS JOIN counts
                WHERE stage.request_id = p_request_id
                  AND stage.stage_kind = 'partner_safety'
                  AND stage.shortlist_count = counts.shortlist_count
            ) AS partnerSafetyReady,
            EXISTS (
                SELECT 1
                FROM public.analysis_v2_dag_stage_manifests AS final_stage
                JOIN public.analysis_v2_ai_scoring_stage_checkpoints
                    AS final_rich
                  ON final_rich.request_id = final_stage.request_id
                 AND final_rich.stage_kind = 'final_score'
                 AND final_rich.batch_key = -1
                 AND final_rich.producer_input_hash =
                        final_stage.producer_input_hash
                 AND final_rich.result_hash = final_stage.result_hash
                JOIN public.analysis_v2_candidate_score_manifests
                    AS score_manifest
                  ON score_manifest.request_id = final_stage.request_id
                 AND score_manifest.producer_input_hash =
                        final_stage.producer_input_hash
                JOIN public.analysis_v2_dag_stage_manifests AS narrative_stage
                  ON narrative_stage.request_id = final_stage.request_id
                 AND narrative_stage.stage_kind = 'narrative'
                JOIN public.analysis_v2_ai_scoring_stage_checkpoints
                    AS narrative_rich
                  ON narrative_rich.request_id = narrative_stage.request_id
                 AND narrative_rich.stage_kind = 'narrative'
                 AND narrative_rich.batch_key = -1
                 AND narrative_rich.producer_input_hash =
                        narrative_stage.producer_input_hash
                 AND narrative_rich.result_hash = narrative_stage.result_hash
                JOIN public.analysis_v2_narrative_manifests
                    AS narrative_manifest
                  ON narrative_manifest.request_id = final_stage.request_id
                 AND narrative_manifest.producer_input_hash =
                        narrative_stage.producer_input_hash
                CROSS JOIN counts
                WHERE final_stage.request_id = p_request_id
                  AND final_stage.stage_kind = 'final_score'
                  AND score_manifest.item_count = counts.verified_count
                  AND final_stage.featured_high_risk_count =
                        narrative_manifest.item_count
                  AND final_stage.narrative_count =
                        narrative_manifest.item_count
                  AND narrative_stage.narrative_count =
                        narrative_manifest.item_count
            ) AS finalNarrativeReady,
            EXISTS (
                SELECT 1
                FROM public.analysis_progress_state AS progress_state
                WHERE progress_state.request_id = p_request_id
                  AND progress_state.status IN ('queued', 'processing')
            ) AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_progress_events AS progress_event
                WHERE progress_event.request_id = p_request_id
                  AND progress_event.event_code = 'ANALYSIS_COMPLETED'
            ) AS progressReady,
            counts.feature_count = COALESCE(
                (SELECT relationship.detailed_public_count FROM relationship),
                -1
            ) AS genderCountsReady,
            counts.*
        FROM counts
    ),
    readiness AS (
        SELECT
            checks.*,
            checks.providerCleanupReady
                AND checks.relationshipEnvelopeReady
                AND checks.targetEvidenceReady
                AND checks.stageCountReady
                AND checks.profileCountsReady
                AND checks.privateCountsReady
                AND checks.profileBatchesReady
                AND checks.privateBatchesReady
                AND checks.featureRowsReady
                AND checks.privateRowsReady
                AND checks.primaryScreeningReady
                AND checks.reverseLikesReady
                AND checks.partnerSafetyReady
                AND checks.finalNarrativeReady
                AND checks.progressReady
                AND checks.genderCountsReady AS ready
        FROM checks
    )
    SELECT pg_catalog.jsonb_build_object(
        'ready', readiness.ready,
        'providerCleanupReady', readiness.providerCleanupReady,
        'relationshipEnvelopeReady', readiness.relationshipEnvelopeReady,
        'targetEvidenceReady', readiness.targetEvidenceReady,
        'stageCountReady', readiness.stageCountReady,
        'profileCountsReady', readiness.profileCountsReady,
        'privateCountsReady', readiness.privateCountsReady,
        'profileBatchesReady', readiness.profileBatchesReady,
        'privateBatchesReady', readiness.privateBatchesReady,
        'featureRowsReady', readiness.featureRowsReady,
        'privateRowsReady', readiness.privateRowsReady,
        'primaryScreeningReady', readiness.primaryScreeningReady,
        'reverseLikesReady', readiness.reverseLikesReady,
        'partnerSafetyReady', readiness.partnerSafetyReady,
        'finalNarrativeReady', readiness.finalNarrativeReady,
        'progressReady', readiness.progressReady,
        'genderCountsReady', readiness.genderCountsReady,
        'stageCount', readiness.stage_count,
        'profileTopologyCount', readiness.profile_topology_count,
        'featureCount', readiness.feature_count,
        'privateTopologyCount', readiness.private_topology_count,
        'privateCount', readiness.private_count,
        'verifiedCount', readiness.verified_count,
        'shortlistCount', readiness.shortlist_count
    )
    INTO v_payload
    FROM readiness;

    RETURN v_payload;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_finalizer_readiness(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_finalizer_readiness(UUID)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_finalizer_readiness(UUID) IS
    'Returns only PII-free finalizer gate booleans and bounded aggregate counts to service_role.';
