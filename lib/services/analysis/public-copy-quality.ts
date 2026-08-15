import {
    containsDefinitiveRelationshipAccusation,
    containsExposedInteractionMetric,
    parseSafePublicRiskNarrative,
    sanitizePublicRiskNarrativeLine,
} from './narrative-privacy';

const MAX_OVERVIEW_LENGTH = 110;
const MAX_NARRATIVE_LENGTH = 180;

/**
 * These strings were previously used as v2.11 fallbacks.  They remain listed
 * here as a deny-list because old rows and cached model responses must never
 * be accepted by a new correction/publication pass.
 */
export const V211_FORBIDDEN_OVERVIEW_COPIES = Object.freeze([
    '사진과 소개에 드러난 개인 기록의 결이 선명해서, 피드가 보여 준 장면부터 차분히 짚어볼 계정입니다.',
    '창작과 일상 기록이 섞여 있고, 피드에 드러난 활동 흐름을 중심으로 읽어볼 만한 계정입니다.',
    '공식 단체나 브랜드 맥락으로 분류됐습니다. 개인 계정보다 조직 성격을 먼저 볼 만합니다.',
    '소개와 피드에 여러 결이 겹친 계정입니다. 보이는 장면을 중심으로 흐름을 정리해볼 만합니다.',
] as const);

const V211_FORBIDDEN_RISK_FIRST_LINE =
    '공개 프로필과 최근 피드, 맞팔 흐름은 눈에 띄어야 할 재료를 꽤 성실하게 쌓아 두었습니다.';
const V211_FORBIDDEN_RISK_SECOND_LINE =
    '관측 표본에서 공개 상호작용을 확정할 재료는 제한적이며, 표본 밖 기록도 없다고 순진하게 믿을 근거는 없습니다.';

const genericEvidenceTerms = new Set([
    '계정', '개인', '공개', '프로필', '피드', '사진', '소개', '장면', '기록', '활동',
    '흐름', '맥락', '자료', '단서', '내용', '모습', '결', '오늘', '일상', '최근',
    'instagram', 'profile', 'account', 'public', 'feed', 'photo', 'post', 'story',
]);
const forbiddenEvidenceTerms = /(?:바람|불륜|외도|연인|애인|남자친구|여자친구|남친|여친|커플|교제|사귀|데이트|관계|점수|순위|등급|위험|좋아요|댓글|태그|멘션|퍼센트|건수|횟수)/u;
const publicIdentifierPattern = /(?:https?:\/\/|www\.|@[a-z0-9._]+|\b[^\s@]+@[^\s@]+\b)/iu;

export type V211CopyEvidence = {
    profileEvidence?: string | null;
    feedEvidence?: readonly string[];
    /** Bounded, non-numeric descriptors from retained media/profile shape. */
    structuralEvidence?: readonly string[];
};

export type V211InteractionEvidence = {
    candidateLikedTarget: boolean;
    candidateCommentedOnTarget: boolean;
    targetLikedCandidate: boolean;
    targetCommentedOnCandidate?: boolean;
    candidateTaggedTarget?: boolean;
    targetTaggedCandidate?: boolean;
    candidateMentionedTarget?: boolean;
    targetMentionedCandidate?: boolean;
    tagEvidence?: boolean;
    commentText?: string | null;
};

export type V211PublicCopyRow = V211CopyEvidence & V211InteractionEvidence & {
    oneLineOverview: string;
    riskGrade: string;
    riskAnalysis: readonly string[];
};

