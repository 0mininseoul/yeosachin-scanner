-- MIGRATION_PREDECESSOR=20260815090000
-- Recover only the narrowly observed paid-order shape where a completed g1
-- admission was followed by an expired-preflight rebind, then a local dispatch
-- release left g2 pending/idle before any g2 provider run could start.  The
-- existing g1 admission evidence is copied into the already-created g2
-- preflight; this migration never rebinds, reserves, or starts a provider run.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815090000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE FUNCTION public.recover_exact_earlybird_generation_two_pending_idle(
    p_order_id UUID,
    p_expected_preflight_id UUID
)
RETURNS TABLE(
    applied BOOLEAN,
    fulfillment_status TEXT,
    request_id UUID,
    initial_job_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_current public.analysis_preflights%ROWTYPE;
    v_source public.analysis_preflights%ROWTYPE;
    v_claim RECORD;
    v_created RECORD;
    v_expected_hash TEXT;
    v_base_preflight_key TEXT;
BEGIN
    IF p_order_id IS NULL OR p_expected_preflight_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.*
    INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.*
    INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT preflight.*
    INTO v_current
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_expected_preflight_id
    FOR UPDATE;
    IF v_fulfillment.order_id IS NULL
       OR v_current.id IS NULL
       OR v_order.preflight_id IS DISTINCT FROM p_expected_preflight_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    -- A response lost after the transaction committed is a no-op replay.  It
    -- must name the same consumed preflight and request; no broader request is
    -- ever accepted as a recovery result.
    IF v_fulfillment.status = 'analysis_in_progress'
       AND v_fulfillment.request_id IS NOT NULL
       AND v_order.status = 'analysis_in_progress'
       AND v_order.result_request_id IS NOT DISTINCT FROM v_fulfillment.request_id
       AND v_current.status = 'consumed'
       AND v_current.consumed_request_id IS NOT DISTINCT FROM v_fulfillment.request_id THEN
        RETURN QUERY SELECT FALSE, v_fulfillment.status, v_fulfillment.request_id,
            'coordinator:bootstrap'::TEXT;
        RETURN;
    END IF;

    v_expected_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'earlybird-fulfillment-admission-v1'
                    || pg_catalog.chr(10)
                    || pg_catalog.lower(v_order.id::TEXT),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
    v_base_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');

    SELECT source.*
    INTO v_source
    FROM public.analysis_preflights AS source
    WHERE source.user_id = v_order.user_id
      AND source.idempotency_key = v_base_preflight_key
    FOR UPDATE;

    IF v_order.status IS DISTINCT FROM 'paid'
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_order.result_request_id IS NOT NULL
       OR EXISTS (
           SELECT 1
           FROM public.earlybird_webhook_events AS refund_event
           WHERE refund_event.payment_id = v_order.payment_id
             AND refund_event.event_type IN (
                 'payment.refunded',
                 'payment.refund_pending',
                 'payment.cancelled',
                 'payment.failed'
             )
       )
       OR v_fulfillment.status IS DISTINCT FROM 'admission_pending'
       OR v_fulfillment.request_id IS NOT NULL
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_fulfillment.last_error_code IS NOT NULL
       OR v_current.user_id IS DISTINCT FROM v_order.user_id
       OR v_current.target_instagram_id IS DISTINCT FROM v_order.target_instagram_id
       OR v_current.exclusion_decision IS DISTINCT FROM v_order.exclusion_decision
       OR v_current.excluded_instagram_id IS DISTINCT FROM v_order.excluded_instagram_id
       OR v_current.access_mode IS DISTINCT FROM 'production'
       OR v_current.status IS DISTINCT FROM 'ready'
       OR v_current.consumed_request_id IS NOT NULL
       OR v_current.idempotency_key IS DISTINCT FROM v_base_preflight_key || '.r1'
       OR v_current.admission_generation IS DISTINCT FROM 2
       OR v_current.admission_status IS DISTINCT FROM 'pending'
       OR v_current.admission_dispatch_state IS DISTINCT FROM 'idle'
       OR v_current.admission_dispatch_token IS NOT NULL
       OR v_current.admission_dispatch_reserved_at IS NOT NULL
       OR v_current.admission_dispatched_at IS NOT NULL
       OR v_current.admission_claim_token IS NOT NULL
       OR v_current.admission_lease_expires_at IS NOT NULL
       OR v_current.admission_failure_count IS DISTINCT FROM 0
       OR v_current.admission_error_code IS NOT NULL
       OR v_source.id IS NULL
       OR v_source.id = v_current.id
       OR v_source.user_id IS DISTINCT FROM v_order.user_id
       OR v_source.target_instagram_id IS DISTINCT FROM v_order.target_instagram_id
       OR v_source.exclusion_decision IS DISTINCT FROM v_order.exclusion_decision
       OR v_source.excluded_instagram_id IS DISTINCT FROM v_order.excluded_instagram_id
       OR v_source.access_mode IS DISTINCT FROM 'production'
       OR v_source.status IS DISTINCT FROM 'expired'
       OR v_source.consumed_request_id IS NOT NULL
       OR v_source.admission_generation IS DISTINCT FROM 1
       OR v_source.admission_status IS DISTINCT FROM 'ready'
       OR v_source.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR v_source.admission_entitlement_jti_hash IS DISTINCT FROM v_expected_hash
       OR v_source.admission_token IS NULL
       OR v_source.admission_refreshed_at IS NULL
       OR v_source.admission_target_followers_count IS NULL
       OR v_source.admission_target_following_count IS NULL
       OR v_source.admission_capacity_required_plan_id IS NULL
       OR v_source.admission_required_plan_id IS NULL
       OR v_source.admission_plan_cards_snapshot IS NULL
       OR v_source.admission_error_code IS NOT NULL
       OR v_source.admission_claim_token IS NOT NULL
       OR v_source.admission_lease_expires_at IS NOT NULL
       OR v_current.launch_status_snapshot
            IS DISTINCT FROM v_source.launch_status_snapshot
       OR v_current.plan_catalog_snapshot
            IS DISTINCT FROM v_source.plan_catalog_snapshot
       OR v_current.pricing_version IS DISTINCT FROM v_source.pricing_version
       OR v_current.pricing_snapshot IS DISTINCT FROM v_source.pricing_snapshot
       OR v_current.policy_versions_snapshot
            IS DISTINCT FROM v_source.policy_versions_snapshot
       OR v_current.target_followers_count
            IS DISTINCT FROM v_source.admission_target_followers_count
       OR v_current.target_following_count
            IS DISTINCT FROM v_source.admission_target_following_count
       OR v_order.target_followers_count
            IS DISTINCT FROM v_source.admission_target_followers_count
       OR v_order.target_following_count
            IS DISTINCT FROM v_source.admission_target_following_count
       OR v_current.capacity_required_plan_id
            IS DISTINCT FROM v_source.admission_capacity_required_plan_id
       OR v_current.required_plan_id
            IS DISTINCT FROM v_source.admission_required_plan_id
       OR v_current.plan_cards_snapshot
            IS DISTINCT FROM v_source.admission_plan_cards_snapshot
       OR EXISTS (
           SELECT 1
           FROM public.analysis_preflight_provider_runs AS generation_two_run
           WHERE generation_two_run.preflight_id = v_current.id
       )
       OR EXISTS (
           SELECT 1
           FROM public.analysis_requests AS active_request
           WHERE active_request.user_id = v_order.user_id
             AND active_request.status IN ('pending', 'processing')
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    -- This is the sole data transition: it preserves the existing g2 identity
    -- and uses the completed g1 source snapshot.  No provider reservation,
    -- task reservation, or preflight rebind is reachable from this function.
    UPDATE public.analysis_preflights AS preflight
    SET admission_status = 'ready',
        admission_selected_plan_id = v_source.admission_selected_plan_id,
        admission_entitlement_jti_hash = v_source.admission_entitlement_jti_hash,
        admission_token = v_source.admission_token,
        admission_requested_at = v_now,
        admission_refreshed_at = v_now,
        admission_target_followers_count = v_source.admission_target_followers_count,
        admission_target_following_count = v_source.admission_target_following_count,
        admission_capacity_required_plan_id = v_source.admission_capacity_required_plan_id,
        admission_required_plan_id = v_source.admission_required_plan_id,
        admission_plan_cards_snapshot = v_source.admission_plan_cards_snapshot,
        admission_failure_count = 0,
        admission_last_error_code = NULL,
        admission_error_code = NULL,
        updated_at = v_now
    WHERE preflight.id = v_current.id
      AND preflight.admission_generation = 2
      AND preflight.admission_status = 'pending'
      AND preflight.admission_dispatch_state = 'idle'
      AND preflight.admission_dispatch_token IS NULL
      AND preflight.admission_claim_token IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_claim
    FROM public.claim_earlybird_fulfillment(
        v_order.id,
        extensions.gen_random_uuid(),
        300
    );
    IF v_claim.claimed IS DISTINCT FROM TRUE
       OR v_claim.fulfillment_status IS DISTINCT FROM 'admission_pending'
       OR v_claim.lease_token IS NULL
       OR v_claim.lease_fence IS NULL
       OR v_claim.lease_fence < 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_CLAIM_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_created
    FROM public.create_or_replay_earlybird_fulfillment_request(
        v_order.id,
        v_claim.lease_token,
        v_claim.lease_fence
    );
    IF v_created.order_id IS DISTINCT FROM v_order.id
       OR v_created.fulfillment_status IS DISTINCT FROM 'analysis_in_progress'
       OR v_created.request_id IS NULL
       OR v_created.initial_job_key IS DISTINCT FROM 'coordinator:bootstrap' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_REQUEST_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT TRUE, v_created.fulfillment_status,
        v_created.request_id, v_created.initial_job_key;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_exact_earlybird_generation_two_pending_idle(
    UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_exact_earlybird_generation_two_pending_idle(
    UUID, UUID
) TO service_role;

COMMENT ON FUNCTION public.recover_exact_earlybird_generation_two_pending_idle(
    UUID, UUID
) IS 'Exact paid concierge recovery for a g1-complete/g2-pending-idle, zero-g2-provider-run checkpoint; resumes request creation without rebind or recollection.';

COMMIT;
