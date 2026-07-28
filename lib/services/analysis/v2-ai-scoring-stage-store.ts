import { z } from 'zod';
import { ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS } from '@/lib/services/ai/image-preprocessing';
import {
    featureAnalysisResultSchema,
    genderTriageResultSchema,
    partnerSafetyResultSchema,
} from '@/lib/services/ai/v2-staged-analysis';
import { selectAnalysisMedia } from '@/lib/domain/analysis/media-policy';
import {
    analysisV2CheckpointProfileSchema,
    type AnalysisV2CheckpointProfile,
} from './v2-profile-fetch-store';
import { screenAnalysisV2OfficialAccount } from './v2-official-account-screening';
import { supabaseAdmin } from '@/lib/supabase/admin';
import type {
    AnalysisV2AiScoringStageStore,
    AnalysisV2FinalScoreSnapshot,
    AnalysisV2NarrativeSnapshot,
    AnalysisV2PartnerSafetySnapshot,
    AnalysisV2PrimaryJoinSnapshot,
    AnalysisV2ProfileAiOutcome,
    AnalysisV2ReverseLikeSnapshot,
    AnalysisV2ScreeningSnapshot,
    AnalysisV2StageReadClaim,
} from './v2-ai-scoring-executors';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const PROFILE_AI_OPERATION_KEY_PATTERN =
    /^(gender-triage|gender-resolution|feature-analysis):[a-f0-9]{64}$/;
const PARTNER_OPERATION_KEY_PATTERN = /^partner-safety:[a-f0-9]{64}$/;
const NARRATIVE_OPERATION_KEY_PATTERN = /^high-risk-narrative:[a-f0-9]{64}$/;

export const ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES = Object.freeze({
    table: 'analysis_v2_ai_scoring_stage_checkpoints',
    checkpointRpc: 'checkpoint_analysis_v2_ai_scoring_stage',
    loadRpc: 'load_analysis_v2_ai_scoring_stage',
    loadProfileBatchesRpc: 'load_analysis_v2_profile_ai_stage_batches',
    purgeRpc: 'purge_analysis_v2_ai_scoring_stage',
});

const stageKindSchema = z.enum([
    'profile_ai_batch',
    'primary_join',
    'screening',
    'reverse_likes',
    'partner_safety',
    'final_score',
    'narrative',
]);

type StageKind = z.infer<typeof stageKindSchema>;

const candidateIdSchema = z.string().regex(CANDIDATE_ID_PATTERN);
const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._]{1,30}$/);
const hashSchema = z.string().regex(SHA256_PATTERN);
const selectionIdSchema = z.string().trim().min(1).max(240);
const profileAiOperationKeySchema = z.string().regex(PROFILE_AI_OPERATION_KEY_PATTERN);
const resolverOperationKeySchema = profileAiOperationKeySchema.regex(/^gender-resolution:/);
const profileClassificationSchema = z.enum([
    'verified_female',
    'verified_non_female',
    'unresolved',
    'unresolved_stage_conflict',
    'fetch_unavailable',
    'media_unavailable',
    'analysis_unavailable',
]);
const classificationSourceSchema = z.enum([
    'triage',
    'feature',
    'gender_resolution',
    'unknown',
    'unavailable',
]);
const genderResolutionStatusSchema = z.enum([
    'disabled',
    'not_eligible',
    'ready_applied',
    'ready_not_needed',
    'ready_inconclusive',
    'cutoff',
    'capacity_skipped',
    'terminal_unavailable',
]);
const appearanceGradeSchema = z.union([
    z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
]);
const accountContextSchema = z.enum([
    'personal',
    'individual_creator',
    'official_group_or_brand',
    'uncertain',
]);
const riskBandSchema = z.enum(['normal', 'caution', 'high_risk']);
const nullableRankSchema = z.number().int().min(1).max(900).nullable();

const mediaCoverageSchema = z.object({
    selectedCount: z.number().int().min(0).max(20),
    normalizedCount: z.number().int().min(0).max(20),
    failures: z.array(z.object({
        selectionId: selectionIdSchema,
        reason: z.enum(ANALYSIS_IMAGE_PREPARATION_FAILURE_REASONS),
        disposition: z.enum(['transient', 'permanent']),
    }).strict()).max(20),
}).strict().superRefine((value, context) => {
    if (value.selectedCount !== value.normalizedCount + value.failures.length) {
        context.addIssue({ code: 'custom', message: 'Media coverage counts drifted.' });
    }
});

const mediaSelectionProvenanceSchema = z.object({
    triageSelectedCount: z.number().int().min(0).max(5),
    featureSelectedCount: z.number().int().min(0).max(11),
    selectedKinds: z.object({
        profile: z.number().int().min(0).max(1),
        postRepresentative: z.number().int().min(0).max(10),
        carouselContext: z.number().int().min(0).max(10),
    }).strict(),
}).strict().superRefine((value, context) => {
    if (
        value.selectedKinds.profile
        + value.selectedKinds.postRepresentative
        + value.selectedKinds.carouselContext
        !== value.featureSelectedCount
    ) {
        context.addIssue({ code: 'custom', message: 'Media selection provenance drifted.' });
    }
});

