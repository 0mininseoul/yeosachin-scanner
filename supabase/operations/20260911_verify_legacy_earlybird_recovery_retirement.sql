-- Sanitized coordinator-owned verifier for the Supabase 22 earlybird wave.
--
-- This file is intentionally outside supabase/migrations and is read-only
-- apart from a temporary report table that is rolled back before return. The
-- caller selects exactly one mode in the session before invoking this file:
--
--   SET supabase.retirement_verifier_mode = 'preflight';
--   \i supabase/operations/20260911_verify_legacy_earlybird_recovery_retirement.sql
--
-- Output contains only relation/routine names, counts, hashes, and booleans.

BEGIN;
SET LOCAL statement_timeout = '2min';

DO $verifier_mode_guard$
DECLARE
    v_mode TEXT := pg_catalog.current_setting(
        'supabase.retirement_verifier_mode', TRUE
    );
BEGIN
    IF v_mode IS DISTINCT FROM 'preflight'
       AND v_mode IS DISTINCT FROM 'postapply' THEN
        RAISE EXCEPTION 'RETIREMENT_VERIFIER_MODE_REQUIRED';
    END IF;
END;
$verifier_mode_guard$;

CREATE TEMP TABLE pg_temp.retirement_verifier_output (
    report JSONB NOT NULL
) ON COMMIT DROP;

DO $verifier$
DECLARE
    v_mode TEXT := pg_catalog.current_setting(
        'supabase.retirement_verifier_mode', TRUE
    );
    v_public_table_count BIGINT;
    v_source_total BIGINT;
    v_source_mismatch_count BIGINT;
    v_canonical_count BIGINT;
    v_canonical_hash TEXT;
    v_canonical_conflict_count BIGINT;
    v_canonical_shape BOOLEAN;
    v_incoming_fk_count BIGINT := 0;
    v_dependent_view_count BIGINT := 0;
    v_routine_dependency_count BIGINT := 0;
    v_routine_identity_count BIGINT := 0;
    v_target_publication_count BIGINT := 0;
    v_all_table_publication_count BIGINT := 0;
    v_public_schema_publication_count BIGINT := 0;
    v_migration_occurrences BIGINT := 0;
    v_source_counts JSONB;
    v_target_absence_count BIGINT := 0;
    v_routine_absence_count BIGINT := 0;
