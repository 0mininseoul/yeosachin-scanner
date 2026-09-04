-- MIGRATION_PREDECESSOR=20260904110000
-- Permanent, order-keyed audit evidence. The execution tables remain the source of truth while
-- this aggregate keeps a bounded, append-only copy that survives terminal working-set cleanup.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $migration$
DECLARE
    v_predecessor_present BOOLEAN := FALSE;
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL THEN
        SELECT EXISTS (
            SELECT 1
            FROM supabase_migrations.schema_migrations
            WHERE version = '20260904110000'
        ) INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_PREDECESSOR_MISSING', ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE TABLE public.analysis_order_audit_assembly_queue (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    status VARCHAR(16) NOT NULL DEFAULT 'queued',
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    last_error_code VARCHAR(96),
    last_error_at TIMESTAMPTZ,
    purge_fenced_at TIMESTAMPTZ,
    purge_fence_reason VARCHAR(96),
    purged_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_order_audit_queue_status_check CHECK (
        status IN ('queued', 'processing', 'completed', 'failed')
    ),
    CONSTRAINT analysis_order_audit_queue_attempt_check CHECK (
        attempt_count BETWEEN 0 AND 1000
    ),
    CONSTRAINT analysis_order_audit_queue_lease_check CHECK (
        (lease_token IS NULL) = (lease_expires_at IS NULL)
    )
);

CREATE TABLE public.analysis_order_audit_bundles (
    request_id UUID NOT NULL,
    version INTEGER NOT NULL,
    bundle_hash VARCHAR(64) NOT NULL,
    previous_version_hash VARCHAR(64),
    source_set_hash VARCHAR(64) NOT NULL,
    pipeline_version VARCHAR(32) NOT NULL,
    pipeline_policy JSONB NOT NULL DEFAULT '{}'::JSONB,
    risk_policy_version VARCHAR(64),
    ai_policy_version VARCHAR(64),
    scheduler_policy_version VARCHAR(64),
    plan_id VARCHAR(16) NOT NULL,
    access_mode VARCHAR(32) NOT NULL,
    order_id UUID,
    preflight_id UUID,
    target_instagram_id VARCHAR(30),
    target_profile_available BOOLEAN NOT NULL,
    target_posts_available BOOLEAN NOT NULL,
    target_post_count INTEGER,
    followers_declared INTEGER,
    followers_collected INTEGER,
    following_declared INTEGER,
    following_collected INTEGER,
    mutual_total INTEGER NOT NULL,
    mutual_list_hash VARCHAR(64) NOT NULL,
    public_total INTEGER NOT NULL,
    private_total INTEGER NOT NULL,
    screened_total INTEGER NOT NULL,
    candidate_declared INTEGER NOT NULL,
    candidate_collected INTEGER NOT NULL,
    interaction_declared INTEGER NOT NULL,
    interaction_collected INTEGER NOT NULL,
    target_likes_declared INTEGER,
    target_likes_collected INTEGER,
    target_comments_declared INTEGER,
    target_comments_collected INTEGER,
    candidate_likes_declared INTEGER,
    candidate_likes_collected INTEGER,
    candidate_likes_evidence_collected INTEGER,
    tags_declared INTEGER,
    tags_collected INTEGER,
    mentions_declared INTEGER,
    mentions_collected INTEGER,
    candidate_key_coverage JSONB NOT NULL DEFAULT '{}'::JSONB,
    provider_runs JSONB NOT NULL DEFAULT '[]'::JSONB,
    stage_status JSONB NOT NULL DEFAULT '{}'::JSONB,
    completeness_status VARCHAR(16) NOT NULL,
    gap_codes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    cost_currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    cost_status VARCHAR(16) NOT NULL,
    cost_known_usd NUMERIC(18, 12),
    cost_conservative_usd NUMERIC(18, 12),
    total_known_cost_usd NUMERIC(18, 12),
    total_conservative_cost_usd NUMERIC(18, 12),
    cost_usage_unknown BOOLEAN NOT NULL,
    usage_unknown BOOLEAN NOT NULL,
    cost_missing_source_codes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    cost_provenance JSONB NOT NULL DEFAULT '{}'::JSONB,
    assembled_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, version),
    UNIQUE (request_id, bundle_hash),
    UNIQUE (request_id, source_set_hash),
    CONSTRAINT analysis_order_audit_bundle_version_check CHECK (
        version BETWEEN 1 AND 100000
    ),
    CONSTRAINT analysis_order_audit_bundle_hash_check CHECK (
        bundle_hash ~ '^[a-f0-9]{64}$'
        AND source_set_hash ~ '^[a-f0-9]{64}$'
        AND (
            previous_version_hash IS NULL
            OR previous_version_hash ~ '^[a-f0-9]{64}$'
        )
    ),
    CONSTRAINT analysis_order_audit_bundle_pipeline_check CHECK (
        pipeline_version = 'v2'
    ),
    CONSTRAINT analysis_order_audit_bundle_plan_check CHECK (
        plan_id IN ('basic', 'standard', 'plus')
    ),
    CONSTRAINT analysis_order_audit_bundle_access_check CHECK (
        access_mode IN ('production', 'test_entitlement')
    ),
    CONSTRAINT analysis_order_audit_bundle_count_check CHECK (
        mutual_total >= 0
        AND public_total >= 0
        AND private_total >= 0
        AND public_total + private_total = mutual_total
        AND screened_total >= 0
        AND candidate_declared >= 0
        AND candidate_collected >= 0
        AND interaction_declared >= 0
        AND interaction_collected >= 0
        AND (target_likes_declared IS NULL OR target_likes_declared >= 0)
        AND (target_likes_collected IS NULL OR target_likes_collected >= 0)
        AND (target_comments_declared IS NULL OR target_comments_declared >= 0)
        AND (target_comments_collected IS NULL OR target_comments_collected >= 0)
        AND (candidate_likes_declared IS NULL OR candidate_likes_declared >= 0)
        AND (candidate_likes_collected IS NULL OR candidate_likes_collected >= 0)
        AND (candidate_likes_evidence_collected IS NULL OR candidate_likes_evidence_collected >= 0)
        AND (tags_declared IS NULL OR tags_declared >= 0)
        AND (tags_collected IS NULL OR tags_collected >= 0)
        AND (mentions_declared IS NULL OR mentions_declared >= 0)
        AND (mentions_collected IS NULL OR mentions_collected >= 0)
    ),
    CONSTRAINT analysis_order_audit_bundle_completeness_check CHECK (
        completeness_status IN ('complete', 'partial', 'inconsistent', 'failed')
    ),
    CONSTRAINT analysis_order_audit_bundle_cost_status_check CHECK (
        cost_status IN ('complete', 'partial', 'unknown', 'not_available')
    ),
    CONSTRAINT analysis_order_audit_bundle_cost_check CHECK (
        (cost_known_usd IS NULL OR cost_known_usd >= 0)
        AND (cost_conservative_usd IS NULL OR cost_conservative_usd >= 0)
        AND (total_known_cost_usd IS NULL OR total_known_cost_usd >= 0)
        AND (total_conservative_cost_usd IS NULL OR total_conservative_cost_usd >= 0)
    ),
    CONSTRAINT analysis_order_audit_bundle_json_check CHECK (
        pg_catalog.jsonb_typeof(pipeline_policy) = 'object'
        AND pg_catalog.jsonb_typeof(provider_runs) = 'array'
        AND pg_catalog.jsonb_typeof(stage_status) = 'object'
        AND pg_catalog.jsonb_typeof(candidate_key_coverage) = 'object'
        AND pg_catalog.jsonb_typeof(cost_provenance) IN ('object', 'array')
    )
);

CREATE TABLE public.analysis_order_audit_candidates (
    request_id UUID NOT NULL,
    version INTEGER NOT NULL,
    candidate_id VARCHAR(128) NOT NULL,
    username VARCHAR(30) NOT NULL,
    mutual_ordinal INTEGER,
    following_ordinal INTEGER,
    is_private BOOLEAN NOT NULL,
    is_verified BOOLEAN NOT NULL,
    profile_available BOOLEAN NOT NULL,
    profile_image_available BOOLEAN NOT NULL,
    profile_failure_code VARCHAR(64),
    initial_gender_output VARCHAR(16),
    initial_gender_model VARCHAR(100),
    initial_gender_confidence VARCHAR(16),
    initial_gender_reason VARCHAR(160),
    final_gender_output VARCHAR(16),
    final_gender_model VARCHAR(100),
    final_gender_confidence VARCHAR(16),
    final_gender_reason VARCHAR(160),
    gender_operation_key VARCHAR(128),
    gender_result_hash VARCHAR(64),
    gender_resolution_operation_key VARCHAR(128),
    gender_resolution_result_hash VARCHAR(64),
    feature_operation_key VARCHAR(128),
    feature_result_hash VARCHAR(64),
    evidence_checkpoint_ids TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    account_context VARCHAR(32) NOT NULL DEFAULT 'uncertain',
    final_inclusion_state VARCHAR(16) NOT NULL,
    risk_components JSONB,
    risk_formula_version VARCHAR(64),
    pre_score NUMERIC(8, 4),
    raw_score NUMERIC(8, 4),
    public_score NUMERIC(8, 4),
    final_score NUMERIC(8, 4),
    risk_band VARCHAR(16),
    final_rank INTEGER,
    featured_rank INTEGER,
    recent_mutual_rank INTEGER,
    partner_safety_operation_key VARCHAR(128),
    partner_safety_result_hash VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, version, candidate_id),
    UNIQUE (request_id, version, username),
    FOREIGN KEY (request_id, version)
        REFERENCES public.analysis_order_audit_bundles(request_id, version)
        ON DELETE CASCADE,
    CONSTRAINT analysis_order_audit_candidate_id_check CHECK (
        candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'
    ),
    CONSTRAINT analysis_order_audit_candidate_username_check CHECK (
        username ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_order_audit_candidate_gender_check CHECK (
        (initial_gender_output IS NULL OR initial_gender_output IN ('female', 'male', 'unknown', 'unavailable'))
        AND (final_gender_output IS NULL OR final_gender_output IN ('female', 'male', 'unknown', 'unavailable'))
        AND (initial_gender_confidence IS NULL OR initial_gender_confidence IN ('low', 'medium', 'high'))
        AND (final_gender_confidence IS NULL OR final_gender_confidence IN ('low', 'medium', 'high'))
    ),
    CONSTRAINT analysis_order_audit_candidate_context_check CHECK (
        account_context IN ('personal', 'individual_creator', 'official_group_or_brand', 'uncertain')
    ),
    CONSTRAINT analysis_order_audit_candidate_inclusion_check CHECK (
        final_inclusion_state IN ('included', 'excluded', 'private', 'unknown', 'unavailable')
    ),
    CONSTRAINT analysis_order_audit_candidate_score_check CHECK (
        (risk_components IS NULL OR pg_catalog.jsonb_typeof(risk_components) = 'object')
        AND (pre_score IS NULL OR pre_score BETWEEN 0 AND 100)
        AND (raw_score IS NULL OR raw_score BETWEEN 0 AND 100)
        AND (public_score IS NULL OR public_score BETWEEN 1 AND 10)
        AND (final_score IS NULL OR final_score BETWEEN 1 AND 10)
        AND (risk_band IS NULL OR risk_band IN ('normal', 'caution', 'high_risk'))
        AND (final_rank IS NULL OR final_rank BETWEEN 1 AND 1200)
        AND (featured_rank IS NULL OR featured_rank BETWEEN 1 AND 100)
        AND (recent_mutual_rank IS NULL OR recent_mutual_rank BETWEEN 1 AND 100)
    )
);

CREATE TABLE public.analysis_order_audit_interactions (
    request_id UUID NOT NULL,
    version INTEGER NOT NULL,
    ordinal INTEGER NOT NULL,
    candidate_id VARCHAR(128),
    username VARCHAR(30),
    signal VARCHAR(32) NOT NULL,
    source_post_id VARCHAR(255),
    evidence_id VARCHAR(255) NOT NULL,
    occurred_at VARCHAR(64),
    comment_text VARCHAR(1000),
    details JSONB,
    reverse_like_status VARCHAR(16),
    reverse_component_score NUMERIC(3, 1),
    completeness_status VARCHAR(16) NOT NULL DEFAULT 'complete',
    gap_codes TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, version, ordinal),
    FOREIGN KEY (request_id, version)
        REFERENCES public.analysis_order_audit_bundles(request_id, version)
        ON DELETE CASCADE,
    CONSTRAINT analysis_order_audit_interaction_ordinal_check CHECK (
        ordinal BETWEEN 1 AND 100000
    ),
    CONSTRAINT analysis_order_audit_interaction_candidate_check CHECK (
        candidate_id IS NULL OR candidate_id ~ '^[A-Za-z0-9._:-]{1,128}$'
    ),
    CONSTRAINT analysis_order_audit_interaction_username_check CHECK (
        username IS NULL OR username ~ '^[a-z0-9._]{1,30}$'
    ),
    CONSTRAINT analysis_order_audit_interaction_signal_check CHECK (
        signal IN ('target_post_like', 'target_post_comment', 'candidate_post_like', 'tag', 'mention')
    ),
    CONSTRAINT analysis_order_audit_interaction_id_check CHECK (
        pg_catalog.char_length(evidence_id) BETWEEN 1 AND 255
        AND evidence_id !~ '[[:cntrl:]]'
        AND (source_post_id IS NULL OR (
            pg_catalog.char_length(source_post_id) BETWEEN 1 AND 255
            AND source_post_id !~ '[[:cntrl:]]'
        ))
    ),
    CONSTRAINT analysis_order_audit_interaction_text_check CHECK (
        comment_text IS NULL OR (
            pg_catalog.char_length(comment_text) BETWEEN 1 AND 1000
            AND pg_catalog.octet_length(comment_text) <= 4000
            AND comment_text !~ '[[:cntrl:]]'
            AND comment_text !~ '[<>]'
        )
    ),
    CONSTRAINT analysis_order_audit_interaction_status_check CHECK (
        completeness_status IN ('complete', 'partial', 'unknown')
    ),
    CONSTRAINT analysis_order_audit_interaction_reverse_check CHECK (
        (reverse_like_status IS NULL AND reverse_component_score IS NULL)
        OR (
            signal = 'candidate_post_like'
            AND reverse_like_status IN ('observed', 'not_observed', 'not_collected')
            AND reverse_component_score IN (0, 3)
        )
    ),
    CONSTRAINT analysis_order_audit_interaction_json_check CHECK (
        details IS NULL OR pg_catalog.jsonb_typeof(details) = 'object'
    )
);

