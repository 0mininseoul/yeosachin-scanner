import { describe, expect, it } from 'vitest';
import {
    buildV211EvidenceSpecificRiskNarrative,
    buildV213ReviewedOverview,
    createV213ReviewRecord,
    validateV213FullReviewRows,
} from './public-copy-quality';

function reviewedEvidence(index: number) {
    return {
        profileEvidence: `독립서점 산책과 ${['도자기', '러닝', '영화', '베이킹'][index % 4]} 기록`,
        feedEvidence: [
            `${['성수', '한강', '연희', '망원'][index % 4]}에서 남긴 ${['전시', '산책', '책', '커피'][index % 4]} 장면`,
            `${['주말', '퇴근길', '오후', '비 오는 날'][index % 4]}의 ${['드로잉', '요리', '여행', '공연'][index % 4]} 기록`,
        ],
        structuralEvidence: ['사진 게시물 화면 구성'],
    };
}

describe('v2.13 concierge full public-copy review', () => {
    it('rebuilds all sixteen reviewed overviews with distinct structures and evidence-grounded semantic records', () => {
        const rows = Array.from({ length: 16 }, (_, index) => {
            const evidence = reviewedEvidence(index);
            const composition = buildV213ReviewedOverview({ ...evidence, reviewOrdinal: index });
            const isHighRisk = index < 2;
            const riskAnalysis = isHighRisk
                ? buildV211EvidenceSpecificRiskNarrative({
                    ...evidence,
                    subjects: {
                        targetUsername: 'target.user',
                        targetFullName: '김준호',
                        candidateUsername: `candidate.${index + 1}`,
                        candidateFullName: `후보${index + 1}`,
                    },
                    candidateLikedTarget: index === 0,
                    candidateCommentedOnTarget: index === 1,
                    targetLikedCandidate: false,
                    candidateTaggedTarget: false,
                    appearance: { isReliable: index === 0 },
                })
                : [];
            const previousOverview = `기존 ${index + 1}번 행의 문구는 이번 전체 검토에서 바뀌어야 합니다.`;
            return {
                rank: index + 1,
                ...evidence,
                ...composition,
                oneLineOverview: composition.overview,
                previousOverview,
                riskGrade: isHighRisk ? 'high_risk' : 'normal',
                riskAnalysis,
                candidateLikedTarget: index === 0,
                candidateCommentedOnTarget: index === 1,
                targetLikedCandidate: false,
                candidateTaggedTarget: false,
                targetTaggedCandidate: false,
                subjects: {
                    targetUsername: 'target.user',
                    targetFullName: '김준호',
                    candidateUsername: `candidate.${index + 1}`,
                    candidateFullName: `후보${index + 1}`,
                },
                appearance: { isReliable: index === 0 },
                review: createV213ReviewRecord({
                    rank: index + 1,
                    previousOverview,
                    nextOverview: composition.overview,
                    overviewForm: composition.form,
                    evidenceTerms: composition.evidenceTerms,
                    previousRiskAnalysis: isHighRisk ? ['기존 서술 첫 줄', '기존 서술 둘째 줄'] : [],
                    nextRiskAnalysis: riskAnalysis,
                }),
            };
        });

        expect(() => validateV213FullReviewRows({ rows })).not.toThrow();
        expect(new Set(rows.map(row => row.oneLineOverview)).size).toBe(16);
        expect(new Set(rows.map(row => row.review.overviewForm)).size).toBeGreaterThanOrEqual(8);
        expect(rows.every(row => row.review.overviewChanged)).toBe(true);
    });

    it('uses names and observed directions in high-risk copy, while keeping appearance explicitly non-probative', () => {
        const narrative = buildV211EvidenceSpecificRiskNarrative({
            profileEvidence: '전시와 커피 기록',
            feedEvidence: ['성수 전시 관람 장면'],
            subjects: {
                targetUsername: 'target.user',
                targetFullName: '김준호',
                candidateUsername: 'candidate.user',
                candidateFullName: '박민지',
            },
            candidateLikedTarget: true,
            candidateCommentedOnTarget: false,
            targetLikedCandidate: false,
            candidateTaggedTarget: true,
            appearance: { isReliable: true },
        });

        expect(narrative.join(' ')).toContain('박민지님이 김준호님 게시물에 좋아요를 남긴 흐름');
        expect(narrative.join(' ')).toContain('박민지님이 김준호님을 태그한 흔적');
        expect(narrative.join(' ')).toContain('사진이 관계 설명서를 써주지는 않습니다');
        expect(narrative.join(' ')).not.toMatch(/(?:대상\s*계정|후보\s*계정|위장여사친)/u);
    });

    it('fails closed for structural-only evidence and labels a comment mention as a comment mention', () => {
        expect(() => buildV213ReviewedOverview({
            profileEvidence: null,
            feedEvidence: [],
            structuralEvidence: ['사진 게시물 화면 구성'],
            reviewOrdinal: 0,
        })).toThrow('CONCIERGE_COPY_EVIDENCE_UNAVAILABLE');

        const narrative = buildV211EvidenceSpecificRiskNarrative({
            feedEvidence: ['성수 전시 관람 장면'],
            subjects: {
                targetUsername: 'target.user',
                targetFullName: '김준호',
                candidateUsername: 'candidate.user',
                candidateFullName: '박민지',
            },
            candidateLikedTarget: false,
            candidateCommentedOnTarget: false,
            candidateCommentMentionedTarget: true,
            targetLikedCandidate: false,
        });

        expect(narrative[1]).toContain('박민지님이 김준호님을 댓글에서 멘션한 흔적');
        expect(narrative[1]).not.toContain('캡션');
    });
});
