import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    isResultAuthoritativelyPublished: vi.fn(),
    orderQuery: null as ReturnType<typeof queryBuilder> | null,
    preflightQuery: null as ReturnType<typeof queryBuilder> | null,
    resultQuery: null as ReturnType<typeof queryBuilder> | null,
    requireActiveAccountClassification: vi.fn(),
}));

function queryBuilder(data: unknown) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        gt: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.gt.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    return query;
}

vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock('@/lib/services/analysis/result-publication-authority', () => ({
    isAnalysisResultAuthoritativelyPublished: mocks.isResultAuthoritativelyPublished,
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { GET } from '@/app/api/earlybird/orders/latest/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174001';
const RESULT_ID = '123e4567-e89b-42d3-a456-426614174002';
const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174003';

function orderRow(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        user_id: USER_ID,
        preflight_id: PREFLIGHT_ID,
        target_instagram_id: 'target.account',
        plan_id: 'basic',
        actual_amount_krw: 14_900,
        status: 'paid',
        paid_at: '2026-07-17T12:00:00.000Z',
        due_at: '2026-07-19T12:00:00.000Z',
        plan_sequence: 3,
        result_request_id: null,
        created_at: '2026-07-17T11:59:00.000Z',
        payment_id: 'must-not-be-selected',
        expected_groble_product_id: 'must-not-be-selected',
        disclosure_text: 'must-not-be-selected',
        ...overrides,
    };
}

function installQueries(
    order: unknown,
    result: unknown = null,
    fulfillment: unknown = { status: 'awaiting_operator' },
    preflight: unknown = {
        id: PREFLIGHT_ID,
        user_id: USER_ID,
        target_instagram_id: 'target.account',
        status: 'ready',
        expires_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
    },
) {
    mocks.orderQuery = queryBuilder(order);
    mocks.preflightQuery = queryBuilder(preflight);
    mocks.resultQuery = queryBuilder(result);
    mocks.rpc.mockResolvedValue({
        data: typeof fulfillment === 'object' && fulfillment !== null
            && 'status' in fulfillment
            ? (fulfillment as { status: unknown }).status
            : null,
        error: null,
    });
    mocks.from.mockImplementation((table: string) => {
        if (table === 'earlybird_orders') return mocks.orderQuery;
        if (table === 'analysis_preflights') return mocks.preflightQuery;
        if (table === 'analysis_requests') return mocks.resultQuery;
        throw new Error(`unexpected table: ${table}`);
    });
}

function authenticate(userId: string | null = USER_ID) {
    mocks.createServerClient.mockResolvedValue({
        auth: {
            getUser: vi.fn().mockResolvedValue({
                data: { user: userId ? { id: userId } : null },
                error: userId ? null : { message: 'unauthorized' },
            }),
        },
    });
}

describe('earlybird owner order status route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED;
        delete process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE;
        authenticate();
        installQueries(orderRow(), null, { status: 'awaiting_operator' });
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(true);
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId: USER_ID,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
    });

    afterEach(() => {
        delete process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED;
        delete process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE;
    });

    it('requires authentication and returns no cached owner data', async () => {
        authenticate(null);
        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('filters by owner and returns only the safe status DTO', async () => {
        const response = await GET(new Request(
            'https://example.com/api/earlybird/orders/latest?plan=basic'
        ));
        expect(response.status).toBe(200);
        expect(mocks.orderQuery?.eq).toHaveBeenCalledWith('user_id', USER_ID);
        expect(mocks.orderQuery?.eq).toHaveBeenCalledWith('plan_id', 'basic');
        expect(mocks.orderQuery?.select).toHaveBeenCalledWith(
            'id, user_id, preflight_id, target_instagram_id, plan_id, actual_amount_krw, status, paid_at, due_at, plan_sequence, result_request_id, created_at'
        );
        const body = await response.json();
        expect(body).toEqual({
            order: {
                orderId: ORDER_ID,
                preflightId: PREFLIGHT_ID,
                targetInstagramId: 'target.account',
                planId: 'basic',
                planName: 'Basic',
                actualAmountKrw: 14_900,
                acceptedAt: '2026-07-17T12:00:00.000Z',
                dueAt: '2026-07-19T12:00:00.000Z',
                planSequence: 3,
                systemStatus: 'paid',
                displayStatus: '판독 대기',
                requiresSupport: false,
                checkoutRecoverable: false,
                deliveryMode: 'concierge',
                progressUrl: null,
                resultUrl: null,
            },
        });
        expect(JSON.stringify(body)).not.toMatch(/payment_id|product|disclosure|buyer|card/);
    });

    it('fails closed before reading order history for a retired account', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(USER_ID);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('returns a paid zero-KRW coupon order instead of dropping the owner history', async () => {
        installQueries(orderRow({ actual_amount_krw: 0 }));

        const response = await GET(new Request(
            'https://example.com/api/earlybird/orders/latest'
        ));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            order: {
                orderId: ORDER_ID,
                preflightId: PREFLIGHT_ID,
                actualAmountKrw: 0,
                systemStatus: 'paid',
                displayStatus: '판독 대기',
            },
        });
    });

    it('returns 404 when the owner-scoped query finds no order', async () => {
        installQueries(null);
        expect((await GET(new Request(
            'https://example.com/api/earlybird/orders/latest'
        ))).status).toBe(404);
    });

    it('does not expose an acceptance timestamp before paid status is verified', async () => {
        installQueries(orderRow({
            status: 'payment_pending',
            actual_amount_krw: null,
            paid_at: null,
            due_at: null,
            plan_sequence: null,
        }));
        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        await expect(response.json()).resolves.toMatchObject({
            order: {
                acceptedAt: null,
                displayStatus: '결제 확인',
            },
        });
    });

    it('keeps a newly-created pending checkout recoverable across bounded clock skew', async () => {
        installQueries(orderRow({
            status: 'payment_pending',
            actual_amount_krw: null,
            paid_at: null,
            due_at: null,
            plan_sequence: null,
            created_at: new Date(Date.now() + 2 * 60 * 1_000).toISOString(),
        }));

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));

        await expect(response.json()).resolves.toMatchObject({
            order: { checkoutRecoverable: true },
        });
    });

    it('fails closed for materially future pending checkout timestamps', async () => {
        installQueries(orderRow({
            status: 'payment_pending',
            actual_amount_krw: null,
            paid_at: null,
            due_at: null,
            plan_sequence: null,
            created_at: new Date(Date.now() + 6 * 60 * 1_000).toISOString(),
        }));

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));

        await expect(response.json()).resolves.toMatchObject({
            order: { checkoutRecoverable: false },
        });
    });

    it.each([
        ['not ready', { status: 'processing' }],
        ['expired', { expires_at: new Date(Date.now() - 1_000).toISOString() }],
        ['different target', { target_instagram_id: 'different.account' }],
        ['different owner', { user_id: '123e4567-e89b-42d3-a456-426614174099' }],
    ] as const)('requires a server-authoritative ready, unexpired, target-bound preflight (%s)', async (_label, preflightOverrides) => {
        installQueries(
            orderRow({
                status: 'payment_pending',
                actual_amount_krw: null,
                paid_at: null,
                due_at: null,
                plan_sequence: null,
                created_at: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
            }),
            null,
            { status: 'awaiting_operator' },
            {
                id: PREFLIGHT_ID,
                user_id: USER_ID,
                target_instagram_id: 'target.account',
                status: 'ready',
                expires_at: new Date(Date.now() + 30 * 60 * 1_000).toISOString(),
                ...preflightOverrides,
            },
        );

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));

        await expect(response.json()).resolves.toMatchObject({
            order: { checkoutRecoverable: false },
        });
    });

    it('rejects invalid plan filters instead of widening the query', async () => {
        const response = await GET(new Request(
            'https://example.com/api/earlybird/orders/latest?plan=plus'
        ));
        expect(response.status).toBe(400);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('shows a result link only after a completed result is rechecked for the same owner', async () => {
        installQueries(orderRow({
            status: 'completed',
            result_request_id: RESULT_ID,
        }), {
            id: RESULT_ID,
            user_id: USER_ID,
            status: 'completed',
        });
        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        await expect(response.json()).resolves.toMatchObject({
            order: {
                displayStatus: '결과 전달 완료',
                requiresSupport: false,
                progressUrl: null,
                resultUrl: `/result/${RESULT_ID}`,
            },
        });
        expect(mocks.resultQuery?.eq).toHaveBeenCalledWith('user_id', USER_ID);

        installQueries(orderRow({
            status: 'completed',
            result_request_id: RESULT_ID,
        }), null);
        const blocked = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        await expect(blocked.json()).resolves.toMatchObject({ order: { resultUrl: null } });
    });

    it('keeps an order in the waiting UX when its completed request is not published', async () => {
        installQueries(orderRow({
            status: 'completed',
            result_request_id: RESULT_ID,
        }), {
            id: RESULT_ID,
            user_id: USER_ID,
            status: 'completed',
        });
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(false);

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));

        await expect(response.json()).resolves.toMatchObject({
            order: {
                systemStatus: 'analysis_in_progress',
                displayStatus: '판독 중',
                deliveryMode: 'concierge',
                progressUrl: `/progress/${RESULT_ID}`,
                resultUrl: null,
            },
        });
        expect(mocks.isResultAuthoritativelyPublished).toHaveBeenCalledWith(RESULT_ID);
    });

    it('returns an owner-scoped progress path only while automatic analysis is in progress', async () => {
        installQueries(orderRow({
            status: 'analysis_in_progress',
            result_request_id: RESULT_ID,
        }), null, { status: 'analysis_in_progress' });

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        await expect(response.json()).resolves.toMatchObject({
            order: {
                deliveryMode: 'automatic',
                progressUrl: `/progress/${RESULT_ID}`,
                resultUrl: null,
            },
        });
    });

    it('keeps completion projection lag automatic while the order remains in progress', async () => {
        installQueries(orderRow({
            status: 'analysis_in_progress',
            result_request_id: RESULT_ID,
        }), null, { status: 'completed' });

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        await expect(response.json()).resolves.toMatchObject({
            order: {
                systemStatus: 'analysis_in_progress',
                deliveryMode: 'automatic',
                requiresSupport: false,
                progressUrl: `/progress/${RESULT_ID}`,
                resultUrl: null,
            },
        });
    });

    it('classifies an admitted automatic paid order without exposing internal fulfillment status', async () => {
        installQueries(orderRow({ status: 'paid' }), null, { status: 'admission_pending' });

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        const body = await response.json();

        expect(body).toMatchObject({
            order: {
                systemStatus: 'paid',
                deliveryMode: 'automatic',
                requiresSupport: false,
                progressUrl: null,
            },
        });
        expect(JSON.stringify(body)).not.toMatch(
            /awaiting_operator|admission_pending|analysis_in_progress|retryable_failure|manual_review/
        );
    });

    it('keeps a newly eligible awaiting-operator order automatic during the webhook handoff', async () => {
        process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED = 'true';
        process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE =
            '2026-08-27T04:40:00Z';
        installQueries(orderRow({
            status: 'paid',
            paid_at: '2026-08-27T04:40:00Z',
        }), null, { status: 'awaiting_operator' });

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));

        await expect(response.json()).resolves.toMatchObject({
            order: {
                systemStatus: 'paid',
                deliveryMode: 'automatic',
                progressUrl: null,
                resultUrl: null,
            },
        });
    });

    it('fails closed to support when the automatic-admission cutoff is invalid', async () => {
        process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED = 'true';
        process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE = 'not-a-timestamp';
        installQueries(orderRow({
            status: 'paid',
            paid_at: '2026-08-27T04:40:00Z',
        }), null, { status: 'awaiting_operator' });

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));

        await expect(response.json()).resolves.toMatchObject({
            order: {
                requiresSupport: true,
                deliveryMode: 'support',
                progressUrl: null,
            },
        });
    });

    it('keeps a pre-cutoff awaiting-operator paid order on concierge delivery', async () => {
        process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_ENABLED = 'true';
        process.env.EARLYBIRD_WEBHOOK_AUTO_ADMISSION_NOT_BEFORE =
            '2026-08-27T04:40:01Z';
        installQueries(orderRow({ status: 'paid' }), null, { status: 'awaiting_operator' });

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        const body = await response.json();

        expect(body).toMatchObject({
            order: {
                systemStatus: 'paid',
                deliveryMode: 'concierge',
                requiresSupport: false,
                progressUrl: null,
            },
        });
        expect(JSON.stringify(body)).not.toContain('awaiting_operator');
    });

    it.each([
        ['successful-but-null', null],
        ['invalid', { status: 'not-a-valid-fulfillment-status' }],
    ] as const)('fails closed to support when paid fulfillment status is %s', async (_label, fulfillment) => {
        installQueries(orderRow({ status: 'paid' }), null, fulfillment);

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        const body = await response.json();

        expect(body).toMatchObject({
            order: {
                requiresSupport: true,
                deliveryMode: 'support',
                progressUrl: null,
            },
        });
        expect(JSON.stringify(body)).not.toMatch(/not-a-valid-fulfillment-status|manual_review/);
    });

    it('returns only a generic support fallback for manual-review fulfillment', async () => {
        installQueries(orderRow({
            status: 'analysis_in_progress',
            result_request_id: RESULT_ID,
        }), null, { status: 'manual_review' });

        const response = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        const body = await response.json();
        expect(body).toMatchObject({
            order: {
                requiresSupport: true,
                deliveryMode: 'support',
                progressUrl: null,
                resultUrl: null,
            },
        });
        expect(JSON.stringify(body)).not.toContain('manual_review');
    });

    it('uses the service-only fulfillment RPC instead of reading the private table', async () => {
        installQueries(orderRow({
            status: 'analysis_in_progress',
            result_request_id: RESULT_ID,
        }));

        await GET(new Request('https://example.com/api/earlybird/orders/latest'));

        expect(mocks.rpc).toHaveBeenCalledWith(
            'load_earlybird_fulfillment_status',
            { p_order_id: ORDER_ID }
        );
        expect(mocks.from).not.toHaveBeenCalledWith('earlybird_fulfillments');
    });

    it('restores the same server order after refresh and protects the status page path', async () => {
        const first = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        const second = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        expect(await second.json()).toEqual(await first.json());

        const proxy = readFileSync(new URL('../../../proxy.ts', import.meta.url), 'utf8');
        expect(proxy).toContain("'/earlybird'");
    });
});
