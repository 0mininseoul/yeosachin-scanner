-- The anonymous create RPC runs as the caller so its RLS policies remain the
-- boundary. Its INSERT also evaluates the existing plan-card shape CHECK, so
-- the immutable, data-free validator must be callable by the public roles.
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
    TO anon, authenticated;
