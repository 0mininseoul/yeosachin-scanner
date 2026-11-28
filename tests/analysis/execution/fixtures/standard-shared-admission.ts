import { strict as assert } from 'node:assert';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { POST as startPreflight } from '@/app/api/analysis/preflight/route';
import { PATCH as setExclusion } from '@/app/api/analysis/preflight/[preflightId]/route';
import { POST as checkout } from '@/app/api/earlybird/checkout/route';
import { POST as paymentWebhook } from '@/app/api/webhooks/groble/route';
import { processPreflight } from '@/lib/services/analysis/preflight';
import { enqueuePrecheckoutBliteTask } from '@/lib/services/analysis/preflight-tasks';
import { runPrecheckoutBlite } from '@/lib/services/precheckout/blite-runner';
import { processAnalysisV2FreshAdmission } from '@/lib/services/analysis/fresh-plan-admission';
import { parseAnalysisV2WorkerTaskPayload } from '@/lib/services/analysis/v2-tasks';
import { admitAndAdvanceEarlybirdFulfillment, supabaseEarlybirdFulfillmentOperator } from '@/lib/services/earlybird/fulfillment-store';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { EARLYBIRD_PLAN_CATALOG } from '@/lib/domain/earlybird/catalog';
import { target, profileItem } from './standard-providers';
import type { StandardDatabase } from './standard-database';

const origin = 'https://shared-standard.example.invalid';
const standardProduct = 'shared-standard-fixture';
const plusProduct = 'shared-plus-fixture';
export const sharedPaidPlan = process.env.SHARED_STANDARD_PLAN === 'plus' ? 'plus' : 'standard';
const webhookSecret = 'synthetic-groble-webhook-shared-standard';
export const sharedStandardAdmissionEnv = {
    NEXT_PUBLIC_APP_URL: origin,
    ANALYSIS_V2_ADMISSION_ENABLED: 'true', PREFLIGHT_ACCESS_MODE: 'production',
    GROBLE_BASIC_PRODUCT_ID: 'shared-basic-fixture', GROBLE_STANDARD_PRODUCT_ID: standardProduct,
    GROBLE_BASIC_PAYMENT_ADDRESS: 'shared-basic-checkout', GROBLE_STANDARD_PAYMENT_ADDRESS: 'shared-standard-checkout',
    GROBLE_PLUS_PRODUCT_ID: plusProduct, GROBLE_PLUS_PAYMENT_ADDRESS: 'shared-plus-checkout',
    GROBLE_WEBHOOK_SECRET: webhookSecret, EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED: 'false',
};

export interface SharedStandardOwner {
    id: string;
    target: string;
    email: string;
    phone: string;
    identities: { provider: 'kakao'; identity_data: { email: string; email_verified: true } }[];
    app_metadata: { provider: 'kakao' };
}

type AsOwner = <T>(owner: SharedStandardOwner, operation: () => Promise<T>) => Promise<T>;
type Preflight = { owner: SharedStandardOwner; preflightId: string };
type PaymentMode = 'fixture' | 'webhook';
type AfterCallback = () => unknown;
const paymentAfter = new AsyncLocalStorage<AfterCallback[]>();

export function captureSharedPaymentAfter(task: AfterCallback | Promise<unknown>) {
    const callbacks = paymentAfter.getStore();
    if (!callbacks) return false;
    assert.ok(typeof task === 'function', 'The signed webhook must defer its work until after the HTTP response');
    callbacks.push(AsyncLocalStorage.bind(task));
    return true;
}

export async function completeWave<T>(tasks: Promise<T>[]) {
    const results = await Promise.allSettled(tasks);
    return results.map(result => {
        if (result.status === 'rejected') throw result.reason;
        return result.value;
    });
}

function request(path: string, body: object, method = 'POST', headers: Record<string, string> = {}) {
    return new Request(origin + path, {
        method, headers: { 'content-type': 'application/json', origin, ...headers }, body: JSON.stringify(body),
    });
}

