-- Forward-only contract for the outer stage-one routing pass.  The existing
-- source_attempt remains Gemini transport lineage; it must never be reused as
-- the outer retry number.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

ALTER TABLE public.analysis_revenue_cost_operations
    ADD COLUMN routing_attempt SMALLINT;

ALTER TABLE public.analysis_revenue_cost_operations
    ADD CONSTRAINT analysis_revenue_cost_operations_routing_attempt_check
    CHECK (
        routing_attempt IS NULL
        OR (
            routing_attempt IN (1, 2)
            AND owner_kind = 'ai_attempt'
            AND source_job_key = 'track:relationships:collect'
            AND operation_kind IN ('stage_one_routing', 'stage_one_routing_retry')
        )
    ) NOT VALID;

CREATE TABLE public.analysis_revenue_ai_routing_attempt_lineages (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    job_key TEXT NOT NULL CHECK (job_key = 'track:relationships:collect'),
    job_input_hash TEXT NOT NULL CHECK (job_input_hash ~ '^[a-f0-9]{64}$'),
    source_operation_key_hash TEXT NOT NULL CHECK (source_operation_key_hash ~ '^[a-f0-9]{64}$'),
    routing_attempt SMALLINT NOT NULL CHECK (routing_attempt IN (1, 2)),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, source_operation_key_hash)
);

ALTER TABLE public.analysis_revenue_ai_routing_attempt_lineages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_ai_routing_attempt_lineages FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_ai_routing_attempt_lineages
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.analysis_revenue_ai_routing_attempt_lineages
    TO service_role;

CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_set_routing_attempt_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_routing_attempt SMALLINT;
BEGIN
    IF NEW.owner_kind <> 'ai_attempt' THEN
        IF NEW.routing_attempt IS NOT NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
        RETURN NEW;
    END IF;

    SELECT routing_attempt INTO v_routing_attempt
      FROM public.analysis_revenue_ai_routing_attempt_lineages
     WHERE request_id = NEW.request_id
       AND job_key = NEW.source_job_key
       AND source_operation_key_hash = NEW.source_operation_key_hash;
    IF FOUND THEN
        IF NEW.routing_attempt IS NOT NULL AND NEW.routing_attempt <> v_routing_attempt THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
        NEW.routing_attempt := v_routing_attempt;
    ELSIF NEW.routing_attempt IS NOT NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_set_routing_attempt_v1()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER analysis_revenue_cost_operations_set_routing_attempt_v1
BEFORE INSERT OR UPDATE OF owner_kind, source_job_key, source_operation_key_hash, routing_attempt
ON public.analysis_revenue_cost_operations
FOR EACH ROW EXECUTE FUNCTION public.analysis_revenue_ai_set_routing_attempt_v1();

CREATE OR REPLACE FUNCTION public.register_analysis_revenue_ai_routing_attempt_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_source_operation_key TEXT,
    p_source_attempt SMALLINT,
    p_routing_attempt SMALLINT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_ai public.analysis_v2_ai_attempts%ROWTYPE;
    v_existing public.analysis_revenue_ai_routing_attempt_lineages%ROWTYPE;
    v_source_hash TEXT;
BEGIN
    IF p_job_key IS DISTINCT FROM 'track:relationships:collect'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_source_operation_key !~ '^gender-triage:[a-f0-9]{64}$'
       OR p_source_attempt NOT BETWEEN 1 AND 4
       OR p_routing_attempt NOT IN (1, 2) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash, TRUE
    );
    SELECT * INTO v_ai
      FROM public.analysis_v2_ai_attempts
     WHERE request_id = p_request_id
       AND job_key = p_job_key
       AND operation_key = p_source_operation_key
       AND attempt = p_source_attempt
     FOR UPDATE;
    IF v_ai.request_id IS NULL
       OR v_ai.job_claim_token IS DISTINCT FROM p_job_claim_token
       OR v_ai.stage IS DISTINCT FROM 'genderTriage'
       OR v_ai.status IS DISTINCT FROM 'reserved'
       OR v_ai.retry_count IS DISTINCT FROM p_source_attempt - 1 THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_source_hash := pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(p_source_operation_key, 'UTF8'), 'sha256'),
        'hex'
    );
    SELECT * INTO v_existing
      FROM public.analysis_revenue_ai_routing_attempt_lineages
     WHERE request_id = p_request_id
       AND job_key = p_job_key
       AND source_operation_key_hash = v_source_hash
     FOR UPDATE;
    IF v_existing.request_id IS NOT NULL THEN
        IF v_existing.job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_existing.routing_attempt IS DISTINCT FROM p_routing_attempt THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'accepted', 'created', FALSE, 'replayed', TRUE
        );
    END IF;
    INSERT INTO public.analysis_revenue_ai_routing_attempt_lineages(
        request_id, job_key, job_input_hash, source_operation_key_hash, routing_attempt
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, v_source_hash, p_routing_attempt
    );
    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'accepted', 'created', TRUE, 'replayed', FALSE
    );
