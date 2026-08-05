-- Anonymous preflight is a narrow profile-summary exception. It never creates an
-- analysis request or an order until a signed claim is consumed after OAuth.
ALTER TABLE public.analysis_preflights
    ALTER COLUMN user_id DROP NOT NULL,
    ADD COLUMN IF NOT EXISTS claim_token_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS target_input_hash VARCHAR(64),
    ADD COLUMN IF NOT EXISTS provider_selector TEXT NOT NULL DEFAULT 'selfhosted_auth';

ALTER TABLE public.analysis_preflights
    ADD CONSTRAINT analysis_preflights_claim_shape_check CHECK (
        (claim_token_hash IS NULL AND claim_expires_at IS NULL)
        OR (
            claim_token_hash ~ '^[0-9a-f]{64}$'
            AND claim_expires_at IS NOT NULL
        )
    ),
    ADD CONSTRAINT analysis_preflights_provider_selector_check CHECK (
        provider_selector IN ('selfhosted_auth', 'anonymous_apify')
    ),
    ADD CONSTRAINT analysis_preflights_target_hash_check CHECK (
        target_input_hash IS NULL OR target_input_hash ~ '^[0-9a-f]{64}$'
    );

-- The table used to be service-role-only. The browser-facing owner and anonymous
-- reads/writes now go through this table's RLS boundary; worker/control-plane RPCs
-- below remain service-owned. Anonymous access is transaction-bound to a hash that
-- the signed-claim RPC places in a local custom GUC, never to a raw token or target.
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_preflights TO anon, authenticated;

CREATE POLICY analysis_preflights_authenticated_owner_select
    ON public.analysis_preflights
    FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = user_id);

CREATE POLICY analysis_preflights_authenticated_owner_update
    ON public.analysis_preflights
    FOR UPDATE TO authenticated
    USING ((SELECT auth.uid()) = user_id)
    WITH CHECK ((SELECT auth.uid()) = user_id);

CREATE POLICY analysis_preflights_anonymous_claim_select
    ON public.analysis_preflights
    FOR SELECT TO anon, authenticated
    USING (
        user_id IS NULL
        AND provider_selector = 'anonymous_apify'
        AND (
            (
                claim_token_hash = NULLIF(
                    pg_catalog.current_setting('app.anonymous_preflight_claim_hash', TRUE),
                    ''
                )
                AND claim_expires_at > pg_catalog.clock_timestamp()
            )
            OR idempotency_key = NULLIF(
                pg_catalog.current_setting('app.anonymous_preflight_idempotency_key', TRUE),
                ''
            )
        )
    );

CREATE POLICY analysis_preflights_anonymous_insert
    ON public.analysis_preflights
    FOR INSERT TO anon, authenticated
    WITH CHECK (
        user_id IS NULL
        AND provider_selector = 'anonymous_apify'
        AND target_input_hash = NULLIF(
            pg_catalog.current_setting('app.anonymous_preflight_target_hash', TRUE),
            ''
        )
        AND idempotency_key = NULLIF(
            pg_catalog.current_setting('app.anonymous_preflight_idempotency_key', TRUE),
            ''
        )
        AND claim_token_hash = NULLIF(
            pg_catalog.current_setting('app.anonymous_preflight_claim_hash', TRUE),
            ''
        )
        AND claim_expires_at > pg_catalog.clock_timestamp()
    );

CREATE POLICY analysis_preflights_anonymous_update
    ON public.analysis_preflights
    FOR UPDATE TO anon, authenticated
    USING (
        user_id IS NULL
        AND provider_selector = 'anonymous_apify'
        AND (
            (
                claim_token_hash = NULLIF(
                    pg_catalog.current_setting('app.anonymous_preflight_claim_hash', TRUE),
                    ''
                )
                AND claim_expires_at > pg_catalog.clock_timestamp()
            )
            OR idempotency_key = NULLIF(
                pg_catalog.current_setting('app.anonymous_preflight_idempotency_key', TRUE),
                ''
            )
        )
    )
    WITH CHECK (
        user_id IS NULL
        AND provider_selector = 'anonymous_apify'
        AND (
            claim_token_hash = NULLIF(
                pg_catalog.current_setting('app.anonymous_preflight_claim_hash', TRUE),
                ''
            )
            OR idempotency_key = NULLIF(
                pg_catalog.current_setting('app.anonymous_preflight_idempotency_key', TRUE),
                ''
            )
        )
    );

