import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

const pfeMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260828071549_recover_earlybird_profile_fetch_exhaustion_fulfillment.sql',
        import.meta.url
    ),
    'utf8'
);
const rearmMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260828140000_rearm_earlybird_pfe_target_evidence_start_rejection.sql',
        import.meta.url
    ),
    'utf8'
);

function retainedScrubToken(id: string): string {
    return `retained.${id.replace(/-/g, '').slice(0, 20)}`;
}

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OLD_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000001';
const PFE_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000002';
const OTHER_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000003';
const ORDER_ID = '30000000-0000-4000-8000-000000000001';
const ORIGINAL_FAILED_REQUEST_ID = '40000000-0000-4000-8000-000000000001';
const REJECTED_REQUEST_ID = '40000000-0000-4000-8000-000000000002';
const OTHER_REQUEST_ID = '40000000-0000-4000-8000-000000000003';
const EXPECTED_MANUAL_REVIEW_AT = '2026-08-27T00:00:00.000Z';
const ORDER_TARGET_INSTAGRAM_ID = 'sample_target_02';
const ORDER_HEX = ORDER_ID.replace(/-/g, '');
const REARMED_PREFLIGHT_KEY = `earlybird.fulfillment.${ORDER_HEX}.r1`;

const ORIGINAL_FAILED_RETAINED_TARGET_ID = retainedScrubToken(ORIGINAL_FAILED_REQUEST_ID);
const PFE_PREFLIGHT_RETAINED_TARGET_ID = retainedScrubToken(PFE_PREFLIGHT_ID);
const REJECTED_REQUEST_RETAINED_TARGET_ID = retainedScrubToken(REJECTED_REQUEST_ID);

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
    PRIMARY KEY (request_id, job_key)
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
-- 20260730170000_recover_schema_failed_earlybird_fulfillment.sql. Both the
-- PFE recovery migration and the real creator RPC depend on it existing.
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

-- The pre-existing production stub the PFE migration renames and re-fronts.
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

-- The pre-existing production RPC the PFE migration renames and re-fronts.
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
    v_request_base_key TEXT;
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

        v_request_idempotency_key := v_request_base_key || '.r1';
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
    await db.exec(pfeMigration);
    await db.exec(rearmMigration);
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

type FixtureOverrides = {
    order?: Record<string, unknown>;
    fulfillment?: Record<string, unknown>;
    request?: Record<string, unknown>;
    preflight?: Record<string, unknown>;
    skipPfeLineage?: boolean;
    pfeLineageOverrides?: Record<string, unknown>;
    skipTargetEvidenceJob?: boolean;
    targetEvidenceJobOverrides?: Record<string, unknown>;
    skipRejectedRun?: boolean;
    rejectedRunOverrides?: Record<string, unknown>;
    extraProviderRun?: Record<string, unknown>;
    skipAdoptionRow?: boolean;
    skipFailureReceipt?: boolean;
    failureReceiptOverrides?: Record<string, unknown>;
    webhookEvents?: string[];
};

