-- Supabase 22 legacy earlybird recovery retirement.
-- This migration owns only the eight approved, inactive source tables.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Serialize this one-shot preservation wave and prevent concurrent writes to
-- either the source records or their canonical destination.
SELECT pg_catalog.pg_advisory_xact_lock(22091109, 22);

-- Advisory locks serialize only coordinated copies. Fail closed when another
-- same-database client can be changing function/procedure or publication
-- catalog state, while allowing known background workers with NULL state.
DO $retirement_active_ddl_guard$
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
            ) AS retirement_active_ddl_normalized_query
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
                              'active',
                              'idle in transaction',
                              'idle in transaction (aborted)'
                          )
                          AND normalized.retirement_active_ddl_normalized_query ~* $retirement_active_ddl_pattern$(?x)
                              (
                                  (CREATE[[:space:]]+OR[[:space:]]+REPLACE|CREATE|ALTER|DROP)
                                  [[:space:]]+(FUNCTION|PROCEDURE|ROUTINE)
                                | (CREATE|ALTER|DROP)[[:space:]]+PUBLICATION
                              )
                          $retirement_active_ddl_pattern$
                      )
                  )
              )
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_ACTIVE_DDL: another active publication or function/procedure DDL session is present';
    END IF;
END;
$retirement_active_ddl_guard$;

-- Capture the exact relation OIDs before inspection. Transaction-local GUCs
-- let the post-lock guard detect same-name replacement without helper objects.
DO $retirement_relation_guard$
DECLARE
    v_relation_oid OID;
BEGIN
    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'maintenance_jobs'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.maintenance_jobs';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_maintenance_jobs_oid', v_relation_oid::TEXT, true);

    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'earlybird_concierge_batch_target_lineage_repairs'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.earlybird_concierge_batch_target_lineage_repairs';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_earlybird_concierge_batch_target_lineage_repairs_oid', v_relation_oid::TEXT, true);

    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'earlybird_partial_adoption_second_rearms'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.earlybird_partial_adoption_second_rearms';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_earlybird_partial_adoption_second_rearms_oid', v_relation_oid::TEXT, true);

    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'earlybird_profile_evidence_failure_recoveries'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.earlybird_profile_evidence_failure_recoveries';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_earlybird_profile_evidence_failure_recoveries_oid', v_relation_oid::TEXT, true);

    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'earlybird_v211_apify_transient_admission_resumes'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.earlybird_v211_apify_transient_admission_resumes';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_earlybird_v211_apify_transient_admission_resumes_oid', v_relation_oid::TEXT, true);

    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'earlybird_v211_concierge_copy_corrections'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.earlybird_v211_concierge_copy_corrections';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_earlybird_v211_concierge_copy_corrections_oid', v_relation_oid::TEXT, true);

    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'earlybird_v212_concierge_copy_corrections'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.earlybird_v212_concierge_copy_corrections';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_earlybird_v212_concierge_copy_corrections_oid', v_relation_oid::TEXT, true);

    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'earlybird_v213_concierge_copy_corrections'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.earlybird_v213_concierge_copy_corrections';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_earlybird_v213_concierge_copy_corrections_oid', v_relation_oid::TEXT, true);

    SELECT relation_row.oid INTO v_relation_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'earlybird_v214_concierge_gemini_copy_corrections'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.earlybird_v214_concierge_gemini_copy_corrections';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_earlybird_v214_concierge_gemini_copy_corrections_oid', v_relation_oid::TEXT, true);
END;
$retirement_relation_guard$;

DO $retirement_baseline_guard$
DECLARE
    v_public_table_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*)
      INTO v_public_table_count
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p');
    IF v_public_table_count <> 185 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLIC_TABLE_COUNT: expected 185, found %',
            v_public_table_count;
    END IF;
END;
$retirement_baseline_guard$;

LOCK TABLE public.maintenance_jobs,
    public.earlybird_concierge_batch_target_lineage_repairs,
    public.earlybird_partial_adoption_second_rearms,
    public.earlybird_profile_evidence_failure_recoveries,
    public.earlybird_v211_apify_transient_admission_resumes,
    public.earlybird_v211_concierge_copy_corrections,
    public.earlybird_v212_concierge_copy_corrections,
    public.earlybird_v213_concierge_copy_corrections,
    public.earlybird_v214_concierge_gemini_copy_corrections
    IN ACCESS EXCLUSIVE MODE;

-- Re-resolve after locking. A same-name replacement before LOCK TABLE would
-- otherwise let later catalog checks inspect a different relation.
DO $retirement_relation_revalidation_guard$
DECLARE
    v_relation_oid OID;
    v_relation_kind "char";
