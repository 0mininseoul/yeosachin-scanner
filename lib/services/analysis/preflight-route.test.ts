import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    after: vi.fn(),
    admissionAvailable: vi.fn(),
    createClient: vi.fn(),
    enqueue: vi.fn(),
    getUser: vi.fn(),
    emit: vi.fn(),
    flush: vi.fn(),
    observeRoute: vi.fn((
        _request: Request,
        _route: string,
        operation: (context: Record<string, unknown>) => Promise<Response>,
    ) => operation({
        request_id: '423e4567-e89b-42d3-a456-426614174000',
        trace_id: null,
        route: '/api/analysis/preflight',
        method: _request.method,
    })),
    process: vi.fn(),
    resolveDispatch: vi.fn(),
    trustedAccessMode: vi.fn(),
    admin: {
        from: vi.fn(),
    },
    adminQuery: {
        select: vi.fn(),
        eq: vi.fn(),
        in: vi.fn(),
        abortSignal: vi.fn(),
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
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
    flushOperationalLogs: mocks.flush,
}));
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
    PreflightImmutableError,
    PreflightRateLimitedError,
    buildReadyPreflightSnapshot,
    type ReadyPreflightSnapshot,
} from './preflight';
import { PreflightTaskEnqueueError } from './preflight-tasks';
import { createAnalysisTestAdmission } from './test-entitlement';
import type { InstagramProfile } from '@/lib/types/instagram';

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
const imageProxySigningSecret = Buffer.alloc(32, 15).toString('base64url');

