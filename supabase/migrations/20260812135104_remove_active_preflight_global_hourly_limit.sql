-- The active public RPC was redefined by a production-only migration and no longer
-- delegates to the older private helper. Remove the shared cap from the real entry point.
DO $migration$
DECLARE
    v_function regprocedure :=
        'public.create_or_replay_analysis_v2_preflight(uuid,text,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure;
    v_definition TEXT;
    v_updated TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_function)
    INTO STRICT v_definition;

    IF pg_catalog.strpos(
        v_definition,
        E'IF v_global_preflight_count >= 300\n       OR v_recent_preflight_count >= 5 OR EXISTS'
    ) = 0
       OR pg_catalog.strpos(v_definition, E'INTERVAL ''10 seconds''') = 0 THEN
        RAISE EXCEPTION 'expected active preflight global hourly guard was not found';
    END IF;

    v_updated := pg_catalog.replace(
        v_definition,
        E'IF v_global_preflight_count >= 300\n       OR v_recent_preflight_count >= 5 OR EXISTS',
        'IF v_recent_preflight_count >= 5 OR EXISTS'
    );
    EXECUTE v_updated;
END;
$migration$;

REVOKE ALL ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) TO service_role;
