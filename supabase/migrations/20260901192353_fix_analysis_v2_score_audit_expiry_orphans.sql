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
    -- Keep the lock order intent -> summary -> run -> checkpoint. Locking the
    -- summary before inserting the child run also serializes concurrent parent
    -- cleanup, so a summary cannot disappear between classification and FK
    -- validation.
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
