import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
    loadCurrentEarlybirdCheckoutPhone: vi.fn(),
    recoverEarlybirdCheckout: vi.fn(),
    findCheckoutForRedirect: vi.fn(),
    getGrobleCheckoutUrl: vi.fn(),
    readGrobleConfig: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
    observeRoute: vi.fn((
        request: Request,
        _route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '30000000-0000-4000-8000-000000000001',
        trace_id: null,
        route: '/api/earlybird/checkout/redirect',
        method: request.method,
    })),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/identity/account-principal-store', () => ({
    AccountPrincipalAdmissionError: class AccountPrincipalAdmissionError extends Error {},
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));
vi.mock('@/lib/services/earlybird/checkout', () => ({
    EarlybirdCheckoutRecoveryError: class EarlybirdCheckoutRecoveryError extends Error {},
    loadCurrentEarlybirdCheckoutPhone: mocks.loadCurrentEarlybirdCheckoutPhone,
    recoverEarlybirdCheckout: mocks.recoverEarlybirdCheckout,
}));
vi.mock('@/lib/services/earlybird/store', () => ({
    EarlybirdPersistenceError: class EarlybirdPersistenceError extends Error {},
    earlybirdStore: { findCheckoutForRedirect: mocks.findCheckoutForRedirect },
}));
vi.mock('@/lib/services/groble/config', () => ({
    getGrobleCheckoutUrl: mocks.getGrobleCheckoutUrl,
    readGrobleConfig: mocks.readGrobleConfig,
}));
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
    flushOperationalLogs: mocks.flush,
}));

import { GET } from './route';

const routeSource = () => readFileSync(
    new URL('./route.ts', import.meta.url),
    'utf8',
);

