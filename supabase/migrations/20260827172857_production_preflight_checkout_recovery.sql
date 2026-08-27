-- Production payment recovery hotfix: keep the public OAuth claim signature
-- stable while moving its one state transition behind an unexposed schema.
-- The migration is intentionally additive so the previous RPC remains
-- available for rollback and already-running clients.

CREATE SCHEMA IF NOT EXISTS private;

REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.claim_anonymous_analysis_v2_preflight(
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
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '2min'
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_anonymous public.analysis_preflights%ROWTYPE;
    v_owner public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token_hash IS NULL
       OR p_claim_token_hash !~ '^[0-9a-f]{64}$'
       OR p_user_id IS NULL
       OR (SELECT auth.uid()) IS DISTINCT FROM p_user_id THEN
        RETURN QUERY SELECT FALSE, 'invalid'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    -- Match the create/replay RPC's lock order: serialize the owner row before
    -- taking any preflight row lock. This prevents claim/create transactions
    -- from acquiring the users and analysis_preflights locks in opposite
    -- orders while the advisory lock below serializes same-owner claims.
    PERFORM 1
    FROM public.users AS owner_user
    WHERE owner_user.id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'invalid'::TEXT, NULL::UUID;
        RETURN;
    END IF;

    -- Serialize every claim for one authenticated owner. The anonymous row
    -- lock below also fences cross-owner races for a replayed claim token.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'analysis-anonymous-preflight:' || p_user_id::TEXT,
            0
        )
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

    -- Lock the current owner row in the same transaction. A stale row must be
    -- terminalized before the anonymous row is attached, otherwise the active
    -- owner uniqueness fence can reject a valid OAuth continuation.
    SELECT preflight.* INTO v_owner
    FROM public.analysis_preflights AS preflight
    WHERE preflight.user_id = p_user_id
      AND preflight.status IN ('pending', 'processing', 'ready')
    ORDER BY preflight.updated_at DESC, preflight.created_at DESC
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
        IF v_owner.expires_at <= v_now THEN
            -- Internal bounded disposition: ANONYMOUS_PREFLIGHT_OWNER_STALE.
            UPDATE public.analysis_preflights
            SET status = 'expired',
                claim_token_hash = NULL,
                claim_expires_at = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = v_now
            WHERE id = v_owner.id
              AND user_id = p_user_id
              AND status IN ('pending', 'processing', 'ready');
        ELSE
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
                -- Internal bounded disposition: ANONYMOUS_PREFLIGHT_OWNER_TARGET_CONFLICT.
                RETURN QUERY SELECT FALSE, 'owner_active_other_target'::TEXT, NULL::UUID;
            END IF;
            RETURN;
        END IF;
    END IF;

    UPDATE public.analysis_preflights
    SET user_id = p_user_id,
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

REVOKE ALL ON FUNCTION private.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
    TO authenticated;

-- Keep the PostgREST-facing signature and bounded invoker semantics stable.
-- The private helper is not in the exposed API schema; authenticated receives
-- only the minimum USAGE/EXECUTE needed for this wrapper call.
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
BEGIN
    RETURN QUERY
    SELECT helper.claimed, helper.preflight_status, helper.owner_preflight_id
    FROM private.claim_anonymous_analysis_v2_preflight(
        p_preflight_id,
        p_claim_token_hash,
        p_user_id
    ) AS helper;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
    TO authenticated;

-- Authenticated creation uses a distinct RPC so the legacy function can be
-- rolled back independently. The existing create transaction is reused, then
-- the returned row is locked and atomically bound/compared before returning.
CREATE OR REPLACE FUNCTION public.create_or_replay_analysis_v2_preflight_with_target_hash(
    p_user_id UUID,
    p_email TEXT,
    p_auth_provider TEXT,
    p_target_instagram_id TEXT,
    p_idempotency_key TEXT,
    p_access_mode TEXT,
    p_launch_status_snapshot JSONB,
    p_plan_catalog_snapshot JSONB,
    p_pricing_version TEXT,
    p_pricing_snapshot JSONB,
    p_policy_versions_snapshot JSONB,
    p_target_input_hash TEXT
)
RETURNS TABLE(
    preflight_id UUID,
    created BOOLEAN,
    preflight_status TEXT,
    expires_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '2min'
AS $$
DECLARE
    v_created RECORD;
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_target_input_hash IS NULL
       OR p_target_input_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_TARGET_HASH_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT created_row.* INTO v_created
    FROM public.create_or_replay_analysis_v2_preflight(
        p_user_id,
        p_email,
        p_auth_provider,
        p_target_instagram_id,
        p_idempotency_key,
        p_access_mode,
        p_launch_status_snapshot,
        p_plan_catalog_snapshot,
        p_pricing_version,
        p_pricing_snapshot,
        p_policy_versions_snapshot
    ) AS created_row;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_created.preflight_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.target_input_hash IS NULL THEN
        UPDATE public.analysis_preflights
        SET target_input_hash = p_target_input_hash,
            updated_at = pg_catalog.clock_timestamp()
        WHERE id = v_preflight.id
          AND target_input_hash IS NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PREFLIGHT_TARGET_HASH_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        v_preflight.target_input_hash := p_target_input_hash;
    ELSIF v_preflight.target_input_hash IS DISTINCT FROM p_target_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_TARGET_HASH_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    RETURN QUERY
    SELECT v_preflight.id,
           v_created.created,
           v_preflight.status,
           v_preflight.expires_at;
END;
$$;

REVOKE ALL ON FUNCTION public.create_or_replay_analysis_v2_preflight_with_target_hash(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_analysis_v2_preflight_with_target_hash(
    UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT, JSONB, JSONB, TEXT
) TO service_role;

NOTIFY pgrst, 'reload schema';
