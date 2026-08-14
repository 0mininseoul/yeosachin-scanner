-- A source-backed cohort becomes ready only through the atomic source/cache finalizer. If a
-- PostgREST schema-cache miss hides that finalizer, the ordinary preflight is deliberately
-- ready but has neither durable source nor cache. Return a terminal fallback state instead of
-- advertising a pending inference that cannot ever be claimed.
CREATE OR REPLACE FUNCTION public.read_precheckout_blite_status_v1(p_preflight_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_cache public.precheckout_blite_cache%ROWTYPE;
    v_source_exists BOOLEAN;
BEGIN
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.precheckout_blite_cohort
      AND preflight.status = 'ready'
      AND preflight.pii_scrubbed_at IS NULL
      AND preflight.expires_at > v_now;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT cache.* INTO v_cache
    FROM public.precheckout_blite_cache AS cache
    WHERE cache.preflight_id = v_preflight.id;
    -- The finalizer writes source and cache atomically. Preserve an unusual source-only row so
    -- the existing claim path can repair its cache; only the absent source/cache pair is a
    -- non-runnable schema-cache-miss result that must immediately take the UI fallback.
    IF NOT FOUND THEN
        SELECT EXISTS (
            SELECT 1
            FROM public.precheckout_blite_sources AS source
            WHERE source.preflight_id = v_preflight.id
        ) INTO v_source_exists;
        IF v_source_exists THEN
            RETURN pg_catalog.jsonb_build_object(
                'state', 'pending', 'submittedAt', v_preflight.submitted_at,
                'deadlineAt', v_preflight.deadline_at
            );
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'state', 'failed', 'submittedAt', v_preflight.submitted_at,
            'deadlineAt', v_preflight.deadline_at, 'failedAt', v_now
        );
    END IF;
    IF v_cache.state = 'pending' THEN
        RETURN pg_catalog.jsonb_build_object(
            'state', 'pending', 'submittedAt', v_preflight.submitted_at,
            'deadlineAt', v_preflight.deadline_at
        );
    END IF;
    IF v_cache.state = 'complete' THEN
        RETURN pg_catalog.jsonb_build_object(
            'state', 'complete', 'submittedAt', v_preflight.submitted_at,
            'deadlineAt', v_preflight.deadline_at, 'completedAt', v_cache.completed_at,
            'dto', v_cache.dto
        );
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'state', 'failed', 'submittedAt', v_preflight.submitted_at,
        'deadlineAt', v_preflight.deadline_at, 'failedAt', v_cache.failed_at
    );
END;
$$;
