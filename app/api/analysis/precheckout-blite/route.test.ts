import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    createClient: vi.fn(),
    getUser: vi.fn(),
    findForOwner: vi.fn(),
    readAnonymousAnalysisV2Preflight: vi.fn(),
    getInstagramProfile: vi.fn(),
    inferPrecheckoutBlite: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({ createClient: mocks.createClient }));
vi.mock('@/lib/services/analysis/preflight', () => ({
    preflightStore: { findForOwner: mocks.findForOwner },
}));
vi.mock('@/lib/services/analysis/anonymous-preflight', () => ({
    readAnonymousAnalysisV2Preflight: mocks.readAnonymousAnalysisV2Preflight,
}));
vi.mock('@/lib/services/instagram/scraper', () => ({
    getInstagramProfile: mocks.getInstagramProfile,
}));
vi.mock('@/lib/services/precheckout/blite-inference', () => ({
    inferPrecheckoutBlite: mocks.inferPrecheckoutBlite,
}));

import { POST, __resetPrecheckoutBliteCacheForTest } from './route';

const preflightId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const anonymousClaimToken = 'v1.anonymous-claim-token-fixture';

function request(body: unknown = { preflightId }, headers: Record<string, string> = {}) {
    return new Request('https://example.com/api/analysis/precheckout-blite', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
    });
}

function storedReadyPreflight(overrides: { username?: string } = {}) {
    return {
        preflightId,
        status: 'ready' as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        blockedCode: null,
        exclusionDecision: 'pending' as const,
        readySnapshot: {
            target: {
                username: overrides.username ?? 'target_user',
                fullName: null,
                bio: null,
                profileImageUrl: null,
                followersCount: 1_200,
                followingCount: 900,
                isPrivate: false as const,
            },
            accessMode: 'standard',
            capacityRequiredPlan: 'basic',
            requiredPlan: 'basic',
            plans: [],
            pricingVersion: 'v1',
        },
    };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(resolver => { resolve = resolver; });
    return { promise, resolve };
}

function storedNonReadyPreflight() {
    return {
        preflightId,
        status: 'pending' as const,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        blockedCode: null,
        exclusionDecision: 'pending' as const,
        readySnapshot: null,
    };
}

function profileWithPosts(overrides: Record<string, unknown> = {}) {
    return {
        username: 'target_user',
        fullName: '홍길동',
        bio: 'bio text',
        externalUrl: 'https://example.com',
        profilePicUrl: 'https://cdn.example.com/p.jpg',
        followersCount: 1_200,
        followingCount: 900,
        postsCount: 12,
        isPrivate: false,
        isVerified: false,
        latestPosts: [{
            id: '1', shortCode: 'a', type: 'image', likesCount: 5, commentsCount: 1,
            timestamp: '2026-08-01T00:00:00.000Z', taggedUsers: [], mentionedUsers: [], hashtags: [],
        }],
        ...overrides,
    };
}

function validDto() {
    return {
        schemaVersion: 1,
        persona: { headline: '헤드라인 텍스트입니다', summary: '요약 텍스트입니다 한글 포함' },
        signals: [
            { claim: '신호 1 텍스트', category: '카테고리', confidence: 0.82, band: 'high' },
            { claim: '신호 2 텍스트', category: '카테고리', confidence: 0.62, band: 'medium' },
            { claim: '신호 3 텍스트', category: '카테고리', confidence: 0.35, band: 'low' },
            { claim: '신호 4 텍스트', category: '카테고리', confidence: 0.71, band: 'high' },
        ],
        candidateRange: { min: 3, max: 9 },
        genderRead: {
            likelyFemale: true,
            confidence: 0.81,
            reasons: ['이유 1 텍스트', '이유 2 텍스트', '이유 3 텍스트'],
        },
        postCount: 1,
        evidenceFields: ['post.caption'],
    };
}

