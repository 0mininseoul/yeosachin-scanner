-- The existing profile-evidence recovery RPC is intentionally strict: a generic
-- SCRAPING_INCOMPLETE_ERROR must not become a paid-order retry.  The incident that
-- motivated this migration has one very narrow durable shape that can be checked
-- without trusting an operator-supplied UUID:
--
--   * the only failure receipt is for track:relationships:collect and its input hash
--     still matches that job;
--   * exactly one authenticated self-hosted relationship receipt survived, for one
--     canonical followers/following side, with a non-empty bounded item array and the
--     primary account (the counterpart is therefore absent);
--   * no relationship evidence side was checkpointed (the failing concurrent branch
--     rolled back before its side checkpoint);
--   * the paid provider ledger, cost ledger, and active jobs remain empty (the base
--     RPC keeps those zero-spend/no-live-work guards).
--
-- The Cloud Run /v1/profiles profile-batch HTTP 502 is a log-only observation in this
-- schema; there is no durable profile-batch HTTP witness to query here.  Consequently this proof is the
-- narrowest DB-verifiable discriminator available, not a claim that the log status is
-- persisted.  A generic SCRAPING_INCOMPLETE_ERROR remains rejected unless every one of
-- the above authenticated receipt predicates matches.  This does leave a residual
-- operator tradeoff: a different self-hosted relationship failure with the same exact
-- one authenticated relationship receipt shape would also qualify.  The immutable
-- receipt/job hash, no-evidence topology, and zero-spend guards keep that exception
-- auditable and prevent broad error-code widening.

DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.recover_earlybird_profile_evidence_failed_fulfillment(uuid,uuid,timestamp with time zone)'::pg_catalog.regprocedure
    );

    v_rewritten := pg_catalog.replace(
        v_definition,
        $anchor$       OR v_request.error_message <> 'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'
       OR v_preflight.status <> 'consumed'$anchor$,
        $replacement$       OR NOT (
            v_request.error_message IN (
                'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE',
                'SCRAPING_INCOMPLETE_ERROR'
            )
       )
       OR v_preflight.status <> 'consumed'$replacement$
    );
    IF v_rewritten = v_definition THEN
        RAISE EXCEPTION 'AUTHENTICATED_RELATIONSHIP_PROFILE_BATCH_RECOVERY_PATCH_MISMATCH';
    END IF;

    v_definition := v_rewritten;
    v_rewritten := pg_catalog.replace(
        v_definition,
        $anchor$
       OR NOT EXISTS (
            SELECT 1
            FROM public.analysis_v2_failure_receipts AS receipt
            WHERE receipt.request_id = v_request.id
              AND receipt.error_code = 'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'
       )
       OR 1 <> ($anchor$,
        $replacement$
       OR NOT (
            (
                v_request.error_message = 'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'
                AND EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_failure_receipts AS receipt
                    WHERE receipt.request_id = v_request.id
                      AND receipt.error_code = 'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE'
                )
            )
            OR (
                v_request.error_message = 'SCRAPING_INCOMPLETE_ERROR'
                AND EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_failure_receipts AS receipt
                    JOIN public.analysis_pipeline_jobs AS failed_job
                      ON failed_job.request_id = receipt.request_id
                     AND failed_job.job_key = receipt.failed_job_key
                    WHERE receipt.request_id = v_request.id
                      AND receipt.failed_job_key = 'track:relationships:collect'
                      AND receipt.failed_job_input_hash = failed_job.input_hash
                      AND failed_job.status = 'failed'
                      AND failed_job.track = 'relationships'
                      AND failed_job.kind = 'collection'
                      AND failed_job.last_error_code = 'SCRAPING_INCOMPLETE_ERROR'
                      AND receipt.error_code = 'SCRAPING_INCOMPLETE_ERROR'
                )
                AND 1 = (
                    SELECT pg_catalog.count(*)
                    FROM public.analysis_v2_selfhosted_auth_runs AS auth_run
                    WHERE auth_run.request_id = v_request.id
                      AND auth_run.job_key = 'track:relationships:collect'
                )
                AND EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_selfhosted_auth_runs AS auth_run
                    WHERE auth_run.request_id = v_request.id
                      AND auth_run.job_key = 'track:relationships:collect'
                      AND auth_run.operation_key ~ '^relationship-(followers|following):[0-9a-f]{64}$'
                      AND auth_run.account_slot = 'primary'
                      AND pg_catalog.jsonb_typeof(auth_run.items) = 'array'
                      AND pg_catalog.jsonb_array_length(auth_run.items) > 0
                      AND NOT EXISTS (
                          SELECT 1
                          FROM pg_catalog.jsonb_array_elements(auth_run.items) AS item(value)
                          WHERE pg_catalog.jsonb_typeof(item.value) <> 'object'
                      )
                )
                AND NOT EXISTS (
                    SELECT 1
                    FROM public.analysis_v2_relationship_sides AS side
                    WHERE side.request_id = v_request.id
                      AND side.job_key = 'track:relationships:collect'
                )
            )
       )
       OR 1 <> ($replacement$
    );
    IF v_rewritten = v_definition THEN
        RAISE EXCEPTION 'AUTHENTICATED_RELATIONSHIP_PROFILE_BATCH_RECOVERY_RECEIPT_PATCH_MISMATCH';
    END IF;

    EXECUTE v_rewritten;
END;
$migration$;

REVOKE ALL ON FUNCTION public.recover_earlybird_profile_evidence_failed_fulfillment(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_earlybird_profile_evidence_failed_fulfillment(
    UUID, UUID, TIMESTAMP WITH TIME ZONE
) TO service_role;
