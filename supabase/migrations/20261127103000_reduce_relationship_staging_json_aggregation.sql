BEGIN;
SET LOCAL lock_timeout = '5s';
DO $guard$
DECLARE
    v_body_hash text;
BEGIN
    SELECT md5(prosrc) INTO STRICT v_body_hash FROM pg_proc
    WHERE oid = 'public.load_analysis_v2_relationship_staging(uuid,text)'::regprocedure;
    IF v_body_hash NOT IN ('49950faf19bf83282cc5a422702d6964', '2ae784476f9ee92c95895c63a98eccf5') THEN
        RAISE EXCEPTION 'Unexpected relationship staging reader definition';
    END IF;
END;
$guard$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_relationship_staging(p_request_id uuid, p_job_key text) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $_$
DECLARE
    v_manifest public.analysis_v2_relationship_manifests%ROWTYPE;
    v_followers public.analysis_v2_relationship_sides%ROWTYPE;
    v_following public.analysis_v2_relationship_sides%ROWTYPE;
    v_mutual_rows jsonb;
    v_detailed_names jsonb;
    v_private_names jsonb;
    v_private_rows jsonb;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_requests AS analysis_request
            WHERE analysis_request.id = p_request_id
              AND analysis_request.pipeline_version = 'v2'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_EVIDENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT relationship_manifest.*
    INTO v_manifest
    FROM public.analysis_v2_relationship_manifests AS relationship_manifest
    WHERE relationship_manifest.request_id = p_request_id
      AND relationship_manifest.job_key = p_job_key;
    IF NOT FOUND THEN RETURN NULL; END IF;

    SELECT relationship_side.*
    INTO STRICT v_followers
    FROM public.analysis_v2_relationship_sides AS relationship_side
    WHERE relationship_side.request_id = p_request_id
      AND relationship_side.job_key = p_job_key
      AND relationship_side.side = 'followers';
    SELECT relationship_side.*
    INTO STRICT v_following
    FROM public.analysis_v2_relationship_sides AS relationship_side
    WHERE relationship_side.request_id = p_request_id
      AND relationship_side.job_key = p_job_key
      AND relationship_side.side = 'following';

    -- All four projections read the same persisted mutual rows. Each output
    -- retains the ordinal used by its consumers and by their integrity checks.
    SELECT jsonb_agg(payload ORDER BY m.mutual_ordinal),
           jsonb_agg(m.username ORDER BY m.detailed_ordinal) FILTER (WHERE m.detailed_ordinal IS NOT NULL),
           jsonb_agg(m.username ORDER BY m.mutual_ordinal) FILTER (WHERE m.is_private),
           jsonb_agg(payload ORDER BY m.mutual_ordinal) FILTER (WHERE m.is_private)
      INTO v_mutual_rows, v_detailed_names, v_private_names, v_private_rows
      FROM public.analysis_v2_mutual_rows m
      CROSS JOIN LATERAL (
          SELECT m.mutual_ordinal AS "mutualOrdinal", m.following_ordinal AS "followingOrdinal",
                 m.username, m.is_private AS "isPrivate", m.is_verified AS "isVerified",
                 m.full_name AS "fullName", m.profile_pic_url AS "profilePicUrl", m.detailed_ordinal AS "detailedOrdinal"
      ) AS payload
      WHERE m.request_id = p_request_id AND m.job_key = p_job_key;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id,
        'jobKey', p_job_key,
        'excludedUsername', v_manifest.excluded_username,
        'detailedMutualLimit', v_manifest.detailed_mutual_limit,
        'manifest', public.analysis_v2_relationship_manifest_json(v_manifest),
        'followers', public.analysis_v2_relationship_side_json(v_followers)
            || pg_catalog.jsonb_build_object(
                'provider', v_followers.provider,
                'providerRunId', v_followers.provider_run_id,
                'providerOperationKey', v_followers.provider_operation_key,
                'providerCredentialSlot', v_followers.provider_credential_slot,
                'rows', COALESCE((
                    SELECT pg_catalog.jsonb_agg(payload ORDER BY relationship_row.ordinal)
                    FROM public.analysis_v2_relationship_rows AS relationship_row
                    CROSS JOIN LATERAL (
                        SELECT relationship_row.username, relationship_row.is_private AS "isPrivate",
                               relationship_row.is_verified AS "isVerified", relationship_row.full_name AS "fullName",
                               relationship_row.profile_pic_url AS "profilePicUrl"
                    ) AS payload
                    WHERE relationship_row.request_id = p_request_id
                      AND relationship_row.job_key = p_job_key
                      AND relationship_row.side = 'followers'
                ), '[]'::JSONB)
            ),
        'following', public.analysis_v2_relationship_side_json(v_following)
            || pg_catalog.jsonb_build_object(
                'provider', v_following.provider,
                'providerRunId', v_following.provider_run_id,
                'providerOperationKey', v_following.provider_operation_key,
                'providerCredentialSlot', v_following.provider_credential_slot,
                'rows', COALESCE((
                    SELECT pg_catalog.jsonb_agg(payload ORDER BY relationship_row.ordinal)
                    FROM public.analysis_v2_relationship_rows AS relationship_row
                    CROSS JOIN LATERAL (
                        SELECT relationship_row.username, relationship_row.is_private AS "isPrivate",
                               relationship_row.is_verified AS "isVerified", relationship_row.full_name AS "fullName",
                               relationship_row.profile_pic_url AS "profilePicUrl"
                    ) AS payload
                    WHERE relationship_row.request_id = p_request_id
                      AND relationship_row.job_key = p_job_key
                      AND relationship_row.side = 'following'
                ), '[]'::JSONB)
            ),
        'mutualRows', COALESCE(v_mutual_rows, '[]'::jsonb),
        'detailedPublicUsernames', COALESCE(v_detailed_names, '[]'::jsonb),
        'privateMutualUsernames', COALESCE(v_private_names, '[]'::jsonb),
        'privateMutualRows', COALESCE(v_private_rows, '[]'::jsonb)
    );
END;
$_$;
COMMIT;
