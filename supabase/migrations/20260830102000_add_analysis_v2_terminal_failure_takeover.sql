BEGIN;

ALTER TABLE public.analysis_v2_provider_cleanup_intents
    ADD COLUMN IF NOT EXISTS terminalization_takeover_at TIMESTAMP WITH TIME ZONE;

/*
 * Keep a crash-window intent authoritative after the original lease expires.
 * The historical claim function terminalized max-attempt jobs directly, which
 * bypassed the intent-owned takeover path on the first redelivery after a
 * worker crash. Patch only that branch so the existing claim/fence contract
 * remains unchanged for every other job.
 */
DO $claim_recovery_patch$
DECLARE
    v_signature CONSTANT TEXT :=
        'public.claim_analysis_v2_job_unfenced_20260811(uuid,text,integer,uuid,uuid,integer,integer)';
    v_definition TEXT;
    v_rewritten TEXT;
    v_anchor CONSTANT TEXT := $old$
    IF v_job.attempt_count >= p_max_attempts THEN
$old$;
    v_replacement CONSTANT TEXT := $new$
    IF v_job.attempt_count >= p_max_attempts
       AND EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_cleanup_intents AS intent
            WHERE intent.request_id = p_request_id
              AND intent.failed_job_key = p_job_key
              AND intent.failed_job_input_hash = v_job.input_hash
              AND intent.completed_at IS NULL
       ) THEN
        -- The durable intent owns terminalization. Return the still-processing
        -- job so the worker can invoke the tightly fenced takeover RPC.
        RETURN QUERY SELECT
            FALSE,
            v_job.status::TEXT,
            v_job.attempt_count,
            v_job.lease_expires_at,
            v_job.track::TEXT,
            v_job.kind::TEXT,
            v_job.batch,
            v_job.input_hash::TEXT;
        RETURN;
    END IF;

    IF v_job.attempt_count >= p_max_attempts THEN
$new$;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        v_signature::pg_catalog.regprocedure
    );
    IF pg_catalog.strpos(v_definition, v_anchor) = 0
       OR (
            pg_catalog.char_length(v_definition)
            - pg_catalog.char_length(
                pg_catalog.replace(v_definition, v_anchor, '')
            )
       ) / pg_catalog.char_length(v_anchor) <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_CLAIM_SHAPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_rewritten := pg_catalog.replace(v_definition, v_anchor, v_replacement);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(
            v_rewritten,
            'intent.failed_job_input_hash = v_job.input_hash'
       ) = 0
       OR pg_catalog.strpos(
            v_rewritten,
            'ANALYSIS_V2_TERMINAL_FAILURE_CLAIM_SHAPE_MISMATCH'
       ) <> 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_CLAIM_REWRITE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    EXECUTE v_rewritten;
END;
$claim_recovery_patch$;

/*
 * A worker can crash after requestCleanup commits but before the failure RPC
 * clears its live job lease. The cleanup intent is then the durable owner of
 * terminalization, and waiting for the old 10-minute lease only delays an
 * idempotent operation. This narrowly fenced RPC transfers that owner to the
 * current delivery without consuming another attempt or opening provider work.
 */
CREATE OR REPLACE FUNCTION public.takeover_analysis_v2_terminal_failure(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 600
)
RETURNS TABLE(
    claimed BOOLEAN,
    job_status TEXT,
    attempt_count INTEGER,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    track TEXT,
    job_kind TEXT,
    batch INTEGER,
    input_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_intent public.analysis_v2_provider_cleanup_intents%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 1000
       OR p_dispatch_token IS NULL
       OR p_claim_token IS NULL
       OR p_lease_seconds IS NULL
       OR p_lease_seconds NOT BETWEEN 30 AND 600 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_INVALID', ERRCODE = 'P0001';
    END IF;

    -- Match the scheduler's canonical lock order. Provider reservations also
    -- take preflight -> request -> job locks, so the active-set proof below
    -- cannot race a new paid start.
    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF v_job.dispatch_generation IS DISTINCT FROM p_dispatch_generation
       OR v_job.dispatch_reservation_token IS DISTINCT FROM p_dispatch_token THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT intent.* INTO v_intent
    FROM public.analysis_v2_provider_cleanup_intents AS intent
    WHERE intent.request_id = p_request_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_intent.completed_at IS NOT NULL
       OR v_intent.failed_job_key IS DISTINCT FROM p_job_key
       OR v_intent.failed_job_input_hash IS DISTINCT FROM v_job.input_hash
       OR v_intent.failed_job_input_hash IS DISTINCT FROM (
            SELECT job.input_hash
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = p_request_id AND job.job_key = p_job_key
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF v_job.status IS DISTINCT FROM 'processing'
       OR v_job.lease_token IS NULL
       OR (
            v_job.lease_token IS DISTINCT FROM v_intent.failed_claim_token
            AND v_job.lease_token IS DISTINCT FROM p_claim_token
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    -- A terminal row is safe. A running row, or a starting row with no
    -- database-owner confirmation that no remote run exists, is not.
    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.status = 'running'
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.status = 'starting'
          AND NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_unconfirmed_start_resolutions AS resolution
                WHERE resolution.reservation_token = provider_run.reservation_token
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_ACTIVE_PROVIDER', ERRCODE = 'P0001';
    END IF;

    -- Repeated delivery by the current owner is a no-op. A competing owner
    -- cannot pass the intent/job fence while the current takeover lease is
    -- live; if that new owner also crashes, its expired lease may be taken
    -- over by the same fenced path.
    IF v_job.lease_token IS DISTINCT FROM p_claim_token
       AND v_intent.terminalization_takeover_at IS NOT NULL
       AND v_job.lease_expires_at > v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_TERMINAL_FAILURE_TAKEOVER_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_job.lease_token IS DISTINCT FROM p_claim_token THEN
        UPDATE public.analysis_pipeline_jobs AS job
        SET lease_token = p_claim_token,
            lease_expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
            updated_at = v_now
        WHERE job.request_id = p_request_id
          AND job.job_key = p_job_key
        RETURNING job.* INTO v_job;
        UPDATE public.analysis_v2_provider_cleanup_intents AS intent
        SET failed_claim_token = p_claim_token
            ,terminalization_takeover_at = v_now
        WHERE intent.request_id = p_request_id;
    END IF;

    RETURN QUERY SELECT
        TRUE,
        v_job.status::TEXT,
        v_job.attempt_count,
        v_job.lease_expires_at,
        v_job.track::TEXT,
        v_job.kind::TEXT,
        v_job.batch,
        v_job.input_hash::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.takeover_analysis_v2_terminal_failure(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.takeover_analysis_v2_terminal_failure(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER
) TO service_role;

COMMENT ON FUNCTION public.takeover_analysis_v2_terminal_failure(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER
) IS 'Atomically resumes intent-owned terminal failure after an owner crash when no active or unconfirmed provider start remains; preserves one current failure owner and does not consume an attempt.';

COMMIT;
