import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AccountContext, AppearanceGrade } from '@/lib/domain/analysis/risk-policy';
import { createAnalysisV2SelectedMediaNormalizer } from '@/lib/services/ai/image-preprocessing';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import {
    createHighRiskNarrativeResultIdentity,
    highRiskNarrative,
    type FeatureAnalysisResult,
    type HighRiskNarrativeInput,
    type StagedAiAuditContext,
} from '@/lib/services/ai/v2-staged-analysis';
import type { InstagramProfile } from '@/lib/types/instagram';
import { analysisV2CheckpointProfileSchema } from './v2-profile-fetch-store';
import {
    analysisV2CandidateId,
} from './v2-ai-scoring-executors';
import {
    calculateV2FinalScores,
    calculateV2PreliminaryScores,
    hasCandidateTargetMention,
} from './v2-candidate-scoring';
import type { InteractionEvidenceRow } from './interaction-stage';
import {
    joinVerifiedFemaleTargetInteractions,
    summarizeCandidateTargetInteractions,
} from './v2-target-interactions';
import { screenAnalysisV2OfficialAccount } from './v2-official-account-screening';
import {
    captureAnalysisV2ReplayBundle,
} from './replay/replay-capture';
import {
    analysisV2ReplaySemanticInputFingerprint,
    type AnalysisV2ReplayBundle,
} from './replay/replay-bundle';
import {
    runAnalysisV2AiReplay,
    type AnalysisV2AiReplayReport,
    type ReplayAccountAiDetail,
} from './replay/replay-runner';
import { createReplayStagedAiAdapter } from './replay/replay-staged-ai-adapter';
import {
    FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
    type ReplayEvaluationPolicy,
    type ReplaySourceLineage,
} from './replay/replay-source-lineage';
import type { FirstPaymentConciergeSource } from './first-payment-concierge-source';

const SHA256 = /^[a-f0-9]{64}$/;
const USERNAME = /^[a-z0-9._]{1,30}$/;
const CANDIDATE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const sourceLineage = Object.freeze({
    selectedPlanId: 'basic',
    policyVersions: {
        pipeline: 'v2',
        aiStage: AI_STAGE_POLICY_V211_VERSION,
        risk: 'risk-policy-v2.5',
        scheduler: 'ai-scheduler-v1',
    },
} as const) satisfies ReplaySourceLineage;

export const firstPaymentConciergeEvaluationPolicy = Object.freeze({
    capability: FIRST_PAYMENT_BASIC_V211_CONCIERGE_CAPABILITY,
    aiStage: AI_STAGE_POLICY_V211_VERSION,
} as const) satisfies ReplayEvaluationPolicy;

const countsSchema = z.object({
    followersDeclared: z.number().int().min(390).max(400),
    followersCollected: z.literal(390),
    followingDeclared: z.number().int().min(256).max(400),
    followingCollected: z.literal(256),
    detectedMutuals: z.literal(182),
    publicMutuals: z.literal(134),
    privateMutuals: z.literal(48),
    screenedMutuals: z.literal(134),
    notScreenedMutuals: z.literal(0),
    fetchUnavailableCount: z.literal(5),
    mediaUnavailableCount: z.number().int().min(0).max(129),
    analysisUnavailableCount: z.number().int().min(0).max(129),
    male: z.number().int().min(0).max(129),
    female: z.number().int().min(0).max(129),
    unknown: z.number().int().min(5).max(134),
}).strict();

const femaleRowSchema = z.object({
    candidateId: z.string().regex(CANDIDATE_ID),
    sortOrdinal: z.number().int().min(1).max(130),
    instagramId: z.string().regex(USERNAME),
    fullName: z.string().min(1).max(200).nullable(),
    profileImageUrl: z.null(),
    bio: z.string().min(1).max(2_200).nullable(),
    displayScore: z.number().min(1).max(10),
    riskBand: z.enum(['normal', 'caution', 'high_risk']),
    featuredRank: z.number().int().min(1).max(15).nullable(),
    recentMutualRank: z.number().int().min(1).max(10).nullable(),
    analysisDepth: z.enum(['features', 'narrative']),
    oneLineOverview: z.string().min(1).max(180),
    narrativeLineOne: z.string().min(1).max(180).nullable(),
    narrativeLineTwo: z.string().min(1).max(180).nullable(),
}).strict().superRefine((row, context) => {
    const narrativeRequired = row.riskBand === 'high_risk'
        && row.featuredRank !== null
        && row.featuredRank <= 3;
    if (narrativeRequired !== (row.analysisDepth === 'narrative')) {
        context.addIssue({ code: 'custom', message: 'Narrative depth drift.' });
    }
    if (
        narrativeRequired
            !== (row.narrativeLineOne !== null && row.narrativeLineTwo !== null)
    ) {
        context.addIssue({ code: 'custom', message: 'Narrative row drift.' });
    }
});

