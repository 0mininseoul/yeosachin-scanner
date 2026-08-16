-- Prepare one future concierge batch order without invoking Earlybird
-- admission/advance state transitions. The reviewed PR431 publisher owns the
-- subsequent CAS publication transaction.
--
-- The first service-role invocation freezes the exact authorized 30-order
-- cohort. Subsequent invocations read only that immutable manifest; they never
-- reselect newly-created paid rows.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.earlybird_concierge_batch_cohort_members (
    cohort_key TEXT NOT NULL CHECK (cohort_key = 'concierge-fallback-20260816'),
    order_id UUID NOT NULL REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    owner_id UUID NOT NULL,
    target_username TEXT NOT NULL CHECK (target_username ~ '^[a-z0-9._]{1,30}$'),
    plan_id TEXT NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    cohort TEXT NOT NULL CHECK (cohort IN ('awaiting_operator', 'failed_canary')),
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    original_result_request_id UUID REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    target_followers_count INTEGER NOT NULL CHECK (target_followers_count BETWEEN 0 AND 10000000),
    target_following_count INTEGER NOT NULL CHECK (target_following_count BETWEEN 0 AND 10000000),
    snapshot_order_status TEXT NOT NULL CHECK (snapshot_order_status IN ('paid', 'analysis_in_progress')),
    snapshot_fulfillment_status TEXT NOT NULL CHECK (snapshot_fulfillment_status IN ('awaiting_operator', 'analysis_in_progress')),
    snapshot_request_status TEXT CHECK (snapshot_request_status IS NULL OR snapshot_request_status = 'failed'),
    snapshot_error_code TEXT CHECK (
        snapshot_error_code IS NULL
        OR snapshot_error_code IN (
            'SCRAPING_INCOMPLETE_ERROR',
            'SCRAPING_PROVIDER_QUOTA_ERROR',
            'SCRAPING_PROVIDER_START_REJECTED_ERROR'
        )
    ),
    payment_id_fingerprint TEXT NOT NULL CHECK (payment_id_fingerprint ~ '^[a-f0-9]{64}$'),
    expected_amount_krw INTEGER NOT NULL CHECK (expected_amount_krw > 0),
    expected_product_id TEXT NOT NULL,
    actual_amount_krw INTEGER,
    actual_product_id TEXT,
    paid_at TIMESTAMP WITH TIME ZONE NOT NULL,
    evidence_hash TEXT NOT NULL CHECK (evidence_hash ~ '^[a-f0-9]{64}$'),
    manifest_hash TEXT NOT NULL CHECK (manifest_hash ~ '^[a-f0-9]{64}$'),
    frozen_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (cohort_key, order_id)
);

ALTER TABLE public.earlybird_concierge_batch_cohort_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_concierge_batch_cohort_members FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_concierge_batch_cohort_members
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prevent_earlybird_concierge_batch_cohort_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'CONCIERGE_BATCH_COHORT_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_earlybird_concierge_batch_cohort_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_concierge_batch_cohort_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_concierge_batch_cohort_members
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_concierge_batch_cohort_mutation();

