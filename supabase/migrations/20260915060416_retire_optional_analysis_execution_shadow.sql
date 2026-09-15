-- Retire optional execution mirrors, not the authoritative V2 pipeline/progress.
-- Apply only after writer removal or disabled live-revision flags are verified.
-- The 2026-09-15 owner-only public backup was restored in isolation; its rows
-- match the UTC/JSONB checksums below. Empty tables permit fresh local installs.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL TIME ZONE 'UTC';
SET LOCAL search_path = public, pg_catalog;

LOCK TABLE public.analysis_jobs, public.analysis_events IN ACCESS EXCLUSIVE MODE;

DO $guard$
DECLARE
    row_count bigint;
    row_digest text;
BEGIN
    SELECT count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY id), ''))
      INTO row_count, row_digest FROM public.analysis_jobs t;
    IF row_count <> 0 AND (row_count <> 19 OR row_digest <> 'bf40b27285d29fa2ea1281d2baa4ceaf') THEN
        RAISE EXCEPTION 'SHADOW_RETIREMENT_JOBS_BACKUP_DRIFT';
    END IF;
    SELECT count(*), md5(coalesce(string_agg(md5(to_jsonb(t)::text), '' ORDER BY id), ''))
      INTO row_count, row_digest FROM public.analysis_events t;
    IF row_count <> 0 AND (row_count <> 81 OR row_digest <> '64517e2ee8b31ff7f852f17c9d2d13c5') THEN
        RAISE EXCEPTION 'SHADOW_RETIREMENT_EVENTS_BACKUP_DRIFT';
    END IF;

    -- PostgreSQL does not track PL/pgSQL body dependencies. Refuse unexpected
    -- callers as well as using RESTRICT for catalog-tracked dependencies below.
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND p.prokind IN ('f', 'p')
          AND p.oid::regprocedure <> ALL (ARRAY[
              'public.record_analysis_canonical_job(uuid,text,text,text,bigint,integer,integer,timestamptz,timestamptz,text,jsonb,text)',
              'public.append_analysis_canonical_event(uuid,uuid,text,text,jsonb,text,text)',
              'public.enqueue_analysis_execution_retry_v1(uuid,text)',
              'public.load_analysis_execution_family_v1(uuid,text)',
              'public.reject_analysis_canonical_mutation()',
              'public.analysis_canonical_json_object_has_exact_keys(jsonb,text[])',
              'public.analysis_canonical_json_value_valid(jsonb)',
              'public.analysis_canonical_payload_valid(jsonb)',
              'public.analysis_canonical_payload_has_only_keys(jsonb,text[])',
              'public.analysis_execution_json_object_has_exact_keys_v1(jsonb,text[])',
              'public.analysis_execution_json_value_valid_v1(jsonb)',
              'public.analysis_execution_payload_valid_v1(jsonb)',
              'public.analysis_execution_payload_has_only_keys_v1(jsonb,text[])'
          ]::regprocedure[])
          AND pg_catalog.pg_get_functiondef(p.oid) ~ '\m(analysis_jobs|analysis_events|record_analysis_canonical_job|append_analysis_canonical_event|enqueue_analysis_execution_retry_v1|load_analysis_execution_family_v1|reject_analysis_canonical_mutation|analysis_canonical_json_object_has_exact_keys|analysis_canonical_json_value_valid|analysis_canonical_payload_valid|analysis_canonical_payload_has_only_keys|analysis_execution_json_object_has_exact_keys_v1|analysis_execution_json_value_valid_v1|analysis_execution_payload_valid_v1|analysis_execution_payload_has_only_keys_v1)\M'
    ) THEN
        RAISE EXCEPTION 'SHADOW_RETIREMENT_UNEXPECTED_ROUTINE_CALLER';
    END IF;

    -- The reviewed public EXECUTE inventory uses fixed V2 relations, a bounded
    -- V2-only table-name validator, a fixed child-table list, or digest fallback.
    -- Pin its exact definitions: new/split-string dynamic SQL must be reviewed,
    -- not assumed absent merely because a lexical reference scan is empty.
    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_proc p
        JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.prokind IN ('f', 'p')
          AND p.prosrc ~* '\mexecute\M'
          AND (p.oid::regprocedure::text, md5(pg_catalog.pg_get_functiondef(p.oid))) NOT IN (
              ('analysis_order_audit_source_table_hash(text,uuid)', '62725997999fc9a6d26c4596f875a3d3'),
              ('analysis_provider_admission_ledger_state(analysis_provider_admission_leases)', 'afbdabf16c770b1ade7996dd1dd3af6d'),
              ('analysis_v2_progress_snapshot_fingerprint(text,boolean,jsonb,jsonb,jsonb)', '9dbce1bd8562ea69a860c124436fceee'),
              ('analysis_v2_purge_result_working_set_exact(uuid,boolean)', '38e61e51a596113a648d778486399dc3'),
              ('bootstrap_earlybird_v211_concierge_first_order(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,smallint,integer,integer,integer,integer,integer,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)', '3f8eef9b1f0cb9e7bc193bdfd74904b6'),
              ('checkpoint_analysis_v2_progress(uuid,text,uuid,text,text,integer,boolean,jsonb,jsonb,jsonb,text,jsonb,text)', 'd214b0214840098031caf53c5ed85be3'),
              ('claim_analysis_v2_scheduler_operation(uuid,text,uuid,text,text,uuid,integer)', '60b3984c2bde7f957ba2403b201832c3')
          )
    ) THEN
        RAISE EXCEPTION 'SHADOW_RETIREMENT_UNREVIEWED_DYNAMIC_SQL';
    END IF;
END;
$guard$;

DROP FUNCTION public.record_analysis_canonical_job(uuid,text,text,text,bigint,integer,integer,timestamptz,timestamptz,text,jsonb,text) RESTRICT;
DROP FUNCTION public.append_analysis_canonical_event(uuid,uuid,text,text,jsonb,text,text) RESTRICT;
DROP FUNCTION public.enqueue_analysis_execution_retry_v1(uuid,text) RESTRICT;
DROP FUNCTION public.load_analysis_execution_family_v1(uuid,text) RESTRICT;

-- Events reference jobs; their own indexes, owned sequence, constraints and
-- append-only trigger disappear with the table. No external CASCADE is used.
DROP TABLE public.analysis_events RESTRICT;
DROP TABLE public.analysis_jobs RESTRICT;

DROP FUNCTION public.reject_analysis_canonical_mutation() RESTRICT;
DROP FUNCTION public.analysis_canonical_payload_has_only_keys(jsonb,text[]) RESTRICT;
DROP FUNCTION public.analysis_canonical_payload_valid(jsonb) RESTRICT;
DROP FUNCTION public.analysis_canonical_json_value_valid(jsonb) RESTRICT;
DROP FUNCTION public.analysis_canonical_json_object_has_exact_keys(jsonb,text[]) RESTRICT;
DROP FUNCTION public.analysis_execution_payload_has_only_keys_v1(jsonb,text[]) RESTRICT;
DROP FUNCTION public.analysis_execution_payload_valid_v1(jsonb) RESTRICT;
DROP FUNCTION public.analysis_execution_json_value_valid_v1(jsonb) RESTRICT;
DROP FUNCTION public.analysis_execution_json_object_has_exact_keys_v1(jsonb,text[]) RESTRICT;
COMMIT;
