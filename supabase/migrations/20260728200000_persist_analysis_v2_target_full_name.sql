-- Persist the target display name in the immutable V2 result summary before
-- terminal preflight PII scrubbing. Existing historical summaries deliberately
-- remain NULL because their source name has already been scrubbed.

ALTER TABLE public.analysis_v2_result_summaries
    ADD COLUMN target_full_name VARCHAR(200);

CREATE OR REPLACE FUNCTION public.analysis_v2_populate_result_target_full_name()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_target_full_name TEXT;
BEGIN
    SELECT NULLIF(pg_catalog.btrim(preflight.target_full_name), '')
    INTO v_target_full_name
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = NEW.request_id;

    NEW.target_full_name := v_target_full_name;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_populate_result_target_full_name()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER populate_analysis_v2_result_target_full_name
BEFORE INSERT ON public.analysis_v2_result_summaries
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_populate_result_target_full_name();

CREATE OR REPLACE FUNCTION public.analysis_v2_result_summary_json(
    p_summary public.analysis_v2_result_summaries
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'targetInstagramId', p_summary.target_instagram_id,
        'targetFullName', p_summary.target_full_name,
        'targetProfileImageUrl', p_summary.target_profile_image_url,
        'planId', p_summary.plan_id,
        'followers', pg_catalog.jsonb_build_object(
            'declared', p_summary.followers_declared,
            'collected', p_summary.followers_collected,
            'coverageRatio', CASE WHEN p_summary.followers_declared = 0 THEN 1
                ELSE p_summary.followers_collected::DOUBLE PRECISION
                    / p_summary.followers_declared::DOUBLE PRECISION END,
            'meetsCoverageGate', p_summary.followers_declared = 0
                OR p_summary.followers_collected * 100 >= p_summary.followers_declared * 99,
            'exactCountMatch', p_summary.followers_collected = p_summary.followers_declared
        ),
        'following', pg_catalog.jsonb_build_object(
            'declared', p_summary.following_declared,
            'collected', p_summary.following_collected,
            'coverageRatio', CASE WHEN p_summary.following_declared = 0 THEN 1
                ELSE p_summary.following_collected::DOUBLE PRECISION
                    / p_summary.following_declared::DOUBLE PRECISION END,
            'meetsCoverageGate', p_summary.following_declared = 0
                OR p_summary.following_collected * 100 >= p_summary.following_declared * 99,
            'exactCountMatch', p_summary.following_collected = p_summary.following_declared
        ),
        'detectedMutuals', p_summary.detected_mutuals,
        'publicMutuals', p_summary.public_mutuals,
        'privateMutuals', p_summary.private_mutuals,
        'screenedMutuals', p_summary.screened_mutuals,
        'genderStats', pg_catalog.jsonb_build_object(
            'male', p_summary.male_count,
            'female', p_summary.female_count,
            'unknown', p_summary.unknown_count
        ),
        'successfullyScreenedMutuals', p_summary.screened_mutuals
            - p_summary.fetch_unavailable_count - p_summary.media_unavailable_count
            - p_summary.analysis_unavailable_count,
        'fetchUnavailableMutuals', p_summary.fetch_unavailable_count,
        'mediaUnavailableMutuals', p_summary.media_unavailable_count,
        'analysisUnavailableMutuals', p_summary.analysis_unavailable_count,
        'notScreenedMutuals', p_summary.not_screened_mutuals,
        'exclusionApplied', p_summary.exclusion_applied,
        'scorePolicyVersion', p_summary.score_policy_version
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_result_summary_json(
    public.analysis_v2_result_summaries
) FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON COLUMN public.analysis_v2_result_summaries.target_full_name IS
    'Target Instagram display name captured at V2 finalization; NULL for historical or absent names.';
