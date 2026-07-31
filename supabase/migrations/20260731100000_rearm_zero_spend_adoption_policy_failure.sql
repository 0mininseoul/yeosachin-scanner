CREATE TABLE public.earlybird_adoption_policy_failure_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    policy_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL,
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.earlybird_adoption_policy_failure_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_adoption_policy_failure_rearms FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_adoption_policy_failure_rearms
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prevent_earlybird_adoption_policy_failure_rearm_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER prevent_earlybird_adoption_policy_failure_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_adoption_policy_failure_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_adoption_policy_failure_rearm_mutation();

CREATE FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(
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
    v_normalized_preflight public.analysis_preflights%ROWTYPE;
    v_lineage public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_audit public.earlybird_adoption_policy_failure_rearms%ROWTYPE;
    v_new_preflight_id UUID;
    v_base_preflight_key TEXT;
BEGIN
    IF p_order_id IS NULL OR p_expected_failed_request_id IS NULL
       OR p_expected_manual_review_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
    END IF;
    SELECT audit.* INTO v_audit
    FROM public.earlybird_adoption_policy_failure_rearms AS audit
    WHERE audit.order_id = p_order_id;
    IF FOUND THEN
        IF v_audit.policy_failed_request_id IS DISTINCT FROM p_expected_failed_request_id
           OR v_audit.expected_manual_review_at
                IS DISTINCT FROM p_expected_manual_review_at THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        SELECT fulfillment.* INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = p_order_id FOR UPDATE;
        IF v_order.preflight_id IS DISTINCT FROM v_audit.rearmed_preflight_id
           OR v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.status NOT IN ('retryable_failure', 'admission_pending') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT p_order_id, v_fulfillment.status,
            v_audit.rearmed_preflight_id, v_audit.policy_failed_request_id;
        RETURN;
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id FOR UPDATE;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_expected_failed_request_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id FOR UPDATE;
    SELECT lineage.* INTO v_lineage
    FROM public.earlybird_schema_failure_recoveries AS lineage
    WHERE lineage.order_id = p_order_id;

    v_base_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');
    v_normalized_preflight := v_preflight;
    v_normalized_preflight.target_instagram_id := v_order.target_instagram_id;
    v_normalized_preflight.exclusion_decision := v_order.exclusion_decision;
    v_normalized_preflight.excluded_instagram_id := v_order.excluded_instagram_id;
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
       OR v_fulfillment.last_error_code <> 'ANALYSIS_FAILED'
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.manual_review_at IS DISTINCT FROM p_expected_manual_review_at
       OR v_fulfillment.attempt_count <> 5
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_request.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status <> 'failed'
       OR v_request.error_message <> 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       OR v_request.idempotency_key IS DISTINCT FROM
            ('earlybird:' || pg_catalog.lower(v_order.id::TEXT) || '.r1')
       OR v_preflight.status <> 'consumed'
       OR v_preflight.consumed_request_id IS DISTINCT FROM v_request.id
       OR v_preflight.idempotency_key IS DISTINCT FROM (v_base_preflight_key || '.r1')
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_preflight.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_preflight.exclusion_decision <> 'skip'
       OR v_preflight.excluded_instagram_id IS NOT NULL
       OR v_preflight.pii_scrubbed_at IS NULL
       OR v_lineage.order_id IS NULL
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR 1 <> (
            SELECT pg_catalog.count(*) FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'coordinator:bootstrap'
              AND job.track = 'coordinator'
              AND job.kind = 'bootstrap'
              AND job.status = 'completed'
              AND job.attempt_count = 1
              AND job.last_error_code IS NULL
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:relationships:collect'
              AND job.track = 'relationships' AND job.kind = 'collection'
              AND job.status = 'failed' AND job.attempt_count = 1
              AND job.last_error_code = 'ANALYSIS_V2_JOB_HANDLER_FAILED'
       )
       OR NOT EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.job_key = 'track:target-evidence:collect'
              AND job.track = 'target_evidence'
              AND job.kind = 'collection'
              AND job.status = 'cancelled'
              AND job.attempt_count = 0
              AND job.last_error_code = 'REQUEST_TERMINATED'
       )
       OR 3 <> (
            SELECT pg_catalog.count(*)
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = v_request.id
              AND job.status IN ('pending', 'processing', 'retryable')
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_provider_runs AS run
            WHERE run.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
            WHERE adoption.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_provider_cost_ledger AS cost
            WHERE cost.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_ai_attempts AS attempt
            WHERE attempt.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_relationship_sides AS evidence
            WHERE evidence.request_id = v_request.id
       )
       OR EXISTS (
            SELECT 1 FROM public.analysis_v2_target_evidence_manifests AS evidence
            WHERE evidence.request_id = v_request.id
       )
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_requests AS original_request
            WHERE original_request.id = v_lineage.failed_request_id
              AND original_request.user_id = v_order.user_id
              AND original_request.pipeline_version = 'v2'
              AND original_request.status = 'failed'
              AND EXISTS (
                  SELECT 1
                  FROM public.analysis_v2_failure_receipts AS original_receipt
                  WHERE original_receipt.request_id = original_request.id
                    AND original_receipt.error_code = original_request.error_message
              )
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS source_run
            WHERE source_run.request_id = v_lineage.failed_request_id
              AND (
                  source_run.status <> 'succeeded'
                  OR source_run.run_id IS NULL
                  OR source_run.actual_usage_usd IS NULL
                  OR source_run.usage_reconciled_at IS NULL
              )
       )
       OR NOT public.analysis_v2_valid_recovery_adoption_preflights(
            v_order,
            (
                SELECT recovery_preflight
                FROM public.analysis_preflights AS recovery_preflight
                WHERE recovery_preflight.id = v_lineage.recovery_preflight_id
            ),
            v_normalized_preflight
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADOPTION_POLICY_FAILURE_REARM_INELIGIBLE',
            ERRCODE = 'P0001';
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
        v_new_preflight_id, v_order.user_id, v_base_preflight_key || '.r2',
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_preflight.launch_status_snapshot, v_preflight.plan_catalog_snapshot,
        v_preflight.plan_cards_snapshot, v_preflight.pricing_version,
        v_preflight.pricing_snapshot, v_preflight.policy_versions_snapshot,
        v_preflight.target_followers_count, v_preflight.target_following_count,
        FALSE, v_preflight.capacity_required_plan_id, v_preflight.required_plan_id,
        v_now, v_now, v_now + INTERVAL '30 minutes', v_now
    );
    INSERT INTO public.earlybird_adoption_policy_failure_rearms(
        order_id, original_failed_request_id, policy_failed_request_id,
        rearmed_preflight_id, expected_fulfillment_attempt_count,
        expected_manual_review_at
    ) VALUES (
        v_order.id, v_lineage.failed_request_id, v_request.id,
        v_new_preflight_id, v_fulfillment.attempt_count,
        p_expected_manual_review_at
    );
    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'paid', preflight_id = v_new_preflight_id,
        result_request_id = NULL, updated_at = v_now
    WHERE earlybird_order.id = v_order.id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending', request_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = v_now,
        last_error_code = NULL, last_error_at = NULL,
        manual_review_at = NULL, completed_at = NULL, updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;
    RETURN QUERY SELECT v_order.id, 'admission_pending'::TEXT,
        v_new_preflight_id, v_request.id;
END;
$$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;