CREATE INDEX analysis_order_audit_bundles_latest_idx
    ON public.analysis_order_audit_bundles(request_id, version DESC);
CREATE INDEX analysis_order_audit_candidates_page_idx
    ON public.analysis_order_audit_candidates(request_id, version, mutual_ordinal, candidate_id);
CREATE INDEX analysis_order_audit_interactions_page_idx
    ON public.analysis_order_audit_interactions(request_id, version, ordinal);
CREATE INDEX analysis_order_audit_queue_recovery_idx
    ON public.analysis_order_audit_assembly_queue(status, next_attempt_at, updated_at);

ALTER TABLE public.analysis_order_audit_assembly_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_order_audit_assembly_queue FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_order_audit_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_order_audit_bundles FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_order_audit_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_order_audit_candidates FORCE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_order_audit_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_order_audit_interactions FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.analysis_order_audit_assembly_queue
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_order_audit_bundles
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_order_audit_candidates
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.analysis_order_audit_interactions
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_order_audit_bundles IS
    'Permanent service-only immutable per-order audit parents. No request FK intentionally: execution rows may be purged after this copy is committed.';
COMMENT ON TABLE public.analysis_order_audit_candidates IS
    'Normalized, versioned candidate evidence for authorized operator audit pages; profile media bytes and URLs are never copied.';
COMMENT ON TABLE public.analysis_order_audit_interactions IS
    'Normalized, versioned interaction evidence. Comment text is retained only in this operator-authorized audit copy.';

CREATE OR REPLACE FUNCTION public.analysis_order_audit_digest(p_value TEXT)
RETURNS VARCHAR(64)
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(pg_catalog.convert_to(p_value, 'UTF8'), 'sha256'),
        'hex'
    );
$$;

CREATE OR REPLACE FUNCTION public.prevent_analysis_order_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'ANALYSIS_ORDER_AUDIT_IMMUTABLE', ERRCODE = 'P0001';
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_order_audit_redact_json(
    p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
DECLARE
    v_type TEXT := pg_catalog.jsonb_typeof(p_value);
    v_result JSONB;
BEGIN
    IF v_type = 'object' THEN
        SELECT COALESCE(pg_catalog.jsonb_object_agg(entry.key,
            public.analysis_order_audit_redact_json(entry.value)), '{}'::JSONB)
          INTO v_result
          FROM pg_catalog.jsonb_each(p_value) AS entry(key, value)
         WHERE pg_catalog.lower(entry.key) NOT IN (
             'userid', 'user_id', 'providertoken', 'provider_token',
             'accesstoken', 'access_token', 'cookie', 'authorization',
             'requestid', 'request_id', 'orderid', 'order_id',
             'preflightid', 'preflight_id', 'actor', 'secret', 'token',
             'useruuid', 'user_uuid',
             'ownerid', 'owner_id', 'actorid', 'actor_id',
             'provideraccountid', 'provider_account_id', 'provideraccount',
             'provider_account', 'accountid', 'account_id', 'account', 'owner',
             'raw_payload', 'rawpayload', 'raw', 'raw_data', 'rawdata', 'provider_payload',
             'providerpayload', 'provider_response', 'providerresponse', 'job_claim_token',
             'jobclaimtoken', 'claim_token', 'claimtoken', 'reservation_token',
             'reservationtoken', 'session', 'session_id', 'sessionid',
             'producer_claim_token', 'producerclaimtoken'
         );
        RETURN v_result;
    END IF;
    IF v_type = 'array' THEN
        SELECT COALESCE(pg_catalog.jsonb_agg(
            public.analysis_order_audit_redact_json(entry.value)
            ORDER BY entry.ordinality
        ), '[]'::JSONB)
          INTO v_result
          FROM pg_catalog.jsonb_array_elements(p_value)
            WITH ORDINALITY AS entry(value, ordinality);
        RETURN v_result;
    END IF;
    RETURN p_value;
END;
$$;

-- Candidate completeness is a set property, not a count property. This bounded helper exposes
-- the expected mutual username keys and the observed feature/private keys so the assembler can
-- preserve both missing and extra rows in its immutable version metadata.
CREATE OR REPLACE FUNCTION public.analysis_order_audit_candidate_key_coverage(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
    WITH selected_relationship AS (
        SELECT manifest.job_key
        FROM public.analysis_v2_relationship_manifests AS manifest
        WHERE manifest.request_id = p_request_id
        ORDER BY manifest.updated_at DESC NULLS LAST, manifest.job_key DESC
        LIMIT 1
    ),
    expected AS (
        SELECT DISTINCT mutual.username
        FROM public.analysis_v2_mutual_rows AS mutual
        WHERE mutual.request_id = p_request_id
          AND (
              NOT EXISTS (SELECT 1 FROM selected_relationship)
              OR mutual.job_key = (SELECT job_key FROM selected_relationship)
          )
    ),
    observed AS (
        SELECT DISTINCT feature.instagram_id AS username
        FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
        UNION
        SELECT DISTINCT private_name.instagram_id AS username
        FROM public.analysis_v2_private_name_rows AS private_name
        WHERE private_name.request_id = p_request_id
    ),
    missing AS (
        SELECT expected.username FROM expected
        EXCEPT SELECT observed.username FROM observed
    ),
    extra AS (
        SELECT observed.username FROM observed
        EXCEPT SELECT expected.username FROM expected
    )
    SELECT pg_catalog.jsonb_build_object(
        'expected', COALESCE((
            SELECT pg_catalog.jsonb_agg(username ORDER BY username) FROM expected
        ), '[]'::JSONB),
        'observed', COALESCE((
            SELECT pg_catalog.jsonb_agg(username ORDER BY username) FROM observed
        ), '[]'::JSONB),
        'missing', COALESCE((
            SELECT pg_catalog.jsonb_agg(username ORDER BY username) FROM missing
        ), '[]'::JSONB),
        'extra', COALESCE((
            SELECT pg_catalog.jsonb_agg(username ORDER BY username) FROM extra
        ), '[]'::JSONB),
        'complete', NOT EXISTS (SELECT 1 FROM missing)
            AND NOT EXISTS (SELECT 1 FROM extra)
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_candidate_key_coverage(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_order_audit_bundle(
    p_request_id UUID,
    p_section TEXT DEFAULT 'summary',
    p_cursor INTEGER DEFAULT 0,
    p_page_size INTEGER DEFAULT 25,
    p_filter TEXT DEFAULT 'all'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
    v_bundle public.analysis_order_audit_bundles%ROWTYPE;
    v_summary JSONB;
    v_rows JSONB := '[]'::JSONB;
    v_total INTEGER := 0;
    v_section TEXT := pg_catalog.lower(COALESCE(p_section, 'summary'));
    v_filter TEXT := pg_catalog.lower(COALESCE(p_filter, 'all'));
BEGIN
    IF p_request_id IS NULL
       OR p_cursor NOT BETWEEN 0 AND 100000
       OR p_page_size NOT BETWEEN 1 AND 50
       OR p_section IS NOT NULL
          AND NOT (p_section IN ('summary', 'mutuals', 'gender', 'interactions', 'risk'))
       OR v_section NOT IN ('summary', 'mutuals', 'gender', 'interactions', 'risk')
       OR v_filter NOT IN ('all', 'public', 'private', 'comments', 'likes',
                           'candidate_likes', 'tags', 'mentions') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_QUERY', ERRCODE = 'P0001';
    END IF;

    SELECT bundle.*
      INTO v_bundle
      FROM public.analysis_order_audit_bundles AS bundle
     WHERE bundle.request_id = p_request_id
     ORDER BY bundle.version DESC
     LIMIT 1;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_summary := public.analysis_order_audit_bundle_payload(v_bundle);

    IF v_section = 'summary' THEN
        RETURN pg_catalog.jsonb_build_object(
            'summary', v_summary,
            'section', v_section,
            'rows', '[]'::JSONB,
            'total', 0,
            'nextCursor', NULL
        );
    END IF;

    IF v_section IN ('mutuals', 'gender', 'risk') THEN
        SELECT pg_catalog.count(*)::INTEGER
          INTO v_total
          FROM public.analysis_order_audit_candidates AS candidate
         WHERE candidate.request_id = v_bundle.request_id
           AND candidate.version = v_bundle.version
           AND (
               v_filter = 'all'
               OR (v_filter = 'private' AND candidate.is_private)
               OR (v_filter = 'public' AND NOT candidate.is_private)
           );

        IF v_section = 'mutuals' THEN
            SELECT COALESCE(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'candidateId', page.candidate_id,
                    'username', page.username,
                    'mutualOrdinal', page.mutual_ordinal,
                    'followingOrdinal', page.following_ordinal,
                    'isPrivate', page.is_private,
                    'isVerified', page.is_verified,
                    'profileAvailable', page.profile_available,
                    'profileImageAvailable', page.profile_image_available,
                    'profileFailureCode', page.profile_failure_code,
                    'finalInclusionState', page.final_inclusion_state,
                    'completeness', CASE
                        WHEN page.profile_available THEN 'complete' ELSE 'partial' END
                ) ORDER BY page.mutual_ordinal NULLS LAST, page.username
            ), '[]'::JSONB)
              INTO v_rows
              FROM (
                  SELECT candidate.*
                    FROM public.analysis_order_audit_candidates AS candidate
                   WHERE candidate.request_id = v_bundle.request_id
                     AND candidate.version = v_bundle.version
                     AND (
                         v_filter = 'all'
                         OR (v_filter = 'private' AND candidate.is_private)
                         OR (v_filter = 'public' AND NOT candidate.is_private)
                     )
                   ORDER BY candidate.mutual_ordinal NULLS LAST, candidate.username
                   OFFSET p_cursor LIMIT p_page_size
              ) AS page;
        ELSIF v_section = 'gender' THEN
            SELECT COALESCE(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'candidateId', page.candidate_id,
                    'username', page.username,
                    'isPrivate', page.is_private,
                    'initial', pg_catalog.jsonb_build_object(
                        'output', page.initial_gender_output,
                        'model', page.initial_gender_model,
                        'confidence', page.initial_gender_confidence,
                        'reason', page.initial_gender_reason,
                        'operationKey', page.gender_operation_key,
                        'resultHash', page.gender_result_hash
                    ),
                    'final', pg_catalog.jsonb_build_object(
                        'output', page.final_gender_output,
                        'model', page.final_gender_model,
                        'confidence', page.final_gender_confidence,
                        'reason', page.final_gender_reason,
                        'operationKey', page.gender_resolution_operation_key,
                        'resultHash', page.gender_resolution_result_hash
                    ),
                    'completeness', CASE
                        WHEN page.final_gender_output IS NULL THEN 'partial' ELSE 'complete' END
                ) ORDER BY page.mutual_ordinal NULLS LAST, page.username
            ), '[]'::JSONB)
              INTO v_rows
              FROM (
                  SELECT candidate.*
                    FROM public.analysis_order_audit_candidates AS candidate
                   WHERE candidate.request_id = v_bundle.request_id
                     AND candidate.version = v_bundle.version
                     AND (
                         v_filter = 'all'
                         OR (v_filter = 'private' AND candidate.is_private)
                         OR (v_filter = 'public' AND NOT candidate.is_private)
                     )
                   ORDER BY candidate.mutual_ordinal NULLS LAST, candidate.username
                   OFFSET p_cursor LIMIT p_page_size
              ) AS page;
        ELSE
            SELECT COALESCE(pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'candidateId', page.candidate_id,
                    'username', page.username,
                    'riskComponents', page.risk_components,
                    'riskFormulaVersion', page.risk_formula_version,
                    'preScore', page.pre_score,
                    'rawScore', page.raw_score,
                    'publicScore', page.public_score,
                    'finalScore', page.final_score,
                    'riskBand', page.risk_band,
                    'finalRank', page.final_rank,
                    'featuredRank', page.featured_rank,
                    'recentMutualRank', page.recent_mutual_rank,
                    'partnerSafety', pg_catalog.jsonb_build_object(
                        'operationKey', page.partner_safety_operation_key,
                        'resultHash', page.partner_safety_result_hash
                    ),
                    'completeness', CASE
                        WHEN page.final_score IS NULL THEN 'partial' ELSE 'complete' END
                ) ORDER BY page.final_rank NULLS LAST, page.username
            ), '[]'::JSONB)
              INTO v_rows
              FROM (
                  SELECT candidate.*
                    FROM public.analysis_order_audit_candidates AS candidate
                   WHERE candidate.request_id = v_bundle.request_id
                     AND candidate.version = v_bundle.version
                     AND (
                         v_filter = 'all'
                         OR (v_filter = 'private' AND candidate.is_private)
                         OR (v_filter = 'public' AND NOT candidate.is_private)
                     )
                   ORDER BY candidate.final_rank NULLS LAST, candidate.username
                   OFFSET p_cursor LIMIT p_page_size
              ) AS page;
        END IF;
    ELSE
        IF v_filter NOT IN ('all', 'comments', 'likes', 'candidate_likes', 'tags', 'mentions') THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_QUERY', ERRCODE = 'P0001';
        END IF;
        SELECT pg_catalog.count(*)::INTEGER
          INTO v_total
          FROM public.analysis_order_audit_interactions AS interaction
         WHERE interaction.request_id = v_bundle.request_id
           AND interaction.version = v_bundle.version
           AND (
               v_filter = 'all'
               OR (v_filter = 'comments' AND interaction.signal = 'target_post_comment')
               OR (v_filter = 'likes' AND interaction.signal = 'target_post_like')
               OR (v_filter = 'candidate_likes' AND interaction.signal = 'candidate_post_like')
               OR (v_filter = 'tags' AND interaction.signal = 'tag')
               OR (v_filter = 'mentions' AND interaction.signal = 'mention')
           );
        SELECT COALESCE(pg_catalog.jsonb_agg(
            pg_catalog.jsonb_build_object(
                'ordinal', page.ordinal,
                'candidateId', page.candidate_id,
                'username', page.username,
                'signal', page.signal,
                'sourcePostId', page.source_post_id,
                'evidenceId', page.evidence_id,
                'occurredAt', page.occurred_at,
                'commentText', page.comment_text,
                'details', public.analysis_order_audit_redact_json(page.details),
                'completeness', page.completeness_status,
                'gapCodes', pg_catalog.to_jsonb(page.gap_codes)
            ) ORDER BY page.ordinal
        ), '[]'::JSONB)
          INTO v_rows
          FROM (
              SELECT interaction.*
                FROM public.analysis_order_audit_interactions AS interaction
               WHERE interaction.request_id = v_bundle.request_id
                 AND interaction.version = v_bundle.version
                 AND (
                     v_filter = 'all'
                     OR (v_filter = 'comments' AND interaction.signal = 'target_post_comment')
                     OR (v_filter = 'likes' AND interaction.signal = 'target_post_like')
                     OR (v_filter = 'candidate_likes' AND interaction.signal = 'candidate_post_like')
                     OR (v_filter = 'tags' AND interaction.signal = 'tag')
                     OR (v_filter = 'mentions' AND interaction.signal = 'mention')
                 )
               ORDER BY interaction.ordinal
               OFFSET p_cursor LIMIT p_page_size
          ) AS page;
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'summary', v_summary,
        'section', v_section,
        'rows', v_rows,
        'total', v_total,
        'nextCursor', CASE
            WHEN p_cursor + p_page_size < v_total THEN p_cursor + p_page_size
            ELSE NULL
        END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_digest(TEXT),
    public.prevent_analysis_order_audit_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_analysis_order_audit_bundle_mutation
