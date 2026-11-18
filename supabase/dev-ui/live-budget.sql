-- Dev-only one-run budget. Apply to the registered Dev database separately from the baseline.
BEGIN;

CREATE SCHEMA IF NOT EXISTS dev_live_budget;
REVOKE ALL ON SCHEMA dev_live_budget FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS dev_live_budget.grants (
    grant_id uuid PRIMARY KEY,
    approved_at timestamptz NOT NULL,
    expires_at timestamptz NOT NULL,
    apify_limit_micros integer NOT NULL CHECK (apify_limit_micros BETWEEN 10000 AND 5000000),
    ai_limit_micros integer NOT NULL CHECK (ai_limit_micros BETWEEN 10000 AND 2000000),
    apify_committed_micros integer NOT NULL DEFAULT 0 CHECK (apify_committed_micros >= 0),
    ai_committed_micros integer NOT NULL DEFAULT 0 CHECK (ai_committed_micros >= 0),
    blocked boolean NOT NULL DEFAULT false,
    CHECK (expires_at > approved_at AND expires_at <= approved_at + interval '30 minutes')
);

CREATE TABLE IF NOT EXISTS dev_live_budget.reservations (
    reservation_id uuid PRIMARY KEY,
    grant_id uuid NOT NULL REFERENCES dev_live_budget.grants (grant_id),
    provider text NOT NULL CHECK (provider IN ('apify', 'vertex')),
    reserved_micros integer NOT NULL CHECK (reserved_micros BETWEEN 1 AND 5000000),
    actual_micros integer CHECK (actual_micros >= 0)
);
REVOKE ALL ON ALL TABLES IN SCHEMA dev_live_budget FROM PUBLIC, anon, authenticated, service_role;

-- Also used by the web before queue admission. This method does not create a grant.
CREATE OR REPLACE FUNCTION public.dev_live_budget_check_v1(
    p_grant_id uuid, p_approved_at timestamptz, p_expires_at timestamptz,
    p_apify_limit_micros integer, p_ai_limit_micros integer
) RETURNS integer
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    active_grant dev_live_budget.grants%ROWTYPE;
    checked_at timestamptz := pg_catalog.statement_timestamp();
BEGIN
    IF p_grant_id IS NULL OR p_approved_at IS NULL OR p_expires_at IS NULL
        OR p_approved_at > checked_at OR p_expires_at <= checked_at
        OR p_expires_at > p_approved_at + interval '30 minutes'
        OR p_apify_limit_micros IS NULL OR p_apify_limit_micros NOT BETWEEN 10000 AND 5000000
        OR p_ai_limit_micros IS NULL OR p_ai_limit_micros NOT BETWEEN 10000 AND 2000000
        OR pg_catalog.has_function_privilege('service_role', pg_catalog.to_regprocedure(
            'public.dev_live_budget_reserve_v1(uuid,timestamptz,timestamptz,integer,integer,uuid,text,integer)'
        ), 'EXECUTE') IS DISTINCT FROM true
        OR pg_catalog.has_function_privilege('service_role', pg_catalog.to_regprocedure(
            'public.dev_live_budget_settle_vertex_v1(uuid,uuid,integer)'
        ), 'EXECUTE') IS DISTINCT FROM true
        OR EXISTS (
            SELECT 1 FROM dev_live_budget.grants g
            WHERE g.grant_id <> p_grant_id AND g.expires_at > checked_at
        ) THEN
        RAISE EXCEPTION 'DEV_LIVE_BUDGET_UNAVAILABLE';
    END IF;
    SELECT * INTO active_grant FROM dev_live_budget.grants g WHERE g.grant_id = p_grant_id;
    IF FOUND AND (active_grant.blocked
        OR active_grant.approved_at <> p_approved_at OR active_grant.expires_at <> p_expires_at
        OR active_grant.apify_limit_micros <> p_apify_limit_micros
        OR active_grant.ai_limit_micros <> p_ai_limit_micros) THEN
        RAISE EXCEPTION 'DEV_LIVE_BUDGET_UNAVAILABLE';
    END IF;
    RETURN 1;
END;
$$;

