import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getConfig: vi.fn(),
    process: vi.fn(),
    processAdmission: vi.fn(),
    verify: vi.fn(),
    emit: vi.fn(),
    observeRoute: vi.fn((
        _request: Request,
        _route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '423e4567-e89b-42d3-a456-426614174001',
        trace_id: null,
        route: '/api/analysis/preflight/worker',
        method: 'POST',
    })),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
}));
vi.mock('@/lib/services/analysis/preflight', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./preflight')>();
    return { ...actual, processPreflight: mocks.process };
});
vi.mock('@/lib/services/analysis/fresh-plan-admission', () => ({
    processAnalysisV2FreshAdmission: mocks.processAdmission,
}));
vi.mock('@/lib/services/analysis/preflight-tasks', () => ({
    getPreflightTasksConfig: mocks.getConfig,
    verifyPreflightTaskAuthorization: mocks.verify,
}));

import { POST } from '@/app/api/analysis/preflight/worker/route';
import { PreflightWorkerRetryError } from './preflight';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const dispatchToken = '123e4567-e89b-42d3-a456-426614174005';
const config = {
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-preflight',
    targetUrl: 'https://worker.example.com/api/analysis/preflight/worker',
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'preflight-task@example-project.iam.gserviceaccount.com',
};

function request(body: unknown, authorization = 'Bearer signed') {
    return new Request('https://worker.example.com/api/analysis/preflight/worker', {
        method: 'POST',
        headers: { authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('preflight worker route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getConfig.mockReturnValue(config);
        mocks.verify.mockResolvedValue(true);
        mocks.process.mockResolvedValue('ready');
        mocks.processAdmission.mockResolvedValue('ready');
    });

    it('rejects an unverified caller before parsing or claiming work', async () => {
        mocks.verify.mockResolvedValue(false);
        const response = await POST(request({ preflightId }));
        expect(response.status).toBe(401);
        expect(mocks.process).not.toHaveBeenCalled();
    });

    it('strictly accepts only a bounded preflight task payload', async () => {
        const response = await POST(request({ preflightId, extra: 'raw-data' }));
        expect(response.status).toBe(400);
        expect(mocks.process).not.toHaveBeenCalled();
    });

    it('runs the claimed domain worker after OIDC verification', async () => {
        const userId = '223e4567-e89b-42d3-a456-426614174000';
        mocks.process.mockImplementation(async (_id, dependencies) => {
            dependencies?.observer?.({
                type: 'profile_collected',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                followersCount: 350,
                followingCount: 300,
            });
            dependencies?.observer?.({
                type: 'completed',
                outcome: 'ready',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                followersCount: 350,
                followingCount: 300,
                requiredPlan: 'basic',
            });
            return 'ready';
        });
        const response = await POST(request({ preflightId }));
        expect(response.status).toBe(200);
        expect(mocks.verify).toHaveBeenCalledWith('Bearer signed', { config });
        expect(mocks.process).toHaveBeenCalledWith(preflightId, {
            observer: expect.any(Function),
        });
        await expect(response.json()).resolves.toEqual({ status: 'ready' });
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.profile_collected',
            severity: 'info',
            fields: expect.objectContaining({
                preflight_id: preflightId,
                user_id: userId,
                target_instagram_id: 'target.name',
                input_count: 350,
                output_count: 300,
                operation: 'profile',
                disposition: 'success',
            }),
        });
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.completed',
            severity: 'info',
            fields: expect.objectContaining({
                preflight_id: preflightId,
                user_id: userId,
                target_instagram_id: 'target.name',
                input_count: 350,
                output_count: 300,
                plan_id: 'basic',
                operation: 'profile',
                disposition: 'ready',
            }),
        });
    });

    it('runs a fenced fresh-admission generation in the same durable Cloud Run worker', async () => {
        const response = await POST(request({
            preflightId,
            kind: 'fresh_admission',
            generation: 3,
            dispatchGeneration: 2,
            dispatchToken,
        }));

        expect(response.status).toBe(200);
        expect(mocks.processAdmission).toHaveBeenCalledWith(
            expect.anything(),
            {
                preflightId,
                generation: 3,
                dispatchGeneration: 2,
                dispatchToken,
            }
        );
        expect(mocks.process).not.toHaveBeenCalled();
    });

    it('rejects an admission task that omits its durable dispatch fence', async () => {
        const response = await POST(request({
            preflightId,
            kind: 'fresh_admission',
            generation: 3,
        }));

        expect(response.status).toBe(400);
        expect(mocks.processAdmission).not.toHaveBeenCalled();
    });

    it('returns a retryable 500 when processing fails', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.process.mockImplementation(async (_id, dependencies) => {
            dependencies?.observer?.({
                type: 'failed',
                preflightId,
                userId: '223e4567-e89b-42d3-a456-426614174000',
                targetInstagramId: 'target.name',
                category: 'rate_limit',
                retryable: true,
                httpStatus: 429,
                workerAttemptCount: 2,
            });
            throw new PreflightWorkerRetryError({
                category: 'rate_limit',
                retryable: true,
                httpStatus: 429,
            }, 2, new Error('raw target.name bearer-secret'));
        });
        const response = await POST(request({ preflightId }));
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ code: 'ANALYSIS_FAILED' });
        expect(log).toHaveBeenCalledOnce();
        const record = String(log.mock.calls[0][0]);
        expect(JSON.parse(record)).toEqual({
            event: 'preflight_worker_failed',
            operation: 'profile',
            category: 'rate_limit',
            retryable: true,
            httpStatus: 429,
            workerAttemptCount: 2,
        });
        expect(record).not.toContain('target.name');
        expect(record).not.toContain('bearer-secret');
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.failed',
            severity: 'error',
            fields: expect.objectContaining({
                preflight_id: preflightId,
                user_id: '223e4567-e89b-42d3-a456-426614174000',
                target_instagram_id: 'target.name',
                operation: 'profile',
                disposition: 'failed',
                retryable: true,
                attempt: 2,
                status: 429,
                error_code: 'RATE_LIMITED',
            }),
        });
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'preflight.failed'
        )).toHaveLength(1);
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /bearer-secret|Bearer signed/
        );
    });

    it('logs only sanitized fresh-admission failure metadata and its bounded attempt', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.processAdmission.mockRejectedValue(new PreflightWorkerRetryError({
            category: 'rate_limit',
            retryable: true,
            httpStatus: 429,
        }, 1, new Error('raw target.name provider-secret')));

        const response = await POST(request({
            preflightId,
            kind: 'fresh_admission',
            generation: 3,
            dispatchGeneration: 2,
            dispatchToken,
        }));

        expect(response.status).toBe(500);
        const record = String(log.mock.calls[0][0]);
        expect(JSON.parse(record)).toEqual({
            event: 'preflight_worker_failed',
            operation: 'fresh_admission',
            category: 'rate_limit',
            retryable: true,
            httpStatus: 429,
            workerAttemptCount: 1,
        });
        expect(record).not.toContain('target.name');
        expect(record).not.toContain('provider-secret');
    });
});
