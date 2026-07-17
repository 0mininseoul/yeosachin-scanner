import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
    from: vi.fn(),
    orderQuery: null as ReturnType<typeof queryBuilder> | null,
    resultQuery: null as ReturnType<typeof queryBuilder> | null,
}));

function queryBuilder(data: unknown) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        limit: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.order.mockReturnValue(query);
    query.limit.mockReturnValue(query);
    return query;
}

vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));

import { GET } from '@/app/api/earlybird/orders/latest/route';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174001';
const RESULT_ID = '123e4567-e89b-42d3-a456-426614174002';

function orderRow(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        user_id: USER_ID,
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

function installQueries(order: unknown, result: unknown = null) {
    mocks.orderQuery = queryBuilder(order);
    mocks.resultQuery = queryBuilder(result);
    mocks.from.mockImplementation((table: string) => {
        if (table === 'earlybird_orders') return mocks.orderQuery;
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
        authenticate();
        installQueries(orderRow());
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
            'id, user_id, target_instagram_id, plan_id, actual_amount_krw, status, paid_at, due_at, plan_sequence, result_request_id, created_at'
        );
        const body = await response.json();
        expect(body).toEqual({
            order: {
                orderId: ORDER_ID,
                targetInstagramId: 'target.account',
                planId: 'basic',
                planName: 'Basic',
                actualAmountKrw: 14_900,
                acceptedAt: '2026-07-17T12:00:00.000Z',
                dueAt: '2026-07-19T12:00:00.000Z',
                planSequence: 3,
                systemStatus: 'paid',
                displayStatus: '판독 대기',
                resultUrl: null,
            },
        });
        expect(JSON.stringify(body)).not.toMatch(/payment_id|product|disclosure|buyer|card/);
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

    it('restores the same server order after refresh and protects the status page path', async () => {
        const first = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        const second = await GET(new Request('https://example.com/api/earlybird/orders/latest'));
        expect(await second.json()).toEqual(await first.json());

        const proxy = readFileSync(new URL('../../../proxy.ts', import.meta.url), 'utf8');
        expect(proxy).toContain("'/earlybird'");
    });
});
