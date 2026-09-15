-- Retire optional execution mirrors, not the authoritative V2 pipeline/progress.
-- Apply only after writer removal or disabled live-revision flags are verified.
-- The 2026-09-15 owner-only public backup was restored in isolation; its rows
-- match the UTC/JSONB checksums below. Empty tables permit fresh local installs.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
SET LOCAL TIME ZONE 'UTC';

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
          AND NOT (n.nspname = 'public' AND p.proname IN (
              'record_analysis_canonical_job', 'append_analysis_canonical_event',
              'enqueue_analysis_execution_retry_v1', 'load_analysis_execution_family_v1',
              'reject_analysis_canonical_mutation',
              'analysis_canonical_json_object_has_exact_keys', 'analysis_canonical_json_value_valid',
              'analysis_canonical_payload_valid', 'analysis_canonical_payload_has_only_keys',
              'analysis_execution_json_object_has_exact_keys_v1', 'analysis_execution_json_value_valid_v1',
              'analysis_execution_payload_valid_v1', 'analysis_execution_payload_has_only_keys_v1'
          ))
          AND p.prosrc ~ '\m(analysis_jobs|analysis_events|record_analysis_canonical_job|append_analysis_canonical_event|enqueue_analysis_execution_retry_v1|load_analysis_execution_family_v1|reject_analysis_canonical_mutation|analysis_canonical_json_object_has_exact_keys|analysis_canonical_json_value_valid|analysis_canonical_payload_valid|analysis_canonical_payload_has_only_keys|analysis_execution_json_object_has_exact_keys_v1|analysis_execution_json_value_valid_v1|analysis_execution_payload_valid_v1|analysis_execution_payload_has_only_keys_v1)\M'
    ) THEN
        RAISE EXCEPTION 'SHADOW_RETIREMENT_UNEXPECTED_ROUTINE_CALLER';
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
