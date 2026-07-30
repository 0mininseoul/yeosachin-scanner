import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
    rpc: vi.fn(),
    from: vi.fn(),
    after: vi.fn(),
    flush: vi.fn(),
    findForOwner: vi.fn(),
    demoStore: {
        findForOwner: vi.fn(),
        startForOwner: vi.fn(),
    },
    emit: vi.fn(),
    suppressOperationalObservation: vi.fn((response: Response) => response),
    observeRoute: vi.fn((
        request: Request,
        route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '423e4567-e89b-42d3-a456-426614174002',
        trace_id: null,
        route,
        method: request.method,
    })),
}));

vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: mocks.rpc, from: mocks.from },
}));
vi.mock('@/lib/observability/request', () => ({
    observeRoute: mocks.observeRoute,
    suppressOperationalObservation: mocks.suppressOperationalObservation,
}));
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
vi.mock('@/lib/services/demo-analysis/store', () => ({ demoAnalysisStore: mocks.demoStore }));

import * as checkoutRoute from '@/app/api/earlybird/checkout/route';
import { POST as waitlist } from '@/app/api/earlybird/waitlist/route';

const checkout = checkoutRoute.POST;
const USER_ID = '123e4567-e89b-42d3-a456-426614174000';
const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174001';
const ORDER_ID = '123e4567-e89b-42d3-a456-426614174002';
const WAITLIST_ID = '123e4567-e89b-42d3-a456-426614174003';
const SELLER_REFERENCE = 'ord.0123456789abcdef0123456789abcdef';

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

async function recoverCheckout(body: unknown, origin = 'https://example.com'): Promise<Response> {
    const handler = (
        checkoutRoute as unknown as {
            PUT?: (request: Request) => Promise<Response>;
        }
    ).PUT;
    expect(handler).toBeTypeOf('function');
    return handler!(new Request('https://example.com/api/earlybird/checkout', {
        method: 'PUT',
        headers: {
            'content-type': 'application/json',
            origin,
        },
        body: JSON.stringify(body),
    }));
}

function recoveryOrderRow(overrides: Record<string, unknown> = {}) {
    return {
        id: ORDER_ID,
        user_id: USER_ID,
        preflight_id: PREFLIGHT_ID,
        plan_id: 'basic',
        pricing_version: 'earlybird-2026-07-v1',
        expected_amount_krw: 14_900,
        expected_groble_product_id: 'basic_product-01',
        buyer_match_policy: 'verified_kakao_phone',
        expected_buyer_phone_number_normalized: '+821012345678',
        expected_buyer_phone_verification_source: 'kakao_rest_api',
        disclosure_version: 'earlybird-24h-v1',
        disclosure_text:
            '현재 얼리버드 기간에는 즉시 자동 판독이 아닌, 결제 완료 후 24시간 이내 판독 결과를 제공합니다.',
        disclosure_accepted_at: '2026-07-24T12:00:00.000Z',
        groble_seller_reference: SELLER_REFERENCE,
        status: 'payment_pending',
        payment_id: null,
        actual_amount_krw: null,
        paid_at: null,
        ...overrides,
    };
}

function currentPhoneRow(overrides: Record<string, unknown> = {}) {
    return {
        id: USER_ID,
        provider: 'kakao',
        phone_number: '010-1234-5678',
        phone_number_normalized: '+821012345678',
        phone_number_verification_source: 'kakao_rest_api',
        phone_number_verified_at: new Date().toISOString(),
        ...overrides,
    };
}

function recoveryQuery(data: unknown) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
}

