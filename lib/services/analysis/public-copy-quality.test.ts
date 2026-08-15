import { describe, expect, it } from 'vitest';
import {
    buildV211EvidenceSpecificOverview,
    buildV211EvidenceSpecificRiskNarrative,
    isForbiddenV211Overview,
    isForbiddenV211RiskNarrative,
    areMateriallyNearDuplicatePublicCopies,
    validateV211PublicCopyRows,
} from './public-copy-quality';

describe('v2.11 concierge public-copy quality', () => {
    it('builds an overview from a concrete retained profile/feed fact', () => {
        const overview = buildV211EvidenceSpecificOverview({
            profileEvidence: '주말마다 전시와 커피를 기록합니다',
            feedEvidence: ['성수동 전시를 둘러본 오후', '콜드브루와 책을 곁들인 기록'],
            variation: 0,
        });

        expect(overview).toContain('전시');
        expect(overview).not.toBe(
            '사진과 소개에 드러난 개인 기록의 결이 선명해서, 피드가 보여 준 장면부터 차분히 짚어볼 계정입니다.',
        );
        expect(isForbiddenV211Overview(overview)).toBe(false);
        expect(overview).not.toMatch(/\d|@|https?:\/\//u);
    });

    it('fails closed when no concrete public evidence is retained', () => {
        expect(() => buildV211EvidenceSpecificOverview({
            profileEvidence: null,
            feedEvidence: [],
            variation: 0,
        })).toThrow('CONCIERGE_COPY_EVIDENCE_UNAVAILABLE');
    });

    it('rejects exact and materially near-duplicate copy but permits distinct evidence', () => {
        const first = '전시와 커피 장면이 이어져 일상에서 건져 올린 취향의 결이 선명한 피드입니다.';
        const near = '전시와 커피 장면이 이어져 일상에서 건져 올린 취향의 결이 또렷한 피드입니다.';
        const distinct = '바닷가 산책과 노을 기록이 이어져 느긋한 하루의 흐름이 드러나는 피드입니다.';

        expect(areMateriallyNearDuplicatePublicCopies(first, first)).toBe(true);
        expect(areMateriallyNearDuplicatePublicCopies(first, near)).toBe(true);
        expect(areMateriallyNearDuplicatePublicCopies(first, distinct)).toBe(false);
    });

    it('builds a concrete two-line high-risk narrative with observed interactions', () => {
        const lines = buildV211EvidenceSpecificRiskNarrative({
            profileEvidence: '주말 전시와 커피 기록',
            feedEvidence: ['성수동 전시를 둘러본 오후'],
            candidateLikedTarget: true,
            candidateCommentedOnTarget: true,
            targetLikedCandidate: false,
            candidateTaggedTarget: true,
            targetTaggedCandidate: false,
            commentText: '다음 전시도 같이 보자',
        });

        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain('전시');
        expect(lines[1]).toContain('후보가 대상 게시물에 남긴 좋아요');
        expect(lines[1]).toContain('댓글의 “다음” 표현');
        expect(lines[1]).toContain('태그 표기');
        expect(lines[1]).toContain('수집 표본 밖');
        expect(isForbiddenV211RiskNarrative(lines)).toBe(false);
    });

    it('keeps candidate-to-target and target-to-candidate evidence directional', () => {
        const lines = buildV211EvidenceSpecificRiskNarrative({
            profileEvidence: '주말 전시와 커피 기록',
            feedEvidence: ['성수동 전시를 둘러본 오후'],
            candidateLikedTarget: true,
            candidateCommentedOnTarget: false,
            targetLikedCandidate: true,
            targetCommentedOnCandidate: true,
        });

        expect(lines[1]).toContain('서로 남긴 좋아요 흔적');
        expect(lines[1]).toContain('대상 계정이 후보 피드에 남긴 댓글 내용');
        expect(lines[1]).toContain('수집 표본 밖');
    });

    it('does not allow generic fallback copy to pass final v2.11 validation', () => {
        const genericOverview = '사진과 소개에 드러난 개인 기록의 결이 선명해서, 피드가 보여 준 장면부터 차분히 짚어볼 계정입니다.';
        const genericNarrative = [
            '공개 프로필과 최근 피드, 맞팔 흐름은 눈에 띄어야 할 재료를 꽤 성실하게 쌓아 두었습니다.',
            '관측 표본에서 공개 상호작용을 확정할 재료는 제한적이며, 표본 밖 기록도 없다고 순진하게 믿을 근거는 없습니다.',
        ];
        expect(isForbiddenV211Overview(genericOverview)).toBe(true);
        expect(isForbiddenV211RiskNarrative(genericNarrative)).toBe(true);
        expect(() => validateV211PublicCopyRows({
            rows: [{
                oneLineOverview: genericOverview,
                riskGrade: 'high_risk',
                riskAnalysis: genericNarrative,
                profileEvidence: '전시와 커피 기록',
                feedEvidence: ['성수동 전시'],
                candidateLikedTarget: true,
                candidateCommentedOnTarget: false,
                targetLikedCandidate: false,
                candidateTaggedTarget: false,
                targetTaggedCandidate: false,
            }],
        })).toThrow('CONCIERGE_COPY_GENERIC_FORBIDDEN');
    });
});
