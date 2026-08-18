import { createHash } from 'node:crypto';
import {
    isRiskBandCompatibleWithDisplayScore,
    type AccountContext,
    type AppearanceGrade,
} from '@/lib/domain/analysis/risk-policy';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';
import {
    createPrivateNameBatchResponseSchema,
    privateNameAccountsInputSchema,
    type PrivateNameAnalysisResult,
} from '@/lib/services/ai/private-name-analysis';
import type { ReplayAccountAiDetail } from './replay/replay-runner';
import type { InstagramPost, InstagramProfile } from '@/lib/types/instagram';
import {
    calculateV2FinalScores,
    calculateV2PreliminaryScores,
    hasCandidateTargetMention,
} from './v2-candidate-scoring';
import {
    joinVerifiedFemaleTargetInteractions,
    summarizeCandidateTargetInteractions,
    type RawTargetInteractionEvidence,
} from './v2-target-interactions';
import { screenAnalysisV2OfficialAccount } from './v2-official-account-screening';
import {
    buildV211EvidenceSpecificRiskNarrative,
    buildV211EvidenceSpecificOverview,
    buildV213SparseEvidenceOverview,
    extractV211EvidenceTerms,
    hasRetainedPublicText,
    needsV211EvidenceSpecificOverview,
} from './public-copy-quality';

const SPARSE_NO_NAME_OVERVIEW = '공개된 소개·캡션 문구가 비어 있어, 사진에서 이야기를 지어내지 않고 확인되는 범위만 차분히 읽어봅니다.';
const SPARSE_TEXT_PRESENT_OVERVIEW = '보존된 공개 소개·캡션 문구를 바탕으로 확인 가능한 기록의 범위만 차분히 읽어봅니다.';
const BATCH_HIGH_RISK_COPY_DEFERRED_OVERVIEW = '배치용 고위험 카피를 생성하기 전 점수와 보존 자료를 먼저 확인합니다.';
const BATCH_HIGH_RISK_COPY_DEFERRED_NARRATIVE = '배치용 고위험 서사가 생성되기 전에는 이 임시 초안을 발행하지 않습니다.';
const CONCIERGE_PUBLIC_IDENTIFIER_PATTERN = /(?:https?:\/\/|www\.|@[a-z0-9._]+|\b[^\s@]+@[^\s@]+\b)/iu;
const CONCIERGE_UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu;

export interface ConciergeRelationshipEvidence {
    username: string;
    side: 'follower' | 'following';
    isPrivate: boolean;
    isVerified: boolean;
    fullName: string | null;
    profilePicUrl?: string | null;
    ordinal: number;
}

export interface ConciergePrivacyPartition {
    profiles: readonly InstagramProfile[];
    publicProfiles: readonly InstagramProfile[];
    privateProfiles: readonly InstagramProfile[];
    /** Exact mutual accounts that could not be classified from authoritative profile hydration. */
    unresolvedUsernames: readonly string[];
    relationshipRows: readonly ConciergeRelationshipEvidence[];
    orderedMutualUsernames: readonly string[];
}

export interface ConciergeLegacyResultRow {
    rank: number;
    suspect_instagram_id: string;
    suspect_profile_image: string | null;
    suspect_full_name: string | null;
    bio: string | null;
    risk_score: number;
    photogenic_grade: AppearanceGrade;
    exposure_level: 'high' | 'medium' | 'low';
    is_tagged: boolean;
    risk_grade: 'normal' | 'caution' | 'high_risk';
    gender_confidence: number;
    gender_status: 'confirmed';
    is_unlocked: true;
    likes_count: number;
    intimate_comments_count: number;
    one_line_overview: string;
    risk_analysis: readonly string[];
}

export interface ConciergePrivateAccountRow {
    sort_ordinal: number;
    instagram_id: string;
    profile_image: string | null;
    full_name: string | null;
    name_female_score: number;
    name_is_name: boolean;
    name_confidence: number;
}

export type ConciergeTargetPostMentionEvidence = Readonly<Pick<
    InstagramPost,
    'taggedUsers' | 'mentionedUsers'
>>;

