-- Supabase 22 retirement wave: one historical receipt ledger plus two empty,
-- server-only payment relations.  No analysis runtime relation is included.
-- Historical receipt rows are preserved in the existing maintenance_jobs
-- canonical ledger before the exact source relation is removed.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

SELECT pg_catalog.pg_advisory_xact_lock(22091212, 22);

-- A concurrent function/publication DDL session could invalidate the reviewed
-- dependency evidence.  Abort rather than attempt a moving target.
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

DO $retirement_relation_guard$
DECLARE
    v_oid OID;
BEGIN
    SELECT c.oid INTO v_oid
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'maintenance_jobs'
      AND c.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.maintenance_jobs';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_maintenance_jobs_oid', v_oid::TEXT, true);

    SELECT c.oid INTO v_oid
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'analysis_v2_historical_legacy_dispatch_terminalization_receipts'
      AND c.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.analysis_v2_historical_legacy_dispatch_terminalization_receipts';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_analysis_legacy_receipts_oid', v_oid::TEXT, true);

    SELECT c.oid INTO v_oid
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'payment_orders'
      AND c.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.payment_orders';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_payment_orders_oid', v_oid::TEXT, true);

    SELECT c.oid INTO v_oid
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'payments'
      AND c.relkind = 'r';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_MISSING: public.payments';
    END IF;
    PERFORM pg_catalog.set_config('retirement.expected_payments_oid', v_oid::TEXT, true);
END;
$retirement_relation_guard$;

DO $retirement_baseline_guard$
DECLARE
    v_public_table_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_public_table_count
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
    IF v_public_table_count <> 177 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLIC_TABLE_COUNT: expected 177, found %',
            v_public_table_count;
    END IF;
END;
$retirement_baseline_guard$;

-- These are the only source relations locked by this migration.  The exact
-- names are repeated so lock scope cannot widen through caller input.
LOCK TABLE public.maintenance_jobs,
    public.analysis_v2_historical_legacy_dispatch_terminalization_receipts,
    public.payment_orders,
    public.payments
    IN ACCESS EXCLUSIVE MODE;

DO $retirement_relation_revalidation_guard$
DECLARE
    v_table_name TEXT;
    v_expected_setting TEXT;
    v_oid OID;
    v_relkind "char";
BEGIN
    FOREACH v_table_name IN ARRAY ARRAY[
        'maintenance_jobs',
        'analysis_v2_historical_legacy_dispatch_terminalization_receipts',
        'payment_orders',
        'payments'
    ] LOOP
        SELECT c.oid, c.relkind INTO v_oid, v_relkind
        FROM pg_catalog.pg_class AS c
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = v_table_name;
        v_expected_setting := CASE v_table_name
            WHEN 'maintenance_jobs' THEN 'retirement.expected_maintenance_jobs_oid'
            WHEN 'analysis_v2_historical_legacy_dispatch_terminalization_receipts' THEN 'retirement.expected_analysis_legacy_receipts_oid'
            WHEN 'payment_orders' THEN 'retirement.expected_payment_orders_oid'
            WHEN 'payments' THEN 'retirement.expected_payments_oid'
        END;
        IF NOT FOUND OR v_relkind <> 'r'
           OR v_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting(v_expected_setting, true) THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_TABLE_REPLACED: public.%', v_table_name;
        END IF;
    END LOOP;
END;
$retirement_relation_revalidation_guard$;

DO $retirement_catalog_guard$
DECLARE
    v_table_name TEXT;
    v_expected_columns TEXT[];
    v_actual_columns TEXT[];
    v_expected_primary_key TEXT[];
    v_actual_primary_key TEXT[];
    v_maintenance_columns TEXT[];
