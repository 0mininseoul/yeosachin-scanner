-- Read-only coordinator evidence for the 20260912 three-table retirement.
-- Run once before and once after the reviewed migration and compare the full
-- JSON object.  It emits only aggregate counts, status maps, OIDs, ACLs,
-- routine contract hashes, owner/security/configuration fields, and booleans.
-- It does not lock, update, or otherwise coordinate unrelated payment work.

BEGIN READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout = '2min';

DO $retirement_evidence_presence_guard$
DECLARE
    v_pending_analysis OID;
    v_wrapper_count BIGINT;
BEGIN
    v_pending_analysis := pg_catalog.to_regclass('public.pending_analysis');
    IF v_pending_analysis IS NULL THEN
        RAISE EXCEPTION 'RETIREMENT_EVIDENCE_PENDING_ANALYSIS_MISSING';
    END IF;

    WITH expected(signature_text) AS (
        SELECT *
        FROM (VALUES
            ('public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
            ('public.finalize_earlybird_groble_payment_reconciliation_aware(uuid,boolean,text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
            ('public.finalize_earlybird_groble_payment(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
            ('public.finalize_earlybird_groble_payment_by_reference(text,text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
            ('public.finalize_earlybird_groble_payment(text,text,text,timestamp with time zone,text,text,text,integer,timestamp with time zone)'),
            ('public.finalize_earlybird_groble_payment_refund_aware(uuid,boolean,text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)')
        ) AS expected_signatures(signature_text)
    )
    SELECT pg_catalog.count(*)
      INTO v_wrapper_count
    FROM expected
    JOIN pg_catalog.pg_proc AS routine_row
      ON routine_row.oid = pg_catalog.to_regprocedure(expected.signature_text)::OID;
    IF v_wrapper_count <> 6 THEN
        RAISE EXCEPTION 'RETIREMENT_EVIDENCE_PAYMENT_WRAPPER_SET';
    END IF;
END;
$retirement_evidence_presence_guard$;

WITH pending_status AS (
    SELECT pending.status::TEXT AS status, pg_catalog.count(*)::BIGINT AS row_count
    FROM public.pending_analysis AS pending
    GROUP BY pending.status
), pending_rows AS (
    SELECT pending.id::TEXT AS id_text, pending.status::TEXT AS status
    FROM public.pending_analysis AS pending
), pending_fingerprint AS (
    SELECT
        (SELECT pg_catalog.count(*)::BIGINT FROM pending_rows) AS row_count,
        COALESCE((
            SELECT pg_catalog.jsonb_object_agg(status, row_count ORDER BY status)
            FROM pending_status
        ), '{}'::JSONB) AS status_counts,
        pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
            COALESCE((
                SELECT pg_catalog.string_agg(id_text || ':' || status, E'\n' ORDER BY id_text)
                FROM pending_rows
            ), ''),
            'UTF8'
        )), 'hex') AS key_status_hash
), payment_wrappers AS (
    SELECT expected.signature_text,
           routine_row.oid::BIGINT AS routine_oid,
           pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
               pg_catalog.pg_get_functiondef(routine_row.oid), 'UTF8'
           )), 'hex') AS definition_hash,
           COALESCE(routine_row.proacl::TEXT, '<null>') AS acl,
           routine_row.proowner::REGROLE::TEXT AS owner_role,
           routine_row.prosecdef AS security_definer,
           COALESCE(routine_row.proconfig::TEXT, '<null>') AS configuration
    FROM (VALUES
        ('public.finalize_earlybird_groble_payment_pre_reconciliation(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
        ('public.finalize_earlybird_groble_payment_reconciliation_aware(uuid,boolean,text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
        ('public.finalize_earlybird_groble_payment(text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
        ('public.finalize_earlybird_groble_payment_by_reference(text,text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)'),
        ('public.finalize_earlybird_groble_payment(text,text,text,timestamp with time zone,text,text,text,integer,timestamp with time zone)'),
        ('public.finalize_earlybird_groble_payment_refund_aware(uuid,boolean,text,text,text,timestamp with time zone,text,text,text,text,text,text,integer,timestamp with time zone)')
    ) AS expected(signature_text)
    JOIN pg_catalog.pg_proc AS routine_row
      ON routine_row.oid = pg_catalog.to_regprocedure(expected.signature_text)::OID
), retired_routines AS (
    SELECT expected.signature_text,
           pg_catalog.to_regprocedure(expected.signature_text)::OID AS routine_oid
    FROM (VALUES
        ('public.list_analysis_v2_historical_legacy_dispatch_candidates(integer)'),
        ('public.resolve_analysis_v2_historical_legacy_dispatch(uuid,text,text,text,text,integer,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone,text,text,smallint,text,smallint,uuid,timestamp with time zone,text,text,text,text)'),
        ('public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()')
    ) AS expected(signature_text)
)
SELECT pg_catalog.jsonb_build_object(
    'pending_analysis', pg_catalog.jsonb_build_object(
        'row_count', pending.row_count,
        'status_counts', pending.status_counts,
        'key_status_hash', pending.key_status_hash
    ),
    'payment_wrappers', COALESCE((
        SELECT pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'signature', wrapper.signature_text,
                'routine_oid', wrapper.routine_oid,
                'definition_hash', wrapper.definition_hash,
                'acl', wrapper.acl,
                'owner_role', wrapper.owner_role,
                'security_definer', wrapper.security_definer,
                'configuration', wrapper.configuration
            ) ORDER BY wrapper.signature_text
        )
        FROM payment_wrappers AS wrapper
    ), '[]'::JSONB),
    'canonical_archive', pg_catalog.jsonb_build_object(
        'row_count', (
            SELECT pg_catalog.count(*)
            FROM public.maintenance_jobs AS job
            WHERE job.kind = 'terminalize'
              AND job.payload->>'legacy_source_table'
                  = 'analysis_v2_historical_legacy_dispatch_terminalization_receipts'
              AND job.payload->>'schema_version' = '1'
        ),
        'legacy_row_hash', (
            SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                COALESCE(pg_catalog.string_agg(
                    (job.payload->'legacy_row')::TEXT,
                    E'\n' ORDER BY (job.payload->'legacy_row')::TEXT
                ), ''),
                'UTF8'
            )), 'hex')
            FROM public.maintenance_jobs AS job
            WHERE job.kind = 'terminalize'
              AND job.payload->>'legacy_source_table'
                  = 'analysis_v2_historical_legacy_dispatch_terminalization_receipts'
              AND job.payload->>'schema_version' = '1'
        )
    ),
    'retired_routines_present', (
        SELECT pg_catalog.count(*)
        FROM retired_routines
        WHERE routine_oid IS NOT NULL
    ),
    'public_base_partitioned_table_count', (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.pg_class AS relation_row
        JOIN pg_catalog.pg_namespace AS relation_schema
          ON relation_schema.oid = relation_row.relnamespace
        WHERE relation_schema.nspname = 'public'
          AND relation_row.relkind IN ('r', 'p')
    ),
    'migration_history_occurrences', (
        SELECT pg_catalog.count(*)
        FROM supabase_migrations.schema_migrations AS migration_row
        WHERE migration_row.version = '20260912070144'
    ),
    'retirement_targets', pg_catalog.jsonb_build_object(
        'historical_receipts_present', pg_catalog.to_regclass(
            'public.analysis_v2_historical_legacy_dispatch_terminalization_receipts'
        ) IS NOT NULL,
        'payment_orders_present', pg_catalog.to_regclass('public.payment_orders') IS NOT NULL,
        'payments_present', pg_catalog.to_regclass('public.payments') IS NOT NULL
    )
) AS sanitized_rollout_fingerprint
FROM pending_fingerprint AS pending;

ROLLBACK;
