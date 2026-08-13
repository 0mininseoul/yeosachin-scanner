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
            AND submitted_at IS NOT NULL
            AND deadline_at = submitted_at + INTERVAL '60 seconds'
        )
    );

CREATE OR REPLACE FUNCTION public.enforce_precheckout_blite_preflight_clock_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.precheckout_blite_cohort THEN
            NEW.submitted_at := COALESCE(NEW.submitted_at, v_now);
            NEW.deadline_at := COALESCE(
                NEW.deadline_at,
                NEW.submitted_at + INTERVAL '60 seconds'
            );
            IF NEW.deadline_at <> NEW.submitted_at + INTERVAL '60 seconds' THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'PRECHECKOUT_BLITE_INVALID_DEADLINE', ERRCODE = 'P0001';
            END IF;
        ELSIF NEW.submitted_at IS NOT NULL OR NEW.deadline_at IS NOT NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PRECHECKOUT_BLITE_NON_COHORT_CLOCK_FORBIDDEN', ERRCODE = 'P0001';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.precheckout_blite_cohort THEN
        IF NEW.precheckout_blite_cohort IS DISTINCT FROM TRUE
           OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
           OR NEW.deadline_at IS DISTINCT FROM OLD.deadline_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PRECHECKOUT_BLITE_CLOCK_IMMUTABLE', ERRCODE = 'P0001';
        END IF;
    ELSIF NEW.precheckout_blite_cohort THEN
        NEW.submitted_at := COALESCE(NEW.submitted_at, v_now);
        NEW.deadline_at := COALESCE(
            NEW.deadline_at,
            NEW.submitted_at + INTERVAL '60 seconds'
        );
        IF NEW.deadline_at <> NEW.submitted_at + INTERVAL '60 seconds' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'PRECHECKOUT_BLITE_INVALID_DEADLINE', ERRCODE = 'P0001';
        END IF;
    ELSIF NEW.submitted_at IS NOT NULL OR NEW.deadline_at IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_NON_COHORT_CLOCK_FORBIDDEN', ERRCODE = 'P0001';
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_precheckout_blite_preflight_clock ON public.analysis_preflights;
CREATE TRIGGER enforce_precheckout_blite_preflight_clock
BEFORE INSERT OR UPDATE OF precheckout_blite_cohort, submitted_at, deadline_at
ON public.analysis_preflights
FOR EACH ROW
EXECUTE FUNCTION public.enforce_precheckout_blite_preflight_clock_v1();

REVOKE ALL ON FUNCTION public.enforce_precheckout_blite_preflight_clock_v1()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.precheckout_blite_sources (
    preflight_id UUID PRIMARY KEY REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    schema_version SMALLINT NOT NULL,
    target_input_hash VARCHAR(64) NOT NULL,
    provider_run_id UUID NOT NULL
        REFERENCES public.analysis_preflight_provider_runs(preflight_id) ON DELETE CASCADE,
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
            AND failure_reason IN ('source_missing', 'source_expired', 'source_invalid', 'source_insufficient', 'attempts_exhausted', 'deadline_exceeded', 'model_unavailable', 'model_invalid')
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

-- This finalizer keeps the existing ready-snapshot validation as the source of truth, but
-- performs it and the source/cache write in one transaction. It supports both current
-- authenticated and anonymous claim fences without putting either claim token in the payload.
CREATE OR REPLACE FUNCTION public.finalize_preflight_blite_source_v1(
    p_preflight_id UUID,
    p_user_id UUID,
    p_claim_token UUID,
    p_target_input_hash VARCHAR,
    p_provider_run_id UUID,
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
    v_completed BOOLEAN;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_target_input_hash IS NULL
       OR p_target_input_hash !~ '^[0-9a-f]{64}$'
       OR p_provider_run_id IS NULL
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

    SELECT provider_run.* INTO v_provider_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = v_preflight.id
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
           AND v_source.provider_run_reference = p_provider_run_reference
           AND v_source.payload_hash = p_payload_hash
           AND v_source.collected_at = p_collected_at
           AND v_source.expires_at = p_expires_at
           AND v_preflight.status = 'ready' THEN
            RETURN FALSE;
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_SOURCE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now THEN
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
        provider_run_reference, payload, payload_bytes, payload_hash,
        collected_at, expires_at, created_at, updated_at
    ) VALUES (
        v_preflight.id, 1, p_target_input_hash, p_provider_run_id,
        p_provider_run_reference, p_payload, v_payload_bytes, p_payload_hash,
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
    p_target_input_hash VARCHAR, p_provider_run_id UUID, p_provider_run_reference TEXT,
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
        p_provider_run_id, p_provider_run_reference, p_target_full_name, p_target_bio,
        p_target_profile_image_url, p_target_followers_count, p_target_following_count,
        p_target_is_private, p_capacity_required_plan_id, p_required_plan_id,
        p_plan_cards_snapshot, p_payload, p_payload_hash, p_collected_at, p_expires_at
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_anonymous_analysis_v2_preflight_with_blite_source_v1(
    p_preflight_id UUID, p_claim_token UUID, p_target_input_hash VARCHAR,
    p_provider_run_id UUID, p_provider_run_reference TEXT, p_target_full_name TEXT,
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
        p_provider_run_id, p_provider_run_reference, p_target_full_name, p_target_bio,
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
        v_reason := 'deadline_exceeded';
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
        'source', v_source.payload, 'deadlineAt', v_preflight.deadline_at
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
BEGIN
    IF p_preflight_id IS NULL
       OR p_lease_token IS NULL
       OR p_dto IS NULL
       OR pg_catalog.jsonb_typeof(p_dto) <> 'object' THEN
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
BEGIN
    IF p_preflight_id IS NULL
       OR p_lease_token IS NULL
       OR p_reason NOT IN ('source_missing', 'source_expired', 'source_invalid', 'source_insufficient', 'attempts_exhausted', 'deadline_exceeded', 'model_unavailable', 'model_invalid') THEN
        RETURN FALSE;
    END IF;

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
    v_deleted INTEGER := 0;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_INVALID_MAINTENANCE_INPUT', ERRCODE = 'P0001';
    END IF;

    FOR v_preflight_id IN
        SELECT source.preflight_id
        FROM public.precheckout_blite_sources AS source
        WHERE source.expires_at <= pg_catalog.clock_timestamp()
        ORDER BY source.expires_at, source.preflight_id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    LOOP
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
        DELETE FROM public.precheckout_blite_sources
        WHERE preflight_id = NEW.id;
        DELETE FROM public.precheckout_blite_cache
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

-- Retire v1 entry points so a service worker cannot bypass the source/terminal fences.
DROP FUNCTION public.claim_precheckout_blite_v1(UUID);
DROP FUNCTION public.complete_precheckout_blite_v1(UUID, UUID, JSONB);
DROP FUNCTION public.release_precheckout_blite_v1(UUID, UUID);

REVOKE ALL ON FUNCTION public.finalize_preflight_blite_source_v1(
    UUID, UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_preflight_blite_source_v1(
    UUID, UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) TO service_role;
REVOKE ALL ON FUNCTION public.complete_analysis_v2_preflight_with_blite_source_v1(
    UUID, UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_preflight_with_blite_source_v1(
    UUID, UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) TO service_role;
REVOKE ALL ON FUNCTION public.complete_anonymous_analysis_v2_preflight_with_blite_source_v1(
    UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
    TEXT, TEXT, JSONB, JSONB, VARCHAR, TIMESTAMP WITH TIME ZONE, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_anonymous_analysis_v2_preflight_with_blite_source_v1(
    UUID, UUID, VARCHAR, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN,
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
