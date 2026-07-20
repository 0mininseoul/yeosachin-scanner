import { readFileSync } from 'node:fs';
import { PGlite, type Results } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EARLYBIRD_PRICING_VERSION } from '@/lib/domain/earlybird/catalog';

// 이 파일은 원본 마이그레이션(20260717140000)만 단독 적용하는 고립된 스냅샷 테스트라,
// 이후 24시간으로 단축된 현재 disclosure 상수(catalog.ts)를 그대로 쓰면 안 된다. 원본
// 마이그레이션이 하드코딩한 48시간 고지를 그대로 리터럴로 고정한다.
const LEGACY_DISCLOSURE_VERSION = 'earlybird-48h-v1';
const LEGACY_DISCLOSURE_TEXT =
    '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 48시간 이내 판독 결과를 제공합니다.';

const migration = readFileSync(
    new URL(
        '../../../supabase/migrations/20260717140000_add_groble_earlybird_presale.sql',
        import.meta.url
    ),
    'utf8'
);

const bootstrap = `
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;

CREATE FUNCTION extensions.gen_random_uuid()
RETURNS UUID LANGUAGE sql VOLATILE AS $$ SELECT pg_catalog.gen_random_uuid() $$;

CREATE FUNCTION auth.uid()
RETURNS UUID LANGUAGE sql STABLE AS $$
    SELECT NULLIF(pg_catalog.current_setting('request.jwt.claim.sub', TRUE), '')::UUID
$$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.users (
    id UUID PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.analysis_requests (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp()
);

CREATE TABLE public.pipeline_jobs (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid()
);

CREATE TABLE public.analysis_preflights (
    id UUID PRIMARY KEY,
    user_id UUID NOT NULL REFERENCES public.users(id),
    target_instagram_id VARCHAR(30) NOT NULL,
    status TEXT NOT NULL,
    exclusion_decision TEXT NOT NULL,
    excluded_instagram_id VARCHAR(30),
    access_mode TEXT NOT NULL,
    plan_cards_snapshot JSONB NOT NULL,
    pricing_version VARCHAR(64) NOT NULL,
    pricing_snapshot JSONB NOT NULL,
    target_followers_count INTEGER NOT NULL,
    target_following_count INTEGER NOT NULL,
    required_plan_id TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL
);
`;

const USER_NAMESPACE = '10000000-0000-4000-8000-';
const PREFLIGHT_NAMESPACE = '20000000-0000-4000-8000-';
const BASIC_PRODUCT_ID = 'basic_product-01';
const STANDARD_PRODUCT_ID = 'standard_product-01';

type PlanId = 'basic' | 'standard' | 'plus';

interface CheckoutRow {
    order_id: string;
    created: boolean;
}

interface FinalizeRow {
    disposition: string;
    order_id: string | null;
    status: string | null;
    plan_sequence: number | null;
}

let db: PGlite;

function uuid(namespace: string, index: number): string {
    return `${namespace}${String(index).padStart(12, '0')}`;
}

function planCards(requiredPlanId: PlanId): Record<PlanId, object> {
    const ranks: Record<PlanId, number> = { basic: 1, standard: 2, plus: 3 };
    return Object.fromEntries((['basic', 'standard', 'plus'] as const).map(planId => [
        planId,
        {
            launchStatus: 'production',
            selectionState: planId === requiredPlanId
                ? 'required'
                : ranks[planId] > ranks[requiredPlanId]
                    ? 'available_upgrade'
                    : 'unavailable',
            unavailableReason: ranks[planId] < ranks[requiredPlanId]
                ? 'below_required_plan'
                : null,
        },
    ])) as Record<PlanId, object>;
}

const pricingSnapshot = {
    basic: { currency: 'KRW', status: 'quoted', amountKrw: 14_900 },
    standard: { currency: 'KRW', status: 'quoted', amountKrw: 19_900 },
    plus: { currency: 'KRW', status: 'deferred', amountKrw: null },
};

async function asService<T>(sql: string, params: unknown[] = []): Promise<Results<T>> {
    await db.exec('SET ROLE service_role');
    try {
        return await db.query<T>(sql, params);
    } finally {
        await db.exec('RESET ROLE');
    }
}

