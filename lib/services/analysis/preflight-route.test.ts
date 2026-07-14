import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    after: vi.fn(),
    admissionAvailable: vi.fn(),
    createClient: vi.fn(),
    enqueue: vi.fn(),
    getUser: vi.fn(),
    process: vi.fn(),
    resolveDispatch: vi.fn(),
    trustedAccessMode: vi.fn(),
    admin: {
        from: vi.fn(),
    },
    adminQuery: {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(),
    },
    store: {
        createOrReplay: vi.fn(),
        findForOwner: vi.fn(),
        reserveDispatch: vi.fn(),
        markDispatched: vi.fn(),
        claim: vi.fn(),
        releaseClaim: vi.fn(),
        finalizeReady: vi.fn(),
        finalizeBlocked: vi.fn(),
        blockQueueUnavailable: vi.fn(),
        setExclusion: vi.fn(),
    },
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('next/server', async (importOriginal) => {
    const actual = await importOriginal<typeof import('next/server')>();
    return { ...actual, after: mocks.after };
});
vi.mock('@/lib/services/analysis/preflight', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./preflight')>();
    return {
        ...actual,
        preflightStore: mocks.store,
        processPreflight: mocks.process,
        trustedPreflightAccessMode: mocks.trustedAccessMode,
    };
});
vi.mock('@/lib/services/analysis/preflight-tasks', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./preflight-tasks')>();
    return {
        ...actual,
        enqueuePreflightTask: mocks.enqueue,
        resolvePreflightDispatchPolicy: mocks.resolveDispatch,
    };
});
vi.mock('@/lib/services/analysis/v2-execution-gate', () => ({
    isAnalysisV2AdmissionAvailable: mocks.admissionAvailable,
}));

import { POST as createPreflight } from '@/app/api/analysis/preflight/route';
import {
    GET as getPreflight,
    PATCH as patchPreflight,
} from '@/app/api/analysis/preflight/[preflightId]/route';
import {
    InvalidPreflightExclusionError,
    PreflightRateLimitedError,
} from './preflight';
import { PreflightTaskEnqueueError } from './preflight-tasks';
import { createAnalysisTestAdmission } from './test-entitlement';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const consumedRequestId = '323e4567-e89b-42d3-a456-426614174000';
const expiresAt = '2030-07-13T13:00:00.000Z';
const taskConfig = {
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-preflight',
    targetUrl: 'https://worker.example.com/api/analysis/preflight/worker',
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'preflight-task@example-project.iam.gserviceaccount.com',
};

function postRequest(
    body: unknown = { targetInstagramId: 'Target.Name' },
    idempotencyKey = 'preflight-key-000000000000',
    testAdmission?: string
) {
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Idempotency-Key': idempotencyKey,
    });
    if (testAdmission) headers.set('x-analysis-test-admission', testAdmission);
    return new Request('https://example.com/api/analysis/preflight', {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
    });
}

function context(id = preflightId) {
    return { params: Promise.resolve({ preflightId: id }) };
}

