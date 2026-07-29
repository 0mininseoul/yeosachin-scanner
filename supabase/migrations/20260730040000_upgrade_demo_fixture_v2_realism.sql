-- V1 rows and payloads are immutable historical evidence. V2 is a distinct,
-- operator-published namespace with a server-owned five minute presentation.
ALTER TABLE public.demo_analysis_runs
    DROP CONSTRAINT IF EXISTS demo_analysis_runs_fixture_version_duration_check;
ALTER TABLE public.demo_analysis_runs
    DROP CONSTRAINT IF EXISTS demo_analysis_runs_fixture_version_check;
ALTER TABLE public.demo_analysis_runs
    DROP CONSTRAINT IF EXISTS demo_analysis_runs_duration_seconds_check;
ALTER TABLE public.demo_analysis_runs
    ADD CONSTRAINT demo_analysis_runs_fixture_version_duration_check CHECK (
        (fixture_version = 'synthetic-fixture-v1' AND duration_seconds BETWEEN 60 AND 90)
        OR (fixture_version IN ('authorized-text-fixture-v2', 'authorized-redacted-fixture-v3', 'authorized-redacted-fixture-v4') AND duration_seconds BETWEEN 30 AND 45)
        OR (fixture_version ~ '^operator-editable-fixture-[a-z0-9][a-z0-9._-]{1,99}$'
            AND fixture_version <> 'operator-editable-fixture-v2'
            AND duration_seconds BETWEEN 30 AND 45)
        OR (fixture_version = 'operator-editable-fixture-v2' AND duration_seconds = 300)
    );

