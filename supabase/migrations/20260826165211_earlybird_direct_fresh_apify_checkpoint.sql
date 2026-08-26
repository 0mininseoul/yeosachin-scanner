-- Paid Earlybird direct-fresh profile admission.
--
-- This is deliberately additive.  The strict test-entitlement fresh RPC in
-- 20260811090000 is left byte-for-byte untouched; paid Earlybird requests use
-- the separate admission below and carry their order-scoped secondary slot.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Fresh outcomes are already part of the outcome attempt domain.  Telemetry
-- was the remaining source-domain boundary for a direct-fresh insert.
ALTER TABLE public.analysis_v2_profile_fetch_telemetry
    DROP CONSTRAINT IF EXISTS analysis_v2_profile_fetch_telemetry_source_check;
ALTER TABLE public.analysis_v2_profile_fetch_telemetry
    ADD CONSTRAINT analysis_v2_profile_fetch_telemetry_source_check CHECK (
        source IN ('cache', 'selfhosted', 'fallback', 'repair', 'fresh_apify')
    );

-- Keep the existing trigger binding and complete aggregation body.  The
-- attempt discriminator is authoritative for all three non-cache sources.
CREATE OR REPLACE FUNCTION public.capture_analysis_v2_profile_fetch_telemetry()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_source TEXT := CASE
        WHEN NEW.attempt = 'fresh_apify' THEN 'fresh_apify'
        WHEN NEW.attempt = 'fallback' THEN 'fallback'
        WHEN NEW.attempt = 'repair' THEN 'repair'
        ELSE NEW.source
    END;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    INSERT INTO public.analysis_v2_profile_fetch_telemetry (
        request_id,
        job_key,
        source,
        status,
        failure_category,
        http_status,
        outcome_count,
        request_count_total,
        latency_ms_total,
        latency_ms_max,
        first_captured_at,
        last_captured_at,
        created_at,
        updated_at
    ) VALUES (
        NEW.request_id,
        NEW.job_key,
        v_source,
        NEW.status,
        NEW.failure_category,
        NEW.http_status,
        1,
        NEW.request_count,
        NEW.latency_ms,
        NEW.latency_ms,
        NEW.captured_at,
        NEW.captured_at,
        v_now,
        v_now
    )
    ON CONFLICT (
        request_id, job_key, source, status, failure_category_key, http_status_key
    ) DO UPDATE
    SET outcome_count = public.analysis_v2_profile_fetch_telemetry.outcome_count + 1,
        request_count_total =
            public.analysis_v2_profile_fetch_telemetry.request_count_total
            + EXCLUDED.request_count_total,
        latency_ms_total = public.analysis_v2_profile_fetch_telemetry.latency_ms_total
            + EXCLUDED.latency_ms_total,
        latency_ms_max = GREATEST(
            public.analysis_v2_profile_fetch_telemetry.latency_ms_max,
            EXCLUDED.latency_ms_max
        ),
        first_captured_at = LEAST(
            public.analysis_v2_profile_fetch_telemetry.first_captured_at,
            EXCLUDED.first_captured_at
        ),
        last_captured_at = GREATEST(
            public.analysis_v2_profile_fetch_telemetry.last_captured_at,
            EXCLUDED.last_captured_at
        ),
        updated_at = v_now;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.capture_analysis_v2_profile_fetch_telemetry()
    FROM PUBLIC, anon, authenticated, service_role;

