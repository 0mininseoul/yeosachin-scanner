-- Supabase 22 pending-input retirement.
-- Preserve the exact legacy rows in the existing server-only canonical ledger,
-- then retire only public.pending_analysis.  The archived source status remains
-- awaiting_payment; succeeded below means archive operation completed only.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';

-- Serialize this one-shot slice after the sibling 20260912070144 migration.
SELECT pg_catalog.pg_advisory_xact_lock(22091212, 23);

-- Do not compete with a concurrent function/procedure/publication DDL change.
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
                              'active',
                              'idle in transaction',
                              'idle in transaction (aborted)'
                          )
                          AND normalized.normalized_query ~* $retirement_ddl_pattern$(?x)
                              (
                                  (CREATE[[:space:]]+OR[[:space:]]+REPLACE|CREATE|ALTER|DROP)
                                  [[:space:]]+(FUNCTION|PROCEDURE|ROUTINE)
                                | (CREATE|ALTER|DROP)[[:space:]]+PUBLICATION
                              )
                          $retirement_ddl_pattern$
                      )
                  )
              )
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_ACTIVE_DDL';
    END IF;
END;
$retirement_active_ddl_guard$;

-- Capture exact relation identities before locking.  Same-name replacement is
-- rejected after the lock so this transaction cannot archive a moving target.
DO $retirement_relation_guard$
DECLARE
    v_oid OID;
BEGIN
    SELECT relation_row.oid INTO v_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'maintenance_jobs'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.maintenance_jobs';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_maintenance_jobs_oid', v_oid::TEXT, true);

    SELECT relation_row.oid INTO v_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'pending_analysis'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.pending_analysis';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_pending_analysis_oid', v_oid::TEXT, true);
END;
$retirement_relation_guard$;

-- This migration is ordered after the three-table sibling, which changes the
-- reviewed 177-table baseline to 174 before this exact one-table reduction.
DO $retirement_baseline_guard$
DECLARE
    v_public_table_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_public_table_count
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p');
    IF v_public_table_count <> 174 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLIC_TABLE_COUNT: expected 174, found %',
            v_public_table_count;
    END IF;
END;
$retirement_baseline_guard$;

LOCK TABLE public.maintenance_jobs, public.pending_analysis IN ACCESS EXCLUSIVE MODE;

DO $retirement_relation_revalidation_guard$
DECLARE
    v_oid OID;
    v_relkind "char";