BEFORE UPDATE OR DELETE ON public.analysis_order_audit_bundles
FOR EACH ROW EXECUTE FUNCTION public.prevent_analysis_order_audit_mutation();
CREATE TRIGGER prevent_analysis_order_audit_candidate_mutation
BEFORE UPDATE OR DELETE ON public.analysis_order_audit_candidates
FOR EACH ROW EXECUTE FUNCTION public.prevent_analysis_order_audit_mutation();
CREATE TRIGGER prevent_analysis_order_audit_interaction_mutation
BEFORE UPDATE OR DELETE ON public.analysis_order_audit_interactions
FOR EACH ROW EXECUTE FUNCTION public.prevent_analysis_order_audit_mutation();


CREATE OR REPLACE FUNCTION public.list_analysis_order_audit_bundle_recovery(
    p_limit INTEGER DEFAULT 10
)
RETURNS SETOF JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', queue.request_id::TEXT,
        'status', queue.status,
        'attemptCount', queue.attempt_count,
        'nextAttemptAt', queue.next_attempt_at,
        'lastErrorCode', queue.last_error_code
    )
    FROM public.analysis_order_audit_assembly_queue AS queue
    WHERE p_limit BETWEEN 1 AND 50
      AND (
          queue.status = 'queued'
          OR (
              queue.status = 'processing'
              AND queue.lease_expires_at < pg_catalog.clock_timestamp()
          )
          OR (
              queue.status = 'failed'
              AND queue.next_attempt_at <= pg_catalog.clock_timestamp()
          )
      )
    ORDER BY queue.next_attempt_at, queue.updated_at, queue.request_id
    LIMIT CASE WHEN p_limit BETWEEN 1 AND 50 THEN p_limit ELSE 0 END;
$$;

