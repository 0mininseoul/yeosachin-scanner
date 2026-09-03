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
             'preflightid', 'preflight_id', 'actor', 'credentialslot',
             'credential_slot', 'secret', 'token'
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

CREATE OR REPLACE FUNCTION public.enqueue_analysis_order_audit_bundle(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_REQUEST', ERRCODE = 'P0001';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.analysis_requests AS request
        WHERE request.id = p_request_id
          AND request.pipeline_version = 'v2'
    ) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.analysis_order_audit_assembly_queue (
        request_id, status, attempt_count, next_attempt_at,
        lease_token, lease_expires_at, last_error_code, last_error_at,
        updated_at
    ) VALUES (
        p_request_id, 'queued', 0, pg_catalog.clock_timestamp(),
        NULL, NULL, NULL, NULL, pg_catalog.clock_timestamp()
    )
    ON CONFLICT (request_id) DO UPDATE SET
        status = 'queued',
        next_attempt_at = pg_catalog.clock_timestamp(),
        lease_token = NULL,
        lease_expires_at = NULL,
        last_error_code = NULL,
        last_error_at = NULL,
        updated_at = pg_catalog.clock_timestamp();

    RETURN pg_catalog.jsonb_build_object(
        'status', 'queued',
        'requestId', p_request_id::TEXT
    );