BEGIN
    SELECT relation_row.oid, relation_row.relkind INTO v_oid, v_relkind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'maintenance_jobs';
    IF NOT FOUND OR v_relkind <> 'r'
       OR v_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting(
           'retirement.expected_maintenance_jobs_oid', true
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.maintenance_jobs';
    END IF;

    SELECT relation_row.oid, relation_row.relkind INTO v_oid, v_relkind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'pending_analysis';
    IF NOT FOUND OR v_relkind <> 'r'
       OR v_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting(
           'retirement.expected_pending_analysis_oid', true
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.pending_analysis';
    END IF;
END;
$retirement_relation_revalidation_guard$;

DO $retirement_catalog_guard$
DECLARE
    v_source_columns TEXT[];
    v_source_primary_key TEXT[];
    v_maintenance_columns TEXT[];
    v_maintenance_primary_key TEXT[];
    v_source_acl TEXT;
    v_maintenance_acl TEXT;
BEGIN
    SELECT pg_catalog.array_agg(
        pg_catalog.format(
            '%s:%s:%s',
            attribute_row.attname,
            pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod),
            CASE WHEN attribute_row.attnotnull THEN 'true' ELSE 'false' END
        ) ORDER BY attribute_row.attnum
    ) INTO v_source_columns
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid = pg_catalog.to_regclass('public.pending_analysis')
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped;
    IF v_source_columns IS DISTINCT FROM ARRAY[
        'id:uuid:true',
        'user_id:uuid:true',
        'target_instagram_id:text:true',
        'target_gender:text:true',
        'plan_type:text:true',
        'status:text:true',
        'polar_checkout_id:text:false',
        'created_at:timestamp with time zone:false',
        'updated_at:timestamp with time zone:false'
    ]::TEXT[] THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_SHAPE';
    END IF;

    SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY key_columns.ordinality)
      INTO v_source_primary_key
    FROM pg_catalog.pg_index AS index_row
    CROSS JOIN LATERAL pg_catalog.unnest(index_row.indkey)
        WITH ORDINALITY AS key_columns(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute_row
      ON attribute_row.attrelid = index_row.indrelid
     AND attribute_row.attnum = key_columns.attnum
    WHERE index_row.indrelid = pg_catalog.to_regclass('public.pending_analysis')
      AND index_row.indisprimary;
    IF v_source_primary_key IS DISTINCT FROM ARRAY['id']::TEXT[] THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PRIMARY_KEY';
    END IF;

    SELECT pg_catalog.array_agg(
        pg_catalog.format(
            '%s:%s:%s',
            attribute_row.attname,
            pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod),
            CASE WHEN attribute_row.attnotnull THEN 'true' ELSE 'false' END
        ) ORDER BY attribute_row.attnum
    ) INTO v_maintenance_columns
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid = pg_catalog.to_regclass('public.maintenance_jobs')
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped;
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
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_SHAPE';
    END IF;

    SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY key_columns.ordinality)
      INTO v_maintenance_primary_key
    FROM pg_catalog.pg_index AS index_row
    CROSS JOIN LATERAL pg_catalog.unnest(index_row.indkey)
        WITH ORDINALITY AS key_columns(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute_row
      ON attribute_row.attrelid = index_row.indrelid
     AND attribute_row.attnum = key_columns.attnum
    WHERE index_row.indrelid = pg_catalog.to_regclass('public.maintenance_jobs')
      AND index_row.indisprimary;
    IF v_maintenance_primary_key IS DISTINCT FROM ARRAY['id']::TEXT[] THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_PRIMARY_KEY';
    END IF;

    SELECT COALESCE(relation_row.relacl::TEXT, '<null>') INTO v_source_acl
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = pg_catalog.to_regclass('public.pending_analysis');
    IF v_source_acl IS DISTINCT FROM
       '{postgres=arwdDxtm/postgres,anon=arwdDxtm/postgres,authenticated=arwdDxtm/postgres,service_role=arwdDxtm/postgres}' THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_ACL';
    END IF;

    SELECT COALESCE(relation_row.relacl::TEXT, '<null>') INTO v_maintenance_acl
    FROM pg_catalog.pg_class AS relation_row
    WHERE relation_row.oid = pg_catalog.to_regclass('public.maintenance_jobs');
    IF v_maintenance_acl IS DISTINCT FROM '{postgres=arwdDxtm/postgres}' THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_ACL';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation_row
        WHERE relation_row.oid = pg_catalog.to_regclass('public.pending_analysis')
          AND relation_row.relrowsecurity
          AND NOT relation_row.relforcerowsecurity
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_RLS';
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS relation_row
        WHERE relation_row.oid = pg_catalog.to_regclass('public.maintenance_jobs')
          AND relation_row.relrowsecurity
          AND relation_row.relforcerowsecurity
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_RLS';
    END IF;

    IF (
        SELECT count(*)
        FROM pg_catalog.pg_policy AS policy_row
        WHERE policy_row.polrelid = pg_catalog.to_regclass('public.pending_analysis')
    ) <> 2
       OR NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_policy AS policy_row
           WHERE policy_row.polrelid = pg_catalog.to_regclass('public.pending_analysis')
             AND policy_row.polname = 'Users can create own pending analysis'
             AND policy_row.polcmd = 'a'
             AND policy_row.polroles = ARRAY[0::OID]
             AND policy_row.polqual IS NULL
             AND pg_catalog.pg_get_expr(policy_row.polwithcheck, policy_row.polrelid)
                 = '(auth.uid() = user_id)'
       )
       OR NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_policy AS policy_row
           WHERE policy_row.polrelid = pg_catalog.to_regclass('public.pending_analysis')
             AND policy_row.polname = 'Users can view own pending analysis'
             AND policy_row.polcmd = 'r'
             AND policy_row.polroles = ARRAY[0::OID]
             AND policy_row.polwithcheck IS NULL
             AND pg_catalog.pg_get_expr(policy_row.polqual, policy_row.polrelid)
                 = '(auth.uid() = user_id)'
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_POLICY_SHAPE';
    END IF;

    IF (
        SELECT count(*)
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE trigger_row.tgrelid = pg_catalog.to_regclass('public.pending_analysis')
          AND NOT trigger_row.tgisinternal
    ) <> 0 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_TRIGGER';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.contype = 'f'
          AND constraint_row.confrelid = pg_catalog.to_regclass('public.pending_analysis')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_INCOMING_FOREIGN_KEY';
    END IF;
    IF (
        SELECT count(*)
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.contype = 'f'
          AND constraint_row.conrelid = pg_catalog.to_regclass('public.pending_analysis')
    ) <> 1
       OR NOT EXISTS (
           SELECT 1
           FROM pg_catalog.pg_constraint AS constraint_row
           WHERE constraint_row.contype = 'f'
             AND constraint_row.conrelid = pg_catalog.to_regclass('public.pending_analysis')
             AND constraint_row.conname = 'pending_analysis_user_id_fkey'
             AND constraint_row.confrelid = 'auth.users'::REGCLASS
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_OUTGOING_FOREIGN_KEY';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency_row
        WHERE dependency_row.classid = 'pg_catalog.pg_rewrite'::REGCLASS
          AND dependency_row.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND dependency_row.refobjid = pg_catalog.to_regclass('public.pending_analysis')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_DEPENDENT_VIEW';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency_row
        WHERE dependency_row.classid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency_row.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND dependency_row.refobjid = pg_catalog.to_regclass('public.pending_analysis')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_DEPENDENT_ROUTINE';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS routine_row
        JOIN pg_catalog.pg_namespace AS routine_schema
          ON routine_schema.oid = routine_row.pronamespace
        WHERE routine_schema.nspname NOT IN ('pg_catalog', 'information_schema')
          AND routine_row.prokind IN ('f', 'p')
          AND pg_catalog.pg_get_functiondef(routine_row.oid) ILIKE '%pending_analysis%'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_BODY_REFERENCE';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS view_row
        JOIN pg_catalog.pg_namespace AS view_schema
          ON view_schema.oid = view_row.relnamespace
        WHERE view_schema.nspname NOT IN ('pg_catalog', 'information_schema')
          AND view_row.relkind IN ('v', 'm')
          AND pg_catalog.pg_get_viewdef(view_row.oid, TRUE) ILIKE '%pending_analysis%'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_VIEW_BODY_REFERENCE';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_namespace AS publication_schema
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = publication_schema.pnnspid
        WHERE target_schema.nspname = 'public'
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_rel AS publication_table
        WHERE publication_table.prrelid = pg_catalog.to_regclass('public.pending_analysis')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLICATION_DEPENDENCY';
    END IF;
END;
$retirement_catalog_guard$;

-- Extend the canonical ledger only after validating its reviewed 16-column
-- predecessor shape.  The typed reference is populated solely for this
-- pending archive cohort; every unrelated maintenance row remains NULL.
ALTER TABLE public.maintenance_jobs
    ADD COLUMN legacy_pending_user_id UUID,
    ADD CONSTRAINT maintenance_jobs_pending_archive_user_fk_check
    CHECK (
        (
            legacy_pending_user_id IS NULL
            AND (
                kind = 'audit_assembly'
                AND state = 'succeeded'
                AND payload->>'archive_operation' = 'pending_analysis_retirement'
                AND payload->>'legacy_source_table' = 'pending_analysis'
            ) IS NOT TRUE
        )
        OR (
            legacy_pending_user_id IS NOT NULL
            AND (
                kind = 'audit_assembly'
                AND state = 'succeeded'
                AND payload->>'archive_operation' = 'pending_analysis_retirement'
                AND payload->>'legacy_source_table' = 'pending_analysis'
            ) IS TRUE
            AND payload->'legacy_row'->>'user_id'
                IS NOT DISTINCT FROM legacy_pending_user_id::TEXT
        )
    ),
    ADD CONSTRAINT maintenance_jobs_legacy_pending_user_id_fkey
        FOREIGN KEY (legacy_pending_user_id)
        REFERENCES auth.users(id)
        ON DELETE CASCADE;

CREATE INDEX maintenance_jobs_legacy_pending_user_id_idx
    ON public.maintenance_jobs(legacy_pending_user_id)
    WHERE legacy_pending_user_id IS NOT NULL;

DO $retirement_source_guard$
DECLARE
    v_count BIGINT;
    v_awaiting_payment_count BIGINT;
    v_checkout_reference_count BIGINT;
    v_distinct_id_count BIGINT;
    v_created_outside_window BIGINT;
    v_updated_outside_window BIGINT;
    v_created_null_count BIGINT;
    v_updated_null_count BIGINT;
    v_created_date_min DATE;
    v_created_date_max DATE;
    v_updated_date_min DATE;
    v_updated_date_max DATE;
    v_source_hash TEXT;
BEGIN
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE source_row.status = 'awaiting_payment'),
        pg_catalog.count(*) FILTER (WHERE source_row.polar_checkout_id IS NOT NULL),
        pg_catalog.count(DISTINCT source_row.id),
        pg_catalog.count(*) FILTER (
            WHERE source_row.created_at IS NULL
               OR source_row.created_at < TIMESTAMPTZ '2026-01-29 00:00:00+00'
               OR source_row.created_at >= TIMESTAMPTZ '2026-02-04 00:00:00+00'
        ),
        pg_catalog.count(*) FILTER (
            WHERE source_row.updated_at IS NULL
               OR source_row.updated_at < TIMESTAMPTZ '2026-01-29 00:00:00+00'
               OR source_row.updated_at >= TIMESTAMPTZ '2026-02-04 00:00:00+00'
        ),
        pg_catalog.count(*) FILTER (WHERE source_row.created_at IS NULL),
        pg_catalog.count(*) FILTER (WHERE source_row.updated_at IS NULL),
        pg_catalog.min((source_row.created_at AT TIME ZONE 'UTC')::DATE),
        pg_catalog.max((source_row.created_at AT TIME ZONE 'UTC')::DATE),
        pg_catalog.min((source_row.updated_at AT TIME ZONE 'UTC')::DATE),
        pg_catalog.max((source_row.updated_at AT TIME ZONE 'UTC')::DATE),
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            COALESCE(
                pg_catalog.string_agg(
                    (pg_catalog.to_jsonb(source_row))::TEXT,
                    E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT
                ),
                ''
            ),
            'UTF8'
        )), 'hex')
    INTO v_count, v_awaiting_payment_count, v_checkout_reference_count,
         v_distinct_id_count, v_created_outside_window, v_updated_outside_window,
         v_created_null_count, v_updated_null_count, v_created_date_min,
         v_created_date_max, v_updated_date_min, v_updated_date_max, v_source_hash
    FROM public.pending_analysis AS source_row;

    IF v_count <> 11
       OR v_awaiting_payment_count <> 11
       OR v_checkout_reference_count <> 0
       OR v_distinct_id_count <> 11
       OR v_created_outside_window <> 0
       OR v_updated_outside_window <> 0
       OR v_created_null_count <> 0
       OR v_updated_null_count <> 0
       OR v_created_date_min IS DISTINCT FROM DATE '2026-01-29'
       OR v_created_date_max IS DISTINCT FROM DATE '2026-02-03'
       OR v_updated_date_min IS DISTINCT FROM DATE '2026-01-29'
       OR v_updated_date_max IS DISTINCT FROM DATE '2026-02-03'
       OR v_source_hash IS DISTINCT FROM 'e7298026824e8f78487aa2b7335277b36c908ee94d1792bba20fd0d1dd4f959b' THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_EVIDENCE_MISMATCH';
    END IF;
