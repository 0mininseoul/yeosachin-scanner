-- MIGRATION_PREDECESSOR=20260814223000
-- Narrow, forward-only recovery for the one paid Basic concierge order from
-- 2026-08-12.  This RPC deliberately requires the complete reviewed
-- relationship arrays.  It must fail before any write when those arrays are
-- unavailable; no relationship or interaction evidence is synthesized here.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := TRUE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        EXECUTE $sql$
            SELECT EXISTS (
                SELECT 1
                FROM supabase_migrations.schema_migrations
                WHERE version = '20260814223000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE FUNCTION public.bootstrap_earlybird_v211_concierge_first_order(
    p_order_id UUID,
    p_owner_id UUID,
    p_source_request_id UUID,
    p_first_relationship_request_id UUID,
    p_second_relationship_request_id UUID,
    p_failed_preflight_id UUID,
    p_rearmed_preflight_id UUID,
    p_result_request_id UUID,
    p_target_instagram_id TEXT,
    p_expected_fulfillment_status TEXT,
    p_expected_fulfillment_attempt_count SMALLINT,
    p_exact_mutual INTEGER,
    p_hydrated INTEGER,
    p_public INTEGER,
    p_private INTEGER,
    p_unresolved INTEGER,
    p_source_fingerprint TEXT,
    p_result_hash TEXT,
    p_artifact_hashes JSONB,
    p_followers JSONB,
    p_following JSONB,
    p_target_evidence JSONB,
    p_publication_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_candidate_count INTEGER;
    v_intersection_count INTEGER;
    v_recovery_rows INTEGER;
    v_recovery_table TEXT;
    v_replay public.earlybird_v211_concierge_replays%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_source public.analysis_requests%ROWTYPE;
    v_result public.analysis_requests%ROWTYPE;
    v_target TEXT;
    v_artifact_keys TEXT[] := ARRAY[
        'allPublicClassifications', 'resultHash', 'sourceFingerprint',
        'targetEvidenceManifest', 'unknownReviewCsv'
    ];
BEGIN
    v_target := pg_catalog.lower(
        pg_catalog.regexp_replace(pg_catalog.btrim(p_target_instagram_id), '^@', '')
    );

    IF p_order_id IS NULL
       OR p_owner_id IS NULL
       OR p_source_request_id IS NULL
       OR p_first_relationship_request_id IS NULL
       OR p_second_relationship_request_id IS NULL
       OR p_failed_preflight_id IS NULL
       OR p_rearmed_preflight_id IS NULL
       OR p_result_request_id IS NULL
       OR (
            p_source_request_id IN (
                p_first_relationship_request_id, p_second_relationship_request_id,
                p_result_request_id
            )
            AND NOT (
                p_first_relationship_request_id = p_source_request_id
                AND p_second_relationship_request_id = p_source_request_id
            )
       )
       OR (
            p_first_relationship_request_id = p_second_relationship_request_id
            AND p_first_relationship_request_id <> p_source_request_id
       )
       OR p_first_relationship_request_id = p_result_request_id
       OR p_second_relationship_request_id = p_result_request_id
       OR v_target IS NULL
       OR v_target !~ '^[a-z0-9._]{1,30}$'
       OR p_expected_fulfillment_status IS DISTINCT FROM 'analysis_in_progress'
       OR p_expected_fulfillment_attempt_count IS DISTINCT FROM 2
       OR p_exact_mutual IS DISTINCT FROM 150
       OR p_hydrated IS DISTINCT FROM 149
       OR p_public IS DISTINCT FROM 53
       OR p_private IS DISTINCT FROM 96
       OR p_unresolved IS DISTINCT FROM 1
       OR p_source_fingerprint IS NULL
       OR p_source_fingerprint !~ '^[a-f0-9]{64}$'
       OR p_result_hash IS NULL
       OR p_result_hash !~ '^[a-f0-9]{64}$'
       OR p_artifact_hashes IS NULL
       OR pg_catalog.jsonb_typeof(p_artifact_hashes) IS DISTINCT FROM 'object'
       OR p_artifact_hashes - v_artifact_keys <> '{}'::JSONB
       OR NOT p_artifact_hashes ?& v_artifact_keys
       OR p_artifact_hashes->>'sourceFingerprint' IS DISTINCT FROM p_source_fingerprint
       OR p_artifact_hashes->>'resultHash' IS DISTINCT FROM p_result_hash
       OR p_artifact_hashes->>'targetEvidenceManifest' IS NULL
       OR p_artifact_hashes->>'targetEvidenceManifest' !~ '^[a-f0-9]{64}$'
       OR p_artifact_hashes->>'allPublicClassifications'
            IS DISTINCT FROM '47a657f1c534680043e24ca44f9e2eaa16854b55cd34ab65e3bb2a8dee7fa8cb'
       OR p_artifact_hashes->>'unknownReviewCsv'
            IS DISTINCT FROM '1c66ac59cb97a18441c613178a77202f6a9501d22d5de85e561e0208a568e367'
       OR pg_catalog.jsonb_typeof(p_followers) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(p_following) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(p_target_evidence) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(p_publication_payload) IS DISTINCT FROM 'object'
       OR pg_catalog.jsonb_typeof(p_publication_payload->'femaleRows') IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_typeof(p_publication_payload->'privateRows') IS DISTINCT FROM 'array'
       OR p_publication_payload->>'sourceFingerprint' IS DISTINCT FROM p_source_fingerprint
       OR p_publication_payload->>'resultHash' IS DISTINCT FROM p_result_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_INPUT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- The supplied CSV is the reviewed immutable file.  The prior manifest
    -- hash is intentionally not accepted, even if every other field matches.
    IF pg_catalog.jsonb_array_length(p_followers) <> 157
       OR pg_catalog.jsonb_array_length(p_following) <> 361
       OR pg_catalog.jsonb_array_length(p_target_evidence) <> 95 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_RELATIONSHIP_ARTIFACT_MISSING',
            ERRCODE = 'P0001';
    END IF;

    IF pg_catalog.jsonb_array_length(p_publication_payload->'femaleRows') <> 16
       OR pg_catalog.jsonb_array_length(p_publication_payload->'privateRows') <> p_private THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_PUBLICATION_PAYLOAD_INVALID',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_publication_payload->'femaleRows') AS item
        WHERE item->>'suspect_instagram_id' IS NULL
           OR item->>'suspect_instagram_id' !~ '^[a-z0-9._]{1,30}$'
           OR item->>'risk_grade' IS NULL
           OR item->>'risk_grade' NOT IN ('normal', 'caution', 'high_risk')
           OR item->>'gender_status' IS DISTINCT FROM 'confirmed'
           OR item->>'one_line_overview' IS NULL
           OR pg_catalog.char_length(item->>'one_line_overview') NOT BETWEEN 1 AND 180
           OR pg_catalog.jsonb_typeof(item->'risk_analysis') IS DISTINCT FROM 'array'
           OR (item->>'risk_grade' = 'high_risk'
               AND pg_catalog.jsonb_array_length(item->'risk_analysis') <> 2)
           OR (item->>'risk_grade' <> 'high_risk'
               AND pg_catalog.jsonb_array_length(item->'risk_analysis') <> 0)
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_publication_payload->'privateRows') AS item
        WHERE item->>'instagram_id' IS NULL
           OR item->>'instagram_id' !~ '^[a-z0-9._]{1,30}$'
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_PUBLICATION_PAYLOAD_INVALID',
            ERRCODE = 'P0001';
    END IF;
    IF (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_publication_payload->'femaleRows') AS item
    ) <> (
        SELECT pg_catalog.count(DISTINCT item->>'suspect_instagram_id')
        FROM pg_catalog.jsonb_array_elements(p_publication_payload->'femaleRows') AS item
    ) OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_publication_payload->'privateRows') AS item
    ) <> (
        SELECT pg_catalog.count(DISTINCT item->>'instagram_id')
        FROM pg_catalog.jsonb_array_elements(p_publication_payload->'privateRows') AS item
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_PUBLICATION_PAYLOAD_INVALID',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_followers) AS item
        WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR item->>'username' IS NULL
           OR item->>'username' !~ '^[a-z0-9._]{1,30}$'
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_following) AS item
        WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR item->>'username' IS NULL
           OR item->>'username' !~ '^[a-z0-9._]{1,30}$'
    ) OR EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_target_evidence) AS item
        WHERE pg_catalog.jsonb_typeof(item) IS DISTINCT FROM 'object'
           OR item->>'actorUsername' IS NULL
           OR item->>'actorUsername' !~ '^[a-z0-9._]{1,30}$'
           OR item->>'postId' IS NULL
           OR item->>'sourceInteractionId' IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_RELATIONSHIP_ARTIFACT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    IF (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_followers) AS item
    ) <> (
        SELECT pg_catalog.count(DISTINCT item->>'username')
        FROM pg_catalog.jsonb_array_elements(p_followers) AS item
    ) OR (
        SELECT pg_catalog.count(*)
        FROM pg_catalog.jsonb_array_elements(p_following) AS item
    ) <> (
        SELECT pg_catalog.count(DISTINCT item->>'username')
        FROM pg_catalog.jsonb_array_elements(p_following) AS item
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_RELATIONSHIP_ARTIFACT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*) INTO v_intersection_count
    FROM (
        SELECT DISTINCT item->>'username' AS username
        FROM pg_catalog.jsonb_array_elements(p_followers) AS item
    ) AS followers
    JOIN (
        SELECT DISTINCT item->>'username' AS username
        FROM pg_catalog.jsonb_array_elements(p_following) AS item
    ) AS following USING (username);
    IF v_intersection_count <> p_exact_mutual THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_RELATIONSHIP_COUNT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.jsonb_array_elements(p_target_evidence) AS item
        GROUP BY item->>'actorUsername', item->>'postId', item->>'sourceInteractionId'
        HAVING pg_catalog.count(*) > 1
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_TARGET_EVIDENCE_DUPLICATE',
            ERRCODE = 'P0001';
    END IF;

    IF p_exact_mutual <> p_hydrated + p_unresolved
       OR p_hydrated <> p_public + p_private THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BOOTSTRAP_COUNT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    -- This lock is independent from normal admission/rearm locks.  It covers
    -- only the one historical first-paid Basic concierge scope.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'earlybird-v211-concierge-first-paid-basic:2026-08-12', 0
        )
    );

    SELECT pg_catalog.count(*) INTO v_candidate_count
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.plan_id = 'basic'
      AND earlybird_order.status = 'completed'
      AND earlybird_order.paid_at >= '2026-08-12T00:00:00Z'::TIMESTAMPTZ
      AND earlybird_order.paid_at < '2026-08-13T00:00:00Z'::TIMESTAMPTZ
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.expected_amount_krw = 990
      AND earlybird_order.actual_amount_krw = 990
      AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
      AND earlybird_order.actual_groble_product_id
            IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS refund_event
          WHERE refund_event.event_type = 'payment.refunded'
            AND refund_event.payment_id = earlybird_order.payment_id
            AND refund_event.product_id = earlybird_order.actual_groble_product_id
            AND refund_event.amount_krw = earlybird_order.actual_amount_krw
            AND refund_event.refund_amount_krw = earlybird_order.actual_amount_krw
            AND refund_event.partial_refund IS FALSE
      );
    IF v_candidate_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_ORDER_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT source_request.* INTO v_source
    FROM public.analysis_requests AS source_request
    WHERE source_request.id = p_source_request_id
    FOR UPDATE;
    SELECT result_request.* INTO v_result
    FROM public.analysis_requests AS result_request
    WHERE result_request.id = p_result_request_id
    FOR UPDATE;

    -- The order row lock is held before checking all recovery ledgers, so a
    -- concurrent admission/rearm path that uses the order lock cannot race a
    -- zero-row precondition into this one-shot scope.  Resolve the table list
    -- at runtime so minimal contract schemas can still install the function
    -- while production checks every deployed recovery ledger.
    FOREACH v_recovery_table IN ARRAY ARRAY[
        'public.earlybird_v211_apify_transient_replays',
        'public.earlybird_v211_profile_ai_diagnostic_replays',
        'public.earlybird_v211_policy_identity_replays',
        'public.earlybird_v211_relationship_lineage_failure_rearms',
        'public.earlybird_v211_lease_policy_failure_rearms',
        'public.earlybird_schema_failure_recoveries'
    ] LOOP
        IF pg_catalog.to_regclass(v_recovery_table) IS NOT NULL THEN
            EXECUTE pg_catalog.format(
                'SELECT pg_catalog.count(*)::INTEGER FROM %s WHERE order_id = $1',
                v_recovery_table
            ) INTO v_recovery_rows USING p_order_id;
            IF v_recovery_rows <> 0 THEN
                RAISE EXCEPTION USING
                    MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_RECOVERY_SCOPE_CONFLICT',
                    ERRCODE = 'P0001';
            END IF;
        END IF;
    END LOOP;

    IF v_order.id IS NULL
       OR v_order.user_id IS DISTINCT FROM p_owner_id
       OR v_order.preflight_id IS DISTINCT FROM p_rearmed_preflight_id
       OR pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
            IS DISTINCT FROM v_target
       OR v_order.result_request_id IS DISTINCT FROM p_result_request_id
       OR v_order.status IS DISTINCT FROM 'completed'
       OR v_order.plan_id IS DISTINCT FROM 'basic'
       OR v_order.expected_amount_krw IS DISTINCT FROM 990
       OR v_order.actual_amount_krw IS DISTINCT FROM 990
       OR v_order.payment_id IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.exclusion_decision IS DISTINCT FROM 'skip'
       OR v_order.excluded_instagram_id IS NOT NULL
       OR v_order.paid_at < '2026-08-12T00:00:00Z'::TIMESTAMPTZ
       OR v_order.paid_at >= '2026-08-13T00:00:00Z'::TIMESTAMPTZ THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_ORDER_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM public.earlybird_webhook_events AS refund_event
        WHERE refund_event.event_type = 'payment.refunded'
          AND refund_event.payment_id = v_order.payment_id
          AND refund_event.product_id = v_order.actual_groble_product_id
          AND refund_event.amount_krw = v_order.actual_amount_krw
          AND refund_event.refund_amount_krw = v_order.actual_amount_krw
          AND refund_event.partial_refund IS FALSE
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_REFUND_REJECTED',
            ERRCODE = 'P0001';
    END IF;
    IF v_fulfillment.order_id IS NULL
       OR v_fulfillment.status IS DISTINCT FROM p_expected_fulfillment_status
       OR v_fulfillment.attempt_count IS DISTINCT FROM p_expected_fulfillment_attempt_count
       OR v_fulfillment.request_id IS DISTINCT FROM p_source_request_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_FULFILLMENT_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_source.id IS NULL
       OR v_source.user_id IS DISTINCT FROM p_owner_id
       OR v_source.preflight_id IS DISTINCT FROM p_failed_preflight_id
       OR pg_catalog.lower(pg_catalog.btrim(v_source.target_instagram_id))
            IS DISTINCT FROM v_target
       OR v_source.pipeline_version IS DISTINCT FROM 'v2'
       OR v_source.status IS DISTINCT FROM 'failed'
       OR v_result.id IS NULL
       OR v_result.user_id IS DISTINCT FROM p_owner_id
       OR pg_catalog.lower(pg_catalog.btrim(v_result.target_instagram_id))
            IS DISTINCT FROM v_target
       OR v_result.pipeline_version IS DISTINCT FROM 'v1'
       OR v_result.status IS DISTINCT FROM 'completed' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_SOURCE_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF p_first_relationship_request_id = p_source_request_id
       AND p_second_relationship_request_id = p_source_request_id THEN
        -- This historical request persisted both relationship provider runs on
        -- the same failed V2 source request.  Bind that exact request only when
        -- the durable provider ledger proves one succeeded Apify run per side;
        -- never synthesize a pair of failed request IDs.
        IF pg_catalog.to_regclass('public.analysis_v2_provider_runs') IS NULL THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_RELATIONSHIP_SCOPE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        EXECUTE $relationship_runs$
            SELECT CASE WHEN
                count(*) FILTER (
                    WHERE operation_key ~ '^relationship-followers:[a-f0-9]{64}$'
                ) = 1
                AND count(*) FILTER (
                    WHERE operation_key ~ '^relationship-following:[a-f0-9]{64}$'
                ) = 1
                AND count(*) = 2
            THEN 0 ELSE 1 END
            FROM public.analysis_v2_provider_runs
            WHERE request_id = $1
              AND job_key = 'track:relationships:collect'
              AND logical_provider = 'apify'
              AND credential_slot = 'tertiary'
              AND status = 'succeeded'
              AND run_id IS NOT NULL
              AND operation_key ~ '^relationship-(followers|following):[a-f0-9]{64}$'
        $relationship_runs$ INTO v_recovery_rows USING p_source_request_id;
        IF v_recovery_rows <> 0 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_RELATIONSHIP_SCOPE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    ELSIF (
        SELECT pg_catalog.count(*)
        FROM public.analysis_requests AS relationship_request
        WHERE relationship_request.id IN (
            p_first_relationship_request_id, p_second_relationship_request_id
        )
          AND relationship_request.user_id = p_owner_id
          AND relationship_request.preflight_id = p_failed_preflight_id
          AND relationship_request.pipeline_version = 'v2'
          AND relationship_request.status = 'failed'
    ) <> 2 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_RELATIONSHIP_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT replay.* INTO v_replay
    FROM public.earlybird_v211_concierge_replays AS replay
    WHERE replay.order_id = p_order_id
    FOR UPDATE;
    IF FOUND THEN
        IF v_replay.original_failed_request_id IS DISTINCT FROM p_source_request_id
           OR v_replay.first_relationship_failed_request_id
                IS DISTINCT FROM p_first_relationship_request_id
           OR v_replay.second_relationship_failed_request_id
                IS DISTINCT FROM p_second_relationship_request_id
           OR v_replay.failed_preflight_id IS DISTINCT FROM p_failed_preflight_id
           OR v_replay.rearmed_preflight_id IS DISTINCT FROM p_rearmed_preflight_id
           OR v_replay.reviewed_source_owner_id IS DISTINCT FROM p_owner_id
           OR v_replay.reviewed_source_target_instagram_id IS DISTINCT FROM v_target
           OR v_replay.reviewed_source_result_request_id IS DISTINCT FROM p_result_request_id
           OR v_replay.reviewed_source_target_evidence IS DISTINCT FROM p_target_evidence
           OR v_replay.reviewed_source_fingerprint IS DISTINCT FROM p_source_fingerprint
           OR v_replay.published_source_fingerprint IS DISTINCT FROM p_source_fingerprint
           OR v_replay.published_result_hash IS DISTINCT FROM p_result_hash
           OR v_result.step_data->'conciergeBootstrap'->'artifactHashes'
                IS DISTINCT FROM p_artifact_hashes THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_BOOTSTRAP_PUBLICATION_CAS_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'disposition', 'already_published',
            'orderId', p_order_id,
            'resultRequestId', p_result_request_id,
            'sourceFingerprint', p_source_fingerprint,
            'resultHash', p_result_hash
        );
    END IF;
    -- Keep the existing order result pointer and the failed V2 source audit
    -- untouched.  This insert adds only the exact one-shot replay lineage.
    INSERT INTO public.earlybird_v211_concierge_replays (
        order_id, original_failed_request_id,
        first_relationship_failed_request_id, second_relationship_failed_request_id,
        failed_preflight_id, rearmed_preflight_id,
        expected_fulfillment_attempt_count, expected_manual_review_at,
        reviewed_source_request_id, reviewed_source_owner_id,
        reviewed_source_target_instagram_id, reviewed_source_result_request_id,
        reviewed_source_target_posts, reviewed_source_target_evidence,
        reviewed_source_fingerprint, reviewed_source_registered_at,
        published_source_fingerprint, published_result_hash, published_at
    ) VALUES (
        p_order_id, p_source_request_id,
        p_first_relationship_request_id, p_second_relationship_request_id,
        p_failed_preflight_id, p_rearmed_preflight_id,
        -- Existing concierge replay rows intentionally record the single
        -- replay admission attempt.  The deployed fulfillment's current
        -- attempt 2 is bound separately by the guard above; keep the legacy
        -- replay-table check and generic readiness rules unchanged.
        1,
        COALESCE(v_fulfillment.manual_review_at, pg_catalog.clock_timestamp()),
        p_source_request_id, p_owner_id, v_target, p_result_request_id,
        '[]'::JSONB, p_target_evidence, p_source_fingerprint,
        pg_catalog.clock_timestamp(), p_source_fingerprint, p_result_hash,
        pg_catalog.clock_timestamp()
    );

    -- The payload is the already-reviewed V1 publication.  Result rows are
    -- replaced only inside this transaction and only after all scope/CAS
    -- guards above have passed.
    DELETE FROM public.analysis_results
    WHERE request_id = p_result_request_id;
    INSERT INTO public.analysis_results (
        request_id, rank, suspect_instagram_id, suspect_profile_image,
        suspect_full_name, bio, risk_score, risk_grade, gender_status,
        one_line_overview, risk_analysis
    )
    SELECT p_result_request_id, rows.rank, rows.suspect_instagram_id,
           rows.suspect_profile_image, rows.suspect_full_name, rows.bio,
           rows.risk_score, rows.risk_grade, rows.gender_status,
           rows.one_line_overview, rows.risk_analysis
    FROM pg_catalog.jsonb_to_recordset(p_publication_payload->'femaleRows') AS rows(
        rank INTEGER, suspect_instagram_id TEXT, suspect_profile_image TEXT,
        suspect_full_name TEXT, bio TEXT, risk_score INTEGER, risk_grade TEXT,
        gender_status TEXT, one_line_overview TEXT, risk_analysis JSONB
    );
    DELETE FROM public.private_accounts
    WHERE request_id = p_result_request_id;
    INSERT INTO public.private_accounts(request_id, instagram_id, profile_image, full_name)
    SELECT p_result_request_id, rows.instagram_id, rows.profile_image, rows.full_name
    FROM pg_catalog.jsonb_to_recordset(p_publication_payload->'privateRows') AS rows(
        instagram_id TEXT, profile_image TEXT, full_name TEXT
    );

    UPDATE public.analysis_requests
    SET mutual_follows = p_exact_mutual,
        step_data = pg_catalog.jsonb_set(
            CASE WHEN pg_catalog.jsonb_typeof(step_data) = 'object'
                 THEN step_data ELSE '{}'::JSONB END,
            '{conciergeBootstrap}',
            pg_catalog.jsonb_build_object(
                'exactMutual', p_exact_mutual, 'hydrated', p_hydrated,
                'public', p_public, 'private', p_private,
                'unresolved', p_unresolved,
                'sourceFingerprint', p_source_fingerprint,
                'resultHash', p_result_hash,
                'artifactHashes', p_artifact_hashes
            ), TRUE
        )
    WHERE id = p_result_request_id;

    RETURN pg_catalog.jsonb_build_object(
        'disposition', 'published',
        'orderId', p_order_id,
        'resultRequestId', p_result_request_id,
        'sourceFingerprint', p_source_fingerprint,
        'resultHash', p_result_hash
    );