END;
$$;

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
        'gapCodes', to_jsonb(p_bundle.gap_codes),
        'pipelineVersion', p_bundle.pipeline_version,
        'pipelinePolicy', p_bundle.pipeline_policy,
        'riskPolicyVersion', p_bundle.risk_policy_version,
        'aiPolicyVersion', p_bundle.ai_policy_version,
        'schedulerPolicyVersion', p_bundle.scheduler_policy_version,
        'planId', p_bundle.plan_id,
        'accessMode', p_bundle.access_mode,
        'orderId', NULL,
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
            'listHash', p_bundle.mutual_list_hash
        ),
        'interactions', pg_catalog.jsonb_build_object(
            'declared', p_bundle.interaction_declared,
            'collected', p_bundle.interaction_collected
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
            'missingSourceCodes', to_jsonb(p_bundle.cost_missing_source_codes),
            'provenance', public.analysis_order_audit_redact_json(p_bundle.cost_provenance)
        ),
        'usageUnknown', p_bundle.usage_unknown
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_bundle_payload(
    public.analysis_order_audit_bundles
) FROM PUBLIC, anon, authenticated, service_role;

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
    v_feature_collected INTEGER := 0;
    v_score_collected INTEGER := 0;
    v_candidate_declared INTEGER := 0;
    v_candidate_collected INTEGER := 0;
    v_interaction_declared INTEGER := 0;
    v_interaction_collected INTEGER := 0;
    v_mutual_list_hash VARCHAR(64);
    v_source_hashes JSONB;
    v_source_set_hash VARCHAR(64);
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
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_REQUEST', ERRCODE = 'P0001';
    END IF;

    -- This lock serializes assemblers for one request. It is deliberately request-scoped,
    -- allowing large orders to assemble independently without a table-wide lock.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_request_id::TEXT, 0)
    );

    SELECT request.*
      INTO v_request
      FROM public.analysis_requests AS request
     WHERE request.id = p_request_id
       AND request.pipeline_version = 'v2';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.analysis_order_audit_assembly_queue(request_id, status, updated_at)
    VALUES (p_request_id, 'processing', v_now)
    ON CONFLICT (request_id) DO UPDATE SET
        status = 'processing',
        lease_token = NULL,
        lease_expires_at = NULL,
        updated_at = v_now;

    SELECT summary.*
      INTO v_summary
      FROM public.analysis_v2_result_summaries AS summary
     WHERE summary.request_id = p_request_id;

    SELECT preflight.*
      INTO v_preflight
      FROM public.analysis_preflights AS preflight
     WHERE preflight.id = v_request.preflight_id;

    SELECT earlybird_order.id
      INTO v_order_id
      FROM public.earlybird_orders AS earlybird_order
     WHERE earlybird_order.result_request_id = p_request_id
     ORDER BY earlybird_order.id
     LIMIT 1;

    v_target_username := COALESCE(
        NULLIF(v_summary.target_instagram_id, ''),
        NULLIF(v_preflight.target_instagram_id, '')
    );
    v_target_profile_available := (
        NULLIF(v_summary.target_profile_image_url, '') IS NOT NULL
        OR NULLIF(v_preflight.target_profile_image_url, '') IS NOT NULL
    );
    v_target_posts_available := FALSE;
    v_plan_id := COALESCE(NULLIF(v_request.selected_plan_id_snapshot, ''), v_summary.plan_id);
    v_access_mode := v_request.plan_access_mode_snapshot;
    v_risk_policy := COALESCE(
        v_request.policy_versions_snapshot->>'risk',
        v_summary.score_policy_version
    );
    v_ai_policy := v_request.policy_versions_snapshot->>'aiStage';
    v_scheduler_policy := v_request.policy_versions_snapshot->>'scheduler';

    IF v_target_username IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'TARGET_ID_MISSING');
    END IF;
    IF NOT v_target_profile_available THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'TARGET_PROFILE_MISSING');
    END IF;
    IF v_summary.request_id IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'RESULT_SUMMARY_MISSING');
    ELSE
        v_finalized := v_request.status IN ('completed', 'failed');
    END IF;

    SELECT side.declared_count, side.collected_count, side.result_hash,
           side.provider, side.provider_run_id, side.provider_operation_key
      INTO v_followers
      FROM public.analysis_v2_relationship_sides AS side
     WHERE side.request_id = p_request_id
       AND side.side = 'followers'
     ORDER BY side.updated_at DESC NULLS LAST
     LIMIT 1;
    SELECT side.declared_count, side.collected_count, side.result_hash,
           side.provider, side.provider_run_id, side.provider_operation_key
      INTO v_following
      FROM public.analysis_v2_relationship_sides AS side
     WHERE side.request_id = p_request_id
       AND side.side = 'following'
     ORDER BY side.updated_at DESC NULLS LAST
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
           v_followers.collected_count <> v_followers.declared_count
           OR v_following.collected_count <> v_following.declared_count
       ) THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'RELATIONSHIP_COUNT_GAP');
    END IF;

    SELECT manifest.job_key, manifest.result_hash, manifest.mutual_count, manifest.public_count,
           manifest.private_count, manifest.detailed_public_count
      INTO v_relationship
      FROM public.analysis_v2_relationship_manifests AS manifest
     WHERE manifest.request_id = p_request_id
     ORDER BY manifest.updated_at DESC NULLS LAST
     LIMIT 1;
    IF v_relationship.mutual_count IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'MUTUAL_MANIFEST_MISSING');
    ELSE
        v_mutual_total := v_relationship.mutual_count;
        v_public_total := v_relationship.public_count;
        v_private_total := v_relationship.private_count;
        v_screened_total := v_relationship.detailed_public_count;
    END IF;

    SELECT target_manifest.job_key, target_manifest.result_hash, target_manifest.interactor_count,
           target_manifest.liker_count, target_manifest.comment_count
      INTO v_target_evidence
      FROM public.analysis_v2_target_evidence_manifests AS target_manifest
     WHERE target_manifest.request_id = p_request_id
     ORDER BY target_manifest.updated_at DESC NULLS LAST
     LIMIT 1;
    IF v_target_evidence.interactor_count IS NULL THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'TARGET_POSTS_MISSING');
    ELSE
        v_target_posts_available := TRUE;
        v_target_post_count := v_target_evidence.interactor_count;
        v_interaction_declared := v_target_evidence.interactor_count;
        v_target_evidence_ready := TRUE;
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
      INTO v_mutual_rows_collected
      FROM public.analysis_v2_mutual_rows AS mutual
     WHERE mutual.request_id = p_request_id
       AND (
           v_relationship.job_key IS NULL
           OR mutual.job_key = v_relationship.job_key
       );
    IF v_relationship.mutual_count IS NOT NULL THEN
        v_candidate_declared := v_relationship.mutual_count;
        IF v_mutual_rows_collected <> v_candidate_declared THEN
            v_gaps := pg_catalog.array_append(v_gaps, 'MUTUAL_ROWS_MISSING');
            v_inconsistent := TRUE;
        END IF;
    ELSE
        v_candidate_declared := v_mutual_rows_collected;
        IF v_mutual_rows_collected = 0 THEN
            v_gaps := pg_catalog.array_append(v_gaps, 'MUTUAL_ROWS_MISSING');
        END IF;
    END IF;
    IF v_mutual_rows_collected > 0 THEN
        v_mutual_list_hash := public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.string_agg(
                mutual.username || E'\t' || mutual.mutual_ordinal::TEXT
                    || E'\t' || mutual.following_ordinal::TEXT,
                E'\n' ORDER BY mutual.mutual_ordinal
            )
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND (
                  v_relationship.job_key IS NULL
                  OR mutual.job_key = v_relationship.job_key
              )
        ), ''));
    ELSE
        v_mutual_list_hash := public.analysis_order_audit_digest('');
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
      INTO v_feature_collected
      FROM public.analysis_v2_candidate_feature_rows AS feature
     WHERE feature.request_id = p_request_id;
    v_features_ready := v_feature_collected >= v_public_total;
    IF v_public_total > 0 AND NOT v_features_ready THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'CANDIDATE_FEATURES_MISSING');
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
      INTO v_interaction_collected
      FROM public.analysis_target_interactors AS interaction
     WHERE interaction.request_id = p_request_id
       AND (
           v_target_evidence.job_key IS NULL
           OR interaction.job_key = v_target_evidence.job_key
       );
    IF v_target_evidence.interactor_count IS NOT NULL
       AND v_interaction_collected <> v_interaction_declared THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'INTERACTION_ROWS_GAP');
        v_inconsistent := TRUE;
    END IF;

    SELECT pg_catalog.count(*)::INTEGER
      INTO v_score_collected
      FROM public.analysis_v2_candidate_score_rows AS score
     WHERE score.request_id = p_request_id;
    v_scores_ready := v_score_collected >= COALESCE(v_summary.female_count, 0);
    IF COALESCE(v_summary.female_count, 0) > 0 AND NOT v_scores_ready THEN
        v_gaps := pg_catalog.array_append(v_gaps, 'RISK_SCORES_MISSING');
    END IF;

    SELECT rollup.*
      INTO v_cost
      FROM public.analysis_v2_cost_rollups AS rollup
     WHERE rollup.request_id = p_request_id
     LIMIT 1;
    IF v_cost.request_id IS NULL THEN
        v_cost_missing := pg_catalog.array_append(v_cost_missing, 'COST_SOURCE_MISSING');
        v_gaps := pg_catalog.array_append(v_gaps, 'COST_SOURCE_MISSING');
    ELSE
        v_total_known := v_cost.total_known_cost_usd;
        v_total_conservative := v_cost.total_conservative_cost_usd;
        v_cost_usage_unknown := COALESCE(v_cost.usage_unknown, TRUE);
        v_cost_complete := COALESCE(v_cost.directly_attributable_cost_complete, FALSE)
            AND NOT v_cost_usage_unknown;
        v_cost_provenance := COALESCE(v_cost.cost_provenance, '{}'::JSONB);
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
        IF v_vertex_unmatched + v_vertex_usage_unknown + v_vertex_duplicate + v_vertex_mismatch > 0 THEN
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

    -- A source-set hash covers every authoritative manifest and the live cost snapshot. Its
    -- JSON object key order is canonical, so repeated assemblers get exactly one version.
    v_source_hashes := pg_catalog.jsonb_build_object(
        'followers', COALESCE(v_followers.result_hash, 'missing'),
        'following', COALESCE(v_following.result_hash, 'missing'),
        'relationships', COALESCE(v_relationship.result_hash, 'missing'),
        'mutualList', v_mutual_list_hash,
        'targetEvidence', COALESCE(v_target_evidence.result_hash, 'missing'),
        'features', COALESCE((
            SELECT public.analysis_order_audit_digest(COALESCE(
                pg_catalog.string_agg(feature.gender_result_hash, E'\n' ORDER BY feature.candidate_id),
                ''
            ))
            FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
        ), 'missing'),
        'scores', COALESCE((
            SELECT public.analysis_order_audit_digest(COALESCE(
                pg_catalog.string_agg(score.candidate_id || ':' || score.display_score::TEXT, E'\n' ORDER BY score.candidate_id),
                ''
            ))
            FROM public.analysis_v2_candidate_score_rows AS score
            WHERE score.request_id = p_request_id
        ), 'missing'),
        'finalizer', COALESCE(v_summary.finalizer_input_hash, 'missing'),
        'interactions', COALESCE((
            SELECT public.analysis_order_audit_digest(COALESCE(
                pg_catalog.string_agg(interaction.signal || ':' || interaction.source_interaction_id, E'\n' ORDER BY interaction.ordinal),
                ''
            ))
            FROM public.analysis_target_interactors AS interaction
            WHERE interaction.request_id = p_request_id
              AND (
                  v_target_evidence.job_key IS NULL
                  OR interaction.job_key = v_target_evidence.job_key
              )
        ), 'missing'),
        'cost', COALESCE(v_cost::TEXT, 'missing')
    );
    v_source_set_hash := public.analysis_order_audit_digest(
        'analysis-order-audit-source-set-v1' || E'\n' || v_source_hashes::TEXT
    );

    SELECT bundle.*
      INTO v_existing
      FROM public.analysis_order_audit_bundles AS bundle
     WHERE bundle.request_id = p_request_id
       AND bundle.source_set_hash = v_source_set_hash;
    IF FOUND THEN
        UPDATE public.analysis_order_audit_assembly_queue
           SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
               updated_at = pg_catalog.clock_timestamp()
         WHERE request_id = p_request_id;
        RETURN public.analysis_order_audit_bundle_payload(v_existing);
    END IF;

    SELECT bundle.*
      INTO v_latest
      FROM public.analysis_order_audit_bundles AS bundle
     WHERE bundle.request_id = p_request_id
     ORDER BY bundle.version DESC
     LIMIT 1;
    v_version := COALESCE(v_latest.version, 0) + 1;
    v_previous_hash := v_latest.bundle_hash;
    v_bundle_hash := public.analysis_order_audit_digest(
        'analysis-order-audit-bundle-v1' || E'\n'
        || p_request_id::TEXT || E'\n' || v_version::TEXT || E'\n'
        || COALESCE(v_previous_hash, 'none') || E'\n' || v_source_set_hash
    );

    -- Keep repeated gap codes out of the immutable payload while retaining every reason.
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

    INSERT INTO public.analysis_order_audit_bundles (
        request_id, version, bundle_hash, previous_version_hash, source_set_hash,
        pipeline_version, pipeline_policy, risk_policy_version, ai_policy_version,
        scheduler_policy_version, plan_id, access_mode, order_id, preflight_id,
        target_instagram_id, target_profile_available, target_posts_available,
        target_post_count, followers_declared, followers_collected,
        following_declared, following_collected, mutual_total, mutual_list_hash,
        public_total, private_total, screened_total, candidate_declared,
        candidate_collected, interaction_declared, interaction_collected,
        provider_runs, stage_status, completeness_status, gap_codes,
        cost_currency, cost_status, cost_known_usd, cost_conservative_usd,
        total_known_cost_usd, total_conservative_cost_usd, cost_usage_unknown,
        usage_unknown, cost_missing_source_codes, cost_provenance, assembled_at
    ) VALUES (
        p_request_id, v_version, v_bundle_hash, v_previous_hash, v_source_set_hash,
        v_request.pipeline_version, COALESCE(v_request.policy_versions_snapshot, '{}'::JSONB),
        v_risk_policy, v_ai_policy, v_scheduler_policy, v_plan_id, v_access_mode,
        v_order_id, v_request.preflight_id, v_target_username,
        v_target_profile_available, v_target_posts_available, v_target_post_count,
        v_followers_declared, v_followers_collected, v_following_declared,
        v_following_collected, v_mutual_total, v_mutual_list_hash,
        v_public_total, v_private_total, v_screened_total, v_mutual_total,
        v_mutual_rows_collected, v_interaction_declared, v_interaction_collected,
        CASE
            WHEN v_followers.provider_run_id IS NULL
             AND v_following.provider_run_id IS NULL THEN '[]'::JSONB
            WHEN v_followers.provider_run_id IS NULL THEN pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'stage', 'following', 'providerAlias', v_following.provider,
                    'runId', v_following.provider_run_id,
                    'operationKey', v_following.provider_operation_key,
                    'resultHash', v_following.result_hash
                )
            )
            WHEN v_following.provider_run_id IS NULL THEN pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'stage', 'followers', 'providerAlias', v_followers.provider,
                    'runId', v_followers.provider_run_id,
                    'operationKey', v_followers.provider_operation_key,
                    'resultHash', v_followers.result_hash
                )
            )
            ELSE pg_catalog.jsonb_build_array(
                pg_catalog.jsonb_build_object(
                    'stage', 'followers', 'providerAlias', v_followers.provider,
                    'runId', v_followers.provider_run_id,
                    'operationKey', v_followers.provider_operation_key,
                    'resultHash', v_followers.result_hash
                ),
                pg_catalog.jsonb_build_object(
                    'stage', 'following', 'providerAlias', v_following.provider,
                    'runId', v_following.provider_run_id,
                    'operationKey', v_following.provider_operation_key,
                    'resultHash', v_following.result_hash
                )
            )
        END,
        pg_catalog.jsonb_build_object(
            'relationships', v_relationship_ready,
            'targetEvidence', v_target_evidence_ready,
            'candidateFeatures', v_features_ready,
            'riskScores', v_scores_ready,
            'finalized', v_finalized,
            'cost', v_cost_status
        ),
        CASE WHEN pg_catalog.cardinality(v_gaps) = 0 THEN 'complete'
             WHEN v_inconsistent THEN 'inconsistent' ELSE 'partial' END,
        v_gaps, 'USD', v_cost_status, v_cost_known, v_cost_conservative,
        v_total_known, v_total_conservative, v_cost_usage_unknown,
        v_cost_usage_unknown, v_cost_missing, v_cost_provenance, v_now
    ) ON CONFLICT (request_id, source_set_hash) DO NOTHING
      RETURNING * INTO v_existing;

    -- Candidates are copied from the mutual intersection and joined to every authoritative
    -- feature/score/checkpoint row. A missing feature is retained as an explicit unknown.
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
    SELECT
        p_request_id, v_version,
        COALESCE(feature.candidate_id, private_name.candidate_id, 'username:' || mutual.username),
        mutual.username, mutual.mutual_ordinal, mutual.following_ordinal,
        mutual.is_private, mutual.is_verified,
        (feature.candidate_id IS NOT NULL OR private_name.candidate_id IS NOT NULL)
            AND COALESCE(feature.terminal_classification, 'available') NOT IN ('unavailable', 'media_unavailable'),
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
        COALESCE(
            initial_checkpoint.result_json->>'routingReason',
            feature.classification_source
        ),
        CASE COALESCE(feature.terminal_classification, feature.baseline_classification)
            WHEN 'verified_female' THEN 'female'
            WHEN 'verified_non_female' THEN 'male'
            WHEN 'unavailable' THEN 'unavailable'
            WHEN 'media_unavailable' THEN 'unavailable'
            ELSE 'unknown'
        END,
        final_checkpoint.model_name,
        final_checkpoint.result_json->'assessment'->>'confidence',
        COALESCE(
            final_checkpoint.result_json->>'reason',
            feature.gender_resolution_status,
            feature.classification_source
        ),
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
            WHEN feature.terminal_classification IN ('unavailable', 'media_unavailable') THEN 'unavailable'
            WHEN feature.candidate_id IS NOT NULL THEN 'excluded'
            ELSE 'unknown'
        END,
        score.components,
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

    -- Target evidence is retained verbatim only in the bounded operator copy. `to_jsonb(row)`
    -- allows later source migrations to add comment-detail columns without coupling this SQL to
    -- a particular working-set shape; absent details remain NULL rather than invented.
    INSERT INTO public.analysis_order_audit_interactions (
        request_id, version, ordinal, candidate_id, username, signal,
        source_post_id, evidence_id, occurred_at, comment_text, details,
        completeness_status, gap_codes
    )
    SELECT
        p_request_id, v_version, interaction.ordinal,
        candidate.candidate_id, interaction.actor_username, interaction.signal,
        interaction.post_id, interaction.source_interaction_id, interaction.occurred_at,
        interaction.comment_text, (to_jsonb(interaction)->'details'),
        'complete', ARRAY[]::TEXT[]
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

    -- Reverse-like evidence is normalized as candidate-post likes. Tags/mentions are represented
    -- by their authoritative score components when the source ledger has no separate row.
    INSERT INTO public.analysis_order_audit_interactions (
        request_id, version, ordinal, candidate_id, username, signal,
        source_post_id, evidence_id, occurred_at, comment_text, details,
        completeness_status, gap_codes
    )
    SELECT p_request_id, v_version, 1000 + row_number() OVER (ORDER BY reverse.candidate_id, refs.value),
        candidate.candidate_id, candidate.username, 'candidate_post_like', NULL,
        refs.value, NULL, NULL, NULL, 'complete', ARRAY[]::TEXT[]
    FROM public.analysis_v2_reverse_like_rows AS reverse
    CROSS JOIN LATERAL unnest(reverse.evidence_ref_ids) AS refs(value)
    JOIN public.analysis_order_audit_candidates AS candidate
      ON candidate.request_id = p_request_id
     AND candidate.version = v_version
     AND candidate.candidate_id = reverse.candidate_id
    WHERE reverse.request_id = p_request_id;

    v_interaction_collected := (
        SELECT pg_catalog.count(*)::INTEGER
        FROM public.analysis_order_audit_interactions AS interaction
        WHERE interaction.request_id = p_request_id AND interaction.version = v_version
    );
    UPDATE public.analysis_order_audit_assembly_queue
       SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
           updated_at = pg_catalog.clock_timestamp()
     WHERE request_id = p_request_id;
    RETURN public.analysis_order_audit_bundle_payload(v_existing);
EXCEPTION WHEN OTHERS THEN
    UPDATE public.analysis_order_audit_assembly_queue
       SET status = 'failed', next_attempt_at = pg_catalog.clock_timestamp() + INTERVAL '30 seconds',
           lease_token = NULL, lease_expires_at = NULL,
           last_error_code = CASE
               WHEN SQLSTATE = 'P0001' THEN SQLERRM
               ELSE 'ANALYSIS_ORDER_AUDIT_ASSEMBLY_FAILED'
           END,
           last_error_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
     WHERE request_id = p_request_id;
    RAISE;
END;
$$;

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
            -- Queue writes are advisory at a durable customer-result boundary. A later recovery
            -- sweep or application hook must be able to retry without rolling back this DML.
            RAISE WARNING USING MESSAGE = 'ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED';
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
    BEGIN
        PERFORM public.enqueue_analysis_order_audit_bundle(NEW.request_id);
    EXCEPTION WHEN OTHERS THEN
        -- Cost/result writes remain authoritative even when the audit queue is temporarily down.
        RAISE WARNING USING MESSAGE = 'ANALYSIS_ORDER_AUDIT_ENQUEUE_FAILED';
    END;
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
