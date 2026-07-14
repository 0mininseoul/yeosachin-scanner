import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getConfig: vi.fn(),
    process: vi.fn(),
    processAdmission: vi.fn(),
    verify: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));
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
        const response = await POST(request({ preflightId }));
        expect(response.status).toBe(200);
        expect(mocks.verify).toHaveBeenCalledWith('Bearer signed', { config });
        expect(mocks.process).toHaveBeenCalledWith(preflightId);
        await expect(response.json()).resolves.toEqual({ status: 'ready' });
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
        mocks.process.mockRejectedValue(new Error('transient'));
        const response = await POST(request({ preflightId }));
        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({ code: 'ANALYSIS_FAILED' });
    });
});
