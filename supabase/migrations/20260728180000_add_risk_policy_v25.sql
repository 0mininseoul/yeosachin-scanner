-- Risk-policy v2.5: evidence-aware two/three-person high-risk floors.
-- Forward-only: immutable v2.3/v2.4 requests retain their exact dispatch paths.

ALTER TABLE public.analysis_v2_candidate_score_manifests
    DROP CONSTRAINT IF EXISTS analysis_v2_candidate_score_manifests_risk_policy_version_check;
ALTER TABLE public.analysis_v2_candidate_score_manifests
    ADD CONSTRAINT analysis_v2_candidate_score_manifests_risk_policy_version_check
    CHECK (risk_policy_version IN (
        'risk-policy-v2.2', 'risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5'
    ));

ALTER TABLE public.analysis_v2_result_summaries
    DROP CONSTRAINT IF EXISTS analysis_v2_result_summaries_score_policy_version_check;
ALTER TABLE public.analysis_v2_result_summaries
    ADD CONSTRAINT analysis_v2_result_summaries_score_policy_version_check
    CHECK (score_policy_version IN (
        'risk-policy-v2.2', 'risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5'
    ));

CREATE OR REPLACE FUNCTION public.analysis_v2_expected_relative_risk_rows_v25(
    p_rows JSONB,
    p_strong_partner_candidate_ids TEXT[]
)
RETURNS TABLE (
    candidate_id TEXT,
    display_score NUMERIC,
    risk_band TEXT,
    relative_tier_applied BOOLEAN
)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
WITH source_rows AS (
    SELECT
        item.value->>'candidateId' AS candidate_id,
        (item.value->>'publicScore')::NUMERIC AS public_score,
        COALESCE(item.value->>'accountContext', 'personal') = 'official_group_or_brand'
            AS official_group_or_brand,
        COALESCE((item.value->'components'->>'candidateToTargetLikes')::NUMERIC, 0) > 0
            OR COALESCE(
                (item.value->'components'->>'candidateToTargetComments')::NUMERIC, 0
            ) > 0
            OR COALESCE(
                (item.value->'components'->>'candidateToTargetTagOrCaptionMention')::NUMERIC,
                0
            ) > 0 AS inbound,
        (item.value->>'candidateId') = ANY(
            COALESCE(p_strong_partner_candidate_ids, ARRAY[]::TEXT[])
        ) AS strong_partner
    FROM pg_catalog.jsonb_array_elements(p_rows) AS item(value)
),
natural_rows AS (
    SELECT source.*,
        pg_catalog.round(source.public_score, 1) AS natural_display_score,
        CASE
            WHEN source.public_score < 4.2 THEN 'normal'
            WHEN source.public_score < 6.8 THEN 'caution'
            ELSE 'high_risk'
        END AS natural_risk_band
    FROM source_rows AS source
),
eligible_rows AS (
    SELECT natural_row.*,
        pg_catalog.count(*) OVER ()::INTEGER AS eligible_count,
        pg_catalog.count(*) FILTER (WHERE natural_row.inbound) OVER ()::INTEGER
            AS inbound_count,
        pg_catalog.count(*) FILTER (
            WHERE natural_row.natural_risk_band = 'high_risk'
        ) OVER ()::INTEGER AS natural_high_count,
        pg_catalog.count(*) FILTER (
            WHERE natural_row.natural_risk_band <> 'normal'
        ) OVER ()::INTEGER AS natural_non_normal_count
    FROM natural_rows AS natural_row
    WHERE NOT natural_row.strong_partner
      AND NOT natural_row.official_group_or_brand
),
high_pool AS (
    SELECT eligible.*,
        pg_catalog.row_number() OVER (
            ORDER BY eligible.public_score DESC, eligible.candidate_id
        )::INTEGER AS high_pool_rank
    FROM eligible_rows AS eligible
    WHERE eligible.inbound_count = 0 OR eligible.inbound
),
high_pool_facts AS (
    SELECT pool.*,
        pg_catalog.count(*) OVER ()::INTEGER AS high_pool_count,
        pg_catalog.max(pool.public_score) FILTER (
            WHERE pool.high_pool_rank = 3
        ) OVER () AS third_high_pool_score
    FROM high_pool AS pool
),
eligible_counts AS (
    SELECT eligible.*,
        COALESCE(pg_catalog.max(pool.high_pool_count), 0)::INTEGER AS high_pool_count,
        pg_catalog.max(pool.third_high_pool_score) AS third_high_pool_score
    FROM eligible_rows AS eligible
    LEFT JOIN high_pool_facts AS pool ON TRUE
    GROUP BY eligible.candidate_id, eligible.public_score,
        eligible.official_group_or_brand, eligible.inbound, eligible.strong_partner,
        eligible.eligible_count, eligible.inbound_count,
        eligible.natural_high_count, eligible.natural_non_normal_count,
        eligible.natural_display_score, eligible.natural_risk_band
),
requested_counts AS (
    SELECT counted.*,
        CASE WHEN counted.eligible_count < 3 THEN 0 ELSE LEAST(
            3,
            counted.eligible_count - 2,
            counted.high_pool_count,
            GREATEST(
                1,
                LEAST(3, counted.eligible_count - 2, counted.natural_high_count),
                CASE
                    WHEN counted.eligible_count >= 5
                     AND counted.high_pool_count >= 3
                     AND counted.third_high_pool_score >= 4.2 THEN 3
                    WHEN counted.eligible_count >= 4 THEN 2
                    ELSE 1
                END
            )
        ) END::INTEGER AS requested_high_count
    FROM eligible_counts AS counted
),
high_selected AS (
    SELECT counted.*,
        COALESCE(pool.high_pool_rank <= counted.requested_high_count, FALSE)
            AS selected_high
    FROM requested_counts AS counted
    LEFT JOIN high_pool_facts AS pool
      ON pool.candidate_id = counted.candidate_id
),
selected_counts AS (
    SELECT selected.*,
        pg_catalog.count(*) FILTER (WHERE selected.selected_high) OVER ()::INTEGER
            AS actual_high_count
    FROM high_selected AS selected
),
remaining_rows AS (
    SELECT selected.*,
        pg_catalog.row_number() OVER (
            ORDER BY selected.public_score DESC, selected.candidate_id
        )::INTEGER AS remaining_rank,
        pg_catalog.count(*) OVER ()::INTEGER AS remaining_count
    FROM selected_counts AS selected
    WHERE NOT selected.selected_high
),
eligible_tiers AS (
    SELECT selected.*,
        CASE
            WHEN selected.eligible_count < 3 THEN selected.natural_risk_band
            WHEN selected.selected_high THEN 'high_risk'
            WHEN remaining.remaining_rank <= LEAST(
                10, remaining.remaining_count,
                GREATEST(2, selected.natural_non_normal_count - selected.actual_high_count)
            ) THEN 'caution'
            ELSE 'normal'
        END AS expected_risk_band
    FROM selected_counts AS selected
    LEFT JOIN remaining_rows AS remaining
      ON remaining.candidate_id = selected.candidate_id
),
expected_eligible AS (
    SELECT tiered.candidate_id,
        CASE tiered.expected_risk_band
            WHEN 'high_risk' THEN
                LEAST(10.0, GREATEST(6.8, tiered.natural_display_score))
            WHEN 'caution' THEN
                LEAST(6.7, GREATEST(4.2, tiered.natural_display_score))
            ELSE LEAST(4.1, GREATEST(1.0, tiered.natural_display_score))
        END::NUMERIC AS display_score,
        tiered.expected_risk_band AS risk_band,
        tiered.eligible_count >= 3 AS relative_tier_applied
    FROM eligible_tiers AS tiered
),
expected_excluded AS (
    SELECT natural_row.candidate_id,
        CASE WHEN natural_row.official_group_or_brand
            THEN LEAST(4.1, GREATEST(1.0, natural_row.natural_display_score))
            ELSE natural_row.natural_display_score
        END::NUMERIC AS display_score,
        CASE WHEN natural_row.official_group_or_brand THEN 'normal'
            ELSE natural_row.natural_risk_band END AS risk_band,
        FALSE AS relative_tier_applied
    FROM natural_rows AS natural_row
    WHERE natural_row.strong_partner OR natural_row.official_group_or_brand
)
SELECT * FROM expected_eligible
UNION ALL
SELECT * FROM expected_excluded
ORDER BY candidate_id;
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_expected_relative_risk_rows(
    p_rows JSONB,
    p_strong_partner_candidate_ids TEXT[],
    p_risk_policy_version TEXT
)
RETURNS TABLE (
    candidate_id TEXT,
    display_score NUMERIC,
    risk_band TEXT,
    relative_tier_applied BOOLEAN
)
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT * FROM public.analysis_v2_expected_relative_risk_rows_v23(
        p_rows, p_strong_partner_candidate_ids
    ) WHERE p_risk_policy_version = 'risk-policy-v2.3'
    UNION ALL
    SELECT * FROM public.analysis_v2_expected_relative_risk_rows(
        p_rows, p_strong_partner_candidate_ids
    ) WHERE p_risk_policy_version = 'risk-policy-v2.4'
    UNION ALL
    SELECT * FROM public.analysis_v2_expected_relative_risk_rows_v25(
        p_rows, p_strong_partner_candidate_ids
    ) WHERE p_risk_policy_version = 'risk-policy-v2.5'
    ORDER BY candidate_id;
