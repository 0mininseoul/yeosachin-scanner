-- Restore the editable-fixture authority that the v4 forward migration superseded.
ALTER TABLE public.demo_analysis_runs
    DROP CONSTRAINT IF EXISTS demo_analysis_runs_fixture_version_duration_check;
ALTER TABLE public.demo_analysis_runs
    ADD CONSTRAINT demo_analysis_runs_fixture_version_duration_check CHECK (
        (fixture_version = 'synthetic-fixture-v1' AND duration_seconds BETWEEN 60 AND 90)
        OR (fixture_version IN ('authorized-text-fixture-v2', 'authorized-redacted-fixture-v3', 'authorized-redacted-fixture-v4') AND duration_seconds BETWEEN 30 AND 45)
        OR (fixture_version ~ '^operator-editable-fixture-[a-z0-9][a-z0-9._-]{1,99}$' AND duration_seconds BETWEEN 30 AND 45)
    );

DROP FUNCTION IF EXISTS public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER);
CREATE OR REPLACE FUNCTION public.create_demo_analysis_preflight(
    p_user_id UUID,
    p_target_instagram_id TEXT,
    p_idempotency_key TEXT,
    p_duration_seconds INTEGER,
    p_fixture_version TEXT,
    p_fixture_payload JSONB
) RETURNS TABLE (
    id UUID, user_id UUID, target_instagram_id TEXT, fixture_version TEXT,
    idempotency_key TEXT, duration_seconds INTEGER, created_at TIMESTAMP WITH TIME ZONE,
    started_at TIMESTAMP WITH TIME ZONE, created BOOLEAN
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    inserted_count INTEGER := 0;
    v_fixture_version TEXT;
BEGIN
    IF p_target_instagram_id <> 'junho_dem'
       OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
       OR p_duration_seconds NOT BETWEEN 30 AND 45 THEN
        RAISE EXCEPTION 'invalid database demo run input';
    END IF;

    -- Preserve an already-created run even after its source row is retired.
    IF EXISTS (SELECT 1 FROM public.demo_analysis_runs AS run WHERE run.user_id = p_user_id AND run.idempotency_key = p_idempotency_key) THEN
        RETURN QUERY SELECT run.id, run.user_id, run.target_instagram_id, run.fixture_version,
            run.idempotency_key, run.duration_seconds, run.created_at, run.started_at, FALSE
        FROM public.demo_analysis_runs AS run WHERE run.user_id = p_user_id AND run.idempotency_key = p_idempotency_key;
        RETURN;
    END IF;

    SELECT fixture.version INTO v_fixture_version
    FROM public.demo_analysis_fixtures AS fixture
    WHERE fixture.status = 'published'
      AND fixture.version = p_fixture_version
      AND fixture.payload = p_fixture_payload
    FOR SHARE;
    IF v_fixture_version IS NULL THEN RETURN; END IF;

    INSERT INTO public.demo_analysis_runs (user_id, target_instagram_id, fixture_version, plan_id, idempotency_key, duration_seconds)
    VALUES (p_user_id, p_target_instagram_id, v_fixture_version, 'standard', p_idempotency_key, p_duration_seconds)
    ON CONFLICT ON CONSTRAINT demo_analysis_runs_user_id_idempotency_key_key DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    RETURN QUERY SELECT run.id, run.user_id, run.target_instagram_id, run.fixture_version,
        run.idempotency_key, run.duration_seconds, run.created_at, run.started_at, inserted_count > 0
    FROM public.demo_analysis_runs AS run WHERE run.user_id = p_user_id AND run.idempotency_key = p_idempotency_key;
END;
$$;

REVOKE ALL ON FUNCTION public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB) TO service_role;
