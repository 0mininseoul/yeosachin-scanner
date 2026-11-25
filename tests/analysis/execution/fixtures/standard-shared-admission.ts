import { strict as assert } from 'node:assert';
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
const webhookSecret = 'synthetic-groble-webhook-shared-standard';
export const sharedStandardAdmissionEnv = {
    NEXT_PUBLIC_APP_URL: origin,
    ANALYSIS_V2_ADMISSION_ENABLED: 'true', PREFLIGHT_ACCESS_MODE: 'production',
    GROBLE_BASIC_PRODUCT_ID: 'shared-basic-fixture', GROBLE_STANDARD_PRODUCT_ID: standardProduct,
    GROBLE_BASIC_PAYMENT_ADDRESS: 'shared-basic-checkout', GROBLE_STANDARD_PAYMENT_ADDRESS: 'shared-standard-checkout',
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

const ioProfile = async (username: string) => {
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
        getProfile: ioProfile,
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
    return processAnalysisV2FreshAdmission(supabaseAdmin, { preflightId, generation, dispatchGeneration, dispatchToken }, { getProfile: ioProfile });
}

async function checkoutSharedOrder(run: Preflight, asOwner: AsOwner) {
    const { owner, preflightId } = run;
    return asOwner(owner, async () => {
        const patch = await setExclusion(request('/api/analysis/preflight/' + preflightId, { decision: 'skip' }, 'PATCH'), { params: Promise.resolve({ preflightId }) });
        assert.equal(patch.status, 204, 'Expected a persisted exclusion decision');
        const order = await checkout(request('/api/earlybird/checkout', { preflightId, planId: 'standard', disclosureAccepted: true }));
        if (order.status !== 200 && order.status !== 201) await responseJson(order, 201, 'checkout');
        return z.string().uuid().parse((await order.json()).orderId);
    });
}

async function confirmPayment(run: Preflight, orderId: string, db: StandardDatabase, mode: PaymentMode) {
    const paidAt = new Date().toISOString();
    const paymentId = 'fixture-payment-' + orderId;
    const eventId = 'fixture-event-' + orderId;
    const expectedAmount = EARLYBIRD_PLAN_CATALOG.standard.earlybirdAmountKrw;
    const { rows: [order] } = await db.query<{ reference: string }>(
        `SELECT groble_seller_reference AS reference FROM earlybird_orders WHERE id=$1 AND preflight_id=$2 AND user_id=$3
        AND status='payment_pending' AND plan_id='standard' AND expected_amount_krw=$4 AND expected_groble_product_id=$5`,
        [orderId, run.preflightId, run.owner.id, expectedAmount, standardProduct],
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
                    content: { id: standardProduct, paymentType: 'ONE_TIME', inputMode: 'PAYMENT_WINDOW' },
                    pricing: { currency: 'KRW', finalAmount: expectedAmount }, payment: { purchasedAt: paidAt }
                }
            },
        });
        const time = String(Math.floor(Date.now() / 1000));
        const response = await paymentWebhook(new Request(origin + '/api/webhooks/groble', {
            method: 'POST', headers: {
                'content-type': 'application/json', 'x-groble-timestamp': time, 'x-groble-idempotency-key': eventId,
                'x-groble-signature': createHmac('sha256', webhookSecret).update(time + '.' + payload).digest('hex'),
            }, body: payload
        }));
        assert.equal((await responseJson(response, 200, 'signed payment')).disposition, 'accepted');
    }
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
