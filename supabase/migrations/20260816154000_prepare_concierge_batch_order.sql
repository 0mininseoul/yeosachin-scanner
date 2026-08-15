-- Prepare one future concierge batch order without invoking Earlybird
-- admission/advance state transitions. The reviewed PR431 publisher owns the
-- subsequent CAS publication transaction.
CREATE OR REPLACE FUNCTION public.prepare_concierge_batch_order(
    p_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
    v_current public.analysis_requests%ROWTYPE;
    v_source public.analysis_requests%ROWTYPE;
    v_source_id UUID;
    v_request_id UUID;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_reused_source BOOLEAN := FALSE;
BEGIN
    IF p_order_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_SCOPE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.*
      INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;

    IF v_order.id IS NULL
       OR v_order.status NOT IN ('paid', 'analysis_in_progress')
       OR v_order.paid_at IS NULL
       OR pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
            !~ '^[a-z0-9._]{1,30}$'
       OR v_order.plan_id NOT IN ('basic', 'standard') THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_SCOPE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    -- A prior invocation is reusable only when this exact forward path marked
    -- the request. Existing failed V2 requests are retained as immutable source
    -- evidence and never retried or advanced here.
    IF v_order.result_request_id IS NOT NULL THEN
        SELECT request.*
          INTO v_current
        FROM public.analysis_requests AS request
        WHERE request.id = v_order.result_request_id
        FOR UPDATE;
        IF v_current.id IS NULL
           OR v_current.user_id IS DISTINCT FROM v_order.user_id
           OR pg_catalog.lower(pg_catalog.btrim(v_current.target_instagram_id))
                IS DISTINCT FROM pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)) THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_SCOPE_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF COALESCE(v_current.step_data, '{}'::JSONB) ? 'conciergeBatchBootstrap' THEN
            v_source_id := (v_current.step_data->'conciergeBatchBootstrap'->>'sourceRequestId')::UUID;
            RETURN pg_catalog.jsonb_build_object(
                'orderId', p_order_id,
                'sourceRequestId', v_source_id,
                'requestId', v_current.id,
                'ownerId', v_order.user_id,
                'targetUsername', pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)),
                'planId', v_order.plan_id,
                'preflightId', v_order.preflight_id,
                'reused', TRUE
            );
        END IF;
        IF v_current.status NOT IN ('failed', 'completed') THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_REQUEST_CONFLICT', ERRCODE = 'P0001';
        END IF;
        v_source := v_current;
        v_source_id := v_current.id;
        v_reused_source := TRUE;
    ELSE
        v_source_id := extensions.gen_random_uuid();
        INSERT INTO public.analysis_requests (
            id, user_id, target_instagram_id, target_gender, status, progress,
            progress_step, current_step, step_data, gender_stats, plan_type,
            background_processing, idempotency_key, pipeline_version
        ) VALUES (
            v_source_id, v_order.user_id,
            pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)),
            'male', 'completed', 100, 'concierge source retained', 'completed',
            pg_catalog.jsonb_build_object(
                'conciergeBatchSource', TRUE,
                'orderId', p_order_id,
                'preflightId', v_order.preflight_id
            ), '{}'::JSONB, v_order.plan_id, FALSE,
            'concierge-batch-source:' || pg_catalog.lower(v_order.id::TEXT), 'v1'
        );
    END IF;

    v_request_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_requests (
        id, user_id, target_instagram_id, target_gender, status, progress,
        progress_step, current_step, step_data, gender_stats, plan_type,
        background_processing, idempotency_key, pipeline_version
    ) VALUES (
        v_request_id, v_order.user_id,
        pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)),
        'male', 'pending', 0, 'concierge batch pending', 'pending',
        pg_catalog.jsonb_build_object(
            'conciergeBatchBootstrap', pg_catalog.jsonb_build_object(
                'sourceRequestId', v_source_id,
                'orderId', p_order_id,
                'preflightId', v_order.preflight_id,
                'createdAt', v_now
            )
        ), '{}'::JSONB, v_order.plan_id, FALSE,
        'concierge-batch-result:' || pg_catalog.lower(v_order.id::TEXT), 'v1'
    );

    UPDATE public.earlybird_orders
    SET status = 'analysis_in_progress',
        result_request_id = v_request_id,
        updated_at = v_now
    WHERE id = p_order_id
      AND status IN ('paid', 'analysis_in_progress')
      AND (result_request_id IS NULL OR result_request_id = v_source_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_SCOPE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'orderId', p_order_id,
        'sourceRequestId', v_source_id,
        'requestId', v_request_id,
        'ownerId', v_order.user_id,
        'targetUsername', pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)),
        'planId', v_order.plan_id,
        'preflightId', v_order.preflight_id,
        'reused', v_reused_source
    );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_concierge_batch_order(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_concierge_batch_order(UUID)
    TO service_role;

COMMENT ON FUNCTION public.prepare_concierge_batch_order(UUID)
    IS 'Service-role-only concierge batch request pair bootstrap; never advances Earlybird fulfillment.';
