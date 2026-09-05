-- MIGRATION_PREDECESSOR=20260904130000
-- Aggregate-only parity evidence for a later reviewed table contraction.
-- This migration creates no table and performs no destructive mutation; its only write path is a
-- bounded PII-free attestation on the existing assembly queue before the existing purge call.
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
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_CONSOLIDATION_PREDECESSOR_MISSING', ERRCODE = 'P0001';
    END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.analysis_order_audit_parity_attestation_is_safe(
    p_value JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
DECLARE
    v_entry RECORD;
    v_key TEXT;
    v_scalar TEXT;
BEGIN
    IF pg_catalog.jsonb_typeof(p_value) = 'object' THEN
        FOR v_entry IN
            SELECT entry.key, entry.value
            FROM pg_catalog.jsonb_each(p_value) AS entry
        LOOP
            v_key := pg_catalog.regexp_replace(
                pg_catalog.lower(v_entry.key), '[_-]', '', 'g'
            );
            IF v_key IN (
                'userid', 'useruuid', 'ownerid', 'owneruuid', 'actorid', 'actoruuid',
                'requestid', 'orderid', 'preflightid', 'accountid', 'provideraccount',
                'username', 'handle', 'comment', 'commenttext', 'raw', 'rawdata',
                'rawpayload', 'providerpayload', 'providerresponse', 'url', 'uri',
                'credential', 'credentials', 'password', 'cookie', 'authorization',
                'secret', 'session', 'sessionid'
            ) OR v_key LIKE '%token%'
              OR v_key LIKE '%payload%'
              OR v_key LIKE '%credential%'
              OR v_key LIKE '%secret%'
              OR v_key LIKE '%password%'
              OR v_key LIKE '%comment%'
              OR v_key LIKE '%username%'
              OR v_key LIKE '%handle%' THEN
                RETURN FALSE;
            END IF;
            IF NOT public.analysis_order_audit_parity_attestation_is_safe(v_entry.value) THEN
                RETURN FALSE;
            END IF;
        END LOOP;
    ELSIF pg_catalog.jsonb_typeof(p_value) = 'array' THEN
        FOR v_entry IN
            SELECT entry.value
            FROM pg_catalog.jsonb_array_elements(p_value) AS entry
        LOOP
            IF NOT public.analysis_order_audit_parity_attestation_is_safe(v_entry.value) THEN
                RETURN FALSE;
            END IF;
        END LOOP;
    ELSIF pg_catalog.jsonb_typeof(p_value) = 'string' THEN
        v_scalar := p_value #>> '{}';
        IF v_scalar ~* '^[A-Za-z][A-Za-z0-9+.-]*://'
           OR v_scalar ~* '^www\.'
           OR v_scalar ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
            RETURN FALSE;
        END IF;
    END IF;
    RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_order_audit_parity_attestation_is_safe(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_order_audit_assembly_queue
    ADD COLUMN parity_attestation JSONB,
    ADD CONSTRAINT analysis_order_audit_queue_parity_attestation_check CHECK (
        parity_attestation IS NULL
        OR (
            pg_catalog.jsonb_typeof(parity_attestation) = 'object'
            AND pg_catalog.octet_length(parity_attestation::TEXT) <= 65536
            AND parity_attestation ?& ARRAY['request', 'bundle', 'recovery', 'sections']
            AND (parity_attestation - 'request' - 'bundle' - 'recovery' - 'sections') = '{}'::JSONB
            AND pg_catalog.jsonb_typeof(parity_attestation->'request') = 'object'
            AND pg_catalog.jsonb_typeof(parity_attestation->'bundle') = 'object'
            AND pg_catalog.jsonb_typeof(parity_attestation->'recovery') = 'object'
            AND pg_catalog.jsonb_typeof(parity_attestation->'sections') = 'object'
            AND (parity_attestation->'request') ?& ARRAY[
                'completed', 'productionOrder', 'sourceDataPresent'
            ]
            AND (parity_attestation->'bundle') ?& ARRAY[
                'present', 'completeness', 'costStatus', 'version'
            ]
            AND (parity_attestation->'recovery') ?& ARRAY['present', 'completed']
            AND (parity_attestation->'sections') ?& ARRAY[
                'relationships', 'targetEvidence', 'candidates', 'risk', 'costLedger'
            ]
            AND public.analysis_order_audit_parity_attestation_is_safe(parity_attestation)
        )
    );

COMMENT ON COLUMN public.analysis_order_audit_assembly_queue.parity_attestation IS
    'PII-free bounded aggregate parity snapshot captured before terminal source purge';

CREATE OR REPLACE FUNCTION public.read_analysis_order_audit_parity_snapshot(
    p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_bundle public.analysis_order_audit_bundles%ROWTYPE;
    v_bundle_present BOOLEAN := FALSE;
    v_recovery_present BOOLEAN := FALSE;
    v_recovery_completed BOOLEAN := FALSE;
    v_order_present BOOLEAN := FALSE;
    v_source_data_present BOOLEAN := FALSE;
    v_completed BOOLEAN := FALSE;
    v_production_order BOOLEAN := FALSE;
    v_parity_attestation JSONB;

    v_relationship_job TEXT;
    v_target_evidence_job TEXT;
    v_relationship_available BOOLEAN := FALSE;
    v_target_evidence_available BOOLEAN := FALSE;
    v_candidate_available BOOLEAN := FALSE;
    v_risk_available BOOLEAN := FALSE;
    v_cost_available BOOLEAN := FALSE;

    v_relationship_source_count INTEGER;
    v_relationship_bundle_count INTEGER;
    v_relationship_source_checksum TEXT;
    v_relationship_bundle_checksum TEXT;
    v_relationship_source_complete BOOLEAN;
    v_relationship_bundle_complete BOOLEAN;

    v_target_source_count INTEGER;
    v_target_bundle_count INTEGER;
    v_target_source_checksum TEXT;
    v_target_bundle_checksum TEXT;
    v_target_source_complete BOOLEAN;
    v_target_bundle_complete BOOLEAN;

    v_candidate_source_count INTEGER;
    v_candidate_bundle_count INTEGER;
    v_candidate_source_checksum TEXT;
    v_candidate_bundle_checksum TEXT;
    v_candidate_source_complete BOOLEAN;
    v_candidate_bundle_complete BOOLEAN;

    v_risk_source_count INTEGER;
    v_risk_bundle_count INTEGER;
    v_risk_source_checksum TEXT;
    v_risk_bundle_checksum TEXT;
    v_risk_source_complete BOOLEAN;
    v_risk_bundle_complete BOOLEAN;

    v_cost_source_count INTEGER;
    v_cost_bundle_count INTEGER;
    v_cost_source_checksum TEXT;
    v_cost_bundle_checksum TEXT;
    v_cost_source_complete BOOLEAN;
    v_cost_bundle_complete BOOLEAN;
BEGIN
    IF p_request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_ORDER_AUDIT_CONSOLIDATION_REQUEST_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT request.*
      INTO v_request
      FROM public.analysis_requests AS request
     WHERE request.id = p_request_id
       AND request.pipeline_version = 'v2';
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    SELECT bundle.*
      INTO v_bundle
      FROM public.analysis_order_audit_bundles AS bundle
     WHERE bundle.request_id = p_request_id
     ORDER BY bundle.version DESC
     LIMIT 1;
    v_bundle_present := FOUND;

    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_order_audit_assembly_queue AS queue
        WHERE queue.request_id = p_request_id
    ) INTO v_recovery_present;
    IF v_recovery_present THEN
        SELECT queue.status = 'completed', queue.parity_attestation
          INTO v_recovery_completed, v_parity_attestation
          FROM public.analysis_order_audit_assembly_queue AS queue
         WHERE queue.request_id = p_request_id;
    END IF;

    v_completed := v_request.status = 'completed';
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_orders AS order_row
        WHERE order_row.result_request_id = p_request_id
    ) INTO v_order_present;
    v_production_order := v_completed
        AND v_request.plan_access_mode_snapshot = 'production'
        AND v_order_present;

    SELECT manifest.job_key
      INTO v_relationship_job
      FROM public.analysis_v2_relationship_manifests AS manifest
     WHERE manifest.request_id = p_request_id
     ORDER BY manifest.updated_at DESC NULLS LAST, manifest.job_key DESC
     LIMIT 1;
    v_relationship_available := v_relationship_job IS NOT NULL
        OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
        );

    SELECT manifest.job_key
      INTO v_target_evidence_job
      FROM public.analysis_v2_target_evidence_manifests AS manifest
     WHERE manifest.request_id = p_request_id
     ORDER BY manifest.updated_at DESC NULLS LAST, manifest.job_key DESC
     LIMIT 1;
    v_target_evidence_available := v_target_evidence_job IS NOT NULL
        OR EXISTS (
            SELECT 1
            FROM public.analysis_target_interactors AS interaction
            WHERE interaction.request_id = p_request_id
        );

    v_candidate_available := EXISTS (
        SELECT 1
        FROM public.analysis_v2_candidate_feature_rows AS feature
        WHERE feature.request_id = p_request_id
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_private_name_rows AS private_name
        WHERE private_name.request_id = p_request_id
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_mutual_rows AS mutual
        WHERE mutual.request_id = p_request_id
    );

    v_risk_available := EXISTS (
        SELECT 1
        FROM public.analysis_v2_candidate_score_manifests AS manifest
        WHERE manifest.request_id = p_request_id
    ) OR EXISTS (
        SELECT 1
        FROM public.analysis_v2_candidate_score_rows AS score
        WHERE score.request_id = p_request_id
    );

    v_cost_available := EXISTS (
        SELECT 1
        FROM public.analysis_v2_cost_rollups AS rollup
        WHERE rollup.request_id = p_request_id
    );
    v_source_data_present := v_relationship_available
        OR v_target_evidence_available
        OR v_candidate_available
        OR v_risk_available
        OR v_cost_available;

    -- Relationship parity compares only the immutable common projection. Handles, names, profile
    -- media, request IDs, and timestamps are deliberately excluded from the checksum projection.
    IF v_relationship_available THEN
        SELECT count(*)::INTEGER
          INTO v_relationship_source_count
          FROM public.analysis_v2_mutual_rows AS mutual
         WHERE mutual.request_id = p_request_id
           AND (
               v_relationship_job IS NULL
               OR mutual.job_key = v_relationship_job
           );
        SELECT public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'mutualOrdinal', mutual.mutual_ordinal,
                    'followingOrdinal', mutual.following_ordinal,
                    'candidateKeyHash', public.analysis_order_audit_digest(mutual.username),
                    'isPrivate', mutual.is_private,
                    'isVerified', mutual.is_verified
                ) ORDER BY mutual.mutual_ordinal, mutual.username
            )::TEXT
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND (
                  v_relationship_job IS NULL
                  OR mutual.job_key = v_relationship_job
              )
        ), '[]')) INTO v_relationship_source_checksum;
        v_relationship_source_complete := v_relationship_job IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM public.analysis_v2_relationship_sides AS side
                WHERE side.request_id = p_request_id
                  AND side.side = 'followers'
                  AND side.job_key = v_relationship_job
                  AND side.declared_count = side.collected_count
            )
            AND EXISTS (
                SELECT 1
                FROM public.analysis_v2_relationship_sides AS side
                WHERE side.request_id = p_request_id
                  AND side.side = 'following'
                  AND side.job_key = v_relationship_job
                  AND side.declared_count = side.collected_count
            )
            AND EXISTS (
                SELECT 1
                FROM public.analysis_v2_relationship_manifests AS manifest
                WHERE manifest.request_id = p_request_id
                  AND manifest.job_key = v_relationship_job
                  AND manifest.mutual_count = v_relationship_source_count
            );
    END IF;

    IF v_bundle_present THEN
        SELECT count(*)::INTEGER
          INTO v_relationship_bundle_count
          FROM public.analysis_order_audit_candidates AS candidate
         WHERE candidate.request_id = v_bundle.request_id
           AND candidate.version = v_bundle.version;
        SELECT public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'mutualOrdinal', candidate.mutual_ordinal,
                    'followingOrdinal', candidate.following_ordinal,
                    'candidateKeyHash', public.analysis_order_audit_digest(candidate.username),
                    'isPrivate', candidate.is_private,
                    'isVerified', candidate.is_verified
                ) ORDER BY candidate.mutual_ordinal NULLS LAST, candidate.username
            )::TEXT
            FROM public.analysis_order_audit_candidates AS candidate
            WHERE candidate.request_id = v_bundle.request_id
              AND candidate.version = v_bundle.version
        ), '[]')) INTO v_relationship_bundle_checksum;
        v_relationship_bundle_complete := v_bundle.stage_status->>'relationships' = 'true'
            AND v_bundle.mutual_total = v_relationship_bundle_count;
    END IF;

    -- Target evidence parity excludes the candidate join key; it compares the stable evidence
    -- identity and content fields in the same order used by the permanent interaction copy.
    IF v_target_evidence_available THEN
        SELECT count(*)::INTEGER
          INTO v_target_source_count
          FROM public.analysis_target_interactors AS interaction
         WHERE interaction.request_id = p_request_id
           AND (
               v_target_evidence_job IS NULL
               OR interaction.job_key = v_target_evidence_job
           );
        SELECT public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'ordinal', interaction.ordinal,
                    'actorKeyHash', public.analysis_order_audit_digest(interaction.actor_username),
                    'postId', interaction.post_id,
                    'signal', interaction.signal,
                    'sourceInteractionId', interaction.source_interaction_id,
                    'occurredAt', interaction.occurred_at,
                    'commentText', interaction.comment_text,
                    'details', public.analysis_order_audit_redact_json(
                        NULLIF(pg_catalog.to_jsonb(interaction)->'details', 'null'::JSONB)
                    )
                ) ORDER BY interaction.ordinal, interaction.signal,
                    interaction.source_interaction_id
            )::TEXT
            FROM public.analysis_target_interactors AS interaction
            WHERE interaction.request_id = p_request_id
              AND (
                  v_target_evidence_job IS NULL
                  OR interaction.job_key = v_target_evidence_job
              )
        ), '[]')) INTO v_target_source_checksum;
        v_target_source_complete := v_target_evidence_job IS NOT NULL
            AND EXISTS (
                SELECT 1
                FROM public.analysis_v2_target_evidence_manifests AS manifest
                WHERE manifest.request_id = p_request_id
                  AND manifest.job_key = v_target_evidence_job
                  AND manifest.interactor_count = v_target_source_count
                  AND manifest.liker_count + manifest.comment_count = manifest.interactor_count
            );
    END IF;

    IF v_bundle_present THEN
        SELECT count(*)::INTEGER
          INTO v_target_bundle_count
          FROM public.analysis_order_audit_interactions AS interaction
         WHERE interaction.request_id = v_bundle.request_id
           AND interaction.version = v_bundle.version
           AND interaction.signal IN ('target_post_like', 'target_post_comment');
        SELECT public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'ordinal', interaction.ordinal,
                    'actorKeyHash', CASE
                        WHEN interaction.username IS NULL THEN NULL
                        ELSE public.analysis_order_audit_digest(interaction.username)
                    END,
                    'postId', interaction.source_post_id,
                    'signal', interaction.signal,
                    'sourceInteractionId', interaction.evidence_id,
                    'occurredAt', interaction.occurred_at,
                    'commentText', interaction.comment_text,
                    'details', interaction.details
                ) ORDER BY interaction.ordinal, interaction.signal, interaction.evidence_id
            )::TEXT
            FROM public.analysis_order_audit_interactions AS interaction
            WHERE interaction.request_id = v_bundle.request_id
              AND interaction.version = v_bundle.version
              AND interaction.signal IN ('target_post_like', 'target_post_comment')
        ), '[]')) INTO v_target_bundle_checksum;
        v_target_bundle_complete := v_bundle.stage_status->>'targetEvidence' = 'true'
            AND COALESCE(v_bundle.target_likes_collected, 0)
                + COALESCE(v_bundle.target_comments_collected, 0)
                = v_target_bundle_count;
    END IF;

    -- Candidate parity uses the stable Instagram-key set only. The key itself is hashed and never
    -- leaves the database; no username or candidate identifier appears in this result.
    IF v_candidate_available THEN
        WITH expected AS (
            SELECT DISTINCT mutual.username
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND (
                  v_relationship_job IS NULL
                  OR mutual.job_key = v_relationship_job
              )
        ), observed AS (
            SELECT DISTINCT feature.instagram_id AS username
            FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
            UNION
            SELECT DISTINCT private_name.instagram_id AS username
            FROM public.analysis_v2_private_name_rows AS private_name
            WHERE private_name.request_id = p_request_id
        )
        SELECT count(*)::INTEGER
          INTO v_candidate_source_count
          FROM observed;
        WITH expected AS (
            SELECT DISTINCT mutual.username
            FROM public.analysis_v2_mutual_rows AS mutual
            WHERE mutual.request_id = p_request_id
              AND (
                  v_relationship_job IS NULL
                  OR mutual.job_key = v_relationship_job
              )
        ), observed AS (
            SELECT DISTINCT feature.instagram_id AS username
            FROM public.analysis_v2_candidate_feature_rows AS feature
            WHERE feature.request_id = p_request_id
            UNION
            SELECT DISTINCT private_name.instagram_id AS username
            FROM public.analysis_v2_private_name_rows AS private_name
            WHERE private_name.request_id = p_request_id
        )
        SELECT public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object('candidateKey', observed.username)
                ORDER BY observed.username
            )::TEXT
            FROM observed
        ), '[]')) INTO v_candidate_source_checksum;
        v_candidate_source_complete := NOT EXISTS (
            WITH expected AS (
                SELECT DISTINCT mutual.username
                FROM public.analysis_v2_mutual_rows AS mutual
                WHERE mutual.request_id = p_request_id
                  AND (
                      v_relationship_job IS NULL
                      OR mutual.job_key = v_relationship_job
                  )
            ), observed AS (
                SELECT DISTINCT feature.instagram_id AS username
                FROM public.analysis_v2_candidate_feature_rows AS feature
                WHERE feature.request_id = p_request_id
                UNION
                SELECT DISTINCT private_name.instagram_id AS username
                FROM public.analysis_v2_private_name_rows AS private_name
                WHERE private_name.request_id = p_request_id
            )
            SELECT username FROM expected
            EXCEPT
            SELECT username FROM observed
        ) AND NOT EXISTS (
            WITH expected AS (
                SELECT DISTINCT mutual.username
                FROM public.analysis_v2_mutual_rows AS mutual
                WHERE mutual.request_id = p_request_id
                  AND (
                      v_relationship_job IS NULL
                      OR mutual.job_key = v_relationship_job
                  )
            ), observed AS (
                SELECT DISTINCT feature.instagram_id AS username
                FROM public.analysis_v2_candidate_feature_rows AS feature
                WHERE feature.request_id = p_request_id
                UNION
                SELECT DISTINCT private_name.instagram_id AS username
                FROM public.analysis_v2_private_name_rows AS private_name
                WHERE private_name.request_id = p_request_id
            )
            SELECT username FROM observed
            EXCEPT
            SELECT username FROM expected
        );
    END IF;

    IF v_bundle_present THEN
        SELECT count(*)::INTEGER
          INTO v_candidate_bundle_count
          FROM public.analysis_order_audit_candidates AS candidate
         WHERE candidate.request_id = v_bundle.request_id
           AND candidate.version = v_bundle.version;
        SELECT public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object('candidateKey', candidate.username)
                ORDER BY candidate.username
            )::TEXT
            FROM public.analysis_order_audit_candidates AS candidate
            WHERE candidate.request_id = v_bundle.request_id
              AND candidate.version = v_bundle.version
        ), '[]')) INTO v_candidate_bundle_checksum;
        v_candidate_bundle_complete := v_bundle.stage_status->>'candidateFeatures' = 'true'
            AND v_bundle.candidate_collected = v_candidate_bundle_count;
    END IF;

    -- Risk parity compares the common score projection and intentionally omits public copy text.
    IF v_risk_available THEN
        SELECT count(*)::INTEGER
          INTO v_risk_source_count
          FROM public.analysis_v2_candidate_score_rows AS score
         WHERE score.request_id = p_request_id;
        SELECT public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'candidateKey', score.candidate_id,
                    'publicScore', score.public_score,
                    'riskBand', score.risk_band,
                    'preScore', score.pre_score,
                    'rawScore', score.raw_score,
                    'featuredRank', score.featured_rank,
                    'recentMutualRank', score.recent_mutual_rank,
                    'components', public.analysis_order_audit_redact_json(score.components),
                    'partnerSafetyOperationKey', score.partner_safety_operation_key,
                    'partnerSafetyResultHash', score.partner_safety_result_hash
                ) ORDER BY score.candidate_id
            )::TEXT
            FROM public.analysis_v2_candidate_score_rows AS score
            WHERE score.request_id = p_request_id
        ), '[]')) INTO v_risk_source_checksum;
        v_risk_source_complete := EXISTS (
            SELECT 1
            FROM public.analysis_v2_candidate_score_manifests AS manifest
            WHERE manifest.request_id = p_request_id
              AND manifest.item_count = v_risk_source_count
        );
    END IF;

    IF v_bundle_present THEN
        SELECT count(*)::INTEGER
          INTO v_risk_bundle_count
          FROM public.analysis_order_audit_candidates AS candidate
         WHERE candidate.request_id = v_bundle.request_id
           AND candidate.version = v_bundle.version
           AND candidate.raw_score IS NOT NULL;
        SELECT public.analysis_order_audit_digest(COALESCE((
            SELECT pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object(
                    'candidateKey', candidate.candidate_id,
                    'publicScore', candidate.public_score,
                    'riskBand', candidate.risk_band,
                    'preScore', candidate.pre_score,
                    'rawScore', candidate.raw_score,
                    'featuredRank', candidate.featured_rank,
                    'recentMutualRank', candidate.recent_mutual_rank,
                    'components', candidate.risk_components,
                    'partnerSafetyOperationKey', candidate.partner_safety_operation_key,
                    'partnerSafetyResultHash', candidate.partner_safety_result_hash
                ) ORDER BY candidate.candidate_id
            )::TEXT
            FROM public.analysis_order_audit_candidates AS candidate
            WHERE candidate.request_id = v_bundle.request_id
              AND candidate.version = v_bundle.version
              AND candidate.raw_score IS NOT NULL
        ), '[]')) INTO v_risk_bundle_checksum;
        v_risk_bundle_complete := v_bundle.stage_status->>'riskScores' = 'true';
    END IF;

    -- The cost rollup's immutable source hash is already persisted in the bundle stage metadata.
    IF v_cost_available THEN
        SELECT count(*)::INTEGER
          INTO v_cost_source_count
          FROM public.analysis_v2_cost_rollups AS rollup
         WHERE rollup.request_id = p_request_id;
        v_cost_source_checksum := public.analysis_order_audit_cost_source_hash(p_request_id);
        SELECT bool_and(
            COALESCE(rollup.directly_attributable_cost_complete, FALSE)
            AND NOT COALESCE(rollup.usage_unknown, TRUE)
        )
          INTO v_cost_source_complete
          FROM public.analysis_v2_cost_rollups AS rollup
         WHERE rollup.request_id = p_request_id;
    END IF;
    IF v_bundle_present THEN
        v_cost_bundle_count := CASE
            WHEN v_bundle.stage_status ? 'costSourceHash' THEN 1 ELSE 0 END;
        v_cost_bundle_checksum := NULLIF(v_bundle.stage_status->>'costSourceHash', '');
        v_cost_bundle_complete := v_bundle.cost_status = 'complete'
            AND v_bundle.stage_status->>'cost' = 'complete'
            AND v_cost_bundle_checksum IS NOT NULL;
    END IF;

    -- The terminal assembler captures this aggregate before it invokes the purge helper. Once
    -- working rows are gone, carry forward only the source side of sections that are absent live;
    -- the latest immutable bundle and any live cost rollup always remain authoritative for their
    -- bundle/cost fields. A prior incomplete attestation remains incomplete and cannot pass parity.
    IF v_parity_attestation IS NOT NULL THEN
        IF NOT v_relationship_available
           AND pg_catalog.jsonb_typeof(v_parity_attestation->'sections'->'relationships') = 'object' THEN
            v_relationship_source_count := NULLIF(
                v_parity_attestation->'sections'->'relationships'->>'sourceCount', ''
            )::INTEGER;
            v_relationship_source_checksum := NULLIF(
                v_parity_attestation->'sections'->'relationships'->>'sourceChecksum', ''
            );
            v_relationship_source_complete := NULLIF(
                v_parity_attestation->'sections'->'relationships'->>'sourceComplete', ''
            )::BOOLEAN;
            v_relationship_available := TRUE;
        END IF;
        IF NOT v_target_evidence_available
           AND pg_catalog.jsonb_typeof(v_parity_attestation->'sections'->'targetEvidence') = 'object' THEN
            v_target_source_count := NULLIF(
                v_parity_attestation->'sections'->'targetEvidence'->>'sourceCount', ''
            )::INTEGER;
            v_target_source_checksum := NULLIF(
                v_parity_attestation->'sections'->'targetEvidence'->>'sourceChecksum', ''
            );
            v_target_source_complete := NULLIF(
                v_parity_attestation->'sections'->'targetEvidence'->>'sourceComplete', ''
            )::BOOLEAN;
            v_target_evidence_available := TRUE;
        END IF;
        IF NOT v_candidate_available
           AND pg_catalog.jsonb_typeof(v_parity_attestation->'sections'->'candidates') = 'object' THEN
            v_candidate_source_count := NULLIF(
                v_parity_attestation->'sections'->'candidates'->>'sourceCount', ''
            )::INTEGER;
            v_candidate_source_checksum := NULLIF(
                v_parity_attestation->'sections'->'candidates'->>'sourceChecksum', ''
            );
            v_candidate_source_complete := NULLIF(
                v_parity_attestation->'sections'->'candidates'->>'sourceComplete', ''
            )::BOOLEAN;
            v_candidate_available := TRUE;
        END IF;
        IF NOT v_risk_available
           AND pg_catalog.jsonb_typeof(v_parity_attestation->'sections'->'risk') = 'object' THEN
            v_risk_source_count := NULLIF(
                v_parity_attestation->'sections'->'risk'->>'sourceCount', ''
            )::INTEGER;
            v_risk_source_checksum := NULLIF(
                v_parity_attestation->'sections'->'risk'->>'sourceChecksum', ''
            );
            v_risk_source_complete := NULLIF(
                v_parity_attestation->'sections'->'risk'->>'sourceComplete', ''
            )::BOOLEAN;
            v_risk_available := TRUE;
        END IF;
        IF NOT v_cost_available
           AND pg_catalog.jsonb_typeof(v_parity_attestation->'sections'->'costLedger') = 'object' THEN
            v_cost_source_count := NULLIF(
                v_parity_attestation->'sections'->'costLedger'->>'sourceCount', ''
            )::INTEGER;
            v_cost_source_checksum := NULLIF(
                v_parity_attestation->'sections'->'costLedger'->>'sourceChecksum', ''
            );
            v_cost_source_complete := NULLIF(
                v_parity_attestation->'sections'->'costLedger'->>'sourceComplete', ''
            )::BOOLEAN;
            v_cost_available := TRUE;
        END IF;
        v_source_data_present := v_source_data_present
            OR COALESCE(
                (v_parity_attestation->'request'->>'sourceDataPresent')::BOOLEAN,
                FALSE
            );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'request', pg_catalog.jsonb_build_object(
            'completed', v_completed,
            'productionOrder', v_production_order,
            'sourceDataPresent', v_source_data_present
        ),
        'bundle', pg_catalog.jsonb_build_object(
            'present', v_bundle_present,
            'completeness', CASE WHEN v_bundle_present THEN v_bundle.completeness_status END,
            'costStatus', CASE WHEN v_bundle_present THEN v_bundle.cost_status END,
            'version', CASE WHEN v_bundle_present THEN v_bundle.version END
        ),
        'recovery', pg_catalog.jsonb_build_object(
            'present', v_recovery_present,
            'completed', v_recovery_completed
        ),
        'sections', pg_catalog.jsonb_build_object(
            'relationships', CASE WHEN v_relationship_available OR v_bundle_present THEN
                pg_catalog.jsonb_build_object(
                    'sourceCount', v_relationship_source_count,
                    'bundleCount', v_relationship_bundle_count,
                    'sourceChecksum', v_relationship_source_checksum,
                    'bundleChecksum', v_relationship_bundle_checksum,
                    'sourceComplete', v_relationship_source_complete,
                    'bundleComplete', v_relationship_bundle_complete
                ) END,
            'targetEvidence', CASE WHEN v_target_evidence_available OR v_bundle_present THEN
                pg_catalog.jsonb_build_object(
                    'sourceCount', v_target_source_count,
                    'bundleCount', v_target_bundle_count,
                    'sourceChecksum', v_target_source_checksum,
                    'bundleChecksum', v_target_bundle_checksum,
                    'sourceComplete', v_target_source_complete,
                    'bundleComplete', v_target_bundle_complete
                ) END,
            'candidates', CASE WHEN v_candidate_available OR v_bundle_present THEN
                pg_catalog.jsonb_build_object(
                    'sourceCount', v_candidate_source_count,
                    'bundleCount', v_candidate_bundle_count,
                    'sourceChecksum', v_candidate_source_checksum,
                    'bundleChecksum', v_candidate_bundle_checksum,
                    'sourceComplete', v_candidate_source_complete,
                    'bundleComplete', v_candidate_bundle_complete
                ) END,
            'risk', CASE WHEN v_risk_available OR v_bundle_present THEN
                pg_catalog.jsonb_build_object(
                    'sourceCount', v_risk_source_count,
                    'bundleCount', v_risk_bundle_count,
                    'sourceChecksum', v_risk_source_checksum,
                    'bundleChecksum', v_risk_bundle_checksum,
                    'sourceComplete', v_risk_source_complete,
                    'bundleComplete', v_risk_bundle_complete
                ) END,
            'costLedger', CASE WHEN v_cost_available OR v_bundle_present THEN
                pg_catalog.jsonb_build_object(
                    'sourceCount', v_cost_source_count,
                    'bundleCount', v_cost_bundle_count,
                    'sourceChecksum', v_cost_source_checksum,
                    'bundleChecksum', v_cost_bundle_checksum,
                    'sourceComplete', v_cost_source_complete,
                    'bundleComplete', v_cost_bundle_complete
                ) END
        )
    );
