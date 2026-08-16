-- Preparation is an operator-only, row-locking RPC.  Bound lock waits at the
-- function boundary so a stale or overlapping invocation fails one order
-- promptly instead of holding the seven-order window until the HTTP timeout.
ALTER FUNCTION public.prepare_concierge_batch_order(UUID)
    SET lock_timeout = '5s';