END;
$retirement_source_guard$;

CREATE TEMP TABLE pg_temp.pending_analysis_archive_expected (
    kind TEXT NOT NULL,
    target_key_hash TEXT NOT NULL,
    payload JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    legacy_pending_user_id UUID NOT NULL,
    PRIMARY KEY (kind, target_key_hash)
) ON COMMIT DROP;

-- The complete typed row is stored under legacy_row.  In particular, the
-- archived awaiting_payment status and nullable checkout/timestamp fields are
-- copied without interpretation or normalization.
INSERT INTO pg_temp.pending_analysis_archive_expected (
    kind, target_key_hash, payload, content_hash, legacy_pending_user_id
)
WITH incoming AS (
    SELECT
        'audit_assembly'::TEXT AS kind,
        source_row.user_id AS legacy_pending_user_id,
        pg_catalog.jsonb_build_object(
            'archive_operation', 'pending_analysis_retirement',
            'archive_state_semantics', 'completed_archive_operation_only',
            'legacy_source_table', 'pending_analysis',
            'legacy_primary_key', pg_catalog.jsonb_build_object('id', source_row.id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'no_work_enqueued', TRUE,
            'payment_state_mutated', FALSE,
            'schema_version', 1
        ) AS payload
    FROM public.pending_analysis AS source_row
), prepared AS (
    SELECT
        kind,
        legacy_pending_user_id,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-public-retirement-v1:' || kind || ':pending_analysis:'
                || (payload->'legacy_primary_key')::TEXT,
            'UTF8'
        )), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex')
            AS content_hash
    FROM incoming
)
SELECT kind, target_key_hash, payload, content_hash, legacy_pending_user_id
FROM prepared;

