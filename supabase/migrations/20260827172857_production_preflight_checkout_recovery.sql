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

    -- Match the checkout create RPC's lock order: take the owner advisory lock
    -- before the users row lock and any preflight row lock. Claim/create
    -- transactions therefore cannot acquire the users and advisory locks in
    -- opposite orders.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'analysis-anonymous-preflight:' || p_user_id::TEXT,
            0
        )
    );

    PERFORM 1
    FROM public.users AS owner_user
    WHERE owner_user.id = p_user_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RETURN QUERY SELECT FALSE, 'invalid'::TEXT, NULL::UUID;
        RETURN;
    END IF;

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

-- A pending order remains payment truth, even when a newer checkout attempt
-- makes its checkout lineage unusable. Keep that disposition on the order so
-- it survives preflight expiry, consumption, scrubbing, and retention of the
-- newer preflight row.
ALTER TABLE public.earlybird_orders
    ADD COLUMN IF NOT EXISTS checkout_blocked_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN IF NOT EXISTS checkout_blocked_reason TEXT;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.earlybird_orders'::pg_catalog.regclass
          AND conname = 'earlybird_orders_checkout_block_check'
    ) THEN
        ALTER TABLE public.earlybird_orders
            ADD CONSTRAINT earlybird_orders_checkout_block_check CHECK (
                (checkout_blocked_at IS NULL AND checkout_blocked_reason IS NULL)
                OR (
                    checkout_blocked_at IS NOT NULL
                    AND checkout_blocked_reason = 'SUPERSEDED_LINEAGE'
                )
            );
    END IF;
END;
$$;

