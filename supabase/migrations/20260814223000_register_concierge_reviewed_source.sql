-- MIGRATION_PREDECESSOR=20260814220000
-- Register the exact reviewed correction snapshot on the existing immutable
-- concierge replay row.  This is deliberately not a new retention table: the
-- row is already order-scoped, service-role-only, and tied to the V2 replay.
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
                WHERE version = '20260814220000'
            )
        $sql$ INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_REVIEWED_SOURCE_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$migration$;

ALTER TABLE public.earlybird_v211_concierge_replays
    ADD COLUMN reviewed_source_request_id UUID,
    ADD COLUMN reviewed_source_owner_id UUID,
    ADD COLUMN reviewed_source_target_instagram_id TEXT,
    ADD COLUMN reviewed_source_result_request_id UUID,
    ADD COLUMN reviewed_source_target_posts JSONB,
    ADD COLUMN reviewed_source_target_evidence JSONB,
    ADD COLUMN reviewed_source_fingerprint VARCHAR(64),
    ADD COLUMN reviewed_source_registered_at TIMESTAMP WITH TIME ZONE,
    ADD COLUMN published_source_fingerprint VARCHAR(64),
    ADD COLUMN published_result_hash VARCHAR(64),
    ADD COLUMN published_at TIMESTAMP WITH TIME ZONE;

ALTER TABLE public.earlybird_v211_concierge_replays
    ADD CONSTRAINT earlybird_v211_concierge_reviewed_source_shape_check CHECK (
        (
            reviewed_source_fingerprint IS NULL
            AND reviewed_source_request_id IS NULL
            AND reviewed_source_owner_id IS NULL
            AND reviewed_source_target_instagram_id IS NULL
            AND reviewed_source_result_request_id IS NULL
            AND reviewed_source_target_posts IS NULL
            AND reviewed_source_target_evidence IS NULL
            AND reviewed_source_registered_at IS NULL
        )
        OR (
            reviewed_source_fingerprint ~ '^[a-f0-9]{64}$'
            AND reviewed_source_request_id IS NOT NULL
            AND reviewed_source_owner_id IS NOT NULL
            AND reviewed_source_target_instagram_id ~ '^[a-z0-9._]{1,30}$'
            AND reviewed_source_result_request_id IS NOT NULL
            AND pg_catalog.jsonb_typeof(reviewed_source_target_posts) = 'array'
            AND pg_catalog.jsonb_typeof(reviewed_source_target_evidence) = 'array'
            AND reviewed_source_registered_at IS NOT NULL
        )
    ),
    ADD CONSTRAINT earlybird_v211_concierge_publication_marker_check CHECK (
        (
            published_source_fingerprint IS NULL
            AND published_result_hash IS NULL
            AND published_at IS NULL
        )
        OR (
            published_source_fingerprint ~ '^[a-f0-9]{64}$'
            AND published_result_hash ~ '^[a-f0-9]{64}$'
            AND published_at IS NOT NULL
        )
    );

-- The original replay row is immutable.  Permit exactly one append-only
-- reviewed-source registration, and only from the SECURITY DEFINER RPC below.
DROP TRIGGER IF EXISTS prevent_earlybird_v211_concierge_replay_mutation
    ON public.earlybird_v211_concierge_replays;