-- One transaction locks the active grant and commits the maximum before SDK dispatch.
-- A duplicate reservation never grants permission to send another provider request.
CREATE OR REPLACE FUNCTION public.dev_live_budget_reserve_v1(
    p_grant_id uuid, p_approved_at timestamptz, p_expires_at timestamptz,
    p_apify_limit_micros integer, p_ai_limit_micros integer,
    p_reservation_id uuid, p_provider text, p_amount_micros integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    active_grant dev_live_budget.grants%ROWTYPE;
BEGIN
    IF p_reservation_id IS NULL OR p_provider IS NULL OR p_provider NOT IN ('apify', 'vertex')
        OR p_amount_micros IS NULL OR p_amount_micros NOT BETWEEN 1 AND 5000000 THEN
        RAISE EXCEPTION 'DEV_LIVE_BUDGET_UNAVAILABLE';
    END IF;
    -- Across grants as well as individual operations, prevent overlapping approval runs.
    PERFORM pg_catalog.pg_advisory_xact_lock(49736740, 1);
    PERFORM public.dev_live_budget_check_v1(
        p_grant_id, p_approved_at, p_expires_at, p_apify_limit_micros, p_ai_limit_micros
    );
    INSERT INTO dev_live_budget.grants (
        grant_id, approved_at, expires_at, apify_limit_micros, ai_limit_micros
    ) VALUES (
        p_grant_id, p_approved_at, p_expires_at, p_apify_limit_micros, p_ai_limit_micros
    ) ON CONFLICT (grant_id) DO NOTHING;
    SELECT * INTO STRICT active_grant FROM dev_live_budget.grants g WHERE g.grant_id = p_grant_id FOR UPDATE;
    IF active_grant.blocked OR active_grant.expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION 'DEV_LIVE_BUDGET_UNAVAILABLE';
    END IF;
    IF (p_provider = 'apify' AND active_grant.apify_committed_micros + p_amount_micros > active_grant.apify_limit_micros)
        OR (p_provider = 'vertex' AND active_grant.ai_committed_micros + p_amount_micros > active_grant.ai_limit_micros) THEN
        RETURN false;
    END IF;
    INSERT INTO dev_live_budget.reservations (reservation_id, grant_id, provider, reserved_micros)
    VALUES (p_reservation_id, p_grant_id, p_provider, p_amount_micros);
    IF p_provider = 'apify' THEN
        UPDATE dev_live_budget.grants SET apify_committed_micros = apify_committed_micros + p_amount_micros
        WHERE grant_id = p_grant_id;
    ELSE
        UPDATE dev_live_budget.grants SET ai_committed_micros = ai_committed_micros + p_amount_micros
        WHERE grant_id = p_grant_id;
    END IF;
    RETURN true;
END;
$$;

-- Only complete Vertex usage may release a portion of a reservation. Apify
-- reservations keep the whole possible charge including ambiguous starts.
CREATE OR REPLACE FUNCTION public.dev_live_budget_settle_vertex_v1(
    p_grant_id uuid, p_reservation_id uuid, p_actual_micros integer
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    charge dev_live_budget.reservations%ROWTYPE;
BEGIN
    IF p_grant_id IS NULL OR p_reservation_id IS NULL OR p_actual_micros IS NULL OR p_actual_micros < 0 THEN
        RAISE EXCEPTION 'DEV_LIVE_BUDGET_UNAVAILABLE';
    END IF;
    PERFORM 1 FROM dev_live_budget.grants g WHERE g.grant_id = p_grant_id FOR UPDATE;
    SELECT * INTO STRICT charge FROM dev_live_budget.reservations r
    WHERE r.reservation_id = p_reservation_id AND r.grant_id = p_grant_id AND r.provider = 'vertex' FOR UPDATE;
    IF p_actual_micros > charge.reserved_micros
        OR (charge.actual_micros IS NOT NULL AND charge.actual_micros <> p_actual_micros) THEN
        UPDATE dev_live_budget.grants SET blocked = true WHERE grant_id = p_grant_id;
        RETURN false;
    END IF;
    IF charge.actual_micros IS NOT NULL THEN RETURN true; END IF;
    UPDATE dev_live_budget.reservations SET actual_micros = p_actual_micros WHERE reservation_id = p_reservation_id;
    UPDATE dev_live_budget.grants SET ai_committed_micros = ai_committed_micros - charge.reserved_micros + p_actual_micros
    WHERE grant_id = p_grant_id;
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.dev_live_budget_check_v1(uuid,timestamptz,timestamptz,integer,integer),
    public.dev_live_budget_reserve_v1(uuid,timestamptz,timestamptz,integer,integer,uuid,text,integer),
    public.dev_live_budget_settle_vertex_v1(uuid,uuid,integer)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dev_live_budget_check_v1(uuid,timestamptz,timestamptz,integer,integer),
    public.dev_live_budget_reserve_v1(uuid,timestamptz,timestamptz,integer,integer,uuid,text,integer),
    public.dev_live_budget_settle_vertex_v1(uuid,uuid,integer) TO service_role;

COMMIT;