BEGIN
    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'maintenance_jobs';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_maintenance_jobs_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.maintenance_jobs';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'earlybird_concierge_batch_target_lineage_repairs';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_earlybird_concierge_batch_target_lineage_repairs_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.earlybird_concierge_batch_target_lineage_repairs';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'earlybird_partial_adoption_second_rearms';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_earlybird_partial_adoption_second_rearms_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.earlybird_partial_adoption_second_rearms';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'earlybird_profile_evidence_failure_recoveries';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_earlybird_profile_evidence_failure_recoveries_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.earlybird_profile_evidence_failure_recoveries';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'earlybird_v211_apify_transient_admission_resumes';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_earlybird_v211_apify_transient_admission_resumes_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.earlybird_v211_apify_transient_admission_resumes';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'earlybird_v211_concierge_copy_corrections';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_earlybird_v211_concierge_copy_corrections_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.earlybird_v211_concierge_copy_corrections';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'earlybird_v212_concierge_copy_corrections';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_earlybird_v212_concierge_copy_corrections_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.earlybird_v212_concierge_copy_corrections';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'earlybird_v213_concierge_copy_corrections';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_earlybird_v213_concierge_copy_corrections_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.earlybird_v213_concierge_copy_corrections';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_relation_oid, v_relation_kind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public' AND relation_row.relname = 'earlybird_v214_concierge_gemini_copy_corrections';
    IF NOT FOUND OR v_relation_kind <> 'r'
       OR v_relation_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting('retirement.expected_earlybird_v214_concierge_gemini_copy_corrections_oid', true) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.earlybird_v214_concierge_gemini_copy_corrections';
    END IF;
END;
$retirement_relation_revalidation_guard$;

DO $retirement_catalog_guard$
DECLARE
    v_table_name TEXT;
    v_expected_columns TEXT[];
    v_actual_columns TEXT[];
    v_maintenance_columns TEXT[];
