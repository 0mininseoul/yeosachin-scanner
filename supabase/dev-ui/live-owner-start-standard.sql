-- Apply after live-owner-start.sql only in the registered Dev Supabase project.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $dev_live$
BEGIN
    IF pg_catalog.to_regclass('dev_ui.preflights') IS NULL
        OR pg_catalog.to_regclass('dev_ui.orders') IS NULL
        OR pg_catalog.to_regclass('dev_ui.runs') IS NULL
        OR pg_catalog.to_regclass('dev_live_budget.grants') IS NULL
        OR pg_catalog.to_regclass('dev_live_budget.reservations') IS NULL
        OR pg_catalog.to_regclass('dev_live_budget.owner_starts') IS NULL
        OR pg_catalog.to_regprocedure('dev_live_budget.owner_is_authorized(uuid)') IS NULL
        OR pg_catalog.to_regprocedure('public.load_e2e_test_runner_v1(uuid)') IS NULL
        OR pg_catalog.to_regprocedure('public.dev_live_owner_start_v1(uuid,text,uuid)') IS NULL
        OR pg_catalog.to_regprocedure('public.dev_live_owner_start_ready_v1(uuid)') IS NULL
        OR pg_catalog.to_regprocedure('public.dev_live_owner_start_lookup_v1(uuid,uuid,text)') IS NULL
        OR pg_catalog.to_regprocedure('public.dev_live_budget_check_v1(uuid,timestamptz,timestamptz,integer,integer)') IS NULL
        OR pg_catalog.to_regprocedure(
            'public.dev_live_budget_reserve_v1(uuid,timestamptz,timestamptz,integer,integer,uuid,text,integer)'
        ) IS NULL
        OR pg_catalog.to_regprocedure('public.dev_live_budget_settle_vertex_v1(uuid,uuid,integer)') IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_STANDARD_WRONG_DATABASE';
    END IF;
END;
$dev_live$;

-- The separate approval operation sets the target. This script seeds no policy.
CREATE TABLE IF NOT EXISTS dev_live_budget.standard_owner_policy (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    target_instagram_id text NOT NULL CHECK (target_instagram_id ~ '^[a-z0-9._]{1,30}$'),
    enabled boolean NOT NULL DEFAULT true,
    policy_id uuid NOT NULL UNIQUE
);
REVOKE ALL ON dev_live_budget.standard_owner_policy FROM PUBLIC, anon, authenticated, service_role;

-- A later approval cannot restore grants issued under a revoked or edited policy.
CREATE OR REPLACE FUNCTION dev_live_budget.stamp_standard_owner_policy()
RETURNS trigger
LANGUAGE plpgsql SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.policy_id := pg_catalog.gen_random_uuid();
    ELSIF NEW.target_instagram_id IS DISTINCT FROM OLD.target_instagram_id OR NEW.enabled IS DISTINCT FROM OLD.enabled THEN
        NEW.policy_id := pg_catalog.gen_random_uuid();
    ELSE
        NEW.policy_id := OLD.policy_id;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION dev_live_budget.stamp_standard_owner_policy() FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE TRIGGER stamp_standard_owner_policy
    BEFORE INSERT OR UPDATE ON dev_live_budget.standard_owner_policy
    FOR EACH ROW EXECUTE FUNCTION dev_live_budget.stamp_standard_owner_policy();

-- A grant retains its policy ID even after the policy is deleted. The shared
-- owner_starts uniqueness constraint binds each attempt to a single grant.
ALTER TABLE dev_live_budget.grants
    ADD COLUMN IF NOT EXISTS plan_id text NOT NULL DEFAULT 'basic',
    ADD COLUMN IF NOT EXISTS standard_policy_id uuid,
    DROP CONSTRAINT IF EXISTS grants_apify_limit_micros_check,
    DROP CONSTRAINT IF EXISTS grants_ai_limit_micros_check,
    DROP CONSTRAINT IF EXISTS grants_check,
    DROP CONSTRAINT IF EXISTS grants_plan_scope_check,
    ADD CONSTRAINT grants_plan_scope_check CHECK (
        expires_at > approved_at
        AND (
            (plan_id = 'basic'
                AND standard_policy_id IS NULL
                AND apify_limit_micros BETWEEN 10000 AND 5000000
                AND ai_limit_micros BETWEEN 10000 AND 2000000
                AND expires_at <= approved_at + interval '30 minutes')
            OR (plan_id = 'standard'
                AND standard_policy_id IS NOT NULL
                AND apify_limit_micros = 6000000
                AND ai_limit_micros = 4000000
                AND expires_at <= approved_at + interval '150 minutes')
        )
    );

