-- Shared monetary reservations for every Vertex AI generation attempt.
-- This is deliberately separate from provider concurrency leases: leases bound active calls,
-- while this table bounds estimated dollars across run, order, and UTC-day scopes.
-- Terminal rows are intentionally retained until the replay/recovery horizon is explicitly
-- configured. Deleting them earlier would turn a late duplicate into a second charge. The
-- indexed terminal lifecycle is the bounded-retention hook for a future service-role archive
-- job that preserves reservation-key tombstones and reconciled aggregates before pruning detail.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE IF NOT EXISTS public.vertex_ai_budget_reservations (
    reservation_key TEXT PRIMARY KEY,
    reservation_id UUID NOT NULL DEFAULT extensions.gen_random_uuid(),
    run_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    day_key DATE NOT NULL,
    operation_key TEXT NOT NULL,
    attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 4),
    route TEXT NOT NULL CHECK (route IN ('default', 'high_value', 'ambiguous')),
    model_name TEXT NOT NULL,
    model_location TEXT NOT NULL,
    input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
    max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens BETWEEN 1 AND 65536),
    estimated_cost_usd NUMERIC(18, 12) NOT NULL CHECK (
        estimated_cost_usd > 0 AND estimated_cost_usd <= 1000000
    ),
    actual_cost_usd NUMERIC(18, 12) CHECK (
        actual_cost_usd IS NULL OR (actual_cost_usd >= 0 AND actual_cost_usd <= 1000000)
    ),
    usage_unknown BOOLEAN NOT NULL DEFAULT TRUE,
    state TEXT NOT NULL DEFAULT 'reserved'
        CHECK (state IN ('reserved', 'settled', 'cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT vertex_ai_budget_reservation_key_check CHECK (
        reservation_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
    ),
    CONSTRAINT vertex_ai_budget_run_id_check CHECK (
        run_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    ),
    CONSTRAINT vertex_ai_budget_order_id_check CHECK (
        order_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$'
    ),
    CONSTRAINT vertex_ai_budget_operation_key_check CHECK (
        operation_key ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
    ),
    CONSTRAINT vertex_ai_budget_model_check CHECK (
        model_name ~ '^[a-z0-9][a-z0-9._-]{0,99}(/[a-z0-9][a-z0-9._-]{0,99})*$'
    ),
    CONSTRAINT vertex_ai_budget_location_check CHECK (
        model_location ~ '^[a-z][a-z0-9-]{0,62}$'
    ),
    CONSTRAINT vertex_ai_budget_usage_state_check CHECK (
        (state = 'settled' AND usage_unknown = (actual_cost_usd IS NULL))
        OR (state IN ('reserved', 'cancelled'))
    ),
    CONSTRAINT vertex_ai_budget_clock_check CHECK (updated_at >= created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS vertex_ai_budget_reservation_id_idx
    ON public.vertex_ai_budget_reservations (reservation_id);
CREATE INDEX IF NOT EXISTS vertex_ai_budget_run_totals_idx
    ON public.vertex_ai_budget_reservations (run_id, state);
CREATE INDEX IF NOT EXISTS vertex_ai_budget_order_totals_idx
    ON public.vertex_ai_budget_reservations (order_id, state);
CREATE INDEX IF NOT EXISTS vertex_ai_budget_day_totals_idx
    ON public.vertex_ai_budget_reservations (day_key, state);
CREATE INDEX IF NOT EXISTS vertex_ai_budget_terminal_retention_idx
    ON public.vertex_ai_budget_reservations (state, created_at)
    WHERE state IN ('settled', 'cancelled');

ALTER TABLE public.vertex_ai_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vertex_ai_budget_reservations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.vertex_ai_budget_reservations
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_vertex_ai_budget(
    p_reservation_key TEXT,
    p_run_id TEXT,
    p_order_id TEXT,
    p_operation_key TEXT,
    p_attempt INTEGER,
    p_route TEXT,
    p_model_name TEXT,
    p_location TEXT,
    p_input_tokens BIGINT,
    p_max_output_tokens INTEGER,
    p_estimated_cost_usd NUMERIC,
    p_day_key DATE DEFAULT NULL,
    p_per_run_limit_usd NUMERIC DEFAULT 2.000000000000,
    p_per_order_limit_usd NUMERIC DEFAULT 5.000000000000,
    p_daily_limit_usd NUMERIC DEFAULT 100.000000000000
)
RETURNS TABLE (
    reservation_id UUID,
    reservation_key TEXT,
    run_id TEXT,
    order_id TEXT,
    day_key DATE,
    route TEXT,
    model_name TEXT,
    attempt INTEGER,
    estimated_cost_usd NUMERIC,
    actual_cost_usd NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing public.vertex_ai_budget_reservations%ROWTYPE;
    v_run_id TEXT := NULLIF(pg_catalog.btrim(p_run_id), '');
    v_order_id TEXT := NULLIF(pg_catalog.btrim(p_order_id), '');
    v_operation_key TEXT := NULLIF(pg_catalog.btrim(p_operation_key), '');
    v_model_name TEXT := NULLIF(pg_catalog.btrim(p_model_name), '');
    v_location TEXT := COALESCE(NULLIF(pg_catalog.btrim(p_location), ''), 'global');
    v_day_key DATE := COALESCE(p_day_key, (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::DATE);
    v_current NUMERIC;
BEGIN
    IF p_reservation_key IS NULL OR p_reservation_key !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,255}$'
       OR v_run_id IS NULL OR v_operation_key IS NULL
       OR p_attempt NOT BETWEEN 1 AND 4
       OR p_route NOT IN ('default', 'high_value', 'ambiguous')
       OR v_model_name IS NULL OR v_location IS NULL
       OR p_input_tokens IS NULL OR p_input_tokens < 0
       OR p_max_output_tokens IS NULL OR p_max_output_tokens NOT BETWEEN 1 AND 65536
       OR p_estimated_cost_usd IS NULL OR p_estimated_cost_usd <= 0
       OR p_estimated_cost_usd > 1000000
       OR p_estimated_cost_usd <> pg_catalog.round(p_estimated_cost_usd, 12)
       OR p_per_run_limit_usd IS NULL OR p_per_run_limit_usd <= 0
       OR p_per_run_limit_usd > 1000000
       OR p_per_run_limit_usd <> pg_catalog.round(p_per_run_limit_usd, 12)
       OR p_per_order_limit_usd IS NULL OR p_per_order_limit_usd <= 0
       OR p_per_order_limit_usd > 1000000
       OR p_per_order_limit_usd <> pg_catalog.round(p_per_order_limit_usd, 12)
       OR p_daily_limit_usd IS NULL OR p_daily_limit_usd <= 0
       OR p_daily_limit_usd > 1000000
       OR p_daily_limit_usd <> pg_catalog.round(p_daily_limit_usd, 12) THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_RESERVATION_INVALID';
    END IF;

    -- A request-scoped run ID is also the result_request_id for paid earlybird orders. Resolve
    -- that order here so all retries/stages share the order ceiling even when the worker fence
    -- carries no order field. Non-order requests intentionally fall back to run scope.
    IF v_order_id IS NULL
       AND v_run_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        SELECT pg_catalog.lower(earlybird_order.id::TEXT)
          INTO v_order_id
          FROM public.earlybird_orders AS earlybird_order
         WHERE earlybird_order.result_request_id = v_run_id::UUID
         LIMIT 1;
    END IF;
    v_order_id := COALESCE(v_order_id, v_run_id);

    -- The shared advisory lock serializes all scope totals and the row lock makes recovery
    -- idempotent, avoiding races between different keys and duplicate retries.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('vertex-ai-budget:all-scopes', 0)
    );
    SELECT reservation.*
      INTO v_existing
      FROM public.vertex_ai_budget_reservations AS reservation
     WHERE reservation.reservation_key = p_reservation_key
     FOR UPDATE;
    IF FOUND THEN
        IF v_existing.run_id IS DISTINCT FROM v_run_id
           OR v_existing.order_id IS DISTINCT FROM v_order_id
           OR v_existing.operation_key IS DISTINCT FROM v_operation_key
           OR v_existing.attempt IS DISTINCT FROM p_attempt
           OR v_existing.route IS DISTINCT FROM p_route
           OR v_existing.model_name IS DISTINCT FROM v_model_name
           OR v_existing.model_location IS DISTINCT FROM v_location
           OR v_existing.input_tokens IS DISTINCT FROM p_input_tokens
           OR v_existing.max_output_tokens IS DISTINCT FROM p_max_output_tokens
           OR v_existing.estimated_cost_usd IS DISTINCT FROM p_estimated_cost_usd
           -- An omitted day is recovery metadata, not part of the attempt identity. This keeps
           -- reserved/settled work anchored to its original UTC day after a midnight retry;
           -- explicit day assertions still detect drift for every lifecycle state.
           OR p_day_key IS NOT NULL
              AND v_existing.day_key IS DISTINCT FROM v_day_key THEN
            RAISE EXCEPTION 'VERTEX_AI_BUDGET_RESERVATION_IDENTITY_DRIFT';
        END IF;
        -- A cancelled reservation never reached the provider. Permit the same deterministic
        -- attempt key to be admitted again after a pre-dispatch retry; active/settled rows remain
        -- fully idempotent and continue to return without another charge.
        IF v_existing.state <> 'cancelled' THEN
            RETURN QUERY SELECT
                v_existing.reservation_id, v_existing.reservation_key, v_existing.run_id,
                v_existing.order_id, v_existing.day_key, v_existing.route, v_existing.model_name,
                v_existing.attempt, v_existing.estimated_cost_usd, v_existing.actual_cost_usd;
            RETURN;
        END IF;
        DELETE FROM public.vertex_ai_budget_reservations AS reservation
         WHERE reservation.reservation_key = p_reservation_key;
    END IF;

    SELECT COALESCE(pg_catalog.sum(
        COALESCE(reservation.actual_cost_usd, reservation.estimated_cost_usd)
    ), 0)
      INTO v_current
      FROM public.vertex_ai_budget_reservations AS reservation
     WHERE reservation.run_id = v_run_id
       AND reservation.state IN ('reserved', 'settled');
    IF v_current + p_estimated_cost_usd > p_per_run_limit_usd THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_EXCEEDED:run:%', v_run_id;
    END IF;

    SELECT COALESCE(pg_catalog.sum(
        COALESCE(reservation.actual_cost_usd, reservation.estimated_cost_usd)
    ), 0)
      INTO v_current
      FROM public.vertex_ai_budget_reservations AS reservation
     WHERE reservation.order_id = v_order_id
       AND reservation.state IN ('reserved', 'settled');
    IF v_current + p_estimated_cost_usd > p_per_order_limit_usd THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_EXCEEDED:order:%', v_order_id;
    END IF;

    SELECT COALESCE(pg_catalog.sum(
        COALESCE(reservation.actual_cost_usd, reservation.estimated_cost_usd)
    ), 0)
      INTO v_current
      FROM public.vertex_ai_budget_reservations AS reservation
     WHERE reservation.day_key = v_day_key
       AND reservation.state IN ('reserved', 'settled');
    IF v_current + p_estimated_cost_usd > p_daily_limit_usd THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_EXCEEDED:day:%', v_day_key;
    END IF;

    RETURN QUERY INSERT INTO public.vertex_ai_budget_reservations (
        reservation_key, run_id, order_id, day_key, operation_key, attempt, route,
        model_name, model_location, input_tokens, max_output_tokens, estimated_cost_usd
    ) VALUES (
        p_reservation_key, v_run_id, v_order_id, v_day_key, v_operation_key, p_attempt, p_route,
        v_model_name, v_location, p_input_tokens, p_max_output_tokens,
        pg_catalog.round(p_estimated_cost_usd, 12)
    )
    RETURNING
        vertex_ai_budget_reservations.reservation_id,
        vertex_ai_budget_reservations.reservation_key,
        vertex_ai_budget_reservations.run_id,
        vertex_ai_budget_reservations.order_id,
        vertex_ai_budget_reservations.day_key,
        vertex_ai_budget_reservations.route,
        vertex_ai_budget_reservations.model_name,
        vertex_ai_budget_reservations.attempt,
        vertex_ai_budget_reservations.estimated_cost_usd,
        vertex_ai_budget_reservations.actual_cost_usd;
END;
$$;

CREATE OR REPLACE FUNCTION public.settle_vertex_ai_budget(
    p_reservation_key TEXT,
    p_reservation_id UUID,
    p_actual_cost_usd NUMERIC DEFAULT NULL
)
RETURNS TABLE (
    reservation_id UUID,
    reservation_key TEXT,
    run_id TEXT,
    order_id TEXT,
    day_key DATE,
    route TEXT,
    model_name TEXT,
    attempt INTEGER,
    estimated_cost_usd NUMERIC,
    actual_cost_usd NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row public.vertex_ai_budget_reservations%ROWTYPE;
BEGIN
    IF p_reservation_key IS NULL OR p_reservation_id IS NULL
       OR p_actual_cost_usd IS NOT NULL
          AND (p_actual_cost_usd < 0 OR p_actual_cost_usd > 1000000
               OR p_actual_cost_usd <> pg_catalog.round(p_actual_cost_usd, 12)) THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_SETTLEMENT_INVALID';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('vertex-ai-budget:all-scopes', 0)
    );
    SELECT reservation.*
      INTO v_row
      FROM public.vertex_ai_budget_reservations AS reservation
     WHERE reservation.reservation_key = p_reservation_key
     FOR UPDATE;
    IF NOT FOUND OR v_row.reservation_id IS DISTINCT FROM p_reservation_id THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_RESERVATION_UNKNOWN';
    END IF;
    IF v_row.state = 'cancelled' THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_RESERVATION_CANCELLED';
    END IF;
    IF v_row.state = 'settled'
       AND v_row.actual_cost_usd IS NOT NULL
       AND p_actual_cost_usd IS NOT NULL
       AND v_row.actual_cost_usd IS DISTINCT FROM p_actual_cost_usd THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_SETTLEMENT_IDENTITY_DRIFT';
    END IF;
    IF v_row.state = 'reserved' THEN
        UPDATE public.vertex_ai_budget_reservations AS reservation
           SET state = 'settled',
               actual_cost_usd = p_actual_cost_usd,
               usage_unknown = p_actual_cost_usd IS NULL,
               updated_at = pg_catalog.clock_timestamp()
         WHERE reservation.reservation_key = p_reservation_key;
        v_row.state := 'settled';
        v_row.actual_cost_usd := p_actual_cost_usd;
        v_row.usage_unknown := p_actual_cost_usd IS NULL;
    ELSIF v_row.state = 'settled' AND v_row.actual_cost_usd IS NULL
          AND p_actual_cost_usd IS NOT NULL THEN
        UPDATE public.vertex_ai_budget_reservations AS reservation
           SET actual_cost_usd = p_actual_cost_usd,
               usage_unknown = FALSE,
               updated_at = pg_catalog.clock_timestamp()
         WHERE reservation.reservation_key = p_reservation_key;
        v_row.actual_cost_usd := p_actual_cost_usd;
        v_row.usage_unknown := FALSE;
    END IF;
    RETURN QUERY SELECT
        v_row.reservation_id, v_row.reservation_key, v_row.run_id, v_row.order_id,
        v_row.day_key, v_row.route, v_row.model_name, v_row.attempt,
        v_row.estimated_cost_usd, v_row.actual_cost_usd;
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_vertex_ai_budget(
    p_reservation_key TEXT,
    p_reservation_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_row public.vertex_ai_budget_reservations%ROWTYPE;
BEGIN
    IF p_reservation_key IS NULL OR p_reservation_id IS NULL THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_CANCELLATION_INVALID';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('vertex-ai-budget:all-scopes', 0)
    );
    SELECT reservation.*
      INTO v_row
      FROM public.vertex_ai_budget_reservations AS reservation
     WHERE reservation.reservation_key = p_reservation_key
     FOR UPDATE;
    IF NOT FOUND OR v_row.reservation_id IS DISTINCT FROM p_reservation_id THEN
        RAISE EXCEPTION 'VERTEX_AI_BUDGET_RESERVATION_UNKNOWN';
    END IF;
    IF v_row.state = 'reserved' THEN
        UPDATE public.vertex_ai_budget_reservations AS reservation
           SET state = 'cancelled', updated_at = pg_catalog.clock_timestamp()
         WHERE reservation.reservation_key = p_reservation_key;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.snapshot_vertex_ai_budget()
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path = ''
AS $$
WITH active AS (
    SELECT
        reservation.run_id,
        reservation.order_id,
        reservation.day_key::TEXT AS day_key,
        COALESCE(reservation.actual_cost_usd, reservation.estimated_cost_usd) AS amount
    FROM public.vertex_ai_budget_reservations AS reservation
    WHERE reservation.state IN ('reserved', 'settled')
),
run_totals AS (
    SELECT COALESCE(jsonb_object_agg(run_id, amount), '{}'::JSONB) AS value
    FROM (SELECT run_id, pg_catalog.sum(amount) AS amount FROM active GROUP BY run_id) grouped
),
order_totals AS (
    SELECT COALESCE(jsonb_object_agg(order_id, amount), '{}'::JSONB) AS value
    FROM (SELECT order_id, pg_catalog.sum(amount) AS amount FROM active GROUP BY order_id) grouped
),
day_totals AS (
    SELECT COALESCE(jsonb_object_agg(day_key, amount), '{}'::JSONB) AS value
    FROM (SELECT day_key, pg_catalog.sum(amount) AS amount FROM active GROUP BY day_key) grouped
)
SELECT jsonb_build_object(
    'run', (SELECT value FROM run_totals),
    'order', (SELECT value FROM order_totals),
    'day', (SELECT value FROM day_totals)
);
$$;

REVOKE ALL ON FUNCTION public.reserve_vertex_ai_budget(
    TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BIGINT, INTEGER, NUMERIC, DATE,
    NUMERIC, NUMERIC, NUMERIC
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_vertex_ai_budget(TEXT, UUID, NUMERIC) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_vertex_ai_budget(TEXT, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.snapshot_vertex_ai_budget() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.reserve_vertex_ai_budget(
    TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, BIGINT, INTEGER, NUMERIC, DATE,
    NUMERIC, NUMERIC, NUMERIC
) TO service_role;
GRANT EXECUTE ON FUNCTION public.settle_vertex_ai_budget(TEXT, UUID, NUMERIC) TO service_role;
GRANT EXECUTE ON FUNCTION public.cancel_vertex_ai_budget(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.snapshot_vertex_ai_budget() TO service_role;
