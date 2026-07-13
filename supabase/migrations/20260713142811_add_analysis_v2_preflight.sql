-- Phase B: service-owned V2 target preflight and one-time test entitlement consumption.
-- Raw upstream profile URLs intentionally remain in service-only storage. Public APIs must mint
-- signed image-proxy URLs instead of exposing this table through PostgREST or Realtime.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_launch_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    plan_id TEXT;
BEGIN
    IF p_snapshot IS NULL
       OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
       OR pg_catalog.octet_length(p_snapshot::TEXT) > 2048
       OR NOT (p_snapshot ?& ARRAY['basic', 'standard', 'plus'])
       OR p_snapshot - ARRAY['basic', 'standard', 'plus'] <> '{}'::JSONB THEN
        RETURN FALSE;
    END IF;

    FOREACH plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        IF p_snapshot->>plan_id IS NULL
           OR p_snapshot->>plan_id NOT IN ('production', 'test_only', 'disabled') THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    plan_id TEXT;
    card JSONB;
    capacity JSONB;
    required_count INTEGER := 0;
    selection_state TEXT;
    unavailable_reason TEXT;
BEGIN
    IF p_snapshot IS NULL
       OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
       OR pg_catalog.octet_length(p_snapshot::TEXT) > 8192
       OR NOT (p_snapshot ?& ARRAY['basic', 'standard', 'plus'])
       OR p_snapshot - ARRAY['basic', 'standard', 'plus'] <> '{}'::JSONB THEN
        RETURN FALSE;
    END IF;

    FOREACH plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        card := p_snapshot->plan_id;
        IF pg_catalog.jsonb_typeof(card) <> 'object'
           OR NOT (card ?& ARRAY[
               'launchStatus',
               'selectionState',
               'unavailableReason',
               'relationshipCapacity',
               'detailedMutualLimit'
           ])
           OR card - ARRAY[
               'launchStatus',
               'selectionState',
               'unavailableReason',
               'relationshipCapacity',
               'detailedMutualLimit'
           ] <> '{}'::JSONB
           OR card->>'launchStatus' IS NULL
           OR card->>'launchStatus' NOT IN ('production', 'test_only', 'disabled')
           OR card->>'selectionState' IS NULL
           OR card->>'selectionState' NOT IN ('required', 'available_upgrade', 'unavailable')
           OR pg_catalog.jsonb_typeof(card->'detailedMutualLimit') <> 'number'
           OR card->>'detailedMutualLimit' !~ '^[0-9]+$'
           OR (card->>'detailedMutualLimit')::NUMERIC < 1
           OR (card->>'detailedMutualLimit')::NUMERIC > 100000 THEN
            RETURN FALSE;
        END IF;

        capacity := card->'relationshipCapacity';
        IF pg_catalog.jsonb_typeof(capacity) <> 'object'
           OR NOT (capacity ?& ARRAY['followers', 'following'])
           OR capacity - ARRAY['followers', 'following'] <> '{}'::JSONB
           OR pg_catalog.jsonb_typeof(capacity->'followers') <> 'number'
           OR pg_catalog.jsonb_typeof(capacity->'following') <> 'number'
           OR capacity->>'followers' !~ '^[0-9]+$'
           OR capacity->>'following' !~ '^[0-9]+$'
           OR (capacity->>'followers')::NUMERIC > 10000000
           OR (capacity->>'following')::NUMERIC > 10000000 THEN
            RETURN FALSE;
        END IF;

        selection_state := card->>'selectionState';
        unavailable_reason := card->>'unavailableReason';
        IF selection_state = 'unavailable' THEN
            IF unavailable_reason IS NULL
               OR unavailable_reason NOT IN ('below_required_plan', 'launch_gate') THEN
                RETURN FALSE;
            END IF;
        ELSIF card->'unavailableReason' <> 'null'::JSONB THEN
            RETURN FALSE;
        END IF;

        IF selection_state = 'required' THEN
            required_count := required_count + 1;
        END IF;
    END LOOP;

    RETURN required_count = 1;
EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    plan_id TEXT;
    plan_definition JSONB;
    capacity JSONB;
    previous_followers INTEGER := 0;
    previous_following INTEGER := 0;
    previous_detailed_limit INTEGER := 0;
BEGIN
    IF p_snapshot IS NULL
       OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
       OR pg_catalog.octet_length(p_snapshot::TEXT) > 4096
       OR NOT (p_snapshot ?& ARRAY['basic', 'standard', 'plus'])
       OR p_snapshot - ARRAY['basic', 'standard', 'plus'] <> '{}'::JSONB THEN
        RETURN FALSE;
    END IF;

    FOREACH plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        plan_definition := p_snapshot->plan_id;
        IF pg_catalog.jsonb_typeof(plan_definition) <> 'object'
           OR NOT (plan_definition ?& ARRAY[
               'launchStatus', 'relationshipCapacity', 'detailedMutualLimit'
           ])
           OR plan_definition - ARRAY[
               'launchStatus', 'relationshipCapacity', 'detailedMutualLimit'
           ] <> '{}'::JSONB
           OR plan_definition->>'launchStatus' NOT IN (
               'production', 'test_only', 'disabled'
           )
           OR pg_catalog.jsonb_typeof(plan_definition->'detailedMutualLimit') <> 'number'
           OR plan_definition->>'detailedMutualLimit' !~ '^[0-9]+$'
           OR (plan_definition->>'detailedMutualLimit')::NUMERIC < 1
           OR (plan_definition->>'detailedMutualLimit')::NUMERIC > 100000 THEN
            RETURN FALSE;
        END IF;

        capacity := plan_definition->'relationshipCapacity';
        IF pg_catalog.jsonb_typeof(capacity) <> 'object'
           OR NOT (capacity ?& ARRAY['followers', 'following'])
           OR capacity - ARRAY['followers', 'following'] <> '{}'::JSONB
           OR pg_catalog.jsonb_typeof(capacity->'followers') <> 'number'
           OR pg_catalog.jsonb_typeof(capacity->'following') <> 'number'
           OR capacity->>'followers' !~ '^[0-9]+$'
           OR capacity->>'following' !~ '^[0-9]+$'
           OR (capacity->>'followers')::NUMERIC < 1
           OR (capacity->>'following')::NUMERIC < 1
           OR (capacity->>'followers')::NUMERIC > 10000000
           OR (capacity->>'following')::NUMERIC > 10000000
           OR (capacity->>'followers')::INTEGER <= previous_followers
           OR (capacity->>'following')::INTEGER <= previous_following
           OR (plan_definition->>'detailedMutualLimit')::INTEGER <= previous_detailed_limit THEN
            RETURN FALSE;
        END IF;

        previous_followers := (capacity->>'followers')::INTEGER;
        previous_following := (capacity->>'following')::INTEGER;
        previous_detailed_limit := (plan_definition->>'detailedMutualLimit')::INTEGER;
    END LOOP;
    RETURN TRUE;
EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_pricing_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    plan_id TEXT;
    price JSONB;