CREATE FUNCTION public.prevent_earlybird_v211_concierge_replay_mutation_v2()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'UPDATE'
       AND (
            (
                OLD.reviewed_source_fingerprint IS NULL
                AND NEW.reviewed_source_fingerprint IS NOT NULL
                AND NEW.reviewed_source_registered_at IS NOT NULL
                AND pg_catalog.current_setting(
                    'app.earlybird_v211_concierge_reviewed_source_register', TRUE
                ) = '1'
                AND OLD.published_source_fingerprint IS NULL
                AND OLD.published_result_hash IS NULL
                AND OLD.published_at IS NULL
            )
            OR (
                OLD.reviewed_source_fingerprint IS NOT NULL
                AND NEW.reviewed_source_fingerprint IS NOT DISTINCT FROM OLD.reviewed_source_fingerprint
                AND OLD.published_source_fingerprint IS NULL
                AND NEW.published_source_fingerprint IS NOT NULL
                AND NEW.published_result_hash IS NOT NULL
                AND NEW.published_at IS NOT NULL
                AND OLD.reviewed_source_request_id IS NOT DISTINCT FROM NEW.reviewed_source_request_id
                AND OLD.reviewed_source_owner_id IS NOT DISTINCT FROM NEW.reviewed_source_owner_id
                AND OLD.reviewed_source_target_instagram_id
                    IS NOT DISTINCT FROM NEW.reviewed_source_target_instagram_id
                AND OLD.reviewed_source_result_request_id
                    IS NOT DISTINCT FROM NEW.reviewed_source_result_request_id
                AND OLD.reviewed_source_target_posts
                    IS NOT DISTINCT FROM NEW.reviewed_source_target_posts
                AND OLD.reviewed_source_target_evidence
                    IS NOT DISTINCT FROM NEW.reviewed_source_target_evidence
                AND OLD.reviewed_source_registered_at
                    IS NOT DISTINCT FROM NEW.reviewed_source_registered_at
                AND pg_catalog.current_setting(
                    'app.earlybird_v211_concierge_publication_marker', TRUE
                ) = '1'
            )
       )
       AND OLD.order_id IS NOT DISTINCT FROM NEW.order_id
       AND OLD.original_failed_request_id IS NOT DISTINCT FROM NEW.original_failed_request_id
       AND OLD.first_relationship_failed_request_id
            IS NOT DISTINCT FROM NEW.first_relationship_failed_request_id
       AND OLD.second_relationship_failed_request_id
            IS NOT DISTINCT FROM NEW.second_relationship_failed_request_id
       AND OLD.failed_preflight_id IS NOT DISTINCT FROM NEW.failed_preflight_id
       AND OLD.rearmed_preflight_id IS NOT DISTINCT FROM NEW.rearmed_preflight_id
       AND OLD.expected_fulfillment_attempt_count
            IS NOT DISTINCT FROM NEW.expected_fulfillment_attempt_count
       AND OLD.expected_manual_review_at
            IS NOT DISTINCT FROM NEW.expected_manual_review_at
       AND OLD.created_at IS NOT DISTINCT FROM NEW.created_at
       THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER prevent_earlybird_v211_concierge_replay_mutation_v2
BEFORE UPDATE OR DELETE ON public.earlybird_v211_concierge_replays
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_v211_concierge_replay_mutation_v2();

REVOKE ALL ON FUNCTION public.prevent_earlybird_v211_concierge_replay_mutation_v2()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.register_earlybird_v211_concierge_reviewed_source(
    p_order_id UUID,
    p_source_request_id UUID,
    p_result_request_id UUID,
    p_owner_id UUID,
    p_target_instagram_id TEXT,
    p_source_fingerprint TEXT,
    p_target_posts JSONB,
    p_target_evidence JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_replay public.earlybird_v211_concierge_replays%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_source public.analysis_requests%ROWTYPE;
    v_result public.analysis_requests%ROWTYPE;
    v_target TEXT;
BEGIN
    v_target := pg_catalog.lower(
        pg_catalog.regexp_replace(pg_catalog.btrim(p_target_instagram_id), '^@', '')
    );
    IF p_order_id IS NULL
       OR p_source_request_id IS NULL
       OR p_result_request_id IS NULL
       OR p_owner_id IS NULL
       OR v_target !~ '^[a-z0-9._]{1,30}$'
       OR p_source_fingerprint IS NULL
       OR p_source_fingerprint !~ '^[a-f0-9]{64}$'
       OR pg_catalog.jsonb_typeof(p_target_posts) <> 'array'
       OR pg_catalog.jsonb_typeof(p_target_evidence) <> 'array'
       OR pg_catalog.jsonb_array_length(p_target_posts) > 8
       OR pg_catalog.jsonb_array_length(p_target_evidence) > 95
       OR pg_catalog.octet_length(p_target_posts::TEXT) > 200000
       OR pg_catalog.octet_length(p_target_evidence::TEXT) > 300000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REVIEWED_SOURCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT replay.*
      INTO v_replay
    FROM public.earlybird_v211_concierge_replays AS replay
    WHERE replay.order_id = p_order_id
    FOR UPDATE;
    SELECT earlybird_order.*
      INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    SELECT source_request.*
      INTO v_source
    FROM public.analysis_requests AS source_request
    WHERE source_request.id = p_source_request_id;
    SELECT result_request.*
      INTO v_result
    FROM public.analysis_requests AS result_request
    WHERE result_request.id = p_result_request_id;

    IF v_replay.order_id IS NULL
       OR v_replay.original_failed_request_id IS DISTINCT FROM p_source_request_id
       OR v_order.id IS NULL
       OR v_order.user_id IS DISTINCT FROM p_owner_id
       OR pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id)) IS DISTINCT FROM v_target
       OR v_order.result_request_id IS DISTINCT FROM p_result_request_id
       OR v_order.status <> 'completed'
       OR v_order.plan_id <> 'basic'
       OR v_source.id IS NULL
       OR v_source.user_id IS DISTINCT FROM p_owner_id
       OR v_source.pipeline_version <> 'v2'
       OR v_source.status <> 'failed'
       OR v_result.id IS NULL
       OR v_result.user_id IS DISTINCT FROM p_owner_id
       OR pg_catalog.lower(pg_catalog.btrim(v_result.target_instagram_id)) IS DISTINCT FROM v_target
       OR v_result.pipeline_version <> 'v1'
       OR v_result.status <> 'completed' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REVIEWED_SOURCE_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    IF v_replay.reviewed_source_fingerprint IS NOT NULL THEN
        IF v_replay.reviewed_source_fingerprint = p_source_fingerprint
           AND v_replay.reviewed_source_request_id = p_source_request_id
           AND v_replay.reviewed_source_owner_id = p_owner_id
           AND v_replay.reviewed_source_target_instagram_id = v_target
           AND v_replay.reviewed_source_result_request_id = p_result_request_id
           AND v_replay.reviewed_source_target_posts = p_target_posts
           AND v_replay.reviewed_source_target_evidence = p_target_evidence THEN
            RETURN pg_catalog.jsonb_build_object(
                'registered', TRUE,
                'sourceFingerprint', p_source_fingerprint
            );
        END IF;
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_REVIEWED_SOURCE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    PERFORM pg_catalog.set_config(
        'app.earlybird_v211_concierge_reviewed_source_register', '1', TRUE
    );
    UPDATE public.earlybird_v211_concierge_replays
       SET reviewed_source_request_id = p_source_request_id,
           reviewed_source_owner_id = p_owner_id,
           reviewed_source_target_instagram_id = v_target,
           reviewed_source_result_request_id = p_result_request_id,
           reviewed_source_target_posts = p_target_posts,
           reviewed_source_target_evidence = p_target_evidence,
           reviewed_source_fingerprint = p_source_fingerprint,
           reviewed_source_registered_at = pg_catalog.clock_timestamp()
     WHERE order_id = p_order_id;
    PERFORM pg_catalog.set_config(
        'app.earlybird_v211_concierge_reviewed_source_register', '0', TRUE
    );

    RETURN pg_catalog.jsonb_build_object(
        'registered', TRUE,
        'sourceFingerprint', p_source_fingerprint
    );
