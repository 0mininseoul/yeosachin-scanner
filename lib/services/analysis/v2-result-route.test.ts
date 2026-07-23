import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    encodeResultCursor,
    type ResultListKind,
} from '@/lib/domain/analysis/result-pagination';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    loadPage: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/v2-result-store', () => ({
    analysisV2ResultStore: { loadPage: mocks.loadPage },
}));

import { GET } from '@/app/api/analysis/v2/result/[requestId]/route';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';

function context(id = requestId) {
    return { params: Promise.resolve({ requestId: id }) };
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
    });

    it('validates identifiers, cursor scope, and page size before authentication', async () => {
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
        expect(mocks.getUser).not.toHaveBeenCalled();
    });

    it('requires authentication', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
        const response = await GET(
            new Request(`https://example.com/api/analysis/v2/result/${requestId}`),
            context()
        );
        expect(response.status).toBe(401);
        expect(mocks.loadPage).not.toHaveBeenCalled();
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