-- Every reader, including finalization, must choose repair first, then a
-- direct fresh-Apify outcome, then frozen fallback, then legacy primary.
CREATE OR REPLACE FUNCTION public.analysis_v2_profile_terminal_attempt(
    p_request_id UUID,
    p_job_key TEXT,
    p_username TEXT,
    p_frozen TEXT[]
)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT CASE
        WHEN EXISTS (
            SELECT 1
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = p_request_id
              AND outcome.job_key = p_job_key
              AND outcome.username = p_username
              AND outcome.attempt = 'repair'
        ) THEN 'repair'
        WHEN EXISTS (
            SELECT 1
            FROM public.analysis_v2_profile_fetch_outcomes AS outcome
            WHERE outcome.request_id = p_request_id
              AND outcome.job_key = p_job_key
              AND outcome.username = p_username
              AND outcome.attempt = 'fresh_apify'
        ) THEN 'fresh_apify'
        WHEN p_username = ANY(p_frozen) THEN 'fallback'
        ELSE 'primary'
    END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_profile_terminal_attempt(
    UUID, TEXT, TEXT, TEXT[]
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_job_input_hash TEXT,
    p_requested_usernames TEXT[],
    p_outcomes JSONB,
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
    v_order public.earlybird_orders%ROWTYPE;
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_provider public.analysis_v2_provider_runs%ROWTYPE;
    v_batch public.analysis_v2_profile_fetch_batches%ROWTYPE;
    v_selected_card JSONB;
    v_expected_scope JSONB;
    v_unresolved TEXT[];
    v_payload_hash TEXT;
    v_now TIMESTAMP WITH TIME ZONE;
    v_existing_outcome_count INTEGER;
    v_existing_fresh_count INTEGER;
BEGIN
    -- The paid route is intentionally narrower than the generic provider-key
    -- validator: only target hydration and the matching profile batch can use
    -- this RPC.  Relationships and interaction jobs have their own admissions.
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$'
       OR p_provider_input_hash IS NULL
       OR p_provider_input_hash !~ '^[a-f0-9]{64}$'
       OR p_operation_key IS NULL
       OR p_operation_key !~ '^(target-profile|profile-fallback):[a-f0-9]{64}$'
       OR NOT public.analysis_v2_valid_profile_username_list(
            p_requested_usernames,
            FALSE
       )
       OR NOT public.analysis_v2_valid_profile_outcomes(
            p_outcomes,
            p_requested_usernames,
            'fallback'
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_INVALID',
            ERRCODE = 'P0001';
    END IF;

    -- Resolve without taking a child lock.  All subsequent locks follow the
    -- reconciliation order fulfillment -> order -> preflight -> request ->
    -- job -> provider -> batch.
    SELECT fulfillment.order_id
    INTO v_order_id
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.request_id = p_request_id;
    IF v_order_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.*
    INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = v_order_id
    FOR UPDATE;
    SELECT earlybird_order.*
    INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = v_order_id
    FOR UPDATE;
    SELECT preflight.*
    INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;
    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;
    SELECT job.*
    INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id
      AND job.job_key = p_job_key
    FOR UPDATE;
    SELECT provider_run.*
    INTO v_provider
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    SELECT batch.*
    INTO v_batch
    FROM public.analysis_v2_profile_fetch_batches AS batch
    WHERE batch.request_id = p_request_id
      AND batch.job_key = p_job_key
    FOR UPDATE;

    IF v_order.id IS NULL
       OR v_fulfillment.order_id IS NULL
       OR v_preflight.id IS NULL
       OR v_request.id IS NULL
       OR v_job.request_id IS NULL
       OR v_provider.request_id IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF v_order.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_fulfillment.status IS DISTINCT FROM 'analysis_in_progress'
       OR v_fulfillment.order_id IS DISTINCT FROM v_order.id
       OR v_fulfillment.request_id IS DISTINCT FROM p_request_id
       OR v_fulfillment.manual_review_at IS NOT NULL
       OR v_order.result_request_id IS DISTINCT FROM p_request_id
       OR v_order.payment_id IS NULL
       OR v_order.paid_at IS NULL
       OR v_order.seller_reference_confirmed_at IS NULL
       OR v_order.actual_amount_krw IS NULL
       OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_order.plan_id NOT IN ('basic', 'standard')
       OR v_order.user_id IS DISTINCT FROM v_preflight.user_id
       OR v_order.user_id IS DISTINCT FROM v_request.user_id
       OR v_order.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_preflight.consumed_request_id IS DISTINCT FROM p_request_id
       OR v_preflight.status IS DISTINCT FROM 'consumed'
       OR v_order.target_instagram_id IS DISTINCT FROM v_preflight.target_instagram_id
       OR v_order.target_instagram_id IS DISTINCT FROM v_request.target_instagram_id
       OR v_preflight.admission_target_followers_count IS DISTINCT FROM v_preflight.target_followers_count
       OR v_preflight.admission_target_following_count IS DISTINCT FROM v_preflight.target_following_count
       OR v_order.excluded_instagram_id IS DISTINCT FROM v_preflight.excluded_instagram_id
       OR v_order.excluded_instagram_id IS DISTINCT FROM v_request.excluded_instagram_id
       OR v_order.exclusion_decision IS DISTINCT FROM v_preflight.exclusion_decision
       OR v_order.exclusion_decision IS DISTINCT FROM v_request.exclusion_decision_snapshot
       OR v_preflight.admission_required_plan_id IS DISTINCT FROM v_preflight.required_plan_id
       OR v_preflight.admission_capacity_required_plan_id IS DISTINCT FROM v_preflight.capacity_required_plan_id
       OR v_order.plan_id IS DISTINCT FROM v_preflight.admission_selected_plan_id
       OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_preflight.capacity_required_plan_id IS DISTINCT FROM v_request.capacity_required_plan_id_snapshot
       OR v_preflight.required_plan_id IS DISTINCT FROM v_request.required_plan_id_snapshot
       OR v_order.plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot
       OR v_preflight.required_plan_id IS NULL
       OR v_preflight.required_plan_id NOT IN ('basic', 'standard', 'plus')
       OR v_preflight.capacity_required_plan_id IS NULL
       OR v_preflight.capacity_required_plan_id NOT IN ('basic', 'standard', 'plus')
       OR v_preflight.admission_required_plan_id IS NULL
       OR v_preflight.admission_required_plan_id NOT IN ('basic', 'standard', 'plus')
       OR v_preflight.admission_capacity_required_plan_id IS NULL
       OR v_preflight.admission_capacity_required_plan_id NOT IN ('basic', 'standard', 'plus')
       OR v_request.required_plan_id_snapshot IS NULL
       OR v_request.required_plan_id_snapshot NOT IN ('basic', 'standard', 'plus')
       OR v_request.capacity_required_plan_id_snapshot IS NULL
       OR v_request.capacity_required_plan_id_snapshot NOT IN ('basic', 'standard', 'plus')
       OR v_request.selected_plan_id_snapshot IS NULL
       OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard')
       OR (
            CASE v_preflight.required_plan_id
                WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3
            END < CASE v_preflight.capacity_required_plan_id
                WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3
            END
       )
       OR (
            CASE v_order.plan_id
                WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3
            END < CASE v_preflight.required_plan_id
                WHEN 'basic' THEN 1 WHEN 'standard' THEN 2 ELSE 3
            END
       )
       OR v_request.preflight_id IS DISTINCT FROM v_preflight.id
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status IS DISTINCT FROM 'processing'
       OR v_preflight.access_mode IS DISTINCT FROM 'production'
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'production'
       OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'standard'
       OR v_request.analysis_entry_channel IS DISTINCT FROM 'standard'
       OR v_request.test_entitlement_jti_hash IS NOT NULL
       OR v_order.concierge_apify_credential_slot IS DISTINCT FROM 'secondary'
       OR v_preflight.order_scoped_apify_credential_slot IS DISTINCT FROM 'secondary'
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_execution_policies AS policy
            WHERE policy.request_id = p_request_id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_test_entitlement_consumptions AS consumption
            WHERE consumption.request_id = p_request_id
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_revenue_run_ledgers AS ledger
            WHERE ledger.request_id = p_request_id
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_selected_card := v_preflight.plan_cards_snapshot->v_order.plan_id;
    v_expected_scope := pg_catalog.jsonb_build_object(
        'relationshipCapacity', v_selected_card->'relationshipCapacity',
        'detailedMutualLimit', v_selected_card->'detailedMutualLimit'
    );
    IF v_preflight.plan_cards_snapshot IS NULL
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(
            v_preflight.plan_cards_snapshot
       )
       OR v_selected_card IS NULL
       OR v_selected_card->>'launchStatus' IS DISTINCT FROM 'production'
       OR v_selected_card->>'selectionState' NOT IN ('required', 'available_upgrade')
       OR COALESCE(v_selected_card->'relationshipCapacity'->>'followers', '')
            !~ '^[0-9]+$'
       OR COALESCE(v_selected_card->'relationshipCapacity'->>'following', '')
            !~ '^[0-9]+$'
       OR v_order.target_followers_count IS NULL
       OR v_order.target_followers_count < 0
       OR v_order.target_following_count IS NULL
       OR v_order.target_following_count < 0
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_followers_count < 0
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.target_following_count < 0
       OR v_order.target_followers_count
            > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_order.target_following_count
            > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER
       OR v_preflight.target_followers_count
            > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_preflight.target_following_count
            > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER
       OR NOT public.analysis_v2_valid_scope_snapshot(v_expected_scope)
       OR v_request.analysis_scope_snapshot IS DISTINCT FROM v_expected_scope THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF p_job_key = 'track:target-evidence:collect' THEN
        IF v_job.track IS DISTINCT FROM 'target_evidence'
           OR v_job.kind IS DISTINCT FROM 'collection'
           OR v_job.batch IS NOT NULL
           OR p_operation_key !~ '^target-profile:[a-f0-9]{64}$'
           OR pg_catalog.cardinality(p_requested_usernames) <> 1
           OR p_requested_usernames[1] IS DISTINCT FROM v_request.target_instagram_id THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    ELSIF p_job_key ~ '^track:profiles:batch:[0-9]+$' THEN
        IF v_job.track IS DISTINCT FROM 'profiles'
           OR v_job.kind IS DISTINCT FROM 'profile_fetch'
           OR v_job.batch IS NULL
           OR v_job.batch < 0
           OR v_job.batch > 999
           OR v_job.batch <> pg_catalog.regexp_replace(p_job_key, '^.*:', '')::INTEGER
           OR p_operation_key !~ '^profile-fallback:[a-f0-9]{64}$' THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    ELSE
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    IF v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.status IS DISTINCT FROM 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp()
       OR v_provider.input_hash IS DISTINCT FROM p_provider_input_hash
       OR v_provider.job_claim_token IS DISTINCT FROM p_claim_token
       OR v_provider.logical_provider IS DISTINCT FROM 'apify'
       OR v_provider.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper'
       OR v_provider.credential_slot IS DISTINCT FROM 'secondary'
       OR v_provider.status IS DISTINCT FROM 'succeeded'
       OR v_provider.run_id IS NULL
       OR v_provider.run_started_at IS NULL
       OR v_provider.terminalized_at IS NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_CHECKPOINT_FENCE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;
    -- v_provider.usage_reconciled_at is intentionally not part of admission:
    -- the current request-owned terminal run is sufficient evidence here.

    v_payload_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.jsonb_build_object(
                'requested_usernames', pg_catalog.to_jsonb(p_requested_usernames),
                'outcomes', p_outcomes
            )::TEXT,
            'sha256'
        ),
        'hex'
    );
    SELECT COALESCE(
        pg_catalog.array_agg(outcome.value->>'username' ORDER BY outcome.ordinal),
        '{}'::TEXT[]
    )
    INTO v_unresolved
    FROM pg_catalog.jsonb_array_elements(p_outcomes)
        WITH ORDINALITY AS outcome(value, ordinal)
    WHERE outcome.value->>'status' <> 'success';

    IF v_batch.request_id IS NOT NULL THEN
        -- Replay is accepted only for the same direct-fresh primary.  Any
        -- fallback/repair timestamp or row means provenance was mixed and is
        -- rejected before a caller can treat it as direct Apify evidence.
        IF v_batch.request_id IS NULL
           OR v_batch.requested_usernames IS DISTINCT FROM p_requested_usernames
           OR v_batch.frozen_unresolved_usernames IS DISTINCT FROM v_unresolved
           OR v_batch.primary_payload_hash IS DISTINCT FROM v_payload_hash
           OR v_batch.fallback_completed_at IS NOT NULL
           OR v_batch.repair_completed_at IS NOT NULL
           OR v_batch.fallback_payload_hash IS NOT NULL
           OR v_batch.repair_payload_hash IS NOT NULL
           OR v_batch.repair_usernames IS NOT NULL
           OR EXISTS (
                SELECT 1
                FROM public.analysis_v2_profile_fetch_outcomes AS outcome
                WHERE outcome.request_id = p_request_id
                  AND outcome.job_key = p_job_key
                  AND outcome.attempt IN ('fallback', 'repair')
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_FRESH_APIFY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        SELECT pg_catalog.count(*)::INTEGER,
               pg_catalog.count(*) FILTER (
                   WHERE outcome.attempt = 'fresh_apify'
                     AND outcome.source = 'apify'
               )::INTEGER
        INTO v_existing_outcome_count, v_existing_fresh_count
        FROM public.analysis_v2_profile_fetch_outcomes AS outcome
        WHERE outcome.request_id = p_request_id
          AND outcome.job_key = p_job_key;
        IF v_existing_outcome_count IS DISTINCT FROM pg_catalog.cardinality(p_requested_usernames)
           OR v_existing_fresh_count IS DISTINCT FROM pg_catalog.cardinality(p_requested_usernames)
           OR EXISTS (
                SELECT 1
                FROM public.analysis_v2_profile_fetch_outcomes AS outcome
                WHERE outcome.request_id = p_request_id
                  AND outcome.job_key = p_job_key
                  AND outcome.attempt <> 'fresh_apify'
           ) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROFILE_FRESH_APIFY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
    END IF;

    -- A batch row and its outcome rows are one physical checkpoint.  A
    -- detached fallback/repair/fresh row is not an admissible new direct run;
    -- reject it rather than attempting to reconstruct provenance.
    IF EXISTS (
        SELECT 1
        FROM public.analysis_v2_profile_fetch_outcomes AS outcome
        WHERE outcome.request_id = p_request_id
          AND outcome.job_key = p_job_key
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROFILE_FRESH_APIFY_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    v_now := pg_catalog.clock_timestamp();
    INSERT INTO public.analysis_v2_profile_fetch_batches (
        request_id,
        job_key,
        requested_usernames,
        frozen_unresolved_usernames,
        primary_payload_hash,
        primary_completed_at,
        created_at,
        updated_at
    ) VALUES (
        p_request_id,
        p_job_key,
        p_requested_usernames,
        v_unresolved,
        v_payload_hash,
        v_now,
        v_now,
        v_now
    );

    INSERT INTO public.analysis_v2_profile_fetch_outcomes (
        request_id,
        job_key,
        attempt,
        ordinal,
        username,
        source,
        status,
        failure_category,
        http_status,
        request_count,
        latency_ms,
        captured_at,
        profile_snapshot
    )
    SELECT
        p_request_id,
        p_job_key,
        'fresh_apify',
        outcome.ordinal::SMALLINT,
        outcome.value->>'username',
        outcome.value->>'source',
        outcome.value->>'status',
        NULLIF(outcome.value->>'failure_category', ''),
        CASE
            WHEN outcome.value->'http_status' = 'null'::JSONB THEN NULL
            ELSE (outcome.value->>'http_status')::SMALLINT
        END,
        (outcome.value->>'request_count')::SMALLINT,
        (outcome.value->>'latency_ms')::INTEGER,
        (outcome.value->>'captured_at')::TIMESTAMPTZ,
        CASE
            WHEN outcome.value->'profile' = 'null'::JSONB THEN NULL
            ELSE outcome.value->'profile'
        END
    FROM pg_catalog.jsonb_array_elements(p_outcomes)
        WITH ORDINALITY AS outcome(value, ordinal)
    ORDER BY outcome.ordinal;

    RETURN public.analysis_v2_profile_checkpoint_snapshot(p_request_id, p_job_key);
END;
$$;

REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB, TEXT, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB, TEXT, TEXT
) TO service_role;

COMMENT ON FUNCTION public.checkpoint_analysis_v2_profile_fresh_apify_earlybird_v1(
    UUID, TEXT, UUID, TEXT, TEXT[], JSONB, TEXT, TEXT
) IS 'Paid Earlybird direct-fresh Apify profile checkpoint. Requires the order-scoped secondary slot and one exact current request-owned provider run; no fallback or repair state is admitted.';

COMMIT;
