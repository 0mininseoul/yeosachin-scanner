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

const USER_ID = '10000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '10000000-0000-4000-8000-000000000002';
const OLD_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000001';
const ORDER_ID = '30000000-0000-4000-8000-000000000001';
const FAILED_REQUEST_ID = '40000000-0000-4000-8000-000000000001';
const OTHER_REQUEST_ID = '40000000-0000-4000-8000-000000000002';
const OTHER_PREFLIGHT_ID = '20000000-0000-4000-8000-000000000002';
const CREDENTIAL_SLOT = 'primary';
const EXPECTED_MANUAL_REVIEW_AT = '2026-08-20T00:00:00.000Z';

const RETAINED_TARGET_ID = 'retained.0123456789abcdef0123';

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

CREATE TABLE public.analysis_v2_failure_receipts (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    error_code TEXT NOT NULL,
    PRIMARY KEY (request_id, error_code)
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
    skipProviderRun?: boolean;
    providerRunOverrides?: Record<string, unknown>;
    skipFailureReceipt?: boolean;
    extraFailureReceipt?: boolean;
    webhookEventType?: string;
};

async function buildValidFixture(
    db: PGlite,
    overrides: FixtureOverrides = {}
): Promise<void> {
    await db.query(`INSERT INTO public.users(id, email) VALUES ($1, 'buyer@example.com')`, [USER_ID]);

    await db.query(
        `INSERT INTO public.analysis_requests(
             id, user_id, pipeline_version, status, current_step, error_message
         ) VALUES ($1, $2, 'v2', 'pending', 'pending', NULL)`,
        [FAILED_REQUEST_ID, USER_ID]
    );

    const snapshot = JSON.stringify({ basic: { launchStatus: 'production' } });
    const preflight = {
        id: OLD_PREFLIGHT_ID,
        status: 'consumed',
        access_mode: 'production',
        pii_scrubbed_at: '2026-08-19T00:00:00.000Z',
        target_instagram_id: RETAINED_TARGET_ID,
        target_followers_count: 300,
        target_following_count: 100,
        target_is_private: false,
        capacity_required_plan_id: 'basic',
        required_plan_id: 'basic',
        consumed_request_id: FAILED_REQUEST_ID,
        ...overrides.preflight,
    };
    await db.query(
        `INSERT INTO public.analysis_preflights(
             id, user_id, idempotency_key, target_instagram_id, status, access_mode,
             launch_status_snapshot, plan_catalog_snapshot, plan_cards_snapshot,
             pricing_version, pricing_snapshot, policy_versions_snapshot,
             target_followers_count, target_following_count, target_is_private,
             capacity_required_plan_id, required_plan_id, consumed_request_id,
             pii_scrubbed_at
         ) VALUES (
             $1, $2, 'old-preflight-key', $3, $4, $5,
             $6::jsonb, $6::jsonb, $6::jsonb, 'v1', $6::jsonb, $6::jsonb,
             $7, $8, $9, $10, $11, $12, $13
         )`,
        [
            preflight.id, USER_ID, preflight.target_instagram_id,
            preflight.status, preflight.access_mode, snapshot,
            preflight.target_followers_count, preflight.target_following_count,
            preflight.target_is_private, preflight.capacity_required_plan_id,
            preflight.required_plan_id, preflight.consumed_request_id,
            preflight.pii_scrubbed_at,
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
        actual_amount_krw: 19900,
        actual_groble_product_id: 'standard-product-01',
        concierge_apify_credential_slot: CREDENTIAL_SLOT,
        ...overrides.order,
    };
    await db.query(
        `INSERT INTO public.earlybird_orders(
             id, user_id, preflight_id, target_instagram_id, target_followers_count,
             target_following_count, exclusion_decision, plan_id, status,
             expected_groble_product_id, expected_amount_krw, payment_id,
             actual_groble_product_id, actual_amount_krw,
             seller_reference_confirmed_at, concierge_apify_credential_slot,
             result_request_id
         ) VALUES (
             $1, $2, $3, $4, $5, $6, 'skip', 'standard', $7,
             'standard-product-01', 19900, $8, $9, $10, $11, $12, $13
         )`,
        [
            ORDER_ID, USER_ID, OLD_PREFLIGHT_ID, RETAINED_TARGET_ID, 300, 100,
            order.status, order.payment_id, order.actual_groble_product_id,
            order.actual_amount_krw, order.seller_reference_confirmed_at,
            order.concierge_apify_credential_slot, FAILED_REQUEST_ID,
        ]
    );

    if (overrides.webhookEventType) {
        await db.query(
            `INSERT INTO public.earlybird_webhook_events(order_id, event_type)
             VALUES ($1, $2)`,
            [ORDER_ID, overrides.webhookEventType]
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
         VALUES ($1, 'track:profiles:batch:1', 'profiles', 'failed', 'JOB_ATTEMPTS_EXHAUSTED')`,
        [FAILED_REQUEST_ID]
    );
    if (!overrides.skipCancelledProfileJob) {
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(request_id, job_key, track, status, last_error_code)
             VALUES ($1, 'track:profiles:batch:2', 'profiles', 'cancelled', 'PROFILE_FETCH_PERSISTENCE_ERROR')`,
            [FAILED_REQUEST_ID]
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
             ) VALUES ($1, 'track:profiles:batch:1', 'profile-fallback:aaaa', $2, $3, $4, $5)`,
            [
                FAILED_REQUEST_ID, providerRun.status, providerRun.run_id,
                providerRun.actual_usage_usd, providerRun.usage_reconciled_at,
            ]
        );
    }

    if (!overrides.skipFailureReceipt) {
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
             VALUES ($1, 'JOB_ATTEMPTS_EXHAUSTED')`,
            [FAILED_REQUEST_ID]
        );
    }
    if (overrides.extraFailureReceipt) {
        await db.query(
            `INSERT INTO public.analysis_v2_failure_receipts(request_id, error_code)
             VALUES ($1, 'SOME_OTHER_ERROR')`,
            [FAILED_REQUEST_ID]
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

        await expect(db.query(
            `SELECT status, access_mode, order_scoped_apify_credential_slot,
                    target_followers_count, target_following_count
             FROM public.analysis_preflights WHERE id = $1`,
            [newPreflightId]
        )).resolves.toMatchObject({
            rows: [{
                status: 'ready',
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

        const dbCancelled = await createDb();
        await buildValidFixture(dbCancelled, { webhookEventType: 'payment.cancel_requested' });
        await expect(recover(dbCancelled)).rejects.toThrow(
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

    it('rejects when the terminal profile-batch cancellation evidence is missing', async () => {
        const db = await createDb();
        await buildValidFixture(db, { skipCancelledProfileJob: true });
        await expect(recover(db)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('rejects when the failure receipt is missing or not exactly one', async () => {
        const dbMissing = await createDb();
        await buildValidFixture(dbMissing, { skipFailureReceipt: true });
        await expect(recover(dbMissing)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );

        const dbExtra = await createDb();
        await buildValidFixture(dbExtra, { extraFailureReceipt: true });
        await expect(recover(dbExtra)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
        );
    });

    it('rejects when the order has an active competing request or preflight for the same user', async () => {
        const db = await createDb();
        await buildValidFixture(db);
        await db.query(
            `INSERT INTO public.analysis_requests(id, user_id, pipeline_version, status)
             VALUES ($1, $2, 'v2', 'processing')`,
            [OTHER_REQUEST_ID, USER_ID]
        );
        await expect(recover(db)).rejects.toThrow(
            'EARLYBIRD_PROFILE_FETCH_EXHAUSTION_RECOVERY_INELIGIBLE'
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