BEGIN
    IF p_snapshot IS NULL
       OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
       OR pg_catalog.octet_length(p_snapshot::TEXT) > 8192
       OR NOT (p_snapshot ?& ARRAY['basic', 'standard', 'plus'])
       OR p_snapshot - ARRAY['basic', 'standard', 'plus'] <> '{}'::JSONB THEN
        RETURN FALSE;
    END IF;

    FOREACH plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        price := p_snapshot->plan_id;
        IF pg_catalog.jsonb_typeof(price) <> 'object'
           OR NOT (price ?& ARRAY['status', 'currency', 'amountKrw'])
           OR price - ARRAY['status', 'currency', 'amountKrw'] <> '{}'::JSONB
           OR price->>'currency' IS DISTINCT FROM 'KRW'
           OR price->>'status' IS NULL
           OR price->>'status' NOT IN ('deferred', 'quoted') THEN
            RETURN FALSE;
        END IF;

        IF price->>'status' = 'deferred' THEN
            IF price->'amountKrw' <> 'null'::JSONB THEN
                RETURN FALSE;
            END IF;
        ELSIF pg_catalog.jsonb_typeof(price->'amountKrw') <> 'number'
              OR price->>'amountKrw' !~ '^[0-9]+$'
              OR (price->>'amountKrw')::NUMERIC < 1
              OR (price->>'amountKrw')::NUMERIC > 1000000000 THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN FALSE;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    item RECORD;
    item_count INTEGER := 0;