BEGIN
    IF pg_catalog.to_regclass('public.maintenance_jobs') IS NULL THEN
        RAISE EXCEPTION 'RETIREMENT_VERIFIER_CANONICAL_MISSING';
    END IF;

    SELECT pg_catalog.count(*) INTO v_canonical_count
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
    SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg(
            (job.payload->'legacy_row')::TEXT,
            E'\n' ORDER BY (job.payload->'legacy_row')::TEXT
        ), ''), 'UTF8'
    )), 'hex') INTO v_canonical_hash
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

    SELECT pg_catalog.count(*) INTO v_canonical_conflict_count
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
    )
      AND (
          job.state IS DISTINCT FROM 'succeeded'
          OR job.payload IS NULL
          OR job.content_hash IS DISTINCT FROM pg_catalog.encode(
              pg_catalog.sha256(pg_catalog.convert_to(job.payload::TEXT, 'UTF8')),
              'hex'
          )
      );
    IF v_canonical_conflict_count <> 0 THEN
        RAISE EXCEPTION 'RETIREMENT_VERIFIER_CANONICAL_CONFLICT: exact legacy canonical rows must be succeeded with matching content_hash';
    END IF;

    SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation_row
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relname = 'maintenance_jobs'
          AND relation_row.relkind = 'r'
          AND (
              SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(
                  attribute.attname,
                  pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                  attribute.attnotnull
              ) ORDER BY attribute.attnum)
              FROM pg_catalog.pg_attribute AS attribute
              WHERE attribute.attrelid = relation_row.oid
                AND attribute.attnum > 0
                AND NOT attribute.attisdropped
          ) = '[
              ["id", "uuid", true],
              ["kind", "text", true],
              ["target_key_hash", "text", true],
              ["state", "text", true],
              ["attempt_count", "smallint", true],
              ["lease_generation", "bigint", true],
              ["lease_token", "uuid", false],
              ["lease_holder_hash", "text", false],
              ["lease_expires_at", "timestamp with time zone", false],
              ["next_attempt_at", "timestamp with time zone", true],
              ["terminal_at", "timestamp with time zone", false],
              ["last_error_code", "text", false],
              ["payload", "jsonb", true],
              ["content_hash", "text", true],
              ["created_at", "timestamp with time zone", true],
              ["updated_at", "timestamp with time zone", true]
          ]'::JSONB
    ) INTO v_canonical_shape;

    IF v_mode = 'preflight' THEN
        SELECT pg_catalog.count(*) INTO v_public_table_count
        FROM pg_catalog.pg_class AS relation_row
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relkind IN ('r', 'p');

        SELECT pg_catalog.jsonb_build_array(
            pg_catalog.jsonb_build_object('table', 'earlybird_concierge_batch_target_lineage_repairs', 'count', (SELECT pg_catalog.count(*) FROM public.earlybird_concierge_batch_target_lineage_repairs), 'expected', 3),
            pg_catalog.jsonb_build_object('table', 'earlybird_partial_adoption_second_rearms', 'count', (SELECT pg_catalog.count(*) FROM public.earlybird_partial_adoption_second_rearms), 'expected', 1),
            pg_catalog.jsonb_build_object('table', 'earlybird_profile_evidence_failure_recoveries', 'count', (SELECT pg_catalog.count(*) FROM public.earlybird_profile_evidence_failure_recoveries), 'expected', 2),
            pg_catalog.jsonb_build_object('table', 'earlybird_v211_apify_transient_admission_resumes', 'count', (SELECT pg_catalog.count(*) FROM public.earlybird_v211_apify_transient_admission_resumes), 'expected', 1),
            pg_catalog.jsonb_build_object('table', 'earlybird_v211_concierge_copy_corrections', 'count', (SELECT pg_catalog.count(*) FROM public.earlybird_v211_concierge_copy_corrections), 'expected', 1),
            pg_catalog.jsonb_build_object('table', 'earlybird_v212_concierge_copy_corrections', 'count', (SELECT pg_catalog.count(*) FROM public.earlybird_v212_concierge_copy_corrections), 'expected', 1),
            pg_catalog.jsonb_build_object('table', 'earlybird_v213_concierge_copy_corrections', 'count', (SELECT pg_catalog.count(*) FROM public.earlybird_v213_concierge_copy_corrections), 'expected', 1),
            pg_catalog.jsonb_build_object('table', 'earlybird_v214_concierge_gemini_copy_corrections', 'count', (SELECT pg_catalog.count(*) FROM public.earlybird_v214_concierge_gemini_copy_corrections), 'expected', 1)
        ) INTO v_source_counts;

        SELECT COALESCE(pg_catalog.sum(actual_count)::BIGINT, 0::BIGINT),
               COALESCE(pg_catalog.sum(
                   CASE WHEN actual_count <> expected_count THEN 1 ELSE 0 END
               )::BIGINT, 0::BIGINT)
          INTO v_source_total, v_source_mismatch_count
        FROM (
            SELECT pg_catalog.count(*) AS actual_count, 3::BIGINT AS expected_count
            FROM public.earlybird_concierge_batch_target_lineage_repairs
            UNION ALL
            SELECT pg_catalog.count(*), 1::BIGINT
            FROM public.earlybird_partial_adoption_second_rearms
            UNION ALL
            SELECT pg_catalog.count(*), 2::BIGINT
            FROM public.earlybird_profile_evidence_failure_recoveries
            UNION ALL
            SELECT pg_catalog.count(*), 1::BIGINT
            FROM public.earlybird_v211_apify_transient_admission_resumes
            UNION ALL
            SELECT pg_catalog.count(*), 1::BIGINT
            FROM public.earlybird_v211_concierge_copy_corrections
            UNION ALL
            SELECT pg_catalog.count(*), 1::BIGINT
            FROM public.earlybird_v212_concierge_copy_corrections
            UNION ALL
            SELECT pg_catalog.count(*), 1::BIGINT
            FROM public.earlybird_v213_concierge_copy_corrections
            UNION ALL
            SELECT pg_catalog.count(*), 1::BIGINT
            FROM public.earlybird_v214_concierge_gemini_copy_corrections
        ) AS source_contract;
        IF v_public_table_count <> 185
           OR v_source_total <> 11
           OR v_source_mismatch_count <> 0
           OR NOT v_canonical_shape THEN
            RAISE EXCEPTION 'RETIREMENT_VERIFIER_PREFLIGHT_SOURCE_MISMATCH';
        END IF;
        IF v_canonical_count <> 0 THEN
            RAISE EXCEPTION 'RETIREMENT_VERIFIER_PREFLIGHT_CANONICAL_MISMATCH: expected zero exact legacy canonical rows, found %', v_canonical_count;
        END IF;

        SELECT pg_catalog.count(*) INTO v_incoming_fk_count
        FROM pg_catalog.pg_constraint AS fk
        JOIN pg_catalog.pg_class AS parent_table ON parent_table.oid = fk.confrelid
        JOIN pg_catalog.pg_namespace AS parent_schema ON parent_schema.oid = parent_table.relnamespace
        WHERE fk.contype = 'f'
          AND parent_schema.nspname = 'public'
          AND parent_table.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          );
        SELECT pg_catalog.count(*) INTO v_dependent_view_count
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_rewrite AS rewrite_row ON rewrite_row.oid = dependency.objid
        JOIN pg_catalog.pg_class AS target_table ON target_table.oid = dependency.refobjid
        JOIN pg_catalog.pg_namespace AS target_schema ON target_schema.oid = target_table.relnamespace
        WHERE dependency.classid = 'pg_catalog.pg_rewrite'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND target_schema.nspname = 'public'
          AND target_table.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          );
        SELECT pg_catalog.count(*) INTO v_routine_dependency_count
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_proc AS dependent_routine ON dependent_routine.oid = dependency.objid
        JOIN pg_catalog.pg_class AS target_table ON target_table.oid = dependency.refobjid
        JOIN pg_catalog.pg_namespace AS target_schema ON target_schema.oid = target_table.relnamespace
        WHERE dependency.classid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND target_schema.nspname = 'public'
          AND target_table.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          );

        SELECT pg_catalog.count(*) INTO v_routine_identity_count
        FROM (VALUES
            ('public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()', ''),
            ('public.reconcile_exact_three_concierge_target_lineage(text)', 'p_expected_allowlist_hash text'),
            ('public.prevent_earlybird_partial_adoption_second_rearm_mutation()', ''),
            ('public.rearm_earlybird_partial_adoption_second_failure(uuid,uuid,timestamp with time zone)', 'p_order_id uuid, p_expected_failed_request_id uuid, p_expected_manual_review_at timestamp with time zone'),
            ('public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)', 'p_order_id uuid, p_expected_failed_request_id uuid, p_expected_manual_review_at timestamp with time zone'),
            ('public.resume_earlybird_v211_apify_transient_admission(uuid,timestamp with time zone)', 'p_order_id uuid, p_expected_manual_review_at timestamp with time zone'),
            ('public.prevent_earlybird_v211_concierge_copy_correction_mutation()', ''),
            ('public.correct_earlybird_v211_concierge_copy(uuid,uuid,uuid,text,text,text,jsonb)', 'p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_correction_result_hash text, p_copy_payload jsonb'),
            ('public.prevent_earlybird_v212_concierge_copy_correction_mutation()', ''),
            ('public.correct_earlybird_v212_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)', 'p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_correction_result_hash text, p_copy_payload jsonb'),
            ('public.prevent_earlybird_v213_concierge_copy_correction_mutation()', ''),
            ('public.correct_earlybird_v213_concierge_copy(uuid,uuid,uuid,text,text,text,text,jsonb)', 'p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_correction_result_hash text, p_copy_payload jsonb'),
            ('public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()', ''),
            ('public.correct_earlybird_v214_concierge_gemini_copy(uuid,uuid,uuid,text,text,text,jsonb,text,jsonb)', 'p_order_id uuid, p_owner_id uuid, p_result_request_id uuid, p_source_fingerprint text, p_expected_published_result_hash text, p_prior_correction_result_hash text, p_expected_v213_fact_snapshot jsonb, p_correction_result_hash text, p_copy_payload jsonb')
        ) AS expected(signature_text, identity_arguments)
        WHERE pg_catalog.to_regprocedure(expected.signature_text) IS NOT NULL
          AND pg_catalog.pg_get_function_identity_arguments(
              pg_catalog.to_regprocedure(expected.signature_text)::OID
          ) = expected.identity_arguments;

        SELECT pg_catalog.count(*) INTO v_all_table_publication_count
        FROM pg_catalog.pg_publication
        WHERE puballtables;
        SELECT pg_catalog.count(*) INTO v_public_schema_publication_count
        FROM pg_catalog.pg_publication_namespace AS publication_schema
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = publication_schema.pnnspid
        WHERE target_schema.nspname = 'public';
        SELECT pg_catalog.count(*) INTO v_target_publication_count
        FROM pg_catalog.pg_publication_rel AS publication_table
        JOIN pg_catalog.pg_class AS target_table ON target_table.oid = publication_table.prrelid
        JOIN pg_catalog.pg_namespace AS target_schema ON target_schema.oid = target_table.relnamespace
        WHERE target_schema.nspname = 'public'
          AND target_table.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          );

        IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
            SELECT pg_catalog.count(*) INTO v_migration_occurrences
            FROM supabase_migrations.schema_migrations
            WHERE version = '20260911001903';
        END IF;

        IF v_incoming_fk_count <> 0
           OR v_dependent_view_count <> 0
           OR v_routine_dependency_count <> 0
           OR v_routine_identity_count <> 14
           OR v_all_table_publication_count <> 0
           OR v_public_schema_publication_count <> 0
           OR v_target_publication_count <> 0
           OR v_migration_occurrences <> 0 THEN
            RAISE EXCEPTION 'RETIREMENT_VERIFIER_PREFLIGHT_CATALOG_MISMATCH';
        END IF;

        INSERT INTO pg_temp.retirement_verifier_output(report)
        VALUES (pg_catalog.jsonb_build_object(
            'mode', v_mode,
            'publicBasePartitionedTableCount', v_public_table_count,
            'sourceCounts', v_source_counts,
            'sourceCountTotal', v_source_total,
            'canonicalRowCount', v_canonical_count,
            'canonicalShapeVerified', v_canonical_shape,
            'incomingForeignKeys', v_incoming_fk_count,
            'dependentViews', v_dependent_view_count,
            'routineDependencies', v_routine_dependency_count,
            'routineIdentitiesVerified', v_routine_identity_count,
            'allTablePublications', v_all_table_publication_count,
            'publicSchemaPublications', v_public_schema_publication_count,
            'targetPublicationMemberships', v_target_publication_count,
            'migrationHistoryOccurrences', v_migration_occurrences,
            'canonicalAggregateSha256', v_canonical_hash
        ));
    ELSE
        SELECT pg_catalog.count(*) INTO v_public_table_count
        FROM pg_catalog.pg_class AS relation_row
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relkind IN ('r', 'p');

        SELECT pg_catalog.count(*) INTO v_target_absence_count
        FROM (VALUES
            ('earlybird_concierge_batch_target_lineage_repairs'),
            ('earlybird_partial_adoption_second_rearms'),
            ('earlybird_profile_evidence_failure_recoveries'),
            ('earlybird_v211_apify_transient_admission_resumes'),
            ('earlybird_v211_concierge_copy_corrections'),
            ('earlybird_v212_concierge_copy_corrections'),
            ('earlybird_v213_concierge_copy_corrections'),
            ('earlybird_v214_concierge_gemini_copy_corrections')
        ) AS expected(table_name)
        WHERE pg_catalog.to_regclass('public.' || expected.table_name) IS NULL;
        SELECT pg_catalog.count(*) INTO v_routine_absence_count
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
        WHERE pg_catalog.to_regprocedure(expected.signature_text) IS NULL;

        SELECT pg_catalog.count(*) INTO v_all_table_publication_count
        FROM pg_catalog.pg_publication
        WHERE puballtables;
        SELECT pg_catalog.count(*) INTO v_public_schema_publication_count
        FROM pg_catalog.pg_publication_namespace AS publication_schema
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = publication_schema.pnnspid
        WHERE target_schema.nspname = 'public';
        SELECT pg_catalog.count(*) INTO v_target_publication_count
        FROM pg_catalog.pg_publication_rel AS publication_table
        JOIN pg_catalog.pg_class AS target_table ON target_table.oid = publication_table.prrelid
        JOIN pg_catalog.pg_namespace AS target_schema ON target_schema.oid = target_table.relnamespace
        WHERE target_schema.nspname = 'public'
          AND target_table.relname IN (
              'earlybird_concierge_batch_target_lineage_repairs',
              'earlybird_partial_adoption_second_rearms',
              'earlybird_profile_evidence_failure_recoveries',
              'earlybird_v211_apify_transient_admission_resumes',
              'earlybird_v211_concierge_copy_corrections',
              'earlybird_v212_concierge_copy_corrections',
              'earlybird_v213_concierge_copy_corrections',
              'earlybird_v214_concierge_gemini_copy_corrections'
          );

        IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
            SELECT pg_catalog.count(*) INTO v_migration_occurrences
            FROM supabase_migrations.schema_migrations
            WHERE version = '20260911001903';
        END IF;

        IF v_public_table_count <> 177
           OR v_target_absence_count <> 8
           OR v_routine_absence_count <> 14
           OR v_canonical_count <> 11
           OR NOT v_canonical_shape
           OR v_all_table_publication_count <> 0
           OR v_public_schema_publication_count <> 0
           OR v_target_publication_count <> 0
           OR v_migration_occurrences <> 1 THEN
            RAISE EXCEPTION 'RETIREMENT_VERIFIER_POSTAPPLY_MISMATCH';
        END IF;

        INSERT INTO pg_temp.retirement_verifier_output(report)
        VALUES (pg_catalog.jsonb_build_object(
            'mode', v_mode,
            'publicBasePartitionedTableCount', v_public_table_count,
            'expectedFinalPublicBasePartitionedTableCount', 177,
            'targetTablesAbsent', v_target_absence_count,
            'expectedTargetTableAbsence', 8,
            'orphanedRoutinesAbsent', v_routine_absence_count,
            'expectedOrphanedRoutineAbsence', 14,
            'canonicalRowCount', v_canonical_count,
            'expectedCanonicalRowCount', 11,
            'canonicalShapeVerified', v_canonical_shape,
            'canonicalAggregateSha256', v_canonical_hash,
            'allTablePublications', v_all_table_publication_count,
            'publicSchemaPublications', v_public_schema_publication_count,
            'targetPublicationMemberships', v_target_publication_count,
            'migrationHistoryOccurrences', v_migration_occurrences
        ));
    END IF;
END;
$verifier$;

SELECT report FROM pg_temp.retirement_verifier_output;
ROLLBACK;
