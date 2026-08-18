import { describe, expect, it } from 'vitest';
import {
    buildCanonicalConciergeResult,
    deriveConciergePrivacyPartition,
    targetPostMentionEvidenceFromStepData,
    validateCanonicalConciergeCorrection,
} from './concierge-basic-correction';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';
import type { ReplayAccountAiDetail } from './replay/replay-runner';
import { isRiskBandCompatibleWithDisplayScore } from '@/lib/domain/analysis/risk-policy';

function profile(username: string, isPrivate: boolean) {
    return {
        username,
        bio: '여행 기록',
        followersCount: 10,
        followingCount: 10,
        postsCount: 0,
        isPrivate,
        isVerified: false,
        latestPosts: [],
    };
}

function relationship(username: string, side: 'follower' | 'following', isPrivate: boolean, ordinal: number) {
    return { username, side, isPrivate, isVerified: false, fullName: null, ordinal };
}

function femaleDetail(ordinal: number, username: string, overview: string, appearanceGrade: 1 | 3 | 5): ReplayAccountAiDetail {
    return {
        ordinal,
        finalClassification: 'verified_female',
        classificationSource: 'feature',
        featureOverview: overview,
        triage: null,
        feature: {
            features: {
                gender: 'female',
                genderConfidence: 'high',
                ownerConsistency: 'same_person',
                appearanceGrade,
                exposureScore: appearanceGrade === 5 ? 5 : appearanceGrade === 3 ? 2 : 0,
                businessClassification: 'personal',
                businessConfidence: 'high',
                accountContext: 'personal',
                marriageEvidence: 'none',
                partnerEvidence: 'none',
                partnerExclusionContext: 'none',
                evidenceSelectionIds: {
                    gender: [],
                    appearance: [],
                    exposure: [],
                    business: [],
                    accountContext: [],
                    marriagePartner: [],
                },
                oneLineOverview: overview,
            },
            finalGenderDecision: 'verified_female',
            analyzedSelectionIds: [],
        } as FeatureAnalysisResult,
    };
}