BEGIN
    IF p_snapshot IS NULL
       OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
       OR p_snapshot = '{}'::JSONB
       OR pg_catalog.octet_length(p_snapshot::TEXT) > 8192 THEN
        RETURN FALSE;
    END IF;

    FOR item IN SELECT key, value FROM pg_catalog.jsonb_each(p_snapshot) LOOP
        item_count := item_count + 1;
        IF item_count > 16
           OR item.key !~ '^[A-Za-z][A-Za-z0-9._:-]{0,63}$'
           OR pg_catalog.jsonb_typeof(item.value) <> 'string'
           OR pg_catalog.char_length(item.value #>> '{}') < 1
           OR pg_catalog.char_length(item.value #>> '{}') > 128 THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_scope_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    capacity JSONB;
BEGIN
    IF p_snapshot IS NULL
       OR pg_catalog.jsonb_typeof(p_snapshot) <> 'object'
       OR NOT (p_snapshot ?& ARRAY['relationshipCapacity', 'detailedMutualLimit'])
       OR p_snapshot - ARRAY['relationshipCapacity', 'detailedMutualLimit'] <> '{}'::JSONB
       OR pg_catalog.jsonb_typeof(p_snapshot->'detailedMutualLimit') <> 'number'
       OR p_snapshot->>'detailedMutualLimit' !~ '^[0-9]+$'
       OR (p_snapshot->>'detailedMutualLimit')::NUMERIC < 1
       OR (p_snapshot->>'detailedMutualLimit')::NUMERIC > 100000 THEN
        RETURN FALSE;
    END IF;

    capacity := p_snapshot->'relationshipCapacity';
    RETURN pg_catalog.jsonb_typeof(capacity) = 'object'
        AND capacity ?& ARRAY['followers', 'following']
        AND capacity - ARRAY['followers', 'following'] = '{}'::JSONB
        AND pg_catalog.jsonb_typeof(capacity->'followers') = 'number'
        AND pg_catalog.jsonb_typeof(capacity->'following') = 'number'
        AND capacity->>'followers' ~ '^[0-9]+$'
        AND capacity->>'following' ~ '^[0-9]+$'
        AND (capacity->>'followers')::NUMERIC <= 10000000
        AND (capacity->>'following')::NUMERIC <= 10000000;
EXCEPTION
    WHEN invalid_text_representation OR numeric_value_out_of_range THEN
        RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.analysis_v2_valid_scope_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_scope_snapshot(JSONB) TO service_role;

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY DEFAULT public.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    idempotency_key VARCHAR(128) NOT NULL,
    target_instagram_id VARCHAR(30) NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    exclusion_decision TEXT NOT NULL DEFAULT 'pending',
    excluded_instagram_id VARCHAR(30),
    access_mode TEXT NOT NULL,
    launch_status_snapshot JSONB NOT NULL,
    plan_catalog_snapshot JSONB NOT NULL,
    plan_cards_snapshot JSONB,
    pricing_version VARCHAR(64) NOT NULL,
    pricing_snapshot JSONB NOT NULL,
    policy_versions_snapshot JSONB NOT NULL,
    target_full_name VARCHAR(200),
    target_bio VARCHAR(2200),
    target_profile_image_url TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    error_code TEXT,
    worker_attempt_count INTEGER NOT NULL DEFAULT 0,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_state TEXT NOT NULL DEFAULT 'unreserved',
    dispatch_token UUID,
    dispatch_reserved_at TIMESTAMP WITH TIME ZONE,
    dispatched_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    claimed_at TIMESTAMP WITH TIME ZONE,
    exclusion_decided_at TIMESTAMP WITH TIME ZONE,
    ready_at TIMESTAMP WITH TIME ZONE,
    blocked_at TIMESTAMP WITH TIME ZONE,
    consumed_at TIMESTAMP WITH TIME ZONE,
    pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
    consumed_request_id UUID UNIQUE REFERENCES public.analysis_requests(id)
        ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT analysis_preflights_idempotency_key_check CHECK (
        char_length(idempotency_key) BETWEEN 16 AND 128
        AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'
    ),
    CONSTRAINT analysis_preflights_target_username_check CHECK (
        target_instagram_id ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_preflights_status_check CHECK (
        status IN ('pending', 'processing', 'ready', 'blocked', 'consumed', 'expired')
    ),
    CONSTRAINT analysis_preflights_exclusion_check CHECK (
        (exclusion_decision = 'pending' AND excluded_instagram_id IS NULL)
        OR (exclusion_decision = 'skip' AND excluded_instagram_id IS NULL)
        OR (
            exclusion_decision = 'exclude'
            AND excluded_instagram_id ~ '^[a-z0-9._]{1,30}$'
            AND excluded_instagram_id <> target_instagram_id
        )
    ),
    CONSTRAINT analysis_preflights_access_mode_check CHECK (
        access_mode IN ('production', 'test_entitlement')
    ),
    CONSTRAINT analysis_preflights_launch_snapshot_check CHECK (
        public.analysis_v2_valid_launch_snapshot(launch_status_snapshot)
    ),
    CONSTRAINT analysis_preflights_plan_catalog_snapshot_check CHECK (
        public.analysis_v2_valid_plan_catalog_snapshot(plan_catalog_snapshot)
    ),
    CONSTRAINT analysis_preflights_plan_cards_snapshot_check CHECK (
        plan_cards_snapshot IS NULL
        OR public.analysis_v2_valid_plan_cards_snapshot(plan_cards_snapshot)
    ),
    CONSTRAINT analysis_preflights_pricing_version_check CHECK (
        char_length(pricing_version) BETWEEN 1 AND 64
        AND pricing_version ~ '^[A-Za-z0-9._:-]+$'
    ),
    CONSTRAINT analysis_preflights_pricing_snapshot_check CHECK (
        public.analysis_v2_valid_pricing_snapshot(pricing_snapshot)
    ),
    CONSTRAINT analysis_preflights_policy_versions_snapshot_check CHECK (
        public.analysis_v2_valid_policy_versions_snapshot(policy_versions_snapshot)
    ),
    CONSTRAINT analysis_preflights_profile_image_check CHECK (
        target_profile_image_url IS NULL
        OR (
            char_length(target_profile_image_url) <= 8192
            AND target_profile_image_url ~* '^https://'
        )
    ),
    CONSTRAINT analysis_preflights_target_counts_check CHECK (
        (target_followers_count IS NULL AND target_following_count IS NULL)
        OR (
            target_followers_count BETWEEN 0 AND 10000000
            AND target_following_count BETWEEN 0 AND 10000000
        )
    ),
    CONSTRAINT analysis_preflights_plan_ids_check CHECK (
        (capacity_required_plan_id IS NULL AND required_plan_id IS NULL)
        OR (
            capacity_required_plan_id IN ('basic', 'standard', 'plus')
            AND required_plan_id IN ('basic', 'standard', 'plus')
            AND CASE required_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
                >= CASE capacity_required_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
        )
    ),
    CONSTRAINT analysis_preflights_error_code_check CHECK (
        error_code IS NULL OR error_code IN (
            'TARGET_NOT_FOUND',
            'TARGET_PRIVATE',
            'TARGET_UNSUPPORTED',
            'OVER_PLUS_CAPACITY',
            'EXCLUSION_REQUIRED',
            'INVALID_EXCLUSION',
            'PLAN_UPGRADE_REQUIRED',
            'RELATIONSHIP_INCOMPLETE',
            'PROFILE_EVIDENCE_INCOMPLETE',
            'QUEUE_UNAVAILABLE',
            'AI_RATE_LIMITED',
            'AI_AMBIGUOUS_RESULT',
            'ANALYSIS_FAILED'
        )
    ),
    CONSTRAINT analysis_preflights_status_payload_check CHECK (
        (
            status IN ('ready', 'consumed')
            AND target_followers_count IS NOT NULL
            AND target_following_count IS NOT NULL
            AND target_is_private = FALSE
            AND capacity_required_plan_id IS NOT NULL
            AND required_plan_id IS NOT NULL
            AND plan_cards_snapshot IS NOT NULL
            AND ready_at IS NOT NULL
            AND error_code IS NULL
        )
        OR status NOT IN ('ready', 'consumed')
    ),
    CONSTRAINT analysis_preflights_blocked_payload_check CHECK (
        (status = 'blocked' AND error_code IS NOT NULL AND blocked_at IS NOT NULL)
        OR (status <> 'blocked' AND error_code IS NULL AND blocked_at IS NULL)
    ),
    CONSTRAINT analysis_preflights_consumed_payload_check CHECK (
        (
            status = 'consumed'
            AND consumed_at IS NOT NULL
            AND consumed_request_id IS NOT NULL
            AND exclusion_decision IN ('exclude', 'skip')
        )
        OR (status <> 'consumed' AND consumed_at IS NULL AND consumed_request_id IS NULL)
    ),
    CONSTRAINT analysis_preflights_lease_pair_check CHECK (
        (lease_token IS NULL AND lease_expires_at IS NULL)
        OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL AND status = 'processing')
    ),
    CONSTRAINT analysis_preflights_attempt_count_check CHECK (
        worker_attempt_count BETWEEN 0 AND 7
    ),
    CONSTRAINT analysis_preflights_dispatch_check CHECK (
        dispatch_generation BETWEEN 0 AND 100
        AND dispatch_state IN ('unreserved', 'reserved', 'enqueued')
        AND (
            (
                dispatch_state = 'unreserved'
                AND dispatch_generation = 0
                AND dispatch_token IS NULL
                AND dispatch_reserved_at IS NULL
                AND dispatched_at IS NULL
            )
            OR (
                dispatch_state = 'reserved'
                AND dispatch_generation > 0
                AND dispatch_token IS NOT NULL
                AND dispatch_reserved_at IS NOT NULL
                AND dispatched_at IS NULL
            )
            OR (
                dispatch_state = 'enqueued'
                AND dispatch_generation > 0
                AND dispatch_token IS NULL
                AND dispatch_reserved_at IS NOT NULL
                AND dispatched_at IS NOT NULL
            )
        )
    ),
    CONSTRAINT analysis_preflights_ttl_check CHECK (
        expires_at = created_at + INTERVAL '30 minutes'
    ),
    CONSTRAINT analysis_preflights_timestamp_order_check CHECK (
        updated_at >= created_at
        AND (claimed_at IS NULL OR claimed_at >= created_at)
        AND (dispatch_reserved_at IS NULL OR dispatch_reserved_at >= created_at)
        AND (dispatched_at IS NULL OR dispatched_at >= dispatch_reserved_at)
        AND (exclusion_decided_at IS NULL OR exclusion_decided_at >= created_at)
        AND (ready_at IS NULL OR ready_at >= created_at)
        AND (blocked_at IS NULL OR blocked_at >= created_at)
        AND (consumed_at IS NULL OR consumed_at >= created_at)
        AND (pii_scrubbed_at IS NULL OR pii_scrubbed_at >= created_at)
        AND (pii_scrubbed_at IS NULL OR status IN ('expired', 'consumed'))
    )
);

CREATE UNIQUE INDEX idx_analysis_preflights_user_idempotency
    ON public.analysis_preflights(user_id, idempotency_key);
CREATE UNIQUE INDEX idx_analysis_preflights_one_active_per_user
    ON public.analysis_preflights(user_id)
    WHERE status IN ('pending', 'processing', 'ready');
CREATE INDEX idx_analysis_preflights_user_created
    ON public.analysis_preflights(user_id, created_at DESC);
CREATE INDEX idx_analysis_preflights_created
    ON public.analysis_preflights(created_at DESC);
CREATE INDEX idx_analysis_preflights_active_expiry
    ON public.analysis_preflights(expires_at, user_id)
    WHERE status IN ('pending', 'processing', 'ready');
CREATE INDEX idx_analysis_preflights_pending_created
    ON public.analysis_preflights(created_at, id)
    WHERE status = 'pending';
CREATE INDEX idx_analysis_preflights_dispatch_recovery
    ON public.analysis_preflights(dispatch_state, dispatched_at, dispatch_reserved_at)
    WHERE status = 'pending';
CREATE INDEX idx_analysis_preflights_lease_expiry
    ON public.analysis_preflights(lease_expires_at, id)
    WHERE status = 'processing' AND lease_token IS NOT NULL;

ALTER TABLE public.analysis_preflights ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_preflights FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analysis_preflights TO service_role;

COMMENT ON TABLE public.analysis_preflights IS
    'Service-only 30-minute V2 target preflight; may contain a raw upstream profile image URL.';
COMMENT ON COLUMN public.analysis_preflights.plan_cards_snapshot IS
    'Bounded plan-card snapshot produced from the Phase A catalog; application code revalidates SSOT semantics.';
COMMENT ON COLUMN public.analysis_preflights.lease_token IS
    'Fencing token required for a worker to complete or block the attempt it claimed.';

ALTER TABLE public.analysis_requests
    ADD COLUMN pipeline_version TEXT,
    ADD COLUMN preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    ADD COLUMN excluded_instagram_id VARCHAR(30),
    ADD COLUMN exclusion_decision_snapshot TEXT,
    ADD COLUMN plan_access_mode_snapshot TEXT,
    ADD COLUMN capacity_required_plan_id_snapshot TEXT,
    ADD COLUMN required_plan_id_snapshot TEXT,
    ADD COLUMN selected_plan_id_snapshot TEXT,
    ADD COLUMN plan_launch_status_snapshot JSONB,
    ADD COLUMN plan_cards_snapshot JSONB,
    ADD COLUMN pricing_version_snapshot VARCHAR(64),
    ADD COLUMN pricing_snapshot JSONB,
    ADD COLUMN analysis_scope_snapshot JSONB,
    ADD COLUMN policy_versions_snapshot JSONB,
    ADD COLUMN relationship_coverage_summary JSONB,
    ADD COLUMN test_entitlement_jti_hash VARCHAR(64);

ALTER TABLE public.analysis_requests
    ADD CONSTRAINT analysis_requests_pipeline_version_check CHECK (
        pipeline_version IS NULL OR pipeline_version IN ('v1', 'v2')
    ),
    ADD CONSTRAINT analysis_requests_preflight_unique UNIQUE (preflight_id),
    ADD CONSTRAINT analysis_requests_v2_exclusion_check CHECK (
        pipeline_version IS DISTINCT FROM 'v2'
        OR (
            exclusion_decision_snapshot IS NOT NULL
            AND exclusion_decision_snapshot IN ('exclude', 'skip')
            AND (
                (exclusion_decision_snapshot = 'skip' AND excluded_instagram_id IS NULL)
                OR (
                    exclusion_decision_snapshot = 'exclude'
                    AND excluded_instagram_id ~ '^[a-z0-9._]{1,30}$'
                    AND excluded_instagram_id <> lower(target_instagram_id)
                )
            )
        )
    ),
    ADD CONSTRAINT analysis_requests_v2_plan_ids_check CHECK (
        pipeline_version IS DISTINCT FROM 'v2'
        OR (
            capacity_required_plan_id_snapshot IS NOT NULL
            AND required_plan_id_snapshot IS NOT NULL
            AND selected_plan_id_snapshot IS NOT NULL
            AND capacity_required_plan_id_snapshot IN ('basic', 'standard', 'plus')
            AND required_plan_id_snapshot IN ('basic', 'standard', 'plus')
            AND selected_plan_id_snapshot IN ('basic', 'standard', 'plus')
            AND CASE required_plan_id_snapshot WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
                >= CASE capacity_required_plan_id_snapshot WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
            AND CASE selected_plan_id_snapshot WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
                >= CASE required_plan_id_snapshot WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END
        )
    ),
    ADD CONSTRAINT analysis_requests_v2_snapshot_check CHECK (
        pipeline_version IS DISTINCT FROM 'v2'
        OR (
            preflight_id IS NOT NULL
            AND idempotency_key IS NOT NULL
            AND plan_access_mode_snapshot IN ('production', 'test_entitlement')
            AND public.analysis_v2_valid_launch_snapshot(plan_launch_status_snapshot)
            AND public.analysis_v2_valid_plan_cards_snapshot(plan_cards_snapshot)
            AND char_length(pricing_version_snapshot) BETWEEN 1 AND 64
            AND pricing_version_snapshot ~ '^[A-Za-z0-9._:-]+$'
            AND public.analysis_v2_valid_pricing_snapshot(pricing_snapshot)
            AND public.analysis_v2_valid_scope_snapshot(analysis_scope_snapshot)
            AND public.analysis_v2_valid_policy_versions_snapshot(policy_versions_snapshot)
            AND (
                relationship_coverage_summary IS NULL
                OR (
                    pg_catalog.jsonb_typeof(relationship_coverage_summary) = 'object'
                    AND pg_catalog.octet_length(relationship_coverage_summary::TEXT) <= 8192
                )
            )
            AND (
                (plan_access_mode_snapshot = 'test_entitlement'
                    AND test_entitlement_jti_hash ~ '^[a-f0-9]{64}$')
                OR (plan_access_mode_snapshot = 'production'
                    AND test_entitlement_jti_hash IS NULL)
            )
        )
    );

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
    ON TABLE public.analysis_requests FROM anon, authenticated;

CREATE TABLE public.analysis_v2_test_entitlement_consumptions (
    entitlement_jti_hash VARCHAR(64) PRIMARY KEY,
    preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE CASCADE,
    request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    selected_plan_id TEXT NOT NULL CHECK (selected_plan_id IN ('basic', 'standard', 'plus')),
    consumed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT analysis_v2_test_entitlement_jti_hash_check CHECK (
        entitlement_jti_hash ~ '^[a-f0-9]{64}$'
    )
);

CREATE INDEX idx_analysis_v2_test_entitlement_consumptions_user
    ON public.analysis_v2_test_entitlement_consumptions(user_id, consumed_at DESC);

ALTER TABLE public.analysis_v2_test_entitlement_consumptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_test_entitlement_consumptions
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.analysis_v2_test_entitlement_consumptions TO service_role;

COMMENT ON TABLE public.analysis_v2_test_entitlement_consumptions IS
    'One-time admin-signed V2 test entitlement use. Only the SHA-256 JTI hash is retained.';
COMMENT ON COLUMN public.analysis_v2_test_entitlement_consumptions.entitlement_jti_hash IS
    'Lowercase SHA-256 digest; the signed token, nonce, and raw JTI are never stored.';

CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_preflights(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_scrubbed_count INTEGER;
    v_deleted_count INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_MAINTENANCE_INPUT', ERRCODE = 'P0001';
    END IF;

    WITH expired AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status <> 'consumed'
          AND preflight.expires_at <= clock_timestamp()
          AND preflight.pii_scrubbed_at IS NULL
        ORDER BY preflight.expires_at, preflight.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired',
        target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20),
        target_full_name = NULL,
        target_bio = NULL,
        target_profile_image_url = NULL,
        target_followers_count = NULL,
        target_following_count = NULL,
        target_is_private = NULL,
        capacity_required_plan_id = NULL,
        required_plan_id = NULL,
        plan_cards_snapshot = NULL,
        error_code = NULL,
        blocked_at = NULL,
        ready_at = NULL,
        exclusion_decision = 'skip',
        excluded_instagram_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        pii_scrubbed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    FROM expired
    WHERE preflight.id = expired.id;

    GET DIAGNOSTICS v_scrubbed_count = ROW_COUNT;

    -- Keep a non-PII tombstone for the complete rolling-hour abuse budget.
    WITH deletable AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status = 'expired'
          AND preflight.created_at <= clock_timestamp() - INTERVAL '1 hour'
        ORDER BY preflight.created_at, preflight.id
        LIMIT p_limit
        FOR UPDATE SKIP LOCKED
    )
    DELETE FROM public.analysis_preflights AS preflight
    USING deletable
    WHERE preflight.id = deletable.id;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_scrubbed_count + v_deleted_count;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.scrub_terminal_analysis_v2_preflights(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_scrubbed_count INTEGER;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_MAINTENANCE_INPUT', ERRCODE = 'P0001';
    END IF;

    WITH terminal AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        JOIN public.analysis_requests AS analysis_request
          ON analysis_request.id = preflight.consumed_request_id
        WHERE preflight.status = 'consumed'
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.status IN ('completed', 'failed')
          AND preflight.pii_scrubbed_at IS NULL
        ORDER BY analysis_request.completed_at NULLS LAST, preflight.id
        LIMIT p_limit
        FOR UPDATE OF preflight SKIP LOCKED
    )
    UPDATE public.analysis_preflights AS preflight
    SET target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20),
        target_full_name = NULL,
        target_bio = NULL,
        target_profile_image_url = NULL,
        exclusion_decision = 'skip',
        excluded_instagram_id = NULL,
        pii_scrubbed_at = clock_timestamp(),
        updated_at = clock_timestamp()
    FROM terminal
    WHERE preflight.id = terminal.id;

    GET DIAGNOSTICS v_scrubbed_count = ROW_COUNT;
    RETURN v_scrubbed_count;
