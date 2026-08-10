import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    loadForOwner: vi.fn(),
    loadDag: vi.fn(),
    demoFindForOwner: vi.fn(),
    isDemoOperator: vi.fn(),
    requireActiveAccountClassification: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/v2-progress-store', () => ({
    analysisV2ProgressStore: { loadForOwner: mocks.loadForOwner },
}));
vi.mock('@/lib/services/analysis/v2-dag-state-store', () => ({
    createSupabaseAnalysisV2DagStateStore: () => ({ load: mocks.loadDag }),
}));
vi.mock('@/lib/services/demo-analysis/store', () => ({
    demoAnalysisStore: { findForOwner: mocks.demoFindForOwner },
}));
vi.mock('@/lib/services/demo-analysis/demo-analysis', () => ({
    isDemoOperator: mocks.isDemoOperator,
}));
vi.mock('@/lib/services/identity/account-principal-store', async importOriginal => ({
    ...(await importOriginal<typeof import('@/lib/services/identity/account-principal-store')>()),
    requireActiveAccountClassification: mocks.requireActiveAccountClassification,
}));

import { GET } from '@/app/api/analysis/duration/[requestId]/route';
import { AccountPrincipalAdmissionError } from '@/lib/services/identity/account-principal-store';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const hash = 'a'.repeat(64);
const context = (id = requestId) => ({ params: Promise.resolve({ requestId: id }) });

function state() {
    return {
        schemaVersion: 2 as const, requestSnapshotHash: hash, planId: 'standard' as const,
        planSnapshotHash: hash, girlfriendExclusion: { decisionHash: hash, excludedCount: 0 as const },
        relationships: {
            revision: 1, resultHash: hash, detectedMutualCount: 474, publicCount: 430, privateCount: 44,
            detailedSelectedPublicCount: 300, notScreenedPublicCount: 130,
            profileBatches: Array.from({ length: 5 }, (_, batch) => ({ batch, itemCount: 86, inputHash: hash })),
            privateNameBatches: [{ batch: 0, itemCount: 44, inputHash: hash }],
        },
    };
}

describe('analysis duration owner route', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.demoFindForOwner.mockResolvedValue(null);
        mocks.loadForOwner.mockResolvedValue({ snapshot: { status: 'processing' } });
        mocks.loadDag.mockResolvedValue(state());
        mocks.isDemoOperator.mockReturnValue(true);
        mocks.requireActiveAccountClassification.mockResolvedValue({
            userId,
            accountClass: 'production',
            trafficClass: 'external',
            lifecycle: 'active',
            classificationVersion: 'account-ledger-v1',
        });
    });

    it('owner-scopes stage two and returns only its versioned public range', async () => {
        const response = await GET(new Request(`https://example.com/api/analysis/duration/${requestId}`), context());
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('private, no-store, max-age=0');
        expect(mocks.loadForOwner).toHaveBeenCalledWith({ requestId, userId, afterSequence: 0, eventLimit: 1 });
        const payload = await response.json();
        expect(payload).toEqual({ estimate: { version: 'v1', band: 'typical', range: { lowMinutes: 5, highMinutes: 8 } } });
        expect(JSON.stringify(payload)).not.toContain('474');
        expect(JSON.stringify(payload)).not.toContain('detailed');
    });

    it('keeps demo on the isolated 60–90 second response without loading production state', async () => {
        mocks.demoFindForOwner.mockResolvedValue({ user_id: userId, started_at: '2026-07-27T00:00:00.000Z' });
        const response = await GET(new Request(`https://example.com/api/analysis/duration/${requestId}`), context());
        expect(await response.json()).toEqual({
            source: 'demo', version: 'demo-v1', rangeSeconds: { lowSeconds: 60, highSeconds: 90 },
        });
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
        expect(mocks.loadDag).not.toHaveBeenCalled();
    });

    it('does not expose duration state for legacy or terminal requests', async () => {
        mocks.loadForOwner.mockResolvedValue(null);
        const legacy = await GET(new Request(`https://example.com/api/analysis/duration/${requestId}`), context());
        expect(legacy.status).toBe(404);

        mocks.loadForOwner.mockResolvedValue({ snapshot: { status: 'completed' } });
        const terminal = await GET(new Request(`https://example.com/api/analysis/duration/${requestId}`), context());
        expect(await terminal.json()).toEqual({ estimate: null });
        expect(mocks.loadDag).not.toHaveBeenCalled();
    });

    it('fails closed before owner duration reads for a retired account', async () => {
        mocks.requireActiveAccountClassification.mockRejectedValue(
            new AccountPrincipalAdmissionError(),
        );

        const response = await GET(
            new Request(`https://example.com/api/analysis/duration/${requestId}`),
            context(),
        );

        expect(response.status).toBe(403);
        expect(mocks.requireActiveAccountClassification).toHaveBeenCalledWith(userId);
        expect(mocks.demoFindForOwner).not.toHaveBeenCalled();
        expect(mocks.loadForOwner).not.toHaveBeenCalled();
    });
});
