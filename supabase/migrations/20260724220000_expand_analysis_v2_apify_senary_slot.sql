-- Add one same-named credential identity to the general Analysis V2 worker.
-- The separate profile-repair microcanary retains its historical five-slot policy.

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        p_slot IN (
            'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary'
        ),
        FALSE
    );
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- The terminal-safety RPC predated the shared validator and retained a five-slot
-- literal. Recreate it against the helper so a failed senary-backed E2E can use
-- the same durable, service-only cleanup path without broadening any canary RPC.
CREATE OR REPLACE FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    p_reservation_token UUID,
    p_run_id TEXT,
    p_logical_provider TEXT,
    p_actor_id TEXT,
    p_credential_slot TEXT,
    p_max_charge_usd NUMERIC,
    p_status TEXT,
    p_actual_usage_usd NUMERIC
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF p_reservation_token IS NULL OR p_run_id !~ '^[A-Za-z0-9]{8,64}$'
       OR p_logical_provider NOT IN ('apify', 'coderx')
       OR p_actor_id !~ '^[A-Za-z0-9][A-Za-z0-9._~/-]{2,199}$'
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd IS NULL OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12)
       OR p_status NOT IN ('succeeded', 'failed', 'aborted', 'timed_out')
       OR (p_actual_usage_usd IS NOT NULL AND (
            p_actual_usage_usd NOT BETWEEN 0 AND 100000
            OR p_actual_usage_usd <> pg_catalog.round(p_actual_usage_usd, 12)
       )) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT provider_run.* INTO v_run
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.reservation_token = p_reservation_token
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_run.run_id IS DISTINCT FROM p_run_id
       OR v_run.logical_provider IS DISTINCT FROM p_logical_provider
       OR v_run.actor_id IS DISTINCT FROM p_actor_id
       OR v_run.credential_slot IS DISTINCT FROM p_credential_slot
       OR v_run.max_charge_usd IS DISTINCT FROM p_max_charge_usd
       OR p_actual_usage_usd > v_run.max_charge_usd + 0.000000001 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.analysis_v2_provider_cleanup_intents AS intent
        WHERE intent.request_id = v_run.request_id AND intent.completed_at IS NULL
    ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY', ERRCODE = 'P0001';
    END IF;

    IF v_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out') THEN
        IF v_run.status IS DISTINCT FROM p_status
           OR (p_actual_usage_usd IS NOT NULL
               AND v_run.actual_usage_usd IS NOT NULL
               AND v_run.actual_usage_usd IS DISTINCT FROM p_actual_usage_usd) THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
        END IF;
        IF p_actual_usage_usd IS NOT NULL AND v_run.actual_usage_usd IS NULL THEN
            UPDATE public.analysis_v2_provider_runs AS provider_run
            SET actual_usage_usd = p_actual_usage_usd,
                usage_reconciled_at = v_now, updated_at = v_now
            WHERE provider_run.reservation_token = p_reservation_token
            RETURNING provider_run.* INTO v_run;
        END IF;
        RETURN public.analysis_v2_provider_run_json(v_run);
    END IF;
    IF v_run.status <> 'running' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_CONFLICT', ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET status = p_status,
        actual_usage_usd = p_actual_usage_usd,
        terminalized_at = v_now,
        usage_reconciled_at = CASE
            WHEN p_actual_usage_usd IS NULL THEN NULL ELSE v_now
        END,
        updated_at = v_now
    WHERE provider_run.reservation_token = p_reservation_token
    RETURNING provider_run.* INTO v_run;
    RETURN public.analysis_v2_provider_run_json(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_analysis_v2_provider_run_for_cleanup(
    UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, NUMERIC
) TO service_role;

COMMENT ON FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT) IS
    'Exact same-named credential identities supported by the general Analysis V2 worker; no token pooling or aliases.';

