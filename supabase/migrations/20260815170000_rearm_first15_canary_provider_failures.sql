-- MIGRATION_PREDECESSOR=20260815160000
-- Replay only paid first15 provider-canary failures.  The original request,
-- provider ledger, and fresh-admission profile run stay immutable; the replay
-- receives a new preflight and exactly one ordered credential fallback.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

DO $predecessor$
BEGIN
    IF pg_catalog.to_regclass('supabase_migrations.schema_migrations') IS NOT NULL
       AND NOT EXISTS (
           SELECT 1
           FROM supabase_migrations.schema_migrations
           WHERE version = '20260815160000'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_PREDECESSOR_MISSING',
            ERRCODE = 'P0001';
    END IF;
END;
$predecessor$;

CREATE TABLE public.earlybird_first15_canary_provider_rearms (
    order_id UUID NOT NULL REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    rearm_generation SMALLINT NOT NULL CHECK (rearm_generation BETWEEN 1 AND 4),
    source_request_id UUID NOT NULL UNIQUE REFERENCES public.analysis_requests(id)
        ON DELETE RESTRICT,
    source_preflight_id UUID NOT NULL UNIQUE REFERENCES public.analysis_preflights(id)
        ON DELETE RESTRICT,
    profile_source_preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id)
        ON DELETE RESTRICT,
    rearmed_preflight_id UUID NOT NULL UNIQUE REFERENCES public.analysis_preflights(id)
        ON DELETE RESTRICT,
    source_failure_code TEXT NOT NULL CHECK (source_failure_code IN (
        'SCRAPING_INCOMPLETE_ERROR',
        'SCRAPING_PROVIDER_QUOTA_ERROR',
        'SCRAPING_PROVIDER_START_REJECTED_ERROR'
    )),
    source_credential_slot TEXT NOT NULL CHECK (
        public.analysis_v2_valid_apify_credential_slot(source_credential_slot)
    ),
    fallback_credential_slot TEXT NOT NULL CHECK (
        public.analysis_v2_valid_apify_credential_slot(fallback_credential_slot)
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (order_id, rearm_generation),
    CHECK ((source_credential_slot, fallback_credential_slot) IN (
        ('senary', 'tertiary'),
        ('tertiary', 'quinary'),
        ('quinary', 'primary'),
        ('primary', 'secondary')
    ))
);

ALTER TABLE public.earlybird_first15_canary_provider_rearms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_first15_canary_provider_rearms FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_first15_canary_provider_rearms
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER prevent_earlybird_first15_canary_provider_rearm_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_first15_canary_provider_rearms
FOR EACH ROW EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

CREATE FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()
RETURNS TABLE(
    order_id UUID,
    request_id UUID,
    preflight_id UUID,
    error_code TEXT,
    credential_slot TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT fulfillment.order_id,
        request.id AS request_id,
        request.preflight_id,
        request.error_message AS error_code,
        earlybird_order.concierge_apify_credential_slot AS credential_slot
    FROM public.earlybird_fulfillments AS fulfillment
    JOIN public.analysis_requests AS request
      ON request.id = fulfillment.request_id
    JOIN public.earlybird_orders AS earlybird_order
      ON earlybird_order.id = fulfillment.order_id
    WHERE fulfillment.status = 'analysis_in_progress'
      AND earlybird_order.status = 'analysis_in_progress'
      AND earlybird_order.result_request_id = request.id
      AND request.pipeline_version = 'v2'
      AND request.status = 'failed'
      AND request.current_step = 'failed'
      AND request.error_message IN (
          'SCRAPING_INCOMPLETE_ERROR',
          'SCRAPING_PROVIDER_QUOTA_ERROR',
          'SCRAPING_PROVIDER_START_REJECTED_ERROR'
      )
    ORDER BY request.created_at, request.id
    LIMIT 24;
$$;

REVOKE ALL ON FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_earlybird_first15_canary_provider_recovery_candidates()
    TO service_role;

CREATE FUNCTION public.rearm_earlybird_first15_canary_provider_failure(
    p_order_id UUID,
    p_expected_failed_request_id UUID,
    p_fallback_credential_slot TEXT
)
RETURNS TABLE(
    applied BOOLEAN,
    fulfillment_status TEXT,
    request_id UUID,
    initial_job_key TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_user_id_hint UUID;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_source_request public.analysis_requests%ROWTYPE;
    v_source_preflight public.analysis_preflights%ROWTYPE;
    v_profile_source_preflight public.analysis_preflights%ROWTYPE;
    v_existing public.earlybird_first15_canary_provider_rearms%ROWTYPE;
    v_previous public.earlybird_first15_canary_provider_rearms%ROWTYPE;
    v_profile_run public.analysis_preflight_provider_runs%ROWTYPE;
    v_claim RECORD;
    v_created RECORD;
    v_new_preflight_id UUID;
    v_rearm_generation SMALLINT;
    v_entitlement_hash TEXT;
    v_base_preflight_key TEXT;
BEGIN
    IF p_order_id IS NULL
       OR p_expected_failed_request_id IS NULL
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_fallback_credential_slot)
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.user_id INTO v_user_id_hint
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_NOT_FOUND', ERRCODE = 'P0001';
    END IF;

    PERFORM 1 FROM public.users AS recovery_user
    WHERE recovery_user.id = v_user_id_hint
    FOR KEY SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    SELECT request.* INTO v_source_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_expected_failed_request_id
    FOR UPDATE;
    SELECT rearm.* INTO v_existing
    FROM public.earlybird_first15_canary_provider_rearms AS rearm
    WHERE rearm.source_request_id = p_expected_failed_request_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.order_id IS DISTINCT FROM p_order_id
           OR v_existing.fallback_credential_slot IS DISTINCT FROM p_fallback_credential_slot
           OR v_order.preflight_id IS DISTINCT FROM v_existing.rearmed_preflight_id
           OR v_fulfillment.request_id IS NULL
        THEN
            RAISE EXCEPTION USING
                MESSAGE = 'FIRST15_CANARY_RECOVERY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN QUERY SELECT FALSE, v_fulfillment.status, v_fulfillment.request_id,
            'coordinator:bootstrap'::TEXT;
        RETURN;
    END IF;

    SELECT preflight.* INTO v_source_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    SELECT rearm.* INTO v_previous
    FROM public.earlybird_first15_canary_provider_rearms AS rearm
    WHERE rearm.rearmed_preflight_id = v_source_preflight.id
    FOR UPDATE;

    IF v_order.id IS NULL
       OR v_fulfillment.order_id IS NULL
       OR v_source_request.id IS NULL
       OR v_source_preflight.id IS NULL
       OR v_order.user_id IS DISTINCT FROM v_user_id_hint
       OR v_order.status <> 'analysis_in_progress'
       OR v_order.result_request_id IS DISTINCT FROM v_source_request.id
       OR v_order.plan_id NOT IN ('basic', 'standard')
       OR v_order.payment_id IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR EXISTS (
           SELECT 1 FROM public.earlybird_webhook_events AS refund_event
           WHERE refund_event.payment_id = v_order.payment_id
             AND refund_event.event_type IN (
                 'payment.refunded', 'payment.refund_pending',
                 'payment.cancelled', 'payment.failed'
             )
       )
       OR v_fulfillment.status <> 'analysis_in_progress'
       OR v_fulfillment.request_id IS DISTINCT FROM v_source_request.id
       OR v_fulfillment.lease_token IS NOT NULL
       OR v_fulfillment.lease_expires_at IS NOT NULL
       OR v_source_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_source_request.preflight_id IS DISTINCT FROM v_source_preflight.id
       OR v_source_request.pipeline_version <> 'v2'
       OR v_source_request.status <> 'failed'
       OR v_source_request.current_step <> 'failed'
       OR v_source_request.error_message NOT IN (
           'SCRAPING_INCOMPLETE_ERROR',
           'SCRAPING_PROVIDER_QUOTA_ERROR',
           'SCRAPING_PROVIDER_START_REJECTED_ERROR'
       )
       OR NOT EXISTS (
           SELECT 1 FROM public.analysis_v2_failure_receipts AS receipt
           WHERE receipt.request_id = v_source_request.id
             AND receipt.failed_job_key IN (
                 'track:relationships:collect',
                 'track:target-evidence:collect'
             )
             AND receipt.error_code = v_source_request.error_message
       )
       OR EXISTS (
           SELECT 1 FROM public.analysis_pipeline_jobs AS job
           WHERE job.request_id = v_source_request.id
             AND job.status IN ('pending', 'processing', 'retryable')
       )
       OR EXISTS (
           SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
           WHERE provider_run.request_id = v_source_request.id
             AND provider_run.status IN ('starting', 'running')
       )
       OR EXISTS (
           SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
           WHERE provider_run.request_id = v_source_request.id
             AND provider_run.status IN ('succeeded', 'aborted', 'failed', 'timed_out')
             AND provider_run.run_id IS NOT NULL
             AND (
                 provider_run.actual_usage_usd IS NULL
                 OR provider_run.usage_reconciled_at IS NULL
             )
       )
       OR v_source_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_source_preflight.access_mode <> 'production'
       OR v_source_preflight.status <> 'consumed'
       OR v_source_preflight.consumed_request_id IS DISTINCT FROM v_source_request.id
       OR v_source_preflight.admission_status <> 'ready'
       OR v_source_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR v_source_preflight.admission_target_followers_count IS NULL
       OR v_source_preflight.admission_target_following_count IS NULL
       OR v_source_preflight.admission_capacity_required_plan_id IS NULL
       OR v_source_preflight.admission_required_plan_id IS NULL
       OR v_source_preflight.admission_plan_cards_snapshot IS NULL
       OR v_order.concierge_apify_credential_slot IS NULL
       OR (v_order.concierge_apify_credential_slot, p_fallback_credential_slot)
            NOT IN (
                ('senary', 'tertiary'),
                ('tertiary', 'quinary'),
                ('quinary', 'primary'),
                ('primary', 'secondary')
            )
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_INELIGIBLE', ERRCODE = 'P0001';
    END IF;

    IF v_previous.order_id IS NULL THEN
        v_profile_source_preflight := v_source_preflight;
        v_rearm_generation := 1;
    ELSE
        IF v_previous.order_id IS DISTINCT FROM v_order.id
           OR v_previous.fallback_credential_slot
                IS DISTINCT FROM v_order.concierge_apify_credential_slot
        THEN
            RAISE EXCEPTION USING
                MESSAGE = 'FIRST15_CANARY_RECOVERY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        SELECT preflight.* INTO v_profile_source_preflight
        FROM public.analysis_preflights AS preflight
        WHERE preflight.id = v_previous.profile_source_preflight_id
        FOR KEY SHARE;
        v_rearm_generation := v_previous.rearm_generation + 1;
    END IF;
    IF v_rearm_generation NOT BETWEEN 1 AND 4 OR v_profile_source_preflight.id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.* INTO v_profile_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = v_profile_source_preflight.id
      AND provider_run.operation_key = 'target-profile-fresh-admission:g1'
    FOR KEY SHARE;
    IF NOT FOUND
       OR v_profile_run.status <> 'succeeded'
       OR v_profile_run.logical_provider <> 'apify'
       OR v_profile_run.actor_id <> 'apify/instagram-profile-scraper'
       OR v_profile_run.run_id IS NULL
       OR v_profile_run.actual_usage_usd IS NULL
       OR v_profile_run.usage_reconciled_at IS NULL
       OR v_profile_run.reusable_profile_schema_version <> 1
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_PROFILE_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;

    v_base_preflight_key := 'earlybird.fulfillment.'
        || pg_catalog.replace(v_order.id::TEXT, '-', '');
    v_entitlement_hash := pg_catalog.encode(extensions.digest(
        pg_catalog.convert_to(
            'earlybird-fulfillment-admission-v1' || pg_catalog.chr(10)
            || pg_catalog.lower(v_order.id::TEXT),
            'UTF8'
        ), 'sha256'
    ), 'hex');
    v_new_preflight_id := extensions.gen_random_uuid();

    INSERT INTO public.analysis_preflights(
        id, user_id, idempotency_key, target_instagram_id, status,
        exclusion_decision, excluded_instagram_id, access_mode,
        launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
        pricing_version, pricing_snapshot, policy_versions_snapshot,
        target_followers_count, target_following_count, target_is_private,
        capacity_required_plan_id, required_plan_id, created_at, updated_at,
        expires_at, ready_at,
        admission_status, admission_generation, admission_selected_plan_id,
        admission_entitlement_jti_hash, admission_token,
        admission_requested_at, admission_refreshed_at,
        admission_dispatch_state, admission_dispatch_generation,
        admission_dispatch_token, admission_dispatch_reserved_at,
        admission_dispatched_at, admission_target_followers_count,
        admission_target_following_count,
        admission_capacity_required_plan_id, admission_required_plan_id,
        admission_plan_cards_snapshot, admission_failure_count,
        analysis_entry_channel, order_scoped_apify_credential_slot
    ) VALUES (
        v_new_preflight_id, v_order.user_id,
        v_base_preflight_key || '.first15r' || v_rearm_generation::TEXT,
        v_order.target_instagram_id, 'ready', v_order.exclusion_decision,
        v_order.excluded_instagram_id, 'production',
        v_source_preflight.launch_status_snapshot,
        v_source_preflight.plan_catalog_snapshot,
        v_source_preflight.admission_plan_cards_snapshot,
        v_source_preflight.pricing_version, v_source_preflight.pricing_snapshot,
        v_source_preflight.policy_versions_snapshot,
        v_order.target_followers_count, v_order.target_following_count, FALSE,
        v_source_preflight.admission_capacity_required_plan_id,
        v_source_preflight.admission_required_plan_id,
        v_now, v_now, v_now + INTERVAL '30 minutes', v_now,
        'ready', 1, v_order.plan_id, v_entitlement_hash,
        extensions.gen_random_uuid(), v_now, v_now,
        'enqueued', 1, extensions.gen_random_uuid(), v_now, v_now,
        v_source_preflight.admission_target_followers_count,
        v_source_preflight.admission_target_following_count,
        v_source_preflight.admission_capacity_required_plan_id,
        v_source_preflight.admission_required_plan_id,
        v_source_preflight.admission_plan_cards_snapshot, 0,
        v_source_preflight.analysis_entry_channel, p_fallback_credential_slot
    );

    INSERT INTO public.earlybird_first15_canary_provider_rearms(
        order_id, rearm_generation, source_request_id, source_preflight_id,
        profile_source_preflight_id, rearmed_preflight_id, source_failure_code,
        source_credential_slot, fallback_credential_slot
    ) VALUES (
        v_order.id, v_rearm_generation, v_source_request.id, v_source_preflight.id,
        v_profile_source_preflight.id, v_new_preflight_id,
        v_source_request.error_message, v_order.concierge_apify_credential_slot,
        p_fallback_credential_slot
    );

    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'paid', preflight_id = v_new_preflight_id,
        result_request_id = NULL,
        concierge_apify_credential_slot = p_fallback_credential_slot,
        updated_at = v_now
    WHERE earlybird_order.id = v_order.id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'admission_pending', attempt_count = 0, request_id = NULL,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = v_now,
        operator_admitted_at = v_now, last_error_code = NULL,
        last_error_at = NULL, manual_review_at = NULL, completed_at = NULL,
        updated_at = v_now
    WHERE fulfillment.order_id = v_order.id;

    SELECT * INTO v_claim
    FROM public.claim_earlybird_fulfillment(
        v_order.id, extensions.gen_random_uuid(), 300
    );
    IF v_claim.claimed IS DISTINCT FROM TRUE
       OR v_claim.fulfillment_status IS DISTINCT FROM 'admission_pending'
       OR v_claim.lease_token IS NULL
       OR v_claim.lease_fence IS NULL
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_CLAIM_CONFLICT', ERRCODE = 'P0001';
    END IF;
    SELECT * INTO v_created
    FROM public.create_or_replay_earlybird_fulfillment_request(
        v_order.id, v_claim.lease_token, v_claim.lease_fence
    );
    IF v_created.order_id IS DISTINCT FROM v_order.id
       OR v_created.fulfillment_status IS DISTINCT FROM 'analysis_in_progress'
       OR v_created.request_id IS NULL
       OR v_created.initial_job_key IS DISTINCT FROM 'coordinator:bootstrap'
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_CANARY_RECOVERY_REQUEST_CONFLICT', ERRCODE = 'P0001';
    END IF;

    RETURN QUERY SELECT TRUE, v_created.fulfillment_status,
        v_created.request_id, v_created.initial_job_key;
END;
$$;

REVOKE ALL ON FUNCTION public.rearm_earlybird_first15_canary_provider_failure(
    UUID, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.rearm_earlybird_first15_canary_provider_failure(
    UUID, UUID, TEXT
) TO service_role;

-- Preserve the established target-profile gate and only consult an immutable
-- first15 replay row after it has returned no local profile checkpoint.
ALTER FUNCTION public.load_analysis_v2_reusable_target_profile_run(
    UUID, TEXT, UUID, TEXT
) RENAME TO load_analysis_v2_reusable_target_profile_run_pre_first15;
REVOKE ALL ON FUNCTION public.load_analysis_v2_reusable_target_profile_run_pre_first15(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.load_analysis_v2_reusable_target_profile_run_first15(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_rearm public.earlybird_first15_canary_provider_rearms%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_profile_run public.analysis_preflight_provider_runs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS DISTINCT FROM 'track:target-evidence:collect'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[0-9a-f]{64}$'
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_TARGET_PROFILE_REUSE_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
    FOR UPDATE;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT rearm.* INTO v_rearm
    FROM public.earlybird_first15_canary_provider_rearms AS rearm
    WHERE rearm.rearmed_preflight_id = v_request.preflight_id
    FOR KEY SHARE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_rearm.order_id
    FOR KEY SHARE;
    IF v_request.id IS NULL
       OR v_job.request_id IS NULL
       OR v_rearm.order_id IS NULL
       OR v_order.id IS NULL
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_order.status <> 'analysis_in_progress'
       OR v_order.concierge_apify_credential_slot
            IS DISTINCT FROM v_rearm.fallback_credential_slot
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_TARGET_PROFILE_REUSE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT provider_run.* INTO v_profile_run
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = v_rearm.profile_source_preflight_id
      AND provider_run.operation_key = 'target-profile-fresh-admission:g1';
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF v_profile_run.status <> 'succeeded'
       OR v_profile_run.logical_provider <> 'apify'
       OR v_profile_run.actor_id <> 'apify/instagram-profile-scraper'
       OR v_profile_run.run_id IS NULL
       OR v_profile_run.actual_usage_usd IS NULL
       OR v_profile_run.usage_reconciled_at IS NULL
       OR v_profile_run.reusable_profile_schema_version <> 1
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_TARGET_PROFILE_REUSE_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'runId', v_profile_run.run_id,
        'inputHash', v_profile_run.input_hash,
        'credentialSlot', v_profile_run.credential_slot,
        'maxChargeUsd', v_profile_run.max_charge_usd,
        'actorId', v_profile_run.actor_id
    );
END;
$$;

CREATE FUNCTION public.load_analysis_v2_reusable_target_profile_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_local JSONB;
BEGIN
    v_local := public.load_analysis_v2_reusable_target_profile_run_pre_first15(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
    IF v_local IS NOT NULL THEN RETURN v_local; END IF;
    RETURN public.load_analysis_v2_reusable_target_profile_run_first15(
        p_request_id, p_job_key, p_claim_token, p_job_input_hash
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_reusable_target_profile_run_first15(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_reusable_target_profile_run(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_reusable_target_profile_run(
    UUID, TEXT, UUID, TEXT
) TO service_role;

-- The existing resolver remains first in the call path.  This final fallback
-- can read only a source explicitly recorded above; quota failures deliberately
-- return NULL so the pinned fallback slot starts fresh evidence instead.
ALTER FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) RENAME TO resolve_analysis_v2_recovery_provider_run_pre_first15;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run_pre_first15(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.resolve_analysis_v2_recovery_provider_run_first15(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_rearm public.earlybird_first15_canary_provider_rearms%ROWTYPE;
    v_source public.analysis_v2_provider_runs%ROWTYPE;
    v_existing public.analysis_v2_recovery_provider_run_adoptions%ROWTYPE;
    v_allow_replacement BOOLEAN := FALSE;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL OR p_claim_token IS NULL
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider <> 'apify'
       OR p_actor_id IS NULL
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL OR p_max_charge_usd NOT BETWEEN 0 AND 100000
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_PROVIDER_ADOPTION_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request
    WHERE request.id = p_request_id
    FOR UPDATE;
    SELECT rearm.* INTO v_rearm
    FROM public.earlybird_first15_canary_provider_rearms AS rearm
    WHERE rearm.rearmed_preflight_id = v_request.preflight_id
    FOR KEY SHARE;
    IF v_rearm.order_id IS NULL THEN RETURN NULL; END IF;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_rearm.order_id
    FOR UPDATE;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_order.id
    FOR UPDATE;
    IF v_job.request_id IS NULL
       OR v_request.id IS NULL
       OR v_order.id IS NULL
       OR v_fulfillment.order_id IS NULL
       OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now
       OR v_request.pipeline_version <> 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_order.result_request_id IS DISTINCT FROM v_request.id
       OR v_order.status <> 'analysis_in_progress'
       OR v_fulfillment.request_id IS DISTINCT FROM v_request.id
       OR v_fulfillment.status <> 'analysis_in_progress'
       OR v_order.concierge_apify_credential_slot
            IS DISTINCT FROM v_rearm.fallback_credential_slot
       OR p_credential_slot IS DISTINCT FROM v_rearm.fallback_credential_slot
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_PROVIDER_ADOPTION_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_rearm.source_failure_code = 'SCRAPING_PROVIDER_QUOTA_ERROR' THEN
        RETURN NULL;
    END IF;
    SELECT provider_run.* INTO v_source
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = v_rearm.source_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF v_source.status <> 'succeeded'
       OR v_source.run_id IS NULL
       OR v_source.actual_usage_usd IS NULL
       OR v_source.usage_reconciled_at IS NULL
       OR v_source.input_hash IS DISTINCT FROM p_input_hash
       OR v_source.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_source.actor_id IS DISTINCT FROM p_actor_id
       OR v_source.credential_slot IS DISTINCT FROM v_rearm.source_credential_slot
       OR v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd
    THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_PROVIDER_ADOPTION_SOURCE_UNAVAILABLE',
            ERRCODE = 'P0001';
    END IF;
    SELECT adoption.* INTO v_existing
    FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
    WHERE adoption.request_id = p_request_id
      AND adoption.job_key = p_job_key
      AND adoption.operation_key = p_operation_key;
    IF FOUND AND (
        v_existing.destination_input_hash IS DISTINCT FROM p_input_hash
        OR v_existing.source_request_id IS DISTINCT FROM v_source.request_id
        OR v_existing.source_job_key IS DISTINCT FROM v_source.job_key
        OR v_existing.source_operation_key IS DISTINCT FROM v_source.operation_key
        OR v_existing.source_run_id IS DISTINCT FROM v_source.run_id
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'FIRST15_PROVIDER_ADOPTION_IDENTITY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF NOT FOUND THEN
        INSERT INTO public.analysis_v2_recovery_provider_run_adoptions(
            request_id, job_key, operation_key, destination_input_hash,
            source_request_id, source_job_key, source_operation_key, source_run_id
        ) VALUES (
            p_request_id, p_job_key, p_operation_key, p_input_hash,
            v_source.request_id, v_source.job_key, v_source.operation_key, v_source.run_id
        );
    END IF;
    v_allow_replacement := v_rearm.source_failure_code = 'SCRAPING_INCOMPLETE_ERROR'
        AND p_job_key = 'track:relationships:collect';
    RETURN pg_catalog.jsonb_build_object(
        'sourceRequestId', v_source.request_id,
        'sourceJobKey', v_source.job_key,
        'operationKey', p_operation_key,
        'inputHash', p_input_hash,
        'logicalProvider', v_source.logical_provider,
        'actorId', v_source.actor_id,
        'credentialSlot', v_source.credential_slot,
        'maxChargeUsd', v_source.max_charge_usd,
        'runId', v_source.run_id,
        'actualUsageUsd', v_source.actual_usage_usd,
        'usageReconciledAt', v_source.usage_reconciled_at
    ) || CASE WHEN v_allow_replacement THEN
        pg_catalog.jsonb_build_object('allowRelationshipIncompleteReplacement', TRUE)
    ELSE '{}'::JSONB END;
END;
$$;

CREATE FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_existing JSONB;
BEGIN
    v_existing := public.resolve_analysis_v2_recovery_provider_run_pre_first15(
        p_request_id, p_job_key, p_claim_token, p_operation_key, p_input_hash,
        p_logical_provider, p_actor_id, p_credential_slot, p_max_charge_usd
    );
    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;
    RETURN public.resolve_analysis_v2_recovery_provider_run_first15(
        p_request_id, p_job_key, p_claim_token, p_operation_key, p_input_hash,
        p_logical_provider, p_actor_id, p_credential_slot, p_max_charge_usd
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run_first15(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

COMMIT;
