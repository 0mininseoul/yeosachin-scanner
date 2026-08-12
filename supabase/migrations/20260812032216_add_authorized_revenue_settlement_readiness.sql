-- A strict Basic/Standard authorized-test replay must retain its completed
-- fresh-admission fence while the existing maintenance reconciler finalizes
-- the two preliminary Apify costs.  Otherwise the two-minute admission TTL
-- can make the route start a second fresh-admission generation before the
-- five-minute retention sweep has had a chance to settle the first one.
--
-- This is intentionally service-only and migration-first: it changes neither
-- ordinary production nor Plus admission, creates no request/provider run,
-- and leaves the revenue-ledger validation as the final write authority.

-- Close the rollout window before installing the readiness wrappers. The
-- owner-row UPDATE policy can rewrite target and economic lineage; anonymous
-- capability functions retain their independently-scoped invoker policies.
DROP POLICY IF EXISTS analysis_preflights_authenticated_owner_update
    ON public.analysis_preflights;

CREATE OR REPLACE FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_fallback public.analysis_preflight_provider_runs%ROWTYPE;
    v_fresh public.analysis_preflight_provider_runs%ROWTYPE;
    v_count INTEGER;
BEGIN
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard')
       OR p_entitlement_jti_hash IS NULL
       OR p_entitlement_jti_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_INVALID_ENTITLEMENT_INPUT',
            ERRCODE = 'P0001';
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.status = 'consumed'
       AND v_preflight.admission_generation IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    -- A concurrent consumer may have completed the exact admission between
    -- the route's snapshot read and this lock. Do not reserve a new
    -- generation; the existing consume RPC can return its durable replay.
    IF v_preflight.status = 'consumed'
       AND v_preflight.consumed_request_id IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'replayable');
    END IF;

    -- First admission and a different signed entitlement keep the existing
    -- reservation behavior. Only an exact completed admission is held here.
    IF v_preflight.status IS DISTINCT FROM 'ready'
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_status IS DISTINCT FROM 'ready'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id
       OR v_preflight.admission_entitlement_jti_hash
            IS DISTINCT FROM p_entitlement_jti_hash THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'not_applicable');
    END IF;

    -- The revenue ledger is intentionally scoped to the first fresh-admission
    -- generation. A later generation is a new provider lineage and must not
    -- be silently treated as the original two-row settlement source.
    IF v_preflight.admission_generation IS DISTINCT FROM 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.admission_token IS NULL
       OR v_preflight.admission_refreshed_at IS NULL
       OR v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.expires_at <= v_now OR v_preflight.status = 'expired' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PREFLIGHT_EXPIRED',
            ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.*
    INTO v_fallback
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
    FOR UPDATE;
    SELECT provider_run.*
    INTO v_fresh
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fresh-admission:g1'
    FOR UPDATE;
    SELECT pg_catalog.count(*)::INTEGER
    INTO v_count
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id;

    -- This is the same immutable source lineage required by the ledger. An
    -- invalid shape must never fall through to a new paid admission attempt.
    IF v_count <> 2
       OR v_fallback.preflight_id IS NULL
       OR v_fresh.preflight_id IS NULL
       OR v_fallback.status IS DISTINCT FROM 'succeeded'
       OR v_fresh.status IS DISTINCT FROM 'succeeded'
       OR v_fallback.input_hash IS NULL
       OR v_fresh.input_hash IS NULL
       OR v_fallback.input_hash !~ '^[a-f0-9]{64}$'
       OR v_fresh.input_hash !~ '^[a-f0-9]{64}$'
       OR v_fallback.input_hash IS DISTINCT FROM v_fresh.input_hash
       OR v_fallback.terminalized_at IS NULL
       OR v_fresh.terminalized_at IS NULL
       OR (v_fallback.actual_usage_usd IS NULL)
            <> (v_fallback.usage_reconciled_at IS NULL)
       OR (v_fresh.actual_usage_usd IS NULL)
            <> (v_fresh.usage_reconciled_at IS NULL) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    -- The legacy four-argument readiness path has no server-derived target
    -- proof, so a missing identity must fail closed before it can return a
    -- retryable reconciliation result. It must never derive an identity from
    -- provider evidence. A non-null target must still exactly match both
    -- immutable provider rows.
    IF v_preflight.target_input_hash IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    -- The pre-existing retention worker remains the only cost reconciler.
    -- The route returns a bounded retry response without consuming anything.
    IF v_fallback.usage_reconciled_at IS NULL
       OR v_fresh.usage_reconciled_at IS NULL THEN
        RETURN pg_catalog.jsonb_build_object('disposition', 'pending');
    END IF;

    IF v_preflight.target_input_hash !~ '^[a-f0-9]{64}$'
       OR v_fallback.input_hash IS DISTINCT FROM v_preflight.target_input_hash
       OR v_fresh.input_hash IS DISTINCT FROM v_preflight.target_input_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    -- Re-arm the exact token only after both immutable costs are settled. This
    -- does not refresh counts or collect another profile; it merely permits
    -- the established consume RPC to validate its normal short-lived fence.
    IF v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes' THEN
        UPDATE public.analysis_preflights AS preflight
        SET admission_refreshed_at = v_now,
            updated_at = v_now
        WHERE preflight.id = v_preflight.id
          AND preflight.user_id = p_user_id
          AND preflight.status = 'ready'
          AND preflight.access_mode = 'test_entitlement'
          AND preflight.admission_status = 'ready'
          AND preflight.admission_selected_plan_id = p_selected_plan_id
          AND preflight.admission_entitlement_jti_hash = p_entitlement_jti_hash
          AND preflight.admission_token = v_preflight.admission_token;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'ready',
        'admissionToken', v_preflight.admission_token
    );
