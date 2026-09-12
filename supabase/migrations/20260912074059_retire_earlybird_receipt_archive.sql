-- Supabase 22 bounded earlybird receipt cutover.
--
-- The 13 historical ledgers are preserved as typed, source-labelled receipts
-- in maintenance_jobs before their relations are retired.  This migration is
-- intentionally self-contained: it does not alter payment/analysis rows,
-- enqueue/claim/finish routines, or the sibling retirement cohorts.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL timezone = 'UTC';

SELECT pg_catalog.pg_advisory_xact_lock(22091112, 22);

DO $predecessor_guard$
DECLARE
    v_pending_present BOOLEAN := TRUE;
    v_three_table_present BOOLEAN := TRUE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1 FROM supabase_migrations.schema_migrations
                WHERE version = '20260912073338'
            )
        $sql$ INTO v_pending_present;
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1 FROM supabase_migrations.schema_migrations
                WHERE version = '20260912070144'
            )
        $sql$ INTO v_three_table_present;
    END IF;
    IF NOT v_pending_present OR NOT v_three_table_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$predecessor_guard$;

DO $active_ddl_guard$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_stat_activity AS activity
        CROSS JOIN LATERAL (
            SELECT pg_catalog.regexp_replace(
                pg_catalog.regexp_replace(
                    activity.query,
                    E'/[*]([^*]|[*][^/])*[*]/', ' ', 'g'
                ),
                E'--[^\\r\\n]*', ' ', 'g'
            ) AS normalized_query
        ) AS normalized
        WHERE activity.pid <> pg_catalog.pg_backend_pid()
          AND activity.datname = pg_catalog.current_database()
          AND (
              activity.backend_type IS NULL
              OR (
                  activity.backend_type = 'client backend'
                  AND (
                      activity.state IS NULL
                      OR activity.query IS NULL
                      OR activity.query = '<insufficient privilege>'
                      OR (
                          activity.state IN (
                              'active', 'idle in transaction',
                              'idle in transaction (aborted)'
                          )
                          AND normalized.normalized_query ~* $pattern$(?x)
                              (
                                  (CREATE OR ALTER|CREATE|ALTER|DROP)
                                  [[:space:]]+(FUNCTION|PROCEDURE|ROUTINE)
                                | (CREATE|ALTER|DROP)[[:space:]]+PUBLICATION
                              )
                          $pattern$
                      )
                  )
              )
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_ACTIVE_DDL', ERRCODE = 'P0001';
    END IF;
END;
$active_ddl_guard$;

DO $baseline_guard$
DECLARE
    v_table_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_table_count
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p');
    IF v_table_count <> 173 THEN
        RAISE EXCEPTION USING
            MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_PUBLIC_TABLE_BASELINE:%s', v_table_count),
            ERRCODE = 'P0001';
    END IF;
END;
$baseline_guard$;

-- Capture OIDs before the lock and revalidate them after the lock.  A
-- same-name replacement must never be mistaken for the reviewed relation.
CREATE TEMP TABLE pg_temp.earlybird_receipt_expected_oids (
    relation_name TEXT PRIMARY KEY,
    relation_oid OID NOT NULL
) ON COMMIT DROP;

INSERT INTO pg_temp.earlybird_receipt_expected_oids(relation_name, relation_oid)
SELECT relation_row.relname, relation_row.oid
FROM pg_catalog.pg_class AS relation_row
JOIN pg_catalog.pg_namespace AS relation_schema
  ON relation_schema.oid = relation_row.relnamespace
WHERE relation_schema.nspname = 'public'
  AND relation_row.relkind = 'r'
  AND relation_row.relname IN (
      'maintenance_jobs',
      'earlybird_adoption_policy_failure_rearms',
      'earlybird_concierge_snapshot_conflict_recoveries',
      'earlybird_pfe_target_evidence_start_rejection_rearms',
      'earlybird_pfe3_media_artifact_rearms',
      'earlybird_profile_fetch_exhaustion_recoveries',
      'earlybird_schema_failure_recoveries',
      'earlybird_terminal_unavailable_exhaustion_rearms',
      'earlybird_v211_apify_transient_replays',
      'earlybird_v211_concierge_replays',
      'earlybird_v211_lease_policy_failure_rearms',
      'earlybird_v211_policy_identity_replays',
      'earlybird_v211_profile_ai_diagnostic_replays',
      'earlybird_v211_relationship_lineage_failure_rearms'
  );

DO $relation_presence_guard$
DECLARE
    v_count INTEGER;
BEGIN
    SELECT pg_catalog.count(*) INTO v_count
    FROM pg_temp.earlybird_receipt_expected_oids;
    IF v_count <> 14 THEN
        RAISE EXCEPTION USING
            MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_RELATIONS_MISSING:%s', v_count),
            ERRCODE = 'P0001';
    END IF;
END;
$relation_presence_guard$;

LOCK TABLE
    public.earlybird_adoption_policy_failure_rearms,
    public.earlybird_concierge_snapshot_conflict_recoveries,
    public.earlybird_pfe3_media_artifact_rearms,
    public.earlybird_pfe_target_evidence_start_rejection_rearms,
    public.earlybird_profile_fetch_exhaustion_recoveries,
    public.earlybird_schema_failure_recoveries,
    public.earlybird_terminal_unavailable_exhaustion_rearms,
    public.earlybird_v211_apify_transient_replays,
    public.earlybird_v211_concierge_replays,
    public.earlybird_v211_lease_policy_failure_rearms,
    public.earlybird_v211_policy_identity_replays,
    public.earlybird_v211_profile_ai_diagnostic_replays,
    public.earlybird_v211_relationship_lineage_failure_rearms,
    public.maintenance_jobs
    IN ACCESS EXCLUSIVE MODE;

DO $relation_revalidation_guard$
DECLARE
    v_relation_name TEXT;
    v_expected_oid OID;
    v_actual_oid OID;
    v_actual_kind "char";
BEGIN
    FOR v_relation_name, v_expected_oid IN
        SELECT relation_name, relation_oid
        FROM pg_temp.earlybird_receipt_expected_oids
        ORDER BY relation_name
    LOOP
        SELECT relation_row.oid, relation_row.relkind
          INTO v_actual_oid, v_actual_kind
        FROM pg_catalog.pg_class AS relation_row
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relname = v_relation_name;
        IF NOT FOUND OR v_actual_kind <> 'r' OR v_actual_oid <> v_expected_oid THEN
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_RELATION_REPLACED:%s', v_relation_name),
                ERRCODE = 'P0001';
        END IF;
    END LOOP;
END;
$relation_revalidation_guard$;

DO $catalog_guard$
DECLARE
    v_table_name TEXT;
    v_expected_columns TEXT[];
    v_actual_columns TEXT[];
    v_maintenance_columns TEXT[];
BEGIN
    SELECT pg_catalog.array_agg(
        pg_catalog.format(
            '%s:%s:%s', attribute.attname,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
            CASE WHEN attribute.attnotnull THEN 'true' ELSE 'false' END
        ) ORDER BY attribute.attnum
    ) INTO v_maintenance_columns
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation_row
      ON relation_row.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'maintenance_jobs'
      AND relation_row.relkind = 'r'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
    IF v_maintenance_columns IS DISTINCT FROM ARRAY[
        'id:uuid:true', 'kind:text:true', 'target_key_hash:text:true',
        'state:text:true', 'attempt_count:smallint:true',
        'lease_generation:bigint:true', 'lease_token:uuid:false',
        'lease_holder_hash:text:false',
        'lease_expires_at:timestamp with time zone:false',
        'next_attempt_at:timestamp with time zone:true',
        'terminal_at:timestamp with time zone:false',
        'last_error_code:text:false', 'payload:jsonb:true',
        'content_hash:text:true', 'created_at:timestamp with time zone:true',
        'updated_at:timestamp with time zone:true', 'legacy_pending_user_id:uuid:false'
    ]::TEXT[] THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_MAINTENANCE_SHAPE', ERRCODE = 'P0001';
    END IF;

    FOREACH v_table_name IN ARRAY ARRAY[
        'earlybird_adoption_policy_failure_rearms',
        'earlybird_concierge_snapshot_conflict_recoveries',
        'earlybird_pfe_target_evidence_start_rejection_rearms',
        'earlybird_pfe3_media_artifact_rearms',
        'earlybird_profile_fetch_exhaustion_recoveries',
        'earlybird_schema_failure_recoveries',
        'earlybird_terminal_unavailable_exhaustion_rearms',
        'earlybird_v211_apify_transient_replays',
        'earlybird_v211_concierge_replays',
        'earlybird_v211_lease_policy_failure_rearms',
        'earlybird_v211_policy_identity_replays',
        'earlybird_v211_profile_ai_diagnostic_replays',
        'earlybird_v211_relationship_lineage_failure_rearms'
    ] LOOP
        v_expected_columns := CASE v_table_name
            WHEN 'earlybird_adoption_policy_failure_rearms' THEN ARRAY[
                'order_id:uuid:true', 'original_failed_request_id:uuid:true',
                'policy_failed_request_id:uuid:true', 'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_concierge_snapshot_conflict_recoveries' THEN ARRAY[
                'order_id:uuid:true', 'preflight_id:uuid:true',
                'provider_operation_key:text:true', 'provider_input_hash:character varying(64):true',
                'provider_run_id_hash:character varying(32):true',
                'expected_manual_review_at:timestamp with time zone:true',
                'expected_admission_refreshed_at:timestamp with time zone:true',
                'old_order_followers_count:integer:true', 'old_order_following_count:integer:true',
                'old_preflight_followers_count:integer:true', 'old_preflight_following_count:integer:true',
                'new_witness_followers_count:integer:true', 'new_witness_following_count:integer:true',
                'old_snapshot_recorded_at:timestamp with time zone:true',
                'new_witness_recorded_at:timestamp with time zone:true',
                'recovery_reason:text:true', 'followers_absolute_delta:integer:true',
                'following_absolute_delta:integer:true', 'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_pfe_target_evidence_start_rejection_rearms' THEN ARRAY[
                'order_id:uuid:true', 'pfe_original_failed_request_id:uuid:true',
                'rejected_successor_request_id:uuid:true', 'rearmed_preflight_id:uuid:true',
                'prior_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_pfe3_media_artifact_rearms' THEN ARRAY[
                'order_id:uuid:true', 'pfe_original_failed_request_id:uuid:true',
                'pfe2_rejected_successor_request_id:uuid:true',
                'media_failed_request_id:uuid:true', 'rearmed_preflight_id:uuid:true',
                'prior_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_profile_fetch_exhaustion_recoveries' THEN ARRAY[
                'order_id:uuid:true', 'failed_request_id:uuid:true',
                'recovery_preflight_id:uuid:true', 'prior_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_schema_failure_recoveries' THEN ARRAY[
                'order_id:uuid:true', 'failed_request_id:uuid:true',
                'recovery_preflight_id:uuid:true', 'prior_attempt_count:smallint:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_terminal_unavailable_exhaustion_rearms' THEN ARRAY[
                'order_id:uuid:true', 'failed_request_id:uuid:true',
                'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v211_apify_transient_replays' THEN ARRAY[
                'order_id:uuid:true', 'original_failed_request_id:uuid:true',
                'policy_identity_failed_request_id:uuid:true',
                'transient_failed_request_id:uuid:true', 'failed_preflight_id:uuid:true',
                'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v211_concierge_replays' THEN ARRAY[
                'order_id:uuid:true', 'original_failed_request_id:uuid:true',
                'first_relationship_failed_request_id:uuid:true',
                'second_relationship_failed_request_id:uuid:true',
                'failed_preflight_id:uuid:true', 'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true',
                'reviewed_source_request_id:uuid:false', 'reviewed_source_owner_id:uuid:false',
                'reviewed_source_target_instagram_id:text:false',
                'reviewed_source_result_request_id:uuid:false',
                'reviewed_source_target_posts:jsonb:false',
                'reviewed_source_target_evidence:jsonb:false',
                'reviewed_source_fingerprint:character varying(64):false',
                'reviewed_source_registered_at:timestamp with time zone:false',
                'published_source_fingerprint:character varying(64):false',
                'published_result_hash:character varying(64):false',
                'published_at:timestamp with time zone:false'
            ]
            WHEN 'earlybird_v211_lease_policy_failure_rearms' THEN ARRAY[
                'order_id:uuid:true', 'failed_request_id:uuid:true',
                'source_preflight_id:uuid:true', 'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v211_policy_identity_replays' THEN ARRAY[
                'order_id:uuid:true', 'original_failed_request_id:uuid:true',
                'policy_identity_failed_request_id:uuid:true',
                'failed_preflight_id:uuid:true', 'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v211_profile_ai_diagnostic_replays' THEN ARRAY[
                'order_id:uuid:true', 'original_failed_request_id:uuid:true',
                'profile_ai_failed_request_id:uuid:true', 'failed_preflight_id:uuid:true',
                'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v211_relationship_lineage_failure_rearms' THEN ARRAY[
                'order_id:uuid:true', 'original_failed_request_id:uuid:true',
                'relationship_failed_request_id:uuid:true',
                'source_preflight_id:uuid:true', 'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
        END;

        SELECT pg_catalog.array_agg(
            pg_catalog.format(
                '%s:%s:%s', attribute.attname,
                pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                CASE WHEN attribute.attnotnull THEN 'true' ELSE 'false' END
            ) ORDER BY attribute.attnum
        ) INTO v_actual_columns
        FROM pg_catalog.pg_attribute AS attribute
        JOIN pg_catalog.pg_class AS relation_row
          ON relation_row.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relname = v_table_name
          AND relation_row.relkind = 'r'
          AND attribute.attnum > 0
          AND NOT attribute.attisdropped;
        IF v_actual_columns IS DISTINCT FROM v_expected_columns THEN
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_SOURCE_SHAPE:%s', v_table_name),
                ERRCODE = 'P0001';
        END IF;

        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_class AS relation_row
            JOIN pg_catalog.pg_namespace AS relation_schema
              ON relation_schema.oid = relation_row.relnamespace
            WHERE relation_schema.nspname = 'public'
              AND relation_row.relname = v_table_name
              AND relation_row.relrowsecurity
              AND relation_row.relforcerowsecurity
        ) OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_trigger AS trigger_row
            JOIN pg_catalog.pg_class AS relation_row
              ON relation_row.oid = trigger_row.tgrelid
            JOIN pg_catalog.pg_namespace AS relation_schema
              ON relation_schema.oid = relation_row.relnamespace
            WHERE relation_schema.nspname = 'public'
              AND relation_row.relname = v_table_name
              AND NOT trigger_row.tgisinternal
              AND trigger_row.tgenabled <> 'D'
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_SOURCE_POLICY:%s', v_table_name),
                ERRCODE = 'P0001';
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint AS constraint_row
        JOIN pg_catalog.pg_class AS referenced_relation
          ON referenced_relation.oid = constraint_row.confrelid
        JOIN pg_catalog.pg_namespace AS referenced_schema
          ON referenced_schema.oid = referenced_relation.relnamespace
        WHERE constraint_row.contype = 'f'
          AND referenced_schema.nspname = 'public'
          AND referenced_relation.relname IN (
              'earlybird_adoption_policy_failure_rearms',
              'earlybird_concierge_snapshot_conflict_recoveries',
              'earlybird_pfe_target_evidence_start_rejection_rearms',
              'earlybird_pfe3_media_artifact_rearms',
              'earlybird_profile_fetch_exhaustion_recoveries',
              'earlybird_schema_failure_recoveries',
              'earlybird_terminal_unavailable_exhaustion_rearms',
              'earlybird_v211_apify_transient_replays',
              'earlybird_v211_concierge_replays',
              'earlybird_v211_lease_policy_failure_rearms',
              'earlybird_v211_policy_identity_replays',
              'earlybird_v211_profile_ai_diagnostic_replays',
              'earlybird_v211_relationship_lineage_failure_rearms'
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_INCOMING_FK', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_rewrite AS rewrite_row
          ON rewrite_row.oid = dependency.objid
        JOIN pg_catalog.pg_class AS dependent_relation
          ON dependent_relation.oid = rewrite_row.ev_class
        JOIN pg_catalog.pg_class AS referenced_relation
          ON referenced_relation.oid = dependency.refobjid
        JOIN pg_catalog.pg_namespace AS referenced_schema
          ON referenced_schema.oid = referenced_relation.relnamespace
        WHERE dependency.classid = 'pg_catalog.pg_rewrite'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND referenced_schema.nspname = 'public'
          AND referenced_relation.relname IN (
              'earlybird_adoption_policy_failure_rearms',
              'earlybird_concierge_snapshot_conflict_recoveries',
              'earlybird_pfe_target_evidence_start_rejection_rearms',
              'earlybird_pfe3_media_artifact_rearms',
              'earlybird_profile_fetch_exhaustion_recoveries',
              'earlybird_schema_failure_recoveries',
              'earlybird_terminal_unavailable_exhaustion_rearms',
              'earlybird_v211_apify_transient_replays',
              'earlybird_v211_concierge_replays',
              'earlybird_v211_lease_policy_failure_rearms',
              'earlybird_v211_policy_identity_replays',
              'earlybird_v211_profile_ai_diagnostic_replays',
              'earlybird_v211_relationship_lineage_failure_rearms'
          )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_DEPENDENT_VIEW', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables)
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_publication_namespace AS publication_schema
            JOIN pg_catalog.pg_namespace AS target_schema
              ON target_schema.oid = publication_schema.pnnspid
            WHERE target_schema.nspname = 'public'
       )
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_publication_rel AS publication_table
            JOIN pg_catalog.pg_class AS target_relation
              ON target_relation.oid = publication_table.prrelid
            JOIN pg_catalog.pg_namespace AS target_schema
              ON target_schema.oid = target_relation.relnamespace
            WHERE target_schema.nspname = 'public'
              AND target_relation.relname IN (
                  'earlybird_adoption_policy_failure_rearms',
                  'earlybird_concierge_snapshot_conflict_recoveries',
                  'earlybird_pfe_target_evidence_start_rejection_rearms',
                  'earlybird_pfe3_media_artifact_rearms',
                  'earlybird_profile_fetch_exhaustion_recoveries',
                  'earlybird_schema_failure_recoveries',
                  'earlybird_terminal_unavailable_exhaustion_rearms',
                  'earlybird_v211_apify_transient_replays',
                  'earlybird_v211_concierge_replays',
                  'earlybird_v211_lease_policy_failure_rearms',
                  'earlybird_v211_policy_identity_replays',
                  'earlybird_v211_profile_ai_diagnostic_replays',
                  'earlybird_v211_relationship_lineage_failure_rearms'
              )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_PUBLICATION_MEMBERSHIP', ERRCODE = 'P0001';
    END IF;
END;
$catalog_guard$;

DO $source_count_guard$
DECLARE
    v_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_adoption_policy_failure_rearms;
    IF v_count <> 2 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:adoption:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_concierge_snapshot_conflict_recoveries;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:snapshot:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_pfe_target_evidence_start_rejection_rearms;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:pfe2:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_pfe3_media_artifact_rearms;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:pfe3:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_profile_fetch_exhaustion_recoveries;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:profile:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_schema_failure_recoveries;
    IF v_count <> 7 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:schema:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_terminal_unavailable_exhaustion_rearms;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:terminal:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v211_apify_transient_replays;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:apify:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v211_concierge_replays;
    IF v_count <> 2 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:concierge:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v211_lease_policy_failure_rearms;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:lease:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v211_policy_identity_replays;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:policy:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v211_profile_ai_diagnostic_replays;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:profile_ai:%', v_count; END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v211_relationship_lineage_failure_rearms;
    IF v_count <> 1 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_COUNT:relationship:%', v_count; END IF;
END;
$source_count_guard$;

-- The expected table is intentionally built from 13 literal branches.  Its
-- payload is the complete legacy row, including the nullable reviewed-source
-- fields on the concierge replay cohort.
CREATE TEMP TABLE pg_temp.earlybird_receipt_expected (
    kind TEXT NOT NULL,
    source_table TEXT NOT NULL,
    payload JSONB NOT NULL,
    target_key_hash TEXT NOT NULL,
    content_hash TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'rearm', 'earlybird_adoption_policy_failure_rearms', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:rearm:earlybird_adoption_policy_failure_rearms:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_adoption_policy_failure_rearms AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_adoption_policy_failure_rearms',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'recovery', 'earlybird_concierge_snapshot_conflict_recoveries', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:recovery:earlybird_concierge_snapshot_conflict_recoveries:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_concierge_snapshot_conflict_recoveries AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_concierge_snapshot_conflict_recoveries',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'rearm', 'earlybird_pfe_target_evidence_start_rejection_rearms', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:rearm:earlybird_pfe_target_evidence_start_rejection_rearms:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_pfe_target_evidence_start_rejection_rearms AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_pfe_target_evidence_start_rejection_rearms',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'rearm', 'earlybird_pfe3_media_artifact_rearms', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:rearm:earlybird_pfe3_media_artifact_rearms:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_pfe3_media_artifact_rearms AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_pfe3_media_artifact_rearms',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'recovery', 'earlybird_profile_fetch_exhaustion_recoveries', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:recovery:earlybird_profile_fetch_exhaustion_recoveries:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_profile_fetch_exhaustion_recoveries AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_profile_fetch_exhaustion_recoveries',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'recovery', 'earlybird_schema_failure_recoveries', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:recovery:earlybird_schema_failure_recoveries:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_schema_failure_recoveries AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_schema_failure_recoveries',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'rearm', 'earlybird_terminal_unavailable_exhaustion_rearms', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:rearm:earlybird_terminal_unavailable_exhaustion_rearms:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_terminal_unavailable_exhaustion_rearms AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_terminal_unavailable_exhaustion_rearms',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'replay', 'earlybird_v211_apify_transient_replays', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:replay:earlybird_v211_apify_transient_replays:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_v211_apify_transient_replays AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_v211_apify_transient_replays',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'replay', 'earlybird_v211_concierge_replays', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:replay:earlybird_v211_concierge_replays:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_v211_concierge_replays AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_v211_concierge_replays',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'rearm', 'earlybird_v211_lease_policy_failure_rearms', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:rearm:earlybird_v211_lease_policy_failure_rearms:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_v211_lease_policy_failure_rearms AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_v211_lease_policy_failure_rearms',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'replay', 'earlybird_v211_policy_identity_replays', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:replay:earlybird_v211_policy_identity_replays:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_v211_policy_identity_replays AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_v211_policy_identity_replays',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'replay', 'earlybird_v211_profile_ai_diagnostic_replays', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:replay:earlybird_v211_profile_ai_diagnostic_replays:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_v211_profile_ai_diagnostic_replays AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_v211_profile_ai_diagnostic_replays',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

INSERT INTO pg_temp.earlybird_receipt_expected(kind, source_table, payload, target_key_hash, content_hash)
SELECT 'rearm', 'earlybird_v211_relationship_lineage_failure_rearms', receipt.payload,
       pg_catalog.encode(extensions.digest(convert_to(
           'supabase-22-legacy-earlybird-retirement-v1:rearm:earlybird_v211_relationship_lineage_failure_rearms:'
           || (receipt.payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex'),
       pg_catalog.encode(extensions.digest(convert_to(receipt.payload::TEXT, 'UTF8'), 'sha256'), 'hex')
FROM public.earlybird_v211_relationship_lineage_failure_rearms AS source_row
CROSS JOIN LATERAL (SELECT pg_catalog.jsonb_build_object(
    'legacy_source_table', 'earlybird_v211_relationship_lineage_failure_rearms',
    'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
    'legacy_row', pg_catalog.to_jsonb(source_row), 'schema_version', 1
) AS payload) AS receipt;

DO $expected_receipt_guard$
DECLARE
    v_expected_count BIGINT;
    v_distinct_keys BIGINT;
BEGIN
    SELECT pg_catalog.count(*), pg_catalog.count(DISTINCT target_key_hash)
      INTO v_expected_count, v_distinct_keys
    FROM pg_temp.earlybird_receipt_expected;
    IF v_expected_count <> 21 OR v_distinct_keys <> v_expected_count THEN
        RAISE EXCEPTION USING
            MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_EXPECTED_ROWS:%s:%s', v_expected_count, v_distinct_keys),
            ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE pg_catalog.jsonb_typeof(payload) IS DISTINCT FROM 'object'
           OR payload->>'schema_version' IS DISTINCT FROM '1'
           OR pg_catalog.jsonb_typeof(payload->'legacy_primary_key') IS DISTINCT FROM 'object'
           OR pg_catalog.jsonb_typeof(payload->'legacy_row') IS DISTINCT FROM 'object'
           OR payload->>'legacy_source_table' IS DISTINCT FROM source_table
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_PAYLOAD_SHAPE', ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_temp.earlybird_receipt_expected AS expected
        WHERE NOT (expected.payload->'legacy_primary_key' ?& ARRAY['order_id'])
           OR expected.payload->'legacy_primary_key'->>'order_id' IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_PRIMARY_KEY_SHAPE', ERRCODE = 'P0001';
    END IF;

    -- Required keys are checked as a source-specific allowlist.  Nullable
    -- reviewed-source keys are still required in the archived object, but may
    -- contain JSON null.
    IF EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_adoption_policy_failure_rearms'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','original_failed_request_id','policy_failed_request_id',
              'rearmed_preflight_id','expected_fulfillment_attempt_count',
              'expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_concierge_snapshot_conflict_recoveries'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','preflight_id','provider_operation_key','provider_input_hash',
              'provider_run_id_hash','expected_manual_review_at','expected_admission_refreshed_at',
              'old_order_followers_count','old_order_following_count',
              'old_preflight_followers_count','old_preflight_following_count',
              'new_witness_followers_count','new_witness_following_count',
              'old_snapshot_recorded_at','new_witness_recorded_at','recovery_reason',
              'followers_absolute_delta','following_absolute_delta','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_pfe_target_evidence_start_rejection_rearms'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','pfe_original_failed_request_id','rejected_successor_request_id',
              'rearmed_preflight_id','prior_attempt_count','expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_pfe3_media_artifact_rearms'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','pfe_original_failed_request_id','pfe2_rejected_successor_request_id',
              'media_failed_request_id','rearmed_preflight_id','prior_attempt_count',
              'expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_profile_fetch_exhaustion_recoveries'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','failed_request_id','recovery_preflight_id','prior_attempt_count',
              'expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_schema_failure_recoveries'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','failed_request_id','recovery_preflight_id','prior_attempt_count','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_terminal_unavailable_exhaustion_rearms'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','failed_request_id','rearmed_preflight_id',
              'expected_fulfillment_attempt_count','expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_v211_apify_transient_replays'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','original_failed_request_id','policy_identity_failed_request_id',
              'transient_failed_request_id','failed_preflight_id','rearmed_preflight_id',
              'expected_fulfillment_attempt_count','expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_v211_concierge_replays'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','original_failed_request_id','first_relationship_failed_request_id',
              'second_relationship_failed_request_id','failed_preflight_id','rearmed_preflight_id',
              'expected_fulfillment_attempt_count','expected_manual_review_at','created_at',
              'reviewed_source_request_id','reviewed_source_owner_id',
              'reviewed_source_target_instagram_id','reviewed_source_result_request_id',
              'reviewed_source_target_posts','reviewed_source_target_evidence',
              'reviewed_source_fingerprint','reviewed_source_registered_at',
              'published_source_fingerprint','published_result_hash','published_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_v211_lease_policy_failure_rearms'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','failed_request_id','source_preflight_id','rearmed_preflight_id',
              'expected_fulfillment_attempt_count','expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_v211_policy_identity_replays'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','original_failed_request_id','policy_identity_failed_request_id',
              'failed_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count',
              'expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_v211_profile_ai_diagnostic_replays'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','original_failed_request_id','profile_ai_failed_request_id',
              'failed_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count',
              'expected_manual_review_at','created_at'
          ])
    ) OR EXISTS (
        SELECT 1 FROM pg_temp.earlybird_receipt_expected
        WHERE source_table = 'earlybird_v211_relationship_lineage_failure_rearms'
          AND NOT (payload->'legacy_row' ?& ARRAY[
              'order_id','original_failed_request_id','relationship_failed_request_id',
              'source_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count',
              'expected_manual_review_at','created_at'
          ])
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_LEGACY_FIELD_MISSING', ERRCODE = 'P0001';
    END IF;
END;
$expected_receipt_guard$;

-- Exercise the typed decode for every source.  The casts are deliberately
-- literal and source-specific; malformed archive data therefore aborts the
-- transaction instead of silently becoming a NULL retention reference.
DO $typed_receipt_guard$
DECLARE
    v_count BIGINT;
BEGIN
    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, original_failed_request_id UUID, policy_failed_request_id UUID,
        rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
        expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_adoption_policy_failure_rearms'
      AND (r.order_id IS NULL OR r.original_failed_request_id IS NULL
        OR r.policy_failed_request_id IS NULL OR r.rearmed_preflight_id IS NULL
        OR r.expected_fulfillment_attempt_count IS NULL OR r.expected_manual_review_at IS NULL
        OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:adoption'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, preflight_id UUID, provider_operation_key TEXT,
        provider_input_hash VARCHAR(64), provider_run_id_hash VARCHAR(32),
        expected_manual_review_at TIMESTAMPTZ, expected_admission_refreshed_at TIMESTAMPTZ,
        old_order_followers_count INTEGER, old_order_following_count INTEGER,
        old_preflight_followers_count INTEGER, old_preflight_following_count INTEGER,
        new_witness_followers_count INTEGER, new_witness_following_count INTEGER,
        old_snapshot_recorded_at TIMESTAMPTZ, new_witness_recorded_at TIMESTAMPTZ,
        recovery_reason TEXT, followers_absolute_delta INTEGER,
        following_absolute_delta INTEGER, created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_concierge_snapshot_conflict_recoveries'
      AND (r.order_id IS NULL OR r.preflight_id IS NULL OR r.provider_operation_key IS NULL
        OR r.provider_input_hash IS NULL OR r.provider_run_id_hash IS NULL
        OR r.expected_manual_review_at IS NULL OR r.expected_admission_refreshed_at IS NULL
        OR r.old_order_followers_count IS NULL OR r.old_order_following_count IS NULL
        OR r.old_preflight_followers_count IS NULL OR r.old_preflight_following_count IS NULL
        OR r.new_witness_followers_count IS NULL OR r.new_witness_following_count IS NULL
        OR r.old_snapshot_recorded_at IS NULL OR r.new_witness_recorded_at IS NULL
        OR r.recovery_reason IS NULL OR r.followers_absolute_delta IS NULL
        OR r.following_absolute_delta IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:snapshot'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, pfe_original_failed_request_id UUID,
        rejected_successor_request_id UUID, rearmed_preflight_id UUID,
        prior_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_pfe_target_evidence_start_rejection_rearms'
      AND (r.order_id IS NULL OR r.pfe_original_failed_request_id IS NULL
        OR r.rejected_successor_request_id IS NULL OR r.rearmed_preflight_id IS NULL
        OR r.prior_attempt_count IS NULL OR r.expected_manual_review_at IS NULL
        OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:pfe2'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, pfe_original_failed_request_id UUID,
        pfe2_rejected_successor_request_id UUID, media_failed_request_id UUID,
        rearmed_preflight_id UUID, prior_attempt_count SMALLINT,
        expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_pfe3_media_artifact_rearms'
      AND (r.order_id IS NULL OR r.pfe_original_failed_request_id IS NULL
        OR r.pfe2_rejected_successor_request_id IS NULL OR r.media_failed_request_id IS NULL
        OR r.rearmed_preflight_id IS NULL OR r.prior_attempt_count IS NULL
        OR r.expected_manual_review_at IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:pfe3'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, failed_request_id UUID, recovery_preflight_id UUID,
        prior_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_profile_fetch_exhaustion_recoveries'
      AND (r.order_id IS NULL OR r.failed_request_id IS NULL OR r.recovery_preflight_id IS NULL
        OR r.prior_attempt_count IS NULL OR r.expected_manual_review_at IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:profile'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, failed_request_id UUID, recovery_preflight_id UUID,
        prior_attempt_count SMALLINT, created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_schema_failure_recoveries'
      AND (r.order_id IS NULL OR r.failed_request_id IS NULL OR r.recovery_preflight_id IS NULL
        OR r.prior_attempt_count IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:schema'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, failed_request_id UUID, rearmed_preflight_id UUID,
        expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_terminal_unavailable_exhaustion_rearms'
      AND (r.order_id IS NULL OR r.failed_request_id IS NULL OR r.rearmed_preflight_id IS NULL
        OR r.expected_fulfillment_attempt_count IS NULL OR r.expected_manual_review_at IS NULL
        OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:terminal'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, original_failed_request_id UUID,
        policy_identity_failed_request_id UUID, transient_failed_request_id UUID,
        failed_preflight_id UUID, rearmed_preflight_id UUID,
        expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_v211_apify_transient_replays'
      AND (r.order_id IS NULL OR r.original_failed_request_id IS NULL
        OR r.policy_identity_failed_request_id IS NULL OR r.transient_failed_request_id IS NULL
        OR r.failed_preflight_id IS NULL OR r.rearmed_preflight_id IS NULL
        OR r.expected_fulfillment_attempt_count IS NULL OR r.expected_manual_review_at IS NULL
        OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:apify'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, original_failed_request_id UUID,
        first_relationship_failed_request_id UUID, second_relationship_failed_request_id UUID,
        failed_preflight_id UUID, rearmed_preflight_id UUID,
        expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ, reviewed_source_request_id UUID, reviewed_source_owner_id UUID,
        reviewed_source_target_instagram_id TEXT, reviewed_source_result_request_id UUID,
        reviewed_source_target_posts JSONB, reviewed_source_target_evidence JSONB,
        reviewed_source_fingerprint VARCHAR(64), reviewed_source_registered_at TIMESTAMPTZ,
        published_source_fingerprint VARCHAR(64), published_result_hash VARCHAR(64),
        published_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_v211_concierge_replays'
      AND (r.order_id IS NULL OR r.original_failed_request_id IS NULL
        OR r.first_relationship_failed_request_id IS NULL
        OR r.second_relationship_failed_request_id IS NULL OR r.failed_preflight_id IS NULL
        OR r.rearmed_preflight_id IS NULL OR r.expected_fulfillment_attempt_count IS NULL
        OR r.expected_manual_review_at IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:concierge'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, failed_request_id UUID, source_preflight_id UUID,
        rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
        expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_v211_lease_policy_failure_rearms'
      AND (r.order_id IS NULL OR r.failed_request_id IS NULL OR r.source_preflight_id IS NULL
        OR r.rearmed_preflight_id IS NULL OR r.expected_fulfillment_attempt_count IS NULL
        OR r.expected_manual_review_at IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:lease'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, original_failed_request_id UUID,
        policy_identity_failed_request_id UUID, failed_preflight_id UUID,
        rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
        expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_v211_policy_identity_replays'
      AND (r.order_id IS NULL OR r.original_failed_request_id IS NULL
        OR r.policy_identity_failed_request_id IS NULL OR r.failed_preflight_id IS NULL
        OR r.rearmed_preflight_id IS NULL OR r.expected_fulfillment_attempt_count IS NULL
        OR r.expected_manual_review_at IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:policy'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, original_failed_request_id UUID,
        profile_ai_failed_request_id UUID, failed_preflight_id UUID,
        rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
        expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_v211_profile_ai_diagnostic_replays'
      AND (r.order_id IS NULL OR r.original_failed_request_id IS NULL
        OR r.profile_ai_failed_request_id IS NULL OR r.failed_preflight_id IS NULL
        OR r.rearmed_preflight_id IS NULL OR r.expected_fulfillment_attempt_count IS NULL
        OR r.expected_manual_review_at IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:profile_ai'; END IF;

    SELECT count(*) INTO v_count FROM pg_temp.earlybird_receipt_expected e
    CROSS JOIN LATERAL jsonb_to_record(e.payload->'legacy_row') AS r(
        order_id UUID, original_failed_request_id UUID,
        relationship_failed_request_id UUID, source_preflight_id UUID,
        rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT,
        expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ
    ) WHERE e.source_table='earlybird_v211_relationship_lineage_failure_rearms'
      AND (r.order_id IS NULL OR r.original_failed_request_id IS NULL
        OR r.relationship_failed_request_id IS NULL OR r.source_preflight_id IS NULL
        OR r.rearmed_preflight_id IS NULL OR r.expected_fulfillment_attempt_count IS NULL
        OR r.expected_manual_review_at IS NULL OR r.created_at IS NULL);
    IF v_count <> 0 THEN RAISE EXCEPTION 'EARLYBIRD_RECEIPT_CUTOVER_TYPED_ROW:relationship'; END IF;
END;
$typed_receipt_guard$;

DO $archive_conflict_guard$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_temp.earlybird_receipt_expected AS expected
        JOIN public.maintenance_jobs AS actual
          ON actual.kind = expected.kind
         AND actual.target_key_hash = expected.target_key_hash
        WHERE actual.state IS DISTINCT FROM 'succeeded'
           OR actual.payload IS DISTINCT FROM expected.payload
           OR actual.content_hash IS DISTINCT FROM expected.content_hash
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_ARCHIVE_CONFLICT', ERRCODE = 'P0001';
    END IF;
END;
$archive_conflict_guard$;

INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM pg_temp.earlybird_receipt_expected
ON CONFLICT (kind, target_key_hash) DO NOTHING;

DO $archive_parity_guard$
DECLARE
    v_total BIGINT;
BEGIN
    SELECT count(*) INTO v_total
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' IN (
        'earlybird_adoption_policy_failure_rearms',
        'earlybird_concierge_snapshot_conflict_recoveries',
        'earlybird_pfe_target_evidence_start_rejection_rearms',
        'earlybird_pfe3_media_artifact_rearms',
        'earlybird_profile_fetch_exhaustion_recoveries',
        'earlybird_schema_failure_recoveries',
        'earlybird_terminal_unavailable_exhaustion_rearms',
        'earlybird_v211_apify_transient_replays',
        'earlybird_v211_concierge_replays',
        'earlybird_v211_lease_policy_failure_rearms',
        'earlybird_v211_policy_identity_replays',
        'earlybird_v211_profile_ai_diagnostic_replays',
        'earlybird_v211_relationship_lineage_failure_rearms'
    );
    IF v_total <> 21 THEN
        RAISE EXCEPTION USING
            MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_ARCHIVE_TOTAL:%s', v_total),
            ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_temp.earlybird_receipt_expected AS expected
        LEFT JOIN public.maintenance_jobs AS actual
          ON actual.kind = expected.kind
         AND actual.target_key_hash = expected.target_key_hash
        WHERE actual.id IS NULL
           OR actual.state IS DISTINCT FROM 'succeeded'
           OR actual.payload IS DISTINCT FROM expected.payload
           OR actual.content_hash IS DISTINCT FROM expected.content_hash
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_ARCHIVE_PARITY', ERRCODE = 'P0001';
    END IF;
END;
$archive_parity_guard$;

-- Source-specific archive writers are internal implementation helpers.  They
-- retain the old receipt idempotency/conflict contract while avoiding a broad
-- JSON facade or a new public table.
CREATE FUNCTION public.archive_earlybird_schema_failure_recovery(
    p_order_id UUID,
    p_failed_request_id UUID,
    p_recovery_preflight_id UUID,
    p_prior_attempt_count SMALLINT,
    p_created_at TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp()
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payload JSONB;
    v_target_key_hash TEXT;
    v_state TEXT;
    v_existing_payload JSONB;
    v_existing_content_hash TEXT;
BEGIN
    IF p_order_id IS NULL OR p_failed_request_id IS NULL
       OR p_recovery_preflight_id IS NULL OR p_prior_attempt_count IS NULL
       OR p_prior_attempt_count NOT BETWEEN 0 AND 10 OR p_created_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCHEMA_RECEIPT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_payload := pg_catalog.jsonb_build_object(
        'legacy_source_table', 'earlybird_schema_failure_recoveries',
        'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', p_order_id),
        'legacy_row', pg_catalog.jsonb_build_object(
            'order_id', p_order_id,
            'failed_request_id', p_failed_request_id,
            'recovery_preflight_id', p_recovery_preflight_id,
            'prior_attempt_count', p_prior_attempt_count,
            'created_at', p_created_at
        ),
        'schema_version', 1
    );
    v_target_key_hash := pg_catalog.encode(extensions.digest(convert_to(
        'supabase-22-legacy-earlybird-retirement-v1:recovery:earlybird_schema_failure_recoveries:'
        || (v_payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex');
    SELECT job.state, job.payload, job.content_hash
      INTO v_state, v_existing_payload, v_existing_content_hash
    FROM public.maintenance_jobs AS job
    WHERE job.kind = 'recovery'
      AND job.target_key_hash = v_target_key_hash
    FOR UPDATE;
    IF FOUND THEN
        IF v_state IS DISTINCT FROM 'succeeded'
           OR v_existing_payload IS DISTINCT FROM v_payload
           OR v_existing_content_hash IS DISTINCT FROM pg_catalog.encode(
                extensions.digest(convert_to(v_payload::TEXT, 'UTF8'), 'sha256'), 'hex'
              ) THEN
            RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCHEMA_RECEIPT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN;
    END IF;
    INSERT INTO public.maintenance_jobs(kind, target_key_hash, state, payload, content_hash)
    VALUES (
        'recovery', v_target_key_hash, 'succeeded', v_payload,
        pg_catalog.encode(extensions.digest(convert_to(v_payload::TEXT, 'UTF8'), 'sha256'), 'hex')
    );
END;
$$;

CREATE FUNCTION public.archive_earlybird_concierge_snapshot_conflict_recovery(
    p_order_id UUID,
    p_preflight_id UUID,
    p_provider_operation_key TEXT,
    p_provider_input_hash VARCHAR(64),
    p_provider_run_id_hash VARCHAR(32),
    p_expected_manual_review_at TIMESTAMPTZ,
    p_expected_admission_refreshed_at TIMESTAMPTZ,
    p_old_order_followers_count INTEGER,
    p_old_order_following_count INTEGER,
    p_old_preflight_followers_count INTEGER,
    p_old_preflight_following_count INTEGER,
    p_new_witness_followers_count INTEGER,
    p_new_witness_following_count INTEGER,
    p_old_snapshot_recorded_at TIMESTAMPTZ,
    p_new_witness_recorded_at TIMESTAMPTZ,
    p_recovery_reason TEXT,
    p_followers_absolute_delta INTEGER,
    p_following_absolute_delta INTEGER,
    p_created_at TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp()
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payload JSONB;
    v_target_key_hash TEXT;
    v_state TEXT;
    v_existing_payload JSONB;
    v_existing_content_hash TEXT;
    v_content_hash TEXT;
BEGIN
    IF p_order_id IS NULL OR p_preflight_id IS NULL
       OR p_provider_operation_key IS DISTINCT FROM 'target-profile-fresh-admission:g3'
       OR p_provider_input_hash IS NULL OR p_provider_input_hash !~ '^[a-f0-9]{64}$'
       OR p_provider_run_id_hash IS NULL OR p_provider_run_id_hash !~ '^[a-f0-9]{32}$'
       OR p_expected_manual_review_at IS NULL OR p_expected_admission_refreshed_at IS NULL
       OR p_old_order_followers_count IS DISTINCT FROM 158
       OR p_old_order_following_count IS DISTINCT FROM 361
       OR p_old_preflight_followers_count IS DISTINCT FROM 158
       OR p_old_preflight_following_count IS DISTINCT FROM 361
       OR p_new_witness_followers_count IS DISTINCT FROM 158
       OR p_new_witness_following_count IS DISTINCT FROM 362
       OR p_old_snapshot_recorded_at IS NULL OR p_new_witness_recorded_at IS NULL
       OR p_recovery_reason IS DISTINCT FROM 'bounded_time_snapshot_drift'
       OR p_followers_absolute_delta IS DISTINCT FROM 0
       OR p_following_absolute_delta IS DISTINCT FROM 1
       OR p_created_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_SNAPSHOT_RECEIPT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_payload := pg_catalog.jsonb_build_object(
        'legacy_source_table', 'earlybird_concierge_snapshot_conflict_recoveries',
        'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', p_order_id),
        'legacy_row', pg_catalog.jsonb_build_object(
            'order_id', p_order_id, 'preflight_id', p_preflight_id,
            'provider_operation_key', p_provider_operation_key,
            'provider_input_hash', p_provider_input_hash,
            'provider_run_id_hash', p_provider_run_id_hash,
            'expected_manual_review_at', p_expected_manual_review_at,
            'expected_admission_refreshed_at', p_expected_admission_refreshed_at,
            'old_order_followers_count', p_old_order_followers_count,
            'old_order_following_count', p_old_order_following_count,
            'old_preflight_followers_count', p_old_preflight_followers_count,
            'old_preflight_following_count', p_old_preflight_following_count,
            'new_witness_followers_count', p_new_witness_followers_count,
            'new_witness_following_count', p_new_witness_following_count,
            'old_snapshot_recorded_at', p_old_snapshot_recorded_at,
            'new_witness_recorded_at', p_new_witness_recorded_at,
            'recovery_reason', p_recovery_reason,
            'followers_absolute_delta', p_followers_absolute_delta,
            'following_absolute_delta', p_following_absolute_delta,
            'created_at', p_created_at
        ),
        'schema_version', 1
    );
    v_target_key_hash := pg_catalog.encode(extensions.digest(convert_to(
        'supabase-22-legacy-earlybird-retirement-v1:recovery:earlybird_concierge_snapshot_conflict_recoveries:'
        || (v_payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex');
    v_content_hash := pg_catalog.encode(
        extensions.digest(convert_to(v_payload::TEXT, 'UTF8'), 'sha256'), 'hex'
    );
    SELECT job.state, job.payload, job.content_hash
      INTO v_state, v_existing_payload, v_existing_content_hash
    FROM public.maintenance_jobs AS job
    WHERE job.kind = 'recovery'
      AND job.target_key_hash = v_target_key_hash
    FOR UPDATE;
    IF FOUND THEN
        IF v_state IS DISTINCT FROM 'succeeded'
           OR v_existing_payload IS DISTINCT FROM v_payload
           OR v_existing_content_hash IS DISTINCT FROM v_content_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_SNAPSHOT_RECEIPT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN;
    END IF;
    INSERT INTO public.maintenance_jobs(kind, target_key_hash, state, payload, content_hash)
    VALUES ('recovery', v_target_key_hash, 'succeeded', v_payload, v_content_hash);
END;
$$;

CREATE FUNCTION public.archive_earlybird_v211_concierge_replay(
    p_order_id UUID,
    p_original_failed_request_id UUID,
    p_first_relationship_failed_request_id UUID,
    p_second_relationship_failed_request_id UUID,
    p_failed_preflight_id UUID,
    p_rearmed_preflight_id UUID,
    p_expected_fulfillment_attempt_count SMALLINT,
    p_expected_manual_review_at TIMESTAMPTZ,
    p_reviewed_source_request_id UUID,
    p_reviewed_source_owner_id UUID,
    p_reviewed_source_target_instagram_id TEXT,
    p_reviewed_source_result_request_id UUID,
    p_reviewed_source_target_posts JSONB,
    p_reviewed_source_target_evidence JSONB,
    p_reviewed_source_fingerprint VARCHAR(64),
    p_reviewed_source_registered_at TIMESTAMPTZ,
    p_published_source_fingerprint VARCHAR(64),
    p_published_result_hash VARCHAR(64),
    p_published_at TIMESTAMPTZ,
    p_created_at TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp()
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_payload JSONB;
    v_target_key_hash TEXT;
    v_content_hash TEXT;
    v_state TEXT;
    v_existing_payload JSONB;
    v_existing_content_hash TEXT;
BEGIN
    IF p_order_id IS NULL OR p_original_failed_request_id IS NULL
       OR p_first_relationship_failed_request_id IS NULL
       OR p_second_relationship_failed_request_id IS NULL
       OR p_failed_preflight_id IS NULL OR p_rearmed_preflight_id IS NULL
       OR p_expected_fulfillment_attempt_count IS DISTINCT FROM 1
       OR p_expected_manual_review_at IS NULL OR p_created_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_REPLAY_RECEIPT_INVALID', ERRCODE = 'P0001';
    END IF;
    v_payload := pg_catalog.jsonb_build_object(
        'legacy_source_table', 'earlybird_v211_concierge_replays',
        'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', p_order_id),
        'legacy_row', pg_catalog.jsonb_build_object(
            'order_id', p_order_id,
            'original_failed_request_id', p_original_failed_request_id,
            'first_relationship_failed_request_id', p_first_relationship_failed_request_id,
            'second_relationship_failed_request_id', p_second_relationship_failed_request_id,
            'failed_preflight_id', p_failed_preflight_id,
            'rearmed_preflight_id', p_rearmed_preflight_id,
            'expected_fulfillment_attempt_count', p_expected_fulfillment_attempt_count,
            'expected_manual_review_at', p_expected_manual_review_at,
            'created_at', p_created_at,
            'reviewed_source_request_id', p_reviewed_source_request_id,
            'reviewed_source_owner_id', p_reviewed_source_owner_id,
            'reviewed_source_target_instagram_id', p_reviewed_source_target_instagram_id,
            'reviewed_source_result_request_id', p_reviewed_source_result_request_id,
            'reviewed_source_target_posts', p_reviewed_source_target_posts,
            'reviewed_source_target_evidence', p_reviewed_source_target_evidence,
            'reviewed_source_fingerprint', p_reviewed_source_fingerprint,
            'reviewed_source_registered_at', p_reviewed_source_registered_at,
            'published_source_fingerprint', p_published_source_fingerprint,
            'published_result_hash', p_published_result_hash,
            'published_at', p_published_at
        ),
        'schema_version', 1
    );
    v_target_key_hash := pg_catalog.encode(extensions.digest(convert_to(
        'supabase-22-legacy-earlybird-retirement-v1:replay:earlybird_v211_concierge_replays:'
        || (v_payload->'legacy_primary_key')::TEXT, 'UTF8'), 'sha256'), 'hex');
    v_content_hash := pg_catalog.encode(
        extensions.digest(convert_to(v_payload::TEXT, 'UTF8'), 'sha256'), 'hex'
    );
    SELECT job.state, job.payload, job.content_hash
      INTO v_state, v_existing_payload, v_existing_content_hash
    FROM public.maintenance_jobs AS job
    WHERE job.kind = 'replay'
      AND job.target_key_hash = v_target_key_hash
    FOR UPDATE;
    IF FOUND THEN
        IF v_state IS DISTINCT FROM 'succeeded'
           OR v_existing_payload IS DISTINCT FROM v_payload
           OR v_existing_content_hash IS DISTINCT FROM v_content_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_REPLAY_RECEIPT_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN;
    END IF;
    INSERT INTO public.maintenance_jobs(kind, target_key_hash, state, payload, content_hash)
    VALUES ('replay', v_target_key_hash, 'succeeded', v_payload, v_content_hash);
END;
$$;

REVOKE ALL ON FUNCTION public.archive_earlybird_schema_failure_recovery(
    UUID, UUID, UUID, SMALLINT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.archive_earlybird_concierge_snapshot_conflict_recovery(
    UUID, UUID, TEXT, VARCHAR, VARCHAR, TIMESTAMPTZ, TIMESTAMPTZ,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TIMESTAMPTZ,
    TIMESTAMPTZ, TEXT, INTEGER, INTEGER, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.archive_earlybird_v211_concierge_replay(
    UUID, UUID, UUID, UUID, UUID, UUID, SMALLINT, TIMESTAMPTZ,
    UUID, UUID, TEXT, UUID, JSONB, JSONB, VARCHAR, TIMESTAMPTZ,
    VARCHAR, VARCHAR, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;

-- These two source-specific mutators preserve the append-only reviewed-source
-- and publication-marker transitions that used to be trigger-authorized UPDATEs.
CREATE FUNCTION public.archive_earlybird_v211_concierge_reviewed_source(
    p_order_id UUID,
    p_source_request_id UUID,
    p_owner_id UUID,
    p_target_instagram_id TEXT,
    p_result_request_id UUID,
    p_target_posts JSONB,
    p_target_evidence JSONB,
    p_source_fingerprint TEXT,
    p_registered_at TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp()
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id UUID;
    v_payload JSONB;
    v_row JSONB;
    v_next_payload JSONB;
BEGIN
    SELECT job.id, job.payload INTO v_id, v_payload
    FROM public.maintenance_jobs AS job
    WHERE job.kind = 'replay'
      AND job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_v211_concierge_replays'
      AND job.payload->'legacy_primary_key'->>'order_id' = p_order_id::TEXT
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_REVIEWED_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    v_row := v_payload->'legacy_row';
    IF v_row->>'reviewed_source_fingerprint' IS NOT NULL THEN
        IF v_row->>'reviewed_source_fingerprint' = p_source_fingerprint
           AND v_row->>'reviewed_source_request_id' = p_source_request_id::TEXT
           AND v_row->>'reviewed_source_owner_id' = p_owner_id::TEXT
           AND v_row->>'reviewed_source_target_instagram_id' = p_target_instagram_id
           AND v_row->>'reviewed_source_result_request_id' = p_result_request_id::TEXT
           AND v_row->'reviewed_source_target_posts' IS NOT DISTINCT FROM p_target_posts
           AND v_row->'reviewed_source_target_evidence' IS NOT DISTINCT FROM p_target_evidence THEN
            RETURN FALSE;
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_REVIEWED_SOURCE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF p_source_request_id IS NULL OR p_owner_id IS NULL OR p_result_request_id IS NULL
       OR p_target_instagram_id IS NULL OR p_target_posts IS NULL OR p_target_evidence IS NULL
       OR p_source_fingerprint IS NULL OR p_registered_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_REVIEWED_SOURCE_INVALID', ERRCODE = 'P0001';
    END IF;
    v_next_payload := pg_catalog.jsonb_set(
        v_payload, '{legacy_row}',
        v_row || pg_catalog.jsonb_build_object(
            'reviewed_source_request_id', p_source_request_id,
            'reviewed_source_owner_id', p_owner_id,
            'reviewed_source_target_instagram_id', p_target_instagram_id,
            'reviewed_source_result_request_id', p_result_request_id,
            'reviewed_source_target_posts', p_target_posts,
            'reviewed_source_target_evidence', p_target_evidence,
            'reviewed_source_fingerprint', p_source_fingerprint,
            'reviewed_source_registered_at', p_registered_at
        )
    );
    UPDATE public.maintenance_jobs
    SET payload = v_next_payload,
        content_hash = pg_catalog.encode(
            extensions.digest(convert_to(v_next_payload::TEXT, 'UTF8'), 'sha256'), 'hex'
        ),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_id;
    RETURN TRUE;
END;
$$;

CREATE FUNCTION public.mark_earlybird_v211_concierge_publication_source(
    p_order_id UUID,
    p_source_fingerprint TEXT,
    p_result_hash TEXT,
    p_published_at TIMESTAMPTZ DEFAULT pg_catalog.clock_timestamp()
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id UUID;
    v_payload JSONB;
    v_row JSONB;
    v_next_payload JSONB;
BEGIN
    SELECT job.id, job.payload INTO v_id, v_payload
    FROM public.maintenance_jobs AS job
    WHERE job.kind = 'replay'
      AND job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_v211_concierge_replays'
      AND job.payload->'legacy_primary_key'->>'order_id' = p_order_id::TEXT
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_SOURCE_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    v_row := v_payload->'legacy_row';
    IF v_row->>'published_source_fingerprint' IS NOT NULL
       OR v_row->>'published_result_hash' IS NOT NULL
       OR v_row->>'published_at' IS NOT NULL THEN
        IF v_row->>'published_source_fingerprint' = p_source_fingerprint
           AND v_row->>'published_result_hash' = p_result_hash THEN
            RETURN FALSE;
        END IF;
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_SOURCE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_row->>'reviewed_source_fingerprint' IS DISTINCT FROM p_source_fingerprint
       OR p_source_fingerprint IS NULL OR p_source_fingerprint !~ '^[a-f0-9]{64}$'
       OR p_result_hash IS NULL OR p_result_hash !~ '^[a-f0-9]{64}$'
       OR p_published_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_SOURCE_INVALID', ERRCODE = 'P0001';
    END IF;
    v_next_payload := pg_catalog.jsonb_set(
        v_payload, '{legacy_row}',
        v_row || pg_catalog.jsonb_build_object(
            'published_source_fingerprint', p_source_fingerprint,
            'published_result_hash', p_result_hash,
            'published_at', p_published_at
        )
    );
    UPDATE public.maintenance_jobs
    SET payload = v_next_payload,
        content_hash = pg_catalog.encode(
            extensions.digest(convert_to(v_next_payload::TEXT, 'UTF8'), 'sha256'), 'hex'
        ),
        updated_at = pg_catalog.clock_timestamp()
    WHERE id = v_id;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.archive_earlybird_v211_concierge_reviewed_source(
    UUID, UUID, UUID, TEXT, UUID, JSONB, JSONB, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.mark_earlybird_v211_concierge_publication_source(
    UUID, TEXT, TEXT, TIMESTAMPTZ
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.assert_earlybird_receipt_archive_purge_safe()
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- A missing key is not equivalent to a NULL value for retention.  The
    -- explicit source branches below fail closed before purge evaluates its
    -- typed archive projections; invalid scalar casts fail in those branches.
    IF EXISTS (
        SELECT 1
        FROM public.maintenance_jobs AS job
        WHERE job.payload->>'legacy_source_table' IN (
            'earlybird_adoption_policy_failure_rearms',
            'earlybird_concierge_snapshot_conflict_recoveries',
            'earlybird_pfe_target_evidence_start_rejection_rearms',
            'earlybird_pfe3_media_artifact_rearms',
            'earlybird_profile_fetch_exhaustion_recoveries',
            'earlybird_schema_failure_recoveries',
            'earlybird_terminal_unavailable_exhaustion_rearms',
            'earlybird_v211_apify_transient_replays',
            'earlybird_v211_concierge_replays',
            'earlybird_v211_lease_policy_failure_rearms',
            'earlybird_v211_policy_identity_replays',
            'earlybird_v211_profile_ai_diagnostic_replays',
            'earlybird_v211_relationship_lineage_failure_rearms'
        )
        AND (
            job.state IS DISTINCT FROM 'succeeded'
            OR job.legacy_pending_user_id IS NOT NULL
            OR job.kind IS DISTINCT FROM CASE job.payload->>'legacy_source_table'
                WHEN 'earlybird_adoption_policy_failure_rearms' THEN 'rearm'
                WHEN 'earlybird_concierge_snapshot_conflict_recoveries' THEN 'recovery'
                WHEN 'earlybird_pfe_target_evidence_start_rejection_rearms' THEN 'rearm'
                WHEN 'earlybird_pfe3_media_artifact_rearms' THEN 'rearm'
                WHEN 'earlybird_profile_fetch_exhaustion_recoveries' THEN 'recovery'
                WHEN 'earlybird_schema_failure_recoveries' THEN 'recovery'
                WHEN 'earlybird_terminal_unavailable_exhaustion_rearms' THEN 'rearm'
                WHEN 'earlybird_v211_apify_transient_replays' THEN 'replay'
                WHEN 'earlybird_v211_concierge_replays' THEN 'replay'
                WHEN 'earlybird_v211_lease_policy_failure_rearms' THEN 'rearm'
                WHEN 'earlybird_v211_policy_identity_replays' THEN 'replay'
                WHEN 'earlybird_v211_profile_ai_diagnostic_replays' THEN 'replay'
                WHEN 'earlybird_v211_relationship_lineage_failure_rearms' THEN 'rearm'
            END
            OR pg_catalog.jsonb_typeof(job.payload) IS DISTINCT FROM 'object'
            OR pg_catalog.jsonb_typeof(job.payload->'legacy_primary_key') IS DISTINCT FROM 'object'
            OR pg_catalog.jsonb_typeof(job.payload->'legacy_row') IS DISTINCT FROM 'object'
            OR job.payload->>'schema_version' IS DISTINCT FROM '1'
            OR NOT (job.payload->'legacy_primary_key' ?& ARRAY['order_id'])
            OR job.payload->'legacy_primary_key'->>'order_id' IS NULL
            OR (job.payload->>'legacy_source_table' = 'earlybird_adoption_policy_failure_rearms'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','original_failed_request_id','policy_failed_request_id','rearmed_preflight_id','expected_fulfillment_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'original_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'policy_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'expected_fulfillment_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_concierge_snapshot_conflict_recoveries'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','preflight_id','provider_operation_key','provider_input_hash','provider_run_id_hash','expected_manual_review_at','expected_admission_refreshed_at','old_order_followers_count','old_order_following_count','old_preflight_followers_count','old_preflight_following_count','new_witness_followers_count','new_witness_following_count','old_snapshot_recorded_at','new_witness_recorded_at','recovery_reason','followers_absolute_delta','following_absolute_delta','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'provider_operation_key' IS NULL
                     OR job.payload->'legacy_row'->>'provider_input_hash' IS NULL
                     OR job.payload->'legacy_row'->>'provider_run_id_hash' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'expected_admission_refreshed_at' IS NULL
                     OR job.payload->'legacy_row'->>'old_order_followers_count' IS NULL
                     OR job.payload->'legacy_row'->>'old_order_following_count' IS NULL
                     OR job.payload->'legacy_row'->>'old_preflight_followers_count' IS NULL
                     OR job.payload->'legacy_row'->>'old_preflight_following_count' IS NULL
                     OR job.payload->'legacy_row'->>'new_witness_followers_count' IS NULL
                     OR job.payload->'legacy_row'->>'new_witness_following_count' IS NULL
                     OR job.payload->'legacy_row'->>'old_snapshot_recorded_at' IS NULL
                     OR job.payload->'legacy_row'->>'new_witness_recorded_at' IS NULL
                     OR job.payload->'legacy_row'->>'recovery_reason' IS NULL
                     OR job.payload->'legacy_row'->>'followers_absolute_delta' IS NULL
                     OR job.payload->'legacy_row'->>'following_absolute_delta' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_pfe_target_evidence_start_rejection_rearms'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','pfe_original_failed_request_id','rejected_successor_request_id','rearmed_preflight_id','prior_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'pfe_original_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'rejected_successor_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'prior_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_pfe3_media_artifact_rearms'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','pfe_original_failed_request_id','pfe2_rejected_successor_request_id','media_failed_request_id','rearmed_preflight_id','prior_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'pfe_original_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'pfe2_rejected_successor_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'media_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'prior_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_profile_fetch_exhaustion_recoveries'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','failed_request_id','recovery_preflight_id','prior_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'recovery_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'prior_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_schema_failure_recoveries'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','failed_request_id','recovery_preflight_id','prior_attempt_count','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'recovery_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'prior_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_terminal_unavailable_exhaustion_rearms'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','failed_request_id','rearmed_preflight_id','expected_fulfillment_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'expected_fulfillment_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_v211_apify_transient_replays'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','original_failed_request_id','policy_identity_failed_request_id','transient_failed_request_id','failed_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'original_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'policy_identity_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'transient_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'failed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'expected_fulfillment_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_v211_concierge_replays'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','original_failed_request_id','first_relationship_failed_request_id','second_relationship_failed_request_id','failed_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count','expected_manual_review_at','created_at','reviewed_source_request_id','reviewed_source_owner_id','reviewed_source_target_instagram_id','reviewed_source_result_request_id','reviewed_source_target_posts','reviewed_source_target_evidence','reviewed_source_fingerprint','reviewed_source_registered_at','published_source_fingerprint','published_result_hash','published_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'original_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'first_relationship_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'second_relationship_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'failed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'expected_fulfillment_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_v211_lease_policy_failure_rearms'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','failed_request_id','source_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'source_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'expected_fulfillment_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_v211_policy_identity_replays'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','original_failed_request_id','policy_identity_failed_request_id','failed_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'original_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'policy_identity_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'failed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'expected_fulfillment_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_v211_profile_ai_diagnostic_replays'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','original_failed_request_id','profile_ai_failed_request_id','failed_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'original_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'profile_ai_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'failed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'expected_fulfillment_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
            OR (job.payload->>'legacy_source_table' = 'earlybird_v211_relationship_lineage_failure_rearms'
                AND (NOT (job.payload->'legacy_row' ?& ARRAY['order_id','original_failed_request_id','relationship_failed_request_id','source_preflight_id','rearmed_preflight_id','expected_fulfillment_attempt_count','expected_manual_review_at','created_at'])
                     OR job.payload->'legacy_row'->>'order_id' IS NULL
                     OR job.payload->'legacy_row'->>'original_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'relationship_failed_request_id' IS NULL
                     OR job.payload->'legacy_row'->>'source_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'rearmed_preflight_id' IS NULL
                     OR job.payload->'legacy_row'->>'expected_fulfillment_attempt_count' IS NULL
                     OR job.payload->'legacy_row'->>'expected_manual_review_at' IS NULL
                     OR job.payload->'legacy_row'->>'created_at' IS NULL))
        ) THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_RECEIPT_PURGE_ARCHIVE_INVALID', ERRCODE = 'P0001';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.assert_earlybird_receipt_archive_purge_safe()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TEMP TABLE pg_temp.earlybird_receipt_projection (
    source_table TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    field_sql TEXT NOT NULL,
    key_sql TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO pg_temp.earlybird_receipt_projection(source_table, kind, field_sql, key_sql)
VALUES
('earlybird_adoption_policy_failure_rearms', 'rearm',
 'order_id UUID, original_failed_request_id UUID, policy_failed_request_id UUID, rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''original_failed_request_id'',''policy_failed_request_id'',''rearmed_preflight_id'',''expected_fulfillment_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_concierge_snapshot_conflict_recoveries', 'recovery',
 'order_id UUID, preflight_id UUID, provider_operation_key TEXT, provider_input_hash VARCHAR(64), provider_run_id_hash VARCHAR(32), expected_manual_review_at TIMESTAMPTZ, expected_admission_refreshed_at TIMESTAMPTZ, old_order_followers_count INTEGER, old_order_following_count INTEGER, old_preflight_followers_count INTEGER, old_preflight_following_count INTEGER, new_witness_followers_count INTEGER, new_witness_following_count INTEGER, old_snapshot_recorded_at TIMESTAMPTZ, new_witness_recorded_at TIMESTAMPTZ, recovery_reason TEXT, followers_absolute_delta INTEGER, following_absolute_delta INTEGER, created_at TIMESTAMPTZ',
 '''order_id'',''preflight_id'',''provider_operation_key'',''provider_input_hash'',''provider_run_id_hash'',''expected_manual_review_at'',''expected_admission_refreshed_at'',''old_order_followers_count'',''old_order_following_count'',''old_preflight_followers_count'',''old_preflight_following_count'',''new_witness_followers_count'',''new_witness_following_count'',''old_snapshot_recorded_at'',''new_witness_recorded_at'',''recovery_reason'',''followers_absolute_delta'',''following_absolute_delta'',''created_at'''),
('earlybird_pfe_target_evidence_start_rejection_rearms', 'rearm',
 'order_id UUID, pfe_original_failed_request_id UUID, rejected_successor_request_id UUID, rearmed_preflight_id UUID, prior_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''pfe_original_failed_request_id'',''rejected_successor_request_id'',''rearmed_preflight_id'',''prior_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_pfe3_media_artifact_rearms', 'rearm',
 'order_id UUID, pfe_original_failed_request_id UUID, pfe2_rejected_successor_request_id UUID, media_failed_request_id UUID, rearmed_preflight_id UUID, prior_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''pfe_original_failed_request_id'',''pfe2_rejected_successor_request_id'',''media_failed_request_id'',''rearmed_preflight_id'',''prior_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_profile_fetch_exhaustion_recoveries', 'recovery',
 'order_id UUID, failed_request_id UUID, recovery_preflight_id UUID, prior_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''failed_request_id'',''recovery_preflight_id'',''prior_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_schema_failure_recoveries', 'recovery',
 'order_id UUID, failed_request_id UUID, recovery_preflight_id UUID, prior_attempt_count SMALLINT, created_at TIMESTAMPTZ',
 '''order_id'',''failed_request_id'',''recovery_preflight_id'',''prior_attempt_count'',''created_at'''),
('earlybird_terminal_unavailable_exhaustion_rearms', 'rearm',
 'order_id UUID, failed_request_id UUID, rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''failed_request_id'',''rearmed_preflight_id'',''expected_fulfillment_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_v211_apify_transient_replays', 'replay',
 'order_id UUID, original_failed_request_id UUID, policy_identity_failed_request_id UUID, transient_failed_request_id UUID, failed_preflight_id UUID, rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''original_failed_request_id'',''policy_identity_failed_request_id'',''transient_failed_request_id'',''failed_preflight_id'',''rearmed_preflight_id'',''expected_fulfillment_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_v211_concierge_replays', 'replay',
 'order_id UUID, original_failed_request_id UUID, first_relationship_failed_request_id UUID, second_relationship_failed_request_id UUID, failed_preflight_id UUID, rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ, reviewed_source_request_id UUID, reviewed_source_owner_id UUID, reviewed_source_target_instagram_id TEXT, reviewed_source_result_request_id UUID, reviewed_source_target_posts JSONB, reviewed_source_target_evidence JSONB, reviewed_source_fingerprint VARCHAR(64), reviewed_source_registered_at TIMESTAMPTZ, published_source_fingerprint VARCHAR(64), published_result_hash VARCHAR(64), published_at TIMESTAMPTZ',
 '''order_id'',''original_failed_request_id'',''first_relationship_failed_request_id'',''second_relationship_failed_request_id'',''failed_preflight_id'',''rearmed_preflight_id'',''expected_fulfillment_attempt_count'',''expected_manual_review_at'',''created_at'',''reviewed_source_request_id'',''reviewed_source_owner_id'',''reviewed_source_target_instagram_id'',''reviewed_source_result_request_id'',''reviewed_source_target_posts'',''reviewed_source_target_evidence'',''reviewed_source_fingerprint'',''reviewed_source_registered_at'',''published_source_fingerprint'',''published_result_hash'',''published_at'''),
('earlybird_v211_lease_policy_failure_rearms', 'rearm',
 'order_id UUID, failed_request_id UUID, source_preflight_id UUID, rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''failed_request_id'',''source_preflight_id'',''rearmed_preflight_id'',''expected_fulfillment_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_v211_policy_identity_replays', 'replay',
 'order_id UUID, original_failed_request_id UUID, policy_identity_failed_request_id UUID, failed_preflight_id UUID, rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''original_failed_request_id'',''policy_identity_failed_request_id'',''failed_preflight_id'',''rearmed_preflight_id'',''expected_fulfillment_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_v211_profile_ai_diagnostic_replays', 'replay',
 'order_id UUID, original_failed_request_id UUID, profile_ai_failed_request_id UUID, failed_preflight_id UUID, rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''original_failed_request_id'',''profile_ai_failed_request_id'',''failed_preflight_id'',''rearmed_preflight_id'',''expected_fulfillment_attempt_count'',''expected_manual_review_at'',''created_at'''),
('earlybird_v211_relationship_lineage_failure_rearms', 'rearm',
 'order_id UUID, original_failed_request_id UUID, relationship_failed_request_id UUID, source_preflight_id UUID, rearmed_preflight_id UUID, expected_fulfillment_attempt_count SMALLINT, expected_manual_review_at TIMESTAMPTZ, created_at TIMESTAMPTZ',
 '''order_id'',''original_failed_request_id'',''relationship_failed_request_id'',''source_preflight_id'',''rearmed_preflight_id'',''expected_fulfillment_attempt_count'',''expected_manual_review_at'',''created_at''');

CREATE TEMP TABLE pg_temp.earlybird_receipt_routines (
    signature TEXT PRIMARY KEY,
    expected_hash TEXT NOT NULL
) ON COMMIT DROP;

INSERT INTO pg_temp.earlybird_receipt_routines(signature, expected_hash)
VALUES
('public.bootstrap_earlybird_v211_concierge_first_order(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,smallint,integer,integer,integer,integer,integer,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)', 'fac43c71391687d55a40173d73f8da3999163a9658ba569e03961d79173ef2a7'),
('public.bridge_earlybird_v211_lease_rearm_admission(uuid,uuid,timestamptz)', 'd90e5dc6b41c59314ff1e96543b5bbb10be8495f3cdfa4884c056a2b64142282'),
('public.complete_analysis_v2_preflight_admission(uuid,integer,uuid,text,integer,integer,boolean)', 'f24498cba68e5e2a4430246b6b17ce844ee176c6a59cd33a1c53a93f936cd9b0'),
('public.complete_earlybird_concierge_snapshot_recovery(uuid,uuid,uuid)', '44843b53e8dfadc145110b510c4976c17220ac9c683617ecf9ea91c103dbdf47'),
('public.create_or_replay_earlybird_fulfillment_request(uuid,uuid,bigint)', 'b12202770d65bf6f7cdd86878e8cfe1cd358b075efe2ea94b60571564ddee354'),
('public.earlybird_concierge_snapshot_conflict_receipt_authorized(uuid,uuid,integer,integer,integer,integer,integer,integer,integer,timestamptz)', '2dcbb2ee5542dc5de232b7ecb0cfe7ee9648c5f387005dd0dfc909907f6d47f6'),
('public.earlybird_pfe3_media_artifact_adoption_ready(uuid,uuid,uuid)', '04a58c78588ade48a2b8e9c47ff3f7db4f71bc87c6add6a63374611d0071aba5'),
('public.earlybird_pfe_evidence_rejection_adoption_ready(uuid,uuid,uuid)', 'eaef95cd5092c99cf1f6abd34ceb9d3b26ec1d3a68ac9464fee813e9c0a8c570'),
('public.earlybird_profile_fetch_exhaustion_provider_run_adoption_ready(uuid,uuid,uuid)', '1417310bc5a8e4d807b050e6bf9040824009f8bb225aa2712083d3fbacefe089'),
('public.earlybird_provider_run_adoption_ready_pre_first15(uuid,uuid,uuid)', 'd163753c26cf9620190f5ef877f0dbaff7c27075a4219e4596081122eac8b69b'),
('public.earlybird_v211_apify_transient_failure_ready(uuid,uuid,uuid,uuid)', '18a4607086fd1b21a04be1ac9dbef5a48347b627d5f5f5a9edd19cc1c404b615'),
('public.earlybird_v211_apify_transient_replay_ready(uuid,uuid,uuid,uuid)', '1cb4f81915c83add0d56e4472e28e107cb548c86c5da3b86c2e275b290876a64'),
('public.earlybird_v211_concierge_replay_ready(uuid,uuid,uuid,uuid)', '0103ff31925757d7c857458200d29056fcb139b9264e7f180a3bb6f1d45f5612'),
('public.earlybird_v211_policy_identity_replay_ready(uuid,uuid,uuid,uuid)', '3b7d389fbb408adcd2d1e1519d806c45b385d2820a75a936b712ae75fb48e80b'),
('public.earlybird_v211_profile_ai_diagnostic_replay_ready(uuid,uuid,uuid,uuid)', '4c2062bf87414c31b0de026c4f09856e07f2bd2bc08c1d66149154e76fcf04f3'),
('public.earlybird_v211_relationship_lineage_rearm_ready(uuid,uuid,uuid,uuid)', 'fb8033ad38e96f59d40b46e9f15ba9238c7c8b9149d64add70ce44d10546e31a'),
('public.inspect_earlybird_concierge_snapshot_conflict_precheck(uuid,uuid,timestamptz,timestamptz,uuid)', '01243a5c7ccad1019615553c1dcbc43cd4e4d32997eeec94645ca88847ee2793'),
('public.inspect_earlybird_concierge_snapshot_recovery_execution(uuid,uuid,timestamptz,timestamptz)', '64b9f6bec654b6b76f83e7e1834d12b11f2c9506a401316069d7793d9111a985'),
('public.list_analysis_v2_dispatchable_jobs(integer)', '7dc744ef441b7534858612a253b5538b57cb25368e7e3fe2d960c6036b34749b'),
('public.mark_earlybird_concierge_snapshot_recovery_job_local(uuid,uuid,text,integer,uuid)', 'c463840c2d0bf3eadca5b4f6b8a67df3f0d79a4f28cf577aaf4cedeb318c1510'),
('public.publish_earlybird_v211_first_payment_concierge(text,text,jsonb)', '2df7fa3bcad5708a7c8b94b806ceae46a1f5c6747ebc08386b4c8087579b336c'),
('public.purge_expired_analysis_v2_preflights(integer)', '45320226a93489fa22059bae1887be3b1a95789b52c420aec8633854046b1aa1'),
('public.read_earlybird_v211_concierge_recovery_source_v1()', '0c6a07c0615bc945ede3eb79ecabd9e7a9db8a013e7dbc86c347648d9315f656'),
('public.read_earlybird_v211_concierge_result_source(uuid)', '818e4229b284e6679ced229b8acef076a4754cf4cd2933b4d8455da5953e5833'),
('public.rearm_earlybird_concierge_snapshot_conflict_execution(uuid,uuid,uuid,timestamptz,timestamptz)', '404f21ffec20dc6d0bf3f390f01d6f6b7db1b2daacf79361b2d4a52538c53298'),
('public.recover_earlybird_concierge_snapshot_conflict(uuid,uuid,timestamptz,timestamptz,text)', '5675a312726c57927eb3218cfe02a535f8c461431f8f3de845a4920f2b69ce8a'),
('public.recover_earlybird_schema_failed_fulfillment(uuid)', '1614a8dc57d89cff78d1ba7126f77cb36abaaeb82d1efee0749f363b956fdf33'),
('public.register_earlybird_v211_concierge_reviewed_source(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb)', '94bbe3efa29045673fc17a77019b0da5c2420dbded1b9efa84128aeba33b7be7'),
('public.request_analysis_v2_provider_run_cleanup(uuid,text,uuid,text,text)', 'c5fae2a70eed4526ea636bfa636c8a7ea0f4d42f1b0eeb8dffb565ecb676f638'),
('public.resolve_analysis_v2_exact_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)', '1d0f0df2b758b000100a4a5ddfe24118fa7954eee16613fdd6815fedeac4d5c7'),
('public.resolve_analysis_v2_recovery_provider_run_pre_first15(uuid,text,uuid,text,text,text,text,text,numeric)', '56605dae2c1e4854c45e3151379e8d26515067b6019da102dac65abeb49418c2'),
('public.resolve_analysis_v2_recovery_provider_run_pre_pfe2(uuid,text,uuid,text,text,text,text,text,numeric)', 'df3245f68a1b2ab15972e6e8030933887ebd91b4b1a2058a507cd0439e34bf36'),
('public.resolve_analysis_v2_recovery_provider_run_pre_pfe3(uuid,text,uuid,text,text,text,text,text,numeric)', '8de871afe0d4dc084a9214bd68857efd9bcd89f6ce01d8a9afb01118ade2c02a'),
('public.resolve_analysis_v2_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)', '2696f0f75d9ff269b4557f9c7bb528f206bddbc38317c7ca5c93f8bfb0727dab'),
('public.restore_earlybird_concierge_snapshot_conflict_cancelled_branche(uuid,uuid,uuid,timestamptz,timestamptz)', 'cf9c9e69ef9e599c251d7fac8e058425970d1f96adce860aa8e0063a9f166b51'),
('public.resume_earlybird_v211_policy_identity_admission(uuid,timestamptz)', '88c31f487d38f05037a062ff67e5d2c78c4946eaa8e6622b4613d157b762e6a6');

DO $routine_rewrite$
DECLARE
    v_routine RECORD;
    v_projection RECORD;
    v_definition TEXT;
    v_rewritten TEXT;
    v_from_prefix TEXT;
    v_join_prefix TEXT;
    v_unaliased_prefix TEXT;
    v_purge_guards TEXT;
    v_before_count INTEGER;
    v_after_count INTEGER;
BEGIN
    FOR v_routine IN
        SELECT signature, expected_hash,
               pg_catalog.to_regprocedure(signature)::OID AS routine_oid
        FROM pg_temp.earlybird_receipt_routines
        ORDER BY signature
    LOOP
        IF v_routine.routine_oid IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_ROUTINE_MISSING:%s', v_routine.signature),
                ERRCODE = 'P0001';
        END IF;
        v_definition := pg_catalog.pg_get_functiondef(v_routine.routine_oid);
        IF pg_catalog.encode(
            extensions.digest(convert_to(v_definition, 'UTF8'), 'sha256'), 'hex'
        ) IS DISTINCT FROM v_routine.expected_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_ROUTINE_FINGERPRINT:%s', v_routine.signature),
                ERRCODE = 'P0001';
        END IF;
        v_rewritten := v_definition;

        FOR v_projection IN
            SELECT source_table, kind, field_sql, key_sql
            FROM pg_temp.earlybird_receipt_projection
            ORDER BY source_table
        LOOP
            v_before_count := pg_catalog.regexp_count(
                v_rewritten,
                E'(FROM|JOIN)[[:space:]]+public\\.'
                    || v_projection.source_table
                    || E'([[:space:]]+AS[[:space:]]+[a-z_][a-z0-9_]*)?',
                1, 'i'
            );

            v_rewritten := pg_catalog.replace(
                v_rewritten,
                'public.' || v_projection.source_table || '%ROWTYPE',
                'RECORD'
            );

            v_from_prefix := pg_catalog.format($from_projection$
FROM public.maintenance_jobs AS archive_source
CROSS JOIN LATERAL (
    SELECT decoded.*
    FROM pg_catalog.jsonb_to_record(archive_source.payload->'legacy_row')
        AS decoded(%s)
    WHERE archive_source.state = 'succeeded'
      AND archive_source.kind = %L
      AND archive_source.payload->>'legacy_source_table' = %L
      AND pg_catalog.jsonb_typeof(archive_source.payload->'legacy_row') = 'object'
      AND archive_source.payload->'legacy_row' ?& ARRAY[%s]::TEXT[]
) AS$from_projection$,
                v_projection.field_sql, v_projection.kind,
                v_projection.source_table, v_projection.key_sql
            );
            v_join_prefix := pg_catalog.format($join_projection$
JOIN LATERAL (
    SELECT decoded.*
    FROM public.maintenance_jobs AS archive_source
    CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
        archive_source.payload->'legacy_row'
    ) AS decoded(%s)
    WHERE archive_source.state = 'succeeded'
      AND archive_source.kind = %L
      AND archive_source.payload->>'legacy_source_table' = %L
      AND pg_catalog.jsonb_typeof(archive_source.payload->'legacy_row') = 'object'
      AND archive_source.payload->'legacy_row' ?& ARRAY[%s]::TEXT[]
) AS$join_projection$,
                v_projection.field_sql, v_projection.kind,
                v_projection.source_table, v_projection.key_sql
            );
            v_unaliased_prefix := pg_catalog.format($unaliased_projection$
FROM LATERAL (
    SELECT decoded.*
    FROM public.maintenance_jobs AS archive_source
    CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
        archive_source.payload->'legacy_row'
    ) AS decoded(%s)
    WHERE archive_source.state = 'succeeded'
      AND archive_source.kind = %L
      AND archive_source.payload->>'legacy_source_table' = %L
      AND pg_catalog.jsonb_typeof(archive_source.payload->'legacy_row') = 'object'
      AND archive_source.payload->'legacy_row' ?& ARRAY[%s]::TEXT[]
) AS legacy_receipt_row$unaliased_projection$,
                v_projection.field_sql, v_projection.kind,
                v_projection.source_table, v_projection.key_sql
            );

            -- Keep the source alias used by the reviewed body.  The archive
            -- base table stays visible to an outer FOR UPDATE, preserving the
            -- existing row-lock behavior for the FROM form.
            v_rewritten := pg_catalog.regexp_replace(
                v_rewritten,
                E'FROM[[:space:]]+public\\.' || v_projection.source_table
                    || E'[[:space:]]+AS[[:space:]]+([a-z_][a-z0-9_]*)',
                v_from_prefix || E' \\1', 'gi'
            );
            v_rewritten := pg_catalog.regexp_replace(
                v_rewritten,
                E'JOIN[[:space:]]+public\\.' || v_projection.source_table
                    || E'[[:space:]]+AS[[:space:]]+([a-z_][a-z0-9_]*)',
                v_join_prefix || E' \\1', 'gi'
            );
            v_rewritten := pg_catalog.replace(
                v_rewritten,
                'FROM public.' || v_projection.source_table,
                v_unaliased_prefix
            );
        END LOOP;

        -- Active state-machine writers use source-specific helpers.  The
        -- source table names are deliberately not replaced in the one-shot
        -- candidate writers below because those routines are retired in the
        -- same transaction after a no-caller guard.
        IF v_routine.signature IN (
            'public.recover_earlybird_schema_failed_fulfillment(uuid)',
            'public.bridge_earlybird_v211_lease_rearm_admission(uuid,uuid,timestamptz)'
        ) THEN
            v_rewritten := pg_catalog.regexp_replace(
                v_rewritten,
                E'INSERT INTO public\\.earlybird_schema_failure_recoveries[[:space:]]*\\([[:space:]]*order_id[[:space:]]*,[[:space:]]*failed_request_id[[:space:]]*,[[:space:]]*recovery_preflight_id[[:space:]]*,[[:space:]]*prior_attempt_count[[:space:]]*\\)[[:space:]]*VALUES[[:space:]]*\\(',
                'PERFORM public.archive_earlybird_schema_failure_recovery(', 'gi'
            );
        END IF;
        IF v_routine.signature IN (
            'public.recover_earlybird_concierge_snapshot_conflict(uuid,uuid,timestamptz,timestamptz,text)'
        ) THEN
            v_rewritten := pg_catalog.regexp_replace(
                v_rewritten,
                E'INSERT INTO public\\.earlybird_concierge_snapshot_conflict_recoveries[[:space:]]*\\([[:space:]]*order_id[[:space:]]*,[[:space:]]*preflight_id[[:space:]]*,[[:space:]]*provider_operation_key[[:space:]]*,[[:space:]]*provider_input_hash[[:space:]]*,[[:space:]]*provider_run_id_hash[[:space:]]*,[[:space:]]*expected_manual_review_at[[:space:]]*,[[:space:]]*expected_admission_refreshed_at[[:space:]]*,[[:space:]]*old_order_followers_count[[:space:]]*,[[:space:]]*old_order_following_count[[:space:]]*,[[:space:]]*old_preflight_followers_count[[:space:]]*,[[:space:]]*old_preflight_following_count[[:space:]]*,[[:space:]]*new_witness_followers_count[[:space:]]*,[[:space:]]*new_witness_following_count[[:space:]]*,[[:space:]]*old_snapshot_recorded_at[[:space:]]*,[[:space:]]*new_witness_recorded_at[[:space:]]*,[[:space:]]*recovery_reason[[:space:]]*,[[:space:]]*followers_absolute_delta[[:space:]]*,[[:space:]]*following_absolute_delta[[:space:]]*\\)[[:space:]]*VALUES[[:space:]]*\\(',
                'PERFORM public.archive_earlybird_concierge_snapshot_conflict_recovery(', 'gi'
            );
        END IF;
        IF v_routine.signature =
            'public.bootstrap_earlybird_v211_concierge_first_order(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,smallint,integer,integer,integer,integer,integer,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)'
        THEN
            v_rewritten := pg_catalog.regexp_replace(
                v_rewritten,
                E'INSERT INTO public\\.earlybird_v211_concierge_replays[[:space:]]*\\([[:space:]]*order_id[[:space:]]*,[[:space:]]*original_failed_request_id[[:space:]]*,[[:space:]]*first_relationship_failed_request_id[[:space:]]*,[[:space:]]*second_relationship_failed_request_id[[:space:]]*,[[:space:]]*failed_preflight_id[[:space:]]*,[[:space:]]*rearmed_preflight_id[[:space:]]*,[[:space:]]*expected_fulfillment_attempt_count[[:space:]]*,[[:space:]]*expected_manual_review_at[[:space:]]*,[[:space:]]*reviewed_source_request_id[[:space:]]*,[[:space:]]*reviewed_source_owner_id[[:space:]]*,[[:space:]]*reviewed_source_target_instagram_id[[:space:]]*,[[:space:]]*reviewed_source_result_request_id[[:space:]]*,[[:space:]]*reviewed_source_target_posts[[:space:]]*,[[:space:]]*reviewed_source_target_evidence[[:space:]]*,[[:space:]]*reviewed_source_fingerprint[[:space:]]*,[[:space:]]*reviewed_source_registered_at[[:space:]]*,[[:space:]]*published_source_fingerprint[[:space:]]*,[[:space:]]*published_result_hash[[:space:]]*,[[:space:]]*published_at[[:space:]]*\\)[[:space:]]*VALUES[[:space:]]*\\(',
                'PERFORM public.archive_earlybird_v211_concierge_replay(', 'gi'
            );
        END IF;
        IF v_routine.signature =
            'public.register_earlybird_v211_concierge_reviewed_source(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb)'
        THEN
            v_rewritten := pg_catalog.regexp_replace(
                v_rewritten,
                E'UPDATE public\\.earlybird_v211_concierge_replays[[:space:]]+SET[[:space:][:print:]]+WHERE[[:space:]]+order_id[[:space:]]*=[[:space:]]*p_order_id;',
                'PERFORM public.archive_earlybird_v211_concierge_reviewed_source(p_order_id, p_source_request_id, p_owner_id, v_target, p_result_request_id, p_target_posts, p_target_evidence, p_source_fingerprint, pg_catalog.clock_timestamp());',
                'gi'
            );
        END IF;
        IF v_routine.signature = 'public.purge_expired_analysis_v2_preflights(integer)' THEN
            v_rewritten := pg_catalog.regexp_replace(
                v_rewritten,
                E'\\nBEGIN\\n',
                E'\\nBEGIN\\n    PERFORM public.assert_earlybird_receipt_archive_purge_safe();\\n'
            );
            v_purge_guards := $purge_archive_guards$
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'rearm'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_adoption_policy_failure_rearms'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(rearmed_preflight_id UUID)
              WHERE archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'recovery'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_concierge_snapshot_conflict_recoveries'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(preflight_id UUID)
              WHERE archive_row.preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'rearm'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_pfe_target_evidence_start_rejection_rearms'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(rearmed_preflight_id UUID)
              WHERE archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'rearm'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_pfe3_media_artifact_rearms'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(rearmed_preflight_id UUID)
              WHERE archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'recovery'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_profile_fetch_exhaustion_recoveries'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(recovery_preflight_id UUID)
              WHERE archive_row.recovery_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'recovery'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_schema_failure_recoveries'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(recovery_preflight_id UUID)
              WHERE archive_row.recovery_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'rearm'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_terminal_unavailable_exhaustion_rearms'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(rearmed_preflight_id UUID)
              WHERE archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'replay'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_v211_apify_transient_replays'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(
                  failed_preflight_id UUID, rearmed_preflight_id UUID
              )
              WHERE archive_row.failed_preflight_id = preflight.id
                 OR archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'replay'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_v211_concierge_replays'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(
                  failed_preflight_id UUID, rearmed_preflight_id UUID
              )
              WHERE archive_row.failed_preflight_id = preflight.id
                 OR archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'rearm'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_v211_lease_policy_failure_rearms'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(
                  source_preflight_id UUID, rearmed_preflight_id UUID
              )
              WHERE archive_row.source_preflight_id = preflight.id
                 OR archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'replay'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_v211_policy_identity_replays'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(
                  failed_preflight_id UUID, rearmed_preflight_id UUID
              )
              WHERE archive_row.failed_preflight_id = preflight.id
                 OR archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'replay'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_v211_profile_ai_diagnostic_replays'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(
                  failed_preflight_id UUID, rearmed_preflight_id UUID
              )
              WHERE archive_row.failed_preflight_id = preflight.id
                 OR archive_row.rearmed_preflight_id = preflight.id
          )
          AND NOT EXISTS (
              SELECT 1
              FROM (
                  SELECT job.payload
                  FROM public.maintenance_jobs AS job
                  WHERE job.kind = 'rearm'
                    AND job.state = 'succeeded'
                    AND job.payload->>'legacy_source_table' = 'earlybird_v211_relationship_lineage_failure_rearms'
              ) AS archive_source
              CROSS JOIN LATERAL pg_catalog.jsonb_to_record(
                  archive_source.payload->'legacy_row'
              ) AS archive_row(
                  source_preflight_id UUID, rearmed_preflight_id UUID
              )
              WHERE archive_row.source_preflight_id = preflight.id
                 OR archive_row.rearmed_preflight_id = preflight.id
          )
$purge_archive_guards$;
            v_rewritten := pg_catalog.replace(
                v_rewritten,
                E'        ORDER BY preflight.created_at, preflight.id'
                    || pg_catalog.chr(10) || E'        LIMIT p_limit',
                v_purge_guards || E'        ORDER BY preflight.created_at, preflight.id'
                    || pg_catalog.chr(10) || E'        LIMIT p_limit'
            );
        END IF;

        v_after_count := pg_catalog.regexp_count(
            v_rewritten,
            E'(FROM|JOIN)[[:space:]]+public\\.'
                || 'earlybird_(adoption_policy_failure_rearms|concierge_snapshot_conflict_recoveries|pfe_target_evidence_start_rejection_rearms|pfe3_media_artifact_rearms|profile_fetch_exhaustion_recoveries|schema_failure_recoveries|terminal_unavailable_exhaustion_rearms|v211_apify_transient_replays|v211_concierge_replays|v211_lease_policy_failure_rearms|v211_policy_identity_replays|v211_profile_ai_diagnostic_replays|v211_relationship_lineage_failure_rearms)',
            1, 'i'
        );
        IF v_after_count <> 0
           OR (v_routine.signature IN (
                    'public.recover_earlybird_schema_failed_fulfillment(uuid)',
                    'public.bridge_earlybird_v211_lease_rearm_admission(uuid,uuid,timestamptz)',
                    'public.recover_earlybird_concierge_snapshot_conflict(uuid,uuid,timestamptz,timestamptz,text)',
                    'public.bootstrap_earlybird_v211_concierge_first_order(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,smallint,integer,integer,integer,integer,integer,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)',
                    'public.register_earlybird_v211_concierge_reviewed_source(uuid,uuid,uuid,uuid,text,text,jsonb,jsonb)'
                )
                AND v_rewritten ~* E'(FROM|JOIN|INSERT[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM)[[:space:]]+public\\.(earlybird_adoption_policy_failure_rearms|earlybird_concierge_snapshot_conflict_recoveries|earlybird_pfe_target_evidence_start_rejection_rearms|earlybird_pfe3_media_artifact_rearms|earlybird_profile_fetch_exhaustion_recoveries|earlybird_schema_failure_recoveries|earlybird_terminal_unavailable_exhaustion_rearms|earlybird_v211_apify_transient_replays|earlybird_v211_concierge_replays|earlybird_v211_lease_policy_failure_rearms|earlybird_v211_policy_identity_replays|earlybird_v211_profile_ai_diagnostic_replays|earlybird_v211_relationship_lineage_failure_rearms)'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_ROUTINE_REWRITE:%s:%s', v_routine.signature, v_before_count),
                ERRCODE = 'P0001';
        END IF;
        IF v_rewritten IS DISTINCT FROM v_definition THEN
            EXECUTE v_rewritten;
        ELSE
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_ROUTINE_UNCHANGED:%s', v_routine.signature),
                ERRCODE = 'P0001';
        END IF;
    END LOOP;
END;
$routine_rewrite$;

-- The following eleven one-shot writers are retired only after proving that
-- no retained routine, policy, view, or other catalog object calls them.  The
-- remaining service/operator routines were rewritten above and remain live.
DO $candidate_retirement_guard$
DECLARE
    v_signature TEXT;
    v_routine_oid OID;
    v_function_name TEXT;
    v_candidate_oids OID[] := ARRAY[]::OID[];
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'public.rearm_earlybird_zero_spend_adoption_policy_failure(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_pfe_target_evidence_start_rejection(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_pfe3_media_artifact_error(uuid,uuid,timestamptz)',
        'public.recover_earlybird_profile_fetch_exhaustion_fulfillment(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_terminal_unavailable_job_exhaustion(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_apify_transient_replay(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_concierge_replay(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_lease_policy_failure(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_policy_identity_replay(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_profile_ai_diagnostic_replay(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_relationship_lineage_failure(uuid,uuid,timestamptz)'
    ] LOOP
        v_routine_oid := pg_catalog.to_regprocedure(v_signature)::OID;
        IF v_routine_oid IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_CANDIDATE_MISSING:%s', v_signature),
                ERRCODE = 'P0001';
        END IF;
        v_candidate_oids := pg_catalog.array_append(v_candidate_oids, v_routine_oid);
    END LOOP;

    FOREACH v_signature IN ARRAY ARRAY[
        'public.rearm_earlybird_zero_spend_adoption_policy_failure(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_pfe_target_evidence_start_rejection(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_pfe3_media_artifact_error(uuid,uuid,timestamptz)',
        'public.recover_earlybird_profile_fetch_exhaustion_fulfillment(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_terminal_unavailable_job_exhaustion(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_apify_transient_replay(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_concierge_replay(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_lease_policy_failure(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_policy_identity_replay(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_profile_ai_diagnostic_replay(uuid,uuid,timestamptz)',
        'public.rearm_earlybird_v211_relationship_lineage_failure(uuid,uuid,timestamptz)'
    ] LOOP
        v_routine_oid := pg_catalog.to_regprocedure(v_signature)::OID;
        v_function_name := pg_catalog.regexp_replace(
            v_signature, '^public[.]([^ (]+).*$', '\\1'
        );
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.pg_depend AS dependency
            WHERE dependency.refclassid = 'pg_catalog.pg_proc'::REGCLASS
              AND dependency.refobjid = v_routine_oid
              AND NOT (
                  dependency.classid = 'pg_catalog.pg_proc'::REGCLASS
                  AND dependency.objid = ANY(v_candidate_oids)
              )
        ) OR EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS dependent
            JOIN pg_catalog.pg_namespace AS dependent_schema
              ON dependent_schema.oid = dependent.pronamespace
            WHERE dependent_schema.nspname = 'public'
              AND dependent.prokind IN ('f', 'p')
              AND dependent.oid <> ALL(v_candidate_oids)
              AND pg_catalog.pg_get_functiondef(dependent.oid) ~* (
                  '(^|[^a-z0-9_])' || v_function_name
                  || '[[:space:]]*\\('
              )
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_CANDIDATE_CALLED:%s', v_signature),
                ERRCODE = 'P0001';
        END IF;
    END LOOP;
END;
$candidate_retirement_guard$;

-- Remove only source-owned triggers before retiring their relations.  The
-- shared append-only guard remains because retained tables still use it.
DROP TRIGGER IF EXISTS prevent_earlybird_adoption_policy_failure_rearm_mutation
    ON public.earlybird_adoption_policy_failure_rearms;
DROP TRIGGER IF EXISTS prevent_earlybird_concierge_snapshot_conflict_recovery_mutation
    ON public.earlybird_concierge_snapshot_conflict_recoveries;
DROP TRIGGER IF EXISTS prevent_earlybird_pfe_target_evidence_rearm_mutation
    ON public.earlybird_pfe_target_evidence_start_rejection_rearms;
DROP TRIGGER IF EXISTS prevent_earlybird_pfe3_media_artifact_rearm_mutation
    ON public.earlybird_pfe3_media_artifact_rearms;
DROP TRIGGER IF EXISTS prevent_earlybird_profile_fetch_exhaustion_recovery_mutation
    ON public.earlybird_profile_fetch_exhaustion_recoveries;
DROP TRIGGER IF EXISTS prevent_earlybird_schema_failure_recovery_mutation
    ON public.earlybird_schema_failure_recoveries;
DROP TRIGGER IF EXISTS prevent_earlybird_terminal_unavailable_exhaustion_rearm_mutation
    ON public.earlybird_terminal_unavailable_exhaustion_rearms;
DROP TRIGGER IF EXISTS prevent_earlybird_v211_apify_transient_replay_mutation
    ON public.earlybird_v211_apify_transient_replays;
DROP TRIGGER IF EXISTS prevent_earlybird_v211_concierge_replay_mutation
    ON public.earlybird_v211_concierge_replays;
DROP TRIGGER IF EXISTS prevent_earlybird_v211_concierge_replay_mutation_v2
    ON public.earlybird_v211_concierge_replays;
DROP TRIGGER IF EXISTS prevent_earlybird_v211_lease_policy_failure_rearm_mutation
    ON public.earlybird_v211_lease_policy_failure_rearms;
DROP TRIGGER IF EXISTS prevent_earlybird_v211_policy_identity_replay_mutation
    ON public.earlybird_v211_policy_identity_replays;
DROP TRIGGER IF EXISTS prevent_earlybird_v211_profile_ai_diagnostic_replay_mutation
    ON public.earlybird_v211_profile_ai_diagnostic_replays;
DROP TRIGGER IF EXISTS prevent_earlybird_v211_relationship_lineage_rearm_mutation
    ON public.earlybird_v211_relationship_lineage_failure_rearms;

DROP FUNCTION IF EXISTS public.prevent_earlybird_adoption_policy_failure_rearm_mutation();
DROP FUNCTION IF EXISTS public.prevent_earlybird_v211_concierge_replay_mutation_v2();

DROP FUNCTION public.rearm_earlybird_zero_spend_adoption_policy_failure(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_pfe_target_evidence_start_rejection(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_pfe3_media_artifact_error(uuid,uuid,timestamptz);
DROP FUNCTION public.recover_earlybird_profile_fetch_exhaustion_fulfillment(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_terminal_unavailable_job_exhaustion(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_v211_apify_transient_replay(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_v211_concierge_replay(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_v211_lease_policy_failure(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_v211_policy_identity_replay(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_v211_profile_ai_diagnostic_replay(uuid,uuid,timestamptz);
DROP FUNCTION public.rearm_earlybird_v211_relationship_lineage_failure(uuid,uuid,timestamptz);

-- No retained routine may still carry a direct source relation reference when
-- the following DROP TABLE statements execute.  The check is deliberately
-- text-based as PL/pgSQL dependencies are not always catalogued by Postgres.
DO $retained_source_guard$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS routine_schema
          ON routine_schema.oid = routine.pronamespace
        WHERE routine_schema.nspname = 'public'
          AND routine.prokind IN ('f', 'p')
          AND pg_catalog.pg_get_functiondef(routine.oid) ~* $source_pattern$(?x)
              (FROM|JOIN|INSERT[[:space:]]+INTO|UPDATE|DELETE[[:space:]]+FROM)
              [[:space:]]+public[.]
              (earlybird_adoption_policy_failure_rearms
               |earlybird_concierge_snapshot_conflict_recoveries
               |earlybird_pfe_target_evidence_start_rejection_rearms
               |earlybird_pfe3_media_artifact_rearms
               |earlybird_profile_fetch_exhaustion_recoveries
               |earlybird_schema_failure_recoveries
               |earlybird_terminal_unavailable_exhaustion_rearms
               |earlybird_v211_apify_transient_replays
               |earlybird_v211_concierge_replays
               |earlybird_v211_lease_policy_failure_rearms
               |earlybird_v211_policy_identity_replays
               |earlybird_v211_profile_ai_diagnostic_replays
               |earlybird_v211_relationship_lineage_failure_rearms)
          $source_pattern$
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_RETAINED_SOURCE_REFERENCE',
            ERRCODE = 'P0001';
    END IF;
END;
$retained_source_guard$;

DROP TABLE public.earlybird_adoption_policy_failure_rearms;
DROP TABLE public.earlybird_concierge_snapshot_conflict_recoveries;
DROP TABLE public.earlybird_pfe_target_evidence_start_rejection_rearms;
DROP TABLE public.earlybird_pfe3_media_artifact_rearms;
DROP TABLE public.earlybird_profile_fetch_exhaustion_recoveries;
DROP TABLE public.earlybird_schema_failure_recoveries;
DROP TABLE public.earlybird_terminal_unavailable_exhaustion_rearms;
DROP TABLE public.earlybird_v211_apify_transient_replays;
DROP TABLE public.earlybird_v211_concierge_replays;
DROP TABLE public.earlybird_v211_lease_policy_failure_rearms;
DROP TABLE public.earlybird_v211_policy_identity_replays;
DROP TABLE public.earlybird_v211_profile_ai_diagnostic_replays;
DROP TABLE public.earlybird_v211_relationship_lineage_failure_rearms;

DO $post_cutover_guard$
DECLARE
    v_public_table_count BIGINT;
    v_maintenance_columns TEXT[];
BEGIN
    IF EXISTS (
        SELECT 1
        FROM (VALUES
            ('earlybird_adoption_policy_failure_rearms'),
            ('earlybird_concierge_snapshot_conflict_recoveries'),
            ('earlybird_pfe_target_evidence_start_rejection_rearms'),
            ('earlybird_pfe3_media_artifact_rearms'),
            ('earlybird_profile_fetch_exhaustion_recoveries'),
            ('earlybird_schema_failure_recoveries'),
            ('earlybird_terminal_unavailable_exhaustion_rearms'),
            ('earlybird_v211_apify_transient_replays'),
            ('earlybird_v211_concierge_replays'),
            ('earlybird_v211_lease_policy_failure_rearms'),
            ('earlybird_v211_policy_identity_replays'),
            ('earlybird_v211_profile_ai_diagnostic_replays'),
            ('earlybird_v211_relationship_lineage_failure_rearms')
        ) AS retired(source_table)
        WHERE pg_catalog.to_regclass('public.' || retired.source_table) IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_SOURCE_REMAINS', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*) INTO v_public_table_count
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p');
    IF v_public_table_count <> 160 THEN
        RAISE EXCEPTION USING
            MESSAGE = format('EARLYBIRD_RECEIPT_CUTOVER_PUBLIC_TABLE_TOTAL:%s', v_public_table_count),
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.array_agg(
        pg_catalog.format(
            '%s:%s:%s', attribute.attname,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
            CASE WHEN attribute.attnotnull THEN 'true' ELSE 'false' END
        ) ORDER BY attribute.attnum
    ) INTO v_maintenance_columns
    FROM pg_catalog.pg_attribute AS attribute
    JOIN pg_catalog.pg_class AS relation_row
      ON relation_row.oid = attribute.attrelid
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'maintenance_jobs'
      AND relation_row.relkind = 'r'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped;
    IF v_maintenance_columns IS DISTINCT FROM ARRAY[
        'id:uuid:true', 'kind:text:true', 'target_key_hash:text:true',
        'state:text:true', 'attempt_count:smallint:true',
        'lease_generation:bigint:true', 'lease_token:uuid:false',
        'lease_holder_hash:text:false',
        'lease_expires_at:timestamp with time zone:false',
        'next_attempt_at:timestamp with time zone:true',
        'terminal_at:timestamp with time zone:false',
        'last_error_code:text:false', 'payload:jsonb:true',
        'content_hash:text:true', 'created_at:timestamp with time zone:true',
        'updated_at:timestamp with time zone:true', 'legacy_pending_user_id:uuid:false'
    ]::TEXT[] THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_MAINTENANCE_SHAPE_POST', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.maintenance_jobs AS job
        WHERE job.payload->>'legacy_source_table' IN (
            SELECT source_table FROM pg_temp.earlybird_receipt_projection
        )
          AND job.legacy_pending_user_id IS NOT NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_PENDING_COLUMN_CONTAMINATION',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.maintenance_jobs AS job
        JOIN pg_temp.earlybird_receipt_expected AS expected
          ON expected.kind = job.kind
         AND expected.target_key_hash = job.target_key_hash
        WHERE job.state IS DISTINCT FROM 'succeeded'
           OR job.payload IS DISTINCT FROM expected.payload
           OR job.content_hash IS DISTINCT FROM expected.content_hash
           OR job.content_hash IS DISTINCT FROM pg_catalog.encode(
                extensions.digest(convert_to(job.payload::TEXT, 'UTF8'), 'sha256'), 'hex'
              )
           OR job.target_key_hash IS DISTINCT FROM pg_catalog.encode(
                extensions.digest(convert_to(
                    'supabase-22-legacy-earlybird-retirement-v1:'
                    || job.kind || ':'
                    || (job.payload->>'legacy_source_table') || ':'
                    || (job.payload->'legacy_primary_key')::TEXT,
                    'UTF8'
                ), 'sha256'), 'hex'
              )
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_ARCHIVE_HASH_POST', ERRCODE = 'P0001';
    END IF;

    IF (SELECT pg_catalog.count(*)
        FROM public.maintenance_jobs AS job
        WHERE job.payload->>'legacy_source_table' IN (
            SELECT source_table FROM pg_temp.earlybird_receipt_projection
        )) <> 21 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_RECEIPT_CUTOVER_ARCHIVE_COUNT_POST', ERRCODE = 'P0001';
    END IF;
END;
$post_cutover_guard$;

COMMIT;
