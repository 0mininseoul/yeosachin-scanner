import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    after: vi.fn(),
    createClient: vi.fn(),
    enqueue: vi.fn(),
    getUser: vi.fn(),
    process: vi.fn(),
    resolveDispatch: vi.fn(),
    trustedAccessMode: vi.fn(),
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

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));
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
vi.mock('@/lib/services/analysis/preflight-tasks', () => ({
    enqueuePreflightTask: mocks.enqueue,
    resolvePreflightDispatchPolicy: mocks.resolveDispatch,
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

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
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
    idempotencyKey = 'preflight-key-000000000000'
) {
    return new Request('https://example.com/api/analysis/preflight', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey,
        },
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

    it('returns 503 instead of pending when deterministic task enqueue fails', async () => {
        mocks.enqueue.mockRejectedValue(new Error('queue down'));
        const response = await createPreflight(postRequest());
        expect(response.status).toBe(503);
        expect(mocks.store.createOrReplay).toHaveBeenCalled();
        expect(mocks.store.blockQueueUnavailable).toHaveBeenCalledWith(preflightId, userId);
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

        mocks.store.findForOwner.mockResolvedValue({
            preflightId,
            status: 'expired',
            expiresAt,
            blockedCode: null,
            readySnapshot: null,
        });
        const expired = await getPreflight(new Request('https://example.com'), context());
        expect(expired.status).toBe(410);
        await expect(expired.json()).resolves.toMatchObject({ code: 'PREFLIGHT_EXPIRED' });
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