BEGIN
    SELECT pg_catalog.array_agg(
        pg_catalog.format(
            '%s:%s:%s',
            a.attname,
            pg_catalog.format_type(a.atttypid, a.atttypmod),
            CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END
        ) ORDER BY a.attnum
    ) INTO v_maintenance_columns
    FROM pg_catalog.pg_attribute AS a
    JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'maintenance_jobs'
      AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped;
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

    FOREACH v_table_name IN ARRAY ARRAY[
        'analysis_v2_historical_legacy_dispatch_terminalization_receipts',
        'payment_orders',
        'payments'
    ] LOOP
        v_expected_columns := CASE v_table_name
            WHEN 'analysis_v2_historical_legacy_dispatch_terminalization_receipts' THEN ARRAY[
                'receipt_id:uuid:true',
                'request_id:uuid:true',
                'job_key:character varying(160):true',
                'input_hash:character varying(64):true',
                'prior_status:character varying(16):true',
                'prior_dispatch_state:character varying(16):true',
                'prior_dispatch_generation:integer:true',
                'prior_dispatch_reservation_token:uuid:true',
                'prior_dispatch_reserved_at:timestamp with time zone:true',
                'prior_dispatched_at:timestamp with time zone:true',
                'prior_delivered_at:timestamp with time zone:true',
                'prior_dispatch_task_name:character varying(512):true',
                'prior_dispatch_workload_role:text:false',
                'prior_dispatch_contract_version:smallint:false',
                'prior_claim_workload_role:text:false',
                'prior_claim_contract_version:smallint:false',
                'prior_lease_token:uuid:false',
                'prior_lease_expires_at:timestamp with time zone:false',
                'manual_resolution_operation_key:character varying(87):false',
                'manual_resolution_evidence_hash:character varying(64):false',
                'terminal_status:character varying(16):true',
                'error_code:character varying(64):true',
                'audit_evidence_hash:character varying(64):true',
                'resolved_at:timestamp with time zone:true',
                'created_at:timestamp with time zone:true'
            ]
            WHEN 'payment_orders' THEN ARRAY[
                'id:uuid:true',
                'polar_order_id:text:true',
                'customer_email:text:false',
                'amount:integer:true',
                'currency:text:true',
                'status:text:true',
                'metadata:jsonb:false',
                'created_at:timestamp with time zone:false'
            ]
            WHEN 'payments' THEN ARRAY[
                'id:uuid:true',
                'user_id:uuid:true',
                'result_id:uuid:false',
                'payment_key:character varying(200):false',
                'order_id:character varying(100):true',
                'amount:integer:true',
                'currency:character varying(10):false',
                'product_type:character varying(20):true',
                'status:character varying(20):false',
                'created_at:timestamp with time zone:false',
                'completed_at:timestamp with time zone:false'
            ]
        END;
        v_expected_primary_key := CASE v_table_name
            WHEN 'analysis_v2_historical_legacy_dispatch_terminalization_receipts' THEN ARRAY['receipt_id']
            ELSE ARRAY['id']
        END;

        SELECT pg_catalog.array_agg(
            pg_catalog.format(
                '%s:%s:%s',
                a.attname,
                pg_catalog.format_type(a.atttypid, a.atttypmod),
                CASE WHEN a.attnotnull THEN 'true' ELSE 'false' END
            ) ORDER BY a.attnum
        ) INTO v_actual_columns
        FROM pg_catalog.pg_attribute AS a
        JOIN pg_catalog.pg_class AS c ON c.oid = a.attrelid
        JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relname = v_table_name
          AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped;
        IF v_actual_columns IS DISTINCT FROM v_expected_columns THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_SHAPE: public.%', v_table_name;
        END IF;

        SELECT pg_catalog.array_agg(a.attname ORDER BY key_columns.ordinality)
          INTO v_actual_primary_key
        FROM pg_catalog.pg_index AS idx
        CROSS JOIN LATERAL pg_catalog.unnest(idx.indkey)
            WITH ORDINALITY AS key_columns(attnum, ordinality)
        JOIN pg_catalog.pg_attribute AS a
          ON a.attrelid = idx.indrelid AND a.attnum = key_columns.attnum
        WHERE idx.indrelid = pg_catalog.to_regclass('public.' || v_table_name)
          AND idx.indisprimary;
        IF v_actual_primary_key IS DISTINCT FROM v_expected_primary_key THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_PRIMARY_KEY: public.%', v_table_name;
        END IF;
    END LOOP;

    -- Incoming FKs/views/routine dependencies are unsafe. Outgoing source FKs
    -- are historical ownership and disappear with their source table.
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS fk
        WHERE fk.contype = 'f'
          AND fk.confrelid IN (
              'public.analysis_v2_historical_legacy_dispatch_terminalization_receipts'::REGCLASS,
              'public.payment_orders'::REGCLASS,
              'public.payments'::REGCLASS
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_INCOMING_FOREIGN_KEY';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        WHERE dependency.classid = 'pg_catalog.pg_rewrite'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND dependency.refobjid IN (
              'public.analysis_v2_historical_legacy_dispatch_terminalization_receipts'::REGCLASS,
              'public.payment_orders'::REGCLASS,
              'public.payments'::REGCLASS
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_DEPENDENT_VIEW';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_proc AS dependent_routine
          ON dependent_routine.oid = dependency.objid
        WHERE dependency.classid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_class'::REGCLASS
          AND dependency.refobjid IN (
              'public.analysis_v2_historical_legacy_dispatch_terminalization_receipts'::REGCLASS,
              'public.payment_orders'::REGCLASS,
              'public.payments'::REGCLASS
          )
          AND dependent_routine.oid NOT IN (
              pg_catalog.to_regprocedure('public.list_analysis_v2_historical_legacy_dispatch_candidates(integer)'),
              pg_catalog.to_regprocedure('public.resolve_analysis_v2_historical_legacy_dispatch(uuid,text,text,text,text,integer,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,smallint,text,smallint,uuid,timestamp with time zone,text,text,text,text)'),
              pg_catalog.to_regprocedure('public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)')
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_RETAINED_ROUTINE_DEPENDENCY';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication AS publication_row
        WHERE publication_row.puballtables
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_namespace AS publication_schema
        JOIN pg_catalog.pg_namespace AS target_schema
          ON target_schema.oid = publication_schema.pnnspid
        WHERE target_schema.nspname = 'public'
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_rel AS publication_table
        WHERE publication_table.prrelid IN (
            'public.analysis_v2_historical_legacy_dispatch_terminalization_receipts'::REGCLASS,
            'public.payment_orders'::REGCLASS,
            'public.payments'::REGCLASS
        )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLICATION_DEPENDENCY';
    END IF;
END;
$retirement_catalog_guard$;

DO $retirement_routine_guard$
DECLARE
    v_signature TEXT;
    v_oid OID;
    v_index INTEGER := 0;
    v_preserved_definition_hash TEXT;
    v_preserved_acl TEXT;
BEGIN
    -- The payment pre-reconciliation implementation is intentionally kept:
    -- the reconciliation-aware wrapper invokes this owner-only routine. Its
    -- definition and ACL are hashed here and rechecked around the table drop.
    FOREACH v_signature IN ARRAY ARRAY[
        'public.list_analysis_v2_historical_legacy_dispatch_candidates(integer)',
        'public.resolve_analysis_v2_historical_legacy_dispatch(uuid,text,text,text,text,integer,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,smallint,text,smallint,uuid,timestamp with time zone,text,text,text,text)',
        'public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)',
        'public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()'
    ] LOOP
        v_index := v_index + 1;
        v_oid := pg_catalog.to_regprocedure(v_signature);
        IF v_oid IS NULL THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_MISSING: %', v_signature;
        END IF;
        PERFORM pg_catalog.set_config(
            'retirement.expected_routine_' || pg_catalog.lpad(v_index::TEXT, 2, '0') || '_oid',
            v_oid::TEXT,
            true
        );
    END LOOP;

    v_oid := pg_catalog.to_regprocedure(
        'public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'
    );
    SELECT
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(v_oid), 'UTF8'
        )), 'hex'),
        COALESCE(routine_row.proacl::TEXT, '<null>')
      INTO v_preserved_definition_hash, v_preserved_acl
    FROM pg_catalog.pg_proc AS routine_row
    WHERE routine_row.oid = v_oid;
    PERFORM pg_catalog.set_config(
        'retirement.preserved_payment_routine_definition_hash',
        v_preserved_definition_hash,
        true
    );
    PERFORM pg_catalog.set_config(
        'retirement.preserved_payment_routine_acl',
        v_preserved_acl,
        true
    );

    IF (
        SELECT count(*)
        FROM pg_catalog.pg_trigger AS trigger_row
        WHERE NOT trigger_row.tgisinternal
          AND trigger_row.tgfoid = pg_catalog.to_regprocedure(
              'public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()'
          )
    ) <> 1 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TRIGGER_OWNERSHIP';
    END IF;
