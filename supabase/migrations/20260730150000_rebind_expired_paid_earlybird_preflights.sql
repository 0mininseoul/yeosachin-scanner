-- A preflight's thirty-minute TTL is immutable.  A paid order that outlives
-- it gets a new execution preflight; the original row remains its tombstone.
ALTER FUNCTION public.admit_earlybird_fulfillment(UUID)
    RENAME TO admit_earlybird_fulfillment_core_20260730140000;
REVOKE ALL ON FUNCTION public.admit_earlybird_fulfillment_core_20260730140000(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

-- The existing core admission routine predates the immutable 30-minute TTL
-- and attempts to extend a preflight. Keep that legacy routine compatible
-- only for a preflight currently bound to an earlybird order, by restoring its
-- table-defined fixed expiry instead of accepting the attempted extension.
CREATE FUNCTION public.enforce_earlybird_preflight_fixed_ttl()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.earlybird_orders AS earlybird_order
        WHERE earlybird_order.preflight_id = OLD.id
    ) THEN
        NEW.expires_at := NEW.created_at + INTERVAL '30 minutes';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_earlybird_preflight_fixed_ttl
    ON public.analysis_preflights;
CREATE TRIGGER enforce_earlybird_preflight_fixed_ttl
BEFORE UPDATE OF expires_at ON public.analysis_preflights
FOR EACH ROW
EXECUTE FUNCTION public.enforce_earlybird_preflight_fixed_ttl();

CREATE FUNCTION public.rebind_expired_paid_earlybird_preflight(
    p_order_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
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
        'earlybird.fulfillment.' || pg_catalog.replace(v_order.id::TEXT, '-', ''),
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

CREATE FUNCTION public.admit_earlybird_fulfillment(p_order_id UUID)
RETURNS TABLE(order_id UUID, fulfillment_status TEXT, preflight_id UUID, user_id UUID, plan_id TEXT, request_id UUID)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    PERFORM public.rebind_expired_paid_earlybird_preflight(p_order_id);
    RETURN QUERY SELECT * FROM public.admit_earlybird_fulfillment_core_20260730140000(p_order_id);
END;
$$;

REVOKE ALL ON FUNCTION public.rebind_expired_paid_earlybird_preflight(UUID), public.admit_earlybird_fulfillment(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rebind_expired_paid_earlybird_preflight(UUID), public.admit_earlybird_fulfillment(UUID)
    TO service_role;
