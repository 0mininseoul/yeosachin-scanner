import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createServerClient: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
    dispatchJob: vi.fn(),
    getTasksConfig: vi.fn(),
    v2StartAvailable: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/services/analysis/v2-execution-gate', () => ({
    isAnalysisV2StartAvailable: mocks.v2StartAvailable,
}));
vi.mock('@/lib/services/analysis/v2-tasks', () => ({
    dispatchAnalysisV2Job: mocks.dispatchJob,
    getAnalysisV2TasksConfig: mocks.getTasksConfig,
}));

import { POST } from '@/app/api/analysis/preflight/[preflightId]/entitle/route';
import { ANALYSIS_V2_BOOTSTRAP_JOB_KEY } from './v2-coordinator';
import { createAnalysisTestEntitlement } from './test-entitlement';

const PREFLIGHT_ID = '123e4567-e89b-42d3-a456-426614174000';
const USER_ID = '123e4567-e89b-42d3-b456-426614174001';
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174002';
const ENTITLEMENT_SECRET = Buffer.alloc(32, 11).toString('base64url');

interface QueryMock {
    select: ReturnType<typeof vi.fn>;
    eq: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
}

function preflightRow(overrides: Record<string, unknown> = {}) {
    return {
        id: PREFLIGHT_ID,
        user_id: USER_ID,
        status: 'ready',
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
        target_instagram_id: 'target.account',
        target_followers_count: 600,
        target_following_count: 700,
        access_mode: 'test_entitlement',
        capacity_required_plan_id: 'standard',
        required_plan_id: 'standard',
        launch_status_snapshot: {
            basic: 'test_only',
            standard: 'test_only',
            plus: 'test_only',
        },
        plan_cards_snapshot: {
            basic: {
                launchStatus: 'test_only',
                relationshipCapacity: { followers: 400, following: 400 },
                detailedMutualLimit: 300,
                selectionState: 'unavailable',
                unavailableReason: 'below_required_plan',
            },
            standard: {
                launchStatus: 'test_only',
                relationshipCapacity: { followers: 800, following: 800 },
                detailedMutualLimit: 600,
                selectionState: 'required',
                unavailableReason: null,
            },
            plus: {
                launchStatus: 'test_only',
                relationshipCapacity: { followers: 1_200, following: 1_200 },
                detailedMutualLimit: 900,
                selectionState: 'available_upgrade',
                unavailableReason: null,
            },
        },
        exclusion_decision: 'skip',
        excluded_instagram_id: null,
        pricing_version: 'deferred',
        pricing_snapshot: {
            basic: { status: 'deferred', currency: 'KRW', amountKrw: null },
            standard: { status: 'deferred', currency: 'KRW', amountKrw: null },
            plus: { status: 'deferred', currency: 'KRW', amountKrw: null },
        },
        consumed_request_id: null,
        ...overrides,
    };
}

function installPreflightQuery(
    result: { data: unknown; error: unknown } = { data: preflightRow(), error: null }
): QueryMock {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn().mockResolvedValue(result),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    mocks.from.mockReturnValue(query);
    return query;
}

function entitlementToken(planId: 'basic' | 'standard' | 'plus' = 'standard') {
    return createAnalysisTestEntitlement({
        preflightId: PREFLIGHT_ID,
        userId: USER_ID,
        planId,
        nonce: 'route_entitlement_nonce_01',
    }, { secret: ENTITLEMENT_SECRET });
}

function request(options: {
    body?: unknown;
    token?: string | null;
} = {}) {
    const token = options.token === undefined ? entitlementToken() : options.token;
    const headers = new Headers({ 'content-type': 'application/json' });
    if (token !== null) headers.set('x-analysis-test-entitlement', token);
    return new Request(
        `https://example.com/api/analysis/preflight/${PREFLIGHT_ID}/entitle`,
        {
            method: 'POST',
            headers,
            body: JSON.stringify(options.body ?? { planId: 'standard' }),
        }
    );
}

function context(preflightId = PREFLIGHT_ID) {
    return { params: Promise.resolve({ preflightId }) };
}

