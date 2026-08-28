import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

// The generic 20260829110000 consumer-hotfix migration is NOT loaded here.
// It was rolled back in production for a text[] vs varchar[] comparison bug
// and has since been fixed and merged separately (#520, the cast-to-text
// fix). This migration's own gate never calls anything 20260829110000
// defines -- it reads the persistent analysis_v2_profile_fetch_telemetry
// rollup, not the bounded direct-consumer function -- so PFE4's own
// correctness does not depend on that migration's content, only on running
// after it in deployment order (already true by timestamp). Loading it here
// would add an unrelated dependency to this suite for no gate coverage.
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
const pfe4Migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260829130000_rearm_earlybird_pfe4_profile_consumer_failure.sql',
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
const PFE3_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000004';
const ORDER_ID = '30000000-0000-4000-8000-000000000001';
const ORIGINAL_FAILED_REQUEST_ID = '40000000-0000-4000-8000-000000000001';
const REJECTED_REQUEST_ID = '40000000-0000-4000-8000-000000000002';
const MEDIA_FAILED_REQUEST_ID = '40000000-0000-4000-8000-000000000003';
const CONSUMER_FAILED_REQUEST_ID = '40000000-0000-4000-8000-000000000004';
const OTHER_REQUEST_ID = '40000000-0000-4000-8000-000000000005';
const EXPECTED_MANUAL_REVIEW_AT = '2026-08-29T00:00:00.000Z';
const ORDER_TARGET_INSTAGRAM_ID = 'sample_target_04';
const ORDER_HEX = ORDER_ID.replace(/-/g, '');
const REARMED_PREFLIGHT_KEY = `earlybird.fulfillment.${ORDER_HEX}.r3`;
const PFE3_CONSUMED_PREFLIGHT_KEY = `earlybird.fulfillment.${ORDER_HEX}.r2`;
const CONSUMER_FAILED_REQUEST_KEY = `earlybird:${ORDER_ID.toLowerCase()}.r3`;

const PFE3_PREFLIGHT_RETAINED_TARGET_ID = retainedScrubToken(PFE3_PREFLIGHT_ID);
const CONSUMER_FAILED_REQUEST_RETAINED_TARGET_ID = retainedScrubToken(CONSUMER_FAILED_REQUEST_ID);

// Foundation schema plus the exact pre-existing stubs and trimmed production
// creator every rearm migration in this lineage depends on. The bootstrap
// mirrors lib/services/analysis/earlybird-pfe3-media-artifact-rearm-pglite.
// test.ts's own bootstrap, plus the two tables unique to PFE4's own gate:
// analysis_v2_profile_fetch_telemetry (the persistent per-batch rollup) and
// analysis_results (the zero-result witness).
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
    attempt_count SMALLINT NOT NULL DEFAULT 0,
    PRIMARY KEY (request_id, job_key)
);

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

CREATE TABLE public.analysis_v2_scheduler_operations (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    operation_key TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'claimed'
        CHECK (status IN ('claimed', 'ready', 'terminal_unavailable')),
    completed_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, operation_key)
);

CREATE TABLE public.analysis_revenue_run_ledgers (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id)
);

CREATE TABLE public.analysis_results (
    id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id)
);

-- Trimmed to exactly the columns PFE4's own gate reads. Mirrors
-- 20260714033000_add_analysis_v2_operational_observability.sql's persistent,
-- PII-free per-(request,job_key,source,status,failure_category,http_status)
-- rollup -- the only surviving evidence of a batch's fresh-Apify telemetry
-- once its raw checkpoint rows are cleaned up.
CREATE TABLE public.analysis_v2_profile_fetch_telemetry (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    source TEXT NOT NULL,
    status TEXT NOT NULL,
    failure_category TEXT,
    http_status SMALLINT,
    outcome_count SMALLINT NOT NULL
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

CREATE TABLE public.analysis_v2_media_artifacts (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    artifact_key VARCHAR(64) NOT NULL,
    registration_job_key VARCHAR(160) NOT NULL,
    artifact_kind VARCHAR(16) NOT NULL,
    deleted_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, artifact_key)
);

CREATE TABLE public.analysis_v2_failure_receipts (
    request_id UUID PRIMARY KEY REFERENCES public.analysis_requests(id),
    failed_job_key TEXT NOT NULL,
    error_code TEXT NOT NULL
);

CREATE TABLE public.earlybird_webhook_events (
    order_id UUID NOT NULL REFERENCES public.earlybird_orders(id),
    event_type TEXT NOT NULL
);

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
-- RPC (20260731050000_bound_recovered_earlybird_request_generation.sql).
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
    await db.exec(pfe4Migration);
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

const DEFAULT_SNAPSHOT = JSON.stringify({ basic: { launchStatus: 'production' } });
const DEFAULT_PLAN_CARDS_SNAPSHOT = JSON.stringify({
    basic: { launchStatus: 'production' },
    standard: {
        launchStatus: 'production',
        selectionState: 'required',
        relationshipCapacity: { followers: 5000, following: 5000 },
    },
});