-- Ownership transfer is a separate policy: the old row is anonymous, while the
-- new row must be owned by the authenticated caller and must have consumed the
-- claim material. The claim RPC also checks auth.uid() explicitly.
CREATE POLICY analysis_preflights_authenticated_claim_update
    ON public.analysis_preflights
    FOR UPDATE TO authenticated
    USING (
        user_id IS NULL
        AND provider_selector = 'anonymous_apify'
        AND claim_token_hash = NULLIF(
            pg_catalog.current_setting('app.anonymous_preflight_claim_hash', TRUE),
            ''
        )
        AND claim_expires_at > pg_catalog.clock_timestamp()
    )
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND provider_selector = 'anonymous_apify'
        AND claim_token_hash IS NULL
        AND claim_expires_at IS NULL
    );

COMMENT ON TABLE public.analysis_preflights IS
    'RLS-protected V2 preflight. Authenticated owners and signed anonymous claims may read their bounded status; workers remain service-owned.';

CREATE INDEX analysis_preflights_anonymous_target_idx
    ON public.analysis_preflights(target_input_hash, created_at DESC)
    WHERE provider_selector = 'anonymous_apify';

-- The existing (user_id, idempotency_key) index does not constrain NULL user IDs.
-- Keep anonymous retries single-row even when two requests arrive concurrently.
CREATE UNIQUE INDEX analysis_preflights_anonymous_idempotency_idx
    ON public.analysis_preflights(idempotency_key)
    WHERE user_id IS NULL
      AND status IN ('pending', 'processing', 'ready', 'blocked');

