import { z } from 'zod';
import {
    ANALYSIS_V2_SCHEMA_VERSION,
    analysisResultPageV1Schema,
    analysisResultSummaryV1Schema,
    femaleResultRowV1Schema,
    privateResultRowV1Schema,
    type AnalysisResultPageV1,
    type AnalysisResultSummaryV1,
    type FemaleResultRowV1,
    type PrivateResultRowV1,
} from '@/lib/contracts/analysis-v2';
import {
    RESULT_PAGE_SIZE_DEFAULT,
    RESULT_PAGE_SIZE_MAX,
    ResultPaginationError,
    decodeResultCursor,
    paginateAnalysisResults,
} from '@/lib/domain/analysis/result-pagination';
import { RISK_POLICY_VERSION } from '@/lib/domain/analysis/risk-policy';
import {
    canonicalizeImageProxyUrl,
    createAnalysisV2ResultImageProxyPath,
    type AnalysisV2ResultImageLocator,
} from '@/lib/services/media/image-proxy-token';
import { supabaseAdmin } from '@/lib/supabase/admin';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CANDIDATE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const AI_OPERATION_KEY_PATTERN = /^(gender-triage|feature-analysis|high-risk-narrative|private-account-name|partner-safety):[0-9a-f]{64}$/;

export const ANALYSIS_V2_RESULT_DATABASE_NAMES = Object.freeze({
    featureManifestTable: 'analysis_v2_candidate_feature_manifests',
    featureRowTable: 'analysis_v2_candidate_feature_rows',
    preliminaryManifestTable: 'analysis_v2_preliminary_score_manifests',
    preliminaryRowTable: 'analysis_v2_preliminary_score_rows',
    reverseManifestTable: 'analysis_v2_reverse_like_manifests',
    reverseRowTable: 'analysis_v2_reverse_like_rows',
    partnerManifestTable: 'analysis_v2_partner_safety_manifests',
    partnerRowTable: 'analysis_v2_partner_safety_rows',
    scoreManifestTable: 'analysis_v2_candidate_score_manifests',
    scoreRowTable: 'analysis_v2_candidate_score_rows',
    privateManifestTable: 'analysis_v2_private_name_manifests',
    privateRowTable: 'analysis_v2_private_name_rows',
    narrativeManifestTable: 'analysis_v2_narrative_manifests',
    narrativeRowTable: 'analysis_v2_narrative_rows',
    summaryTable: 'analysis_v2_result_summaries',
    femaleResultTable: 'analysis_v2_female_results',
    privateResultTable: 'analysis_v2_private_results',
    checkpointFeatureRpc: 'checkpoint_analysis_v2_candidate_features',
    checkpointPreliminaryRpc: 'checkpoint_analysis_v2_preliminary_scores',
    checkpointReverseRpc: 'checkpoint_analysis_v2_reverse_likes',
    checkpointPartnerRpc: 'checkpoint_analysis_v2_partner_safety',
    checkpointScoreRpc: 'checkpoint_analysis_v2_candidate_scores',
    checkpointPrivateRpc: 'checkpoint_analysis_v2_private_names',
    checkpointNarrativeRpc: 'checkpoint_analysis_v2_narratives',
    finalizeRpc: 'complete_analysis_v2_result_and_purge',
    failRpc: 'fail_analysis_v2_result_and_purge',
    loadStageRpc: 'load_analysis_v2_result_stage_snapshot',
    loadRpc: 'load_analysis_v2_result_snapshot',
    loadPageRpc: 'load_analysis_v2_result_page',
    loadImageRpc: 'load_analysis_v2_result_image_url',
});

const candidateIdSchema = z.string().regex(CANDIDATE_ID_PATTERN);
const hashSchema = z.string().regex(SHA256_PATTERN);
const operationKeySchema = z.string().regex(AI_OPERATION_KEY_PATTERN);
const usernameSchema = femaleResultRowV1Schema.shape.instagramId;
const fullNameSchema = femaleResultRowV1Schema.shape.fullName;
const oneLineOverviewSchema = femaleResultRowV1Schema.shape.oneLineOverview;
const rawImageUrlSchema = z.string().trim().min(1).max(8_192)
    .transform(value => canonicalizeImageProxyUrl(value))
    .nullable();
const selectionIdSchema = z.string().trim().min(1).max(240);
const evidenceRefIdSchema = z.string().trim().min(1).max(240);

const mediaContextSchema = z.object({
    bundleId: z.string().regex(/^bundle:[a-f0-9]{64}$/),
    selectionIds: z.array(selectionIdSchema).min(1).max(11),
    triageAnalyzedSelectionIds: z.array(selectionIdSchema).min(1).max(5),
    featureAnalyzedSelectionIds: z.array(selectionIdSchema).max(11),
    captions: z.array(z.object({
        evidenceRefId: evidenceRefIdSchema,
        selectionId: selectionIdSchema,
        text: z.string().max(2_200),
    }).strict()).max(10),
    posts: z.array(z.object({
        postId: z.string().trim().min(1).max(255),
        taggedUsers: z.array(usernameSchema).max(50),
        mentionedUsers: z.array(usernameSchema).max(50),
    }).strict()).max(8),
}).strict().superRefine((value, context) => {
    const selected = new Set(value.selectionIds);
    if (selected.size !== value.selectionIds.length) {
        context.addIssue({ code: 'custom', path: ['selectionIds'], message: 'Duplicate selection id.' });
    }
    for (const [field, ids] of [
        ['triageAnalyzedSelectionIds', value.triageAnalyzedSelectionIds],
        ['featureAnalyzedSelectionIds', value.featureAnalyzedSelectionIds],
    ] as const) {
        if (new Set(ids).size !== ids.length || ids.some(id => !selected.has(id))) {
            context.addIssue({ code: 'custom', path: [field], message: 'Analyzed media is outside the bundle.' });
        }
    }
    value.captions.forEach((caption, index) => {
        if (!selected.has(caption.selectionId)) {
            context.addIssue({ code: 'custom', path: ['captions', index], message: 'Caption media is outside the bundle.' });
        }
    });
});

export interface AnalysisV2ResultJobClaim {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
}

export interface AnalysisV2VerifiedFemaleFeatureData {
    appearanceGrade: 1 | 2 | 3 | 4 | 5;
    exposureScore: number;
    isBusinessAccount: boolean;
    featurePartnerEvidenceStrong: boolean;
    oneLineOverview: string;
}

