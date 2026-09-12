-- Isolated rollback/restore operation for the 20260912 retirement wave.
--
-- This operation is intentionally outside supabase/migrations.  It must only
-- run in a disposable database after the caller explicitly sets:
--
--   SET supabase.retirement_isolated = 'true';
--
-- The operation never deletes or rewrites canonical maintenance_jobs rows.
-- The payment relations were empty at retirement and therefore have no row
-- payload to restore.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $restore_guard$
BEGIN
    IF pg_catalog.current_setting('supabase.retirement_isolated', TRUE)
        IS DISTINCT FROM 'true' THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_ISOLATED_GUARD';
    END IF;

    IF pg_catalog.to_regclass('public.maintenance_jobs') IS NULL THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_CANONICAL_MISSING';
    END IF;

    IF pg_catalog.to_regclass('public.analysis_v2_historical_legacy_dispatch_terminalization_receipts') IS NOT NULL
       OR pg_catalog.to_regclass('public.payment_orders') IS NOT NULL
       OR pg_catalog.to_regclass('public.payments') IS NOT NULL THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_TARGET_ALREADY_PRESENT';
    END IF;

    IF (
        SELECT count(*)
        FROM public.maintenance_jobs AS job
        WHERE job.kind = 'terminalize'
          AND job.payload->>'legacy_source_table'
              = 'analysis_v2_historical_legacy_dispatch_terminalization_receipts'
          AND job.payload->>'schema_version' = '1'
    ) <> 5 THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_CANONICAL_COUNT';
    END IF;
END;
$restore_guard$;

LOCK TABLE public.maintenance_jobs IN SHARE MODE;