END;
$$;
REVOKE ALL ON FUNCTION public.register_analysis_revenue_ai_routing_attempt_v1(
    UUID, TEXT, UUID, TEXT, TEXT, SMALLINT, SMALLINT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_analysis_revenue_ai_routing_attempt_v1(
    UUID, TEXT, UUID, TEXT, TEXT, SMALLINT, SMALLINT
) TO service_role;

-- Preserve the reviewed mapping verbatim under an explicit legacy name.  New
-- callers use the durable outer-pass registry below; old source rows with no
-- registry retain their reviewed source_attempt semantics.
CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_operation_mapping_legacy_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_input_hash TEXT,
    p_plan_id TEXT,
    p_operation_key TEXT,
    p_source_attempt SMALLINT,
    p_stage TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_manifest public.analysis_v2_gender_routing_manifests%ROWTYPE;
    v_manifest_count INTEGER := 0;
BEGIN
    IF p_plan_id NOT IN ('basic', 'standard') OR p_source_attempt NOT BETWEEN 1 AND 4
       OR p_operation_key IS NULL OR p_stage IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF p_stage = 'genderTriage'
       AND p_operation_key ~ '^gender-triage:[a-f0-9]{64}$'
       AND p_job_key = 'track:relationships:collect' THEN
        FOR v_manifest IN
            SELECT * FROM public.analysis_v2_gender_routing_manifests
             WHERE request_id = p_request_id
               AND relationship_job_key = p_job_key
               AND relationship_job_input_hash = p_job_input_hash
               AND policy_version = 'gender-routing-v1'
               AND plan_id = p_plan_id
               AND status IN ('building', 'complete')
             FOR UPDATE
        LOOP
            v_manifest_count := v_manifest_count + 1;
            IF v_manifest_count > 1 THEN
                RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
            END IF;
        END LOOP;
        IF v_manifest_count <> 1 OR v_manifest.request_id IS NULL THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'operation_kind', CASE WHEN p_source_attempt = 1
                THEN 'stage_one_routing' ELSE 'stage_one_routing_retry' END,
            'selected_manifest_scope_hash', v_manifest.canonical_input_hmac
        );
    ELSIF p_stage = 'genderTriage'
       AND p_operation_key ~ '^gender-triage:[a-f0-9]{64}$'
       AND p_job_key ~ '^track:profile-ai:batch:[0-9]+$' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_profile');
    ELSIF p_stage = 'genderResolution'
       AND p_operation_key ~ '^gender-resolution:[a-f0-9]{64}$'
       AND p_job_key ~ '^track:profile-ai:batch:[0-9]+$' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'resolver');
    ELSIF p_stage = 'featureAnalysis'
       AND p_operation_key ~ '^feature-analysis:[a-f0-9]{64}$'
       AND p_job_key ~ '^track:profile-ai:batch:[0-9]+$' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_media');
    ELSIF p_stage = 'privateAccountName'
       AND p_operation_key ~ '^private-account-name:[a-f0-9]{64}$'
       AND p_job_key ~ '^track:private-names:batch:[0-9]+$' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_profile');
    ELSIF p_stage = 'partnerSafety'
       AND p_operation_key ~ '^partner-safety:[a-f0-9]{64}$'
       AND p_job_key = 'track:partner-safety:batch:0' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_interaction');
    ELSIF p_stage = 'highRiskNarrative'
       AND p_operation_key ~ '^high-risk-narrative:[a-f0-9]{64}$'
       AND p_job_key = 'track:narratives:batch:0' THEN
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'detail_interaction');
    END IF;
    RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_operation_mapping_legacy_v1(
    UUID, TEXT, TEXT, TEXT, TEXT, SMALLINT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_revenue_ai_cost_operation_mapping_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_input_hash TEXT,
    p_plan_id TEXT,
    p_operation_key TEXT,
    p_source_attempt SMALLINT,
    p_stage TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_lineage public.analysis_revenue_ai_routing_attempt_lineages%ROWTYPE;
    v_manifest public.analysis_v2_gender_routing_manifests%ROWTYPE;
    v_manifest_count INTEGER := 0;
    v_source_hash TEXT;
BEGIN
    -- The strict opportunistic resolver is intentionally owned by
    -- primary_join. It is admitted by the durable request-scoped pass before
    -- this normal AI audit/cost lifecycle can reserve a Gemini attempt.
    IF p_stage = 'genderResolution'
       AND p_job_key = 'coordinator:join:primary-evidence'
       AND p_operation_key ~ '^gender-resolution:[a-f0-9]{64}$' THEN
        IF p_plan_id NOT IN ('basic', 'standard')
           OR p_source_attempt NOT BETWEEN 1 AND 4 THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
        v_source_hash := pg_catalog.encode(
            extensions.digest(pg_catalog.convert_to(p_operation_key, 'UTF8'), 'sha256'),
            'hex'
        );
        IF NOT EXISTS (
            SELECT 1
            FROM public.analysis_revenue_resolver_passes AS pass
            JOIN public.analysis_revenue_resolver_capacity_reservations AS reservation
              ON reservation.request_id = pass.request_id
             AND reservation.job_key = pass.job_key
             AND reservation.job_input_hash = pass.job_input_hash
             AND reservation.operation_key_hash = v_source_hash
             AND reservation.disposition = 'accepted'
            WHERE pass.request_id = p_request_id
              AND pass.job_key = p_job_key
              AND pass.job_input_hash = p_job_input_hash
              AND pass.plan_id = p_plan_id
        ) THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
        END IF;
        RETURN pg_catalog.jsonb_build_object('operation_kind', 'resolver');
    END IF;
    IF p_stage = 'genderTriage'
       AND p_job_key = 'track:relationships:collect'
       AND p_operation_key ~ '^gender-triage:[a-f0-9]{64}$' THEN
        v_source_hash := pg_catalog.encode(
            extensions.digest(pg_catalog.convert_to(p_operation_key, 'UTF8'), 'sha256'),
            'hex'
        );
        SELECT * INTO v_lineage
          FROM public.analysis_revenue_ai_routing_attempt_lineages
         WHERE request_id = p_request_id
           AND job_key = p_job_key
           AND source_operation_key_hash = v_source_hash
         FOR UPDATE;
        IF v_lineage.request_id IS NOT NULL THEN
            IF v_lineage.job_input_hash IS DISTINCT FROM p_job_input_hash
               OR v_lineage.routing_attempt NOT IN (1, 2)
               OR p_source_attempt NOT BETWEEN 1 AND 4
               OR p_plan_id NOT IN ('basic', 'standard') THEN
                RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
            END IF;
            FOR v_manifest IN
                SELECT * FROM public.analysis_v2_gender_routing_manifests
                 WHERE request_id = p_request_id
                   AND relationship_job_key = p_job_key
                   AND relationship_job_input_hash = p_job_input_hash
                   AND policy_version = 'gender-routing-v1'
                   AND plan_id = p_plan_id
                   AND status IN ('building', 'complete')
                 FOR UPDATE
            LOOP
                v_manifest_count := v_manifest_count + 1;
                IF v_manifest_count > 1 THEN
                    RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
                END IF;
            END LOOP;
            IF v_manifest_count <> 1 OR v_manifest.request_id IS NULL THEN
                RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
            END IF;
            RETURN pg_catalog.jsonb_build_object(
                'operation_kind', CASE WHEN v_lineage.routing_attempt = 1
                    THEN 'stage_one_routing' ELSE 'stage_one_routing_retry' END,
                'selected_manifest_scope_hash', v_manifest.canonical_input_hmac
            );
        END IF;
    END IF;
    RETURN public.analysis_revenue_ai_cost_operation_mapping_legacy_v1(
        p_request_id, p_job_key, p_job_input_hash, p_plan_id,
        p_operation_key, p_source_attempt, p_stage
    );
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_revenue_ai_cost_operation_mapping_v1(
    UUID, TEXT, TEXT, TEXT, TEXT, SMALLINT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN public.analysis_revenue_cost_operations.routing_attempt IS
    'Immutable outer stage-one routing pass (1 or 2); source_attempt remains Gemini transport lineage.';
COMMENT ON TABLE public.analysis_revenue_ai_routing_attempt_lineages IS
    'Forward-only immutable outer routing pass registry for Basic/Standard test-entitlement stage-one AI.';

-- The finalizer records its real persisted cohort once. This remains a
-- forward-only companion to the reviewed cost schema: a failing quality gate
-- is durable manual-review evidence, never an in-memory helper result.
CREATE TABLE public.analysis_revenue_final_coverage_gates (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
    job_key TEXT NOT NULL CHECK (job_key = 'coordinator:finalize'),
    job_input_hash TEXT NOT NULL CHECK (job_input_hash ~ '^[a-f0-9]{64}$'),
    public_mutual_count INTEGER NOT NULL CHECK (public_mutual_count >= 0),
    screened_count INTEGER NOT NULL CHECK (screened_count >= 0),
    not_screened_count INTEGER NOT NULL CHECK (not_screened_count >= 0),
    unknown_burden_count INTEGER NOT NULL CHECK (unknown_burden_count >= 0),
    disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'manual_review')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.analysis_revenue_final_coverage_gates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_final_coverage_gates FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_final_coverage_gates
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.analysis_revenue_final_coverage_gates
    TO service_role;

CREATE OR REPLACE FUNCTION public.record_analysis_revenue_coverage_gate_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_public_mutual_count INTEGER,
    p_screened_count INTEGER,
    p_not_screened_count INTEGER,
    p_unknown_burden_count INTEGER,
    p_coverage_valid BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing public.analysis_revenue_final_coverage_gates%ROWTYPE;
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_valid BOOLEAN;
BEGIN
    IF p_job_key IS DISTINCT FROM 'coordinator:finalize'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_public_mutual_count IS NULL
       OR p_screened_count IS NULL
       OR p_not_screened_count IS NULL
       OR p_unknown_burden_count IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash, TRUE
    );
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_parent
      FROM public.analysis_revenue_run_ledgers
     WHERE request_id = p_request_id
     FOR UPDATE;

    v_valid := p_coverage_valid IS TRUE
        AND p_public_mutual_count >= 0
        AND p_screened_count >= 0
        AND p_not_screened_count >= 0
        AND p_unknown_burden_count >= 0
        AND p_screened_count + p_not_screened_count = p_public_mutual_count
        AND p_unknown_burden_count <= p_screened_count
        -- A zero selected cohort is valid only when there was no public cohort.
        AND (p_public_mutual_count = 0 OR p_screened_count > 0)
        -- Exact integer semantics: exactly 30 percent passes; greater fails.
        AND p_unknown_burden_count * 10 <= p_screened_count * 3;

    SELECT * INTO v_existing
      FROM public.analysis_revenue_final_coverage_gates
     WHERE request_id = p_request_id
     FOR UPDATE;
    IF v_existing.request_id IS NOT NULL THEN
        IF v_existing.job_key IS DISTINCT FROM p_job_key
           OR v_existing.job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_existing.public_mutual_count IS DISTINCT FROM p_public_mutual_count
           OR v_existing.screened_count IS DISTINCT FROM p_screened_count
           OR v_existing.not_screened_count IS DISTINCT FROM p_not_screened_count
           OR v_existing.unknown_burden_count IS DISTINCT FROM p_unknown_burden_count
           OR v_parent.public_mutual_count IS DISTINCT FROM p_public_mutual_count
           OR v_parent.screened_count IS DISTINCT FROM p_screened_count
           OR v_parent.not_screened_count IS DISTINCT FROM p_not_screened_count
           OR v_parent.unknown_burden_count IS DISTINCT FROM p_unknown_burden_count THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
        END IF;
        IF v_existing.disposition = 'accepted'
           AND v_valid
           AND v_parent.status = 'running'
           AND v_parent.manual_review_reason IS NULL THEN
            RETURN pg_catalog.jsonb_build_object(
                'disposition', 'accepted', 'created', FALSE, 'replayed', TRUE
            );
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'manual_review', 'created', FALSE, 'replayed', TRUE
        );
    END IF;

    IF v_valid
       AND v_parent.status = 'running'
       AND v_parent.manual_review_reason IS NULL THEN
        INSERT INTO public.analysis_revenue_final_coverage_gates(
            request_id, job_key, job_input_hash, public_mutual_count,
            screened_count, not_screened_count, unknown_burden_count, disposition
        ) VALUES (
            p_request_id, p_job_key, p_job_input_hash, p_public_mutual_count,
            p_screened_count, p_not_screened_count, p_unknown_burden_count, 'accepted'
        );
        UPDATE public.analysis_revenue_run_ledgers
           SET public_mutual_count = p_public_mutual_count,
               screened_count = p_screened_count,
               not_screened_count = p_not_screened_count,
               unknown_burden_count = p_unknown_burden_count
         WHERE request_id = p_request_id;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'accepted', 'created', TRUE, 'replayed', FALSE
        );
    END IF;

    INSERT INTO public.analysis_revenue_final_coverage_gates(
        request_id, job_key, job_input_hash, public_mutual_count,
        screened_count, not_screened_count, unknown_burden_count, disposition
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_public_mutual_count,
        p_screened_count, p_not_screened_count, p_unknown_burden_count, 'manual_review'
    );
    UPDATE public.analysis_revenue_run_ledgers
       SET public_mutual_count = p_public_mutual_count,
           screened_count = p_screened_count,
           not_screened_count = p_not_screened_count,
           unknown_burden_count = p_unknown_burden_count,
           status = 'manual_review',
           manual_review_reason = CASE
               WHEN manual_review_reason IN (
                   'cost_overrun', 'cost_denied', 'ambiguous_external_call'
               ) THEN manual_review_reason
               ELSE 'routing_failure'
           END
     WHERE request_id = p_request_id;
    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'manual_review', 'created', TRUE, 'replayed', FALSE
    );
