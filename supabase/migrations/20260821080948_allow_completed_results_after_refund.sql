SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Commercial refund state does not erase a result that was already completed
-- and delivered. Fulfillment remains the authority for whether paid result
-- work finished, while the order status continues to preserve financial truth.
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
          AND NOT (
              COALESCE(analysis_request.step_data, '{}'::JSONB)
                  ? 'conciergeBatchSource'
              OR COALESCE(analysis_request.idempotency_key, '')
                  LIKE 'concierge-batch-source:%'
          )
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
              -- A commercial refund transition is compatible with a result
              -- that the request-bound fulfillment already completed. Other
              -- payment and cancellation states remain fail-closed.
              OR NOT EXISTS (
                  SELECT 1
                  FROM public.earlybird_orders AS earlybird_order
                  WHERE earlybird_order.result_request_id = analysis_request.id
                    AND earlybird_order.payment_id IS NOT NULL
                    AND (
                        earlybird_order.status NOT IN (
                            'completed',
                            'refund_pending',
                            'refunded'
                        )
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
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_result_publication_authorized(UUID)
    TO service_role;
