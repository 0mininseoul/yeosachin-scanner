ALTER TABLE public.analysis_v2_candidate_score_manifests
    DROP CONSTRAINT IF EXISTS analysis_v2_candidate_score_manifests_risk_policy_version_check;

ALTER TABLE public.analysis_v2_candidate_score_manifests
    ADD CONSTRAINT
        analysis_v2_candidate_score_manifests_risk_policy_version_check
    CHECK (
        risk_policy_version IN ('risk-policy-v2.2', 'risk-policy-v2.3')
    );

ALTER TABLE public.analysis_v2_result_summaries
    DROP CONSTRAINT IF EXISTS analysis_v2_result_summaries_score_policy_version_check;

ALTER TABLE public.analysis_v2_result_summaries
    ADD CONSTRAINT
        analysis_v2_result_summaries_score_policy_version_check
    CHECK (
        score_policy_version IN ('risk-policy-v2.2', 'risk-policy-v2.3')
    );