async function seedPreflight(index: number, requiredPlanId: PlanId): Promise<{
    userId: string;
    preflightId: string;
    email: string;
}> {
    const userId = uuid(USER_NAMESPACE, index);
    const preflightId = uuid(PREFLIGHT_NAMESPACE, index);
    const email = `buyer${index}@example.com`;
    await db.query(
        `INSERT INTO public.users (id, email) VALUES ($1, $2)`,
        [userId, email]
    );
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            excluded_instagram_id, access_mode, plan_cards_snapshot,
            pricing_version, pricing_snapshot, target_followers_count,
            target_following_count, required_plan_id, expires_at
        ) VALUES (
            $1, $2, $3, 'ready', 'exclude', $4, 'production', $5,
            $6, $7, $8, $9, $10,
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [
            preflightId,
            userId,
            `target_${index}`,
            `excluded_${index}`,
            planCards(requiredPlanId),
            EARLYBIRD_PRICING_VERSION,
            pricingSnapshot,
            requiredPlanId === 'basic' ? 300 : requiredPlanId === 'standard' ? 700 : 1_000,
            100,
            requiredPlanId,
        ]
    );
    return { userId, preflightId, email };
}

async function seedNewPreflightForUser(
    index: number,
    userId: string,
    requiredPlanId: PlanId
): Promise<string> {
    const preflightId = uuid(PREFLIGHT_NAMESPACE, index);
    await db.query(
        `INSERT INTO public.analysis_preflights (
            id, user_id, target_instagram_id, status, exclusion_decision,
            excluded_instagram_id, access_mode, plan_cards_snapshot,
            pricing_version, pricing_snapshot, target_followers_count,
            target_following_count, required_plan_id, created_at, expires_at
        ) VALUES (
            $1, $2, $3, 'ready', 'exclude', $4, 'production', $5,
            $6, $7, $8, $9, $10,
            pg_catalog.clock_timestamp() + INTERVAL '1 second',
            pg_catalog.clock_timestamp() + INTERVAL '30 minutes'
        )`,
        [
            preflightId,
            userId,
            `target_${index}`,
            `excluded_${index}`,
            planCards(requiredPlanId),
            EARLYBIRD_PRICING_VERSION,
            pricingSnapshot,
            requiredPlanId === 'basic' ? 300 : requiredPlanId === 'standard' ? 700 : 1_000,
            100,
            requiredPlanId,
        ]
    );
    return preflightId;
}

async function createCheckout(
    seed: { userId: string; preflightId: string },
    planId: 'basic' | 'standard'
): Promise<CheckoutRow> {
    const amount = planId === 'basic' ? 14_900 : 19_900;
    const productId = planId === 'basic' ? BASIC_PRODUCT_ID : STANDARD_PRODUCT_ID;
    const result = await asService<CheckoutRow>(
        `SELECT * FROM public.create_earlybird_checkout(
            $1, $2, $3, $4, $5, $6, $7, $8, pg_catalog.clock_timestamp()
        )`,
        [
            seed.userId,
            seed.preflightId,
            planId,
            productId,
            amount,
            EARLYBIRD_PRICING_VERSION,
            LEGACY_DISCLOSURE_VERSION,
            LEGACY_DISCLOSURE_TEXT,
        ]
    );
    return result.rows[0];
}

async function finalize(
    seed: { email: string },
    planId: 'basic' | 'standard',
    index: number,
    overrides: Partial<{ eventId: string; idempotencyKey: string; paymentId: string; productId: string; amount: number }> = {}
): Promise<FinalizeRow> {
    const productId = planId === 'basic' ? BASIC_PRODUCT_ID : STANDARD_PRODUCT_ID;
    const amount = planId === 'basic' ? 14_900 : 19_900;
    const result = await asService<FinalizeRow>(
        `SELECT * FROM public.finalize_earlybird_groble_payment(
            $1, $2, 'payment.completed', $3, $4, $5, $6, $7, $8
        )`,
        [
            overrides.eventId ?? `event_${planId}_${index}`,
            overrides.idempotencyKey ?? `idem_${planId}_${index}`,
            '2026-07-17T21:00:00+09:00',
            overrides.paymentId ?? `payment_${planId}_${index}`,
            seed.email,
            overrides.productId ?? productId,
            overrides.amount ?? amount,
            '2026-07-17T21:00:00+09:00',
        ]
    );
    return result.rows[0];
}

async function requestCancellation(
    paymentId: string,
    planId: 'basic' | 'standard',
    index: number
): Promise<FinalizeRow> {
    const productId = planId === 'basic' ? BASIC_PRODUCT_ID : STANDARD_PRODUCT_ID;
    const amount = planId === 'basic' ? 14_900 : 19_900;
    const result = await asService<FinalizeRow>(
        `SELECT * FROM public.finalize_earlybird_groble_cancel_request(
            $1, $2, 'payment.cancel_requested', $3, $4, $5, $6, $7
        )`,
        [
            `event_cancel_${index}`,
            `idem_cancel_${index}`,
            '2026-07-18T09:00:00+09:00',
            paymentId,
            productId,
            amount,
            '2026-07-18T09:00:00+09:00',
        ]
    );
    return result.rows[0];
}

