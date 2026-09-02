import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

const pfe1Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260828071549_recover_earlybird_profile_fetch_exhaustion_fulfillment.sql',
        import.meta.url
    ),
    'utf8'
);
const pfe2Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260828140000_rearm_earlybird_pfe_target_evidence_start_rejection.sql',
        import.meta.url
    ),
    'utf8'
);
const pfe3Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260829090000_rearm_earlybird_pfe3_media_artifact_error.sql',
        import.meta.url
    ),
    'utf8'
);

function retainedScrubToken(id: string): string {
    return `retained.${id.replace(/-/g, '').slice(0, 20)}`;
}

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OLD_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000001';
const PFE1_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000002';
const PFE2_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000003';
const OTHER_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000004';
const ORDER_ID = '30000000-0000-4000-8000-000000000001';
const ORIGINAL_FAILED_REQUEST_ID = '40000000-0000-4000-8000-000000000001';
const REJECTED_REQUEST_ID = '40000000-0000-4000-8000-000000000002';
const MEDIA_FAILED_REQUEST_ID = '40000000-0000-4000-8000-000000000003';
const OTHER_REQUEST_ID = '40000000-0000-4000-8000-000000000004';
const EXPECTED_MANUAL_REVIEW_AT = '2026-08-29T00:00:00.000Z';
const ORDER_TARGET_INSTAGRAM_ID = 'sample_target_03';
const ORDER_HEX = ORDER_ID.replace(/-/g, '');
const REARMED_PREFLIGHT_KEY = `earlybird.fulfillment.${ORDER_HEX}.r2`;

const PFE1_PREFLIGHT_RETAINED_TARGET_ID = retainedScrubToken(PFE1_PREFLIGHT_ID);
const PFE2_PREFLIGHT_RETAINED_TARGET_ID = retainedScrubToken(PFE2_PREFLIGHT_ID);
const MEDIA_FAILED_REQUEST_RETAINED_TARGET_ID = retainedScrubToken(MEDIA_FAILED_REQUEST_ID);

// Foundation schema plus the exact pre-existing stubs and trimmed production
// creator both the first- and second-stage recovery migrations depend on.
// PFE1_PREFLIGHT_ID/rejected-successor B and their own tables are created by
// applying the *real* first- and second-stage migration files below, not
// duplicated here.
const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA extensions;

CREATE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql VOLATILE AS $$
    SELECT pg_catalog.gen_random_uuid()
$$;

CREATE FUNCTION public.analysis_v2_valid_apify_credential_slot(TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT $1 IN ('primary', 'secondary')
$$;

CREATE FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT $1 IS NOT NULL AND pg_catalog.jsonb_typeof($1) = 'object'
$$;
CREATE FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT $1 IS NOT NULL AND pg_catalog.jsonb_typeof($1) = 'object'
$$;
CREATE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT $1 IS NOT NULL AND pg_catalog.jsonb_typeof($1) = 'object'
$$;
CREATE FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT $1 IS NOT NULL AND pg_catalog.jsonb_typeof($1) = 'object'
$$;
CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
    SELECT $1 IS NOT NULL AND pg_catalog.jsonb_typeof($1) = 'object'
$$;

CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email TEXT
);

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    preflight_id UUID,
    idempotency_key TEXT,
    target_instagram_id TEXT,
    pipeline_version TEXT NOT NULL,
    status TEXT NOT NULL,
    current_step TEXT,
    error_message TEXT
);
-- The exact production constraint from 010_transactional_analysis_start.sql:
-- without it a trimmed creator stub can silently mint a colliding
-- idempotency_key that real Postgres would reject.
CREATE UNIQUE INDEX IF NOT EXISTS idx_analysis_requests_user_idempotency
    ON public.analysis_requests(user_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    idempotency_key TEXT NOT NULL,
    target_instagram_id TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    exclusion_decision TEXT,
    excluded_instagram_id TEXT,
    status TEXT NOT NULL,
    admission_status TEXT NOT NULL DEFAULT 'idle',
    access_mode TEXT NOT NULL,
    launch_status_snapshot JSONB,
    plan_catalog_snapshot JSONB,
    plan_cards_snapshot JSONB,
    pricing_version TEXT,
    pricing_snapshot JSONB,
    policy_versions_snapshot JSONB,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    -- The real fresh-admission witness columns from 20260714030000_add_
    -- analysis_v2_fresh_admission_gate.sql: captured once at the preflight's
    -- own fresh-admission pass, and never touched again -- the capacity-safe
    -- count-drift gate under test compares against these, not against a
    -- second live read of the current target counts.
    admission_target_followers_count INTEGER,
    admission_target_following_count INTEGER,
    admission_selected_plan_id TEXT,
    admission_capacity_required_plan_id TEXT,
    admission_required_plan_id TEXT,
    admission_plan_cards_snapshot JSONB,
    consumed_request_id UUID REFERENCES public.analysis_requests(id),
    pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
    order_scoped_apify_credential_slot TEXT
        CHECK (
            order_scoped_apify_credential_slot IS NULL
            OR public.analysis_v2_valid_apify_credential_slot(
                order_scoped_apify_credential_slot
            )
        ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMP WITH TIME ZONE,
    ready_at TIMESTAMP WITH TIME ZONE
);
ALTER TABLE public.analysis_requests
    ADD CONSTRAINT analysis_requests_preflight_fk
    FOREIGN KEY (preflight_id) REFERENCES public.analysis_preflights(id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    target_instagram_id TEXT NOT NULL,
    target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id TEXT,
    plan_id TEXT NOT NULL,
    status TEXT NOT NULL,
    expected_groble_product_id TEXT NOT NULL,
    expected_amount_krw INTEGER NOT NULL,
    payment_id TEXT,
    paid_at TIMESTAMP WITH TIME ZONE,
    actual_groble_product_id TEXT,
    actual_amount_krw INTEGER,
    seller_reference_confirmed_at TIMESTAMP WITH TIME ZONE,
    concierge_apify_credential_slot TEXT
        CHECK (
            concierge_apify_credential_slot IS NULL
            OR public.analysis_v2_valid_apify_credential_slot(
                concierge_apify_credential_slot
            )
        ),
    result_request_id UUID REFERENCES public.analysis_requests(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp()
);

CREATE FUNCTION public.copy_earlybird_order_scoped_apify_slot()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
    IF NEW.preflight_id IS DISTINCT FROM OLD.preflight_id
       AND NEW.preflight_id IS NOT NULL
       AND NEW.concierge_apify_credential_slot IS NOT NULL THEN
        UPDATE public.analysis_preflights
        SET order_scoped_apify_credential_slot = NEW.concierge_apify_credential_slot
        WHERE id = NEW.preflight_id;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER copy_earlybird_order_scoped_apify_slot
AFTER UPDATE OF preflight_id, concierge_apify_credential_slot
ON public.earlybird_orders
FOR EACH ROW EXECUTE FUNCTION public.copy_earlybird_order_scoped_apify_slot();

CREATE TABLE public.earlybird_fulfillments (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    status TEXT NOT NULL,
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    lease_token UUID,
    lease_expires_at TIMESTAMP WITH TIME ZONE,
    next_attempt_at TIMESTAMP WITH TIME ZONE,
    request_id UUID REFERENCES public.analysis_requests(id),
    operator_admitted_at TIMESTAMP WITH TIME ZONE,
    last_error_code TEXT,
    last_error_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE,
    manual_review_at TIMESTAMP WITH TIME ZONE,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL
        DEFAULT pg_catalog.clock_timestamp(),
    CHECK (
        (status = 'manual_review' AND manual_review_at IS NOT NULL)
        OR (status <> 'manual_review' AND manual_review_at IS NULL)
    )
);

CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    track TEXT NOT NULL,
    status TEXT NOT NULL,
    last_error_code TEXT,
    -- The real production column (20260713155145_add_analysis_v2_job_
    -- foundation.sql) is unconstrained beyond BETWEEN 0 AND 100; only the
    -- PFE3 rearm's own exact-incident check narrows it further.
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    PRIMARY KEY (request_id, job_key)
);

-- Trimmed to exactly the columns the PFE3 rearm's eligibility gate reads.
-- Mirrors 20260713170859_add_analysis_v2_ai_attempt_ledger.sql's Gemini
-- AI-attempt ledger -- a distinct table from analysis_v2_provider_runs
-- above, which records only third-party Instagram scraper calls. No FK to
-- analysis_pipeline_jobs(request_id, job_key) is modeled, exactly like the
-- trimmed analysis_v2_provider_runs table above.
CREATE TABLE public.analysis_v2_ai_attempts (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    attempt SMALLINT NOT NULL,
    status TEXT NOT NULL DEFAULT 'reserved'
        CHECK (status IN (
            'reserved', 'success', 'rate_limited', 'ambiguous', 'rejected',
            'response_rejected', 'cutoff'
        )),
    usage_metadata_status TEXT,
    usage_complete BOOLEAN,
    terminalized_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, operation_key, attempt)
);

-- Trimmed to exactly the columns the PFE3 rearm's eligibility gate reads.
-- Mirrors 20260727034000_add_analysis_v2_scheduler_live_operations.sql.
CREATE TABLE public.analysis_v2_scheduler_operations (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed'
        CHECK (status IN ('claimed', 'ready', 'terminal_unavailable')),
    completed_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, operation_key)
);

-- Trimmed to exactly the column the PFE3 rearm's eligibility gate reads.
-- Mirrors 20260810090000_add_revenue_e2e_observability_ledgers.sql, whose
-- own access_mode CHECK pins every row to access_mode = 'test_entitlement'
-- (never 'production'): a production-access-mode earlybird successor can
-- never have a row here, so the gate only ever needs to prove absence.
CREATE TABLE public.analysis_revenue_run_ledgers (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id)
);

