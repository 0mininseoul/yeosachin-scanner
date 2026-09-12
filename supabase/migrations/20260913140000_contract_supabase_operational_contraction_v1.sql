-- Post-deploy W1A contraction.  This migration is deliberately fail-closed:
-- it embeds the coordinator-pinned provenance below, requires the exact
-- catalog/data shape below, and names every destructive statement explicitly.
-- It does not archive or rewrite rows because every candidate count must be 0.
-- Pinned provenance: deploy revision 90a6e6a20ba242afd4526063b0100a49f65caa88;
-- deployment completed 2026-09-12T21:33:16Z; exact zero-count observation
-- completed 2026-09-12T21:42:43.922341Z; pre-contraction public table count 160.
-- Policy source: supabase-operational-policy-v1, SHA
-- 053d46326e7ecf45c02ebab9ae210ffe66624d00.  The checked-in manifest and
-- this immutable SQL file are the reviewed source; no caller-controlled GUC
-- or mutable session attestation is consulted.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';

SELECT pg_catalog.pg_advisory_xact_lock(22091313, 1);

-- The additive policy source must already be in immutable migration history.
-- Its reviewed source SHA and the deployed revision/evidence provenance are
-- fixed above; history is the live prerequisite that can be checked here.
DO $w1a_policy_source_guard$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NULL
       OR NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations AS migration_row
           WHERE migration_row.version = '20260913130000'
       ) THEN
        RAISE EXCEPTION 'W1A_GUARD_POLICY_MIGRATION_MISSING';
    END IF;
END;
$w1a_policy_source_guard$;

-- Abort if another client is concurrently changing catalog objects.  A
-- moving catalog cannot satisfy an exact destructive contract.
DO $w1a_active_ddl_guard$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_activity AS activity
        CROSS JOIN LATERAL (
            SELECT pg_catalog.regexp_replace(
                pg_catalog.regexp_replace(
                    activity.query,
                    E'/[*]([^*]|[*][^/])*[*]/',
                    ' ',
                    'g'
                ),
                E'--[^\\r\\n]*',
                ' ',
                'g'
            ) AS normalized_query
        ) AS normalized
        WHERE activity.pid <> pg_catalog.pg_backend_pid()
          AND activity.datname = pg_catalog.current_database()
          AND activity.backend_type = 'client backend'
          AND activity.state IN ('active', 'idle in transaction', 'idle in transaction (aborted)')
          AND normalized.normalized_query ~* $w1a_ddl_pattern$(?x)
              (
                  (CREATE[[:space:]]+OR[[:space:]]+REPLACE|CREATE|ALTER|DROP)
                      [[:space:]]+(FUNCTION|PROCEDURE|ROUTINE|TABLE|INDEX|TRIGGER|VIEW|PUBLICATION)
              )$w1a_ddl_pattern$
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_ACTIVE_DDL';
    END IF;
END;
$w1a_active_ddl_guard$;

