-- Migration B: read the durable "repair" profile-fetch attempt.
-- Migration A (20260720130000) made a third attempt writable. This migration makes every
-- reader see it: the telemetry source domain now admits it, and the three terminal-attempt
-- readers resolve it through one canonical selector instead of three copy-pasted CASEs.
-- Without this, a username that failed at 'fallback' but succeeded at 'repair' still
-- resolves to its failed fallback row, and the finalizer readiness gate wedges the request
-- on ANALYSIS_V2_RESULT_NOT_READY forever.

-- 1. Telemetry must accept the third attempt or the repair outcome INSERT aborts the whole
--    repair checkpoint transaction on the source CHECK. The new predicate is a strict
--    superset of the current one, so every existing row satisfies it.
--    Note this table is PERMANENT ("request/job profile outcome counters", 20260714033000:83-84)
--    and is not purged at terminalization the way the per-request staging tables are, so
--    ADD CONSTRAINT seq-scans the whole history under ACCESS EXCLUSIVE. That is the right
--    trade at the current row count (low hundreds: one row per distinct
--    request/job/source/status/failure_category/http_status). If this table ever grows large,
--    split this into ADD CONSTRAINT ... NOT VALID followed by a separate VALIDATE CONSTRAINT,
--    which does the same scan under the weaker SHARE UPDATE EXCLUSIVE lock.
ALTER TABLE public.analysis_v2_profile_fetch_telemetry
    DROP CONSTRAINT analysis_v2_profile_fetch_telemetry_source_check;
ALTER TABLE public.analysis_v2_profile_fetch_telemetry
    ADD CONSTRAINT analysis_v2_profile_fetch_telemetry_source_check CHECK (
        source IN ('cache', 'selfhosted', 'fallback', 'repair')
    );

-- Verbatim copy of 20260714033000:86-157 with the v_source CASE widened by one branch.
-- The trigger binding is untouched: CREATE OR REPLACE keeps it pointed at this function.
CREATE OR REPLACE FUNCTION public.capture_analysis_v2_profile_fetch_telemetry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source TEXT := CASE
        WHEN NEW.attempt = 'fallback' THEN 'fallback'
        WHEN NEW.attempt = 'repair' THEN 'repair'
        ELSE NEW.source
    END;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    INSERT INTO public.analysis_v2_profile_fetch_telemetry (
        request_id,
        job_key,
        source,
        status,
        failure_category,
        http_status,
        outcome_count,
        request_count_total,
        latency_ms_total,
        latency_ms_max,
        first_captured_at,
        last_captured_at,
        created_at,
        updated_at
    ) VALUES (
        NEW.request_id,
        NEW.job_key,
        v_source,
        NEW.status,
        NEW.failure_category,
        NEW.http_status,
        1,
        NEW.request_count,
        NEW.latency_ms,
        NEW.latency_ms,
        NEW.captured_at,
        NEW.captured_at,
        v_now,
        v_now
    )
    ON CONFLICT (
        request_id, job_key, source, status, failure_category_key, http_status_key
    ) DO UPDATE
    SET outcome_count = public.analysis_v2_profile_fetch_telemetry.outcome_count + 1,
        request_count_total =
            public.analysis_v2_profile_fetch_telemetry.request_count_total
            + EXCLUDED.request_count_total,
        latency_ms_total = public.analysis_v2_profile_fetch_telemetry.latency_ms_total
            + EXCLUDED.latency_ms_total,
        latency_ms_max = GREATEST(
            public.analysis_v2_profile_fetch_telemetry.latency_ms_max,
            EXCLUDED.latency_ms_max
        ),
        first_captured_at = LEAST(
            public.analysis_v2_profile_fetch_telemetry.first_captured_at,
            EXCLUDED.first_captured_at
        ),
        last_captured_at = GREATEST(
            public.analysis_v2_profile_fetch_telemetry.last_captured_at,
            EXCLUDED.last_captured_at
        ),
        updated_at = v_now;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_analysis_v2_profile_fetch_telemetry()
    FROM PUBLIC, anon, authenticated, service_role;

