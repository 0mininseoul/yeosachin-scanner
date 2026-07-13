import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    acquireLease: vi.fn(),
    analyzeCombined: vi.fn(),
    after: vi.fn(),
    afterCallbacks: [] as Array<() => void | Promise<void>>,
    abortRuns: vi.fn(),
    createServerClient: vi.fn(),
    enqueueTask: vi.fn(),
    from: vi.fn(),
    recordStepEvent: vi.fn(),
    reconcileProviderCosts: vi.fn(),
    releaseLease: vi.fn(),
    rpc: vi.fn(),
    verifyTask: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from, rpc: mocks.rpc },
}));
vi.mock('@/lib/supabase/server', () => ({
    createClient: mocks.createServerClient,
}));
vi.mock('@/lib/services/analysis/request-lease', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/lib/services/analysis/request-lease')
    >();
    return {
        ...actual,
        acquireAnalysisRequestLease: mocks.acquireLease,
        releaseAnalysisRequestLease: mocks.releaseLease,
    };
});
vi.mock('@/lib/services/analysis/background-tasks', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/lib/services/analysis/background-tasks')
    >();
    return {
        ...actual,
        enqueueAnalysisTask: mocks.enqueueTask,
        verifyAnalysisTaskAuthorization: mocks.verifyTask,
    };
});
vi.mock('@/lib/services/analysis/provider-run', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/lib/services/analysis/provider-run')
    >();
    return {
        ...actual,
        abortRunningAnalysisProviderRuns: mocks.abortRuns,
    };
});
vi.mock('@/lib/services/analysis/observability', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/lib/services/analysis/observability')
    >();
    return {
        ...actual,
        recordAnalysisStepEvent: mocks.recordStepEvent,
    };
});
vi.mock('@/lib/services/analysis/provider-cost-reconciliation', () => ({
    reconcileSettledAnalysisProviderCosts: mocks.reconcileProviderCosts,
}));
vi.mock('@/lib/services/ai/combined-analysis', async (importOriginal) => {
    const actual = await importOriginal<
        typeof import('@/lib/services/ai/combined-analysis')
    >();
    return {
        ...actual,
        analyzeCombined: mocks.analyzeCombined,
    };
});
vi.mock('next/server', async (importOriginal) => {
    const actual = await importOriginal<typeof import('next/server')>();
    return { ...actual, after: mocks.after };
});

import {
    POST,
    scheduleBrowserFallbackCostReconciliation,
} from '@/app/api/analysis/step/route';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';

interface FluentAdminMock {
    builder: Record<string, ReturnType<typeof vi.fn>>;
    single: ReturnType<typeof vi.fn>;
    maybeSingle: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
}

function installFluentAdminMock(): FluentAdminMock {
    const single = vi.fn();
    const maybeSingle = vi.fn();
    const update = vi.fn();
    const builder: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['select', 'eq', 'in']) {
        builder[method] = vi.fn(() => builder);
    }
    builder.single = single;
    builder.maybeSingle = maybeSingle;
    builder.update = update.mockImplementation(() => builder);
    mocks.from.mockImplementation(() => builder);
    return { builder, single, maybeSingle, update };
}

function analysisRow(overrides: Record<string, unknown> = {}) {
    return {
        id: requestId,
        user_id: userId,
        status: 'processing',
        current_step: 'pending',
        step_data: {},
        target_instagram_id: 'public_target',
        plan_type: 'basic',
        idempotency_key: 'analysis-key-0000000000000000',
        users: { email: null },
        ...overrides,
    };
}

function postRequest(headers?: Record<string, string>) {
    return new Request('https://example.com/api/analysis/step', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ requestId }),
    });
}

