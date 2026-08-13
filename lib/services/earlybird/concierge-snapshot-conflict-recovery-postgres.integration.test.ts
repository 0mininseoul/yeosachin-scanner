import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const databaseUrl = process.env.CONCIERGE_RECOVERY_POSTGRES_TEST_URL;
const destructiveMarker = process.env.CONCIERGE_RECOVERY_POSTGRES_TEST_MARKER;
const describePostgres = databaseUrl ? describe : describe.skip;
const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260813233100_recover_concierge_snapshot_conflict.sql',
    import.meta.url,
), 'utf8');

const PAID_AT = '2026-08-12T09:07:30.000Z';
const MANUAL_REVIEW_AT = '2026-08-13T19:00:00.000Z';
const ADMISSION_REQUESTED_AT = '2026-08-13T18:58:00.000Z';
const ADMISSION_REFRESHED_AT = '2026-08-13T18:59:00.000Z';
const TARGET_INPUT_HASH = 'a'.repeat(64);

type Incident = Readonly<{
    userId: string;
    orderId: string;
    preflightId: string;
}>;

export function isSafeConciergeRecoveryPostgresTarget(
    connectionString: string | undefined,
    marker: string | undefined,
): boolean {
    if (marker !== 'local-ephemeral-concierge-recovery-only' || !connectionString) {
        return false;
    }
    try {
        const url = new URL(connectionString);
        return url.protocol === 'postgresql:'
            && (url.hostname === '127.0.0.1' || url.hostname === 'localhost')
            && url.pathname === '/concierge_snapshot_recovery_test';
    } catch {
        return false;
    }
}

describe('concierge recovery PostgreSQL destructive target guard', () => {
    it('accepts only the explicit loopback database and marker', () => {
        expect(isSafeConciergeRecoveryPostgresTarget(
            'postgresql://tester@127.0.0.1:55433/concierge_snapshot_recovery_test',
            'local-ephemeral-concierge-recovery-only',
        )).toBe(true);
    });

    it.each([
        ['postgresql://tester@db.example.com/concierge_snapshot_recovery_test', 'local-ephemeral-concierge-recovery-only'],
        ['postgresql://tester@127.0.0.1:55433/postgres', 'local-ephemeral-concierge-recovery-only'],
        ['postgresql://tester@127.0.0.1:55433/concierge_snapshot_recovery_test', undefined],
    ])('rejects an unsafe target or missing marker', (url, marker) => {
        expect(isSafeConciergeRecoveryPostgresTarget(url, marker)).toBe(false);
    });
});

