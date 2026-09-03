-- Per-request/order cost attribution for automatic-analysis v2.
--
-- Existing provider, preflight, AI-attempt, and result-checkpoint ledgers remain the source of
-- truth. This migration adds only a PII-free source mapping and a derived service-role rollup;
-- it does not copy provider amounts into a second fact ledger. Vertex/Gemini response usage is
-- deliberately named metered_estimated_cost_usd: Vertex returns metered token usage, not a final
-- invoice charge. Apify actual_usage_usd remains the only provider-reported actual charge.
-- MIGRATION_PREDECESSOR=20260904100000
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260904100000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_COST_ATTRIBUTION_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.analysis_v2_canonical_gemini_model(
    p_model_name TEXT
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    WITH model AS (
        SELECT pg_catalog.regexp_replace(pg_catalog.btrim(p_model_name), '^.*/', '')
            AS model_name
    )
    SELECT CASE
        WHEN model.model_name ~ '^gemini-3[.]1-flash-lite(?:-preview(?:-[0-9]{3})?|-[0-9]{3})?$'
            THEN 'gemini-3.1-flash-lite'
        WHEN model.model_name ~ '^gemini-3[.]7-flash(?:-[0-9]{3})?$'
            THEN 'gemini-3.7-flash'
        WHEN model.model_name = 'gemini-3-flash-preview'
            THEN 'gemini-3-flash-preview'
        ELSE model.model_name
    END
    FROM model;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_canonical_gemini_model(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- V2 attempt rows are the authoritative per-attempt Gemini ledger. Keep the existing RPC wire
-- unchanged during the migration-first rollout: these internal columns are populated by a
-- trigger, while current reserve/load/terminalize callers continue to receive the old JSON shape.
-- Existing rows are intentionally not backfilled. Their pricing/cache provenance is unknown and
-- must remain unknown rather than acquiring invented values.
ALTER TABLE public.analysis_v2_ai_attempts
    ADD COLUMN IF NOT EXISTS pricing_version VARCHAR(64),
    ADD COLUMN IF NOT EXISTS canonical_model_name VARCHAR(100),
    ADD COLUMN IF NOT EXISTS cache_read_tokens INTEGER,
    ADD COLUMN IF NOT EXISTS metered_estimated_cost_usd NUMERIC(15, 12);

ALTER TABLE public.analysis_v2_ai_attempts
    DROP CONSTRAINT IF EXISTS analysis_v2_ai_attempt_pricing_version_check,
    DROP CONSTRAINT IF EXISTS analysis_v2_ai_attempt_canonical_model_check,
    DROP CONSTRAINT IF EXISTS analysis_v2_ai_attempt_cache_read_tokens_check,
    DROP CONSTRAINT IF EXISTS analysis_v2_ai_attempt_metered_estimated_cost_check;

ALTER TABLE public.analysis_v2_ai_attempts
    ADD CONSTRAINT analysis_v2_ai_attempt_pricing_version_check CHECK (
        pricing_version IS NULL OR pricing_version ~ '^[A-Za-z0-9._:-]{1,64}$'
    ),
    ADD CONSTRAINT analysis_v2_ai_attempt_canonical_model_check CHECK (
        canonical_model_name IS NULL
        OR canonical_model_name ~ '^[a-z0-9][a-z0-9._-]{0,99}$'
    ),
    ADD CONSTRAINT analysis_v2_ai_attempt_cache_read_tokens_check CHECK (
        cache_read_tokens IS NULL OR cache_read_tokens BETWEEN 0 AND 100000000
    ),
    ADD CONSTRAINT analysis_v2_ai_attempt_metered_estimated_cost_check CHECK (
        metered_estimated_cost_usd IS NULL
        OR metered_estimated_cost_usd BETWEEN 0 AND 999.999999999999
    );

CREATE OR REPLACE FUNCTION public.analysis_v2_ai_attempt_cost_provenance_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.pricing_version IS NOT NULL
           AND NEW.pricing_version IS DISTINCT FROM OLD.pricing_version THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_PRICING_VERSION_IMMUTABLE',
                ERRCODE = 'P0001';
        END IF;
        IF OLD.canonical_model_name IS NOT NULL
           AND (
               NEW.model_name IS DISTINCT FROM OLD.model_name
               OR NEW.location IS DISTINCT FROM OLD.location
               OR NEW.canonical_model_name IS DISTINCT FROM OLD.canonical_model_name
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_MODEL_PROVENANCE_IMMUTABLE',
                ERRCODE = 'P0001';
        END IF;
        IF OLD.cache_read_tokens IS NOT NULL
           AND (
               NEW.cache_read_tokens IS DISTINCT FROM OLD.cache_read_tokens
               OR NEW.usage_metadata_status IS DISTINCT FROM OLD.usage_metadata_status
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_CACHE_PROVENANCE_IMMUTABLE',
                ERRCODE = 'P0001';
        END IF;
        IF OLD.metered_estimated_cost_usd IS NOT NULL
           AND (
               NEW.metered_estimated_cost_usd IS DISTINCT FROM OLD.metered_estimated_cost_usd
               OR NEW.estimated_cost_usd IS DISTINCT FROM OLD.estimated_cost_usd
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_METERED_COST_IMMUTABLE',
                ERRCODE = 'P0001';
        END IF;
        NEW.pricing_version := COALESCE(OLD.pricing_version, NEW.pricing_version,
            'vertex-ai-cost-v1');
    ELSE
        NEW.pricing_version := COALESCE(NEW.pricing_version, 'vertex-ai-cost-v1');
    END IF;

    -- Only the current catalog is accepted. A future catalog requires a forward migration so
    -- every estimate remains tied to the exact immutable catalog used at write time.
    IF NEW.pricing_version <> 'vertex-ai-cost-v1' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AI_ATTEMPT_PRICING_VERSION_UNSUPPORTED',
            ERRCODE = 'P0001';
    END IF;
    NEW.canonical_model_name := public.analysis_v2_canonical_gemini_model(NEW.model_name);

    -- The V2 transport assembles only inline `contents` and never sends a cachedContent
    -- reference. For a complete response that proves cached-content input was zero; provider
    -- omission is not treated as proof on any transport that can send cached content.
    IF NEW.usage_metadata_status = 'complete' THEN
        NEW.cache_read_tokens := COALESCE(NEW.cache_read_tokens, 0);
    ELSE
        NEW.cache_read_tokens := NULL;
    END IF;
    NEW.metered_estimated_cost_usd := NEW.estimated_cost_usd;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_ai_attempt_cost_provenance_trigger()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS analysis_v2_ai_attempt_cost_provenance
    ON public.analysis_v2_ai_attempts;
CREATE TRIGGER analysis_v2_ai_attempt_cost_provenance
BEFORE INSERT OR UPDATE OF model_name, location, pricing_version, usage_metadata_status,
    cache_read_tokens, estimated_cost_usd, metered_estimated_cost_usd
ON public.analysis_v2_ai_attempts
FOR EACH ROW EXECUTE FUNCTION public.analysis_v2_ai_attempt_cost_provenance_trigger();

COMMENT ON COLUMN public.analysis_v2_ai_attempts.metered_estimated_cost_usd IS
    'Deterministic Vertex/Gemini estimate from this attempt response usage; not a provider invoice actual.';
COMMENT ON COLUMN public.analysis_v2_ai_attempts.cache_read_tokens IS
    'Cached-content input tokens from Vertex usage metadata; null means usage is unknown.';
COMMENT ON COLUMN public.analysis_v2_ai_attempts.pricing_version IS
    'Immutable pricing catalog version for metered_estimated_cost_usd; null means legacy provenance is unknown.';

-- A source mapping is one row per consumed preflight provider operation. Amounts are never copied
-- here: the rollup joins this map back to analysis_preflight_provider_runs, so a late reconciliation
-- changes the derived value without a second fact or a second charge. The dual unique keys prevent
-- both duplicate retries and accidental attribution of one preflight source to two requests.
CREATE TABLE public.analysis_v2_cost_attributions (
    request_id UUID NOT NULL
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    preflight_id UUID NOT NULL,
    order_id UUID REFERENCES public.earlybird_orders(id) ON DELETE SET NULL,
    source_kind TEXT NOT NULL,
    source_operation_key TEXT NOT NULL,
    source_identity_hash VARCHAR(64) NOT NULL,
    attributed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, source_kind, source_operation_key),
    UNIQUE (preflight_id, source_kind, source_operation_key),
    UNIQUE (source_identity_hash),
    CONSTRAINT analysis_v2_cost_attribution_kind_check CHECK (
        source_kind = 'preflight_provider_run'
    ),
    CONSTRAINT analysis_v2_cost_attribution_operation_check CHECK (
        source_operation_key = 'target-profile-fallback'
        OR source_operation_key ~ '^target-profile-fresh-admission:g([1-9]|[1-9][0-9]|100)$'
    ),
    CONSTRAINT analysis_v2_cost_attribution_hash_check CHECK (
        source_identity_hash ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT analysis_v2_cost_attribution_time_check CHECK (
        updated_at >= attributed_at
    )
);

CREATE INDEX analysis_v2_cost_attributions_request_idx
    ON public.analysis_v2_cost_attributions(request_id, preflight_id);
CREATE INDEX analysis_v2_cost_attributions_order_idx
    ON public.analysis_v2_cost_attributions(order_id, request_id)
    WHERE order_id IS NOT NULL;

ALTER TABLE public.analysis_v2_cost_attributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_cost_attributions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_cost_attributions
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_cost_attributions IS
    'Service-only, PII-free mapping from a consumed preflight provider operation to its eventual V2 request/order. It stores no amount or user identifier.';
COMMENT ON COLUMN public.analysis_v2_cost_attributions.source_identity_hash IS
    'Domain-separated SHA-256 of the preflight and operation identity; raw provider/run identities are never exposed by the rollup.';

CREATE OR REPLACE FUNCTION public.analysis_v2_sync_cost_attributions(
    p_preflight_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request_id UUID;
    v_order_id UUID;
    v_inserted INTEGER := 0;
BEGIN
    IF p_preflight_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_COST_ATTRIBUTION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.consumed_request_id
      INTO v_request_id
      FROM public.analysis_preflights AS preflight
     WHERE preflight.id = p_preflight_id
       AND preflight.status = 'consumed'
       AND preflight.consumed_request_id IS NOT NULL;
    IF v_request_id IS NULL THEN
        RETURN 0;
    END IF;

    SELECT earlybird_order.id
      INTO v_order_id
      FROM public.earlybird_orders AS earlybird_order
     WHERE earlybird_order.preflight_id = p_preflight_id
       AND (
            earlybird_order.result_request_id IS NULL
            OR earlybird_order.result_request_id = v_request_id
       )
     ORDER BY earlybird_order.id
     LIMIT 1;

    INSERT INTO public.analysis_v2_cost_attributions (
        request_id,
        preflight_id,
        order_id,
        source_kind,
        source_operation_key,
        source_identity_hash
    )
    SELECT
        v_request_id,
        provider_run.preflight_id,
        v_order_id,
        'preflight_provider_run',
        provider_run.operation_key,
        pg_catalog.encode(
            extensions.digest(
                pg_catalog.convert_to(
                    'analysis-v2-cost-source:v1' || pg_catalog.chr(10)
                    || provider_run.preflight_id::TEXT || pg_catalog.chr(10)
                    || provider_run.operation_key,
                    'UTF8'
                ),
                'sha256'
            ),
            'hex'
        )
      FROM public.analysis_preflight_provider_runs AS provider_run
     WHERE provider_run.preflight_id = p_preflight_id
    ON CONFLICT (request_id, source_kind, source_operation_key) DO UPDATE
       SET order_id = COALESCE(
            public.analysis_v2_cost_attributions.order_id,
            EXCLUDED.order_id
       ),
           updated_at = CASE
               WHEN public.analysis_v2_cost_attributions.order_id IS NULL
                    AND EXCLUDED.order_id IS NOT NULL
                   THEN pg_catalog.clock_timestamp()
               ELSE public.analysis_v2_cost_attributions.updated_at
           END
     WHERE public.analysis_v2_cost_attributions.order_id IS NULL
       AND EXCLUDED.order_id IS NOT NULL;

    GET DIAGNOSTICS v_inserted = ROW_COUNT;
    RETURN v_inserted;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_sync_cost_attributions(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_cost_attribution_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_TABLE_NAME = 'analysis_preflights' THEN
        PERFORM public.analysis_v2_sync_cost_attributions(NEW.id);
    ELSIF TG_TABLE_NAME = 'analysis_preflight_provider_runs' THEN
        PERFORM public.analysis_v2_sync_cost_attributions(NEW.preflight_id);
    ELSE
        PERFORM public.analysis_v2_sync_cost_attributions(NEW.preflight_id);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_cost_attribution_trigger()
    FROM PUBLIC, anon, authenticated, service_role;

-- Every consumption path already updates consumed_request_id. A trigger gives production,
-- test_entitlement, Basic, Standard, and Plus identical coverage without changing each admission
-- RPC and without making a provider retry an additional billable attribution.
DROP TRIGGER IF EXISTS analysis_v2_cost_attribution_preflight_consumed
    ON public.analysis_preflights;
CREATE TRIGGER analysis_v2_cost_attribution_preflight_consumed
AFTER UPDATE OF consumed_request_id, status ON public.analysis_preflights
FOR EACH ROW
WHEN (NEW.status = 'consumed' AND NEW.consumed_request_id IS NOT NULL)
EXECUTE FUNCTION public.analysis_v2_cost_attribution_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_attribution_preflight_provider
    ON public.analysis_preflight_provider_runs;
CREATE TRIGGER analysis_v2_cost_attribution_preflight_provider
AFTER INSERT OR UPDATE OF operation_key, run_id, status, actual_usage_usd, usage_reconciled_at
ON public.analysis_preflight_provider_runs
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_cost_attribution_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_attribution_order
    ON public.earlybird_orders;
CREATE TRIGGER analysis_v2_cost_attribution_order
AFTER INSERT OR UPDATE OF preflight_id, result_request_id ON public.earlybird_orders
FOR EACH ROW
-- Do not re-enter attribution when ON DELETE SET NULL clears result_request_id during request purge.
WHEN (NEW.result_request_id IS NOT NULL)
EXECUTE FUNCTION public.analysis_v2_cost_attribution_trigger();

-- Backfill already-consumed V2 requests once. This is only a map insert; source ledgers remain
-- unchanged and each source operation is protected by both unique constraints above.
DO $backfill$
DECLARE
    v_preflight RECORD;
BEGIN
    FOR v_preflight IN
        SELECT preflight.id
          FROM public.analysis_preflights AS preflight
         WHERE preflight.status = 'consumed'
           AND preflight.consumed_request_id IS NOT NULL
    LOOP
        PERFORM public.analysis_v2_sync_cost_attributions(v_preflight.id);
    END LOOP;
END;
$backfill$;

-- A view keeps current detail joined to the authoritative ledgers. Every source operation appears
-- in exactly one aggregate CTE, so preflight rows cannot be counted once through the short-lived
-- provider ledger and again through its long-lived acquisition event.
CREATE VIEW public.analysis_v2_cost_rollups AS
WITH preflight_sources AS (
    SELECT
        attribution.request_id,
        attribution.preflight_id,
        attribution.order_id,
        attribution.source_operation_key,
        provider_run.preflight_id AS joined_preflight_id,
        provider_run.logical_provider,
        provider_run.actor_id,
        provider_run.credential_slot,
        provider_run.status,
        provider_run.run_id,
        provider_run.max_charge_usd,
        provider_run.actual_usage_usd,
        provider_run.terminalized_at,
        provider_run.usage_reconciled_at
    FROM public.analysis_v2_cost_attributions AS attribution
    LEFT JOIN public.analysis_preflight_provider_runs AS provider_run
      ON provider_run.preflight_id = attribution.preflight_id
     AND provider_run.operation_key = attribution.source_operation_key
    WHERE attribution.source_kind = 'preflight_provider_run'
),
-- A consumed selfhosted_auth preflight intentionally has no paid-provider run. Keep this
-- explicit zero/no-call fact separate from an anonymous/cache path, where the existing schema
-- does not prove that the target was served from cache and the absence remains unknown.
preflight_zero_sources AS (
    SELECT
        preflight.consumed_request_id AS request_id,
        preflight.id AS preflight_id,
        CASE WHEN preflight.provider_selector = 'selfhosted_auth' THEN 1 ELSE 0 END
            AS no_paid_provider_count,
        CASE WHEN preflight.provider_selector = 'selfhosted_auth' THEN 0 ELSE 1 END
            AS usage_unknown_count,
        CASE WHEN preflight.provider_selector = 'selfhosted_auth' THEN 1 ELSE 0 END
            AS no_call_count,
        CASE WHEN preflight.provider_selector = 'selfhosted_auth'
            THEN pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'sourceKind', 'preflight_selfhosted_auth',
                    'provider', 'selfhosted_auth',
                    'status', preflight.status,
                    'providerChargeUsd', 0::NUMERIC,
                    'chargeKind', 'no_paid_provider',
                    'noCall', TRUE,
                    'usageUnknown', FALSE
                )
            )
            ELSE '[]'::JSONB
        END AS provenance
    FROM public.analysis_preflights AS preflight
    WHERE preflight.status = 'consumed'
      AND preflight.consumed_request_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_v2_cost_attributions AS attribution
          WHERE attribution.request_id = preflight.consumed_request_id
            AND attribution.preflight_id = preflight.id
            AND attribution.source_kind = 'preflight_provider_run'
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_preflight_provider_runs AS provider_run
          WHERE provider_run.preflight_id = preflight.id
      )
),
preflight_rollup AS (
    SELECT
        source.request_id,
        (pg_catalog.array_agg(source.preflight_id ORDER BY source.preflight_id))[1]
            AS preflight_id,
        (pg_catalog.array_agg(source.order_id ORDER BY source.order_id)
            FILTER (WHERE source.order_id IS NOT NULL))[1] AS order_id,
        pg_catalog.count(*)::INTEGER AS source_count,
        pg_catalog.count(source.joined_preflight_id)::INTEGER AS joined_source_count,
        pg_catalog.count(*) FILTER (
            WHERE source.joined_preflight_id IS NULL
               OR source.status IN ('starting', 'running')
               OR source.status = 'resolved_identity_drift'
               OR source.actual_usage_usd IS NULL
               OR source.usage_reconciled_at IS NULL
        )::INTEGER AS usage_unknown_count,
        pg_catalog.count(*) FILTER (
            WHERE source.joined_preflight_id IS NOT NULL
              AND source.status IN ('rejected', 'resolved_no_run')
              AND source.actual_usage_usd = 0
              AND source.usage_reconciled_at IS NOT NULL
        )::INTEGER AS no_call_count,
        pg_catalog.count(*) FILTER (
            WHERE source.joined_preflight_id IS NOT NULL
              AND source.logical_provider = 'apify'
              AND source.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
              AND source.run_id IS NOT NULL
              AND source.actual_usage_usd IS NOT NULL
              AND source.usage_reconciled_at IS NOT NULL
        )::INTEGER AS apify_actual_count,
        COALESCE(pg_catalog.sum(source.actual_usage_usd) FILTER (
            WHERE source.joined_preflight_id IS NOT NULL
              AND source.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
              AND source.run_id IS NOT NULL
              AND source.actual_usage_usd IS NOT NULL
              AND source.usage_reconciled_at IS NOT NULL
        ), 0::NUMERIC) AS actual_usd,
        COALESCE(pg_catalog.sum(source.actual_usage_usd) FILTER (
            WHERE source.joined_preflight_id IS NOT NULL
              AND source.logical_provider = 'apify'
              AND source.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
              AND source.run_id IS NOT NULL
              AND source.actual_usage_usd IS NOT NULL
              AND source.usage_reconciled_at IS NOT NULL
        ), 0::NUMERIC) AS apify_actual_usd,
        COALESCE(pg_catalog.sum(CASE
            WHEN source.joined_preflight_id IS NULL THEN 0::NUMERIC
            WHEN source.status IN ('rejected', 'resolved_no_run')
                 AND source.actual_usage_usd = 0
                THEN 0::NUMERIC
            WHEN source.status = 'resolved_identity_drift'
                THEN source.max_charge_usd
            WHEN source.actual_usage_usd IS NULL OR source.usage_reconciled_at IS NULL
                THEN source.max_charge_usd
            ELSE source.actual_usage_usd
        END), 0::NUMERIC) AS conservative_usd,
        COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sourceKind', 'preflight_provider_run',
                'operationKey', source.source_operation_key,
                'provider', source.logical_provider,
                'actor', source.actor_id,
                'credentialSlot', source.credential_slot,
                'status', source.status,
                'actualChargeUsd', CASE
                    WHEN source.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                         AND source.run_id IS NOT NULL
                         AND source.actual_usage_usd IS NOT NULL
                         AND source.usage_reconciled_at IS NOT NULL
                        THEN source.actual_usage_usd
                    ELSE NULL
                END,
                'conservativeEstimateUsd', CASE
                    WHEN source.status = 'resolved_identity_drift'
                        THEN source.max_charge_usd
                    WHEN source.status IN ('starting', 'running')
                         OR source.actual_usage_usd IS NULL
                         OR source.usage_reconciled_at IS NULL
                        THEN source.max_charge_usd
                    ELSE NULL
                END,
                'noCall', source.status IN ('rejected', 'resolved_no_run')
                    AND source.actual_usage_usd = 0
                    AND source.usage_reconciled_at IS NOT NULL,
                'usageUnknown', source.joined_preflight_id IS NULL
                    OR source.status IN ('starting', 'running')
                    OR source.status = 'resolved_identity_drift'
                    OR source.actual_usage_usd IS NULL
                    OR source.usage_reconciled_at IS NULL
            ) ORDER BY source.source_operation_key
        ) FILTER (WHERE source.joined_preflight_id IS NOT NULL), '[]'::JSONB) AS provenance
    FROM preflight_sources AS source
    GROUP BY source.request_id
),
provider_rollup AS (
    SELECT
        provider_run.request_id,
        pg_catalog.count(*)::INTEGER AS run_count,
        pg_catalog.count(*) FILTER (
            WHERE provider_run.status IN ('starting', 'running')
        )::INTEGER AS active_count,
        pg_catalog.count(*) FILTER (
            WHERE provider_run.status IN ('starting', 'running')
               OR (
                    provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                    AND (
                        provider_run.manual_resolution_kind IS NOT NULL
                        OR provider_run.actual_usage_usd IS NULL
                        OR provider_run.usage_reconciled_at IS NULL
                    )
               )
        )::INTEGER AS usage_unknown_count,
        pg_catalog.count(*) FILTER (
            WHERE provider_run.status = 'rejected'
              AND provider_run.actual_usage_usd = 0
              AND provider_run.usage_reconciled_at IS NOT NULL
        )::INTEGER AS no_call_count,
        pg_catalog.count(*) FILTER (
            WHERE provider_run.logical_provider = 'apify'
              AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
              AND provider_run.run_id IS NOT NULL
              AND provider_run.manual_resolution_kind IS NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
        )::INTEGER AS apify_actual_count,
        pg_catalog.count(*) FILTER (
            WHERE provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
              AND provider_run.run_id IS NOT NULL
              AND provider_run.manual_resolution_kind IS NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
        )::INTEGER AS actual_count,
        COALESCE(pg_catalog.sum(provider_run.actual_usage_usd) FILTER (
            WHERE provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
              AND provider_run.run_id IS NOT NULL
              AND provider_run.manual_resolution_kind IS NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
        ), 0::NUMERIC) AS actual_usd,
        COALESCE(pg_catalog.sum(provider_run.actual_usage_usd) FILTER (
            WHERE provider_run.logical_provider = 'apify'
              AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
              AND provider_run.run_id IS NOT NULL
              AND provider_run.manual_resolution_kind IS NULL
              AND provider_run.actual_usage_usd IS NOT NULL
              AND provider_run.usage_reconciled_at IS NOT NULL
        ), 0::NUMERIC) AS apify_actual_usd,
        COALESCE(pg_catalog.sum(CASE
            WHEN provider_run.status = 'rejected'
                 AND provider_run.actual_usage_usd = 0
                THEN 0::NUMERIC
            WHEN provider_run.manual_resolution_kind = 'conservative_max_charge'
                THEN provider_run.max_charge_usd
            WHEN provider_run.status IN ('starting', 'running')
                 OR provider_run.actual_usage_usd IS NULL
                 OR provider_run.usage_reconciled_at IS NULL
                THEN provider_run.max_charge_usd
            ELSE provider_run.actual_usage_usd
        END), 0::NUMERIC) AS conservative_usd,
        COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sourceKind', 'analysis_provider_run',
                'operationKey', provider_run.operation_key,
                'provider', provider_run.logical_provider,
                'actor', provider_run.actor_id,
                'credentialSlot', provider_run.credential_slot,
                'status', provider_run.status,
                'actualChargeUsd', CASE
                    WHEN provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                         AND provider_run.run_id IS NOT NULL
                         AND provider_run.manual_resolution_kind IS NULL
                         AND provider_run.actual_usage_usd IS NOT NULL
                         AND provider_run.usage_reconciled_at IS NOT NULL
                        THEN provider_run.actual_usage_usd
                    ELSE NULL
                END,
                'conservativeEstimateUsd', CASE
                    WHEN provider_run.manual_resolution_kind = 'conservative_max_charge'
                        THEN provider_run.max_charge_usd
                    WHEN provider_run.status IN ('starting', 'running')
                         OR provider_run.actual_usage_usd IS NULL
                         OR provider_run.usage_reconciled_at IS NULL
                        THEN provider_run.max_charge_usd
                    ELSE NULL
                END,
                'noCall', provider_run.status = 'rejected'
                    AND provider_run.actual_usage_usd = 0
                    AND provider_run.usage_reconciled_at IS NOT NULL,
                'usageUnknown', provider_run.status IN ('starting', 'running')
                    OR provider_run.manual_resolution_kind IS NOT NULL
                    OR provider_run.actual_usage_usd IS NULL
                    OR provider_run.usage_reconciled_at IS NULL,
                'manualResolutionKind', provider_run.manual_resolution_kind
            ) ORDER BY provider_run.operation_key
        ), '[]'::JSONB) AS provenance
    FROM public.analysis_v2_provider_runs AS provider_run
    GROUP BY provider_run.request_id
),
ai_rollup AS (
    SELECT
        ai_attempt.request_id,
        pg_catalog.count(*)::INTEGER AS attempt_count,
        pg_catalog.count(*) FILTER (
            WHERE ai_attempt.status = 'reserved'
        )::INTEGER AS reserved_count,
        pg_catalog.count(*) FILTER (
            WHERE ai_attempt.status <> 'reserved'
              AND (
                  ai_attempt.usage_complete IS DISTINCT FROM TRUE
                  OR ai_attempt.metered_estimated_cost_usd IS NULL
                  OR ai_attempt.cache_read_tokens IS NULL
                  OR ai_attempt.canonical_model_name IS NULL
                  OR ai_attempt.pricing_version IS NULL
              )
        )::INTEGER AS usage_unknown_count,
        pg_catalog.count(*) FILTER (
            WHERE ai_attempt.status <> 'reserved'
              AND ai_attempt.usage_complete = TRUE
              AND ai_attempt.metered_estimated_cost_usd IS NOT NULL
              AND ai_attempt.cache_read_tokens IS NOT NULL
              AND ai_attempt.canonical_model_name IS NOT NULL
              AND ai_attempt.pricing_version IS NOT NULL
        )::INTEGER AS metered_cost_count,
        COALESCE(pg_catalog.sum(ai_attempt.metered_estimated_cost_usd) FILTER (
            WHERE ai_attempt.status <> 'reserved'
              AND ai_attempt.usage_complete = TRUE
              AND ai_attempt.metered_estimated_cost_usd IS NOT NULL
              AND ai_attempt.cache_read_tokens IS NOT NULL
              AND ai_attempt.canonical_model_name IS NOT NULL
              AND ai_attempt.pricing_version IS NOT NULL
        ), 0::NUMERIC) AS metered_estimated_usd,
        COALESCE(pg_catalog.sum(ai_attempt.prompt_tokens) FILTER (
            WHERE ai_attempt.status <> 'reserved'
              AND ai_attempt.usage_complete = TRUE
              AND ai_attempt.prompt_tokens IS NOT NULL
              AND ai_attempt.cache_read_tokens IS NOT NULL
        ), 0::BIGINT) AS input_tokens,
        COALESCE(pg_catalog.sum(
            ai_attempt.completion_tokens + ai_attempt.thinking_tokens
        ) FILTER (
            WHERE ai_attempt.status <> 'reserved'
              AND ai_attempt.usage_complete = TRUE
              AND ai_attempt.completion_tokens IS NOT NULL
              AND ai_attempt.thinking_tokens IS NOT NULL
              AND ai_attempt.cache_read_tokens IS NOT NULL
        ), 0::BIGINT) AS output_tokens,
        COALESCE(pg_catalog.sum(ai_attempt.cache_read_tokens) FILTER (
            WHERE ai_attempt.status <> 'reserved'
              AND ai_attempt.usage_complete = TRUE
              AND ai_attempt.cache_read_tokens IS NOT NULL
        ), 0::BIGINT) AS cache_tokens,
        COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'canonicalModelName', ai_attempt.canonical_model_name,
                'modelName', ai_attempt.model_name,
                'modelLocation', ai_attempt.location,
                'pricingVersion', ai_attempt.pricing_version,
                'attempt', ai_attempt.attempt,
                'status', ai_attempt.status,
                'usageUnknown', ai_attempt.usage_complete IS DISTINCT FROM TRUE
                    OR ai_attempt.metered_estimated_cost_usd IS NULL
                    OR ai_attempt.cache_read_tokens IS NULL
                    OR ai_attempt.canonical_model_name IS NULL
                    OR ai_attempt.pricing_version IS NULL,
                'meteredEstimatedCostUsd', ai_attempt.metered_estimated_cost_usd
            ) ORDER BY ai_attempt.operation_key, ai_attempt.attempt
        ) FILTER (WHERE ai_attempt.status <> 'reserved'), '[]'::JSONB) AS provenance
    FROM public.analysis_v2_ai_attempts AS ai_attempt
    GROUP BY ai_attempt.request_id
),
cache_rollup AS (
    SELECT
        checkpoint.request_id,
        pg_catalog.count(*) FILTER (
            WHERE checkpoint.source = 'global_cache'
        )::INTEGER AS cache_hit_count
    FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
    GROUP BY checkpoint.request_id
),
selfhosted_rollup AS (
    SELECT
        receipt.request_id,
        pg_catalog.count(*)::INTEGER AS no_paid_provider_count,
        COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'sourceKind', 'selfhosted_auth',
                'operationKey', receipt.operation_key,
                'provider', 'selfhosted_auth',
                'status', 'succeeded',
                'providerChargeUsd', 0::NUMERIC,
                'chargeKind', 'no_paid_provider',
                'usageUnknown', FALSE
            ) ORDER BY receipt.operation_key
        ), '[]'::JSONB) AS provenance
    FROM public.analysis_v2_selfhosted_auth_runs AS receipt
    GROUP BY receipt.request_id
),
-- v2.12's shared monetary guard is a second, intentionally non-billable cross-check. Its
-- `actual_cost_usd` is the metered response estimate used to settle a reservation, not an
-- invoice actual, and this view never sums it. A non-cancelled reservation must match one
-- token-ledger attempt by request/run, operation, attempt, model, and location.
vertex_budget_rollup AS (
    SELECT
        reservation.run_id AS request_id_text,
        pg_catalog.count(*)::INTEGER AS reservation_count,
        pg_catalog.count(*) FILTER (
            WHERE reservation.state = 'reserved'
               OR reservation.usage_unknown
               OR reservation.actual_cost_usd IS NULL
        )::INTEGER AS usage_unknown_count,
        pg_catalog.count(*) FILTER (
            WHERE ai_attempt.request_id IS NULL
        )::INTEGER AS unmatched_count,
        pg_catalog.count(*)
            - pg_catalog.count(DISTINCT (reservation.operation_key, reservation.attempt))
            AS duplicate_count,
        pg_catalog.count(*) FILTER (
            WHERE ai_attempt.request_id IS NOT NULL
        )::INTEGER AS matched_count,
        pg_catalog.count(*) FILTER (
            WHERE ai_attempt.request_id IS NOT NULL
              AND (
                  reservation.model_name IS DISTINCT FROM ai_attempt.model_name
                  OR reservation.model_location IS DISTINCT FROM ai_attempt.location
                  OR reservation.usage_unknown IS DISTINCT FROM (
                      ai_attempt.metered_estimated_cost_usd IS NULL
                  )
                  OR reservation.actual_cost_usd IS DISTINCT FROM ai_attempt.metered_estimated_cost_usd
              )
        )::INTEGER AS mismatch_count,
        COALESCE(pg_catalog.sum(CASE
            -- The reservation estimate is a conservative upper bound, not another charge. Add
            -- only the still-uncovered delta for an uncertain reservation; a settled, complete
            -- attempt remains counted once from analysis_v2_ai_attempts above.
            WHEN reservation.state = 'reserved'
              OR reservation.usage_unknown
              OR ai_attempt.request_id IS NULL
              OR reservation.usage_unknown IS DISTINCT FROM (
                  ai_attempt.metered_estimated_cost_usd IS NULL
              )
              OR reservation.actual_cost_usd IS DISTINCT FROM ai_attempt.metered_estimated_cost_usd
                THEN GREATEST(
                    reservation.estimated_cost_usd - COALESCE(
                        CASE
                            WHEN ai_attempt.status <> 'reserved'
                             AND ai_attempt.usage_complete = TRUE
                             AND ai_attempt.metered_estimated_cost_usd IS NOT NULL
                             AND ai_attempt.cache_read_tokens IS NOT NULL
                             AND ai_attempt.canonical_model_name IS NOT NULL
                             AND ai_attempt.pricing_version IS NOT NULL
                                THEN ai_attempt.metered_estimated_cost_usd
                            ELSE 0::NUMERIC
                        END,
                        0::NUMERIC
                    ),
                    0::NUMERIC
                )
            ELSE 0::NUMERIC
        END), 0::NUMERIC) AS conservative_fallback_usd
    FROM public.vertex_ai_budget_reservations AS reservation
    LEFT JOIN public.analysis_v2_ai_attempts AS ai_attempt
      ON reservation.run_id = ai_attempt.request_id::TEXT
     AND reservation.operation_key = ai_attempt.operation_key
     AND reservation.attempt = ai_attempt.attempt
     AND reservation.model_name = ai_attempt.model_name
     AND reservation.model_location = ai_attempt.location
    WHERE reservation.state <> 'cancelled'
    GROUP BY reservation.run_id
),
order_rollup AS (
    SELECT
        earlybird_order.result_request_id AS request_id,
        (pg_catalog.array_agg(earlybird_order.id ORDER BY earlybird_order.id))[1] AS order_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.result_request_id IS NOT NULL
    GROUP BY earlybird_order.result_request_id
)
SELECT
    'analysis-v2-cost-rollup-v1'::TEXT AS rollup_version,
    'analysis-v2-direct-provider-and-vertex-metered-v1'::TEXT AS cost_scope,
    FALSE AS infrastructure_included,
    request.id AS request_id,
    COALESCE(preflight_source.preflight_id, preflight_zero.preflight_id, request.preflight_id)
        AS preflight_id,
    COALESCE(preflight_source.order_id, order_source.order_id) AS order_id,
    request.selected_plan_id_snapshot AS plan_id,
    request.plan_access_mode_snapshot AS access_mode,
    request.status AS request_status,
    request.created_at,
    request.completed_at,
    COALESCE(preflight_source.source_count, 0)::INTEGER AS preflight_provider_run_count,
    COALESCE(preflight_source.joined_source_count, 0)::INTEGER
        AS preflight_attributed_provider_run_count,
    GREATEST(
        COALESCE(preflight_source.source_count, 0)
            - COALESCE(preflight_source.joined_source_count, 0),
        0
    )::INTEGER AS preflight_attribution_gap_count,
    (
        COALESCE(preflight_source.source_count, 0) = 0
        AND COALESCE(preflight_zero.no_paid_provider_count, 0) = 0
    ) AS preflight_coverage_unknown,
    COALESCE(preflight_source.usage_unknown_count, 0)
        + COALESCE(preflight_zero.usage_unknown_count, 0)::INTEGER
        AS preflight_usage_unknown_count,
    COALESCE(preflight_source.no_call_count, 0)::INTEGER
        + COALESCE(preflight_zero.no_call_count, 0)::INTEGER AS preflight_no_call_count,
    COALESCE(preflight_zero.no_paid_provider_count, 0)::INTEGER
        AS preflight_no_paid_provider_count,
    COALESCE(preflight_source.apify_actual_count, 0)::INTEGER
        AS preflight_apify_actual_count,
    COALESCE(preflight_source.actual_usd, 0::NUMERIC) AS preflight_provider_actual_usd,
    COALESCE(preflight_source.apify_actual_usd, 0::NUMERIC)
        AS preflight_apify_actual_charge_usd,
    COALESCE(preflight_source.conservative_usd, 0::NUMERIC)
        AS preflight_provider_conservative_usd,
    COALESCE(provider.run_count, 0)::INTEGER AS provider_run_count,
    COALESCE(provider.active_count, 0)::INTEGER AS provider_active_count,
    COALESCE(provider.usage_unknown_count, 0)::INTEGER AS provider_usage_unknown_count,
    COALESCE(provider.no_call_count, 0)::INTEGER AS provider_no_call_count,
    CASE
        WHEN COALESCE(provider.run_count, 0) = 0
             AND COALESCE(selfhosted.no_paid_provider_count, 0) = 0
            THEN 1 ELSE 0
    END AS provider_coverage_gap_count,
    COALESCE(provider.actual_count, 0)::INTEGER AS provider_actual_count,
    COALESCE(provider.apify_actual_count, 0)::INTEGER AS provider_apify_actual_count,
    COALESCE(provider.actual_usd, 0::NUMERIC) AS provider_actual_usd,
    COALESCE(provider.apify_actual_usd, 0::NUMERIC) AS apify_actual_charge_usd,
    COALESCE(provider.conservative_usd, 0::NUMERIC) AS provider_conservative_usd,
    COALESCE(ai.attempt_count, 0)::INTEGER AS ai_attempt_count,
    COALESCE(ai.reserved_count, 0)::INTEGER AS ai_reserved_count,
    COALESCE(ai.usage_unknown_count, 0)::INTEGER AS ai_usage_unknown_count,
    COALESCE(ai.metered_cost_count, 0)::INTEGER AS ai_metered_cost_count,
    COALESCE(ai.metered_estimated_usd, 0::NUMERIC) AS metered_estimated_cost_usd,
    COALESCE(ai.input_tokens, 0::BIGINT) AS ai_input_tokens,
    COALESCE(ai.output_tokens, 0::BIGINT) AS ai_output_tokens,
    COALESCE(ai.cache_tokens, 0::BIGINT) AS ai_cache_tokens,
    COALESCE(cache.cache_hit_count, 0)::INTEGER AS cache_hit_count,
    CASE
        WHEN COALESCE(ai.attempt_count, 0) = 0
             AND COALESCE(cache.cache_hit_count, 0) = 0
            THEN 1 ELSE 0
    END AS ai_coverage_gap_count,
    COALESCE(selfhosted.no_paid_provider_count, 0)::INTEGER
        AS selfhosted_no_paid_provider_count,
    COALESCE(vertex_budget.reservation_count, 0)::INTEGER
        AS vertex_budget_reservation_count,
    COALESCE(vertex_budget.matched_count, 0)::INTEGER
        AS vertex_budget_matched_count,
    COALESCE(vertex_budget.unmatched_count, 0)::INTEGER
        AS vertex_budget_unmatched_count,
    COALESCE(vertex_budget.usage_unknown_count, 0)::INTEGER
        AS vertex_budget_usage_unknown_count,
    COALESCE(vertex_budget.duplicate_count, 0)::INTEGER
        AS vertex_budget_duplicate_count,
    COALESCE(vertex_budget.mismatch_count, 0)::INTEGER
        AS vertex_budget_mismatch_count,
    COALESCE(vertex_budget.conservative_fallback_usd, 0::NUMERIC)
        AS vertex_budget_conservative_fallback_usd,
    CASE
        WHEN request.policy_versions_snapshot->>'aiStage' = 'ai-stage-policy-v2.12'
             AND COALESCE(vertex_budget.reservation_count, 0) = 0
             AND COALESCE(cache.cache_hit_count, 0) = 0
            THEN 1 ELSE 0
    END AS vertex_budget_coverage_gap_count,
    COALESCE(preflight_source.no_call_count, 0)
        + COALESCE(preflight_zero.no_call_count, 0)::INTEGER
        + COALESCE(provider.no_call_count, 0)::INTEGER AS provider_no_call_count_total,
    COALESCE(preflight_source.no_call_count, 0)
        + COALESCE(preflight_zero.no_call_count, 0)::INTEGER
        + COALESCE(provider.no_call_count, 0)::INTEGER
        + COALESCE(cache.cache_hit_count, 0)::INTEGER AS no_call_count,
    COALESCE(preflight_source.actual_usd, 0::NUMERIC)
        + COALESCE(provider.actual_usd, 0::NUMERIC) AS provider_actual_total_usd,
    COALESCE(preflight_source.conservative_usd, 0::NUMERIC)
        + COALESCE(provider.conservative_usd, 0::NUMERIC)
        AS provider_conservative_total_usd,
    COALESCE(preflight_source.actual_usd, 0::NUMERIC)
        + COALESCE(provider.actual_usd, 0::NUMERIC)
        + COALESCE(ai.metered_estimated_usd, 0::NUMERIC) AS total_known_cost_usd,
    COALESCE(preflight_source.conservative_usd, 0::NUMERIC)
        + COALESCE(provider.conservative_usd, 0::NUMERIC)
        + COALESCE(ai.metered_estimated_usd, 0::NUMERIC)
        + COALESCE(vertex_budget.conservative_fallback_usd, 0::NUMERIC)
        AS total_conservative_cost_usd,
    COALESCE(preflight_source.provenance, '[]'::JSONB)
        || COALESCE(preflight_zero.provenance, '[]'::JSONB)
        || COALESCE(provider.provenance, '[]'::JSONB)
        || COALESCE(ai.provenance, '[]'::JSONB)
        || COALESCE(selfhosted.provenance, '[]'::JSONB) AS cost_provenance,
    (
        request.status IN ('completed', 'failed')
        AND COALESCE(preflight_source.source_count, 0)
            = COALESCE(preflight_source.joined_source_count, 0)
        AND (
            COALESCE(preflight_source.source_count, 0) > 0
            OR COALESCE(preflight_zero.no_paid_provider_count, 0) > 0
        )
        AND GREATEST(
            COALESCE(preflight_source.source_count, 0)
                - COALESCE(preflight_source.joined_source_count, 0),
            0
        ) = 0
        AND COALESCE(preflight_source.usage_unknown_count, 0)
            + COALESCE(preflight_zero.usage_unknown_count, 0) = 0
        AND COALESCE(provider.active_count, 0) = 0
        AND COALESCE(provider.usage_unknown_count, 0) = 0
        AND (
            COALESCE(provider.run_count, 0) > 0
            OR COALESCE(selfhosted.no_paid_provider_count, 0) > 0
        )
        AND COALESCE(ai.reserved_count, 0) = 0
        AND COALESCE(ai.usage_unknown_count, 0) = 0
        AND (
            COALESCE(ai.attempt_count, 0) > 0
            OR COALESCE(cache.cache_hit_count, 0) > 0
        )
        AND (
            request.policy_versions_snapshot->>'aiStage'
                IS DISTINCT FROM 'ai-stage-policy-v2.12'
            OR (
                (
                    COALESCE(vertex_budget.reservation_count, 0) > 0
                    AND COALESCE(vertex_budget.unmatched_count, 0) = 0
                    AND COALESCE(vertex_budget.usage_unknown_count, 0) = 0
                    AND COALESCE(vertex_budget.duplicate_count, 0) = 0
                    AND COALESCE(vertex_budget.mismatch_count, 0) = 0
                )
                OR (
                    COALESCE(vertex_budget.reservation_count, 0) = 0
                    AND COALESCE(cache.cache_hit_count, 0) > 0
                )
            )
        )
    ) AS directly_attributable_cost_complete,
    (
        GREATEST(
            COALESCE(preflight_source.source_count, 0)
                - COALESCE(preflight_source.joined_source_count, 0),
            0
        )
        + CASE
            WHEN COALESCE(preflight_source.source_count, 0) = 0
             AND COALESCE(preflight_zero.no_paid_provider_count, 0) = 0
                THEN 1 ELSE 0
          END
        + COALESCE(preflight_source.usage_unknown_count, 0)
        + COALESCE(preflight_zero.usage_unknown_count, 0)
        + COALESCE(provider.usage_unknown_count, 0)
        + COALESCE(ai.usage_unknown_count, 0)
        + COALESCE(ai.reserved_count, 0)
        + CASE
            WHEN COALESCE(provider.run_count, 0) = 0
                 AND COALESCE(selfhosted.no_paid_provider_count, 0) = 0
                THEN 1 ELSE 0
          END
        + CASE
            WHEN COALESCE(ai.attempt_count, 0) = 0
                 AND COALESCE(cache.cache_hit_count, 0) = 0
                THEN 1 ELSE 0
          END
        + CASE
            WHEN request.policy_versions_snapshot->>'aiStage' IS NOT DISTINCT FROM 'ai-stage-policy-v2.12'
                THEN COALESCE(vertex_budget.unmatched_count, 0)
                   + COALESCE(vertex_budget.usage_unknown_count, 0)
                   + COALESCE(vertex_budget.duplicate_count, 0)
                   + COALESCE(vertex_budget.mismatch_count, 0)
                   + CASE WHEN COALESCE(vertex_budget.reservation_count, 0) = 0
                              AND COALESCE(cache.cache_hit_count, 0) = 0
                        THEN 1 ELSE 0 END
            ELSE 0
          END
    ) > 0 AS usage_unknown
