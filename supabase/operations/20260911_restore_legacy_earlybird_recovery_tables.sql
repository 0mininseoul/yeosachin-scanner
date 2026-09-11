-- Isolated rollback operation for the Supabase 22 legacy earlybird wave.
--
-- This file is intentionally outside supabase/migrations. It can only run
-- after the caller explicitly sets the session guard below in a disposable,
-- isolated database:
--
--   SET supabase.retirement_isolated = 'true';
--   \i supabase/operations/20260911_restore_legacy_earlybird_recovery_tables.sql
--
-- The operation never deletes or rewrites canonical maintenance_jobs rows.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $restore_guard$
BEGIN
    IF pg_catalog.current_setting('supabase.retirement_isolated', TRUE)
        IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_ISOLATED_GUARD';
    END IF;

    IF pg_catalog.to_regclass('public.earlybird_concierge_batch_target_lineage_repairs') IS NOT NULL
       OR pg_catalog.to_regclass('public.earlybird_partial_adoption_second_rearms') IS NOT NULL
       OR pg_catalog.to_regclass('public.earlybird_profile_evidence_failure_recoveries') IS NOT NULL
       OR pg_catalog.to_regclass('public.earlybird_v211_apify_transient_admission_resumes') IS NOT NULL
       OR pg_catalog.to_regclass('public.earlybird_v211_concierge_copy_corrections') IS NOT NULL
       OR pg_catalog.to_regclass('public.earlybird_v212_concierge_copy_corrections') IS NOT NULL
       OR pg_catalog.to_regclass('public.earlybird_v213_concierge_copy_corrections') IS NOT NULL
       OR pg_catalog.to_regclass('public.earlybird_v214_concierge_gemini_copy_corrections') IS NOT NULL THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_TARGET_ALREADY_PRESENT';
    END IF;
END;
$restore_guard$;

LOCK TABLE public.maintenance_jobs IN SHARE MODE;

-- These definitions are copied from the committed historical migrations. The
-- parent relations are intentionally not recreated by this operation: an
-- isolated rollback harness must provide the retained parent schema.
CREATE TABLE public.earlybird_concierge_batch_target_lineage_repairs (
    cohort_key TEXT NOT NULL CHECK (
        cohort_key = 'concierge-fallback-20260816'
    ),
    order_id UUID NOT NULL REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id)
        ON DELETE RESTRICT,
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id)
        ON DELETE RESTRICT,
    rearm_generation SMALLINT NOT NULL CHECK (rearm_generation = 3),
    source_failure_code TEXT NOT NULL CHECK (source_failure_code IN (
        'JOB_ATTEMPTS_EXHAUSTED',
        'SCRAPING_INCOMPLETE_ERROR',
        'SCRAPING_PROVIDER_START_REJECTED_ERROR'
    )),
    source_credential_slot TEXT NOT NULL CHECK (source_credential_slot = 'quinary'),
    fallback_credential_slot TEXT NOT NULL CHECK (fallback_credential_slot = 'primary'),
    allowlist_hash TEXT NOT NULL CHECK (allowlist_hash ~ '^[a-f0-9]{64}$'),
    old_request_target_hash TEXT NOT NULL CHECK (old_request_target_hash ~ '^[a-f0-9]{64}$'),
    old_preflight_target_hash TEXT NOT NULL CHECK (old_preflight_target_hash ~ '^[a-f0-9]{64}$'),
    repaired_target_hash TEXT NOT NULL CHECK (repaired_target_hash ~ '^[a-f0-9]{64}$'),
    repaired_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (cohort_key, order_id),
    UNIQUE (cohort_key, request_id, preflight_id)
);

