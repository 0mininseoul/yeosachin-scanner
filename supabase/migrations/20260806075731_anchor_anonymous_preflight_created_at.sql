-- Keep the TTL check anchored to the same timestamp used to calculate expires_at.
-- The original RPC used the column default for created_at, which can differ by a
-- few microseconds from its v_now value and make every anonymous insert fail.
CREATE OR REPLACE FUNCTION public.create_anonymous_analysis_v2_preflight(
    p_target_instagram_id TEXT,
    p_target_input_hash VARCHAR(64),
    p_idempotency_key VARCHAR(128),
    p_claim_token_hash VARCHAR(64),
    p_claim_expires_at TIMESTAMP WITH TIME ZONE,
    p_launch_status_snapshot JSONB,
    p_plan_catalog_snapshot JSONB,
    p_pricing_version VARCHAR(64),
    p_pricing_snapshot JSONB,
    p_policy_versions_snapshot JSONB
)
RETURNS TABLE(preflight_id UUID, expires_at TIMESTAMP WITH TIME ZONE, created BOOLEAN, preflight_status TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_existing public.analysis_preflights%ROWTYPE;
    v_id UUID;
    v_expires TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_target_instagram_id IS NULL
       OR p_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
       OR p_target_input_hash !~ '^[0-9a-f]{64}$'
       OR p_idempotency_key IS NULL
       OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
       OR p_claim_token_hash !~ '^[0-9a-f]{64}$'
       OR p_claim_expires_at IS NULL
       OR p_claim_expires_at <= v_now
       OR p_claim_expires_at > v_now + INTERVAL '10 minutes'
       OR NOT public.analysis_v2_valid_launch_snapshot(p_launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(p_plan_catalog_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(p_pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(p_policy_versions_snapshot) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_INVALID_INPUT', ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_claim_hash', p_claim_token_hash, TRUE
    );
    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_idempotency_key', p_idempotency_key, TRUE
    );
    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_target_hash', p_target_input_hash, TRUE
    );

    -- Serialize the replay/create decision for one anonymous idempotency key. The
    -- advisory lock is only a coordination primitive; the partial unique index
    -- remains the database invariant.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('anonymous-preflight-idempotency:' || p_idempotency_key, 0)
    );

    SELECT preflight.* INTO v_existing
    FROM public.analysis_preflights AS preflight
      WHERE preflight.user_id IS NULL
      AND preflight.idempotency_key = p_idempotency_key
    ORDER BY preflight.created_at DESC
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.status = 'expired' OR v_existing.expires_at <= v_now THEN
            UPDATE public.analysis_preflights
            SET status = 'expired',
                claim_token_hash = NULL,
                claim_expires_at = NULL,
                lease_token = NULL,
                lease_expires_at = NULL,
                updated_at = v_now
            WHERE id = v_existing.id;
        ELSE
            IF v_existing.target_instagram_id IS DISTINCT FROM p_target_instagram_id
               OR v_existing.target_input_hash IS DISTINCT FROM p_target_input_hash
               OR v_existing.provider_selector IS DISTINCT FROM 'anonymous_apify' THEN
                RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_IDEMPOTENCY_CONFLICT', ERRCODE = 'P0001';
            END IF;
            UPDATE public.analysis_preflights
            SET claim_token_hash = p_claim_token_hash,
                claim_expires_at = p_claim_expires_at,
                updated_at = v_now
            WHERE id = v_existing.id
              AND v_existing.status IN ('pending', 'processing', 'ready', 'blocked');
            RETURN QUERY SELECT v_existing.id, v_existing.expires_at, FALSE, v_existing.status;
            RETURN;
        END IF;
    END IF;

    v_id := extensions.gen_random_uuid();
    v_expires := v_now + INTERVAL '30 minutes';
    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, access_mode, launch_status_snapshot,
        plan_catalog_snapshot, pricing_version, pricing_snapshot,
        policy_versions_snapshot, created_at, expires_at, claim_token_hash,
        claim_expires_at, target_input_hash, provider_selector
    ) VALUES (
        v_id, NULL, p_idempotency_key, p_target_instagram_id, 'pending',
        'pending', 'production', p_launch_status_snapshot,
        p_plan_catalog_snapshot, p_pricing_version, p_pricing_snapshot,
        p_policy_versions_snapshot, v_now, v_expires, p_claim_token_hash,
        p_claim_expires_at, p_target_input_hash, 'anonymous_apify'
    );
    RETURN QUERY SELECT v_id, v_expires, TRUE, 'pending'::TEXT;
END;
$$;