function canonicalV28MediaSelectionProvenance(profile: AnalysisV2CheckpointProfile) {
    const latestPosts = profile.latestPosts ?? [];
    if (
        !profile.isPrivate
        && latestPosts.length < Math.min(profile.postsCount, 8)
    ) {
        return null;
    }
    const selected = selectAnalysisMedia({
        profile: profile.profilePicUrl
            ? { id: profile.username, imageUrl: profile.profilePicUrl }
            : undefined,
        posts: latestPosts,
    }, { carouselDiversity: true });
    if (selected.carouselCoverage.incompletePostIds.length > 0) return null;
    const selectedKinds = {
        profile: 0,
        postRepresentative: 0,
        carouselContext: 0,
    };
    for (const media of selected.feature.media) {
        if (media.role === 'profile') selectedKinds.profile += 1;
        else if (media.role === 'post_representative') selectedKinds.postRepresentative += 1;
        else if (media.role === 'carousel_context') selectedKinds.carouselContext += 1;
    }
    return {
        triageSelectedCount: selected.triage.media.length,
        featureSelectedCount: selected.feature.media.length,
        selectedKinds,
    };
}

const captionSchema = z.object({
    evidenceRefId: z.string().trim().min(1).max(240),
    selectionId: selectionIdSchema,
    text: z.string().max(2_200),
}).strict();