// Builds the exact end-state this migration targets: an order already
// recorded in earlybird_profile_fetch_exhaustion_recoveries (the original
// job-exhausted request A, consumed by rebind preflight P1), whose successor
// request B -- created on P1 -- itself terminally failed at
// track:target-evidence:collect with SCRAPING_PROVIDER_START_REJECTED_ERROR.
async function buildValidFixture(
    db: PGlite,
    overrides: FixtureOverrides = {}
): Promise<void> {
    await db.query(`INSERT INTO public.users(id, email) VALUES ($1, 'buyer@example.com')`, [USER_ID]);

    const snapshot = JSON.stringify({ basic: { launchStatus: 'production' } });

    // The very first, pre-incident preflight A consumed. Only needed so A
    // has somewhere to live before the profile-fetch-exhaustion lineage
    // rebinds the order onto P1.
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
            'earlybird:' + ORDER_ID.toLowerCase(), ORIGINAL_FAILED_RETAINED_TARGET_ID,
        ]
    );
    await db.query(
        `UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`,
        [OLD_PREFLIGHT_ID, ORIGINAL_FAILED_REQUEST_ID]
    );
    // The real creator RPC's own conflicting-request block requires a
    // failure receipt matching A's error_message before it will recognize
    // A as a bridged recovery lineage at all.
    await db.query(
        `INSERT INTO public.analysis_v2_failure_receipts(request_id, failed_job_key, error_code)
         VALUES ($1, 'track:target-evidence:collect', 'JOB_ATTEMPTS_EXHAUSTED')`,
        [ORIGINAL_FAILED_REQUEST_ID]
    );
    // A's own succeeded, reconciled provider run -- the dataset the shared
    // schema-failure-recoveries adoption-readiness gate cares about.
    await db.query(
        `INSERT INTO public.analysis_v2_provider_runs(
             request_id, job_key, operation_key, status, run_id,
             actual_usage_usd, usage_reconciled_at
         ) VALUES ($1, 'track:target-evidence:collect', 'target-likers:aaaa', 'succeeded', 'run-a1', 0.3, $2)`,
        [ORIGINAL_FAILED_REQUEST_ID, '2026-08-19T12:00:00.000Z']
    );

    // The rebind preflight the profile-fetch-exhaustion recovery minted (P1),
    // now consumed by the rejected successor request B.
    const preflight = {
        status: 'consumed',
        access_mode: 'production',
        pii_scrubbed_at: '2026-08-26T00:00:00.000Z',
        target_instagram_id: PFE_PREFLIGHT_RETAINED_TARGET_ID,
        target_followers_count: 300,
        target_following_count: 100,
        target_is_private: false,
        capacity_required_plan_id: 'basic',
        required_plan_id: 'basic',
        consumed_request_id: REJECTED_REQUEST_ID,
        order_scoped_apify_credential_slot: 'secondary',
        ...overrides.preflight,
    };
    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, idempotency_key, target_instagram_id, status, access_mode,
             launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
             pricing_version, pricing_snapshot, policy_versions_snapshot,
             target_followers_count, target_following_count, target_is_private,
             capacity_required_plan_id, required_plan_id,
             pii_scrubbed_at, order_scoped_apify_credential_slot
         ) VALUES (
             $1, $2, 'earlybird.schema-recovery.' || $3, $4, $5, $6,
             $7::jsonb, $7::jsonb, $7::jsonb, 'v1', $7::jsonb, $7::jsonb,
             $8, $9, $10, $11, $12, $13, $14
         )`,
        [
            PFE_PREFLIGHT_ID, USER_ID, ORDER_HEX, preflight.target_instagram_id,
            preflight.status, preflight.access_mode, snapshot,
            preflight.target_followers_count, preflight.target_following_count,
            preflight.target_is_private, preflight.capacity_required_plan_id,
            preflight.required_plan_id,
            preflight.pii_scrubbed_at, preflight.order_scoped_apify_credential_slot,
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
            REJECTED_REQUEST_ID, USER_ID, PFE_PREFLIGHT_ID,
            'earlybird:' + ORDER_ID.toLowerCase() + '.r1',
            REJECTED_REQUEST_RETAINED_TARGET_ID,
        ]
    );
    await db.query(
        `UPDATE public.analysis_preflights SET consumed_request_id = $2 WHERE id = $1`,
        [PFE_PREFLIGHT_ID, preflight.consumed_request_id]
    );
    if (overrides.request) {
        for (const [column, value] of Object.entries(overrides.request)) {
            await db.query(
                `UPDATE public.analysis_requests SET ${column} = $2 WHERE id = $1`,
                [REJECTED_REQUEST_ID, value]
            );
        }
    }

    const order = {
        status: 'analysis_in_progress',
        seller_reference_confirmed_at: '2026-08-18T00:00:00.000Z',
        payment_id: 'pay_123',
        paid_at: '2026-08-18T00:00:05.000Z',
        actual_amount_krw: 19900,
        actual_groble_product_id: 'standard-product-01',
        concierge_apify_credential_slot: 'secondary',
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
            ORDER_ID, USER_ID, PFE_PREFLIGHT_ID, ORDER_TARGET_INSTAGRAM_ID, 300, 100,
            order.status, order.payment_id, order.paid_at, order.actual_groble_product_id,
            order.actual_amount_krw, order.seller_reference_confirmed_at,
            order.concierge_apify_credential_slot, REJECTED_REQUEST_ID,
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
        attempt_count: 1,
        ...overrides.fulfillment,
    };
    await db.query(
        `INSERT INTO public.earlybird_fulfillments(
             order_id, status, attempt_count, request_id, last_error_code,
             manual_review_at
         ) VALUES ($1, $2, $3, $4, $5, $6)`,
        [
            ORDER_ID, fulfillment.status, fulfillment.attempt_count,
            REJECTED_REQUEST_ID, fulfillment.last_error_code,
            fulfillment.manual_review_at,
        ]
    );

    if (!overrides.skipPfeLineage) {
        const lineage = {
            failed_request_id: ORIGINAL_FAILED_REQUEST_ID,
            recovery_preflight_id: PFE_PREFLIGHT_ID,
            prior_attempt_count: 3,
            expected_manual_review_at: '2026-08-20T00:00:00.000Z',
            ...overrides.pfeLineageOverrides,
        };
        await db.query(
            `INSERT INTO public.earlybird_profile_fetch_exhaustion_recoveries(
                 order_id, failed_request_id, recovery_preflight_id,
                 prior_attempt_count, expected_manual_review_at
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
                ORDER_ID, lineage.failed_request_id, lineage.recovery_preflight_id,
                lineage.prior_attempt_count, lineage.expected_manual_review_at,
            ]
        );
        // The shared bridge ledger the profile-fetch-exhaustion recovery
        // also inserted into, so the real creator's own conflict-resolution
        // block can recognize A as this order's recovered lineage.
        await db.query(
            `INSERT INTO public.earlybird_schema_failure_recoveries(
                 order_id, failed_request_id, recovery_preflight_id, prior_attempt_count
             ) VALUES ($1, $2, $3, $4)`,
            [ORDER_ID, lineage.failed_request_id, lineage.recovery_preflight_id, lineage.prior_attempt_count]
        );
    }

    if (!overrides.skipTargetEvidenceJob) {
        const job = {
            status: 'failed',
            track: 'target_evidence',
            last_error_code: 'SCRAPING_PROVIDER_START_REJECTED_ERROR',
            ...overrides.targetEvidenceJobOverrides,
        };
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code)
             VALUES ($1, 'track:target-evidence:collect', $2, $3, $4)`,
            [REJECTED_REQUEST_ID, job.track, job.status, job.last_error_code]
        );
    }

    // One succeeded, reconciled fresh provider run (e.g. likers) B made
    // before hitting the comments-actor rejection.
    if (!overrides.extraProviderRun) {
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
    } else {
        const extra = overrides.extraProviderRun;
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                 request_id, job_key, operation_key, logical_provider, actor_id,
                 credential_slot, status, run_id, actual_usage_usd, usage_reconciled_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                REJECTED_REQUEST_ID, extra.job_key ?? 'track:target-evidence:collect',
                extra.operation_key ?? 'target-likers:bbbb', extra.logical_provider ?? 'apify',
                extra.actor_id ?? 'datadoping/instagram-likes-scraper',
                extra.credential_slot ?? 'secondary', extra.status ?? 'succeeded',
                extra.run_id ?? 'run-b1', extra.actual_usage_usd ?? 0.4,
                extra.usage_reconciled_at ?? '2026-08-27T00:05:00.000Z',
            ]
        );
    }

    if (!overrides.skipRejectedRun) {
        const rejected = {
            status: 'rejected',
            run_id: null,
            actual_usage_usd: 0,
            usage_reconciled_at: '2026-08-27T00:06:00.000Z',
            actor_id: 'apify/instagram-comment-scraper',
            credential_slot: 'secondary',
            ...overrides.rejectedRunOverrides,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                 request_id, job_key, operation_key, logical_provider, actor_id,
                 credential_slot, status, run_id, actual_usage_usd, usage_reconciled_at
             ) VALUES (
                 $1, 'track:target-evidence:collect', 'target-comments:cccc', 'apify',
                 $2, $3, $4, $5, $6, $7
             )`,
            [
                REJECTED_REQUEST_ID, rejected.actor_id, rejected.credential_slot,
                rejected.status, rejected.run_id, rejected.actual_usage_usd,
                rejected.usage_reconciled_at,
            ]
        );
    }

    if (!overrides.skipAdoptionRow) {
        // Deliberately absent by default: proves zero adoption occurred for
        // the rejected successor. Tests that need one insert it explicitly.
    }

    if (!overrides.skipFailureReceipt) {
        const receipt = {
            failed_job_key: 'track:target-evidence:collect',
            error_code: 'SCRAPING_PROVIDER_START_REJECTED_ERROR',
            ...overrides.failureReceiptOverrides,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, failed_job_key, error_code)
             VALUES ($1, $2, $3)`,
            [REJECTED_REQUEST_ID, receipt.failed_job_key, receipt.error_code]
        );
    }
}

function rearm(
    db: PGlite,
    orderId = ORDER_ID,
    rejectedRequestId = REJECTED_REQUEST_ID,
    expectedManualReviewAt = EXPECTED_MANUAL_REVIEW_AT
) {
    return asRole<RearmRow>(
        db,
        'service_role',
        `SELECT * FROM public.rearm_earlybird_pfe_target_evidence_start_rejection($1, $2, $3)`,
        [orderId, rejectedRequestId, expectedManualReviewAt]
    );
}

describe('rearm_earlybird_pfe_target_evidence_start_rejection', () => {
    afterAll(async () => {
        await Promise.all(databases.map(database => database.close()));
    });

    it('happy path: rebinds the order onto a fresh preflight generation without touching either failed lineage', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        const result = await rearm(db);

        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];
        expect(row.order_id).toBe(ORDER_ID);
        expect(row.fulfillment_status).toBe('admission_pending');
        expect(row.failed_request_id).toBe(REJECTED_REQUEST_ID);
        expect(row.preflight_id).not.toBe(PFE_PREFLIGHT_ID);
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

        // Both failed lineages are untouched.
        const originalRequest = await db.query<{ status: string; error_message: string }>(
            `SELECT status, error_message FROM public.analysis_requests WHERE id = $1`,
            [ORIGINAL_FAILED_REQUEST_ID]
        );
        expect(originalRequest.rows[0]).toEqual({ status: 'failed', error_message: 'JOB_ATTEMPTS_EXHAUSTED' });
        const rejectedRequest = await db.query<{ status: string; error_message: string }>(
            `SELECT status, error_message FROM public.analysis_requests WHERE id = $1`,
            [REJECTED_REQUEST_ID]
        );
        expect(rejectedRequest.rows[0]).toEqual({
            status: 'failed', error_message: 'SCRAPING_PROVIDER_START_REJECTED_ERROR',
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
             FROM public.earlybird_pfe_target_evidence_start_rejection_rearms
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
            rearm(db, ORDER_ID, REJECTED_REQUEST_ID, '2099-01-01T00:00:00.000Z')
        ).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_CONFLICT');
    });

    it('stale CAS on first admission: rejects before minting anything when the caller-supplied manual_review_at does not match the live fulfillment row', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await expect(
            rearm(db, ORDER_ID, REJECTED_REQUEST_ID, '2099-01-01T00:00:00.000Z')
        ).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');

        const count = await db.query<{ count: string }>(
            `SELECT pg_catalog.count(*)::TEXT AS count
             FROM public.earlybird_pfe_target_evidence_start_rejection_rearms
             WHERE order_id = $1`,
            [ORDER_ID]
        );
        expect(count.rows[0].count).toBe('0');
    });

    it('requires the order to already be recorded in earlybird_profile_fetch_exhaustion_recoveries', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipPfeLineage: true });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
    });

    it('rejects when the failure receipt does not match the exact job key and error code', async () => {
        const db = await createDb();
        await buildValidFixture(db, {
            failureReceiptOverrides: { error_code: 'SCRAPING_PROVIDER_QUOTA_ERROR' },
        });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
    });

    it('requires the exact rejected comments-actor row on secondary with zero reconciled usage', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipRejectedRun: true });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');

        const wrongSlot = await createDb();
        await buildValidFixture(wrongSlot, { rejectedRunOverrides: { credential_slot: 'primary' } });
        await expect(rearm(wrongSlot)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');

        const nonZeroUsage = await createDb();
        await buildValidFixture(nonZeroUsage, { rejectedRunOverrides: { actual_usage_usd: 0.01 } });
        await expect(rearm(nonZeroUsage)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
    });

    it('requires every provider run to be terminal and usage-reconciled', async () => {
        const db = await createDb();
        await buildValidFixture(db, {
            extraProviderRun: { status: 'running', run_id: 'run-b1', actual_usage_usd: null, usage_reconciled_at: null },
        });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
    });

    it('rejects when a recovery-provider-run adoption row already exists for the rejected successor', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await db.query(
            `INSERT INTO public.analysis_v2_recovery_provider_run_adoptions(
                 request_id, job_key, operation_key, source_request_id, source_job_key, source_run_id
             ) VALUES ($1, 'track:target-evidence:collect', 'target-likers:bbbb', $2, 'track:target-evidence:collect', 'run-a1')`,
            [REJECTED_REQUEST_ID, ORIGINAL_FAILED_REQUEST_ID]
        );
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
    });

    it('rejects when the order credential slot is not exactly secondary', async () => {
        const db = await createDb();
        await buildValidFixture(db, { order: { concierge_apify_credential_slot: 'primary' } });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
    });

    it('rejects when payment evidence is incomplete or a cancel/refund event exists', async () => {
        const missingPaidAt = await createDb();
        await buildValidFixture(missingPaidAt, { order: { paid_at: null } });
        await expect(rearm(missingPaidAt)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');

        const extraEvent = await createDb();
        await buildValidFixture(extraEvent, { webhookEvents: ['payment.completed', 'payment.cancelled'] });
        await expect(rearm(extraEvent)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
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
        await expect(rearm(activeRequest)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
    });

    it('rejects when the pipeline job evidence for track:target-evidence:collect is missing or wrong', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipTargetEvidenceJob: true });
        await expect(rearm(db)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');

        const stillActive = await createDb();
        await buildValidFixture(stillActive, { targetEvidenceJobOverrides: { status: 'retryable' } });
        await expect(rearm(stillActive)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');

        // The pipeline track column uses an underscore ('target_evidence')
        // even though the job_key segment stays hyphenated
        // ('track:target-evidence:collect'); a hyphenated track value must
        // not satisfy the gate.
        const wrongTrackSpelling = await createDb();
        await buildValidFixture(wrongTrackSpelling, { targetEvidenceJobOverrides: { track: 'target-evidence' } });
        await expect(rearm(wrongTrackSpelling)).rejects.toThrow('EARLYBIRD_PFE_TARGET_EVIDENCE_REARM_INELIGIBLE');
    });

    it('restrictive ACL: only service_role may execute, and no other role can read or write the audit table', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        await expect(asRole(
            db, 'authenticated',
            `SELECT * FROM public.rearm_earlybird_pfe_target_evidence_start_rejection($1, $2, $3)`,
            [ORDER_ID, REJECTED_REQUEST_ID, EXPECTED_MANUAL_REVIEW_AT]
        )).rejects.toThrow();

        await expect(asRole(
            db, 'authenticated',
            `SELECT * FROM public.earlybird_pfe_target_evidence_start_rejection_rearms`
        )).rejects.toThrow();

        await rearm(db);
        await expect(asRole(
            db, 'authenticated',
            `DELETE FROM public.earlybird_pfe_target_evidence_start_rejection_rearms WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow();
        // The audit ledger is append-only even to service_role: REVOKE ALL
        // means service_role has no direct table privileges at all, so this
        // is blocked before the immutability trigger ever gets a chance to
        // fire -- exactly like the profile-fetch-exhaustion recovery's own
        // sibling ledger.
        await expect(asRole(
            db, 'service_role',
            `DELETE FROM public.earlybird_pfe_target_evidence_start_rejection_rearms WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE|permission denied/i);
        // The immutability guard itself still holds when reached directly
        // (as the connection's owning role, matching how it is actually
        // reached in production -- only ever from inside another SECURITY
        // DEFINER function's own privileged body).
        await expect(db.query(
            `DELETE FROM public.earlybird_pfe_target_evidence_start_rejection_rearms WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow('EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE');
    });
});

