import { describe, expect, it } from 'vitest';
import {
    buildCanonicalConciergeResult,
    deriveConciergePrivacyPartition,
    targetPostMentionEvidenceFromStepData,
    validateCanonicalConciergeCorrection,
} from './concierge-basic-correction';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';
import type { ReplayAccountAiDetail } from './replay/replay-runner';

function profile(username: string, isPrivate: boolean) {
    return {
        username,
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
            targetInteractions: [],
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
            femaleRows: [{ risk_grade: 'caution', risk_analysis: [] }],
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