const profileOutcomeSchema = z.object({
    candidateId: candidateIdSchema,
    instagramId: usernameSchema,
    status: profileClassificationSchema,
    unavailableReason: z.enum(['profile_fetch', 'ai_response']).nullable().optional(),
    profile: analysisV2CheckpointProfileSchema.nullable(),
    triage: genderTriageResultSchema.nullable(),
    feature: featureAnalysisResultSchema.nullable(),
    normalizedSelectionIds: z.array(selectionIdSchema).max(11),
    captions: z.array(captionSchema).max(10),
    mediaCoverage: mediaCoverageSchema,
    genderOperationKey: profileAiOperationKeySchema.regex(/^gender-triage:/).nullable(),
    genderResultHash: hashSchema.nullable(),
    featureOperationKey: profileAiOperationKeySchema.regex(/^feature-analysis:/).nullable(),
    featureResultHash: hashSchema.nullable(),
    baselineClassification: profileClassificationSchema.optional(),
    classificationSource: classificationSourceSchema.optional(),
    genderResolutionStatus: genderResolutionStatusSchema.optional(),
    genderResolutionOperationKey: resolverOperationKeySchema.nullable().optional(),
    genderResolutionResultHash: hashSchema.nullable().optional(),
    mediaBundlePersisted: z.boolean(),
    v29FeatureAdmission: z.enum([
        'eligible',
        'nonpersonal_or_official',
        'unsupported_unknown',
    ]).optional(),
    aiStagePolicyVersion: z.enum([
        'ai-stage-policy-v2.8',
        'ai-stage-policy-v2.9',
        'ai-stage-policy-v2.10',
    ]).optional(),
    mediaSelectionProvenance: mediaSelectionProvenanceSchema.optional(),
    inputQualityPolicy: z.literal('input-quality-v2.8').optional(),
    accountContextOverride: accountContextSchema.optional(),
    officialScreeningStatus: z.enum([
        'not_model_official',
        'corroborated_official',
        'uncorroborated_official',
    ]).optional(),
    officialExclusionReason: z.literal('model_group_context_plus_profile_signals')
        .nullable().optional(),
}).strict().transform(value => ({
    ...value,
    unavailableReason: value.unavailableReason
        ?? (value.status === 'fetch_unavailable'
            ? 'profile_fetch' as const
            : value.status === 'analysis_unavailable'
                ? 'ai_response' as const
                : null),
    baselineClassification: value.baselineClassification ?? value.status,
    classificationSource: value.classificationSource ?? (
        value.status === 'verified_non_female' && value.feature === null
            ? 'triage' as const
            : value.status === 'verified_female'
                || value.status === 'verified_non_female'
                ? 'feature' as const
                : value.status === 'unresolved'
                    || value.status === 'unresolved_stage_conflict'
                    ? 'unknown' as const
                    : 'unavailable' as const
    ),
    genderResolutionStatus: value.genderResolutionStatus ?? 'disabled' as const,
    genderResolutionOperationKey: value.genderResolutionOperationKey ?? null,
    genderResolutionResultHash: value.genderResolutionResultHash ?? null,
})).superRefine((value, context) => {
    const classificationChanged = value.status !== value.baselineClassification;
    if (classificationChanged && (
        !['unresolved', 'unresolved_stage_conflict'].includes(value.baselineClassification)
        || !['verified_female', 'verified_non_female'].includes(value.status)
        || value.classificationSource !== 'gender_resolution'
        || value.genderResolutionStatus !== 'ready_applied'
    )) {
        context.addIssue({
            code: 'custom',
            message: 'Gender resolution provenance does not justify the classification change.',
        });
    }
    const readyResolver = [
        'ready_applied',
        'ready_not_needed',
        'ready_inconclusive',
    ].includes(value.genderResolutionStatus);
    if (readyResolver !== (
        value.genderResolutionOperationKey !== null
        && value.genderResolutionResultHash !== null
    )) {
        context.addIssue({
            code: 'custom',
            message: 'Ready gender resolution provenance is incomplete.',
        });
    }
    if (
        value.classificationSource === 'gender_resolution'
        && value.genderResolutionStatus !== 'ready_applied'
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Gender resolution source requires an applied ready result.',
        });
    }
    const fetchUnavailable = value.status === 'fetch_unavailable';
    if (fetchUnavailable !== (value.unavailableReason === 'profile_fetch')) {
        context.addIssue({ code: 'custom', message: 'Profile unavailable reason mismatch.' });
    }
    if (fetchUnavailable !== (value.profile === null)) {
        context.addIssue({ code: 'custom', path: ['profile'], message: 'Profile status mismatch.' });
    }
    if (fetchUnavailable && (
        value.triage || value.feature || value.genderOperationKey || value.genderResultHash
        || value.featureOperationKey || value.featureResultHash
        || value.normalizedSelectionIds.length > 0 || value.mediaBundlePersisted
    )) {
        context.addIssue({ code: 'custom', message: 'Unavailable outcome contains analysis data.' });
    }
    const analysisUnavailable = value.status === 'analysis_unavailable';
    if (analysisUnavailable !== (value.unavailableReason === 'ai_response')) {
        context.addIssue({ code: 'custom', message: 'Analysis unavailable reason mismatch.' });
    }
    if (analysisUnavailable && (
        value.profile === null || value.triage || value.feature
        || value.genderOperationKey || value.genderResultHash
        || value.featureOperationKey || value.featureResultHash
        || value.normalizedSelectionIds.length > 0 || value.captions.length > 0
        || value.mediaCoverage.selectedCount > 0
        || value.mediaCoverage.normalizedCount > 0
        || value.mediaCoverage.failures.length > 0
        || value.mediaBundlePersisted
    )) {
        context.addIssue({
            code: 'custom',
            message: 'Analysis-unavailable outcome contains analysis or media data.',
        });
    }
    const mediaUnavailable = value.status === 'media_unavailable';
    if (mediaUnavailable && (
        value.profile === null || value.triage || value.feature
        || value.genderOperationKey || value.genderResultHash
        || value.featureOperationKey || value.featureResultHash
        || value.mediaBundlePersisted
    )) {
        context.addIssue({ code: 'custom', message: 'Media-unavailable outcome is inconsistent.' });
    }
    if (!fetchUnavailable && !mediaUnavailable && !analysisUnavailable && (
        !value.triage || !value.genderOperationKey || !value.genderResultHash
        || value.normalizedSelectionIds.length === 0
    )) {
        context.addIssue({ code: 'custom', message: 'Analyzed outcome is incomplete.' });
    }
    const v29FeatureSkipped = (
        value.aiStagePolicyVersion === 'ai-stage-policy-v2.9'
        || value.aiStagePolicyVersion === 'ai-stage-policy-v2.10'
    )
        && value.v29FeatureAdmission !== undefined
        && value.v29FeatureAdmission !== 'eligible';
    if (v29FeatureSkipped && (
        value.status !== 'unresolved'
        || value.feature !== null
        || value.featureOperationKey !== null
        || value.featureResultHash !== null
    )) {
        context.addIssue({
            code: 'custom',
            message: 'A v2.9 pre-feature exclusion must remain an unresolved triage-only outcome.',
        });
    }
    const featureRequired = !v29FeatureSkipped && [
        'verified_female', 'unresolved', 'unresolved_stage_conflict',
    ].includes(value.status);
    if (featureRequired && (
        !value.feature || !value.featureOperationKey || !value.featureResultHash
    )) {
        context.addIssue({ code: 'custom', message: 'Feature outcome is incomplete.' });
    }
    const hasV28Contamination = value.inputQualityPolicy !== undefined
        || value.mediaSelectionProvenance !== undefined
        || value.accountContextOverride !== undefined
        || value.officialScreeningStatus !== undefined
        || value.officialExclusionReason !== undefined;
    const inputQualityPolicyFamily = value.aiStagePolicyVersion === 'ai-stage-policy-v2.8'
        || value.aiStagePolicyVersion === 'ai-stage-policy-v2.9'
        || value.aiStagePolicyVersion === 'ai-stage-policy-v2.10';
    const requiresInputQualityProvenance = inputQualityPolicyFamily && !v29FeatureSkipped;
    if (!inputQualityPolicyFamily && hasV28Contamination) {
        context.addIssue({
            code: 'custom',
                message: 'v2.8 input-quality fields require an exact v2.8-family AI-stage policy.',
        });
    }
    if (requiresInputQualityProvenance && !value.feature) {
        context.addIssue({
            code: 'custom',
            message: 'Media selection provenance requires completed feature analysis.',
        });
    }
    if (requiresInputQualityProvenance && (
        value.inputQualityPolicy !== 'input-quality-v2.8'
        || value.mediaSelectionProvenance === undefined
        || value.accountContextOverride === undefined
        || value.officialScreeningStatus === undefined
        || value.officialExclusionReason === undefined
    )) {
        context.addIssue({
            code: 'custom',
            message: 'v2.8 input-quality provenance is incomplete.',
        });
    }
    if (requiresInputQualityProvenance && value.feature && value.profile) {
        const modelContext = value.feature.features.accountContext;
        const screening = screenAnalysisV2OfficialAccount({
            modelAccountContext: modelContext,
            fullName: value.profile.fullName ?? null,
            bio: value.profile.bio ?? null,
        });
        const expectedContext = modelContext === 'official_group_or_brand'
            ? screening.accountContext
            : modelContext;
        const expectedStatus = modelContext !== 'official_group_or_brand'
            ? 'not_model_official'
            : screening.exclusionReason
                ? 'corroborated_official'
                : 'uncorroborated_official';
        const expectedMedia = canonicalV28MediaSelectionProvenance(value.profile);
        if (
            value.accountContextOverride !== expectedContext
            || value.officialScreeningStatus !== expectedStatus
            || value.officialExclusionReason !== screening.exclusionReason
            || expectedMedia === null
            || JSON.stringify(value.mediaSelectionProvenance) !== JSON.stringify(expectedMedia)
        ) {
            context.addIssue({
                code: 'custom',
                message: 'v2.8 input-quality provenance does not match persisted source evidence.',
            });
        }
    }
    if (value.mediaBundlePersisted !== (value.status === 'verified_female')) {
        context.addIssue({ code: 'custom', message: 'Only verified women retain media bundles.' });
    }
    if (
        value.mediaCoverage.normalizedCount !== value.normalizedSelectionIds.length
        || value.mediaCoverage.selectedCount !== (
            value.mediaCoverage.normalizedCount + value.mediaCoverage.failures.length
        )
    ) {
        context.addIssue({ code: 'custom', message: 'Media coverage counts drifted.' });
    }
});