FROM public.analysis_requests AS request
LEFT JOIN preflight_rollup AS preflight_source
  ON preflight_source.request_id = request.id
LEFT JOIN preflight_zero_sources AS preflight_zero
  ON preflight_zero.request_id = request.id
LEFT JOIN provider_rollup AS provider
  ON provider.request_id = request.id
LEFT JOIN ai_rollup AS ai
  ON ai.request_id = request.id
LEFT JOIN cache_rollup AS cache
  ON cache.request_id = request.id
LEFT JOIN selfhosted_rollup AS selfhosted
  ON selfhosted.request_id = request.id
LEFT JOIN vertex_budget_rollup AS vertex_budget
  ON vertex_budget.request_id_text = request.id::TEXT
LEFT JOIN order_rollup AS order_source
  ON order_source.request_id = request.id
WHERE request.pipeline_version = 'v2'
  AND request.plan_access_mode_snapshot IN ('production', 'test_entitlement')
  AND request.selected_plan_id_snapshot IN ('basic', 'standard', 'plus');

REVOKE ALL ON public.analysis_v2_cost_rollups
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.analysis_v2_cost_rollups TO service_role;

COMMENT ON VIEW public.analysis_v2_cost_rollups IS
    'Service-role-only live per-request/order rollup, scope analysis-v2-direct-provider-and-vertex-metered-v1. Apify actual charges and Vertex/Gemini metered estimates are explicitly separate; infrastructureIncluded=false excludes shared Cloud Run, Cloud Tasks, Supabase, Vercel, and email overhead. directly_attributable_cost_complete means directly attributable source coverage only, never a fully loaded invoice claim; no user identifier is selected.';

