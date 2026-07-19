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
    emit: vi.fn(),
    observeRoute: vi.fn((
        _request: Request,
        _route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '423e4567-e89b-42d3-a456-426614174001',
        trace_id: null,
        route: '/api/analysis/v2/worker',
        method: 'POST',
    })),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
}));

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
        expect(mocks.observeRoute).toHaveBeenCalledTimes(2);
        expect(mocks.emit.mock.calls.map(call => call[0].event)).toEqual([
            'analysis_v2.worker_completed',
            'analysis_v2.worker_failed',
        ]);
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain('raw_user');
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

        expect(mocks.emit.mock.calls.map(call => call[0])).toEqual([
            expect.objectContaining({
                event: 'analysis_v2.worker_completed',
                fields: expect.objectContaining({
                    analysis_request_id: payload.requestId,
                    job_key: payload.jobKey,
                    disposition: 'stale_delivery',
                    error_code: 'ANALYSIS_V2_JOB_FENCE_MISMATCH',
                }),
            }),
            expect.objectContaining({
                event: 'analysis_v2.worker_retry',
                fields: expect.objectContaining({
                    disposition: 'transient',
                    error_code: 'JOB_DISPATCH_NOT_READY',
                    retryable: true,
                }),
            }),
            expect.objectContaining({
                event: 'analysis_v2.worker_retry',
                fields: expect.objectContaining({
                    disposition: 'transient',
                    error_code: 'JOB_LEASE_BUSY',
                    retryable: true,
                }),
            }),
        ]);
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
        expect(mocks.emit).toHaveBeenCalledOnce();
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'analysis_v2.worker_retry',
            severity: 'warn',
            fields: expect.objectContaining({
                analysis_request_id: payload.requestId,
                job_key: 'coordinator:bootstrap',
                operation: 'worker',
                disposition: 'transient',
                retryable: true,
                error_code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            }),
        });
    });

    it('sanitizes a returned retry code before logging or responding', async () => {
        mocks.process.mockResolvedValueOnce({
            status: 'retry',
            errorCode: 'APIFY_TOKEN_PROVIDER_SECRET_ERROR',
        });

        const response = await POST(request());
        const serialized = JSON.stringify(mocks.emit.mock.calls);

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        expect(serialized).not.toContain('APIFY_TOKEN_PROVIDER_SECRET_ERROR');
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'analysis_v2.worker_retry',
            fields: expect.objectContaining({
                error_code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            }),
        }));
    });

    it.each([
        'ANALYSIS_V2_PROFILE_AI_BATCH_DRIFT',
        'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE',
        'ANALYSIS_V2_REVERSE_LIKE_RESULT_LIMIT_EXCEEDED',
    ])('preserves the canonical executor code in logs and responses: %s', async errorCode => {
        mocks.process.mockResolvedValueOnce({ status: 'failed', errorCode });

        const response = await POST(request());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ status: 'failed', errorCode });
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'analysis_v2.worker_failed',
            severity: 'error',
            fields: expect.objectContaining({
                disposition: 'permanent',
                error_code: errorCode,
                retryable: false,
            }),
        }));
    });

    it('logs provider quota exhaustion as a permanent failed outcome', async () => {
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
        expect(mocks.emit).toHaveBeenCalledOnce();
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'analysis_v2.worker_failed',
            severity: 'error',
            fields: expect.objectContaining({
                job_key: 'coordinator:bootstrap',
                disposition: 'permanent',
                error_code: 'SCRAPING_PROVIDER_QUOTA_ERROR',
                retryable: false,
            }),
        });
    });

    it('logs an allowlisted throw outcome without raw errors, headers, URLs, or usernames', async () => {
        mocks.process.mockRejectedValueOnce(new Error(
            'raw_user https://private.example/profile APIFY_TOKEN=provider-secret'
        ));

        const response = await POST(request(payload, 'Bearer header-secret'));
        const serialized = JSON.stringify(mocks.emit.mock.calls);

        expect(response.status).toBe(500);
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'analysis_v2.worker_retry',
            severity: 'warn',
            fields: expect.objectContaining({
                job_key: 'coordinator:bootstrap',
                disposition: 'transient',
                error_code: 'ANALYSIS_V2_WORKER_UNHANDLED_ERROR',
                retryable: true,
            }),
        });
        for (const secret of [
            'raw_user',
            'private.example',
            'provider-secret',
            'header-secret',
        ]) {
            expect(serialized).not.toContain(secret);
        }
    });

    it('maps completed and already-terminal deliveries to one completed event each', async () => {
        for (const status of ['completed', 'already_terminal'] as const) {
            mocks.emit.mockClear();
            mocks.process.mockResolvedValueOnce({
                status,
                successorCount: 0,
                pendingRecoveryCount: 0,
            });

            const response = await POST(request());

            expect(response.status).toBe(200);
            expect(mocks.emit).toHaveBeenCalledOnce();
            expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
                event: 'analysis_v2.worker_completed',
                fields: expect.objectContaining({ disposition: status }),
            }));
        }
    });

    it('records rejected and unavailable deliveries without leaking invalid bodies', async () => {
        mocks.config.mockImplementationOnce(() => {
            throw new Error('private queue configuration');
        });
        const unavailable = await POST(request());
        expect(unavailable.status).toBe(503);
        expect(mocks.emit).toHaveBeenLastCalledWith(expect.objectContaining({
            event: 'analysis_v2.worker_failed',
            fields: expect.objectContaining({ error_code: 'JOB_DISPATCH_NOT_READY' }),
        }));

        mocks.emit.mockClear();
        const malformed = await POST(request({
            ...payload,
            comment: 'private comment',
            imageUrl: 'https://private.example/image.jpg',
        }));
        expect(malformed.status).toBe(400);
        expect(mocks.emit).toHaveBeenCalledOnce();
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'analysis_v2.worker_failed',
            fields: expect.objectContaining({
                disposition: 'rejected',
                error_code: 'INVALID_REQUEST',
            }),
        }));
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /private comment|private\.example/
        );
    });
});
