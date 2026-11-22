import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const migration = readFileSync(new URL(
    '../../supabase/migrations/20261123120000_create_cherry_service.sql', import.meta.url,
), 'utf8');
const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
let db: PGlite;

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
    return (await db.query<T>(sql, params)).rows[0];
}
async function rpc<T = Record<string, unknown>>(call: string, params: unknown[] = []): Promise<T> {
    return (await one<{ value: T }>(`select public.${call} as value`, params)).value;
}

beforeAll(async () => {
    db = await PGlite.create();
    await db.exec(`
        create role anon nologin; create role authenticated nologin; create role service_role nologin;
        create table public.users (
            id uuid primary key, email text, provider text, lifecycle text not null default 'active',
            phone_number_normalized text, phone_number_verification_source text
        );
        create table public.namchin_launch_reservations (
            email text primary key, phone text not null unique, consented_at timestamptz not null default now()
        );
    `);
    await db.exec(migration);
}, 60_000);
afterAll(async () => db.close());

beforeEach(async () => {
    await db.exec(`
        truncate public.cherry_notifications, public.cherry_mutual_events, public.cherry_reports, public.cherry_relations,
            public.cherry_checks, public.cherry_refunds, public.cherry_payments, public.cherry_payment_events,
            public.cherry_provider_runs, public.cherry_subscriptions, public.cherry_target_checks,
            public.cherry_reservation_claims, public.cherry_target_blocks, public.cherry_capacity_waitlist,
            public.cherry_billing_keys, public.users, public.namchin_launch_reservations cascade;
        insert into public.users (id, email, provider, phone_number_normalized, phone_number_verification_source) values
            ('${USER}', 'me@example.com', 'kakao', '+821011112222', 'kakao_rest_api'),
            ('${OTHER}', 'other@example.com', 'kakao', '+821033334444', 'kakao_rest_api');
        update public.cherry_settings set sales_enabled = true, tester_user_ids = '{}', monitoring_enabled = true, notifications_enabled = true,
            auto_refund_enabled = false, payment_provider = 'groble', max_active_runs = 3,
            apify_limit_usd = 100, apify_usage_usd = 10, apify_observed_at = now();
        update public.cherry_offers set active = true, groble_product_id = 'prod_' || code, groble_payment_address = 'pay_' || code;
    `);
});

async function targetCheck(user: string | null = null, followers = 400, following = 300): Promise<string> {
    const row = await one<{ id: string }>(`
        insert into public.cherry_target_checks (user_id, username, status, result_code, instagram_id, followers_count, following_count)
        values ($1, 'target_user', 'done', 'ok', '9001', $2, $3) returning id`, [user, followers, following]);
    return row.id;
}
async function checkout(user = USER) {
    const offer = await one<{ price_krw: number }>('select price_krw from public.cherry_resolve_offer($1)', [user]);
    return rpc<Record<string, string & number>>('cherry_begin_checkout($1, $2, $3, $4)', [user, await targetCheck(), 'v1', offer?.price_krw ?? 0]);
}
async function renew(amount = 9900) {
    return rpc<Record<string, unknown>>('cherry_begin_renewal($1, $2)', [USER, amount]);
}
async function pay(order: Record<string, unknown>, event = 'evt_1', payment = 'pay_1', overrides: Record<string, unknown> = {}) {
    return rpc<{ disposition: string }>('cherry_record_payment($1,$2,$3,$4,$5,$6,now(),null)', [
        event, 'groble', order.orderRef, payment, overrides.product ?? `prod_${overrides.offer ?? 'standard'}`,
        overrides.amount ?? order.amountKrw,
    ]);
}
async function claimOne() {
    return one<{ id: string; lease_token: string; subscription_id: string; kind: string }>(
        'select * from public.cherry_claim_checks(5, 300)');
}
function relation(id: string, follower: boolean, following: boolean, extra: Record<string, unknown> = {}) {
    return { id, username: `u${id}`, full_name: null, is_private: false, is_verified: false, follower, following,
        follower_new: false, following_new: false, follower_misses: 0, following_misses: 0,
        follower_missing_since: null, following_missing_since: null, ...extra };
}
async function activate() {
    const order = await checkout();
    await pay(order);
    const check = await claimOne();
    await rpc('cherry_apply_check($1,$2,$3)', [check.id, check.lease_token, JSON.stringify({
        followers: { count: 2, gap: 0 }, following: { count: 1, gap: 0 }, items: 3, mutuals: 1,
        relations: [relation('1', true, true), relation('2', true, false)], events: [],
    })]);
    return { order, subscriptionId: String(order.subscriptionId) };
}

