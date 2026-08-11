import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    encodeResultCursor,
    type ResultListKind,
} from '@/lib/domain/analysis/result-pagination';
import { createDemoFixture } from '@/lib/services/demo-analysis/demo-analysis';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    loadPage: vi.fn(),
    operationalEmit: vi.fn(),
    observeRoute: vi.fn(),
    demoFindForOwner: vi.fn(),
    loadFixture: vi.fn(),
    isResultOperator: vi.fn(),
    resolveResultOwner: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/v2-result-store', () => ({
    analysisV2ResultStore: { loadPage: mocks.loadPage },
}));
vi.mock('@/lib/services/demo-analysis/store', () => ({
    demoAnalysisStore: { findForOwner: mocks.demoFindForOwner },
}));
vi.mock('@/lib/observability/request', () => ({
    observeRoute: mocks.observeRoute,
}));
vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: mocks.operationalEmit },
}));
vi.mock('@/lib/services/demo-analysis/fixture-store', () => ({
    loadDemoFixtureForVersion: mocks.loadFixture,
}));
vi.mock('@/lib/services/analysis/result-operator-access', () => ({
    isAnalysisResultOperator: mocks.isResultOperator,
    resolveAnalysisResultOwner: mocks.resolveResultOwner,
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { GET } from '@/app/api/analysis/v2/result/[requestId]/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';

function context(id = requestId) {
    return { params: Promise.resolve({ requestId: id }) };
}

function loadedFixture(version: string) {
    return {
        version,
        target: {
            username: 'junho_dem',
            fullName: version === 'synthetic-fixture-v1' ? '준호의 공개 프로필' : '모의 분석용 공개 계정',
            bio: version === 'synthetic-fixture-v1' ? '사진과 일상을 기록하는 공개 프로필입니다.' : '산책과 사진을 기록하는 데모 프로필입니다.',
            profileImage: version === 'synthetic-fixture-v1' ? '/demo-avatars/synthetic-blurred-avatar-1-v1.png' : '/demo-avatars/demo-v3-target-000.webp',
            followersCount: 600, followingCount: 580, isPrivate: false as const,
        },
        fixture: { ...createDemoFixture('route-fixture', version as never), version },
    };
}

function cursor(list: ResultListKind) {
    return encodeResultCursor({
        version: 1,
        list,
        direction: 'asc',
        sortKeyType: 'number',
        sortKey: 24,
        candidateId: 'candidate-24',
    });
}

function page() {
    return {
        schemaVersion: 1 as const,
        requestId,
        summary: {
            targetInstagramId: 'target.user',
            targetProfileImage: null,
            planId: 'basic' as const,
            followers: {
                declared: 300,
                collected: 300,
                coverageRatio: 1,
                meetsCoverageGate: true,
                exactCountMatch: true,
            },
            following: {
                declared: 300,
                collected: 300,
                coverageRatio: 1,
                meetsCoverageGate: true,
                exactCountMatch: true,
            },
            detectedMutuals: 100,
            publicMutuals: 80,
            privateMutuals: 20,
            screenedMutuals: 80,
            genderStats: { male: 40, female: 30, unknown: 10 },
            successfullyScreenedMutuals: 78,
            fetchUnavailableMutuals: 1,
            mediaUnavailableMutuals: 1,
            notScreenedMutuals: 0,
            exclusionApplied: true,
            scorePolicyVersion: 'risk-policy-v2.2' as const,
        },
        femaleAccounts: [],
        privateAccounts: [],
        femaleNextCursor: null,
        privateNextCursor: null,
    };
}

describe('analysis V2 owner result route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.loadPage.mockResolvedValue(page());
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
        mocks.observeRoute.mockImplementation(async (
            _request: Request,
            _route: string,
            operation: (context: {
                request_id: string;
                trace_id: null;
                route: string;
                method: string;
            }) => Promise<Response>,
        ) => operation({
            request_id: '323e4567-e89b-42d3-a456-426614174000',
            trace_id: null,
            route: '/api/analysis/v2/result/[requestId]',
            method: 'GET',
        }));
        mocks.loadFixture.mockImplementation(async (version: string) => loadedFixture(version));
    });

    it('validates route identifiers safely and keeps malformed production pagination generic', async () => {
        const malformedId = await GET(
            new Request('https://example.com/api/analysis/v2/result/nope'),
            context('nope')
        );
        const wrongCursor = await GET(
            new Request(
                `https://example.com/api/analysis/v2/result/${requestId}?femaleCursor=${cursor('private')}`
            ),
            context()
        );
        const excessivePage = await GET(
            new Request(
                `https://example.com/api/analysis/v2/result/${requestId}?pageSize=51`
            ),
            context()
        );

        expect([malformedId.status, wrongCursor.status, excessivePage.status])
            .toEqual([400, 400, 400]);
        expect(malformedId.headers.get('x-analytics-eligible')).toBeNull();
        expect(wrongCursor.headers.get('x-analytics-eligible')).toBeNull();
        expect(excessivePage.headers.get('x-analytics-eligible')).toBeNull();
        expect(mocks.getUser).toHaveBeenCalledTimes(2);
        expect(mocks.demoFindForOwner).toHaveBeenCalledTimes(2);
        expect(mocks.loadPage).not.toHaveBeenCalled();
    });

    it('requires authentication before reading malformed pagination for a valid route id', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
        const response = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}?pageSize=51`),
            context()
        );
        expect(response.status).toBe(401);
        expect(response.headers.get('x-analytics-eligible')).toBeNull();
        expect(mocks.demoFindForOwner).not.toHaveBeenCalled();
        expect(mocks.loadPage).not.toHaveBeenCalled();
    });

    it('fails closed before demo or result access when the owner account is retired', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
            error: 'Account unavailable.',
        });
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.demoFindForOwner).not.toHaveBeenCalled();
        expect(mocks.loadPage).not.toHaveBeenCalled();
    });

    it('denies a demo result before completion without consulting the production result store', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-result-key-00000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date().toISOString(),
        });
        const response = await GET(new Request(`https://example.com/api/analysis/v2/result/${requestId}`), context());
        expect(response.status).toBe(404);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.loadPage).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it.each([
        `femaleCursor=${cursor('private')}`,
        `privateCursor=${cursor('public')}`,
        'pageSize=51',
    ])('keeps malformed demo result pagination private: %s', async query => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-result-key-00000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date().toISOString(),
        });

        const response = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}?${query}`),
            context()
        );

        expect(response.status).toBe(400);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.demoFindForOwner).toHaveBeenCalledWith(requestId, userId);
        expect(mocks.loadPage).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('returns a completed demo page with capability headers and local images only', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-result-key-00000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date(Date.now() - 80_000).toISOString(),
        });
        const response = await GET(new Request(`https://example.com/api/analysis/v2/result/${requestId}?pageSize=1`), context());
        expect(response.status).toBe(200);
        expect(response.headers.get('x-external-profile-links')).toBe('disabled');
        await expect(response.json()).resolves.toMatchObject({ femaleAccounts: [{ profileImage: '/demo-avatars/synthetic-blurred-avatar-1-v1.png' }] });
        expect(mocks.loadPage).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('renders the exact non-static database fixture payload without production result reads', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        const fixtureVersion = 'operator-editable-fixture-route-v1';
        const fixture = createDemoFixture('database-route-fixture');
        fixture.summary.targetFullName = 'DB Fixture Target';
        mocks.loadFixture.mockResolvedValue({
            version: fixtureVersion,
            target: { username: 'junho_dem', fullName: 'DB Fixture Target', bio: 'fixture bio', profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false },
            fixture: { ...fixture, version: fixtureVersion },
        });
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: fixtureVersion,
            idempotency_key: 'demo-result-key-db-fixture', duration_seconds: 38,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date(Date.now() - 80_000).toISOString(),
        });

        const response = await GET(new Request(`https://example.com/api/analysis/v2/result/${requestId}?pageSize=1`), context());
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({ summary: { targetFullName: 'DB Fixture Target' } });
        expect(mocks.loadFixture).toHaveBeenCalledWith(fixtureVersion);
        expect(mocks.loadPage).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('returns demo-unavailable without production result reads when a DB fixture cannot load', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.loadFixture.mockResolvedValue(null);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'operator-editable-fixture-route-v1',
            idempotency_key: 'demo-result-key-no-fixture', duration_seconds: 38,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date(Date.now() - 80_000).toISOString(),
        });
        const response = await GET(new Request(`https://example.com/api/analysis/v2/result/${requestId}`), context());
        expect(response.status).toBe(503);
        expect(mocks.loadPage).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('dispatches a legacy run to the legacy fixture instead of rendering the v2 fixture', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        const startedAt = new Date(Date.now() - 80_000).toISOString();
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-result-key-00000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', started_at: startedAt,
        });
        const legacy = await GET(new Request(`https://example.com/api/analysis/v2/result/${requestId}?pageSize=1`), context());
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'authorized-text-fixture-v2',
            idempotency_key: 'demo-result-key-00000000001', duration_seconds: 38,
            created_at: '2026-01-01T00:00:00.000Z', started_at: startedAt,
        });
        const current = await GET(new Request(`https://example.com/api/analysis/v2/result/${requestId}?pageSize=1`), context());

        const legacyPayload = await legacy.json() as { femaleAccounts: Array<{ instagramId: string }> };
        const currentPayload = await current.json() as { femaleAccounts: Array<{ instagramId: string }> };
        expect(legacyPayload.femaleAccounts[0]?.instagramId).not.toBe(currentPayload.femaleAccounts[0]?.instagramId);
        expect(mocks.loadPage).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('returns a safe 404 for a demo row that is not owned by the authenticated operator', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: '323e4567-e89b-42d3-a456-426614174000', target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-result-key-00000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date(Date.now() - 80_000).toISOString(),
        });
        const response = await GET(new Request(`https://example.com/api/analysis/v2/result/${requestId}`), context());
        expect(response.status).toBe(404);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.loadPage).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('owner-scopes cursor reads and returns a validated no-store envelope', async () => {
        const femaleCursor = cursor('public');
        const privateCursor = cursor('private');
        const response = await GET(
            new Request(
                `https://example.com/api/analysis/v2/result/${requestId}`
                + `?femaleCursor=${femaleCursor}&privateCursor=${privateCursor}&pageSize=25`
            ),
            context()
        );

        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
        expect(mocks.loadPage).toHaveBeenCalledWith({
            requestId,
            userId,
            femaleCursor,
            privateCursor,
            pageSize: 25,
        });
        await expect(response.json()).resolves.toMatchObject({
            schemaVersion: 1,
            requestId,
        });
        expect(mocks.operationalEmit).not.toHaveBeenCalled();
        expect(mocks.resolveResultOwner).not.toHaveBeenCalled();
    });

    it('lets the authenticated result operator read a completed result through its real owner boundary', async () => {
        const ownerUserId = '423e4567-e89b-42d3-a456-426614174000';
        mocks.getUser.mockResolvedValue({
            data: { user: { id: userId, email: 'ym1113@kakao.com' } },
            error: null,
        });
        mocks.isResultOperator.mockReturnValue(true);
        mocks.resolveResultOwner.mockResolvedValue(ownerUserId);

        const response = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(200);
        expect(mocks.isResultOperator).toHaveBeenCalledWith({
            id: userId,
            email: 'ym1113@kakao.com',
        });
        expect(mocks.resolveResultOwner).toHaveBeenCalledWith(requestId);
        expect(mocks.loadPage).toHaveBeenCalledWith(expect.objectContaining({
            requestId,
            userId: ownerUserId,
        }));
        expect(mocks.operationalEmit).toHaveBeenCalledWith(expect.objectContaining({
            fields: expect.objectContaining({ user_id: userId }),
        }));
    });

    it('does not resolve another owner for a normal authenticated user', async () => {
        mocks.getUser.mockResolvedValue({
            data: { user: { id: userId, email: 'someone@example.com' } },
            error: null,
        });

        const response = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(200);
        expect(mocks.resolveResultOwner).not.toHaveBeenCalled();
        expect(mocks.loadPage).toHaveBeenCalledWith(expect.objectContaining({
            userId,
        }));
    });

    it('records the initial completed-result view with the owner and analysis join keys', async () => {
        const response = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}`),
            context(),
        );

        expect(response.status).toBe(200);
        expect(mocks.operationalEmit).toHaveBeenCalledWith({
            event: 'analysis_v2.result_viewed',
            severity: 'info',
            fields: expect.objectContaining({
                request_id: '323e4567-e89b-42d3-a456-426614174000',
                user_id: userId,
                analysis_request_id: requestId,
                operation: 'result',
                disposition: 'success',
            }),
        });
    });

    it('maps owner-hidden results to 404 and invalid store output to 500', async () => {
        mocks.loadPage.mockResolvedValueOnce(null);
        const hidden = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}`),
            context()
        );
        expect(hidden.status).toBe(404);

        mocks.loadPage.mockResolvedValueOnce({ ...page(), schemaVersion: 2 });
        const invalid = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}`),
            context()
        );
        expect(invalid.status).toBe(500);
    });
});