export interface AnalysisV2CandidateMediaContext {
    bundleId: string;
    selectionIds: readonly string[];
    triageAnalyzedSelectionIds: readonly string[];
    featureAnalyzedSelectionIds: readonly string[];
    captions: readonly Readonly<{
        evidenceRefId: string;
        selectionId: string;
        text: string;
    }>[];
    posts: readonly Readonly<{
        postId: string;
        taggedUsers: readonly string[];
        mentionedUsers: readonly string[];
    }>[];
}

export type AnalysisV2TerminalProfileClassification =
    | 'verified_female'
    | 'verified_non_female'
    | 'unresolved'
    | 'unresolved_stage_conflict'
    | 'media_unavailable'
    | 'unavailable';

export interface AnalysisV2ProfileClassificationRow {
    candidateId: string;
    instagramId: string;
    fullName: string | null;
    profileImageUrl: string | null;
    bio: string | null;
    classification: AnalysisV2TerminalProfileClassification;
    mediaContext: AnalysisV2CandidateMediaContext | null;
    genderOperationKey: string | null;
    genderResultHash: string | null;
    featureOperationKey: string | null;
    featureResultHash: string | null;
    feature: AnalysisV2VerifiedFemaleFeatureData | null;
}

/** Backward-readable name for executor code; the row now contains every terminal classification. */
export type AnalysisV2VerifiedFemaleFeatureRow = AnalysisV2ProfileClassificationRow;

export interface AnalysisV2ScoreComponents {
    candidateToTargetLikes: number;
    candidateToTargetComments: number;
    targetToCandidateLike: number;
    tagOrCaptionMention: number;
    recentMutual: number;
    appearanceExposure: number;
}

export interface AnalysisV2PreliminaryScoreRow {
    candidateId: string;
    components: AnalysisV2ScoreComponents;
    preScore: number;
    possibleUpperBound: number;
    recentMutualRank: number | null;
    verificationShortlistRank: number | null;
}

export interface AnalysisV2ReverseLikeRow {
    candidateId: string;
    status: 'observed' | 'not_observed' | 'not_collected';
    componentScore: number;
    evidenceRefIds: readonly string[];
}

export interface AnalysisV2PartnerSafetyRow {
    candidateId: string;
    source: AnalysisV2PartnerSafetySource;
    hasStrongPartnerEvidence: boolean;
    hasWeakPartnerEvidence: boolean;
    strongEvidenceBasis: 'none' | 'feature' | 'contact_sheet' | 'both';
    evidenceSelectionIds: readonly string[];
    bundleId: string | null;
    operationKey: string | null;
    aiResultHash: string | null;
}

export type AnalysisV2PartnerSafetySource =
    | 'not_collected'
    | 'feature_only'
    | 'gemini'
    | 'safe_fallback';

export interface AnalysisV2CandidateScoreRow {
    candidateId: string;
    displayScore: number;
    riskBand: FemaleResultRowV1['riskBand'];
    featuredRank: number | null;
    recentMutualRank: number | null;
    verificationShortlistRank: number | null;
    partnerSafetySource: AnalysisV2PartnerSafetySource;
    partnerSafetyOperationKey: string | null;
    partnerSafetyResultHash: string | null;
    components: AnalysisV2ScoreComponents;
    weakPartnerAdjustment: -5 | 0;
    preScore: number;
    rawScore: number;
    possibleUpperBound: number;
    publicScore: number;
    possibleUpperPublicScore: number;
    partnerCapApplied: boolean;
    partnerEvidenceSelectionIds: readonly string[];
}

export type AnalysisV2AiFallbackSource = 'checkpoint' | 'safe_fallback';
export type AnalysisV2NarrativeSource = AnalysisV2AiFallbackSource | 'not_applicable';

export interface AnalysisV2PrivateNameRow {
    candidateId: string;
    instagramId: string;
    fullName: string | null;
    profileImageUrl: string | null;
    nameFemaleScore: number;
    nameIsName: boolean;
    nameConfidence: number;
}

export interface AnalysisV2NarrativeRow {
    candidateId: string;
    lines: readonly [string, string];
    source: AnalysisV2NarrativeSource;
    operationKey: string | null;
    aiResultHash: string | null;
}

export interface AnalysisV2ResultCheckpointManifest {
    requestId: string;
    jobKey: string;
    batch: number | null;
    itemCount: number;
    rowCount: number;
    resultHash: string;
}

export interface AnalysisV2FinalizationResult {
    finalized: boolean;
    requestStatus: 'completed';
    summary: AnalysisResultSummaryV1;
}

export interface AnalysisV2FailureResult {
    finalized: boolean;
    requestStatus: 'failed';
}

export interface AnalysisV2FinalizedSnapshot {
    requestId: string;
    summary: AnalysisResultSummaryV1;
    femaleAccounts: readonly Readonly<{
        candidateId: string;
        sortOrdinal: number;
        row: FemaleResultRowV1;
    }>[];
    privateAccounts: readonly Readonly<{
        candidateId: string;
        sortOrdinal: number;
        row: PrivateResultRowV1;
    }>[];
}

