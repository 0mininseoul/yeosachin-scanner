-- Do not resume OAuth against an owner preflight whose fixed 30-minute TTL has
-- elapsed. Mark that stale row expired first so the active-owner uniqueness
-- fence is released, then claim the current anonymous snapshot normally.
CREATE OR REPLACE FUNCTION public.claim_anonymous_analysis_v2_preflight(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64),
    p_user_id UUID
)
RETURNS TABLE(
    claimed BOOLEAN,
    preflight_status TEXT,
    owner_preflight_id UUID
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_anonymous public.analysis_preflights%ROWTYPE;
    v_owner public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token_hash !~ '^[0-9a-f]{64}$'
       OR p_user_id IS NULL
       OR (SELECT auth.uid()) IS DISTINCT FROM p_user_id THEN
        RETURN QUERY SELECT FALSE, 'invalid'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_claim_hash', p_claim_token_hash, TRUE
    );

    SELECT preflight.* INTO v_anonymous
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id IS NULL
      AND preflight.provider_selector = 'anonymous_apify'
      AND preflight.claim_token_hash = p_claim_token_hash
      AND preflight.claim_expires_at > v_now
      AND preflight.status IN ('ready', 'blocked')
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'rejected'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    -- Lock the user's current owner before touching the anonymous row. An
    -- expired row still participates in the active-owner index until it is
    -- explicitly terminalized, so clear that fence before the new claim.
    SELECT preflight.* INTO v_owner
    FROM public.analysis_preflights AS preflight
    WHERE preflight.user_id = (SELECT auth.uid())
      AND preflight.status IN ('pending', 'processing', 'ready')
    ORDER BY preflight.updated_at DESC, preflight.created_at DESC
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
        IF v_owner.expires_at <= v_now THEN
            UPDATE public.analysis_preflights
            SET status = 'expired',
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = v_now
            WHERE id = v_owner.id
              AND user_id = (SELECT auth.uid())
              AND status IN ('pending', 'processing', 'ready');
        ELSE
            -- An earlier callback may already own a live snapshot for this
            -- target. Reuse that row rather than violating uniqueness fences.
            PERFORM pg_catalog.set_config(
                'app.anonymous_preflight_idempotency_key',
                v_anonymous.idempotency_key,
                TRUE
            );
            UPDATE public.analysis_preflights
            SET status = 'expired',
                claim_token_hash = NULL,
                claim_expires_at = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = v_now
            WHERE id = v_anonymous.id;

            IF v_owner.target_instagram_id IS NOT DISTINCT FROM v_anonymous.target_instagram_id THEN
                RETURN QUERY SELECT FALSE, 'owner_active'::TEXT, v_owner.id;
            ELSE
                RETURN QUERY SELECT FALSE, 'owner_active_other_target'::TEXT, NULL::UUID;
            END IF;
            RETURN;
        END IF;
    END IF;

    UPDATE public.analysis_preflights
    SET user_id = (SELECT auth.uid()),
        claim_token_hash = NULL,
        claim_expires_at = NULL,
        claimed_at = COALESCE(claimed_at, v_now),
        updated_at = v_now
    WHERE id = p_preflight_id
      AND user_id IS NULL
      AND claim_token_hash = p_claim_token_hash
      AND claim_expires_at > v_now
      AND status IN ('ready', 'blocked');
    IF FOUND THEN
        RETURN QUERY SELECT TRUE, 'claimed'::TEXT, NULL::UUID;
    ELSE
        RETURN QUERY SELECT FALSE, 'rejected'::TEXT, NULL::UUID;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
    TO authenticated;

NOTIFY pgrst, 'reload schema';
