-- Analysis lifecycle analytics is owned by the V2 request ledger.  The table is
-- intentionally separate from browser analytics: Cloud Task retries can claim the
-- same logical event and reuse its stable Amplitude insert_id.
CREATE TABLE public.analysis_lifecycle_events (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE NO ACTION,
    event_name TEXT NOT NULL,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE NO ACTION,
    plan_id TEXT,
    preflight_id UUID,
    error_code TEXT,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL,
    insert_id TEXT NOT NULL UNIQUE,
    delivery_attempts INTEGER NOT NULL DEFAULT 0,
    sent_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, event_name),
    CONSTRAINT analysis_lifecycle_event_name_check CHECK (
        event_name IN ('analysis_started', 'analysis_completed', 'analysis_failed')
    ),
    CONSTRAINT analysis_lifecycle_plan_check CHECK (
        plan_id IS NULL OR plan_id IN ('basic', 'standard', 'plus')
    ),
    CONSTRAINT analysis_lifecycle_error_check CHECK (
        error_code IS NULL OR error_code IN (
            'INTERNAL_ERROR',
            'HANDLE_FORMAT_INVALID',
            'NETWORK_ERROR',
            'NOT_FOUND',
            'TARGET_NOT_FOUND',
            'TARGET_PRIVATE',
            'PLAN_CAPACITY_EXCEEDED',
            'EXCLUSION_RULE_VIOLATION',
            'PROVIDER_ERROR',
            'PROVIDER_TEMPORARY_FAILURE',
            'RATE_LIMITED',
            'TIMEOUT',
            'UNAUTHORIZED',
            'UNKNOWN',
            'VALIDATION_ERROR'
        )
    ),
    CONSTRAINT analysis_lifecycle_attempts_check CHECK (delivery_attempts >= 0)
);

CREATE INDEX analysis_lifecycle_events_occurred_idx
    ON public.analysis_lifecycle_events(event_name, occurred_at);

ALTER TABLE public.analysis_lifecycle_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_lifecycle_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_lifecycle_events TO service_role;

CREATE OR REPLACE FUNCTION public.claim_analysis_lifecycle_event(
    p_request_id UUID,
    p_event_name TEXT,
    p_error_code TEXT DEFAULT NULL
)
RETURNS TABLE (
    request_id UUID,
    event_name TEXT,
    user_id UUID,
    plan_id TEXT,
    preflight_id UUID,
    occurred_at TIMESTAMP WITH TIME ZONE,
    insert_id TEXT,
    duration_ms INTEGER,
    error_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_request RECORD;
    v_event RECORD;
    v_started_at TIMESTAMP WITH TIME ZONE;
    v_occurred_at TIMESTAMP WITH TIME ZONE;
    v_error_code TEXT;
    v_duration_ms INTEGER;
BEGIN
    IF p_event_name NOT IN ('analysis_started', 'analysis_completed', 'analysis_failed') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYTICS_LIFECYCLE_INVALID_EVENT', ERRCODE = 'P0001';
    END IF;

    SELECT
        request.id,
        request.user_id,
        request.selected_plan_id_snapshot,
        request.preflight_id,
        request.created_at
    INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
      AND request.pipeline_version = 'v2';
    IF NOT FOUND THEN
        RETURN;
    END IF;

    v_error_code := CASE
        WHEN p_event_name <> 'analysis_failed' THEN NULL
        WHEN p_error_code IN (
            'INTERNAL_ERROR', 'HANDLE_FORMAT_INVALID', 'NETWORK_ERROR', 'NOT_FOUND',
            'TARGET_NOT_FOUND', 'TARGET_PRIVATE', 'PLAN_CAPACITY_EXCEEDED',
            'EXCLUSION_RULE_VIOLATION', 'PROVIDER_ERROR', 'PROVIDER_TEMPORARY_FAILURE',
            'RATE_LIMITED', 'TIMEOUT', 'UNAUTHORIZED', 'UNKNOWN', 'VALIDATION_ERROR'
        ) THEN p_error_code
        ELSE 'UNKNOWN'
    END;
    v_occurred_at := pg_catalog.clock_timestamp();

    INSERT INTO public.analysis_lifecycle_events (
        request_id,
        event_name,
        user_id,
        plan_id,
        preflight_id,
        error_code,
        occurred_at,
        insert_id
    ) VALUES (
        v_request.id,
        p_event_name,
        v_request.user_id,
        v_request.selected_plan_id_snapshot,
        v_request.preflight_id,
        v_error_code,
        v_occurred_at,
        'analysis:' || v_request.id::TEXT || ':' || p_event_name
    )
    ON CONFLICT (request_id, event_name) DO NOTHING;

    SELECT event.*
    INTO v_event
    FROM public.analysis_lifecycle_events AS event
    WHERE event.request_id = p_request_id
      AND event.event_name = p_event_name
    FOR UPDATE;
    IF NOT FOUND OR v_event.sent_at IS NOT NULL THEN
        RETURN;
    END IF;

    UPDATE public.analysis_lifecycle_events
    SET delivery_attempts = delivery_attempts + 1
    WHERE analysis_lifecycle_events.request_id = p_request_id
      AND analysis_lifecycle_events.event_name = p_event_name;

    SELECT started.occurred_at
    INTO v_started_at
    FROM public.analysis_lifecycle_events AS started
    WHERE started.request_id = p_request_id
      AND started.event_name = 'analysis_started';
    v_duration_ms := LEAST(
        86400000,
        GREATEST(
            0,
            FLOOR(EXTRACT(EPOCH FROM (
                v_event.occurred_at - COALESCE(v_started_at, v_request.created_at)
            )) * 1000)::INTEGER
        )
    );

    RETURN QUERY SELECT
        v_event.request_id,
        v_event.event_name,
        v_event.user_id,
        v_event.plan_id,
        v_event.preflight_id,
        v_event.occurred_at,
        v_event.insert_id,
        v_duration_ms,
        v_event.error_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_analysis_lifecycle_event_sent(
    p_request_id UUID,
    p_event_name TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, extensions
AS $$
    UPDATE public.analysis_lifecycle_events
    SET sent_at = COALESCE(sent_at, pg_catalog.clock_timestamp())
    WHERE request_id = p_request_id
      AND event_name = p_event_name
    RETURNING TRUE;
$$;

REVOKE ALL ON FUNCTION public.claim_analysis_lifecycle_event(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_analysis_lifecycle_event(UUID, TEXT, TEXT)
    TO service_role;
REVOKE ALL ON FUNCTION public.mark_analysis_lifecycle_event_sent(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_analysis_lifecycle_event_sent(UUID, TEXT)
    TO service_role;

COMMENT ON TABLE public.analysis_lifecycle_events IS
    'Idempotent server-owned Amplitude lifecycle intents for analysis_v2; no target or buyer PII.';