END;
$retirement_routine_guard$;

-- A routine caller that is not in this literal retirement allowlist would make
-- dropping the old receipt/payment objects unsafe. Dynamic SQL callers are
-- caught by the definition scan below; local app/ops callers are recorded in
-- the companion report and the historical terminalizer is retired there.
DO $retirement_routine_caller_guard$
BEGIN
    IF EXISTS (
        WITH expected AS (
            SELECT pg_catalog.to_regprocedure(signature_text)::OID AS routine_oid
            FROM (VALUES
                ('public.list_analysis_v2_historical_legacy_dispatch_candidates(integer)'),
                ('public.resolve_analysis_v2_historical_legacy_dispatch(uuid,text,text,text,text,integer,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,smallint,text,smallint,uuid,timestamp with time zone,text,text,text,text)'),
                ('public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
                ('public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()')
            ) AS expected_signatures(signature_text)
        )
        SELECT 1
        FROM pg_catalog.pg_depend AS dependency
        JOIN pg_catalog.pg_proc AS caller ON caller.oid = dependency.objid
        WHERE dependency.classid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refclassid = 'pg_catalog.pg_proc'::REGCLASS
          AND dependency.refobjid IN (SELECT routine_oid FROM expected)
          AND caller.oid NOT IN (SELECT routine_oid FROM expected)
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_RETAINED_ROUTINE_CALLER';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS caller
        JOIN pg_catalog.pg_namespace AS n ON n.oid = caller.pronamespace
        WHERE n.nspname = 'public'
          AND caller.prokind IN ('f', 'p')
          AND caller.oid NOT IN (
              pg_catalog.to_regprocedure('public.list_analysis_v2_historical_legacy_dispatch_candidates(integer)'),
              pg_catalog.to_regprocedure('public.resolve_analysis_v2_historical_legacy_dispatch(uuid,text,text,text,text,integer,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,smallint,text,smallint,uuid,timestamp with time zone,text,text,text,text)'),
              pg_catalog.to_regprocedure('public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
              pg_catalog.to_regprocedure('public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()')
          )
          AND (
              pg_catalog.strpos(
                  pg_catalog.pg_get_functiondef(caller.oid),
                  'analysis_v2_historical_legacy_dispatch_terminalization_receipts'
              ) > 0
              OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(caller.oid), 'payment_orders') > 0
              OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(caller.oid), 'payments') > 0
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_RETAINED_ROUTINE_DEFINITION_REFERENCE';
    END IF;
END;
$retirement_routine_caller_guard$;

DO $retirement_source_count_guard$
DECLARE
    v_count BIGINT;
BEGIN
    SELECT pg_catalog.count(*) INTO v_count
    FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts;
    IF v_count <> 5 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_SOURCE_COUNT: historical receipts expected 5, found %', v_count;
    END IF;

    SELECT pg_catalog.count(*) INTO v_count FROM public.payment_orders;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_NONEMPTY: public.payment_orders';
    END IF;
    SELECT pg_catalog.count(*) INTO v_count FROM public.payments;
    IF v_count <> 0 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_NONEMPTY: public.payments';
    END IF;

    IF (
        SELECT count(DISTINCT receipt_id)
        FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts
    ) <> 5 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PRIMARY_KEY_MULTIPLICITY';
    END IF;
END;
$retirement_source_count_guard$;

CREATE TEMP TABLE pg_temp.retirement_expected_canonical_rows (
    source_table TEXT NOT NULL,
    kind TEXT NOT NULL,
    target_key_hash TEXT NOT NULL,
    payload JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (kind, target_key_hash)
) ON COMMIT DROP;

-- The complete typed source row is retained as JSONB.  The stable receipt_id
-- primary key is copied separately so multiplicity and restore identity are
-- unambiguous.  Hash input is domain-separated by retirement contract/kind/
-- source table/key to avoid collisions with unrelated maintenance work.
INSERT INTO pg_temp.retirement_expected_canonical_rows (
    source_table, kind, target_key_hash, payload, content_hash
)
WITH incoming AS (
    SELECT
        'analysis_v2_historical_legacy_dispatch_terminalization_receipts'::TEXT AS source_table,
        'terminalize'::TEXT AS kind,
        pg_catalog.jsonb_build_object(
            'legacy_source_table', 'analysis_v2_historical_legacy_dispatch_terminalization_receipts',
            'legacy_primary_key', pg_catalog.jsonb_build_object('receipt_id', source_row.receipt_id),
            'legacy_row', pg_catalog.to_jsonb(source_row),
            'schema_version', 1
        ) AS payload
    FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts AS source_row
), prepared AS (
    SELECT source_table, kind,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            'supabase-22-public-retirement-v1:' || kind || ':' || source_table || ':'
                || (payload->'legacy_primary_key')::TEXT,
            'UTF8'
        )), 'hex') AS target_key_hash,
        payload,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(payload::TEXT, 'UTF8')), 'hex') AS content_hash
    FROM incoming
)
SELECT source_table, kind, target_key_hash, payload, content_hash
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
        RAISE EXCEPTION 'MAINTENANCE_CONTENT_CONFLICT';
    END IF;