describe('analysis V2 test entitlement route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.ANALYSIS_TEST_ENTITLEMENT_SECRET = ENTITLEMENT_SECRET;
        process.env.ANALYSIS_TEST_ENTITLEMENTS_ENABLED = 'true';
        mocks.v2StartAvailable.mockReturnValue(true);
        mocks.dispatchJob.mockResolvedValue('enqueued');
        mocks.getTasksConfig.mockReturnValue({ configured: true });
        mocks.createServerClient.mockResolvedValue({
            auth: {
                getUser: vi.fn().mockResolvedValue({
                    data: { user: { id: USER_ID } },
                    error: null,
                }),
            },
        });
        mocks.rpc.mockResolvedValue({
            data: [{
                request_id: REQUEST_ID,
                created: true,
                initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                request_status: 'pending',
                background_processing: false,
            }],
            error: null,
        });
    });

    afterEach(() => {
        delete process.env.ANALYSIS_TEST_ENTITLEMENT_SECRET;
        delete process.env.ANALYSIS_TEST_ENTITLEMENTS_ENABLED;
        vi.restoreAllMocks();
    });

    it('authenticates, owner-filters the preflight, and atomically consumes a bound token', async () => {
        const query = installPreflightQuery();
        const token = entitlementToken();

        const response = await POST(request({ token }), context());

        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toEqual({
            schemaVersion: 1,
            requestId: REQUEST_ID,
            status: 'queued',
            backgroundProcessing: true,
        });
        expect(mocks.from).toHaveBeenCalledWith('analysis_preflights');
        expect(query.eq).toHaveBeenNthCalledWith(1, 'id', PREFLIGHT_ID);
        expect(query.eq).toHaveBeenNthCalledWith(2, 'user_id', USER_ID);
        expect(mocks.rpc).toHaveBeenCalledWith(
            'consume_analysis_v2_test_entitlement',
            expect.objectContaining({
                p_preflight_id: PREFLIGHT_ID,
                p_user_id: USER_ID,
                p_selected_plan_id: 'standard',
                p_entitlement_jti_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
            })
        );
        expect(mocks.getTasksConfig.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.rpc.mock.invocationCallOrder[0]);
        expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain(token);
        expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain('route_entitlement_nonce_01');
        expect(mocks.dispatchJob).toHaveBeenCalledOnce();
        expect(mocks.dispatchJob).toHaveBeenCalledWith(
            REQUEST_ID,
            ANALYSIS_V2_BOOTSTRAP_JOB_KEY
        );
    });

    it('rechecks the operational kill switch before reading or consuming a preflight', async () => {
        process.env.ANALYSIS_TEST_ENTITLEMENTS_ENABLED = 'false';
        const response = await POST(request(), context());

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'TEST_ENTITLEMENTS_DISABLED',
        });
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('reports an enabled but invalid signing configuration as unavailable', async () => {
        process.env.ANALYSIS_TEST_ENTITLEMENT_SECRET =
            'replace-with-a-canonical-base64url-32-byte-secret';
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await POST(request({ token: 'v1.invalid.invalid' }), context());

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'TEST_ENTITLEMENTS_UNAVAILABLE',
        });
        expect(errorSpy).toHaveBeenCalledWith(
            'Analysis V2 test entitlement configuration is invalid.'
        );
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('does not consume a token before the V2 background dispatcher ships', async () => {
        mocks.v2StartAvailable.mockReturnValue(false);

        const response = await POST(request(), context());

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            code: 'V2_PIPELINE_UNAVAILABLE',
        });
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.getTasksConfig).not.toHaveBeenCalled();
    });

    it('does not consume a token before the complete V2 queue config is valid', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        for (const unavailable of [null, new Error('invalid private config detail')]) {
            mocks.getTasksConfig.mockReset();
            if (unavailable instanceof Error) {
                mocks.getTasksConfig.mockImplementationOnce(() => { throw unavailable; });
            } else {
                mocks.getTasksConfig.mockReturnValueOnce(unavailable);
            }

            const response = await POST(request(), context());

            expect(response.status).toBe(503);
            await expect(response.json()).resolves.toMatchObject({
                code: 'QUEUE_UNAVAILABLE',
            });
        }
        expect(mocks.from).not.toHaveBeenCalled();
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
        expect(errorSpy).toHaveBeenCalledTimes(2);
    });

    it('redrives the same bootstrap job on an exact idempotent replay', async () => {
        installPreflightQuery({
            data: preflightRow({
                status: 'consumed',
                expires_at: new Date(Date.now() - 60_000).toISOString(),
                consumed_request_id: REQUEST_ID,
            }),
            error: null,
        });
        mocks.rpc.mockResolvedValue({
            data: [{
                request_id: REQUEST_ID,
                created: false,
                initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                request_status: 'processing',
                background_processing: true,
            }],
            error: null,
        });
        mocks.dispatchJob.mockResolvedValueOnce('already_dispatched');

        const response = await POST(request(), context());
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            requestId: REQUEST_ID,
            status: 'processing',
            backgroundProcessing: true,
        });
        expect(mocks.dispatchJob).toHaveBeenCalledWith(
            REQUEST_ID,
            ANALYSIS_V2_BOOTSTRAP_JOB_KEY
        );
    });

    it('returns a recoverable 503 when the initial queue handoff fails', async () => {
        installPreflightQuery();
        mocks.dispatchJob.mockRejectedValueOnce(new Error('internal queue detail'));
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const token = entitlementToken();

        const unavailable = await POST(request({ token }), context());

        expect(unavailable.status).toBe(503);
        await expect(unavailable.json()).resolves.toEqual({
            error: '분석 작업 큐를 사용할 수 없습니다.',
            code: 'QUEUE_UNAVAILABLE',
        });
        expect(errorSpy).toHaveBeenCalledWith('Analysis V2 initial job dispatch failed.');
        expect(mocks.rpc).toHaveBeenCalledOnce();

        mocks.rpc.mockResolvedValueOnce({
            data: [{
                request_id: REQUEST_ID,
                created: false,
                initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                request_status: 'pending',
                background_processing: false,
            }],
            error: null,
        });
        mocks.dispatchJob.mockResolvedValueOnce('exists');
        const replay = await POST(request({ token }), context());

        expect(replay.status).toBe(200);
        await expect(replay.json()).resolves.toMatchObject({
            requestId: REQUEST_ID,
            backgroundProcessing: true,
        });
        expect(mocks.dispatchJob).toHaveBeenCalledTimes(2);
        expect(mocks.dispatchJob.mock.calls[1]).toEqual(mocks.dispatchJob.mock.calls[0]);
        expect(mocks.rpc.mock.calls[1][1].p_entitlement_jti_hash)
            .toBe(mocks.rpc.mock.calls[0][1].p_entitlement_jti_hash);
    });

    it('reports terminal replay state without dispatching another task', async () => {
        installPreflightQuery({
            data: preflightRow({
                status: 'consumed',
                expires_at: new Date(Date.now() - 60_000).toISOString(),
                consumed_request_id: REQUEST_ID,
            }),
            error: null,
        });

        for (const requestStatus of ['completed', 'failed'] as const) {
            mocks.rpc.mockResolvedValueOnce({
                data: [{
                    request_id: REQUEST_ID,
                    created: false,
                    initial_job_key: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
                    request_status: requestStatus,
                    background_processing: false,
                }],
                error: null,
            });

            const response = await POST(request(), context());

            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({
                requestId: REQUEST_ID,
                status: requestStatus,
                backgroundProcessing: false,
            });
        }
        expect(mocks.dispatchJob).not.toHaveBeenCalled();
    });

    it('rejects unauthenticated, malformed, and cross-owner requests before the RPC', async () => {
        mocks.createServerClient.mockResolvedValueOnce({
            auth: {
                getUser: vi.fn().mockResolvedValue({
                    data: { user: null },
                    error: { message: 'invalid session' },
                }),
            },
        });
        expect((await POST(request(), context())).status).toBe(401);

        expect((await POST(request({
            body: { planId: 'standard', unexpected: true },
        }), context())).status).toBe(400);
        expect((await POST(request(), context('not-a-uuid'))).status).toBe(400);

        installPreflightQuery({ data: null, error: null });
        const missing = await POST(request(), context());
        expect(missing.status).toBe(404);
        await expect(missing.json()).resolves.toMatchObject({
            code: 'ANALYSIS_V2_PREFLIGHT_NOT_FOUND',
        });
        expect(mocks.rpc).not.toHaveBeenCalled();
    });

    it('requires the token to bind the authenticated user, preflight, and selected plan', async () => {
        installPreflightQuery();
        for (const token of [
            null,
            'v1.invalid.invalid',
            entitlementToken('plus'),
            createAnalysisTestEntitlement({
                preflightId: PREFLIGHT_ID,
                userId: '123e4567-e89b-42d3-b456-426614174099',
                planId: 'standard',
                nonce: 'different_user_nonce_01',
            }, { secret: ENTITLEMENT_SECRET }),
        ]) {
            const response = await POST(request({ token }), context());
            expect(response.status).toBe(403);
            await expect(response.json()).resolves.toMatchObject({
                code: 'INVALID_ENTITLEMENT',
            });
        }
        expect(mocks.rpc).not.toHaveBeenCalled();
        expect(mocks.getTasksConfig).not.toHaveBeenCalled();
    });

    it('rejects invalid preflight snapshots and maps a different-token replay to 409', async () => {
        installPreflightQuery({
            data: preflightRow({ exclusion_decision: null }),
            error: null,
        });
        const exclusion = await POST(request(), context());
        expect(exclusion.status).toBe(409);
        await expect(exclusion.json()).resolves.toMatchObject({
            code: 'ANALYSIS_V2_EXCLUSION_REQUIRED',
        });
        expect(mocks.rpc).not.toHaveBeenCalled();

        installPreflightQuery();
        mocks.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: 'P0001', message: 'ANALYSIS_V2_ENTITLEMENT_CONFLICT' },
        });
        const conflict = await POST(request(), context());
        expect(conflict.status).toBe(409);
        await expect(conflict.json()).resolves.toMatchObject({
            code: 'ANALYSIS_V2_ENTITLEMENT_CONFLICT',
        });
    });

    it('never logs the entitlement when an unexpected persistence error occurs', async () => {
        installPreflightQuery();
        mocks.rpc.mockResolvedValueOnce({
            data: null,
            error: { code: 'XX000', message: 'unexpected database failure' },
        });
        const token = entitlementToken();
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        const response = await POST(request({ token }), context());

        expect(response.status).toBe(500);
        expect(errorSpy).toHaveBeenCalledWith(
            'Analysis V2 test entitlement consumption failed.'
        );
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(token);
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('route_entitlement_nonce_01');
    });
});