-- Idempotent re-entry is allowed only for an exact archive row.  Any other
-- row using this source marker is a conflict, not evidence to overwrite.
DO $retirement_canonical_conflict_guard$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.maintenance_jobs AS actual
        WHERE actual.payload->>'legacy_source_table' = 'pending_analysis'
          AND NOT EXISTS (
              SELECT 1
              FROM pg_temp.pending_analysis_archive_expected AS expected
              WHERE expected.kind = actual.kind
                AND expected.target_key_hash = actual.target_key_hash
                AND actual.state = 'succeeded'
                AND actual.payload IS NOT DISTINCT FROM expected.payload
                AND actual.content_hash IS NOT DISTINCT FROM expected.content_hash
                AND actual.legacy_pending_user_id
                    IS NOT DISTINCT FROM expected.legacy_pending_user_id
          )
    ) OR EXISTS (
        SELECT 1
        FROM pg_temp.pending_analysis_archive_expected AS expected
        JOIN public.maintenance_jobs AS actual
          ON actual.kind = expected.kind
         AND actual.target_key_hash = expected.target_key_hash
        WHERE actual.state IS DISTINCT FROM 'succeeded'
           OR actual.payload IS DISTINCT FROM expected.payload
           OR actual.content_hash IS DISTINCT FROM expected.content_hash
           OR actual.legacy_pending_user_id
                IS DISTINCT FROM expected.legacy_pending_user_id
    ) THEN
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT';
    END IF;
