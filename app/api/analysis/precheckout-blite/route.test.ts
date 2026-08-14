import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    findForOwner: vi.fn(),
    readAnonymous: vi.fn(),
    readStatus: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/preflight', () => ({
    preflightStore: { findForOwner: mocks.findForOwner },
}));
vi.mock('@/lib/services/analysis/anonymous-preflight', () => ({
    readAnonymousAnalysisV2Preflight: mocks.readAnonymous,
}));
vi.mock('@/lib/services/precheckout/blite-store', () => ({
    precheckoutBliteTerminalStore: { readStatus: mocks.readStatus },
}));

import { POST, maxDuration } from './route';

const preflightId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const submittedAt = '2026-08-13T00:00:00.000Z';
const deadlineAt = '2026-08-13T00:01:30.000Z';

function request(headers: Record<string, string> = {}) {
    return new Request('https://example.com/api/analysis/precheckout-blite', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ preflightId }),
    });
}

function ready() {
    return {
        preflightId,
        status: 'ready' as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        blockedCode: null,
        exclusionDecision: 'pending' as const,
        readySnapshot: null,
    };
}

function dto() {
    return {
        schemaVersion: 1,
        persona: { headline: '요약', summary: '설명' },
        signals: [
            { claim: '신호 하나', category: '성향', confidence: 0.8, band: 'high' as const },
            { claim: '신호 둘', category: '성향', confidence: 0.6, band: 'medium' as const },
            { claim: '신호 셋', category: '성향', confidence: 0.4, band: 'low' as const },
            { claim: '신호 넷', category: '성향', confidence: 0.7, band: 'high' as const },
        ],
        candidateRange: { min: 0, max: 1 },
        genderRead: { likelyFemale: false, confidence: 0, reasons: ['가', '나', '다'] },
        postCount: 0,
        evidenceFields: ['post.caption'],
    };
}

describe('POST /api/analysis/precheckout-blite', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        process.env.PRECHECKOUT_BLITE_ENABLED = 'true';
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.findForOwner.mockResolvedValue(ready());
    });

    it('is a 15-second status-only route and returns a bounded pending response', async () => {
        mocks.readStatus.mockResolvedValue({ state: 'pending', submittedAt, deadlineAt });

        const response = await POST(request());

        expect(maxDuration).toBe(15);
        expect(response.status).toBe(202);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({
            state: 'pending',
            submittedAt,
            deadlineAt,
            fallbackAt: '2026-08-13T00:01:18.000Z',
            retryAfterMs: 1_000,
        });
        expect(mocks.readStatus).toHaveBeenCalledWith({ preflightId });
    });

    it('returns complete and terminal failed cache states without any generation work', async () => {
        mocks.readStatus.mockResolvedValueOnce({
            state: 'complete', submittedAt, deadlineAt,
            completedAt: '2026-08-13T00:00:20.000Z',
            dto: dto(),
        }).mockResolvedValueOnce({
            state: 'failed', submittedAt, deadlineAt, failedAt: '2026-08-13T00:00:30.000Z',
        });

        const complete = await POST(request());
        const failed = await POST(request());
        expect(complete.status).toBe(200);
        expect((await complete.json()).state).toBe('complete');
        expect(failed.status).toBe(200);
        expect(await failed.json()).toEqual({
            state: 'failed', submittedAt, deadlineAt,
            fallbackAt: '2026-08-13T00:01:18.000Z',
        });
    });

    it('keeps anonymous claim access and fails open when cache is unavailable', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
        mocks.readAnonymous.mockResolvedValue(ready());
        mocks.readStatus.mockResolvedValue(null);

        const response = await POST(request({ 'x-preflight-claim-token': 'anonymous-claim' }));

        expect(response.status).toBe(204);
        expect(mocks.readAnonymous).toHaveBeenCalledWith(
            preflightId, 'anonymous-claim', expect.objectContaining({ client: expect.anything() }),
        );
    });
});
