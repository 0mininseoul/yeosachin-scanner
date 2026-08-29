BEGIN;

ALTER TABLE public.analysis_v2_active_profile_heartbeats
    ADD COLUMN call_phase TEXT NOT NULL DEFAULT 'fetching';

ALTER TABLE public.analysis_v2_active_profile_heartbeats
    ADD CONSTRAINT analysis_v2_active_profile_call_phase_check CHECK (
        call_phase IN ('fetching', 'analyzing', 'persisting')
    );

DROP FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT, TEXT[], TEXT
);

CREATE FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_started_at TIMESTAMP WITH TIME ZONE,
    p_total_count INTEGER,
    p_masked_username TEXT,
    p_image_url TEXT DEFAULT NULL,
    p_feed_image_urls TEXT[] DEFAULT '{}'::TEXT[],
    p_candidate_key TEXT DEFAULT NULL,
    p_current_ordinal INTEGER DEFAULT 0,
    p_call_phase TEXT DEFAULT 'fetching'
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_expected_total INTEGER;
    v_advanced BOOLEAN := FALSE;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL
       OR p_job_key !~ '^track:(profiles|profile-ai):batch:[0-9]+$'
       OR p_claim_token IS NULL OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_started_at IS NULL
       OR p_started_at < v_now - INTERVAL '30 minutes'
       OR p_started_at > v_now + INTERVAL '5 minutes'
       OR p_total_count IS NULL OR p_total_count NOT BETWEEN 1 AND 30
       OR p_current_ordinal IS NULL
       OR p_current_ordinal NOT BETWEEN 0 AND p_total_count
       OR p_call_phase IS NULL
       OR p_call_phase NOT IN ('fetching', 'analyzing', 'persisting')
       OR p_masked_username IS NULL
       OR p_masked_username !~ '^[A-Za-z0-9._]*\*[A-Za-z0-9._*]*$'
       OR pg_catalog.char_length(p_masked_username) NOT BETWEEN 1 AND 30
       OR (
            p_image_url IS NOT NULL AND (
                pg_catalog.char_length(p_image_url) NOT BETWEEN 1 AND 2048
                OR p_image_url NOT LIKE '/api/image-proxy?%'
            )
       )
       OR NOT public.analysis_v2_valid_active_profile_feed_image_urls(
            p_feed_image_urls
       )
       OR (
            p_candidate_key IS NOT NULL
            AND p_candidate_key !~ '^[a-f0-9]{64}$'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROGRESS_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT topology.item_count INTO v_expected_total
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id
      AND topology.topology_kind = 'profile'
      AND topology.batch = pg_catalog.substring(p_job_key, '([0-9]+)$')::INTEGER;
    IF NOT FOUND OR v_expected_total IS DISTINCT FROM p_total_count THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROGRESS_TOPOLOGY_MISMATCH', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_active_profile_heartbeats (
        request_id, job_key, job_input_hash, claim_token, started_at,
        completed_count, total_count, masked_username, image_url,
        feed_image_urls, candidate_key, call_phase, updated_at
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_claim_token, p_started_at,
        p_current_ordinal, p_total_count, p_masked_username, p_image_url,
        p_feed_image_urls, p_candidate_key, p_call_phase, v_now
    )
    ON CONFLICT (request_id, job_key) DO UPDATE
    SET job_input_hash = EXCLUDED.job_input_hash,
        claim_token = EXCLUDED.claim_token,
        started_at = EXCLUDED.started_at,
        completed_count = EXCLUDED.completed_count,
        total_count = EXCLUDED.total_count,
        -- Identity and media are updated as one ordinal-paired record. A
        -- lower ordinal from a concurrent provider call is rejected below,
        -- so it can never overwrite the higher ordinal's label or phase.
        masked_username = EXCLUDED.masked_username,
        image_url = EXCLUDED.image_url,
        feed_image_urls = EXCLUDED.feed_image_urls,
        candidate_key = EXCLUDED.candidate_key,
        call_phase = EXCLUDED.call_phase,
        updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.claim_token
            IS DISTINCT FROM public.analysis_v2_active_profile_heartbeats.claim_token
       OR (
            EXCLUDED.claim_token
                IS NOT DISTINCT FROM public.analysis_v2_active_profile_heartbeats.claim_token
            AND EXCLUDED.completed_count
                >= public.analysis_v2_active_profile_heartbeats.completed_count
            AND (
                EXCLUDED.started_at
                    > public.analysis_v2_active_profile_heartbeats.started_at
                OR (
                    EXCLUDED.started_at
                        = public.analysis_v2_active_profile_heartbeats.started_at
                    AND (
                        EXCLUDED.completed_count
                            > public.analysis_v2_active_profile_heartbeats.completed_count
                        OR EXCLUDED.masked_username IS DISTINCT FROM
                            public.analysis_v2_active_profile_heartbeats.masked_username
                        OR EXCLUDED.image_url IS DISTINCT FROM
                            public.analysis_v2_active_profile_heartbeats.image_url
                        OR EXCLUDED.feed_image_urls IS DISTINCT FROM
                            public.analysis_v2_active_profile_heartbeats.feed_image_urls
                        OR EXCLUDED.candidate_key IS DISTINCT FROM
                            public.analysis_v2_active_profile_heartbeats.candidate_key
                        OR EXCLUDED.call_phase IS DISTINCT FROM
                            public.analysis_v2_active_profile_heartbeats.call_phase
                    )
                )
            )
       )
    RETURNING TRUE INTO v_advanced;

    RETURN COALESCE(v_advanced, FALSE);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT, TEXT[], TEXT,
    INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT, TEXT[], TEXT,
    INTEGER, TEXT
) TO service_role;