CREATE TABLE public.analysis_v2_provider_runs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    logical_provider TEXT,
    actor_id TEXT,
    credential_slot TEXT,
    status TEXT NOT NULL,
    run_id TEXT,
    actual_usage_usd NUMERIC,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key, operation_key)
);

CREATE TABLE public.analysis_v2_recovery_provider_run_adoptions (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    source_request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    source_job_key TEXT NOT NULL,
    source_run_id TEXT NOT NULL,
    PRIMARY KEY (request_id, job_key, operation_key)
);

-- Trimmed to exactly the columns the PFE3 rearm's eligibility gate reads.
-- Mirrors 20260713180254_add_analysis_v2_media_artifacts.sql: rows are never
-- physically removed, only marked deleted_at once terminal cleanup runs.
CREATE TABLE public.analysis_v2_media_artifacts (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    artifact_key VARCHAR(64) NOT NULL,
    registration_job_key VARCHAR(160) NOT NULL,
    artifact_kind VARCHAR(16) NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, artifact_key)
);

-- Mirrors the real schema: request_id is the table's own primary key, so at
-- most one receipt can ever exist per request.
CREATE TABLE public.analysis_v2_failure_receipts (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id),
    failed_job_key TEXT NOT NULL,
    error_code TEXT NOT NULL
);

CREATE TABLE public.earlybird_webhook_events (
    order_id UUID NOT NULL REFERENCES public.earlybird_orders(id),
    event_type TEXT NOT NULL
);

-- The exact shared, append-only admission ledger from
-- 20260730170000_recover_schema_failed_earlybird_fulfillment.sql. The
-- first-stage PFE recovery, the second-stage rearm, and the real creator RPC
-- all depend on it existing.
CREATE TABLE public.earlybird_schema_failure_recoveries (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id)
        ON DELETE RESTRICT,
    failed_request_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_requests(id) ON DELETE RESTRICT,
    recovery_preflight_id UUID NOT NULL UNIQUE
        REFERENCES public.analysis_preflights(id) ON DELETE RESTRICT,
    prior_attempt_count SMALLINT NOT NULL CHECK (
        prior_attempt_count BETWEEN 0 AND 10
    ),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
ALTER TABLE public.earlybird_schema_failure_recoveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.earlybird_schema_failure_recoveries FORCE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.earlybird_schema_failure_recoveries
    FROM PUBLIC, anon, authenticated, service_role;

CREATE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
    RAISE EXCEPTION USING
        MESSAGE = 'EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE',
        ERRCODE = 'P0001';
END;
$$;

CREATE TRIGGER prevent_earlybird_schema_failure_recovery_mutation
BEFORE UPDATE OR DELETE ON public.earlybird_schema_failure_recoveries
FOR EACH ROW
EXECUTE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation();

-- The pre-existing production stub the first-stage PFE migration renames and
-- re-fronts.
CREATE FUNCTION public.earlybird_provider_run_adoption_ready(
    p_order_id UUID,
    p_failed_request_id UUID,
    p_recovery_preflight_id UUID
)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT FALSE;
$$;
REVOKE ALL ON FUNCTION public.earlybird_provider_run_adoption_ready(
    UUID, UUID, UUID
) FROM PUBLIC, anon, authenticated, service_role;

-- The pre-existing production RPC the first-stage PFE migration renames and
-- re-fronts.
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
RETURNS JSONB LANGUAGE sql STABLE AS $$
    SELECT pg_catalog.jsonb_build_object(
        'source', 'pre_pfe_stub',
        'request_id', p_request_id,
        'job_key', p_job_key
    )
$$;
REVOKE ALL ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_analysis_v2_recovery_provider_run(
    UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC
) TO service_role;