const interactionSchema = z.object({
    candidateUsername: usernameSchema,
    postId: z.string().trim().min(1).max(255),
    signal: z.enum(['female_target_like', 'female_target_comment']),
    sourceInteractionId: z.string().trim().min(1).max(255),
    occurredAt: z.string().datetime({ offset: true }).optional(),
    content: z.string().max(1_000).optional(),
}).strict();

const primaryCandidateSchema = z.object({
    candidateId: candidateIdSchema,
    instagramId: usernameSchema,
    interactions: z.array(interactionSchema).max(690),
}).strict();

const preliminaryCandidateSchema = z.object({
    candidateId: candidateIdSchema,
    username: usernameSchema,
    appearanceGrade: appearanceGradeSchema,
    exposureScore: z.number().int().min(0).max(5),
    accountContext: accountContextSchema,
    hasWeakPartnerEvidence: z.boolean(),
    hasStrongPartnerEvidence: z.boolean(),
    uniqueTargetPostsLikedByCandidate: z.number().int().min(0).max(4),
    boundedCandidateCommentsOnTarget: z.number().int().min(0).max(12),
    hasCandidateToTargetTagOrCaptionMention: z.boolean(),
    hasTargetToCandidateTagOrCaptionMention: z.boolean(),
    recentFemaleMutualRank: nullableRankSchema,
    recentMutualBadgeRank: z.number().int().min(1).max(5).nullable(),
    preScore: z.number().finite().min(0).max(95),
    verificationShortlistRank: z.number().int().min(1).max(10).nullable(),
}).strict();

const legacyPreliminaryCandidateSchema = z.object({
    candidateId: candidateIdSchema,
    username: usernameSchema,
    appearanceGrade: appearanceGradeSchema,
    exposureScore: z.number().int().min(0).max(5),
    accountContext: accountContextSchema,
    hasWeakPartnerEvidence: z.boolean(),
    hasStrongPartnerEvidence: z.boolean(),
    uniqueTargetPostsLikedByCandidate: z.number().int().min(0).max(4),
    boundedCandidateCommentsOnTarget: z.number().int().min(0).max(12),
    hasTagOrCaptionMention: z.boolean(),
    recentFemaleMutualRank: nullableRankSchema,
    recentMutualBadgeRank: z.number().int().min(1).max(5).nullable(),
    preScore: z.number().finite().min(0).max(97),
    verificationShortlistRank: z.number().int().min(1).max(10).nullable(),
}).strict();

const scoreComponentsSchema = z.object({
    candidateToTargetLikes: z.number().finite().min(0).max(24),
    candidateToTargetComments: z.number().finite().min(0).max(30),
    candidateToTargetTagOrCaptionMention: z.number().finite().min(0).max(12),
    targetToCandidateTagOrCaptionMention: z.number().finite().min(0).max(8),
    targetToCandidateLike: z.number().finite().min(0).max(5),
    recentMutual: z.number().finite().min(0).max(5),
    appearanceExposure: z.number().finite().min(0).max(16),
}).strict();

