-- Isolated restore operation for the pending_analysis retirement migration.
--
-- Run only in a disposable database after:
--   SET supabase.retirement_isolated = 'true';
--
-- This operation never deletes or rewrites public.maintenance_jobs rows.  The
-- disposable database must already contain auth.users for the archived FK.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';
SET LOCAL TIME ZONE 'UTC';

DO $restore_relation_guard$
DECLARE
    v_oid OID;
BEGIN
    IF pg_catalog.current_setting('supabase.retirement_isolated', TRUE)
        IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_ISOLATED_GUARD';
    END IF;

    SELECT relation_row.oid INTO v_oid
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'maintenance_jobs'
      AND relation_row.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_CANONICAL_MISSING';
    END IF;
    PERFORM pg_catalog.set_config('restore.expected_maintenance_jobs_oid', v_oid::TEXT, true);

    IF pg_catalog.to_regclass('public.pending_analysis') IS NOT NULL THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_TARGET_ALREADY_PRESENT';
    END IF;
    IF pg_catalog.to_regclass('auth.users') IS NULL THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_PARENT_MISSING';
    END IF;
END;
$restore_relation_guard$;

-- SHARE blocks concurrent canonical inserts while allowing this read-only
-- restore proof to copy the immutable archive.
LOCK TABLE public.maintenance_jobs IN SHARE MODE;

DO $restore_archive_guard$
DECLARE
    v_oid OID;
    v_relkind "char";
    v_count BIGINT;
    v_hash TEXT;