export interface AnalysisV2ResultStore {
    checkpointFeatureBatch(input: AnalysisV2ResultJobClaim & {
        batch: number;
        analyzedCount: number;
        rows: readonly AnalysisV2ProfileClassificationRow[];
    }): Promise<AnalysisV2ResultCheckpointManifest>;
    checkpointPreliminaryScores(input: AnalysisV2ResultJobClaim & {
        rows: readonly AnalysisV2PreliminaryScoreRow[];
    }): Promise<AnalysisV2ResultCheckpointManifest>;
    checkpointReverseLikes(input: AnalysisV2ResultJobClaim & {
        rows: readonly AnalysisV2ReverseLikeRow[];
    }): Promise<AnalysisV2ResultCheckpointManifest>;
    checkpointPartnerSafety(input: AnalysisV2ResultJobClaim & {
        rows: readonly AnalysisV2PartnerSafetyRow[];
    }): Promise<AnalysisV2ResultCheckpointManifest>;
    checkpointScores(input: AnalysisV2ResultJobClaim & {
        rows: readonly AnalysisV2CandidateScoreRow[];
    }): Promise<AnalysisV2ResultCheckpointManifest>;
    checkpointPrivateNames(input: AnalysisV2ResultJobClaim & {
        batch: number;
        source: AnalysisV2AiFallbackSource;
        operationKey: string;
        aiResultHash: string | null;
        rows: readonly AnalysisV2PrivateNameRow[];
    }): Promise<AnalysisV2ResultCheckpointManifest>;
    checkpointNarratives(input: AnalysisV2ResultJobClaim & {
        rows: readonly AnalysisV2NarrativeRow[];
    }): Promise<AnalysisV2ResultCheckpointManifest>;
    finalize(input: AnalysisV2ResultJobClaim & {
        targetProfileImageUrl: string | null;
    }): Promise<AnalysisV2FinalizationResult>;
    fail(input: AnalysisV2ResultJobClaim & {
        errorCode: string;
    }): Promise<AnalysisV2FailureResult>;
    loadSnapshot(input: {
        requestId: string;
        userId: string;
    }): Promise<AnalysisV2FinalizedSnapshot | null>;
    loadStageSnapshot(input: {
        requestId: string;
    }): Promise<AnalysisV2ResultStageSnapshot | null>;
    loadPage(input: {
        requestId: string;
        userId: string;
        femaleCursor?: string | null;
        privateCursor?: string | null;
        pageSize?: number;
    }): Promise<AnalysisResultPageV1 | null>;
}

export interface AnalysisV2ResultStageSnapshot {
    requestId: string;
    profileClassifications: readonly AnalysisV2ProfileClassificationRow[];
    preliminaryScores: readonly AnalysisV2PreliminaryScoreRow[];
    reverseLikes: readonly AnalysisV2ReverseLikeRow[];
    partnerSafety: readonly AnalysisV2PartnerSafetyRow[];
    finalScores: readonly AnalysisV2CandidateScoreRow[];
    privateNames: readonly AnalysisV2PrivateNameRow[];
    narratives: readonly AnalysisV2NarrativeRow[];
}

interface RpcError {
    code?: string;
    message?: string;
}

interface RpcResult {
    data: unknown;
    error: RpcError | null;
}

export interface AnalysisV2ResultSupabaseClient {
    rpc(name: string, params: Record<string, unknown>): PromiseLike<RpcResult>;
}

export class AnalysisV2ResultFenceError extends Error {
    constructor() {
        super('ANALYSIS_V2_RESULT_FENCE_MISMATCH');
        this.name = 'AnalysisV2ResultFenceError';
    }
}

export class AnalysisV2ResultConflictError extends Error {
    constructor() {
        super('ANALYSIS_V2_RESULT_CONFLICT');
        this.name = 'AnalysisV2ResultConflictError';
    }
}

export class AnalysisV2ResultNotReadyError extends Error {
    constructor() {
        super('ANALYSIS_V2_RESULT_NOT_READY');
        this.name = 'AnalysisV2ResultNotReadyError';
    }
}

const verifiedFemaleFeatureDataSchema = z.object({
    appearanceGrade: z.union([
        z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5),
    ]),
    exposureScore: z.number().int().min(0).max(5),
    isBusinessAccount: z.boolean(),
    featurePartnerEvidenceStrong: z.boolean(),
    oneLineOverview: oneLineOverviewSchema,
}).strict();

const featureRowSchema = z.object({
    candidateId: candidateIdSchema,
    instagramId: usernameSchema,
    fullName: fullNameSchema,
    profileImageUrl: rawImageUrlSchema,
    bio: z.string().max(2_200).nullable(),
    classification: z.enum([
        'verified_female', 'verified_non_female', 'unresolved',
        'unresolved_stage_conflict', 'media_unavailable', 'unavailable',
    ]),
    mediaContext: mediaContextSchema.nullable(),
    genderOperationKey: operationKeySchema.regex(/^gender-triage:/).nullable(),
    genderResultHash: hashSchema.nullable(),
    featureOperationKey: operationKeySchema.regex(/^feature-analysis:/).nullable(),
    featureResultHash: hashSchema.nullable(),
    feature: verifiedFemaleFeatureDataSchema.nullable(),
}).strict().superRefine((value, context) => {
    const genderPair = value.genderOperationKey !== null && value.genderResultHash !== null;
    const featurePair = value.featureOperationKey !== null && value.featureResultHash !== null;
    if ((value.genderOperationKey === null) !== (value.genderResultHash === null)) {
        context.addIssue({ code: 'custom', message: 'Gender operation/result must be paired.' });
    }
    if ((value.featureOperationKey === null) !== (value.featureResultHash === null)) {
        context.addIssue({ code: 'custom', message: 'Feature operation/result must be paired.' });
    }
    if (value.classification === 'unavailable' || value.classification === 'media_unavailable') {
        if (value.mediaContext || genderPair || featurePair || value.feature) {
            context.addIssue({ code: 'custom', message: 'Unavailable profiles cannot contain AI output.' });
        }
        return;
    }
    if (!value.mediaContext || !genderPair) {
        context.addIssue({ code: 'custom', message: 'Analyzed profiles require media and triage.' });
    }
    if (
        ['verified_female', 'unresolved', 'unresolved_stage_conflict'].includes(value.classification)
        && !featurePair
    ) {
        context.addIssue({ code: 'custom', message: 'This classification requires feature analysis.' });
    }
    if ((value.classification === 'verified_female') !== (value.feature !== null)) {
        context.addIssue({ code: 'custom', message: 'Only verified women retain scoring features.' });
    }
});

const scoreComponentsSchema = z.object({
    candidateToTargetLikes: z.number().finite().min(0).max(20),
    candidateToTargetComments: z.number().finite().min(0).max(26),
    targetToCandidateLike: z.number().finite().min(0).max(3),
    tagOrCaptionMention: z.number().finite().min(0).max(14),
    recentMutual: z.number().finite().min(0).max(17),
    appearanceExposure: z.number().finite().min(0).max(20),
}).strict();