-- A faithful trim of the real create_or_replay_earlybird_fulfillment_request
-- RPC (20260731050000_bound_recovered_earlybird_request_generation.sql):
-- every clause of its conflicting-request / recovery-lineage / rebind-
-- preflight-idempotency-key eligibility block, and its provider-run
-- adoption gate, are reproduced verbatim in shape. The plan/pricing/launch
-- eligibility block earlier in the real function is intentionally dropped
-- (permissive here) because it is orthogonal to what this migration chain
-- changes; every scenario below always finds the immutable base-key request
-- as the conflicting request, so this is the block whose exactness matters.
CREATE FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    p_order_id UUID,
    p_lease_token UUID,
    p_lease_fence BIGINT
)
RETURNS TABLE(
    order_id UUID,
    fulfillment_status TEXT,
    request_id UUID,
    created BOOLEAN,
    initial_job_key TEXT
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMP WITH TIME ZONE := pg_catalog.clock_timestamp();
    v_initial_job_key CONSTANT TEXT := 'coordinator:bootstrap';
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
    v_request_id UUID;
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
    IF p_order_id IS NULL OR p_lease_token IS NULL OR p_lease_fence IS NULL
       OR p_lease_fence < 1 THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_INVALID', ERRCODE = 'P0001';
    END IF;

    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id = p_order_id
    FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_NOT_FOUND', ERRCODE = 'P0001';
    END IF;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id = p_order_id
    FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id = v_order.preflight_id
    FOR UPDATE;

    IF v_order.status <> 'paid' OR v_fulfillment.request_id IS NOT NULL
       OR v_order.result_request_id IS NOT NULL
       OR v_preflight.consumed_request_id IS NOT NULL THEN
        RAISE EXCEPTION USING
            MESSAGE = 'EARLYBIRD_FULFILLMENT_SNAPSHOT_CONFLICT', ERRCODE = 'P0001';
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
                    OR v_preflight.access_mode <> 'production'
                    OR v_recovery_preflight.access_mode <> 'production'
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
            SET status = 'manual_review', last_error_code = 'REQUEST_CONFLICT',
                manual_review_at = v_now, updated_at = v_now
            WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT,
                NULL::UUID, FALSE, NULL::TEXT;
            RETURN;
        END IF;

        IF EXISTS (
            SELECT 1 FROM public.analysis_v2_provider_runs AS provider_run
            WHERE provider_run.request_id = v_conflicting_request.id
        ) AND NOT public.earlybird_provider_run_adoption_ready(
            v_order.id, v_conflicting_request.id, v_preflight.id
        ) THEN
            UPDATE public.earlybird_fulfillments AS fulfillment
            SET status = 'manual_review',
                last_error_code = 'PROVIDER_RUN_ADOPTION_REQUIRED',
                manual_review_at = v_now, updated_at = v_now
            WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT,
                NULL::UUID, FALSE, NULL::TEXT;
            RETURN;
        END IF;

        -- Bounded generation computation copied verbatim from the real
        -- creator (20260731050000_bound_recovered_earlybird_request_
        -- generation.sql): the base key counts as generation 0, every
        -- '.r<n>' sibling contributes its own n, and the new request always
        -- takes MAX(existing generations) + 1 -- never a fixed generation --
        -- so it can never collide with an already-minted generation.
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
            SET status = 'manual_review',
                last_error_code = 'REQUEST_IDEMPOTENCY_EXHAUSTED',
                manual_review_at = v_now, updated_at = v_now
            WHERE fulfillment.order_id = p_order_id;
            RETURN QUERY SELECT p_order_id, 'manual_review'::TEXT,
                NULL::UUID, FALSE, NULL::TEXT;
            RETURN;
        END IF;
        v_request_idempotency_key := v_request_generation_prefix
            || v_request_generation::TEXT;
    END IF;

    v_request_id := extensions.gen_random_uuid();
    INSERT INTO public.analysis_requests(
        id, user_id, preflight_id, target_instagram_id, pipeline_version,
        status, current_step, idempotency_key
    ) VALUES (
        v_request_id, v_order.user_id, v_preflight.id, v_order.target_instagram_id,
        'v2', 'pending', 'pending', v_request_idempotency_key
    );
    UPDATE public.analysis_preflights AS preflight
    SET status = 'consumed', consumed_request_id = v_request_id
    WHERE preflight.id = v_preflight.id;
    INSERT INTO public.analysis_pipeline_jobs(
        request_id, job_key, track, status
    ) VALUES (
        v_request_id, v_initial_job_key, 'coordinator', 'pending'
    );
    UPDATE public.earlybird_orders AS earlybird_order
    SET status = 'analysis_in_progress', result_request_id = v_request_id,
        updated_at = v_now
    WHERE earlybird_order.id = p_order_id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status = 'analysis_in_progress', request_id = v_request_id,
        updated_at = v_now
    WHERE fulfillment.order_id = p_order_id;
    RETURN QUERY SELECT p_order_id, 'analysis_in_progress'::TEXT,
        v_request_id, TRUE, v_initial_job_key;
END;
$$;
REVOKE ALL ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID, UUID, BIGINT
) TO service_role;
`;

type RearmRow = {
    order_id: string;
    fulfillment_status: string;
    preflight_id: string;
    failed_request_id: string;
};

const databases: PGlite[] = [];

async function createDb(): Promise<PGlite> {
    const db = await PGlite.create();
    databases.push(db);
    await db.exec(bootstrap);
    await db.exec(pfe1Migration);
    await db.exec(pfe2Migration);
    await db.exec(pfe3Migration);
    return db;
}

async function asRole<T>(
    db: PGlite,
    role: 'authenticated' | 'service_role',
    sql: string,
    params: unknown[] = []
) {
    await db.exec(`SET ROLE ${role}`);
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

type ProviderRunOverride = {
    job_key?: string;
    operation_key?: string;
    logical_provider?: string;
    actor_id?: string;
    credential_slot?: string;
    status?: string;
    run_id?: string | null;
    actual_usage_usd?: number | null;
    usage_reconciled_at?: string | null;
};

type MediaArtifactOverride = {
    artifact_key?: string;
    registration_job_key?: string;
    artifact_kind?: string;
    deleted_at?: string | null;
};

type AiAttemptOverride = {
    job_key?: string;
    operation_key?: string;
    attempt?: number;
    status?: string;
    usage_metadata_status?: string | null;
    usage_complete?: boolean | null;
    terminalized_at?: string | null;
};

type SchedulerOperationOverride = {
    job_key?: string;
    operation_key?: string;
    status?: string;
    completed_at?: string | null;
};

type FixtureOverrides = {
    order?: Record<string, unknown>;
    fulfillment?: Record<string, unknown>;
    request?: Record<string, unknown>;
    preflight?: Record<string, unknown>;
    skipPfe1Lineage?: boolean;
    skipPfe2Lineage?: boolean;
    skipProfileAiJob?: boolean;
    profileAiJobOverrides?: Record<string, unknown>;
    providerRuns?: ProviderRunOverride[];
    skipAdoptionRow?: boolean;
    skipFailureReceipt?: boolean;
    failureReceiptOverrides?: Record<string, unknown>;
    mediaArtifacts?: MediaArtifactOverride[];
    webhookEvents?: string[];
    aiAttempts?: AiAttemptOverride[];
    schedulerOperations?: SchedulerOperationOverride[];
    insertRevenueRunLedger?: boolean;
    planCardsSnapshot?: string;
    adminPlanCardsSnapshot?: string;
};

type StandardCardOverrides = {
    omit?: boolean;
    launchStatus?: string;
    selectionState?: string;
    followersCapacity?: number | string | null;
    followingCapacity?: number | string | null;
};

// The 'standard' card is the plan the fixture's paid order always selects
// (earlybird_orders.plan_id = 'standard' below). Defaults give it generous
// capacity so every test that does not care about the capacity-safe
// count-drift gate keeps passing unmodified; capacity-focused tests override
// individual fields to build the exact invalid/boundary shape they need.
function planCardsSnapshot(standard: StandardCardOverrides = {}): string {
    if (standard.omit) {
        return JSON.stringify({ basic: { launchStatus: 'production' } });
    }
    return JSON.stringify({
        basic: { launchStatus: 'production' },
        standard: {
            launchStatus: standard.launchStatus ?? 'production',
            selectionState: standard.selectionState ?? 'required',
            relationshipCapacity: {
                followers: standard.followersCapacity === undefined
                    ? 5000 : standard.followersCapacity,
                following: standard.followingCapacity === undefined
                    ? 5000 : standard.followingCapacity,
            },
        },
    });
}
const DEFAULT_PLAN_CARDS_SNAPSHOT = planCardsSnapshot();

const DEFAULT_PROVIDER_RUNS: ProviderRunOverride[] = [
    { operation_key: 'target-likers:c001', run_id: 'run-c1' },
    { operation_key: 'target-comments:c002', run_id: 'run-c2' },
    { operation_key: 'target-following:c003', run_id: 'run-c3' },
];

const DEFAULT_MEDIA_ARTIFACTS: MediaArtifactOverride[] = [
    { artifact_key: 'a'.repeat(64), deleted_at: '2026-08-29T00:10:00.000Z' },
    { artifact_key: 'b'.repeat(64), deleted_at: '2026-08-29T00:10:05.000Z' },
];

// The two profile_ai batches (1, 2) that already completed their Gemini
// calls before batch:3's own media-artifact fetch failed -- batch:3 itself
// never reaches an AI attempt, exactly matching the production incident.
const DEFAULT_AI_ATTEMPTS: AiAttemptOverride[] = [
    {
        job_key: 'track:profile-ai:batch:1', operation_key: 'gender-triage-op-1',
        attempt: 1, status: 'success', usage_metadata_status: 'complete',
        usage_complete: true, terminalized_at: '2026-08-29T00:02:00.000Z',
    },
    {
        job_key: 'track:profile-ai:batch:2', operation_key: 'feature-analysis-op-1',
        attempt: 1, status: 'success', usage_metadata_status: 'complete',
        usage_complete: true, terminalized_at: '2026-08-29T00:03:00.000Z',
    },
];

const DEFAULT_SCHEDULER_OPERATIONS: SchedulerOperationOverride[] = [
    {
        job_key: 'track:profile-ai:batch:1', operation_key: 'sched-op-1',
        status: 'ready', completed_at: '2026-08-29T00:02:05.000Z',
    },
    {
        job_key: 'track:profile-ai:batch:2', operation_key: 'sched-op-2',
        status: 'ready', completed_at: '2026-08-29T00:03:05.000Z',
    },
];

// Builds the exact end-state this migration targets: an order already
// recorded in earlybird_pfe_target_evidence_start_rejection_rearms (the
// second-stage rearm; A recovered by the first-stage PFE onto P1, B minted
// on P1 and rearmed by the second stage onto P2), whose second successor
// request C -- created on P2 -- itself terminally failed at
// track:profile-ai:batch:3 with ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR
// after fully succeeded, reconciled provider spend and a fully deleted
// media-artifact registry.
async function buildValidFixture(
    db: PGlite,
    overrides: FixtureOverrides = {}
): Promise<void> {
    await db.query(`INSERT INTO public.users(id, email) VALUES ($1, 'buyer@example.com')`, [USER_ID]);

    const snapshot = JSON.stringify({ basic: { launchStatus: 'production' } });

    // A's own pre-incident preflight, consumed by A.
    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, idempotency_key, target_instagram_id, status, access_mode,
             launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
             pricing_version, pricing_snapshot, policy_versions_snapshot,
             target_followers_count, target_following_count, target_is_private,
             capacity_required_plan_id, required_plan_id
         ) VALUES (
             $1, $2, $3, $4, 'consumed', 'production',
             $5::jsonb, $5::jsonb, $5::jsonb, 'v1', $5::jsonb, $5::jsonb,
             300, 100, FALSE, 'basic', 'basic'
         )`,
        [OLD_PREFLIGHT_ID, USER_ID, 'earlybird.fulfillment.' + ORDER_HEX, ORDER_TARGET_INSTAGRAM_ID, snapshot]
    );
    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, preflight_id, idempotency_key, target_instagram_id,
             pipeline_version, status, current_step, error_message
         ) VALUES (
             $1, $2, $3, $4, $5, 'v2', 'failed', 'failed', 'JOB_ATTEMPTS_EXHAUSTED'
         )`,
        [
            ORIGINAL_FAILED_REQUEST_ID, USER_ID, OLD_PREFLIGHT_ID,
            'earlybird:' + ORDER_ID.toLowerCase(), retainedScrubToken(ORIGINAL_FAILED_REQUEST_ID),
        ]
    );
    await db.query(
        `UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`,
        [OLD_PREFLIGHT_ID, ORIGINAL_FAILED_REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_failure_receipts(request_id, failed_job_key, error_code)
         VALUES ($1, 'track:target-evidence:collect', 'JOB_ATTEMPTS_EXHAUSTED')`,
        [ORIGINAL_FAILED_REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs(
             request_id, job_key, operation_key, status, run_id,
             actual_usage_usd, usage_reconciled_at
         ) VALUES ($1, 'track:target-evidence:collect', 'target-likers:aaaa', 'succeeded', 'run-a1', 0.3, $2)`,
        [ORIGINAL_FAILED_REQUEST_ID, '2026-08-19T12:00:00.000Z']
    );

    // P1: the first-stage PFE's own rebind preflight, consumed by B.
    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, idempotency_key, target_instagram_id, status, access_mode,
             launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
             pricing_version, pricing_snapshot, policy_versions_snapshot,
             target_followers_count, target_following_count, target_is_private,
             capacity_required_plan_id, required_plan_id,
             pii_scrubbed_at, order_scoped_apify_credential_slot
         ) VALUES (
             $1, $2, 'earlybird.schema-recovery.' || $3, $4, 'consumed', 'production',
             $5::jsonb, $5::jsonb, $5::jsonb, 'v1', $5::jsonb, $5::jsonb,
             300, 100, FALSE, 'basic', 'basic', $6, 'secondary'
         )`,
        [
            PFE1_PREFLIGHT_ID, USER_ID, ORDER_HEX, PFE1_PREFLIGHT_RETAINED_TARGET_ID,
            snapshot, '2026-08-26T00:00:00.000Z',
        ]
    );
    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, preflight_id, idempotency_key, target_instagram_id,
             pipeline_version, status, current_step, error_message
         ) VALUES (
             $1, $2, $3, $4, $5, 'v2', 'failed', 'failed',
             'SCRAPING_PROVIDER_START_REJECTED_ERROR'
         )`,
        [
            REJECTED_REQUEST_ID, USER_ID, PFE1_PREFLIGHT_ID,
            'earlybird:' + ORDER_ID.toLowerCase() + '.r1',
            retainedScrubToken(REJECTED_REQUEST_ID),
        ]
    );
    await db.query(
        `UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`,
        [PFE1_PREFLIGHT_ID, REJECTED_REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_failure_receipts(request_id, failed_job_key, error_code)
         VALUES ($1, 'track:target-evidence:collect', 'SCRAPING_PROVIDER_START_REJECTED_ERROR')`,
        [REJECTED_REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code)
         VALUES ($1, 'track:target-evidence:collect', 'target_evidence', 'failed', 'SCRAPING_PROVIDER_START_REJECTED_ERROR')`,
        [REJECTED_REQUEST_ID]
    );
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs(
             request_id, job_key, operation_key, logical_provider, actor_id,
             credential_slot, status, run_id, actual_usage_usd, usage_reconciled_at
         ) VALUES (
             $1, 'track:target-evidence:collect', 'target-likers:bbbb', 'apify',
             'datadoping/instagram-likes-scraper', 'secondary', 'succeeded', 'run-b1',
             0.4, $2
         )`,
        [REJECTED_REQUEST_ID, '2026-08-27T00:05:00.000Z']
    );
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs(
             request_id, job_key, operation_key, logical_provider, actor_id,
             credential_slot, status, run_id, actual_usage_usd, usage_reconciled_at
         ) VALUES (
             $1, 'track:target-evidence:collect', 'target-comments:cccc', 'apify',
             'apify/instagram-comment-scraper', 'secondary', 'rejected', NULL, 0, $2
         )`,
        [REJECTED_REQUEST_ID, '2026-08-27T00:06:00.000Z']
    );

    // P2: the second-stage rearm's own rebind preflight ('.r1'), consumed by
    // C -- the media-artifact-failed request this migration targets.
    const preflight = {
        target_followers_count: 300,
        target_following_count: 100,
        target_is_private: false,
        capacity_required_plan_id: 'basic',
        required_plan_id: 'basic',
        pii_scrubbed_at: '2026-08-28T00:00:00.000Z',
        order_scoped_apify_credential_slot: 'secondary',
        // Defaults match target_followers_count/target_following_count
        // above exactly -- the preflight's own fresh-admission witness has
        // not drifted from itself. admission_selected_plan_id matches the
        // order's own plan_id ('standard' below) for the same reason.
        admission_target_followers_count: 300,
        admission_target_following_count: 100,
        admission_selected_plan_id: 'standard',
        admission_capacity_required_plan_id: 'basic',
        admission_required_plan_id: 'basic',
        ...overrides.preflight,
    };
    const planCards = overrides.planCardsSnapshot ?? DEFAULT_PLAN_CARDS_SNAPSHOT;
    const adminPlanCards = overrides.adminPlanCardsSnapshot ?? planCards;
    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, idempotency_key, target_instagram_id, status, access_mode,
             launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
             pricing_version, pricing_snapshot, policy_versions_snapshot,
             target_followers_count, target_following_count, target_is_private,
             capacity_required_plan_id, required_plan_id,
             pii_scrubbed_at, order_scoped_apify_credential_slot,
             admission_target_followers_count, admission_target_following_count,
             admission_selected_plan_id, admission_capacity_required_plan_id,
             admission_required_plan_id, admission_plan_cards_snapshot
         ) VALUES (
             $1, $2, $3, $4, 'consumed', 'production',
             $5::jsonb, $5::jsonb, $6::jsonb, 'v1', $5::jsonb, $5::jsonb,
             $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $19::jsonb
         )`,
        [
            PFE2_PREFLIGHT_ID, USER_ID, `earlybird.fulfillment.${ORDER_HEX}.r1`,
            PFE2_PREFLIGHT_RETAINED_TARGET_ID, snapshot, planCards,
            preflight.target_followers_count, preflight.target_following_count,
            preflight.target_is_private, preflight.capacity_required_plan_id,
            preflight.required_plan_id, preflight.pii_scrubbed_at,
            preflight.order_scoped_apify_credential_slot,
            preflight.admission_target_followers_count,
            preflight.admission_target_following_count,
            preflight.admission_selected_plan_id,
            preflight.admission_capacity_required_plan_id,
            preflight.admission_required_plan_id,
            adminPlanCards,
        ]
    );

    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, preflight_id, idempotency_key, target_instagram_id,
             pipeline_version, status, current_step, error_message
         ) VALUES (
             $1, $2, $3, $4, $5, 'v2', 'failed', 'failed',
             'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'
         )`,
        [
            MEDIA_FAILED_REQUEST_ID, USER_ID, PFE2_PREFLIGHT_ID,
            'earlybird:' + ORDER_ID.toLowerCase() + '.r2',
            MEDIA_FAILED_REQUEST_RETAINED_TARGET_ID,
        ]
    );
    await db.query(
        `UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`,
        [PFE2_PREFLIGHT_ID, MEDIA_FAILED_REQUEST_ID]
    );
    if (overrides.request) {
        for (const [column, value] of Object.entries(overrides.request)) {
            await db.query(
                `UPDATE public.analysis_requests SET ${column} = $2 WHERE id = $1`,
                [MEDIA_FAILED_REQUEST_ID, value]
            );
        }
    }

    const order = {
        status: 'analysis_in_progress',
        seller_reference_confirmed_at: '2026-08-18T00:00:00.000Z',
        payment_id: 'pay_123',
        paid_at: '2026-08-18T00:00:05.000Z',
        // The exact zero-coupon incident: a 100%-off coupon settles the
        // order at actual_amount_krw = 0 against a positive
        // expected_amount_krw (19900 below), which the migration's
        // eligibility gate must still accept (0 <= actual <= expected).
        actual_amount_krw: 0,
        actual_groble_product_id: 'standard-product-01',
        concierge_apify_credential_slot: 'secondary',
        // Matches the preflight's own default target counts above -- tests
        // that exercise capacity-safe count drift override these directly.
        target_followers_count: 300,
        target_following_count: 100,
        ...overrides.order,
    };
    await db.query(
        `INSERT INTO public.earlybird_orders(
             id, user_id, preflight_id, target_instagram_id, target_followers_count,
             target_following_count, exclusion_decision, plan_id, status,
             expected_groble_product_id, expected_amount_krw, payment_id, paid_at,
             actual_groble_product_id, actual_amount_krw,
             seller_reference_confirmed_at, concierge_apify_credential_slot,
             result_request_id
         ) VALUES (
             $1, $2, $3, $4, $5, $6, 'skip', 'standard', $7,
             'standard-product-01', 19900, $8, $9, $10, $11, $12, $13, $14
         )`,
        [
            ORDER_ID, USER_ID, PFE2_PREFLIGHT_ID, ORDER_TARGET_INSTAGRAM_ID,
            order.target_followers_count, order.target_following_count,
            order.status, order.payment_id, order.paid_at, order.actual_groble_product_id,
            order.actual_amount_krw, order.seller_reference_confirmed_at,
            order.concierge_apify_credential_slot, MEDIA_FAILED_REQUEST_ID,
        ]
    );

    const webhookEvents = overrides.webhookEvents ?? ['payment.completed'];
    for (const eventType of webhookEvents) {
        await db.query(
            `INSERT INTO public.earlybird_webhook_events(order_id, event_type)
             VALUES ($1, $2)`,
            [ORDER_ID, eventType]
        );
    }

    const fulfillment = {
        status: 'manual_review',
        last_error_code: 'ANALYSIS_FAILED',
        manual_review_at: EXPECTED_MANUAL_REVIEW_AT,
        // The exact production fact: the fulfillment-level counter had
        // already reached 3 across the two prior recoveries.
        attempt_count: 3,
        ...overrides.fulfillment,
    };
    await db.query(
        `INSERT INTO public.earlybird_fulfillments(
             order_id, status, attempt_count, request_id, last_error_code,
             manual_review_at
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            ORDER_ID, fulfillment.status, fulfillment.attempt_count,
            MEDIA_FAILED_REQUEST_ID, fulfillment.last_error_code,
            fulfillment.manual_review_at,
        ]
    );

    if (!overrides.skipPfe1Lineage) {
        await db.query(
            `INSERT INTO public.earlybird_profile_fetch_exhaustion_recoveries(
                 order_id, failed_request_id, recovery_preflight_id,
                 prior_attempt_count, expected_manual_review_at
             ) VALUES ($1, $2, $3, 3, '2026-08-20T00:00:00.000Z')`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE1_PREFLIGHT_ID]
        );
        await db.query(
            `INSERT INTO public.earlybird_schema_failure_recoveries(
                 order_id, failed_request_id, recovery_preflight_id, prior_attempt_count
             ) VALUES ($1, $2, $3, 3)`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE1_PREFLIGHT_ID]
        );
    }

    if (!overrides.skipPfe2Lineage) {
        await db.query(
            `INSERT INTO public.earlybird_pfe_target_evidence_start_rejection_rearms(
                 order_id, pfe_original_failed_request_id,
                 rejected_successor_request_id, rearmed_preflight_id,
                 prior_attempt_count, expected_manual_review_at
             ) VALUES ($1, $2, $3, $4, 1, '2026-08-27T00:00:00.000Z')`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, REJECTED_REQUEST_ID, PFE2_PREFLIGHT_ID]
        );
    }

    if (!overrides.skipProfileAiJob) {
        const job = {
            status: 'failed',
            track: 'profile_ai',
            last_error_code: 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR',
            // The exact production fact: the job-level counter had already
            // reached 3 when the media-artifact-object error terminally
            // failed it.
            attempt_count: 3,
            ...overrides.profileAiJobOverrides,
        };
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code, attempt_count)
             VALUES ($1, 'track:profile-ai:batch:3', $2, $3, $4, $5)`,
            [MEDIA_FAILED_REQUEST_ID, job.track, job.status, job.last_error_code, job.attempt_count]
        );
    }

    const aiAttempts = overrides.aiAttempts ?? DEFAULT_AI_ATTEMPTS;
    for (const attemptOverride of aiAttempts) {
        // Object-spread merge (not `??` per field): an override that
        // explicitly sets a field to null (e.g. terminalized_at: null) must
        // survive, which `defaultValue ?? override` would silently discard.
        const attempt = {
            job_key: 'track:profile-ai:batch:1',
            operation_key: 'gender-triage-op-1',
            attempt: 1,
            status: 'success',
            usage_metadata_status: 'complete' as string | null,
            usage_complete: true as boolean | null,
            terminalized_at: '2026-08-29T00:02:00.000Z' as string | null,
            ...attemptOverride,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(
                 request_id, job_key, operation_key, attempt, status,
                 usage_metadata_status, usage_complete, terminalized_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                MEDIA_FAILED_REQUEST_ID, attempt.job_key, attempt.operation_key,
                attempt.attempt, attempt.status, attempt.usage_metadata_status,
                attempt.usage_complete, attempt.terminalized_at,
            ]
        );
    }

    const schedulerOperations = overrides.schedulerOperations ?? DEFAULT_SCHEDULER_OPERATIONS;
    for (const operationOverride of schedulerOperations) {
        const operation = {
            job_key: 'track:profile-ai:batch:1',
            operation_key: 'sched-op-1',
            status: 'ready',
            completed_at: '2026-08-29T00:02:05.000Z' as string | null,
            ...operationOverride,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_scheduler_operations(
                 request_id, job_key, operation_key, status, completed_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
                MEDIA_FAILED_REQUEST_ID, operation.job_key, operation.operation_key,
                operation.status, operation.completed_at,
            ]
        );
    }

    if (overrides.insertRevenueRunLedger) {
        await db.query(
            `INSERT INTO public.analysis_revenue_run_ledgers(request_id) VALUES ($1)`,
            [MEDIA_FAILED_REQUEST_ID]
        );
    }

    const providerRuns = overrides.providerRuns ?? DEFAULT_PROVIDER_RUNS;
    for (const runOverride of providerRuns) {
        // Object-spread merge (not `??` per field): an override that
        // explicitly sets a field to null (e.g. actual_usage_usd: null) must
        // survive, which `defaultValue ?? override` would silently discard.
        const run = {
            job_key: 'track:profile-ai:batch:3',
            operation_key: 'target-likers:c001',
            logical_provider: 'apify',
            actor_id: 'datadoping/instagram-likes-scraper',
            credential_slot: 'secondary',
            status: 'succeeded',
            run_id: null as string | null,
            actual_usage_usd: 0.4 as number | null,
            usage_reconciled_at: '2026-08-29T00:05:00.000Z' as string | null,
            ...runOverride,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                 request_id, job_key, operation_key, logical_provider, actor_id,
                 credential_slot, status, run_id, actual_usage_usd, usage_reconciled_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                MEDIA_FAILED_REQUEST_ID, run.job_key, run.operation_key,
                run.logical_provider, run.actor_id, run.credential_slot,
                run.status, run.run_id, run.actual_usage_usd, run.usage_reconciled_at,
            ]
        );
    }

    if (!overrides.skipAdoptionRow) {
        // Deliberately absent by default: proves zero adoption occurred for
        // the media-failed successor. Tests that need one insert it
        // explicitly.
    }

    if (!overrides.skipFailureReceipt) {
        const receipt = {
            failed_job_key: 'track:profile-ai:batch:3',
            error_code: 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR',
            ...overrides.failureReceiptOverrides,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, failed_job_key, error_code)
             VALUES ($1, $2, $3)`,
            [MEDIA_FAILED_REQUEST_ID, receipt.failed_job_key, receipt.error_code]
        );
    }

    const mediaArtifacts = overrides.mediaArtifacts ?? DEFAULT_MEDIA_ARTIFACTS;
    for (const artifactOverride of mediaArtifacts) {
        // Object-spread merge (not `??` per field): an override that
        // explicitly sets deleted_at: null must survive, which
        // `defaultValue ?? override` would silently discard.
        const artifact = {
            artifact_key: 'a'.repeat(64),
            registration_job_key: 'track:profile-ai:batch:3',
            artifact_kind: 'media_bundle',
            deleted_at: '2026-08-29T00:10:00.000Z' as string | null,
            ...artifactOverride,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_media_artifacts(
                 request_id, artifact_key, registration_job_key, artifact_kind, deleted_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
                MEDIA_FAILED_REQUEST_ID, artifact.artifact_key,
                artifact.registration_job_key, artifact.artifact_kind,
                artifact.deleted_at,
            ]
        );
    }
}

