import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getAnalysisPlan, PLAN_IDS, type PlanId } from '@/lib/domain/analysis/plan-catalog';
import { getBetaApifyOperationBudgetCatalog } from './beta-apify-operation-budget';
import { profileMaximumCharge } from './v2-apify-operation-costs';
import { ANALYSIS_V2_PROFILE_BATCH_LIMIT } from './v2-dag-planner';

const migrationUrls = [
    new URL(
        '../../../supabase/migrations/20260802010000_add_betatest_apify_credit_pool.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802010100_validate_betatest_entry_channel_constraints.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802020000_add_betatest_apify_credit_reservations.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802030000_bind_betatest_provider_policy.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802030100_validate_betatest_provider_policy.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802040000_settle_betatest_apify_credit_reservations.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802050000_harden_betatest_apify_credit_capacity.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802060000_expose_betatest_frozen_provider_budgets.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802070000_wire_betatest_preflight_credit_runtime.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802080000_admit_betatest_apify_plan.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802090000_settle_betatest_terminal_credit.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802100000_harden_betatest_entry_lifecycle.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802100100_harden_betatest_entry_lifecycle_runtime.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802100200_validate_betatest_entry_lifecycle.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802100300_allow_betatest_prepare_retry_exhaustion_terminal_state.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802100400_terminalize_betatest_prepare_retry_exhaustion_runtime.sql',
        import.meta.url
    ),
    new URL(
        '../../../supabase/migrations/20260802100500_validate_betatest_prepare_retry_exhaustion.sql',
        import.meta.url
    ),
];
const migrations = migrationUrls.map(url => readFileSync(url, 'utf8'));
const allAuthenticatedAccessMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260802104141_enable_betatest_all_authenticated_access.sql',
    import.meta.url
), 'utf8');

const USER_ID = '10000000-0000-4000-8000-000000000001';
const PREFLIGHT_ID = '20000000-0000-4000-8000-000000000001';
const REQUEST_ID = '30000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN = '40000000-0000-4000-8000-000000000001';
const CLAIM_TOKEN_B = '40000000-0000-4000-8000-000000000002';
const CLAIM_TOKEN_C = '40000000-0000-4000-8000-000000000003';
const PREPARE_TOKEN = '41000000-0000-4000-8000-000000000001';
const PREPARE_CLAIM_TOKEN = '42000000-0000-4000-8000-000000000001';
const RESERVATION_TOKEN = '50000000-0000-4000-8000-000000000001';
const DISPATCH_TOKEN = '70000000-0000-4000-8000-000000000001';
const ADMISSION_TOKEN = '80000000-0000-4000-8000-000000000001';
const PROVIDER_RUN_ID = 'BetaRun123456';
const TARGET = 'target.user';
const INPUT_HASH = 'a'.repeat(64);
const OTHER_INPUT_HASH = 'b'.repeat(64);
const DIGEST = 'c'.repeat(64);
const AUDIT_HASH = 'd'.repeat(64);
const JTI_HASH = 'e'.repeat(64);
const BETA_SLOTS = [
    'primary',
    'tertiary',
    'quaternary',
    'quinary',
    'senary',
    'septenary',
] as const;
const OPERATIONS = [
    'target-profile',
    'relationship-followers',
    'relationship-following',
    'profile-fallback',
    'profile-repair',
    'target-likers',
    'target-comments',
    'candidate-likers',
] as const;

const betaSlots: Record<string, string> = {
    'target-profile': 'primary',
    'relationship-followers': 'tertiary',
    'relationship-following': 'quaternary',
    'profile-fallback': 'quinary',
    'profile-repair': 'septenary',
    'target-likers': 'senary',
    'target-comments': 'tertiary',
    'candidate-likers': 'quaternary',
};
const betaBudgets: Record<string, number> = Object.fromEntries(
    OPERATIONS.map(operation => [
        operation,
        operation === 'target-profile' ? 0.0052 : 0.02,
    ])
);
const legacySlots = {
    'target-profile': 'primary',
    'relationship-followers': 'senary',
    'relationship-following': 'secondary',
    'profile-fallback': 'primary',
    'target-likers': 'quaternary',
    'target-comments': 'primary',
    'candidate-likers': 'quinary',
};

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

CREATE SCHEMA auth;
CREATE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE SET search_path = ''
AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;

CREATE FUNCTION public.analysis_v2_valid_apify_credential_slot(p_slot TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(p_slot IN (
        'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary'
    ), FALSE)
$$;

CREATE FUNCTION public.analysis_v2_valid_test_operation_slot_map(p_map JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_map) = 'object'
        AND p_map ?& ARRAY[
            'target-profile', 'relationship-followers', 'relationship-following',
            'profile-fallback', 'target-likers', 'target-comments', 'candidate-likers'
        ]
        AND p_map - ARRAY[
            'target-profile', 'relationship-followers', 'relationship-following',
            'profile-fallback', 'target-likers', 'target-comments', 'candidate-likers'
        ] = '{}'::JSONB
        AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_each_text(p_map) AS entry(key, value)
            WHERE NOT public.analysis_v2_valid_apify_credential_slot(entry.value)
        ), FALSE
    )
$$;

CREATE FUNCTION public.analysis_v2_valid_provider_operation_key(p_key TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE STRICT SET search_path = ''
AS $$
    SELECT p_key ~ '^(target-profile|profile-fallback|profile-repair|relationship-followers|relationship-following|target-likers|target-comments|candidate-likers):[0-9a-f]{64}$'
$$;

CREATE FUNCTION public.analysis_v2_valid_launch_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_snapshot) = 'object'
        AND p_snapshot ?& ARRAY['basic','standard','plus']
        AND p_snapshot - ARRAY['basic','standard','plus'] = '{}'::JSONB,
        FALSE
    )
$$;
CREATE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_snapshot) = 'object'
        AND p_snapshot ?& ARRAY['basic','standard','plus']
        AND p_snapshot - ARRAY['basic','standard','plus'] = '{}'::JSONB
        AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.jsonb_each(p_snapshot) AS card(plan_id, value)
            WHERE pg_catalog.jsonb_typeof(card.value) <> 'object'
               OR NOT card.value ?& ARRAY[
                    'launchStatus','relationshipCapacity','detailedMutualLimit',
                    'selectionState','unavailableReason'
               ]
        ), FALSE
    )
$$;
CREATE FUNCTION public.analysis_v2_valid_pricing_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_snapshot) = 'object'
        AND p_snapshot ?& ARRAY['basic','standard','plus']
        AND p_snapshot - ARRAY['basic','standard','plus'] = '{}'::JSONB,
        FALSE
    )
$$;
CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_snapshot) = 'object'
        AND p_snapshot <> '{}'::JSONB,
        FALSE
    )
$$;
CREATE FUNCTION public.analysis_v2_valid_scope_snapshot(p_snapshot JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
    SELECT COALESCE(
        pg_catalog.jsonb_typeof(p_snapshot) = 'object'
        AND p_snapshot ?& ARRAY['relationshipCapacity','detailedMutualLimit']
        AND p_snapshot - ARRAY['relationshipCapacity','detailedMutualLimit'] = '{}'::JSONB
        AND pg_catalog.jsonb_typeof(p_snapshot->'relationshipCapacity') = 'object',
        FALSE
    )
$$;

CREATE TABLE public.users (id UUID PRIMARY KEY);

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    target_instagram_id TEXT NOT NULL,
    excluded_instagram_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    completed_at TIMESTAMP WITH TIME ZONE,
    background_processing BOOLEAN NOT NULL DEFAULT FALSE,
    pipeline_version TEXT,
    preflight_id UUID,
    plan_access_mode_snapshot TEXT,
    test_entitlement_jti_hash TEXT,
    selected_plan_id_snapshot TEXT,
    analysis_scope_snapshot JSONB
    ,target_gender TEXT
    ,progress INTEGER NOT NULL DEFAULT 0
    ,progress_step TEXT
    ,current_step TEXT
    ,step_data JSONB NOT NULL DEFAULT '{}'::JSONB
    ,gender_stats JSONB NOT NULL DEFAULT '{}'::JSONB
    ,plan_type TEXT
    ,idempotency_key TEXT
    ,exclusion_decision_snapshot TEXT
    ,capacity_required_plan_id_snapshot TEXT
    ,required_plan_id_snapshot TEXT
    ,plan_launch_status_snapshot JSONB
    ,plan_cards_snapshot JSONB
    ,pricing_version_snapshot TEXT
    ,pricing_snapshot JSONB
    ,policy_versions_snapshot JSONB
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    error_code TEXT,
    access_mode TEXT NOT NULL CHECK (access_mode IN ('production', 'test_entitlement')),
    target_instagram_id TEXT,
    idempotency_key TEXT,
    target_full_name TEXT,
    target_bio TEXT,
    target_profile_image_url TEXT,
    exclusion_decision TEXT NOT NULL DEFAULT 'skip',
    worker_attempt_count INTEGER NOT NULL DEFAULT 0,
    plan_catalog_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    launch_status_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    plan_cards_snapshot JSONB,
    pricing_version TEXT NOT NULL DEFAULT 'test',
    pricing_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    policy_versions_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    excluded_instagram_id TEXT,
    exclusion_decided_at TIMESTAMPTZ,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    admission_status TEXT,
    admission_generation INTEGER,
    admission_selected_plan_id TEXT,
    admission_token UUID,
    admission_requested_at TIMESTAMPTZ,
    admission_claim_token UUID,
    admission_lease_expires_at TIMESTAMPTZ,
    admission_failure_count INTEGER NOT NULL DEFAULT 0,
    admission_refreshed_at TIMESTAMPTZ,
    admission_error_code TEXT,
    admission_last_error_code TEXT,
    admission_dispatch_generation INTEGER NOT NULL DEFAULT 1,
    admission_dispatch_token UUID,
    admission_dispatch_state TEXT NOT NULL DEFAULT 'reserved',
    admission_dispatched_at TIMESTAMPTZ,
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_state TEXT NOT NULL DEFAULT 'unreserved',
    dispatch_token UUID,
    dispatch_reserved_at TIMESTAMPTZ,
    dispatched_at TIMESTAMPTZ,
    consumed_request_id UUID,
    consumed_at TIMESTAMPTZ,
    ready_at TIMESTAMPTZ,
    blocked_at TIMESTAMPTZ,
    pii_scrubbed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX analysis_preflights_user_idempotency_key_idx
    ON public.analysis_preflights(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'cancelled'
);
CREATE TABLE public.earlybird_waitlist (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);
CREATE TABLE public.earlybird_schema_failure_recoveries (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    recovery_preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);
CREATE TABLE public.analysis_v2_replay_capture_authorizations (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);
CREATE TABLE public.earlybird_adoption_policy_failure_rearms (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    rearmed_preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);
CREATE TABLE public.earlybird_terminal_unavailable_exhaustion_rearms (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    rearmed_preflight_id UUID REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    dispatch_state TEXT NOT NULL DEFAULT 'pending',
    dispatch_generation INTEGER NOT NULL DEFAULT 0,
    dispatch_reservation_token UUID,
    dispatch_reserved_at TIMESTAMPTZ,
    dispatched_at TIMESTAMPTZ,
    dispatch_task_name TEXT,
    delivered_at TIMESTAMPTZ,
    first_started_at TIMESTAMPTZ,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    track TEXT NOT NULL DEFAULT 'collect',
    kind TEXT NOT NULL DEFAULT 'collect',
    batch INTEGER,
    last_error_code TEXT,
    last_error_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    input_hash TEXT NOT NULL DEFAULT '${INPUT_HASH}',
    required_job_keys TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    PRIMARY KEY (request_id, job_key)
);

CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    operation_key TEXT NOT NULL DEFAULT 'target-profile-fallback',
    input_hash TEXT NOT NULL,
    logical_provider TEXT NOT NULL DEFAULT 'apify',
    actor_id TEXT NOT NULL DEFAULT 'apify/instagram-profile-scraper',
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    usage_reconciled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (preflight_id, operation_key)
);

CREATE FUNCTION public.analysis_preflight_provider_run_json(
    p_run public.analysis_preflight_provider_runs
)
RETURNS JSONB LANGUAGE sql STABLE STRICT SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'preflightId', p_run.preflight_id,
        'operationKey', p_run.operation_key,
        'inputHash', p_run.input_hash,
        'logicalProvider', p_run.logical_provider,
        'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot,
        'maxChargeUsd', p_run.max_charge_usd,
        'status', p_run.status
    )
$$;

CREATE FUNCTION public.adopt_legacy_fresh_admission_provider_run(
    p_preflight_id UUID,
    p_operation_key TEXT,
    p_admission_requested_at TIMESTAMPTZ
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
    UPDATE public.analysis_preflight_provider_runs AS provider_run
    SET operation_key = p_operation_key,
        updated_at = pg_catalog.clock_timestamp()
    WHERE provider_run.preflight_id = p_preflight_id
      AND provider_run.operation_key = 'target-profile-fallback'
      AND provider_run.reserved_at >= p_admission_requested_at
      AND NOT EXISTS (
          SELECT 1 FROM public.analysis_preflight_provider_runs AS current_generation
          WHERE current_generation.preflight_id = p_preflight_id
            AND current_generation.operation_key = p_operation_key
      );
END
$$;

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL,
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    job_claim_token UUID NOT NULL,
    reservation_token UUID NOT NULL UNIQUE,
    logical_provider TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    max_charge_usd NUMERIC(18, 12) NOT NULL,
    status TEXT NOT NULL DEFAULT 'starting',
    run_id TEXT,
    actual_usage_usd NUMERIC(18, 12),
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    run_started_at TIMESTAMPTZ,
    terminalized_at TIMESTAMPTZ,
    usage_reconciled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY (request_id, job_key, operation_key),
    FOREIGN KEY (request_id, job_key)
        REFERENCES public.analysis_pipeline_jobs(request_id, job_key)
);

CREATE FUNCTION public.analysis_v2_provider_run_json(p_run public.analysis_v2_provider_runs)
RETURNS JSONB LANGUAGE sql STABLE STRICT SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
        'requestId', p_run.request_id,
        'jobKey', p_run.job_key,
        'operationKey', p_run.operation_key,
        'inputHash', p_run.input_hash,
        'reservationToken', p_run.reservation_token,
        'logicalProvider', p_run.logical_provider,
        'actorId', p_run.actor_id,
        'credentialSlot', p_run.credential_slot,
        'maxChargeUsd', p_run.max_charge_usd,
        'status', p_run.status
    )
$$;

CREATE FUNCTION public.analysis_v2_reserve_provider_run_internal(
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
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_existing public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    IF NOT public.analysis_v2_valid_provider_operation_key(p_operation_key)
       OR NOT public.analysis_v2_valid_apify_credential_slot(p_credential_slot)
       OR p_max_charge_usd NOT BETWEEN 0 AND 100000
       OR p_max_charge_usd <> pg_catalog.round(p_max_charge_usd, 12) THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_INVALID', ERRCODE = 'P0001';
    END IF;
    SELECT job.* INTO v_job
    FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    FOR UPDATE;
    IF NOT FOUND OR v_job.status <> 'processing'
       OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at <= pg_catalog.clock_timestamp() THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT provider_run.* INTO v_existing
    FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id
      AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_existing.input_hash IS DISTINCT FROM p_input_hash
           OR v_existing.logical_provider IS DISTINCT FROM p_logical_provider
           OR v_existing.actor_id IS DISTINCT FROM p_actor_id
           OR v_existing.credential_slot IS DISTINCT FROM p_credential_slot
           OR v_existing.max_charge_usd IS DISTINCT FROM p_max_charge_usd THEN
            RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT', ERRCODE = 'P0001';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'created', FALSE, 'run', public.analysis_v2_provider_run_json(v_existing)
        );
    END IF;
    INSERT INTO public.analysis_v2_provider_runs (
        request_id, job_key, operation_key, input_hash, job_claim_token,
        reservation_token, logical_provider, actor_id, credential_slot,
        max_charge_usd
    ) VALUES (
        p_request_id, p_job_key, p_operation_key, p_input_hash, p_claim_token,
        p_reservation_token, p_logical_provider, p_actor_id, p_credential_slot,
        p_max_charge_usd
    ) RETURNING * INTO v_existing;
    RETURN pg_catalog.jsonb_build_object(
        'created', TRUE, 'run', public.analysis_v2_provider_run_json(v_existing)
    );
END
$$;

CREATE TABLE public.analysis_v2_provider_cleanup_intents (
    request_id UUID PRIMARY KEY,
    completed_at TIMESTAMPTZ
);

