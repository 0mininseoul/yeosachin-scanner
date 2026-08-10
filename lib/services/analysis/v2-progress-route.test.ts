import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDemoFixture } from '@/lib/services/demo-analysis/demo-analysis';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    loadForOwner: vi.fn(),
    demoFindForOwner: vi.fn(),
    loadFixture: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/v2-progress-store', () => ({
    analysisV2ProgressStore: { loadForOwner: mocks.loadForOwner },
}));
vi.mock('@/lib/services/demo-analysis/store', () => ({
    demoAnalysisStore: { findForOwner: mocks.demoFindForOwner },
}));
vi.mock('@/lib/services/demo-analysis/fixture-store', () => ({
    loadDemoFixtureForVersion: mocks.loadFixture,
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { GET } from '@/app/api/analysis/progress/[requestId]/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const occurredAt = '2026-07-13T09:00:00.000Z';

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

function snapshot() {
    return {
        schemaVersion: 1 as const,
        requestId,
        revision: 2,
        status: 'processing' as const,
        progressBp: 2_500,
        backgroundProcessing: true,
        tracks: {
            relationshipAi: {
                state: 'running' as const,
                stageCode: 'PROFILE_SCREENING',
                done: 1,
                total: 4,
                progressBp: 2_500,
            },
            interactions: {
                state: 'pending' as const,
                stageCode: 'INTERACTIONS_QUEUED',
                done: 0,
                total: 2,
                progressBp: 0,
            },
            finalization: {
                state: 'pending' as const,
                stageCode: 'FINALIZATION_QUEUED',
                done: 0,
                total: 1,
                progressBp: 0,
            },
        },
        activeProfile: {
            maskedUsername: 'a***e',
            imageUrl: null,
            feedImageUrls: ['/api/image-proxy?token=progress-feed'],
        },
        etaRange: { lowSeconds: 90, highSeconds: 180 },
        lastEventSeq: 1,
    };
}

describe('analysis V2 owner progress route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.loadForOwner.mockResolvedValue({
            snapshot: snapshot(),
            events: [{
                schemaVersion: 1,
                requestId,
                seq: 1,
                revision: 2,
                occurredAt,
                state: 'confirmed',
                eventCode: 'PROFILE_SCREENED',
                copyCode: 'PROFILE_SCREENED',
                aggregateCount: 1,
            }],
        });
        mocks.demoFindForOwner.mockResolvedValue(null);
        mocks.loadFixture.mockImplementation(async (version: string) => loadedFixture(version));
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
    });

    it('requires authentication before reading malformed pagination for a valid route id', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
        const response = await GET(
            new Request(`https://example.com/api/analysis/progress/${requestId}?afterSeq=-1`),
            context()
        );
        expect(response.status).toBe(401);
        expect(response.headers.get('x-analytics-eligible')).toBeNull();
        expect(mocks.demoFindForOwner).not.toHaveBeenCalled();
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
    });

    it('validates route identifiers safely and keeps malformed production pagination generic', async () => {
        const malformedId = await GET(
            new Request('https://example.com/api/analysis/progress/nope'),
            context('nope')
        );
        const malformedCursor = await GET(
            new Request(`https://example.com/api/analysis/progress/${requestId}?afterSeq=-1`),
            context()
        );
        const excessiveLimit = await GET(
            new Request(`https://example.com/api/analysis/progress/${requestId}?limit=201`),
            context()
        );
        expect([malformedId.status, malformedCursor.status, excessiveLimit.status])
            .toEqual([400, 400, 400]);
        expect(malformedId.headers.get('x-analytics-eligible')).toBeNull();
        expect(malformedCursor.headers.get('x-analytics-eligible')).toBeNull();
        expect(excessiveLimit.headers.get('x-analytics-eligible')).toBeNull();
        expect(mocks.getUser).toHaveBeenCalledTimes(2);
        expect(mocks.demoFindForOwner).toHaveBeenCalledTimes(2);
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
    });

    it('owner-scopes recovery reads and returns a validated no-store envelope', async () => {
        const response = await GET(
            new Request(
                `https://example.com/api/analysis/progress/${requestId}?afterSeq=0&limit=25`
            ),
            context()
        );
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
        expect(mocks.loadForOwner).toHaveBeenCalledWith({
            requestId,
            userId,
            afterSequence: 0,
            eventLimit: 25,
        });
        await expect(response.json()).resolves.toMatchObject({
            schemaVersion: 1,
            snapshot: {
                requestId,
                lastEventSeq: 1,
                activeProfile: {
                    feedImageUrls: ['/api/image-proxy?token=progress-feed'],
                },
            },
            events: [{ seq: 1, eventCode: 'PROFILE_SCREENED' }],
        });
    });

    it('fails closed before owner progress reads for a retired account', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await GET(
            new Request(`https://example.com/api/analysis/progress/${requestId}`),
            context(),
        );

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.demoFindForOwner).not.toHaveBeenCalled();
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
    });

    it('serves an allowlisted started demo without loading production progress', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-progress-key-000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date(Date.now() - 20_000).toISOString(),
        });
        const response = await GET(new Request(`https://example.com/api/analysis/progress/${requestId}`), context());
        expect(response.status).toBe(200);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        await expect(response.json()).resolves.toMatchObject({ snapshot: { requestId, status: 'processing' } });
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('projects a non-static DB fixture by its persisted version without production progress reads', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-01T00:00:20.000Z'));
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        const fixtureVersion = 'operator-editable-fixture-route-v1';
        const fixture = createDemoFixture('database-progress-fixture');
        fixture.publicAccounts[5]!.instagramId = 'db.fixture.profile';
        mocks.loadFixture.mockResolvedValue({
            version: fixtureVersion,
            target: { username: 'junho_dem', fullName: 'DB Fixture Target', bio: 'fixture bio', profileImage: '/demo-avatars/demo-v3-target-000.webp', followersCount: 600, followingCount: 580, isPrivate: false },
            fixture: { ...fixture, version: fixtureVersion },
        });
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: fixtureVersion,
            idempotency_key: 'demo-progress-key-db-fixture', duration_seconds: 38,
            created_at: '2026-07-01T00:00:00.000Z', started_at: '2026-07-01T00:00:00.000Z',
        });
        try {
            const response = await GET(new Request(`https://example.com/api/analysis/progress/${requestId}`), context());
            expect(response.status).toBe(200);
            await expect(response.json()).resolves.toMatchObject({ snapshot: { activeProfile: { maskedUsername: 'db.fixture.profile*' } } });
            expect(mocks.loadFixture).toHaveBeenCalledWith(fixtureVersion);
            expect(mocks.loadForOwner).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
            vi.unstubAllEnvs();
        }
    });

    it('returns demo-unavailable without production progress reads when a DB fixture cannot load', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.loadFixture.mockResolvedValue(null);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'operator-editable-fixture-route-v1',
            idempotency_key: 'demo-progress-key-no-fixture', duration_seconds: 38,
            created_at: '2026-07-01T00:00:00.000Z', started_at: new Date().toISOString(),
        });
        const response = await GET(new Request(`https://example.com/api/analysis/progress/${requestId}`), context());
        expect(response.status).toBe(503);
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('dispatches a legacy run to the legacy progress profile instead of v2 source text', async () => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-progress-key-000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date(Date.now() - 20_000).toISOString(),
        });

        const response = await GET(new Request(`https://example.com/api/analysis/progress/${requestId}`), context());
        await expect(response.json()).resolves.toMatchObject({
            snapshot: { activeProfile: { maskedUsername: 'profile.***' } },
        });
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it.each([
        'afterSeq=-1',
        'limit=201',
    ])('keeps malformed demo progress pagination private: %s', async query => {
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-progress-key-000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', started_at: new Date().toISOString(),
        });

        const response = await GET(
            new Request(`https://example.com/api/analysis/progress/${requestId}?${query}`),
            context()
        );

        expect(response.status).toBe(400);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.demoFindForOwner).toHaveBeenCalledWith(requestId, userId);
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('returns only the requested contiguous demo event window across refreshes', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-07-01T00:00:20.000Z'));
        vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
        vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-progress-key-000000000', duration_seconds: 75,
            created_at: '2026-07-01T00:00:00.000Z', started_at: '2026-07-01T00:00:00.000Z',
        });
        try {
            const first = await GET(new Request(`https://example.com/api/analysis/progress/${requestId}?afterSeq=1&limit=2`), context());
            const firstPayload = await first.json() as { snapshot: { lastEventSeq: number }; events: Array<{ seq: number; revision: number; occurredAt: string }> };
            expect(firstPayload.snapshot.lastEventSeq).toBeGreaterThanOrEqual(4);
            expect(firstPayload.events.map(event => event.seq)).toEqual([2, 3]);
            expect(firstPayload.events[1]!.revision).toBeGreaterThan(firstPayload.events[0]!.revision);
            expect(Date.parse(firstPayload.events[1]!.occurredAt)).toBeGreaterThan(Date.parse(firstPayload.events[0]!.occurredAt));

            const refreshed = await GET(new Request(`https://example.com/api/analysis/progress/${requestId}?afterSeq=3&limit=2`), context());
            const refreshedPayload = await refreshed.json() as { events: Array<{ seq: number; revision: number; occurredAt: string }> };
            expect(refreshedPayload.events.map(event => event.seq)).toEqual([4]);
            expect(refreshedPayload.events[0]!.revision).toBeGreaterThan(firstPayload.events[1]!.revision);
            expect(Date.parse(refreshedPayload.events[0]!.occurredAt)).toBeGreaterThan(Date.parse(firstPayload.events[1]!.occurredAt));
        } finally {
            vi.useRealTimers();
            vi.unstubAllEnvs();
        }
    });

    it.each([
        ['unstarted', { started_at: null }, true],
        ['flag-off', { started_at: new Date(Date.now() - 20_000).toISOString() }, false],
        ['other-owner', { user_id: '323e4567-e89b-42d3-a456-426614174000', started_at: new Date(Date.now() - 20_000).toISOString() }, true],
    ])('returns a safe 404 for a %s demo state without loading production progress', async (_case, overrides, enabled) => {
        if (enabled) {
            vi.stubEnv('DEMO_ANALYSIS_ENABLED', 'true');
            vi.stubEnv('DEMO_ANALYSIS_OPERATOR_USER_IDS', userId);
        }
        mocks.demoFindForOwner.mockResolvedValue({
            id: requestId, user_id: userId, target_instagram_id: 'junho_dem', fixture_version: 'synthetic-fixture-v1',
            idempotency_key: 'demo-progress-key-000000000', duration_seconds: 75,
            created_at: '2026-01-01T00:00:00.000Z', ...overrides,
        });
        const response = await GET(new Request(`https://example.com/api/analysis/progress/${requestId}`), context());
        expect(response.status).toBe(404);
        expect(response.headers.get('x-analytics-eligible')).toBe('0');
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
        vi.unstubAllEnvs();
    });

    it('maps an owner-hidden row to 404 without leaking existence', async () => {
        mocks.loadForOwner.mockResolvedValue(null);
        const response = await GET(
            new Request(`https://example.com/api/analysis/progress/${requestId}`),
            context()
        );
        expect(response.status).toBe(404);
    });

    it('fails closed when the store response violates the public contract', async () => {
        mocks.loadForOwner.mockResolvedValue({
            snapshot: snapshot(),
            events: [{
                schemaVersion: 1,
                requestId: '323e4567-e89b-42d3-a456-426614174000',
                seq: 1,
                revision: 2,
                occurredAt,
                state: 'confirmed',
                eventCode: 'PROFILE_SCREENED',
                copyCode: 'PROFILE_SCREENED',
                aggregateCount: 1,
            }],
        });
        const response = await GET(
            new Request(`https://example.com/api/analysis/progress/${requestId}`),
            context()
        );
        expect(response.status).toBe(500);
    });
});