function rearm(
    db: PGlite,
    orderId = ORDER_ID,
    mediaFailedRequestId = MEDIA_FAILED_REQUEST_ID,
    expectedManualReviewAt = EXPECTED_MANUAL_REVIEW_AT
) {
    return asRole<RearmRow>(
        db,
        'service_role',
        `SELECT * FROM public.rearm_earlybird_pfe3_media_artifact_error($1, $2, $3)`,
        [orderId, mediaFailedRequestId, expectedManualReviewAt]
    );
}

async function expectNoRearmMutation(db: PGlite): Promise<void> {
    const ledger = await db.query<{ count: string }>(
        `SELECT pg_catalog.count(*)::TEXT AS count
         FROM public.earlybird_pfe3_media_artifact_rearms WHERE order_id = $1`,
        [ORDER_ID]
    );
    expect(ledger.rows[0].count).toBe('0');

    const order = await db.query<{ status: string; preflight_id: string; result_request_id: string | null }>(
        `SELECT status, preflight_id, result_request_id FROM public.earlybird_orders WHERE id = $1`,
        [ORDER_ID]
    );
    expect(order.rows[0]).toEqual({
        status: 'analysis_in_progress', preflight_id: PFE2_PREFLIGHT_ID, result_request_id: MEDIA_FAILED_REQUEST_ID,
    });

    const fulfillment = await db.query<{ status: string; request_id: string | null }>(
        `SELECT status, request_id FROM public.earlybird_fulfillments WHERE order_id = $1`,
        [ORDER_ID]
    );
    expect(fulfillment.rows[0]).toEqual({ status: 'manual_review', request_id: MEDIA_FAILED_REQUEST_ID });
}