function parseTargetPostMentionEvidence(value: unknown): ConciergeTargetPostMentionEvidence[] | null {
    if (!Array.isArray(value)) return null;
    if (!value.every(item => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const row = item as { id?: unknown; taggedUsers?: unknown; mentionedUsers?: unknown };
        const taggedUsersValid = row.taggedUsers === undefined
            || (Array.isArray(row.taggedUsers)
                && row.taggedUsers.every(username => typeof username === 'string'));
        const mentionedUsersValid = row.mentionedUsers === undefined
            || (Array.isArray(row.mentionedUsers)
                && row.mentionedUsers.every(username => typeof username === 'string'));
        return typeof row.id === 'string' && taggedUsersValid && mentionedUsersValid;
    })) return null;
    return value.map(item => {
        const row = item as { taggedUsers?: string[]; mentionedUsers?: string[] };
        return {
            taggedUsers: [...(row.taggedUsers ?? [])],
            mentionedUsers: [...(row.mentionedUsers ?? [])],
        };
    });
}

/** Reads only exact target-post mention fields from the source request checkpoint. */
export function targetPostMentionEvidenceFromStepData(
    stepData: unknown,
): readonly ConciergeTargetPostMentionEvidence[] {
    if (!stepData || typeof stepData !== 'object' || Array.isArray(stepData)) {
        throw new Error('CONCIERGE_TARGET_POSTS_UNAVAILABLE');
    }
    const root = stepData as {
        targetPosts?: unknown;
        targetProfileCheckpoint?: { targetPosts?: unknown };
    };
    const targetPosts = parseTargetPostMentionEvidence(root.targetPosts)
        ?? parseTargetPostMentionEvidence(root.targetProfileCheckpoint?.targetPosts);
    if (!targetPosts) throw new Error('CONCIERGE_TARGET_POSTS_UNAVAILABLE');
    return Object.freeze(targetPosts.map(post => Object.freeze(post)));
}

