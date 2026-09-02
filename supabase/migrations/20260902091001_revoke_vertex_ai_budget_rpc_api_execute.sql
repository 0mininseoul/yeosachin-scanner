-- The initial budget migration revoked PUBLIC but production default privileges had
-- already materialized explicit EXECUTE grants for the API roles. Remove those
-- explicit grants without changing defaults, function bodies, or table access.
REVOKE EXECUTE ON FUNCTION public.reserve_vertex_ai_budget(
    TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BIGINT, INTEGER, NUMERIC, DATE,
    NUMERIC, NUMERIC, NUMERIC
) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.settle_vertex_ai_budget(TEXT, UUID, NUMERIC)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.cancel_vertex_ai_budget(TEXT, UUID)
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.snapshot_vertex_ai_budget()
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_vertex_ai_budget(
    TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BIGINT, INTEGER, NUMERIC, DATE,
    NUMERIC, NUMERIC, NUMERIC
) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_vertex_ai_budget(TEXT, UUID, NUMERIC)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_vertex_ai_budget(TEXT, UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.snapshot_vertex_ai_budget()
    TO service_role;
