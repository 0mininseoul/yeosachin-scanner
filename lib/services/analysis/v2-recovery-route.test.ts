import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    config: vi.fn(),
    verify: vi.fn(),
    available: vi.fn(),
    recover: vi.fn(),
}));

vi.mock('@/lib/services/analysis/v2-maintenance-auth', () => ({
    getAnalysisV2MaintenanceAuthConfig: mocks.config,
    verifyAnalysisV2MaintenanceAuthorization: mocks.verify,
}));
vi.mock('@/lib/services/analysis/v2-execution-gate', () => ({
    isAnalysisV2RecoveryAvailable: mocks.available,
}));
vi.mock('@/lib/services/analysis/v2-recovery', () => ({
    recoverAnalysisV2Jobs: mocks.recover,
}));

import { POST } from '@/app/api/analysis/v2/recover/route';

const config = {
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'analysis-maintenance@example-project.iam.gserviceaccount.com',
};

function request() {
    return new Request('https://worker.example.com/api/analysis/v2/recover', {
        method: 'POST',
        headers: { authorization: 'Bearer signed' },
    });
}

describe('analysis V2 recovery route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.config.mockReturnValue(config);
        mocks.verify.mockResolvedValue(true);
        mocks.available.mockReturnValue(true);
        mocks.recover.mockResolvedValue({
            scanned: 2,
            dispatched: 1,
            taskPresent: 1,
            lostRace: 0,
            failed: 0,
        });
    });

    it('runs the bounded recovery scan only for the configured OIDC identity', async () => {
        const response = await POST(request());
        expect(response.status).toBe(200);
        expect(mocks.verify).toHaveBeenCalledWith('Bearer signed', { config });
        expect(mocks.recover).toHaveBeenCalledOnce();
    });

    it('uses only the recovery gate and retries partial failures', async () => {
        mocks.available.mockReturnValue(false);
        const closed = await POST(request());
        expect(closed.status).toBe(503);
        expect(mocks.recover).not.toHaveBeenCalled();

        mocks.available.mockReturnValue(true);
        mocks.recover.mockResolvedValue({
            scanned: 1,
            dispatched: 0,
            taskPresent: 0,
            lostRace: 0,
            failed: 1,
        });
        const retry = await POST(request());
        expect(retry.status).toBe(500);
    });

    it('fails closed before recovery when maintenance auth is unavailable or invalid', async () => {
        mocks.config.mockImplementationOnce(() => {
            throw new Error('missing maintenance config');
        });
        const unavailable = await POST(request());
        expect(unavailable.status).toBe(503);
        await expect(unavailable.json()).resolves.toEqual({
            code: 'MAINTENANCE_UNAVAILABLE',
        });

        mocks.verify.mockResolvedValueOnce(false);
        const unauthorized = await POST(request());
        expect(unauthorized.status).toBe(401);
        expect(mocks.recover).not.toHaveBeenCalled();
    });
});
