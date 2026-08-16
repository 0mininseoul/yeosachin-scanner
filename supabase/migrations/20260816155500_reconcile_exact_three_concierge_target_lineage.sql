-- The exact three paid first15 generation-three canaries are still live
-- `analysis_in_progress` orders, but their terminal V2 request and consumed
-- preflight were scrubbed by the normal terminal-PII retention path. The
-- order row is the surviving paid checkout witness for the target handle.
--
-- Repair only that provable shape. The operator supplies a hash over the
-- exact three candidate rows after a read-only dry run. The RPC locks the
-- candidate rows, rechecks payment/refund, request/preflight/rearm lineage,
-- and provider settlement, then updates only the two stale target fields.
-- No order, fulfillment, request status, job, provider run, or completed
-- result is advanced. The immutable audit stores hashes, never target text.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE TABLE public.earlybird_concierge_batch_target_lineage_repairs (
    cohort_key TEXT NOT NULL CHECK (
        cohort_key = 'concierge-fallback-20260816'
    ),
    order_id UUID NOT NULL REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id)
        ON DELETE RESTRICT,
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id)
        ON DELETE RESTRICT,
    rearm_generation SMALLINT NOT NULL CHECK (rearm_generation = 3),
    source_failure_code TEXT NOT NULL CHECK (source_failure_code IN (
        'JOB_ATTEMPTS_EXHAUSTED',
        'SCRAPING_INCOMPLETE_ERROR',
        'SCRAPING_PROVIDER_START_REJECTED_ERROR'
    )),
    source_credential_slot TEXT NOT NULL CHECK (
        source_credential_slot = 'quinary'
    ),
    fallback_credential_slot TEXT NOT NULL CHECK (
        fallback_credential_slot = 'primary'
    ),
    allowlist_hash TEXT NOT NULL CHECK (allowlist_hash ~ '^[a-f0-9]{64}$'),
    old_request_target_hash TEXT NOT NULL CHECK (
        old_request_target_hash ~ '^[a-f0-9]{64}$'
    ),
    old_preflight_target_hash TEXT NOT NULL CHECK (
        old_preflight_target_hash ~ '^[a-f0-9]{64}$'
    ),
    repaired_target_hash TEXT NOT NULL CHECK (
        repaired_target_hash ~ '^[a-f0-9]{64}$'
    ),
    repaired_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (cohort_key, order_id),
    UNIQUE (cohort_key, request_id, preflight_id)
);

ALTER TABLE public.earlybird_concierge_batch_target_lineage_repairs
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_concierge_batch_target_lineage_repairs
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_concierge_batch_target_lineage_repairs
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_REPAIR_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_concierge_batch_target_lineage_repair_mutation
BEFORE UPDATE OR DELETE
ON public.earlybird_concierge_batch_target_lineage_repairs
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_concierge_batch_target_lineage_repair_mutation();