const riskResultSchema = z.object({
    policyVersion: z.literal('risk-policy-v2.4'),
    components: scoreComponentsSchema,
    softContextBeforeBusinessAdjustment: z.object({
        recentMutual: z.number().finite().min(0).max(5),
        appearanceExposure: z.number().finite().min(0).max(16),
    }).strict(),
    softContextMultiplier: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
    weakPartnerAdjustment: z.union([z.literal(-5), z.literal(0)]),
    preScore: z.number().finite().min(0).max(95),
    rawScore: z.number().finite().min(0).max(100),
    possibleUpperBound: z.number().finite().min(0).max(100),
    publicScore: z.number().finite().min(1).max(10),
    displayScore: z.number().finite().min(1).max(10),
    possibleUpperPublicScore: z.number().finite().min(1).max(10),
    possibleUpperDisplayScore: z.number().finite().min(1).max(10),
    riskBand: riskBandSchema,
    partnerCapApplied: z.boolean(),
}).strict();

const legacyScoreComponentsSchema = z.object({
    candidateToTargetLikes: z.number().finite().min(0).max(20),
    candidateToTargetComments: z.number().finite().min(0).max(26),
    targetToCandidateLike: z.number().finite().min(0).max(3),
    tagOrCaptionMention: z.number().finite().min(0).max(14),
    recentMutual: z.number().finite().min(0).max(17),
    appearanceExposure: z.number().finite().min(0).max(20),
}).strict();

const legacyRiskResultSchema = z.object({
    policyVersion: z.literal('risk-policy-v2.3'),
    components: legacyScoreComponentsSchema,
    softContextBeforeBusinessAdjustment: z.object({
        recentMutual: z.number().finite().min(0).max(17),
        appearanceExposure: z.number().finite().min(0).max(20),
    }).strict(),
    softContextMultiplier: z.union([z.literal(0), z.literal(0.5), z.literal(1)]),
    weakPartnerAdjustment: z.union([z.literal(-5), z.literal(0)]),
    preScore: z.number().finite().min(0).max(97),
    rawScore: z.number().finite().min(0).max(100),
    possibleUpperBound: z.number().finite().min(0).max(100),
    publicScore: z.number().finite().min(1).max(10),
    displayScore: z.number().finite().min(1).max(10),
    possibleUpperPublicScore: z.number().finite().min(1).max(10),
    possibleUpperDisplayScore: z.number().finite().min(1).max(10),
    riskBand: riskBandSchema,
    partnerCapApplied: z.boolean(),
}).strict();

const finalCandidateSchema = preliminaryCandidateSchema.extend({
    reverseLikeStatus: z.enum(['observed', 'not_observed', 'not_collected']),
    risk: riskResultSchema,
    displayScore: z.number().finite().min(1).max(10)
        .refine(value => Math.round(value * 10) === value * 10),
    riskBand: riskBandSchema,
    relativeTierApplied: z.boolean(),
    featuredRank: z.number().int().min(1).max(10).nullable(),
    relativeWatchRank: z.number().int().min(1).max(2).nullable(),
}).strict();

const legacyFinalCandidateSchema = legacyPreliminaryCandidateSchema.extend({
    reverseLikeStatus: z.enum(['observed', 'not_observed', 'not_collected']),
    risk: legacyRiskResultSchema,
    displayScore: z.number().finite().min(1).max(10)
        .refine(value => Math.round(value * 10) === value * 10),
    riskBand: riskBandSchema,
    relativeTierApplied: z.boolean(),
    featuredRank: z.number().int().min(1).max(15).nullable(),
    relativeWatchRank: z.number().int().min(1).max(2).nullable(),
}).strict();

const reverseLikeRowSchema = z.object({
    candidateId: candidateIdSchema,
    shortlistRank: z.number().int().min(1).max(10),
    status: z.enum(['observed', 'observed_not_found', 'not_collected']),
    operationKey: z.string().trim().min(1).max(240).nullable(),
}).strict();

const partnerSafetyRowSchema = z.object({
    candidateId: candidateIdSchema,
    shortlistRank: z.number().int().min(1).max(10),
    result: partnerSafetyResultSchema,
    operationKey: z.string().regex(PARTNER_OPERATION_KEY_PATTERN).nullable(),
    resultHash: hashSchema.nullable(),
    mediaCoverage: mediaCoverageSchema,
}).strict();

const narrativeRowSchema = z.object({
    candidateId: candidateIdSchema,
    lines: z.tuple([
        z.string().trim().min(1).max(180),
        z.string().trim().min(1).max(180),
    ]),
    source: z.enum(['checkpoint', 'safe_fallback']),
    operationKey: z.string().regex(NARRATIVE_OPERATION_KEY_PATTERN),
    aiResultHash: hashSchema.nullable(),
}).strict().superRefine((value, context) => {
    if ((value.source === 'checkpoint') !== (value.aiResultHash !== null)) {
        context.addIssue({ code: 'custom', message: 'Narrative result provenance drifted.' });
    }
});

