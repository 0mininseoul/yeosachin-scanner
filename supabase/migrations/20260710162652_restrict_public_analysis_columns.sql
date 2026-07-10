-- Keep pipeline state, evidence-bearing JSON, and unsanitized narratives behind service_role.
REVOKE SELECT ON TABLE analysis_requests FROM anon, authenticated;

GRANT SELECT (
    id,
    user_id,
    target_instagram_id,
    status,
    progress,
    progress_step,
    error_message,
    created_at,
    completed_at,
    plan_type,
    background_processing
) ON TABLE analysis_requests TO authenticated;

REVOKE SELECT (risk_analysis) ON TABLE analysis_results FROM anon, authenticated;

COMMENT ON COLUMN analysis_requests.step_data IS
    'Server-internal pipeline state; may contain evidence-bearing account and provider data.';
