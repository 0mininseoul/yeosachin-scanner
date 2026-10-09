-- Dev project only. This is deliberately outside production migrations.
-- No business rows, provider calls, outbox, fulfillment or worker are created.
BEGIN;

CREATE SCHEMA IF NOT EXISTS dev_ui;
REVOKE ALL ON SCHEMA dev_ui FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA dev_ui TO service_role;

-- Preserve the cloned global/public default ACLs. Schema-local defaults cannot
-- subtract global PUBLIC EXECUTE, so every created Dev function also receives
-- an explicit final REVOKE below, before this transaction becomes visible.
ALTER DEFAULT PRIVILEGES IN SCHEMA dev_ui REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA dev_ui REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA dev_ui REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

-- Versioned Dev fixture quote snapshot. TS checks parity against the existing
-- pure catalog; drift fails closed instead of consulting live Groble inventory.
CREATE OR REPLACE FUNCTION dev_ui.plan_snapshot() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
    SELECT '{
      "basic":{"planId":"basic","launchStatus":"production","relationshipCapacity":{"followers":400,"following":400},"detailedMutualLimit":300,"selectionState":"required","unavailableReason":null,"pricingVersion":"earlybird-2026-08-v5","price":{"currency":"KRW","status":"quoted","amountKrw":9900},"remainingSlots":null},
      "standard":{"planId":"standard","launchStatus":"production","relationshipCapacity":{"followers":800,"following":800},"detailedMutualLimit":600,"selectionState":"available_upgrade","unavailableReason":null,"pricingVersion":"earlybird-2026-08-v5","price":{"currency":"KRW","status":"quoted","amountKrw":19900},"remainingSlots":null},
      "plus":{"planId":"plus","launchStatus":"disabled","relationshipCapacity":{"followers":1200,"following":1200},"detailedMutualLimit":900,"selectionState":"unavailable","unavailableReason":"launch_gate","pricingVersion":"earlybird-2026-08-v5","price":{"currency":"KRW","status":"deferred","amountKrw":null},"remainingSlots":null}
    }'::jsonb;
$$;

CREATE TABLE IF NOT EXISTS dev_ui.preflights (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    target_instagram_id text NOT NULL CHECK (target_instagram_id ~ '^[a-z0-9._]{1,30}$'),
    idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'),
    fixture_version text NOT NULL DEFAULT 'dev-ui-synthetic-v1' CHECK (fixture_version = 'dev-ui-synthetic-v1'),
    fixture_scenario text NOT NULL CHECK (fixture_scenario IN ('complete', 'partial', 'failed', 'empty')),
    duration_seconds integer NOT NULL DEFAULT 45 CHECK (duration_seconds = 45),
    pricing_version text NOT NULL DEFAULT 'earlybird-2026-08-v5',
    plan_snapshot jsonb NOT NULL DEFAULT dev_ui.plan_snapshot() CHECK (jsonb_typeof(plan_snapshot) = 'object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    UNIQUE (user_id, idempotency_key),
    UNIQUE (id, user_id)
);

CREATE TABLE IF NOT EXISTS dev_ui.orders (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    preflight_id uuid NOT NULL,
    target_instagram_id text NOT NULL,
    plan_id text NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    pricing_version text NOT NULL,
    plan_snapshot jsonb NOT NULL CHECK (jsonb_typeof(plan_snapshot) = 'object'),
    fixture_version text NOT NULL CHECK (fixture_version = 'dev-ui-synthetic-v1'),
    fixture_scenario text NOT NULL CHECK (fixture_scenario IN ('complete', 'partial', 'failed', 'empty')),
    duration_seconds integer NOT NULL CHECK (duration_seconds = 45),
    disclosure_accepted_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'cancel', 'failure')),
    created_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    run_id uuid UNIQUE,
    UNIQUE (user_id, preflight_id),
    UNIQUE (id, user_id),
    FOREIGN KEY (preflight_id, user_id) REFERENCES dev_ui.preflights(id, user_id),
    CHECK ((status = 'pending' AND completed_at IS NULL AND run_id IS NULL)
        OR (status = 'success' AND completed_at IS NOT NULL AND run_id IS NOT NULL)
        OR (status IN ('cancel', 'failure') AND completed_at IS NOT NULL AND run_id IS NULL))
);

