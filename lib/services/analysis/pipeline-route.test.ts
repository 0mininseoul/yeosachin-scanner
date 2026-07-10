import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    acquireLease: vi.fn(),
    abortRuns: vi.fn(),
    createServerClient: vi.fn(),
    enqueueTask: vi.fn(),
    from: vi.fn(),
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

import { POST } from '@/app/api/analysis/step/route';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = 'user-123';

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
        mocks.acquireLease.mockResolvedValue({ requestId, token: 'lease-token' });
        mocks.abortRuns.mockResolvedValue(0);
        mocks.releaseLease.mockResolvedValue(undefined);
        mocks.rpc.mockResolvedValue({ data: 1, error: null });
        mocks.enqueueTask.mockResolvedValue('exists');
        mocks.createServerClient.mockResolvedValue({
            auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: userId } } }) },
        });
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
        expect(admin.update).not.toHaveBeenCalled();
        expect(mocks.enqueueTask).not.toHaveBeenCalled();
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
});