function targetProfile(overrides: Partial<InstagramProfile> = {}): InstagramProfile {
    return {
        username: 'target.name',
        fullName: 'Target',
        bio: 'bio',
        profilePicUrl: 'https://scontent.cdninstagram.com/avatar.jpg',
        followersCount: 350,
        followingCount: 300,
        postsCount: 10,
        isPrivate: false,
        isVerified: false,
        ...overrides,
    };
}

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
        mocks.adminQuery.in.mockReturnValue(mocks.adminQuery);
        mocks.adminQuery.abortSignal.mockResolvedValue({ data: [], error: null });
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
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.failed',
            severity: 'warn',
            fields: expect.objectContaining({
                user_id: userId,
                target_instagram_id: 'target.name',
                operation: 'preflight',
                disposition: 'rate_limited',
                error_code: 'RATE_LIMITED',
            }),
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toContain('owner@example.com');
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
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.requested',
            severity: 'info',
            fields: expect.objectContaining({
                user_id: userId,
                preflight_id: preflightId,
                target_instagram_id: 'target.name',
                provider: 'google',
                operation: 'preflight',
                disposition: 'requested',
            }),
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /owner@example|preflight-key-000000000000/
        );
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
        const response = await createPreflight(postRequest());
        expect(response.status).toBe(202);
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.after).toHaveBeenCalledOnce();
        await mocks.after.mock.calls[0][0]();
        expect(mocks.process).toHaveBeenCalledWith(preflightId, {
            observer: expect.any(Function),
        });
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.profile_collected',
            severity: 'info',
            fields: expect.objectContaining({
                user_id: userId,
                preflight_id: preflightId,
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
                user_id: userId,
                preflight_id: preflightId,
                target_instagram_id: 'target.name',
                input_count: 350,
                output_count: 300,
                plan_id: 'basic',
                operation: 'profile',
                disposition: 'ready',
            }),
        });
        expect(mocks.flush).toHaveBeenCalledOnce();
    });

    it('logs and flushes a blocked local profile outcome at the background boundary', async () => {
        mocks.resolveDispatch.mockReturnValue({ mode: 'local_after' });
        mocks.process.mockImplementation(async (_id, dependencies) => {
            dependencies?.observer?.({
                type: 'profile_collected',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                followersCount: 401,
                followingCount: 302,
            });
            dependencies?.observer?.({
                type: 'completed',
                outcome: 'blocked',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                followersCount: 401,
                followingCount: 302,
                errorCode: 'TARGET_PRIVATE',
            });
            return 'blocked';
        });

        const response = await createPreflight(postRequest());

        expect(response.status).toBe(202);
        await mocks.after.mock.calls[0][0]();
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.completed',
            severity: 'warn',
            fields: expect.objectContaining({
                user_id: userId,
                preflight_id: preflightId,
                target_instagram_id: 'target.name',
                input_count: 401,
                output_count: 302,
                disposition: 'blocked',
                error_code: 'TARGET_PRIVATE',
            }),
        });
        expect(mocks.flush).toHaveBeenCalledOnce();
    });

    it('logs and flushes a retrying local failure without leaking its cause', async () => {
        const error = new Error('private provider response bearer-secret');
        mocks.resolveDispatch.mockReturnValue({ mode: 'local_after' });
        mocks.process.mockImplementation(async (_id, dependencies) => {
            dependencies?.observer?.({
                type: 'failed',
                preflightId,
                userId,
                targetInstagramId: 'target.name',
                category: 'rate_limit',
                retryable: true,
                httpStatus: 429,
                workerAttemptCount: 2,
            });
            throw error;
        });

        const response = await createPreflight(postRequest());

        expect(response.status).toBe(202);
        await mocks.after.mock.calls[0][0]();
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.failed',
            severity: 'error',
            fields: expect.objectContaining({
                user_id: userId,
                preflight_id: preflightId,
                target_instagram_id: 'target.name',
                retryable: true,
                status: 429,
                attempt: 2,
                error_code: 'RATE_LIMITED',
            }),
        });
        expect(JSON.stringify(mocks.emit.mock.calls)).not.toMatch(
            /private provider response|bearer-secret/
        );
        expect(mocks.flush).toHaveBeenCalledOnce();
    });

    it('carries earlybird remaining slots into a ready GET response', async () => {
        vi.stubEnv('IMAGE_PROXY_SIGNING_SECRET', imageProxySigningSecret);
        const snapshot = buildReadyPreflightSnapshot(
            targetProfile(),
            'test_entitlement'
        ) as ReadyPreflightSnapshot;
        mocks.store.findForOwner.mockResolvedValue({
            preflightId,
            status: 'ready',
            expiresAt,
            blockedCode: null,
            readySnapshot: snapshot,
            exclusionDecision: 'skip',
        });
        mocks.adminQuery.abortSignal.mockResolvedValue({
            data: [
                { plan_id: 'basic', sale_limit: 10, sold_count: 7 },
                { plan_id: 'standard', sale_limit: 10, sold_count: 10 },
            ],
            error: null,
        });

        const response = await getPreflight(new Request('https://example.com'), context());

        expect(response.status).toBe(200);
        expect(mocks.admin.from).toHaveBeenCalledWith('earlybird_plan_inventory');
        const body = await response.json() as {
            plans: Array<{ planId: string; remainingSlots?: number }>;
        };
        const byPlan = Object.fromEntries(body.plans.map(plan => [plan.planId, plan]));
        expect(byPlan.basic).toHaveProperty('remainingSlots', 3);
        expect(byPlan.standard).toHaveProperty('remainingSlots', 0);
        expect(byPlan.plus).not.toHaveProperty('remainingSlots');
    });

    it('never queries earlybird plan inventory for a pending GET', async () => {
        const response = await getPreflight(new Request('https://example.com'), context());

        expect(response.status).toBe(200);
        expect(mocks.admin.from).not.toHaveBeenCalledWith('earlybird_plan_inventory');
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
        expect(mocks.emit).toHaveBeenCalledWith({
            event: 'preflight.exclusion_decided',
            severity: 'info',
            fields: expect.objectContaining({
                user_id: userId,
                preflight_id: preflightId,
                excluded_instagram_id: 'girlfriend.name',
                operation: 'exclusion',
                disposition: 'accepted',
            }),
        });

        mocks.store.setExclusion.mockRejectedValueOnce(new InvalidPreflightExclusionError());
        const rejected = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'exclude', excludedInstagramId: 'target.name' }),
        }), context());
        expect(rejected.status).toBe(400);
        await expect(rejected.json()).resolves.toMatchObject({ code: 'INVALID_EXCLUSION' });

        mocks.store.setExclusion.mockRejectedValueOnce(new PreflightImmutableError());
        const conflict = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'skip' }),
        }), context());
        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toMatchObject({ code: 'PREFLIGHT_IMMUTABLE' });
    });
});
