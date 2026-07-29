import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AnalysisResultPageV1 } from '@/lib/contracts/analysis-v2';
import { encodeResultCursor } from '@/lib/domain/analysis/result-pagination';
import {
    createV2ShareImagePath,
    createV2ShareResultService,
    v2SharedResultPageSchema,
} from './v2-result-share';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const userId = '223e4567-e89b-42d3-a456-426614174000';
const token = 'a'.repeat(64);
const privacySecret = 'share-test-secret-'.repeat(3);

function page(): AnalysisResultPageV1 {
    return {
        schemaVersion: 1,
        requestId,
        summary: {
            targetInstagramId: 'target.user',
            targetFullName: '김준호',
            targetProfileImage: createV2ShareImagePath(token, {
                requestId,
                kind: 'target',
                candidateId: null,
            }),
            planId: 'standard',
            followers: {
                declared: 3,
                collected: 3,
                coverageRatio: 1,
                meetsCoverageGate: true,
                exactCountMatch: true,
            },
            following: {
                declared: 3,
                collected: 3,
                coverageRatio: 1,
                meetsCoverageGate: true,
                exactCountMatch: true,
            },
            detectedMutuals: 3,
            publicMutuals: 2,
            privateMutuals: 1,
            screenedMutuals: 2,
            genderStats: { male: 1, female: 1, unknown: 0 },
            notScreenedMutuals: 0,
            exclusionApplied: false,
            scorePolicyVersion: 'risk-policy-v2.4',
        },
        femaleAccounts: [{
            instagramId: 'visible.woman',
            fullName: '표시 이름',
            profileImage: createV2ShareImagePath(token, {
                requestId,
                kind: 'female',
                candidateId: 'candidate:one',
            }),
            bio: '공개 bio',
            displayScore: 8.1,
            riskBand: 'high_risk',
            featuredRank: 1,
            recentMutualRank: 2,
            analysisDepth: 'narrative',
            oneLineOverview: '구체적인 공개 총평',
            highRiskNarrative: [
                '공개 프로필과 최근 흐름은 굳이 눈에 띄지만, 단정할 근거는 아닙니다.',
                '좋아요 흔적은 제법 친절하지만 수집 범위 밖의 맥락까지 없다고 믿기는 이릅니다.',
            ],
        }],
        privateAccounts: [{
            instagramId: 'visible.private',
            fullName: '비공개 이름',
            profileImage: createV2ShareImagePath(token, {
                requestId,
                kind: 'private',
                candidateId: 'candidate:two',
            }),
        }],
        femaleNextCursor: encodeResultCursor({
            version: 1,
            list: 'public',
            direction: 'asc',
            sortKeyType: 'number',
            sortKey: 1,
            candidateId: 'candidate:one',
        }),
        privateNextCursor: null,
    };
}