type TelemetryRow = {
    job_key: string;
    source: string;
    status: string;
    failure_category: string | null;
    http_status: number | null;
    outcome_count: number;
};

function defaultTelemetryRows(): TelemetryRow[] {
    return [
        { job_key: 'track:profiles:batch:5', source: 'fresh_apify', status: 'success', failure_category: null, http_status: null, outcome_count: 29 },
        { job_key: 'track:profiles:batch:5', source: 'fresh_apify', status: 'failed', failure_category: 'incomplete', http_status: null, outcome_count: 1 },
        { job_key: 'track:profiles:batch:7', source: 'fresh_apify', status: 'success', failure_category: null, http_status: null, outcome_count: 26 },
        { job_key: 'track:profiles:batch:7', source: 'fresh_apify', status: 'failed', failure_category: 'incomplete', http_status: null, outcome_count: 1 },
    ];
}

type FixtureOverrides = {
    order?: Record<string, unknown>;
    fulfillment?: Record<string, unknown>;
    request?: Record<string, unknown>;
    preflight?: Record<string, unknown>;
    profileAiJob5Overrides?: Record<string, unknown>;
    profileAiJob7Overrides?: Record<string, unknown>;
    skipProfileAiJob5?: boolean;
    skipProfileAiJob7?: boolean;
    telemetryRows?: TelemetryRow[];
    providerRunCount?: number;
    providerRunBadRow?: boolean;
    aiAttemptCount?: number;
    aiAttemptReservedCount?: number;
    mediaArtifactCount?: number;
    mediaArtifactUndeletedCount?: number;
    skipMediaArtifactForFailingJob?: boolean;
    insertRevenueRunLedger?: boolean;
    insertAnalysisResult?: boolean;
    insertAdoptionRow?: boolean;
    skipPfe3Lineage?: boolean;
    webhookEvents?: string[];
};