BEGIN
    -- The destination shape is intentionally checked by column name, type,
    -- and nullability before any source record is copied.
    SELECT pg_catalog.array_agg(
        pg_catalog.format(
            '%s:%s:%s',
            attribute.attname,
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
            CASE WHEN attribute.attnotnull THEN 'true' ELSE 'false' END
        ) ORDER BY attribute.attnum
    )
      INTO v_maintenance_columns
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
        'id:uuid:true',
        'kind:text:true',
        'target_key_hash:text:true',
        'state:text:true',
        'attempt_count:smallint:true',
        'lease_generation:bigint:true',
        'lease_token:uuid:false',
        'lease_holder_hash:text:false',
        'lease_expires_at:timestamp with time zone:false',
        'next_attempt_at:timestamp with time zone:true',
        'terminal_at:timestamp with time zone:false',
        'last_error_code:text:false',
        'payload:jsonb:true',
        'content_hash:text:true',
        'created_at:timestamp with time zone:true',
        'updated_at:timestamp with time zone:true'
    ]::TEXT[] THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_SHAPE: public.maintenance_jobs differs from the reviewed shape';
    END IF;

    FOREACH v_table_name IN ARRAY ARRAY[
        'earlybird_concierge_batch_target_lineage_repairs',
        'earlybird_partial_adoption_second_rearms',
        'earlybird_profile_evidence_failure_recoveries',
        'earlybird_v211_apify_transient_admission_resumes',
        'earlybird_v211_concierge_copy_corrections',
        'earlybird_v212_concierge_copy_corrections',
        'earlybird_v213_concierge_copy_corrections',
        'earlybird_v214_concierge_gemini_copy_corrections'
    ] LOOP
        v_expected_columns := CASE v_table_name
            WHEN 'earlybird_concierge_batch_target_lineage_repairs' THEN ARRAY[
                'cohort_key:text:true', 'order_id:uuid:true', 'request_id:uuid:true',
                'preflight_id:uuid:true', 'rearm_generation:smallint:true',
                'source_failure_code:text:true', 'source_credential_slot:text:true',
                'fallback_credential_slot:text:true', 'allowlist_hash:text:true',
                'old_request_target_hash:text:true', 'old_preflight_target_hash:text:true',
                'repaired_target_hash:text:true', 'repaired_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_partial_adoption_second_rearms' THEN ARRAY[
                'order_id:uuid:true', 'original_failed_request_id:uuid:true',
                'first_policy_failed_request_id:uuid:true',
                'second_policy_failed_request_id:uuid:true', 'rearmed_preflight_id:uuid:true',
                'expected_fulfillment_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_profile_evidence_failure_recoveries' THEN ARRAY[
                'order_id:uuid:true', 'failed_request_id:uuid:true',
                'recovery_preflight_id:uuid:true', 'prior_attempt_count:smallint:true',
                'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v211_apify_transient_admission_resumes' THEN ARRAY[
                'order_id:uuid:true', 'expected_manual_review_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v211_concierge_copy_corrections' THEN ARRAY[
                'order_id:uuid:true', 'result_request_id:uuid:true',
                'published_source_fingerprint:text:true',
                'expected_published_result_hash:text:true',
                'correction_result_hash:text:true', 'copy_payload:jsonb:true',
                'corrected_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v212_concierge_copy_corrections' THEN ARRAY[
                'order_id:uuid:true', 'result_request_id:uuid:true',
                'prior_correction_result_hash:text:true',
                'correction_result_hash:text:true', 'copy_payload:jsonb:true',
                'corrected_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v213_concierge_copy_corrections' THEN ARRAY[
                'order_id:uuid:true', 'result_request_id:uuid:true',
                'prior_correction_result_hash:text:true',
                'correction_result_hash:text:true', 'copy_payload:jsonb:true',
                'corrected_at:timestamp with time zone:true'
            ]
            WHEN 'earlybird_v214_concierge_gemini_copy_corrections' THEN ARRAY[
                'order_id:uuid:true', 'result_request_id:uuid:true',
                'prior_correction_result_hash:text:true',
                'correction_result_hash:text:true', 'copy_payload:jsonb:true',
                'corrected_at:timestamp with time zone:true'
            ]
            ELSE ARRAY[]::TEXT[]
        END;

        SELECT pg_catalog.array_agg(
            pg_catalog.format(
                '%s:%s:%s',
                attribute.attname,
                pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                CASE WHEN attribute.attnotnull THEN 'true' ELSE 'false' END
            ) ORDER BY attribute.attnum
        )
          INTO v_actual_columns
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
            RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_SHAPE: public.% differs from the reviewed shape',
                v_table_name;
        END IF;
    END LOOP;

    -- Only dependencies that would make an exact restrictive drop unsafe are blocked.
    -- Outgoing foreign keys owned by the source tables are expected history.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS foreign_key
        JOIN pg_catalog.pg_class AS parent_relation
          ON parent_relation.oid = foreign_key.confrelid
        JOIN pg_catalog.pg_namespace AS parent_schema
          ON parent_schema.oid = parent_relation.relnamespace
        WHERE foreign_key.contype = 'f'
          AND parent_schema.nspname = 'public'
          AND parent_relation.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_INCOMING_FOREIGN_KEY';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_class AS target_relation
          ON target_relation.oid = dependency.refobjid
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = target_relation.relnamespace
        WHERE dependency.classid = 'pg_catalog.pg_rewrite'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND target_schema.nspname = 'public'
          AND target_relation.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_DEPENDENT_VIEW';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_proc AS dependent_routine
          ON dependent_routine.oid = dependency.objid
        JOIN pg_catalog.pg_class AS target_relation
          ON target_relation.oid = dependency.refobjid
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = target_relation.relnamespace
        WHERE dependency.classid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND target_schema.nspname = 'public'
          AND target_relation.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          )
          AND dependent_routine.oid NOT IN (
              SELECT pg_catalog.to_regprocedure(signature_text)::OID
              FROM (VALUES
                  ('public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()'),
                  ('public.reconcile_exact_three_concierge_target_lineage(text)'),
                  ('public.prevent_earlybird_partial_adoption_second_rearm_mutation()'),
                  ('public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)'),
                  ('public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)'),
                  ('public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)'),
                  ('public.prevent_earlybird_v211_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v212_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v213_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()'),
                  ('public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)')
              ) AS expected(signature_text)
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_RETAINED_ROUTINE_DEPENDENCY';
    END IF;

    -- A complete definition scan catches PL/pgSQL and dynamic references that
    -- are not represented in pg_depend. The shared schema-recovery trigger
    -- function is deliberately not in the drop list and has no source-table
    -- reference; target-owned trigger functions are allowlisted above.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS stored_routine
        JOIN pg_catalog.pg_namespace AS routine_schema
          ON routine_schema.oid = stored_routine.pronamespace
        WHERE routine_schema.nspname = 'public'
          AND stored_routine.prokind IN ('f', 'p')
          AND stored_routine.oid NOT IN (
              SELECT pg_catalog.to_regprocedure(signature_text)::OID
              FROM (VALUES
                  ('public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()'),
                  ('public.reconcile_exact_three_concierge_target_lineage(text)'),
                  ('public.prevent_earlybird_partial_adoption_second_rearm_mutation()'),
                  ('public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)'),
                  ('public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)'),
                  ('public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)'),
                  ('public.prevent_earlybird_v211_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v212_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v213_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()'),
                  ('public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)')
              ) AS expected(signature_text)
          )
          AND pg_catalog.pg_get_functiondef(stored_routine.oid) ~* E'\\m(earlybird_concierge_batch_target_lineage_repairs|earlybird_partial_adoption_second_rearms|earlybird_profile_evidence_failure_recoveries|earlybird_v211_apify_transient_admission_resumes|earlybird_v211_concierge_copy_corrections|earlybird_v212_concierge_copy_corrections|earlybird_v213_concierge_copy_corrections|earlybird_v214_concierge_gemini_copy_corrections)\\M'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_RETAINED_ROUTINE_DEFINITION_REFERENCE';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication AS publication_row
        WHERE publication_row.puballtables
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLICATION_ALL_TABLES';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_namespace AS publication_schema
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = publication_schema.pnnspid
        WHERE target_schema.nspname = 'public'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLICATION_SCHEMA';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_rel AS publication_table
        JOIN pg_catalog.pg_class AS target_relation
          ON target_relation.oid = publication_table.prrelid
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = target_relation.relnamespace
        WHERE target_schema.nspname = 'public'
          AND target_relation.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLICATION_MEMBERSHIP';
    END IF;
END;
$retirement_catalog_guard$;

DO $retirement_source_count_guard$
DECLARE
    v_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_concierge_batch_target_lineage_repairs;
    IF v_count <> 3 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: public.earlybird_concierge_batch_target_lineage_repairs expected 3, found %', v_count;
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_partial_adoption_second_rearms;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: public.earlybird_partial_adoption_second_rearms expected 1, found %', v_count;
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_profile_evidence_failure_recoveries;
    IF v_count <> 2 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: public.earlybird_profile_evidence_failure_recoveries expected 2, found %', v_count;
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v211_apify_transient_admission_resumes;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: public.earlybird_v211_apify_transient_admission_resumes expected 1, found %', v_count;
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v211_concierge_copy_corrections;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: public.earlybird_v211_concierge_copy_corrections expected 1, found %', v_count;
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v212_concierge_copy_corrections;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: public.earlybird_v212_concierge_copy_corrections expected 1, found %', v_count;
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v213_concierge_copy_corrections;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: public.earlybird_v213_concierge_copy_corrections expected 1, found %', v_count;
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.earlybird_v214_concierge_gemini_copy_corrections;
    IF v_count <> 1 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: public.earlybird_v214_concierge_gemini_copy_corrections expected 1, found %', v_count;
    END IF;
END;
$retirement_source_count_guard$;

DO $retirement_routine_guard$
DECLARE
    v_signature TEXT;
    v_routine OID;
    v_routine_index INTEGER := 0;
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()',
        'public.reconcile_exact_three_concierge_target_lineage(text)',
        'public.prevent_earlybird_partial_adoption_second_rearm_mutation()',
        'public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)',
        'public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)',
        'public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)',
        'public.prevent_earlybird_v211_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)',
        'public.prevent_earlybird_v212_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)',
        'public.prevent_earlybird_v213_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)',
        'public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()',
        'public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)'
    ] LOOP
        v_routine := pg_catalog.to_regprocedure(v_signature);
        IF v_routine IS NULL THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_MISSING: %', v_signature;
        END IF;
        IF NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_proc AS routine_row
            JOIN pg_catalog.pg_namespace AS routine_schema
              ON routine_schema.oid = routine_row.pronamespace
            WHERE routine_row.oid = v_routine
              AND routine_schema.nspname = 'public'
              AND routine_row.prokind IN ('f', 'p')
              AND pg_catalog.pg_get_function_identity_arguments(routine_row.oid)
                    = CASE v_signature
                        WHEN 'public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()' THEN ''
                        WHEN 'public.reconcile_exact_three_concierge_target_lineage(text)' THEN 'p_expected_allowlist_hash text'
                        WHEN 'public.prevent_earlybird_partial_adoption_second_rearm_mutation()' THEN ''
                        WHEN 'public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)' THEN 'p_order_id uuid, p_expected_failed_request_id uuid, p_expected_manual_review_at timestamp with time zone'
                        WHEN 'public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)' THEN 'p_order_id uuid, p_expected_failed_request_id uuid, p_expected_manual_review_at timestamp with time zone'
                        WHEN 'public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)' THEN 'p_order_id uuid, p_expected_manual_review_at timestamp with time zone'
                        WHEN 'public.prevent_earlybird_v211_concierge_copy_correction_mutation()' THEN ''
                        WHEN 'public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)' THEN 'p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_correction_result_hash text, p_copy_payload jsonb'
                        WHEN 'public.prevent_earlybird_v212_concierge_copy_correction_mutation()' THEN ''
                        WHEN 'public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)' THEN 'p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_correction_result_hash text, p_copy_payload jsonb'
                        WHEN 'public.prevent_earlybird_v213_concierge_copy_correction_mutation()' THEN ''
                        WHEN 'public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)' THEN 'p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_correction_result_hash text, p_copy_payload jsonb'
                        WHEN 'public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()' THEN ''
                        WHEN 'public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)' THEN 'p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_expected_v213_fact_snapshot jsonb, p_correction_result_hash text, p_copy_payload jsonb'
                    END
        ) THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_IDENTITY_MISMATCH: %', v_signature;
        END IF;
        v_routine_index := v_routine_index + 1;
        PERFORM pg_catalog.set_config(
            'retirement.expected_routine_' || pg_catalog.lpad(v_routine_index::TEXT, 2, '0') || '_oid',
            v_routine::TEXT,
            true
        );
    END LOOP;
END;
$retirement_routine_guard$;

DO $retirement_routine_caller_guard$
BEGIN
    IF EXISTS (
        WITH expected AS (
            SELECT pg_catalog.to_regprocedure(signature_text)::OID AS routine_oid
            FROM (VALUES
                ('public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()'),
                ('public.reconcile_exact_three_concierge_target_lineage(text)'),
                ('public.prevent_earlybird_partial_adoption_second_rearm_mutation()'),
                ('public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)'),
                ('public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)'),
                ('public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)'),
                ('public.prevent_earlybird_v211_concierge_copy_correction_mutation()'),
                ('public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)'),
                ('public.prevent_earlybird_v212_concierge_copy_correction_mutation()'),
                ('public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)'),
                ('public.prevent_earlybird_v213_concierge_copy_correction_mutation()'),
                ('public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)'),
                ('public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()'),
                ('public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)')
            ) AS expected_signatures(signature_text)
        )
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_proc AS dependent_routine
          ON dependent_routine.oid = dependency.objid
        WHERE dependency.classid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refobjid IN (SELECT routine_oid FROM expected)
          AND dependent_routine.oid NOT IN (SELECT routine_oid FROM expected)
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_RETAINED_ROUTINE_CALLER';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS stored_routine
        JOIN pg_catalog.pg_namespace AS routine_schema
          ON routine_schema.oid = stored_routine.pronamespace
        WHERE routine_schema.nspname = 'public'
          AND stored_routine.prokind IN ('f', 'p')
          AND stored_routine.oid NOT IN (
              SELECT pg_catalog.to_regprocedure(signature_text)::OID
              FROM (VALUES
                  ('public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()'),
                  ('public.reconcile_exact_three_concierge_target_lineage(text)'),
                  ('public.prevent_earlybird_partial_adoption_second_rearm_mutation()'),
                  ('public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)'),
                  ('public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)'),
                  ('public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)'),
                  ('public.prevent_earlybird_v211_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v212_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v213_concierge_copy_correction_mutation()'),
                  ('public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)'),
                  ('public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()'),
                  ('public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)')
              ) AS expected(signature_text)
          )
          AND pg_catalog.pg_get_functiondef(stored_routine.oid) ~* E'\\m(prevent_earlybird_concierge_batch_target_lineage_repair_mutation|reconcile_exact_three_concierge_target_lineage|prevent_earlybird_partial_adoption_second_rearm_mutation|rearm_earlybird_partial_adoption_second_failure|recover_earlybird_profile_evidence_failed_fulfillment|resume_earlybird_v211_apify_transient_admission|prevent_earlybird_v211_concierge_copy_correction_mutation|correct_earlybird_v211_concierge_copy|prevent_earlybird_v212_concierge_copy_correction_mutation|correct_earlybird_v212_concierge_copy|prevent_earlybird_v213_concierge_copy_correction_mutation|correct_earlybird_v213_concierge_copy|prevent_earlybird_v214_concierge_gemini_copy_correction_mutation|correct_earlybird_v214_concierge_gemini_copy)\\M'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_RETAINED_ROUTINE_CALLER';
    END IF;
END;
$retirement_routine_caller_guard$;

-- Each insert is explicit so table identifiers and primary-key bindings are
-- reviewable. The complete source row remains in canonical JSONB.
CREATE TEMP TABLE pg_temp.retirement_expected_canonical_rows (
    kind TEXT NOT NULL,
    target_key_hash TEXT NOT NULL,
    payload JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (kind, target_key_hash)
) ON COMMIT DROP;

-- Materialize the exact incoming rows before touching canonical conflicts. A
-- conflict is safe only when the existing row is succeeded and both payload
-- and content_hash are byte-for-byte/equality exact; otherwise abort.
INSERT INTO pg_temp.retirement_expected_canonical_rows (
    kind, target_key_hash, payload, content_hash
)
WITH incoming AS (
    SELECT
        'recovery'::TEXT AS kind,
        'earlybird_concierge_batch_target_lineage_repairs'::TEXT AS source_table,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_concierge_batch_target_lineage_repairs',
            'legacy_primary_key', pg_catalog.jsonb_build_object(
                'cohort_key', source_row.cohort_key,
                'order_id', source_row.order_id
            ),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_concierge_batch_target_lineage_repairs AS source_row
    UNION ALL
    SELECT
        'rearm'::TEXT,
        'earlybird_partial_adoption_second_rearms'::TEXT,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_partial_adoption_second_rearms',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        )
    FROM public.earlybird_partial_adoption_second_rearms AS source_row
    UNION ALL
    SELECT
        'recovery'::TEXT,
        'earlybird_profile_evidence_failure_recoveries'::TEXT,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_profile_evidence_failure_recoveries',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        )
    FROM public.earlybird_profile_evidence_failure_recoveries AS source_row
    UNION ALL
    SELECT
        'rearm'::TEXT,
        'earlybird_v211_apify_transient_admission_resumes'::TEXT,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v211_apify_transient_admission_resumes',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        )
    FROM public.earlybird_v211_apify_transient_admission_resumes AS source_row
    UNION ALL
    SELECT
        'replay'::TEXT,
        'earlybird_v211_concierge_copy_corrections'::TEXT,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v211_concierge_copy_corrections',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        )
    FROM public.earlybird_v211_concierge_copy_corrections AS source_row
    UNION ALL
    SELECT
        'replay'::TEXT,
        'earlybird_v212_concierge_copy_corrections'::TEXT,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v212_concierge_copy_corrections',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        )
    FROM public.earlybird_v212_concierge_copy_corrections AS source_row
    UNION ALL
    SELECT
        'replay'::TEXT,
        'earlybird_v213_concierge_copy_corrections'::TEXT,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v213_concierge_copy_corrections',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        )
    FROM public.earlybird_v213_concierge_copy_corrections AS source_row
    UNION ALL
    SELECT
        'replay'::TEXT,
        'earlybird_v214_concierge_gemini_copy_corrections'::TEXT,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v214_concierge_gemini_copy_corrections',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        )
    FROM public.earlybird_v214_concierge_gemini_copy_corrections AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-legacy-earlybird-retirement-v1:' || kind || ':'
            || source_table || ':' || (payload->'legacy_primary_key')::TEXT,
            'UTF8'
        )), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
SELECT kind, target_key_hash, payload, content_hash
FROM prepared;

DO $retirement_canonical_conflict_guard$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_temp.retirement_expected_canonical_rows AS expected
        JOIN public.maintenance_jobs AS actual
          ON actual.kind = expected.kind
         AND actual.target_key_hash = expected.target_key_hash
        WHERE actual.state IS DISTINCT FROM 'succeeded'
           OR actual.payload IS DISTINCT FROM expected.payload
           OR actual.content_hash IS DISTINCT FROM expected.content_hash
    ) THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: existing canonical row is not succeeded with the exact payload and content_hash';
    END IF;
END;
$retirement_canonical_conflict_guard$;

WITH incoming AS (
    SELECT
        'recovery'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_concierge_batch_target_lineage_repairs',
            'legacy_primary_key', pg_catalog.jsonb_build_object(
                'cohort_key', source_row.cohort_key,
                'order_id', source_row.order_id
            ),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_concierge_batch_target_lineage_repairs AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(
            pg_catalog.sha256(
                pg_catalog.convert_to(
                    'supabase-22-legacy-earlybird-retirement-v1:'
                    || kind || ':earlybird_concierge_batch_target_lineage_repairs:'
                    || (payload->'legacy_primary_key')::TEXT,
                    'UTF8'
                )
            ), 'hex'
        ) AS target_key_hash,
        payload,
        pg_catalog.encode(
            pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')),
            'hex'
        ) AS content_hash
    FROM incoming
)
INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM prepared
ON CONFLICT (kind, target_key_hash) DO NOTHING;

WITH incoming AS (
    SELECT
        'rearm'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_partial_adoption_second_rearms',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_partial_adoption_second_rearms AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-legacy-earlybird-retirement-v1:' || kind
            || ':earlybird_partial_adoption_second_rearms:'
            || (payload->'legacy_primary_key')::TEXT, 'UTF8')), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM prepared
ON CONFLICT (kind, target_key_hash) DO NOTHING;

WITH incoming AS (
    SELECT
        'recovery'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_profile_evidence_failure_recoveries',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_profile_evidence_failure_recoveries AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-legacy-earlybird-retirement-v1:' || kind
            || ':earlybird_profile_evidence_failure_recoveries:'
            || (payload->'legacy_primary_key')::TEXT, 'UTF8')), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM prepared
ON CONFLICT (kind, target_key_hash) DO NOTHING;

WITH incoming AS (
    SELECT
        'rearm'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v211_apify_transient_admission_resumes',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_v211_apify_transient_admission_resumes AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-legacy-earlybird-retirement-v1:' || kind
            || ':earlybird_v211_apify_transient_admission_resumes:'
            || (payload->'legacy_primary_key')::TEXT, 'UTF8')), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM prepared
