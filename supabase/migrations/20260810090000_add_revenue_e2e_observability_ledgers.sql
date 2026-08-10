-- Revenue E2E additive ledgers.
-- This migration only creates service-owned evidence surfaces; no paid request,
-- account classification, order, or result row is changed by applying it.

CREATE TABLE public.analysis_revenue_run_ledgers (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    preflight_id UUID NOT NULL,
    user_id UUID NOT NULL,
    plan_id TEXT NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    access_mode TEXT NOT NULL CHECK (access_mode = 'test_entitlement'),
    target_username_hmac TEXT NOT NULL CHECK (target_username_hmac ~ '^[a-f0-9]{64}$'),
    preflight_refreshed_at TIMESTAMPTZ NOT NULL,
    request_started_at TIMESTAMPTZ NOT NULL,
    fresh_provenance JSONB NOT NULL DEFAULT '{}'::JSONB,
    cost_cap_krw INTEGER NOT NULL CHECK (cost_cap_krw IN (1808, 3634)),
    reserved_cost_krw INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cost_krw >= 0),
    actual_cost_krw INTEGER CHECK (actual_cost_krw IS NULL OR actual_cost_krw >= 0),
    public_mutual_count INTEGER CHECK (public_mutual_count IS NULL OR public_mutual_count >= 0),
    screened_count INTEGER CHECK (screened_count IS NULL OR screened_count >= 0),
    not_screened_count INTEGER CHECK (not_screened_count IS NULL OR not_screened_count >= 0),
    unknown_burden_count INTEGER CHECK (unknown_burden_count IS NULL OR unknown_burden_count >= 0),
    result_revision_id UUID,
    image_manifest_id UUID,
    content_hash TEXT CHECK (content_hash IS NULL OR content_hash ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'manual_review', 'failed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    completed_at TIMESTAMPTZ
);

ALTER TABLE public.analysis_revenue_run_ledgers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_run_ledgers FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_run_ledgers FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_revenue_run_ledgers TO service_role;

CREATE TABLE public.analysis_result_share_observations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    client_nonce TEXT NOT NULL CHECK (client_nonce ~ '^[A-Za-z0-9_-]{16,64}$'),
    share_channel TEXT NOT NULL CHECK (share_channel IN ('clipboard', 'web_share', 'kakao')),
    share_outcome TEXT NOT NULL CHECK (share_outcome IN ('started', 'succeeded', 'cancelled', 'failed', 'confirmed', 'opened')),
    event_name TEXT NOT NULL CHECK (event_name IN (
        'result_share_initiated', 'result_share_copy_succeeded',
        'result_share_handoff_completed', 'result_shared_confirmed',
        'shared_result_opened', 'result_share_cancelled', 'result_share_failed'
    )),
    traffic_class TEXT NOT NULL CHECK (traffic_class IN ('external', 'operator', 'e2e_test', 'internal_tester', 'unknown')),
    axiom_delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (request_id, client_nonce)
);

ALTER TABLE public.analysis_result_share_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_result_share_observations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_result_share_observations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_result_share_observations TO service_role;

COMMENT ON TABLE public.analysis_revenue_run_ledgers IS
    'Service-only revenue E2E provenance, cost, coverage, and immutable-reader equality evidence.';
COMMENT ON TABLE public.analysis_result_share_observations IS
    'Allowlisted, nonce-idempotent share semantics; raw share URLs and Kakao callback bodies are never stored.';

-- The stage-one routing authority is deliberately separate from relationship PII staging.
-- Its candidate identity is only the relationship-local mutual ordinal and a derived opaque key.
ALTER TABLE public.analysis_v2_relationship_manifests
    ADD CONSTRAINT analysis_v2_relationship_manifests_checkpoint_identity_key
    UNIQUE (request_id, job_key, result_hash);

CREATE TABLE public.analysis_v2_gender_routing_manifests (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    relationship_job_key VARCHAR(160) NOT NULL
        CHECK (relationship_job_key = 'track:relationships:collect'),
    relationship_job_input_hash VARCHAR(64) NOT NULL
        CHECK (relationship_job_input_hash ~ '^[a-f0-9]{64}$'),
    relationship_checkpoint_id VARCHAR(64) NOT NULL
        CHECK (relationship_checkpoint_id ~ '^[a-f0-9]{64}$'),
    policy_version VARCHAR(64) NOT NULL
        CHECK (policy_version = 'gender-routing-v1'),
    manifest_schema_version SMALLINT NOT NULL DEFAULT 1
        CHECK (manifest_schema_version = 1),
    plan_id TEXT NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    detailed_cap SMALLINT NOT NULL CHECK (detailed_cap IN (100, 200)),
    population_count SMALLINT NOT NULL CHECK (population_count BETWEEN 0 AND 800),
    canonical_input_hmac VARCHAR(64) NOT NULL
        CHECK (canonical_input_hmac ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL DEFAULT 'building'
        CHECK (status IN ('building', 'complete', 'invalidated')),
    attempt_count SMALLINT NOT NULL DEFAULT 1 CHECK (attempt_count BETWEEN 1 AND 32767),
    selected_count SMALLINT,
    model_attempted_count SMALLINT,
    model_valid_count SMALLINT,
    model_failed_count SMALLINT,
    model_retried_count SMALLINT,
    quota_female_shortfall SMALLINT,
    quota_uncertainty_shortfall SMALLINT,
    female_priority_count SMALLINT,
    uncertainty_count SMALLINT,
    male_deprioritized_count SMALLINT,
    selected_female_priority_count SMALLINT,
    selected_uncertainty_count SMALLINT,
    selected_male_deprioritized_count SMALLINT,
    candidate_rows_hash VARCHAR(32),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    completed_at TIMESTAMPTZ,
    invalidated_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, relationship_checkpoint_id, policy_version),
    FOREIGN KEY (request_id, relationship_job_key, relationship_checkpoint_id)
        REFERENCES public.analysis_v2_relationship_manifests(request_id, job_key, result_hash)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_gender_routing_manifest_plan_cap_check CHECK (
        (plan_id = 'basic' AND detailed_cap = 100 AND population_count <= 400)
        OR (plan_id = 'standard' AND detailed_cap = 200 AND population_count <= 800)
    ),
    CONSTRAINT analysis_v2_gender_routing_manifest_complete_check CHECK (
        (status = 'building'
            AND selected_count IS NULL AND model_attempted_count IS NULL
            AND model_valid_count IS NULL AND model_failed_count IS NULL
            AND model_retried_count IS NULL AND quota_female_shortfall IS NULL
            AND quota_uncertainty_shortfall IS NULL AND female_priority_count IS NULL
            AND uncertainty_count IS NULL AND male_deprioritized_count IS NULL
            AND selected_female_priority_count IS NULL
            AND selected_uncertainty_count IS NULL
            AND selected_male_deprioritized_count IS NULL
            AND candidate_rows_hash IS NULL AND completed_at IS NULL
            AND invalidated_at IS NULL)
        OR (status = 'complete'
            AND selected_count BETWEEN 0 AND detailed_cap
            AND model_attempted_count BETWEEN 0 AND population_count
            AND model_valid_count BETWEEN 0 AND model_attempted_count
            AND model_failed_count BETWEEN 0 AND model_attempted_count
            AND model_retried_count BETWEEN 0 AND population_count
            AND quota_female_shortfall BETWEEN 0 AND 160
            AND quota_uncertainty_shortfall BETWEEN 0 AND 40
            AND female_priority_count BETWEEN 0 AND population_count
            AND uncertainty_count BETWEEN 0 AND population_count
            AND male_deprioritized_count BETWEEN 0 AND population_count
            AND selected_female_priority_count BETWEEN 0 AND selected_count
            AND selected_uncertainty_count BETWEEN 0 AND selected_count
            AND selected_male_deprioritized_count BETWEEN 0 AND selected_count
            AND candidate_rows_hash ~ '^[a-f0-9]{32}$'
            AND completed_at IS NOT NULL AND invalidated_at IS NULL)
        OR (status = 'invalidated' AND invalidated_at IS NOT NULL)
    )
);

