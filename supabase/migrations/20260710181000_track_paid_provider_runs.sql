-- Paid Actor runs can outlive a serverless invocation. Reserve an intent before start,
-- then persist the run ID before waiting so retries never start the operation again.
CREATE TABLE public.analysis_provider_runs (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    operation_key TEXT NOT NULL
        CHECK (operation_key ~ '^[a-z0-9:_-]{3,100}$'),
    logical_provider TEXT NOT NULL CHECK (logical_provider IN ('apify', 'coderx')),
    actor_id TEXT NOT NULL CHECK (actor_id ~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'),
    status TEXT NOT NULL CHECK (status IN ('starting', 'running')),
    run_id TEXT CHECK (run_id ~ '^[A-Za-z0-9]{8,64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, operation_key),
    CHECK (
        (status = 'starting' AND run_id IS NULL)
        OR (status = 'running' AND run_id IS NOT NULL)
    )
);

ALTER TABLE public.analysis_provider_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_provider_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.analysis_provider_runs TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_provider_run(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_operation_key TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_operation_key !~ '^[a-z0-9:_-]{3,100}$'
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$' THEN
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_RUN_INVALID';
    END IF;

    PERFORM 1
    FROM public.analysis_requests
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = p_expected_step
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_provider_runs
        WHERE request_id = p_request_id
          AND operation_key = p_operation_key
    ) THEN
        RETURN FALSE;
    END IF;

    INSERT INTO public.analysis_provider_runs (
        request_id,
        operation_key,
        logical_provider,
        actor_id,
        status
    ) VALUES (
        p_request_id,
        p_operation_key,
        p_logical_provider,
        p_actor_id,
        'starting'
    );
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_provider_run(
    p_request_id UUID,
    p_user_id UUID,
    p_expected_step TEXT,
    p_operation_key TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_run_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    affected_rows INTEGER;
BEGIN
    IF p_operation_key !~ '^[a-z0-9:_-]{3,100}$'
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR p_run_id !~ '^[A-Za-z0-9]{8,64}$' THEN
        RAISE EXCEPTION 'ANALYSIS_PROVIDER_RUN_INVALID';
    END IF;

    PERFORM 1
    FROM public.analysis_requests
    WHERE id = p_request_id
      AND user_id = p_user_id
      AND status IN ('pending', 'processing')
      AND COALESCE(current_step, 'pending') = p_expected_step
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    UPDATE public.analysis_provider_runs
    SET status = 'running',
        run_id = p_run_id,
        updated_at = clock_timestamp()
    WHERE request_id = p_request_id
      AND operation_key = p_operation_key
      AND logical_provider = p_logical_provider
      AND actor_id = p_actor_id
      AND status = 'starting'
      AND run_id IS NULL;

    GET DIAGNOSTICS affected_rows = ROW_COUNT;
    RETURN affected_rows = 1;
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_provider_run(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.purge_terminal_analysis_provider_runs()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.status IN ('completed', 'failed') THEN
        DELETE FROM public.analysis_provider_runs
        WHERE request_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS purge_terminal_analysis_provider_runs
    ON public.analysis_requests;
CREATE TRIGGER purge_terminal_analysis_provider_runs
    AFTER UPDATE OF status ON public.analysis_requests
    FOR EACH ROW
    WHEN (NEW.status IN ('completed', 'failed'))
    EXECUTE FUNCTION public.purge_terminal_analysis_provider_runs();

REVOKE ALL ON FUNCTION public.purge_terminal_analysis_provider_runs()
    FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.analysis_provider_runs IS
    'Server-only Apify run checkpoints used to resume billable operations after retries.';
