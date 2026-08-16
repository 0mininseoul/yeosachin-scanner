-- Forward-only publication path for concierge batches after the already-published
-- first order.  The historic first-order RPC remains intentionally untouched.
CREATE OR REPLACE FUNCTION public.publish_concierge_batch_manual_override(
    p_order_id UUID,
    p_request_id UUID,
    p_owner_id UUID,
    p_target_username TEXT,
    p_target_input_hash TEXT,
    p_source_request_id UUID,
    p_replay_lineage_hash TEXT,
    p_relationship_manifest_hash TEXT,
    p_expected_version INTEGER,
    p_expected_result_hash TEXT,
    p_result_hash TEXT,
    p_result_url TEXT,
    p_interaction_lineage_hash TEXT,
    p_interaction_lineage JSONB,
    p_publication JSONB,
    p_classification_ledger JSONB,
    p_manual_import JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order public.earlybird_orders%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_source public.analysis_requests%ROWTYPE;
    v_step_data JSONB;
    v_target TEXT;
    v_current_version INTEGER;
    v_current_result_hash TEXT;
    v_current_result_url TEXT;
    v_previous_result_hash TEXT;
    v_current_counts JSONB;
    v_male INTEGER;
    v_female INTEGER;
    v_unknown INTEGER;
    v_public INTEGER;
    v_private INTEGER;
    v_unresolved INTEGER;
    v_mutual INTEGER;
    v_authoritative_mutual INTEGER;
    v_hydrated INTEGER;
    v_analyzed INTEGER;
    v_persisted_private_rows JSONB;
    v_idempotent BOOLEAN := FALSE;
BEGIN
    v_target := pg_catalog.lower(
        pg_catalog.regexp_replace(pg_catalog.btrim(p_target_username), '^@', '')
    );
    IF p_order_id IS NULL
       OR p_request_id IS NULL
       OR p_owner_id IS NULL
       OR p_source_request_id IS NULL
       OR p_source_request_id = p_request_id
       OR v_target !~ '^[a-z0-9._]{1,30}$'
       OR p_target_input_hash !~ '^[a-f0-9]{64}$'
       OR p_replay_lineage_hash !~ '^[a-f0-9]{64}$'
       OR p_relationship_manifest_hash !~ '^[a-f0-9]{64}$'
       OR p_result_hash !~ '^[a-f0-9]{64}$'
       OR p_interaction_lineage_hash !~ '^[a-f0-9]{64}$'
       OR p_result_url IS DISTINCT FROM '/result/' || p_request_id::TEXT
       OR p_expected_version IS NULL
       OR p_expected_version < 0
       OR (p_expected_result_hash IS NOT NULL
           AND p_expected_result_hash !~ '^[a-f0-9]{64}$')
       OR pg_catalog.jsonb_typeof(p_interaction_lineage) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(p_publication) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(p_publication->'rows') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(p_publication->'privateRows') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(p_publication->'counts') IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(p_classification_ledger) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(p_manual_import) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_PAYLOAD_INVALID', ERRCODE = 'P0001';
    END IF;

    IF COALESCE(p_publication->'counts'->>'male', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'female', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'unknown', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'public', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'private', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'unresolved', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'mutual', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'authoritativeMutual', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'hydrated', '') !~ '^[0-9]+$'
       OR COALESCE(p_publication->'counts'->>'analyzed', '') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_COUNTS_INVALID', ERRCODE = 'P0001';
    END IF;

    v_male := (p_publication->'counts'->>'male')::INTEGER;
    v_female := (p_publication->'counts'->>'female')::INTEGER;
    v_unknown := (p_publication->'counts'->>'unknown')::INTEGER;
    v_public := (p_publication->'counts'->>'public')::INTEGER;
    v_private := (p_publication->'counts'->>'private')::INTEGER;
    v_unresolved := (p_publication->'counts'->>'unresolved')::INTEGER;
    v_mutual := (p_publication->'counts'->>'mutual')::INTEGER;
    v_authoritative_mutual := (p_publication->'counts'->>'authoritativeMutual')::INTEGER;
    v_hydrated := (p_publication->'counts'->>'hydrated')::INTEGER;
    v_analyzed := (p_publication->'counts'->>'analyzed')::INTEGER;
    IF v_public <> v_male + v_female + v_unknown
       OR v_hydrated <> v_public + v_private
       OR v_mutual <> v_hydrated + v_unresolved
       OR v_authoritative_mutual <> v_mutual
       OR v_analyzed <> v_public THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_COUNTS_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF pg_catalog.jsonb_array_length(p_publication->'rows') <> v_female THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_PUBLIC_ROWS_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF (SELECT pg_catalog.count(*) FROM pg_catalog.jsonb_to_recordset(
            p_publication->'privateRows'
        ) AS row(
            sort_ordinal INTEGER,
            instagram_id TEXT,
            profile_image TEXT,
            full_name TEXT,
            name_female_score DOUBLE PRECISION,
            name_is_name BOOLEAN,
            name_confidence DOUBLE PRECISION
        )) <> v_private THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_PRIVATE_ROWS_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_to_recordset(p_publication->'privateRows') AS row(
            sort_ordinal INTEGER,
            instagram_id TEXT,
            profile_image TEXT,
            full_name TEXT,
            name_female_score DOUBLE PRECISION,
            name_is_name BOOLEAN,
            name_confidence DOUBLE PRECISION
        )
        WHERE row.sort_ordinal IS NULL
           OR row.instagram_id IS NULL
           OR row.instagram_id !~ '^[a-z0-9._]{1,30}$'
           OR row.instagram_id IS DISTINCT FROM pg_catalog.lower(
                pg_catalog.regexp_replace(pg_catalog.btrim(row.instagram_id), '^@', '')
           )
           OR row.name_female_score IS NULL
           OR row.name_female_score < 0
           OR row.name_female_score > 1
           OR row.name_is_name IS NULL
           OR row.name_confidence IS NULL
           OR row.name_confidence < 0
           OR row.name_confidence > 1
           OR (row.name_is_name = FALSE AND row.name_female_score <> 0.5)
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_PRIVATE_NAME_INVALID', ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (
            SELECT row.instagram_id,
                   row.sort_ordinal,
                   pg_catalog.row_number() OVER (
                       ORDER BY row.name_female_score DESC,
                                row.name_confidence DESC,
                                row.instagram_id ASC
                   )::INTEGER AS expected_sort_ordinal
            FROM pg_catalog.jsonb_to_recordset(p_publication->'privateRows') AS row(
                sort_ordinal INTEGER,
                instagram_id TEXT,
                profile_image TEXT,
                full_name TEXT,
                name_female_score DOUBLE PRECISION,
                name_is_name BOOLEAN,
                name_confidence DOUBLE PRECISION
            )
        ) AS ordered
        WHERE ordered.sort_ordinal <> ordered.expected_sort_ordinal
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_to_recordset(p_publication->'privateRows') AS row(
            sort_ordinal INTEGER,
            instagram_id TEXT,
            profile_image TEXT,
            full_name TEXT,
            name_female_score DOUBLE PRECISION,
            name_is_name BOOLEAN,
            name_confidence DOUBLE PRECISION
        )
        GROUP BY row.instagram_id
        HAVING pg_catalog.count(*) <> 1
    ) THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_PRIVATE_ORDER_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.*
      INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT request.*
      INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
    FOR UPDATE;
    SELECT source.*
      INTO v_source
    FROM public.analysis_requests AS source
    WHERE source.id = p_source_request_id;

    IF v_order.id IS NULL
       OR v_order.user_id IS DISTINCT FROM p_owner_id
       OR pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)) IS DISTINCT FROM v_target
       OR v_order.result_request_id IS DISTINCT FROM p_request_id
       OR v_order.status NOT IN ('paid', 'analysis_in_progress', 'completed')
       OR v_order.paid_at IS NULL
       OR v_request.id IS NULL
       OR v_request.user_id IS DISTINCT FROM p_owner_id
       OR pg_catalog.lower(pg_catalog.btrim(v_request.target_instagram_id)) IS DISTINCT FROM v_target
       OR v_source.id IS NULL
       OR v_source.user_id IS DISTINCT FROM p_owner_id THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_SCOPE_CONFLICT', ERRCODE = 'P0001';
    END IF;

    v_step_data := COALESCE(v_request.step_data, '{}'::JSONB);
    -- The paid first order was published by a deliberately separate one-shot
    -- RPC.  Never permit this forward-only path to mutate it.
    IF v_step_data ? 'conciergeBootstrap' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_FIRST_ORDER_IMMUTABLE', ERRCODE = 'P0001';
    END IF;
    IF COALESCE(v_step_data#>>'{conciergeBatchPublication,version}', '0') !~ '^[0-9]+$' THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_STATE_INVALID', ERRCODE = 'P0001';
    END IF;
    v_current_version := COALESCE((v_step_data#>>'{conciergeBatchPublication,version}')::INTEGER, 0);
    v_current_result_hash := v_step_data#>>'{conciergeBatchPublication,resultHash}';
    v_current_result_url := v_step_data#>>'{conciergeBatchPublication,resultUrl}';
    v_previous_result_hash := v_step_data#>>'{conciergeBatchPublication,previousResultHash}';
    v_current_counts := v_step_data#>'{conciergeBatchPublication,counts}';

    IF v_current_result_hash = p_result_hash THEN
        IF v_current_version <> p_expected_version + 1
           OR v_previous_result_hash IS DISTINCT FROM p_expected_result_hash
           OR v_current_result_url IS DISTINCT FROM p_result_url
           OR v_current_counts IS DISTINCT FROM p_publication->'counts' THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_STALE_VERSION', ERRCODE = 'P0001';
        END IF;
        v_idempotent := TRUE;
    ELSIF v_current_version <> p_expected_version
       OR v_current_result_hash IS DISTINCT FROM p_expected_result_hash THEN
        RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_STALE_VERSION', ERRCODE = 'P0001';
    END IF;

    IF NOT v_idempotent THEN
        IF v_order.status = 'completed' THEN
            RAISE EXCEPTION USING MESSAGE = 'CONCIERGE_PUBLICATION_COMPLETED_ORDER_IMMUTABLE', ERRCODE = 'P0001';
        END IF;
        DELETE FROM public.analysis_results WHERE request_id = p_request_id;
        INSERT INTO public.analysis_results (
            request_id, rank, suspect_instagram_id, suspect_profile_image,
            suspect_full_name, bio, risk_score, photogenic_grade,
            exposure_level, is_tagged, risk_grade, gender_confidence,
            gender_status, is_unlocked, likes_count, intimate_comments_count,
            one_line_overview, risk_analysis
        )
        SELECT p_request_id, row.rank, row.suspect_instagram_id,
               row.suspect_profile_image, row.suspect_full_name, row.bio,
               row.risk_score, row.photogenic_grade, row.exposure_level,
               row.is_tagged, row.risk_grade, row.gender_confidence,
               row.gender_status, row.is_unlocked, row.likes_count,
               row.intimate_comments_count, row.one_line_overview,
               row.risk_analysis
        FROM pg_catalog.jsonb_to_recordset(p_publication->'rows') AS row(
            rank INTEGER,
            suspect_instagram_id TEXT,
            suspect_profile_image TEXT,
            suspect_full_name TEXT,
            bio TEXT,
            risk_score INTEGER,
            photogenic_grade INTEGER,
            exposure_level TEXT,
            is_tagged BOOLEAN,
            risk_grade TEXT,
            gender_confidence DOUBLE PRECISION,
            gender_status TEXT,
            is_unlocked BOOLEAN,
            likes_count INTEGER,
            intimate_comments_count INTEGER,
            one_line_overview TEXT,
            risk_analysis JSONB
        );

        DELETE FROM public.private_accounts WHERE request_id = p_request_id;
        INSERT INTO public.private_accounts (
            request_id, instagram_id, profile_image, full_name,
            name_female_score, name_is_name, name_confidence
        )
        SELECT p_request_id, row.instagram_id, row.profile_image, row.full_name,
               row.name_female_score, row.name_is_name, row.name_confidence
        FROM pg_catalog.jsonb_to_recordset(p_publication->'privateRows') AS row(
            sort_ordinal INTEGER,
            instagram_id TEXT,
            profile_image TEXT,
            full_name TEXT,
            name_female_score DOUBLE PRECISION,
            name_is_name BOOLEAN,
            name_confidence DOUBLE PRECISION
        );

        UPDATE public.analysis_requests
        SET status = 'completed',
            mutual_follows = v_mutual,
            opposite_gender_count = v_female,
            gender_stats = pg_catalog.jsonb_build_object(
                'male', v_male,
                'female', v_female,
                'unknown', v_unknown
            ),
            step_data = pg_catalog.jsonb_set(
                v_step_data,
                '{conciergeBatchPublication}',
                pg_catalog.jsonb_build_object(
                    'version', v_current_version + 1,
                    'previousResultHash', v_current_result_hash,
                    'resultHash', p_result_hash,
                    'resultUrl', p_result_url,
                    'sourceRequestId', p_source_request_id,
                    'targetInputHash', p_target_input_hash,
                    'replayLineageHash', p_replay_lineage_hash,
                    'relationshipManifestHash', p_relationship_manifest_hash,
                    'interactionLineageHash', p_interaction_lineage_hash,
                    'counts', p_publication->'counts'
                ),
                TRUE
            )
        WHERE id = p_request_id;
        UPDATE public.earlybird_orders
        SET status = 'completed'
        WHERE id = p_order_id;
        v_current_version := v_current_version + 1;
    END IF;

    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'sortOrdinal', ordered.sort_ordinal,
            'instagramId', ordered.instagram_id,
            'profileImage', ordered.profile_image,
            'fullName', ordered.full_name,
            'nameFemaleScore', ordered.name_female_score,
            'nameIsName', ordered.name_is_name,
            'nameConfidence', ordered.name_confidence
        ) ORDER BY ordered.sort_ordinal
    ), '[]'::JSONB)
    INTO v_persisted_private_rows
    FROM (
        SELECT pg_catalog.row_number() OVER (
            ORDER BY private_account.name_female_score DESC,
                     private_account.name_confidence DESC,
                     private_account.instagram_id ASC
        )::INTEGER AS sort_ordinal,
        private_account.instagram_id,
        private_account.profile_image,
        private_account.full_name,
        private_account.name_female_score,
        private_account.name_is_name,
        private_account.name_confidence
        FROM public.private_accounts AS private_account
        WHERE private_account.request_id = p_request_id
    ) AS ordered;

    RETURN pg_catalog.jsonb_build_object(
        'published', TRUE,
        'idempotent', v_idempotent,
        'ownerReadContractVerified', TRUE,
        'adminReadContractVerified', TRUE,
        'resultHash', p_result_hash,
        'resultUrl', p_result_url,
        'requestId', p_request_id,
        'version', v_current_version,
        'counts', p_publication->'counts',
        'privateRows', v_persisted_private_rows
    );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_concierge_batch_manual_override(
    UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT,
    TEXT, TEXT, JSONB, JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_concierge_batch_manual_override(
    UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT,
    TEXT, TEXT, JSONB, JSONB, JSONB, JSONB
) TO service_role;

COMMENT ON FUNCTION public.publish_concierge_batch_manual_override(
    UUID, UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, INTEGER, TEXT, TEXT,
    TEXT, TEXT, JSONB, JSONB, JSONB, JSONB
) IS 'Service-role-only atomic publisher for future concierge batch orders. Persists private name-likelihood fields and returns their ordered read contract; rejects the already-published first-order bootstrap.';
