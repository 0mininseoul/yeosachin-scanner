-- Expose each active betatest allocation's frozen operation budgets only to
-- the service-owned collection context. The complete predecessor claim fence
-- is recreated here so the additional allocation checks cannot bypass request,
-- preflight, job, lease, or provider-policy identity validation.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- Canonical apply fence: take the allocation relation before CREATE TRIGGER
-- or any child repair can acquire a conflicting table lock. Concurrent
-- activation/settlement finishes first or this migration fails within the
-- existing five-second lock timeout; no child-first lock cycle is possible.
LOCK TABLE public.analysis_beta_pool_allocations IN EXCLUSIVE MODE;

-- Terminal settlement deliberately decoupled allocation and reservation
-- lifecycles. Keep activation atomic by explicitly promoting the eight child
-- reservations when their allocation becomes active, then validate that the
-- frozen maps and durable rows are identical before the transition commits.
CREATE OR REPLACE FUNCTION public.activate_analysis_beta_pool_reservations()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_reservation_count INTEGER;
DECLARE v_reservation_drift BOOLEAN;
BEGIN
    IF OLD.lifecycle_state IS DISTINCT FROM 'active'
       AND NEW.lifecycle_state = 'active' THEN
        UPDATE public.analysis_beta_pool_reservations AS reservation
        SET lifecycle_state = 'active',
            updated_at = pg_catalog.clock_timestamp()
        WHERE reservation.allocation_id = NEW.id
          AND reservation.lifecycle_state = 'preflight_held';

        SELECT pg_catalog.count(*)::INTEGER,
               COALESCE(pg_catalog.bool_or(
                   reservation.lifecycle_state IS DISTINCT FROM 'active'
                   OR reservation.credential_slot IS DISTINCT FROM NEW.operation_slot_map->>reservation.operation_family
                   OR reservation.reserved_usd IS DISTINCT FROM (NEW.operation_budget_map->>reservation.operation_family)::NUMERIC
               ), FALSE)
        INTO v_reservation_count, v_reservation_drift
        FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.allocation_id = NEW.id;

        IF v_reservation_count <> 8 OR v_reservation_drift THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.activate_analysis_beta_pool_reservations()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER activate_analysis_beta_pool_reservations
AFTER UPDATE OF lifecycle_state
ON public.analysis_beta_pool_allocations
FOR EACH ROW
EXECUTE FUNCTION public.activate_analysis_beta_pool_reservations();

-- Repair allocations activated after settlement decoupled the lifecycle FK.
-- The following assertion makes a malformed live historical allocation fail
-- the migration instead of exposing a partial or mismatched budget context.
-- Terminal allocations may legitimately be partially settled while one
-- ambiguous provider family remains held, so they are outside this live fence.
UPDATE public.analysis_beta_pool_reservations AS reservation
SET lifecycle_state = 'active',
    updated_at = pg_catalog.clock_timestamp()