const preliminaryScoreRowSchema = z.object({
    candidateId: candidateIdSchema,
    components: scoreComponentsSchema,
    preScore: z.number().finite().min(0).max(97),
    possibleUpperBound: z.number().finite().min(0).max(100),
    recentMutualRank: z.number().int().min(1).max(10).nullable(),
    verificationShortlistRank: z.number().int().min(1).max(10).nullable(),
}).strict().superRefine((value, context) => {
    if (value.components.targetToCandidateLike !== 0) {
        context.addIssue({ code: 'custom', path: ['components'], message: 'Preliminary reverse score must be zero.' });
    }
    const componentTotal = Object.values(value.components)
        .reduce((total, component) => total + component, 0);
    if (Math.abs(value.preScore - componentTotal) > 1e-6) {
        context.addIssue({ code: 'custom', path: ['preScore'], message: 'Preliminary score components drifted.' });
    }
    if (Math.abs(value.possibleUpperBound - Math.min(value.preScore + 3, 100)) > 1e-6) {
        context.addIssue({ code: 'custom', path: ['possibleUpperBound'], message: 'Invalid upper bound.' });
    }
});

const reverseLikeRowSchema = z.object({
    candidateId: candidateIdSchema,
    status: z.enum(['observed', 'not_observed', 'not_collected']),
    componentScore: z.union([z.literal(0), z.literal(3)]),
    evidenceRefIds: z.array(evidenceRefIdSchema).max(8),
}).strict().superRefine((value, context) => {
    if ((value.status === 'observed') !== (value.componentScore === 3)) {
        context.addIssue({ code: 'custom', message: 'Observed reverse likes must score three.' });
    }
    if ((value.status === 'observed') !== (value.evidenceRefIds.length > 0)) {
        context.addIssue({ code: 'custom', message: 'Observed reverse likes require evidence.' });
    }
});

const partnerSafetyRowSchema = z.object({
    candidateId: candidateIdSchema,
    source: z.enum(['not_collected', 'feature_only', 'gemini', 'safe_fallback']),
    hasStrongPartnerEvidence: z.boolean(),
    hasWeakPartnerEvidence: z.boolean(),
    strongEvidenceBasis: z.enum(['none', 'feature', 'contact_sheet', 'both']),
    evidenceSelectionIds: z.array(selectionIdSchema).max(8),
    bundleId: z.string().regex(/^bundle:[a-f0-9]{64}$/).nullable(),
    operationKey: operationKeySchema.regex(/^partner-safety:/).nullable(),
    aiResultHash: hashSchema.nullable(),
}).strict().superRefine((value, context) => {
    if ((value.strongEvidenceBasis !== 'none') !== value.hasStrongPartnerEvidence) {
        context.addIssue({ code: 'custom', message: 'Strong evidence basis mismatch.' });
    }
    if (value.hasStrongPartnerEvidence && value.hasWeakPartnerEvidence) {
        context.addIssue({ code: 'custom', message: 'Weak and strong partner evidence are exclusive.' });
    }
    if (value.source === 'gemini' && (!value.bundleId || !value.operationKey || !value.aiResultHash)) {
        context.addIssue({ code: 'custom', message: 'Gemini partner safety requires bundle and result.' });
    }
    if (value.source === 'safe_fallback' && (!value.bundleId || !value.operationKey || value.aiResultHash)) {
        context.addIssue({ code: 'custom', message: 'Partner fallback requires bundle and operation.' });
    }
    if (
        (value.source === 'not_collected' || value.source === 'feature_only')
        && (value.bundleId || value.operationKey || value.aiResultHash)
    ) {
        context.addIssue({ code: 'custom', message: 'Non-AI partner state cannot reference AI.' });
    }
});

const scoreRowSchema = z.object({
    candidateId: candidateIdSchema,
    displayScore: femaleResultRowV1Schema.shape.displayScore,
    riskBand: femaleResultRowV1Schema.shape.riskBand,
    featuredRank: femaleResultRowV1Schema.shape.featuredRank,
    recentMutualRank: femaleResultRowV1Schema.shape.recentMutualRank,
    verificationShortlistRank: z.number().int().min(1).max(10).nullable(),
    partnerSafetySource: z.enum([
        'not_collected', 'feature_only', 'gemini', 'safe_fallback',
    ]),
    partnerSafetyOperationKey: operationKeySchema.regex(/^partner-safety:/).nullable(),
    partnerSafetyResultHash: hashSchema.nullable(),
    components: scoreComponentsSchema,
    weakPartnerAdjustment: z.union([z.literal(-5), z.literal(0)]),
    preScore: z.number().finite().min(0).max(97),
    rawScore: z.number().finite().min(0).max(100),
    possibleUpperBound: z.number().finite().min(0).max(100),
    publicScore: z.number().finite().min(1).max(10),
    possibleUpperPublicScore: z.number().finite().min(1).max(10),
    partnerCapApplied: z.boolean(),
    partnerEvidenceSelectionIds: z.array(selectionIdSchema).max(8),
}).strict().superRefine((value, context) => {
    const hasOperation = value.partnerSafetyOperationKey !== null;
    const hasResult = value.partnerSafetyResultHash !== null;
    if (value.partnerSafetySource === 'gemini' && (!hasOperation || !hasResult)) {
        context.addIssue({ code: 'custom', message: 'Gemini partner safety requires a result.' });
    }
    if (value.partnerSafetySource === 'safe_fallback' && (!hasOperation || hasResult)) {
        context.addIssue({ code: 'custom', message: 'Fallback partner safety requires only an operation.' });
    }
    if (
        (value.partnerSafetySource === 'not_collected'
            || value.partnerSafetySource === 'feature_only')
        && (hasOperation || hasResult)
    ) {
        context.addIssue({ code: 'custom', message: 'Non-AI partner safety cannot reference AI.' });
    }
    if (
        value.verificationShortlistRank === null
        && value.partnerSafetySource !== 'not_collected'
    ) {
        context.addIssue({
            code: 'custom',
            message: 'Non-shortlist rows cannot contain partner-safety output.',
        });
    }
    const componentTotal = Object.values(value.components)
        .reduce((total, component) => total + component, 0);
    const expectedPreScore = Math.min(Math.max(
        componentTotal
            - value.components.targetToCandidateLike
            + value.weakPartnerAdjustment,
        0
    ), 97);
    const expectedRawScore = Math.min(Math.max(
        componentTotal + value.weakPartnerAdjustment,
        0
    ), 100);
    if (Math.abs(value.rawScore - expectedRawScore) > 1e-6) {
        context.addIssue({ code: 'custom', path: ['rawScore'], message: 'Raw score components drifted.' });
    }
    if (Math.abs(value.preScore - expectedPreScore) > 1e-6) {
        context.addIssue({ code: 'custom', path: ['preScore'], message: 'Preliminary score drifted.' });
    }
    const possibleUpperBounds = value.components.targetToCandidateLike === 0
        ? value.verificationShortlistRank === null
            ? [Math.min(value.preScore + 3, 100)]
            : [value.rawScore, Math.min(value.preScore + 3, 100)]
        : [value.rawScore];
    if (!possibleUpperBounds.some(
        expected => Math.abs(value.possibleUpperBound - expected) <= 1e-6
    )) {
        context.addIssue({ code: 'custom', path: ['possibleUpperBound'], message: 'Possible upper bound drifted.' });
    }
    if (Math.abs(value.displayScore * 10 - Math.round(value.publicScore * 10)) > 1e-6) {
        context.addIssue({ code: 'custom', path: ['displayScore'], message: 'Display score is not rounded public score.' });
    }
});