describe('cherry checkout and payment', () => {
    it('stays closed until sales are switched on and needs a verified phone', async () => {
        await db.exec('update public.cherry_settings set sales_enabled = false');
        expect((await checkout()).outcome).toBe('sales_closed');
        await db.exec(`update public.cherry_settings set tester_user_ids = '{${USER}}'`);
        expect((await checkout()).outcome).toBe('ready');
        expect((await checkout(OTHER)).outcome).toBe('sales_closed');
        await db.exec('update public.cherry_settings set sales_enabled = true');
        await db.exec(`update public.users set phone_number_normalized = null where id = '${USER}'`);
        expect((await checkout()).outcome).toBe('phone_required');
    });

    it('charges the list price, and 4,900 for one year to one member per reservation', async () => {
        expect((await checkout()).amountKrw).toBe(9900);
        await db.exec(`insert into public.namchin_launch_reservations (email, phone) values ('other@example.com', '+821011112222')`);
        const order = await checkout();
        expect(order.amountKrw).toBe(4900);
        expect((await pay(order, 'evt_r', 'pay_r', { offer: 'reservation' })).disposition).toBe('activated');
        const lock = await one<{ months: number }>(`select round(extract(epoch from price_lock_until - first_paid_at) / 86400) as months
            from public.cherry_subscriptions where user_id = '${USER}'`);
        expect([365, 366]).toContain(Number(lock.months));
        // The same reservation also matches the other member's email, but it is already used.
        expect((await checkout(OTHER)).amountKrw).toBe(9900);
    });

    it('holds a reservation for the member who is checking out with it', async () => {
        await db.exec(`insert into public.namchin_launch_reservations (email, phone) values ('other@example.com', '+821011112222')`);
        const mine = await checkout();
        expect(mine.amountKrw).toBe(4900);
        expect((await checkout(OTHER)).amountKrw).toBe(9900);
        expect((await checkout()).orderRef).toBe(mine.orderRef);
        await db.exec(`update public.cherry_reservation_claims set locked_until = now() - interval '1 minute'`);
        const theirs = await checkout(OTHER);
        expect(theirs.amountKrw).toBe(4900);
        await pay(theirs, 'evt_o', 'pay_o', { offer: 'reservation' });
        // The expired holder still gets the price already shown, but not the year.
        expect((await pay(mine, 'evt_m', 'pay_m', { offer: 'reservation' })).disposition).toBe('activated');
        const locks = await db.query<{ locked: boolean }>('select price_lock_until is not null as locked from public.cherry_subscriptions order by user_id');
        expect(locks.rows.map(row => row.locked)).toEqual([false, true]);
    });

    it('never charges a price the member did not see', async () => {
        expect(await rpc('cherry_begin_checkout($1,$2,$3,$4)', [USER, await targetCheck(), 'v1', 4900])).toEqual({ outcome: 'price_changed', amountKrw: 9900 });
    });

    it('refuses to sell when the shared budget cannot cover the first list', async () => {
        await db.exec('update public.cherry_settings set apify_limit_usd = 25.2, apify_usage_usd = 10');
        expect((await checkout()).outcome).toBe('capacity_wait');
        expect((await one<{ n: number }>('select count(*)::int as n from public.cherry_capacity_waitlist')).n).toBe(1);
        await db.exec(`update public.cherry_settings set apify_limit_usd = 100, apify_observed_at = now() - interval '2 hours'`);
        expect((await checkout()).outcome).toBe('capacity_wait');
    });

    it('activates once for repeated webhooks and keeps mismatches for review', async () => {
        const order = await checkout();
        expect((await checkout()).orderRef).toBe(order.orderRef);
        expect((await pay(order, 'evt_bad', 'pay_bad', { amount: 100 })).disposition).toBe('review');
        const retry = await checkout();
        expect(retry.orderRef).not.toBe(order.orderRef);
        expect((await pay(retry, 'evt_1', 'pay_1')).disposition).toBe('activated');
        expect((await pay(retry, 'evt_1', 'pay_1')).disposition).toBe('duplicate_event');
        expect((await pay(retry, 'evt_2', 'pay_1')).disposition).toBe('duplicate_payment');
        expect((await pay(retry, 'evt_3', 'pay_2')).disposition).toBe('unmatched');
        expect((await one<{ n: number }>(`select count(*)::int as n from public.cherry_checks where kind = 'baseline'`)).n).toBe(1);
        expect((await checkout()).outcome).toBe('already_subscribed');
    });

    it('records the refund of a duplicate payment without touching the paid service', async () => {
        const first = await checkout();
        await db.exec(`update public.cherry_offers set price_krw = 8900 where code = 'standard'`);
        const second = await checkout();
        await db.exec(`update public.cherry_offers set price_krw = 9900 where code = 'standard'`);
        expect((await pay(second, 'evt_2', 'pay_2')).disposition).toBe('activated');
        expect((await pay(first, 'evt_1', 'pay_1')).disposition).toBe('review');
        expect((await rpc<{ disposition: string }>('cherry_record_refund($1,$2,$3,$4,$5)', ['evt_r', 'groble', 'pay_1', 9900, false])).disposition).toBe('refunded');
        expect((await one<{ status: string }>('select status from public.cherry_subscriptions')).status).toBe('preparing');
    });

    it('returns to the earlier paid period when an early renewal is refunded', async () => {
        const { subscriptionId } = await activate();
        await db.exec(`update public.cherry_subscriptions set current_period_end = now() + interval '5 days'; update public.cherry_payments set period_end = now() + interval '5 days'`);
        await pay(await renew(), 'evt_n', 'pay_n');
        await rpc('cherry_record_refund($1,$2,$3,$4,$5)', ['evt_nr', 'groble', 'pay_n', 9900, false]);
        const row = await one<{ status: string; days: number }>(`select status, round(extract(epoch from current_period_end - now()) / 86400)::int as days
            from public.cherry_subscriptions where id = $1`, [subscriptionId]);
        expect(row).toEqual({ status: 'active', days: 5 });
    });

    it('ends the service on a full refund and leaves an unknown refund unmatched', async () => {
        const { subscriptionId } = await activate();
        expect((await rpc<{ disposition: string }>('cherry_record_refund($1,$2,$3,$4,$5)',
            ['evt_x', 'groble', 'nope', 9900, false])).disposition).toBe('unmatched');
        expect((await rpc<{ disposition: string }>('cherry_record_refund($1,$2,$3,$4,$5)',
            ['evt_y', 'groble', 'pay_1', 9900, false])).disposition).toBe('refunded');
        expect((await one<{ status: string }>('select status from public.cherry_subscriptions where id = $1', [subscriptionId])).status).toBe('ended');
    });
});