const profilePayloadSchema = z.object({
    aiStagePolicyVersion: z.enum([
        'ai-stage-policy-v2.8',
        'ai-stage-policy-v2.9',
        'ai-stage-policy-v2.10',
    ]).optional(),
    outcomes: z.array(profileOutcomeSchema).min(1).max(30),
}).strict().superRefine((value, context) => {
    const exactV28Family = value.aiStagePolicyVersion === 'ai-stage-policy-v2.8'
        || value.aiStagePolicyVersion === 'ai-stage-policy-v2.9'
        || value.aiStagePolicyVersion === 'ai-stage-policy-v2.10';
    for (const [index, outcome] of value.outcomes.entries()) {
        const hasFeature = outcome.feature !== null;
        if (exactV28Family && hasFeature && outcome.aiStagePolicyVersion !== value.aiStagePolicyVersion) {
            context.addIssue({
                code: 'custom',
                path: ['outcomes', index, 'aiStagePolicyVersion'],
                message: 'v2.8-family feature outcome is not bound to the batch policy.',
            });
        }
        if (!exactV28Family && outcome.aiStagePolicyVersion === 'ai-stage-policy-v2.8') {
            // Preserve the exact legacy rejection contract for every stored v2.8 checkpoint.
            context.addIssue({
                code: 'custom',
                path: ['outcomes', index, 'aiStagePolicyVersion'],
                message: 'v2.8 outcome requires a v2.8 batch policy.',
            });
        }
        if (!exactV28Family && outcome.aiStagePolicyVersion === 'ai-stage-policy-v2.9') {
            context.addIssue({
                code: 'custom',
                path: ['outcomes', index, 'aiStagePolicyVersion'],
                message: 'v2.9 outcome requires a v2.9 batch policy.',
            });
        }
        if (!exactV28Family && outcome.aiStagePolicyVersion === 'ai-stage-policy-v2.10') {
            context.addIssue({
                code: 'custom',
                path: ['outcomes', index, 'aiStagePolicyVersion'],
                message: 'v2.10 outcome requires a v2.10 batch policy.',
            });
        }
    }
});
const primaryPayloadSchema = z.object({
    candidates: z.array(primaryCandidateSchema).max(900),
}).strict();
const screeningPayloadV24Schema = z.object({
    riskPolicyVersion: z.literal('risk-policy-v2.4'),
    shortlistHash: hashSchema,
    candidates: z.array(preliminaryCandidateSchema).max(900),
}).strict();
const screeningPayloadV23Schema = z.object({
    shortlistHash: hashSchema,
    candidates: z.array(legacyPreliminaryCandidateSchema).max(900),
}).strict();
const screeningPayloadSchema = z.union([screeningPayloadV24Schema, screeningPayloadV23Schema]);
const reverseRowsPayloadSchema = z.object({
    rows: z.array(reverseLikeRowSchema).max(10),
}).strict();
const partnerRowsPayloadSchema = z.object({
    rows: z.array(partnerSafetyRowSchema).max(10),
}).strict();
const narrativeRowsPayloadSchema = z.object({
    rows: z.array(narrativeRowSchema).max(3),
}).strict();
const finalPayloadV24Schema = z.object({
    riskPolicyVersion: z.literal('risk-policy-v2.4'),
    candidates: z.array(finalCandidateSchema).max(900),
    narrativeCandidateIds: z.array(candidateIdSchema).max(3),
    narrativeBatchHash: hashSchema,
}).strict();
const finalPayloadV23Schema = z.object({
    candidates: z.array(legacyFinalCandidateSchema).max(900),
    narrativeCandidateIds: z.array(candidateIdSchema).max(3),
    narrativeBatchHash: hashSchema,
}).strict();
const finalPayloadSchema = z.union([finalPayloadV24Schema, finalPayloadV23Schema]);

const rpcEnvelopeSchema = z.object({
    stageKind: stageKindSchema,
    batch: z.number().int().min(0).max(100_000).nullable(),
    revision: z.literal(1),
    resultHash: hashSchema,
    itemCount: z.number().int().min(0).max(1_200),
    payload: z.unknown(),
}).strict();

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2AiScoringStageSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export class AnalysisV2AiScoringStageFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH');
        this.name = 'AnalysisV2AiScoringStageFenceError';
    }
}

export class AnalysisV2AiScoringStageConflictError extends Error {
    constructor() {
        super('ANALYSIS_V2_AI_SCORING_STAGE_CONFLICT');
        this.name = 'AnalysisV2AiScoringStageConflictError';
    }
}