-- The allowlist is duplicated in SQL so the destructive target cannot widen
-- if an operator supplies a different manifest or a broad catalog query.
CREATE TEMP TABLE pg_temp.w1a_expected_allowlist (
    item TEXT PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO pg_temp.w1a_expected_allowlist(item) VALUES
    ('table:public.analysis_artifacts'),
    ('table:public.analysis_audit_bundles'),
    ('table:public.analysis_cache'),
    ('table:public.analysis_costs'),
    ('table:public.fulfillment_jobs'),
    ('table:public.notification_outbox'),
    ('table:public.system_configuration'),
    ('table:public.system_leases'),
    ('constraint:public.analysis_artifacts.analysis_artifacts_pkey'),
    ('constraint:public.analysis_artifacts.analysis_artifacts_request_id_artifact_key_content_hash_key'),
    ('constraint:public.analysis_artifacts.analysis_artifacts_request_id_fkey'),
    ('constraint:public.analysis_artifacts.analysis_artifacts_job_id_fkey'),
    ('constraint:public.analysis_artifacts.analysis_artifacts_kind_check'),
    ('constraint:public.analysis_artifacts.analysis_artifacts_state_check'),
    ('constraint:public.analysis_artifacts.analysis_artifacts_content_hash_check'),
    ('constraint:public.analysis_artifacts.analysis_artifacts_payload_check'),
    ('constraint:public.analysis_costs.analysis_costs_pkey'),
    ('constraint:public.analysis_costs.analysis_costs_request_id_fkey'),
    ('constraint:public.analysis_costs.analysis_costs_amount_known_check'),
    ('constraint:public.analysis_costs.analysis_costs_amount_conservative_check'),
    ('constraint:public.analysis_costs.analysis_costs_check'),
    ('constraint:public.analysis_costs.analysis_costs_check1'),
    ('constraint:public.analysis_costs.analysis_costs_source_hash_check'),
    ('constraint:public.analysis_costs.analysis_costs_payload_check'),
    ('constraint:public.analysis_cache.analysis_cache_pkey'),
    ('constraint:public.analysis_cache.analysis_cache_request_id_fkey'),
    ('constraint:public.analysis_cache.analysis_cache_request_id_scope_cache_key_hash_key'),
    ('constraint:public.analysis_cache.analysis_cache_scope_check'),
    ('constraint:public.analysis_cache.analysis_cache_cache_key_hash_check'),
    ('constraint:public.analysis_cache.analysis_cache_state_check'),
    ('constraint:public.analysis_cache.analysis_cache_single_flight_token_hash_check'),
    ('constraint:public.analysis_cache.analysis_cache_payload_check'),
    ('constraint:public.analysis_audit_bundles.analysis_audit_bundles_pkey'),
    ('constraint:public.analysis_audit_bundles.analysis_audit_bundles_request_id_fkey'),
    ('constraint:public.analysis_audit_bundles.analysis_audit_bundles_request_id_version_kind_content_hash_key'),
    ('constraint:public.analysis_audit_bundles.analysis_audit_bundles_version_check'),
    ('constraint:public.analysis_audit_bundles.analysis_audit_bundles_kind_check'),
    ('constraint:public.analysis_audit_bundles.analysis_audit_bundles_state_check'),
    ('constraint:public.analysis_audit_bundles.analysis_audit_bundles_content_hash_check'),
    ('constraint:public.analysis_audit_bundles.analysis_audit_bundles_payload_check'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_pkey'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_order_id_key'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_request_id_key'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_order_id_fkey'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_request_id_fkey'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_state_check'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_attempt_count_check'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_lease_generation_check'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_payload_check'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_check'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_check1'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_check2'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_check3'),
    ('constraint:public.fulfillment_jobs.fulfillment_jobs_check4'),
    ('constraint:public.notification_outbox.notification_outbox_pkey'),
    ('constraint:public.notification_outbox.notification_outbox_dedupe_key_key'),
    ('constraint:public.notification_outbox.notification_outbox_channel_check'),
    ('constraint:public.notification_outbox.notification_outbox_state_check'),
    ('constraint:public.notification_outbox.notification_outbox_attempt_count_check'),
    ('constraint:public.notification_outbox.notification_outbox_lease_generation_check'),
    ('constraint:public.notification_outbox.notification_outbox_lease_holder_hash_check'),
    ('constraint:public.notification_outbox.notification_outbox_content_hash_check'),
    ('constraint:public.notification_outbox.notification_outbox_payload_check'),
    ('constraint:public.system_configuration.system_configuration_pkey'),
    ('constraint:public.system_configuration.system_configuration_version_check'),
    ('constraint:public.system_configuration.system_configuration_state_check'),
    ('constraint:public.system_configuration.system_configuration_content_hash_check'),
    ('constraint:public.system_configuration.system_configuration_config_check'),
    ('constraint:public.system_leases.system_leases_pkey'),
    ('constraint:public.system_leases.system_leases_kind_check'),
    ('constraint:public.system_leases.system_leases_generation_check'),
    ('constraint:public.system_leases.system_leases_state_check'),
    ('constraint:public.system_leases.system_leases_holder_hash_check'),
    ('constraint:public.system_leases.system_leases_fence_token_check'),
    ('constraint:public.system_leases.system_leases_payload_check'),
    ('index:public.analysis_artifacts.analysis_artifacts_pkey'),
    ('index:public.analysis_artifacts.analysis_artifacts_request_id_artifact_key_content_hash_key'),
    ('index:public.analysis_artifacts.analysis_artifacts_request_kind_idx'),
    ('index:public.analysis_costs.analysis_costs_pkey'),
    ('index:public.analysis_costs.analysis_costs_request_recorded_idx'),
    ('index:public.analysis_costs.analysis_costs_request_idempotency_idx'),
    ('index:public.analysis_cache.analysis_cache_pkey'),
    ('index:public.analysis_cache.analysis_cache_request_id_scope_cache_key_hash_key'),
    ('index:public.analysis_cache.analysis_cache_expiry_idx'),
    ('index:public.analysis_cache.analysis_cache_request_updated_idx'),
    ('index:public.analysis_audit_bundles.analysis_audit_bundles_pkey'),
    ('index:public.analysis_audit_bundles.analysis_audit_bundles_request_id_version_kind_content_hash_key'),
    ('index:public.analysis_audit_bundles.analysis_audit_request_version_idx'),
    ('index:public.analysis_audit_bundles.analysis_audit_request_idempotency_idx'),
    ('index:public.fulfillment_jobs.fulfillment_jobs_pkey'),
    ('index:public.fulfillment_jobs.fulfillment_jobs_order_id_key'),
    ('index:public.fulfillment_jobs.fulfillment_jobs_request_id_key'),
    ('index:public.fulfillment_jobs.fulfillment_jobs_recovery_idx'),
    ('index:public.notification_outbox.notification_outbox_pkey'),
    ('index:public.notification_outbox.notification_outbox_dedupe_key_key'),
    ('index:public.notification_outbox.notification_outbox_delivery_idx'),
    ('index:public.system_configuration.system_configuration_pkey'),
    ('index:public.system_configuration.system_configuration_effective_idx'),
    ('index:public.system_leases.system_leases_pkey'),
    ('index:public.system_leases.system_leases_expiry_idx'),
    ('routine:public.append_analysis_canonical_artifact(uuid,uuid,text,text,text,text,jsonb,text)'),
    ('routine:public.apply_analysis_canonical_backfill_row(text,text,text,text,text,uuid,jsonb)'),
    ('routine:public.append_analysis_canonical_audit(uuid,integer,text,text,integer,text,text,text,jsonb,text)'),
    ('routine:public.append_analysis_canonical_late_cost_audit(uuid,text,text,text,character,numeric,numeric,boolean,text,text,jsonb,text,text,jsonb,text)'),
    ('routine:public.upsert_analysis_canonical_cache(uuid,text,text,text,timestamptz,text,jsonb)'),
    ('routine:public.append_analysis_canonical_cost(uuid,text,text,text,character,numeric,numeric,boolean,text,jsonb,text,text)'),
    ('routine:public.enqueue_analysis_canonical_retry(uuid,text)'),
    ('routine:public.load_analysis_canonical_family(uuid,text)'),
    ('routine:public.upsert_fulfillment_job_v1(uuid,uuid,text,smallint,bigint,uuid,timestamptz,timestamptz,text,jsonb,timestamptz,timestamptz,timestamptz,timestamptz)'),
    ('routine:public.enqueue_notification_v1(text,text,text,jsonb,text,boolean)'),
    ('routine:public.claim_notification_outbox_v1(integer,text,integer)'),
    ('routine:public.finish_notification_outbox_v1(uuid,uuid,bigint,text,text,integer)'),
    ('routine:public.reconcile_stale_notification_outbox_v1(integer)'),
    ('routine:public.list_notification_outbox_v1(integer)'),
    ('routine:public.list_notification_legacy_outbox_v1(integer)'),
    ('routine:public.canonical_system_configuration_json(jsonb)'),
    ('routine:public.record_system_configuration_v1(text,integer,text,jsonb,text,timestamptz)'),
    ('routine:public.acquire_system_lease_v1(text,text,text,integer)'),
    ('trigger:public.analysis_costs.analysis_costs_append_only'),
    ('trigger:public.analysis_audit_bundles.analysis_audit_bundles_append_only'),
    ('trigger:public.system_configuration.system_configuration_immutable'),
    ('sequence:public.analysis_costs_id_seq'),
    ('acl:table:public.analysis_artifacts:PUBLIC,anon,authenticated,service_role'),
    ('acl:table:public.analysis_audit_bundles:PUBLIC,anon,authenticated,service_role'),
    ('acl:table:public.analysis_cache:PUBLIC,anon,authenticated,service_role'),
    ('acl:table:public.analysis_costs:PUBLIC,anon,authenticated,service_role'),
    ('acl:table:public.fulfillment_jobs:PUBLIC,anon,authenticated,service_role'),
    ('acl:table:public.notification_outbox:PUBLIC,anon,authenticated,service_role'),
    ('acl:table:public.system_configuration:PUBLIC,anon,authenticated,service_role'),
    ('acl:table:public.system_leases:PUBLIC,anon,authenticated,service_role'),
    ('acl:column:public.analysis_artifacts.id:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.request_id:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.job_id:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.kind:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.artifact_key:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.state:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.content_hash:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.payload:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.retention_class:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.created_at:service_role:SELECT'),
    ('acl:column:public.analysis_artifacts.updated_at:service_role:SELECT'),
    ('acl:column:public.analysis_costs.id:service_role:SELECT'),
    ('acl:column:public.analysis_costs.request_id:service_role:SELECT'),
    ('acl:column:public.analysis_costs.provider:service_role:SELECT'),
    ('acl:column:public.analysis_costs.operation_key:service_role:SELECT'),
    ('acl:column:public.analysis_costs.stage:service_role:SELECT'),
    ('acl:column:public.analysis_costs.currency:service_role:SELECT'),
    ('acl:column:public.analysis_costs.amount_known:service_role:SELECT'),
    ('acl:column:public.analysis_costs.amount_conservative:service_role:SELECT'),
    ('acl:column:public.analysis_costs.usage_unknown:service_role:SELECT'),
    ('acl:column:public.analysis_costs.source_hash:service_role:SELECT'),
    ('acl:column:public.analysis_costs.idempotency_key:service_role:SELECT'),
    ('acl:column:public.analysis_costs.payload:service_role:SELECT'),
    ('acl:column:public.analysis_costs.retention_class:service_role:SELECT'),
    ('acl:column:public.analysis_costs.recorded_at:service_role:SELECT'),
    ('acl:routine:public.append_analysis_canonical_artifact:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.apply_analysis_canonical_backfill_row:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.append_analysis_canonical_audit:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.append_analysis_canonical_late_cost_audit:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.upsert_analysis_canonical_cache:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.append_analysis_canonical_cost:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.enqueue_analysis_canonical_retry:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.load_analysis_canonical_family:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.upsert_fulfillment_job_v1:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.enqueue_notification_v1:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.claim_notification_outbox_v1:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.finish_notification_outbox_v1:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.reconcile_stale_notification_outbox_v1:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.list_notification_outbox_v1:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.list_notification_legacy_outbox_v1:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.canonical_system_configuration_json:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.record_system_configuration_v1:PUBLIC,anon,authenticated,service_role'),
    ('acl:routine:public.acquire_system_lease_v1:PUBLIC,anon,authenticated,service_role'),
    ('policy:none:public.analysis_artifacts'),
    ('policy:none:public.analysis_audit_bundles'),
    ('policy:none:public.analysis_cache'),
    ('policy:none:public.analysis_costs'),
    ('policy:none:public.fulfillment_jobs'),
    ('policy:none:public.notification_outbox'),
    ('policy:none:public.system_configuration'),
    ('policy:none:public.system_leases'),
    ('view:none:public.analysis_artifacts'),
    ('view:none:public.analysis_audit_bundles'),
    ('view:none:public.analysis_cache'),
    ('view:none:public.analysis_costs'),
    ('view:none:public.fulfillment_jobs'),
    ('view:none:public.notification_outbox'),
    ('view:none:public.system_configuration'),
    ('view:none:public.system_leases'),
    ('publication:none:public.analysis_artifacts'),
    ('publication:none:public.analysis_audit_bundles'),
    ('publication:none:public.analysis_cache'),
    ('publication:none:public.analysis_costs'),
    ('publication:none:public.fulfillment_jobs'),
    ('publication:none:public.notification_outbox'),
    ('publication:none:public.system_configuration'),
    ('publication:none:public.system_leases');

DO $w1a_allowlist_guard$
DECLARE
    v_count INTEGER;
    v_hash TEXT;
BEGIN
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.string_agg(item, E'\n' ORDER BY item COLLATE "C"), 'UTF8'
    )), 'hex')
      INTO v_count, v_hash
    FROM pg_temp.w1a_expected_allowlist;
    IF v_count <> 197
       OR v_hash IS DISTINCT FROM '99315920ba18f11f23982443e38770cbcf7800d42cd94b1795ab58b12a37f91b' THEN
        RAISE EXCEPTION 'W1A_GUARD_ALLOWLIST_CONTENT';
    END IF;
END;
$w1a_allowlist_guard$;

CREATE TEMP TABLE pg_temp.w1a_expected_relations (
    relation_name TEXT PRIMARY KEY,
    relation_oid OID NOT NULL
) ON COMMIT DROP;

DO $w1a_relation_guard$
DECLARE
    v_name TEXT;
    v_oid OID;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache',
        'analysis_costs', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ] LOOP
        SELECT relation_row.oid INTO v_oid
        FROM pg_catalog.pg_class AS relation_row
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relname = v_name
          AND relation_row.relkind = 'r';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'W1A_GUARD_TABLE_MISSING: public.%', v_name;
        END IF;
        INSERT INTO pg_temp.w1a_expected_relations(relation_name, relation_oid)
        VALUES (v_name, v_oid);
    END LOOP;
END;
$w1a_relation_guard$;

-- Retained operational tables must be present.  Only actually observed
-- payment-side relations are named here; no historical payment relation is
-- looked up or changed by this migration.
DO $w1a_retained_guard$
DECLARE
    v_name TEXT;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_jobs', 'analysis_events', 'analysis_provider_runs',
        'analysis_v2_provider_runs', 'payment_events', 'earlybird_orders',
        'maintenance_jobs', 'analysis_order_audit_assembly_queue',
        'analysis_order_audit_bundles', 'analysis_order_audit_candidates',
        'analysis_order_audit_interactions', 'account_lifecycle'
    ] LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_class AS relation_row
            JOIN pg_catalog.pg_namespace AS relation_schema
              ON relation_schema.oid = relation_row.relnamespace
            WHERE relation_schema.nspname = 'public'
              AND relation_row.relname = v_name
              AND relation_row.relkind = 'r'
        ) THEN
            RAISE EXCEPTION 'W1A_GUARD_RETAINED_TABLE_MISSING: public.%', v_name;
        END IF;
    END LOOP;
END;
$w1a_retained_guard$;

-- Lock only the eight approved candidate relations, then revalidate their
-- OIDs before checking rows and issuing explicit drops.
LOCK TABLE public.analysis_artifacts,
    public.analysis_audit_bundles,
    public.analysis_cache,
    public.analysis_costs,
    public.fulfillment_jobs,
    public.notification_outbox,
    public.system_configuration,
    public.system_leases
    IN ACCESS EXCLUSIVE MODE;