ON CONFLICT (kind, target_key_hash) DO NOTHING;

WITH incoming AS (
    SELECT
        'replay'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v211_concierge_copy_corrections',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_v211_concierge_copy_corrections AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-legacy-earlybird-retirement-v1:' || kind
            || ':earlybird_v211_concierge_copy_corrections:'
            || (payload->'legacy_primary_key')::TEXT, 'UTF8')), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM prepared
ON CONFLICT (kind, target_key_hash) DO NOTHING;

WITH incoming AS (
    SELECT
        'replay'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v212_concierge_copy_corrections',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_v212_concierge_copy_corrections AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-legacy-earlybird-retirement-v1:' || kind
            || ':earlybird_v212_concierge_copy_corrections:'
            || (payload->'legacy_primary_key')::TEXT, 'UTF8')), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM prepared
ON CONFLICT (kind, target_key_hash) DO NOTHING;

WITH incoming AS (
    SELECT
        'replay'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v213_concierge_copy_corrections',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_v213_concierge_copy_corrections AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-legacy-earlybird-retirement-v1:' || kind
            || ':earlybird_v213_concierge_copy_corrections:'
            || (payload->'legacy_primary_key')::TEXT, 'UTF8')), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM prepared
ON CONFLICT (kind, target_key_hash) DO NOTHING;

