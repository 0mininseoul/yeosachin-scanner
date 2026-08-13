-- One Apify profile/feed collection supplies both the ready preflight snapshot and the
-- short-lived B-lite evidence. This migration is additive: historical preflights remain
-- outside the cohort and are never assigned a new submission clock retroactively.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_preflights
    ADD COLUMN IF NOT EXISTS precheckout_blite_cohort BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_blite_cohort_clock_check CHECK (
        (NOT precheckout_blite_cohort AND submitted_at IS NULL AND deadline_at IS NULL)
        OR (
            precheckout_blite_cohort
            AND submitted_at = created_at
            AND deadline_at = created_at + INTERVAL '60 seconds'
        )
    );

CREATE OR REPLACE FUNCTION public.enforce_precheckout_blite_preflight_clock_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PRECHECKOUT_BLITE_CREATED_AT_IMMUTABLE', ERRCODE = 'P0001';
        END IF;
        IF OLD.precheckout_blite_cohort THEN
            IF NEW.precheckout_blite_cohort IS DISTINCT FROM TRUE
               OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
               OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_IMMUTABLE', ERRCODE = 'P0001';
            END IF;
        END IF;
    END IF;

    IF NEW.precheckout_blite_cohort THEN
        IF (NEW.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM NEW.created_at)
           OR (NEW.deadline_at IS NOT NULL
               AND NEW.deadline_at IS DISTINCT FROM NEW.created_at + INTERVAL '60 seconds') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_ORIGIN_FORBIDDEN', ERRCODE = 'P0001';
        END IF;
        NEW.submitted_at := NEW.created_at;
        NEW.deadline_at := NEW.created_at + INTERVAL '60 seconds';
    ELSIF NEW.submitted_at IS NOT NULL OR NEW.deadline_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_NON_COHORT_CLOCK_FORBIDDEN', ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_precheckout_blite_preflight_clock ON public.analysis_preflights;
CREATE TRIGGER enforce_precheckout_blite_preflight_clock
BEFORE INSERT OR UPDATE OF precheckout_blite_cohort, submitted_at, deadline_at, created_at
ON public.analysis_preflights
FOR EACH ROW
EXECUTE FUNCTION public.enforce_precheckout_blite_preflight_clock_v1();

REVOKE ALL ON FUNCTION public.enforce_precheckout_blite_preflight_clock_v1()
    FROM PUBLIC, anon, authenticated, service_role;

-- The cohort is chosen only after the ordinary claim fence succeeds, but before any provider
-- work. This keeps its immutable T+60 clock anchored to the original preflight creation time.
CREATE OR REPLACE FUNCTION public.activate_precheckout_blite_cohort_v1(
    p_preflight_id UUID,
    p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.expires_at <= v_now
       OR v_preflight.pii_scrubbed_at IS NOT NULL
       OR v_preflight.created_at + INTERVAL '60 seconds' <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    IF NOT v_preflight.precheckout_blite_cohort THEN
        UPDATE public.analysis_preflights
        SET precheckout_blite_cohort = TRUE,
            updated_at = v_now
        WHERE id = v_preflight.id
        RETURNING * INTO v_preflight;
    END IF;

    IF v_preflight.submitted_at IS NULL
       OR v_preflight.deadline_at IS NULL
       OR v_preflight.deadline_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'submittedAt', v_preflight.submitted_at,
        'deadlineAt', v_preflight.deadline_at,
        'expiresAt', v_preflight.expires_at
    );
END;
$$;