CREATE TABLE public.earlybird_partial_adoption_second_rearms (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id) ON DELETE RESTRICT,
    original_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    first_policy_failed_request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    second_policy_failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    expected_fulfillment_attempt_count SMALLINT NOT NULL CHECK (
        expected_fulfillment_attempt_count = 3
    ),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_profile_evidence_failure_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL CHECK (prior_attempt_count BETWEEN 1 AND 10),
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_v211_apify_transient_admission_resumes (
    order_id UUID PRIMARY KEY
        REFERENCES public.earlybird_v211_apify_transient_replays(order_id)
        ON DELETE RESTRICT,
    expected_manual_review_at TIMESTAMP WITH TIME ZONE NOT NULL UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.earlybird_v211_concierge_copy_corrections (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    result_request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    published_source_fingerprint TEXT NOT NULL
        CHECK (published_source_fingerprint ~ '^[a-f0-9]{64}$'),
    expected_published_result_hash TEXT NOT NULL
        CHECK (expected_published_result_hash ~ '^[a-f0-9]{64}$'),
    correction_result_hash TEXT NOT NULL
        CHECK (correction_result_hash ~ '^[a-f0-9]{64}$'),
    copy_payload JSONB NOT NULL
        CHECK (pg_catalog.jsonb_typeof(copy_payload) = 'object'),
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (order_id, correction_result_hash)
);

CREATE TABLE public.earlybird_v212_concierge_copy_corrections (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    result_request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    prior_correction_result_hash TEXT NOT NULL
        CHECK (prior_correction_result_hash ~ '^[a-f0-9]{64}$'),
    correction_result_hash TEXT NOT NULL
        CHECK (correction_result_hash ~ '^[a-f0-9]{64}$'),
    copy_payload JSONB NOT NULL
        CHECK (pg_catalog.jsonb_typeof(copy_payload) = 'object'),
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (order_id, correction_result_hash)
);

CREATE TABLE public.earlybird_v213_concierge_copy_corrections (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    result_request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    prior_correction_result_hash TEXT NOT NULL
        CHECK (prior_correction_result_hash ~ '^[a-f0-9]{64}$'),
    correction_result_hash TEXT NOT NULL
        CHECK (correction_result_hash ~ '^[a-f0-9]{64}$'),
    copy_payload JSONB NOT NULL
        CHECK (pg_catalog.jsonb_typeof(copy_payload) = 'object'),
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (order_id, correction_result_hash)
);

CREATE TABLE public.earlybird_v214_concierge_gemini_copy_corrections (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    result_request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    prior_correction_result_hash TEXT NOT NULL
        CHECK (prior_correction_result_hash ~ '^[a-f0-9]{64}$'),
    correction_result_hash TEXT NOT NULL
        CHECK (correction_result_hash ~ '^[a-f0-9]{64}$'),
    copy_payload JSONB NOT NULL
        CHECK (pg_catalog.jsonb_typeof(copy_payload) = 'object'),
    corrected_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    UNIQUE (order_id, correction_result_hash)
);

ALTER TABLE public.earlybird_concierge_batch_target_lineage_repairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_concierge_batch_target_lineage_repairs FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_partial_adoption_second_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_partial_adoption_second_rearms FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_profile_evidence_failure_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_profile_evidence_failure_recoveries FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_apify_transient_admission_resumes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_apify_transient_admission_resumes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_concierge_copy_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_concierge_copy_corrections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v212_concierge_copy_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v212_concierge_copy_corrections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v213_concierge_copy_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v213_concierge_copy_corrections FORCE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v214_concierge_gemini_copy_corrections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v214_concierge_gemini_copy_corrections FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.earlybird_concierge_batch_target_lineage_repairs FROM PUBLIC;
REVOKE ALL ON TABLE public.earlybird_partial_adoption_second_rearms FROM PUBLIC;
REVOKE ALL ON TABLE public.earlybird_profile_evidence_failure_recoveries FROM PUBLIC;
REVOKE ALL ON TABLE public.earlybird_v211_apify_transient_admission_resumes FROM PUBLIC;
REVOKE ALL ON TABLE public.earlybird_v211_concierge_copy_corrections FROM PUBLIC;
REVOKE ALL ON TABLE public.earlybird_v212_concierge_copy_corrections FROM PUBLIC;
REVOKE ALL ON TABLE public.earlybird_v213_concierge_copy_corrections FROM PUBLIC;
REVOKE ALL ON TABLE public.earlybird_v214_concierge_gemini_copy_corrections FROM PUBLIC;

-- Recreate only immutable table-owned trigger behavior in the isolated target.
CREATE OR REPLACE FUNCTION public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_REPAIR_IMMUTABLE', ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER prevent_earlybird_concierge_batch_target_lineage_repair_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_concierge_batch_target_lineage_repairs
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation();

CREATE OR REPLACE FUNCTION public.prevent_earlybird_partial_adoption_second_rearm_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_PARTIAL_ADOPTION_SECOND_REARM_IMMUTABLE', ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER prevent_earlybird_partial_adoption_second_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_partial_adoption_second_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_partial_adoption_second_rearm_mutation();

CREATE OR REPLACE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE', ERRCODE = 'P0001';
END;
$$;
CREATE TRIGGER prevent_earlybird_profile_evidence_failure_recovery_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_profile_evidence_failure_recoveries
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();
CREATE TRIGGER prevent_earlybird_v211_apify_transient_admission_resume_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_apify_transient_admission_resumes
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE OR REPLACE FUNCTION public.prevent_earlybird_v211_concierge_copy_correction_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_CORRECTION_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER prevent_earlybird_v211_concierge_copy_correction_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v211_concierge_copy_corrections
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_v211_concierge_copy_correction_mutation();

CREATE OR REPLACE FUNCTION public.prevent_earlybird_v212_concierge_copy_correction_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V212_CORRECTION_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER prevent_earlybird_v212_concierge_copy_correction_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v212_concierge_copy_corrections
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_v212_concierge_copy_correction_mutation();

CREATE OR REPLACE FUNCTION public.prevent_earlybird_v213_concierge_copy_correction_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V213_CORRECTION_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER prevent_earlybird_v213_concierge_copy_correction_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v213_concierge_copy_corrections
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_v213_concierge_copy_correction_mutation();

CREATE OR REPLACE FUNCTION public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_COPY_V214_CORRECTION_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER prevent_earlybird_v214_concierge_gemini_copy_correction_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_v214_concierge_gemini_copy_corrections
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_v214_concierge_gemini_copy_correction_mutation();

-- Every cast names its destination column so a malformed canonical payload
-- fails instead of silently changing the restored type or column order.
INSERT INTO public.earlybird_concierge_batch_target_lineage_repairs (
    cohort_key, order_id, request_id, preflight_id, rearm_generation,
    source_failure_code, source_credential_slot, fallback_credential_slot,
    allowlist_hash, old_request_target_hash, old_preflight_target_hash,
    repaired_target_hash, repaired_at
)
SELECT row_payload->>'cohort_key',
       (row_payload->>'order_id')::UUID,
       (row_payload->>'request_id')::UUID,
       (row_payload->>'preflight_id')::UUID,
       (row_payload->>'rearm_generation')::SMALLINT,
       row_payload->>'source_failure_code', row_payload->>'source_credential_slot',
       row_payload->>'fallback_credential_slot', row_payload->>'allowlist_hash',
       row_payload->>'old_request_target_hash', row_payload->>'old_preflight_target_hash',
       row_payload->>'repaired_target_hash', (row_payload->>'repaired_at')::TIMESTAMPTZ
FROM (
    SELECT job.payload->'legacy_row' AS row_payload
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_concierge_batch_target_lineage_repairs'
) AS source_rows;

INSERT INTO public.earlybird_partial_adoption_second_rearms (
    order_id, original_failed_request_id, first_policy_failed_request_id,
    second_policy_failed_request_id, rearmed_preflight_id,
    expected_fulfillment_attempt_count, expected_manual_review_at, created_at
)
SELECT (row_payload->>'order_id')::UUID,
       (row_payload->>'original_failed_request_id')::UUID,
       (row_payload->>'first_policy_failed_request_id')::UUID,
       (row_payload->>'second_policy_failed_request_id')::UUID,
       (row_payload->>'rearmed_preflight_id')::UUID,
       (row_payload->>'expected_fulfillment_attempt_count')::SMALLINT,
       (row_payload->>'expected_manual_review_at')::TIMESTAMPTZ,
       (row_payload->>'created_at')::TIMESTAMPTZ
FROM (
    SELECT job.payload->'legacy_row' AS row_payload
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_partial_adoption_second_rearms'
) AS source_rows;

INSERT INTO public.earlybird_profile_evidence_failure_recoveries (
    order_id, failed_request_id, recovery_preflight_id, prior_attempt_count,
    expected_manual_review_at, created_at
)
SELECT (row_payload->>'order_id')::UUID,
       (row_payload->>'failed_request_id')::UUID,
       (row_payload->>'recovery_preflight_id')::UUID,
       (row_payload->>'prior_attempt_count')::SMALLINT,
       (row_payload->>'expected_manual_review_at')::TIMESTAMPTZ,
       (row_payload->>'created_at')::TIMESTAMPTZ
FROM (
    SELECT job.payload->'legacy_row' AS row_payload
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_profile_evidence_failure_recoveries'
) AS source_rows;

INSERT INTO public.earlybird_v211_apify_transient_admission_resumes (
    order_id, expected_manual_review_at, created_at
)
SELECT (row_payload->>'order_id')::UUID,
       (row_payload->>'expected_manual_review_at')::TIMESTAMPTZ,
       (row_payload->>'created_at')::TIMESTAMPTZ
FROM (
    SELECT job.payload->'legacy_row' AS row_payload
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_v211_apify_transient_admission_resumes'
) AS source_rows;

INSERT INTO public.earlybird_v211_concierge_copy_corrections (
    order_id, result_request_id, published_source_fingerprint,
    expected_published_result_hash, correction_result_hash, copy_payload,
    corrected_at
)
SELECT (row_payload->>'order_id')::UUID,
       (row_payload->>'result_request_id')::UUID,
       row_payload->>'published_source_fingerprint',
       row_payload->>'expected_published_result_hash',
       row_payload->>'correction_result_hash', row_payload->'copy_payload',
       (row_payload->>'corrected_at')::TIMESTAMPTZ
FROM (
    SELECT job.payload->'legacy_row' AS row_payload
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_v211_concierge_copy_corrections'
) AS source_rows;

INSERT INTO public.earlybird_v212_concierge_copy_corrections (
    order_id, result_request_id, prior_correction_result_hash,
    correction_result_hash, copy_payload, corrected_at
)
SELECT (row_payload->>'order_id')::UUID,
       (row_payload->>'result_request_id')::UUID,
       row_payload->>'prior_correction_result_hash',
       row_payload->>'correction_result_hash', row_payload->'copy_payload',
       (row_payload->>'corrected_at')::TIMESTAMPTZ
FROM (
    SELECT job.payload->'legacy_row' AS row_payload
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_v212_concierge_copy_corrections'
) AS source_rows;

INSERT INTO public.earlybird_v213_concierge_copy_corrections (
    order_id, result_request_id, prior_correction_result_hash,
    correction_result_hash, copy_payload, corrected_at
)
SELECT (row_payload->>'order_id')::UUID,
       (row_payload->>'result_request_id')::UUID,
       row_payload->>'prior_correction_result_hash',
       row_payload->>'correction_result_hash', row_payload->'copy_payload',
       (row_payload->>'corrected_at')::TIMESTAMPTZ
FROM (
    SELECT job.payload->'legacy_row' AS row_payload
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_v213_concierge_copy_corrections'
) AS source_rows;

INSERT INTO public.earlybird_v214_concierge_gemini_copy_corrections (
    order_id, result_request_id, prior_correction_result_hash,
    correction_result_hash, copy_payload, corrected_at
)
SELECT (row_payload->>'order_id')::UUID,
       (row_payload->>'result_request_id')::UUID,
       row_payload->>'prior_correction_result_hash',
       row_payload->>'correction_result_hash', row_payload->'copy_payload',
       (row_payload->>'corrected_at')::TIMESTAMPTZ
FROM (
    SELECT job.payload->'legacy_row' AS row_payload
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload->>'legacy_source_table' = 'earlybird_v214_concierge_gemini_copy_corrections'
) AS source_rows;

DO $restore_parity$
DECLARE
    v_total BIGINT;
    v_mismatches BIGINT;
BEGIN
    WITH source_rows AS (
        SELECT 'earlybird_concierge_batch_target_lineage_repairs'::TEXT AS source_table, pg_catalog.to_jsonb(source_row) AS row_json
        FROM public.earlybird_concierge_batch_target_lineage_repairs AS source_row
        UNION ALL SELECT 'earlybird_partial_adoption_second_rearms', pg_catalog.to_jsonb(source_row)
        FROM public.earlybird_partial_adoption_second_rearms AS source_row
        UNION ALL SELECT 'earlybird_profile_evidence_failure_recoveries', pg_catalog.to_jsonb(source_row)
        FROM public.earlybird_profile_evidence_failure_recoveries AS source_row
        UNION ALL SELECT 'earlybird_v211_apify_transient_admission_resumes', pg_catalog.to_jsonb(source_row)
        FROM public.earlybird_v211_apify_transient_admission_resumes AS source_row
        UNION ALL SELECT 'earlybird_v211_concierge_copy_corrections', pg_catalog.to_jsonb(source_row)
        FROM public.earlybird_v211_concierge_copy_corrections AS source_row
        UNION ALL SELECT 'earlybird_v212_concierge_copy_corrections', pg_catalog.to_jsonb(source_row)
        FROM public.earlybird_v212_concierge_copy_corrections AS source_row
        UNION ALL SELECT 'earlybird_v213_concierge_copy_corrections', pg_catalog.to_jsonb(source_row)
        FROM public.earlybird_v213_concierge_copy_corrections AS source_row
        UNION ALL SELECT 'earlybird_v214_concierge_gemini_copy_corrections', pg_catalog.to_jsonb(source_row)
        FROM public.earlybird_v214_concierge_gemini_copy_corrections AS source_row
    ), canonical_rows AS (
        SELECT job.payload->>'legacy_source_table' AS source_table,
               job.payload->'legacy_row' AS row_json
        FROM public.maintenance_jobs AS job
        WHERE job.state = 'succeeded'
          AND job.payload ? 'legacy_source_table'
    ), source_aggregate AS (
        SELECT source_table, pg_catalog.count(*) AS row_count,
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   COALESCE(pg_catalog.string_agg(row_json::TEXT, E'\n' ORDER BY row_json::TEXT), ''),
                   'UTF8'
               )), 'hex') AS row_hash
        FROM source_rows
        GROUP BY source_table
    ), canonical_aggregate AS (
        SELECT source_table, pg_catalog.count(*) AS row_count,
               pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
                   COALESCE(pg_catalog.string_agg(row_json::TEXT, E'\n' ORDER BY row_json::TEXT), ''),
                   'UTF8'
               )), 'hex') AS row_hash
        FROM canonical_rows
        GROUP BY source_table
    )
    SELECT pg_catalog.count(*) INTO v_mismatches
    FROM source_aggregate AS source_side
    FULL JOIN canonical_aggregate AS canonical_side USING (source_table)
    WHERE source_side.row_count IS DISTINCT FROM canonical_side.row_count
       OR source_side.row_hash IS DISTINCT FROM canonical_side.row_hash;

    IF v_mismatches <> 0 THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_CANONICAL_PARITY_MISMATCH';
    END IF;

    SELECT pg_catalog.count(*) INTO v_total
    FROM public.maintenance_jobs AS job
    WHERE job.state = 'succeeded'
      AND job.payload ? 'legacy_source_table';
    IF v_total <> 11 THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_CANONICAL_TOTAL_MISMATCH';
    END IF;
END;
$restore_parity$;

COMMIT;
