-- Reuse already-paid, reconciled provider Datasets only through the immutable
-- failed-request -> paid order -> current recovery-request lineage. This is not a cache:
-- no lookup is possible without the current job claim and the operator-approved recovery row.
CREATE TABLE public.analysis_v2_recovery_provider_run_adoptions (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    job_key VARCHAR(160) NOT NULL,
    operation_key VARCHAR(87) NOT NULL,
    source_request_id UUID NOT NULL REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    source_job_key VARCHAR(160) NOT NULL,
    source_run_id VARCHAR(64) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, operation_key),
    UNIQUE (request_id, source_run_id),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key) ON DELETE RESTRICT,
    FOREIGN KEY (source_request_id, source_job_key, operation_key)
        REFERENCES public.analysis_v2_provider_runs(request_id, job_key, operation_key)
        ON DELETE RESTRICT
);

ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_recovery_provider_run_adoptions FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_recovery_provider_run_adoptions
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prevent_analysis_v2_provider_run_adoption_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER prevent_analysis_v2_provider_run_adoption_mutation
BEFORE UPDATE OR DELETE ON public.analysis_v2_recovery_provider_run_adoptions
FOR EACH ROW EXECUTE FUNCTION public.prevent_analysis_v2_provider_run_adoption_mutation();

CREATE FUNCTION public.analysis_v2_valid_recovery_adoption_preflights(
    p_order public.earlybird_orders,
    p_recovery public.analysis_preflights,
    p_current public.analysis_preflights
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_plan_id TEXT;
    v_plan_rank INTEGER;
    v_catalog JSONB;
    v_launch TEXT;
    v_admission_capacity TEXT;
    v_admission_required TEXT;
    v_admission_capacity_rank INTEGER;
    v_admission_required_rank INTEGER;
    v_current_capacity TEXT;
    v_current_required TEXT;
    v_current_capacity_rank INTEGER;
    v_current_required_rank INTEGER;
    v_admission_cards JSONB := '{}'::JSONB;
    v_current_cards JSONB := '{}'::JSONB;
    v_state TEXT;
    v_reason TEXT;
    v_selected_rank INTEGER;
BEGIN
    IF p_order.plan_id NOT IN ('basic', 'standard')
       OR p_recovery.admission_target_followers_count IS NULL
       OR p_recovery.admission_target_following_count IS NULL
       OR p_current.target_followers_count IS DISTINCT FROM p_order.target_followers_count
       OR p_current.target_following_count IS DISTINCT FROM p_order.target_following_count
       OR p_current.launch_status_snapshot IS DISTINCT FROM p_recovery.launch_status_snapshot
       OR p_current.plan_catalog_snapshot IS DISTINCT FROM p_recovery.plan_catalog_snapshot THEN
        RETURN FALSE;
    END IF;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog := p_recovery.plan_catalog_snapshot->v_plan_id;
        v_launch := p_recovery.launch_status_snapshot->>v_plan_id;
        IF v_catalog->>'launchStatus' IS DISTINCT FROM v_launch THEN RETURN FALSE; END IF;
        IF v_admission_capacity_rank IS NULL
           AND p_recovery.admission_target_followers_count
                <= (v_catalog->'relationshipCapacity'->>'followers')::INTEGER
           AND p_recovery.admission_target_following_count
                <= (v_catalog->'relationshipCapacity'->>'following')::INTEGER THEN
            v_admission_capacity_rank := v_plan_rank;
            v_admission_capacity := v_plan_id;
        END IF;
        IF v_current_capacity_rank IS NULL
           AND p_order.target_followers_count
                <= (v_catalog->'relationshipCapacity'->>'followers')::INTEGER
           AND p_order.target_following_count
                <= (v_catalog->'relationshipCapacity'->>'following')::INTEGER THEN
            v_current_capacity_rank := v_plan_rank;
            v_current_capacity := v_plan_id;
        END IF;
    END LOOP;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        IF v_admission_required_rank IS NULL
           AND v_plan_rank >= v_admission_capacity_rank
           AND p_recovery.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_admission_required_rank := v_plan_rank;
            v_admission_required := v_plan_id;
        END IF;
        IF v_current_required_rank IS NULL
           AND v_plan_rank >= v_current_capacity_rank
           AND p_recovery.launch_status_snapshot->>v_plan_id = 'production' THEN
            v_current_required_rank := v_plan_rank;
            v_current_required := v_plan_id;
        END IF;
    END LOOP;
    v_selected_rank := CASE p_order.plan_id WHEN 'basic' THEN 1 ELSE 2 END;
    IF v_admission_required_rank IS NULL OR v_current_required_rank IS NULL
       OR v_selected_rank < v_admission_required_rank
       OR v_selected_rank < v_current_required_rank THEN
        RETURN FALSE;
    END IF;
    FOREACH v_plan_id IN ARRAY ARRAY['basic', 'standard', 'plus'] LOOP
        v_plan_rank := CASE v_plan_id WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3 END;
        v_catalog := p_recovery.plan_catalog_snapshot->v_plan_id;
        v_launch := p_recovery.launch_status_snapshot->>v_plan_id;
        IF v_plan_rank < v_admission_capacity_rank THEN
            v_state := 'unavailable'; v_reason := 'below_required_plan';
        ELSIF v_launch <> 'production' THEN
            v_state := 'unavailable'; v_reason := 'launch_gate';
        ELSIF v_plan_id = v_admission_required THEN
            v_state := 'required'; v_reason := NULL;
        ELSE
            v_state := 'available_upgrade'; v_reason := NULL;
        END IF;
        v_admission_cards := v_admission_cards || pg_catalog.jsonb_build_object(
            v_plan_id, pg_catalog.jsonb_build_object(
                'launchStatus', v_launch,
                'relationshipCapacity', v_catalog->'relationshipCapacity',
                'detailedMutualLimit', v_catalog->'detailedMutualLimit',
                'selectionState', v_state, 'unavailableReason', v_reason
            )
        );
        IF v_plan_rank < v_current_capacity_rank THEN
            v_state := 'unavailable'; v_reason := 'below_required_plan';
        ELSIF v_launch <> 'production' THEN
            v_state := 'unavailable'; v_reason := 'launch_gate';
        ELSIF v_plan_id = v_current_required THEN
            v_state := 'required'; v_reason := NULL;
        ELSE
            v_state := 'available_upgrade'; v_reason := NULL;
        END IF;
        v_current_cards := v_current_cards || pg_catalog.jsonb_build_object(
            v_plan_id, pg_catalog.jsonb_build_object(
                'launchStatus', v_launch,
                'relationshipCapacity', v_catalog->'relationshipCapacity',
                'detailedMutualLimit', v_catalog->'detailedMutualLimit',
                'selectionState', v_state, 'unavailableReason', v_reason
            )
        );
    END LOOP;
    RETURN public.analysis_v2_valid_plan_cards_snapshot(v_admission_cards)
       AND public.analysis_v2_valid_plan_cards_snapshot(v_current_cards)
       AND p_recovery.admission_capacity_required_plan_id = v_admission_capacity
       AND p_recovery.admission_required_plan_id = v_admission_required
       AND p_recovery.admission_plan_cards_snapshot = v_admission_cards
       AND p_current.capacity_required_plan_id = v_current_capacity
       AND p_current.required_plan_id = v_current_required
       AND p_current.plan_cards_snapshot = v_current_cards
       AND p_current.plan_cards_snapshot->p_order.plan_id->>'launchStatus' = 'production'
       AND p_current.plan_cards_snapshot->p_order.plan_id->>'selectionState'
            IN ('required', 'available_upgrade')
       AND p_recovery.admission_plan_cards_snapshot->p_order.plan_id->>'launchStatus'
            = 'production'
       AND p_recovery.admission_plan_cards_snapshot->p_order.plan_id->>'selectionState'
            IN ('required', 'available_upgrade');
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_recovery_adoption_preflights(
    public.earlybird_orders, public.analysis_preflights, public.analysis_preflights
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.earlybird_provider_run_adoption_ready(
    p_order_id UUID,
    p_failed_request_id UUID,
    p_recovery_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.earlybird_schema_failure_recoveries AS recovery
        JOIN public.earlybird_orders AS earlybird_order
          ON earlybird_order.id = recovery.order_id
        JOIN public.analysis_preflights AS current_preflight
          ON current_preflight.id = earlybird_order.preflight_id
        JOIN public.analysis_preflights AS recovery_preflight
          ON recovery_preflight.id = recovery.recovery_preflight_id
        WHERE recovery.order_id = p_order_id
          AND recovery.failed_request_id = p_failed_request_id
          AND current_preflight.id = p_recovery_preflight_id
          AND current_preflight.user_id = earlybird_order.user_id
          AND current_preflight.access_mode = 'production'
          AND current_preflight.idempotency_key ~ (
              '^earlybird[.]fulfillment[.]'
              || pg_catalog.replace(earlybird_order.id::TEXT, '-', '')
              || '([.]r[1-9])?$'
          )
          AND current_preflight.target_instagram_id = earlybird_order.target_instagram_id
          AND current_preflight.launch_status_snapshot =
              recovery_preflight.launch_status_snapshot
          AND current_preflight.plan_catalog_snapshot =
              recovery_preflight.plan_catalog_snapshot
          AND current_preflight.pricing_version = recovery_preflight.pricing_version
          AND current_preflight.pricing_snapshot = recovery_preflight.pricing_snapshot
          AND current_preflight.policy_versions_snapshot =
              recovery_preflight.policy_versions_snapshot
          AND recovery_preflight.status = 'expired'
          AND recovery_preflight.pii_scrubbed_at IS NOT NULL
          AND recovery_preflight.pii_scrubbed_at >= recovery_preflight.expires_at
          AND recovery_preflight.target_instagram_id = (
              'retained.' || pg_catalog.substr(
                  pg_catalog.replace(recovery_preflight.id::TEXT, '-', ''), 1, 20
              )
          )
          AND recovery_preflight.target_followers_count IS NULL
          AND recovery_preflight.target_following_count IS NULL
          AND recovery_preflight.admission_status = 'ready'
          AND recovery_preflight.admission_selected_plan_id = earlybird_order.plan_id
          AND recovery_preflight.admission_entitlement_jti_hash =
              pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                  'earlybird-fulfillment-admission-v1'
                  || pg_catalog.chr(10)
                  || pg_catalog.lower(earlybird_order.id::TEXT),
                  'UTF8'
              ), 'sha256'), 'hex')
          AND recovery_preflight.admission_target_followers_count IS NOT NULL
          AND recovery_preflight.admission_target_following_count IS NOT NULL
          AND recovery_preflight.admission_plan_cards_snapshot IS NOT NULL
          AND public.analysis_v2_valid_recovery_adoption_preflights(
              earlybird_order, recovery_preflight, current_preflight
          )
          AND NOT EXISTS (
              SELECT 1
              FROM public.analysis_v2_provider_runs AS source_run
              WHERE source_run.request_id = recovery.failed_request_id
                AND (
                    source_run.status <> 'succeeded'
                    OR source_run.run_id IS NULL
                    OR source_run.actual_usage_usd IS NULL
                    OR source_run.usage_reconciled_at IS NULL
                )
          )
    );
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
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_recovery public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_current_preflight public.analysis_preflights%ROWTYPE;
    v_recovery_preflight public.analysis_preflights%ROWTYPE;
    v_failed_request public.analysis_requests%ROWTYPE;
    v_source public.analysis_v2_provider_runs%ROWTYPE;
    v_existing public.analysis_v2_recovery_provider_run_adoptions%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL OR p_claim_token IS NULL
       OR NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id IS NULL OR p_credential_slot IS NULL
       OR p_max_charge_usd IS NULL OR p_max_charge_usd NOT BETWEEN 0 AND 100000 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT request.* INTO v_request
    FROM public.analysis_requests AS request WHERE request.id = p_request_id;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.result_request_id = p_request_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT recovery.* INTO v_recovery
    FROM public.earlybird_schema_failure_recoveries AS recovery
    WHERE recovery.order_id = v_order.id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_recovery.order_id;
    SELECT preflight.* INTO v_current_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_request.preflight_id;
    SELECT preflight.* INTO v_recovery_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_recovery.recovery_preflight_id;
    SELECT failed_request.* INTO v_failed_request
    FROM public.analysis_requests AS failed_request
    WHERE failed_request.id = v_recovery.failed_request_id;
    IF v_request.pipeline_version <> 'v2'
       OR v_request.user_id IS DISTINCT FROM v_order.user_id
       OR v_request.target_instagram_id IS DISTINCT FROM v_order.target_instagram_id
       OR v_order.preflight_id IS DISTINCT FROM v_request.preflight_id
       OR v_order.result_request_id IS DISTINCT FROM p_request_id
       OR v_fulfillment.request_id IS DISTINCT FROM p_request_id
       OR v_order.status NOT IN ('analysis_in_progress', 'result_ready')
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id
            IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_failed_request.user_id IS DISTINCT FROM v_order.user_id
       OR (
            pg_catalog.lower(pg_catalog.btrim(v_failed_request.target_instagram_id))
                IS DISTINCT FROM
                pg_catalog.lower(pg_catalog.btrim(v_order.target_instagram_id))
            AND v_failed_request.target_instagram_id IS DISTINCT FROM
                'retained.' || pg_catalog.substr(
                    pg_catalog.replace(v_failed_request.id::TEXT, '-', ''), 1, 20
                )
       )
       OR v_failed_request.status <> 'failed'
       OR v_failed_request.pipeline_version <> 'v2'
       OR v_current_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_current_preflight.access_mode <> 'production'
       OR v_current_preflight.consumed_request_id IS DISTINCT FROM p_request_id
       OR v_current_preflight.idempotency_key !~
            ('^earlybird[.]fulfillment[.]'
             || pg_catalog.replace(v_order.id::TEXT, '-', '')
             || '([.]r[1-9])?$')
       OR v_current_preflight.target_instagram_id
            IS DISTINCT FROM v_order.target_instagram_id
       OR v_current_preflight.target_followers_count
            IS DISTINCT FROM v_order.target_followers_count
       OR v_current_preflight.target_following_count
            IS DISTINCT FROM v_order.target_following_count
       OR v_current_preflight.exclusion_decision
            IS DISTINCT FROM v_order.exclusion_decision
       OR v_current_preflight.excluded_instagram_id
            IS DISTINCT FROM v_order.excluded_instagram_id
       OR v_current_preflight.launch_status_snapshot
            IS DISTINCT FROM v_recovery_preflight.launch_status_snapshot
       OR v_current_preflight.plan_catalog_snapshot
            IS DISTINCT FROM v_recovery_preflight.plan_catalog_snapshot
       OR v_current_preflight.pricing_version
            IS DISTINCT FROM v_recovery_preflight.pricing_version
       OR v_current_preflight.pricing_snapshot
            IS DISTINCT FROM v_recovery_preflight.pricing_snapshot
       OR v_current_preflight.policy_versions_snapshot
            IS DISTINCT FROM v_recovery_preflight.policy_versions_snapshot
       OR v_recovery_preflight.user_id IS DISTINCT FROM v_order.user_id
       OR v_recovery_preflight.access_mode <> 'production'
       OR v_recovery_preflight.status <> 'expired'
       OR v_recovery_preflight.pii_scrubbed_at IS NULL
       OR v_recovery_preflight.pii_scrubbed_at < v_recovery_preflight.expires_at
       OR v_recovery_preflight.target_instagram_id IS DISTINCT FROM (
            'retained.' || pg_catalog.substr(
                pg_catalog.replace(v_recovery_preflight.id::TEXT, '-', ''), 1, 20
            )
       )
       OR v_recovery_preflight.target_full_name IS NOT NULL
       OR v_recovery_preflight.target_bio IS NOT NULL
       OR v_recovery_preflight.target_profile_image_url IS NOT NULL
       OR v_recovery_preflight.target_followers_count IS NOT NULL
       OR v_recovery_preflight.target_following_count IS NOT NULL
       OR v_recovery_preflight.target_is_private IS NOT NULL
       OR v_recovery_preflight.capacity_required_plan_id IS NOT NULL
       OR v_recovery_preflight.required_plan_id IS NOT NULL
       OR v_recovery_preflight.plan_cards_snapshot IS NOT NULL
       OR v_recovery_preflight.exclusion_decision <> 'skip'
       OR v_recovery_preflight.excluded_instagram_id IS NOT NULL
       OR v_recovery_preflight.admission_status <> 'ready'
       OR v_recovery_preflight.admission_selected_plan_id
            IS DISTINCT FROM v_order.plan_id
       OR v_recovery_preflight.admission_entitlement_jti_hash IS DISTINCT FROM
            pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                'earlybird-fulfillment-admission-v1'
                || pg_catalog.chr(10) || pg_catalog.lower(v_order.id::TEXT),
                'UTF8'
            ), 'sha256'), 'hex')
       OR v_recovery_preflight.admission_target_followers_count IS NULL
       OR v_recovery_preflight.admission_target_following_count IS NULL
       OR v_recovery_preflight.admission_plan_cards_snapshot IS NULL
       OR NOT public.analysis_v2_valid_recovery_adoption_preflights(
            v_order, v_recovery_preflight, v_current_preflight
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_LINEAGE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT source_run.* INTO v_source
    FROM public.analysis_v2_provider_runs AS source_run
    WHERE source_run.request_id = v_recovery.failed_request_id
      AND source_run.job_key = p_job_key
      AND source_run.operation_key = p_operation_key;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF v_source.status <> 'succeeded'
       OR v_source.run_id IS NULL
       OR v_source.actual_usage_usd IS NULL
       OR v_source.usage_reconciled_at IS NULL
       OR v_source.input_hash IS DISTINCT FROM p_input_hash
       OR v_source.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_source.actor_id IS DISTINCT FROM p_actor_id
       OR v_source.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_source.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
        RETURN NULL;
    END IF;

    SELECT adoption.* INTO v_existing
    FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
    WHERE adoption.request_id = p_request_id
      AND adoption.job_key = p_job_key
      AND adoption.operation_key = p_operation_key;
    IF FOUND AND (
        v_existing.source_request_id IS DISTINCT FROM v_source.request_id
        OR v_existing.source_job_key IS DISTINCT FROM v_source.job_key
        OR v_existing.source_run_id IS DISTINCT FROM v_source.run_id
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_IDENTITY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
    IF NOT FOUND THEN
        INSERT INTO public.analysis_v2_recovery_provider_run_adoptions(
            request_id, job_key, operation_key,
            source_request_id, source_job_key, source_run_id
        ) VALUES (
            p_request_id, p_job_key, p_operation_key,
            v_source.request_id, v_source.job_key, v_source.run_id
        );
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'sourceRequestId', v_source.request_id,
        'sourceJobKey', v_source.job_key,
        'operationKey', v_source.operation_key,
        'inputHash', v_source.input_hash,
        'logicalProvider', v_source.logical_provider,
        'actorId', v_source.actor_id,
        'credentialSlot', v_source.credential_slot,
        'maxChargeUsd', v_source.max_charge_usd,
        'runId', v_source.run_id,
        'actualUsageUsd', v_source.actual_usage_usd,
        'usageReconciledAt', v_source.usage_reconciled_at
    );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

-- Evidence writers call this instead of assuming the source ledger row belongs to the
-- destination request. It remains claim-fenced and accepts only the immutable adoption row.
CREATE FUNCTION public.analysis_v2_valid_provider_evidence_source(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_provider TEXT,
    p_run_id TEXT,
    p_credential_slot TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_operation_key
          AND provider_run.job_claim_token = p_claim_token
          AND provider_run.input_hash = p_input_hash
          AND provider_run.logical_provider = p_provider
          AND provider_run.run_id = p_run_id
          AND provider_run.status = 'succeeded'
          AND (p_credential_slot IS NULL OR provider_run.credential_slot = p_credential_slot)
        UNION ALL
        SELECT 1
        FROM public.analysis_v2_recovery_provider_run_adoptions AS adoption
        JOIN public.analysis_v2_provider_runs AS provider_run
          ON provider_run.request_id = adoption.source_request_id
         AND provider_run.job_key = adoption.source_job_key
         AND provider_run.operation_key = adoption.operation_key
         AND provider_run.run_id = adoption.source_run_id
        JOIN public.analysis_pipeline_jobs AS job
          ON job.request_id = adoption.request_id AND job.job_key = adoption.job_key
        WHERE adoption.request_id = p_request_id
          AND adoption.job_key = p_job_key
          AND adoption.operation_key = p_operation_key
          AND job.status = 'processing'
          AND job.lease_token = p_claim_token
          AND job.lease_expires_at > pg_catalog.clock_timestamp()
          AND provider_run.input_hash = p_input_hash
          AND provider_run.logical_provider = p_provider
          AND provider_run.run_id = p_run_id
          AND provider_run.status = 'succeeded'
          AND provider_run.actual_usage_usd IS NOT NULL
          AND provider_run.usage_reconciled_at IS NOT NULL
          AND (p_credential_slot IS NULL OR provider_run.credential_slot = p_credential_slot)
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_provider_evidence_source(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the complete, already-hardened evidence writers and replace only their
-- same-request provider-ledger predicate. Abort the migration if the expected body
-- is not exact; silently weakening a later function revision is forbidden.
DO $migration$
DECLARE
    v_definition TEXT;
    v_rewritten TEXT;
BEGIN
    v_definition := pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_relationship_side(uuid,text,uuid,text,text,integer,text,text,text,text,text,jsonb)'::pg_catalog.regprocedure
    );
    v_rewritten := pg_catalog.replace(v_definition, $old$
    SELECT provider_run.*
    INTO v_provider_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_provider_operation_key
    FOR UPDATE;
    IF NOT FOUND
       OR v_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
       OR v_provider_run.logical_provider IS DISTINCT FROM p_provider
       OR v_provider_run.input_hash IS DISTINCT FROM p_input_hash
       OR v_provider_run.run_id IS DISTINCT FROM p_provider_run_id
       OR v_provider_run.status <> 'succeeded' THEN
$old$, $new$
    IF NOT public.analysis_v2_valid_provider_evidence_source(
        p_request_id, p_job_key, p_claim_token, p_provider_operation_key,
        p_input_hash, p_provider, p_provider_run_id, NULL
    ) THEN
$new$);
    IF v_rewritten = v_definition THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_RELATIONSHIP_PATCH_MISMATCH';
    END IF;
    EXECUTE v_rewritten;

    v_definition := pg_catalog.pg_get_functiondef(
        'public.checkpoint_analysis_v2_target_evidence(uuid,text,uuid,text,text,text,text,text,jsonb,jsonb,jsonb)'::pg_catalog.regprocedure
    );
    v_rewritten := pg_catalog.replace(v_definition, $old$
        SELECT provider_run.*
        INTO v_liker_provider_run
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_liker_source->>'provider_operation_key'
        FOR UPDATE;
        IF NOT FOUND
           OR v_liker_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
           OR v_liker_provider_run.input_hash IS DISTINCT FROM p_liker_source->>'input_hash'
           OR v_liker_provider_run.logical_provider IS DISTINCT FROM p_liker_source->>'provider'
           OR v_liker_provider_run.run_id IS DISTINCT FROM p_liker_source->>'provider_run_id'
           OR v_liker_provider_run.credential_slot IS DISTINCT FROM
                p_liker_source->>'provider_credential_slot'
           OR v_liker_provider_run.status <> 'succeeded' THEN
$old$, $new$
        IF NOT public.analysis_v2_valid_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_liker_source->>'provider_operation_key',
            p_liker_source->>'input_hash', p_liker_source->>'provider',
            p_liker_source->>'provider_run_id',
            p_liker_source->>'provider_credential_slot'
        ) THEN
$new$);
    v_rewritten := pg_catalog.replace(v_rewritten, $old$
        SELECT provider_run.*
        INTO v_comment_provider_run
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_comment_source->>'provider_operation_key'
        FOR UPDATE;
        IF NOT FOUND
           OR v_comment_provider_run.job_claim_token IS DISTINCT FROM p_claim_token
           OR v_comment_provider_run.input_hash IS DISTINCT FROM p_comment_source->>'input_hash'
           OR v_comment_provider_run.logical_provider IS DISTINCT FROM p_comment_source->>'provider'
           OR v_comment_provider_run.run_id IS DISTINCT FROM p_comment_source->>'provider_run_id'
           OR v_comment_provider_run.credential_slot IS DISTINCT FROM
                p_comment_source->>'provider_credential_slot'
           OR v_comment_provider_run.status <> 'succeeded' THEN
$old$, $new$
        IF NOT public.analysis_v2_valid_provider_evidence_source(
            p_request_id, p_job_key, p_claim_token,
            p_comment_source->>'provider_operation_key',
            p_comment_source->>'input_hash', p_comment_source->>'provider',
            p_comment_source->>'provider_run_id',
            p_comment_source->>'provider_credential_slot'
        ) THEN
$new$);
    IF v_rewritten = v_definition
       OR pg_catalog.strpos(v_rewritten, 'INTO v_liker_provider_run') > 0
       OR pg_catalog.strpos(v_rewritten, 'INTO v_comment_provider_run') > 0 THEN
        RAISE EXCEPTION 'ANALYSIS_V2_PROVIDER_RUN_ADOPTION_TARGET_PATCH_MISMATCH';
    END IF;
    EXECUTE v_rewritten;
END;
$migration$;