CREATE TABLE IF NOT EXISTS dev_ui.runs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES auth.users(id),
    order_id uuid NOT NULL UNIQUE,
    preflight_id uuid NOT NULL,
    target_instagram_id text NOT NULL,
    plan_id text NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    pricing_version text NOT NULL,
    plan_snapshot jsonb NOT NULL CHECK (jsonb_typeof(plan_snapshot) = 'object'),
    fixture_version text NOT NULL CHECK (fixture_version = 'dev-ui-synthetic-v1'),
    fixture_scenario text NOT NULL CHECK (fixture_scenario IN ('complete', 'partial', 'failed', 'empty')),
    duration_seconds integer NOT NULL CHECK (duration_seconds = 45),
    created_at timestamptz NOT NULL,
    started_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    UNIQUE (id, order_id, user_id),
    FOREIGN KEY (order_id, user_id) REFERENCES dev_ui.orders(id, user_id),
    FOREIGN KEY (preflight_id, user_id) REFERENCES dev_ui.preflights(id, user_id)
);

DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'dev_ui.orders'::regclass AND conname = 'dev_ui_order_run_link') THEN
        ALTER TABLE dev_ui.orders ADD CONSTRAINT dev_ui_order_run_link
            FOREIGN KEY (run_id, id, user_id) REFERENCES dev_ui.runs(id, order_id, user_id)
            DEFERRABLE INITIALLY DEFERRED;
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS dev_ui_orders_owner_created ON dev_ui.orders(user_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS dev_ui_orders_created ON dev_ui.orders(created_at DESC, id);

ALTER TABLE dev_ui.preflights ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_ui.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE dev_ui.runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA dev_ui FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA dev_ui TO service_role;
-- Writes occur through the owner-executed transaction functions; client roles
-- have no table policies and no schema access. service_role has BYPASSRLS.

CREATE OR REPLACE FUNCTION public.dev_ui_create_preflight(
    p_user_id uuid, p_target_instagram_id text, p_idempotency_key text, p_fixture_scenario text DEFAULT 'complete'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
DECLARE
    prepared dev_ui.preflights%ROWTYPE;
    inserted boolean;
    instant timestamptz := clock_timestamp();
BEGIN
    IF p_user_id IS NULL OR p_target_instagram_id IS NULL OR p_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
        OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[A-Za-z0-9._:-]{16,128}$'
        OR p_fixture_scenario IS NULL OR p_fixture_scenario NOT IN ('complete', 'partial', 'failed', 'empty') THEN
        RAISE EXCEPTION 'DEV_UI_INVALID_INPUT';
    END IF;
    INSERT INTO dev_ui.preflights (user_id, target_instagram_id, idempotency_key, fixture_scenario, created_at, expires_at)
        VALUES (p_user_id, p_target_instagram_id, p_idempotency_key, p_fixture_scenario, instant, instant + interval '30 minutes')
        ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING * INTO prepared;
    inserted := FOUND;
    IF NOT inserted THEN
        SELECT * INTO prepared FROM dev_ui.preflights
            WHERE user_id = p_user_id AND idempotency_key = p_idempotency_key FOR UPDATE;
        IF prepared.target_instagram_id <> p_target_instagram_id OR prepared.fixture_scenario <> p_fixture_scenario THEN
            RAISE EXCEPTION 'DEV_UI_IDEMPOTENCY_CONFLICT';
        END IF;
        IF prepared.consumed_at IS NULL AND prepared.expires_at <= clock_timestamp() THEN
            RAISE EXCEPTION 'DEV_UI_EXPIRED';
        END IF;
    END IF;
    RETURN jsonb_build_object('preflight', to_jsonb(prepared), 'created', inserted);
END;
$$;

CREATE OR REPLACE FUNCTION public.dev_ui_create_checkout(
    p_user_id uuid, p_preflight_id uuid, p_plan_id text, p_disclosure_accepted boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
DECLARE
    prepared dev_ui.preflights%ROWTYPE;
    checkout dev_ui.orders%ROWTYPE;
    instant timestamptz;
BEGIN
    IF p_user_id IS NULL OR p_preflight_id IS NULL OR p_plan_id IS NULL OR p_plan_id NOT IN ('basic', 'standard')
        OR p_disclosure_accepted IS DISTINCT FROM true THEN RAISE EXCEPTION 'DEV_UI_INVALID_INPUT'; END IF;
    SELECT * INTO prepared FROM dev_ui.preflights WHERE id = p_preflight_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'DEV_UI_NOT_FOUND'; END IF;
    SELECT * INTO checkout FROM dev_ui.orders WHERE preflight_id = p_preflight_id AND user_id = p_user_id;
    IF FOUND THEN
        IF checkout.plan_id <> p_plan_id THEN RAISE EXCEPTION 'DEV_UI_PLAN_CONFLICT'; END IF;
        IF checkout.status = 'pending' AND (checkout.expires_at <= clock_timestamp() OR prepared.expires_at <= clock_timestamp()) THEN
            RAISE EXCEPTION 'DEV_UI_EXPIRED';
        END IF;
        RETURN jsonb_build_object('order', to_jsonb(checkout), 'replayed', true);
    END IF;
    instant := clock_timestamp();
    IF prepared.expires_at <= instant THEN RAISE EXCEPTION 'DEV_UI_EXPIRED'; END IF;
    IF prepared.consumed_at IS NOT NULL THEN RAISE EXCEPTION 'DEV_UI_SNAPSHOT_MISMATCH'; END IF;
    IF prepared.plan_snapshot IS DISTINCT FROM dev_ui.plan_snapshot()
        OR prepared.pricing_version <> 'earlybird-2026-08-v5' THEN RAISE EXCEPTION 'DEV_UI_SNAPSHOT_MISMATCH'; END IF;
    INSERT INTO dev_ui.orders (user_id, preflight_id, target_instagram_id, plan_id, pricing_version, plan_snapshot,
        fixture_version, fixture_scenario, duration_seconds, disclosure_accepted_at, created_at, expires_at)
        VALUES (p_user_id, prepared.id, prepared.target_instagram_id, p_plan_id, prepared.pricing_version,
            prepared.plan_snapshot -> p_plan_id, prepared.fixture_version, prepared.fixture_scenario, prepared.duration_seconds,
            instant, instant, LEAST(instant + interval '30 minutes', prepared.expires_at))
        RETURNING * INTO checkout;
    RETURN jsonb_build_object('order', to_jsonb(checkout), 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.dev_ui_complete_checkout(
    p_user_id uuid, p_order_id uuid, p_outcome text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
DECLARE
    checkout dev_ui.orders%ROWTYPE;
    prepared dev_ui.preflights%ROWTYPE;
    run dev_ui.runs%ROWTYPE;
    instant timestamptz;
BEGIN
    IF p_user_id IS NULL OR p_order_id IS NULL OR p_outcome IS NULL OR p_outcome NOT IN ('success', 'cancel', 'failure') THEN
        RAISE EXCEPTION 'DEV_UI_INVALID_INPUT';
    END IF;
    SELECT * INTO checkout FROM dev_ui.orders WHERE id = p_order_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'DEV_UI_NOT_FOUND'; END IF;
    SELECT * INTO prepared FROM dev_ui.preflights WHERE id = checkout.preflight_id AND user_id = p_user_id FOR UPDATE;
    IF NOT FOUND OR checkout.target_instagram_id IS DISTINCT FROM prepared.target_instagram_id
        OR checkout.pricing_version IS DISTINCT FROM prepared.pricing_version
        OR checkout.plan_snapshot IS DISTINCT FROM (prepared.plan_snapshot -> checkout.plan_id)
        OR checkout.fixture_version IS DISTINCT FROM prepared.fixture_version
        OR checkout.fixture_scenario IS DISTINCT FROM prepared.fixture_scenario
        OR checkout.duration_seconds IS DISTINCT FROM prepared.duration_seconds
        OR prepared.plan_snapshot IS DISTINCT FROM dev_ui.plan_snapshot()
        OR prepared.pricing_version <> 'earlybird-2026-08-v5' THEN RAISE EXCEPTION 'DEV_UI_SNAPSHOT_MISMATCH'; END IF;
    instant := clock_timestamp();
    IF checkout.status <> 'pending' THEN
        IF checkout.status <> p_outcome THEN RAISE EXCEPTION 'DEV_UI_COMPLETION_CONFLICT'; END IF;
        IF checkout.status = 'success' THEN
            SELECT * INTO run FROM dev_ui.runs WHERE id = checkout.run_id AND order_id = checkout.id AND user_id = p_user_id;
            IF NOT FOUND OR run.started_at IS DISTINCT FROM checkout.completed_at
                OR run.plan_snapshot IS DISTINCT FROM checkout.plan_snapshot THEN RAISE EXCEPTION 'DEV_UI_SNAPSHOT_MISMATCH'; END IF;
            IF run.expires_at <= instant THEN RAISE EXCEPTION 'DEV_UI_RUN_EXPIRED'; END IF;
        END IF;
        RETURN jsonb_build_object('order', to_jsonb(checkout), 'run', CASE WHEN checkout.status = 'success' THEN to_jsonb(run) ELSE NULL END, 'replayed', true);
    END IF;
    IF checkout.expires_at <= instant OR prepared.expires_at <= instant THEN RAISE EXCEPTION 'DEV_UI_EXPIRED'; END IF;
    IF p_outcome = 'success' THEN
        INSERT INTO dev_ui.runs (user_id, order_id, preflight_id, target_instagram_id, plan_id, pricing_version, plan_snapshot,
            fixture_version, fixture_scenario, duration_seconds, created_at, started_at, expires_at)
            VALUES (p_user_id, checkout.id, prepared.id, prepared.target_instagram_id, checkout.plan_id, checkout.pricing_version,
                checkout.plan_snapshot, prepared.fixture_version, prepared.fixture_scenario, prepared.duration_seconds,
                instant, instant, instant + interval '7 days') RETURNING * INTO run;
        UPDATE dev_ui.preflights SET consumed_at = instant WHERE id = prepared.id;
    END IF;
    UPDATE dev_ui.orders SET status = p_outcome, completed_at = instant, run_id = CASE WHEN p_outcome = 'success' THEN run.id ELSE NULL END
        WHERE id = checkout.id RETURNING * INTO checkout;
    RETURN jsonb_build_object('order', to_jsonb(checkout), 'run', CASE WHEN p_outcome = 'success' THEN to_jsonb(run) ELSE NULL END, 'replayed', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.dev_ui_read_preflight(p_user_id uuid, p_preflight_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
    SELECT to_jsonb(p) || jsonb_build_object('request_id', o.run_id)
    FROM dev_ui.preflights p LEFT JOIN dev_ui.orders o ON o.preflight_id = p.id AND o.user_id = p.user_id AND o.status = 'success'
    WHERE p.id = p_preflight_id AND p.user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.dev_ui_read_checkout(p_user_id uuid, p_order_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
    SELECT jsonb_build_object('order', to_jsonb(o), 'run', to_jsonb(r))
    FROM dev_ui.orders o LEFT JOIN dev_ui.runs r ON r.id = o.run_id AND r.order_id = o.id AND r.user_id = o.user_id
    WHERE o.id = p_order_id AND o.user_id = p_user_id;
$$;

CREATE OR REPLACE FUNCTION public.dev_ui_read_run(p_user_id uuid, p_run_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
DECLARE run dev_ui.runs%ROWTYPE;
BEGIN
    SELECT r.* INTO run FROM dev_ui.runs r JOIN dev_ui.orders o ON o.id = r.order_id AND o.run_id = r.id AND o.user_id = r.user_id
        WHERE r.id = p_run_id AND r.user_id = p_user_id AND o.status = 'success';
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF run.expires_at <= clock_timestamp() THEN RAISE EXCEPTION 'DEV_UI_RUN_EXPIRED'; END IF;
    RETURN to_jsonb(run);
END;
$$;

CREATE OR REPLACE FUNCTION public.dev_ui_list_owner_orders(p_user_id uuid, p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('order', to_jsonb(o), 'run', to_jsonb(r)) ORDER BY o.created_at DESC, o.id), '[]'::jsonb)
    FROM (SELECT * FROM dev_ui.orders WHERE user_id = p_user_id ORDER BY created_at DESC, id LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 100))) o
    LEFT JOIN dev_ui.runs r ON r.id = o.run_id AND r.order_id = o.id AND r.user_id = o.user_id;
$$;

-- Admin reads still need the private server allowlist; these RPCs are never
-- granted to authenticated and expose no mutation or provider action.
CREATE OR REPLACE FUNCTION public.dev_ui_list_admin_orders(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object('order', to_jsonb(o), 'run', to_jsonb(r)) ORDER BY o.created_at DESC, o.id), '[]'::jsonb)
    FROM (SELECT * FROM dev_ui.orders ORDER BY created_at DESC, id LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 100), 100))) o
    LEFT JOIN dev_ui.runs r ON r.id = o.run_id AND r.order_id = o.id AND r.user_id = o.user_id;
$$;

CREATE OR REPLACE FUNCTION public.dev_ui_read_admin_order(p_order_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, dev_ui AS $$
    SELECT jsonb_build_object('order', to_jsonb(o), 'run', to_jsonb(r))
    FROM dev_ui.orders o LEFT JOIN dev_ui.runs r ON r.id = o.run_id AND r.order_id = o.id AND r.user_id = o.user_id WHERE o.id = p_order_id;
$$;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA dev_ui FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_create_preflight(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_create_checkout(uuid, uuid, text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_complete_checkout(uuid, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_read_preflight(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_read_checkout(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_read_run(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_list_owner_orders(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_list_admin_orders(integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.dev_ui_read_admin_order(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.dev_ui_create_preflight(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_ui_create_checkout(uuid, uuid, text, boolean) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_ui_complete_checkout(uuid, uuid, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_ui_read_preflight(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_ui_read_checkout(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_ui_read_run(uuid, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_ui_list_owner_orders(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_ui_list_admin_orders(integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.dev_ui_read_admin_order(uuid) TO service_role;

COMMIT;