const bootstrap = `
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT ALL ON SCHEMA public TO CURRENT_USER;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(
    version TEXT PRIMARY KEY
);
INSERT INTO supabase_migrations.schema_migrations(version)
VALUES ('20260813221946') ON CONFLICT DO NOTHING;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;

CREATE FUNCTION public.prevent_earlybird_schema_failure_recovery_mutation()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION 'IMMUTABLE_RECOVERY_RECEIPT'; END;
$$;
CREATE FUNCTION public.analysis_v2_valid_launch_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_plan_catalog_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_plan_cards_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_pricing_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;
CREATE FUNCTION public.analysis_v2_valid_policy_versions_snapshot(JSONB)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$ SELECT TRUE $$;

CREATE TABLE public.users (id UUID PRIMARY KEY);
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES public.users(id),
    preflight_id UUID,status TEXT NOT NULL,
    pipeline_version TEXT NOT NULL DEFAULT 'v2'
);
CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES public.users(id),
    target_instagram_id TEXT NOT NULL,target_followers_count INTEGER,
    target_input_hash TEXT,
    target_following_count INTEGER,target_is_private BOOLEAN,status TEXT NOT NULL,
    access_mode TEXT NOT NULL,consumed_request_id UUID,exclusion_decision TEXT NOT NULL,
    excluded_instagram_id TEXT,launch_status_snapshot JSONB NOT NULL,
    plan_catalog_snapshot JSONB NOT NULL,plan_cards_snapshot JSONB NOT NULL,
    pricing_snapshot JSONB NOT NULL,policy_versions_snapshot JSONB NOT NULL,
    capacity_required_plan_id TEXT,required_plan_id TEXT,admission_status TEXT NOT NULL,
    admission_generation INTEGER NOT NULL,admission_selected_plan_id TEXT,
    admission_requested_at TIMESTAMPTZ,admission_refreshed_at TIMESTAMPTZ,
    admission_target_followers_count INTEGER,admission_target_following_count INTEGER,
    admission_capacity_required_plan_id TEXT,admission_required_plan_id TEXT,
    admission_plan_cards_snapshot JSONB,order_scoped_apify_credential_slot TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES public.users(id),
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    target_instagram_id TEXT NOT NULL,target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,exclusion_decision TEXT NOT NULL,
    excluded_instagram_id TEXT,plan_id TEXT NOT NULL,pricing_version TEXT NOT NULL,
    status TEXT NOT NULL,
    payment_id TEXT,expected_groble_product_id TEXT,actual_groble_product_id TEXT,
    expected_amount_krw INTEGER,actual_amount_krw INTEGER,paid_at TIMESTAMPTZ,
    seller_reference_confirmed_at TIMESTAMPTZ,result_request_id UUID,
    concierge_apify_credential_slot TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.earlybird_fulfillments (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),status TEXT NOT NULL,
    request_id UUID,lease_fence BIGINT NOT NULL DEFAULT 0,
    lease_token UUID,lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL,attempt_count INTEGER NOT NULL,
    operator_admitted_at TIMESTAMPTZ,last_error_code TEXT,last_error_at TIMESTAMPTZ,
    manual_review_at TIMESTAMPTZ,completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.earlybird_webhook_events (
    event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,payment_id TEXT NOT NULL
);
CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    operation_key TEXT NOT NULL,input_hash TEXT NOT NULL,logical_provider TEXT NOT NULL,
    actor_id TEXT NOT NULL,credential_slot TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,
    reserved_at TIMESTAMPTZ NOT NULL,run_started_at TIMESTAMPTZ,
    terminalized_at TIMESTAMPTZ,actual_usage_usd NUMERIC,
    usage_reconciled_at TIMESTAMPTZ,reusable_profile_schema_version INTEGER,
    PRIMARY KEY (preflight_id,operation_key)
);
CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,status TEXT NOT NULL,dispatch_state TEXT NOT NULL,
    dispatch_generation INTEGER NOT NULL,dispatch_reservation_token UUID,
    dispatch_reserved_at TIMESTAMPTZ,dispatched_at TIMESTAMPTZ,
    dispatch_task_name TEXT,lease_expires_at TIMESTAMPTZ,
    recovery_not_before TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    scheduler_not_before_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    PRIMARY KEY(request_id,job_key)
);

CREATE FUNCTION public.claim_earlybird_fulfillment(
    p_order_id UUID,p_lease_token UUID,p_lease_seconds INTEGER
)
RETURNS TABLE(claimed BOOLEAN,fulfillment_status TEXT,lease_token UUID,
    lease_fence BIGINT,attempt_count INTEGER)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id=p_order_id FOR UPDATE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id=p_order_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=v_order.preflight_id FOR UPDATE;
    IF v_preflight.admission_refreshed_at IS NULL
       OR v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes' THEN
        RAISE EXCEPTION 'EARLYBIRD_FULFILLMENT_ADMISSION_NOT_READY';
    END IF;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status='admission_pending',lease_token=p_lease_token,
        lease_expires_at=v_now+p_lease_seconds*INTERVAL '1 second',
        lease_fence=fulfillment.lease_fence+1,
        attempt_count=fulfillment.attempt_count+1
    WHERE fulfillment.order_id=p_order_id
    RETURNING fulfillment.* INTO v_fulfillment;
    RETURN QUERY SELECT TRUE,v_fulfillment.status,v_fulfillment.lease_token,
        v_fulfillment.lease_fence,v_fulfillment.attempt_count;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_earlybird_fulfillment(UUID,UUID,INTEGER)
    FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.claim_earlybird_fulfillment(UUID,UUID,INTEGER)
    TO service_role;

CREATE FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    p_order_id UUID,p_lease_token UUID,p_lease_fence BIGINT
)
RETURNS TABLE(order_id UUID,fulfillment_status TEXT,request_id UUID,
    created BOOLEAN,initial_job_key TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_now TIMESTAMPTZ := pg_catalog.clock_timestamp();
    v_fulfillment public.earlybird_fulfillments%ROWTYPE;
    v_order public.earlybird_orders%ROWTYPE;
    v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    SELECT fulfillment.* INTO v_fulfillment
    FROM public.earlybird_fulfillments AS fulfillment
    WHERE fulfillment.order_id=p_order_id FOR UPDATE;
    SELECT earlybird_order.* INTO v_order
    FROM public.earlybird_orders AS earlybird_order
    WHERE earlybird_order.id=p_order_id FOR UPDATE;
    SELECT preflight.* INTO v_preflight
    FROM public.analysis_preflights AS preflight
    WHERE preflight.id=v_order.preflight_id FOR UPDATE;
    IF v_preflight.admission_target_followers_count IS NULL OR v_preflight.admission_target_following_count IS NULL
       OR v_preflight.admission_target_followers_count IS DISTINCT FROM v_preflight.target_followers_count
       OR v_preflight.admission_target_following_count IS DISTINCT FROM v_preflight.target_following_count THEN
        RETURN QUERY SELECT p_order_id,'manual_review'::TEXT,NULL::UUID,FALSE,NULL::TEXT;
        RETURN;
    END IF;
    IF v_preflight.admission_refreshed_at IS NOT NULL AND v_preflight.admission_refreshed_at < v_now - INTERVAL '2 minutes' THEN
        RETURN QUERY SELECT p_order_id,'retryable_failure'::TEXT,NULL::UUID,FALSE,NULL::TEXT;
        RETURN;
    END IF;
    INSERT INTO public.analysis_requests(id,user_id,preflight_id,status)
    VALUES (p_lease_token,v_order.user_id,v_preflight.id,'pending');
    UPDATE public.earlybird_orders AS updated_order
    SET status='analysis_in_progress',result_request_id=p_lease_token
    WHERE updated_order.id=p_order_id;
    UPDATE public.earlybird_fulfillments AS updated_fulfillment
    SET status='analysis_in_progress',request_id=p_lease_token,
        lease_token=NULL,lease_expires_at=NULL
    WHERE updated_fulfillment.order_id=p_order_id;
    UPDATE public.analysis_preflights AS updated_preflight
    SET consumed_request_id=p_lease_token
    WHERE updated_preflight.id=v_preflight.id;
    INSERT INTO public.analysis_pipeline_jobs(
        request_id,job_key,status,dispatch_state,dispatch_generation
    ) VALUES (
        p_lease_token,'coordinator:bootstrap','pending','pending',0
    );
    RETURN QUERY SELECT p_order_id,'analysis_in_progress'::TEXT,
        p_lease_token,TRUE,'coordinator:bootstrap'::TEXT;
END;
$$;
REVOKE ALL ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID,UUID,BIGINT
) FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    UUID,UUID,BIGINT
) TO service_role;
`;