-- Completed requests can outlive their working-set ledgers: request deletion cascades the V2
-- provider, AI, checkpoint, and preflight rows. Keep one minimal PII-free tombstone per request so
-- historical plan averages remain valid after that purge. This is a derived retention snapshot,
-- not a second provider fact; source provenance and completeness are retained for auditability.
CREATE TABLE public.analysis_v2_cost_rollup_snapshots (
    rollup_version TEXT NOT NULL,
    cost_scope TEXT NOT NULL,
    infrastructure_included BOOLEAN NOT NULL,
    request_id UUID PRIMARY KEY,
    preflight_id UUID,
    order_id UUID,
    plan_id TEXT NOT NULL,
    access_mode TEXT NOT NULL,
    request_status TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    completed_at TIMESTAMP WITH TIME ZONE,
    preflight_provider_run_count INTEGER NOT NULL,
    preflight_attributed_provider_run_count INTEGER NOT NULL,
    preflight_attribution_gap_count INTEGER NOT NULL,
    preflight_coverage_unknown BOOLEAN NOT NULL,
    preflight_usage_unknown_count INTEGER NOT NULL,
    preflight_no_call_count INTEGER NOT NULL,
    preflight_no_paid_provider_count INTEGER NOT NULL,
    preflight_apify_actual_count INTEGER NOT NULL,
    preflight_provider_actual_usd NUMERIC(18, 12) NOT NULL,
    preflight_apify_actual_charge_usd NUMERIC(18, 12) NOT NULL,
    preflight_provider_conservative_usd NUMERIC(18, 12) NOT NULL,
    provider_run_count INTEGER NOT NULL,
    provider_active_count INTEGER NOT NULL,
    provider_usage_unknown_count INTEGER NOT NULL,
    provider_no_call_count INTEGER NOT NULL,
    provider_coverage_gap_count INTEGER NOT NULL,
    provider_actual_count INTEGER NOT NULL,
    provider_apify_actual_count INTEGER NOT NULL,
    provider_actual_usd NUMERIC(18, 12) NOT NULL,
    apify_actual_charge_usd NUMERIC(18, 12) NOT NULL,
    provider_conservative_usd NUMERIC(18, 12) NOT NULL,
    ai_attempt_count INTEGER NOT NULL,
    ai_reserved_count INTEGER NOT NULL,
    ai_usage_unknown_count INTEGER NOT NULL,
    ai_metered_cost_count INTEGER NOT NULL,
    metered_estimated_cost_usd NUMERIC(18, 12) NOT NULL,
    ai_input_tokens BIGINT NOT NULL,
    ai_output_tokens BIGINT NOT NULL,
    ai_cache_tokens BIGINT NOT NULL,
    cache_hit_count INTEGER NOT NULL,
    ai_coverage_gap_count INTEGER NOT NULL,
    selfhosted_no_paid_provider_count INTEGER NOT NULL,
    vertex_budget_reservation_count INTEGER NOT NULL,
    vertex_budget_matched_count INTEGER NOT NULL,
    vertex_budget_unmatched_count INTEGER NOT NULL,
    vertex_budget_usage_unknown_count INTEGER NOT NULL,
    vertex_budget_duplicate_count INTEGER NOT NULL,
    vertex_budget_mismatch_count INTEGER NOT NULL,
    vertex_budget_conservative_fallback_usd NUMERIC(18, 12) NOT NULL,
    vertex_budget_coverage_gap_count INTEGER NOT NULL,
    provider_no_call_count_total INTEGER NOT NULL,
    no_call_count INTEGER NOT NULL,
    provider_actual_total_usd NUMERIC(18, 12) NOT NULL,
    provider_conservative_total_usd NUMERIC(18, 12) NOT NULL,
    total_known_cost_usd NUMERIC(18, 12) NOT NULL,
    total_conservative_cost_usd NUMERIC(18, 12) NOT NULL,
    cost_provenance JSONB NOT NULL,
    directly_attributable_cost_complete BOOLEAN NOT NULL,
    usage_unknown BOOLEAN NOT NULL,
    captured_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_v2_cost_snapshot_version_check CHECK (
        rollup_version = 'analysis-v2-cost-rollup-v1'
    ),
    CONSTRAINT analysis_v2_cost_snapshot_scope_check CHECK (
        cost_scope = 'analysis-v2-direct-provider-and-vertex-metered-v1'
        AND infrastructure_included = FALSE
    ),
    CONSTRAINT analysis_v2_cost_snapshot_plan_check CHECK (
        plan_id IN ('basic', 'standard', 'plus')
    ),
    CONSTRAINT analysis_v2_cost_snapshot_access_check CHECK (
        access_mode IN ('production', 'test_entitlement')
    ),
    CONSTRAINT analysis_v2_cost_snapshot_status_check CHECK (
        request_status IN ('pending', 'processing', 'completed', 'failed')
    ),
    CONSTRAINT analysis_v2_cost_snapshot_nonnegative_check CHECK (
        preflight_provider_run_count >= 0
        AND preflight_attributed_provider_run_count >= 0
        AND preflight_attribution_gap_count >= 0
        AND preflight_coverage_unknown IN (TRUE, FALSE)
        AND preflight_usage_unknown_count >= 0
        AND preflight_no_call_count >= 0
        AND preflight_no_paid_provider_count >= 0
        AND preflight_apify_actual_count >= 0
        AND preflight_provider_actual_usd >= 0
        AND preflight_apify_actual_charge_usd >= 0
        AND preflight_provider_conservative_usd >= 0
        AND provider_run_count >= 0
        AND provider_active_count >= 0
        AND provider_usage_unknown_count >= 0
        AND provider_no_call_count >= 0
        AND provider_coverage_gap_count >= 0
        AND provider_actual_count >= 0
        AND provider_apify_actual_count >= 0
        AND provider_actual_usd >= 0
        AND apify_actual_charge_usd >= 0
        AND provider_conservative_usd >= 0
        AND ai_attempt_count >= 0
        AND ai_reserved_count >= 0
        AND ai_usage_unknown_count >= 0
        AND ai_metered_cost_count >= 0
        AND metered_estimated_cost_usd >= 0
        AND ai_input_tokens >= 0
        AND ai_output_tokens >= 0
        AND ai_cache_tokens >= 0
        AND cache_hit_count >= 0
        AND ai_coverage_gap_count >= 0
        AND selfhosted_no_paid_provider_count >= 0
        AND vertex_budget_reservation_count >= 0
        AND vertex_budget_matched_count >= 0
        AND vertex_budget_unmatched_count >= 0
        AND vertex_budget_usage_unknown_count >= 0
        AND vertex_budget_duplicate_count >= 0
        AND vertex_budget_mismatch_count >= 0
        AND vertex_budget_conservative_fallback_usd >= 0
        AND vertex_budget_coverage_gap_count >= 0
        AND provider_no_call_count_total >= 0
        AND no_call_count >= 0
        AND provider_actual_total_usd >= 0
        AND provider_conservative_total_usd >= 0
        AND total_known_cost_usd >= 0
        AND total_conservative_cost_usd >= 0
    ),
    CONSTRAINT analysis_v2_cost_snapshot_time_check CHECK (
        updated_at >= captured_at
    )
);

