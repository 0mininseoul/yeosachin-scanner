CREATE TABLE public.analysis_v2_active_profile_heartbeats (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    job_input_hash VARCHAR(64) NOT NULL,
    claim_token UUID NOT NULL,
    started_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_count SMALLINT NOT NULL DEFAULT 0,
    total_count SMALLINT NOT NULL,
    masked_username VARCHAR(30) NOT NULL,
    image_url TEXT,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_active_profile_job_hash_check CHECK (
        job_input_hash ~ '^[a-f0-9]{64}$'
    ),
    CONSTRAINT analysis_v2_active_profile_username_check CHECK (
        masked_username ~ '^[A-Za-z0-9._]*\*[A-Za-z0-9._*]*$'
        AND pg_catalog.char_length(masked_username) BETWEEN 1 AND 30
    ),
    CONSTRAINT analysis_v2_active_profile_work_check CHECK (
        total_count BETWEEN 1 AND 30
        AND completed_count BETWEEN 0 AND total_count
    ),
    CONSTRAINT analysis_v2_active_profile_image_check CHECK (
        image_url IS NULL OR (
            pg_catalog.char_length(image_url) BETWEEN 1 AND 2048
            AND image_url LIKE '/api/image-proxy?%'
        )
    )
);

ALTER TABLE public.analysis_v2_active_profile_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_active_profile_heartbeats FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_active_profile_heartbeats
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_started_at TIMESTAMP WITH TIME ZONE,
    p_total_count INTEGER,
    p_masked_username TEXT,
    p_image_url TEXT DEFAULT NULL
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
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^track:(profiles|profile-ai):batch:[0-9]+$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_started_at IS NULL
       OR p_started_at < v_now - INTERVAL '30 minutes'
       OR p_started_at > v_now + INTERVAL '5 minutes'
       OR p_total_count IS NULL
       OR p_total_count NOT BETWEEN 1 AND 30
       OR p_masked_username IS NULL
       OR p_masked_username !~ '^[A-Za-z0-9._]*\*[A-Za-z0-9._*]*$'
       OR pg_catalog.char_length(p_masked_username) NOT BETWEEN 1 AND 30
       OR (
            p_image_url IS NOT NULL
            AND (
                pg_catalog.char_length(p_image_url) NOT BETWEEN 1 AND 2048
                OR p_image_url NOT LIKE '/api/image-proxy?%'
            )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT topology.item_count INTO v_expected_total
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id
      AND topology.topology_kind = 'profile'
      AND topology.batch = pg_catalog.substring(p_job_key, '([0-9]+)$')::INTEGER;
    IF NOT FOUND OR v_expected_total IS DISTINCT FROM p_total_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_TOPOLOGY_MISMATCH', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_active_profile_heartbeats (
        request_id,
        job_key,
        job_input_hash,
        claim_token,
        started_at,
        completed_count,
        total_count,
        masked_username,
        image_url,
        updated_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_job_input_hash,
        p_claim_token,
        p_started_at,
        0,
        p_total_count,
        p_masked_username,
        p_image_url,
        v_now
    )
    ON CONFLICT (request_id, job_key) DO UPDATE
    SET job_input_hash = EXCLUDED.job_input_hash,
        claim_token = EXCLUDED.claim_token,
        started_at = EXCLUDED.started_at,
        completed_count = CASE
            WHEN EXCLUDED.claim_token IS DISTINCT FROM
                public.analysis_v2_active_profile_heartbeats.claim_token THEN 0
            ELSE public.analysis_v2_active_profile_heartbeats.completed_count
        END,
        total_count = EXCLUDED.total_count,
        masked_username = EXCLUDED.masked_username,
        image_url = EXCLUDED.image_url,
        updated_at = EXCLUDED.updated_at
    WHERE EXCLUDED.started_at > public.analysis_v2_active_profile_heartbeats.started_at
       OR (
            EXCLUDED.started_at = public.analysis_v2_active_profile_heartbeats.started_at
            AND EXCLUDED.claim_token
                IS DISTINCT FROM public.analysis_v2_active_profile_heartbeats.claim_token
       )
    RETURNING TRUE INTO v_advanced;

    RETURN COALESCE(v_advanced, FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_progress(
    p_request_id UUID,
    p_user_id UUID,
    p_after_sequence BIGINT DEFAULT 0,
    p_event_limit INTEGER DEFAULT 100
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
    v_snapshot JSONB;
BEGIN
    IF p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_after_sequence IS NULL
       OR p_after_sequence < 0
       OR p_after_sequence > 9007199254740991
       OR p_event_limit IS NULL
       OR p_event_limit < 1
       OR p_event_limit > 200 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROGRESS_INVALID', ERRCODE = 'P0001';
    END IF;

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
        SELECT pg_catalog.jsonb_build_object(
            'maskedUsername', heartbeat.masked_username,
            'imageUrl', heartbeat.image_url
        )
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
    RETURN pg_catalog.jsonb_build_object('snapshot', v_snapshot, 'events', v_events);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT
) TO service_role;
COMMENT ON TABLE public.analysis_v2_active_profile_heartbeats IS
    'Sanitized per-job profile heartbeat; owner reads expose only the latest live label.';
COMMENT ON FUNCTION public.checkpoint_analysis_v2_active_profile_heartbeat(
    UUID, TEXT, UUID, TEXT, TIMESTAMP WITH TIME ZONE, INTEGER, TEXT, TEXT
) IS
    'Persists one masked profile-start heartbeat under the exact live profile job lease.';