async function seedAndCheckoutRange(
    startIndex: number,
    count: number,
    planId: 'basic' | 'standard'
): Promise<Array<{ userId: string; preflightId: string; email: string }>> {
    const seeds = [];
    for (let offset = 0; offset < count; offset += 1) {
        const seed = await seedPreflight(startIndex + offset, planId);
        await createCheckout(seed, planId);
        seeds.push(seed);
    }
    return seeds;
}

describe('Groble earlybird database boundary', () => {
    beforeAll(async () => {
        db = await PGlite.create();
        await db.exec(bootstrap);
        await db.exec(migration);
    }, 30_000);

    beforeEach(async () => {
        await db.exec(`
            TRUNCATE public.earlybird_webhook_events,
                public.earlybird_waitlist,
                public.earlybird_orders,
                public.analysis_preflights,
                public.pipeline_jobs,
                public.analysis_requests,
                public.users CASCADE;
            UPDATE public.earlybird_plan_inventory SET sold_count = 0;
        `);
    });

    afterAll(async () => {
        await db.close();
    });

    it('blocks Basic for a Standard-required account and rejects stale preflights', async () => {
        const seed = await seedPreflight(1, 'standard');
        await expect(createCheckout(seed, 'basic')).rejects.toThrow(/PLAN_UPGRADE_REQUIRED/);

        const older = await seedPreflight(2, 'basic');
        await db.query(
            `UPDATE public.analysis_preflights
             SET created_at = pg_catalog.clock_timestamp() - INTERVAL '1 minute'
             WHERE id = $1`,
            [older.preflightId]
        );
        await db.query(
            `INSERT INTO public.analysis_preflights
             SELECT pg_catalog.gen_random_uuid(), user_id, 'newer_target', status,
                exclusion_decision, excluded_instagram_id, access_mode,
                plan_cards_snapshot, pricing_version, pricing_snapshot,
                target_followers_count, target_following_count, required_plan_id,
                pg_catalog.clock_timestamp(), expires_at
             FROM public.analysis_preflights WHERE id = $1`,
            [older.preflightId]
        );
        await expect(createCheckout(older, 'basic')).rejects.toThrow(/PREFLIGHT_NOT_LATEST/);
    });

    it('creates Plus waitlist state without creating a payment order', async () => {
        const seed = await seedPreflight(3, 'plus');
        const result = await asService<{ waitlist_id: string; created: boolean }>(
            `SELECT * FROM public.join_earlybird_waitlist($1, $2)`,
            [seed.userId, seed.preflightId]
        );
        expect(result.rows[0]).toMatchObject({ created: true });
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_waitlist'
        )).rows[0].count).toBe(1);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders'
        )).rows[0].count).toBe(0);
    });

    it('atomically supersedes an abandoned pending checkout with the latest preflight', async () => {
        const seed = await seedPreflight(92, 'basic');
        const first = await createCheckout(seed, 'basic');
        const nextPreflightId = await seedNewPreflightForUser(93, seed.userId, 'standard');
        const second = await createCheckout({
            userId: seed.userId,
            preflightId: nextPreflightId,
        }, 'standard');

        expect(second.created).toBe(true);
        expect(second.order_id).not.toBe(first.order_id);
        const orders = (await db.query<{
            id: string;
            preflight_id: string;
            target_instagram_id: string;
            plan_id: string;
            expected_groble_product_id: string;
            status: string;
        }>(
            `SELECT id, preflight_id, target_instagram_id, plan_id,
                expected_groble_product_id, status
             FROM public.earlybird_orders ORDER BY created_at`
        )).rows;
        expect(orders).toEqual([{
            id: first.order_id,
            preflight_id: seed.preflightId,
            target_instagram_id: 'target_92',
            plan_id: 'basic',
            expected_groble_product_id: BASIC_PRODUCT_ID,
            status: 'cancelled',
        }, {
            id: second.order_id,
            preflight_id: nextPreflightId,
            target_instagram_id: 'target_93',
            plan_id: 'standard',
            expected_groble_product_id: STANDARD_PRODUCT_ID,
            status: 'payment_pending',
        }]);

        const lateOldPayment = await finalize(seed, 'basic', 92);
        expect(lateOldPayment).toMatchObject({
            disposition: 'late_cancelled_payment',
            order_id: first.order_id,
            status: 'refund_pending',
            plan_sequence: null,
        });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [second.order_id]
        )).rows[0].status).toBe('payment_pending');
    });

    it('keeps a same-plan pending intent authoritative when a newer preflight cannot be distinguished', async () => {
        const seed = await seedPreflight(94, 'basic');
        const first = await createCheckout(seed, 'basic');
        const nextPreflightId = await seedNewPreflightForUser(95, seed.userId, 'basic');

        await expect(createCheckout({
            userId: seed.userId,
            preflightId: nextPreflightId,
        }, 'basic')).rejects.toThrow(/EARLYBIRD_CHECKOUT_ALREADY_PENDING/);

        const orders = (await db.query<{
            id: string;
            preflight_id: string;
            target_instagram_id: string;
            status: string;
        }>(
            `SELECT id, preflight_id, target_instagram_id, status
             FROM public.earlybird_orders ORDER BY created_at`
        )).rows;
        expect(orders).toEqual([{
            id: first.order_id,
            preflight_id: seed.preflightId,
            target_instagram_id: 'target_94',
            status: 'payment_pending',
        }]);

        const completion = await finalize(seed, 'basic', 94);
        expect(completion).toMatchObject({
            disposition: 'accepted',
            order_id: first.order_id,
            status: 'paid',
            plan_sequence: 1,
        });
    });

    it('blocks returning to a product while its superseded intent remains payable', async () => {
        const seed = await seedPreflight(96, 'basic');
        const first = await createCheckout(seed, 'basic');
        const standardPreflightId = await seedNewPreflightForUser(97, seed.userId, 'standard');
        const second = await createCheckout({
            userId: seed.userId,
            preflightId: standardPreflightId,
        }, 'standard');
        const basicPreflightId = await seedNewPreflightForUser(98, seed.userId, 'basic');

        await expect(createCheckout({
            userId: seed.userId,
            preflightId: basicPreflightId,
        }, 'basic')).rejects.toThrow(/EARLYBIRD_CHECKOUT_ALREADY_PENDING/);

        const lateFirstPayment = await finalize(seed, 'basic', 96);
        expect(lateFirstPayment).toMatchObject({
            disposition: 'late_cancelled_payment',
            order_id: first.order_id,
            status: 'refund_pending',
            plan_sequence: null,
        });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [second.order_id]
        )).rows[0].status).toBe('payment_pending');
    });

    it('makes duplicate event and payment deliveries idempotent', async () => {
        const seed = await seedPreflight(4, 'basic');
        await createCheckout(seed, 'basic');
        const first = await finalize(seed, 'basic', 4);
        const replay = await finalize(seed, 'basic', 4);
        const samePayment = await finalize(seed, 'basic', 44, {
            paymentId: 'payment_basic_4',
        });

        expect(first).toMatchObject({ disposition: 'accepted', status: 'paid', plan_sequence: 1 });
        expect(replay.order_id).toBe(first.order_id);
        expect(samePayment.order_id).toBe(first.order_id);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.earlybird_orders'
        )).rows[0].count).toBe(1);
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(1);

        await expect(createCheckout(seed, 'basic'))
            .rejects.toThrow(/EARLYBIRD_ORDER_CONFLICT/);
    });

    it('records cancellation requests and keeps final refund transitions service-only', async () => {
        const seed = await seedPreflight(5, 'basic');
        await createCheckout(seed, 'basic');
        const paid = await finalize(seed, 'basic', 5);
        const cancellation = await requestCancellation('payment_basic_5', 'basic', 5);
        const replay = await requestCancellation('payment_basic_5', 'basic', 5);

        expect(cancellation).toMatchObject({
            disposition: 'cancel_requested',
            order_id: paid.order_id,
            status: 'refund_pending',
            plan_sequence: 1,
        });
        expect(replay).toMatchObject({
            disposition: 'cancel_duplicate_event',
            order_id: paid.order_id,
            status: 'refund_pending',
        });

        await asService(
            'SELECT public.set_earlybird_refund_status($1, $2)',
            [paid.order_id, 'refunded']
        );
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders WHERE id = $1',
            [paid.order_id]
        )).rows[0].status).toBe('refunded');
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(1);
    });

    it('reconciles a cancellation delivered before payment completion without selling a slot', async () => {
        const seed = await seedPreflight(6, 'basic');
        await createCheckout(seed, 'basic');
        const cancellation = await requestCancellation('payment_basic_6', 'basic', 6);
        const completion = await finalize(seed, 'basic', 6);

        expect(cancellation).toMatchObject({
            disposition: 'cancel_unmatched',
            order_id: null,
        });
        expect(completion).toMatchObject({
            disposition: 'cancel_before_payment',
            status: 'refund_pending',
            plan_sequence: null,
        });
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
    });

    it.each([
        ['basic', 10] as const,
        ['standard', 30] as const,
    ])('atomically accepts only ten %s payments and isolates the eleventh', async (planId, start) => {
        const seeds = await seedAndCheckoutRange(start, 11, planId);
        const results = await Promise.all(
            seeds.map((seed, offset) => finalize(seed, planId, start + offset))
        );

        expect(results.filter(result => result.status === 'paid')).toHaveLength(10);
        expect(results.filter(result => result.status === 'overflow_refund_required'))
            .toHaveLength(1);
        expect(results.flatMap(result => result.plan_sequence ?? []).sort((a, b) => a - b))
            .toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        expect((await db.query<{ sold_count: number }>(
            'SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = $1',
            [planId]
        )).rows[0].sold_count).toBe(10);
    });

    it('keeps Basic and Standard inventory and sequences independent', async () => {
        const basic = await seedPreflight(60, 'basic');
        const standard = await seedPreflight(61, 'standard');
        await createCheckout(basic, 'basic');
        await createCheckout(standard, 'standard');

        const [basicResult, standardResult] = await Promise.all([
            finalize(basic, 'basic', 60),
            finalize(standard, 'standard', 61),
        ]);
        expect(basicResult.plan_sequence).toBe(1);
        expect(standardResult.plan_sequence).toBe(1);
    });

    it('rejects an unknown product without mutating the pending order', async () => {
        const seed = await seedPreflight(70, 'basic');
        await createCheckout(seed, 'basic');
        const result = await finalize(seed, 'basic', 70, {
            productId: 'wrong_product',
            amount: 14_900,
        });
        expect(result).toMatchObject({ disposition: 'unmatched', status: null });
        expect((await db.query<{ status: string }>(
            'SELECT status FROM public.earlybird_orders'
        )).rows[0].status).toBe('payment_pending');
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
    });

    it('rejects an amount mismatch without consuming inventory', async () => {
        const seed = await seedPreflight(71, 'basic');
        await createCheckout(seed, 'basic');
        const result = await finalize(seed, 'basic', 71, {
            productId: BASIC_PRODUCT_ID,
            amount: 14_901,
        });
        expect(result).toMatchObject({ disposition: 'mismatch', status: 'payment_failed' });
        expect((await db.query<{ sold_count: number }>(
            `SELECT sold_count FROM public.earlybird_plan_inventory WHERE plan_id = 'basic'`
        )).rows[0].sold_count).toBe(0);
    });

    it('calculates due_at from paid_at by an actual 48 hours and dispatches nothing', async () => {
        const seed = await seedPreflight(80, 'basic');
        await createCheckout(seed, 'basic');
        await finalize(seed, 'basic', 80);
        const order = (await db.query<{ seconds: number }>(
            `SELECT EXTRACT(EPOCH FROM (due_at - paid_at))::INTEGER AS seconds
             FROM public.earlybird_orders`
        )).rows[0];
        expect(order.seconds).toBe(172_800);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.analysis_requests'
        )).rows[0].count).toBe(0);
        expect((await db.query<{ count: number }>(
            'SELECT COUNT(*)::INTEGER AS count FROM public.pipeline_jobs'
        )).rows[0].count).toBe(0);
    });

    it('allows authenticated owners to read only their own order and no mutation RPC', async () => {
        const owner = await seedPreflight(90, 'basic');
        const other = await seedPreflight(91, 'basic');
        await createCheckout(owner, 'basic');
        await createCheckout(other, 'basic');
        await db.query(`SELECT pg_catalog.set_config('request.jwt.claim.sub', $1, FALSE)`, [owner.userId]);
        await db.exec('SET ROLE authenticated');
        try {
            const visible = await db.query<{ user_id: string }>(
                'SELECT user_id FROM public.earlybird_orders'
            );
            expect(visible.rows).toEqual([{ user_id: owner.userId }]);
            await expect(db.query(
                'SELECT payment_id FROM public.earlybird_orders'
            )).rejects.toThrow(/permission denied/i);
            await expect(db.query(
                `SELECT * FROM public.join_earlybird_waitlist($1, $2)`,
                [owner.userId, owner.preflightId]
            )).rejects.toThrow(/permission denied/i);
        } finally {
            await db.exec('RESET ROLE');
        }
    });
});
