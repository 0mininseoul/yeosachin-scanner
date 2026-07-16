-- Preserve the public `unavailable` classification while retaining its bounded internal cause.
ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD COLUMN unavailable_reason VARCHAR(16);

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
     AND outcome.attempt = CASE
        WHEN NEW.instagram_id = ANY(profile_batch.frozen_unresolved_usernames)
            THEN 'fallback'
        ELSE 'primary'
     END
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

CREATE TRIGGER analysis_v2_candidate_feature_unavailable_reason
BEFORE INSERT ON public.analysis_v2_candidate_feature_rows
FOR EACH ROW EXECUTE FUNCTION public.analysis_v2_set_feature_unavailable_reason();

UPDATE public.analysis_v2_candidate_feature_rows AS feature
SET unavailable_reason = CASE
    WHEN outcome.status = 'success' THEN 'ai_response'
    ELSE 'profile_fetch'
END
FROM public.analysis_v2_profile_fetch_batches AS profile_batch
JOIN public.analysis_v2_profile_fetch_outcomes AS outcome
  ON outcome.request_id = profile_batch.request_id
 AND outcome.job_key = profile_batch.job_key
WHERE feature.terminal_classification = 'unavailable'
  AND profile_batch.request_id = feature.request_id
  AND profile_batch.job_key = 'track:profiles:batch:' || feature.batch::TEXT
  AND outcome.username = feature.instagram_id
  AND outcome.attempt = CASE
    WHEN feature.instagram_id = ANY(profile_batch.frozen_unresolved_usernames)
        THEN 'fallback'
    ELSE 'primary'
  END;

ALTER TABLE public.analysis_v2_candidate_feature_rows
    ADD CONSTRAINT analysis_v2_candidate_feature_unavailable_reason_check CHECK (
        (
            terminal_classification = 'unavailable'
            AND unavailable_reason IN ('profile_fetch', 'ai_response')
        )
        OR (
            terminal_classification <> 'unavailable'
            AND unavailable_reason IS NULL
        )
    );

ALTER TABLE public.analysis_v2_result_summaries
    ADD COLUMN analysis_unavailable_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.analysis_v2_result_summaries
    DROP CONSTRAINT analysis_v2_result_summary_count_check;
ALTER TABLE public.analysis_v2_result_summaries
    ADD CONSTRAINT analysis_v2_result_summary_count_check CHECK (
        detected_mutuals BETWEEN 0 AND 1200
        AND public_mutuals BETWEEN 0 AND detected_mutuals
        AND private_mutuals BETWEEN 0 AND detected_mutuals
        AND public_mutuals + private_mutuals = detected_mutuals
        AND screened_mutuals BETWEEN 0 AND public_mutuals
        AND not_screened_mutuals = public_mutuals - screened_mutuals
        AND fetch_unavailable_count BETWEEN 0 AND screened_mutuals
        AND media_unavailable_count BETWEEN 0 AND screened_mutuals
        AND analysis_unavailable_count BETWEEN 0 AND screened_mutuals
        AND fetch_unavailable_count + media_unavailable_count
            + analysis_unavailable_count <= screened_mutuals
        AND detected_mutuals <= followers_collected
        AND detected_mutuals <= following_collected
    );

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
        'successfullyScreenedMutuals', p_summary.screened_mutuals
            - p_summary.fetch_unavailable_count - p_summary.media_unavailable_count
            - p_summary.analysis_unavailable_count,
        'fetchUnavailableMutuals', p_summary.fetch_unavailable_count,
        'mediaUnavailableMutuals', p_summary.media_unavailable_count,
        'analysisUnavailableMutuals', p_summary.analysis_unavailable_count,
        'notScreenedMutuals', p_summary.not_screened_mutuals,
        'exclusionApplied', p_summary.exclusion_applied,
        'scorePolicyVersion', p_summary.score_policy_version
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_result_summary_json(
    public.analysis_v2_result_summaries
) FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_v2_result_coverage_telemetry
    ADD COLUMN analysis_unavailable_count SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE public.analysis_v2_result_coverage_telemetry
    DROP CONSTRAINT analysis_v2_result_coverage_telemetry_counts_check;