CREATE FUNCTION public.freeze_concierge_batch_cohort(
    p_expected_manifest_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_cohort_key CONSTANT TEXT := 'concierge-fallback-20260816';
    v_count INTEGER;
    v_manifest_hash TEXT;
    v_existing_hash TEXT;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_expected_manifest_hash IS NULL
       OR p_expected_manifest_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_EXPECTED_HASH_REQUIRED', ERRCODE = 'P0001';
    END IF;
    LOCK TABLE public.earlybird_concierge_batch_cohort_members IN SHARE ROW EXCLUSIVE MODE;
    SELECT pg_catalog.count(*), pg_catalog.min(member.manifest_hash), pg_catalog.max(member.manifest_hash)
      INTO v_count, v_existing_hash, v_manifest_hash
    FROM public.earlybird_concierge_batch_cohort_members AS member
    WHERE member.cohort_key = v_cohort_key;
    IF v_count > 0 THEN
        IF v_count <> 30
           OR v_existing_hash IS NULL
           OR v_existing_hash IS DISTINCT FROM v_manifest_hash
           OR v_existing_hash IS DISTINCT FROM p_expected_manifest_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_COHORT_MANIFEST_INVALID', ERRCODE = 'P0001';
        END IF;
        RETURN (
            SELECT pg_catalog.jsonb_build_object(
                'cohortKey', v_cohort_key,
                'manifestHash', v_existing_hash,
                'members', COALESCE(
                    pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'orderId', member.order_id,
                            'ownerId', member.owner_id,
                            'targetUsername', member.target_username,
                            'planId', member.plan_id,
                            'cohort', member.cohort,
                            'preflightId', member.preflight_id,
                            'originalResultRequestId', member.original_result_request_id,
                            'targetFollowersCount', member.target_followers_count,
                            'targetFollowingCount', member.target_following_count,
                            'snapshotOrderStatus', member.snapshot_order_status,
                            'snapshotFulfillmentStatus', member.snapshot_fulfillment_status,
                            'snapshotRequestStatus', member.snapshot_request_status,
                            'snapshotErrorCode', member.snapshot_error_code,
                            'paymentIdFingerprint', member.payment_id_fingerprint,
                            'expectedAmountKrw', member.expected_amount_krw,
                            'expectedProductId', member.expected_product_id,
                            'actualAmountKrw', member.actual_amount_krw,
                            'actualProductId', member.actual_product_id,
                            'paidAt', member.paid_at,
                            'evidenceHash', member.evidence_hash,
                            'manifestHash', member.manifest_hash,
                            'frozenAt', member.frozen_at,
                            'currentOrderStatus', earlybird_order.status,
                            'currentFulfillmentStatus', fulfillment.status,
                            'currentRequestStatus', request.status,
                            'published', (
                                earlybird_order.status = 'completed'
                                OR COALESCE(request.step_data#>>'{conciergeBatchPublication,version}', '0') ~ '^[1-9][0-9]*$'
                            )
                        ) ORDER BY member.order_id
                    ), '[]'::JSONB
                )
            )
            FROM public.earlybird_concierge_batch_cohort_members AS member
            JOIN public.earlybird_orders AS earlybird_order
              ON earlybird_order.id = member.order_id
            JOIN public.earlybird_fulfillments AS fulfillment
              ON fulfillment.order_id = member.order_id
            LEFT JOIN public.analysis_requests AS request
              ON request.id = earlybird_order.result_request_id
            WHERE member.cohort_key = v_cohort_key
        );
    END IF;

    -- Lock only the exact first-pass candidate shape before counting or
    -- hashing. Any concurrent payment/refund/status mutation therefore either
    -- waits for this transaction or is rejected by the rechecked count.
    PERFORM earlybird_order.id
    FROM public.earlybird_orders AS earlybird_order
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    LEFT JOIN public.analysis_requests AS request
      ON request.id = earlybird_order.result_request_id
    WHERE earlybird_order.paid_at IS NOT NULL
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.target_instagram_id ~ '^[a-z0-9._]{1,30}$'
      AND earlybird_order.plan_id IN ('basic', 'standard')
      AND (
          (earlybird_order.status = 'paid'
           AND fulfillment.status = 'awaiting_operator'
           AND earlybird_order.result_request_id IS NULL)
          OR (
              earlybird_order.status = 'analysis_in_progress'
              AND fulfillment.status = 'analysis_in_progress'
              AND request.id = earlybird_order.result_request_id
              AND request.pipeline_version = 'v2'
              AND request.status = 'failed'
              AND request.current_step = 'failed'
              AND request.error_message IN (
                  'SCRAPING_INCOMPLETE_ERROR',
                  'SCRAPING_PROVIDER_QUOTA_ERROR',
                  'SCRAPING_PROVIDER_START_REJECTED_ERROR'
              )
          )
      )
    FOR UPDATE OF earlybird_order, fulfillment;

    PERFORM request.id
    FROM public.analysis_requests AS request
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.result_request_id = request.id
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    WHERE earlybird_order.paid_at IS NOT NULL
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.status = 'analysis_in_progress'
      AND fulfillment.status = 'analysis_in_progress'
      AND request.pipeline_version = 'v2'
      AND request.status = 'failed'
      AND request.current_step = 'failed'
      AND request.error_message IN (
          'SCRAPING_INCOMPLETE_ERROR',
          'SCRAPING_PROVIDER_QUOTA_ERROR',
          'SCRAPING_PROVIDER_START_REJECTED_ERROR'
      )
    FOR UPDATE OF request;

    SELECT pg_catalog.count(*)
      INTO v_count
    FROM public.earlybird_orders AS earlybird_order
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    LEFT JOIN public.analysis_requests AS request
      ON request.id = earlybird_order.result_request_id
    WHERE earlybird_order.paid_at IS NOT NULL
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.target_instagram_id ~ '^[a-z0-9._]{1,30}$'
      AND earlybird_order.plan_id IN ('basic', 'standard')
      AND (
          (earlybird_order.status = 'paid'
           AND fulfillment.status = 'awaiting_operator'
           AND earlybird_order.result_request_id IS NULL)
          OR (
              earlybird_order.status = 'analysis_in_progress'
              AND fulfillment.status = 'analysis_in_progress'
              AND request.id = earlybird_order.result_request_id
              AND request.pipeline_version = 'v2'
              AND request.status = 'failed'
              AND request.current_step = 'failed'
              AND request.error_message IN (
                  'SCRAPING_INCOMPLETE_ERROR',
                  'SCRAPING_PROVIDER_QUOTA_ERROR',
                  'SCRAPING_PROVIDER_START_REJECTED_ERROR'
              )
          )
      );
    IF v_count <> 30 THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_COHORT_COUNT_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        pg_catalog.string_agg(
            pg_catalog.concat_ws('|',
                earlybird_order.id::TEXT,
                earlybird_order.user_id::TEXT,
                pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id)),
                earlybird_order.plan_id,
                CASE
                    WHEN earlybird_order.status = 'paid' THEN 'awaiting_operator'
                    ELSE 'failed_canary'
                END,
                earlybird_order.preflight_id::TEXT,
                COALESCE(earlybird_order.result_request_id::TEXT, ''),
                earlybird_order.target_followers_count::TEXT,
                earlybird_order.target_following_count::TEXT,
                earlybird_order.status,
                fulfillment.status,
                COALESCE(request.status, ''),
                COALESCE(request.error_message, ''),
                pg_catalog.encode(extensions.digest(pg_catalog.convert_to(earlybird_order.payment_id, 'UTF8'), 'sha256'), 'hex'),
                earlybird_order.expected_amount_krw::TEXT,
                earlybird_order.expected_groble_product_id,
                COALESCE(earlybird_order.actual_amount_krw::TEXT, ''),
                COALESCE(earlybird_order.actual_groble_product_id, ''),
                earlybird_order.paid_at::TEXT
            ), '||' ORDER BY earlybird_order.id
        ), 'UTF8'), 'sha256'), 'hex')
    INTO v_manifest_hash
    FROM public.earlybird_orders AS earlybird_order
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    LEFT JOIN public.analysis_requests AS request
      ON request.id = earlybird_order.result_request_id
    WHERE earlybird_order.paid_at IS NOT NULL
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.target_instagram_id ~ '^[a-z0-9._]{1,30}$'
      AND earlybird_order.plan_id IN ('basic', 'standard')
      AND (
          (earlybird_order.status = 'paid'
           AND fulfillment.status = 'awaiting_operator'
           AND earlybird_order.result_request_id IS NULL)
          OR (
              earlybird_order.status = 'analysis_in_progress'
              AND fulfillment.status = 'analysis_in_progress'
              AND request.id = earlybird_order.result_request_id
              AND request.pipeline_version = 'v2'
              AND request.status = 'failed'
              AND request.current_step = 'failed'
              AND request.error_message IN (
                  'SCRAPING_INCOMPLETE_ERROR',
                  'SCRAPING_PROVIDER_QUOTA_ERROR',
                  'SCRAPING_PROVIDER_START_REJECTED_ERROR'
              )
          )
      );

    IF v_manifest_hash IS DISTINCT FROM p_expected_manifest_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_COHORT_EXPECTED_HASH_CONFLICT', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.earlybird_concierge_batch_cohort_members (
        cohort_key, order_id, owner_id, target_username, plan_id, cohort,
        preflight_id, original_result_request_id, target_followers_count,
        target_following_count, snapshot_order_status, snapshot_fulfillment_status,
        snapshot_request_status, snapshot_error_code, payment_id_fingerprint,
        expected_amount_krw, expected_product_id, actual_amount_krw,
        actual_product_id, paid_at, evidence_hash, manifest_hash, frozen_at
    )
    SELECT v_cohort_key,
        earlybird_order.id,
        earlybird_order.user_id,
        pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id)),
        earlybird_order.plan_id,
        CASE WHEN earlybird_order.status = 'paid' THEN 'awaiting_operator' ELSE 'failed_canary' END,
        earlybird_order.preflight_id,
        earlybird_order.result_request_id,
        earlybird_order.target_followers_count,
        earlybird_order.target_following_count,
        earlybird_order.status,
        fulfillment.status,
        request.status,
        request.error_message,
        pg_catalog.encode(extensions.digest(pg_catalog.convert_to(earlybird_order.payment_id, 'UTF8'), 'sha256'), 'hex'),
        earlybird_order.expected_amount_krw,
        earlybird_order.expected_groble_product_id,
        earlybird_order.actual_amount_krw,
        earlybird_order.actual_groble_product_id,
        earlybird_order.paid_at,
        pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
            pg_catalog.concat_ws('|', earlybird_order.id::TEXT, earlybird_order.user_id::TEXT,
                pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id)),
                earlybird_order.preflight_id::TEXT, earlybird_order.payment_id,
                earlybird_order.paid_at::TEXT), 'UTF8'), 'sha256'), 'hex'),
        v_manifest_hash,
        v_now
    FROM public.earlybird_orders AS earlybird_order
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    LEFT JOIN public.analysis_requests AS request
      ON request.id = earlybird_order.result_request_id
    WHERE earlybird_order.paid_at IS NOT NULL
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.target_instagram_id ~ '^[a-z0-9._]{1,30}$'
      AND earlybird_order.plan_id IN ('basic', 'standard')
      AND (
          (earlybird_order.status = 'paid'
           AND fulfillment.status = 'awaiting_operator'
           AND earlybird_order.result_request_id IS NULL)
          OR (
              earlybird_order.status = 'analysis_in_progress'
              AND fulfillment.status = 'analysis_in_progress'
              AND request.id = earlybird_order.result_request_id
              AND request.pipeline_version = 'v2'
              AND request.status = 'failed'
              AND request.current_step = 'failed'
              AND request.error_message IN (
                  'SCRAPING_INCOMPLETE_ERROR',
                  'SCRAPING_PROVIDER_QUOTA_ERROR',
                  'SCRAPING_PROVIDER_START_REJECTED_ERROR'
              )
          )
      );

    RETURN (
        SELECT pg_catalog.jsonb_build_object(
            'cohortKey', v_cohort_key,
            'manifestHash', v_manifest_hash,
            'members', COALESCE(
                pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                        'orderId', member.order_id,
                        'ownerId', member.owner_id,
                        'targetUsername', member.target_username,
                        'planId', member.plan_id,
                        'cohort', member.cohort,
                        'preflightId', member.preflight_id,
                        'originalResultRequestId', member.original_result_request_id,
                        'targetFollowersCount', member.target_followers_count,
                        'targetFollowingCount', member.target_following_count,
                        'snapshotOrderStatus', member.snapshot_order_status,
                        'snapshotFulfillmentStatus', member.snapshot_fulfillment_status,
                        'snapshotRequestStatus', member.snapshot_request_status,
                        'snapshotErrorCode', member.snapshot_error_code,
                        'paymentIdFingerprint', member.payment_id_fingerprint,
                        'expectedAmountKrw', member.expected_amount_krw,
                        'expectedProductId', member.expected_product_id,
                        'actualAmountKrw', member.actual_amount_krw,
                        'actualProductId', member.actual_product_id,
                        'paidAt', member.paid_at,
                        'evidenceHash', member.evidence_hash,
                        'manifestHash', member.manifest_hash,
                        'frozenAt', member.frozen_at,
                        'currentOrderStatus', earlybird_order.status,
                        'currentFulfillmentStatus', fulfillment.status,
                        'currentRequestStatus', request.status,
                        'published', (
                            earlybird_order.status = 'completed'
                            OR COALESCE(request.step_data#>>'{conciergeBatchPublication,version}', '0') ~ '^[1-9][0-9]*$'
                        )
                    ) ORDER BY member.order_id
                ), '[]'::JSONB
            )
        )
        FROM public.earlybird_concierge_batch_cohort_members AS member
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = member.order_id
        JOIN public.earlybird_fulfillments AS fulfillment
          ON fulfillment.order_id = member.order_id
        LEFT JOIN public.analysis_requests AS request
          ON request.id = earlybird_order.result_request_id
        WHERE member.cohort_key = v_cohort_key
    );
