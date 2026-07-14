import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AnalysisV2JobDispatchNotReadyError,
    AnalysisV2JobFenceError,
    AnalysisV2JobLeaseBusyError,
} from './v2-job-store';

const mocks = vi.hoisted(() => ({
    config: vi.fn(),
    verify: vi.fn(),
    available: vi.fn(),
    process: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

vi.mock('@/lib/services/analysis/v2-tasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./v2-tasks')>();
    return {
        ...actual,
        getAnalysisV2TasksConfig: mocks.config,
        verifyAnalysisV2TaskAuthorization: mocks.verify,
    };
});
vi.mock('@/lib/services/analysis/v2-execution-gate', () => ({
    isAnalysisV2WorkerAvailable: mocks.available,
}));
vi.mock('@/lib/services/analysis/v2-worker', () => ({
    processAnalysisV2TaskDelivery: mocks.process,
}));

import { POST } from '@/app/api/analysis/v2/worker/route';

const config = {
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-v2',
    targetUrl: 'https://worker.example.com/api/analysis/v2/worker',
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'analysis-task@example-project.iam.gserviceaccount.com',
};
const payload = {
    requestId: '123e4567-e89b-42d3-a456-426614174000',
    jobKey: 'coordinator:bootstrap',
    generation: 1,
    reservationToken: '223e4567-e89b-42d3-a456-426614174000', // gitleaks:allow -- UUID fixture
};

function request(body: unknown = payload, authorization = 'Bearer signed') {
    return new Request('https://worker.example.com/api/analysis/v2/worker', {
        method: 'POST',
        headers: { authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('analysis V2 worker route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.config.mockReturnValue(config);
        mocks.verify.mockResolvedValue(true);
        mocks.available.mockReturnValue(true);
        mocks.process.mockResolvedValue({
            status: 'completed',
            successorCount: 2,
            pendingRecoveryCount: 0,
        });
    });

    it('authenticates OIDC and processes only a strict task payload', async () => {
        const response = await POST(request());
        expect(response.status).toBe(200);
        expect(mocks.verify).toHaveBeenCalledWith('Bearer signed', { config });
        expect(mocks.process).toHaveBeenCalledWith(payload);

        const malformed = await POST(request({ ...payload, username: 'raw_user' }));
        expect(malformed.status).toBe(400);
        expect(mocks.process).toHaveBeenCalledOnce();
    });

    it('uses only the worker drain gate, independently from new admission', async () => {
        mocks.available.mockReturnValue(false);
        const response = await POST(request());
        expect(response.status).toBe(503);
        expect(mocks.process).not.toHaveBeenCalled();
    });

    it('acknowledges a stale generation but retries early delivery and a busy lease', async () => {
        mocks.process.mockRejectedValueOnce(new AnalysisV2JobFenceError());
        const stale = await POST(request());
        expect(stale.status).toBe(200);
        await expect(stale.json()).resolves.toEqual({ status: 'stale_delivery' });

        mocks.process.mockRejectedValueOnce(new AnalysisV2JobDispatchNotReadyError());
        const early = await POST(request());
        expect(early.status).toBe(409);
        await expect(early.json()).resolves.toEqual({ code: 'JOB_DISPATCH_NOT_READY' });

        mocks.process.mockRejectedValueOnce(new AnalysisV2JobLeaseBusyError());
        const busy = await POST(request());
        expect(busy.status).toBe(409);
    });

    it('returns a retryable server error for transient handler failures', async () => {
        mocks.process.mockResolvedValueOnce({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        const response = await POST(request());
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
    });
});
