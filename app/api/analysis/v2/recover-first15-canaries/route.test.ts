import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    config: vi.fn(),
    verify: vi.fn(),
    workerAvailable: vi.fn(),
    recover: vi.fn(),
}));

vi.mock('@/lib/services/analysis/v2-maintenance-auth', () => ({
    getAnalysisV2MaintenanceAuthConfig: mocks.config,
    verifyAnalysisV2MaintenanceAuthorization: mocks.verify,
}));
vi.mock('@/lib/services/analysis/v2-execution-gate', () => ({
    isAnalysisV2WorkerAvailable: mocks.workerAvailable,
}));
vi.mock('@/lib/services/analysis/first15-canary-provider-recovery', () => ({
    runFirst15CanaryProviderRecovery: mocks.recover,
}));

import { POST } from './route';

function request(authorization = 'Bearer signed'): Request {
    return new Request('https://worker.example.com/api/analysis/v2/recover-first15-canaries', {
        method: 'POST',
        headers: { authorization },
    });
}

describe('first15 canary recovery maintenance route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.config.mockReturnValue({
            oidcAudience: 'https://worker.example.com',
            serviceAccountEmail: 'analysis-maintenance@example-project.iam.gserviceaccount.com',
        });
        mocks.verify.mockResolvedValue(true);
        mocks.workerAvailable.mockReturnValue(true);
        mocks.recover.mockResolvedValue({
            candidates: 3,
            reconciledProviderRuns: 7,
            rearmed: 3,
            dispatched: 3,
        });
    });

    it('runs only the exact recovery service with maintenance authentication', async () => {
        const response = await POST(request());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            candidates: 3,
            reconciledProviderRuns: 7,
            rearmed: 3,
            dispatched: 3,
        });
        expect(mocks.verify).toHaveBeenCalledOnce();
        expect(mocks.recover).toHaveBeenCalledOnce();
    });

    it('does not run recovery when maintenance identity verification fails', async () => {
        mocks.verify.mockResolvedValue(false);

        const response = await POST(request());

        expect(response.status).toBe(401);
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it('does not require the disabled global-recovery gate', async () => {
        mocks.workerAvailable.mockReturnValue(false);

        const response = await POST(request());

        expect(response.status).toBe(503);
        expect(mocks.recover).not.toHaveBeenCalled();
    });

    it('logs only a bounded recovery code when the authoritative sweep fails', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.recover.mockRejectedValueOnce(
            new Error('FIRST15_CANARY_RECOVERY_SENARY_PROVIDER_AUTH_FAILED'),
        );

        const response = await POST(request());

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            code: 'FIRST15_CANARY_RECOVERY_FAILED',
        });
        expect(log).toHaveBeenCalledWith('First15 provider-canary recovery failed.', {
            code: 'FIRST15_CANARY_RECOVERY_SENARY_PROVIDER_AUTH_FAILED',
        });
        log.mockRestore();
    });

    it('does not log an arbitrary recovery exception message', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.recover.mockRejectedValueOnce(new Error('unbounded provider response'));

        const response = await POST(request());

        expect(response.status).toBe(500);
        expect(log).toHaveBeenCalledWith('First15 provider-canary recovery failed.', {
            code: 'FIRST15_CANARY_RECOVERY_UNEXPECTED_FAILURE',
        });
        log.mockRestore();
    });
});
