-- A user-scoped preflight create used to apply the complete retention scrub to
-- every expired active row before checking whether an earlybird order retained
-- the row as paid evidence. Scheduled retention already fences these references.
-- Keep linked evidence immutable while still retiring the row from the active
-- uniqueness index; only unlinked rows receive the complete PII scrub.
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
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
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
    VALUES (p_user_id, pg_catalog.btrim(p_email), p_auth_provider, 0, FALSE)
    ON CONFLICT (id) DO NOTHING;

    PERFORM 1 FROM public.users WHERE id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_AUTH_INPUT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired',
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE preflight.user_id = p_user_id
      AND preflight.status IN ('pending', 'processing', 'ready')
      AND preflight.expires_at <= v_now
      AND EXISTS (
          SELECT 1
          FROM public.earlybird_orders AS earlybird_order
          WHERE earlybird_order.preflight_id = preflight.id
            AND earlybird_order.status IN (
                'payment_pending', 'cancelled', 'paid',
                'analysis_in_progress', 'completed'
            )
      );

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
      AND preflight.expires_at <= v_now
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_orders AS earlybird_order
          WHERE earlybird_order.preflight_id = preflight.id
            AND earlybird_order.status IN (
                'payment_pending', 'cancelled', 'paid',
                'analysis_in_progress', 'completed'
            )
      );

    SELECT preflight.* INTO v_existing
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

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('analysis-v2-preflight-global-hourly-budget', 0)
    );
    SELECT pg_catalog.count(*)::INTEGER INTO v_global_preflight_count
    FROM public.analysis_preflights AS recent_preflight
    WHERE recent_preflight.created_at > v_now - INTERVAL '1 hour';
    SELECT pg_catalog.count(*)::INTEGER INTO v_recent_preflight_count
    FROM public.analysis_preflights AS recent_preflight
    WHERE recent_preflight.user_id = p_user_id
      AND recent_preflight.created_at > v_now - INTERVAL '1 hour';
    IF v_global_preflight_count >= 300
       OR v_recent_preflight_count >= 5
       OR EXISTS (
           SELECT 1 FROM public.analysis_preflights AS recent_preflight
           WHERE recent_preflight.user_id = p_user_id
             AND recent_preflight.created_at > v_now - INTERVAL '10 seconds'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_RATE_LIMITED', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired', lease_token = NULL, lease_expires_at = NULL, updated_at = v_now
    WHERE preflight.user_id = p_user_id
      AND preflight.status IN ('pending', 'processing', 'ready');

    v_preflight_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_preflights (
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, access_mode, launch_status_snapshot,
        plan_catalog_snapshot, pricing_version, pricing_snapshot,
        policy_versions_snapshot, created_at, updated_at, expires_at
    ) VALUES (
        v_preflight_id, p_user_id, p_idempotency_key, v_target_instagram_id,
        'pending', 'pending', p_access_mode, p_launch_status_snapshot,
        p_plan_catalog_snapshot, p_pricing_version, p_pricing_snapshot,
        p_policy_versions_snapshot, v_now, v_now, v_now + INTERVAL '30 minutes'
    );
    RETURN QUERY SELECT v_preflight_id, TRUE, 'pending'::TEXT,
        v_now + INTERVAL '30 minutes';
END;
$$;

REVOKE ALL ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) TO service_role;