const privateRowSchema = z.object({
    candidateId: z.string().regex(CANDIDATE_ID),
    sortOrdinal: z.number().int().min(1).max(48),
    instagramId: z.string().regex(USERNAME),
    fullName: z.string().min(1).max(200).nullable(),
    profileImageUrl: z.null(),
}).strict();

export const firstPaymentConciergePublicationPayloadSchema = z.object({
    schemaVersion: z.literal(1),
    descriptorHash: z.string().regex(SHA256),
    evidenceHash: z.string().regex(SHA256),
    semanticInputFingerprint: z.string().regex(SHA256),
    targetFullName: z.string().min(1).max(200).nullable(),
    counts: countsSchema,
    femaleRows: z.array(femaleRowSchema).max(130),
    privateRows: z.array(privateRowSchema).length(48),
}).strict().superRefine((payload, context) => {
    const counts = payload.counts;
    if (
        counts.male + counts.female + counts.unknown !== counts.screenedMutuals
        || counts.female !== payload.femaleRows.length
        || counts.fetchUnavailableCount + counts.mediaUnavailableCount
            + counts.analysisUnavailableCount > counts.unknown
    ) {
        context.addIssue({ code: 'custom', message: 'Publication count drift.' });
    }
    const candidateIds = [
        ...payload.femaleRows.map(row => row.candidateId),
        ...payload.privateRows.map(row => row.candidateId),
    ];
    const usernames = [
        ...payload.femaleRows.map(row => row.instagramId),
        ...payload.privateRows.map(row => row.instagramId),
    ];
    if (
        new Set(candidateIds).size !== candidateIds.length
        || new Set(usernames).size !== usernames.length
        || payload.femaleRows.some((row, index) => row.sortOrdinal !== index + 1)
        || payload.privateRows.some((row, index) => row.sortOrdinal !== index + 1)
    ) {
        context.addIssue({ code: 'custom', message: 'Publication identity drift.' });
    }
});

export type FirstPaymentConciergePublicationPayload = z.infer<
    typeof firstPaymentConciergePublicationPayloadSchema
>;

export interface FirstPaymentConciergeCapturedBundle {
    bundle: Extract<AnalysisV2ReplayBundle, { schemaVersion: 1 }>;
    fetchUnavailableOrdinals: readonly number[];
    mediaUnavailableOrdinals: readonly number[];
}

function sanitized(value: string | null | undefined, maximum: number): string | null {
    if (!value) return null;
    const normalized = value.normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized ? [...normalized].slice(0, maximum).join('') : null;
}

