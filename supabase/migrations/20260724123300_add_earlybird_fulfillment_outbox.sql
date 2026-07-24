SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.earlybird_fulfillments (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'awaiting_operator',
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    lease_fence BIGINT NOT NULL DEFAULT 0,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    next_attempt_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    request_id UUID UNIQUE REFERENCES public.analysis_requests(id)
        ON DELETE RESTRICT,
    operator_admitted_at TIMESTAMP WITH TIME ZONE,
    last_error_code VARCHAR(64),
    last_error_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    manual_review_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT earlybird_fulfillments_status_check CHECK (
        status IN ('awaiting_operator', 'admission_pending', 'analysis_in_progress', 'completed', 'retryable_failure', 'manual_review')
    ),
    CONSTRAINT earlybird_fulfillments_attempt_count_check CHECK (
        attempt_count BETWEEN 0 AND 10
    ),
    CONSTRAINT earlybird_fulfillments_lease_fence_check CHECK (
        lease_fence BETWEEN 0 AND 9223372036854775806
    ),
    CONSTRAINT earlybird_fulfillments_error_code_check CHECK (
        last_error_code IS NULL
        OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,63}$'
    ),
    CONSTRAINT earlybird_fulfillments_lease_shape_check CHECK (
        (lease_token IS NULL AND lease_expires_at IS NULL)
        OR (
            lease_token IS NOT NULL
            AND lease_expires_at IS NOT NULL
            AND status IN ('admission_pending', 'retryable_failure')
        )
    ),
    CONSTRAINT earlybird_fulfillments_admission_shape_check CHECK (
        (
            status = 'awaiting_operator'
            AND operator_admitted_at IS NULL
            AND request_id IS NULL
        )
        OR (
            status <> 'awaiting_operator'
            AND operator_admitted_at IS NOT NULL
        )
    ),
    CONSTRAINT earlybird_fulfillments_request_shape_check CHECK (
        (
            status IN ('analysis_in_progress', 'completed')
            AND request_id IS NOT NULL
        )
        OR status NOT IN ('analysis_in_progress', 'completed')
    ),
    CONSTRAINT earlybird_fulfillments_terminal_shape_check CHECK (
        (status = 'completed' AND completed_at IS NOT NULL)
        OR (status <> 'completed' AND completed_at IS NULL)
    ),
    CONSTRAINT earlybird_fulfillments_review_shape_check CHECK (
        (status = 'manual_review' AND manual_review_at IS NOT NULL)
        OR (status <> 'manual_review' AND manual_review_at IS NULL)
    )
);

CREATE INDEX earlybird_fulfillments_recovery_idx
    ON public.earlybird_fulfillments(status, next_attempt_at, created_at)
    WHERE status IN (
        'admission_pending',
        'retryable_failure',
        'analysis_in_progress'
    );