function normalizedUsername(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

function canonicalCandidateId(username: string): string {
    const normalized = normalizedUsername(username);
    return `candidate:${createHash('sha256').update(
        `analysis-v2-candidate-id-v1\n${normalized}`,
        'utf8',
    ).digest('hex').slice(0, 40)}`;
}

function requireRelationshipSides(
    rows: readonly ConciergeRelationshipEvidence[],
    username: string,
): {
    follower: ConciergeRelationshipEvidence | undefined;
    following: ConciergeRelationshipEvidence | undefined;
} {
    const matching = rows.filter(row => normalizedUsername(row.username) === username);
    const follower = matching.find(row => row.side === 'follower');
    const following = matching.find(row => row.side === 'following');
    if (
        matching.length === 0
        || matching.filter(row => row.side === 'follower').length > 1
        || matching.filter(row => row.side === 'following').length > 1
    ) {
        throw new Error('CONCIERGE_PRIVACY_RELATIONSHIP_EVIDENCE_INCOMPLETE');
    }
    if (follower && following && follower.isPrivate !== following.isPrivate) {
        throw new Error('CONCIERGE_PRIVACY_RELATIONSHIP_SIDE_CONFLICT');
    }
    return { follower, following };
}

/**
 * Derives the account partition from retained profile and relationship provider surfaces.
 * Any retained relationship side must agree with the profile; false is never a default.
 */
export function deriveConciergePrivacyPartition(input: {
    profiles: readonly InstagramProfile[];
    relationshipRows: readonly ConciergeRelationshipEvidence[];
    /** Exact follow intersection mode. Missing profile hydration stays unresolved. */
    requireExactMutual?: boolean;
}): ConciergePrivacyPartition {
    const profilesByUsername = new Map<string, InstagramProfile>();
    for (const profile of input.profiles) {
        const username = normalizedUsername(profile.username);
        if (!username || profilesByUsername.has(username)) {
            throw new Error('CONCIERGE_PRIVACY_PROFILE_IDENTITY_CONFLICT');
        }
        profilesByUsername.set(username, profile);
    }
    const relationshipRows = input.relationshipRows.map(row => ({
        ...row,
        username: normalizedUsername(row.username),
    }));
    const relationshipKeys = new Set<string>();
    for (const row of relationshipRows) {
        const key = `${row.side}:${row.username}`;
        if (relationshipKeys.has(key)) {
            throw new Error('CONCIERGE_PRIVACY_RELATIONSHIP_EVIDENCE_INCOMPLETE');
        }
        relationshipKeys.add(key);
    }
    const followerNames = new Set(
        relationshipRows.filter(row => row.side === 'follower').map(row => row.username),
    );
    const orderedMutualUsernames = relationshipRows
        .filter(row => row.side === 'following' && followerNames.has(row.username))
        .sort((left, right) => left.ordinal - right.ordinal)
        .map(row => row.username);
    const mutualNames = new Set(orderedMutualUsernames);
    const publicProfiles: InstagramProfile[] = [];
    const privateProfiles: InstagramProfile[] = [];
    for (const [username, profile] of profilesByUsername) {
        const { follower, following } = requireRelationshipSides(relationshipRows, username);
        if (
            (follower && profile.isPrivate !== follower.isPrivate)
            || (following && profile.isPrivate !== following.isPrivate)
        ) {
            throw new Error('CONCIERGE_PRIVACY_PROVIDER_EVIDENCE_CONFLICT');
        }
        (profile.isPrivate ? privateProfiles : publicProfiles).push(profile);
    }
    if (input.requireExactMutual && [...profilesByUsername.keys()].some(username => !mutualNames.has(username))) {
        throw new Error('CONCIERGE_PRIVACY_PROFILE_NOT_EXACT_MUTUAL');
    }
    const unresolvedUsernames = input.requireExactMutual
        ? orderedMutualUsernames.filter(username => !profilesByUsername.has(username))
        : [];
    return Object.freeze({
        profiles: Object.freeze([...input.profiles]),
        publicProfiles: Object.freeze(publicProfiles),
        privateProfiles: Object.freeze(privateProfiles),
        unresolvedUsernames: Object.freeze(unresolvedUsernames),
        relationshipRows: Object.freeze(relationshipRows),
        orderedMutualUsernames: Object.freeze(orderedMutualUsernames),
    });
}

function accountContext(feature: FeatureAnalysisResult, profile: InstagramProfile): AccountContext {
    if (feature.features.accountContext !== 'official_group_or_brand') {
        return feature.features.accountContext;
    }
    return screenAnalysisV2OfficialAccount({
        modelAccountContext: feature.features.accountContext,
        fullName: profile.fullName ?? null,
        bio: profile.bio ?? null,
    }).accountContext;
}

function strongPartner(feature: FeatureAnalysisResult): boolean {
    return feature.features.partnerExclusionContext === 'none'
        && (feature.features.marriageEvidence === 'strong'
            || feature.features.partnerEvidence === 'strong');
}

function weakPartner(feature: FeatureAnalysisResult): boolean {
    return feature.features.partnerExclusionContext === 'none'
        && !strongPartner(feature)
        && (feature.features.marriageEvidence === 'possible'
            || feature.features.partnerEvidence === 'weak');
}

function exposureLevel(score: number): 'high' | 'medium' | 'low' {
    return score >= 0.66 ? 'high' : score >= 0.33 ? 'medium' : 'low';
}

function genderConfidence(detail: ReplayAccountAiDetail): number {
    const confidence = detail.triage?.assessment.confidence;
    return confidence === 'high' ? 0.9 : confidence === 'medium' ? 0.6 : 0.3;
}

function retainedPublicCopyEvidence(profile: InstagramProfile): {
    profileEvidence: string | null;
    feedEvidence: string[];
    structuralEvidence: string[];
} {
    const feedEvidence = (profile.latestPosts ?? []).flatMap(post => [
        ...(post.caption ? [post.caption] : []),
        ...(post.mediaItems ?? []).flatMap(item => item.caption ? [item.caption] : []),
    ]);
    return {
        profileEvidence: profile.bio ?? null,
        feedEvidence,
        structuralEvidence: [
            ...(profile.profilePicUrl ? ['프로필 이미지'] : []),
            ...((profile.latestPosts ?? []).some(post => (
                Boolean(post.imageUrl || post.thumbnailUrl || post.mediaItems?.some(item => (
                    item.imageUrl || item.thumbnailUrl
                )))
            )) ? ['사진 게시물'] : []),
        ],
    };
}

function conciergeBoundedOverview(value: unknown, evidence: ReturnType<typeof retainedPublicCopyEvidence>): string | null {
    if (typeof value !== 'string') return null;
    const overview = value.trim();
    const evidenceTerms = extractV211EvidenceTerms(evidence);
    if (overview.length < 25 || overview.length > 180
        || CONCIERGE_PUBLIC_IDENTIFIER_PATTERN.test(overview)
        || CONCIERGE_UUID_PATTERN.test(overview)
        || !hasRetainedPublicText(evidence)
        || evidenceTerms.length === 0
        || !evidenceTerms.some(term => overview.toLowerCase().includes(term.toLowerCase()))) {
        return null;
    }
    return overview;
}

function conciergeDisplayName(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const name = value.trim().replace(/\s+/gu, ' ');
    if (!name || CONCIERGE_PUBLIC_IDENTIFIER_PATTERN.test(name) || CONCIERGE_UUID_PATTERN.test(name)
        || /(?:대상\s*계정|후보\s*계정)/u.test(name)) {
        return null;
    }
    return name.endsWith('님') ? name : `${name}님`;
}

function buildConciergeRelaxedRiskNarrative(input: {
    copyEvidence: ReturnType<typeof retainedPublicCopyEvidence>;
    candidateFullName?: string | null;
    interactionObserved: boolean;
}): [string, string] {
    const candidate = conciergeDisplayName(input.candidateFullName);
    const terms = extractV211EvidenceTerms(input.copyEvidence);
    const first = terms.length >= 2
        ? `${candidate ? `${candidate}의 ` : ''}공개 기록에서 “${terms[0]}”와 “${terms[1]}” 관련 내용이 확인됩니다.`
        : terms.length === 1
            ? `${candidate ? `${candidate}의 ` : ''}공개 기록에서 “${terms[0]}” 관련 내용이 확인됩니다.`
            : candidate
                ? `${candidate}의 공개 소개·캡션 문구가 비어 있어, 사진에서 이야기를 지어내지 않고 확인되는 범위만 살펴봅니다.`
                : SPARSE_NO_NAME_OVERVIEW;
    const second = input.interactionObserved
        ? '확인된 공개 상호작용만을 근거로 흐름을 살피며, 관계를 단정하지 않고 수집 범위 밖 기록은 알 수 없습니다.'
        : '관계를 단정할 공개 상호작용은 확인되지 않았고, 수집 범위 밖 기록은 알 수 없습니다.';
    return [first, second];
}

function hasReliableAppearanceEvidence(
    profile: InstagramProfile,
    detail: ReplayAccountAiDetail,
): boolean {
    const appearanceGrade = detail.feature?.features.appearanceGrade ?? 0;
    const hasAnalyzableImage = Boolean(profile.profilePicUrl)
        || (profile.latestPosts ?? []).some(post => (
            Boolean(post.imageUrl || post.thumbnailUrl || post.mediaItems?.some(item => (
                item.imageUrl || item.thumbnailUrl
            )))
        ));
    return appearanceGrade >= 4 && hasAnalyzableImage;
}

function privateNameResultsByUsername(
    privateProfiles: readonly InstagramProfile[],
    rawResults: readonly PrivateNameAnalysisResult[],
): ReadonlyMap<string, PrivateNameAnalysisResult> {
    try {
        const accounts = privateNameAccountsInputSchema.parse(privateProfiles.map(profile => ({
            id: normalizedUsername(profile.username),
            username: profile.username,
            fullName: profile.fullName ?? undefined,
        })));
        const results = createPrivateNameBatchResponseSchema(accounts.map(account => account.id))
            .parse(rawResults);
        return new Map(accounts.map((account, index) => [
            account.username,
            results[index]!,
        ]));
    } catch {
        throw new Error('CONCIERGE_PRIVATE_NAME_CONTRACT_MISMATCH');
    }
}

function compareNormalizedUsername(left: string, right: string): number {
    // Match the live publication RPC's en_US.UTF-8 text ordering for the
    // final tie-breaker. PostgreSQL places punctuation such as `_` before
    // `.` under that collation, unlike a JavaScript code-unit comparison.
    return left.localeCompare(right, 'en-US');
}

/** `private_accounts` persists these fields as PostgreSQL REAL values. */
function privateNameScoreForStorage(value: number): number {
    return Math.fround(value);
}

/** Builds legacy rows only from canonical V2 final scores and canonical safe narratives. */
export function buildCanonicalConciergeResult(input: {
    targetUsername: string;
    targetFullName?: string | null;
    profilesByOrdinal: ReadonlyMap<number, InstagramProfile>;
    details: readonly ReplayAccountAiDetail[];
    orderedMutualUsernames: readonly string[];
    targetInteractions: readonly RawTargetInteractionEvidence[];
    targetPosts: readonly ConciergeTargetPostMentionEvidence[];
    privateProfiles: readonly InstagramProfile[];
    privateNameResults?: readonly PrivateNameAnalysisResult[];
    /** Public usernames whose exact relationship identity is known but whose bounded
     * profile-only hydration exhausted its approved slots; these are unknown, never
     * female candidates, and must carry provenance in the publication fingerprint. */
    unknownPublicUsernames?: readonly string[];
    /** Batch-only draft mode defers high-risk copy until the operator Gemini pass. */
    deferHighRiskCopy?: boolean;
    /** Ordinals explicitly promoted through the concierge name-only path. */
    nameOnlyOrdinals?: ReadonlySet<number>;
}): {
    femaleRows: readonly ConciergeLegacyResultRow[];
    privateRows: readonly ConciergePrivateAccountRow[];
    counts: { male: number; female: number; unknownPublic: number; unknown: number };
} {
    const maleDetails = input.details.filter(detail => detail.finalClassification === 'verified_non_female');
    const femaleDetails = input.details.filter(detail => (
        detail.finalClassification === 'verified_female'
        && (detail.feature !== null || input.nameOnlyOrdinals?.has(detail.ordinal) === true)
    ));
    const unknownPublic = input.details.length - maleDetails.length - femaleDetails.length
        + (input.unknownPublicUsernames?.length ?? 0);
    if (input.details.some(detail => (
        detail.finalClassification === 'verified_non_female'
        && input.profilesByOrdinal.get(detail.ordinal)
        && femaleDetails.some(female => female.ordinal === detail.ordinal)
    ))) {
        throw new Error('CONCIERGE_GENDER_RESULT_CONFLICT');
    }
    const femaleUsernames = femaleDetails.map(detail => {
        const profile = input.profilesByOrdinal.get(detail.ordinal);
        if (!profile) throw new Error('CONCIERGE_GENDER_PROFILE_IDENTITY_MISSING');
        return normalizedUsername(profile.username);
    });
    const joined = joinVerifiedFemaleTargetInteractions({
        evidence: input.targetInteractions,
        verifiedFemaleUsernames: femaleUsernames,
        excludedUsername: null,
    });
    const interactions = new Map(
        summarizeCandidateTargetInteractions(joined)
            .map(summary => [summary.candidateUsername, summary]),
    );
    const candidates = femaleDetails.map(detail => {
        const profile = input.profilesByOrdinal.get(detail.ordinal);
        const feature = detail.feature;
        const nameOnly = input.nameOnlyOrdinals?.has(detail.ordinal) === true;
        if (!profile || (!feature && !nameOnly)) throw new Error('CONCIERGE_GENDER_FEATURE_MISSING');
        const username = normalizedUsername(profile.username);
        const interaction = interactions.get(username);
        const mentions = hasCandidateTargetMention({
            targetUsername: input.targetUsername,
            candidateUsername: username,
            targetPosts: input.targetPosts,
            candidatePosts: profile.latestPosts ?? [],
        });
        return {
            candidateId: canonicalCandidateId(username),
            username,
            appearanceGrade: (feature?.features.appearanceGrade ?? 1) as AppearanceGrade,
            exposureScore: feature?.features.exposureScore ?? 0,
            accountContext: feature ? accountContext(feature, profile) : 'uncertain',
            hasWeakPartnerEvidence: feature ? weakPartner(feature) : false,
            hasStrongPartnerEvidence: feature ? strongPartner(feature) : false,
            uniqueTargetPostsLikedByCandidate: interaction?.uniqueTargetPostsLikedByCandidate ?? 0,
            boundedCandidateCommentsOnTarget: interaction?.boundedCandidateCommentsOnTarget ?? 0,
            hasCandidateToTargetTagOrCaptionMention: mentions.candidateToTargetTagOrCaptionMention,
            hasTargetToCandidateTagOrCaptionMention: mentions.targetToCandidateTagOrCaptionMention,
        };
    });
    const preliminary = calculateV2PreliminaryScores({
        candidates,
        orderedMutualUsernames: input.orderedMutualUsernames,
        excludedUsername: null,
        riskPolicyVersion: 'risk-policy-v2.5',
    });
    const finalScores = calculateV2FinalScores({
        preliminary,
        observedReverseLikeCandidateIds: new Set(),
        notCollectedCandidateIds: new Set(preliminary.map(row => row.candidateId)),
        riskPolicyVersion: 'risk-policy-v2.5',
    }).sort((left, right) => (
        right.displayScore - left.displayScore || left.candidateId.localeCompare(right.candidateId)
    ));
    const detailByCandidate = new Map(femaleDetails.map(detail => {
        const profile = input.profilesByOrdinal.get(detail.ordinal);
        if (!profile) throw new Error('CONCIERGE_GENDER_PROFILE_IDENTITY_MISSING');
        return [canonicalCandidateId(profile.username), { detail, profile }];
    }));
    const femaleRows = finalScores.map((score, index) => {
        const retained = detailByCandidate.get(score.candidateId);
        if (!retained) throw new Error('CONCIERGE_GENDER_RESULT_MISSING');
        const nameOnly = input.nameOnlyOrdinals?.has(retained.detail.ordinal) === true;
        const feature = retained.detail.feature;
        const interaction = interactions.get(normalizedUsername(retained.profile.username));
        const commentText = joined.find(row => (
            row.candidateUsername === normalizedUsername(retained.profile.username)
            && row.signal === 'female_target_comment'
        ))?.content;
        const copyEvidence = retainedPublicCopyEvidence(retained.profile);
        const subjects = {
            targetUsername: input.targetUsername,
            targetFullName: input.targetFullName ?? null,
            candidateUsername: retained.profile.username,
            candidateFullName: retained.profile.fullName ?? null,
        };
        const interactionEvidence = {
            candidateLikedTarget: (interaction?.uniqueTargetPostsLikedByCandidate ?? 0) > 0,
            candidateCommentedOnTarget: (interaction?.boundedCandidateCommentsOnTarget ?? 0) > 0,
            targetLikedCandidate: false,
            candidateTaggedTarget: score.hasCandidateToTargetTagOrCaptionMention,
            targetTaggedCandidate: score.hasTargetToCandidateTagOrCaptionMention,
            ...(commentText ? { commentText } : {}),
        };
        const deferHighRiskCopy = input.deferHighRiskCopy === true && score.riskBand === 'high_risk';
        let narrative: readonly string[] = [];
        if (deferHighRiskCopy) {
            narrative = [BATCH_HIGH_RISK_COPY_DEFERRED_NARRATIVE, BATCH_HIGH_RISK_COPY_DEFERRED_NARRATIVE];
        } else if (score.riskBand === 'high_risk' && nameOnly) {
            narrative = buildConciergeRelaxedRiskNarrative({
                copyEvidence,
                candidateFullName: retained.profile.fullName,
                interactionObserved: Object.values(interactionEvidence)
                    .some(value => typeof value === 'boolean' && value),
            });
        } else if (score.riskBand === 'high_risk') {
            try {
                narrative = buildV211EvidenceSpecificRiskNarrative({
                    ...copyEvidence,
                    subjects,
                    ...interactionEvidence,
                    appearance: { isReliable: hasReliableAppearanceEvidence(retained.profile, retained.detail) },
                });
            } catch (error) {
                const code = error instanceof Error ? error.message : '';
                if (![
                    'CONCIERGE_COPY_INTERACTION_EVIDENCE_UNAVAILABLE',
                    'CONCIERGE_COPY_NARRATIVE_CONTRACT_FAILED',
                    'CONCIERGE_COPY_SUBJECT_REQUIRED',
                    'CONCIERGE_COPY_SUBJECT_CONFLICT',
                ].includes(code)) throw error;
                narrative = buildConciergeRelaxedRiskNarrative({
                    copyEvidence,
                    candidateFullName: retained.profile.fullName,
                    interactionObserved: Object.values(interactionEvidence)
                        .some(value => typeof value === 'boolean' && value),
                });
            }
        }
        let overview: string;
        if (deferHighRiskCopy) {
            overview = BATCH_HIGH_RISK_COPY_DEFERRED_OVERVIEW;
        } else if (nameOnly) {
            overview = SPARSE_NO_NAME_OVERVIEW;
        } else {
            const retainedOverview = conciergeBoundedOverview(
                feature!.features.oneLineOverview,
                copyEvidence,
            );
            if (retainedOverview) {
                overview = retainedOverview;
            } else {
                try {
                    overview = needsV211EvidenceSpecificOverview(
                        feature!.features.oneLineOverview,
                        copyEvidence,
                    )
                        ? buildV211EvidenceSpecificOverview({
                            ...copyEvidence,
                            variation: index,
                        })
                        : feature!.features.oneLineOverview;
                } catch (error) {
                    if (!(error instanceof Error) || error.message !== 'CONCIERGE_COPY_EVIDENCE_UNAVAILABLE') {
                        throw error;
                    }
                    const textEvidenceAbsent = !hasRetainedPublicText(copyEvidence);
                    try {
                        overview = buildV213SparseEvidenceOverview({
                            ...interactionEvidence,
                            subjects,
                            reviewOrdinal: index,
                            textEvidenceAbsent,
                        }).overview;
                    } catch (sparseError) {
                        if (sparseError instanceof Error
                            && [
                                'CONCIERGE_COPY_INTERACTION_EVIDENCE_UNAVAILABLE',
                                'CONCIERGE_COPY_EVIDENCE_UNAVAILABLE',
                                'CONCIERGE_COPY_SPARSE_SUBJECTS_REQUIRED',
                            ].includes(sparseError.message)
                            && !textEvidenceAbsent) {
                            overview = SPARSE_TEXT_PRESENT_OVERVIEW;
                        } else if (!(sparseError instanceof Error)
                            || sparseError.message !== 'CONCIERGE_COPY_SPARSE_SUBJECTS_REQUIRED'
                            || !textEvidenceAbsent) {
                            throw sparseError;
                        } else {
                            // The global v2.13 builder requires a display name because its
                            // normal sparse copy names the candidate. Concierge can retain
                            // a valid no-text profile without inventing an identifier in
                            // the overview, so use the name-free absence statement only
                            // for this exact no-text branch.
                            overview = SPARSE_NO_NAME_OVERVIEW;
                        }
                    }
                }
            }
        }
        if (overview.length === 0 || overview.length > 180) {
            throw new Error('CONCIERGE_OVERVIEW_REQUIRED');
        }
        return {
            rank: index + 1,
            suspect_instagram_id: normalizedUsername(retained.profile.username),
            suspect_profile_image: retained.profile.profilePicUrl ?? null,
            suspect_full_name: retained.profile.fullName ?? null,
            bio: retained.profile.bio ?? null,
            risk_score: Math.round(score.displayScore * 10),
            photogenic_grade: (feature?.features.appearanceGrade ?? 1) as AppearanceGrade,
            exposure_level: feature ? exposureLevel(feature.features.exposureScore) : 'low',
            is_tagged: score.hasCandidateToTargetTagOrCaptionMention,
            risk_grade: score.riskBand,
            gender_confidence: genderConfidence(retained.detail),
            gender_status: 'confirmed' as const,
            is_unlocked: true as const,
            likes_count: interaction?.uniqueTargetPostsLikedByCandidate ?? 0,
            intimate_comments_count: interaction?.boundedCandidateCommentsOnTarget ?? 0,
            one_line_overview: overview,
            // Featured high-risk rows retain their canonical two-line narrative
            // contract; other rows have no narrative payload.
            risk_analysis: score.riskBand === 'high_risk' ? narrative : [],
        };
    });
    const privateNames = privateNameResultsByUsername(
        input.privateProfiles,
        input.privateNameResults ?? [],
    );
    const privateRows = input.privateProfiles.map(profile => {
        const instagramId = normalizedUsername(profile.username);
        const name = privateNames.get(instagramId);
        if (!name) throw new Error('CONCIERGE_PRIVATE_NAME_CONTRACT_MISMATCH');
        return {
            instagram_id: instagramId,
            profile_image: profile.profilePicUrl ?? null,
            full_name: profile.fullName ?? null,
            name_female_score: privateNameScoreForStorage(name.femaleScore),
            name_is_name: name.isName,
            name_confidence: privateNameScoreForStorage(name.confidence),
        };
    }).sort((left, right) => (
        right.name_female_score - left.name_female_score
        || right.name_confidence - left.name_confidence
        || compareNormalizedUsername(left.instagram_id, right.instagram_id)
    )).map((row, index) => ({ ...row, sort_ordinal: index + 1 }));
    if (new Set(femaleRows.map(row => row.suspect_instagram_id)).size !== femaleRows.length) {
        throw new Error('CONCIERGE_GENDER_RESULT_IDENTITY_CONFLICT');
    }
    if (femaleRows.some(row => row.risk_grade === 'high_risk' && row.risk_analysis.length === 0)) {
        throw new Error('CONCIERGE_NARRATIVE_REQUIRED');
    }
    return {
        femaleRows: Object.freeze(femaleRows),
        privateRows: Object.freeze(privateRows),
        counts: {
            male: maleDetails.length,
            female: femaleDetails.length,
            unknownPublic,
            // Private accounts are deliberately excluded from gender totals. They are
            // exposed through privateRows and are never sent to the AI gender resolver.
            unknown: unknownPublic,
        },
    };
}

export function validateCanonicalConciergeCorrection(input: {
    fetchedCount: number;
    partition: Pick<ConciergePrivacyPartition, 'publicProfiles' | 'privateProfiles'> & {
        unresolvedUsernames?: readonly string[];
    };
    result: ReturnType<typeof buildCanonicalConciergeResult>;
}): void {
    const { fetchedCount, partition, result } = input;
    const unresolvedCount = partition.unresolvedUsernames?.length ?? 0;
    if (partition.publicProfiles.length + partition.privateProfiles.length + unresolvedCount !== fetchedCount) {
        throw new Error('CONCIERGE_COUNT_RECONCILIATION_FAILED');
    }
    if (result.counts.male + result.counts.female + result.counts.unknown !== partition.publicProfiles.length) {
        throw new Error('CONCIERGE_GENDER_COUNT_RECONCILIATION_FAILED');
    }
    if (result.femaleRows.some(row => row.risk_grade === 'high_risk' && row.risk_analysis.length === 0)) {
        throw new Error('CONCIERGE_NARRATIVE_REQUIRED');
    }
    if (result.femaleRows.some(row => (
        !Number.isFinite(row.risk_score)
        || !Number.isSafeInteger(row.risk_score)
        || row.risk_score < 10
        || row.risk_score > 100
    ))) {
        throw new Error('CONCIERGE_RISK_SCORE_INVALID');
    }
    if (result.femaleRows.some(row => (
        !isRiskBandCompatibleWithDisplayScore(row.risk_score / 10, row.risk_grade)
    ))) {
        throw new Error('CONCIERGE_RISK_SCORE_GRADE_MISMATCH');
    }
    if (result.femaleRows.some(row => (
        !row.one_line_overview
        || row.one_line_overview.length > 180
        || (row.risk_grade !== 'high_risk' && row.risk_analysis.length !== 0)
    ))) {
        throw new Error('CONCIERGE_OVERVIEW_REQUIRED');
    }
}
