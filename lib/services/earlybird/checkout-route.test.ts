import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
    rpc: vi.fn(),
    from: vi.fn(),
    after: vi.fn(),
    flush: vi.fn(),
    findForOwner: vi.fn(),
    emit: vi.fn(),
    observeRoute: vi.fn((
        _request: Request,
        _route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '423e4567-e89b-42d3-a456-426614174002',
        trace_id: null,
        route: '/api/earlybird/checkout',
        method: 'POST',
    })),
}));

vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
    flushOperationalLogs: mocks.flush,
}));
vi.mock('next/server', async (importOriginal) => {
    const actual = await importOriginal<typeof import('next/server')>();
    return { ...actual, after: mocks.after };
});
vi.mock('@/lib/services/analysis/preflight', () => ({
    preflightStore: { findForOwner: mocks.findForOwner },
}));

import { POST as checkout } from '@/app/api/earlybird/checkout/route';
import { POST as waitlist } from '@/app/api/earlybird/waitlist/route';

const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174001';
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174002';
const WAITLIST_ID = '123e4567-e89b-42d3-a456-426614174003';

function request(path: string, body: unknown, origin = 'https://example.com'): Request {
    return new Request(`https://example.com${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin,
        },
        body: JSON.stringify(body),
    });
}

function authenticate(userId: string | null = USER_ID): void {
    mocks.createServerClient.mockResolvedValue({
        auth: {
            getUser: vi.fn().mockResolvedValue({
                data: { user: userId ? { id: userId } : null },
                error: userId ? null : { message: 'unauthorized' },
            }),
        },
    });
}

describe('earlybird checkout and waitlist routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.after.mockReset();
        mocks.from.mockReset();
        mocks.from.mockReturnValue({
            select: vi.fn(() => ({
                in: vi.fn(() => ({
                    abortSignal: vi.fn(async () => ({ data: [], error: null })),
                })),
            })),
        });
        authenticate();
        process.env.GROBLE_BASIC_PRODUCT_ID = 'basic_product-01';
        process.env.GROBLE_STANDARD_PRODUCT_ID = 'standard_product-01';
        process.env.GROBLE_BASIC_PAYMENT_ADDRESS = 'basic-checkout-a1';
        process.env.GROBLE_STANDARD_PAYMENT_ADDRESS = 'standard-checkout-b2';
        process.env.GROBLE_WEBHOOK_SECRET = 'webhook-secret';
        mocks.flush.mockResolvedValue(undefined);
        mocks.findForOwner.mockResolvedValue({
            preflightId: PREFLIGHT_ID,
            status: 'ready',
            readySnapshot: {
                target: { username: 'target.account' },
            },
        });
    });

    it('rejects unauthenticated, cross-origin, and missing-consent checkout requests', async () => {
        authenticate(null);
        expect((await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }))).status).toBe(401);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'earlybird.checkout_failed',
            severity: 'warn',
            fields: expect.objectContaining({
                operation: 'checkout',
                disposition: 'rejected',
                error_code: 'UNAUTHORIZED',
            }),
        });

        mocks.emit.mockClear();
        authenticate();
        expect((await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }, 'https://attacker.example'))).status).toBe(403);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'earlybird.checkout_failed',
            severity: 'warn',
            fields: expect.objectContaining({
                operation: 'checkout',
                disposition: 'rejected',
                error_code: 'VALIDATION_ERROR',
            }),
        });

        mocks.emit.mockClear();
        expect((await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: false,
            buyerEmail: 'private@example.com',
            signature: 'private-signature',
        }))).status).toBe(400);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'earlybird.checkout_failed',
            severity: 'warn',
            fields: expect.objectContaining({
                user_id: USER_ID,
                operation: 'checkout',
                disposition: 'rejected',
                error_code: 'VALIDATION_ERROR',
            }),
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /private@example|private-signature/
        );
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('uses server-owned Basic product and amount while ignoring client price/count fields', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{ order_id: ORDER_ID, created: true }],
            error: null,
        });
        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
            amountKrw: 1,
            followersCount: 0,
            followingCount: 0,
        }));

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            orderId: ORDER_ID,
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1',
        });
        expect(mocks.rpc).toHaveBeenCalledWith('create_earlybird_checkout', expect.objectContaining({
            p_user_id: USER_ID,
            p_preflight_id: PREFLIGHT_ID,
            p_plan_id: 'basic',
            p_expected_product_id: 'basic_product-01',
            p_expected_amount_krw: 14_900,
            p_pricing_version: 'earlybird-2026-07-v1',
            p_disclosure_version: 'earlybird-24h-v1',
        }));
        expect(mocks.emit.mock.calls.some(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_created'
        )).toBe(false);
        expect(mocks.after).toHaveBeenCalledOnce();
        await mocks.after.mock.calls[0][0]();
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'earlybird.checkout_created',
            severity: 'info',
            fields: {
                request_id: '423e4567-e89b-42d3-a456-426614174002',
                trace_id: null,
                route: '/api/earlybird/checkout',
                method: 'POST',
                user_id: USER_ID,
                preflight_id: PREFLIGHT_ID,
                order_id: ORDER_ID,
                target_instagram_id: 'target.account',
                plan_id: 'basic',
                amount_krw: 14_900,
                operation: 'checkout',
                disposition: 'accepted',
            },
        });
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_created'
        )).toHaveLength(1);
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /basic_product-01|basic-checkout-a1/
        );
        expect(mocks.flush).toHaveBeenCalledOnce();
    });

    it('restores the same pending order on idempotent checkout replay', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{ order_id: ORDER_ID, created: false }],
            error: null,
        });
        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'standard',
            disclosureAccepted: true,
        }));
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ orderId: ORDER_ID });
        expect(mocks.emit.mock.calls.some(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_created'
        )).toBe(false);
        expect(mocks.after).toHaveBeenCalledOnce();
        await mocks.after.mock.calls[0][0]();
        expect(mocks.findForOwner).toHaveBeenCalledWith(PREFLIGHT_ID, USER_ID);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'earlybird.checkout_created',
            severity: 'info',
            fields: expect.objectContaining({
                user_id: USER_ID,
                preflight_id: PREFLIGHT_ID,
                order_id: ORDER_ID,
                target_instagram_id: 'target.account',
                plan_id: 'standard',
                amount_krw: 19_900,
                operation: 'checkout',
                disposition: 'exists',
            }),
        });
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_created'
        )).toHaveLength(1);
        expect(mocks.flush).toHaveBeenCalledOnce();
    });

    it('preserves a newly-created checkout when background registration throws', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{ order_id: ORDER_ID, created: true }],
            error: null,
        });
        mocks.after.mockImplementation(() => {
            throw new Error('after registration unavailable');
        });

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            orderId: ORDER_ID,
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1',
        });
        expect(mocks.findForOwner).not.toHaveBeenCalled();
        const createdEvents = mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_created'
        );
        expect(createdEvents).toEqual([[{
            event: 'earlybird.checkout_created',
            severity: 'info',
            fields: expect.objectContaining({
                user_id: USER_ID,
                preflight_id: PREFLIGHT_ID,
                order_id: ORDER_ID,
                plan_id: 'basic',
                amount_krw: 14_900,
                operation: 'checkout',
                disposition: 'accepted',
            }),
        }]]);
        expect(createdEvents[0][0].fields).not.toHaveProperty('target_instagram_id');
        expect(mocks.flush).not.toHaveBeenCalled();
    });

    it('preserves an idempotent checkout replay when background registration throws', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{ order_id: ORDER_ID, created: false }],
            error: null,
        });
        mocks.after.mockImplementation(() => {
            throw new Error('after registration unavailable');
        });

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'standard',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            orderId: ORDER_ID,
            checkoutUrl: 'https://groble.im/payment/standard-checkout-b2',
        });
        expect(mocks.findForOwner).not.toHaveBeenCalled();
        const createdEvents = mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_created'
        );
        expect(createdEvents).toHaveLength(1);
        expect(createdEvents[0][0]).toEqual({
            event: 'earlybird.checkout_created',
            severity: 'info',
            fields: expect.objectContaining({
                order_id: ORDER_ID,
                plan_id: 'standard',
                disposition: 'exists',
            }),
        });
        expect(createdEvents[0][0].fields).not.toHaveProperty('target_instagram_id');
    });

    it('rejects a sold-out plan checkout without creating the order', async () => {
        mocks.from.mockReturnValue({
            select: vi.fn(() => ({
                in: vi.fn(() => ({
                    abortSignal: vi.fn(async () => ({
                        data: [{ plan_id: 'basic', sale_limit: 10, sold_count: 10 }],
                        error: null,
                    })),
                })),
            })),
        });

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            code: 'EARLYBIRD_SOLD_OUT',
            error: '이 플랜의 얼리버드 물량이 모두 소진되었습니다.',
        });
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('allows checkout when the plan still has remaining slots', async () => {
        mocks.from.mockReturnValue({
            select: vi.fn(() => ({
                in: vi.fn(() => ({
                    abortSignal: vi.fn(async () => ({
                        data: [{ plan_id: 'basic', sale_limit: 10, sold_count: 9 }],
                        error: null,
                    })),
                })),
            })),
        });
        mocks.rpc.mockResolvedValue({
            data: [{ order_id: ORDER_ID, created: true }],
            error: null,
        });

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            orderId: ORDER_ID,
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1',
        });
    });

    it('fails open and allows checkout when the inventory lookup throws', async () => {
        mocks.from.mockImplementation(() => {
            throw new Error('network down');
        });
        mocks.rpc.mockResolvedValue({
            data: [{ order_id: ORDER_ID, created: true }],
            error: null,
        });

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            orderId: ORDER_ID,
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1',
        });
    });

    it('maps server plan validation failures and never creates a Plus payment object', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: { message: 'PLAN_UPGRADE_REQUIRED' },
        });
        expect((await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }))).status).toBe(409);

        vi.clearAllMocks();
        authenticate();
        const plusResponse = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'plus',
            disclosureAccepted: true,
        }));
        expect(plusResponse.status).toBe(409);
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('returns a conflict when a same-plan checkout is already pending', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: { message: 'EARLYBIRD_CHECKOUT_ALREADY_PENDING' },
        });
        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            code: 'EARLYBIRD_CHECKOUT_ALREADY_PENDING',
            error: '기존 결제창의 처리 상태를 먼저 확인해주세요.',
        });
    });

    it('requires a Kakao phone snapshot without returning phone evidence', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: { message: 'CHECKOUT_PHONE_REQUIRED' },
        });
        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(409);
        const body = await response.json();
        expect(body).toEqual({
            code: 'CHECKOUT_PHONE_REQUIRED',
            error: '카카오 계정의 전화번호 동의 정보를 확인한 뒤 다시 로그인해주세요.',
        });
        expect(JSON.stringify(body)).not.toMatch(/\+?82?10[0-9-]+/);
        expect(mocks.after).toHaveBeenCalledOnce();
        await mocks.after.mock.calls[0][0]();
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'earlybird.checkout_failed',
            severity: 'warn',
            fields: expect.objectContaining({
                user_id: USER_ID,
                preflight_id: PREFLIGHT_ID,
                target_instagram_id: 'target.account',
                plan_id: 'basic',
                amount_krw: 14_900,
                operation: 'checkout',
                disposition: 'rejected',
                error_code: 'VALIDATION_ERROR',
            }),
        });
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_failed'
        )).toHaveLength(1);
        expect(mocks.flush).toHaveBeenCalledOnce();
    });

    it('preserves a validated 409 when background registration throws', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: { message: 'CHECKOUT_PHONE_REQUIRED' },
        });
        mocks.after.mockImplementation(() => {
            throw new Error('after registration unavailable');
        });

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            code: 'CHECKOUT_PHONE_REQUIRED',
            error: '카카오 계정의 전화번호 동의 정보를 확인한 뒤 다시 로그인해주세요.',
        });
        expect(mocks.findForOwner).not.toHaveBeenCalled();
        const failedEvents = mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_failed'
        );
        expect(failedEvents).toHaveLength(1);
        expect(failedEvents[0][0]).toEqual({
            event: 'earlybird.checkout_failed',
            severity: 'warn',
            fields: expect.objectContaining({
                preflight_id: PREFLIGHT_ID,
                plan_id: 'basic',
                disposition: 'rejected',
                error_code: 'VALIDATION_ERROR',
            }),
        });
        expect(failedEvents[0][0].fields).not.toHaveProperty('target_instagram_id');
    });

    it('creates only a Plus waitlist row through the service-only RPC', async () => {
        mocks.rpc.mockResolvedValue({
            data: [{ waitlist_id: WAITLIST_ID, created: true }],
            error: null,
        });
        const response = await waitlist(request('/api/earlybird/waitlist', {
            preflightId: PREFLIGHT_ID,
            planId: 'plus',
        }));
        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            waitlistId: WAITLIST_ID,
            status: 'waitlisted',
        });
        expect(mocks.rpc).toHaveBeenCalledWith('join_earlybird_waitlist', {
            p_user_id: USER_ID,
            p_preflight_id: PREFLIGHT_ID,
        });
    });

    it('has no automatic analysis or task dispatcher dependency', () => {
        const source = [
            readFileSync(new URL('../../../app/api/earlybird/checkout/route.ts', import.meta.url), 'utf8'),
            readFileSync(new URL('../../../app/api/earlybird/waitlist/route.ts', import.meta.url), 'utf8'),
        ].join('\n');
        expect(source).not.toMatch(/analysis_requests|Cloud Tasks|dispatchAnalysis|enqueue/i);
    });
});
