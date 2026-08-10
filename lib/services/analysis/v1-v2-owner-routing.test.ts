import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    from: vi.fn(),
    expireStale: vi.fn(),
    demoFindForOwner: vi.fn(),
    demoDeleteForOwner: vi.fn(),
    isResultOperator: vi.fn(),
    resolveResultOwner: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/supabase/admin', () => ({
    supabaseAdmin: { from: mocks.from },
}));
vi.mock('@/lib/services/analysis/start-cleanup', () => ({
    expireStaleAnalysisBeforeStart: mocks.expireStale,
}));
vi.mock('@/lib/services/analysis/failure', () => ({
    failAnalysisRequest: vi.fn(),
    isAnalysisRequestStale: vi.fn(() => true),
}));
vi.mock('@/lib/services/analysis/provider-run', () => ({
    abortRunningAnalysisProviderRuns: vi.fn(),
}));
vi.mock('@/lib/services/analysis/request-lease', () => ({
    ANALYSIS_STEP_LEASE_SECONDS: 60,
    acquireAnalysisRequestLease: vi.fn(),
    releaseAnalysisRequestLease: vi.fn(),
}));
vi.mock('@/lib/services/demo-analysis/store', () => ({
    demoAnalysisStore: {
        findForOwner: mocks.demoFindForOwner,
        deleteForOwner: mocks.demoDeleteForOwner,
    },
}));
vi.mock('@/lib/services/analysis/result-operator-access', () => ({
    isAnalysisResultOperator: mocks.isResultOperator,
    resolveAnalysisResultOwner: mocks.resolveResultOwner,
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { GET as getLegacyStatus } from '@/app/api/analysis/status/[requestId]/route';
import { DELETE as deleteLegacyResult, GET as getLegacyResult } from '@/app/api/analysis/result/[requestId]/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';

function context() {
    return { params: Promise.resolve({ requestId }) };
}

function ownerQuery(row: Record<string, unknown>) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(async () => ({ data: row, error: null })),
        single: vi.fn(async () => ({ data: row, error: null })),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    return query;
}

describe('owner-facing V1/V2 route selection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({
            data: { user: { id: userId } },
            error: null,
        });
        mocks.demoFindForOwner.mockResolvedValue(null);
        mocks.isResultOperator.mockReturnValue(false);
        mocks.resolveResultOwner.mockResolvedValue(null);
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
    });

    it('routes an owned V2 request from legacy status to the durable progress endpoint', async () => {
        mocks.from.mockReturnValue(ownerQuery({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v2',
            status: 'processing',
            current_step: 'profile_screening',
            progress: 0,
            progress_step: 'V2 analysis queued',
            error_message: null,
            background_processing: true,
            created_at: '2026-07-14T00:00:00.000Z',
            completed_at: null,
            idempotency_key: 'test-key',
        }));

        const response = await getLegacyStatus(
            new Request(`https://example.com/api/analysis/status/${requestId}`),
            context()
        );

        expect(response.status).toBe(409);
        expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
        await expect(response.json()).resolves.toEqual({
            error: 'V2 분석은 전용 진행 경로를 사용합니다.',
            code: 'V2_ROUTE_REQUIRED',
            pipelineVersion: 'v2',
            progressUrl: `/api/analysis/progress/${requestId}`,
        });
        expect(mocks.expireStale).not.toHaveBeenCalled();
    });

    it('fails closed before legacy result reads or deletion for a retired owner', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const read = await getLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`),
            context(),
        );
        const deleted = await deleteLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`, {
                method: 'DELETE',
            }),
            context(),
        );

        expect(read.status).toBe(403);
        await expect(read.json()).resolves.toEqual({
            error: '이 계정은 현재 사용할 수 없습니다.',
        });
        expect(deleted.status).toBe(403);
        await expect(deleted.json()).resolves.toEqual({
            error: '이 계정은 현재 사용할 수 없습니다.',
        });
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledTimes(2);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('routes an owned V2 request before touching any legacy result table', async () => {
        mocks.from.mockReturnValue(ownerQuery({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v2',
            target_instagram_id: 'target',
            status: 'completed',
            progress: 100,
            mutual_follows: 10,
            gender_stats: null,
            step_data: null,
        }));

        const response = await getLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`),
            context()
        );

        expect(response.status).toBe(409);
        expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
        await expect(response.json()).resolves.toEqual({
            error: 'V2 분석은 전용 결과 경로를 사용합니다.',
            code: 'V2_ROUTE_REQUIRED',
            pipelineVersion: 'v2',
            resultUrl: `/api/analysis/v2/result/${requestId}`,
        });
        expect(mocks.from).toHaveBeenCalledOnce();
        expect(mocks.from).toHaveBeenCalledWith('analysis_requests');
    });

    it('routes the authenticated result operator to an unowned completed V2 result', async () => {
        const ownerUserId = '323e4567-e89b-42d3-a456-426614174000';
        mocks.getUser.mockResolvedValue({
            data: { user: { id: userId, email: 'ym1113@kakao.com' } },
            error: null,
        });
        mocks.isResultOperator.mockReturnValue(true);
        mocks.resolveResultOwner.mockResolvedValue(ownerUserId);

        const response = await getLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({
            code: 'V2_ROUTE_REQUIRED',
            pipelineVersion: 'v2',
            resultUrl: `/api/analysis/v2/result/${requestId}`,
        });
        expect(mocks.isResultOperator).toHaveBeenCalledWith({
            id: userId,
            email: 'ym1113@kakao.com',
        });
        expect(mocks.resolveResultOwner).toHaveBeenCalledWith(requestId);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('routes an owner demo through the V2 result requirement without querying legacy tables', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({ id: requestId, user_id: userId });

        const response = await getLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`), context()
        );

        expect(response.status).toBe(409);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        await expect(response.json()).resolves.toMatchObject({ code: 'V2_ROUTE_REQUIRED', pipelineVersion: 'v2' });
        expect(mocks.from).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('deletes an owner demo from the demo store only and hides a mismatched owner', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValueOnce({ id: requestId, user_id: userId });
        mocks.demoDeleteForOwner.mockResolvedValueOnce(true);

        const deleted = await deleteLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`, { method: 'DELETE' }), context()
        );
        expect(deleted.status).toBe(204);
        expect(deleted.headers.get('x-analytics-eligible')).toBe('0');
        expect(deleted.headers.get('cache-control')).toContain('no-store');
        expect(mocks.demoDeleteForOwner).toHaveBeenCalledWith(requestId, userId);
        expect(mocks.from).not.toHaveBeenCalled();

        mocks.demoFindForOwner.mockResolvedValueOnce({ id: requestId, user_id: '323e4567-e89b-42d3-a456-426614174000' });
        const hidden = await deleteLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`, { method: 'DELETE' }), context()
        );
        expect(hidden.status).toBe(404);
        expect(hidden.headers.get('x-analytics-eligible')).toBe('0');
        expect(hidden.headers.get('cache-control')).toContain('no-store');
        expect(mocks.demoDeleteForOwner).toHaveBeenCalledOnce();
        expect(mocks.from).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });
});