DO $w1a_relation_revalidation_guard$
DECLARE
    v_name TEXT;
    v_oid OID;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache',
        'analysis_costs', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ] LOOP
        SELECT relation_row.oid INTO v_oid
        FROM pg_catalog.pg_class AS relation_row
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relname = v_name
          AND relation_row.relkind = 'r';
        IF NOT FOUND
           OR v_oid IS DISTINCT FROM (
               SELECT expected.relation_oid
               FROM pg_temp.w1a_expected_relations AS expected
               WHERE expected.relation_name = v_name
           ) THEN
            RAISE EXCEPTION 'W1A_GUARD_TABLE_REPLACED: public.%', v_name;
        END IF;
    END LOOP;
END;
$w1a_relation_revalidation_guard$;

DO $w1a_baseline_guard$
DECLARE
    v_public_table_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_public_table_count
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p');
    IF v_public_table_count <> 160 THEN
        RAISE EXCEPTION 'W1A_GUARD_PUBLIC_TABLE_COUNT: expected 160, found %',
            v_public_table_count;
    END IF;
END;
$w1a_baseline_guard$;

-- Compare every candidate column, including type modifiers and nullability.
DO $w1a_column_guard$
DECLARE
    v_name TEXT;
    v_expected TEXT[];
    v_actual TEXT[];
    v_oid OID;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_artifacts', 'analysis_costs', 'analysis_cache',
        'analysis_audit_bundles', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ] LOOP
        v_expected := CASE v_name
            WHEN 'analysis_artifacts' THEN ARRAY[
                'id:uuid:true',
                'request_id:uuid:true',
                'job_id:uuid:false',
                'kind:text:true',
                'artifact_key:text:true',
                'state:text:true',
                'content_hash:text:true',
                'payload:jsonb:true',
                'retention_class:text:true',
                'created_at:timestamp with time zone:true',
                'updated_at:timestamp with time zone:true'
            ]
            WHEN 'analysis_costs' THEN ARRAY[
                'id:bigint:true',
                'request_id:uuid:true',
                'provider:text:true',
                'operation_key:text:true',
                'stage:text:true',
                'currency:character(3):true',
                'amount_known:numeric(18,12):false',
                'amount_conservative:numeric(18,12):false',
                'usage_unknown:boolean:true',
                'source_hash:text:true',
                'idempotency_key:text:false',
                'payload:jsonb:true',
                'retention_class:text:true',
                'recorded_at:timestamp with time zone:true'
            ]
            WHEN 'analysis_cache' THEN ARRAY[
                'id:uuid:true',
                'request_id:uuid:true',
                'scope:text:true',
                'cache_key_hash:text:true',
                'state:text:true',
                'expires_at:timestamp with time zone:true',
                'single_flight_token_hash:text:false',
                'payload:jsonb:true',
                'created_at:timestamp with time zone:true',
                'updated_at:timestamp with time zone:true'
            ]
            WHEN 'analysis_audit_bundles' THEN ARRAY[
                'id:uuid:true',
                'request_id:uuid:true',
                'version:integer:true',
                'kind:text:true',
                'candidate_key:text:false',
                'ordinal:integer:false',
                'state:text:true',
                'content_hash:text:true',
                'idempotency_key:text:false',
                'retention_class:text:true',
                'payload:jsonb:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'fulfillment_jobs' THEN ARRAY[
                'id:uuid:true',
                'order_id:uuid:true',
                'request_id:uuid:false',
                'state:text:true',
                'attempt_count:smallint:true',
                'lease_generation:bigint:true',
                'lease_token:uuid:false',
                'lease_expires_at:timestamp with time zone:false',
                'next_attempt_at:timestamp with time zone:true',
                'last_error_code:text:false',
                'operator_admitted_at:timestamp with time zone:false',
                'last_error_at:timestamp with time zone:false',
                'completed_at:timestamp with time zone:false',
                'manual_review_at:timestamp with time zone:false',
                'payload:jsonb:true',
                'created_at:timestamp with time zone:true',
                'updated_at:timestamp with time zone:true'
            ]
            WHEN 'notification_outbox' THEN ARRAY[
                'id:uuid:true',
                'channel:text:true',
                'event_kind:text:true',
                'dedupe_key:text:true',
                'state:text:true',
                'attempt_count:smallint:true',
                'lease_generation:bigint:true',
                'lease_token:uuid:false',
                'lease_holder_hash:text:false',
                'lease_expires_at:timestamp with time zone:false',
                'next_attempt_at:timestamp with time zone:true',
                'delivered_at:timestamp with time zone:false',
                'terminal_at:timestamp with time zone:false',
                'last_error_code:text:false',
                'payload:jsonb:true',
                'content_hash:text:true',
                'created_at:timestamp with time zone:true',
                'updated_at:timestamp with time zone:true'
            ]
            WHEN 'system_configuration' THEN ARRAY[
                'config_key:text:true',
                'version:integer:true',
                'state:text:true',
                'config:jsonb:true',
                'content_hash:text:true',
                'effective_at:timestamp with time zone:false',
                'created_at:timestamp with time zone:true'
            ]
            ELSE ARRAY[
                'lease_key:text:true',
                'kind:text:true',
                'generation:bigint:true',
                'state:text:true',
                'holder_hash:text:false',
                'lease_expires_at:timestamp with time zone:false',
                'heartbeat_at:timestamp with time zone:false',
                'fence_token:bigint:true',
                'payload:jsonb:true',
                'updated_at:timestamp with time zone:true'
            ]
        END::TEXT[];

        SELECT expected.relation_oid INTO v_oid
        FROM pg_temp.w1a_expected_relations AS expected
        WHERE expected.relation_name = v_name;
        SELECT pg_catalog.array_agg(
            pg_catalog.format(
                '%s:%s:%s',
                attribute_row.attname,
                pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod),
                CASE WHEN attribute_row.attnotnull THEN 'true' ELSE 'false' END
            ) ORDER BY attribute_row.attnum
        ) INTO v_actual
        FROM pg_catalog.pg_attribute AS attribute_row
        WHERE attribute_row.attrelid = v_oid
          AND attribute_row.attnum > 0
          AND NOT attribute_row.attisdropped;
        IF v_actual IS DISTINCT FROM v_expected THEN
            RAISE EXCEPTION 'W1A_GUARD_COLUMN_SHAPE: public.%', v_name;
        END IF;
    END LOOP;
END;
$w1a_column_guard$;

DO $w1a_rls_policy_guard$
DECLARE
    v_name TEXT;
    v_oid OID;
    v_rls BOOLEAN;
    v_force BOOLEAN;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache',
        'analysis_costs', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ] LOOP
        SELECT expected.relation_oid INTO v_oid
        FROM pg_temp.w1a_expected_relations AS expected
        WHERE expected.relation_name = v_name;
        SELECT relation_row.relrowsecurity, relation_row.relforcerowsecurity
          INTO v_rls, v_force
        FROM pg_catalog.pg_class AS relation_row
        WHERE relation_row.oid = v_oid;
        IF v_rls IS DISTINCT FROM TRUE OR v_force IS DISTINCT FROM TRUE THEN
            RAISE EXCEPTION 'W1A_GUARD_RLS_MODE: public.%', v_name;
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_policy AS policy_row
            WHERE policy_row.polrelid = v_oid
        ) THEN
            RAISE EXCEPTION 'W1A_GUARD_UNEXPECTED_POLICY: public.%', v_name;
        END IF;
    END LOOP;
END;
$w1a_rls_policy_guard$;

