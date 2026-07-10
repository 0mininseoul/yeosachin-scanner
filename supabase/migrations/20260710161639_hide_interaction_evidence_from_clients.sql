-- Interaction counts and component scores stay server-internal. End users receive the final
-- rank/grade plus a bounded narrative for high-risk rows through the application API.
REVOKE SELECT ON TABLE analysis_results FROM anon, authenticated;

-- Legacy detail tables are no longer part of the product result contract. Their owner-scoped RLS
-- remains as defense in depth, while Data API clients lose direct access to raw interaction rows.
REVOKE ALL ON TABLE comment_details FROM anon, authenticated;
REVOKE ALL ON TABLE interaction_logs FROM anon, authenticated;

GRANT SELECT (
    request_id,
    rank,
    suspect_instagram_id,
    suspect_profile_image,
    suspect_full_name,
    bio,
    risk_grade,
    risk_analysis
) ON TABLE analysis_results TO authenticated;

COMMENT ON COLUMN analysis_results.risk_analysis IS
    'Public high-risk narrative; raw interaction counts and component scores remain server-only.';
