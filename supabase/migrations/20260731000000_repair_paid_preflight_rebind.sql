-- Rebinding a paid order onto a fresh preflight was a one-shot operation that
-- could not actually run even once against a live checkout preflight:
--
--   1. it inserted the replacement while the outgoing row was still 'ready',
--      so both rows landed in idx_analysis_preflights_one_active_per_user;
--   2. it hardcoded idempotency_key = 'earlybird.fulfillment.' || <order hex>,
--      so a second rebind for the same order violated
--      idx_analysis_preflights_user_idempotency.
--
-- Both collisions stranded a paid order permanently. This retires the outgoing
-- preflight in the same transaction, generation-scopes the key, and caps the
-- number of replacements so a permanently broken order cannot churn forever.
-- Every existing refusal — lifecycle, snapshot, and capacity — is unchanged.
CREATE OR REPLACE FUNCTION public.rebind_expired_paid_earlybird_preflight(
    p_order_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    -- At most ten execution preflights may ever be minted for one order. The
    -- eleventh attempt refuses instead of minting, so a target that fails for a
    -- structural reason stops consuming preflight capacity and surfaces to the
    -- operator as the same stranded admission it already was.
    c_max_generations CONSTANT INTEGER := 10;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_new_preflight_id UUID;
    v_capacity_plan TEXT;
    v_required_plan TEXT;
    v_cards JSONB;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_catalog_plan JSONB;
    v_launch_status TEXT;
    v_state TEXT;
    v_reason TEXT;
    v_base_key TEXT;
    v_generation_prefix TEXT;
    v_last_generation INTEGER;
    v_generation INTEGER;
    v_idempotency_key TEXT;
    v_deactivated INTEGER;
BEGIN
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_order.id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    -- Rebinding is only a recovery bridge for a confirmed, not-yet-started
    -- payment. Every other order/fulfillment lifecycle remains on its original
    -- preflight and is handled by the existing core semantics.
    IF v_order.status <> 'paid'
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_fulfillment.status NOT IN (
            'awaiting_operator', 'admission_pending', 'retryable_failure'
       )
       OR (v_preflight.status <> 'expired' AND v_preflight.expires_at > v_now) THEN
        RETURN v_preflight.id;
    END IF;
    IF v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR NOT public.analysis_v2_valid_launch_snapshot(v_preflight.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(v_preflight.plan_catalog_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(v_preflight.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(v_preflight.policy_versions_snapshot)
       OR v_order.plan_id NOT IN ('basic', 'standard')
       OR v_preflight.plan_catalog_snapshot->v_order.plan_id->>'launchStatus' <> 'production' THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_capacity_rank := NULL;
    v_required_rank := NULL;
    v_cards := '{}'::JSONB;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog_plan := v_preflight.plan_catalog_snapshot->v_plan_id;
        v_launch_status := v_preflight.launch_status_snapshot->>v_plan_id;
        IF v_catalog_plan->>'launchStatus' IS DISTINCT FROM v_launch_status THEN
            RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF v_capacity_rank IS NULL
           AND v_order.target_followers_count <= (v_catalog_plan->'relationshipCapacity'->>'followers')::INTEGER
           AND v_order.target_following_count <= (v_catalog_plan->'relationshipCapacity'->>'following')::INTEGER THEN
            v_capacity_rank := v_plan_rank;
            v_capacity_plan := v_plan_id;
        END IF;
    END LOOP;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        IF v_required_rank IS NULL AND v_plan_rank >= v_capacity_rank
           AND v_preflight.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_required_rank := v_plan_rank;
            v_required_plan := v_plan_id;
        END IF;
    END LOOP;
    IF v_capacity_rank IS NULL OR v_required_rank IS NULL
       OR (CASE v_order.plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 END) < v_required_rank THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog_plan := v_preflight.plan_catalog_snapshot->v_plan_id;
        v_launch_status := v_preflight.launch_status_snapshot->>v_plan_id;
        IF v_plan_rank < v_capacity_rank THEN v_state := 'unavailable'; v_reason := 'below_required_plan';
        ELSIF v_launch_status <> 'production' THEN v_state := 'unavailable'; v_reason := 'launch_gate';
        ELSIF v_plan_id = v_required_plan THEN v_state := 'required'; v_reason := NULL;
        ELSE v_state := 'available_upgrade'; v_reason := NULL;
        END IF;
        v_cards := v_cards || pg_catalog.jsonb_build_object(v_plan_id, pg_catalog.jsonb_build_object(
            'launchStatus', v_launch_status,
            'relationshipCapacity', v_catalog_plan->'relationshipCapacity',
            'detailedMutualLimit', v_catalog_plan->'detailedMutualLimit',
            'selectionState', v_state,
            'unavailableReason', v_reason));
    END LOOP;
    IF NOT public.analysis_v2_valid_plan_cards_snapshot(v_cards) THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    -- One order owns one key family: the first replacement keeps the original
    -- fixed key, later ones append '.rN'. N is derived from the highest
    -- generation still present rather than from a row count, because a retired
    -- preflight stops being referenced by its order and therefore becomes
    -- deletable by purge_expired_analysis_v2_preflights; a count would then
    -- reissue a key that a surviving newer row already holds. The newest family
    -- member is always the one the order points at, so it is never purged and
    -- the high-water mark cannot regress while the order is live.
    v_base_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');
    v_generation_prefix := v_base_key || '.r';
    SELECT pg_catalog.max(
        CASE
            WHEN preflight.idempotency_key = v_base_key THEN 0
            ELSE (pg_catalog.substr(
                preflight.idempotency_key,
                pg_catalog.char_length(v_generation_prefix) + 1
            ))::INTEGER
        END
    ) INTO v_last_generation
    FROM public.analysis_preflights AS preflight
    WHERE preflight.user_id = v_order.user_id
      AND (
          preflight.idempotency_key = v_base_key
          OR (
              pg_catalog.left(
                  preflight.idempotency_key,
                  pg_catalog.char_length(v_generation_prefix)
              ) = v_generation_prefix
              AND pg_catalog.substr(
                  preflight.idempotency_key,
                  pg_catalog.char_length(v_generation_prefix) + 1
              ) ~ '^[0-9]{1,3}$'
          )
      );
    v_generation := COALESCE(v_last_generation + 1, 0);
    -- Refuse before retiring anything: a capped order must keep the preflight it
    -- already has rather than be left with no active row at all.
    IF v_generation >= c_max_generations THEN
        RETURN v_preflight.id;
    END IF;
    v_idempotency_key := CASE
        WHEN v_generation = 0 THEN v_base_key
        ELSE v_generation_prefix || v_generation::TEXT
    END;

    -- The replacement can only enter idx_analysis_preflights_one_active_per_user
    -- once the outgoing row leaves it, so retire it in the same transaction and
    -- only in the shape recovery is allowed to retire: unconsumed, past its
    -- immutable TTL, and not already a terminal 'blocked'/'consumed' record.
    -- The lease pair goes with it because analysis_preflights_lease_pair_check
    -- only tolerates a held lease while the row is still 'processing'. Anything
    -- outside that shape updates no row and keeps the existing refusal.
    UPDATE public.analysis_preflights AS preflight
    SET status = 'expired',
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id
      AND preflight.consumed_request_id IS NULL
      AND (preflight.status = 'expired' OR preflight.expires_at <= v_now)
      AND preflight.status IN ('pending', 'processing', 'ready', 'expired');
    GET DIAGNOSTICS v_deactivated = ROW_COUNT;
    IF v_deactivated <> 1 THEN
        RETURN v_preflight.id;
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, excluded_instagram_id, access_mode,
        launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
        pricing_version, pricing_snapshot, policy_versions_snapshot,
        target_followers_count, target_following_count, target_is_private,
        capacity_required_plan_id, required_plan_id, created_at, updated_at,
        expires_at, ready_at
    ) VALUES (
        v_new_preflight_id, v_order.user_id,
        v_idempotency_key,
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot, v_cards,
        v_preflight.pricing_version, v_preflight.pricing_snapshot, v_preflight.policy_versions_snapshot,
        v_order.target_followers_count, v_order.target_following_count, FALSE,
        v_capacity_plan, v_required_plan, v_now, v_now,
        v_now + INTERVAL '30 minutes', v_now
    );
    UPDATE public.earlybird_orders AS earlybird_order
    SET preflight_id = v_new_preflight_id, updated_at = v_now
    WHERE earlybird_order.id = v_order.id;
    RETURN v_new_preflight_id;
END;
$$;

REVOKE ALL ON FUNCTION public.rebind_expired_paid_earlybird_preflight(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rebind_expired_paid_earlybird_preflight(UUID)
    TO service_role;
