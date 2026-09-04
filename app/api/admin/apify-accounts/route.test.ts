import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    APIFY_CREDENTIAL_SLOTS,
    type ApifyCredentialSlot,
} from '@/lib/services/instagram/providers/types';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    isAnalysisAuditOperator: vi.fn(),
    createStore: vi.fn(),
    createServerFactory: vi.fn(),
    load: vi.fn(),
    setManualExclusion: vi.fn(),
    refreshPaidSecondary: vi.fn(),
    adminRpc: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { rpc: mocks.adminRpc },
}));
vi.mock('@/lib/services/analysis/score-audit', () => ({
    isAnalysisAuditOperator: mocks.isAnalysisAuditOperator,
}));
vi.mock('@/lib/services/analysis/apify-account-credit-inventory', () => ({
    createApifyAccountCreditInventoryStore: mocks.createStore,
    createServerApifyCreditClientFactory: mocks.createServerFactory,
}));

import { GET, PATCH, POST } from './route';

const operatorId = '11111111-1111-4111-8111-111111111111';

function inventory() {
    return APIFY_CREDENTIAL_SLOTS.map((credentialSlot: ApifyCredentialSlot) => ({
        credentialSlot,
        workloadRole: credentialSlot === 'secondary' ? 'paid' : 'free',
        healthState: 'healthy',
        freshnessState: 'fresh',
        monthlyLimitUsd: 10,
        monthlyUsageUsd: 2,
        effectiveRemainingUsd: 8,
        billingCycleStartAt: '2026-09-01T00:00:00.000Z',
        billingCycleEndAt: '2026-10-01T00:00:00.000Z',
        cycleResetAt: '2026-10-01T00:00:00.000Z',
        observedAt: '2026-09-02T00:00:00.000Z',
        refreshedAt: '2026-09-02T00:00:01.000Z',
        manuallyExcluded: false,
    }));
}

