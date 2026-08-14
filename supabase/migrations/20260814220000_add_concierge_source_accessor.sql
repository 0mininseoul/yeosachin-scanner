-- MIGRATION_PREDECESSOR=20260814210000
-- Narrow service-role-only accessor for the immutable first-payment concierge
-- replay lineage. The replay audit table remains FORCE RLS with no table grants.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.read_earlybird_v211_concierge_result_source(
    p_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source_request_id UUID;
    v_match_count INTEGER;
BEGIN
    IF p_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
      INTO v_match_count
    FROM public.earlybird_v211_concierge_replays AS replay
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = replay.order_id
    JOIN public.analysis_requests AS source_request
      ON source_request.id = replay.original_failed_request_id
    WHERE replay.order_id = p_order_id
      AND source_request.user_id = earlybird_order.user_id
      AND source_request.target_instagram_id = earlybird_order.target_instagram_id
      AND source_request.pipeline_version = 'v2'
      AND source_request.status = 'failed';

    IF v_match_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT source_request.id
      INTO v_source_request_id
    FROM public.earlybird_v211_concierge_replays AS replay
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = replay.order_id
    JOIN public.analysis_requests AS source_request
      ON source_request.id = replay.original_failed_request_id
    WHERE replay.order_id = p_order_id
      AND source_request.user_id = earlybird_order.user_id
      AND source_request.target_instagram_id = earlybird_order.target_instagram_id
      AND source_request.pipeline_version = 'v2'
      AND source_request.status = 'failed';
    IF v_source_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'sourceRequestId', v_source_request_id::TEXT
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_earlybird_v211_concierge_result_source(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_earlybird_v211_concierge_result_source(UUID)
    TO service_role;

DO $final_guard$
DECLARE
    v_signature TEXT :=
        'public.read_earlybird_v211_concierge_result_source(uuid)';
BEGIN
    IF pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') THEN
        RAISE EXCEPTION 'EARLYBIRD_V211_CONCIERGE_SOURCE_ACCESSOR_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
