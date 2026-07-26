import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    loadForOwner: vi.fn(),
    demoFindForOwner: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/v2-progress-store', () => ({
    analysisV2ProgressStore: { loadForOwner: mocks.loadForOwner },
}));
vi.mock('@/lib/services/demo-analysis/store', () => ({
    demoAnalysisStore: { findForOwner: mocks.demoFindForOwner },
}));

import { GET } from '@/app/api/analysis/progress/[requestId]/route';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const occurredAt = '2026-07-13T09:00:00.000Z';

function context(id = requestId) {
    return { params: Promise.resolve({ requestId: id }) };
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
        activeProfile: { maskedUsername: 'a***e', imageUrl: null },
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
    });

    it('requires authentication before reading owner progress', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
        const response = await GET(
            new Request(`https://example.com/api/analysis/progress/${requestId}`),
            context()
        );
        expect(response.status).toBe(401);
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
    });

    it('rejects malformed request ids and cursor bounds before authentication', async () => {
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
        expect(mocks.getUser).not.toHaveBeenCalled();
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
            snapshot: { requestId, lastEventSeq: 1 },
            events: [{ seq: 1, eventCode: 'PROFILE_SCREENED' }],
        });
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
