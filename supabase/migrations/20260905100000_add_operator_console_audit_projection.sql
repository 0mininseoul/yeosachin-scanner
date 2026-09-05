-- MIGRATION_PREDECESSOR=20260904130000
-- Additive operator projection for the permanent order audit bundle. The source tables and
-- immutable audit rows remain unchanged; this migration only exposes bounded, redacted metadata.
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
            WHERE version = '20260904130000'
        ) INTO v_predecessor_present;
    END IF;
    IF NOT v_predecessor_present THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_PROJECTION_PREDECESSOR_MISSING', ERRCODE = 'P0001';
    END IF;
END;
$migration$;

-- Counts are calculated from the immutable child copy, so old bundles and post-purge bundles
-- receive the same truthful projection without mutating retained rows.
CREATE OR REPLACE FUNCTION public.analysis_order_audit_summary_counts(
    p_request_id UUID,
    p_version INTEGER
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'gender', pg_catalog.jsonb_build_object(
            'initialResolved', COUNT(*) FILTER (
                WHERE candidate.initial_gender_output IN ('female', 'male')
            )::INTEGER,
            'finalResolved', COUNT(*) FILTER (
                WHERE candidate.final_gender_output IN ('female', 'male')
            )::INTEGER
        ),
        'risk', pg_catalog.jsonb_build_object(
            'declared', COUNT(*) FILTER (
                WHERE NOT candidate.is_private
                  AND candidate.final_gender_output = 'female'
            )::INTEGER,
            'collected', COUNT(*) FILTER (
                WHERE NOT candidate.is_private
                  AND candidate.final_gender_output = 'female'
                  AND candidate.final_score IS NOT NULL
            )::INTEGER
        )
    )
    FROM public.analysis_order_audit_candidates AS candidate
    WHERE candidate.request_id = p_request_id
      AND candidate.version = p_version;
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_summary_counts(UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_order_audit_retention_payload(
    p_request_id UUID,
    p_version INTEGER,
    p_assembled_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
    SELECT COALESCE((
        SELECT pg_catalog.jsonb_build_object(
            'state', CASE
                WHEN queue.purge_fenced_at IS NOT NULL THEN 'fenced'
                WHEN queue.status = 'completed' THEN 'retained'
                ELSE 'pending'
            END,
            'queueStatus', queue.status,
            'version', p_version,
            'assembledAt', p_assembled_at,
            'purgeFencedAt', queue.purge_fenced_at,
            'purgeFenceReason', queue.purge_fence_reason,
            'purgedAt', queue.purged_at,
            'queueUpdatedAt', queue.updated_at
        )
        FROM public.analysis_order_audit_assembly_queue AS queue
        WHERE queue.request_id = p_request_id
    ), pg_catalog.jsonb_build_object(
        'state', 'unknown',
        'queueStatus', NULL,
        'version', p_version,
        'assembledAt', p_assembled_at,
        'purgeFencedAt', NULL,
        'purgeFenceReason', NULL,
        'purgedAt', NULL,
        'queueUpdatedAt', NULL
    ));
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_retention_payload(UUID, INTEGER, TIMESTAMPTZ)
    FROM PUBLIC, anon, authenticated, service_role;

-- Replace the existing redacted summary function in place so all existing assembler callers
-- retain their signature while the operator payload gains retention and gender/risk counts.
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
        'gender', public.analysis_order_audit_summary_counts(
            p_bundle.request_id, p_bundle.version
        )->'gender',
        'risk', public.analysis_order_audit_summary_counts(
            p_bundle.request_id, p_bundle.version
        )->'risk',
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
        'retention', public.analysis_order_audit_retention_payload(
            p_bundle.request_id, p_bundle.version, p_bundle.assembled_at
        ),
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

-- Keep the summary function service-only as in the predecessor migration.
REVOKE ALL ON FUNCTION public.analysis_order_audit_bundle_payload(
    public.analysis_order_audit_bundles
) FROM PUBLIC, anon, authenticated, service_role;

-- The risk ledger needs an exact public-female projection. Keep the existing detail RPC
-- signature and bounded OFFSET pagination, adding only the additive filter contract.
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
       OR v_filter NOT IN ('all', 'public', 'public_female', 'private', 'comments', 'likes',
                           'candidate_likes', 'tags', 'mentions')
       OR (v_filter = 'public_female' AND v_section <> 'risk') THEN
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
               OR (v_filter = 'public_female'
                   AND NOT candidate.is_private
                   AND candidate.final_gender_output = 'female')
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
                         OR (v_filter = 'public_female'
                             AND NOT candidate.is_private
                             AND candidate.final_gender_output = 'female')
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
                         OR (v_filter = 'public_female'
                             AND NOT candidate.is_private
                             AND candidate.final_gender_output = 'female')
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
                         OR (v_filter = 'public_female'
                             AND NOT candidate.is_private
                             AND candidate.final_gender_output = 'female')
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

REVOKE ALL ON FUNCTION public.load_analysis_order_audit_bundle(
    UUID, TEXT, INTEGER, INTEGER, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_order_audit_bundle(
    UUID, TEXT, INTEGER, INTEGER, TEXT
) TO service_role;

-- Keep the existing bounded keyset list and add only compact count/retention projections.
CREATE OR REPLACE FUNCTION public.list_analysis_order_audit_bundles(
    p_cursor_assembled_at TIMESTAMPTZ DEFAULT NULL,
    p_cursor_request_id UUID DEFAULT NULL,
    p_page_size INTEGER DEFAULT 25
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
SET statement_timeout = '5s'
AS $$
DECLARE
    v_rows JSONB;
    v_has_more BOOLEAN;
    v_next_assembled_at TIMESTAMPTZ;
    v_next_request_id UUID;
BEGIN
    IF (p_cursor_assembled_at IS NULL) <> (p_cursor_request_id IS NULL)
       OR p_page_size IS NULL
       OR p_page_size NOT BETWEEN 1 AND 50 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_INVALID_QUERY', ERRCODE = 'P0001';
    END IF;

    WITH latest AS (
        SELECT DISTINCT ON (bundle.request_id)
            bundle.request_id,
            bundle.order_id,
            bundle.target_instagram_id,
            bundle.plan_id,
            bundle.version,
            bundle.completeness_status,
            bundle.gap_codes,
            bundle.cost_status,
            bundle.cost_known_usd,
            bundle.cost_conservative_usd,
            bundle.cost_usage_unknown,
            bundle.stage_status,
            bundle.assembled_at
        FROM public.analysis_order_audit_bundles AS bundle
        ORDER BY bundle.request_id, bundle.version DESC
    ), candidates AS (
        SELECT latest.*
        FROM latest
        WHERE p_cursor_assembled_at IS NULL
           OR assembled_at < p_cursor_assembled_at
           OR (
               assembled_at = p_cursor_assembled_at
               AND request_id < p_cursor_request_id
           )
        ORDER BY assembled_at DESC, request_id DESC
        LIMIT p_page_size + 1
    ), ordered AS (
        SELECT candidates.*,
               pg_catalog.row_number() OVER (
                   ORDER BY assembled_at DESC, request_id DESC
               ) AS page_ordinal
        FROM candidates
    ), page AS (
        SELECT ordered.*
        FROM ordered
        WHERE ordered.page_ordinal <= p_page_size
    ), projected AS (
        SELECT page.*,
               public.analysis_order_audit_summary_counts(
                   page.request_id, page.version
               )->'gender' AS gender,
               public.analysis_order_audit_summary_counts(
                   page.request_id, page.version
               )->'risk' AS risk,
               public.analysis_order_audit_retention_payload(
                   page.request_id, page.version, page.assembled_at
               ) AS retention
        FROM page
    ), has_more AS (
        SELECT EXISTS (
            SELECT 1
            FROM ordered
            WHERE ordered.page_ordinal = p_page_size + 1
        ) AS value
    )
    SELECT
        COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'requestId', page.request_id,
                    'orderId', page.order_id,
                    'targetInstagramId', page.target_instagram_id,
                    'planId', page.plan_id,
                    'version', page.version,
                    'completenessStatus', page.completeness_status,
                    'gapCodes', COALESCE((
                        SELECT pg_catalog.jsonb_agg(bounded.code ORDER BY bounded.ordinality)
                        FROM (
                            SELECT gap.code, gap.ordinality
                            FROM pg_catalog.unnest(
                                COALESCE(page.gap_codes, ARRAY[]::TEXT[])
                            ) WITH ORDINALITY AS gap(code, ordinality)
                            WHERE pg_catalog.char_length(gap.code) BETWEEN 1 AND 96
                              AND gap.code !~ '[[:cntrl:]]'
                            ORDER BY gap.ordinality
                            LIMIT 32
                        ) AS bounded
                    ), '[]'::JSONB),
                    'cost', pg_catalog.jsonb_build_object(
                        'status', page.cost_status,
                        'knownUsd', page.cost_known_usd,
                        'conservativeUsd', page.cost_conservative_usd,
                        'usageUnknown', page.cost_usage_unknown
                    ),
                    'gender', page.gender,
                    'risk', page.risk,
                    'retention', page.retention,
                    'stageStatus', pg_catalog.jsonb_build_object(
                        'relationships', page.stage_status->>'relationships' = 'true',
                        'targetEvidence', page.stage_status->>'targetEvidence' = 'true',
                        'candidateFeatures', page.stage_status->>'candidateFeatures' = 'true',
                        'riskScores', page.stage_status->>'riskScores' = 'true',
                        'finalized', page.stage_status->>'finalized' = 'true'
                    ),
                    'assembledAt', page.assembled_at
                ) ORDER BY page.assembled_at DESC, page.request_id DESC
            )
            FROM projected AS page
        ), '[]'::JSONB),
        has_more.value,
        CASE WHEN has_more.value THEN (
            SELECT page.assembled_at
            FROM page
            ORDER BY page.assembled_at ASC, page.request_id ASC
            LIMIT 1
        ) ELSE NULL END,
        CASE WHEN has_more.value THEN (
            SELECT page.request_id
            FROM page
            ORDER BY page.assembled_at ASC, page.request_id ASC
            LIMIT 1
        ) ELSE NULL END
      INTO v_rows, v_has_more, v_next_assembled_at, v_next_request_id
      FROM has_more;

    RETURN pg_catalog.jsonb_build_object(
        'rows', v_rows,
        'nextCursor', CASE WHEN v_has_more THEN pg_catalog.jsonb_build_object(
            'assembledAt', v_next_assembled_at,
            'requestId', v_next_request_id
        ) ELSE NULL END
    );
END;
$$;

REVOKE ALL ON FUNCTION public.list_analysis_order_audit_bundles(TIMESTAMPTZ, UUID, INTEGER)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_analysis_order_audit_bundles(TIMESTAMPTZ, UUID, INTEGER)
    TO service_role;