CREATE INDEX analysis_v2_cost_rollup_snapshots_plan_idx
    ON public.analysis_v2_cost_rollup_snapshots(
        plan_id, access_mode, request_status, completed_at
    );
CREATE INDEX analysis_v2_cost_rollup_snapshots_order_idx
    ON public.analysis_v2_cost_rollup_snapshots(order_id, request_id)
    WHERE order_id IS NOT NULL;

ALTER TABLE public.analysis_v2_cost_rollup_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_cost_rollup_snapshots FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_cost_rollup_snapshots
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_cost_rollup_snapshots IS
    'Permanent service-only PII-free derived V2 cost snapshots. Deliberately has no foreign keys so request/preflight purge cannot erase plan-average history.';
COMMENT ON COLUMN public.analysis_v2_cost_rollup_snapshots.total_known_cost_usd IS
    'Directly attributable provider actuals plus Vertex/Gemini metered estimates only; shared infrastructure is excluded and this is not a fully loaded invoice total.';
COMMENT ON COLUMN public.analysis_v2_cost_rollup_snapshots.directly_attributable_cost_complete IS
    'Completeness of directly attributable ledgers only; infrastructure_included=false and this flag never claims fully loaded invoice coverage.';

CREATE OR REPLACE FUNCTION public.analysis_v2_refresh_cost_rollup_snapshot(
    p_request_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.analysis_v2_cost_rollup_snapshots (
        rollup_version,
        cost_scope,
        infrastructure_included,
        request_id,
        preflight_id,
        order_id,
        plan_id,
        access_mode,
        request_status,
        created_at,
        completed_at,
        preflight_provider_run_count,
        preflight_attributed_provider_run_count,
        preflight_attribution_gap_count,
        preflight_coverage_unknown,
        preflight_usage_unknown_count,
        preflight_no_call_count,
        preflight_no_paid_provider_count,
        preflight_apify_actual_count,
        preflight_provider_actual_usd,
        preflight_apify_actual_charge_usd,
        preflight_provider_conservative_usd,
        provider_run_count,
        provider_active_count,
        provider_usage_unknown_count,
        provider_no_call_count,
        provider_coverage_gap_count,
        provider_actual_count,
        provider_apify_actual_count,
        provider_actual_usd,
        apify_actual_charge_usd,
        provider_conservative_usd,
        ai_attempt_count,
        ai_reserved_count,
        ai_usage_unknown_count,
        ai_metered_cost_count,
        metered_estimated_cost_usd,
        ai_input_tokens,
        ai_output_tokens,
        ai_cache_tokens,
        cache_hit_count,
        ai_coverage_gap_count,
        selfhosted_no_paid_provider_count,
        vertex_budget_reservation_count,
        vertex_budget_matched_count,
        vertex_budget_unmatched_count,
        vertex_budget_usage_unknown_count,
        vertex_budget_duplicate_count,
        vertex_budget_mismatch_count,
        vertex_budget_conservative_fallback_usd,
        vertex_budget_coverage_gap_count,
        provider_no_call_count_total,
        no_call_count,
        provider_actual_total_usd,
        provider_conservative_total_usd,
        total_known_cost_usd,
        total_conservative_cost_usd,
        cost_provenance,
        directly_attributable_cost_complete,
        usage_unknown,
        captured_at,
        updated_at
    )
    SELECT
        rollup.rollup_version,
        rollup.cost_scope,
        rollup.infrastructure_included,
        rollup.request_id,
        rollup.preflight_id,
        rollup.order_id,
        rollup.plan_id,
        rollup.access_mode,
        rollup.request_status,
        rollup.created_at,
        rollup.completed_at,
        rollup.preflight_provider_run_count,
        rollup.preflight_attributed_provider_run_count,
        rollup.preflight_attribution_gap_count,
        rollup.preflight_coverage_unknown,
        rollup.preflight_usage_unknown_count,
        rollup.preflight_no_call_count,
        rollup.preflight_no_paid_provider_count,
        rollup.preflight_apify_actual_count,
        rollup.preflight_provider_actual_usd,
        rollup.preflight_apify_actual_charge_usd,
        rollup.preflight_provider_conservative_usd,
        rollup.provider_run_count,
        rollup.provider_active_count,
        rollup.provider_usage_unknown_count,
        rollup.provider_no_call_count,
        rollup.provider_coverage_gap_count,
        rollup.provider_actual_count,
        rollup.provider_apify_actual_count,
        rollup.provider_actual_usd,
        rollup.apify_actual_charge_usd,
        rollup.provider_conservative_usd,
        rollup.ai_attempt_count,
        rollup.ai_reserved_count,
        rollup.ai_usage_unknown_count,
        rollup.ai_metered_cost_count,
        rollup.metered_estimated_cost_usd,
        rollup.ai_input_tokens,
        rollup.ai_output_tokens,
        rollup.ai_cache_tokens,
        rollup.cache_hit_count,
        rollup.ai_coverage_gap_count,
        rollup.selfhosted_no_paid_provider_count,
        rollup.vertex_budget_reservation_count,
        rollup.vertex_budget_matched_count,
        rollup.vertex_budget_unmatched_count,
        rollup.vertex_budget_usage_unknown_count,
        rollup.vertex_budget_duplicate_count,
        rollup.vertex_budget_mismatch_count,
        rollup.vertex_budget_conservative_fallback_usd,
        rollup.vertex_budget_coverage_gap_count,
        rollup.provider_no_call_count_total,
        rollup.no_call_count,
        rollup.provider_actual_total_usd,
        rollup.provider_conservative_total_usd,
        rollup.total_known_cost_usd,
        rollup.total_conservative_cost_usd,
        rollup.cost_provenance,
        rollup.directly_attributable_cost_complete,
        rollup.usage_unknown,
        pg_catalog.clock_timestamp(),
        pg_catalog.clock_timestamp()
      FROM public.analysis_v2_cost_rollups AS rollup
     WHERE rollup.request_id = p_request_id
       AND rollup.request_status IN ('completed', 'failed')

    ON CONFLICT (request_id) DO UPDATE
       SET rollup_version = EXCLUDED.rollup_version,
           cost_scope = EXCLUDED.cost_scope,
           infrastructure_included = EXCLUDED.infrastructure_included,
           preflight_id = EXCLUDED.preflight_id,
           order_id = EXCLUDED.order_id,
           plan_id = EXCLUDED.plan_id,
           access_mode = EXCLUDED.access_mode,
           request_status = EXCLUDED.request_status,
           created_at = EXCLUDED.created_at,
           completed_at = EXCLUDED.completed_at,
           preflight_provider_run_count = EXCLUDED.preflight_provider_run_count,
           preflight_attributed_provider_run_count = EXCLUDED.preflight_attributed_provider_run_count,
           preflight_attribution_gap_count = EXCLUDED.preflight_attribution_gap_count,
           preflight_coverage_unknown = EXCLUDED.preflight_coverage_unknown,
           preflight_usage_unknown_count = EXCLUDED.preflight_usage_unknown_count,
           preflight_no_call_count = EXCLUDED.preflight_no_call_count,
           preflight_no_paid_provider_count = EXCLUDED.preflight_no_paid_provider_count,
           preflight_apify_actual_count = EXCLUDED.preflight_apify_actual_count,
           preflight_provider_actual_usd = EXCLUDED.preflight_provider_actual_usd,
           preflight_apify_actual_charge_usd = EXCLUDED.preflight_apify_actual_charge_usd,
           preflight_provider_conservative_usd = EXCLUDED.preflight_provider_conservative_usd,
           provider_run_count = EXCLUDED.provider_run_count,
           provider_active_count = EXCLUDED.provider_active_count,
           provider_usage_unknown_count = EXCLUDED.provider_usage_unknown_count,
           provider_no_call_count = EXCLUDED.provider_no_call_count,
           provider_coverage_gap_count = EXCLUDED.provider_coverage_gap_count,
           provider_actual_count = EXCLUDED.provider_actual_count,
           provider_apify_actual_count = EXCLUDED.provider_apify_actual_count,
           provider_actual_usd = EXCLUDED.provider_actual_usd,
           apify_actual_charge_usd = EXCLUDED.apify_actual_charge_usd,
           provider_conservative_usd = EXCLUDED.provider_conservative_usd,
           ai_attempt_count = EXCLUDED.ai_attempt_count,
           ai_reserved_count = EXCLUDED.ai_reserved_count,
           ai_usage_unknown_count = EXCLUDED.ai_usage_unknown_count,
           ai_metered_cost_count = EXCLUDED.ai_metered_cost_count,
           metered_estimated_cost_usd = EXCLUDED.metered_estimated_cost_usd,
           ai_input_tokens = EXCLUDED.ai_input_tokens,
           ai_output_tokens = EXCLUDED.ai_output_tokens,
           ai_cache_tokens = EXCLUDED.ai_cache_tokens,
           cache_hit_count = EXCLUDED.cache_hit_count,
           ai_coverage_gap_count = EXCLUDED.ai_coverage_gap_count,
           selfhosted_no_paid_provider_count = EXCLUDED.selfhosted_no_paid_provider_count,
           vertex_budget_reservation_count = EXCLUDED.vertex_budget_reservation_count,
           vertex_budget_matched_count = EXCLUDED.vertex_budget_matched_count,
           vertex_budget_unmatched_count = EXCLUDED.vertex_budget_unmatched_count,
           vertex_budget_usage_unknown_count = EXCLUDED.vertex_budget_usage_unknown_count,
           vertex_budget_duplicate_count = EXCLUDED.vertex_budget_duplicate_count,
           vertex_budget_mismatch_count = EXCLUDED.vertex_budget_mismatch_count,
           vertex_budget_conservative_fallback_usd = EXCLUDED.vertex_budget_conservative_fallback_usd,
           vertex_budget_coverage_gap_count = EXCLUDED.vertex_budget_coverage_gap_count,
           provider_no_call_count_total = EXCLUDED.provider_no_call_count_total,
           no_call_count = EXCLUDED.no_call_count,
           provider_actual_total_usd = EXCLUDED.provider_actual_total_usd,
           provider_conservative_total_usd = EXCLUDED.provider_conservative_total_usd,
           total_known_cost_usd = EXCLUDED.total_known_cost_usd,
           total_conservative_cost_usd = EXCLUDED.total_conservative_cost_usd,
           cost_provenance = EXCLUDED.cost_provenance,
           directly_attributable_cost_complete = EXCLUDED.directly_attributable_cost_complete,
           usage_unknown = EXCLUDED.usage_unknown,
           updated_at = pg_catalog.clock_timestamp();
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_refresh_cost_rollup_snapshot(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

-- Source rows may be reconciled after request terminalization. Refresh triggers keep the snapshot
-- current until the request is deleted; the BEFORE DELETE fence captures the final live rollup
-- while cascading child rows still exist. The snapshot has no source foreign keys, so this also
-- covers account/request deletion and the ON DELETE CASCADE working-set purge.
CREATE OR REPLACE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'analysis_requests' THEN
        v_request_id := NEW.id;
    ELSIF TG_TABLE_NAME IN (
        'analysis_v2_provider_runs',
        'analysis_v2_ai_attempts',
        'analysis_v2_ai_result_checkpoints',
        'analysis_v2_selfhosted_auth_runs'
    ) THEN
        v_request_id := NEW.request_id;
    ELSIF TG_TABLE_NAME = 'earlybird_orders' THEN
        v_request_id := NEW.result_request_id;
    ELSIF TG_TABLE_NAME = 'analysis_preflights' THEN
        v_request_id := NEW.consumed_request_id;
    ELSIF TG_TABLE_NAME = 'analysis_preflight_provider_runs' THEN
        SELECT preflight.consumed_request_id
          INTO v_request_id
          FROM public.analysis_preflights AS preflight
         WHERE preflight.id = NEW.preflight_id;
    ELSIF TG_TABLE_NAME = 'vertex_ai_budget_reservations' THEN
        SELECT request.id
          INTO v_request_id
          FROM public.analysis_requests AS request
         WHERE request.id::TEXT = NEW.run_id;
    END IF;

    PERFORM public.analysis_v2_refresh_cost_rollup_snapshot(v_request_id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_capture_cost_rollup_before_request_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.analysis_v2_refresh_cost_rollup_snapshot(OLD.id);
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_capture_cost_rollup_before_preflight_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- Account/preflight cleanup can be the outer delete that cascades into a request. Capture
    -- while the consumed request and preflight/provider source rows are still addressable.
    PERFORM public.analysis_v2_refresh_cost_rollup_snapshot(OLD.consumed_request_id);
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_capture_cost_rollup_before_request_delete()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_capture_cost_rollup_before_preflight_delete()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_request
    ON public.analysis_requests;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_request
AFTER INSERT OR UPDATE OF status ON public.analysis_requests
FOR EACH ROW
WHEN (NEW.status IN ('completed', 'failed'))
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_request_delete
    ON public.analysis_requests;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_request_delete
BEFORE DELETE ON public.analysis_requests
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_capture_cost_rollup_before_request_delete();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_preflight_delete
    ON public.analysis_preflights;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_preflight_delete
BEFORE DELETE ON public.analysis_preflights
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_capture_cost_rollup_before_preflight_delete();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_v2_provider
    ON public.analysis_v2_provider_runs;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_v2_provider
AFTER INSERT OR UPDATE OF status, run_id, actual_usage_usd, usage_reconciled_at,
    manual_resolution_kind, manual_resolution_evidence_hash, manual_resolved_at
ON public.analysis_v2_provider_runs
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_ai_attempt
    ON public.analysis_v2_ai_attempts;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_ai_attempt
AFTER INSERT OR UPDATE OF status, usage_metadata_status, usage_complete,
    prompt_tokens, completion_tokens, total_tokens, thinking_tokens,
    estimated_cost_usd, model_name, location, canonical_model_name, pricing_version, cache_read_tokens,
    metered_estimated_cost_usd
ON public.analysis_v2_ai_attempts
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_checkpoint
    ON public.analysis_v2_ai_result_checkpoints;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_checkpoint
AFTER INSERT OR UPDATE OF source, attempt, reservation_token
ON public.analysis_v2_ai_result_checkpoints
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_preflight
    ON public.analysis_preflights;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_preflight
AFTER UPDATE OF consumed_request_id, status ON public.analysis_preflights
FOR EACH ROW
WHEN (NEW.status = 'consumed' AND NEW.consumed_request_id IS NOT NULL)
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_preflight_provider
    ON public.analysis_preflight_provider_runs;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_preflight_provider
AFTER INSERT OR UPDATE OF operation_key, run_id, status, actual_usage_usd, usage_reconciled_at,
    terminalized_at, manual_resolution_evidence_hash, manual_resolved_at
ON public.analysis_preflight_provider_runs
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_selfhosted
    ON public.analysis_v2_selfhosted_auth_runs;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_selfhosted
AFTER INSERT OR UPDATE OF operation_key, updated_at
ON public.analysis_v2_selfhosted_auth_runs
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_order
    ON public.earlybird_orders;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_order
AFTER UPDATE OF result_request_id ON public.earlybird_orders
FOR EACH ROW
WHEN (NEW.result_request_id IS NOT NULL)
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

DROP TRIGGER IF EXISTS analysis_v2_cost_rollup_snapshot_budget
    ON public.vertex_ai_budget_reservations;
CREATE TRIGGER analysis_v2_cost_rollup_snapshot_budget
AFTER INSERT OR UPDATE OF run_id, operation_key, attempt, model_name, model_location,
    state, actual_cost_usd, usage_unknown
ON public.vertex_ai_budget_reservations
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_cost_rollup_snapshot_trigger();

-- Populate durable snapshots for terminal rows that already exist. Existing legacy AI attempts
-- remain unknown where this migration cannot prove pricing/cache provenance.
DO $snapshot_backfill$
DECLARE
    v_request RECORD;
BEGIN
    FOR v_request IN
        SELECT request.id
          FROM public.analysis_requests AS request
         WHERE request.pipeline_version = 'v2'
           AND request.status IN ('completed', 'failed')
    LOOP
        PERFORM public.analysis_v2_refresh_cost_rollup_snapshot(v_request.id);
    END LOOP;
END;
$snapshot_backfill$;

CREATE VIEW public.analysis_v2_cost_rollup_history AS
SELECT snapshot.*
  FROM public.analysis_v2_cost_rollup_snapshots AS snapshot;

REVOKE ALL ON public.analysis_v2_cost_rollup_history
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.analysis_v2_cost_rollup_history TO service_role;

COMMENT ON VIEW public.analysis_v2_cost_rollup_history IS
    'Service-role-only durable PII-free V2 cost snapshots retained after request/preflight cascades; shared infrastructure is excluded.';

CREATE OR REPLACE FUNCTION public.load_analysis_v2_cost_rollup(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_rollup JSONB;
BEGIN
    IF p_request_id IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT pg_catalog.to_jsonb(rollup)
      INTO v_rollup
      FROM public.analysis_v2_cost_rollups AS rollup
     WHERE rollup.request_id = p_request_id;
    IF v_rollup IS NOT NULL THEN
        RETURN v_rollup;
    END IF;

    SELECT pg_catalog.to_jsonb(snapshot)
      INTO v_rollup
      FROM public.analysis_v2_cost_rollup_snapshots AS snapshot
     WHERE snapshot.request_id = p_request_id;
    RETURN v_rollup;
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_cost_rollup(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_cost_rollup(UUID)
    TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_cost_rollup(UUID) IS
    'Service-role-only current-or-durable V2 cost rollup loader; excludes shared infrastructure and user identifiers.';
