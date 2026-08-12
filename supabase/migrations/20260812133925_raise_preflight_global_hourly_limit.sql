-- Campaign traffic can legitimately exceed the original 300/hour global guard.
-- Keep the per-user (5/hour) and duplicate-submit (10 seconds) protections intact,
-- and only raise the shared ceiling so one busy cohort cannot lock out everyone.
DO $migration$
DECLARE
    v_function regprocedure :=
        'public.analysis_v2_create_or_replay_preflight_unfenced_20260802(uuid,text,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure;
    v_definition TEXT;
    v_updated TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_function)
    INTO STRICT v_definition;

    IF pg_catalog.strpos(v_definition, 'v_global_preflight_count >= 300') = 0
       OR pg_catalog.strpos(v_definition, 'v_global_preflight_count >= 3000') > 0 THEN
        RAISE EXCEPTION 'expected preflight global hourly limit definition was not found';
    END IF;

    v_updated := pg_catalog.replace(
        v_definition,
        'v_global_preflight_count >= 300',
        'v_global_preflight_count >= 3000'
    );
    EXECUTE v_updated;
END;
$migration$;

REVOKE ALL ON FUNCTION public.analysis_v2_create_or_replay_preflight_unfenced_20260802(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