END;
$$;
REVOKE ALL ON FUNCTION public.record_analysis_revenue_coverage_gate_v1(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_analysis_revenue_coverage_gate_v1(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN
) TO service_role;

COMMENT ON TABLE public.analysis_revenue_final_coverage_gates IS
    'Immutable final strict-cohort coverage decision; non-passing values durably force revenue manual_review.';

-- A strict request gets one immutable primary-join resolver plan only after the
-- exact integer unknown gate fails. The plan stores no candidate identifier,
-- URL, model input, or HMAC: only its canonical opaque digest and aggregate
-- counts. A recovery can resume its admitted operation identities, but cannot
-- form a second pass or broaden the selected cohort.
CREATE TABLE public.analysis_revenue_resolver_passes (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
    job_key TEXT NOT NULL CHECK (job_key = 'coordinator:join:primary-evidence'),
    job_input_hash TEXT NOT NULL CHECK (job_input_hash ~ '^[a-f0-9]{64}$'),
    plan_id TEXT NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    capacity_limit SMALLINT NOT NULL CHECK (capacity_limit IN (20, 40)),
    plan_hash TEXT NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
    screened_count INTEGER NOT NULL CHECK (screened_count BETWEEN 1 AND 900),
    unknown_burden_count INTEGER NOT NULL CHECK (unknown_burden_count BETWEEN 1 AND 900),
    final_unknown_burden_count INTEGER,
    disposition TEXT NOT NULL DEFAULT 'started'
        CHECK (disposition IN ('started', 'accepted', 'manual_review')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    completed_at TIMESTAMPTZ,
    CHECK (unknown_burden_count <= screened_count),
    CHECK (unknown_burden_count * 10 > screened_count * 3),
    CHECK (
        (disposition = 'started' AND final_unknown_burden_count IS NULL AND completed_at IS NULL)
        OR (
            disposition IN ('accepted', 'manual_review')
            AND final_unknown_burden_count BETWEEN 0 AND screened_count
            AND completed_at IS NOT NULL
        )
    )
);

ALTER TABLE public.analysis_revenue_resolver_passes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_resolver_passes FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_resolver_passes
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.analysis_revenue_resolver_passes
    TO service_role;

CREATE OR REPLACE FUNCTION public.begin_analysis_revenue_resolver_pass_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_plan_hash TEXT,
    p_screened_count INTEGER,
    p_unknown_burden_count INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_existing public.analysis_revenue_resolver_passes%ROWTYPE;
    v_limit SMALLINT;
BEGIN
    IF p_job_key IS DISTINCT FROM 'coordinator:join:primary-evidence'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_plan_hash !~ '^[a-f0-9]{64}$'
       OR p_screened_count IS NULL
       OR p_unknown_burden_count IS NULL
       OR p_screened_count < 1
       OR p_unknown_burden_count < 1
       OR p_unknown_burden_count > p_screened_count
       OR p_unknown_burden_count * 10 <= p_screened_count * 3 THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash, TRUE
    );
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_parent
      FROM public.analysis_revenue_run_ledgers
     WHERE request_id = p_request_id
     FOR UPDATE;
    v_limit := CASE v_parent.plan_id WHEN 'basic' THEN 20 ELSE 40 END;
    SELECT * INTO v_existing
      FROM public.analysis_revenue_resolver_passes
     WHERE request_id = p_request_id
     FOR UPDATE;
    IF v_existing.request_id IS NOT NULL THEN
        IF v_existing.job_key IS DISTINCT FROM p_job_key
           OR v_existing.job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_existing.plan_id IS DISTINCT FROM v_parent.plan_id
           OR v_existing.capacity_limit IS DISTINCT FROM v_limit
           OR v_existing.plan_hash IS DISTINCT FROM p_plan_hash
           OR v_existing.screened_count IS DISTINCT FROM p_screened_count
           OR v_existing.unknown_burden_count IS DISTINCT FROM p_unknown_burden_count THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
        END IF;
        IF v_parent.status = 'running' AND v_parent.manual_review_reason IS NULL THEN
            RETURN pg_catalog.jsonb_build_object(
                'disposition', 'accepted', 'created', FALSE, 'replayed', TRUE
            );
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'manual_review', 'created', FALSE, 'replayed', TRUE
        );
    END IF;
    IF v_parent.status IS DISTINCT FROM 'running' OR v_parent.manual_review_reason IS NOT NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'manual_review', 'created', TRUE, 'replayed', FALSE
        );
    END IF;
    INSERT INTO public.analysis_revenue_resolver_passes(
        request_id, job_key, job_input_hash, plan_id, capacity_limit, plan_hash,
        screened_count, unknown_burden_count
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, v_parent.plan_id, v_limit,
        p_plan_hash, p_screened_count, p_unknown_burden_count
    );
    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'accepted', 'created', TRUE, 'replayed', FALSE
    );
