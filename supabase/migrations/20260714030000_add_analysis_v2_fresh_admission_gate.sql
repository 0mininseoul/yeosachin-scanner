-- Durable, count-only checkout admission. Vercel only reserves and polls this state; the
-- authenticated Cloud Run preflight worker performs the Instagram request and commits the
-- latest counts before entitlement consumption can create any analysis request or provider run.

ALTER TABLE public.analysis_preflights
    ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN admission_generation INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN admission_selected_plan_id TEXT,
    ADD COLUMN admission_entitlement_jti_hash TEXT,
    ADD COLUMN admission_token UUID,
    ADD COLUMN admission_requested_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_refreshed_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_claim_token UUID,
    ADD COLUMN admission_lease_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_dispatch_state TEXT NOT NULL DEFAULT 'idle',
    ADD COLUMN admission_dispatch_generation INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN admission_dispatch_token UUID,
    ADD COLUMN admission_dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_dispatched_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN admission_error_code TEXT,
    ADD COLUMN admission_target_followers_count INTEGER,
    ADD COLUMN admission_target_following_count INTEGER,
    ADD COLUMN admission_capacity_required_plan_id TEXT,
    ADD COLUMN admission_required_plan_id TEXT,
    ADD COLUMN admission_plan_cards_snapshot JSONB,
    ADD COLUMN admission_failure_count INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN admission_last_error_code TEXT,
    ADD CONSTRAINT analysis_preflights_admission_status_check CHECK (
        admission_status IN ('idle', 'pending', 'processing', 'ready', 'blocked')
    ),
    ADD CONSTRAINT analysis_preflights_admission_generation_check CHECK (
        admission_generation BETWEEN 0 AND 100
    ),
    ADD CONSTRAINT analysis_preflights_admission_plan_check CHECK (
        admission_selected_plan_id IS NULL
        OR admission_selected_plan_id IN ('basic', 'standard', 'plus')
    ),
    ADD CONSTRAINT analysis_preflights_admission_error_check CHECK (
        admission_error_code IS NULL
        OR admission_error_code IN (
            'ANALYSIS_V2_PLAN_NOT_ALLOWED',
            'ANALYSIS_V2_TARGET_NOT_FOUND',
            'ANALYSIS_V2_TARGET_PRIVATE',
            'ANALYSIS_V2_OVER_PLUS_CAPACITY',
            'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_jti_check CHECK (
        admission_entitlement_jti_hash IS NULL
        OR admission_entitlement_jti_hash ~ '^[a-f0-9]{64}$'
    ),
    ADD CONSTRAINT analysis_preflights_admission_failure_check CHECK (
        (
            admission_failure_count = 0
            AND admission_last_error_code IS NULL
        )
        OR (
            admission_failure_count BETWEEN 1 AND 3
            AND admission_last_error_code = 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_failure_terminal_check CHECK (
        admission_failure_count < 3
        OR (
            admission_status = 'blocked'
            AND admission_error_code = 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_counts_check CHECK (
        (
            admission_target_followers_count IS NULL
            AND admission_target_following_count IS NULL
        )
        OR (
            admission_target_followers_count BETWEEN 0 AND 10000000
            AND admission_target_following_count BETWEEN 0 AND 10000000
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_required_plan_check CHECK (
        (
            admission_capacity_required_plan_id IS NULL
            AND admission_required_plan_id IS NULL
        )
        OR (
            admission_capacity_required_plan_id IN ('basic', 'standard', 'plus')
            AND (
                admission_required_plan_id IS NULL
                OR (
                    admission_required_plan_id IN ('basic', 'standard', 'plus')
                    AND CASE admission_required_plan_id
                        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
                        >= CASE admission_capacity_required_plan_id
                            WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
                )
            )
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_cards_check CHECK (
        admission_plan_cards_snapshot IS NULL
        OR (
            pg_catalog.jsonb_typeof(admission_plan_cards_snapshot) = 'object'
            AND pg_catalog.octet_length(admission_plan_cards_snapshot::TEXT) <= 8192
            AND admission_plan_cards_snapshot ?& ARRAY['basic', 'standard', 'plus']
            AND admission_plan_cards_snapshot - ARRAY['basic', 'standard', 'plus'] = '{}'::JSONB
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_lease_check CHECK (
        (admission_claim_token IS NULL AND admission_lease_expires_at IS NULL)
        OR (
            admission_status = 'processing'
            AND admission_claim_token IS NOT NULL
            AND admission_lease_expires_at IS NOT NULL
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_dispatch_check CHECK (
        admission_dispatch_generation BETWEEN 0 AND 100
        AND admission_dispatch_state IN ('idle', 'reserved', 'enqueued')
        AND (
            (
                admission_dispatch_generation = 0
                AND admission_dispatch_state = 'idle'
                AND admission_dispatch_token IS NULL
                AND admission_dispatch_reserved_at IS NULL
                AND admission_dispatched_at IS NULL
            )
            OR (
                admission_dispatch_generation > 0
                AND admission_dispatch_state = 'idle'
                AND admission_dispatch_token IS NULL
                AND admission_dispatch_reserved_at IS NULL
                AND admission_dispatched_at IS NULL
            )
            OR (
                admission_dispatch_generation > 0
                AND admission_dispatch_state = 'reserved'
                AND admission_dispatch_token IS NOT NULL
                AND admission_dispatch_reserved_at IS NOT NULL
                AND admission_dispatched_at IS NULL
            )
            OR (
                admission_dispatch_generation > 0
                AND admission_dispatch_state = 'enqueued'
                AND admission_dispatch_token IS NOT NULL
                AND admission_dispatch_reserved_at IS NOT NULL
                AND admission_dispatched_at IS NOT NULL
            )
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_payload_check CHECK (
        (
            admission_status = 'idle'
            AND admission_generation = 0
            AND admission_selected_plan_id IS NULL
            AND admission_entitlement_jti_hash IS NULL
            AND admission_token IS NULL
            AND admission_requested_at IS NULL
            AND admission_refreshed_at IS NULL
            AND admission_dispatch_state = 'idle'
            AND admission_dispatch_generation = 0
            AND admission_error_code IS NULL
            AND admission_target_followers_count IS NULL
            AND admission_target_following_count IS NULL
            AND admission_capacity_required_plan_id IS NULL
            AND admission_required_plan_id IS NULL
            AND admission_plan_cards_snapshot IS NULL
            AND admission_failure_count = 0
            AND admission_last_error_code IS NULL
        )
        OR (
            admission_status IN ('pending', 'processing')
            AND admission_generation >= 1
            AND admission_selected_plan_id IS NOT NULL
            AND admission_entitlement_jti_hash IS NOT NULL
            AND admission_token IS NOT NULL
            AND admission_requested_at IS NOT NULL
            AND admission_refreshed_at IS NULL
            AND (
                admission_status = 'pending'
                OR admission_dispatch_state = 'enqueued'
            )
            AND admission_error_code IS NULL
            AND admission_target_followers_count IS NULL
            AND admission_target_following_count IS NULL
            AND admission_capacity_required_plan_id IS NULL
            AND admission_required_plan_id IS NULL
            AND admission_plan_cards_snapshot IS NULL
            AND admission_failure_count < 3
        )
        OR (
            admission_status = 'ready'
            AND admission_generation >= 1
            AND admission_selected_plan_id IS NOT NULL
            AND admission_entitlement_jti_hash IS NOT NULL
            AND admission_token IS NOT NULL
            AND admission_requested_at IS NOT NULL
            AND admission_refreshed_at IS NOT NULL
            AND admission_error_code IS NULL
            AND admission_target_followers_count IS NOT NULL
            AND admission_target_following_count IS NOT NULL
            AND admission_capacity_required_plan_id IS NOT NULL
            AND admission_required_plan_id IS NOT NULL
            AND admission_plan_cards_snapshot IS NOT NULL
            AND admission_dispatch_state = 'enqueued'
            AND admission_claim_token IS NULL
            AND admission_lease_expires_at IS NULL
        )
        OR (
            admission_status = 'blocked'
            AND admission_generation >= 1
            AND admission_selected_plan_id IS NOT NULL
            AND admission_entitlement_jti_hash IS NOT NULL
            AND admission_token IS NOT NULL
            AND admission_requested_at IS NOT NULL
            AND admission_refreshed_at IS NOT NULL
            AND admission_error_code IS NOT NULL
            AND admission_dispatch_state = 'enqueued'
            AND admission_claim_token IS NULL
            AND admission_lease_expires_at IS NULL
        )
    ),
    ADD CONSTRAINT analysis_preflights_admission_time_check CHECK (
        (admission_requested_at IS NULL OR admission_requested_at >= created_at)
        AND (
            admission_refreshed_at IS NULL
            OR admission_refreshed_at >= admission_requested_at
        )
        AND (
            admission_dispatch_reserved_at IS NULL
            OR admission_dispatch_reserved_at >= admission_requested_at
        )
        AND (
            admission_dispatched_at IS NULL
            OR admission_dispatched_at >= admission_dispatch_reserved_at
        )
    );

COMMENT ON COLUMN public.analysis_preflights.admission_status IS
    'Durable count-only checkout admission state; independent from the initial profile preflight.';
COMMENT ON COLUMN public.analysis_preflights.admission_token IS
    'Owner-bound, short-lived fence consumed by the request-creation transaction.';
COMMENT ON COLUMN public.analysis_preflights.admission_entitlement_jti_hash IS
    'Hashed entitlement attempt identity used to reuse one stable admission fence across polling.';
COMMENT ON COLUMN public.analysis_preflights.admission_failure_count IS
    'Bounded count of sanitized self-hosted admission failures for the current generation.';
COMMENT ON COLUMN public.analysis_preflights.admission_last_error_code IS
    'Sanitized last admission failure class; never stores upstream payloads or usernames.';
COMMENT ON COLUMN public.analysis_preflights.admission_plan_cards_snapshot IS
    'Latest admission cards, including all-unavailable over-Plus snapshots.';
COMMENT ON COLUMN public.analysis_preflights.admission_dispatch_state IS
    'Durable Cloud Tasks dispatch state for the current admission generation.';
COMMENT ON COLUMN public.analysis_preflights.admission_dispatch_token IS
    'Exact dispatch fence retained after enqueue so an early worker delivery can prove ownership.';

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_preflight_admission(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT,
    p_admission_token UUID,
    p_dispatch_token UUID
)
RETURNS TABLE(
    admission_status TEXT,
    should_enqueue BOOLEAN,
    admission_generation INTEGER,
    dispatch_generation INTEGER,
    dispatch_token UUID,
    selected_plan_id TEXT,
    selected_plan_allowed BOOLEAN,
    admission_token UUID,
    admission_refreshed_at TIMESTAMP WITH TIME ZONE,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    plan_cards_snapshot JSONB,
    pricing_version TEXT,
    pricing_snapshot JSONB,
    admission_error_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_fresh BOOLEAN;
    v_allowed BOOLEAN;
    v_same_attempt BOOLEAN;
    v_effective_token UUID;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_entitlement_jti_hash IS NULL
       OR p_entitlement_jti_hash !~ '^[a-f0-9]{64}$'
       OR p_admission_token IS NULL
       OR p_dispatch_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_EXPIRED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.exclusion_decision NOT IN ('exclude', 'skip') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.access_mode NOT IN ('production', 'test_entitlement')
       OR NOT public.analysis_v2_valid_launch_snapshot(v_preflight.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(v_preflight.plan_catalog_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(v_preflight.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
           v_preflight.policy_versions_snapshot
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    v_same_attempt := v_preflight.admission_selected_plan_id IS NOT DISTINCT FROM p_selected_plan_id
        AND v_preflight.admission_entitlement_jti_hash
            IS NOT DISTINCT FROM p_entitlement_jti_hash;
    v_effective_token := CASE
        WHEN v_same_attempt AND v_preflight.admission_token IS NOT NULL
            THEN v_preflight.admission_token
        ELSE p_admission_token
    END;

    v_fresh := v_preflight.admission_status IN ('ready', 'blocked')
        AND v_preflight.admission_refreshed_at >= v_now - INTERVAL '2 minutes'
        AND v_preflight.admission_refreshed_at <= v_now + INTERVAL '30 seconds';

    IF v_fresh THEN
        UPDATE public.analysis_preflights AS preflight
        SET admission_selected_plan_id = p_selected_plan_id,
            admission_entitlement_jti_hash = p_entitlement_jti_hash,
            admission_token = v_effective_token,
            updated_at = v_now
        WHERE preflight.id = v_preflight.id;

        v_allowed := v_preflight.admission_status = 'ready'
            AND v_preflight.admission_plan_cards_snapshot
                ->p_selected_plan_id->>'selectionState'
                IN ('required', 'available_upgrade');

        RETURN QUERY SELECT
            v_preflight.admission_status,
            FALSE,
            v_preflight.admission_generation,
            v_preflight.admission_dispatch_generation,
            NULL::UUID,
            p_selected_plan_id,
            CASE WHEN v_preflight.admission_status = 'ready' THEN v_allowed ELSE NULL END,
            CASE WHEN v_preflight.admission_status = 'ready'
                THEN v_effective_token ELSE NULL END,
            v_preflight.admission_refreshed_at,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_capacity_required_plan_id,
            v_preflight.admission_required_plan_id,
            v_preflight.admission_plan_cards_snapshot,
            v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,
            v_preflight.admission_error_code;
        RETURN;
    END IF;

    IF v_preflight.admission_status = 'processing'
       AND v_preflight.admission_lease_expires_at <= v_now THEN
        UPDATE public.analysis_preflights AS preflight
        SET admission_status = 'pending',
            admission_selected_plan_id = p_selected_plan_id,
            admission_entitlement_jti_hash = p_entitlement_jti_hash,
            admission_token = v_effective_token,
            admission_claim_token = NULL,
            admission_lease_expires_at = NULL,
            updated_at = v_now
        WHERE preflight.id = v_preflight.id;
        v_preflight.admission_status := 'pending';
    END IF;

    IF v_preflight.admission_status = 'processing'
       AND v_preflight.admission_lease_expires_at > v_now THEN
        UPDATE public.analysis_preflights AS preflight
        SET admission_selected_plan_id = p_selected_plan_id,
            admission_entitlement_jti_hash = p_entitlement_jti_hash,
            admission_token = v_effective_token,
            updated_at = v_now
        WHERE preflight.id = v_preflight.id;

        RETURN QUERY SELECT
            'processing'::TEXT,
            FALSE,
            v_preflight.admission_generation,
            v_preflight.admission_dispatch_generation,
            NULL::UUID,
            p_selected_plan_id,
            NULL::BOOLEAN,
            NULL::UUID,
            NULL::TIMESTAMP WITH TIME ZONE,
            NULL::INTEGER,
            NULL::INTEGER,
            NULL::TEXT,
            NULL::TEXT,
            NULL::JSONB,
            v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,
            NULL::TEXT;
        RETURN;
    END IF;

    IF v_preflight.admission_status = 'pending' THEN
        IF v_preflight.admission_dispatch_state = 'enqueued'
           OR (
               v_preflight.admission_dispatch_state = 'reserved'
               AND v_preflight.admission_dispatch_reserved_at
                    > v_now - INTERVAL '2 minutes'
           ) THEN
            UPDATE public.analysis_preflights AS preflight
            SET admission_selected_plan_id = p_selected_plan_id,
                admission_entitlement_jti_hash = p_entitlement_jti_hash,
                admission_token = v_effective_token,
                updated_at = v_now
            WHERE preflight.id = v_preflight.id;

            RETURN QUERY SELECT
                'pending'::TEXT,
                FALSE,
                v_preflight.admission_generation,
                v_preflight.admission_dispatch_generation,
                NULL::UUID,
                p_selected_plan_id,
                NULL::BOOLEAN,
                NULL::UUID,
                NULL::TIMESTAMP WITH TIME ZONE,
                NULL::INTEGER,
                NULL::INTEGER,
                NULL::TEXT,
                NULL::TEXT,
                NULL::JSONB,
                v_preflight.pricing_version::TEXT,
                v_preflight.pricing_snapshot,
                NULL::TEXT;
            RETURN;
        END IF;

        IF v_preflight.admission_dispatch_generation >= 100 THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
        END IF;

        UPDATE public.analysis_preflights AS preflight
        SET admission_selected_plan_id = p_selected_plan_id,
            admission_entitlement_jti_hash = p_entitlement_jti_hash,
            admission_token = v_effective_token,
            admission_dispatch_state = 'reserved',
            admission_dispatch_generation = v_preflight.admission_dispatch_generation + 1,
            admission_dispatch_token = p_dispatch_token,
            admission_dispatch_reserved_at = v_now,
            admission_dispatched_at = NULL,
            updated_at = v_now
        WHERE preflight.id = v_preflight.id;

        RETURN QUERY SELECT
            'pending'::TEXT,
            TRUE,
            v_preflight.admission_generation,
            v_preflight.admission_dispatch_generation + 1,
            p_dispatch_token,
            p_selected_plan_id,
            NULL::BOOLEAN,
            NULL::UUID,
            NULL::TIMESTAMP WITH TIME ZONE,
            NULL::INTEGER,
            NULL::INTEGER,
            NULL::TEXT,
            NULL::TEXT,
            NULL::JSONB,
            v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,
            NULL::TEXT;
        RETURN;
    END IF;

    IF v_preflight.admission_generation >= 100 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET admission_status = 'pending',
        admission_generation = v_preflight.admission_generation + 1,
        admission_selected_plan_id = p_selected_plan_id,
        admission_entitlement_jti_hash = p_entitlement_jti_hash,
        admission_token = p_admission_token,
        admission_requested_at = v_now,
        admission_refreshed_at = NULL,
        admission_claim_token = NULL,
        admission_lease_expires_at = NULL,
        admission_dispatch_state = 'reserved',
        admission_dispatch_generation = 1,
        admission_dispatch_token = p_dispatch_token,
        admission_dispatch_reserved_at = v_now,
        admission_dispatched_at = NULL,
        admission_error_code = NULL,
        admission_target_followers_count = NULL,
        admission_target_following_count = NULL,
        admission_capacity_required_plan_id = NULL,
        admission_required_plan_id = NULL,
        admission_plan_cards_snapshot = NULL,
        admission_failure_count = 0,
        admission_last_error_code = NULL,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    RETURN QUERY SELECT
        'pending'::TEXT,
        TRUE,
        v_preflight.admission_generation + 1,
        1,
        p_dispatch_token,
        p_selected_plan_id,
        NULL::BOOLEAN,
        NULL::UUID,
        NULL::TIMESTAMP WITH TIME ZONE,
        NULL::INTEGER,
        NULL::INTEGER,
        NULL::TEXT,
        NULL::TEXT,
        NULL::JSONB,
        v_preflight.pricing_version::TEXT,
        v_preflight.pricing_snapshot,
        NULL::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_preflight_admission_dispatched(
    p_preflight_id UUID,
    p_user_id UUID,
    p_admission_generation INTEGER,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 100
       OR p_dispatch_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.admission_generation <> p_admission_generation
       OR v_preflight.admission_dispatch_generation <> p_dispatch_generation
       OR v_preflight.admission_dispatch_token IS DISTINCT FROM p_dispatch_token THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_DISPATCH_LOST', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.admission_dispatch_state = 'enqueued' THEN
        RETURN FALSE;
    END IF;
    IF v_preflight.admission_dispatch_state <> 'reserved' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_DISPATCH_LOST', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET admission_dispatch_state = 'enqueued',
        admission_dispatched_at = v_now,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_analysis_v2_preflight_admission_dispatch(
    p_preflight_id UUID,
    p_user_id UUID,
    p_admission_generation INTEGER,
    p_dispatch_generation INTEGER,
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
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 100
       OR p_dispatch_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET admission_dispatch_state = 'idle',
        admission_dispatch_token = NULL,
        admission_dispatch_reserved_at = NULL,
        admission_dispatched_at = NULL,
        updated_at = v_now
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
      AND preflight.admission_generation = p_admission_generation
      AND preflight.admission_status = 'pending'
      AND preflight.admission_dispatch_generation = p_dispatch_generation
      AND preflight.admission_dispatch_state = 'reserved'
      AND preflight.admission_dispatch_token = p_dispatch_token;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_analysis_v2_preflight_admission(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER
)
RETURNS TABLE(
    claimed BOOLEAN,
    admission_status TEXT,
    target_instagram_id TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation NOT BETWEEN 1 AND 100
       OR p_dispatch_token IS NULL
       OR p_claim_token IS NULL
       OR p_lease_seconds IS NULL
       OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'blocked'::TEXT, NULL::TEXT;
        RETURN;
    END IF;
    IF v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now THEN
        RETURN QUERY SELECT FALSE, 'blocked'::TEXT, NULL::TEXT;
        RETURN;
    END IF;
    IF v_preflight.admission_generation <> p_admission_generation THEN
        RETURN QUERY SELECT FALSE, 'blocked'::TEXT, NULL::TEXT;
        RETURN;
    END IF;
    IF v_preflight.admission_dispatch_generation <> p_dispatch_generation
       OR v_preflight.admission_dispatch_token IS DISTINCT FROM p_dispatch_token
       OR v_preflight.admission_dispatch_state NOT IN ('reserved', 'enqueued') THEN
        RETURN QUERY SELECT FALSE, 'blocked'::TEXT, NULL::TEXT;
        RETURN;
    END IF;
    IF v_preflight.admission_status IN ('idle', 'ready', 'blocked') THEN
        RETURN QUERY SELECT
            FALSE,
            CASE WHEN v_preflight.admission_status = 'idle'
                THEN 'blocked' ELSE v_preflight.admission_status END,
            NULL::TEXT;
        RETURN;
    END IF;
    IF v_preflight.admission_status = 'processing'
       AND v_preflight.admission_lease_expires_at > v_now THEN
        RETURN QUERY SELECT FALSE, 'processing'::TEXT, NULL::TEXT;
        RETURN;
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET admission_status = 'processing',
        admission_claim_token = p_claim_token,
        admission_lease_expires_at = v_now
            + pg_catalog.make_interval(secs => p_lease_seconds),
        admission_dispatch_state = 'enqueued',
        admission_dispatched_at = COALESCE(preflight.admission_dispatched_at, v_now),
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    RETURN QUERY SELECT TRUE, 'processing'::TEXT, v_preflight.target_instagram_id::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_analysis_v2_preflight_admission(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    UPDATE public.analysis_preflights AS preflight
    SET admission_status = 'pending',
        admission_claim_token = NULL,
        admission_lease_expires_at = NULL,
        updated_at = v_now
    WHERE preflight.id = p_preflight_id
      AND preflight.admission_generation = p_admission_generation
      AND preflight.admission_status = 'processing'
      AND preflight.admission_claim_token = p_claim_token;
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_analysis_v2_preflight_admission_failure(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID
)
RETURNS TABLE(
    admission_status TEXT,
    failure_count INTEGER,
    admission_error_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_failure_count INTEGER;
    v_status TEXT;
    v_error_code TEXT;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.admission_generation = p_admission_generation
      AND preflight.admission_status = 'processing'
      AND preflight.admission_claim_token = p_claim_token
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    v_failure_count := LEAST(v_preflight.admission_failure_count + 1, 3);
    v_status := CASE WHEN v_failure_count >= 3 THEN 'blocked' ELSE 'pending' END;
    v_error_code := CASE WHEN v_status = 'blocked'
        THEN 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE' ELSE NULL END;

    UPDATE public.analysis_preflights AS preflight
    SET admission_status = v_status,
        admission_refreshed_at = CASE WHEN v_status = 'blocked' THEN v_now ELSE NULL END,
        admission_claim_token = NULL,
        admission_lease_expires_at = NULL,
        admission_error_code = v_error_code,
        admission_failure_count = v_failure_count,
        admission_last_error_code = 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE',
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    RETURN QUERY SELECT v_status, v_failure_count, v_error_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_analysis_v2_preflight_admission(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_error_code TEXT
)
RETURNS TABLE(admission_status TEXT, admission_error_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_error_code IS NULL OR p_error_code NOT IN (
        'ANALYSIS_V2_TARGET_NOT_FOUND',
        'ANALYSIS_V2_TARGET_PRIVATE'
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET admission_status = 'blocked',
        admission_refreshed_at = v_now,
        admission_claim_token = NULL,
        admission_lease_expires_at = NULL,
        admission_error_code = p_error_code,
        admission_target_followers_count = NULL,
        admission_target_following_count = NULL,
        admission_capacity_required_plan_id = NULL,
        admission_required_plan_id = NULL,
        admission_plan_cards_snapshot = NULL,
        updated_at = v_now
    WHERE preflight.id = p_preflight_id
      AND preflight.admission_generation = p_admission_generation
      AND preflight.admission_status = 'processing'
      AND preflight.admission_claim_token = p_claim_token;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    RETURN QUERY SELECT 'blocked'::TEXT, p_error_code;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_preflight_admission(
    p_preflight_id UUID,
    p_admission_generation INTEGER,
    p_claim_token UUID,
    p_target_instagram_id TEXT,
    p_target_followers_count INTEGER,
    p_target_following_count INTEGER,
    p_target_is_private BOOLEAN
)
RETURNS TABLE(admission_status TEXT, admission_error_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_plan_ids CONSTANT TEXT[] := ARRAY['basic', 'standard', 'plus'];
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_capacity_required_plan_id TEXT;
    v_required_plan_id TEXT;
    v_catalog_plan JSONB;
    v_capacity JSONB;
    v_launch_status TEXT;
    v_selection_state TEXT;
    v_unavailable_reason TEXT;
    v_cards JSONB := '{}'::JSONB;
    v_status TEXT := 'ready';
    v_error_code TEXT;
BEGIN
    IF p_preflight_id IS NULL
       OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100
       OR p_claim_token IS NULL
       OR p_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
       OR p_target_followers_count IS NULL
       OR p_target_followers_count NOT BETWEEN 0 AND 10000000
       OR p_target_following_count IS NULL
       OR p_target_following_count NOT BETWEEN 0 AND 10000000
       OR p_target_is_private IS DISTINCT FROM FALSE THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.admission_generation = p_admission_generation
      AND preflight.admission_status = 'processing'
      AND preflight.admission_claim_token = p_claim_token
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.target_instagram_id IS DISTINCT FROM p_target_instagram_id THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_TARGET_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.expires_at <= v_now
       OR v_preflight.access_mode NOT IN ('production', 'test_entitlement')
       OR NOT public.analysis_v2_valid_launch_snapshot(
           v_preflight.launch_status_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(
           v_preflight.plan_catalog_snapshot
       )
       OR NOT public.analysis_v2_valid_pricing_snapshot(
           v_preflight.pricing_snapshot
       )
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
           v_preflight.policy_versions_snapshot
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    FOREACH v_plan_id IN ARRAY v_plan_ids LOOP
        IF v_preflight.plan_catalog_snapshot->v_plan_id->>'launchStatus'
            IS DISTINCT FROM v_preflight.launch_status_snapshot->>v_plan_id THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
        END IF;
    END LOOP;

    FOREACH v_plan_id IN ARRAY v_plan_ids LOOP
        v_plan_rank := CASE v_plan_id
            WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_capacity := v_preflight.plan_catalog_snapshot
            ->v_plan_id->'relationshipCapacity';
        IF v_capacity_rank IS NULL
           AND p_target_followers_count <= (v_capacity->>'followers')::INTEGER
           AND p_target_following_count <= (v_capacity->>'following')::INTEGER THEN
            v_capacity_rank := v_plan_rank;
            v_capacity_required_plan_id := v_plan_id;
        END IF;
    END LOOP;

    IF v_capacity_rank IS NOT NULL THEN
        FOREACH v_plan_id IN ARRAY v_plan_ids LOOP
            v_plan_rank := CASE v_plan_id
                WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
            v_launch_status := v_preflight.launch_status_snapshot->>v_plan_id;
            IF v_required_rank IS NULL
               AND v_plan_rank >= v_capacity_rank
               AND (
                   (
                       v_preflight.access_mode = 'test_entitlement'
                       AND v_launch_status <> 'disabled'
                   )
                   OR (
                       v_preflight.access_mode = 'production'
                       AND v_launch_status = 'production'
                   )
               ) THEN
                v_required_rank := v_plan_rank;
                v_required_plan_id := v_plan_id;
            END IF;
        END LOOP;
    END IF;

    IF v_capacity_rank IS NULL THEN
        v_status := 'blocked';
        v_error_code := 'ANALYSIS_V2_OVER_PLUS_CAPACITY';
    ELSIF v_required_rank IS NULL THEN
        v_status := 'blocked';
        v_error_code := 'ANALYSIS_V2_PLAN_NOT_ALLOWED';
    END IF;

    FOREACH v_plan_id IN ARRAY v_plan_ids LOOP
        v_plan_rank := CASE v_plan_id
            WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog_plan := v_preflight.plan_catalog_snapshot->v_plan_id;
        v_launch_status := v_preflight.launch_status_snapshot->>v_plan_id;

        IF v_capacity_rank IS NULL THEN
            v_selection_state := 'unavailable';
            v_unavailable_reason := 'over_plus_capacity';
        ELSIF v_plan_rank < v_capacity_rank THEN
            v_selection_state := 'unavailable';
            v_unavailable_reason := 'below_required_plan';
        ELSIF (
            v_preflight.access_mode = 'test_entitlement'
            AND v_launch_status = 'disabled'
        ) OR (
            v_preflight.access_mode = 'production'
            AND v_launch_status <> 'production'
        ) THEN
            v_selection_state := 'unavailable';
            v_unavailable_reason := 'launch_gate';
        ELSIF v_plan_id = v_required_plan_id THEN
            v_selection_state := 'required';
            v_unavailable_reason := NULL;
        ELSE
            v_selection_state := 'available_upgrade';
            v_unavailable_reason := NULL;
        END IF;

        v_cards := v_cards || pg_catalog.jsonb_build_object(
            v_plan_id,
            pg_catalog.jsonb_build_object(
                'launchStatus', v_launch_status,
                'relationshipCapacity', v_catalog_plan->'relationshipCapacity',
                'detailedMutualLimit', v_catalog_plan->'detailedMutualLimit',
                'selectionState', v_selection_state,
                'unavailableReason', v_unavailable_reason
            )
        );
    END LOOP;

    IF v_status = 'ready' AND NOT public.analysis_v2_valid_plan_cards_snapshot(v_cards) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET target_followers_count = CASE WHEN v_status = 'ready'
            THEN p_target_followers_count ELSE preflight.target_followers_count END,
        target_following_count = CASE WHEN v_status = 'ready'
            THEN p_target_following_count ELSE preflight.target_following_count END,
        target_is_private = CASE WHEN v_status = 'ready'
            THEN FALSE ELSE preflight.target_is_private END,
        capacity_required_plan_id = CASE WHEN v_status = 'ready'
            THEN v_capacity_required_plan_id ELSE preflight.capacity_required_plan_id END,
        required_plan_id = CASE WHEN v_status = 'ready'
            THEN v_required_plan_id ELSE preflight.required_plan_id END,
        plan_cards_snapshot = CASE WHEN v_status = 'ready'
            THEN v_cards ELSE preflight.plan_cards_snapshot END,
        admission_status = v_status,
        admission_refreshed_at = v_now,
        admission_claim_token = NULL,
        admission_lease_expires_at = NULL,
        admission_error_code = v_error_code,
        admission_target_followers_count = p_target_followers_count,
        admission_target_following_count = p_target_following_count,
        admission_capacity_required_plan_id = v_capacity_required_plan_id,
        admission_required_plan_id = v_required_plan_id,
        admission_plan_cards_snapshot = v_cards,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    RETURN QUERY SELECT v_status, v_error_code;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_preflight_admission(
    UUID, UUID, TEXT, TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_analysis_v2_preflight_admission_dispatched(
    UUID, UUID, INTEGER, INTEGER, UUID
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_analysis_v2_preflight_admission_dispatch(
    UUID, UUID, INTEGER, INTEGER, UUID
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight_admission(
    UUID, INTEGER, INTEGER, UUID, UUID, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.release_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_analysis_v2_preflight_admission_failure(
    UUID, INTEGER, UUID
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.block_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.complete_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_preflight_admission(
    UUID, UUID, TEXT, TEXT, UUID, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_preflight_admission_dispatched(
    UUID, UUID, INTEGER, INTEGER, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_v2_preflight_admission_dispatch(
    UUID, UUID, INTEGER, INTEGER, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight_admission(
    UUID, INTEGER, INTEGER, UUID, UUID, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_analysis_v2_preflight_admission_failure(
    UUID, INTEGER, UUID
) TO service_role;
GRANT EXECUTE ON FUNCTION public.block_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_preflight_admission(
    UUID, INTEGER, UUID, TEXT, INTEGER, INTEGER, BOOLEAN
) TO service_role;

-- Preserve the mature request/job transaction behind a private helper. The public wrapper accepts
-- consumed replays, while first creation requires the exact owner-selected, short-lived admission.
ALTER FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT)
    RENAME TO analysis_v2_consume_entitlement_after_admission_internal;

REVOKE ALL ON FUNCTION public.analysis_v2_consume_entitlement_after_admission_internal(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.consume_analysis_v2_test_entitlement(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT,
    p_admission_token UUID
)
RETURNS TABLE(
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT,
    request_status TEXT,
    background_processing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_selected_card JSONB;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_entitlement_jti_hash IS NULL
       OR p_entitlement_jti_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_ENTITLEMENT_INPUT', ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_entitlement_jti_hash, 0)
    );
    PERFORM 1 FROM public.users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status <> 'consumed' THEN
        IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_EXPIRED', ERRCODE = 'P0001';
        END IF;
        IF v_preflight.status <> 'ready'
           OR v_preflight.admission_status <> 'ready'
           OR v_preflight.admission_refreshed_at IS NULL
           OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id
           OR v_preflight.admission_entitlement_jti_hash
                IS DISTINCT FROM p_entitlement_jti_hash
           OR v_preflight.admission_token IS DISTINCT FROM p_admission_token
           OR v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'
           OR v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
        END IF;

        v_selected_card := v_preflight.plan_cards_snapshot->p_selected_plan_id;
        IF v_preflight.target_followers_count IS NULL
           OR v_preflight.target_following_count IS NULL
           OR v_preflight.capacity_required_plan_id IS NULL
           OR v_preflight.required_plan_id IS NULL
           OR NOT public.analysis_v2_valid_plan_cards_snapshot(
               v_preflight.plan_cards_snapshot
           )
           OR v_selected_card->>'selectionState'
                NOT IN ('required', 'available_upgrade')
           OR v_preflight.target_followers_count
                > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
           OR v_preflight.target_following_count
                > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN QUERY
    SELECT consumed.request_id,
           consumed.created,
           consumed.initial_job_key,
           consumed.request_status,
           consumed.background_processing
    FROM public.analysis_v2_consume_entitlement_after_admission_internal(
        p_preflight_id,
        p_user_id,
        p_selected_plan_id,
        p_entitlement_jti_hash
    ) AS consumed;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_analysis_v2_test_entitlement(
    UUID, UUID, TEXT, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_analysis_v2_test_entitlement(
    UUID, UUID, TEXT, TEXT, UUID
) TO service_role;

COMMENT ON FUNCTION public.consume_analysis_v2_test_entitlement(
    UUID, UUID, TEXT, TEXT, UUID
) IS
    'Consumes/replays an entitlement; first creation requires a recent durable Cloud Run count-only admission for the selected plan.';