BEGIN
    SELECT relation_row.oid, relation_row.relkind INTO v_oid, v_relkind
    FROM pg_catalog.pg_class AS relation_row
    JOIN pg_catalog.pg_namespace AS relation_schema
      ON relation_schema.oid = relation_row.relnamespace
    WHERE relation_schema.nspname = 'public'
      AND relation_row.relname = 'maintenance_jobs';
    IF NOT FOUND OR v_relkind <> 'r'
       OR v_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting(
           'restore.expected_maintenance_jobs_oid', true
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_CANONICAL_REPLACED';
    END IF;

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
      INTO v_count, v_hash
    FROM public.maintenance_jobs AS job_row
    WHERE job_row.kind = 'audit_assembly'
      AND job_row.state = 'succeeded'
      AND job_row.payload->>'archive_operation' = 'pending_analysis_retirement'
      AND job_row.payload->>'archive_state_semantics'
          = 'completed_archive_operation_only'
      AND job_row.payload->>'legacy_source_table' = 'pending_analysis'
      AND job_row.payload->>'schema_version' = '1'
      AND job_row.payload->>'no_work_enqueued' = 'true'
      AND job_row.payload->>'payment_state_mutated' = 'false';
    IF v_count <> 11
       OR v_hash IS DISTINCT FROM
          'e7298026824e8f78487aa2b7335277b36c908ee94d1792bba20fd0d1dd4f959b' THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_ARCHIVE_EVIDENCE_MISMATCH';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.maintenance_jobs AS job_row
        WHERE job_row.payload->>'legacy_source_table' = 'pending_analysis'
          AND (
              job_row.kind IS DISTINCT FROM 'audit_assembly'
              OR job_row.state IS DISTINCT FROM 'succeeded'
              OR job_row.payload->>'archive_operation'
                    IS DISTINCT FROM 'pending_analysis_retirement'
              OR job_row.payload->>'archive_state_semantics'
                    IS DISTINCT FROM 'completed_archive_operation_only'
              OR job_row.payload->>'schema_version' IS DISTINCT FROM '1'
              OR job_row.payload->>'no_work_enqueued' IS DISTINCT FROM 'true'
              OR job_row.payload->>'payment_state_mutated' IS DISTINCT FROM 'false'
              OR jsonb_typeof(job_row.payload->'legacy_row') IS DISTINCT FROM 'object'
              OR (
                  SELECT count(*)
                  FROM jsonb_object_keys(job_row.payload->'legacy_row')
              ) <> 9
              OR NOT (job_row.payload->'legacy_row' ?& ARRAY[
                  'id', 'user_id', 'target_instagram_id', 'target_gender',
                  'plan_type', 'status', 'polar_checkout_id', 'created_at', 'updated_at'
              ])
              OR job_row.payload->'legacy_primary_key'
                    IS DISTINCT FROM jsonb_build_object(
                        'id', job_row.payload->'legacy_row'->'id'
                    )
              OR job_row.target_key_hash IS DISTINCT FROM pg_catalog.encode(
                  pg_catalog.sha256(pg_catalog.convert_to(
                      'supabase-22-public-retirement-v1:audit_assembly:pending_analysis:'
                      || (job_row.payload->'legacy_primary_key')::TEXT,
                      'UTF8'
                  )),
                  'hex'
              )
              OR job_row.content_hash IS DISTINCT FROM pg_catalog.encode(
                  pg_catalog.sha256(pg_catalog.convert_to(job_row.payload::TEXT, 'UTF8')),
                  'hex'
              )
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_ARCHIVE_CONTENT_MISMATCH';
    END IF;
END;
$restore_archive_guard$;

CREATE TABLE public.pending_analysis (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    target_instagram_id TEXT NOT NULL,
    target_gender TEXT NOT NULL,
    plan_type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_payment',
    polar_checkout_id TEXT,
    created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now(),
    CONSTRAINT pending_analysis_plan_type_check
        CHECK (plan_type = ANY (ARRAY['basic'::text, 'standard'::text])),
    CONSTRAINT pending_analysis_status_check
        CHECK (status = ANY (ARRAY[
            'awaiting_payment'::text, 'paid'::text, 'refunded'::text, 'expired'::text
        ])),
    CONSTRAINT pending_analysis_target_gender_check
        CHECK (target_gender = ANY (ARRAY['male'::text, 'female'::text]))
);

CREATE INDEX idx_pending_analysis_status
    ON public.pending_analysis(status);
CREATE INDEX idx_pending_analysis_user_id
    ON public.pending_analysis(user_id);

ALTER TABLE public.pending_analysis ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.pending_analysis FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.pending_analysis TO anon, authenticated, service_role;

CREATE POLICY "Users can create own pending analysis"
    ON public.pending_analysis
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can view own pending analysis"
    ON public.pending_analysis
    FOR SELECT
    USING (auth.uid() = user_id);

DO $restore_shape_guard$
DECLARE
    v_columns TEXT[];
    v_primary_key TEXT[];
BEGIN
    SELECT pg_catalog.array_agg(
        pg_catalog.format(
            '%s:%s:%s',
            attribute_row.attname,
            pg_catalog.format_type(attribute_row.atttypid, attribute_row.atttypmod),
            CASE WHEN attribute_row.attnotnull THEN 'true' ELSE 'false' END
        ) ORDER BY attribute_row.attnum
    ) INTO v_columns
    FROM pg_catalog.pg_attribute AS attribute_row
    WHERE attribute_row.attrelid = pg_catalog.to_regclass('public.pending_analysis')
      AND attribute_row.attnum > 0
      AND NOT attribute_row.attisdropped;
    IF v_columns IS DISTINCT FROM ARRAY[
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
        RAISE EXCEPTION 'RETIREMENT_RESTORE_SOURCE_SHAPE';
    END IF;

    SELECT pg_catalog.array_agg(attribute_row.attname ORDER BY key_columns.ordinality)
      INTO v_primary_key
    FROM pg_catalog.pg_index AS index_row
    CROSS JOIN LATERAL pg_catalog.unnest(index_row.indkey)
        WITH ORDINALITY AS key_columns(attnum, ordinality)
    JOIN pg_catalog.pg_attribute AS attribute_row
      ON attribute_row.attrelid = index_row.indrelid
     AND attribute_row.attnum = key_columns.attnum
    WHERE index_row.indrelid = pg_catalog.to_regclass('public.pending_analysis')
      AND index_row.indisprimary;
    IF v_primary_key IS DISTINCT FROM ARRAY['id']::TEXT[] THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_PRIMARY_KEY';
    END IF;
END;
$restore_shape_guard$;

INSERT INTO public.pending_analysis (
    id,
    user_id,
    target_instagram_id,
    target_gender,
    plan_type,
    status,
    polar_checkout_id,
    created_at,
    updated_at
)
SELECT
    (job_row.payload->'legacy_row'->>'id')::UUID,
    (job_row.payload->'legacy_row'->>'user_id')::UUID,
    job_row.payload->'legacy_row'->>'target_instagram_id',
    job_row.payload->'legacy_row'->>'target_gender',
    job_row.payload->'legacy_row'->>'plan_type',
    job_row.payload->'legacy_row'->>'status',
    job_row.payload->'legacy_row'->>'polar_checkout_id',
    (job_row.payload->'legacy_row'->>'created_at')::TIMESTAMPTZ,
    (job_row.payload->'legacy_row'->>'updated_at')::TIMESTAMPTZ
FROM public.maintenance_jobs AS job_row
WHERE job_row.kind = 'audit_assembly'
  AND job_row.state = 'succeeded'
  AND job_row.payload->>'archive_operation' = 'pending_analysis_retirement'
  AND job_row.payload->>'legacy_source_table' = 'pending_analysis';

DO $restore_parity_guard$
DECLARE
    v_source_count BIGINT;
    v_source_hash TEXT;
    v_awaiting_payment_count BIGINT;
    v_checkout_reference_count BIGINT;
    v_distinct_id_count BIGINT;
BEGIN
    SELECT
        pg_catalog.count(*),
        pg_catalog.count(*) FILTER (WHERE source_row.status = 'awaiting_payment'),
        pg_catalog.count(*) FILTER (WHERE source_row.polar_checkout_id IS NOT NULL),
        pg_catalog.count(DISTINCT source_row.id),
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
      INTO v_source_count, v_awaiting_payment_count, v_checkout_reference_count,
           v_distinct_id_count, v_source_hash
    FROM public.pending_analysis AS source_row;

    IF v_source_count <> 11
       OR v_awaiting_payment_count <> 11
       OR v_checkout_reference_count <> 0
       OR v_distinct_id_count <> 11
       OR v_source_hash IS DISTINCT FROM
          'e7298026824e8f78487aa2b7335277b36c908ee94d1792bba20fd0d1dd4f959b' THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_PARITY_MISMATCH';
    END IF;
END;
$restore_parity_guard$;

COMMIT;