function request(method: string, body?: unknown, headers?: HeadersInit) {
    return new Request('https://example.test/api/admin/apify-accounts', {
        method,
        headers: body === undefined
            ? headers
            : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
}

function authenticate({
    user = { id: operatorId },
    error = null,
}: {
    user?: { id: string } | null;
    error?: { message: string } | null;
} = {}) {
    mocks.createClient.mockResolvedValue({
        auth: {
            getUser: vi.fn().mockResolvedValue({ data: { user }, error }),
        },
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    authenticate();
    mocks.isAnalysisAuditOperator.mockReturnValue(true);
    mocks.load.mockResolvedValue(inventory());
    mocks.setManualExclusion.mockResolvedValue(undefined);
    mocks.refreshPaidSecondary.mockResolvedValue(inventory()[1]);
    mocks.createStore.mockReturnValue({
        load: mocks.load,
        setManualExclusion: mocks.setManualExclusion,
        refreshPaidSecondary: mocks.refreshPaidSecondary,
    });
    mocks.createServerFactory.mockReturnValue(vi.fn(() => ({
        limits: vi.fn(),
        monthlyUsage: vi.fn(),
    })));
});

describe('operator Apify account API', () => {
    it('returns 401 for an unauthenticated request with private no-store headers', async () => {
        authenticate({ user: null, error: { message: 'no session' } });

        const response = await GET(request('GET'));

        expect(response.status).toBe(401);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('returns 403 when an authenticated user is not an audit operator', async () => {
        mocks.isAnalysisAuditOperator.mockReturnValue(false);

        const response = await GET(request('GET'));

        expect(response.status).toBe(403);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('loads exactly ten durable rows in canonical order without creating an Apify client', async () => {
        const rows = inventory();
        const response = await GET(request('GET'));

        expect(response.status).toBe(200);
        expect((await response.json()).inventory).toEqual(rows);
        expect(rows.map(row => row.credentialSlot)).toEqual([...APIFY_CREDENTIAL_SLOTS]);
        expect(mocks.createStore).toHaveBeenCalledWith(expect.objectContaining({ rpc: expect.any(Function) }));
        expect(mocks.load).toHaveBeenCalledWith(expect.any(Number));
        expect(mocks.createServerFactory).not.toHaveBeenCalled();
        expect(mocks.adminRpc).not.toHaveBeenCalled();
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('rejects secondary exclusion before calling the RPC', async () => {
        const response = await PATCH(request('PATCH', {
            credentialSlot: 'secondary',
            excluded: true,
        }));

        expect(response.status).toBe(400);
        expect(mocks.setManualExclusion).not.toHaveBeenCalled();
        expect(mocks.adminRpc).not.toHaveBeenCalled();
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('rejects an unknown exclusion slot before calling the RPC', async () => {
        const response = await PATCH(request('PATCH', {
            credentialSlot: 'unknown',
            excluded: true,
        }));

        expect(response.status).toBe(400);
        expect(mocks.setManualExclusion).not.toHaveBeenCalled();
        expect(mocks.adminRpc).not.toHaveBeenCalled();
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('returns a freshly loaded exact-ten inventory after a valid free exclusion', async () => {
        const rows = inventory();
        rows[7] = { ...rows[7]!, manuallyExcluded: true };
        mocks.load.mockResolvedValue(rows);

        const response = await PATCH(request('PATCH', {
            credentialSlot: 'octonary',
            excluded: true,
        }));

        expect(response.status).toBe(200);
        expect(mocks.setManualExclusion).toHaveBeenCalledWith({
            credentialSlot: 'octonary',
            excluded: true,
        });
        expect(mocks.load).toHaveBeenCalledWith(expect.any(Number));
        const body = await response.json();
        expect(body.inventory).toHaveLength(10);
        expect(body.inventory[7].manuallyExcluded).toBe(true);
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('returns a safe 500 when exclusion persistence fails', async () => {
        mocks.setManualExclusion.mockRejectedValue(new Error('provider token must not escape'));

        const response = await PATCH(request('PATCH', {
            credentialSlot: 'octonary',
            excluded: true,
        }));
        const body = await response.json();

        expect(response.status).toBe(500);
        expect(body).toEqual({ error: 'Failed to update Apify account exclusion' });
        expect(JSON.stringify(body)).not.toContain('provider token');
        expect(mocks.load).not.toHaveBeenCalled();
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('refreshes only paid secondary on an explicit POST action', async () => {
        const secondaryClient = { limits: vi.fn(), monthlyUsage: vi.fn() };
        const factory = vi.fn((slot: ApifyCredentialSlot) => {
            expect(slot).toBe('secondary');
            return secondaryClient;
        });
        mocks.createServerFactory.mockReturnValue(factory);

        const response = await POST(request('POST', { action: 'refresh-paid-secondary' }));
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(mocks.createServerFactory).toHaveBeenCalledTimes(1);
        expect(factory).toHaveBeenCalledWith('secondary');
        expect(mocks.refreshPaidSecondary).toHaveBeenCalledWith({ client: secondaryClient });
        expect(body.inventory).toHaveLength(10);
        expect(body.secondary.credentialSlot).toBe('secondary');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('rejects oversized or unknown mutation bodies before persistence', async () => {
        const response = await PATCH(request(
            'PATCH',
            { credentialSlot: 'octonary', excluded: true },
            { 'content-length': '999999' },
        ));

        expect(response.status).toBe(400);
        expect(mocks.setManualExclusion).not.toHaveBeenCalled();
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });

    it('bounds chunked mutation bodies before parsing JSON', async () => {
        const oversized = new Request('https://example.test/api/admin/apify-accounts', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: `{"credentialSlot":"octonary","excluded":true,"padding":"${'x'.repeat(5_000)}"}`,
        });

        const response = await PATCH(oversized);

        expect(response.status).toBe(400);
        expect(mocks.setManualExclusion).not.toHaveBeenCalled();
        expect(response.headers.get('cache-control')).toBe('private, no-store');
    });
});