END;
$$;
REVOKE ALL ON FUNCTION public.begin_analysis_revenue_resolver_pass_v1(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_analysis_revenue_resolver_pass_v1(
    UUID, TEXT, UUID, TEXT, TEXT, INTEGER, INTEGER
) TO service_role;

-- A resolver slot is a request-scoped economic admission, not a transient
-- Gemini lease. Its stable operation hash means retries/recovery replay the
-- same allocation and cannot consume a second Basic/Standard resolver unit.
CREATE TABLE public.analysis_revenue_resolver_capacity_reservations (
    request_id UUID NOT NULL REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
    operation_key_hash TEXT NOT NULL CHECK (operation_key_hash ~ '^[a-f0-9]{64}$'),
    job_key TEXT NOT NULL CHECK (job_key = 'coordinator:join:primary-evidence'),
    job_input_hash TEXT NOT NULL CHECK (job_input_hash ~ '^[a-f0-9]{64}$'),
    plan_id TEXT NOT NULL CHECK (plan_id IN ('basic', 'standard')),
    capacity_limit SMALLINT NOT NULL CHECK (capacity_limit IN (20, 40)),
    disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'capacity_skipped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, operation_key_hash)
);

ALTER TABLE public.analysis_revenue_resolver_capacity_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_resolver_capacity_reservations FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_resolver_capacity_reservations
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.analysis_revenue_resolver_capacity_reservations
    TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_revenue_resolver_capacity_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_operation_key TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_pass public.analysis_revenue_resolver_passes%ROWTYPE;
    v_existing public.analysis_revenue_resolver_capacity_reservations%ROWTYPE;
    v_operation_hash TEXT;
    v_limit SMALLINT;
    v_reserved_count INTEGER;
BEGIN
    IF p_job_key IS DISTINCT FROM 'coordinator:join:primary-evidence'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_operation_key !~ '^gender-resolution:[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    -- This is the same immutable entitlement + runner + parent ledger fence
    -- used by cost reservation, before the resolver's Gemini boundary.
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash, TRUE
    );
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_parent
      FROM public.analysis_revenue_run_ledgers
     WHERE request_id = p_request_id
     FOR UPDATE;
    v_limit := CASE v_parent.plan_id WHEN 'basic' THEN 20 ELSE 40 END;
    SELECT * INTO v_pass
      FROM public.analysis_revenue_resolver_passes
     WHERE request_id = p_request_id
     FOR UPDATE;
    IF v_pass.request_id IS NULL
       OR v_pass.job_key IS DISTINCT FROM p_job_key
       OR v_pass.job_input_hash IS DISTINCT FROM p_job_input_hash
       OR v_pass.plan_id IS DISTINCT FROM v_parent.plan_id
       OR v_pass.capacity_limit IS DISTINCT FROM v_limit THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    v_operation_hash := pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(p_operation_key, 'UTF8'), 'sha256'),
        'hex'
    );
    SELECT * INTO v_existing
      FROM public.analysis_revenue_resolver_capacity_reservations
     WHERE request_id = p_request_id
       AND operation_key_hash = v_operation_hash
     FOR UPDATE;
    IF v_existing.request_id IS NOT NULL THEN
        IF v_existing.job_key IS DISTINCT FROM p_job_key
           OR v_existing.job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_existing.plan_id IS DISTINCT FROM v_parent.plan_id
           OR v_existing.capacity_limit IS DISTINCT FROM v_limit THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
        END IF;
        IF v_existing.disposition = 'accepted'
           AND v_parent.status = 'running'
           AND v_parent.manual_review_reason IS NULL THEN
            RETURN pg_catalog.jsonb_build_object(
                'disposition', 'accepted', 'created', FALSE, 'replayed', TRUE
            );
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'capacity_skipped', 'created', FALSE, 'replayed', TRUE
        );
    END IF;

    IF v_parent.status = 'running' AND v_parent.manual_review_reason IS NULL THEN
        SELECT pg_catalog.count(*)::INTEGER INTO v_reserved_count
          FROM public.analysis_revenue_resolver_capacity_reservations
         WHERE request_id = p_request_id
           AND disposition = 'accepted';
        IF v_reserved_count < v_limit THEN
            INSERT INTO public.analysis_revenue_resolver_capacity_reservations(
                request_id, operation_key_hash, job_key, job_input_hash,
                plan_id, capacity_limit, disposition
            ) VALUES (
                p_request_id, v_operation_hash, p_job_key, p_job_input_hash,
                v_parent.plan_id, v_limit, 'accepted'
            );
            RETURN pg_catalog.jsonb_build_object(
                'disposition', 'accepted', 'created', TRUE, 'replayed', FALSE
            );
        END IF;
    END IF;

    INSERT INTO public.analysis_revenue_resolver_capacity_reservations(
        request_id, operation_key_hash, job_key, job_input_hash,
        plan_id, capacity_limit, disposition
    ) VALUES (
        p_request_id, v_operation_hash, p_job_key, p_job_input_hash,
        v_parent.plan_id, v_limit, 'capacity_skipped'
    );
    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'capacity_skipped', 'created', TRUE, 'replayed', FALSE
    );
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_analysis_revenue_resolver_capacity_v1(
    UUID, TEXT, UUID, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_revenue_resolver_capacity_v1(
    UUID, TEXT, UUID, TEXT, TEXT
) TO service_role;

COMMENT ON TABLE public.analysis_revenue_resolver_capacity_reservations IS
    'Durable per-request Basic 20 / Standard 40 resolver admission, keyed by immutable resolver operation hash.';

-- Primary_join is the durable quality checkpoint. It records both the
-- pre-pass and post-pass union count, including a resolver-free <=30% cohort,
-- so finalization never needs to reread mutable profile-AI outcomes.
CREATE TABLE public.analysis_revenue_primary_quality_checkpoints (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
    job_key TEXT NOT NULL CHECK (job_key = 'coordinator:join:primary-evidence'),
    job_input_hash TEXT NOT NULL CHECK (job_input_hash ~ '^[a-f0-9]{64}$'),
    public_mutual_count INTEGER NOT NULL CHECK (public_mutual_count >= 0),
    screened_count INTEGER NOT NULL CHECK (screened_count >= 0),
    not_screened_count INTEGER NOT NULL CHECK (not_screened_count >= 0),
    initial_unknown_burden_count INTEGER NOT NULL CHECK (initial_unknown_burden_count >= 0),
    final_unknown_burden_count INTEGER NOT NULL CHECK (final_unknown_burden_count >= 0),
    resolver_pass_started BOOLEAN NOT NULL,
    disposition TEXT NOT NULL CHECK (disposition IN ('accepted', 'manual_review')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CHECK (screened_count + not_screened_count = public_mutual_count),
    CHECK (initial_unknown_burden_count <= screened_count),
    CHECK (final_unknown_burden_count <= screened_count),
    CHECK (public_mutual_count = 0 OR screened_count > 0),
    CHECK (
        resolver_pass_started = (initial_unknown_burden_count * 10 > screened_count * 3)
    )
);

ALTER TABLE public.analysis_revenue_primary_quality_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_primary_quality_checkpoints FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_primary_quality_checkpoints
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.analysis_revenue_primary_quality_checkpoints TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_revenue_primary_quality_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT,
    p_public_mutual_count INTEGER,
    p_screened_count INTEGER,
    p_not_screened_count INTEGER,
    p_initial_unknown_burden_count INTEGER,
    p_final_unknown_burden_count INTEGER,
    p_coverage_valid BOOLEAN,
    p_resolver_pass_started BOOLEAN
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_parent public.analysis_revenue_run_ledgers%ROWTYPE;
    v_existing public.analysis_revenue_primary_quality_checkpoints%ROWTYPE;
    v_pass public.analysis_revenue_resolver_passes%ROWTYPE;
    v_valid BOOLEAN;
BEGIN
    IF p_job_key IS DISTINCT FROM 'coordinator:join:primary-evidence'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_public_mutual_count IS NULL
       OR p_screened_count IS NULL
       OR p_not_screened_count IS NULL
       OR p_initial_unknown_burden_count IS NULL
       OR p_final_unknown_burden_count IS NULL
       OR p_resolver_pass_started IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash, TRUE
    );
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_parent FROM public.analysis_revenue_run_ledgers
     WHERE request_id = p_request_id FOR UPDATE;

    v_valid := p_coverage_valid IS TRUE
        AND p_public_mutual_count >= 0
        AND p_screened_count >= 0
        AND p_not_screened_count >= 0
        AND p_initial_unknown_burden_count BETWEEN 0 AND p_screened_count
        AND p_final_unknown_burden_count BETWEEN 0 AND p_screened_count
        AND p_screened_count + p_not_screened_count = p_public_mutual_count
        AND (p_public_mutual_count = 0 OR p_screened_count > 0)
        AND p_resolver_pass_started = (
            p_initial_unknown_burden_count * 10 > p_screened_count * 3
        )
        AND p_final_unknown_burden_count * 10 <= p_screened_count * 3;

    SELECT * INTO v_existing
    FROM public.analysis_revenue_primary_quality_checkpoints
    WHERE request_id = p_request_id FOR UPDATE;
    IF v_existing.request_id IS NOT NULL THEN
        IF v_existing.job_key IS DISTINCT FROM p_job_key
           OR v_existing.job_input_hash IS DISTINCT FROM p_job_input_hash
           OR v_existing.public_mutual_count IS DISTINCT FROM p_public_mutual_count
           OR v_existing.screened_count IS DISTINCT FROM p_screened_count
           OR v_existing.not_screened_count IS DISTINCT FROM p_not_screened_count
           OR v_existing.initial_unknown_burden_count
                IS DISTINCT FROM p_initial_unknown_burden_count
           OR v_existing.final_unknown_burden_count
                IS DISTINCT FROM p_final_unknown_burden_count
           OR v_existing.resolver_pass_started IS DISTINCT FROM p_resolver_pass_started THEN
            RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', v_existing.disposition,
            'created', FALSE,
            'replayed', TRUE
        );
    END IF;

    IF p_resolver_pass_started THEN
        SELECT * INTO v_pass FROM public.analysis_revenue_resolver_passes
        WHERE request_id = p_request_id FOR UPDATE;
        IF v_pass.request_id IS NULL THEN
            -- An incoherent profile cohort is never allowed to enter the
            -- resolver boundary merely to satisfy a ratio.  Persist its
            -- manual-review quality receipt directly; a valid cohort above
            -- the threshold still requires the immutable pass row below.
            IF p_coverage_valid IS TRUE THEN
                RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
            END IF;
        ELSE
            IF v_pass.job_key IS DISTINCT FROM p_job_key
               OR v_pass.job_input_hash IS DISTINCT FROM p_job_input_hash
               OR v_pass.screened_count IS DISTINCT FROM p_screened_count
               OR v_pass.unknown_burden_count
                    IS DISTINCT FROM p_initial_unknown_burden_count THEN
                RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
            END IF;
            IF v_pass.disposition = 'started' THEN
                UPDATE public.analysis_revenue_resolver_passes
                   SET final_unknown_burden_count = p_final_unknown_burden_count,
                       disposition = CASE WHEN v_valid THEN 'accepted' ELSE 'manual_review' END,
                       completed_at = pg_catalog.clock_timestamp()
                 WHERE request_id = p_request_id;
            ELSIF v_pass.final_unknown_burden_count
                      IS DISTINCT FROM p_final_unknown_burden_count
                  OR v_pass.disposition IS DISTINCT FROM (
                        CASE WHEN v_valid THEN 'accepted' ELSE 'manual_review' END
                  ) THEN
                RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
            END IF;
        END IF;
    ELSIF EXISTS (
        SELECT 1 FROM public.analysis_revenue_resolver_passes
        WHERE request_id = p_request_id
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
    END IF;

    INSERT INTO public.analysis_revenue_primary_quality_checkpoints(
        request_id, job_key, job_input_hash, public_mutual_count, screened_count,
        not_screened_count, initial_unknown_burden_count, final_unknown_burden_count,
        resolver_pass_started, disposition
    ) VALUES (
        p_request_id, p_job_key, p_job_input_hash, p_public_mutual_count,
        p_screened_count, p_not_screened_count, p_initial_unknown_burden_count,
        p_final_unknown_burden_count, p_resolver_pass_started,
        CASE WHEN v_valid AND v_parent.status = 'running'
                  AND v_parent.manual_review_reason IS NULL
            THEN 'accepted' ELSE 'manual_review' END
    );

    IF v_valid AND v_parent.status = 'running' AND v_parent.manual_review_reason IS NULL THEN
        UPDATE public.analysis_revenue_run_ledgers
           SET public_mutual_count = p_public_mutual_count,
               screened_count = p_screened_count,
               not_screened_count = p_not_screened_count,
               unknown_burden_count = p_final_unknown_burden_count
         WHERE request_id = p_request_id;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'accepted', 'created', TRUE, 'replayed', FALSE
        );
    END IF;

    UPDATE public.analysis_revenue_run_ledgers
       SET public_mutual_count = p_public_mutual_count,
           screened_count = p_screened_count,
           not_screened_count = p_not_screened_count,
           unknown_burden_count = p_final_unknown_burden_count,
           status = 'manual_review',
           manual_review_reason = CASE
               WHEN manual_review_reason IN (
                   'cost_overrun', 'cost_denied', 'ambiguous_external_call'
               ) THEN manual_review_reason
               ELSE 'routing_failure'
           END
     WHERE request_id = p_request_id;
    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'manual_review', 'created', TRUE, 'replayed', FALSE
    );
