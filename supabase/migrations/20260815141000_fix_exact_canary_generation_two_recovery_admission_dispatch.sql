-- Correct only the exact g2 pending-idle recovery transition introduced by
-- 20260815140000.  A ready admission payload is constrained to an enqueued
-- dispatch witness; the original recovery restored its count snapshot but
-- omitted that witness, so its transaction rolled back before any request or
-- provider work was created.  This replacement preserves every original
-- eligibility fence and creates only the required durable admission-dispatch
-- witness before the existing request-creation RPC consumes the preflight.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815140000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EXACT_G2_PENDING_IDLE_RECOVERY_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.recover_exact_earlybird_generation_two_pending_idle(
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
    v_claim RECORD;
    v_created RECORD;
    v_expected_hash TEXT;
    v_base_preflight_key TEXT;
    v_provider_run_count INTEGER;
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

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_provider_run_count
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = v_current.id;

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
       OR v_current.idempotency_key IS DISTINCT FROM v_base_preflight_key
       OR v_current.target_followers_count
            IS DISTINCT FROM v_order.target_followers_count
       OR v_current.target_following_count
            IS DISTINCT FROM v_order.target_following_count
       OR v_current.capacity_required_plan_id IS NULL
       OR v_current.required_plan_id IS NULL
       OR v_current.plan_cards_snapshot IS NULL
       OR v_current.admission_generation IS DISTINCT FROM 2
       OR v_current.admission_status IS DISTINCT FROM 'pending'
       OR v_current.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR v_current.admission_entitlement_jti_hash IS DISTINCT FROM v_expected_hash
       OR v_current.admission_token IS NULL
       OR v_current.admission_requested_at IS NULL
       OR v_current.admission_refreshed_at IS NOT NULL
       OR v_current.admission_target_followers_count IS NOT NULL
       OR v_current.admission_target_following_count IS NOT NULL
       OR v_current.admission_capacity_required_plan_id IS NOT NULL
       OR v_current.admission_required_plan_id IS NOT NULL
       OR v_current.admission_plan_cards_snapshot IS NOT NULL
       OR v_current.admission_failure_count IS DISTINCT FROM 0
       OR v_current.admission_last_error_code IS NOT NULL
       OR v_current.admission_error_code IS NOT NULL
       OR v_current.admission_dispatch_state IS DISTINCT FROM 'idle'
       OR v_current.admission_dispatch_token IS NOT NULL
       OR v_current.admission_dispatch_reserved_at IS NOT NULL
       OR v_current.admission_dispatched_at IS NOT NULL
       OR v_current.admission_claim_token IS NOT NULL
       OR v_current.admission_lease_expires_at IS NOT NULL
       OR v_provider_run_count IS DISTINCT FROM 1
       OR NOT EXISTS (
           SELECT 1
           FROM public.analysis_preflight_provider_runs AS generation_one_run
           WHERE generation_one_run.preflight_id = v_current.id
             AND generation_one_run.operation_key = 'target-profile-fresh-admission:g1'
             AND generation_one_run.status = 'succeeded'
             AND generation_one_run.logical_provider = 'apify'
             AND generation_one_run.actor_id = 'apify/instagram-profile-scraper'
             AND generation_one_run.credential_slot = 'senary'
             AND generation_one_run.input_hash ~ '^[a-f0-9]{64}$'
             AND generation_one_run.run_id IS NOT NULL
             AND generation_one_run.terminalized_at IS NOT NULL
             AND generation_one_run.actual_usage_usd IS NOT NULL
             AND generation_one_run.usage_reconciled_at IS NOT NULL
             AND generation_one_run.reusable_profile_schema_version = 1
       )
       OR EXISTS (
           SELECT 1
           FROM public.analysis_preflight_provider_runs AS generation_two_run
           WHERE generation_two_run.preflight_id = v_current.id
             AND generation_two_run.operation_key = 'target-profile-fresh-admission:g2'
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

    -- The ready payload must carry an enqueued admission-dispatch witness to
    -- satisfy the durable preflight constraint.  This is checkpoint repair,
    -- not a provider admission reservation: g1 is already reconciled and g2
    -- remains absent; the following RPC only creates the request.
    UPDATE public.analysis_preflights AS preflight
    SET admission_status = 'ready',
        admission_refreshed_at = v_now,
        admission_target_followers_count = v_current.target_followers_count,
        admission_target_following_count = v_current.target_following_count,
        admission_capacity_required_plan_id = v_current.capacity_required_plan_id,
        admission_required_plan_id = v_current.required_plan_id,
        admission_plan_cards_snapshot = v_current.plan_cards_snapshot,
        admission_dispatch_state = 'enqueued',
        admission_dispatch_token = extensions.gen_random_uuid(),
        admission_dispatch_reserved_at = v_now,
        admission_dispatched_at = v_now,
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
) IS 'Exact paid concierge recovery for a completed SENARY g1 and g2 pending-idle zero-g2-run checkpoint; restores the constrained admission-dispatch witness before request creation, without rebind or recollection.';

COMMIT;