describe('preflight owner routes', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.admissionAvailable.mockReturnValue(true);
        mocks.getUser.mockResolvedValue({
            data: {
                user: {
                    id: userId,
                    email: 'owner@example.com',
                    app_metadata: { provider: 'google' },
                },
            },
            error: null,
        });
        mocks.resolveDispatch.mockReturnValue({ mode: 'queue', config: taskConfig });
        mocks.trustedAccessMode.mockReturnValue('test_entitlement');
        mocks.store.createOrReplay.mockResolvedValue({
            preflightId,
            expiresAt,
            created: true,
            status: 'pending',
        });
        mocks.store.findForOwner.mockResolvedValue({
            preflightId,
            status: 'pending',
            expiresAt,
            blockedCode: null,
            readySnapshot: null,
            exclusionDecision: 'pending',
        });
        mocks.store.reserveDispatch.mockResolvedValue({
            shouldEnqueue: true,
            generation: 1,
            reservationToken: '323e4567-e89b-42d3-a456-426614174000', // gitleaks:allow -- UUID fixture
            status: 'pending',
        });
        mocks.store.markDispatched.mockResolvedValue(undefined);
        mocks.store.setExclusion.mockResolvedValue(undefined);
        mocks.store.blockQueueUnavailable.mockResolvedValue(undefined);
        mocks.enqueue.mockResolvedValue('enqueued');
        mocks.process.mockResolvedValue('ready');
        mocks.admin.from.mockReturnValue(mocks.adminQuery);
        mocks.adminQuery.select.mockReturnValue(mocks.adminQuery);
        mocks.adminQuery.eq.mockReturnValue(mocks.adminQuery);
        mocks.adminQuery.maybeSingle.mockResolvedValue({
            data: {
                id: consumedRequestId,
                user_id: userId,
                preflight_id: preflightId,
                pipeline_version: 'v2',
            },
            error: null,
        });
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('requires a verified Supabase user before creating or reading a preflight', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
        expect((await createPreflight(postRequest())).status).toBe(401);
        expect((await getPreflight(new Request('https://example.com'), context())).status)
            .toBe(401);
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
        expect(mocks.store.findForOwner).not.toHaveBeenCalled();
    });

    it('strictly validates the body and idempotency key', async () => {
        expect((await createPreflight(postRequest({
            targetInstagramId: 'target',
            extra: true,
        }))).status).toBe(400);
        expect((await createPreflight(postRequest(undefined, 'short'))).status).toBe(400);
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
    });

    it('blocks new intake without stopping already authenticated workers', async () => {
        mocks.admissionAvailable.mockReturnValue(false);
        const response = await createPreflight(postRequest());
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'V2_PIPELINE_UNAVAILABLE',
        });
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
    });

    it('admits only a user, target, and idempotency-bound signed canary', async () => {
        const secret = Buffer.alloc(32, 13).toString('base64url');
        vi.stubEnv('ANALYSIS_TEST_ENTITLEMENTS_ENABLED', 'true');
        vi.stubEnv('ANALYSIS_TEST_ENTITLEMENT_SECRET', secret);
        mocks.admissionAvailable.mockReturnValue(false);
        const token = createAnalysisTestAdmission({
            userId,
            targetInstagramId: 'target.name',
            idempotencyKey: 'preflight-key-000000000000',
            nonce: 'preflight_admission_nonce_01',
        }, { secret });

        const accepted = await createPreflight(postRequest(
            { targetInstagramId: 'Target.Name' },
            'preflight-key-000000000000',
            token
        ));
        expect(accepted.status).toBe(202);
        expect(mocks.store.createOrReplay).toHaveBeenCalledOnce();

        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({
            data: {
                user: {
                    id: userId,
                    email: 'owner@example.com',
                    app_metadata: { provider: 'google' },
                },
            },
            error: null,
        });
        const rejected = await createPreflight(postRequest(
            { targetInstagramId: 'other.target' },
            'preflight-key-000000000000',
            token
        ));
        expect(rejected.status).toBe(503);
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
    });

    it('maps the atomic per-user creation budget to a bounded 429', async () => {
        mocks.store.createOrReplay.mockRejectedValue(new PreflightRateLimitedError());

        const response = await createPreflight(postRequest());

        expect(response.status).toBe(429);
        await expect(response.json()).resolves.toMatchObject({
            code: 'PREFLIGHT_RATE_LIMITED',
        });
        expect(mocks.store.reserveDispatch).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('fails closed before persistence when no queue or explicit local runner is available', async () => {
        mocks.resolveDispatch.mockReturnValue({ mode: 'unavailable' });
        const response = await createPreflight(postRequest());
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({ code: 'QUEUE_UNAVAILABLE' });
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
    });

    it('creates through the identity-bound adapter and enqueues before returning pending', async () => {
        const response = await createPreflight(postRequest());
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            preflightId,
            expiresAt,
            status: 'pending',
            exclusionDecision: 'pending',
        });
        expect(mocks.store.createOrReplay).toHaveBeenCalledWith({
            userId,
            email: 'owner@example.com',
            authProvider: 'google',
            targetInstagramId: 'target.name',
            idempotencyKey: 'preflight-key-000000000000',
            accessMode: 'test_entitlement',
        });
        expect(mocks.enqueue).toHaveBeenCalledWith(preflightId, 1, { config: taskConfig });
        expect(mocks.store.markDispatched).toHaveBeenCalledWith({
            preflightId,
            userId,
            generation: 1,
            reservationToken: '323e4567-e89b-42d3-a456-426614174000', // gitleaks:allow -- UUID fixture
        });
    });

    it('terminalizes only a definitive deterministic task rejection', async () => {
        mocks.enqueue.mockRejectedValue(new PreflightTaskEnqueueError('terminal'));
        const response = await createPreflight(postRequest());
        expect(response.status).toBe(503);
        expect(mocks.store.createOrReplay).toHaveBeenCalled();
        expect(mocks.store.blockQueueUnavailable).toHaveBeenCalledWith(preflightId, userId);
    });

    it('keeps an ambiguous deterministic task reservation replayable', async () => {
        mocks.enqueue.mockRejectedValue(new PreflightTaskEnqueueError('replayable'));
        const response = await createPreflight(postRequest());
        expect(response.status).toBe(503);
        expect(mocks.store.createOrReplay).toHaveBeenCalled();
        expect(mocks.store.blockQueueUnavailable).not.toHaveBeenCalled();
        expect(mocks.store.markDispatched).not.toHaveBeenCalled();
    });

    it('does not enqueue another task when an idempotent replay returns an existing row', async () => {
        mocks.store.createOrReplay.mockResolvedValue({
            preflightId,
            expiresAt,
            created: false,
            status: 'pending',
        });
        mocks.store.reserveDispatch.mockResolvedValue({
            shouldEnqueue: false,
            generation: 1,
            reservationToken: null,
            status: 'pending',
        });

        expect((await createPreflight(postRequest())).status).toBe(200);
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.after).not.toHaveBeenCalled();
    });

    it('uses after only for the explicit local runner', async () => {
        mocks.resolveDispatch.mockReturnValue({ mode: 'local_after' });
        const response = await createPreflight(postRequest());
        expect(response.status).toBe(202);
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.after).toHaveBeenCalledOnce();
        await mocks.after.mock.calls[0][0]();
        expect(mocks.process).toHaveBeenCalledWith(preflightId);
    });

    it('owner-filters GET and maps expired rows to a bounded 410', async () => {
        expect((await getPreflight(new Request('https://example.com'), context())).status)
            .toBe(200);
        expect(mocks.store.findForOwner).toHaveBeenCalledWith(preflightId, userId);

        const pendingResponse = await getPreflight(
            new Request('https://example.com'),
            context()
        );
        await expect(pendingResponse.json()).resolves.toEqual({
            schemaVersion: 1,
            preflightId,
            expiresAt,
            status: 'pending',
            exclusionDecision: 'pending',
        });

        mocks.store.findForOwner.mockResolvedValue({
            preflightId,
            status: 'expired',
            expiresAt,
            blockedCode: null,
            readySnapshot: null,
            exclusionDecision: 'pending',
        });
        const expired = await getPreflight(new Request('https://example.com'), context());
        expect(expired.status).toBe(410);
        await expect(expired.json()).resolves.toMatchObject({ code: 'PREFLIGHT_EXPIRED' });
    });

    it('owner-recovers a consumed request even after the preflight TTL', async () => {
        mocks.store.findForOwner.mockResolvedValue({
            preflightId,
            status: 'consumed',
            expiresAt: '2026-07-13T12:00:00.000Z',
            blockedCode: null,
            readySnapshot: null,
            exclusionDecision: 'exclude',
        });

        const response = await getPreflight(new Request('https://example.com'), context());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            preflightId,
            status: 'consumed',
            exclusionDecision: 'exclude',
            requestId: consumedRequestId,
        });
        expect(mocks.admin.from).toHaveBeenCalledWith('analysis_requests');
        expect(mocks.adminQuery.eq).toHaveBeenNthCalledWith(1, 'preflight_id', preflightId);
        expect(mocks.adminQuery.eq).toHaveBeenNthCalledWith(2, 'user_id', userId);
        expect(mocks.adminQuery.eq).toHaveBeenNthCalledWith(3, 'pipeline_version', 'v2');
    });

    it('fails closed when a consumed owner row has no bound request', async () => {
        mocks.store.findForOwner.mockResolvedValue({
            preflightId,
            status: 'consumed',
            expiresAt,
            blockedCode: null,
            readySnapshot: null,
            exclusionDecision: 'skip',
        });
        mocks.adminQuery.maybeSingle.mockResolvedValue({
            data: {
                id: null,
                user_id: userId,
                preflight_id: preflightId,
                pipeline_version: 'v2',
            },
            error: null,
        });

        const response = await getPreflight(new Request('https://example.com'), context());

        expect(response.status).toBe(500);
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            code: 'ANALYSIS_FAILED',
            error: '사전 점검 상태 조회에 실패했습니다.',
        });
    });

    it('strictly stores exclude/skip decisions and rejects target exclusion', async () => {
        const response = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'exclude', excludedInstagramId: 'Girlfriend.Name' }),
        }), context());
        expect(response.status).toBe(204);
        expect(mocks.store.setExclusion).toHaveBeenCalledWith({
            preflightId,
            userId,
            decision: 'exclude',
            excludedInstagramId: 'girlfriend.name',
        });

        mocks.store.setExclusion.mockRejectedValueOnce(new InvalidPreflightExclusionError());
        const rejected = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'exclude', excludedInstagramId: 'target.name' }),
        }), context());
        expect(rejected.status).toBe(400);
        await expect(rejected.json()).resolves.toMatchObject({ code: 'INVALID_EXCLUSION' });
    });
});