describe('same-origin earlybird checkout redirect route contract', () => {
    const userId = '40000000-0000-4000-8000-000000000001';
    const orderId = '40000000-0000-4000-8000-000000000002';
    const preflightId = '40000000-0000-4000-8000-000000000003';

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({
            auth: {
                getUser: vi.fn().mockResolvedValue({
                    data: { user: { id: userId } },
                    error: null,
                }),
            },
        });
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId,
            lifecycle: 'active',
        });
        mocks.findCheckoutForRedirect.mockResolvedValue({
            orderId,
            userId,
            preflightId,
            targetInstagramId: 'target.account',
            planId: 'standard',
            sellerReference: 'ord.0123456789abcdef0123456789abcdef',
            createdAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
        });
        mocks.loadCurrentEarlybirdCheckoutPhone.mockResolvedValue({
            normalizedPhone: '+821012345678',
            verificationSource: 'kakao_rest_api',
        });
        mocks.recoverEarlybirdCheckout.mockResolvedValue({
            orderId,
            planId: 'standard',
            expectedAmountKrw: 19_900,
        });
        mocks.readGrobleConfig.mockReturnValue({ productIds: { standard: 'server-product' } });
        mocks.getGrobleCheckoutUrl.mockReturnValue('https://groble.im/payment/server-address');
        mocks.flush.mockResolvedValue(undefined);
    });

    it('returns 303/no-store only after owner and payment-session validation', async () => {
        const response = await GET(new Request(
            `https://example.com/api/earlybird/checkout/redirect?orderId=${orderId}&planId=standard`,
        ));

        expect(response.status).toBe(303);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('location')).toBe(
            'https://groble.im/payment/server-address',
        );
        expect(mocks.findCheckoutForRedirect).toHaveBeenCalledWith(
            userId,
            orderId,
            'standard',
        );
        expect(mocks.recoverEarlybirdCheckout).toHaveBeenCalledWith(expect.objectContaining({
            userId,
            preflightId,
            planId: 'standard',
            targetInstagramId: 'target.account',
        }));
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'earlybird.checkout_redirected',
            severity: 'info',
            fields: expect.objectContaining({
                plan_id: 'standard',
                operation: 'checkout',
                disposition: 'redirected',
            }),
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /groble\.im|ord\.|010-|seller|phone|user_id|order_id/i,
        );
    });

    it('keeps malformed input and failed age validation on a same-origin 303', async () => {
        const malformed = await GET(new Request(
            'https://example.com/api/earlybird/checkout/redirect?planId=standard',
        ));
        expect(malformed.status).toBe(303);
        expect(malformed.headers.get('cache-control')).toBe('no-store');
        expect(malformed.headers.get('location')).toBe(
            'https://example.com/earlybird?plan=standard&checkout=unavailable',
        );
        expect(mocks.createClient).not.toHaveBeenCalled();

        mocks.recoverEarlybirdCheckout.mockRejectedValueOnce(
            new Error('EARLYBIRD_CHECKOUT_NOT_RECOVERABLE'),
        );
        const expired = await GET(new Request(
            `https://example.com/api/earlybird/checkout/redirect?orderId=${orderId}&planId=standard`,
        ));
        expect(expired.status).toBe(303);
        expect(expired.headers.get('location')).toBe(
            'https://example.com/earlybird?plan=standard&checkout=unavailable',
        );
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'earlybird.checkout_failed',
            fields: expect.objectContaining({
                operation: 'checkout',
                disposition: 'rejected',
                error_code: 'INTERNAL_ERROR',
            }),
        }));
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /groble\.im|ord\.|010-|seller|phone|user_id|order_id/i,
        );
    });

    it('keeps unauthorized redirect failures same-origin and records only a bounded code', async () => {
        mocks.emit.mockClear();
        mocks.createClient.mockResolvedValue({
            auth: {
                getUser: vi.fn().mockResolvedValue({
                    data: { user: null },
                    error: { message: 'unauthorized' },
                }),
            },
        });

        const response = await GET(new Request(
            `https://example.com/api/earlybird/checkout/redirect?orderId=${orderId}&planId=standard`,
        ));

        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(
            'https://example.com/earlybird?plan=standard&checkout=unavailable',
        );
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'earlybird.checkout_failed',
            fields: expect.objectContaining({
                operation: 'checkout',
                disposition: 'rejected',
                error_code: 'UNAUTHORIZED',
            }),
        }));
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /groble\.im|ord\.|010-|seller|phone|user_id|order_id/i,
        );
    });

    it('does not require the expiring preflight snapshot for a durable order redirect', async () => {
        // The order query is the authoritative target/owner binding. A
        // preflight snapshot may be past its 30-minute TTL while the order is
        // still inside the 24-hour recovery window.
        const response = await GET(new Request(
            `https://example.com/api/earlybird/checkout/redirect?orderId=${orderId}&planId=standard`,
        ));
        expect(response.status).toBe(303);
        expect(mocks.findCheckoutForRedirect).toHaveBeenCalledOnce();
        expect(mocks.loadCurrentEarlybirdCheckoutPhone).toHaveBeenCalledOnce();
    });

    it('does not block a valid redirect when success telemetry throws', async () => {
        mocks.emit.mockImplementationOnce(() => {
            throw new Error('telemetry unavailable');
        });

        const response = await GET(new Request(
            `https://example.com/api/earlybird/checkout/redirect?orderId=${orderId}&planId=standard`,
        ));

        expect(response.status).toBe(303);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('revalidates owner, account, phone, pricing, evidence, and age before a 303', () => {
        const source = routeSource();

        expect(source).toContain('export async function GET');
        expect(source).toContain('requireActiveAccountClassification');
        expect(source).toContain('loadCurrentEarlybirdCheckoutPhone');
        expect(source).toContain('recoverEarlybirdCheckout');
        expect(source).toContain('getGrobleCheckoutUrl');
        expect(source).toContain('status: 303');
        expect(source).toContain('Cache-Control');
        expect(source).toContain('no-store');
    });

    it('keeps malformed and failed redirect attempts on a bounded same-origin destination', () => {
        const source = routeSource();

        expect(source).toMatch(/checkout=unavailable|checkout=expired/);
        expect(source).not.toMatch(/JSON\.stringify\([^)]*(seller|phone|url|token)/i);
        expect(source).not.toContain('console.log');
    });
});
