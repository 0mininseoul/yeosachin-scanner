import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    config: vi.fn(),
    verify: vi.fn(),
    available: vi.fn(),
    recover: vi.fn(),
}));

vi.mock('@/lib/services/analysis/v2-tasks', () => ({
    getAnalysisV2TasksConfig: mocks.config,
    verifyAnalysisV2TaskAuthorization: mocks.verify,
}));
vi.mock('@/lib/services/analysis/v2-execution-gate', () => ({
    isAnalysisV2StartAvailable: mocks.available,
}));
vi.mock('@/lib/services/analysis/v2-recovery', () => ({
    recoverAnalysisV2Jobs: mocks.recover,
}));

import { POST } from '@/app/api/analysis/v2/recover/route';

const config = {
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-v2',
    targetUrl: 'https://worker.example.com/api/analysis/v2/worker',
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'analysis-task@example-project.iam.gserviceaccount.com',
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

    it('keeps recovery closed with the execution gate and retries partial failures', async () => {
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
});