WITH incoming AS (
    SELECT
        'replay'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'earlybird_v214_concierge_gemini_copy_corrections',
            'legacy_primary_key', pg_catalog.jsonb_build_object('order_id', source_row.order_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.earlybird_v214_concierge_gemini_copy_corrections AS source_row
), prepared AS (
    SELECT kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-legacy-earlybird-retirement-v1:' || kind
            || ':earlybird_v214_concierge_gemini_copy_corrections:'
            || (payload->'legacy_primary_key')::TEXT, 'UTF8')), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM prepared
ON CONFLICT (kind, target_key_hash) DO NOTHING;

DO $retirement_parity_guard$
DECLARE
    v_source_count BIGINT;
    v_canonical_count BIGINT;
    v_source_hash TEXT;
    v_canonical_hash TEXT;
    v_total BIGINT;
BEGIN
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.earlybird_concierge_batch_target_lineage_repairs AS source_row;
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n' ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' = 'earlybird_concierge_batch_target_lineage_repairs';
    IF v_source_count <> 3 OR v_canonical_count <> v_source_count OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: RETIREMENT_GUARD_CANONICAL_PARITY earlybird_concierge_batch_target_lineage_repairs';
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.earlybird_partial_adoption_second_rearms AS source_row;
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n' ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' = 'earlybird_partial_adoption_second_rearms';
    IF v_source_count <> 1 OR v_canonical_count <> v_source_count OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: RETIREMENT_GUARD_CANONICAL_PARITY earlybird_partial_adoption_second_rearms';
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.earlybird_profile_evidence_failure_recoveries AS source_row;
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n' ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' = 'earlybird_profile_evidence_failure_recoveries';
    IF v_source_count <> 2 OR v_canonical_count <> v_source_count OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: RETIREMENT_GUARD_CANONICAL_PARITY earlybird_profile_evidence_failure_recoveries';
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.earlybird_v211_apify_transient_admission_resumes AS source_row;
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n' ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' = 'earlybird_v211_apify_transient_admission_resumes';
    IF v_source_count <> 1 OR v_canonical_count <> v_source_count OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: RETIREMENT_GUARD_CANONICAL_PARITY earlybird_v211_apify_transient_admission_resumes';
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.earlybird_v211_concierge_copy_corrections AS source_row;
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n' ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' = 'earlybird_v211_concierge_copy_corrections';
    IF v_source_count <> 1 OR v_canonical_count <> v_source_count OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: RETIREMENT_GUARD_CANONICAL_PARITY earlybird_v211_concierge_copy_corrections';
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.earlybird_v212_concierge_copy_corrections AS source_row;
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n' ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' = 'earlybird_v212_concierge_copy_corrections';
    IF v_source_count <> 1 OR v_canonical_count <> v_source_count OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: RETIREMENT_GUARD_CANONICAL_PARITY earlybird_v212_concierge_copy_corrections';
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.earlybird_v213_concierge_copy_corrections AS source_row;
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n' ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' = 'earlybird_v213_concierge_copy_corrections';
    IF v_source_count <> 1 OR v_canonical_count <> v_source_count OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: RETIREMENT_GUARD_CANONICAL_PARITY earlybird_v213_concierge_copy_corrections';
    END IF;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.earlybird_v214_concierge_gemini_copy_corrections AS source_row;
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n' ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' = 'earlybird_v214_concierge_gemini_copy_corrections';
    IF v_source_count <> 1 OR v_canonical_count <> v_source_count OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT: RETIREMENT_GUARD_CANONICAL_PARITY earlybird_v214_concierge_gemini_copy_corrections';
    END IF;

    SELECT pg_catalog.count(*) INTO v_total
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' IN (
        'earlybird_concierge_batch_target_lineage_repairs',
        'earlybird_partial_adoption_second_rearms',
        'earlybird_profile_evidence_failure_recoveries',
        'earlybird_v211_apify_transient_admission_resumes',
        'earlybird_v211_concierge_copy_corrections',
        'earlybird_v212_concierge_copy_corrections',
        'earlybird_v213_concierge_copy_corrections',
        'earlybird_v214_concierge_gemini_copy_corrections'
    );
    IF v_total <> 11 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_TOTAL: expected 11, found %', v_total;
    END IF;
