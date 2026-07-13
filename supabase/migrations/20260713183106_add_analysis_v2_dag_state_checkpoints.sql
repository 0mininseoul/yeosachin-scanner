-- Phase F: append-only, PII-free DAG scope and result manifests.
CREATE TABLE public.analysis_v2_dag_scopes (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    schema_version SMALLINT NOT NULL DEFAULT 2 CHECK (schema_version = 2),
    request_snapshot_hash VARCHAR(64) NOT NULL CHECK (
        request_snapshot_hash ~ '^[a-f0-9]{64}$'
    ),
    plan_id TEXT NOT NULL CHECK (plan_id IN ('basic', 'standard', 'plus')),
    plan_snapshot_hash VARCHAR(64) NOT NULL CHECK (
        plan_snapshot_hash ~ '^[a-f0-9]{64}$'
    ),
    exclusion_decision_hash VARCHAR(64) NOT NULL CHECK (
        exclusion_decision_hash ~ '^[a-f0-9]{64}$'
    ),
    excluded_count SMALLINT NOT NULL CHECK (excluded_count IN (0, 1)),
    initialized_by_job_key VARCHAR(160) NOT NULL
        CHECK (initialized_by_job_key = 'coordinator:bootstrap'),
    initialized_by_input_hash VARCHAR(64) NOT NULL CHECK (
        initialized_by_input_hash ~ '^[a-f0-9]{64}$'
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.analysis_v2_dag_stage_manifests (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_dag_scopes(request_id) ON DELETE CASCADE,
    stage_kind TEXT NOT NULL,
    producer_job_key VARCHAR(160) NOT NULL,
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    detected_mutual_count INTEGER,
    public_count INTEGER,
    private_count INTEGER,
    detailed_selected_public_count INTEGER,
    not_screened_public_count INTEGER,
    interactor_count INTEGER,
    verified_female_count INTEGER,
    shortlist_count INTEGER,
    shortlist_hash VARCHAR(64),
    featured_high_risk_count INTEGER,
    narrative_count INTEGER,
    narrative_batch_hash VARCHAR(64),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, stage_kind),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key),
    CONSTRAINT analysis_v2_dag_stage_kind_check CHECK (
        stage_kind IN (
            'relationships',
            'target_evidence',
            'primary_join',
            'screening',
            'reverse_likes',
            'partner_safety',
            'final_score',
            'narrative'
        )
    ),
    CONSTRAINT analysis_v2_dag_stage_producer_check CHECK (
        producer_job_key = CASE stage_kind
            WHEN 'relationships' THEN 'track:relationships:collect'
            WHEN 'target_evidence' THEN 'track:target-evidence:collect'
            WHEN 'primary_join' THEN 'coordinator:join:primary-evidence'
            WHEN 'screening' THEN 'coordinator:candidate-screening'
            WHEN 'reverse_likes' THEN 'track:reverse-likes:collect'
            WHEN 'partner_safety' THEN 'track:partner-safety:batch:0'
            WHEN 'final_score' THEN 'coordinator:join:final-score'
            WHEN 'narrative' THEN 'track:narratives:batch:0'
        END
    ),
    CONSTRAINT analysis_v2_dag_stage_hashes_check CHECK (
        (shortlist_hash IS NULL OR shortlist_hash ~ '^[a-f0-9]{64}$')
        AND (narrative_batch_hash IS NULL OR narrative_batch_hash ~ '^[a-f0-9]{64}$')
    ),
    CONSTRAINT analysis_v2_dag_stage_shape_check CHECK (
        (
            stage_kind = 'relationships'
            AND detected_mutual_count BETWEEN 0 AND 1200
            AND public_count BETWEEN 0 AND detected_mutual_count
            AND private_count BETWEEN 0 AND detected_mutual_count
            AND public_count + private_count = detected_mutual_count
            AND detailed_selected_public_count BETWEEN 0 AND 900
            AND detailed_selected_public_count <= public_count
            AND not_screened_public_count = public_count - detailed_selected_public_count
            AND pg_catalog.num_nonnulls(
                detected_mutual_count,
                public_count,
                private_count,
                detailed_selected_public_count,
                not_screened_public_count
            ) = 5
            AND pg_catalog.num_nonnulls(
                interactor_count,
                verified_female_count,
                shortlist_count,
                shortlist_hash,
                featured_high_risk_count,
                narrative_count,
                narrative_batch_hash
            ) = 0
        )
        OR (
            stage_kind = 'target_evidence'
            AND interactor_count IS NOT NULL
            AND interactor_count BETWEEN 0 AND 690
            AND pg_catalog.num_nonnulls(
                detected_mutual_count,
                public_count,
                private_count,
                detailed_selected_public_count,
                not_screened_public_count,
                verified_female_count,
                shortlist_count,
                shortlist_hash,
                featured_high_risk_count,
                narrative_count,
                narrative_batch_hash
            ) = 0
        )
        OR (
            stage_kind = 'primary_join'
            AND verified_female_count IS NOT NULL
            AND verified_female_count BETWEEN 0 AND 900
            AND pg_catalog.num_nonnulls(
                detected_mutual_count,
                public_count,
                private_count,
                detailed_selected_public_count,
                not_screened_public_count,
                interactor_count,
                shortlist_count,
                shortlist_hash,
                featured_high_risk_count,
                narrative_count,
                narrative_batch_hash
            ) = 0
        )
        OR (
            stage_kind = 'screening'
            AND verified_female_count IS NOT NULL
            AND shortlist_count IS NOT NULL
            AND verified_female_count BETWEEN 0 AND 900
            AND shortlist_count BETWEEN 0 AND 10
            AND shortlist_hash IS NOT NULL
            AND pg_catalog.num_nonnulls(
                detected_mutual_count,
                public_count,
                private_count,
                detailed_selected_public_count,
                not_screened_public_count,
                interactor_count,
                featured_high_risk_count,
                narrative_count,
                narrative_batch_hash
            ) = 0
        )
        OR (
            stage_kind IN ('reverse_likes', 'partner_safety')
            AND shortlist_count IS NOT NULL
            AND shortlist_count BETWEEN 0 AND 10
            AND pg_catalog.num_nonnulls(
                detected_mutual_count,
                public_count,
                private_count,
                detailed_selected_public_count,
                not_screened_public_count,
                interactor_count,
                verified_female_count,
                shortlist_hash,
                featured_high_risk_count,
                narrative_count,
                narrative_batch_hash
            ) = 0
        )
        OR (
            stage_kind = 'final_score'
            AND featured_high_risk_count IS NOT NULL
            AND narrative_count IS NOT NULL
            AND featured_high_risk_count BETWEEN 0 AND 3
            AND narrative_count = featured_high_risk_count
            AND narrative_batch_hash IS NOT NULL
            AND pg_catalog.num_nonnulls(
                detected_mutual_count,
                public_count,
                private_count,
                detailed_selected_public_count,
                not_screened_public_count,
                interactor_count,
                verified_female_count,
                shortlist_count,
                shortlist_hash
            ) = 0
        )
        OR (
            stage_kind = 'narrative'
            AND narrative_count IS NOT NULL
            AND narrative_count BETWEEN 0 AND 3
            AND pg_catalog.num_nonnulls(
                detected_mutual_count,
                public_count,
                private_count,
                detailed_selected_public_count,
                not_screened_public_count,
                interactor_count,
                verified_female_count,
                shortlist_count,
                shortlist_hash,
                featured_high_risk_count,
                narrative_batch_hash
            ) = 0
        )
    )
);

