-- A signed test entitlement may bind one immutable operation-to-credential policy before
-- its initial job is dispatched. Ordinary test requests and every production request keep
-- the existing deployment-scoped single credential slot.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_test_operation_slot_map(p_map JSONB)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_map) = 'object'
        AND p_map ?& ARRAY[
            'target-profile', 'relationship-followers', 'relationship-following',
            'profile-fallback',
            'target-likers', 'target-comments', 'candidate-likers'
        ]
        AND p_map - ARRAY[
            'target-profile', 'relationship-followers', 'relationship-following',
            'profile-fallback',
            'target-likers', 'target-comments', 'candidate-likers'
        ] = '{}'::JSONB
        AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.jsonb_each(p_map) AS entry(operation_kind, slot_value)
            WHERE pg_catalog.jsonb_typeof(entry.slot_value) <> 'string'
               OR NOT public.analysis_v2_valid_apify_credential_slot(
                    entry.slot_value #>> '{}'
               )
        )
        AND p_map->>'target-profile' = p_map->>'profile-fallback'
        AND p_map->>'relationship-followers' <> p_map->>'relationship-following'
        AND p_map->>'target-likers' <> p_map->>'candidate-likers',
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_test_operation_slot_map(JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TABLE public.analysis_v2_provider_execution_policies (
    request_id UUID PRIMARY KEY
        REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    mode VARCHAR(32) NOT NULL CHECK (mode = 'test_operation_split'),
    policy_version VARCHAR(64) NOT NULL
        CHECK (policy_version = 'authorized-free-e2e-v1'),
    entitlement_jti_hash VARCHAR(64) NOT NULL
        CHECK (entitlement_jti_hash ~ '^[a-f0-9]{64}$'),
    target_instagram_id VARCHAR(30) NOT NULL
        CHECK (target_instagram_id ~ '^[a-z0-9._]{1,30}$'),
    operation_slot_map JSONB NOT NULL
        CHECK (public.analysis_v2_valid_test_operation_slot_map(operation_slot_map)),
    policy_hash VARCHAR(64) NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

ALTER TABLE public.analysis_v2_provider_execution_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_provider_execution_policies FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_provider_execution_policies
    FROM PUBLIC, anon, authenticated, service_role;

COMMENT ON TABLE public.analysis_v2_provider_execution_policies IS
    'Immutable operation-level credential policy for an explicitly authorized signed V2 test request; absence means the normal single-slot path.';
COMMENT ON COLUMN public.analysis_v2_provider_execution_policies.operation_slot_map IS
    'Slot labels only. API tokens are never stored in Postgres.';

CREATE OR REPLACE FUNCTION public.bind_analysis_v2_authorized_test_provider_policy(
    p_request_id UUID,
    p_user_id UUID,
    p_entitlement_jti_hash TEXT,
    p_target_instagram_id TEXT,
    p_policy_version TEXT,
    p_operation_slot_map JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_request public.analysis_requests%ROWTYPE;
    v_existing public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_policy_hash TEXT;
BEGIN
    IF p_request_id IS NULL
       OR p_user_id IS NULL
       OR p_entitlement_jti_hash IS NULL
       OR p_entitlement_jti_hash !~ '^[a-f0-9]{64}$'
       OR p_target_instagram_id IS NULL
       OR p_target_instagram_id !~ '^[a-z0-9._]{1,30}$'
       OR p_policy_version IS DISTINCT FROM 'authorized-free-e2e-v1'
       OR NOT public.analysis_v2_valid_test_operation_slot_map(p_operation_slot_map) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT analysis_request.*
    INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;

    IF NOT FOUND
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.user_id IS DISTINCT FROM p_user_id
       OR v_request.plan_access_mode_snapshot IS DISTINCT FROM 'test_entitlement'
       OR v_request.test_entitlement_jti_hash IS DISTINCT FROM p_entitlement_jti_hash
       OR pg_catalog.lower(v_request.target_instagram_id)
            IS DISTINCT FROM p_target_instagram_id THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SCOPE_MISMATCH',
            ERRCODE = 'P0001';
    END IF;

    v_policy_hash := pg_catalog.encode(
        extensions.digest(
            pg_catalog.convert_to(
                p_policy_version || E'\n'
                || p_target_instagram_id || E'\n'
                || p_operation_slot_map::TEXT,
                'UTF8'
            ),
            'sha256'
        ),
        'hex'
    );

    SELECT policy.*
    INTO v_existing
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id
    FOR UPDATE;

    IF FOUND THEN
        IF v_existing.mode IS DISTINCT FROM 'test_operation_split'
           OR v_existing.policy_version IS DISTINCT FROM p_policy_version
           OR v_existing.entitlement_jti_hash IS DISTINCT FROM p_entitlement_jti_hash
           OR v_existing.target_instagram_id IS DISTINCT FROM p_target_instagram_id
           OR v_existing.operation_slot_map IS DISTINCT FROM p_operation_slot_map
           OR v_existing.policy_hash IS DISTINCT FROM v_policy_hash THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'mode', v_existing.mode,
            'policyVersion', v_existing.policy_version,
            'operationSlots', v_existing.operation_slot_map,
            'policyHash', v_existing.policy_hash
        );
    END IF;

    IF v_request.status IS DISTINCT FROM 'pending'
       OR v_request.background_processing IS DISTINCT FROM FALSE
       OR EXISTS (
            SELECT 1
            FROM public.analysis_pipeline_jobs AS job
            WHERE job.request_id = p_request_id
              AND (job.status <> 'pending' OR job.dispatch_state <> 'pending')
       )
       OR EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = p_request_id
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_TOO_LATE', ERRCODE = 'P0001';
    END IF;

    INSERT INTO public.analysis_v2_provider_execution_policies (
        request_id,
        mode,
        policy_version,
        entitlement_jti_hash,
        target_instagram_id,
        operation_slot_map,
        policy_hash
    ) VALUES (
        p_request_id,
        'test_operation_split',
        p_policy_version,
        p_entitlement_jti_hash,
        p_target_instagram_id,
        p_operation_slot_map,
        v_policy_hash
    ) RETURNING * INTO v_existing;

    RETURN pg_catalog.jsonb_build_object(
        'mode', v_existing.mode,
        'policyVersion', v_existing.policy_version,
        'operationSlots', v_existing.operation_slot_map,
        'policyHash', v_existing.policy_hash
    );
END;
$$;

REVOKE ALL ON FUNCTION public.bind_analysis_v2_authorized_test_provider_policy(
    UUID, UUID, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.consume_analysis_v2_authorized_test_entitlement(
    p_preflight_id UUID,
    p_user_id UUID,
    p_selected_plan_id TEXT,
    p_entitlement_jti_hash TEXT,
    p_admission_token UUID,
    p_target_instagram_id TEXT,
    p_policy_version TEXT,
    p_operation_slot_map JSONB
)
RETURNS TABLE(
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT,
    request_status TEXT,
    background_processing BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_consumed RECORD;
BEGIN
    SELECT consumed.*
    INTO v_consumed
    FROM public.consume_analysis_v2_test_entitlement(
        p_preflight_id,
        p_user_id,
        p_selected_plan_id,
        p_entitlement_jti_hash,
        p_admission_token
    ) AS consumed;

    PERFORM public.bind_analysis_v2_authorized_test_provider_policy(
        v_consumed.request_id,
        p_user_id,
        p_entitlement_jti_hash,
        p_target_instagram_id,
        p_policy_version,
        p_operation_slot_map
    );

    RETURN QUERY SELECT
        v_consumed.request_id::UUID,
        v_consumed.created::BOOLEAN,
        v_consumed.initial_job_key::TEXT,
        v_consumed.request_status::TEXT,
        v_consumed.background_processing::BOOLEAN;
END;
$$;

REVOKE ALL ON FUNCTION public.consume_analysis_v2_authorized_test_entitlement(
    UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.consume_analysis_v2_authorized_test_entitlement(
    UUID, UUID, TEXT, TEXT, UUID, TEXT, TEXT, JSONB
) TO service_role;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_collection_context_with_policy(
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
    v_now TIMESTAMP WITH TIME ZONE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_detailed_limit INTEGER;
BEGIN
    IF p_request_id IS NULL
       OR p_job_key IS NULL
       OR pg_catalog.char_length(p_job_key) NOT BETWEEN 1 AND 160
       OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_claim_token IS NULL
       OR p_job_input_hash IS NULL
       OR p_job_input_hash !~ '^[a-f0-9]{64}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id
    FOR UPDATE;

    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
    FOR UPDATE;

    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;

    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id;

    v_now := pg_catalog.clock_timestamp();
    IF v_preflight.id IS NULL
       OR v_preflight.status <> 'consumed'
       OR v_preflight.target_followers_count IS NULL
       OR v_preflight.target_following_count IS NULL
       OR v_preflight.target_instagram_id IS DISTINCT FROM
            pg_catalog.lower(v_request.target_instagram_id)
       OR v_preflight.excluded_instagram_id IS DISTINCT FROM
            v_request.excluded_instagram_id
       OR v_preflight.access_mode IS DISTINCT FROM v_request.plan_access_mode_snapshot
       OR v_request.id IS NULL
       OR v_request.pipeline_version IS DISTINCT FROM 'v2'
       OR v_request.status NOT IN ('pending', 'processing')
       OR v_request.plan_access_mode_snapshot NOT IN ('production', 'test_entitlement')
       OR (v_request.plan_access_mode_snapshot = 'production' AND v_policy.request_id IS NOT NULL)
       OR (v_policy.request_id IS NOT NULL
            AND v_policy.target_instagram_id IS DISTINCT FROM
                pg_catalog.lower(v_request.target_instagram_id))
       OR v_request.selected_plan_id_snapshot NOT IN ('basic', 'standard', 'plus')
       OR v_request.analysis_scope_snapshot IS NULL
       OR v_job.request_id IS NULL
       OR v_job.status <> 'processing'
       OR v_job.input_hash IS DISTINCT FROM p_job_input_hash
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at IS NULL
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;

    v_detailed_limit := (v_request.analysis_scope_snapshot->>'detailedMutualLimit')::INTEGER;
    IF v_detailed_limit NOT IN (300, 600, 900)
       OR v_preflight.target_followers_count > (
            v_request.analysis_scope_snapshot->'relationshipCapacity'->>'followers'
       )::INTEGER
       OR v_preflight.target_following_count > (
            v_request.analysis_scope_snapshot->'relationshipCapacity'->>'following'
       )::INTEGER THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_COLLECTION_CONTEXT_INVALID', ERRCODE = 'P0001';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'requestId', v_request.id,
        'targetUsername', pg_catalog.lower(v_request.target_instagram_id),
        'excludedUsername', v_request.excluded_instagram_id,
        'accessMode', v_request.plan_access_mode_snapshot,
        'providerExecutionPolicy', CASE WHEN v_policy.request_id IS NULL THEN NULL ELSE
            pg_catalog.jsonb_build_object(
                'mode', v_policy.mode,
                'policyVersion', v_policy.policy_version,
                'operationSlots', v_policy.operation_slot_map
            )
        END,
        'planId', v_request.selected_plan_id_snapshot,
        'followersDeclaredCount', v_preflight.target_followers_count,
        'followingDeclaredCount', v_preflight.target_following_count,
        'detailedMutualLimit', v_detailed_limit
    );
END;
$$;

REVOKE ALL ON FUNCTION public.load_analysis_v2_collection_context_with_policy(
    UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_collection_context_with_policy(
    UUID, TEXT, UUID, TEXT
) TO service_role;

COMMENT ON FUNCTION public.load_analysis_v2_collection_context_with_policy(
    UUID, TEXT, UUID, TEXT
) IS 'Returns the immutable V2 target, access mode, optional authorized test credential policy, exclusion, selected plan, and exact relationship counts only for the exact live collection job claim.';

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_provider_run(
    p_request_id UUID,
    p_job_key TEXT,
    p_claim_token UUID,
    p_operation_key TEXT,
    p_input_hash TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_policy public.analysis_v2_provider_execution_policies%ROWTYPE;
    v_operation_kind TEXT;
BEGIN
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;

    IF EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = p_request_id AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED', ERRCODE = 'P0001';
    END IF;

    SELECT policy.* INTO v_policy
    FROM public.analysis_v2_provider_execution_policies AS policy
    WHERE policy.request_id = p_request_id;
    IF FOUND THEN
        v_operation_kind := pg_catalog.split_part(p_operation_key, ':', 1);
        IF v_policy.operation_slot_map->>v_operation_kind
            IS DISTINCT FROM p_credential_slot THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_AUTHORIZED_TEST_POLICY_SLOT_MISMATCH',
                ERRCODE = 'P0001';
        END IF;
    END IF;

    RETURN public.analysis_v2_reserve_provider_run_internal(
        p_request_id, p_job_key, p_claim_token, p_operation_key, p_input_hash,
        p_logical_provider, p_actor_id, p_credential_slot, p_max_charge_usd,
        p_reservation_token
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, UUID
) TO service_role;
