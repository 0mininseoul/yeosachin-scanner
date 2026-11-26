import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverPaidResultEmails, isPaidResultEmailAvailableForOrder } from '@/lib/services/earlybird/result-email';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock('resend', () => ({ Resend: class { emails = { send: mocks.send }; } }));

const db = new PGlite();
const user = randomUUID();
const order = randomUUID();
const request = randomUUID();
const ownerEmail = 'owner@example.test';
const readMigration = (name: string) => readFileSync(new URL('../../../supabase/migrations/' + name, import.meta.url), 'utf8');

beforeAll(async () => {
    await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE SCHEMA auth;
        CREATE TABLE auth.users(id uuid PRIMARY KEY,email text,email_confirmed_at timestamptz,deleted_at timestamptz);
        CREATE TABLE auth.identities(user_id uuid,provider text,identity_data jsonb);
        CREATE TABLE public.users(id uuid PRIMARY KEY,email text,account_class text,traffic_class text,lifecycle text);
        CREATE TABLE public.earlybird_orders(id uuid PRIMARY KEY,user_id uuid,status text,target_instagram_id text,
            result_request_id uuid,payment_id text,paid_at timestamptz,actual_amount_krw int,expected_amount_krw int,
            actual_groble_product_id text,expected_groble_product_id text,seller_reference_confirmed_at timestamptz DEFAULT now(),
            preflight_id uuid,plan_id text,updated_at timestamptz);
        CREATE TABLE public.analysis_requests(id uuid PRIMARY KEY,user_id uuid,status text,pipeline_version text,
            target_instagram_id text,step_data jsonb,idempotency_key text,completed_at timestamptz DEFAULT now(),
            preflight_id uuid,test_entitlement_jti_hash text,selected_plan_id_snapshot text DEFAULT 'standard');
        CREATE TABLE public.analysis_v2_result_summaries(request_id uuid PRIMARY KEY,target_instagram_id text,plan_id text DEFAULT 'standard');
        CREATE TABLE public.earlybird_fulfillments(order_id uuid PRIMARY KEY,request_id uuid,status text,completed_at timestamptz,
            capacity_first_started_at timestamptz,updated_at timestamptz);
        CREATE TABLE public.analysis_preflights(id uuid PRIMARY KEY,user_id uuid,access_mode text,status text,consumed_request_id uuid,admission_selected_plan_id text DEFAULT 'standard');
        CREATE TABLE public.earlybird_webhook_events(order_id uuid,payment_id text,event_type text,disposition text,amount_krw int);
    `);
    await db.exec(readMigration('20260821080948_allow_completed_results_after_refund.sql'));
    await db.exec(readMigration('20261126100001_add_paid_result_email_outbox.sql'));
    await db.exec(readMigration('20261126100003_complete_published_capacity_order.sql'));
});

beforeEach(async () => {
    for (const [key, value] of Object.entries({
        NODE_ENV: 'production', PAID_RESULT_EMAIL_ENABLED: 'true', K_SERVICE: 'analysis-paid-worker',
        ANALYSIS_WORKLOAD_ROLE: 'paid', RESEND_API_KEY: 'synthetic-transport', RESEND_FROM_EMAIL: 'results@example.test',
        VERCEL_ENV: 'production',
    })) vi.stubEnv(key, value);
    await db.exec('TRUNCATE auth.users,auth.identities,public.users,earlybird_orders,analysis_requests,analysis_v2_result_summaries,earlybird_fulfillments,paid_result_email_outbox,analysis_preflights,earlybird_webhook_events');
    await db.query("INSERT INTO auth.users VALUES ($1,$2,now(),NULL)", [user, ownerEmail]);
    await db.query("INSERT INTO public.users VALUES ($1,$2,'production','external','active')", [user, ownerEmail]);
    await db.query("INSERT INTO earlybird_orders VALUES ($1,$2,'completed','target',$3,'synthetic-payment',now(),4900,4900,'standard','standard')",
        [order, user, request]);
    await db.query("INSERT INTO analysis_requests VALUES ($1,$2,'completed','v2','target',NULL,NULL)", [request,user]);
    await db.query("INSERT INTO analysis_v2_result_summaries VALUES ($1,'target')", [request]);
    await db.query("INSERT INTO earlybird_fulfillments VALUES ($1,$2,'completed',now())", [order,request]);
    mocks.rpc.mockReset().mockImplementation(async (name, args) => {
        if (name === 'claim_paid_result_email') {
            const { rows } = await db.query('SELECT * FROM claim_paid_result_email($1)', [args.p_token]);
            return {data: JSON.parse(JSON.stringify(rows)),error:null};
        }
        if (name === 'finish_paid_result_email') {
            const { rows } = await db.query<{ok:boolean}>('SELECT finish_paid_result_email($1,$2,$3) AS ok',
                [args.p_order_id,args.p_token,args.p_accepted]);
            return {data:rows[0].ok,error:null};
        }
        if (name === 'paid_result_email_available') {
            const { rows } = await db.query<{ok:boolean}>('SELECT paid_result_email_available($1,$2) AS ok',
                [args.p_order_id,args.p_owner_id]);
            return {data:rows[0].ok,error:null};
        }
        throw Error('unexpected test RPC');
    });
    mocks.send.mockReset().mockResolvedValue({data:{id:'synthetic-receipt'},error:null});
});
afterEach(() => vi.unstubAllEnvs());
afterAll(() => db.close());

describe('signed capacity order publication', () => {
    beforeEach(async () => {
        const preflight = randomUUID();
        await db.query("INSERT INTO analysis_preflights VALUES ($1,$2,'production','consumed',$3)", [preflight,user,request]);
        await db.query('UPDATE analysis_requests SET preflight_id=$1', [preflight]);
        await db.query("UPDATE earlybird_orders SET status='analysis_in_progress',preflight_id=$1,plan_id='standard'", [preflight]);
        await db.exec(`
            UPDATE earlybird_fulfillments SET status='analysis_in_progress',completed_at=NULL,capacity_first_started_at=now();
            INSERT INTO earlybird_webhook_events SELECT id,payment_id,'payment.completed','accepted',actual_amount_krw FROM earlybird_orders;
        `);
    });
    const complete = () => db.query<{ done: boolean }>('SELECT complete_published_capacity_order_v1($1) AS done', [request]);
    it('publishes the assigned order immediately and preserves the first completion on redelivery', async () => {
        expect((await complete()).rows[0].done).toBe(true);
        const completed = await db.query('SELECT completed_at FROM earlybird_fulfillments');
        expect((await complete()).rows[0].done).toBe(false);
        expect((await db.query('SELECT completed_at FROM earlybird_fulfillments')).rows).toEqual(completed.rows);
        expect((await db.query('SELECT analysis_result_publication_authorized($1) AS published', [request])).rows)
            .toEqual([{published:true}]);
    });
    it.each([
        "UPDATE earlybird_fulfillments SET capacity_first_started_at=NULL",
        "UPDATE earlybird_orders SET status='refunded'",
        "UPDATE analysis_requests SET status='processing'",
        'UPDATE analysis_preflights SET user_id=gen_random_uuid()',
        "UPDATE earlybird_webhook_events SET disposition='rejected'",
        "UPDATE analysis_v2_result_summaries SET target_instagram_id='other-synthetic'",
        "UPDATE analysis_requests SET selected_plan_id_snapshot='basic'",
    ])('preserves the pending fulfillment after %s', async change => {
        await db.exec(change);
        expect((await complete()).rows[0].done).toBe(false);
        expect((await db.query('SELECT completed_at FROM earlybird_fulfillments')).rows).toEqual([{completed_at:null}]);
    });
    it('publishes a scrubbed request only for its own retained identifier and the original purchased target', async () => {
        await db.exec("UPDATE analysis_requests SET target_instagram_id='retained.' || repeat('0',20)");
        expect((await complete()).rows[0].done).toBe(false);
        await db.exec("UPDATE analysis_requests SET target_instagram_id='retained.' || substr(replace(id::text,'-',''),1,20)");
        expect((await complete()).rows[0].done).toBe(true);
    });
    it('rolls back both projections if the result publication authority refuses the source', async () => {
        await db.exec("UPDATE analysis_requests SET idempotency_key='concierge-batch-source:fixture'");
        await expect(complete()).rejects.toThrow('PAID_CAPACITY_RESULT_NOT_PUBLISHABLE');
        expect((await db.query('SELECT status FROM earlybird_orders')).rows).toEqual([{status:'analysis_in_progress'}]);
        expect((await db.query('SELECT completed_at FROM earlybird_fulfillments')).rows).toEqual([{completed_at:null}]);
    });
});

describe('paid result completion email', () => {
    beforeAll(async () => {
        // Run the same scrub function as finalize, including its two different retained IDs.
        await db.exec(`
            ALTER TABLE analysis_requests ADD COLUMN IF NOT EXISTS exclusion_decision_snapshot text,
                ADD COLUMN IF NOT EXISTS excluded_instagram_id text;
            ALTER TABLE analysis_preflights ADD COLUMN IF NOT EXISTS target_instagram_id text,
                ADD COLUMN IF NOT EXISTS target_full_name text, ADD COLUMN IF NOT EXISTS target_bio text,
                ADD COLUMN IF NOT EXISTS target_profile_image_url text, ADD COLUMN IF NOT EXISTS exclusion_decision text,
                ADD COLUMN IF NOT EXISTS excluded_instagram_id text, ADD COLUMN IF NOT EXISTS pii_scrubbed_at timestamptz,
                ADD COLUMN IF NOT EXISTS updated_at timestamptz;
        `);
        const finalization = readMigration('20260713185711_add_analysis_v2_result_finalization.sql');
        const signature = 'CREATE OR REPLACE FUNCTION public.analysis_v2_scrub_terminal_request_pii(';
        const start = finalization.indexOf(signature);
        const end = finalization.indexOf('\n$$;', start);
        if (start < 0 || end < 0) throw new Error('Missing terminal request scrub function');
        await db.exec(finalization.slice(start, end + 4));
    });
    beforeEach(async () => {
        await db.exec(`INSERT INTO earlybird_webhook_events(order_id,payment_id,event_type,disposition,amount_krw)
            SELECT id,payment_id,'payment.completed','accepted',actual_amount_krw FROM earlybird_orders`);
    });

    it('uses the published request and verified owner, once, after fulfillment', async () => {
        expect(await isPaidResultEmailAvailableForOrder(order,user)).toBe(true);
        expect(await isPaidResultEmailAvailableForOrder(order,randomUUID())).toBe(false);
        await db.exec("UPDATE earlybird_fulfillments SET status='analysis_in_progress',completed_at=NULL");
        await deliverPaidResultEmails();
        expect(mocks.send).not.toHaveBeenCalled();
        await db.exec("UPDATE earlybird_fulfillments SET status='completed',completed_at=now()");
        await Promise.all([deliverPaidResultEmails(),deliverPaidResultEmails()]);
        await deliverPaidResultEmails();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
            to: ownerEmail, html: expect.stringContaining('https://yeosachin.com/result/' + request),
        }), {idempotencyKey:'paid-result/' + request});
    });

    it('completes the signed purchase after terminal PII scrubbing and mails the original published target once', async () => {
        const preflight = randomUUID();
        await db.query(`INSERT INTO analysis_preflights(id,user_id,access_mode,status,consumed_request_id,
            admission_selected_plan_id,target_instagram_id) VALUES ($1,$2,'production','consumed',$3,'standard','target')`,
        [preflight,user,request]);
        await db.query('UPDATE analysis_requests SET preflight_id=$1 WHERE id=$2', [preflight,request]);
        await db.query("UPDATE earlybird_orders SET preflight_id=$1,plan_id='standard',status='analysis_in_progress' WHERE id=$2",
            [preflight,order]);
        await db.query("UPDATE earlybird_fulfillments SET status='analysis_in_progress',capacity_first_started_at=now(),completed_at=NULL WHERE order_id=$1",
            [order]);
        await db.query('SELECT analysis_v2_scrub_terminal_request_pii($1,now())', [request]);
        const scrub = await db.query(`SELECT r.target_instagram_id=p.target_instagram_id AS shared_target,
            r.target_instagram_id LIKE 'retained.%' AS request_scrubbed, p.target_instagram_id LIKE 'retained.%' AS preflight_scrubbed
            FROM analysis_requests r JOIN analysis_preflights p ON p.id=r.preflight_id WHERE r.id=$1`, [request]);
        expect(scrub.rows).toEqual([{shared_target:false, request_scrubbed:true, preflight_scrubbed:true}]);
        expect((await db.query('SELECT complete_published_capacity_order_v1($1) AS complete', [request])).rows)
            .toEqual([{complete:true}]);
        await deliverPaidResultEmails();
        await deliverPaidResultEmails();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
            to:ownerEmail, subject:expect.stringContaining('@target '), html:expect.stringContaining('@target</span>'),
        }), {idempotencyKey:'paid-result/'+request});
    });

    it.each([
        "UPDATE analysis_requests SET user_id=gen_random_uuid()",
        "UPDATE analysis_requests SET target_instagram_id='different_target'",
        "UPDATE analysis_requests SET target_instagram_id='retained.' || substr(replace(gen_random_uuid()::text,'-',''),1,20)",
        "UPDATE analysis_v2_result_summaries SET target_instagram_id='different_target'",
        "UPDATE earlybird_orders SET target_instagram_id='different_target'",
        "UPDATE earlybird_webhook_events SET payment_id='another-payment'",
        "UPDATE earlybird_webhook_events SET amount_krw=amount_krw+1",
        "UPDATE earlybird_webhook_events SET disposition='rejected'",
        "UPDATE earlybird_orders SET status='refunded'",
        "UPDATE earlybird_orders SET actual_amount_krw=0",
        "UPDATE earlybird_orders SET actual_amount_krw=expected_amount_krw+1",
        "UPDATE earlybird_orders SET seller_reference_confirmed_at=NULL",
        "UPDATE auth.users SET email_confirmed_at=NULL",
        "UPDATE auth.users SET deleted_at=now()",
        "UPDATE public.users SET lifecycle='deleted'",
        "UPDATE public.users SET account_class='e2e_test'",
        "DELETE FROM analysis_v2_result_summaries",
        "UPDATE earlybird_fulfillments SET completed_at=now()-interval '1 year'",
        "UPDATE analysis_requests SET completed_at=now()-interval '1 year'",
    ])('suppresses mail for an ineligible durable state (%s)', async change => {
        await db.exec(change);
        await deliverPaidResultEmails();
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('delivers a discounted purchase after skipping earlier ineligible tasks in the same sweep', async () => {
        await db.exec('UPDATE earlybird_orders SET actual_amount_krw=expected_amount_krw-100');
        await db.exec('UPDATE earlybird_webhook_events SET amount_krw=(SELECT actual_amount_krw FROM earlybird_orders)');
        for (let i = 0; i < 3; i++) {
            const invalidOrder = randomUUID();
            const invalidRequest = randomUUID();
            await db.query("INSERT INTO earlybird_orders(id,user_id,status) VALUES ($1,$2,'refunded')", [invalidOrder,user]);
            await db.query("INSERT INTO analysis_requests(id,user_id,status) VALUES ($1,$2,'completed')", [invalidRequest,user]);
            await db.query(`INSERT INTO paid_result_email_outbox(order_id,request_id,next_attempt_at)
                VALUES ($1,$2,now()-interval '1 minute')`, [invalidOrder,invalidRequest]);
        }
        expect(await isPaidResultEmailAvailableForOrder(order,user)).toBe(true);
        expect(await deliverPaidResultEmails()).toMatchObject({accepted:1,failed:0});
        expect(mocks.send).toHaveBeenCalledTimes(1);
        const { rows } = await db.query("SELECT count(*)::int AS invalid FROM paid_result_email_outbox WHERE status='ineligible'");
        expect(rows).toEqual([{invalid:3}]);
    });

    it('requires the verified Kakao identity to match the exact owner address', async () => {
        await db.exec('UPDATE auth.users SET email_confirmed_at=NULL');
        await db.query("INSERT INTO auth.identities VALUES ($1,'kakao',$2)", [user,
            JSON.stringify({email:'other@example.test',email_verified:true})]);
        expect(await isPaidResultEmailAvailableForOrder(order,user)).toBe(false);
        await db.query("UPDATE auth.identities SET identity_data=$1", [JSON.stringify({email:ownerEmail,email_verified:true})]);
        expect(await isPaidResultEmailAvailableForOrder(order,user)).toBe(true);
    });

    it('reclaims a lost acceptance acknowledgement using the identical provider key and payload', async () => {
        const provider = new Set<string>();
        mocks.send.mockImplementation(async (_payload, options) => {
            provider.add(options.idempotencyKey);
            return {data:{id:'same-receipt'},error:null};
        });
        const original = mocks.rpc.getMockImplementation()!;
        let loseAck = true;
        mocks.rpc.mockImplementation(async (name, args) => {
            if (name === 'finish_paid_result_email' && loseAck) {
                loseAck=false;
                return {data:null,error:{code:'ECONNRESET'}};
            }
            return original(name,args);
        });
        expect(await deliverPaidResultEmails()).toMatchObject({failed:1});
        await deliverPaidResultEmails();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        await db.exec("UPDATE paid_result_email_outbox SET next_attempt_at=now()-interval '1 second'");
        expect(await deliverPaidResultEmails()).toMatchObject({accepted:1});
        expect(mocks.send.mock.calls[0]).toEqual(mocks.send.mock.calls[1]);
        expect(provider.size).toBe(1);
        expect((await db.query("SELECT status FROM earlybird_fulfillments")).rows).toEqual([{status:'completed'}]);
    });

    it.each(['recipient', 'published target', 'provider window'])('holds uncertain sends for review after a change to the %s', async changed => {
        mocks.send.mockResolvedValueOnce({data:null,error:{name:'network'}});
        expect(await deliverPaidResultEmails()).toMatchObject({accepted:0,failed:1});
        await db.exec("UPDATE paid_result_email_outbox SET next_attempt_at=now()-interval '1 second'");
        if (changed === 'recipient') {
            await db.exec("UPDATE public.users SET email='changed@example.test'; UPDATE auth.users SET email='changed@example.test'");
        } else if (changed === 'published target') {
            await db.exec("UPDATE analysis_v2_result_summaries SET target_instagram_id='changed_target'");
        } else await db.exec("UPDATE paid_result_email_outbox SET first_attempt_at=now()-interval '24 hours'");
        await deliverPaidResultEmails();
        expect(mocks.send).toHaveBeenCalledTimes(1);
        expect((await db.query('SELECT status FROM paid_result_email_outbox')).rows).toEqual([{status:'review'}]);
    });

    it.each([
        ['NODE_ENV','test'], ['DEPLOYMENT_ROLE','dev'], ['K_SERVICE','dev-live-paid'],
        ['DEV_LIVE_WORKLOAD','paid'], ['PAID_RESULT_EMAIL_ENABLED','false'], ['ANALYSIS_WORKLOAD_ROLE','preflight'],
    ])('avoids claiming or sending in %s=%s', async (name,value) => {
        vi.stubEnv(name,value);
        expect(await deliverPaidResultEmails()).toMatchObject({enabled:false});
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.send).not.toHaveBeenCalled();
    });

    it('restricts raw address, outbox tables and dispatch functions to the required privilege', async () => {
        for (const role of ['anon','authenticated','service_role']) {
            await db.exec(`SET ROLE ${role}`);
            try {
                await expect(db.query('SELECT * FROM paid_result_email_outbox')).rejects.toThrow('permission denied');
                await expect(db.query('SELECT paid_result_email_recipient($1,$2)',[order,user])).rejects.toThrow('permission denied');
                await expect(db.query("SELECT paid_result_target_matches_v1($1,'target','target','target')",[request])).rejects.toThrow('permission denied');
                if (role !== 'service_role') await expect(db.query('SELECT * FROM claim_paid_result_email($1)',[randomUUID()])).rejects.toThrow('permission denied');
            } finally { await db.exec('RESET ROLE'); }
        }
    });
});
