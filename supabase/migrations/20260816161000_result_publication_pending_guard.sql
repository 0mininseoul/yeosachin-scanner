SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- analysis_requests.status is an execution state.  A paid result becomes
-- public only after its order and fulfillment projection agree on the same
-- completed request.  The historic first-order bootstrap is the one explicit
-- exception: its dedicated publisher predates the fulfillment outbox and is
-- already the completed first historical result.
CREATE OR REPLACE FUNCTION public.analysis_result_publication_authorized(
    p_request_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.status = 'completed'
          AND (
              -- Free/legacy requests have no paid order projection.
              NOT EXISTS (
                  SELECT 1
                  FROM public.earlybird_orders AS earlybird_order
                  WHERE earlybird_order.result_request_id = analysis_request.id
                    AND earlybird_order.payment_id IS NOT NULL
              )
              -- The separate first-order publisher is authoritative even
              -- though that historic path has no completed outbox row.
              OR (
                  analysis_request.pipeline_version = 'v1'
                  AND COALESCE(analysis_request.step_data, '{}'::JSONB)
                      ? 'conciergeBootstrap'
                  AND EXISTS (
                      SELECT 1
                      FROM public.earlybird_orders AS earlybird_order
                      WHERE earlybird_order.result_request_id = analysis_request.id
                        AND earlybird_order.payment_id IS NOT NULL
                        AND earlybird_order.status = 'completed'
                  )
                  AND NOT EXISTS (
                      SELECT 1
                      FROM public.earlybird_orders AS earlybird_order
                      WHERE earlybird_order.result_request_id = analysis_request.id
                        AND earlybird_order.payment_id IS NOT NULL
                        AND earlybird_order.status IS DISTINCT FROM 'completed'
                  )
              )
              -- Every paid order must have a completed fulfillment bound to
              -- this request.  This deliberately rejects a partial batch
              -- publication even when the request and order say completed.
              OR NOT EXISTS (
                  SELECT 1
                  FROM public.earlybird_orders AS earlybird_order
                  WHERE earlybird_order.result_request_id = analysis_request.id
                    AND earlybird_order.payment_id IS NOT NULL
                    AND (
                        earlybird_order.status IS DISTINCT FROM 'completed'
                        OR NOT EXISTS (
                            SELECT 1
                            FROM public.earlybird_fulfillments AS fulfillment
                            WHERE fulfillment.order_id = earlybird_order.id
                              AND fulfillment.request_id = analysis_request.id
                              AND fulfillment.status = 'completed'
                              AND fulfillment.completed_at IS NOT NULL
                        )
                    )
              )
          )
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_result_publication_authorized(UUID)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_result_publication_authorized(UUID)
    TO service_role;

-- Preserve the existing owner/auth checks and projection, then downgrade only
-- rows whose completed request is not publication-authorized.  This keeps the
-- archive useful while making a stale request status harmless.
ALTER FUNCTION public.load_analysis_owner_history_v1()
    RENAME TO load_analysis_owner_history_v1_legacy;
REVOKE ALL ON FUNCTION public.load_analysis_owner_history_v1_legacy()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_owner_history_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payload JSONB;
    v_items JSONB;
BEGIN
    v_payload := public.load_analysis_owner_history_v1_legacy();

    SELECT COALESCE(
        pg_catalog.jsonb_agg(
            CASE
                WHEN item.value->>'status' = 'completed'
                     AND NOT public.analysis_result_publication_authorized(
                         (item.value->>'id')::UUID
                     )
                    THEN item.value || pg_catalog.jsonb_build_object(
                        'status', 'pending',
                        'publicFemaleCount', NULL
                    )
                ELSE item.value
            END
            ORDER BY item.ordinality
        ),
        '[]'::JSONB
    )
    INTO v_items
    FROM pg_catalog.jsonb_array_elements(
        COALESCE(v_payload->'items', '[]'::JSONB)
    ) WITH ORDINALITY AS item(value, ordinality);

    RETURN pg_catalog.jsonb_set(v_payload, '{items}', v_items, TRUE);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_owner_history_v1()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_owner_history_v1()
    TO authenticated;

-- The 2026-08-16 batch publisher marked request/order completed before it
-- advanced earlybird_fulfillments.  Restore only that exact paid batch shape;
-- the historic first-order marker, refunded orders, and completed V2 rows do
-- not match this predicate.  No result rows, payment ids, or refund fields
-- are deleted or changed.
WITH incomplete_batch AS (
    SELECT analysis_request.id AS request_id, earlybird_order.id AS order_id
    FROM public.analysis_requests AS analysis_request
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.result_request_id = analysis_request.id
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    WHERE earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.status = 'completed'
      AND earlybird_order.result_request_id IS NOT NULL
      AND analysis_request.pipeline_version = 'v1'
      AND analysis_request.status = 'completed'
      AND COALESCE(analysis_request.idempotency_key, '')
          LIKE 'concierge-batch-result:%'
      AND COALESCE(analysis_request.step_data, '{}'::JSONB)
          ? 'conciergeBatchBootstrap'
      AND fulfillment.status IS DISTINCT FROM 'completed'
)
UPDATE public.analysis_requests AS analysis_request
SET status = 'pending',
    progress = 0,
    progress_step = '분석 대기 중...',
    current_step = 'pending',
    error_message = NULL,
    completed_at = NULL,
    background_processing = FALSE
FROM incomplete_batch
WHERE analysis_request.id = incomplete_batch.request_id;

WITH incomplete_batch AS (
    SELECT earlybird_order.id AS order_id
    FROM public.analysis_requests AS analysis_request
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.result_request_id = analysis_request.id
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    WHERE earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.status = 'completed'
      AND analysis_request.pipeline_version = 'v1'
      AND analysis_request.status = 'pending'
      AND COALESCE(analysis_request.idempotency_key, '')
          LIKE 'concierge-batch-result:%'
      AND COALESCE(analysis_request.step_data, '{}'::JSONB)
          ? 'conciergeBatchBootstrap'
      AND fulfillment.status IS DISTINCT FROM 'completed'
)
UPDATE public.earlybird_orders AS earlybird_order
SET status = 'analysis_in_progress'
FROM incomplete_batch
WHERE earlybird_order.id = incomplete_batch.order_id;

-- Keep the public publisher name stable while repairing its missing outbox
-- transition.  The legacy body still owns all payload/CAS validation; this
-- wrapper locks the order/fill projection first and marks fulfillment complete
-- in the same transaction before the route can expose the result.
ALTER FUNCTION public.publish_concierge_batch_manual_override(
    UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT,
    TEXT, TEXT, JSONB, JSONB, JSONB, JSONB
) RENAME TO publish_concierge_batch_manual_override_legacy;
REVOKE ALL ON FUNCTION public.publish_concierge_batch_manual_override_legacy(
    UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT,
    TEXT, TEXT, JSONB, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.publish_concierge_batch_manual_override(
    p_order_id UUID,
    p_request_id UUID,
    p_owner_id UUID,
    p_target_username TEXT,
    p_target_input_hash TEXT,
    p_source_request_id UUID,
    p_replay_lineage_hash TEXT,
    p_relationship_manifest_hash TEXT,
    p_expected_version INTEGER,
    p_expected_result_hash TEXT,
    p_result_hash TEXT,
    p_result_url TEXT,
    p_interaction_lineage_hash TEXT,
    p_interaction_lineage JSONB,
    p_publication JSONB,
    p_classification_ledger JSONB,
    p_manual_import JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_result JSONB;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    -- Lock in the same order as the legacy publisher (order, then request)
    -- before taking the fulfillment row, avoiding a cross-path lock inversion.
    PERFORM 1
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;

    SELECT fulfillment.*
    INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_fulfillment.status NOT IN (
           'awaiting_operator', 'analysis_in_progress', 'completed'
       )
       OR (
           v_fulfillment.request_id IS NOT NULL
           AND v_fulfillment.request_id IS DISTINCT FROM p_request_id
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_PUBLICATION_FULFILLMENT_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_result := public.publish_concierge_batch_manual_override_legacy(
        p_order_id,
        p_request_id,
        p_owner_id,
        p_target_username,
        p_target_input_hash,
        p_source_request_id,
        p_replay_lineage_hash,
        p_relationship_manifest_hash,
        p_expected_version,
        p_expected_result_hash,
        p_result_hash,
        p_result_url,
        p_interaction_lineage_hash,
        p_interaction_lineage,
        p_publication,
        p_classification_ledger,
        p_manual_import
    );

    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'completed',
        request_id = p_request_id,
        operator_admitted_at = COALESCE(
            fulfillment.operator_admitted_at,
            v_now
        ),
        completed_at = COALESCE(fulfillment.completed_at, v_now),
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        last_error_at = NULL,
        manual_review_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = p_order_id;

    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.publish_concierge_batch_manual_override(
    UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT,
    TEXT, TEXT, JSONB, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_concierge_batch_manual_override(
    UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT,
    TEXT, TEXT, JSONB, JSONB, JSONB, JSONB
) TO service_role;