$$;

-- The preliminary checkpoint shape and component math are identical for v2.4/v2.5.
DO $migration$
DECLARE v_definition TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_preliminary_scores_v24(uuid,text,uuid,text,jsonb,text)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(
        v_definition,
        $guard$p_risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'$guard$
    ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RISK_POLICY_V25_PRELIMINARY_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.replace(
        v_definition,
        $guard$p_risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'$guard$,
        $guard$p_risk_policy_version NOT IN ('risk-policy-v2.4', 'risk-policy-v2.5')$guard$
    );
    EXECUTE v_definition;
END;
$migration$;

-- Patch only the version gates in the audited candidate checkpoint. Its v2.4
-- row shape and component math remain shared; relative-tier dispatch is above.
DO $migration$
DECLARE v_definition TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_candidate_scores(uuid,text,uuid,text,jsonb,text)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF pg_catalog.strpos(
        v_definition,
        $guard$p_risk_policy_version NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4')$guard$
    ) = 0
       OR pg_catalog.strpos(
            v_definition,
            $shape$p_risk_policy_version = 'risk-policy-v2.4'$shape$
       ) = 0 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RISK_POLICY_V25_FINAL_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    v_definition := pg_catalog.replace(
        v_definition,
        $guard$p_risk_policy_version NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4')$guard$,
        $guard$p_risk_policy_version NOT IN ('risk-policy-v2.3', 'risk-policy-v2.4', 'risk-policy-v2.5')$guard$
    );
    v_definition := pg_catalog.replace(
        v_definition,
        $shape$p_risk_policy_version = 'risk-policy-v2.4'$shape$,
        $shape$p_risk_policy_version IN ('risk-policy-v2.4', 'risk-policy-v2.5')$shape$
    );
    EXECUTE v_definition;
END;
$migration$;

-- Scheduler claims use exact immutable snapshots. Add the v2.5 twins without
-- weakening the pipeline, AI-stage, or scheduler portions of the fence.
DO $migration$
DECLARE
    v_definition TEXT;
    v_ai_stage TEXT;
    v_old TEXT;
    v_new TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.claim_analysis_v2_scheduler_operation(uuid,text,uuid,text,text,uuid,integer)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    FOREACH v_ai_stage IN ARRAY ARRAY[
        'ai-stage-policy-v2.8', 'ai-stage-policy-v2.9', 'ai-stage-policy-v2.10'
    ] LOOP
        v_old := pg_catalog.format(
            $old$v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', '%s', 'scheduler', 'ai-scheduler-v1')$old$,
            v_ai_stage
        );
        IF pg_catalog.strpos(v_definition, v_old) = 0 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_RISK_POLICY_V25_SCHEDULER_CLAIM_DRIFT',
                ERRCODE = 'P0001';
        END IF;
        v_new := pg_catalog.format(
            $new$(v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', '%1$s', 'scheduler', 'ai-scheduler-v1') OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', '%1$s', 'scheduler', 'ai-scheduler-v1'))$new$,
            v_ai_stage
        );
        v_definition := pg_catalog.replace(v_definition, v_old, v_new);
    END LOOP;
    EXECUTE v_definition;