function validateClaim(input: AnalysisV2StageReadClaim): AnalysisV2StageReadClaim {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.jobInputHash)
    ) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_VALIDATION_ERROR: invalid claim.');
    }
    return {
        requestId: input.requestId.toLowerCase(),
        jobKey: input.jobKey,
        claimToken: input.claimToken.toLowerCase(),
        jobInputHash: input.jobInputHash,
    };
}

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (
        error.message === 'ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH'
    ) {
        throw new AnalysisV2AiScoringStageFenceError();
    }
    if (error.message === 'ANALYSIS_V2_AI_SCORING_STAGE_CONFLICT') {
        throw new AnalysisV2AiScoringStageConflictError();
    }
    throw new Error(
        `ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

interface StagePayloadMap {
    profile_ai_batch: z.infer<typeof profilePayloadSchema>;
    primary_join: z.infer<typeof primaryPayloadSchema>;
    screening: z.infer<typeof screeningPayloadSchema>;
    reverse_likes: z.infer<typeof reverseRowsPayloadSchema>;
    partner_safety: z.infer<typeof partnerRowsPayloadSchema>;
    final_score: z.infer<typeof finalPayloadSchema>;
    narrative: z.infer<typeof narrativeRowsPayloadSchema>;
}

function payloadSchema(kind: StageKind): z.ZodType<StagePayloadMap[StageKind]> {
    switch (kind) {
        case 'profile_ai_batch': return profilePayloadSchema;
        case 'primary_join': return primaryPayloadSchema;
        case 'screening': return screeningPayloadSchema;
        case 'reverse_likes': return reverseRowsPayloadSchema;
        case 'partner_safety': return partnerRowsPayloadSchema;
        case 'narrative': return narrativeRowsPayloadSchema;
        case 'final_score': return finalPayloadSchema;
    }
}

function parseEnvelope<K extends StageKind>(
    data: unknown,
    expectedKind: K,
    expectedBatch: number | null
): Omit<z.infer<typeof rpcEnvelopeSchema>, 'payload' | 'stageKind'> & {
    stageKind: K;
    payload: StagePayloadMap[K];
} {
    const parsed = rpcEnvelopeSchema.safeParse(Array.isArray(data) ? data[0] : data);
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: invalid response.');
    }
    if (parsed.data.stageKind !== expectedKind || parsed.data.batch !== expectedBatch) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: response drift.');
    }
    const payload = payloadSchema(expectedKind).safeParse(parsed.data.payload);
    if (!payload.success) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: invalid payload.');
    }
    return {
        ...parsed.data,
        stageKind: expectedKind,
        payload: payload.data as StagePayloadMap[K],
    };
}

function uniqueCandidates<T extends { candidateId: string }>(rows: readonly T[]): void {
    const ids = rows.map(row => candidateIdSchema.parse(row.candidateId));
    if (new Set(ids).size !== ids.length) {
        throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_VALIDATION_ERROR: duplicate candidate.');
    }
}

function commonParams(claim: AnalysisV2StageReadClaim) {
    const parsed = validateClaim(claim);
    return {
        p_request_id: parsed.requestId,
        p_job_key: parsed.jobKey,
        p_claim_token: parsed.claimToken,
        p_job_input_hash: parsed.jobInputHash,
    };
}

export function createSupabaseAnalysisV2AiScoringStageStore(
    client: AnalysisV2AiScoringStageSupabaseClient = supabaseAdmin
): AnalysisV2AiScoringStageStore {
    async function checkpoint<K extends StageKind>(
        claim: AnalysisV2StageReadClaim,
        kind: K,
        batch: number | null,
        itemCount: number,
        payload: unknown
    ) {
        const parsedPayload = payloadSchema(kind).parse(payload);
        const { data, error } = await client.rpc(
            ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.checkpointRpc,
            {
                ...commonParams(claim),
                p_stage_kind: kind,
                p_batch: batch,
                p_item_count: itemCount,
                p_payload: parsedPayload,
            }
        );
        if (error) throwRpcError(error, 'checkpoint');
        const envelope = parseEnvelope(data, kind, batch);
        if (envelope.itemCount !== itemCount) {
            throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: item count drift.');
        }
        return envelope;
    }

    async function load<K extends Exclude<StageKind, 'profile_ai_batch'>>(
        claim: AnalysisV2StageReadClaim,
        kind: K
    ) {
        const { data, error } = await client.rpc(
            ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.loadRpc,
            { ...commonParams(claim), p_stage_kind: kind }
        );
        if (error) throwRpcError(error, 'load');
        return data === null ? null : parseEnvelope(data, kind, null);
    }

    return {
        async checkpointProfileAiBatch(input) {
            const outcomes = profileOutcomeSchema.array().min(1).max(30).parse(input.outcomes);
            uniqueCandidates(outcomes);
            const payload = {
                ...(
                    input.aiStagePolicyVersion === 'ai-stage-policy-v2.8'
                    || input.aiStagePolicyVersion === 'ai-stage-policy-v2.9'
                    || input.aiStagePolicyVersion === 'ai-stage-policy-v2.10'
                    ? { aiStagePolicyVersion: input.aiStagePolicyVersion }
                    : {}),
                outcomes,
            };
            const envelope = await checkpoint(
                input,
                'profile_ai_batch',
                input.batch,
                outcomes.length,
                payload,
            );
            return {
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                itemCount: envelope.itemCount,
            };
        },

        async loadProfileAiOutcomes(input) {
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.loadProfileBatchesRpc,
                commonParams(input)
            );
            if (error) throwRpcError(error, 'profile batch load');
            if (!Array.isArray(data)) {
                throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: invalid profile batches.');
            }
            const batches = data.map(item => parseEnvelope(
                item,
                'profile_ai_batch',
                rpcEnvelopeSchema.parse(item).batch
            )).sort((left, right) => left.batch! - right.batch!);
            const outcomes = batches.flatMap(batch => batch.payload.outcomes);
            uniqueCandidates(outcomes);
            return Object.freeze(outcomes) as readonly AnalysisV2ProfileAiOutcome[];
        },

        async checkpointPrimaryJoin(input) {
            const candidates = primaryCandidateSchema.array().max(900).parse(input.candidates);
            uniqueCandidates(candidates);
            const envelope = await checkpoint(
                input, 'primary_join', null, candidates.length, { candidates }
            );
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                candidates: envelope.payload.candidates,
            }) as AnalysisV2PrimaryJoinSnapshot;
        },

        async loadPrimaryJoin(input) {
            const envelope = await load(input, 'primary_join');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                candidates: envelope.payload.candidates,
            }) as AnalysisV2PrimaryJoinSnapshot;
        },

        async checkpointScreening(input) {
            uniqueCandidates(input.candidates);
            const envelope = await checkpoint(input, 'screening', null, input.candidates.length, {
                ...(input.riskPolicyVersion === 'risk-policy-v2.3'
                    ? {} : { riskPolicyVersion: 'risk-policy-v2.4' }),
                shortlistHash: input.shortlistHash,
                candidates: input.candidates,
            });
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                shortlistHash: envelope.payload.shortlistHash,
                riskPolicyVersion: input.riskPolicyVersion ?? 'risk-policy-v2.4',
                candidates: envelope.payload.candidates,
            }) as AnalysisV2ScreeningSnapshot;
        },

        async loadScreening(input) {
            const envelope = await load(input, 'screening');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                shortlistHash: envelope.payload.shortlistHash,
                riskPolicyVersion: 'riskPolicyVersion' in envelope.payload
                    ? envelope.payload.riskPolicyVersion
                    : 'risk-policy-v2.3',
                candidates: envelope.payload.candidates,
            }) as AnalysisV2ScreeningSnapshot;
        },

        async checkpointReverseLikes(input) {
            uniqueCandidates(input.rows);
            const envelope = await checkpoint(
                input, 'reverse_likes', null, input.rows.length, { rows: input.rows }
            );
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2ReverseLikeSnapshot;
        },

        async loadReverseLikes(input) {
            const envelope = await load(input, 'reverse_likes');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2ReverseLikeSnapshot;
        },

        async checkpointPartnerSafety(input) {
            uniqueCandidates(input.rows);
            const envelope = await checkpoint(
                input, 'partner_safety', null, input.rows.length, { rows: input.rows }
            );
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2PartnerSafetySnapshot;
        },

        async loadPartnerSafety(input) {
            const envelope = await load(input, 'partner_safety');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2PartnerSafetySnapshot;
        },

        async checkpointFinalScores(input) {
            uniqueCandidates(input.candidates);
            const envelope = await checkpoint(input, 'final_score', null, input.candidates.length, {
                ...(input.riskPolicyVersion === 'risk-policy-v2.3'
                    ? {} : { riskPolicyVersion: 'risk-policy-v2.4' }),
                candidates: input.candidates,
                narrativeCandidateIds: input.narrativeCandidateIds,
                narrativeBatchHash: input.narrativeBatchHash,
            });
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                riskPolicyVersion: input.riskPolicyVersion ?? 'risk-policy-v2.4',
                candidates: envelope.payload.candidates,
                narrativeCandidateIds: envelope.payload.narrativeCandidateIds,
                narrativeBatchHash: envelope.payload.narrativeBatchHash,
            }) as AnalysisV2FinalScoreSnapshot;
        },

        async loadFinalScores(input) {
            const envelope = await load(input, 'final_score');
            return envelope === null ? null : Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                riskPolicyVersion: 'riskPolicyVersion' in envelope.payload
                    ? envelope.payload.riskPolicyVersion
                    : 'risk-policy-v2.3',
                candidates: envelope.payload.candidates,
                narrativeCandidateIds: envelope.payload.narrativeCandidateIds,
                narrativeBatchHash: envelope.payload.narrativeBatchHash,
            }) as AnalysisV2FinalScoreSnapshot;
        },

        async checkpointNarratives(input) {
            uniqueCandidates(input.rows);
            const envelope = await checkpoint(
                input, 'narrative', null, input.rows.length, { rows: input.rows }
            );
            return Object.freeze({
                revision: envelope.revision,
                resultHash: envelope.resultHash,
                rows: envelope.payload.rows,
            }) as AnalysisV2NarrativeSnapshot;
        },

        async purgeTerminal(input) {
            const { data, error } = await client.rpc(
                ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.purgeRpc,
                commonParams(input)
            );
            if (error) throwRpcError(error, 'purge');
            if (!Number.isSafeInteger(data) || (data as number) < 0) {
                throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: invalid purge result.');
            }
            return data as number;
        },
    };
}

export const analysisV2AiScoringStageStore =
    createSupabaseAnalysisV2AiScoringStageStore();
