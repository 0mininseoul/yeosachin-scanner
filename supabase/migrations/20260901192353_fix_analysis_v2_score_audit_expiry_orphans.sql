-- MIGRATION_PREDECESSOR=20260831100000
-- Expired audit intents can outlive their result summary when terminal
-- working-set cleanup removes that parent. Reconcile those orphaned intents
-- before inserting a run, while retaining the existing terminal audit record
-- for requests whose summary still exists.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.purge_expired_analysis_v2_score_audit_evidence(
    p_limit INTEGER DEFAULT 100
)
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_count INTEGER := 0;
    v_expired RECORD;
    v_summary_request_id UUID;
BEGIN
    -- Keep the lock order intent -> checkpoint -> summary -> run. Locking the
    -- checkpoint before the summary matches terminal working-set cleanup, and
    -- locking the summary before inserting the child run keeps FK validation
    -- safe when the summary is concurrently eligible for deletion.
    FOR v_expired IN
        SELECT intent.request_id, intent.source_result_hash,
               intent.source_generation,
               request.policy_versions_snapshot->>'risk' AS risk_policy_version
        FROM public.analysis_v2_score_audit_intents AS intent
        JOIN public.analysis_requests AS request
          ON request.id = intent.request_id
        WHERE intent.intent_status = 'queued'
          AND intent.retain_until <= pg_catalog.clock_timestamp()
        ORDER BY intent.retain_until, intent.request_id
        LIMIT LEAST(GREATEST(p_limit, 1), 100)
        FOR UPDATE SKIP LOCKED
    LOOP
        -- Lock the exact rich checkpoint before taking the result-summary lock.
        -- An orphaned intent has no checkpoint, which intentionally remains a
        -- valid path and is reconciled below without creating a child run.
        PERFORM 1
        FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
        WHERE stage.request_id = v_expired.request_id
          AND stage.stage_kind = 'final_score'
          AND stage.batch_key = -1
          AND stage.result_hash = v_expired.source_result_hash
        FOR UPDATE;

        v_summary_request_id := NULL;
        SELECT summary.request_id
        INTO v_summary_request_id
        FROM public.analysis_v2_result_summaries AS summary
        WHERE summary.request_id = v_expired.request_id
        FOR KEY SHARE;

        IF v_summary_request_id IS NOT NULL THEN
            INSERT INTO public.analysis_v2_score_audit_runs (
                request_id, source_result_hash, source_generation,
                risk_policy_version, status, reason
            ) VALUES (
                v_expired.request_id, v_expired.source_result_hash,
                v_expired.source_generation, v_expired.risk_policy_version,
                'partial', 'SOURCE_EVIDENCE_EXPIRED'
            )
            ON CONFLICT (request_id) DO UPDATE SET
                source_result_hash = EXCLUDED.source_result_hash,
                source_generation = EXCLUDED.source_generation,
                risk_policy_version = EXCLUDED.risk_policy_version,
                status = 'partial', reason = 'SOURCE_EVIDENCE_EXPIRED',
                lease_token = NULL, lease_expires_at = NULL,
                updated_at = pg_catalog.clock_timestamp();
        END IF;

        UPDATE public.analysis_v2_score_audit_intents AS intent
        SET intent_status = 'released',
            updated_at = pg_catalog.clock_timestamp()
        WHERE intent.request_id = v_expired.request_id
          AND intent.source_result_hash = v_expired.source_result_hash
          AND intent.source_generation = v_expired.source_generation;

        DELETE FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
        WHERE stage.request_id = v_expired.request_id
          AND stage.stage_kind = 'final_score'
          AND stage.batch_key = -1
          AND stage.result_hash = v_expired.source_result_hash;

        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

-- Terminal result cleanup takes the same intent/checkpoint/summary/run locks as
-- the TTL drain. Keeping the intent lock first serializes this purge with audit
-- claims, while the parent summary lock keeps the run FK-safe.
CREATE OR REPLACE FUNCTION public.analysis_v2_purge_result_working_set(
    p_request_id UUID,
    p_keep_final BOOLEAN
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF p_request_id IS NULL OR p_keep_final IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_RESULT_INVALID', ERRCODE = 'P0001';
    END IF;

    -- Claim and expiry processing both serialize on the intent row. A missing
    -- intent remains a supported orphan path and simply produces no row lock.
    PERFORM 1
    FROM public.analysis_v2_score_audit_intents AS intent
    WHERE intent.request_id = p_request_id
    FOR UPDATE;

    -- Lock every rich checkpoint before taking either the result-summary or run
    -- lock. This includes checkpoints that will be deleted unconditionally.
    PERFORM 1
    FROM public.analysis_v2_ai_scoring_stage_checkpoints AS stage
    WHERE stage.request_id = p_request_id
    ORDER BY stage.stage_kind, stage.batch_key
    FOR UPDATE;

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

    -- Lock an existing run after its parent summary, preserving the same order
    -- for ON CONFLICT/FK work performed by the TTL drain.
    PERFORM 1
    FROM public.analysis_v2_score_audit_runs AS run
    WHERE run.request_id = p_request_id
    FOR UPDATE;

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
END;
$$;