CREATE TABLE public.analysis_anonymous_profile_cache (
    target_input_hash VARCHAR(64) PRIMARY KEY,
    profile_summary JSONB NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_anonymous_profile_cache_hash_check CHECK (
        target_input_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_anonymous_profile_cache_shape_check CHECK (
        jsonb_typeof(profile_summary) = 'object'
    )
);

-- A cache row is created only after a provider response exists, so a missing row
-- cannot itself be used as a cross-instance single-flight lock. Keep the lock
-- separate and keyed only by the opaque target hash.
CREATE TABLE public.analysis_anonymous_profile_cache_locks (
    target_input_hash VARCHAR(64) PRIMARY KEY,
    lease_token UUID NOT NULL,
    lease_expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_anonymous_profile_cache_lock_hash_check CHECK (
        target_input_hash ~ '^[0-9a-f]{64}$'
    )
);

CREATE TABLE public.analysis_anonymous_preflight_attempts (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    ip_hash VARCHAR(64) NOT NULL,
    device_hash VARCHAR(64) NOT NULL,
    target_input_hash VARCHAR(64) NOT NULL,
    preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE SET NULL,
    occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_anonymous_attempt_ip_check CHECK (ip_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT analysis_anonymous_attempt_device_check CHECK (device_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT analysis_anonymous_attempt_target_check CHECK (target_input_hash ~ '^[0-9a-f]{64}$')
);

CREATE INDEX analysis_anonymous_attempts_ip_idx
    ON public.analysis_anonymous_preflight_attempts(ip_hash, occurred_at DESC);
CREATE INDEX analysis_anonymous_attempts_device_idx
    ON public.analysis_anonymous_preflight_attempts(device_hash, occurred_at DESC);
CREATE INDEX analysis_anonymous_attempts_day_idx
    ON public.analysis_anonymous_preflight_attempts(occurred_at);

ALTER TABLE public.analysis_anonymous_profile_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_anonymous_profile_cache_locks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_anonymous_preflight_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_anonymous_profile_cache,
    public.analysis_anonymous_profile_cache_locks,
    public.analysis_anonymous_preflight_attempts
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analysis_anonymous_profile_cache
    TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.analysis_anonymous_profile_cache_locks
    TO service_role;
GRANT INSERT, SELECT, UPDATE ON TABLE public.analysis_anonymous_preflight_attempts
    TO service_role;

CREATE OR REPLACE FUNCTION public.claim_anonymous_profile_cache_lock(
    p_target_input_hash VARCHAR(64),
    p_lease_token UUID,
    p_lease_seconds INTEGER DEFAULT 60
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_rows INTEGER;
BEGIN
    IF p_target_input_hash !~ '^[0-9a-f]{64}$'
       OR p_lease_token IS NULL
       OR p_lease_seconds IS NULL
       OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PROFILE_CACHE_INVALID_LOCK_INPUT', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_anonymous_profile_cache_locks(
        target_input_hash, lease_token, lease_expires_at
    ) VALUES (
        p_target_input_hash,
        p_lease_token,
        v_now + make_interval(secs => p_lease_seconds)
    ) ON CONFLICT (target_input_hash) DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 1 THEN RETURN TRUE; END IF;

    UPDATE public.analysis_anonymous_profile_cache_locks
    SET lease_token = p_lease_token,
        lease_expires_at = v_now + make_interval(secs => p_lease_seconds)
    WHERE target_input_hash = p_target_input_hash
      AND lease_expires_at <= v_now;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RETURN v_rows = 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_anonymous_profile_cache_lock(
    p_target_input_hash VARCHAR(64),
    p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, extensions
AS $$
    DELETE FROM public.analysis_anonymous_profile_cache_locks
    WHERE target_input_hash = p_target_input_hash
      AND lease_token = p_lease_token
    RETURNING TRUE;
$$;

CREATE OR REPLACE FUNCTION public.reserve_anonymous_preflight_budget(
    p_ip_hash VARCHAR(64),
    p_device_hash VARCHAR(64),
    p_target_input_hash VARCHAR(64),
    p_daily_limit INTEGER DEFAULT 300
)
RETURNS TABLE(allowed BOOLEAN, reason TEXT, daily_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_daily_count INTEGER;
    v_actor_count INTEGER;
BEGIN
    IF p_ip_hash !~ '^[0-9a-f]{64}$'
       OR p_device_hash !~ '^[0-9a-f]{64}$'
       OR p_target_input_hash !~ '^[0-9a-f]{64}$'
       OR p_daily_limit IS NULL OR p_daily_limit < 1 OR p_daily_limit > 10000 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_INVALID_BUDGET_INPUT', ERRCODE = 'P0001';
    END IF;
    SELECT COUNT(*)::INTEGER INTO v_daily_count
    FROM public.analysis_anonymous_preflight_attempts
    WHERE occurred_at >= date_trunc('day', v_now);
    IF v_daily_count >= p_daily_limit THEN
        RETURN QUERY SELECT FALSE, 'daily_cap'::TEXT, v_daily_count;
        RETURN;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('anonymous-preflight-daily-budget', 0)
    );
    SELECT COUNT(*)::INTEGER INTO v_daily_count
    FROM public.analysis_anonymous_preflight_attempts
    WHERE occurred_at >= date_trunc('day', v_now);
    IF v_daily_count >= p_daily_limit THEN
        RETURN QUERY SELECT FALSE, 'daily_cap'::TEXT, v_daily_count;
        RETURN;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_ip_hash || ':' || p_device_hash, 0)
    );
    SELECT COUNT(*)::INTEGER INTO v_actor_count
    FROM public.analysis_anonymous_preflight_attempts
    WHERE occurred_at >= v_now - INTERVAL '10 minutes'
      AND (ip_hash = p_ip_hash OR device_hash = p_device_hash);
    IF v_actor_count >= 5 THEN
        RETURN QUERY SELECT FALSE, 'rate_limited'::TEXT, v_daily_count;
        RETURN;
    END IF;
    INSERT INTO public.analysis_anonymous_preflight_attempts(
        ip_hash, device_hash, target_input_hash
    ) VALUES (p_ip_hash, p_device_hash, p_target_input_hash);
    RETURN QUERY SELECT TRUE, 'accepted'::TEXT, v_daily_count + 1;
END;
$$;

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
    -- above remains the database invariant.
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
        policy_versions_snapshot, expires_at, claim_token_hash,
        claim_expires_at, target_input_hash, provider_selector
    ) VALUES (
        v_id, NULL, p_idempotency_key, p_target_instagram_id, 'pending',
        'pending', 'production', p_launch_status_snapshot,
        p_plan_catalog_snapshot, p_pricing_version, p_pricing_snapshot,
        p_policy_versions_snapshot, v_expires, p_claim_token_hash,
        p_claim_expires_at, p_target_input_hash, 'anonymous_apify'
    );
    RETURN QUERY SELECT v_id, v_expires, TRUE, 'pending'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.read_anonymous_analysis_v2_preflight(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64)
)
RETURNS SETOF public.analysis_preflights
LANGUAGE SQL
SECURITY DEFINER
SET search_path = public, extensions
AS $$
    SELECT preflight.*
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id IS NULL
      AND preflight.claim_token_hash = p_claim_token_hash
      AND preflight.claim_expires_at > pg_catalog.clock_timestamp();
