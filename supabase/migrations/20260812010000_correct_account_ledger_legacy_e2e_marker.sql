-- Corrective fix for the applied account-ledger candidate predicate.
--
-- The legacy synthetic orders have accepted payment.completed evidence, so
-- accepted-event absence cannot distinguish them from external purchases.
-- Their four payment-lineage identifiers carry the approved e2e- marker.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.account_ledger_legacy_e2e_candidate_ids_v1()
RETURNS TABLE(account_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    WITH exact_marker_lineage AS (
        SELECT paid_order.user_id AS account_id,
            paid_order.id AS order_id
        FROM public.earlybird_orders AS paid_order
        JOIN public.earlybird_webhook_events AS webhook_event
          ON webhook_event.order_id = paid_order.id
        WHERE paid_order.payment_id IS NOT NULL
          AND paid_order.payment_id ~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'
          AND paid_order.paid_at IS NOT NULL
          AND paid_order.actual_groble_product_id IS NOT NULL
          AND paid_order.actual_amount_krw > 0
          AND webhook_event.event_type = 'payment.completed'
          AND webhook_event.disposition = 'accepted'
          AND webhook_event.payment_id = paid_order.payment_id
          AND webhook_event.product_id = paid_order.actual_groble_product_id
          AND webhook_event.amount_krw = paid_order.actual_amount_krw
          AND webhook_event.event_id ~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'
          AND webhook_event.idempotency_key ~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'
          AND webhook_event.payment_id ~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'
    ),
    accounts_with_invalid_accepted_lineage AS (
        SELECT paid_order.user_id AS account_id,
            paid_order.id AS order_id
        FROM public.earlybird_orders AS paid_order
        JOIN public.earlybird_webhook_events AS webhook_event
          ON webhook_event.order_id = paid_order.id
        WHERE webhook_event.event_type = 'payment.completed'
          AND webhook_event.disposition = 'accepted'
          AND (
                paid_order.payment_id IS NULL
                OR paid_order.payment_id !~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'
                OR paid_order.paid_at IS NULL
                OR paid_order.actual_groble_product_id IS NULL
                OR paid_order.actual_amount_krw IS NULL
                OR paid_order.actual_amount_krw <= 0
                OR webhook_event.event_id IS NULL
                OR webhook_event.event_id !~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'
                OR webhook_event.idempotency_key IS NULL
                OR webhook_event.idempotency_key
                    !~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'
                OR webhook_event.payment_id IS NULL
                OR webhook_event.payment_id
                    !~ '^e2e-[a-z0-9][a-z0-9_-]{0,63}$'
                OR webhook_event.payment_id
                    IS DISTINCT FROM paid_order.payment_id
                OR webhook_event.product_id
                    IS DISTINCT FROM paid_order.actual_groble_product_id
                OR webhook_event.amount_krw
                    IS DISTINCT FROM paid_order.actual_amount_krw
          )
    )
    SELECT account.id
    FROM public.users AS account
    WHERE account.classification_version IS NULL
      AND NOT EXISTS (
          SELECT 1
          FROM auth.users AS auth_user
          WHERE auth_user.id = account.id
      )
      AND EXISTS (
          SELECT 1
          FROM public.analysis_requests AS analysis_request
          WHERE analysis_request.user_id = account.id
      )
      AND EXISTS (
          SELECT 1
          FROM exact_marker_lineage AS marker_lineage
          WHERE marker_lineage.account_id = account.id
      )
      AND NOT EXISTS (
          SELECT 1
          FROM accounts_with_invalid_accepted_lineage AS invalid_lineage
          WHERE invalid_lineage.account_id = account.id
      )
    ORDER BY account.id
$$;

REVOKE ALL ON FUNCTION public.account_ledger_legacy_e2e_candidate_ids_v1()
    FROM PUBLIC, anon, authenticated, service_role;
