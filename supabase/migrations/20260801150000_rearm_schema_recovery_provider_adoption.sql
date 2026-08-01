-- A provider-adoption recovery can be left in manual review after every
-- source Dataset was reconciled. Reuse the existing schema recovery operator
-- path, but only for that immutable recovery row and its exact stale-ready
-- preflight. The normal paid-preflight rebind remains the only way forward
-- once the row has been rearmed.
--
-- Claim/create take fulfillment -> order, while paid-preflight rebind takes
-- order -> fulfillment. This RPC already owns the order lock before reaching
-- its immutable-recovery FOUND branch, so waiting for fulfillment here could
-- deadlock claim/create. A NOWAIT lock fails the operator call deterministically
-- and releases its order lock instead; retry then observes the canonical state.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.recover_earlybird_schema_failed_fulfillment(uuid)'::pg_catalog.regprocedure
    );

    -- Reapplication is harmless when the complete desired FOUND branch is
    -- already present. Otherwise reject any definition drift before EXECUTE:
    -- the function body is replaced once, only after the exact old branch
    -- matched, so a partial rearm patch cannot be installed.
    IF pg_catalog.strpos(
        v_definition,
        'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_ADOPTION_REARM_INELIGIBLE'
    ) = 0
       OR pg_catalog.strpos(
            v_definition,
            $expected$v_fulfillment.status = 'admission_pending'$expected$
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            $expected$v_fulfillment.last_error_code IS DISTINCT FROM$expected$
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'public.earlybird_provider_run_adoption_ready('
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_BUSY'
       ) = 0
       OR pg_catalog.strpos(
            v_definition,
            'FOR UPDATE NOWAIT'
       ) = 0 THEN
        v_rewritten := pg_catalog.replace(v_definition, $old$
    IF FOUND THEN
        SELECT fulfillment.* INTO v_fulfillment
        FROM public.earlybird_fulfillments AS fulfillment
        WHERE fulfillment.order_id = v_order.id;
        IF NOT FOUND
           OR v_order.preflight_id IS DISTINCT FROM v_recovery.recovery_preflight_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            v_order.id,
            v_fulfillment.status,
            v_recovery.recovery_preflight_id;
        RETURN;
    END IF;
$old$, $new$
    IF FOUND THEN
        BEGIN
            SELECT fulfillment.* INTO v_fulfillment
            FROM public.earlybird_fulfillments AS fulfillment
            WHERE fulfillment.order_id = v_order.id
            FOR UPDATE NOWAIT;
        EXCEPTION
            WHEN lock_not_available THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_BUSY',
                    ERRCODE = 'P0001';
        END;
        IF NOT FOUND
           OR v_order.preflight_id IS DISTINCT FROM v_recovery.recovery_preflight_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_CONFLICT', ERRCODE = 'P0001';
        END IF;

        -- A duplicate operator call after the single transition is a read-only
        -- replay. It intentionally does not refresh timestamps or leases.
        IF v_fulfillment.status = 'admission_pending' THEN
            RETURN QUERY SELECT
                v_order.id,
                v_fulfillment.status,
                v_recovery.recovery_preflight_id;
            RETURN;
        END IF;

        SELECT preflight.* INTO v_preflight
        FROM public.analysis_preflights AS preflight
        WHERE preflight.id = v_recovery.recovery_preflight_id
        FOR UPDATE;
        SELECT analysis_request.* INTO v_failed_request
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = v_recovery.failed_request_id
        FOR UPDATE;

        IF NOT FOUND
           OR v_fulfillment.status <> 'manual_review'
           OR v_fulfillment.request_id IS NOT NULL
           OR v_fulfillment.lease_token IS NOT NULL
           OR v_fulfillment.lease_expires_at IS NOT NULL
           OR v_fulfillment.last_error_code IS DISTINCT FROM
                'PROVIDER_RUN_ADOPTION_REQUIRED'
           OR v_fulfillment.last_error_at IS NULL
           OR v_fulfillment.manual_review_at IS NULL
           OR v_fulfillment.completed_at IS NOT NULL
           OR v_order.status <> 'paid'
           OR v_order.result_request_id IS NOT NULL
           OR v_order.seller_reference_confirmed_at IS NULL
           OR v_order.payment_id IS NULL
           OR v_order.actual_amount_krw IS NULL
           OR v_order.actual_amount_krw < 0
           OR v_order.actual_amount_krw > v_order.expected_amount_krw
           OR v_order.actual_groble_product_id
                IS DISTINCT FROM v_order.expected_groble_product_id
           OR v_order.plan_id NOT IN ('basic', 'standard')
           OR v_preflight.id IS DISTINCT FROM v_order.preflight_id
           OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
           OR v_preflight.access_mode <> 'production'
           OR v_preflight.status <> 'ready'
           OR v_preflight.consumed_request_id IS NOT NULL
           OR v_preflight.idempotency_key IS DISTINCT FROM
                ('earlybird.schema-recovery.'
                 || pg_catalog.replace(v_order.id::TEXT, '-', ''))
           OR v_failed_request.user_id IS DISTINCT FROM v_order.user_id
           OR v_failed_request.pipeline_version <> 'v2'
           OR v_failed_request.status <> 'failed'
           OR (
                pg_catalog.lower(pg_catalog.btrim(v_failed_request.target_instagram_id))
                    IS DISTINCT FROM
                    pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
                AND v_failed_request.target_instagram_id IS DISTINCT FROM (
                    'retained.' || pg_catalog.substr(
                        pg_catalog.replace(v_failed_request.id::TEXT, '-', ''), 1, 20
                    )
                )
           )
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_failure_receipts AS receipt
                WHERE receipt.request_id = v_failed_request.id
                  AND receipt.error_code = v_failed_request.error_message
           )
           OR EXISTS (
                SELECT 1
                FROM public.analysis_requests AS analysis_request
                WHERE analysis_request.user_id = v_order.user_id
                  AND analysis_request.status IN ('pending', 'processing')
           )
           OR EXISTS (
                SELECT 1
                FROM public.analysis_preflights AS preflight
                WHERE preflight.user_id = v_order.user_id
                  AND preflight.status IN ('pending', 'processing', 'ready')
                  AND preflight.id <> v_recovery.recovery_preflight_id
           )
           OR NOT public.earlybird_provider_run_adoption_ready(
                v_order.id,
                v_recovery.failed_request_id,
                v_recovery.recovery_preflight_id
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_ADOPTION_REARM_INELIGIBLE',
                ERRCODE = 'P0001';
        END IF;

        UPDATE public.earlybird_fulfillments AS fulfillment
        SET status = 'admission_pending',
            lease_token = NULL,
            lease_expires_at = NULL,
            next_attempt_at = v_now,
            last_error_code = NULL,
            last_error_at = NULL,
            manual_review_at = NULL,
            completed_at = NULL,
            updated_at = v_now
        WHERE fulfillment.order_id = v_order.id;

        RETURN QUERY SELECT
            v_order.id,
            'admission_pending'::TEXT,
            v_recovery.recovery_preflight_id;
        RETURN;
    END IF;
$new$);
        IF v_rewritten = v_definition
           OR pg_catalog.strpos(
                v_rewritten,
                'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_ADOPTION_REARM_INELIGIBLE'
           ) = 0 THEN
            RAISE EXCEPTION 'EARLYBIRD_SCHEMA_RECOVERY_ADOPTION_REARM_PATCH_MISMATCH';
        END IF;
        EXECUTE v_rewritten;
    END IF;
END;
$migration$;

REVOKE ALL ON FUNCTION public.recover_earlybird_schema_failed_fulfillment(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_earlybird_schema_failed_fulfillment(UUID)
    TO service_role;