END;
$retirement_parity_guard$;

-- Repeat the visibility fence immediately before the exact destructive
-- allowlist. The target locks do not block uncoordinated routine/publication
-- DDL, so the coordinator still needs a single-writer DDL window.
DO $retirement_active_ddl_guard$
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
            ) AS retirement_active_ddl_normalized_query
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
                              'active',
                              'idle in transaction',
                              'idle in transaction (aborted)'
                          )
                          AND normalized.retirement_active_ddl_normalized_query ~* $retirement_active_ddl_pattern$(?x)
                              (
                                  (CREATE[[:space:]]+OR[[:space:]]+REPLACE|CREATE|ALTER|DROP)
                                  [[:space:]]+(FUNCTION|PROCEDURE|ROUTINE)
                                | (CREATE|ALTER|DROP)[[:space:]]+PUBLICATION
                              )
                          $retirement_active_ddl_pattern$
                      )
                  )
              )
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_ACTIVE_DDL: another active publication or function/procedure DDL session is present';
    END IF;
END;
$retirement_active_ddl_guard$;

-- Revalidate every reviewed routine identity after all evidence reads. A
-- same-signature drop/recreate gets a new OID and aborts before any DROP.
DO $retirement_routine_revalidation_guard$
DECLARE
    v_signature TEXT;
    v_routine OID;
    v_routine_index INTEGER := 0;
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()',
        'public.reconcile_exact_three_concierge_target_lineage(text)',
        'public.prevent_earlybird_partial_adoption_second_rearm_mutation()',
        'public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)',
        'public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)',
        'public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)',
        'public.prevent_earlybird_v211_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)',
        'public.prevent_earlybird_v212_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)',
        'public.prevent_earlybird_v213_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)',
        'public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()',
        'public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)'
    ] LOOP
        v_routine_index := v_routine_index + 1;
        v_routine := pg_catalog.to_regprocedure(v_signature);
        IF v_routine IS NULL
           OR v_routine::TEXT IS DISTINCT FROM pg_catalog.current_setting(
               'retirement.expected_routine_' || pg_catalog.lpad(v_routine_index::TEXT, 2, '0') || '_oid',
               true
           ) THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_REPLACED: %', v_signature;
        END IF;
    END LOOP;
