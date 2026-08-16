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
    isResultAuthoritativelyPublished: vi.fn(),
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
vi.mock('@/lib/services/analysis/result-publication-authority', () => ({
    isAnalysisResultAuthoritativelyPublished: mocks.isResultAuthoritativelyPublished,
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { GET as getLegacyStatus } from '@/app/api/analysis/status/[requestId]/route';
import { DELETE as deleteLegacyResult, GET as getLegacyResult } from '@/app/api/analysis/result/[requestId]/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';
import {
    ownerScorePercent,
    threatMeterFillCount,
} from '@/lib/services/analysis/owner-view-presentation';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';

function context() {
    return { params: Promise.resolve({ requestId }) };
}

function ownerQuery(row: Record<string, unknown>) {
    const query = {
        select: vi.fn(),
        eq: vi.fn(),
        maybeSingle: vi.fn(async (): Promise<{ data: Record<string, unknown> | null; error: unknown }> => ({
            data: row,
            error: null,
        })),
        single: vi.fn(async (): Promise<{ data: Record<string, unknown> | null; error: unknown }> => ({
            data: row,
            error: null,
        })),
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
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(true);
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

    it('projects a stale completed V1 request as pending in the owner status response', async () => {
        mocks.from.mockReturnValue(ownerQuery({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v1',
            status: 'completed',
            current_step: 'completed',
            progress: 100,
            progress_step: '완료',
            error_message: null,
            background_processing: false,
            created_at: '2026-08-14T00:00:00.000Z',
            completed_at: '2026-08-14T00:10:00.000Z',
            idempotency_key: 'concierge-batch-result:test',
        }));
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(false);

        const response = await getLegacyStatus(
            new Request(`https://example.com/api/analysis/status/${requestId}`),
            context(),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            status: 'pending',
            progress: 0,
            progressStep: '분석 대기 중...',
            errorMessage: null,
        });
        expect(mocks.expireStale).not.toHaveBeenCalled();
    });

    it('fails closed before legacy status reads for a retired owner', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await getLegacyStatus(
            new Request(`https://example.com/api/analysis/status/${requestId}`),
            context(),
        );

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.from).not.toHaveBeenCalled();
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

    it('fails closed before reading legacy result rows when paid publication is still pending', async () => {
        mocks.from.mockReturnValue(ownerQuery({
            id: requestId,
            user_id: userId,
            pipeline_version: 'v1',
            target_instagram_id: 'target',
            status: 'completed',
            progress: 100,
            mutual_follows: 10,
            gender_stats: { male: 5, female: 5, unknown: 0 },
            step_data: {},
        }));
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(false);

        const response = await getLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toMatchObject({
            code: 'RESULT_PENDING',
            status: 'pending',
            progress: 0,
        });
        expect(mocks.isResultAuthoritativelyPublished).toHaveBeenCalledWith(requestId);
        expect(mocks.from).toHaveBeenCalledTimes(1);
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

    it('lets the authenticated result operator read an unowned completed V1 concierge result payload', async () => {
        const ownerUserId = '323e4567-e89b-42d3-a456-426614174000';
        const requestRow = {
            id: requestId,
            user_id: ownerUserId,
            pipeline_version: 'v1',
            target_instagram_id: 'target',
            status: 'completed',
            progress: 100,
            mutual_follows: 150,
            gender_stats: { male: 100, female: 5, unknown: 43 },
            step_data: {
                mutualFollows: ['candidate_1'],
                conciergeEvidence: { hydration: { hydrated: 149, unresolved: 1 } },
            },
        };
        const resultRows = Array.from({ length: 5 }, (_, index) => ({
            rank: index + 1,
            suspect_instagram_id: `candidate_${index + 1}`,
            suspect_profile_image: null,
            suspect_full_name: `Candidate ${index + 1}`,
            bio: '',
            risk_score: [31, 43, 72, 67, 51][index],
            risk_grade: index === 0 ? 'normal' : index === 1 ? 'caution' : index === 2 ? 'high_risk' : 'caution',
            one_line_overview: `${['첫', '두', '세', '네', '다섯'][index] ?? '여섯'} 번째 공개 계정의 특징을 중심으로 정리한 계정입니다.`,
            risk_analysis: index === 2
                ? [
                    '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
                    '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
                ]
                : [],
        }));
        const requestQuery = ownerQuery(requestRow);
        requestQuery.eq.mockImplementation((column: string, value: unknown) => {
            if (column === 'user_id') {
                requestQuery.single.mockResolvedValue({
                    data: value === ownerUserId ? requestRow : null,
                    error: value === ownerUserId ? null : { code: 'PGRST116' },
                });
            }
            return requestQuery;
        });
        const listQuery = (rows: unknown[]) => {
            const query = {
                select: vi.fn(),
                eq: vi.fn(),
                order: vi.fn(),
                then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                    Promise.resolve({ data: rows, error: null }).then(resolve, reject),
            };
            query.select.mockReturnValue(query);
            query.eq.mockReturnValue(query);
            query.order.mockReturnValue(query);
            return query;
        };
        const resultsQuery = listQuery(resultRows);
        const privateAccountsQuery = listQuery([{
            instagram_id: 'private_candidate',
            full_name: 'Private Candidate',
            profile_image: null,
        }]);

        mocks.getUser.mockResolvedValue({
            data: { user: { id: userId, email: 'ym1113@kakao.com' } },
            error: null,
        });
        mocks.isResultOperator.mockReturnValue(true);
        mocks.resolveResultOwner.mockImplementation((_id: string, pipeline = 'v2') => (
            pipeline === 'v1' ? ownerUserId : null
        ));
        mocks.from.mockImplementation((table: string) => {
            if (table === 'analysis_requests') return requestQuery;
            if (table === 'analysis_results') return resultsQuery;
            if (table === 'private_accounts') return privateAccountsQuery;
            throw new Error(`unexpected table: ${table}`);
        });

        const response = await getLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(200);
        const payload = await response.json() as {
            femaleAccounts?: unknown[];
            summary?: { mutualFollows?: number; analyzedMutuals?: number };
        };
        expect(payload.femaleAccounts).toHaveLength(5);
        expect(payload.summary).toMatchObject({ mutualFollows: 150, analyzedMutuals: 149 });
        expect(payload.femaleAccounts).toEqual(expect.arrayContaining([
            expect.objectContaining({
                instagramId: 'candidate_1',
                oneLineOverview: '첫 번째 공개 계정의 특징을 중심으로 정리한 계정입니다.',
            }),
            expect.objectContaining({
                instagramId: 'candidate_2',
                oneLineOverview: '두 번째 공개 계정의 특징을 중심으로 정리한 계정입니다.',
                riskGrade: 'caution',
                displayScore: 4.3,
            }),
            expect.objectContaining({
                instagramId: 'candidate_3',
                oneLineOverview: '세 번째 공개 계정의 특징을 중심으로 정리한 계정입니다.',
                riskAnalysis: [
                    '프로필과 최근 피드에서 눈에 띌 재료를 꽤 성실하게 모아 둔 계정입니다.',
                    '댓글 흔적은 제법 친절하지만, 수집 표본 밖 활동은 누락될 수 있습니다.',
                ],
            }),
            expect.objectContaining({
                instagramId: 'candidate_4',
                riskGrade: 'caution',
                displayScore: 6.7,
            }),
        ]));
        expect(resultsQuery.select).toHaveBeenCalledWith(expect.stringContaining('risk_score'));
        const candidateTwo = payload.femaleAccounts?.find((account) => (
            (account as { instagramId?: string }).instagramId === 'candidate_2'
        )) as { displayScore: number; riskGrade: 'caution' };
        const candidateFour = payload.femaleAccounts?.find((account) => (
            (account as { instagramId?: string }).instagramId === 'candidate_4'
        )) as { displayScore: number; riskGrade: 'caution' };
        expect([
            ownerScorePercent(candidateTwo.displayScore),
            ownerScorePercent(candidateFour.displayScore),
        ]).toEqual([43, 67]);
        expect([
            threatMeterFillCount({ grade: candidateTwo.riskGrade, displayScore: candidateTwo.displayScore, segments: 10 }),
            threatMeterFillCount({ grade: candidateFour.riskGrade, displayScore: candidateFour.displayScore, segments: 10 }),
        ]).toEqual([4, 7]);
        expect(mocks.resolveResultOwner).toHaveBeenCalledWith(requestId, 'v1');
        expect(requestQuery.eq).toHaveBeenCalledWith('user_id', ownerUserId);
    });

    it('returns finite zero gender counts for malformed legacy stats', async () => {
        const ownerUserId = '323e4567-e89b-42d3-a456-426614174000';
        const requestRow = {
            id: requestId,
            user_id: ownerUserId,
            pipeline_version: 'v1',
            target_instagram_id: 'target',
            status: 'completed',
            progress: 100,
            mutual_follows: 0,
            gender_stats: {},
            step_data: {},
        };
        const requestQuery = ownerQuery(requestRow);
        const listQuery = (rows: unknown[]) => {
            const query = {
                select: vi.fn(),
                eq: vi.fn(),
                order: vi.fn(),
                then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                    Promise.resolve({ data: rows, error: null }).then(resolve, reject),
            };
            query.select.mockReturnValue(query);
            query.eq.mockReturnValue(query);
            query.order.mockReturnValue(query);
            return query;
        };
        mocks.getUser.mockResolvedValue({
            data: { user: { id: userId, email: 'ym1113@kakao.com' } },
            error: null,
        });
        mocks.isResultOperator.mockReturnValue(true);
        mocks.resolveResultOwner.mockImplementation((_id: string, pipeline = 'v2') => (
            pipeline === 'v1' ? ownerUserId : null
        ));
        mocks.from.mockImplementation((table: string) => {
            if (table === 'analysis_requests') return requestQuery;
            if (table === 'analysis_results' || table === 'private_accounts') return listQuery([]);
            throw new Error(`unexpected table: ${table}`);
        });

        const response = await getLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
            summary: {
                mutualFollows: 0,
                analyzedMutuals: 0,
                genderRatio: {
                    male: { count: 0, percentage: 0 },
                    female: { count: 0, percentage: 0 },
                    unknown: { count: 0, percentage: 0 },
                },
            },
        });
    });

    it('keeps an unowned completed V1 result hidden from a non-operator', async () => {
        const ownerUserId = '323e4567-e89b-42d3-a456-426614174000';
        const requestQuery = ownerQuery({
            id: requestId,
            user_id: ownerUserId,
            pipeline_version: 'v1',
            target_instagram_id: 'target',
            status: 'completed',
            progress: 100,
            mutual_follows: 5,
            gender_stats: { male: 0, female: 5, unknown: 0 },
            step_data: {},
        });
        requestQuery.eq.mockImplementation((column: string, value: unknown) => {
            if (column === 'user_id') {
                requestQuery.single.mockResolvedValue({
                    data: value === ownerUserId ? {} : null,
                    error: value === ownerUserId ? null : { code: 'PGRST116' },
                });
            }
            return requestQuery;
        });
        mocks.from.mockReturnValue(requestQuery);

        const response = await getLegacyResult(
            new Request(`https://example.com/api/analysis/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(404);
        expect(mocks.isResultOperator).toHaveBeenCalledWith({ id: userId, email: undefined });
        expect(mocks.resolveResultOwner).not.toHaveBeenCalled();
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