CREATE OR REPLACE FUNCTION dev_live_budget.standard_policy_for_owner(p_user_id uuid, p_target_instagram_id text)
RETURNS uuid
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT policy.policy_id
    FROM dev_live_budget.standard_owner_policy AS policy
    WHERE policy.singleton AND policy.enabled
      AND policy.target_instagram_id = p_target_instagram_id
      AND dev_live_budget.owner_is_authorized(p_user_id);
$$;
REVOKE ALL ON FUNCTION dev_live_budget.standard_policy_for_owner(uuid,text)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION dev_live_budget.lookup_owner_start(
    p_grant_id uuid, p_user_id uuid, p_target_instagram_id text, p_plan_id text
) RETURNS jsonb
LANGUAGE sql VOLATILE SET search_path = ''
AS $$
    SELECT jsonb_build_object(
        'id', grant_row.grant_id,
        'targetInstagramId', start_row.target_instagram_id,
        'approvedAt', to_char(grant_row.approved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'expiresAt', to_char(grant_row.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'apifyMaxCents', grant_row.apify_limit_micros / 10000,
        'aiMaxCents', grant_row.ai_limit_micros / 10000
    )
    FROM dev_live_budget.owner_starts AS start_row
    JOIN dev_live_budget.grants AS grant_row ON grant_row.grant_id = start_row.grant_id
    CROSS JOIN (SELECT pg_catalog.clock_timestamp() AS checked_at) AS clock
    WHERE start_row.grant_id = p_grant_id
      AND start_row.user_id = p_user_id
      AND start_row.target_instagram_id = p_target_instagram_id
      AND grant_row.plan_id = p_plan_id
      AND NOT grant_row.blocked
      AND grant_row.approved_at <= clock.checked_at
      AND grant_row.expires_at > clock.checked_at
      AND CASE grant_row.plan_id
          WHEN 'basic' THEN dev_live_budget.owner_is_authorized(p_user_id)
          WHEN 'standard' THEN grant_row.standard_policy_id = dev_live_budget.standard_policy_for_owner(p_user_id, p_target_instagram_id)
      END;
$$;
REVOKE ALL ON FUNCTION dev_live_budget.lookup_owner_start(uuid,uuid,text,text)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dev_live_owner_start_lookup_v1(
    p_grant_id uuid, p_user_id uuid, p_target_instagram_id text
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT dev_live_budget.lookup_owner_start(p_grant_id, p_user_id, p_target_instagram_id, 'basic');
$$;

CREATE OR REPLACE FUNCTION public.dev_live_owner_start_lookup_v2(
    p_grant_id uuid, p_user_id uuid, p_target_instagram_id text
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT dev_live_budget.lookup_owner_start(p_grant_id, p_user_id, p_target_instagram_id, 'standard')
        || jsonb_build_object('planId', 'standard');
$$;

CREATE OR REPLACE FUNCTION public.dev_live_owner_start_ready_v2(p_user_id uuid, p_target_instagram_id text)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT dev_live_budget.standard_policy_for_owner(p_user_id, p_target_instagram_id) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION public.dev_live_owner_start_v2(
    p_user_id uuid, p_target_instagram_id text, p_attempt_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    approved_policy_id uuid;
    issued_grant_id uuid;
    issued_at timestamptz;
    existing_plan text;
    existing_target text;
    descriptor jsonb;
BEGIN
    IF p_user_id IS NULL OR p_target_instagram_id IS NULL OR p_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
        OR p_attempt_id IS NULL OR p_attempt_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
        RAISE EXCEPTION 'DEV_LIVE_OWNER_START_DENIED';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(49736740, 1);
    SELECT policy.policy_id INTO approved_policy_id
    FROM dev_live_budget.standard_owner_policy AS policy
    WHERE policy.policy_id = dev_live_budget.standard_policy_for_owner(p_user_id, p_target_instagram_id)
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'DEV_LIVE_OWNER_START_DENIED';
    END IF;

    SELECT existing.grant_id, grant_row.plan_id, existing.target_instagram_id
    INTO issued_grant_id, existing_plan, existing_target
    FROM dev_live_budget.owner_starts AS existing
    JOIN dev_live_budget.grants AS grant_row ON grant_row.grant_id = existing.grant_id
    WHERE existing.user_id = p_user_id AND existing.attempt_id = p_attempt_id;

    IF FOUND THEN
        IF existing_plan <> 'standard' THEN
            RAISE EXCEPTION 'DEV_LIVE_OWNER_START_PLAN_CONFLICT';
        END IF;
        IF existing_target <> p_target_instagram_id THEN
            RAISE EXCEPTION 'DEV_LIVE_OWNER_START_TARGET_CONFLICT';
        END IF;
    ELSE
        issued_grant_id := pg_catalog.gen_random_uuid();
        issued_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
        INSERT INTO dev_live_budget.grants (
            grant_id, approved_at, expires_at, apify_limit_micros, ai_limit_micros, plan_id, standard_policy_id
        ) VALUES (
            issued_grant_id, issued_at, issued_at + interval '150 minutes', 6000000, 4000000, 'standard', approved_policy_id
        );
        INSERT INTO dev_live_budget.owner_starts (grant_id, user_id, attempt_id, target_instagram_id)
        VALUES (issued_grant_id, p_user_id, p_attempt_id, p_target_instagram_id);
    END IF;

    descriptor := public.dev_live_owner_start_lookup_v2(issued_grant_id, p_user_id, p_target_instagram_id);
    IF descriptor IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_OWNER_START_UNAVAILABLE';
    END IF;
    RETURN descriptor;
END;
$$;

-- Keep Basic and legacy checks. Standard must also match a currently approved
-- policy ID, target and owner at admission and before every provider reservation.
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
    SELECT * INTO active_grant FROM dev_live_budget.grants AS grant_row WHERE grant_row.grant_id = p_grant_id;
    IF NOT FOUND OR active_grant.blocked
        OR active_grant.approved_at IS DISTINCT FROM p_approved_at
        OR active_grant.expires_at IS DISTINCT FROM p_expires_at
        OR active_grant.apify_limit_micros IS DISTINCT FROM p_apify_limit_micros
        OR active_grant.ai_limit_micros IS DISTINCT FROM p_ai_limit_micros
        OR active_grant.approved_at > checked_at OR active_grant.expires_at <= checked_at
        OR pg_catalog.has_function_privilege('service_role', pg_catalog.to_regprocedure(
            'public.dev_live_budget_reserve_v1(uuid,timestamptz,timestamptz,integer,integer,uuid,text,integer)'
        ), 'EXECUTE') IS DISTINCT FROM true
        OR pg_catalog.has_function_privilege('service_role', pg_catalog.to_regprocedure(
            'public.dev_live_budget_settle_vertex_v1(uuid,uuid,integer)'
        ), 'EXECUTE') IS DISTINCT FROM true
        OR (
            active_grant.plan_id = 'standard'
            AND NOT EXISTS (
                SELECT FROM dev_live_budget.owner_starts AS start_row
                WHERE start_row.grant_id = p_grant_id
                  AND dev_live_budget.standard_policy_for_owner(start_row.user_id, start_row.target_instagram_id)
                      = active_grant.standard_policy_id
            )
        )
        OR (
            NOT EXISTS (SELECT FROM dev_live_budget.owner_starts AS current_start WHERE current_start.grant_id = p_grant_id)
            AND EXISTS (
                SELECT FROM dev_live_budget.grants AS other
                WHERE other.grant_id <> p_grant_id AND other.expires_at > checked_at
                  AND NOT EXISTS (SELECT FROM dev_live_budget.owner_starts AS current_start WHERE current_start.grant_id = other.grant_id)
            )
        ) THEN
        RAISE EXCEPTION 'DEV_LIVE_BUDGET_UNAVAILABLE';
    END IF;
    RETURN 1;
END;
$$;

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
    PERFORM pg_catalog.pg_advisory_xact_lock(49736740, 1);
    IF EXISTS (SELECT FROM dev_live_budget.grants WHERE grant_id = p_grant_id AND plan_id = 'standard') THEN
        -- Order this reservation and a concurrent policy update or deletion.
        PERFORM 1 FROM dev_live_budget.standard_owner_policy WHERE singleton FOR SHARE;
    END IF;
    PERFORM public.dev_live_budget_check_v1(
        p_grant_id, p_approved_at, p_expires_at, p_apify_limit_micros, p_ai_limit_micros
    );
    SELECT * INTO STRICT active_grant FROM dev_live_budget.grants g WHERE g.grant_id = p_grant_id FOR UPDATE;
    IF active_grant.blocked OR active_grant.expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION 'DEV_LIVE_BUDGET_UNAVAILABLE';
    END IF;
    IF (p_provider = 'apify' AND p_amount_micros > active_grant.apify_limit_micros - active_grant.apify_committed_micros)
        OR (p_provider = 'vertex' AND p_amount_micros > active_grant.ai_limit_micros - active_grant.ai_committed_micros) THEN
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

REVOKE ALL ON FUNCTION public.dev_live_owner_start_ready_v2(uuid,text),
    public.dev_live_owner_start_v2(uuid,text,uuid),
    public.dev_live_owner_start_lookup_v2(uuid,uuid,text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dev_live_owner_start_ready_v2(uuid,text),
    public.dev_live_owner_start_v2(uuid,text,uuid),
    public.dev_live_owner_start_lookup_v2(uuid,uuid,text)
    TO service_role;

COMMIT;
