-- The anonymous flow presents the self-exclusion step while the profile
-- summary is still being collected.  The decision is independent of the
-- ready snapshot, so keep the claim fence but allow the same lifecycle states
-- as the authenticated exclusion RPC.
CREATE OR REPLACE FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64),
    p_decision TEXT,
    p_excluded_instagram_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_target TEXT;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_claim_hash', p_claim_token_hash, TRUE
    );
    SELECT target_instagram_id INTO v_target
    FROM public.analysis_preflights
    WHERE id = p_preflight_id
      AND user_id IS NULL
      AND claim_token_hash = p_claim_token_hash
      AND claim_expires_at > v_now
      AND expires_at > v_now
      AND status IN ('pending', 'processing', 'ready')
    FOR UPDATE;
    IF NOT FOUND
       OR p_decision NOT IN ('exclude', 'skip')
       OR (p_decision = 'exclude' AND (
            p_excluded_instagram_id IS NULL
            OR p_excluded_instagram_id !~ '^[a-z0-9._]{1,30}$'
            OR p_excluded_instagram_id = v_target
       ))
       OR (p_decision = 'skip' AND p_excluded_instagram_id IS NOT NULL) THEN
        RETURN FALSE;
    END IF;
    UPDATE public.analysis_preflights
    SET exclusion_decision = p_decision,
        excluded_instagram_id = p_excluded_instagram_id,
        exclusion_decided_at = v_now,
        updated_at = v_now
    WHERE id = p_preflight_id;
    RETURN TRUE;
END;
$$;
