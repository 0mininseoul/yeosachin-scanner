-- The dashboard-editable fixture is deliberately isolated from analysis data.
-- A row is a complete presentation payload, never a partial runtime override.
CREATE TABLE public.demo_analysis_fixtures (
    version TEXT PRIMARY KEY CHECK (version ~ '^operator-editable-fixture-[a-z0-9][a-z0-9._-]{1,99}$'),
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
    payload JSONB NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE public.demo_analysis_fixtures ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.demo_analysis_fixtures FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.demo_analysis_fixtures FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.demo_analysis_fixtures FROM service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.demo_analysis_fixtures TO service_role;

CREATE UNIQUE INDEX demo_analysis_fixtures_one_published
    ON public.demo_analysis_fixtures ((status)) WHERE status = 'published';

CREATE OR REPLACE FUNCTION public.assert_demo_analysis_fixture_payload()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = '' AS $$
DECLARE
    duplicate_count INTEGER;
BEGIN
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
       OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload->'target')) <> 7 THEN
        RAISE EXCEPTION 'demo fixture strict object contract failed';
    END IF;

    IF NOT (NEW.payload->'target' ?& ARRAY['username', 'fullName', 'bio', 'profileImage', 'followersCount', 'followingCount', 'isPrivate'])
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
        SELECT 1
        FROM jsonb_array_elements(NEW.payload->'public') AS account(value)
        WHERE jsonb_typeof(account.value) <> 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(account.value)) <> 11
           OR NOT (account.value ?& ARRAY['instagramId', 'fullName', 'profileImage', 'bio', 'displayScore', 'riskBand', 'featuredRank', 'recentMutualRank', 'analysisDepth', 'oneLineOverview', 'highRiskNarrative'])
           OR account.value->>'profileImage' !~ '^/demo-avatars/demo-v3-female-[0-9]{3}[.]webp$'
    ) OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.payload->'private') AS account(value)
        WHERE jsonb_typeof(account.value) <> 'object'
           OR (SELECT count(*) FROM jsonb_object_keys(account.value)) <> 3
           OR NOT (account.value ?& ARRAY['instagramId', 'fullName', 'profileImage'])
           OR account.value->>'profileImage' !~ '^/demo-avatars/demo-v3-private-[0-9]{3}[.]webp$'
    ) THEN
        RAISE EXCEPTION 'demo fixture account contract failed';
    END IF;

    -- The database contract is intentionally at least as narrow as the DTO
    -- loader: dashboard edits must never create a run that runtime rejects.
    IF jsonb_typeof(NEW.payload->'target'->'fullName') NOT IN ('string', 'null')
       OR jsonb_typeof(NEW.payload->'target'->'bio') NOT IN ('string', 'null')
       OR jsonb_typeof(NEW.payload->'target'->'profileImage') <> 'string'
       OR jsonb_typeof(NEW.payload->'target'->'followersCount') <> 'number'
       OR jsonb_typeof(NEW.payload->'target'->'followingCount') <> 'number'
       OR jsonb_typeof(NEW.payload->'target'->'isPrivate') <> 'boolean'
       OR NEW.payload->'target'->>'followersCount' !~ '^[0-9]+$'
       OR NEW.payload->'target'->>'followingCount' !~ '^[0-9]+$'
       OR length(COALESCE(NEW.payload->'target'->>'fullName', '')) > 200
       OR length(COALESCE(NEW.payload->'target'->>'bio', '')) > 2200 THEN
        RAISE EXCEPTION 'demo fixture target DTO contract failed';
    END IF;

    IF jsonb_typeof(NEW.payload->'summary'->'targetFullName') NOT IN ('string', 'null')
       OR jsonb_typeof(NEW.payload->'summary'->'targetProfileImage') NOT IN ('string', 'null')
       OR NEW.payload->'summary'->>'planId' NOT IN ('basic', 'standard', 'plus')
       OR NEW.payload->'summary'->>'scorePolicyVersion' NOT IN ('risk-policy-v2.2', 'risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5')
       OR jsonb_typeof(NEW.payload->'summary'->'exclusionApplied') <> 'boolean'
       OR jsonb_typeof(NEW.payload->'summary'->'followers') <> 'object'
       OR jsonb_typeof(NEW.payload->'summary'->'following') <> 'object'
       OR jsonb_typeof(NEW.payload->'summary'->'genderStats') <> 'object'
       OR EXISTS (
           SELECT 1 FROM unnest(ARRAY['detectedMutuals', 'publicMutuals', 'privateMutuals', 'screenedMutuals', 'notScreenedMutuals']) AS field(name)
           WHERE jsonb_typeof(NEW.payload->'summary'->field.name) <> 'number'
              OR NEW.payload->'summary'->>field.name !~ '^[0-9]+$'
       ) THEN
        RAISE EXCEPTION 'demo fixture summary DTO contract failed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM unnest(ARRAY['followers', 'following']) AS side(name)
        WHERE NOT (NEW.payload->'summary'->side.name ?& ARRAY['declared', 'collected', 'coverageRatio', 'meetsCoverageGate', 'exactCountMatch'])
           OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload->'summary'->side.name)) <> 5
           OR jsonb_typeof(NEW.payload->'summary'->side.name->'declared') <> 'number'
           OR jsonb_typeof(NEW.payload->'summary'->side.name->'collected') <> 'number'
           OR jsonb_typeof(NEW.payload->'summary'->side.name->'coverageRatio') <> 'number'
           OR jsonb_typeof(NEW.payload->'summary'->side.name->'meetsCoverageGate') <> 'boolean'
           OR jsonb_typeof(NEW.payload->'summary'->side.name->'exactCountMatch') <> 'boolean'
           OR NEW.payload->'summary'->side.name->>'declared' !~ '^[0-9]+$'
           OR NEW.payload->'summary'->side.name->>'collected' !~ '^[0-9]+$'
           OR NEW.payload->'summary'->side.name->>'coverageRatio' !~ '^(0|1|0[.][0-9]+)$'
           OR (NEW.payload->'summary'->side.name->>'meetsCoverageGate') <> 'true'
           OR (NEW.payload->'summary'->side.name->>'coverageRatio')::NUMERIC
              <> CASE WHEN (NEW.payload->'summary'->side.name->>'declared')::NUMERIC = 0 THEN 1
                      ELSE LEAST((NEW.payload->'summary'->side.name->>'collected')::NUMERIC / (NEW.payload->'summary'->side.name->>'declared')::NUMERIC, 1) END
           OR (NEW.payload->'summary'->side.name->>'exactCountMatch')::BOOLEAN
              <> ((NEW.payload->'summary'->side.name->>'collected')::NUMERIC = (NEW.payload->'summary'->side.name->>'declared')::NUMERIC)
    ) OR NOT (NEW.payload->'summary'->'genderStats' ?& ARRAY['male', 'female', 'unknown'])
      OR (SELECT count(*) FROM jsonb_object_keys(NEW.payload->'summary'->'genderStats')) <> 3
      OR EXISTS (
          SELECT 1 FROM unnest(ARRAY['male', 'female', 'unknown']) AS field(name)
          WHERE jsonb_typeof(NEW.payload->'summary'->'genderStats'->field.name) <> 'number'
             OR NEW.payload->'summary'->'genderStats'->>field.name !~ '^[0-9]+$'
      ) THEN
        RAISE EXCEPTION 'demo fixture summary coverage DTO contract failed';
    END IF;

    IF (NEW.payload->'summary'->>'publicMutuals')::INTEGER
           + (NEW.payload->'summary'->>'privateMutuals')::INTEGER
           <> (NEW.payload->'summary'->>'detectedMutuals')::INTEGER
       OR (NEW.payload->'summary'->>'screenedMutuals')::INTEGER
           + (NEW.payload->'summary'->>'notScreenedMutuals')::INTEGER
           <> (NEW.payload->'summary'->>'publicMutuals')::INTEGER
       OR (NEW.payload->'summary'->'genderStats'->>'male')::INTEGER
           + (NEW.payload->'summary'->'genderStats'->>'female')::INTEGER
           + (NEW.payload->'summary'->'genderStats'->>'unknown')::INTEGER
           <> (NEW.payload->'summary'->>'screenedMutuals')::INTEGER
       OR (NEW.payload->'summary'->>'detectedMutuals')::INTEGER > (NEW.payload->'summary'->'followers'->>'collected')::INTEGER
       OR (NEW.payload->'summary'->>'detectedMutuals')::INTEGER > (NEW.payload->'summary'->'following'->>'collected')::INTEGER THEN
        RAISE EXCEPTION 'demo fixture summary consistency contract failed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.payload->'public') AS account(value)
        WHERE jsonb_typeof(account.value->'instagramId') <> 'string'
           OR account.value->>'instagramId' !~ '^[A-Za-z0-9._]{1,30}$'
           OR jsonb_typeof(account.value->'fullName') NOT IN ('string', 'null')
           OR jsonb_typeof(account.value->'bio') NOT IN ('string', 'null')
           OR jsonb_typeof(account.value->'displayScore') <> 'number'
           OR account.value->>'displayScore' !~ '^(10|[1-9]([.][0-9])?)$'
           OR account.value->>'riskBand' NOT IN ('normal', 'caution', 'high_risk')
           OR jsonb_typeof(account.value->'featuredRank') NOT IN ('number', 'null')
           OR jsonb_typeof(account.value->'recentMutualRank') NOT IN ('number', 'null')
           OR account.value->>'analysisDepth' NOT IN ('features', 'narrative')
           OR jsonb_typeof(account.value->'oneLineOverview') <> 'string'
           OR length(account.value->>'oneLineOverview') NOT BETWEEN 1 AND 180
           OR account.value->>'oneLineOverview' !~ '[가-힣]'
           OR account.value->>'oneLineOverview' ~ '[\r\n@]'
           OR length(COALESCE(account.value->>'fullName', '')) > 200
           OR length(COALESCE(account.value->>'bio', '')) > 2200
           OR (jsonb_typeof(account.value->'featuredRank') = 'number' AND account.value->>'featuredRank' !~ '^(10|[1-9])$')
           OR (jsonb_typeof(account.value->'recentMutualRank') = 'number' AND account.value->>'recentMutualRank' !~ '^(10|[1-9])$')
           OR jsonb_typeof(account.value->'highRiskNarrative') NOT IN ('array', 'null')
           OR (jsonb_typeof(account.value->'highRiskNarrative') = 'array' AND (
               jsonb_array_length(account.value->'highRiskNarrative') <> 2
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(account.value->'highRiskNarrative') AS line(value)
                          WHERE jsonb_typeof(line.value) <> 'string'
                             OR length(line.value #>> '{}') NOT BETWEEN 1 AND 180
                             OR (line.value #>> '{}') !~ '[가-힣]'
                             OR (line.value #>> '{}') ~ '[\r\n@]')
           ))
           OR ((account.value->>'riskBand' = 'normal') AND jsonb_typeof(account.value->'featuredRank') <> 'null')
           OR ((account.value->>'riskBand' = 'high_risk') AND jsonb_typeof(account.value->'featuredRank') = 'number' AND (account.value->>'featuredRank')::INTEGER > 3)
           OR ((account.value->>'riskBand' = 'normal' AND (account.value->>'displayScore')::NUMERIC >= 4.2)
               OR (account.value->>'riskBand' = 'caution' AND ((account.value->>'displayScore')::NUMERIC < 4.2 OR (account.value->>'displayScore')::NUMERIC > 6.8))
               OR (account.value->>'riskBand' = 'high_risk' AND (account.value->>'displayScore')::NUMERIC < 6.8))
    ) THEN
        RAISE EXCEPTION 'demo fixture public DTO contract failed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(NEW.payload->'private') AS account(value)
        WHERE jsonb_typeof(account.value->'instagramId') <> 'string'
           OR account.value->>'instagramId' !~ '^[A-Za-z0-9._]{1,30}$'
           OR jsonb_typeof(account.value->'fullName') NOT IN ('string', 'null')
           OR length(COALESCE(account.value->>'fullName', '')) > 200
           OR jsonb_typeof(account.value->'profileImage') <> 'string'
    ) THEN
        RAISE EXCEPTION 'demo fixture private DTO contract failed';
    END IF;

    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT account.value->>'instagramId' AS instagram_id
        FROM jsonb_array_elements(NEW.payload->'public') AS account(value)
        UNION ALL
        SELECT account.value->>'instagramId' AS instagram_id
        FROM jsonb_array_elements(NEW.payload->'private') AS account(value)
    ) AS ids
    GROUP BY instagram_id HAVING instagram_id IS NULL OR COUNT(*) > 1;
    IF duplicate_count > 0 THEN RAISE EXCEPTION 'demo fixture Instagram IDs must be unique'; END IF;

    IF (NEW.payload->'summary'->>'publicMutuals')::INTEGER <> 84
       OR (NEW.payload->'summary'->>'privateMutuals')::INTEGER <> 145
       OR (NEW.payload->'summary'->>'screenedMutuals')::INTEGER <> 84 THEN
        RAISE EXCEPTION 'demo fixture summary count contract failed';
    END IF;
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.prevent_immutable_demo_analysis_fixture()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = '' AS $$
BEGIN
    IF OLD.status = 'published'
       AND TG_OP = 'UPDATE'
       AND NEW.status = 'retired'
       AND NEW.version IS NOT DISTINCT FROM OLD.version
       AND NEW.payload IS NOT DISTINCT FROM OLD.payload
       AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at THEN
        RETURN NEW;
    END IF;
    IF OLD.status IN ('published', 'retired') THEN
        RAISE EXCEPTION 'published and retired demo fixtures are immutable';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER validate_demo_analysis_fixture_payload
    BEFORE INSERT OR UPDATE ON public.demo_analysis_fixtures
    FOR EACH ROW EXECUTE FUNCTION public.assert_demo_analysis_fixture_payload();
