import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    config: vi.fn(),
    verify: vi.fn(),
    available: vi.fn(),
    recover: vi.fn(),
    recoverCanary: vi.fn(),
    purgeResultImages: vi.fn(),
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
vi.mock('@/lib/services/analysis/profile-provider-canary-recovery', () => ({
    recoverExpiredProfileProviderCanaries: mocks.recoverCanary,
}));
vi.mock('@/lib/services/media/result-image-purge', () => ({
    purgeConfiguredResultImages: mocks.purgeResultImages,
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
        mocks.recoverCanary.mockResolvedValue({
            scanned: 1,
            finalized: 1,
            failed: 0,
        });
        mocks.purgeResultImages.mockResolvedValue({
            claimed: 2,
            deleted: 2,
            failed: 0,
            hasMore: false,
        });
    });

    it('runs the bounded recovery scan only for the configured OIDC identity', async () => {
        const response = await POST(request());
        expect(response.status).toBe(200);
        expect(mocks.verify).toHaveBeenCalledWith('Bearer signed', { config });
        expect(mocks.recover).toHaveBeenCalledOnce();
        expect(mocks.recoverCanary).toHaveBeenCalledOnce();
        expect(mocks.purgeResultImages).toHaveBeenCalledOnce();
        await expect(response.json()).resolves.toMatchObject({
            profileProviderCanary: { scanned: 1, finalized: 1, failed: 0 },
            resultImagePurge: { claimed: 2, deleted: 2, failed: 0 },
        });
    });

    it('uses only the recovery gate and retries partial failures', async () => {
        mocks.available.mockReturnValue(false);
        const closed = await POST(request());
        expect(closed.status).toBe(503);
        expect(mocks.recover).not.toHaveBeenCalled();
        expect(mocks.recoverCanary).not.toHaveBeenCalled();
        expect(mocks.purgeResultImages).not.toHaveBeenCalled();

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

        mocks.recover.mockResolvedValue({
            scanned: 0,
            dispatched: 0,
            taskPresent: 0,
            lostRace: 0,
            failed: 0,
        });
        mocks.recoverCanary.mockResolvedValue({ scanned: 1, finalized: 0, failed: 1 });
        const canaryRetry = await POST(request());
        expect(canaryRetry.status).toBe(500);

        mocks.recoverCanary.mockResolvedValue({ scanned: 0, finalized: 0, failed: 0 });
        mocks.purgeResultImages.mockResolvedValue({
            claimed: 1,
            deleted: 0,
            failed: 1,
            hasMore: false,
        });
        const purgeRetry = await POST(request());
        expect(purgeRetry.status).toBe(500);
    });

    it('still runs canary cleanup when general recovery throws', async () => {
        mocks.recover.mockRejectedValue(new Error('general recovery unavailable'));

        const response = await POST(request());

        expect(response.status).toBe(500);
        expect(mocks.recover).toHaveBeenCalledOnce();
        expect(mocks.recoverCanary).toHaveBeenCalledOnce();
        expect(mocks.purgeResultImages).toHaveBeenCalledOnce();
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
        expect(mocks.recoverCanary).not.toHaveBeenCalled();
        expect(mocks.purgeResultImages).not.toHaveBeenCalled();
    });
});