FROM public.analysis_beta_pool_allocations AS allocation
WHERE allocation.id = reservation.allocation_id
  AND allocation.lifecycle_state = 'active'
  AND reservation.lifecycle_state = 'preflight_held';

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.analysis_beta_pool_allocations AS allocation
        JOIN public.analysis_requests AS analysis_request
          ON analysis_request.id = allocation.request_id
        LEFT JOIN public.analysis_beta_pool_reservations AS reservation
          ON reservation.allocation_id = allocation.id
        WHERE allocation.lifecycle_state = 'active'
          AND analysis_request.status IN ('pending', 'processing')
        GROUP BY allocation.id
        HAVING pg_catalog.count(reservation.*) <> 8
            OR COALESCE(pg_catalog.bool_or(
                reservation.lifecycle_state IS DISTINCT FROM 'active'
                OR reservation.credential_slot IS DISTINCT FROM allocation.operation_slot_map->>reservation.operation_family
                OR reservation.reserved_usd IS DISTINCT FROM (allocation.operation_budget_map->>reservation.operation_family)::NUMERIC
            ), FALSE)
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_BETA_ALLOCATION_CONFLICT',
            ERRCODE = 'P0001';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_collection_context_with_policy(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_job_input_hash TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_request public.analysis_requests%ROWTYPE;
DECLARE v_job public.analysis_pipeline_jobs%ROWTYPE;
DECLARE v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_beta_reservation_count INTEGER := 0;
DECLARE v_beta_reservation_drift BOOLEAN := FALSE;
DECLARE v_detailed_limit INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160 OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' OR p_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID', ERRCODE = 'P0001'; END IF;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request FROM public.analysis_requests AS analysis_request WHERE analysis_request.id = p_request_id FOR UPDATE;
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    SELECT policy.* INTO v_policy FROM public.analysis_v2_provider_execution_policies AS policy WHERE policy.request_id = p_request_id;
    IF v_request.analysis_entry_channel = 'betatest' THEN
        SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation WHERE allocation.request_id = p_request_id FOR UPDATE;
        IF v_allocation.id IS NOT NULL THEN
            PERFORM 1 FROM public.analysis_beta_pool_reservations AS reservation WHERE reservation.allocation_id = v_allocation.id ORDER BY reservation.operation_family FOR UPDATE;
            SELECT pg_catalog.count(*)::INTEGER,
                   COALESCE(pg_catalog.bool_or(
                       reservation.lifecycle_state IS DISTINCT FROM 'active'
                       OR reservation.credential_slot IS DISTINCT FROM v_allocation.operation_slot_map->>reservation.operation_family
                       OR reservation.reserved_usd IS DISTINCT FROM (v_allocation.operation_budget_map->>reservation.operation_family)::NUMERIC
                   ), FALSE)
            INTO v_beta_reservation_count, v_beta_reservation_drift
            FROM public.analysis_beta_pool_reservations AS reservation
            WHERE reservation.allocation_id = v_allocation.id;
        END IF;
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.id IS NULL OR v_preflight.status <> 'consumed' OR v_preflight.target_followers_count IS NULL OR v_preflight.target_following_count IS NULL OR v_preflight.target_instagram_id IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id) OR v_preflight.excluded_instagram_id IS DISTINCT FROM v_request.excluded_instagram_id OR v_preflight.access_mode IS DISTINCT FROM v_request.plan_access_mode_snapshot OR v_request.id IS NULL OR v_request.pipeline_version IS DISTINCT FROM 'v2' OR v_request.status NOT IN ('pending','processing') OR v_request.plan_access_mode_snapshot NOT IN ('production','test_entitlement') OR (v_policy.request_id IS NOT NULL AND v_policy.target_instagram_id IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)) OR (v_request.plan_access_mode_snapshot = 'production' AND v_policy.request_id IS NOT NULL AND NOT (v_request.analysis_entry_channel = 'betatest' AND v_preflight.analysis_entry_channel = 'betatest' AND v_policy.mode = 'betatest_free_pool' AND v_policy.policy_version = 'betatest-free-pool-v1' AND v_policy.entitlement_jti_hash IS NULL AND v_allocation.lifecycle_state = 'active' AND v_allocation.request_id IS NOT DISTINCT FROM v_request.id AND v_allocation.preflight_id = v_preflight.id AND v_allocation.user_id IS NOT DISTINCT FROM v_request.user_id AND v_allocation.selected_plan_id IS NOT DISTINCT FROM v_request.selected_plan_id_snapshot AND v_allocation.policy_version IS NOT DISTINCT FROM v_policy.policy_version AND public.analysis_beta_valid_operation_slot_map(v_allocation.operation_slot_map) AND public.analysis_beta_valid_operation_budget_map(v_allocation.operation_budget_map) AND v_allocation.operation_slot_map IS NOT DISTINCT FROM v_policy.operation_slot_map AND v_policy.operation_slot_map IS NOT DISTINCT FROM v_allocation.operation_slot_map AND v_policy.policy_hash = public.analysis_beta_provider_policy_hash(pg_catalog.lower(v_request.target_instagram_id), v_policy.operation_slot_map) AND v_beta_reservation_count = 8 AND NOT v_beta_reservation_drift)) OR (v_request.analysis_entry_channel = 'betatest' AND (v_policy.request_id IS NULL OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest' OR v_policy.mode IS DISTINCT FROM 'betatest_free_pool' OR v_policy.policy_version IS DISTINCT FROM 'betatest-free-pool-v1' OR v_policy.entitlement_jti_hash IS NOT NULL OR v_allocation.lifecycle_state IS DISTINCT FROM 'active' OR v_allocation.request_id IS DISTINCT FROM v_request.id OR v_allocation.preflight_id IS DISTINCT FROM v_preflight.id OR v_allocation.user_id IS DISTINCT FROM v_request.user_id OR v_allocation.selected_plan_id IS DISTINCT FROM v_request.selected_plan_id_snapshot OR v_allocation.policy_version IS DISTINCT FROM v_policy.policy_version OR NOT public.analysis_beta_valid_operation_slot_map(v_allocation.operation_slot_map) OR NOT public.analysis_beta_valid_operation_budget_map(v_allocation.operation_budget_map) OR v_allocation.operation_slot_map IS DISTINCT FROM v_policy.operation_slot_map OR v_policy.policy_hash IS DISTINCT FROM public.analysis_beta_provider_policy_hash(pg_catalog.lower(v_request.target_instagram_id), v_policy.operation_slot_map) OR v_beta_reservation_count <> 8 OR v_beta_reservation_drift)) OR v_request.selected_plan_id_snapshot NOT IN ('basic','standard','plus') OR v_request.analysis_scope_snapshot IS NULL OR v_job.request_id IS NULL OR v_job.status <> 'processing' OR v_job.input_hash IS DISTINCT FROM p_job_input_hash OR v_job.lease_token IS DISTINCT FROM p_claim_token OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH', ERRCODE = 'P0001'; END IF;
    v_detailed_limit := (v_request.analysis_scope_snapshot->>'detailedMutualLimit')::INTEGER;
    IF v_detailed_limit NOT IN (300,600,900) OR v_preflight.target_followers_count > (v_request.analysis_scope_snapshot->'relationshipCapacity'->>'followers')::INTEGER OR v_preflight.target_following_count > (v_request.analysis_scope_snapshot->'relationshipCapacity'->>'following')::INTEGER THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID', ERRCODE = 'P0001'; END IF;
    RETURN pg_catalog.jsonb_build_object('requestId',v_request.id,'targetUsername',pg_catalog.lower(v_request.target_instagram_id),'excludedUsername',v_request.excluded_instagram_id,'accessMode',v_request.plan_access_mode_snapshot,'providerExecutionPolicy',CASE WHEN v_policy.request_id IS NULL THEN NULL WHEN v_policy.mode = 'betatest_free_pool' THEN pg_catalog.jsonb_build_object('mode',v_policy.mode,'policyVersion',v_policy.policy_version,'operationSlots',v_policy.operation_slot_map,'operationBudgets',v_allocation.operation_budget_map) ELSE pg_catalog.jsonb_build_object('mode',v_policy.mode,'policyVersion',v_policy.policy_version,'operationSlots',v_policy.operation_slot_map) END,'planId',v_request.selected_plan_id_snapshot,'followersDeclaredCount',v_preflight.target_followers_count,'followingDeclaredCount',v_preflight.target_following_count,'detailedMutualLimit',v_detailed_limit);
END;
$$;
REVOKE ALL ON FUNCTION public.load_analysis_v2_collection_context_with_policy(UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_collection_context_with_policy(UUID,TEXT,UUID,TEXT) TO service_role;
COMMIT;
