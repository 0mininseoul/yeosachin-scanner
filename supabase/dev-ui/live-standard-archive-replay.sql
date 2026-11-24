-- Install only on registered Dev, after live-owner-start-standard.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
    IF pg_catalog.to_regclass('dev_ui.preflights') IS NULL
       OR pg_catalog.to_regclass('dev_ui.orders') IS NULL
       OR pg_catalog.to_regclass('dev_ui.runs') IS NULL
       OR pg_catalog.to_regclass('dev_live_budget.standard_owner_policy') IS NULL
       OR pg_catalog.to_regclass('public.analysis_v2_test_entitlement_consumptions') IS NULL
       OR pg_catalog.to_regprocedure('public.dev_live_owner_start_v4(uuid,text,uuid)') IS NULL
       OR pg_catalog.to_regprocedure('dev_live_budget.reserve(uuid,timestamptz,timestamptz,integer,integer,uuid,text,integer,uuid,integer)') IS NULL THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_WRONG_DATABASE';
    END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS dev_live_budget.standard_archive_replay_grants (
    grant_id uuid PRIMARY KEY REFERENCES dev_live_budget.grants,
    source_grant_id uuid NOT NULL REFERENCES dev_live_budget.grants,
    slot_hash text NOT NULL CHECK (slot_hash ~ '^[0-9a-f]{64}$'),
    expires_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(expires_at)),
    CHECK (grant_id <> source_grant_id)
);
REVOKE ALL ON dev_live_budget.standard_archive_replay_grants FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION dev_live_budget.reject_archive_binding_change()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_BINDING_IMMUTABLE';
END;
$$;
REVOKE ALL ON FUNCTION dev_live_budget.reject_archive_binding_change() FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE TRIGGER reject_archive_binding_change
    BEFORE UPDATE OR DELETE OR TRUNCATE ON dev_live_budget.standard_archive_replay_grants
    FOR EACH STATEMENT EXECUTE FUNCTION dev_live_budget.reject_archive_binding_change();

-- The callers still prove the source owner and grant against the requested
-- target. Terminal scrub replaces the public rows' original target fields, so
-- accept the retained pair only with its exact, consumed Standard entitlement.
CREATE OR REPLACE FUNCTION dev_live_budget.standard_archive_source_target_matches_v1(
    p_preflight public.analysis_preflights, p_request public.analysis_requests,
    p_source_grant_id uuid, p_target_instagram_id text
) RETURNS boolean LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT CASE WHEN p_preflight.pii_scrubbed_at IS NULL THEN
        p_preflight.target_instagram_id = p_target_instagram_id
        AND p_request.target_instagram_id = p_target_instagram_id
    ELSE
        p_preflight.status = 'consumed'
        AND p_preflight.consumed_request_id = p_request.id
        AND p_request.preflight_id = p_preflight.id
        AND p_request.user_id = p_preflight.user_id
        AND p_request.status = 'completed'
        AND p_preflight.consumed_at <= p_request.completed_at
        AND p_request.completed_at <= p_preflight.pii_scrubbed_at
        AND p_preflight.pii_scrubbed_at <= pg_catalog.statement_timestamp()
        AND p_preflight.target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(p_preflight.id::text, '-', ''), 1, 20)
        AND p_request.target_instagram_id = 'retained.'
            || pg_catalog.substr(pg_catalog.replace(p_request.id::text, '-', ''), 1, 20)
        AND EXISTS (
            SELECT 1 FROM public.analysis_v2_test_entitlement_consumptions AS consumption
            WHERE consumption.preflight_id = p_preflight.id AND consumption.request_id = p_request.id
              AND consumption.user_id = p_request.user_id AND consumption.selected_plan_id = 'standard'
              AND consumption.entitlement_jti_hash = p_preflight.admission_entitlement_jti_hash
              AND consumption.entitlement_jti_hash = p_request.test_entitlement_jti_hash
              AND consumption.entitlement_jti_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                  'analysis-test-entitlement-jti-v1' || pg_catalog.chr(10) || 'dev-live-' || p_source_grant_id::text,
                  'UTF8'
              )), 'hex')
        )
    END;