-- Legacy rows scrubbed before the fence retained no admission target ID. This
-- recovery is consequently limited to the exact order-linked purge tombstone;
-- the order is the target/exclusion authority, while the retained immutable
-- snapshots and canonical admission witness remain independent plan evidence.
CREATE FUNCTION public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
    p_order_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(order_id UUID, fulfillment_status TEXT, preflight_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := public.earlybird_fulfillment_clock();
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_old public.analysis_preflights%ROWTYPE;
    v_new public.analysis_preflights%ROWTYPE;
    v_rebound_id UUID;
    v_capacity_plan TEXT;
    v_required_plan TEXT;
    v_cards JSONB := '{}'::JSONB;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_catalog_plan JSONB;
    v_launch_status TEXT;
    v_state TEXT;
    v_reason TEXT;
    v_selected_card JSONB;
BEGIN
    IF p_order_id IS NULL OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_INVALID', ERRCODE = 'P0001';
    END IF;

    -- Global order is identical to fulfillment runtime and rebind:
    -- order -> fulfillment -> preflight. Active requests remain an unlocked read.
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_old
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    IF v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.last_error_code <> 'SNAPSHOT_CONFLICT'
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_fulfillment.request_id IS NOT NULL
       OR v_order.result_request_id IS NOT NULL
       OR v_old.consumed_request_id IS NOT NULL
       OR v_old.consumed_at IS NOT NULL
       OR v_old.lease_token IS NOT NULL
       OR v_old.lease_expires_at IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_STATE_INVALID', ERRCODE = 'P0001';
    END IF;
    IF v_fulfillment.manual_review_at IS DISTINCT FROM p_expected_manual_review_at THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_CAS_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_order.status <> 'paid'
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_order.target_followers_count IS NULL
       OR v_order.target_following_count IS NULL
       OR v_old.user_id IS DISTINCT FROM v_order.user_id
       OR v_old.access_mode <> 'production'
       OR v_old.status <> 'expired'
       OR v_old.pii_scrubbed_at IS NULL
       OR v_old.expires_at > v_now
       OR v_old.pii_scrubbed_at < v_old.expires_at
       OR v_old.target_instagram_id IS DISTINCT FROM (
           'retained.' || pg_catalog.substr(
               pg_catalog.replace(v_old.id::TEXT, '-', ''), 1, 20
           )
       )
       OR v_old.target_full_name IS NOT NULL
       OR v_old.target_bio IS NOT NULL
       OR v_old.target_profile_image_url IS NOT NULL
       OR v_old.target_followers_count IS NOT NULL
       OR v_old.target_following_count IS NOT NULL
       OR v_old.target_is_private IS NOT NULL
       OR v_old.capacity_required_plan_id IS NOT NULL
       OR v_old.required_plan_id IS NOT NULL
       OR v_old.plan_cards_snapshot IS NOT NULL
       OR v_old.error_code IS NOT NULL
       OR v_old.blocked_at IS NOT NULL
       OR v_old.ready_at IS NOT NULL
       OR v_old.exclusion_decision <> 'skip'
       OR v_old.excluded_instagram_id IS NOT NULL
       OR NOT public.analysis_v2_valid_launch_snapshot(v_old.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(v_old.plan_catalog_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(v_old.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(v_old.policy_versions_snapshot)
       OR v_order.plan_id NOT IN ('basic', 'standard')
       OR v_old.admission_status <> 'ready'
       OR v_old.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR v_old.admission_entitlement_jti_hash IS DISTINCT FROM pg_catalog.encode(
           extensions.digest(
               pg_catalog.convert_to(
                   'earlybird-fulfillment-admission-v1'
                   || pg_catalog.chr(10) || pg_catalog.lower(v_order.id::TEXT),
                   'UTF8'
               ),
               'sha256'
           ),
           'hex'
       )
       OR v_old.admission_target_followers_count IS NULL
       OR v_old.admission_target_following_count IS NULL
       OR v_old.admission_claim_token IS NOT NULL
       OR v_old.admission_lease_expires_at IS NOT NULL
       OR v_old.admission_error_code IS NOT NULL
       OR v_old.admission_refreshed_at IS NULL
       OR v_old.admission_refreshed_at > v_now
       OR v_old.admission_refreshed_at >= v_now - INTERVAL '2 minutes' THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog_plan := v_old.plan_catalog_snapshot->v_plan_id;
        v_launch_status := v_old.launch_status_snapshot->>v_plan_id;
        IF v_catalog_plan->>'launchStatus' IS DISTINCT FROM v_launch_status THEN
            RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF v_capacity_rank IS NULL
           AND v_old.admission_target_followers_count
                <= (v_catalog_plan->'relationshipCapacity'->>'followers')::INTEGER
           AND v_old.admission_target_following_count
                <= (v_catalog_plan->'relationshipCapacity'->>'following')::INTEGER THEN
            v_capacity_rank := v_plan_rank;
            v_capacity_plan := v_plan_id;
        END IF;
    END LOOP;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        IF v_required_rank IS NULL
           AND v_plan_rank >= v_capacity_rank
           AND v_old.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_required_rank := v_plan_rank;
            v_required_plan := v_plan_id;
        END IF;
    END LOOP;
    IF v_capacity_rank IS NULL OR v_required_rank IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog_plan := v_old.plan_catalog_snapshot->v_plan_id;
        v_launch_status := v_old.launch_status_snapshot->>v_plan_id;
        IF v_plan_rank < v_capacity_rank THEN
            v_state := 'unavailable'; v_reason := 'below_required_plan';
        ELSIF v_launch_status <> 'production' THEN
            v_state := 'unavailable'; v_reason := 'launch_gate';
        ELSIF v_plan_id = v_required_plan THEN
            v_state := 'required'; v_reason := NULL;
        ELSE
            v_state := 'available_upgrade'; v_reason := NULL;
        END IF;
        v_cards := v_cards || pg_catalog.jsonb_build_object(
            v_plan_id,
            pg_catalog.jsonb_build_object(
                'launchStatus', v_launch_status,
                'relationshipCapacity', v_catalog_plan->'relationshipCapacity',
                'detailedMutualLimit', v_catalog_plan->'detailedMutualLimit',
                'selectionState', v_state,
                'unavailableReason', v_reason
            )
        );
    END LOOP;
    IF NOT public.analysis_v2_valid_plan_cards_snapshot(v_cards)
       OR v_old.admission_capacity_required_plan_id IS DISTINCT FROM v_capacity_plan
       OR v_old.admission_required_plan_id IS DISTINCT FROM v_required_plan
       OR v_old.admission_plan_cards_snapshot IS DISTINCT FROM v_cards THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    v_selected_card := v_cards->v_order.plan_id;
    IF v_selected_card IS NULL
       OR v_selected_card->>'launchStatus' <> 'production'
       OR v_selected_card->>'selectionState' NOT IN ('required', 'available_upgrade')
       OR v_order.target_followers_count
            > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_order.target_following_count
            > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER
       OR v_old.admission_target_followers_count
            > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_old.admission_target_following_count
            > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests AS active_request
        WHERE active_request.user_id = v_order.user_id
          AND active_request.status IN ('pending', 'processing')
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_ACTIVE_REQUEST_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'retryable_failure',
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_now,
        last_error_code = 'ADMISSION_FRESHNESS_EXPIRED',
        last_error_at = v_now,
        manual_review_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = p_order_id
      AND fulfillment.status = 'manual_review'
      AND fulfillment.manual_review_at IS NOT DISTINCT FROM p_expected_manual_review_at;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_CAS_MISMATCH', ERRCODE = 'P0001';
    END IF;

    v_rebound_id := public.rebind_expired_paid_earlybird_preflight(p_order_id);
    IF v_rebound_id IS NULL OR v_rebound_id = v_old.id THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_REBIND_REFUSED', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_new
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_rebound_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_new.id IS DISTINCT FROM v_rebound_id
       OR v_new.user_id IS DISTINCT FROM v_order.user_id
       OR v_new.status <> 'ready'
       OR v_new.consumed_request_id IS NOT NULL
       OR v_new.consumed_at IS NOT NULL
       OR v_new.access_mode <> 'production'
       OR v_new.target_instagram_id IS DISTINCT FROM v_order.target_instagram_id
       OR v_new.target_followers_count IS DISTINCT FROM v_order.target_followers_count
       OR v_new.target_following_count IS DISTINCT FROM v_order.target_following_count
       OR v_new.exclusion_decision IS DISTINCT FROM v_order.exclusion_decision
       OR v_new.excluded_instagram_id IS DISTINCT FROM v_order.excluded_instagram_id
       OR v_new.launch_status_snapshot IS DISTINCT FROM v_old.launch_status_snapshot
       OR v_new.plan_catalog_snapshot IS DISTINCT FROM v_old.plan_catalog_snapshot
       OR v_new.pricing_version IS DISTINCT FROM v_old.pricing_version
       OR v_new.pricing_snapshot IS DISTINCT FROM v_old.pricing_snapshot
       OR v_new.policy_versions_snapshot IS DISTINCT FROM v_old.policy_versions_snapshot
       OR NOT public.analysis_v2_valid_launch_snapshot(v_new.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(v_new.plan_catalog_snapshot)
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(v_new.plan_cards_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(v_new.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(v_new.policy_versions_snapshot)
       OR v_new.capacity_required_plan_id IS DISTINCT FROM v_capacity_plan
       OR v_new.required_plan_id IS DISTINCT FROM v_required_plan
       OR v_new.plan_cards_snapshot IS DISTINCT FROM v_cards
       OR v_new.admission_status NOT IN ('idle', 'pending')
       OR v_new.admission_selected_plan_id IS NOT NULL
       OR v_new.admission_refreshed_at IS NOT NULL
       OR v_new.admission_target_followers_count IS NOT NULL
       OR v_new.admission_target_following_count IS NOT NULL
       OR v_new.admission_plan_cards_snapshot IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCRUBBED_FRESHNESS_RECOVERY_POSTCONDITION_FAILED', ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT p_order_id, 'retryable_failure'::TEXT, v_new.id;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
    UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_scrubbed_earlybird_freshness_snapshot_conflict(
    UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;
