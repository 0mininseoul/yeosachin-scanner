import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    config: vi.fn(),
    verify: vi.fn(),
    available: vi.fn(),
    recover: vi.fn(),
}));

vi.mock('@/lib/services/analysis/v2-maintenance-auth', () => ({
    getPreflightMaintenanceAuthConfig: mocks.config,
    verifyAnalysisV2MaintenanceAuthorization: mocks.verify,
}));
vi.mock('@/lib/services/analysis/v2-execution-gate', () => ({
    isPreflightRecoveryAvailable: mocks.available,
}));
vi.mock('@/lib/services/analysis/workload-role', () => ({
    assertAnalysisWorkerWorkloadRole: vi.fn(),
}));
vi.mock('@/lib/services/analysis/capacity-dispatch-recovery', () => ({
    recoverAnalysisCapacityDispatches: mocks.recover,
}));

import { POST } from '@/app/api/analysis/preflight/recover/route';

const config = {
    oidcAudience: 'https://preflight.example.com',
    serviceAccountEmail: 'preflight-maintenance@example-project.iam.gserviceaccount.com',
};

function request(authorization = 'Bearer signed'): Request {
    return new Request('https://preflight.example.com/api/analysis/preflight/recover', {
        method: 'POST',
        headers: { authorization },
    });
}

describe('preflight capacity recovery maintenance route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.config.mockReturnValue(config);
        mocks.verify.mockResolvedValue(true);
        mocks.available.mockReturnValue(true);
        mocks.recover.mockResolvedValue({
            scanned: 2,
            recovered: 2,
            taskPresent: 0,
            skipped: 0,
            failed: 0,
        });
    });

    it('runs only when preflight recovery is enabled', async () => {
        const response = await POST(request());
        expect(response.status).toBe(200);
        expect(mocks.verify).toHaveBeenCalledWith('Bearer signed', { config });
        expect(mocks.recover).toHaveBeenCalledWith({ workloadRole: 'preflight' });

        mocks.available.mockReturnValue(false);
        const closed = await POST(request());
        expect(closed.status).toBe(503);
        await expect(closed.json()).resolves.toEqual({
            code: 'PREFLIGHT_RECOVERY_UNAVAILABLE',
        });
        expect(mocks.recover).toHaveBeenCalledOnce();
    });

    it('rejects cross-role or unauthenticated maintenance before recovery', async () => {
        mocks.verify.mockResolvedValue(false);
        const unauthorized = await POST(request('Bearer paid-maintenance-token'));
        expect(unauthorized.status).toBe(401);
        expect(mocks.recover).not.toHaveBeenCalled();

        mocks.verify.mockResolvedValue(true);
        mocks.config.mockImplementation(() => {
            throw new Error('missing preflight role config');
        });
        const crossRole = await POST(request());
        expect(crossRole.status).toBe(503);
        expect(mocks.recover).not.toHaveBeenCalled();
    });
});