CREATE OR REPLACE FUNCTION public.analysis_v2_valid_apify_secret_ref_prune_slots(
    p_slots TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
    SELECT COALESCE(
        pg_catalog.cardinality(p_slots) BETWEEN 1 AND 5
        AND pg_catalog.cardinality(p_slots) = (
            SELECT pg_catalog.count(DISTINCT requested.slot)
            FROM pg_catalog.unnest(p_slots) AS requested(slot)
        )
        AND NOT EXISTS (
            SELECT 1
            FROM pg_catalog.unnest(p_slots) AS requested(slot)
            WHERE requested.slot IS NULL
               OR requested.slot = 'primary'
               OR NOT public.analysis_v2_valid_apify_credential_slot(
                    requested.slot
               )
        ),
        FALSE
    );
$$;

CREATE OR REPLACE FUNCTION public.analysis_v2_normalize_apify_secret_ref_prune_slots(
    p_slots TEXT[]
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
STRICT
SET search_path = ''
AS $$
    SELECT pg_catalog.array_agg(requested.slot ORDER BY requested.slot)
    FROM pg_catalog.unnest(p_slots) AS requested(slot);
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_valid_apify_secret_ref_prune_slots(TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.analysis_v2_normalize_apify_secret_ref_prune_slots(TEXT[])
    FROM PUBLIC, anon, authenticated, service_role;

-- One permanent row is the serialization point shared by destructive pruning
-- and both manual canary reservation paths. Clearing updates the row back to
-- the constrained inactive shape; no privileged RPC ever deletes it.
CREATE TABLE public.analysis_v2_apify_secret_ref_prune_guard (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE,
    drop_slots TEXT[],
    owner_source_commit_sha VARCHAR(40),
    fenced_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT analysis_v2_apify_secret_ref_prune_guard_singleton_check CHECK (
        singleton IS TRUE
    ),
    CONSTRAINT analysis_v2_apify_secret_ref_prune_guard_state_check CHECK (
        (
            drop_slots IS NULL
            AND owner_source_commit_sha IS NULL
            AND fenced_at IS NULL
        ) OR (
            public.analysis_v2_valid_apify_secret_ref_prune_slots(drop_slots)
            AND drop_slots =
                public.analysis_v2_normalize_apify_secret_ref_prune_slots(
                    drop_slots
                )
            AND owner_source_commit_sha ~ '^[0-9a-f]{40}$'
            AND fenced_at IS NOT NULL
            AND updated_at >= fenced_at
        )
    )
);

INSERT INTO public.analysis_v2_apify_secret_ref_prune_guard(singleton)
VALUES (TRUE);

ALTER TABLE public.analysis_v2_apify_secret_ref_prune_guard
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_apify_secret_ref_prune_guard
    FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_apify_secret_ref_prune_guard
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.acquire_analysis_v2_apify_secret_ref_prune_fence(
    p_drop_slots TEXT[],
    p_owner_source_commit_sha TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_drop_slots TEXT[];
    v_guard public.analysis_v2_apify_secret_ref_prune_guard%ROWTYPE;
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
BEGIN
    IF NOT public.analysis_v2_valid_apify_secret_ref_prune_slots(p_drop_slots)
       OR p_owner_source_commit_sha IS NULL
       OR p_owner_source_commit_sha !~ '^[0-9a-f]{40}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_drop_slots :=
        public.analysis_v2_normalize_apify_secret_ref_prune_slots(p_drop_slots);

    SELECT guard.*
    INTO v_guard
    FROM public.analysis_v2_apify_secret_ref_prune_guard AS guard
    WHERE guard.singleton IS TRUE
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_GUARD_CORRUPT',
            ERRCODE = 'P0001';
    END IF;

    IF v_guard.drop_slots IS NOT NULL THEN
        IF v_guard.drop_slots IS DISTINCT FROM v_drop_slots
           OR v_guard.owner_source_commit_sha
                IS DISTINCT FROM p_owner_source_commit_sha THEN
            RAISE EXCEPTION USING
                MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_CONFLICT',
                ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'active', TRUE,
            'acquired', FALSE,
            'dropSlots', pg_catalog.to_jsonb(v_drop_slots)
        );
    END IF;

    UPDATE public.analysis_v2_apify_secret_ref_prune_guard AS guard
    SET drop_slots = v_drop_slots,
        owner_source_commit_sha = p_owner_source_commit_sha,
        fenced_at = v_now,
        updated_at = v_now
    WHERE guard.singleton IS TRUE;

    RETURN pg_catalog.jsonb_build_object(
        'active', TRUE,
        'acquired', TRUE,
        'dropSlots', pg_catalog.to_jsonb(v_drop_slots)
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.load_analysis_v2_apify_secret_ref_prune_fence()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_guard public.analysis_v2_apify_secret_ref_prune_guard%ROWTYPE;
BEGIN
    SELECT guard.*
    INTO v_guard
    FROM public.analysis_v2_apify_secret_ref_prune_guard AS guard
    WHERE guard.singleton IS TRUE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_GUARD_CORRUPT',
            ERRCODE = 'P0001';
    END IF;
    RETURN pg_catalog.jsonb_build_object(
        'active', v_guard.drop_slots IS NOT NULL,
        'dropSlots', pg_catalog.to_jsonb(v_guard.drop_slots),
        'ownerSourceCommitSha', v_guard.owner_source_commit_sha
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.clear_analysis_v2_apify_secret_ref_prune_fence(
    p_drop_slots TEXT[],
    p_expected_owner_source_commit_sha TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_drop_slots TEXT[];
    v_guard public.analysis_v2_apify_secret_ref_prune_guard%ROWTYPE;
BEGIN
    IF NOT public.analysis_v2_valid_apify_secret_ref_prune_slots(p_drop_slots)
       OR p_expected_owner_source_commit_sha IS NULL
       OR p_expected_owner_source_commit_sha !~ '^[0-9a-f]{40}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_drop_slots :=
        public.analysis_v2_normalize_apify_secret_ref_prune_slots(p_drop_slots);

    SELECT guard.*
    INTO v_guard
    FROM public.analysis_v2_apify_secret_ref_prune_guard AS guard
    WHERE guard.singleton IS TRUE
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_GUARD_CORRUPT',
            ERRCODE = 'P0001';
    END IF;
    IF v_guard.drop_slots IS NULL THEN
        RETURN pg_catalog.jsonb_build_object(
            'active', FALSE,
            'cleared', FALSE,
            'dropSlots', pg_catalog.to_jsonb(v_drop_slots)
        );
    END IF;
    IF v_guard.drop_slots IS DISTINCT FROM v_drop_slots
       OR v_guard.owner_source_commit_sha
            IS DISTINCT FROM p_expected_owner_source_commit_sha THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    UPDATE public.analysis_v2_apify_secret_ref_prune_guard AS guard
    SET drop_slots = NULL,
        owner_source_commit_sha = NULL,
        fenced_at = NULL,
        updated_at = pg_catalog.clock_timestamp()
    WHERE guard.singleton IS TRUE;

    RETURN pg_catalog.jsonb_build_object(
        'active', FALSE,
        'cleared', TRUE,
        'dropSlots', pg_catalog.to_jsonb(v_drop_slots)
    );
END;
$$;

REVOKE ALL ON FUNCTION public.acquire_analysis_v2_apify_secret_ref_prune_fence(
    TEXT[], TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.acquire_analysis_v2_apify_secret_ref_prune_fence(
    TEXT[], TEXT
) TO service_role;
REVOKE ALL ON FUNCTION public.load_analysis_v2_apify_secret_ref_prune_fence()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.load_analysis_v2_apify_secret_ref_prune_fence()
    TO service_role;
REVOKE ALL ON FUNCTION public.clear_analysis_v2_apify_secret_ref_prune_fence(
    TEXT[], TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.clear_analysis_v2_apify_secret_ref_prune_fence(
    TEXT[], TEXT
) TO service_role;

-- Preserve the reviewed canary implementations behind private names and put
-- the durable guard in front of every reservation attempt, including retries.
ALTER FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, TEXT, UUID
) RENAME TO analysis_v2_profile_repair_canary_reserve_unfenced;
REVOKE ALL ON FUNCTION public.analysis_v2_profile_repair_canary_reserve_unfenced(
    UUID, INTEGER, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_credential_slot TEXT,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_guard public.analysis_v2_apify_secret_ref_prune_guard%ROWTYPE;
BEGIN
    SELECT guard.*
    INTO v_guard
    FROM public.analysis_v2_apify_secret_ref_prune_guard AS guard
    WHERE guard.singleton IS TRUE
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_GUARD_CORRUPT',
            ERRCODE = 'P0001';
    END IF;
    IF v_guard.drop_slots IS NOT NULL
       AND p_credential_slot = ANY(v_guard.drop_slots) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCED',
            ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_profile_repair_canary_reserve_unfenced(
        p_source_request_id,
        p_repetition,
        p_credential_slot,
        p_reservation_token
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, TEXT, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_profile_repair_canary_run(
    UUID, INTEGER, TEXT, UUID
) TO service_role;

ALTER FUNCTION public.reserve_analysis_v2_profile_provider_canary_run(
    UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    INTEGER, TEXT, BOOLEAN, UUID
) RENAME TO analysis_v2_profile_provider_canary_reserve_unfenced;
REVOKE ALL ON FUNCTION public.analysis_v2_profile_provider_canary_reserve_unfenced(
    UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    INTEGER, TEXT, BOOLEAN, UUID
) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.reserve_analysis_v2_profile_provider_canary_run(
    p_source_request_id UUID,
    p_repetition INTEGER,
    p_source_run_count INTEGER,
    p_candidate_count INTEGER,
    p_unique_candidate_count INTEGER,
    p_public_candidate_count INTEGER,
    p_incomplete_candidate_count INTEGER,
    p_unavailable_candidate_count INTEGER,
    p_primary_success_candidate_count INTEGER,
    p_critical_candidate_count INTEGER,
    p_ordered_set_hmac TEXT,
    p_restricted_access_verified BOOLEAN,
    p_reservation_token UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_guard public.analysis_v2_apify_secret_ref_prune_guard%ROWTYPE;
BEGIN
    SELECT guard.*
    INTO v_guard
    FROM public.analysis_v2_apify_secret_ref_prune_guard AS guard
    WHERE guard.singleton IS TRUE
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_GUARD_CORRUPT',
            ERRCODE = 'P0001';
    END IF;
    IF v_guard.drop_slots IS NOT NULL
       AND EXISTS (
            SELECT 1
            FROM public.analysis_v2_provider_runs AS source_run
            JOIN public.analysis_v2_provider_execution_policies AS execution_policy
              ON execution_policy.request_id = source_run.request_id
            WHERE source_run.request_id = p_source_request_id
              AND source_run.status = 'succeeded'
              AND source_run.run_id ~ '^[A-Za-z0-9]{8,64}$'
              AND source_run.actor_id = 'apify/instagram-profile-scraper'
              AND source_run.job_key ~ '^track:profiles:batch:(?:0|[1-7])$'
              AND source_run.operation_key ~
                    '^profile-fallback:[0-9a-f]{64}$'
              AND execution_policy.mode = 'test_operation_split'
              AND execution_policy.policy_version = 'authorized-free-e2e-v1'
              AND execution_policy.operation_slot_map->>'profile-fallback'
                    = source_run.credential_slot
              AND source_run.credential_slot = ANY(v_guard.drop_slots)
       ) THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCED',
            ERRCODE = 'P0001';
    END IF;
    RETURN public.analysis_v2_profile_provider_canary_reserve_unfenced(
        p_source_request_id,
        p_repetition,
        p_source_run_count,
        p_candidate_count,
        p_unique_candidate_count,
        p_public_candidate_count,
        p_incomplete_candidate_count,
        p_unavailable_candidate_count,
        p_primary_success_candidate_count,
        p_critical_candidate_count,
        p_ordered_set_hmac,
        p_restricted_access_verified,
        p_reservation_token
    );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_analysis_v2_profile_provider_canary_run(
    UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    INTEGER, TEXT, BOOLEAN, UUID
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.reserve_analysis_v2_profile_provider_canary_run(
    UUID, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER, INTEGER,
    INTEGER, TEXT, BOOLEAN, UUID
) TO service_role;

-- Return authoritative, bounded evidence before a deploy intentionally removes
-- non-primary Secret Manager references. Official profile-provider canary runs
-- use primary, but cleanup of their eight retained source runs uses each source
-- run's stored credential slot. Both canary journals must therefore be drained.
CREATE OR REPLACE FUNCTION public.analysis_v2_apify_secret_ref_prune_readiness(
    p_drop_slots TEXT[],
    p_owner_source_commit_sha TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_drop_slots TEXT[];
    v_guard public.analysis_v2_apify_secret_ref_prune_guard%ROWTYPE;
    v_active_request_runs BIGINT;
    v_unreconciled_request_runs BIGINT;
    v_active_preflight_runs BIGINT;
    v_unreconciled_preflight_runs BIGINT;
    v_active_profile_repair_canary_runs BIGINT;
    v_unreconciled_profile_repair_canary_runs BIGINT;
    v_active_requests BIGINT;
    v_active_preflights BIGINT;
    v_active_drop_slot_policies BIGINT;
    v_incomplete_profile_provider_canary_cleanups BIGINT;
BEGIN
    IF NOT public.analysis_v2_valid_apify_secret_ref_prune_slots(p_drop_slots)
       OR p_owner_source_commit_sha IS NULL
       OR p_owner_source_commit_sha !~ '^[0-9a-f]{40}$' THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_INVALID',
            ERRCODE = 'P0001';
    END IF;
    v_drop_slots :=
        public.analysis_v2_normalize_apify_secret_ref_prune_slots(p_drop_slots);

    SELECT guard.*
    INTO v_guard
    FROM public.analysis_v2_apify_secret_ref_prune_guard AS guard
    WHERE guard.singleton IS TRUE
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_GUARD_CORRUPT',
            ERRCODE = 'P0001';
    END IF;
    IF v_guard.drop_slots IS DISTINCT FROM v_drop_slots
       OR v_guard.owner_source_commit_sha
            IS DISTINCT FROM p_owner_source_commit_sha THEN
        RAISE EXCEPTION USING
            MESSAGE = 'ANALYSIS_V2_APIFY_SECRET_REF_PRUNE_FENCE_CONFLICT',
            ERRCODE = 'P0001';
    END IF;

    SELECT pg_catalog.count(*)
    INTO v_active_request_runs
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.credential_slot = ANY(v_drop_slots)
      AND provider_run.status IN ('starting', 'running');

    SELECT pg_catalog.count(*)
    INTO v_unreconciled_request_runs
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.credential_slot = ANY(v_drop_slots)
      AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
      AND provider_run.usage_reconciled_at IS NULL;

    SELECT pg_catalog.count(*)
    INTO v_active_preflight_runs
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.credential_slot = ANY(v_drop_slots)
      AND provider_run.status IN ('starting', 'running');

    SELECT pg_catalog.count(*)
    INTO v_unreconciled_preflight_runs
    FROM public.analysis_preflight_provider_runs AS provider_run
    WHERE provider_run.credential_slot = ANY(v_drop_slots)
      AND provider_run.status IN ('succeeded', 'failed', 'aborted', 'timed_out')
      AND provider_run.usage_reconciled_at IS NULL;

    SELECT pg_catalog.count(*)
    INTO v_active_profile_repair_canary_runs
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.credential_slot = ANY(v_drop_slots)
      AND canary_run.state IN ('starting', 'running', 'ambiguous');

    SELECT pg_catalog.count(*)
    INTO v_unreconciled_profile_repair_canary_runs
    FROM public.analysis_v2_profile_repair_canary_runs AS canary_run
    WHERE canary_run.credential_slot = ANY(v_drop_slots)
      AND canary_run.state IN ('succeeded', 'failed')
      AND canary_run.usage_reconciled_at IS NULL;

    -- A provider reservation can still be created before any provider ledger
    -- row exists. Reserve is fenced by an active request, while target-profile
    -- acquisition is fenced by either the main preflight state or the
    -- independent fresh-admission state. Requiring global quiet state prevents
    -- an old drained worker invocation from materializing a drop-slot run after
    -- this point-in-time audit.
    SELECT pg_catalog.count(*)
    INTO v_active_requests
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.status IN ('pending', 'processing');

    SELECT pg_catalog.count(*)
    INTO v_active_preflights
    FROM public.analysis_preflights AS preflight
    WHERE preflight.status IN ('pending', 'processing')
       OR (
            preflight.status = 'ready'
            AND preflight.admission_status IN ('pending', 'processing')
       );

    -- Keep the policy-specific count as diagnostic evidence. Terminal requests
    -- retain immutable policies but can no longer reserve provider runs.
    SELECT pg_catalog.count(*)
    INTO v_active_drop_slot_policies
    FROM public.analysis_v2_provider_execution_policies AS policy
    JOIN public.analysis_requests AS analysis_request
      ON analysis_request.id = policy.request_id
    WHERE analysis_request.status IN ('pending', 'processing')
      AND EXISTS (
          SELECT 1
          FROM pg_catalog.jsonb_each_text(
              policy.operation_slot_map
          ) AS operation_slot(operation_kind, credential_slot)
          WHERE operation_slot.credential_slot = ANY(v_drop_slots)
      );

    SELECT pg_catalog.count(*)
    INTO v_incomplete_profile_provider_canary_cleanups
    FROM public.analysis_v2_profile_provider_canary_experiments AS experiment
    WHERE (
        experiment.source_kvs_cleanup_state IS DISTINCT FROM 'verified_absent'
        OR experiment.source_dataset_cleanup_state IS DISTINCT FROM 'verified_absent'
        OR experiment.source_request_queue_cleanup_state
            IS DISTINCT FROM 'verified_absent'
    )
      AND EXISTS (
          SELECT 1
          FROM public.analysis_v2_provider_runs AS source_run
          JOIN public.analysis_v2_provider_execution_policies AS execution_policy
            ON execution_policy.request_id = source_run.request_id
          WHERE source_run.request_id = experiment.source_request_id
            AND source_run.status = 'succeeded'
            AND source_run.run_id ~ '^[A-Za-z0-9]{8,64}$'
            AND source_run.actor_id = 'apify/instagram-profile-scraper'
            AND source_run.job_key ~ '^track:profiles:batch:(?:0|[1-7])$'
            AND source_run.operation_key ~ '^profile-fallback:[0-9a-f]{64}$'
            AND execution_policy.mode = 'test_operation_split'
            AND execution_policy.policy_version = 'authorized-free-e2e-v1'
            AND execution_policy.operation_slot_map->>'profile-fallback'
                = source_run.credential_slot
            AND source_run.credential_slot = ANY(v_drop_slots)
      );

    RETURN pg_catalog.jsonb_build_object(
        'ready',
            v_active_request_runs = 0
            AND v_unreconciled_request_runs = 0
            AND v_active_preflight_runs = 0
            AND v_unreconciled_preflight_runs = 0
            AND v_active_profile_repair_canary_runs = 0
            AND v_unreconciled_profile_repair_canary_runs = 0
            AND v_active_requests = 0
            AND v_active_preflights = 0
            AND v_active_drop_slot_policies = 0
            AND v_incomplete_profile_provider_canary_cleanups = 0,
        'dropSlots', pg_catalog.to_jsonb(v_drop_slots),
        'activeRequestRuns', v_active_request_runs,
        'unreconciledRequestRuns', v_unreconciled_request_runs,
        'activePreflightRuns', v_active_preflight_runs,
        'unreconciledPreflightRuns', v_unreconciled_preflight_runs,
        'activeProfileRepairCanaryRuns', v_active_profile_repair_canary_runs,
        'unreconciledProfileRepairCanaryRuns',
            v_unreconciled_profile_repair_canary_runs,
        'activeRequests', v_active_requests,
        'activePreflights', v_active_preflights,
        'activeDropSlotPolicies', v_active_drop_slot_policies,
        'incompleteProfileProviderCanaryCleanups',
            v_incomplete_profile_provider_canary_cleanups
    );
END;
$$;

REVOKE ALL ON FUNCTION public.analysis_v2_apify_secret_ref_prune_readiness(
    TEXT[], TEXT
)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.analysis_v2_apify_secret_ref_prune_readiness(
    TEXT[], TEXT
)
    TO service_role;

COMMENT ON FUNCTION public.analysis_v2_apify_secret_ref_prune_readiness(
    TEXT[], TEXT
) IS
    'Service-only global quiet-work, drop-slot ledger, policy, and source-cleanup evidence before a primary-only Cloud Run promotion.';