END;
$$;

REVOKE ALL ON FUNCTION public.bootstrap_earlybird_v211_concierge_first_order(
    UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, SMALLINT,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, JSONB, JSONB,
    JSONB, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_earlybird_v211_concierge_first_order(
    UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, SMALLINT,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, JSONB, JSONB,
    JSONB, JSONB, JSONB
) TO service_role;

DO $final_guard$
DECLARE
    v_signature TEXT :=
        'public.bootstrap_earlybird_v211_concierge_first_order(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,smallint,integer,integer,integer,integer,integer,text,text,jsonb,jsonb,jsonb,jsonb,jsonb)';
BEGIN
    IF pg_catalog.has_function_privilege('anon', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('authenticated', v_signature, 'EXECUTE')
       OR pg_catalog.has_function_privilege('service_role', v_signature, 'EXECUTE') IS FALSE THEN
        RAISE EXCEPTION 'CONCIERGE_FIRST_ORDER_BOOTSTRAP_ACL_MISMATCH';
    END IF;
END;
$final_guard$;

COMMENT ON FUNCTION public.bootstrap_earlybird_v211_concierge_first_order(
    UUID, UUID, UUID, UUID, UUID, UUID, UUID, UUID, TEXT, TEXT, SMALLINT,
    INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, TEXT, TEXT, JSONB, JSONB,
    JSONB, JSONB, JSONB
) IS 'One-shot service-role-only bootstrap/publication for the exact first paid non-refunded 2026-08-12 Basic concierge order; rejects absent relationship evidence and does not broaden admission or rearm rules.';

COMMIT;
