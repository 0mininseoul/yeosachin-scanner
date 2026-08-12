-- The shared hourly cap turns a traffic spike into a total outage for unrelated users.
-- Retain the per-user hourly and short duplicate-submit guards instead.
DO $migration$
DECLARE
    v_function regprocedure :=
        'public.analysis_v2_create_or_replay_preflight_unfenced_20260802(uuid,text,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure;
    v_definition TEXT;
    v_updated TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_function)
    INTO STRICT v_definition;

    IF pg_catalog.strpos(
        v_definition,
        E'IF v_global_preflight_count >= 3000\n       OR v_recent_preflight_count >= 5'
    ) = 0
       OR pg_catalog.strpos(v_definition, E'INTERVAL ''10 seconds''') = 0 THEN
        RAISE EXCEPTION 'expected preflight global hourly guard was not found';
    END IF;

    v_updated := pg_catalog.replace(
        v_definition,
        E'IF v_global_preflight_count >= 3000\n       OR v_recent_preflight_count >= 5',
        'IF v_recent_preflight_count >= 5'
    );
    EXECUTE v_updated;
END;
$migration$;

REVOKE ALL ON FUNCTION public.analysis_v2_create_or_replay_preflight_unfenced_20260802(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
