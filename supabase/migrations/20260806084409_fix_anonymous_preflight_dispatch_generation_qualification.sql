-- The dispatch RPC returns a column named dispatch_generation. Qualify the
-- target column in the increment so PostgreSQL does not resolve the UPDATE
-- expression against the PL/pgSQL output variable instead of the row column.
CREATE OR REPLACE FUNCTION public.reserve_anonymous_analysis_v2_preflight_dispatch(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64),
    p_dispatch_token UUID
)
RETURNS TABLE(should_enqueue BOOLEAN, dispatch_generation INTEGER, reservation_token UUID, preflight_status TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token_hash !~ '^[0-9a-f]{64}$'
       OR p_dispatch_token IS NULL THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'missing'::TEXT;
        RETURN;
    END IF;
    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_claim_hash', p_claim_token_hash, TRUE
    );
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id IS NULL
      AND preflight.claim_token_hash = p_claim_token_hash
      AND preflight.claim_expires_at > v_now
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 0, NULL::UUID, 'missing'::TEXT;
        RETURN;
    END IF;
    IF v_preflight.dispatch_state = 'enqueued' THEN
        RETURN QUERY SELECT FALSE, v_preflight.dispatch_generation, NULL::UUID, v_preflight.status;
        RETURN;
    END IF;
    UPDATE public.analysis_preflights AS target
    SET dispatch_generation = target.dispatch_generation + 1,
        dispatch_state = 'reserved',
        dispatch_token = p_dispatch_token,
        dispatch_reserved_at = v_now,
        updated_at = v_now
    WHERE target.id = p_preflight_id;
    RETURN QUERY SELECT TRUE, v_preflight.dispatch_generation + 1, p_dispatch_token, v_preflight.status;
END;
$$;