$$;
REVOKE ALL ON FUNCTION dev_live_budget.standard_archive_source_target_matches_v1(
    public.analysis_preflights, public.analysis_requests, uuid, text
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.dev_live_standard_archive_replay_start_v1(
    p_user_id uuid, p_target_instagram_id text, p_attempt_id uuid, p_source_grant_id uuid, p_slot_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    previous_grant uuid;
    approval jsonb;
    destination uuid;
    deadline timestamptz;
BEGIN
    IF p_source_grant_id IS NULL OR p_slot_hash IS NULL OR p_slot_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE';
    END IF;
    -- Classify the attempt under the same issuance lock as Basic and Standard.
    -- An ordinary grant already visible to a worker must never be relabelled.
    PERFORM pg_catalog.pg_advisory_xact_lock(49736740, 1);
    SELECT grant_id INTO previous_grant FROM dev_live_budget.owner_starts
    WHERE user_id = p_user_id AND attempt_id = p_attempt_id;
    approval := public.dev_live_owner_start_v4(p_user_id, p_target_instagram_id, p_attempt_id);
    destination := (approval->>'id')::uuid;

    SELECT source.approved_at + interval '24 hours' INTO deadline
    FROM dev_live_budget.grants AS source
    JOIN public.analysis_preflights AS preflight
      ON preflight.user_id = p_user_id
     AND preflight.idempotency_key = 'dev-live:owner:standard:' || source.grant_id::text
    JOIN public.analysis_requests AS request
      ON request.id = preflight.consumed_request_id AND request.preflight_id = preflight.id
     AND request.user_id = p_user_id
    JOIN public.analysis_v2_test_entitlement_consumptions AS consumption
      ON consumption.preflight_id = preflight.id AND consumption.request_id = request.id
     AND consumption.user_id = p_user_id AND consumption.selected_plan_id = 'standard'
     AND consumption.entitlement_jti_hash = preflight.admission_entitlement_jti_hash
     AND consumption.entitlement_jti_hash = request.test_entitlement_jti_hash
    WHERE source.grant_id = p_source_grant_id AND source.grant_id <> destination
      AND public.dev_live_owner_start_lookup_v2(source.grant_id, p_user_id, p_target_instagram_id) IS NOT NULL
      AND dev_live_budget.standard_archive_source_target_matches_v1(
          preflight, request, source.grant_id, p_target_instagram_id
      )
      AND preflight.status = 'consumed' AND preflight.admission_status = 'ready'
      AND preflight.access_mode = 'test_entitlement' AND preflight.analysis_entry_channel = 'standard'
      AND preflight.admission_selected_plan_id = 'standard' AND preflight.beta_entry_provenance IS NULL
      AND request.status = 'completed' AND request.pipeline_version = 'v2'
      AND request.analysis_entry_channel = 'standard' AND request.plan_access_mode_snapshot = 'test_entitlement'
      AND request.selected_plan_id_snapshot = 'standard'
      AND consumption.entitlement_jti_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'analysis-test-entitlement-jti-v1' || pg_catalog.chr(10) || 'dev-live-' || source.grant_id::text, 'UTF8'
          )), 'hex')
      AND NOT EXISTS (SELECT FROM dev_live_budget.standard_archive_replay_grants WHERE grant_id = source.grant_id)
    FOR SHARE OF source, preflight, request, consumption;
    IF deadline IS NULL OR deadline <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_REPLAY_UNAVAILABLE';
    END IF;

    IF previous_grant IS NULL THEN
        INSERT INTO dev_live_budget.standard_archive_replay_grants (grant_id, source_grant_id, slot_hash, expires_at)
        VALUES (destination, p_source_grant_id, p_slot_hash, deadline);
    ELSIF NOT EXISTS (
        SELECT FROM dev_live_budget.standard_archive_replay_grants
        WHERE grant_id = destination AND source_grant_id = p_source_grant_id
          AND slot_hash = p_slot_hash AND expires_at = deadline
    ) THEN
        RAISE EXCEPTION 'DEV_STANDARD_ARCHIVE_REPLAY_CONFLICT';
    END IF;
    RETURN public.dev_live_owner_start_lookup_v2(destination, p_user_id, p_target_instagram_id);
