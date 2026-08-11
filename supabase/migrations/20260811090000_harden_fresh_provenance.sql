-- Forward-only hardening for the published revenue E2E ledger migration.
-- Fresh provenance is introduced here so 20260810090000 remains byte-for-byte stable.

ALTER TABLE public.analysis_revenue_run_ledgers
    DROP CONSTRAINT analysis_revenue_run_ledgers_request_id_fkey;
ALTER TABLE public.analysis_revenue_run_ledgers
    DROP COLUMN fresh_provenance;

-- The revenue parent and its fresh evidence are service-owned write surfaces.
-- Every mutation below is mediated by an exact SECURITY DEFINER RPC, never a
-- direct service_role DML grant.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.analysis_revenue_run_ledgers FROM service_role;

COMMENT ON COLUMN public.analysis_revenue_run_ledgers.image_manifest_id IS
    'When present, this is the stable analysis_v2_result_image_manifests.request_id snapshot identity; it is not a separately allocated manifest UUID.';

CREATE OR REPLACE FUNCTION public.reject_analysis_revenue_run_ledger_lineage_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.preflight_id IS DISTINCT FROM NEW.preflight_id
       OR OLD.user_id IS DISTINCT FROM NEW.user_id
       OR OLD.plan_id IS DISTINCT FROM NEW.plan_id
       OR OLD.access_mode IS DISTINCT FROM NEW.access_mode
       OR OLD.target_username_hmac IS DISTINCT FROM NEW.target_username_hmac
       OR OLD.preflight_refreshed_at IS DISTINCT FROM NEW.preflight_refreshed_at
       OR OLD.request_started_at IS DISTINCT FROM NEW.request_started_at THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_LEDGER_DRIFT', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_analysis_revenue_run_ledger_lineage_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER analysis_revenue_run_ledger_lineage_immutable
BEFORE UPDATE ON public.analysis_revenue_run_ledgers
FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_revenue_run_ledger_lineage_mutation();