CREATE TABLE public.analysis_v2_dag_batch_topology (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_dag_scopes(request_id) ON DELETE CASCADE,
    topology_kind TEXT NOT NULL CHECK (topology_kind IN ('profile', 'private_name')),
    batch INTEGER NOT NULL CHECK (batch BETWEEN 0 AND 100000),
    item_count INTEGER NOT NULL,
    input_hash VARCHAR(64) NOT NULL CHECK (input_hash ~ '^[a-f0-9]{64}$'),
    producer_job_key VARCHAR(160) NOT NULL CHECK (
        producer_job_key = 'track:relationships:collect'
    ),
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, topology_kind, batch),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key),
    CONSTRAINT analysis_v2_dag_batch_topology_size_check CHECK (
        (topology_kind = 'profile' AND item_count BETWEEN 1 AND 30)
        OR (topology_kind = 'private_name' AND item_count BETWEEN 1 AND 100)
    )
);

CREATE TABLE public.analysis_v2_dag_batch_results (
    request_id UUID NOT NULL
        REFERENCES public.analysis_v2_dag_scopes(request_id) ON DELETE CASCADE,
    result_kind TEXT NOT NULL CHECK (
        result_kind IN ('profile_fetch', 'profile_ai', 'private_name')
    ),
    batch INTEGER NOT NULL CHECK (batch BETWEEN 0 AND 100000),
    item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 100),
    producer_job_key VARCHAR(160) NOT NULL,
    producer_input_hash VARCHAR(64) NOT NULL CHECK (
        producer_input_hash ~ '^[a-f0-9]{64}$'
    ),
    revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 1000000),
    result_hash VARCHAR(64) NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, result_kind, batch),
    FOREIGN KEY (request_id, producer_job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key),
    CONSTRAINT analysis_v2_dag_batch_result_producer_check CHECK (
        producer_job_key = CASE result_kind
            WHEN 'profile_fetch' THEN 'track:profiles:batch:' || batch::TEXT
            WHEN 'profile_ai' THEN 'track:profile-ai:batch:' || batch::TEXT
            WHEN 'private_name' THEN 'track:private-names:batch:' || batch::TEXT
        END
    ),
    CONSTRAINT analysis_v2_dag_batch_result_size_check CHECK (
        (result_kind IN ('profile_fetch', 'profile_ai') AND item_count BETWEEN 1 AND 30)
        OR (result_kind = 'private_name' AND item_count BETWEEN 1 AND 100)
    )
);

CREATE INDEX idx_analysis_v2_dag_stage_producer
    ON public.analysis_v2_dag_stage_manifests(request_id, producer_job_key);
CREATE INDEX idx_analysis_v2_dag_batch_result_producer
    ON public.analysis_v2_dag_batch_results(request_id, producer_job_key);

ALTER TABLE public.analysis_v2_dag_scopes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_dag_scopes FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_dag_stage_manifests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_dag_stage_manifests FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_dag_batch_topology ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_dag_batch_topology FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_dag_batch_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_dag_batch_results FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_v2_dag_scopes
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_dag_stage_manifests
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_dag_batch_topology
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_dag_batch_results
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_dag_scopes IS
    'Append-only PII-free V2 request scope, derived under the live bootstrap lease.';
