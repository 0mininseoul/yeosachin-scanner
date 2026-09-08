-- MIGRATION_PREDECESSOR=20260905110000
-- Replace only the B-lite expiry candidate selector. CREATE OR REPLACE preserves the
-- existing function identity, owner, and ACL while retaining its lock protocol.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.purge_expired_precheckout_blite_sources_v1(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight_id UUID;
    v_now TIMESTAMP WITH TIME ZONE;
    v_cache public.precheckout_blite_cache%ROWTYPE;
    v_source public.precheckout_blite_sources%ROWTYPE;
    v_deleted INTEGER := 0;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'PRECHECKOUT_BLITE_INVALID_MAINTENANCE_INPUT', ERRCODE = 'P0001';
    END IF;

    FOR v_preflight_id IN
        SELECT preflight.id
        FROM public.precheckout_blite_sources AS expired_source
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = expired_source.preflight_id
        WHERE expired_source.expires_at <= pg_catalog.clock_timestamp()
        ORDER BY preflight.id
        LIMIT p_limit
        FOR UPDATE OF preflight SKIP LOCKED
    LOOP
        -- Match claim/finalizer/terminal cleanup: parent -> cache -> source.
        SELECT cache.* INTO v_cache
        FROM public.precheckout_blite_cache AS cache
        WHERE cache.preflight_id = v_preflight_id
        FOR UPDATE;
        SELECT source.* INTO v_source
        FROM public.precheckout_blite_sources AS source
        WHERE source.preflight_id = v_preflight_id
        FOR UPDATE;
        v_now := pg_catalog.clock_timestamp();
        IF NOT FOUND OR v_source.expires_at > v_now THEN
            CONTINUE;
        END IF;
        DELETE FROM public.precheckout_blite_cache
        WHERE preflight_id = v_preflight_id;
        DELETE FROM public.precheckout_blite_sources
        WHERE preflight_id = v_preflight_id;
        v_deleted := v_deleted + 1;
    END LOOP;
    RETURN v_deleted;
END;
$$;