-- This intentionally does not reuse the generic provider-key predicate. The
-- fresh contract admits only the explicit target and profile-batch family
-- whose runtime executes a live Apify source with no cache, adoption, or
-- self-hosted branch. In particular, profile-repair is never admitted.
CREATE OR REPLACE FUNCTION public.analysis_revenue_valid_fresh_provider_operation_key_v1(
    p_operation_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT p_operation_key ~ '^(target-profile|profile-fallback|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[a-f0-9]{64}$'
$$;

REVOKE ALL ON FUNCTION public.analysis_revenue_valid_fresh_provider_operation_key_v1(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- The normalized fresh-evidence row is the sole provider freshness authority.
-- It stores only domain-separated hashes; raw Apify run and Dataset ids never
-- cross this table or any RPC response.
CREATE TABLE public.analysis_revenue_fresh_provider_evidence (
    request_id UUID NOT NULL
        REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
    job_key VARCHAR(160) NOT NULL CHECK (
        job_key ~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
    ),
    job_input_hash VARCHAR(64) NOT NULL CHECK (job_input_hash ~ '^[a-f0-9]{64}$'),
    operation_key_hash VARCHAR(64) NOT NULL CHECK (operation_key_hash ~ '^[a-f0-9]{64}$'),
    provider TEXT NOT NULL DEFAULT 'apify' CHECK (provider = 'apify'),
    provider_input_hash VARCHAR(64) NOT NULL CHECK (provider_input_hash ~ '^[a-f0-9]{64}$'),
    provider_run_hash VARCHAR(64) NOT NULL CHECK (provider_run_hash ~ '^[a-f0-9]{64}$'),
    provider_dataset_hash VARCHAR(64) CHECK (provider_dataset_hash ~ '^[a-f0-9]{64}$'),
    provider_run_started_at TIMESTAMPTZ NOT NULL,
    no_reuse BOOLEAN NOT NULL DEFAULT TRUE CHECK (no_reuse),
    no_adoption BOOLEAN NOT NULL DEFAULT TRUE CHECK (no_adoption),
    no_cache BOOLEAN NOT NULL DEFAULT TRUE CHECK (no_cache),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    dataset_bound_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, job_key, operation_key_hash),
    UNIQUE (request_id, job_key, provider_run_hash),
    CONSTRAINT analysis_revenue_fresh_provider_evidence_dataset_binding_check CHECK (
        (provider_dataset_hash IS NULL AND dataset_bound_at IS NULL)
        OR (provider_dataset_hash IS NOT NULL AND dataset_bound_at IS NOT NULL)
    )
);

ALTER TABLE public.analysis_revenue_fresh_provider_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_fresh_provider_evidence FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_fresh_provider_evidence
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.analysis_revenue_fresh_provider_evidence FROM service_role;

COMMENT ON TABLE public.analysis_revenue_fresh_provider_evidence IS
    'Normalized, service-only proof of a fresh live Apify source. Raw run ids, Dataset ids, targets, usernames, URLs, claims, and credentials are forbidden.';

-- All normalized source fields are immutable. The only allowed mutation is
-- the one-way null-to-hash Dataset proof performed by its SECURITY DEFINER
-- binding RPC; a retry is a read-only replay rather than another mutation.
CREATE OR REPLACE FUNCTION public.reject_analysis_revenue_fresh_provider_evidence_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF OLD.request_id IS DISTINCT FROM NEW.request_id
       OR OLD.job_key IS DISTINCT FROM NEW.job_key
       OR OLD.job_input_hash IS DISTINCT FROM NEW.job_input_hash
       OR OLD.operation_key_hash IS DISTINCT FROM NEW.operation_key_hash
       OR OLD.provider IS DISTINCT FROM NEW.provider
       OR OLD.provider_input_hash IS DISTINCT FROM NEW.provider_input_hash
       OR OLD.provider_run_hash IS DISTINCT FROM NEW.provider_run_hash
       OR OLD.provider_run_started_at IS DISTINCT FROM NEW.provider_run_started_at
       OR OLD.no_reuse IS DISTINCT FROM NEW.no_reuse
       OR OLD.no_adoption IS DISTINCT FROM NEW.no_adoption
       OR OLD.no_cache IS DISTINCT FROM NEW.no_cache
       OR OLD.created_at IS DISTINCT FROM NEW.created_at
       OR OLD.provider_dataset_hash IS NOT NULL
       OR OLD.dataset_bound_at IS NOT NULL
       OR NEW.provider_dataset_hash IS NULL
       OR NEW.dataset_bound_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_analysis_revenue_fresh_provider_evidence_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER analysis_revenue_fresh_provider_evidence_immutable
BEFORE UPDATE ON public.analysis_revenue_fresh_provider_evidence
FOR EACH ROW EXECUTE FUNCTION public.reject_analysis_revenue_fresh_provider_evidence_mutation();

-- This admission gate is called before the provider-run store can reserve or
-- resume an Actor. It proves the trusted Basic/Standard parent and exact live
-- job lineage, and rejects a retained source row which predates its preflight.
CREATE OR REPLACE FUNCTION public.assert_analysis_revenue_fresh_provider_admission_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_operation_key TEXT,
    p_provider_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_provider public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_claim_token IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_job_input_hash IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_provider_input_hash IS NULL OR p_provider_input_hash !~ '^[a-f0-9]{64}$'
       OR p_operation_key IS NULL
       OR NOT public.analysis_revenue_valid_fresh_provider_operation_key_v1(p_operation_key) THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_FENCE', ERRCODE = 'P0001';
    END IF;

    -- Canonical locking order shared with the live-cost RPCs:
    -- preflight → request → job → provider/source → revenue parent.
    SELECT * INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT * INTO v_provider
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    SELECT * INTO v_parent
    FROM public.analysis_revenue_run_ledgers AS ledger
    WHERE ledger.request_id = p_request_id
    FOR UPDATE;

    IF v_parent.request_id IS NULL
       OR v_request.id IS NULL
       OR v_preflight.id IS NULL
       OR v_job.request_id IS NULL
       OR v_parent.preflight_id IS DISTINCT FROM v_request.preflight_id
       OR v_parent.user_id IS DISTINCT FROM v_request.user_id
       OR v_parent.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_parent.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_parent.plan_id NOT IN ('basic', 'standard')
       OR v_parent.status IS DISTINCT FROM 'running'
       OR v_parent.target_username_hmac IS DISTINCT FROM v_preflight.target_input_hash
       OR v_parent.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at
       OR v_parent.request_started_at IS DISTINCT FROM v_request.created_at
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status IS DISTINCT FROM 'processing'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_job_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_FENCE', ERRCODE = 'P0001';
    END IF;
    IF v_provider.request_id IS NULL OR (
        v_provider.input_hash IS DISTINCT FROM p_provider_input_hash
        OR v_provider.job_claim_token IS DISTINCT FROM p_job_claim_token
        OR v_provider.logical_provider IS DISTINCT FROM 'apify'
        OR v_provider.reserved_at < v_parent.preflight_refreshed_at
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH', ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'admitted', 'created', FALSE, 'replayed', TRUE
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.record_analysis_revenue_fresh_provider_evidence_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_operation_key TEXT,
    p_provider_input_hash TEXT,
    p_provider_run_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_provider public.analysis_v2_provider_runs%ROWTYPE;
    v_existing public.analysis_revenue_fresh_provider_evidence%ROWTYPE;
    v_operation_hash TEXT;
    v_expected_run_hash TEXT;
BEGIN
    IF p_provider_run_hash IS NULL OR p_provider_run_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_FENCE', ERRCODE = 'P0001';
    END IF;
    -- The admission function obtains the canonical lock sequence:
    -- preflight → request → job → provider/source → revenue parent.
    PERFORM public.assert_analysis_revenue_fresh_provider_admission_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash,
        p_operation_key, p_provider_input_hash
    );

    SELECT * INTO v_provider
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    SELECT * INTO v_parent
    FROM public.analysis_revenue_run_ledgers AS ledger
    WHERE ledger.request_id = p_request_id
    FOR UPDATE;
    IF v_provider.request_id IS NULL
       OR v_provider.logical_provider IS DISTINCT FROM 'apify'
       OR v_provider.input_hash IS DISTINCT FROM p_provider_input_hash
       OR v_provider.job_claim_token IS DISTINCT FROM p_job_claim_token
       OR v_provider.status NOT IN ('running', 'succeeded', 'failed', 'aborted', 'timed_out')
       OR v_provider.run_id IS NULL
       OR v_provider.run_started_at IS NULL
       OR v_provider.run_started_at < v_parent.preflight_refreshed_at THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH', ERRCODE = 'P0001';
    END IF;

    v_operation_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        'analysis-revenue-fresh-provider-operation/v1|'
        || pg_catalog.octet_length(p_operation_key)::TEXT || ':' || p_operation_key,
        'UTF8'
    ), 'sha256'), 'hex');
    v_expected_run_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        'analysis-revenue-fresh-provider-run/v1|'
        || pg_catalog.octet_length(p_request_id::TEXT)::TEXT || ':' || p_request_id::TEXT || '|'
        || pg_catalog.octet_length(p_job_key)::TEXT || ':' || p_job_key || '|'
        || pg_catalog.octet_length(p_operation_key)::TEXT || ':' || p_operation_key || '|'
        || pg_catalog.octet_length(v_provider.run_id)::TEXT || ':' || v_provider.run_id,
        'UTF8'
    ), 'sha256'), 'hex');
    IF p_provider_run_hash IS DISTINCT FROM v_expected_run_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT', ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_existing
    FROM public.analysis_revenue_fresh_provider_evidence AS evidence
    WHERE evidence.request_id = p_request_id
      AND evidence.job_key = p_job_key
      AND evidence.operation_key_hash = v_operation_hash
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_existing.provider IS DISTINCT FROM 'apify'
           OR v_existing.provider_input_hash IS DISTINCT FROM p_provider_input_hash
           OR v_existing.provider_run_hash IS DISTINCT FROM v_expected_run_hash
           OR v_existing.provider_run_started_at IS DISTINCT FROM v_provider.run_started_at
           OR NOT v_existing.no_reuse OR NOT v_existing.no_adoption OR NOT v_existing.no_cache THEN
            RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'recorded', 'created', FALSE, 'replayed', TRUE
        );
    END IF;

    INSERT INTO public.analysis_revenue_fresh_provider_evidence (
        request_id, job_key, job_input_hash, operation_key_hash, provider,
        provider_input_hash, provider_run_hash, provider_run_started_at,
        no_reuse, no_adoption, no_cache
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, v_operation_hash, 'apify',
        p_provider_input_hash, v_expected_run_hash, v_provider.run_started_at,
        TRUE, TRUE, TRUE
    );
    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'recorded', 'created', TRUE, 'replayed', FALSE
    );
