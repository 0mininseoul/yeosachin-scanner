BEGIN;

/*
 * The 20260829120000 wrapper canonicalizes only stageCode before delegating to
 * the historical fenced checkpoint. A stale writer can therefore carry an
 * older done/progress value into the transition validator, and the wrapper
 * passes the stale aggregate progress rather than the canonical calculation.
 * Keep the historical implementation as the final fence, but make this
 * forward migration's canonical boundary merge the complete monotonic track.
 */
CREATE OR REPLACE FUNCTION public.analysis_v2_valid_progress_track(p_track JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_track IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_track) = 'object'
       AND p_track ?& ARRAY['state', 'stageCode', 'done', 'total', 'progressBp']
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_track) AS track_key(value)
            WHERE track_key.value <> ALL (
                ARRAY['state', 'stageCode', 'done', 'total', 'progressBp']
            )
       )
       AND p_track->>'state' IN ('pending', 'running', 'completed', 'failed')
       AND p_track->>'stageCode' ~ '^[A-Z][A-Z0-9_]{0,63}$'
       AND pg_catalog.jsonb_typeof(p_track->'done') = 'number'
       AND p_track->>'done' ~ '^(0|[1-9][0-9]{0,6})$'
       AND (p_track->>'done')::INTEGER BETWEEN 0 AND 1000000
       AND pg_catalog.jsonb_typeof(p_track->'total') = 'number'
       AND p_track->>'total' ~ '^(0|[1-9][0-9]{0,6})$'
       AND (p_track->>'total')::INTEGER BETWEEN 0 AND 1000000
       AND (p_track->>'done')::INTEGER <= (p_track->>'total')::INTEGER
       AND pg_catalog.jsonb_typeof(p_track->'progressBp') = 'number'
       AND p_track->>'progressBp' ~ '^(0|[1-9][0-9]{0,4})$'
       -- A merge may retain an already durable high-water progress value
       -- while totals are extended. It may never exceed the bounded cap or
       -- fall below the progress implied by its own durable counters.
       AND (p_track->>'progressBp')::INTEGER >= CASE
            WHEN (p_track->>'total')::INTEGER = 0 THEN 0
            ELSE pg_catalog.floor(
                (p_track->>'done')::NUMERIC * 10000
                / (p_track->>'total')::NUMERIC
            )::INTEGER
       END
       AND (p_track->>'progressBp')::INTEGER BETWEEN 0 AND 10000
       AND (p_track->>'state' <> 'pending' OR (p_track->>'done')::INTEGER = 0)
       AND (
            p_track->>'state' <> 'completed'
            OR (p_track->>'done')::INTEGER = (p_track->>'total')::INTEGER
       );
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
        -- Unknown stage codes are deliberately fail-closed. Returning the
        -- previous complete track preserves attribution and avoids allowing
        -- an unrecognized caller payload to erase durable progress.
        WHEN public.analysis_v2_progress_stage_rank(
                p_track_id, p_previous->>'stageCode'
             ) < 0
          OR public.analysis_v2_progress_stage_rank(
                p_track_id, p_next->>'stageCode'
             ) < 0
        THEN p_previous
        -- Once a track is terminal, the old transition contract permits only
        -- an exact replay. Do not synthesize a second terminal outcome.
        WHEN p_previous->>'state' IN ('completed', 'failed')
             AND p_next IS DISTINCT FROM p_previous
        THEN p_previous
        ELSE pg_catalog.jsonb_build_object(
            'state', CASE
                WHEN CASE p_next->>'state'
                    WHEN 'pending' THEN 0
                    WHEN 'running' THEN 1
                    WHEN 'completed' THEN 2
                    WHEN 'failed' THEN 2
                    ELSE -1
                END < CASE p_previous->>'state'
                    WHEN 'pending' THEN 0
                    WHEN 'running' THEN 1
                    WHEN 'completed' THEN 2
                    WHEN 'failed' THEN 2
                    ELSE -1
                END THEN p_previous->>'state'
                ELSE p_next->>'state'
            END,
            'stageCode', CASE
                WHEN public.analysis_v2_progress_stage_rank(
                        p_track_id, p_next->>'stageCode'
                     ) < public.analysis_v2_progress_stage_rank(
                        p_track_id, p_previous->>'stageCode'
                     ) THEN p_previous->>'stageCode'
                ELSE p_next->>'stageCode'
            END,
            'done', GREATEST(
                (p_previous->>'done')::INTEGER,
                (p_next->>'done')::INTEGER
            ),
            'total', GREATEST(
                (p_previous->>'total')::INTEGER,
                (p_next->>'total')::INTEGER
            ),
            'progressBp', GREATEST(
                (p_previous->>'progressBp')::INTEGER,
                (p_next->>'progressBp')::INTEGER
            )
        )
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
    SELECT pg_catalog.jsonb_build_object(
        'relationshipAi', public.analysis_v2_progress_merge_track_stage(
            'relationshipAi', p_previous->'relationshipAi', p_next->'relationshipAi'
        ),
        'interactions', public.analysis_v2_progress_merge_track_stage(
            'interactions', p_previous->'interactions', p_next->'interactions'
        ),
        'finalization', public.analysis_v2_progress_merge_track_stage(
            'finalization', p_previous->'finalization', p_next->'finalization'
        )
    );