-- Any view/rule or publication relationship would be an unreviewed
-- dependency.  A publication that includes all tables also includes these
-- relations, so it is rejected explicitly.
DO $w1a_view_publication_guard$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid = 'pg_catalog.pg_rewrite'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND dependency.refobjid IN (
              SELECT relation_oid FROM pg_temp.w1a_expected_relations
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_DEPENDENT_VIEW';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication AS publication_row
        WHERE publication_row.puballtables
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_rel AS publication_table
        WHERE publication_table.prrelid IN (
            SELECT relation_oid FROM pg_temp.w1a_expected_relations
        )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_PUBLICATION_DEPENDENCY';
    END IF;
END;
$w1a_view_publication_guard$;

DO $w1a_constraint_guard$
DECLARE
    v_name TEXT;
    v_oid OID;
    v_expected TEXT[];
    v_actual_count INTEGER;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_artifacts', 'analysis_costs', 'analysis_cache',
        'analysis_audit_bundles', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ] LOOP
        v_expected := CASE v_name
            WHEN 'analysis_artifacts' THEN ARRAY[
                'analysis_artifacts_content_hash_check',
                'analysis_artifacts_job_id_fkey',
                'analysis_artifacts_kind_check',
                'analysis_artifacts_payload_check',
                'analysis_artifacts_pkey',
                'analysis_artifacts_request_id_artifact_key_content_hash_key',
                'analysis_artifacts_request_id_fkey',
                'analysis_artifacts_state_check'
            ]
            WHEN 'analysis_costs' THEN ARRAY[
                'analysis_costs_amount_conservative_check',
                'analysis_costs_amount_known_check',
                'analysis_costs_check',
                'analysis_costs_check1',
                'analysis_costs_payload_check',
                'analysis_costs_pkey',
                'analysis_costs_request_id_fkey',
                'analysis_costs_source_hash_check'
            ]
            WHEN 'analysis_cache' THEN ARRAY[
                'analysis_cache_cache_key_hash_check',
                'analysis_cache_payload_check',
                'analysis_cache_pkey',
                'analysis_cache_request_id_fkey',
                'analysis_cache_request_id_scope_cache_key_hash_key',
                'analysis_cache_scope_check',
                'analysis_cache_single_flight_token_hash_check',
                'analysis_cache_state_check'
            ]
            WHEN 'analysis_audit_bundles' THEN ARRAY[
                'analysis_audit_bundles_content_hash_check',
                'analysis_audit_bundles_kind_check',
                'analysis_audit_bundles_payload_check',
                'analysis_audit_bundles_pkey',
                'analysis_audit_bundles_request_id_fkey',
                'analysis_audit_bundles_request_id_version_kind_content_hash_key',
                'analysis_audit_bundles_state_check',
                'analysis_audit_bundles_version_check'
            ]
            WHEN 'fulfillment_jobs' THEN ARRAY[
                'fulfillment_jobs_attempt_count_check',
                'fulfillment_jobs_check',
                'fulfillment_jobs_check1',
                'fulfillment_jobs_check2',
                'fulfillment_jobs_check3',
                'fulfillment_jobs_check4',
                'fulfillment_jobs_lease_generation_check',
                'fulfillment_jobs_order_id_fkey',
                'fulfillment_jobs_order_id_key',
                'fulfillment_jobs_payload_check',
                'fulfillment_jobs_pkey',
                'fulfillment_jobs_request_id_fkey',
                'fulfillment_jobs_request_id_key',
                'fulfillment_jobs_state_check'
            ]
            WHEN 'notification_outbox' THEN ARRAY[
                'notification_outbox_attempt_count_check',
                'notification_outbox_channel_check',
                'notification_outbox_content_hash_check',
                'notification_outbox_dedupe_key_key',
                'notification_outbox_lease_generation_check',
                'notification_outbox_lease_holder_hash_check',
                'notification_outbox_payload_check',
                'notification_outbox_pkey',
                'notification_outbox_state_check'
            ]
            WHEN 'system_configuration' THEN ARRAY[
                'system_configuration_config_check',
                'system_configuration_content_hash_check',
                'system_configuration_pkey',
                'system_configuration_state_check',
                'system_configuration_version_check'
            ]
            ELSE ARRAY[
                'system_leases_fence_token_check',
                'system_leases_generation_check',
                'system_leases_holder_hash_check',
                'system_leases_kind_check',
                'system_leases_payload_check',
                'system_leases_pkey',
                'system_leases_state_check'
            ]
        END::TEXT[];
        SELECT expected.relation_oid INTO v_oid
        FROM pg_temp.w1a_expected_relations AS expected
        WHERE expected.relation_name = v_name;
        SELECT pg_catalog.count(*) INTO v_actual_count
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = v_oid;
        IF v_actual_count <> pg_catalog.cardinality(v_expected)
           OR EXISTS (
               SELECT 1
               FROM pg_catalog.pg_constraint AS constraint_row
               WHERE constraint_row.conrelid = v_oid
                 AND NOT (constraint_row.conname = ANY(v_expected))
           )
           OR EXISTS (
               SELECT 1
               FROM pg_catalog.unnest(v_expected) AS expected_name
               WHERE NOT EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_constraint AS constraint_row
                   WHERE constraint_row.conrelid = v_oid
                     AND constraint_row.conname = expected_name
               )
           ) THEN
            RAISE EXCEPTION 'W1A_GUARD_CONSTRAINT_SET: public.%', v_name;
        END IF;
    END LOOP;
END;
$w1a_constraint_guard$;

DO $w1a_foreign_key_guard$
DECLARE
    v_expected RECORD;
    v_table_oid OID;
    v_constraint_oid OID;
    v_referenced_name TEXT;
    v_local_columns TEXT[];
    v_referenced_columns TEXT[];
    v_delete_action "char";