END;
$retirement_canonical_conflict_guard$;

INSERT INTO public.maintenance_jobs AS maintenance(
    kind, target_key_hash, state, payload, content_hash
)
SELECT kind, target_key_hash, 'succeeded', payload, content_hash
FROM pg_temp.retirement_expected_canonical_rows
ON CONFLICT (kind, target_key_hash) DO NOTHING;

-- Verify exact row equality and deterministic aggregate parity before any
-- destructive statement.  Both tests run inside this transaction.
DO $retirement_parity_guard$
DECLARE
    v_source_count BIGINT;
    v_canonical_count BIGINT;
    v_source_hash TEXT;
    v_canonical_hash TEXT;
BEGIN
    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((pg_catalog.to_jsonb(source_row))::TEXT, E'\n'
            ORDER BY (pg_catalog.to_jsonb(source_row))::TEXT), ''), 'UTF8')), 'hex')
      INTO v_source_count, v_source_hash
    FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts AS source_row;

    SELECT pg_catalog.count(*), pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        COALESCE(pg_catalog.string_agg((job.payload->'legacy_row')::TEXT, E'\n'
            ORDER BY (job.payload->'legacy_row')::TEXT), ''), 'UTF8')), 'hex')
      INTO v_canonical_count, v_canonical_hash
    FROM public.maintenance_jobs AS job
    WHERE job.kind = 'terminalize'
      AND job.payload->>'legacy_source_table'
          = 'analysis_v2_historical_legacy_dispatch_terminalization_receipts';

    IF v_source_count <> 5 OR v_canonical_count <> v_source_count
       OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_PARITY';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_historical_legacy_dispatch_terminalization_receipts AS source_row
        LEFT JOIN public.maintenance_jobs AS job
          ON job.kind = 'terminalize'
         AND job.target_key_hash = pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
              'supabase-22-public-retirement-v1:terminalize:analysis_v2_historical_legacy_dispatch_terminalization_receipts:'
              || pg_catalog.jsonb_build_object('receipt_id', source_row.receipt_id)::TEXT,
              'UTF8'
         )), 'hex')
        WHERE job.id IS NULL
           OR job.payload->'legacy_primary_key'
                 IS DISTINCT FROM pg_catalog.jsonb_build_object('receipt_id', source_row.receipt_id)
           OR job.payload->'legacy_row' IS DISTINCT FROM pg_catalog.to_jsonb(source_row)
           OR job.payload->>'schema_version' IS DISTINCT FROM '1'
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_FULL_ROW_PARITY';
    END IF;