describe('POST /api/analysis/precheckout-blite', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        __resetPrecheckoutBliteCacheForTest();
        process.env.PRECHECKOUT_BLITE_ENABLED = 'true';
        mocks.createClient.mockResolvedValue({ auth: { getUser: mocks.getUser } });
        mocks.getUser.mockResolvedValue({ data: { user: { id: userId } }, error: null });
        mocks.findForOwner.mockResolvedValue(storedReadyPreflight());
        mocks.getInstagramProfile.mockResolvedValue(profileWithPosts());
        mocks.inferPrecheckoutBlite.mockResolvedValue(validDto());
    });

    it('responds 204 with no body when the flag is off', async () => {
        delete process.env.PRECHECKOUT_BLITE_ENABLED;
        const response = await POST(request());
        expect(response.status).toBe(204);
        expect(mocks.findForOwner).not.toHaveBeenCalled();
    });

    it('responds 204 for a malformed request body', async () => {
        const response = await POST(request({ preflightId: 'not-a-uuid' }));
        expect(response.status).toBe(204);
        expect(mocks.findForOwner).not.toHaveBeenCalled();
    });

    it('responds 204 for a request with no body at all', async () => {
        const response = await POST(new Request('https://example.com/api/analysis/precheckout-blite', {
            method: 'POST',
        }));
        expect(response.status).toBe(204);
    });

    it('responds 204 for an unauthenticated caller with no anonymous claim token', async () => {
        mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
        const response = await POST(request());
        expect(response.status).toBe(204);
        expect(mocks.findForOwner).not.toHaveBeenCalled();
        expect(mocks.readAnonymousAnalysisV2Preflight).not.toHaveBeenCalled();
    });

    it('responds 204 when the preflight is not found', async () => {
        mocks.findForOwner.mockResolvedValue(null);
        const response = await POST(request());
        expect(response.status).toBe(204);
        expect(mocks.getInstagramProfile).not.toHaveBeenCalled();
    });

    it('responds 204 when the preflight is not in the ready state', async () => {
        mocks.findForOwner.mockResolvedValue(storedNonReadyPreflight());
        const response = await POST(request());
        expect(response.status).toBe(204);
        expect(mocks.getInstagramProfile).not.toHaveBeenCalled();
    });

    it('responds 204 for an expired ready preflight before reading cache or scraping', async () => {
        mocks.findForOwner.mockResolvedValue({
            ...storedReadyPreflight(),
            expiresAt: new Date(Date.now() - 1_000).toISOString(),
        });
        const response = await POST(request());
        expect(response.status).toBe(204);
        expect(mocks.getInstagramProfile).not.toHaveBeenCalled();
    });

    it('responds 204 when the profile cannot be fetched', async () => {
        mocks.getInstagramProfile.mockResolvedValue(null);
        const response = await POST(request());
        expect(response.status).toBe(204);
        expect(mocks.inferPrecheckoutBlite).not.toHaveBeenCalled();
    });

    it('responds 204 for a private profile', async () => {
        mocks.getInstagramProfile.mockResolvedValue(profileWithPosts({ isPrivate: true }));
        const response = await POST(request());
        expect(response.status).toBe(204);
        expect(mocks.inferPrecheckoutBlite).not.toHaveBeenCalled();
    });

    it('responds 204 when the profile has no posts', async () => {
        mocks.getInstagramProfile.mockResolvedValue(profileWithPosts({ latestPosts: [] }));
        const response = await POST(request());
        expect(response.status).toBe(204);
        expect(mocks.inferPrecheckoutBlite).not.toHaveBeenCalled();
    });

    it('responds 204 when inference returns null', async () => {
        mocks.inferPrecheckoutBlite.mockResolvedValue(null);
        const response = await POST(request());
        expect(response.status).toBe(204);
    });

    it('responds 204 (never 5xx) when an unexpected error is thrown', async () => {
        mocks.findForOwner.mockRejectedValue(new Error('boom'));
        const response = await POST(request());
        expect(response.status).toBe(204);
    });

    it('returns the DTO body on success with no identifying field', async () => {
        const response = await POST(request());
        expect(response.status).toBe(200);
        const payload = await response.json();
        expect(payload).toEqual(validDto());

        const serialized = JSON.stringify(payload);
        expect(serialized).not.toContain('target_user');
        expect(serialized).not.toContain(preflightId);
        expect(serialized).not.toContain('홍길동');
        expect(serialized).not.toContain('bio text');
        expect(serialized).not.toContain('example.com');
        expect(serialized).not.toContain('1200');
        expect(serialized).not.toContain('900');
    });

    it('passes the ready-snapshot username to the scraper, not an arbitrary value', async () => {
        mocks.findForOwner.mockResolvedValue(storedReadyPreflight({ username: 'resolved_target' }));
        mocks.getInstagramProfile.mockResolvedValue(profileWithPosts({ username: 'resolved_target' }));
        await POST(request());
        expect(mocks.getInstagramProfile).toHaveBeenCalledWith(
            'resolved_target',
            expect.objectContaining({
                requestId: preflightId,
                providerRun: expect.objectContaining({
                    invocationDeadlineAtMs: expect.any(Number),
                    startCancellationSignal: expect.any(AbortSignal),
                }),
            })
        );
    });

    it('coalesces concurrent requests for one preflight into one scrape and inference', async () => {
        const pendingProfile = deferred<ReturnType<typeof profileWithPosts>>();
        mocks.getInstagramProfile.mockReturnValue(pendingProfile.promise);

        const firstPromise = POST(request());
        const secondPromise = POST(request());
        await vi.waitFor(() => expect(mocks.getInstagramProfile).toHaveBeenCalledTimes(1));

        pendingProfile.resolve(profileWithPosts());
        const [first, second] = await Promise.all([firstPromise, secondPromise]);
        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(mocks.getInstagramProfile).toHaveBeenCalledTimes(1);
        expect(mocks.inferPrecheckoutBlite).toHaveBeenCalledTimes(1);
    });

    it('caches the DTO by preflightId so a repeat request does not re-run inference', async () => {
        const first = await POST(request());
        expect(first.status).toBe(200);
        const second = await POST(request());
        expect(second.status).toBe(200);

        expect(mocks.getInstagramProfile).toHaveBeenCalledTimes(1);
        expect(mocks.inferPrecheckoutBlite).toHaveBeenCalledTimes(1);
        // Ownership is still re-verified on every request, cache hit or not.
        expect(mocks.findForOwner).toHaveBeenCalledTimes(2);

        const secondPayload = await second.json();
        expect(secondPayload).toEqual(validDto());
    });

    // This screen sits before login and payment, so most real callers arrive here with no
    // Supabase session at all. Access is proven the same way the existing preflight status
    // route proves it: a short-lived signed claim token in `x-preflight-claim-token`, verified
    // server-side by `readAnonymousAnalysisV2Preflight`.
    describe('anonymous caller (no session)', () => {
        beforeEach(() => {
            mocks.getUser.mockResolvedValue({ data: { user: null }, error: null });
            mocks.readAnonymousAnalysisV2Preflight.mockResolvedValue(storedReadyPreflight());
        });

        it('returns the success DTO for an anonymous caller with a valid claim on a ready preflight', async () => {
            const response = await POST(request(
                { preflightId },
                { 'x-preflight-claim-token': anonymousClaimToken },
            ));
            expect(response.status).toBe(200);
            const payload = await response.json();
            expect(payload).toEqual(validDto());

            expect(mocks.readAnonymousAnalysisV2Preflight).toHaveBeenCalledWith(
                preflightId,
                anonymousClaimToken,
                expect.objectContaining({ client: expect.anything() }),
            );
            expect(mocks.findForOwner).not.toHaveBeenCalled();
        });

        it('responds 204 for an anonymous caller who cannot prove access to the preflight', async () => {
            mocks.readAnonymousAnalysisV2Preflight.mockResolvedValue(null);
            const response = await POST(request(
                { preflightId },
                { 'x-preflight-claim-token': anonymousClaimToken },
            ));
            expect(response.status).toBe(204);
            expect(mocks.getInstagramProfile).not.toHaveBeenCalled();
        });

        it('responds 204 for an anonymous caller with no claim token at all', async () => {
            const response = await POST(request());
            expect(response.status).toBe(204);
            expect(mocks.readAnonymousAnalysisV2Preflight).not.toHaveBeenCalled();
        });

        it('responds 204 for an anonymous caller on a non-ready preflight', async () => {
            mocks.readAnonymousAnalysisV2Preflight.mockResolvedValue(storedNonReadyPreflight());
            const response = await POST(request(
                { preflightId },
                { 'x-preflight-claim-token': anonymousClaimToken },
            ));
            expect(response.status).toBe(204);
            expect(mocks.getInstagramProfile).not.toHaveBeenCalled();
        });

        it('responds 204 (never 4xx/5xx) when claim verification itself throws', async () => {
            mocks.readAnonymousAnalysisV2Preflight.mockRejectedValue(
                new Error('ANONYMOUS_PREFLIGHT_CLAIM_INVALID')
            );
            const response = await POST(request(
                { preflightId },
                { 'x-preflight-claim-token': anonymousClaimToken },
            ));
            expect(response.status).toBe(204);
        });

        it('re-verifies the anonymous claim on every request, including cache hits', async () => {
            const first = await POST(request(
                { preflightId },
                { 'x-preflight-claim-token': anonymousClaimToken },
            ));
            expect(first.status).toBe(200);
            const second = await POST(request(
                { preflightId },
                { 'x-preflight-claim-token': anonymousClaimToken },
            ));
            expect(second.status).toBe(200);

            expect(mocks.inferPrecheckoutBlite).toHaveBeenCalledTimes(1);
            // Ownership/claim is still re-verified on every request, cache hit or not.
            expect(mocks.readAnonymousAnalysisV2Preflight).toHaveBeenCalledTimes(2);
        });
    });
});
