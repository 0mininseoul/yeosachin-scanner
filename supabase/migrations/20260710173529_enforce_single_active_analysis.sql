-- Preserve stale requests for history while preventing them from blocking the new active-request
-- invariant. A healthy analysis is expected to finish within minutes.
UPDATE public.analysis_requests
SET status = 'failed',
    current_step = 'failed',
    error_message = 'Analysis expired after remaining active for more than two hours.',
    background_processing = FALSE,
    processing_lease_token = NULL,
    processing_lease_expires_at = NULL
WHERE status IN ('pending', 'processing')
  AND created_at < clock_timestamp() - INTERVAL '2 hours';

-- A fresh database restore can contain multiple recent active rows from before this invariant
-- existed. Keep the newest request deterministically and fail the rest before building the
-- partial unique index.
WITH ranked_active AS (
    SELECT
        id,
        row_number() OVER (
            PARTITION BY user_id
            ORDER BY created_at DESC NULLS LAST, id DESC
        ) AS active_rank
    FROM public.analysis_requests
    WHERE status IN ('pending', 'processing')
)
UPDATE public.analysis_requests AS analysis_request
SET status = 'failed',
    current_step = 'failed',
    error_message = 'Analysis superseded while enforcing one active request per user.',
    background_processing = FALSE,
    step_data = '{}'::JSONB,
    processing_lease_token = NULL,
    processing_lease_expires_at = NULL
FROM ranked_active
WHERE analysis_request.id = ranked_active.id
  AND ranked_active.active_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_requests_one_active_per_user
    ON public.analysis_requests(user_id)
    WHERE status IN ('pending', 'processing');

CREATE OR REPLACE FUNCTION public.reject_concurrent_analysis_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests
        WHERE user_id = NEW.user_id
          AND status IN ('pending', 'processing')
    ) THEN
        RAISE EXCEPTION 'ANALYSIS_ALREADY_IN_PROGRESS';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS reject_concurrent_analysis_request
    ON public.analysis_requests;
CREATE TRIGGER reject_concurrent_analysis_request
    BEFORE INSERT ON public.analysis_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.reject_concurrent_analysis_request();

REVOKE ALL ON FUNCTION public.reject_concurrent_analysis_request()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_concurrent_analysis_request()
    TO service_role;

COMMENT ON INDEX public.idx_analysis_requests_one_active_per_user IS
    'Prevents one account from multiplying paid crawler and AI work concurrently.';