const privateNameRowSchema = z.object({
    candidateId: candidateIdSchema,
    instagramId: privateResultRowV1Schema.shape.instagramId,
    fullName: privateResultRowV1Schema.shape.fullName,
    profileImageUrl: rawImageUrlSchema,
    nameFemaleScore: z.number().finite().min(0).max(1),
    nameIsName: z.boolean(),
    nameConfidence: z.number().finite().min(0).max(1),
}).strict().superRefine((value, context) => {
    if (!value.nameIsName && value.nameFemaleScore !== 0.5) {
        context.addIssue({
            code: 'custom',
            path: ['nameFemaleScore'],
            message: 'Non-name rows must use a neutral female score.',
        });
    }
});

const narrativeRowSchema = z.object({
    candidateId: candidateIdSchema,
    lines: femaleResultRowV1Schema.shape.highRiskNarrative.unwrap(),
    source: z.enum(['checkpoint', 'safe_fallback', 'not_applicable']),
    operationKey: operationKeySchema.regex(/^high-risk-narrative:/).nullable(),
    aiResultHash: hashSchema.nullable(),
}).strict().superRefine((value, context) => {
    if (value.source === 'checkpoint' && (!value.operationKey || !value.aiResultHash)) {
        context.addIssue({ code: 'custom', message: 'Narrative checkpoint requires AI result.' });
    }
    if (value.source === 'safe_fallback' && (!value.operationKey || value.aiResultHash)) {
        context.addIssue({ code: 'custom', message: 'Narrative fallback requires only an operation.' });
    }
    if (value.source === 'not_applicable') {
        context.addIssue({ code: 'custom', message: 'Not-applicable narratives have no row.' });
    }
});

const checkpointManifestSchema = z.object({
    requestId: z.string().uuid(),
    jobKey: z.string().regex(JOB_KEY_PATTERN),
    batch: z.number().int().min(0).max(100_000).nullable(),
    itemCount: z.number().int().min(0).max(1_200),
    rowCount: z.number().int().min(0).max(1_200),
    resultHash: hashSchema,
}).strict().superRefine((value, context) => {
    if (value.rowCount > value.itemCount) {
        context.addIssue({ code: 'custom', path: ['rowCount'], message: 'rowCount exceeds itemCount.' });
    }
});

const { targetProfileImage: summaryImageShape, ...summaryWithoutImageShape } =
    analysisResultSummaryV1Schema.shape;
void summaryImageShape;
const rawSummarySchema = z.object({
    ...summaryWithoutImageShape,
    targetProfileImageUrl: rawImageUrlSchema,
}).strict();
const { profileImage: femaleImageShape, ...femaleWithoutImageShape } =
    femaleResultRowV1Schema.shape;
void femaleImageShape;
const rawFemaleResultRowSchema = z.object({
    ...femaleWithoutImageShape,
    profileImageUrl: rawImageUrlSchema,
}).strict();
const { profileImage: privateImageShape, ...privateWithoutImageShape } =
    privateResultRowV1Schema.shape;
void privateImageShape;
const rawPrivateResultRowSchema = z.object({
    ...privateWithoutImageShape,
    profileImageUrl: rawImageUrlSchema,
}).strict();

const rawFinalizationResultSchema = z.object({
    finalized: z.boolean(),
    requestStatus: z.literal('completed'),
    summary: rawSummarySchema,
}).strict();

const failureResultSchema = z.object({
    finalized: z.boolean(),
    requestStatus: z.literal('failed'),
}).strict();

const finalizedFemaleEnvelopeSchema = z.object({
    candidateId: candidateIdSchema,
    sortOrdinal: z.number().int().min(1).max(900),
    row: rawFemaleResultRowSchema,
}).strict();

const finalizedPrivateEnvelopeSchema = z.object({
    candidateId: candidateIdSchema,
    sortOrdinal: z.number().int().min(1).max(1_200),
    row: rawPrivateResultRowSchema,
}).strict();

const finalizedSnapshotSchema = z.object({
    requestId: z.string().uuid(),
    summary: rawSummarySchema,
    femaleAccounts: z.array(finalizedFemaleEnvelopeSchema).max(900),
    privateAccounts: z.array(finalizedPrivateEnvelopeSchema).max(1_200),
}).strict().superRefine((value, context) => {
    const candidateIds = new Set<string>();
    const usernames = new Set<string>();
    for (const [collection, rows] of [
        ['femaleAccounts', value.femaleAccounts],
        ['privateAccounts', value.privateAccounts],
    ] as const) {
        rows.forEach((entry, index) => {
            if (candidateIds.has(entry.candidateId) || usernames.has(entry.row.instagramId)) {
                context.addIssue({
                    code: 'custom',
                    path: [collection, index],
                    message: 'Finalized result identities must be globally unique.',
                });
            }
            candidateIds.add(entry.candidateId);
            usernames.add(entry.row.instagramId);
            if (entry.sortOrdinal !== index + 1) {
                context.addIssue({
                    code: 'custom',
                    path: [collection, index, 'sortOrdinal'],
                    message: 'Finalized result ordinals must be contiguous.',
                });
            }
        });
    }
    if (value.privateAccounts.length !== value.summary.privateMutuals) {
        context.addIssue({
            code: 'custom',
            path: ['privateAccounts'],
            message: 'Private result count must match the summary.',
        });
    }
    if (value.femaleAccounts.length > value.summary.screenedMutuals) {
        context.addIssue({
            code: 'custom',
            path: ['femaleAccounts'],
            message: 'Female result count exceeds screened mutuals.',
        });
    }
});

