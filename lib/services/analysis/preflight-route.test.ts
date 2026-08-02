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
    suppressOperationalObservation: vi.fn((response: Response) => response),
    insertLandingLead: vi.fn(),
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
    demoStore: {
        createOrReplay: vi.fn(),
        findForOwner: vi.fn(),
    },
    loadFixture: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: mocks.admin }));
vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/observability/request', () => ({
    observeRoute: mocks.observeRoute,
    suppressOperationalObservation: mocks.suppressOperationalObservation,
}));
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
vi.mock('@/lib/services/leads/store', () => ({
    insertLandingLead: mocks.insertLandingLead,
}));
vi.mock('@/lib/services/demo-analysis/store', () => ({ demoAnalysisStore: mocks.demoStore }));
vi.mock('@/lib/services/demo-analysis/fixture-store', () => ({ loadDemoFixtureForVersion: mocks.loadFixture }));

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
import { createDemoFixture, demoReadyPreflight, LEGACY_DEMO_FIXTURE_VERSION } from '@/lib/services/demo-analysis/demo-analysis';

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

function loadedFixture(version: string) {
    return {
        version,
        target: {
            username: 'junho_dem',
            fullName: version === LEGACY_DEMO_FIXTURE_VERSION ? '준호의 공개 프로필' : '모의 분석용 공개 계정',
            bio: version === LEGACY_DEMO_FIXTURE_VERSION ? '사진과 일상을 기록하는 공개 프로필입니다.' : '산책과 사진을 기록하는 데모 프로필입니다.',
            profileImage: version === LEGACY_DEMO_FIXTURE_VERSION ? '/demo-avatars/synthetic-blurred-avatar-1-v1.png' : '/demo-avatars/demo-v3-target-000.webp',
            followersCount: 600, followingCount: 580, isPrivate: false as const,
        },
        fixture: { ...createDemoFixture('route-fixture', version as never), version },
    };
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
        mocks.insertLandingLead.mockResolvedValue(undefined);
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
        mocks.loadFixture.mockImplementation(async (version: string) => loadedFixture(version));
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

    it('gives a valid signed canary request-scoped precedence over public production admission', async () => {
        const secret = Buffer.alloc(32, 13).toString('base64url');
        vi.stubEnv('ANALYSIS_TEST_ENTITLEMENTS_ENABLED', 'true');
        vi.stubEnv('ANALYSIS_TEST_ENTITLEMENT_SECRET', secret);
        mocks.admissionAvailable.mockReturnValue(true);
        mocks.trustedAccessMode.mockReturnValue('production');
        const token = createAnalysisTestAdmission({
            userId,
            targetInstagramId: 'target.name',
            idempotencyKey: 'preflight-key-000000000000',
            nonce: 'preflight_admission_nonce_02',
        }, { secret });

        const response = await createPreflight(postRequest(
            { targetInstagramId: 'Target.Name' },
            'preflight-key-000000000000',
            token
        ));

        expect(response.status).toBe(202);
        expect(mocks.store.createOrReplay).toHaveBeenCalledWith(
            expect.objectContaining({ accessMode: 'test_entitlement' })
        );
    });

    it('rejects an invalid supplied canary instead of falling through to public production', async () => {
        const secret = Buffer.alloc(32, 13).toString('base64url');
        vi.stubEnv('ANALYSIS_TEST_ENTITLEMENTS_ENABLED', 'true');
        vi.stubEnv('ANALYSIS_TEST_ENTITLEMENT_SECRET', secret);
        mocks.admissionAvailable.mockReturnValue(true);
        mocks.trustedAccessMode.mockReturnValue('production');
        const token = createAnalysisTestAdmission({
            userId,
            targetInstagramId: 'different.target',
            idempotencyKey: 'preflight-key-000000000000',
            nonce: 'preflight_admission_nonce_03',
        }, { secret });

        const response = await createPreflight(postRequest(
            { targetInstagramId: 'Target.Name' },
            'preflight-key-000000000000',
            token
        ));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'V2_PIPELINE_UNAVAILABLE',
        });
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('keeps no-header public admission on the trusted production access mode', async () => {
        mocks.admissionAvailable.mockReturnValue(true);
        mocks.trustedAccessMode.mockReturnValue('production');

        const response = await createPreflight(postRequest());

        expect(response.status).toBe(202);
        expect(mocks.store.createOrReplay).toHaveBeenCalledWith(
            expect.objectContaining({ accessMode: 'production' })
        );
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
            settleBetaCredit: expect.any(Function),
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

    it('observes an unexpected exclusion persistence failure without changing its response', async () => {
        const failure = new Error('PREFLIGHT_PERSISTENCE_ERROR: exclusion failed (PGRST202).');
        mocks.store.setExclusion.mockRejectedValueOnce(failure);
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            const response = await patchPreflight(new Request('https://example.com', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ decision: 'skip' }),
            }), context());

            expect(response.status).toBe(500);
            await expect(response.json()).resolves.toMatchObject({ code: 'ANALYSIS_FAILED' });
            expect(mocks.emit).toHaveBeenCalledWith({
                event: 'preflight.failed',
                severity: 'error',
                fields: expect.objectContaining({
                    user_id: userId,
                    preflight_id: preflightId,
                    operation: 'exclusion',
                    disposition: 'failed',
                    error_code: 'PREFLIGHT_PERSISTENCE_ERROR',
                }),
                error: failure,
            });
            expect(errorSpy).toHaveBeenCalledWith(
                'Preflight exclusion update failed (PREFLIGHT_PERSISTENCE_ERROR).'
            );
        } finally {
            errorSpy.mockRestore();
        }
    });

    it('captures a normalized excluded lead after the durable decision succeeds', async () => {
        const response = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'exclude', excludedInstagramId: 'Girlfriend.Name' }),
        }), context());

        expect(response.status).toBe(204);
        expect(mocks.after).toHaveBeenCalledTimes(1);
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();

        const capture = mocks.after.mock.calls[0]?.[0] as (() => Promise<void>) | undefined;
        await capture?.();

        expect(mocks.insertLandingLead).toHaveBeenCalledWith({
            instagramId: 'girlfriend.name',
            inputContext: 'excluded',
            sourcePreflightId: preflightId,
        });
    });

    it('never lets excluded lead persistence fail the PATCH', async () => {
        mocks.insertLandingLead.mockRejectedValueOnce(new Error('lead database unavailable'));

        const excluded = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'exclude', excludedInstagramId: 'girlfriend.name' }),
        }), context());
        expect(excluded.status).toBe(204);
        expect(mocks.after).toHaveBeenCalledTimes(1);
        const capture = mocks.after.mock.calls[0][0] as () => Promise<void>;
        await expect(capture()).resolves.toBeUndefined();
    });

    it('does not capture skip decisions', async () => {
        const skipped = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'skip' }),
        }), context());
        expect(skipped.status).toBe(204);
        expect(mocks.after).not.toHaveBeenCalled();
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();
    });

    it('keeps a durable exclusion accepted when background scheduling is unavailable', async () => {
        mocks.after.mockImplementationOnce(() => {
            throw new Error('after unavailable');
        });

        const response = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'exclude', excludedInstagramId: 'girlfriend.name' }),
        }), context());

        expect(response.status).toBe(204);
        expect(mocks.store.setExclusion).toHaveBeenCalledTimes(1);
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();
    });

    it('never schedules a lead capture when the exclusion decision is rejected', async () => {
        mocks.store.setExclusion.mockRejectedValueOnce(new InvalidPreflightExclusionError());

        const response = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ decision: 'exclude', excludedInstagramId: 'target.name' }),
        }), context());

        expect(response.status).toBe(400);
        expect(mocks.after).not.toHaveBeenCalled();
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();
    });

    it('isolates the exact allowlisted synthetic target before reservation, task, and provider work', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoStore.createOrReplay.mockResolvedValue({
            run: {
                id: preflightId, user_id: userId, target_instagram_id: 'junho_dem',
                fixture_version: 'synthetic-fixture-v1', idempotency_key: 'preflight-key-000000000000',
                duration_seconds: 75, created_at: expiresAt, started_at: null,
            },
            created: true,
        });

        const response = await createPreflight(postRequest({ targetInstagramId: 'junho_dem' }));
        expect(response.status).toBe(202);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(mocks.demoStore.createOrReplay).toHaveBeenCalledOnce();
        expect(mocks.store.createOrReplay).not.toHaveBeenCalled();
        expect(mocks.store.reserveDispatch).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.process).not.toHaveBeenCalled();
        expect(mocks.resolveDispatch).not.toHaveBeenCalled();
        expect(mocks.emit).not.toHaveBeenCalled();
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(response);
        vi.unstubAllEnvs();
    });

    it('does not emit an operational failure event for a demo request with an invalid idempotency key', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);

        const response = await createPreflight(postRequest({ targetInstagramId: 'junho_dem' }, 'too-short'));

        expect(response.status).toBe(400);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.demoStore.createOrReplay).not.toHaveBeenCalled();
        expect(mocks.emit).not.toHaveBeenCalled();
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(response);
    });

    it('marks every other bounded exact-demo preflight error without marking production', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        const invalid = await createPreflight(postRequest({ targetInstagramId: 'junho_dem', extra: true }));
        expect(invalid.status).toBe(400);
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(invalid);

        mocks.suppressOperationalObservation.mockClear();
        const production = await createPreflight(postRequest({ targetInstagramId: 'target.name', extra: true }));
        expect(production.status).toBe(400);
        expect(mocks.suppressOperationalObservation).not.toHaveBeenCalled();
    });

    it('marks a demo persistence rejection and leaves a production preflight observable', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoStore.createOrReplay.mockResolvedValue(null);
        const rejected = await createPreflight(postRequest({ targetInstagramId: 'junho_dem' }));
        expect(rejected.status).toBe(503);
        expect(rejected.headers.get('x-analytics-eligible')).toBe('0');
        expect(rejected.headers.get('cache-control')).toContain('no-store');
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(rejected);

        mocks.suppressOperationalObservation.mockClear();
        const production = await createPreflight(postRequest({ targetInstagramId: 'target.name' }));
        expect(production.status).toBe(202);
        expect(mocks.suppressOperationalObservation).not.toHaveBeenCalled();
    });

    it('marks a thrown demo persistence failure without emitting the target', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoStore.createOrReplay.mockRejectedValue(new Error('demo persistence unavailable'));

        const response = await createPreflight(postRequest({ targetInstagramId: 'junho_dem' }));

        expect(response.status).toBe(503);
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(response);
        expect(mocks.emit).not.toHaveBeenCalled();
    });

    it('marks demo preflight GET and PATCH responses, including a revoked operator response', async () => {
        const demo = {
            id: preflightId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'preflight-key-000000000000', duration_seconds: 75, created_at: expiresAt, started_at: null,
        };
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoStore.findForOwner.mockResolvedValue(demo);

        const ready = await getPreflight(new Request('https://example.com'), context());
        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({
            target: demoReadyPreflight(demo, LEGACY_DEMO_FIXTURE_VERSION).target,
        });
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(ready);

        mocks.suppressOperationalObservation.mockClear();
        const acknowledged = await patchPreflight(new Request('https://example.com', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'skip' }),
        }), context());
        expect(acknowledged.status).toBe(204);
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(acknowledged);

        mocks.suppressOperationalObservation.mockClear();
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'false');
        const hidden = await getPreflight(new Request('https://example.com'), context());
        expect(hidden.status).toBe(404);
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(hidden);
    });

    it('reads the exact non-static DB fixture target and fails closed when it is unavailable', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        const fixtureVersion = 'operator-editable-fixture-route-v1';
        const demo = {
            id: preflightId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: fixtureVersion,
            idempotency_key: 'preflight-db-fixture-key', duration_seconds: 38, created_at: expiresAt, started_at: null,
        };
        mocks.demoStore.findForOwner.mockResolvedValue(demo);
        mocks.loadFixture.mockResolvedValue({
            version: fixtureVersion,
            target: { username: 'junho_dem', fullName: 'DB Fixture Target', bio: 'DB fixture bio', profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false },
            fixture: { ...createDemoFixture('database-preflight-fixture'), version: fixtureVersion },
        });
        const ready = await getPreflight(new Request('https://example.com'), context());
        expect(ready.status).toBe(200);
        await expect(ready.json()).resolves.toMatchObject({ target: { fullName: 'DB Fixture Target', bio: 'DB fixture bio' } });
        expect(mocks.loadFixture).toHaveBeenCalledWith(fixtureVersion);
        expect(mocks.store.findForOwner).not.toHaveBeenCalled();

        mocks.loadFixture.mockResolvedValue(null);
        const unavailable = await getPreflight(new Request('https://example.com'), context());
        expect(unavailable.status).toBe(503);
        expect(mocks.store.findForOwner).not.toHaveBeenCalled();
        expect(mocks.process).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('presents expired and started demo preflights as terminal lifecycle states', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoStore.findForOwner.mockResolvedValueOnce({
            id: preflightId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'preflight-key-000000000000', duration_seconds: 75,
            created_at: new Date(Date.now() - 30 * 60_000 - 1_000).toISOString(), started_at: null,
        });
        const expired = await getPreflight(new Request('https://example.com'), context());
        expect(expired.status).toBe(410);
        expect(expired.headers.get('x-analytics-eligible')).toBe('0');
        expect(expired.headers.get('cache-control')).toContain('no-store');
        await expect(expired.json()).resolves.toMatchObject({ code: 'PREFLIGHT_EXPIRED' });

        mocks.demoStore.findForOwner.mockResolvedValueOnce({
            id: preflightId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'preflight-key-000000000000', duration_seconds: 75,
            created_at: expiresAt, started_at: new Date().toISOString(),
        });
        const consumed = await getPreflight(new Request('https://example.com'), context());
        expect(consumed.status).toBe(200);
        await expect(consumed.json()).resolves.toMatchObject({ status: 'consumed', requestId: preflightId });
    });

    it.each([
        new Request('https://example.com', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{',
        }),
        new Request('https://example.com', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'invalid' }),
        }),
    ])('marks malformed demo PATCH bodies before production exclusion work', async request => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoStore.findForOwner.mockResolvedValue({
            id: preflightId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'preflight-key-000000000000', duration_seconds: 75, created_at: expiresAt, started_at: null,
        });

        const response = await patchPreflight(request, context());

        expect(response.status).toBe(400);
        expect(mocks.suppressOperationalObservation).toHaveBeenCalledWith(response);
        expect(mocks.emit).not.toHaveBeenCalled();
        expect(mocks.insertLandingLead).not.toHaveBeenCalled();
        expect(mocks.store.setExclusion).not.toHaveBeenCalled();
    });
});
