-- The fulfillment outbox is intentionally not table-readable, even by the
-- service role. Expose only the status needed by the owner-facing order page
-- through the existing service-only RPC boundary.
CREATE FUNCTION public.load_earlybird_fulfillment_status(
    p_order_id UUID
)
RETURNS TEXT
LANGUAGE sql
STABLE
STRICT
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT fulfillment.status
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id;
$$;

REVOKE ALL ON FUNCTION public.load_earlybird_fulfillment_status(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_earlybird_fulfillment_status(UUID)
    TO service_role;

COMMENT ON FUNCTION public.load_earlybird_fulfillment_status(UUID) IS
    'Service-only status projection for the owner-facing paid-order status page; the fulfillment table remains private.';