async function responseJson(response: Response, status: number, step: string) {
    const body = await response.json();
    if (response.status !== status) {
        const safeCode = typeof body?.code === 'string' && /^[A-Z_0-9]+$/.test(body.code) ? body.code : 'UNEXPECTED';
        throw Error(`Shared Standard ${step}: HTTP ${response.status} (${safeCode})`);
    }
    return body;
}

export async function seedSharedStandardOwners(db: StandardDatabase, count = 16, requestTarget = target) {
    assert.ok(Number.isInteger(count) && count >= 1 && count <= 16);
    const { rows: [socket] } = await db.query<{ offline: boolean }>(
        "SELECT inet_server_addr() IS NULL AND current_setting('listen_addresses')='' AS offline",
    );
    assert.equal(socket?.offline, true, 'Only a disposable Unix-socket PostgreSQL fixture may seed buyers');
    return db.transaction(async tx => {
        await tx.query("INSERT INTO earlybird_plan_inventory(plan_id,sale_limit,sold_count) VALUES('basic',10,0),('standard',10,0) ON CONFLICT(plan_id) DO NOTHING");
        const owners: SharedStandardOwner[] = [];
        for (let index = 0; index < count; index++) {
            const id = randomUUID();
            const email = `shared-${id}@example.invalid`;
            const phone = '0100000' + String(index + 1).padStart(4, '0');
            const metadata = { provider: 'kakao' } as const;
            const identity = { provider: 'kakao', identity_data: { email, email_verified: true } } as const;
            await tx.query('INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES($1,$2,$3::jsonb)', [id, email, JSON.stringify(metadata)]);
            await tx.query('INSERT INTO auth.identities(user_id,provider,identity_data) VALUES($1,$2,$3::jsonb)', [id, identity.provider, JSON.stringify(identity.identity_data)]);
            await tx.query(`INSERT INTO public.users(id,email,provider,phone_number,phone_number_normalized,phone_number_verification_source,phone_number_verified_at)
                VALUES($1,$2,'kakao',$3::text,public.normalize_kr_mobile_e164($3::text),'kakao_rest_api',now()) ON CONFLICT(id) DO UPDATE SET
                phone_number=EXCLUDED.phone_number,phone_number_normalized=EXCLUDED.phone_number_normalized,
                phone_number_verification_source=EXCLUDED.phone_number_verification_source,phone_number_verified_at=EXCLUDED.phone_number_verified_at`,
                [id, email, phone]);
            owners.push({ id, email, phone, target: requestTarget, app_metadata: metadata, identities: [identity] });
        }
        return owners;
    });
}

export async function startSharedStandardPreflight(owner: SharedStandardOwner, asOwner: AsOwner): Promise<Preflight> {
    const headers = { 'x-anonymous-device-id': randomUUID(), 'idempotency-key': 'shared-standard:' + randomUUID() };
    const post = () => asOwner(owner, () => startPreflight(request('/api/analysis/preflight', { targetInstagramId: owner.target }, 'POST', headers)));
    const first = await responseJson(await post(), 202, 'preflight');
    const preflightId = z.string().uuid().parse(first.preflightId);
    const repeat = await responseJson(await post(), 200, 'preflight redelivery');
    assert.equal(repeat.preflightId, preflightId);
    return { owner, preflightId };
}

export const sharedPublicProfile = async (username: string) => {
    const item = profileItem(username, 1, Number(process.env.SHARED_STANDARD_PUBLIC ?? 1) + 1);
    return {
        username, followersCount: item.followersCount, followingCount: item.followsCount, postsCount: item.postsCount,
        isPrivate: false, isVerified: false, fullName: item.fullName, bio: item.biography, profilePicUrl: item.profilePicUrl
    };
};
const fence = z.object({ preflightId: z.string().uuid(), generation: z.number().int().positive(), reservationToken: z.string().uuid() });
const blite = z.object({ kind: z.literal('precheckout_blite'), preflightId: z.string().uuid(), dispatchGeneration: z.number().int().positive(), dispatchToken: z.string().uuid() });