END;
$$;

REVOKE ALL ON FUNCTION public.register_earlybird_v211_concierge_reviewed_source(
    UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.register_earlybird_v211_concierge_reviewed_source(
    UUID, UUID, UUID, UUID, TEXT, TEXT, JSONB, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.read_earlybird_v211_concierge_result_source(
    p_order_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_replay public.earlybird_v211_concierge_replays%ROWTYPE;
    v_source_request_id UUID;
    v_match_count INTEGER;
BEGIN
    IF p_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_INVALID',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
      INTO v_match_count
    FROM public.earlybird_v211_concierge_replays AS replay
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = replay.order_id
    JOIN public.analysis_requests AS source_request
      ON source_request.id = replay.original_failed_request_id
    JOIN public.analysis_preflights AS source_preflight
      ON source_preflight.id = source_request.preflight_id
    JOIN public.analysis_preflights AS current_preflight
      ON current_preflight.id = replay.rearmed_preflight_id
     AND current_preflight.id = earlybird_order.preflight_id
    WHERE replay.order_id = p_order_id
      AND source_request.user_id = earlybird_order.user_id
      AND source_preflight.user_id = earlybird_order.user_id
      AND source_preflight.target_instagram_id = 'retained.'
          || pg_catalog.substr(
              pg_catalog.replace(source_preflight.id::TEXT, '-', ''), 1, 20
          )
      AND current_preflight.user_id = earlybird_order.user_id
      AND source_request.pipeline_version = 'v2'
      AND source_request.status = 'failed';

    IF v_match_count <> 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_V211_CONCIERGE_SOURCE_SCOPE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT replay.*
      INTO v_replay
    FROM public.earlybird_v211_concierge_replays AS replay
    WHERE replay.order_id = p_order_id;
    v_source_request_id := v_replay.original_failed_request_id;
    IF v_replay.reviewed_source_fingerprint IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'sourceRequestId', v_source_request_id::TEXT
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'sourceRequestId', v_source_request_id::TEXT,
        'reviewedSource', pg_catalog.jsonb_build_object(
            'ownerId', v_replay.reviewed_source_owner_id::TEXT,
            'targetUsername', v_replay.reviewed_source_target_instagram_id,
            'resultRequestId', v_replay.reviewed_source_result_request_id::TEXT,
            'targetPosts', v_replay.reviewed_source_target_posts,
            'targetEvidence', v_replay.reviewed_source_target_evidence,
            'sourceFingerprint', v_replay.reviewed_source_fingerprint
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_earlybird_v211_concierge_result_source(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_earlybird_v211_concierge_result_source(UUID)
    TO service_role;

COMMIT;