function normalizeCopy(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function scrubEvidence(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const normalized = normalizeCopy(value)
        .replace(publicIdentifierPattern, ' ')
        .replace(/\b\d+(?:[.,]\d+)?\b/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized || null;
}

/** Returns short concrete words that can be quoted without exposing identity. */
export function extractV211EvidenceTerms(input: V211CopyEvidence): string[] {
    const source = [
        input.profileEvidence ?? '',
        ...(input.feedEvidence ?? []),
        ...(input.structuralEvidence ?? []),
    ]
        .map(scrubEvidence)
        .filter((value): value is string => Boolean(value))
        .join(' ');
    const matches = source.match(/[가-힣]{2,14}|[a-z]{3,18}/giu) ?? [];
    const cleaned = matches.map(term => term.toLowerCase().replace(
        /(?<=[가-힣])(?:과|와|은|는|이|가|을|를|의|에|로|으로|도|만)$/u,
        '',
    ));
    return [...new Set(cleaned)]
        .filter(term => !genericEvidenceTerms.has(term))
        .filter(term => !forbiddenEvidenceTerms.test(term))
        .filter(term => !/^\d+$/u.test(term))
        .slice(0, 8);
}

export function isForbiddenV211Overview(value: unknown): boolean {
    if (typeof value !== 'string') return true;
    const normalized = normalizeCopy(value);
    return V211_FORBIDDEN_OVERVIEW_COPIES.some(copy => normalizeCopy(copy) === normalized)
        || /(?:피드가\s*보여\s*준\s*장면부터|활동\s*흐름을\s*중심으로\s*읽어볼)/u.test(normalized);
}

export function isForbiddenV211RiskNarrative(value: unknown): boolean {
    if (!Array.isArray(value) || value.length !== 2) return true;
    const first = typeof value[0] === 'string' ? normalizeCopy(value[0]) : '';
    const second = typeof value[1] === 'string' ? normalizeCopy(value[1]) : '';
    return first === V211_FORBIDDEN_RISK_FIRST_LINE
        || second === V211_FORBIDDEN_RISK_SECOND_LINE
        || /(?:눈에\s*띄어야\s*할\s*재료를|공개\s*상호작용을\s*확정할\s*재료는\s*제한)/u.test(first + second);
}

function quoted(term: string): string {
    return `“${term.slice(0, 14)}”`;
}

/**
 * Deterministic, evidence-first fallback for v2.11.  There is intentionally
 * no generic branch: if retained evidence cannot yield a concrete term, the
 * caller must quarantine the account/correction instead of publishing copy.
 */
export function buildV211EvidenceSpecificOverview(input: V211CopyEvidence & {
    variation?: number;
}): string {
    const terms = extractV211EvidenceTerms(input);
    if (terms.length === 0) throw new Error('CONCIERGE_COPY_EVIDENCE_UNAVAILABLE');
    const first = terms[0]!;
    const second = terms[1];
    const variation = Math.abs(input.variation ?? 0) % 4;
    const raw = second
        ? [
            `${quoted(first)}와 ${quoted(second)} 장면이 이어져, 공개된 취향의 결이 구체적으로 보이는 피드입니다.`,
            `피드에서 보인 ${quoted(first)}와 ${quoted(second)} 흐름이 겹쳐, 일상에서 건져 올린 장면이 선명한 계정입니다.`,
            `${quoted(first)} 장면부터 ${quoted(second)} 기록까지 이어져, 활동의 결이 한눈에 잡히는 피드입니다.`,
            `${quoted(first)}와 ${quoted(second)} 이야기가 포개져, 공개된 하루의 분위기가 또렷하게 남는 피드입니다.`,
        ][variation]!
        : [
            `${quoted(first)} 장면이 이어져, 공개된 취향과 활동의 결이 구체적으로 보이는 피드입니다.`,
            `피드에서 보인 ${quoted(first)} 흐름이 이어져, 일상에서 건져 올린 장면이 선명한 계정입니다.`,
            `${quoted(first)} 기록을 중심으로, 공개된 활동의 결이 한눈에 잡히는 피드입니다.`,
            `${quoted(first)} 이야기가 남아, 공개된 하루의 분위기를 구체적으로 읽게 하는 피드입니다.`,
        ][variation]!;
    const result = normalizeCopy(raw);
    if (
        result.length < 25
        || result.length > MAX_OVERVIEW_LENGTH
        || isForbiddenV211Overview(result)
        || containsDefinitiveRelationshipAccusation(result)
        || containsExposedInteractionMetric(result)
        || publicIdentifierPattern.test(result)
        || !terms.some(term => result.toLowerCase().includes(term.toLowerCase()))
    ) {
        throw new Error('CONCIERGE_COPY_OVERVIEW_CONTRACT_FAILED');
    }
    return result;
}

function interactionParts(input: V211InteractionEvidence): string[] {
    const parts: string[] = [];
    if (input.candidateLikedTarget && input.targetLikedCandidate) {
        parts.push('서로 남긴 좋아요 흔적');
    } else if (input.candidateLikedTarget) {
        parts.push('후보가 대상 게시물에 남긴 좋아요 흔적');
    } else if (input.targetLikedCandidate) {
        parts.push('대상 계정이 후보 피드에 남긴 좋아요 흔적');
    }
    if (input.candidateCommentedOnTarget) {
        const terms = extractV211EvidenceTerms({ profileEvidence: input.commentText });
        parts.push(terms[0]
            ? `후보가 대상 게시물에 남긴 댓글의 ${quoted(terms[0])} 표현`
            : '후보가 대상 게시물에 남긴 댓글 내용');
    }
    if (input.targetCommentedOnCandidate) {
        parts.push('대상 계정이 후보 피드에 남긴 댓글 내용');
    }
    if (input.candidateTaggedTarget) parts.push('후보를 가리킨 태그 표기');
    if (input.targetTaggedCandidate) parts.push('대상 계정을 가리킨 태그 표기');
    if (input.candidateMentionedTarget) parts.push('후보가 남긴 캡션 멘션');
    if (input.targetMentionedCandidate) parts.push('대상 계정의 캡션 멘션');
    if (input.tagEvidence && !input.candidateTaggedTarget && !input.targetTaggedCandidate) {
        parts.push('확인된 태그 표기');
    }
    return parts;
}

export function buildV211EvidenceSpecificRiskNarrative(
    input: V211CopyEvidence & V211InteractionEvidence,
): [string, string] {
    const terms = extractV211EvidenceTerms(input);
    if (terms.length === 0) throw new Error('CONCIERGE_COPY_EVIDENCE_UNAVAILABLE');
    const first = terms[0]!;
    const second = terms[1];
    const line1 = normalizeCopy(second
        ? `프로필과 피드에서 ${quoted(first)} 및 ${quoted(second)} 장면이 이어져, 공개된 활동 맥락이 구체적으로 보입니다.`
        : `프로필과 피드에서 ${quoted(first)} 장면이 이어져, 공개된 활동 맥락이 구체적으로 보입니다.`);
    const parts = interactionParts(input);
    const line2 = parts.length === 0
        ? '공개 좋아요·댓글·태그 흔적은 현재 확인되지 않지만, 수집 표본 밖 누락 가능성은 남습니다.'
        : `${parts.join('과 ')}이 보이지만, 수집 표본 밖 누락 가능성은 남습니다.`;
    const parsed = parseSafePublicRiskNarrative([line1, line2]);
    if (!parsed || isForbiddenV211RiskNarrative(parsed)) {
        throw new Error('CONCIERGE_COPY_NARRATIVE_CONTRACT_FAILED');
    }
    return parsed;
}

function normalizedCopyTokens(value: string): string[] {
    return normalizeCopy(value)
        .toLowerCase()
        .match(/[가-힣]{2,}|[a-z]{2,}/giu) ?? [];
}

function characterNgrams(value: string): Set<string> {
    const normalized = normalizeCopy(value).replace(/\s+/g, '');
    const result = new Set<string>();
    for (let index = 0; index < normalized.length - 2; index += 1) {
        result.add(normalized.slice(index, index + 3));
    }
    return result;
}

function jaccard(left: Set<string>, right: Set<string>): number {
    if (left.size === 0 && right.size === 0) return 1;
    let intersection = 0;
    for (const token of left) if (right.has(token)) intersection += 1;
    return intersection / (left.size + right.size - intersection || 1);
}

export function areMateriallyNearDuplicatePublicCopies(left: string, right: string): boolean {
    const leftNormalized = normalizeCopy(left).toLowerCase();
    const rightNormalized = normalizeCopy(right).toLowerCase();
    if (leftNormalized === rightNormalized) return true;
    const tokenSimilarity = jaccard(
        new Set(normalizedCopyTokens(leftNormalized)),
        new Set(normalizedCopyTokens(rightNormalized)),
    );
    const characterSimilarity = jaccard(characterNgrams(leftNormalized), characterNgrams(rightNormalized));
    return tokenSimilarity >= 0.78 && characterSimilarity >= 0.68;
}

function assertV211InteractionCopy(input: V211PublicCopyRow): void {
    const lines = input.riskAnalysis;
    if (input.riskGrade !== 'high_risk') {
        if (lines.length !== 0) throw new Error('CONCIERGE_COPY_NARRATIVE_SCOPE_INVALID');
        return;
    }
    if (isForbiddenV211RiskNarrative(lines) || lines.length !== 2) {
        throw new Error('CONCIERGE_COPY_GENERIC_FORBIDDEN');
    }
    const first = normalizeCopy(lines[0] ?? '');
    const second = normalizeCopy(lines[1] ?? '');
    const terms = extractV211EvidenceTerms(input);
    if (!terms.some(term => first.toLowerCase().includes(term.toLowerCase()))) {
        throw new Error('CONCIERGE_COPY_EVIDENCE_GROUNDING_FAILED');
    }
    if (input.candidateLikedTarget && !second.includes('후보가 대상 게시물에 남긴 좋아요')) {
        throw new Error('CONCIERGE_COPY_INTERACTION_GROUNDING_FAILED');
    }
    if (input.targetLikedCandidate && !second.includes('대상 계정이 후보 피드에 남긴 좋아요') && !second.includes('서로 남긴 좋아요')) {
        throw new Error('CONCIERGE_COPY_INTERACTION_GROUNDING_FAILED');
    }
    if (input.targetCommentedOnCandidate && !second.includes('대상 계정이 후보 피드에 남긴 댓글')) {
        throw new Error('CONCIERGE_COPY_INTERACTION_GROUNDING_FAILED');
    }
    if (input.candidateCommentedOnTarget && !second.includes('후보가 대상 게시물에 남긴 댓글')) {
        throw new Error('CONCIERGE_COPY_INTERACTION_GROUNDING_FAILED');
    }
    if (!parseSafePublicRiskNarrative([first, second])) {
        throw new Error('CONCIERGE_COPY_NARRATIVE_CONTRACT_FAILED');
    }
}

export function validateV211PublicCopyRows(input: { rows: readonly V211PublicCopyRow[] }): void {
    if (input.rows.length === 0) throw new Error('CONCIERGE_COPY_ROWS_EMPTY');
    for (const row of input.rows) {
        const overview = normalizeCopy(row.oneLineOverview);
        if (
            overview.length < 25
            || overview.length > MAX_NARRATIVE_LENGTH
            || isForbiddenV211Overview(overview)
            || containsDefinitiveRelationshipAccusation(overview)
            || containsExposedInteractionMetric(overview)
            || publicIdentifierPattern.test(overview)
        ) {
            throw new Error('CONCIERGE_COPY_GENERIC_FORBIDDEN');
        }
        const evidenceTerms = extractV211EvidenceTerms(row);
        if (evidenceTerms.length === 0 || !evidenceTerms.some(term => overview.toLowerCase().includes(term.toLowerCase()))) {
            throw new Error('CONCIERGE_COPY_EVIDENCE_GROUNDING_FAILED');
        }
        assertV211InteractionCopy(row);
    }
    const overviews = input.rows.map(row => normalizeCopy(row.oneLineOverview));
    for (let left = 0; left < overviews.length; left += 1) {
        for (let right = left + 1; right < overviews.length; right += 1) {
            if (areMateriallyNearDuplicatePublicCopies(overviews[left]!, overviews[right]!)) {
                throw new Error('CONCIERGE_COPY_DUPLICATE_FORBIDDEN');
            }
        }
    }
}