$$;

/* Rebuild the canonical wrapper so its delegated call receives the exact
 * aggregate calculation for merged tracks. The historical _v1 function still
 * owns request/job/state locks, event idempotence, and terminal transitions. */
CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_progress(
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
    v_previous_background_processing BOOLEAN;
    v_previous_active_profile JSONB;
    v_previous_eta_range JSONB;
    v_previous_fingerprint TEXT;
    v_canonical_tracks JSONB := p_tracks;
    v_canonical_progress_bp INTEGER := p_progress_bp;
    v_track_canonicalized BOOLEAN := FALSE;
    v_effective_fingerprint TEXT := p_snapshot_fingerprint;
    v_effective_event JSONB := p_event;
    v_effective_event_key TEXT := p_event_key;
BEGIN
    EXECUTE 'SELECT 1 FROM public.analysis_preflights AS preflight
             WHERE preflight.consumed_request_id = $1 FOR UPDATE'
        INTO v_lock USING p_request_id;
    EXECUTE 'SELECT 1 FROM public.analysis_requests AS analysis_request
             WHERE analysis_request.id = $1 FOR UPDATE'
        INTO v_lock USING p_request_id;
    EXECUTE 'SELECT 1 FROM public.analysis_pipeline_jobs AS job
             WHERE job.request_id = $1 AND job.job_key = $2 FOR UPDATE'
        INTO v_lock USING p_request_id, p_job_key;
    EXECUTE 'SELECT progress_state.status,
                    progress_state.background_processing,
                    progress_state.tracks,
                    progress_state.active_profile,
                    progress_state.eta_range,
                    progress_state.snapshot_fingerprint
             FROM public.analysis_progress_state AS progress_state
             WHERE progress_state.request_id = $1 FOR UPDATE'
        INTO v_previous_status,
             v_previous_background_processing,
             v_previous_tracks,
             v_previous_active_profile,
             v_previous_eta_range,
             v_previous_fingerprint
        USING p_request_id;

    IF v_previous_tracks IS NOT NULL
       AND public.analysis_v2_valid_progress_tracks(p_tracks) THEN
        v_canonical_tracks := public.analysis_v2_progress_canonical_tracks(
            v_previous_tracks, p_tracks
        );
        v_track_canonicalized := v_canonical_tracks IS DISTINCT FROM p_tracks;
        v_canonical_progress_bp := public.analysis_v2_calculate_progress_bp(
            v_canonical_tracks, p_status
        );
        IF v_canonical_tracks IS NOT DISTINCT FROM v_previous_tracks
           AND v_previous_status IS NOT DISTINCT FROM p_status
           AND v_previous_background_processing IS NOT DISTINCT FROM p_background_processing
           AND v_previous_active_profile IS NOT DISTINCT FROM p_active_profile
           AND v_previous_eta_range IS NOT DISTINCT FROM p_eta_range THEN
            v_effective_fingerprint := v_previous_fingerprint;
            IF v_track_canonicalized THEN
                v_effective_event := NULL;
                v_effective_event_key := NULL;
            END IF;
        ELSIF v_track_canonicalized THEN
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
        v_canonical_progress_bp,
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

COMMIT;
