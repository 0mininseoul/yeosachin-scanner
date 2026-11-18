import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    getConfig: vi.fn(),
    isApprovedDevLiveDelivery: vi.fn(),
    requireDevLiveProviderApproval: vi.fn(),
    process: vi.fn(),
    prepareBeta: vi.fn(),
    enqueue: vi.fn(),
    lookup: vi.fn(),
    rearm: vi.fn(),
    mark: vi.fn(),
    processAdmission: vi.fn(),
    runBlite: vi.fn(),
    settleBetaCredit: vi.fn(),
    refreshBetaCredit: vi.fn(),
    betaPrepareEnabled: vi.fn(),
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

vi.mock('@/lib/services/dev-ui/live-analysis', () => ({
    isApprovedDevLiveDelivery: mocks.isApprovedDevLiveDelivery,
}));
vi.mock('@/lib/services/dev-ui/live-budget', () => ({
    requireDevLiveProviderApproval: mocks.requireDevLiveProviderApproval,
}));
vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));
vi.mock('@/lib/observability/request', () => ({ observeRoute: mocks.observeRoute }));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.emit },
}));
vi.mock('@/lib/services/analysis/preflight', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../../lib/services/analysis/preflight')>();
    return {
        ...actual,
        processPreflight: mocks.process,
        preflightStore: {
            ...actual.preflightStore,
            rearmProviderCapacityDispatch: mocks.rearm,
            markProviderCapacityDispatch: mocks.mark,
        },
        prepareBetaPreflightDispatch: mocks.prepareBeta,
    };
});
vi.mock('@/lib/services/analysis/fresh-plan-admission', () => ({
    processAnalysisV2FreshAdmission: mocks.processAdmission,
}));
vi.mock('@/lib/services/precheckout/blite-runner', () => ({
    runPrecheckoutBlite: mocks.runBlite,
}));
vi.mock('@/lib/services/analysis/preflight-tasks', () => ({
    getPreflightTasksConfig: mocks.getConfig,
    verifyPreflightTaskAuthorization: mocks.verify,
    enqueuePreflightTask: mocks.enqueue,
    lookupPreflightTask: mocks.lookup,
}));
vi.mock('@/lib/services/analysis/beta-apify-credit-settlement-runtime', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('../../../lib/services/analysis/beta-apify-credit-settlement-runtime')
    >();
    return {
        ...actual,
        settleBetaApifyPreflightCredit: mocks.settleBetaCredit,
        refreshBetaApifyCreditSnapshots: mocks.refreshBetaCredit,
    };
});
vi.mock('@/lib/services/analysis/betatest-access', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../../lib/services/analysis/betatest-access')>()),
    isAnalysisBetaPrepareEnabled: mocks.betaPrepareEnabled,
}));

import { POST } from '@/app/api/analysis/preflight/worker/route';
import { PreflightWorkerRetryError } from '../../../lib/services/analysis/preflight';
import { sanitizeOperationalEvent } from '@/lib/observability/schema';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const dispatchToken = '123e4567-e89b-42d3-a456-426614174005';
const successorToken = '123e4567-e89b-42d3-a456-426614174006';
const ordinaryTask = { preflightId, workloadRole: 'preflight', generation: 1, reservationToken: dispatchToken };
const config = {
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-preflight',
    targetUrl: 'https://worker.example.com/api/analysis/preflight/worker',
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'preflight-task@example-project.iam.gserviceaccount.com',
};

function request(
    body: unknown,
    authorization = 'Bearer signed',
    extraHeaders: Record<string, string> = {}
) {
    return new Request('https://worker.example.com/api/analysis/preflight/worker', {
        method: 'POST',
        headers: {
            authorization,
            'Content-Type': 'application/json',
            ...extraHeaders,
        },
        body: JSON.stringify(body),
    });
}