END;
$migration$;

-- The scheduler-specific Gemini admission RPC is the second live claim fence.
-- Preserve its lease semantics while admitting the exact v2.8-v2.10 snapshot
-- families for both immutable risk versions.
DO $migration$
DECLARE
    v_definition TEXT;
    v_pattern TEXT := $pattern$v_request\.policy_versions_snapshot\s*<>\s*pg_catalog\.jsonb_build_object\(\s*'pipeline'\s*,\s*'v2'\s*,\s*'risk'\s*,\s*'risk-policy-v2\.4'\s*,\s*'aiStage'\s*,\s*'ai-stage-policy-v2\.8'\s*,\s*'scheduler'\s*,\s*'ai-scheduler-v1'\s*\)$pattern$;
    v_new TEXT;
BEGIN
    SELECT pg_catalog.pg_get_functiondef(
        'public.acquire_analysis_v2_scheduler_gemini_lease_v1(uuid,text,text,text,integer,uuid,integer)'
            ::pg_catalog.regprocedure
    ) INTO v_definition;
    IF v_definition !~ v_pattern THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RISK_POLICY_V25_GEMINI_CLAIM_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    v_new := $new$NOT (
            v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.8', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.9', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.4', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.8', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.9', 'scheduler', 'ai-scheduler-v1')
            OR v_request.policy_versions_snapshot = pg_catalog.jsonb_build_object('pipeline', 'v2', 'risk', 'risk-policy-v2.5', 'aiStage', 'ai-stage-policy-v2.10', 'scheduler', 'ai-scheduler-v1')
       )$new$;
    v_definition := pg_catalog.regexp_replace(v_definition, v_pattern, v_new);
    EXECUTE v_definition;