END;
$$;

REVOKE ALL ON FUNCTION public.read_analysis_order_audit_parity_snapshot(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_analysis_order_audit_parity_snapshot(UUID)
    TO service_role;

-- Capture the aggregate after bundle children have been inserted and before the assembler's
-- terminal purge call. This trigger only updates the existing queue row's bounded attestation;
-- it never copies source payloads or identifiers.
CREATE OR REPLACE FUNCTION public.capture_analysis_order_audit_parity_attestation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_current JSONB;
    v_previous JSONB;
    v_attestation JSONB;
BEGIN
    IF NEW.status <> 'completed'
       OR (TG_OP = 'UPDATE' AND OLD.status = 'completed') THEN
        RETURN NEW;
    END IF;

    v_current := public.read_analysis_order_audit_parity_snapshot(NEW.request_id);
    IF v_current IS NULL
       OR v_current->'bundle'->>'present' IS DISTINCT FROM 'true' THEN
        RETURN NEW;
    END IF;

    SELECT queue.parity_attestation
      INTO v_previous
      FROM public.analysis_order_audit_assembly_queue AS queue
     WHERE queue.request_id = NEW.request_id;

    v_attestation := pg_catalog.jsonb_build_object(
        'request', pg_catalog.jsonb_build_object(
            'completed', COALESCE(
                NULLIF(v_current->'request'->'completed', 'null'::JSONB),
                v_previous->'request'->'completed'
            ),
            'productionOrder', COALESCE(
                NULLIF(v_current->'request'->'productionOrder', 'null'::JSONB),
                v_previous->'request'->'productionOrder'
            ),
            'sourceDataPresent', (
                COALESCE((v_current->'request'->>'sourceDataPresent')::BOOLEAN, FALSE)
                OR COALESCE((v_previous->'request'->>'sourceDataPresent')::BOOLEAN, FALSE)
            )
        ),
        'bundle', v_current->'bundle',
        'recovery', v_current->'recovery',
        'sections', pg_catalog.jsonb_build_object(
            'relationships', CASE
                WHEN COALESCE(
                    pg_catalog.jsonb_typeof(v_current->'sections'->'relationships') <> 'object',
                    TRUE
                ) THEN v_previous->'sections'->'relationships'
                ELSE v_current->'sections'->'relationships' || pg_catalog.jsonb_build_object(
                    'sourceCount', COALESCE(
                        NULLIF(v_current->'sections'->'relationships'->'sourceCount', 'null'::JSONB),
                        v_previous->'sections'->'relationships'->'sourceCount'
                    ),
                    'bundleCount', COALESCE(
                        NULLIF(v_current->'sections'->'relationships'->'bundleCount', 'null'::JSONB),
                        v_previous->'sections'->'relationships'->'bundleCount'
                    ),
                    'sourceChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'relationships'->'sourceChecksum', 'null'::JSONB),
                        v_previous->'sections'->'relationships'->'sourceChecksum'
                    ),
                    'bundleChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'relationships'->'bundleChecksum', 'null'::JSONB),
                        v_previous->'sections'->'relationships'->'bundleChecksum'
                    ),
                    'sourceComplete', COALESCE(
                        NULLIF(v_current->'sections'->'relationships'->'sourceComplete', 'null'::JSONB),
                        v_previous->'sections'->'relationships'->'sourceComplete'
                    ),
                    'bundleComplete', COALESCE(
                        NULLIF(v_current->'sections'->'relationships'->'bundleComplete', 'null'::JSONB),
                        v_previous->'sections'->'relationships'->'bundleComplete'
                    )
                )
            END,
            'targetEvidence', CASE
                WHEN COALESCE(
                    pg_catalog.jsonb_typeof(v_current->'sections'->'targetEvidence') <> 'object',
                    TRUE
                ) THEN v_previous->'sections'->'targetEvidence'
                ELSE v_current->'sections'->'targetEvidence' || pg_catalog.jsonb_build_object(
                    'sourceCount', COALESCE(
                        NULLIF(v_current->'sections'->'targetEvidence'->'sourceCount', 'null'::JSONB),
                        v_previous->'sections'->'targetEvidence'->'sourceCount'
                    ),
                    'bundleCount', COALESCE(
                        NULLIF(v_current->'sections'->'targetEvidence'->'bundleCount', 'null'::JSONB),
                        v_previous->'sections'->'targetEvidence'->'bundleCount'
                    ),
                    'sourceChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'targetEvidence'->'sourceChecksum', 'null'::JSONB),
                        v_previous->'sections'->'targetEvidence'->'sourceChecksum'
                    ),
                    'bundleChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'targetEvidence'->'bundleChecksum', 'null'::JSONB),
                        v_previous->'sections'->'targetEvidence'->'bundleChecksum'
                    ),
                    'sourceComplete', COALESCE(
                        NULLIF(v_current->'sections'->'targetEvidence'->'sourceComplete', 'null'::JSONB),
                        v_previous->'sections'->'targetEvidence'->'sourceComplete'
                    ),
                    'bundleComplete', COALESCE(
                        NULLIF(v_current->'sections'->'targetEvidence'->'bundleComplete', 'null'::JSONB),
                        v_previous->'sections'->'targetEvidence'->'bundleComplete'
                    )
                )
            END,
            'candidates', CASE
                WHEN COALESCE(
                    pg_catalog.jsonb_typeof(v_current->'sections'->'candidates') <> 'object',
                    TRUE
                ) THEN v_previous->'sections'->'candidates'
                ELSE v_current->'sections'->'candidates' || pg_catalog.jsonb_build_object(
                    'sourceCount', COALESCE(
                        NULLIF(v_current->'sections'->'candidates'->'sourceCount', 'null'::JSONB),
                        v_previous->'sections'->'candidates'->'sourceCount'
                    ),
                    'bundleCount', COALESCE(
                        NULLIF(v_current->'sections'->'candidates'->'bundleCount', 'null'::JSONB),
                        v_previous->'sections'->'candidates'->'bundleCount'
                    ),
                    'sourceChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'candidates'->'sourceChecksum', 'null'::JSONB),
                        v_previous->'sections'->'candidates'->'sourceChecksum'
                    ),
                    'bundleChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'candidates'->'bundleChecksum', 'null'::JSONB),
                        v_previous->'sections'->'candidates'->'bundleChecksum'
                    ),
                    'sourceComplete', COALESCE(
                        NULLIF(v_current->'sections'->'candidates'->'sourceComplete', 'null'::JSONB),
                        v_previous->'sections'->'candidates'->'sourceComplete'
                    ),
                    'bundleComplete', COALESCE(
                        NULLIF(v_current->'sections'->'candidates'->'bundleComplete', 'null'::JSONB),
                        v_previous->'sections'->'candidates'->'bundleComplete'
                    )
                )
            END,
            'risk', CASE
                WHEN COALESCE(
                    pg_catalog.jsonb_typeof(v_current->'sections'->'risk') <> 'object',
                    TRUE
                ) THEN v_previous->'sections'->'risk'
                ELSE v_current->'sections'->'risk' || pg_catalog.jsonb_build_object(
                    'sourceCount', COALESCE(
                        NULLIF(v_current->'sections'->'risk'->'sourceCount', 'null'::JSONB),
                        v_previous->'sections'->'risk'->'sourceCount'
                    ),
                    'bundleCount', COALESCE(
                        NULLIF(v_current->'sections'->'risk'->'bundleCount', 'null'::JSONB),
                        v_previous->'sections'->'risk'->'bundleCount'
                    ),
                    'sourceChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'risk'->'sourceChecksum', 'null'::JSONB),
                        v_previous->'sections'->'risk'->'sourceChecksum'
                    ),
                    'bundleChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'risk'->'bundleChecksum', 'null'::JSONB),
                        v_previous->'sections'->'risk'->'bundleChecksum'
                    ),
                    'sourceComplete', COALESCE(
                        NULLIF(v_current->'sections'->'risk'->'sourceComplete', 'null'::JSONB),
                        v_previous->'sections'->'risk'->'sourceComplete'
                    ),
                    'bundleComplete', COALESCE(
                        NULLIF(v_current->'sections'->'risk'->'bundleComplete', 'null'::JSONB),
                        v_previous->'sections'->'risk'->'bundleComplete'
                    )
                )
            END,
            'costLedger', CASE
                WHEN COALESCE(
                    pg_catalog.jsonb_typeof(v_current->'sections'->'costLedger') <> 'object',
                    TRUE
                ) THEN v_previous->'sections'->'costLedger'
                ELSE v_current->'sections'->'costLedger' || pg_catalog.jsonb_build_object(
                    'sourceCount', COALESCE(
                        NULLIF(v_current->'sections'->'costLedger'->'sourceCount', 'null'::JSONB),
                        v_previous->'sections'->'costLedger'->'sourceCount'
                    ),
                    'bundleCount', COALESCE(
                        NULLIF(v_current->'sections'->'costLedger'->'bundleCount', 'null'::JSONB),
                        v_previous->'sections'->'costLedger'->'bundleCount'
                    ),
                    'sourceChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'costLedger'->'sourceChecksum', 'null'::JSONB),
                        v_previous->'sections'->'costLedger'->'sourceChecksum'
                    ),
                    'bundleChecksum', COALESCE(
                        NULLIF(v_current->'sections'->'costLedger'->'bundleChecksum', 'null'::JSONB),
                        v_previous->'sections'->'costLedger'->'bundleChecksum'
                    ),
                    'sourceComplete', COALESCE(
                        NULLIF(v_current->'sections'->'costLedger'->'sourceComplete', 'null'::JSONB),
                        v_previous->'sections'->'costLedger'->'sourceComplete'
                    ),
                    'bundleComplete', COALESCE(
                        NULLIF(v_current->'sections'->'costLedger'->'bundleComplete', 'null'::JSONB),
                        v_previous->'sections'->'costLedger'->'bundleComplete'
                    )
                )
            END
        )
    );

    UPDATE public.analysis_order_audit_assembly_queue
       SET parity_attestation = v_attestation
     WHERE request_id = NEW.request_id;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_analysis_order_audit_parity_attestation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER capture_analysis_order_audit_parity_attestation_after_completion
AFTER INSERT OR UPDATE OF status ON public.analysis_order_audit_assembly_queue
FOR EACH ROW EXECUTE FUNCTION public.capture_analysis_order_audit_parity_attestation();