async function seedIncident(pool: Pool): Promise<Incident> {
    const incident = Object.freeze({
        userId: randomUUID(),
        orderId: randomUUID(),
        preflightId: randomUUID(),
    });
    const cards = {
        basic: {
            launchStatus: 'production',selectionState: 'required',
            relationshipCapacity: { followers: 500, following: 500 },
        },
    };
    await pool.query('INSERT INTO public.users(id) VALUES ($1)', [incident.userId]);
    await pool.query(
        `INSERT INTO public.analysis_preflights(
            id,user_id,target_instagram_id,target_followers_count,target_following_count,
            target_is_private,status,access_mode,consumed_request_id,exclusion_decision,
            launch_status_snapshot,plan_catalog_snapshot,plan_cards_snapshot,
            pricing_snapshot,policy_versions_snapshot,capacity_required_plan_id,
            required_plan_id,admission_status,admission_generation,
            admission_selected_plan_id,admission_requested_at,admission_refreshed_at,
            admission_target_followers_count,admission_target_following_count,
            admission_capacity_required_plan_id,admission_required_plan_id,
            admission_plan_cards_snapshot,order_scoped_apify_credential_slot
        ) VALUES ($1,$2,'incident_target',158,361,FALSE,'ready','production',NULL,
            'skip','{}','{}',$3,'{}','{}','basic','basic','ready',3,'basic',$4,$5,
            158,362,'basic','basic',$3,'tertiary')`,
        [incident.preflightId, incident.userId, cards, ADMISSION_REQUESTED_AT, ADMISSION_REFRESHED_AT],
    );
    await pool.query(
        `INSERT INTO public.earlybird_orders(
            id,user_id,preflight_id,target_instagram_id,target_followers_count,
            target_following_count,exclusion_decision,plan_id,pricing_version,status,payment_id,
            expected_groble_product_id,actual_groble_product_id,expected_amount_krw,
            actual_amount_krw,paid_at,seller_reference_confirmed_at,result_request_id,
            concierge_apify_credential_slot
        ) VALUES ($1,$2,$3,'incident_target',158,361,'skip','basic',
            'earlybird-2026-08-v3','paid','opaque-payment','basic-product',
            'basic-product',990,990,$4,$4,NULL,'tertiary')`,
        [incident.orderId, incident.userId, incident.preflightId, PAID_AT],
    );
    await pool.query(
        `INSERT INTO public.earlybird_fulfillments(
            order_id,status,request_id,lease_token,lease_expires_at,next_attempt_at,
            attempt_count,operator_admitted_at,last_error_code,last_error_at,manual_review_at
        ) VALUES ($1,'manual_review',NULL,NULL,NULL,$2,1,$2,
            'SNAPSHOT_CONFLICT',$2,$2)`,
        [incident.orderId, MANUAL_REVIEW_AT],
    );
    await pool.query(
        `INSERT INTO public.analysis_preflight_provider_runs(
            preflight_id,operation_key,input_hash,logical_provider,actor_id,
            credential_slot,status,run_id,reserved_at,run_started_at,terminalized_at,
            actual_usage_usd,usage_reconciled_at,reusable_profile_schema_version
        ) SELECT $1,'target-profile-fresh-admission:g' || generation,$2,'apify',
            'apify/instagram-profile-scraper','tertiary','succeeded',
            'opaqueRun0' || generation,$3,$3,$4,0.001,$4,1
          FROM pg_catalog.generate_series(1,3) AS generation`,
        [incident.preflightId, 'a'.repeat(64), ADMISSION_REQUESTED_AT, ADMISSION_REFRESHED_AT],
    );
    return incident;
}

