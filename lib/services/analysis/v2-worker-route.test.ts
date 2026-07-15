import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    afterEach(() => {
        vi.restoreAllMocks();
    });

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
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.process.mockResolvedValueOnce({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        const response = await POST(request());
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        expect(warning).toHaveBeenCalledOnce();
        expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toEqual({
            schemaVersion: 1,
            event: 'analysis_v2_worker',
            jobKey: 'coordinator:bootstrap',
            outcome: 'retry',
            disposition: 'transient',
            errorCode: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        warning.mockRestore();
    });

    it('sanitizes a returned retry code before logging or responding', async () => {
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.process.mockResolvedValueOnce({
            status: 'retry',
            errorCode: 'APIFY_TOKEN_PROVIDER_SECRET_ERROR',
        });

        const response = await POST(request());
        const serialized = JSON.stringify(warning.mock.calls);

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        expect(serialized).not.toContain('APIFY_TOKEN_PROVIDER_SECRET_ERROR');
        warning.mockRestore();
    });

    it.each([
        'ANALYSIS_V2_PROFILE_AI_BATCH_DRIFT',
        'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE',
        'ANALYSIS_V2_REVERSE_LIKE_RESULT_LIMIT_EXCEEDED',
    ])('preserves the canonical executor code in logs and responses: %s', async errorCode => {
        const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.process.mockResolvedValueOnce({ status: 'failed', errorCode });

        const response = await POST(request());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'failed', errorCode });
        expect(JSON.parse(String(failure.mock.calls[0]?.[0]))).toMatchObject({
            outcome: 'failed',
            disposition: 'permanent',
            errorCode,
        });
        failure.mockRestore();
    });

    it('logs provider quota exhaustion as a permanent failed outcome', async () => {
        const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.process.mockResolvedValueOnce({
            status: 'failed',
            errorCode: 'SCRAPING_PROVIDER_QUOTA_ERROR',
        });

        const response = await POST(request());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            status: 'failed',
            errorCode: 'SCRAPING_PROVIDER_QUOTA_ERROR',
        });
        expect(failure).toHaveBeenCalledOnce();
        expect(JSON.parse(String(failure.mock.calls[0]?.[0]))).toEqual({
            schemaVersion: 1,
            event: 'analysis_v2_worker',
            jobKey: 'coordinator:bootstrap',
            outcome: 'failed',
            disposition: 'permanent',
            errorCode: 'SCRAPING_PROVIDER_QUOTA_ERROR',
        });
        failure.mockRestore();
    });

    it('logs an allowlisted throw outcome without raw errors, headers, URLs, or usernames', async () => {
        const failure = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        mocks.process.mockRejectedValueOnce(new Error(
            'raw_user https://private.example/profile APIFY_TOKEN=provider-secret'
        ));

        const response = await POST(request(payload, 'Bearer header-secret'));
        const serialized = JSON.stringify(failure.mock.calls);

        expect(response.status).toBe(500);
        expect(JSON.parse(String(failure.mock.calls[0]?.[0]))).toEqual({
            schemaVersion: 1,
            event: 'analysis_v2_worker',
            jobKey: 'coordinator:bootstrap',
            outcome: 'error',
            disposition: 'transient',
            errorCode: 'ANALYSIS_V2_WORKER_UNHANDLED_ERROR',
        });
        for (const secret of [
            'raw_user',
            'private.example',
            'provider-secret',
            'header-secret',
        ]) {
            expect(serialized).not.toContain(secret);
        }
        failure.mockRestore();
    });
});
