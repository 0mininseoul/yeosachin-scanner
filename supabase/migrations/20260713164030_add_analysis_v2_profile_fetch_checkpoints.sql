-- Phase D: durable, exact per-username profile outcomes and unresolved-only fallback.
-- Provider run identity and billing state remain in analysis_provider_runs; this staging
-- stores only bounded canonical profile evidence and provider outcome telemetry.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_username_list(
    p_usernames TEXT[],
    p_allow_empty BOOLEAN DEFAULT FALSE
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_usernames IS NOT NULL
       AND pg_catalog.cardinality(p_usernames) BETWEEN
            CASE WHEN p_allow_empty THEN 0 ELSE 1 END AND 30
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(p_usernames) AS username(value)
            WHERE username.value IS NULL
               OR pg_catalog.char_length(username.value) NOT BETWEEN 1 AND 30
               OR username.value !~ '^[a-z0-9._]+$'
       )
       AND pg_catalog.cardinality(p_usernames) = (
            SELECT pg_catalog.count(DISTINCT username.value)::INTEGER
            FROM pg_catalog.unnest(p_usernames) AS username(value)
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_username_list(TEXT[], BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_snapshot(p_profile JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_typeof(p_profile) = 'object'
       AND p_profile ?& ARRAY[
            'username', 'followersCount', 'followingCount', 'postsCount',
            'isPrivate', 'isVerified'
       ]
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_object_keys(p_profile) AS profile_key(value)
            WHERE profile_key.value <> ALL(ARRAY[
                'username', 'fullName', 'bio', 'externalUrl', 'profilePicUrl',
                'followersCount', 'followingCount', 'postsCount', 'isPrivate',
                'isVerified', 'latestPosts'
            ])
       )
       AND pg_catalog.jsonb_typeof(p_profile->'username') = 'string'
       AND p_profile->>'username' ~ '^[a-z0-9._]{1,30}$'
       AND (
            NOT p_profile ? 'fullName'
            OR (
                pg_catalog.jsonb_typeof(p_profile->'fullName') = 'string'
                AND pg_catalog.char_length(p_profile->>'fullName') <= 150
            )
       )
       AND (
            NOT p_profile ? 'bio'
            OR (
                pg_catalog.jsonb_typeof(p_profile->'bio') = 'string'
                AND pg_catalog.char_length(p_profile->>'bio') <= 2200
            )
       )
       AND (
            NOT p_profile ? 'externalUrl'
            OR (
                pg_catalog.jsonb_typeof(p_profile->'externalUrl') = 'string'
                AND pg_catalog.char_length(p_profile->>'externalUrl') BETWEEN 1 AND 8192
                AND p_profile->>'externalUrl' ~ '^https?://[^[:space:]]+$'
            )
       )
       AND (
            NOT p_profile ? 'profilePicUrl'
            OR (
                pg_catalog.jsonb_typeof(p_profile->'profilePicUrl') = 'string'
                AND pg_catalog.char_length(p_profile->>'profilePicUrl') BETWEEN 1 AND 8192
                AND p_profile->>'profilePicUrl' ~ '^https?://[^[:space:]]+$'
            )
       )
       AND pg_catalog.jsonb_typeof(p_profile->'followersCount') = 'number'
       AND p_profile->>'followersCount' ~ '^(0|[1-9][0-9]{0,9})$'
       AND (p_profile->>'followersCount')::NUMERIC <= 2000000000
       AND pg_catalog.jsonb_typeof(p_profile->'followingCount') = 'number'
       AND p_profile->>'followingCount' ~ '^(0|[1-9][0-9]{0,9})$'
       AND (p_profile->>'followingCount')::NUMERIC <= 2000000000
       AND pg_catalog.jsonb_typeof(p_profile->'postsCount') = 'number'
       AND p_profile->>'postsCount' ~ '^(0|[1-9][0-9]{0,9})$'
       AND (p_profile->>'postsCount')::NUMERIC <= 2000000000
       AND pg_catalog.jsonb_typeof(p_profile->'isPrivate') = 'boolean'
       AND pg_catalog.jsonb_typeof(p_profile->'isVerified') = 'boolean'
       AND (
            NOT p_profile ? 'latestPosts'
            OR (
                pg_catalog.jsonb_typeof(p_profile->'latestPosts') = 'array'
                AND pg_catalog.jsonb_array_length(p_profile->'latestPosts') <= 8
                AND NOT EXISTS (
                    SELECT 1
                    FROM pg_catalog.jsonb_array_elements(p_profile->'latestPosts') AS post(value)
                    WHERE pg_catalog.jsonb_typeof(post.value) <> 'object'
                       OR NOT post.value ?& ARRAY[
                            'id', 'shortCode', 'type', 'likesCount', 'commentsCount',
                            'timestamp', 'taggedUsers', 'mentionedUsers'
                       ]
                       OR EXISTS (
                            SELECT 1
                            FROM pg_catalog.jsonb_object_keys(post.value) AS post_key(value)
                            WHERE post_key.value <> ALL(ARRAY[
                                'id', 'shortCode', 'caption', 'hashtags', 'imageUrl',
                                'thumbnailUrl', 'videoUrl', 'type', 'mediaItems',
                                'declaredMediaCount', 'childrenComplete', 'likesCount',
                                'commentsCount', 'timestamp', 'taggedUsers', 'mentionedUsers'
                            ])
                       )
                       OR pg_catalog.jsonb_typeof(post.value->'id') <> 'string'
                       OR pg_catalog.char_length(post.value->>'id') NOT BETWEEN 1 AND 255
                       OR pg_catalog.jsonb_typeof(post.value->'shortCode') <> 'string'
                       OR pg_catalog.char_length(post.value->>'shortCode') NOT BETWEEN 1 AND 100
                       OR pg_catalog.jsonb_typeof(post.value->'type') <> 'string'
                       OR post.value->>'type' NOT IN ('image', 'video', 'carousel', 'reel')
                       OR pg_catalog.jsonb_typeof(post.value->'likesCount') <> 'number'
                       OR post.value->>'likesCount' !~ '^(0|[1-9][0-9]{0,9})$'
                       OR (post.value->>'likesCount')::NUMERIC > 2000000000
                       OR pg_catalog.jsonb_typeof(post.value->'commentsCount') <> 'number'
                       OR post.value->>'commentsCount' !~ '^(0|[1-9][0-9]{0,9})$'
                       OR (post.value->>'commentsCount')::NUMERIC > 2000000000
                       OR pg_catalog.jsonb_typeof(post.value->'timestamp') <> 'string'
                       OR pg_catalog.char_length(post.value->>'timestamp') > 64
                       OR (
                            post.value ? 'caption'
                            AND (
                                pg_catalog.jsonb_typeof(post.value->'caption') <> 'string'
                                OR pg_catalog.char_length(post.value->>'caption') > 2200
                            )
                       )
                       OR (
                            post.value ? 'hashtags'
                            AND (
                                pg_catalog.jsonb_typeof(post.value->'hashtags') <> 'array'
                                OR pg_catalog.jsonb_array_length(post.value->'hashtags') > 30
                                OR EXISTS (
                                    SELECT 1
                                    FROM pg_catalog.jsonb_array_elements(post.value->'hashtags') AS hashtag(value)
                                    WHERE pg_catalog.jsonb_typeof(hashtag.value) <> 'string'
                                       OR pg_catalog.char_length(hashtag.value #>> '{}') NOT BETWEEN 1 AND 100
                                )
                            )
                       )
                       OR EXISTS (
                            SELECT 1
                            FROM pg_catalog.unnest(ARRAY['imageUrl', 'thumbnailUrl', 'videoUrl']) AS media_key(value)
                            WHERE post.value ? media_key.value
                              AND (
                                pg_catalog.jsonb_typeof(post.value->media_key.value) <> 'string'
                                OR pg_catalog.char_length(post.value->>media_key.value) NOT BETWEEN 1 AND 8192
                                OR post.value->>media_key.value !~ '^https?://[^[:space:]]+$'
                              )
                       )
                       OR pg_catalog.jsonb_typeof(post.value->'taggedUsers') <> 'array'
                       OR pg_catalog.jsonb_array_length(post.value->'taggedUsers') > 50
                       OR EXISTS (
                            SELECT 1
                            FROM pg_catalog.jsonb_array_elements(post.value->'taggedUsers') AS username(value)
                            WHERE pg_catalog.jsonb_typeof(username.value) <> 'string'
                               OR username.value #>> '{}' !~ '^[a-z0-9._]{1,30}$'
                       )
                       OR pg_catalog.jsonb_typeof(post.value->'mentionedUsers') <> 'array'
                       OR pg_catalog.jsonb_array_length(post.value->'mentionedUsers') > 50
                       OR EXISTS (
                            SELECT 1
                            FROM pg_catalog.jsonb_array_elements(post.value->'mentionedUsers') AS username(value)
                            WHERE pg_catalog.jsonb_typeof(username.value) <> 'string'
                               OR username.value #>> '{}' !~ '^[a-z0-9._]{1,30}$'
                       )
                       OR (
                            post.value->>'type' <> 'carousel'
                            AND (
                                post.value ? 'mediaItems'
                                OR post.value ? 'declaredMediaCount'
                                OR post.value ? 'childrenComplete'
                            )
                       )
                       OR (
                            post.value ? 'declaredMediaCount'
                            AND (
                                pg_catalog.jsonb_typeof(post.value->'declaredMediaCount') <> 'number'
                                OR post.value->>'declaredMediaCount' !~ '^([1-9]|1[0-9]|20)$'
                            )
                       )
                       OR (
                            post.value ? 'childrenComplete'
                            AND pg_catalog.jsonb_typeof(post.value->'childrenComplete') <> 'boolean'
                       )
                       OR (
                            post.value ? 'mediaItems'
                            AND (
                                pg_catalog.jsonb_typeof(post.value->'mediaItems') <> 'array'
                                OR pg_catalog.jsonb_array_length(post.value->'mediaItems') > 20
                                OR EXISTS (
                                    SELECT 1
                                    FROM pg_catalog.jsonb_array_elements(post.value->'mediaItems') AS media(value)
                                    WHERE pg_catalog.jsonb_typeof(media.value) <> 'object'
                                       OR NOT media.value ? 'type'
                                       OR EXISTS (
                                            SELECT 1
                                            FROM pg_catalog.jsonb_object_keys(media.value) AS media_item_key(value)
                                            WHERE media_item_key.value <> ALL(ARRAY[
                                                'id', 'type', 'imageUrl', 'thumbnailUrl', 'videoUrl'
                                            ])
                                       )
                                       OR media.value->>'type' NOT IN ('image', 'video', 'reel')
                                       OR (
                                            media.value ? 'id'
                                            AND (
                                                pg_catalog.jsonb_typeof(media.value->'id') <> 'string'
                                                OR pg_catalog.char_length(media.value->>'id') NOT BETWEEN 1 AND 255
                                            )
                                       )
                                       OR NOT (
                                            media.value ? 'imageUrl'
                                            OR media.value ? 'thumbnailUrl'
                                            OR media.value ? 'videoUrl'
                                       )
                                       OR EXISTS (
                                            SELECT 1
                                            FROM pg_catalog.unnest(ARRAY['imageUrl', 'thumbnailUrl', 'videoUrl']) AS media_url_key(value)
                                            WHERE media.value ? media_url_key.value
                                              AND (
                                                pg_catalog.jsonb_typeof(media.value->media_url_key.value) <> 'string'
                                                OR pg_catalog.char_length(media.value->>media_url_key.value) NOT BETWEEN 1 AND 8192
                                                OR media.value->>media_url_key.value !~ '^https?://[^[:space:]]+$'
                                              )
                                       )
                                )
                            )
                       )
                       OR (
                            post.value->>'childrenComplete' = 'true'
                            AND (
                                NOT post.value ? 'declaredMediaCount'
                                OR NOT post.value ? 'mediaItems'
                                OR (post.value->>'declaredMediaCount')::INTEGER
                                    <> pg_catalog.jsonb_array_length(post.value->'mediaItems')
                            )
                       )
                )
            )
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_snapshot(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_profile_outcomes(
    p_outcomes JSONB,
    p_expected_usernames TEXT[],
    p_attempt TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT p_attempt IN ('primary', 'fallback')
       AND public.analysis_v2_valid_profile_username_list(p_expected_usernames, FALSE)
       AND pg_catalog.jsonb_typeof(p_outcomes) = 'array'
       AND pg_catalog.jsonb_array_length(p_outcomes) = pg_catalog.cardinality(p_expected_usernames)
       AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(p_outcomes)
                WITH ORDINALITY AS outcome(value, ordinal)
            WHERE pg_catalog.jsonb_typeof(outcome.value) <> 'object'
               OR NOT outcome.value ?& ARRAY[
                    'username', 'source', 'status', 'failure_category', 'http_status',
                    'request_count', 'latency_ms', 'captured_at', 'profile'
               ]
               OR EXISTS (
                    SELECT 1
                    FROM pg_catalog.jsonb_object_keys(outcome.value) AS outcome_key(value)
                    WHERE outcome_key.value <> ALL(ARRAY[
                        'username', 'source', 'status', 'failure_category', 'http_status',
                        'request_count', 'latency_ms', 'captured_at', 'profile'
                    ])
               )
               OR pg_catalog.jsonb_typeof(outcome.value->'username') <> 'string'
               OR outcome.value->>'username' <> p_expected_usernames[outcome.ordinal::INTEGER]
               OR (
                    p_attempt = 'primary'
                    AND outcome.value->>'source' NOT IN ('cache', 'selfhosted')
               )
               OR (
                    p_attempt = 'fallback'
                    AND outcome.value->>'source' <> 'apify'
               )
               OR outcome.value->>'status' NOT IN ('success', 'unavailable', 'failed')
               OR pg_catalog.jsonb_typeof(outcome.value->'request_count') <> 'number'
               OR outcome.value->>'request_count' !~ '^([0-9]|10)$'
               OR pg_catalog.jsonb_typeof(outcome.value->'latency_ms') <> 'number'
               OR outcome.value->>'latency_ms' !~ '^(0|[1-9][0-9]{0,5})$'
               OR (outcome.value->>'latency_ms')::INTEGER > 300000
               OR pg_catalog.jsonb_typeof(outcome.value->'captured_at') <> 'string'
               OR outcome.value->>'captured_at' !~
                    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
               OR (
                    outcome.value->>'status' = 'success'
                    AND (
                        outcome.value->'failure_category' <> 'null'::JSONB
                        OR outcome.value->'http_status' <> 'null'::JSONB
                        OR NOT public.analysis_v2_valid_profile_snapshot(outcome.value->'profile')
                        OR outcome.value->'profile'->>'username' <> outcome.value->>'username'
                    )
               )
               OR (
                    outcome.value->>'status' = 'unavailable'
                    AND (
                        outcome.value->>'failure_category' NOT IN ('not_found', 'empty_user')
                        OR NOT (
                            outcome.value->'http_status' = 'null'::JSONB
                            OR (
                                pg_catalog.jsonb_typeof(outcome.value->'http_status') = 'number'
                                AND outcome.value->>'http_status' = '404'
                            )
                        )
                        OR outcome.value->'profile' <> 'null'::JSONB
                    )
               )
               OR (
                    outcome.value->>'status' = 'failed'
                    AND (
                        outcome.value->>'failure_category' NOT IN (
                            'auth', 'rate_limit', 'timeout', 'incomplete', 'schema',
                            'transport', 'http', 'unknown'
                        )
                        OR NOT (
                            outcome.value->'http_status' = 'null'::JSONB
                            OR (
                                pg_catalog.jsonb_typeof(outcome.value->'http_status') = 'number'
                                AND outcome.value->>'http_status' ~ '^[45][0-9]{2}$'
                            )
                        )
                        OR outcome.value->'profile' <> 'null'::JSONB
                    )
               )
       );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_profile_outcomes(JSONB, TEXT[], TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_v2_profile_fetch_batches (
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    requested_usernames TEXT[] NOT NULL,
    frozen_unresolved_usernames TEXT[] NOT NULL,
    primary_payload_hash VARCHAR(64) NOT NULL,
    fallback_payload_hash VARCHAR(64),
    primary_completed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    fallback_completed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, job_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_profile_batches_requested_check CHECK (
        public.analysis_v2_valid_profile_username_list(requested_usernames, FALSE)
    ),
    CONSTRAINT analysis_v2_profile_batches_unresolved_check CHECK (
        public.analysis_v2_valid_profile_username_list(
            frozen_unresolved_usernames,
            TRUE
        )
        AND frozen_unresolved_usernames <@ requested_usernames
    ),
    CONSTRAINT analysis_v2_profile_batches_hash_check CHECK (
        primary_payload_hash ~ '^[a-f0-9]{64}$'
        AND (
            fallback_payload_hash IS NULL
            OR fallback_payload_hash ~ '^[a-f0-9]{64}$'
        )
    ),
    CONSTRAINT analysis_v2_profile_batches_fallback_pair_check CHECK (
        (fallback_payload_hash IS NULL AND fallback_completed_at IS NULL)
        OR (fallback_payload_hash IS NOT NULL AND fallback_completed_at IS NOT NULL)
    ),
    CONSTRAINT analysis_v2_profile_batches_timestamp_check CHECK (
        primary_completed_at >= created_at
        AND updated_at >= created_at
        AND (
            fallback_completed_at IS NULL
            OR fallback_completed_at >= primary_completed_at
        )
    )
);

CREATE TABLE public.analysis_v2_profile_fetch_outcomes (
    request_id UUID NOT NULL,
    job_key VARCHAR(160) NOT NULL,
    attempt VARCHAR(16) NOT NULL,
    ordinal SMALLINT NOT NULL,
    username VARCHAR(30) NOT NULL,
    source VARCHAR(16) NOT NULL,
    status VARCHAR(16) NOT NULL,
    failure_category VARCHAR(32),
    http_status SMALLINT,
    request_count SMALLINT NOT NULL,
    latency_ms INTEGER NOT NULL,
    captured_at TIMESTAMP WITH TIME ZONE NOT NULL,
    profile_snapshot JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (request_id, job_key, attempt, username),
    UNIQUE (request_id, job_key, attempt, ordinal),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_v2_profile_fetch_batches(request_id, job_key)
        ON DELETE CASCADE,
    CONSTRAINT analysis_v2_profile_outcomes_attempt_check CHECK (
        attempt IN ('primary', 'fallback')
    ),
    CONSTRAINT analysis_v2_profile_outcomes_ordinal_check CHECK (
        ordinal BETWEEN 1 AND 30
    ),
    CONSTRAINT analysis_v2_profile_outcomes_username_check CHECK (
        username ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_v2_profile_outcomes_source_check CHECK (
        (attempt = 'primary' AND source IN ('cache', 'selfhosted'))
        OR (attempt = 'fallback' AND source = 'apify')
    ),
    CONSTRAINT analysis_v2_profile_outcomes_status_check CHECK (
        status IN ('success', 'unavailable', 'failed')
    ),
    CONSTRAINT analysis_v2_profile_outcomes_result_check CHECK (
        (
            status = 'success'
            AND failure_category IS NULL
            AND http_status IS NULL
            AND profile_snapshot IS NOT NULL
            AND public.analysis_v2_valid_profile_snapshot(profile_snapshot)
            AND profile_snapshot->>'username' = username
        )
        OR (
            status = 'unavailable'
            AND failure_category IN ('not_found', 'empty_user')
            AND (http_status IS NULL OR http_status = 404)
            AND profile_snapshot IS NULL
        )
        OR (
            status = 'failed'
            AND failure_category IN (
                'auth', 'rate_limit', 'timeout', 'incomplete', 'schema',
                'transport', 'http', 'unknown'
            )
            AND (http_status IS NULL OR http_status BETWEEN 400 AND 599)
            AND profile_snapshot IS NULL
        )
    ),
    CONSTRAINT analysis_v2_profile_outcomes_request_count_check CHECK (
        request_count BETWEEN 0 AND 10
    ),
    CONSTRAINT analysis_v2_profile_outcomes_latency_check CHECK (
        latency_ms BETWEEN 0 AND 300000
    )
);

CREATE INDEX idx_analysis_v2_profile_outcomes_request_attempt
    ON public.analysis_v2_profile_fetch_outcomes(
        request_id,
        job_key,
        attempt,
        ordinal
    );

ALTER TABLE public.analysis_v2_profile_fetch_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_fetch_batches FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_fetch_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_profile_fetch_outcomes FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_v2_profile_fetch_batches
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_v2_profile_fetch_outcomes
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_profile_fetch_batches IS
    'RPC-only V2 staging that freezes one exact unresolved profile username set per profile job.';
COMMENT ON TABLE public.analysis_v2_profile_fetch_outcomes IS
    'Bounded canonical profile snapshots and one terminal outcome per username/provider attempt; no raw provider payload or provider credential/run identity.';

CREATE OR REPLACE FUNCTION public.analysis_v2_profile_checkpoint_snapshot(
    p_request_id UUID,
    p_job_key TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', batch.request_id,
        'jobKey', batch.job_key,
        'requestedUsernames', pg_catalog.to_jsonb(batch.requested_usernames),
        'frozenUnresolvedUsernames',
            pg_catalog.to_jsonb(batch.frozen_unresolved_usernames),
        'primaryResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'primary'
        ), '[]'::JSONB),
        'fallbackResults', COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'outcome', pg_catalog.jsonb_build_object(
                        'requestedUsername', outcome.username,
                        'source', outcome.source,
                        'status', outcome.status,
                        'failureCategory', outcome.failure_category,
                        'httpStatus', outcome.http_status,
                        'requestCount', outcome.request_count,
                        'latencyMs', outcome.latency_ms,
                        'capturedAt', outcome.captured_at
                    )
                ) || CASE
                    WHEN outcome.status = 'success' THEN
                        pg_catalog.jsonb_build_object('profile', outcome.profile_snapshot)
                    ELSE '{}'::JSONB
                END
                ORDER BY outcome.ordinal
            )
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = batch.request_id
              AND outcome.job_key = batch.job_key
              AND outcome.attempt = 'fallback'
        ), '[]'::JSONB),
        'primaryCapturedAt', batch.primary_completed_at,
        'fallbackCapturedAt', batch.fallback_completed_at
    )
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_checkpoint_snapshot(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_primary(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_requested_usernames TEXT[],
    p_outcomes JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_batch public.analysis_v2_profile_fetch_batches%ROWTYPE;
    v_unresolved TEXT[];
    v_payload_hash TEXT;
    v_completed_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR NOT public.analysis_v2_valid_profile_username_list(
            p_requested_usernames,
            FALSE
       )
       OR NOT public.analysis_v2_valid_profile_outcomes(
            p_outcomes,
            p_requested_usernames,
            'primary'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Match the terminal-capable V2 lock order even though this function does not terminalize.
    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND OR v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_now := pg_catalog.clock_timestamp();
    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_payload_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.jsonb_build_object(
                'requested_usernames', pg_catalog.to_jsonb(p_requested_usernames),
                'outcomes', p_outcomes
            )::TEXT,
            'sha256'
        ),
        'hex'
    );

    SELECT batch.*
    INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key
    FOR UPDATE;
    v_now := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF FOUND THEN
        IF v_batch.requested_usernames IS DISTINCT FROM p_requested_usernames
           OR v_batch.primary_payload_hash <> v_payload_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_PRIMARY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
    END IF;

    SELECT COALESCE(
        pg_catalog.array_agg(outcome.value->>'username' ORDER BY outcome.ordinal),
        '{}'::TEXT[]
    )
    INTO v_unresolved
    FROM pg_catalog.jsonb_array_elements(p_outcomes)
        WITH ORDINALITY AS outcome(value, ordinal)
    WHERE outcome.value->>'status' <> 'success';

    v_completed_at := clock_timestamp();
    INSERT INTO public.analysis_v2_profile_fetch_batches (
        request_id,
        job_key,
        requested_usernames,
        frozen_unresolved_usernames,
        primary_payload_hash,
        primary_completed_at,
        created_at,
        updated_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_requested_usernames,
        v_unresolved,
        v_payload_hash,
        v_completed_at,
        v_completed_at,
        v_completed_at
    );

    INSERT INTO public.analysis_v2_profile_fetch_outcomes (
        request_id,
        job_key,
        attempt,
        ordinal,
        username,
        source,
        status,
        failure_category,
        http_status,
        request_count,
        latency_ms,
        captured_at,
        profile_snapshot
    )
    SELECT
        p_request_id,
        p_job_key,
        'primary',
        outcome.ordinal::SMALLINT,
        outcome.value->>'username',
        outcome.value->>'source',
        outcome.value->>'status',
        NULLIF(outcome.value->>'failure_category', ''),
        CASE
            WHEN outcome.value->'http_status' = 'null'::JSONB THEN NULL
            ELSE (outcome.value->>'http_status')::SMALLINT
        END,
        (outcome.value->>'request_count')::SMALLINT,
        (outcome.value->>'latency_ms')::INTEGER,
        (outcome.value->>'captured_at')::TIMESTAMP WITH TIME ZONE,
        CASE
            WHEN outcome.value->'profile' = 'null'::JSONB THEN NULL
            ELSE outcome.value->'profile'
        END
    FROM pg_catalog.jsonb_array_elements(p_outcomes)
        WITH ORDINALITY AS outcome(value, ordinal)
    ORDER BY outcome.ordinal;

    RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_primary(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_profile_primary(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_fallback(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_outcomes JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_batch public.analysis_v2_profile_fetch_batches%ROWTYPE;
    v_payload_hash TEXT;
    v_completed_at TIMESTAMP WITH TIME ZONE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_outcomes) <> 'array' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    IF NOT FOUND OR v_request.pipeline_version IS DISTINCT FROM 'v2' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    v_completed_at := pg_catalog.clock_timestamp();
    IF v_request.status NOT IN ('pending', 'processing')
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_completed_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT batch.*
    INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key
    FOR UPDATE;
    v_completed_at := pg_catalog.clock_timestamp();
    IF v_job.lease_expires_at <= v_completed_at THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    IF NOT FOUND
       OR pg_catalog.cardinality(v_batch.frozen_unresolved_usernames) = 0
       OR NOT public.analysis_v2_valid_profile_outcomes(
            p_outcomes,
            v_batch.frozen_unresolved_usernames,
            'fallback'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    v_payload_hash := pg_catalog.encode(
        extensions.digest(p_outcomes::TEXT, 'sha256'),
        'hex'
    );
    IF v_batch.fallback_completed_at IS NOT NULL THEN
        IF v_batch.fallback_payload_hash <> v_payload_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_FALLBACK_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
    END IF;

    INSERT INTO public.analysis_v2_profile_fetch_outcomes (
        request_id,
        job_key,
        attempt,
        ordinal,
        username,
        source,
        status,
        failure_category,
        http_status,
        request_count,
        latency_ms,
        captured_at,
        profile_snapshot
    )
    SELECT
        p_request_id,
        p_job_key,
        'fallback',
        outcome.ordinal::SMALLINT,
        outcome.value->>'username',
        outcome.value->>'source',
        outcome.value->>'status',
        NULLIF(outcome.value->>'failure_category', ''),
        CASE
            WHEN outcome.value->'http_status' = 'null'::JSONB THEN NULL
            ELSE (outcome.value->>'http_status')::SMALLINT
        END,
        (outcome.value->>'request_count')::SMALLINT,
        (outcome.value->>'latency_ms')::INTEGER,
        (outcome.value->>'captured_at')::TIMESTAMP WITH TIME ZONE,
        CASE
            WHEN outcome.value->'profile' = 'null'::JSONB THEN NULL
            ELSE outcome.value->'profile'
        END
    FROM pg_catalog.jsonb_array_elements(p_outcomes)
        WITH ORDINALITY AS outcome(value, ordinal)
    ORDER BY outcome.ordinal;

    v_completed_at := clock_timestamp();
    UPDATE public.analysis_v2_profile_fetch_batches AS batch
    SET fallback_payload_hash = v_payload_hash,
        fallback_completed_at = v_completed_at,
        updated_at = v_completed_at
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key;

    RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_fallback(
    UUID, TEXT, UUID, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_profile_fallback(
    UUID, TEXT, UUID, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_fetch_checkpoint(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    PERFORM 1
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;

    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;

    v_now := pg_catalog.clock_timestamp();
    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_job.request_id IS NULL
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_fetch_checkpoint(
    UUID, TEXT, UUID, TEXT
)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_fetch_checkpoint(
    UUID, TEXT, UUID, TEXT
)
    TO service_role;

CREATE OR REPLACE FUNCTION public.purge_analysis_v2_profile_fetch_checkpoints(
    p_request_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    IF p_request_id IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = p_request_id
          AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.status IN ('completed', 'failed')
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    DELETE FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_analysis_v2_profile_fetch_checkpoints(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.purge_analysis_v2_profile_fetch_checkpoints(UUID)
    TO service_role;

COMMENT ON FUNCTION public.checkpoint_analysis_v2_profile_primary(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB
) IS 'Atomically persists one complete primary outcome set and freezes its exact ordered unresolved usernames; exact replay is idempotent and conflicting replay fails closed.';
COMMENT ON FUNCTION public.checkpoint_analysis_v2_profile_fallback(
    UUID, TEXT, UUID, TEXT, JSONB
) IS 'Atomically persists exactly one Apify outcome for every username in the frozen unresolved set without storing provider run identity or credentials.';
COMMENT ON FUNCTION public.load_analysis_v2_profile_fetch_checkpoint(
    UUID, TEXT, UUID, TEXT
) IS
    'Loads the strict bounded resume snapshot for one V2 profile job.';
COMMENT ON FUNCTION public.purge_analysis_v2_profile_fetch_checkpoints(UUID) IS
    'Standalone terminal staging purge. The transactional Phase G finalizer must call this after its canonical preflight/request/job lock order or delete the same request rows inline.';