describe('rearm_earlybird_pfe3_media_artifact_error', () => {
    afterAll(async () => {
        await Promise.all(databases.map(database => database.close()));
    });

    it('happy path: rebinds the order onto a fresh (.r2) preflight generation without touching any prior failed lineage', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        const result = await rearm(db);

        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];
        expect(row.order_id).toBe(ORDER_ID);
        expect(row.fulfillment_status).toBe('admission_pending');
        expect(row.failed_request_id).toBe(MEDIA_FAILED_REQUEST_ID);
        expect(row.preflight_id).not.toBe(PFE1_PREFLIGHT_ID);
        expect(row.preflight_id).not.toBe(PFE2_PREFLIGHT_ID);
        expect(row.preflight_id).not.toBe(OLD_PREFLIGHT_ID);

        const preflight = await db.query<{ idempotency_key: string; status: string; order_scoped_apify_credential_slot: string }>(
            `SELECT idempotency_key, status, order_scoped_apify_credential_slot
             FROM public.analysis_preflights WHERE id = $1`,
            [row.preflight_id]
        );
        expect(preflight.rows[0].idempotency_key).toBe(REARMED_PREFLIGHT_KEY);
        expect(preflight.rows[0].status).toBe('ready');
        expect(preflight.rows[0].order_scoped_apify_credential_slot).toBe('secondary');

        const order = await db.query<{ status: string; preflight_id: string; result_request_id: string | null }>(
            `SELECT status, preflight_id, result_request_id FROM public.earlybird_orders WHERE id = $1`,
            [ORDER_ID]
        );
        expect(order.rows[0].status).toBe('paid');
        expect(order.rows[0].preflight_id).toBe(row.preflight_id);
        expect(order.rows[0].result_request_id).toBeNull();

        const fulfillment = await db.query<{ status: string; request_id: string | null; attempt_count: number }>(
            `SELECT status, request_id, attempt_count FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER_ID]
        );
        expect(fulfillment.rows[0].status).toBe('admission_pending');
        expect(fulfillment.rows[0].request_id).toBeNull();
        expect(fulfillment.rows[0].attempt_count).toBe(0);

        // All three failed lineages are untouched.
        const original = await db.query<{ status: string; error_message: string }>(
            `SELECT status, error_message FROM public.analysis_requests WHERE id = $1`,
            [ORIGINAL_FAILED_REQUEST_ID]
        );
        expect(original.rows[0]).toEqual({ status: 'failed', error_message: 'JOB_ATTEMPTS_EXHAUSTED' });
        const rejected = await db.query<{ status: string; error_message: string }>(
            `SELECT status, error_message FROM public.analysis_requests WHERE id = $1`,
            [REJECTED_REQUEST_ID]
        );
        expect(rejected.rows[0]).toEqual({
            status: 'failed', error_message: 'SCRAPING_PROVIDER_START_REJECTED_ERROR',
        });
        const mediaFailed = await db.query<{ status: string; error_message: string }>(
            `SELECT status, error_message FROM public.analysis_requests WHERE id = $1`,
            [MEDIA_FAILED_REQUEST_ID]
        );
        expect(mediaFailed.rows[0]).toEqual({
            status: 'failed', error_message: 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR',
        });

        // The audit ledger records all three lineage ids. Read as the
        // connection's owning role (not service_role, which has no direct
        // table privileges at all -- REVOKE ALL -- exactly like the
        // sibling ledger the restrictive-ACL test below covers).
        const ledger = await db.query<{
            pfe_original_failed_request_id: string;
            pfe2_rejected_successor_request_id: string;
            media_failed_request_id: string;
        }>(
            `SELECT pfe_original_failed_request_id, pfe2_rejected_successor_request_id, media_failed_request_id
             FROM public.earlybird_pfe3_media_artifact_rearms WHERE order_id = $1`,
            [ORDER_ID]
        );
        expect(ledger.rows[0]).toEqual({
            pfe_original_failed_request_id: ORIGINAL_FAILED_REQUEST_ID,
            pfe2_rejected_successor_request_id: REJECTED_REQUEST_ID,
            media_failed_request_id: MEDIA_FAILED_REQUEST_ID,
        });
    });

    it('idempotent replay: a second identical call returns the same rearm without duplicating audit rows', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        const first = await rearm(db);
        const second = await rearm(db);
        expect(second.rows).toEqual(first.rows);

        const count = await db.query<{ count: string }>(
            `SELECT pg_catalog.count(*)::TEXT AS count
             FROM public.earlybird_pfe3_media_artifact_rearms
             WHERE order_id = $1`,
            [ORDER_ID]
        );
        expect(count.rows[0].count).toBe('1');
    });

    it('stale CAS on replay: rejects when the caller-supplied manual_review_at no longer matches the audited rearm', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await rearm(db);
        await expect(
            rearm(db, ORDER_ID, MEDIA_FAILED_REQUEST_ID, '2099-01-01T00:00:00.000Z')
        ).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_CONFLICT');
    });

    it('stale CAS on first admission: rejects before minting anything when the caller-supplied manual_review_at does not match the live fulfillment row', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await expect(
            rearm(db, ORDER_ID, MEDIA_FAILED_REQUEST_ID, '2099-01-01T00:00:00.000Z')
        ).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const count = await db.query<{ count: string }>(
            `SELECT pg_catalog.count(*)::TEXT AS count
             FROM public.earlybird_pfe3_media_artifact_rearms
             WHERE order_id = $1`,
            [ORDER_ID]
        );
        expect(count.rows[0].count).toBe('0');
    });

    it('requires the order to already be recorded in earlybird_pfe_target_evidence_start_rejection_rearms', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipPfe2Lineage: true });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('does not itself require the first-stage lineage row: it trusts the second-stage rearm\'s own immutable ledger', async () => {
        const db = await createDb();
        // earlybird_pfe_target_evidence_start_rejection_rearms already
        // carries its own copy of the original failed request id (verified
        // when the second-stage rearm itself ran); this migration's gate
        // only reads that ledger, so it never needs to re-check the
        // first-stage table directly.
        await buildValidFixture(db, { skipPfe1Lineage: true });
        await expect(rearm(db)).resolves.toMatchObject({
            rows: [{ fulfillment_status: 'admission_pending' }],
        });
    });

    it('rejects when the failure receipt does not match the exact job key and error code', async () => {
        const db = await createDb();
        await buildValidFixture(db, {
            failureReceiptOverrides: { error_code: 'ANALYSIS_V2_JOB_HANDLER_FAILED' },
        });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('requires every provider run to be succeeded, reconciled, and on the secondary slot', async () => {
        const runningRun = await createDb();
        await buildValidFixture(runningRun, {
            providerRuns: [
                ...DEFAULT_PROVIDER_RUNS,
                { operation_key: 'target-following:c999', status: 'running', run_id: 'run-c9', actual_usage_usd: null, usage_reconciled_at: null },
            ],
        });
        await expect(rearm(runningRun)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const wrongSlot = await createDb();
        await buildValidFixture(wrongSlot, {
            providerRuns: [{ ...DEFAULT_PROVIDER_RUNS[0], credential_slot: 'primary' }, ...DEFAULT_PROVIDER_RUNS.slice(1)],
        });
        await expect(rearm(wrongSlot)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const noRuns = await createDb();
        await buildValidFixture(noRuns, { providerRuns: [] });
        await expect(rearm(noRuns)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('rejects when a recovery-provider-run adoption row already exists for the media-failed successor', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await db.query(
            `INSERT INTO public.analysis_v2_recovery_provider_run_adoptions(
                 request_id, job_key, operation_key, source_request_id, source_job_key, source_run_id
             ) VALUES ($1, 'track:profile-ai:batch:3', 'target-likers:c001', $2, 'track:target-evidence:collect', 'run-a1')`,
            [MEDIA_FAILED_REQUEST_ID, ORIGINAL_FAILED_REQUEST_ID]
        );
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('rejects when the order credential slot is not exactly secondary', async () => {
        const db = await createDb();
        await buildValidFixture(db, { order: { concierge_apify_credential_slot: 'primary' } });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('rejects when payment evidence is incomplete or a cancel/refund event exists', async () => {
        const missingPaidAt = await createDb();
        await buildValidFixture(missingPaidAt, { order: { paid_at: null } });
        await expect(rearm(missingPaidAt)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const extraEvent = await createDb();
        await buildValidFixture(extraEvent, { webhookEvents: ['payment.completed', 'payment.cancelled'] });
        await expect(rearm(extraEvent)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('accepts the exact zero-coupon incident: actual_amount_krw = 0 against a positive expected amount', async () => {
        const db = await createDb();
        await buildValidFixture(db, { order: { actual_amount_krw: 0 } });
        await expect(rearm(db)).resolves.toMatchObject({
            rows: [{ fulfillment_status: 'admission_pending' }],
        });
    });

    it('rejects when actual_amount_krw is negative or exceeds the expected amount', async () => {
        const negative = await createDb();
        await buildValidFixture(negative, { order: { actual_amount_krw: -1 } });
        await expect(rearm(negative)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const overpaid = await createDb();
        await buildValidFixture(overpaid, { order: { actual_amount_krw: 999999 } });
        await expect(rearm(overpaid)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('accepts fully witnessed capacity-safe count drift between the paid order and the consumed preflight, and the resulting rearm admits an exact .r3 successor', async () => {
        const db = await createDb();
        // The exact production shape: checkout froze higher order-level
        // relationship counts than this consumed preflight's own later,
        // independent observation. Neither is required to equal the other
        // any more -- only to each independently fit inside the selected
        // 'standard' card's default 5000/5000 capacity.
        await buildValidFixture(db, {
            order: { target_followers_count: 450, target_following_count: 180 },
        });

        await expect(rearm(db)).resolves.toMatchObject({
            rows: [{ fulfillment_status: 'admission_pending' }],
        });

        const created = await asRole<{ request_id: string; created: boolean }>(
            db, 'service_role',
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, 1)`,
            [ORDER_ID, '50000000-0000-4000-8000-000000000099']
        );
        expect(created.rows[0].created).toBe(true);
        const request = await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_requests WHERE id = $1`,
            [created.rows[0].request_id]
        );
        // Base ('.'-less), '.r1' (B), and '.r2' (C) are already taken on the
        // shared 'earlybird:<order>' base key, so the bounded generation
        // computation must mint exactly '.r3'.
        expect(request.rows[0].idempotency_key).toBe('earlybird:' + ORDER_ID.toLowerCase() + '.r3');
    });

    it('rejects when the paid order or the consumed preflight observes a negative relationship count', async () => {
        const negativeOrderFollowers = await createDb();
        await buildValidFixture(negativeOrderFollowers, { order: { target_followers_count: -1 } });
        await expect(rearm(negativeOrderFollowers)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(negativeOrderFollowers);

        const negativePreflightFollowing = await createDb();
        await buildValidFixture(negativePreflightFollowing, {
            preflight: { target_following_count: -1, admission_target_following_count: -1 },
        });
        await expect(rearm(negativePreflightFollowing)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(negativePreflightFollowing);
    });

    it("rejects when the preflight's own fresh-admission target-count witness is missing or has drifted from its current counts", async () => {
        const missingWitness = await createDb();
        await buildValidFixture(missingWitness, { preflight: { admission_target_followers_count: null } });
        await expect(rearm(missingWitness)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(missingWitness);

        const driftedWitness = await createDb();
        await buildValidFixture(driftedWitness, { preflight: { admission_target_following_count: 999 } });
        await expect(rearm(driftedWitness)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(driftedWitness);
    });

    it("rejects when the preflight's admission-time selected plan does not match the order's paid plan", async () => {
        const db = await createDb();
        await buildValidFixture(db, { preflight: { admission_selected_plan_id: 'basic' } });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(db);
    });

    it("rejects when the admission-time capacity/required-plan or plan-cards witnesses no longer match the preflight's current snapshots", async () => {
        const capacityPlanDrift = await createDb();
        await buildValidFixture(capacityPlanDrift, { preflight: { admission_capacity_required_plan_id: 'standard' } });
        await expect(rearm(capacityPlanDrift)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(capacityPlanDrift);

        const requiredPlanDrift = await createDb();
        await buildValidFixture(requiredPlanDrift, { preflight: { admission_required_plan_id: 'standard' } });
        await expect(rearm(requiredPlanDrift)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(requiredPlanDrift);

        const cardsSnapshotDrift = await createDb();
        await buildValidFixture(cardsSnapshotDrift, {
            adminPlanCardsSnapshot: planCardsSnapshot({ followersCapacity: 9000 }),
        });
        await expect(rearm(cardsSnapshotDrift)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(cardsSnapshotDrift);
    });

    it('rejects when the plan-selected card is missing, not launched to production, or not in a selectable state', async () => {
        const missingCard = await createDb();
        const missingCardCards = planCardsSnapshot({ omit: true });
        await buildValidFixture(missingCard, {
            planCardsSnapshot: missingCardCards, adminPlanCardsSnapshot: missingCardCards,
        });
        await expect(rearm(missingCard)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(missingCard);

        const notProduction = await createDb();
        const notProductionCards = planCardsSnapshot({ launchStatus: 'beta' });
        await buildValidFixture(notProduction, {
            planCardsSnapshot: notProductionCards, adminPlanCardsSnapshot: notProductionCards,
        });
        await expect(rearm(notProduction)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(notProduction);

        const notSelectable = await createDb();
        const notSelectableCards = planCardsSnapshot({ selectionState: 'excluded' });
        await buildValidFixture(notSelectable, {
            planCardsSnapshot: notSelectableCards, adminPlanCardsSnapshot: notSelectableCards,
        });
        await expect(rearm(notSelectable)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(notSelectable);
    });

    it('rejects when the selected card capacity is missing or not a plain non-negative integer', async () => {
        const missingFollowers = await createDb();
        const missingFollowersCards = planCardsSnapshot({ followersCapacity: null });
        await buildValidFixture(missingFollowers, {
            planCardsSnapshot: missingFollowersCards, adminPlanCardsSnapshot: missingFollowersCards,
        });
        await expect(rearm(missingFollowers)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(missingFollowers);

        const nonNumericFollowing = await createDb();
        const nonNumericCards = planCardsSnapshot({ followingCapacity: 'unlimited' });
        await buildValidFixture(nonNumericFollowing, {
            planCardsSnapshot: nonNumericCards, adminPlanCardsSnapshot: nonNumericCards,
        });
        await expect(rearm(nonNumericFollowing)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(nonNumericFollowing);
    });

    it('rejects when either the paid order or the consumed preflight observes a count above the selected card capacity', async () => {
        const orderAboveCapacity = await createDb();
        await buildValidFixture(orderAboveCapacity, { order: { target_followers_count: 6000 } });
        await expect(rearm(orderAboveCapacity)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(orderAboveCapacity);

        const preflightAboveCapacity = await createDb();
        await buildValidFixture(preflightAboveCapacity, {
            preflight: { target_following_count: 6000, admission_target_following_count: 6000 },
        });
        await expect(rearm(preflightAboveCapacity)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
        await expectNoRearmMutation(preflightAboveCapacity);
    });

    it('rejects when the order has an active competing request or preflight for the same user', async () => {
        const activeRequest = await createDb();
        await buildValidFixture(activeRequest);
        await activeRequest.query(
            `INSERT INTO public.analysis_preflights(
                 id, user_id, idempotency_key, target_instagram_id, status, access_mode
             ) VALUES ($1, $2, 'other-key', 'other_target', 'ready', 'production')`,
            [OTHER_PREFLIGHT_ID, USER_ID]
        );
        await activeRequest.query(
            `INSERT INTO public.analysis_requests(
                 id, user_id, preflight_id, idempotency_key, target_instagram_id,
                 pipeline_version, status, current_step
             ) VALUES ($1, $2, $3, 'other-request-key', 'other_target', 'v2', 'processing', 'coordinator:bootstrap')`,
            [OTHER_REQUEST_ID, USER_ID, OTHER_PREFLIGHT_ID]
        );
        await expect(rearm(activeRequest)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('rejects when the pipeline job evidence for track:profile-ai:batch:3 is missing or wrong', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipProfileAiJob: true });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const stillActive = await createDb();
        await buildValidFixture(stillActive, { profileAiJobOverrides: { status: 'retryable' } });
        await expect(rearm(stillActive)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        // The pipeline track column uses an underscore ('profile_ai') even
        // though the job_key segment stays hyphenated
        // ('track:profile-ai:batch:3'); a hyphenated track value must not
        // satisfy the gate.
        const wrongTrackSpelling = await createDb();
        await buildValidFixture(wrongTrackSpelling, { profileAiJobOverrides: { track: 'profile-ai' } });
        await expect(rearm(wrongTrackSpelling)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    }, 30_000);

    it('forbids any undeleted media artifact for the media-failed successor', async () => {
        const db = await createDb();
        await buildValidFixture(db, {
            mediaArtifacts: [
                { artifact_key: 'a'.repeat(64), deleted_at: '2026-08-29T00:10:00.000Z' },
                { artifact_key: 'b'.repeat(64), deleted_at: null },
            ],
        });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('requires at least one media artifact registered by the exact failing job', async () => {
        const db = await createDb();
        await buildValidFixture(db, { mediaArtifacts: [] });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const wrongJob = await createDb();
        await buildValidFixture(wrongJob, {
            mediaArtifacts: [
                { artifact_key: 'a'.repeat(64), registration_job_key: 'track:profile-ai:batch:2', deleted_at: '2026-08-29T00:10:00.000Z' },
            ],
        });
        await expect(rearm(wrongJob)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('rejects when the exact failing job attempt_count does not match the production incident (3)', async () => {
        const tooFew = await createDb();
        await buildValidFixture(tooFew, { profileAiJobOverrides: { attempt_count: 2 } });
        await expect(rearm(tooFew)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const tooMany = await createDb();
        await buildValidFixture(tooMany, { profileAiJobOverrides: { attempt_count: 4 } });
        await expect(rearm(tooMany)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('requires at least one AI attempt for the successor, distinct from the Instagram-scraper analysis_v2_provider_runs ledger', async () => {
        const db = await createDb();
        await buildValidFixture(db, { aiAttempts: [] });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('rejects when any AI attempt for the successor is still reserved (non-terminal)', async () => {
        const db = await createDb();
        await buildValidFixture(db, {
            aiAttempts: [
                ...DEFAULT_AI_ATTEMPTS,
                {
                    job_key: 'track:profile-ai:batch:2', operation_key: 'feature-analysis-op-2',
                    attempt: 1, status: 'reserved', usage_metadata_status: null,
                    usage_complete: null, terminalized_at: null,
                },
            ],
        });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('rejects when a terminal AI attempt is missing its usage-accounting shape', async () => {
        const missingUsageStatus = await createDb();
        await buildValidFixture(missingUsageStatus, {
            aiAttempts: [{ ...DEFAULT_AI_ATTEMPTS[0], usage_metadata_status: null }, DEFAULT_AI_ATTEMPTS[1]],
        });
        await expect(rearm(missingUsageStatus)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const missingUsageComplete = await createDb();
        await buildValidFixture(missingUsageComplete, {
            aiAttempts: [{ ...DEFAULT_AI_ATTEMPTS[0], usage_complete: null }, DEFAULT_AI_ATTEMPTS[1]],
        });
        await expect(rearm(missingUsageComplete)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');

        const missingTerminalizedAt = await createDb();
        await buildValidFixture(missingTerminalizedAt, {
            aiAttempts: [{ ...DEFAULT_AI_ATTEMPTS[0], terminalized_at: null }, DEFAULT_AI_ATTEMPTS[1]],
        });
        await expect(rearm(missingTerminalizedAt)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('rejects when a scheduler operation for the successor is still actively claimed', async () => {
        const db = await createDb();
        await buildValidFixture(db, {
            schedulerOperations: [
                ...DEFAULT_SCHEDULER_OPERATIONS,
                {
                    job_key: 'track:profile-ai:batch:2', operation_key: 'sched-op-3',
                    status: 'claimed', completed_at: null,
                },
            ],
        });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('accepts a terminal_unavailable scheduler operation: only "claimed" is non-terminal', async () => {
        const db = await createDb();
        await buildValidFixture(db, {
            schedulerOperations: [
                ...DEFAULT_SCHEDULER_OPERATIONS,
                {
                    job_key: 'track:profile-ai:batch:2', operation_key: 'sched-op-3',
                    status: 'terminal_unavailable', completed_at: null,
                },
            ],
        });
        await expect(rearm(db)).resolves.toMatchObject({
            rows: [{ fulfillment_status: 'admission_pending' }],
        });
    });

    it('rejects when a revenue run ledger row exists for the successor: production access_mode requests can never have one', async () => {
        const db = await createDb();
        await buildValidFixture(db, { insertRevenueRunLedger: true });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE3_MEDIA_ARTIFACT_REARM_INELIGIBLE');
    });

    it('restrictive ACL: only service_role may execute, and no other role can read or write the audit table', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        await expect(asRole(
            db, 'authenticated',
            `SELECT * FROM public.rearm_earlybird_pfe3_media_artifact_error($1, $2, $3)`,
            [ORDER_ID, MEDIA_FAILED_REQUEST_ID, EXPECTED_MANUAL_REVIEW_AT]
        )).rejects.toThrow();

        await expect(asRole(
            db, 'authenticated',
            `SELECT * FROM public.earlybird_pfe3_media_artifact_rearms`
        )).rejects.toThrow();

        await rearm(db);
        await expect(asRole(
            db, 'authenticated',
            `DELETE FROM public.earlybird_pfe3_media_artifact_rearms WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow();
        // The audit ledger is append-only even to service_role: REVOKE ALL
        // means service_role has no direct table privileges at all, so this
        // is blocked before the immutability trigger ever gets a chance to
        // fire -- exactly like both sibling ledgers.
        await expect(asRole(
            db, 'service_role',
            `DELETE FROM public.earlybird_pfe3_media_artifact_rearms WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE|permission denied/i);
        // The immutability guard itself still holds when reached directly
        // (as the connection's owning role, matching how it is actually
        // reached in production -- only ever from inside another SECURITY
        // DEFINER function's own privileged body).
        await expect(db.query(
            `DELETE FROM public.earlybird_pfe3_media_artifact_rearms WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow('EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE');
    });
});