CREATE TABLE public.analysis_v2_gender_routing_candidates (
    request_id UUID NOT NULL,
    relationship_checkpoint_id VARCHAR(64) NOT NULL,
    policy_version VARCHAR(64) NOT NULL,
    relationship_job_key VARCHAR(160) NOT NULL
        CHECK (relationship_job_key = 'track:relationships:collect'),
    mutual_ordinal SMALLINT NOT NULL CHECK (mutual_ordinal BETWEEN 1 AND 1200),
    candidate_key VARCHAR(32) NOT NULL
        CHECK (candidate_key ~ '^mutual:[1-9][0-9]{0,3}$'),
    has_image BOOLEAN NOT NULL,
    has_name BOOLEAN NOT NULL,
    image_content_hmac VARCHAR(64),
    fullname_hmac VARCHAR(64),
    female_score NUMERIC(9, 8),
    male_score NUMERIC(9, 8),
    uncertainty_score NUMERIC(9, 8),
    evidence TEXT,
    bucket TEXT NOT NULL CHECK (bucket IN ('female_priority', 'uncertainty', 'male_deprioritized')),
    routing_unavailable BOOLEAN NOT NULL,
    selected BOOLEAN NOT NULL,
    selection_reason TEXT NOT NULL CHECK (selection_reason IN (
        'population_within_cap', 'female_quota', 'uncertainty_quota', 'fill', 'not_selected'
    )),
    selection_slot TEXT CHECK (selection_slot IN ('female', 'uncertainty', 'fill')),
    ordinal SMALLINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, relationship_checkpoint_id, policy_version, mutual_ordinal),
    UNIQUE (request_id, relationship_checkpoint_id, policy_version, candidate_key),
    UNIQUE (request_id, relationship_checkpoint_id, policy_version, ordinal),
    FOREIGN KEY (request_id, relationship_checkpoint_id, policy_version)
        REFERENCES public.analysis_v2_gender_routing_manifests(
            request_id, relationship_checkpoint_id, policy_version
        ) ON DELETE CASCADE,
    FOREIGN KEY (request_id, relationship_job_key, mutual_ordinal)
        REFERENCES public.analysis_v2_mutual_rows(request_id, job_key, mutual_ordinal)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_gender_routing_candidates_hmac_check CHECK (
        (image_content_hmac IS NULL OR image_content_hmac ~ '^[a-f0-9]{64}$')
        AND (fullname_hmac IS NULL OR fullname_hmac ~ '^[a-f0-9]{64}$')
    ),
    CONSTRAINT analysis_v2_gender_routing_candidates_score_check CHECK (
        (female_score IS NULL AND male_score IS NULL AND uncertainty_score IS NULL AND evidence IS NULL)
        OR (female_score BETWEEN 0 AND 1 AND male_score BETWEEN 0 AND 1
            AND uncertainty_score BETWEEN 0 AND 1
            AND female_score + male_score + uncertainty_score BETWEEN 0.999999 AND 1.000001
            AND evidence IN ('image_and_name', 'image_only', 'name_only', 'none'))
    ),
    CONSTRAINT analysis_v2_gender_routing_candidates_evidence_check CHECK (
        evidence IS NULL OR evidence = CASE
            WHEN has_image AND has_name THEN 'image_and_name'
            WHEN has_image THEN 'image_only'
            WHEN has_name THEN 'name_only'
            ELSE 'none'
        END
    ),
    CONSTRAINT analysis_v2_gender_routing_candidates_selection_check CHECK (
        (selected AND ordinal IS NOT NULL AND ordinal >= 1 AND selection_slot IS NOT NULL
            AND selection_reason = CASE selection_slot
                WHEN 'female' THEN 'female_quota'
                WHEN 'uncertainty' THEN 'uncertainty_quota'
                WHEN 'fill' THEN selection_reason
            END
            AND (selection_slot <> 'fill' OR selection_reason IN ('population_within_cap', 'fill')))
        OR (NOT selected AND ordinal IS NULL AND selection_slot IS NULL AND selection_reason = 'not_selected')
    ),
    CONSTRAINT analysis_v2_gender_routing_candidates_identity_check CHECK (
        candidate_key = 'mutual:' || mutual_ordinal::TEXT
    )
);