COMMENT ON COLUMN public.analysis_v2_active_profile_heartbeats.completed_count IS
    'Current 1-based profile ordinal for the active batch; retained column name preserves rolling compatibility.';

-- The old four-argument RPC intentionally remains a no-media path. The
-- progress page opts into the sibling RPC below so duration and other owner
-- reads do not scan, aggregate, or sign candidate outcomes.
CREATE OR REPLACE FUNCTION public.analysis_v2_load_progress_internal(
    p_request_id UUID,
    p_user_id UUID,
    p_after_sequence BIGINT,
    p_event_limit INTEGER,
    p_include_candidate_media BOOLEAN
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_state public.analysis_progress_state%ROWTYPE;
    v_events JSONB;
    v_active_profile JSONB;
    v_candidate_media JSONB := '[]'::JSONB;
    v_snapshot JSONB;
BEGIN
    IF p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_after_sequence IS NULL
       OR p_after_sequence < 0
       OR p_after_sequence > 9007199254740991
       OR p_event_limit IS NULL
       OR p_event_limit < 1
       OR p_event_limit > 200
       OR p_include_candidate_media IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_INVALID', ERRCODE = 'P0001';
    END IF;

    -- The owner check is deliberately before any profile outcome is read.
    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.user_id = p_user_id
          AND analysis_request.pipeline_version = 'v2'
    ) THEN
        RETURN NULL;
    END IF;

    SELECT progress_state.* INTO v_state
    FROM public.analysis_progress_state AS progress_state
    WHERE progress_state.request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF v_state.status = 'processing' THEN
        SELECT
            pg_catalog.jsonb_build_object(
                'maskedUsername', heartbeat.masked_username,
                'imageUrl', heartbeat.image_url,
                'feedImageUrls', heartbeat.feed_image_urls,
                'currentOrdinal', heartbeat.completed_count,
                'totalCount', heartbeat.total_count,
                'callPhase', heartbeat.call_phase
            ) || CASE
                WHEN heartbeat.candidate_key IS NULL THEN '{}'::JSONB
                ELSE pg_catalog.jsonb_build_object(
                    'candidateKey', heartbeat.candidate_key
                )
            END
        INTO v_active_profile
        FROM public.analysis_v2_active_profile_heartbeats AS heartbeat
        JOIN public.analysis_pipeline_jobs AS job
          ON job.request_id = heartbeat.request_id
         AND job.job_key = heartbeat.job_key
        WHERE heartbeat.request_id = p_request_id
          AND job.status = 'processing'
          AND job.input_hash = heartbeat.job_input_hash
          AND job.lease_token = heartbeat.claim_token
          AND job.lease_expires_at > pg_catalog.clock_timestamp()
        ORDER BY heartbeat.started_at DESC, heartbeat.updated_at DESC, heartbeat.job_key DESC
        LIMIT 1;

        IF p_include_candidate_media THEN
            -- Emit only the image-bearing projection needed by the owner rail;
            -- never aggregate the full private profile snapshot.
            SELECT COALESCE(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'username', candidate.username,
                    'profile', pg_catalog.jsonb_strip_nulls(
                        pg_catalog.jsonb_build_object(
                            'profilePicUrl', candidate.profile_snapshot->'profilePicUrl',
                            'latestPosts', (
                                SELECT COALESCE(pg_catalog.jsonb_agg(
                                    pg_catalog.jsonb_strip_nulls(
                                        pg_catalog.jsonb_build_object(
                                            'type', post.value->'type',
                                            'imageUrl', post.value->'imageUrl',
                                            'thumbnailUrl', post.value->'thumbnailUrl',
                                            'videoUrl', post.value->'videoUrl',
                                            'mediaItems', CASE
                                                WHEN post.value->>'type' = 'carousel' THEN (
                                                    SELECT COALESCE(pg_catalog.jsonb_agg(
                                                        pg_catalog.jsonb_strip_nulls(
                                                            pg_catalog.jsonb_build_object(
                                                                'type', child.value->'type',
                                                                'imageUrl', child.value->'imageUrl',
                                                                'thumbnailUrl', child.value->'thumbnailUrl',
                                                                'videoUrl', child.value->'videoUrl'
                                                            )
                                                        ) ORDER BY child.ordinality
                                                    ), '[]'::JSONB)
                                                    FROM pg_catalog.jsonb_array_elements(
                                                        CASE
                                                            WHEN pg_catalog.jsonb_typeof(post.value->'mediaItems') = 'array'
                                                                THEN post.value->'mediaItems'
                                                            ELSE '[]'::JSONB
                                                        END
                                                    ) WITH ORDINALITY AS child(value, ordinality)
                                                    WHERE child.ordinality <= 20
                                                )
                                                ELSE NULL
                                            END
                                        )
                                    ) ORDER BY post.ordinality
                                ), '[]'::JSONB)
                                FROM pg_catalog.jsonb_array_elements(
                                    CASE
                                        WHEN pg_catalog.jsonb_typeof(candidate.profile_snapshot->'latestPosts') = 'array'
                                            THEN candidate.profile_snapshot->'latestPosts'
                                        ELSE '[]'::JSONB
                                    END
                                ) WITH ORDINALITY AS post(value, ordinality)
                                WHERE post.ordinality <= 8
                            )
                        )
                    )
                )
                ORDER BY candidate.captured_at ASC, candidate.ordinal, candidate.username
            ), '[]'::JSONB)
            INTO v_candidate_media
            FROM (
                SELECT candidate.username, candidate.profile_snapshot, candidate.captured_at, candidate.ordinal
                FROM (
                    SELECT DISTINCT ON (outcome.username)
                        outcome.username,
                        outcome.profile_snapshot,
                        outcome.captured_at,
                        outcome.ordinal
                    FROM public.analysis_v2_profile_fetch_outcomes AS outcome
                    WHERE outcome.request_id = p_request_id
                      AND outcome.job_key LIKE 'track:profiles:batch:%'
                      AND outcome.status = 'success'
                      AND outcome.profile_snapshot IS NOT NULL
                      AND outcome.profile_snapshot->>'isPrivate' = 'false'
                    ORDER BY outcome.username,
                        outcome.captured_at DESC,
                        outcome.ordinal DESC,
                        CASE outcome.attempt
                            WHEN 'repair' THEN 0
                            WHEN 'fallback' THEN 1
                            ELSE 2
                        END
                ) AS candidate
                -- Select newest unique candidates, then emit oldest-first for
                -- deterministic client reconciliation and rail motion.
                ORDER BY candidate.captured_at DESC, candidate.ordinal DESC, candidate.username DESC
                LIMIT 20
            ) AS candidate;
        END IF;
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(page.event_json ORDER BY page.seq), '[]'::JSONB)
    INTO v_events
    FROM (
        SELECT
            progress_event.seq,
            public.analysis_v2_progress_event_json(progress_event) AS event_json
        FROM public.analysis_progress_events AS progress_event
        WHERE progress_event.request_id = p_request_id
          AND progress_event.seq > p_after_sequence
        ORDER BY progress_event.seq
        LIMIT p_event_limit
    ) AS page;

    v_snapshot := pg_catalog.jsonb_set(
        public.analysis_v2_progress_snapshot_json(v_state),
        '{activeProfile}',
        COALESCE(v_active_profile, 'null'::JSONB),
        TRUE
    );
    IF p_include_candidate_media THEN
        v_snapshot := pg_catalog.jsonb_set(
            v_snapshot,
            '{candidateMediaRaw}',
            v_candidate_media,
            TRUE
        );
    END IF;
    RETURN pg_catalog.jsonb_build_object('snapshot', v_snapshot, 'events', v_events);
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_progress(
    p_request_id UUID,
    p_user_id UUID,
    p_after_sequence BIGINT DEFAULT 0,
    p_event_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.analysis_v2_load_progress_internal(
        p_request_id, p_user_id, p_after_sequence, p_event_limit, FALSE
    );
$$;

CREATE FUNCTION public.load_analysis_v2_progress_with_candidate_media(
    p_request_id UUID,
    p_user_id UUID,
    p_after_sequence BIGINT DEFAULT 0,
    p_event_limit INTEGER DEFAULT 100
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.analysis_v2_load_progress_internal(
        p_request_id, p_user_id, p_after_sequence, p_event_limit, TRUE
    );
$$;

/*
 * Progress stage metadata is owned by the durable state row, not by whichever
 * distributed worker happens to report last.  Keep the order explicit for
 * each track because a generic lexical comparison would make an older stage
 * such as PROFILE_SCREENING appear newer than RESULT_FINALIZING.
 */
CREATE OR REPLACE FUNCTION public.analysis_v2_progress_stage_rank(
    p_track_id TEXT,
    p_stage_code TEXT
)
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE p_track_id
        WHEN 'relationshipAi' THEN CASE p_stage_code
            WHEN 'RELATIONSHIP_AI_QUEUED' THEN 0
            WHEN 'RELATIONSHIPS_COLLECTING' THEN 1
            WHEN 'RELATIONSHIP_AI_RUNNING' THEN 2
            WHEN 'PUBLIC_PROFILES_COLLECTING' THEN 3
            WHEN 'PROFILE_SCREENING' THEN 4
            WHEN 'EVIDENCE_JOINING' THEN 5
            WHEN 'CANDIDATES_RANKING' THEN 6
            WHEN 'PARTNER_CONTEXT_CHECKING' THEN 7
            WHEN 'RELATIONSHIP_AI_COMPLETE' THEN 8
            ELSE -1
        END
        WHEN 'interactions' THEN CASE p_stage_code
            WHEN 'INTERACTIONS_QUEUED' THEN 0
            WHEN 'TARGET_INTERACTIONS_COLLECTING' THEN 1
            WHEN 'INTERACTIONS_RUNNING' THEN 2
            WHEN 'SHORTLIST_INTERACTIONS_COLLECTING' THEN 3
            WHEN 'INTERACTIONS_COMPLETE' THEN 4
            ELSE -1
        END
        WHEN 'finalization' THEN CASE p_stage_code
            WHEN 'FINALIZATION_QUEUED' THEN 0
            WHEN 'FINALIZATION_RUNNING' THEN 1
            WHEN 'PRIVATE_NAMES_SCREENING' THEN 2
            WHEN 'FINAL_SCORE_CALCULATING' THEN 3
            WHEN 'HIGH_RISK_NARRATIVES_WRITING' THEN 4
            WHEN 'RESULT_FINALIZING' THEN 5
            WHEN 'FINALIZATION_COMPLETE' THEN 6
            ELSE -1
        END
        ELSE -1
    END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_progress_merge_track_stage(
    p_track_id TEXT,
    p_previous JSONB,
    p_next JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN public.analysis_v2_progress_stage_rank(
                p_track_id, p_previous->>'stageCode'
             ) < 0
          OR public.analysis_v2_progress_stage_rank(
                p_track_id, p_next->>'stageCode'
             ) < 0
        THEN p_previous
        WHEN public.analysis_v2_progress_stage_rank(
                p_track_id, p_next->>'stageCode'
             ) < public.analysis_v2_progress_stage_rank(
                p_track_id, p_previous->>'stageCode'
             )
        THEN pg_catalog.jsonb_set(
            p_next,
            ARRAY['stageCode'],
            pg_catalog.to_jsonb(p_previous->>'stageCode'),
            TRUE
        )
        ELSE p_next
    END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_progress_canonical_tracks(
    p_previous JSONB,
    p_next JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_set(
        pg_catalog.jsonb_set(
            pg_catalog.jsonb_set(
                p_next,
                '{relationshipAi}',
                public.analysis_v2_progress_merge_track_stage(
                    'relationshipAi',
                    p_previous->'relationshipAi',
                    p_next->'relationshipAi'
                ),
                TRUE
            ),
            '{interactions}',
            public.analysis_v2_progress_merge_track_stage(
                'interactions',
                p_previous->'interactions',
                p_next->'interactions'
            ),
            TRUE
        ),
        '{finalization}',
        public.analysis_v2_progress_merge_track_stage(
            'finalization',
            p_previous->'finalization',
            p_next->'finalization'
        ),
        TRUE
    );
$$;

/* Stage canonicalization can change the payload after the client has already
   hashed its pre-canonical snapshot. Rebuild a deterministic DB identity from
   the canonical payload so state and any later event share one identity. */
CREATE OR REPLACE FUNCTION public.analysis_v2_progress_snapshot_fingerprint(
    p_status TEXT,
    p_background_processing BOOLEAN,
    p_tracks JSONB,
    p_active_profile JSONB,
    p_eta_range JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_payload BYTEA := pg_catalog.convert_to(
        pg_catalog.jsonb_build_object(
            'domain', 'analysis-v2-progress-canonical-fingerprint-v1',
            'status', p_status,
            'backgroundProcessing', p_background_processing,
            'tracks', p_tracks,
            'activeProfile', p_active_profile,
            'etaRange', p_eta_range
        )::TEXT,
        'UTF8'
    );
    v_fingerprint TEXT;
BEGIN
    BEGIN
        EXECUTE 'SELECT pg_catalog.encode(pg_catalog.sha256($1::BYTEA), ''hex'')'
            INTO v_fingerprint
            USING v_payload;
    EXCEPTION
        WHEN undefined_function THEN
            EXECUTE 'SELECT pg_catalog.encode(extensions.digest($1::BYTEA, ''sha256''), ''hex'')'
                INTO v_fingerprint
                USING v_payload;
    END;
    RETURN v_fingerprint;
END;
$$;

/* The historical checkpoint remains the implementation of fencing, counter
   monotonicity, revision/event idempotence, and conflict recovery. Rename it
   once, then put the stage canonicalization boundary in front of it. The
   dynamic lock queries keep this migration installable in narrow contract
   harnesses while production calls acquire the exact same lock order as the
   historical function: preflight, request, job, then state. */
ALTER FUNCTION public.checkpoint_analysis_v2_progress(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, BOOLEAN, JSONB, JSONB, JSONB, TEXT, JSONB, TEXT
) RENAME TO checkpoint_analysis_v2_progress_v1;

CREATE FUNCTION public.checkpoint_analysis_v2_progress(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_status TEXT,
    p_progress_bp INTEGER,
    p_background_processing BOOLEAN,
    p_tracks JSONB,
    p_active_profile JSONB,
    p_eta_range JSONB,
    p_snapshot_fingerprint TEXT,
    p_event JSONB DEFAULT NULL,
    p_event_key TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_lock INTEGER;
    v_previous_tracks JSONB;
    v_previous_status TEXT;
    v_previous_progress_bp INTEGER;
    v_previous_background_processing BOOLEAN;
    v_previous_active_profile JSONB;
    v_previous_eta_range JSONB;
    v_previous_fingerprint TEXT;
    v_canonical_tracks JSONB := p_tracks;
    v_canonical_progress_bp INTEGER := p_progress_bp;
    v_stage_canonicalized BOOLEAN := FALSE;
    v_effective_fingerprint TEXT := p_snapshot_fingerprint;
    v_effective_event JSONB := p_event;
    v_effective_event_key TEXT := p_event_key;
BEGIN
    EXECUTE 'SELECT 1
             FROM public.analysis_preflights AS preflight
             WHERE preflight.consumed_request_id = $1
             FOR UPDATE'
        INTO v_lock USING p_request_id;
    EXECUTE 'SELECT 1
             FROM public.analysis_requests AS analysis_request
             WHERE analysis_request.id = $1
             FOR UPDATE'
        INTO v_lock USING p_request_id;
    EXECUTE 'SELECT 1
             FROM public.analysis_pipeline_jobs AS job
             WHERE job.request_id = $1 AND job.job_key = $2
             FOR UPDATE'
        INTO v_lock USING p_request_id, p_job_key;
    EXECUTE 'SELECT progress_state.status,
                    progress_state.progress_bp,
                    progress_state.background_processing,
                    progress_state.tracks,
                    progress_state.active_profile,
                    progress_state.eta_range,
                    progress_state.snapshot_fingerprint
             FROM public.analysis_progress_state AS progress_state
             WHERE progress_state.request_id = $1
             FOR UPDATE'
        INTO v_previous_status,
             v_previous_progress_bp,
             v_previous_background_processing,
             v_previous_tracks,
             v_previous_active_profile,
             v_previous_eta_range,
             v_previous_fingerprint
        USING p_request_id;

    IF v_previous_tracks IS NOT NULL
       AND public.analysis_v2_valid_progress_tracks(p_tracks) THEN
        v_canonical_tracks := public.analysis_v2_progress_canonical_tracks(
            v_previous_tracks,
            p_tracks
        );
        v_stage_canonicalized := v_canonical_tracks IS DISTINCT FROM p_tracks;
        v_canonical_progress_bp := CASE
            WHEN p_progress_bp > v_previous_progress_bp THEN p_progress_bp
            ELSE v_previous_progress_bp
        END;
        IF v_canonical_tracks IS NOT DISTINCT FROM v_previous_tracks
           AND v_canonical_progress_bp IS NOT DISTINCT FROM v_previous_progress_bp
           AND v_previous_status IS NOT DISTINCT FROM p_status
           AND v_previous_background_processing IS NOT DISTINCT FROM p_background_processing
           AND v_previous_active_profile IS NOT DISTINCT FROM p_active_profile
           AND v_previous_eta_range IS NOT DISTINCT FROM p_eta_range THEN
            -- Reuse the fingerprint when the full canonical payload is already
            -- durable. Suppress only an event attached to a stage that was
            -- actually rewritten; a current-stage no-op may carry a new event.
            v_effective_fingerprint := v_previous_fingerprint;
            IF v_stage_canonicalized THEN
                v_effective_event := NULL;
                v_effective_event_key := NULL;
            END IF;
        ELSIF v_stage_canonicalized THEN
            /* The caller's fingerprint covers the stale stage. Use a hash of
               the rewritten payload, and never let an event for that stale
               stage enter the durable history. A later canonical retry can
               attach its event against this stored identity. */
            v_effective_fingerprint := public.analysis_v2_progress_snapshot_fingerprint(
                p_status,
                p_background_processing,
                v_canonical_tracks,
                p_active_profile,
                p_eta_range
            );
            v_effective_event := NULL;
            v_effective_event_key := NULL;
        END IF;
    END IF;

    RETURN public.checkpoint_analysis_v2_progress_v1(
        p_request_id,
        p_job_key,
        p_claim_token,
        p_job_input_hash,
        p_status,
        p_progress_bp,
        p_background_processing,
        v_canonical_tracks,
        p_active_profile,
        p_eta_range,
        v_effective_fingerprint,
        v_effective_event,
        v_effective_event_key
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_load_progress_internal(UUID, UUID, BIGINT, INTEGER, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_load_progress_internal(UUID, UUID, BIGINT, INTEGER, BOOLEAN)
    TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_progress(UUID, UUID, BIGINT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_progress(UUID, UUID, BIGINT, INTEGER)
    TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_progress_with_candidate_media(UUID, UUID, BIGINT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_progress_with_candidate_media(UUID, UUID, BIGINT, INTEGER)
    TO service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_progress_stage_rank(TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_progress_merge_track_stage(TEXT, JSONB, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_progress_canonical_tracks(JSONB, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_progress_snapshot_fingerprint(
    TEXT, BOOLEAN, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_progress_v1(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, BOOLEAN, JSONB, JSONB, JSONB, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_progress(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, BOOLEAN, JSONB, JSONB, JSONB, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_progress(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, BOOLEAN, JSONB, JSONB, JSONB, TEXT, JSONB, TEXT
) TO service_role;

COMMIT;
