BEGIN;

-- Consume only a ready delivery belonging to an already-admitted, signed paid order.
-- The same RPC can be called after a lost response. It never reserves a new fresh generation.
CREATE FUNCTION public.handoff_ready_signed_paid_fulfillment_v1(
    p_preflight_id uuid, p_generation integer, p_dispatch_generation integer, p_dispatch_token uuid
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    purchase record;
    claimed record;
    materialized record;
BEGIN
    SELECT o.id AS order_id, o.status AS order_status, o.result_request_id, f.status AS fulfillment_status,
           f.request_id, f.lease_token, f.lease_expires_at, p.status AS preflight_status, p.consumed_request_id,
           p.admission_refreshed_at, p.expires_at
    INTO purchase
    FROM public.earlybird_orders o
    JOIN public.earlybird_fulfillments f ON f.order_id=o.id
    JOIN public.analysis_preflights p ON p.id=o.preflight_id AND p.user_id=o.user_id
    JOIN public.users u ON u.id=o.user_id
    WHERE p.id=p_preflight_id AND p.access_mode='production'
      AND p.admission_status='ready' AND p.admission_generation=p_generation
      AND p.admission_dispatch_generation=p_dispatch_generation AND p.admission_dispatch_token=p_dispatch_token
      AND p.admission_dispatch_workload_role='paid' AND p.admission_dispatch_contract_version=2
      AND p.admission_entitlement_jti_hash=pg_catalog.encode(extensions.digest(
          'earlybird-fulfillment-admission-v1' || chr(10) || o.id::text,'sha256'),'hex')
      AND p.admission_selected_plan_id=o.plan_id AND o.plan_id IN ('basic','standard')
      AND p.admission_plan_cards_snapshot->o.plan_id->>'selectionState' IN ('required','available_upgrade')
      AND o.status IN ('paid','analysis_in_progress') AND f.status IN ('admission_pending','retryable_failure','analysis_in_progress')
      AND f.operator_admitted_at IS NOT NULL AND f.capacity_queued_at IS NOT NULL AND f.capacity_acquired_at IS NOT NULL
      AND o.paid_at IS NOT NULL AND o.seller_reference_confirmed_at IS NOT NULL
      AND o.actual_amount_krw>0 AND o.actual_amount_krw<=o.expected_amount_krw
      AND o.actual_groble_product_id=o.expected_groble_product_id
      AND u.account_class='production' AND u.traffic_class='external' AND u.lifecycle='active'
      AND EXISTS (SELECT FROM public.earlybird_webhook_events e WHERE e.order_id=o.id AND e.payment_id=o.payment_id
          AND e.event_type='payment.completed' AND e.disposition='accepted' AND e.amount_krw=o.actual_amount_krw)
    FOR UPDATE OF f,o,p NOWAIT FOR SHARE OF u NOWAIT;
    IF NOT FOUND THEN RETURN NULL; END IF;

    -- A response or bootstrap enqueue may have been lost after the prior transaction committed.
    IF purchase.fulfillment_status='analysis_in_progress' AND purchase.order_status='analysis_in_progress'
       AND purchase.preflight_status='consumed' AND purchase.request_id=purchase.result_request_id
       AND purchase.request_id=purchase.consumed_request_id THEN RETURN purchase.request_id; END IF;
    IF purchase.order_status<>'paid' OR purchase.preflight_status<>'ready'
       OR purchase.fulfillment_status NOT IN ('admission_pending','retryable_failure')
       OR purchase.request_id IS NOT NULL OR purchase.result_request_id IS NOT NULL OR purchase.consumed_request_id IS NOT NULL
       OR purchase.expires_at<=clock_timestamp() OR purchase.admission_refreshed_at IS NULL
       OR purchase.admission_refreshed_at<clock_timestamp()-interval '2 minutes' THEN RETURN NULL; END IF;
    IF purchase.lease_token IS NOT NULL AND purchase.lease_expires_at>clock_timestamp() THEN
        RAISE EXCEPTION 'EARLYBIRD_FULFILLMENT_LEASE_BUSY' USING ERRCODE='55P03';
    END IF;
    SELECT * INTO STRICT claimed FROM public.claim_earlybird_fulfillment(purchase.order_id,gen_random_uuid(),300);
    IF NOT claimed.claimed THEN RETURN NULL; END IF;
    SELECT * INTO STRICT materialized FROM public.create_or_replay_earlybird_fulfillment_request(
        purchase.order_id,claimed.lease_token,claimed.lease_fence);
    IF materialized.fulfillment_status='analysis_in_progress' THEN RETURN materialized.request_id; END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.handoff_ready_signed_paid_fulfillment_v1(uuid,integer,integer,uuid)
FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.handoff_ready_signed_paid_fulfillment_v1(uuid,integer,integer,uuid) TO service_role;
COMMIT;
