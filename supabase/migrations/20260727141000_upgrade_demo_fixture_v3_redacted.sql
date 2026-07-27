-- v1/v2 rows stay immutable replay inputs. Only new runs use v3.
ALTER TABLE public.demo_analysis_runs
    DROP CONSTRAINT IF EXISTS demo_analysis_runs_fixture_version_duration_check;
ALTER TABLE public.demo_analysis_runs
    ADD CONSTRAINT demo_analysis_runs_fixture_version_duration_check CHECK (
        (fixture_version = 'synthetic-fixture-v1' AND duration_seconds BETWEEN 60 AND 90)
        OR (fixture_version IN ('authorized-text-fixture-v2', 'authorized-redacted-fixture-v3') AND duration_seconds BETWEEN 30 AND 45)
    );

CREATE OR REPLACE FUNCTION public.create_demo_analysis_preflight(
    p_user_id UUID,
    p_target_instagram_id TEXT,
    p_idempotency_key TEXT,
    p_duration_seconds INTEGER
) RETURNS TABLE (
    id UUID,
    user_id UUID,
    target_instagram_id TEXT,
    fixture_version TEXT,
    idempotency_key TEXT,
    duration_seconds INTEGER,
    created_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE,
    created BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    inserted_count INTEGER := 0;
BEGIN
    IF p_target_instagram_id !~ '^[A-Za-z0-9._]{1,30}$'
        OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
        OR p_duration_seconds NOT BETWEEN 30 AND 45 THEN
        RAISE EXCEPTION 'invalid demo v3 run input';
    END IF;

    INSERT INTO public.demo_analysis_runs (
        user_id,
        target_instagram_id,
        fixture_version,
        plan_id,
        idempotency_key,
        duration_seconds
    ) VALUES (
        p_user_id,
        p_target_instagram_id,
        'authorized-redacted-fixture-v3',
        'standard',
        p_idempotency_key,
        p_duration_seconds
    ) ON CONFLICT ON CONSTRAINT demo_analysis_runs_user_id_idempotency_key_key DO NOTHING;

    GET DIAGNOSTICS inserted_count = ROW_COUNT;

    RETURN QUERY
    SELECT
        demo_run.id,
        demo_run.user_id,
        demo_run.target_instagram_id,
        demo_run.fixture_version,
        demo_run.idempotency_key,
        demo_run.duration_seconds,
        demo_run.created_at,
        demo_run.started_at,
        inserted_count > 0
    FROM public.demo_analysis_runs AS demo_run
    WHERE demo_run.user_id = p_user_id
      AND demo_run.idempotency_key = p_idempotency_key
      AND demo_run.fixture_version = 'authorized-redacted-fixture-v3';
END;
$$;

REVOKE ALL ON FUNCTION public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER)
    TO service_role;
