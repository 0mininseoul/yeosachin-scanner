-- Actor abort and cost reconciliation require provider credentials and therefore
-- run in the application before this insert. The database remains the final
-- concurrency guard but must never purge an in-flight provider checkpoint itself.
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

REVOKE ALL ON FUNCTION public.reject_concurrent_analysis_request()
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reject_concurrent_analysis_request()
    TO service_role;

COMMENT ON FUNCTION public.reject_concurrent_analysis_request() IS
    'Rejects concurrent active analyses; stale cleanup is performed by the authenticated start API after provider reconciliation.';