ALTER TABLE public.analysis_v2_result_coverage_telemetry
    ADD CONSTRAINT analysis_v2_result_coverage_telemetry_counts_check CHECK (
        followers_declared BETWEEN 0 AND 1200
        AND followers_collected BETWEEN 0 AND followers_declared
        AND following_declared BETWEEN 0 AND 1200
        AND following_collected BETWEEN 0 AND following_declared
        AND detected_mutuals BETWEEN 0 AND 1200
        AND public_mutuals BETWEEN 0 AND detected_mutuals
        AND private_mutuals BETWEEN 0 AND detected_mutuals
        AND public_mutuals + private_mutuals = detected_mutuals
        AND screened_mutuals BETWEEN 0 AND public_mutuals
        AND not_screened_mutuals = public_mutuals - screened_mutuals
        AND fetch_unavailable_count BETWEEN 0 AND screened_mutuals
        AND media_unavailable_count BETWEEN 0 AND screened_mutuals
        AND analysis_unavailable_count BETWEEN 0 AND screened_mutuals
        AND fetch_unavailable_count + media_unavailable_count
            + analysis_unavailable_count <= screened_mutuals
    );

CREATE OR REPLACE FUNCTION public.capture_analysis_v2_result_coverage_telemetry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    INSERT INTO public.analysis_v2_result_coverage_telemetry (
        request_id, plan_id,
        followers_declared, followers_collected,
        following_declared, following_collected,
        detected_mutuals, public_mutuals, private_mutuals,
        screened_mutuals, not_screened_mutuals,
        fetch_unavailable_count, media_unavailable_count,
        analysis_unavailable_count
    ) VALUES (
        NEW.request_id, NEW.plan_id,
        NEW.followers_declared, NEW.followers_collected,
        NEW.following_declared, NEW.following_collected,
        NEW.detected_mutuals, NEW.public_mutuals, NEW.private_mutuals,
        NEW.screened_mutuals, NEW.not_screened_mutuals,
        NEW.fetch_unavailable_count, NEW.media_unavailable_count,
        NEW.analysis_unavailable_count
    )
    ON CONFLICT (request_id) DO UPDATE
    SET plan_id = EXCLUDED.plan_id,
        followers_declared = EXCLUDED.followers_declared,
        followers_collected = EXCLUDED.followers_collected,
        following_declared = EXCLUDED.following_declared,
        following_collected = EXCLUDED.following_collected,
        detected_mutuals = EXCLUDED.detected_mutuals,
        public_mutuals = EXCLUDED.public_mutuals,
        private_mutuals = EXCLUDED.private_mutuals,
        screened_mutuals = EXCLUDED.screened_mutuals,
        not_screened_mutuals = EXCLUDED.not_screened_mutuals,
        fetch_unavailable_count = EXCLUDED.fetch_unavailable_count,
        media_unavailable_count = EXCLUDED.media_unavailable_count,
        analysis_unavailable_count = EXCLUDED.analysis_unavailable_count;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_analysis_v2_result_coverage_telemetry()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER analysis_v2_result_coverage_telemetry_capture
    ON public.analysis_v2_result_summaries;
CREATE TRIGGER analysis_v2_result_coverage_telemetry_capture
AFTER INSERT OR UPDATE OF
    fetch_unavailable_count, media_unavailable_count, analysis_unavailable_count
ON public.analysis_v2_result_summaries
FOR EACH ROW EXECUTE FUNCTION public.capture_analysis_v2_result_coverage_telemetry();

-- Keep the legacy finalizer body stable, but validate and adapt its working set atomically.
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
                     AND outcome.attempt = CASE
                        WHEN feature.instagram_id = ANY(
                            profile_batch.frozen_unresolved_usernames
                        ) THEN 'fallback' ELSE 'primary' END
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
                     AND outcome.attempt = CASE
                        WHEN feature.instagram_id = ANY(
                            profile_batch.frozen_unresolved_usernames
                        ) THEN 'fallback' ELSE 'primary' END
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

-- Extend the existing operational loader without duplicating its large aggregation query.
ALTER FUNCTION public.load_analysis_v2_operational_observability(UUID)
    RENAME TO analysis_v2_load_operational_observability_internal;