describe('resolve_analysis_v2_recovery_provider_run (post-pfe3-rearm successor resolver wrapper)', () => {
    async function admitSuccessor(db: PGlite): Promise<string> {
        await buildValidFixture(db);
        await rearm(db);
        const created = await asRole<{ request_id: string; created: boolean }>(
            db, 'service_role',
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, 1)`,
            [ORDER_ID, '50000000-0000-4000-8000-000000000001']
        );
        expect(created.rows[0].created).toBe(true);
        return created.rows[0].request_id;
    }

    it('returns NULL for the exact successor request this rearm lineage produced, forcing a brand-new provider call', async () => {
        const db = await createDb();
        const successorId = await admitSuccessor(db);

        const result = await asRole<{ resolve_analysis_v2_recovery_provider_run: unknown }>(
            db, 'service_role',
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                 $1, 'track:profile-ai:batch:1', $2, 'profile-ai:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'datadoping/instagram-likes-scraper',
                 'secondary', 0.5
             )`,
            [successorId, '60000000-0000-4000-8000-000000000001']
        );
        expect(result.rows[0].resolve_analysis_v2_recovery_provider_run).toBeNull();
    });

    it("delegates byte-for-byte to the renamed resolver for a request that is not this lineage's successor", async () => {
        const db = await createDb();
        const result = await asRole<{ resolve_analysis_v2_recovery_provider_run: { source: string } }>(
            db, 'service_role',
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                 $1, 'track:profile-ai:batch:1', $2, 'profile-ai:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'datadoping/instagram-likes-scraper',
                 'secondary', 0.5
             )`,
            [OTHER_REQUEST_ID, '60000000-0000-4000-8000-000000000002']
        );
        expect(result.rows[0].resolve_analysis_v2_recovery_provider_run).toEqual({
            source: 'pre_pfe_stub', request_id: OTHER_REQUEST_ID, job_key: 'track:profile-ai:batch:1',
        });
    });

    it('restrictive ACL: only service_role may execute the wrapper, and the renamed resolvers are not directly callable', async () => {
        const db = await createDb();
        await expect(asRole(
            db, 'authenticated',
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                 $1, 'track:profile-ai:batch:1', $2, 'profile-ai:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'datadoping/instagram-likes-scraper',
                 'secondary', 0.5
             )`,
            [OTHER_REQUEST_ID, '60000000-0000-4000-8000-000000000003']
        )).rejects.toThrow();

        await expect(asRole(
            db, 'service_role',
            `SELECT public.resolve_analysis_v2_recovery_provider_run_pre_pfe3(
                 $1, 'track:profile-ai:batch:1', $2, 'profile-ai:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'datadoping/instagram-likes-scraper',
                 'secondary', 0.5
             )`,
            [OTHER_REQUEST_ID, '60000000-0000-4000-8000-000000000004']
        )).rejects.toThrow();
    });
});