CREATE TRIGGER prevent_immutable_demo_analysis_fixture
    BEFORE UPDATE OR DELETE ON public.demo_analysis_fixtures
    FOR EACH ROW EXECUTE FUNCTION public.prevent_immutable_demo_analysis_fixture();

ALTER TABLE public.demo_analysis_runs
    DROP CONSTRAINT IF EXISTS demo_analysis_runs_fixture_version_duration_check;
ALTER TABLE public.demo_analysis_runs
    ADD CONSTRAINT demo_analysis_runs_fixture_version_duration_check CHECK (
        (fixture_version = 'synthetic-fixture-v1' AND duration_seconds BETWEEN 60 AND 90)
        OR (fixture_version IN ('authorized-text-fixture-v2', 'authorized-redacted-fixture-v3', 'authorized-redacted-fixture-v4') AND duration_seconds BETWEEN 30 AND 45)
        OR (fixture_version ~ '^operator-editable-fixture-[a-z0-9][a-z0-9._-]{1,99}$' AND duration_seconds BETWEEN 30 AND 45)
    );

CREATE OR REPLACE FUNCTION public.create_demo_analysis_preflight(
    p_user_id UUID,
    p_target_instagram_id TEXT,
    p_idempotency_key TEXT,
    p_duration_seconds INTEGER
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

REVOKE ALL ON FUNCTION public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_demo_analysis_preflight(UUID, TEXT, TEXT, INTEGER) TO service_role;