describe('analysis step route orchestration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.afterCallbacks.length = 0;
        mocks.after.mockImplementation((callback: () => void | Promise<void>) => {
            mocks.afterCallbacks.push(callback);
        });
        mocks.acquireLease.mockResolvedValue({ requestId, token: 'lease-token' });
        mocks.abortRuns.mockResolvedValue(0);
        mocks.releaseLease.mockResolvedValue(undefined);
        mocks.recordStepEvent.mockResolvedValue(true);
        mocks.reconcileProviderCosts.mockResolvedValue({
            eligible: 0,
            finalized: 0,
            failed: 0,
            hasMore: false,
        });
        mocks.rpc.mockResolvedValue({ data: 1, error: null });
        mocks.enqueueTask.mockResolvedValue('exists');
        mocks.createServerClient.mockResolvedValue({
            auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } } }) },
        });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('dispatches using the fresh row read after acquiring the lease', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(false);
        admin.single
            .mockResolvedValueOnce({ data: analysisRow(), error: null })
            .mockResolvedValueOnce({
                data: analysisRow({
                    current_step: 'profiles',
                    step_data: { publicAccounts: [] },
                }),
                error: null,
            });
        admin.maybeSingle.mockResolvedValue({ data: { id: requestId }, error: null });

        const response = await POST(postRequest());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            step: 'finalize',
        });
        expect(admin.update).toHaveBeenCalledWith(expect.objectContaining({
            current_step: 'finalize',
        }));
        expect(admin.update).not.toHaveBeenCalledWith(expect.objectContaining({
            current_step: 'collect',
        }));
        expect(mocks.recordStepEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ step: 'profiles', eventType: 'started' })
        );
        expect(mocks.recordStepEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ step: 'profiles', eventType: 'completed' })
        );
    });

    it('never executes a persisted V2 request through the paid V1 state machine', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(false);
        admin.single.mockResolvedValueOnce({
            data: analysisRow({ pipeline_version: 'v2' }),
            error: null,
        });

        const response = await POST(postRequest());

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
            code: 'V2_PIPELINE_REQUIRED',
        });
        expect(mocks.acquireLease).not.toHaveBeenCalled();
        expect(mocks.enqueueTask).not.toHaveBeenCalled();
    });

    it('returns 503 without terminalizing a verified task transient failure', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(true);
        admin.single
            .mockResolvedValueOnce({ data: analysisRow(), error: null })
            .mockResolvedValueOnce({ data: null, error: { code: 'temporary' } });
        admin.maybeSingle.mockResolvedValueOnce({
            data: {
                status: 'processing',
                current_step: 'pending',
                progress: 0,
                step_data: {},
                background_processing: true,
            },
            error: null,
        });

        const response = await POST(postRequest({
            'X-CloudTasks-TaskRetryCount': '0',
        }));

        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
            retrying: true,
            step: 'pending',
        });
        expect(admin.update).not.toHaveBeenCalled();
        expect(mocks.rpc).toHaveBeenCalledWith(
            'increment_analysis_semantic_retry',
            expect.objectContaining({
                p_request_id: requestId,
                p_state_key: 'v1:pending',
            })
        );
        expect(mocks.releaseLease).toHaveBeenCalledOnce();
        expect(mocks.enqueueTask).not.toHaveBeenCalled();
        expect(mocks.recordStepEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ step: 'pending', eventType: 'retrying' })
        );
    });

    it('does not execute a paid step after the verified delivery safety ceiling', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(true);
        mocks.rpc.mockResolvedValue({ data: true, error: null });
        admin.single
            .mockResolvedValueOnce({ data: analysisRow(), error: null })
            .mockResolvedValueOnce({
                data: analysisRow({ current_step: 'interactions' }),
                error: null,
            });
        admin.maybeSingle
            .mockResolvedValueOnce({
                data: {
                    status: 'failed',
                    current_step: 'failed',
                    progress: 100,
                    step_data: {},
                    background_processing: true,
                },
                error: null,
            })
            .mockResolvedValueOnce({ data: { id: requestId }, error: null });

        const response = await POST(postRequest({
            'X-CloudTasks-TaskRetryCount': '6',
        }));

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            step: 'failed',
            status: 'failed',
            done: true,
        });
        expect(mocks.rpc).toHaveBeenCalledWith(
            'fail_analysis_request_and_purge_staging',
            expect.objectContaining({ p_request_id: requestId })
        );
        expect(mocks.abortRuns).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                requestId,
                userId,
            })
        );
        expect(admin.update).toHaveBeenCalledWith({ background_processing: false });
        expect(mocks.enqueueTask).toHaveBeenCalledWith(
            requestId,
            expect.objectContaining({ currentStep: 'failed' }),
            { delaySeconds: 35 }
        );
        expect(mocks.recordStepEvent).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                step: 'interactions',
                eventType: 'aborted',
                failureCategory: 'retry_exhausted',
            })
        );
    });

    it('enqueues a continuation only after a verified task commits a successful step', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(true);
        admin.single
            .mockResolvedValueOnce({ data: analysisRow(), error: null })
            .mockResolvedValueOnce({ data: analysisRow(), error: null });
        admin.maybeSingle
            .mockResolvedValueOnce({ data: { id: requestId }, error: null })
            .mockResolvedValueOnce({
                data: {
                    status: 'processing',
                    current_step: 'collect',
                    progress: 5,
                    step_data: {},
                    background_processing: true,
                },
                error: null,
            });

        const response = await POST(postRequest({
            'X-CloudTasks-TaskRetryCount': '0',
        }));

        expect(response.status).toBe(200);
        expect(mocks.enqueueTask).toHaveBeenCalledOnce();
    });

    it('checkpoints a charged strict Gemini rejection as unknown without regenerating it', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(false);
        mocks.rpc.mockResolvedValue({ data: true, error: null });
        mocks.analyzeCombined.mockRejectedValueOnce(new Error(
            'AI_GENERATION_RESPONSE_REJECTED_ERROR: finishReason MAX_TOKENS'
        ));

        const account = {
            profile: {
                username: 'candidate',
                isPrivate: false,
            },
            recentPosts: [],
        };
        const initialState = analysisRow({
            current_step: 'analyze',
            progress: 50,
            step_data: {
                accountsWithPosts: [account],
                analyzeBatchIndex: 0,
                combinedResults: {},
            },
        });
        const checkpointedState = analysisRow({
            current_step: 'analyze',
            progress: 82,
            step_data: {
                accountsWithPosts: [account],
                analyzeBatchIndex: 1,
                combinedResults: {
                    candidate: {
                        gender: 'unknown',
                        genderConfidence: 0,
                    },
                },
            },
        });
        admin.single
            .mockResolvedValueOnce({ data: initialState, error: null })
            .mockResolvedValueOnce({ data: initialState, error: null })
            .mockResolvedValueOnce({ data: checkpointedState, error: null })
            .mockResolvedValueOnce({ data: checkpointedState, error: null });
        admin.maybeSingle.mockResolvedValue({
            data: { id: requestId },
            error: null,
        });

        const firstResponse = await POST(postRequest());
        const firstBody = await firstResponse.json();
        expect(firstResponse.status).toBe(200);
        expect(firstBody).toMatchObject({
            success: true,
            step: 'analyze',
            done: false,
        });
        expect(admin.update).toHaveBeenCalledWith(expect.objectContaining({
            current_step: 'analyze',
            step_data: expect.objectContaining({
                analyzeBatchIndex: 1,
                combinedResults: {
                    candidate: {
                        gender: 'unknown',
                        genderConfidence: 0,
                    },
                },
            }),
        }));

        const resumedResponse = await POST(postRequest());
        expect(resumedResponse.status).toBe(200);
        await expect(resumedResponse.json()).resolves.toMatchObject({
            success: true,
            step: 'interactions',
            done: false,
        });
        expect(mocks.analyzeCombined).toHaveBeenCalledTimes(1);
        expect(mocks.abortRuns).not.toHaveBeenCalled();
    });

    it('acknowledges a duplicate verified task that cannot acquire the lease', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(true);
        mocks.acquireLease.mockResolvedValueOnce(null);
        admin.single.mockResolvedValueOnce({ data: analysisRow(), error: null });

        const response = await POST(postRequest());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            success: true,
            skipped: true,
        });
        expect(mocks.enqueueTask).not.toHaveBeenCalled();
        expect(mocks.releaseLease).not.toHaveBeenCalled();
    });

    it('retries a terminal background task while its request costs remain unsettled', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(true);
        admin.single.mockResolvedValueOnce({
            data: analysisRow({ status: 'completed', current_step: 'completed' }),
            error: null,
        });
        mocks.reconcileProviderCosts
            .mockResolvedValueOnce({ eligible: 1, finalized: 0, failed: 1, hasMore: false })
            .mockResolvedValueOnce({ eligible: 1, finalized: 0, failed: 1, hasMore: false });

        const response = await POST(postRequest());

        expect(response.status).toBe(503);
        expect(mocks.reconcileProviderCosts).toHaveBeenNthCalledWith(
            1,
            expect.anything(),
            requestId
        );
        expect(mocks.reconcileProviderCosts).toHaveBeenNthCalledWith(
            2,
            expect.anything()
        );
        expect(mocks.acquireLease).not.toHaveBeenCalled();
    });

    it('runs a global reconciliation for a deleted request background task', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(true);
        admin.single.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116' } });

        const response = await POST(postRequest());

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ success: true, done: true });
        expect(mocks.reconcileProviderCosts).toHaveBeenCalledOnce();
        expect(mocks.reconcileProviderCosts).toHaveBeenCalledWith(expect.anything());
        expect(mocks.acquireLease).not.toHaveBeenCalled();
    });

    it('retries a background task when the request read fails transiently', async () => {
        const admin = installFluentAdminMock();
        mocks.verifyTask.mockResolvedValue(true);
        admin.single.mockResolvedValueOnce({ data: null, error: { code: '08006' } });

        const response = await POST(postRequest());

        expect(response.status).toBe(500);
        expect(mocks.reconcileProviderCosts).not.toHaveBeenCalled();
        expect(mocks.acquireLease).not.toHaveBeenCalled();
    });

    it('reconciles browser fallback costs after 35 seconds and stops on success', async () => {
        vi.useFakeTimers();
        mocks.reconcileProviderCosts
            .mockResolvedValueOnce({ eligible: 1, finalized: 0, failed: 1, hasMore: false })
            .mockResolvedValueOnce({ eligible: 1, finalized: 1, failed: 0, hasMore: false });

        scheduleBrowserFallbackCostReconciliation(requestId);

        expect(mocks.after).toHaveBeenCalledOnce();
        const pending = Promise.resolve(mocks.afterCallbacks[0]());
        await vi.advanceTimersByTimeAsync(35_000);
        expect(mocks.reconcileProviderCosts).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30_000);
        await pending;
        expect(mocks.reconcileProviderCosts).toHaveBeenCalledTimes(2);
        expect(mocks.reconcileProviderCosts).toHaveBeenLastCalledWith(
            expect.anything(),
            requestId
        );
    });

    it('caps browser fallback cost reconciliation at three attempts', async () => {
        vi.useFakeTimers();
        mocks.reconcileProviderCosts.mockResolvedValue({
            eligible: 1,
            finalized: 0,
            failed: 1,
            hasMore: false,
        });

        scheduleBrowserFallbackCostReconciliation(requestId);

        const pending = Promise.resolve(mocks.afterCallbacks[0]());
        await vi.advanceTimersByTimeAsync(95_000);
        await pending;
        expect(mocks.reconcileProviderCosts).toHaveBeenCalledTimes(3);
    });
});
