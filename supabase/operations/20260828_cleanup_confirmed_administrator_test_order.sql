-- Explicit production operation. Invoke this file only after the schema
-- migration has been dry-run and applied; it is intentionally outside the
-- universal migration set. Run it with psql ON_ERROR_STOP enabled.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL search_path = pg_catalog, public, auth;

CREATE TEMP TABLE IF NOT EXISTS pg_temp.earlybird_admin_cleanup_receipt (
    operation TEXT NOT NULL,
    deleted_count INTEGER NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE NOT NULL
) ON COMMIT PRESERVE ROWS;
TRUNCATE TABLE pg_temp.earlybird_admin_cleanup_receipt;

DO $$
DECLARE
    v_operation_key CONSTANT TEXT :=
        'operation:production:earlybird-admin-test-order-cleanup:v1';
    v_target_fingerprint CONSTANT TEXT :=
        'ca805b0332bcbf8a263c4ffcfa7bd792226f555d8f2d37f928b30544912b6a52';
    v_admin_id UUID;
    v_admin_count INTEGER;
    v_candidate_count INTEGER;
    v_product_id TEXT;
    v_product_max TEXT;
    v_recheck_product_id TEXT;
    v_recheck_product_max TEXT;
    v_order_id UUID;
    v_deleted_count INTEGER;