END;
$$;

-- Dataset binding is deliberately null-to-value only. A retry may repeat the
-- exact opaque dataset hash; a distinct hash is immutable evidence drift.
CREATE OR REPLACE FUNCTION public.bind_analysis_revenue_fresh_provider_dataset_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_operation_key TEXT,
    p_provider_input_hash TEXT,
    p_provider_run_hash TEXT,
    p_provider_dataset_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_provider public.analysis_v2_provider_runs%ROWTYPE;
    v_existing public.analysis_revenue_fresh_provider_evidence%ROWTYPE;
    v_operation_hash TEXT;
    v_expected_run_hash TEXT;
BEGIN
    IF p_provider_run_hash IS NULL OR p_provider_run_hash !~ '^[a-f0-9]{64}$'
       OR p_provider_dataset_hash IS NULL OR p_provider_dataset_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_FENCE', ERRCODE = 'P0001';
    END IF;
    -- Admission locks preflight → request → job → provider/source → revenue parent
    -- before this source can acquire an immutable Dataset binding.
    PERFORM public.assert_analysis_revenue_fresh_provider_admission_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash,
        p_operation_key, p_provider_input_hash
    );
    SELECT * INTO v_provider
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF v_provider.request_id IS NULL
       OR v_provider.logical_provider IS DISTINCT FROM 'apify'
       OR v_provider.input_hash IS DISTINCT FROM p_provider_input_hash
       OR v_provider.status IS DISTINCT FROM 'succeeded'
       OR v_provider.run_id IS NULL OR v_provider.run_started_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH', ERRCODE = 'P0001';
    END IF;
    v_operation_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        'analysis-revenue-fresh-provider-operation/v1|'
        || pg_catalog.octet_length(p_operation_key)::TEXT || ':' || p_operation_key,
        'UTF8'
    ), 'sha256'), 'hex');
    v_expected_run_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        'analysis-revenue-fresh-provider-run/v1|'
        || pg_catalog.octet_length(p_request_id::TEXT)::TEXT || ':' || p_request_id::TEXT || '|'
        || pg_catalog.octet_length(p_job_key)::TEXT || ':' || p_job_key || '|'
        || pg_catalog.octet_length(p_operation_key)::TEXT || ':' || p_operation_key || '|'
        || pg_catalog.octet_length(v_provider.run_id)::TEXT || ':' || v_provider.run_id,
        'UTF8'
    ), 'sha256'), 'hex');
    IF p_provider_run_hash IS DISTINCT FROM v_expected_run_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_existing
    FROM public.analysis_revenue_fresh_provider_evidence AS evidence
    WHERE evidence.request_id = p_request_id
      AND evidence.job_key = p_job_key
      AND evidence.operation_key_hash = v_operation_hash
    FOR UPDATE;
    IF NOT FOUND
       OR v_existing.job_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_existing.provider IS DISTINCT FROM 'apify'
       OR v_existing.provider_input_hash IS DISTINCT FROM p_provider_input_hash
       OR v_existing.provider_run_hash IS DISTINCT FROM v_expected_run_hash
       OR NOT v_existing.no_reuse OR NOT v_existing.no_adoption OR NOT v_existing.no_cache THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT', ERRCODE = 'P0001';
    END IF;
    IF v_existing.provider_dataset_hash IS NULL THEN
        UPDATE public.analysis_revenue_fresh_provider_evidence
        SET provider_dataset_hash = p_provider_dataset_hash,
            dataset_bound_at = pg_catalog.clock_timestamp()
        WHERE request_id = p_request_id
          AND job_key = p_job_key
          AND operation_key_hash = v_operation_hash;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'bound', 'created', TRUE, 'replayed', FALSE
        );
    END IF;
    IF v_existing.provider_dataset_hash IS DISTINCT FROM p_provider_dataset_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_DRIFT', ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'bound', 'created', FALSE, 'replayed', TRUE
    );
