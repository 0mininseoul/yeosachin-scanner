import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../../supabase/migrations/20260815140000_recover_exact_canary_generation_two_pending_idle.sql',
    import.meta.url,
), 'utf8');

const USER_ID = '10000000-0000-4000-8000-000000000001';
const ORDER_ID = '10000000-0000-4000-8000-000000000002';
const SOURCE_PREFLIGHT_ID = '10000000-0000-4000-8000-000000000003';
const CURRENT_PREFLIGHT_ID = '10000000-0000-4000-8000-000000000004';
const SOURCE_TOKEN = '10000000-0000-4000-8000-000000000005';
const CLAIM_TOKEN = '10000000-0000-4000-8000-000000000006';
const REQUEST_ID = '10000000-0000-4000-8000-000000000007';
const ADMISSION_HASH = 'a'.repeat(64);
const SNAPSHOT = JSON.stringify({ v: 1 });
const CARDS = JSON.stringify({ basic: { selectionState: 'required' } });

let db: PGlite;

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(version TEXT PRIMARY KEY);
INSERT INTO supabase_migrations.schema_migrations(version) VALUES ('20260815130000');
CREATE SCHEMA extensions;
CREATE FUNCTION extensions.digest(BYTEA, TEXT) RETURNS BYTEA
LANGUAGE sql IMMUTABLE AS $$ SELECT decode(repeat('aa', 32), 'hex') $$;
CREATE FUNCTION extensions.gen_random_uuid() RETURNS UUID
LANGUAGE sql VOLATILE AS $$ SELECT '${CLAIM_TOKEN}'::UUID $$;

CREATE TABLE public.users (id UUID PRIMARY KEY);
CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    idempotency_key TEXT NOT NULL,
    target_instagram_id TEXT NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id TEXT,
    access_mode TEXT NOT NULL,
    status TEXT NOT NULL,
    consumed_request_id UUID,
    launch_status_snapshot JSONB NOT NULL,
    plan_catalog_snapshot JSONB NOT NULL,
    pricing_version TEXT NOT NULL,
    pricing_snapshot JSONB NOT NULL,
    policy_versions_snapshot JSONB NOT NULL,
    target_followers_count INTEGER,
    target_following_count INTEGER,
    capacity_required_plan_id TEXT,
    required_plan_id TEXT,
    plan_cards_snapshot JSONB,
    admission_generation INTEGER NOT NULL,
    admission_status TEXT NOT NULL,
    admission_selected_plan_id TEXT,
    admission_entitlement_jti_hash TEXT,
    admission_token UUID,
    admission_requested_at TIMESTAMPTZ,
    admission_refreshed_at TIMESTAMPTZ,
    admission_target_followers_count INTEGER,
    admission_target_following_count INTEGER,
    admission_capacity_required_plan_id TEXT,
    admission_required_plan_id TEXT,
    admission_plan_cards_snapshot JSONB,
    admission_failure_count INTEGER NOT NULL DEFAULT 0,
    admission_last_error_code TEXT,
    admission_error_code TEXT,
    admission_dispatch_state TEXT NOT NULL,
    admission_dispatch_token UUID,
    admission_dispatch_reserved_at TIMESTAMPTZ,
    admission_dispatched_at TIMESTAMPTZ,
    admission_claim_token UUID,
    admission_lease_expires_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.earlybird_orders (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    status TEXT NOT NULL,
    seller_reference_confirmed_at TIMESTAMPTZ,
    payment_id TEXT,
    actual_amount_krw INTEGER,
    expected_amount_krw INTEGER,
    actual_groble_product_id TEXT,
    expected_groble_product_id TEXT,
    result_request_id UUID,
    target_instagram_id TEXT NOT NULL,
    target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id TEXT,
    plan_id TEXT NOT NULL
);
CREATE TABLE public.earlybird_fulfillments (
    order_id UUID PRIMARY KEY REFERENCES public.earlybird_orders(id),
    status TEXT NOT NULL,
    request_id UUID,
    lease_token UUID,
    lease_expires_at TIMESTAMPTZ,
    lease_fence BIGINT NOT NULL DEFAULT 0,
    last_error_code TEXT
);
CREATE TABLE public.earlybird_webhook_events (
    payment_id TEXT NOT NULL,
    event_type TEXT NOT NULL
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
    terminalized_at TIMESTAMPTZ,
    actual_usage_usd NUMERIC,
    usage_reconciled_at TIMESTAMPTZ,
    reusable_profile_schema_version INTEGER,
    PRIMARY KEY (preflight_id, operation_key)
);
CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    preflight_id UUID NOT NULL REFERENCES public.analysis_preflights(id),
    status TEXT NOT NULL
);