// Builds the exact end-state this migration targets: an order already
// recorded in earlybird_pfe3_media_artifact_rearms (A -> B -> C, C rearmed
// onto PFE3_PREFLIGHT_ID's '.r2' generation), whose fourth successor request
// D -- created on that '.r2' preflight -- itself terminally failed with
// JOB_ATTEMPTS_EXHAUSTED at track:profile-ai:batch:7 after the upstream
// profile-fetch-consumer defect on batches 5 and 7, fully reconciled
// provider spend, a fully settled AI-attempt ledger, and a fully deleted
// media-artifact registry.
async function buildValidFixture(
    db: PGlite,
    overrides: FixtureOverrides = {}
): Promise<void> {
    await db.query(`INSERT INTO public.users(id, email) VALUES ($1, 'buyer@example.com')`, [USER_ID]);

    // A (base, gen 0) and B (gen ~1) exist only as FK/distinctness targets
    // for earlybird_pfe3_media_artifact_rearms and the shared admission
    // ledger; PFE4's own gate never inspects their job/provider-run state.
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
        [OLD_PREFLIGHT_ID, USER_ID, 'earlybird.fulfillment.' + ORDER_HEX, ORDER_TARGET_INSTAGRAM_ID, DEFAULT_SNAPSHOT]
    );
    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, preflight_id, idempotency_key, target_instagram_id,
             pipeline_version, status, current_step, error_message
         ) VALUES ($1, $2, $3, $4, $5, 'v2', 'failed', 'failed', 'JOB_ATTEMPTS_EXHAUSTED')`,
        [ORIGINAL_FAILED_REQUEST_ID, USER_ID, OLD_PREFLIGHT_ID, 'earlybird:' + ORDER_ID.toLowerCase(), retainedScrubToken(ORIGINAL_FAILED_REQUEST_ID)]
    );
    await db.query(`UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`, [OLD_PREFLIGHT_ID, ORIGINAL_FAILED_REQUEST_ID]);
    await db.query(
        `INSERT INTO public.analysis_v2_failure_receipts(request_id, failed_job_key, error_code)
         VALUES ($1, 'track:target-evidence:collect', 'JOB_ATTEMPTS_EXHAUSTED')`,
        [ORIGINAL_FAILED_REQUEST_ID]
    );
    // One provider run on A exercises the readiness-chain resolution during
    // the end-to-end create_or_replay integration test below.
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs(
             request_id, job_key, operation_key, status, run_id, actual_usage_usd, usage_reconciled_at
         ) VALUES ($1, 'track:target-evidence:collect', 'target-likers:aaaa', 'succeeded', 'run-a1', 0.3, $2)`,
        [ORIGINAL_FAILED_REQUEST_ID, '2026-08-19T12:00:00.000Z']
    );

    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, idempotency_key, target_instagram_id, status, access_mode,
             launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
             pricing_version, pricing_snapshot, policy_versions_snapshot,
             target_followers_count, target_following_count, target_is_private,
             capacity_required_plan_id, required_plan_id, pii_scrubbed_at,
             order_scoped_apify_credential_slot
         ) VALUES (
             $1, $2, 'earlybird.schema-recovery.' || $3, $4, 'consumed', 'production',
             $5::jsonb, $5::jsonb, $5::jsonb, 'v1', $5::jsonb, $5::jsonb,
             300, 100, FALSE, 'basic', 'basic', $6, 'secondary'
         )`,
        [PFE1_PREFLIGHT_ID, USER_ID, ORDER_HEX, retainedScrubToken(PFE1_PREFLIGHT_ID), DEFAULT_SNAPSHOT, '2026-08-26T00:00:00.000Z']
    );
    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, preflight_id, idempotency_key, target_instagram_id,
             pipeline_version, status, current_step, error_message
         ) VALUES ($1, $2, $3, $4, $5, 'v2', 'failed', 'failed', 'SCRAPING_PROVIDER_START_REJECTED_ERROR')`,
        [REJECTED_REQUEST_ID, USER_ID, PFE1_PREFLIGHT_ID, 'earlybird:' + ORDER_ID.toLowerCase() + '.r1', retainedScrubToken(REJECTED_REQUEST_ID)]
    );
    await db.query(`UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`, [PFE1_PREFLIGHT_ID, REJECTED_REQUEST_ID]);

    // C: the media-artifact-failed request PFE3's own migration rearmed
    // from. Only exists as a FK/distinctness target here.
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
        [PFE2_PREFLIGHT_ID, USER_ID, `earlybird.fulfillment.${ORDER_HEX}.r1`, retainedScrubToken(PFE2_PREFLIGHT_ID), DEFAULT_SNAPSHOT]
    );
    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, preflight_id, idempotency_key, target_instagram_id,
             pipeline_version, status, current_step, error_message
         ) VALUES ($1, $2, $3, $4, $5, 'v2', 'failed', 'failed', 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR')`,
        [MEDIA_FAILED_REQUEST_ID, USER_ID, PFE2_PREFLIGHT_ID, 'earlybird:' + ORDER_ID.toLowerCase() + '.r2', retainedScrubToken(MEDIA_FAILED_REQUEST_ID)]
    );
    await db.query(`UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`, [PFE2_PREFLIGHT_ID, MEDIA_FAILED_REQUEST_ID]);

    // D's own '.r2' preflight and the '.r3' failed request PFE4 rearms from.
    const preflight = {
        target_followers_count: 300,
        target_following_count: 100,
        target_is_private: false,
        capacity_required_plan_id: 'basic',
        required_plan_id: 'basic',
        pii_scrubbed_at: '2026-08-29T00:20:00.000Z',
        order_scoped_apify_credential_slot: 'secondary',
        admission_target_followers_count: 300,
        admission_target_following_count: 100,
        admission_selected_plan_id: 'standard',
        admission_capacity_required_plan_id: 'basic',
        admission_required_plan_id: 'basic',
        idempotency_key: PFE3_CONSUMED_PREFLIGHT_KEY,
        ...overrides.preflight,
    };
    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, idempotency_key, target_instagram_id, status, access_mode,
             launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
             pricing_version, pricing_snapshot, policy_versions_snapshot,
             target_followers_count, target_following_count, target_is_private,
             capacity_required_plan_id, required_plan_id, pii_scrubbed_at,
             order_scoped_apify_credential_slot,
             admission_target_followers_count, admission_target_following_count,
             admission_selected_plan_id, admission_capacity_required_plan_id,
             admission_required_plan_id, admission_plan_cards_snapshot
         ) VALUES (
             $1, $2, $3, $4, 'consumed', 'production',
             $5::jsonb, $5::jsonb, $6::jsonb, 'v1', $5::jsonb, $5::jsonb,
             $7, $8, $9, $10, $11, $12, $13,
             $14, $15, $16, $17, $18, $6::jsonb
         )`,
        [
            PFE3_PREFLIGHT_ID, USER_ID, preflight.idempotency_key, PFE3_PREFLIGHT_RETAINED_TARGET_ID,
            DEFAULT_SNAPSHOT, DEFAULT_PLAN_CARDS_SNAPSHOT,
            preflight.target_followers_count, preflight.target_following_count,
            preflight.target_is_private, preflight.capacity_required_plan_id,
            preflight.required_plan_id, preflight.pii_scrubbed_at,
            preflight.order_scoped_apify_credential_slot,
            preflight.admission_target_followers_count,
            preflight.admission_target_following_count,
            preflight.admission_selected_plan_id,
            preflight.admission_capacity_required_plan_id,
            preflight.admission_required_plan_id,
        ]
    );

    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, preflight_id, idempotency_key, target_instagram_id,
             pipeline_version, status, current_step, error_message
         ) VALUES ($1, $2, $3, $4, $5, 'v2', 'failed', 'failed', 'JOB_ATTEMPTS_EXHAUSTED')`,
        [CONSUMER_FAILED_REQUEST_ID, USER_ID, PFE3_PREFLIGHT_ID, CONSUMER_FAILED_REQUEST_KEY, CONSUMER_FAILED_REQUEST_RETAINED_TARGET_ID]
    );
    await db.query(`UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`, [PFE3_PREFLIGHT_ID, CONSUMER_FAILED_REQUEST_ID]);
    if (overrides.request) {
        for (const [column, value] of Object.entries(overrides.request)) {
            await db.query(`UPDATE public.analysis_requests SET ${column} = $2 WHERE id = $1`, [CONSUMER_FAILED_REQUEST_ID, value]);
        }
    }

    const order = {
        status: 'analysis_in_progress',
        seller_reference_confirmed_at: '2026-08-18T00:00:00.000Z',
        payment_id: 'pay_123',
        paid_at: '2026-08-18T00:00:05.000Z',
        actual_amount_krw: 0,
        actual_groble_product_id: 'standard-product-01',
        concierge_apify_credential_slot: 'secondary',
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
            ORDER_ID, USER_ID, PFE3_PREFLIGHT_ID, ORDER_TARGET_INSTAGRAM_ID,
            order.target_followers_count, order.target_following_count,
            order.status, order.payment_id, order.paid_at, order.actual_groble_product_id,
            order.actual_amount_krw, order.seller_reference_confirmed_at,
            order.concierge_apify_credential_slot, CONSUMER_FAILED_REQUEST_ID,
        ]
    );

    // Both lineage audit rows carry an order_id FK to earlybird_orders, so
    // they are inserted here -- once the order row above exists -- rather
    // than back at generation B/C's own creation.
    await db.query(
        `INSERT INTO public.earlybird_schema_failure_recoveries(
             order_id, failed_request_id, recovery_preflight_id, prior_attempt_count
         ) VALUES ($1, $2, $3, 3)`,
        [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE1_PREFLIGHT_ID]
    );

    // The audited, real earlybird_pfe3_media_artifact_rearms row (PFE4's own
    // lineage witness). rearmed_preflight_id points at PFE3_PREFLIGHT_ID, the
    // '.r2' generation D is consumed on above. This ledger is append-only
    // (immutable via the same generic guard as every sibling recovery
    // table), so a test that wants to exercise "not yet recorded" must skip
    // this insert rather than insert-then-delete the row.
    if (!overrides.skipPfe3Lineage) {
        await db.query(
            `INSERT INTO public.earlybird_pfe3_media_artifact_rearms(
                 order_id, pfe_original_failed_request_id, pfe2_rejected_successor_request_id,
                 media_failed_request_id, rearmed_preflight_id, prior_attempt_count,
                 expected_manual_review_at
             ) VALUES ($1, $2, $3, $4, $5, 1, '2026-08-29T00:00:00.000Z')`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, REJECTED_REQUEST_ID, MEDIA_FAILED_REQUEST_ID, PFE3_PREFLIGHT_ID]
        );
    }

    const webhookEvents = overrides.webhookEvents ?? ['payment.completed'];
    for (const eventType of webhookEvents) {
        await db.query(`INSERT INTO public.earlybird_webhook_events(order_id, event_type) VALUES ($1, $2)`, [ORDER_ID, eventType]);
    }

    const fulfillment = {
        status: 'manual_review',
        last_error_code: 'ANALYSIS_FAILED',
        manual_review_at: EXPECTED_MANUAL_REVIEW_AT,
        attempt_count: 1,
        ...overrides.fulfillment,
    };
    await db.query(
        `INSERT INTO public.earlybird_fulfillments(
             order_id, status, attempt_count, request_id, last_error_code, manual_review_at
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [ORDER_ID, fulfillment.status, fulfillment.attempt_count, CONSUMER_FAILED_REQUEST_ID, fulfillment.last_error_code, fulfillment.manual_review_at]
    );

    await db.query(
        `INSERT INTO public.analysis_v2_failure_receipts(request_id, failed_job_key, error_code)
         VALUES ($1, 'track:profile-ai:batch:7', 'JOB_ATTEMPTS_EXHAUSTED')`,
        [CONSUMER_FAILED_REQUEST_ID]
    );

    if (!overrides.skipProfileAiJob7) {
        const job7 = { status: 'failed', last_error_code: 'JOB_ATTEMPTS_EXHAUSTED', attempt_count: 7, ...overrides.profileAiJob7Overrides };
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code, attempt_count)
             VALUES ($1, 'track:profile-ai:batch:7', 'profile_ai', $2, $3, $4)`,
            [CONSUMER_FAILED_REQUEST_ID, job7.status, job7.last_error_code, job7.attempt_count]
        );
    }
    if (!overrides.skipProfileAiJob5) {
        const job5 = { status: 'cancelled', last_error_code: null as string | null, attempt_count: 6, ...overrides.profileAiJob5Overrides };
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code, attempt_count)
             VALUES ($1, 'track:profile-ai:batch:5', 'profile_ai', $2, $3, $4)`,
            [CONSUMER_FAILED_REQUEST_ID, job5.status, job5.last_error_code, job5.attempt_count]
        );
    }

    const telemetryRows = overrides.telemetryRows ?? defaultTelemetryRows();
    for (const row of telemetryRows) {
        await db.query(
            `INSERT INTO public.analysis_v2_profile_fetch_telemetry(
                 request_id, job_key, source, status, failure_category, http_status, outcome_count
             ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [CONSUMER_FAILED_REQUEST_ID, row.job_key, row.source, row.status, row.failure_category, row.http_status, row.outcome_count]
        );
    }

    const providerRunCount = overrides.providerRunCount ?? 13;
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs(
             request_id, job_key, operation_key, logical_provider, actor_id,
             credential_slot, status, run_id, actual_usage_usd, usage_reconciled_at
         )
         SELECT $1, 'track:profile-ai:batch:7', 'target-profile-ai:' || lpad(series::TEXT, 4, '0'),
                'apify', 'datadoping/instagram-likes-scraper', 'secondary', 'succeeded',
                'run-' || series, 0.1, $2
         FROM pg_catalog.generate_series(1, $3) AS series`,
        [CONSUMER_FAILED_REQUEST_ID, '2026-08-29T00:05:00.000Z', providerRunCount]
    );
    if (overrides.providerRunBadRow) {
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                 request_id, job_key, operation_key, logical_provider, actor_id,
                 credential_slot, status, run_id, actual_usage_usd, usage_reconciled_at
             ) VALUES ($1, 'track:profile-ai:batch:7', 'target-profile-ai:bad', 'apify',
                 'datadoping/instagram-likes-scraper', 'primary', 'succeeded', 'run-bad', 0.1, $2)`,
            [CONSUMER_FAILED_REQUEST_ID, '2026-08-29T00:05:00.000Z']
        );
    }

    const aiAttemptCount = overrides.aiAttemptCount ?? 309;
    const aiAttemptReservedCount = overrides.aiAttemptReservedCount ?? 0;
    const settledCount = aiAttemptCount - aiAttemptReservedCount;
    if (settledCount > 0) {
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(
                 request_id, job_key, operation_key, attempt, status,
                 usage_metadata_status, usage_complete, terminalized_at
             )
             SELECT $1, 'track:profile-ai:batch:1', 'settled-op-' || series, 1, 'success',
                    'complete', TRUE, $2
             FROM pg_catalog.generate_series(1, $3) AS series`,
            [CONSUMER_FAILED_REQUEST_ID, '2026-08-29T00:02:00.000Z', settledCount]
        );
    }
    if (aiAttemptReservedCount > 0) {
        await db.query(
            `INSERT INTO public.analysis_v2_ai_attempts(
                 request_id, job_key, operation_key, attempt, status
             )
             SELECT $1, 'track:profile-ai:batch:1', 'reserved-op-' || series, 1, 'reserved'
             FROM pg_catalog.generate_series(1, $2) AS series`,
            [CONSUMER_FAILED_REQUEST_ID, aiAttemptReservedCount]
        );
    }

    if (overrides.insertRevenueRunLedger) {
        await db.query(`INSERT INTO public.analysis_revenue_run_ledgers(request_id) VALUES ($1)`, [CONSUMER_FAILED_REQUEST_ID]);
    }
    if (overrides.insertAnalysisResult) {
        await db.query(`INSERT INTO public.analysis_results(request_id) VALUES ($1)`, [CONSUMER_FAILED_REQUEST_ID]);
    }
    if (overrides.insertAdoptionRow) {
        await db.query(
            `INSERT INTO public.analysis_v2_recovery_provider_run_adoptions(
                 request_id, job_key, operation_key, source_request_id, source_job_key, source_run_id
             ) VALUES ($1, 'track:profile-ai:batch:7', 'target-profile-ai:0001', $2, 'track:target-evidence:collect', 'run-a1')`,
            [CONSUMER_FAILED_REQUEST_ID, ORIGINAL_FAILED_REQUEST_ID]
        );
    }

    const mediaArtifactCount = overrides.mediaArtifactCount ?? 55;
    const undeletedCount = overrides.mediaArtifactUndeletedCount ?? 0;
    const deletedCount = mediaArtifactCount - undeletedCount;
    const includeBatch7 = !overrides.skipMediaArtifactForFailingJob;
    if (deletedCount > 0) {
        await db.query(
            `INSERT INTO public.analysis_v2_media_artifacts(
                 request_id, artifact_key, registration_job_key, artifact_kind, deleted_at
             )
             SELECT $1, lpad(series::TEXT, 64, '0'),
                    CASE WHEN series = 1 AND $2 THEN 'track:profile-ai:batch:7' ELSE 'track:profile-ai:batch:1' END,
                    'media_bundle', $3
             FROM pg_catalog.generate_series(1, $4) AS series`,
            [CONSUMER_FAILED_REQUEST_ID, includeBatch7, '2026-08-29T00:10:00.000Z', deletedCount]
        );
    }
    if (undeletedCount > 0) {
        await db.query(
            `INSERT INTO public.analysis_v2_media_artifacts(
                 request_id, artifact_key, registration_job_key, artifact_kind, deleted_at
             )
             SELECT $1, lpad((1000 + series)::TEXT, 64, '0'), 'track:profile-ai:batch:1', 'media_bundle', NULL
             FROM pg_catalog.generate_series(1, $2) AS series`,
            [CONSUMER_FAILED_REQUEST_ID, undeletedCount]
        );
    }
}

function rearm(
    db: PGlite,
    orderId = ORDER_ID,
    failedRequestId = CONSUMER_FAILED_REQUEST_ID,
    expectedManualReviewAt = EXPECTED_MANUAL_REVIEW_AT
) {
    return asRole<RearmRow>(
        db, 'service_role',
        `SELECT * FROM public.rearm_earlybird_pfe4_profile_consumer_failure($1, $2, $3)`,
        [orderId, failedRequestId, expectedManualReviewAt]
    );
}

describe('rearm_earlybird_pfe4_profile_consumer_failure', () => {
    afterAll(async () => {
        await Promise.all(databases.map(database => database.close()));
    });

    it('happy path: rebinds the order onto a fresh (.r3) preflight generation without touching any prior failed lineage', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        const result = await rearm(db);
        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];
        expect(row.order_id).toBe(ORDER_ID);
        expect(row.fulfillment_status).toBe('admission_pending');
        expect(row.failed_request_id).toBe(CONSUMER_FAILED_REQUEST_ID);
        expect(row.preflight_id).not.toBe(PFE3_PREFLIGHT_ID);

        const preflight = await db.query<{ idempotency_key: string; status: string }>(
            `SELECT idempotency_key, status FROM public.analysis_preflights WHERE id = $1`,
            [row.preflight_id]
        );
        expect(preflight.rows[0]).toEqual({ idempotency_key: REARMED_PREFLIGHT_KEY, status: 'ready' });

        const order = await db.query<{ status: string; preflight_id: string; result_request_id: string | null }>(
            `SELECT status, preflight_id, result_request_id FROM public.earlybird_orders WHERE id = $1`,
            [ORDER_ID]
        );
        expect(order.rows[0]).toEqual({ status: 'paid', preflight_id: row.preflight_id, result_request_id: null });

        const fulfillment = await db.query<{ status: string; request_id: string | null; attempt_count: number }>(
            `SELECT status, request_id, attempt_count FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER_ID]
        );
        expect(fulfillment.rows[0]).toEqual({ status: 'admission_pending', request_id: null, attempt_count: 0 });

        const ledger = await db.query<{ profile_consumer_failed_request_id: string }>(
            `SELECT profile_consumer_failed_request_id FROM public.earlybird_pfe4_profile_consumer_rearms WHERE order_id = $1`,
            [ORDER_ID]
        );
        expect(ledger.rows[0].profile_consumer_failed_request_id).toBe(CONSUMER_FAILED_REQUEST_ID);
    });

    it('idempotent replay: a second identical call returns the same rearm without duplicating audit rows', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        const first = await rearm(db);
        const second = await rearm(db);
        expect(second.rows).toEqual(first.rows);

        const count = await db.query<{ count: string }>(
            `SELECT pg_catalog.count(*)::TEXT AS count FROM public.earlybird_pfe4_profile_consumer_rearms WHERE order_id = $1`,
            [ORDER_ID]
        );
        expect(count.rows[0].count).toBe('1');
    });

    it('stale CAS on replay: rejects when the caller-supplied manual_review_at no longer matches the audited rearm', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await rearm(db);
        await expect(
            rearm(db, ORDER_ID, CONSUMER_FAILED_REQUEST_ID, '2099-01-01T00:00:00.000Z')
        ).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_CONFLICT');
    });

    it('requires the order to already be recorded in earlybird_pfe3_media_artifact_rearms', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipPfe3Lineage: true });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('rejects when fulfillment.attempt_count is not exactly 1 (a near miss of 2)', async () => {
        const db = await createDb();
        await buildValidFixture(db, { fulfillment: { attempt_count: 2 } });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it("rejects when the failed request's idempotency_key is not exactly the order's '.r3' generation", async () => {
        const db = await createDb();
        await buildValidFixture(db, { request: { idempotency_key: 'earlybird:' + ORDER_ID.toLowerCase() + '.r9' } });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it("rejects when the consumed preflight's idempotency_key is not exactly the third-stage rearm's '.r2' generation", async () => {
        const db = await createDb();
        await buildValidFixture(db, { preflight: { idempotency_key: 'earlybird.fulfillment.' + ORDER_HEX + '.r9' } });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('rejects when track:profile-ai:batch:7 evidence is missing, still active, or not exactly attempt 7', async () => {
        const missing = await createDb();
        await buildValidFixture(missing, { skipProfileAiJob7: true });
        await expect(rearm(missing)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const wrongAttempt = await createDb();
        await buildValidFixture(wrongAttempt, { profileAiJob7Overrides: { attempt_count: 6 } });
        await expect(rearm(wrongAttempt)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('rejects when the sibling track:profile-ai:batch:5 is not exactly cancelled at attempt 6', async () => {
        const completed = await createDb();
        await buildValidFixture(completed, { profileAiJob5Overrides: { status: 'completed', attempt_count: 6 } });
        await expect(rearm(completed)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const wrongAttempt = await createDb();
        await buildValidFixture(wrongAttempt, { profileAiJob5Overrides: { attempt_count: 5 } });
        await expect(rearm(wrongAttempt)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('rejects when a profile-fetch telemetry batch is missing, has the wrong success/incomplete split, or carries an extra row', async () => {
        const missingBatch5 = await createDb();
        await buildValidFixture(missingBatch5, {
            telemetryRows: defaultTelemetryRows().filter(row => row.job_key !== 'track:profiles:batch:5'),
        });
        await expect(rearm(missingBatch5)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const wrongSplit = await createDb();
        const rows = defaultTelemetryRows();
        rows[0] = { ...rows[0], outcome_count: 28 };
        await buildValidFixture(wrongSplit, { telemetryRows: rows });
        await expect(rearm(wrongSplit)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const extraRow = await createDb();
        await buildValidFixture(extraRow, {
            telemetryRows: [
                ...defaultTelemetryRows(),
                { job_key: 'track:profiles:batch:7', source: 'fresh_apify', status: 'failed', failure_category: 'incomplete', http_status: 404, outcome_count: 0 },
            ],
        });
        await expect(rearm(extraRow)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const wrongHttpStatus = await createDb();
        const httpRows = defaultTelemetryRows();
        httpRows[3] = { ...httpRows[3], http_status: 404 };
        await buildValidFixture(wrongHttpStatus, { telemetryRows: httpRows });
        await expect(rearm(wrongHttpStatus)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('requires exactly 13 succeeded, reconciled, secondary-slot provider runs', async () => {
        const tooFew = await createDb();
        await buildValidFixture(tooFew, { providerRunCount: 12 });
        await expect(rearm(tooFew)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const badSlot = await createDb();
        await buildValidFixture(badSlot, { providerRunCount: 12, providerRunBadRow: true });
        await expect(rearm(badSlot)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('requires exactly 309 settled AI attempts and rejects any reserved (non-terminal) attempt', async () => {
        const tooFew = await createDb();
        await buildValidFixture(tooFew, { aiAttemptCount: 308 });
        await expect(rearm(tooFew)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const oneReserved = await createDb();
        await buildValidFixture(oneReserved, { aiAttemptCount: 309, aiAttemptReservedCount: 1 });
        await expect(rearm(oneReserved)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('requires exactly 55 deleted media artifacts including one from the failing job, and forbids any undeleted row', async () => {
        const tooFew = await createDb();
        await buildValidFixture(tooFew, { mediaArtifactCount: 54 });
        await expect(rearm(tooFew)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const undeleted = await createDb();
        await buildValidFixture(undeleted, { mediaArtifactCount: 54, mediaArtifactUndeletedCount: 1 });
        await expect(rearm(undeleted)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const missingBatch7 = await createDb();
        await buildValidFixture(missingBatch7, { skipMediaArtifactForFailingJob: true });
        await expect(rearm(missingBatch7)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('rejects when a scored result row already exists for the failed request', async () => {
        const db = await createDb();
        await buildValidFixture(db, { insertAnalysisResult: true });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('rejects when a revenue run ledger or a recovery-provider-run adoption row already exists', async () => {
        const revenue = await createDb();
        await buildValidFixture(revenue, { insertRevenueRunLedger: true });
        await expect(rearm(revenue)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');

        const adopted = await createDb();
        await buildValidFixture(adopted, { insertAdoptionRow: true });
        await expect(rearm(adopted)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('rejects when payment evidence is incomplete', async () => {
        const db = await createDb();
        await buildValidFixture(db, { order: { paid_at: null } });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE4_CONSUMER_REARM_INELIGIBLE');
    });

    it('restrictive ACL: only service_role may execute, and no other role can read, write, or mutate the audit table', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        await expect(asRole(
            db, 'authenticated',
            `SELECT * FROM public.rearm_earlybird_pfe4_profile_consumer_failure($1, $2, $3)`,
            [ORDER_ID, CONSUMER_FAILED_REQUEST_ID, EXPECTED_MANUAL_REVIEW_AT]
        )).rejects.toThrow();

        await expect(asRole(
            db, 'authenticated', `SELECT * FROM public.earlybird_pfe4_profile_consumer_rearms`
        )).rejects.toThrow();

        await rearm(db);
        await expect(asRole(
            db, 'service_role',
            `DELETE FROM public.earlybird_pfe4_profile_consumer_rearms WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE|permission denied/i);
        await expect(db.query(
            `DELETE FROM public.earlybird_pfe4_profile_consumer_rearms WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow('EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE');
    });

    it('names every PK/UNIQUE/FK/CHECK constraint explicitly, each within the 63-byte Postgres identifier limit', async () => {
        const db = await createDb();
        const constraints = await db.query<{ conname: string }>(
            `SELECT pg_constraint.conname
             FROM pg_catalog.pg_constraint
             JOIN pg_catalog.pg_class ON pg_class.oid = pg_constraint.conrelid
             WHERE pg_class.relname = 'earlybird_pfe4_profile_consumer_rearms'`
        );
        expect(constraints.rows.length).toBeGreaterThanOrEqual(11);
        for (const row of constraints.rows) {
            expect(Buffer.byteLength(row.conname, 'utf8')).toBeLessThanOrEqual(63);
        }
    });
});

describe('earlybird_provider_run_adoption_ready / resolve_analysis_v2_recovery_provider_run (PFE4 wrapper non-broadening)', () => {
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

    it('readiness helper is ready only for the exact order/original-request/rearmed-preflight triple', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        const rearmed = await rearm(db);
        const preflightId = rearmed.rows[0].preflight_id;

        await expect(db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3) AS ready`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, preflightId]
        )).resolves.toMatchObject({ rows: [{ ready: true }] });

        await expect(db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3) AS ready`,
            [ORDER_ID, CONSUMER_FAILED_REQUEST_ID, preflightId]
        )).resolves.toMatchObject({ rows: [{ ready: false }] });
    });

    it('resolver returns NULL only for the exact minted .r4 successor, forcing a brand-new provider call', async () => {
        const db = await createDb();
        const successorId = await admitSuccessor(db);

        const result = await asRole<{ resolve_analysis_v2_recovery_provider_run: unknown }>(
            db, 'service_role',
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                 $1, 'track:profile-ai:batch:1', $2, 'profile-ai:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'datadoping/instagram-likes-scraper', 'secondary', 0.5
             )`,
            [successorId, '60000000-0000-4000-8000-000000000001']
        );
        expect(result.rows[0].resolve_analysis_v2_recovery_provider_run).toBeNull();

        const request = await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_requests WHERE id = $1`,
            [successorId]
        );
        expect(request.rows[0].idempotency_key).toBe(`earlybird:${ORDER_ID.toLowerCase()}.r4`);
    });

    it("delegates byte-for-byte for a request that is not this lineage's exact .r4 successor, even on the same rearmed preflight", async () => {
        const db = await createDb();
        await buildValidFixture(db);
        const rearmed = await rearm(db);

        // A same-preflight request with a *different* generation key must
        // never receive the zero-adoption bypass -- only the exact minted
        // '.r4' successor may.
        await db.query(
            `INSERT INTO public.analysis_requests(
                 id, user_id, preflight_id, idempotency_key, target_instagram_id,
                 pipeline_version, status, current_step
             ) VALUES ($1, $2, $3, $4, 'other_target', 'v2', 'pending', 'pending')`,
            ['40000000-0000-4000-8000-000000000099', USER_ID, rearmed.rows[0].preflight_id, `earlybird:${ORDER_ID.toLowerCase()}.r5`]
        );

        const result = await asRole<{ resolve_analysis_v2_recovery_provider_run: { source: string } }>(
            db, 'service_role',
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                 $1, 'track:profile-ai:batch:1', $2, 'profile-ai:eeee',
                 pg_catalog.repeat('a', 64), 'apify', 'datadoping/instagram-likes-scraper', 'secondary', 0.5
             )`,
            ['40000000-0000-4000-8000-000000000099', '60000000-0000-4000-8000-000000000002']
        );
        expect(result.rows[0].resolve_analysis_v2_recovery_provider_run).toEqual({
            source: 'pre_pfe_stub', request_id: '40000000-0000-4000-8000-000000000099', job_key: 'track:profile-ai:batch:1',
        });
    });

    it('restrictive ACL: only service_role may execute the wrapper, and the renamed pre-PFE4 functions are not directly callable', async () => {
        const db = await createDb();
        await expect(asRole(
            db, 'authenticated',
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                 $1, 'track:profile-ai:batch:1', $2, 'profile-ai:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'datadoping/instagram-likes-scraper', 'secondary', 0.5
             )`,
            [OTHER_REQUEST_ID, '60000000-0000-4000-8000-000000000003']
        )).rejects.toThrow();

        await expect(asRole(
            db, 'service_role',
            `SELECT public.resolve_analysis_v2_recovery_provider_run_pre_pfe4(
                 $1, 'track:profile-ai:batch:1', $2, 'profile-ai:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'datadoping/instagram-likes-scraper', 'secondary', 0.5
             )`,
            [OTHER_REQUEST_ID, '60000000-0000-4000-8000-000000000004']
        )).rejects.toThrow();

        await expect(asRole(
            db, 'authenticated',
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3)`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE3_PREFLIGHT_ID]
        )).rejects.toThrow(/permission denied/i);
    });
});

describe('create_or_replay_earlybird_fulfillment_request (post-PFE4-rearm successor admission)', () => {
    it('admits exactly one distinct .r4 successor request once the rearm makes the lineage provider-run-adoption ready', async () => {
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
        expect([ORIGINAL_FAILED_REQUEST_ID, REJECTED_REQUEST_ID, MEDIA_FAILED_REQUEST_ID, CONSUMER_FAILED_REQUEST_ID])
            .not.toContain(created.rows[0].request_id);

        const request = await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_requests WHERE id = $1`,
            [created.rows[0].request_id]
        );
        expect(request.rows[0].idempotency_key).toBe(`earlybird:${ORDER_ID.toLowerCase()}.r4`);

        const duplicates = await db.query<{ count: string }>(
            `SELECT pg_catalog.count(*)::TEXT AS count
             FROM (
                 SELECT idempotency_key FROM public.analysis_requests
                 WHERE user_id = $1 GROUP BY idempotency_key HAVING pg_catalog.count(*) > 1
             ) AS duplicate_key`,
            [USER_ID]
        );
        expect(duplicates.rows[0].count).toBe('0');
    });
});
