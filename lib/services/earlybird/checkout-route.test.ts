import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: mocks.rpc },
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
        authenticate();
        process.env.GROBLE_BASIC_PRODUCT_ID = 'basic_product-01';
        process.env.GROBLE_STANDARD_PRODUCT_ID = 'standard_product-01';
        process.env.GROBLE_BASIC_PAYMENT_ADDRESS = 'basic-checkout-a1';
        process.env.GROBLE_STANDARD_PAYMENT_ADDRESS = 'standard-checkout-b2';
        process.env.GROBLE_WEBHOOK_SECRET = 'webhook-secret';
    });

    it('rejects unauthenticated, cross-origin, and missing-consent checkout requests', async () => {
        authenticate(null);
        expect((await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }))).status).toBe(401);

        authenticate();
        expect((await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: true,
        }, 'https://attacker.example'))).status).toBe(403);
        expect((await checkout(request('/api/earlybird/checkout', {
            preflightId: PREFLIGHT_ID,
            planId: 'basic',
            disclosureAccepted: false,
        }))).status).toBe(400);
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
            p_disclosure_version: 'earlybird-48h-v1',
        }));
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