ALTER TABLE public.earlybird_fulfillments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_fulfillments
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.enqueue_earlybird_fulfillment(
    p_order_id UUID
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
    v_status TEXT;
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
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_ORDER_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_order.status = 'paid'
       AND v_order.seller_reference_confirmed_at IS NOT NULL
       AND v_order.payment_id IS NOT NULL
       AND v_order.actual_amount_krw IS NOT NULL
       AND v_order.actual_amount_krw BETWEEN 0 AND v_order.expected_amount_krw
       AND v_order.actual_groble_product_id
            IS NOT DISTINCT FROM v_order.expected_groble_product_id THEN
        INSERT INTO public.earlybird_fulfillments(
            order_id,
            status
        ) VALUES (
            v_order.id,
            'awaiting_operator'
        )
        ON CONFLICT (order_id) DO NOTHING;
    END IF;

    SELECT fulfillment.status INTO v_status
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id;
    RETURN v_status;
END;
$$;

CREATE FUNCTION public.enqueue_reference_confirmed_earlybird_fulfillment()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.enqueue_earlybird_fulfillment(NEW.id);
    RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_reference_confirmed_earlybird_fulfillment
AFTER INSERT OR UPDATE OF status, seller_reference_confirmed_at
ON public.earlybird_orders
FOR EACH ROW
EXECUTE FUNCTION public.enqueue_reference_confirmed_earlybird_fulfillment();

CREATE FUNCTION public.admit_earlybird_fulfillment(
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

    UPDATE public.analysis_preflights AS preflight
    SET target_instagram_id = v_order.target_instagram_id,
        target_followers_count = v_order.target_followers_count,
        target_following_count = v_order.target_following_count,
        target_is_private = FALSE,
        exclusion_decision = v_order.exclusion_decision,
        excluded_instagram_id = v_order.excluded_instagram_id,
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

CREATE FUNCTION public.list_recoverable_earlybird_fulfillments(
    p_limit INTEGER DEFAULT 20
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
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT
        fulfillment.order_id,
        fulfillment.status,
        earlybird_order.preflight_id,
        earlybird_order.user_id,
        earlybird_order.plan_id,
        fulfillment.request_id
    FROM public.earlybird_fulfillments AS fulfillment
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = fulfillment.order_id
    WHERE fulfillment.status IN ('admission_pending', 'retryable_failure')
      AND fulfillment.operator_admitted_at IS NOT NULL
      AND fulfillment.next_attempt_at <= pg_catalog.clock_timestamp()
      AND (
          fulfillment.lease_token IS NULL
          OR fulfillment.lease_expires_at <= pg_catalog.clock_timestamp()
      )
    ORDER BY fulfillment.next_attempt_at, fulfillment.created_at
    LIMIT p_limit;
END;
$$;

CREATE FUNCTION public.claim_earlybird_fulfillment(
    p_order_id UUID,
    p_lease_token UUID,
    p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE(
    claimed BOOLEAN,
    fulfillment_status TEXT,
    lease_token UUID,
    lease_fence BIGINT,
    attempt_count INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_expected_admission_hash TEXT;
    v_is_admitted BOOLEAN;
BEGIN
    IF p_order_id IS NULL
       OR p_lease_token IS NULL
       OR p_lease_seconds IS NULL
       OR p_lease_seconds NOT BETWEEN 60 AND 600 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_is_admitted := v_fulfillment.status IN ('admission_pending', 'retryable_failure');
    IF NOT v_is_admitted
       OR v_fulfillment.operator_admitted_at IS NULL
       OR v_fulfillment.request_id IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_STATE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    IF v_fulfillment.lease_token IS NOT NULL
       AND v_fulfillment.lease_expires_at > v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_LEASE_BUSY',
            ERRCODE = 'P0001';
    END IF;

    v_expected_admission_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'earlybird-fulfillment-admission-v1'
                    || pg_catalog.chr(10)
                    || pg_catalog.lower(p_order_id::TEXT),
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
    IF v_order.status <> 'paid'
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_preflight.status <> 'ready'
       OR v_preflight.consumed_request_id IS NOT NULL
       OR v_preflight.admission_status <> 'ready'
       OR v_preflight.admission_selected_plan_id
            IS DISTINCT FROM v_order.plan_id
       OR v_preflight.admission_entitlement_jti_hash
            IS DISTINCT FROM v_expected_admission_hash
       OR v_preflight.admission_token IS NULL
       OR v_preflight.admission_refreshed_at IS NULL
       OR v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'
       OR v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds'
       OR v_preflight.admission_plan_cards_snapshot
            ->v_order.plan_id->>'selectionState'
            NOT IN ('required', 'available_upgrade') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_ADMISSION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    IF v_fulfillment.attempt_count >= 10 THEN
        UPDATE public.earlybird_fulfillments AS fulfillment
        SET status = 'manual_review',
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = 'ATTEMPT_EXHAUSTED',
            last_error_at = v_now,
            manual_review_at = v_now,
            updated_at = v_now
        WHERE fulfillment.order_id = p_order_id
        RETURNING fulfillment.* INTO v_fulfillment;
        RETURN QUERY SELECT
            FALSE,
            v_fulfillment.status,
            NULL::UUID,
            v_fulfillment.lease_fence,
            v_fulfillment.attempt_count::INTEGER;
        RETURN;
    END IF;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending',
        attempt_count = v_fulfillment.attempt_count + 1,
        lease_fence = v_fulfillment.lease_fence + 1,
        lease_token = p_lease_token,
        lease_expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
        last_error_code = NULL,
        last_error_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = p_order_id
    RETURNING fulfillment.* INTO v_fulfillment;

    RETURN QUERY SELECT
        TRUE,
        v_fulfillment.status,
        v_fulfillment.lease_token,
        v_fulfillment.lease_fence,
        v_fulfillment.attempt_count::INTEGER;
END;
$$;

CREATE FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    p_order_id UUID,
    p_lease_token UUID,
    p_lease_fence BIGINT
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_initial_job_key CONSTANT TEXT := 'coordinator:bootstrap';
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request_id UUID;
    v_scope_snapshot JSONB;
    v_selected_card JSONB;
    v_input_hash TEXT;
BEGIN
    IF p_order_id IS NULL
       OR p_lease_token IS NULL
       OR p_lease_fence IS NULL
       OR p_lease_fence < 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_fulfillment.request_id IS NOT NULL
       OR v_order.result_request_id IS NOT NULL
       OR v_preflight.consumed_request_id IS NOT NULL THEN
        IF v_fulfillment.request_id IS NULL
           OR v_order.result_request_id IS DISTINCT FROM v_fulfillment.request_id
           OR v_preflight.consumed_request_id
                IS DISTINCT FROM v_fulfillment.request_id THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review',
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = 'REQUEST_CONFLICT',
                last_error_at = v_now,
                manual_review_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT
                p_order_id,
                'manual_review'::TEXT,
                NULL::UUID,
                FALSE,
                NULL::TEXT;
            RETURN;
        END IF;

        SELECT analysis_request.* INTO v_request
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = v_fulfillment.request_id
          AND analysis_request.user_id = v_order.user_id
          AND analysis_request.preflight_id = v_order.preflight_id
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.plan_access_mode_snapshot = 'production'
          AND analysis_request.selected_plan_id_snapshot = v_order.plan_id;
        IF NOT FOUND THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review',
                lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = 'REQUEST_CONFLICT',
                last_error_at = v_now,
                manual_review_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT
                p_order_id,
                'manual_review'::TEXT,
                NULL::UUID,
                FALSE,
                NULL::TEXT;
            RETURN;
        END IF;

        UPDATE public.earlybird_fulfillments AS fulfillment
        SET status = CASE
                WHEN v_request.status = 'completed' THEN 'completed'
                ELSE 'analysis_in_progress'
            END,
            lease_token = NULL,
            lease_expires_at = NULL,
            completed_at = CASE
                WHEN v_request.status = 'completed' THEN v_now
                ELSE NULL
            END,
            updated_at = v_now
        WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT
            p_order_id,
            CASE WHEN v_request.status = 'completed'
                THEN 'completed'::TEXT
                ELSE 'analysis_in_progress'::TEXT
            END,
            v_request.id,
            FALSE,
            v_initial_job_key;
        RETURN;
    END IF;

    IF v_fulfillment.lease_token IS DISTINCT FROM p_lease_token
       OR v_fulfillment.lease_fence IS DISTINCT FROM p_lease_fence
       OR v_fulfillment.lease_expires_at IS NULL
       OR v_fulfillment.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_LEASE_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF v_order.status <> 'paid'
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_preflight.status <> 'ready'
       OR v_preflight.access_mode <> 'production'
       OR v_preflight.target_instagram_id
            IS DISTINCT FROM v_order.target_instagram_id
       OR v_preflight.exclusion_decision
            IS DISTINCT FROM v_order.exclusion_decision
       OR v_preflight.excluded_instagram_id
            IS DISTINCT FROM v_order.excluded_instagram_id
       OR v_preflight.admission_status <> 'ready'
       OR v_preflight.admission_selected_plan_id
            IS DISTINCT FROM v_order.plan_id
       OR v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes'
       OR v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds' THEN
        UPDATE public.earlybird_fulfillments AS fulfillment
        SET status = 'manual_review',
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = 'SNAPSHOT_CONFLICT',
            last_error_at = v_now,
            manual_review_at = v_now,
            updated_at = v_now
        WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT
            p_order_id,
            'manual_review'::TEXT,
            NULL::UUID,
            FALSE,
            NULL::TEXT;
        RETURN;
    END IF;

    v_selected_card := v_preflight.plan_cards_snapshot->v_order.plan_id;
    IF v_selected_card IS NULL
       OR v_selected_card->>'launchStatus' <> 'production'
       OR v_selected_card->>'selectionState'
            NOT IN ('required', 'available_upgrade')
       OR v_preflight.target_followers_count
            > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_preflight.target_following_count
            > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER THEN
        UPDATE public.earlybird_fulfillments AS fulfillment
        SET status = 'manual_review',
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = 'PLAN_NOT_ALLOWED',
            last_error_at = v_now,
            manual_review_at = v_now,
            updated_at = v_now
        WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT
            p_order_id,
            'manual_review'::TEXT,
            NULL::UUID,
            FALSE,
            NULL::TEXT;
        RETURN;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_requests AS active_request
        WHERE active_request.user_id = v_order.user_id
          AND active_request.status IN ('pending', 'processing')
    ) THEN
        UPDATE public.earlybird_fulfillments AS fulfillment
        SET status = 'manual_review',
            lease_token = NULL,
            lease_expires_at = NULL,
            last_error_code = 'ACTIVE_REQUEST_CONFLICT',
            last_error_at = v_now,
            manual_review_at = v_now,
            updated_at = v_now
        WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT
            p_order_id,
            'manual_review'::TEXT,
            NULL::UUID,
            FALSE,
            NULL::TEXT;
        RETURN;
    END IF;

    v_scope_snapshot := pg_catalog.jsonb_build_object(
        'relationshipCapacity', v_selected_card->'relationshipCapacity',
        'detailedMutualLimit', v_selected_card->'detailedMutualLimit'
    );
    IF NOT public.analysis_v2_valid_scope_snapshot(v_scope_snapshot) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_request_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_requests (
        id,
        user_id,
        target_instagram_id,
        target_gender,
        status,
        progress,
        progress_step,
        current_step,
        step_data,
        gender_stats,
        plan_type,
        background_processing,
        idempotency_key,
        pipeline_version,
        preflight_id,
        excluded_instagram_id,
        exclusion_decision_snapshot,
        plan_access_mode_snapshot,
        capacity_required_plan_id_snapshot,
        required_plan_id_snapshot,
        selected_plan_id_snapshot,
        plan_launch_status_snapshot,
        plan_cards_snapshot,
        pricing_version_snapshot,
        pricing_snapshot,
        analysis_scope_snapshot,
        policy_versions_snapshot
    ) VALUES (
        v_request_id,
        v_order.user_id,
        v_order.target_instagram_id,
        'male',
        'pending',
        0,
        '분석 대기 중...',
        'pending',
        '{}'::JSONB,
        '{}'::JSONB,
        v_order.plan_id,
        TRUE,
        'earlybird:' || pg_catalog.lower(v_order.id::TEXT),
        'v2',
        v_preflight.id,
        v_order.excluded_instagram_id,
        v_order.exclusion_decision,
        'production',
        v_preflight.capacity_required_plan_id,
        v_preflight.required_plan_id,
        v_order.plan_id,
        v_preflight.launch_status_snapshot,
        v_preflight.plan_cards_snapshot,
        v_preflight.pricing_version,
        v_preflight.pricing_snapshot,
        v_scope_snapshot,
        v_preflight.policy_versions_snapshot
    );

    UPDATE public.analysis_preflights AS preflight
    SET status = 'consumed',
        consumed_at = v_now,
        consumed_request_id = v_request_id,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id;

    v_input_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'analysis-v2-job-input-v1'
                    || pg_catalog.chr(10)
                    || pg_catalog.lower(v_request_id::TEXT)
                    || pg_catalog.chr(10)
                    || v_initial_job_key,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );
    INSERT INTO public.analysis_pipeline_jobs (
        request_id,
        job_key,
        track,
        kind,
        batch,
        input_hash,
        required_job_keys
    ) VALUES (
        v_request_id,
        v_initial_job_key,
        'coordinator',
        'bootstrap',
        NULL,
        v_input_hash,
        '{}'::TEXT[]
    )
    ON CONFLICT ON CONSTRAINT analysis_pipeline_jobs_pkey DO NOTHING;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = v_request_id
      AND job.job_key = v_initial_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.track <> 'coordinator'
       OR v_job.kind <> 'bootstrap'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash <> v_input_hash
       OR v_job.required_job_keys <> '{}'::TEXT[] THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_REQUEST_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'analysis_in_progress',
        result_request_id = v_request_id,
        updated_at = v_now
    WHERE earlybird_order.id = p_order_id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'analysis_in_progress',
        request_id = v_request_id,
        lease_token = NULL,
        lease_expires_at = NULL,
        next_attempt_at = v_now,
        last_error_code = NULL,
        last_error_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = p_order_id;

    RETURN QUERY SELECT
        p_order_id,
        'analysis_in_progress'::TEXT,
        v_request_id,
        TRUE,
        v_initial_job_key;
END;
$$;

CREATE FUNCTION public.mark_earlybird_fulfillment_manual_review(
    p_order_id UUID,
    p_error_code TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_status TEXT;
BEGIN
    IF p_order_id IS NULL
       OR p_error_code IS NULL
       OR p_error_code NOT IN (
            'TARGET_UNAVAILABLE',
            'PLAN_NOT_ALLOWED',
            'PAYMENT_STATE',
            'SNAPSHOT_CONFLICT',
            'REQUEST_CONFLICT',
            'ACTIVE_REQUEST_CONFLICT',
            'ATTEMPT_EXHAUSTED'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'manual_review',
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = p_error_code,
        last_error_at = v_now,
        manual_review_at = v_now,
        updated_at = v_now
    WHERE fulfillment.order_id = p_order_id
      AND fulfillment.operator_admitted_at IS NOT NULL
      AND fulfillment.request_id IS NULL
      AND fulfillment.status IN ('admission_pending', 'retryable_failure')
    RETURNING fulfillment.status INTO v_status;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_STATE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    RETURN v_status;
END;
$$;

CREATE FUNCTION public.reconcile_earlybird_fulfillments(
    p_limit INTEGER DEFAULT 100
)
RETURNS TABLE(
    scanned INTEGER,
    completed INTEGER,
    manual_review INTEGER,
    retryable INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_row RECORD;
    v_scanned INTEGER := 0;
    v_completed INTEGER := 0;
    v_manual_review INTEGER := 0;
    v_retryable INTEGER := 0;
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    FOR v_row IN
        SELECT
            fulfillment.order_id,
            fulfillment.status,
            fulfillment.request_id,
            fulfillment.lease_token,
            fulfillment.lease_expires_at,
            earlybird_order.user_id AS order_user_id,
            earlybird_order.status AS order_status,
            earlybird_order.result_request_id,
            analysis_request.user_id AS request_user_id,
            analysis_request.status AS request_status,
            analysis_request.status = 'completed' AS request_completed,
            analysis_request.status = 'failed' AS request_failed
        FROM public.earlybird_fulfillments AS fulfillment
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = fulfillment.order_id
        LEFT JOIN public.analysis_requests AS analysis_request
          ON analysis_request.id = fulfillment.request_id
        WHERE (
            fulfillment.status = 'analysis_in_progress'
            OR (
                fulfillment.status IN (
                    'admission_pending',
                    'retryable_failure'
                )
                AND fulfillment.lease_token IS NOT NULL
                AND fulfillment.lease_expires_at <= v_now
            )
        )
        ORDER BY fulfillment.updated_at, fulfillment.order_id
        LIMIT p_limit
        FOR UPDATE OF fulfillment, earlybird_order
    LOOP
        v_scanned := v_scanned + 1;
        IF v_row.status IN ('admission_pending', 'retryable_failure') THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'retryable_failure',
                lease_token = NULL,
                lease_expires_at = NULL,
                next_attempt_at = v_now,
                last_error_code = 'LEASE_EXPIRED',
                last_error_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = v_row.order_id;
            v_retryable := v_retryable + 1;
        ELSIF v_row.order_status <> 'analysis_in_progress' THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review',
                last_error_code = 'PAYMENT_STATE',
                last_error_at = v_now,
                manual_review_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = v_row.order_id;
            v_manual_review := v_manual_review + 1;
        ELSIF v_row.request_id IS NULL
           OR v_row.result_request_id IS DISTINCT FROM v_row.request_id
           OR v_row.request_user_id IS DISTINCT FROM v_row.order_user_id
           OR v_row.request_status IS NULL THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review',
                last_error_code = 'REQUEST_CONFLICT',
                last_error_at = v_now,
                manual_review_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = v_row.order_id;
            v_manual_review := v_manual_review + 1;
        ELSIF v_row.request_completed THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'completed',
                completed_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = v_row.order_id;
            UPDATE public.earlybird_orders AS earlybird_order
            SET status = 'completed',
                updated_at = v_now
            WHERE earlybird_order.id = v_row.order_id;
            v_completed := v_completed + 1;
        ELSIF v_row.request_failed THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review',
                last_error_code = 'ANALYSIS_FAILED',
                last_error_at = v_now,
                manual_review_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = v_row.order_id;
            v_manual_review := v_manual_review + 1;
        END IF;
    END LOOP;

    RETURN QUERY SELECT
        v_scanned,
        v_completed,
        v_manual_review,
        v_retryable;
END;
$$;

INSERT INTO public.earlybird_fulfillments(order_id, status)
SELECT earlybird_order.id, 'awaiting_operator'
FROM public.earlybird_orders AS earlybird_order
WHERE earlybird_order.status = 'paid'
  AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
  AND earlybird_order.payment_id IS NOT NULL
  AND earlybird_order.actual_amount_krw IS NOT NULL
  AND earlybird_order.actual_amount_krw
        BETWEEN 0 AND earlybird_order.expected_amount_krw
  AND earlybird_order.actual_groble_product_id
        IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
ON CONFLICT (order_id) DO NOTHING;

REVOKE ALL ON FUNCTION public.enqueue_earlybird_fulfillment(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_reference_confirmed_earlybird_fulfillment()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.admit_earlybird_fulfillment(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_recoverable_earlybird_fulfillments(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_earlybird_fulfillment(UUID, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_earlybird_fulfillment_manual_review(
    UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reconcile_earlybird_fulfillments(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.enqueue_earlybird_fulfillment(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.admit_earlybird_fulfillment(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.list_recoverable_earlybird_fulfillments(INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_earlybird_fulfillment(
    UUID, UUID, INTEGER
) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.mark_earlybird_fulfillment_manual_review(
    UUID, TEXT
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_earlybird_fulfillments(INTEGER)
    TO service_role;