describe('concierge basic correction', () => {
    it('accepts private-name results keyed by the concierge analyzer username identity', () => {
        const privateProfile = {
            ...profile('private.one', true),
            fullName: '박민지',
        };

        expect(() => buildCanonicalConciergeResult({
            targetUsername: 'target',
            profilesByOrdinal: new Map(),
            details: [],
            orderedMutualUsernames: ['private.one'],
            targetInteractions: [],
            targetPosts: [],
            privateProfiles: [privateProfile],
            privateNameResults: [{
                id: privateProfile.username,
                femaleScore: 0.8,
                isName: true,
                confidence: 0.9,
            }],
        })).not.toThrow();
    });

    it('orders private-name ties like the live publication RPC collation', () => {
        const dotted = { ...profile('a.b', true), fullName: '도트' };
        const underscored = { ...profile('a_b', true), fullName: '언더스코어' };
        const result = buildCanonicalConciergeResult({
            targetUsername: 'target',
            profilesByOrdinal: new Map(),
            details: [],
            orderedMutualUsernames: ['a.b', 'a_b'],
            targetInteractions: [],
            targetPosts: [],
            privateProfiles: [dotted, underscored],
            privateNameResults: [
                { id: 'a.b', femaleScore: 0.8, isName: true, confidence: 0.9 },
                { id: 'a_b', femaleScore: 0.8, isName: true, confidence: 0.9 },
            ],
        });

        expect(result.privateRows.map(row => row.instagram_id)).toEqual(['a_b', 'a.b']);
    });

    it('uses the concierge sparse-copy contract when a retained profile has no text evidence', () => {
        const sparseProfile = {
            ...profile('public.one', false),
            bio: undefined,
            fullName: '박민지',
            postsCount: 0,
            latestPosts: [],
        };

        const result = buildCanonicalConciergeResult({
            targetUsername: 'target',
            targetFullName: '김준호',
            profilesByOrdinal: new Map([[1, sparseProfile]]),
            details: [femaleDetail(1, sparseProfile.username, '공개 계정의 특징을 중심으로 정리한 계정입니다.', 1)],
            orderedMutualUsernames: [sparseProfile.username],
            targetInteractions: [],
            targetPosts: [],
            privateProfiles: [],
        });

        expect(result.femaleRows[0]?.one_line_overview).toContain('박민지님');
        expect(result.femaleRows[0]?.one_line_overview).toContain('소개·캡션 문구가 비어 있어');
    });

    it('keeps a no-text profile publishable without inventing an identifier in sparse copy', () => {
        const sparseProfile = {
            ...profile('public.one', false),
            bio: undefined,
            fullName: undefined,
            postsCount: 0,
            latestPosts: [],
        };

        const result = buildCanonicalConciergeResult({
            targetUsername: 'target',
            targetFullName: '김준호',
            profilesByOrdinal: new Map([[1, sparseProfile]]),
            details: [femaleDetail(1, sparseProfile.username, '공개 계정의 특징을 중심으로 정리한 계정입니다.', 1)],
            orderedMutualUsernames: [sparseProfile.username],
            targetInteractions: [],
            targetPosts: [],
            privateProfiles: [],
        });

        expect(result.femaleRows[0]?.one_line_overview).toBe('공개된 소개·캡션 문구가 비어 있어, 사진에서 이야기를 지어내지 않고 확인되는 범위만 차분히 읽어봅니다.');
        expect(result.femaleRows[0]?.one_line_overview).not.toContain('public.one');
    });

    it('keeps bounded Gemini overview wording when retained text is present', () => {
        const retainedProfile = {
            ...profile('public.one', false),
            bio: '주말마다 전시와 커피를 기록합니다',
        };
        const generatedOverview = '공개 프로필에 담긴 전시 기록을 바탕으로 계정의 분위기와 흐름을 차분하게 정리한 결과입니다.';

        const result = buildCanonicalConciergeResult({
            targetUsername: 'target',
            profilesByOrdinal: new Map([[1, retainedProfile]]),
            details: [femaleDetail(1, retainedProfile.username, generatedOverview, 1)],
            orderedMutualUsernames: [retainedProfile.username],
            targetInteractions: [],
            targetPosts: [],
            privateProfiles: [],
        });

        expect(result.femaleRows[0]?.one_line_overview).toBe(generatedOverview);
    });

    it('keeps a no-interaction row bounded when no risk narrative is required', () => {
        const retainedProfile = {
            ...profile('public.one', false),
            fullName: '박민지',
            bio: '주말마다 전시와 커피를 기록합니다',
        };

        const result = buildCanonicalConciergeResult({
            targetUsername: 'target',
            targetFullName: '김준호',
            profilesByOrdinal: new Map([[1, retainedProfile]]),
            details: [femaleDetail(1, retainedProfile.username, '공개 프로필과 피드에서 확인된 특징을 중심으로 정리한 계정입니다.', 5)],
            orderedMutualUsernames: [retainedProfile.username],
            targetInteractions: [],
            targetPosts: [],
            privateProfiles: [],
        });

        const row = result.femaleRows[0]!;
        expect(row.risk_grade).toBe('normal');
        expect(row.risk_analysis).toHaveLength(0);
    });

    it('uses text-present sparse copy when retained text has no extractable evidence term', () => {
        const retainedProfile = {
            ...profile('public.one', false),
            fullName: '박민지',
            bio: '123',
        };

        const result = buildCanonicalConciergeResult({
            targetUsername: 'target',
            targetFullName: '김준호',
            profilesByOrdinal: new Map([[1, retainedProfile]]),
            details: [femaleDetail(1, retainedProfile.username, '공개 계정의 특징을 중심으로 정리한 계정입니다.', 1)],
            orderedMutualUsernames: [retainedProfile.username],
            targetInteractions: [],
            targetPosts: [],
            privateProfiles: [],
        });

        expect(result.femaleRows[0]?.one_line_overview).toBe(
            '보존된 공개 소개·캡션 문구를 바탕으로 확인 가능한 기록의 범위만 차분히 읽어봅니다.',
        );
    });

    it('persists canonical overviews for normal and caution rows without replacing high-risk narratives', () => {
        const overviews = Array.from({ length: 10 }, (_, index) => (
            `${['첫', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열'][index]} 번째 공개 계정의 기록과 분위기를 중심으로 정리한 계정입니다.`
        ));
        const profiles = overviews.map((_, index) => profile(`female.${index + 1}`, false));
        const result = buildCanonicalConciergeResult({
            targetUsername: 'target',
            profilesByOrdinal: new Map(profiles.map((account, index) => [
                index + 1,
                account,
            ])),
            details: overviews.map((overview, index) => femaleDetail(
                index + 1,
                `female.${index + 1}`,
                overview,
                index === 0 ? 5 : index === 1 ? 3 : 1,
            )),
            orderedMutualUsernames: profiles.map(account => account.username),
            targetInteractions: profiles.map(account => ({
                actorUsername: account.username,
                postId: 'target-post-1',
                signal: 'target_post_like' as const,
                sourceInteractionId: `like-${account.username}`,
            })),
            targetPosts: [],
            privateProfiles: [],
        });

        expect(result.femaleRows).toHaveLength(10);
        for (const row of result.femaleRows) {
            expect(row.one_line_overview).toBeTruthy();
            expect(row.one_line_overview).toHaveLength(
                overviews.find(overview => overview === row.one_line_overview)?.length
                    ?? row.one_line_overview.length,
            );
            if (row.risk_grade === 'high_risk') {
                expect(row.risk_analysis).toHaveLength(2);
            } else {
                expect(row.risk_analysis).toHaveLength(0);
            }
        }
        expect(result.femaleRows.some(row => row.risk_grade === 'normal')).toBe(true);
        expect(result.femaleRows.some(row => row.risk_grade === 'caution')).toBe(true);
        expect(result.femaleRows.some(row => row.risk_grade === 'high_risk')).toBe(true);
        expect(result.femaleRows.every(row => (
            Number.isFinite(row.risk_score)
            && Number.isSafeInteger(row.risk_score)
            && isRiskBandCompatibleWithDisplayScore(row.risk_score / 10, row.risk_grade)
        ))).toBe(true);
        expect(result.femaleRows.some((row, index, rows) => rows.some(other => (
            other !== row
            && other.risk_grade === row.risk_grade
            && other.risk_score !== row.risk_score
        )))).toBe(true);
    });

    it('gives high-risk rows canonical names and treats reliable appearance as context, not proof', () => {
        const candidate = {
            ...profile('female.1', false),
            fullName: '박민지',
            profilePicUrl: 'https://example.com/candidate.jpg',
            latestPosts: [{
                id: 'post-1', shortCode: 'post1', caption: '성수 전시 관람', type: 'image' as const,
                imageUrl: 'https://example.com/post.jpg', likesCount: 0, commentsCount: 0,
                timestamp: '2026-08-12T00:00:00.000Z', taggedUsers: [], mentionedUsers: [],
            }],
        };
        const otherProfiles = Array.from({ length: 9 }, (_, index) => (
            profile(`female.${index + 2}`, false)
        ));
        const allProfiles = [candidate, ...otherProfiles];
        const result = buildCanonicalConciergeResult({
            targetUsername: 'target.user',
            targetFullName: '김준호',
            profilesByOrdinal: new Map(allProfiles.map((account, index) => [index + 1, account])),
            details: allProfiles.map((account, index) => femaleDetail(
                index + 1,
                account.username,
                index === 0
                    ? '성수 전시 기록이 이어져, 관람 취향이 자연스럽게 드러나는 피드입니다.'
                    : `${index + 1}번째 공개 계정의 여행 기록이 남아 있습니다.`,
                index === 0 ? 5 : 1,
            )),
            orderedMutualUsernames: allProfiles.map(account => account.username),
            targetInteractions: allProfiles.flatMap((account, profileIndex) => Array.from(
                { length: profileIndex === 0 ? 5 : 1 },
                (_, interactionIndex) => ({
                    actorUsername: account.username,
                    postId: `target-post-${profileIndex + 1}-${interactionIndex + 1}`,
                    signal: 'target_post_like' as const,
                    sourceInteractionId: `like-${account.username}-${interactionIndex + 1}`,
                }),
            )),
            targetPosts: [],
            privateProfiles: [],
        });

        const narrative = result.femaleRows.find(row => row.risk_grade === 'high_risk')?.risk_analysis;
        expect(narrative).toBeDefined();
        expect(narrative?.join(' ')).toContain('박민지님이 김준호님 게시물에 좋아요를 남긴 흐름');
        expect(narrative?.join(' ')).toContain('사진이 관계 설명서를 써주지는 않습니다');
        expect(narrative?.join(' ')).not.toContain('위장여사친');
        expect(narrative?.join(' ')).not.toMatch(/(?:대상\s*계정|후보\s*계정)/u);
    });

    it('preserves target-to-candidate mention signals from exact target post evidence', () => {
        const profiles = [profile('female.1', false)];
        const detail = femaleDetail(
            1,
            'female.1',
            '공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정입니다.',
            1,
        );
        const baseInput = {
            targetUsername: 'target',
            profilesByOrdinal: new Map([[1, profiles[0]!]]),
            details: [detail],
            orderedMutualUsernames: ['female.1'],
            targetInteractions: [],
            privateProfiles: [],
        };
        const withoutMention = buildCanonicalConciergeResult({ ...baseInput, targetPosts: [] });
        const withMention = buildCanonicalConciergeResult({
            ...baseInput,
            targetPosts: [{ taggedUsers: [], mentionedUsers: ['female.1'] }],
        });
        expect(withMention.femaleRows[0]!.risk_score)
            .toBeGreaterThan(withoutMention.femaleRows[0]!.risk_score);
    });

    it('carries collected target-post like/comment evidence into a verified-female row\'s likes_count and intimate_comments_count', () => {
        // Regression: this exact combination (a verified-female candidate who
        // also appears in the collected target-post interaction evidence) had
        // no fixture before, and likes_count/intimate_comments_count were
        // never asserted directly by any existing test.
        const likedOnly = profile('liked.only', false);
        const commentedOnly = profile('commented.only', false);
        const both = profile('both.signals', false);
        const noEvidence = profile('no.evidence', false);
        const profiles = [likedOnly, commentedOnly, both, noEvidence];
        const result = buildCanonicalConciergeResult({
            targetUsername: 'target',
            profilesByOrdinal: new Map(profiles.map((account, index) => [index + 1, account])),
            details: profiles.map((account, index) => femaleDetail(
                index + 1,
                account.username,
                `${index + 1}번째 공개 계정의 기록이 남아 있는 계정입니다.`,
                1,
            )),
            orderedMutualUsernames: profiles.map(account => account.username),
            targetInteractions: [
                {
                    actorUsername: 'liked.only',
                    postId: 'target-post-1',
                    signal: 'target_post_like' as const,
                    sourceInteractionId: 'like-liked-only-1',
                },
                {
                    actorUsername: 'commented.only',
                    postId: 'target-post-1',
                    signal: 'target_post_comment' as const,
                    sourceInteractionId: 'comment-commented-only-1',
                    content: '너무 예쁘세요',
                },
                {
                    actorUsername: 'both.signals',
                    postId: 'target-post-1',
                    signal: 'target_post_like' as const,
                    sourceInteractionId: 'like-both-1',
                },
                {
                    actorUsername: 'both.signals',
                    postId: 'target-post-2',
                    signal: 'target_post_like' as const,
                    sourceInteractionId: 'like-both-2',
                },
                {
                    actorUsername: 'both.signals',
                    postId: 'target-post-1',
                    signal: 'target_post_comment' as const,
                    sourceInteractionId: 'comment-both-1',
                    content: '저도 가고 싶어요',
                },
            ],
            targetPosts: [],
            privateProfiles: [],
        });

        const rowByUsername = new Map(result.femaleRows.map(row => [row.suspect_instagram_id, row]));
        expect(rowByUsername.get('liked.only')).toMatchObject({ likes_count: 1, intimate_comments_count: 0 });
        expect(rowByUsername.get('commented.only')).toMatchObject({ likes_count: 0, intimate_comments_count: 1 });
        expect(rowByUsername.get('both.signals')).toMatchObject({ likes_count: 2, intimate_comments_count: 1 });
        expect(rowByUsername.get('no.evidence')).toMatchObject({ likes_count: 0, intimate_comments_count: 0 });
    });

    it('accepts the canonical target-post checkpoint while preserving optional mention evidence', () => {
        expect(targetPostMentionEvidenceFromStepData({
            targetPosts: [{ id: 'post-1', taggedUsers: ['female.1'], mentionedUsers: [] }],
        })).toEqual([{ taggedUsers: ['female.1'], mentionedUsers: [] }]);
        expect(targetPostMentionEvidenceFromStepData({
            targetPosts: [{ id: 'post-1' }],
        })).toEqual([{ taggedUsers: [], mentionedUsers: [] }]);
    });

    it('derives privacy from profile and both relationship sides instead of defaulting public', () => {
        const partition = deriveConciergePrivacyPartition({
            profiles: [profile('public.one', false), profile('private.one', true)],
            relationshipRows: [
                relationship('public.one', 'follower', false, 1),
                relationship('private.one', 'follower', true, 2),
                relationship('public.one', 'following', false, 1),
                relationship('private.one', 'following', true, 2),
            ],
        });

        expect(partition.publicProfiles.map(row => row.username)).toEqual(['public.one']);
        expect(partition.privateProfiles.map(row => row.username)).toEqual(['private.one']);
        expect(partition.orderedMutualUsernames).toEqual(['public.one', 'private.one']);
    });

    it('fails closed when relationship privacy disagrees with the collected profile', () => {
        expect(() => deriveConciergePrivacyPartition({
            profiles: [profile('conflict', true)],
            relationshipRows: [
                relationship('conflict', 'follower', false, 1),
                relationship('conflict', 'following', false, 1),
            ],
        })).toThrow('CONCIERGE_PRIVACY_PROVIDER_EVIDENCE_CONFLICT');
    });

    it('uses the collected profile state when one retained relationship side is absent', () => {
        const partition = deriveConciergePrivacyPartition({
            profiles: [profile('public.one', false), profile('private.one', true)],
            relationshipRows: [
                relationship('public.one', 'follower', false, 1),
                relationship('private.one', 'following', true, 2),
            ],
        });

        expect(partition.publicProfiles).toHaveLength(1);
        expect(partition.privateProfiles).toHaveLength(1);
    });

    it('requires reconciled gender totals and canonical narratives for high-risk rows', () => {
        const result = {
            femaleRows: [{
                risk_score: 70,
                risk_grade: 'high_risk',
                one_line_overview: '공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정입니다.',
                risk_analysis: ['첫 문장', '둘째 문장'],
            }],
            privateRows: [],
            counts: { male: 1, female: 1, unknownPublic: 0, unknown: 0 },
        } as never;
        expect(() => validateCanonicalConciergeCorrection({
            fetchedCount: 3,
            partition: {
                publicProfiles: [profile('one', false), profile('two', false)],
                privateProfiles: [profile('private', true)],
            },
            result,
        })).not.toThrow();
        expect(() => validateCanonicalConciergeCorrection({
            fetchedCount: 4,
            partition: {
                publicProfiles: [profile('one', false), profile('two', false)],
                privateProfiles: [],
            },
            result,
        })).toThrow('CONCIERGE_COUNT_RECONCILIATION_FAILED');
    });

    it('rejects a ranked normal or caution row without its canonical overview', () => {
        const result = {
            femaleRows: [{ risk_score: 50, risk_grade: 'caution', risk_analysis: [] }],
            privateRows: [],
            counts: { male: 0, female: 1, unknownPublic: 0, unknown: 0 },
        } as never;
        expect(() => validateCanonicalConciergeCorrection({
            fetchedCount: 1,
            partition: {
                publicProfiles: [profile('public.one', false)],
                privateProfiles: [],
            },
            result,
        })).toThrow('CONCIERGE_OVERVIEW_REQUIRED');
    });

    it('rejects non-finite or grade-incompatible persisted risk scores', () => {
        const baseResult = {
            femaleRows: [{
                risk_score: 43,
                risk_grade: 'caution',
                one_line_overview: '공개 프로필과 최근 피드의 특징을 중심으로 정리한 계정입니다.',
                risk_analysis: [],
            }],
            privateRows: [],
            counts: { male: 0, female: 1, unknownPublic: 0, unknown: 0 },
        };
        const correction = {
            fetchedCount: 1,
            partition: { publicProfiles: [profile('public.one', false)], privateProfiles: [] },
        };

        expect(() => validateCanonicalConciergeCorrection({
            ...correction,
            result: {
                ...baseResult,
                femaleRows: [{ ...baseResult.femaleRows[0]!, risk_score: Number.POSITIVE_INFINITY }],
            } as never,
        })).toThrow('CONCIERGE_RISK_SCORE_INVALID');
        expect(() => validateCanonicalConciergeCorrection({
            ...correction,
            result: {
                ...baseResult,
                femaleRows: [{ ...baseResult.femaleRows[0]!, risk_score: 67, risk_grade: 'normal' }],
            } as never,
        })).toThrow('CONCIERGE_RISK_SCORE_GRADE_MISMATCH');
    });

    it('keeps missing exact-mutual hydration outside privacy and gender totals', () => {
        const partition = deriveConciergePrivacyPartition({
            profiles: [profile('public.one', false)],
            relationshipRows: [
                relationship('public.one', 'follower', false, 1),
                relationship('unknown.one', 'follower', false, 2),
                relationship('public.one', 'following', false, 1),
                relationship('unknown.one', 'following', false, 2),
            ],
            requireExactMutual: true,
        });
        expect(partition.publicProfiles).toHaveLength(1);
        expect(partition.privateProfiles).toHaveLength(0);
        expect(partition.unresolvedUsernames).toEqual(['unknown.one']);
        const result = {
            femaleRows: [],
            privateRows: [],
            counts: { male: 0, female: 0, unknownPublic: 1, unknown: 1 },
        } as never;
        expect(() => validateCanonicalConciergeCorrection({
            fetchedCount: 2,
            partition,
            result,
        })).not.toThrow();
    });
});