END;
$retirement_parity_guard$;

-- Revalidate routine identities immediately before destructive DDL.  A
-- same-signature drop/recreate after the evidence reads aborts the transaction.
DO $retirement_routine_revalidation_guard$
DECLARE
    v_signature TEXT;
    v_oid OID;
    v_index INTEGER := 0;
    v_definition_hash TEXT;
    v_acl TEXT;
BEGIN
    FOREACH v_signature IN ARRAY ARRAY[
        'public.list_analysis_v2_historical_legacy_dispatch_candidates(integer)',
        'public.resolve_analysis_v2_historical_legacy_dispatch(uuid,text,text,text,text,integer,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,smallint,text,smallint,uuid,timestamp with time zone,text,text,text,text)',
        'public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)',
        'public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()'
    ] LOOP
        v_index := v_index + 1;
        v_oid := pg_catalog.to_regprocedure(v_signature);
        IF v_oid IS NULL
           OR v_oid::TEXT IS DISTINCT FROM pg_catalog.current_setting(
               'retirement.expected_routine_' || pg_catalog.lpad(v_index::TEXT, 2, '0') || '_oid', true
           ) THEN
            RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_REPLACED';
        END IF;
    END LOOP;

    v_oid := pg_catalog.to_regprocedure(
        'public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'
    );
    SELECT
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(v_oid), 'UTF8'
        )), 'hex'),
        COALESCE(routine_row.proacl::TEXT, '<null>')
      INTO v_definition_hash, v_acl
    FROM pg_catalog.pg_proc AS routine_row
    WHERE routine_row.oid = v_oid;
    IF v_definition_hash IS DISTINCT FROM pg_catalog.current_setting(
           'retirement.preserved_payment_routine_definition_hash', true
       )
       OR v_acl IS DISTINCT FROM pg_catalog.current_setting(
           'retirement.preserved_payment_routine_acl', true
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PRESERVED_PAYMENT_ROUTINE_CHANGED';
    END IF;
END;
$retirement_routine_revalidation_guard$;

REVOKE ALL ON FUNCTION public.list_analysis_v2_historical_legacy_dispatch_candidates(INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_historical_legacy_dispatch(
    UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
    TEXT, TEXT, SMALLINT, TEXT, SMALLINT, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()
    FROM PUBLIC, anon, authenticated, service_role;

DROP FUNCTION public.list_analysis_v2_historical_legacy_dispatch_candidates(INTEGER);
DROP FUNCTION public.resolve_analysis_v2_historical_legacy_dispatch(
    UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, UUID, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ,
    TEXT, TEXT, SMALLINT, TEXT, SMALLINT, UUID, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT
);
-- The trigger is owned by the receipt relation and disappears with its exact
-- table.  Drop only the now-unreferenced guard routine after that table.
DROP TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts;
DROP FUNCTION public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability();

DROP TABLE public.payment_orders;
DROP TABLE public.payments;

DO $retirement_terminal_guard$
DECLARE
    v_public_table_count BIGINT;
    v_canonical_count BIGINT;
    v_preserved_definition_hash TEXT;
    v_preserved_acl TEXT;
BEGIN
    IF pg_catalog.to_regclass('public.analysis_v2_historical_legacy_dispatch_terminalization_receipts') IS NOT NULL
       OR pg_catalog.to_regclass('public.payment_orders') IS NOT NULL
       OR pg_catalog.to_regclass('public.payments') IS NOT NULL THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_TARGET_REMAINS';
    END IF;

    IF pg_catalog.to_regprocedure('public.list_analysis_v2_historical_legacy_dispatch_candidates(integer)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.resolve_analysis_v2_historical_legacy_dispatch(uuid,text,text,text,text,integer,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,smallint,text,smallint,uuid,timestamp with time zone,text,text,text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()') IS NOT NULL THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_ROUTINE_REMAINS';
    END IF;

    IF pg_catalog.to_regprocedure('public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)') IS NULL THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PRESERVED_PAYMENT_ROUTINE_MISSING';
    END IF;

    SELECT
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            pg_catalog.pg_get_functiondef(routine_row.oid), 'UTF8'
        )), 'hex'),
        COALESCE(routine_row.proacl::TEXT, '<null>')
      INTO v_preserved_definition_hash, v_preserved_acl
    FROM pg_catalog.pg_proc AS routine_row
    WHERE routine_row.oid = pg_catalog.to_regprocedure(
        'public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'
    );
    IF v_preserved_definition_hash IS DISTINCT FROM pg_catalog.current_setting(
           'retirement.preserved_payment_routine_definition_hash', true
       )
       OR v_preserved_acl IS DISTINCT FROM pg_catalog.current_setting(
           'retirement.preserved_payment_routine_acl', true
       ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PRESERVED_PAYMENT_ROUTINE_CHANGED';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_proc AS routine_row
        JOIN pg_catalog.pg_namespace AS routine_schema ON routine_schema.oid = routine_row.pronamespace
        WHERE routine_schema.nspname = 'public'
          AND routine_row.prokind IN ('f', 'p')
          AND routine_row.oid <> pg_catalog.to_regprocedure(
              'public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'
          )
          AND (
              pg_catalog.strpos(pg_catalog.pg_get_functiondef(routine_row.oid), 'analysis_v2_historical_legacy_dispatch_terminalization_receipts') > 0
              OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(routine_row.oid), 'payment_orders') > 0
              OR pg_catalog.strpos(pg_catalog.pg_get_functiondef(routine_row.oid), 'payments') > 0
          )
    ) THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_RETAINED_TABLE_REFERENCE';
    END IF;

    SELECT pg_catalog.count(*) INTO v_canonical_count
    FROM public.maintenance_jobs AS job
    WHERE job.kind = 'terminalize'
      AND job.payload->>'legacy_source_table'
          = 'analysis_v2_historical_legacy_dispatch_terminalization_receipts';
    IF v_canonical_count <> 5 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_CANONICAL_TOTAL';
    END IF;

    IF pg_catalog.to_regclass('public.pending_analysis') IS NULL THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_OUT_OF_SCOPE_TABLE_CHANGED';
    END IF;

    SELECT pg_catalog.count(*) INTO v_public_table_count
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p');
    IF v_public_table_count <> 174 THEN
        RAISE EXCEPTION 'RETIREMENT_GUARD_PUBLIC_TABLE_COUNT: expected 174, found %',
            v_public_table_count;
    END IF;
END;
$retirement_terminal_guard$;

COMMIT;
