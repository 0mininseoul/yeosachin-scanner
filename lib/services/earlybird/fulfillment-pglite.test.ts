import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import {
    afterAll,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
} from 'vitest';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260724123300_add_earlybird_fulfillment_outbox.sql',
        import.meta.url
    ),
    'utf8'
);

const USER = '123e4567-e89b-42d3-a456-426614174001';
const PREFLIGHT = '223e4567-e89b-42d3-a456-426614174001';
const ORDER = '323e4567-e89b-42d3-a456-426614174001';
const CLAIM = '423e4567-e89b-42d3-a456-426614174001'; // gitleaks:allow

const catalog = {
    basic: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 400, following: 400 },
        detailedMutualLimit: 300,
    },
    standard: {
        launchStatus: 'production',
        relationshipCapacity: { followers: 800, following: 800 },
        detailedMutualLimit: 600,
    },
    plus: {
        launchStatus: 'test_only',
        relationshipCapacity: { followers: 1200, following: 1200 },
        detailedMutualLimit: 900,
    },
};
const cards = {
    basic: {
        ...catalog.basic,
        selectionState: 'required',
        unavailableReason: null,
    },
    standard: {
        ...catalog.standard,
        selectionState: 'available_upgrade',
        unavailableReason: null,
    },
    plus: {
        ...catalog.plus,
        selectionState: 'unavailable',
        unavailableReason: 'launch_gate',
    },
};

type FulfillmentIdentity = {
    order_id: string;
    fulfillment_status: string;
    preflight_id: string;
    user_id: string;
    plan_id: 'basic' | 'standard';
    request_id: string | null;
};

let db: PGlite;