-- Accept the historic payload shape for replay, and the new aggregate shape
-- only for V2. Published/retired rows remain guarded by the existing
-- immutability trigger.
CREATE OR REPLACE FUNCTION public.assert_demo_analysis_fixture_payload()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
    duplicate_count INTEGER;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.status = 'published' THEN
        RAISE EXCEPTION 'draft fixtures require the controlled publish procedure';
    END IF;
    IF jsonb_typeof(NEW.payload) <> 'object'
       OR NOT (NEW.payload ? 'target' AND NEW.payload ? 'summary' AND NEW.payload ? 'public' AND NEW.payload ? 'private')
       OR jsonb_typeof(NEW.payload->'target') <> 'object'
       OR jsonb_typeof(NEW.payload->'summary') <> 'object'
       OR jsonb_typeof(NEW.payload->'public') <> 'array'
       OR jsonb_typeof(NEW.payload->'private') <> 'array'
       OR jsonb_array_length(NEW.payload->'public') <> 84
       OR jsonb_array_length(NEW.payload->'private') <> 145 THEN
        RAISE EXCEPTION 'invalid demo fixture payload shape';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(NEW.payload)) <> 4
       OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload->'target')) <> 7
       OR NOT (NEW.payload->'target' ?& ARRAY['username', 'fullName', 'bio', 'profileImage', 'followersCount', 'followingCount', 'isPrivate'])
       OR NOT (NEW.payload->'summary' ?& ARRAY['targetInstagramId', 'targetFullName', 'targetProfileImage', 'planId', 'followers', 'following', 'detectedMutuals', 'publicMutuals', 'privateMutuals', 'screenedMutuals', 'genderStats', 'notScreenedMutuals', 'exclusionApplied', 'scorePolicyVersion'])
       OR NEW.payload->'target'->>'username' <> 'junho_dem'
       OR NEW.payload->'summary'->>'targetInstagramId' <> 'junho_dem'
       OR COALESCE((NEW.payload->'target'->>'isPrivate')::BOOLEAN, TRUE) THEN
        RAISE EXCEPTION 'demo fixture target contract failed';
    END IF;
    IF NEW.payload::TEXT ~ 'https?://' OR NEW.payload::TEXT ~ 'www[.]'
       OR (NEW.payload->'target'->>'profileImage') !~ '^/demo-avatars/demo-v3-target-[0-9]{3}[.]webp$'
       OR (NEW.payload->'summary'->>'targetProfileImage') !~ '^/demo-avatars/demo-v3-target-[0-9]{3}[.]webp$' THEN
        RAISE EXCEPTION 'demo fixture must use only local blurred avatars';
    END IF;
    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.payload->'public') AS account(value)
        WHERE jsonb_typeof(account.value) <> 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(account.value)) <> 11
           OR NOT (account.value ?& ARRAY['instagramId', 'fullName', 'profileImage', 'bio', 'displayScore', 'riskBand', 'featuredRank', 'recentMutualRank', 'analysisDepth', 'oneLineOverview', 'highRiskNarrative'])
           OR account.value->>'profileImage' !~ '^/demo-avatars/demo-v3-female-[0-9]{3}[.]webp$'
    ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.payload->'private') AS account(value)
        WHERE jsonb_typeof(account.value) <> 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(account.value)) <> 3
           OR NOT (account.value ?& ARRAY['instagramId', 'fullName', 'profileImage'])
           OR account.value->>'profileImage' !~ '^/demo-avatars/demo-v3-private-[0-9]{3}[.]webp$'
    ) THEN
        RAISE EXCEPTION 'demo fixture account contract failed';
    END IF;
    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT lower(account.value->>'instagramId') AS instagram_id FROM jsonb_array_elements(NEW.payload->'public') AS account(value)
        UNION ALL
        SELECT lower(account.value->>'instagramId') AS instagram_id FROM jsonb_array_elements(NEW.payload->'private') AS account(value)
    ) AS ids GROUP BY instagram_id HAVING instagram_id IS NULL OR COUNT(*) > 1;
    IF duplicate_count > 0 THEN RAISE EXCEPTION 'demo fixture Instagram IDs must be unique'; END IF;
    IF NEW.version = 'operator-editable-fixture-v2' THEN
        IF NEW.payload->'target'->>'bio' IS NOT NULL
           OR NEW.payload->'summary'->>'detectedMutuals' <> '313'
           OR NEW.payload->'summary'->>'publicMutuals' <> '168'
           OR NEW.payload->'summary'->>'privateMutuals' <> '145'
           OR NEW.payload->'summary'->>'screenedMutuals' <> '168'
           OR NEW.payload->'summary'->>'notScreenedMutuals' <> '0'
           OR NEW.payload->'summary'->'genderStats' <> '{"male": 74, "female": 84, "unknown": 10}'::JSONB
           OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.payload->'public') AS account(value) WHERE account.value->>'bio' IS NOT NULL) THEN
            RAISE EXCEPTION 'demo fixture v2 synthetic count and bio contract failed';
        END IF;
    ELSIF NEW.payload->'summary'->>'publicMutuals' <> '84'
       OR NEW.payload->'summary'->>'privateMutuals' <> '145'
       OR NEW.payload->'summary'->>'screenedMutuals' <> '84' THEN
        RAISE EXCEPTION 'demo fixture summary count contract failed';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

DROP FUNCTION IF EXISTS public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER, TEXT, JSONB);
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
       OR (p_fixture_version = 'operator-editable-fixture-v2' AND p_duration_seconds <> 300)
       OR (p_fixture_version <> 'operator-editable-fixture-v2'
           AND (p_fixture_version !~ '^operator-editable-fixture-[a-z0-9][a-z0-9._-]{1,99}$'
               OR p_duration_seconds NOT BETWEEN 30 AND 45)) THEN
        RAISE EXCEPTION 'invalid database demo run input';
    END IF;
    IF EXISTS (SELECT 1 FROM public.demo_analysis_runs AS run WHERE run.user_id = p_user_id AND run.idempotency_key = p_idempotency_key) THEN
        RETURN QUERY SELECT run.id, run.user_id, run.target_instagram_id, run.fixture_version,
            run.idempotency_key, run.duration_seconds, run.created_at, run.started_at, FALSE
        FROM public.demo_analysis_runs AS run WHERE run.user_id = p_user_id AND run.idempotency_key = p_idempotency_key;
        RETURN;
    END IF;
    SELECT fixture.version INTO v_fixture_version
    FROM public.demo_analysis_fixtures AS fixture
    WHERE fixture.status = 'published' AND fixture.version = p_fixture_version AND fixture.payload = p_fixture_payload
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