const finalizedPageSnapshotSchema = z.object({
    requestId: z.string().uuid(),
    summary: rawSummarySchema,
    femaleAccounts: z.array(finalizedFemaleEnvelopeSchema).max(RESULT_PAGE_SIZE_MAX + 1),
    privateAccounts: z.array(finalizedPrivateEnvelopeSchema).max(RESULT_PAGE_SIZE_MAX + 1),
}).strict().superRefine((value, context) => {
    const candidateIds = new Set<string>();
    const usernames = new Set<string>();
    for (const [collection, rows] of [
        ['femaleAccounts', value.femaleAccounts],
        ['privateAccounts', value.privateAccounts],
    ] as const) {
        let previousOrdinal = 0;
        rows.forEach((entry, index) => {
            if (
                entry.sortOrdinal <= previousOrdinal
                || candidateIds.has(entry.candidateId)
                || usernames.has(entry.row.instagramId)
            ) {
                context.addIssue({
                    code: 'custom',
                    path: [collection, index],
                    message: 'Paged results must be ordered and globally unique.',
                });
            }
            previousOrdinal = entry.sortOrdinal;
            candidateIds.add(entry.candidateId);
            usernames.add(entry.row.instagramId);
        });
    }
});

const stageSnapshotSchema = z.object({
    requestId: z.string().uuid(),
    profileClassifications: z.array(featureRowSchema).max(900),
    preliminaryScores: z.array(preliminaryScoreRowSchema).max(900),
    reverseLikes: z.array(reverseLikeRowSchema).max(900),
    partnerSafety: z.array(partnerSafetyRowSchema).max(900),
    finalScores: z.array(scoreRowSchema).max(900),
    privateNames: z.array(privateNameRowSchema).max(1_200),
    narratives: z.array(narrativeRowSchema).max(3),
}).strict();

function safeRpcCode(error: RpcError): string {
    return typeof error.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(error.code)
        ? error.code
        : 'unknown';
}

function throwRpcError(error: RpcError, operation: string): never {
    if (
        error.message === 'ANALYSIS_V2_RESULT_FENCE_MISMATCH'
        || error.message === 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH'
    ) {
        throw new AnalysisV2ResultFenceError();
    }
    if (
        error.message === 'ANALYSIS_V2_RESULT_CONFLICT'
        || error.message === 'ANALYSIS_V2_FINALIZE_CONFLICT'
    ) {
        throw new AnalysisV2ResultConflictError();
    }
    if (
        error.message === 'ANALYSIS_V2_RESULT_NOT_READY'
        || error.message === 'ANALYSIS_V2_FINALIZE_NOT_READY'
    ) {
        throw new AnalysisV2ResultNotReadyError();
    }
    if (
        error.message === 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED'
        || error.message === 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY'
    ) {
        throw new Error(error.message);
    }
    throw new Error(
        `ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: ${operation} failed (${safeRpcCode(error)}).`
    );
}

function rpcPayload(data: unknown, label: string): unknown {
    if (Array.isArray(data)) {
        if (data.length !== 1) {
            throw new Error(`ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: invalid ${label} result.`);
        }
        return data[0];
    }
    return data;
}

function validateClaim(input: AnalysisV2ResultJobClaim): AnalysisV2ResultJobClaim {
    if (
        !UUID_PATTERN.test(input.requestId)
        || !JOB_KEY_PATTERN.test(input.jobKey)
        || !UUID_PATTERN.test(input.claimToken)
        || !SHA256_PATTERN.test(input.jobInputHash)
    ) {
        throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid job claim.');
    }
    return {
        requestId: input.requestId.toLowerCase(),
        jobKey: input.jobKey,
        claimToken: input.claimToken.toLowerCase(),
        jobInputHash: input.jobInputHash,
    };
}

function uniqueSortedRows<T extends { candidateId: string }>(
    rows: readonly T[],
    schema: z.ZodType<T>
): T[] {
    const parsed = rows.map(row => schema.parse(row));
    parsed.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    if (new Set(parsed.map(row => row.candidateId)).size !== parsed.length) {
        throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: duplicate candidate id.');
    }
    return parsed;
}

function parseManifest(data: unknown): AnalysisV2ResultCheckpointManifest {
    const parsed = checkpointManifestSchema.safeParse(rpcPayload(data, 'checkpoint'));
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: invalid checkpoint result.');
    }
    return Object.freeze(parsed.data);
}

type ImageProxySigner = (
    rawUrl: string | null,
    locator: AnalysisV2ResultImageLocator
) => string | null;

function publicImagePath(
    rawUrl: string | null,
    signer: ImageProxySigner,
    locator: AnalysisV2ResultImageLocator
): string | null {
    if (rawUrl === null) return null;
    const signed = signer(rawUrl, locator);
    if (!signed) {
        throw new Error('ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: result image cannot be signed.');
    }
    return signed;
}

function publicSummary(
    value: z.infer<typeof rawSummarySchema>,
    signer: ImageProxySigner,
    requestId: string
): AnalysisResultSummaryV1 {
    const { targetProfileImageUrl, ...summary } = value;
    return analysisResultSummaryV1Schema.parse({
        ...summary,
        targetProfileImage: publicImagePath(targetProfileImageUrl, signer, {
            requestId,
            kind: 'target',
            candidateId: null,
        }),
    });
}

function publicFemaleEnvelope(
    entry: z.infer<typeof finalizedFemaleEnvelopeSchema>,
    requestId: string,
    signer: ImageProxySigner
) {
    const { profileImageUrl, ...row } = entry.row;
    return Object.freeze({
        candidateId: entry.candidateId,
        sortOrdinal: entry.sortOrdinal,
        row: femaleResultRowV1Schema.parse({
            ...row,
            profileImage: publicImagePath(profileImageUrl, signer, {
                requestId,
                kind: 'female',
                candidateId: entry.candidateId,
            }),
        }),
    });
}

function publicPrivateEnvelope(
    entry: z.infer<typeof finalizedPrivateEnvelopeSchema>,
    requestId: string,
    signer: ImageProxySigner
) {
    const { profileImageUrl, ...row } = entry.row;
    return Object.freeze({
        candidateId: entry.candidateId,
        sortOrdinal: entry.sortOrdinal,
        row: privateResultRowV1Schema.parse({
            ...row,
            profileImage: publicImagePath(profileImageUrl, signer, {
                requestId,
                kind: 'private',
                candidateId: entry.candidateId,
            }),
        }),
    });
}

