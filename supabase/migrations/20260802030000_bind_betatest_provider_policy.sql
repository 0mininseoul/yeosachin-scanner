-- Bind the durable betatest allocation to the immutable provider policy and
-- fence every provider-reservation entry point to that allocation.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

CREATE OR REPLACE FUNCTION public.analysis_beta_provider_policy_hash(
    p_target_instagram_id TEXT,
    p_operation_slot_map JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                'betatest-free-pool-v1' || E'\n' || p_target_instagram_id
                || E'\n' || p_operation_slot_map::TEXT,
                'UTF8'
            ), 'sha256'
        ), 'hex'
    )
$$;

REVOKE ALL ON FUNCTION public.analysis_beta_provider_policy_hash(TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.analysis_v2_provider_execution_policies
    ALTER COLUMN entitlement_jti_hash DROP NOT NULL,
    DROP CONSTRAINT IF EXISTS analysis_v2_provider_execution_policies_mode_check,
    DROP CONSTRAINT IF EXISTS analysis_v2_provider_execution_policies_policy_version_check,
    DROP CONSTRAINT IF EXISTS analysis_v2_provider_execution_policies_operation_slot_map_check;

-- PostgreSQL truncates generated CHECK names on this long table name.  Remove
-- the three legacy branch checks by their definitions as well as their normal
-- names so both existing production databases and the compact PGlite schema
-- arrive at the one explicit branch constraint below.
DO $$
DECLARE v_constraint RECORD;
BEGIN
    FOR v_constraint IN
        SELECT constraint_row.conname
        FROM pg_catalog.pg_constraint AS constraint_row
        WHERE constraint_row.conrelid = 'public.analysis_v2_provider_execution_policies'::pg_catalog.regclass
          AND constraint_row.contype = 'c'
          AND (
              pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%mode = ''test_operation_split''%'
              OR pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%policy_version = ''authorized-free-e2e-v1''%'
              OR pg_catalog.pg_get_constraintdef(constraint_row.oid) LIKE '%analysis_v2_valid_test_operation_slot_map%'
          )
    LOOP
        EXECUTE pg_catalog.format(
            'ALTER TABLE public.analysis_v2_provider_execution_policies DROP CONSTRAINT %I',
            v_constraint.conname
        );
    END LOOP;
END;
$$;

ALTER TABLE public.analysis_v2_provider_execution_policies
    ADD CONSTRAINT analysis_v2_provider_execution_policies_branch_check CHECK (
        (
            mode = 'test_operation_split'
            AND policy_version = 'authorized-free-e2e-v1'
            AND entitlement_jti_hash IS NOT NULL
            AND entitlement_jti_hash ~ '^[a-f0-9]{64}$'
            AND public.analysis_v2_valid_test_operation_slot_map(operation_slot_map)
        ) OR (
            mode = 'betatest_free_pool'
            AND policy_version = 'betatest-free-pool-v1'
            AND entitlement_jti_hash IS NULL
            AND public.analysis_beta_valid_operation_slot_map(operation_slot_map)
        )
    ) NOT VALID;

ALTER TABLE public.analysis_v2_provider_execution_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_provider_execution_policies FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_provider_execution_policies
    FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the Task 2B1 implementation as a private primitive.  The public
-- signature is recreated below so the policy and allocation commit together.
ALTER FUNCTION public.activate_analysis_beta_apify_request_credit(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) RENAME TO activate_analysis_beta_apify_request_credit_unbound;

CREATE OR REPLACE FUNCTION public.activate_analysis_beta_apify_request_credit(
    p_preflight_id UUID,
    p_request_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_operation_slot_map JSONB,
    p_operation_budget_map JSONB,
    p_max_snapshot_age_seconds INTEGER DEFAULT 300
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_preflight public.analysis_preflights%ROWTYPE;
    v_before public.analysis_beta_pool_allocations%ROWTYPE;
    v_active public.analysis_beta_pool_allocations%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_existing public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_policy_hash TEXT;
    v_result JSONB;
BEGIN
    -- Match the 2B1 lock order before observing whether this is a replay.
    PERFORM users.id FROM public.users AS users
    WHERE users.id = p_user_id FOR KEY SHARE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id FOR UPDATE;
    SELECT allocation.* INTO v_before
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id FOR UPDATE;

    v_result := public.activate_analysis_beta_apify_request_credit_unbound(
        p_preflight_id, p_request_id, p_user_id, p_selected_plan_id,
        p_operation_slot_map, p_operation_budget_map, p_max_snapshot_age_seconds
    );

    SELECT allocation.* INTO v_active
    FROM public.analysis_beta_pool_allocations AS allocation
    WHERE allocation.preflight_id = p_preflight_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id FOR UPDATE;

    v_policy_hash := public.analysis_beta_provider_policy_hash(
        pg_catalog.lower(v_request.target_instagram_id), p_operation_slot_map
    );
    SELECT policy.* INTO v_existing
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id FOR UPDATE;

    IF v_before.lifecycle_state = 'active' THEN
        IF NOT FOUND
           OR v_existing.mode IS DISTINCT FROM 'betatest_free_pool'
           OR v_existing.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
           OR v_existing.entitlement_jti_hash IS NOT NULL
           OR v_existing.target_instagram_id IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)
           OR v_existing.operation_slot_map IS DISTINCT FROM p_operation_slot_map
           OR v_existing.policy_hash IS DISTINCT FROM v_policy_hash THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN v_result;
    END IF;

    IF FOUND THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF v_active.lifecycle_state IS DISTINCT FROM 'active'
       OR v_active.request_id IS DISTINCT FROM p_request_id
       OR v_active.operation_slot_map IS DISTINCT FROM p_operation_slot_map
       OR v_request.analysis_entry_channel IS DISTINCT FROM 'betatest' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_provider_execution_policies (
        request_id, mode, policy_version, entitlement_jti_hash,
        target_instagram_id, operation_slot_map, policy_hash
    ) VALUES (
        p_request_id, 'betatest_free_pool', 'betatest-free-pool-v1', NULL,
        pg_catalog.lower(v_request.target_instagram_id), p_operation_slot_map,
        v_policy_hash
    );
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.activate_analysis_beta_apify_request_credit(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.activate_analysis_beta_apify_request_credit(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) TO service_role;
REVOKE ALL ON FUNCTION public.activate_analysis_beta_apify_request_credit_unbound(
    UUID, UUID, UUID, TEXT, JSONB, JSONB, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.analysis_v2_reserve_provider_run_internal(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_operation_key TEXT,
    p_input_hash TEXT, p_logical_provider TEXT, p_actor_id TEXT,
    p_credential_slot TEXT, p_max_charge_usd NUMERIC, p_reservation_token UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_job public.analysis_pipeline_jobs%ROWTYPE;
DECLARE v_existing public.analysis_v2_provider_runs%ROWTYPE;
DECLARE v_beta BOOLEAN;
BEGIN
    SELECT EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_execution_policies AS policy
        WHERE policy.request_id = p_request_id AND policy.mode = 'betatest_free_pool'
    ) INTO v_beta;
    IF NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR NOT (public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
               OR (v_beta AND public.analysis_beta_valid_apify_credential_slot(p_credential_slot)))
       OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF NOT FOUND OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT provider_run.* INTO v_existing FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key FOR UPDATE;
    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash
           OR v_existing.logical_provider IS DISTINCT FROM p_logical_provider
           OR v_existing.actor_id IS DISTINCT FROM p_actor_id
           OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object('created', FALSE, 'run', public.analysis_v2_provider_run_json(v_existing));
    END IF;
    INSERT INTO public.analysis_v2_provider_runs (
        request_id, job_key, operation_key, input_hash, job_claim_token,
        reservation_token, logical_provider, actor_id, credential_slot, max_charge_usd
    ) VALUES (
        p_request_id, p_job_key, p_operation_key, p_input_hash, p_claim_token,
        p_reservation_token, p_logical_provider, p_actor_id, p_credential_slot, p_max_charge_usd
    ) RETURNING * INTO v_existing;
    RETURN pg_catalog.jsonb_build_object('created', TRUE, 'run', public.analysis_v2_provider_run_json(v_existing));
END;
$$;
REVOKE ALL ON FUNCTION public.analysis_v2_reserve_provider_run_internal(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_provider_run(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID, p_operation_key TEXT,
    p_input_hash TEXT, p_logical_provider TEXT, p_actor_id TEXT,
    p_credential_slot TEXT, p_max_charge_usd NUMERIC, p_reservation_token UUID
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
DECLARE v_request public.analysis_requests%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_existing public.analysis_v2_provider_runs%ROWTYPE;
DECLARE v_operation_kind TEXT;
DECLARE v_operation_family TEXT;
DECLARE v_spent NUMERIC;
BEGIN
    PERFORM 1 FROM public.analysis_preflights AS preflight WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request FROM public.analysis_requests AS analysis_request WHERE analysis_request.id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_pipeline_jobs AS job WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF EXISTS (SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent WHERE intent.request_id = p_request_id AND intent.completed_at IS NULL) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;
    SELECT policy.* INTO v_policy FROM public.analysis_v2_provider_execution_policies AS policy WHERE policy.request_id = p_request_id;
    IF v_request.analysis_entry_channel = 'betatest' THEN
        v_operation_family := pg_catalog.split_part(p_operation_key, ':', 1);
        IF NOT public.analysis_beta_valid_operation_slot_map(v_policy.operation_slot_map)
           OR v_policy.mode IS DISTINCT FROM 'betatest_free_pool'
           OR v_policy.policy_version IS DISTINCT FROM 'betatest-free-pool-v1'
           OR v_policy.entitlement_jti_hash IS NOT NULL
           OR v_operation_family NOT IN ('target-profile','relationship-followers','relationship-following','profile-fallback','profile-repair','target-likers','target-comments','candidate-likers') THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_RUN_OPERATION_INVALID', ERRCODE = 'P0001';
        END IF;
        SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation
        WHERE allocation.request_id = p_request_id AND allocation.lifecycle_state = 'active' FOR UPDATE;
        SELECT reservation.* INTO v_reservation FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.allocation_id = v_allocation.id AND reservation.operation_family = v_operation_family FOR UPDATE;
        IF NOT FOUND OR v_allocation.operation_slot_map IS DISTINCT FROM v_policy.operation_slot_map
           OR v_reservation.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_policy.operation_slot_map->>v_operation_family IS DISTINCT FROM p_credential_slot
           OR NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_RUN_SLOT_MISMATCH', ERRCODE = 'P0001';
        END IF;
        SELECT provider_run.* INTO v_existing FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id AND provider_run.job_key = p_job_key
          AND provider_run.operation_key = p_operation_key FOR UPDATE;
        IF FOUND AND (v_existing.input_hash IS DISTINCT FROM p_input_hash
           OR v_existing.logical_provider IS DISTINCT FROM p_logical_provider
           OR v_existing.actor_id IS DISTINCT FROM p_actor_id
           OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd) THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        SELECT COALESCE(pg_catalog.sum(provider_run.max_charge_usd), 0::NUMERIC) INTO v_spent
        FROM public.analysis_v2_provider_runs AS provider_run
        WHERE provider_run.request_id = p_request_id
          AND pg_catalog.split_part(provider_run.operation_key, ':', 1) = v_operation_family
          AND (provider_run.job_key IS DISTINCT FROM p_job_key OR provider_run.operation_key IS DISTINCT FROM p_operation_key);
        IF v_spent + p_max_charge_usd > v_reservation.reserved_usd THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PROVIDER_RUN_BUDGET_EXCEEDED', ERRCODE = 'P0001';
        END IF;
    ELSIF FOUND THEN
        v_operation_kind := pg_catalog.split_part(p_operation_key, ':', 1);
        IF v_policy.mode = 'test_operation_split' AND v_operation_kind = 'profile-repair' THEN v_operation_kind := 'profile-fallback'; END IF;
        IF v_policy.operation_slot_map->>v_operation_kind IS DISTINCT FROM p_credential_slot THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH', ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN public.analysis_v2_reserve_provider_run_internal(p_request_id,p_job_key,p_claim_token,p_operation_key,p_input_hash,p_logical_provider,p_actor_id,p_credential_slot,p_max_charge_usd,p_reservation_token);
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_analysis_v2_provider_run(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,UUID) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_provider_run(UUID,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,NUMERIC,UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_preflight_provider_run(
    p_preflight_id UUID, p_claim_token UUID, p_input_hash TEXT,
    p_credential_slot TEXT, p_max_charge_usd NUMERIC
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_target_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_existing public.analysis_preflight_provider_runs%ROWTYPE;
DECLARE v_spent NUMERIC;
BEGIN
    IF p_preflight_id IS NULL OR p_claim_token IS NULL OR p_input_hash !~ '^[0-9a-f]{64}$'
       OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight
    WHERE preflight.id = p_preflight_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001'; END IF;
    IF v_preflight.expires_at <= v_now OR NOT ((v_preflight.status = 'processing' AND v_preflight.lease_token IS NOT DISTINCT FROM p_claim_token AND v_preflight.lease_expires_at > v_now) OR (v_preflight.status = 'ready' AND v_preflight.consumed_request_id IS NULL AND v_preflight.admission_status = 'processing' AND v_preflight.admission_claim_token IS NOT DISTINCT FROM p_claim_token AND v_preflight.admission_lease_expires_at > v_now)) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_preflight.analysis_entry_channel = 'betatest' THEN
        SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation
        WHERE allocation.preflight_id = p_preflight_id AND allocation.lifecycle_state = 'preflight_held' FOR UPDATE;
        SELECT reservation.* INTO v_target_reservation FROM public.analysis_beta_pool_reservations AS reservation
        WHERE reservation.allocation_id = v_allocation.id AND reservation.operation_family = 'target-profile' FOR UPDATE;
        IF NOT FOUND OR NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot)
           OR v_target_reservation.credential_slot IS DISTINCT FROM p_credential_slot THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH', ERRCODE = 'P0001';
        END IF;
    ELSIF NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT provider_run.* INTO v_existing FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.preflight_id = p_preflight_id AND provider_run.operation_key = 'target-profile-fallback' FOR UPDATE;
    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash OR v_existing.logical_provider IS DISTINCT FROM 'apify' OR v_existing.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper' OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object('created',FALSE,'run',public.analysis_preflight_provider_run_json(v_existing));
    END IF;
    IF v_preflight.analysis_entry_channel = 'betatest' THEN
        PERFORM 1 FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id = p_preflight_id FOR UPDATE;
        SELECT COALESCE(pg_catalog.sum(provider_run.max_charge_usd),0::NUMERIC) INTO v_spent FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id = p_preflight_id AND provider_run.operation_key IS DISTINCT FROM 'target-profile-fallback';
        IF v_spent + p_max_charge_usd > v_target_reservation.reserved_usd THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_BUDGET_EXCEEDED', ERRCODE = 'P0001'; END IF;
    END IF;
    INSERT INTO public.analysis_preflight_provider_runs(preflight_id,input_hash,credential_slot,max_charge_usd) VALUES(p_preflight_id,p_input_hash,p_credential_slot,p_max_charge_usd) RETURNING * INTO v_existing;
    RETURN pg_catalog.jsonb_build_object('created',TRUE,'run',public.analysis_preflight_provider_run_json(v_existing));
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_analysis_preflight_provider_run(UUID,UUID,TEXT,TEXT,NUMERIC) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_preflight_provider_run(UUID,UUID,TEXT,TEXT,NUMERIC) TO service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(
    p_preflight_id UUID, p_admission_generation INTEGER, p_claim_token UUID,
    p_input_hash TEXT, p_credential_slot TEXT, p_max_charge_usd NUMERIC
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
DECLARE v_operation_key TEXT;
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_allocation public.analysis_beta_pool_allocations%ROWTYPE;
DECLARE v_target_reservation public.analysis_beta_pool_reservations%ROWTYPE;
DECLARE v_existing public.analysis_preflight_provider_runs%ROWTYPE;
DECLARE v_spent NUMERIC;
BEGIN
    IF p_preflight_id IS NULL OR p_admission_generation NOT BETWEEN 1 AND 100 OR p_claim_token IS NULL OR p_input_hash !~ '^[0-9a-f]{64}$' OR p_max_charge_usd IS DISTINCT FROM 0.002600000000 THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE = 'P0001'; END IF;
    v_operation_key := 'target-profile-fresh-admission:g' || p_admission_generation::TEXT;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight WHERE preflight.id = p_preflight_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001'; END IF;
    IF v_preflight.status IS DISTINCT FROM 'ready' OR v_preflight.consumed_request_id IS NOT NULL OR v_preflight.expires_at <= v_now OR v_preflight.admission_generation IS DISTINCT FROM p_admission_generation OR v_preflight.admission_status IS DISTINCT FROM 'processing' OR v_preflight.admission_claim_token IS DISTINCT FROM p_claim_token OR v_preflight.admission_lease_expires_at IS NULL OR v_preflight.admission_lease_expires_at <= v_now THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001'; END IF;
    IF v_preflight.analysis_entry_channel = 'betatest' THEN
        IF p_admission_generation > 1 THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_GENERATION_INVALID', ERRCODE = 'P0001'; END IF;
        SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation WHERE allocation.preflight_id = p_preflight_id AND allocation.lifecycle_state = 'preflight_held' FOR UPDATE;
        SELECT reservation.* INTO v_target_reservation FROM public.analysis_beta_pool_reservations AS reservation WHERE reservation.allocation_id = v_allocation.id AND reservation.operation_family = 'target-profile' FOR UPDATE;
        IF NOT FOUND OR NOT public.analysis_beta_valid_apify_credential_slot(p_credential_slot) OR v_target_reservation.credential_slot IS DISTINCT FROM p_credential_slot THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH', ERRCODE = 'P0001'; END IF;
    ELSIF NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot) THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_INVALID', ERRCODE = 'P0001'; END IF;
    PERFORM public.adopt_legacy_fresh_admission_provider_run(p_preflight_id,v_operation_key,v_preflight.admission_requested_at);
    SELECT provider_run.* INTO v_existing FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id = p_preflight_id AND provider_run.operation_key = v_operation_key FOR UPDATE;
    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash OR v_existing.logical_provider IS DISTINCT FROM 'apify' OR v_existing.actor_id IS DISTINCT FROM 'apify/instagram-profile-scraper' OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_PREFLIGHT_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001'; END IF;
        RETURN pg_catalog.jsonb_build_object('created',FALSE,'run',public.analysis_preflight_provider_run_json(v_existing));
    END IF;
    IF v_preflight.analysis_entry_channel = 'betatest' THEN
        PERFORM 1 FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id = p_preflight_id FOR UPDATE;
        SELECT COALESCE(pg_catalog.sum(provider_run.max_charge_usd),0::NUMERIC) INTO v_spent FROM public.analysis_preflight_provider_runs AS provider_run WHERE provider_run.preflight_id = p_preflight_id AND provider_run.operation_key IS DISTINCT FROM v_operation_key;
        IF v_spent + p_max_charge_usd > v_target_reservation.reserved_usd THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_BUDGET_EXCEEDED', ERRCODE = 'P0001'; END IF;
    END IF;
    INSERT INTO public.analysis_preflight_provider_runs(preflight_id,operation_key,input_hash,credential_slot,max_charge_usd) VALUES(p_preflight_id,v_operation_key,p_input_hash,p_credential_slot,p_max_charge_usd) RETURNING * INTO v_existing;
    RETURN pg_catalog.jsonb_build_object('created',TRUE,'run',public.analysis_preflight_provider_run_json(v_existing));
END;
$$;
REVOKE ALL ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(UUID,INTEGER,UUID,TEXT,TEXT,NUMERIC) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_fresh_admission_provider_run(UUID,INTEGER,UUID,TEXT,TEXT,NUMERIC) TO service_role;

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
DECLARE v_detailed_limit INTEGER;
BEGIN
    IF p_request_id IS NULL OR p_job_key IS NULL OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160 OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$' OR p_claim_token IS NULL OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID', ERRCODE = 'P0001'; END IF;
    SELECT preflight.* INTO v_preflight FROM public.analysis_preflights AS preflight WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request FROM public.analysis_requests AS analysis_request WHERE analysis_request.id = p_request_id FOR UPDATE;
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    SELECT policy.* INTO v_policy FROM public.analysis_v2_provider_execution_policies AS policy WHERE policy.request_id = p_request_id;
    IF v_request.analysis_entry_channel = 'betatest' THEN
        SELECT allocation.* INTO v_allocation FROM public.analysis_beta_pool_allocations AS allocation WHERE allocation.request_id = p_request_id FOR UPDATE;
    END IF;
    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.id IS NULL OR v_preflight.status <> 'consumed' OR v_preflight.target_followers_count IS NULL OR v_preflight.target_following_count IS NULL OR v_preflight.target_instagram_id IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id) OR v_preflight.excluded_instagram_id IS DISTINCT FROM v_request.excluded_instagram_id OR v_preflight.access_mode IS DISTINCT FROM v_request.plan_access_mode_snapshot OR v_request.id IS NULL OR v_request.pipeline_version IS DISTINCT FROM 'v2' OR v_request.status NOT IN ('pending','processing') OR v_request.plan_access_mode_snapshot NOT IN ('production','test_entitlement') OR (v_policy.request_id IS NOT NULL AND v_policy.target_instagram_id IS DISTINCT FROM pg_catalog.lower(v_request.target_instagram_id)) OR (v_request.plan_access_mode_snapshot = 'production' AND v_policy.request_id IS NOT NULL AND NOT (v_request.analysis_entry_channel = 'betatest' AND v_preflight.analysis_entry_channel = 'betatest' AND v_policy.mode = 'betatest_free_pool' AND v_policy.policy_version = 'betatest-free-pool-v1' AND v_policy.entitlement_jti_hash IS NULL AND v_allocation.lifecycle_state = 'active' AND v_allocation.preflight_id = v_preflight.id AND v_allocation.operation_slot_map IS NOT DISTINCT FROM v_policy.operation_slot_map AND v_policy.operation_slot_map IS NOT DISTINCT FROM v_allocation.operation_slot_map AND v_policy.policy_hash = public.analysis_beta_provider_policy_hash(pg_catalog.lower(v_request.target_instagram_id), v_policy.operation_slot_map))) OR (v_request.analysis_entry_channel = 'betatest' AND (v_policy.request_id IS NULL OR v_preflight.analysis_entry_channel IS DISTINCT FROM 'betatest' OR v_policy.mode IS DISTINCT FROM 'betatest_free_pool' OR v_policy.policy_version IS DISTINCT FROM 'betatest-free-pool-v1' OR v_policy.entitlement_jti_hash IS NOT NULL OR v_allocation.lifecycle_state IS DISTINCT FROM 'active' OR v_allocation.preflight_id IS DISTINCT FROM v_preflight.id OR v_allocation.operation_slot_map IS DISTINCT FROM v_policy.operation_slot_map OR v_policy.policy_hash IS DISTINCT FROM public.analysis_beta_provider_policy_hash(pg_catalog.lower(v_request.target_instagram_id), v_policy.operation_slot_map))) OR v_request.selected_plan_id_snapshot NOT IN ('basic','standard','plus') OR v_request.analysis_scope_snapshot IS NULL OR v_job.request_id IS NULL OR v_job.status <> 'processing' OR v_job.input_hash IS DISTINCT FROM p_job_input_hash OR v_job.lease_token IS DISTINCT FROM p_claim_token OR v_job.lease_expires_at IS NULL OR v_job.lease_expires_at <= v_now THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH', ERRCODE = 'P0001'; END IF;
    v_detailed_limit := (v_request.analysis_scope_snapshot->>'detailedMutualLimit')::INTEGER;
    IF v_detailed_limit NOT IN (300,600,900) OR v_preflight.target_followers_count > (v_request.analysis_scope_snapshot->'relationshipCapacity'->>'followers')::INTEGER OR v_preflight.target_following_count > (v_request.analysis_scope_snapshot->'relationshipCapacity'->>'following')::INTEGER THEN RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID', ERRCODE = 'P0001'; END IF;
    RETURN pg_catalog.jsonb_build_object('requestId',v_request.id,'targetUsername',pg_catalog.lower(v_request.target_instagram_id),'excludedUsername',v_request.excluded_instagram_id,'accessMode',v_request.plan_access_mode_snapshot,'providerExecutionPolicy',CASE WHEN v_policy.request_id IS NULL THEN NULL ELSE pg_catalog.jsonb_build_object('mode',v_policy.mode,'policyVersion',v_policy.policy_version,'operationSlots',v_policy.operation_slot_map) END,'planId',v_request.selected_plan_id_snapshot,'followersDeclaredCount',v_preflight.target_followers_count,'followingDeclaredCount',v_preflight.target_following_count,'detailedMutualLimit',v_detailed_limit);
END;
$$;
REVOKE ALL ON FUNCTION public.load_analysis_v2_collection_context_with_policy(UUID,TEXT,UUID,TEXT) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_collection_context_with_policy(UUID,TEXT,UUID,TEXT) TO service_role;
