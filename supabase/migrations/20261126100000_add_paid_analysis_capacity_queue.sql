BEGIN;

-- Enable only after the matching load test and the worker/web deployment.
-- NULL is the pre-rollout behavior. Changing N never revokes a running job.
CREATE TABLE public.paid_analysis_capacity_policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    max_active integer CHECK (max_active > 0),
    validation_ref text CHECK (length(trim(validation_ref)) BETWEEN 1 AND 256),
    expected_basic_max_minutes integer CHECK (expected_basic_max_minutes > 0),
    expected_standard_max_minutes integer CHECK (expected_standard_max_minutes > 0),
    CHECK (max_active IS NULL OR validation_ref IS NOT NULL)
);
ALTER TABLE public.paid_analysis_capacity_policy ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_analysis_capacity_policy FROM PUBLIC, anon, authenticated, service_role;
INSERT INTO public.paid_analysis_capacity_policy DEFAULT VALUES;

ALTER TABLE public.earlybird_fulfillments
    ADD COLUMN capacity_queued_at timestamptz,
    ADD COLUMN capacity_acquired_at timestamptz,
    ADD COLUMN capacity_waited boolean NOT NULL DEFAULT false,
    ADD COLUMN capacity_first_started_at timestamptz,
    ADD COLUMN capacity_expected_minutes integer;

CREATE INDEX earlybird_fulfillment_capacity_fifo
ON public.earlybird_fulfillments(capacity_queued_at, order_id)
WHERE capacity_queued_at IS NOT NULL AND capacity_acquired_at IS NULL
  AND status IN ('awaiting_operator', 'admission_pending', 'retryable_failure');

-- Old in-flight orders have no queue marker and retain their existing admission.
-- A terminal/manual order re-armed by the existing recovery authority must queue again.
CREATE FUNCTION public.register_paid_analysis_capacity_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.status IN ('admission_pending', 'retryable_failure')
       AND (TG_OP = 'INSERT' OR OLD.status IN ('awaiting_operator', 'manual_review', 'completed'))
       AND EXISTS (SELECT FROM public.paid_analysis_capacity_policy WHERE max_active IS NOT NULL) THEN
        SELECT COALESCE(o.paid_at, NEW.operator_admitted_at) INTO NEW.capacity_queued_at
        FROM public.earlybird_orders o
        WHERE o.id = NEW.order_id AND o.status = 'paid' AND o.plan_id IN ('basic', 'standard');
        NEW.capacity_acquired_at := NULL;
        NEW.capacity_waited := COALESCE(NEW.capacity_waited, false) OR NOT public.paid_analysis_capacity_has_room_v1(
            NEW.order_id,NEW.capacity_queued_at,(SELECT max_active FROM public.paid_analysis_capacity_policy WHERE singleton)
        );
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER register_paid_analysis_capacity
BEFORE INSERT OR UPDATE OF status ON public.earlybird_fulfillments
FOR EACH ROW EXECUTE FUNCTION public.register_paid_analysis_capacity_v1();

CREATE FUNCTION public.paid_analysis_capacity_available_v1(p_limit integer) RETURNS integer
LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT greatest(0, p_limit - count(*)::integer)
    FROM public.earlybird_fulfillments f
    JOIN public.earlybird_orders o ON o.id = f.order_id
    LEFT JOIN public.analysis_requests r ON r.id = f.request_id
    WHERE o.plan_id IN ('basic', 'standard') AND (
        r.status IN ('pending', 'processing')
        OR (f.lease_token IS NOT NULL AND f.lease_expires_at > pg_catalog.statement_timestamp())
        OR (o.status <> 'paid' AND EXISTS (
            SELECT FROM public.analysis_preflights preflight
            WHERE preflight.id = o.preflight_id AND preflight.admission_status IN ('pending','processing')
              AND preflight.admission_entitlement_jti_hash = pg_catalog.encode(extensions.digest(
                  'earlybird-fulfillment-admission-v1' || chr(10) || o.id::text, 'sha256'), 'hex')
        ))
        OR (o.status = 'paid' AND f.status IN ('admission_pending', 'retryable_failure')
            AND (f.capacity_queued_at IS NULL OR f.capacity_acquired_at IS NOT NULL))
    );