-- 2. One canonical terminal-attempt selector, replacing the copy-pasted CASE expressions.
--    A recorded repair outcome always wins; otherwise the frozen set still decides.
--    Called only from other SECURITY DEFINER functions, so nothing is granted EXECUTE.
CREATE OR REPLACE FUNCTION public.analysis_v2_profile_terminal_attempt(
    p_request_id UUID,
    p_job_key TEXT,
    p_username TEXT,
    p_frozen TEXT[]
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = p_request_id
              AND outcome.job_key = p_job_key
              AND outcome.attempt = 'repair'
              AND outcome.username = p_username
        ) THEN 'repair'
        WHEN p_username = ANY(p_frozen) THEN 'fallback'
        ELSE 'primary'
    END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_terminal_attempt(
    UUID, TEXT, TEXT, TEXT[]
) FROM PUBLIC, anon, authenticated, service_role;

-- 3a. Verbatim copy of 20260716162523:5-45 with only the attempt CASE swapped.
CREATE OR REPLACE FUNCTION public.analysis_v2_set_feature_unavailable_reason()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_fetch_status TEXT;
BEGIN
    IF NEW.terminal_classification <> 'unavailable' THEN
        NEW.unavailable_reason := NULL;
        RETURN NEW;
    END IF;

    SELECT outcome.status INTO v_fetch_status
    FROM public.analysis_v2_profile_fetch_batches AS profile_batch
    JOIN public.analysis_v2_profile_fetch_outcomes AS outcome
      ON outcome.request_id = profile_batch.request_id
     AND outcome.job_key = profile_batch.job_key
     AND outcome.username = NEW.instagram_id
     AND outcome.attempt = public.analysis_v2_profile_terminal_attempt(
            profile_batch.request_id,
            profile_batch.job_key,
            NEW.instagram_id,
            profile_batch.frozen_unresolved_usernames
     )
    WHERE profile_batch.request_id = NEW.request_id
      AND profile_batch.job_key = 'track:profiles:batch:' || NEW.batch::TEXT;

    IF v_fetch_status IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    NEW.unavailable_reason := CASE
        WHEN v_fetch_status = 'success' THEN 'ai_response'
        ELSE 'profile_fetch'
    END;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_set_feature_unavailable_reason()
    FROM PUBLIC, anon, authenticated, service_role;