describe('earlybird_provider_run_adoption_ready (PFE3 media-artifact lineage readiness helper)', () => {
    // Called directly as the connection's owning role (not via asRole/SET
    // ROLE): the dispatcher's REVOKE ALL ... FROM PUBLIC, anon,
    // authenticated, service_role matches its real production ACL, where it
    // is only ever reached internally from create_or_replay_earlybird_
    // fulfillment_request's own SECURITY DEFINER body -- never called
    // directly by an exposed role. The restrictive-ACL test below proves
    // service_role itself has no EXECUTE.
    function readinessReady(db: PGlite, failedRequestId: string, preflightId: string) {
        return db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3) AS ready`,
            [ORDER_ID, failedRequestId, preflightId]
        );
    }

    it('is ready once the rearmed lineage matches the order/original-failed-request/preflight triple exactly', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        const rearmed = await rearm(db);
        const row = rearmed.rows[0];

        await expect(readinessReady(db, ORIGINAL_FAILED_REQUEST_ID, row.preflight_id))
            .resolves.toMatchObject({ rows: [{ ready: true }] });
    });

    it('is not ready for either intervening successor request, only the original job-exhausted one', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        const rearmed = await rearm(db);
        const row = rearmed.rows[0];

        await expect(readinessReady(db, REJECTED_REQUEST_ID, row.preflight_id))
            .resolves.toMatchObject({ rows: [{ ready: false }] });
        await expect(readinessReady(db, MEDIA_FAILED_REQUEST_ID, row.preflight_id))
            .resolves.toMatchObject({ rows: [{ ready: false }] });
    });

    it('is not ready once the order has moved off the paid state the rearm admitted it into', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        const rearmed = await rearm(db);
        const row = rearmed.rows[0];
        await db.query(`UPDATE public.earlybird_orders SET status = 'analysis_in_progress' WHERE id = $1`, [ORDER_ID]);

        await expect(readinessReady(db, ORIGINAL_FAILED_REQUEST_ID, row.preflight_id))
            .resolves.toMatchObject({ rows: [{ ready: false }] });
    });

    it('restrictive ACL: no exposed role may execute either readiness helper', async () => {
        const db = await createDb();

        await expect(db.query<{
            service_execute: boolean;
            authenticated_execute: boolean;
        }>(`SELECT
            has_function_privilege(
                'service_role', 'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)', 'EXECUTE'
            ) AS service_execute,
            has_function_privilege(
                'authenticated', 'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)', 'EXECUTE'
            ) AS authenticated_execute
        `)).resolves.toMatchObject({
            rows: [{ service_execute: false, authenticated_execute: false }],
        });

        await expect(asRole(
            db, 'authenticated',
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3)`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE2_PREFLIGHT_ID]
        )).rejects.toThrow(/permission denied/i);
        await expect(asRole(
            db, 'service_role',
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3)`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE2_PREFLIGHT_ID]
        )).rejects.toThrow(/permission denied/i);
        await expect(asRole(
            db, 'service_role',
            `SELECT public.earlybird_provider_run_adoption_ready_pre_pfe3($1, $2, $3)`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE2_PREFLIGHT_ID]
        )).rejects.toThrow(/permission denied/i);
    });
});

describe('create_or_replay_earlybird_fulfillment_request (post-pfe3-rearm successor admission)', () => {
    it('admits exactly one distinct .r3 successor request once the rearm makes the lineage provider-run-adoption ready', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await rearm(db);

        const created = await asRole<{ request_id: string; created: boolean; fulfillment_status: string }>(
            db, 'service_role',
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, 1)`,
            [ORDER_ID, '50000000-0000-4000-8000-000000000002']
        );
        expect(created.rows[0].created).toBe(true);
        expect(created.rows[0].fulfillment_status).toBe('analysis_in_progress');
        expect(created.rows[0].request_id).not.toBe(ORIGINAL_FAILED_REQUEST_ID);
        expect(created.rows[0].request_id).not.toBe(REJECTED_REQUEST_ID);
        expect(created.rows[0].request_id).not.toBe(MEDIA_FAILED_REQUEST_ID);

        const preflight = await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_preflights
             WHERE consumed_request_id = $1`,
            [created.rows[0].request_id]
        );
        expect(preflight.rows[0].idempotency_key).toBe(REARMED_PREFLIGHT_KEY);

        // Base ('.'-less), '.r1' (B), and '.r2' (C, the media-failed
        // successor) are already taken on the shared 'earlybird:<order>'
        // base key; the real creator's bounded generation computation must
        // mint the next free generation ('.r3'), never re-mint an existing
        // one.
        const request = await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_requests WHERE id = $1`,
            [created.rows[0].request_id]
        );
        expect(request.rows[0].idempotency_key).toBe(
            `earlybird:${ORDER_ID.toLowerCase()}.r3`
        );

        // Proves the production unique index on
        // analysis_requests(user_id, idempotency_key) never sees a
        // collision across all four generations for this user.
        const duplicates = await db.query<{ count: string }>(
            `SELECT pg_catalog.count(*)::TEXT AS count
             FROM (
                 SELECT idempotency_key
                 FROM public.analysis_requests
                 WHERE user_id = $1
                 GROUP BY idempotency_key
                 HAVING pg_catalog.count(*) > 1
             ) AS duplicate_key`,
            [USER_ID]
        );
        expect(duplicates.rows[0].count).toBe('0');
    });

    it('enforces the production unique index on analysis_requests(user_id, idempotency_key), rejecting a duplicate key outright', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        // MEDIA_FAILED_REQUEST_ID already owns 'earlybird:<order>.r2' for
        // USER_ID; a second row with the exact same (user_id,
        // idempotency_key) pair must be rejected by the index itself,
        // independent of any application-level generation logic.
        await expect(
            db.query(
                `INSERT INTO public.analysis_requests(
                     id, user_id, preflight_id, idempotency_key, target_instagram_id,
                     pipeline_version, status, current_step
                 ) VALUES ($1, $2, $3, $4, 'dup_target', 'v2', 'pending', 'pending')`,
                [
                    '40000000-0000-4000-8000-000000000099', USER_ID, PFE2_PREFLIGHT_ID,
                    `earlybird:${ORDER_ID.toLowerCase()}.r2`,
                ]
            )
        ).rejects.toThrow(/duplicate key|unique constraint/i);
    });
});

