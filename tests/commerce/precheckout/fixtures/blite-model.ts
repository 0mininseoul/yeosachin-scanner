export function validModelResponse() {
    return {
        persona: {
            headline: '관계를 자주 드러내는 활발한 소통형 계정',
            summary: '최근 게시물에서 태그와 멘션을 자주 활용하는 편이에요. 참고용 페르소나이며 확정적인 결론은 아니에요.',
        },
        signals: [
            { claim: '태그된 사람과의 관계를 자주 드러내는 편이에요.', category: '관계 노출 성향', confidence: 0.82 },
            { claim: '캐러셀 게시물을 자주 활용해요.', category: '게시 습관', confidence: 0.62 },
            { claim: '해시태그 사용이 적은 편이에요.', category: '게시 습관', confidence: 0.35 },
            { claim: '댓글 반응을 유도하는 캡션을 자주 써요.', category: '소통 성향', confidence: 0.71 },
        ],
        genderRead: {
            likelyFemale: true,
            confidence: 0.81,
            reasons: [
                '캡션 어투가 여성형 표현에 가까워요.',
                '태그된 계정 구성이 여성형 이름에 가까워요.',
                '게시물 주제가 여성형 관심사에 가까워요.',
            ],
        },
    };
}
