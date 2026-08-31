BEGIN;

/*
 * A successful direct-fresh Apify run is immutable evidence. The execution
 * claim token is only a live-job fence and may rotate after redelivery. This
 * RPC admits an exact retained checkpoint under the new live claim, atomically
 * rebinding only the mutable provider fence, then performs the paid Earlybird
 * order, dataset, and row-attribution checks required for replay. No provider
 * API is called and no checkpoint payload is changed.
 */
CREATE OR REPLACE FUNCTION public.load_analysis_v2_profile_fetch_checkpoint_for_retry(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_operation_key TEXT,
    p_provider_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_order_id UUID;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_provider public.analysis_v2_provider_runs%ROWTYPE;
    v_batch public.analysis_v2_profile_fetch_batches%ROWTYPE;
    v_outcome_count INTEGER;
    v_failed_count INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR p_job_key !~ '^track:(target-evidence:collect|profiles:batch:[0-9]+)$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_operation_key IS NULL
       OR p_operation_key !~ '^(target-profile|profile-fallback):[a-f0-9]{64}$'
       OR p_provider_input_hash IS NULL OR p_provider_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.order_id INTO v_order_id
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.request_id = p_request_id;
    IF v_order_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_order_id FOR UPDATE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_order_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    SELECT provider_run.* INTO v_provider
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    SELECT batch.* INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id AND batch.job_key = p_job_key
    FOR UPDATE;

    IF v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_job.request_id IS NULL
       OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    -- A new run has no retained checkpoint; the caller may proceed through
    -- ordinary reservation admission. Only an existing batch enters this
    -- claim-rebinding path.
    IF v_batch.request_id IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_fulfillment.order_id IS NULL
       OR v_fulfillment.request_id IS DISTINCT FROM p_request_id
       OR v_fulfillment.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_fulfillment.manual_review_at IS NOT NULL
       OR v_order.id IS NULL
       OR v_order.result_request_id IS DISTINCT FROM p_request_id
       OR v_order.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_order.payment_id IS NULL
       OR v_order.paid_at IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_preflight.id IS NULL
       OR v_preflight.consumed_request_id IS DISTINCT FROM p_request_id
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_provider.request_id IS NULL
       OR v_provider.input_hash IS DISTINCT FROM p_provider_input_hash
       OR v_provider.logical_provider IS DISTINCT FROM 'apify'
       OR v_provider.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR v_provider.credential_slot IS DISTINCT FROM 'secondary'
       OR v_provider.status IS DISTINCT FROM 'succeeded'
       OR v_provider.run_id IS NULL
       OR v_provider.run_started_at IS NULL
       OR v_provider.terminalized_at IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_PROVIDER_NOT_SUCCEEDED', ERRCODE = 'P0001';
    END IF;

    SELECT count(*)::INTEGER INTO v_outcome_count
    FROM public.analysis_v2_profile_fetch_outcomes AS outcome
    WHERE outcome.request_id = p_request_id
      AND outcome.job_key = p_job_key
      AND outcome.attempt = 'fresh_apify';
    SELECT count(*)::INTEGER INTO v_failed_count
    FROM public.analysis_v2_profile_fetch_outcomes AS outcome
    WHERE outcome.request_id = p_request_id
      AND outcome.job_key = p_job_key
      AND outcome.attempt = 'fresh_apify'
      AND outcome.status = 'failed';
    IF v_batch.primary_completed_at IS NULL
       OR v_batch.primary_payload_hash IS NULL
       OR v_batch.primary_payload_hash !~ '^[a-f0-9]{64}$'
       OR NOT public.analysis_v2_valid_profile_username_list(
            v_batch.requested_usernames,
            FALSE
       )
       OR v_batch.fallback_completed_at IS NOT NULL
       OR v_batch.fallback_payload_hash IS NOT NULL
       OR v_batch.repair_completed_at IS NOT NULL
       OR v_batch.repair_payload_hash IS NOT NULL
       OR v_batch.repair_usernames IS NOT NULL
       OR v_outcome_count IS DISTINCT FROM pg_catalog.cardinality(v_batch.requested_usernames)
       OR v_failed_count > (
            pg_catalog.cardinality(v_batch.requested_usernames)
            - pg_catalog.ceil(
                pg_catalog.cardinality(v_batch.requested_usernames) * 0.9
              )::INTEGER
       )
       OR v_batch.frozen_unresolved_usernames IS DISTINCT FROM COALESCE((
            SELECT pg_catalog.array_agg(outcome.username::TEXT ORDER BY outcome.ordinal)
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = p_request_id
              AND outcome.job_key = p_job_key
              AND outcome.attempt = 'fresh_apify'
              AND outcome.status <> 'success'
       ), '{}'::TEXT[])
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = p_request_id
              AND outcome.job_key = p_job_key
              AND (
                   outcome.attempt <> 'fresh_apify'
                   OR outcome.source <> 'apify'
                   OR outcome.ordinal < 1
                   OR outcome.ordinal > pg_catalog.cardinality(v_batch.requested_usernames)
                   OR outcome.username IS DISTINCT FROM
                        v_batch.requested_usernames[outcome.ordinal::INTEGER]
                   OR outcome.status NOT IN ('success', 'unavailable', 'failed')
                   OR (
                        outcome.status = 'success'
                        AND (
                            outcome.profile_snapshot IS NULL
                            OR outcome.profile_snapshot->>'username' IS DISTINCT FROM outcome.username
                        )
                   )
                   OR (
                        outcome.status = 'failed'
                        AND outcome.failure_category NOT IN ('incomplete', 'schema')
                   )
              )
       ) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_CHECKPOINT_UNUSABLE', ERRCODE = 'P0001';
    END IF;

    IF p_job_key = 'track:target-evidence:collect'
       AND p_operation_key !~ '^target-profile:' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_SCOPE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF p_job_key <> 'track:target-evidence:collect'
       AND p_operation_key !~ '^profile-fallback:' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROFILE_RETRY_ADMISSION_SCOPE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    -- The provider reservation identity remains unchanged; only its current
    -- execution fence follows the current, already-validated job claim.
    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET job_claim_token = p_claim_token,
        updated_at = pg_catalog.clock_timestamp()
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
      AND provider_run.input_hash = p_provider_input_hash
      AND provider_run.status = 'succeeded';

    RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_profile_fetch_checkpoint_for_retry(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_profile_fetch_checkpoint_for_retry(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_profile_fetch_checkpoint_for_retry(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT
) IS 'Admits an exact retained succeeded direct-fresh Apify checkpoint under a current job lease fence; immutable provider identity is preserved and no provider call is made.';

COMMIT;
