import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createSharedStandardDatabase } from '../../analysis/execution/fixtures/standard-shared-database';
import { seedProcessingJob } from '../../analysis/execution/fixtures/standard-shared-processing-job';

const native = it.runIf(process.env.RUN_SHARED_STANDARD_POSTGRES_TEST === '1');

native('serializes simultaneous paid claims, preserves FIFO and releases only terminal work', async () => {
    const db = await createSharedStandardDatabase(8);
    try {
        const base = await seedProcessingJob(db);
        const { rows: [source] } = await db.query<{ owner: string; preflight: string }>(
            'SELECT user_id AS owner, preflight_id AS preflight FROM analysis_requests WHERE id=$1', [base.requestId]);
        async function order(
            index: number,
            paidAt = new Date(Date.UTC(2026, 0, 1, 0, index)),
            planId: 'basic' | 'standard' | 'plus' = index % 2 ? 'basic' : 'standard',
        ) {
            const id = randomUUID();
            const owner = index === 0 ? source.owner : randomUUID();
            const preflight = index === 0 ? source.preflight : randomUUID();
            if (index > 0) {
                await db.query("INSERT INTO users(id,email,provider) VALUES($1,$2,'kakao')", [owner, owner + '@example.invalid']);
            await db.query(`INSERT INTO analysis_preflights(id,user_id,idempotency_key,target_instagram_id,access_mode,
                created_at,expires_at,launch_status_snapshot,plan_catalog_snapshot,pricing_version,pricing_snapshot,policy_versions_snapshot)
                SELECT $1,$4,$2,target_instagram_id,'production',now(),now()+interval '30 minutes',launch_status_snapshot,
                    plan_catalog_snapshot,pricing_version,pricing_snapshot,policy_versions_snapshot FROM analysis_preflights WHERE id=$3`,
                [preflight, id, source.preflight,owner]);
            }
            const suffix = String(index).padStart(2, '0');
            await db.query(`UPDATE users SET phone_number=$2, phone_number_normalized=$3, phone_number_verified_at=now(),
                phone_number_verification_source='kakao_rest_api' WHERE id=$1`, [owner, '010000000'+suffix, '+8210000000'+suffix]);
            await db.query(`INSERT INTO earlybird_orders(id,user_id,preflight_id,target_instagram_id,target_followers_count,
                target_following_count,exclusion_decision,plan_id,pricing_version,expected_amount_krw,expected_groble_product_id,
                disclosure_version,disclosure_text,disclosure_accepted_at,status,payment_id,actual_groble_product_id,actual_amount_krw,
                paid_at,buyer_match_policy,seller_reference_confirmed_at)
                VALUES($1,$2,$3,'capacity_fixture',150,110,'skip',$4,'fixture',9900,'fixture','fixture','fixture',now(),'paid',
                    $5,'fixture',9900,$6::timestamptz,'legacy_email',now())`,
                [id,owner,preflight,planId,id,paidAt.toISOString()]);
            await db.query("UPDATE earlybird_fulfillments SET status='admission_pending',operator_admitted_at=now() WHERE order_id=$1", [id]);
            return { id, preflight, owner };
        }
        const rpc = (name: string, args: Record<string, unknown>) => db.client().rpc(name, args);
        const claim = async (id: string) => {
            const reply = await rpc('claim_paid_analysis_capacity_v1', { p_order_id: id });
            expect(reply.error).toBeNull();
            return reply.data;
        };
        const info = async (order: { id:string; owner:string }, user = order.owner) =>
            (await rpc('load_paid_analysis_capacity_v1', { p_order_id:order.id, p_user_id:user })).data;
        expect((await db.query('SELECT max_active,expected_basic_max_minutes,expected_standard_max_minutes FROM paid_analysis_capacity_policy')).rows)
            .toEqual([{max_active:null,expected_basic_max_minutes:null,expected_standard_max_minutes:null}]);
        const legacy = await order(0);
        expect(await claim(legacy.id)).toBe('ready');
        expect(await info(legacy)).toBeNull();
        await expect(db.exec('UPDATE paid_analysis_capacity_policy SET max_active=2')).rejects.toThrow();
        await db.exec("UPDATE paid_analysis_capacity_policy SET max_active=2,validation_ref='local-fixture',expected_standard_max_minutes=60");
        const a = await order(1);
        const b = await order(2);
        const c = await order(3);
        const d = await order(4);
        const simultaneous = await Promise.all([d,c,b,a,a].map(o => claim(o.id)));
        expect(simultaneous).toEqual(['waiting','waiting','waiting','ready','ready']);
        expect(await info(a)).toMatchObject({waiting:false, expectedMaxMinutes:null,startedAt:expect.any(String)});
        const before = await info(a);
        expect(await info(b)).toMatchObject({waiting:true,startedAt:null,expectedMaxMinutes:null});
        expect(await info(b, randomUUID())).toBeNull();
        await expect(db.query(`UPDATE earlybird_fulfillments SET lease_token=gen_random_uuid(),lease_expires_at=now()+interval '1 minute'
            WHERE order_id=$1`,[b.id])).rejects.toThrow('EARLYBIRD_ANALYSIS_CAPACITY_WAITING');
        await expect(db.query(`UPDATE analysis_preflights SET admission_generation=1,
            admission_entitlement_jti_hash=encode(extensions.digest('earlybird-fulfillment-admission-v1'||chr(10)||$2,'sha256'),'hex')
            WHERE id=$1`,[b.preflight,b.id])).rejects.toThrow('EARLYBIRD_ANALYSIS_CAPACITY_WAITING');
        await db.query("UPDATE earlybird_orders SET status='refunded' WHERE id=$1", [b.id]);
        expect(await claim(b.id)).toBe('ineligible');
        expect(await info(b)).toMatchObject({waiting:false,startedAt:null});
        await db.query("UPDATE earlybird_fulfillments SET status='analysis_in_progress',request_id=$2 WHERE order_id=$1", [legacy.id,base.requestId]);
        await db.query("UPDATE earlybird_orders SET status='refund_pending' WHERE id=$1", [legacy.id]);
        expect(await claim(c.id)).toBe('waiting');
        await db.query("UPDATE analysis_requests SET status='failed' WHERE id=$1", [base.requestId]);
        const recoverable = await rpc('list_recoverable_earlybird_fulfillments', {p_limit:20});
        expect(recoverable.error).toBeNull();
        expect((recoverable.data as {order_id:string}[]).map(row=>row.order_id)).toEqual([c.id,a.id]);
        expect(await Promise.all([claim(d.id),claim(c.id)])).toEqual(['waiting','ready']);
        expect(await claim(a.id)).toEqual('ready');
        expect(await info(a)).toEqual(before);
        await db.query("UPDATE earlybird_fulfillments SET status='manual_review',manual_review_at=now() WHERE order_id=$1", [a.id]);
        expect(await claim(d.id)).toBe('ready');
        const newRequest = randomUUID();
        await db.query(`INSERT INTO analysis_requests SELECT cloned.* FROM analysis_requests original
            CROSS JOIN LATERAL jsonb_populate_record(NULL::analysis_requests,
                to_jsonb(original) || jsonb_build_object('id',$1::uuid,'user_id',$2::uuid,'preflight_id',$3::uuid,
                    'idempotency_key',$1::text)) cloned WHERE original.id=$4`,
            [newRequest, d.owner, d.preflight, base.requestId]);
        await db.query("UPDATE earlybird_fulfillments SET status='analysis_in_progress', request_id=$2 WHERE order_id=$1",
            [d.id,newRequest]);
        const duration = (user: string) => rpc('load_paid_analysis_capacity_by_request_v1', {
            p_request_id: newRequest, p_user_id: user,
        });
        expect((await duration(d.owner)).data).toEqual(await info(d));
        expect((await duration(c.owner)).data).toBeNull();

        // Runtime shrink/rollback preserves grants and the policy at the first real start.
        await db.exec("UPDATE paid_analysis_capacity_policy SET max_active=1,validation_ref='second-fixture',expected_basic_max_minutes=39,expected_standard_max_minutes=52");
        const next = await order(5);
        expect(await claim(next.id)).toBe('waiting');
        expect(await info(d)).toMatchObject({expectedMaxMinutes:60});
        expect(await info(c)).toMatchObject({expectedMaxMinutes:null});
        await db.exec('UPDATE paid_analysis_capacity_policy SET max_active=NULL');
        expect(await claim(next.id)).toBe('ready');
        expect(await info(next)).toMatchObject({startedAt:expect.any(String),expectedMaxMinutes:null});
        // Real Groble reference finalizer registers before webhook credential binding.
        await db.exec("UPDATE paid_analysis_capacity_policy SET max_active=1,validation_ref='payment-order-test'");
        const signed = await order(6);
        const ref = 'ord.' + signed.id.replaceAll('-','');
        await db.query('DELETE FROM earlybird_fulfillments WHERE order_id=$1',[signed.id]);
        await db.query(`UPDATE earlybird_orders SET status='payment_pending', payment_id=NULL,paid_at=NULL,actual_amount_krw=NULL,
            actual_groble_product_id=NULL,seller_reference_confirmed_at=now(),groble_seller_reference=$2 WHERE id=$1`,[signed.id,ref]);
        const payment = {
            p_event_id:'evt_test_'+signed.id.replaceAll('-',''),p_idempotency_key:'fixture-'+signed.id,
            p_event_type:'payment.completed',p_occurred_at:new Date().toISOString(),p_payment_id:'paid-'+signed.id,
            p_buyer_email:signed.owner+'@example.invalid',p_buyer_phone_normalized:'+821000000006',p_buyer_phone_raw:null,
            p_buyer_display_name:null,p_product_id:'fixture',p_amount_krw:9900,p_paid_at:new Date().toISOString(),p_seller_reference:ref,
        };
        await db.query("INSERT INTO earlybird_plan_inventory(plan_id,sale_limit,sold_count) VALUES('standard',10,0) ON CONFLICT DO NOTHING");
        const finalized = await rpc('finalize_automatic_paid_analysis_v1',payment);
        expect(finalized.error).toBeNull();
        expect(finalized.data).toMatchObject([{disposition:'accepted',order_id:signed.id,status:'paid'}]);
        expect((await db.query('SELECT status,capacity_queued_at IS NOT NULL AS enrolled FROM earlybird_fulfillments WHERE order_id=$1',
            [signed.id])).rows).toEqual([{status:'awaiting_operator',enrolled:true}]);
        expect(await info(signed)).toMatchObject({waiting:true,startedAt:null});
        const backlog = await rpc('list_signed_paid_analysis_admissions_v1',{p_limit:20});
        expect(backlog.data).toContainEqual({order_id:signed.id});
        const later = await order(7, new Date(Date.now()+1000));
        await db.query("UPDATE earlybird_fulfillments SET status='manual_review',operator_admitted_at=now(),manual_review_at=now() WHERE order_id<>ALL($1::uuid[]) AND status IN ('admission_pending','analysis_in_progress')",[[signed.id,later.id]]);
        // The registered head stays visible until the worker takes it.
        expect(await info(signed)).toMatchObject({waiting:true,startedAt:null});
        expect(await claim(later.id)).toBe('waiting');
        const resumed = await rpc('recover_signed_paid_analysis_admission_v1',{p_order_id:signed.id,p_defer:false});
        expect(resumed.error).toBeNull();
        expect(await claim(signed.id)).toBe('ready');
        expect(await info(signed)).toMatchObject({waiting:false,expectedMaxMinutes:52,startedAt:expect.any(String)});
        expect(await claim(later.id)).toBe('waiting');
        await db.query("UPDATE earlybird_fulfillments SET status='manual_review',manual_review_at=now() WHERE order_id=$1", [signed.id]);
        expect(await claim(later.id)).toBe('ready');
        expect(await info(later)).toMatchObject({expectedMaxMinutes:39});
        const counts = await db.query(`SELECT sum(attempt_count)::int AS attempts,count(lease_token)::int AS leases,
            sum(lease_fence)::int AS fences FROM earlybird_fulfillments`);
        expect(counts.rows[0]).toEqual({attempts:0,leases:0,fences:0});
        expect((await db.client(source.owner).rpc('claim_paid_analysis_capacity_v1',{p_order_id:d.id})).error).toBeTruthy();
        expect((await db.client(null).rpc('load_paid_analysis_capacity_v1',{p_order_id:d.id,p_user_id:source.owner})).error).toBeTruthy();

        await db.exec(`UPDATE analysis_requests SET status='failed' WHERE status IN ('pending','processing');
            UPDATE earlybird_fulfillments SET status='manual_review',manual_review_at=now();
            UPDATE paid_analysis_capacity_policy SET max_active=3, validation_ref='three-shared-seats'`);
        const plusOrders = await Promise.all([0, 1, 2].map(async i => order(8 + i, new Date(Date.UTC(2026,0,1,1,i)), 'plus')));
        const fourth = await order(11, new Date(Date.UTC(2026,0,1,1,3)), 'standard');
        for (const p of plusOrders) expect(await claim(p.id)).toBe('ready');
        expect(await claim(fourth.id)).toBe('waiting');
        expect(await info(fourth)).toMatchObject({waiting:true,startedAt:null});
        await expect(db.query(`UPDATE earlybird_fulfillments SET lease_token=gen_random_uuid(),lease_expires_at=now()+interval '1 minute'
            WHERE order_id=$1`,[fourth.id])).rejects.toThrow('EARLYBIRD_ANALYSIS_CAPACITY_WAITING');
        await db.query("UPDATE earlybird_fulfillments SET status='manual_review',manual_review_at=now() WHERE order_id=$1",[plusOrders[0].id]);
        expect(await claim(fourth.id)).toBe('ready');
        const started = await info(fourth);
        expect(started).toMatchObject({waiting:false,startedAt:expect.any(String)});
        expect(await claim(fourth.id)).toBe('ready');
        expect(await info(fourth)).toEqual(started);
    } finally {
        await db.close();
    }
}, 60_000);