REVOKE ALL ON FUNCTION public.analysis_v2_load_operational_observability_internal(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_operational_observability(
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
    v_analysis_unavailable_count SMALLINT;
BEGIN
    v_payload := public.analysis_v2_load_operational_observability_internal(p_request_id);
    IF v_payload IS NULL OR v_payload->'summary'->'resultCoverage' = 'null'::JSONB THEN
        RETURN v_payload;
    END IF;
    SELECT telemetry.analysis_unavailable_count INTO v_analysis_unavailable_count
    FROM public.analysis_v2_result_coverage_telemetry AS telemetry
    WHERE telemetry.request_id = p_request_id;
    RETURN pg_catalog.jsonb_set(
        v_payload,
        ARRAY['summary', 'resultCoverage', 'analysisUnavailableCount'],
        pg_catalog.to_jsonb(COALESCE(v_analysis_unavailable_count, 0)),
        TRUE
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_operational_observability(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_operational_observability(UUID)
    TO service_role;

-- A request-level 4xx remains `rejected`; only a generated response rejected by strict parsing
-- becomes replay-safe `response_rejected`.
ALTER TABLE public.analysis_v2_ai_attempts
    DROP CONSTRAINT analysis_v2_ai_attempt_status_check;
ALTER TABLE public.analysis_v2_ai_attempts
    ADD CONSTRAINT analysis_v2_ai_attempt_status_check CHECK (
        status IN (
            'reserved', 'success', 'rate_limited', 'ambiguous', 'rejected',
            'response_rejected'
        )
    );

DO $migration$
DECLARE
    v_definition TEXT;
    v_old TEXT :=
        'p_status NOT IN (''success'', ''rate_limited'', ''ambiguous'', ''rejected'')';
    v_new TEXT :=
        'p_status NOT IN (''success'', ''rate_limited'', ''ambiguous'', ''rejected'', ''response_rejected'')';
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.analysis_v2_terminalize_ai_attempt_internal(uuid,text,uuid,text,smallint,uuid,text,jsonb)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(v_definition, v_old) = 0
       OR pg_catalog.strpos(
            pg_catalog.substr(
                v_definition,
                pg_catalog.strpos(v_definition, v_old) + pg_catalog.char_length(v_old)
            ),
            v_old
       ) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESPONSE_REJECTED_MIGRATION_DRIFT', ERRCODE = 'P0001';
    END IF;
    EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
END;
$migration$;

-- Expose only the immutable request policy value needed by service-role workers.
CREATE OR REPLACE FUNCTION public.load_analysis_v2_ai_stage_policy_version(
    p_request_id UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT analysis_request.policy_versions_snapshot->>'aiStage'
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2';
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_ai_stage_policy_version(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_ai_stage_policy_version(UUID)
    TO service_role;

DO $migration$
DECLARE
    v_signature TEXT;
    v_definition TEXT;
    v_old TEXT := 'ai_attempt.status = ''rejected''';
    v_new TEXT := 'ai_attempt.status = ''response_rejected''';
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'public.checkpoint_analysis_v2_private_names(uuid,text,uuid,text,integer,text,text,text,jsonb)',
        'public.checkpoint_analysis_v2_narratives(uuid,text,uuid,text,jsonb)',
        'public.analysis_v2_result_partner_safety_row_matches(uuid,text,jsonb)'
    ] LOOP
        SELECT pg_catalog.pg_get_functiondef(
            v_signature::pg_catalog.regprocedure
        ) INTO v_definition;
        IF pg_catalog.strpos(v_definition, v_old) = 0
           OR pg_catalog.strpos(
                pg_catalog.substr(
                    v_definition,
                    pg_catalog.strpos(v_definition, v_old) + pg_catalog.char_length(v_old)
                ),
                v_old
           ) > 0 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RESPONSE_REJECTED_FALLBACK_MIGRATION_DRIFT',
                ERRCODE = 'P0001';
        END IF;
        EXECUTE pg_catalog.replace(v_definition, v_old, v_new);
    END LOOP;
END;
$migration$;
