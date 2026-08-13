-- Accepted Groble payments create one privacy-safe Discord delivery row in the
-- same transaction that moves an earlybird order to paid.
CREATE TABLE public.earlybird_payment_discord_outbox (
    id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    order_id uuid NOT NULL UNIQUE REFERENCES public.earlybird_orders(id) ON DELETE CASCADE,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'ambiguous_failed')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    claim_token uuid,
    claimed_at timestamptz,
    sent_at timestamptz,
    failure_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX earlybird_payment_discord_outbox_pending_idx
    ON public.earlybird_payment_discord_outbox (next_attempt_at, created_at)
    WHERE status = 'pending';

ALTER TABLE public.earlybird_payment_discord_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_payment_discord_outbox FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_payment_discord_outbox FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.earlybird_payment_discord_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_earlybird_payment_discord_outbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF NEW.status = 'paid'
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'paid') THEN
        INSERT INTO public.earlybird_payment_discord_outbox (order_id)
        VALUES (NEW.id)
        ON CONFLICT (order_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_earlybird_order_paid_discord_outbox
    ON public.earlybird_orders;
CREATE TRIGGER on_earlybird_order_paid_discord_outbox
    AFTER INSERT OR UPDATE OF status ON public.earlybird_orders
    FOR EACH ROW
    EXECUTE FUNCTION public.enqueue_earlybird_payment_discord_outbox();

CREATE OR REPLACE FUNCTION public.claim_earlybird_payment_discord_outbox(
    p_limit integer DEFAULT 1
)
RETURNS TABLE (
    id uuid,
    order_id uuid,
    claim_token uuid,
    plan_id text,
    paid_at timestamptz,
    buyer_name text,
    gender text,
    attempts integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    WITH candidates AS (
        SELECT outbox.id
        FROM public.earlybird_payment_discord_outbox AS outbox
        JOIN public.earlybird_orders AS earlybird_order
            ON earlybird_order.id = outbox.order_id
        WHERE outbox.status = 'pending'
          AND outbox.next_attempt_at <= clock_timestamp()
          AND earlybird_order.status = 'paid'
        ORDER BY outbox.created_at
        FOR UPDATE OF outbox SKIP LOCKED
        LIMIT LEAST(GREATEST(COALESCE(p_limit, 1), 1), 10)
    ), claimed AS (
        UPDATE public.earlybird_payment_discord_outbox AS outbox
        SET status = 'sending',
            attempts = outbox.attempts + 1,
            claim_token = uuid_generate_v4(),
            claimed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        FROM candidates
        WHERE outbox.id = candidates.id
        RETURNING outbox.*
    )
    SELECT claimed.id,
           claimed.order_id,
           claimed.claim_token,
           earlybird_order.plan_id::text,
           earlybird_order.paid_at,
           buyer.name::text,
           buyer.gender::text,
           claimed.attempts
    FROM claimed
    JOIN public.earlybird_orders AS earlybird_order
        ON earlybird_order.id = claimed.order_id
    LEFT JOIN public.users AS buyer
        ON buyer.id = earlybird_order.user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.complete_earlybird_payment_discord_outbox(
    p_outbox_id uuid,
    p_claim_token uuid,
    p_outcome text,
    p_failure_code text DEFAULT NULL,
    p_retry_after_seconds integer DEFAULT 0
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_attempts integer;
BEGIN
    IF p_outcome NOT IN ('sent', 'retry', 'failed', 'ambiguous_failed') THEN
        RAISE EXCEPTION 'EARLYBIRD_PAYMENT_DISCORD_OUTBOX_OUTCOME_INVALID';
    END IF;

    SELECT attempts
    INTO v_attempts
    FROM public.earlybird_payment_discord_outbox
    WHERE id = p_outbox_id
      AND status = 'sending'
      AND claim_token = p_claim_token
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'EARLYBIRD_PAYMENT_DISCORD_OUTBOX_CLAIM_NOT_FOUND';
    END IF;

    UPDATE public.earlybird_payment_discord_outbox
    SET status = CASE
            WHEN p_outcome = 'sent' THEN 'sent'
            WHEN p_outcome = 'retry' AND v_attempts < 3 THEN 'pending'
            WHEN p_outcome = 'ambiguous_failed' THEN 'ambiguous_failed'
            ELSE 'failed'
        END,
        next_attempt_at = CASE
            WHEN p_outcome = 'retry' AND v_attempts < 3
                THEN clock_timestamp()
                    + make_interval(secs => LEAST(
                        GREATEST(COALESCE(p_retry_after_seconds, 1), 1),
                        900
                    ))
            ELSE next_attempt_at
        END,
        sent_at = CASE WHEN p_outcome = 'sent' THEN clock_timestamp() ELSE sent_at END,
        failure_code = CASE WHEN p_outcome = 'sent' THEN NULL ELSE p_failure_code END,
        claim_token = NULL,
        claimed_at = NULL,
        updated_at = clock_timestamp()
    WHERE id = p_outbox_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.reconcile_stale_earlybird_payment_discord_claims(
    p_lease_seconds integer DEFAULT 900
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_count integer;
BEGIN
    UPDATE public.earlybird_payment_discord_outbox
    SET status = 'ambiguous_failed',
        failure_code = 'DISCORD_CLAIM_LEASE_EXPIRED_AMBIGUOUS',
        claim_token = NULL,
        claimed_at = NULL,
        updated_at = clock_timestamp()
    WHERE status = 'sending'
      AND claimed_at < clock_timestamp()
            - make_interval(secs => LEAST(
                GREATEST(COALESCE(p_lease_seconds, 900), 60),
                3600
            ));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_earlybird_payment_discord_outbox()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_earlybird_payment_discord_outbox(integer)
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_earlybird_payment_discord_outbox(
    uuid, uuid, text, text, integer
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reconcile_stale_earlybird_payment_discord_claims(integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_earlybird_payment_discord_outbox(integer)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_earlybird_payment_discord_outbox(
    uuid, uuid, text, text, integer
) TO service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_earlybird_payment_discord_claims(integer)
    TO service_role;
