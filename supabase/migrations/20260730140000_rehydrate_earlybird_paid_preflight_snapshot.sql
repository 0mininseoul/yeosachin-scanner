-- A paid earlybird order retains its immutable checkout identity while the
-- associated expired preflight may have its display payload scrubbed. Restore
-- only the validated checkout/admission snapshot needed to re-enter `ready`.
CREATE OR REPLACE FUNCTION public.admit_earlybird_fulfillment(
    p_order_id UUID
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    preflight_id UUID,
    user_id UUID,
    plan_id TEXT,
    request_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_payment_valid BOOLEAN;
    v_capacity_required_plan_id TEXT;
    v_required_plan_id TEXT;
    v_plan_cards_snapshot JSONB;
    v_selected_card JSONB;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_selected_rank INTEGER;
    v_card_followers TEXT;
    v_card_following TEXT;
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_catalog_plan JSONB;
    v_launch_status TEXT;
    v_selection_state TEXT;
    v_unavailable_reason TEXT;
BEGIN
    IF p_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    v_payment_valid := (
            v_order.status = 'paid'
            OR v_order.status IN ('analysis_in_progress', 'completed')
        )
        AND v_order.seller_reference_confirmed_at IS NOT NULL
        AND v_order.payment_id IS NOT NULL
        AND v_order.actual_amount_krw IS NOT NULL
        AND v_order.actual_amount_krw BETWEEN 0 AND v_order.expected_amount_krw
        AND v_order.actual_groble_product_id
            IS NOT DISTINCT FROM v_order.expected_groble_product_id;
    IF NOT v_payment_valid THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_PAYMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    IF v_fulfillment.status IN ('analysis_in_progress', 'completed') THEN
        RETURN QUERY SELECT
            v_order.id,
            v_fulfillment.status,
            v_order.preflight_id,
            v_order.user_id,
            v_order.plan_id,
            v_fulfillment.request_id;
        RETURN;
    END IF;
    IF v_fulfillment.status = 'manual_review' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_MANUAL_REVIEW',
            ERRCODE = 'P0001';
    END IF;
    IF v_fulfillment.status = 'awaiting_operator' THEN
        v_fulfillment.operator_admitted_at := v_now;
    END IF;
    IF v_fulfillment.status NOT IN (
        'awaiting_operator',
        'admission_pending',
        'retryable_failure'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_STATE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.plan_catalog_snapshot IS NULL
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
       )
       OR v_order.plan_id NOT IN ('basic', 'standard')
       OR v_preflight.plan_catalog_snapshot
            ->v_order.plan_id->>'launchStatus' <> 'production' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    -- The purge path clears the status-payload columns as one set. Never mix
    -- a partial current payload with a later admission payload.
    IF v_preflight.plan_cards_snapshot IS NOT NULL
       AND v_preflight.capacity_required_plan_id IS NOT NULL
       AND v_preflight.required_plan_id IS NOT NULL THEN
        v_capacity_required_plan_id := v_preflight.capacity_required_plan_id;
        v_required_plan_id := v_preflight.required_plan_id;
        v_plan_cards_snapshot := v_preflight.plan_cards_snapshot;
    ELSIF v_preflight.plan_cards_snapshot IS NULL
       AND v_preflight.capacity_required_plan_id IS NULL
       AND v_preflight.required_plan_id IS NULL
       AND v_preflight.admission_plan_cards_snapshot IS NOT NULL
       AND v_preflight.admission_capacity_required_plan_id IS NOT NULL
       AND v_preflight.admission_required_plan_id IS NOT NULL THEN
        v_capacity_required_plan_id :=
            v_preflight.admission_capacity_required_plan_id;
        v_required_plan_id := v_preflight.admission_required_plan_id;
        v_plan_cards_snapshot := v_preflight.admission_plan_cards_snapshot;
    ELSIF v_preflight.plan_cards_snapshot IS NULL
       AND v_preflight.capacity_required_plan_id IS NULL
       AND v_preflight.required_plan_id IS NULL
       AND v_preflight.admission_plan_cards_snapshot IS NULL
       AND v_preflight.admission_capacity_required_plan_id IS NULL
       AND v_preflight.admission_required_plan_id IS NULL THEN
        -- A paid order can outlive a scrubbed preflight before a fresh-admission
        -- attempt is recorded. Its immutable order counts plus pinned catalog
        -- are sufficient to rebuild the same plan-card contract; the normal
        -- fresh-admission worker still rechecks current profile availability.
        v_capacity_rank := NULL;
        v_required_rank := NULL;
        v_plan_cards_snapshot := '{}'::JSONB;
        FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
            v_plan_rank := CASE v_plan_id
                WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
            v_catalog_plan := v_preflight.plan_catalog_snapshot->v_plan_id;
            v_launch_status := v_preflight.launch_status_snapshot->>v_plan_id;
            IF v_catalog_plan->>'launchStatus' IS DISTINCT FROM v_launch_status THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
                    ERRCODE = 'P0001';
            END IF;
            IF v_capacity_rank IS NULL
               AND v_order.target_followers_count
                    <= (v_catalog_plan->'relationshipCapacity'->>'followers')::INTEGER
               AND v_order.target_following_count
                    <= (v_catalog_plan->'relationshipCapacity'->>'following')::INTEGER THEN
                v_capacity_rank := v_plan_rank;
                v_capacity_required_plan_id := v_plan_id;
            END IF;
        END LOOP;

        IF v_capacity_rank IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
            v_plan_rank := CASE v_plan_id
                WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
            IF v_required_rank IS NULL
               AND v_plan_rank >= v_capacity_rank
               AND v_preflight.launch_status_snapshot->>v_plan_id = 'production' THEN
                v_required_rank := v_plan_rank;
                v_required_plan_id := v_plan_id;
            END IF;
        END LOOP;

        IF v_required_rank IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
            v_plan_rank := CASE v_plan_id
                WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
            v_catalog_plan := v_preflight.plan_catalog_snapshot->v_plan_id;
            v_launch_status := v_preflight.launch_status_snapshot->>v_plan_id;
            IF v_plan_rank < v_capacity_rank THEN
                v_selection_state := 'unavailable';
                v_unavailable_reason := 'below_required_plan';
            ELSIF v_launch_status <> 'production' THEN
                v_selection_state := 'unavailable';
                v_unavailable_reason := 'launch_gate';
            ELSIF v_plan_id = v_required_plan_id THEN
                v_selection_state := 'required';
                v_unavailable_reason := NULL;
            ELSE
                v_selection_state := 'available_upgrade';
                v_unavailable_reason := NULL;
            END IF;
            v_plan_cards_snapshot := v_plan_cards_snapshot || pg_catalog.jsonb_build_object(
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
    ELSE
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_capacity_rank := CASE v_capacity_required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3
        ELSE NULL
    END;
    v_required_rank := CASE v_required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 WHEN 'plus' THEN 3
        ELSE NULL
    END;
    v_selected_rank := CASE v_order.plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE NULL
    END;
    v_selected_card := v_plan_cards_snapshot -> v_order.plan_id;
    v_card_followers := v_selected_card #>> '{relationshipCapacity,followers}';
    v_card_following := v_selected_card #>> '{relationshipCapacity,following}';

    IF v_capacity_rank IS NULL
       OR v_required_rank IS NULL
       OR v_selected_rank IS NULL
       OR v_capacity_rank > v_required_rank
       OR v_selected_rank < v_required_rank
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(
            v_plan_cards_snapshot
       )
       OR v_selected_card IS NULL
       OR v_selected_card->>'launchStatus' <> 'production'
       OR v_selected_card->>'selectionState'
            NOT IN ('required', 'available_upgrade')
       OR v_card_followers IS NULL
       OR v_card_following IS NULL
       OR v_card_followers !~ '^[0-9]+$'
       OR v_card_following !~ '^[0-9]+$'
       OR v_card_followers::BIGINT < v_order.target_followers_count::BIGINT
       OR v_card_following::BIGINT < v_order.target_following_count::BIGINT THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET target_instagram_id = v_order.target_instagram_id,
        target_followers_count = v_order.target_followers_count,
        target_following_count = v_order.target_following_count,
        target_is_private = FALSE,
        exclusion_decision = v_order.exclusion_decision,
        excluded_instagram_id = v_order.excluded_instagram_id,
        capacity_required_plan_id = v_capacity_required_plan_id,
        required_plan_id = v_required_plan_id,
        plan_cards_snapshot = v_plan_cards_snapshot,
        status = 'ready',
        error_code = NULL,
        blocked_at = NULL,
        ready_at = COALESCE(preflight.ready_at, v_now),
        expires_at = v_now + INTERVAL '1 hour',
        pii_scrubbed_at = NULL,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending',
        operator_admitted_at = COALESCE(
            fulfillment.operator_admitted_at,
            v_now
        ),
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_now,
        last_error_code = NULL,
        last_error_at = NULL,
        manual_review_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = p_order_id
    RETURNING fulfillment.* INTO v_fulfillment;

    RETURN QUERY SELECT
        v_order.id,
        v_fulfillment.status,
        v_order.preflight_id,
        v_order.user_id,
        v_order.plan_id,
        v_fulfillment.request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admit_earlybird_fulfillment(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admit_earlybird_fulfillment(UUID)
    TO service_role;

-- A checkout can still complete after the normal preflight expiry. Retain its
-- immutable ready payload while payment is pending or paid so future automatic
-- fulfillment never needs to reconstruct a scrubbed checkout row.
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
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_MAINTENANCE_INPUT', ERRCODE = 'P0001';
    END IF;

    WITH expired AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status <> 'consumed'
          AND preflight.expires_at <= pg_catalog.clock_timestamp()
          AND preflight.pii_scrubbed_at IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_orders AS earlybird_order
              WHERE earlybird_order.preflight_id = preflight.id
                AND earlybird_order.status IN (
                    'payment_pending', 'cancelled', 'paid', 'analysis_in_progress', 'completed'
                )
          )
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
        pii_scrubbed_at = pg_catalog.clock_timestamp(),
        updated_at = pg_catalog.clock_timestamp()
    FROM expired
    WHERE preflight.id = expired.id;

    GET DIAGNOSTICS v_scrubbed_count = ROW_COUNT;

    WITH deletable AS (
        SELECT preflight.id
        FROM public.analysis_preflights AS preflight
        WHERE preflight.status = 'expired'
          AND preflight.created_at <= pg_catalog.clock_timestamp() - INTERVAL '1 hour'
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_preflight_provider_runs AS provider_run
              WHERE provider_run.preflight_id = preflight.id
                AND (
                    provider_run.status NOT IN (
                        'rejected', 'succeeded', 'failed', 'aborted', 'timed_out',
                        'resolved_no_run'
                    )
                    OR provider_run.actual_usage_usd IS NULL
                    OR provider_run.usage_reconciled_at IS NULL
                )
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_orders AS earlybird_order
              WHERE earlybird_order.preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1 FROM public.earlybird_waitlist AS waitlist_entry
              WHERE waitlist_entry.preflight_id = preflight.id
          )
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
