import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, describe, expect, it } from 'vitest';

const recoveryMigration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260828071549_recover_earlybird_profile_fetch_exhaustion_fulfillment.sql',
        import.meta.url
    ),
    'utf8'
);

function retainedScrubToken(id: string): string {
    return `retained.${id.replace(/-/g, '').slice(0, 20)}`;
}

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OLD_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000001';
const OTHER_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000002';
const ORDER_ID = '30000000-0000-4000-8000-000000000001';
const FAILED_REQUEST_ID = '40000000-0000-4000-8000-000000000001';
const OTHER_REQUEST_ID = '40000000-0000-4000-8000-000000000002';
const SUCCESSOR_REQUEST_ID = '40000000-0000-4000-8000-000000000003';
const CLAIM_TOKEN = '50000000-0000-4000-8000-000000000001';
const CREDENTIAL_SLOT = 'secondary';
const WRONG_CREDENTIAL_SLOT = 'primary';
const EXPECTED_MANUAL_REVIEW_AT = '2026-08-20T00:00:00.000Z';
// The order's own target handle -- never a scrub token, never checked against
// either recovered row's retained token.
const ORDER_TARGET_INSTAGRAM_ID = 'sample_target_01';

const FAILED_REQUEST_RETAINED_TARGET_ID = retainedScrubToken(FAILED_REQUEST_ID);
const OLD_PREFLIGHT_RETAINED_TARGET_ID = retainedScrubToken(OLD_PREFLIGHT_ID);

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
    status TEXT NOT NULL,
    run_id TEXT,
    actual_usage_usd NUMERIC,
    usage_reconciled_at TIMESTAMP WITH TIME ZONE,
    PRIMARY KEY (request_id, job_key, operation_key)
);

-- Mirrors the real schema (20260713185711_add_analysis_v2_result_finalization.sql):
-- request_id is the table's own primary key, so at most one receipt can ever
-- exist per request -- this is what lets the target migration's NOT EXISTS
-- check double as the "exactly one, and it's this exact failure" gate.
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
-- 20260730170000_recover_schema_failed_earlybird_fulfillment.sql. The target
-- migration inserts into it (never updates/deletes) and installs its own
-- table's immutability trigger against the same guard function, so both must
-- exist before the target migration runs.
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

-- The pre-existing production stub from 20260731050000_bound_recovered_
-- earlybird_request_generation.sql: always-false until a later incident
-- teaches it a narrow, exact readiness rule. The target migration renames
-- this one and re-fronts it too, exactly like the resolver stub below.
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

-- A faithful-minimal stand-in for the real create_or_replay_earlybird_
-- fulfillment_request RPC (20260731050000_bound_recovered_earlybird_
-- request_generation.sql): just enough of its request-generation guard --
-- idempotency-key conflict detection against the preserved, terminally
-- failed request, the shared schema-failure-recovery lineage lookup, and
-- the provider-run adoption gate -- to prove the target migration's fix
-- threads a profile-fetch-exhaustion lineage through it correctly.
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
        IF v_recovery.order_id IS NULL
           OR v_preflight.id IS DISTINCT FROM v_recovery.recovery_preflight_id THEN
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

