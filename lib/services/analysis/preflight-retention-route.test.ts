import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    config: vi.fn(),
    verify: vi.fn(),
    retain: vi.fn(),
}));

vi.mock('@/lib/services/analysis/v2-maintenance-auth', () => ({
    getAnalysisV2MaintenanceAuthConfig: mocks.config,
    verifyAnalysisV2MaintenanceAuthorization: mocks.verify,
}));
vi.mock('@/lib/services/analysis/preflight-retention', () => ({
    runPreflightRetention: mocks.retain,
}));

import { POST } from '@/app/api/analysis/preflight/retention/route';

const config = {
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'analysis-maintenance@example-project.iam.gserviceaccount.com',
};
const summary = {
    providerCosts: { eligible: 1, finalized: 1, failed: 0, hasMore: false },
    providerCostReconciliationFailures: 0,
    expiredPurged: 2,
    terminalScrubbed: 1,
    betaCreditRecovered: 0,
    betaCreditArchived: 0,
    betaCreditRecoveryFailures: 0,
    betaCreditArchiveFailures: 0,
    betaCreditRefreshAttempts: 0,
    betaCreditRefreshFailures: 0,
};

function request() {
    return new Request('https://worker.example.com/api/analysis/preflight/retention', {
        method: 'POST',
        headers: { authorization: 'Bearer signed' },
    });
}

describe('preflight retention route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.config.mockReturnValue(config);
        mocks.verify.mockResolvedValue(true);
        mocks.retain.mockResolvedValue(summary);
    });

    it('runs only for the dedicated maintenance identity', async () => {
        const response = await POST(request());
        expect(response.status).toBe(200);
        expect(mocks.verify).toHaveBeenCalledWith('Bearer signed', { config });
        await expect(response.json()).resolves.toEqual(summary);

        mocks.verify.mockResolvedValue(false);
        expect((await POST(request())).status).toBe(401);
    });

    it('returns retryable failure when bounded retention fails', async () => {
        mocks.retain.mockRejectedValue(new Error('rpc'));
        expect((await POST(request())).status).toBe(500);
    });

    it('returns a bounded provider reconciliation failure without failing maintenance', async () => {
        mocks.retain.mockResolvedValue({
            ...summary,
            providerCosts: { eligible: 0, finalized: 0, failed: 0, hasMore: false },
            providerCostReconciliationFailures: 1,
            expiredPurged: 3,
            terminalScrubbed: 2,
            betaCreditRecovered: 1,
            betaCreditArchived: 1,
        });

        const response = await POST(request());
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            providerCostReconciliationFailures: 1,
            expiredPurged: 3,
            terminalScrubbed: 2,
            betaCreditRecovered: 1,
            betaCreditArchived: 1,
        });
    });
});