describe('V2 shared result service', () => {
    beforeEach(() => {
        vi.stubEnv('IMAGE_PROXY_SIGNING_SECRET', privacySecret);
    });

    it('builds revocable share-token-bound image paths without raw candidate ids', () => {
        const targetPath = createV2ShareImagePath(token, {
            requestId,
            kind: 'target',
            candidateId: null,
        });
        const candidatePath = createV2ShareImagePath(token, {
            requestId,
            kind: 'female',
            candidateId: 'candidate:one',
        });

        expect(targetPath).toBe(`/api/share/${token}/image?kind=target`);
        expect(candidatePath).toMatch(
            new RegExp(`^/api/share/${token}/image\\?locator=[A-Za-z0-9_-]+$`)
        );
        expect(candidatePath).not.toContain('candidate');
        expect(() => createV2ShareImagePath('not-a-token', {
            requestId,
            kind: 'target',
            candidateId: null,
        })).toThrow('INVALID_V2_SHARE_IMAGE_INPUT');
    });

    it('returns a shared-only masked DTO while preserving public bio copy', async () => {
        const loadPage = vi.fn(async () => page());
        const service = createV2ShareResultService({
            createStore: imageProxySigner => {
                expect(imageProxySigner('ignored', {
                    requestId,
                    kind: 'female',
                    candidateId: 'candidate:one',
                })).toContain(`/api/share/${token}/image?`);
                return { loadPage };
            },
        });

        const shared = await service.loadPage({
            requestId,
            ownerUserId: userId,
            shareToken: token,
            pageSize: 24,
        });

        expect(shared).not.toBeNull();
        expect(shared?.femaleAccounts[0]).toMatchObject({
            handleMasked: expect.stringMatching(/^vi[^A-Za-z0-9._]+$/),
            fullNameMasked: expect.stringMatching(/^[^표시이름]+$/),
            bio: '공개 bio',
        });
        expect(shared?.privateAccounts[0]).toMatchObject({
            handleMasked: expect.stringMatching(/^vi[^A-Za-z0-9._]+$/),
            fullNameMasked: expect.stringMatching(/^[^비공개이름]+$/),
        });
        expect(shared?.femaleAccounts[0]?.accountKey).not.toBe(
            shared?.privateAccounts[0]?.accountKey
        );
        expect(shared?.femaleAccounts[0]).not.toHaveProperty('instagramId');
        expect(shared?.femaleAccounts[0]).not.toHaveProperty('fullName');
        expect(shared?.femaleAccounts[0]).not.toHaveProperty('instagramUrl');
        expect(shared?.privateAccounts[0]).not.toHaveProperty('instagramId');
        expect(shared?.privateAccounts[0]).not.toHaveProperty('fullName');
        expect(shared?.privateAccounts[0]).not.toHaveProperty('instagramUrl');

        const serialized = JSON.stringify(shared);
        for (const secretValue of [
            'visible.woman',
            'visible.private',
            '표시 이름',
            '비공개 이름',
            'candidate:one',
            'candidate:two',
        ]) {
            expect(serialized).not.toContain(secretValue);
        }
        expect(serialized).toContain('공개 bio');
        expect(loadPage).toHaveBeenCalledWith({
            requestId,
            userId,
            femaleCursor: undefined,
            privateCursor: undefined,
            pageSize: 24,
        });
    });

    it('wraps owner cursors in a share-token-bound opaque cursor', async () => {
        const ownerPage = page();
        const loadPage = vi.fn(async () => ownerPage);
        const service = createV2ShareResultService({
            createStore: () => ({ loadPage }),
        });

        const first = await service.loadPage({
            requestId,
            ownerUserId: userId,
            shareToken: token,
        });
        expect(first?.femaleNextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(first?.femaleNextCursor).not.toBe(ownerPage.femaleNextCursor);
        expect(JSON.stringify(first)).not.toContain('candidate:one');

        await service.loadPage({
            requestId,
            ownerUserId: userId,
            shareToken: token,
            femaleCursor: first?.femaleNextCursor,
        });
        expect(loadPage).toHaveBeenLastCalledWith({
            requestId,
            userId,
            femaleCursor: ownerPage.femaleNextCursor,
            privateCursor: undefined,
            pageSize: undefined,
        });

        await expect(service.loadPage({
            requestId,
            ownerUserId: userId,
            shareToken: 'b'.repeat(64),
            femaleCursor: first?.femaleNextCursor,
        })).rejects.toThrow('INVALID_CURSOR');
    });

    it('rejects malformed cursors before reading the store', async () => {
        const createStore = vi.fn();
        const service = createV2ShareResultService({ createStore });

        await expect(service.loadPage({
            requestId,
            ownerUserId: userId,
            shareToken: token,
            femaleCursor: 'not-a-cursor',
            privateCursor: null,
            pageSize: 24,
        })).rejects.toThrow('INVALID_CURSOR');
        expect(createStore).not.toHaveBeenCalled();
    });

    it('rejects DTO additions instead of silently leaking future fields', () => {
        const sharedShape = {
            schemaVersion: 1,
            requestId,
            summary: page().summary,
            femaleAccounts: [{
                accountKey: `account_${'a'.repeat(43)}`,
                handleMasked: 'vi••••',
                fullNameMasked: '•• ••',
                profileImage: null,
                bio: '공개 bio',
                displayScore: 8.1,
                riskBand: 'high_risk',
                featuredRank: 1,
                recentMutualRank: 2,
                analysisDepth: 'narrative',
                oneLineOverview: '구체적인 공개 총평',
                highRiskNarrative: [
                    '공개 프로필과 최근 흐름은 굳이 눈에 띄지만, 단정할 근거는 아닙니다.',
                    '좋아요 흔적은 제법 친절하지만 수집 범위 밖의 맥락까지 없다고 믿기는 이릅니다.',
                ],
            }],
            privateAccounts: [],
            femaleNextCursor: null,
            privateNextCursor: null,
            isShared: true,
        } as const;

        expect(v2SharedResultPageSchema.safeParse({
            ...sharedShape,
            internalEvidence: ['must-not-leak'],
        }).success).toBe(false);
        expect(v2SharedResultPageSchema.safeParse({
            ...sharedShape,
            femaleAccounts: [{
                ...sharedShape.femaleAccounts[0],
                instagramId: 'must.not.leak',
            }],
        }).success).toBe(false);
    });

    it('rejects a shared DTO that carries a raw candidate id image path', () => {
        const shared = {
            schemaVersion: 1,
            requestId,
            summary: page().summary,
            femaleAccounts: [{
                accountKey: `account_${'a'.repeat(43)}`,
                handleMasked: 'vi••••',
                fullNameMasked: '•• ••',
                profileImage:
                    `/api/share/${token}/image`
                    + '?kind=female&candidateId=candidate%3Aone',
                bio: '공개 bio',
                displayScore: 8.1,
                riskBand: 'high_risk',
                featuredRank: 1,
                recentMutualRank: 2,
                analysisDepth: 'narrative',
                oneLineOverview: '구체적인 공개 총평',
                highRiskNarrative: [
                    '공개 프로필과 최근 흐름은 굳이 눈에 띄지만, 단정할 근거는 아닙니다.',
                    '좋아요 흔적은 제법 친절하지만 수집 범위 밖의 맥락까지 없다고 믿기는 이릅니다.',
                ],
            }],
            privateAccounts: [],
            femaleNextCursor: null,
            privateNextCursor: null,
            isShared: true,
        };

        expect(v2SharedResultPageSchema.safeParse(shared).success).toBe(false);
    });
});
