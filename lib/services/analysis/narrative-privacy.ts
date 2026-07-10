export const MAX_PUBLIC_RISK_NARRATIVE_LINES = 2;
export const MAX_PUBLIC_RISK_NARRATIVE_LINE_LENGTH = 180;

const definitiveAccusationPattern = /(?:바람(?:을)?\s*(?:피우고\s*있(?:다|는)|폈다|피웠다)|불륜\s*(?:이다|관계(?:다|이다)?|중(?:이다)?)|외도\s*(?:했다|중(?:이다)?|하고\s*있(?:다|는))|(?:연인|교제)\s*(?:이다|중(?:이다)?|관계(?:다|이다|로\s*확정))|사귀고\s*있(?:다|는))/u;
const interactionTermPattern = /(?:좋아요|댓글|상호작용)/u;
const coverageCaveatPattern = /(?:(?:수집|관측|확인)\s*(?:범위|비율)|coverage|커버리지|누락|표본)/iu;
const cynicalTonePattern = /(?:굳이|공교롭게|하필|제법\s*친절|순진하게|우연치고는|모른\s*척|알아서)/u;
const koreanQuantityPattern = /(?:하나|한|둘|두|셋|세|넷|네|다섯|여섯|일곱|여덟|아홉|열|한두|두어|두세|서너|너덧|너댓|대여섯|예닐곱|일여덟|스무|스물(?:한|두|세|네)?|서른|마흔|쉰|예순|일흔|여든|아흔|수십|수백|수천|여러|몇몇|몇|[일이삼사오육칠팔구]?(?:십|백|천)(?:여|남짓)?|일|이|삼|사|오|육|칠|팔|구)(?=\s*(?:건|개|회|번|차례|점|퍼센트|%|[이가을를은는만도,.!?。]|$))/u;
const englishQuantityPattern = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|once|twice|thrice|single|double|triple|few|several|many|multiple|dozen|times?|counts?)\b/iu;
const genericCommentTerms = new Set([
    '그래', '그런데', '그리고', '그냥', '너무', '오늘', '정말', '진짜',
    'comment', 'instagram', 'like', 'this', 'that', 'with',
]);

export function sanitizePublicRiskNarrativeLine(value: unknown): string | null {
    if (typeof value !== 'string') return null;

    const sanitized = value
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    return sanitized || null;
}

export function containsExposedInteractionMetric(value: string): boolean {
    const normalized = value.normalize('NFKC');
    if (/\p{N}/u.test(value) || /\p{N}/u.test(normalized)) return true;

    const clauses = normalized.split(/[.!?。]/u);
    return clauses.some(clause => (
        koreanQuantityPattern.test(clause) || englishQuantityPattern.test(clause)
    ));
}

export function containsDefinitiveRelationshipAccusation(value: string): boolean {
    return definitiveAccusationPattern.test(value);
}

export function extractSafePublicCommentTerms(value: unknown): string[] {
    if (typeof value !== 'string') return [];

    const terms = value
        .normalize('NFKC')
        .match(/[가-힣]{2,12}|[a-z]{3,12}/giu) ?? [];
    return [...new Set(
        terms
            .map(term => term.toLowerCase())
            .filter(term => !genericCommentTerms.has(term))
            .filter(term => !containsDefinitiveRelationshipAccusation(term))
    )].slice(0, 8);
}

export function isSafePublicRiskNarrativeLine(value: string): boolean {
    return value.length > 0
        && value.length <= MAX_PUBLIC_RISK_NARRATIVE_LINE_LENGTH
        && /[가-힣]/u.test(value)
        && !containsDefinitiveRelationshipAccusation(value)
        && !containsExposedInteractionMetric(value);
}

export function hasPublicRiskInteractionReference(value: string): boolean {
    return interactionTermPattern.test(value);
}

export function hasPublicRiskCoverageCaveat(value: string): boolean {
    return coverageCaveatPattern.test(value);
}

export function hasCynicalPublicRiskTone(lines: readonly string[]): boolean {
    return lines.some(line => cynicalTonePattern.test(line));
}

export function parseSafePublicRiskNarrative(value: unknown): [string, string] | null {
    if (!Array.isArray(value) || value.length !== MAX_PUBLIC_RISK_NARRATIVE_LINES) return null;

    const lines = value.map(sanitizePublicRiskNarrativeLine);
    if (lines.some(line => line === null)) return null;
    const parsed = lines as [string, string];

    if (
        parsed[0] === parsed[1]
        || !parsed.every(isSafePublicRiskNarrativeLine)
        || !hasPublicRiskInteractionReference(parsed[1])
        || !hasPublicRiskCoverageCaveat(parsed[1])
        || !hasCynicalPublicRiskTone(parsed)
    ) {
        return null;
    }

    return parsed;
}

export function buildSafeFallbackRiskNarrative(signals: {
    candidateLikedTarget: boolean;
    candidateCommentedOnTarget: boolean;
    targetLikedCandidate: boolean;
    commentText?: string;
}): [string, string] {
    const likeEvidence = signals.candidateLikedTarget && signals.targetLikedCandidate
        ? '서로 남긴 좋아요 흔적'
        : signals.candidateLikedTarget
            ? '후보가 대상 게시물에 남긴 좋아요 흔적'
            : signals.targetLikedCandidate
                ? '대상 계정이 후보 피드에 남긴 좋아요 흔적'
                : '';
    const commentTerm = extractSafePublicCommentTerms(signals.commentText)[0];
    const commentEvidence = signals.candidateCommentedOnTarget
        ? commentTerm
            ? `후보가 대상 게시물에 남긴 댓글의 “${commentTerm}” 표현`
            : '후보가 대상 게시물에 남긴 댓글 내용'
        : '';
    const evidence = [likeEvidence, commentEvidence].filter(Boolean).join('과 ');
    const lines = [
        '공개 프로필과 최근 피드, 맞팔 흐름은 눈에 띄어야 할 재료를 꽤 성실하게 쌓아 두었습니다.',
        evidence
            ? `${evidence}까지 관측돼 기록은 제법 친절하지만, 수집 표본 밖의 다른 상호작용까지 없다고 순진하게 믿기는 이릅니다.`
            : '관측 표본에서 공개 상호작용을 확정할 재료는 제한적이며, 표본 밖 기록도 없다고 순진하게 믿을 근거는 없습니다.',
    ];
    const parsed = parseSafePublicRiskNarrative(lines);
    if (!parsed) {
        throw new Error('Safe fallback risk narrative violated its public contract.');
    }
    return parsed;
}