END;
$migration$;

-- Score component math is unchanged; keep a separately named versioned mirror
-- so audits never infer semantic equivalence from an unversioned helper.
CREATE OR REPLACE FUNCTION public.analysis_v2_score_audit_expected_v25_components(
    p_signals JSONB,
    p_account_context TEXT
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT public.analysis_v2_score_audit_expected_v24_components(
        p_signals, p_account_context
    );
$$;

-- Extend the audit capture/materialization gates while requiring all recorded
-- versions to agree. No v2.4 source, run, or summary is rewritten.
DO $migration$
DECLARE
    v_definition TEXT;
    v_function REGPROCEDURE;
BEGIN
    v_function := 'public.analysis_v2_score_audit_valid_candidate(jsonb)'::REGPROCEDURE;
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    v_definition := pg_catalog.replace(
        v_definition,
        $old$p_value->'risk'->>'policyVersion' = 'risk-policy-v2.4'$old$,
        $new$p_value->'risk'->>'policyVersion' IN ('risk-policy-v2.4', 'risk-policy-v2.5')$new$
    );
    EXECUTE v_definition;

    v_function := 'public.refresh_analysis_v2_score_audit_scan_locator(uuid)'::REGPROCEDURE;
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    v_definition := pg_catalog.replace(
        v_definition,
        $old$v_summary.score_policy_version = 'risk-policy-v2.4'$old$,
        $new$v_summary.score_policy_version IN ('risk-policy-v2.4', 'risk-policy-v2.5')$new$
    );
    EXECUTE v_definition;

    v_function :=
        'public.prepare_analysis_v2_score_audit_source(uuid,text,integer)'::REGPROCEDURE;
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    v_definition := pg_catalog.replace(
        v_definition,
        $old$SELECT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_source.source_payload->'candidates') AS item(value)
        WHERE public.analysis_v2_score_audit_valid_candidate(item.value)
                IS DISTINCT FROM TRUE$old$,
        $new$SELECT (
        v_source.source_payload->>'riskPolicyVersion'
            IS DISTINCT FROM v_source.risk_policy_version
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(v_source.source_payload->'candidates') AS item(value)
        WHERE public.analysis_v2_score_audit_valid_candidate(item.value)
                IS DISTINCT FROM TRUE
           OR item.value->'risk'->>'policyVersion'
                IS DISTINCT FROM v_source.risk_policy_version$new$
    );
    EXECUTE v_definition;

    v_function := 'public.capture_analysis_v2_score_audit_source(uuid)'::REGPROCEDURE;
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    v_definition := pg_catalog.replace(
        v_definition,
        $old$v_policy IS DISTINCT FROM 'risk-policy-v2.4'
       OR v_stage.payload->>'riskPolicyVersion'
            IS DISTINCT FROM 'risk-policy-v2.4'$old$,
        $new$v_policy NOT IN ('risk-policy-v2.4', 'risk-policy-v2.5')
       OR v_stage.payload->>'riskPolicyVersion' IS DISTINCT FROM v_policy$new$
    );
    v_definition := pg_catalog.replace(
        v_definition,
        $old$'riskPolicyVersion', 'risk-policy-v2.4'$old$,
        $new$'riskPolicyVersion', v_policy$new$
    );
    EXECUTE v_definition;

    v_function := 'public.claim_analysis_v2_score_audit(uuid)'::REGPROCEDURE;
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    v_definition := pg_catalog.replace(
        v_definition,
        $old$v_summary.score_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       OR (
            v_source.request_id IS NOT NULL
            AND v_source.risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       )$old$,
        $new$v_summary.score_policy_version NOT IN ('risk-policy-v2.4', 'risk-policy-v2.5')
       OR (
            v_source.request_id IS NOT NULL
            AND v_source.risk_policy_version IS DISTINCT FROM v_summary.score_policy_version
       )$new$
    );
    EXECUTE v_definition;

    v_function := 'public.materialize_analysis_v2_score_audit(uuid,uuid)'::REGPROCEDURE;
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    v_definition := pg_catalog.replace(
        v_definition,
        $old$v_run.risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       OR v_source.risk_policy_version IS DISTINCT FROM 'risk-policy-v2.4'
       OR v_summary.score_policy_version IS DISTINCT FROM 'risk-policy-v2.4'$old$,
        $new$v_run.risk_policy_version NOT IN ('risk-policy-v2.4', 'risk-policy-v2.5')
       OR v_source.risk_policy_version IS DISTINCT FROM v_run.risk_policy_version
       OR v_summary.score_policy_version IS DISTINCT FROM v_run.risk_policy_version$new$
    );
    v_definition := pg_catalog.replace(
        v_definition,
        $old$COALESCE(source_json.strong_ids, ARRAY[]::TEXT[]),
            'risk-policy-v2.4'$old$,
        $new$COALESCE(source_json.strong_ids, ARRAY[]::TEXT[]),
            v_run.risk_policy_version$new$
    );
    EXECUTE v_definition;

    v_function :=
        'public.purge_expired_analysis_v2_score_audit_evidence(integer)'::REGPROCEDURE;
    SELECT pg_catalog.pg_get_functiondef(v_function) INTO v_definition;
    v_definition := pg_catalog.replace(
        v_definition,
        $old$SELECT intent.request_id, intent.source_result_hash,
               intent.source_generation
        FROM public.analysis_v2_score_audit_intents AS intent$old$,
        $new$SELECT intent.request_id, intent.source_result_hash,
               intent.source_generation,
               request.policy_versions_snapshot->>'risk' AS risk_policy_version
        FROM public.analysis_v2_score_audit_intents AS intent
        JOIN public.analysis_requests AS request ON request.id = intent.request_id$new$
    );
    v_definition := pg_catalog.replace(
        v_definition,
        $old$expired.source_generation, 'risk-policy-v2.4',
               'partial'$old$,
        $new$expired.source_generation, expired.risk_policy_version,
               'partial'$new$
    );
    EXECUTE v_definition;
END;
$migration$;

-- The finalizer remains generic, but name its preserved transactional delegate
-- in this migration contract so review catches accidental bypasses.
COMMENT ON FUNCTION public.analysis_v2_complete_result_and_purge_before_v28_tone(
    UUID, TEXT, UUID, TEXT, TEXT
) IS 'Transactional result finalization delegate; accepts the version fenced by candidate manifests, including risk-policy-v2.5.';

REVOKE ALL ON FUNCTION public.analysis_v2_expected_relative_risk_rows_v25(JSONB, TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_score_audit_expected_v25_components(JSONB, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_expected_relative_risk_rows(JSONB, TEXT[], TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_preliminary_scores_v24(
    UUID, TEXT, UUID, TEXT, JSONB, TEXT
) TO service_role;
