import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
    insert: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock('@/lib/services/feedback/store', () => ({
    insertResultFeedback: mocks.insert,
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { POST } from '@/app/api/result-feedback/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '223e4567-e89b-42d3-a456-426614174000';

function request() {
    return new Request('https://example.com/api/result-feedback', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            origin: 'https://example.com',
        },
        body: JSON.stringify({ requestId, body: '결과 의견' }),
    });
}

describe('result feedback account admission', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
    });

    it('fails closed before an owner feedback write for a retired account', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await POST(request());

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.insert).not.toHaveBeenCalled();
    });
});