CREATE FUNCTION public.reconcile_exact_three_concierge_target_lineage(
    p_expected_allowlist_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_cohort_key CONSTANT TEXT := 'concierge-fallback-20260816';
    v_candidate_count INTEGER;
    v_candidate_hash TEXT;
    v_audit_count INTEGER;
    v_audit_hash TEXT;
    v_repaired_count INTEGER := 0;
    v_audit_valid_count INTEGER;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_candidate RECORD;
BEGIN
    IF p_expected_allowlist_hash IS NULL
       OR p_expected_allowlist_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_ALLOWLIST_REQUIRED',
            ERRCODE = 'P0001';
    END IF;

    -- Serialize this one-shot repair and make a partial audit impossible to
    -- mistake for a successful exact-three repair.
    LOCK TABLE public.earlybird_concierge_batch_target_lineage_repairs
        IN SHARE ROW EXCLUSIVE MODE;

    SELECT pg_catalog.count(*)::INTEGER,
        pg_catalog.min(repair.allowlist_hash),
        pg_catalog.max(repair.allowlist_hash)
      INTO v_audit_count, v_audit_hash, v_candidate_hash
    FROM public.earlybird_concierge_batch_target_lineage_repairs AS repair
    WHERE repair.cohort_key = v_cohort_key;

    IF v_audit_count > 0 THEN
        IF v_audit_count <> 3
           OR v_audit_hash IS NULL
           OR v_audit_hash IS DISTINCT FROM v_candidate_hash
           OR v_audit_hash IS DISTINCT FROM p_expected_allowlist_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_AUDIT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        SELECT pg_catalog.count(*)::INTEGER
          INTO v_audit_valid_count
        FROM public.earlybird_concierge_batch_target_lineage_repairs AS repair
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = repair.order_id
        JOIN public.analysis_requests AS request_row
          ON request_row.id = repair.request_id
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = repair.preflight_id
        WHERE repair.cohort_key = v_cohort_key
          AND earlybird_order.result_request_id = request_row.id
          AND earlybird_order.preflight_id = preflight.id
          AND pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id))
                = pg_catalog.lower(pg_catalog.btrim(request_row.target_instagram_id))
          AND pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id))
                = pg_catalog.lower(pg_catalog.btrim(preflight.target_instagram_id))
          AND repair.repaired_target_hash = pg_catalog.encode(
                extensions.digest(
                    pg_catalog.convert_to(
                        pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id)),
                        'UTF8'
                    ), 'sha256'
                ), 'hex'
            );
        IF v_audit_valid_count <> 3 THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_AUDIT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'cohortKey', v_cohort_key,
            'allowlistHash', p_expected_allowlist_hash,
            'candidateCount', 3,
            'updatedCount', 0,
            'auditCount', 3,
            'status', 'already_reconciled'
        );
    END IF;

    -- Lock every row participating in the exact predicate before counting or
    -- hashing. A concurrent payment/refund, rearm, or terminal transition
    -- therefore either waits for this transaction or makes the count/hash
    -- checks fail closed.
    PERFORM 1
    FROM public.earlybird_orders AS earlybird_order
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    JOIN public.analysis_requests AS request_row
      ON request_row.id = earlybird_order.result_request_id
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = earlybird_order.preflight_id
    JOIN public.earlybird_first15_canary_provider_rearms AS rearm
      ON rearm.order_id = earlybird_order.id
     AND rearm.rearmed_preflight_id = preflight.id
    WHERE earlybird_order.paid_at IS NOT NULL
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
      AND earlybird_order.actual_amount_krw IS NOT DISTINCT FROM earlybird_order.expected_amount_krw
      AND earlybird_order.actual_groble_product_id IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
      AND earlybird_order.target_instagram_id IS NOT NULL
      AND pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id))
            = earlybird_order.target_instagram_id
      AND earlybird_order.target_instagram_id ~ '^[a-z0-9._]{1,30}$'
      AND earlybird_order.plan_id IN ('basic', 'standard')
      AND earlybird_order.status = 'analysis_in_progress'
      AND fulfillment.status = 'analysis_in_progress'
      AND fulfillment.request_id = request_row.id
      AND request_row.user_id = earlybird_order.user_id
      AND request_row.preflight_id = preflight.id
      AND request_row.pipeline_version = 'v2'
      AND request_row.status = 'failed'
      AND request_row.current_step = 'failed'
      AND request_row.error_message IN (
          'ANALYSIS_V2_JOB_HANDLER_FAILED',
          'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR'
      )
      AND request_row.plan_access_mode_snapshot = 'production'
      AND request_row.analysis_entry_channel = 'standard'
      AND request_row.selected_plan_id_snapshot = earlybird_order.plan_id
      AND request_row.idempotency_key LIKE 'earlybird:%'
      AND pg_catalog.right(request_row.idempotency_key, 3) = '.r3'
      AND request_row.target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(request_row.id::TEXT, '-', ''), 1, 20
      )
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'production'
      AND preflight.admission_status = 'ready'
      AND preflight.admission_selected_plan_id = earlybird_order.plan_id
      AND preflight.consumed_request_id = request_row.id
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
      )
      AND rearm.rearm_generation = 3
      AND rearm.source_credential_slot = 'quinary'
      AND rearm.fallback_credential_slot = 'primary'
      AND rearm.source_failure_code IN (
          'JOB_ATTEMPTS_EXHAUSTED',
          'SCRAPING_INCOMPLETE_ERROR',
          'SCRAPING_PROVIDER_START_REJECTED_ERROR'
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS refund_event
          WHERE refund_event.payment_id = earlybird_order.payment_id
            AND refund_event.event_type IN (
                'payment.refunded',
                'payment.refund_pending',
                'payment.cancelled',
                'payment.failed'
            )
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_pipeline_jobs AS job
          WHERE job.request_id = request_row.id
            AND job.status IN ('pending', 'processing', 'retryable')
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_v2_provider_runs AS provider_run
          WHERE provider_run.request_id = request_row.id
            AND provider_run.status IN ('starting', 'running')
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_v2_provider_runs AS provider_run
          WHERE provider_run.request_id = request_row.id
            AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND provider_run.max_charge_usd > 0
            AND (
                provider_run.actual_usage_usd IS NULL
                OR provider_run.usage_reconciled_at IS NULL
            )
      )
    FOR UPDATE OF earlybird_order, fulfillment, request_row, preflight, rearm;

    SELECT pg_catalog.count(*)::INTEGER,
        pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
            pg_catalog.string_agg(
                pg_catalog.concat_ws('|',
                    earlybird_order.id::TEXT,
                    request_row.id::TEXT,
                    preflight.id::TEXT,
                    rearm.rearm_generation::TEXT,
                    rearm.source_failure_code,
                    rearm.source_credential_slot,
                    rearm.fallback_credential_slot,
                    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                        pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id)),
                        'UTF8'
                    ), 'sha256'), 'hex'),
                    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                        request_row.target_instagram_id, 'UTF8'
                    ), 'sha256'), 'hex'),
                    pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                        preflight.target_instagram_id, 'UTF8'
                    ), 'sha256'), 'hex')
                ), '||' ORDER BY earlybird_order.id
            ), 'UTF8'
        ), 'sha256'), 'hex')
      INTO v_candidate_count, v_candidate_hash
    FROM public.earlybird_orders AS earlybird_order
    JOIN public.earlybird_fulfillments AS fulfillment
      ON fulfillment.order_id = earlybird_order.id
    JOIN public.analysis_requests AS request_row
      ON request_row.id = earlybird_order.result_request_id
    JOIN public.analysis_preflights AS preflight
      ON preflight.id = earlybird_order.preflight_id
    JOIN public.earlybird_first15_canary_provider_rearms AS rearm
      ON rearm.order_id = earlybird_order.id
     AND rearm.rearmed_preflight_id = preflight.id
    WHERE earlybird_order.paid_at IS NOT NULL
      AND earlybird_order.payment_id IS NOT NULL
      AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
      AND earlybird_order.actual_amount_krw IS NOT DISTINCT FROM earlybird_order.expected_amount_krw
      AND earlybird_order.actual_groble_product_id IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
      AND earlybird_order.target_instagram_id IS NOT NULL
      AND pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id))
            = earlybird_order.target_instagram_id
      AND earlybird_order.target_instagram_id ~ '^[a-z0-9._]{1,30}$'
      AND earlybird_order.plan_id IN ('basic', 'standard')
      AND earlybird_order.status = 'analysis_in_progress'
      AND fulfillment.status = 'analysis_in_progress'
      AND fulfillment.request_id = request_row.id
      AND request_row.user_id = earlybird_order.user_id
      AND request_row.preflight_id = preflight.id
      AND request_row.pipeline_version = 'v2'
      AND request_row.status = 'failed'
      AND request_row.current_step = 'failed'
      AND request_row.error_message IN (
          'ANALYSIS_V2_JOB_HANDLER_FAILED',
          'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR'
      )
      AND request_row.plan_access_mode_snapshot = 'production'
      AND request_row.analysis_entry_channel = 'standard'
      AND request_row.selected_plan_id_snapshot = earlybird_order.plan_id
      AND request_row.idempotency_key LIKE 'earlybird:%'
      AND pg_catalog.right(request_row.idempotency_key, 3) = '.r3'
      AND request_row.target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(request_row.id::TEXT, '-', ''), 1, 20
      )
      AND preflight.status = 'consumed'
      AND preflight.access_mode = 'production'
      AND preflight.admission_status = 'ready'
      AND preflight.admission_selected_plan_id = earlybird_order.plan_id
      AND preflight.consumed_request_id = request_row.id
      AND preflight.pii_scrubbed_at IS NOT NULL
      AND preflight.target_instagram_id = 'retained.' || pg_catalog.substr(
            pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
      )
      AND rearm.rearm_generation = 3
      AND rearm.source_credential_slot = 'quinary'
      AND rearm.fallback_credential_slot = 'primary'
      AND rearm.source_failure_code IN (
          'JOB_ATTEMPTS_EXHAUSTED',
          'SCRAPING_INCOMPLETE_ERROR',
          'SCRAPING_PROVIDER_START_REJECTED_ERROR'
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.earlybird_webhook_events AS refund_event
          WHERE refund_event.payment_id = earlybird_order.payment_id
            AND refund_event.event_type IN (
                'payment.refunded',
                'payment.refund_pending',
                'payment.cancelled',
                'payment.failed'
            )
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_pipeline_jobs AS job
          WHERE job.request_id = request_row.id
            AND job.status IN ('pending', 'processing', 'retryable')
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_v2_provider_runs AS provider_run
          WHERE provider_run.request_id = request_row.id
            AND provider_run.status IN ('starting', 'running')
      )
      AND NOT EXISTS (
          SELECT 1
          FROM public.analysis_v2_provider_runs AS provider_run
          WHERE provider_run.request_id = request_row.id
            AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
            AND provider_run.max_charge_usd > 0
            AND (
                provider_run.actual_usage_usd IS NULL
                OR provider_run.usage_reconciled_at IS NULL
            )
      );

    IF v_candidate_count <> 3 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_COUNT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF v_candidate_hash IS DISTINCT FROM p_expected_allowlist_hash THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_ALLOWLIST_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    FOR v_candidate IN
        SELECT earlybird_order.id AS order_id,
            request_row.id AS request_id,
            preflight.id AS preflight_id,
            rearm.rearm_generation,
            rearm.source_failure_code,
            rearm.source_credential_slot,
            rearm.fallback_credential_slot,
            pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id))
                AS target_username,
            pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                request_row.target_instagram_id, 'UTF8'
            ), 'sha256'), 'hex') AS old_request_target_hash,
            pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                preflight.target_instagram_id, 'UTF8'
            ), 'sha256'), 'hex') AS old_preflight_target_hash,
            pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id)),
                'UTF8'
            ), 'sha256'), 'hex') AS repaired_target_hash
        FROM public.earlybird_orders AS earlybird_order
        JOIN public.earlybird_fulfillments AS fulfillment
          ON fulfillment.order_id = earlybird_order.id
        JOIN public.analysis_requests AS request_row
          ON request_row.id = earlybird_order.result_request_id
        JOIN public.analysis_preflights AS preflight
          ON preflight.id = earlybird_order.preflight_id
        JOIN public.earlybird_first15_canary_provider_rearms AS rearm
          ON rearm.order_id = earlybird_order.id
         AND rearm.rearmed_preflight_id = preflight.id
        WHERE earlybird_order.paid_at IS NOT NULL
          AND earlybird_order.payment_id IS NOT NULL
          AND earlybird_order.seller_reference_confirmed_at IS NOT NULL
          AND earlybird_order.actual_amount_krw IS NOT DISTINCT FROM earlybird_order.expected_amount_krw
          AND earlybird_order.actual_groble_product_id IS NOT DISTINCT FROM earlybird_order.expected_groble_product_id
          AND earlybird_order.target_instagram_id IS NOT NULL
          AND pg_catalog.lower(pg_catalog.btrim(earlybird_order.target_instagram_id))
                = earlybird_order.target_instagram_id
          AND earlybird_order.target_instagram_id ~ '^[a-z0-9._]{1,30}$'
          AND earlybird_order.plan_id IN ('basic', 'standard')
          AND earlybird_order.status = 'analysis_in_progress'
          AND fulfillment.status = 'analysis_in_progress'
          AND fulfillment.request_id = request_row.id
          AND request_row.user_id = earlybird_order.user_id
          AND request_row.preflight_id = preflight.id
          AND request_row.pipeline_version = 'v2'
          AND request_row.status = 'failed'
          AND request_row.current_step = 'failed'
          AND request_row.error_message IN (
              'ANALYSIS_V2_JOB_HANDLER_FAILED',
              'ANALYSIS_V2_STAGE_SCHEMA_VALIDATION_ERROR'
          )
          AND request_row.plan_access_mode_snapshot = 'production'
          AND request_row.analysis_entry_channel = 'standard'
          AND request_row.selected_plan_id_snapshot = earlybird_order.plan_id
          AND request_row.idempotency_key LIKE 'earlybird:%'
          AND pg_catalog.right(request_row.idempotency_key, 3) = '.r3'
          AND request_row.target_instagram_id = 'retained.' || pg_catalog.substr(
                pg_catalog.replace(request_row.id::TEXT, '-', ''), 1, 20
          )
          AND preflight.status = 'consumed'
          AND preflight.access_mode = 'production'
          AND preflight.admission_status = 'ready'
          AND preflight.admission_selected_plan_id = earlybird_order.plan_id
          AND preflight.consumed_request_id = request_row.id
          AND preflight.pii_scrubbed_at IS NOT NULL
          AND preflight.target_instagram_id = 'retained.' || pg_catalog.substr(
                pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
          )
          AND rearm.rearm_generation = 3
          AND rearm.source_credential_slot = 'quinary'
          AND rearm.fallback_credential_slot = 'primary'
          AND rearm.source_failure_code IN (
              'JOB_ATTEMPTS_EXHAUSTED',
              'SCRAPING_INCOMPLETE_ERROR',
              'SCRAPING_PROVIDER_START_REJECTED_ERROR'
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.earlybird_webhook_events AS refund_event
              WHERE refund_event.payment_id = earlybird_order.payment_id
                AND refund_event.event_type IN (
                    'payment.refunded',
                    'payment.refund_pending',
                    'payment.cancelled',
                    'payment.failed'
                )
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_pipeline_jobs AS job
              WHERE job.request_id = request_row.id
                AND job.status IN ('pending', 'processing', 'retryable')
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = request_row.id
                AND provider_run.status IN ('starting', 'running')
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS provider_run
              WHERE provider_run.request_id = request_row.id
                AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
                AND provider_run.max_charge_usd > 0
                AND (
                    provider_run.actual_usage_usd IS NULL
                    OR provider_run.usage_reconciled_at IS NULL
                )
          )
        ORDER BY earlybird_order.id
    LOOP
        UPDATE public.analysis_requests AS request_row
        SET target_instagram_id = v_candidate.target_username
        WHERE request_row.id = v_candidate.request_id
          AND request_row.target_instagram_id = 'retained.' || pg_catalog.substr(
                pg_catalog.replace(request_row.id::TEXT, '-', ''), 1, 20
          );
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_REQUEST_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        UPDATE public.analysis_preflights AS preflight
        SET target_instagram_id = v_candidate.target_username,
            updated_at = v_now
        WHERE preflight.id = v_candidate.preflight_id
          AND preflight.target_instagram_id = 'retained.' || pg_catalog.substr(
                pg_catalog.replace(preflight.id::TEXT, '-', ''), 1, 20
          )
          AND preflight.pii_scrubbed_at IS NOT NULL;
        IF NOT FOUND THEN
            RAISE EXCEPTION USING
                MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_PREFLIGHT_CONFLICT',
                ERRCODE = 'P0001';
        END IF;

        INSERT INTO public.earlybird_concierge_batch_target_lineage_repairs (
            cohort_key, order_id, request_id, preflight_id, rearm_generation,
            source_failure_code, source_credential_slot, fallback_credential_slot,
            allowlist_hash, old_request_target_hash, old_preflight_target_hash,
            repaired_target_hash, repaired_at
        ) VALUES (
            v_cohort_key, v_candidate.order_id, v_candidate.request_id,
            v_candidate.preflight_id, v_candidate.rearm_generation,
            v_candidate.source_failure_code, v_candidate.source_credential_slot,
            v_candidate.fallback_credential_slot, v_candidate_hash,
            v_candidate.old_request_target_hash, v_candidate.old_preflight_target_hash,
            v_candidate.repaired_target_hash, v_now
        );
        v_repaired_count := v_repaired_count + 1;
    END LOOP;

    IF v_repaired_count <> 3 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'CONCIERGE_BATCH_TARGET_LINEAGE_REPAIR_COUNT_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'cohortKey', v_cohort_key,
        'allowlistHash', v_candidate_hash,
        'candidateCount', v_candidate_count,
        'updatedCount', v_repaired_count,
        'auditCount', v_repaired_count,
        'status', 'reconciled'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_exact_three_concierge_target_lineage(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reconcile_exact_three_concierge_target_lineage(TEXT)
    TO service_role;

COMMENT ON TABLE public.earlybird_concierge_batch_target_lineage_repairs IS
    'Immutable hash-only audit of the one-shot exact-three paid first15 target-lineage repair.';
COMMENT ON FUNCTION public.reconcile_exact_three_concierge_target_lineage(TEXT) IS
    'Service-role-only exact-three repair. Requires a read-only operator allowlist hash and repairs only scrubbed request/preflight target handles.';

COMMIT;