describe('preflight worker route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getConfig.mockReturnValue(config);
        mocks.verify.mockResolvedValue(true);
        mocks.process.mockResolvedValue('ready');
        mocks.prepareBeta.mockResolvedValue('prepared');
        mocks.enqueue.mockResolvedValue('enqueued');
        mocks.lookup.mockResolvedValue('exists');
        mocks.rearm.mockResolvedValue({ shouldEnqueue: true, generation: 2, reservationToken: successorToken });
        mocks.mark.mockResolvedValue(true);
        mocks.processAdmission.mockResolvedValue('ready');
        mocks.runBlite.mockResolvedValue('complete');
        mocks.settleBetaCredit.mockResolvedValue(false);
        mocks.refreshBetaCredit.mockResolvedValue(undefined);
        mocks.betaPrepareEnabled.mockReturnValue(true);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('checks the Dev approval only after OIDC and rejects unapproved fenced work', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'preflight');
        mocks.isApprovedDevLiveDelivery.mockResolvedValue(false);
        mocks.verify.mockResolvedValueOnce(false);

        expect((await POST(request(ordinaryTask))).status).toBe(401);
        expect(mocks.isApprovedDevLiveDelivery).not.toHaveBeenCalled();

        expect((await POST(request(ordinaryTask))).status).toBe(403);
        expect(mocks.isApprovedDevLiveDelivery).toHaveBeenCalledWith({ preflightId });
        expect(mocks.process).not.toHaveBeenCalled();
    });

    it('makes the credit refresh available only to approved ordinary Dev work', async () => {
        const refreshUnused = await POST(request(ordinaryTask));
        expect(refreshUnused.status).toBe(200);
        expect(mocks.process.mock.calls[0][1].refreshFreePoolCredits).toBeUndefined();

        vi.stubEnv('DEV_LIVE_WORKLOAD', 'preflight');
        mocks.isApprovedDevLiveDelivery.mockResolvedValue(true);
        expect((await POST(request(ordinaryTask))).status).toBe(200);

        const refresh = mocks.process.mock.calls[1][1].refreshFreePoolCredits;
        expect(refresh).toEqual(expect.any(Function));
        expect(mocks.refreshBetaCredit).not.toHaveBeenCalled();
        await refresh();
        expect(mocks.refreshBetaCredit).toHaveBeenCalledOnce();
    });

    it('skips credit lookup when a Dev approval expires before fallback', async () => {
        vi.stubEnv('DEV_LIVE_WORKLOAD', 'preflight');
        mocks.isApprovedDevLiveDelivery.mockResolvedValue(true);
        expect((await POST(request(ordinaryTask))).status).toBe(200);

        const refresh = mocks.process.mock.calls[0][1].refreshFreePoolCredits;
        mocks.requireDevLiveProviderApproval.mockImplementationOnce(() => {
            throw new Error('DEV_LIVE_BUDGET_UNAVAILABLE');
        });

        await expect(refresh()).rejects.toThrow('DEV_LIVE_BUDGET_UNAVAILABLE');
        expect(mocks.refreshBetaCredit).not.toHaveBeenCalled();
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
        expect(mocks.process).toHaveBeenCalledWith(preflightId, expect.objectContaining({
            betaCreditCoordinator: expect.any(Object),
            settleBetaCredit: expect.any(Function),
            refreshBetaCredit: expect.any(Function),
            observer: expect.any(Function),
        }));
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
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'preflight.profile_collected'
        )).toHaveLength(1);
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'preflight.completed'
        )).toHaveLength(1);
        expect(mocks.observeRoute).toHaveBeenCalledWith(
            expect.any(Request),
            '/api/analysis/preflight/worker',
            expect.any(Function),
            { flush: 'await' },
        );
    });

    it('records one completed terminal event for a business-blocked profile', async () => {
        mocks.process.mockImplementation(async (_id, dependencies) => {
            dependencies?.observer?.({
                type: 'completed',
                outcome: 'blocked',
                preflightId,
                userId: '223e4567-e89b-42d3-a456-426614174000',
                targetInstagramId: 'target.name',
                errorCode: 'TARGET_PRIVATE',
            });
            return 'blocked';
        });

        const response = await POST(request({ preflightId }));

        expect(response.status).toBe(200);
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'preflight.completed'
        )).toHaveLength(1);
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'preflight.failed'
        )).toHaveLength(0);
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
            },
            expect.objectContaining({ betaCreditCoordinator: expect.any(Object) })
        );
        expect(mocks.process).not.toHaveBeenCalled();
    });

    it('routes roleless legacy fresh-admission work through the marker-free drain contract', async () => {
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
            },
            expect.objectContaining({
                betaCreditCoordinator: expect.any(Object),
                legacyDrain: true,
            })
        );
    });

    it('terminally rejects a stale roleless fresh delivery after paid admission is enabled', async () => {
        mocks.processAdmission.mockRejectedValue(
            new Error('ANALYSIS_V2_LEGACY_FRESH_DRAIN_DISABLED'),
        );

        const response = await POST(request({
            preflightId,
            kind: 'fresh_admission',
            generation: 3,
            dispatchGeneration: 2,
            dispatchToken,
        }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({
            status: 'legacy_drain_required',
            code: 'ANALYSIS_V2_LEGACY_FRESH_DRAIN_REQUIRED',
        });
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'preflight.failed',
            severity: 'warn',
            fields: expect.objectContaining({
                disposition: 'legacy_drain_required',
                error_code: 'ANALYSIS_V2_LEGACY_FRESH_DRAIN_REQUIRED',
            }),
        }));
    });

    it('drains only roleless legacy fresh-admission payloads on preflight', async () => {
        const response = await POST(request({
            preflightId,
            kind: 'fresh_admission',
            workloadRole: 'preflight',
            generation: 3,
            dispatchGeneration: 2,
            dispatchToken,
        }));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ code: 'QUEUE_UNAVAILABLE' });
        expect(mocks.processAdmission).not.toHaveBeenCalled();
    });

    it('runs the trusted B-lite task without invoking the profile preflight worker', async () => {
        const response = await POST(request({ preflightId, kind: 'precheckout_blite' }));

        expect(response.status).toBe(200);
        expect(mocks.runBlite).toHaveBeenCalledWith(preflightId);
        expect(mocks.process).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toEqual({ status: 'complete' });
    });

    it('returns retryable 503 after a B-lite capacity defer so Cloud Tasks redelivers the task', async () => {
        mocks.runBlite.mockResolvedValue('capacity_pending');

        const response = await POST(request({ preflightId, kind: 'precheckout_blite' }));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({
            code: 'CAPACITY_PENDING',
            status: 'pending',
        });
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'preflight.failed',
            severity: 'warn',
            fields: expect.objectContaining({
                operation: 'precheckout_blite',
                disposition: 'capacity_pending',
                retryable: true,
                error_code: 'ANALYSIS_PROVIDER_ADMISSION_CAPACITY_PENDING',
            }),
        }));
    });

    it('acknowledges an ordinary capacity delivery after its successor task and DB mark are confirmed', async () => {
        mocks.process.mockResolvedValue('capacity_pending');
        const response = await POST(request(ordinaryTask, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': '6',
        }));

        expect(mocks.rearm).toHaveBeenCalledExactlyOnceWith({
            preflightId, expectedGeneration: 1, expectedReservationToken: dispatchToken,
        });
        expect(mocks.enqueue).toHaveBeenCalledExactlyOnceWith(preflightId, 2, {
            config, reservationToken: successorToken,
        });
        expect(mocks.mark).toHaveBeenCalledExactlyOnceWith({
            preflightId, generation: 2, reservationToken: successorToken,
        });
        expect(mocks.lookup).not.toHaveBeenCalled();
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toEqual({ code: 'CAPACITY_HANDOFF', status: 'pending' });
        expect(mocks.emit).toHaveBeenCalledWith(expect.objectContaining({
            event: 'preflight.completed', severity: 'info',
            fields: expect.objectContaining({
                operation: 'enqueue', disposition: 'enqueued', retryable: false,
            }),
        }));
        const handoff = mocks.emit.mock.calls.find(([event]) => event.fields.disposition === 'enqueued')?.[0];
        expect(sanitizeOperationalEvent(handoff).fields).toMatchObject({
            operation: 'enqueue', disposition: 'enqueued', retryable: false,
        });
    });

    it('acknowledges a successor after an ambiguous enqueue is confirmed by its exact task lookup', async () => {
        mocks.process.mockResolvedValue('capacity_pending');
        mocks.enqueue.mockRejectedValueOnce(new Error('synthetic enqueue response lost'));
        const response = await POST(request(ordinaryTask, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': '6',
        }));

        expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith(preflightId, 2, { config });
        expect(mocks.mark).toHaveBeenCalledExactlyOnceWith({
            preflightId, generation: 2, reservationToken: successorToken,
        });
        expect(response.status).toBe(200);
    });

    it('acknowledges only after an ambiguous mark is confirmed by exact lookup and successful fenced mark replay', async () => {
        mocks.process.mockResolvedValue('capacity_pending');
        mocks.mark.mockRejectedValueOnce(new Error('synthetic mark response lost'));
        const response = await POST(request(ordinaryTask, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': '6',
        }));

        expect(mocks.lookup).toHaveBeenCalledExactlyOnceWith(preflightId, 2, { config });
        expect(mocks.enqueue).toHaveBeenCalledOnce();
        expect(mocks.mark).toHaveBeenCalledTimes(2);
        expect(mocks.mark).toHaveBeenNthCalledWith(2, {
            preflightId, generation: 2, reservationToken: successorToken,
        });
        expect(response.status).toBe(200);
    });

    it.each(['', '5', '-1'])('keeps an ordinary capacity delivery retryable with retry metadata %s', async retryCount => {
        mocks.process.mockResolvedValue('capacity_pending');
        const response = await POST(request(ordinaryTask, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': retryCount,
        }));

        expect(response.status).toBe(503);
        expect(mocks.rearm).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.mark).not.toHaveBeenCalled();
    });

    it('keeps an unfenced legacy ordinary capacity delivery retryable at the safety ceiling', async () => {
        mocks.process.mockResolvedValue('capacity_pending');
        const response = await POST(request({ preflightId }, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': '6',
        }));

        expect(response.status).toBe(503);
        expect(mocks.rearm).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.mark).not.toHaveBeenCalled();
    });

    it('keeps a delivery retryable when rearm does not reserve a successor', async () => {
        mocks.process.mockResolvedValue('capacity_pending');
        mocks.rearm.mockResolvedValueOnce({ shouldEnqueue: false, generation: 1, reservationToken: null });
        const response = await POST(request(ordinaryTask, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': '6',
        }));

        expect(response.status).toBe(503);
        expect(mocks.enqueue).not.toHaveBeenCalled();
        expect(mocks.mark).not.toHaveBeenCalled();
    });

    it.each(['unconfirmed enqueue', 'false mark', 'unconfirmed mark'])(
        'retains a retryable failure for %s instead of acknowledging an unconfirmed handoff',
        async scenario => {
            const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            mocks.process.mockResolvedValue('capacity_pending');
            if (scenario === 'unconfirmed enqueue') {
                mocks.enqueue.mockRejectedValueOnce(new Error('synthetic enqueue response lost'));
                mocks.lookup.mockResolvedValueOnce('not_found');
            } else if (scenario === 'false mark') {
                mocks.mark.mockResolvedValue(false);
            } else {
                mocks.mark.mockRejectedValueOnce(new Error('synthetic mark response lost'));
                mocks.lookup.mockResolvedValueOnce('not_found');
            }
            try {
                const response = await POST(request(ordinaryTask, 'Bearer signed', {
                    'X-CloudTasks-TaskRetryCount': '6',
                }));

                expect(response.status).toBe(500);
                await expect(response.json()).resolves.toEqual({ code: 'ANALYSIS_FAILED' });
                if (scenario === 'unconfirmed enqueue') expect(mocks.mark).not.toHaveBeenCalled();
                else expect(mocks.mark).toHaveBeenCalledTimes(scenario === 'false mark' ? 2 : 1);
            } finally {
                log.mockRestore();
            }
        },
    );

    it('prepares beta credit only with the persisted generation/token fence', async () => {
        const prepareToken = preflightId.replace(/^1/, '3');
        const response = await POST(request({
            preflightId,
            kind: 'beta_prepare',
            userId: '223e4567-e89b-42d3-a456-426614174000',
            prepareGeneration: 2,
            prepareToken,
        }));
        expect(response.status).toBe(200);
        expect(mocks.prepareBeta).toHaveBeenCalledWith(expect.objectContaining({
            preflightId,
            userId: '223e4567-e89b-42d3-a456-426614174000',
            prepareGeneration: 2,
            prepareToken,
            enqueue: expect.any(Function),
        }));
        expect(mocks.process).not.toHaveBeenCalled();
        await expect(response.json()).resolves.toEqual({ status: 'prepared' });
    });

    it('rejects beta preparation before claim/provider work when the active gate is disabled', async () => {
        mocks.betaPrepareEnabled.mockReturnValue(false);
        const response = await POST(request({
            preflightId,
            kind: 'beta_prepare',
            userId: '223e4567-e89b-42d3-a456-426614174000',
            prepareGeneration: 2,
            prepareToken: preflightId.replace(/^1/, '3'),
        }));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ code: 'QUEUE_UNAVAILABLE' });
        expect(mocks.prepareBeta).not.toHaveBeenCalled();
        expect(mocks.process).not.toHaveBeenCalled();
    });

    it('acknowledges retry-exhausted and stale beta prepare deliveries as noops', async () => {
        const payload = {
            preflightId,
            kind: 'beta_prepare' as const,
            userId: '223e4567-e89b-42d3-a456-426614174000',
            prepareGeneration: 2,
            prepareToken: preflightId.replace(/^1/, '3'),
        };
        mocks.prepareBeta.mockResolvedValue('noop');

        const exhausted = await POST(request(payload, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': '6',
        }));
        const stale = await POST(request(payload));

        expect(exhausted.status).toBe(200);
        expect(stale.status).toBe(200);
        await expect(exhausted.json()).resolves.toEqual({ status: 'noop' });
        await expect(stale.json()).resolves.toEqual({ status: 'noop' });
        expect(mocks.process).not.toHaveBeenCalled();
        expect(mocks.enqueue).not.toHaveBeenCalled();
    });

    it('passes only a validated Cloud Tasks delivery retry count to beta prepare', async () => {
        const payload = {
            preflightId,
            kind: 'beta_prepare' as const,
            userId: '223e4567-e89b-42d3-a456-426614174000',
            prepareGeneration: 2,
            prepareToken: preflightId.replace(/^1/, '3'),
        };

        expect((await POST(request(payload, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': '6',
        }))).status).toBe(200);
        expect((await POST(request(payload, 'Bearer signed', {
            'X-CloudTasks-TaskRetryCount': '-1',
        }))).status).toBe(200);

        expect(mocks.prepareBeta).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ deliveryRetryCount: 6 })
        );
        expect(mocks.prepareBeta).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({ deliveryRetryCount: null })
        );
    });

    it('refreshes the exact beta pool only after a fresh-admission block settles credit', async () => {
        mocks.processAdmission.mockResolvedValue('blocked');
        mocks.settleBetaCredit.mockResolvedValue(true);

        const response = await POST(request({
            preflightId,
            kind: 'fresh_admission',
            generation: 3,
            dispatchGeneration: 2,
            dispatchToken,
        }));

        expect(response.status).toBe(200);
        expect(mocks.settleBetaCredit).toHaveBeenCalledWith(
            expect.anything(), preflightId,
            { telemetry: expect.objectContaining({ emit: expect.any(Function) }) }
        );
        expect(mocks.refreshBetaCredit).toHaveBeenCalledWith(
            expect.anything(),
            { telemetry: expect.objectContaining({ emit: expect.any(Function) }) }
        );
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

    it('logs only the persistence operation and database code from a retry cause', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.process.mockRejectedValue(new PreflightWorkerRetryError({
            category: 'persistence',
            retryable: true,
            httpStatus: null,
        }, 3, new Error('PREFLIGHT_PERSISTENCE_ERROR: claim failed (55P03). raw-secret')));

        const response = await POST(request({ preflightId }));

        expect(response.status).toBe(500);
        const record = String(log.mock.calls[0][0]);
        expect(JSON.parse(record)).toEqual({
            event: 'preflight_worker_failed',
            operation: 'profile',
            category: 'persistence',
            retryable: true,
            httpStatus: null,
            workerAttemptCount: 3,
            persistenceOperation: 'claim',
            persistenceCode: '55P03',
        });
        expect(record).not.toContain('raw-secret');
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

    it('does not duplicate a non-retryable terminal profile failure observed by the domain worker', async () => {
        const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        mocks.process.mockImplementation(async (_id, dependencies) => {
            dependencies?.observer?.({
                type: 'failed',
                preflightId,
                userId: '223e4567-e89b-42d3-a456-426614174000',
                targetInstagramId: 'target.name',
                category: 'provider',
                retryable: false,
                httpStatus: null,
                workerAttemptCount: 1,
            });
            throw new Error('provider rejected');
        });

        const response = await POST(request({ preflightId }));

        expect(response.status).toBe(500);
        expect(mocks.emit.mock.calls.filter(([entry]) => (
            entry as { event?: string }).event === 'preflight.failed'
        )).toHaveLength(1);
        expect(log).toHaveBeenCalledOnce();
    });
});