END;
$$;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_revenue_primary_quality_v1(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_revenue_primary_quality_v1(
    UUID, TEXT, UUID, TEXT, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, BOOLEAN, BOOLEAN
) TO service_role;

-- This overlay is intentionally narrower than a profile checkpoint: only an
-- opaque candidate id and audited resolver provenance are stored. The public
-- scoring feature values remain in the existing result row that finalization
-- already treats as its authority.
CREATE TABLE public.analysis_revenue_resolver_outcome_overlays (
    request_id UUID NOT NULL REFERENCES public.analysis_revenue_run_ledgers(request_id) ON DELETE CASCADE,
    candidate_id TEXT NOT NULL CHECK (candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
    job_key TEXT NOT NULL CHECK (job_key = 'coordinator:join:primary-evidence'),
    job_input_hash TEXT NOT NULL CHECK (job_input_hash ~ '^[a-f0-9]{64}$'),
    classification TEXT NOT NULL CHECK (classification IN ('verified_female', 'verified_non_female')),
    operation_key TEXT NOT NULL CHECK (operation_key ~ '^gender-resolution:[a-f0-9]{64}$'),
    result_hash TEXT NOT NULL CHECK (result_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, candidate_id),
    UNIQUE (request_id, operation_key)
);

ALTER TABLE public.analysis_revenue_resolver_outcome_overlays ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_revenue_resolver_outcome_overlays FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_revenue_resolver_outcome_overlays
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON TABLE public.analysis_revenue_resolver_outcome_overlays TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_revenue_resolver_outcomes_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_rows JSONB
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_pass public.analysis_revenue_resolver_passes%ROWTYPE;
BEGIN
    IF p_job_key IS DISTINCT FROM 'coordinator:join:primary-evidence'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_rows IS NULL
       OR pg_catalog.jsonb_typeof(p_rows) <> 'array'
       OR pg_catalog.jsonb_array_length(p_rows) > 40
       OR EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
            WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
               OR NOT (item.value ?& ARRAY[
                    'candidateId', 'classification', 'operationKey', 'resultHash'
               ])
               OR item.value - ARRAY[
                    'candidateId', 'classification', 'operationKey', 'resultHash'
               ] <> '{}'::JSONB
               OR item.value->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item.value->>'classification' NOT IN ('verified_female', 'verified_non_female')
               OR item.value->>'operationKey' !~ '^gender-resolution:[a-f0-9]{64}$'
               OR item.value->>'resultHash' !~ '^[a-f0-9]{64}$'
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
    ) <> (
        SELECT pg_catalog.count(DISTINCT item.value->>'candidateId')
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash, TRUE
    );
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_pass FROM public.analysis_revenue_resolver_passes
    WHERE request_id = p_request_id FOR UPDATE;
    IF v_pass.request_id IS NULL
       OR v_pass.job_key IS DISTINCT FROM p_job_key
       OR v_pass.job_input_hash IS DISTINCT FROM p_job_input_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        LEFT JOIN public.analysis_v2_candidate_feature_rows AS feature
          ON feature.request_id = p_request_id
         AND feature.candidate_id = item.value->>'candidateId'
        LEFT JOIN public.analysis_v2_ai_result_checkpoints AS ai_result
          ON ai_result.request_id = p_request_id
         AND ai_result.job_key = p_job_key
         AND ai_result.operation_key = item.value->>'operationKey'
         AND ai_result.stage = 'genderResolution'
         AND ai_result.result_hash = item.value->>'resultHash'
        LEFT JOIN public.analysis_revenue_resolver_capacity_reservations AS reservation
          ON reservation.request_id = p_request_id
         AND reservation.operation_key_hash = pg_catalog.encode(
                extensions.digest(
                    pg_catalog.convert_to(item.value->>'operationKey', 'UTF8'), 'sha256'
                ), 'hex'
            )
         AND reservation.disposition = 'accepted'
        WHERE feature.request_id IS NULL
           OR feature.baseline_classification NOT IN (
                'unresolved', 'unresolved_stage_conflict',
                'media_unavailable', 'analysis_unavailable'
           )
           OR ai_result.request_id IS NULL
           OR reservation.request_id IS NULL
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
        JOIN public.analysis_revenue_resolver_outcome_overlays AS existing
          ON existing.request_id = p_request_id
         AND existing.candidate_id = item.value->>'candidateId'
        WHERE existing.job_key IS DISTINCT FROM p_job_key
           OR existing.job_input_hash IS DISTINCT FROM p_job_input_hash
           OR existing.classification IS DISTINCT FROM item.value->>'classification'
           OR existing.operation_key IS DISTINCT FROM item.value->>'operationKey'
           OR existing.result_hash IS DISTINCT FROM item.value->>'resultHash'
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_DRIFT';
    END IF;

    INSERT INTO public.analysis_revenue_resolver_outcome_overlays(
        request_id, candidate_id, job_key, job_input_hash, classification, operation_key, result_hash
    )
    SELECT p_request_id, item.value->>'candidateId', p_job_key, p_job_input_hash,
        item.value->>'classification', item.value->>'operationKey', item.value->>'resultHash'
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
    ON CONFLICT (request_id, candidate_id) DO NOTHING;

    -- The overlay is deliberately the sole resolver authority.  When a
    -- baseline row already has a feature, its public result materialization
    -- is reconstructed server-side from the sealed profile-AI checkpoint;
    -- the caller never sends feature content through this revenue RPC.  Rows
    -- with no feature (the normal analysis/media-unavailable case) retain
    -- only the overlay: they count as resolved primary membership, while
    -- screening naturally excludes them because no detail feature exists.
    WITH resolver_rows AS (
        SELECT item.value AS item
        FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
    ), source_feature AS (
        SELECT resolver.item, source.outcome
        FROM resolver_rows AS resolver
        JOIN LATERAL (
            SELECT outcome.value AS outcome
            FROM public.analysis_v2_ai_scoring_stage_checkpoints AS checkpoint
            CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(
                checkpoint.payload->'outcomes'
            ) AS outcome(value)
            WHERE checkpoint.request_id = p_request_id
              AND checkpoint.stage_kind = 'profile_ai_batch'
              AND outcome.value->>'candidateId' = resolver.item->>'candidateId'
              AND pg_catalog.jsonb_typeof(outcome.value->'feature') = 'object'
              AND pg_catalog.jsonb_typeof(
                    outcome.value->'feature'->'features'
              ) = 'object'
            LIMIT 1
        ) AS source ON TRUE
        WHERE (source.outcome->'feature'->'features'->>'appearanceGrade') ~ '^[1-5]$'
          AND (source.outcome->'feature'->'features'->>'exposureScore') ~ '^[0-5]$'
          AND pg_catalog.jsonb_typeof(
                source.outcome->'feature'->'features'->'oneLineOverview'
              ) = 'string'
          AND pg_catalog.char_length(
                source.outcome->'feature'->'features'->>'oneLineOverview'
              ) BETWEEN 1 AND 180
    )
    UPDATE public.analysis_v2_candidate_feature_rows AS feature
       SET terminal_classification = source.item->>'classification',
           classification_source = 'gender_resolution',
           gender_resolution_status = 'ready_applied',
           gender_resolution_operation_key = source.item->>'operationKey',
           gender_resolution_result_hash = source.item->>'resultHash',
           appearance_grade = CASE WHEN source.item->>'classification' = 'verified_female'
                THEN (source.outcome->'feature'->'features'->>'appearanceGrade')::SMALLINT
                ELSE NULL END,
           exposure_score = CASE WHEN source.item->>'classification' = 'verified_female'
                THEN (source.outcome->'feature'->'features'->>'exposureScore')::SMALLINT
                ELSE NULL END,
           is_business_account = CASE WHEN source.item->>'classification' = 'verified_female'
                THEN COALESCE(
                    source.outcome->>'accountContextOverride',
                    source.outcome->'feature'->'features'->>'accountContext'
                ) IN ('individual_creator', 'official_group_or_brand')
                ELSE NULL END,
           feature_partner_evidence_strong = CASE
                WHEN source.item->>'classification' = 'verified_female' THEN (
                    source.outcome->'feature'->'features'->>'partnerExclusionContext' = 'none'
                    AND (
                        source.outcome->'feature'->'features'->>'marriageEvidence' = 'strong'
                        OR source.outcome->'feature'->'features'->>'partnerEvidence' = 'strong'
                    )
                )
                ELSE NULL
            END,
           one_line_overview = CASE WHEN source.item->>'classification' = 'verified_female'
                THEN source.outcome->'feature'->'features'->>'oneLineOverview' ELSE NULL END
     FROM source_feature AS source
     WHERE feature.request_id = p_request_id
       AND feature.candidate_id = source.item->>'candidateId'
       -- The reviewed feature-row invariant permits a resolver mutation only
       -- from the existing unresolved baselines.  Analysis/media-unavailable
       -- candidates are intentionally featureless and remain overlay-only;
       -- this guards a malformed historical rich payload from accidentally
       -- relaxing that invariant.
       AND feature.baseline_classification IN (
            'unresolved', 'unresolved_stage_conflict'
       );

    RETURN public.load_analysis_v2_revenue_resolver_outcomes_v1(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
END;
$$;

-- Permit primary_join to read its own opaque overlay while holding the same
-- live strict lineage fence; no public API can read these rows.
CREATE OR REPLACE FUNCTION public.load_analysis_v2_revenue_resolver_outcomes_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_job_key IS DISTINCT FROM 'coordinator:join:primary-evidence'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash, TRUE
    );
    RETURN pg_catalog.jsonb_build_object('rows', COALESCE((
        SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
            'candidateId', overlay.candidate_id,
            'classification', overlay.classification,
            'operationKey', overlay.operation_key,
            'resultHash', overlay.result_hash
        ) ORDER BY overlay.candidate_id)
        FROM public.analysis_revenue_resolver_outcome_overlays AS overlay
        WHERE overlay.request_id = p_request_id
          AND overlay.job_key = p_job_key
          AND overlay.job_input_hash = p_job_input_hash
    ), '[]'::JSONB));
