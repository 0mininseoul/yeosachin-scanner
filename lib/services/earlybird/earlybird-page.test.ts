import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    requireActiveAccountSession: vi.fn(),
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
    supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock('@/lib/services/identity/account-principal-store', () => ({
    requireActiveAccountSession: mocks.requireActiveAccountSession,
}));
vi.mock('next/navigation', () => ({
    redirect: vi.fn(),
}));
vi.mock('@/components/case-ui', () => ({
    TopBar: () => createElement('div', null, 'top'),
    CaseCard: ({ children }: { children: ReactNode }) => (
        createElement('div', null, children)
    ),
    Eyebrow: ({ children }: { children: ReactNode }) => (
        createElement('div', null, children)
    ),
}));
vi.mock('@/app/earlybird/earlybird-status', () => ({
    EarlybirdStatus: ({
        order,
    }: {
        order: { orderId: string; actualAmountKrw: number | null };
    }) => createElement(
        'div',
        { 'data-testid': 'earlybird-status' },
        `${order.orderId}:${String(order.actualAmountKrw)}`
    ),
}));

import EarlybirdPage from '@/app/earlybird/page';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174001';
const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174003';

describe('earlybird status page', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createServerClient.mockResolvedValue({
            auth: {
                getUser: vi.fn().mockResolvedValue({
                    data: { user: { id: USER_ID } },
                    error: null,
                }),
            },
        });
        const orderQuery = queryBuilder({
            id: ORDER_ID,
            user_id: USER_ID,
            preflight_id: PREFLIGHT_ID,
            target_instagram_id: 'target.account',
            plan_id: 'basic',
            actual_amount_krw: 0,
            status: 'paid',
            paid_at: '2026-07-17T12:00:00.000Z',
            due_at: '2026-07-18T12:00:00.000Z',
            plan_sequence: 3,
            result_request_id: null,
            created_at: '2026-07-17T11:59:00.000Z',
        });
        mocks.rpc.mockResolvedValue({ data: null, error: null });
        mocks.requireActiveAccountSession.mockResolvedValue({
            userId: USER_ID,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'runtime_default_v1',
        });
        mocks.from.mockImplementation((table: string) => {
            if (table === 'earlybird_orders') return orderQuery;
            throw new Error(`unexpected table: ${table}`);
        });
    });

    it('renders a paid zero-KRW coupon order instead of the no-history branch', async () => {
        const page = await EarlybirdPage({
            searchParams: Promise.resolve({}),
        });
        const markup = renderToStaticMarkup(page);

        expect(markup).toContain(`data-testid="earlybird-status"`);
        expect(markup).toContain(`${ORDER_ID}:0`);
        expect(markup).not.toContain('확인할 내역이 없습니다');
    });

    it('does not expose order status to a retired account', async () => {
        const redirectError = new Error('NEXT_REDIRECT');
        mocks.requireActiveAccountSession.mockRejectedValue(
            new Error('ACCOUNT_ADMISSION_DENIED')
        );
        const redirect = await import('next/navigation');
        vi.mocked(redirect.redirect).mockImplementation(() => {
            throw redirectError;
        });

        await expect(EarlybirdPage({
            searchParams: Promise.resolve({}),
        })).rejects.toBe(redirectError);

        expect(redirect.redirect).toHaveBeenCalledWith(
            '/login?error=account_unavailable'
        );
        expect(mocks.requireActiveAccountSession).toHaveBeenCalledWith(
            expect.objectContaining({ id: USER_ID }),
        );
        expect(mocks.from).not.toHaveBeenCalled();
    });
});
