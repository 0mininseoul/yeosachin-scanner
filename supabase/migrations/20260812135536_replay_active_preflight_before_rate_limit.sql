-- Repeated submissions for the same owner and target should resume the active
-- preflight instead of surfacing an expected admission guard as preflight_failed.
DO $migration$
DECLARE
    v_function regprocedure :=
        'public.create_or_replay_analysis_v2_preflight(uuid,text,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb)'::regprocedure;
    v_definition TEXT;
    v_anchor TEXT :=
        E'    -- Serialize only fresh global-budget checks. Idempotent replays returned above do not consume\n' ||
        E'    -- capacity or contend on this circuit breaker.\n';
    v_replay TEXT :=
        E'    SELECT preflight.* INTO v_existing\n' ||
        E'    FROM public.analysis_preflights AS preflight\n' ||
        E'    WHERE preflight.user_id = p_user_id\n' ||
        E'      AND preflight.target_instagram_id = v_target_instagram_id\n' ||
        E'      AND preflight.access_mode = p_access_mode\n' ||
        E'      AND preflight.beta_entry_provenance IS NULL\n' ||
        E'      AND preflight.status IN (''pending'', ''processing'', ''ready'')\n' ||
        E'      AND preflight.expires_at > v_now\n' ||
        E'    ORDER BY preflight.created_at DESC\n' ||
        E'    LIMIT 1\n' ||
        E'    FOR UPDATE;\n' ||
        E'    IF FOUND THEN\n' ||
        E'        RETURN QUERY SELECT v_existing.id, FALSE, v_existing.status, v_existing.expires_at;\n' ||
        E'        RETURN;\n' ||
        E'    END IF;\n\n';
BEGIN
    SELECT pg_catalog.pg_get_functiondef(v_function)
    INTO STRICT v_definition;

    IF pg_catalog.strpos(v_definition, v_anchor) = 0
       OR pg_catalog.strpos(v_definition, 'preflight.beta_entry_provenance IS NULL') > 0 THEN
        RAISE EXCEPTION 'expected active preflight admission anchor was not found';
    END IF;

    EXECUTE pg_catalog.replace(v_definition, v_anchor, v_replay || v_anchor);
END;
$migration$;

REVOKE ALL ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB
) TO service_role;
