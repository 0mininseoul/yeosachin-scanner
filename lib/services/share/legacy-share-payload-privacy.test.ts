import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    loadV2Page: vi.fn(),
    isResultAuthoritativelyPublished: vi.fn(),
}));

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: { from: mocks.from } }));
vi.mock('@/lib/services/share/v2-result-share', () => ({
    v2ShareResultService: { loadPage: mocks.loadV2Page },
}));
vi.mock('@/lib/services/analysis/result-publication-authority', () => ({
    isAnalysisResultAuthoritativelyPublished: mocks.isResultAuthoritativelyPublished,
}));

import { GET as sharedResult } from '@/app/api/share/[token]/route';

const requestId = '223e4567-e89b-42d3-a456-426614174000';
const userId = '123e4567-e89b-42d3-a456-426614174000';
const token = 'a'.repeat(64);
const IMAGE_SECRET = 'test-image-proxy-signing-secret-at-least-32-characters';

/* The bio the database still holds for these rows. Nothing in the response may
   carry it, in any field, under any name. */
const SUSPECT_BIO = '강남 OO치과 위생사 · 한국대 21학번 · 본계 @suspect.private';

/* Supabase query builders are thenable: the route awaits the results and
   private-account queries directly, with no terminal .single() to hang a
   resolved value off. */
function queryChain(response: { data: unknown; error: unknown }) {
    const chain = {
        select: vi.fn(),
        eq: vi.fn(),
        order: vi.fn(),
        single: vi.fn(),
        then: vi.fn(),
    };
    chain.select.mockReturnValue(chain);
    chain.eq.mockReturnValue(chain);
    chain.order.mockReturnValue(chain);
    chain.single.mockResolvedValue(response);
    chain.then.mockImplementation((
        onFulfilled: (value: typeof response) => unknown,
        onRejected?: (reason: unknown) => unknown
    ) => Promise.resolve(response).then(onFulfilled, onRejected));
    return chain;
}

function installLegacyShare() {
    const requests = queryChain({
        data: {
            id: requestId,
            user_id: userId,
            pipeline_version: 'v1',
            status: 'completed',
            share_token: token,
            share_enabled: true,
            target_instagram_id: 'target.account',
            mutual_follows: 2,
            gender_stats: { male: 1, female: 1, unknown: 0 },
            step_data: { mutualFollows: ['suspect.one', 'suspect.two'] },
        },
        error: null,
    });
    const results = queryChain({
        data: [
            {
                rank: 1,
                suspect_instagram_id: 'suspect.one',
                suspect_profile_image: 'https://scontent.cdninstagram.com/suspect-one.jpg',
                suspect_full_name: '김수연',
                bio: SUSPECT_BIO,
                risk_grade: 'high_risk',
                one_line_overview: '프로필과 최근 피드의 특징이 뚜렷한 공개 계정입니다.',
                risk_analysis: ['프로필과 피드는 꽤 눈에 띕니다.'],
            },
            {
                rank: 2,
                suspect_instagram_id: 'suspect.two',
                suspect_profile_image: null,
                suspect_full_name: null,
                bio: '서울 OO대 재학 · 취미는 클라이밍',
                risk_grade: 'normal',
                one_line_overview: '일상 기록과 공개 프로필의 흐름을 중심으로 정리한 계정입니다.',
                risk_analysis: null,
            },
        ],
        error: null,
    });
    const privateAccounts = queryChain({
        data: [
            {
                instagram_id: 'private.one',
                profile_image: null,
                full_name: '박지민',
                name_female_score: 0.9,
                name_confidence: 0.8,
            },
        ],
        error: null,
    });

    mocks.from.mockImplementation((table: string) => {
        if (table === 'analysis_requests') return requests;
        if (table === 'analysis_results') return results;
        if (table === 'private_accounts') return privateAccounts;
        throw new Error(`unexpected table ${table}`);
    });

    return { requests, results, privateAccounts };
}

function get() {
    return sharedResult(
        new Request(`https://example.com/api/share/${token}`),
        { params: Promise.resolve({ token }) },
    );
}

describe('legacy share payload privacy', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubEnv('IMAGE_PROXY_SIGNING_SECRET', IMAGE_SECRET);
        mocks.isResultAuthoritativelyPublished.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('never ships a suspect bio to an anonymous share reader', async () => {
        installLegacyShare();

        const response = await get();
        const body = await response.json();

        expect(response.status).toBe(200);
        expect(body.femaleAccounts).toHaveLength(2);
        /* A bio names workplaces, schools and other handles, so it identifies at
           least as readily as the name does — and the share view discards it, so
           every byte of it was shipped to readers and rendered for no one. An
           absent key is the assertion; `bio: ''` would pass a toEqual against an
           object that simply omits it. */
        for (const account of body.femaleAccounts) {
            expect(Object.keys(account)).not.toContain('bio');
        }
        // Nothing may smuggle it through under another name either.
        expect(JSON.stringify(body)).not.toContain(SUSPECT_BIO);
        expect(JSON.stringify(body)).not.toContain('클라이밍');
    });

    it('does not even read the bio column for a shared result', async () => {
        const { results } = installLegacyShare();

        await get();

        expect(results.select).toHaveBeenCalledTimes(1);
        const selected = results.select.mock.calls[0][0] as string;
        expect(selected).toContain('suspect_instagram_id');
        expect(selected).toContain('one_line_overview');
        expect(selected).not.toMatch(/\bbio\b/);
    });

    it('still returns the fields the shared report is built from', async () => {
        installLegacyShare();

        const body = await (await get()).json();

        expect(body.femaleAccounts[0]).toEqual({
            instagramId: 'suspect.one',
            fullName: '김수연',
            profileImage: expect.stringMatching(/^\/api\/image-proxy\?/),
            instagramUrl: 'https://instagram.com/suspect.one',
            riskGrade: 'high_risk',
            recentMutualRank: 1,
            oneLineOverview: '프로필과 최근 피드의 특징이 뚜렷한 공개 계정입니다.',
            riskAnalysis: [],
        });
        expect(body.femaleAccounts[1]).toMatchObject({
            instagramId: 'suspect.two',
            oneLineOverview: '일상 기록과 공개 프로필의 흐름을 중심으로 정리한 계정입니다.',
            riskGrade: 'normal',
            riskAnalysis: [],
        });
        expect(body.summary).toMatchObject({
            targetInstagramId: 'target.account',
            mutualFollows: 2,
        });
        expect(body.privateAccounts).toEqual([
            {
                instagramId: 'private.one',
                fullName: '박지민',
                profileImage: undefined,
                instagramUrl: 'https://instagram.com/private.one',
            },
        ]);
    });
});
