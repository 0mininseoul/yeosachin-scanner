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
                                                'id', 'type', 'caption', 'imageUrl', 'thumbnailUrl', 'videoUrl'
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
                                       OR (
                                            media.value ? 'caption'
                                            AND (
                                                pg_catalog.jsonb_typeof(media.value->'caption') <> 'string'
                                                OR pg_catalog.char_length(media.value->>'caption') > 2200
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