$$;

-- Public status reads intentionally return a safe projection. In particular, the
-- raw provider image URL, claim material, input hash, lease, and dispatch fields
-- never cross the anonymous RPC boundary.
CREATE OR REPLACE FUNCTION public.read_anonymous_analysis_v2_preflight_public(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64)
)
RETURNS TABLE(
    id UUID,
    status TEXT,
    expires_at TIMESTAMP WITH TIME ZONE,
    error_code TEXT,
    target_instagram_id VARCHAR(30),
    target_full_name VARCHAR(200),
    target_bio VARCHAR(2200),
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    access_mode TEXT,
    launch_status_snapshot JSONB,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    plan_cards_snapshot JSONB,
    pricing_version VARCHAR(64),
    pricing_snapshot JSONB,
    exclusion_decision TEXT
)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token_hash !~ '^[0-9a-f]{64}$' THEN
        RETURN;
    END IF;
    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_claim_hash', p_claim_token_hash, TRUE
    );
    RETURN QUERY
    SELECT
        preflight.id,
        preflight.status,
        preflight.expires_at,
        preflight.error_code,
        preflight.target_instagram_id,
        preflight.target_full_name,
        preflight.target_bio,
        preflight.target_followers_count,
        preflight.target_following_count,
        preflight.target_is_private,
        preflight.access_mode,
        preflight.launch_status_snapshot,
        preflight.capacity_required_plan_id,
        preflight.required_plan_id,
        preflight.plan_cards_snapshot,
        preflight.pricing_version,
        preflight.pricing_snapshot,
        preflight.exclusion_decision
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id IS NULL
      AND preflight.provider_selector = 'anonymous_apify'
      AND preflight.claim_token_hash = p_claim_token_hash
      AND preflight.claim_expires_at > pg_catalog.clock_timestamp();
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_anonymous_analysis_v2_preflight(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64),
    p_user_id UUID
)
RETURNS TABLE(claimed BOOLEAN, preflight_status TEXT)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token_hash !~ '^[0-9a-f]{64}$'
       OR p_user_id IS NULL
       OR (SELECT auth.uid()) IS DISTINCT FROM p_user_id THEN
        RETURN QUERY SELECT FALSE, 'invalid'::TEXT;
        RETURN;
    END IF;
    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_claim_hash', p_claim_token_hash, TRUE
    );
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
      -- Ownership transfer is allowed only after the anonymous worker has
      -- terminalized the profile snapshot. A mid-worker transfer would make
      -- the worker's anonymous completion fence fail closed.
      AND status IN ('ready', 'blocked');
    IF FOUND THEN
        RETURN QUERY SELECT TRUE, 'claimed'::TEXT;
    ELSE
        RETURN QUERY SELECT FALSE, 'rejected'::TEXT;
    END IF;
END;
$$;

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
      AND status = 'ready'
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