-- Copied from the committed 20260904000000 historical migration.  Parent
-- relations (analysis_requests and analysis_pipeline_jobs) must already exist
-- in the disposable restore database.
CREATE TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts (
    receipt_id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key VARCHAR(160) NOT NULL,
    input_hash VARCHAR(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
    prior_status VARCHAR(16) NOT NULL CHECK (prior_status IN ('pending', 'processing')),
    prior_dispatch_state VARCHAR(16) NOT NULL CHECK (prior_dispatch_state = 'delivered'),
    prior_dispatch_generation INTEGER NOT NULL CHECK (prior_dispatch_generation BETWEEN 1 AND 1000),
    prior_dispatch_reservation_token UUID NOT NULL,
    prior_dispatch_reserved_at TIMESTAMPTZ NOT NULL,
    prior_dispatched_at TIMESTAMPTZ NOT NULL,
    prior_delivered_at TIMESTAMPTZ NOT NULL,
    prior_dispatch_task_name VARCHAR(512) NOT NULL,
    prior_dispatch_workload_role TEXT,
    prior_dispatch_contract_version SMALLINT,
    prior_claim_workload_role TEXT,
    prior_claim_contract_version SMALLINT,
    prior_lease_token UUID,
    prior_lease_expires_at TIMESTAMPTZ,
    manual_resolution_operation_key VARCHAR(87),
    manual_resolution_evidence_hash VARCHAR(64),
    terminal_status VARCHAR(16) NOT NULL CHECK (terminal_status IN ('failed', 'cancelled')),
    error_code VARCHAR(64) NOT NULL
        CHECK (error_code = 'HISTORICAL_LEGACY_DISPATCH_TERMINALIZED'),
    audit_evidence_hash VARCHAR(64) NOT NULL CHECK (audit_evidence_hash ~ '^[0-9a-f]{64}$'),
    resolved_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_identity_unique
        UNIQUE (request_id, job_key),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_provenance_check CHECK (
        prior_dispatch_workload_role IS NULL
        AND prior_dispatch_contract_version IS NULL
        AND prior_claim_workload_role IS NULL
        AND prior_claim_contract_version IS NULL
    ),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_manual_resolution_check CHECK (
        (
            manual_resolution_operation_key IS NULL
            AND manual_resolution_evidence_hash IS NULL
        )
        OR (
            manual_resolution_operation_key IS NOT NULL
            AND manual_resolution_operation_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$'
            AND manual_resolution_evidence_hash IS NOT NULL
            AND manual_resolution_evidence_hash ~ '^[0-9a-f]{64}$'
        )
    ),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_lease_check CHECK (
        (
            prior_status = 'pending'
            AND prior_lease_token IS NULL
            AND prior_lease_expires_at IS NULL
        )
        OR (
            prior_status = 'processing'
            AND prior_lease_token IS NOT NULL
            AND prior_lease_expires_at IS NOT NULL
        )
    ),
    CONSTRAINT analysis_v2_historical_legacy_dispatch_receipt_time_check CHECK (
        prior_dispatch_reserved_at <= prior_dispatched_at
        AND prior_dispatched_at <= prior_delivered_at
    ),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE INDEX analysis_v2_historical_legacy_dispatch_receipt_resolved_idx
    ON public.analysis_v2_historical_legacy_dispatch_terminalization_receipts(resolved_at, request_id, job_key);

ALTER TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_historical_legacy_dispatch_terminalization_receipts
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_HISTORICAL_LEGACY_DISPATCH_RECEIPT_IMMUTABLE',
            ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability
BEFORE UPDATE OR DELETE ON public.analysis_v2_historical_legacy_dispatch_terminalization_receipts
FOR EACH ROW EXECUTE FUNCTION public.guard_analysis_v2_historical_legacy_dispatch_terminalization_receipt_immutability();

-- These two empty relations are reconstructed from the sanitized production
-- catalog snapshot.  They retain their historical constraints/indexes and
-- server-only RLS boundary, but no payment state is synthesized.
CREATE TABLE public.payment_orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    polar_order_id TEXT NOT NULL UNIQUE,
    customer_email TEXT,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL DEFAULT 'completed',
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_payment_orders_polar_order_id
    ON public.payment_orders(polar_order_id);
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payment_orders FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.payment_orders TO service_role;

CREATE TABLE public.payments (
    id UUID PRIMARY KEY DEFAULT extensions.uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    result_id UUID REFERENCES public.analysis_results(id) ON DELETE SET NULL,
    payment_key VARCHAR(200),
    order_id VARCHAR(100) NOT NULL,
    amount INTEGER NOT NULL,
    currency VARCHAR(10) DEFAULT 'usd',
    product_type VARCHAR(20) NOT NULL
        CHECK (product_type IN ('unlock_rank', 'deep_scan')),
    status VARCHAR(20) DEFAULT 'pending'
        CHECK (status IN ('pending', 'completed', 'failed', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ,
    UNIQUE (order_id)
);
CREATE INDEX idx_payments_order_id ON public.payments(order_id);
CREATE INDEX idx_payments_user_id ON public.payments(user_id);
ALTER TABLE public.payments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.payments FROM PUBLIC, anon, authenticated, service_role;
GRANT ALL ON TABLE public.payments TO service_role;

INSERT INTO public.analysis_v2_historical_legacy_dispatch_terminalization_receipts (
    receipt_id,
    request_id,
    job_key,
    input_hash,
    prior_status,
    prior_dispatch_state,
    prior_dispatch_generation,
    prior_dispatch_reservation_token,
    prior_dispatch_reserved_at,
    prior_dispatched_at,
    prior_delivered_at,
    prior_dispatch_task_name,
    prior_dispatch_workload_role,
    prior_dispatch_contract_version,
    prior_claim_workload_role,
    prior_claim_contract_version,
    prior_lease_token,
    prior_lease_expires_at,
    manual_resolution_operation_key,
    manual_resolution_evidence_hash,
    terminal_status,
    error_code,
    audit_evidence_hash,
    resolved_at,
    created_at
)
SELECT
    (job.payload->'legacy_row'->>'receipt_id')::UUID,
    (job.payload->'legacy_row'->>'request_id')::UUID,
    (job.payload->'legacy_row'->>'job_key')::VARCHAR(160),
    (job.payload->'legacy_row'->>'input_hash')::VARCHAR(64),
    (job.payload->'legacy_row'->>'prior_status')::VARCHAR(16),
    (job.payload->'legacy_row'->>'prior_dispatch_state')::VARCHAR(16),
    (job.payload->'legacy_row'->>'prior_dispatch_generation')::INTEGER,
    (job.payload->'legacy_row'->>'prior_dispatch_reservation_token')::UUID,
    (job.payload->'legacy_row'->>'prior_dispatch_reserved_at')::TIMESTAMPTZ,
    (job.payload->'legacy_row'->>'prior_dispatched_at')::TIMESTAMPTZ,
    (job.payload->'legacy_row'->>'prior_delivered_at')::TIMESTAMPTZ,
    (job.payload->'legacy_row'->>'prior_dispatch_task_name')::VARCHAR(512),
    (job.payload->'legacy_row'->>'prior_dispatch_workload_role')::TEXT,
    (job.payload->'legacy_row'->>'prior_dispatch_contract_version')::SMALLINT,
    (job.payload->'legacy_row'->>'prior_claim_workload_role')::TEXT,
    (job.payload->'legacy_row'->>'prior_claim_contract_version')::SMALLINT,
    (job.payload->'legacy_row'->>'prior_lease_token')::UUID,
    (job.payload->'legacy_row'->>'prior_lease_expires_at')::TIMESTAMPTZ,
    (job.payload->'legacy_row'->>'manual_resolution_operation_key')::VARCHAR(87),
    (job.payload->'legacy_row'->>'manual_resolution_evidence_hash')::VARCHAR(64),
    (job.payload->'legacy_row'->>'terminal_status')::VARCHAR(16),
    (job.payload->'legacy_row'->>'error_code')::VARCHAR(64),
    (job.payload->'legacy_row'->>'audit_evidence_hash')::VARCHAR(64),
    (job.payload->'legacy_row'->>'resolved_at')::TIMESTAMPTZ,
    (job.payload->'legacy_row'->>'created_at')::TIMESTAMPTZ
FROM public.maintenance_jobs AS job
WHERE job.kind = 'terminalize'
  AND job.payload->>'legacy_source_table'
      = 'analysis_v2_historical_legacy_dispatch_terminalization_receipts'
  AND job.payload->>'schema_version' = '1';

DO $restore_parity_guard$
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
    IF v_source_count <> 5 OR v_canonical_count <> 5
       OR v_source_hash <> v_canonical_hash THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_PARITY_MISMATCH';
    END IF;
    IF (SELECT count(*) FROM public.payment_orders) <> 0
       OR (SELECT count(*) FROM public.payments) <> 0 THEN
        RAISE EXCEPTION 'RETIREMENT_RESTORE_EMPTY_PAYMENT_MISMATCH';
    END IF;
END;
$restore_parity_guard$;

COMMIT;
