import {
    containsDefinitiveRelationshipAccusation,
    containsExposedInteractionMetric,
    parseSafePublicRiskNarrative,
} from './narrative-privacy';

const MAX_OVERVIEW_LENGTH = 110;

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
    '주말마다', '오후',
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

export type V211CopySubjects = {
    targetUsername: string;
    targetFullName?: string | null;
    candidateUsername: string;
    candidateFullName?: string | null;
};

export type V211InteractionEvidence = {
    /** Canonical public identities, used instead of generic target/candidate labels. */
    subjects?: V211CopySubjects;
    candidateLikedTarget: boolean;
    candidateCommentedOnTarget: boolean;
    targetLikedCandidate: boolean;
    targetCommentedOnCandidate?: boolean;
    candidateTaggedTarget?: boolean;
    targetTaggedCandidate?: boolean;
    candidateCaptionMentionedTarget?: boolean;
    candidateCommentMentionedTarget?: boolean;
    targetCaptionMentionedCandidate?: boolean;
    targetCommentMentionedCandidate?: boolean;
    candidateMentionedTarget?: boolean;
    targetMentionedCandidate?: boolean;
    tagEvidence?: boolean;
    commentText?: string | null;
    /** Appearance copy is permitted only when analyzed image evidence is reliable. */
    appearance?: { isReliable: boolean };
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

/** True only when the retained bio/caption source has visible raw text. */
export function hasRetainedPublicText(input: V211CopyEvidence): boolean {
    return [input.profileEvidence ?? '', ...(input.feedEvidence ?? [])]
        .some(value => normalizeCopy(value).length > 0);
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

function normalizedUsername(value: string): string {
    return normalizeCopy(value).replace(/^@/u, '').toLowerCase();
}

function normalizedFullName(value: string | null | undefined): string | null {
    const normalized = normalizeCopy(value ?? '')
        .replace(publicIdentifierPattern, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    // The two generic role labels are never canonical names.  A malformed
    // retained full-name field must therefore fall back to the normalized
    // username rather than leak the forbidden label into public copy.
    return normalized && !genericRoleLabel(normalized) ? normalized : null;
}

function subjectName(fullName: string | null | undefined, username: string): string {
    const canonicalFullName = normalizedFullName(fullName);
    if (canonicalFullName) {
        return canonicalFullName.endsWith('님') ? canonicalFullName : `${canonicalFullName}님`;
    }
    const normalized = normalizedUsername(username);
    if (!normalized) throw new Error('CONCIERGE_COPY_SUBJECT_REQUIRED');
    return normalized;
}

export function v211CopySubjectNames(input: V211CopySubjects | undefined): {
    target: string;
    candidate: string;
} {
    if (!input) throw new Error('CONCIERGE_COPY_SUBJECT_REQUIRED');
    const target = subjectName(input.targetFullName, input.targetUsername);
    const candidate = subjectName(input.candidateFullName, input.candidateUsername);
    if (target === candidate) throw new Error('CONCIERGE_COPY_SUBJECT_CONFLICT');
    return { target, candidate };
}

function subjectParticle(name: string): string {
    return name.endsWith('님') ? `${name}이` : `${name}가`;
}

function genericRoleLabel(value: string): boolean {
    return /(?:대상\s*계정|후보\s*계정)/u.test(value);
}

export function parseV211NarrativeWithSubjects(
    lines: [string, string],
    subjects: { target: string; candidate: string },
): [string, string] | null {
    // A normalized username can legitimately include digits.  Mask the two
    // approved subject names before the generic metric guard runs, so those
    // digits cannot be mistaken for disclosed interaction counts.
    const masked = lines.map(line => line
        .replaceAll(subjects.target, 'PERSON')
        .replaceAll(subjects.candidate, 'PERSON')
        // Subject-name particles are grammatical, not interaction counts.
        // Remove them together with the approved-name placeholder so the
        // generic Korean-quantity detector cannot read 이/삼 as a count.
        .replace(/PERSON[이가은는을를와과의]/gu, 'PERSON')) as [string, string];
    return parseSafePublicRiskNarrative(masked) ? lines : null;
}

export function needsV211EvidenceSpecificOverview(
    value: unknown,
    evidence: V211CopyEvidence,
): boolean {
    if (typeof value !== 'string') return true;
    const overview = normalizeCopy(value);
    if (
        overview.length < 25
        || overview.length > MAX_OVERVIEW_LENGTH
        || isForbiddenV211Overview(overview)
        || containsDefinitiveRelationshipAccusation(overview)
        || containsExposedInteractionMetric(overview)
        || publicIdentifierPattern.test(overview)
        || genericRoleLabel(overview)
    ) return true;
    const terms = extractV211EvidenceTerms(evidence);
    return terms.length === 0
        || !terms.some(term => overview.toLowerCase().includes(term.toLowerCase()));
}

/**
 * Deterministic, evidence-first fallback for v2.11.  There is intentionally
 * no generic branch: if retained evidence cannot yield a concrete term, the
 * caller must quarantine the account/correction instead of publishing copy.
 */
export function buildV211EvidenceSpecificOverview(input: V211CopyEvidence & {
    /** Retained for source compatibility; composition is evidence-driven, never rank-driven. */
    variation?: number;
}): string {
    const profileTerms = extractV211EvidenceTerms({ profileEvidence: input.profileEvidence });
    const feedTerms = extractV211EvidenceTerms({ feedEvidence: input.feedEvidence });
    const terms = [...new Set([...profileTerms, ...feedTerms])];
    if (terms.length === 0) throw new Error('CONCIERGE_COPY_EVIDENCE_UNAVAILABLE');
    const profile = profileTerms[0];
    const feed = feedTerms[0];
    const secondFeed = feedTerms.find(term => term !== feed);
    const raw = profile && feed && profile !== feed
        ? `소개에 적은 ${quoted(profile)}와 피드의 ${quoted(feed)} 장면이 자연스럽게 이어지는 기록입니다.`
        : feed && secondFeed
            ? `${quoted(feed)}부터 ${quoted(secondFeed)}까지 피드에 남겨, 취향의 흐름이 또렷하게 보이는 기록입니다.`
            : feed
                ? `${quoted(feed)} 장면을 피드에 남겨, 무엇을 좋아하는지 구체적으로 읽히는 기록입니다.`
                : `${quoted(profile!)}을 소개에 적어 두어, 공개된 관심사가 선명하게 남는 계정입니다.`;
    const result = normalizeCopy(raw);
    if (
        result.length < 25
        || result.length > MAX_OVERVIEW_LENGTH
        || isForbiddenV211Overview(result)
        || containsDefinitiveRelationshipAccusation(result)
        || containsExposedInteractionMetric(result)
        || publicIdentifierPattern.test(result)
        || genericRoleLabel(result)
        || !terms.some(term => result.toLowerCase().includes(term.toLowerCase()))
    ) {
        throw new Error('CONCIERGE_COPY_OVERVIEW_CONTRACT_FAILED');
    }
    return result;
}

export type V213ReviewedOverview = {
    overview: string;
    /** The deliberately selected composition, retained with the correction audit. */
    form: string;
    evidenceTerms: readonly string[];
    /** Present only for the two explicit no-text v2.13 evidence paths. */
    sparseOverviewMode?: V213SparseOverviewMode;
};

export type V213SparseOverviewMode = 'observed_interaction' | 'no_text_evidence';

/**
 * The correction pass intentionally rewrites every already-published overview.
 * Its ordinal selects a composition only; every public clause still comes from
 * the retained profile/feed evidence supplied by the caller.
 */
export function buildV213ReviewedOverview(input: V211CopyEvidence & {
    reviewOrdinal: number;
}): V213ReviewedOverview {
    const profileTerms = extractV211EvidenceTerms({ profileEvidence: input.profileEvidence });
    const feedTerms = extractV211EvidenceTerms({ feedEvidence: input.feedEvidence });
    const allTerms = [...new Set([...profileTerms, ...feedTerms])];
    if (allTerms.length === 0) throw new Error('CONCIERGE_COPY_EVIDENCE_UNAVAILABLE');

    const profile = profileTerms[0];
    const feed = feedTerms[0] ?? profileTerms[0]!;
    const secondFeed = feedTerms.find(term => term !== feed) ?? feed;
    const formIndex = ((input.reviewOrdinal % 16) + 16) % 16;
    const profileAndFeedForms = [
        `소개에는 ${profile}에 관한 이야기가, 피드에는 ${feed} 장면이 남아 관심사가 자연스럽게 이어집니다.`,
        `피드에서 ${feed} 장면이 먼저 눈에 들어오고, 소개의 ${profile} 관심사도 같은 방향을 가리킵니다.`,
        `${feed} 기록을 따라가면 ${profile}에 관한 소개까지 연결돼, 좋아하는 것이 또렷하게 읽힙니다.`,
        `소개에 적어 둔 ${profile}와 피드의 ${feed} 장면이 나란히 남아 계정의 분위기를 만듭니다.`,
        `${feed} 장면을 담은 피드에 ${profile}에 관한 소개가 보태져, 공개 기록의 결이 분명합니다.`,
        `피드 속 ${feed} 기록과 ${profile}에 관한 짧은 소개가 만나, 일상 취향을 구체적으로 보여 줍니다.`,
        `${profile}에 대한 관심사는 소개에서, ${feed} 장면은 피드에서 확인돼 서로 자연스럽게 이어집니다.`,
        `소개보다 피드의 ${feed} 장면이 먼저 말을 걸고, ${profile}에 관한 기록이 그 흐름을 받쳐 줍니다.`,
        `${feed}에서 시작한 피드가 ${secondFeed} 기록으로 이어져, 한 가지 취향에 머물지 않는 모습이 보입니다.`,
        `피드에는 ${secondFeed} 기록이 이어지고 ${feed} 장면도 남아, 공개된 관심사가 차분히 드러납니다.`,
        `${profile}에 관한 소개를 읽은 뒤 ${feed} 장면을 보면, 이 계정이 담아온 하루가 더 선명해집니다.`,
        `${feed} 장면과 ${secondFeed} 기록이 피드에 쌓여, 무엇을 즐겨 담는지 자연스럽게 알 수 있습니다.`,
        `소개에 남긴 ${profile} 관심사가 피드의 ${secondFeed} 기록과 맞닿아, 계정의 성격을 또렷하게 합니다.`,
        `${secondFeed} 기록이 이어지는 피드라 ${feed} 장면도 우연한 한 컷보다 관심사의 일부로 읽힙니다.`,
        `피드의 ${feed} 장면은 ${profile}에 관한 소개와 연결돼, 공개된 기록에 일관된 방향을 남깁니다.`,
        `${profile}에 관한 소개와 ${secondFeed} 기록을 함께 보면, 피드가 들려주는 일상의 취향이 구체적입니다.`,
    ] as const;
    const feedOnlyForms = [
        `${feed} 장면이 피드에 남고 ${secondFeed} 기록으로 이어져, 무엇을 즐겨 담는지 자연스럽게 드러납니다.`,
        `피드에서 ${feed} 장면이 먼저 눈에 들어오며 ${secondFeed} 기록까지 이어져 관심사의 방향이 분명합니다.`,
        `${feed} 기록을 따라가면 ${secondFeed} 장면으로 연결돼, 이 계정이 담아온 일상이 구체적으로 읽힙니다.`,
        `${secondFeed} 기록과 ${feed} 장면이 피드에 나란히 남아, 좋아하는 소재가 자연스럽게 드러납니다.`,
        `${feed} 장면을 담은 뒤 ${secondFeed} 기록으로 이어가, 공개된 피드의 흐름이 한눈에 들어옵니다.`,
        `피드 속 ${feed} 기록은 ${secondFeed} 장면과 맞닿아, 일상 취향을 차분하게 보여 줍니다.`,
        `${feed} 장면에서 시작한 피드가 ${secondFeed} 기록으로 이어져, 관심사가 한 흐름으로 보입니다.`,
        `피드에 남긴 ${secondFeed} 기록을 보면 ${feed} 장면도 우연한 한 컷보다 취향의 일부로 읽힙니다.`,
        `${feed} 장면과 ${secondFeed} 기록이 차례로 남아, 무엇을 즐겨 기록하는지 구체적으로 알 수 있습니다.`,
        `${secondFeed} 기록이 이어지는 피드라 ${feed} 장면도 계정의 분위기를 만드는 한 조각으로 보입니다.`,
        `피드의 ${feed} 장면은 ${secondFeed} 기록과 연결돼, 공개된 일상에 일관된 방향을 남깁니다.`,
        `${secondFeed} 기록을 담은 피드에 ${feed} 장면도 더해져, 관심사가 과장 없이 드러납니다.`,
        `${feed} 장면을 중심으로 ${secondFeed} 기록이 이어져, 피드가 들려주는 취향이 또렷합니다.`,
        `피드에는 ${secondFeed} 기록이 이어지고 ${feed} 장면도 남아, 공개된 관심사가 차분히 읽힙니다.`,
        `${feed} 장면과 ${secondFeed} 기록을 함께 보면, 이 피드가 기록해 온 하루가 더 선명해집니다.`,
        `${secondFeed} 기록 사이에 ${feed} 장면이 남아, 일상에서 좋아하는 것을 자연스럽게 보여 줍니다.`,
    ] as const;
    const overview = normalizeCopy((profile ? profileAndFeedForms : feedOnlyForms)[formIndex]!);
    const usedTerms = [...new Set([profile, feed, secondFeed].filter((term): term is string => Boolean(term)))];
    if (
        overview.length < 25
        || overview.length > MAX_OVERVIEW_LENGTH
        || needsV211EvidenceSpecificOverview(overview, input)
        || !usedTerms.some(term => overview.toLowerCase().includes(term.toLowerCase()))
    ) {
        throw new Error('CONCIERGE_COPY_OVERVIEW_CONTRACT_FAILED');
    }
    return {
        overview,
        form: `v213-full-review-${formIndex + 1}`,
        evidenceTerms: usedTerms,
    };
}

function interactionParts(
    input: V211InteractionEvidence,
    subjects: { target: string; candidate: string },
): string[] {
    const parts: string[] = [];
    if (input.candidateLikedTarget && input.targetLikedCandidate) {
        parts.push(`${subjectParticle(subjects.candidate)} ${subjects.target} 게시물에 좋아요를 남긴 흐름`);
        parts.push(`${subjectParticle(subjects.target)} ${subjects.candidate} 피드에 좋아요를 남긴 흐름`);
    } else if (input.candidateLikedTarget) {
        parts.push(`${subjectParticle(subjects.candidate)} ${subjects.target} 게시물에 좋아요를 남긴 흐름`);
    } else if (input.targetLikedCandidate) {
        parts.push(`${subjectParticle(subjects.target)} ${subjects.candidate} 피드에 좋아요를 남긴 흐름`);
    }
    if (input.candidateCommentedOnTarget) {
        parts.push(`${subjectParticle(subjects.candidate)} ${subjects.target} 게시물에 댓글을 남긴 흐름`);
    }
    if (input.targetCommentedOnCandidate) {
        parts.push(`${subjectParticle(subjects.target)} ${subjects.candidate} 피드에 댓글을 남긴 흐름`);
    }
    if (input.candidateTaggedTarget) parts.push(`${subjectParticle(subjects.candidate)} ${subjects.target}을 태그한 흔적`);
    if (input.targetTaggedCandidate) parts.push(`${subjectParticle(subjects.target)} ${subjects.candidate}을 태그한 흔적`);
    if (input.candidateCaptionMentionedTarget) parts.push(`${subjectParticle(subjects.candidate)} ${subjects.target}을 캡션에서 멘션한 흔적`);
    if (input.candidateCommentMentionedTarget) parts.push(`${subjectParticle(subjects.candidate)} ${subjects.target}을 댓글에서 멘션한 흔적`);
    if (input.candidateMentionedTarget && !input.candidateCaptionMentionedTarget && !input.candidateCommentMentionedTarget) {
        parts.push(`${subjectParticle(subjects.candidate)} ${subjects.target}을 멘션한 흔적`);
    }
    if (input.targetCaptionMentionedCandidate) parts.push(`${subjectParticle(subjects.target)} ${subjects.candidate}을 캡션에서 멘션한 흔적`);
    if (input.targetCommentMentionedCandidate) parts.push(`${subjectParticle(subjects.target)} ${subjects.candidate}을 댓글에서 멘션한 흔적`);
    if (input.targetMentionedCandidate && !input.targetCaptionMentionedCandidate && !input.targetCommentMentionedCandidate) {
        parts.push(`${subjectParticle(subjects.target)} ${subjects.candidate}을 멘션한 흔적`);
    }
    if (input.tagEvidence && !input.candidateTaggedTarget && !input.targetTaggedCandidate) {
        parts.push('확인된 태그 표기');
    }
    return parts;
}

/** A compact direction-preserving phrase when the target's display name cannot be public overview text. */
function sparseInteractionPhrase(input: V211InteractionEvidence, candidate: string): string | null {
    if (input.candidateLikedTarget) return `${candidate}이 상대 게시물에 좋아요를 남긴 흐름`;
    if (input.candidateCommentedOnTarget) return `${candidate}이 상대 게시물에 댓글을 남긴 흐름`;
    if (input.targetLikedCandidate) return `상대가 ${candidate} 피드에 좋아요를 남긴 흐름`;
    if (input.targetCommentedOnCandidate) return `상대가 ${candidate} 피드에 댓글을 남긴 흐름`;
    if (input.candidateTaggedTarget) return `${candidate}이 상대를 태그한 흔적`;
    if (input.targetTaggedCandidate) return `상대가 ${candidate}을 태그한 흔적`;
    if (input.candidateCaptionMentionedTarget) return `${candidate}이 캡션에서 상대를 멘션한 흔적`;
    if (input.candidateCommentMentionedTarget) return `${candidate}이 댓글에서 상대를 멘션한 흔적`;
    if (input.candidateMentionedTarget) return `${candidate}이 상대를 멘션한 흔적`;
    if (input.targetCaptionMentionedCandidate) return `상대가 캡션에서 ${candidate}을 멘션한 흔적`;
    if (input.targetCommentMentionedCandidate) return `상대가 댓글에서 ${candidate}을 멘션한 흔적`;
    if (input.targetMentionedCandidate) return `상대가 ${candidate}을 멘션한 흔적`;
    if (input.tagEvidence) return `${candidate}과 관련해 확인된 태그 표기`;
    return null;
}

/**
 * A v2.13-only path for a retained profile whose bio and captions contain no
 * publishable text.  It deliberately never turns media shape into a fact:
 * either an observed public interaction is named, or the copy says only that
 * the available text is absent and refuses to invent a photo story.
 */
export function buildV213SparseEvidenceOverview(input: V211InteractionEvidence & {
    reviewOrdinal: number;
    subjects: V211CopySubjects;
    /** Allows the no-text statement only when bio and retained captions are truly absent. */
    textEvidenceAbsent: boolean;
}): V213ReviewedOverview {
    const candidateFullName = normalizedFullName(input.subjects.candidateFullName);
    if (!candidateFullName || /[0-9@]/u.test(candidateFullName)) {
        throw new Error('CONCIERGE_COPY_SPARSE_SUBJECTS_REQUIRED');
    }
    const candidate = candidateFullName.endsWith('님') ? candidateFullName : `${candidateFullName}님`;
    const hasObservedInteraction = input.candidateLikedTarget
        || input.candidateCommentedOnTarget
        || input.targetLikedCandidate
        || Boolean(input.targetCommentedOnCandidate)
        || Boolean(input.candidateTaggedTarget)
        || Boolean(input.targetTaggedCandidate)
        || Boolean(input.candidateCaptionMentionedTarget)
        || Boolean(input.candidateCommentMentionedTarget)
        || Boolean(input.targetCaptionMentionedCandidate)
        || Boolean(input.targetCommentMentionedCandidate)
        || Boolean(input.candidateMentionedTarget)
        || Boolean(input.targetMentionedCandidate)
        || Boolean(input.tagEvidence);
    if (!hasObservedInteraction && !input.textEvidenceAbsent) {
        throw new Error('CONCIERGE_COPY_EVIDENCE_UNAVAILABLE');
    }
    const observedPart = hasObservedInteraction ? sparseInteractionPhrase(input, candidate) : null;
    if (hasObservedInteraction && !observedPart) {
        throw new Error('CONCIERGE_COPY_INTERACTION_EVIDENCE_UNAVAILABLE');
    }
    const sparseOverviewMode: V213SparseOverviewMode = observedPart
        ? 'observed_interaction'
        : 'no_text_evidence';
    const raw = observedPart
        ? `${observedPart}이 확인되지만, 단일 공개 반응만으로 관계를 단정하지 않고 공개 기록부터 살펴봅니다.`
        : `${candidate}의 공개된 소개·캡션 문구가 비어 있어, 사진에서 이야기를 지어내지 않고 이름으로 확인되는 범위만 차분히 읽어봅니다.`;
    const overview = normalizeCopy(raw);
    // Sparse overview names must be canonical full names, not username
    // fallbacks, because the immutable RPC rejects identifiers in overview text.
    const masked = overview
        .replaceAll(candidate, 'PERSON');
    if (
        overview.length < 25
        || overview.length > MAX_OVERVIEW_LENGTH
        || isForbiddenV211Overview(overview)
        || containsDefinitiveRelationshipAccusation(masked)
        || containsExposedInteractionMetric(masked)
        || publicIdentifierPattern.test(overview)
        || genericRoleLabel(overview)
    ) {
        throw new Error('CONCIERGE_COPY_OVERVIEW_CONTRACT_FAILED');
    }
    return {
        overview,
        form: `v213-full-review-${((input.reviewOrdinal % 16) + 16) % 16 + 1}`,
        evidenceTerms: [candidate],
        sparseOverviewMode,
    };
}

export function buildV211EvidenceSpecificRiskNarrative(
    input: V211CopyEvidence & V211InteractionEvidence,
): [string, string] {
    const subjects = v211CopySubjectNames(input.subjects);
    const parts = interactionParts(input, subjects);
    if (parts.length === 0) throw new Error('CONCIERGE_COPY_INTERACTION_EVIDENCE_UNAVAILABLE');
    // High-risk prose is limited to retained feed facts plus observed public
    // interactions.  A profile bio alone must never supply a risk premise.
    const terms = extractV211EvidenceTerms({
        feedEvidence: input.feedEvidence,
    });
    const first = terms[0];
    const second = terms[1];
    const context = first
        ? second
            ? `${subjects.candidate} 피드에는 ${first}와 ${second} 장면이 이어집니다.`
            : `${subjects.candidate} 피드에는 ${first} 장면이 남아 있습니다.`
        : `${subjects.candidate}과 ${subjects.target} 사이에는 공개 반응이 확인돼, 피드 밖 사정을 보태지 않고 그 흐름만 살펴봅니다.`;
    const appearance = input.appearance?.isReliable
        ? ' 사진 속 분위기가 눈길을 붙잡지만, 사진이 관계 설명서를 써주지는 않습니다.'
        : '';
    const line1 = normalizeCopy(context + appearance);
    const line2 = `${parts.join(', ')}이 확인됩니다. 다만 이 공개 흔적만으로 관계를 판단할 수 없고, 수집 범위 밖 기록은 알 수 없습니다.`;
    const parsed = parseV211NarrativeWithSubjects([line1, line2], subjects);
    if (!parsed || isForbiddenV211RiskNarrative(parsed)) {
        throw new Error('CONCIERGE_COPY_NARRATIVE_CONTRACT_FAILED');
    }
    return parsed;
}

export type V213ReviewRecord = {
    reviewVersion: 'v213-full-evidence-review-v1';
    rank: number;
    previousOverview: string;
    nextOverview: string;
    overviewChanged: boolean;
    overviewForm: string;
    overviewEvidenceMode: 'text_evidence' | V213SparseOverviewMode;
    observedEvidenceTerms: readonly string[];
    narrative: {
        previousLines: readonly string[];
        nextLines: readonly string[];
        retainedSentenceJustifications: readonly {
            sentence: string;
            observedEvidenceTerms: readonly string[];
        }[];
    };
};

export function createV213ReviewRecord(input: {
    rank: number;
    previousOverview: string;
    nextOverview: string;
    overviewForm: string;
    evidenceTerms: readonly string[];
    overviewEvidenceMode?: 'text_evidence' | V213SparseOverviewMode;
    previousRiskAnalysis: readonly string[];
    nextRiskAnalysis: readonly string[];
}): V213ReviewRecord {
    const previousOverview = normalizeCopy(input.previousOverview);
    const nextOverview = normalizeCopy(input.nextOverview);
    const previousLines = input.previousRiskAnalysis.map(line => normalizeCopy(line));
    const nextLines = input.nextRiskAnalysis.map(line => normalizeCopy(line));
    const retainedSentenceJustifications = previousLines
        .filter(line => nextLines.includes(line))
        .map(sentence => ({
            sentence,
            observedEvidenceTerms: [...new Set(input.evidenceTerms)],
        }));
    return {
        reviewVersion: 'v213-full-evidence-review-v1',
        rank: input.rank,
        previousOverview,
        nextOverview,
        overviewChanged: previousOverview !== nextOverview,
        overviewForm: input.overviewForm,
        overviewEvidenceMode: input.overviewEvidenceMode ?? 'text_evidence',
        observedEvidenceTerms: [...new Set(input.evidenceTerms)],
        narrative: {
            previousLines,
            nextLines,
            retainedSentenceJustifications,
        },
    };
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
    const subjects = v211CopySubjectNames(input.subjects);
    if (
        genericRoleLabel(first + second)
        || !first.includes(subjects.candidate)
        || !second.includes(subjects.candidate)
        || !second.includes(subjects.target)
    ) {
        throw new Error('CONCIERGE_COPY_SUBJECT_GROUNDING_FAILED');
    }
    const feedTerms = extractV211EvidenceTerms({
        feedEvidence: input.feedEvidence,
    });
    if (feedTerms.length > 0 && !feedTerms.some(term => first.toLowerCase().includes(term.toLowerCase()))) {
        throw new Error('CONCIERGE_COPY_EVIDENCE_GROUNDING_FAILED');
    }
    if (input.candidateLikedTarget && !second.includes('좋아요')) {
        throw new Error('CONCIERGE_COPY_INTERACTION_GROUNDING_FAILED');
    }
    if (input.targetLikedCandidate && !second.includes('좋아요')) {
        throw new Error('CONCIERGE_COPY_INTERACTION_GROUNDING_FAILED');
    }
    if (input.targetCommentedOnCandidate && !second.includes('댓글')) {
        throw new Error('CONCIERGE_COPY_INTERACTION_GROUNDING_FAILED');
    }
    if (input.candidateCommentedOnTarget && !second.includes('댓글')) {
        throw new Error('CONCIERGE_COPY_INTERACTION_GROUNDING_FAILED');
    }
    if (!parseV211NarrativeWithSubjects([first, second], subjects)) {
        throw new Error('CONCIERGE_COPY_NARRATIVE_CONTRACT_FAILED');
    }
}

export function validateV211PublicCopyRows(input: { rows: readonly V211PublicCopyRow[] }): void {
    if (input.rows.length === 0) throw new Error('CONCIERGE_COPY_ROWS_EMPTY');
    for (const row of input.rows) {
        const overview = normalizeCopy(row.oneLineOverview);
        if (
            needsV211EvidenceSpecificOverview(overview, row)
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

export type V213FullReviewRow = V211PublicCopyRow & {
    rank: number;
    previousOverview: string;
    review: V213ReviewRecord;
    sparseOverviewMode?: V213SparseOverviewMode;
};

/**
 * Final quality gate for the one-shot correction.  Unlike the v2.12 pass,
 * every one-line overview must be a deliberate replacement, and the payload
 * carries the prior/current sentence comparison needed for an audit.
 */
export function validateV213FullReviewRows(input: {
    rows: readonly V213FullReviewRow[];
}): void {
    if (input.rows.length !== 16) throw new Error('CONCIERGE_COPY_FULL_REVIEW_SCOPE_INVALID');

    const ranks = new Set<number>();
    const forms = new Map<string, number>();
    for (const row of input.rows) {
        const overview = normalizeCopy(row.oneLineOverview);
        const subjects = v211CopySubjectNames(row.subjects);
        if (row.sparseOverviewMode) {
            const masked = overview
                .replaceAll(subjects.candidate, 'PERSON')
                .replaceAll(subjects.target, 'PERSON');
            if (
                overview.length < 25
                || overview.length > MAX_OVERVIEW_LENGTH
                || isForbiddenV211Overview(overview)
                || containsDefinitiveRelationshipAccusation(masked)
                || containsExposedInteractionMetric(masked)
                || publicIdentifierPattern.test(overview)
                || genericRoleLabel(overview)
            ) {
                throw new Error('CONCIERGE_COPY_GENERIC_FORBIDDEN');
            }
            const observedPart = sparseInteractionPhrase(row, subjects.candidate);
            if (row.sparseOverviewMode === 'observed_interaction') {
                if (!observedPart || !overview.includes(observedPart) || !overview.includes('단정하지 않고')) {
                    throw new Error('CONCIERGE_COPY_EVIDENCE_GROUNDING_FAILED');
                }
            } else if (
                row.sparseOverviewMode !== 'no_text_evidence'
                || hasRetainedPublicText(row)
                || observedPart !== null
                || !overview.includes(subjects.candidate)
                || !overview.includes('소개·캡션 문구가 비어 있어')
                || !overview.includes('사진에서 이야기를 지어내지 않고')
            ) {
                throw new Error('CONCIERGE_COPY_EVIDENCE_GROUNDING_FAILED');
            }
        } else {
            if (needsV211EvidenceSpecificOverview(overview, row)) {
                throw new Error('CONCIERGE_COPY_GENERIC_FORBIDDEN');
            }
            const evidenceTerms = extractV211EvidenceTerms(row);
            if (evidenceTerms.length === 0 || !evidenceTerms.some(term => overview.toLowerCase().includes(term.toLowerCase()))) {
                throw new Error('CONCIERGE_COPY_EVIDENCE_GROUNDING_FAILED');
            }
        }
        assertV211InteractionCopy(row);
        const review = row.review;
        if (!Number.isInteger(row.rank) || row.rank < 1 || row.rank > 16 || ranks.has(row.rank)) {
            throw new Error('CONCIERGE_COPY_FULL_REVIEW_SCOPE_INVALID');
        }
        ranks.add(row.rank);
        if (
            review.reviewVersion !== 'v213-full-evidence-review-v1'
            || review.rank !== row.rank
            || !review.overviewChanged
            || review.overviewEvidenceMode !== (row.sparseOverviewMode ?? 'text_evidence')
            || normalizeCopy(review.previousOverview) !== normalizeCopy(row.previousOverview)
            || normalizeCopy(review.nextOverview) !== normalizeCopy(row.oneLineOverview)
            || normalizeCopy(review.previousOverview) === normalizeCopy(row.oneLineOverview)
            || !/^v213-full-review-(?:[1-9]|1[0-6])$/u.test(review.overviewForm)
        ) {
            throw new Error('CONCIERGE_COPY_FULL_REVIEW_REQUIRED');
        }
        const evidenceTerms = [...new Set(review.observedEvidenceTerms.map(normalizeCopy).filter(Boolean))];
        if (
            evidenceTerms.length === 0
            || !evidenceTerms.some(term => normalizeCopy(row.oneLineOverview).toLowerCase().includes(term.toLowerCase()))
        ) {
            throw new Error('CONCIERGE_COPY_EVIDENCE_GROUNDING_FAILED');
        }
        if (
            review.narrative.nextLines.length !== row.riskAnalysis.length
            || review.narrative.nextLines.some((line, index) => normalizeCopy(line) !== normalizeCopy(row.riskAnalysis[index] ?? ''))
        ) {
            throw new Error('CONCIERGE_COPY_SEMANTIC_DIFF_INVALID');
        }
        const retainedLines = review.narrative.previousLines.filter(line => review.narrative.nextLines.includes(line));
        if (
            retainedLines.length !== review.narrative.retainedSentenceJustifications.length
            || retainedLines.some((sentence, index) => {
                const justification = review.narrative.retainedSentenceJustifications[index];
                return justification?.sentence !== sentence
                    || justification.observedEvidenceTerms.length === 0;
            })
        ) {
            throw new Error('CONCIERGE_COPY_SEMANTIC_DIFF_INVALID');
        }
        forms.set(review.overviewForm, (forms.get(review.overviewForm) ?? 0) + 1);
    }
    if (ranks.size !== 16 || forms.size < 8 || [...forms.values()].some(count => count > 2)) {
        throw new Error('CONCIERGE_COPY_FULL_REVIEW_VARIETY_INVALID');
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