COMMENT ON TABLE public.analysis_v2_dag_stage_manifests IS
    'Append-only typed singleton DAG result manifests; evidence and usernames are forbidden.';
COMMENT ON TABLE public.analysis_v2_dag_batch_topology IS
    'Append-only relationship-produced batch topology, preserving the producing input lineage.';
COMMENT ON TABLE public.analysis_v2_dag_batch_results IS
    'Append-only PII-free batch result manifests with exact producer job input lineage.';

CREATE OR REPLACE FUNCTION public.analysis_v2_dag_bounded_integer(
    p_value JSONB,
    p_minimum INTEGER,
    p_maximum INTEGER
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT CASE
        WHEN pg_catalog.jsonb_typeof(p_value) = 'number'
         AND p_value::TEXT ~ '^(0|[1-9][0-9]{0,6})$'
        THEN (p_value::TEXT)::NUMERIC BETWEEN p_minimum AND p_maximum
        ELSE FALSE
    END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_dag_bounded_integer(JSONB, INTEGER, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_dag_hash_json(p_value JSONB)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(p_value::TEXT, 'UTF8'), 'sha256'),
        'hex'
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_dag_hash_json(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

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
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'detectedMutualCount', stage.detected_mutual_count,
                'publicCount', stage.public_count,
                'privateCount', stage.private_count,
                'detailedSelectedPublicCount', stage.detailed_selected_public_count,
                'notScreenedPublicCount', stage.not_screened_public_count,
                'profileBatches', COALESCE((
                    SELECT pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'batch', topology.batch,
                            'itemCount', topology.item_count,
                            'inputHash', topology.input_hash
                        ) ORDER BY topology.batch
                    )
                    FROM public.analysis_v2_dag_batch_topology AS topology
                    WHERE topology.request_id = scope.request_id
                      AND topology.topology_kind = 'profile'
                ), '[]'::JSONB),
                'privateNameBatches', COALESCE((
                    SELECT pg_catalog.jsonb_agg(
                        pg_catalog.jsonb_build_object(
                            'batch', topology.batch,
                            'itemCount', topology.item_count,
                            'inputHash', topology.input_hash
                        ) ORDER BY topology.batch
                    )
                    FROM public.analysis_v2_dag_batch_topology AS topology
                    WHERE topology.request_id = scope.request_id
                      AND topology.topology_kind = 'private_name'
                ), '[]'::JSONB)
            )
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
            WHERE stage.request_id = scope.request_id
              AND stage.stage_kind = 'target_evidence'
        ),
        'profileFetchBatches', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'batch', result.batch,
                    'itemCount', result.item_count,
                    'producerInputHash', result.producer_input_hash,
                    'revision', result.revision,
                    'resultHash', result.result_hash
                ) ORDER BY result.batch
            )
            FROM public.analysis_v2_dag_batch_results AS result
            WHERE result.request_id = scope.request_id
              AND result.result_kind = 'profile_fetch'
        ), '[]'::JSONB),
        'profileAiBatches', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'batch', result.batch,
                    'itemCount', result.item_count,
                    'producerInputHash', result.producer_input_hash,
                    'revision', result.revision,
                    'resultHash', result.result_hash
                ) ORDER BY result.batch
            )
            FROM public.analysis_v2_dag_batch_results AS result
            WHERE result.request_id = scope.request_id
              AND result.result_kind = 'profile_ai'
        ), '[]'::JSONB),
        'privateNameBatches', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'batch', result.batch,
                    'itemCount', result.item_count,
                    'producerInputHash', result.producer_input_hash,
                    'revision', result.revision,
                    'resultHash', result.result_hash
                ) ORDER BY result.batch
            )
            FROM public.analysis_v2_dag_batch_results AS result
            WHERE result.request_id = scope.request_id
              AND result.result_kind = 'private_name'
        ), '[]'::JSONB),
        'primaryJoin', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'verifiedFemaleCount', stage.verified_female_count
            )
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'primary_join'
        ),
        'screening', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'verifiedFemaleCount', stage.verified_female_count,
                'shortlistCount', stage.shortlist_count,
                'shortlistHash', stage.shortlist_hash
            )
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'screening'
        ),
        'reverseLikes', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'shortlistCount', stage.shortlist_count
            )
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'reverse_likes'
        ),
        'partnerSafety', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'shortlistCount', stage.shortlist_count
            )
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'partner_safety'
        ),
        'finalScore', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'featuredHighRiskCount', stage.featured_high_risk_count,
                'narrativeCount', stage.narrative_count,
                'narrativeBatchHash', stage.narrative_batch_hash
            )
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'final_score'
        ),
        'narrative', (
            SELECT pg_catalog.jsonb_build_object(
                'revision', stage.revision,
                'resultHash', stage.result_hash,
                'narrativeCount', stage.narrative_count
            )
            FROM public.analysis_v2_dag_stage_manifests AS stage
            WHERE stage.request_id = scope.request_id AND stage.stage_kind = 'narrative'
        )
    ))
    FROM public.analysis_v2_dag_scopes AS scope
    WHERE scope.request_id = p_request_id;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_dag_state_json(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.initialize_analysis_v2_dag_scope(
    p_request_id UUID,
    p_job_key TEXT,
    p_input_hash TEXT,
    p_claim_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_scope public.analysis_v2_dag_scopes%ROWTYPE;
    v_request_hash TEXT;
    v_plan_hash TEXT;
    v_exclusion_hash TEXT;
    v_excluded_count SMALLINT;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key <> 'coordinator:bootstrap'
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[a-f0-9]{64}$'
       OR p_claim_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.track <> 'coordinator'
       OR v_job.kind <> 'bootstrap'
       OR v_job.batch IS NOT NULL
       OR v_job.input_hash <> p_input_hash
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard', 'plus')
       OR v_request.exclusion_decision_snapshot NOT IN ('exclude', 'skip') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
    END IF;

    v_excluded_count := CASE
        WHEN v_request.exclusion_decision_snapshot = 'exclude' THEN 1
        ELSE 0
    END;
    v_request_hash := public.analysis_v2_dag_hash_json(pg_catalog.jsonb_build_object(
        'domain', 'analysis-v2-request-snapshot-v1',
        'requestId', p_request_id,
        'schemaVersion', 2,
        'pipelineVersion', v_request.pipeline_version,
        'preflightId', v_request.preflight_id,
        'targetInstagramId', pg_catalog.lower(v_request.target_instagram_id),
        'selectedPlanId', v_request.selected_plan_id_snapshot,
        'exclusionDecision', v_request.exclusion_decision_snapshot,
        'excludedInstagramId', v_request.excluded_instagram_id,
        'analysisScope', v_request.analysis_scope_snapshot,
        'policyVersions', v_request.policy_versions_snapshot,
        'pricingVersion', v_request.pricing_version_snapshot
    ));
    v_plan_hash := public.analysis_v2_dag_hash_json(pg_catalog.jsonb_build_object(
        'domain', 'analysis-v2-plan-snapshot-v1',
        'requestId', p_request_id,
        'planId', v_request.selected_plan_id_snapshot,
        'planCard', pg_catalog.jsonb_extract_path(
            v_request.plan_cards_snapshot,
            v_request.selected_plan_id_snapshot
        ),
        'analysisScope', v_request.analysis_scope_snapshot,
        'policyVersions', v_request.policy_versions_snapshot
    ));
    v_exclusion_hash := public.analysis_v2_dag_hash_json(pg_catalog.jsonb_build_object(
        'domain', 'analysis-v2-exclusion-decision-v1',
        'requestId', p_request_id,
        'decision', v_request.exclusion_decision_snapshot,
        'excludedInstagramId', v_request.excluded_instagram_id
    ));

    SELECT scope.*
    INTO v_scope
    FROM public.analysis_v2_dag_scopes AS scope
    WHERE scope.request_id = p_request_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_scope.schema_version <> 2
           OR v_scope.request_snapshot_hash <> v_request_hash
           OR v_scope.plan_id <> v_request.selected_plan_id_snapshot
           OR v_scope.plan_snapshot_hash <> v_plan_hash
           OR v_scope.exclusion_decision_hash <> v_exclusion_hash
           OR v_scope.excluded_count <> v_excluded_count
           OR v_scope.initialized_by_job_key <> p_job_key
           OR v_scope.initialized_by_input_hash <> p_input_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_dag_state_json(p_request_id);
    END IF;

    INSERT INTO public.analysis_v2_dag_scopes (
        request_id,
        request_snapshot_hash,
        plan_id,
        plan_snapshot_hash,
        exclusion_decision_hash,
        excluded_count,
        initialized_by_job_key,
        initialized_by_input_hash
    ) VALUES (
        p_request_id,
        v_request_hash,
        v_request.selected_plan_id_snapshot,
        v_plan_hash,
        v_exclusion_hash,
        v_excluded_count,
        p_job_key,
        p_input_hash
    );

    RETURN public.analysis_v2_dag_state_json(p_request_id);
END;
$$;

REVOKE ALL ON FUNCTION public.initialize_analysis_v2_dag_scope(UUID, TEXT, TEXT, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.initialize_analysis_v2_dag_scope(UUID, TEXT, TEXT, UUID)
    TO service_role;

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
    v_now TIMESTAMP WITH TIME ZONE := clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_scope public.analysis_v2_dag_scopes%ROWTYPE;
    v_stage public.analysis_v2_dag_stage_manifests%ROWTYPE;
    v_batch_result public.analysis_v2_dag_batch_results%ROWTYPE;
    v_stage_exists BOOLEAN := FALSE;
    v_result_kind TEXT;
    v_topology_kind TEXT;
    v_expected_job_key TEXT;
    v_revision INTEGER;
    v_result_hash TEXT;
    v_batch INTEGER;
    v_item_count INTEGER;
    v_detected INTEGER;
    v_public INTEGER;
    v_private INTEGER;
    v_detailed INTEGER;
    v_not_screened INTEGER;
    v_interactor INTEGER;
    v_verified INTEGER;
    v_shortlist INTEGER;
    v_shortlist_hash TEXT;
    v_featured INTEGER;
    v_narrative INTEGER;
    v_narrative_batch_hash TEXT;
    v_profile_batches JSONB;
    v_private_batches JSONB;
    v_existing_batches JSONB;
    v_profile_limit INTEGER;
    v_relationship public.analysis_v2_dag_stage_manifests%ROWTYPE;
    v_dependency public.analysis_v2_dag_stage_manifests%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_claim_token IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_input_hash IS NULL
       OR p_input_hash !~ '^[a-f0-9]{64}$'
       OR p_manifest_kind IS NULL
       OR p_manifest_kind NOT IN (
            'relationships', 'target_evidence', 'profile_fetch_batch',
            'profile_ai_batch', 'private_name_batch', 'primary_join',
            'screening', 'reverse_likes', 'partner_safety', 'final_score', 'narrative'
       )
       OR p_manifest IS NULL
       OR pg_catalog.jsonb_typeof(p_manifest) <> 'object'
       OR pg_catalog.octet_length(p_manifest::TEXT) > 65536 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2'
    FOR UPDATE;
    IF NOT FOUND OR v_request.status NOT IN ('pending', 'processing') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_job.input_hash <> p_input_hash
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT scope.*
    INTO v_scope
    FROM public.analysis_v2_dag_scopes AS scope
    WHERE scope.request_id = p_request_id
    FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_SCOPE_MISSING', ERRCODE = 'P0001';
    END IF;

    IF NOT (p_manifest ?& ARRAY['revision', 'resultHash'])
       OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'revision', 1, 1000000)
       OR pg_catalog.jsonb_typeof(p_manifest->'resultHash') <> 'string'
       OR p_manifest->>'resultHash' !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
    END IF;
    v_revision := (p_manifest->>'revision')::INTEGER;
    v_result_hash := p_manifest->>'resultHash';

    IF p_manifest_kind IN ('profile_fetch_batch', 'profile_ai_batch', 'private_name_batch') THEN
        IF NOT (p_manifest ?& ARRAY[
                'batch', 'itemCount', 'producerInputHash', 'revision', 'resultHash'
            ])
           OR p_manifest - ARRAY[
                'batch', 'itemCount', 'producerInputHash', 'revision', 'resultHash'
            ]::TEXT[] <> '{}'::JSONB
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'batch', 0, 100000)
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'itemCount', 1, 100)
           OR pg_catalog.jsonb_typeof(p_manifest->'producerInputHash') <> 'string'
           OR p_manifest->>'producerInputHash' <> p_input_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;

        v_batch := (p_manifest->>'batch')::INTEGER;
        v_item_count := (p_manifest->>'itemCount')::INTEGER;
        v_result_kind := CASE p_manifest_kind
            WHEN 'profile_fetch_batch' THEN 'profile_fetch'
            WHEN 'profile_ai_batch' THEN 'profile_ai'
            ELSE 'private_name'
        END;
        v_topology_kind := CASE
            WHEN v_result_kind = 'private_name' THEN 'private_name'
            ELSE 'profile'
        END;
        v_expected_job_key := CASE v_result_kind
            WHEN 'profile_fetch' THEN 'track:profiles:batch:' || v_batch::TEXT
            WHEN 'profile_ai' THEN 'track:profile-ai:batch:' || v_batch::TEXT
            ELSE 'track:private-names:batch:' || v_batch::TEXT
        END;
        IF p_job_key <> v_expected_job_key
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_dag_batch_topology AS topology
                WHERE topology.request_id = p_request_id
                  AND topology.topology_kind = v_topology_kind
                  AND topology.batch = v_batch
                  AND topology.item_count = v_item_count
           )
           OR (
                v_result_kind = 'profile_ai'
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_dag_batch_results AS result
                    WHERE result.request_id = p_request_id
                      AND result.result_kind = 'profile_fetch'
                      AND result.batch = v_batch
                      AND result.item_count = v_item_count
                )
           ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;

        SELECT result.*
        INTO v_batch_result
        FROM public.analysis_v2_dag_batch_results AS result
        WHERE result.request_id = p_request_id
          AND result.result_kind = v_result_kind
          AND result.batch = v_batch
        FOR UPDATE;
        IF FOUND THEN
            IF v_batch_result.item_count <> v_item_count
               OR v_batch_result.producer_job_key <> p_job_key
               OR v_batch_result.producer_input_hash <> p_input_hash
               OR v_batch_result.revision <> v_revision
               OR v_batch_result.result_hash <> v_result_hash THEN
                RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
            END IF;
        ELSE
            INSERT INTO public.analysis_v2_dag_batch_results (
                request_id,
                result_kind,
                batch,
                item_count,
                producer_job_key,
                producer_input_hash,
                revision,
                result_hash
            ) VALUES (
                p_request_id,
                v_result_kind,
                v_batch,
                v_item_count,
                p_job_key,
                p_input_hash,
                v_revision,
                v_result_hash
            );
        END IF;
        RETURN public.analysis_v2_dag_state_json(p_request_id);
    END IF;

    v_expected_job_key := CASE p_manifest_kind
        WHEN 'relationships' THEN 'track:relationships:collect'
        WHEN 'target_evidence' THEN 'track:target-evidence:collect'
        WHEN 'primary_join' THEN 'coordinator:join:primary-evidence'
        WHEN 'screening' THEN 'coordinator:candidate-screening'
        WHEN 'reverse_likes' THEN 'track:reverse-likes:collect'
        WHEN 'partner_safety' THEN 'track:partner-safety:batch:0'
        WHEN 'final_score' THEN 'coordinator:join:final-score'
        WHEN 'narrative' THEN 'track:narratives:batch:0'
    END;
    IF p_job_key <> v_expected_job_key THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
    END IF;

    IF p_manifest_kind = 'relationships' THEN
        IF NOT (p_manifest ?& ARRAY[
                'revision', 'resultHash', 'detectedMutualCount', 'publicCount',
                'privateCount', 'detailedSelectedPublicCount', 'notScreenedPublicCount',
                'profileBatches', 'privateNameBatches'
            ])
           OR p_manifest - ARRAY[
                'revision', 'resultHash', 'detectedMutualCount', 'publicCount',
                'privateCount', 'detailedSelectedPublicCount', 'notScreenedPublicCount',
                'profileBatches', 'privateNameBatches'
            ]::TEXT[] <> '{}'::JSONB
           OR NOT public.analysis_v2_dag_bounded_integer(
                p_manifest->'detectedMutualCount', 0, 1200
           )
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'publicCount', 0, 1200)
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'privateCount', 0, 1200)
           OR NOT public.analysis_v2_dag_bounded_integer(
                p_manifest->'detailedSelectedPublicCount', 0, 900
           )
           OR NOT public.analysis_v2_dag_bounded_integer(
                p_manifest->'notScreenedPublicCount', 0, 1200
           )
           OR pg_catalog.jsonb_typeof(p_manifest->'profileBatches') <> 'array'
           OR pg_catalog.jsonb_typeof(p_manifest->'privateNameBatches') <> 'array' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
        v_detected := (p_manifest->>'detectedMutualCount')::INTEGER;
        v_public := (p_manifest->>'publicCount')::INTEGER;
        v_private := (p_manifest->>'privateCount')::INTEGER;
        v_detailed := (p_manifest->>'detailedSelectedPublicCount')::INTEGER;
        v_not_screened := (p_manifest->>'notScreenedPublicCount')::INTEGER;
        v_profile_batches := p_manifest->'profileBatches';
        v_private_batches := p_manifest->'privateNameBatches';
        v_profile_limit := CASE v_scope.plan_id
            WHEN 'basic' THEN 300 WHEN 'standard' THEN 600 ELSE 900
        END;
        IF v_detected > (CASE v_scope.plan_id
                WHEN 'basic' THEN 400 WHEN 'standard' THEN 800 ELSE 1200
            END)
           OR v_public + v_private <> v_detected
           OR v_detailed <> LEAST(v_public, v_profile_limit)
           OR v_not_screened <> v_public - v_detailed
           OR pg_catalog.jsonb_array_length(v_profile_batches)
                <> (CASE WHEN v_detailed = 0 THEN 0 ELSE (v_detailed + 29) / 30 END)
           OR pg_catalog.jsonb_array_length(v_private_batches)
                <> (CASE WHEN v_private = 0 THEN 0 ELSE (v_private + 99) / 100 END) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_profile_batches) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY['batch', 'itemCount', 'inputHash'])
               OR item.value - ARRAY['batch', 'itemCount', 'inputHash']::TEXT[] <> '{}'::JSONB
               OR NOT public.analysis_v2_dag_bounded_integer(item.value->'batch', 0, 100000)
               OR NOT public.analysis_v2_dag_bounded_integer(item.value->'itemCount', 1, 30)
               OR pg_catalog.jsonb_typeof(item.value->'inputHash') <> 'string'
               OR item.value->>'inputHash' !~ '^[a-f0-9]{64}$'
        ) OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_private_batches) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY['batch', 'itemCount', 'inputHash'])
               OR item.value - ARRAY['batch', 'itemCount', 'inputHash']::TEXT[] <> '{}'::JSONB
               OR NOT public.analysis_v2_dag_bounded_integer(item.value->'batch', 0, 100000)
               OR NOT public.analysis_v2_dag_bounded_integer(item.value->'itemCount', 1, 100)
               OR pg_catalog.jsonb_typeof(item.value->'inputHash') <> 'string'
               OR item.value->>'inputHash' !~ '^[a-f0-9]{64}$'
        ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
        IF EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_profile_batches) WITH ORDINALITY AS item(value, ordinal)
            WHERE (item.value->>'batch')::INTEGER <> item.ordinal - 1
               OR (item.value->>'itemCount')::INTEGER
                    <> LEAST(30, v_detailed - ((item.ordinal - 1) * 30))
        ) OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_private_batches) WITH ORDINALITY AS item(value, ordinal)
            WHERE (item.value->>'batch')::INTEGER <> item.ordinal - 1
               OR (item.value->>'itemCount')::INTEGER
                    <> LEAST(100, v_private - ((item.ordinal - 1) * 100))
        ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
    ELSIF p_manifest_kind = 'target_evidence' THEN
        IF NOT (p_manifest ?& ARRAY['revision', 'resultHash', 'interactorCount'])
           OR p_manifest - ARRAY['revision', 'resultHash', 'interactorCount']::TEXT[] <> '{}'::JSONB
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'interactorCount', 0, 690) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
        v_interactor := (p_manifest->>'interactorCount')::INTEGER;
    ELSIF p_manifest_kind = 'primary_join' THEN
        IF NOT (p_manifest ?& ARRAY['revision', 'resultHash', 'verifiedFemaleCount'])
           OR p_manifest - ARRAY['revision', 'resultHash', 'verifiedFemaleCount']::TEXT[] <> '{}'::JSONB
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'verifiedFemaleCount', 0, 900) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
        v_verified := (p_manifest->>'verifiedFemaleCount')::INTEGER;
        SELECT stage.* INTO v_relationship
        FROM public.analysis_v2_dag_stage_manifests AS stage
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'relationships';
        IF NOT FOUND
           OR v_verified > v_relationship.detailed_selected_public_count
           OR NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
                WHERE stage.request_id = p_request_id AND stage.stage_kind = 'target_evidence'
           )
           OR EXISTS (
                SELECT 1 FROM public.analysis_v2_dag_batch_topology AS topology
                WHERE topology.request_id = p_request_id AND topology.topology_kind = 'profile'
                  AND (
                    NOT EXISTS (
                        SELECT 1 FROM public.analysis_v2_dag_batch_results AS result
                        WHERE result.request_id = p_request_id
                          AND result.result_kind = 'profile_fetch'
                          AND result.batch = topology.batch
                          AND result.item_count = topology.item_count
                    )
                    OR NOT EXISTS (
                        SELECT 1 FROM public.analysis_v2_dag_batch_results AS result
                        WHERE result.request_id = p_request_id
                          AND result.result_kind = 'profile_ai'
                          AND result.batch = topology.batch
                          AND result.item_count = topology.item_count
                    )
                  )
           ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
    ELSIF p_manifest_kind = 'screening' THEN
        IF NOT (p_manifest ?& ARRAY[
                'revision', 'resultHash', 'verifiedFemaleCount', 'shortlistCount', 'shortlistHash'
            ])
           OR p_manifest - ARRAY[
                'revision', 'resultHash', 'verifiedFemaleCount', 'shortlistCount', 'shortlistHash'
            ]::TEXT[] <> '{}'::JSONB
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'verifiedFemaleCount', 0, 900)
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'shortlistCount', 0, 10)
           OR pg_catalog.jsonb_typeof(p_manifest->'shortlistHash') <> 'string'
           OR p_manifest->>'shortlistHash' !~ '^[a-f0-9]{64}$' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
        v_verified := (p_manifest->>'verifiedFemaleCount')::INTEGER;
        v_shortlist := (p_manifest->>'shortlistCount')::INTEGER;
        v_shortlist_hash := p_manifest->>'shortlistHash';
        SELECT stage.* INTO v_dependency
        FROM public.analysis_v2_dag_stage_manifests AS stage
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'primary_join';
        IF NOT FOUND
           OR v_verified <> v_dependency.verified_female_count
           OR v_shortlist <> LEAST(v_verified, 10) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
    ELSIF p_manifest_kind IN ('reverse_likes', 'partner_safety') THEN
        IF NOT (p_manifest ?& ARRAY['revision', 'resultHash', 'shortlistCount'])
           OR p_manifest - ARRAY['revision', 'resultHash', 'shortlistCount']::TEXT[] <> '{}'::JSONB
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'shortlistCount', 0, 10) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
        v_shortlist := (p_manifest->>'shortlistCount')::INTEGER;
        SELECT stage.* INTO v_dependency
        FROM public.analysis_v2_dag_stage_manifests AS stage
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'screening';
        IF NOT FOUND OR v_shortlist <> v_dependency.shortlist_count THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
    ELSIF p_manifest_kind = 'final_score' THEN
        IF NOT (p_manifest ?& ARRAY[
                'revision', 'resultHash', 'featuredHighRiskCount',
                'narrativeCount', 'narrativeBatchHash'
            ])
           OR p_manifest - ARRAY[
                'revision', 'resultHash', 'featuredHighRiskCount',
                'narrativeCount', 'narrativeBatchHash'
            ]::TEXT[] <> '{}'::JSONB
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'featuredHighRiskCount', 0, 3)
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'narrativeCount', 0, 3)
           OR pg_catalog.jsonb_typeof(p_manifest->'narrativeBatchHash') <> 'string'
           OR p_manifest->>'narrativeBatchHash' !~ '^[a-f0-9]{64}$' THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
        v_featured := (p_manifest->>'featuredHighRiskCount')::INTEGER;
        v_narrative := (p_manifest->>'narrativeCount')::INTEGER;
        v_narrative_batch_hash := p_manifest->>'narrativeBatchHash';
        SELECT stage.* INTO v_dependency
        FROM public.analysis_v2_dag_stage_manifests AS stage
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'screening';
        IF NOT FOUND
           OR v_featured > LEAST(v_dependency.verified_female_count, 3)
           OR v_narrative <> v_featured
           OR NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
                WHERE stage.request_id = p_request_id AND stage.stage_kind = 'reverse_likes'
           )
           OR NOT EXISTS (
                SELECT 1 FROM public.analysis_v2_dag_stage_manifests AS stage
                WHERE stage.request_id = p_request_id AND stage.stage_kind = 'partner_safety'
           ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
    ELSE
        IF NOT (p_manifest ?& ARRAY['revision', 'resultHash', 'narrativeCount'])
           OR p_manifest - ARRAY['revision', 'resultHash', 'narrativeCount']::TEXT[] <> '{}'::JSONB
           OR NOT public.analysis_v2_dag_bounded_integer(p_manifest->'narrativeCount', 0, 3) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
        v_narrative := (p_manifest->>'narrativeCount')::INTEGER;
        SELECT stage.* INTO v_dependency
        FROM public.analysis_v2_dag_stage_manifests AS stage
        WHERE stage.request_id = p_request_id AND stage.stage_kind = 'final_score';
        IF NOT FOUND OR v_narrative <> v_dependency.narrative_count THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_INVALID', ERRCODE = 'P0001';
        END IF;
    END IF;

    SELECT stage.*
    INTO v_stage
    FROM public.analysis_v2_dag_stage_manifests AS stage
    WHERE stage.request_id = p_request_id
      AND stage.stage_kind = p_manifest_kind
    FOR UPDATE;
    v_stage_exists := FOUND;
    IF v_stage_exists THEN
        IF v_stage.producer_job_key <> p_job_key
           OR v_stage.producer_input_hash <> p_input_hash
           OR v_stage.revision <> v_revision
           OR v_stage.result_hash <> v_result_hash
           OR v_stage.detected_mutual_count IS DISTINCT FROM v_detected
           OR v_stage.public_count IS DISTINCT FROM v_public
           OR v_stage.private_count IS DISTINCT FROM v_private
           OR v_stage.detailed_selected_public_count IS DISTINCT FROM v_detailed
           OR v_stage.not_screened_public_count IS DISTINCT FROM v_not_screened
           OR v_stage.interactor_count IS DISTINCT FROM v_interactor
           OR v_stage.verified_female_count IS DISTINCT FROM v_verified
           OR v_stage.shortlist_count IS DISTINCT FROM v_shortlist
           OR v_stage.shortlist_hash IS DISTINCT FROM v_shortlist_hash
           OR v_stage.featured_high_risk_count IS DISTINCT FROM v_featured
           OR v_stage.narrative_count IS DISTINCT FROM v_narrative
           OR v_stage.narrative_batch_hash IS DISTINCT FROM v_narrative_batch_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;
    ELSE
        INSERT INTO public.analysis_v2_dag_stage_manifests (
            request_id,
            stage_kind,
            producer_job_key,
            producer_input_hash,
            revision,
            result_hash,
            detected_mutual_count,
            public_count,
            private_count,
            detailed_selected_public_count,
            not_screened_public_count,
            interactor_count,
            verified_female_count,
            shortlist_count,
            shortlist_hash,
            featured_high_risk_count,
            narrative_count,
            narrative_batch_hash
        ) VALUES (
            p_request_id,
            p_manifest_kind,
            p_job_key,
            p_input_hash,
            v_revision,
            v_result_hash,
            v_detected,
            v_public,
            v_private,
            v_detailed,
            v_not_screened,
            v_interactor,
            v_verified,
            v_shortlist,
            v_shortlist_hash,
            v_featured,
            v_narrative,
            v_narrative_batch_hash
        );
    END IF;

    IF p_manifest_kind = 'relationships' THEN
        IF NOT v_stage_exists THEN
            INSERT INTO public.analysis_v2_dag_batch_topology (
                request_id,
                topology_kind,
                batch,
                item_count,
                input_hash,
                producer_job_key,
                producer_input_hash
            )
            SELECT
                p_request_id,
                'profile',
                (item.value->>'batch')::INTEGER,
                (item.value->>'itemCount')::INTEGER,
                item.value->>'inputHash',
                p_job_key,
                p_input_hash
            FROM pg_catalog.jsonb_array_elements(v_profile_batches) AS item(value);

            INSERT INTO public.analysis_v2_dag_batch_topology (
                request_id,
                topology_kind,
                batch,
                item_count,
                input_hash,
                producer_job_key,
                producer_input_hash
            )
            SELECT
                p_request_id,
                'private_name',
                (item.value->>'batch')::INTEGER,
                (item.value->>'itemCount')::INTEGER,
                item.value->>'inputHash',
                p_job_key,
                p_input_hash
            FROM pg_catalog.jsonb_array_elements(v_private_batches) AS item(value);
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.analysis_v2_dag_batch_topology AS topology
            WHERE topology.request_id = p_request_id
              AND (
                topology.producer_job_key <> p_job_key
                OR topology.producer_input_hash <> p_input_hash
              )
        ) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;

        SELECT COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'batch', topology.batch,
                'itemCount', topology.item_count,
                'inputHash', topology.input_hash
            ) ORDER BY topology.batch
        ), '[]'::JSONB)
        INTO v_existing_batches
        FROM public.analysis_v2_dag_batch_topology AS topology
        WHERE topology.request_id = p_request_id AND topology.topology_kind = 'profile';
        IF v_existing_batches <> v_profile_batches THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;

        SELECT COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'batch', topology.batch,
                'itemCount', topology.item_count,
                'inputHash', topology.input_hash
            ) ORDER BY topology.batch
        ), '[]'::JSONB)
        INTO v_existing_batches
        FROM public.analysis_v2_dag_batch_topology AS topology
        WHERE topology.request_id = p_request_id AND topology.topology_kind = 'private_name';
        IF v_existing_batches <> v_private_batches THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_DAG_STATE_CONFLICT', ERRCODE = 'P0001';
        END IF;
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

COMMENT ON FUNCTION public.initialize_analysis_v2_dag_scope(UUID, TEXT, TEXT, UUID) IS
    'Derives and freezes PII-free V2 scope hashes under the exact live bootstrap lease.';
COMMENT ON FUNCTION public.checkpoint_analysis_v2_dag_manifest(UUID, TEXT, TEXT, UUID, TEXT, JSONB) IS
    'Appends one strict typed stage or batch manifest under its exact live producer lease.';
COMMENT ON FUNCTION public.load_analysis_v2_dag_state(UUID) IS
    'Loads only the PII-free append-only state required by the deterministic V2 DAG planner.';
