import {
    derivePrecheckoutBliteSignalBand,
    precheckoutBliteV1Schema,
    type PrecheckoutBliteV1,
} from '@/lib/services/precheckout/blite-contract';

/** Synthetic display input only: no source profiles, persistence, or analysis execution. */
export function createDevUiPrecheckoutPresentation(): PrecheckoutBliteV1 {
    return precheckoutBliteV1Schema.parse({
        schemaVersion: 1,
        persona: {
            headline: '합성 프로필의 관계 신호 미리보기',
            summary: '화면 검증을 위한 합성 단서로 구성된 미리보기입니다.',
        },
        signals: [
            { category: '관계 노출 성향', claim: '합성된 태그 패턴으로 관계 노출 화면을 재현합니다.', confidence: 0.82 },
            { category: '게시 습관', claim: '합성된 게시물 구성으로 판독 신호를 표시합니다.', confidence: 0.62 },
            { category: '게시 습관', claim: '합성된 표현의 차이를 낮은 강도의 신호로 표시합니다.', confidence: 0.35 },
            { category: '소통 성향', claim: '합성된 댓글 패턴으로 소통 신호를 표시합니다.', confidence: 0.71 },
        ].map(signal => ({ ...signal, band: derivePrecheckoutBliteSignalBand(signal.confidence) })),
        candidateRange: { min: 3, max: 9 },
        genderRead: {
            likelyFemale: true,
            confidence: 0.84,
            reasons: [
                '합성 프로필 신호로 성별 확인 화면을 재현합니다.',
                '합성 게시물 표현으로 확인 단계를 검증합니다.',
                '실제 계정의 성별을 판정한 결과가 아닙니다.',
            ],
        },
        postCount: 8,
        evidenceFields: ['post.caption', 'post.hashtags', 'post.taggedUsers'],
    });
}