async function asService<T>(
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

function admissionHash(orderId = ORDER): string {
    return createHash('sha256')
        .update(`earlybird-fulfillment-admission-v1\n${orderId}`, 'utf8')
        .digest('hex');
}

async function admit(): Promise<FulfillmentIdentity> {
    return (await asService<FulfillmentIdentity>(
        'SELECT * FROM public.admit_earlybird_fulfillment($1)',
        [ORDER]
    )).rows[0];
}

async function makeAdmissionReady(): Promise<void> {
    await db.query(
        `UPDATE public.analysis_preflights
         SET admission_status = 'ready',
             admission_selected_plan_id = 'basic',
             admission_entitlement_jti_hash = $2,
             admission_token = '523e4567-e89b-42d3-a456-426614174001',
             admission_refreshed_at = pg_catalog.clock_timestamp(),
             admission_plan_cards_snapshot = $3::JSONB
         WHERE id = $1`,
        [PREFLIGHT, admissionHash(), JSON.stringify(cards)]
    );
}

async function claim() {
    return (await asService<{
        claimed: boolean;
        fulfillment_status: string;
        lease_token: string | null;
        lease_fence: number;
        attempt_count: number;
    }>(
        `SELECT * FROM public.claim_earlybird_fulfillment(
            $1, $2, 300
        )`,
        [ORDER, CLAIM]
    )).rows[0];
}

describe('operator-approved earlybird fulfillment migration', () => {
    beforeAll(async () => {
        db = await PGlite.create({ extensions: { pgcrypto } });
        await db.exec(`
            CREATE ROLE anon NOLOGIN;
            CREATE ROLE authenticated NOLOGIN;
            CREATE ROLE service_role NOLOGIN;
            CREATE SCHEMA extensions;
            CREATE EXTENSION pgcrypto WITH SCHEMA extensions;

            CREATE TABLE public.users (
                id UUID PRIMARY KEY
            );
            CREATE TABLE public.analysis_requests (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES public.users(id),
                target_instagram_id TEXT NOT NULL,
                target_gender TEXT NOT NULL,
                status TEXT NOT NULL,
                progress INTEGER NOT NULL,
                progress_step TEXT,
                current_step TEXT,
                step_data JSONB,
                gender_stats JSONB,
                plan_type TEXT,
                background_processing BOOLEAN,
                idempotency_key TEXT,
                pipeline_version TEXT,
                preflight_id UUID,
                excluded_instagram_id TEXT,
                exclusion_decision_snapshot TEXT,
                plan_access_mode_snapshot TEXT,
                capacity_required_plan_id_snapshot TEXT,
                required_plan_id_snapshot TEXT,
                selected_plan_id_snapshot TEXT,
                plan_launch_status_snapshot JSONB,
                plan_cards_snapshot JSONB,
                pricing_version_snapshot TEXT,
                pricing_snapshot JSONB,
                analysis_scope_snapshot JSONB,
                policy_versions_snapshot JSONB
            );
            CREATE TABLE public.analysis_preflights (
                id UUID PRIMARY KEY,
                user_id UUID NOT NULL REFERENCES public.users(id),
                target_instagram_id TEXT NOT NULL,
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
                consumed_at TIMESTAMP WITH TIME ZONE,
                error_code TEXT,
                blocked_at TIMESTAMP WITH TIME ZONE,
                ready_at TIMESTAMP WITH TIME ZONE,
                expires_at TIMESTAMP WITH TIME ZONE,
                pii_scrubbed_at TIMESTAMP WITH TIME ZONE,
                admission_status TEXT,
                admission_selected_plan_id TEXT,
                admission_entitlement_jti_hash TEXT,
                admission_token UUID,
                admission_refreshed_at TIMESTAMP WITH TIME ZONE,
                admission_plan_cards_snapshot JSONB,
                updated_at TIMESTAMP WITH TIME ZONE
                    DEFAULT pg_catalog.clock_timestamp()
            );
            ALTER TABLE public.analysis_requests
                ADD CONSTRAINT analysis_requests_preflight_fk
                FOREIGN KEY (preflight_id)
                REFERENCES public.analysis_preflights(id)
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
                result_request_id UUID REFERENCES public.analysis_requests(id),
                updated_at TIMESTAMP WITH TIME ZONE
                    DEFAULT pg_catalog.clock_timestamp()
            );
            CREATE TABLE public.analysis_pipeline_jobs (
                request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
                job_key TEXT NOT NULL,
                track TEXT NOT NULL,
                kind TEXT NOT NULL,
                batch INTEGER,
                input_hash TEXT NOT NULL,
                required_job_keys TEXT[] NOT NULL,
                PRIMARY KEY(request_id, job_key)
            );

            CREATE FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
            CREATE FUNCTION public.analysis_v2_valid_scope_snapshot(JSONB)
            RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
        `);
        await db.exec(migration);
    });

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.earlybird_fulfillments,
                public.analysis_pipeline_jobs,
                public.earlybird_orders,
                public.analysis_requests,
                public.analysis_preflights,
                public.users;
            INSERT INTO public.users(id) VALUES ('${USER}');
        `);
        await db.query(
            `INSERT INTO public.analysis_preflights(
                id, user_id, target_instagram_id,
                target_followers_count, target_following_count,
                target_is_private, exclusion_decision, status, access_mode,
                launch_status_snapshot, plan_catalog_snapshot,
                plan_cards_snapshot, pricing_version, pricing_snapshot,
                policy_versions_snapshot, capacity_required_plan_id,
                required_plan_id, ready_at, expires_at, admission_status
            ) VALUES (
                $1, $2, 'sample.account', 120, 140, FALSE, 'skip',
                'expired', 'production',
                '{"basic":"production","standard":"production","plus":"test_only"}',
                $3::JSONB, $4::JSONB, 'deferred',
                '{"basic":{"status":"deferred"},"standard":{"status":"deferred"},"plus":{"status":"deferred"}}',
                '{"pipeline":"v2","risk":"v1","aiStage":"v1"}',
                'basic', 'basic', pg_catalog.clock_timestamp() - INTERVAL '1 day',
                pg_catalog.clock_timestamp() - INTERVAL '1 hour', 'idle'
            )`,
            [PREFLIGHT, USER, JSON.stringify(catalog), JSON.stringify(cards)]
        );
        await db.query(
            `INSERT INTO public.earlybird_orders(
                id, user_id, preflight_id, target_instagram_id,
                target_followers_count, target_following_count,
                exclusion_decision, plan_id, status,
                expected_groble_product_id, expected_amount_krw,
                payment_id, actual_groble_product_id, actual_amount_krw,
                seller_reference_confirmed_at
            ) VALUES (
                $1, $2, $3, 'sample.account', 120, 140, 'skip',
                'basic', 'paid', 'basic-product', 14900,
                'payment-one', 'basic-product', 14900,
                pg_catalog.clock_timestamp()
            )`,
            [ORDER, USER, PREFLIGHT]
        );
    });

    afterAll(async () => {
        await db.close();
    });

    it('enqueues a confirmed payment but never exposes it to recovery before admission', async () => {
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].status).toBe('awaiting_operator');
        expect((await asService(
            'SELECT * FROM public.list_recoverable_earlybird_fulfillments(20)'
        )).rows).toEqual([]);
        expect((await db.query<{ count: number }>(
            'SELECT pg_catalog.count(*)::INTEGER AS count FROM public.analysis_requests'
        )).rows[0].count).toBe(0);
    });

    it('reactivates only the immutable paid preflight after explicit admission', async () => {
        await expect(admit()).resolves.toMatchObject({
            order_id: ORDER,
            fulfillment_status: 'admission_pending',
            preflight_id: PREFLIGHT,
            user_id: USER,
            plan_id: 'basic',
            request_id: null,
        });
        expect((await db.query<{
            status: string;
            target_instagram_id: string;
            access_mode: string;
        }>(
            `SELECT status, target_instagram_id, access_mode
             FROM public.analysis_preflights WHERE id = $1`,
            [PREFLIGHT]
        )).rows[0]).toEqual({
            status: 'ready',
            target_instagram_id: 'sample.account',
            access_mode: 'production',
        });
        expect((await asService<FulfillmentIdentity>(
            'SELECT * FROM public.list_recoverable_earlybird_fulfillments(20)'
        )).rows).toHaveLength(1);
    });

    it('creates one owner-linked production V2 request and safely replays it', async () => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        expect(lease).toMatchObject({
            claimed: true,
            fulfillment_status: 'admission_pending',
            lease_token: CLAIM,
            lease_fence: 1,
            attempt_count: 1,
        });

        const first = (await asService<{
            fulfillment_status: string;
            request_id: string | null;
            created: boolean;
            initial_job_key: string | null;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect(first).toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            created: true,
            initial_job_key: 'coordinator:bootstrap',
        });
        expect(first.request_id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        );

        const replay = (await asService<{
            fulfillment_status: string;
            request_id: string | null;
            created: boolean;
        }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        expect(replay).toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            request_id: first.request_id,
            created: false,
        });
        await expect(admit()).resolves.toMatchObject({
            fulfillment_status: 'analysis_in_progress',
            request_id: first.request_id,
        });
        expect((await db.query<{
            count: number;
            access_mode: string;
            user_id: string;
        }>(
            `SELECT pg_catalog.count(*) OVER ()::INTEGER AS count,
                    plan_access_mode_snapshot AS access_mode,
                    user_id::TEXT
             FROM public.analysis_requests`
        )).rows[0]).toEqual({
            count: 1,
            access_mode: 'production',
            user_id: USER,
        });
    });

    it('recovers expired claims and reconciles completed requests without admitting others', async () => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        await db.exec(`
            UPDATE public.earlybird_fulfillments
            SET lease_expires_at = pg_catalog.clock_timestamp() - INTERVAL '1 second'
            WHERE order_id = '${ORDER}';
        `);
        await expect(asService<{
            retryable: number;
        }>(
            'SELECT * FROM public.reconcile_earlybird_fulfillments(100)'
        )).resolves.toMatchObject({
            rows: [expect.objectContaining({ retryable: 1 })],
        });

        await makeAdmissionReady();
        const nextLease = await claim();
        expect(nextLease.lease_fence).toBe(lease.lease_fence + 1);
        const created = (await asService<{ request_id: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, nextLease.lease_fence]
        )).rows[0];
        await db.query(
            `UPDATE public.analysis_requests SET status = 'completed'
             WHERE id = $1`,
            [created.request_id]
        );
        const summary = (await asService<{
            completed: number;
            manual_review: number;
        }>(
            'SELECT * FROM public.reconcile_earlybird_fulfillments(100)'
        )).rows[0];
        expect(summary).toMatchObject({ completed: 1, manual_review: 0 });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_fulfillments WHERE order_id = $1',
            [ORDER]
        )).rows[0].status).toBe('completed');
    });

    it('never overwrites a refund-state order with a completed analysis', async () => {
        await admit();
        await makeAdmissionReady();
        const lease = await claim();
        const created = (await asService<{ request_id: string }>(
            `SELECT * FROM public.create_or_replay_earlybird_fulfillment_request(
                $1, $2, $3
            )`,
            [ORDER, CLAIM, lease.lease_fence]
        )).rows[0];
        await db.query(
            `UPDATE public.analysis_requests SET status = 'completed'
             WHERE id = $1`,
            [created.request_id]
        );
        await db.query(
            `UPDATE public.earlybird_orders SET status = 'refund_pending'
             WHERE id = $1`,
            [ORDER]
        );

        const summary = (await asService<{
            completed: number;
            manual_review: number;
        }>(
            'SELECT * FROM public.reconcile_earlybird_fulfillments(100)'
        )).rows[0];
        expect(summary).toMatchObject({ completed: 0, manual_review: 1 });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [ORDER]
        )).rows[0].status).toBe('refund_pending');
    });
});