END;
$$;

REVOKE ALL ON FUNCTION public.assert_analysis_revenue_fresh_provider_admission_v1(UUID,TEXT,UUID,TEXT,TEXT,TEXT),
    public.record_analysis_revenue_fresh_provider_evidence_v1(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT),
    public.bind_analysis_revenue_fresh_provider_dataset_v1(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_analysis_revenue_fresh_provider_admission_v1(UUID,TEXT,UUID,TEXT,TEXT,TEXT),
    public.record_analysis_revenue_fresh_provider_evidence_v1(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT),
    public.bind_analysis_revenue_fresh_provider_dataset_v1(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT)
    TO service_role;

-- Trusted fresh Apify profile checkpoint.
--
-- The legacy primary attempt is deliberately free/cache-or-selfhosted.  The
-- test-entitlement cohort cannot reuse that shape, so this additive attempt is
-- the one narrow exception: it accepts only the already-proven exact Apify
-- source whose opaque run and Dataset evidence have both been durably bound.
-- It remains separate from primary/fallback/repair so ordinary production
-- collection and its cache semantics are unchanged.
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    DROP CONSTRAINT analysis_v2_profile_outcomes_attempt_check;
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    ADD CONSTRAINT analysis_v2_profile_outcomes_attempt_check CHECK (
        attempt IN ('primary', 'fallback', 'repair', 'fresh_apify')
    );
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    DROP CONSTRAINT analysis_v2_profile_outcomes_source_check;
ALTER TABLE public.analysis_v2_profile_fetch_outcomes
    ADD CONSTRAINT analysis_v2_profile_outcomes_source_check CHECK (
        (attempt = 'primary' AND source IN ('cache', 'selfhosted'))
        OR (attempt IN ('fallback', 'repair', 'fresh_apify') AND source = 'apify')
    );

-- A fresh-Apify batch is presented as the primary result set to the existing
-- V2 resume contract, but is never merged with a legacy primary, fallback, or
-- repair attempt.  The predicate is server-derived from the immutable outcome
-- rows, not a mutable request field.
CREATE OR REPLACE FUNCTION public.analysis_v2_profile_checkpoint_snapshot(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', batch.request_id,
        'jobKey', batch.job_key,
        'requestedUsernames', pg_catalog.to_jsonb(batch.requested_usernames),
        'frozenUnresolvedUsernames',
            pg_catalog.to_jsonb(batch.frozen_unresolved_usernames),
        'primaryResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = CASE WHEN EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_profile_fetch_outcomes AS fresh_outcome
                    WHERE fresh_outcome.request_id = batch.request_id
                      AND fresh_outcome.job_key = batch.job_key
                      AND fresh_outcome.attempt = 'fresh_apify'
                ) THEN 'fresh_apify' ELSE 'primary' END
        ), '[]'::JSONB),
        'fallbackResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'fallback'
        ), '[]'::JSONB),
        'repairResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'repair'
        ), '[]'::JSONB),
        'primaryCapturedAt', batch.primary_completed_at,
        'fallbackCapturedAt', batch.fallback_completed_at,
        'repairUsernames', pg_catalog.to_jsonb(batch.repair_usernames),
        'repairCapturedAt', batch.repair_completed_at
    )
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_checkpoint_snapshot(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_requested_usernames TEXT[],
    p_outcomes JSONB,
    p_operation_key TEXT,
    p_provider_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_provider public.analysis_v2_provider_runs%ROWTYPE;
    v_evidence public.analysis_revenue_fresh_provider_evidence%ROWTYPE;
    v_batch public.analysis_v2_profile_fetch_batches%ROWTYPE;
    v_operation_hash TEXT;
    v_expected_run_hash TEXT;
    v_payload_hash TEXT;
    v_unresolved TEXT[];
    v_completed_at TIMESTAMPTZ;
    v_existing_outcome_count INTEGER;
    v_existing_fresh_count INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_provider_input_hash IS NULL OR p_provider_input_hash !~ '^[a-f0-9]{64}$'
       OR p_operation_key IS NULL
       OR NOT public.analysis_revenue_valid_fresh_provider_operation_key_v1(p_operation_key)
       OR NOT public.analysis_v2_valid_profile_username_list(p_requested_usernames, FALSE)
       -- The established fallback validator is the exact bounded Apify outcome
       -- grammar.  It is intentionally reused rather than widening primary.
       OR NOT public.analysis_v2_valid_profile_outcomes(
            p_outcomes, p_requested_usernames, 'fallback'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Lock and prove the test-entitlement parent, live job claim, and exact
    -- Apify source before touching a profile checkpoint. The admission gate
    -- and the materialized reads below both use preflight → request → job →
    -- provider/source → revenue parent, matching live-cost RPCs.
    PERFORM public.assert_analysis_revenue_fresh_provider_admission_v1(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash,
        p_operation_key, p_provider_input_hash
    );

    SELECT * INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT * INTO v_provider
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    SELECT * INTO v_parent
    FROM public.analysis_revenue_run_ledgers AS ledger
    WHERE ledger.request_id = p_request_id
    FOR UPDATE;

    v_operation_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        'analysis-revenue-fresh-provider-operation/v1|'
        || pg_catalog.octet_length(p_operation_key)::TEXT || ':' || p_operation_key,
        'UTF8'
    ), 'sha256'), 'hex');
    IF v_provider.request_id IS NULL
       OR v_provider.logical_provider IS DISTINCT FROM 'apify'
       OR v_provider.input_hash IS DISTINCT FROM p_provider_input_hash
       OR v_provider.job_claim_token IS DISTINCT FROM p_claim_token
       OR v_provider.status IS DISTINCT FROM 'succeeded'
       OR v_provider.run_id IS NULL
       OR v_provider.run_started_at IS NULL
       OR v_provider.reserved_at < v_parent.preflight_refreshed_at
       OR v_provider.run_started_at < v_parent.preflight_refreshed_at THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH', ERRCODE = 'P0001';
    END IF;
    v_expected_run_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
        'analysis-revenue-fresh-provider-run/v1|'
        || pg_catalog.octet_length(p_request_id::TEXT)::TEXT || ':' || p_request_id::TEXT || '|'
        || pg_catalog.octet_length(p_job_key)::TEXT || ':' || p_job_key || '|'
        || pg_catalog.octet_length(p_operation_key)::TEXT || ':' || p_operation_key || '|'
        || pg_catalog.octet_length(v_provider.run_id)::TEXT || ':' || v_provider.run_id,
        'UTF8'
    ), 'sha256'), 'hex');
    SELECT * INTO v_evidence
    FROM public.analysis_revenue_fresh_provider_evidence AS evidence
    WHERE evidence.request_id = p_request_id
      AND evidence.job_key = p_job_key
      AND evidence.operation_key_hash = v_operation_hash
    FOR UPDATE;
    IF v_evidence.request_id IS NULL
       OR v_evidence.job_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_evidence.provider IS DISTINCT FROM 'apify'
       OR v_evidence.provider_input_hash IS DISTINCT FROM p_provider_input_hash
       OR v_evidence.provider_run_hash IS DISTINCT FROM v_expected_run_hash
       OR v_evidence.provider_run_started_at IS DISTINCT FROM v_provider.run_started_at
       OR v_evidence.provider_dataset_hash IS NULL
       OR v_evidence.dataset_bound_at IS NULL
       OR NOT v_evidence.no_reuse
       OR NOT v_evidence.no_adoption
       OR NOT v_evidence.no_cache THEN
        RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH', ERRCODE = 'P0001';
    END IF;

    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_job.request_id IS NULL
       OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_payload_hash := pg_catalog.encode(extensions.digest(
        pg_catalog.jsonb_build_object(
            'requested_usernames', pg_catalog.to_jsonb(p_requested_usernames),
            'outcomes', p_outcomes
        )::TEXT,
        'sha256'
    ), 'hex');
    SELECT * INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_batch.requested_usernames IS DISTINCT FROM p_requested_usernames
           OR v_batch.primary_payload_hash IS DISTINCT FROM v_payload_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_FRESH_APIFY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        SELECT pg_catalog.count(*)::INTEGER,
               pg_catalog.count(*) FILTER (
                   WHERE outcome.attempt = 'fresh_apify' AND outcome.source = 'apify'
               )::INTEGER
        INTO v_existing_outcome_count, v_existing_fresh_count
        FROM public.analysis_v2_profile_fetch_outcomes AS outcome
        WHERE outcome.request_id = p_request_id
          AND outcome.job_key = p_job_key;
        IF v_existing_outcome_count IS DISTINCT FROM pg_catalog.cardinality(p_requested_usernames)
           OR v_existing_fresh_count IS DISTINCT FROM pg_catalog.cardinality(p_requested_usernames) THEN
            RAISE EXCEPTION USING MESSAGE = 'FRESH_PROVENANCE_NOT_FRESH', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
    END IF;

    SELECT COALESCE(
        pg_catalog.array_agg(outcome.value->>'username' ORDER BY outcome.ordinal),
        '{}'::TEXT[]
    )
    INTO v_unresolved
    FROM pg_catalog.jsonb_array_elements(p_outcomes)
        WITH ORDINALITY AS outcome(value, ordinal)
    WHERE outcome.value->>'status' <> 'success';

    v_completed_at := pg_catalog.clock_timestamp();
    INSERT INTO public.analysis_v2_profile_fetch_batches (
        request_id,
        job_key,
        requested_usernames,
        frozen_unresolved_usernames,
        primary_payload_hash,
        primary_completed_at,
        created_at,
        updated_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_requested_usernames,
        v_unresolved,
        v_payload_hash,
        v_completed_at,
        v_completed_at,
        v_completed_at
    );

    INSERT INTO public.analysis_v2_profile_fetch_outcomes (
        request_id,
        job_key,
        attempt,
        ordinal,
        username,
        source,
        status,
        failure_category,
        http_status,
        request_count,
        latency_ms,
        captured_at,
        profile_snapshot
    )
    SELECT
        p_request_id,
        p_job_key,
        'fresh_apify',
        outcome.ordinal::SMALLINT,
        outcome.value->>'username',
        outcome.value->>'source',
        outcome.value->>'status',
        NULLIF(outcome.value->>'failure_category', ''),
        CASE
            WHEN outcome.value->'http_status' = 'null'::JSONB THEN NULL
            ELSE (outcome.value->>'http_status')::SMALLINT
        END,
        (outcome.value->>'request_count')::SMALLINT,
        (outcome.value->>'latency_ms')::INTEGER,
        (outcome.value->>'captured_at')::TIMESTAMPTZ,
        CASE
            WHEN outcome.value->'profile' = 'null'::JSONB THEN NULL
            ELSE outcome.value->'profile'
        END
    FROM pg_catalog.jsonb_array_elements(p_outcomes)
        WITH ORDINALITY AS outcome(value, ordinal)
    ORDER BY outcome.ordinal;

    RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_v1(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_v1(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_v1(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB, TEXT, TEXT
) IS 'Trusted Basic/Standard-only direct profile checkpoint. Requires one exact terminal Apify provider source with recorded opaque run and Dataset evidence; replay is exact and legacy/cache rows fail closed.';

-- A consumed strict request is not dispatchable merely because it has a
-- scheduler row. This durable guard closes the begin-RPC transport window:
-- a route can quarantine an unresolved begin, and every later dispatch/claim
-- must observe the exact active running revenue parent.
CREATE TABLE public.analysis_revenue_dispatch_guards (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    state TEXT NOT NULL CHECK (state IN ('active', 'quarantined')),
    reason_code TEXT CHECK (reason_code IN ('begin_failure')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_revenue_dispatch_guards_state_reason_check CHECK (
        (state = 'active' AND reason_code IS NULL)
        OR (state = 'quarantined' AND reason_code = 'begin_failure')
    )
);

ALTER TABLE public.analysis_revenue_dispatch_guards ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_dispatch_guards FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_dispatch_guards
    FROM PUBLIC, anon, authenticated, service_role;

-- Locks only the exact dispatch lineage. The order is deliberately identical
-- to live-cost/fresh-provenance work: preflight → request → job →
-- provider/source policy → revenue parent → guard.
CREATE OR REPLACE FUNCTION public.assert_analysis_revenue_dispatch_guard_v1(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_guard public.analysis_revenue_dispatch_guards%ROWTYPE;
    v_strict BOOLEAN := FALSE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE', ERRCODE = 'P0001';
    END IF;

    SELECT * INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    SELECT * INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT * INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_parent
    FROM public.analysis_revenue_run_ledgers AS ledger
    WHERE ledger.request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_guard
    FROM public.analysis_revenue_dispatch_guards AS dispatch_guard
    WHERE dispatch_guard.request_id = p_request_id
    FOR UPDATE;

    v_strict := v_request.id IS NOT NULL
        AND v_request.plan_access_mode_snapshot = 'test_entitlement'
        AND v_request.selected_plan_id_snapshot IN ('basic', 'standard')
        AND v_policy.request_id IS NOT NULL
        AND v_policy.mode = 'test_operation_split'
        AND v_policy.policy_version = 'authorized-free-e2e-v1';
    IF NOT v_strict THEN
        RETURN;
    END IF;

    IF v_preflight.id IS NULL
       OR v_job.request_id IS NULL
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_parent.request_id IS NULL
       OR v_parent.status IS DISTINCT FROM 'running'
       OR v_parent.preflight_id IS DISTINCT FROM v_request.preflight_id
       OR v_parent.user_id IS DISTINCT FROM v_request.user_id
       OR v_parent.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_parent.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_parent.target_username_hmac IS DISTINCT FROM v_preflight.target_input_hash
       OR v_parent.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at
       OR v_parent.request_started_at IS DISTINCT FROM v_request.created_at
       OR v_guard.request_id IS NULL
       OR v_guard.state IS DISTINCT FROM 'active'
       OR v_guard.reason_code IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE', ERRCODE = 'P0001';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.activate_analysis_revenue_dispatch_guard_v1(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_guard public.analysis_revenue_dispatch_guards%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE', ERRCODE = 'P0001';
    END IF;

    -- Canonical lock order: preflight → request → job → provider/source policy
    -- → revenue parent → guard.
    SELECT * INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    SELECT * INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT * INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_parent
    FROM public.analysis_revenue_run_ledgers AS ledger
    WHERE ledger.request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_guard
    FROM public.analysis_revenue_dispatch_guards AS dispatch_guard
    WHERE dispatch_guard.request_id = p_request_id
    FOR UPDATE;

    IF v_preflight.id IS NULL
       OR v_request.id IS NULL
       OR v_job.request_id IS NULL
       OR v_policy.request_id IS NULL
       OR v_parent.request_id IS NULL
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_preflight.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard')
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_parent.status IS DISTINCT FROM 'running'
       OR v_parent.preflight_id IS DISTINCT FROM v_request.preflight_id
       OR v_parent.user_id IS DISTINCT FROM v_request.user_id
       OR v_parent.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_parent.access_mode IS DISTINCT FROM 'test_entitlement'
       OR v_parent.target_username_hmac IS DISTINCT FROM v_preflight.target_input_hash
       OR v_parent.preflight_refreshed_at IS DISTINCT FROM v_preflight.admission_refreshed_at
       OR v_parent.request_started_at IS DISTINCT FROM v_request.created_at THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE', ERRCODE = 'P0001';
    END IF;

    IF v_guard.request_id IS NULL THEN
        INSERT INTO public.analysis_revenue_dispatch_guards (
            request_id, state, reason_code
        ) VALUES (
            p_request_id, 'active', NULL
        );
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'active', 'created', TRUE, 'replayed', FALSE
        );
    END IF;
    IF v_guard.state = 'active' AND v_guard.reason_code IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'active', 'created', FALSE, 'replayed', TRUE
        );
    END IF;
    RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE', ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION public.quarantine_analysis_revenue_dispatch_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_reason_code TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_guard public.analysis_revenue_dispatch_guards%ROWTYPE;
    v_changed BOOLEAN := FALSE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_reason_code IS DISTINCT FROM 'begin_failure' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE', ERRCODE = 'P0001';
    END IF;

    -- Canonical lock order: preflight → request → job → provider/source policy
    -- → revenue parent → guard.
    SELECT * INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    SELECT * INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT * INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_parent
    FROM public.analysis_revenue_run_ledgers AS ledger
    WHERE ledger.request_id = p_request_id
    FOR UPDATE;
    SELECT * INTO v_guard
    FROM public.analysis_revenue_dispatch_guards AS dispatch_guard
    WHERE dispatch_guard.request_id = p_request_id
    FOR UPDATE;

    IF v_request.id IS NULL
       OR v_job.request_id IS NULL
       OR v_policy.request_id IS NULL
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard')
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_REVENUE_DISPATCH_FENCE', ERRCODE = 'P0001';
    END IF;

    IF v_guard.request_id IS NULL THEN
        INSERT INTO public.analysis_revenue_dispatch_guards (
            request_id, state, reason_code
        ) VALUES (
            p_request_id, 'quarantined', 'begin_failure'
        );
        v_changed := TRUE;
    ELSIF v_guard.state = 'quarantined'
          AND v_guard.reason_code = 'begin_failure' THEN
        v_changed := FALSE;
    ELSE
        UPDATE public.analysis_revenue_dispatch_guards AS dispatch_guard
        SET state = 'quarantined',
            reason_code = 'begin_failure',
            updated_at = pg_catalog.clock_timestamp()
        WHERE dispatch_guard.request_id = p_request_id;
        v_changed := TRUE;
    END IF;

    -- A committed begin can now be proven: keep its immutable cost lineage but
    -- put the parent under manual review. A failed/ambiguous begin with no
    -- parent is still fail-closed because the request below becomes terminal.
    IF v_parent.request_id IS NOT NULL AND v_parent.status = 'running' THEN
        UPDATE public.analysis_revenue_run_ledgers AS ledger
        SET status = 'manual_review',
            manual_review_reason = 'routing_failure'
        WHERE ledger.request_id = p_request_id;
    END IF;
    UPDATE public.analysis_requests AS analysis_request
    SET status = 'failed',
        background_processing = FALSE,
        progress_step = 'V2 analysis quarantined',
        current_step = 'failed',
        error_message = 'REVENUE_DISPATCH_QUARANTINED',
        completed_at = COALESCE(analysis_request.completed_at, pg_catalog.clock_timestamp())
    WHERE analysis_request.id = p_request_id
      AND analysis_request.status IN ('pending', 'processing');

    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'quarantined',
        'created', v_changed,
        'replayed', NOT v_changed
    );
END;
$$;

REVOKE ALL ON FUNCTION public.assert_analysis_revenue_dispatch_guard_v1(UUID, TEXT),
    public.activate_analysis_revenue_dispatch_guard_v1(UUID, TEXT),
    public.quarantine_analysis_revenue_dispatch_v1(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assert_analysis_revenue_dispatch_guard_v1(UUID, TEXT),
    public.activate_analysis_revenue_dispatch_guard_v1(UUID, TEXT),
    public.quarantine_analysis_revenue_dispatch_v1(UUID, TEXT, TEXT)
    TO service_role;

-- A row trigger would acquire the job row lock before it could check the
-- preflight/request lineage, reversing the live-cost lock order. Fence every
-- service-visible dispatch RPC instead: the guard obtains
-- preflight -> request -> job -> policy -> parent -> guard before the legacy
-- mutation can touch the job. The renamed implementations are deliberately
-- not executable by service_role, so the wrappers are the only production
-- dispatch surface.
ALTER FUNCTION public.reserve_analysis_v2_job_dispatch(UUID, TEXT, UUID)
    RENAME TO reserve_analysis_v2_job_dispatch_unfenced_20260811;
ALTER FUNCTION public.mark_analysis_v2_job_dispatched(UUID, TEXT, INTEGER, UUID, TEXT)
    RENAME TO mark_analysis_v2_job_dispatched_unfenced_20260811;
ALTER FUNCTION public.rearm_analysis_v2_job_dispatch(UUID, TEXT, INTEGER, UUID, UUID)
    RENAME TO rearm_analysis_v2_job_dispatch_unfenced_20260811;
ALTER FUNCTION public.claim_analysis_v2_job(UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER)
    RENAME TO claim_analysis_v2_job_unfenced_20260811;
ALTER FUNCTION public.continue_analysis_v2_scheduler_job(UUID, TEXT, UUID, UUID, TEXT, INTEGER)
    RENAME TO continue_analysis_v2_scheduler_job_unfenced_20260811;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_job_dispatch_unfenced_20260811(UUID, TEXT, UUID),
    public.mark_analysis_v2_job_dispatched_unfenced_20260811(UUID, TEXT, INTEGER, UUID, TEXT),
    public.rearm_analysis_v2_job_dispatch_unfenced_20260811(UUID, TEXT, INTEGER, UUID, UUID),
    public.claim_analysis_v2_job_unfenced_20260811(UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER),
    public.continue_analysis_v2_scheduler_job_unfenced_20260811(UUID, TEXT, UUID, UUID, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_job_dispatch(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_token UUID
)
RETURNS TABLE(
    reserved BOOLEAN,
    dispatch_generation INTEGER,
    reservation_token UUID,
    job_status TEXT,
    dispatch_state TEXT,
    task_name TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.assert_analysis_revenue_dispatch_guard_v1(p_request_id, p_job_key);
    RETURN QUERY
    SELECT * FROM public.reserve_analysis_v2_job_dispatch_unfenced_20260811(
        p_request_id, p_job_key, p_dispatch_token
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_analysis_v2_job_dispatched(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_task_name TEXT
)
RETURNS TABLE(marked BOOLEAN, job_status TEXT, dispatch_state TEXT, task_name TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.assert_analysis_revenue_dispatch_guard_v1(p_request_id, p_job_key);
    RETURN QUERY
    SELECT * FROM public.mark_analysis_v2_job_dispatched_unfenced_20260811(
        p_request_id, p_job_key, p_dispatch_generation, p_dispatch_token, p_task_name
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.rearm_analysis_v2_job_dispatch(
    p_request_id UUID,
    p_job_key TEXT,
    p_expected_generation INTEGER,
    p_expected_dispatch_token UUID,
    p_new_dispatch_token UUID
)
RETURNS TABLE(
    rearmed BOOLEAN,
    dispatch_generation INTEGER,
    reservation_token UUID,
    job_status TEXT,
    dispatch_state TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.assert_analysis_revenue_dispatch_guard_v1(p_request_id, p_job_key);
    RETURN QUERY
    SELECT * FROM public.rearm_analysis_v2_job_dispatch_unfenced_20260811(
        p_request_id, p_job_key, p_expected_generation,
        p_expected_dispatch_token, p_new_dispatch_token
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.claim_analysis_v2_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_dispatch_generation INTEGER,
    p_dispatch_token UUID,
    p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 120,
    p_max_attempts INTEGER DEFAULT 7
)
RETURNS TABLE(
    claimed BOOLEAN,
    job_status TEXT,
    attempt_count INTEGER,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    track TEXT,
    job_kind TEXT,
    batch INTEGER,
    input_hash TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.assert_analysis_revenue_dispatch_guard_v1(p_request_id, p_job_key);
    RETURN QUERY
    SELECT * FROM public.claim_analysis_v2_job_unfenced_20260811(
        p_request_id, p_job_key, p_dispatch_generation, p_dispatch_token,
        p_claim_token, p_lease_seconds, p_max_attempts
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.continue_analysis_v2_scheduler_job(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_dispatch_token UUID,
    p_error_code TEXT,
    p_delay_seconds INTEGER
)
RETURNS TABLE(
    reserved BOOLEAN,
    dispatch_generation INTEGER,
    reservation_token UUID,
    job_status TEXT,
    dispatch_state TEXT,
    task_name TEXT,
    attempt_count INTEGER,
    request_status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    PERFORM public.assert_analysis_revenue_dispatch_guard_v1(p_request_id, p_job_key);
    RETURN QUERY
    SELECT * FROM public.continue_analysis_v2_scheduler_job_unfenced_20260811(
        p_request_id, p_job_key, p_claim_token, p_dispatch_token,
        p_error_code, p_delay_seconds
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_job_dispatch(UUID, TEXT, UUID),
    public.mark_analysis_v2_job_dispatched(UUID, TEXT, INTEGER, UUID, TEXT),
    public.rearm_analysis_v2_job_dispatch(UUID, TEXT, INTEGER, UUID, UUID),
    public.claim_analysis_v2_job(UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER),
    public.continue_analysis_v2_scheduler_job(UUID, TEXT, UUID, UUID, TEXT, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_job_dispatch(UUID, TEXT, UUID),
    public.mark_analysis_v2_job_dispatched(UUID, TEXT, INTEGER, UUID, TEXT),
    public.rearm_analysis_v2_job_dispatch(UUID, TEXT, INTEGER, UUID, UUID),
    public.claim_analysis_v2_job(UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER),
    public.continue_analysis_v2_scheduler_job(UUID, TEXT, UUID, UUID, TEXT, INTEGER)
    TO service_role;