CREATE FUNCTION public.claim_earlybird_fulfillment(
    p_order_id UUID, p_lease_token UUID, p_lease_seconds INTEGER
)
RETURNS TABLE(claimed BOOLEAN, fulfillment_status TEXT, lease_token UUID, lease_fence BIGINT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_preflight public.analysis_preflights%ROWTYPE;
BEGIN
    SELECT preflight.* INTO v_preflight
    FROM public.earlybird_orders AS earlybird_order
    JOIN public.analysis_preflights AS preflight ON preflight.id=earlybird_order.preflight_id
    WHERE earlybird_order.id=p_order_id;
    IF v_preflight.admission_status <> 'ready'
       OR v_preflight.admission_refreshed_at < clock_timestamp()-INTERVAL '2 minutes' THEN
        RAISE EXCEPTION 'ADMISSION_NOT_FRESH';
    END IF;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET lease_token=p_lease_token,
        lease_expires_at=clock_timestamp()+p_lease_seconds*INTERVAL '1 second',
        lease_fence=fulfillment.lease_fence+1
    WHERE fulfillment.order_id=p_order_id;
    RETURN QUERY SELECT TRUE,'admission_pending'::TEXT,p_lease_token,1::BIGINT;
END;
$$;
CREATE FUNCTION public.create_or_replay_earlybird_fulfillment_request(
    p_order_id UUID, p_lease_token UUID, p_lease_fence BIGINT
)
RETURNS TABLE(order_id UUID, fulfillment_status TEXT, request_id UUID, created BOOLEAN, initial_job_key TEXT)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_user UUID; v_preflight UUID;
BEGIN
    SELECT earlybird_order.user_id,earlybird_order.preflight_id INTO v_user,v_preflight
    FROM public.earlybird_orders AS earlybird_order WHERE earlybird_order.id=p_order_id;
    INSERT INTO public.analysis_requests(id,user_id,preflight_id,status)
    VALUES ('${REQUEST_ID}'::UUID,v_user,v_preflight,'pending');
    UPDATE public.analysis_preflights SET status='consumed',consumed_request_id='${REQUEST_ID}'::UUID
    WHERE id=v_preflight;
    UPDATE public.earlybird_orders SET status='analysis_in_progress',result_request_id='${REQUEST_ID}'::UUID
    WHERE id=p_order_id;
    UPDATE public.earlybird_fulfillments AS fulfillment
    SET status='analysis_in_progress',request_id='${REQUEST_ID}'::UUID,lease_token=NULL,lease_expires_at=NULL
    WHERE fulfillment.order_id=p_order_id AND fulfillment.lease_token=p_lease_token AND fulfillment.lease_fence=p_lease_fence;
    RETURN QUERY SELECT p_order_id,'analysis_in_progress'::TEXT,'${REQUEST_ID}'::UUID,TRUE,'coordinator:bootstrap'::TEXT;
END;
$$;
`;

async function seed(withGenerationTwoProviderRun = false) {
    await db.exec(`
        DELETE FROM public.analysis_preflight_provider_runs;
        DELETE FROM public.analysis_requests;
        DELETE FROM public.earlybird_fulfillments;
        DELETE FROM public.earlybird_orders;
        DELETE FROM public.analysis_preflights;
        DELETE FROM public.users;
        DELETE FROM public.earlybird_webhook_events;
        INSERT INTO public.users(id) VALUES ('${USER_ID}');
        INSERT INTO public.analysis_preflights(
            id,user_id,idempotency_key,target_instagram_id,exclusion_decision,excluded_instagram_id,
            access_mode,status,consumed_request_id,launch_status_snapshot,plan_catalog_snapshot,
            pricing_version,pricing_snapshot,policy_versions_snapshot,target_followers_count,
            target_following_count,capacity_required_plan_id,required_plan_id,plan_cards_snapshot,
            admission_generation,admission_status,admission_selected_plan_id,
            admission_entitlement_jti_hash,admission_token,admission_requested_at,
            admission_refreshed_at,admission_target_followers_count,
            admission_target_following_count,admission_capacity_required_plan_id,
            admission_required_plan_id,admission_plan_cards_snapshot,admission_failure_count,
            admission_dispatch_state
        ) VALUES (
            '${SOURCE_PREFLIGHT_ID}','${USER_ID}','earlybird.fulfillment.10000000000040008000000000000002',
            'target','skip',NULL,'production','expired',NULL,'${SNAPSHOT}','${SNAPSHOT}','v1',
            '${SNAPSHOT}','${SNAPSHOT}',111,222,'basic','basic','${CARDS}',1,'ready','basic',
            '${ADMISSION_HASH}','${SOURCE_TOKEN}',clock_timestamp()-INTERVAL '4 minutes',
            clock_timestamp()-INTERVAL '3 minutes',111,222,'basic','basic','${CARDS}',0,'enqueued'
        ), (
            '${CURRENT_PREFLIGHT_ID}','${USER_ID}','earlybird.fulfillment.10000000000040008000000000000002',
            'target','skip',NULL,'production','ready',NULL,'${SNAPSHOT}','${SNAPSHOT}','v1',
            '${SNAPSHOT}','${SNAPSHOT}',111,222,'basic','basic','${CARDS}',2,'pending','basic',
            '${ADMISSION_HASH}','${SOURCE_TOKEN}',clock_timestamp()-INTERVAL '1 minute',NULL,
            NULL,NULL,NULL,NULL,NULL,0,'idle'
        );
        INSERT INTO public.earlybird_orders(
            id,user_id,preflight_id,status,seller_reference_confirmed_at,payment_id,
            actual_amount_krw,expected_amount_krw,actual_groble_product_id,
            expected_groble_product_id,result_request_id,target_instagram_id,
            target_followers_count,target_following_count,exclusion_decision,excluded_instagram_id,plan_id
        ) VALUES (
            '${ORDER_ID}','${USER_ID}','${CURRENT_PREFLIGHT_ID}','paid',clock_timestamp(),'payment-proof',
            6900,6900,'product-proof','product-proof',NULL,'target',111,222,'skip',NULL,'basic'
        );
        INSERT INTO public.earlybird_fulfillments(order_id,status,request_id,lease_token,lease_expires_at,lease_fence,last_error_code)
        VALUES ('${ORDER_ID}','admission_pending',NULL,NULL,NULL,0,NULL);
        INSERT INTO public.analysis_preflight_provider_runs(
            preflight_id,operation_key,input_hash,logical_provider,actor_id,credential_slot,status,
            run_id,terminalized_at,actual_usage_usd,usage_reconciled_at,reusable_profile_schema_version
        ) VALUES (
            '${CURRENT_PREFLIGHT_ID}','target-profile-fresh-admission:g1',repeat('b',64),'apify',
            'apify/instagram-profile-scraper','senary','succeeded','run-proof',clock_timestamp(),0.0026,
            clock_timestamp(),1
        );
        ${withGenerationTwoProviderRun ? `INSERT INTO public.analysis_preflight_provider_runs(preflight_id,operation_key,input_hash,logical_provider,actor_id,credential_slot,status) VALUES ('${CURRENT_PREFLIGHT_ID}','target-profile-fresh-admission:g2',repeat('c',64),'apify','apify/instagram-profile-scraper','senary','succeeded');` : ''}
    `);
}

beforeAll(async () => {
    db = new PGlite();
    await db.exec(bootstrap);
    await db.exec(migration);
});

beforeEach(async () => {
    await seed();
});

afterAll(async () => {
    await db.close();
});

describe('exact generation-two pending-idle recovery', () => {
    it('reuses completed g1 evidence to create one request without a g2 provider run', async () => {
        const recovered = await db.query<{
            applied: boolean;
            fulfillment_status: string;
            request_id: string;
            initial_job_key: string;
        }>(`SELECT * FROM public.recover_exact_earlybird_generation_two_pending_idle(
            '${ORDER_ID}', '${CURRENT_PREFLIGHT_ID}'
        )`);

        expect(recovered.rows).toEqual([{
            applied: true,
            fulfillment_status: 'analysis_in_progress',
            request_id: REQUEST_ID,
            initial_job_key: 'coordinator:bootstrap',
        }]);
        const state = await db.query<{
            fulfillment_status: string;
            preflight_status: string;
            admission_generation: number;
            generation_one_runs: number;
            generation_two_runs: number;
        }>(`SELECT fulfillment.status AS fulfillment_status,preflight.status AS preflight_status,
                preflight.admission_generation,
                (SELECT count(*)::INTEGER FROM public.analysis_preflight_provider_runs run
                    WHERE run.preflight_id=preflight.id AND run.operation_key='target-profile-fresh-admission:g1') AS generation_one_runs,
                (SELECT count(*)::INTEGER FROM public.analysis_preflight_provider_runs run
                    WHERE run.preflight_id=preflight.id AND run.operation_key='target-profile-fresh-admission:g2') AS generation_two_runs
            FROM public.earlybird_fulfillments fulfillment
            JOIN public.earlybird_orders earlybird_order ON earlybird_order.id=fulfillment.order_id
            JOIN public.analysis_preflights preflight ON preflight.id=earlybird_order.preflight_id
            WHERE fulfillment.order_id='${ORDER_ID}'`);
        expect(state.rows).toEqual([{
            fulfillment_status: 'analysis_in_progress',
            preflight_status: 'consumed',
            admission_generation: 2,
            generation_one_runs: 1,
            generation_two_runs: 0,
        }]);
    });

    it('fails closed when the current generation already has provider activity', async () => {
        await seed(true);

        await expect(db.query(`SELECT * FROM public.recover_exact_earlybird_generation_two_pending_idle(
            '${ORDER_ID}', '${CURRENT_PREFLIGHT_ID}'
        )`)).rejects.toThrow('EXACT_G2_PENDING_IDLE_RECOVERY_CONFLICT');
        const retained = await db.query<{ status: string; request_id: string | null }>(
            `SELECT status,request_id FROM public.earlybird_fulfillments WHERE order_id='${ORDER_ID}'`,
        );
        expect(retained.rows).toEqual([{ status: 'admission_pending', request_id: null }]);
    });
});
