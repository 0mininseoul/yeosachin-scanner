-- Operational-policy-v1 contraction manifest.
--
-- This migration is intentionally gated by an operator-supplied, fresh
-- read-only evidence hash.  It is a change set only: production application is
-- prohibited until the independent evidence, old-revision drain, and approval
-- have been verified outside this migration.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $$
DECLARE
    v_expected_approved_subset CONSTANT TEXT[] := ARRAY[
        'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache',
        'analysis_costs', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ];
    v_approved_subset TEXT[];
    v_approved_subset_json JSONB;
    v_missing TEXT[];
BEGIN
    IF pg_catalog.to_regclass('public.analysis_jobs') IS NULL
       OR pg_catalog.to_regclass('public.analysis_events') IS NULL
       OR pg_catalog.to_regclass('public.analysis_provider_runs') IS NULL
       OR pg_catalog.to_regclass('public.analysis_v2_provider_runs') IS NULL
       OR pg_catalog.to_regclass('public.payment_events') IS NULL
       OR pg_catalog.to_regclass('public.payment_pending') IS NULL
       OR pg_catalog.to_regclass('public.payments') IS NULL
       OR pg_catalog.to_regclass('public.payment_orders') IS NULL
       OR pg_catalog.to_regclass('public.earlybird_orders') IS NULL
       OR pg_catalog.to_regclass('public.pending_analysis') IS NULL
       OR pg_catalog.to_regclass('public.maintenance_jobs') IS NULL
       OR pg_catalog.to_regclass('public.account_lifecycle') IS NULL
       OR pg_catalog.to_regclass('public.analysis_order_audit_assembly_queue') IS NULL
       OR pg_catalog.to_regclass('public.analysis_order_audit_bundles') IS NULL
       OR pg_catalog.to_regclass('public.analysis_order_audit_candidates') IS NULL
       OR pg_catalog.to_regclass('public.analysis_order_audit_interactions') IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_RETAINED_PRECONDITION_FAILED',
            ERRCODE = '55000';
    END IF;

    SELECT COALESCE(pg_catalog.array_agg(candidate.name ORDER BY candidate.name), '{}'::TEXT[])
    INTO v_missing
    FROM pg_catalog.unnest(v_expected_approved_subset) AS candidate(name)
    WHERE pg_catalog.to_regclass('public.' || candidate.name) IS NULL;
    IF pg_catalog.cardinality(v_missing) > 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_W1A_PRECONDITION_FAILED: missing candidate',
            DETAIL = pg_catalog.array_to_string(v_missing, ','),
            ERRCODE = '55000';
    END IF;

    IF pg_catalog.to_regprocedure('public.append_analysis_canonical_artifact(uuid,uuid,text,text,text,text,jsonb,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.append_analysis_canonical_cost(uuid,text,text,text,character,numeric,numeric,boolean,text,jsonb,text,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.upsert_analysis_canonical_cache(uuid,text,text,text,timestamptz,text,jsonb)') IS NULL
       OR pg_catalog.to_regprocedure('public.append_analysis_canonical_audit(uuid,integer,text,text,integer,text,text,text,jsonb,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.append_analysis_canonical_late_cost_audit(uuid,text,text,text,character,numeric,numeric,boolean,text,text,jsonb,text,text,jsonb,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.enqueue_analysis_canonical_retry(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.load_analysis_canonical_family(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.apply_analysis_canonical_backfill_row(text,text,text,text,text,uuid,jsonb)') IS NULL
       OR pg_catalog.to_regprocedure('public.upsert_fulfillment_job_v1(uuid,uuid,text,smallint,bigint,uuid,timestamptz,timestamptz,text,jsonb,timestamptz,timestamptz,timestamptz,timestamptz)') IS NULL
       OR pg_catalog.to_regprocedure('public.enqueue_notification_v1(text,text,text,jsonb,text,boolean)') IS NULL
       OR pg_catalog.to_regprocedure('public.record_system_configuration_v1(text,integer,text,jsonb,text,timestamptz)') IS NULL
       OR pg_catalog.to_regprocedure('public.acquire_system_lease_v1(text,text,text,integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.claim_notification_outbox_v1(integer,text,integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.finish_notification_outbox_v1(uuid,uuid,bigint,text,text,integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.reconcile_stale_notification_outbox_v1(integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.list_notification_legacy_outbox_v1(integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.list_notification_outbox_v1(integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.record_analysis_canonical_job(uuid,text,text,text,bigint,integer,integer,timestamptz,timestamptz,text,jsonb,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.append_analysis_canonical_event(uuid,uuid,text,text,jsonb,text,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.record_payment_event_v1(text,text,text,text,uuid,text,text,text,jsonb,timestamptz,integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.append_account_lifecycle_v1(uuid,text,text,jsonb,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.enqueue_maintenance_job_v1(text,text,jsonb,text,boolean)') IS NULL
       OR pg_catalog.to_regprocedure('public.mirror_account_deletion_job_v1(uuid)') IS NULL
       OR pg_catalog.to_regprocedure('public.claim_maintenance_jobs_v1(integer,text,integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.finish_maintenance_job_v1(uuid,uuid,bigint,text,text,integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.reconcile_stale_maintenance_jobs_v1(integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.backfill_account_deletion_jobs_v1(integer,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.collect_account_deletion_parity_v1()') IS NULL
       OR pg_catalog.to_regprocedure('public.load_analysis_order_audit_bundle(uuid,text,integer,integer,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.list_analysis_order_audit_bundles(timestamptz,uuid,integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.claim_analysis_order_audit_bundle(uuid,integer)') IS NULL
       OR pg_catalog.to_regprocedure('public.read_analysis_order_audit_parity_snapshot(uuid)') IS NULL
       OR pg_catalog.to_regprocedure('public.analysis_canonical_json_object_has_exact_keys(jsonb,text[])') IS NULL
       OR pg_catalog.to_regprocedure('public.analysis_canonical_json_value_valid(jsonb)') IS NULL
       OR pg_catalog.to_regprocedure('public.analysis_canonical_payload_valid(jsonb)') IS NULL
       OR pg_catalog.to_regprocedure('public.analysis_canonical_payload_has_only_keys(jsonb,text[])') IS NULL
       OR pg_catalog.to_regprocedure('public.canonical_system_configuration_json(jsonb)') IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_W1A_RPC_PRECONDITION_FAILED',
            ERRCODE = '55000';
    END IF;
    IF pg_catalog.to_regprocedure('public.enqueue_analysis_execution_retry_v1(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.load_analysis_execution_family_v1(uuid,text)') IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_RETAINED_RPC_PRECONDITION_FAILED',
            ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.unnest(ARRAY[
            'analysis_jobs_dispatch_idx',
            'analysis_events_request_created_idx',
            'analysis_events_retry_key_idx',
            'analysis_events_backfill_copy_key_idx',
            'payment_events_order_recorded_idx',
            'account_lifecycle_account_recorded_idx',
            'maintenance_jobs_recovery_idx',
            'analysis_artifacts_request_kind_idx',
            'analysis_costs_request_recorded_idx',
            'analysis_costs_request_idempotency_idx',
            'analysis_cache_expiry_idx',
            'analysis_cache_request_updated_idx',
            'analysis_audit_request_version_idx',
            'analysis_audit_request_idempotency_idx',
            'fulfillment_jobs_recovery_idx',
            'notification_outbox_delivery_idx',
            'system_configuration_effective_idx',
            'system_leases_expiry_idx'
        ]::TEXT[]) AS expected(name)
        WHERE NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS relation
            JOIN pg_catalog.pg_namespace AS namespace
              ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public'
              AND relation.relname = expected.name
              AND relation.relkind = 'i'
        )
    ) OR EXISTS (
        SELECT 1
        FROM (VALUES
            ('analysis_events_append_only', 'analysis_events'),
            ('analysis_costs_append_only', 'analysis_costs'),
            ('analysis_audit_bundles_append_only', 'analysis_audit_bundles'),
            ('system_configuration_immutable', 'system_configuration'),
            ('payment_events_immutable', 'payment_events'),
            ('account_lifecycle_immutable', 'account_lifecycle')
        ) AS expected(trigger_name, table_name)
        WHERE NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_trigger AS trigger_row
            WHERE trigger_row.tgname = expected.trigger_name
              AND trigger_row.tgrelid = pg_catalog.to_regclass('public.' || expected.table_name)
              AND trigger_row.tgisinternal = false
        )
    ) OR pg_catalog.to_regclass('public.analysis_costs_id_seq') IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_depend AS sequence_dependency
           WHERE sequence_dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
             AND sequence_dependency.objid = pg_catalog.to_regclass('public.analysis_costs_id_seq')
             AND sequence_dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
             AND sequence_dependency.refobjid = pg_catalog.to_regclass('public.analysis_costs')
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_OBJECT_PRECONDITION_FAILED',
            ERRCODE = '55000';
    END IF;

    -- The session must carry a reviewed subset of the upper bound and a
    -- no-CASCADE manifest digest. A missing, malformed, duplicated, or
    -- out-of-bound family is deliberately a hard failure.
    BEGIN
        v_approved_subset_json := current_setting(
            'app.supabase_operational_policy_approved_subset', true
        )::JSONB;
    EXCEPTION WHEN OTHERS THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_FRESH_EVIDENCE_REQUIRED',
            ERRCODE = '55000';
    END;
    IF v_approved_subset_json IS NULL
       OR pg_catalog.jsonb_typeof(v_approved_subset_json) <> 'array'
       OR (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_array_elements_text(v_approved_subset_json))
          <> (SELECT pg_catalog.count(DISTINCT value) FROM pg_catalog.jsonb_array_elements_text(v_approved_subset_json))
       OR EXISTS (
           SELECT 1
           FROM pg_catalog.jsonb_array_elements_text(v_approved_subset_json) AS candidate(value)
           WHERE candidate.value IS NULL
              OR pg_catalog.btrim(candidate.value) = ''
              OR candidate.value <> ALL (v_expected_approved_subset)
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_FRESH_EVIDENCE_REQUIRED',
            ERRCODE = '55000';
    END IF;
    SELECT COALESCE(
        pg_catalog.array_agg(candidate.value ORDER BY candidate.value),
        '{}'::TEXT[]
    )
    INTO v_approved_subset
    FROM pg_catalog.jsonb_array_elements_text(v_approved_subset_json) AS candidate(value);
    IF COALESCE(current_setting('app.supabase_operational_policy_no_cascade_hash', true), '')
            !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_FRESH_EVIDENCE_REQUIRED',
            ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'public'
          AND relation.relname = ANY(v_expected_approved_subset)
          AND (
              relation.relrowsecurity IS DISTINCT FROM true
              OR relation.relforcerowsecurity IS DISTINCT FROM true
              OR pg_catalog.has_table_privilege('public', relation.oid, 'SELECT')
              OR pg_catalog.has_table_privilege('public', relation.oid, 'INSERT')
              OR pg_catalog.has_table_privilege('public', relation.oid, 'UPDATE')
              OR pg_catalog.has_table_privilege('public', relation.oid, 'DELETE')
              OR pg_catalog.has_table_privilege('anon', relation.oid, 'SELECT')
              OR pg_catalog.has_table_privilege('anon', relation.oid, 'INSERT')
              OR pg_catalog.has_table_privilege('anon', relation.oid, 'UPDATE')
              OR pg_catalog.has_table_privilege('anon', relation.oid, 'DELETE')
              OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'SELECT')
              OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'INSERT')
              OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'UPDATE')
              OR pg_catalog.has_table_privilege('authenticated', relation.oid, 'DELETE')
              OR pg_catalog.has_table_privilege('service_role', relation.oid, 'SELECT')
              OR pg_catalog.has_table_privilege('service_role', relation.oid, 'INSERT')
              OR pg_catalog.has_table_privilege('service_role', relation.oid, 'UPDATE')
              OR pg_catalog.has_table_privilege('service_role', relation.oid, 'DELETE')
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_SECURITY_PRECONDITION_FAILED',
            ERRCODE = '55000';
    END IF;

    -- No dependent relation/view/constraint may be removed implicitly.  The
    -- only relation dependencies admitted here are the named W1A tables,
    -- indexes, triggers, and policies that this file removes explicitly.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_class AS target
          ON target.oid = dependency.refobjid
        JOIN pg_catalog.pg_namespace AS target_ns
          ON target_ns.oid = target.relnamespace
        LEFT JOIN pg_catalog.pg_class AS dependent
          ON dependent.oid = dependency.objid
        LEFT JOIN pg_catalog.pg_namespace AS dependent_ns
          ON dependent_ns.oid = dependent.relnamespace
        WHERE target_ns.nspname = 'public'
          AND target.relname = ANY(v_approved_subset)
          AND dependency.refclassid = 'pg_catalog.pg_class'::pg_catalog.regclass
          AND dependency.deptype NOT IN ('i', 'a')
          AND NOT (
              (
                  dependency.classid = 'pg_catalog.pg_constraint'::pg_catalog.regclass
                  AND EXISTS (
                      SELECT 1
                      FROM pg_catalog.pg_constraint AS constraint_row
                      WHERE constraint_row.oid = dependency.objid
                        AND constraint_row.conrelid = target.oid
                  )
              )
              OR (
                  dependency.classid = 'pg_catalog.pg_trigger'::pg_catalog.regclass
                  AND EXISTS (
                      SELECT 1
                      FROM pg_catalog.pg_trigger AS trigger_row
                      WHERE trigger_row.oid = dependency.objid
                        AND trigger_row.tgrelid = target.oid
                  )
              )
              OR (
                  dependency.classid = 'pg_catalog.pg_policy'::pg_catalog.regclass
                  AND EXISTS (
                      SELECT 1
                      FROM pg_catalog.pg_policy AS policy_row
                      WHERE policy_row.oid = dependency.objid
                        AND policy_row.polrelid = target.oid
                  )
              )
              OR (
                  dependency.classid = 'pg_catalog.pg_class'::pg_catalog.regclass
                  AND dependent_ns.nspname = 'public'
                  AND dependent.relname = ANY(ARRAY[
                      'analysis_artifacts_request_kind_idx',
                      'analysis_costs_request_recorded_idx',
                      'analysis_costs_request_idempotency_idx',
                      'analysis_cache_expiry_idx',
                      'analysis_cache_request_updated_idx',
                      'analysis_audit_request_version_idx',
                      'analysis_audit_request_idempotency_idx',
                      'fulfillment_jobs_recovery_idx',
                      'notification_outbox_delivery_idx',
                      'system_configuration_effective_idx',
                      'system_leases_expiry_idx'
                  ])
              )
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_DEPENDENCY_PRECONDITION_FAILED',
            ERRCODE = '55000';
    END IF;

END;
$$;

-- Retained execution validator: only jobs/events payload vocabulary survives.
CREATE OR REPLACE FUNCTION public.analysis_canonical_json_value_valid(p_value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    v_entry RECORD;
BEGIN
    IF p_value IS NULL THEN RETURN FALSE; END IF;
    IF pg_catalog.jsonb_typeof(p_value) = 'string'
       AND pg_catalog.char_length(p_value #>> '{}') > 8192 THEN RETURN FALSE; END IF;
    IF pg_catalog.jsonb_typeof(p_value) = 'array' THEN
        IF pg_catalog.jsonb_array_length(p_value) > 100 THEN RETURN FALSE; END IF;
        FOR v_entry IN SELECT value FROM pg_catalog.jsonb_array_elements(p_value) LOOP
            IF NOT public.analysis_canonical_json_value_valid(v_entry.value) THEN RETURN FALSE; END IF;
        END LOOP;
        RETURN TRUE;
    END IF;
    IF pg_catalog.jsonb_typeof(p_value) <> 'object' THEN RETURN TRUE; END IF;
    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_object_keys(p_value)) > 64 THEN RETURN FALSE; END IF;
    FOR v_entry IN SELECT key, value FROM pg_catalog.jsonb_each(p_value) LOOP
        IF v_entry.key = 'schemaVersion' AND v_entry.value <> '1'::JSONB THEN RETURN FALSE; END IF;
        IF v_entry.key NOT IN (
            'schemaVersion', 'successorCount', 'track', 'batch', 'jobKey', 'generation',
            'attemptCount', 'dependencyCount', 'completionHash', 'requestStatus', 'state',
            'counts', 'eventCode', 'copyCode', 'aggregateCount', 'tracks', 'relationshipAi',
            'interactions', 'finalization', 'stageCode', 'done', 'total', 'completed',
            'lowSeconds', 'highSeconds', 'orderHash', 'providerOperation', 'family', 'retryKey'
        ) THEN RETURN FALSE; END IF;
        IF pg_catalog.lower(v_entry.key) IN (
            'provider_token', 'access_token', 'cookie', 'cookies', 'authorization', 'secret',
            'raw', 'raw_source', 'raw_provider_payload', 'synthetic', 'placeholder',
            'partial_evidence'
        ) THEN RETURN FALSE; END IF;
    END LOOP;
    RETURN TRUE;
END;
$$;

-- Keep the existing constraint function signature while removing all W1A key
-- vocabulary from its accepted input. Existing jobs/events constraints remain.
CREATE OR REPLACE FUNCTION public.analysis_canonical_payload_has_only_keys(
    p_payload JSONB,
    p_keys TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_payload IS NOT NULL
       AND pg_catalog.jsonb_typeof(p_payload) = 'object'
       AND p_payload ? 'schemaVersion'
       AND p_payload -> 'schemaVersion' = '1'::JSONB
       AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.jsonb_object_keys(p_payload) AS key
           WHERE key <> ALL (p_keys)
       )
       AND public.analysis_canonical_json_value_valid(p_payload);
$$;

CREATE FUNCTION public.enqueue_analysis_execution_retry_v1(
    p_request_id UUID,
    p_family TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_key TEXT := p_request_id::TEXT || ':' || p_family;
    v_hash TEXT := pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(v_key, 'UTF8'), 'sha256'), 'hex'
    );
    v_row public.analysis_events;
BEGIN
    IF p_request_id IS NULL OR p_family NOT IN ('jobs', 'events') THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_RETRY_FAMILY' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.analysis_events(
        request_id, kind, state, payload, content_hash, retention_class
    ) VALUES (
        p_request_id, 'operational', 'canonical_retry',
        pg_catalog.jsonb_build_object('family', p_family, 'retryKey', v_key),
        v_hash, 'standard'
    )
    ON CONFLICT (request_id, state, content_hash)
        WHERE kind = 'operational' AND state = 'canonical_retry'
    DO NOTHING
    RETURNING * INTO v_row;
    IF v_row.id IS NULL THEN
        SELECT * INTO v_row FROM public.analysis_events
        WHERE request_id = p_request_id AND kind = 'operational'
          AND state = 'canonical_retry' AND content_hash = v_hash;
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'id', v_row.id, 'request_id', v_row.request_id, 'kind', v_row.kind,
        'state', v_row.state, 'payload', v_row.payload,
        'content_hash', v_row.content_hash, 'retention_class', v_row.retention_class,
        'created_at', pg_catalog.to_char(v_row.created_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
END;
$$;

CREATE FUNCTION public.load_analysis_execution_family_v1(
    p_request_id UUID,
    p_family TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL OR p_family NOT IN ('jobs', 'events') THEN
        RAISE EXCEPTION 'ANALYSIS_CANONICAL_INVALID_READ_FAMILY' USING ERRCODE = '22023';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'jobs', CASE WHEN p_family = 'jobs' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM (
                SELECT source_row.* FROM public.analysis_jobs AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.created_at, source_row.id LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END,
        'events', CASE WHEN p_family = 'events' THEN COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.to_jsonb(row) ORDER BY row.created_at, row.id)
            FROM (
                SELECT source_row.* FROM public.analysis_events AS source_row
                WHERE source_row.request_id = p_request_id
                ORDER BY source_row.created_at, source_row.id LIMIT 100
            ) AS row
        ), '[]'::JSONB) ELSE '[]'::JSONB END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_analysis_execution_retry_v1(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_analysis_execution_retry_v1(UUID, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_execution_family_v1(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_execution_family_v1(UUID, TEXT) TO service_role;

-- Explicit W1A dependency closure. Every object is named; no implicit
-- dependent deletion is allowed. The reviewed approvedSubset may be smaller
-- than the upper bound, so each family is contracted independently.
DO $$
DECLARE
    v_approved_subset TEXT[];
    v_drop_routine_oids OID[] := '{}'::OID[];
BEGIN
    SELECT COALESCE(
        pg_catalog.array_agg(candidate.value ORDER BY candidate.value),
        '{}'::TEXT[]
    )
    INTO v_approved_subset
    FROM pg_catalog.jsonb_array_elements_text(
        current_setting('app.supabase_operational_policy_approved_subset', true)::JSONB
    ) AS candidate(value);

    IF 'analysis_costs' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TRIGGER analysis_costs_append_only ON public.analysis_costs';
    END IF;
    IF 'analysis_audit_bundles' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TRIGGER analysis_audit_bundles_append_only ON public.analysis_audit_bundles';
    END IF;
    IF 'system_configuration' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TRIGGER system_configuration_immutable ON public.system_configuration';
    END IF;

    IF 'analysis_artifacts' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP INDEX public.analysis_artifacts_request_kind_idx';
    END IF;
    IF 'analysis_costs' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP INDEX public.analysis_costs_request_recorded_idx';
        EXECUTE 'DROP INDEX public.analysis_costs_request_idempotency_idx';
    END IF;
    IF 'analysis_cache' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP INDEX public.analysis_cache_expiry_idx';
        EXECUTE 'DROP INDEX public.analysis_cache_request_updated_idx';
    END IF;
    IF 'analysis_audit_bundles' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP INDEX public.analysis_audit_request_version_idx';
        EXECUTE 'DROP INDEX public.analysis_audit_request_idempotency_idx';
    END IF;
    IF 'fulfillment_jobs' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP INDEX public.fulfillment_jobs_recovery_idx';
    END IF;
    IF 'notification_outbox' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP INDEX public.notification_outbox_delivery_idx';
    END IF;
    IF 'system_configuration' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP INDEX public.system_configuration_effective_idx';
    END IF;
    IF 'system_leases' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP INDEX public.system_leases_expiry_idx';
    END IF;

    -- Family-local routines are only removed with their approved table family.
    -- The three mixed-surface entry points are different: their jobs/events
    -- branch is replaced above, and their abandoned backfill surface has no
    -- retained caller, so they are explicitly closed for every subset.
    IF 'analysis_artifacts' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := pg_catalog.array_append(
            v_drop_routine_oids,
            pg_catalog.to_regprocedure(
                'public.append_analysis_canonical_artifact(uuid,uuid,text,text,text,text,jsonb,text)'
            )::OID
        );
    END IF;
    IF 'analysis_costs' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := v_drop_routine_oids || ARRAY[
            pg_catalog.to_regprocedure(
                'public.append_analysis_canonical_cost(uuid,text,text,text,character,numeric,numeric,boolean,text,jsonb,text,text)'
            )::OID
        ];
    END IF;
    IF 'analysis_cache' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := v_drop_routine_oids || ARRAY[
            pg_catalog.to_regprocedure(
                'public.upsert_analysis_canonical_cache(uuid,text,text,text,timestamptz,text,jsonb)'
            )::OID
        ];
    END IF;
    IF 'analysis_audit_bundles' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := v_drop_routine_oids || ARRAY[
            pg_catalog.to_regprocedure(
                'public.append_analysis_canonical_audit(uuid,integer,text,text,integer,text,text,text,jsonb,text)'
            )::OID
        ];
    END IF;
    IF 'analysis_costs' = ANY(v_approved_subset)
       AND 'analysis_audit_bundles' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := v_drop_routine_oids || ARRAY[
            pg_catalog.to_regprocedure(
                'public.append_analysis_canonical_late_cost_audit(uuid,text,text,text,character,numeric,numeric,boolean,text,text,jsonb,text,text,jsonb,text)'
            )::OID
        ];
    END IF;
    IF 'fulfillment_jobs' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := v_drop_routine_oids || ARRAY[
            pg_catalog.to_regprocedure(
                'public.upsert_fulfillment_job_v1(uuid,uuid,text,smallint,bigint,uuid,timestamptz,timestamptz,text,jsonb,timestamptz,timestamptz,timestamptz,timestamptz)'
            )::OID
        ];
    END IF;
    IF 'notification_outbox' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := v_drop_routine_oids || ARRAY[
            pg_catalog.to_regprocedure('public.enqueue_notification_v1(text,text,text,jsonb,text,boolean)')::OID,
            pg_catalog.to_regprocedure('public.claim_notification_outbox_v1(integer,text,integer)')::OID,
            pg_catalog.to_regprocedure('public.finish_notification_outbox_v1(uuid,uuid,bigint,text,text,integer)')::OID,
            pg_catalog.to_regprocedure('public.reconcile_stale_notification_outbox_v1(integer)')::OID,
            pg_catalog.to_regprocedure('public.list_notification_legacy_outbox_v1(integer)')::OID,
            pg_catalog.to_regprocedure('public.list_notification_outbox_v1(integer)')::OID
        ];
    END IF;
    IF 'system_configuration' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := v_drop_routine_oids || ARRAY[
            pg_catalog.to_regprocedure('public.record_system_configuration_v1(text,integer,text,jsonb,text,timestamptz)')::OID,
            pg_catalog.to_regprocedure('public.canonical_system_configuration_json(jsonb)')::OID
        ];
    END IF;
    IF 'system_leases' = ANY(v_approved_subset) THEN
        v_drop_routine_oids := v_drop_routine_oids || ARRAY[
            pg_catalog.to_regprocedure('public.acquire_system_lease_v1(text,text,text,integer)')::OID
        ];
    END IF;
    v_drop_routine_oids := v_drop_routine_oids || ARRAY[
        pg_catalog.to_regprocedure('public.enqueue_analysis_canonical_retry(uuid,text)')::OID,
        pg_catalog.to_regprocedure('public.load_analysis_canonical_family(uuid,text)')::OID,
        pg_catalog.to_regprocedure('public.apply_analysis_canonical_backfill_row(text,text,text,text,text,uuid,jsonb)')::OID
    ];

    IF pg_catalog.cardinality(v_drop_routine_oids) > 0 AND EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.refclassid = 'pg_catalog.pg_proc'::pg_catalog.regclass
          AND dependency.deptype NOT IN ('i', 'a')
          AND dependency.refobjid = ANY(v_drop_routine_oids)
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'OPERATIONAL_POLICY_RPC_DEPENDENCY_PRECONDITION_FAILED',
            ERRCODE = '55000';
    END IF;

    IF 'analysis_artifacts' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.append_analysis_canonical_artifact(UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT)';
    END IF;
    IF 'analysis_costs' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.append_analysis_canonical_cost(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT, TEXT)';
    END IF;
    IF 'analysis_cache' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.upsert_analysis_canonical_cache(UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB)';
    END IF;
    IF 'analysis_audit_bundles' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.append_analysis_canonical_audit(UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT)';
    END IF;
    IF 'analysis_costs' = ANY(v_approved_subset)
       AND 'analysis_audit_bundles' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.append_analysis_canonical_late_cost_audit(UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT)';
    END IF;
    EXECUTE 'DROP FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT)';
    EXECUTE 'DROP FUNCTION public.load_analysis_canonical_family(UUID, TEXT)';
    EXECUTE 'DROP FUNCTION public.apply_analysis_canonical_backfill_row(TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB)';
    IF 'fulfillment_jobs' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.upsert_fulfillment_job_v1(UUID, UUID, TEXT, SMALLINT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ)';
    END IF;
    IF 'notification_outbox' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.enqueue_notification_v1(TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)';
        EXECUTE 'DROP FUNCTION public.claim_notification_outbox_v1(INTEGER, TEXT, INTEGER)';
        EXECUTE 'DROP FUNCTION public.finish_notification_outbox_v1(UUID, UUID, BIGINT, TEXT, TEXT, INTEGER)';
        EXECUTE 'DROP FUNCTION public.reconcile_stale_notification_outbox_v1(INTEGER)';
        EXECUTE 'DROP FUNCTION public.list_notification_legacy_outbox_v1(INTEGER)';
        EXECUTE 'DROP FUNCTION public.list_notification_outbox_v1(INTEGER)';
    END IF;
    IF 'system_configuration' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.record_system_configuration_v1(TEXT, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ)';
        EXECUTE 'DROP FUNCTION public.canonical_system_configuration_json(JSONB)';
    END IF;
    IF 'system_leases' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER)';
    END IF;

    IF 'analysis_artifacts' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TABLE public.analysis_artifacts';
    END IF;
    IF 'analysis_audit_bundles' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TABLE public.analysis_audit_bundles';
    END IF;
    IF 'analysis_cache' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TABLE public.analysis_cache';
    END IF;
    IF 'analysis_costs' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TABLE public.analysis_costs';
    END IF;
    IF 'fulfillment_jobs' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TABLE public.fulfillment_jobs';
    END IF;
    IF 'notification_outbox' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TABLE public.notification_outbox';
    END IF;
    IF 'system_configuration' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TABLE public.system_configuration';
    END IF;
    IF 'system_leases' = ANY(v_approved_subset) THEN
        EXECUTE 'DROP TABLE public.system_leases';
    END IF;

    -- These generic helpers existed only for the removed W1A payload
    -- contracts. Drop them only when every analysis W1A table is gone, so a
    -- deferred family retains the dependency required by its own constraints.
    IF v_approved_subset @> ARRAY[
        'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache', 'analysis_costs'
    ]::TEXT[] THEN
        EXECUTE 'DROP FUNCTION public.analysis_canonical_payload_valid(JSONB)';
        EXECUTE 'DROP FUNCTION public.analysis_canonical_json_object_has_exact_keys(JSONB, TEXT[])';
    END IF;
END;
$$;

-- This migration deliberately does not alter account_lifecycle,
-- payment_pending, provider tables, maintenance_jobs, analysis_jobs/events, or
-- the analysis_order_audit_* contract.