-- 3b. Verbatim copy of 20260716162523:232-385 with only the two attempt CASEs swapped.
CREATE OR REPLACE FUNCTION public.complete_analysis_v2_result_and_purge(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_profile_image_url TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_analysis_unavailable_count INTEGER := 0;
    v_result JSONB;
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
BEGIN
    IF pg_catalog.to_regclass(
        'public.analysis_v2_ai_scoring_stage_checkpoints'
    ) IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.status IN ('starting', 'running')
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
          AND feature.terminal_classification = 'unavailable'
          AND NOT (
            (
                feature.unavailable_reason = 'profile_fetch'
                AND EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_profile_fetch_batches AS profile_batch
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
                      AND profile_batch.job_key = 'track:profiles:batch:'
                            || feature.batch::TEXT
                      AND outcome.status <> 'success'
                )
            )
            OR (
                feature.unavailable_reason = 'ai_response'
                AND EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_profile_fetch_batches AS profile_batch
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
                      AND profile_batch.job_key = 'track:profiles:batch:'
                            || feature.batch::TEXT
                      AND outcome.status = 'success'
                )
                AND EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_ai_scoring_stage_checkpoints AS rich_stage
                    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
                        rich_stage.payload->'outcomes'
                    ) AS rich_outcome(value)
                    WHERE rich_stage.request_id = p_request_id
                      AND rich_stage.stage_kind = 'profile_ai_batch'
                      AND rich_stage.batch_key = feature.batch
                      AND rich_outcome.value->>'candidateId' = feature.candidate_id
                      AND rich_outcome.value->>'instagramId' = feature.instagram_id
                      AND rich_outcome.value->>'status' = 'analysis_unavailable'
                )
            )
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER INTO v_analysis_unavailable_count
    FROM public.analysis_v2_candidate_feature_rows AS feature
    WHERE feature.request_id = p_request_id
      AND feature.terminal_classification = 'unavailable'
      AND feature.unavailable_reason = 'ai_response';

    UPDATE public.analysis_v2_candidate_feature_rows AS feature
    SET terminal_classification = 'media_unavailable',
        unavailable_reason = NULL
    WHERE feature.request_id = p_request_id
      AND feature.terminal_classification = 'unavailable'
      AND feature.unavailable_reason = 'ai_response';

    v_result := public.analysis_v2_complete_result_and_purge_internal(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash,
        p_target_profile_image_url
    );

    IF v_analysis_unavailable_count > 0 THEN
        UPDATE public.analysis_v2_result_summaries AS summary
        SET media_unavailable_count = summary.media_unavailable_count
                - v_analysis_unavailable_count,
            analysis_unavailable_count = v_analysis_unavailable_count
        WHERE summary.request_id = p_request_id
        RETURNING summary.* INTO v_summary;
        IF v_summary.request_id IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
        END IF;
        v_result := pg_catalog.jsonb_set(
            v_result,
            ARRAY['summary'],
            public.analysis_v2_result_summary_json(v_summary),
            TRUE
        );
    END IF;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_result_and_purge(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;

-- 3c. Verbatim copy of 20260713185711:2651-3197 (the authoritative body, renamed by
--     20260713213000:230) with only the one attempt CASE swapped. CREATE OR REPLACE
--     preserves the existing REVOKE, so nothing is re-granted here.
CREATE OR REPLACE FUNCTION public.analysis_v2_complete_result_and_purge_internal(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_target_profile_image_url TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
    v_relationship public.analysis_v2_relationship_manifests%ROWTYPE;
    v_followers public.analysis_v2_relationship_sides%ROWTYPE;
    v_following public.analysis_v2_relationship_sides%ROWTYPE;
    v_progress public.analysis_progress_state%ROWTYPE;
    v_tracks JSONB;
    v_revision BIGINT;
    v_sequence BIGINT;
    v_fingerprint TEXT;
    v_event_key TEXT;
    v_profile_count INTEGER;
    v_private_count INTEGER;
    v_verified_count INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS DISTINCT FROM 'coordinator:finalize'
       OR p_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR NOT public.analysis_v2_result_valid_image_path(p_target_profile_image_url) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.to_regclass(
        'public.analysis_v2_ai_scoring_stage_checkpoints'
    ) IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF v_preflight.id IS NULL OR v_request.id IS NULL OR v_job.request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF v_request.status = 'completed' THEN
        SELECT summary.* INTO v_summary
        FROM public.analysis_v2_result_summaries AS summary
        WHERE summary.request_id = p_request_id;
        IF v_job.status <> 'completed'
           OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
           OR v_job.completion_token IS DISTINCT FROM p_claim_token
           OR v_summary.request_id IS NULL
           OR v_summary.finalizer_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_summary.target_profile_image_url IS DISTINCT FROM p_target_profile_image_url THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'finalized', FALSE,
            'requestStatus', 'completed',
            'summary', public.analysis_v2_result_summary_json(v_summary)
        );
    END IF;
    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.track <> 'coordinator' OR v_job.kind <> 'finalizer'
       OR v_job.batch IS NOT NULL OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.cardinality(v_job.required_job_keys) < 1
       OR EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS sibling
            WHERE sibling.request_id = p_request_id
              AND sibling.job_key <> p_job_key AND sibling.status <> 'completed'
       ) OR EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(v_job.required_job_keys) AS required_key(value)
            LEFT JOIN public.analysis_pipeline_jobs AS required_job
              ON required_job.request_id = p_request_id
             AND required_job.job_key = required_key.value
            WHERE required_job.request_id IS NULL OR required_job.status <> 'completed'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT relationship_manifest.* INTO v_relationship
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = 'track:relationships:collect';
    SELECT side.* INTO v_followers
    FROM public.analysis_v2_relationship_sides AS side
    WHERE side.request_id = p_request_id
      AND side.job_key = 'track:relationships:collect' AND side.side = 'followers';
    SELECT side.* INTO v_following
    FROM public.analysis_v2_relationship_sides AS side
    WHERE side.request_id = p_request_id
      AND side.job_key = 'track:relationships:collect' AND side.side = 'following';

    IF v_relationship.request_id IS NULL OR v_followers.request_id IS NULL
       OR v_following.request_id IS NULL
       OR v_preflight.target_followers_count IS DISTINCT FROM v_followers.declared_count
       OR v_preflight.target_following_count IS DISTINCT FROM v_following.declared_count
       OR v_followers.collected_count * 100 < v_followers.declared_count * 99
       OR v_following.collected_count * 100 < v_following.declared_count * 99
       OR v_relationship.followers_result_hash <> v_followers.result_hash
       OR v_relationship.following_result_hash <> v_following.result_hash
       OR v_relationship.excluded_username IS DISTINCT FROM v_request.excluded_instagram_id
       OR v_relationship.detailed_mutual_limit IS DISTINCT FROM
            (v_request.analysis_scope_snapshot->>'detailedMutualLimit')::INTEGER
       OR v_relationship.detailed_public_count <> LEAST(
            v_relationship.public_count, v_relationship.detailed_mutual_limit
       ) OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard', 'plus')
       OR v_request.policy_versions_snapshot->>'risk' <> 'risk-policy-v2.2'
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_v2_dag_scopes AS scope
            WHERE scope.request_id = p_request_id
              AND scope.plan_id = v_request.selected_plan_id_snapshot
              AND scope.excluded_count = CASE
                    WHEN v_request.exclusion_decision_snapshot = 'exclude' THEN 1 ELSE 0 END
              AND scope.exclusion_decision_hash = v_relationship.exclusion_decision_hash
       ) OR (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = p_request_id
       ) <> 8
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = p_request_id AND stage.stage_kind = 'relationships'
              AND stage.result_hash = v_relationship.result_hash
              AND stage.detected_mutual_count = v_relationship.mutual_count
              AND stage.public_count = v_relationship.public_count
              AND stage.private_count = v_relationship.private_count
              AND stage.detailed_selected_public_count = v_relationship.detailed_public_count
       ) OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_target_evidence_manifests AS evidence
            JOIN public.analysis_v2_dag_stage_manifests AS stage
              ON stage.request_id = evidence.request_id
             AND stage.stage_kind = 'target_evidence'
             AND stage.result_hash = evidence.result_hash
             AND stage.interactor_count = evidence.interactor_count
            WHERE evidence.request_id = p_request_id
              AND evidence.job_key = 'track:target-evidence:collect'
              AND evidence.target_username = pg_catalog.lower(v_request.target_instagram_id)
              AND evidence.excluded_username IS NOT DISTINCT FROM v_request.excluded_instagram_id
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(pg_catalog.sum(topology.item_count), 0)::INTEGER INTO v_profile_count
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id AND topology.topology_kind = 'profile';
    SELECT COALESCE(pg_catalog.sum(topology.item_count), 0)::INTEGER INTO v_private_count
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id AND topology.topology_kind = 'private_name';
    SELECT pg_catalog.count(*)::INTEGER INTO v_verified_count
    FROM public.analysis_v2_candidate_feature_rows AS feature
    WHERE feature.request_id = p_request_id
      AND feature.terminal_classification = 'verified_female';

    IF v_profile_count <> v_relationship.detailed_public_count
       OR v_private_count <> v_relationship.private_count
       OR v_profile_count <> (
            SELECT pg_catalog.count(*) FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
       ) OR v_private_count <> (
            SELECT pg_catalog.count(*) FROM public.analysis_v2_private_name_rows AS private_name
            WHERE private_name.request_id = p_request_id
       ) OR EXISTS (
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
            LEFT JOIN public.analysis_v2_candidate_feature_manifests AS feature_manifest
              ON feature_manifest.request_id = topology.request_id
             AND feature_manifest.batch = topology.batch
             AND feature_manifest.item_count = topology.item_count
             AND feature_manifest.row_count = topology.item_count
             AND feature_manifest.producer_input_hash = ai_result.producer_input_hash
            LEFT JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS rich_stage
              ON rich_stage.request_id = topology.request_id
             AND rich_stage.stage_kind = 'profile_ai_batch'
             AND rich_stage.batch_key = topology.batch
             AND rich_stage.producer_input_hash = ai_result.producer_input_hash
             AND rich_stage.result_hash = ai_result.result_hash
             AND rich_stage.item_count = topology.item_count
            WHERE topology.request_id = p_request_id
              AND topology.topology_kind = 'profile'
              AND (fetch_result.request_id IS NULL OR ai_result.request_id IS NULL
                OR feature_manifest.request_id IS NULL OR rich_stage.request_id IS NULL)
       ) OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_dag_batch_topology AS topology
            LEFT JOIN public.analysis_v2_dag_batch_results AS private_result
              ON private_result.request_id = topology.request_id
             AND private_result.result_kind = 'private_name'
             AND private_result.batch = topology.batch
             AND private_result.item_count = topology.item_count
            LEFT JOIN public.analysis_v2_private_name_manifests AS private_manifest
              ON private_manifest.request_id = topology.request_id
             AND private_manifest.batch = topology.batch
             AND private_manifest.item_count = topology.item_count
             AND private_manifest.producer_input_hash = private_result.producer_input_hash
             AND private_manifest.result_hash = private_result.result_hash
            WHERE topology.request_id = p_request_id
              AND topology.topology_kind = 'private_name'
              AND (private_result.request_id IS NULL OR private_manifest.request_id IS NULL)
       ) OR EXISTS (
            SELECT 1 FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
              AND (
                feature.candidate_id <> public.analysis_v2_result_candidate_id(feature.instagram_id)
                OR feature.instagram_id = pg_catalog.lower(v_request.target_instagram_id)
                OR feature.instagram_id = v_request.excluded_instagram_id
                OR NOT EXISTS (
                    SELECT 1 FROM public.analysis_v2_mutual_rows AS mutual
                    WHERE mutual.request_id = p_request_id
                      AND mutual.job_key = 'track:relationships:collect'
                      AND mutual.username = feature.instagram_id
                      AND NOT mutual.is_private AND mutual.detailed_ordinal IS NOT NULL
                )
                OR NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_profile_fetch_batches AS profile_batch
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
                      AND profile_batch.job_key = 'track:profiles:batch:'
                            || feature.batch::TEXT
                      AND (
                        (
                            feature.terminal_classification = 'unavailable'
                            AND outcome.status <> 'success'
                        )
                        OR (
                            feature.terminal_classification = 'media_unavailable'
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
       ) OR EXISTS (
            SELECT 1 FROM public.analysis_v2_private_name_rows AS private_name
            WHERE private_name.request_id = p_request_id
              AND (
                private_name.candidate_id <>
                    public.analysis_v2_result_candidate_id(private_name.instagram_id)
                OR private_name.instagram_id = pg_catalog.lower(v_request.target_instagram_id)
                OR private_name.instagram_id = v_request.excluded_instagram_id
                OR NOT EXISTS (
                    SELECT 1 FROM public.analysis_v2_mutual_rows AS mutual
                    WHERE mutual.request_id = p_request_id
                      AND mutual.job_key = 'track:relationships:collect'
                      AND mutual.username = private_name.instagram_id AND mutual.is_private
                )
              )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS primary_join
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS primary_rich
          ON primary_rich.request_id = primary_join.request_id
         AND primary_rich.stage_kind = 'primary_join' AND primary_rich.batch_key = -1
         AND primary_rich.producer_input_hash = primary_join.producer_input_hash
         AND primary_rich.result_hash = primary_join.result_hash
        JOIN public.analysis_v2_dag_stage_manifests AS screening
          ON screening.request_id = primary_join.request_id
         AND screening.stage_kind = 'screening'
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS screening_rich
          ON screening_rich.request_id = screening.request_id
         AND screening_rich.stage_kind = 'screening' AND screening_rich.batch_key = -1
         AND screening_rich.producer_input_hash = screening.producer_input_hash
         AND screening_rich.result_hash = screening.result_hash
        JOIN public.analysis_v2_preliminary_score_manifests AS preliminary
          ON preliminary.request_id = primary_join.request_id
         AND preliminary.producer_input_hash = screening.producer_input_hash
         AND preliminary.item_count = screening.verified_female_count
        WHERE primary_join.request_id = p_request_id
          AND primary_join.stage_kind = 'primary_join'
          AND primary_join.verified_female_count = v_verified_count
          AND screening.verified_female_count = v_verified_count
          AND screening.shortlist_count = (
                SELECT pg_catalog.count(*)
                FROM public.analysis_v2_preliminary_score_rows AS score
                WHERE score.request_id = p_request_id
                  AND score.verification_shortlist_rank IS NOT NULL
          )
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS rich_stage
          ON rich_stage.request_id = stage.request_id
         AND rich_stage.stage_kind = 'reverse_likes' AND rich_stage.batch_key = -1
         AND rich_stage.producer_input_hash = stage.producer_input_hash
         AND rich_stage.result_hash = stage.result_hash
        JOIN public.analysis_v2_reverse_like_manifests AS manifest
          ON manifest.request_id = stage.request_id
         AND manifest.producer_input_hash = stage.producer_input_hash
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'reverse_likes'
          AND stage.shortlist_count = (
                SELECT pg_catalog.count(*)
                FROM public.analysis_v2_preliminary_score_rows AS preliminary
                WHERE preliminary.request_id = p_request_id
                  AND preliminary.verification_shortlist_rank IS NOT NULL
          )
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS rich_stage
          ON rich_stage.request_id = stage.request_id
         AND rich_stage.stage_kind = 'partner_safety' AND rich_stage.batch_key = -1
         AND rich_stage.producer_input_hash = stage.producer_input_hash
         AND rich_stage.result_hash = stage.result_hash
        JOIN public.analysis_v2_partner_safety_manifests AS manifest
          ON manifest.request_id = stage.request_id
         AND manifest.producer_input_hash = stage.producer_input_hash
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'partner_safety'
          AND stage.shortlist_count = (
                SELECT pg_catalog.count(*)
                FROM public.analysis_v2_preliminary_score_rows AS preliminary
                WHERE preliminary.request_id = p_request_id
                  AND preliminary.verification_shortlist_rank IS NOT NULL
          )
    ) OR NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS final_stage
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS final_rich
          ON final_rich.request_id = final_stage.request_id
         AND final_rich.stage_kind = 'final_score' AND final_rich.batch_key = -1
         AND final_rich.producer_input_hash = final_stage.producer_input_hash
         AND final_rich.result_hash = final_stage.result_hash
        JOIN public.analysis_v2_candidate_score_manifests AS score_manifest
          ON score_manifest.request_id = final_stage.request_id
         AND score_manifest.producer_input_hash = final_stage.producer_input_hash
        JOIN public.analysis_v2_dag_stage_manifests AS narrative_stage
          ON narrative_stage.request_id = final_stage.request_id
         AND narrative_stage.stage_kind = 'narrative'
        JOIN public.analysis_v2_ai_scoring_stage_checkpoints AS narrative_rich
          ON narrative_rich.request_id = narrative_stage.request_id
         AND narrative_rich.stage_kind = 'narrative' AND narrative_rich.batch_key = -1
         AND narrative_rich.producer_input_hash = narrative_stage.producer_input_hash
         AND narrative_rich.result_hash = narrative_stage.result_hash
        JOIN public.analysis_v2_narrative_manifests AS narrative_manifest
          ON narrative_manifest.request_id = final_stage.request_id
         AND narrative_manifest.producer_input_hash = narrative_stage.producer_input_hash
        WHERE final_stage.request_id = p_request_id
          AND final_stage.stage_kind = 'final_score'
          AND score_manifest.item_count = v_verified_count
          AND final_stage.featured_high_risk_count = narrative_manifest.item_count
          AND final_stage.narrative_count = narrative_manifest.item_count
          AND narrative_stage.narrative_count = narrative_manifest.item_count
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT progress_state.* INTO v_progress
    FROM public.analysis_progress_state AS progress_state
    WHERE progress_state.request_id = p_request_id FOR UPDATE;
    IF v_progress.request_id IS NULL
       OR v_progress.status NOT IN ('queued', 'processing')
       OR EXISTS (
            SELECT 1 FROM public.analysis_progress_events AS progress_event
            WHERE progress_event.request_id = p_request_id
              AND progress_event.event_code = 'ANALYSIS_COMPLETED'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_result_summaries (
        request_id, target_instagram_id, target_profile_image_url, plan_id,
        followers_declared, followers_collected, following_declared, following_collected,
        detected_mutuals, public_mutuals, private_mutuals, screened_mutuals,
        not_screened_mutuals, fetch_unavailable_count, media_unavailable_count,
        exclusion_applied, score_policy_version,
        finalizer_input_hash
    ) VALUES (
        p_request_id, pg_catalog.lower(v_request.target_instagram_id),
        p_target_profile_image_url, v_request.selected_plan_id_snapshot,
        v_followers.declared_count, v_followers.collected_count,
        v_following.declared_count, v_following.collected_count,
        v_relationship.mutual_count, v_relationship.public_count,
        v_relationship.private_count, v_relationship.detailed_public_count,
        v_relationship.public_count - v_relationship.detailed_public_count,
        (SELECT pg_catalog.count(*) FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
              AND feature.terminal_classification = 'unavailable'),
        (SELECT pg_catalog.count(*) FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
              AND feature.terminal_classification = 'media_unavailable'),
        v_request.exclusion_decision_snapshot = 'exclude', 'risk-policy-v2.2',
        p_job_input_hash
    ) RETURNING * INTO v_summary;

    INSERT INTO public.analysis_v2_female_results (
        request_id, candidate_id, sort_ordinal, instagram_id, full_name,
        profile_image_url, bio, display_score, risk_band, featured_rank,
        recent_mutual_rank, analysis_depth, one_line_overview,
        narrative_line_one, narrative_line_two
    )
    SELECT p_request_id, ordered.candidate_id, ordered.sort_ordinal,
        ordered.instagram_id, ordered.full_name, ordered.profile_image_url, ordered.bio,
        ordered.display_score, ordered.risk_band, ordered.featured_rank,
        ordered.recent_mutual_rank,
        CASE WHEN ordered.line_one IS NULL THEN 'features' ELSE 'narrative' END,
        ordered.one_line_overview, ordered.line_one, ordered.line_two
    FROM (
        SELECT feature.candidate_id, feature.instagram_id, feature.full_name,
            feature.profile_image_url, feature.bio, score.display_score, score.risk_band,
            score.featured_rank, score.recent_mutual_rank, feature.one_line_overview,
            narrative.line_one, narrative.line_two,
            pg_catalog.row_number() OVER (
                ORDER BY score.display_score DESC, feature.candidate_id
            )::SMALLINT AS sort_ordinal
        FROM public.analysis_v2_candidate_feature_rows AS feature
        JOIN public.analysis_v2_candidate_score_rows AS score
          ON score.request_id = feature.request_id
         AND score.candidate_id = feature.candidate_id
        LEFT JOIN public.analysis_v2_narrative_rows AS narrative
          ON narrative.request_id = feature.request_id
         AND narrative.candidate_id = feature.candidate_id
        WHERE feature.request_id = p_request_id
          AND feature.terminal_classification = 'verified_female'
    ) AS ordered;

    INSERT INTO public.analysis_v2_private_results (
        request_id, candidate_id, sort_ordinal, instagram_id, full_name, profile_image_url
    )
    SELECT p_request_id, private_name.candidate_id,
        pg_catalog.row_number() OVER (
            ORDER BY private_name.name_female_score DESC,
                private_name.name_confidence DESC, private_name.instagram_id
        )::SMALLINT,
        private_name.instagram_id, private_name.full_name, private_name.profile_image_url
    FROM public.analysis_v2_private_name_rows AS private_name
    WHERE private_name.request_id = p_request_id;

    IF (SELECT pg_catalog.count(*) FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = p_request_id) <> v_verified_count
       OR (SELECT pg_catalog.count(*) FROM public.analysis_v2_private_results AS private_result
        WHERE private_result.request_id = p_request_id) <> v_relationship.private_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_tracks := pg_catalog.jsonb_build_object(
        'relationshipAi', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'relationshipAi'->>'stageCode',
            'done', (v_progress.tracks->'relationshipAi'->>'total')::INTEGER,
            'total', (v_progress.tracks->'relationshipAi'->>'total')::INTEGER,
            'progressBp', CASE WHEN (v_progress.tracks->'relationshipAi'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        ),
        'interactions', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'interactions'->>'stageCode',
            'done', (v_progress.tracks->'interactions'->>'total')::INTEGER,
            'total', (v_progress.tracks->'interactions'->>'total')::INTEGER,
            'progressBp', CASE WHEN (v_progress.tracks->'interactions'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        ),
        'finalization', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'finalization'->>'stageCode',
            'done', (v_progress.tracks->'finalization'->>'total')::INTEGER,
            'total', (v_progress.tracks->'finalization'->>'total')::INTEGER,
            'progressBp', CASE WHEN (v_progress.tracks->'finalization'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        )
    );
    v_revision := v_progress.revision + 1;
    v_sequence := v_progress.last_event_seq + 1;
    v_fingerprint := public.analysis_v2_dag_hash_json(pg_catalog.jsonb_build_object(
        'domain', 'analysis-v2-progress-snapshot-v1',
        'requestId', p_request_id, 'status', 'completed', 'progressBp', 10000,
        'backgroundProcessing', FALSE, 'tracks', v_tracks,
        'activeProfile', NULL, 'etaRange', NULL
    ));
    v_event_key := public.analysis_v2_dag_hash_json(pg_catalog.jsonb_build_object(
        'domain', 'analysis-v2-progress-event-v1',
        'requestId', p_request_id, 'eventCode', 'ANALYSIS_COMPLETED'
    ));
    UPDATE public.analysis_progress_state AS progress_state
    SET revision = v_revision, status = 'completed', progress_bp = 10000,
        background_processing = FALSE, tracks = v_tracks, active_profile = NULL,
        eta_range = NULL, last_event_seq = v_sequence,
        snapshot_fingerprint = v_fingerprint, updated_at = v_now
    WHERE progress_state.request_id = p_request_id;
    INSERT INTO public.analysis_progress_events (
        request_id, seq, event_key, revision, snapshot_fingerprint, occurred_at,
        event_state, event_code, copy_code, aggregate_count
    ) VALUES (
        p_request_id, v_sequence, v_event_key, v_revision, v_fingerprint, v_now,
        'confirmed', 'ANALYSIS_COMPLETED', 'ANALYSIS_COMPLETED', NULL
    );

    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
        completion_token = p_claim_token, completion_fanout_hash = pg_catalog.md5('[]'),
        completed_at = v_now, updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key;
    UPDATE public.analysis_requests AS analysis_request
    SET status = 'completed', progress = 100, background_processing = FALSE,
        progress_step = 'V2 analysis completed', current_step = 'completed',
        error_message = NULL, completed_at = v_now
    WHERE analysis_request.id = p_request_id;

    PERFORM public.analysis_v2_scrub_terminal_request_pii(p_request_id, v_now);
    PERFORM public.analysis_v2_purge_result_working_set(p_request_id, TRUE);
    RETURN pg_catalog.jsonb_build_object(
        'finalized', TRUE,
        'requestStatus', 'completed',
        'summary', public.analysis_v2_result_summary_json(v_summary)
    );
END;
$$;

COMMENT ON FUNCTION public.analysis_v2_profile_terminal_attempt(
    UUID, TEXT, TEXT, TEXT[]
) IS 'Single source of truth for which profile-fetch attempt is terminal for a username: a recorded repair outcome wins, then the frozen fallback set, then primary.';