END;
$$;

REVOKE ALL ON FUNCTION public.freeze_concierge_batch_cohort(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.freeze_concierge_batch_cohort(TEXT)
    TO service_role;

CREATE OR REPLACE FUNCTION public.prepare_concierge_batch_order(
    p_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.earlybird_concierge_batch_cohort_members%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
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

    SELECT member.*
      INTO v_manifest
    FROM public.earlybird_concierge_batch_cohort_members AS member
    WHERE member.cohort_key = 'concierge-fallback-20260816'
      AND member.order_id = p_order_id
    FOR UPDATE;

    SELECT earlybird_order.*
      INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;

    SELECT fulfillment.*
      INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;

    IF v_manifest.order_id IS NULL
       OR v_order.id IS NULL
       OR v_fulfillment.order_id IS NULL
       OR v_order.status NOT IN ('paid', 'analysis_in_progress')
       OR v_order.paid_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.user_id IS DISTINCT FROM v_manifest.owner_id
       OR pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
            IS DISTINCT FROM v_manifest.target_username
       OR v_order.plan_id IS DISTINCT FROM v_manifest.plan_id
       OR v_order.preflight_id IS DISTINCT FROM v_manifest.preflight_id
       OR v_order.target_followers_count IS DISTINCT FROM v_manifest.target_followers_count
       OR v_order.target_following_count IS DISTINCT FROM v_manifest.target_following_count
       OR v_order.expected_amount_krw IS DISTINCT FROM v_manifest.expected_amount_krw
       OR v_order.expected_groble_product_id IS DISTINCT FROM v_manifest.expected_product_id
       OR v_order.actual_amount_krw IS DISTINCT FROM v_manifest.actual_amount_krw
       OR v_order.actual_groble_product_id IS DISTINCT FROM v_manifest.actual_product_id
       OR v_order.paid_at IS DISTINCT FROM v_manifest.paid_at
       OR pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_order.payment_id, 'UTF8'), 'sha256'), 'hex')
            IS DISTINCT FROM v_manifest.payment_id_fingerprint
       OR v_fulfillment.status IS DISTINCT FROM v_manifest.snapshot_fulfillment_status
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
            IF COALESCE(v_current.step_data->'conciergeBatchBootstrap'->>'orderId', '')
                    IS DISTINCT FROM p_order_id::TEXT
               OR COALESCE(v_current.step_data->'conciergeBatchBootstrap'->>'preflightId', '')
                    IS DISTINCT FROM v_manifest.preflight_id::TEXT
               OR v_current.status NOT IN ('pending', 'failed') THEN
                RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_REQUEST_CONFLICT', ERRCODE = 'P0001';
            END IF;
            v_source_id := (v_current.step_data->'conciergeBatchBootstrap'->>'sourceRequestId')::UUID;
            RETURN pg_catalog.jsonb_build_object(
                'orderId', p_order_id,
                'sourceRequestId', v_source_id,
                'requestId', v_current.id,
                'ownerId', v_order.user_id,
                'targetUsername', pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)),
                'planId', v_order.plan_id,
                'preflightId', v_order.preflight_id,
                'manifestHash', v_manifest.manifest_hash,
                'evidenceHash', v_manifest.evidence_hash,
                'reused', TRUE
            );
        END IF;
        IF v_manifest.original_result_request_id IS NULL
           OR v_order.result_request_id IS DISTINCT FROM v_manifest.original_result_request_id
           OR v_current.status NOT IN ('failed', 'completed') THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_REQUEST_CONFLICT', ERRCODE = 'P0001';
        END IF;
        v_source := v_current;
        v_source_id := v_current.id;
        v_reused_source := TRUE;
    ELSIF v_manifest.original_result_request_id IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_SCOPE_CONFLICT', ERRCODE = 'P0001';
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
        'manifestHash', v_manifest.manifest_hash,
        'evidenceHash', v_manifest.evidence_hash,
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

COMMIT;
