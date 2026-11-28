BEGIN;

CREATE TABLE public.paid_result_email_recipients (
    order_id uuid PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE CASCADE,
    sealed_recipient text NOT NULL CHECK (
        length(sealed_recipient) BETWEEN 40 AND 1400 AND sealed_recipient ~ '^[A-Za-z0-9_-]+$'
    ),
    expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '48 hours'
);
CREATE INDEX paid_result_email_recipient_expiry ON public.paid_result_email_recipients(expires_at);
ALTER TABLE public.paid_result_email_recipients ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_result_email_recipients FROM PUBLIC, anon, authenticated, service_role;

-- The first accepted, signed purchase and its address commit together.
-- A duplicate event, refund, or historic purchase can never replace the address.
CREATE FUNCTION public.finalize_paid_analysis_with_result_email_v1(
    p_event_id text, p_idempotency_key text, p_event_type text, p_occurred_at timestamptz, p_payment_id text,
    p_buyer_email text, p_buyer_phone_normalized text, p_buyer_phone_raw text, p_buyer_display_name text,
    p_product_id text, p_amount_krw integer, p_paid_at timestamptz, p_seller_reference text, p_sealed_recipient text
) RETURNS TABLE(disposition text, order_id uuid, status text, plan_sequence smallint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    payment record;
BEGIN
    IF p_event_type IS DISTINCT FROM 'payment.completed'
       OR p_seller_reference IS NULL OR p_seller_reference !~ '^ord\.[a-f0-9]{32}$'
       OR p_sealed_recipient IS NULL OR length(p_sealed_recipient) NOT BETWEEN 40 AND 1400
       OR p_sealed_recipient !~ '^[A-Za-z0-9_-]+$' THEN
        RAISE EXCEPTION 'PAID_RESULT_EMAIL_CAPTURE_INVALID';
    END IF;
    SELECT * INTO STRICT payment FROM public.finalize_automatic_paid_analysis_v1(
        p_event_id,p_idempotency_key,p_event_type,p_occurred_at,p_payment_id,
        p_buyer_email,p_buyer_phone_normalized,p_buyer_phone_raw,p_buyer_display_name,
        p_product_id,p_amount_krw,p_paid_at,p_seller_reference
    );
    IF payment.disposition = 'accepted' AND payment.status = 'paid' THEN
        INSERT INTO public.paid_result_email_recipients(order_id,sealed_recipient)
        SELECT o.id,p_sealed_recipient
        FROM public.earlybird_orders o
        JOIN public.earlybird_webhook_events e ON e.event_id=p_event_id AND e.order_id=o.id
        JOIN public.users u ON u.id=o.user_id
        WHERE o.id=payment.order_id AND o.groble_seller_reference=p_seller_reference
          AND o.seller_reference_confirmed_at IS NOT NULL
          AND o.payment_id=p_payment_id AND o.actual_amount_krw=p_amount_krw
          AND o.actual_amount_krw>0 AND o.actual_groble_product_id=p_product_id
          AND o.expected_groble_product_id=p_product_id
          AND e.idempotency_key=p_idempotency_key AND e.event_type='payment.completed'
          AND e.disposition='accepted' AND e.payment_id=p_payment_id
          AND e.product_id=p_product_id AND e.amount_krw=p_amount_krw
          AND u.account_class='production' AND u.traffic_class='external' AND u.lifecycle='active'
        ON CONFLICT DO NOTHING;
    END IF;
    RETURN QUERY SELECT payment.disposition,payment.order_id,payment.status,payment.plan_sequence;
END;
$$;

-- Keep the outbox claim shape and guard the encrypted recipient on every attempt.
CREATE OR REPLACE FUNCTION public.paid_result_email_recipient(p_order_id uuid, p_owner_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT o.groble_seller_reference || ':' || recipient.sealed_recipient
    FROM public.paid_result_email_recipients recipient
    JOIN public.earlybird_orders o ON o.id=recipient.order_id
    JOIN public.users u ON u.id=o.user_id
    JOIN auth.users a ON a.id=u.id
    WHERE o.id=p_order_id AND o.user_id=p_owner_id AND recipient.expires_at > now()
      AND o.status IN ('paid','analysis_in_progress','completed')
      AND o.payment_id IS NOT NULL AND o.paid_at IS NOT NULL
      AND o.seller_reference_confirmed_at IS NOT NULL
      AND o.actual_amount_krw > 0 AND o.actual_amount_krw <= o.expected_amount_krw
      AND o.actual_groble_product_id = o.expected_groble_product_id
      AND u.account_class='production' AND u.traffic_class='external' AND u.lifecycle='active'
      AND a.deleted_at IS NULL;
$$;

CREATE OR REPLACE FUNCTION public.finish_paid_result_email(p_order_id uuid, p_token uuid, p_accepted boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_accepted IS NULL THEN RAISE EXCEPTION 'INVALID_EMAIL_DISPOSITION'; END IF;
    UPDATE public.paid_result_email_outbox q SET
        status=CASE WHEN p_accepted THEN 'sent' ELSE 'pending' END,
        sent_at=CASE WHEN p_accepted THEN clock_timestamp() END,
        next_attempt_at=clock_timestamp() + make_interval(secs => least(900, 30 * (1 << least(q.attempts,5)))),
        claim_token=NULL WHERE q.order_id=p_order_id AND q.status='sending' AND q.claim_token=p_token;
    IF NOT FOUND THEN RETURN false; END IF;
    IF p_accepted THEN
        DELETE FROM public.paid_result_email_recipients r WHERE r.order_id=p_order_id;
    END IF;
    RETURN true;
END;
$$;

-- The paid state, publication, recipient expiry and worker claim are checked
-- again immediately before the worker submits the message to the provider.
CREATE FUNCTION public.paid_result_email_send_deadline_v1(p_order_id uuid, p_token uuid)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT least(recipient.expires_at,q.next_attempt_at,q.first_attempt_at+interval '23 hours')
    FROM public.paid_result_email_outbox q
    JOIN public.earlybird_orders o ON o.id=q.order_id AND o.result_request_id=q.request_id
    JOIN public.earlybird_fulfillments f ON f.order_id=o.id AND f.request_id=q.request_id
    JOIN public.paid_result_email_recipients recipient ON recipient.order_id=q.order_id
    WHERE q.order_id=p_order_id AND q.status='sending' AND q.claim_token=p_token
      AND q.next_attempt_at>now() AND f.status='completed' AND o.status='completed'
      AND public.paid_result_email_recipient(o.id,o.user_id) IS NOT NULL
      AND public.analysis_result_publication_authorized(q.request_id);
$$;

CREATE FUNCTION public.purge_paid_result_email_recipients_v1()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    removed integer;
BEGIN
    DELETE FROM public.paid_result_email_recipients r
    USING public.earlybird_orders o
    WHERE o.id=r.order_id AND (r.expires_at <= now()
        OR o.status NOT IN ('paid','analysis_in_progress','completed')
        OR EXISTS (SELECT FROM public.paid_result_email_outbox q
            WHERE q.order_id=r.order_id AND q.status IN ('sent','ineligible','review')));
    GET DIAGNOSTICS removed = ROW_COUNT;
    RETURN removed;
END;
$$;

REVOKE ALL ON FUNCTION public.finalize_paid_analysis_with_result_email_v1(
    text,text,text,timestamptz,text,text,text,text,text,text,integer,timestamptz,text,text
), public.purge_paid_result_email_recipients_v1(), public.paid_result_email_send_deadline_v1(uuid,uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_paid_analysis_with_result_email_v1(
    text,text,text,timestamptz,text,text,text,text,text,text,integer,timestamptz,text,text
), public.purge_paid_result_email_recipients_v1(), public.paid_result_email_send_deadline_v1(uuid,uuid) TO service_role;
COMMIT;