describe('cherry checks', () => {
    it('starts the paid month when the first list is stored, and fences stale workers', async () => {
        const { subscriptionId } = await activate();
        const subscription = await one<Record<string, unknown>>('select * from public.cherry_subscriptions where id = $1', [subscriptionId]);
        expect(subscription.status).toBe('active');
        expect(subscription.current_period_end).not.toBeNull();
        expect((await one<{ n: number }>(`select count(*)::int as n from public.cherry_notifications where kind = 'baseline_ready'`)).n).toBe(1);

        await db.exec(`update public.cherry_subscriptions set next_check_at = now() - interval '1 minute'`);
        expect(await rpc('cherry_enqueue_due(now())')).toEqual({ checks: 1 });
        expect(await rpc('cherry_enqueue_due(now())')).toEqual({ checks: 0 });
        const check = await claimOne();
        expect(check.kind).toBe('daily');
        expect(await claimOne()).toBeUndefined();
        await expect(rpc('cherry_apply_check($1,$2,$3)', [check.id, OTHER, '{}'])).rejects.toThrow('CHERRY_CHECK_FENCE');
    });

    it('groups one day of new mutuals into one report and one notice', async () => {
        const { subscriptionId } = await activate();
        await db.exec(`update public.cherry_subscriptions set next_check_at = now() - interval '1 minute'`);
        await rpc('cherry_enqueue_due(now())');
        const check = await claimOne();
        const event = (id: string, kind: string) => ({ id, username: `u${id}`, full_name: null, is_private: false, is_verified: false, kind, certainty: 'confirmed', position: 0 });
        const applied = await rpc<{ newEvents: number; reportId: string }>('cherry_apply_check($1,$2,$3)', [check.id, check.lease_token, JSON.stringify({
            following: { count: 3, gap: 1 }, items: 50, relations: [relation('2', true, true, { following_new: true }),
                relation('3', true, true, { following_new: true })],
            events: [event('2', 'new'), event('3', 'new'), event('4', 'supplement')],
        })]);
        expect(applied.newEvents).toBe(2);
        const report = await one<{ id: string; lease_token: string }>('select * from public.cherry_claim_reports(5, 60)');
        expect(await rpc('cherry_finish_report($1,$2)', [report.id, report.lease_token])).toBe(true);
        expect(await rpc('cherry_finish_report($1,$2)', [report.id, report.lease_token])).toBe(false);
        expect((await one<{ n: number }>(`select count(*)::int as n from public.cherry_notifications where kind = 'new_mutual'`)).n).toBe(1);
        expect((await one<{ n: number }>(`select count(*)::int as n from public.cherry_mutual_events where report_id is not null`)).n).toBe(2);
        // The direction that was not read keeps its earlier count.
        expect(await one('select items_used, followers_count, following_count, following_gap from public.cherry_subscriptions where id = $1', [subscriptionId]))
            .toEqual({ items_used: 50, followers_count: 2, following_count: 3, following_gap: 1 });
    });

    it('confirms a private target twice before ending with a prorated refund', async () => {
        const { subscriptionId } = await activate();
        await db.exec(`update public.cherry_subscriptions set next_check_at = now() - interval '1 minute',
            current_period_start = now() - interval '15 days', current_period_end = now() + interval '15 days';
            update public.cherry_payments set period_start = now() - interval '15 days', period_end = now() + interval '15 days'`);
        await rpc('cherry_enqueue_due(now())');
        let check = await claimOne();
        expect(await rpc('cherry_mark_unavailable($1,$2,$3,$4)', [check.id, check.lease_token, 'private', 3600])).toEqual({ confirmed: false });
        expect(await claimOne()).toBeUndefined();
        await db.exec(`update public.cherry_checks set run_after = now(); update public.cherry_subscriptions set unavailable_since = now() - interval '2 hours'`);
        check = await claimOne();
        const result = await rpc<{ confirmed: boolean; refundKrw: number }>('cherry_mark_unavailable($1,$2,$3,$4)', [check.id, check.lease_token, 'private', 3600]);
        expect(result.confirmed).toBe(true);
        expect(result.refundKrw).toBeGreaterThan(4900);
        expect(result.refundKrw).toBeLessThan(5000);
        const refund = await one<{ status: string }>('select status from public.cherry_refunds where subscription_id = $1', [subscriptionId]);
        expect(refund.status).toBe('manual_required');
        await expect(rpc('cherry_end_with_refund($1,$2)', [subscriptionId, 'operator'])).resolves.toMatchObject({ ended: false });
    });

    it('lets a member stop the next charge, and cancel in full only when the first list is a day late', async () => {
        const order = await checkout();
        await pay(order);
        expect(await rpc('cherry_member_action($1,$2)', [USER, 'cancel_preparing'])).toEqual({ outcome: 'not_allowed' });
        await db.exec(`update public.cherry_subscriptions set first_paid_at = now() - interval '25 hours'`);
        expect(await rpc('cherry_member_action($1,$2)', [USER, 'cancel_preparing'])).toMatchObject({ outcome: 'done', ended: true, refundKrw: 9900 });
        expect((await one<{ amount_krw: number }>('select amount_krw from public.cherry_refunds')).amount_krw).toBe(9900);
    });

    it('ends a granted month without billing or refunding it', async () => {
        const granted = await rpc<{ outcome: string; subscriptionId: string }>('cherry_grant($1,$2,$3)', [USER, await targetCheck(), 'v1']);
        expect(granted.outcome).toBe('granted');
        const check = await claimOne();
        await rpc('cherry_apply_check($1,$2,$3)', [check.id, check.lease_token, JSON.stringify({
            followers: { count: 1, gap: 0 }, following: { count: 1, gap: 0 }, items: 2, mutuals: 1, relations: [relation('1', true, true)], events: [],
        })]);
        await db.exec(`update public.cherry_subscriptions set current_period_end = now() - interval '1 minute'`);
        await rpc('cherry_enqueue_due(now())');
        expect(await one('select status, status_reason from public.cherry_subscriptions where id = $1', [granted.subscriptionId]))
            .toEqual({ status: 'ended', status_reason: 'canceled' });
        expect((await one<{ n: number }>('select (select count(*) from public.cherry_payments) + (select count(*) from public.cherry_refunds) as n')).n).toBe(0);
    });

    it('lets an operator look again without reusing earlier runs', async () => {
        const { subscriptionId } = await activate();
        expect(await rpc('cherry_operator_requeue($1)', [subscriptionId])).toEqual({ outcome: 'queued' });
        const check = await claimOne();
        expect(check).toMatchObject({ kind: 'daily', series: 1 });
        expect(await rpc('cherry_operator_requeue($1)', [subscriptionId])).toEqual({ outcome: 'running' });
    });

    it('refunds both periods after an early renewal, and drops yesterday\'s unfinished check', async () => {
        const { subscriptionId } = await activate();
        await db.exec(`update public.cherry_subscriptions set current_period_start = now() - interval '24 days', current_period_end = now() + interval '6 days';
            update public.cherry_payments set period_start = now() - interval '24 days', period_end = now() + interval '6 days'`);
        const renewal = await renew();
        expect((await pay(renewal, 'evt_early', 'pay_early')).disposition).toBe('renewed');
        await db.exec(`insert into public.cherry_checks (subscription_id, kind, check_date, created_at)
            values ('${subscriptionId}', 'daily', current_date - 1, now() - interval '21 hours')`);
        expect(await claimOne()).toBeUndefined();
        const { refundKrw } = await rpc<{ refundKrw: number }>('cherry_end_with_refund($1,$2)', [subscriptionId, 'target_private']);
        expect([1979 + 9900, 1980 + 9900]).toContain(refundKrw);
        expect((await one<{ n: number }>('select count(*)::int as n from public.cherry_refunds')).n).toBe(2);
    });

    it('moves a pass to automatic billing at its next renewal, and lets a declined card be replaced', async () => {
        const { subscriptionId } = await activate();
        await db.exec(`update public.cherry_settings set payment_provider = 'toss'; update public.cherry_subscriptions set current_period_end = now() + interval '1 day'`);
        const renewal = await renew();
        expect(renewal).toMatchObject({ outcome: 'ready', provider: 'toss', amountKrw: 9900 });
        await rpc('cherry_record_payment($1,$2,$3,$4,$5,$6,now(),null)', ['toss:1', 'toss', renewal.orderRef, 'tpay_1', null, 9900]);
        expect((await one<{ payment_provider: string }>('select payment_provider from public.cherry_subscriptions where id = $1', [subscriptionId])).payment_provider).toBe('toss');
        expect(await renew()).toEqual({ outcome: 'ready', provider: 'toss', amountKrw: 0 });
        await db.exec(`update public.cherry_subscriptions set current_period_end = now() - interval '1 minute'`);
        const charge = await one<{ id: string }>('select * from public.cherry_claim_billing(5)');
        await rpc('cherry_fail_payment($1,$2)', [charge.id, 'EXPIRED_CARD']);
        expect(await renew()).toMatchObject({ outcome: 'ready', provider: 'toss', amountKrw: 9900 });
        await db.exec('update public.cherry_subscriptions set billing_next_attempt_at = now()');
        expect(await one('select * from public.cherry_claim_billing(5)')).toMatchObject({ status: 'processing' });
    });

    it('keeps the paid period when an early renewal card is declined', async () => {
        const { subscriptionId } = await activate();
        await db.exec(`update public.cherry_settings set payment_provider = 'toss'; update public.cherry_subscriptions set current_period_end = now() + interval '5 days'`);
        const renewal = await renew();
        await rpc('cherry_fail_payment($1,$2)', [renewal.paymentId, 'REJECT_CARD_PAYMENT']);
        expect((await one<{ status: string }>('select status from public.cherry_subscriptions where id = $1', [subscriptionId])).status).toBe('active');
        expect((await one<{ n: number }>(`select count(*)::int as n from public.cherry_notifications where kind = 'payment_failed'`)).n).toBe(0);
    });

    it('tells a member without a price lock before a higher charge, and closes a plan billing cannot reach', async () => {
        const { subscriptionId } = await activate();
        await db.exec(`update public.cherry_subscriptions set payment_provider = 'toss', price_krw = 5900, current_period_end = now() + interval '3 days'`);
        await rpc('cherry_enqueue_due(now())');
        expect((await one<{ n: number }>(`select count(*)::int as n from public.cherry_notifications where kind = 'price_change'`)).n).toBe(1);
        await db.exec(`update public.cherry_subscriptions set current_period_end = now() - interval '2 days'`);
        await rpc('cherry_enqueue_due(now())');
        expect((await one<{ status: string }>('select status from public.cherry_subscriptions where id = $1', [subscriptionId])).status).toBe('past_due');
        await db.exec(`update public.cherry_subscriptions set current_period_end = now() - interval '5 days'`);
        await rpc('cherry_enqueue_due(now())');
        expect((await one<{ status: string }>('select status from public.cherry_subscriptions where id = $1', [subscriptionId])).status).toBe('ended');
    });

    it('forgets a checkout that was never paid', async () => {
        await checkout();
        await db.exec(`update public.cherry_subscriptions set updated_at = now() - interval '8 days'`);
        await rpc('cherry_retention_batch(10)');
        expect(await one('select status, recipient_phone, target_username from public.cherry_subscriptions')).toEqual({ status: 'ended', recipient_phone: null, target_username: 'purged' });
    });

    it('lapses an unrenewed pass, then ends it after the grace period', async () => {
        const { subscriptionId } = await activate();
        await db.exec(`update public.cherry_subscriptions set current_period_end = now() - interval '1 minute'`);
        await rpc('cherry_enqueue_due(now())');
        expect((await one<{ status: string }>('select status from public.cherry_subscriptions where id = $1', [subscriptionId])).status).toBe('past_due');
        const renewal = await renew();
        expect(renewal.outcome).toBe('ready');
        expect((await pay(renewal, 'evt_renew', 'pay_renew')).disposition).toBe('renewed');
        const renewed = await one<{ status: string; followers_listed_at: string | null }>('select status, followers_listed_at from public.cherry_subscriptions where id = $1', [subscriptionId]);
        expect(renewed).toMatchObject({ status: 'active', followers_listed_at: null });
        await db.exec(`update public.cherry_subscriptions set current_period_end = now() - interval '5 days'`);
        await rpc('cherry_enqueue_due(now())');
        expect((await one<{ status: string }>('select status from public.cherry_subscriptions where id = $1', [subscriptionId])).status).toBe('ended');
    });
});

