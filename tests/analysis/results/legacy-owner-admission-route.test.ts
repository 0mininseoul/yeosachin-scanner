import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
    adminFrom: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.adminFrom },
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { POST as startAnalysis } from '@/app/api/analysis/start/route';
import { POST as runAnalysis } from '@/app/api/analysis/run/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const userId = '123e4567-e89b-42d3-a456-426614174000';
const requestId = '223e4567-e89b-42d3-a456-426614174000';

describe('legacy owner analysis admission', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId, email: 'owner@example.com' } }, error: null });
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('fails closed before creating a legacy analysis for a retired account', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await startAnalysis(new Request(
            'https://example.com/api/analysis/start',
            {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'idempotency-key': 'legacy-start-key-000000',
                },
                body: JSON.stringify({ targetInstagramId: 'target.name', targetGender: 'female' }),
            },
        ));

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.adminFrom).not.toHaveBeenCalled();
    });

    it('fails closed before the explicitly enabled legacy run can execute for a retired account', async () => {
        vi.stubEnv('ENABLE_LEGACY_ANALYSIS_RUN', 'true');
        vi.stubEnv('ADMIN_API_KEY', 'review-admin-key');
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await runAnalysis(new Request(
            'https://example.com/api/analysis/run',
            {
                method: 'POST',
                headers: {
                    authorization: 'Bearer review-admin-key',
                    'content-type': 'application/json',
                },
                body: JSON.stringify({ requestId }),
            },
        ));

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.adminFrom).not.toHaveBeenCalled();
    });
});
