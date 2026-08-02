-- UUID-only, read-only capture source for one completed paid production Standard run.
-- Target identifiers and retained result content never cross this RPC boundary.
CREATE FUNCTION public.read_analysis_v2_current_production_replay_source(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_provider_runs JSONB;
    v_preflight_runs JSONB;
    v_provider_run_count INTEGER;
    v_preflight_run_count INTEGER;
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_SOURCE_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT request.*
    INTO v_request
    FROM public.analysis_requests AS request
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = request.preflight_id
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.preflight_id = preflight.id
     AND earlybird_order.result_request_id = request.id
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
     AND fulfillment.request_id = request.id
    JOIN public.analysis_v2_result_summaries AS result_summary
      ON result_summary.request_id = request.id
    WHERE request.id = p_request_id
      AND request.status = 'completed'
      AND request.completed_at IS NOT NULL
      AND request.pipeline_version = 'v2'
      AND request.selected_plan_id_snapshot = 'standard'
      AND request.plan_access_mode_snapshot = 'production'
      AND request.test_entitlement_jti_hash IS NULL
      AND request.policy_versions_snapshot =
          '{"pipeline":"v2","risk":"risk-policy-v2.5","aiStage":"ai-stage-policy-v2.10","scheduler":"ai-scheduler-v1"}'::JSONB
      AND preflight.user_id = request.user_id
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'production'
      AND preflight.consumed_request_id = request.id
      AND preflight.policy_versions_snapshot = request.policy_versions_snapshot
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id = 'retained.'
          || pg_catalog.substr(
              pg_catalog.replace(preflight.id::TEXT, '-', ''),
              1,
              20
          )
      AND preflight.target_full_name IS NULL
      AND preflight.target_bio IS NULL
      AND preflight.target_profile_image_url IS NULL
      AND preflight.exclusion_decision = 'skip'
      AND preflight.excluded_instagram_id IS NULL
      AND earlybird_order.user_id = request.user_id
      AND earlybird_order.plan_id = 'standard'
      AND earlybird_order.status = 'completed'
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.paid_at IS NOT NULL
      AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
      AND earlybird_order.actual_groble_product_id
          IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
      AND earlybird_order.actual_amount_krw IS NOT NULL
      AND earlybird_order.actual_amount_krw > 0
      AND earlybird_order.actual_amount_krw <= earlybird_order.expected_amount_krw
      AND fulfillment.status = 'completed'
      AND fulfillment.completed_at IS NOT NULL
      AND result_summary.plan_id = 'standard'
      AND result_summary.score_policy_version = 'risk-policy-v2.5'
      AND (
          SELECT pg_catalog.count(*)
          FROM public.earlybird_webhook_events AS payment_event
          WHERE payment_event.order_id = earlybird_order.id
            AND payment_event.event_type = 'payment.completed'
            AND payment_event.disposition = 'accepted'
            AND payment_event.payment_id = earlybird_order.payment_id
            AND payment_event.product_id = earlybird_order.actual_groble_product_id
            AND payment_event.amount_krw = earlybird_order.actual_amount_krw
      ) = 1;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_SOURCE_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_request.preflight_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_SOURCE_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*) INTO v_provider_run_count
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = v_request.id;
    IF v_provider_run_count NOT BETWEEN 1 AND 128
       OR EXISTS (
          SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
          WHERE provider_run.request_id = v_request.id
            AND (
                provider_run.logical_provider <> 'apify'
                OR provider_run.status <> 'succeeded'
                OR provider_run.run_id IS NULL
                OR provider_run.terminalized_at IS NULL
                OR provider_run.actual_usage_usd IS NULL
                OR provider_run.usage_reconciled_at IS NULL
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_PROVIDER_LEDGER_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*) INTO v_preflight_run_count
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = v_preflight.id;
    IF v_preflight_run_count NOT BETWEEN 1 AND 4
       OR EXISTS (
          SELECT 1 FROM public.analysis_preflight_provider_runs AS provider_run
          WHERE provider_run.preflight_id = v_preflight.id
            AND (
                provider_run.logical_provider <> 'apify'
                OR provider_run.status <> 'succeeded'
                OR provider_run.run_id IS NULL
                OR provider_run.terminalized_at IS NULL
                OR provider_run.actual_usage_usd IS NULL
                OR provider_run.usage_reconciled_at IS NULL
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_PROVIDER_LEDGER_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actorId', run.actor_id,
        'credentialSlot', run.credential_slot,
        'runId', run.run_id,
        'status', run.status,
        'operationKey', run.operation_key
    ) ORDER BY run.job_key, run.operation_key)
    INTO v_provider_runs
    FROM public.analysis_v2_provider_runs AS run
    WHERE run.request_id = v_request.id;

    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'actorId', run.actor_id,
        'credentialSlot', run.credential_slot,
        'runId', run.run_id,
        'status', run.status,
        'operationKey', run.operation_key
    ) ORDER BY run.operation_key)
    INTO v_preflight_runs
    FROM public.analysis_preflight_provider_runs AS run
    WHERE run.preflight_id = v_preflight.id;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request.id,
        'preflightId', v_preflight.id,
        'targetUsername', 'replay_' || pg_catalog.substr(pg_catalog.md5(
            v_request.id::TEXT || ':' || v_preflight.id::TEXT
        ), 1, 23),
        'selectedPlanId', 'standard',
        'policyVersions', v_request.policy_versions_snapshot,
        'preflightRuns', v_preflight_runs,
        'providerRuns', v_provider_runs
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_analysis_v2_current_production_replay_source(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_analysis_v2_current_production_replay_source(UUID)
    TO service_role;

COMMENT ON FUNCTION public.read_analysis_v2_current_production_replay_source(UUID) IS
    'Read-only UUID source for an exact paid production Standard replay; requires scrubbed same-user lineage, immutable payment/fulfillment/result evidence, and bounded reconciled Apify ledgers.';