function parseSnapshot(
    data: unknown,
    signer: ImageProxySigner
): AnalysisV2FinalizedSnapshot | null {
    if (data === null) return null;
    const parsed = finalizedSnapshotSchema.safeParse(rpcPayload(data, 'snapshot'));
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: invalid result snapshot.');
    }
    const femaleAccounts = parsed.data.femaleAccounts.map(entry => (
        publicFemaleEnvelope(entry, parsed.data.requestId, signer)
    ));
    const privateAccounts = parsed.data.privateAccounts.map(entry => (
        publicPrivateEnvelope(entry, parsed.data.requestId, signer)
    ));
    const snapshot: AnalysisV2FinalizedSnapshot = {
        requestId: parsed.data.requestId,
        summary: publicSummary(parsed.data.summary, signer, parsed.data.requestId),
        femaleAccounts: Object.freeze(femaleAccounts),
        privateAccounts: Object.freeze(privateAccounts),
    };
    return Object.freeze(snapshot);
}

function parsePageSnapshot(
    data: unknown,
    signer: ImageProxySigner
): AnalysisV2FinalizedSnapshot | null {
    if (data === null) return null;
    const parsed = finalizedPageSnapshotSchema.safeParse(rpcPayload(data, 'result page'));
    if (!parsed.success) {
        throw new Error('ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: invalid result page.');
    }
    return Object.freeze({
        requestId: parsed.data.requestId,
        summary: publicSummary(parsed.data.summary, signer, parsed.data.requestId),
        femaleAccounts: Object.freeze(parsed.data.femaleAccounts.map(entry => (
            publicFemaleEnvelope(entry, parsed.data.requestId, signer)
        ))),
        privateAccounts: Object.freeze(parsed.data.privateAccounts.map(entry => (
            publicPrivateEnvelope(entry, parsed.data.requestId, signer)
        ))),
    });
}

function pageCursor(
    cursor: string | null | undefined,
    list: 'public' | 'private'
): { ordinal: number; candidateId: string } | null {
    if (!cursor) return null;
    const parsed = decodeResultCursor(cursor);
    if (
        parsed.list !== list
        || parsed.direction !== 'asc'
        || parsed.sortKeyType !== 'number'
        || typeof parsed.sortKey !== 'number'
        || !Number.isSafeInteger(parsed.sortKey)
        || parsed.sortKey < 1
    ) {
        throw new ResultPaginationError('CURSOR_SCOPE_MISMATCH');
    }
    return { ordinal: parsed.sortKey, candidateId: parsed.candidateId };
}

export function paginateAnalysisV2FinalizedSnapshot(input: {
    snapshot: AnalysisV2FinalizedSnapshot;
    femaleCursor?: string | null;
    privateCursor?: string | null;
    pageSize?: number;
}): AnalysisResultPageV1 {
    const pageSize = input.pageSize ?? RESULT_PAGE_SIZE_DEFAULT;
    const female = paginateAnalysisResults(input.snapshot.femaleAccounts, {
        list: 'public',
        direction: 'asc',
        sortKeyType: 'number',
        getSortKey: item => item.sortOrdinal,
        getCandidateId: item => item.candidateId,
        cursor: input.femaleCursor,
        pageSize,
    });
    const privateAccounts = paginateAnalysisResults(input.snapshot.privateAccounts, {
        list: 'private',
        direction: 'asc',
        sortKeyType: 'number',
        getSortKey: item => item.sortOrdinal,
        getCandidateId: item => item.candidateId,
        cursor: input.privateCursor,
        pageSize,
    });
    return analysisResultPageV1Schema.parse({
        schemaVersion: ANALYSIS_V2_SCHEMA_VERSION,
        requestId: input.snapshot.requestId,
        summary: input.snapshot.summary,
        femaleAccounts: female.items.map(item => item.row),
        privateAccounts: privateAccounts.items.map(item => item.row),
        femaleNextCursor: female.nextCursor,
        privateNextCursor: privateAccounts.nextCursor,
    });
}