describe('cherry provider ledger and messages', () => {
    const reserve = (owner: string, charge = 0.5, reuse = 3600) => rpc<{ outcome: string; id: string; attempt: number }>(
        'cherry_reserve_run($1,$2,$3,$4,$5,$6,$7,$8)', [`check:${owner}`, 'followers_s0', null, 'secondary', 'actor', 100, charge, reuse]);

    it('limits active runs, keeps the analyzer reserve, and never repeats an unknown start', async () => {
        const ids = ['a', 'b', 'c', 'd'].map(letter => `${letter.repeat(8)}-0000-4000-8000-000000000000`);
        for (const id of ids.slice(0, 3)) expect((await reserve(id)).outcome).toBe('reserved');
        expect((await reserve(ids[3])).outcome).toBe('capacity');
        expect((await reserve(ids[0])).outcome).toBe('busy');
        await db.exec(`update public.cherry_provider_runs set created_at = now() - interval '40 minutes'`);
        expect((await reserve(ids[0])).outcome).toBe('reserved');
        await db.exec(`update public.cherry_provider_runs set created_at = now() - interval '40 minutes' where attempt = 2`);
        expect((await reserve(ids[0])).outcome).toBe('ambiguous');
        await db.exec('update public.cherry_settings set apify_usage_usd = 84.8');
        expect((await reserve(ids[3])).outcome).toBe('budget');
    });

    it('counts spending that the last balance reading could not include', async () => {
        await db.exec('update public.cherry_settings set apify_usage_usd = 83, apify_observed_at = now()');
        for (const [index, outcome] of ['reserved', 'budget'].entries()) {
            const run = await reserve(`${index}`.repeat(8) + '-0000-4000-8000-000000000000', 1.275);
            expect(run.outcome).toBe(outcome);
            if (run.id) await db.query(`update public.cherry_provider_runs set status = 'succeeded', run_id = $2, estimated_cost_usd = 1.0,
                finished_at = now() + interval '1 second' where id = $1`, [run.id, `run0000${index}`]);
        }
    });

    it('buys a list again only after its reuse time, and stops after five unusable runs', async () => {
        const owner = 'f'.repeat(8) + '-0000-4000-8000-000000000000';
        const first = await reserve(owner);
        await db.query(`update public.cherry_provider_runs set status = 'succeeded', run_id = 'runaaaaa', finished_at = now() - interval '2 hours' where id = $1`, [first.id]);
        expect((await reserve(owner, 0.5, 3 * 3600)).outcome).toBe('resume');
        expect(await reserve(owner, 0.5, 3600)).toMatchObject({ outcome: 'reserved', attempt: 1 });
        for (let index = 0; index < 5; index += 1) {
            await db.query(`update public.cherry_provider_runs set status = 'failed', finished_at = now() where owner_key = $1 and status = 'reserved'`, [`check:${owner}`]);
            if (index < 4) expect(await reserve(owner, 0.5, 60)).toMatchObject({ outcome: 'reserved', attempt: index + 2 });
        }
        expect((await reserve(owner, 0.5, 60)).outcome).toBe('exhausted');
    });

    it('counts unusable lists toward the month', async () => {
        const { subscriptionId } = await activate();
        const check = '33333333-3333-4333-8333-333333333333';
        await db.query(`insert into public.cherry_provider_runs (owner_key, operation, attempt, subscription_id, credential_slot, actor_id, requested_items, max_charge_usd, status, items_returned)
            values ('check:${check}', 'followers_s0', 1, $1, 'secondary', 'a', 800, 1, 'failed', 700),
                ('check:${check}', 'followers_s0', 2, $1, 'secondary', 'a', 800, 1, 'succeeded', 750),
                ('check:44444444-4444-4444-8444-444444444444', 'following_s0', 1, $1, 'secondary', 'a', 800, 1, 'succeeded', 600),
                ('check:44444444-4444-4444-8444-444444444444', 'profile_s0', 1, $1, 'secondary', 'a', 2, 1, 'succeeded', 1)`, [subscriptionId]);
        expect(await rpc(`cherry_rows_used($1, now() - interval '1 day', $2)`, [subscriptionId, check])).toBe(1300);
    });

    it('resumes a started run instead of starting another', async () => {
        const owner = 'e'.repeat(8) + '-0000-4000-8000-000000000000';
        const first = await reserve(owner);
        await db.query(`update public.cherry_provider_runs set status = 'started', run_id = 'run12345' where id = $1`, [first.id]);
        expect(await reserve(owner)).toMatchObject({ outcome: 'resume', runId: 'run12345' });
    });

    it('does not resend a message whose outcome is unknown', async () => {
        await activate();
        await db.exec(`update public.cherry_notifications set send_after = now()`);
        const message = await one<{ id: string }>('select * from public.cherry_claim_notifications(5, 60, true)');
        await db.query(`update public.cherry_notifications set lease_expires_at = now() - interval '1 minute' where id = $1`, [message.id]);
        expect(await one('select * from public.cherry_claim_notifications(5, 60, true)')).toBeUndefined();
        expect((await one<{ status: string }>('select status from public.cherry_notifications where id = $1', [message.id])).status).toBe('unconfirmed');
    });

    it('creates one recurring charge per cycle and retries a decline on later days', async () => {
        await activate();
        await db.exec(`update public.cherry_subscriptions set payment_provider = 'toss', current_period_end = now() - interval '1 minute'`);
        const charge = await one<{ id: string; cycle: number; amount_krw: number }>('select * from public.cherry_claim_billing(5)');
        expect(charge).toMatchObject({ cycle: 2, amount_krw: 9900 });
        expect(await one('select * from public.cherry_claim_billing(5)')).toBeUndefined();
        await rpc('cherry_fail_payment($1,$2)', [charge.id, 'REJECT_CARD_PAYMENT']);
        expect(await one('select * from public.cherry_claim_billing(5)')).toBeUndefined();
        await db.exec(`update public.cherry_subscriptions set billing_next_attempt_at = now()`);
        expect(await one('select * from public.cherry_claim_billing(5)')).toMatchObject({ cycle: 2 });
    });
});

