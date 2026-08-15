import { createHash } from 'node:crypto';
import type { FeatureAnalysisResult, HighRiskNarrativeInput } from '@/lib/services/ai/v2-staged-analysis';
import type { InstagramProfile } from '@/lib/types/instagram';
import type { InteractionEvidenceRow } from './interaction-stage';

export type RetainedObservation =
    | { readonly status: 'observed'; readonly evidenceRefIds: readonly [string, ...string[]] }
    | { readonly status: 'not_observed'; readonly evidenceRefIds: readonly [] }
    | { readonly status: 'not_collected'; readonly evidenceRefIds: readonly [] };

export interface RetainedNarrativeProfile {
    profile: InstagramProfile;
    selectedPostEvidence: readonly {
        postId: string;
        selectionId: string;
        taggedUsers: readonly string[];
        mentionedUsers: readonly string[];
    }[];
}

export interface RetainedBidirectionalNarrativeInputArgs {
    target: RetainedNarrativeProfile;
    candidate: RetainedNarrativeProfile;
    feature: FeatureAnalysisResult;
    candidateToTargetInteractions: readonly InteractionEvidenceRow[];
    targetToCandidateLike: RetainedObservation;
}

export type RetainedBidirectionalNarrativeInput = HighRiskNarrativeInput & {
    interactions: HighRiskNarrativeInput['interactions'] & {
        targetToCandidateComment: RetainedObservation;
    };
};

function clean(value: string | null | undefined, max: number): string | null {
    if (!value) return null;
    const result = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    return result ? [...result].slice(0, max).join('') : null;
}

function username(value: string): string {
    const result = value.trim().replace(/^@/u, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(result)) throw new Error('FIRST_PAYMENT_CONCIERGE_USERNAME_INVALID');
    return result;
}

function comparableUsername(value: string): string {
    return value.trim().replace(/^@/u, '').toLowerCase();
}

function canonicalName(value: string | undefined): string {
    const result = clean(value, 200);
    if (!result || /(?:대상\s*계정|후보\s*계정)/u.test(result)) {
        throw new Error('FIRST_PAYMENT_CONCIERGE_CANONICAL_NAME_MISSING');
    }
    return result;
}

function opaque(domain: string, value: unknown): string {
    return `retained:${domain}:${createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 48)}`;
}

function observation(refs: readonly string[]): RetainedObservation {
    const unique = [...new Set(refs.map(value => value.trim()).filter(Boolean))].slice(0, 8);
    return (unique.length ? { status: 'observed', evidenceRefIds: unique } : { status: 'not_observed', evidenceRefIds: [] }) as RetainedObservation;
}

function validateObservation(value: RetainedObservation): RetainedObservation {
    if (value.status === 'observed') {
        if (value.evidenceRefIds.length < 1 || value.evidenceRefIds.length > 8
            || value.evidenceRefIds.some(ref => typeof ref !== 'string' || ref.trim().length === 0)) {
            throw new Error('FIRST_PAYMENT_CONCIERGE_RETAINED_OBSERVATION_INVALID');
        }
    } else if (value.evidenceRefIds.length !== 0) {
        throw new Error('FIRST_PAYMENT_CONCIERGE_RETAINED_OBSERVATION_INVALID');
    }
    return value;
}

function postDirection(input: RetainedNarrativeProfile, subject: string, field: 'taggedUsers' | 'mentionedUsers'): RetainedObservation {
    const refs = input.selectedPostEvidence
        .filter(post => post[field].some(value => comparableUsername(value) === subject))
        .map(post => post.selectionId);
    return observation(refs);
}

export function buildRetainedBidirectionalNarrativeInput(
    input: RetainedBidirectionalNarrativeInputArgs,
): RetainedBidirectionalNarrativeInput {
    const targetUsername = username(input.target.profile.username);
    const candidateUsername = username(input.candidate.profile.username);
    if (targetUsername === candidateUsername) throw new Error('FIRST_PAYMENT_CONCIERGE_USERNAME_INVALID');
    const rows = input.candidateToTargetInteractions.filter(row => username(row.candidateUsername) === candidateUsername);
    const likes = rows.filter(row => row.signal === 'female_target_like');
    const commentRows = rows.filter(row => row.signal === 'female_target_comment' && clean(row.content, 300));
    const comments = [...new Map(commentRows.map(row => {
        const evidenceRefId = opaque('interaction', { candidateUsername, postId: row.postId, signal: row.signal, sourceInteractionId: row.sourceInteractionId });
        return [evidenceRefId, {
            evidenceRefId,
            targetPostEvidenceRefId: opaque('target-post', row.postId),
            text: clean(row.content, 300)!,
        }];
    })).values()].slice(0, 8);
    const candidateToTargetLike = observation(likes.map(row => opaque('interaction', { candidateUsername, postId: row.postId, signal: row.signal, sourceInteractionId: row.sourceInteractionId })));
    const candidateToTargetComment = observation(comments.map(row => row.evidenceRefId));
    const media = [] as HighRiskNarrativeInput['media'];
    return {
        forbiddenIdentifiers: { targetUsername, candidateUsername },
        publicSubjects: { targetFullName: canonicalName(input.target.profile.fullName), candidateFullName: canonicalName(input.candidate.profile.fullName) },
        appearance: {
            isReliable: input.feature.features.evidenceSelectionIds.appearance.some(selectionId => (
                input.candidate.selectedPostEvidence.some(post => post.selectionId === selectionId)
            )),
        },
        bio: clean(input.candidate.profile.bio, 2_200), media, captions: [], carouselCaptionDossier: null,
        interactions: {
            candidateToTargetLike, candidateToTargetComment,
            targetToCandidateLike: validateObservation(input.targetToCandidateLike),
            candidateToTargetTag: postDirection(input.candidate, targetUsername, 'taggedUsers'),
            candidateToTargetMention: postDirection(input.candidate, targetUsername, 'mentionedUsers'),
            targetToCandidateTag: postDirection(input.target, candidateUsername, 'taggedUsers'),
            targetToCandidateMention: postDirection(input.target, candidateUsername, 'mentionedUsers'),
            targetToCandidateComment: { status: 'not_collected', evidenceRefIds: [] }, comments,
            coverage: { status: 'partial', evidenceRefId: opaque('coverage', [targetUsername, candidateUsername]) },
        },
    } as unknown as RetainedBidirectionalNarrativeInput;
}