async function runAsService(client: PoolClient, incident: Incident) {
    await client.query('BEGIN');
    try {
        await client.query('SET LOCAL ROLE service_role');
        await client.query("SET LOCAL lock_timeout='5s'");
        const result = await client.query<{ applied: boolean; fulfillment_status: string }>(
            `SELECT * FROM public.recover_earlybird_concierge_snapshot_conflict(
                $1,$2,$3,$4,$5
            )`,
            [
                incident.orderId,
                incident.preflightId,
                MANUAL_REVIEW_AT,
                ADMISSION_REFRESHED_AT,
                TARGET_INPUT_HASH,
            ],
        );
        await client.query('COMMIT');
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

async function runCreateAsService(client: PoolClient, incident: Incident) {
    await client.query('BEGIN');
    try {
        await client.query('SET LOCAL ROLE service_role');
        await client.query("SET LOCAL lock_timeout='5s'");
        const result = await client.query<{ fulfillment_status: string }>(
            `SELECT fulfillment_status
             FROM public.create_or_replay_earlybird_fulfillment_request(
                $1,$2,1
             )`,
            [incident.orderId, randomUUID()],
        );
        await client.query('COMMIT');
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

async function markLocalJobAsService(client: PoolClient, input: {
    orderId: string;
    requestId: string;
    dispatchToken: string;
}) {
    await client.query('BEGIN');
    try {
        await client.query('SET LOCAL ROLE service_role');
        await client.query("SET LOCAL lock_timeout='5s'");
        const result = await client.query<{ marked: boolean }>(
            `SELECT public.mark_earlybird_concierge_snapshot_recovery_job_local(
                $1,$2,'coordinator:bootstrap',1,$3
             ) AS marked`,
            [input.orderId, input.requestId, input.dispatchToken],
        );
        await client.query('COMMIT');
        return result.rows[0]?.marked;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

async function createRecoveryRequestAsService(
    client: PoolClient,
    incident: Incident,
) {
    const leaseToken = randomUUID();
    await client.query('BEGIN');
    try {
        await client.query('SET LOCAL ROLE service_role');
        await client.query("SET LOCAL lock_timeout='5s'");
        const result = await client.query<{ request_id: string }>(
            `SELECT request_id
             FROM public.create_earlybird_concierge_snapshot_recovery_request(
                $1,$2,$3
             )`,
            [incident.orderId, incident.preflightId, leaseToken],
        );
        await client.query('COMMIT');
        return result.rows[0]?.request_id;
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    }
}

async function waitForBackendLock(pool: Pool, backendPid: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await pool.query<{ waiting: boolean }>(
            `SELECT wait_event_type = 'Lock' AS waiting
             FROM pg_catalog.pg_stat_activity
             WHERE pid = $1`,
            [backendPid],
        );
        if (state.rows[0]?.waiting) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('request wrapper did not reach the expected row lock');
}

describePostgres('concierge snapshot-conflict recovery on real PostgreSQL', () => {
    let pool: Pool;

    beforeAll(async () => {
        if (!isSafeConciergeRecoveryPostgresTarget(databaseUrl, destructiveMarker)) {
            throw new Error('Refusing destructive PostgreSQL recovery test target.');
        }
        pool = new Pool({ connectionString: databaseUrl, max: 8 });
        const identity = await pool.query<{ name: string }>(
            'SELECT pg_catalog.current_database() AS name',
        );
        if (identity.rows[0]?.name !== 'concierge_snapshot_recovery_test') {
            throw new Error('Refusing unexpected PostgreSQL recovery test database.');
        }
        await pool.query(bootstrap);
        await pool.query(migration);
    }, 30_000);

    beforeEach(async () => {
        await pool.query(`
            TRUNCATE public.earlybird_concierge_snapshot_conflict_recoveries,
                public.analysis_pipeline_jobs,public.analysis_preflight_provider_runs,
                public.earlybird_webhook_events,
                public.earlybird_fulfillments,public.earlybird_orders,
                public.analysis_requests,public.analysis_preflights,public.users CASCADE;
        `);
    });

    afterAll(async () => pool?.end());

    it('serializes concurrent calls into one apply and one replay', async () => {
        const incident = await seedIncident(pool);
        const first = await pool.connect();
        const second = await pool.connect();
        try {
            const [left, right] = await Promise.all([
                runAsService(first, incident),
                runAsService(second, incident),
            ]);
            expect([left.applied, right.applied].sort()).toEqual([false, true]);
            expect(left.fulfillment_status).toBe('retryable_failure');
            expect(right.fulfillment_status).toBe('retryable_failure');
            const persisted = await pool.query<{
                order_following: number;
                preflight_following: number;
                receipts: number;
            }>(
                `SELECT o.target_following_count AS order_following,
                        p.target_following_count AS preflight_following,
                        (SELECT count(*)::INTEGER
                         FROM public.earlybird_concierge_snapshot_conflict_recoveries) AS receipts
                 FROM public.earlybird_orders o
                 JOIN public.analysis_preflights p ON p.id=o.preflight_id
                 WHERE o.id=$1`,
                [incident.orderId],
            );
            expect(persisted.rows).toEqual([{
                order_following: 361,
                preflight_following: 361,
                receipts: 1,
            }]);
            await first.query('BEGIN');
            await first.query('SET LOCAL ROLE service_role');
            const authorized = await first.query<{ fulfillment_status: string }>(
                `SELECT fulfillment_status
                 FROM public.create_or_replay_earlybird_fulfillment_request(
                    $1,$2,1
                 )`,
                [incident.orderId, randomUUID()],
            );
            await first.query('COMMIT');
            expect(authorized.rows).toEqual([{
                fulfillment_status: 'analysis_in_progress',
            }]);
        } finally {
            await first.query('ROLLBACK').catch(() => undefined);
            first.release();
            second.release();
        }
    });

    it('does not deadlock against concurrent request creation and replays deterministically', async () => {
        const incident = await seedIncident(pool);
        const blocker = await pool.connect();
        const recoverer = await pool.connect();
        const creator = await pool.connect();
        try {
            await blocker.query('BEGIN');
            await blocker.query(
                'SELECT 1 FROM public.earlybird_fulfillments WHERE order_id=$1 FOR UPDATE',
                [incident.orderId],
            );
            const recoveryPending = runAsService(recoverer, incident);
            const creationPending = runCreateAsService(creator, incident);
            await blocker.query('COMMIT');
            const [recovery, creation] = await Promise.all([
                recoveryPending,
                creationPending,
            ]);
            expect(recovery).toEqual({
                applied: true,
                fulfillment_status: 'retryable_failure',
            });
            expect(['retryable_failure', 'analysis_in_progress']).toContain(
                creation?.fulfillment_status,
            );
            await expect(runCreateAsService(creator, incident)).resolves.toEqual({
                fulfillment_status: 'analysis_in_progress',
            });
        } finally {
            await blocker.query('ROLLBACK').catch(() => undefined);
            blocker.release();
            recoverer.release();
            creator.release();
        }
    });

    it('rolls back all writes when the fulfillment CAS races with recovery', async () => {
        const incident = await seedIncident(pool);
        const locker = await pool.connect();
        const recoverer = await pool.connect();
        try {
            await locker.query('BEGIN');
            await locker.query(
                'SELECT 1 FROM public.earlybird_fulfillments WHERE order_id=$1 FOR UPDATE',
                [incident.orderId],
            );
            const pending = runAsService(recoverer, incident);
            await locker.query(
                `UPDATE public.earlybird_fulfillments
                 SET manual_review_at=manual_review_at+INTERVAL '1 second'
                 WHERE order_id=$1`,
                [incident.orderId],
            );
            await locker.query('COMMIT');
            await expect(pending).rejects.toThrow(/CONCIERGE_SNAPSHOT_RECOVERY_CAS_MISMATCH/);
            const persisted = await pool.query<{
                order_following: number;
                preflight_following: number;
                receipts: number;
            }>(
                `SELECT o.target_following_count AS order_following,
                        p.target_following_count AS preflight_following,
                        (SELECT count(*)::INTEGER
                         FROM public.earlybird_concierge_snapshot_conflict_recoveries) AS receipts
                 FROM public.earlybird_orders o
                 JOIN public.analysis_preflights p ON p.id=o.preflight_id
                 WHERE o.id=$1`,
                [incident.orderId],
            );
            expect(persisted.rows).toEqual([{
                order_following: 361,
                preflight_following: 361,
                receipts: 0,
            }]);
        } finally {
            await locker.query('ROLLBACK').catch(() => undefined);
            locker.release();
            recoverer.release();
        }
    });

    it('serializes with a concurrent refund and leaves the order unrecovered', async () => {
        const incident = await seedIncident(pool);
        const refunder = await pool.connect();
        const recoverer = await pool.connect();
        try {
            await refunder.query('BEGIN');
            await refunder.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended('opaque-payment',0)
                )`,
            );
            const pending = runAsService(recoverer, incident);
            await refunder.query(
                `INSERT INTO public.earlybird_webhook_events(
                    event_id,event_type,payment_id
                 ) VALUES ('concurrent-refund','payment.refunded','opaque-payment')`,
            );
            await refunder.query('COMMIT');
            await expect(pending).rejects.toThrow(/CONCIERGE_SNAPSHOT_RECOVERY_REFUNDED/);
            const persisted = await pool.query<{ receipts: number; status: string }>(
                `SELECT (SELECT count(*)::INTEGER
                         FROM public.earlybird_concierge_snapshot_conflict_recoveries) AS receipts,
                        status
                 FROM public.earlybird_fulfillments
                 WHERE order_id=$1`,
                [incident.orderId],
            );
            expect(persisted.rows).toEqual([{
                receipts: 0,
                status: 'manual_review',
            }]);
        } finally {
            await refunder.query('ROLLBACK').catch(() => undefined);
            refunder.release();
            recoverer.release();
        }
    });

    it('fails closed on replay after the exact provider lineage changes', async () => {
        const incident = await seedIncident(pool);
        const client = await pool.connect();
        try {
            await expect(runAsService(client, incident)).resolves.toMatchObject({
                applied: true,
            });
            await pool.query(
                `UPDATE public.analysis_preflight_provider_runs
                 SET credential_slot='secondary'
                 WHERE preflight_id=$1
                   AND operation_key='target-profile-fresh-admission:g2'`,
                [incident.preflightId],
            );
            await expect(runAsService(client, incident)).rejects.toThrow(
                /CONCIERGE_SNAPSHOT_RECOVERY_REPLAY_CONFLICT/,
            );
        } finally {
            client.release();
        }
    });

    it('fails closed on replay after a refund', async () => {
        const incident = await seedIncident(pool);
        const client = await pool.connect();
        try {
            await expect(runAsService(client, incident)).resolves.toMatchObject({
                applied: true,
            });
            await pool.query(
                `INSERT INTO public.earlybird_webhook_events(
                    event_id,event_type,payment_id
                 ) VALUES ('refund-after-recovery','payment.refunded','opaque-payment')`,
            );
            await expect(runAsService(client, incident)).rejects.toThrow(
                /CONCIERGE_SNAPSHOT_RECOVERY_REPLAY_CONFLICT/,
            );
        } finally {
            client.release();
        }
    });

    it('marks one receipt-bound local job, replays its CAS, and rejects cross-order use', async () => {
        const incident = await seedIncident(pool);
        const service = await pool.connect();
        const requestId = randomUUID();
        const dispatchToken = randomUUID();
        try {
            await expect(runAsService(service, incident)).resolves.toMatchObject({
                applied: true,
            });
            await pool.query(
                `INSERT INTO public.analysis_requests(
                    id,user_id,preflight_id,status,pipeline_version
                 ) VALUES ($1,$2,$3,'pending','v2')`,
                [requestId, incident.userId, incident.preflightId],
            );
            await pool.query(
                `UPDATE public.earlybird_orders
                 SET status='analysis_in_progress',result_request_id=$1
                 WHERE id=$2`,
                [requestId, incident.orderId],
            );
            await pool.query(
                `UPDATE public.earlybird_fulfillments
                 SET status='analysis_in_progress',request_id=$1
                 WHERE order_id=$2`,
                [requestId, incident.orderId],
            );
            await pool.query(
                `UPDATE public.analysis_preflights
                 SET consumed_request_id=$1 WHERE id=$2`,
                [requestId, incident.preflightId],
            );
            await pool.query(
                `INSERT INTO public.analysis_pipeline_jobs(
                    request_id,job_key,status,dispatch_state,dispatch_generation,
                    dispatch_reservation_token
                 ) VALUES ($1,'coordinator:bootstrap','pending','reserved',1,$2)`,
                [requestId, dispatchToken],
            );

            await expect(markLocalJobAsService(service, {
                orderId: incident.orderId,
                requestId,
                dispatchToken,
            })).resolves.toBe(true);
            await expect(markLocalJobAsService(service, {
                orderId: incident.orderId,
                requestId,
                dispatchToken,
            })).resolves.toBe(false);
            await expect(markLocalJobAsService(service, {
                orderId: randomUUID(),
                requestId,
                dispatchToken,
            })).rejects.toThrow(/CONCIERGE_SNAPSHOT_LOCAL_JOB_CONFLICT/);

            const job = await pool.query<{
                dispatch_state: string;
                dispatch_task_name: string;
            }>(
                `SELECT dispatch_state,dispatch_task_name
                 FROM public.analysis_pipeline_jobs
                 WHERE request_id=$1 AND job_key='coordinator:bootstrap'`,
                [requestId],
            );
            expect(job.rows[0]?.dispatch_state).toBe('enqueued');
            expect(job.rows[0]?.dispatch_task_name).toMatch(
                /^manual-local\/concierge-snapshot-conflict\/[a-f0-9]{32}\/g1$/,
            );
            expect(job.rows[0]?.dispatch_task_name).not.toContain(requestId);
            const sharedRecovery = await service.query(
                'SELECT * FROM public.list_analysis_v2_dispatchable_jobs(100)',
            );
            expect(sharedRecovery.rows).toEqual([]);

            await pool.query(
                "UPDATE public.analysis_requests SET status='completed' WHERE id=$1",
                [requestId],
            );
            await pool.query(
                "UPDATE public.analysis_pipeline_jobs SET status='completed' WHERE request_id=$1",
                [requestId],
            );
            await service.query('BEGIN');
            await service.query('SET LOCAL ROLE service_role');
            const completed = await service.query<{ completed: boolean }>(
                `SELECT public.complete_earlybird_concierge_snapshot_recovery(
                    $1,$2,$3
                 ) AS completed`,
                [incident.orderId, incident.preflightId, requestId],
            );
            const replayed = await service.query<{ completed: boolean }>(
                `SELECT public.complete_earlybird_concierge_snapshot_recovery(
                    $1,$2,$3
                 ) AS completed`,
                [incident.orderId, incident.preflightId, requestId],
            );
            await service.query('COMMIT');
            expect(completed.rows).toEqual([{ completed: true }]);
            expect(replayed.rows).toEqual([{ completed: false }]);
        } finally {
            await service.query('ROLLBACK').catch(() => undefined);
            service.release();
        }
    });

    it('atomically claims and creates the receipt-bound stale request', async () => {
        const incident = await seedIncident(pool);
        const service = await pool.connect();
        const leaseToken = randomUUID();
        try {
            await expect(runAsService(service, incident)).resolves.toMatchObject({
                applied: true,
            });
            await service.query('BEGIN');
            await service.query('SET LOCAL ROLE service_role');
            const inspection = await service.query<{
                recovered: boolean;
                request_id: string | null;
            }>(
                `SELECT recovered,request_id
                 FROM public.inspect_earlybird_concierge_snapshot_recovery_execution(
                    $1,$2,$3,$4
                 )`,
                [
                    incident.orderId,
                    incident.preflightId,
                    MANUAL_REVIEW_AT,
                    ADMISSION_REFRESHED_AT,
                ],
            );
            const created = await service.query<{ request_id: string }>(
                `SELECT request_id
                 FROM public.create_earlybird_concierge_snapshot_recovery_request(
                    $1,$2,$3
                 )`,
                [incident.orderId, incident.preflightId, leaseToken],
            );
            await service.query('COMMIT');
            expect(inspection.rows).toEqual([{ recovered: true, request_id: null }]);
            expect(created.rows).toEqual([{ request_id: leaseToken }]);
        } finally {
            await service.query('ROLLBACK').catch(() => undefined);
            service.release();
        }
    });

    it('locks fulfillment before order when racing normal fulfillment work', async () => {
        const incident = await seedIncident(pool);
        const service = await pool.connect();
        const blocker = await pool.connect();
        try {
            await expect(runAsService(service, incident)).resolves.toMatchObject({
                applied: true,
            });
            const backend = await service.query<{ pid: number }>(
                'SELECT pg_catalog.pg_backend_pid() AS pid',
            );
            await blocker.query('BEGIN');
            await blocker.query("SET LOCAL lock_timeout='2s'");
            await blocker.query(
                'SELECT 1 FROM public.earlybird_fulfillments WHERE order_id=$1 FOR UPDATE',
                [incident.orderId],
            );
            const pending = createRecoveryRequestAsService(service, incident);
            await waitForBackendLock(pool, backend.rows[0]!.pid);
            await expect(blocker.query(
                'SELECT 1 FROM public.earlybird_orders WHERE id=$1 FOR UPDATE',
                [incident.orderId],
            )).resolves.toBeDefined();
            await blocker.query('COMMIT');
            await expect(pending).resolves.toBeTruthy();
        } finally {
            await blocker.query('ROLLBACK').catch(() => undefined);
            await service.query('ROLLBACK').catch(() => undefined);
            service.release();
            blocker.release();
        }
    });

    it('serializes exact request creation behind a concurrent refund', async () => {
        const incident = await seedIncident(pool);
        const service = await pool.connect();
        const refunder = await pool.connect();
        try {
            await expect(runAsService(service, incident)).resolves.toMatchObject({
                applied: true,
            });
            await refunder.query('BEGIN');
            await refunder.query(
                `SELECT pg_catalog.pg_advisory_xact_lock(
                    pg_catalog.hashtextextended('opaque-payment',0)
                )`,
            );
            const pending = createRecoveryRequestAsService(service, incident);
            await refunder.query(
                `INSERT INTO public.earlybird_webhook_events(
                    event_id,event_type,payment_id
                 ) VALUES ('request-race-refund','payment.refunded','opaque-payment')`,
            );
            await refunder.query('COMMIT');
            await expect(pending).rejects.toThrow(/CONCIERGE_SNAPSHOT_REQUEST_CONFLICT/);
            const requests = await pool.query<{ count: number }>(
                'SELECT count(*)::INTEGER AS count FROM public.analysis_requests',
            );
            expect(requests.rows).toEqual([{ count: 0 }]);
        } finally {
            await refunder.query('ROLLBACK').catch(() => undefined);
            service.release();
            refunder.release();
        }
    });
});
