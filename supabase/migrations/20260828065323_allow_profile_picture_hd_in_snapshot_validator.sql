-- Apify's profile dataset items include profilePicUrlHD alongside profilePicUrl. The
-- TypeScript checkpoint schema already accepts and persists this optional bounded URL, but
-- the SQL snapshot validator's strict key allowlist rejected it as an unknown key, raising
-- ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID for every paid profile checkpoint write. Extend the
-- existing hidden-engagement wrapper in place: strip a validated profilePicUrlHD before
-- delegating to the base validator, so the allowlist never sees it.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_snapshot(p_profile JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT NOT EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(
            CASE
                WHEN pg_catalog.jsonb_typeof(p_profile->'latestPosts') = 'array'
                    THEN p_profile->'latestPosts'
                ELSE '[]'::JSONB
            END
        ) AS post(value)
        WHERE (
                post.value ? 'likesCountHidden'
                AND (
                    pg_catalog.jsonb_typeof(post.value->'likesCountHidden') <> 'boolean'
                    OR post.value->>'likesCountHidden' <> 'true'
                )
            )
           OR (
                post.value ? 'commentsCountHidden'
                AND (
                    pg_catalog.jsonb_typeof(post.value->'commentsCountHidden') <> 'boolean'
                    OR post.value->>'commentsCountHidden' <> 'true'
                )
            )
    )
    AND (
        NOT p_profile ? 'profilePicUrlHD'
        OR (
            pg_catalog.jsonb_typeof(p_profile->'profilePicUrlHD') = 'string'
            AND pg_catalog.char_length(p_profile->>'profilePicUrlHD') BETWEEN 1 AND 8192
            AND p_profile->>'profilePicUrlHD' ~ '^https?://[^[:space:]]+$'
        )
    )
    AND public.analysis_v2_valid_profile_snapshot_without_hidden_counts(
        (
            CASE
                WHEN pg_catalog.jsonb_typeof(p_profile->'latestPosts') = 'array' THEN
                    (p_profile - 'latestPosts')
                    || pg_catalog.jsonb_build_object(
                        'latestPosts',
                        COALESCE((
                            SELECT pg_catalog.jsonb_agg(
                                post.value - 'likesCountHidden' - 'commentsCountHidden'
                                ORDER BY post.ordinality
                            )
                            FROM pg_catalog.jsonb_array_elements(p_profile->'latestPosts')
                                WITH ORDINALITY AS post(value, ordinality)
                        ), '[]'::JSONB)
                    )
                ELSE p_profile
            END
        ) - 'profilePicUrlHD'
    );
$$;

-- CREATE OR REPLACE preserves the function OID, so the existing analysis_v2_profile_fetch_outcomes
-- CHECK constraint keeps resolving to this definition without being dropped and recreated.
REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB) IS
    'Validates bounded V2 profile snapshots, including true-only hidden engagement markers and an optional bounded profilePicUrlHD.';
