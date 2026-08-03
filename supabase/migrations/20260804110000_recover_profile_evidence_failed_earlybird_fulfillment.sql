-- Allow one audited fresh admission after a paid V2 request failed because the
-- authenticated profile batch could not produce complete evidence. The original
-- payment, request, and provider-free failure remain immutable; the replacement
-- preflight is the only new work admitted for the already-paid order.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.earlybird_profile_evidence_failure_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL CHECK (
        prior_attempt_count BETWEEN 1 AND 10
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.earlybird_profile_evidence_failure_recoveries
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_profile_evidence_failure_recoveries
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_profile_evidence_failure_recoveries
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_profile_evidence_failure_recovery_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_profile_evidence_failure_recoveries
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.recover_earlybird_profile_evidence_failed_fulfillment(
    p_order_id UUID,
    p_expected_failed_request_id UUID,
    p_expected_manual_review_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    preflight_id UUID,
    failed_request_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.earlybird_profile_evidence_failure_recoveries%ROWTYPE;
    v_new_preflight_id UUID;
    v_recovery_key TEXT;
BEGIN
    IF p_order_id IS NULL
       OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_EVIDENCE_RECOVERY_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.*
    INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_EVIDENCE_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT recovery.*
    INTO v_existing
    FROM public.earlybird_profile_evidence_failure_recoveries AS recovery
    WHERE recovery.order_id = p_order_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.failed_request_id IS DISTINCT FROM p_expected_failed_request_id
           OR v_existing.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PROFILE_EVIDENCE_RECOVERY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        SELECT fulfillment.*
        INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = p_order_id;
        IF NOT FOUND
           OR v_order.preflight_id IS DISTINCT FROM v_existing.recovery_preflight_id
           OR v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.status NOT IN ('admission_pending', 'retryable_failure') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_PROFILE_EVIDENCE_RECOVERY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            p_order_id,
            v_fulfillment.status,
            v_existing.recovery_preflight_id,
            v_existing.failed_request_id;
        RETURN;
    END IF;

    SELECT fulfillment.*
    INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_EVIDENCE_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_expected_failed_request_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_EVIDENCE_RECOVERY_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;
    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_EVIDENCE_RECOVERY_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_order.status <> 'analysis_in_progress'
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.last_error_code <> 'ANALYSIS_FAILED'
       OR v_fulfillment.manual_review_at
            IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.attempt_count NOT BETWEEN 1 AND 10
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.error_message <> 'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.pii_scrubbed_at IS NULL
       OR v_preflight.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_request.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_request.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_request.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.target_followers_count
            IS DISTINCT FROM v_order.target_followers_count
       OR v_preflight.target_following_count
            IS DISTINCT FROM v_order.target_following_count
       OR v_preflight.target_is_private IS DISTINCT FROM FALSE
       OR v_preflight.capacity_required_plan_id IS NULL
       OR v_preflight.required_plan_id IS NULL
       OR v_preflight.plan_cards_snapshot IS NULL
       OR NOT public.analysis_v2_valid_launch_snapshot(
            v_preflight.launch_status_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(
            v_preflight.plan_catalog_snapshot
       )
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(
            v_preflight.plan_cards_snapshot
       )
       OR NOT public.analysis_v2_valid_pricing_snapshot(
            v_preflight.pricing_snapshot
       )
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(
            v_preflight.policy_versions_snapshot
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.error_code = 'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_provider_cost_ledger AS provider_cost
            WHERE provider_cost.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS pipeline_job
            WHERE pipeline_job.request_id = v_request.id
              AND pipeline_job.status IN ('pending', 'processing', 'retryable')
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_requests AS active_request
            WHERE active_request.user_id = v_order.user_id
              AND active_request.id <> v_request.id
              AND active_request.status IN ('pending', 'processing')
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_preflights AS active_preflight
            WHERE active_preflight.user_id = v_order.user_id
              AND active_preflight.id <> v_preflight.id
              AND active_preflight.status IN ('pending', 'processing', 'ready')
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_PROFILE_EVIDENCE_RECOVERY_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;

    v_new_preflight_id := extensions.gen_random_uuid();
    v_recovery_key := 'earlybird.profile-evidence-recovery.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');

    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, excluded_instagram_id, access_mode,
        launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
        pricing_version, pricing_snapshot, policy_versions_snapshot,
        target_followers_count, target_following_count, target_is_private,
        capacity_required_plan_id, required_plan_id, created_at, updated_at,
        expires_at, ready_at
    ) VALUES (
        v_new_preflight_id, v_order.user_id, v_recovery_key,
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_preflight.plan_cards_snapshot, v_preflight.pricing_version,
        v_preflight.pricing_snapshot, v_preflight.policy_versions_snapshot,
        v_order.target_followers_count, v_order.target_following_count,
        FALSE, v_preflight.capacity_required_plan_id,
        v_preflight.required_plan_id, v_now, v_now,
        v_now + INTERVAL '30 minutes', v_now
    );

    INSERT INTO public.earlybird_profile_evidence_failure_recoveries(
        order_id, failed_request_id, recovery_preflight_id,
        prior_attempt_count, expected_manual_review_at
    ) VALUES (
        v_order.id, v_request.id, v_new_preflight_id,
        v_fulfillment.attempt_count, p_expected_manual_review_at
    );

    UPDATE public.earlybird_orders AS earlybird_order
    SET preflight_id = v_new_preflight_id,
        status = 'paid',
        result_request_id = NULL,
        updated_at = v_now
    WHERE earlybird_order.id = v_order.id;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending',
        attempt_count = 0,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_now,
        request_id = NULL,
        operator_admitted_at = v_now,
        last_error_code = NULL,
        last_error_at = NULL,
        completed_at = NULL,
        manual_review_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;

    RETURN QUERY SELECT
        v_order.id,
        'admission_pending'::TEXT,
        v_new_preflight_id,
        v_request.id;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_earlybird_profile_evidence_failed_fulfillment(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_earlybird_profile_evidence_failed_fulfillment(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;