describe('cherry privacy', () => {
    it('removes observed data with the account and keeps payment records', async () => {
        const { subscriptionId } = await activate();
        await rpc('cherry_purge_account($1)', [USER]);
        const subscription = await one<Record<string, unknown>>('select * from public.cherry_subscriptions where id = $1', [subscriptionId]);
        expect(subscription).toMatchObject({ status: 'ended', status_reason: 'account_deleted', target_username: 'purged', recipient_phone: null });
        expect((await one<{ n: number }>('select count(*)::int as n from public.cherry_relations')).n).toBe(0);
        expect((await one<{ n: number }>('select count(*)::int as n from public.cherry_payments')).n).toBe(1);
    });

    it('is closed to browser roles', async () => {
        for (const role of ['anon', 'authenticated']) {
            await db.exec(`set role ${role}`);
            await expect(db.query('select * from public.cherry_subscriptions')).rejects.toThrow('permission denied');
            await expect(db.query('select public.cherry_enqueue_due()')).rejects.toThrow('permission denied');
            await db.exec('reset role');
        }
        await db.exec('set role service_role');
        await expect(db.query('select public.cherry_enqueue_due()')).resolves.toBeTruthy();
        await expect(db.query('delete from public.cherry_audit_log')).rejects.toThrow('permission denied');
        await db.exec('reset role');
    });

    it('limits account lookups per visitor and reuses a recent one', async () => {
        const lookup = (name: string) => rpc<{ outcome: string; created?: boolean }>('cherry_request_target_check($1,null,$2,2,100)', [name, 'ip']);
        expect(await lookup('first')).toMatchObject({ outcome: 'accepted', created: true });
        expect(await lookup('first')).toMatchObject({ outcome: 'accepted', created: false });
        expect((await lookup('second')).outcome).toBe('accepted');
        expect((await lookup('third')).outcome).toBe('limited');
    });
});