export async function processSharedStandardPreflight(payload: unknown) {
    const task = fence.parse(payload);
    return processPreflight(task.preflightId, {
        dispatchFence: { generation: task.generation, reservationToken: task.reservationToken },
        getProfile: sharedPublicProfile,
        enqueueBliteInference: (id, dispatchGeneration, dispatchToken) => enqueuePrecheckoutBliteTask(id, { dispatchGeneration, dispatchToken }),
    });
}

export function processSharedStandardBlite(payload: unknown) {
    const task = blite.parse(payload);
    return runPrecheckoutBlite(task.preflightId, { dispatchGeneration: task.dispatchGeneration, dispatchToken: task.dispatchToken });
}

export function processSharedStandardFresh(payload: unknown) {
    const task = parseAnalysisV2WorkerTaskPayload(payload);
    if (!('kind' in task) || task.kind !== 'fresh_admission') throw Error('Expected fresh admission delivery');
    const { preflightId, generation, dispatchGeneration, dispatchToken } = task;
    return processAnalysisV2FreshAdmission(supabaseAdmin, { preflightId, generation, dispatchGeneration, dispatchToken }, { getProfile: sharedPublicProfile });
}

async function checkoutSharedOrder(run: Preflight, asOwner: AsOwner) {
    const { owner, preflightId } = run;
    return asOwner(owner, async () => {
        const patch = await setExclusion(request('/api/analysis/preflight/' + preflightId, { decision: 'skip' }, 'PATCH'), { params: Promise.resolve({ preflightId }) });
        assert.equal(patch.status, 204, 'Expected a persisted exclusion decision');
        const order = await checkout(request('/api/earlybird/checkout', { preflightId, planId: sharedPaidPlan, disclosureAccepted: true }));
        if (order.status !== 200 && order.status !== 201) await responseJson(order, 201, 'checkout');
        return z.string().uuid().parse((await order.json()).orderId);
    });
}

async function confirmPayment(run: Preflight, orderId: string, db: StandardDatabase, mode: PaymentMode, afterResponses?: AfterCallback[][]) {
    const paidAt = new Date().toISOString();
    const paymentId = 'fixture-payment-' + orderId;
    const eventId = 'fixture-event-' + orderId;
    const expectedAmount = EARLYBIRD_PLAN_CATALOG[sharedPaidPlan].earlybirdAmountKrw;
    const product = sharedPaidPlan === 'plus' ? plusProduct : standardProduct;
    const { rows: [order] } = await db.query<{ reference: string }>(
        `SELECT groble_seller_reference AS reference FROM earlybird_orders WHERE id=$1 AND preflight_id=$2 AND user_id=$3
        AND status='payment_pending' AND plan_id=$6 AND expected_amount_krw=$4 AND expected_groble_product_id=$5`,
        [orderId, run.preflightId, run.owner.id, expectedAmount, product, sharedPaidPlan],
    );
    assert.ok(order && /^ord\.[a-f0-9]{32}$/.test(order.reference), 'Expected owned pending checkout with a seller reference');
    if (mode === 'fixture') {
        // The 16-buyer capacity sample starts from paid evidence. Limited-presale numbering is
        // exercised separately through the signed webhook. The real table constraints stay active.
        await db.transaction(async tx => {
            const { rows } = await tx.query(`UPDATE earlybird_orders SET status='paid',payment_id=$2,paid_at=$3::timestamptz,
                due_at=$3::timestamptz + interval '24 hours',seller_reference_confirmed_at=$3::timestamptz,
                actual_amount_krw=expected_amount_krw,actual_groble_product_id=expected_groble_product_id
                WHERE id=$1 AND status='payment_pending' AND plan_sequence IS NULL RETURNING id`, [orderId, paymentId, paidAt]);
            assert.equal(rows.length, 1);
            const payload = JSON.stringify({ fixture: 'standard-capacity', amount: expectedAmount });
            await tx.query(`SELECT record_payment_event_v1($1,$1,'payment.completed',$2,$3,'groble','accepted',$4,$5::jsonb,$6,$7)`,
                [eventId, paymentId, orderId, createHash('sha256').update(payload).digest('hex'), payload, paidAt, expectedAmount]);
            await tx.query('SELECT enqueue_earlybird_fulfillment($1)', [orderId]);
        });
    } else {
        const payload = JSON.stringify({
            id: eventId, type: 'payment.completed', version: '2026-04-21', occurredAt: paidAt,
            data: {
                object: {
                    merchantUid: paymentId, sellerReference: order.reference, buyer: { email: run.owner.email, phoneNumber: run.owner.phone },
                    content: { id: product, paymentType: 'ONE_TIME', inputMode: 'PAYMENT_WINDOW' },
                    pricing: { currency: 'KRW', finalAmount: expectedAmount }, payment: { purchasedAt: paidAt }
                }
            },
        });
        const time = String(Math.floor(Date.now() / 1000));
        const deliver = () => paymentWebhook(new Request(origin + '/api/webhooks/groble', {
            method: 'POST', headers: {
                'content-type': 'application/json', 'x-groble-timestamp': time, 'x-groble-idempotency-key': eventId,
                'x-groble-signature': createHmac('sha256', webhookSecret).update(time + '.' + payload).digest('hex'),
            }, body: payload
        }));
        const submit = () => {
            if (!afterResponses) return deliver();
            const callbacks: AfterCallback[] = [];
            afterResponses.push(callbacks);
            return paymentAfter.run(callbacks, deliver);
        };
        assert.equal((await responseJson(await submit(), 200, 'signed payment')).disposition, 'accepted');
        if (afterResponses) {
            assert.equal((await responseJson(await submit(), 200, 'signed payment redelivery')).disposition, 'duplicate_event');
        }
    }
}