-- Authenticated owner PATCHes use an invoker RPC so the owner RLS policy, rather
-- than a service-role read/update, is the authority. The beta boolean self-check
-- remains the only beta table surface exposed to an authenticated caller.
CREATE OR REPLACE FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(
    p_preflight_id UUID,
    p_user_id UUID,
    p_decision TEXT,
    p_excluded_instagram_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_excluded_instagram_id TEXT;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR (SELECT auth.uid()) IS DISTINCT FROM p_user_id
       OR p_decision NOT IN ('exclude', 'skip') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
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

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = (SELECT auth.uid())
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    IF v_preflight.beta_entry_provenance IS NOT NULL
       AND NOT public.analysis_beta_has_access() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_ACCESS_UNAVAILABLE', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.exclusion_decision = p_decision
       AND v_preflight.excluded_instagram_id IS NOT DISTINCT FROM v_excluded_instagram_id THEN
        RETURN FALSE;
    END IF;
    IF v_preflight.exclusion_decision <> 'pending' THEN
        RAISE EXCEPTION USING MESSAGE = 'PREFLIGHT_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_EXPIRED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status = 'consumed' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_CONSUMED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status NOT IN ('pending', 'processing', 'ready') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE = 'P0001';
    END IF;
    IF p_decision = 'exclude'
       AND v_excluded_instagram_id = v_preflight.target_instagram_id THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_EXCLUSION', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights
    SET exclusion_decision = p_decision,
        excluded_instagram_id = v_excluded_instagram_id,
        exclusion_decided_at = v_now,
        updated_at = v_now
    WHERE id = v_preflight.id
      AND exclusion_decision = 'pending';
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'PREFLIGHT_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    RETURN TRUE;
END;
$$;

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
    UPDATE public.analysis_preflights
    SET dispatch_generation = dispatch_generation + 1,
        dispatch_state = 'reserved',
        dispatch_token = p_dispatch_token,
        dispatch_reserved_at = v_now,
        updated_at = v_now
    WHERE id = p_preflight_id;
    RETURN QUERY SELECT TRUE, v_preflight.dispatch_generation + 1, p_dispatch_token, v_preflight.status;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_anonymous_analysis_v2_preflight_dispatched(
    p_preflight_id UUID,
    p_claim_token_hash VARCHAR(64),
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions
AS $$
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token_hash !~ '^[0-9a-f]{64}$'
       OR p_dispatch_token IS NULL THEN
        RETURN FALSE;
    END IF;
    PERFORM pg_catalog.set_config(
        'app.anonymous_preflight_claim_hash', p_claim_token_hash, TRUE
    );
    UPDATE public.analysis_preflights
    SET dispatch_state = 'enqueued',
        dispatch_token = NULL,
        dispatched_at = COALESCE(dispatched_at, pg_catalog.clock_timestamp()),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = p_preflight_id
      AND user_id IS NULL
      AND claim_token_hash = p_claim_token_hash
      AND dispatch_generation = p_dispatch_generation
      AND dispatch_token = p_dispatch_token
      AND dispatch_state = 'reserved'
    ;
    RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_anonymous_preflight_budget(VARCHAR, VARCHAR, VARCHAR, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_anonymous_preflight_budget(VARCHAR, VARCHAR, VARCHAR, INTEGER)
    TO service_role;
REVOKE ALL ON FUNCTION public.claim_anonymous_profile_cache_lock(VARCHAR, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_anonymous_profile_cache_lock(VARCHAR, UUID, INTEGER)
    TO service_role;
REVOKE ALL ON FUNCTION public.release_anonymous_profile_cache_lock(VARCHAR, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.release_anonymous_profile_cache_lock(VARCHAR, UUID)
    TO service_role;

-- These validators are immutable, bounded shape checks used by the invoker create
-- RPC. They reveal no table data and therefore may be called by the two public DB
-- roles without opening a data read surface.
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
    TO anon, authenticated;

REVOKE ALL ON FUNCTION public.create_anonymous_analysis_v2_preflight(
    TEXT, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ, JSONB, JSONB, VARCHAR, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_anonymous_analysis_v2_preflight(
    TEXT, VARCHAR, VARCHAR, VARCHAR, TIMESTAMPTZ, JSONB, JSONB, VARCHAR, JSONB, JSONB
) TO anon, authenticated;
REVOKE ALL ON FUNCTION public.read_anonymous_analysis_v2_preflight(UUID, VARCHAR)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_anonymous_analysis_v2_preflight(UUID, VARCHAR)
    TO service_role;
REVOKE ALL ON FUNCTION public.read_anonymous_analysis_v2_preflight_public(UUID, VARCHAR)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_anonymous_analysis_v2_preflight_public(UUID, VARCHAR)
    TO anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_anonymous_analysis_v2_preflight(UUID, VARCHAR, UUID)
    TO authenticated;
REVOKE ALL ON FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(UUID, VARCHAR, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_anonymous_analysis_v2_preflight_exclusion(UUID, VARCHAR, TEXT, TEXT)
    TO anon, authenticated;
REVOKE ALL ON FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_authenticated_analysis_v2_preflight_exclusion(UUID, UUID, TEXT, TEXT)
    TO authenticated;
REVOKE ALL ON FUNCTION public.reserve_anonymous_analysis_v2_preflight_dispatch(UUID, VARCHAR, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_anonymous_analysis_v2_preflight_dispatch(UUID, VARCHAR, UUID)
    TO anon, authenticated;
REVOKE ALL ON FUNCTION public.mark_anonymous_analysis_v2_preflight_dispatched(UUID, VARCHAR, INTEGER, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.mark_anonymous_analysis_v2_preflight_dispatched(UUID, VARCHAR, INTEGER, UUID)
    TO anon, authenticated;

-- The authenticated completion/block RPCs deliberately require a user UUID. Anonymous
-- workers use these parallel fences until the signed claim is consumed after OAuth.
CREATE OR REPLACE FUNCTION public.complete_anonymous_analysis_v2_preflight(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_target_full_name TEXT,
    p_target_bio TEXT,
    p_target_profile_image_url TEXT,
    p_target_followers_count INTEGER,
    p_target_following_count INTEGER,
    p_target_is_private BOOLEAN,
    p_capacity_required_plan_id TEXT,
    p_required_plan_id TEXT,
    p_plan_cards_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_plan_id TEXT;
    v_capacity JSONB;
    v_capacity_rank INTEGER;
    v_required_rank INTEGER;
    v_loop_rank INTEGER := 0;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_target_is_private IS DISTINCT FROM FALSE
       OR p_target_followers_count IS NULL
       OR p_target_following_count IS NULL
       OR p_target_followers_count < 0
       OR p_target_followers_count > 10000000
       OR p_target_following_count < 0
       OR p_target_following_count > 10000000
       OR p_capacity_required_plan_id IS NULL
       OR p_capacity_required_plan_id NOT IN ('basic', 'standard', 'plus')
       OR p_required_plan_id IS NULL
       OR p_required_plan_id NOT IN ('basic', 'standard', 'plus')
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(p_plan_cards_snapshot)
       OR (p_target_full_name IS NOT NULL AND pg_catalog.char_length(p_target_full_name) > 200)
       OR (p_target_bio IS NOT NULL AND pg_catalog.char_length(p_target_bio) > 2200)
       OR (
           p_target_profile_image_url IS NOT NULL
           AND (
               pg_catalog.char_length(p_target_profile_image_url) > 8192
               OR p_target_profile_image_url !~* '^https://'
           )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_INVALID_READY_SNAPSHOT', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id IS NULL
      AND preflight.provider_selector = 'anonymous_apify'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_EXPIRED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status = 'ready' THEN
        RETURN FALSE;
    END IF;
    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_LEASE_LOST', ERRCODE = 'P0001';
    END IF;

    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        IF p_plan_cards_snapshot->v_plan_id->>'launchStatus'
                IS DISTINCT FROM v_preflight.launch_status_snapshot->>v_plan_id
           OR p_plan_cards_snapshot->v_plan_id->'relationshipCapacity'
                IS DISTINCT FROM v_preflight.plan_catalog_snapshot->v_plan_id->'relationshipCapacity'
           OR p_plan_cards_snapshot->v_plan_id->>'detailedMutualLimit'
                IS DISTINCT FROM v_preflight.plan_catalog_snapshot->v_plan_id->>'detailedMutualLimit' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
        END IF;
    END LOOP;

    v_capacity_rank := CASE p_capacity_required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
    v_required_rank := CASE p_required_plan_id
        WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
    IF v_required_rank < v_capacity_rank
       OR p_plan_cards_snapshot->p_required_plan_id->>'selectionState' <> 'required'
       OR p_plan_cards_snapshot->p_required_plan_id->>'launchStatus' <> 'production' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;

    v_capacity := p_plan_cards_snapshot->p_capacity_required_plan_id->'relationshipCapacity';
    IF p_target_followers_count > (v_capacity->>'followers')::INTEGER
       OR p_target_following_count > (v_capacity->>'following')::INTEGER THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
    END IF;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_loop_rank := v_loop_rank + 1;
        EXIT WHEN v_loop_rank >= v_capacity_rank;
        v_capacity := p_plan_cards_snapshot->v_plan_id->'relationshipCapacity';
        IF p_target_followers_count <= (v_capacity->>'followers')::INTEGER
           AND p_target_following_count <= (v_capacity->>'following')::INTEGER THEN
            RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_PLAN_NOT_ALLOWED', ERRCODE = 'P0001';
        END IF;
    END LOOP;

    UPDATE public.analysis_preflights
    SET status = 'ready',
        target_full_name = p_target_full_name,
        target_bio = p_target_bio,
        target_profile_image_url = p_target_profile_image_url,
        target_followers_count = p_target_followers_count,
        target_following_count = p_target_following_count,
        target_is_private = FALSE,
        capacity_required_plan_id = p_capacity_required_plan_id,
        required_plan_id = p_required_plan_id,
        plan_cards_snapshot = p_plan_cards_snapshot,
        ready_at = v_now,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE id = v_preflight.id;
    RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_anonymous_analysis_v2_preflight(
    p_preflight_id UUID,
    p_claim_token UUID,
    p_error_code TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    IF p_preflight_id IS NULL
       OR p_claim_token IS NULL
       OR p_error_code IS NULL
       OR p_error_code NOT IN (
           'TARGET_NOT_FOUND', 'TARGET_PRIVATE', 'TARGET_UNSUPPORTED',
           'OVER_PLUS_CAPACITY', 'EXCLUSION_REQUIRED', 'INVALID_EXCLUSION',
           'PLAN_UPGRADE_REQUIRED', 'RELATIONSHIP_INCOMPLETE',
           'PROFILE_EVIDENCE_INCOMPLETE', 'QUEUE_UNAVAILABLE', 'AI_RATE_LIMITED',
           'AI_AMBIGUOUS_RESULT', 'ANALYSIS_FAILED'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_INVALID_BLOCK_INPUT', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id IS NULL
      AND preflight.provider_selector = 'anonymous_apify'
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_EXPIRED', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status = 'blocked' THEN
        IF v_preflight.error_code = p_error_code THEN RETURN FALSE; END IF;
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_BLOCK_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.status <> 'processing'
       OR v_preflight.lease_token IS DISTINCT FROM p_claim_token
       OR v_preflight.lease_expires_at IS NULL
       OR v_preflight.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANONYMOUS_PREFLIGHT_LEASE_LOST', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_preflights
    SET status = 'blocked',
        error_code = p_error_code,
        blocked_at = v_now,
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now
    WHERE id = v_preflight.id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_anonymous_analysis_v2_preflight(
    UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_anonymous_analysis_v2_preflight(
    UUID, UUID, TEXT, TEXT, TEXT, INTEGER, INTEGER, BOOLEAN, TEXT, TEXT, JSONB
) TO service_role;
REVOKE ALL ON FUNCTION public.block_anonymous_analysis_v2_preflight(UUID, UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.block_anonymous_analysis_v2_preflight(UUID, UUID, TEXT)
    TO service_role;