END;
$retirement_routine_revalidation_guard$;

-- Revoke before dropping the exact orphaned identities. Shared schema
-- recovery trigger routines are intentionally not listed here.
REVOKE ALL ON FUNCTION public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.reconcile_exact_three_concierge_target_lineage(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_earlybird_partial_adoption_second_rearm_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.rearm_earlybird_partial_adoption_second_failure(UUID, UUID, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.recover_earlybird_profile_evidence_failed_fulfillment(UUID, UUID, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resume_earlybird_v211_apify_transient_admission(UUID, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_earlybird_v211_concierge_copy_correction_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_earlybird_v211_concierge_copy(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_earlybird_v212_concierge_copy_correction_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_earlybird_v212_concierge_copy(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_earlybird_v213_concierge_copy_correction_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_earlybird_v213_concierge_copy(UUID, UUID, UUID, TEXT, TEXT, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.correct_earlybird_v214_concierge_gemini_copy(UUID, UUID, UUID, TEXT, TEXT, TEXT, JSONB, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- Remove the eight observed table-owned triggers before dropping their exact
-- target routines. The two triggers using the shared schema-recovery routine
-- are removed here, but that shared routine itself remains in service.
DROP TRIGGER prevent_earlybird_concierge_batch_target_lineage_repair_mutation
    ON public.earlybird_concierge_batch_target_lineage_repairs;
DROP TRIGGER prevent_earlybird_partial_adoption_second_rearm_mutation
    ON public.earlybird_partial_adoption_second_rearms;
DROP TRIGGER prevent_earlybird_profile_evidence_failure_recovery_mutation
    ON public.earlybird_profile_evidence_failure_recoveries;
DROP TRIGGER prevent_earlybird_v211_apify_transient_admission_resume_mutation
    ON public.earlybird_v211_apify_transient_admission_resumes;
DROP TRIGGER prevent_earlybird_v211_concierge_copy_correction_mutation
    ON public.earlybird_v211_concierge_copy_corrections;
DROP TRIGGER prevent_earlybird_v212_concierge_copy_correction_mutation
    ON public.earlybird_v212_concierge_copy_corrections;
DROP TRIGGER prevent_earlybird_v213_concierge_copy_correction_mutation
    ON public.earlybird_v213_concierge_copy_corrections;
DROP TRIGGER prevent_earlybird_v214_concierge_gemini_copy_correction_mutation
    ON public.earlybird_v214_concierge_gemini_copy_corrections;

DROP FUNCTION public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation();
DROP FUNCTION public.reconcile_exact_three_concierge_target_lineage(text);
DROP FUNCTION public.prevent_earlybird_partial_adoption_second_rearm_mutation();
DROP FUNCTION public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone);
DROP FUNCTION public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone);
DROP FUNCTION public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone);
DROP FUNCTION public.prevent_earlybird_v211_concierge_copy_correction_mutation();
DROP FUNCTION public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb);
DROP FUNCTION public.prevent_earlybird_v212_concierge_copy_correction_mutation();
DROP FUNCTION public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb);
DROP FUNCTION public.prevent_earlybird_v213_concierge_copy_correction_mutation();
DROP FUNCTION public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb);
DROP FUNCTION public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation();
DROP FUNCTION public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb);

DROP TABLE public.earlybird_concierge_batch_target_lineage_repairs;
DROP TABLE public.earlybird_partial_adoption_second_rearms;
DROP TABLE public.earlybird_profile_evidence_failure_recoveries;
DROP TABLE public.earlybird_v211_apify_transient_admission_resumes;
DROP TABLE public.earlybird_v211_concierge_copy_corrections;
DROP TABLE public.earlybird_v212_concierge_copy_corrections;
DROP TABLE public.earlybird_v213_concierge_copy_corrections;
DROP TABLE public.earlybird_v214_concierge_gemini_copy_corrections;

DO $retirement_terminal_guard$
DECLARE
    v_public_table_count BIGINT;
    v_canonical_count BIGINT;
    v_signature TEXT;
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation_row
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TARGET_REMAINS';
    END IF;

    FOREACH v_signature IN ARRAY ARRAY[
        'public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()',
        'public.reconcile_exact_three_concierge_target_lineage(text)',
        'public.prevent_earlybird_partial_adoption_second_rearm_mutation()',
        'public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)',
        'public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)',
        'public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)',
        'public.prevent_earlybird_v211_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)',
        'public.prevent_earlybird_v212_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)',
        'public.prevent_earlybird_v213_concierge_copy_correction_mutation()',
        'public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)',
        'public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()',
        'public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)'
    ] LOOP
        IF pg_catalog.to_regprocedure(v_signature) IS NOT NULL THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_REMAINS: %', v_signature;
        END IF;
    END LOOP;

    SELECT pg_catalog.count(*)
      INTO v_canonical_count
    FROM public.maintenance_jobs AS job
    WHERE job.payload->>'legacy_source_table' IN (
        'earlybird_concierge_batch_target_lineage_repairs',
        'earlybird_partial_adoption_second_rearms',
        'earlybird_profile_evidence_failure_recoveries',
        'earlybird_v211_apify_transient_admission_resumes',
        'earlybird_v211_concierge_copy_corrections',
        'earlybird_v212_concierge_copy_corrections',
        'earlybird_v213_concierge_copy_corrections',
        'earlybird_v214_concierge_gemini_copy_corrections'
    );
    IF v_canonical_count <> 11 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_TOTAL: terminal expected 11, found %', v_canonical_count;
    END IF;

    SELECT pg_catalog.count(*)
      INTO v_public_table_count
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p');
    IF v_public_table_count <> 177 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLIC_TABLE_COUNT: expected 177, found %',
            v_public_table_count;
    END IF;
END;
$retirement_terminal_guard$;

COMMIT;
