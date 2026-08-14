-- The API persists the authoritative target identity hash on the preflight row.  A worker may
-- run with a different deployment secret during a rotation, but it must never invent a new
-- lineage hash for a B-lite source.  Read that persisted hash only through the current claim
-- fence; this is service-role-only and returns no clear-text target identity.
CREATE OR REPLACE FUNCTION public.read_claimed_analysis_v2_preflight_target_hash_v1(
    p_preflight_id UUID,
    p_claim_token UUID
)
RETURNS VARCHAR
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_CLAIM_INPUT', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now
       OR v_preflight.expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_CLAIM_FENCE_LOST', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.target_input_hash IS NOT NULL
       AND v_preflight.target_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_TARGET_HASH_INVALID', ERRCODE = 'P0001';
    END IF;

    RETURN v_preflight.target_input_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.read_claimed_analysis_v2_preflight_target_hash_v1(UUID, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_claimed_analysis_v2_preflight_target_hash_v1(UUID, UUID)
    TO service_role;

NOTIFY pgrst, 'reload schema';