BEGIN
    FOR v_expected IN
        SELECT *
        FROM (VALUES
            ('analysis_artifacts', 'analysis_artifacts_request_id_fkey', 'analysis_requests', 'request_id', 'id'),
            ('analysis_artifacts', 'analysis_artifacts_job_id_fkey', 'analysis_jobs', 'job_id', 'id'),
            ('analysis_costs', 'analysis_costs_request_id_fkey', 'analysis_requests', 'request_id', 'id'),
            ('analysis_cache', 'analysis_cache_request_id_fkey', 'analysis_requests', 'request_id', 'id'),
            ('analysis_audit_bundles', 'analysis_audit_bundles_request_id_fkey', 'analysis_requests', 'request_id', 'id'),
            ('fulfillment_jobs', 'fulfillment_jobs_order_id_fkey', 'earlybird_orders', 'order_id', 'id'),
            ('fulfillment_jobs', 'fulfillment_jobs_request_id_fkey', 'analysis_requests', 'request_id', 'id')
        ) AS expected(table_name, constraint_name, referenced_table, local_column, referenced_column)
    LOOP
        SELECT expected_relation.relation_oid INTO v_table_oid
        FROM pg_temp.w1a_expected_relations AS expected_relation
        WHERE expected_relation.relation_name = v_expected.table_name;
        SELECT constraint_row.oid INTO v_constraint_oid
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = v_table_oid
          AND constraint_row.conname = v_expected.constraint_name
          AND constraint_row.contype = 'f';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'W1A_GUARD_FOREIGN_KEY_MISSING: public.%', v_expected.constraint_name;
        END IF;
        SELECT format('%s.%s', referenced_schema.nspname, referenced_relation.relname),
               constraint_row.confdeltype
          INTO v_referenced_name, v_delete_action
        FROM pg_catalog.pg_constraint AS constraint_row
        JOIN pg_catalog.pg_class AS referenced_relation
          ON referenced_relation.oid = constraint_row.confrelid
        JOIN pg_catalog.pg_namespace AS referenced_schema
          ON referenced_schema.oid = referenced_relation.relnamespace
        WHERE constraint_row.oid = v_constraint_oid;
        SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY key_columns.ordinality)
          INTO v_local_columns
        FROM pg_catalog.pg_constraint AS constraint_row
        CROSS JOIN LATERAL pg_catalog.unnest(constraint_row.conkey)
            WITH ORDINALITY AS key_columns(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.conrelid
         AND attribute_row.attnum = key_columns.attnum
        WHERE constraint_row.oid = v_constraint_oid;
        SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY key_columns.ordinality)
          INTO v_referenced_columns
        FROM pg_catalog.pg_constraint AS constraint_row
        CROSS JOIN LATERAL pg_catalog.unnest(constraint_row.confkey)
            WITH ORDINALITY AS key_columns(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = constraint_row.confrelid
         AND attribute_row.attnum = key_columns.attnum
        WHERE constraint_row.oid = v_constraint_oid;
        IF v_referenced_name IS DISTINCT FROM 'public.' || v_expected.referenced_table
           OR v_local_columns IS DISTINCT FROM ARRAY[v_expected.local_column]::TEXT[]
           OR v_referenced_columns IS DISTINCT FROM ARRAY[v_expected.referenced_column]::TEXT[]
           OR v_delete_action IS DISTINCT FROM 'r' THEN
            RAISE EXCEPTION 'W1A_GUARD_FOREIGN_KEY_SHAPE: public.%', v_expected.constraint_name;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS incoming
        WHERE incoming.contype = 'f'
          AND incoming.confrelid IN (
              SELECT relation_oid FROM pg_temp.w1a_expected_relations
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_INCOMING_FOREIGN_KEY';
    END IF;
END;
$w1a_foreign_key_guard$;

CREATE TEMP TABLE pg_temp.w1a_expected_indexes (
    index_name TEXT PRIMARY KEY,
    relation_name TEXT NOT NULL,
    unique_index BOOLEAN NOT NULL,
    key_columns TEXT[] NOT NULL,
    predicate TEXT
) ON COMMIT DROP;

INSERT INTO pg_temp.w1a_expected_indexes(
    index_name, relation_name, unique_index, key_columns, predicate
) VALUES
    ('analysis_artifacts_pkey', 'analysis_artifacts', TRUE, ARRAY['id'], NULL),
    ('analysis_artifacts_request_id_artifact_key_content_hash_key', 'analysis_artifacts', TRUE, ARRAY['request_id', 'artifact_key', 'content_hash'], NULL),
    ('analysis_artifacts_request_kind_idx', 'analysis_artifacts', FALSE, ARRAY['request_id', 'kind', 'created_at'], NULL),
    ('analysis_costs_pkey', 'analysis_costs', TRUE, ARRAY['id'], NULL),
    ('analysis_costs_request_recorded_idx', 'analysis_costs', FALSE, ARRAY['request_id', 'recorded_at'], NULL),
    ('analysis_costs_request_idempotency_idx', 'analysis_costs', TRUE, ARRAY['request_id', 'idempotency_key'], '(idempotency_key IS NOT NULL)'),
    ('analysis_cache_pkey', 'analysis_cache', TRUE, ARRAY['id'], NULL),
    ('analysis_cache_request_id_scope_cache_key_hash_key', 'analysis_cache', TRUE, ARRAY['request_id', 'scope', 'cache_key_hash'], NULL),
    ('analysis_cache_expiry_idx', 'analysis_cache', FALSE, ARRAY['expires_at', 'state'], NULL),
    ('analysis_cache_request_updated_idx', 'analysis_cache', FALSE, ARRAY['request_id', 'updated_at', 'id'], NULL),
    ('analysis_audit_bundles_pkey', 'analysis_audit_bundles', TRUE, ARRAY['id'], NULL),
    ('analysis_audit_bundles_request_id_version_kind_content_hash_key', 'analysis_audit_bundles', TRUE, ARRAY['request_id', 'version', 'kind', 'content_hash'], NULL),
    ('analysis_audit_request_version_idx', 'analysis_audit_bundles', FALSE, ARRAY['request_id', 'version', 'kind'], NULL),
    ('analysis_audit_request_idempotency_idx', 'analysis_audit_bundles', TRUE, ARRAY['request_id', 'kind', 'idempotency_key'], '(idempotency_key IS NOT NULL)'),
    ('fulfillment_jobs_pkey', 'fulfillment_jobs', TRUE, ARRAY['id'], NULL),
    ('fulfillment_jobs_order_id_key', 'fulfillment_jobs', TRUE, ARRAY['order_id'], NULL),
    ('fulfillment_jobs_request_id_key', 'fulfillment_jobs', TRUE, ARRAY['request_id'], NULL),
    ('fulfillment_jobs_recovery_idx', 'fulfillment_jobs', FALSE, ARRAY['state', 'next_attempt_at', 'created_at'], '(state = ANY (ARRAY[''admission_pending''::text, ''retryable_failure''::text, ''analysis_in_progress''::text]))'),
    ('notification_outbox_pkey', 'notification_outbox', TRUE, ARRAY['id'], NULL),
    ('notification_outbox_dedupe_key_key', 'notification_outbox', TRUE, ARRAY['dedupe_key'], NULL),
    ('notification_outbox_delivery_idx', 'notification_outbox', FALSE, ARRAY['state', 'next_attempt_at', 'created_at'], '(state = ANY (ARRAY[''queued''::text, ''retryable''::text]))'),
    ('system_configuration_pkey', 'system_configuration', TRUE, ARRAY['config_key', 'version'], NULL),
    ('system_configuration_effective_idx', 'system_configuration', FALSE, ARRAY['config_key', 'effective_at', 'version'], '(state = ''effective''::text)'),
    ('system_leases_pkey', 'system_leases', TRUE, ARRAY['lease_key'], NULL),
    ('system_leases_expiry_idx', 'system_leases', FALSE, ARRAY['kind', 'state', 'lease_expires_at'], NULL);

DO $w1a_index_guard$
DECLARE
    v_expected RECORD;
    v_table_oid OID;
    v_index_oid OID;
    v_unique BOOLEAN;
    v_method TEXT;
    v_columns TEXT[];
    v_predicate TEXT;
BEGIN
    IF (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_index AS index_row
        WHERE index_row.indrelid IN (SELECT relation_oid FROM pg_temp.w1a_expected_relations)
    ) <> (SELECT pg_catalog.count(*) FROM pg_temp.w1a_expected_indexes) THEN
        RAISE EXCEPTION 'W1A_GUARD_INDEX_COUNT';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_class AS index_relation
          ON index_relation.oid = index_row.indexrelid
        WHERE index_row.indrelid IN (SELECT relation_oid FROM pg_temp.w1a_expected_relations)
          AND NOT EXISTS (
              SELECT 1
              FROM pg_temp.w1a_expected_indexes AS expected
              WHERE expected.index_name = index_relation.relname
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_UNEXPECTED_INDEX';
    END IF;
    FOR v_expected IN SELECT * FROM pg_temp.w1a_expected_indexes ORDER BY index_name LOOP
        SELECT expected_relation.relation_oid INTO v_table_oid
        FROM pg_temp.w1a_expected_relations AS expected_relation
        WHERE expected_relation.relation_name = v_expected.relation_name;
        SELECT index_row.indexrelid, index_row.indisunique,
               access_method.amname,
               pg_catalog.pg_get_expr(index_row.indpred, index_row.indrelid)
          INTO v_index_oid, v_unique, v_method, v_predicate
        FROM pg_catalog.pg_index AS index_row
        JOIN pg_catalog.pg_class AS index_relation
          ON index_relation.oid = index_row.indexrelid
        JOIN pg_catalog.pg_am AS access_method
          ON access_method.oid = index_relation.relam
        WHERE index_row.indrelid = v_table_oid
          AND index_relation.relname = v_expected.index_name;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'W1A_GUARD_INDEX_MISSING: public.%', v_expected.index_name;
        END IF;
        SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY key_columns.ordinality)
          INTO v_columns
        FROM pg_catalog.pg_index AS index_row
        CROSS JOIN LATERAL pg_catalog.unnest(index_row.indkey)
            WITH ORDINALITY AS key_columns(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS attribute_row
          ON attribute_row.attrelid = index_row.indrelid
         AND attribute_row.attnum = key_columns.attnum
        WHERE index_row.indexrelid = v_index_oid;
        IF v_unique IS DISTINCT FROM v_expected.unique_index
           OR v_method IS DISTINCT FROM 'btree'
           OR v_columns IS DISTINCT FROM v_expected.key_columns
           OR v_predicate IS DISTINCT FROM v_expected.predicate THEN
            RAISE EXCEPTION 'W1A_GUARD_INDEX_SHAPE: public.%', v_expected.index_name;
        END IF;
    END LOOP;
END;
$w1a_index_guard$;

DO $w1a_trigger_guard$
DECLARE
    v_name TEXT;
    v_oid OID;
    v_expected TEXT[];
    v_actual_count INTEGER;
    v_trigger_oid OID;
    v_trigger_function OID;
    v_expected_function OID;
    v_enabled "char";
    v_type INTEGER;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_artifacts', 'analysis_costs', 'analysis_cache',
        'analysis_audit_bundles', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ] LOOP
        v_expected := CASE v_name
            WHEN 'analysis_costs' THEN ARRAY['analysis_costs_append_only']
            WHEN 'analysis_audit_bundles' THEN ARRAY['analysis_audit_bundles_append_only']
            WHEN 'system_configuration' THEN ARRAY['system_configuration_immutable']
            ELSE ARRAY[]::TEXT[]
        END;
        SELECT expected.relation_oid INTO v_oid
        FROM pg_temp.w1a_expected_relations AS expected
        WHERE expected.relation_name = v_name;
        SELECT pg_catalog.count(*) INTO v_actual_count
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = v_oid
          AND NOT trigger_row.tgisinternal;
        IF v_actual_count <> pg_catalog.cardinality(v_expected)
           OR EXISTS (
               SELECT 1
               FROM pg_catalog.pg_trigger AS trigger_row
               WHERE trigger_row.tgrelid = v_oid
                 AND NOT trigger_row.tgisinternal
                 AND NOT (trigger_row.tgname = ANY(v_expected))
           )
           OR EXISTS (
               SELECT 1
               FROM pg_catalog.unnest(v_expected) AS expected_name
               WHERE NOT EXISTS (
                   SELECT 1
                   FROM pg_catalog.pg_trigger AS trigger_row
                   WHERE trigger_row.tgrelid = v_oid
                     AND NOT trigger_row.tgisinternal
                     AND trigger_row.tgname = expected_name
               )
           ) THEN
            RAISE EXCEPTION 'W1A_GUARD_TRIGGER_SET: public.%', v_name;
        END IF;
    END LOOP;

    SELECT pg_catalog.to_regprocedure('public.reject_analysis_canonical_mutation()')
      INTO v_expected_function;
    IF v_expected_function IS NULL THEN
        RAISE EXCEPTION 'W1A_GUARD_SHARED_ANALYSIS_TRIGGER_FUNCTION';
    END IF;
    SELECT trigger_row.oid, trigger_row.tgfoid, trigger_row.tgenabled, trigger_row.tgtype
      INTO v_trigger_oid, v_trigger_function, v_enabled, v_type
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = (
        SELECT relation_oid FROM pg_temp.w1a_expected_relations
        WHERE relation_name = 'analysis_costs'
    )
      AND trigger_row.tgname = 'analysis_costs_append_only'
      AND NOT trigger_row.tgisinternal;
    IF NOT FOUND OR v_trigger_function IS DISTINCT FROM v_expected_function
       OR v_enabled IS DISTINCT FROM 'O' OR v_type <> 27 THEN
        RAISE EXCEPTION 'W1A_GUARD_ANALYSIS_TRIGGER_SHAPE';
    END IF;
    SELECT trigger_row.tgfoid, trigger_row.tgenabled, trigger_row.tgtype
      INTO v_trigger_function, v_enabled, v_type
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = (
        SELECT relation_oid FROM pg_temp.w1a_expected_relations
        WHERE relation_name = 'analysis_audit_bundles'
    )
      AND trigger_row.tgname = 'analysis_audit_bundles_append_only'
      AND NOT trigger_row.tgisinternal;
    IF NOT FOUND OR v_trigger_function IS DISTINCT FROM v_expected_function
       OR v_enabled IS DISTINCT FROM 'O' OR v_type <> 27 THEN
        RAISE EXCEPTION 'W1A_GUARD_AUDIT_TRIGGER_SHAPE';
    END IF;

    SELECT pg_catalog.to_regprocedure('public.reject_commerce_append_only_mutation()')
      INTO v_expected_function;
    IF v_expected_function IS NULL THEN
        RAISE EXCEPTION 'W1A_GUARD_SHARED_COMMERCE_TRIGGER_FUNCTION';
    END IF;
    SELECT trigger_row.tgfoid, trigger_row.tgenabled, trigger_row.tgtype
      INTO v_trigger_function, v_enabled, v_type
    FROM pg_catalog.pg_trigger AS trigger_row
    WHERE trigger_row.tgrelid = (
        SELECT relation_oid FROM pg_temp.w1a_expected_relations
        WHERE relation_name = 'system_configuration'
    )
      AND trigger_row.tgname = 'system_configuration_immutable'
      AND NOT trigger_row.tgisinternal;
    IF NOT FOUND OR v_trigger_function IS DISTINCT FROM v_expected_function
       OR v_enabled IS DISTINCT FROM 'O' OR v_type <> 27 THEN
        RAISE EXCEPTION 'W1A_GUARD_CONFIGURATION_TRIGGER_SHAPE';
    END IF;
END;
$w1a_trigger_guard$;

DO $w1a_sequence_guard$
BEGIN
    IF pg_catalog.pg_get_serial_sequence('public.analysis_costs', 'id')
        IS DISTINCT FROM 'public.analysis_costs_id_seq' THEN
        RAISE EXCEPTION 'W1A_GUARD_IDENTITY_SEQUENCE';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS sequence_row
        JOIN pg_catalog.pg_namespace AS sequence_schema
          ON sequence_schema.oid = sequence_row.relnamespace
        WHERE sequence_schema.nspname = 'public'
          AND sequence_row.relname = 'analysis_costs_id_seq'
          AND sequence_row.relkind = 'S'
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_IDENTITY_SEQUENCE_MISSING';
    END IF;
END;
$w1a_sequence_guard$;

CREATE TEMP TABLE pg_temp.w1a_expected_routines (
    signature_text TEXT PRIMARY KEY,
    routine_oid OID
) ON COMMIT DROP;

INSERT INTO pg_temp.w1a_expected_routines(signature_text, routine_oid)
SELECT expected.signature_text,
       pg_catalog.to_regprocedure(expected.signature_text)::OID
FROM (VALUES
    ('public.append_analysis_canonical_artifact(uuid,uuid,text,text,text,text,jsonb,text)'),
    ('public.apply_analysis_canonical_backfill_row(text,text,text,text,text,uuid,jsonb)'),
    ('public.append_analysis_canonical_audit(uuid,integer,text,text,integer,text,text,text,jsonb,text)'),
    ('public.append_analysis_canonical_late_cost_audit(uuid,text,text,text,character,numeric,numeric,boolean,text,text,jsonb,text,text,jsonb,text)'),
    ('public.upsert_analysis_canonical_cache(uuid,text,text,text,timestamptz,text,jsonb)'),
    ('public.append_analysis_canonical_cost(uuid,text,text,text,character,numeric,numeric,boolean,text,jsonb,text,text)'),
    ('public.enqueue_analysis_canonical_retry(uuid,text)'),
    ('public.load_analysis_canonical_family(uuid,text)'),
    ('public.upsert_fulfillment_job_v1(uuid,uuid,text,smallint,bigint,uuid,timestamptz,timestamptz,text,jsonb,timestamptz,timestamptz,timestamptz,timestamptz)'),
    ('public.enqueue_notification_v1(text,text,text,jsonb,text,boolean)'),
    ('public.claim_notification_outbox_v1(integer,text,integer)'),
    ('public.finish_notification_outbox_v1(uuid,uuid,bigint,text,text,integer)'),
    ('public.reconcile_stale_notification_outbox_v1(integer)'),
    ('public.list_notification_outbox_v1(integer)'),
    ('public.list_notification_legacy_outbox_v1(integer)'),
    ('public.canonical_system_configuration_json(jsonb)'),
    ('public.record_system_configuration_v1(text,integer,text,jsonb,text,timestamptz)'),
    ('public.acquire_system_lease_v1(text,text,text,integer)')
) AS expected(signature_text);

DO $w1a_routine_guard$
DECLARE
    v_expected_count INTEGER;
    v_expected_signature TEXT;
    v_oid OID;
    v_service_role_oid OID;
BEGIN
    SELECT pg_catalog.count(*) INTO v_expected_count
    FROM pg_temp.w1a_expected_routines;
    IF v_expected_count <> 18
       OR EXISTS (
           SELECT 1
           FROM pg_temp.w1a_expected_routines AS expected
           WHERE expected.routine_oid IS NULL
       ) THEN
        RAISE EXCEPTION 'W1A_GUARD_ROUTINE_SET';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS routine_row
        JOIN pg_catalog.pg_namespace AS routine_schema
          ON routine_schema.oid = routine_row.pronamespace
        WHERE routine_schema.nspname = 'public'
          AND routine_row.proname IN (
              'append_analysis_canonical_artifact',
              'apply_analysis_canonical_backfill_row',
              'append_analysis_canonical_audit',
              'append_analysis_canonical_late_cost_audit',
              'upsert_analysis_canonical_cache',
              'append_analysis_canonical_cost',
              'enqueue_analysis_canonical_retry',
              'load_analysis_canonical_family',
              'upsert_fulfillment_job_v1',
              'enqueue_notification_v1',
              'claim_notification_outbox_v1',
              'finish_notification_outbox_v1',
              'reconcile_stale_notification_outbox_v1',
              'list_notification_outbox_v1',
              'list_notification_legacy_outbox_v1',
              'canonical_system_configuration_json',
              'record_system_configuration_v1',
              'acquire_system_lease_v1'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM pg_temp.w1a_expected_routines AS expected
              WHERE expected.routine_oid = routine_row.oid
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_UNREVIEWED_ROUTINE_OVERLOAD';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_temp.w1a_expected_routines AS expected
        JOIN pg_catalog.pg_proc AS routine_row
          ON routine_row.oid = expected.routine_oid
        WHERE routine_row.prokind <> 'f'
           OR routine_row.prosecdef IS DISTINCT FROM TRUE
           OR routine_row.proconfig IS NULL
           OR pg_catalog.cardinality(routine_row.proconfig) <> 1
           OR NOT ('search_path=""' = ANY(routine_row.proconfig))
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_ROUTINE_SECURITY';
    END IF;

    SELECT pg_catalog.to_regrole('service_role') INTO v_service_role_oid;
    IF v_service_role_oid IS NULL THEN
        RAISE EXCEPTION 'W1A_GUARD_SERVICE_ROLE_MISSING';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_temp.w1a_expected_routines AS expected
        JOIN pg_catalog.pg_proc AS routine_row
          ON routine_row.oid = expected.routine_oid
        CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(routine_row.proacl, pg_catalog.acldefault('f', routine_row.proowner))
        ) AS privilege
        WHERE privilege.grantee IN (
                  0,
                  pg_catalog.to_regrole('anon'),
                  pg_catalog.to_regrole('authenticated')
              )
           OR privilege.grantee <> v_service_role_oid
              AND privilege.grantee <> routine_row.proowner
           OR privilege.grantee = v_service_role_oid
              AND (
                  privilege.privilege_type <> 'EXECUTE'
                  OR privilege.is_grantable
              )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_ROUTINE_ACL';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_temp.w1a_expected_routines AS expected
        WHERE NOT pg_catalog.has_function_privilege(
            v_service_role_oid,
            expected.routine_oid,
            'EXECUTE'
        )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_ROUTINE_SERVICE_EXECUTE';
    END IF;

    -- Stored dependencies and lexical references are checked separately.
    -- The latter catches dynamic SQL literals that do not register a catalog
    -- dependency, including calls from retained routines.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_proc AS caller
          ON caller.oid = dependency.objid
        WHERE dependency.classid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refobjid IN (
              SELECT routine_oid FROM pg_temp.w1a_expected_routines
          )
          AND NOT EXISTS (
              SELECT 1
              FROM pg_temp.w1a_expected_routines AS expected
              WHERE expected.routine_oid = caller.oid
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_RETAINED_ROUTINE_CALLER';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_proc AS caller
          ON caller.oid = dependency.objid
        WHERE dependency.classid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND dependency.refobjid IN (
              SELECT relation_oid FROM pg_temp.w1a_expected_relations
          )
          AND NOT EXISTS (
              SELECT 1
              FROM pg_temp.w1a_expected_routines AS expected
              WHERE expected.routine_oid = caller.oid
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_RETAINED_CANDIDATE_DEPENDENCY';
    END IF;
    IF EXISTS (
        WITH routine_definitions AS (
            SELECT caller.oid,
                   pg_catalog.regexp_replace(
                       pg_catalog.regexp_replace(
                           pg_catalog.pg_get_functiondef(caller.oid),
                           E'/[*]([^*]|[*][^/])*[*]/', ' ', 'g'
                       ),
                       E'--[^\\r\\n]*', ' ', 'g'
                   ) AS normalized_definition
            FROM pg_catalog.pg_proc AS caller
            JOIN pg_catalog.pg_namespace AS routine_schema
              ON routine_schema.oid = caller.pronamespace
            WHERE routine_schema.nspname NOT LIKE 'pg!_%' ESCAPE '!'
              AND routine_schema.nspname <> 'information_schema'
              AND caller.prokind IN ('f', 'p')
              AND NOT EXISTS (
                  SELECT 1
                  FROM pg_temp.w1a_expected_routines AS expected
                  WHERE expected.routine_oid = caller.oid
              )
        )
        SELECT 1
        FROM routine_definitions
        WHERE normalized_definition ~* $w1a_reference_pattern$(?x)
            (
                analysis_artifacts|analysis_audit_bundles|analysis_cache|analysis_costs|
                fulfillment_jobs|notification_outbox|system_configuration|system_leases|
                append_analysis_canonical_artifact|apply_analysis_canonical_backfill_row|
                append_analysis_canonical_audit|append_analysis_canonical_late_cost_audit|
                upsert_analysis_canonical_cache|append_analysis_canonical_cost|
                enqueue_analysis_canonical_retry|load_analysis_canonical_family|
                upsert_fulfillment_job_v1|enqueue_notification_v1|claim_notification_outbox_v1|
                finish_notification_outbox_v1|reconcile_stale_notification_outbox_v1|
                list_notification_outbox_v1|list_notification_legacy_outbox_v1|
                canonical_system_configuration_json|record_system_configuration_v1|
                acquire_system_lease_v1
            )$w1a_reference_pattern$
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_RETAINED_ROUTINE_DEFINITION_REFERENCE';
    END IF;

    -- These source-family validators and retained trigger entry points are
    -- intentionally outside the target allowlist and must survive intact.
    FOREACH v_expected_signature IN ARRAY ARRAY[
        'public.analysis_canonical_json_value_valid(jsonb)',
        'public.analysis_canonical_payload_valid(jsonb)',
        'public.analysis_canonical_payload_has_only_keys(jsonb,text[])',
        'public.analysis_execution_json_value_valid_v1(jsonb)',
        'public.analysis_execution_payload_valid_v1(jsonb)',
        'public.analysis_execution_payload_has_only_keys_v1(jsonb,text[])',
        'public.record_payment_event_v1(text,text,text,text,uuid,text,text,text,jsonb,timestamptz,integer)',
        'public.append_account_lifecycle_v1(uuid,text,text,jsonb,text)',
        'public.enqueue_maintenance_job_v1(text,text,jsonb,text,boolean)'
    ] LOOP
        IF pg_catalog.to_regprocedure(v_expected_signature) IS NULL THEN
            RAISE EXCEPTION 'W1A_GUARD_RETAINED_ROUTINE_MISSING: %', v_expected_signature;
        END IF;
    END LOOP;
END;
$w1a_routine_guard$;

DO $w1a_acl_guard$
DECLARE
    v_oid OID;
    v_name TEXT;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache',
        'analysis_costs', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ] LOOP
        SELECT expected.relation_oid INTO v_oid
        FROM pg_temp.w1a_expected_relations AS expected
        WHERE expected.relation_name = v_name;
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.aclexplode(
                (SELECT COALESCE(
                    relation_row.relacl,
                    pg_catalog.acldefault('r', relation_row.relowner)
                ) FROM pg_catalog.pg_class AS relation_row WHERE relation_row.oid = v_oid)
            ) AS privilege
            WHERE privilege.grantee IN (
                0,
                pg_catalog.to_regrole('anon'),
                pg_catalog.to_regrole('authenticated'),
                pg_catalog.to_regrole('service_role')
            )
        ) THEN
            RAISE EXCEPTION 'W1A_GUARD_TABLE_ACL: public.%', v_name;
        END IF;
    END LOOP;
END;
$w1a_acl_guard$;

-- Column ACLs are part of the exact source shape.  The two projection tables
-- intentionally retain only service_role SELECT on every listed column;
-- every other candidate column must have no explicit column ACL.
CREATE TEMP TABLE pg_temp.w1a_expected_column_acl (
    relation_name TEXT NOT NULL,
    column_name TEXT NOT NULL,
    grantee_name TEXT NOT NULL,
    privilege_type TEXT NOT NULL,
    is_grantable BOOLEAN NOT NULL,
    PRIMARY KEY (relation_name, column_name)
) ON COMMIT DROP;

INSERT INTO pg_temp.w1a_expected_column_acl(
    relation_name, column_name, grantee_name, privilege_type, is_grantable
) VALUES
    ('analysis_artifacts', 'id', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'request_id', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'job_id', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'kind', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'artifact_key', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'state', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'content_hash', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'payload', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'retention_class', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'created_at', 'service_role', 'SELECT', FALSE),
    ('analysis_artifacts', 'updated_at', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'id', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'request_id', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'provider', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'operation_key', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'stage', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'currency', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'amount_known', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'amount_conservative', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'usage_unknown', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'source_hash', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'idempotency_key', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'payload', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'retention_class', 'service_role', 'SELECT', FALSE),
    ('analysis_costs', 'recorded_at', 'service_role', 'SELECT', FALSE);

DO $w1a_column_acl_guard$
DECLARE
    v_expected RECORD;
    v_relation_oid OID;
BEGIN
    IF (SELECT pg_catalog.count(*) FROM pg_temp.w1a_expected_column_acl) <> 25 THEN
        RAISE EXCEPTION 'W1A_GUARD_COLUMN_ACL_ALLOWLIST';
    END IF;

    FOR v_expected IN
        SELECT * FROM pg_temp.w1a_expected_column_acl
    LOOP
        SELECT expected.relation_oid INTO v_relation_oid
        FROM pg_temp.w1a_expected_relations AS expected
        WHERE expected.relation_name = v_expected.relation_name;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute AS attribute_row
            WHERE attribute_row.attrelid = v_relation_oid
              AND attribute_row.attname = v_expected.column_name
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
              AND attribute_row.attacl IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'W1A_GUARD_COLUMN_ACL_MISSING: public.%.%',
                v_expected.relation_name, v_expected.column_name;
        END IF;

        IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_attribute AS attribute_row
            CROSS JOIN LATERAL pg_catalog.aclexplode(attribute_row.attacl) AS privilege
            WHERE attribute_row.attrelid = v_relation_oid
              AND attribute_row.attname = v_expected.column_name
              AND attribute_row.attnum > 0
              AND NOT attribute_row.attisdropped
            GROUP BY attribute_row.attrelid, attribute_row.attnum
            HAVING pg_catalog.count(*) = 1
               AND pg_catalog.bool_and(
                   privilege.grantee = pg_catalog.to_regrole(v_expected.grantee_name)
                   AND privilege.privilege_type = v_expected.privilege_type
                   AND privilege.is_grantable = v_expected.is_grantable
               )
        ) THEN
            RAISE EXCEPTION 'W1A_GUARD_COLUMN_ACL_SHAPE: public.%.%',
                v_expected.relation_name, v_expected.column_name;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute AS attribute_row
        JOIN pg_temp.w1a_expected_relations AS expected
          ON expected.relation_oid = attribute_row.attrelid
        WHERE attribute_row.attnum > 0
          AND NOT attribute_row.attisdropped
          AND attribute_row.attacl IS NOT NULL
          AND NOT EXISTS (
              SELECT 1
              FROM pg_temp.w1a_expected_column_acl AS expected_column
              WHERE expected_column.relation_name = expected.relation_name
                AND expected_column.column_name = attribute_row.attname
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_COLUMN_ACL_EXTRA';
    END IF;
END;
$w1a_column_acl_guard$;

DO $w1a_zero_count_guard$
DECLARE
    v_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_count FROM public.analysis_artifacts;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W1A_GUARD_NONZERO: public.analysis_artifacts';
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.analysis_audit_bundles;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W1A_GUARD_NONZERO: public.analysis_audit_bundles';
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.analysis_cache;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W1A_GUARD_NONZERO: public.analysis_cache';
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.analysis_costs;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W1A_GUARD_NONZERO: public.analysis_costs';
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.fulfillment_jobs;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W1A_GUARD_NONZERO: public.fulfillment_jobs';
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.notification_outbox;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W1A_GUARD_NONZERO: public.notification_outbox';
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.system_configuration;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W1A_GUARD_NONZERO: public.system_configuration';
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.system_leases;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'W1A_GUARD_NONZERO: public.system_leases';
    END IF;
END;
$w1a_zero_count_guard$;

-- Drop only the reviewed candidate triggers and routines.  Shared validator,
-- provider, payment-event, maintenance, account-lifecycle, and operator-audit
-- routines are never named by a destructive statement.
DROP TRIGGER analysis_costs_append_only ON public.analysis_costs;
DROP TRIGGER analysis_audit_bundles_append_only ON public.analysis_audit_bundles;
DROP TRIGGER system_configuration_immutable ON public.system_configuration;

REVOKE ALL ON TABLE public.analysis_artifacts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_audit_bundles FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_cache FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_costs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.fulfillment_jobs FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.notification_outbox FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.system_configuration FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.system_leases FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.append_analysis_canonical_artifact(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.apply_analysis_canonical_backfill_row(
    TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_audit(
    UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_late_cost_audit(
    UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT,
    JSONB, TEXT, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_analysis_canonical_cache(
    UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.append_analysis_canonical_cost(
    UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_analysis_canonical_family(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.upsert_fulfillment_job_v1(
    UUID, UUID, TEXT, SMALLINT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT,
    JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.enqueue_notification_v1(
    TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.claim_notification_outbox_v1(INTEGER, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.finish_notification_outbox_v1(
    UUID, UUID, BIGINT, TEXT, TEXT, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reconcile_stale_notification_outbox_v1(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_notification_outbox_v1(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.list_notification_legacy_outbox_v1(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.canonical_system_configuration_json(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.record_system_configuration_v1(
    TEXT, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION public.append_analysis_canonical_artifact(
    UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
);
DROP FUNCTION public.apply_analysis_canonical_backfill_row(
    TEXT, TEXT, TEXT, TEXT, TEXT, UUID, JSONB
);
DROP FUNCTION public.append_analysis_canonical_audit(
    UUID, INTEGER, TEXT, TEXT, INTEGER, TEXT, TEXT, TEXT, JSONB, TEXT
);
DROP FUNCTION public.append_analysis_canonical_late_cost_audit(
    UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, TEXT,
    JSONB, TEXT, TEXT, JSONB, TEXT
);
DROP FUNCTION public.upsert_analysis_canonical_cache(
    UUID, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, JSONB
);
DROP FUNCTION public.append_analysis_canonical_cost(
    UUID, TEXT, TEXT, TEXT, CHAR, NUMERIC, NUMERIC, BOOLEAN, TEXT, JSONB, TEXT, TEXT
);
DROP FUNCTION public.enqueue_analysis_canonical_retry(UUID, TEXT);
DROP FUNCTION public.load_analysis_canonical_family(UUID, TEXT);
DROP FUNCTION public.upsert_fulfillment_job_v1(
    UUID, UUID, TEXT, SMALLINT, BIGINT, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT,
    JSONB, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ
);
DROP FUNCTION public.enqueue_notification_v1(TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN);
DROP FUNCTION public.claim_notification_outbox_v1(INTEGER, TEXT, INTEGER);
DROP FUNCTION public.finish_notification_outbox_v1(UUID, UUID, BIGINT, TEXT, TEXT, INTEGER);
DROP FUNCTION public.reconcile_stale_notification_outbox_v1(INTEGER);
DROP FUNCTION public.list_notification_outbox_v1(INTEGER);
DROP FUNCTION public.list_notification_legacy_outbox_v1(INTEGER);
DROP FUNCTION public.canonical_system_configuration_json(JSONB);
DROP FUNCTION public.record_system_configuration_v1(TEXT, INTEGER, TEXT, JSONB, TEXT, TIMESTAMPTZ);
DROP FUNCTION public.acquire_system_lease_v1(TEXT, TEXT, TEXT, INTEGER);

ALTER TABLE public.analysis_artifacts
    DROP CONSTRAINT analysis_artifacts_content_hash_check,
    DROP CONSTRAINT analysis_artifacts_job_id_fkey,
    DROP CONSTRAINT analysis_artifacts_kind_check,
    DROP CONSTRAINT analysis_artifacts_payload_check,
    DROP CONSTRAINT analysis_artifacts_pkey,
    DROP CONSTRAINT analysis_artifacts_request_id_artifact_key_content_hash_key,
    DROP CONSTRAINT analysis_artifacts_request_id_fkey,
    DROP CONSTRAINT analysis_artifacts_state_check;
ALTER TABLE public.analysis_costs
    DROP CONSTRAINT analysis_costs_amount_conservative_check,
    DROP CONSTRAINT analysis_costs_amount_known_check,
    DROP CONSTRAINT analysis_costs_check,
    DROP CONSTRAINT analysis_costs_check1,
    DROP CONSTRAINT analysis_costs_payload_check,
    DROP CONSTRAINT analysis_costs_pkey,
    DROP CONSTRAINT analysis_costs_request_id_fkey,
    DROP CONSTRAINT analysis_costs_source_hash_check;
ALTER TABLE public.analysis_cache
    DROP CONSTRAINT analysis_cache_cache_key_hash_check,
    DROP CONSTRAINT analysis_cache_payload_check,
    DROP CONSTRAINT analysis_cache_pkey,
    DROP CONSTRAINT analysis_cache_request_id_fkey,
    DROP CONSTRAINT analysis_cache_request_id_scope_cache_key_hash_key,
    DROP CONSTRAINT analysis_cache_scope_check,
    DROP CONSTRAINT analysis_cache_single_flight_token_hash_check,
    DROP CONSTRAINT analysis_cache_state_check;
ALTER TABLE public.analysis_audit_bundles
    DROP CONSTRAINT analysis_audit_bundles_content_hash_check,
    DROP CONSTRAINT analysis_audit_bundles_kind_check,
    DROP CONSTRAINT analysis_audit_bundles_payload_check,
    DROP CONSTRAINT analysis_audit_bundles_pkey,
    DROP CONSTRAINT analysis_audit_bundles_request_id_fkey,
    DROP CONSTRAINT analysis_audit_bundles_request_id_version_kind_content_hash_key,
    DROP CONSTRAINT analysis_audit_bundles_state_check,
    DROP CONSTRAINT analysis_audit_bundles_version_check;
ALTER TABLE public.fulfillment_jobs
    DROP CONSTRAINT fulfillment_jobs_attempt_count_check,
    DROP CONSTRAINT fulfillment_jobs_check,
    DROP CONSTRAINT fulfillment_jobs_check1,
    DROP CONSTRAINT fulfillment_jobs_check2,
    DROP CONSTRAINT fulfillment_jobs_check3,
    DROP CONSTRAINT fulfillment_jobs_check4,
    DROP CONSTRAINT fulfillment_jobs_lease_generation_check,
    DROP CONSTRAINT fulfillment_jobs_order_id_fkey,
    DROP CONSTRAINT fulfillment_jobs_order_id_key,
    DROP CONSTRAINT fulfillment_jobs_payload_check,
    DROP CONSTRAINT fulfillment_jobs_pkey,
    DROP CONSTRAINT fulfillment_jobs_request_id_fkey,
    DROP CONSTRAINT fulfillment_jobs_request_id_key,
    DROP CONSTRAINT fulfillment_jobs_state_check;
ALTER TABLE public.notification_outbox
    DROP CONSTRAINT notification_outbox_attempt_count_check,
    DROP CONSTRAINT notification_outbox_channel_check,
    DROP CONSTRAINT notification_outbox_content_hash_check,
    DROP CONSTRAINT notification_outbox_dedupe_key_key,
    DROP CONSTRAINT notification_outbox_lease_generation_check,
    DROP CONSTRAINT notification_outbox_lease_holder_hash_check,
    DROP CONSTRAINT notification_outbox_payload_check,
    DROP CONSTRAINT notification_outbox_pkey,
    DROP CONSTRAINT notification_outbox_state_check;
ALTER TABLE public.system_configuration
    DROP CONSTRAINT system_configuration_config_check,
    DROP CONSTRAINT system_configuration_content_hash_check,
    DROP CONSTRAINT system_configuration_pkey,
    DROP CONSTRAINT system_configuration_state_check,
    DROP CONSTRAINT system_configuration_version_check;
ALTER TABLE public.system_leases
    DROP CONSTRAINT system_leases_fence_token_check,
    DROP CONSTRAINT system_leases_generation_check,
    DROP CONSTRAINT system_leases_holder_hash_check,
    DROP CONSTRAINT system_leases_kind_check,
    DROP CONSTRAINT system_leases_payload_check,
    DROP CONSTRAINT system_leases_pkey,
    DROP CONSTRAINT system_leases_state_check;

DROP INDEX public.analysis_artifacts_request_kind_idx;
DROP INDEX public.analysis_costs_request_recorded_idx;
DROP INDEX public.analysis_costs_request_idempotency_idx;
DROP INDEX public.analysis_cache_expiry_idx;
DROP INDEX public.analysis_cache_request_updated_idx;
DROP INDEX public.analysis_audit_request_version_idx;
DROP INDEX public.analysis_audit_request_idempotency_idx;
DROP INDEX public.fulfillment_jobs_recovery_idx;
DROP INDEX public.notification_outbox_delivery_idx;
DROP INDEX public.system_configuration_effective_idx;
DROP INDEX public.system_leases_expiry_idx;

ALTER TABLE public.analysis_costs ALTER COLUMN id DROP IDENTITY;

DROP TABLE public.analysis_artifacts;
DROP TABLE public.analysis_audit_bundles;
DROP TABLE public.analysis_cache;
DROP TABLE public.analysis_costs;
DROP TABLE public.fulfillment_jobs;
DROP TABLE public.notification_outbox;
DROP TABLE public.system_configuration;
DROP TABLE public.system_leases;

DO $w1a_terminal_guard$
DECLARE
    v_name TEXT;
    v_oid OID;
    v_public_table_count BIGINT;
BEGIN
    FOREACH v_name IN ARRAY ARRAY[
        'analysis_artifacts', 'analysis_audit_bundles', 'analysis_cache',
        'analysis_costs', 'fulfillment_jobs', 'notification_outbox',
        'system_configuration', 'system_leases'
    ] LOOP
        IF pg_catalog.to_regclass('public.' || v_name) IS NOT NULL THEN
            RAISE EXCEPTION 'W1A_GUARD_TABLE_REMAINS: public.%', v_name;
        END IF;
    END LOOP;
    IF pg_catalog.to_regclass('public.analysis_costs_id_seq') IS NOT NULL THEN
        RAISE EXCEPTION 'W1A_GUARD_SEQUENCE_REMAINS';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS routine_row
        JOIN pg_catalog.pg_namespace AS routine_schema
          ON routine_schema.oid = routine_row.pronamespace
        WHERE routine_schema.nspname = 'public'
          AND routine_row.proname IN (
              'append_analysis_canonical_artifact',
              'apply_analysis_canonical_backfill_row',
              'append_analysis_canonical_audit',
              'append_analysis_canonical_late_cost_audit',
              'upsert_analysis_canonical_cache',
              'append_analysis_canonical_cost',
              'enqueue_analysis_canonical_retry',
              'load_analysis_canonical_family',
              'upsert_fulfillment_job_v1',
              'enqueue_notification_v1',
              'claim_notification_outbox_v1',
              'finish_notification_outbox_v1',
              'reconcile_stale_notification_outbox_v1',
              'list_notification_outbox_v1',
              'list_notification_legacy_outbox_v1',
              'canonical_system_configuration_json',
              'record_system_configuration_v1',
              'acquire_system_lease_v1'
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_ROUTINE_REMAINS';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS index_relation
        JOIN pg_catalog.pg_namespace AS index_schema
          ON index_schema.oid = index_relation.relnamespace
        WHERE index_schema.nspname = 'public'
          AND index_relation.relkind = 'i'
          AND index_relation.relname IN (
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
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_INDEX_REMAINS';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE NOT trigger_row.tgisinternal
          AND trigger_row.tgname IN (
              'analysis_costs_append_only',
              'analysis_audit_bundles_append_only',
              'system_configuration_immutable'
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_TRIGGER_REMAINS';
    END IF;

    SELECT pg_catalog.count(*) INTO v_public_table_count
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p');
    IF v_public_table_count <> 152 THEN
        RAISE EXCEPTION 'W1A_GUARD_POST_TABLE_COUNT: expected 152, found %',
            v_public_table_count;
    END IF;

    -- Confirm the retained append-only entry points still belong to the
    -- retained objects after every candidate drop.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = 'public.analysis_events'::REGCLASS
          AND trigger_row.tgname = 'analysis_events_append_only'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
              'public.reject_analysis_canonical_mutation()'
          )
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = 'public.payment_events'::REGCLASS
          AND trigger_row.tgname = 'payment_events_immutable'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
              'public.reject_commerce_append_only_mutation()'
          )
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = 'public.account_lifecycle'::REGCLASS
          AND trigger_row.tgname = 'account_lifecycle_immutable'
          AND NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
              'public.reject_commerce_append_only_mutation()'
          )
    ) THEN
        RAISE EXCEPTION 'W1A_GUARD_RETAINED_TRIGGER_MISSING';
    END IF;
END;
$w1a_terminal_guard$;

COMMIT;
