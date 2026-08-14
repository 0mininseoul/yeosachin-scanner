import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260813233100_recover_concierge_snapshot_conflict.sql',
    import.meta.url,
), 'utf8');
const completionPrecheckMigration = readFileSync(new URL(
    '../../../supabase/migrations/20260814000854_concierge_snapshot_completion_precheck_rpc.sql',
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

let db: PGlite;

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;

CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(
    version TEXT PRIMARY KEY
);
INSERT INTO supabase_migrations.schema_migrations(version)
VALUES ('20260813221946')
ON CONFLICT (version) DO NOTHING;

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
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    preflight_id UUID,
    status TEXT NOT NULL,
    pipeline_version TEXT NOT NULL DEFAULT 'v2'
);
CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    target_instagram_id TEXT NOT NULL,
    target_input_hash TEXT,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    target_is_private BOOLEAN,
    status TEXT NOT NULL,
    access_mode TEXT NOT NULL,
    consumed_request_id UUID,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id TEXT,
    launch_status_snapshot JSONB NOT NULL,
    plan_catalog_snapshot JSONB NOT NULL,
    plan_cards_snapshot JSONB NOT NULL,
    pricing_snapshot JSONB NOT NULL,
    policy_versions_snapshot JSONB NOT NULL,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    admission_status TEXT NOT NULL,
    admission_generation INTEGER NOT NULL,
    admission_selected_plan_id TEXT,
    admission_requested_at TIMESTAMPTZ,
    admission_refreshed_at TIMESTAMPTZ,
    admission_target_followers_count INTEGER,
    admission_target_following_count INTEGER,
    admission_capacity_required_plan_id TEXT,
    admission_required_plan_id TEXT,
    admission_plan_cards_snapshot JSONB,
    order_scoped_apify_credential_slot TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
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
    pricing_version TEXT NOT NULL,
    status TEXT NOT NULL,
    payment_id TEXT,
    expected_groble_product_id TEXT,
    actual_groble_product_id TEXT,
    expected_amount_krw INTEGER,
    actual_amount_krw INTEGER,
    paid_at TIMESTAMPTZ,
    seller_reference_confirmed_at TIMESTAMPTZ,
    result_request_id UUID,
    concierge_apify_credential_slot TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.earlybird_fulfillments (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    status TEXT NOT NULL,
    request_id UUID,
    lease_fence BIGINT NOT NULL DEFAULT 0,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ NOT NULL,
    attempt_count INTEGER NOT NULL,
    operator_admitted_at TIMESTAMPTZ,
    last_error_code TEXT,
    last_error_at TIMESTAMPTZ,
    manual_review_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp()
);
CREATE TABLE public.earlybird_webhook_events (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    payment_id TEXT NOT NULL
);
CREATE TABLE public.analysis_preflight_provider_runs (
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    operation_key TEXT NOT NULL,
    input_hash TEXT NOT NULL,
    logical_provider TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    credential_slot TEXT NOT NULL,
    status TEXT NOT NULL,
    run_id TEXT,
    reserved_at TIMESTAMPTZ NOT NULL,
    run_started_at TIMESTAMPTZ,
    terminalized_at TIMESTAMPTZ,
    actual_usage_usd NUMERIC,
    usage_reconciled_at TIMESTAMPTZ,
    reusable_profile_schema_version INTEGER,
    PRIMARY KEY (preflight_id, operation_key)
);
CREATE TABLE public.analysis_pipeline_jobs (
    request_id UUID NOT NULL REFERENCES public.analysis_requests(id),
    job_key TEXT NOT NULL,
    status TEXT NOT NULL,
    dispatch_state TEXT NOT NULL,
    dispatch_generation INTEGER NOT NULL,
    dispatch_reservation_token UUID,
    dispatch_reserved_at TIMESTAMPTZ,
    dispatched_at TIMESTAMPTZ,
    dispatch_task_name TEXT,
    lease_expires_at TIMESTAMPTZ,
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

async function seedIncident(): Promise<Incident> {
    const incident = Object.freeze({
        userId: randomUUID(),
        orderId: randomUUID(),
        preflightId: randomUUID(),
    });
    const cards = JSON.stringify({
        basic: {
            launchStatus: 'production',
            selectionState: 'required',
            relationshipCapacity: { followers: 500, following: 500 },
        },
    });
    await db.query('INSERT INTO public.users(id) VALUES ($1)', [incident.userId]);
    await db.query(
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
        ) VALUES (
            $1,$2,'incident_target',158,361,FALSE,'ready','production',NULL,'skip',
            '{}'::JSONB,'{}'::JSONB,$3::JSONB,'{}'::JSONB,'{}'::JSONB,
            'basic','basic','ready',3,'basic',$4,$5,158,362,'basic','basic',$3::JSONB,'tertiary'
        )`,
        [
            incident.preflightId,
            incident.userId,
            cards,
            ADMISSION_REQUESTED_AT,
            ADMISSION_REFRESHED_AT,
        ],
    );
    await db.query(
        `INSERT INTO public.earlybird_orders(
            id,user_id,preflight_id,target_instagram_id,target_followers_count,
            target_following_count,exclusion_decision,plan_id,pricing_version,status,payment_id,
            expected_groble_product_id,actual_groble_product_id,expected_amount_krw,
            actual_amount_krw,paid_at,seller_reference_confirmed_at,result_request_id,
            concierge_apify_credential_slot
        ) VALUES (
            $1,$2,$3,'incident_target',158,361,'skip','basic','earlybird-2026-08-v3',
            'paid','opaque-payment','basic-product','basic-product',990,990,$4,$4,NULL,'tertiary'
        )`,
        [incident.orderId, incident.userId, incident.preflightId, PAID_AT],
    );
    await db.query(
        `INSERT INTO public.earlybird_fulfillments(
            order_id,status,request_id,lease_token,lease_expires_at,next_attempt_at,
            attempt_count,operator_admitted_at,last_error_code,last_error_at,manual_review_at
        ) VALUES (
            $1,'manual_review',NULL,NULL,NULL,$2,1,$2,'SNAPSHOT_CONFLICT',$2,$2
        )`,
        [incident.orderId, MANUAL_REVIEW_AT],
    );
    await db.query(
        `INSERT INTO public.analysis_preflight_provider_runs(
            preflight_id,operation_key,input_hash,logical_provider,actor_id,
            credential_slot,status,run_id,reserved_at,run_started_at,terminalized_at,
            actual_usage_usd,usage_reconciled_at,reusable_profile_schema_version
        ) SELECT
            $1,'target-profile-fresh-admission:g' || generation,$2,'apify',
            'apify/instagram-profile-scraper','tertiary','succeeded',
            'opaqueRun0' || generation,$3,$3,$4,0.001,$4,1
          FROM pg_catalog.generate_series(1,3) AS generation`,
        [incident.preflightId, 'a'.repeat(64), ADMISSION_REQUESTED_AT, ADMISSION_REFRESHED_AT],
    );
    return incident;
}

async function recover(
    incident: Incident,
    serverTargetInputHash = TARGET_INPUT_HASH,
) {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<{ applied: boolean; fulfillment_status: string }>(
            `SELECT * FROM public.recover_earlybird_concierge_snapshot_conflict(
                $1,$2,$3,$4,$5
            )`,
            [
                incident.orderId,
                incident.preflightId,
                MANUAL_REVIEW_AT,
                ADMISSION_REFRESHED_AT,
                serverTargetInputHash,
            ],
        );
    } finally {
        await db.exec('RESET ROLE');
    }
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(bootstrap);
    await db.exec(migration);
    await db.exec(`
        INSERT INTO supabase_migrations.schema_migrations(version)
        VALUES ('20260813233100')
        ON CONFLICT (version) DO NOTHING;
    `);
    await db.exec(completionPrecheckMigration);
}, 30_000);

beforeEach(async () => {
    await db.exec(`
        TRUNCATE public.earlybird_concierge_snapshot_conflict_recoveries,
            public.analysis_pipeline_jobs,public.analysis_preflight_provider_runs,
            public.earlybird_webhook_events,
            public.earlybird_fulfillments,public.earlybird_orders,
            public.analysis_requests,public.analysis_preflights,public.users CASCADE;
    `);
});

afterAll(async () => db.close());

describe('concierge snapshot-conflict recovery in PGlite', () => {
    it('scopes completion precheck jobs to the exact preflight instead of global active work', async () => {
        const incident = await seedIncident();
        const unrelated = await seedIncident();
        const unrelatedRequestId = randomUUID();
        await db.query(
            `INSERT INTO public.analysis_requests(id,user_id,preflight_id,status)
             VALUES ($1,$2,$3,'processing')`,
            [unrelatedRequestId, unrelated.userId, unrelated.preflightId],
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id,job_key,status,dispatch_state,dispatch_generation
             ) VALUES ($1,'coordinator:bootstrap','processing','delivered',1)`,
            [unrelatedRequestId],
        );

        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query<{ payload: {
                active_request_count: number;
                active_job_count: number;
                provider_runs: Array<{ operation_key: string }>;
                fulfillment: { status: string };
            } }>(
                `SELECT public.inspect_earlybird_concierge_snapshot_conflict_precheck(
                    $1,$2,$3,$4,NULL
                 ) AS payload`,
                [incident.orderId, incident.preflightId, MANUAL_REVIEW_AT, ADMISSION_REFRESHED_AT],
            )).resolves.toMatchObject({
                rows: [{
                    payload: {
                        active_request_count: 0,
                        active_job_count: 0,
                        fulfillment: { status: 'manual_review' },
                        provider_runs: expect.arrayContaining([
                            expect.objectContaining({ operation_key: 'target-profile-fresh-admission:g1' }),
                            expect.objectContaining({ operation_key: 'target-profile-fresh-admission:g2' }),
                            expect.objectContaining({ operation_key: 'target-profile-fresh-admission:g3' }),
                        ]),
                    },
                }],
            });
        } finally {
            await db.exec('RESET ROLE');
        }

        const samePreflightRequestId = randomUUID();
        await db.query(
            `INSERT INTO public.analysis_requests(id,user_id,preflight_id,status)
             VALUES ($1,$2,$3,'processing')`,
            [samePreflightRequestId, incident.userId, incident.preflightId],
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id,job_key,status,dispatch_state,dispatch_generation
             ) VALUES ($1,'coordinator:bootstrap','processing','delivered',1)`,
            [samePreflightRequestId],
        );
        await db.exec('SET ROLE service_role');
        try {
            const scoped = await db.query<{ payload: {
                active_request_count: number;
                active_job_count: number;
            } }>(
                `SELECT public.inspect_earlybird_concierge_snapshot_conflict_precheck(
                    $1,$2,$3,$4,NULL
                 ) AS payload`,
                [incident.orderId, incident.preflightId, MANUAL_REVIEW_AT, ADMISSION_REFRESHED_AT],
            );
            expect(scoped.rows).toMatchObject([{
                payload: { active_request_count: 1, active_job_count: 1 },
            }]);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('keeps the private ledgers RPC-only for service_role and RPC-only for public roles', async () => {
        const incident = await seedIncident();
        for (const role of ['anon', 'authenticated']) {
            await db.exec(`SET ROLE ${role}`);
            try {
                await expect(db.query(
                    `SELECT public.inspect_earlybird_concierge_snapshot_conflict_precheck(
                        $1,$2,$3,$4,NULL
                     )`,
                    [incident.orderId, incident.preflightId, MANUAL_REVIEW_AT, ADMISSION_REFRESHED_AT],
                )).rejects.toThrow(/permission denied/i);
            } finally {
                await db.exec('RESET ROLE');
            }
        }
        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query(
                'SELECT status FROM public.earlybird_fulfillments WHERE order_id=$1',
                [incident.orderId],
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                'SELECT operation_key FROM public.analysis_preflight_provider_runs WHERE preflight_id=$1',
                [incident.preflightId],
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('authorizes only the receipt-backed drift without rewriting either snapshot', async () => {
        const incident = await seedIncident();
        await expect(recover(incident)).resolves.toMatchObject({
            rows: [{ applied: true, fulfillment_status: 'retryable_failure' }],
        });

        const state = await db.query<{
            order_following: number;
            preflight_following: number;
            witness_following: number;
            fulfillment_status: string;
            last_error_code: string;
            reason: string;
            receipts: number;
        }>(
            `SELECT o.target_following_count AS order_following,
                    p.target_following_count AS preflight_following,
                    p.admission_target_following_count AS witness_following,
                    f.status AS fulfillment_status,f.last_error_code,
                    (SELECT recovery_reason
                     FROM public.earlybird_concierge_snapshot_conflict_recoveries) AS reason,
                    (SELECT count(*)::INTEGER
                     FROM public.earlybird_concierge_snapshot_conflict_recoveries) AS receipts
             FROM public.earlybird_orders o
             JOIN public.analysis_preflights p ON p.id=o.preflight_id
             JOIN public.earlybird_fulfillments f ON f.order_id=o.id
             WHERE o.id=$1`,
            [incident.orderId],
        );
        expect(state.rows).toEqual([{
            order_following: 361,
            preflight_following: 361,
            witness_following: 362,
            fulfillment_status: 'retryable_failure',
            last_error_code: 'CONCIERGE_SNAPSHOT_CONFLICT_RECOVERY',
            reason: 'bounded_time_snapshot_drift',
            receipts: 1,
        }]);
        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query<{ fulfillment_status: string }>(
                `SELECT fulfillment_status
                 FROM public.create_or_replay_earlybird_fulfillment_request(
                    $1,$2,1
                 )`,
                [incident.orderId, randomUUID()],
            )).resolves.toMatchObject({
                rows: [{ fulfillment_status: 'analysis_in_progress' }],
            });
        } finally {
            await db.exec('RESET ROLE');
        }
        await expect(db.query(
            `UPDATE public.earlybird_concierge_snapshot_conflict_recoveries
             SET old_order_following_count=0 WHERE order_id=$1`,
            [incident.orderId],
        )).rejects.toThrow(/IMMUTABLE_RECOVERY_RECEIPT/);
    });

    it('replays the same compare-and-set without a second mutation or receipt', async () => {
        const incident = await seedIncident();
        await recover(incident);
        await expect(recover(incident)).resolves.toMatchObject({
            rows: [{ applied: false, fulfillment_status: 'retryable_failure' }],
        });
        const receipts = await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.earlybird_concierge_snapshot_conflict_recoveries',
        );
        expect(receipts.rows).toEqual([{ count: 1 }]);
    });

    it('fails closed when the server-derived target identity does not match the witness', async () => {
        const incident = await seedIncident();
        await expect(recover(incident, 'b'.repeat(64))).rejects.toThrow(
            /CONCIERGE_SNAPSHOT_RECOVERY_WITNESS_CONFLICT/,
        );
        const receipts = await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.earlybird_concierge_snapshot_conflict_recoveries',
        );
        expect(receipts.rows).toEqual([{ count: 0 }]);
    });

    it('does not consume or replay a receipt after admission provenance changes', async () => {
        const incident = await seedIncident();
        await recover(incident);
        await db.query(
            `UPDATE public.analysis_preflights
             SET admission_generation=4,
                 admission_refreshed_at=admission_refreshed_at+INTERVAL '1 second'
             WHERE id=$1`,
            [incident.preflightId],
        );
        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query<{ fulfillment_status: string }>(
                `SELECT fulfillment_status
                 FROM public.create_or_replay_earlybird_fulfillment_request(
                    $1,$2,1
                 )`,
                [incident.orderId, randomUUID()],
            )).resolves.toMatchObject({
                rows: [{ fulfillment_status: 'manual_review' }],
            });
            await expect(recover(incident)).rejects.toThrow(
                /CONCIERGE_SNAPSHOT_RECOVERY_REPLAY_CONFLICT/,
            );
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('does not consume or replay a receipt after provider provenance changes', async () => {
        const incident = await seedIncident();
        await recover(incident);
        await db.query(
            `UPDATE public.analysis_preflight_provider_runs
             SET status='failed'
             WHERE preflight_id=$1
               AND operation_key='target-profile-fresh-admission:g1'`,
            [incident.preflightId],
        );
        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query<{ fulfillment_status: string }>(
                `SELECT fulfillment_status
                 FROM public.create_or_replay_earlybird_fulfillment_request(
                    $1,$2,1
                 )`,
                [incident.orderId, randomUUID()],
            )).resolves.toMatchObject({
                rows: [{ fulfillment_status: 'manual_review' }],
            });
            await expect(recover(incident)).rejects.toThrow(
                /CONCIERGE_SNAPSHOT_RECOVERY_REPLAY_CONFLICT/,
            );
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it('does not replay a receipt after a refund', async () => {
        const incident = await seedIncident();
        await recover(incident);
        await db.query(
            `INSERT INTO public.earlybird_webhook_events
             VALUES ('refund-after-recovery','payment.refunded','opaque-payment')`,
        );
        await expect(recover(incident)).rejects.toThrow(
            /CONCIERGE_SNAPSHOT_RECOVERY_REPLAY_CONFLICT/,
        );
    });

    it('marks only a receipt-bound request job for incident-scoped local delivery', async () => {
        const incident = await seedIncident();
        await recover(incident);
        const requestId = randomUUID();
        const dispatchToken = randomUUID();
        await db.query(
            `INSERT INTO public.analysis_requests(id,user_id,preflight_id,status)
             VALUES ($1,$2,$3,'pending')`,
            [requestId, incident.userId, incident.preflightId],
        );
        await db.query(
            `UPDATE public.earlybird_orders
             SET status='analysis_in_progress',result_request_id=$1 WHERE id=$2`,
            [requestId, incident.orderId],
        );
        await db.query(
            `UPDATE public.earlybird_fulfillments
             SET status='analysis_in_progress',request_id=$1 WHERE order_id=$2`,
            [requestId, incident.orderId],
        );
        await db.query(
            `UPDATE public.analysis_preflights
             SET consumed_request_id=$1 WHERE id=$2`,
            [requestId, incident.preflightId],
        );
        await db.query(
            `INSERT INTO public.analysis_pipeline_jobs(
                request_id,job_key,status,dispatch_state,dispatch_generation,
                dispatch_reservation_token
             ) VALUES ($1,'coordinator:bootstrap','pending','reserved',1,$2)`,
            [requestId, dispatchToken],
        );
        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query<{ marked: boolean }>(
                `SELECT public.mark_earlybird_concierge_snapshot_recovery_job_local(
                    $1,$2,'coordinator:bootstrap',1,$3
                ) AS marked`,
                [incident.orderId, requestId, dispatchToken],
            )).resolves.toMatchObject({ rows: [{ marked: true }] });
        } finally {
            await db.exec('RESET ROLE');
        }
        const job = await db.query<{
            dispatch_state: string;
            dispatch_task_name: string;
        }>(
            `SELECT dispatch_state,dispatch_task_name
             FROM public.analysis_pipeline_jobs WHERE request_id=$1`,
            [requestId],
        );
        expect(job.rows[0]?.dispatch_state).toBe('enqueued');
        expect(job.rows[0]?.dispatch_task_name).toMatch(
            /^manual-local\/concierge-snapshot-conflict\/[a-f0-9]{32}\/g1$/,
        );
        expect(job.rows[0]?.dispatch_task_name).not.toContain(requestId);
        const sharedRecovery = await db.query(
            'SELECT * FROM public.list_analysis_v2_dispatchable_jobs(100)',
        );
        expect(sharedRecovery.rows).toEqual([]);

        await db.query(
            "UPDATE public.analysis_requests SET status='completed' WHERE id=$1",
            [requestId],
        );
        await db.query(
            "UPDATE public.analysis_pipeline_jobs SET status='completed' WHERE request_id=$1",
            [requestId],
        );
        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query<{ completed: boolean }>(
                `SELECT public.complete_earlybird_concierge_snapshot_recovery(
                    $1,$2,$3
                ) AS completed`,
                [incident.orderId, incident.preflightId, requestId],
            )).resolves.toMatchObject({ rows: [{ completed: true }] });
            await expect(db.query<{ completed: boolean }>(
                `SELECT public.complete_earlybird_concierge_snapshot_recovery(
                    $1,$2,$3
                ) AS completed`,
                [incident.orderId, incident.preflightId, requestId],
            )).resolves.toMatchObject({ rows: [{ completed: false }] });
        } finally {
            await db.exec('RESET ROLE');
        }
        const completed = await db.query<{ order_status: string; fulfillment_status: string }>(
            `SELECT earlybird_order.status AS order_status,
                    fulfillment.status AS fulfillment_status
             FROM public.earlybird_orders AS earlybird_order
             JOIN public.earlybird_fulfillments AS fulfillment
               ON fulfillment.order_id=earlybird_order.id
             WHERE earlybird_order.id=$1`,
            [incident.orderId],
        );
        expect(completed.rows).toEqual([{
            order_status: 'completed',
            fulfillment_status: 'completed',
        }]);
    });

    it('atomically claims and creates the receipt-bound request despite stale admission', async () => {
        const incident = await seedIncident();
        await recover(incident);
        const leaseToken = randomUUID();
        await db.exec('SET ROLE service_role');
        try {
            await expect(db.query<{ recovered: boolean; request_id: string | null }>(
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
            )).resolves.toMatchObject({
                rows: [{ recovered: true, request_id: null }],
            });
            await expect(db.query<{ request_id: string }>(
                `SELECT request_id
                 FROM public.create_earlybird_concierge_snapshot_recovery_request(
                    $1,$2,$3
                 )`,
                [incident.orderId, incident.preflightId, leaseToken],
            )).resolves.toMatchObject({ rows: [{ request_id: leaseToken }] });
        } finally {
            await db.exec('RESET ROLE');
        }
    });

    it.each([
        [100, 101, true],
        [100, 102, false],
        [1000, 1003, true],
        [1000, 1004, false],
        [0, 0, true],
        [0, 1, false],
    ])('enforces absolute-three and relative-one-percent for %i to %i', async (
        oldCount,
        newCount,
        expected,
    ) => {
        const result = await db.query<{ accepted: boolean }>(
            `SELECT public.earlybird_snapshot_count_drift_within_tolerance(
                $1,$2
            ) AS accepted`,
            [oldCount, newCount],
        );
        expect(result.rows).toEqual([{ accepted: expected }]);
    });

    it.each([
        {
            label: 'unpaid',
            sql: "UPDATE public.earlybird_orders SET status='refund_pending' WHERE id=$1",
            params: (incident: Incident) => [incident.orderId],
        },
        {
            label: 'refunded',
            sql: "INSERT INTO public.earlybird_webhook_events VALUES ('refund-event','payment.refunded','opaque-payment')",
            params: () => [],
        },
        {
            label: 'result exists',
            sql: 'UPDATE public.earlybird_orders SET result_request_id=$1 WHERE id=$2',
            params: (incident: Incident, requestId: string) => [requestId, incident.orderId],
        },
        {
            label: 'request exists',
            sql: 'UPDATE public.earlybird_fulfillments SET request_id=$1 WHERE order_id=$2',
            params: (incident: Incident, requestId: string) => [requestId, incident.orderId],
        },
        {
            label: 'not manual',
            sql: "UPDATE public.earlybird_fulfillments SET status='retryable_failure' WHERE order_id=$1",
            params: (incident: Incident) => [incident.orderId],
        },
        {
            label: 'old count drift',
            sql: 'UPDATE public.earlybird_orders SET target_following_count=360 WHERE id=$1',
            params: (incident: Incident) => [incident.orderId],
        },
        {
            label: 'witness drift',
            sql: 'UPDATE public.analysis_preflights SET admission_target_following_count=363 WHERE id=$1',
            params: (incident: Incident) => [incident.preflightId],
        },
        {
            label: 'slot drift',
            sql: "UPDATE public.analysis_preflight_provider_runs SET credential_slot='secondary' WHERE preflight_id=$1",
            params: (incident: Incident) => [incident.preflightId],
        },
        {
            label: 'provider not successful',
            sql: "UPDATE public.analysis_preflight_provider_runs SET status='failed' WHERE preflight_id=$1 AND operation_key='target-profile-fresh-admission:g3'",
            params: (incident: Incident) => [incident.preflightId],
        },
        {
            label: 'provider input identity drift',
            sql: "UPDATE public.analysis_preflight_provider_runs SET input_hash=$2 WHERE preflight_id=$1 AND operation_key='target-profile-fresh-admission:g1'",
            params: (incident: Incident) => [incident.preflightId, 'b'.repeat(64)],
        },
        {
            label: 'private transition',
            sql: 'UPDATE public.analysis_preflights SET target_is_private=TRUE WHERE id=$1',
            params: (incident: Incident) => [incident.preflightId],
        },
    ])('rejects $label without any partial mutation', async ({ sql, params }) => {
        const incident = await seedIncident();
        const unrelatedRequest = randomUUID();
        if (sql.includes('result_request_id') || sql.includes('request_id=$2')) {
            await db.query(
                `INSERT INTO public.analysis_requests(id,user_id,preflight_id,status)
                 VALUES ($1,$2,$3,'failed')`,
                [unrelatedRequest, incident.userId, incident.preflightId],
            );
        }
        await db.query(sql, params(incident, unrelatedRequest));
        await expect(recover(incident)).rejects.toThrow(/CONCIERGE_SNAPSHOT_RECOVERY_/);
        const receipts = await db.query<{ count: number }>(
            'SELECT count(*)::INTEGER AS count FROM public.earlybird_concierge_snapshot_conflict_recoveries',
        );
        expect(receipts.rows).toEqual([{ count: 0 }]);
    });

    it('rejects cross-order ambiguity and unrelated active work', async () => {
        const incident = await seedIncident();
        const second = await seedIncident();
        await expect(recover(incident)).rejects.toThrow(/CONCIERGE_SNAPSHOT_RECOVERY_IDENTITY_CONFLICT/);

        await db.query('DELETE FROM public.analysis_preflight_provider_runs WHERE preflight_id=$1', [second.preflightId]);
        await db.query('DELETE FROM public.earlybird_fulfillments WHERE order_id=$1', [second.orderId]);
        await db.query('DELETE FROM public.earlybird_orders WHERE id=$1', [second.orderId]);
        await db.query('DELETE FROM public.analysis_preflights WHERE id=$1', [second.preflightId]);
        await db.query('DELETE FROM public.users WHERE id=$1', [second.userId]);
        await db.query(
            `INSERT INTO public.analysis_requests(id,user_id,preflight_id,status)
             VALUES ($1,$2,$3,'processing')`,
            [randomUUID(), incident.userId, incident.preflightId],
        );
        await expect(recover(incident)).rejects.toThrow(/CONCIERGE_SNAPSHOT_RECOVERY_UNRELATED_WORK/);
    });

    it('denies anon and authenticated callers', async () => {
        const incident = await seedIncident();
        for (const role of ['anon', 'authenticated']) {
            await db.exec(`SET ROLE ${role}`);
            await expect(db.query(
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
            )).rejects.toThrow(/permission denied/i);
            await db.exec('RESET ROLE');
        }
    });
});