describe('earlybird_pfe3_media_artifact_rearms (explicit constraint naming)', () => {
    it('names every PK/UNIQUE/FK/CHECK constraint explicitly, each within the 63-byte Postgres identifier limit', async () => {
        const db = await createDb();

        const constraints = await db.query<{ conname: string; contype: string }>(
            `SELECT pg_constraint.conname, pg_constraint.contype
             FROM pg_catalog.pg_constraint
             JOIN pg_catalog.pg_class ON pg_class.oid = pg_constraint.conrelid
             WHERE pg_class.relname = 'earlybird_pfe3_media_artifact_rearms'
             ORDER BY pg_constraint.conname`
        );

        // p = PRIMARY KEY, u = UNIQUE, f = FOREIGN KEY, c = CHECK.
        expect(constraints.rows.map(row => row.conname).sort()).toEqual(
            [
                'pfe3_rearms_b_req_fk',
                'pfe3_rearms_b_req_key',
                'pfe3_rearms_distinct_chk',
                'pfe3_rearms_media_req_fk',
                'pfe3_rearms_media_req_key',
                'pfe3_rearms_order_fk',
                'pfe3_rearms_orig_req_fk',
                'pfe3_rearms_orig_req_key',
                'pfe3_rearms_pkey',
                'pfe3_rearms_preflight_fk',
                'pfe3_rearms_preflight_key',
                'pfe3_rearms_prior_attempt_chk',
            ].sort()
        );
        expect(constraints.rows.map(row => row.contype).sort()).toEqual(
            ['c', 'c', 'f', 'f', 'f', 'f', 'f', 'p', 'u', 'u', 'u', 'u'].sort()
        );
        for (const row of constraints.rows) {
            expect(Buffer.byteLength(row.conname, 'utf8')).toBeLessThanOrEqual(63);
        }
    });
});
