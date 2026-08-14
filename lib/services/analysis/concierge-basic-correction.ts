import { createHash } from 'node:crypto';
import type { AccountContext, AppearanceGrade } from '@/lib/domain/analysis/risk-policy';
import type { FeatureAnalysisResult } from '@/lib/services/ai/v2-staged-analysis';
import type { ReplayAccountAiDetail } from './replay/replay-runner';
import type { InstagramProfile } from '@/lib/types/instagram';
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
import { buildSafeFallbackRiskNarrative } from './narrative-privacy';

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
    risk_analysis: readonly string[];
}

export interface ConciergePrivateAccountRow {
    instagram_id: string;
    profile_image: string | null;
    full_name: string | null;
    name_female_score: null;
    name_is_name: null;
    name_confidence: null;
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

/** Builds legacy rows only from canonical V2 final scores and canonical safe narratives. */
export function buildCanonicalConciergeResult(input: {
    targetUsername: string;
    profilesByOrdinal: ReadonlyMap<number, InstagramProfile>;
    details: readonly ReplayAccountAiDetail[];
    orderedMutualUsernames: readonly string[];
    targetInteractions: readonly RawTargetInteractionEvidence[];
    privateProfiles: readonly InstagramProfile[];
}): {
    femaleRows: readonly ConciergeLegacyResultRow[];
    privateRows: readonly ConciergePrivateAccountRow[];
    counts: { male: number; female: number; unknownPublic: number; unknown: number };
} {
    const maleDetails = input.details.filter(detail => detail.finalClassification === 'verified_non_female');
    const femaleDetails = input.details.filter(detail => (
        detail.finalClassification === 'verified_female' && detail.feature !== null
    ));
    const unknownPublic = input.details.length - maleDetails.length - femaleDetails.length;
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
        if (!profile || !feature) throw new Error('CONCIERGE_GENDER_FEATURE_MISSING');
        const username = normalizedUsername(profile.username);
        const interaction = interactions.get(username);
        const mentions = hasCandidateTargetMention({
            targetUsername: input.targetUsername,
            candidateUsername: username,
            targetPosts: [],
            candidatePosts: profile.latestPosts ?? [],
        });
        return {
            candidateId: canonicalCandidateId(username),
            username,
            appearanceGrade: feature.features.appearanceGrade as AppearanceGrade,
            exposureScore: feature.features.exposureScore,
            accountContext: accountContext(feature, profile),
            hasWeakPartnerEvidence: weakPartner(feature),
            hasStrongPartnerEvidence: strongPartner(feature),
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
        if (!retained?.detail.feature) throw new Error('CONCIERGE_GENDER_RESULT_MISSING');
        const interaction = interactions.get(normalizedUsername(retained.profile.username));
        const commentText = joined.find(row => (
            row.candidateUsername === normalizedUsername(retained.profile.username)
            && row.signal === 'female_target_comment'
        ))?.content;
        const narrative = score.riskBand === 'high_risk'
            ? buildSafeFallbackRiskNarrative({
                candidateLikedTarget: (interaction?.uniqueTargetPostsLikedByCandidate ?? 0) > 0,
                candidateCommentedOnTarget: (interaction?.boundedCandidateCommentsOnTarget ?? 0) > 0,
                targetLikedCandidate: false,
                ...(commentText ? { commentText } : {}),
            })
            : [];
        return {
            rank: index + 1,
            suspect_instagram_id: normalizedUsername(retained.profile.username),
            suspect_profile_image: retained.profile.profilePicUrl ?? null,
            suspect_full_name: retained.profile.fullName ?? null,
            bio: retained.profile.bio ?? null,
            risk_score: Math.round(score.displayScore * 10),
            photogenic_grade: retained.detail.feature.features.appearanceGrade as AppearanceGrade,
            exposure_level: exposureLevel(retained.detail.feature.features.exposureScore),
            is_tagged: score.hasCandidateToTargetTagOrCaptionMention,
            risk_grade: score.riskBand,
            gender_confidence: genderConfidence(retained.detail),
            gender_status: 'confirmed' as const,
            is_unlocked: true as const,
            likes_count: interaction?.uniqueTargetPostsLikedByCandidate ?? 0,
            intimate_comments_count: interaction?.boundedCandidateCommentsOnTarget ?? 0,
            risk_analysis: narrative,
        };
    });
    const privateRows = input.privateProfiles.map(profile => ({
        instagram_id: normalizedUsername(profile.username),
        profile_image: profile.profilePicUrl ?? null,
        full_name: profile.fullName ?? null,
        name_female_score: null,
        name_is_name: null,
        name_confidence: null,
    }));
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
}