describe('resolve_analysis_v2_recovery_provider_run (post-rearm successor resolver wrapper)', () => {
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
                 $1, 'track:target-evidence:collect', $2, 'target-comments:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'apify/instagram-comment-scraper',
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
                 $1, 'track:target-evidence:collect', $2, 'target-comments:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'apify/instagram-comment-scraper',
                 'secondary', 0.5
             )`,
            [OTHER_REQUEST_ID, '60000000-0000-4000-8000-000000000002']
        );
        expect(result.rows[0].resolve_analysis_v2_recovery_provider_run).toEqual({
            source: 'pre_pfe_stub', request_id: OTHER_REQUEST_ID, job_key: 'track:target-evidence:collect',
        });
    });

    it('restrictive ACL: only service_role may execute the wrapper, and the renamed resolvers are not directly callable', async () => {
        const db = await createDb();
        await expect(asRole(
            db, 'authenticated',
            `SELECT public.resolve_analysis_v2_recovery_provider_run(
                 $1, 'track:target-evidence:collect', $2, 'target-comments:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'apify/instagram-comment-scraper',
                 'secondary', 0.5
             )`,
            [OTHER_REQUEST_ID, '60000000-0000-4000-8000-000000000003']
        )).rejects.toThrow();

        await expect(asRole(
            db, 'service_role',
            `SELECT public.resolve_analysis_v2_recovery_provider_run_pre_pfe2(
                 $1, 'track:target-evidence:collect', $2, 'target-comments:dddd',
                 pg_catalog.repeat('a', 64), 'apify', 'apify/instagram-comment-scraper',
                 'secondary', 0.5
             )`,
            [OTHER_REQUEST_ID, '60000000-0000-4000-8000-000000000004']
        )).rejects.toThrow();
    });
});

describe('earlybird_provider_run_adoption_ready (PFE target-evidence rejection lineage readiness helper)', () => {
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

    it('is not ready for the intervening rejected successor request, only the original job-exhausted one', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        const rearmed = await rearm(db);
        const row = rearmed.rows[0];

        await expect(readinessReady(db, REJECTED_REQUEST_ID, row.preflight_id))
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
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE_PREFLIGHT_ID]
        )).rejects.toThrow(/permission denied/i);
        await expect(asRole(
            db, 'service_role',
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3)`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE_PREFLIGHT_ID]
        )).rejects.toThrow(/permission denied/i);
        await expect(asRole(
            db, 'service_role',
            `SELECT public.earlybird_provider_run_adoption_ready_pre_pfe2($1, $2, $3)`,
            [ORDER_ID, ORIGINAL_FAILED_REQUEST_ID, PFE_PREFLIGHT_ID]
        )).rejects.toThrow(/permission denied/i);
    });
});

describe('create_or_replay_earlybird_fulfillment_request (post-rearm successor admission)', () => {
    it('admits exactly one distinct successor request once the rearm makes the lineage provider-run-adoption ready', async () => {
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

        const preflight = await db.query<{ idempotency_key: string }>(
            `SELECT idempotency_key FROM public.analysis_preflights
             WHERE consumed_request_id = $1`,
            [created.rows[0].request_id]
        );
        expect(preflight.rows[0].idempotency_key).toBe(REARMED_PREFLIGHT_KEY);
    });
});