$$;

CREATE FUNCTION public.paid_analysis_capacity_has_room_v1(p_order_id uuid, p_queued_at timestamptz, p_limit integer)
RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
    WITH available AS MATERIALIZED (SELECT public.paid_analysis_capacity_available_v1(p_limit) AS slots)
    SELECT slots > 0 AND NOT EXISTS (
        SELECT FROM public.earlybird_fulfillments f JOIN public.earlybird_orders o ON o.id = f.order_id
        WHERE f.status IN ('awaiting_operator','admission_pending','retryable_failure') AND o.status = 'paid'
          AND f.capacity_acquired_at IS NULL AND f.next_attempt_at <= pg_catalog.clock_timestamp()
          AND (f.capacity_queued_at, f.order_id) < (p_queued_at, p_order_id)
        OFFSET greatest(0, slots - 1)
    ) FROM available;
$$;

-- Only the verified webhook chooses this RPC after its existing signed-time
-- eligibility check. Both payment matchers keep their original arguments and result.
CREATE FUNCTION public.finalize_automatic_paid_analysis_v1(
    p_event_id text, p_idempotency_key text, p_event_type text, p_occurred_at timestamptz, p_payment_id text,
    p_buyer_email text, p_buyer_phone_normalized text, p_buyer_phone_raw text, p_buyer_display_name text,
    p_product_id text, p_amount_krw integer, p_paid_at timestamptz, p_seller_reference text
) RETURNS TABLE(disposition text, order_id uuid, status text, plan_sequence smallint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    payment record;
    v_limit integer;
BEGIN
    IF p_seller_reference IS NULL THEN
        SELECT * INTO STRICT payment FROM public.finalize_earlybird_groble_payment(p_event_id,p_idempotency_key,
            p_event_type,p_occurred_at,p_payment_id,p_buyer_email,p_buyer_phone_normalized,p_buyer_phone_raw,
            p_buyer_display_name,p_product_id,p_amount_krw,p_paid_at);
    ELSE
        SELECT * INTO STRICT payment FROM public.finalize_earlybird_groble_payment_by_reference(p_seller_reference,
            p_event_id,p_idempotency_key,p_event_type,p_occurred_at,p_payment_id,p_buyer_email,p_buyer_phone_normalized,
            p_buyer_phone_raw,p_buyer_display_name,p_product_id,p_amount_krw,p_paid_at);
    END IF;
    SELECT max_active INTO STRICT v_limit FROM public.paid_analysis_capacity_policy WHERE singleton;
    IF v_limit IS NOT NULL AND payment.status = 'paid'
       AND payment.disposition IN ('accepted','duplicate_event','duplicate_payment') THEN
        UPDATE public.earlybird_fulfillments f SET capacity_queued_at = o.paid_at,
            capacity_waited = NOT public.paid_analysis_capacity_has_room_v1(o.id,o.paid_at,v_limit)
        FROM public.earlybird_orders o
        WHERE o.id=payment.order_id AND f.order_id=o.id AND f.status='awaiting_operator'
          AND f.capacity_queued_at IS NULL AND o.status='paid' AND o.paid_at IS NOT NULL;
    END IF;
    RETURN QUERY SELECT payment.disposition,payment.order_id,payment.status,payment.plan_sequence;
END;
$$;

-- Only signed, already-finalized, queue-registered purchases can be recovered
-- here, even when the historical all-orders auto-admission sweep is disabled.
CREATE FUNCTION public.list_signed_paid_analysis_admissions_v1(p_limit integer) RETURNS TABLE(order_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT f.order_id FROM public.earlybird_fulfillments f JOIN public.earlybird_orders o ON o.id=f.order_id
    WHERE f.status='awaiting_operator' AND f.capacity_queued_at IS NOT NULL AND o.status='paid'
      AND f.next_attempt_at <= pg_catalog.now()
    ORDER BY f.capacity_queued_at,f.order_id LIMIT least(greatest(1,p_limit),100);
$$;
CREATE FUNCTION public.recover_signed_paid_analysis_admission_v1(p_order_id uuid, p_defer boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NOT EXISTS (SELECT FROM public.earlybird_fulfillments f JOIN public.earlybird_orders o ON o.id=f.order_id
        WHERE f.order_id=p_order_id AND f.status='awaiting_operator' AND f.capacity_queued_at IS NOT NULL AND o.status='paid')
    THEN RETURN; END IF;
    IF p_defer THEN
        UPDATE public.earlybird_fulfillments SET next_attempt_at=pg_catalog.clock_timestamp()+interval '30 seconds'
        WHERE order_id=p_order_id AND status='awaiting_operator';
        RETURN;
    END IF;
    PERFORM public.bind_earlybird_order_scoped_apify_slot(p_order_id,'secondary');
    PERFORM public.rebind_expired_paid_earlybird_preflight(p_order_id);
    IF EXISTS (SELECT FROM public.earlybird_fulfillments WHERE order_id=p_order_id AND status='awaiting_operator') THEN
        PERFORM public.admit_earlybird_fulfillment(p_order_id);
    END IF;
END;
$$;

-- This transaction only locks the policy row and the caller's fulfillment.
-- Repeated delivery of the same paid order sees its original grant.
CREATE FUNCTION public.claim_paid_analysis_capacity_v1(p_order_id uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_policy public.paid_analysis_capacity_policy%ROWTYPE;
    v_expected_minutes integer;
    v_queue timestamptz;
    v_acquired timestamptz;
    v_now timestamptz;
BEGIN
    IF NOT EXISTS (SELECT FROM public.paid_analysis_capacity_policy WHERE max_active IS NOT NULL)
       AND NOT EXISTS (SELECT FROM public.earlybird_fulfillments WHERE order_id = p_order_id AND capacity_queued_at IS NOT NULL)
    THEN RETURN 'ready'; END IF;
    SELECT * INTO STRICT v_policy FROM public.paid_analysis_capacity_policy WHERE singleton FOR UPDATE;
    SELECT CASE o.plan_id WHEN 'basic' THEN v_policy.expected_basic_max_minutes
        WHEN 'standard' THEN v_policy.expected_standard_max_minutes END INTO v_expected_minutes
    FROM public.earlybird_orders o WHERE o.id = p_order_id AND o.status = 'paid'
        AND o.plan_id IN ('basic','standard') FOR SHARE NOWAIT;
    IF NOT FOUND THEN RETURN 'ineligible'; END IF;
    SELECT f.capacity_queued_at, f.capacity_acquired_at INTO v_queue, v_acquired
    FROM public.earlybird_fulfillments f
    WHERE f.order_id = p_order_id AND f.status IN ('admission_pending','retryable_failure')
      AND f.operator_admitted_at IS NOT NULL FOR UPDATE NOWAIT;
    IF NOT FOUND THEN RETURN 'ineligible'; END IF;
    IF v_queue IS NULL OR v_acquired IS NOT NULL THEN RETURN 'ready'; END IF;

    IF v_policy.max_active IS NOT NULL AND NOT public.paid_analysis_capacity_has_room_v1(
        p_order_id, v_queue, v_policy.max_active
    ) THEN
        UPDATE public.earlybird_fulfillments SET capacity_waited=true WHERE order_id=p_order_id AND NOT capacity_waited;
        RETURN 'waiting';
    END IF;
    v_now := pg_catalog.clock_timestamp();
    UPDATE public.earlybird_fulfillments SET capacity_acquired_at = v_now,
        capacity_expected_minutes = CASE WHEN capacity_first_started_at IS NOT NULL THEN capacity_expected_minutes
            WHEN v_policy.max_active IS NOT NULL THEN v_expected_minutes END,
        capacity_first_started_at = COALESCE(capacity_first_started_at, v_now)
    WHERE order_id = p_order_id;
    RETURN 'ready';
EXCEPTION WHEN lock_not_available THEN RETURN 'retry';
END;
$$;

-- Fence older worker revisions too. Block the paid lineage before the original
-- reservation can emit a dispatch token or obtain the fulfillment lease.
CREATE FUNCTION public.fence_waiting_paid_analysis_v1() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_TABLE_NAME = 'earlybird_fulfillments' THEN
        IF NEW.capacity_queued_at IS NOT NULL AND NEW.capacity_acquired_at IS NULL
           AND NEW.lease_token IS NOT NULL THEN
            RAISE EXCEPTION 'EARLYBIRD_ANALYSIS_CAPACITY_WAITING';
        END IF;
    ELSIF NEW.admission_entitlement_jti_hash IS NOT NULL AND EXISTS (
        SELECT FROM public.earlybird_fulfillments f JOIN public.earlybird_orders o ON o.id = f.order_id
        WHERE o.preflight_id = NEW.id AND o.user_id = NEW.user_id AND f.capacity_queued_at IS NOT NULL
          AND f.capacity_acquired_at IS NULL AND f.status IN ('admission_pending','retryable_failure')
          AND NEW.admission_entitlement_jti_hash = pg_catalog.encode(
              extensions.digest('earlybird-fulfillment-admission-v1' || chr(10) || o.id::text, 'sha256'), 'hex')
    ) THEN
        RAISE EXCEPTION 'EARLYBIRD_ANALYSIS_CAPACITY_WAITING';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER fence_waiting_paid_analysis_lease BEFORE UPDATE OF lease_token ON public.earlybird_fulfillments
FOR EACH ROW EXECUTE FUNCTION public.fence_waiting_paid_analysis_v1();
CREATE TRIGGER fence_waiting_paid_preflight BEFORE UPDATE OF admission_generation, admission_dispatch_generation
ON public.analysis_preflights FOR EACH ROW EXECUTE FUNCTION public.fence_waiting_paid_analysis_v1();

-- With room available the sweep promotes the oldest due payments first.
-- Saturated queues do not crowd out in-flight or pre-rollout recovery work.
CREATE OR REPLACE FUNCTION public.list_recoverable_earlybird_fulfillments(p_limit integer DEFAULT 20)
RETURNS TABLE(order_id uuid, fulfillment_status text, preflight_id uuid, user_id uuid, plan_id text, request_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN
        RAISE EXCEPTION 'EARLYBIRD_FULFILLMENT_INVALID';
    END IF;
    RETURN QUERY
    WITH candidates AS (
        SELECT f.order_id, f.status, o.preflight_id, o.user_id, o.plan_id, f.request_id,
            f.capacity_queued_at, f.next_attempt_at, f.created_at,
            f.capacity_queued_at IS NOT NULL AND f.capacity_acquired_at IS NULL AS waiting
        FROM public.earlybird_fulfillments f JOIN public.earlybird_orders o ON o.id = f.order_id
        WHERE f.status IN ('admission_pending','retryable_failure') AND f.operator_admitted_at IS NOT NULL
          AND f.next_attempt_at <= pg_catalog.clock_timestamp()
          AND (f.lease_token IS NULL OR f.lease_expires_at <= pg_catalog.clock_timestamp())
          AND (f.capacity_queued_at IS NULL OR o.status = 'paid')
    ), ranked AS (
        SELECT c.*, row_number() OVER (PARTITION BY c.waiting ORDER BY c.capacity_queued_at, c.order_id) AS position
        FROM candidates c
    ), remaining AS MATERIALIZED (
        SELECT CASE WHEN max_active IS NOT NULL THEN public.paid_analysis_capacity_available_v1(max_active) END AS slots
        FROM public.paid_analysis_capacity_policy WHERE singleton
    )
    SELECT c.order_id,c.status,c.preflight_id,c.user_id,c.plan_id,c.request_id FROM ranked c CROSS JOIN remaining
    WHERE NOT c.waiting OR slots IS NULL OR c.position <= slots
    ORDER BY c.waiting DESC, CASE WHEN c.waiting THEN c.position END, c.next_attempt_at, c.created_at
    LIMIT p_limit;
END;
$$;

CREATE FUNCTION public.load_paid_analysis_capacity_v1(p_order_id uuid, p_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT jsonb_build_object(
        'waiting', o.status = 'paid' AND f.status IN ('awaiting_operator','admission_pending','retryable_failure')
            AND f.capacity_acquired_at IS NULL AND p.max_active IS NOT NULL
            AND (f.capacity_waited OR NOT public.paid_analysis_capacity_has_room_v1(f.order_id, f.capacity_queued_at, p.max_active)),
        'startedAt', f.capacity_first_started_at, 'expectedMaxMinutes', f.capacity_expected_minutes
    ) FROM public.earlybird_fulfillments f JOIN public.earlybird_orders o ON o.id = f.order_id
    JOIN public.paid_analysis_capacity_policy p ON p.singleton
    WHERE o.id = p_order_id AND o.user_id = p_user_id AND f.capacity_queued_at IS NOT NULL;
$$;
CREATE FUNCTION public.load_paid_analysis_capacity_by_request_v1(p_request_id uuid, p_user_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT public.load_paid_analysis_capacity_v1(f.order_id, p_user_id)
    FROM public.earlybird_fulfillments f JOIN public.analysis_requests r ON r.id = f.request_id
    WHERE r.id = p_request_id AND r.user_id = p_user_id;
$$;

REVOKE ALL ON FUNCTION public.finalize_automatic_paid_analysis_v1(text,text,text,timestamptz,text,text,text,text,text,text,integer,timestamptz,text), public.list_signed_paid_analysis_admissions_v1(integer), public.recover_signed_paid_analysis_admission_v1(uuid,boolean),
    public.register_paid_analysis_capacity_v1(), public.paid_analysis_capacity_available_v1(integer),
    public.paid_analysis_capacity_has_room_v1(uuid,timestamptz,integer), public.fence_waiting_paid_analysis_v1(), public.claim_paid_analysis_capacity_v1(uuid),
    public.load_paid_analysis_capacity_v1(uuid,uuid), public.load_paid_analysis_capacity_by_request_v1(uuid,uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_automatic_paid_analysis_v1(text,text,text,timestamptz,text,text,text,text,text,text,integer,timestamptz,text), public.list_signed_paid_analysis_admissions_v1(integer), public.recover_signed_paid_analysis_admission_v1(uuid,boolean),
    public.claim_paid_analysis_capacity_v1(uuid),
    public.load_paid_analysis_capacity_v1(uuid,uuid), public.load_paid_analysis_capacity_by_request_v1(uuid,uuid)
    TO service_role;

-- Apply only to the source-verified terminal generation-cap branch, under its
-- existing user/order/fulfillment/preflight locks. Timeouts do not enter it.
DO $migration$
DECLARE
    fn regprocedure := 'public.rebind_expired_paid_earlybird_preflight(uuid)'::regprocedure;
    marker text := 'IF v_generation >= c_max_generations THEN';
    body text := pg_get_functiondef(fn);
BEGIN
    IF (SELECT encode(sha256(convert_to(prosrc,'UTF8')),'hex') FROM pg_proc WHERE oid=fn)
        <> 'ea93a53b69f5dd74772dfd0642869f2e943c121e39d58431239d9d146c8e6d0d'
    THEN RAISE EXCEPTION 'PAID_CAPACITY_REBIND_DEFINITION_CHANGED'; END IF;
    EXECUTE replace(body, marker, marker || $guard$
        IF v_fulfillment.capacity_queued_at IS NOT NULL AND v_fulfillment.request_id IS NULL
           AND v_order.result_request_id IS NULL AND v_preflight.consumed_request_id IS NULL
           AND (v_fulfillment.lease_token IS NULL OR v_fulfillment.lease_expires_at <= v_now)
           AND v_preflight.admission_status IN ('idle','ready','blocked')
           AND v_preflight.admission_claim_token IS NULL AND v_preflight.admission_dispatch_state <> 'reserved'
           AND NOT EXISTS (SELECT FROM public.analysis_preflight_provider_runs run
               WHERE run.preflight_id=v_preflight.id AND (run.actual_usage_usd IS NULL OR run.usage_reconciled_at IS NULL)) THEN
            UPDATE public.earlybird_fulfillments SET status='manual_review', manual_review_at=v_now,
                operator_admitted_at=coalesce(operator_admitted_at,v_now),
                last_error_code='PAID_PREFLIGHT_REBIND_EXHAUSTED', last_error_at=v_now,
                lease_token=NULL,lease_expires_at=NULL WHERE order_id=p_order_id;
        END IF;
$guard$);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
COMMIT;
