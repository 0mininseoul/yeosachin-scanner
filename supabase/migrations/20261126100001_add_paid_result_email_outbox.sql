BEGIN;

-- The recovery worker starts with new fulfillments. Installing this migration never
-- sends historical results, and provider failures cannot affect result publication.
CREATE TABLE public.paid_result_email_rollout (
    singleton boolean PRIMARY KEY CHECK (singleton),
    starts_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO public.paid_result_email_rollout(singleton) VALUES (true);

CREATE TABLE public.paid_result_email_outbox (
    order_id uuid PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE CASCADE,
    request_id uuid NOT NULL UNIQUE REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sending','sent','ineligible','review')),
    next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    first_attempt_at timestamptz,
    attempts integer NOT NULL DEFAULT 0,
    recipient_fingerprint bytea,
    claim_token uuid,
    sent_at timestamptz,
    CHECK ((status = 'sending') = (claim_token IS NOT NULL)),
    CHECK ((status = 'sent') = (sent_at IS NOT NULL))
);
CREATE INDEX paid_result_email_due ON public.paid_result_email_outbox(next_attempt_at,order_id)
    WHERE status IN ('pending','sending');
CREATE INDEX earlybird_completed_email_lookup ON public.earlybird_fulfillments(completed_at,order_id)
    WHERE status = 'completed';
ALTER TABLE public.paid_result_email_rollout ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.paid_result_email_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.paid_result_email_rollout, public.paid_result_email_outbox FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.paid_result_email_recipient(p_order_id uuid, p_owner_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT lower(btrim(a.email))
    FROM public.earlybird_orders o
    JOIN public.users u ON u.id = o.user_id
    JOIN auth.users a ON a.id = u.id
    WHERE o.id = p_order_id AND o.user_id = p_owner_id
      AND o.status IN ('paid','analysis_in_progress','completed')
      AND o.payment_id IS NOT NULL AND o.paid_at IS NOT NULL AND o.seller_reference_confirmed_at IS NOT NULL
      AND o.actual_amount_krw > 0 AND o.actual_amount_krw <= o.expected_amount_krw
      AND o.actual_groble_product_id = o.expected_groble_product_id
      AND u.account_class = 'production' AND u.traffic_class = 'external' AND u.lifecycle = 'active'
      AND a.deleted_at IS NULL AND lower(btrim(u.email)) = lower(btrim(a.email))
      AND length(btrim(a.email)) <= 254 AND btrim(a.email) ~ '^[^[:space:]<>@]+@[^[:space:]<>@]+[.][^[:space:]<>@]+$'
      AND (a.email_confirmed_at IS NOT NULL OR EXISTS (
          SELECT FROM auth.identities i WHERE i.user_id = a.id AND i.provider = 'kakao'
            AND i.identity_data->'email_verified' = 'true'::jsonb
            AND lower(btrim(i.identity_data->>'email')) = lower(btrim(a.email))
      ));
$$;

CREATE FUNCTION public.paid_result_email_available(p_order_id uuid, p_owner_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT public.paid_result_email_recipient(p_order_id, p_owner_id) IS NOT NULL;
$$;

-- Evaluate the same paid, published, owner-readable result both when discovering
-- the delivery and again when reclaiming it. Only the worker receives an address.
CREATE FUNCTION public.claim_paid_result_email(p_token uuid)
RETURNS TABLE(order_id uuid, request_id uuid, recipient text, target text, send_before timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    task public.paid_result_email_outbox%ROWTYPE;
    address text;
    instagram text;
    fingerprint bytea;
    ts timestamptz := clock_timestamp();
BEGIN
    IF p_token IS NULL THEN RAISE EXCEPTION 'INVALID_EMAIL_CLAIM'; END IF;
    INSERT INTO public.paid_result_email_outbox(order_id,request_id,next_attempt_at)
    SELECT f.order_id, f.request_id, ts FROM public.earlybird_fulfillments f
    JOIN public.earlybird_orders o ON o.id=f.order_id AND o.result_request_id=f.request_id
    JOIN public.analysis_requests r ON r.id=f.request_id AND r.user_id=o.user_id
    JOIN public.analysis_v2_result_summaries s ON s.request_id=r.id AND s.target_instagram_id=r.target_instagram_id
    CROSS JOIN public.paid_result_email_rollout rollout
    WHERE rollout.singleton AND f.status='completed' AND f.completed_at >= rollout.starts_at AND r.completed_at >= rollout.starts_at
      AND o.status='completed' AND r.status='completed' AND r.pipeline_version='v2'
      AND o.target_instagram_id=r.target_instagram_id AND o.payment_id IS NOT NULL
      AND NOT EXISTS (SELECT FROM public.paid_result_email_outbox q WHERE q.order_id=f.order_id OR q.request_id=f.request_id)
      AND public.analysis_result_publication_authorized(r.id)
    ORDER BY f.completed_at,f.order_id LIMIT 16
    ON CONFLICT DO NOTHING;

    FOR task IN SELECT q.* FROM public.paid_result_email_outbox q
    WHERE q.status IN ('pending','sending') AND q.next_attempt_at <= ts
    ORDER BY q.next_attempt_at,q.order_id LIMIT 16 FOR UPDATE SKIP LOCKED LOOP
        SELECT public.paid_result_email_recipient(o.id,r.user_id), r.target_instagram_id
        INTO address,instagram
        FROM public.earlybird_orders o
        JOIN public.earlybird_fulfillments f ON f.order_id=o.id AND f.request_id=o.result_request_id
        JOIN public.analysis_requests r ON r.id=f.request_id AND r.user_id=o.user_id
        JOIN public.analysis_v2_result_summaries s ON s.request_id=r.id AND s.target_instagram_id=r.target_instagram_id
        WHERE o.id=task.order_id AND r.id=task.request_id AND r.pipeline_version='v2'
          AND o.target_instagram_id=r.target_instagram_id AND o.status='completed'
          AND f.status='completed' AND f.completed_at IS NOT NULL AND public.analysis_result_publication_authorized(r.id);
        fingerprint := sha256(convert_to(address || chr(10) || instagram,'UTF8'));
        IF address IS NULL OR instagram IS NULL OR instagram !~ '^[a-z0-9._]{1,30}$'
           OR (task.recipient_fingerprint IS NOT NULL AND fingerprint IS DISTINCT FROM task.recipient_fingerprint)
           OR task.first_attempt_at <= ts - interval '23 hours' THEN
            UPDATE public.paid_result_email_outbox q
            SET status=CASE WHEN task.first_attempt_at IS NULL THEN 'ineligible' ELSE 'review' END, claim_token=NULL
            WHERE q.order_id=task.order_id;
            CONTINUE;
        END IF;
        UPDATE public.paid_result_email_outbox q SET status='sending', claim_token=p_token,
            attempts=attempts+1, first_attempt_at=coalesce(first_attempt_at,ts), recipient_fingerprint=fingerprint,
            next_attempt_at=ts+interval '3 minutes' WHERE q.order_id=task.order_id;
        RETURN QUERY SELECT task.order_id, task.request_id, address, instagram,
            least(ts+interval '3 minutes',coalesce(task.first_attempt_at,ts)+interval '23 hours');
        RETURN;
    END LOOP;
END;
$$;

CREATE FUNCTION public.finish_paid_result_email(p_order_id uuid, p_token uuid, p_accepted boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_accepted IS NULL THEN RAISE EXCEPTION 'INVALID_EMAIL_DISPOSITION'; END IF;
    UPDATE public.paid_result_email_outbox q SET
        status=CASE WHEN p_accepted THEN 'sent' ELSE 'pending' END,
        sent_at=CASE WHEN p_accepted THEN clock_timestamp() END,
        next_attempt_at=clock_timestamp() + make_interval(secs => least(900, 30 * (1 << least(q.attempts,5)))),
        claim_token=NULL WHERE q.order_id=p_order_id AND q.status='sending' AND q.claim_token=p_token;
    RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.paid_result_email_recipient(uuid,uuid), public.paid_result_email_available(uuid,uuid),
    public.claim_paid_result_email(uuid), public.finish_paid_result_email(uuid,uuid,boolean)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.paid_result_email_available(uuid,uuid),
    public.claim_paid_result_email(uuid), public.finish_paid_result_email(uuid,uuid,boolean) TO service_role;
COMMIT;