function canonical(value: unknown): string {
    if (value === undefined) return 'null';
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    const record = value as Readonly<Record<string, unknown>>;
    return `{${Object.keys(record).filter(key => record[key] !== undefined).sort()
        .map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

function hash(domain: string, value: unknown): string {
    return createHash('sha256').update(`${domain}\n${canonical(value)}`).digest('hex');
}

export function firstPaymentConciergeSafeFailureCode(error: unknown): string {
    const messages: string[] = [];
    let current = error;
    for (let depth = 0; depth < 3 && current instanceof Error; depth++) {
        messages.push(current.message);
        current = current.cause;
    }
    for (const message of messages) {
        const match = /^([A-Z][A-Z0-9_]{2,119})(?::|$)/.exec(message);
        if (match?.[1]) return match[1];
    }
    if (error instanceof z.ZodError) {
        return 'FIRST_PAYMENT_CONCIERGE_ZOD_VALIDATION_FAILED';
    }
    return 'FIRST_PAYMENT_CONCIERGE_UNCLASSIFIED_FAILURE';
}

async function runBounded<T>(
    values: readonly T[],
    concurrency: number,
    worker: (value: T) => Promise<void>,
): Promise<void> {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
        while (next < values.length) {
            const value = values[next++];
            if (value !== undefined) await worker(value);
        }
    }));
}

function replayEvidence(source: FirstPaymentConciergeSource): AnalysisV2ReplayBundle['evidence'] {
    return {
        relationship: source.mutualRows.flatMap(row => ([
            {
                username: row.username,
                side: 'follower' as const,
                isPrivate: row.isPrivate,
                isVerified: row.isVerified,
                fullName: sanitized(row.fullName, 200),
                ordinal: row.mutualOrdinal,
            },
            {
                username: row.username,
                side: 'following' as const,
                isPrivate: row.isPrivate,
                isVerified: row.isVerified,
                fullName: sanitized(row.fullName, 200),
                ordinal: row.mutualOrdinal,
            },
        ])),
        targetInteractions: source.targetInteractions.map(row => ({
            ...row,
            occurredAt: row.occurredAt ?? null,
            content: sanitized(row.content, 1_000),
        })),
        reverseInteractions: [],
    };
}

export function firstPaymentConciergeCheckpointProfile(profile: InstagramProfile) {
    const latestPosts = profile.latestPosts === undefined
        ? undefined
        : [...profile.latestPosts]
            .sort((left, right) => (
                Date.parse(right.timestamp) - Date.parse(left.timestamp)
                || left.id.localeCompare(right.id)
            ))
            .slice(0, 8);
    const parsed = analysisV2CheckpointProfileSchema.safeParse({
        ...profile,
        ...(latestPosts === undefined ? {} : { latestPosts }),
        ...(profile.fullName ? { fullName: profile.fullName } : {}),
        ...(profile.bio ? { bio: profile.bio } : {}),
        ...(profile.externalUrl ? { externalUrl: profile.externalUrl } : {}),
        ...(profile.profilePicUrl ? { profilePicUrl: profile.profilePicUrl } : {}),
    });
    if (!parsed.success) {
        throw new Error('FIRST_PAYMENT_CONCIERGE_PROFILE_SCHEMA_INVALID');
    }
    return parsed.data;
}

function isMediaTerminal(error: unknown): boolean {
    const message = error instanceof Error ? error.message : '';
    return message === 'ANALYSIS_V2_REPLAY_MEDIA_STRUCTURAL_INCOMPLETE'
        || message === 'ANALYSIS_V2_REPLAY_MEDIA_INVALID';
}

export async function captureFirstPaymentConciergeAiBundle(input: {
    source: FirstPaymentConciergeSource;
    normalizeMedia?: ReturnType<typeof createAnalysisV2SelectedMediaNormalizer>;
    now?: number;
}): Promise<FirstPaymentConciergeCapturedBundle> {
    const normalizeMedia = input.normalizeMedia
        ?? createAnalysisV2SelectedMediaNormalizer();
    const evidence = replayEvidence(input.source);
    const captured = new Map<number, AnalysisV2ReplayBundle['profiles'][number]>();
    const fetchUnavailable = new Set(
        input.source.publicUnavailableRows.map(row => row.mutualOrdinal),
    );
    const mediaUnavailable = new Set<number>();
    await runBounded(input.source.publicProfiles, 4, async item => {
        const profile = firstPaymentConciergeCheckpointProfile(item.profile);
        try {
            const one = await captureAnalysisV2ReplayBundle({
                selector: { targetUsername: profile.username },
                repository: {
                    async findCompletedReplaySourceExact() {
                        return {
                            requestFingerprint: input.source.descriptorHash,
                            sourceLineage,
                            completed: true,
                        };
                    },
                    async loadReplaySource() {
                        return { profiles: [profile], evidence, providerRuns: [] };
                    },
                },
                normalizeMedia,
                evaluationPolicy: firstPaymentConciergeEvaluationPolicy,
                now: input.now,
            });
            const capturedProfile = one.profiles[0];
            if (!capturedProfile) throw new Error('FIRST_PAYMENT_CONCIERGE_CAPTURE_EMPTY');
            captured.set(item.ordinal, { ...capturedProfile, ordinal: item.ordinal });
        } catch (error) {
            if (!isMediaTerminal(error)) throw error;
            mediaUnavailable.add(item.ordinal);
        }
    });
    if (captured.size + mediaUnavailable.size + fetchUnavailable.size !== 134) {
        throw new Error('FIRST_PAYMENT_CONCIERGE_CAPTURE_COUNT_DRIFT');
    }
    const now = input.now ?? Date.now();
    const bundle: Extract<AnalysisV2ReplayBundle, { schemaVersion: 1 }> = {
        schemaVersion: 1,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 24 * 60 * 60 * 1_000).toISOString(),
        capture: {
            requestFingerprint: input.source.descriptorHash,
            sourceLineage,
            evaluationPolicy: firstPaymentConciergeEvaluationPolicy,
        },
        profiles: [...captured.values()].sort((left, right) => left.ordinal - right.ordinal),
        evidence,
    };
    return Object.freeze({
        bundle,
        fetchUnavailableOrdinals: Object.freeze(
            [...fetchUnavailable].sort((a, b) => a - b),
        ),
        mediaUnavailableOrdinals: Object.freeze([...mediaUnavailable].sort((a, b) => a - b)),
    });
}

function accountContext(feature: FeatureAnalysisResult, profile: InstagramProfile): AccountContext {
    const model = feature.features.accountContext;
    if (model !== 'official_group_or_brand') return model;
    return screenAnalysisV2OfficialAccount({
        modelAccountContext: model,
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

function canonicalPublicName(value: string | null | undefined): string {
    const name = sanitized(value, 200);
    if (!name || /(?:대상\s*계정|후보\s*계정)/u.test(name)) {
        throw new Error('FIRST_PAYMENT_CONCIERGE_CANONICAL_NAME_MISSING');
    }
    return name;
}

function interactionRef(row: InteractionEvidenceRow): string {
    return `interaction:${hash('first-payment-concierge-interaction-v1', {
        candidateUsername: row.candidateUsername,
        postId: row.postId,
        signal: row.signal,
        sourceInteractionId: row.sourceInteractionId,
    })}`;
}

function observation(evidenceRefIds: readonly string[]) {
    return evidenceRefIds.length > 0
        ? { status: 'observed' as const, evidenceRefIds: [...new Set(evidenceRefIds)].slice(0, 8) }
        : { status: 'not_observed' as const, evidenceRefIds: [] };
}

function notCollectedObservation() {
    return { status: 'not_collected' as const, evidenceRefIds: [] };
}

function selectedPostEvidenceRefs(input: {
    profile: InstagramProfile;
    capturedProfile: AnalysisV2ReplayBundle['profiles'][number];
    username: string;
    field: 'taggedUsers' | 'mentionedUsers';
}): string[] {
    const selected = new Set(input.capturedProfile.featureSelectionIds);
    const selectionByPostId = new Map(
        input.capturedProfile.media
            .filter(media => selected.has(media.selectionId) && media.postId)
            .map(media => [media.postId!, media.selectionId]),
    );
    return (input.profile.latestPosts ?? []).flatMap(post => (
        post[input.field].some(value => value.trim().replace(/^@/u, '').toLowerCase()
            === input.username)
            ? [selectionByPostId.get(post.id)]
            : []
    )).filter((value): value is string => Boolean(value));
}

/**
 * Binds retained first-payment evidence directly to the existing Gemini
 * high-risk stage.  It deliberately does not alter the scored snapshot.
 */
export function createFirstPaymentConciergeHighRiskNarrativeInput(input: {
    targetProfile: InstagramProfile;
    candidateProfile: InstagramProfile;
    capturedProfile: AnalysisV2ReplayBundle['profiles'][number];
    feature: FeatureAnalysisResult;
    interactions: readonly InteractionEvidenceRow[];
}): HighRiskNarrativeInput {
    const targetUsername = input.targetProfile.username.toLowerCase();
    const candidateUsername = input.candidateProfile.username.toLowerCase();
    const selected = new Set(input.capturedProfile.featureSelectionIds);
    const media = input.capturedProfile.media
        .filter(item => selected.has(item.selectionId))
        .map(item => ({
            selectionId: item.selectionId,
            kind: item.kind,
            normalizedJpegBase64: item.jpegBase64,
            ...(item.postId ? { postId: item.postId } : {}),
        }));
    const selectedMediaIds = new Set(media.map(item => item.selectionId));
    const candidateInteractions = input.interactions.filter(row => (
        row.candidateUsername === candidateUsername
    ));
    const likes = candidateInteractions.filter(row => row.signal === 'female_target_like');
    const comments = candidateInteractions
        .filter(row => row.signal === 'female_target_comment')
        .flatMap(row => {
            const text = sanitized(row.content, 300);
            return text ? [{
                evidenceRefId: interactionRef(row),
                targetPostEvidenceRefId: `target-post:${hash(
                    'first-payment-concierge-target-post-v1', row.postId,
                )}`,
                text,
            }] : [];
        })
        .slice(0, 12);
    const candidateToTargetTag = selectedPostEvidenceRefs({
        profile: input.candidateProfile,
        capturedProfile: input.capturedProfile,
        username: targetUsername,
        field: 'taggedUsers',
    });
    const candidateToTargetMention = selectedPostEvidenceRefs({
        profile: input.candidateProfile,
        capturedProfile: input.capturedProfile,
        username: targetUsername,
        field: 'mentionedUsers',
    });

    return {
        forbiddenIdentifiers: { targetUsername, candidateUsername },
        publicSubjects: {
            targetFullName: canonicalPublicName(input.targetProfile.fullName),
            candidateFullName: canonicalPublicName(input.candidateProfile.fullName),
        },
        appearance: {
            isReliable: input.feature.features.evidenceSelectionIds.appearance
                .some(selectionId => selectedMediaIds.has(selectionId)),
        },
        bio: sanitized(input.candidateProfile.bio, 2_200),
        media,
        captions: input.capturedProfile.captions
            .filter(caption => selectedMediaIds.has(caption.selectionId))
            .map(caption => ({ ...caption, text: sanitized(caption.text, 2_200) ?? '' }))
            .filter(caption => caption.text.length > 0),
        carouselCaptionDossier: null,
        interactions: {
            candidateToTargetLike: observation(likes.map(interactionRef)),
            targetToCandidateLike: notCollectedObservation(),
            candidateToTargetComment: observation(comments.map(comment => comment.evidenceRefId)),
            candidateToTargetTag: observation(candidateToTargetTag),
            targetToCandidateTag: notCollectedObservation(),
            candidateToTargetMention: observation(candidateToTargetMention),
            targetToCandidateMention: notCollectedObservation(),
            comments,
            coverage: {
                status: 'partial',
                evidenceRefId: 'coverage:retained-target-interactions',
            },
        },
    };
}

function conciergeNarrativeAudit(input: HighRiskNarrativeInput): StagedAiAuditContext {
    const resultIdentity = createHighRiskNarrativeResultIdentity(
        input,
        AI_STAGE_POLICY_V211_VERSION,
    );
    return {
        requestId: randomUUID(),
        operationKey: resultIdentity.operationKey,
        resultIdentity,
        prepare: async () => ({ result: null, source: null, startingAttempt: 1 }),
        onBeforeAttempt: () => undefined,
        onAttemptTelemetry: () => undefined,
    };
}

export async function createFirstPaymentConciergePublication(input: {
    source: FirstPaymentConciergeSource;
    captured: FirstPaymentConciergeCapturedBundle;
    /** Test seam for the existing high-risk Gemini stage; production uses it directly. */
    runNarrative?: typeof highRiskNarrative;
}): Promise<Readonly<{
    payload: FirstPaymentConciergePublicationPayload;
    report: AnalysisV2AiReplayReport;
}>> {
    const details = new Map<number, ReplayAccountAiDetail>();
    const report = await runAnalysisV2AiReplay({
        bundle: input.captured.bundle,
        runner: createReplayStagedAiAdapter(AI_STAGE_POLICY_V211_VERSION),
        mode: 'paid-ai',
        paidAiOptIn: true,
        evaluationPolicy: firstPaymentConciergeEvaluationPolicy,
        onAccountAnalyzed(detail) {
            if (details.has(detail.ordinal)) {
                throw new Error('FIRST_PAYMENT_CONCIERGE_AI_OUTPUT_DUPLICATE');
            }
            details.set(detail.ordinal, detail);
        },
    });
    if (details.size !== input.captured.bundle.profiles.length) {
        throw new Error('FIRST_PAYMENT_CONCIERGE_AI_OUTPUT_INCOMPLETE');
    }

    const profileByOrdinal = new Map(input.source.publicProfiles.map(item => [item.ordinal, item.profile]));
    const verifiedFemale = [...details.values()].filter(detail => (
        detail.finalClassification === 'verified_female' && detail.feature !== null
    ));
    const femaleUsernames = verifiedFemale.map(detail => {
        const username = profileByOrdinal.get(detail.ordinal)?.username.toLowerCase();
        if (!username) throw new Error('FIRST_PAYMENT_CONCIERGE_PROFILE_IDENTITY_MISSING');
        return username;
    });
    const joinedInteractions = joinVerifiedFemaleTargetInteractions({
        evidence: input.source.targetInteractions,
        verifiedFemaleUsernames: femaleUsernames,
        excludedUsername: null,
    });
    const interactionByUsername = new Map(
        summarizeCandidateTargetInteractions(joinedInteractions)
            .map(summary => [summary.candidateUsername, summary]),
    );
    const candidateEvidence = verifiedFemale.map(detail => {
        const profile = profileByOrdinal.get(detail.ordinal);
        const feature = detail.feature;
        if (!profile || !feature) {
            throw new Error('FIRST_PAYMENT_CONCIERGE_FEMALE_EVIDENCE_MISSING');
        }
        const username = profile.username.toLowerCase();
        const interaction = interactionByUsername.get(username);
        const mentions = hasCandidateTargetMention({
            targetUsername: input.source.targetProfile.username,
            candidateUsername: username,
            targetPosts: input.source.targetProfile.latestPosts ?? [],
            candidatePosts: profile.latestPosts ?? [],
        });
        return {
            candidateId: analysisV2CandidateId(username),
            username,
            appearanceGrade: feature.features.appearanceGrade as AppearanceGrade,
            exposureScore: feature.features.exposureScore,
            accountContext: accountContext(feature, profile),
            hasWeakPartnerEvidence: weakPartner(feature),
            hasStrongPartnerEvidence: strongPartner(feature),
            uniqueTargetPostsLikedByCandidate:
                interaction?.uniqueTargetPostsLikedByCandidate ?? 0,
            boundedCandidateCommentsOnTarget:
                interaction?.boundedCandidateCommentsOnTarget ?? 0,
            hasCandidateToTargetTagOrCaptionMention:
                mentions.candidateToTargetTagOrCaptionMention,
            hasTargetToCandidateTagOrCaptionMention:
                mentions.targetToCandidateTagOrCaptionMention,
        };
    });
    const preliminary = calculateV2PreliminaryScores({
        candidates: candidateEvidence,
        orderedMutualUsernames: input.source.mutualRows.map(row => row.username),
        excludedUsername: null,
        riskPolicyVersion: 'risk-policy-v2.5',
    });
    const finalScores = calculateV2FinalScores({
        preliminary,
        observedReverseLikeCandidateIds: new Set(),
        notCollectedCandidateIds: new Set(preliminary.map(row => row.candidateId)),
        riskPolicyVersion: 'risk-policy-v2.5',
    });
    const detailByCandidate = new Map(verifiedFemale.map(detail => {
        const profile = profileByOrdinal.get(detail.ordinal)!;
        return [analysisV2CandidateId(profile.username), { detail, profile }];
    }));
    const capturedProfileByOrdinal = new Map(
        input.captured.bundle.profiles.map(profile => [profile.ordinal, profile]),
    );
    const runNarrative = input.runNarrative ?? highRiskNarrative;
    const femaleRows = await Promise.all(finalScores.slice().sort((left, right) => (
        right.displayScore - left.displayScore
        || left.candidateId.localeCompare(right.candidateId)
    )).map(async (score, index) => {
        const retained = detailByCandidate.get(score.candidateId);
        if (!retained?.detail.feature) {
            throw new Error('FIRST_PAYMENT_CONCIERGE_FEMALE_RESULT_MISSING');
        }
        const narrativeRequired = score.riskBand === 'high_risk'
            && score.featuredRank !== null
            && score.featuredRank <= 3;
        const capturedProfile = capturedProfileByOrdinal.get(retained.detail.ordinal);
        if (!capturedProfile) {
            throw new Error('FIRST_PAYMENT_CONCIERGE_NARRATIVE_MEDIA_MISSING');
        }
        const narrativeInput = narrativeRequired
            ? createFirstPaymentConciergeHighRiskNarrativeInput({
                targetProfile: input.source.targetProfile,
                candidateProfile: retained.profile,
                capturedProfile,
                feature: retained.detail.feature,
                interactions: joinedInteractions,
            })
            : null;
        const narrative = narrativeInput
            ? await runNarrative(
                narrativeInput,
                conciergeNarrativeAudit(narrativeInput),
                { aiStagePolicyVersion: AI_STAGE_POLICY_V211_VERSION },
            )
            : null;
        if (narrativeRequired && narrative?.source !== 'gemini') {
            throw new Error('FIRST_PAYMENT_CONCIERGE_GEMINI_NARRATIVE_REQUIRED');
        }
        const overview = sanitized(retained.detail.feature.features.oneLineOverview, 180);
        if (!overview) {
            throw new Error('FIRST_PAYMENT_CONCIERGE_GEMINI_OVERVIEW_MISSING');
        }
        return {
            candidateId: score.candidateId,
            sortOrdinal: index + 1,
            instagramId: retained.profile.username.toLowerCase(),
            fullName: sanitized(retained.profile.fullName, 200),
            profileImageUrl: null,
            bio: sanitized(retained.profile.bio, 2_200),
            displayScore: score.displayScore,
            riskBand: score.riskBand,
            featuredRank: score.featuredRank,
            recentMutualRank: score.recentMutualBadgeRank,
            analysisDepth: narrativeRequired ? 'narrative' as const : 'features' as const,
            oneLineOverview: overview,
            narrativeLineOne: narrative?.lines[0] ?? null,
            narrativeLineTwo: narrative?.lines[1] ?? null,
        };
    }));
    const privateRows = input.source.privateRows.map((row, index) => ({
        candidateId: analysisV2CandidateId(row.username),
        sortOrdinal: index + 1,
        instagramId: row.username,
        fullName: sanitized(row.fullName, 200),
        profileImageUrl: null,
    }));

    const mediaUnavailable = new Set(input.captured.mediaUnavailableOrdinals);
    const fetchUnavailable = new Set(input.captured.fetchUnavailableOrdinals);
    const analysisUnavailableCount = [...details.values()].filter(detail => (
        detail.finalClassification === 'analysis_unavailable'
    )).length;
    const male = [...details.values()].filter(detail => (
        detail.finalClassification === 'verified_non_female'
    )).length;
    const female = verifiedFemale.length;
    const unknown = 134 - male - female;
    const semanticInputFingerprint = analysisV2ReplaySemanticInputFingerprint(
        input.captured.bundle,
    );
    const evidenceHash = hash('first-payment-concierge-evidence-v1', {
        descriptorHash: input.source.descriptorHash,
        semanticInputFingerprint,
        fetchUnavailableOrdinals: [...fetchUnavailable].sort((a, b) => a - b),
        mediaUnavailableOrdinals: [...mediaUnavailable].sort((a, b) => a - b),
        accounts: [...details.values()].sort((a, b) => a.ordinal - b.ordinal),
    });
    const payload = firstPaymentConciergePublicationPayloadSchema.parse({
        schemaVersion: 1,
        descriptorHash: input.source.descriptorHash,
        evidenceHash,
        semanticInputFingerprint,
        targetFullName: sanitized(input.source.targetProfile.fullName, 200),
        counts: {
            followersDeclared: input.source.followersDeclared,
            followersCollected: input.source.followersCollected,
            followingDeclared: input.source.followingDeclared,
            followingCollected: input.source.followingCollected,
            detectedMutuals: input.source.mutualRows.length,
            publicMutuals: input.source.publicProfiles.length
                + input.source.publicUnavailableRows.length,
            privateMutuals: input.source.privateRows.length,
            screenedMutuals: input.source.publicProfiles.length
                + input.source.publicUnavailableRows.length,
            notScreenedMutuals: 0,
            fetchUnavailableCount: fetchUnavailable.size,
            mediaUnavailableCount: mediaUnavailable.size,
            analysisUnavailableCount,
            male,
            female,
            unknown,
        },
        femaleRows,
        privateRows,
    });
    return Object.freeze({ payload, report });
}