export async function prepareSharedAutomaticOrders(runs: Preflight[], asOwner: AsOwner, db: StandardDatabase) {
    const orders = await completeWave(runs.map(async run => {
        const orderId = await checkoutSharedOrder(run, asOwner);
        const responses: AfterCallback[][] = [];
        await confirmPayment(run, orderId, db, 'webhook', responses);
        assert.equal(responses.length, 2);
        assert.ok(responses.every(callbacks => callbacks.length > 0), 'Each webhook must schedule deferred work');
        return { ...run, orderId, responses };
    }));
    const orderIds = orders.map(order => order.orderId);
    const counts = async () => (await db.query<{ registered: number; active: number; requested: number }>(
        `SELECT count(*) FILTER (WHERE capacity_queued_at IS NOT NULL)::int AS registered,
            count(capacity_acquired_at)::int AS active, count(request_id)::int AS requested
            FROM earlybird_fulfillments WHERE order_id=ANY($1::uuid[])`, [orderIds],
    )).rows[0];
    const beforeAfter = await counts();
    assert.deepEqual(beforeAfter, { registered: runs.length, active: 0, requested: 0 });
    // Keep each request's deferred effects attached to its response. Other buyers
    // advance concurrently, including their duplicate signed delivery.
    await completeWave(orders.map(async ({ responses }) => {
        for (const callbacks of responses) await completeWave(callbacks.map(async callback => callback()));
    }));
    const afterDrain = await counts();
    assert.deepEqual(afterDrain, { registered: runs.length, active: runs.length, requested: 0 });
    return {
        orders: orders.map(({ owner, preflightId, orderId }) => ({ owner, preflightId, orderId })),
        evidence: { signed: runs.length, redeliveries: runs.length, afterResponses: orders.reduce((n, o) => n + o.responses.length, 0),
            beforeAfter, afterDrain },
    };
}