CREATE FUNCTION public.claim_analysis_v2_job(
    p_request_id UUID, p_job_key TEXT, p_dispatch_generation INTEGER,
    p_dispatch_token UUID, p_claim_token UUID,
    p_lease_seconds INTEGER DEFAULT 120, p_max_attempts INTEGER DEFAULT 7
)
RETURNS TABLE(
    claimed BOOLEAN, job_status TEXT, attempt_count INTEGER,
    lease_expires_at TIMESTAMPTZ, track TEXT, job_kind TEXT,
    batch INTEGER, input_hash TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_request public.analysis_requests%ROWTYPE;
    v_job public.analysis_pipeline_jobs%ROWTYPE;
BEGIN
    IF p_request_id IS NULL OR p_job_key !~ '^[a-z0-9][a-z0-9:._-]{0,159}$'
       OR p_dispatch_generation NOT BETWEEN 1 AND 1000
       OR p_dispatch_token IS NULL OR p_claim_token IS NULL
       OR p_lease_seconds NOT BETWEEN 30 AND 600
       OR p_max_attempts NOT BETWEEN 1 AND 20 THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_INVALID_JOB_CLAIM_INPUT', ERRCODE = 'P0001';
    END IF;
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    SELECT analysis_request.* INTO v_request
    FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id
      AND analysis_request.pipeline_version = 'v2' FOR UPDATE;
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF v_request.id IS NULL OR v_job.request_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    IF v_job.dispatch_generation <> p_dispatch_generation
       OR v_job.dispatch_reservation_token <> p_dispatch_token
       OR v_job.dispatch_state NOT IN ('enqueued', 'delivered') THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_JOB_DISPATCH_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    IF v_job.status = 'processing' AND v_job.lease_expires_at > v_now THEN
        RETURN QUERY SELECT v_job.lease_token = p_claim_token,
            v_job.status, v_job.attempt_count, v_job.lease_expires_at,
            v_job.track, v_job.kind, v_job.batch, v_job.input_hash;
        RETURN;
    END IF;
    UPDATE public.analysis_pipeline_jobs AS job
    SET status = 'processing', dispatch_state = 'delivered',
        lease_token = p_claim_token,
        lease_expires_at = v_now + p_lease_seconds * INTERVAL '1 second',
        attempt_count = job.attempt_count + 1,
        first_started_at = COALESCE(job.first_started_at, v_now),
        updated_at = v_now
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key
    RETURNING job.* INTO v_job;
    RETURN QUERY SELECT TRUE, v_job.status, v_job.attempt_count,
        v_job.lease_expires_at, v_job.track, v_job.kind, v_job.batch,
        v_job.input_hash;
END
$$;
REVOKE ALL ON FUNCTION public.claim_analysis_v2_job(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_analysis_v2_job(
    UUID, TEXT, INTEGER, UUID, UUID, INTEGER, INTEGER
) TO service_role;

CREATE FUNCTION public.checkpoint_analysis_v2_provider_run_started(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID,
    p_operation_key TEXT, p_reservation_token UUID, p_run_id TEXT
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_job public.analysis_pipeline_jobs%ROWTYPE;
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id AND analysis_request.pipeline_version = 'v2' FOR UPDATE;
    SELECT job.* INTO v_job FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    IF v_job.status <> 'processing' OR v_job.lease_token IS DISTINCT FROM p_claim_token
       OR v_job.lease_expires_at <= v_now THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    SELECT provider_run.* INTO v_run FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key FOR UPDATE;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.job_claim_token IS DISTINCT FROM p_claim_token THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET status = 'running', run_id = p_run_id, run_started_at = v_now,
        updated_at = v_now
    WHERE provider_run.request_id = p_request_id AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    RETURNING provider_run.* INTO v_run;
    RETURN public.analysis_v2_provider_run_json(v_run);
END
$$;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_provider_run_started(
    UUID, TEXT, UUID, TEXT, UUID, TEXT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_provider_run_started(
    UUID, TEXT, UUID, TEXT, UUID, TEXT
) TO service_role;

CREATE FUNCTION public.checkpoint_analysis_v2_provider_run_terminal(
    p_request_id UUID, p_job_key TEXT, p_claim_token UUID,
    p_operation_key TEXT, p_reservation_token UUID, p_run_id TEXT,
    p_status TEXT, p_actual_usage_usd NUMERIC
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_run public.analysis_v2_provider_runs%ROWTYPE;
BEGIN
    PERFORM 1 FROM public.analysis_preflights AS preflight
    WHERE preflight.consumed_request_id = p_request_id FOR UPDATE;
    PERFORM 1 FROM public.analysis_requests AS analysis_request
    WHERE analysis_request.id = p_request_id AND analysis_request.pipeline_version = 'v2' FOR UPDATE;
    PERFORM 1 FROM public.analysis_pipeline_jobs AS job
    WHERE job.request_id = p_request_id AND job.job_key = p_job_key FOR UPDATE;
    SELECT provider_run.* INTO v_run FROM public.analysis_v2_provider_runs AS provider_run
    WHERE provider_run.request_id = p_request_id AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key FOR UPDATE;
    IF v_run.reservation_token IS DISTINCT FROM p_reservation_token
       OR v_run.job_claim_token IS DISTINCT FROM p_claim_token
       OR v_run.run_id IS DISTINCT FROM p_run_id OR v_run.status <> 'running' THEN
        RAISE EXCEPTION USING MESSAGE = 'ANALYSIS_V2_PROVIDER_RUN_FENCE_MISMATCH', ERRCODE = 'P0001';
    END IF;
    UPDATE public.analysis_v2_provider_runs AS provider_run
    SET status = p_status, actual_usage_usd = p_actual_usage_usd,
        terminalized_at = v_now, usage_reconciled_at = v_now,
        updated_at = v_now
    WHERE provider_run.request_id = p_request_id AND provider_run.job_key = p_job_key
      AND provider_run.operation_key = p_operation_key
    RETURNING provider_run.* INTO v_run;
    RETURN public.analysis_v2_provider_run_json(v_run);
END
$$;
REVOKE ALL ON FUNCTION public.checkpoint_analysis_v2_provider_run_terminal(
    UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.checkpoint_analysis_v2_provider_run_terminal(
    UUID, TEXT, UUID, TEXT, UUID, TEXT, TEXT, NUMERIC
) TO service_role;

CREATE TABLE public.analysis_v2_provider_execution_policies (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id) ON DELETE CASCADE,
    mode VARCHAR(32) NOT NULL CHECK (mode = 'test_operation_split'),
    policy_version VARCHAR(64) NOT NULL CHECK (policy_version = 'authorized-free-e2e-v1'),
    entitlement_jti_hash VARCHAR(64) NOT NULL CHECK (entitlement_jti_hash ~ '^[a-f0-9]{64}$'),
    target_instagram_id VARCHAR(30) NOT NULL CHECK (target_instagram_id ~ '^[a-z0-9._]{1,30}$'),
    operation_slot_map JSONB NOT NULL CHECK (
        public.analysis_v2_valid_test_operation_slot_map(operation_slot_map)
    ),
    policy_hash VARCHAR(64) NOT NULL CHECK (policy_hash ~ '^[a-f0-9]{64}$'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.analysis_v2_provider_execution_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.analysis_v2_provider_execution_policies FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.analysis_v2_provider_execution_policies
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.claim_analysis_v2_preflight(UUID, UUID, INTEGER DEFAULT 300)
RETURNS TABLE(preflight_id UUID, user_id UUID, claimed BOOLEAN, target_instagram_id TEXT,
    access_mode TEXT, plan_catalog_snapshot JSONB, pricing_version TEXT, pricing_snapshot JSONB,
    worker_attempt_count INTEGER, lease_expires_at TIMESTAMPTZ, preflight_status TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT NULL::UUID,NULL::UUID,FALSE,NULL::TEXT,NULL::TEXT,NULL::JSONB,NULL::TEXT,NULL::JSONB,NULL::INTEGER,NULL::TIMESTAMPTZ,NULL::TEXT $$;
CREATE FUNCTION public.claim_analysis_v2_preflight_admission(UUID, INTEGER, INTEGER, UUID, UUID, INTEGER)
RETURNS TABLE(claimed BOOLEAN, admission_status TEXT, target_instagram_id TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$ SELECT FALSE,NULL::TEXT,NULL::TEXT $$;

-- Faithful current overloads are present so the hardening migration can
-- rename the exact implementations and wrap their public signatures.
CREATE FUNCTION public.create_or_replay_analysis_v2_preflight(
    p_user_id UUID, p_email TEXT, p_auth_provider TEXT,
    p_target_instagram_id TEXT, p_idempotency_key TEXT, p_access_mode TEXT,
    p_launch_status_snapshot JSONB, p_plan_catalog_snapshot JSONB,
    p_pricing_version TEXT, p_pricing_snapshot JSONB,
    p_policy_versions_snapshot JSONB
)
RETURNS TABLE(preflight_id UUID, created BOOLEAN, preflight_status TEXT,
    expires_at TIMESTAMPTZ)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
DECLARE v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
BEGIN
    UPDATE public.analysis_preflights AS stale
    SET status='expired',updated_at=v_now
    WHERE stale.user_id=p_user_id
      AND stale.status<>'consumed'
      AND stale.expires_at<=v_now;
    SELECT row.* INTO v_preflight
    FROM public.analysis_preflights AS row
    WHERE row.user_id=p_user_id AND row.idempotency_key=p_idempotency_key
    FOR UPDATE;
    IF FOUND THEN
        IF v_preflight.target_instagram_id IS DISTINCT FROM p_target_instagram_id
           OR v_preflight.access_mode IS DISTINCT FROM p_access_mode THEN
            RAISE EXCEPTION USING
                MESSAGE='ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT', ERRCODE='P0001';
        END IF;
        RETURN QUERY SELECT v_preflight.id,FALSE,v_preflight.status,v_preflight.expires_at;
        RETURN;
    END IF;
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(
            'analysis-v2-preflight-global-hourly-budget',0
        )
    );
    INSERT INTO public.analysis_preflights(
        id,user_id,status,access_mode,target_instagram_id,idempotency_key,
        exclusion_decision,launch_status_snapshot,plan_catalog_snapshot,
        pricing_version,pricing_snapshot,policy_versions_snapshot,expires_at
    ) VALUES(
        extensions.gen_random_uuid(),p_user_id,'pending',p_access_mode,
        p_target_instagram_id,p_idempotency_key,'pending',
        p_launch_status_snapshot,p_plan_catalog_snapshot,p_pricing_version,
        p_pricing_snapshot,p_policy_versions_snapshot,v_now+INTERVAL '30 minutes'
    ) RETURNING * INTO v_preflight;
    RETURN QUERY SELECT v_preflight.id,TRUE,v_preflight.status,v_preflight.expires_at;
END;
$$;

CREATE FUNCTION public.reserve_analysis_v2_preflight_dispatch(
    p_preflight_id UUID,p_user_id UUID,p_dispatch_token UUID
)
RETURNS TABLE(should_enqueue BOOLEAN,dispatch_generation INTEGER,
    reservation_token UUID,preflight_status TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    SELECT row.* INTO v_preflight FROM public.analysis_preflights AS row
    WHERE row.id=p_preflight_id AND row.user_id=p_user_id FOR UPDATE;
    IF NOT FOUND OR v_preflight.status IS DISTINCT FROM 'pending' THEN
        RETURN QUERY SELECT FALSE,COALESCE(v_preflight.dispatch_generation,0),
            v_preflight.dispatch_token,v_preflight.status;
        RETURN;
    END IF;
    IF v_preflight.dispatch_state='unreserved' THEN
        UPDATE public.analysis_preflights AS row
        SET dispatch_generation=row.dispatch_generation+1,
            dispatch_state='reserved',dispatch_token=p_dispatch_token,
            dispatch_reserved_at=pg_catalog.clock_timestamp()
        WHERE row.id=p_preflight_id RETURNING * INTO v_preflight;
    END IF;
    RETURN QUERY SELECT TRUE,v_preflight.dispatch_generation,
        v_preflight.dispatch_token,v_preflight.status;
END;
$$;

CREATE FUNCTION public.record_analysis_v2_preflight_admission_failure(
    p_preflight_id UUID, p_admission_generation INTEGER, p_claim_token UUID
)
RETURNS TABLE(admission_status TEXT, failure_count INTEGER, admission_error_code TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_preflight public.analysis_preflights%ROWTYPE;
    v_failure_count INTEGER;
    v_status TEXT;
    v_error_code TEXT;
BEGIN
    IF p_preflight_id IS NULL OR p_admission_generation IS NULL
       OR p_admission_generation NOT BETWEEN 1 AND 100 OR p_claim_token IS NULL THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_FRESH_ADMISSION_INVALID', ERRCODE='P0001';
    END IF;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=p_preflight_id
      AND preflight.admission_generation=p_admission_generation
      AND preflight.admission_status='processing'
      AND preflight.admission_claim_token=p_claim_token
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING MESSAGE='ANALYSIS_V2_PREFLIGHT_NOT_READY', ERRCODE='P0001';
    END IF;
    v_failure_count:=LEAST(v_preflight.admission_failure_count+1,3);
    v_status:=CASE WHEN v_failure_count>=3 THEN 'blocked' ELSE 'pending' END;
    v_error_code:=CASE WHEN v_status='blocked' THEN 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE' ELSE NULL END;
    UPDATE public.analysis_preflights AS preflight
    SET admission_status=v_status,
        admission_refreshed_at=CASE WHEN v_status='blocked' THEN v_now ELSE NULL END,
        admission_claim_token=NULL, admission_lease_expires_at=NULL,
        admission_error_code=v_error_code, admission_failure_count=v_failure_count,
        admission_last_error_code='ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE', updated_at=v_now
    WHERE preflight.id=v_preflight.id;
    RETURN QUERY SELECT v_status,v_failure_count,v_error_code;
END;
$$;
REVOKE ALL ON FUNCTION public.record_analysis_v2_preflight_admission_failure(UUID, INTEGER, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.record_analysis_v2_preflight_admission_failure(UUID, INTEGER, UUID)
    TO service_role;
`;

interface JsonRow<T> {
    result: T;
}

interface AllocationJson {
    allocationId: string;
    lifecycleState: string;
    operationSlotMap: Record<string, string> | null;
}

interface ReservationJson {
    created: boolean;
    run: {
        operationKey: string;
        credentialSlot: string;
        maxChargeUsd: number;
    };
}

interface PlanAdmissionJson {
    requestId: string;
    initialJobKey: 'coordinator:bootstrap';
    allocationId: string;
    replayed: boolean;
}

let db: PGlite;
let entryHardeningApplied = false;
let partialSettlementUpgrade: {
    allocation_state: string;
    active_count: number;
    settled_count: number;
} | null = null;
let retryExhaustionBeforeUpgrade: {
    channel: string;
    status: string;
    error_code: string | null;
    state: string;
    retry_recorded: boolean;
} | null = null;
let retryExhaustionBackfillUpgrade: {
    channel: string;
    status: string;
    error_code: string | null;
    state: string;
    dispatch: string;
    lease_token: string | null;
    lease_expires_at: string | null;
    blocked_recorded: boolean;
    completed_recorded: boolean;
    retry_recorded: boolean;
    constraint_validated: boolean;
} | null = null;

async function serviceQuery<T>(
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function authenticatedQuery<T>(
    userId: string,
    sql: string,
    params: unknown[] = []
): Promise<Results<T>> {
    await db.query(
        `SELECT pg_catalog.set_config('request.jwt.claim.sub',$1,FALSE)`,
        [userId]
    );
    await db.exec('SET ROLE authenticated');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

function snapshots(): unknown[] {
    const now = Date.now();
    return BETA_SLOTS.map(credentialSlot => ({
        credentialSlot,
        monthlyLimitUsd: 1,
        monthlyUsageUsd: 0,
        billingCycleStartAt: new Date(now - 60_000).toISOString(),
        billingCycleEndAt: new Date(now + 86_400_000).toISOString(),
        observedAt: new Date(now - 1_000).toISOString(),
        healthState: 'healthy',
    }));
}

function admissionSnapshotPayload() {
    const launch = Object.fromEntries(PLAN_IDS.map(planId => [planId, 'production']));
    const cards = Object.fromEntries(PLAN_IDS.map((planId, index) => {
        const plan = getAnalysisPlan(planId);
        return [planId, {
            launchStatus: 'production',
            relationshipCapacity: plan.relationshipCapacity,
            detailedMutualLimit: plan.detailedMutualLimit,
            selectionState: index === 0 ? 'required' : 'available_upgrade',
            unavailableReason: null,
        }];
    }));
    const pricing = Object.fromEntries(PLAN_IDS.map(planId => [planId, {
        status: planId === 'plus' ? 'deferred' : 'quoted',
        currency: 'KRW',
        amountKrw: planId === 'basic' ? 6900 : planId === 'standard' ? 9900 : null,
    }]));
    return { launch, cards, pricing, policies: { riskPolicy: 'v29' } };
}

async function seedPendingBetaPreflight(): Promise<void> {
    await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
    if (entryHardeningApplied) {
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, status, access_mode, target_instagram_id,
                target_followers_count, target_following_count, expires_at,
                beta_entry_provenance,beta_prepare_generation,beta_prepare_token,
                beta_prepare_state,beta_prepare_dispatch_state
             ) VALUES (
                $1, $2, 'pending', 'production', $3, 120, 140,
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes',
                'betatest_service_v1',1,$4,'reserved','enqueued'
             )`,
            [PREFLIGHT_ID, USER_ID, TARGET, PREPARE_TOKEN]
        );
    } else {
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, status, access_mode, target_instagram_id,
                target_followers_count, target_following_count, expires_at
             ) VALUES (
                $1, $2, 'pending', 'production', $3, 120, 140,
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
             )`,
            [PREFLIGHT_ID, USER_ID, TARGET]
        );
    }
    await serviceQuery(
        `SELECT public.upsert_analysis_beta_access_grant(
            $1, TRUE, pg_catalog.clock_timestamp() + INTERVAL '1 hour', $2
        )`,
        [USER_ID, AUDIT_HASH]
    );
    await serviceQuery(
        'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
        [JSON.stringify(snapshots())]
    );
    if (entryHardeningApplied) {
        await serviceQuery(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`,
            [PREFLIGHT_ID, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        );
        await serviceQuery(
            `SELECT public.prepare_analysis_beta_apify_preflight_credit(
                $1,$2,1,$3,$4,'primary',0.005200000000,300
            )`,
            [PREFLIGHT_ID, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        );
    } else {
        await serviceQuery(
            `SELECT public.hold_analysis_beta_apify_preflight_credit(
                $1, $2, 'primary', 0.005200000000, 300
            )`,
            [PREFLIGHT_ID, USER_ID]
        );
    }
}

async function seedPendingBetaRequest(): Promise<void> {
    await seedPendingBetaPreflight();
    await db.query(
        `INSERT INTO public.analysis_requests (
            id, user_id, target_instagram_id, status, background_processing,
            pipeline_version, preflight_id, plan_access_mode_snapshot,
            test_entitlement_jti_hash, selected_plan_id_snapshot,
            analysis_scope_snapshot
         ) VALUES (
            $1, $2, $3, 'pending', FALSE, 'v2', $4, 'production', NULL,
            'standard', $5::JSONB
         )`,
        [
            REQUEST_ID,
            USER_ID,
            TARGET,
            PREFLIGHT_ID,
            JSON.stringify({
                relationshipCapacity: { followers: 300, following: 300 },
                detailedMutualLimit: 300,
            }),
        ]
    );
    await db.query(
        `UPDATE public.analysis_preflights
         SET status = 'consumed', consumed_request_id = $2
         WHERE id = $1`,
        [PREFLIGHT_ID, REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs (request_id, job_key)
         VALUES ($1, 'collect')`,
        [REQUEST_ID]
    );
}

async function seedReadyBetaAdmission(planId: PlanId): Promise<void> {
    await seedPendingBetaPreflight();
    const snapshot = admissionSnapshotPayload();
    await db.query(
        `UPDATE public.analysis_apify_credit_snapshots
         SET monthly_limit_usd = 10, monthly_usage_usd = 0`
    );
    await db.query(
        `UPDATE public.analysis_preflights
         SET status = 'ready', exclusion_decision = 'skip', target_is_private = FALSE,
             capacity_required_plan_id = 'basic', required_plan_id = 'basic',
             launch_status_snapshot = $2::JSONB, plan_cards_snapshot = $3::JSONB,
             pricing_version = 'earlybird-2026-07-v2', pricing_snapshot = $4::JSONB,
             policy_versions_snapshot = $5::JSONB, ready_at = pg_catalog.clock_timestamp(),
             admission_status = 'ready', admission_generation = 1,
             admission_selected_plan_id = $6, admission_token = $7,
             admission_refreshed_at = pg_catalog.clock_timestamp(), updated_at = pg_catalog.clock_timestamp()
         WHERE id = $1`,
        [
            PREFLIGHT_ID,
            JSON.stringify(snapshot.launch),
            JSON.stringify(snapshot.cards),
            JSON.stringify(snapshot.pricing),
            JSON.stringify(snapshot.policies),
            planId,
            ADMISSION_TOKEN,
        ]
    );
}

async function admitBetaPlan(input: {
    planId?: PlanId;
    token?: string;
    generation?: number;
    slots?: Record<string, string>;
    budgets?: Record<string, number>;
} = {}): Promise<PlanAdmissionJson> {
    const planId = input.planId ?? 'basic';
    const result = await serviceQuery<JsonRow<PlanAdmissionJson>>(
        `SELECT public.admit_analysis_v2_betatest_plan(
            $1, $2, $3, $4, $5, $6::JSONB, $7::JSONB, 300
        ) AS result`,
        [
            PREFLIGHT_ID,
            USER_ID,
            input.token ?? ADMISSION_TOKEN,
            input.generation ?? 1,
            planId,
            JSON.stringify(input.slots ?? betaSlots),
            JSON.stringify(input.budgets ?? getBetaApifyOperationBudgetCatalog(planId, {})),
        ]
    );
    return result.rows[0].result;
}

async function replayBetaPlan(input: {
    planId?: PlanId;
    token?: string;
    generation?: number;
} = {}): Promise<PlanAdmissionJson | null> {
    const result = await serviceQuery<JsonRow<PlanAdmissionJson | null>>(
        `SELECT public.load_analysis_v2_betatest_plan_replay(
            $1, $2, $3, $4, $5
        ) AS result`,
        [
            PREFLIGHT_ID,
            USER_ID,
            input.token ?? ADMISSION_TOKEN,
            input.generation ?? 1,
            input.planId ?? 'basic',
        ]
    );
    return result.rows[0].result;
}

async function replayConsumedBetaPlan(
    selectedPlanId: PlanId = 'basic'
): Promise<PlanAdmissionJson | null> {
    const result = await serviceQuery<JsonRow<PlanAdmissionJson | null>>(
        `SELECT public.load_analysis_v2_betatest_consumed_replay(
            $1, $2, $3
        ) AS result`,
        [PREFLIGHT_ID, USER_ID, selectedPlanId]
    );
    return result.rows[0].result;
}

async function activateBeta(
    slots: Record<string, string> = betaSlots,
    budgets: Record<string, number> = betaBudgets
): Promise<AllocationJson> {
    const result = await serviceQuery<JsonRow<AllocationJson>>(
        `SELECT public.activate_analysis_beta_apify_request_credit(
            $1, $2, $3, 'standard', $4::JSONB, $5::JSONB, 300
        ) AS result`,
        [
            PREFLIGHT_ID,
            REQUEST_ID,
            USER_ID,
            JSON.stringify(slots),
            JSON.stringify(budgets),
        ]
    );
    return result.rows[0].result;
}

async function makeJobLive(jobKey = 'collect'): Promise<void> {
    await db.query(
        `UPDATE public.analysis_pipeline_jobs
         SET status = 'processing', dispatch_state = 'dispatched',
             dispatch_generation = 1, dispatched_at = pg_catalog.clock_timestamp(),
             lease_token = $2,
             lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
         WHERE request_id = $1 AND job_key = $3`,
        [REQUEST_ID, CLAIM_TOKEN, jobKey]
    );
}

async function reserveProvider(input: {
    family?: string;
    digest?: string;
    slot?: string;
    max?: number;
    inputHash?: string;
    reservationToken?: string;
    claimToken?: string;
    requestId?: string;
    jobKey?: string;
} = {}): Promise<ReservationJson> {
    const family = input.family ?? 'relationship-followers';
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_v2_provider_run(
            $1, $2, $3, $4, $5, 'apify', 'actor/test', $6, $7, $8
        ) AS result`,
        [
            input.requestId ?? REQUEST_ID,
            input.jobKey ?? 'collect',
            input.claimToken ?? CLAIM_TOKEN,
            `${family}:${input.digest ?? DIGEST}`,
            input.inputHash ?? INPUT_HASH,
            input.slot ?? betaSlots[family] ?? 'primary',
            input.max ?? 0.01,
            input.reservationToken ?? RESERVATION_TOKEN,
        ]
    );
    return result.rows[0].result;
}

async function reserveInitial(
    slot = 'primary',
    inputHash = INPUT_HASH
): Promise<ReservationJson> {
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_preflight_provider_run(
            $1, $2, $3, $4, 0.002600000000
        ) AS result`,
        [PREFLIGHT_ID, CLAIM_TOKEN, inputHash, slot]
    );
    return result.rows[0].result;
}

async function reserveFresh(
    generation: number,
    slot = 'primary',
    inputHash = OTHER_INPUT_HASH
): Promise<ReservationJson> {
    const result = await serviceQuery<JsonRow<ReservationJson>>(
        `SELECT public.reserve_analysis_v2_fresh_admission_provider_run(
            $1, $2, $3, $4, $5, 0.002600000000
        ) AS result`,
        [PREFLIGHT_ID, generation, CLAIM_TOKEN, inputHash, slot]
    );
    return result.rows[0].result;
}

interface BetaCreateRow {
    preflight_id: string;
    created: boolean;
    preflight_status: string;
    expires_at: string;
    prepare_generation: number;
    prepare_token: string;
    should_enqueue: boolean;
}

async function createDedicatedBetaPreflight(input: {
    idempotencyKey?: string;
    prepareToken?: string;
} = {}): Promise<BetaCreateRow> {
    const result = await serviceQuery<BetaCreateRow>(
        `SELECT * FROM public.create_or_replay_analysis_v2_betatest_preflight(
            $1,'owner@example.com','google',$2,$3,
            '{}'::JSONB,'{}'::JSONB,'test','{}'::JSONB,'{}'::JSONB,$4
        )`,
        [
            USER_ID,
            TARGET,
            input.idempotencyKey ?? 'betatest-entry-key-000001',
            input.prepareToken ?? PREPARE_TOKEN,
        ]
    );
    return result.rows[0];
}

beforeAll(async () => {
    db = await PGlite.create({ extensions: { pgcrypto } });
    await db.exec(bootstrap);
    for (const migration of migrations.slice(0, -8)) {
        await db.exec(migration);
    }
    await seedPendingBetaRequest();
    const allocation = await activateBeta();
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs (
            request_id, job_key, operation_key, input_hash, job_claim_token,
            reservation_token, logical_provider, actor_id, credential_slot,
            max_charge_usd, status
         ) VALUES ($1, 'collect', $2, $3, $4, $5, 'apify', 'actor/test',
            'tertiary', 0.02, 'starting')`,
        [
            REQUEST_ID,
            `relationship-followers:${DIGEST}`,
            INPUT_HASH,
            CLAIM_TOKEN,
            RESERVATION_TOKEN,
        ]
    );
    await db.query(
        `UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`,
        [REQUEST_ID]
    );
    await serviceQuery(
        `SELECT public.settle_analysis_beta_apify_credit_allocation(
            $1, 'request_terminal'
        )`,
        [allocation.allocationId]
    );

    const upgradeMigrations = migrations.slice(-8);
    if (upgradeMigrations.length !== 8) throw new Error('missing runtime migrations');
    for (const migration of upgradeMigrations.slice(0, 5)) await db.exec(migration);

    const backfillUserId = '10000000-0000-4000-8000-000000000099';
    const backfillPrepareToken = '41000000-0000-4000-8000-000000000099';
    await db.query('INSERT INTO public.users(id) VALUES ($1)', [backfillUserId]);
    await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
    await serviceQuery(
        `SELECT public.upsert_analysis_beta_access_grant(
            $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
        )`, [backfillUserId, AUDIT_HASH]
    );
    const backfillCreated = (await serviceQuery<BetaCreateRow>(
        `SELECT * FROM public.create_or_replay_analysis_v2_betatest_preflight(
            $1,'backfill@example.com','google','backfill.target',$2,
            '{}'::JSONB,'{}'::JSONB,'test','{}'::JSONB,'{}'::JSONB,$3
        )`, [backfillUserId, 'betatest-backfill-key-000001', backfillPrepareToken]
    )).rows[0];
    await serviceQuery(
        `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
            $1,$2,1,$3
        )`, [backfillCreated.preflight_id, backfillUserId, backfillPrepareToken]
    );
    await serviceQuery(
        `SELECT public.mark_analysis_beta_preflight_prepare_retry_exhausted(
            $1,$2,1,$3
        )`, [backfillCreated.preflight_id, backfillUserId, backfillPrepareToken]
    );
    retryExhaustionBeforeUpgrade = (await db.query<{
        channel: string;
        status: string;
        error_code: string | null;
        state: string;
        retry_recorded: boolean;
    }>(`SELECT analysis_entry_channel AS channel,status,error_code,
               beta_prepare_state AS state,
               (beta_prepare_retry_exhausted_at IS NOT NULL) AS retry_recorded
        FROM public.analysis_preflights WHERE id=$1`, [backfillCreated.preflight_id]))
        .rows[0] ?? null;

    for (const migration of upgradeMigrations.slice(5)) await db.exec(migration);
    await db.exec(allAuthenticatedAccessMigration);
    retryExhaustionBackfillUpgrade = (await db.query<{
        channel: string;
        status: string;
        error_code: string | null;
        state: string;
        dispatch: string;
        lease_token: string | null;
        lease_expires_at: string | null;
        blocked_recorded: boolean;
        completed_recorded: boolean;
        retry_recorded: boolean;
        constraint_validated: boolean;
    }>(`SELECT preflight.analysis_entry_channel AS channel,preflight.status,
               preflight.error_code,preflight.beta_prepare_state AS state,
               preflight.beta_prepare_dispatch_state AS dispatch,
               preflight.beta_prepare_lease_token AS lease_token,
               preflight.beta_prepare_lease_expires_at AS lease_expires_at,
               (preflight.blocked_at IS NOT NULL) AS blocked_recorded,
               (preflight.beta_prepare_completed_at IS NOT NULL) AS completed_recorded,
               (preflight.beta_prepare_retry_exhausted_at IS NOT NULL) AS retry_recorded,
               constraint_row.convalidated AS constraint_validated
        FROM public.analysis_preflights AS preflight
        CROSS JOIN pg_catalog.pg_constraint AS constraint_row
        WHERE preflight.id=$1
          AND constraint_row.conname='analysis_preflights_beta_prepare_shape_check'`,
    [backfillCreated.preflight_id])).rows[0] ?? null;
    entryHardeningApplied = true;
    const upgraded = await db.query<{
        allocation_state: string;
        active_count: number;
        settled_count: number;
    }>(
        `SELECT allocation.lifecycle_state AS allocation_state,
                pg_catalog.count(*) FILTER (
                    WHERE reservation.lifecycle_state = 'active'
                )::INTEGER AS active_count,
                pg_catalog.count(*) FILTER (
                    WHERE reservation.lifecycle_state = 'settled'
                )::INTEGER AS settled_count
         FROM public.analysis_beta_pool_allocations AS allocation
         JOIN public.analysis_beta_pool_reservations AS reservation
           ON reservation.allocation_id = allocation.id
         WHERE allocation.id = $1
         GROUP BY allocation.id`,
        [allocation.allocationId]
    );
    partialSettlementUpgrade = upgraded.rows[0] ?? null;
});

beforeEach(async () => {
    await db.exec(`
        DELETE FROM public.analysis_v2_provider_runs;
        DELETE FROM public.analysis_v2_provider_execution_policies;
        DELETE FROM public.analysis_beta_pool_reservation_archive;
        DELETE FROM public.analysis_beta_pool_local_debits;
        DELETE FROM public.analysis_beta_pool_reservations;
        DELETE FROM public.analysis_beta_pool_allocations;
        DELETE FROM public.analysis_pipeline_jobs;
        DELETE FROM public.analysis_preflight_provider_runs;
        DELETE FROM public.analysis_beta_access_grants;
        DELETE FROM public.earlybird_adoption_policy_failure_rearms;
        DELETE FROM public.earlybird_terminal_unavailable_exhaustion_rearms;
        DELETE FROM public.analysis_v2_replay_capture_authorizations;
        DELETE FROM public.earlybird_schema_failure_recoveries;
        DELETE FROM public.earlybird_waitlist;
        DELETE FROM public.earlybird_orders;
        DELETE FROM public.analysis_preflights;
        DELETE FROM public.analysis_requests;
        DELETE FROM public.users;
        UPDATE public.analysis_apify_credit_snapshots
        SET monthly_limit_usd = NULL, monthly_usage_usd = NULL,
            billing_cycle_start_at = NULL, billing_cycle_end_at = NULL,
            observed_at = NULL, health_state = 'unhealthy';
    `);
    await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
    await serviceQuery("SELECT public.set_analysis_beta_access_policy('all_authenticated')");
});

afterAll(async () => {
    await db?.close();
});

describe('betatest provider policy/guard migration PGlite', () => {
    it('applies after Task 2A/2B1 and validates the policy branch separately', async () => {
        expect(migrationUrls.map(url => url.pathname.split('/').at(-1))).toEqual([
            '20260802010000_add_betatest_apify_credit_pool.sql',
            '20260802010100_validate_betatest_entry_channel_constraints.sql',
            '20260802020000_add_betatest_apify_credit_reservations.sql',
            '20260802030000_bind_betatest_provider_policy.sql',
            '20260802030100_validate_betatest_provider_policy.sql',
            '20260802040000_settle_betatest_apify_credit_reservations.sql',
            '20260802050000_harden_betatest_apify_credit_capacity.sql',
            '20260802060000_expose_betatest_frozen_provider_budgets.sql',
            '20260802070000_wire_betatest_preflight_credit_runtime.sql',
            '20260802080000_admit_betatest_apify_plan.sql',
            '20260802090000_settle_betatest_terminal_credit.sql',
            '20260802100000_harden_betatest_entry_lifecycle.sql',
            '20260802100100_harden_betatest_entry_lifecycle_runtime.sql',
            '20260802100200_validate_betatest_entry_lifecycle.sql',
            '20260802100300_allow_betatest_prepare_retry_exhaustion_terminal_state.sql',
            '20260802100400_terminalize_betatest_prepare_retry_exhaustion_runtime.sql',
            '20260802100500_validate_betatest_prepare_retry_exhaustion.sql',
        ]);
        const constraint = await db.query<{ validated: boolean }>(
            `SELECT convalidated AS validated
             FROM pg_catalog.pg_constraint
             WHERE conname = 'analysis_v2_provider_execution_policies_branch_check'`
        );
        expect(constraint.rows).toEqual([{ validated: true }]);
        expect(partialSettlementUpgrade).toEqual({
            allocation_state: 'active',
            active_count: 1,
            settled_count: 7,
        });
        expect(retryExhaustionBeforeUpgrade).toEqual({
            channel: 'standard',
            status: 'pending',
            error_code: null,
            state: 'reserved',
            retry_recorded: true,
        });
        expect(retryExhaustionBackfillUpgrade).toEqual({
            channel: 'betatest',
            status: 'blocked',
            error_code: 'QUEUE_UNAVAILABLE',
            state: 'retry_exhausted',
            dispatch: 'completed',
            lease_token: null,
            lease_expires_at: null,
            blocked_recorded: true,
            completed_recorded: true,
            retry_recorded: true,
            constraint_validated: true,
        });
    });

    it('installs exact private overload ACLs and bounded pg_proc runtime settings', async () => {
        const privateAcl = await db.query<{
            create_private: boolean;
            hold_private: boolean;
            dispatch_private: boolean;
            historical_hold_service: boolean;
            fenced_prepare_service: boolean;
        }>(`SELECT
            pg_catalog.has_function_privilege(
                'service_role',
                'public.analysis_v2_create_or_replay_preflight_unfenced_20260802(uuid,text,text,text,text,text,jsonb,jsonb,text,jsonb,jsonb)',
                'EXECUTE'
            ) AS create_private,
            pg_catalog.has_function_privilege(
                'service_role',
                'public.hold_analysis_beta_apify_preflight_credit_unfenced_20260802(uuid,uuid,text,numeric,integer)',
                'EXECUTE'
            ) AS hold_private,
            pg_catalog.has_function_privilege(
                'service_role',
                'public.reserve_analysis_v2_preflight_dispatch_unfenced_20260802(uuid,uuid,uuid)',
                'EXECUTE'
            ) AS dispatch_private,
            pg_catalog.has_function_privilege(
                'service_role',
                'public.hold_analysis_beta_apify_preflight_credit(uuid,uuid,text,numeric,integer)',
                'EXECUTE'
            ) AS historical_hold_service,
            pg_catalog.has_function_privilege(
                'service_role',
                'public.prepare_analysis_beta_apify_preflight_credit(uuid,uuid,integer,uuid,uuid,text,numeric,integer)',
                'EXECUTE'
            ) AS fenced_prepare_service`);
        expect(privateAcl.rows).toEqual([{
            create_private: false,
            hold_private: false,
            dispatch_private: false,
            historical_hold_service: false,
            fenced_prepare_service: true,
        }]);

        const settings = await db.query<{ proname: string; proconfig: string[] }>(
            `SELECT proc.proname, proc.proconfig
             FROM pg_catalog.pg_proc AS proc
             JOIN pg_catalog.pg_namespace AS namespace
               ON namespace.oid=proc.pronamespace
             WHERE namespace.nspname='public'
               AND proc.proname IN (
                    'set_analysis_beta_runtime_gate',
                    'create_or_replay_analysis_v2_preflight',
                    'create_or_replay_analysis_v2_betatest_preflight',
                    'mark_analysis_beta_preflight_prepare_dispatched',
                    'mark_analysis_beta_preflight_prepare_retry_exhausted',
                    'claim_analysis_beta_preflight_prepare',
                    'release_analysis_beta_preflight_prepare_claim',
                    'hold_analysis_beta_apify_preflight_credit',
                    'prepare_analysis_beta_apify_preflight_credit',
                    'block_analysis_beta_preflight_capacity',
                    'reserve_analysis_v2_preflight_dispatch',
                    'set_analysis_v2_preflight_exclusion',
                    'reserve_analysis_preflight_provider_run',
                    'reserve_analysis_v2_fresh_admission_provider_run',
                    'load_analysis_v2_betatest_consumed_replay',
                    'admit_analysis_v2_betatest_plan'
               )`
        );
        expect(settings.rows).toHaveLength(16);
        for (const row of settings.rows) {
            expect(row.proconfig).toContain('lock_timeout=5s');
            expect(row.proconfig).toContain('statement_timeout=2min');
        }
    });

    it('combines the disabled operational gate with the active self grant', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1)', [USER_ID]);
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
            )`, [USER_ID, AUDIT_HASH]
        );
        expect((await authenticatedQuery<{ allowed: boolean }>(
            USER_ID, 'SELECT public.analysis_beta_has_access() AS allowed'
        )).rows).toEqual([{ allowed: true }]);
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
        expect((await authenticatedQuery<{ allowed: boolean }>(
            USER_ID, 'SELECT public.analysis_beta_has_access() AS allowed'
        )).rows).toEqual([{ allowed: false }]);
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant($1,FALSE,NULL,$2)`,
            [USER_ID, AUDIT_HASH]
        );
        expect((await authenticatedQuery<{ allowed: boolean }>(
            USER_ID, 'SELECT public.analysis_beta_has_access() AS allowed'
        )).rows).toEqual([{ allowed: false }]);
    });

    it('enrolls authenticated users only while the gate and all-authenticated policy are enabled', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1), ($2)', [USER_ID, PREFLIGHT_ID]);

        expect((await authenticatedQuery<{ allowed: boolean }>(
            USER_ID, 'SELECT public.enroll_analysis_beta_authenticated_user() AS allowed'
        )).rows).toEqual([{ allowed: true }]);
        const firstEnrollment = (await db.query<{
            enabled: boolean; source: string; updated_at: string; audit_hash: string;
        }>(
            `SELECT enabled, grant_source AS source, updated_at,
                    audit_reference_hash AS audit_hash
             FROM public.analysis_beta_access_grants WHERE user_id=$1`, [USER_ID]
        )).rows[0];
        expect(firstEnrollment).toMatchObject({ enabled: true, source: 'automatic' });
        expect((await authenticatedQuery<{ allowed: boolean }>(
            USER_ID, 'SELECT public.enroll_analysis_beta_authenticated_user() AS allowed'
        )).rows).toEqual([{ allowed: true }]);
        expect((await db.query<{
            enabled: boolean; source: string; updated_at: string; audit_hash: string;
        }>(
            `SELECT enabled, grant_source AS source, updated_at,
                    audit_reference_hash AS audit_hash
             FROM public.analysis_beta_access_grants WHERE user_id=$1`, [USER_ID]
        )).rows[0]).toEqual(firstEnrollment);
        await expect(createDedicatedBetaPreflight({
            idempotencyKey: 'automatic-grant-fence-000001',
        })).resolves.toMatchObject({ created: true });
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_beta_access_grants WHERE user_id=$1`, [USER_ID]
        )).rows).toEqual([{ count: 1 }]);

        await serviceQuery(
            'SELECT public.upsert_analysis_beta_access_grant($1,FALSE,NULL,$2)',
            [PREFLIGHT_ID, AUDIT_HASH]
        );
        expect((await authenticatedQuery<{ allowed: boolean }>(
            PREFLIGHT_ID, 'SELECT public.enroll_analysis_beta_authenticated_user() AS allowed'
        )).rows).toEqual([{ allowed: true }]);
        const convertedOperator = (await db.query<{
            enabled: boolean; source: string; audit_hash: string;
        }>(
            `SELECT enabled, grant_source AS source, audit_reference_hash AS audit_hash
             FROM public.analysis_beta_access_grants WHERE user_id=$1`, [PREFLIGHT_ID]
        )).rows[0];
        expect(convertedOperator).toMatchObject({ enabled: true, source: 'automatic' });
        expect(convertedOperator?.audit_hash).not.toBe(AUDIT_HASH);

        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
        await db.query(
            `UPDATE public.analysis_beta_access_grants
             SET enabled=FALSE WHERE user_id=$1`, [USER_ID]
        );
        expect((await authenticatedQuery<{ allowed: boolean }>(
            USER_ID, 'SELECT public.enroll_analysis_beta_authenticated_user() AS allowed'
        )).rows).toEqual([{ allowed: false }]);
        expect((await db.query<{ enabled: boolean }>(
            'SELECT enabled FROM public.analysis_beta_access_grants WHERE user_id=$1', [USER_ID]
        )).rows).toEqual([{ enabled: false }]);
        expect((await authenticatedQuery<{ allowed: boolean }>(
            null, 'SELECT public.enroll_analysis_beta_authenticated_user() AS allowed'
        )).rows).toEqual([{ allowed: false }]);
    });

    it('rolls back automatic grants but preserves an automatic row promoted by an operator grant', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1), ($2)', [USER_ID, PREFLIGHT_ID]);
        await authenticatedQuery(
            USER_ID, 'SELECT public.enroll_analysis_beta_authenticated_user()'
        );
        await authenticatedQuery(
            PREFLIGHT_ID, 'SELECT public.enroll_analysis_beta_authenticated_user()'
        );
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,NULL,$2
            )`, [PREFLIGHT_ID, AUDIT_HASH]
        );
        await serviceQuery("SELECT public.set_analysis_beta_access_policy('grant_only')");

        expect((await authenticatedQuery<{ allowed: boolean }>(
            USER_ID, 'SELECT public.analysis_beta_has_access() AS allowed'
        )).rows).toEqual([{ allowed: false }]);
        expect((await authenticatedQuery<{ allowed: boolean }>(
            PREFLIGHT_ID, 'SELECT public.analysis_beta_has_access() AS allowed'
        )).rows).toEqual([{ allowed: true }]);
        expect((await authenticatedQuery<{ allowed: boolean }>(
            USER_ID, 'SELECT public.enroll_analysis_beta_authenticated_user() AS allowed'
        )).rows).toEqual([{ allowed: false }]);
        expect((await authenticatedQuery<{ allowed: boolean }>(
            PREFLIGHT_ID, 'SELECT public.enroll_analysis_beta_authenticated_user() AS allowed'
        )).rows).toEqual([{ allowed: true }]);
        expect((await db.query<{ user_id: string; enabled: boolean; source: string }>(
            `SELECT user_id, enabled, grant_source AS source
             FROM public.analysis_beta_access_grants
             ORDER BY user_id`
        )).rows).toEqual([
            { user_id: USER_ID, enabled: false, source: 'automatic' },
            { user_id: PREFLIGHT_ID, enabled: true, source: 'operator' },
        ]);
    });

    it('keeps enrollment and policy RPCs non-enumerable and narrowly callable', async () => {
        const acl = await db.query<{
            enroll_authenticated: boolean; enroll_anon: boolean;
            policy_service: boolean; policy_authenticated: boolean;
            grants_authenticated_select: boolean; grants_anon_insert: boolean;
            policy_authenticated_select: boolean; policy_anon_update: boolean;
        }>(`SELECT
            pg_catalog.has_function_privilege('authenticated',
                'public.enroll_analysis_beta_authenticated_user()', 'EXECUTE') AS enroll_authenticated,
            pg_catalog.has_function_privilege('anon',
                'public.enroll_analysis_beta_authenticated_user()', 'EXECUTE') AS enroll_anon,
            pg_catalog.has_function_privilege('service_role',
                'public.set_analysis_beta_access_policy(text)', 'EXECUTE') AS policy_service,
            pg_catalog.has_function_privilege('authenticated',
                'public.set_analysis_beta_access_policy(text)', 'EXECUTE') AS policy_authenticated,
            pg_catalog.has_table_privilege('authenticated',
                'public.analysis_beta_access_grants', 'SELECT') AS grants_authenticated_select,
            pg_catalog.has_table_privilege('anon',
                'public.analysis_beta_access_grants', 'INSERT') AS grants_anon_insert,
            pg_catalog.has_table_privilege('authenticated',
                'public.analysis_beta_access_policy', 'SELECT') AS policy_authenticated_select,
            pg_catalog.has_table_privilege('anon',
                'public.analysis_beta_access_policy', 'UPDATE') AS policy_anon_update`);
        expect(acl.rows).toEqual([{
            enroll_authenticated: true, enroll_anon: false,
            policy_service: true, policy_authenticated: false,
            grants_authenticated_select: false, grants_anon_insert: false,
            policy_authenticated_select: false, policy_anon_update: false,
        }]);
    });

    it('persists one service-only beta generation/token and rejects same-key ordinary dispatch attacks', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1)', [USER_ID]);
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
            )`, [USER_ID, AUDIT_HASH]
        );
        const first = await createDedicatedBetaPreflight();
        const replay = await createDedicatedBetaPreflight({
            prepareToken: '41000000-0000-4000-8000-000000000099',
        });
        expect(first).toMatchObject({
            created: true, prepare_generation: 1,
            prepare_token: PREPARE_TOKEN, should_enqueue: true,
        });
        expect(replay).toMatchObject({
            preflight_id: first.preflight_id, created: false,
            prepare_generation: 1, prepare_token: PREPARE_TOKEN,
            should_enqueue: true,
        });
        await expect(serviceQuery(
            `SELECT * FROM public.create_or_replay_analysis_v2_preflight(
                $1,'owner@example.com','google',$2,$3,'production',
                '{}'::JSONB,'{}'::JSONB,'test','{}'::JSONB,'{}'::JSONB
            )`, [USER_ID, TARGET, 'betatest-entry-key-000001']
        )).rejects.toThrow(/ANALYSIS_V2_PREFLIGHT_IDEMPOTENCY_CONFLICT/);
        await expect(serviceQuery(
            `SELECT * FROM public.reserve_analysis_v2_preflight_dispatch($1,$2,$3)`,
            [first.preflight_id, USER_ID, DISPATCH_TOKEN]
        )).rejects.toThrow(/ANALYSIS_BETA_PREPARE_REQUIRED/);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_preflights WHERE user_id=$1`, [USER_ID]
        )).rows).toEqual([{ count: 1 }]);
    });

    it('rearms an expired lease but terminalizes exhausted delivery until a new key is used', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1)', [USER_ID]);
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
            )`, [USER_ID, AUDIT_HASH]
        );
        const first = await createDedicatedBetaPreflight();
        await serviceQuery(
            `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
                $1,$2,1,$3
            )`, [first.preflight_id, USER_ID, PREPARE_TOKEN]
        );
        await serviceQuery(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [first.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        );
        const retryClaim = '42000000-0000-4000-8000-000000000010';
        expect((await serviceQuery<{
            claimed: boolean; prepare_state: string; claim_disposition: string;
        }>(`SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [first.preflight_id, USER_ID, PREPARE_TOKEN, retryClaim])).rows)
            .toEqual([{
                claimed: false,
                prepare_state: 'preparing',
                claim_disposition: 'busy',
            }]);
        expect((await serviceQuery<{ released: boolean }>(
            `SELECT public.release_analysis_beta_preflight_prepare_claim(
                $1,$2,1,$3,$4
            ) AS released`, [
                first.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN,
            ]
        )).rows).toEqual([{ released: true }]);
        await serviceQuery(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [first.preflight_id, USER_ID, PREPARE_TOKEN, retryClaim]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET beta_prepare_lease_expires_at=
                    pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`, [first.preflight_id]
        );
        const nextToken = '41000000-0000-4000-8000-000000000010';
        const rearmed = await createDedicatedBetaPreflight({
            prepareToken: nextToken,
        });
        expect(rearmed).toMatchObject({
            preflight_id: first.preflight_id,
            created: false,
            prepare_generation: 2,
            prepare_token: nextToken,
            should_enqueue: true,
        });
        expect((await serviceQuery<{ claimed: boolean; prepare_state: string }>(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [first.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        )).rows).toEqual([{
            claimed: false, prepare_state: 'reserved', claim_disposition: 'stale',
        }]);

        const exhaustedToken = '41000000-0000-4000-8000-000000000020';
        const exhausted = await createDedicatedBetaPreflight({
            idempotencyKey: 'betatest-entry-key-000020',
            prepareToken: exhaustedToken,
        });
        await serviceQuery(
            `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
                $1,$2,1,$3
            )`, [exhausted.preflight_id, USER_ID, exhaustedToken]
        );
        expect((await serviceQuery<{ exhausted: boolean }>(
            `SELECT public.mark_analysis_beta_preflight_prepare_retry_exhausted(
                $1,$2,1,$3
            ) AS exhausted`, [exhausted.preflight_id, USER_ID, exhaustedToken]
        )).rows).toEqual([{ exhausted: true }]);

        const terminal = await db.query<{
            channel: string;
            status: string;
            error_code: string;
            state: string;
            dispatch: string;
            lease_token: string | null;
            lease_expires_at: string | null;
            blocked_at: string | null;
            completed_at: string | null;
            retry_exhausted_at: string | null;
        }>(`SELECT analysis_entry_channel AS channel,status,error_code,
                   beta_prepare_state AS state,
                   beta_prepare_dispatch_state AS dispatch,
                   beta_prepare_lease_token AS lease_token,
                   beta_prepare_lease_expires_at AS lease_expires_at,
                   blocked_at,beta_prepare_completed_at AS completed_at,
                   beta_prepare_retry_exhausted_at AS retry_exhausted_at
            FROM public.analysis_preflights WHERE id=$1`, [exhausted.preflight_id]);
        expect(terminal.rows[0]).toMatchObject({
            channel: 'betatest',
            status: 'blocked',
            error_code: 'QUEUE_UNAVAILABLE',
            state: 'retry_exhausted',
            dispatch: 'completed',
            lease_token: null,
            lease_expires_at: null,
        });
        expect(terminal.rows[0]?.blocked_at).not.toBeNull();
        expect(terminal.rows[0]?.completed_at).not.toBeNull();
        expect(terminal.rows[0]?.retry_exhausted_at).not.toBeNull();

        const recoveredToken = '41000000-0000-4000-8000-000000000021';
        const recovered = await createDedicatedBetaPreflight({
            idempotencyKey: 'betatest-entry-key-000020',
            prepareToken: recoveredToken,
        });
        expect(recovered).toMatchObject({
            preflight_id: exhausted.preflight_id,
            created: false,
            preflight_status: 'blocked',
            prepare_generation: 1,
            prepare_token: exhaustedToken,
            should_enqueue: false,
        });

        expect((await serviceQuery<{
            claimed: boolean; prepare_state: string; claim_disposition: string;
        }>(`SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [
                exhausted.preflight_id, USER_ID, exhaustedToken, PREPARE_CLAIM_TOKEN,
            ])).rows).toEqual([{
            claimed: false,
            prepare_state: 'retry_exhausted',
            claim_disposition: 'terminal',
        }]);
        expect((await serviceQuery<{ result: string }>(
            `SELECT public.block_analysis_beta_preflight_capacity(
                $1,$2,1,$3,NULL
            ) AS result`, [exhausted.preflight_id, USER_ID, exhaustedToken]
        )).rows).toEqual([{ result: 'retry_exhausted' }]);
        expect((await serviceQuery<{ released: boolean }>(
            `SELECT public.release_analysis_beta_preflight_prepare_claim(
                $1,$2,1,$3,$4
            ) AS released`, [
                exhausted.preflight_id, USER_ID, exhaustedToken, PREPARE_CLAIM_TOKEN,
            ]
        )).rows).toEqual([{ released: false }]);

        const retried = await createDedicatedBetaPreflight({
            idempotencyKey: 'betatest-entry-key-000021',
            prepareToken: recoveredToken,
        });
        expect(retried).toMatchObject({
            created: true,
            preflight_status: 'pending',
            prepare_generation: 1,
            prepare_token: recoveredToken,
            should_enqueue: true,
        });
        expect(retried.preflight_id).not.toBe(exhausted.preflight_id);

        await db.query(
            `UPDATE public.analysis_preflights
             SET expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`, [exhausted.preflight_id]
        );
        await serviceQuery('SELECT public.purge_expired_analysis_v2_preflights(10)');
        expect((await db.query<{
            status: string;
            channel: string;
            state: string;
            dispatch: string;
            error_code: string | null;
            blocked_at: string | null;
            retry_exhausted_at: string | null;
        }>(`SELECT status,analysis_entry_channel AS channel,
                   beta_prepare_state AS state,
                   beta_prepare_dispatch_state AS dispatch,error_code,blocked_at,
                   beta_prepare_retry_exhausted_at AS retry_exhausted_at
            FROM public.analysis_preflights WHERE id=$1`, [exhausted.preflight_id])).rows)
            .toEqual([{
                status: 'expired',
                channel: 'betatest',
                state: 'expired',
                dispatch: 'completed',
                error_code: null,
                blocked_at: null,
                retry_exhausted_at: null,
            }]);
    });

    it('expires a retry-ceiling delivery that arrives after the preflight TTL', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1)', [USER_ID]);
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
            )`, [USER_ID, AUDIT_HASH]
        );
        const created = await createDedicatedBetaPreflight({
            idempotencyKey: 'betatest-expired-retry-key-000001',
        });
        await serviceQuery(
            `SELECT public.mark_analysis_beta_preflight_prepare_dispatched(
                $1,$2,1,$3
            )`, [created.preflight_id, USER_ID, PREPARE_TOKEN]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`, [created.preflight_id]
        );

        expect((await serviceQuery<{ exhausted: boolean }>(
            `SELECT public.mark_analysis_beta_preflight_prepare_retry_exhausted(
                $1,$2,1,$3
            ) AS exhausted`, [created.preflight_id, USER_ID, PREPARE_TOKEN]
        )).rows).toEqual([{ exhausted: true }]);
        expect((await db.query<{
            status: string;
            channel: string;
            state: string;
            dispatch: string;
            error_code: string | null;
            blocked_at: string | null;
            retry_exhausted_at: string | null;
        }>(`SELECT status,analysis_entry_channel AS channel,
                   beta_prepare_state AS state,
                   beta_prepare_dispatch_state AS dispatch,error_code,blocked_at,
                   beta_prepare_retry_exhausted_at AS retry_exhausted_at
            FROM public.analysis_preflights WHERE id=$1`, [created.preflight_id])).rows)
            .toEqual([{
                status: 'expired',
                channel: 'betatest',
                state: 'expired',
                dispatch: 'completed',
                error_code: null,
                blocked_at: null,
                retry_exhausted_at: null,
            }]);
        expect((await serviceQuery<{
            claimed: boolean; prepare_state: string; claim_disposition: string;
        }>(`SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [
                created.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN,
            ])).rows).toEqual([{
            claimed: false,
            prepare_state: 'expired',
            claim_disposition: 'terminal',
        }]);
    });

    it('terminalizes a queued beta prepare when the gate is disabled before claim', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1)', [USER_ID]);
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
            )`, [USER_ID, AUDIT_HASH]
        );
        const created = await createDedicatedBetaPreflight();
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
        const claim = await serviceQuery<{ claimed: boolean; prepare_state: string }>(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [created.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        );
        expect(claim.rows).toEqual([{
            claimed: false,
            prepare_state: 'capacity_blocked',
            claim_disposition: 'terminal',
        }]);
        expect((await db.query<{
            status: string; error_code: string; channel: string; state: string;
        }>(`SELECT status,error_code,analysis_entry_channel AS channel,
                   beta_prepare_state AS state
            FROM public.analysis_preflights WHERE id=$1`, [created.preflight_id])).rows)
            .toEqual([{
                status: 'blocked', error_code: 'BETA_CAPACITY_UNAVAILABLE',
                channel: 'betatest', state: 'capacity_blocked',
            }]);
    });

    it('atomically recovers hold-commit worker crashes and permits ordinary dispatch only after prepared', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1)', [USER_ID]);
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
            )`, [USER_ID, AUDIT_HASH]
        );
        const created = await createDedicatedBetaPreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count=120,target_following_count=140
             WHERE id=$1`, [created.preflight_id]
        );
        await serviceQuery(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(snapshots())]
        );
        expect((await serviceQuery<{ claimed: boolean; prepare_state: string }>(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [created.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        )).rows).toEqual([{
            claimed: true, prepare_state: 'preparing', claim_disposition: 'claimed',
        }]);
        await serviceQuery(
            `SELECT public.prepare_analysis_beta_apify_preflight_credit(
                $1,$2,1,$3,$4,'primary',0.005200000000,300
            )`, [created.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        );
        // Simulate a worker dying after the DB commit but before its response.
        expect((await serviceQuery<{ claimed: boolean; prepare_state: string }>(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [created.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        )).rows).toEqual([{
            claimed: false, prepare_state: 'prepared', claim_disposition: 'terminal',
        }]);
        expect((await serviceQuery<{ should_enqueue: boolean }>(
            `SELECT * FROM public.reserve_analysis_v2_preflight_dispatch($1,$2,$3)`,
            [created.preflight_id, USER_ID, DISPATCH_TOKEN]
        )).rows).toEqual([expect.objectContaining({ should_enqueue: true })]);
    });

    it('persists capacity failure and resolves an ambiguous post-hold block as prepared', async () => {
        await db.query('INSERT INTO public.users(id) VALUES ($1)', [USER_ID]);
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
            )`, [USER_ID, AUDIT_HASH]
        );
        const blocked = await createDedicatedBetaPreflight();
        await serviceQuery(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [blocked.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        );
        expect((await serviceQuery<{ result: string }>(
            `SELECT public.block_analysis_beta_preflight_capacity(
                $1,$2,1,$3,$4
            ) AS result`, [blocked.preflight_id, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        )).rows).toEqual([{ result: 'blocked' }]);

        const secondKey = 'betatest-entry-key-000002';
        const secondToken = '41000000-0000-4000-8000-000000000002';
        const secondClaim = '42000000-0000-4000-8000-000000000002';
        const prepared = await createDedicatedBetaPreflight({
            idempotencyKey: secondKey, prepareToken: secondToken,
        });
        await db.query(
            `UPDATE public.analysis_preflights
             SET target_followers_count=120,target_following_count=140 WHERE id=$1`,
            [prepared.preflight_id]
        );
        await serviceQuery(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(snapshots())]
        );
        await serviceQuery(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [prepared.preflight_id, USER_ID, secondToken, secondClaim]
        );
        await serviceQuery(
            `SELECT public.prepare_analysis_beta_apify_preflight_credit(
                $1,$2,1,$3,$4,'primary',0.005200000000,300
            )`, [prepared.preflight_id, USER_ID, secondToken, secondClaim]
        );
        expect((await serviceQuery<{ result: string }>(
            `SELECT public.block_analysis_beta_preflight_capacity(
                $1,$2,1,$3,$4
            ) AS result`, [prepared.preflight_id, USER_ID, secondToken, secondClaim]
        )).rows).toEqual([{ result: 'prepared' }]);
    });

    it('normalizes every historical beta expiry writer into a clean terminal shape', async () => {
        await db.query('INSERT INTO public.users(id) VALUES($1)', [USER_ID]);
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1,TRUE,pg_catalog.clock_timestamp()+INTERVAL '1 hour',$2
            )`,
            [USER_ID, AUDIT_HASH]
        );

        const pendingPrepareExpiry = await createDedicatedBetaPreflight({
            idempotencyKey: 'betatest-expiry-prepare-claim-000001',
        });
        await db.query(
            `UPDATE public.analysis_preflights
             SET expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`,
            [pendingPrepareExpiry.preflight_id]
        );
        expect((await serviceQuery<{
            claimed: boolean;
            prepare_state: string;
            claim_disposition: string;
        }>(`SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [
                pendingPrepareExpiry.preflight_id,
                USER_ID,
                pendingPrepareExpiry.prepare_token,
                '42000000-0000-4000-8000-000000000030',
            ])).rows).toEqual([{
            claimed: false,
            prepare_state: 'expired',
            claim_disposition: 'terminal',
        }]);

        const claimedExpiry = await createDedicatedBetaPreflight({
            idempotencyKey: 'betatest-expiry-claim-000001',
            prepareToken: '41000000-0000-4000-8000-000000000030',
        });
        await db.query(
            `UPDATE public.analysis_preflights
             SET expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`,
            [claimedExpiry.preflight_id]
        );
        await serviceQuery(
            `SELECT * FROM public.claim_analysis_v2_preflight($1,$2,300)`,
            [claimedExpiry.preflight_id, CLAIM_TOKEN]
        );

        const purgeExpiry = await createDedicatedBetaPreflight({
            idempotencyKey: 'betatest-expiry-purge-000001',
            prepareToken: '41000000-0000-4000-8000-000000000031',
        });
        const purgeClaim = '42000000-0000-4000-8000-000000000031';
        await serviceQuery(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`,
            [
                purgeExpiry.preflight_id,
                USER_ID,
                purgeExpiry.prepare_token,
                purgeClaim,
            ]
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`,
            [purgeExpiry.preflight_id]
        );
        await serviceQuery(
            'SELECT public.purge_expired_analysis_v2_preflights(10)'
        );

        const createExpiry = await createDedicatedBetaPreflight({
            idempotencyKey: 'betatest-expiry-create-000001',
            prepareToken: '41000000-0000-4000-8000-000000000032',
        });
        await db.query(
            `UPDATE public.analysis_preflights
             SET expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`,
            [createExpiry.preflight_id]
        );
        await serviceQuery(
            `SELECT * FROM public.create_or_replay_analysis_v2_preflight(
                $1,'owner@example.com','google','ordinary.target',
                'ordinary-after-stale-beta-000001','production',
                '{}'::JSONB,'{}'::JSONB,'test','{}'::JSONB,'{}'::JSONB
            )`,
            [USER_ID]
        );

        const stored = await db.query<{
            id: string;
            status: string;
            channel: string;
            state: string;
            dispatch: string;
            lease_token: string | null;
            lease_expires_at: string | null;
            retry_exhausted_at: string | null;
            completed_at: string | null;
            pii_scrubbed_at: string | null;
        }>(`SELECT id,status,analysis_entry_channel AS channel,
                   beta_prepare_state AS state,
                   beta_prepare_dispatch_state AS dispatch,
                   beta_prepare_lease_token AS lease_token,
                   beta_prepare_lease_expires_at AS lease_expires_at,
                   beta_prepare_retry_exhausted_at AS retry_exhausted_at,
                   beta_prepare_completed_at AS completed_at,
                   pii_scrubbed_at
            FROM public.analysis_preflights
            WHERE id=ANY($1::UUID[])
            ORDER BY id`, [[
                pendingPrepareExpiry.preflight_id,
                claimedExpiry.preflight_id,
                purgeExpiry.preflight_id,
                createExpiry.preflight_id,
            ]]);
        expect(stored.rows).toHaveLength(4);
        for (const row of stored.rows) {
            expect(row).toMatchObject({
                status: 'expired',
                channel: 'betatest',
                state: 'expired',
                dispatch: 'completed',
                lease_token: null,
                lease_expires_at: null,
                retry_exhausted_at: null,
            });
            expect(row.completed_at).not.toBeNull();
        }
        expect(stored.rows.find(row => row.id === purgeExpiry.preflight_id)
            ?.pii_scrubbed_at).not.toBeNull();
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_preflights
             WHERE idempotency_key='ordinary-after-stale-beta-000001'
               AND beta_entry_provenance IS NULL`
        )).rows).toEqual([{ count: 1 }]);
    });

    it('rejects actually expired initial/fresh leases and still replays an existing authorization after gate-off', async () => {
        await seedPendingBetaPreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET status='processing',lease_token=$2,
                 lease_expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`, [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await expect(reserveInitial()).rejects.toThrow(
            /ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH/
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET status='ready',consumed_request_id=NULL,
                 admission_status='processing',admission_generation=1,
                 admission_claim_token=$2,
                 admission_lease_expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE id=$1`, [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await expect(reserveFresh(1)).rejects.toThrow(
            /ANALYSIS_PREFLIGHT_PROVIDER_RUN_FENCE_MISMATCH/
        );

        await db.query(
            `UPDATE public.analysis_preflights
             SET status='processing',lease_token=$2,
                 lease_expires_at=pg_catalog.clock_timestamp()+INTERVAL '5 minutes'
             WHERE id=$1`, [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        const authorization = await reserveInitial();
        expect(authorization.created).toBe(true);
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
        const replay = await reserveInitial();
        expect(replay).toEqual({ ...authorization, created: false });
    });

    it.each(PLAN_IDS)('keeps the %s frozen TS and DB budget catalogs byte-identical', async planId => {
        const result = await db.query<{ catalog: Record<string, number> }>(
            `SELECT public.analysis_beta_plan_operation_budget_map($1) AS catalog`,
            [planId]
        );
        expect(result.rows[0]?.catalog).toEqual(
            getBetaApifyOperationBudgetCatalog(planId, {
                APIFY_PROFILE_ESTIMATED_COST_PER_RESULT_USD: '0.000001',
            })
        );
    });

    it.each(PLAN_IDS)('atomically admits one complete %s beta request and bootstrap job', async planId => {
        await seedReadyBetaAdmission(planId);
        const admitted = await admitBetaPlan({ planId });
        expect(admitted).toMatchObject({
            initialJobKey: 'coordinator:bootstrap', replayed: false,
        });
        const state = await db.query<{
            preflight_status: string;
            consumed_request_id: string;
            request_channel: string;
            access_mode: string;
            selected_plan: string;
            background_processing: boolean;
            job_key: string;
            job_track: string;
            job_kind: string;
            job_batch: number | null;
            required_keys: string[];
            allocation_state: string;
            allocation_request_id: string;
            policy_mode: string;
            policy_version: string;
            policy_hash_valid: boolean;
            reservation_count: number;
            active_count: number;
        }>(
            `SELECT preflight.status AS preflight_status,
                    preflight.consumed_request_id,
                    request.analysis_entry_channel AS request_channel,
                    request.plan_access_mode_snapshot AS access_mode,
                    request.selected_plan_id_snapshot AS selected_plan,
                    request.background_processing,
                    job.job_key, job.track AS job_track, job.kind AS job_kind,
                    job.batch AS job_batch, job.required_job_keys AS required_keys,
                    allocation.lifecycle_state AS allocation_state,
                    allocation.request_id AS allocation_request_id,
                    policy.mode AS policy_mode, policy.policy_version,
                    policy.policy_hash = public.analysis_beta_provider_policy_hash(
                        request.target_instagram_id, policy.operation_slot_map
                    ) AS policy_hash_valid,
                    pg_catalog.count(reservation.*)::INTEGER AS reservation_count,
                    pg_catalog.count(reservation.*) FILTER (
                        WHERE reservation.lifecycle_state = 'active'
                    )::INTEGER AS active_count
             FROM public.analysis_preflights AS preflight
             JOIN public.analysis_requests AS request
               ON request.id = preflight.consumed_request_id
             JOIN public.analysis_pipeline_jobs AS job
               ON job.request_id = request.id AND job.job_key = 'coordinator:bootstrap'
             JOIN public.analysis_beta_pool_allocations AS allocation
               ON allocation.request_id = request.id
             JOIN public.analysis_beta_pool_reservations AS reservation
               ON reservation.allocation_id = allocation.id
             JOIN public.analysis_v2_provider_execution_policies AS policy
               ON policy.request_id = request.id
             WHERE preflight.id = $1
             GROUP BY preflight.id, request.id, job.request_id, job.job_key,
                      allocation.id, policy.request_id`,
            [PREFLIGHT_ID]
        );
        expect(state.rows).toEqual([expect.objectContaining({
            preflight_status: 'consumed',
            consumed_request_id: admitted.requestId,
            request_channel: 'betatest', access_mode: 'production',
            selected_plan: planId, background_processing: false,
            job_key: 'coordinator:bootstrap', job_track: 'coordinator',
            job_kind: 'bootstrap', job_batch: null, required_keys: [],
            allocation_state: 'active', allocation_request_id: admitted.requestId,
            policy_mode: 'betatest_free_pool',
            policy_version: 'betatest-free-pool-v1', policy_hash_valid: true,
            reservation_count: 8, active_count: 8,
        })]);
    });

    it('replays stored identity after grant disable/expiry and ignores a racing caller replan', async () => {
        await seedReadyBetaAdmission('basic');
        const admitted = await admitBetaPlan();
        await db.query(
            `UPDATE public.analysis_beta_access_grants
             SET enabled = FALSE, expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
             WHERE user_id = $1`,
            [USER_ID]
        );
        await expect(replayBetaPlan()).resolves.toEqual({ ...admitted, replayed: true });
        const alternateSlots = Object.fromEntries(
            OPERATIONS.map(operation => [operation, 'septenary'])
        );
        await expect(admitBetaPlan({ slots: alternateSlots }))
            .resolves.toEqual({ ...admitted, replayed: true });
        const state = await db.query<{ requests: number; jobs: number; allocations: number }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_requests) AS requests,
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_pipeline_jobs) AS jobs,
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_beta_pool_allocations) AS allocations`
        );
        expect(state.rows).toEqual([{ requests: 1, jobs: 1, allocations: 1 }]);
    });

    it('loads consumed identity without current gate/grant and rejects a different plan', async () => {
        await seedReadyBetaAdmission('basic');
        const admitted = await admitBetaPlan();
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
        await db.query(
            `UPDATE public.analysis_beta_access_grants
             SET enabled=FALSE, expires_at=pg_catalog.clock_timestamp()-INTERVAL '1 second'
             WHERE user_id=$1`,
            [USER_ID]
        );

        await expect(replayConsumedBetaPlan()).resolves.toEqual({
            ...admitted, replayed: true,
        });
        await expect(replayConsumedBetaPlan('plus')).rejects.toThrow(
            /ANALYSIS_BETA_PLAN_REPLAY_IDENTITY_CONFLICT/
        );
    });

    it('rejects fresh admission behind the database gate without partial activation and preserves consumed replay', async () => {
        await seedReadyBetaAdmission('basic');
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');

        await expect(admitBetaPlan()).rejects.toThrow(
            /ANALYSIS_BETA_ACCESS_UNAVAILABLE/
        );
        expect((await db.query<{
            requests: number; jobs: number; policies: number;
            active_allocations: number; active_reservations: number;
        }>(`SELECT
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_requests) AS requests,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_pipeline_jobs) AS jobs,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_v2_provider_execution_policies) AS policies,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_beta_pool_allocations
                 WHERE lifecycle_state='active') AS active_allocations,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_beta_pool_reservations
                 WHERE lifecycle_state='active') AS active_reservations`)).rows).toEqual([{
            requests: 0,
            jobs: 0,
            policies: 0,
            active_allocations: 0,
            active_reservations: 0,
        }]);

        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
        const admitted = await admitBetaPlan();
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');
        await expect(admitBetaPlan()).resolves.toEqual({
            ...admitted,
            replayed: true,
        });
    });

    it('requires durable beta entry and prepared fences before fresh admission', async () => {
        await seedReadyBetaAdmission('basic');
        await db.query(
            `UPDATE public.analysis_preflights
             SET beta_entry_provenance=NULL,
                 beta_prepare_generation=0,
                 beta_prepare_token=NULL,
                 beta_prepare_state=NULL,
                 beta_prepare_dispatch_state=NULL,
                 beta_prepare_dispatched_at=NULL,
                 beta_prepare_lease_token=NULL,
                 beta_prepare_lease_expires_at=NULL,
                 beta_prepare_completed_at=NULL,
                 beta_prepare_retry_exhausted_at=NULL
             WHERE id=$1`,
            [PREFLIGHT_ID]
        );

        await expect(admitBetaPlan()).rejects.toThrow(
            /ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/
        );
        expect((await db.query<{ requests: number; active: number }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_requests) AS requests,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_beta_pool_allocations
                 WHERE lifecycle_state='active') AS active`
        )).rows).toEqual([{ requests: 0, active: 0 }]);
    });

    it('rechecks gate and active grant inside shared beta exclusion mutation', async () => {
        await seedPendingBetaPreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET exclusion_decision='pending' WHERE id=$1`,
            [PREFLIGHT_ID]
        );
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');

        await expect(serviceQuery(
            `SELECT public.set_analysis_v2_preflight_exclusion(
                $1,$2,'exclude','candidate.user'
            )`,
            [PREFLIGHT_ID, USER_ID]
        )).rejects.toThrow(/ANALYSIS_BETA_ACCESS_UNAVAILABLE/);
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(TRUE)');
        await db.query(
            `UPDATE public.analysis_beta_access_grants
             SET enabled=FALSE WHERE user_id=$1`,
            [USER_ID]
        );
        await expect(serviceQuery(
            `SELECT public.set_analysis_v2_preflight_exclusion(
                $1,$2,'exclude','candidate.user'
            )`,
            [PREFLIGHT_ID, USER_ID]
        )).rejects.toThrow(/ANALYSIS_BETA_ACCESS_UNAVAILABLE/);

        const stored = await db.query<{
            decision: string;
            excluded: string | null;
        }>(
            `SELECT exclusion_decision AS decision,
                    excluded_instagram_id AS excluded
             FROM public.analysis_preflights WHERE id=$1`,
            [PREFLIGHT_ID]
        );
        expect(stored.rows).toEqual([{ decision: 'pending', excluded: null }]);
    });

    it('does not apply beta gate/grant requirements to an ordinary exclusion mutation', async () => {
        await db.query('INSERT INTO public.users(id) VALUES($1)', [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id,user_id,status,access_mode,target_instagram_id,expires_at,
                exclusion_decision
             ) VALUES(
                $1,$2,'pending','production',$3,
                pg_catalog.clock_timestamp()+INTERVAL '30 minutes','pending'
             )`,
            [PREFLIGHT_ID, USER_ID, TARGET]
        );
        await serviceQuery('SELECT public.set_analysis_beta_runtime_gate(FALSE)');

        const mutation = await serviceQuery<{ changed: boolean }>(
            `SELECT public.set_analysis_v2_preflight_exclusion(
                $1,$2,'skip',NULL
            ) AS changed`,
            [PREFLIGHT_ID, USER_ID]
        );

        expect(mutation.rows).toEqual([{ changed: true }]);
    });

    it('returns null before consumption and rejects corrupted consumed job integrity', async () => {
        await seedReadyBetaAdmission('basic');
        await expect(replayConsumedBetaPlan()).resolves.toBeNull();
        const admitted = await admitBetaPlan();
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET input_hash=$2
             WHERE request_id=$1 AND job_key='coordinator:bootstrap'`,
            [admitted.requestId, 'f'.repeat(64)]
        );
        await expect(replayConsumedBetaPlan()).rejects.toThrow(
            /ANALYSIS_BETA_ALLOCATION_CONFLICT/
        );
    });

    it('preserves terminal settled replay without requiring a current grant', async () => {
        await seedReadyBetaAdmission('basic');
        const admitted = await admitBetaPlan();
        await db.query(`UPDATE public.analysis_requests SET status='failed' WHERE id=$1`, [admitted.requestId]);
        await serviceQuery(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal')`,
            [admitted.allocationId]
        );
        await db.query(`DELETE FROM public.analysis_beta_access_grants WHERE user_id=$1`, [USER_ID]);
        await expect(replayBetaPlan()).resolves.toEqual({ ...admitted, replayed: true });
    });

    it('replays a partially settled terminal allocation with one ambiguous family still active', async () => {
        await seedReadyBetaAdmission('basic');
        const admitted = await admitBetaPlan();
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status
             ) SELECT $1, 'coordinator:bootstrap', $2, job.input_hash, $3,
                $4, 'apify', 'actor/test', 'tertiary', 0.68, 'starting'
             FROM public.analysis_pipeline_jobs AS job
             WHERE job.request_id=$1 AND job.job_key='coordinator:bootstrap'`,
            [
                admitted.requestId,
                `relationship-followers:${DIGEST}`,
                CLAIM_TOKEN,
                RESERVATION_TOKEN,
            ]
        );
        await db.query(
            `UPDATE public.analysis_requests SET status='failed' WHERE id=$1`,
            [admitted.requestId]
        );
        const partial = await serviceQuery<JsonRow<{
            lifecycleState: string;
            heldFamilies: number;
        }>>(
            `SELECT public.settle_analysis_beta_apify_credit_allocation(
                $1, 'request_terminal'
            ) AS result`,
            [admitted.allocationId]
        );
        expect(partial.rows[0].result).toMatchObject({
            lifecycleState: 'active',
            heldFamilies: 1,
        });
        const familyStates = await db.query<{ state: string; count: number }>(
            `SELECT lifecycle_state AS state, pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_beta_pool_reservations
             WHERE allocation_id=$1
             GROUP BY lifecycle_state
             ORDER BY lifecycle_state`,
            [admitted.allocationId]
        );
        expect(familyStates.rows).toEqual([
            { state: 'active', count: 1 },
            { state: 'settled', count: 7 },
        ]);
        await expect(replayBetaPlan()).resolves.toEqual({
            ...admitted,
            replayed: true,
        });
    });

    it('rejects an active allocation corrupted to have no active reservation family', async () => {
        await seedReadyBetaAdmission('basic');
        await admitBetaPlan();
        await db.query(
            `UPDATE public.analysis_beta_pool_reservations
             SET lifecycle_state='settled', actual_usd=0,
                 released_usd=reserved_usd,
                 settled_at=pg_catalog.clock_timestamp(),
                 settlement_reason='request_terminal'`
        );
        await expect(replayBetaPlan()).rejects.toThrow(
            /ANALYSIS_BETA_ALLOCATION_CONFLICT/
        );
    });

    it('rejects mixed active and settled reservation families for a nonterminal request', async () => {
        await seedReadyBetaAdmission('basic');
        const admitted = await admitBetaPlan();
        await db.query(
            `UPDATE public.analysis_beta_pool_reservations
             SET lifecycle_state='settled', actual_usd=0,
                 released_usd=reserved_usd,
                 settled_at=pg_catalog.clock_timestamp(),
                 settlement_reason='request_terminal'
             WHERE allocation_id=$1 AND operation_family='target-comments'`,
            [admitted.allocationId]
        );
        await expect(replayBetaPlan()).rejects.toThrow(
            /ANALYSIS_BETA_ALLOCATION_CONFLICT/
        );
    });

    it('rejects a settled allocation attached to a nonterminal request', async () => {
        await seedReadyBetaAdmission('basic');
        const admitted = await admitBetaPlan();
        await db.query(
            `UPDATE public.analysis_beta_pool_reservations
             SET lifecycle_state='settled', actual_usd=0,
                 released_usd=reserved_usd,
                 settled_at=pg_catalog.clock_timestamp(),
                 settlement_reason='request_terminal'
             WHERE allocation_id=$1`,
            [admitted.allocationId]
        );
        await db.query(
            `UPDATE public.analysis_beta_pool_allocations
             SET lifecycle_state='settled', settled_at=pg_catalog.clock_timestamp(),
                 settlement_reason='request_terminal', updated_at=pg_catalog.clock_timestamp()
             WHERE id=$1`,
            [admitted.allocationId]
        );
        await expect(replayBetaPlan()).rejects.toThrow(
            /ANALYSIS_BETA_ALLOCATION_CONFLICT/
        );
    });

    it('rejects corrupt provider policy, bootstrap job, and reservation integrity on replay', async () => {
        await seedReadyBetaAdmission('basic');
        const admitted = await admitBetaPlan();
        await db.query(
            `UPDATE public.analysis_v2_provider_execution_policies
             SET policy_hash=$2 WHERE request_id=$1`,
            [admitted.requestId, 'f'.repeat(64)]
        );
        await expect(replayBetaPlan()).rejects.toThrow(/ANALYSIS_BETA_(?:PROVIDER_POLICY|ALLOCATION)_CONFLICT/);
        await db.query(
            `UPDATE public.analysis_v2_provider_execution_policies
             SET policy_hash=public.analysis_beta_provider_policy_hash(target_instagram_id, operation_slot_map)
             WHERE request_id=$1`,
            [admitted.requestId]
        );
        await db.query(
            `UPDATE public.analysis_pipeline_jobs SET input_hash=$2
             WHERE request_id=$1 AND job_key='coordinator:bootstrap'`,
            [admitted.requestId, 'f'.repeat(64)]
        );
        await expect(replayBetaPlan()).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET input_hash=pg_catalog.encode(extensions.digest(pg_catalog.convert_to(
                'analysis-v2-job-input-v1' || pg_catalog.chr(10) || pg_catalog.lower($1::TEXT)
                || pg_catalog.chr(10) || 'coordinator:bootstrap','UTF8'),'sha256'),'hex')
             WHERE request_id=$1 AND job_key='coordinator:bootstrap'`,
            [admitted.requestId]
        );
        await db.query(
            `UPDATE public.analysis_beta_pool_reservations
             SET credential_slot='septenary'
             WHERE allocation_id=$1 AND operation_family='relationship-followers'`,
            [admitted.allocationId]
        );
        await expect(replayBetaPlan()).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_CONFLICT/);
    });

    it('rejects wrong token/generation and stale admission without partial durable work', async () => {
        await seedReadyBetaAdmission('basic');
        await expect(admitBetaPlan({ token: CLAIM_TOKEN })).rejects.toThrow(
            /ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/
        );
        await expect(admitBetaPlan({ generation: 2 })).rejects.toThrow(
            /ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_refreshed_at=pg_catalog.clock_timestamp() - INTERVAL '3 minutes'
             WHERE id=$1`,
            [PREFLIGHT_ID]
        );
        await expect(admitBetaPlan()).rejects.toThrow(/ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/);
        const state = await db.query<{ requests: number; jobs: number; lifecycle: string; reservations: number }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_requests) AS requests,
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_pipeline_jobs) AS jobs,
                allocation.lifecycle_state AS lifecycle,
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_beta_pool_reservations) AS reservations
             FROM public.analysis_beta_pool_allocations AS allocation
             WHERE allocation.preflight_id=$1`,
            [PREFLIGHT_ID]
        );
        expect(state.rows).toEqual([{ requests: 0, jobs: 0, lifecycle: 'preflight_held', reservations: 1 }]);
    });

    it('rolls back underbudget, overbudget, and insufficient-capacity admissions', async () => {
        await seedReadyBetaAdmission('basic');
        const frozen = getBetaApifyOperationBudgetCatalog('basic', {});
        await expect(admitBetaPlan({
            budgets: { ...frozen, 'candidate-likers': frozen['candidate-likers'] - 0.000000000001 },
        })).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_INVALID/);
        await expect(admitBetaPlan({
            budgets: { ...frozen, 'candidate-likers': frozen['candidate-likers'] + 0.000000000001 },
        })).rejects.toThrow(/ANALYSIS_BETA_ALLOCATION_INVALID/);
        await db.query(
            `UPDATE public.analysis_apify_credit_snapshots
             SET monthly_limit_usd=0.1, monthly_usage_usd=0`
        );
        await expect(admitBetaPlan()).rejects.toThrow(/ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/);
        const state = await db.query<{ requests: number; jobs: number; lifecycle: string; reservations: number }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_requests) AS requests,
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_pipeline_jobs) AS jobs,
                allocation.lifecycle_state AS lifecycle,
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_beta_pool_reservations) AS reservations
             FROM public.analysis_beta_pool_allocations AS allocation
             WHERE allocation.preflight_id=$1`,
            [PREFLIGHT_ID]
        );
        expect(state.rows).toEqual([{ requests: 0, jobs: 0, lifecycle: 'preflight_held', reservations: 1 }]);
    });

    it('keeps both admission RPCs service-only and ordinary access modes unable to opt in', async () => {
        const privileges = await db.query<{ replay_public: boolean; replay_service: boolean; consumed_auth: boolean; consumed_service: boolean; admit_auth: boolean; admit_service: boolean }>(
            `SELECT
                pg_catalog.has_function_privilege('public','public.load_analysis_v2_betatest_plan_replay(uuid,uuid,uuid,integer,text)','EXECUTE') AS replay_public,
                pg_catalog.has_function_privilege('service_role','public.load_analysis_v2_betatest_plan_replay(uuid,uuid,uuid,integer,text)','EXECUTE') AS replay_service,
                pg_catalog.has_function_privilege('authenticated','public.load_analysis_v2_betatest_consumed_replay(uuid,uuid,text)','EXECUTE') AS consumed_auth,
                pg_catalog.has_function_privilege('service_role','public.load_analysis_v2_betatest_consumed_replay(uuid,uuid,text)','EXECUTE') AS consumed_service,
                pg_catalog.has_function_privilege('authenticated','public.admit_analysis_v2_betatest_plan(uuid,uuid,uuid,integer,text,jsonb,jsonb,integer)','EXECUTE') AS admit_auth,
                pg_catalog.has_function_privilege('service_role','public.admit_analysis_v2_betatest_plan(uuid,uuid,uuid,integer,text,jsonb,jsonb,integer)','EXECUTE') AS admit_service`
        );
        expect(privileges.rows).toEqual([{
            replay_public: false, replay_service: true,
            consumed_auth: false, consumed_service: true,
            admit_auth: false, admit_service: true,
        }]);

        await db.query(`INSERT INTO public.users(id) VALUES($1)`, [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id,user_id,status,access_mode,target_instagram_id,expires_at,
                admission_token,admission_generation,admission_selected_plan_id
             ) VALUES($1,$2,'ready','production',$3,pg_catalog.clock_timestamp()+INTERVAL '30 minutes',$4,1,'basic')`,
            [PREFLIGHT_ID, USER_ID, TARGET, ADMISSION_TOKEN]
        );
        await expect(replayBetaPlan()).rejects.toThrow(/ANALYSIS_BETA_REQUEST_NOT_ELIGIBLE/);
        const counts = await db.query<{ requests: number; allocations: number }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_requests) AS requests,
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_beta_pool_allocations) AS allocations`
        );
        expect(counts.rows).toEqual([{ requests: 0, allocations: 0 }]);
    });

    it('durably exhausts three betatest fresh-admission failures with stale-token fencing', async () => {
        await seedPendingBetaPreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET status='ready', admission_status='pending', admission_generation=1,
                 admission_dispatch_generation=1, admission_dispatch_token=$2,
                 admission_dispatch_state='reserved'
             WHERE id=$1`,
            [PREFLIGHT_ID, DISPATCH_TOKEN]
        );
        const tokens = [CLAIM_TOKEN, CLAIM_TOKEN_B, CLAIM_TOKEN_C];
        for (let index = 0; index < tokens.length; index++) {
            const token = tokens[index];
            const claimed = await serviceQuery<{
                claimed: boolean; admission_status: string; analysis_entry_channel: string;
            }>(
                `SELECT * FROM public.claim_analysis_v2_preflight_admission(
                    $1, 1, 1, $2, $3, 60
                )`,
                [PREFLIGHT_ID, DISPATCH_TOKEN, token]
            );
            expect(claimed.rows[0]).toMatchObject({
                claimed: true,
                admission_status: 'processing',
                analysis_entry_channel: 'betatest',
            });
            const failed = await serviceQuery<{
                admission_status: string; failure_count: number;
                admission_error_code: string | null;
            }>(
                `SELECT * FROM public.record_analysis_v2_preflight_admission_failure(
                    $1, 1, $2
                )`,
                [PREFLIGHT_ID, token]
            );
            expect(failed.rows[0]).toEqual({
                admission_status: index === 2 ? 'blocked' : 'pending',
                failure_count: index + 1,
                admission_error_code: index === 2
                    ? 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE'
                    : null,
            });
            await expect(serviceQuery(
                `SELECT * FROM public.record_analysis_v2_preflight_admission_failure(
                    $1, 1, $2
                )`,
                [PREFLIGHT_ID, token]
            )).rejects.toThrow(/ANALYSIS_V2_PREFLIGHT_NOT_READY/);
        }
        const state = await db.query<{
            admission_status: string; admission_failure_count: number;
            admission_error_code: string; admission_claim_token: string | null;
            admission_lease_expires_at: string | null;
        }>(
            `SELECT admission_status,admission_failure_count,admission_error_code,
                    admission_claim_token,admission_lease_expires_at
             FROM public.analysis_preflights WHERE id=$1`,
            [PREFLIGHT_ID]
        );
        expect(state.rows[0]).toEqual({
            admission_status: 'blocked', admission_failure_count: 3,
            admission_error_code: 'ANALYSIS_V2_FRESH_PROFILE_UNAVAILABLE',
            admission_claim_token: null, admission_lease_expires_at: null,
        });
        const noWork = await db.query<{ requests: number; runs: number }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_requests) AS requests,
                (SELECT pg_catalog.count(*)::INTEGER FROM public.analysis_preflight_provider_runs) AS runs`
        );
        expect(noWork.rows).toEqual([{ requests: 0, runs: 0 }]);
    });

    it('keeps legacy senary valid, septenary invalid, and beta secondary invalid', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version,
                plan_access_mode_snapshot, test_entitlement_jti_hash
             ) VALUES ($1, $2, $3, 'pending', 'v2', 'test_entitlement', $4)`,
            [REQUEST_ID, USER_ID, TARGET, JTI_HASH]
        );
        await expect(db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'test_operation_split', 'authorized-free-e2e-v1', $2,
                $3, $4::JSONB, $5
             )`,
            [REQUEST_ID, JTI_HASH, TARGET, JSON.stringify(legacySlots), 'f'.repeat(64)]
        )).resolves.toBeDefined();

        await db.query('DELETE FROM public.analysis_v2_provider_execution_policies');
        await expect(db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'test_operation_split', 'authorized-free-e2e-v1', $2,
                $3, $4::JSONB, $5
             )`,
            [
                REQUEST_ID,
                JTI_HASH,
                TARGET,
                JSON.stringify({ ...legacySlots, 'target-comments': 'septenary' }),
                'f'.repeat(64),
            ]
        )).rejects.toThrow(/branch_check/);

        await expect(db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'betatest_free_pool', 'betatest-free-pool-v1', NULL,
                $2, $3::JSONB, $4
             )`,
            [
                REQUEST_ID,
                TARGET,
                JSON.stringify({ ...betaSlots, 'target-comments': 'secondary' }),
                'f'.repeat(64),
            ]
        )).rejects.toThrow(/branch_check/);
    });

    it('atomically binds beta policy before the first activation completes', async () => {
        await seedPendingBetaRequest();
        const active = await activateBeta();
        expect(active).toMatchObject({
            lifecycleState: 'active',
            operationSlotMap: betaSlots,
        });
        const state = await db.query<{
            channel: string;
            mode: string;
            version: string;
            entitlement: string | null;
            slots: Record<string, string>;
        }>(
            `SELECT request.analysis_entry_channel AS channel,
                    policy.mode, policy.policy_version AS version,
                    policy.entitlement_jti_hash AS entitlement,
                    policy.operation_slot_map AS slots
             FROM public.analysis_requests AS request
             JOIN public.analysis_v2_provider_execution_policies AS policy
               ON policy.request_id = request.id
             WHERE request.id = $1`,
            [REQUEST_ID]
        );
        expect(state.rows).toEqual([{
            channel: 'betatest',
            mode: 'betatest_free_pool',
            version: 'betatest-free-pool-v1',
            entitlement: null,
            slots: betaSlots,
        }]);
    });

    it('rolls back policy/state/channel together when binding conflicts', async () => {
        await seedPendingBetaRequest();
        await db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'betatest_free_pool', 'betatest-free-pool-v1', NULL,
                $2, $3::JSONB, $4
             )`,
            [REQUEST_ID, TARGET, JSON.stringify(betaSlots), 'f'.repeat(64)]
        );
        await expect(activateBeta()).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT/
        );
        const state = await db.query<{
            lifecycle: string;
            request_id: string | null;
            channel: string;
            reservation_count: number;
        }>(
            `SELECT allocation.lifecycle_state AS lifecycle,
                    allocation.request_id,
                    request.analysis_entry_channel AS channel,
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_beta_pool_reservations) AS reservation_count
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_requests AS request ON request.id = $1`,
            [REQUEST_ID]
        );
        expect(state.rows).toEqual([{
            lifecycle: 'preflight_held',
            request_id: null,
            channel: 'standard',
            reservation_count: 1,
        }]);
    });

    it('permits exact active replay after dispatch and rejects missing/corrupt policy', async () => {
        await seedPendingBetaRequest();
        const active = await activateBeta();
        await makeJobLive();
        await expect(activateBeta()).resolves.toEqual(active);

        await db.query(
            `UPDATE public.analysis_v2_provider_execution_policies
             SET policy_hash = $2 WHERE request_id = $1`,
            [REQUEST_ID, 'f'.repeat(64)]
        );
        await expect(activateBeta()).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT/
        );
        await db.query(
            'DELETE FROM public.analysis_v2_provider_execution_policies WHERE request_id = $1',
            [REQUEST_ID]
        );
        await expect(activateBeta()).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_POLICY_CONFLICT/
        );
    });

    it('accepts beta profile-repair as its own exact reserved family', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        const reserved = await reserveProvider({
            family: 'profile-repair',
            slot: 'septenary',
            max: 0.01,
        });
        expect(reserved).toMatchObject({
            created: true,
            run: {
                operationKey: `profile-repair:${DIGEST}`,
                credentialSlot: 'septenary',
                maxChargeUsd: 0.01,
            },
        });
    });

    it('rejects beta secondary, unknown family, wrong slot, and budget overflow', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        await expect(reserveProvider({ slot: 'secondary' })).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_RUN_SLOT_MISMATCH/
        );
        await expect(reserveProvider({ family: 'unknown' })).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_RUN_OPERATION_INVALID/
        );
        await expect(reserveProvider({ slot: 'quinary' })).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_RUN_SLOT_MISMATCH/
        );
        await expect(reserveProvider({ max: 0.020000000001 })).rejects.toThrow(
            /ANALYSIS_BETA_PROVIDER_RUN_BUDGET_EXCEEDED/
        );
    });

    it('does not double count exact provider replay but rejects changed identity', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        const first = await reserveProvider({ max: 0.02 });
        await expect(reserveProvider({ max: 0.02 })).resolves.toMatchObject({
            created: false,
            run: first.run,
        });
        await expect(reserveProvider({ max: 0.02, inputHash: OTHER_INPUT_HASH }))
            .rejects.toThrow(/ANALYSIS_V2_PROVIDER_RUN_IDENTITY_CONFLICT/);
    });

    it('rebinds an exact beta replay to a reclaimed live job claim', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET dispatch_state = 'delivered', dispatch_generation = 1,
                 dispatch_reservation_token = $2
             WHERE request_id = $1 AND job_key = 'collect'`,
            [REQUEST_ID, DISPATCH_TOKEN]
        );
        const claimA = await serviceQuery<{ claimed: boolean }>(
            `SELECT claimed FROM public.claim_analysis_v2_job(
                $1, 'collect', 1, $2, $3, 120, 7
            )`,
            [REQUEST_ID, DISPATCH_TOKEN, CLAIM_TOKEN]
        );
        expect(claimA.rows).toEqual([{ claimed: true }]);
        await expect(reserveProvider({ max: 0.01 }))
            .resolves.toMatchObject({ created: true });

        await db.query(
            `UPDATE public.analysis_pipeline_jobs
             SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
             WHERE request_id = $1 AND job_key = 'collect'`,
            [REQUEST_ID]
        );
        const claimB = await serviceQuery<{ claimed: boolean }>(
            `SELECT claimed FROM public.claim_analysis_v2_job(
                $1, 'collect', 1, $2, $3, 120, 7
            )`,
            [REQUEST_ID, DISPATCH_TOKEN, CLAIM_TOKEN_B]
        );
        expect(claimB.rows).toEqual([{ claimed: true }]);

        await expect(reserveProvider({
            max: 0.01,
            claimToken: CLAIM_TOKEN_B,
        })).resolves.toMatchObject({ created: false });
        const rebound = await db.query<{ claim_token: string }>(
            `SELECT job_claim_token AS claim_token
             FROM public.analysis_v2_provider_runs
             WHERE request_id = $1 AND job_key = 'collect'
               AND operation_key = $2`,
            [REQUEST_ID, `relationship-followers:${DIGEST}`]
        );
        expect(rebound.rows).toEqual([{ claim_token: CLAIM_TOKEN_B }]);

        await expect(serviceQuery(
            `SELECT public.checkpoint_analysis_v2_provider_run_started(
                $1, 'collect', $2, $3, $4, $5
            )`,
            [
                REQUEST_ID,
                CLAIM_TOKEN_B,
                `relationship-followers:${DIGEST}`,
                RESERVATION_TOKEN,
                PROVIDER_RUN_ID,
            ]
        )).resolves.toBeDefined();
        await expect(serviceQuery(
            `SELECT public.checkpoint_analysis_v2_provider_run_terminal(
                $1, 'collect', $2, $3, $4, $5, 'succeeded', 0.005
            )`,
            [
                REQUEST_ID,
                CLAIM_TOKEN_B,
                `relationship-followers:${DIGEST}`,
                RESERVATION_TOKEN,
                PROVIDER_RUN_ID,
            ]
        )).resolves.toBeDefined();
        const terminal = await db.query<{
            status: string;
            claim_token: string;
        }>(
            `SELECT status, job_claim_token AS claim_token
             FROM public.analysis_v2_provider_runs
             WHERE request_id = $1 AND job_key = 'collect'
               AND operation_key = $2`,
            [REQUEST_ID, `relationship-followers:${DIGEST}`]
        );
        expect(terminal.rows).toEqual([{
            status: 'succeeded',
            claim_token: CLAIM_TOKEN_B,
        }]);
    });

    it('serializes cumulative family headroom so a second operation cannot oversubscribe', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        await reserveProvider({ max: 0.012 });
        await expect(reserveProvider({
            digest: 'f'.repeat(64),
            max: 0.009,
            reservationToken: '50000000-0000-4000-8000-000000000002',
        })).rejects.toThrow(/ANALYSIS_BETA_PROVIDER_RUN_BUDGET_EXCEEDED/);
        const count = await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs
             WHERE request_id = $1`,
            [REQUEST_ID]
        );
        expect(count.rows).toEqual([{ count: 1 }]);
    });

    it('accepts the final independent target fallback after every candidate profile batch', async () => {
        const catalog = getBetaApifyOperationBudgetCatalog('standard', {});
        const maximumCandidateBatches = Math.ceil(
            getAnalysisPlan('standard').detailedMutualLimit
                / ANALYSIS_V2_PROFILE_BATCH_LIMIT
        );
        const candidateBatchMaximum = profileMaximumCharge(
            ANALYSIS_V2_PROFILE_BATCH_LIMIT,
            {}
        );
        const targetFallbackMaximum = profileMaximumCharge(1, {});

        await seedPendingBetaRequest();
        await db.query(
            `UPDATE public.analysis_apify_credit_snapshots
             SET monthly_limit_usd = 10, monthly_usage_usd = 0`
        );
        await activateBeta(betaSlots, catalog);
        await makeJobLive();
        for (let index = 1; index <= maximumCandidateBatches; index += 1) {
            await expect(reserveProvider({
                family: 'profile-fallback',
                digest: index.toString(16).padStart(64, '0'),
                slot: betaSlots['profile-fallback'],
                max: candidateBatchMaximum,
                reservationToken: randomUUID(),
            })).resolves.toMatchObject({ created: true });
        }

        await expect(reserveProvider({
            family: 'profile-fallback',
            digest: 'f'.repeat(64),
            slot: betaSlots['profile-fallback'],
            max: targetFallbackMaximum,
            reservationToken: randomUUID(),
        })).resolves.toMatchObject({ created: true });
        const spent = await db.query<{ total: string; count: number }>(
            `SELECT pg_catalog.sum(max_charge_usd)::TEXT AS total,
                    pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_v2_provider_runs
             WHERE request_id = $1
               AND pg_catalog.split_part(operation_key, ':', 1) = 'profile-fallback'`,
            [REQUEST_ID]
        );
        expect(spent.rows).toEqual([{
            total: catalog['profile-fallback'].toFixed(12),
            count: maximumCandidateBatches + 1,
        }]);
    });

    it('keeps standard provider reserve and legacy profile-repair alias compatible', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version,
                plan_access_mode_snapshot, test_entitlement_jti_hash,
                selected_plan_id_snapshot, analysis_scope_snapshot
             ) VALUES (
                $1, $2, $3, 'processing', 'v2', 'test_entitlement', $4,
                'standard', $5::JSONB
             )`,
            [
                REQUEST_ID,
                USER_ID,
                TARGET,
                JTI_HASH,
                JSON.stringify({
                    relationshipCapacity: { followers: 300, following: 300 },
                    detailedMutualLimit: 300,
                }),
            ]
        );
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, status, access_mode, target_instagram_id,
                target_followers_count, target_following_count,
                consumed_request_id, expires_at
             ) VALUES (
                $1, $2, 'consumed', 'test_entitlement', $3, 120, 140, $4,
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
             )`,
            [PREFLIGHT_ID, USER_ID, TARGET, REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs (
                request_id, job_key, status, dispatch_state, lease_token,
                lease_expires_at
             ) VALUES (
                $1, 'collect', 'processing', 'dispatched', $2,
                pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             )`,
            [REQUEST_ID, CLAIM_TOKEN]
        );
        const policyHash = await db.query<{ hash: string }>(
            `SELECT pg_catalog.encode(extensions.digest(
                pg_catalog.convert_to($1 || E'\\n' || $2 || E'\\n' || $3::JSONB::TEXT, 'UTF8'),
                'sha256'
             ), 'hex') AS hash`,
            ['authorized-free-e2e-v1', TARGET, JSON.stringify(legacySlots)]
        );
        await db.query(
            `INSERT INTO public.analysis_v2_provider_execution_policies (
                request_id, mode, policy_version, entitlement_jti_hash,
                target_instagram_id, operation_slot_map, policy_hash
             ) VALUES (
                $1, 'test_operation_split', 'authorized-free-e2e-v1', $2,
                $3, $4::JSONB, $5
             )`,
            [REQUEST_ID, JTI_HASH, TARGET, JSON.stringify(legacySlots), policyHash.rows[0].hash]
        );
        const legacyContext = await serviceQuery<JsonRow<{
            providerExecutionPolicy: Record<string, unknown>;
        }>>(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            ) AS result`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(legacyContext.rows[0].result.providerExecutionPolicy).toEqual({
            mode: 'test_operation_split',
            policyVersion: 'authorized-free-e2e-v1',
            operationSlots: legacySlots,
        });
        await expect(reserveProvider({
            family: 'profile-repair',
            slot: 'primary',
            max: 0.01,
        })).resolves.toMatchObject({ created: true });
    });

    it('keeps an ordinary production collection context policy-free', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_requests (
                id, user_id, target_instagram_id, status, pipeline_version,
                preflight_id, plan_access_mode_snapshot,
                selected_plan_id_snapshot, analysis_scope_snapshot
             ) VALUES (
                $1, $2, $3, 'processing', 'v2', $4, 'production',
                'basic', $5::JSONB
             )`,
            [
                REQUEST_ID,
                USER_ID,
                TARGET,
                PREFLIGHT_ID,
                JSON.stringify({
                    relationshipCapacity: { followers: 300, following: 300 },
                    detailedMutualLimit: 300,
                }),
            ]
        );
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, status, access_mode, target_instagram_id,
                target_followers_count, target_following_count,
                consumed_request_id, expires_at
             ) VALUES (
                $1, $2, 'consumed', 'production', $3, 120, 140, $4,
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
             )`,
            [PREFLIGHT_ID, USER_ID, TARGET, REQUEST_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs (
                request_id, job_key, status, dispatch_state, lease_token,
                lease_expires_at
             ) VALUES (
                $1, 'collect', 'processing', 'dispatched', $2,
                pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             )`,
            [REQUEST_ID, CLAIM_TOKEN]
        );

        const ordinaryContext = await serviceQuery<JsonRow<{
            accessMode: string;
            providerExecutionPolicy: null;
        }>>(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            ) AS result`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(ordinaryContext.rows[0].result).toMatchObject({
            accessMode: 'production',
            providerExecutionPolicy: null,
        });
    });

    it('allows only initial plus fresh generation one within the held .0052', async () => {
        await seedPendingBetaPreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'processing', lease_token = $2,
                 lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE id = $1`,
            [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await expect(reserveInitial()).resolves.toMatchObject({ created: true });
        await expect(reserveInitial()).resolves.toMatchObject({ created: false });

        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'ready', lease_token = NULL, lease_expires_at = NULL,
                 admission_status = 'processing', admission_generation = 1,
                 admission_requested_at = (
                    SELECT pg_catalog.max(provider_run.reserved_at)
                           + INTERVAL '1 microsecond'
                    FROM public.analysis_preflight_provider_runs AS provider_run
                    WHERE provider_run.preflight_id = $1
                 ),
                 admission_claim_token = $2,
                 admission_lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE id = $1`,
            [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await expect(reserveFresh(1)).resolves.toMatchObject({ created: true });
        await expect(reserveFresh(1)).resolves.toMatchObject({ created: false });

        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_generation = 2,
                 admission_requested_at = pg_catalog.clock_timestamp()
             WHERE id = $1`,
            [PREFLIGHT_ID]
        );
        await expect(reserveFresh(2)).rejects.toThrow(
            /ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_GENERATION_INVALID/
        );
        const total = await db.query<{ total: string; count: number }>(
            `SELECT pg_catalog.sum(max_charge_usd) AS total,
                    pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_preflight_provider_runs
             WHERE preflight_id = $1`,
            [PREFLIGHT_ID]
        );
        expect(total.rows).toEqual([{ total: '0.005200000000', count: 2 }]);
    });

    it('rejects a beta preflight wrong/free-ineligible slot without a ledger row', async () => {
        await seedPendingBetaPreflight();
        await db.query(
            `UPDATE public.analysis_preflights
             SET status = 'processing', lease_token = $2,
                 lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '5 minutes'
             WHERE id = $1`,
            [PREFLIGHT_ID, CLAIM_TOKEN]
        );
        await expect(reserveInitial('secondary')).rejects.toThrow(
            /ANALYSIS_BETA_PREFLIGHT_PROVIDER_RUN_SLOT_MISMATCH/
        );
        const count = await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_preflight_provider_runs'
        );
        expect(count.rows).toEqual([{ count: 0 }]);
    });

    it('returns beta policy in collection context and rejects ordinary production policy', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        const context = await serviceQuery<JsonRow<{
            accessMode: string;
            providerExecutionPolicy: { mode: string; policyVersion: string };
        }>>(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            ) AS result`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        );
        expect(context.rows[0].result).toMatchObject({
            accessMode: 'production',
            providerExecutionPolicy: {
                mode: 'betatest_free_pool',
                policyVersion: 'betatest-free-pool-v1',
                operationSlots: betaSlots,
                operationBudgets: betaBudgets,
            },
        });

        await db.query(
            `UPDATE public.analysis_beta_pool_reservations
             SET reserved_usd = 0.019
             WHERE operation_family = 'candidate-likers'`
        );
        await expect(serviceQuery(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            )`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        )).rejects.toThrow(/ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH/);

        await db.query(
            `UPDATE public.analysis_requests SET analysis_entry_channel = 'standard'
             WHERE id = $1`,
            [REQUEST_ID]
        );
        await expect(serviceQuery(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            )`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        )).rejects.toThrow(/ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH/);

        await db.query(
            `UPDATE public.analysis_requests SET analysis_entry_channel = 'betatest'
             WHERE id = $1`,
            [REQUEST_ID]
        );
        await db.query(
            'DELETE FROM public.analysis_v2_provider_execution_policies WHERE request_id = $1',
            [REQUEST_ID]
        );
        await expect(serviceQuery(
            `SELECT public.load_analysis_v2_collection_context_with_policy(
                $1, 'collect', $2, $3
            )`,
            [REQUEST_ID, CLAIM_TOKEN, INPUT_HASH]
        )).rejects.toThrow(/ANALYSIS_V2_COLLECTION_CONTEXT_FENCE_MISMATCH/);
    });

    it('denies direct policy and beta-credit DML without changing state', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        const allocation = await db.query<{
            id: string;
            lifecycle: string;
            policy_hash: string;
            reservation_count: number;
        }>(
            `SELECT allocation.id,
                    allocation.lifecycle_state AS lifecycle,
                    policy.policy_hash,
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_beta_pool_reservations AS reservation
                     WHERE reservation.allocation_id = allocation.id) AS reservation_count
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_v2_provider_execution_policies AS policy
               ON policy.request_id = allocation.request_id
             WHERE allocation.request_id = $1`,
            [REQUEST_ID]
        );
        const before = allocation.rows[0];
        expect(before).toBeDefined();

        const attempts: Array<{ sql: string; params: unknown[] }> = [
            {
                sql: `INSERT INTO public.analysis_v2_provider_execution_policies (
                    request_id, mode, policy_version, entitlement_jti_hash,
                    target_instagram_id, operation_slot_map, policy_hash
                ) VALUES ($1, 'betatest_free_pool', 'betatest-free-pool-v1',
                    NULL, $2, $3::JSONB, $4)`,
                params: [REQUEST_ID, TARGET, JSON.stringify(betaSlots), 'f'.repeat(64)],
            },
            {
                sql: `UPDATE public.analysis_v2_provider_execution_policies
                      SET policy_hash = $2 WHERE request_id = $1`,
                params: [REQUEST_ID, 'f'.repeat(64)],
            },
            {
                sql: 'DELETE FROM public.analysis_v2_provider_execution_policies WHERE request_id = $1',
                params: [REQUEST_ID],
            },
            {
                sql: `INSERT INTO public.analysis_beta_pool_allocations (
                    id, preflight_id, user_id, lifecycle_state, expires_at
                ) VALUES ($1, $2, $3, 'preflight_held',
                    pg_catalog.clock_timestamp() + INTERVAL '1 hour')`,
                params: [
                    '60000000-0000-4000-8000-000000000001',
                    PREFLIGHT_ID,
                    USER_ID,
                ],
            },
            {
                sql: `UPDATE public.analysis_beta_pool_allocations
                      SET lifecycle_state = 'preflight_held' WHERE id = $1`,
                params: [before.id],
            },
            {
                sql: 'DELETE FROM public.analysis_beta_pool_allocations WHERE id = $1',
                params: [before.id],
            },
            {
                sql: `INSERT INTO public.analysis_beta_pool_reservations (
                    allocation_id, operation_family, credential_slot,
                    reserved_usd, lifecycle_state
                ) VALUES ($1, 'target-profile', 'primary',
                    0.005200000000, 'active')`,
                params: [before.id],
            },
            {
                sql: `UPDATE public.analysis_beta_pool_reservations
                      SET reserved_usd = 0.005100000000
                      WHERE allocation_id = $1 AND operation_family = 'target-profile'`,
                params: [before.id],
            },
            {
                sql: `DELETE FROM public.analysis_beta_pool_reservations
                      WHERE allocation_id = $1 AND operation_family = 'target-profile'`,
                params: [before.id],
            },
        ];

        for (const role of ['service_role', 'authenticated'] as const) {
            for (const attempt of attempts) {
                await db.exec(`SET ROLE ${role}`);
                try {
                    await expect(db.query(attempt.sql, attempt.params))
                        .rejects.toThrow(/permission denied/i);
                } finally {
                    await db.exec('RESET ROLE');
                }
            }
        }

        const after = await db.query<{
            id: string;
            lifecycle: string;
            policy_hash: string;
            reservation_count: number;
        }>(
            `SELECT allocation.id,
                    allocation.lifecycle_state AS lifecycle,
                    policy.policy_hash,
                    (SELECT pg_catalog.count(*)::INTEGER
                     FROM public.analysis_beta_pool_reservations AS reservation
                     WHERE reservation.allocation_id = allocation.id) AS reservation_count
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_v2_provider_execution_policies AS policy
               ON policy.request_id = allocation.request_id
             WHERE allocation.request_id = $1`,
            [REQUEST_ID]
        );
        expect(after.rows).toEqual([before]);

        for (const table of [
            'analysis_v2_provider_execution_policies',
            'analysis_beta_pool_allocations',
            'analysis_beta_pool_reservations',
            'analysis_beta_pool_reservation_archive',
            'analysis_beta_pool_local_debits',
        ]) {
            await expect(serviceQuery(`SELECT * FROM public.${table}`))
                .rejects.toThrow(/permission denied/i);
        }
        for (const role of ['service_role', 'authenticated'] as const) {
            await db.exec(`SET ROLE ${role}`);
            try {
                for (const table of [
                    'analysis_beta_pool_reservation_archive',
                    'analysis_beta_pool_local_debits',
                ]) {
                    for (const statement of [
                        `INSERT INTO public.${table} DEFAULT VALUES`,
                        `UPDATE public.${table} SET credential_slot = credential_slot`,
                        `DELETE FROM public.${table}`,
                    ]) {
                        await expect(db.query(statement)).rejects.toThrow(/permission denied/i);
                    }
                }
            } finally {
                await db.exec('RESET ROLE');
            }
        }
        for (const role of ['service_role', 'authenticated']) {
            const privateHelpers = await db.query<{ allowed: boolean }>(
                `SELECT pg_catalog.has_function_privilege(
                    $1,
                    'public.analysis_beta_pool_effective_capacity_snapshot()',
                    'EXECUTE'
                 ) AS allowed`,
                [role]
            );
            const triggerHelper = await db.query<{ allowed: boolean }>(
                `SELECT pg_catalog.has_function_privilege(
                    $1,
                    'public.guard_analysis_beta_pool_reservation_headroom()',
                    'EXECUTE'
                 ) AS allowed`,
                [role]
            );
            expect(privateHelpers.rows).toEqual([{ allowed: false }]);
            expect(triggerHelper.rows).toEqual([{ allowed: false }]);
        }
        await db.exec('SET ROLE authenticated');
        try {
            await expect(db.query(
                `SELECT public.activate_analysis_beta_apify_request_credit(
                    $1, $2, $3, 'standard', $4::JSONB, $5::JSONB, 300
                )`,
                [
                    PREFLIGHT_ID,
                    REQUEST_ID,
                    USER_ID,
                    JSON.stringify(betaSlots),
                    JSON.stringify(betaBudgets),
                ]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('settles a terminal request family-by-family and releases safe no-run budgets', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(
            `UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`,
            [REQUEST_ID]
        );
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`, [REQUEST_ID]
        )).rows[0].id;
        const settled = await serviceQuery<JsonRow<{
            lifecycleState: string; settledFamilies: number; releasedUsd: number;
        }>>(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal') AS result`,
            [allocationId]
        );
        expect(settled.rows[0].result).toMatchObject({
            lifecycleState: 'settled', settledFamilies: 8,
        });
        const families = await db.query<{ state: string; count: number }>(
            `SELECT lifecycle_state AS state, pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_beta_pool_reservations GROUP BY lifecycle_state`
        );
        expect(families.rows).toEqual([{ state: 'settled', count: 8 }]);
    });

    it('keeps an ambiguous started provider family held, then settles it after reconciliation', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status
             ) VALUES ($1, 'collect', $2, $3, $4, $5, 'apify', 'actor/test',
                'tertiary', 0.02, 'starting')`,
            [REQUEST_ID, `relationship-followers:${DIGEST}`, INPUT_HASH, CLAIM_TOKEN, RESERVATION_TOKEN]
        );
        await db.query(`UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`, [REQUEST_ID]);
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`, [REQUEST_ID]
        )).rows[0].id;
        const partial = await serviceQuery<JsonRow<{ lifecycleState: string; heldFamilies: number }>>(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal') AS result`, [allocationId]
        );
        expect(partial.rows[0].result).toMatchObject({ lifecycleState: 'active', heldFamilies: 1 });
        await db.query(
            `UPDATE public.analysis_v2_provider_runs
             SET status = 'failed', actual_usage_usd = 0.005,
                 run_id = 'BetaRun123456', run_started_at = pg_catalog.clock_timestamp(),
                 terminalized_at = pg_catalog.clock_timestamp(), usage_reconciled_at = pg_catalog.clock_timestamp()
             WHERE request_id = $1`, [REQUEST_ID]
        );
        const complete = await serviceQuery<JsonRow<{ lifecycleState: string; actualUsd: number }>>(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'recovery') AS result`, [allocationId]
        );
        expect(complete.rows[0].result).toMatchObject({ lifecycleState: 'settled', actualUsd: 0.005 });
    });

    it('releases an expired no-run preflight but never releases its starting intent', async () => {
        await seedPendingBetaPreflight();
        await db.query(`UPDATE public.analysis_preflights SET expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second' WHERE id = $1`, [PREFLIGHT_ID]);
        await expect(serviceQuery(
            `SELECT public.recover_analysis_beta_apify_credit_allocations(10)`
        )).resolves.toBeDefined();
        const released = await db.query<{ state: string }>(
            `SELECT lifecycle_state AS state FROM public.analysis_beta_pool_allocations`
        );
        expect(released.rows).toEqual([{ state: 'settled' }]);

        await db.exec(`DELETE FROM public.analysis_beta_pool_reservations; DELETE FROM public.analysis_beta_pool_allocations; DELETE FROM public.analysis_preflights; DELETE FROM public.analysis_beta_access_grants; DELETE FROM public.users;`);
        await seedPendingBetaPreflight();
        await db.query(`UPDATE public.analysis_preflights SET status = 'processing', lease_token = $2, lease_expires_at = pg_catalog.clock_timestamp() + INTERVAL '1 minute' WHERE id = $1`, [PREFLIGHT_ID, CLAIM_TOKEN]);
        await reserveInitial();
        await db.query(`UPDATE public.analysis_preflights SET expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second' WHERE id = $1`, [PREFLIGHT_ID]);
        await serviceQuery(`SELECT public.recover_analysis_beta_apify_credit_allocations(10)`);
        const held = await db.query<{ state: string }>(`SELECT lifecycle_state AS state FROM public.analysis_beta_pool_reservations`);
        expect(held.rows).toEqual([{ state: 'preflight_held' }]);
    });

    it('never auto-archives terminal ambiguous provider work', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status
             ) VALUES ($1, 'collect', $2, $3, $4, $5, 'apify', 'actor/test',
                'tertiary', 0.020000000000, 'starting')`,
            [REQUEST_ID, `relationship-followers:${DIGEST}`, INPUT_HASH, CLAIM_TOKEN, RESERVATION_TOKEN]
        );
        await db.query(`UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`, [REQUEST_ID]);
        await expect(serviceQuery(
            `SELECT public.archive_settled_analysis_beta_apify_credit_allocations(10)`
        )).resolves.toBeDefined();
        const ambiguous = await db.query<{ state: string; debit: string; actual: string; released: string }>(
            `SELECT archive_state AS state, unabsorbed_debit_usd AS debit,
                    actual_usd AS actual, released_usd AS released
             FROM public.analysis_beta_pool_reservation_archive
             WHERE operation_family = 'relationship-followers'`
        );
        expect(ambiguous.rows).toEqual([]);
        expect((await db.query(`SELECT id FROM public.analysis_beta_pool_allocations`)).rows)
            .toHaveLength(1);
        await db.query(`DELETE FROM public.analysis_v2_provider_runs WHERE request_id = $1`, [REQUEST_ID]);
        await db.query(`DELETE FROM public.analysis_pipeline_jobs WHERE request_id = $1`, [REQUEST_ID]);
        await db.query(`DELETE FROM public.analysis_beta_pool_reservations WHERE allocation_id IN (SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1)`, [REQUEST_ID]);
        await db.query(`DELETE FROM public.analysis_beta_pool_allocations WHERE request_id = $1`, [REQUEST_ID]);
        await db.query(`DELETE FROM public.analysis_preflights WHERE id = $1`, [PREFLIGHT_ID]);
        await db.query(`DELETE FROM public.analysis_requests WHERE id = $1`, [REQUEST_ID]);
        await expect(db.query(`DELETE FROM public.users WHERE id = $1`, [USER_ID]))
            .resolves.toBeDefined();
    });

    it('rejects a debit-insufficient slot at the hold RPC precheck while another slot remains usable', async () => {
        await db.query('INSERT INTO public.users (id) VALUES ($1)', [USER_ID]);
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, status, access_mode, target_instagram_id,
                target_followers_count, target_following_count, expires_at,
                beta_entry_provenance,beta_prepare_generation,beta_prepare_token,
                beta_prepare_state,beta_prepare_dispatch_state
             ) VALUES ($1, $2, 'pending', 'production', $3, 120, 140,
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes',
                'betatest_service_v1',1,$4,'reserved','enqueued')`,
            [PREFLIGHT_ID, USER_ID, TARGET, PREPARE_TOKEN]
        );
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant(
                $1, TRUE, pg_catalog.clock_timestamp() + INTERVAL '1 hour', $2
            )`,
            [USER_ID, AUDIT_HASH]
        );
        await serviceQuery(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(snapshots())]
        );
        await serviceQuery(
            `SELECT * FROM public.claim_analysis_beta_preflight_prepare(
                $1,$2,1,$3,$4,300
            )`, [PREFLIGHT_ID, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        );
        const observed = (await db.query<{ observed_at: string }>(
            `SELECT observed_at FROM public.analysis_apify_credit_snapshots
             WHERE credential_slot = 'primary'`
        )).rows[0].observed_at;
        await db.query(
            `INSERT INTO public.analysis_beta_pool_reservation_archive (
                allocation_id, operation_family, credential_slot, reserved_usd,
                actual_usd, released_usd, reconciliation_watermark, settled_at,
                settlement_reason, archive_state, unabsorbed_debit_usd
             ) VALUES (
                '90000000-0000-4000-8000-000000000001', 'target-profile',
                'primary', 0.998000000000, 0.998000000000, 0,
                $1, pg_catalog.clock_timestamp(), 'recovery', 'settled',
                0.998000000000
             )`, [observed]
        );

        await expect(serviceQuery(
            `SELECT public.prepare_analysis_beta_apify_preflight_credit(
                $1,$2,1,$3,$4,'primary',0.005200000000,300
            )`, [PREFLIGHT_ID, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        )).rejects.toThrow(/ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/);
        expect((await db.query(
            'SELECT id FROM public.analysis_beta_pool_allocations WHERE preflight_id = $1',
            [PREFLIGHT_ID]
        )).rows).toEqual([]);
        await expect(serviceQuery(
            `SELECT public.prepare_analysis_beta_apify_preflight_credit(
                $1,$2,1,$3,$4,'tertiary',0.005200000000,300
            )`, [PREFLIGHT_ID, USER_ID, PREPARE_TOKEN, PREPARE_CLAIM_TOKEN]
        )).resolves.toBeDefined();
    });

    it('rejects a positive residual reservation shortfall and permits an exact fit', async () => {
        await seedPendingBetaPreflight();
        // The initial target-profile hold is 0.0052.  Leave exactly 0.005 in
        // primary, so a BEFORE INSERT fence must include the proposed row.
        await db.query(
            `UPDATE public.analysis_apify_credit_snapshots
             SET monthly_limit_usd = 0.010200000000,
                 monthly_usage_usd = 0
             WHERE credential_slot = 'primary'`
        );
        await db.query(
            `INSERT INTO public.analysis_preflights (
                id, user_id, status, access_mode, expires_at
             ) VALUES (
                '20000000-0000-4000-8000-000000000099', $1,
                'pending', 'production',
                pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
             )`,
            [USER_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_allocations (
                id, preflight_id, user_id, lifecycle_state, expires_at
             ) VALUES (
                '60000000-0000-4000-8000-000000000099',
                '20000000-0000-4000-8000-000000000099', $1,
                'preflight_held', pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
             )`,
            [USER_ID]
        );

        await expect(db.query(
            `INSERT INTO public.analysis_beta_pool_reservations (
                allocation_id, operation_family, credential_slot,
                reserved_usd, lifecycle_state
             ) VALUES (
                '60000000-0000-4000-8000-000000000099', 'target-profile',
                'primary', 0.005000000001, 'preflight_held'
             )`
        )).rejects.toThrow(/ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/);

        await expect(db.query(
            `INSERT INTO public.analysis_beta_pool_reservations (
                allocation_id, operation_family, credential_slot,
                reserved_usd, lifecycle_state
             ) VALUES (
                '60000000-0000-4000-8000-000000000099', 'target-profile',
                'primary', 0.005000000000, 'preflight_held'
             )`
        )).resolves.toBeDefined();
    });

    it('keeps an archived settled debit through an equal snapshot and retires it only after a newer exact-six refresh', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        await reserveProvider({ max: 0.02 });
        await serviceQuery(
            `SELECT public.checkpoint_analysis_v2_provider_run_started(
                $1, 'collect', $2, $3, $4, $5
            )`,
            [
                REQUEST_ID,
                CLAIM_TOKEN,
                `relationship-followers:${DIGEST}`,
                RESERVATION_TOKEN,
                PROVIDER_RUN_ID,
            ]
        );
        await serviceQuery(
            `SELECT public.checkpoint_analysis_v2_provider_run_terminal(
                $1, 'collect', $2, $3, $4, $5, 'succeeded', 0.01
            )`,
            [
                REQUEST_ID,
                CLAIM_TOKEN,
                `relationship-followers:${DIGEST}`,
                RESERVATION_TOKEN,
                PROVIDER_RUN_ID,
            ]
        );
        await db.query(
            `UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`,
            [REQUEST_ID]
        );
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`,
            [REQUEST_ID]
        )).rows[0]!.id;
        await serviceQuery(
            `SELECT public.settle_analysis_beta_apify_credit_allocation(
                $1, 'request_terminal'
            )`,
            [allocationId]
        );
        const watermark = (await db.query<{ watermark: string }>(
            `SELECT reconciliation_watermark AS watermark
             FROM public.analysis_beta_pool_reservations
             WHERE allocation_id = $1 AND operation_family = 'relationship-followers'`,
            [allocationId]
        )).rows[0]!.watermark;
        const liveCapacity = await db.query<{ capacity: string }>(
            `SELECT effective_capacity_usd AS capacity
             FROM public.analysis_beta_pool_effective_capacity_snapshot()
             WHERE credential_slot = 'tertiary'`
        );
        expect(Number(liveCapacity.rows[0]!.capacity)).toBeCloseTo(0.99, 12);
        await db.query(`UPDATE public.analysis_beta_pool_allocations SET settled_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours' WHERE id = $1`, [allocationId]);
        await serviceQuery(
            `SELECT public.archive_settled_analysis_beta_apify_credit_allocations(10)`
        );

        const archived = await db.query<{ history: number; live: number }>(
            `SELECT
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_beta_pool_reservation_archive
                 WHERE allocation_id = $1) AS history,
                (SELECT pg_catalog.count(*)::INTEGER
                 FROM public.analysis_beta_pool_allocations
                 WHERE id = $1) AS live`,
            [allocationId]
        );
        expect(archived.rows).toEqual([{ history: 8, live: 0 }]);

        const archivedCapacity = await db.query<{ capacity: string }>(
            `SELECT effective_capacity_usd AS capacity
             FROM public.analysis_beta_pool_effective_capacity_snapshot()
             WHERE credential_slot = 'tertiary'`
        );
        // One MVCC statement sees either live or archive debit, never both
        // and never neither; archive also preserves every zero/nonzero fact.
        expect(Number(archivedCapacity.rows[0]!.capacity)).toBeCloseTo(0.99, 12);
        expect((await db.query<{ actual: string; released: string }>(
            `SELECT actual_usd AS actual, released_usd AS released
             FROM public.analysis_beta_pool_reservation_archive
             WHERE allocation_id = $1 AND operation_family = 'relationship-followers'`,
            [allocationId]
        )).rows).toEqual([{ actual: '0.010000000000', released: '0.010000000000' }]);

        const staleSnapshot = snapshots().map(snapshot => ({
            ...(snapshot as Record<string, unknown>),
            billingCycleStartAt: new Date(Date.now() - 11 * 60_000).toISOString(),
            observedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        }));
        await expect(serviceQuery(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(staleSnapshot)]
        )).rejects.toThrow(/ANALYSIS_BETA_POOL_SNAPSHOT_STALE/);
        const partialSnapshot = snapshots().slice(0, 5);
        await expect(serviceQuery(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(partialSnapshot)]
        )).rejects.toThrow(/ANALYSIS_BETA_POOL_SNAPSHOT_INCOMPLETE/);
        expect((await db.query<{ capacity: string }>(
            `SELECT effective_capacity_usd AS capacity
             FROM public.analysis_beta_pool_effective_capacity_snapshot()
             WHERE credential_slot = 'tertiary'`
        )).rows).toEqual(archivedCapacity.rows);

        const equalSnapshot = snapshots().map(snapshot => ({
            ...(snapshot as Record<string, unknown>), observedAt: watermark,
        }));
        await serviceQuery(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(equalSnapshot)]
        );
        const equalCapacity = await db.query<{ capacity: string }>(
            `SELECT effective_capacity_usd AS capacity
             FROM public.analysis_beta_pool_effective_capacity_snapshot()
             WHERE credential_slot = 'tertiary'`
        );
        expect(Number(equalCapacity.rows[0]!.capacity)).toBeCloseTo(0.99, 12);

        const newerObservedAt = new Date(
            new Date(watermark).getTime() + 1
        ).toISOString();
        const newerSnapshot = snapshots().map(snapshot => ({
            ...(snapshot as Record<string, unknown>), observedAt: newerObservedAt,
        }));
        await serviceQuery(
            'SELECT public.upsert_analysis_beta_apify_credit_snapshots($1::JSONB)',
            [JSON.stringify(newerSnapshot)]
        );
        const newerCapacity = await db.query<{ capacity: string }>(
            `SELECT effective_capacity_usd AS capacity
             FROM public.analysis_beta_pool_effective_capacity_snapshot()
             WHERE credential_slot = 'tertiary'`
        );
        expect(Number(newerCapacity.rows[0]!.capacity)).toBeCloseTo(1, 12);
        expect((await db.query(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_beta_pool_reservation_archive
             WHERE allocation_id = $1`,
            [allocationId]
        )).rows).toEqual([{ count: 8 }]);
    });

    it('uses cumulative debit-aware capacity for several activation families mapped to one slot', async () => {
        await seedPendingBetaRequest();
        const observed = (await db.query<{ observed: string }>(
            `SELECT observed_at AS observed FROM public.analysis_apify_credit_snapshots
             WHERE credential_slot = 'tertiary'`
        )).rows[0]!.observed;
        await db.query(
            `UPDATE public.analysis_apify_credit_snapshots
             SET monthly_limit_usd = 0.050000000000, monthly_usage_usd = 0
             WHERE credential_slot = 'tertiary'`
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_reservation_archive (
                allocation_id, operation_family, credential_slot, reserved_usd,
                actual_usd, released_usd, reconciliation_watermark, settled_at,
                settlement_reason, archive_state, unabsorbed_debit_usd
             ) VALUES (
                '90000000-0000-4000-8000-000000000021', 'target-profile',
                'tertiary', 0.020000000000, 0.020000000000, 0, $1,
                pg_catalog.clock_timestamp(), 'recovery', 'settled', 0.020000000000
             )`, [observed]
        );
        const slots = {
            ...betaSlots,
            'relationship-followers': 'tertiary',
            'target-comments': 'tertiary',
        };
        const budgets = {
            ...betaBudgets,
            'relationship-followers': 0.02,
            'target-comments': 0.02,
        };
        await expect(activateBeta(slots, budgets)).rejects.toThrow(
            /ANALYSIS_BETA_POOL_CAPACITY_UNAVAILABLE/
        );
        expect((await db.query<{ state: string; count: number }>(
            `SELECT allocation.lifecycle_state AS state,
                    pg_catalog.count(reservation.*)::INTEGER AS count
             FROM public.analysis_beta_pool_allocations AS allocation
             JOIN public.analysis_beta_pool_reservations AS reservation
               ON reservation.allocation_id = allocation.id
             GROUP BY allocation.lifecycle_state`
        )).rows).toEqual([{ state: 'preflight_held', count: 1 }]);
    });

    it('keeps terminal settlement and bounded recovery sweep idempotent', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(
            `UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`,
            [REQUEST_ID]
        );
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`,
            [REQUEST_ID]
        )).rows[0]!.id;
        const first = await serviceQuery<JsonRow<Record<string, unknown>>>(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal') AS result`,
            [allocationId]
        );
        const second = await serviceQuery<JsonRow<Record<string, unknown>>>(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal') AS result`,
            [allocationId]
        );
        expect(first.rows[0]!.result).toMatchObject({ lifecycleState: 'settled', settledFamilies: 8 });
        expect(second.rows[0]!.result).toMatchObject({ lifecycleState: 'settled', settledFamilies: 0 });
        const beforeSweep = await db.query<{ state: string; count: number }>(
            `SELECT lifecycle_state AS state, pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_beta_pool_reservations GROUP BY lifecycle_state`
        );
        await expect(serviceQuery(
            `SELECT public.recover_analysis_beta_apify_credit_allocations(1)`
        )).resolves.toBeDefined();
        await expect(serviceQuery(
            `SELECT public.recover_analysis_beta_apify_credit_allocations(1)`
        )).resolves.toBeDefined();
        expect((await db.query<{ state: string; count: number }>(
            `SELECT lifecycle_state AS state, pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_beta_pool_reservations GROUP BY lifecycle_state`
        )).rows).toEqual(beforeSweep.rows);
    });

    it('settles a terminal request after its beta grant has been revoked', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await serviceQuery(
            `SELECT public.upsert_analysis_beta_access_grant($1, FALSE, NULL, $2)`,
            [USER_ID, 'f'.repeat(64)]
        );
        await db.query(`UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`, [REQUEST_ID]);
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`, [REQUEST_ID]
        )).rows[0]!.id;
        await expect(serviceQuery(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal')`,
            [allocationId]
        )).resolves.toBeDefined();
        expect((await db.query<{ state: string }>(
            `SELECT lifecycle_state AS state FROM public.analysis_beta_pool_allocations WHERE id = $1`,
            [allocationId]
        )).rows).toEqual([{ state: 'settled' }]);
    });

    it('rolls back every earlier family settlement when a later corrupted actual exceeds its reservation', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await makeJobLive();
        await reserveProvider({ family: 'relationship-followers', max: 0.02 });
        await serviceQuery(
            `SELECT public.checkpoint_analysis_v2_provider_run_started($1, 'collect', $2, $3, $4, $5)`,
            [REQUEST_ID, CLAIM_TOKEN, `relationship-followers:${DIGEST}`, RESERVATION_TOKEN, PROVIDER_RUN_ID]
        );
        await serviceQuery(
            `SELECT public.checkpoint_analysis_v2_provider_run_terminal($1, 'collect', $2, $3, $4, $5, 'succeeded', 0.01)`,
            [REQUEST_ID, CLAIM_TOKEN, `relationship-followers:${DIGEST}`, RESERVATION_TOKEN, PROVIDER_RUN_ID]
        );
        // Service APIs reject this overage at terminal checkpoint.  Seed the
        // minimum owner-only corrupted provider record to exercise the
        // settlement transaction's defensive all-or-nothing guard.
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs (
                request_id, job_key, operation_key, input_hash, job_claim_token,
                reservation_token, logical_provider, actor_id, credential_slot,
                max_charge_usd, status, actual_usage_usd, usage_reconciled_at
             ) VALUES ($1, 'collect', $2, $3, $4, $5, 'apify', 'actor/test',
                'quaternary', 0.020000000000, 'failed', 0.030000000000,
                pg_catalog.clock_timestamp())`,
            [
                REQUEST_ID,
                `relationship-following:${'f'.repeat(64)}`,
                INPUT_HASH,
                CLAIM_TOKEN,
                '50000000-0000-4000-8000-000000000022',
            ]
        );
        await db.query(`UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`, [REQUEST_ID]);
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`, [REQUEST_ID]
        )).rows[0]!.id;
        const beforeSettlement = await db.query<{ state: string; actual: string }>(
            `SELECT lifecycle_state AS state, actual_usd AS actual
             FROM public.analysis_beta_pool_reservations
             WHERE allocation_id = $1 ORDER BY operation_family`, [allocationId]
        );
        await expect(serviceQuery(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal')`,
            [allocationId]
        )).rejects.toThrow(/ANALYSIS_BETA_SETTLEMENT_ACTUAL_EXCEEDS_RESERVATION/);
        expect((await db.query<{ state: string; actual: string }>(
            `SELECT lifecycle_state AS state, actual_usd AS actual
             FROM public.analysis_beta_pool_reservations
             WHERE allocation_id = $1 ORDER BY operation_family`, [allocationId]
        )).rows).toEqual(beforeSettlement.rows);
    });

    it('fails immutable archive conflicts before deleting the live allocation', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(`UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`, [REQUEST_ID]);
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`, [REQUEST_ID]
        )).rows[0].id;
        await db.query(
            `INSERT INTO public.analysis_beta_pool_reservation_archive (
                allocation_id, operation_family, credential_slot, reserved_usd,
                actual_usd, released_usd, reconciliation_watermark, settled_at,
                settlement_reason, archive_state, unabsorbed_debit_usd
             ) VALUES ($1, 'target-profile', 'tertiary', 0.005200000000,
                0, 0.005200000000, NULL, pg_catalog.clock_timestamp(),
                'recovery', 'settled', 0)`, [allocationId]
        );
        await serviceQuery(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal')`,
            [allocationId]
        );
        await db.query(`UPDATE public.analysis_beta_pool_allocations SET settled_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours' WHERE id = $1`, [allocationId]);
        await expect(serviceQuery(
            `SELECT public.archive_settled_analysis_beta_apify_credit_allocations(10)`
        )).resolves.toMatchObject({ rows: [{ archive_settled_analysis_beta_apify_credit_allocations: 0 }] });
        expect((await db.query(
            `SELECT lifecycle_state FROM public.analysis_beta_pool_allocations WHERE id = $1`,
            [allocationId]
        )).rows).toEqual([{ lifecycle_state: 'settled' }]);
        expect((await db.query<{ credential_slot: string }>(
            `SELECT credential_slot FROM public.analysis_beta_pool_reservation_archive
             WHERE allocation_id = $1 AND operation_family = 'target-profile'`, [allocationId]
        )).rows).toEqual([{ credential_slot: 'tertiary' }]);
    });

    it('fails closed for active nonterminal retention and accepts only an exact preseeded archive retry', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await expect(serviceQuery(
            `SELECT public.archive_settled_analysis_beta_apify_credit_allocations(10)`
        )).resolves.toMatchObject({ rows: [{ archive_settled_analysis_beta_apify_credit_allocations: 0 }] });
        await expect(db.query(`DELETE FROM public.analysis_preflights WHERE id = $1`, [PREFLIGHT_ID]))
            .rejects.toThrow(/foreign key/i);

        await db.query(`UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`, [REQUEST_ID]);
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`, [REQUEST_ID]
        )).rows[0]!.id;
        await serviceQuery(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal')`,
            [allocationId]
        );
        await db.query(
            `INSERT INTO public.analysis_beta_pool_reservation_archive (
                allocation_id, operation_family, credential_slot, reserved_usd,
                actual_usd, released_usd, reconciliation_watermark, settled_at,
                settlement_reason, archive_state, unabsorbed_debit_usd
             ) SELECT allocation_id, operation_family, credential_slot, reserved_usd,
                 actual_usd, released_usd, reconciliation_watermark, settled_at,
                 settlement_reason, 'settled', actual_usd
               FROM public.analysis_beta_pool_reservations
              WHERE allocation_id = $1 AND operation_family = 'target-profile'`,
            [allocationId]
        );
        await db.query(`UPDATE public.analysis_beta_pool_allocations SET settled_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours' WHERE id = $1`, [allocationId]);
        await expect(serviceQuery(
            `SELECT public.archive_settled_analysis_beta_apify_credit_allocations(10)`
        )).resolves.toBeDefined();
        expect((await db.query(`SELECT id FROM public.analysis_beta_pool_allocations WHERE id = $1`, [allocationId])).rows)
            .toEqual([]);
        expect((await db.query<{ count: number }>(
            `SELECT pg_catalog.count(*)::INTEGER AS count
             FROM public.analysis_beta_pool_reservation_archive WHERE allocation_id = $1`, [allocationId]
        )).rows).toEqual([{ count: 8 }]);
    });

    it('archives deterministic settled family history before allowing retained parents to delete', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(`UPDATE public.analysis_requests SET status = 'failed' WHERE id = $1`, [REQUEST_ID]);
        const allocationId = (await db.query<{ id: string }>(
            `SELECT id FROM public.analysis_beta_pool_allocations WHERE request_id = $1`, [REQUEST_ID]
        )).rows[0]!.id;
        await serviceQuery(
            `SELECT public.settle_analysis_beta_apify_credit_allocation($1, 'request_terminal')`,
            [allocationId]
        );
        await db.query(`UPDATE public.analysis_beta_pool_allocations SET settled_at = pg_catalog.clock_timestamp() - INTERVAL '2 hours' WHERE id = $1`, [allocationId]);
        await expect(serviceQuery(`SELECT public.archive_settled_analysis_beta_apify_credit_allocations(10)`)).resolves.toBeDefined();
        const history = await db.query<{
            allocation_id: string; operation: string; reserved: number; actual: number; released: number;
        }>(`SELECT allocation_id, operation_family AS operation, reserved_usd AS reserved,
                   actual_usd AS actual, released_usd AS released
            FROM public.analysis_beta_pool_reservation_archive ORDER BY operation_family`);
        expect(history.rows).toHaveLength(8);
        expect(history.rows.every(row => Number(row.actual) === 0 && Number(row.released) === Number(row.reserved))).toBe(true);
        await expect(db.query(`DELETE FROM public.analysis_preflights WHERE id = $1`, [PREFLIGHT_ID])).resolves.toBeDefined();
        await db.query(`DELETE FROM public.analysis_pipeline_jobs WHERE request_id = $1`, [REQUEST_ID]);
        await expect(db.query(`DELETE FROM public.analysis_requests WHERE id = $1`, [REQUEST_ID])).resolves.toBeDefined();
        await expect(db.query(`DELETE FROM public.users WHERE id = $1`, [USER_ID])).resolves.toBeDefined();
    });

    it('targeted request settlement works after grant disable and is idempotent', async () => {
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(`UPDATE public.analysis_beta_access_grants SET enabled = FALSE WHERE user_id = $1`, [USER_ID]);
        await db.query(`UPDATE public.analysis_requests SET status = 'completed' WHERE id = $1`, [REQUEST_ID]);
        const first = await serviceQuery<JsonRow<{ lifecycleState: string; heldFamilies: number }>>(
            `SELECT public.settle_analysis_beta_apify_request_credit($1) AS result`,
            [REQUEST_ID],
        );
        expect(first.rows[0]!.result).toMatchObject({ lifecycleState: 'settled', heldFamilies: 0 });
        const replay = await serviceQuery<JsonRow<null>>(
            `SELECT public.settle_analysis_beta_apify_request_credit($1) AS result`,
            [REQUEST_ID],
        );
        expect(replay.rows[0]!.result).toBeNull();
    });

    it('targeted preflight settlement handles expiry but no-ops ready and soft admission blocks', async () => {
        await seedPendingBetaPreflight();
        await expect(serviceQuery<JsonRow<null>>(
            `SELECT public.settle_analysis_beta_apify_preflight_credit($1) AS result`,
            [PREFLIGHT_ID],
        )).resolves.toMatchObject({ rows: [{ result: null }] });
        await db.query(`UPDATE public.analysis_preflights SET status = 'expired' WHERE id = $1`, [PREFLIGHT_ID]);
        const expired = await serviceQuery<JsonRow<{ lifecycleState: string }>>(
            `SELECT public.settle_analysis_beta_apify_preflight_credit($1) AS result`,
            [PREFLIGHT_ID],
        );
        expect(expired.rows[0]!.result).toMatchObject({ lifecycleState: 'settled' });

        await db.exec(`DELETE FROM public.analysis_beta_pool_reservations; DELETE FROM public.analysis_beta_pool_allocations; DELETE FROM public.analysis_preflight_provider_runs; DELETE FROM public.analysis_beta_access_grants; DELETE FROM public.analysis_preflights; DELETE FROM public.users;`);
        await seedPendingBetaRequest();
        await activateBeta();
        await db.query(`UPDATE public.analysis_preflights SET admission_status = 'blocked' WHERE id = $1`, [PREFLIGHT_ID]);
        await expect(serviceQuery<JsonRow<null>>(
            `SELECT public.settle_analysis_beta_apify_preflight_credit($1) AS result`,
            [PREFLIGHT_ID],
        )).resolves.toMatchObject({ rows: [{ result: null }] });
    });

    it('purges unrelated rows while both late rearm FKs and a beta allocation stay fenced', async () => {
        const ids = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await db.query(`INSERT INTO public.users(id) VALUES ($1)`, [USER_ID]);
        for (const [index, id] of ids.entries()) {
            await db.query(
                `INSERT INTO public.analysis_preflights(
                    id,user_id,status,access_mode,target_instagram_id,created_at,
                    expires_at,pii_scrubbed_at
                 ) VALUES ($1,$2,'expired','production',$3,
                    pg_catalog.clock_timestamp()-INTERVAL '2 hours',
                    pg_catalog.clock_timestamp()-INTERVAL '1 hour',
                    pg_catalog.clock_timestamp()-INTERVAL '1 hour')`,
                [id, USER_ID, `retained.${index}`],
            );
        }
        await db.query(`INSERT INTO public.earlybird_adoption_policy_failure_rearms(rearmed_preflight_id) VALUES ($1)`, [ids[0]]);
        await db.query(`INSERT INTO public.earlybird_terminal_unavailable_exhaustion_rearms(rearmed_preflight_id) VALUES ($1)`, [ids[1]]);
        await db.query(
            `INSERT INTO public.analysis_beta_pool_allocations(
                id,preflight_id,user_id,lifecycle_state,policy_version,expires_at
             ) VALUES ($1,$2,$3,'preflight_held','betatest-free-pool-v1',
                pg_catalog.clock_timestamp()+INTERVAL '1 hour')`,
            [randomUUID(), ids[2], USER_ID],
        );
        await expect(serviceQuery(
            `SELECT public.purge_expired_analysis_v2_preflights(10) AS purged`,
        )).resolves.toMatchObject({ rows: [{ purged: 1 }] });
        const remaining = await db.query<{ id: string }>(
            `SELECT id::TEXT FROM public.analysis_preflights ORDER BY id`,
        );
        expect(remaining.rows.map(row => row.id).sort()).toEqual(ids.slice(0, 3).sort());
    });
});
