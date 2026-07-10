-- Cloud Tasks delivery attempts are transport metadata, not a durable count of
-- failures for one logical pipeline state. Keep a bounded, server-only counter
-- on the request so a newly-created task cannot reset the retry budget.
ALTER TABLE public.analysis_requests
    ADD COLUMN retry_state_key TEXT,
    ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE public.analysis_requests
    ADD CONSTRAINT analysis_requests_retry_state_key_check
        CHECK (
            retry_state_key IS NULL
            OR (
                char_length(retry_state_key) BETWEEN 4 AND 128
                AND retry_state_key ~ '^v1:[a-z0-9:_=-]+$'
            )
        ),
    ADD CONSTRAINT analysis_requests_retry_count_check
        CHECK (retry_count BETWEEN 0 AND 1000),
    ADD CONSTRAINT analysis_requests_retry_state_pair_check
        CHECK (
            (retry_state_key IS NULL AND retry_count = 0)
            OR (retry_state_key IS NOT NULL AND retry_count > 0)
        );

CREATE OR REPLACE FUNCTION public.increment_analysis_semantic_retry(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_state_key TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    current_state_key TEXT;
    current_retry_count INTEGER;
    next_retry_count INTEGER;
    state_key_prefix TEXT;
BEGIN
    IF p_expected_step IS NULL
       OR p_expected_step NOT IN (
           'pending',
           'collect',
           'profiles',
           'analyze',
           'interactions',
           'deep_analysis',
           'finalize',
           'gender',
           'features'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_RETRY_INVALID_STEP',
            ERRCODE = '22023';
    END IF;

    state_key_prefix := 'v1:' || p_expected_step;
    IF p_state_key IS NULL
       OR char_length(p_state_key) NOT BETWEEN 4 AND 128
       OR p_state_key !~ '^v1:[a-z0-9:_=-]+$'
       OR NOT (
           p_state_key = state_key_prefix
           OR left(p_state_key, char_length(state_key_prefix) + 1)
               = state_key_prefix || ':'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_RETRY_INVALID_STATE_KEY',
            ERRCODE = '22023';
    END IF;

    SELECT retry_state_key, retry_count
    INTO current_state_key, current_retry_count
    FROM public.analysis_requests
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = p_expected_step
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    next_retry_count := CASE
        WHEN current_state_key = p_state_key
            THEN LEAST(current_retry_count + 1, 1000)
        ELSE 1
    END;

    UPDATE public.analysis_requests
    SET retry_state_key = p_state_key,
        retry_count = next_retry_count
    WHERE id = p_request_id;

    RETURN next_retry_count;
END;
$$;

REVOKE ALL ON FUNCTION public.increment_analysis_semantic_retry(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_analysis_semantic_retry(
    UUID, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON COLUMN public.analysis_requests.retry_state_key IS
    'PII-free logical pipeline cursor whose repeated failures share one retry budget.';
COMMENT ON COLUMN public.analysis_requests.retry_count IS
    'Bounded consecutive failure count for retry_state_key; server-only.';
COMMENT ON FUNCTION public.increment_analysis_semantic_retry(UUID, UUID, TEXT, TEXT) IS
    'Atomically increments or resets the logical pipeline failure count for an active request.';
