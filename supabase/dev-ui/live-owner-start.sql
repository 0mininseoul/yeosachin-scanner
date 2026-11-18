-- Apply after live-budget.sql to the registered Dev Supabase project.
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
        OR pg_catalog.to_regprocedure('public.load_e2e_test_runner_v1(uuid)') IS NULL
        OR pg_catalog.to_regprocedure(
            'public.dev_live_budget_check_v1(uuid,timestamptz,timestamptz,integer,integer)'
        ) IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_OWNER_START_WRONG_DATABASE';
    END IF;
END;
$dev_live$;

-- Keep the attempt binding even after expiry so delivery retries cannot renew it.
CREATE TABLE IF NOT EXISTS dev_live_budget.owner_starts (
    grant_id uuid PRIMARY KEY REFERENCES dev_live_budget.grants (grant_id),
    user_id uuid NOT NULL,
    attempt_id uuid NOT NULL,
    target_instagram_id text NOT NULL CHECK (target_instagram_id ~ '^[a-z0-9._]{1,30}$'),
    UNIQUE (user_id, attempt_id)
);
REVOKE ALL ON dev_live_budget.owner_starts FROM PUBLIC, anon, authenticated, service_role;

-- This audit marker identifies the single Kakao principal approved during Dev setup.
-- The site also verifies its configured Dev tester and authenticated session.
CREATE OR REPLACE FUNCTION dev_live_budget.owner_is_authorized(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT FROM public.account_e2e_test_runners AS runner
        JOIN auth.users AS owner ON owner.id = runner.account_id
        CROSS JOIN LATERAL public.load_e2e_test_runner_v1(owner.id) AS loaded
        WHERE owner.id = p_user_id
          AND runner.runner_plan = 'basic'
          AND runner.command_version = 'dev-live-basic-v1'
          AND loaded.runner_plan = 'basic'
          AND owner.raw_app_meta_data ->> 'provider' = 'kakao'
          AND EXISTS (
              SELECT FROM public.account_classification_audit AS audit
              WHERE audit.account_id = owner.id
                AND audit.command_version = runner.command_version
                AND audit.reason_code = 'DEV_LIVE_BASIC_TESTER'
                AND audit.next_account_class = 'e2e_test'
                AND audit.next_traffic_class = 'e2e_test'
                AND audit.next_lifecycle = 'active'
          )
          AND (SELECT count(*) FROM auth.identities AS identity WHERE identity.user_id = owner.id) = 1
          AND EXISTS (
              SELECT FROM auth.identities AS identity
              WHERE identity.user_id = owner.id AND identity.provider = 'kakao'
                AND identity.identity_data -> 'email_verified' = 'true'::jsonb
                AND lower(btrim(identity.identity_data ->> 'email')) = lower(btrim(owner.email))
          )
    );
$$;
REVOKE ALL ON FUNCTION dev_live_budget.owner_is_authorized(uuid) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dev_live_owner_start_ready_v1(p_user_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
    SELECT dev_live_budget.owner_is_authorized(p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.dev_live_owner_start_lookup_v1(
    p_grant_id uuid, p_user_id uuid, p_target_instagram_id text
) RETURNS jsonb
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = ''
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
      AND NOT grant_row.blocked
      AND grant_row.approved_at <= clock.checked_at
      AND grant_row.expires_at > clock.checked_at
      AND dev_live_budget.owner_is_authorized(p_user_id);
$$;

CREATE OR REPLACE FUNCTION public.dev_live_owner_start_v1(
    p_user_id uuid, p_target_instagram_id text, p_attempt_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    start_row dev_live_budget.owner_starts%ROWTYPE;
    issued_grant_id uuid;
    issued_at timestamptz;
    descriptor jsonb;
BEGIN
    IF p_user_id IS NULL OR p_target_instagram_id IS NULL OR p_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
        OR p_attempt_id IS NULL OR p_attempt_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        OR NOT dev_live_budget.owner_is_authorized(p_user_id) THEN
        RAISE EXCEPTION 'DEV_LIVE_OWNER_START_DENIED';
    END IF;

    -- Serialize with both the ledger reservations and repeat browser submissions.
    PERFORM pg_catalog.pg_advisory_xact_lock(49736740, 1);
    SELECT * INTO start_row
    FROM dev_live_budget.owner_starts AS existing
    WHERE existing.user_id = p_user_id AND existing.attempt_id = p_attempt_id;

    IF FOUND THEN
        IF start_row.target_instagram_id <> p_target_instagram_id THEN
            RAISE EXCEPTION 'DEV_LIVE_OWNER_START_TARGET_CONFLICT';
        END IF;
        issued_grant_id := start_row.grant_id;
    ELSE
        issued_grant_id := pg_catalog.gen_random_uuid();
        -- The descriptor is serialized in milliseconds. Persist the same precision
        -- so subsequent reservations must match the exact issued timestamps.
        issued_at := pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp());
        INSERT INTO dev_live_budget.grants (
            grant_id, approved_at, expires_at, apify_limit_micros, ai_limit_micros
        ) VALUES (
            issued_grant_id, issued_at, issued_at + interval '30 minutes', 5000000, 2000000
        );
        INSERT INTO dev_live_budget.owner_starts (grant_id, user_id, attempt_id, target_instagram_id)
        VALUES (issued_grant_id, p_user_id, p_attempt_id, p_target_instagram_id);
    END IF;

    descriptor := public.dev_live_owner_start_lookup_v1(issued_grant_id, p_user_id, p_target_instagram_id);
    IF descriptor IS NULL THEN
        RAISE EXCEPTION 'DEV_LIVE_OWNER_START_UNAVAILABLE';
    END IF;
    RETURN descriptor;
END;
$$;

-- Existing reservations continue to use their immutable, persisted grant. Each
-- owner start is independently capped. Older grants cannot overlap one another.
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

REVOKE ALL ON FUNCTION public.dev_live_owner_start_ready_v1(uuid),
    public.dev_live_owner_start_v1(uuid,text,uuid),
    public.dev_live_owner_start_lookup_v1(uuid,uuid,text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dev_live_owner_start_ready_v1(uuid),
    public.dev_live_owner_start_v1(uuid,text,uuid),
    public.dev_live_owner_start_lookup_v1(uuid,uuid,text)
    TO service_role;

COMMIT;