-- The pre-existing production RPC the target migration renames and re-fronts
-- (see 20260815170000_rearm_first15_canary_provider_failures.sql). The stub
-- return value is a distinguishable marker so tests can prove the target
-- migration's wrapper delegates to it byte-for-byte for every caller that
-- isn't this exact recovery lineage's successor request.
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
`;

type RecoveryRow = {
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
    await db.exec(recoveryMigration);
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
    skipCancelledProfileJob?: boolean;
    extraPipelineJob?: {
        job_key: string;
        track: string;
        status: string;
        last_error_code?: string | null;
    };
    skipProviderRun?: boolean;
    providerRunOverrides?: Record<string, unknown>;
    skipFailureReceipt?: boolean;
    failureReceiptOverrides?: Record<string, unknown>;
    webhookEvents?: string[];
};

async function buildValidFixture(
    db: PGlite,
    overrides: FixtureOverrides = {}
): Promise<void> {
    await db.query(`INSERT INTO public.users(id, email) VALUES ($1, 'buyer@example.com')`, [USER_ID]);

    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, target_instagram_id, pipeline_version, status, current_step, error_message
         ) VALUES ($1, $2, $3, 'v2', 'pending', 'pending', NULL)`,
        [FAILED_REQUEST_ID, USER_ID, FAILED_REQUEST_RETAINED_TARGET_ID]
    );

    const snapshot = JSON.stringify({ basic: { launchStatus: 'production' } });
    const preflight = {
        id: OLD_PREFLIGHT_ID,
        status: 'consumed',
        access_mode: 'production',
        pii_scrubbed_at: '2026-08-19T00:00:00.000Z',
        target_instagram_id: OLD_PREFLIGHT_RETAINED_TARGET_ID,
        target_followers_count: 300,
        target_following_count: 100,
        target_is_private: false,
        capacity_required_plan_id: 'basic',
        required_plan_id: 'basic',
        consumed_request_id: FAILED_REQUEST_ID,
        order_scoped_apify_credential_slot: CREDENTIAL_SLOT,
        ...overrides.preflight,
    };
    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, idempotency_key, target_instagram_id, status, access_mode,
             launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
             pricing_version, pricing_snapshot, policy_versions_snapshot,
             target_followers_count, target_following_count, target_is_private,
             capacity_required_plan_id, required_plan_id, consumed_request_id,
             pii_scrubbed_at, order_scoped_apify_credential_slot
         ) VALUES (
             $1, $2, 'old-preflight-key', $3, $4, $5,
             $6::jsonb, $6::jsonb, $6::jsonb, 'v1', $6::jsonb, $6::jsonb,
             $7, $8, $9, $10, $11, $12, $13, $14
         )`,
        [
            preflight.id, USER_ID, preflight.target_instagram_id,
            preflight.status, preflight.access_mode, snapshot,
            preflight.target_followers_count, preflight.target_following_count,
            preflight.target_is_private, preflight.capacity_required_plan_id,
            preflight.required_plan_id, preflight.consumed_request_id,
            preflight.pii_scrubbed_at, preflight.order_scoped_apify_credential_slot,
        ]
    );

    await db.query(
        `UPDATE public.analysis_requests
         SET preflight_id = $2, status = 'failed', current_step = 'failed',
             error_message = 'JOB_ATTEMPTS_EXHAUSTED'
         WHERE id = $1`,
        [FAILED_REQUEST_ID, OLD_PREFLIGHT_ID]
    );
    if (overrides.request) {
        const entries = Object.entries(overrides.request);
        for (const [column, value] of entries) {
            await db.query(
                `UPDATE public.analysis_requests SET ${column} = $2 WHERE id = $1`,
                [FAILED_REQUEST_ID, value]
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
        concierge_apify_credential_slot: CREDENTIAL_SLOT,
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
            ORDER_ID, USER_ID, OLD_PREFLIGHT_ID, ORDER_TARGET_INSTAGRAM_ID, 300, 100,
            order.status, order.payment_id, order.paid_at, order.actual_groble_product_id,
            order.actual_amount_krw, order.seller_reference_confirmed_at,
            order.concierge_apify_credential_slot, FAILED_REQUEST_ID,
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
            FAILED_REQUEST_ID, fulfillment.last_error_code,
            fulfillment.manual_review_at,
        ]
    );

    await db.query(
        `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code)
         VALUES ($1, 'track:target-evidence:collect', 'target-evidence', 'failed', 'JOB_ATTEMPTS_EXHAUSTED')`,
        [FAILED_REQUEST_ID]
    );
    if (!overrides.skipCancelledProfileJob) {
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code)
             VALUES ($1, 'track:profiles:batch:2', 'profiles', 'cancelled', 'PROFILE_FETCH_PERSISTENCE_ERROR')`,
            [FAILED_REQUEST_ID]
        );
    }
    if (overrides.extraPipelineJob) {
        const job = overrides.extraPipelineJob;
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code)
             VALUES ($1, $2, $3, $4, $5)`,
            [FAILED_REQUEST_ID, job.job_key, job.track, job.status, job.last_error_code ?? null]
        );
    }

    if (!overrides.skipProviderRun) {
        const providerRun = {
            status: 'succeeded',
            run_id: 'run-1',
            actual_usage_usd: 0.5,
            usage_reconciled_at: '2026-08-19T12:00:00.000Z',
            ...overrides.providerRunOverrides,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                 request_id, job_key, operation_key, status, run_id,
                 actual_usage_usd, usage_reconciled_at
             ) VALUES ($1, 'track:target-evidence:collect', 'profile-fallback:aaaa', $2, $3, $4, $5)`,
            [
                FAILED_REQUEST_ID, providerRun.status, providerRun.run_id,
                providerRun.actual_usage_usd, providerRun.usage_reconciled_at,
            ]
        );
    }

    if (!overrides.skipFailureReceipt) {
        const receipt = {
            failed_job_key: 'track:target-evidence:collect',
            error_code: 'JOB_ATTEMPTS_EXHAUSTED',
            ...overrides.failureReceiptOverrides,
        };
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, failed_job_key, error_code)
             VALUES ($1, $2, $3)`,
            [FAILED_REQUEST_ID, receipt.failed_job_key, receipt.error_code]
        );
    }
}

function recover(
    db: PGlite,
    orderId = ORDER_ID,
    failedRequestId = FAILED_REQUEST_ID,
    expectedManualReviewAt = EXPECTED_MANUAL_REVIEW_AT
) {
    return asRole<RecoveryRow>(
        db,
        'service_role',
        `SELECT * FROM public.recover_earlybird_profile_fetch_exhaustion_fulfillment($1, $2, $3)`,
        [orderId, failedRequestId, expectedManualReviewAt]
    );
}

describe('recover_earlybird_profile_fetch_exhaustion_fulfillment', () => {
    afterAll(async () => {
        await Promise.all(databases.map(database => database.close()));
    });

    it('happy path: resets order/fulfillment onto a fresh preflight without touching the failed lineage', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        const result = await recover(db);
        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];
        expect(row.order_id).toBe(ORDER_ID);
        expect(row.fulfillment_status).toBe('admission_pending');
        expect(row.failed_request_id).toBe(FAILED_REQUEST_ID);
        expect(row.preflight_id).not.toBe(OLD_PREFLIGHT_ID);
        const newPreflightId = row.preflight_id;
        const expectedIdempotencyKey =
            `earlybird.schema-recovery.${ORDER_ID.replace(/-/g, '')}`;

        await expect(db.query(
            `SELECT status, admission_status, idempotency_key, access_mode,
                    order_scoped_apify_credential_slot,
                    target_followers_count, target_following_count
             FROM public.analysis_preflights WHERE id = $1`,
            [newPreflightId]
        )).resolves.toMatchObject({
            rows: [{
                status: 'ready',
                // Fresh-admission idle by default: the operator's own
                // admitAndAdvance reserves/enqueues admission later.
                admission_status: 'idle',
                idempotency_key: expectedIdempotencyKey,
                access_mode: 'production',
                order_scoped_apify_credential_slot: CREDENTIAL_SLOT,
                target_followers_count: 300,
                target_following_count: 100,
            }],
        });

        await expect(db.query(
            `SELECT preflight_id, status, result_request_id FROM public.earlybird_orders WHERE id = $1`,
            [ORDER_ID]
        )).resolves.toMatchObject({
            rows: [{ preflight_id: newPreflightId, status: 'paid', result_request_id: null }],
        });

        await expect(db.query(
            `SELECT status, attempt_count, request_id, last_error_code, manual_review_at
             FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER_ID]
        )).resolves.toMatchObject({
            rows: [{
                status: 'admission_pending', attempt_count: 0,
                request_id: null, last_error_code: null, manual_review_at: null,
            }],
        });

        await expect(db.query(
            `SELECT order_id, failed_request_id, recovery_preflight_id
             FROM public.earlybird_schema_failure_recoveries WHERE order_id = $1`,
            [ORDER_ID]
        )).resolves.toMatchObject({
            rows: [{
                order_id: ORDER_ID, failed_request_id: FAILED_REQUEST_ID,
                recovery_preflight_id: newPreflightId,
            }],
        });
        await expect(db.query(
            `SELECT expected_manual_review_at FROM public.earlybird_profile_fetch_exhaustion_recoveries
             WHERE order_id = $1`,
            [ORDER_ID]
        )).resolves.toMatchObject({
            rows: [{ expected_manual_review_at: new Date(EXPECTED_MANUAL_REVIEW_AT) }],
        });

        // Old (terminal) lineage must remain byte-for-byte untouched.
        await expect(db.query(
            `SELECT status, consumed_request_id FROM public.analysis_preflights WHERE id = $1`,
            [OLD_PREFLIGHT_ID]
        )).resolves.toMatchObject({
            rows: [{ status: 'consumed', consumed_request_id: FAILED_REQUEST_ID }],
        });
        await expect(db.query(
            `SELECT status, error_message FROM public.analysis_requests WHERE id = $1`,
            [FAILED_REQUEST_ID]
        )).resolves.toMatchObject({
            rows: [{ status: 'failed', error_message: 'JOB_ATTEMPTS_EXHAUSTED' }],
        });
    });

    it('idempotent replay: a second identical call returns the same recovery without duplicating audit rows', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        const first = await recover(db);
        const second = await recover(db);
        expect(second.rows[0]).toEqual(first.rows[0]);

        await expect(db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.earlybird_profile_fetch_exhaustion_recoveries
             WHERE order_id = $1`,
            [ORDER_ID]
        )).resolves.toMatchObject({ rows: [{ count: 1 }] });
        await expect(db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_preflights`
        )).resolves.toMatchObject({ rows: [{ count: 2 }] });
    });

    it('stale CAS: rejects when the caller-supplied manual_review_at no longer matches the fulfillment row', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        await expect(recover(db, ORDER_ID, FAILED_REQUEST_ID, '2099-01-01T00:00:00.000Z')).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
        await expect(db.query(
            `SELECT status FROM public.earlybird_orders WHERE id = $1`,
            [ORDER_ID]
        )).resolves.toMatchObject({ rows: [{ status: 'analysis_in_progress' }] });

        // After a genuine recovery, replaying with a different CAS value is a
        // distinct conflict (existing lineage found, but CAS no longer matches).
        await recover(db);
        await expect(recover(db, ORDER_ID, FAILED_REQUEST_ID, '2099-01-01T00:00:00.000Z')).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_CONFLICT'
        );
    });

    it('payment/refund refusal: rejects when payment evidence is incomplete or a cancel event exists', async () => {
        const dbMissingPayment = await createDb();
        await buildValidFixture(dbMissingPayment, { order: { actual_amount_krw: null } });
        await expect(recover(dbMissingPayment)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbUnpaid = await createDb();
        await buildValidFixture(dbUnpaid, { order: { paid_at: null } });
        await expect(recover(dbUnpaid)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbCancelled = await createDb();
        await buildValidFixture(dbCancelled, { webhookEvents: ['payment.cancel_requested'] });
        await expect(recover(dbCancelled)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('webhook event count gate: rejects unless the order has exactly one payment.completed event', async () => {
        const dbNone = await createDb();
        await buildValidFixture(dbNone, { webhookEvents: [] });
        await expect(recover(dbNone)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbDuplicate = await createDb();
        await buildValidFixture(dbDuplicate, {
            webhookEvents: ['payment.completed', 'payment.completed'],
        });
        await expect(recover(dbDuplicate)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('unreconciled-run refusal: rejects when a terminal provider run is missing usage reconciliation or one is still active', async () => {
        const dbUnreconciled = await createDb();
        await buildValidFixture(dbUnreconciled, {
            providerRunOverrides: { usage_reconciled_at: null },
        });
        await expect(recover(dbUnreconciled)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbActive = await createDb();
        await buildValidFixture(dbActive, {
            providerRunOverrides: {
                status: 'running', run_id: null, actual_usage_usd: null, usage_reconciled_at: null,
            },
        });
        await expect(recover(dbActive)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('narrows adoption-readiness to fully-succeeded runs: a reconciled but non-succeeded terminal run is still ineligible', async () => {
        const db = await createDb();
        await buildValidFixture(db, {
            providerRunOverrides: { status: 'failed' },
        });
        await expect(recover(db)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('requires at least one provider run to exist', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipProviderRun: true });
        await expect(recover(db)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('requires every source provider run to be fully succeeded, not just one of several', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipProviderRun: true });
        await db.query(
            `INSERT INTO public.analysis_v2_provider_runs(
                 request_id, job_key, operation_key, status, run_id,
                 actual_usage_usd, usage_reconciled_at
             ) VALUES
                 ($1, 'track:target-evidence:collect', 'op-a', 'succeeded', 'run-a', 0.5, $2),
                 ($1, 'track:target-evidence:collect', 'op-b', 'succeeded', NULL, NULL, NULL)`,
            [FAILED_REQUEST_ID, '2026-08-19T12:00:00.000Z']
        );
        await expect(recover(db)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('rejects when the terminal profile-batch cancellation evidence is missing', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipCancelledProfileJob: true });
        await expect(recover(db)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('rejects when the failure receipt is missing or does not match the exact job key and error code', async () => {
        const dbMissing = await createDb();
        await buildValidFixture(dbMissing, { skipFailureReceipt: true });
        await expect(recover(dbMissing)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbWrongJobKey = await createDb();
        await buildValidFixture(dbWrongJobKey, {
            failureReceiptOverrides: { failed_job_key: 'track:profiles:batch:2' },
        });
        await expect(recover(dbWrongJobKey)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbWrongErrorCode = await createDb();
        await buildValidFixture(dbWrongErrorCode, {
            failureReceiptOverrides: { error_code: 'SOME_OTHER_ERROR' },
        });
        await expect(recover(dbWrongErrorCode)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it.each(['pending', 'processing', 'retryable'] as const)(
        'rejects when another job on the request is still active with status %s',
        async (status) => {
            const db = await createDb();
            await buildValidFixture(db, {
                extraPipelineJob: {
                    job_key: `track:extra:${status}`,
                    track: 'profiles',
                    status,
                },
            });
            await expect(recover(db)).rejects.toThrow(
                'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
            );
        }
    );

    it('credential slot gate: requires the order slot to be exactly secondary and the source preflight slot to match it', async () => {
        const dbWrongOrderSlot = await createDb();
        await buildValidFixture(dbWrongOrderSlot, {
            order: { concierge_apify_credential_slot: WRONG_CREDENTIAL_SLOT },
        });
        await expect(recover(dbWrongOrderSlot)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbNullOrderSlot = await createDb();
        await buildValidFixture(dbNullOrderSlot, {
            order: { concierge_apify_credential_slot: null },
        });
        await expect(recover(dbNullOrderSlot)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbMismatchedPreflightSlot = await createDb();
        await buildValidFixture(dbMismatchedPreflightSlot, {
            preflight: { order_scoped_apify_credential_slot: WRONG_CREDENTIAL_SLOT },
        });
        await expect(recover(dbMismatchedPreflightSlot)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbNullPreflightSlot = await createDb();
        await buildValidFixture(dbNullPreflightSlot, {
            preflight: { order_scoped_apify_credential_slot: null },
        });
        await expect(recover(dbNullPreflightSlot)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    }, 30_000);

    it('scrub token gate: the request and source preflight tokens are each derived from their own id, independently', async () => {
        const dbWrongRequestToken = await createDb();
        await buildValidFixture(dbWrongRequestToken, {
            request: { target_instagram_id: 'retained.deadbeefdeadbeefdead' },
        });
        await expect(recover(dbWrongRequestToken)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbWrongPreflightToken = await createDb();
        await buildValidFixture(dbWrongPreflightToken, {
            preflight: { target_instagram_id: 'retained.deadbeefdeadbeefdead' },
        });
        await expect(recover(dbWrongPreflightToken)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        // The happy path above is the positive proof that the two tokens
        // (derived from two different ids) are never required to match each
        // other.
    });

    it('rejects when the order has an active competing request or preflight for the same user', async () => {
        const dbActiveRequest = await createDb();
        await buildValidFixture(dbActiveRequest);
        await dbActiveRequest.query(
            `INSERT INTO public.analysis_requests(id, user_id, pipeline_version, status)
             VALUES ($1, $2, 'v2', 'processing')`,
            [OTHER_REQUEST_ID, USER_ID]
        );
        await expect(recover(dbActiveRequest)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbActivePreflight = await createDb();
        await buildValidFixture(dbActivePreflight);
        await dbActivePreflight.query(
            `INSERT INTO public.analysis_preflights(
                 id, user_id, idempotency_key, status, access_mode
             ) VALUES ($1, $2, 'other-active-preflight-key', 'ready', 'production')`,
            [OTHER_PREFLIGHT_ID, USER_ID]
        );
        await expect(recover(dbActivePreflight)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('rejects when the order status is not analysis_in_progress', async () => {
        const db = await createDb();
        await buildValidFixture(db, { order: { status: 'paid' } });
        await expect(recover(db)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('fails closed with a descriptive error when the shared schema-recovery ledger already holds a row for this order', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        // An unrelated recovery lineage (a different failed request and
        // preflight) already occupies this order's row in the shared,
        // append-only ledger the target migration's own bridge insert must
        // also write to.
        await db.query(
            `INSERT INTO public.analysis_requests(id, user_id, pipeline_version, status)
             VALUES ($1, $2, 'v2', 'failed')`,
            [OTHER_REQUEST_ID, USER_ID]
        );
        await db.query(
            `INSERT INTO public.analysis_preflights(
                 id, user_id, idempotency_key, status, access_mode
             ) VALUES ($1, $2, 'unrelated-shared-recovery-preflight-key', 'consumed', 'production')`,
            [OTHER_PREFLIGHT_ID, USER_ID]
        );
        await db.query(
            `INSERT INTO public.earlybird_schema_failure_recoveries(
                 order_id, failed_request_id, recovery_preflight_id, prior_attempt_count
             ) VALUES ($1, $2, $3, 0)`,
            [ORDER_ID, OTHER_REQUEST_ID, OTHER_PREFLIGHT_ID]
        );

        await expect(recover(db)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_SHARED_LEDGER_CONFLICT'
        );
    });

    it('restrictive ACL: only service_role may execute, and no other role can read or write the audit table', async () => {
        const db = await createDb();
        await buildValidFixture(db);

        await expect(db.query<{
            service_execute: boolean;
            authenticated_execute: boolean;
            anon_execute: boolean;
            authenticated_select: boolean;
            authenticated_insert: boolean;
        }>(`SELECT
            has_function_privilege(
                'service_role',
                'public.recover_earlybird_profile_fetch_exhaustion_fulfillment(uuid,uuid,timestamptz)',
                'EXECUTE'
            ) AS service_execute,
            has_function_privilege(
                'authenticated',
                'public.recover_earlybird_profile_fetch_exhaustion_fulfillment(uuid,uuid,timestamptz)',
                'EXECUTE'
            ) AS authenticated_execute,
            has_function_privilege(
                'anon',
                'public.recover_earlybird_profile_fetch_exhaustion_fulfillment(uuid,uuid,timestamptz)',
                'EXECUTE'
            ) AS anon_execute,
            has_table_privilege(
                'authenticated', 'public.earlybird_profile_fetch_exhaustion_recoveries', 'SELECT'
            ) AS authenticated_select,
            has_table_privilege(
                'authenticated', 'public.earlybird_profile_fetch_exhaustion_recoveries', 'INSERT'
            ) AS authenticated_insert
        `)).resolves.toMatchObject({
            rows: [{
                service_execute: true,
                authenticated_execute: false,
                anon_execute: false,
                authenticated_select: false,
                authenticated_insert: false,
            }],
        });

        await expect(asRole(
            db, 'authenticated',
            `SELECT * FROM public.recover_earlybird_profile_fetch_exhaustion_fulfillment($1, $2, $3)`,
            [ORDER_ID, FAILED_REQUEST_ID, EXPECTED_MANUAL_REVIEW_AT]
        )).rejects.toThrow(/permission denied/i);

        // The audit ledger is append-only even to service_role: no direct
        // UPDATE/DELETE, only the SECURITY DEFINER function's own INSERT.
        await recover(db);
        await expect(asRole(
            db, 'service_role',
            `UPDATE public.earlybird_profile_fetch_exhaustion_recoveries
             SET prior_attempt_count = 9 WHERE order_id = $1`,
            [ORDER_ID]
        )).rejects.toThrow(/EARLYBIRD_SCHEMA_FAILURE_RECOVERY_IMMUTABLE|permission denied/i);
    });
});

describe('resolve_analysis_v2_recovery_provider_run (post-recovery successor resolver wrapper)', () => {
    const RESOLVER_SQL = `SELECT public.resolve_analysis_v2_recovery_provider_run(
        $1, $2, $3, $4, $5, $6, $7, $8, $9
    ) AS result`;

    async function setUpSuccessorLineage(db: PGlite): Promise<void> {
        await buildValidFixture(db);
        await recover(db);
        const { rows } = await db.query<{ preflight_id: string }>(
            `SELECT preflight_id FROM public.earlybird_orders WHERE id = $1`,
            [ORDER_ID]
        );
        const newPreflightId = rows[0].preflight_id;
        await db.query(
            `INSERT INTO public.analysis_requests(id, user_id, preflight_id, pipeline_version, status)
             VALUES ($1, $2, $3, 'v2', 'pending')`,
            [SUCCESSOR_REQUEST_ID, USER_ID, newPreflightId]
        );
        await db.query(
            `UPDATE public.earlybird_orders SET result_request_id = $2 WHERE id = $1`,
            [ORDER_ID, SUCCESSOR_REQUEST_ID]
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments SET request_id = $2 WHERE order_id = $1`,
            [ORDER_ID, SUCCESSOR_REQUEST_ID]
        );
    }

    it('returns NULL for the exact successor request this recovery lineage produced, forcing a brand-new provider call', async () => {
        const db = await createDb();
        await setUpSuccessorLineage(db);

        await expect(asRole<{ result: unknown }>(
            db, 'service_role', RESOLVER_SQL,
            [
                SUCCESSOR_REQUEST_ID, 'track:target-evidence:collect', CLAIM_TOKEN,
                'op', 'a'.repeat(64), 'apify', 'actor', 'secondary', 10,
            ]
        )).resolves.toMatchObject({ rows: [{ result: null }] });
    });

    it('delegates byte-for-byte to the renamed resolver for a request that is not this lineage\'s successor', async () => {
        const db = await createDb();
        await setUpSuccessorLineage(db);

        await expect(asRole<{ result: { source: string; request_id: string; job_key: string } }>(
            db, 'service_role', RESOLVER_SQL,
            [
                FAILED_REQUEST_ID, 'track:target-evidence:collect', CLAIM_TOKEN,
                'op', 'a'.repeat(64), 'apify', 'actor', 'secondary', 10,
            ]
        )).resolves.toMatchObject({
            rows: [{
                result: {
                    source: 'pre_pfe_stub',
                    request_id: FAILED_REQUEST_ID,
                    job_key: 'track:target-evidence:collect',
                },
            }],
        });
    });

    it('delegates for a request id that does not exist at all, without erroring', async () => {
        const db = await createDb();
        await setUpSuccessorLineage(db);
        const bogusRequestId = '40000000-0000-4000-8000-000000009999';

        await expect(asRole<{ result: { source: string } }>(
            db, 'service_role', RESOLVER_SQL,
            [
                bogusRequestId, 'track:target-evidence:collect', CLAIM_TOKEN,
                'op', 'a'.repeat(64), 'apify', 'actor', 'secondary', 10,
            ]
        )).resolves.toMatchObject({
            rows: [{ result: { source: 'pre_pfe_stub' } }],
        });
    });

    it('restrictive ACL: only service_role may execute the wrapper, and the renamed resolver is not directly callable', async () => {
        const db = await createDb();
        await setUpSuccessorLineage(db);

        await expect(db.query<{
            wrapper_service_execute: boolean;
            wrapper_authenticated_execute: boolean;
            wrapper_anon_execute: boolean;
            renamed_service_execute: boolean;
            renamed_authenticated_execute: boolean;
        }>(`SELECT
            has_function_privilege(
                'service_role',
                'public.resolve_analysis_v2_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)',
                'EXECUTE'
            ) AS wrapper_service_execute,
            has_function_privilege(
                'authenticated',
                'public.resolve_analysis_v2_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)',
                'EXECUTE'
            ) AS wrapper_authenticated_execute,
            has_function_privilege(
                'anon',
                'public.resolve_analysis_v2_recovery_provider_run(uuid,text,uuid,text,text,text,text,text,numeric)',
                'EXECUTE'
            ) AS wrapper_anon_execute,
            has_function_privilege(
                'service_role',
                'public.resolve_analysis_v2_recovery_provider_run_pre_pfe(uuid,text,uuid,text,text,text,text,text,numeric)',
                'EXECUTE'
            ) AS renamed_service_execute,
            has_function_privilege(
                'authenticated',
                'public.resolve_analysis_v2_recovery_provider_run_pre_pfe(uuid,text,uuid,text,text,text,text,text,numeric)',
                'EXECUTE'
            ) AS renamed_authenticated_execute
        `)).resolves.toMatchObject({
            rows: [{
                wrapper_service_execute: true,
                wrapper_authenticated_execute: false,
                wrapper_anon_execute: false,
                renamed_service_execute: false,
                renamed_authenticated_execute: false,
            }],
        });

        await expect(asRole(
            db, 'authenticated', RESOLVER_SQL,
            [
                SUCCESSOR_REQUEST_ID, 'track:target-evidence:collect', CLAIM_TOKEN,
                'op', 'a'.repeat(64), 'apify', 'actor', 'secondary', 10,
            ]
        )).rejects.toThrow(/permission denied/i);
    });
});

describe('earlybird_provider_run_adoption_ready (profile-fetch-exhaustion lineage readiness helper)', () => {
    async function recoveredPreflightId(db: PGlite): Promise<string> {
        const { rows } = await db.query<{ preflight_id: string }>(
            `SELECT preflight_id FROM public.earlybird_orders WHERE id = $1`,
            [ORDER_ID]
        );
        return rows[0].preflight_id;
    }

    // Called directly as the connection's owning role (not via asRole/SET
    // ROLE): the function's REVOKE ALL ... FROM PUBLIC, anon, authenticated,
    // service_role matches its real production ACL, where it is only ever
    // reached internally, from another SECURITY DEFINER function executing
    // as its owner -- never called directly by an exposed role. The
    // restrictive-ACL test below proves service_role itself has no EXECUTE.
    function readinessReady(db: PGlite, preflightId: string) {
        return db.query<{ ready: boolean }>(
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3) AS ready`,
            [ORDER_ID, FAILED_REQUEST_ID, preflightId]
        );
    }

    it('is ready once the recovered lineage matches the order/failed-request/preflight triple exactly', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await recover(db);
        const preflightId = await recoveredPreflightId(db);

        await expect(readinessReady(db, preflightId)).resolves.toMatchObject({
            rows: [{ ready: true }],
        });
    });

    it('is not ready once every source provider run has been removed', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await recover(db);
        const preflightId = await recoveredPreflightId(db);

        await db.query(
            `DELETE FROM public.analysis_v2_provider_runs WHERE request_id = $1`,
            [FAILED_REQUEST_ID]
        );

        await expect(readinessReady(db, preflightId)).resolves.toMatchObject({
            rows: [{ ready: false }],
        });
    });

    it('is not ready once the order has moved off the paid state the recovery admitted it into', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await recover(db);
        const preflightId = await recoveredPreflightId(db);

        await db.query(
            `UPDATE public.earlybird_orders SET status = 'analysis_in_progress' WHERE id = $1`,
            [ORDER_ID]
        );

        await expect(readinessReady(db, preflightId)).resolves.toMatchObject({
            rows: [{ ready: false }],
        });
    });

    it('is not ready once the order already has a result request bound', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await recover(db);
        const preflightId = await recoveredPreflightId(db);

        await db.query(
            `UPDATE public.earlybird_orders SET result_request_id = $2 WHERE id = $1`,
            [ORDER_ID, FAILED_REQUEST_ID]
        );

        await expect(readinessReady(db, preflightId)).resolves.toMatchObject({
            rows: [{ ready: false }],
        });
    });

    it('restrictive ACL: no exposed role may execute either readiness helper directly', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await recover(db);

        await expect(db.query<{
            top_service_execute: boolean;
            top_authenticated_execute: boolean;
            top_anon_execute: boolean;
            pfe_service_execute: boolean;
            pre_pfe_service_execute: boolean;
        }>(`SELECT
            has_function_privilege(
                'service_role',
                'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)',
                'EXECUTE'
            ) AS top_service_execute,
            has_function_privilege(
                'authenticated',
                'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)',
                'EXECUTE'
            ) AS top_authenticated_execute,
            has_function_privilege(
                'anon',
                'public.earlybird_provider_run_adoption_ready(uuid,uuid,uuid)',
                'EXECUTE'
            ) AS top_anon_execute,
            has_function_privilege(
                'service_role',
                'public.earlybird_profile_fetch_exhaustion_provider_run_adoption_ready(uuid,uuid,uuid)',
                'EXECUTE'
            ) AS pfe_service_execute,
            has_function_privilege(
                'service_role',
                'public.earlybird_provider_run_adoption_ready_pre_pfe(uuid,uuid,uuid)',
                'EXECUTE'
            ) AS pre_pfe_service_execute
        `)).resolves.toMatchObject({
            rows: [{
                top_service_execute: false,
                top_authenticated_execute: false,
                top_anon_execute: false,
                pfe_service_execute: false,
                pre_pfe_service_execute: false,
            }],
        });

        const preflightId = await recoveredPreflightId(db);
        await expect(asRole(
            db, 'service_role',
            `SELECT public.earlybird_provider_run_adoption_ready($1, $2, $3)`,
            [ORDER_ID, FAILED_REQUEST_ID, preflightId]
        )).rejects.toThrow(/permission denied/i);
    });
});

describe('create_or_replay_earlybird_fulfillment_request (post-recovery successor admission gate)', () => {
    type AdmissionRow = {
        order_id: string;
        fulfillment_status: string;
        request_id: string | null;
        created: boolean;
        initial_job_key: string | null;
    };

    function admitSuccessor(db: PGlite) {
        return asRole<AdmissionRow>(
            db, 'service_role',
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request($1, $2, $3)`,
            [ORDER_ID, CLAIM_TOKEN, 1]
        );
    }

    it('admits exactly one distinct successor request once the profile-fetch-exhaustion lineage is provider-run adoption ready', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await recover(db);

        // The preserved, terminally-failed request still owns the order's
        // base idempotency key -- exactly as create_or_replay_earlybird_
        // fulfillment_request's own request-generation guard expects, and
        // exactly what makes it a "conflicting request" this incident's
        // fresh successor must be threaded past rather than blocked by.
        await db.query(
            `UPDATE public.analysis_requests SET idempotency_key = $2 WHERE id = $1`,
            [FAILED_REQUEST_ID, `earlybird:${ORDER_ID.toLowerCase()}`]
        );

        const result = await admitSuccessor(db);
        expect(result.rows).toHaveLength(1);
        const row = result.rows[0];
        expect(row.fulfillment_status).toBe('analysis_in_progress');
        expect(row.created).toBe(true);
        expect(row.request_id).not.toBeNull();
        expect(row.request_id).not.toBe(FAILED_REQUEST_ID);

        await expect(db.query<{ count: number }>(
            `SELECT count(*)::INTEGER AS count FROM public.analysis_requests
             WHERE id <> $1`,
            [FAILED_REQUEST_ID]
        )).resolves.toMatchObject({ rows: [{ count: 1 }] });

        await expect(db.query(
            `SELECT job_key, track, status FROM public.analysis_pipeline_jobs
             WHERE request_id = $1`,
            [row.request_id]
        )).resolves.toMatchObject({
            rows: [{ job_key: 'coordinator:bootstrap', track: 'coordinator', status: 'pending' }],
        });

        await expect(db.query(
            `SELECT status, result_request_id FROM public.earlybird_orders WHERE id = $1`,
            [ORDER_ID]
        )).resolves.toMatchObject({
            rows: [{ status: 'analysis_in_progress', result_request_id: row.request_id }],
        });
        await expect(db.query(
            `SELECT status, request_id FROM public.earlybird_fulfillments WHERE order_id = $1`,
            [ORDER_ID]
        )).resolves.toMatchObject({
            rows: [{ status: 'analysis_in_progress', request_id: row.request_id }],
        });
    });
});