END;
$retirement_canonical_conflict_guard$;

-- Succeeded is a terminal archive fact; claim_maintenance_jobs_v1 only takes
-- queued/retryable rows, so this insert cannot enqueue work.
INSERT INTO public.maintenance_jobs AS maintenance_job (
    kind, target_key_hash, state, payload, content_hash, legacy_pending_user_id
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash,
       legacy_pending_user_id
FROM pg_temp.pending_analysis_archive_expected
ON CONFLICT (kind, target_key_hash) DO NOTHING;

DO $retirement_parity_guard$
DECLARE
    v_source_count BIGINT;
    v_canonical_count BIGINT;
    v_source_hash TEXT;
    v_canonical_hash TEXT;
BEGIN
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(
            pg_catalog.string_agg(
                (pg_catalog.to_jsonb(source_row))::TEXT,
                E'\n' ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT
            ),
            ''
        ),
        'UTF8'
    )), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.pending_analysis AS source_row;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(
            pg_catalog.string_agg(
                (job_row.payload->'legacy_row')::TEXT,
                E'\n' ORDER BY (job_row.payload->'legacy_row')::TEXT
            ),
            ''
        ),
        'UTF8'
    )), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job_row
    WHERE job_row.kind = 'audit_assembly'
      AND job_row.state = 'succeeded'
      AND job_row.payload->>'legacy_source_table' = 'pending_analysis';

    IF v_source_count <> 11
       OR v_canonical_count <> 11
       OR v_source_hash IS DISTINCT FROM v_canonical_hash
       OR v_source_hash IS DISTINCT FROM
          'e7298026824e8f78487aa2b7335277b36c908ee94d1792bba20fd0d1dd4f959b' THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_PARITY';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.pending_analysis AS source_row
        LEFT JOIN public.maintenance_jobs AS job_row
          ON job_row.kind = 'audit_assembly'
         AND job_row.target_key_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              'supabase-22-public-retirement-v1:audit_assembly:pending_analysis:'
              || pg_catalog.jsonb_build_object('id', source_row.id)::TEXT,
              'UTF8'
         )), 'hex')
        WHERE job_row.id IS NULL
           OR job_row.state IS DISTINCT FROM 'succeeded'
           OR job_row.payload->>'legacy_source_table' IS DISTINCT FROM 'pending_analysis'
           OR job_row.payload->'legacy_primary_key'
                 IS DISTINCT FROM pg_catalog.jsonb_build_object('id', source_row.id)
           OR job_row.payload->'legacy_row' IS DISTINCT FROM pg_catalog.to_jsonb(source_row)
           OR job_row.payload->>'schema_version' IS DISTINCT FROM '1'
           OR job_row.payload->>'archive_state_semantics'
                 IS DISTINCT FROM 'completed_archive_operation_only'
           OR job_row.payload->>'payment_state_mutated' IS DISTINCT FROM 'false'
           OR job_row.payload->>'no_work_enqueued' IS DISTINCT FROM 'true'
           OR job_row.content_hash IS DISTINCT FROM pg_catalog.encode(
                pg_catalog.sha256(pg_catalog.convert_to(job_row.payload::TEXT, 'UTF8')),
                'hex'
           )
           OR job_row.legacy_pending_user_id IS DISTINCT FROM source_row.user_id
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_FULL_ROW_PARITY';
    END IF;