function installRecoveryOrder(
    order: unknown,
    currentPhone: unknown = currentPhoneRow()
): {
    ownerFilter: ReturnType<typeof vi.fn>;
    userFilter: ReturnType<typeof vi.fn>;
} {
    const orderQuery = recoveryQuery(order);
    const userQuery = recoveryQuery(currentPhone);
    mocks.from.mockImplementation((table: string) => {
        if (table === 'earlybird_orders') return orderQuery;
        if (table === 'users') return userQuery;
        throw new Error(`unexpected table: ${table}`);
    });
    return {
        ownerFilter: orderQuery.eq,
        userFilter: userQuery.eq,
    };
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

function mockCheckoutRecord(created: boolean): void {
    mocks.rpc.mockImplementation(async (name: string) => {
        if (name === 'create_earlybird_checkout') {
            return {
                data: [{ order_id: ORDER_ID, created }],
                error: null,
            };
        }
        if (name === 'issue_earlybird_groble_seller_reference') {
            return { data: SELLER_REFERENCE, error: null };
        }
        return { data: null, error: { message: 'unexpected rpc' } };
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
        mockCheckoutRecord(true);
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
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1'
                + `?ref=${SELLER_REFERENCE}`,
        });
        expect(mocks.rpc).toHaveBeenCalledWith('create_earlybird_checkout', expect.objectContaining({
            p_user_id: USER_ID,
            p_preflight_id: PREFLIGHT_ID,
            p_plan_id: 'basic',
            p_expected_product_id: 'basic_product-01',
            p_expected_amount_krw: 6_900,
            p_pricing_version: 'earlybird-2026-07-v2',
            p_disclosure_version: 'earlybird-auto-start-v2',
        }));
        expect(mocks.rpc).toHaveBeenCalledWith(
            'issue_earlybird_groble_seller_reference',
            { p_order_id: ORDER_ID }
        );
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
                amount_krw: 6_900,
                operation: 'checkout',
                disposition: 'accepted',
            },
        });
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_created'
        )).toHaveLength(1);
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /basic_product-01|basic-checkout-a1|ord\.[a-f0-9]{32}/
        );
        expect(mocks.flush).toHaveBeenCalledOnce();
        expect(mocks.suppressOperationalObservation).not.toHaveBeenCalled();
    });

    it('restores the same pending order on idempotent checkout replay', async () => {
        mockCheckoutRecord(false);
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
                amount_krw: 9_900,
                operation: 'checkout',
                disposition: 'exists',
            }),
        });
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'earlybird.checkout_created'
        )).toHaveLength(1);
        expect(mocks.flush).toHaveBeenCalledOnce();
    });

    it('recovers the same owner-scoped pending checkout after preflight expiry without trusting client commerce fields', async () => {
        const { ownerFilter, userFilter } = installRecoveryOrder(recoveryOrderRow());
        const response = await recoverCheckout({
            preflightId: PREFLIGHT_ID,
        });

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            orderId: ORDER_ID,
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1'
                + `?ref=${SELLER_REFERENCE}`,
        });
        expect(mocks.from).toHaveBeenCalledWith('earlybird_orders');
        expect(ownerFilter).toHaveBeenCalledWith('preflight_id', PREFLIGHT_ID);
        expect(ownerFilter).toHaveBeenCalledWith('user_id', USER_ID);
        expect(mocks.from).toHaveBeenCalledWith('users');
        expect(userFilter).toHaveBeenCalledWith('id', USER_ID);
        expect(mocks.findForOwner).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();

        mocks.from.mockClear();
        const hostile = await recoverCheckout({
            preflightId: PREFLIGHT_ID,
            planId: 'standard',
            amountKrw: 1,
            productId: 'attacker-product',
            checkoutUrl: 'https://attacker.example',
        });
        expect(hostile.status).toBe(400);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('requires authentication and same-origin JSON for checkout recovery', async () => {
        authenticate(null);
        expect((await recoverCheckout({ preflightId: PREFLIGHT_ID })).status).toBe(401);
        expect(mocks.from).not.toHaveBeenCalled();

        authenticate();
        expect((await recoverCheckout(
            { preflightId: PREFLIGHT_ID },
            'https://attacker.example'
        )).status).toBe(403);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('does not expose another owner order and never recovers paid or cancelled checkout state', async () => {
        installRecoveryOrder(null);
        const hidden = await recoverCheckout({ preflightId: PREFLIGHT_ID });
        expect(hidden.status).toBe(404);
        await expect(hidden.json()).resolves.toEqual({
            code: 'EARLYBIRD_CHECKOUT_RECOVERY_NOT_FOUND',
            error: '복구할 결제창이 없습니다.',
        });

        for (const status of ['paid', 'cancelled'] as const) {
            installRecoveryOrder(recoveryOrderRow({ status }));
            const conflict = await recoverCheckout({ preflightId: PREFLIGHT_ID });
            expect(conflict.status).toBe(409);
            const body = await conflict.json();
            expect(body).toEqual({
                code: 'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE',
                error: '이 주문의 결제창을 다시 열 수 없습니다.',
            });
            expect(JSON.stringify(body)).not.toContain(SELLER_REFERENCE);
        }
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('requires a current verified Kakao phone and exact immutable phone match before recovery', async () => {
        const staleVerification = new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString();
        for (const [currentPhone, expected] of [
            [
                currentPhoneRow({ phone_number_verified_at: staleVerification }),
                {
                    code: 'CHECKOUT_PHONE_REQUIRED',
                    error: '카카오 계정의 전화번호 동의 정보를 확인한 뒤 다시 로그인해주세요.',
                },
            ],
            [
                currentPhoneRow({
                    phone_number: null,
                    phone_number_normalized: null,
                    phone_number_verification_source: null,
                    phone_number_verified_at: null,
                }),
                {
                    code: 'CHECKOUT_PHONE_REQUIRED',
                    error: '카카오 계정의 전화번호 동의 정보를 확인한 뒤 다시 로그인해주세요.',
                },
            ],
            [
                currentPhoneRow({
                    phone_number: '010-9999-8888',
                    phone_number_normalized: '+821099998888',
                }),
                {
                    code: 'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE',
                    error: '이 주문의 결제창을 다시 열 수 없습니다.',
                },
            ],
        ] as const) {
            installRecoveryOrder(recoveryOrderRow(), currentPhone);
            const response = await recoverCheckout({ preflightId: PREFLIGHT_ID });
            expect(response.status).toBe(409);
            const body = await response.json();
            expect(body).toEqual(expected);
            expect(JSON.stringify(body)).not.toContain(SELLER_REFERENCE);
        }
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('rejects a pending row whose immutable product or disclosure snapshot is inconsistent', async () => {
        for (const overrides of [
            { expected_groble_product_id: 'attacker-product' },
            { expected_amount_krw: 1 },
            { disclosure_text: 'different disclosure' },
            { groble_seller_reference: null },
        ]) {
            installRecoveryOrder(recoveryOrderRow(overrides));
            const response = await recoverCheckout({ preflightId: PREFLIGHT_ID });
            expect(response.status).toBe(409);
            await expect(response.json()).resolves.toEqual({
                code: 'EARLYBIRD_CHECKOUT_NOT_RECOVERABLE',
                error: '이 주문의 결제창을 다시 열 수 없습니다.',
            });
        }
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('preserves a newly-created checkout when background registration throws', async () => {
        mockCheckoutRecord(true);
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
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1'
                + `?ref=${SELLER_REFERENCE}`,
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
                amount_krw: 6_900,
                operation: 'checkout',
                disposition: 'accepted',
            }),
        }]]);
        expect(createdEvents[0][0].fields).not.toHaveProperty('target_instagram_id');
        expect(mocks.flush).not.toHaveBeenCalled();
    });

    it('preserves an idempotent checkout replay when background registration throws', async () => {
        mockCheckoutRecord(false);
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
            checkoutUrl: 'https://groble.im/payment/standard-checkout-b2'
                + `?ref=${SELLER_REFERENCE}`,
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
        mockCheckoutRecord(true);

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            orderId: ORDER_ID,
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1'
                + `?ref=${SELLER_REFERENCE}`,
        });
    });

    it('fails open and allows checkout when the inventory lookup throws', async () => {
        mocks.from.mockImplementation(() => {
            throw new Error('network down');
        });
        mockCheckoutRecord(true);

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            orderId: ORDER_ID,
            checkoutUrl: 'https://groble.im/payment/basic-checkout-a1'
                + `?ref=${SELLER_REFERENCE}`,
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

    it('returns a stable active-pending lineage classification with its stored subreason', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: {
                message: 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE:STALE_PRICING_LINEAGE',
            },
        });
        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            code: 'EARLYBIRD_CHECKOUT_ACTIVE_PENDING_LINEAGE',
            error: '기존 결제창의 처리 상태를 먼저 확인해주세요.',
            subreason: 'STALE_PRICING_LINEAGE',
        });
    });

    it('returns a status-only cancelled unresolved-lineage classification', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: {
                message: 'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE:SUPERSEDED_LINEAGE',
            },
        });
        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            code: 'EARLYBIRD_CHECKOUT_CANCELLED_UNRESOLVED_LINEAGE',
            error: '이전 결제 요청의 처리 상태를 먼저 확인해주세요. 새 결제를 만들 수 없습니다.',
            subreason: 'SUPERSEDED_LINEAGE',
        });
    });

    it('requires a fresh preflight when the stored pricing snapshot predates v2', async () => {
        mocks.rpc.mockResolvedValue({
            data: null,
            error: { message: 'EARLYBIRD_PRICING_REFRESH_REQUIRED' },
        });
        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toEqual({
            code: 'EARLYBIRD_PRICING_REFRESH_REQUIRED',
            error: '가격이 변경되어 대상 계정을 다시 확인해주세요.',
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
                amount_krw: 6_900,
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
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'earlybird.waitlist_created',
            severity: 'info',
            fields: expect.objectContaining({
                request_id: '423e4567-e89b-42d3-a456-426614174002',
                user_id: USER_ID,
                preflight_id: PREFLIGHT_ID,
                plan_id: 'plus',
                operation: 'checkout',
                disposition: 'accepted',
            }),
        });
    });

    it('blocks an owner demo waitlist before RPC, inventory, or checkout events', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', USER_ID);
        mocks.demoStore.findForOwner.mockResolvedValue({ id: PREFLIGHT_ID, user_id: USER_ID });
        const response = await waitlist(request('/api/earlybird/waitlist', { preflightId: PREFLIGHT_ID, planId: 'plus' }));
        expect(response.status).toBe(409);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
        expect(mocks.emit).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('has no automatic analysis or task dispatcher dependency', () => {
        const source = [
            readFileSync(new URL('../../../app/api/earlybird/checkout/route.ts', import.meta.url), 'utf8'),
            readFileSync(new URL('../../../app/api/earlybird/waitlist/route.ts', import.meta.url), 'utf8'),
        ].join('\n');
        expect(source).not.toMatch(/analysis_requests|Cloud Tasks|dispatchAnalysis|enqueue/i);
    });

    it('starts the exact synthetic run before Groble, order, inventory, or commercial events', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', USER_ID);
        mocks.demoStore.findForOwner.mockResolvedValue({
            id: PREFLIGHT_ID, user_id: USER_ID, target_instagram_id: 'junho_dem',
            fixture_version: 'synthetic-fixture-v1', idempotency_key: 'checkout-key-0000000000000',
            duration_seconds: 75, created_at: '2030-01-01T00:00:00.000Z', started_at: null,
        });
        mocks.demoStore.startForOwner.mockResolvedValue({
            id: PREFLIGHT_ID, user_id: USER_ID, target_instagram_id: 'junho_dem',
            fixture_version: 'synthetic-fixture-v1', idempotency_key: 'checkout-key-0000000000000',
            duration_seconds: 75, created_at: '2030-01-01T00:00:00.000Z', started_at: '2030-01-01T00:00:01.000Z',
        });

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID, planId: 'standard', disclosureAccepted: true,
        }));
        expect(response.status).toBe(200);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        await expect(response.json()).resolves.toEqual({ nextUrl: `/progress/${PREFLIGHT_ID}` });
        expect(mocks.demoStore.startForOwner).toHaveBeenCalledWith(PREFLIGHT_ID, USER_ID);
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
        expect(mocks.emit).not.toHaveBeenCalled();
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(response);
        vi.unstubAllEnvs();
    });

    it.each([
        ['flag-off', 'off', 'standard', true, 404, 'NOT_FOUND'],
        ['allowlist-revoked', 'revoked', 'standard', true, 404, 'NOT_FOUND'],
        ['non-Standard plan', 'operator', 'basic', true, 409, 'PLAN_SELECTION_UNAVAILABLE'],
        ['start failure', 'operator', 'standard', false, 409, 'PREFLIGHT_NOT_VALID'],
    ] as const)('keeps the %s demo checkout rejection entirely silent', async (
        _case,
        operatorMode,
        planId,
        startSucceeds,
        expectedStatus,
        expectedCode,
    ) => {
        if (operatorMode === 'off') {
            vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'false');
        } else {
            vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
            vi.stubEnv(
                'DEMO_ANALYSIS_OPERATOR_USER_IDS',
                operatorMode === 'operator' ? USER_ID : '223e4567-e89b-42d3-a456-426614174000'
            );
        }
        mocks.demoStore.findForOwner.mockResolvedValue({ id: PREFLIGHT_ID, user_id: USER_ID });
        mocks.demoStore.startForOwner.mockResolvedValue(startSucceeds ? { id: PREFLIGHT_ID, user_id: USER_ID } : null);

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId,
            disclosureAccepted: true,
        }));

        expect(response.status).toBe(expectedStatus);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        await expect(response.json()).resolves.toMatchObject({ code: expectedCode });
        expect(mocks.emit).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.findForOwner).not.toHaveBeenCalled();
        expect(mocks.demoStore.startForOwner).toHaveBeenCalledTimes(
            planId === 'standard' && operatorMode === 'operator' ? 1 : 0
        );
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(response);
        vi.unstubAllEnvs();
    });

    it('keeps a thrown demo start failure silent and marked', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', USER_ID);
        mocks.demoStore.findForOwner.mockResolvedValue({ id: PREFLIGHT_ID, user_id: USER_ID });
        mocks.demoStore.startForOwner.mockRejectedValue(new Error('demo start unavailable'));

        const response = await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID, planId: 'standard', disclosureAccepted: true,
        }));

        expect(response.status).toBe(409);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(response);
        expect(mocks.emit).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it.each([
        [{ preflightId: PREFLIGHT_ID, planId: 'standard', disclosureAccepted: false }],
        [{ preflightId: PREFLIGHT_ID, unexpected: true }],
    ])('recognizes a UUID-owned demo before malformed checkout validation: %o', async body => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', USER_ID);
        mocks.demoStore.findForOwner.mockResolvedValue({ id: PREFLIGHT_ID, user_id: USER_ID });

        const response = await checkout(request('/api/earlybird/checkout', body));

        expect(response.status).toBe(400);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(response);
        expect(mocks.demoStore.startForOwner).not.toHaveBeenCalled();
        expect(mocks.emit).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.findForOwner).not.toHaveBeenCalled();
    });
});
