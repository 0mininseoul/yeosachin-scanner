import { describe, expect, it, vi } from 'vitest';
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

function cursor(list: 'public' | 'private') {
    return encodeResultCursor({
        version: 1,
        list,
        direction: 'asc',
        sortKeyType: 'number',
        sortKey: 1,
        candidateId: `candidate:${list}`,
    });
}

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
    it('builds revocable share-token-bound image paths without request ids', () => {
        expect(createV2ShareImagePath(token, {
            requestId,
            kind: 'target',
            candidateId: null,
        })).toBe(`/api/share/${token}/image?kind=target`);
        expect(createV2ShareImagePath(token, {
            requestId,
            kind: 'female',
            candidateId: 'candidate:one',
        })).toBe(
            `/api/share/${token}/image?kind=female&candidateId=candidate%3Aone`
        );
        expect(() => createV2ShareImagePath('not-a-token', {
            requestId,
            kind: 'target',
            candidateId: null,
        })).toThrow('INVALID_V2_SHARE_IMAGE_INPUT');
    });

    it('returns an exact owner-equivalent DTO and forwards both cursors', async () => {
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

        await expect(service.loadPage({
            requestId,
            ownerUserId: userId,
            shareToken: token,
            femaleCursor: cursor('public'),
            privateCursor: cursor('private'),
            pageSize: 24,
        })).resolves.toEqual({
            ...page(),
            isShared: true,
        });
        expect(loadPage).toHaveBeenCalledWith({
            requestId,
            userId,
            femaleCursor: cursor('public'),
            privateCursor: cursor('private'),
            pageSize: 24,
        });
    });

    it('rejects malformed or cross-list cursors before reading the store', async () => {
        const createStore = vi.fn();
        const service = createV2ShareResultService({ createStore });

        await expect(service.loadPage({
            requestId,
            ownerUserId: userId,
            shareToken: token,
            femaleCursor: cursor('private'),
            privateCursor: null,
            pageSize: 24,
        })).rejects.toThrow('CURSOR_SCOPE_MISMATCH');
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
        expect(v2SharedResultPageSchema.safeParse({
            ...page(),
            isShared: true,
            internalEvidence: ['must-not-leak'],
        }).success).toBe(false);
    });
});