-- The legacy create RPC remains available for rollback compatibility. This
-- service-only wrapper catches only the database-authoritative superseded
-- lineage result, records a durable marker in the outer transaction, and
-- returns a bounded disposition so the caller does not have to rewrite the
-- payment ledger status (or rely on mutable preflight state).
CREATE OR REPLACE FUNCTION public.create_earlybird_checkout_with_lineage_marker(
    p_user_id UUID,
    p_preflight_id UUID,
    p_plan_id TEXT,
    p_expected_product_id TEXT,
    p_expected_amount_krw INTEGER,
    p_pricing_version TEXT,
    p_disclosure_version TEXT,
    p_disclosure_text TEXT,
    p_disclosure_accepted_at TIMESTAMP WITH TIME ZONE
)
RETURNS TABLE(order_id UUID, created BOOLEAN, disposition TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
SET lock_timeout = '5s'
SET statement_timeout = '2min'
AS $$
DECLARE
    v_order_id UUID;
    v_created BOOLEAN;
    v_error_message TEXT;
    v_pending_count INTEGER;
    v_pending public.earlybird_orders%ROWTYPE;
    v_current_preflight public.analysis_preflights%ROWTYPE;
    v_pending_preflight public.analysis_preflights%ROWTYPE;
    v_blocked_at TIMESTAMP WITH TIME ZONE;
    v_blocked_reason TEXT;
    v_updated_count INTEGER;
BEGIN
    BEGIN
        SELECT created_row.order_id, created_row.created
        INTO v_order_id, v_created
        FROM public.create_earlybird_checkout(
            p_user_id,
            p_preflight_id,
            p_plan_id,
            p_expected_product_id,
            p_expected_amount_krw,
            p_pricing_version,
            p_disclosure_version,
            p_disclosure_text,
            p_disclosure_accepted_at
        ) AS created_row;
    EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS v_error_message = MESSAGE_TEXT;
        IF v_error_message <> 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE:SUPERSEDED_LINEAGE' THEN
            RAISE;
        END IF;

        -- Locks acquired by the legacy call were held in the failed inner
        -- subtransaction and were rolled back with it. Reacquire its exact
        -- product/user/user-row lock order before reproving any rows, so a
        -- competing create cannot change the candidate between checks.
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(
                'earlybird:groble:product:' || p_expected_product_id,
                0
            )
        );
        PERFORM pg_catalog.pg_advisory_xact_lock(
            pg_catalog.hashtextextended(p_user_id::TEXT, 0)
        );
        PERFORM 1
        FROM public.users AS buyer
        WHERE buyer.id = p_user_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED',
                ERRCODE = 'P0001';
        END IF;

        SELECT current_preflight.*
        INTO v_current_preflight
        FROM public.analysis_preflights AS current_preflight
        WHERE current_preflight.id = p_preflight_id
          AND current_preflight.user_id = p_user_id
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED',
                ERRCODE = 'P0001';
        END IF;

        SELECT pg_catalog.count(*)::INTEGER
        INTO v_pending_count
        FROM public.earlybird_orders AS pending_order
        WHERE pending_order.user_id = p_user_id
          AND pending_order.expected_groble_product_id = p_expected_product_id
          AND pending_order.status = 'payment_pending';
        IF v_pending_count <> 1 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED',
                ERRCODE = 'P0001';
        END IF;

        SELECT pending_order.*
        INTO v_pending
        FROM public.earlybird_orders AS pending_order
        WHERE pending_order.user_id = p_user_id
          AND pending_order.expected_groble_product_id = p_expected_product_id
          AND pending_order.status = 'payment_pending'
        ORDER BY pending_order.created_at, pending_order.id
        LIMIT 1
        FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED',
                ERRCODE = 'P0001';
        END IF;

        SELECT pending_preflight.*
        INTO v_pending_preflight
        FROM public.analysis_preflights AS pending_preflight
        WHERE pending_preflight.id = v_pending.preflight_id
          AND pending_preflight.user_id = p_user_id
        FOR UPDATE;
        IF NOT FOUND OR NOT (
            v_current_preflight.created_at > v_pending_preflight.created_at
            OR (
                v_current_preflight.created_at = v_pending_preflight.created_at
                AND v_current_preflight.id::TEXT > v_pending_preflight.id::TEXT
            )
        ) THEN
            -- The old RPC's error is only durable evidence of supersession if
            -- the requested preflight is actually newer than the pending row.
            RAISE EXCEPTION USING
                MESSAGE = v_error_message,
                ERRCODE = 'P0001';
        END IF;

        IF v_pending.payment_id IS NOT NULL
           OR v_pending.actual_groble_product_id IS NOT NULL
           OR v_pending.actual_amount_krw IS NOT NULL
           OR v_pending.paid_at IS NOT NULL
           OR v_pending.seller_reference_confirmed_at IS NOT NULL THEN
            -- Never turn ambiguous provider/payment evidence into a checkout
            -- marker. Abort the wrapper instead.
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED',
                ERRCODE = 'P0001';
        END IF;

        UPDATE public.earlybird_orders AS superseded_order
        SET checkout_blocked_at = COALESCE(
                superseded_order.checkout_blocked_at,
                pg_catalog.clock_timestamp()
            ),
            checkout_blocked_reason = 'SUPERSEDED_LINEAGE',
            updated_at = pg_catalog.clock_timestamp()
        WHERE superseded_order.id = v_pending.id
          AND superseded_order.user_id = p_user_id
          AND superseded_order.expected_groble_product_id = p_expected_product_id
          AND superseded_order.status = 'payment_pending'
          AND superseded_order.payment_id IS NULL
          AND superseded_order.actual_groble_product_id IS NULL
          AND superseded_order.actual_amount_krw IS NULL
          AND superseded_order.paid_at IS NULL
          AND superseded_order.seller_reference_confirmed_at IS NULL
          AND (
              superseded_order.checkout_blocked_reason IS NULL
              OR superseded_order.checkout_blocked_reason = 'SUPERSEDED_LINEAGE'
          );
        GET DIAGNOSTICS v_updated_count = ROW_COUNT;
        IF v_updated_count <> 1 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED',
                ERRCODE = 'P0001';
        END IF;

        RETURN QUERY SELECT v_pending.id, FALSE, 'superseded'::TEXT;
        RETURN;
    END;

    IF v_order_id IS NULL OR v_created IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED',
            ERRCODE = 'P0001';
    END IF;

    SELECT checkout_blocked_at, checkout_blocked_reason
    INTO v_blocked_at, v_blocked_reason
    FROM public.earlybird_orders
    WHERE id = v_order_id
      AND user_id = p_user_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_CHECKOUT_SUPERSESSION_MARKER_FAILED',
            ERRCODE = 'P0001';
    END IF;

    IF v_blocked_at IS NOT NULL OR v_blocked_reason IS NOT NULL THEN
        RETURN QUERY SELECT v_order_id, FALSE, 'superseded'::TEXT;
        RETURN;
    END IF;

    RETURN QUERY SELECT v_order_id, v_created,
        CASE WHEN v_created THEN 'created' ELSE 'replayed' END;
END;
$$;

REVOKE ALL ON FUNCTION public.create_earlybird_checkout_with_lineage_marker(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_earlybird_checkout_with_lineage_marker(
    UUID, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, TIMESTAMP WITH TIME ZONE
) TO service_role;

NOTIFY pgrst, 'reload schema';