END;
$$;

REVOKE ALL ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.prepare_analysis_v2_authorized_revenue_settlement_admission(
    UUID, UUID, TEXT, TEXT
) IS 'Service-only strict authorized-test fence: holds one exact fresh admission until the existing provider-cost reconciler settles immutable fallback/g1 rows, then re-arms that same token for normal consumption.';

-- The deployed reserve function normally starts a new admission after a
-- short-lived ready/blocked result expires.  For the one registered
-- Basic/Standard E2E runner and its exact signed JTI, that would turn the
-- immutable g1 cost lineage into g2 before the settlement gate can run.
-- Keep the original body private and place a narrow service-only fence before
-- its stale-generation branch.  Production, Plus, other users, and a first
-- (generation-zero) admission continue through the unchanged implementation.
ALTER FUNCTION public.reserve_analysis_v2_preflight_admission(
    UUID, UUID, TEXT, TEXT, UUID, UUID
) RENAME TO analysis_v2_reserve_preflight_admission_after_settlement_internal;

REVOKE ALL ON FUNCTION public.analysis_v2_reserve_preflight_admission_after_settlement_internal(
    UUID, UUID, TEXT, TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_preflight_admission(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT,
    p_admission_token UUID,
    p_dispatch_token UUID
)
RETURNS TABLE(
    admission_status TEXT,
    should_enqueue BOOLEAN,
    admission_generation INTEGER,
    dispatch_generation INTEGER,
    dispatch_token UUID,
    selected_plan_id TEXT,
    selected_plan_allowed BOOLEAN,
    admission_token UUID,
    admission_refreshed_at TIMESTAMP WITH TIME ZONE,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    plan_cards_snapshot JSONB,
    pricing_version TEXT,
    pricing_snapshot JSONB,
    admission_error_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_runner_plan TEXT;
    v_settlement JSONB;
    v_allowed BOOLEAN;
BEGIN
    -- Preserve the established validation and behavior until a concrete row
    -- proves this is the registered strict authorized-test lineage.
    IF p_preflight_id IS NULL
       OR p_user_id IS NULL
       OR p_selected_plan_id NOT IN ('basic', 'standard') THEN
        RETURN QUERY
        SELECT *
        FROM public.analysis_v2_reserve_preflight_admission_after_settlement_internal(
            p_preflight_id,
            p_user_id,
            p_selected_plan_id,
            p_entitlement_jti_hash,
            p_admission_token,
            p_dispatch_token
        );
        RETURN;
    END IF;

    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id
      AND preflight.user_id = p_user_id
    FOR UPDATE;
    IF NOT FOUND
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.admission_generation < 1 THEN
        RETURN QUERY
        SELECT *
        FROM public.analysis_v2_reserve_preflight_admission_after_settlement_internal(
            p_preflight_id,
            p_user_id,
            p_selected_plan_id,
            p_entitlement_jti_hash,
            p_admission_token,
            p_dispatch_token
        );
        RETURN;
    END IF;

    SELECT runner.runner_plan
    INTO v_runner_plan
    FROM public.load_e2e_test_runner_v1(p_user_id) AS runner;
    IF v_runner_plan IS NULL
       OR v_runner_plan NOT IN ('basic', 'standard') THEN
        RETURN QUERY
        SELECT *
        FROM public.analysis_v2_reserve_preflight_admission_after_settlement_internal(
            p_preflight_id,
            p_user_id,
            p_selected_plan_id,
            p_entitlement_jti_hash,
            p_admission_token,
            p_dispatch_token
        );
        RETURN;
    END IF;

    -- Once a registered Basic/Standard runner has a g1, no different signed
    -- entitlement or plan may reach the legacy stale-admission branch. That
    -- branch creates a new provider generation before later consumption can
    -- reject the mismatched capability. Exact identity may still replay the
    -- durable result below; all mismatch cases fence before any enqueue.
    IF p_entitlement_jti_hash IS NULL
       OR p_entitlement_jti_hash !~ '^[a-f0-9]{64}$'
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_runner_plan
       OR v_preflight.admission_entitlement_jti_hash
            IS DISTINCT FROM p_entitlement_jti_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
            ERRCODE = 'P0001';
    END IF;

    IF v_preflight.consumed_request_id IS NOT NULL THEN
        RETURN QUERY
        SELECT *
        FROM public.analysis_v2_reserve_preflight_admission_after_settlement_internal(
            p_preflight_id,
            p_user_id,
            p_selected_plan_id,
            p_entitlement_jti_hash,
            p_admission_token,
            p_dispatch_token
        );
        RETURN;
    END IF;

    -- A later generation has no ledger-authorized source lineage. Do not
    -- enqueue or create g3 while a migration-first route is still draining.
    IF v_preflight.admission_generation IS DISTINCT FROM 1 THEN
        RETURN QUERY SELECT
            'pending'::TEXT,
            FALSE,
            v_preflight.admission_generation,
            GREATEST(v_preflight.admission_dispatch_generation, 1),
            NULL::UUID,
            p_selected_plan_id,
            NULL::BOOLEAN,
            NULL::UUID,
            NULL::TIMESTAMP WITH TIME ZONE,
            NULL::INTEGER,
            NULL::INTEGER,
            NULL::TEXT,
            NULL::TEXT,
            NULL::JSONB,
            v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,
            NULL::TEXT;
        RETURN;
    END IF;

    -- A proven blocked g1 is terminal. Replaying its stored outcome is safe;
    -- replacing it with g2 would recollect and destroy the ledger fence.
    IF v_preflight.admission_status = 'blocked' THEN
        RETURN QUERY SELECT
            'blocked'::TEXT,
            FALSE,
            v_preflight.admission_generation,
            GREATEST(v_preflight.admission_dispatch_generation, 1),
            NULL::UUID,
            p_selected_plan_id,
            NULL::BOOLEAN,
            NULL::UUID,
            v_preflight.admission_refreshed_at,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_capacity_required_plan_id,
            v_preflight.admission_required_plan_id,
            v_preflight.admission_plan_cards_snapshot,
            v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,
            v_preflight.admission_error_code;
        RETURN;
    END IF;

    -- This turns the migration-first old-route path into its existing pending
    -- response before it reaches the authorized consume RPC. After settlement
    -- the same helper re-arms and returns the existing token, never a caller
    -- supplied replacement and never a new provider generation.
    IF v_preflight.admission_status = 'ready' THEN
        v_settlement := public.prepare_analysis_v2_authorized_revenue_settlement_admission(
            p_preflight_id,
            p_user_id,
            p_selected_plan_id,
            p_entitlement_jti_hash
        );
        IF v_settlement->>'disposition' = 'pending' THEN
            RETURN QUERY SELECT
                'pending'::TEXT,
                FALSE,
                v_preflight.admission_generation,
                GREATEST(v_preflight.admission_dispatch_generation, 1),
                NULL::UUID,
                p_selected_plan_id,
                NULL::BOOLEAN,
                NULL::UUID,
                NULL::TIMESTAMP WITH TIME ZONE,
                NULL::INTEGER,
                NULL::INTEGER,
                NULL::TEXT,
                NULL::TEXT,
                NULL::JSONB,
                v_preflight.pricing_version::TEXT,
                v_preflight.pricing_snapshot,
                NULL::TEXT;
            RETURN;
        END IF;
        IF v_settlement->>'disposition' IS DISTINCT FROM 'ready' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                ERRCODE = 'P0001';
        END IF;

        SELECT preflight.*
        INTO v_preflight
        FROM public.analysis_preflights AS preflight
        WHERE preflight.id = p_preflight_id
          AND preflight.user_id = p_user_id
        FOR UPDATE;
        v_allowed := v_preflight.admission_plan_cards_snapshot
            ->p_selected_plan_id->>'selectionState'
            IN ('required', 'available_upgrade');
        IF v_preflight.admission_status IS DISTINCT FROM 'ready'
           OR v_preflight.admission_generation IS DISTINCT FROM 1
           OR v_preflight.admission_selected_plan_id IS DISTINCT FROM p_selected_plan_id
           OR v_preflight.admission_entitlement_jti_hash
                IS DISTINCT FROM p_entitlement_jti_hash
           OR v_preflight.admission_token
                IS DISTINCT FROM (v_settlement->>'admissionToken')::UUID
           OR v_preflight.admission_refreshed_at IS NULL
           OR v_allowed IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT
            'ready'::TEXT,
            FALSE,
            v_preflight.admission_generation,
            GREATEST(v_preflight.admission_dispatch_generation, 1),
            NULL::UUID,
            p_selected_plan_id,
            TRUE,
            v_preflight.admission_token,
            v_preflight.admission_refreshed_at,
            v_preflight.admission_target_followers_count,
            v_preflight.admission_target_following_count,
            v_preflight.admission_capacity_required_plan_id,
            v_preflight.admission_required_plan_id,
            v_preflight.admission_plan_cards_snapshot,
            v_preflight.pricing_version::TEXT,
            v_preflight.pricing_snapshot,
            NULL::TEXT;
        RETURN;
    END IF;

    -- Pending/processing g1 retains the original dispatch-recovery behavior:
    -- it may resume that same provider intent but cannot create g2.
    RETURN QUERY
    SELECT *
    FROM public.analysis_v2_reserve_preflight_admission_after_settlement_internal(
        p_preflight_id,
        p_user_id,
        p_selected_plan_id,
        p_entitlement_jti_hash,
        p_admission_token,
        p_dispatch_token
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_preflight_admission(
    UUID, UUID, TEXT, TEXT, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_preflight_admission(
    UUID, UUID, TEXT, TEXT, UUID, UUID
) TO service_role;

-- Migration-first defense in depth. During rollout an older route instance
-- may still call the authorized consume RPC directly. The additive gate
-- below makes that legacy path fail closed while the existing reconciler is
-- pending, and reuses the exact token returned by the readiness RPC after
-- settlement. Consumed rows remain replayable and Plus/ordinary paths do not
-- enter this branch.
CREATE OR REPLACE FUNCTION public.consume_analysis_v2_authorized_test_entitlement(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT,
    p_admission_token UUID,
    p_target_instagram_id TEXT,
    p_policy_version TEXT,
    p_operation_slot_map JSONB
)
RETURNS TABLE(
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT,
    request_status TEXT,
    background_processing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_consumed RECORD;
    v_settlement JSONB;
BEGIN
    IF p_selected_plan_id IN ('basic', 'standard')
       AND p_policy_version IS NOT DISTINCT FROM 'authorized-free-e2e-v1' THEN
        -- Keep the lock order identical to the base consume RPC
        -- (JTI advisory lock -> user row -> preflight row). The readiness
        -- helper then takes the already-owned preflight lock reentrantly,
        -- so it cannot form a preflight -> JTI cycle with a concurrent
        -- base consume/replay.
        IF p_entitlement_jti_hash IS NOT NULL
           AND p_entitlement_jti_hash ~ '^[a-f0-9]{64}$' THEN
            PERFORM pg_catalog.pg_advisory_xact_lock(
                pg_catalog.hashtextextended(p_entitlement_jti_hash, 0)
            );
            PERFORM 1
            FROM public.users AS account
            WHERE account.id = p_user_id
            FOR UPDATE;
        END IF;

        v_settlement := public.prepare_analysis_v2_authorized_revenue_settlement_admission(
            p_preflight_id,
            p_user_id,
            p_selected_plan_id,
            p_entitlement_jti_hash
        );
        IF v_settlement->>'disposition' = 'pending' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_PENDING',
                ERRCODE = 'P0001';
        ELSIF v_settlement->>'disposition' = 'ready' THEN
            -- A caller supplied token is part of the signed admission
            -- capability. Never replace it with the canonical DB token:
            -- demand an exact match before handing off to base consumption.
            IF p_admission_token IS DISTINCT FROM (v_settlement->>'admissionToken')::UUID THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                    ERRCODE = 'P0001';
            END IF;
        ELSIF v_settlement->>'disposition' NOT IN ('not_applicable', 'replayable') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_REVENUE_SETTLEMENT_FENCE',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT consumed.*
    INTO v_consumed
    FROM public.consume_analysis_v2_test_entitlement(
        p_preflight_id,
        p_user_id,
        p_selected_plan_id,
        p_entitlement_jti_hash,
        p_admission_token
    ) AS consumed;

    PERFORM public.bind_analysis_v2_authorized_test_provider_policy(
        v_consumed.request_id,
        p_user_id,
        p_entitlement_jti_hash,
        p_target_instagram_id,
        p_policy_version,
        p_operation_slot_map
    );

    RETURN QUERY SELECT
        v_consumed.request_id::UUID,
        v_consumed.created::BOOLEAN,
        v_consumed.initial_job_key::TEXT,
        v_consumed.request_status::TEXT,
        v_consumed.background_processing::BOOLEAN;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_analysis_v2_authorized_test_entitlement(
    UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_analysis_v2_authorized_test_entitlement(
    UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) TO service_role;

-- PostgREST caches RPC metadata. Reload it in the same forward migration so
-- the additive service-only signatures and grants are visible before the app
-- rollout proceeds. A failed rollout is recovered by endpoint quiesce/app
-- rollback followed by a later forward migration; this DB fence is not
-- rolled back in place.
NOTIFY pgrst, 'reload schema';
