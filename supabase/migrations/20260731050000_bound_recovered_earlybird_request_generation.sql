-- A schema/job-exhaustion recovery deliberately preserves its terminal request
-- while rebinding the paid order to a fresh preflight. The preserved request
-- still owns the original per-user idempotency key. Admit a bounded successor
-- only for that immutable recovery lineage, and fail closed before any new
-- provider spend until cross-request adoption is explicitly ready.

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE FUNCTION public.earlybird_provider_run_adoption_ready(
    p_order_id UUID,
    p_failed_request_id UUID,
    p_recovery_preflight_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
    SELECT FALSE;
$$;

REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    p_order_id UUID, p_lease_token UUID, p_lease_fence BIGINT
)
RETURNS TABLE(order_id UUID, fulfillment_status TEXT, request_id UUID, created BOOLEAN, initial_job_key TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := public.earlybird_fulfillment_clock();
    v_initial_job_key CONSTANT TEXT := 'coordinator:bootstrap';
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_request_id UUID;
    v_selected_card JSONB;
    v_scope_snapshot JSONB;
    v_input_hash TEXT;
    c_max_request_generations CONSTANT INTEGER := 10;
    v_request_base_key TEXT;
    v_request_generation_prefix TEXT;
    v_request_last_generation INTEGER;
    v_request_generation INTEGER;
    v_request_idempotency_key TEXT;
    v_conflicting_request public.analysis_requests%ROWTYPE;
    v_recovery public.earlybird_schema_failure_recoveries%ROWTYPE;
    v_recovery_preflight public.analysis_preflights%ROWTYPE;
    v_rebind_preflight_base_key TEXT;
    v_rebind_preflight_generation_prefix TEXT;
BEGIN
    IF p_order_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL OR p_lease_fence < 1 THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT fulfillment.* INTO v_fulfillment FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_NOT_FOUND', ERRCODE = 'P0001'; END IF;
    SELECT earlybird_order.* INTO v_order FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001'; END IF;

    IF v_fulfillment.request_id IS NOT NULL OR v_order.result_request_id IS NOT NULL
       OR v_preflight.consumed_request_id IS NOT NULL THEN
        IF v_fulfillment.request_id IS NULL OR v_order.result_request_id IS DISTINCT FROM v_fulfillment.request_id
           OR v_preflight.consumed_request_id IS DISTINCT FROM v_fulfillment.request_id THEN
            UPDATE public.earlybird_fulfillments AS fulfillment SET status = 'manual_review', lease_token = NULL,
                lease_expires_at = NULL, last_error_code = 'REQUEST_CONFLICT', last_error_at = v_now,
                manual_review_at = v_now, updated_at = v_now WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT, NULL::UUID, FALSE, NULL::TEXT; RETURN;
        END IF;
        SELECT analysis_request.* INTO v_request FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.id = v_fulfillment.request_id AND analysis_request.user_id = v_order.user_id
          AND analysis_request.preflight_id = v_order.preflight_id AND analysis_request.pipeline_version = 'v2'
          AND analysis_request.plan_access_mode_snapshot = 'production'
          AND analysis_request.selected_plan_id_snapshot = v_order.plan_id;
        IF NOT FOUND THEN
            UPDATE public.earlybird_fulfillments AS fulfillment SET status = 'manual_review', lease_token = NULL,
                lease_expires_at = NULL, last_error_code = 'REQUEST_CONFLICT', last_error_at = v_now,
                manual_review_at = v_now, updated_at = v_now WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT, NULL::UUID, FALSE, NULL::TEXT; RETURN;
        END IF;
        UPDATE public.earlybird_fulfillments AS fulfillment
        SET status = CASE WHEN v_request.status = 'completed' THEN 'completed' ELSE 'analysis_in_progress' END,
            lease_token = NULL, lease_expires_at = NULL,
            completed_at = CASE WHEN v_request.status = 'completed' THEN v_now ELSE NULL END, updated_at = v_now
        WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT p_order_id, CASE WHEN v_request.status = 'completed' THEN 'completed'::TEXT ELSE 'analysis_in_progress'::TEXT END,
            v_request.id, FALSE, v_initial_job_key; RETURN;
    END IF;
    IF v_fulfillment.lease_token IS DISTINCT FROM p_lease_token OR v_fulfillment.lease_fence IS DISTINCT FROM p_lease_fence
       OR v_fulfillment.lease_expires_at IS NULL OR v_fulfillment.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_LEASE_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    IF v_order.status <> 'paid' OR v_order.seller_reference_confirmed_at IS NULL OR v_order.payment_id IS NULL
       OR v_order.actual_amount_krw IS NULL OR v_order.actual_amount_krw < 0
       OR v_order.actual_amount_krw > v_order.expected_amount_krw
       OR v_order.actual_groble_product_id IS DISTINCT FROM v_order.expected_groble_product_id
       OR v_order.target_followers_count IS NULL OR v_order.target_following_count IS NULL
       OR v_preflight.user_id IS DISTINCT FROM v_order.user_id OR v_preflight.status <> 'ready'
       OR v_preflight.access_mode <> 'production' OR v_preflight.target_instagram_id IS DISTINCT FROM v_order.target_instagram_id
       OR v_preflight.exclusion_decision IS DISTINCT FROM v_order.exclusion_decision
       OR v_preflight.excluded_instagram_id IS DISTINCT FROM v_order.excluded_instagram_id
       OR v_preflight.admission_status <> 'ready'
       OR v_preflight.target_followers_count IS NULL OR v_preflight.target_following_count IS NULL
       OR v_preflight.admission_target_followers_count IS NULL OR v_preflight.admission_target_following_count IS NULL
       OR v_preflight.admission_target_followers_count IS DISTINCT FROM v_preflight.target_followers_count
       OR v_preflight.admission_target_following_count IS DISTINCT FROM v_preflight.target_following_count
       OR v_preflight.admission_capacity_required_plan_id IS DISTINCT FROM v_preflight.capacity_required_plan_id
       OR v_preflight.admission_required_plan_id IS DISTINCT FROM v_preflight.required_plan_id
       OR v_preflight.admission_plan_cards_snapshot IS DISTINCT FROM v_preflight.plan_cards_snapshot
       OR NOT public.analysis_v2_valid_launch_snapshot(v_preflight.launch_status_snapshot)
       OR NOT public.analysis_v2_valid_plan_catalog_snapshot(v_preflight.plan_catalog_snapshot)
       OR NOT public.analysis_v2_valid_plan_cards_snapshot(v_preflight.plan_cards_snapshot)
       OR NOT public.analysis_v2_valid_pricing_snapshot(v_preflight.pricing_snapshot)
       OR NOT public.analysis_v2_valid_policy_versions_snapshot(v_preflight.policy_versions_snapshot) THEN
        UPDATE public.earlybird_fulfillments AS fulfillment SET status = 'manual_review', lease_token = NULL,
            lease_expires_at = NULL, last_error_code = 'SNAPSHOT_CONFLICT', last_error_at = v_now,
            manual_review_at = v_now, updated_at = v_now WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT, NULL::UUID, FALSE, NULL::TEXT; RETURN;
    END IF;
    v_selected_card := v_preflight.plan_cards_snapshot->v_order.plan_id;
    IF v_order.plan_id NOT IN ('basic', 'standard') OR v_preflight.admission_selected_plan_id IS DISTINCT FROM v_order.plan_id
       OR v_selected_card IS NULL OR v_selected_card->>'launchStatus' <> 'production'
       OR v_selected_card->>'selectionState' NOT IN ('required', 'available_upgrade')
       OR COALESCE(v_selected_card->'relationshipCapacity'->>'followers', '') !~ '^[0-9]+$'
       OR COALESCE(v_selected_card->'relationshipCapacity'->>'following', '') !~ '^[0-9]+$'
       OR v_preflight.target_followers_count > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_preflight.target_following_count > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER
       OR v_order.target_followers_count > (v_selected_card->'relationshipCapacity'->>'followers')::INTEGER
       OR v_order.target_following_count > (v_selected_card->'relationshipCapacity'->>'following')::INTEGER THEN
        UPDATE public.earlybird_fulfillments AS fulfillment SET status = 'manual_review', lease_token = NULL,
            lease_expires_at = NULL, last_error_code = 'PLAN_NOT_ALLOWED', last_error_at = v_now,
            manual_review_at = v_now, updated_at = v_now WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT, NULL::UUID, FALSE, NULL::TEXT; RETURN;
    END IF;
    IF v_preflight.admission_refreshed_at IS NOT NULL AND v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes' THEN
        UPDATE public.earlybird_fulfillments AS fulfillment SET status = 'retryable_failure', lease_token = NULL,
            lease_expires_at = NULL, next_attempt_at = v_now, last_error_code = 'ADMISSION_FRESHNESS_EXPIRED',
            last_error_at = v_now, manual_review_at = NULL, updated_at = v_now WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT p_order_id, 'retryable_failure'::TEXT, NULL::UUID, FALSE, NULL::TEXT; RETURN;
    END IF;
    IF v_preflight.admission_refreshed_at IS NULL OR v_preflight.admission_refreshed_at > v_now + INTERVAL '30 seconds' THEN
        UPDATE public.earlybird_fulfillments AS fulfillment SET status = 'manual_review', lease_token = NULL,
            lease_expires_at = NULL, last_error_code = 'SNAPSHOT_CONFLICT', last_error_at = v_now,
            manual_review_at = v_now, updated_at = v_now WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT, NULL::UUID, FALSE, NULL::TEXT; RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM public.analysis_requests AS active_request WHERE active_request.user_id = v_order.user_id
        AND active_request.status IN ('pending', 'processing')) THEN
        UPDATE public.earlybird_fulfillments AS fulfillment SET status = 'manual_review', lease_token = NULL,
            lease_expires_at = NULL, last_error_code = 'ACTIVE_REQUEST_CONFLICT', last_error_at = v_now,
            manual_review_at = v_now, updated_at = v_now WHERE fulfillment.order_id = p_order_id;
        RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT, NULL::UUID, FALSE, NULL::TEXT; RETURN;
    END IF;
    v_scope_snapshot := pg_catalog.jsonb_build_object('relationshipCapacity', v_selected_card->'relationshipCapacity',
        'detailedMutualLimit', v_selected_card->'detailedMutualLimit');
    IF NOT public.analysis_v2_valid_scope_snapshot(v_scope_snapshot) THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
    END IF;
    v_request_base_key := 'earlybird:' || pg_catalog.lower(v_order.id::TEXT);
    v_request_idempotency_key := v_request_base_key;
    SELECT analysis_request.* INTO v_conflicting_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.user_id = v_order.user_id
      AND analysis_request.idempotency_key = v_request_base_key
    FOR UPDATE;
    IF FOUND THEN
        SELECT recovery.* INTO v_recovery
        FROM public.earlybird_schema_failure_recoveries AS recovery
        WHERE recovery.order_id = v_order.id
          AND recovery.failed_request_id = v_conflicting_request.id
        FOR UPDATE;
        IF FOUND THEN
            SELECT recovery_preflight.* INTO v_recovery_preflight
            FROM public.analysis_preflights AS recovery_preflight
            WHERE recovery_preflight.id = v_recovery.recovery_preflight_id
            FOR UPDATE;
        END IF;
        v_rebind_preflight_base_key := 'earlybird.fulfillment.'
            || pg_catalog.replace(v_order.id::TEXT, '-', '');
        v_rebind_preflight_generation_prefix :=
            v_rebind_preflight_base_key || '.r';
        IF v_recovery.order_id IS NULL
           OR v_recovery_preflight.id IS NULL
           OR v_conflicting_request.status <> 'failed'
           OR v_conflicting_request.pipeline_version <> 'v2'
           OR v_conflicting_request.error_message IS NULL
           OR NOT EXISTS (
                SELECT 1
                FROM public.analysis_v2_failure_receipts AS receipt
                WHERE receipt.request_id = v_conflicting_request.id
                  AND receipt.error_code = v_conflicting_request.error_message
           )
           OR (
                v_preflight.id IS DISTINCT FROM v_recovery.recovery_preflight_id
                AND (
                    v_preflight.user_id
                        IS DISTINCT FROM v_recovery_preflight.user_id
                    OR v_preflight.user_id IS DISTINCT FROM v_order.user_id
                    OR v_preflight.target_instagram_id
                        IS DISTINCT FROM v_order.target_instagram_id
                    OR v_preflight.exclusion_decision
                        IS DISTINCT FROM v_order.exclusion_decision
                    OR v_preflight.excluded_instagram_id
                        IS DISTINCT FROM v_order.excluded_instagram_id
                    OR v_preflight.access_mode <> 'production'
                    OR v_recovery_preflight.access_mode <> 'production'
                    OR v_preflight.launch_status_snapshot
                        IS DISTINCT FROM v_recovery_preflight.launch_status_snapshot
                    OR v_preflight.plan_catalog_snapshot
                        IS DISTINCT FROM v_recovery_preflight.plan_catalog_snapshot
                    OR v_preflight.pricing_version
                        IS DISTINCT FROM v_recovery_preflight.pricing_version
                    OR v_preflight.pricing_snapshot
                        IS DISTINCT FROM v_recovery_preflight.pricing_snapshot
                    OR v_preflight.policy_versions_snapshot
                        IS DISTINCT FROM v_recovery_preflight.policy_versions_snapshot
                    OR v_preflight.created_at < v_recovery_preflight.created_at
                    OR (
                        v_preflight.idempotency_key
                            <> v_rebind_preflight_base_key
                        AND NOT (
                            pg_catalog.left(
                                v_preflight.idempotency_key,
                                pg_catalog.char_length(
                                    v_rebind_preflight_generation_prefix
                                )
                            ) = v_rebind_preflight_generation_prefix
                            AND pg_catalog.substr(
                                v_preflight.idempotency_key,
                                pg_catalog.char_length(
                                    v_rebind_preflight_generation_prefix
                                ) + 1
                            ) ~ '^[1-9]$'
                        )
                    )
                )
           ) THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review', lease_token = NULL,
                lease_expires_at = NULL, last_error_code = 'REQUEST_CONFLICT',
                last_error_at = v_now, manual_review_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT,
                NULL::UUID, FALSE, NULL::TEXT;
            RETURN;
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_conflicting_request.id
        ) AND NOT public.earlybird_provider_run_adoption_ready(
            v_order.id, v_conflicting_request.id, v_preflight.id
        ) THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review', lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = 'PROVIDER_RUN_ADOPTION_REQUIRED',
                last_error_at = v_now, manual_review_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT,
                NULL::UUID, FALSE, NULL::TEXT;
            RETURN;
        END IF;

        v_request_generation_prefix := v_request_base_key || '.r';
        SELECT pg_catalog.max(
            CASE
                WHEN analysis_request.idempotency_key = v_request_base_key THEN 0
                ELSE (pg_catalog.substr(
                    analysis_request.idempotency_key,
                    pg_catalog.char_length(v_request_generation_prefix) + 1
                ))::INTEGER
            END
        ) INTO v_request_last_generation
        FROM public.analysis_requests AS analysis_request
        WHERE analysis_request.user_id = v_order.user_id
          AND (
              analysis_request.idempotency_key = v_request_base_key
              OR (
                  pg_catalog.left(
                      analysis_request.idempotency_key,
                      pg_catalog.char_length(v_request_generation_prefix)
                  ) = v_request_generation_prefix
                  AND pg_catalog.substr(
                      analysis_request.idempotency_key,
                      pg_catalog.char_length(v_request_generation_prefix) + 1
                  ) ~ '^[0-9]{1,3}$'
              )
          );
        v_request_generation := COALESCE(v_request_last_generation + 1, 1);
        IF v_request_generation >= c_max_request_generations THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review', lease_token = NULL,
                lease_expires_at = NULL,
                last_error_code = 'REQUEST_IDEMPOTENCY_EXHAUSTED',
                last_error_at = v_now, manual_review_at = v_now,
                updated_at = v_now
            WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT,
                NULL::UUID, FALSE, NULL::TEXT;
            RETURN;
        END IF;
        v_request_idempotency_key := v_request_generation_prefix
            || v_request_generation::TEXT;
    END IF;

    v_request_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_requests(id,user_id,target_instagram_id,target_gender,status,progress,progress_step,current_step,step_data,gender_stats,plan_type,background_processing,idempotency_key,pipeline_version,preflight_id,excluded_instagram_id,exclusion_decision_snapshot,plan_access_mode_snapshot,capacity_required_plan_id_snapshot,required_plan_id_snapshot,selected_plan_id_snapshot,plan_launch_status_snapshot,plan_cards_snapshot,pricing_version_snapshot,pricing_snapshot,analysis_scope_snapshot,policy_versions_snapshot)
    VALUES (v_request_id,v_order.user_id,v_order.target_instagram_id,'male','pending',0,'분석 대기 중...','pending','{}'::JSONB,'{}'::JSONB,v_order.plan_id,TRUE,v_request_idempotency_key,'v2',v_preflight.id,v_order.excluded_instagram_id,v_order.exclusion_decision,'production',v_preflight.capacity_required_plan_id,v_preflight.required_plan_id,v_order.plan_id,v_preflight.launch_status_snapshot,v_preflight.plan_cards_snapshot,v_preflight.pricing_version,v_preflight.pricing_snapshot,v_scope_snapshot,v_preflight.policy_versions_snapshot);
    UPDATE public.analysis_preflights AS preflight SET status = 'consumed', consumed_at = v_now,
        consumed_request_id = v_request_id, updated_at = v_now WHERE preflight.id = v_preflight.id;
    v_input_hash := pg_catalog.encode(extensions.digest(pg_catalog.convert_to('analysis-v2-job-input-v1' || pg_catalog.chr(10)
        || pg_catalog.lower(v_request_id::TEXT) || pg_catalog.chr(10) || v_initial_job_key,'UTF8'),'sha256'),'hex');
    INSERT INTO public.analysis_pipeline_jobs(request_id,job_key,track,kind,batch,input_hash,required_job_keys)
    VALUES(v_request_id,v_initial_job_key,'coordinator','bootstrap',NULL,v_input_hash,'{}'::TEXT[])
    ON CONFLICT ON CONSTRAINT analysis_pipeline_jobs_pkey DO NOTHING;
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = v_request_id AND job.job_key = v_initial_job_key FOR UPDATE;
    IF NOT FOUND OR v_job.track <> 'coordinator' OR v_job.kind <> 'bootstrap' OR v_job.batch IS NOT NULL
       OR v_job.input_hash <> v_input_hash OR v_job.required_job_keys <> '{}'::TEXT[] THEN
        RAISE EXCEPTION USING MESSAGE = 'EARLYBIRD_FULFILLMENT_REQUEST_CONFLICT', ERRCODE = 'P0001';
    END IF;
    UPDATE public.earlybird_orders AS earlybird_order SET status = 'analysis_in_progress', result_request_id = v_request_id,
        updated_at = v_now WHERE earlybird_order.id = p_order_id;
    UPDATE public.earlybird_fulfillments AS fulfillment SET status = 'analysis_in_progress', request_id = v_request_id,
        lease_token = NULL, lease_expires_at = NULL, next_attempt_at = v_now, last_error_code = NULL,
        last_error_at = NULL, updated_at = v_now WHERE fulfillment.order_id = p_order_id;
    RETURN QUERY SELECT p_order_id, 'analysis_in_progress'::TEXT, v_request_id, TRUE, v_initial_job_key;
END;
$$;

REVOKE ALL ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) TO service_role;