export async function readSharedAutomaticOrders(
    orders: (Preflight & { orderId: string })[], db: StandardDatabase,
) {
    const rows = (await db.query<{ order_id: string; request_id: string }>(
        `SELECT f.order_id, r.id AS request_id
        FROM earlybird_fulfillments f JOIN earlybird_orders o ON o.id=f.order_id AND o.result_request_id=f.request_id
        JOIN analysis_requests r ON r.id=f.request_id AND r.user_id=o.user_id AND r.preflight_id=o.preflight_id
        JOIN analysis_preflights p ON p.id=r.preflight_id AND p.consumed_request_id=r.id
            AND p.admission_generation=1 AND p.admission_dispatch_generation=1
        WHERE f.order_id=ANY($1::uuid[]) AND f.status='analysis_in_progress'
          AND f.capacity_acquired_at IS NOT NULL AND o.status='analysis_in_progress'`, [orders.map(order => order.orderId)],
    )).rows;
    const requestByOrder = new Map(rows.map(row => [row.order_id, row.request_id]));
    assert.equal(requestByOrder.size, orders.length);
    return orders.map(order => ({ ...order, requestId: z.string().uuid().parse(requestByOrder.get(order.orderId)) }));
}

// Probe the real callback with reversible local mutations, before consuming its one valid generation.
export async function checkSharedReadyHandoffFences(db: StandardDatabase, args: {
    p_preflight_id: string; p_generation: number; p_dispatch_generation: number; p_dispatch_token: string;
}) {
    const values = [args.p_preflight_id, args.p_generation, args.p_dispatch_generation, args.p_dispatch_token];
    return db.transaction(async tx => {
        const handoff = async (bindings: unknown[]) => (await tx.query<{ request: string | null }>(
            'SELECT public.handoff_ready_signed_paid_fulfillment_v1($1,$2,$3,$4) AS request', bindings)).rows[0]!.request;
        const acl = (await tx.query<{ allowed: boolean }>(`
            SELECT has_function_privilege('service_role',fn,'EXECUTE') AND NOT has_function_privilege('authenticated',fn,'EXECUTE')
                AND NOT has_function_privilege('anon',fn,'EXECUTE') AS allowed
            FROM (VALUES ('public.handoff_ready_signed_paid_fulfillment_v1(uuid,integer,integer,uuid)')) v(fn)
        `)).rows[0]!.allowed;
        assert.ok(acl);
        assert.equal(await handoff([randomUUID(), ...values.slice(1)]), null);
        assert.equal(await handoff([values[0],args.p_generation+1,...values.slice(2)]), null);
        assert.equal(await handoff([values[0],values[1],args.p_dispatch_generation+1,values[3]]), null);
        assert.equal(await handoff([...values.slice(0,3),randomUUID()]), null);
        for (const sql of [
            "UPDATE earlybird_orders SET status='refund_pending' WHERE preflight_id=$1",
            "UPDATE earlybird_fulfillments SET capacity_acquired_at=NULL WHERE order_id=(SELECT id FROM earlybird_orders WHERE preflight_id=$1)",
        ]) {
            await tx.exec('SAVEPOINT handoff_probe');
            await tx.query(sql, [values[0]]);
            assert.equal(await handoff(values), null);
            await tx.exec('ROLLBACK TO SAVEPOINT handoff_probe');
            await tx.exec('RELEASE SAVEPOINT handoff_probe');
        }
        return true;
    });
}

export async function prepareSharedStandardOrder(
    run: Preflight, asOwner: AsOwner,
    options: { db: StandardDatabase; payment: PaymentMode },
) {
    const orderId = await checkoutSharedOrder(run, asOwner);
    await confirmPayment(run, orderId, options.db, options.payment);
    // The paid fulfillment CLI binds this credential before admitting the order.
    await supabaseEarlybirdFulfillmentOperator.bindCredentialSlot(orderId, 'secondary');
    const admitted = await admitAndAdvanceEarlybirdFulfillment(orderId);
    assert.equal(admitted.nextAction, 'wait_for_fresh_admission');
    return { ...run, orderId };
}

export async function admitSharedStandard(run: Preflight & { orderId: string }) {
    const { orderId } = run;
    const accepted = await admitAndAdvanceEarlybirdFulfillment(orderId);
    assert.equal(accepted.nextAction, 'monitor_analysis');
    const requestId = z.string().uuid().parse(accepted.requestId);
    const replay = await admitAndAdvanceEarlybirdFulfillment(orderId);
    assert.equal(replay.requestId, requestId);
    return { ...run, orderId, requestId };
}
