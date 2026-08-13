-- Include the settled order amount in the existing payment Discord claim payload.
-- This changes only the RPC return contract; the outbox and ledger schemas remain unchanged.
DROP FUNCTION IF EXISTS public.claim_earlybird_payment_discord_outbox(integer);

CREATE FUNCTION public.claim_earlybird_payment_discord_outbox(
    p_limit integer DEFAULT 1
)
RETURNS TABLE (
    id uuid,
    order_id uuid,
    claim_token uuid,
    plan_id text,
    actual_amount_krw integer,
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
           earlybird_order.actual_amount_krw,
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

REVOKE ALL ON FUNCTION public.claim_earlybird_payment_discord_outbox(integer)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_earlybird_payment_discord_outbox(integer)
    TO service_role;