END;
$retirement_parity_guard$;

-- Recheck the narrow dependency boundary immediately before destructive DDL.
DO $retirement_final_dependency_guard$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.contype = 'f'
          AND constraint_row.confrelid = pg_catalog.to_regclass('public.pending_analysis')
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency_row
        WHERE dependency_row.classid IN (
                  'pg_catalog.pg_rewrite'::REGCLASS,
                  'pg_catalog.pg_proc'::REGCLASS
              )
          AND dependency_row.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND dependency_row.refobjid = pg_catalog.to_regclass('public.pending_analysis')
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS routine_row
        JOIN pg_catalog.pg_namespace AS routine_schema
          ON routine_schema.oid = routine_row.pronamespace
        WHERE routine_schema.nspname NOT IN ('pg_catalog', 'information_schema')
          AND routine_row.prokind IN ('f', 'p')
          AND pg_catalog.pg_get_functiondef(routine_row.oid) ILIKE '%pending_analysis%'
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_class AS view_row
        JOIN pg_catalog.pg_namespace AS view_schema
          ON view_schema.oid = view_row.relnamespace
        WHERE view_schema.nspname NOT IN ('pg_catalog', 'information_schema')
          AND view_row.relkind IN ('v', 'm')
          AND pg_catalog.pg_get_viewdef(view_row.oid, TRUE) ILIKE '%pending_analysis%'
    ) OR EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_namespace AS publication_schema
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = publication_schema.pnnspid
        WHERE target_schema.nspname = 'public'
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_rel AS publication_table
        WHERE publication_table.prrelid = pg_catalog.to_regclass('public.pending_analysis')
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_DEPENDENCY_CHANGED';
    END IF;
END;
$retirement_final_dependency_guard$;

-- Explicit non-CASCADE drop: source-owned indexes, policies and its outgoing
-- FK disappear with this exact relation; no other table or business row does.
DROP TABLE public.pending_analysis;

DO $retirement_terminal_guard$
DECLARE
    v_public_table_count BIGINT;
    v_canonical_count BIGINT;
    v_typed_pending_user_count BIGINT;
BEGIN
    IF pg_catalog.to_regclass('public.pending_analysis') IS NOT NULL THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TARGET_REMAINS';
    END IF;
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE job_row.legacy_pending_user_id IS NOT NULL)
      INTO v_canonical_count, v_typed_pending_user_count
    FROM public.maintenance_jobs AS job_row
    WHERE job_row.kind = 'audit_assembly'
      AND job_row.state = 'succeeded'
      AND job_row.payload->>'legacy_source_table' = 'pending_analysis';
    IF v_canonical_count <> 11 OR v_typed_pending_user_count <> 11 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_TOTAL';
    END IF;
    SELECT pg_catalog.count(*) INTO v_public_table_count
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relkind IN ('r', 'p');
    IF v_public_table_count <> 173 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLIC_TABLE_COUNT: expected 173, found %',
            v_public_table_count;
    END IF;
END;
$retirement_terminal_guard$;

COMMIT;
