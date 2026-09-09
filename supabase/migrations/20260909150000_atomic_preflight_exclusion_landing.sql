-- Validate the caller, preflight lifecycle, and exclusion payload while holding
-- the preflight row lock, then persist the exclusion lead in the same
-- transaction. A failed lead capture therefore rolls back the decision.
CREATE OR REPLACE FUNCTION public.set_analysis_v2_preflight_exclusion_with_landing(
    p_preflight_id UUID,
    p_user_id UUID,
    p_claim_token_hash VARCHAR(64),
    p_decision TEXT,
    p_excluded_instagram_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '2min'
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_excluded_instagram_id TEXT;
BEGIN
    IF p_preflight_id IS NULL
       OR p_decision IS NULL
       OR p_decision NOT IN ('exclude', 'skip') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    IF p_user_id IS NOT NULL THEN
        IF p_claim_token_hash IS NOT NULL
           OR (SELECT auth.uid()) IS DISTINCT FROM p_user_id THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
        END IF;
    ELSIF p_claim_token_hash IS NULL
          OR p_claim_token_hash !~ '^[0-9a-f]{64}$'
          OR (SELECT auth.uid()) IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_CLAIM_INVALID', ERRCODE = 'P0001';
    END IF;

    IF p_decision = 'exclude' THEN
        v_excluded_instagram_id := pg_catalog.lower(pg_catalog.btrim(p_excluded_instagram_id));
        IF v_excluded_instagram_id IS NULL
           OR v_excluded_instagram_id !~ '^[a-z0-9._]{1,30}$' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
        END IF;
    ELSIF p_excluded_instagram_id IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND (
          (
              p_user_id IS NOT NULL
              AND preflight.user_id = p_user_id
          )
          OR (
              p_user_id IS NULL
              AND preflight.user_id IS NULL
              AND preflight.claim_token_hash = p_claim_token_hash
              AND preflight.claim_expires_at > v_now
          )
      )
    FOR UPDATE;
    IF NOT FOUND THEN
        IF p_user_id IS NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_CLAIM_INVALID', ERRCODE = 'P0001';
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    -- Lifecycle and expiry remain authoritative even for an identical retry.
    -- They must be checked before replay/self-heal so an expired or consumed
    -- row can never recreate an excluded landing lead.
    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_EXPIRED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status = 'consumed' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_CONSUMED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status NOT IN ('pending', 'processing', 'ready') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF p_user_id IS NOT NULL
       AND v_preflight.beta_entry_provenance IS NOT NULL
       AND NOT public.analysis_beta_has_access() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;

    -- An identical retry is successful without changing the write-once
    -- decision. For an exclusion, replay the idempotent lead insert as well so
    -- a legacy decision that predates this atomic boundary can self-heal.
    IF v_preflight.exclusion_decision = p_decision
       AND v_preflight.excluded_instagram_id IS NOT DISTINCT FROM v_excluded_instagram_id THEN
        IF p_decision = 'exclude'
           AND NOT public.create_or_replay_landing_lead_exclusion(
               p_preflight_id,
               v_excluded_instagram_id
           ) THEN
            RAISE EXCEPTION USING MESSAGE = 'LANDING_LEAD_TARGET_MISSING', ERRCODE = 'P0001';
        END IF;
        RETURN FALSE;
    END IF;
    IF v_preflight.exclusion_decision <> 'pending' THEN
        RAISE EXCEPTION USING MESSAGE = 'PREFLIGHT_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    IF p_decision = 'exclude'
       AND v_excluded_instagram_id = pg_catalog.lower(v_preflight.target_instagram_id) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights AS preflight
    SET exclusion_decision = p_decision,
        excluded_instagram_id = v_excluded_instagram_id,
        exclusion_decided_at = v_now,
        updated_at = v_now
    WHERE preflight.id = v_preflight.id
      AND preflight.exclusion_decision = 'pending';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PREFLIGHT_IMMUTABLE', ERRCODE = 'P0001';
    END IF;

    IF p_decision = 'exclude'
       AND NOT public.create_or_replay_landing_lead_exclusion(
           p_preflight_id,
           v_excluded_instagram_id
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'LANDING_LEAD_TARGET_MISSING', ERRCODE = 'P0001';
    END IF;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.set_analysis_v2_preflight_exclusion_with_landing(
    UUID, UUID, VARCHAR, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_analysis_v2_preflight_exclusion_with_landing(
    UUID, UUID, VARCHAR, TEXT, TEXT
) TO anon, authenticated;

-- Preserve the historical browser RPC signatures for mixed-version clients,
-- but route both through the same atomic boundary so they cannot commit a
-- decision without its excluded lead.
CREATE OR REPLACE FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64),
    p_decision TEXT,
    p_excluded_instagram_id TEXT
)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY INVOKER
SET search_path = public, extensions
AS $$
    SELECT public.set_analysis_v2_preflight_exclusion_with_landing(
        p_preflight_id,
        NULL::UUID,
        p_claim_token_hash,
        p_decision,
        p_excluded_instagram_id
    );
$$;

REVOKE ALL ON FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(
    UUID, VARCHAR, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(
    UUID, VARCHAR, TEXT, TEXT
) TO anon, authenticated;

CREATE OR REPLACE FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    p_preflight_id UUID,
    p_user_id UUID,
    p_decision TEXT,
    p_excluded_instagram_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '2min'
AS $$
    SELECT public.set_analysis_v2_preflight_exclusion_with_landing(
        p_preflight_id,
        p_user_id,
        NULL::VARCHAR,
        p_decision,
        p_excluded_instagram_id
    );
$$;

REVOKE ALL ON FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    UUID, UUID, TEXT, TEXT
) TO authenticated;

-- The historical service-only exclusion RPC has no landing-write boundary.
-- Keep its signature for mixed-version schema compatibility, but hard-fail
-- that unscoped path so all supported decisions use the atomic RPC above.
REVOKE ALL ON FUNCTION public.set_analysis_v2_preflight_exclusion(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