ALTER TABLE public.analysis_v2_gender_routing_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_gender_routing_manifests FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_gender_routing_manifests
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_v2_gender_routing_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_gender_routing_candidates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_gender_routing_candidates
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_gender_routing_manifest_json(
    p_manifest public.analysis_v2_gender_routing_manifests
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'status', p_manifest.status,
        'attemptCount', p_manifest.attempt_count,
        'requestId', p_manifest.request_id,
        'relationshipCheckpointId', p_manifest.relationship_checkpoint_id,
        'relationshipJobInputHash', p_manifest.relationship_job_input_hash,
        'policyVersion', p_manifest.policy_version,
        'planId', p_manifest.plan_id,
        'canonicalInputHmac', p_manifest.canonical_input_hmac,
        'populationCount', p_manifest.population_count,
        'detailedCap', p_manifest.detailed_cap,
        'selectedCount', p_manifest.selected_count,
        'modelAttemptedCount', p_manifest.model_attempted_count,
        'modelValidCount', p_manifest.model_valid_count,
        'modelFailedCount', p_manifest.model_failed_count,
        'modelRetriedCount', p_manifest.model_retried_count,
        'quotaFemaleShortfall', p_manifest.quota_female_shortfall,
        'quotaUncertaintyShortfall', p_manifest.quota_uncertainty_shortfall,
        'femalePriorityCount', p_manifest.female_priority_count,
        'uncertaintyCount', p_manifest.uncertainty_count,
        'maleDeprioritizedCount', p_manifest.male_deprioritized_count,
        'selectedFemalePriorityCount', p_manifest.selected_female_priority_count,
        'selectedUncertaintyCount', p_manifest.selected_uncertainty_count,
        'selectedMaleDeprioritizedCount', p_manifest.selected_male_deprioritized_count
    ));
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_gender_routing_manifest_json(
    public.analysis_v2_gender_routing_manifests
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.begin_analysis_v2_gender_routing_manifest(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_relationship_checkpoint_id TEXT,
    p_policy_version TEXT,
    p_plan_id TEXT,
    p_canonical_input_hmac TEXT,
    p_population_count INTEGER,
    p_detailed_cap INTEGER
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_relationship public.analysis_v2_relationship_manifests%ROWTYPE;
    v_manifest public.analysis_v2_gender_routing_manifests%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key <> 'track:relationships:collect'
       OR p_claim_token IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_relationship_checkpoint_id !~ '^[a-f0-9]{64}$'
       OR p_policy_version <> 'gender-routing-v1'
       OR p_canonical_input_hmac !~ '^[a-f0-9]{64}$'
       OR (p_plan_id = 'basic' AND (p_detailed_cap <> 100 OR p_population_count NOT BETWEEN 0 AND 400))
       OR (p_plan_id = 'standard' AND (p_detailed_cap <> 200 OR p_population_count NOT BETWEEN 0 AND 800))
       OR p_plan_id NOT IN ('basic', 'standard') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id
    FOR UPDATE;
    SELECT relationship_manifest.* INTO v_relationship
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = p_job_key
      AND relationship_manifest.result_hash = p_relationship_checkpoint_id
    FOR UPDATE;

    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot IS DISTINCT FROM p_plan_id
       OR v_policy.request_id IS NULL
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_job.request_id IS NULL
       OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now
       OR v_relationship.request_id IS NULL
       OR v_relationship.public_count IS DISTINCT FROM p_population_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT routing_manifest.* INTO v_manifest
    FROM public.analysis_v2_gender_routing_manifests AS routing_manifest
    WHERE routing_manifest.request_id = p_request_id
      AND routing_manifest.relationship_checkpoint_id = p_relationship_checkpoint_id
      AND routing_manifest.policy_version = p_policy_version
    FOR UPDATE;

    IF FOUND THEN
        IF v_manifest.relationship_job_key IS DISTINCT FROM p_job_key
           OR v_manifest.relationship_job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_manifest.plan_id IS DISTINCT FROM p_plan_id
           OR v_manifest.detailed_cap IS DISTINCT FROM p_detailed_cap
           OR v_manifest.population_count IS DISTINCT FROM p_population_count
           OR v_manifest.canonical_input_hmac IS DISTINCT FROM p_canonical_input_hmac THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DRIFT', ERRCODE = 'P0001';
        END IF;
        IF v_manifest.status = 'complete' THEN
            RETURN public.analysis_v2_gender_routing_manifest_json(v_manifest);
        END IF;
        IF v_manifest.status = 'invalidated' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALIDATED', ERRCODE = 'P0001';
        END IF;
        UPDATE public.analysis_v2_gender_routing_manifests AS routing_manifest
        SET attempt_count = routing_manifest.attempt_count + 1,
            updated_at = v_now
        WHERE routing_manifest.request_id = p_request_id
          AND routing_manifest.relationship_checkpoint_id = p_relationship_checkpoint_id
          AND routing_manifest.policy_version = p_policy_version
        RETURNING * INTO v_manifest;
        RETURN public.analysis_v2_gender_routing_manifest_json(v_manifest);
    END IF;

    INSERT INTO public.analysis_v2_gender_routing_manifests (
        request_id, relationship_job_key, relationship_job_input_hash, relationship_checkpoint_id, policy_version,
        plan_id, detailed_cap, population_count, canonical_input_hmac, status,
        attempt_count, created_at, updated_at
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_relationship_checkpoint_id, p_policy_version,
        p_plan_id, p_detailed_cap, p_population_count, p_canonical_input_hmac, 'building',
        1, v_now, v_now
    ) RETURNING * INTO v_manifest;
    RETURN public.analysis_v2_gender_routing_manifest_json(v_manifest);
END;
$$;

REVOKE ALL ON FUNCTION public.begin_analysis_v2_gender_routing_manifest(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_analysis_v2_gender_routing_manifest(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER
) TO service_role;

CREATE OR REPLACE FUNCTION public.publish_analysis_v2_gender_routing_manifest(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_relationship_checkpoint_id TEXT,
    p_policy_version TEXT,
    p_plan_id TEXT,
    p_canonical_input_hmac TEXT,
    p_population_count INTEGER,
    p_detailed_cap INTEGER,
    p_selected_count INTEGER,
    p_model_attempted_count INTEGER,
    p_model_valid_count INTEGER,
    p_model_failed_count INTEGER,
    p_model_retried_count INTEGER,
    p_quota_female_shortfall INTEGER,
    p_quota_uncertainty_shortfall INTEGER,
    p_female_priority_count INTEGER,
    p_uncertainty_count INTEGER,
    p_male_deprioritized_count INTEGER,
    p_selected_female_priority_count INTEGER,
    p_selected_uncertainty_count INTEGER,
    p_selected_male_deprioritized_count INTEGER,
    p_rows JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_relationship public.analysis_v2_relationship_manifests%ROWTYPE;
    v_manifest public.analysis_v2_gender_routing_manifests%ROWTYPE;
    v_row JSONB;
    v_mutual_ordinal INTEGER;
    v_ordinal INTEGER;
    v_has_image BOOLEAN;
    v_has_name BOOLEAN;
    v_selected BOOLEAN;
    v_unavailable BOOLEAN;
    v_female_score NUMERIC;
    v_male_score NUMERIC;
    v_uncertainty_score NUMERIC;
    v_row_count INTEGER := 0;
    v_selected_count INTEGER := 0;
    v_callable_count INTEGER := 0;
    v_failed_count INTEGER := 0;
    v_female_priority_count INTEGER := 0;
    v_uncertainty_count INTEGER := 0;
    v_male_deprioritized_count INTEGER := 0;
    v_selected_female_priority_count INTEGER := 0;
    v_selected_uncertainty_count INTEGER := 0;
    v_selected_male_deprioritized_count INTEGER := 0;
    v_female_slot_count INTEGER := 0;
    v_uncertainty_slot_count INTEGER := 0;
    v_rows_hash TEXT;
    v_female_quota INTEGER;
    v_uncertainty_quota INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key <> 'track:relationships:collect'
       OR p_claim_token IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_relationship_checkpoint_id !~ '^[a-f0-9]{64}$'
       OR p_policy_version <> 'gender-routing-v1'
       OR p_canonical_input_hmac !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR (p_plan_id = 'basic' AND (p_detailed_cap <> 100 OR p_population_count NOT BETWEEN 0 AND 400))
       OR (p_plan_id = 'standard' AND (p_detailed_cap <> 200 OR p_population_count NOT BETWEEN 0 AND 800))
       OR p_plan_id NOT IN ('basic', 'standard') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;
    IF p_selected_count < 0 OR p_model_attempted_count < 0 OR p_model_valid_count < 0
       OR p_model_failed_count < 0 OR p_model_retried_count < 0
       OR p_quota_female_shortfall < 0 OR p_quota_uncertainty_shortfall < 0
       OR p_female_priority_count < 0 OR p_uncertainty_count < 0
       OR p_male_deprioritized_count < 0 OR p_selected_female_priority_count < 0
       OR p_selected_uncertainty_count < 0 OR p_selected_male_deprioritized_count < 0 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;
    v_rows_hash := pg_catalog.md5(p_rows::TEXT);
    v_female_quota := CASE WHEN p_plan_id = 'basic' THEN 80 ELSE 160 END;
    v_uncertainty_quota := CASE WHEN p_plan_id = 'basic' THEN 20 ELSE 40 END;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id
    FOR UPDATE;
    SELECT relationship_manifest.* INTO v_relationship
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = p_job_key
      AND relationship_manifest.result_hash = p_relationship_checkpoint_id
    FOR UPDATE;
    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot IS DISTINCT FROM p_plan_id
       OR v_policy.request_id IS NULL
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_job.request_id IS NULL
       OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now
       OR v_relationship.request_id IS NULL
       OR v_relationship.public_count IS DISTINCT FROM p_population_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT routing_manifest.* INTO v_manifest
    FROM public.analysis_v2_gender_routing_manifests AS routing_manifest
    WHERE routing_manifest.request_id = p_request_id
      AND routing_manifest.relationship_checkpoint_id = p_relationship_checkpoint_id
      AND routing_manifest.policy_version = p_policy_version
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_NOT_BUILDING', ERRCODE = 'P0001';
    END IF;
    IF v_manifest.relationship_job_key IS DISTINCT FROM p_job_key
       OR v_manifest.relationship_job_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_manifest.plan_id IS DISTINCT FROM p_plan_id
       OR v_manifest.detailed_cap IS DISTINCT FROM p_detailed_cap
       OR v_manifest.population_count IS DISTINCT FROM p_population_count
       OR v_manifest.canonical_input_hmac IS DISTINCT FROM p_canonical_input_hmac THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DRIFT', ERRCODE = 'P0001';
    END IF;
    IF v_manifest.status = 'invalidated' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALIDATED', ERRCODE = 'P0001';
    END IF;
    IF v_manifest.status = 'complete' THEN
        IF v_manifest.candidate_rows_hash IS DISTINCT FROM v_rows_hash
           OR v_manifest.selected_count IS DISTINCT FROM p_selected_count
           OR v_manifest.model_attempted_count IS DISTINCT FROM p_model_attempted_count
           OR v_manifest.model_valid_count IS DISTINCT FROM p_model_valid_count
           OR v_manifest.model_failed_count IS DISTINCT FROM p_model_failed_count
           OR v_manifest.model_retried_count IS DISTINCT FROM p_model_retried_count
           OR v_manifest.quota_female_shortfall IS DISTINCT FROM p_quota_female_shortfall
           OR v_manifest.quota_uncertainty_shortfall IS DISTINCT FROM p_quota_uncertainty_shortfall
           OR v_manifest.female_priority_count IS DISTINCT FROM p_female_priority_count
           OR v_manifest.uncertainty_count IS DISTINCT FROM p_uncertainty_count
           OR v_manifest.male_deprioritized_count IS DISTINCT FROM p_male_deprioritized_count
           OR v_manifest.selected_female_priority_count IS DISTINCT FROM p_selected_female_priority_count
           OR v_manifest.selected_uncertainty_count IS DISTINCT FROM p_selected_uncertainty_count
           OR v_manifest.selected_male_deprioritized_count IS DISTINCT FROM p_selected_male_deprioritized_count THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_gender_routing_manifest_json(v_manifest);
    END IF;

    IF pg_catalog.jsonb_array_length(p_rows) <> p_population_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;
    FOR v_row IN SELECT value FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value) LOOP
        IF pg_catalog.jsonb_typeof(v_row) <> 'object'
           OR NOT (v_row ?& ARRAY[
                'mutualOrdinal', 'candidateKey', 'hasImage', 'hasName',
                'imageContentHmac', 'fullnameHmac', 'femaleScore', 'maleScore',
                'uncertaintyScore', 'evidence', 'bucket', 'routingUnavailable',
                'selected', 'selectionReason', 'selectionSlot', 'ordinal'
           ]::TEXT[])
           OR EXISTS (
                SELECT 1 FROM pg_catalog.jsonb_object_keys(v_row) AS key_name(key_name)
                WHERE key_name.key_name NOT IN (
                    'mutualOrdinal', 'candidateKey', 'hasImage', 'hasName',
                    'imageContentHmac', 'fullnameHmac', 'femaleScore', 'maleScore',
                    'uncertaintyScore', 'evidence', 'bucket', 'routingUnavailable',
                    'selected', 'selectionReason', 'selectionSlot', 'ordinal'
                )
           )
           OR pg_catalog.jsonb_typeof(v_row->'mutualOrdinal') <> 'number'
           OR (v_row->>'mutualOrdinal') !~ '^[1-9][0-9]{0,3}$'
           OR pg_catalog.jsonb_typeof(v_row->'candidateKey') <> 'string'
           OR pg_catalog.jsonb_typeof(v_row->'hasImage') <> 'boolean'
           OR pg_catalog.jsonb_typeof(v_row->'hasName') <> 'boolean'
           OR pg_catalog.jsonb_typeof(v_row->'routingUnavailable') <> 'boolean'
           OR pg_catalog.jsonb_typeof(v_row->'selected') <> 'boolean'
           OR pg_catalog.jsonb_typeof(v_row->'bucket') <> 'string'
           OR pg_catalog.jsonb_typeof(v_row->'selectionReason') <> 'string' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
        END IF;
        v_mutual_ordinal := (v_row->>'mutualOrdinal')::INTEGER;
        v_has_image := (v_row->>'hasImage')::BOOLEAN;
        v_has_name := (v_row->>'hasName')::BOOLEAN;
        v_selected := (v_row->>'selected')::BOOLEAN;
        v_unavailable := (v_row->>'routingUnavailable')::BOOLEAN;
        IF v_mutual_ordinal > 1200
           OR v_row->>'candidateKey' <> 'mutual:' || v_mutual_ordinal::TEXT
           OR v_row->>'bucket' NOT IN ('female_priority', 'uncertainty', 'male_deprioritized')
           OR (v_has_image AND v_row->'imageContentHmac' = 'null'::JSONB)
           OR (NOT v_has_image AND v_row->'imageContentHmac' <> 'null'::JSONB)
           OR (v_has_name AND v_row->'fullnameHmac' = 'null'::JSONB)
           OR (NOT v_has_name AND v_row->'fullnameHmac' <> 'null'::JSONB)
           OR (v_row->'imageContentHmac' <> 'null'::JSONB AND (
                pg_catalog.jsonb_typeof(v_row->'imageContentHmac') <> 'string'
                OR v_row->>'imageContentHmac' !~ '^[a-f0-9]{64}$'))
           OR (v_row->'fullnameHmac' <> 'null'::JSONB AND (
                pg_catalog.jsonb_typeof(v_row->'fullnameHmac') <> 'string'
                OR v_row->>'fullnameHmac' !~ '^[a-f0-9]{64}$')) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
        END IF;
        IF v_row->'femaleScore' = 'null'::JSONB
           AND v_row->'maleScore' = 'null'::JSONB
           AND v_row->'uncertaintyScore' = 'null'::JSONB THEN
            IF v_row->'evidence' <> 'null'::JSONB THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
            END IF;
        ELSE
            IF pg_catalog.jsonb_typeof(v_row->'femaleScore') <> 'number'
               OR pg_catalog.jsonb_typeof(v_row->'maleScore') <> 'number'
               OR pg_catalog.jsonb_typeof(v_row->'uncertaintyScore') <> 'number'
               OR pg_catalog.jsonb_typeof(v_row->'evidence') <> 'string'
               OR (v_row->>'femaleScore') !~ '^(0|1)(\.[0-9]+)?$'
               OR (v_row->>'maleScore') !~ '^(0|1)(\.[0-9]+)?$'
               OR (v_row->>'uncertaintyScore') !~ '^(0|1)(\.[0-9]+)?$' THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
            END IF;
            v_female_score := (v_row->>'femaleScore')::NUMERIC;
            v_male_score := (v_row->>'maleScore')::NUMERIC;
            v_uncertainty_score := (v_row->>'uncertaintyScore')::NUMERIC;
            IF v_female_score NOT BETWEEN 0 AND 1 OR v_male_score NOT BETWEEN 0 AND 1
               OR v_uncertainty_score NOT BETWEEN 0 AND 1
               OR v_female_score + v_male_score + v_uncertainty_score NOT BETWEEN 0.999999 AND 1.000001
               OR v_row->>'evidence' <> (CASE
                    WHEN v_has_image AND v_has_name THEN 'image_and_name'
                    WHEN v_has_image THEN 'image_only'
                    WHEN v_has_name THEN 'name_only'
                    ELSE 'none'
               END)
               OR (v_row->>'bucket' = 'female_priority' AND (
                    v_female_score <= v_male_score OR v_uncertainty_score >= 0.4))
               OR (v_row->>'bucket' = 'uncertainty' AND NOT (
                    v_uncertainty_score >= 0.4 OR pg_catalog.abs(v_female_score - v_male_score) < 0.15))
               OR (v_row->>'bucket' = 'male_deprioritized' AND (
                    v_female_score > v_male_score
                    OR v_uncertainty_score >= 0.4
                    OR pg_catalog.abs(v_female_score - v_male_score) < 0.15)) THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
            END IF;
        END IF;
        IF v_selected THEN
            IF pg_catalog.jsonb_typeof(v_row->'ordinal') <> 'number'
               OR (v_row->>'ordinal') !~ '^[1-9][0-9]{0,2}$'
               OR pg_catalog.jsonb_typeof(v_row->'selectionSlot') <> 'string' THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
            END IF;
            v_ordinal := (v_row->>'ordinal')::INTEGER;
            IF v_ordinal > p_detailed_cap
               OR (v_row->>'selectionSlot' = 'female' AND v_row->>'selectionReason' <> 'female_quota')
               OR (v_row->>'selectionSlot' = 'uncertainty' AND v_row->>'selectionReason' <> 'uncertainty_quota')
               OR (v_row->>'selectionSlot' = 'fill' AND (
                    (p_population_count <= p_detailed_cap AND v_row->>'selectionReason' <> 'population_within_cap')
                    OR (p_population_count > p_detailed_cap AND v_row->>'selectionReason' <> 'fill')))
               OR (v_row->>'selectionSlot' = 'female' AND v_row->>'bucket' <> 'female_priority')
               OR (v_row->>'selectionSlot' = 'uncertainty' AND v_row->>'bucket' <> 'uncertainty')
               OR v_row->>'selectionSlot' NOT IN ('female', 'uncertainty', 'fill') THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
            END IF;
        ELSIF v_row->'ordinal' <> 'null'::JSONB
           OR v_row->'selectionSlot' <> 'null'::JSONB
           OR v_row->>'selectionReason' <> 'not_selected' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
        END IF;
        PERFORM 1
        FROM public.analysis_v2_mutual_rows AS mutual_row
        WHERE mutual_row.request_id = p_request_id
          AND mutual_row.job_key = p_job_key
          AND mutual_row.mutual_ordinal = v_mutual_ordinal
          AND NOT mutual_row.is_private;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_LINEAGE_MISMATCH', ERRCODE = 'P0001';
        END IF;
        v_row_count := v_row_count + 1;
        IF v_selected THEN
            v_selected_count := v_selected_count + 1;
            IF v_row->>'selectionSlot' = 'female' THEN v_female_slot_count := v_female_slot_count + 1; END IF;
            IF v_row->>'selectionSlot' = 'uncertainty' THEN v_uncertainty_slot_count := v_uncertainty_slot_count + 1; END IF;
        END IF;
        IF v_has_image OR v_has_name THEN
            v_callable_count := v_callable_count + 1;
            IF v_unavailable THEN v_failed_count := v_failed_count + 1; END IF;
        END IF;
        IF v_row->>'bucket' = 'female_priority' THEN
            v_female_priority_count := v_female_priority_count + 1;
            IF v_selected THEN v_selected_female_priority_count := v_selected_female_priority_count + 1; END IF;
        ELSIF v_row->>'bucket' = 'uncertainty' THEN
            v_uncertainty_count := v_uncertainty_count + 1;
            IF v_selected THEN v_selected_uncertainty_count := v_selected_uncertainty_count + 1; END IF;
        ELSE
            v_male_deprioritized_count := v_male_deprioritized_count + 1;
            IF v_selected THEN v_selected_male_deprioritized_count := v_selected_male_deprioritized_count + 1; END IF;
        END IF;
    END LOOP;
    IF v_row_count <> p_population_count
       OR (SELECT pg_catalog.count(DISTINCT (value->>'mutualOrdinal')::INTEGER)
           FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)) <> p_population_count
       OR (SELECT pg_catalog.count(DISTINCT (value->>'ordinal')::INTEGER)
           FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
           WHERE (value->>'selected')::BOOLEAN) <> v_selected_count
       OR (SELECT COALESCE(pg_catalog.min((value->>'ordinal')::INTEGER), 1)
           FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
           WHERE (value->>'selected')::BOOLEAN) <> 1
       OR (SELECT COALESCE(pg_catalog.max((value->>'ordinal')::INTEGER), 0)
           FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
           WHERE (value->>'selected')::BOOLEAN) <> v_selected_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;
    IF p_population_count <= p_detailed_cap THEN
        IF p_selected_count <> p_population_count OR v_selected_count <> p_population_count
           OR p_model_attempted_count <> 0 OR p_model_valid_count <> 0
           OR p_model_failed_count <> 0 OR p_model_retried_count <> 0
           OR p_quota_female_shortfall <> 0 OR p_quota_uncertainty_shortfall <> 0
           OR EXISTS (
                SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
                WHERE value->>'selectionReason' <> 'population_within_cap'
                   OR value->>'selectionSlot' <> 'fill'
                   OR value->'femaleScore' <> 'null'::JSONB
           ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
        END IF;
    ELSIF p_selected_count <> p_detailed_cap OR v_selected_count <> p_detailed_cap
       OR p_model_attempted_count <> v_callable_count
       OR p_model_valid_count <> v_callable_count - v_failed_count
       OR p_model_failed_count <> v_failed_count
       OR p_model_attempted_count = 0
       OR p_model_valid_count = 0
       OR p_model_failed_count::NUMERIC / p_model_attempted_count > 0.1
       OR p_model_retried_count > v_callable_count
       OR p_quota_female_shortfall <> GREATEST(0, v_female_quota - v_female_priority_count)
       OR p_quota_uncertainty_shortfall <> GREATEST(0, v_uncertainty_quota - v_uncertainty_count)
       OR v_female_slot_count <> LEAST(v_female_quota, v_female_priority_count)
       OR v_uncertainty_slot_count <> LEAST(v_uncertainty_quota, v_uncertainty_count) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;
    IF p_female_priority_count <> v_female_priority_count
       OR p_uncertainty_count <> v_uncertainty_count
       OR p_male_deprioritized_count <> v_male_deprioritized_count
       OR p_selected_female_priority_count <> v_selected_female_priority_count
       OR p_selected_uncertainty_count <> v_selected_uncertainty_count
       OR p_selected_male_deprioritized_count <> v_selected_male_deprioritized_count
       OR p_selected_count <> v_selected_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_gender_routing_candidates (
        request_id, relationship_checkpoint_id, policy_version, relationship_job_key,
        mutual_ordinal, candidate_key, has_image, has_name, image_content_hmac,
        fullname_hmac, female_score, male_score, uncertainty_score, evidence, bucket,
        routing_unavailable, selected, selection_reason, selection_slot, ordinal
    )
    SELECT p_request_id, p_relationship_checkpoint_id, p_policy_version, p_job_key,
        (value->>'mutualOrdinal')::SMALLINT, value->>'candidateKey',
        (value->>'hasImage')::BOOLEAN, (value->>'hasName')::BOOLEAN,
        NULLIF(value->>'imageContentHmac', ''), NULLIF(value->>'fullnameHmac', ''),
        CASE WHEN value->'femaleScore' = 'null'::JSONB THEN NULL ELSE (value->>'femaleScore')::NUMERIC END,
        CASE WHEN value->'maleScore' = 'null'::JSONB THEN NULL ELSE (value->>'maleScore')::NUMERIC END,
        CASE WHEN value->'uncertaintyScore' = 'null'::JSONB THEN NULL ELSE (value->>'uncertaintyScore')::NUMERIC END,
        NULLIF(value->>'evidence', ''), value->>'bucket', (value->>'routingUnavailable')::BOOLEAN,
        (value->>'selected')::BOOLEAN, value->>'selectionReason', NULLIF(value->>'selectionSlot', ''),
        CASE WHEN value->'ordinal' = 'null'::JSONB THEN NULL ELSE (value->>'ordinal')::SMALLINT END
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value);

    UPDATE public.analysis_v2_gender_routing_manifests AS routing_manifest
    SET status = 'complete', selected_count = p_selected_count,
        model_attempted_count = p_model_attempted_count, model_valid_count = p_model_valid_count,
        model_failed_count = p_model_failed_count, model_retried_count = p_model_retried_count,
        quota_female_shortfall = p_quota_female_shortfall,
        quota_uncertainty_shortfall = p_quota_uncertainty_shortfall,
        female_priority_count = p_female_priority_count, uncertainty_count = p_uncertainty_count,
        male_deprioritized_count = p_male_deprioritized_count,
        selected_female_priority_count = p_selected_female_priority_count,
        selected_uncertainty_count = p_selected_uncertainty_count,
        selected_male_deprioritized_count = p_selected_male_deprioritized_count,
        candidate_rows_hash = v_rows_hash, completed_at = v_now, updated_at = v_now
    WHERE routing_manifest.request_id = p_request_id
      AND routing_manifest.relationship_checkpoint_id = p_relationship_checkpoint_id
      AND routing_manifest.policy_version = p_policy_version
    RETURNING * INTO v_manifest;
    RETURN public.analysis_v2_gender_routing_manifest_json(v_manifest);
END;
$$;

REVOKE ALL ON FUNCTION public.publish_analysis_v2_gender_routing_manifest(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_analysis_v2_gender_routing_manifest(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, INTEGER, INTEGER,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_gender_routing_selected(
    p_request_id UUID,
    p_relationship_checkpoint_id TEXT,
    p_policy_version TEXT,
    p_plan_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.analysis_v2_gender_routing_manifests%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_relationship public.analysis_v2_relationship_manifests%ROWTYPE;
    v_row_count INTEGER;
    v_selected_count INTEGER;
    v_min_ordinal INTEGER;
    v_max_ordinal INTEGER;
    v_rows JSONB;
BEGIN
    IF p_request_id IS NULL
       OR p_relationship_checkpoint_id !~ '^[a-f0-9]{64}$'
       OR p_policy_version <> 'gender-routing-v1'
       OR p_plan_id NOT IN ('basic', 'standard') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT routing_manifest.* INTO v_manifest
    FROM public.analysis_v2_gender_routing_manifests AS routing_manifest
    WHERE routing_manifest.request_id = p_request_id
      AND routing_manifest.relationship_checkpoint_id = p_relationship_checkpoint_id
      AND routing_manifest.policy_version = p_policy_version
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_MISSING', ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = v_manifest.relationship_job_key
    FOR UPDATE;
    SELECT relationship_manifest.* INTO v_relationship
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = v_manifest.relationship_job_key
      AND relationship_manifest.result_hash = p_relationship_checkpoint_id
    FOR UPDATE;
    IF v_manifest.plan_id IS DISTINCT FROM p_plan_id
       OR (p_plan_id = 'basic' AND (v_manifest.detailed_cap <> 100 OR v_manifest.population_count NOT BETWEEN 0 AND 400))
       OR (p_plan_id = 'standard' AND (v_manifest.detailed_cap <> 200 OR v_manifest.population_count NOT BETWEEN 0 AND 800)) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DRIFT', ERRCODE = 'P0001';
    END IF;
    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status IS DISTINCT FROM 'processing'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot IS DISTINCT FROM p_plan_id
       OR v_policy.request_id IS NULL
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_job.request_id IS NULL
       OR v_job.input_hash IS DISTINCT FROM v_manifest.relationship_job_input_hash
       OR v_relationship.request_id IS NULL
       OR v_relationship.public_count IS DISTINCT FROM v_manifest.population_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_manifest.status IS DISTINCT FROM 'complete' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_NOT_COMPLETE', ERRCODE = 'P0001';
    END IF;
    SELECT pg_catalog.count(*)::INTEGER,
           (SELECT pg_catalog.count(*)::INTEGER
            FROM public.analysis_v2_gender_routing_candidates AS all_candidate
            WHERE all_candidate.request_id = p_request_id
              AND all_candidate.relationship_checkpoint_id = p_relationship_checkpoint_id
              AND all_candidate.policy_version = p_policy_version),
           COALESCE(pg_catalog.min(candidate.ordinal), 1),
           COALESCE(pg_catalog.max(candidate.ordinal), 0),
           COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'mutualOrdinal', candidate.mutual_ordinal,
                'candidateKey', candidate.candidate_key,
                'selectionSlot', candidate.selection_slot,
                'ordinal', candidate.ordinal
           ) ORDER BY candidate.ordinal), '[]'::JSONB)
    INTO v_selected_count, v_row_count, v_min_ordinal, v_max_ordinal, v_rows
    FROM public.analysis_v2_gender_routing_candidates AS candidate
    WHERE candidate.request_id = p_request_id
      AND candidate.relationship_checkpoint_id = p_relationship_checkpoint_id
      AND candidate.policy_version = p_policy_version
      AND candidate.selected;
    IF v_row_count IS DISTINCT FROM v_manifest.population_count
       OR v_selected_count IS DISTINCT FROM v_manifest.selected_count
       OR v_min_ordinal <> 1
       OR v_max_ordinal <> v_selected_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_CORRUPT', ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.jsonb_build_object('selectedCount', v_manifest.selected_count, 'rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_gender_routing_selected(
    UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_gender_routing_selected(
    UUID, TEXT, TEXT, TEXT
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_gender_routing_selected_usernames(
    p_request_id UUID,
    p_relationship_checkpoint_id TEXT,
    p_policy_version TEXT,
    p_plan_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.analysis_v2_gender_routing_manifests%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_relationship public.analysis_v2_relationship_manifests%ROWTYPE;
    v_row_count INTEGER;
    v_selected_count INTEGER;
    v_min_ordinal INTEGER;
    v_max_ordinal INTEGER;
    v_rows JSONB;
BEGIN
    IF p_request_id IS NULL
       OR p_relationship_checkpoint_id !~ '^[a-f0-9]{64}$'
       OR p_policy_version <> 'gender-routing-v1'
       OR p_plan_id NOT IN ('basic', 'standard') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT routing_manifest.* INTO v_manifest
    FROM public.analysis_v2_gender_routing_manifests AS routing_manifest
    WHERE routing_manifest.request_id = p_request_id
      AND routing_manifest.relationship_checkpoint_id = p_relationship_checkpoint_id
      AND routing_manifest.policy_version = p_policy_version
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_MISSING', ERRCODE = 'P0001';
    END IF;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = v_manifest.relationship_job_key
    FOR UPDATE;
    SELECT relationship_manifest.* INTO v_relationship
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = v_manifest.relationship_job_key
      AND relationship_manifest.result_hash = p_relationship_checkpoint_id
    FOR UPDATE;
    IF v_manifest.plan_id IS DISTINCT FROM p_plan_id
       OR (p_plan_id = 'basic' AND (v_manifest.detailed_cap <> 100 OR v_manifest.population_count NOT BETWEEN 0 AND 400))
       OR (p_plan_id = 'standard' AND (v_manifest.detailed_cap <> 200 OR v_manifest.population_count NOT BETWEEN 0 AND 800)) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_DRIFT', ERRCODE = 'P0001';
    END IF;
    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status IS DISTINCT FROM 'processing'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot IS DISTINCT FROM p_plan_id
       OR v_policy.request_id IS NULL
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_job.request_id IS NULL
       OR v_job.input_hash IS DISTINCT FROM v_manifest.relationship_job_input_hash
       OR v_relationship.request_id IS NULL
       OR v_relationship.public_count IS DISTINCT FROM v_manifest.population_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_manifest.status IS DISTINCT FROM 'complete' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_NOT_COMPLETE', ERRCODE = 'P0001';
    END IF;
    SELECT pg_catalog.count(*)::INTEGER,
           (SELECT pg_catalog.count(*)::INTEGER
            FROM public.analysis_v2_gender_routing_candidates AS all_candidate
            WHERE all_candidate.request_id = p_request_id
              AND all_candidate.relationship_checkpoint_id = p_relationship_checkpoint_id
              AND all_candidate.policy_version = p_policy_version),
           COALESCE(pg_catalog.min(candidate.ordinal), 1),
           COALESCE(pg_catalog.max(candidate.ordinal), 0),
           COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'mutualOrdinal', candidate.mutual_ordinal,
                'candidateKey', candidate.candidate_key,
                'selectionSlot', candidate.selection_slot,
                'ordinal', candidate.ordinal,
                'username', mutual_row.username
           ) ORDER BY candidate.ordinal), '[]'::JSONB)
    INTO v_selected_count, v_row_count, v_min_ordinal, v_max_ordinal, v_rows
    FROM public.analysis_v2_gender_routing_candidates AS candidate
    INNER JOIN public.analysis_v2_mutual_rows AS mutual_row
        ON mutual_row.request_id = candidate.request_id
       AND mutual_row.job_key = candidate.relationship_job_key
       AND mutual_row.mutual_ordinal = candidate.mutual_ordinal
    WHERE candidate.request_id = p_request_id
      AND candidate.relationship_checkpoint_id = p_relationship_checkpoint_id
      AND candidate.policy_version = p_policy_version
      AND candidate.selected
      AND NOT mutual_row.is_private;
    IF v_row_count IS DISTINCT FROM v_manifest.population_count
       OR v_selected_count IS DISTINCT FROM v_manifest.selected_count
       OR v_min_ordinal <> 1
       OR v_max_ordinal <> v_selected_count THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_GENDER_ROUTING_MANIFEST_CORRUPT', ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.jsonb_build_object('selectedCount', v_manifest.selected_count, 'rows', v_rows);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_gender_routing_selected_usernames(
    UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_gender_routing_selected_usernames(
    UUID, TEXT, TEXT, TEXT
) TO service_role;

-- A relationship checkpoint normally follows the frozen plan's detailed-mutual limit. The
-- nullable policy identity below is the sole exception: it records only the completed routing
-- manifest identity and aggregate counts, never a username or other relationship evidence.
ALTER TABLE public.analysis_v2_dag_stage_manifests
    ADD COLUMN relationship_selection_policy_version TEXT,
    ADD COLUMN relationship_selection_checkpoint_id VARCHAR(64),
    ADD COLUMN relationship_selection_job_input_hash VARCHAR(64),
    ADD COLUMN relationship_selection_plan_id TEXT,
    ADD COLUMN relationship_selection_public_population_count INTEGER,
    ADD COLUMN relationship_selection_selected_count INTEGER,
    ADD CONSTRAINT analysis_v2_dag_relationship_selection_policy_shape_check CHECK (
        (
            stage_kind = 'relationships'
            AND (
                pg_catalog.num_nonnulls(
                    relationship_selection_policy_version,
                    relationship_selection_checkpoint_id,
                    relationship_selection_job_input_hash,
                    relationship_selection_plan_id,
                    relationship_selection_public_population_count,
                    relationship_selection_selected_count
                ) = 0
                OR (
                    relationship_selection_policy_version = 'gender-routing-v1'
                    AND relationship_selection_checkpoint_id ~ '^[a-f0-9]{64}$'
                    AND relationship_selection_checkpoint_id = result_hash
                    AND relationship_selection_job_input_hash ~ '^[a-f0-9]{64}$'
                    AND relationship_selection_job_input_hash = producer_input_hash
                    AND relationship_selection_plan_id IN ('basic', 'standard')
                    AND relationship_selection_public_population_count = public_count
                    AND relationship_selection_selected_count = detailed_selected_public_count
                    AND (
                        (relationship_selection_plan_id = 'basic'
                            AND relationship_selection_public_population_count BETWEEN 0 AND 400
                            AND relationship_selection_selected_count
                                = LEAST(relationship_selection_public_population_count, 100))
                        OR (relationship_selection_plan_id = 'standard'
                            AND relationship_selection_public_population_count BETWEEN 0 AND 800
                            AND relationship_selection_selected_count
                                = LEAST(relationship_selection_public_population_count, 200))
                    )
                )
            )
        )
        OR (
            stage_kind <> 'relationships'
            AND pg_catalog.num_nonnulls(
                relationship_selection_policy_version,
                relationship_selection_checkpoint_id,
                relationship_selection_job_input_hash,
                relationship_selection_plan_id,
                relationship_selection_public_population_count,
                relationship_selection_selected_count
            ) = 0
        )
    );

CREATE OR REPLACE FUNCTION public.analysis_v2_dag_state_json(p_request_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
        'schemaVersion', scope.schema_version,
        'requestSnapshotHash', scope.request_snapshot_hash,
        'planId', scope.plan_id,
        'planSnapshotHash', scope.plan_snapshot_hash,
        'girlfriendExclusion', pg_catalog.jsonb_build_object(
            'decisionHash', scope.exclusion_decision_hash,
            'excludedCount', scope.excluded_count
        ),
        'relationships', (
            SELECT pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'detectedMutualCount', stage.detected_mutual_count,
                'publicCount', stage.public_count,
                'privateCount', stage.private_count,
                'detailedSelectedPublicCount', stage.detailed_selected_public_count,
                'notScreenedPublicCount', stage.not_screened_public_count,
                'profileBatches', COALESCE((
                    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'batch', topology.batch,
                        'itemCount', topology.item_count,
                        'inputHash', topology.input_hash
                    ) ORDER BY topology.batch)
                    FROM public.analysis_v2_dag_batch_topology AS topology
                    WHERE topology.request_id = scope.request_id
                      AND topology.topology_kind = 'profile'
                ), '[]'::JSONB),
                'privateNameBatches', COALESCE((
                    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                        'batch', topology.batch,
                        'itemCount', topology.item_count,
                        'inputHash', topology.input_hash
                    ) ORDER BY topology.batch)
                    FROM public.analysis_v2_dag_batch_topology AS topology
                    WHERE topology.request_id = scope.request_id
                      AND topology.topology_kind = 'private_name'
                ), '[]'::JSONB),
                'relationshipSelectionPolicy', CASE
                    WHEN stage.relationship_selection_policy_version IS NULL THEN NULL
                    ELSE pg_catalog.jsonb_build_object(
                        'policyVersion', stage.relationship_selection_policy_version,
                        'relationshipCheckpointId', stage.relationship_selection_checkpoint_id,
                        'relationshipJobInputHash', stage.relationship_selection_job_input_hash,
                        'planId', stage.relationship_selection_plan_id,
                        'publicPopulationCount', stage.relationship_selection_public_population_count,
                        'selectedCount', stage.relationship_selection_selected_count
                    )
                END
            ))
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id
              AND stage.stage_kind = 'relationships'
        ),
        'targetEvidence', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'interactorCount', stage.interactor_count
            )
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'target_evidence'
        ),
        'profileFetchBatches', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'batch', result.batch, 'itemCount', result.item_count,
                'producerInputHash', result.producer_input_hash,
                'revision', result.revision, 'resultHash', result.result_hash
            ) ORDER BY result.batch)
            FROM public.analysis_v2_dag_batch_results AS result
            WHERE result.request_id = scope.request_id AND result.result_kind = 'profile_fetch'
        ), '[]'::JSONB),
        'profileAiBatches', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'batch', result.batch, 'itemCount', result.item_count,
                'producerInputHash', result.producer_input_hash,
                'revision', result.revision, 'resultHash', result.result_hash
            ) ORDER BY result.batch)
            FROM public.analysis_v2_dag_batch_results AS result
            WHERE result.request_id = scope.request_id AND result.result_kind = 'profile_ai'
        ), '[]'::JSONB),
        'privateNameBatches', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'batch', result.batch, 'itemCount', result.item_count,
                'producerInputHash', result.producer_input_hash,
                'revision', result.revision, 'resultHash', result.result_hash
            ) ORDER BY result.batch)
            FROM public.analysis_v2_dag_batch_results AS result
            WHERE result.request_id = scope.request_id AND result.result_kind = 'private_name'
        ), '[]'::JSONB),
        'primaryJoin', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision, 'resultHash', stage.result_hash,
                'verifiedFemaleCount', stage.verified_female_count
            ) FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'primary_join'
        ),
        'screening', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision, 'resultHash', stage.result_hash,
                'verifiedFemaleCount', stage.verified_female_count,
                'shortlistCount', stage.shortlist_count, 'shortlistHash', stage.shortlist_hash
            ) FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'screening'
        ),
        'reverseLikes', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision, 'resultHash', stage.result_hash,
                'shortlistCount', stage.shortlist_count
            ) FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'reverse_likes'
        ),
        'partnerSafety', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision, 'resultHash', stage.result_hash,
                'shortlistCount', stage.shortlist_count
            ) FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'partner_safety'
        ),
        'finalScore', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision, 'resultHash', stage.result_hash,
                'featuredHighRiskCount', stage.featured_high_risk_count,
                'narrativeCount', stage.narrative_count,
                'narrativeBatchHash', stage.narrative_batch_hash
            ) FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'final_score'
        ),
        'narrative', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision, 'resultHash', stage.result_hash,
                'narrativeCount', stage.narrative_count
            ) FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'narrative'
        )
    ))
    FROM public.analysis_v2_dag_scopes AS scope
    WHERE scope.request_id = p_request_id;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_dag_state_json(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

-- Retain the deployed exact legacy path for every checkpoint that has no policy identity. Only
-- the special relationship form below can bypass its min(publicCount, detailedMutualLimit) rule.
ALTER FUNCTION public.checkpoint_analysis_v2_dag_manifest(UUID, TEXT, TEXT, UUID, TEXT, JSONB)
    RENAME TO checkpoint_analysis_v2_dag_manifest_legacy;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_dag_manifest_legacy(
    UUID, TEXT, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_dag_manifest(
    p_request_id UUID,
    p_job_key TEXT,
    p_input_hash TEXT,
    p_claim_token UUID,
    p_manifest_kind TEXT,
    p_manifest JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_scope public.analysis_v2_dag_scopes%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_relationship_manifest public.analysis_v2_relationship_manifests%ROWTYPE;
    v_routing_manifest public.analysis_v2_gender_routing_manifests%ROWTYPE;
    v_stage public.analysis_v2_dag_stage_manifests%ROWTYPE;
    v_detected INTEGER;
    v_public INTEGER;
    v_private INTEGER;
    v_detailed INTEGER;
    v_not_screened INTEGER;
    v_revision INTEGER;
    v_result_hash TEXT;
    v_profile_batches JSONB;
    v_private_batches JSONB;
    v_existing_batches JSONB;
    v_selection JSONB;
    v_selection_plan TEXT;
    v_population INTEGER;
    v_selected INTEGER;
    v_population_cap INTEGER;
    v_detailed_cap INTEGER;
    v_all_candidates INTEGER;
    v_selected_candidates INTEGER;
    v_min_ordinal INTEGER;
    v_max_ordinal INTEGER;
BEGIN
    IF p_manifest IS NULL
       OR pg_catalog.jsonb_typeof(p_manifest) <> 'object'
       OR NOT (p_manifest ? 'relationshipSelectionPolicy') THEN
        RETURN public.checkpoint_analysis_v2_dag_manifest_legacy(
            p_request_id, p_job_key, p_input_hash, p_claim_token, p_manifest_kind, p_manifest
        );
    END IF;

    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_job_key <> 'track:relationships:collect'
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[a-f0-9]{64}$'
       OR p_manifest_kind <> 'relationships'
       OR pg_catalog.octet_length(p_manifest::TEXT) > 65536
       OR NOT (p_manifest ?& ARRAY[
            'revision', 'resultHash', 'detectedMutualCount', 'publicCount', 'privateCount',
            'detailedSelectedPublicCount', 'notScreenedPublicCount', 'profileBatches',
            'privateNameBatches', 'relationshipSelectionPolicy'
       ])
       OR p_manifest - ARRAY[
            'revision', 'resultHash', 'detectedMutualCount', 'publicCount', 'privateCount',
            'detailedSelectedPublicCount', 'notScreenedPublicCount', 'profileBatches',
            'privateNameBatches', 'relationshipSelectionPolicy'
       ]::TEXT[] <> '{}'::JSONB
       OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'revision', 1, 1000000)
       OR pg_catalog.jsonb_typeof(p_manifest->'resultHash') <> 'string'
       OR p_manifest->>'resultHash' !~ '^[a-f0-9]{64}$'
       OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'detectedMutualCount', 0, 1200)
       OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'publicCount', 0, 1200)
       OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'privateCount', 0, 1200)
       OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'detailedSelectedPublicCount', 0, 200)
       OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'notScreenedPublicCount', 0, 1200)
       OR pg_catalog.jsonb_typeof(p_manifest->'profileBatches') <> 'array'
       OR pg_catalog.jsonb_typeof(p_manifest->'privateNameBatches') <> 'array'
       OR pg_catalog.jsonb_typeof(p_manifest->'relationshipSelectionPolicy') <> 'object' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
    END IF;

    v_selection := p_manifest->'relationshipSelectionPolicy';
    IF NOT (v_selection ?& ARRAY[
            'policyVersion', 'relationshipCheckpointId', 'relationshipJobInputHash', 'planId',
            'publicPopulationCount', 'selectedCount'
       ])
       OR v_selection - ARRAY[
            'policyVersion', 'relationshipCheckpointId', 'relationshipJobInputHash', 'planId',
            'publicPopulationCount', 'selectedCount'
       ]::TEXT[] <> '{}'::JSONB
       OR v_selection->>'policyVersion' <> 'gender-routing-v1'
       OR pg_catalog.jsonb_typeof(v_selection->'relationshipCheckpointId') <> 'string'
       OR v_selection->>'relationshipCheckpointId' !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(v_selection->'relationshipJobInputHash') <> 'string'
       OR v_selection->>'relationshipJobInputHash' !~ '^[a-f0-9]{64}$'
       OR v_selection->>'planId' NOT IN ('basic', 'standard')
       OR NOT public.analysis_v2_dag_bounded_integer(v_selection->'publicPopulationCount', 0, 1200)
       OR NOT public.analysis_v2_dag_bounded_integer(v_selection->'selectedCount', 0, 200) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
    END IF;

    v_revision := (p_manifest->>'revision')::INTEGER;
    v_result_hash := p_manifest->>'resultHash';
    v_detected := (p_manifest->>'detectedMutualCount')::INTEGER;
    v_public := (p_manifest->>'publicCount')::INTEGER;
    v_private := (p_manifest->>'privateCount')::INTEGER;
    v_detailed := (p_manifest->>'detailedSelectedPublicCount')::INTEGER;
    v_not_screened := (p_manifest->>'notScreenedPublicCount')::INTEGER;
    v_profile_batches := p_manifest->'profileBatches';
    v_private_batches := p_manifest->'privateNameBatches';
    v_selection_plan := v_selection->>'planId';
    v_population := (v_selection->>'publicPopulationCount')::INTEGER;
    v_selected := (v_selection->>'selectedCount')::INTEGER;
    v_population_cap := CASE WHEN v_selection_plan = 'basic' THEN 400 ELSE 800 END;
    v_detailed_cap := CASE WHEN v_selection_plan = 'basic' THEN 100 ELSE 200 END;

    IF v_public + v_private <> v_detected
       OR v_detected > v_population_cap
       OR v_population <> v_public
       OR v_selected <> v_detailed
       OR v_selected <> LEAST(v_population, v_detailed_cap)
       OR v_not_screened <> v_public - v_detailed
       OR pg_catalog.jsonb_array_length(v_profile_batches)
            <> (CASE WHEN v_detailed = 0 THEN 0 ELSE (v_detailed + 29) / 30 END)
       OR pg_catalog.jsonb_array_length(v_private_batches)
            <> (CASE WHEN v_private = 0 THEN 0 ELSE (v_private + 99) / 100 END)
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_profile_batches) WITH ORDINALITY AS item(value, ordinal)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY['batch', 'itemCount', 'inputHash'])
               OR item.value - ARRAY['batch', 'itemCount', 'inputHash']::TEXT[] <> '{}'::JSONB
               OR NOT public.analysis_v2_dag_bounded_integer(item.value->'batch', 0, 100000)
               OR NOT public.analysis_v2_dag_bounded_integer(item.value->'itemCount', 1, 30)
               OR pg_catalog.jsonb_typeof(item.value->'inputHash') <> 'string'
               OR item.value->>'inputHash' !~ '^[a-f0-9]{64}$'
               OR (item.value->>'batch')::INTEGER <> item.ordinal - 1
               OR (item.value->>'itemCount')::INTEGER <> LEAST(30, v_detailed - ((item.ordinal - 1) * 30))
       )
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(v_private_batches) WITH ORDINALITY AS item(value, ordinal)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY['batch', 'itemCount', 'inputHash'])
               OR item.value - ARRAY['batch', 'itemCount', 'inputHash']::TEXT[] <> '{}'::JSONB
               OR NOT public.analysis_v2_dag_bounded_integer(item.value->'batch', 0, 100000)
               OR NOT public.analysis_v2_dag_bounded_integer(item.value->'itemCount', 1, 100)
               OR pg_catalog.jsonb_typeof(item.value->'inputHash') <> 'string'
               OR item.value->>'inputHash' !~ '^[a-f0-9]{64}$'
               OR (item.value->>'batch')::INTEGER <> item.ordinal - 1
               OR (item.value->>'itemCount')::INTEGER <> LEAST(100, v_private - ((item.ordinal - 1) * 100))
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    SELECT scope.* INTO v_scope
    FROM public.analysis_v2_dag_scopes AS scope
    WHERE scope.request_id = p_request_id FOR SHARE;
    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id FOR UPDATE;
    SELECT relationship_manifest.* INTO v_relationship_manifest
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = p_job_key
      AND relationship_manifest.result_hash = v_result_hash FOR UPDATE;
    SELECT routing_manifest.* INTO v_routing_manifest
    FROM public.analysis_v2_gender_routing_manifests AS routing_manifest
    WHERE routing_manifest.request_id = p_request_id
      AND routing_manifest.relationship_checkpoint_id = v_result_hash
      AND routing_manifest.policy_version = 'gender-routing-v1' FOR UPDATE;

    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.selected_plan_id_snapshot IS DISTINCT FROM v_selection_plan
       OR v_scope.request_id IS NULL
       OR v_scope.plan_id IS DISTINCT FROM v_selection_plan
       OR v_job.request_id IS NULL
       OR v_job.track IS DISTINCT FROM 'relationships'
       OR v_job.kind IS DISTINCT FROM 'collection'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash IS DISTINCT FROM p_input_hash
       OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now
       OR v_policy.request_id IS NULL
       OR v_policy.mode IS DISTINCT FROM 'test_operation_split'
       OR v_policy.policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR v_relationship_manifest.request_id IS NULL
       OR v_relationship_manifest.public_count IS DISTINCT FROM v_public
       OR v_selection->>'relationshipCheckpointId' IS DISTINCT FROM v_result_hash
       OR v_selection->>'relationshipJobInputHash' IS DISTINCT FROM p_input_hash
       OR v_routing_manifest.request_id IS NULL
       OR v_routing_manifest.status IS DISTINCT FROM 'complete'
       OR v_routing_manifest.relationship_job_key IS DISTINCT FROM p_job_key
       OR v_routing_manifest.relationship_job_input_hash IS DISTINCT FROM p_input_hash
       OR v_routing_manifest.plan_id IS DISTINCT FROM v_selection_plan
       OR v_routing_manifest.detailed_cap IS DISTINCT FROM v_detailed_cap
       OR v_routing_manifest.population_count IS DISTINCT FROM v_population
       OR v_routing_manifest.selected_count IS DISTINCT FROM v_selected THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER,
           pg_catalog.count(*) FILTER (WHERE candidate.selected)::INTEGER,
           COALESCE(pg_catalog.min(candidate.ordinal) FILTER (WHERE candidate.selected), 1),
           COALESCE(pg_catalog.max(candidate.ordinal) FILTER (WHERE candidate.selected), 0)
    INTO v_all_candidates, v_selected_candidates, v_min_ordinal, v_max_ordinal
    FROM public.analysis_v2_gender_routing_candidates AS candidate
    WHERE candidate.request_id = p_request_id
      AND candidate.relationship_checkpoint_id = v_result_hash
      AND candidate.policy_version = 'gender-routing-v1';
    IF v_all_candidates IS DISTINCT FROM v_population
       OR v_selected_candidates IS DISTINCT FROM v_selected
       OR v_min_ordinal <> 1
       OR v_max_ordinal <> v_selected THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT stage.* INTO v_stage
    FROM public.analysis_v2_dag_stage_manifests AS stage
    WHERE stage.request_id = p_request_id AND stage.stage_kind = 'relationships' FOR UPDATE;
    IF FOUND THEN
        IF v_stage.producer_job_key <> p_job_key
           OR v_stage.producer_input_hash <> p_input_hash
           OR v_stage.revision <> v_revision
           OR v_stage.result_hash <> v_result_hash
           OR v_stage.detected_mutual_count <> v_detected
           OR v_stage.public_count <> v_public
           OR v_stage.private_count <> v_private
           OR v_stage.detailed_selected_public_count <> v_detailed
           OR v_stage.not_screened_public_count <> v_not_screened
           OR v_stage.relationship_selection_policy_version <> 'gender-routing-v1'
           OR v_stage.relationship_selection_checkpoint_id <> v_result_hash
           OR v_stage.relationship_selection_job_input_hash <> p_input_hash
           OR v_stage.relationship_selection_plan_id <> v_selection_plan
           OR v_stage.relationship_selection_public_population_count <> v_population
           OR v_stage.relationship_selection_selected_count <> v_selected THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;
    ELSE
        INSERT INTO public.analysis_v2_dag_stage_manifests (
            request_id, stage_kind, producer_job_key, producer_input_hash, revision, result_hash,
            detected_mutual_count, public_count, private_count, detailed_selected_public_count,
            not_screened_public_count, relationship_selection_policy_version,
            relationship_selection_checkpoint_id, relationship_selection_job_input_hash,
            relationship_selection_plan_id, relationship_selection_public_population_count,
            relationship_selection_selected_count
        ) VALUES (
            p_request_id, 'relationships', p_job_key, p_input_hash, v_revision, v_result_hash,
            v_detected, v_public, v_private, v_detailed, v_not_screened, 'gender-routing-v1',
            v_result_hash, p_input_hash, v_selection_plan, v_population, v_selected
        );
        INSERT INTO public.analysis_v2_dag_batch_topology (
            request_id, topology_kind, batch, item_count, input_hash,
            producer_job_key, producer_input_hash
        )
        SELECT p_request_id, 'profile', (item.value->>'batch')::INTEGER,
               (item.value->>'itemCount')::INTEGER, item.value->>'inputHash', p_job_key, p_input_hash
        FROM pg_catalog.jsonb_array_elements(v_profile_batches) AS item(value);
        INSERT INTO public.analysis_v2_dag_batch_topology (
            request_id, topology_kind, batch, item_count, input_hash,
            producer_job_key, producer_input_hash
        )
        SELECT p_request_id, 'private_name', (item.value->>'batch')::INTEGER,
               (item.value->>'itemCount')::INTEGER, item.value->>'inputHash', p_job_key, p_input_hash
        FROM pg_catalog.jsonb_array_elements(v_private_batches) AS item(value);
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_dag_batch_topology AS topology
        WHERE topology.request_id = p_request_id
          AND (topology.producer_job_key <> p_job_key OR topology.producer_input_hash <> p_input_hash)
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'batch', topology.batch, 'itemCount', topology.item_count, 'inputHash', topology.input_hash
    ) ORDER BY topology.batch), '[]'::JSONB)
    INTO v_existing_batches
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id AND topology.topology_kind = 'profile';
    IF v_existing_batches <> v_profile_batches THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;
    SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'batch', topology.batch, 'itemCount', topology.item_count, 'inputHash', topology.input_hash
    ) ORDER BY topology.batch), '[]'::JSONB)
    INTO v_existing_batches
    FROM public.analysis_v2_dag_batch_topology AS topology
    WHERE topology.request_id = p_request_id AND topology.topology_kind = 'private_name';
    IF v_existing_batches <> v_private_batches THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    RETURN public.analysis_v2_dag_state_json(p_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_dag_manifest(
    UUID, TEXT, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_dag_manifest(
    UUID, TEXT, TEXT, UUID, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_dag_state(p_request_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT public.analysis_v2_dag_state_json(p_request_id);
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_dag_state(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_dag_state(UUID) TO service_role;
