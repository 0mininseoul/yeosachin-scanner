-- Persist aggregate V2 gender classifications before terminal staging is purged.
-- Existing finalized rows are backfilled from a coherent legacy request snapshot, with
-- finalized female rows plus an unknown remainder as the conservative fallback.

ALTER TABLE public.analysis_v2_result_summaries
    ADD COLUMN male_count SMALLINT,
    ADD COLUMN female_count SMALLINT,
    ADD COLUMN unknown_count SMALLINT;

WITH normalized AS (
    SELECT
        summary.request_id,
        summary.screened_mutuals,
        CASE
            WHEN pg_catalog.jsonb_typeof(analysis_request.gender_stats->'male') = 'number'
             AND analysis_request.gender_stats->>'male' ~ '^[0-9]+$'
            THEN (analysis_request.gender_stats->>'male')::NUMERIC
            ELSE NULL
        END AS legacy_male,
        CASE
            WHEN pg_catalog.jsonb_typeof(analysis_request.gender_stats->'female') = 'number'
             AND analysis_request.gender_stats->>'female' ~ '^[0-9]+$'
            THEN (analysis_request.gender_stats->>'female')::NUMERIC
            ELSE NULL
        END AS legacy_female,
        CASE
            WHEN pg_catalog.jsonb_typeof(analysis_request.gender_stats->'unknown') = 'number'
             AND analysis_request.gender_stats->>'unknown' ~ '^[0-9]+$'
            THEN (analysis_request.gender_stats->>'unknown')::NUMERIC
            ELSE NULL
        END AS legacy_unknown,
        female_rows.row_count AS female_row_count
    FROM public.analysis_v2_result_summaries AS summary
    JOIN public.analysis_requests AS analysis_request
      ON analysis_request.id = summary.request_id
    CROSS JOIN LATERAL (
        SELECT pg_catalog.count(*)::INTEGER AS row_count
        FROM public.analysis_v2_female_results AS female
        WHERE female.request_id = summary.request_id
    ) AS female_rows
),
backfill AS (
    SELECT
        normalized.request_id,
        CASE
            WHEN normalized.legacy_male BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_female BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_unknown BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_male
                    + normalized.legacy_female
                    + normalized.legacy_unknown = normalized.screened_mutuals
            THEN normalized.legacy_male::SMALLINT
            ELSE 0::SMALLINT
        END AS male_count,
        CASE
            WHEN normalized.legacy_male BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_female BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_unknown BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_male
                    + normalized.legacy_female
                    + normalized.legacy_unknown = normalized.screened_mutuals
            THEN normalized.legacy_female::SMALLINT
            ELSE LEAST(
                normalized.female_row_count,
                normalized.screened_mutuals::INTEGER
            )::SMALLINT
        END AS female_count,
        CASE
            WHEN normalized.legacy_male BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_female BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_unknown BETWEEN 0 AND normalized.screened_mutuals
             AND normalized.legacy_male
                    + normalized.legacy_female
                    + normalized.legacy_unknown = normalized.screened_mutuals
            THEN normalized.legacy_unknown::SMALLINT
            ELSE (
                normalized.screened_mutuals
                - LEAST(
                    normalized.female_row_count,
                    normalized.screened_mutuals::INTEGER
                )
            )::SMALLINT
        END AS unknown_count
    FROM normalized
)
UPDATE public.analysis_v2_result_summaries AS summary
SET male_count = backfill.male_count,
    female_count = backfill.female_count,
    unknown_count = backfill.unknown_count
FROM backfill
WHERE backfill.request_id = summary.request_id;

ALTER TABLE public.analysis_v2_result_summaries
    ALTER COLUMN male_count SET NOT NULL,
    ALTER COLUMN female_count SET NOT NULL,
    ALTER COLUMN unknown_count SET NOT NULL,
    ADD CONSTRAINT analysis_v2_result_summaries_gender_counts_check CHECK (
        male_count >= 0
        AND female_count >= 0
        AND unknown_count >= 0
        AND male_count + female_count + unknown_count = screened_mutuals
    );

CREATE OR REPLACE FUNCTION public.analysis_v2_populate_result_gender_stats()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_male_count INTEGER;
    v_female_count INTEGER;
    v_unknown_count INTEGER;
BEGIN
    SELECT
        pg_catalog.count(*) FILTER (
            WHERE feature.terminal_classification = 'verified_non_female'
        )::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE feature.terminal_classification = 'verified_female'
        )::INTEGER,
        pg_catalog.count(*) FILTER (
            WHERE feature.terminal_classification NOT IN (
                'verified_female',
                'verified_non_female'
            )
        )::INTEGER
    INTO v_male_count, v_female_count, v_unknown_count
    FROM public.analysis_v2_candidate_feature_rows AS feature
    WHERE feature.request_id = NEW.request_id;

    IF v_male_count + v_female_count + v_unknown_count <> NEW.screened_mutuals THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    NEW.male_count := v_male_count::SMALLINT;
    NEW.female_count := v_female_count::SMALLINT;
    NEW.unknown_count := v_unknown_count::SMALLINT;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_populate_result_gender_stats()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER populate_analysis_v2_result_gender_stats
BEFORE INSERT ON public.analysis_v2_result_summaries
FOR EACH ROW
EXECUTE FUNCTION public.analysis_v2_populate_result_gender_stats();

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

COMMENT ON COLUMN public.analysis_v2_result_summaries.male_count IS
    'Screened public mutuals terminally classified as verified non-female.';
COMMENT ON COLUMN public.analysis_v2_result_summaries.female_count IS
    'Screened public mutuals terminally classified as verified female.';
COMMENT ON COLUMN public.analysis_v2_result_summaries.unknown_count IS
    'Screened public mutuals with every other terminal classification.';