END;
$$;

-- Keep the binding identifiable after expiry: a worker must never interpret
-- an expired replay grant as permission to start collecting live.
CREATE OR REPLACE FUNCTION public.dev_live_standard_archive_replay_lookup_v1(p_grant_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT pg_catalog.jsonb_build_object('sourceGrantId', source_grant_id, 'slotHash', slot_hash,
        'expiresAt', pg_catalog.to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    FROM dev_live_budget.standard_archive_replay_grants WHERE grant_id = p_grant_id;
$$;

REVOKE ALL ON FUNCTION public.dev_live_standard_archive_replay_start_v1(uuid,text,uuid,uuid,text),
    public.dev_live_standard_archive_replay_lookup_v1(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.dev_live_standard_archive_replay_start_v1(uuid,text,uuid,uuid,text),
    public.dev_live_standard_archive_replay_lookup_v1(uuid) TO service_role;

-- The ordinary worker lookup carries the binding in its existing round trip.
-- Keep an unauthorized lookup NULL even if a replay binding exists.
CREATE OR REPLACE FUNCTION public.dev_live_owner_start_lookup_v2(
    p_grant_id uuid, p_user_id uuid, p_target_instagram_id text
) RETURNS jsonb LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path = '' AS $$
    SELECT dev_live_budget.lookup_owner_start(p_grant_id, p_user_id, p_target_instagram_id, 'standard')
        || pg_catalog.jsonb_build_object('planId', 'standard')
        || CASE WHEN binding IS NULL THEN '{}'::jsonb
                ELSE pg_catalog.jsonb_build_object('archiveReplay', binding) END
    FROM (SELECT public.dev_live_standard_archive_replay_lookup_v1(p_grant_id) AS binding) AS replay;
$$;

-- Both reservation RPCs insert a new receipt before authorizing dispatch.
-- Settling previously reserved spend updates existing receipts and stays possible.
CREATE OR REPLACE FUNCTION dev_live_budget.guard_archive_replay_reservation()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF EXISTS (
        SELECT FROM dev_live_budget.standard_archive_replay_grants AS binding
        WHERE binding.grant_id = NEW.grant_id
          AND (NEW.provider = 'apify' OR binding.expires_at <= pg_catalog.clock_timestamp())
    ) THEN
        RAISE EXCEPTION 'DEV_LIVE_BUDGET_UNAVAILABLE';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION dev_live_budget.guard_archive_replay_reservation() FROM PUBLIC, anon, authenticated, service_role;
CREATE OR REPLACE TRIGGER guard_archive_replay_reservation
    BEFORE INSERT ON dev_live_budget.reservations FOR EACH ROW WHEN (NEW.provider = 'apify')
    EXECUTE FUNCTION dev_live_budget.guard_archive_replay_reservation();

-- Vertex can wait on the balance row after insertion. Check its replay deadline
-- at commit, before the service-role RPC returns permission to dispatch.
DROP TRIGGER IF EXISTS guard_archive_replay_vertex_deadline ON dev_live_budget.reservations;
CREATE CONSTRAINT TRIGGER guard_archive_replay_vertex_deadline
    AFTER INSERT ON dev_live_budget.reservations DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.provider = 'vertex') EXECUTE FUNCTION dev_live_budget.guard_archive_replay_reservation();

COMMIT;