BEGIN
    -- Serialize this named operation before resolving any mutable target.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'operation:production:earlybird-admin-test-order-cleanup:v1',
            0
        )
    );

    SELECT pg_catalog.count(*)::INTEGER
    INTO v_admin_count
    FROM auth.users AS auth_user
    JOIN public.users AS app_user
      ON app_user.id = auth_user.id
    WHERE pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = 'ym1113@kakao.com'
      AND pg_catalog.lower(pg_catalog.btrim(app_user.email)) = 'ym1113@kakao.com';

    IF v_admin_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_ADMIN_PRECONDITION_FAILED',
            ERRCODE = 'P0001';
    END IF;

    SELECT auth_user.id
    INTO v_admin_id
    FROM auth.users AS auth_user
    JOIN public.users AS app_user
      ON app_user.id = auth_user.id
    WHERE pg_catalog.lower(pg_catalog.btrim(auth_user.email)) = 'ym1113@kakao.com'
      AND pg_catalog.lower(pg_catalog.btrim(app_user.email)) = 'ym1113@kakao.com';

    -- Resolve the single bounded product identifier from the exact candidate
    -- shape before taking the canonical product lock. No product identifier
    -- is hardcoded in this operation.
    SELECT
        pg_catalog.count(*)::INTEGER,
        pg_catalog.min(earlybird_order.expected_groble_product_id),
        pg_catalog.max(earlybird_order.expected_groble_product_id)
    INTO v_candidate_count, v_product_id, v_product_max
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.user_id = v_admin_id
      AND pg_catalog.lower(earlybird_order.target_instagram_id) = '0_min._.00'
      AND earlybird_order.plan_id = 'standard'
      AND earlybird_order.status = 'payment_pending'
      AND earlybird_order.expected_groble_product_id IS NOT NULL
      AND earlybird_order.payment_id IS NULL
      AND earlybird_order.paid_at IS NULL
      AND earlybird_order.actual_groble_product_id IS NULL
      AND earlybird_order.actual_amount_krw IS NULL
      AND earlybird_order.seller_reference_confirmed_at IS NULL
      AND earlybird_order.id IS NOT NULL
      AND earlybird_order.groble_seller_reference IS NOT NULL
      AND earlybird_order.created_at IS NOT NULL
      AND pg_catalog.encode(
          extensions.digest(
              pg_catalog.convert_to(
                  'earlybird-admin-cleanup:v1|'
                  || earlybird_order.id::TEXT
                  || '|'
                  || earlybird_order.groble_seller_reference
                  || '|'
                  || pg_catalog.to_char(
                      earlybird_order.created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                  ),
                  'UTF8'
              ),
              'sha256'
          ),
          'hex'
      ) = v_target_fingerprint
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_fulfillments AS fulfillment
          WHERE fulfillment.order_id = earlybird_order.id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_requests AS analysis_request
          WHERE analysis_request.id = earlybird_order.result_request_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS webhook_event
          WHERE webhook_event.order_id = earlybird_order.id
      );

    IF v_candidate_count <> 1
       OR v_product_id IS NULL
       OR v_product_id IS DISTINCT FROM v_product_max
       OR v_product_id !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_ORDER_PRECONDITION_FAILED',
            ERRCODE = 'P0001';
    END IF;

    -- Canonical lock order: product advisory -> raw user advisory -> public
    -- users row -> exact order row. Keep this order aligned with checkout.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'earlybird:groble:product:' || v_product_id,
            0
        )
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_admin_id::TEXT, 0)
    );
    PERFORM 1
    FROM public.users AS app_user
    WHERE app_user.id = v_admin_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_USER_LOCK_FAILED',
            ERRCODE = 'P0001';
    END IF;

    -- Re-resolve and lock every exact candidate after all waits. The CTE
    -- locks every match before counting, so an unexpected second row fails
    -- closed instead of allowing an arbitrary delete.
    WITH candidate_rows AS MATERIALIZED (
        SELECT earlybird_order.id, earlybird_order.expected_groble_product_id
        FROM public.earlybird_orders AS earlybird_order
        WHERE earlybird_order.user_id = v_admin_id
          AND pg_catalog.lower(earlybird_order.target_instagram_id) = '0_min._.00'
          AND earlybird_order.plan_id = 'standard'
          AND earlybird_order.expected_groble_product_id IS NOT NULL
          AND earlybird_order.status = 'payment_pending'
          AND earlybird_order.payment_id IS NULL
          AND earlybird_order.paid_at IS NULL
          AND earlybird_order.actual_groble_product_id IS NULL
          AND earlybird_order.actual_amount_krw IS NULL
          AND earlybird_order.seller_reference_confirmed_at IS NULL
          AND earlybird_order.id IS NOT NULL
          AND earlybird_order.groble_seller_reference IS NOT NULL
          AND earlybird_order.created_at IS NOT NULL
          AND pg_catalog.encode(
              extensions.digest(
                  pg_catalog.convert_to(
                      'earlybird-admin-cleanup:v1|'
                      || earlybird_order.id::TEXT
                      || '|'
                      || earlybird_order.groble_seller_reference
                      || '|'
                      || pg_catalog.to_char(
                          earlybird_order.created_at AT TIME ZONE 'UTC',
                          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                      ),
                      'UTF8'
                  ),
                  'sha256'
              ),
              'hex'
          ) = v_target_fingerprint
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_fulfillments AS fulfillment
              WHERE fulfillment.order_id = earlybird_order.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_requests AS analysis_request
              WHERE analysis_request.id = earlybird_order.result_request_id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_webhook_events AS webhook_event
              WHERE webhook_event.order_id = earlybird_order.id
          )
        FOR UPDATE
    )
    SELECT
        pg_catalog.count(*)::INTEGER,
        pg_catalog.min(id::TEXT)::UUID,
        pg_catalog.min(expected_groble_product_id),
        pg_catalog.max(expected_groble_product_id)
    INTO v_candidate_count, v_order_id, v_recheck_product_id, v_recheck_product_max
    FROM candidate_rows;

    IF v_candidate_count <> 1
       OR v_recheck_product_id IS DISTINCT FROM v_product_id
       OR v_recheck_product_id IS DISTINCT FROM v_recheck_product_max THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_ORDER_LOCK_FAILED',
            ERRCODE = 'P0001';
    END IF;

    -- Recheck every payment/provider/seller-confirmation/fulfillment/result/
    -- webhook predicate while the exact order lock is held.
    SELECT pg_catalog.count(*)::INTEGER
    INTO v_candidate_count
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_order_id
      AND earlybird_order.user_id = v_admin_id
      AND pg_catalog.lower(earlybird_order.target_instagram_id) = '0_min._.00'
      AND earlybird_order.plan_id = 'standard'
      AND earlybird_order.expected_groble_product_id = v_product_id
      AND earlybird_order.status = 'payment_pending'
      AND earlybird_order.payment_id IS NULL
      AND earlybird_order.paid_at IS NULL
      AND earlybird_order.actual_groble_product_id IS NULL
      AND earlybird_order.actual_amount_krw IS NULL
      AND earlybird_order.seller_reference_confirmed_at IS NULL
      AND earlybird_order.id IS NOT NULL
      AND earlybird_order.groble_seller_reference IS NOT NULL
      AND earlybird_order.created_at IS NOT NULL
      AND pg_catalog.encode(
          extensions.digest(
              pg_catalog.convert_to(
                  'earlybird-admin-cleanup:v1|'
                  || earlybird_order.id::TEXT
                  || '|'
                  || earlybird_order.groble_seller_reference
                  || '|'
                  || pg_catalog.to_char(
                      earlybird_order.created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                  ),
                  'UTF8'
              ),
              'sha256'
          ),
          'hex'
      ) = v_target_fingerprint
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_fulfillments AS fulfillment
          WHERE fulfillment.order_id = earlybird_order.id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_requests AS analysis_request
          WHERE analysis_request.id = earlybird_order.result_request_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS webhook_event
          WHERE webhook_event.order_id = earlybird_order.id
      );
    IF v_candidate_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_RECHECK_FAILED',
            ERRCODE = 'P0001';
    END IF;

    DELETE FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_order_id
      AND earlybird_order.user_id = v_admin_id
      AND pg_catalog.lower(earlybird_order.target_instagram_id) = '0_min._.00'
      AND earlybird_order.plan_id = 'standard'
      AND earlybird_order.expected_groble_product_id = v_product_id
      AND earlybird_order.status = 'payment_pending'
      AND earlybird_order.payment_id IS NULL
      AND earlybird_order.paid_at IS NULL
      AND earlybird_order.actual_groble_product_id IS NULL
      AND earlybird_order.actual_amount_krw IS NULL
      AND earlybird_order.seller_reference_confirmed_at IS NULL
      AND earlybird_order.id IS NOT NULL
      AND earlybird_order.groble_seller_reference IS NOT NULL
      AND earlybird_order.created_at IS NOT NULL
      AND pg_catalog.encode(
          extensions.digest(
              pg_catalog.convert_to(
                  'earlybird-admin-cleanup:v1|'
                  || earlybird_order.id::TEXT
                  || '|'
                  || earlybird_order.groble_seller_reference
                  || '|'
                  || pg_catalog.to_char(
                      earlybird_order.created_at AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
                  ),
                  'UTF8'
              ),
              'sha256'
          ),
          'hex'
      ) = v_target_fingerprint
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_fulfillments AS fulfillment
          WHERE fulfillment.order_id = earlybird_order.id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_requests AS analysis_request
          WHERE analysis_request.id = earlybird_order.result_request_id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS webhook_event
          WHERE webhook_event.order_id = earlybird_order.id
      )
    RETURNING id INTO v_order_id;

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    IF v_deleted_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_ADMIN_TEST_CLEANUP_DELETE_PRECONDITION_FAILED',
            ERRCODE = 'P0001';
    END IF;

    INSERT INTO pg_temp.earlybird_admin_cleanup_receipt(
        operation,
        deleted_count,
        completed_at
    ) VALUES (
        v_operation_key,
        v_deleted_count,
        pg_catalog.clock_timestamp()
    );
END;
$$;

COMMIT;

SELECT operation, deleted_count, completed_at
FROM pg_temp.earlybird_admin_cleanup_receipt;

DROP TABLE pg_temp.earlybird_admin_cleanup_receipt;