export function createSupabaseAnalysisV2ResultStore(
    client: AnalysisV2ResultSupabaseClient = supabaseAdmin,
    options: { imageProxySigner?: ImageProxySigner } = {}
): AnalysisV2ResultStore {
    const imageProxySigner: ImageProxySigner = options.imageProxySigner
        ?? ((_rawUrl, locator) => createAnalysisV2ResultImageProxyPath(locator) ?? null);
    async function checkpoint(
        rpcName: string,
        claimInput: AnalysisV2ResultJobClaim,
        params: Record<string, unknown>
    ): Promise<AnalysisV2ResultCheckpointManifest> {
        const claim = validateClaim(claimInput);
        const { data, error } = await client.rpc(rpcName, {
            p_request_id: claim.requestId,
            p_job_key: claim.jobKey,
            p_claim_token: claim.claimToken,
            p_job_input_hash: claim.jobInputHash,
            ...params,
        });
        if (error) throwRpcError(error, rpcName);
        return parseManifest(data);
    }

    return {
        async checkpointFeatureBatch(input) {
            if (!Number.isSafeInteger(input.batch) || input.batch < 0 || input.batch > 100_000) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid feature batch.');
            }
            if (
                !Number.isSafeInteger(input.analyzedCount)
                || input.analyzedCount < 1
                || input.analyzedCount > 30
            ) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid analyzed count.');
            }
            const rows = uniqueSortedRows(input.rows, featureRowSchema);
            if (rows.length !== input.analyzedCount) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: feature batch is incomplete.');
            }
            return checkpoint(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointFeatureRpc,
                input,
                { p_batch: input.batch, p_analyzed_count: input.analyzedCount, p_rows: rows }
            );
        },

        async checkpointPreliminaryScores(input) {
            const rows = uniqueSortedRows(input.rows, preliminaryScoreRowSchema);
            return checkpoint(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointPreliminaryRpc,
                input,
                { p_rows: rows }
            );
        },

        async checkpointReverseLikes(input) {
            const rows = uniqueSortedRows(input.rows, reverseLikeRowSchema);
            return checkpoint(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointReverseRpc,
                input,
                { p_rows: rows }
            );
        },

        async checkpointPartnerSafety(input) {
            const rows = uniqueSortedRows(input.rows, partnerSafetyRowSchema);
            return checkpoint(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointPartnerRpc,
                input,
                { p_rows: rows }
            );
        },

        async checkpointScores(input) {
            const rows = uniqueSortedRows(input.rows, scoreRowSchema);
            return checkpoint(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointScoreRpc,
                input,
                { p_rows: rows, p_risk_policy_version: RISK_POLICY_VERSION }
            );
        },

        async checkpointPrivateNames(input) {
            if (!Number.isSafeInteger(input.batch) || input.batch < 0 || input.batch > 100_000) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid private batch.');
            }
            const operationKey = operationKeySchema.regex(/^private-account-name:/)
                .parse(input.operationKey);
            const aiResultHash = input.aiResultHash === null ? null : hashSchema.parse(input.aiResultHash);
            if (
                (input.source === 'checkpoint' && aiResultHash === null)
                || (input.source === 'safe_fallback' && aiResultHash !== null)
            ) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid private AI source.');
            }
            const rows = uniqueSortedRows(input.rows, privateNameRowSchema);
            if (
                input.source === 'safe_fallback'
                && rows.some(row => (
                    row.nameFemaleScore !== 0.5
                    || row.nameIsName
                    || row.nameConfidence !== 0
                ))
            ) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: fallback rows must be neutral.');
            }
            return checkpoint(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointPrivateRpc,
                input,
                {
                    p_batch: input.batch,
                    p_source: input.source,
                    p_operation_key: operationKey,
                    p_ai_result_hash: aiResultHash,
                    p_rows: rows,
                }
            );
        },

        async checkpointNarratives(input) {
            const rows = uniqueSortedRows(input.rows, narrativeRowSchema);
            if (rows.length > 3) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: too many narratives.');
            }
            return checkpoint(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.checkpointNarrativeRpc,
                input,
                { p_rows: rows }
            );
        },

        async finalize(input) {
            const claim = validateClaim(input);
            if (claim.jobKey !== 'coordinator:finalize') {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid finalizer job.');
            }
            const targetProfileImageUrl = rawImageUrlSchema.parse(input.targetProfileImageUrl);
            const { data, error } = await client.rpc(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.finalizeRpc,
                {
                    p_request_id: claim.requestId,
                    p_job_key: claim.jobKey,
                    p_claim_token: claim.claimToken,
                    p_job_input_hash: claim.jobInputHash,
                    p_target_profile_image_url: targetProfileImageUrl,
                }
            );
            if (error) throwRpcError(error, 'result finalization');
            const parsed = rawFinalizationResultSchema.safeParse(rpcPayload(data, 'finalization'));
            if (!parsed.success) {
                throw new Error('ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: invalid finalization result.');
            }
            return Object.freeze({
                finalized: parsed.data.finalized,
                requestStatus: parsed.data.requestStatus,
                summary: publicSummary(parsed.data.summary, imageProxySigner, claim.requestId),
            });
        },

        async fail(input) {
            const claim = validateClaim(input);
            if (!ERROR_CODE_PATTERN.test(input.errorCode)) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid error code.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.failRpc,
                {
                    p_request_id: claim.requestId,
                    p_job_key: claim.jobKey,
                    p_claim_token: claim.claimToken,
                    p_job_input_hash: claim.jobInputHash,
                    p_error_code: input.errorCode,
                }
            );
            if (error) throwRpcError(error, 'result failure');
            const parsed = failureResultSchema.safeParse(rpcPayload(data, 'failure'));
            if (!parsed.success) {
                throw new Error('ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: invalid failure result.');
            }
            return Object.freeze(parsed.data);
        },

        async loadSnapshot(input) {
            if (!UUID_PATTERN.test(input.requestId) || !UUID_PATTERN.test(input.userId)) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid result owner input.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.loadRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_user_id: input.userId.toLowerCase(),
                }
            );
            if (error) throwRpcError(error, 'result load');
            return parseSnapshot(data, imageProxySigner);
        },

        async loadStageSnapshot(input) {
            if (!UUID_PATTERN.test(input.requestId)) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid stage request id.');
            }
            const { data, error } = await client.rpc(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.loadStageRpc,
                { p_request_id: input.requestId.toLowerCase() }
            );
            if (error) throwRpcError(error, 'result stage load');
            if (data === null) return null;
            const parsed = stageSnapshotSchema.safeParse(rpcPayload(data, 'stage snapshot'));
            if (!parsed.success) {
                throw new Error('ANALYSIS_V2_RESULT_PERSISTENCE_ERROR: invalid stage snapshot.');
            }
            return Object.freeze(parsed.data as AnalysisV2ResultStageSnapshot);
        },

        async loadPage(input) {
            if (!UUID_PATTERN.test(input.requestId) || !UUID_PATTERN.test(input.userId)) {
                throw new Error('ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid result owner input.');
            }
            const pageSize = input.pageSize ?? RESULT_PAGE_SIZE_DEFAULT;
            if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > RESULT_PAGE_SIZE_MAX) {
                throw new ResultPaginationError('INVALID_PAGE_SIZE');
            }
            const femaleCursor = pageCursor(input.femaleCursor, 'public');
            const privateCursor = pageCursor(input.privateCursor, 'private');
            const { data, error } = await client.rpc(
                ANALYSIS_V2_RESULT_DATABASE_NAMES.loadPageRpc,
                {
                    p_request_id: input.requestId.toLowerCase(),
                    p_user_id: input.userId.toLowerCase(),
                    p_female_after_ordinal: femaleCursor?.ordinal ?? null,
                    p_female_after_candidate_id: femaleCursor?.candidateId ?? null,
                    p_private_after_ordinal: privateCursor?.ordinal ?? null,
                    p_private_after_candidate_id: privateCursor?.candidateId ?? null,
                    p_page_size: pageSize,
                }
            );
            if (error) throwRpcError(error, 'result page load');
            const snapshot = parsePageSnapshot(data, imageProxySigner);
            if (!snapshot) return null;
            return paginateAnalysisV2FinalizedSnapshot({
                snapshot,
                femaleCursor: input.femaleCursor,
                privateCursor: input.privateCursor,
                pageSize: input.pageSize,
            });
        },
    };
}

export const analysisV2ResultStore = createSupabaseAnalysisV2ResultStore();