END;
$$;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_revenue_resolver_outcomes_v1(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_revenue_resolver_outcomes_v1(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_revenue_resolver_outcomes_v1(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_revenue_resolver_outcomes_v1(
    UUID, TEXT, UUID, TEXT
) TO service_role;

-- The historical profile-batch validator remains intact; this forward-only
-- extension additionally recognizes an audited, capacity-admitted primary
-- resolver result. It never relaxes the baseline-mutation constraint.
CREATE OR REPLACE FUNCTION public.analysis_v2_validate_candidate_gender_resolution()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    v_profile_job_key TEXT;
BEGIN
    IF NEW.baseline_classification IS NULL THEN
        NEW.baseline_classification := NEW.terminal_classification;
    END IF;
    IF NEW.classification_source IS NULL THEN
        NEW.classification_source := CASE
            WHEN NEW.terminal_classification = 'verified_non_female'
                 AND NEW.feature_operation_key IS NULL THEN 'triage'
            WHEN NEW.terminal_classification IN ('verified_female', 'verified_non_female')
                THEN 'feature'
            WHEN NEW.terminal_classification IN ('unresolved', 'unresolved_stage_conflict')
                THEN 'unknown'
            ELSE 'unavailable'
        END;
    END IF;
    IF NEW.gender_resolution_status IS NULL THEN
        NEW.gender_resolution_status := 'disabled';
    END IF;
    IF NEW.gender_resolution_status IN (
        'ready_applied', 'ready_not_needed', 'ready_inconclusive'
    ) THEN
        SELECT manifest.producer_job_key INTO v_profile_job_key
        FROM public.analysis_v2_candidate_feature_manifests AS manifest
        WHERE manifest.request_id = NEW.request_id AND manifest.batch = NEW.batch;
        IF v_profile_job_key IS NULL OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_ai_result_checkpoints AS result
            WHERE result.request_id = NEW.request_id
              AND result.operation_key = NEW.gender_resolution_operation_key
              AND result.stage = 'genderResolution'
              AND result.cache_scope = 'request'
              AND result.result_hash = NEW.gender_resolution_result_hash
              AND (
                    result.job_key = v_profile_job_key
                    OR (
                        result.job_key = 'coordinator:join:primary-evidence'
                        AND EXISTS (
                            SELECT 1 FROM public.analysis_revenue_resolver_passes AS pass
                            WHERE pass.request_id = NEW.request_id
                              AND pass.job_key = result.job_key
                        )
                    )
              )
        ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_GENDER_RESOLUTION_RESULT_FENCE_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

-- Finalizer is a zero-model verifier. It replays the normal finalizer fence
-- against the immutable primary quality receipt and records the reviewed
-- finalizer coverage gate with the same aggregate values.
CREATE OR REPLACE FUNCTION public.verify_analysis_revenue_final_coverage_gate_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_job_claim_token UUID,
    p_job_input_hash TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_primary public.analysis_revenue_primary_quality_checkpoints%ROWTYPE;
BEGIN
    IF p_job_key IS DISTINCT FROM 'coordinator:finalize'
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'REVENUE_COST_OPERATION_FENCE';
    END IF;
    PERFORM public.analysis_revenue_ai_cost_assert_lineage_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash, TRUE
    );
    PERFORM public.analysis_revenue_ai_cost_assert_parent_v1(p_request_id);
    SELECT * INTO v_primary
    FROM public.analysis_revenue_primary_quality_checkpoints
    WHERE request_id = p_request_id FOR UPDATE;
    IF v_primary.request_id IS NULL THEN
        UPDATE public.analysis_revenue_run_ledgers
           SET status = 'manual_review',
               manual_review_reason = CASE
                   WHEN manual_review_reason IN (
                       'cost_overrun', 'cost_denied', 'ambiguous_external_call'
                   ) THEN manual_review_reason
                   ELSE 'routing_failure'
               END
         WHERE request_id = p_request_id;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'manual_review', 'created', TRUE, 'replayed', FALSE
        );
    END IF;
    RETURN public.record_analysis_revenue_coverage_gate_v1(
        p_request_id, p_job_key, p_job_claim_token, p_job_input_hash,
        v_primary.public_mutual_count, v_primary.screened_count,
        v_primary.not_screened_count, v_primary.final_unknown_burden_count,
        v_primary.disposition = 'accepted'
    );
END;
$$;
REVOKE ALL ON FUNCTION public.verify_analysis_revenue_final_coverage_gate_v1(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.verify_analysis_revenue_final_coverage_gate_v1(
    UUID, TEXT, UUID, TEXT
) TO service_role;

COMMENT ON TABLE public.analysis_revenue_primary_quality_checkpoints IS
    'Immutable strict primary-join unknown-burden receipt; finalizer verifies it without model work.';
COMMENT ON TABLE public.analysis_revenue_resolver_outcome_overlays IS
    'Opaque primary-join resolver provenance overlay; candidate features are materialized in the existing result rows.';
