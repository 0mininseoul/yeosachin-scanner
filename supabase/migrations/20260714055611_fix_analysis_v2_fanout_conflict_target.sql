-- Fix the remaining PL/pgSQL output-column collision in job fan-out.
-- `request_id` is also an OUT parameter, so target the primary-key constraint by name.
CREATE OR REPLACE FUNCTION public.complete_analysis_v2_job_and_fanout(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_successors JSONB DEFAULT '[]'::JSONB
)
RETURNS TABLE(
    request_id UUID,
    completed BOOLEAN,
    job_status TEXT,
    dispatchable_job_keys TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_successor public.analysis_pipeline_jobs%ROWTYPE;
    v_spec JSONB;
    v_job_key TEXT;
    v_track TEXT;
    v_kind TEXT;
    v_batch INTEGER;
    v_input_hash TEXT;
    v_required_keys TEXT[];
    v_fanout_hash TEXT;
    v_was_completed BOOLEAN := FALSE;
    v_dispatchable TEXT[] := '{}'::TEXT[];
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_successors IS NULL
       OR pg_catalog.jsonb_typeof(p_successors) <> 'array'
       OR pg_catalog.jsonb_array_length(p_successors) > 100
       OR pg_catalog.octet_length(p_successors::TEXT) > 65536 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_successors) AS successor(spec)
        GROUP BY successor.spec->>'jobKey'
        HAVING pg_catalog.count(*) > 1
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
    END IF;

    v_fanout_hash := pg_catalog.md5(p_successors::TEXT);

    -- The request row serializes all predecessor completions. The second of two concurrent
    -- completions therefore observes the first commit and opens a join exactly once.
    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_job.status = 'completed' THEN
        IF v_job.completion_token <> p_claim_token
           OR v_job.completion_fanout_hash <> v_fanout_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_FENCE_MISMATCH', ERRCODE = 'P0001';
        END IF;
        v_was_completed := TRUE;
    ELSIF v_job.status = 'processing' THEN
        IF v_request.status NOT IN ('pending', 'processing')
           OR v_job.lease_token <> p_claim_token
           OR v_job.lease_expires_at <= v_now THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
        END IF;

        UPDATE public.analysis_pipeline_jobs AS job
        SET status = 'completed',
            lease_token = NULL,
            lease_expires_at = NULL,
            completion_token = p_claim_token,
            completion_fanout_hash = v_fanout_hash,
            completed_at = v_now,
            updated_at = v_now
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key
        RETURNING job.* INTO v_job;
    ELSE
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_request.status NOT IN ('pending', 'processing') THEN
        RETURN QUERY SELECT
            p_request_id,
            NOT v_was_completed,
            v_job.status::TEXT,
            '{}'::TEXT[];
        RETURN;
    END IF;

    FOR v_spec IN
        SELECT successor.spec
        FROM pg_catalog.jsonb_array_elements(p_successors) AS successor(spec)
    LOOP
        IF pg_catalog.jsonb_typeof(v_spec) <> 'object'
           OR v_spec - ARRAY[
                'jobKey',
                'track',
                'kind',
                'batch',
                'inputHash',
                'requiredJobKeys'
           ]::TEXT[] <> '{}'::JSONB
           OR NOT (v_spec ?& ARRAY['jobKey', 'track', 'kind', 'batch', 'inputHash'])
           OR pg_catalog.jsonb_typeof(v_spec->'jobKey') <> 'string'
           OR pg_catalog.jsonb_typeof(v_spec->'track') <> 'string'
           OR pg_catalog.jsonb_typeof(v_spec->'kind') <> 'string'
           OR pg_catalog.jsonb_typeof(v_spec->'inputHash') <> 'string'
           OR (
                v_spec ? 'requiredJobKeys'
                AND pg_catalog.jsonb_typeof(v_spec->'requiredJobKeys') <> 'array'
           ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
        END IF;

        v_job_key := v_spec->>'jobKey';
        v_track := v_spec->>'track';
        v_kind := v_spec->>'kind';
        v_input_hash := v_spec->>'inputHash';

        IF pg_catalog.char_length(v_job_key) NOT BETWEEN 1 AND 160
           OR v_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
           OR v_job_key = p_job_key
           OR pg_catalog.char_length(v_track) NOT BETWEEN 1 AND 50
           OR v_track !~ '^[a-z][a-z0-9_]{0,49}$'
           OR pg_catalog.char_length(v_kind) NOT BETWEEN 1 AND 50
           OR v_kind !~ '^[a-z][a-z0-9_]{0,49}$'
           OR v_input_hash !~ '^[a-f0-9]{64}$' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
        END IF;

        IF pg_catalog.jsonb_typeof(v_spec->'batch') = 'null' THEN
            v_batch := NULL;
        ELSIF pg_catalog.jsonb_typeof(v_spec->'batch') = 'number'
              AND v_spec->>'batch' ~ '^(0|[1-9][0-9]{0,5})$'
              AND (v_spec->>'batch')::INTEGER BETWEEN 0 AND 100000 THEN
            v_batch := (v_spec->>'batch')::INTEGER;
        ELSE
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
        END IF;

        SELECT COALESCE(
            pg_catalog.array_agg(required_key.value ORDER BY required_key.value),
            '{}'::TEXT[]
        )
        INTO v_required_keys
        FROM pg_catalog.jsonb_array_elements_text(
            COALESCE(v_spec->'requiredJobKeys', '[]'::JSONB)
        ) AS required_key(value);

        IF NOT public.analysis_v2_valid_job_keys(v_required_keys)
           OR v_job_key = ANY(v_required_keys) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_FANOUT_INPUT', ERRCODE = 'P0001';
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(v_required_keys) AS required_key(value)
            LEFT JOIN public.analysis_pipeline_jobs AS required_job
              ON required_job.request_id = p_request_id
             AND required_job.job_key = required_key.value
            WHERE required_job.request_id IS NULL
               OR required_job.status <> 'completed'
        ) THEN
            INSERT INTO public.analysis_pipeline_jobs (
                request_id,
                job_key,
                track,
                kind,
                batch,
                input_hash,
                required_job_keys
            ) VALUES (
                p_request_id,
                v_job_key,
                v_track,
                v_kind,
                v_batch,
                v_input_hash,
                v_required_keys
            )
            ON CONFLICT ON CONSTRAINT analysis_pipeline_jobs_pkey DO NOTHING;

            SELECT successor.*
            INTO v_successor
            FROM public.analysis_pipeline_jobs AS successor
            WHERE successor.request_id = p_request_id
              AND successor.job_key = v_job_key
            FOR UPDATE;

            IF NOT FOUND
               OR v_successor.track <> v_track
               OR v_successor.kind <> v_kind
               OR v_successor.batch IS DISTINCT FROM v_batch
               OR v_successor.input_hash <> v_input_hash
               OR v_successor.required_job_keys <> v_required_keys THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_FANOUT_CONFLICT', ERRCODE = 'P0001';
            END IF;

            IF v_successor.status = 'pending' THEN
                v_dispatchable := pg_catalog.array_append(v_dispatchable, v_job_key);
            END IF;
        END IF;
    END LOOP;

    SELECT COALESCE(
        pg_catalog.array_agg(DISTINCT dispatchable_key.value ORDER BY dispatchable_key.value),
        '{}'::TEXT[]
    )
    INTO v_dispatchable
    FROM pg_catalog.unnest(v_dispatchable) AS dispatchable_key(value);

    RETURN QUERY SELECT
        p_request_id,
        NOT v_was_completed,
        v_job.status::TEXT,
        v_dispatchable;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_job_and_fanout(
    UUID, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_job_and_fanout(
    UUID, TEXT, UUID, JSONB
) TO service_role;

COMMENT ON FUNCTION public.complete_analysis_v2_job_and_fanout(UUID, TEXT, UUID, JSONB) IS
    'Completes under a lease and accepts <=100 strict {jobKey,track,kind,batch,inputHash,requiredJobKeys?} specs; returns ready keys after request-serialized joins.';