END;
$$;

REVOKE ALL ON FUNCTION public.scrub_terminal_analysis_v2_preflights(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.scrub_terminal_analysis_v2_preflights(INTEGER)
    TO service_role;

COMMENT ON FUNCTION public.purge_expired_analysis_v2_preflights(INTEGER) IS
    'Scrubs unconsumed PII at 30 minutes and deletes the rate-limit tombstone after one hour.';
COMMENT ON FUNCTION public.scrub_terminal_analysis_v2_preflights(INTEGER) IS
    'Bounded removal of duplicate preflight PII after the linked V2 request is terminal.';

CREATE OR REPLACE FUNCTION public.create_or_replay_analysis_v2_preflight(
    p_user_id UUID,
    p_email TEXT,
    p_auth_provider TEXT,
    p_target_instagram_id TEXT,
    p_idempotency_key TEXT,
    p_access_mode TEXT,
    p_launch_status_snapshot JSONB,
    p_plan_catalog_snapshot JSONB,
    p_pricing_version TEXT,
    p_pricing_snapshot JSONB,
    p_policy_versions_snapshot JSONB
)
RETURNS TABLE(
    preflight_id UUID,
    created BOOLEAN,
    preflight_status TEXT,
    expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_target_instagram_id TEXT;
    v_existing public.analysis_preflights%ROWTYPE;
    v_preflight_id UUID;
    v_plan_id TEXT;
    v_recent_preflight_count INTEGER;
    v_global_preflight_count INTEGER;
BEGIN
    IF p_user_id IS NULL
       OR p_email IS NULL
       OR pg_catalog.char_length(pg_catalog.btrim(p_email)) < 3
       OR pg_catalog.char_length(pg_catalog.btrim(p_email)) > 255
       OR pg_catalog.strpos(p_email, '@') < 2
       OR p_auth_provider IS NULL
       OR p_auth_provider !~ '^[a-z0-9._:-]{1,50}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_AUTH_INPUT', ERRCODE = 'P0001';
    END IF;

    v_target_instagram_id := pg_catalog.lower(pg_catalog.btrim(p_target_instagram_id));
    IF v_target_instagram_id IS NULL
       OR v_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
       OR p_idempotency_key IS NULL
       OR pg_catalog.char_length(p_idempotency_key) < 16
       OR pg_catalog.char_length(p_idempotency_key) > 128
       OR p_idempotency_key !~ '^[A-Za-z0-9._:-]+$'
       OR p_access_mode IS NULL
       OR p_access_mode NOT IN ('production', 'test_entitlement')
       OR NOT public.analysis_v2_valid_launch_snapshot(p_launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(p_plan_catalog_snapshot)
       OR p_pricing_version IS NULL
       OR pg_catalog.char_length(p_pricing_version) < 1
       OR pg_catalog.char_length(p_pricing_version) > 64
       OR p_pricing_version !~ '^[A-Za-z0-9._:-]+$'
       OR NOT public.analysis_v2_valid_pricing_snapshot(p_pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(p_policy_versions_snapshot) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_PREFLIGHT_INPUT', ERRCODE = 'P0001';
    END IF;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        IF p_plan_catalog_snapshot->v_plan_id->>'launchStatus'
            IS DISTINCT FROM p_launch_status_snapshot->>v_plan_id THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_PREFLIGHT_INPUT', ERRCODE = 'P0001';
        END IF;
    END LOOP;

    INSERT INTO public.users (id, email, provider, analysis_count, is_paid_user)
    VALUES (
        p_user_id,
        pg_catalog.btrim(p_email),
        p_auth_provider,
        0,
        FALSE
    )
    ON CONFLICT (id) DO NOTHING;

    PERFORM 1
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_AUTH_INPUT', ERRCODE = 'P0001';
    END IF;

    -- This user row is already locked, so user-scoped retention cannot invert lock order with
    -- another request. Cross-user maintenance runs only in the dedicated scheduled worker.
    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired',
        target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20),
        target_full_name = NULL,
        target_bio = NULL,
        target_profile_image_url = NULL,
        target_followers_count = NULL,
        target_following_count = NULL,
        target_is_private = NULL,
        capacity_required_plan_id = NULL,
        required_plan_id = NULL,
        plan_cards_snapshot = NULL,
        error_code = NULL,
        blocked_at = NULL,
        ready_at = NULL,
        exclusion_decision = 'skip',
        excluded_instagram_id = NULL,
        lease_token = NULL,
        lease_expires_at = NULL,
        pii_scrubbed_at = v_now,
        updated_at = v_now
    WHERE preflight.user_id = p_user_id
      AND preflight.status IN ('pending', 'processing', 'ready')
      AND preflight.expires_at <= v_now;

    SELECT preflight.*
    INTO v_existing
    FROM public.analysis_preflights AS preflight
    WHERE preflight.user_id = p_user_id
      AND preflight.idempotency_key = p_idempotency_key
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.status = 'expired' THEN
            RETURN QUERY SELECT v_existing.id, FALSE, 'expired'::TEXT, v_existing.expires_at;
            RETURN;
        END IF;
        IF v_existing.target_instagram_id IS DISTINCT FROM v_target_instagram_id
           OR v_existing.access_mode IS DISTINCT FROM p_access_mode THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
        END IF;

        RETURN QUERY SELECT v_existing.id, FALSE, v_existing.status, v_existing.expires_at;
        RETURN;
    END IF;

    -- Serialize only fresh global-budget checks. Idempotent replays returned above do not consume
    -- capacity or contend on this circuit breaker.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-preflight-global-hourly-budget', 0)
    );
    SELECT pg_catalog.count(*)::INTEGER
    INTO v_global_preflight_count
    FROM public.analysis_preflights AS recent_preflight
    WHERE recent_preflight.created_at > v_now - INTERVAL '1 hour';

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_recent_preflight_count
    FROM public.analysis_preflights AS recent_preflight
    WHERE recent_preflight.user_id = p_user_id
      AND recent_preflight.created_at > v_now - INTERVAL '1 hour';

    IF v_global_preflight_count >= 300
       OR v_recent_preflight_count >= 5 OR EXISTS (
        SELECT 1
        FROM public.analysis_preflights AS recent_preflight
        WHERE recent_preflight.user_id = p_user_id
          AND recent_preflight.created_at > v_now - INTERVAL '10 seconds'
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_RATE_LIMITED', ERRCODE = 'P0001';
    END IF;

    -- A fresh idempotency key intentionally supersedes an unfinished free preflight. The consumed
    -- analysis is immutable and is not part of this active-preflight set.
    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired',
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE preflight.user_id = p_user_id
      AND preflight.status IN ('pending', 'processing', 'ready');

    v_preflight_id := public.uuid_generate_v4();
    INSERT INTO public.analysis_preflights (
        id,
        user_id,
        idempotency_key,
        target_instagram_id,
        status,
        exclusion_decision,
        access_mode,
        launch_status_snapshot,
        plan_catalog_snapshot,
        pricing_version,
        pricing_snapshot,
        policy_versions_snapshot,
        created_at,
        updated_at,
        expires_at
    ) VALUES (
        v_preflight_id,
        p_user_id,
        p_idempotency_key,
        v_target_instagram_id,
        'pending',
        'pending',
        p_access_mode,
        p_launch_status_snapshot,
        p_plan_catalog_snapshot,
        p_pricing_version,
        p_pricing_snapshot,
        p_policy_versions_snapshot,
        v_now,
        v_now,
        v_now + INTERVAL '30 minutes'
    );

    RETURN QUERY
    SELECT v_preflight_id, TRUE, 'pending'::TEXT, v_now + INTERVAL '30 minutes';
END;
$$;

REVOKE ALL ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_preflight_dispatch(
    p_preflight_id UUID,
    p_user_id UUID,
    p_dispatch_token UUID
)
RETURNS TABLE(
    should_enqueue BOOLEAN,
    dispatch_generation INTEGER,
    reservation_token UUID,
    preflight_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL OR p_user_id IS NULL OR p_dispatch_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_DISPATCH_INPUT', ERRCODE = 'P0001';
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

    IF v_preflight.expires_at <= v_now THEN
        IF v_preflight.status IN ('pending', 'processing', 'ready') THEN
            UPDATE public.analysis_preflights
            SET status = 'expired',
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = v_now
            WHERE id = v_preflight.id;
        END IF;
        RETURN QUERY SELECT FALSE, v_preflight.dispatch_generation, NULL::UUID, 'expired'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.status <> 'pending' THEN
        RETURN QUERY
        SELECT FALSE, v_preflight.dispatch_generation, NULL::UUID, v_preflight.status;
        RETURN;
    END IF;

    IF v_preflight.dispatch_state = 'reserved'
       AND v_preflight.dispatch_reserved_at > v_now - INTERVAL '2 minutes' THEN
        RETURN QUERY
        SELECT TRUE, v_preflight.dispatch_generation, v_preflight.dispatch_token, 'pending'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.dispatch_state = 'enqueued' THEN
        RETURN QUERY
        SELECT FALSE, v_preflight.dispatch_generation, NULL::UUID, 'pending'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.dispatch_generation >= 100 THEN
        UPDATE public.analysis_preflights
        SET status = 'blocked',
            error_code = 'QUEUE_UNAVAILABLE',
            blocked_at = v_now,
            updated_at = v_now
        WHERE id = v_preflight.id;
        RETURN QUERY SELECT FALSE, v_preflight.dispatch_generation, NULL::UUID, 'blocked'::TEXT;
        RETURN;
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET dispatch_generation = preflight.dispatch_generation + 1,
        dispatch_state = 'reserved',
        dispatch_token = p_dispatch_token,
        dispatch_reserved_at = v_now,
        dispatched_at = NULL,
        updated_at = v_now
    WHERE id = v_preflight.id;

    RETURN QUERY
    SELECT TRUE, v_preflight.dispatch_generation + 1, p_dispatch_token, 'pending'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_preflight_dispatch(UUID, UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_preflight_dispatch(UUID, UUID, UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_preflight_dispatched(
    p_preflight_id UUID,
    p_user_id UUID,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_dispatch_generation IS NULL
       OR p_dispatch_generation < 1
       OR p_dispatch_generation > 100
       OR p_dispatch_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_DISPATCH_INPUT', ERRCODE = 'P0001';
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

    IF v_preflight.dispatch_state = 'enqueued'
       AND v_preflight.dispatch_generation = p_dispatch_generation THEN
        RETURN FALSE;
    END IF;
    IF v_preflight.dispatch_state <> 'reserved'
       OR v_preflight.dispatch_generation <> p_dispatch_generation
       OR v_preflight.dispatch_token IS DISTINCT FROM p_dispatch_token THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DISPATCH_RESERVATION_LOST', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights
    SET dispatch_state = 'enqueued',
        dispatch_token = NULL,
        dispatched_at = v_now,
        updated_at = v_now
    WHERE id = v_preflight.id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_analysis_v2_preflight_dispatched(UUID, UUID, INTEGER, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_analysis_v2_preflight_dispatched(UUID, UUID, INTEGER, UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.claim_analysis_v2_preflight(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE(
    preflight_id UUID,
    user_id UUID,
    claimed BOOLEAN,
    target_instagram_id TEXT,
    access_mode TEXT,
    plan_catalog_snapshot JSONB,
    pricing_version TEXT,
    pricing_snapshot JSONB,
    worker_attempt_count INTEGER,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    preflight_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_lease_expires_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_lease_seconds IS NULL
       OR p_lease_seconds < 30
       OR p_lease_seconds > 300 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_CLAIM_INPUT', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.expires_at <= v_now THEN
        IF v_preflight.status IN ('pending', 'processing', 'ready') THEN
            UPDATE public.analysis_preflights
            SET status = 'expired',
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = v_now
            WHERE id = v_preflight.id;
        END IF;
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, FALSE, NULL::TEXT,
            v_preflight.access_mode, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            NULL::TIMESTAMPTZ, 'expired'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.status = 'processing'
       AND v_preflight.lease_token = p_claim_token
       AND v_preflight.lease_expires_at > v_now THEN
        v_lease_expires_at := LEAST(
            v_preflight.expires_at,
            v_now + pg_catalog.make_interval(secs => p_lease_seconds)
        );
        UPDATE public.analysis_preflights
        SET lease_expires_at = v_lease_expires_at,
            updated_at = v_now
        WHERE id = v_preflight.id;
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, TRUE, v_preflight.target_instagram_id,
            v_preflight.access_mode, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            v_lease_expires_at, 'processing'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.status = 'processing' AND v_preflight.lease_expires_at > v_now THEN
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, FALSE, NULL::TEXT,
            v_preflight.access_mode, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            v_preflight.lease_expires_at, 'processing'::TEXT;
        RETURN;
    END IF;

    IF v_preflight.status NOT IN ('pending', 'processing') THEN
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, FALSE, NULL::TEXT,
            v_preflight.access_mode, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            NULL::TIMESTAMPTZ, v_preflight.status;
        RETURN;
    END IF;

    -- Transport/authentication failures do not consume this counter. The queue retries those for
    -- the full preflight TTL, while seven successful database claims bound crawler executions.
    IF v_preflight.worker_attempt_count >= 7 THEN
        UPDATE public.analysis_preflights
        SET status = 'blocked',
            error_code = 'ANALYSIS_FAILED',
            blocked_at = v_now,
            lease_token = NULL,
            lease_expires_at = NULL,
            updated_at = v_now
        WHERE id = v_preflight.id;
        RETURN QUERY
        SELECT v_preflight.id, v_preflight.user_id, FALSE, NULL::TEXT,
            v_preflight.access_mode, v_preflight.plan_catalog_snapshot,
            v_preflight.pricing_version, v_preflight.pricing_snapshot,
            v_preflight.worker_attempt_count,
            NULL::TIMESTAMPTZ, 'blocked'::TEXT;
        RETURN;
    END IF;

    v_lease_expires_at := LEAST(
        v_preflight.expires_at,
        v_now + pg_catalog.make_interval(secs => p_lease_seconds)
    );
    UPDATE public.analysis_preflights AS preflight
    SET status = 'processing',
        worker_attempt_count = preflight.worker_attempt_count + 1,
        lease_token = p_claim_token,
        lease_expires_at = v_lease_expires_at,
        claimed_at = v_now,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    RETURN QUERY
    SELECT v_preflight.id, v_preflight.user_id, TRUE, v_preflight.target_instagram_id,
        v_preflight.access_mode, v_preflight.plan_catalog_snapshot,
        v_preflight.pricing_version, v_preflight.pricing_snapshot,
        v_preflight.worker_attempt_count + 1,
        v_lease_expires_at, 'processing'::TEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER)
    TO service_role;

CREATE OR REPLACE FUNCTION public.release_analysis_preflight_claim(
    p_preflight_id UUID,
    p_claim_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_CLAIM_INPUT', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.expires_at <= v_now THEN
        RETURN FALSE;
    END IF;

    UPDATE public.analysis_preflights
    SET status = 'pending',
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE id = v_preflight.id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.release_analysis_preflight_claim(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_preflight_claim(UUID, UUID)
    TO service_role;

CREATE OR REPLACE FUNCTION public.set_analysis_v2_preflight_exclusion(
    p_preflight_id UUID,
    p_user_id UUID,
    p_decision TEXT,
    p_excluded_instagram_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_excluded_instagram_id TEXT;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_decision IS NULL
       OR p_decision NOT IN ('exclude', 'skip') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    IF p_decision = 'exclude' THEN
        v_excluded_instagram_id := pg_catalog.lower(pg_catalog.btrim(p_excluded_instagram_id));
        IF v_excluded_instagram_id !~ '^[a-z0-9._]{1,30}$' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
        END IF;
    ELSIF p_excluded_instagram_id IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
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
    IF v_preflight.status = 'consumed' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_CONSUMED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status NOT IN ('pending', 'processing', 'ready') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF p_decision = 'exclude' AND v_excluded_instagram_id = v_preflight.target_instagram_id THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.exclusion_decision = p_decision
       AND v_preflight.excluded_instagram_id IS NOT DISTINCT FROM v_excluded_instagram_id THEN
        RETURN FALSE;
    END IF;

    UPDATE public.analysis_preflights
    SET exclusion_decision = p_decision,
        excluded_instagram_id = v_excluded_instagram_id,
        exclusion_decided_at = v_now,
        updated_at = v_now
    WHERE id = v_preflight.id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.set_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.complete_analysis_v2_preflight(
    p_preflight_id UUID,
    p_user_id UUID,
    p_claim_token UUID,
    p_target_full_name TEXT,
    p_target_bio TEXT,
    p_target_profile_image_url TEXT,
    p_target_followers_count INTEGER,
    p_target_following_count INTEGER,
    p_target_is_private BOOLEAN,
    p_capacity_required_plan_id TEXT,
    p_required_plan_id TEXT,
    p_plan_cards_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_plan_id TEXT;
    v_plan_card JSONB;
    v_capacity JSONB;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_loop_rank INTEGER;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_claim_token IS NULL
       OR p_target_is_private IS NULL
       OR p_target_is_private
       OR p_target_followers_count IS NULL
       OR p_target_following_count IS NULL
       OR p_target_followers_count < 0
       OR p_target_followers_count > 10000000
       OR p_target_following_count < 0
       OR p_target_following_count > 10000000
       OR p_capacity_required_plan_id IS NULL
       OR p_capacity_required_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_required_plan_id IS NULL
       OR p_required_plan_id NOT IN ('basic', 'standard', 'plus')
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(p_plan_cards_snapshot)
       OR (p_target_full_name IS NOT NULL AND pg_catalog.char_length(p_target_full_name) > 200)
       OR (p_target_bio IS NOT NULL AND pg_catalog.char_length(p_target_bio) > 2200)
       OR (
           p_target_profile_image_url IS NOT NULL
           AND (
               pg_catalog.char_length(p_target_profile_image_url) > 8192
               OR p_target_profile_image_url !~* '^https://'
           )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_READY_SNAPSHOT', ERRCODE = 'P0001';
    END IF;

    v_capacity_rank := CASE p_capacity_required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
    v_required_rank := CASE p_required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
    IF v_required_rank < v_capacity_rank
       OR p_plan_cards_snapshot->p_required_plan_id->>'selectionState' <> 'required' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
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

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        IF p_plan_cards_snapshot->v_plan_id->>'launchStatus'
            IS DISTINCT FROM v_preflight.launch_status_snapshot->>v_plan_id
           OR p_plan_cards_snapshot->v_plan_id->'relationshipCapacity'
            IS DISTINCT FROM v_preflight.plan_catalog_snapshot
                ->v_plan_id->'relationshipCapacity'
           OR p_plan_cards_snapshot->v_plan_id->'detailedMutualLimit'
            IS DISTINCT FROM v_preflight.plan_catalog_snapshot
                ->v_plan_id->'detailedMutualLimit' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
        END IF;
    END LOOP;

    v_plan_card := p_plan_cards_snapshot->p_capacity_required_plan_id;
    v_capacity := v_plan_card->'relationshipCapacity';
    IF p_target_followers_count > (v_capacity->>'followers')::INTEGER
       OR p_target_following_count > (v_capacity->>'following')::INTEGER THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    v_loop_rank := 0;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_loop_rank := v_loop_rank + 1;
        EXIT WHEN v_loop_rank >= v_capacity_rank;
        v_capacity := p_plan_cards_snapshot->v_plan_id->'relationshipCapacity';
        IF p_target_followers_count <= (v_capacity->>'followers')::INTEGER
           AND p_target_following_count <= (v_capacity->>'following')::INTEGER THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
        END IF;
    END LOOP;

    IF (
        v_preflight.access_mode = 'production'
        AND p_plan_cards_snapshot->p_required_plan_id->>'launchStatus' <> 'production'
    ) OR (
        v_preflight.access_mode = 'test_entitlement'
        AND p_plan_cards_snapshot->p_required_plan_id->>'launchStatus' = 'disabled'
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status = 'ready' THEN
        IF v_preflight.target_full_name IS NOT DISTINCT FROM p_target_full_name
           AND v_preflight.target_bio IS NOT DISTINCT FROM p_target_bio
           AND v_preflight.target_profile_image_url IS NOT DISTINCT FROM p_target_profile_image_url
           AND v_preflight.target_followers_count = p_target_followers_count
           AND v_preflight.target_following_count = p_target_following_count
           AND v_preflight.target_is_private = p_target_is_private
           AND v_preflight.capacity_required_plan_id = p_capacity_required_plan_id
           AND v_preflight.required_plan_id = p_required_plan_id
           AND v_preflight.plan_cards_snapshot = p_plan_cards_snapshot THEN
            RETURN FALSE;
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_COMPLETION_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status <> 'processing' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_LEASE_LOST', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights
    SET status = 'ready',
        target_full_name = p_target_full_name,
        target_bio = p_target_bio,
        target_profile_image_url = p_target_profile_image_url,
        target_followers_count = p_target_followers_count,
        target_following_count = p_target_following_count,
        target_is_private = FALSE,
        capacity_required_plan_id = p_capacity_required_plan_id,
        required_plan_id = p_required_plan_id,
        plan_cards_snapshot = p_plan_cards_snapshot,
        ready_at = v_now,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE id = v_preflight.id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_analysis_v2_preflight(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_analysis_v2_preflight(
    UUID, UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN, TEXT, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.block_analysis_v2_preflight(
    p_preflight_id UUID,
    p_user_id UUID,
    p_claim_token UUID,
    p_error_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_error_code IS NULL
       OR p_error_code NOT IN (
           'TARGET_NOT_FOUND',
           'TARGET_PRIVATE',
           'TARGET_UNSUPPORTED',
           'OVER_PLUS_CAPACITY',
           'EXCLUSION_REQUIRED',
           'INVALID_EXCLUSION',
           'PLAN_UPGRADE_REQUIRED',
           'RELATIONSHIP_INCOMPLETE',
           'PROFILE_EVIDENCE_INCOMPLETE',
           'QUEUE_UNAVAILABLE',
           'AI_RATE_LIMITED',
           'AI_AMBIGUOUS_RESULT',
           'ANALYSIS_FAILED'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_BLOCK_INPUT', ERRCODE = 'P0001';
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
    IF v_preflight.status = 'blocked' THEN
        IF v_preflight.error_code = p_error_code THEN
            RETURN FALSE;
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_BLOCK_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status = 'processing' THEN
        IF p_claim_token IS NULL
           OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
           OR v_preflight.lease_expires_at <= v_now THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_LEASE_LOST', ERRCODE = 'P0001';
        END IF;
    ELSIF v_preflight.status = 'pending' THEN
        IF p_error_code <> 'QUEUE_UNAVAILABLE' OR p_claim_token IS NOT NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
        END IF;
    ELSE
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights
    SET status = 'blocked',
        error_code = p_error_code,
        blocked_at = v_now,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE id = v_preflight.id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.block_analysis_v2_preflight(UUID, UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.block_analysis_v2_preflight(UUID, UUID, UUID, TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.consume_analysis_v2_test_entitlement(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT
)
RETURNS TABLE(request_id UUID, created BOOLEAN)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing_request public.analysis_requests%ROWTYPE;
    v_existing_consumption public.analysis_v2_test_entitlement_consumptions%ROWTYPE;
    v_request_id UUID;
    v_idempotency_key TEXT;
    v_selected_card JSONB;
    v_scope_snapshot JSONB;
    v_required_rank INTEGER;
    v_selected_rank INTEGER;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_entitlement_jti_hash IS NULL
       OR p_entitlement_jti_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_ENTITLEMENT_INPUT', ERRCODE = 'P0001';
    END IF;

    -- Serialize a JTI even before its first consumption row exists, so a concurrent use receives
    -- the bounded conflict below instead of a raw unique-constraint error.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_entitlement_jti_hash, 0)
    );

    PERFORM 1
    FROM public.users
    WHERE id = p_user_id
    FOR UPDATE;
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

    IF v_preflight.status = 'consumed' THEN
        SELECT analysis_request.*
        INTO v_existing_request
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = v_preflight.consumed_request_id
          AND analysis_request.preflight_id = v_preflight.id
          AND analysis_request.user_id = v_preflight.user_id
        FOR UPDATE;

        IF FOUND
           AND v_existing_request.pipeline_version = 'v2'
           AND v_existing_request.plan_access_mode_snapshot = 'test_entitlement'
           AND v_existing_request.selected_plan_id_snapshot = p_selected_plan_id
           AND v_existing_request.test_entitlement_jti_hash = p_entitlement_jti_hash THEN
            RETURN QUERY SELECT v_existing_request.id, FALSE;
            RETURN;
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_EXPIRED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status <> 'ready' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.exclusion_decision = 'pending' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_EXCLUSION_REQUIRED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.access_mode <> 'test_entitlement' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    v_selected_card := v_preflight.plan_cards_snapshot->p_selected_plan_id;
    IF v_selected_card IS NULL
       OR v_selected_card->>'selectionState' NOT IN ('required', 'available_upgrade')
       OR v_selected_card->>'launchStatus' = 'disabled'
       OR v_preflight.pricing_snapshot->p_selected_plan_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    v_required_rank := CASE v_preflight.required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3 ELSE NULL END;
    v_selected_rank := CASE p_selected_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
    IF v_required_rank IS NULL OR v_selected_rank < v_required_rank THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    SELECT consumption.*
    INTO v_existing_consumption
    FROM public.analysis_v2_test_entitlement_consumptions AS consumption
    WHERE consumption.entitlement_jti_hash = p_entitlement_jti_hash
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing_consumption.preflight_id = v_preflight.id
           AND v_existing_consumption.user_id = v_preflight.user_id
           AND v_existing_consumption.selected_plan_id = p_selected_plan_id THEN
            SELECT analysis_request.*
            INTO v_existing_request
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = v_existing_consumption.request_id
            FOR UPDATE;
            IF FOUND
               AND v_existing_request.preflight_id = v_preflight.id
               AND v_existing_request.test_entitlement_jti_hash = p_entitlement_jti_hash THEN
                RETURN QUERY SELECT v_existing_request.id, FALSE;
                RETURN;
            END IF;
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_existing_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.preflight_id = v_preflight.id
    FOR UPDATE;
    IF FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests AS active_request
        WHERE active_request.user_id = p_user_id
          AND active_request.status IN ('pending', 'processing')
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_ALREADY_IN_PROGRESS', ERRCODE = 'P0001';
    END IF;

    v_idempotency_key := 'v2-preflight:' || v_preflight.id::TEXT;
    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests AS idempotent_request
        WHERE idempotent_request.user_id = p_user_id
          AND idempotent_request.idempotency_key = v_idempotency_key
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_ENTITLEMENT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_scope_snapshot := pg_catalog.jsonb_build_object(
        'relationshipCapacity', v_selected_card->'relationshipCapacity',
        'detailedMutualLimit', v_selected_card->'detailedMutualLimit'
    );
    IF NOT public.analysis_v2_valid_scope_snapshot(v_scope_snapshot) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    v_request_id := public.uuid_generate_v4();
    INSERT INTO public.analysis_requests (
        id,
        user_id,
        target_instagram_id,
        target_gender,
        status,
        progress,
        progress_step,
        current_step,
        step_data,
        gender_stats,
        plan_type,
        background_processing,
        idempotency_key,
        pipeline_version,
        preflight_id,
        excluded_instagram_id,
        exclusion_decision_snapshot,
        plan_access_mode_snapshot,
        capacity_required_plan_id_snapshot,
        required_plan_id_snapshot,
        selected_plan_id_snapshot,
        plan_launch_status_snapshot,
        plan_cards_snapshot,
        pricing_version_snapshot,
        pricing_snapshot,
        analysis_scope_snapshot,
        policy_versions_snapshot,
        test_entitlement_jti_hash
    ) VALUES (
        v_request_id,
        v_preflight.user_id,
        v_preflight.target_instagram_id,
        'male',
        'pending',
        0,
        '분석 대기 중...',
        'pending',
        '{}'::JSONB,
        '{}'::JSONB,
        p_selected_plan_id,
        FALSE,
        v_idempotency_key,
        'v2',
        v_preflight.id,
        v_preflight.excluded_instagram_id,
        v_preflight.exclusion_decision,
        v_preflight.access_mode,
        v_preflight.capacity_required_plan_id,
        v_preflight.required_plan_id,
        p_selected_plan_id,
        v_preflight.launch_status_snapshot,
        v_preflight.plan_cards_snapshot,
        v_preflight.pricing_version,
        v_preflight.pricing_snapshot,
        v_scope_snapshot,
        v_preflight.policy_versions_snapshot,
        p_entitlement_jti_hash
    );

    UPDATE public.analysis_preflights
    SET status = 'consumed',
        consumed_at = v_now,
        consumed_request_id = v_request_id,
        updated_at = v_now
    WHERE id = v_preflight.id;

    INSERT INTO public.analysis_v2_test_entitlement_consumptions (
        entitlement_jti_hash,
        preflight_id,
        request_id,
        user_id,
        selected_plan_id,
        consumed_at
    ) VALUES (
        p_entitlement_jti_hash,
        v_preflight.id,
        v_request_id,
        v_preflight.user_id,
        p_selected_plan_id,
        v_now
    );

    RETURN QUERY SELECT v_request_id, TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT)
    TO service_role;

COMMENT ON FUNCTION public.consume_analysis_v2_test_entitlement(UUID, UUID, TEXT, TEXT) IS
    'Consumes one externally verified signed test-entitlement JTI hash and creates exactly one pending V2 request.';
