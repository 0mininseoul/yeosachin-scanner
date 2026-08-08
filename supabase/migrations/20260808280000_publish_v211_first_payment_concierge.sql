-- MIGRATION_PREDECESSOR=20260808270000
-- One-shot, service-role-only publication boundary for the first paid Basic
-- v2.11 concierge recovery. No customer or Instagram identity is accepted as
-- input; both are resolved from the already-fenced incident ledger.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260808270000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

ALTER FUNCTION public.read_earlybird_v211_concierge_recovery_source()
    RENAME TO read_earlybird_v211_concierge_recovery_source_v1;
REVOKE ALL ON FUNCTION public.read_earlybird_v211_concierge_recovery_source_v1()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.read_earlybird_v211_concierge_recovery_source()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source JSONB;
    v_descriptor_hash TEXT;
BEGIN
    v_source := public.read_earlybird_v211_concierge_recovery_source_v1();
    IF pg_catalog.jsonb_typeof(v_source) <> 'object'
       OR pg_catalog.jsonb_array_length(v_source->'preflightRuns') <> 4
       OR pg_catalog.jsonb_array_length(v_source->'providerRuns') <> 15
       OR pg_catalog.jsonb_array_length(v_source->'schedulerOperations') <> 22 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_NOT_EXACT',
            ERRCODE = 'P0001';
    END IF;
    v_descriptor_hash := public.analysis_v2_dag_hash_json(
        pg_catalog.jsonb_build_object(
            'domain', 'earlybird-v211-first-payment-concierge-source-v2',
            'source', v_source
        )
    );
    RETURN (v_source - 'schemaVersion') || pg_catalog.jsonb_build_object(
        'schemaVersion', 2,
        'descriptorHash', v_descriptor_hash
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_earlybird_v211_concierge_recovery_source()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_earlybird_v211_concierge_recovery_source()
    TO service_role;

CREATE TABLE public.earlybird_v211_concierge_publications (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    descriptor_hash VARCHAR(64) NOT NULL CHECK (
        descriptor_hash ~ '^[a-f0-9]{64}$'
    ),
    evidence_hash VARCHAR(64) NOT NULL CHECK (
        evidence_hash ~ '^[a-f0-9]{64}$'
    ),
    payload_hash VARCHAR(64) NOT NULL CHECK (
        payload_hash ~ '^[a-f0-9]{64}$'
    ),
    female_count SMALLINT NOT NULL CHECK (female_count BETWEEN 0 AND 130),
    private_count SMALLINT NOT NULL CHECK (private_count = 48),
    status TEXT NOT NULL CHECK (status IN ('publishing', 'completed')),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    completed_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT earlybird_v211_concierge_publications_terminal_check CHECK (
        (status = 'publishing' AND completed_at IS NULL)
        OR (status = 'completed' AND completed_at IS NOT NULL)
    )
);

ALTER TABLE public.earlybird_v211_concierge_publications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_v211_concierge_publications FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_v211_concierge_publications
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.analysis_v2_is_first_payment_concierge_publication(
    p_request_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_v211_concierge_publications AS publication
        WHERE publication.request_id = p_request_id
          AND publication.status = 'publishing'
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_is_first_payment_concierge_publication(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

-- The normal result triggers remain unchanged. Their WHEN clauses skip only
-- the transaction carrying the exact one-shot publication marker.
DROP TRIGGER populate_analysis_v2_result_gender_stats
    ON public.analysis_v2_result_summaries;
CREATE TRIGGER populate_analysis_v2_result_gender_stats
BEFORE INSERT ON public.analysis_v2_result_summaries
FOR EACH ROW
WHEN (
    NOT public.analysis_v2_is_first_payment_concierge_publication(NEW.request_id)
)
EXECUTE FUNCTION public.analysis_v2_populate_result_gender_stats();

DROP TRIGGER seal_analysis_v2_gender_resolution_metrics
    ON public.analysis_v2_result_summaries;
CREATE TRIGGER seal_analysis_v2_gender_resolution_metrics
BEFORE INSERT ON public.analysis_v2_result_summaries
FOR EACH ROW
WHEN (
    NOT public.analysis_v2_is_first_payment_concierge_publication(NEW.request_id)
)
EXECUTE FUNCTION public.analysis_v2_seal_gender_resolution_metrics();

CREATE FUNCTION public.publish_earlybird_v211_first_payment_concierge(
    p_descriptor_hash TEXT,
    p_evidence_hash TEXT,
    p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_source JSONB;
    v_counts JSONB;
    v_female_rows JSONB;
    v_private_rows JSONB;
    v_payload_hash TEXT;
    v_replay public.earlybird_v211_apify_transient_replays%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_progress public.analysis_progress_state%ROWTYPE;
    v_existing public.earlybird_v211_concierge_publications%ROWTYPE;
    v_followers_declared INTEGER;
    v_followers_collected INTEGER;
    v_following_declared INTEGER;
    v_following_collected INTEGER;
    v_detected_mutuals INTEGER;
    v_public_mutuals INTEGER;
    v_private_mutuals INTEGER;
    v_screened_mutuals INTEGER;
    v_not_screened_mutuals INTEGER;
    v_fetch_unavailable INTEGER;
    v_media_unavailable INTEGER;
    v_analysis_unavailable INTEGER;
    v_male INTEGER;
    v_female INTEGER;
    v_unknown INTEGER;
    v_tracks JSONB;
    v_revision BIGINT;
    v_sequence BIGINT;
    v_fingerprint TEXT;
    v_event_key TEXT;
BEGIN
    IF p_descriptor_hash IS NULL
       OR p_descriptor_hash !~ '^[a-f0-9]{64}$'
       OR p_evidence_hash IS NULL
       OR p_evidence_hash !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR NOT p_payload ?& ARRAY[
            'schemaVersion', 'descriptorHash', 'evidenceHash',
            'semanticInputFingerprint', 'targetFullName', 'counts',
            'femaleRows', 'privateRows'
       ]
       OR p_payload - ARRAY[
            'schemaVersion', 'descriptorHash', 'evidenceHash',
            'semanticInputFingerprint', 'targetFullName', 'counts',
            'femaleRows', 'privateRows'
       ] <> '{}'::JSONB
       OR p_payload->>'schemaVersion' <> '1'
       OR p_payload->>'descriptorHash' <> p_descriptor_hash
       OR p_payload->>'evidenceHash' <> p_evidence_hash
       OR p_payload->>'semanticInputFingerprint' !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_payload->'counts') <> 'object'
       OR pg_catalog.jsonb_typeof(p_payload->'femaleRows') <> 'array'
       OR pg_catalog.jsonb_typeof(p_payload->'privateRows') <> 'array'
       OR (
            p_payload->'targetFullName' <> 'null'::JSONB
            AND (
                pg_catalog.jsonb_typeof(p_payload->'targetFullName') <> 'string'
                OR pg_catalog.char_length(p_payload->>'targetFullName') NOT BETWEEN 1 AND 200
                OR p_payload->>'targetFullName' ~ '[[:cntrl:]]'
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT publication.* INTO v_existing
    FROM public.earlybird_v211_concierge_publications AS publication
    WHERE publication.status = 'completed';
    IF FOUND THEN
        IF v_existing.descriptor_hash <> p_descriptor_hash
           OR v_existing.evidence_hash <> p_evidence_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'completed', TRUE,
            'requestId', v_existing.request_id,
            'resultPath', '/result/' || v_existing.request_id::TEXT
        );
    END IF;

    v_source := public.read_earlybird_v211_concierge_recovery_source();
    IF v_source->>'descriptorHash' <> p_descriptor_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_SOURCE_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    SELECT replay.* INTO v_replay
    FROM public.earlybird_v211_apify_transient_replays AS replay
    FOR UPDATE;
    IF NOT FOUND OR 1 <> (
        SELECT pg_catalog.count(*)
        FROM public.earlybird_v211_apify_transient_replays
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_replay.order_id
    FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_replay.order_id
    FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = v_fulfillment.request_id
    FOR UPDATE;
    IF v_order.id IS NULL
       OR v_fulfillment.order_id IS NULL
       OR v_request.id IS NULL
       OR v_order.plan_id <> 'basic'
       OR v_order.expected_amount_krw <> 990
       OR v_order.actual_amount_krw <> 990
       OR v_order.payment_id IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_order.exclusion_decision <> 'skip'
       OR v_order.excluded_instagram_id IS NOT NULL
       OR v_order.status <> 'analysis_in_progress'
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.status <> 'manual_review'
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.last_error_code <> 'ANALYSIS_FAILED'
       OR v_request.pipeline_version <> 'v2'
       OR v_request.selected_plan_id_snapshot <> 'basic'
       OR v_request.status <> 'failed'
       OR v_request.current_step <> 'failed'
       OR v_request.background_processing
       OR v_request.error_message <> 'SCRAPING_INCOMPLETE_ERROR'
       OR v_request.policy_versions_snapshot <> pg_catalog.jsonb_build_object(
            'pipeline', 'v2',
            'risk', 'risk-policy-v2.5',
            'aiStage', 'ai-stage-policy-v2.11',
            'scheduler', 'ai-scheduler-v1'
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_result_summaries AS summary
            WHERE summary.request_id IN (
                v_replay.original_failed_request_id,
                v_replay.policy_identity_failed_request_id,
                v_replay.transient_failed_request_id,
                v_request.id
            )
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    v_counts := p_payload->'counts';
    IF NOT v_counts ?& ARRAY[
        'followersDeclared', 'followersCollected',
        'followingDeclared', 'followingCollected', 'detectedMutuals',
        'publicMutuals', 'privateMutuals', 'screenedMutuals',
        'notScreenedMutuals', 'fetchUnavailableCount',
        'mediaUnavailableCount', 'analysisUnavailableCount',
        'male', 'female', 'unknown'
    ] OR v_counts - ARRAY[
        'followersDeclared', 'followersCollected',
        'followingDeclared', 'followingCollected', 'detectedMutuals',
        'publicMutuals', 'privateMutuals', 'screenedMutuals',
        'notScreenedMutuals', 'fetchUnavailableCount',
        'mediaUnavailableCount', 'analysisUnavailableCount',
        'male', 'female', 'unknown'
    ] <> '{}'::JSONB THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_COUNT_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    v_followers_declared := (v_counts->>'followersDeclared')::INTEGER;
    v_followers_collected := (v_counts->>'followersCollected')::INTEGER;
    v_following_declared := (v_counts->>'followingDeclared')::INTEGER;
    v_following_collected := (v_counts->>'followingCollected')::INTEGER;
    v_detected_mutuals := (v_counts->>'detectedMutuals')::INTEGER;
    v_public_mutuals := (v_counts->>'publicMutuals')::INTEGER;
    v_private_mutuals := (v_counts->>'privateMutuals')::INTEGER;
    v_screened_mutuals := (v_counts->>'screenedMutuals')::INTEGER;
    v_not_screened_mutuals := (v_counts->>'notScreenedMutuals')::INTEGER;
    v_fetch_unavailable := (v_counts->>'fetchUnavailableCount')::INTEGER;
    v_media_unavailable := (v_counts->>'mediaUnavailableCount')::INTEGER;
    v_analysis_unavailable := (v_counts->>'analysisUnavailableCount')::INTEGER;
    v_male := (v_counts->>'male')::INTEGER;
    v_female := (v_counts->>'female')::INTEGER;
    v_unknown := (v_counts->>'unknown')::INTEGER;
    IF v_followers_collected <> 390
       OR v_followers_declared NOT BETWEEN 390 AND 393
       OR v_followers_collected * 100 < v_followers_declared * 99
       OR v_following_collected <> 256
       OR v_following_declared NOT BETWEEN 256 AND 258
       OR v_following_collected * 100 < v_following_declared * 99
       OR v_detected_mutuals <> 182
       OR v_public_mutuals <> 134
       OR v_private_mutuals <> 48
       OR v_screened_mutuals <> 130
       OR v_not_screened_mutuals <> 4
       OR v_fetch_unavailable <> 0
       OR v_media_unavailable NOT BETWEEN 0 AND 130
       OR v_analysis_unavailable NOT BETWEEN 0 AND 130
       OR v_male NOT BETWEEN 0 AND 130
       OR v_female NOT BETWEEN 0 AND 130
       OR v_unknown NOT BETWEEN 0 AND 130
       OR v_male + v_female + v_unknown <> 130
       OR v_media_unavailable + v_analysis_unavailable > v_unknown THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_COUNT_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_female_rows := p_payload->'femaleRows';
    v_private_rows := p_payload->'privateRows';
    IF pg_catalog.jsonb_array_length(v_female_rows) <> v_female
       OR pg_catalog.jsonb_array_length(v_private_rows) <> 48
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_female_rows) AS item
            WHERE pg_catalog.jsonb_typeof(item) <> 'object'
               OR NOT item ?& ARRAY[
                    'candidateId', 'sortOrdinal', 'instagramId', 'fullName',
                    'profileImageUrl', 'bio', 'displayScore', 'riskBand',
                    'featuredRank', 'recentMutualRank', 'analysisDepth',
                    'oneLineOverview', 'narrativeLineOne', 'narrativeLineTwo'
               ]
               OR item - ARRAY[
                    'candidateId', 'sortOrdinal', 'instagramId', 'fullName',
                    'profileImageUrl', 'bio', 'displayScore', 'riskBand',
                    'featuredRank', 'recentMutualRank', 'analysisDepth',
                    'oneLineOverview', 'narrativeLineOne', 'narrativeLineTwo'
               ] <> '{}'::JSONB
               OR item->'profileImageUrl' <> 'null'::JSONB
       )
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_private_rows) AS item
            WHERE pg_catalog.jsonb_typeof(item) <> 'object'
               OR NOT item ?& ARRAY[
                    'candidateId', 'sortOrdinal', 'instagramId', 'fullName',
                    'profileImageUrl'
               ]
               OR item - ARRAY[
                    'candidateId', 'sortOrdinal', 'instagramId', 'fullName',
                    'profileImageUrl'
               ] <> '{}'::JSONB
               OR item->'profileImageUrl' <> 'null'::JSONB
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_ROW_DRIFT',
            ERRCODE = 'P0001';
    END IF;
    IF (
        SELECT pg_catalog.count(DISTINCT item->>'candidateId')
        FROM (
            SELECT item FROM pg_catalog.jsonb_array_elements(v_female_rows) AS item
            UNION ALL
            SELECT item FROM pg_catalog.jsonb_array_elements(v_private_rows) AS item
        ) AS rows
    ) <> v_female + 48
       OR (
        SELECT pg_catalog.count(DISTINCT item->>'instagramId')
        FROM (
            SELECT item FROM pg_catalog.jsonb_array_elements(v_female_rows) AS item
            UNION ALL
            SELECT item FROM pg_catalog.jsonb_array_elements(v_private_rows) AS item
        ) AS rows
    ) <> v_female + 48
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_female_rows)
                WITH ORDINALITY AS row(item, ordinal)
            WHERE (item->>'sortOrdinal')::INTEGER <> ordinal
               OR item->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item->>'instagramId' !~ '^[a-z0-9._]{1,30}$'
               OR item->>'instagramId' = v_order.target_instagram_id
       )
       OR EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_array_elements(v_private_rows)
                WITH ORDINALITY AS row(item, ordinal)
            WHERE (item->>'sortOrdinal')::INTEGER <> ordinal
               OR item->>'candidateId' !~ '^[A-Za-z0-9._:-]{1,128}$'
               OR item->>'instagramId' !~ '^[a-z0-9._]{1,30}$'
               OR item->>'instagramId' = v_order.target_instagram_id
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_IDENTITY_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    SELECT progress.* INTO v_progress
    FROM public.analysis_progress_state AS progress
    WHERE progress.request_id = v_request.id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_NOT_READY',
            ERRCODE = 'P0001';
    END IF;

    v_payload_hash := public.analysis_v2_dag_hash_json(
        pg_catalog.jsonb_build_object(
            'domain', 'earlybird-v211-first-payment-concierge-publication-v1',
            'payload', p_payload
        )
    );
    INSERT INTO public.earlybird_v211_concierge_publications (
        request_id, descriptor_hash, evidence_hash, payload_hash,
        female_count, private_count, status
    ) VALUES (
        v_request.id, p_descriptor_hash, p_evidence_hash, v_payload_hash,
        v_female, 48, 'publishing'
    );

    INSERT INTO public.analysis_v2_result_summaries (
        request_id, target_instagram_id, target_profile_image_url, target_full_name,
        plan_id, followers_declared, followers_collected,
        following_declared, following_collected, detected_mutuals,
        public_mutuals, private_mutuals, screened_mutuals,
        not_screened_mutuals, fetch_unavailable_count,
        media_unavailable_count, analysis_unavailable_count,
        exclusion_applied, score_policy_version, finalizer_input_hash,
        male_count, female_count, unknown_count
    ) VALUES (
        v_request.id, v_order.target_instagram_id, NULL,
        p_payload->>'targetFullName', 'basic',
        v_followers_declared, v_followers_collected,
        v_following_declared, v_following_collected, v_detected_mutuals,
        v_public_mutuals, v_private_mutuals, v_screened_mutuals,
        v_not_screened_mutuals, v_fetch_unavailable,
        v_media_unavailable, v_analysis_unavailable,
        FALSE, 'risk-policy-v2.5', v_payload_hash,
        v_male, v_female, v_unknown
    );
    -- The generic target-name trigger correctly sees the scrubbed preflight;
    -- restore only the already-validated name retained in this result payload.
    UPDATE public.analysis_v2_result_summaries AS summary
    SET target_full_name = p_payload->>'targetFullName'
    WHERE summary.request_id = v_request.id;

    INSERT INTO public.analysis_v2_female_results (
        request_id, candidate_id, sort_ordinal, instagram_id, full_name,
        profile_image_url, bio, display_score, risk_band, featured_rank,
        recent_mutual_rank, analysis_depth, one_line_overview,
        narrative_line_one, narrative_line_two
    )
    SELECT v_request.id,
        item->>'candidateId', (item->>'sortOrdinal')::SMALLINT,
        item->>'instagramId', item->>'fullName', NULL, item->>'bio',
        (item->>'displayScore')::NUMERIC,
        item->>'riskBand', (item->>'featuredRank')::SMALLINT,
        (item->>'recentMutualRank')::SMALLINT, item->>'analysisDepth',
        item->>'oneLineOverview', item->>'narrativeLineOne',
        item->>'narrativeLineTwo'
    FROM pg_catalog.jsonb_array_elements(v_female_rows) AS item;

    INSERT INTO public.analysis_v2_private_results (
        request_id, candidate_id, sort_ordinal, instagram_id,
        full_name, profile_image_url
    )
    SELECT v_request.id,
        item->>'candidateId', (item->>'sortOrdinal')::SMALLINT,
        item->>'instagramId', item->>'fullName', NULL
    FROM pg_catalog.jsonb_array_elements(v_private_rows) AS item;

    IF (SELECT pg_catalog.count(*) FROM public.analysis_v2_female_results
        WHERE request_id = v_request.id) <> v_female
       OR (SELECT pg_catalog.count(*) FROM public.analysis_v2_private_results
        WHERE request_id = v_request.id) <> 48 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_PUBLICATION_ROW_DRIFT',
            ERRCODE = 'P0001';
    END IF;

    v_tracks := pg_catalog.jsonb_build_object(
        'relationshipAi', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'relationshipAi'->>'stageCode',
            'done', (v_progress.tracks->'relationshipAi'->>'total')::INTEGER,
            'total', (v_progress.tracks->'relationshipAi'->>'total')::INTEGER,
            'progressBp', CASE
                WHEN (v_progress.tracks->'relationshipAi'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        ),
        'interactions', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'interactions'->>'stageCode',
            'done', (v_progress.tracks->'interactions'->>'total')::INTEGER,
            'total', (v_progress.tracks->'interactions'->>'total')::INTEGER,
            'progressBp', CASE
                WHEN (v_progress.tracks->'interactions'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        ),
        'finalization', pg_catalog.jsonb_build_object(
            'state', 'completed',
            'stageCode', v_progress.tracks->'finalization'->>'stageCode',
            'done', (v_progress.tracks->'finalization'->>'total')::INTEGER,
            'total', (v_progress.tracks->'finalization'->>'total')::INTEGER,
            'progressBp', CASE
                WHEN (v_progress.tracks->'finalization'->>'total')::INTEGER = 0
                THEN 0 ELSE 10000 END
        )
    );
    v_revision := v_progress.revision + 1;
    v_sequence := v_progress.last_event_seq + 1;
    v_fingerprint := public.analysis_v2_dag_hash_json(
        pg_catalog.jsonb_build_object(
            'domain', 'analysis-v2-progress-snapshot-v1',
            'requestId', v_request.id, 'status', 'completed',
            'progressBp', 10000, 'backgroundProcessing', FALSE,
            'tracks', v_tracks, 'activeProfile', NULL, 'etaRange', NULL
        )
    );
    v_event_key := public.analysis_v2_dag_hash_json(
        pg_catalog.jsonb_build_object(
            'domain', 'analysis-v2-progress-event-v1',
            'requestId', v_request.id, 'eventCode', 'ANALYSIS_COMPLETED'
        )
    );
    UPDATE public.analysis_progress_state AS progress
    SET revision = v_revision, status = 'completed', progress_bp = 10000,
        background_processing = FALSE, tracks = v_tracks,
        active_profile = NULL, eta_range = NULL,
        last_event_seq = v_sequence, snapshot_fingerprint = v_fingerprint,
        updated_at = v_now
    WHERE progress.request_id = v_request.id;
    INSERT INTO public.analysis_progress_events (
        request_id, seq, event_key, revision, snapshot_fingerprint,
        occurred_at, event_state, event_code, copy_code, aggregate_count
    ) VALUES (
        v_request.id, v_sequence, v_event_key, v_revision, v_fingerprint,
        v_now, 'confirmed', 'ANALYSIS_COMPLETED', 'ANALYSIS_COMPLETED', NULL
    );

    UPDATE public.analysis_requests AS analysis_request
    SET status = 'completed', progress = 100,
        progress_step = 'V2 analysis completed', current_step = 'completed',
        background_processing = FALSE, error_message = NULL,
        total_followers = v_followers_declared,
        mutual_follows = v_detected_mutuals,
        opposite_gender_count = v_female,
        gender_stats = pg_catalog.jsonb_build_object(
            'male', v_male, 'female', v_female, 'unknown', v_unknown
        ),
        completed_at = v_now
    WHERE analysis_request.id = v_request.id;
    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'completed', result_request_id = v_request.id,
        updated_at = v_now
    WHERE earlybird_order.id = v_order.id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
        last_error_code = NULL, last_error_at = NULL,
        manual_review_at = NULL, completed_at = v_now, updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;
    UPDATE public.earlybird_v211_concierge_publications AS publication
    SET status = 'completed', completed_at = v_now
    WHERE publication.request_id = v_request.id
      AND publication.status = 'publishing';

    RETURN pg_catalog.jsonb_build_object(
        'completed', TRUE,
        'requestId', v_request.id,
        'resultPath', '/result/' || v_request.id::TEXT
    );
END;
$$;

REVOKE ALL ON FUNCTION public.publish_earlybird_v211_first_payment_concierge(
    TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_earlybird_v211_first_payment_concierge(
    TEXT, TEXT, JSONB
) TO service_role;

CREATE FUNCTION public.read_earlybird_v211_concierge_publication_status()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_publication public.earlybird_v211_concierge_publications%ROWTYPE;
    v_request_status TEXT;
    v_order_status TEXT;
    v_fulfillment_status TEXT;
    v_female_rows INTEGER;
    v_private_rows INTEGER;
BEGIN
    SELECT publication.* INTO v_publication
    FROM public.earlybird_v211_concierge_publications AS publication
    WHERE publication.status = 'completed';
    IF NOT FOUND THEN
        RETURN pg_catalog.jsonb_build_object('completed', FALSE);
    END IF;
    SELECT request.status INTO v_request_status
    FROM public.analysis_requests AS request
    WHERE request.id = v_publication.request_id;
    SELECT earlybird_order.status INTO v_order_status
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.result_request_id = v_publication.request_id;
    SELECT fulfillment.status INTO v_fulfillment_status
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.request_id = v_publication.request_id;
    SELECT pg_catalog.count(*)::INTEGER INTO v_female_rows
    FROM public.analysis_v2_female_results AS female
    WHERE female.request_id = v_publication.request_id;
    SELECT pg_catalog.count(*)::INTEGER INTO v_private_rows
    FROM public.analysis_v2_private_results AS private_result
    WHERE private_result.request_id = v_publication.request_id;
    RETURN pg_catalog.jsonb_build_object(
        'completed', v_request_status = 'completed'
            AND v_order_status = 'completed'
            AND v_fulfillment_status = 'completed'
            AND v_female_rows = v_publication.female_count
            AND v_private_rows = v_publication.private_count,
        'requestId', v_publication.request_id,
        'resultPath', '/result/' || v_publication.request_id::TEXT,
        'requestStatus', v_request_status,
        'orderStatus', v_order_status,
        'fulfillmentStatus', v_fulfillment_status,
        'femaleRows', v_female_rows,
        'privateRows', v_private_rows
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_earlybird_v211_concierge_publication_status()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_earlybird_v211_concierge_publication_status()
    TO service_role;

DO $final_guard$
DECLARE
    v_source_signature TEXT :=
        'public.read_earlybird_v211_concierge_recovery_source()';
    v_publish_signature TEXT :=
        'public.publish_earlybird_v211_first_payment_concierge(text,text,jsonb)';
    v_status_signature TEXT :=
        'public.read_earlybird_v211_concierge_publication_status()';
BEGIN
    IF pg_catalog.has_function_privilege('anon', v_source_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_source_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_source_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_publish_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_publish_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_publish_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('anon', v_status_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_status_signature, 'EXECUTE')
       OR NOT pg_catalog.has_function_privilege('service_role', v_status_signature, 'EXECUTE') THEN
        RAISE EXCEPTION
            'EARLYBIRD_V211_CONCIERGE_PUBLICATION_FINAL_GUARD_MISMATCH';
    END IF;
END;
$final_guard$;

COMMIT;