CREATE OR REPLACE FUNCTION public.claim_analysis_order_audit_bundle(
    p_request_id UUID,
    p_lease_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_queue public.analysis_order_audit_assembly_queue%ROWTYPE;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_lease UUID := extensions.gen_random_uuid();
BEGIN
    IF p_request_id IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 1800 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_CLAIM', ERRCODE = 'P0001';
    END IF;

    SELECT queue.*
      INTO v_queue
      FROM public.analysis_order_audit_assembly_queue AS queue
     WHERE queue.request_id = p_request_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_queue.status = 'processing'
       AND v_queue.lease_expires_at IS NOT NULL
       AND v_queue.lease_expires_at > v_now THEN
        RETURN NULL;
    END IF;
    IF v_queue.status = 'completed' THEN
        RETURN NULL;
    END IF;
    IF v_queue.next_attempt_at > v_now THEN
        RETURN NULL;
    END IF;

    UPDATE public.analysis_order_audit_assembly_queue
       SET status = 'processing',
           attempt_count = v_queue.attempt_count + 1,
           lease_token = v_lease,
           lease_expires_at = v_now + make_interval(secs => p_lease_seconds),
           updated_at = v_now
     WHERE request_id = p_request_id;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id::TEXT,
        'leaseToken', v_lease::TEXT,
        'attemptCount', v_queue.attempt_count + 1,
        'leaseExpiresAt', v_now + make_interval(secs => p_lease_seconds)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_analysis_order_audit_bundle(
    p_request_id UUID,
    p_lease_token UUID,
    p_error_code TEXT DEFAULT NULL,
    p_retryable BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_status TEXT;
    v_next TIMESTAMPTZ;
BEGIN
    IF p_request_id IS NULL OR p_lease_token IS NULL
       OR p_error_code IS NOT NULL
          AND (p_error_code !~ '^[A-Z0-9_:-]{1,96}$') THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_RELEASE', ERRCODE = 'P0001';
    END IF;

    v_status := CASE WHEN p_retryable THEN 'queued' ELSE 'failed' END;
    v_next := CASE WHEN p_retryable
        THEN pg_catalog.clock_timestamp() + INTERVAL '30 seconds'
        ELSE pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
    END;
    UPDATE public.analysis_order_audit_assembly_queue
       SET status = v_status,
           next_attempt_at = v_next,
           lease_token = NULL,
           lease_expires_at = NULL,
           last_error_code = p_error_code,
           last_error_at = CASE WHEN p_error_code IS NULL THEN NULL ELSE pg_catalog.clock_timestamp() END,
           updated_at = pg_catalog.clock_timestamp()
     WHERE request_id = p_request_id
       AND lease_token = p_lease_token;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'requestId', p_request_id::TEXT,
        'status', v_status,
        'nextAttemptAt', v_next
    );
END;
$$;



CREATE OR REPLACE FUNCTION public.analysis_order_audit_cost_source_hash(
    p_request_id UUID
)
RETURNS VARCHAR(64)
LANGUAGE sql
SECURITY DEFINER
STABLE
    SET search_path = ''
AS $$
    SELECT public.analysis_order_audit_digest(COALESCE((
        SELECT public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(rollup))::TEXT
        FROM public.analysis_v2_cost_rollups AS rollup
        WHERE rollup.request_id = p_request_id
        LIMIT 1
    ), 'missing-cost-source'));
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_cost_source_hash(UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_order_audit_source_table_hash(
    p_table_name TEXT,
    p_request_id UUID
)
RETURNS VARCHAR(64)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
    v_hash VARCHAR(64);
BEGIN
    IF p_table_name IS NULL
       OR p_table_name !~ '^analysis_v2_[a-z0-9_]+$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_SOURCE_TABLE', ERRCODE = 'P0001';
    END IF;
    IF pg_catalog.to_regclass('public.' || p_table_name) IS NULL THEN
        RETURN public.analysis_order_audit_digest('missing-table:' || p_table_name);
    END IF;
    EXECUTE pg_catalog.format(
        'SELECT public.analysis_order_audit_digest(COALESCE((
             SELECT pg_catalog.jsonb_agg(
                 public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(source))
                 ORDER BY pg_catalog.to_jsonb(source)::TEXT
             )::TEXT
             FROM public.%I AS source
             WHERE source.request_id = $1
         ), ''[]''))', p_table_name
    ) INTO v_hash USING p_request_id;
    RETURN v_hash;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_source_table_hash(TEXT, UUID)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_order_audit_purge_fence(
    p_request_id UUID,
    p_reason TEXT DEFAULT 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED'
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- ANALYSIS_ORDER_AUDIT_PURGE_FENCED is the durable safety outcome; the successful path emits
    -- ANALYSIS_ORDER_AUDIT_PURGE_COMPLETED after all allowlisted source rows are deleted.
    IF p_request_id IS NULL
       OR p_reason IS NULL
       OR p_reason !~ '^[A-Z][A-Z0-9_:-]{1,95}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_PURGE_FENCE', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_order_audit_assembly_queue
       SET status = 'failed',
           next_attempt_at = pg_catalog.clock_timestamp(),
           lease_token = NULL,
           lease_expires_at = NULL,
           purge_fenced_at = pg_catalog.clock_timestamp(),
           purge_fence_reason = p_reason,
           purged_at = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE request_id = p_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_purge_fence(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_order_audit_bundle_payload(
    p_bundle public.analysis_order_audit_bundles
)
RETURNS JSONB
LANGUAGE sql
STABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_bundle.request_id::TEXT,
        'version', p_bundle.version,
        'bundleHash', p_bundle.bundle_hash,
        'previousVersionHash', p_bundle.previous_version_hash,
        'sourceSetHash', p_bundle.source_set_hash,
        'status', p_bundle.completeness_status,
        'completeness', p_bundle.completeness_status,
        'gapCodes', pg_catalog.to_jsonb(p_bundle.gap_codes),
        'pipelineVersion', p_bundle.pipeline_version,
        'pipelinePolicy', public.analysis_order_audit_redact_json(p_bundle.pipeline_policy),
        'riskPolicyVersion', p_bundle.risk_policy_version,
        'aiPolicyVersion', p_bundle.ai_policy_version,
        'schedulerPolicyVersion', p_bundle.scheduler_policy_version,
        'planId', p_bundle.plan_id,
        'accessMode', p_bundle.access_mode,
        'orderId', p_bundle.order_id,
        'targetInstagramId', p_bundle.target_instagram_id,
        'targetProfileAvailable', p_bundle.target_profile_available,
        'targetPostsAvailable', p_bundle.target_posts_available,
        'targetPostCount', p_bundle.target_post_count,
        'followers', pg_catalog.jsonb_build_object(
            'declared', p_bundle.followers_declared,
            'collected', p_bundle.followers_collected
        ),
        'following', pg_catalog.jsonb_build_object(
            'declared', p_bundle.following_declared,
            'collected', p_bundle.following_collected
        ),
        'mutuals', pg_catalog.jsonb_build_object(
            'total', p_bundle.mutual_total,
            'public', p_bundle.public_total,
            'private', p_bundle.private_total,
            'screened', p_bundle.screened_total,
            'declared', p_bundle.candidate_declared,
            'collected', p_bundle.candidate_collected,
            'listHash', p_bundle.mutual_list_hash,
            'keyCoverage', p_bundle.candidate_key_coverage
        ),
        'interactions', pg_catalog.jsonb_build_object(
            'declared', p_bundle.interaction_declared,
            'collected', p_bundle.interaction_collected,
            'targetLikes', pg_catalog.jsonb_build_object(
                'declared', p_bundle.target_likes_declared,
                'collected', p_bundle.target_likes_collected
            ),
            'targetComments', pg_catalog.jsonb_build_object(
                'declared', p_bundle.target_comments_declared,
                'collected', p_bundle.target_comments_collected
            ),
            'candidateLikes', pg_catalog.jsonb_build_object(
                'declared', p_bundle.candidate_likes_declared,
                'collected', p_bundle.candidate_likes_collected,
                'evidenceCollected', p_bundle.candidate_likes_evidence_collected
            ),
            'tags', pg_catalog.jsonb_build_object(
                'declared', p_bundle.tags_declared,
                'collected', p_bundle.tags_collected
            ),
            'mentions', pg_catalog.jsonb_build_object(
                'declared', p_bundle.mentions_declared,
                'collected', p_bundle.mentions_collected
            )
        ),
        'providerRuns', p_bundle.provider_runs,
        'stageStatus', p_bundle.stage_status,
        'assembledAt', p_bundle.assembled_at,
        'cost', pg_catalog.jsonb_build_object(
            'currency', p_bundle.cost_currency,
            'status', p_bundle.cost_status,
            'knownUsd', p_bundle.cost_known_usd,
            'conservativeUsd', p_bundle.cost_conservative_usd,
            'totalKnownCostUsd', p_bundle.total_known_cost_usd,
            'totalConservativeCostUsd', p_bundle.total_conservative_cost_usd,
            'usageUnknown', p_bundle.cost_usage_unknown,
            'missingSourceCodes', pg_catalog.to_jsonb(p_bundle.cost_missing_source_codes),
            'provenance', public.analysis_order_audit_redact_json(p_bundle.cost_provenance)
        ),
        'usageUnknown', p_bundle.usage_unknown
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_bundle_payload(
    public.analysis_order_audit_bundles
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.enqueue_analysis_order_audit_bundle(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_latest public.analysis_order_audit_bundles%ROWTYPE;
    v_cost_hash VARCHAR(64);
    v_reopen BOOLEAN := FALSE;
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_REQUEST', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_requests AS request
        WHERE request.id = p_request_id AND request.pipeline_version = 'v2'
    ) THEN
        RETURN NULL;
    END IF;

    v_cost_hash := public.analysis_order_audit_cost_source_hash(p_request_id);
    SELECT bundle.* INTO v_latest
    FROM public.analysis_order_audit_bundles AS bundle
    WHERE bundle.request_id = p_request_id
    ORDER BY bundle.version DESC
    LIMIT 1;
    v_reopen := v_latest.request_id IS NOT NULL
        AND v_latest.stage_status->>'costSourceHash' IS DISTINCT FROM v_cost_hash;

    INSERT INTO public.analysis_order_audit_assembly_queue (
        request_id, status, attempt_count, next_attempt_at, lease_token,
        lease_expires_at, last_error_code, last_error_at, updated_at
    ) VALUES (
        p_request_id, 'queued', 0, pg_catalog.clock_timestamp(), NULL,
        NULL, NULL, NULL, pg_catalog.clock_timestamp()
    )
    ON CONFLICT (request_id) DO UPDATE SET
        status = CASE
            WHEN public.analysis_order_audit_assembly_queue.status = 'completed'
                 AND NOT v_reopen THEN 'completed'
            WHEN public.analysis_order_audit_assembly_queue.status = 'processing'
                 AND public.analysis_order_audit_assembly_queue.lease_expires_at
                     > pg_catalog.clock_timestamp()
                 AND NOT v_reopen THEN 'processing'
            ELSE 'queued'
        END,
        next_attempt_at = CASE
            WHEN public.analysis_order_audit_assembly_queue.status = 'completed'
                 AND NOT v_reopen
                THEN public.analysis_order_audit_assembly_queue.next_attempt_at
            WHEN public.analysis_order_audit_assembly_queue.status = 'processing'
                 AND public.analysis_order_audit_assembly_queue.lease_expires_at
                     > pg_catalog.clock_timestamp()
                 AND NOT v_reopen
                THEN public.analysis_order_audit_assembly_queue.next_attempt_at
            ELSE pg_catalog.clock_timestamp()
        END,
        lease_token = CASE
            WHEN public.analysis_order_audit_assembly_queue.status = 'processing'
                 AND public.analysis_order_audit_assembly_queue.lease_expires_at
                     > pg_catalog.clock_timestamp()
                 AND NOT v_reopen
                THEN public.analysis_order_audit_assembly_queue.lease_token
            ELSE NULL
        END,
        lease_expires_at = CASE
            WHEN public.analysis_order_audit_assembly_queue.status = 'processing'
                 AND public.analysis_order_audit_assembly_queue.lease_expires_at
                     > pg_catalog.clock_timestamp()
                 AND NOT v_reopen
                THEN public.analysis_order_audit_assembly_queue.lease_expires_at
            ELSE NULL
        END,
        last_error_code = CASE
            WHEN public.analysis_order_audit_assembly_queue.status IN ('completed', 'processing')
                 AND NOT v_reopen
                THEN public.analysis_order_audit_assembly_queue.last_error_code
            ELSE NULL
        END,
        last_error_at = CASE
            WHEN public.analysis_order_audit_assembly_queue.status IN ('completed', 'processing')
                 AND NOT v_reopen
                THEN public.analysis_order_audit_assembly_queue.last_error_at
            ELSE NULL
        END,
        -- A late cost source changes the immutable version but must not erase a terminal purge
        -- fence; the retry assembler will purge only after the new finalized bundle is durable.
        purge_fenced_at = public.analysis_order_audit_assembly_queue.purge_fenced_at,
        purge_fence_reason = public.analysis_order_audit_assembly_queue.purge_fence_reason,
        purged_at = CASE WHEN v_reopen THEN NULL
            ELSE public.analysis_order_audit_assembly_queue.purged_at END,
        updated_at = pg_catalog.clock_timestamp();

    RETURN pg_catalog.jsonb_build_object(
        'status', 'queued',
        'requestId', p_request_id::TEXT,
        'costSourceHash', v_cost_hash
    );
END;
$$;

-- This private implementation preserves the production purge contract. The lock sequence must stay
-- intent -> summary -> audit run -> ordered scoring checkpoints; the terminal final-score predicate
-- below is the only exception to deleting the rich scoring checkpoint working set.
CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set_exact(
    p_request_id UUID,
    p_keep_final BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_table TEXT;
    v_child_tables CONSTANT TEXT[] := ARRAY[
        'analysis_v2_candidate_score_rows',
        'analysis_v2_partner_safety_rows',
        'analysis_v2_narrative_rows',
        'analysis_v2_reverse_like_rows',
        'analysis_v2_preliminary_score_rows',
        'analysis_target_interactors',
        'analysis_v2_candidate_feature_rows',
        'analysis_v2_private_name_rows',
        'analysis_v2_mutual_rows',
        'analysis_v2_relationship_rows',
        'analysis_v2_profile_fetch_outcomes'
    ];
BEGIN
    IF p_request_id IS NULL OR p_keep_final IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    -- The production function locks the score-audit intent first so claim/expiry work cannot race
    -- the destructive cleanup. A missing intent remains a supported orphan path.
    PERFORM 1
    FROM public.analysis_v2_score_audit_intents AS intent
    WHERE intent.request_id = p_request_id
    FOR UPDATE;

    -- Lock the parent summary before touching the audit run or deleting it below.
    IF p_keep_final THEN
        PERFORM 1
        FROM public.analysis_v2_result_summaries AS summary
        WHERE summary.request_id = p_request_id
        FOR KEY SHARE;
    ELSE
        PERFORM 1
        FROM public.analysis_v2_result_summaries AS summary
        WHERE summary.request_id = p_request_id
        FOR UPDATE;
    END IF;

    PERFORM 1
    FROM public.analysis_v2_score_audit_runs AS run
    WHERE run.request_id = p_request_id
    FOR UPDATE;

    -- Lock every scoring checkpoint in stable order before any working-set delete.
    PERFORM 1
    FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
    WHERE stage.request_id = p_request_id
    ORDER BY stage.stage_kind, stage.batch_key
    FOR UPDATE;

    -- Additional child ledgers are removed before their manifests/parents. Every delete is guarded
    -- so this function remains usable in narrowly provisioned repair stacks.
    FOREACH v_table IN ARRAY v_child_tables LOOP
        IF pg_catalog.to_regclass('public.' || v_table) IS NOT NULL THEN
            EXECUTE pg_catalog.format(
                'DELETE FROM public.%I WHERE request_id = $1', v_table
            ) USING p_request_id;
        END IF;
    END LOOP;

    -- Keep the exact latest production deletion sequence below, including its final-score intent
    -- retention predicate.
    DELETE FROM public.analysis_v2_narrative_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_candidate_score_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_partner_safety_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_reverse_like_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_preliminary_score_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_private_name_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_candidate_feature_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_ai_result_checkpoints WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
    WHERE stage.request_id = p_request_id
      AND NOT (
        p_keep_final
        AND stage.stage_kind = 'final_score' AND stage.batch_key = -1
        AND EXISTS (
            SELECT 1
            FROM public.analysis_v2_score_audit_intents AS intent
            LEFT JOIN public.analysis_v2_score_audit_runs AS run
              ON run.request_id = intent.request_id
             AND run.source_result_hash = intent.source_result_hash
             AND run.source_generation = intent.source_generation
            WHERE intent.request_id = p_request_id
              AND intent.source_result_hash = stage.result_hash
              AND intent.intent_status = 'queued'
              AND intent.retain_until > pg_catalog.clock_timestamp()
              AND (
                run.request_id IS NULL
                OR run.status IN ('queued','processing')
              )
        )
      );
    DELETE FROM public.analysis_v2_profile_fetch_batches WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_target_evidence_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_relationship_manifests WHERE request_id = p_request_id;
    DELETE FROM public.analysis_v2_relationship_sides WHERE request_id = p_request_id;
    IF NOT p_keep_final THEN
        DELETE FROM public.analysis_v2_result_summaries WHERE request_id = p_request_id;
    END IF;

    UPDATE public.analysis_order_audit_assembly_queue
       SET purged_at = pg_catalog.clock_timestamp(),
           purge_fenced_at = NULL,
           purge_fence_reason = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE request_id = p_request_id;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_purge_result_working_set_exact(UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;

-- A terminal purge is allowed only after the immutable parent is durable. Missing parents are
-- recorded as a durable fence and leave all rich evidence available for a later retry.
CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set(
    p_request_id UUID,
    p_keep_final BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_bundle_assembled_at TIMESTAMPTZ;
    v_bundle_finalized BOOLEAN;
    v_purge_fenced_at TIMESTAMPTZ;
    v_queue_status TEXT;
    v_request_status TEXT;
BEGIN
    IF p_request_id IS NULL OR p_keep_final IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_request_id::TEXT, 0)
    );

    SELECT request.status
      INTO v_request_status
      FROM public.analysis_requests AS request
     WHERE request.id = p_request_id
       AND request.pipeline_version = 'v2'
     FOR KEY SHARE;
    IF NOT FOUND OR v_request_status NOT IN ('completed', 'failed') THEN
        RETURN;
    END IF;

    -- The queue row is the durable fence state. A caller cannot purge merely because an older
    -- partial bundle exists, and a missing queue row cannot prove that assembly completed.
    SELECT queue.status, queue.purge_fenced_at
      INTO v_queue_status, v_purge_fenced_at
      FROM public.analysis_order_audit_assembly_queue AS queue
     WHERE queue.request_id = p_request_id
     FOR UPDATE;
    IF NOT FOUND THEN
        -- The request FK makes this insert safe. Persist the fence even when an earlier deployment
        -- or repair path lost the queue row; never treat a missing queue as permission to purge.
        INSERT INTO public.analysis_order_audit_assembly_queue(
            request_id, status, attempt_count, next_attempt_at,
            purge_fenced_at, purge_fence_reason, purged_at, updated_at
        ) VALUES (
            p_request_id, 'failed', 0, pg_catalog.clock_timestamp(),
            pg_catalog.clock_timestamp(), 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED', NULL,
            pg_catalog.clock_timestamp()
        )
        ON CONFLICT (request_id) DO NOTHING;
        RETURN;
    END IF;

    SELECT bundle.assembled_at,
           bundle.stage_status->>'finalized' = 'true'
      INTO v_bundle_assembled_at, v_bundle_finalized
      FROM public.analysis_order_audit_bundles AS bundle
     WHERE bundle.request_id = p_request_id
     ORDER BY bundle.version DESC
     LIMIT 1;
    IF v_bundle_assembled_at IS NULL THEN
        PERFORM public.analysis_order_audit_purge_fence(
            p_request_id, 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED'
        );
        RETURN;
    END IF;
    IF NOT COALESCE(v_bundle_finalized, FALSE) THEN
        PERFORM public.analysis_order_audit_purge_fence(
            p_request_id, 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_NOT_FINALIZED'
        );
        RETURN;
    END IF;
    IF v_queue_status IS DISTINCT FROM 'completed'
       OR (v_purge_fenced_at IS NOT NULL AND v_bundle_assembled_at <= v_purge_fenced_at) THEN
        RETURN;
    END IF;

    PERFORM public.analysis_v2_purge_result_working_set_exact(
        p_request_id, p_keep_final
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_purge_result_working_set(UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_purge_result_working_set(UUID, BOOLEAN)
    TO service_role;

CREATE OR REPLACE FUNCTION public.assemble_analysis_order_audit_bundle(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_summary public.analysis_v2_result_summaries%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.analysis_order_audit_bundles%ROWTYPE;
    v_latest public.analysis_order_audit_bundles%ROWTYPE;
    v_followers RECORD;
    v_following RECORD;
    v_relationship RECORD;
    v_target_evidence RECORD;
    v_cost RECORD;
    v_order_id UUID;
    v_target_username TEXT;
    v_risk_policy TEXT;
    v_ai_policy TEXT;
    v_scheduler_policy TEXT;
    v_plan_id TEXT;
    v_access_mode TEXT;
    v_target_profile_available BOOLEAN := FALSE;
    v_target_posts_available BOOLEAN := FALSE;
    v_target_post_count INTEGER;
    v_followers_declared INTEGER;
    v_followers_collected INTEGER;
    v_following_declared INTEGER;
    v_following_collected INTEGER;
    v_mutual_total INTEGER := 0;
    v_public_total INTEGER := 0;
    v_private_total INTEGER := 0;
    v_screened_total INTEGER := 0;
    v_mutual_rows_collected INTEGER := 0;
    v_candidate_declared INTEGER := 0;
    v_candidate_collected INTEGER := 0;
    v_interaction_declared INTEGER := 0;
    v_interaction_collected INTEGER := 0;
    v_target_likes_declared INTEGER;
    v_target_likes_collected INTEGER;
    v_target_comments_declared INTEGER;
    v_target_comments_collected INTEGER;
    v_candidate_likes_declared INTEGER;
    v_candidate_likes_collected INTEGER;
    v_candidate_likes_evidence_collected INTEGER;
    v_score_collected INTEGER := 0;
    v_tags_declared INTEGER;
    v_tags_collected INTEGER;
    v_mentions_declared INTEGER;
    v_mentions_collected INTEGER;
    v_target_interaction_max_ordinal INTEGER := 0;
    v_reverse_manifest_exists BOOLEAN := FALSE;
    v_mutual_list_hash VARCHAR(64);
    v_source_set_json JSONB := '{}'::JSONB;
    v_retained_source_set_hash VARCHAR(64);
    v_source_set_hash VARCHAR(64);
    v_cost_source_hash VARCHAR(64);
    v_provider_runs JSONB := '[]'::JSONB;
    v_stage_status JSONB := '{}'::JSONB;
    v_candidate_key_coverage JSONB := '{}'::JSONB;
    v_bundle_hash VARCHAR(64);
    v_previous_hash VARCHAR(64);
    v_version INTEGER;
    v_gaps TEXT[] := ARRAY[]::TEXT[];
    v_cost_missing TEXT[] := ARRAY[]::TEXT[];
    v_cost_status TEXT := 'not_available';
    v_cost_known NUMERIC;
    v_cost_conservative NUMERIC;
    v_total_known NUMERIC;
    v_total_conservative NUMERIC;
    v_cost_usage_unknown BOOLEAN := TRUE;
    v_cost_complete BOOLEAN := FALSE;
    v_cost_provenance JSONB := '{}'::JSONB;
    v_preflight_usage_unknown INTEGER := 0;
    v_provider_usage_unknown INTEGER := 0;
    v_ai_usage_unknown INTEGER := 0;
    v_vertex_unmatched INTEGER := 0;
    v_vertex_usage_unknown INTEGER := 0;
    v_vertex_duplicate INTEGER := 0;
    v_vertex_mismatch INTEGER := 0;
    v_relationship_ready BOOLEAN := FALSE;
    v_target_evidence_ready BOOLEAN := FALSE;
    v_features_ready BOOLEAN := FALSE;
    v_scores_ready BOOLEAN := FALSE;
    v_finalized BOOLEAN := FALSE;
    v_inconsistent BOOLEAN := FALSE;
    v_reuse_latest BOOLEAN := FALSE;
    v_queue_fenced BOOLEAN := FALSE;
    v_purge_fenced_at TIMESTAMPTZ;
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_REQUEST', ERRCODE = 'P0001';
    END IF;

    -- One request lock covers queue state, source reads, append, and the retry purge fence.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_request_id::TEXT, 0)
    );

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id AND request.pipeline_version = 'v2';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT bundle.* INTO v_latest
    FROM public.analysis_order_audit_bundles AS bundle
    WHERE bundle.request_id = p_request_id
    ORDER BY bundle.version DESC
    LIMIT 1;
    SELECT queue.purge_fenced_at IS NOT NULL, queue.purge_fenced_at
      INTO v_queue_fenced, v_purge_fenced_at
    FROM public.analysis_order_audit_assembly_queue AS queue
    WHERE queue.request_id = p_request_id;
    v_queue_fenced := COALESCE(v_queue_fenced, FALSE);
    -- Keep the durable freshness fence strict even when the database clock has only millisecond
    -- resolution or moves backwards between the failed terminal attempt and its retry.
    IF v_purge_fenced_at IS NOT NULL AND v_now <= v_purge_fenced_at THEN
        v_now := v_purge_fenced_at + INTERVAL '1 microsecond';
    END IF;

    INSERT INTO public.analysis_order_audit_assembly_queue(request_id, status, updated_at)
    VALUES (p_request_id, 'processing', v_now)
    ON CONFLICT (request_id) DO UPDATE SET
        status = 'processing',
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now;

    SELECT summary.* INTO v_summary
    FROM public.analysis_v2_result_summaries AS summary
    WHERE summary.request_id = p_request_id;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_request.preflight_id;
    SELECT earlybird_order.id INTO v_order_id
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.result_request_id = p_request_id
    ORDER BY earlybird_order.id
    LIMIT 1;

    v_target_username := COALESCE(
        NULLIF(v_summary.target_instagram_id, ''),
        NULLIF(v_preflight.target_instagram_id, '')
    );
    v_target_profile_available := v_summary.request_id IS NOT NULL
        OR (
            v_preflight.target_followers_count IS NOT NULL
            AND v_preflight.target_following_count IS NOT NULL
        );
    v_plan_id := COALESCE(
        NULLIF(v_request.selected_plan_id_snapshot, ''),
        NULLIF(v_summary.plan_id, '')
    );
    v_access_mode := v_request.plan_access_mode_snapshot;
    v_risk_policy := COALESCE(
        v_request.policy_versions_snapshot->>'risk',
        v_summary.score_policy_version
    );
    v_ai_policy := v_request.policy_versions_snapshot->>'aiStage';
    v_scheduler_policy := v_request.policy_versions_snapshot->>'scheduler';
    v_finalized := v_request.status IN ('completed', 'failed');

    IF v_target_username IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'TARGET_ID_MISSING');
    END IF;
    IF NOT v_target_profile_available THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'TARGET_PROFILE_MISSING');
    END IF;
    IF v_summary.request_id IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'RESULT_SUMMARY_MISSING');
    END IF;

    SELECT side.declared_count, side.collected_count, side.result_hash,
           side.input_hash, side.provider, side.provider_run_id,
           side.provider_operation_key, side.provider_credential_slot,
           side.job_key
      INTO v_followers
      FROM public.analysis_v2_relationship_sides AS side
     WHERE side.request_id = p_request_id AND side.side = 'followers'
     ORDER BY side.updated_at DESC NULLS LAST, side.job_key DESC
     LIMIT 1;
    SELECT side.declared_count, side.collected_count, side.result_hash,
           side.input_hash, side.provider, side.provider_run_id,
           side.provider_operation_key, side.provider_credential_slot,
           side.job_key
      INTO v_following
      FROM public.analysis_v2_relationship_sides AS side
     WHERE side.request_id = p_request_id AND side.side = 'following'
     ORDER BY side.updated_at DESC NULLS LAST, side.job_key DESC
     LIMIT 1;

    IF v_followers.declared_count IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'FOLLOWERS_SOURCE_MISSING');
    ELSE
        v_followers_declared := v_followers.declared_count;
        v_followers_collected := v_followers.collected_count;
        v_relationship_ready := TRUE;
    END IF;
    IF v_following.declared_count IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'FOLLOWING_SOURCE_MISSING');
        v_relationship_ready := FALSE;
    ELSE
        v_following_declared := v_following.declared_count;
        v_following_collected := v_following.collected_count;
    END IF;
    IF v_followers.declared_count IS NOT NULL
       AND v_following.declared_count IS NOT NULL
       AND (
           v_followers.collected_count IS DISTINCT FROM v_followers.declared_count
           OR v_following.collected_count IS DISTINCT FROM v_following.declared_count
       ) THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'RELATIONSHIP_COUNT_GAP');
        v_inconsistent := TRUE;
    END IF;

    SELECT manifest.job_key, manifest.result_hash, manifest.mutual_count,
           manifest.public_count, manifest.private_count,
           manifest.detailed_public_count, manifest.excluded_username,
           manifest.exclusion_decision_hash, manifest.followers_result_hash,
           manifest.following_result_hash, manifest.detailed_mutual_limit
      INTO v_relationship
      FROM public.analysis_v2_relationship_manifests AS manifest
     WHERE manifest.request_id = p_request_id
     ORDER BY manifest.updated_at DESC NULLS LAST, manifest.job_key DESC
     LIMIT 1;
    IF v_relationship.mutual_count IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'MUTUAL_MANIFEST_MISSING');
    ELSE
        v_mutual_total := v_relationship.mutual_count;
        v_public_total := COALESCE(v_relationship.public_count, 0);
        v_private_total := COALESCE(v_relationship.private_count, 0);
        v_screened_total := COALESCE(v_relationship.detailed_public_count, 0);
    END IF;

    -- The relationship intersection itself is authoritative. Compare its keys with the copied
    -- mutual rows, retaining an explicit gap for both omissions and unexpected extras.
    IF v_relationship.job_key IS NOT NULL
       AND EXISTS (
           WITH follower_keys AS (
               SELECT DISTINCT row.username
               FROM public.analysis_v2_relationship_rows AS row
               WHERE row.request_id = p_request_id
                 AND row.job_key = v_relationship.job_key
                 AND row.side = 'followers'
           ),
           following_keys AS (
               SELECT DISTINCT row.username
               FROM public.analysis_v2_relationship_rows AS row
               WHERE row.request_id = p_request_id
                 AND row.job_key = v_relationship.job_key
                 AND row.side = 'following'
           ),
           expected_keys AS (
               SELECT username FROM follower_keys
               INTERSECT
               SELECT username FROM following_keys
           ),
           copied_keys AS (
               SELECT DISTINCT mutual.username
               FROM public.analysis_v2_mutual_rows AS mutual
               WHERE mutual.request_id = p_request_id
                 AND mutual.job_key = v_relationship.job_key
           )
           SELECT 1
           FROM (
               (SELECT username FROM expected_keys
                EXCEPT SELECT username FROM copied_keys)
               UNION ALL
               (SELECT username FROM copied_keys
                EXCEPT SELECT username FROM expected_keys)
           ) AS difference
       ) THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'CANDIDATE_KEY_SET_GAP');
        v_inconsistent := TRUE;
    END IF;

    SELECT target_manifest.job_key, target_manifest.result_hash,
           target_manifest.input_hash, target_manifest.target_username,
           target_manifest.interactor_count, target_manifest.liker_count,
           target_manifest.comment_count, target_manifest.liker_source,
           target_manifest.comment_source, target_manifest.liker_source_hash,
           target_manifest.comment_source_hash
      INTO v_target_evidence
     FROM public.analysis_v2_target_evidence_manifests AS target_manifest
     WHERE target_manifest.request_id = p_request_id
     ORDER BY target_manifest.updated_at DESC NULLS LAST, target_manifest.job_key DESC
     LIMIT 1;
    IF v_target_evidence.job_key IS NULL
       OR v_target_evidence.interactor_count IS NULL
       OR v_target_evidence.liker_count IS NULL
       OR v_target_evidence.comment_count IS NULL
       OR NOT public.analysis_v2_valid_target_evidence_source(
           'target_post_like', v_target_evidence.liker_source
       )
       OR NOT public.analysis_v2_valid_target_evidence_source(
           'target_post_comment', v_target_evidence.comment_source
       )
       OR v_target_evidence.liker_count + v_target_evidence.comment_count
            IS DISTINCT FROM v_target_evidence.interactor_count THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'TARGET_POSTS_MISSING');
    ELSE
        SELECT pg_catalog.count(*)::INTEGER
          INTO v_target_post_count
          FROM (
              SELECT coverage.value->>'post_id' AS post_id
              FROM pg_catalog.jsonb_array_elements(
                  v_target_evidence.liker_source->'coverage'
              ) AS coverage(value)
              UNION
              SELECT coverage.value->>'post_id' AS post_id
              FROM pg_catalog.jsonb_array_elements(
                  v_target_evidence.comment_source->'coverage'
              ) AS coverage(value)
          ) AS target_posts;
        v_target_posts_available := v_target_post_count > 0;
        v_target_evidence_ready := TRUE;
        v_target_likes_declared := v_target_evidence.liker_count;
        v_target_comments_declared := v_target_evidence.comment_count;
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
      INTO v_mutual_rows_collected
      FROM public.analysis_v2_mutual_rows AS mutual
     WHERE mutual.request_id = p_request_id
       AND (
           v_relationship.job_key IS NULL
           OR mutual.job_key = v_relationship.job_key
       );
    v_candidate_declared := COALESCE(v_relationship.mutual_count, v_mutual_rows_collected);
    v_candidate_collected := v_mutual_rows_collected;
    IF v_relationship.mutual_count IS NOT NULL
       AND v_mutual_rows_collected <> v_relationship.mutual_count THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'MUTUAL_ROWS_MISSING');
        v_inconsistent := TRUE;
    ELSIF v_relationship.mutual_count IS NULL AND v_mutual_rows_collected = 0 THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'MUTUAL_ROWS_MISSING');
    END IF;

    IF v_mutual_rows_collected > 0 THEN
        v_mutual_list_hash := public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(mutual))
                ORDER BY mutual.mutual_ordinal, mutual.username
            )::TEXT
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND (
                  v_relationship.job_key IS NULL
                  OR mutual.job_key = v_relationship.job_key
              )
        ), '[]'));
    ELSE
        v_mutual_list_hash := public.analysis_order_audit_digest('[]');
    END IF;

    v_candidate_key_coverage :=
        public.analysis_order_audit_candidate_key_coverage(p_request_id);
    IF pg_catalog.jsonb_array_length(
           COALESCE(v_candidate_key_coverage->'missing', '[]'::JSONB)
       ) > 0
       OR pg_catalog.jsonb_array_length(
           COALESCE(v_candidate_key_coverage->'extra', '[]'::JSONB)
       ) > 0 THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'CANDIDATE_KEY_SET_GAP');
        v_inconsistent := TRUE;
    END IF;
    v_features_ready := COALESCE((v_candidate_key_coverage->>'complete')::BOOLEAN, FALSE);
    IF v_public_total > 0 AND NOT v_features_ready THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'CANDIDATE_FEATURES_MISSING');
    END IF;

    SELECT
        count(*) FILTER (WHERE interaction.signal = 'target_post_like')::INTEGER,
        count(*) FILTER (WHERE interaction.signal = 'target_post_comment')::INTEGER,
        COALESCE(max(interaction.ordinal), 0)::INTEGER
      INTO v_target_likes_collected, v_target_comments_collected,
           v_target_interaction_max_ordinal
      FROM public.analysis_target_interactors AS interaction
     WHERE interaction.request_id = p_request_id
       AND (
           v_target_evidence.job_key IS NULL
           OR interaction.job_key = v_target_evidence.job_key
       );
    IF NOT v_target_evidence_ready
       AND v_target_likes_collected = 0
       AND v_target_comments_collected = 0 THEN
        v_target_likes_collected := NULL;
        v_target_comments_collected := NULL;
    END IF;
    IF v_target_evidence.interactor_count IS NOT NULL
       AND v_target_likes_collected + v_target_comments_collected
            IS DISTINCT FROM v_target_evidence.interactor_count THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'INTERACTION_ROWS_GAP');
        v_inconsistent := TRUE;
    END IF;
    IF v_target_likes_declared IS NOT NULL
       AND v_target_likes_collected <> v_target_likes_declared THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'TARGET_LIKES_ROWS_GAP');
        v_inconsistent := TRUE;
    END IF;
    IF v_target_comments_declared IS NOT NULL
       AND v_target_comments_collected <> v_target_comments_declared THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'TARGET_COMMENTS_ROWS_GAP');
        v_inconsistent := TRUE;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM public.analysis_v2_reverse_like_manifests AS manifest
        WHERE manifest.request_id = p_request_id
    ) INTO v_reverse_manifest_exists;
    IF v_reverse_manifest_exists THEN
        SELECT manifest.item_count
          INTO v_candidate_likes_declared
          FROM public.analysis_v2_reverse_like_manifests AS manifest
         WHERE manifest.request_id = p_request_id;
    END IF;
    SELECT count(*)::INTEGER,
           COALESCE(sum(pg_catalog.cardinality(reverse.evidence_ref_ids)), 0)::INTEGER
      INTO v_candidate_likes_collected, v_candidate_likes_evidence_collected
      FROM public.analysis_v2_reverse_like_rows AS reverse
      WHERE reverse.request_id = p_request_id
       AND EXISTS (
           SELECT 1
           FROM public.analysis_v2_mutual_rows AS mutual
           LEFT JOIN public.analysis_v2_candidate_feature_rows AS feature
             ON feature.request_id = mutual.request_id
            AND feature.instagram_id = mutual.username
           LEFT JOIN public.analysis_v2_private_name_rows AS private_name
             ON private_name.request_id = mutual.request_id
            AND private_name.instagram_id = mutual.username
           WHERE mutual.request_id = p_request_id
             AND (
                 v_relationship.job_key IS NULL
                 OR mutual.job_key = v_relationship.job_key
             )
             AND COALESCE(
                 feature.candidate_id, private_name.candidate_id,
                 'username:' || mutual.username
             ) = reverse.candidate_id
       );
    IF NOT v_reverse_manifest_exists
       AND v_candidate_likes_collected = 0 THEN
        v_candidate_likes_collected := NULL;
        v_candidate_likes_evidence_collected := NULL;
    END IF;
    IF NOT v_reverse_manifest_exists THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'CANDIDATE_LIKES_SOURCE_MISSING');
    ELSIF v_candidate_likes_declared IS DISTINCT FROM v_candidate_likes_collected THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'CANDIDATE_LIKES_ROWS_GAP');
        v_inconsistent := TRUE;
    END IF;

    -- Tags and mentions have no authoritative V2 row ledger. Keep their unknown declaration
    -- explicit and prevent an empty child page from looking complete.
    v_gaps := pg_catalog.array_append(v_gaps, 'TAGS_SOURCE_MISSING');
    v_gaps := pg_catalog.array_append(v_gaps, 'MENTIONS_SOURCE_MISSING');

    v_interaction_declared :=
        COALESCE(v_target_likes_declared, 0)
        + COALESCE(v_target_comments_declared, 0)
        ;
    v_interaction_collected :=
        COALESCE(v_target_likes_collected, 0)
        + COALESCE(v_target_comments_collected, 0)
        + COALESCE(v_candidate_likes_evidence_collected, 0);

    SELECT count(*)::INTEGER
      INTO v_score_collected
      FROM public.analysis_v2_candidate_score_rows AS score
     WHERE score.request_id = p_request_id;
    v_scores_ready := v_score_collected >= COALESCE(v_summary.female_count, 0);
    IF COALESCE(v_summary.female_count, 0) > 0 AND NOT v_scores_ready THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'RISK_SCORES_MISSING');
    END IF;

    SELECT rollup.* INTO v_cost
    FROM public.analysis_v2_cost_rollups AS rollup
    WHERE rollup.request_id = p_request_id
    LIMIT 1;
    v_cost_source_hash := public.analysis_order_audit_cost_source_hash(p_request_id);
    IF v_cost.request_id IS NULL THEN
        v_cost_missing := pg_catalog.array_append(v_cost_missing, 'COST_SOURCE_MISSING');
        v_gaps := pg_catalog.array_append(v_gaps, 'COST_SOURCE_MISSING');
    ELSE
        v_total_known := v_cost.total_known_cost_usd;
        v_total_conservative := v_cost.total_conservative_cost_usd;
        v_cost_usage_unknown := COALESCE(v_cost.usage_unknown, TRUE);
        v_cost_complete := COALESCE(v_cost.directly_attributable_cost_complete, FALSE)
            AND NOT v_cost_usage_unknown;
        v_cost_provenance := public.analysis_order_audit_redact_json(
            COALESCE(v_cost.cost_provenance, '{}'::JSONB)
        );
        v_preflight_usage_unknown := COALESCE(v_cost.preflight_usage_unknown_count, 0);
        v_provider_usage_unknown := COALESCE(v_cost.provider_usage_unknown_count, 0);
        v_ai_usage_unknown := COALESCE(v_cost.ai_usage_unknown_count, 0);
        v_vertex_unmatched := COALESCE(v_cost.vertex_budget_unmatched_count, 0);
        v_vertex_usage_unknown := COALESCE(v_cost.vertex_budget_usage_unknown_count, 0);
        v_vertex_duplicate := COALESCE(v_cost.vertex_budget_duplicate_count, 0);
        v_vertex_mismatch := COALESCE(v_cost.vertex_budget_mismatch_count, 0);
        IF v_cost_usage_unknown THEN
            v_cost_missing := pg_catalog.array_append(v_cost_missing, 'COST_USAGE_UNKNOWN');
            v_gaps := pg_catalog.array_append(v_gaps, 'COST_USAGE_UNKNOWN');
        END IF;
        IF v_preflight_usage_unknown > 0 THEN
            v_cost_missing := pg_catalog.array_append(v_cost_missing, 'PREFLIGHT_USAGE_UNKNOWN');
            v_gaps := pg_catalog.array_append(v_gaps, 'PREFLIGHT_USAGE_UNKNOWN');
        END IF;
        IF v_provider_usage_unknown > 0 THEN
            v_cost_missing := pg_catalog.array_append(v_cost_missing, 'PROVIDER_USAGE_UNKNOWN');
            v_gaps := pg_catalog.array_append(v_gaps, 'PROVIDER_USAGE_UNKNOWN');
        END IF;
        IF v_ai_usage_unknown > 0 THEN
            v_cost_missing := pg_catalog.array_append(v_cost_missing, 'AI_USAGE_UNKNOWN');
            v_gaps := pg_catalog.array_append(v_gaps, 'AI_USAGE_UNKNOWN');
        END IF;
        IF v_vertex_unmatched + v_vertex_usage_unknown + v_vertex_duplicate
             + v_vertex_mismatch > 0 THEN
            v_cost_missing := pg_catalog.array_append(v_cost_missing, 'VERTEX_USAGE_GAP');
            v_gaps := pg_catalog.array_append(v_gaps, 'VERTEX_USAGE_GAP');
        END IF;
    END IF;
    v_cost_status := CASE
        WHEN v_cost.request_id IS NULL THEN 'not_available'
        WHEN v_cost_complete THEN 'complete'
        WHEN v_cost_usage_unknown THEN 'unknown'
        ELSE 'partial'
    END;
    IF NOT v_cost_usage_unknown THEN
        v_cost_known := v_total_known;
    END IF;
    v_cost_conservative := v_total_conservative;
    -- Resolve the authoritative order identity before hashing the request lineage.
    v_order_id := COALESCE(v_order_id, v_cost.order_id);

    -- Once terminal cleanup has removed source rows, carry the immutable rich evidence forward.
    v_reuse_latest := v_latest.request_id IS NOT NULL
        AND v_finalized
        AND v_followers.declared_count IS NULL
        AND v_following.declared_count IS NULL
        AND v_relationship.mutual_count IS NULL
        AND v_target_evidence.interactor_count IS NULL;
    IF v_reuse_latest THEN
        v_retained_source_set_hash := COALESCE(
            v_latest.stage_status->>'retainedEvidenceSourceSetHash',
            v_latest.source_set_hash
        );
        v_target_username := v_latest.target_instagram_id;
        v_target_profile_available := v_latest.target_profile_available;
        v_target_posts_available := v_latest.target_posts_available;
        v_target_post_count := v_latest.target_post_count;
        v_followers_declared := v_latest.followers_declared;
        v_followers_collected := v_latest.followers_collected;
        v_following_declared := v_latest.following_declared;
        v_following_collected := v_latest.following_collected;
        v_mutual_total := v_latest.mutual_total;
        v_mutual_list_hash := v_latest.mutual_list_hash;
        v_public_total := v_latest.public_total;
        v_private_total := v_latest.private_total;
        v_screened_total := v_latest.screened_total;
        v_candidate_declared := v_latest.candidate_declared;
        v_candidate_collected := v_latest.candidate_collected;
        v_interaction_declared := v_latest.interaction_declared;
        v_interaction_collected := v_latest.interaction_collected;
        v_target_likes_declared := v_latest.target_likes_declared;
        v_target_likes_collected := v_latest.target_likes_collected;
        v_target_comments_declared := v_latest.target_comments_declared;
        v_target_comments_collected := v_latest.target_comments_collected;
        v_candidate_likes_declared := v_latest.candidate_likes_declared;
        v_candidate_likes_collected := v_latest.candidate_likes_collected;
        v_candidate_likes_evidence_collected := v_latest.candidate_likes_evidence_collected;
        v_tags_declared := v_latest.tags_declared;
        v_tags_collected := v_latest.tags_collected;
        v_mentions_declared := v_latest.mentions_declared;
        v_mentions_collected := v_latest.mentions_collected;
        v_candidate_key_coverage := v_latest.candidate_key_coverage;
        v_finalized := TRUE;
        v_inconsistent := v_latest.completeness_status = 'inconsistent';
        v_relationship_ready := COALESCE(v_latest.stage_status->>'relationships' = 'true', FALSE);
        v_target_evidence_ready := COALESCE(v_latest.stage_status->>'targetEvidence' = 'true', FALSE);
        v_features_ready := COALESCE(v_latest.stage_status->>'candidateFeatures' = 'true', FALSE);
        v_scores_ready := COALESCE(v_latest.stage_status->>'riskScores' = 'true', FALSE);
        v_risk_policy := COALESCE(v_latest.risk_policy_version, v_risk_policy);
        v_ai_policy := COALESCE(v_latest.ai_policy_version, v_ai_policy);
        v_scheduler_policy := COALESCE(v_latest.scheduler_policy_version, v_scheduler_policy);
        SELECT COALESCE(pg_catalog.array_agg(code ORDER BY code), ARRAY[]::TEXT[])
          INTO v_gaps
          FROM pg_catalog.unnest(v_latest.gap_codes) AS gap(code)
         WHERE code NOT IN (
             'COST_SOURCE_MISSING', 'COST_USAGE_UNKNOWN', 'PREFLIGHT_USAGE_UNKNOWN',
             'PROVIDER_USAGE_UNKNOWN', 'AI_USAGE_UNKNOWN', 'VERTEX_USAGE_GAP'
         );
        v_gaps := v_gaps || v_cost_missing;
    END IF;

    -- Hash the canonical redacted projections of every copied immutable source field. Arrays are
    -- ordered by stable keys; JSONB itself canonicalizes object key order.
    IF v_reuse_latest THEN
        v_source_set_json := pg_catalog.jsonb_build_object(
            'request', pg_catalog.jsonb_build_object(
                'pipelineVersion', v_request.pipeline_version,
                'policyVersions', public.analysis_order_audit_redact_json(
                    COALESCE(v_request.policy_versions_snapshot, '{}'::JSONB)
                ),
                'preflightId', v_request.preflight_id,
                'planId', v_plan_id,
                'accessMode', v_access_mode,
                'orderId', v_order_id,
                'targetUsername', v_target_username,
                'targetProfileAvailable', v_target_profile_available,
                'targetPostsAvailable', v_target_posts_available,
                'targetPostCount', v_target_post_count,
                'finalized', v_finalized
            ),
            'retainedEvidenceSourceSetHash', v_retained_source_set_hash,
            'costSourceHash', v_cost_source_hash
        );
    ELSE
        v_source_set_json := pg_catalog.jsonb_build_object(
            'request', pg_catalog.jsonb_build_object(
                'pipelineVersion', v_request.pipeline_version,
                'policyVersions', public.analysis_order_audit_redact_json(
                    COALESCE(v_request.policy_versions_snapshot, '{}'::JSONB)
                ),
                'preflightId', v_request.preflight_id,
                'planId', v_plan_id,
                'accessMode', v_access_mode,
                'orderId', v_order_id,
                'targetUsername', v_target_username,
                'targetProfileAvailable', v_target_profile_available,
                'targetPostsAvailable', v_target_posts_available,
                'targetPostCount', v_target_post_count,
                'finalized', v_finalized
            ),
            'relationshipSides', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                        'side', side.side,
                        'jobKey', side.job_key,
                        'logicalProvider', side.provider,
                        'credentialSlot', side.provider_credential_slot,
                        'runId', side.provider_run_id,
                        'operationKey', side.provider_operation_key,
                        'inputHash', side.input_hash,
                        'resultHash', side.result_hash,
                        'declared', side.declared_count,
                        'collected', side.collected_count
                    ) ORDER BY side.side, side.job_key
                )
                FROM public.analysis_v2_relationship_sides AS side
                WHERE side.request_id = p_request_id
                  AND (
                      (side.side = 'followers' AND side.job_key = v_followers.job_key)
                      OR (side.side = 'following' AND side.job_key = v_following.job_key)
                  )
            ), '[]'::JSONB),
            'relationshipManifest', COALESCE((
                SELECT public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(manifest))
                FROM public.analysis_v2_relationship_manifests AS manifest
                WHERE manifest.request_id = p_request_id
                ORDER BY manifest.updated_at DESC NULLS LAST, manifest.job_key DESC
                LIMIT 1
            ), '{}'::JSONB),
            'relationshipRows', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(row))
                    ORDER BY row.side, row.ordinal, row.username
                )
                FROM public.analysis_v2_relationship_rows AS row
                WHERE row.request_id = p_request_id
                  AND (
                      v_relationship.job_key IS NULL
                      OR row.job_key = v_relationship.job_key
                  )
            ), '[]'::JSONB),
            'mutualRows', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(mutual))
                    ORDER BY mutual.mutual_ordinal, mutual.username
                )
                FROM public.analysis_v2_mutual_rows AS mutual
                WHERE mutual.request_id = p_request_id
                  AND (
                      v_relationship.job_key IS NULL
                      OR mutual.job_key = v_relationship.job_key
                  )
            ), '[]'::JSONB),
            'targetEvidenceManifest', COALESCE((
                SELECT public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(manifest))
                FROM public.analysis_v2_target_evidence_manifests AS manifest
                WHERE manifest.request_id = p_request_id
                ORDER BY manifest.updated_at DESC NULLS LAST, manifest.job_key DESC
                LIMIT 1
            ), '{}'::JSONB),
            'targetInteractors', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                        'jobKey', interaction.job_key,
                        'ordinal', interaction.ordinal,
                        'actorUsername', interaction.actor_username,
                        'postId', interaction.post_id,
                        'signal', interaction.signal,
                        'sourceInteractionId', interaction.source_interaction_id,
                        'occurredAt', interaction.occurred_at,
                        'commentText', interaction.comment_text,
                        'details', public.analysis_order_audit_redact_json(
                            NULLIF(to_jsonb(interaction)->'details', 'null'::JSONB)
                        )
                    ) ORDER BY interaction.ordinal, interaction.signal,
                        interaction.source_interaction_id
                )
                FROM public.analysis_target_interactors AS interaction
                WHERE interaction.request_id = p_request_id
                  AND (
                      v_target_evidence.job_key IS NULL
                      OR interaction.job_key = v_target_evidence.job_key
                  )
            ), '[]'::JSONB),
            'candidateFeatures', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(feature))
                    ORDER BY feature.instagram_id, feature.candidate_id
                )
                FROM public.analysis_v2_candidate_feature_rows AS feature
                WHERE feature.request_id = p_request_id
            ), '[]'::JSONB),
            'privateNames', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(private_name))
                    ORDER BY private_name.instagram_id, private_name.candidate_id
                )
                FROM public.analysis_v2_private_name_rows AS private_name
                WHERE private_name.request_id = p_request_id
            ), '[]'::JSONB),
            'scoreManifest', COALESCE((
                SELECT public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(manifest))
                FROM public.analysis_v2_candidate_score_manifests AS manifest
                WHERE manifest.request_id = p_request_id
                LIMIT 1
            ), '{}'::JSONB),
            'scoreRows', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(score))
                    ORDER BY score.candidate_id
                )
                FROM public.analysis_v2_candidate_score_rows AS score
                WHERE score.request_id = p_request_id
            ), '[]'::JSONB),
            'femaleResults', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(result))
                    ORDER BY result.sort_ordinal, result.candidate_id
                )
                FROM public.analysis_v2_female_results AS result
                WHERE result.request_id = p_request_id
            ), '[]'::JSONB),
            'aiCheckpoints', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    pg_catalog.jsonb_build_object(
                        'operationKey', checkpoint.operation_key,
                        'stage', checkpoint.stage,
                        'model', checkpoint.model_name,
                        'inputHash', checkpoint.input_hash,
                        'resultHash', checkpoint.result_hash,
                        'result', public.analysis_order_audit_redact_json(checkpoint.result_json)
                    ) ORDER BY checkpoint.operation_key
                )
                FROM public.analysis_v2_ai_result_checkpoints AS checkpoint
                WHERE checkpoint.request_id = p_request_id
            ), '[]'::JSONB),
            'reverseLikeManifest', COALESCE((
                SELECT public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(manifest))
                FROM public.analysis_v2_reverse_like_manifests AS manifest
                WHERE manifest.request_id = p_request_id
                LIMIT 1
            ), '{}'::JSONB),
            'reverseLikeRows', COALESCE((
                SELECT pg_catalog.jsonb_agg(
                    public.analysis_order_audit_redact_json(pg_catalog.to_jsonb(reverse))
                    ORDER BY reverse.candidate_id
                )
                FROM public.analysis_v2_reverse_like_rows AS reverse
                WHERE reverse.request_id = p_request_id
            ), '[]'::JSONB),
            'candidateKeyCoverage', v_candidate_key_coverage,
            'candidateFeatureManifestHash', public.analysis_order_audit_source_table_hash(
                'analysis_v2_candidate_feature_manifests', p_request_id
            ),
            'preliminaryScoreManifestHash', public.analysis_order_audit_source_table_hash(
                'analysis_v2_preliminary_score_manifests', p_request_id
            ),
            'partnerSafetyManifestHash', public.analysis_order_audit_source_table_hash(
                'analysis_v2_partner_safety_manifests', p_request_id
            ),
            'narrativeManifestHash', public.analysis_order_audit_source_table_hash(
                'analysis_v2_narrative_manifests', p_request_id
            ),
            'privateNameManifestHash', public.analysis_order_audit_source_table_hash(
                'analysis_v2_private_name_manifests', p_request_id
            ),
            'finalResolution', pg_catalog.jsonb_build_object(
                'summary', public.analysis_order_audit_redact_json(
                    COALESCE(pg_catalog.to_jsonb(v_summary), '{}'::JSONB)
                ),
                'finalizerInputHash', v_summary.finalizer_input_hash
            ),
            'costSourceHash', v_cost_source_hash
        );
        v_retained_source_set_hash := public.analysis_order_audit_digest(
            'analysis-order-audit-retained-v2' || E'\n'
            || (v_source_set_json - 'costSourceHash')::TEXT
        );
    END IF;
    v_source_set_hash := public.analysis_order_audit_digest(
        'analysis-order-audit-source-set-v2' || E'\n' || v_source_set_json::TEXT
    );

    SELECT bundle.* INTO v_existing
    FROM public.analysis_order_audit_bundles AS bundle
    WHERE bundle.request_id = p_request_id
      AND bundle.source_set_hash = v_source_set_hash;
    IF FOUND THEN
        UPDATE public.analysis_order_audit_assembly_queue
           SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
               updated_at = pg_catalog.clock_timestamp()
         WHERE request_id = p_request_id;
        IF v_queue_fenced AND v_finalized THEN
            PERFORM public.analysis_v2_purge_result_working_set(p_request_id, TRUE);
        END IF;
        RETURN public.analysis_order_audit_bundle_payload(v_existing);
    END IF;

    SELECT bundle.* INTO v_latest
    FROM public.analysis_order_audit_bundles AS bundle
    WHERE bundle.request_id = p_request_id
    ORDER BY bundle.version DESC
    LIMIT 1;
    v_version := COALESCE(v_latest.version, 0) + 1;
    v_previous_hash := v_latest.bundle_hash;
    v_bundle_hash := public.analysis_order_audit_digest(
        'analysis-order-audit-bundle-v2' || E'\n'
        || p_request_id::TEXT || E'\n' || v_version::TEXT || E'\n'
        || COALESCE(v_previous_hash, 'none') || E'\n' || v_source_set_hash
    );

    SELECT COALESCE(pg_catalog.array_agg(code ORDER BY code), ARRAY[]::TEXT[])
      INTO v_gaps
      FROM (
          SELECT DISTINCT code
          FROM pg_catalog.unnest(v_gaps) AS gap(code)
      ) AS unique_gaps;
    SELECT COALESCE(pg_catalog.array_agg(code ORDER BY code), ARRAY[]::TEXT[])
      INTO v_cost_missing
      FROM (
          SELECT DISTINCT code
          FROM pg_catalog.unnest(v_cost_missing) AS gap(code)
      ) AS unique_gaps;

    -- Only the safe lineage aliases are serialized. Source records and provider/account metadata
    -- never cross this boundary.
    SELECT COALESCE(pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
            'stage', run.stage,
            'logicalProvider', run.logical_provider,
            'credentialSlot', run.credential_slot,
            'runId', run.run_id,
            'operationKey', run.operation_key,
            'inputHash', run.input_hash,
            'resultHash', run.result_hash
        ) ORDER BY run.stage
    ), '[]'::JSONB)
      INTO v_provider_runs
      FROM (
          SELECT 'followers'::TEXT AS stage, v_followers.provider AS logical_provider,
                 v_followers.provider_credential_slot AS credential_slot,
                 v_followers.provider_run_id AS run_id,
                 v_followers.provider_operation_key AS operation_key,
                 v_followers.input_hash AS input_hash, v_followers.result_hash AS result_hash
          WHERE v_followers.provider_run_id IS NOT NULL
          UNION ALL
          SELECT 'following', v_following.provider, v_following.provider_credential_slot,
                 v_following.provider_run_id, v_following.provider_operation_key,
                 v_following.input_hash, v_following.result_hash
          WHERE v_following.provider_run_id IS NOT NULL
          UNION ALL
          SELECT 'target_likers', v_target_evidence.liker_source->>'provider',
                 v_target_evidence.liker_source->>'provider_credential_slot',
                 v_target_evidence.liker_source->>'provider_run_id',
                 v_target_evidence.liker_source->>'provider_operation_key',
                 v_target_evidence.liker_source->>'input_hash',
                 v_target_evidence.liker_source_hash
          WHERE v_target_evidence.liker_source->>'provider_run_id' IS NOT NULL
          UNION ALL
          SELECT 'target_comments', v_target_evidence.comment_source->>'provider',
                 v_target_evidence.comment_source->>'provider_credential_slot',
                 v_target_evidence.comment_source->>'provider_run_id',
                 v_target_evidence.comment_source->>'provider_operation_key',
                 v_target_evidence.comment_source->>'input_hash',
                 v_target_evidence.comment_source_hash
          WHERE v_target_evidence.comment_source->>'provider_run_id' IS NOT NULL
      ) AS run;

    v_stage_status := pg_catalog.jsonb_build_object(
        'relationships', v_relationship_ready,
        'targetEvidence', v_target_evidence_ready,
        'candidateFeatures', v_features_ready,
        'riskScores', v_scores_ready,
        'finalized', v_finalized,
        'cost', v_cost_status,
        'costSourceHash', v_cost_source_hash,
        'candidateKeyCoverage', v_candidate_key_coverage,
        'targetLikes', v_target_likes_declared IS NOT NULL,
        'targetComments', v_target_comments_declared IS NOT NULL,
        'candidateLikes', v_candidate_likes_declared IS NOT NULL,
        'tags', FALSE,
        'mentions', FALSE,
        'retainedEvidenceSourceSetHash', v_retained_source_set_hash
    );
    IF v_reuse_latest THEN
        v_provider_runs := v_latest.provider_runs;
        v_stage_status := pg_catalog.jsonb_set(
            COALESCE(v_latest.stage_status, '{}'::JSONB),
            ARRAY['costSourceHash'], pg_catalog.to_jsonb(v_cost_source_hash), TRUE
        );
        v_stage_status := pg_catalog.jsonb_set(
            v_stage_status, ARRAY['retainedEvidenceSourceSetHash'],
            pg_catalog.to_jsonb(v_retained_source_set_hash), TRUE
        );
        v_stage_status := pg_catalog.jsonb_set(
            v_stage_status, ARRAY['finalized'], pg_catalog.to_jsonb(v_finalized), TRUE
        );
    END IF;

    INSERT INTO public.analysis_order_audit_bundles (
        request_id, version, bundle_hash, previous_version_hash, source_set_hash,
        pipeline_version, pipeline_policy, risk_policy_version, ai_policy_version,
        scheduler_policy_version, plan_id, access_mode, order_id, preflight_id,
        target_instagram_id, target_profile_available, target_posts_available,
        target_post_count, followers_declared, followers_collected,
        following_declared, following_collected, mutual_total, mutual_list_hash,
        public_total, private_total, screened_total, candidate_declared,
        candidate_collected, interaction_declared, interaction_collected,
        target_likes_declared, target_likes_collected,
        target_comments_declared, target_comments_collected,
        candidate_likes_declared, candidate_likes_collected,
        candidate_likes_evidence_collected,
        tags_declared, tags_collected, mentions_declared, mentions_collected,
        candidate_key_coverage, provider_runs, stage_status,
        completeness_status, gap_codes, cost_currency, cost_status,
        cost_known_usd, cost_conservative_usd, total_known_cost_usd,
        total_conservative_cost_usd, cost_usage_unknown, usage_unknown,
        cost_missing_source_codes, cost_provenance, assembled_at
    ) VALUES (
        p_request_id, v_version, v_bundle_hash, v_previous_hash, v_source_set_hash,
        v_request.pipeline_version, public.analysis_order_audit_redact_json(
            COALESCE(v_request.policy_versions_snapshot, '{}'::JSONB)
        ), v_risk_policy, v_ai_policy, v_scheduler_policy, v_plan_id, v_access_mode,
        v_order_id, v_request.preflight_id, v_target_username,
        v_target_profile_available, v_target_posts_available, v_target_post_count,
        v_followers_declared, v_followers_collected, v_following_declared,
        v_following_collected, v_mutual_total, v_mutual_list_hash,
        v_public_total, v_private_total, v_screened_total, v_candidate_declared,
        v_candidate_collected, v_interaction_declared, v_interaction_collected,
        v_target_likes_declared, v_target_likes_collected,
        v_target_comments_declared, v_target_comments_collected,
        v_candidate_likes_declared, v_candidate_likes_collected,
        v_candidate_likes_evidence_collected,
        v_tags_declared, v_tags_collected, v_mentions_declared, v_mentions_collected,
        v_candidate_key_coverage, v_provider_runs, v_stage_status,
        CASE WHEN pg_catalog.cardinality(v_gaps) = 0 THEN 'complete'
             WHEN v_inconsistent THEN 'inconsistent' ELSE 'partial' END,
        v_gaps, 'USD', v_cost_status, v_cost_known, v_cost_conservative,
        v_total_known, v_total_conservative, v_cost_usage_unknown,
        v_cost_usage_unknown, v_cost_missing, v_cost_provenance, v_now
    ) ON CONFLICT (request_id, source_set_hash) DO NOTHING
      RETURNING * INTO v_existing;
    IF NOT FOUND THEN
        SELECT bundle.* INTO v_existing
        FROM public.analysis_order_audit_bundles AS bundle
        WHERE bundle.request_id = p_request_id
          AND bundle.source_set_hash = v_source_set_hash;
        UPDATE public.analysis_order_audit_assembly_queue
           SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
               updated_at = pg_catalog.clock_timestamp()
         WHERE request_id = p_request_id;
        IF v_queue_fenced AND v_finalized THEN
            PERFORM public.analysis_v2_purge_result_working_set(p_request_id, TRUE);
        END IF;
        RETURN public.analysis_order_audit_bundle_payload(v_existing);
    END IF;

    IF v_reuse_latest THEN
        INSERT INTO public.analysis_order_audit_candidates (
            request_id, version, candidate_id, username, mutual_ordinal,
            following_ordinal, is_private, is_verified, profile_available,
            profile_image_available, profile_failure_code, initial_gender_output,
            initial_gender_model, initial_gender_confidence, initial_gender_reason,
            final_gender_output, final_gender_model, final_gender_confidence,
            final_gender_reason, gender_operation_key, gender_result_hash,
            gender_resolution_operation_key, gender_resolution_result_hash,
            feature_operation_key, feature_result_hash, evidence_checkpoint_ids,
            account_context, final_inclusion_state, risk_components,
            risk_formula_version, pre_score, raw_score, public_score, final_score,
            risk_band, final_rank, featured_rank, recent_mutual_rank,
            partner_safety_operation_key, partner_safety_result_hash
        )
        SELECT p_request_id, v_version, candidate.candidate_id, candidate.username,
            candidate.mutual_ordinal, candidate.following_ordinal, candidate.is_private,
            candidate.is_verified, candidate.profile_available,
            candidate.profile_image_available, candidate.profile_failure_code,
            candidate.initial_gender_output, candidate.initial_gender_model,
            candidate.initial_gender_confidence, candidate.initial_gender_reason,
            candidate.final_gender_output, candidate.final_gender_model,
            candidate.final_gender_confidence, candidate.final_gender_reason,
            candidate.gender_operation_key, candidate.gender_result_hash,
            candidate.gender_resolution_operation_key, candidate.gender_resolution_result_hash,
            candidate.feature_operation_key, candidate.feature_result_hash,
            candidate.evidence_checkpoint_ids, candidate.account_context,
            candidate.final_inclusion_state, candidate.risk_components,
            candidate.risk_formula_version, candidate.pre_score, candidate.raw_score,
            candidate.public_score, candidate.final_score, candidate.risk_band,
            candidate.final_rank, candidate.featured_rank, candidate.recent_mutual_rank,
            candidate.partner_safety_operation_key, candidate.partner_safety_result_hash
        FROM public.analysis_order_audit_candidates AS candidate
        WHERE candidate.request_id = p_request_id
          AND candidate.version = v_latest.version;
    ELSE
        INSERT INTO public.analysis_order_audit_candidates (
            request_id, version, candidate_id, username, mutual_ordinal,
            following_ordinal, is_private, is_verified, profile_available,
            profile_image_available, profile_failure_code, initial_gender_output,
            initial_gender_model, initial_gender_confidence, initial_gender_reason,
            final_gender_output, final_gender_model, final_gender_confidence,
            final_gender_reason, gender_operation_key, gender_result_hash,
            gender_resolution_operation_key, gender_resolution_result_hash,
            feature_operation_key, feature_result_hash, evidence_checkpoint_ids,
            account_context, final_inclusion_state, risk_components,
            risk_formula_version, pre_score, raw_score, public_score, final_score,
            risk_band, final_rank, featured_rank, recent_mutual_rank,
            partner_safety_operation_key, partner_safety_result_hash
        )
        SELECT p_request_id, v_version,
            COALESCE(feature.candidate_id, private_name.candidate_id,
                'username:' || mutual.username),
            mutual.username, mutual.mutual_ordinal, mutual.following_ordinal,
            mutual.is_private, mutual.is_verified,
            (feature.candidate_id IS NOT NULL OR private_name.candidate_id IS NOT NULL)
                AND COALESCE(feature.terminal_classification, 'available')
                    NOT IN ('unavailable', 'media_unavailable'),
            (feature.profile_image_url IS NOT NULL OR private_name.profile_image_url IS NOT NULL),
            CASE WHEN feature.terminal_classification IN ('unavailable', 'media_unavailable')
                THEN feature.terminal_classification ELSE NULL END,
            CASE COALESCE(feature.baseline_classification, feature.terminal_classification)
                WHEN 'verified_female' THEN 'female'
                WHEN 'verified_non_female' THEN 'male'
                WHEN 'unavailable' THEN 'unavailable'
                WHEN 'media_unavailable' THEN 'unavailable'
                ELSE 'unknown'
            END,
            initial_checkpoint.model_name,
            initial_checkpoint.result_json->'assessment'->>'confidence',
            COALESCE(initial_checkpoint.result_json->>'routingReason',
                feature.classification_source),
            CASE COALESCE(feature.terminal_classification, feature.baseline_classification)
                WHEN 'verified_female' THEN 'female'
                WHEN 'verified_non_female' THEN 'male'
                WHEN 'unavailable' THEN 'unavailable'
                WHEN 'media_unavailable' THEN 'unavailable'
                ELSE 'unknown'
            END,
            final_checkpoint.model_name,
            final_checkpoint.result_json->'assessment'->>'confidence',
            COALESCE(final_checkpoint.result_json->>'reason',
                feature.gender_resolution_status, feature.classification_source),
            feature.gender_operation_key, feature.gender_result_hash,
            feature.gender_resolution_operation_key, feature.gender_resolution_result_hash,
            feature.feature_operation_key, feature.feature_result_hash,
            ARRAY_REMOVE(ARRAY[
                feature.gender_operation_key, feature.gender_resolution_operation_key,
                feature.feature_operation_key, score.partner_safety_operation_key
            ], NULL),
            CASE
                WHEN feature.media_context->>'accountContext' IN (
                    'personal', 'individual_creator', 'official_group_or_brand', 'uncertain'
                ) THEN feature.media_context->>'accountContext'
                ELSE 'uncertain'
            END,
            CASE
                WHEN mutual.is_private THEN 'private'
                WHEN result.candidate_id IS NOT NULL THEN 'included'
                WHEN feature.terminal_classification IN ('unavailable', 'media_unavailable')
                    THEN 'unavailable'
                WHEN feature.candidate_id IS NOT NULL THEN 'excluded'
                ELSE 'unknown'
            END,
            public.analysis_order_audit_redact_json(score.components),
            COALESCE(score_manifest.risk_policy_version, v_risk_policy),
            score.pre_score, score.raw_score, score.public_score,
            result.display_score, COALESCE(result.risk_band, score.risk_band),
            result.sort_ordinal, COALESCE(result.featured_rank, score.featured_rank),
            COALESCE(result.recent_mutual_rank, score.recent_mutual_rank),
            score.partner_safety_operation_key, score.partner_safety_result_hash
        FROM public.analysis_v2_mutual_rows AS mutual
        LEFT JOIN public.analysis_v2_candidate_feature_rows AS feature
          ON feature.request_id = mutual.request_id
         AND feature.instagram_id = mutual.username
        LEFT JOIN public.analysis_v2_private_name_rows AS private_name
          ON private_name.request_id = mutual.request_id
         AND private_name.instagram_id = mutual.username
        LEFT JOIN public.analysis_v2_ai_result_checkpoints AS initial_checkpoint
          ON initial_checkpoint.request_id = mutual.request_id
         AND initial_checkpoint.operation_key = feature.gender_operation_key
        LEFT JOIN public.analysis_v2_ai_result_checkpoints AS final_checkpoint
          ON final_checkpoint.request_id = mutual.request_id
         AND final_checkpoint.operation_key = feature.gender_resolution_operation_key
        LEFT JOIN public.analysis_v2_candidate_score_rows AS score
          ON score.request_id = mutual.request_id
         AND score.candidate_id = COALESCE(feature.candidate_id, private_name.candidate_id)
        LEFT JOIN public.analysis_v2_candidate_score_manifests AS score_manifest
          ON score_manifest.request_id = mutual.request_id
        LEFT JOIN public.analysis_v2_female_results AS result
          ON result.request_id = mutual.request_id
         AND result.candidate_id = score.candidate_id
        WHERE mutual.request_id = p_request_id
          AND (
              v_relationship.job_key IS NULL
              OR mutual.job_key = v_relationship.job_key
          );
    END IF;

    IF v_reuse_latest THEN
        INSERT INTO public.analysis_order_audit_interactions (
            request_id, version, ordinal, candidate_id, username, signal,
            source_post_id, evidence_id, occurred_at, comment_text, details,
            reverse_like_status, reverse_component_score,
            completeness_status, gap_codes
        )
        SELECT p_request_id, v_version, interaction.ordinal, interaction.candidate_id,
            interaction.username, interaction.signal, interaction.source_post_id,
            interaction.evidence_id, interaction.occurred_at, interaction.comment_text,
            interaction.details, interaction.reverse_like_status,
            interaction.reverse_component_score, interaction.completeness_status,
            interaction.gap_codes
        FROM public.analysis_order_audit_interactions AS interaction
        WHERE interaction.request_id = p_request_id
          AND interaction.version = v_latest.version;
    ELSE
        INSERT INTO public.analysis_order_audit_interactions (
            request_id, version, ordinal, candidate_id, username, signal,
            source_post_id, evidence_id, occurred_at, comment_text, details,
            reverse_like_status, reverse_component_score,
            completeness_status, gap_codes
        )
        SELECT p_request_id, v_version, interaction.ordinal,
            candidate.candidate_id, interaction.actor_username, interaction.signal,
            interaction.post_id, interaction.source_interaction_id, interaction.occurred_at,
            interaction.comment_text, public.analysis_order_audit_redact_json(
                NULLIF(to_jsonb(interaction)->'details', 'null'::JSONB)
            ),
            NULL, NULL,
            CASE
                WHEN interaction.signal = 'target_post_like'
                     AND v_target_likes_declared IS NOT NULL
                     AND v_target_likes_collected = v_target_likes_declared THEN 'complete'
                WHEN interaction.signal = 'target_post_comment'
                     AND v_target_comments_declared IS NOT NULL
                     AND v_target_comments_collected = v_target_comments_declared THEN 'complete'
                ELSE 'partial'
            END,
            CASE
                WHEN interaction.signal = 'target_post_like'
                     AND v_target_likes_declared IS NOT NULL
                     AND v_target_likes_collected <> v_target_likes_declared
                    THEN ARRAY['TARGET_LIKES_ROWS_GAP']::TEXT[]
                WHEN interaction.signal = 'target_post_comment'
                     AND v_target_comments_declared IS NOT NULL
                     AND v_target_comments_collected <> v_target_comments_declared
                    THEN ARRAY['TARGET_COMMENTS_ROWS_GAP']::TEXT[]
                ELSE ARRAY[]::TEXT[]
            END
        FROM public.analysis_target_interactors AS interaction
        LEFT JOIN public.analysis_order_audit_candidates AS candidate
          ON candidate.request_id = p_request_id
         AND candidate.version = v_version
         AND candidate.username = interaction.actor_username
        WHERE interaction.request_id = p_request_id
          AND (
              v_target_evidence.job_key IS NULL
              OR interaction.job_key = v_target_evidence.job_key
          )
        ORDER BY interaction.ordinal;

        INSERT INTO public.analysis_order_audit_interactions (
            request_id, version, ordinal, candidate_id, username, signal,
            source_post_id, evidence_id, occurred_at, comment_text, details,
            reverse_like_status, reverse_component_score,
            completeness_status, gap_codes
        )
        SELECT p_request_id, v_version,
            (v_target_interaction_max_ordinal + row_number() OVER (
                ORDER BY reverse.candidate_id, refs.value
            ))::INTEGER,
            candidate.candidate_id, candidate.username, 'candidate_post_like', NULL,
            refs.value, NULL, NULL,
            public.analysis_order_audit_redact_json(
                pg_catalog.jsonb_build_object(
                    'reverseLikeStatus', reverse.reverse_like_status,
                    'componentScore', reverse.component_score
                )
            ),
            reverse.reverse_like_status, reverse.component_score,
            CASE WHEN v_reverse_manifest_exists THEN 'complete' ELSE 'partial' END,
            CASE WHEN v_reverse_manifest_exists THEN ARRAY[]::TEXT[]
                ELSE ARRAY['CANDIDATE_LIKES_SOURCE_MISSING']::TEXT[] END
        FROM public.analysis_v2_reverse_like_rows AS reverse
        CROSS JOIN LATERAL unnest(reverse.evidence_ref_ids) AS refs(value)
        JOIN public.analysis_order_audit_candidates AS candidate
          ON candidate.request_id = p_request_id
         AND candidate.version = v_version
         AND candidate.candidate_id = reverse.candidate_id
        WHERE reverse.request_id = p_request_id;
    END IF;

    UPDATE public.analysis_order_audit_assembly_queue
       SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
           last_error_code = NULL, last_error_at = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE request_id = p_request_id;

    IF v_queue_fenced AND v_finalized THEN
        PERFORM public.analysis_v2_purge_result_working_set(p_request_id, TRUE);
    END IF;
    RETURN public.analysis_order_audit_bundle_payload(v_existing);