CREATE TABLE public.precheckout_blite_sources (
    preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    schema_version SMALLINT NOT NULL,
    target_input_hash VARCHAR(64) NOT NULL,
    provider_run_id UUID NOT NULL,
    provider_operation_key TEXT NOT NULL,
    provider_run_reference TEXT NOT NULL,
    payload JSONB NOT NULL,
    payload_bytes INTEGER NOT NULL,
    payload_hash VARCHAR(64) NOT NULL,
    collected_at TIMESTAMP WITH TIME ZONE NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT precheckout_blite_sources_schema_check CHECK (schema_version = 1),
    CONSTRAINT precheckout_blite_sources_target_hash_check CHECK (
        target_input_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT precheckout_blite_sources_provider_lineage_fkey FOREIGN KEY (provider_run_id, provider_operation_key)
        REFERENCES public.analysis_preflight_provider_runs(preflight_id, operation_key)
        ON DELETE CASCADE,
    CONSTRAINT precheckout_blite_sources_provider_preflight_check CHECK (
        provider_run_id = preflight_id
    ),
    CONSTRAINT precheckout_blite_sources_provider_operation_check CHECK (
        provider_operation_key = 'target-profile-fallback'
        OR provider_operation_key ~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$'
    ),
    CONSTRAINT precheckout_blite_sources_provider_reference_check CHECK (
        provider_run_reference ~ '^[A-Za-z0-9]{8,64}$'
    ),
    CONSTRAINT precheckout_blite_sources_payload_check CHECK (
        pg_catalog.jsonb_typeof(payload) = 'object'
        AND payload_bytes >= 2
        AND payload_bytes <= 262144
        AND payload_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT precheckout_blite_sources_time_check CHECK (
        expires_at > collected_at
        AND expires_at <= collected_at + INTERVAL '30 minutes'
        AND updated_at >= created_at
    )
);

ALTER TABLE public.precheckout_blite_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.precheckout_blite_sources FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.precheckout_blite_sources FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.precheckout_blite_sources TO service_role;

ALTER TABLE public.precheckout_blite_cache
    ADD COLUMN IF NOT EXISTS attempt_count SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failure_reason TEXT,
    ADD COLUMN IF NOT EXISTS failed_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.precheckout_blite_cache
    DROP CONSTRAINT precheckout_blite_cache_state_check,
    DROP CONSTRAINT precheckout_blite_cache_payload_check,
    DROP CONSTRAINT precheckout_blite_cache_timestamp_check;

ALTER TABLE public.precheckout_blite_cache
    ADD CONSTRAINT precheckout_blite_cache_state_check CHECK (
        state IN ('pending', 'complete', 'failed')
    ),
    ADD CONSTRAINT precheckout_blite_cache_payload_check CHECK (
        (state = 'pending'
            AND dto IS NULL
            AND completed_at IS NULL
            AND failure_reason IS NULL
            AND failed_at IS NULL)
        OR (state = 'complete'
            AND dto IS NOT NULL
            AND pg_catalog.jsonb_typeof(dto) = 'object'
            AND completed_at IS NOT NULL
            AND failure_reason IS NULL
            AND failed_at IS NULL)
        OR (state = 'failed'
            AND dto IS NULL
            AND completed_at IS NULL
            AND failure_reason IS NOT NULL
            AND failed_at IS NOT NULL)
    ),
    ADD CONSTRAINT precheckout_blite_cache_failure_reason_check CHECK (
        failure_reason IS NULL OR (
            pg_catalog.char_length(failure_reason) <= 64
            AND failure_reason IN ('source_missing', 'source_expired', 'source_invalid', 'source_insufficient', 'dispatch_failed', 'inference_timeout', 'inference_rate_limited', 'inference_provider_failed', 'inference_response_invalid', 'persistence_failed', 'attempts_exhausted')
        )
    ),
    ADD CONSTRAINT precheckout_blite_cache_attempt_check CHECK (
        attempt_count BETWEEN 0 AND 2
    ),
    ADD CONSTRAINT precheckout_blite_cache_timestamp_check CHECK (
        updated_at >= created_at
        AND lease_expires_at >= created_at
        AND (completed_at IS NULL OR completed_at >= created_at)
        AND (failed_at IS NULL OR failed_at >= created_at)
    );

ALTER TABLE public.precheckout_blite_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.precheckout_blite_cache FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.precheckout_blite_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.precheckout_blite_cache TO service_role;

CREATE OR REPLACE FUNCTION public.enforce_precheckout_blite_terminal_immutability_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.state IN ('complete', 'failed') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_TERMINAL_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_precheckout_blite_terminal_immutability ON public.precheckout_blite_cache;
CREATE TRIGGER enforce_precheckout_blite_terminal_immutability
BEFORE UPDATE ON public.precheckout_blite_cache
FOR EACH ROW
EXECUTE FUNCTION public.enforce_precheckout_blite_terminal_immutability_v1();

REVOKE ALL ON FUNCTION public.enforce_precheckout_blite_terminal_immutability_v1()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.precheckout_blite_v1_has_exact_keys(
    p_value JSONB,
    p_expected_keys TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_value IS NOT NULL
        AND pg_catalog.jsonb_typeof(p_value) = 'object'
        AND (
            SELECT pg_catalog.count(*)
            FROM pg_catalog.jsonb_object_keys(p_value)
        ) = pg_catalog.array_length(p_expected_keys, 1)
        AND p_value ?& p_expected_keys,
        FALSE
    )
$$;

CREATE OR REPLACE FUNCTION public.precheckout_blite_v1_copy_is_valid(
    p_value TEXT,
    p_max_length INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_value IS NOT NULL
        AND p_value = pg_catalog.btrim(p_value)
        AND pg_catalog.char_length(p_value) BETWEEN 1 AND p_max_length
        AND p_value !~ E'[\\r\\n]'
        AND p_value ~ '[가-힣]'
        AND p_value !~* 'https?://'
        AND p_value !~* 'www[.]'
        AND p_value !~ '@',
        FALSE
    )
$$;

CREATE OR REPLACE FUNCTION public.precheckout_blite_v1_integer_in_range(
    p_value JSONB,
    p_minimum NUMERIC,
    p_maximum NUMERIC
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_number NUMERIC;
BEGIN
    IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN
        RETURN FALSE;
    END IF;
    v_number := (p_value #>> '{}')::NUMERIC;
    RETURN v_number = pg_catalog.trunc(v_number)
       AND v_number BETWEEN p_minimum AND p_maximum;
EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.precheckout_blite_v1_confidence_is_valid(
    p_value JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_number NUMERIC;
BEGIN
    IF pg_catalog.jsonb_typeof(p_value) IS DISTINCT FROM 'number' THEN
        RETURN FALSE;
    END IF;
    v_number := (p_value #>> '{}')::NUMERIC;
    RETURN v_number BETWEEN 0 AND 1
       AND v_number = pg_catalog.round(v_number, 2);
EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.precheckout_blite_v1_dto_is_valid(
    p_dto JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_value JSONB;
    v_reason JSONB;
    v_field JSONB;
    v_candidate_min NUMERIC;
    v_candidate_max NUMERIC;
    v_confidence NUMERIC;
    v_band TEXT;
    v_all_high BOOLEAN := TRUE;
    v_seen_fields TEXT[] := ARRAY[]::TEXT[];
    v_field_name TEXT;
BEGIN
    IF public.precheckout_blite_v1_has_exact_keys(
        p_dto,
        ARRAY['schemaVersion', 'persona', 'signals', 'candidateRange', 'genderRead', 'postCount', 'evidenceFields']
    ) IS DISTINCT FROM TRUE
       OR public.precheckout_blite_v1_integer_in_range(p_dto->'schemaVersion', 1, 1)
            IS DISTINCT FROM TRUE THEN
        RETURN FALSE;
    END IF;

    IF public.precheckout_blite_v1_has_exact_keys(
        p_dto->'persona', ARRAY['headline', 'summary']
    ) IS DISTINCT FROM TRUE
       OR pg_catalog.jsonb_typeof(p_dto->'persona'->'headline') IS DISTINCT FROM 'string'
       OR pg_catalog.jsonb_typeof(p_dto->'persona'->'summary') IS DISTINCT FROM 'string'
       OR public.precheckout_blite_v1_copy_is_valid(p_dto->'persona'->>'headline', 80)
            IS DISTINCT FROM TRUE
       OR public.precheckout_blite_v1_copy_is_valid(p_dto->'persona'->>'summary', 400)
            IS DISTINCT FROM TRUE THEN
        RETURN FALSE;
    END IF;

    IF pg_catalog.jsonb_typeof(p_dto->'signals') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(p_dto->'signals') <> 4 THEN
        RETURN FALSE;
    END IF;
    FOR v_value IN
        SELECT signal.value
        FROM pg_catalog.jsonb_array_elements(p_dto->'signals') AS signal(value)
    LOOP
        IF public.precheckout_blite_v1_has_exact_keys(
            v_value, ARRAY['claim', 'category', 'confidence', 'band']
        ) IS DISTINCT FROM TRUE
           OR pg_catalog.jsonb_typeof(v_value->'claim') IS DISTINCT FROM 'string'
           OR pg_catalog.jsonb_typeof(v_value->'category') IS DISTINCT FROM 'string'
           OR pg_catalog.jsonb_typeof(v_value->'band') IS DISTINCT FROM 'string'
           OR public.precheckout_blite_v1_copy_is_valid(v_value->>'claim', 120)
                IS DISTINCT FROM TRUE
           OR public.precheckout_blite_v1_copy_is_valid(v_value->>'category', 24)
                IS DISTINCT FROM TRUE
           OR public.precheckout_blite_v1_confidence_is_valid(v_value->'confidence')
                IS DISTINCT FROM TRUE THEN
            RETURN FALSE;
        END IF;
        v_confidence := (v_value->'confidence' #>> '{}')::NUMERIC;
        v_band := v_value->>'band';
        IF v_band IS DISTINCT FROM (
            CASE
                WHEN v_confidence >= 0.7 THEN 'high'
                WHEN v_confidence >= 0.5 THEN 'medium'
                ELSE 'low'
            END
        ) THEN
            RETURN FALSE;
        END IF;
        IF v_band <> 'high' THEN
            v_all_high := FALSE;
        END IF;
    END LOOP;
    IF v_all_high THEN
        RETURN FALSE;
    END IF;

    IF public.precheckout_blite_v1_has_exact_keys(
        p_dto->'candidateRange', ARRAY['min', 'max']
    ) IS DISTINCT FROM TRUE
       OR public.precheckout_blite_v1_integer_in_range(
            p_dto->'candidateRange'->'min', 0, 1000000000
       ) IS DISTINCT FROM TRUE
       OR public.precheckout_blite_v1_integer_in_range(
            p_dto->'candidateRange'->'max', 0, 1000000000
       ) IS DISTINCT FROM TRUE THEN
        RETURN FALSE;
    END IF;
    v_candidate_min := (p_dto->'candidateRange'->'min' #>> '{}')::NUMERIC;
    v_candidate_max := (p_dto->'candidateRange'->'max' #>> '{}')::NUMERIC;
    IF v_candidate_min >= v_candidate_max THEN
        RETURN FALSE;
    END IF;

    IF public.precheckout_blite_v1_has_exact_keys(
        p_dto->'genderRead', ARRAY['likelyFemale', 'confidence', 'reasons']
    ) IS DISTINCT FROM TRUE
       OR pg_catalog.jsonb_typeof(p_dto->'genderRead'->'likelyFemale') IS DISTINCT FROM 'boolean'
       OR public.precheckout_blite_v1_confidence_is_valid(p_dto->'genderRead'->'confidence')
            IS DISTINCT FROM TRUE
       OR pg_catalog.jsonb_typeof(p_dto->'genderRead'->'reasons') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(p_dto->'genderRead'->'reasons') <> 3 THEN
        RETURN FALSE;
    END IF;
    FOR v_reason IN
        SELECT reason.value
        FROM pg_catalog.jsonb_array_elements(p_dto->'genderRead'->'reasons') AS reason(value)
    LOOP
        IF pg_catalog.jsonb_typeof(v_reason) IS DISTINCT FROM 'string'
           OR public.precheckout_blite_v1_copy_is_valid(v_reason #>> '{}', 90)
                IS DISTINCT FROM TRUE THEN
            RETURN FALSE;
        END IF;
    END LOOP;

    IF public.precheckout_blite_v1_integer_in_range(p_dto->'postCount', 0, 100)
        IS DISTINCT FROM TRUE
       OR pg_catalog.jsonb_typeof(p_dto->'evidenceFields') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(p_dto->'evidenceFields') NOT BETWEEN 1 AND 15 THEN
        RETURN FALSE;
    END IF;
    FOR v_field IN
        SELECT field.value
        FROM pg_catalog.jsonb_array_elements(p_dto->'evidenceFields') AS field(value)
    LOOP
        IF pg_catalog.jsonb_typeof(v_field) IS DISTINCT FROM 'string' THEN
            RETURN FALSE;
        END IF;
        v_field_name := v_field #>> '{}';
        IF v_field_name NOT IN (
            'post.caption', 'post.hashtags', 'post.type', 'post.mediaItems',
            'post.declaredMediaCount', 'post.likesCount', 'post.commentsCount',
            'post.likesCountHidden', 'post.commentsCountHidden', 'post.taggedUsers',
            'post.mentionedUsers', 'post.imageUrl', 'post.thumbnailUrl',
            'profile.fullName', 'profile.profilePicUrl'
        ) OR v_field_name = ANY(v_seen_fields) THEN
            RETURN FALSE;
        END IF;
        v_seen_fields := pg_catalog.array_append(v_seen_fields, v_field_name);
    END LOOP;

    RETURN TRUE;
EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN FALSE;
END;
$$;

-- This finalizer keeps the existing ready-snapshot validation as the source of truth, but
-- performs it and the source/cache write in one transaction. It supports both current
-- authenticated and anonymous claim fences without putting either claim token in the payload.
CREATE OR REPLACE FUNCTION public.finalize_preflight_blite_source_v1(
    p_preflight_id UUID,
    p_user_id UUID,
    p_claim_token UUID,
    p_target_input_hash VARCHAR,
    p_provider_run_id UUID,
    p_provider_operation_key TEXT,
    p_provider_run_reference TEXT,
    p_target_full_name TEXT,
    p_target_bio TEXT,
    p_target_profile_image_url TEXT,
    p_target_followers_count INTEGER,
    p_target_following_count INTEGER,
    p_target_is_private BOOLEAN,
    p_capacity_required_plan_id TEXT,
    p_required_plan_id TEXT,
    p_plan_cards_snapshot JSONB,
    p_payload JSONB,
    p_payload_hash VARCHAR,
    p_collected_at TIMESTAMP WITH TIME ZONE,
    p_expires_at TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_provider_run public.analysis_preflight_provider_runs%ROWTYPE;
    v_source public.precheckout_blite_sources%ROWTYPE;
    v_payload_bytes INTEGER;
    v_payload_hash VARCHAR(64);
    v_completed BOOLEAN;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_target_input_hash IS NULL
       OR p_target_input_hash !~ '^[0-9a-f]{64}$'
       OR p_provider_run_id IS NULL
       OR p_provider_run_id IS DISTINCT FROM p_preflight_id
       OR p_provider_operation_key IS NULL
       OR NOT (
            p_provider_operation_key = 'target-profile-fallback'
            OR p_provider_operation_key ~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$'
       )
       OR p_provider_run_reference IS NULL
       OR p_provider_run_reference !~ '^[A-Za-z0-9]{8,64}$'
       OR p_payload IS NULL
       OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_payload_hash IS NULL
       OR p_payload_hash !~ '^[0-9a-f]{64}$'
       OR p_collected_at IS NULL
       OR p_expires_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_SOURCE_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR NOT v_preflight.precheckout_blite_cohort
       OR v_preflight.pii_scrubbed_at IS NOT NULL
       OR v_preflight.submitted_at IS NULL
       OR v_preflight.deadline_at IS NULL
       OR NOT (v_preflight.deadline_at > v_now)
       OR v_preflight.target_input_hash IS DISTINCT FROM p_target_input_hash
       OR v_preflight.user_id IS DISTINCT FROM p_user_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    IF p_expires_at > v_preflight.expires_at
       OR p_expires_at > p_collected_at + INTERVAL '30 minutes'
       OR p_expires_at <> LEAST(
            p_collected_at + INTERVAL '30 minutes',
            v_preflight.expires_at
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_SOURCE_EXPIRY_INVALID', ERRCODE = 'P0001';
    END IF;

    v_payload_bytes := pg_catalog.octet_length(
        pg_catalog.convert_to(p_payload::TEXT, 'UTF8')
    );
    IF v_payload_bytes > 262144 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_SOURCE_TOO_LARGE', ERRCODE = 'P0001';
    END IF;
    v_payload_hash := pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(p_payload::TEXT, 'UTF8'), 'sha256'),
        'hex'
    );

    SELECT provider_run.* INTO v_provider_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = v_preflight.id
      AND provider_run.operation_key = p_provider_operation_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_provider_run.input_hash IS DISTINCT FROM p_target_input_hash
       OR v_provider_run.logical_provider IS DISTINCT FROM 'apify'
       OR v_provider_run.status IS DISTINCT FROM 'succeeded'
       OR p_provider_run_id IS DISTINCT FROM v_provider_run.preflight_id
       OR p_provider_run_reference IS DISTINCT FROM v_provider_run.run_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PROVIDER_LINEAGE_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT source.* INTO v_source
    FROM public.precheckout_blite_sources AS source
    WHERE source.preflight_id = v_preflight.id
    FOR UPDATE;
    IF FOUND THEN
        IF v_source.schema_version = 1
           AND v_source.target_input_hash = p_target_input_hash
           AND v_source.provider_run_id = p_provider_run_id
           AND v_source.provider_operation_key = p_provider_operation_key
           AND v_source.provider_run_reference = p_provider_run_reference
           AND v_source.payload_hash = v_payload_hash
           AND v_source.collected_at = p_collected_at
           AND v_source.expires_at = p_expires_at
           AND v_preflight.status = 'ready' THEN
            RETURN FALSE;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_SOURCE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    -- Provider/source lock waits consume the same deadline as work execution.
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.deadline_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.user_id IS NULL THEN
        v_completed := public.complete_anonymous_analysis_v2_preflight(
            p_preflight_id, p_claim_token,
            p_target_full_name, p_target_bio, p_target_profile_image_url,
            p_target_followers_count, p_target_following_count, p_target_is_private,
            p_capacity_required_plan_id, p_required_plan_id, p_plan_cards_snapshot
        );
    ELSE
        v_completed := public.complete_analysis_v2_preflight(
            p_preflight_id, p_user_id, p_claim_token,
            p_target_full_name, p_target_bio, p_target_profile_image_url,
            p_target_followers_count, p_target_following_count, p_target_is_private,
            p_capacity_required_plan_id, p_required_plan_id, p_plan_cards_snapshot
        );
    END IF;
    IF NOT v_completed THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_READY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.precheckout_blite_sources (
        preflight_id, schema_version, target_input_hash, provider_run_id,
        provider_operation_key, provider_run_reference, payload, payload_bytes, payload_hash,
        collected_at, expires_at, created_at, updated_at
    ) VALUES (
        v_preflight.id, 1, p_target_input_hash, p_provider_run_id,
        p_provider_operation_key, p_provider_run_reference, p_payload, v_payload_bytes, v_payload_hash,
        p_collected_at, p_expires_at, v_now, v_now
    );

    INSERT INTO public.precheckout_blite_cache (
        preflight_id, state, lease_token, lease_expires_at,
        attempt_count, created_at, updated_at
    ) VALUES (
        v_preflight.id, 'pending', extensions.gen_random_uuid(), v_now,
        0, v_now, v_now
    ) ON CONFLICT (preflight_id) DO NOTHING;

    RETURN TRUE;
END;
$$;

-- Named wrappers are the only completion entry points for the cohort path. Existing callers
-- remain untouched; Track C selects these before the provider starts.
CREATE OR REPLACE FUNCTION public.complete_analysis_v2_preflight_with_blite_source_v1(
    p_preflight_id UUID, p_user_id UUID, p_claim_token UUID,
    p_target_input_hash VARCHAR, p_provider_run_id UUID, p_provider_operation_key TEXT,
    p_provider_run_reference TEXT,
    p_target_full_name TEXT, p_target_bio TEXT, p_target_profile_image_url TEXT,
    p_target_followers_count INTEGER, p_target_following_count INTEGER,
    p_target_is_private BOOLEAN, p_capacity_required_plan_id TEXT,
    p_required_plan_id TEXT, p_plan_cards_snapshot JSONB, p_payload JSONB,
    p_payload_hash VARCHAR, p_collected_at TIMESTAMP WITH TIME ZONE,
    p_expires_at TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_FENCE_LOST', ERRCODE = 'P0001';
    END IF;
    RETURN public.finalize_preflight_blite_source_v1(
        p_preflight_id, p_user_id, p_claim_token, p_target_input_hash,
        p_provider_run_id, p_provider_operation_key, p_provider_run_reference,
        p_target_full_name, p_target_bio,
        p_target_profile_image_url, p_target_followers_count, p_target_following_count,
        p_target_is_private, p_capacity_required_plan_id, p_required_plan_id,
        p_plan_cards_snapshot, p_payload, p_payload_hash, p_collected_at, p_expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_anonymous_analysis_v2_preflight_with_blite_source_v1(
    p_preflight_id UUID, p_claim_token UUID, p_target_input_hash VARCHAR,
    p_provider_run_id UUID, p_provider_operation_key TEXT, p_provider_run_reference TEXT,
    p_target_full_name TEXT,
    p_target_bio TEXT, p_target_profile_image_url TEXT, p_target_followers_count INTEGER,
    p_target_following_count INTEGER, p_target_is_private BOOLEAN,
    p_capacity_required_plan_id TEXT, p_required_plan_id TEXT,
    p_plan_cards_snapshot JSONB, p_payload JSONB, p_payload_hash VARCHAR,
    p_collected_at TIMESTAMP WITH TIME ZONE, p_expires_at TIMESTAMP WITH TIME ZONE
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RETURN public.finalize_preflight_blite_source_v1(
        p_preflight_id, NULL, p_claim_token, p_target_input_hash,
        p_provider_run_id, p_provider_operation_key, p_provider_run_reference,
        p_target_full_name, p_target_bio,
        p_target_profile_image_url, p_target_followers_count, p_target_following_count,
        p_target_is_private, p_capacity_required_plan_id, p_required_plan_id,
        p_plan_cards_snapshot, p_payload, p_payload_hash, p_collected_at, p_expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_precheckout_blite_v2(p_preflight_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease UUID := extensions.gen_random_uuid();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_source public.precheckout_blite_sources%ROWTYPE;
    v_cache public.precheckout_blite_cache%ROWTYPE;
    v_reason TEXT;
BEGIN
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR NOT v_preflight.precheckout_blite_cohort
       OR v_preflight.status <> 'ready'
       OR v_preflight.ready_at IS NULL
       OR v_preflight.pii_scrubbed_at IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.deadline_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    SELECT cache.* INTO v_cache
    FROM public.precheckout_blite_cache AS cache
    WHERE cache.preflight_id = v_preflight.id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND THEN
        INSERT INTO public.precheckout_blite_cache (
            preflight_id, state, lease_token, lease_expires_at,
            attempt_count, created_at, updated_at
        ) VALUES (
            v_preflight.id, 'pending', v_lease, v_now,
            0, v_now, v_now
        ) RETURNING * INTO v_cache;
    END IF;

    IF v_cache.state = 'complete' THEN
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'complete', 'dto', v_cache.dto,
            'completedAt', v_cache.completed_at
        );
    END IF;
    IF v_cache.state = 'failed' THEN
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'failed', 'reason', v_cache.failure_reason,
            'failedAt', v_cache.failed_at
        );
    END IF;

    SELECT source.* INTO v_source
    FROM public.precheckout_blite_sources AS source
    WHERE source.preflight_id = v_preflight.id
    FOR UPDATE;

    -- Evaluate expiry/deadline only after every row-lock wait has completed.
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF NOT FOUND THEN
        v_reason := 'source_missing';
    ELSIF NOT (v_source.expires_at > v_now) THEN
        v_reason := 'source_expired';
    ELSIF v_source.target_input_hash IS DISTINCT FROM v_preflight.target_input_hash
       OR v_source.provider_run_id IS DISTINCT FROM v_preflight.id
       OR v_source.payload_bytes > 262144
       OR pg_catalog.jsonb_typeof(v_source.payload) <> 'object' THEN
        v_reason := 'source_invalid';
    ELSIF NOT (v_preflight.deadline_at - INTERVAL '4 seconds' > v_now) THEN
        v_reason := 'inference_timeout';
    ELSIF v_cache.attempt_count >= 2 THEN
        v_reason := 'attempts_exhausted';
    ELSE
        v_reason := NULL;
    END IF;

    IF v_reason IS NOT NULL THEN
        UPDATE public.precheckout_blite_cache
        SET state = 'failed', failure_reason = v_reason, failed_at = v_now,
            updated_at = v_now
        WHERE preflight_id = v_preflight.id
          AND state = 'pending';
        DELETE FROM public.precheckout_blite_sources
        WHERE preflight_id = v_preflight.id;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'failed', 'reason', v_reason, 'failedAt', v_now
        );
    END IF;

    IF v_cache.lease_expires_at > v_now THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'pending');
    END IF;

    UPDATE public.precheckout_blite_cache
    SET lease_token = v_lease,
        lease_expires_at = v_now + INTERVAL '2 minutes',
        attempt_count = v_cache.attempt_count + 1,
        updated_at = v_now
    WHERE preflight_id = v_preflight.id
      AND state = 'pending'
      AND lease_token = v_cache.lease_token
      AND lease_expires_at <= v_now
      AND attempt_count < 2;
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'pending');
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'claimed', 'leaseToken', v_lease,
        'source', v_source.payload,
        'submittedAt', v_preflight.submitted_at,
        'deadlineAt', v_preflight.deadline_at,
        'followersCount', v_preflight.target_followers_count,
        'followingCount', v_preflight.target_following_count
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_precheckout_blite_v2(
    p_preflight_id UUID,
    p_lease_token UUID,
    p_dto JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_cache public.precheckout_blite_cache%ROWTYPE;
    v_source public.precheckout_blite_sources%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_lease_token IS NULL
       OR p_dto IS NULL
       OR public.precheckout_blite_v1_dto_is_valid(p_dto) IS DISTINCT FROM TRUE THEN
        RETURN FALSE;
    END IF;

    -- Every lifecycle path takes these locks in parent -> cache -> source order.
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR NOT v_preflight.precheckout_blite_cohort
       OR v_preflight.status <> 'ready'
       OR v_preflight.pii_scrubbed_at IS NOT NULL
       OR v_preflight.deadline_at IS NULL THEN
        RETURN FALSE;
    END IF;

    SELECT cache.* INTO v_cache
    FROM public.precheckout_blite_cache AS cache
    WHERE cache.preflight_id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_cache.state <> 'pending'
       OR v_cache.lease_token IS DISTINCT FROM p_lease_token
       OR v_cache.lease_expires_at <= v_now THEN
        RETURN FALSE;
    END IF;

    SELECT source.* INTO v_source
    FROM public.precheckout_blite_sources AS source
    WHERE source.preflight_id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND THEN
        UPDATE public.precheckout_blite_cache
        SET state = 'failed', failure_reason = 'source_missing', failed_at = v_now,
            updated_at = v_now
        WHERE preflight_id = p_preflight_id
          AND state = 'pending'
          AND lease_token = p_lease_token
          AND lease_expires_at > v_now;
        RETURN FALSE;
    END IF;

    IF v_source.expires_at <= v_now THEN
        UPDATE public.precheckout_blite_cache
        SET state = 'failed', failure_reason = 'source_expired', failed_at = v_now,
            updated_at = v_now
        WHERE preflight_id = p_preflight_id
          AND state = 'pending'
          AND lease_token = p_lease_token
          AND lease_expires_at > v_now;
        DELETE FROM public.precheckout_blite_sources
        WHERE preflight_id = p_preflight_id;
        RETURN FALSE;
    END IF;

    IF v_source.target_input_hash IS DISTINCT FROM v_preflight.target_input_hash
       OR v_source.provider_run_id IS DISTINCT FROM v_preflight.id
       OR v_source.payload_bytes > 262144
       OR pg_catalog.jsonb_typeof(v_source.payload) <> 'object' THEN
        UPDATE public.precheckout_blite_cache
        SET state = 'failed', failure_reason = 'source_invalid', failed_at = v_now,
            updated_at = v_now
        WHERE preflight_id = p_preflight_id
          AND state = 'pending'
          AND lease_token = p_lease_token
          AND lease_expires_at > v_now;
        DELETE FROM public.precheckout_blite_sources
        WHERE preflight_id = p_preflight_id;
        RETURN FALSE;
    END IF;

    -- A two-minute crash lease does not extend the shared T+56 inference cutoff.
    IF NOT (v_preflight.deadline_at - INTERVAL '4 seconds' > v_now) THEN
        UPDATE public.precheckout_blite_cache
        SET state = 'failed', failure_reason = 'inference_timeout', failed_at = v_now,
            updated_at = v_now
        WHERE preflight_id = p_preflight_id
          AND state = 'pending'
          AND lease_token = p_lease_token
          AND lease_expires_at > v_now;
        DELETE FROM public.precheckout_blite_sources
        WHERE preflight_id = p_preflight_id;
        RETURN FALSE;
    END IF;

    UPDATE public.precheckout_blite_cache
    SET state = 'complete', dto = p_dto, completed_at = v_now,
        updated_at = v_now
    WHERE preflight_id = p_preflight_id
      AND state = 'pending'
      AND lease_token = p_lease_token
      AND lease_expires_at > v_now;
    IF NOT FOUND THEN RETURN FALSE; END IF;

    DELETE FROM public.precheckout_blite_sources
    WHERE preflight_id = p_preflight_id;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.fail_precheckout_blite_v2(
    p_preflight_id UUID,
    p_lease_token UUID,
    p_reason TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_cache public.precheckout_blite_cache%ROWTYPE;
    v_source public.precheckout_blite_sources%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_lease_token IS NULL
       OR p_reason IS NULL
       OR p_reason NOT IN ('source_missing', 'source_expired', 'source_invalid', 'source_insufficient', 'dispatch_failed', 'inference_timeout', 'inference_rate_limited', 'inference_provider_failed', 'inference_response_invalid', 'persistence_failed', 'attempts_exhausted') THEN
        RETURN FALSE;
    END IF;

    -- Failure remains available after the deadline to clean up a valid current lease.
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR NOT v_preflight.precheckout_blite_cohort
       OR v_preflight.pii_scrubbed_at IS NOT NULL THEN
        RETURN FALSE;
    END IF;

    SELECT cache.* INTO v_cache
    FROM public.precheckout_blite_cache AS cache
    WHERE cache.preflight_id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND
       OR v_cache.state <> 'pending'
       OR v_cache.lease_token IS DISTINCT FROM p_lease_token
       OR v_cache.lease_expires_at <= v_now THEN
        RETURN FALSE;
    END IF;

    SELECT source.* INTO v_source
    FROM public.precheckout_blite_sources AS source
    WHERE source.preflight_id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();

    UPDATE public.precheckout_blite_cache
    SET state = 'failed', failure_reason = p_reason, failed_at = v_now,
        updated_at = v_now
    WHERE preflight_id = p_preflight_id
      AND state = 'pending'
      AND lease_token = p_lease_token
      AND lease_expires_at > v_now;
    IF NOT FOUND THEN RETURN FALSE; END IF;

    DELETE FROM public.precheckout_blite_sources
    WHERE preflight_id = p_preflight_id;
    RETURN TRUE;
END;
$$;

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
    IF NOT FOUND OR v_cache.state = 'pending' THEN
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

CREATE OR REPLACE FUNCTION public.purge_expired_precheckout_blite_sources_v1(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight_id UUID;
    v_now TIMESTAMP WITH TIME ZONE;
    v_cache public.precheckout_blite_cache%ROWTYPE;
    v_source public.precheckout_blite_sources%ROWTYPE;
    v_deleted INTEGER := 0;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_INVALID_MAINTENANCE_INPUT', ERRCODE = 'P0001';
    END IF;

    FOR v_preflight_id IN
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE EXISTS (
            SELECT 1
            FROM public.precheckout_blite_sources AS expired_source
            WHERE expired_source.preflight_id = preflight.id
              AND expired_source.expires_at <= pg_catalog.clock_timestamp()
        )
        ORDER BY preflight.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    LOOP
        -- Match claim/finalizer/terminal cleanup: parent -> cache -> source.
        SELECT cache.* INTO v_cache
        FROM public.precheckout_blite_cache AS cache
        WHERE cache.preflight_id = v_preflight_id
        FOR UPDATE;
        SELECT source.* INTO v_source
        FROM public.precheckout_blite_sources AS source
        WHERE source.preflight_id = v_preflight_id
        FOR UPDATE;
        v_now := pg_catalog.clock_timestamp();
        IF NOT FOUND OR v_source.expires_at > v_now THEN
            CONTINUE;
        END IF;
        DELETE FROM public.precheckout_blite_cache
        WHERE preflight_id = v_preflight_id;
        DELETE FROM public.precheckout_blite_sources
        WHERE preflight_id = v_preflight_id;
        v_deleted := v_deleted + 1;
    END LOOP;
    RETURN v_deleted;
END;
$$;

-- The pre-existing PII trigger is reused so account deletion and every retention path inherit
-- source/cache cleanup without reading a feature flag.
CREATE OR REPLACE FUNCTION public.delete_precheckout_blite_cache_on_pii_scrub_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.pii_scrubbed_at IS NOT NULL
       AND OLD.pii_scrubbed_at IS DISTINCT FROM NEW.pii_scrubbed_at THEN
        -- The parent row is already locked by the UPDATE that fired this trigger.
        -- Take cache before source to avoid a cycle with a concurrent terminal writer.
        PERFORM 1
        FROM public.precheckout_blite_cache AS cache
        WHERE cache.preflight_id = NEW.id
        FOR UPDATE;
        PERFORM 1
        FROM public.precheckout_blite_sources AS source
        WHERE source.preflight_id = NEW.id
        FOR UPDATE;
        DELETE FROM public.precheckout_blite_cache
        WHERE preflight_id = NEW.id;
        DELETE FROM public.precheckout_blite_sources
        WHERE preflight_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS delete_precheckout_blite_cache_on_pii_scrub
    ON public.analysis_preflights;
CREATE TRIGGER delete_precheckout_blite_cache_on_pii_scrub
AFTER UPDATE OF pii_scrubbed_at ON public.analysis_preflights
FOR EACH ROW
EXECUTE FUNCTION public.delete_precheckout_blite_cache_on_pii_scrub_v1();

-- Keep v1 reachable for flag-off callers during the DB-first rollout window. The new
-- cohort path is fenced at its finalizer and v2 RPCs; legacy workers retain their
-- original pending/complete/release lifecycle until the application rollout retires them.
CREATE OR REPLACE FUNCTION public.claim_precheckout_blite_v1(p_preflight_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_lease UUID := extensions.gen_random_uuid();
    v_cache public.precheckout_blite_cache%ROWTYPE;
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS preflight
        WHERE preflight.id = p_preflight_id
          AND preflight.status = 'ready'
          AND preflight.ready_at IS NOT NULL
          AND preflight.expires_at > v_now
          AND NOT preflight.precheckout_blite_cohort
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.precheckout_blite_cache (
        preflight_id, state, lease_token, lease_expires_at, created_at, updated_at
    ) VALUES (
        p_preflight_id, 'pending', v_lease, v_now + INTERVAL '2 minutes', v_now, v_now
    ) ON CONFLICT (preflight_id) DO NOTHING;

    SELECT cache.* INTO v_cache
    FROM public.precheckout_blite_cache AS cache
    WHERE cache.preflight_id = p_preflight_id
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();

    IF v_cache.state = 'complete' THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'complete', 'dto', v_cache.dto);
    END IF;
    -- A DB-first v1 caller can observe a terminal v2 row. Preserve the legacy result
    -- vocabulary and leave its immutable failed state entirely untouched.
    IF v_cache.state = 'failed' THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'pending');
    END IF;
    IF v_cache.lease_token = v_lease THEN
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'claimed', 'leaseToken', v_cache.lease_token
        );
    END IF;
    IF v_cache.lease_expires_at <= v_now THEN
        UPDATE public.precheckout_blite_cache
        SET lease_token = v_lease,
            lease_expires_at = v_now + INTERVAL '2 minutes',
            updated_at = v_now
        WHERE preflight_id = p_preflight_id;
        RETURN pg_catalog.jsonb_build_object('disposition', 'claimed', 'leaseToken', v_lease);
    END IF;
    RETURN pg_catalog.jsonb_build_object('disposition', 'pending');
END;
$$;

REVOKE ALL ON FUNCTION public.claim_precheckout_blite_v1(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_precheckout_blite_v1(UUID)
    TO service_role;
REVOKE ALL ON FUNCTION public.complete_precheckout_blite_v1(UUID, UUID, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_precheckout_blite_v1(UUID, UUID, JSONB)
    TO service_role;
REVOKE ALL ON FUNCTION public.release_precheckout_blite_v1(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_precheckout_blite_v1(UUID, UUID)
    TO service_role;

-- Validation helpers are implementation details, not Data API endpoints.
REVOKE ALL ON FUNCTION public.precheckout_blite_v1_has_exact_keys(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.precheckout_blite_v1_copy_is_valid(TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.precheckout_blite_v1_integer_in_range(JSONB, NUMERIC, NUMERIC)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.precheckout_blite_v1_confidence_is_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.precheckout_blite_v1_dto_is_valid(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.finalize_preflight_blite_source_v1(
    UUID, UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_preflight_blite_source_v1(
    UUID, UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) TO service_role;
REVOKE ALL ON FUNCTION public.activate_precheckout_blite_cohort_v1(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.activate_precheckout_blite_cohort_v1(UUID, UUID)
    TO service_role;
REVOKE ALL ON FUNCTION public.complete_analysis_v2_preflight_with_blite_source_v1(
    UUID, UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_preflight_with_blite_source_v1(
    UUID, UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) TO service_role;
REVOKE ALL ON FUNCTION public.complete_anonymous_analysis_v2_preflight_with_blite_source_v1(
    UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_anonymous_analysis_v2_preflight_with_blite_source_v1(
    UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) TO service_role;
REVOKE ALL ON FUNCTION public.claim_precheckout_blite_v2(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_precheckout_blite_v2(UUID)
    TO service_role;
REVOKE ALL ON FUNCTION public.complete_precheckout_blite_v2(UUID, UUID, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_precheckout_blite_v2(UUID, UUID, JSONB)
    TO service_role;
REVOKE ALL ON FUNCTION public.fail_precheckout_blite_v2(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.fail_precheckout_blite_v2(UUID, UUID, TEXT)
    TO service_role;
REVOKE ALL ON FUNCTION public.read_precheckout_blite_status_v1(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_precheckout_blite_status_v1(UUID)
    TO service_role;
REVOKE ALL ON FUNCTION public.purge_expired_precheckout_blite_sources_v1(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_precheckout_blite_sources_v1(INTEGER)
    TO service_role;

-- Durable, additive recovery fence for the post-finalize B-lite task enqueue.
-- The persisted cohort/readiness/source rows are authoritative; rollout env changes do not
-- affect recovery. A deterministic Cloud Task name makes a lost acknowledgement safe to retry.
CREATE TABLE IF NOT EXISTS public.precheckout_blite_dispatches (
    preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'idle',
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    dispatch_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    failure_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT precheckout_blite_dispatch_state_check CHECK (state IN ('idle', 'enqueuing', 'enqueued')),
    CONSTRAINT precheckout_blite_dispatch_attempt_check CHECK (attempt_count BETWEEN 0 AND 32767),
    CONSTRAINT precheckout_blite_dispatch_failure_check CHECK (
        failure_reason IS NULL OR failure_reason = 'dispatch_failed'
    ),
    CONSTRAINT precheckout_blite_dispatch_token_check CHECK (
        (state = 'enqueuing' AND dispatch_token IS NOT NULL AND lease_expires_at IS NOT NULL)
        OR (state IN ('idle', 'enqueued') AND dispatch_token IS NULL AND lease_expires_at IS NULL)
    ),
    CONSTRAINT precheckout_blite_dispatch_timestamp_check CHECK (updated_at >= created_at)
);

ALTER TABLE public.precheckout_blite_dispatches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.precheckout_blite_dispatches FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.precheckout_blite_dispatches FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.precheckout_blite_dispatches TO service_role;

-- Extend the existing PII scrub trigger so the additive dispatch fence is removed with the
-- source/cache rows; no user-visible status or task payload is retained after scrub.
CREATE OR REPLACE FUNCTION public.delete_precheckout_blite_cache_on_pii_scrub_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.pii_scrubbed_at IS NOT NULL
       AND OLD.pii_scrubbed_at IS DISTINCT FROM NEW.pii_scrubbed_at THEN
        PERFORM 1
        FROM public.precheckout_blite_cache AS cache
        WHERE cache.preflight_id = NEW.id
        FOR UPDATE;
        PERFORM 1
        FROM public.precheckout_blite_sources AS source
        WHERE source.preflight_id = NEW.id
        FOR UPDATE;
        PERFORM 1
        FROM public.precheckout_blite_dispatches AS dispatch
        WHERE dispatch.preflight_id = NEW.id
        FOR UPDATE;
        DELETE FROM public.precheckout_blite_cache WHERE preflight_id = NEW.id;
        DELETE FROM public.precheckout_blite_sources WHERE preflight_id = NEW.id;
        DELETE FROM public.precheckout_blite_dispatches WHERE preflight_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_precheckout_blite_dispatch_v1(p_preflight_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_token UUID := extensions.gen_random_uuid();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_dispatch public.precheckout_blite_dispatches%ROWTYPE;
BEGIN
    -- The database row, not the current rollout percentage, decides recovery eligibility.
    IF p_preflight_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'PRECHECKOUT_BLITE_DISPATCH_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    -- Re-read wall time after the row-lock wait before applying the expiry fence.
    v_now := pg_catalog.clock_timestamp();
    IF NOT FOUND THEN
        -- A valid UUID whose preflight was retention-deleted is an idempotent no-op. This
        -- prevents replay loops while NULL/malformed inputs still fail closed above/type-check.
        RETURN pg_catalog.jsonb_build_object(
            'should_enqueue', FALSE, 'dispatch_token', NULL
        );
    END IF;
    IF NOT v_preflight.precheckout_blite_cohort
       OR v_preflight.status <> 'ready'
       OR v_preflight.pii_scrubbed_at IS NOT NULL
       OR v_preflight.expires_at <= v_now THEN
        RETURN pg_catalog.jsonb_build_object(
            'should_enqueue', FALSE, 'dispatch_token', NULL
        );
    END IF;
    IF NOT EXISTS (
            SELECT 1 FROM public.precheckout_blite_sources AS source
            WHERE source.preflight_id = p_preflight_id
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.precheckout_blite_cache AS cache
            WHERE cache.preflight_id = p_preflight_id
       ) THEN
        RETURN pg_catalog.jsonb_build_object(
            'should_enqueue', FALSE, 'dispatch_token', NULL
        );
    END IF;

    SELECT dispatch.* INTO v_dispatch
    FROM public.precheckout_blite_dispatches AS dispatch
    WHERE dispatch.preflight_id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        INSERT INTO public.precheckout_blite_dispatches (
            preflight_id, state, attempt_count, created_at, updated_at
        ) VALUES (p_preflight_id, 'idle', 0, v_now, v_now)
        RETURNING * INTO v_dispatch;
    END IF;

    v_now := pg_catalog.clock_timestamp();
    IF v_dispatch.state = 'enqueued' THEN
        RETURN pg_catalog.jsonb_build_object(
            'should_enqueue', FALSE, 'dispatch_token', NULL
        );
    END IF;
    IF v_dispatch.state = 'enqueuing'
       AND v_dispatch.lease_expires_at > v_now THEN
        RETURN pg_catalog.jsonb_build_object(
            'should_enqueue', FALSE, 'dispatch_token', NULL
        );
    END IF;

    UPDATE public.precheckout_blite_dispatches
    SET state = 'enqueuing',
        attempt_count = v_dispatch.attempt_count + 1,
        dispatch_token = v_token,
        lease_expires_at = v_now + INTERVAL '2 minutes',
        failure_reason = NULL,
        updated_at = v_now
    WHERE preflight_id = p_preflight_id;
    RETURN pg_catalog.jsonb_build_object(
        'should_enqueue', TRUE, 'dispatch_token', v_token
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_precheckout_blite_dispatch_failed_v1(
    p_preflight_id UUID,
    p_dispatch_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    UPDATE public.precheckout_blite_dispatches
    SET state = 'idle', dispatch_token = NULL, lease_expires_at = NULL,
        failure_reason = 'dispatch_failed', updated_at = v_now
    WHERE preflight_id = p_preflight_id
      AND state = 'enqueuing'
      AND dispatch_token = p_dispatch_token;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_precheckout_blite_dispatch_enqueued_v1(
    p_preflight_id UUID,
    p_dispatch_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    UPDATE public.precheckout_blite_dispatches
    SET state = 'enqueued', dispatch_token = NULL, lease_expires_at = NULL,
        failure_reason = NULL, updated_at = v_now
    WHERE preflight_id = p_preflight_id
      AND (
        (state = 'enqueuing' AND dispatch_token = p_dispatch_token)
        OR state = 'enqueued'
      );
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_precheckout_blite_dispatch_v1(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_precheckout_blite_dispatch_v1(UUID)
    TO service_role;
REVOKE ALL ON FUNCTION public.mark_precheckout_blite_dispatch_failed_v1(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_precheckout_blite_dispatch_failed_v1(UUID, UUID)
    TO service_role;
REVOKE ALL ON FUNCTION public.mark_precheckout_blite_dispatch_enqueued_v1(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_precheckout_blite_dispatch_enqueued_v1(UUID, UUID)
    TO service_role;
