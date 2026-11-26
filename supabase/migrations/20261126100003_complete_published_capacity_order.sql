BEGIN;

-- The paid worker calls this after finalization has committed. A periodic
-- reconciliation can still complete the order if the worker or network stops.
CREATE FUNCTION public.complete_published_capacity_order_v1(p_request_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='250ms' AS $$
DECLARE
    purchase_id uuid;
    finished_at timestamptz;
BEGIN
    SELECT o.id INTO purchase_id
    FROM public.earlybird_fulfillments f
    JOIN public.earlybird_orders o ON o.id=f.order_id AND o.result_request_id=f.request_id
    JOIN public.analysis_requests r ON r.id=f.request_id AND r.user_id=o.user_id AND r.preflight_id=o.preflight_id
    JOIN public.analysis_preflights p ON p.id=r.preflight_id AND p.user_id=r.user_id
    JOIN public.users u ON u.id=r.user_id
    JOIN public.analysis_v2_result_summaries s ON s.request_id=r.id
    WHERE r.id=p_request_id AND r.status='completed' AND r.pipeline_version='v2' AND r.completed_at IS NOT NULL
      AND r.test_entitlement_jti_hash IS NULL
      AND public.paid_result_target_matches_v1(r.id,r.target_instagram_id,s.target_instagram_id,o.target_instagram_id)
      AND p.access_mode='production' AND p.status='consumed' AND p.consumed_request_id=r.id
      AND u.account_class='production' AND u.traffic_class='external' AND u.lifecycle='active'
      AND f.status='analysis_in_progress' AND f.capacity_first_started_at IS NOT NULL
      AND o.status='analysis_in_progress' AND o.plan_id IN ('basic','standard') AND o.paid_at IS NOT NULL
      AND r.selected_plan_id_snapshot=o.plan_id AND p.admission_selected_plan_id=o.plan_id AND s.plan_id=o.plan_id
      AND o.seller_reference_confirmed_at IS NOT NULL AND o.actual_amount_krw>0
      AND o.actual_amount_krw<=o.expected_amount_krw AND o.actual_groble_product_id=o.expected_groble_product_id
      AND EXISTS (SELECT FROM public.earlybird_webhook_events e WHERE e.order_id=o.id AND e.payment_id=o.payment_id
          AND e.event_type='payment.completed' AND e.disposition='accepted' AND e.amount_krw=o.actual_amount_krw)
    FOR UPDATE OF f,o SKIP LOCKED FOR SHARE OF r,p,u,s SKIP LOCKED;

    IF NOT FOUND THEN RETURN false; END IF;
    finished_at := pg_catalog.clock_timestamp();
    UPDATE public.earlybird_fulfillments SET status='completed',completed_at=finished_at,updated_at=finished_at
        WHERE order_id=purchase_id;
    UPDATE public.earlybird_orders SET status='completed',updated_at=finished_at WHERE id=purchase_id;
    IF NOT public.analysis_result_publication_authorized(p_request_id) THEN
        RAISE EXCEPTION 'PAID_CAPACITY_RESULT_NOT_PUBLISHABLE';
    END IF;
    RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_published_capacity_order_v1(uuid) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.complete_published_capacity_order_v1(uuid) TO service_role;

COMMIT;