EXCEPTION WHEN OTHERS THEN
    BEGIN
        UPDATE public.analysis_order_audit_assembly_queue
           SET status = 'failed',
               next_attempt_at = pg_catalog.clock_timestamp() + INTERVAL '30 seconds',
               lease_token = NULL, lease_expires_at = NULL,
               last_error_code = CASE
                   WHEN SQLSTATE = 'P0001' THEN SQLERRM
                   ELSE 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED'
               END,
               last_error_at = pg_catalog.clock_timestamp(),
               updated_at = pg_catalog.clock_timestamp()
         WHERE request_id = p_request_id;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;
    IF v_finalized THEN
        BEGIN
            PERFORM public.analysis_order_audit_purge_fence(
                p_request_id, 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED'
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
    RAISE;
END;
$$;

-- Install the trigger implementations after all hardening helpers exist. Existing trigger objects
-- keep their names and therefore continue to use these replaced function bodies.
CREATE OR REPLACE FUNCTION public.analysis_order_audit_enqueue_from_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF NEW.pipeline_version = 'v2'
       AND NEW.status IN ('completed', 'failed') THEN
        BEGIN
            PERFORM public.enqueue_analysis_order_audit_bundle(NEW.id);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING USING MESSAGE = 'ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED';
        END;
        BEGIN
            PERFORM public.assemble_analysis_order_audit_bundle(NEW.id);
            PERFORM public.analysis_v2_purge_result_working_set(NEW.id, TRUE);
        EXCEPTION WHEN OTHERS THEN
            BEGIN
                PERFORM public.analysis_order_audit_purge_fence(
                    NEW.id, 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED'
                );
            EXCEPTION WHEN OTHERS THEN
                NULL;
            END;
            RAISE WARNING USING MESSAGE = 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED';
        END;
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.analysis_order_audit_enqueue_from_request_id()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    -- enqueue_analysis_order_audit_bundle compares costSourceHash with the latest immutable
    -- parent. INSERT and UPDATE both reach that comparison; unchanged cost keeps queue status = 'completed'
    -- while an IS DISTINCT FROM cost source reopens exactly one queue.
    IF TG_OP = 'INSERT'
       OR (TG_OP = 'UPDATE' AND NEW.request_id IS DISTINCT FROM NULL) THEN
        BEGIN
            PERFORM public.enqueue_analysis_order_audit_bundle(NEW.request_id);
        EXCEPTION WHEN OTHERS THEN
            RAISE WARNING USING MESSAGE = 'ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED';
        END;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER enqueue_analysis_order_audit_after_request_finalization
AFTER INSERT OR UPDATE OF status ON public.analysis_requests
FOR EACH ROW EXECUTE FUNCTION public.analysis_order_audit_enqueue_from_request();

CREATE TRIGGER enqueue_analysis_order_audit_after_result_summary
AFTER INSERT OR UPDATE ON public.analysis_v2_result_summaries
FOR EACH ROW EXECUTE FUNCTION public.analysis_order_audit_enqueue_from_request_id();

CREATE TRIGGER enqueue_analysis_order_audit_after_cost_snapshot
AFTER INSERT OR UPDATE ON public.analysis_v2_cost_rollup_snapshots
FOR EACH ROW EXECUTE FUNCTION public.analysis_order_audit_enqueue_from_request_id();

CREATE TRIGGER enqueue_analysis_order_audit_after_cost_attribution
AFTER INSERT OR UPDATE ON public.analysis_v2_cost_attributions
FOR EACH ROW EXECUTE FUNCTION public.analysis_order_audit_enqueue_from_request_id();

REVOKE ALL ON FUNCTION public.enqueue_analysis_order_audit_bundle(UUID),
    public.assemble_analysis_order_audit_bundle(UUID),
    public.load_analysis_order_audit_bundle(UUID, TEXT, INTEGER, INTEGER, TEXT),
    public.list_analysis_order_audit_bundle_recovery(INTEGER),
    public.claim_analysis_order_audit_bundle(UUID, INTEGER),
    public.release_analysis_order_audit_bundle(UUID, UUID, TEXT, BOOLEAN),
    public.analysis_order_audit_redact_json(JSONB),
    public.analysis_order_audit_enqueue_from_request(),
    public.analysis_order_audit_enqueue_from_request_id()
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_analysis_order_audit_bundle(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.assemble_analysis_order_audit_bundle(UUID)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_order_audit_bundle(UUID, TEXT, INTEGER, INTEGER, TEXT)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_order_audit_bundle_recovery(INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_order_audit_bundle(UUID, INTEGER)
    TO service_role;
GRANT EXECUTE ON FUNCTION public.release_analysis_order_audit_bundle(UUID, UUID, TEXT, BOOLEAN)
    TO service_role;
