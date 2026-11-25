import type { V211CopySubjects } from './public-copy-quality';
import {
    currentDevStandardArchive,
    DevStandardArchiveError,
    DevStandardArchiveStorageRetryError,
    sealDevStandardArchive,
} from '@/lib/services/dev-ui/standard-archive-runtime';
import { createHash } from 'node:crypto';
import {
    MAX_RECENT_POSTS,
    selectAnalysisMedia,
    type SelectedAnalysisMedia,
} from '@/lib/domain/analysis/media-policy';
import {
    applyGenderResolution,
    createFeatureAnalysisResultIdentity,
    createGenderResolutionResultIdentity,
    prepareGenderTriagePlanAccount,
    type GenderTriagePlanAccount,
} from '@/lib/services/ai/v2-staged-analysis';
import { buildCarouselCaptionPolicy } from '@/lib/domain/analysis/carousel-caption-policy';
import {
    calculateRiskPolicy,
    type AccountContext,
    type AppearanceGrade,
    type RiskBand,
    type RiskPolicyVersion,
} from '@/lib/domain/analysis/risk-policy';
import { createPartnerSafetyContactSheet } from '@/lib/services/ai/partner-contact-sheet';
import {
    resultImageArchiveIdentity,
    resultImageOrderedManifestHash,
    type ResultImageCaptureSource,
} from '@/lib/services/media/result-image-capture';
import type {
    FeatureAnalysisInput,
    FeatureAnalysisResult,
    GenderTriageResult,
    GenderTriageInput,
    HighRiskNarrativeInput,
    NormalizedAiMediaSelection,
    PartnerSafetyResult,
} from '@/lib/services/ai/v2-staged-analysis';
import {
    AI_STAGE_POLICY_V211_VERSION,
    aiStagePolicySupports,
    assertSupportedAiStagePolicyVersion,
    type AiStagePolicyCapability,
    type AiStagePolicyVersion,
} from '@/lib/services/ai/stage-policy';
import { devStandardEvalBundleSchema, type DevStandardEvalBundle } from '@/lib/services/dev-ui/standard-eval-types';
import type { AnalysisV2CheckpointProfile } from './v2-profile-fetch-store';
import type {
    AnalysisV2CanonicalTargetEvidenceRow,
    AnalysisV2RelationshipStagingSnapshot,
    AnalysisV2TargetEvidenceStagingSnapshot,
} from './v2-evidence-store';
import {
    calculateV2FinalScores,
    calculateV2PreliminaryScores,
    hasCandidateTargetMention,
    type V2FinalCandidateScore,
    type V2PreliminaryCandidateScore,
} from './v2-candidate-scoring';
import {
    calculateLegacyV23FinalScores,
    calculateLegacyV23PreliminaryRisk,
    calculateLegacyV23PreliminaryScores,
    type LegacyV23PreliminaryCandidate,
} from './v2-legacy-risk-recovery';
import {
    joinVerifiedFemaleTargetInteractions,
    summarizeCandidateTargetInteractions,
} from './v2-target-interactions';
import type { InteractionEvidenceRow } from './interaction-stage';
import type {
    AnalysisV2AiFallbackSource,
    AnalysisV2CandidateScoreRow,
    AnalysisV2NarrativeRow,
    AnalysisV2PartnerSafetyRow as AnalysisV2StoredPartnerSafetyRow,
    AnalysisV2PreliminaryScoreRow,
    AnalysisV2PrivateNameRow,
    AnalysisV2ReverseLikeRow as AnalysisV2StoredReverseLikeRow,
    AnalysisV2ResultCheckpointManifest,
    AnalysisV2RevenueResolverOutcomePatch,
    AnalysisV2ResultStageSnapshot,
    AnalysisV2ResultStore,
    AnalysisV2VerifiedFemaleFeatureRow,
} from './v2-result-store';
import type {
    AnalysisV2MediaArtifactStore,
    AnalysisV2NormalizedMediaBundleItem,
} from './v2-media-artifact-store';
import { ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES } from './v2-media-artifact-store';
import {
    analysisV2SourceMediaArchiveId,
    type AnalysisV2SourceMediaArchiveStore,
} from './v2-source-media-archive';
import {
    DeferredProfileFeatureInput, persistProfileMedia, pinProfileFeatureMedia,
    profileMediaInputStore, profileMediaReceipt, restoreProfileMedia,
    type ProfileMediaInput, type ProfileMediaInputStore,
} from './v2-profile-media-inputs';
import type {
    AnalysisV2StageExecutorContext,
    AnalysisV2StageExecutorRegistry,
} from './v2-worker';
import {
    enqueueFinalizedAnalysisOrderAuditBundle,
    type OrderAuditBundleEnqueue,
} from './order-audit-bundle';
import {
    AnalysisV2GenderResolutionCutoffPersistenceError,
    type AnalysisV2AiStageRuntime,
    type AnalysisV2GenderResolutionHandle,
    type AnalysisV2GenderResolutionState,
} from './v2-ai-stage-runtime';
import { AnalysisV2AiResultRecoveryPendingError } from './v2-ai-result-store';
import { isAnalysisV2AiDeterministicFallbackError } from './v2-ai-fallback-policy';
import { emitAnalysisLifecycleEvent } from '@/lib/services/analytics-server';
import {
    screenAnalysisV2OfficialAccount,
    type AnalysisV2OfficialExclusionReason,
} from './v2-official-account-screening';
import { v29FeatureAdmission } from './v2-v29-feature-admission';
import { v211FeatureAdmission } from './v2-v211-feature-admission';
import { v29GenderResolverAdmission } from './v2-v29-gender-resolver-admission';
import { selectAnalysisV2GenderResolverMedia } from './v2-gender-resolver-media-policy';
import { selectAnalysisV2ProgressCandidateMedia } from './progress-candidate-media';
import { assertCoverageInvariant } from './revenue-ledger';
import type { AnalysisV2RevenueFinalQualityGate } from './revenue-final-quality-gate';
import type {
    AnalysisV2RevenueResolverCapacity,
    AnalysisV2RevenueResolverCapacityAdmission,
} from './revenue-resolver-capacity';
import {
    AnalysisV2TransientMediaPreparationError,
    isAnalysisV2PartialMediaCoverageAllowed,
    captureDevStandardMediaSelection,
    normalizeAnalysisV2MediaSelections,
    type AnalysisV2ProfileMediaCoverage,
} from './v2-media-normalization';
export {
    ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS,
    AnalysisV2TransientMediaPreparationError,
    isAnalysisV2PartialMediaCoverageAllowed,
    normalizeAnalysisV2MediaSelections,
    type AnalysisV2ProfileMediaCoverage,
} from './v2-media-normalization';

const PROFILE_BATCH_JOB_PREFIX = 'track:profiles:batch:';
const LEGACY_MAX_PROFILE_AI_CONCURRENCY = 4;
const SCHEDULER_V1_PROFILE_PIPELINE_CONCURRENCY = 6;
const MAX_PARTNER_SAFETY_CONCURRENCY = 3;
const MAX_NARRATIVE_CONCURRENCY = 3;
const REVERSE_LIKE_LIMIT = 100;
export function analysisV2ProfilePipelineConcurrency(
    aiStagePolicyVersion: string,
    schedulerCapability: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>[
        'schedulerCapability'
    ],
    configured?: number,
): number {
    return configured ?? (
        policySupports(aiStagePolicyVersion, 'inputQualityV28')
        && schedulerCapability === 'scheduler-v1'
            ? SCHEDULER_V1_PROFILE_PIPELINE_CONCURRENCY
            : LEGACY_MAX_PROFILE_AI_CONCURRENCY
    );
}

export type AnalysisV2ProfileAiTerminalStatus =
    | 'verified_female'
    | 'verified_non_female'
    | 'unresolved'
    | 'unresolved_stage_conflict'
    | 'fetch_unavailable'
    | 'media_unavailable'
    | 'analysis_unavailable';

export type AnalysisV2ProfileUnavailableReason =
    | 'profile_fetch'
    | 'ai_response';

export interface AnalysisV2StoredCaptionEvidence {
    evidenceRefId: string;
    selectionId: string;
    text: string;
}

export interface AnalysisV2ProfileAiOutcome {
    candidateId: string;
    instagramId: string;
    status: AnalysisV2ProfileAiTerminalStatus;
    unavailableReason: AnalysisV2ProfileUnavailableReason | null;
    profile: AnalysisV2CheckpointProfile | null;
    triage: GenderTriageResult | null;
    feature: FeatureAnalysisResult | null;
    normalizedSelectionIds: readonly string[];
    mediaCoverage: AnalysisV2ProfileMediaCoverage;
    captions: readonly AnalysisV2StoredCaptionEvidence[];
    genderOperationKey: string | null;
    genderResultHash: string | null;
    featureOperationKey: string | null;
    featureResultHash: string | null;
    baselineClassification: AnalysisV2ProfileAiTerminalStatus;
    classificationSource:
        | 'triage'
        | 'feature'
        | 'gender_resolution'
        | 'unknown'
        | 'unavailable';
    genderResolutionStatus:
        | 'disabled'
        | 'not_eligible'
        | 'ready_applied'
        | 'ready_not_needed'
        | 'ready_inconclusive'
        | 'cutoff'
        | 'capacity_skipped'
        | 'terminal_unavailable';
    genderResolutionOperationKey: string | null;
    genderResolutionResultHash: string | null;
    mediaBundlePersisted: boolean;
    sourceMediaArchive?: Readonly<{
        triageSha256: string;
        featureRemainderSha256: string | null;
    }>;
    /** v2.8 provenance only: aggregate counts, never source URLs/captions/media. */
    mediaSelectionProvenance?: Readonly<{
        triageSelectedCount: number;
        featureSelectedCount: number;
        selectedKinds: Readonly<{
            profile: number;
            postRepresentative: number;
            carouselContext: number;
        }>;
    }>;
    aiStagePolicyVersion?: AiStagePolicyVersion;
    inputQualityPolicy?: 'input-quality-v2.8';
    /** v2.9-only pre-feature gate; prevents unsupported accounts from spending a feature call. */
    v29FeatureAdmission?: 'eligible' | 'nonpersonal_or_official' | 'unsupported_unknown';
    /** v2.8 screened context consumed by the existing v2.4 risk policy. */
    accountContextOverride?: AccountContext;
    officialScreeningStatus?:
        | 'not_model_official'
        | 'corroborated_official'
        | 'uncorroborated_official';
    officialExclusionReason?: AnalysisV2OfficialExclusionReason | null;
}

function analysisUnavailableOutcome(
    candidateId: string,
    instagramId: string,
    profile: AnalysisV2CheckpointProfile,
    genderResolutionStatus: AnalysisV2ProfileAiOutcome['genderResolutionStatus'] = 'disabled',
    genderResolutionOperationKey: string | null = null,
    genderResolutionResultHash: string | null = null,
): AnalysisV2ProfileAiOutcome {
    return {
        candidateId,
        instagramId: normalizeUsername(instagramId),
        status: 'analysis_unavailable',
        unavailableReason: 'ai_response',
        profile,
        triage: null,
        feature: null,
        normalizedSelectionIds: [],
        mediaCoverage: { selectedCount: 0, normalizedCount: 0, failures: [] },
        captions: [],
        genderOperationKey: null,
        genderResultHash: null,
        featureOperationKey: null,
        featureResultHash: null,
        baselineClassification: 'analysis_unavailable',
        classificationSource: 'unavailable',
        genderResolutionStatus,
        genderResolutionOperationKey,
        genderResolutionResultHash,
        mediaBundlePersisted: false,
    };
}

async function settleOptionalGenderResolution(
    handle: AnalysisV2GenderResolutionHandle | null
): Promise<AnalysisV2GenderResolutionState | null> {
    if (!handle) return null;
    if (handle.peek().status !== 'pending') return handle.peek();
    try {
        await handle.cutoff();
    } catch (error) {
        // cutoff() already fences the optional provider call before bounded audit
        // bookkeeping. A slow ledger write must not discard the required analysis;
        // finalization still observes and gates any genuinely nonterminal attempt.
        if (!(error instanceof AnalysisV2GenderResolutionCutoffPersistenceError)) {
            throw error;
        }
    }
    return handle.peek();
}

interface AnalysisV2DeferredProfileAiOutcome {
    kind: 'resolver_pending';
    resolverHandle: AnalysisV2GenderResolutionHandle | null;
    finalize(
        resolverState: AnalysisV2GenderResolutionState | null
    ): Promise<AnalysisV2ProfileAiOutcome>;
}

type AnalysisV2PreparedProfileAiOutcome =
    | AnalysisV2ProfileAiOutcome
    | AnalysisV2DeferredProfileAiOutcome;

type TriageMedia = Awaited<ReturnType<typeof normalizeAnalysisV2MediaSelections>>;
interface ProfileGenderEvidence {
    ordinal: number;
    username: string;
    candidateId: string;
    profile: AnalysisV2CheckpointProfile;
    policy: ReturnType<typeof mediaPolicy>;
    selectionProvenance?: ReturnType<typeof mediaSelectionProvenance>;
    profileEvidence?: GenderTriageInput['accountProfile'];
    triageSha256: string;
}
type GenderEvaluation = () => ReturnType<AnalysisV2AiStageRuntime['gender']>;
interface PlannedProfile {
    kind: 'planned_gender';
    account: GenderTriagePlanAccount;
    evidence: ProfileGenderEvidence;
    load(): Promise<TriageMedia>;
}

function profileGenderInput(media: TriageMedia, evidence: ProfileGenderEvidence): GenderTriageInput {
    return {
        media: media.media,
        ...(evidence.profileEvidence ? { accountProfile: evidence.profileEvidence } : {}),
    };
}

/** Retain only JPEG buffers within the job budget. Larger batches can reload the exact immutable archive. */
function profileTriageLoader(
    normalized: TriageMedia, retain: boolean, archive: AnalysisV2SourceMediaArchiveStore,
    reference: { requestId: string; archiveId: string; contentSha256: string },
): PlannedProfile['load'] {
    const manifest = normalized.media.map(({ selectionId, kind, postId }) => ({ selectionId, kind, postId }));
    const coverage = normalized.coverage;
    const cached = retain ? normalized.bytes : null;
    return async () => {
        let bytes = cached;
        if (!bytes) {
            const rows = await archive.loadBundle({
                ...reference,
                expectedSelectionIds: manifest.map(row => row.selectionId),
            });
            if (!rows) throw new Error('ANALYSIS_V2_MEDIA_SELECTION_DRIFT');
            bytes = new Map(rows.map(row => [row.selectionId, row.normalizedJpeg]));
        }
        const media = manifest.map(row => {
            const buffer = bytes.get(row.selectionId);
            if (!buffer) throw new Error('ANALYSIS_V2_MEDIA_SELECTION_DRIFT');
            return { ...row, normalizedJpegBase64: buffer.toString('base64') };
        });
        return { media, bytes, coverage };
    };
}

/** A paired call and its dependent profile pipelines occupy the same candidate slots as before. */
async function runProfileGroups<T>(
    groups: readonly T[], concurrency: number, memberCount: (group: T) => number,
    run: (group: T, slots: number) => Promise<void>,
) {
    const active = new Set<Promise<void>>();
    let occupied = 0;
    let failed = false;
    let failure: unknown;
    for (const group of groups) {
        const slots = Math.min(concurrency, memberCount(group));
        while (!failed && occupied + slots > concurrency) await Promise.race(active);
        if (failed) break;
        occupied += slots;
        const task = run(group, slots).catch(error => {
            if (!failed) {
                failed = true;
                failure = error;
            }
        }).finally(() => {
            occupied -= slots;
            active.delete(task);
        });
        active.add(task);
    }
    await Promise.all(active);
    if (failed) throw failure;
}

function isDeferredProfileAiOutcome(
    value: AnalysisV2PreparedProfileAiOutcome
): value is AnalysisV2DeferredProfileAiOutcome {
    return 'kind' in value && value.kind === 'resolver_pending';
}

export interface AnalysisV2PrimaryJoinCandidate {
    candidateId: string;
    instagramId: string;
    interactions: readonly InteractionEvidenceRow[];
}

export interface AnalysisV2PrimaryJoinSnapshot {
    revision: number;
    resultHash: string;
    candidates: readonly AnalysisV2PrimaryJoinCandidate[];
}

export interface AnalysisV2ScreeningSnapshot {
    revision: number;
    resultHash: string;
    shortlistHash: string;
    /** The persisted scoring contract; absent only on pre-policy in-memory test doubles. */
    riskPolicyVersion?: 'risk-policy-v2.3' | RiskPolicyVersion;
    candidates: readonly V2PreliminaryCandidateScore[];
}

export type AnalysisV2ReverseLikeObservation =
    | 'observed'
    | 'observed_not_found'
    | 'not_collected';

export interface AnalysisV2ReverseLikeRow {
    candidateId: string;
    shortlistRank: number;
    status: AnalysisV2ReverseLikeObservation;
    operationKey: string | null;
}

export interface AnalysisV2ReverseLikeSnapshot {
    revision: number;
    resultHash: string;
    rows: readonly AnalysisV2ReverseLikeRow[];
}

export interface AnalysisV2PartnerSafetyRow {
    candidateId: string;
    shortlistRank: number;
    result: PartnerSafetyResult;
    operationKey: string | null;
    resultHash: string | null;
    mediaCoverage: AnalysisV2ProfileMediaCoverage;
}

export interface AnalysisV2PartnerSafetySnapshot {
    revision: number;
    resultHash: string;
    rows: readonly AnalysisV2PartnerSafetyRow[];
}

export interface AnalysisV2FinalScoreSnapshot {
    revision: number;
    resultHash: string;
    /** The persisted scoring contract; absent only on pre-policy in-memory test doubles. */
    riskPolicyVersion?: 'risk-policy-v2.3' | RiskPolicyVersion;
    candidates: readonly V2FinalCandidateScore[];
    narrativeCandidateIds: readonly string[];
    narrativeBatchHash: string;
}

export interface AnalysisV2NarrativeCheckpointRow extends AnalysisV2NarrativeRow {
    source: 'checkpoint' | 'safe_fallback';
    operationKey: string;
    aiResultHash: string | null;
}

export interface AnalysisV2NarrativeSnapshot {
    revision: number;
    resultHash: string;
    rows: readonly AnalysisV2NarrativeCheckpointRow[];
}

export interface AnalysisV2ProfileAiBatchCheckpoint {
    revision: number;
    resultHash: string;
    itemCount: number;
}

export type AnalysisV2PrivateNameBatchCheckpoint = AnalysisV2ProfileAiBatchCheckpoint;

/** Service-only read/write model. It may contain evidence but is never returned by public APIs. */
export interface AnalysisV2AiScoringStageStore {
    checkpointProfileAiBatch(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        batch: number;
        aiStagePolicyVersion?: AiStagePolicyVersion;
        outcomes: readonly AnalysisV2ProfileAiOutcome[];
    }): Promise<AnalysisV2ProfileAiBatchCheckpoint>;
    loadProfileAiOutcomes(input: AnalysisV2StageReadClaim):
        Promise<readonly AnalysisV2ProfileAiOutcome[]>;
    checkpointPrimaryJoin(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        candidates: readonly AnalysisV2PrimaryJoinCandidate[];
    }): Promise<AnalysisV2PrimaryJoinSnapshot>;
    loadPrimaryJoin(input: AnalysisV2StageReadClaim):
        Promise<AnalysisV2PrimaryJoinSnapshot | null>;
    checkpointScreening(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        candidates: readonly V2PreliminaryCandidateScore[];
        shortlistHash: string;
        riskPolicyVersion?: 'risk-policy-v2.3' | RiskPolicyVersion;
    }): Promise<AnalysisV2ScreeningSnapshot>;
    loadScreening(input: AnalysisV2StageReadClaim): Promise<AnalysisV2ScreeningSnapshot | null>;
    checkpointReverseLikes(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        rows: readonly AnalysisV2ReverseLikeRow[];
    }): Promise<AnalysisV2ReverseLikeSnapshot>;
    loadReverseLikes(input: AnalysisV2StageReadClaim):
        Promise<AnalysisV2ReverseLikeSnapshot | null>;
    checkpointPartnerSafety(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        rows: readonly AnalysisV2PartnerSafetyRow[];
    }): Promise<AnalysisV2PartnerSafetySnapshot>;
    loadPartnerSafety(input: AnalysisV2StageReadClaim):
        Promise<AnalysisV2PartnerSafetySnapshot | null>;
    checkpointFinalScores(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        candidates: readonly V2FinalCandidateScore[];
        narrativeCandidateIds: readonly string[];
        narrativeBatchHash: string;
        riskPolicyVersion?: 'risk-policy-v2.3' | RiskPolicyVersion;
    }): Promise<AnalysisV2FinalScoreSnapshot>;
    loadFinalScores(input: AnalysisV2StageReadClaim):
        Promise<AnalysisV2FinalScoreSnapshot | null>;
    checkpointNarratives(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        rows: readonly AnalysisV2NarrativeCheckpointRow[];
    }): Promise<AnalysisV2NarrativeSnapshot>;
    purgeTerminal(input: AnalysisV2StageReadClaim): Promise<number>;
}

export interface AnalysisV2StageReadClaim {
    requestId: string;
    jobKey: string;
    claimToken: string;
    jobInputHash: string;
}

export interface AnalysisV2ProfileBatchReadModel {
    loadExactBatch(input: {
        requestId: string;
        consumerJobKey: string;
        consumerClaimToken: string;
        consumerInputHash: string;
        producerJobKey: string;
        batch: number;
        expectedItemCount: number;
        expectedProducerInputHash: string;
    }): Promise<Readonly<{
        requestedUsernames: readonly string[];
        results: readonly Readonly<{
            username: string;
            status: 'success' | 'unavailable' | 'failed';
            profile?: AnalysisV2CheckpointProfile;
        }>[];
    }> | null>;
}

export interface AnalysisV2TargetProfileReadModel {
    loadTargetProfile(claim: AnalysisV2StageReadClaim): Promise<AnalysisV2CheckpointProfile>;
}

export interface AnalysisV2RelationshipEvidenceReadModel {
    loadRelationships(claim: AnalysisV2StageReadClaim):
        Promise<AnalysisV2RelationshipStagingSnapshot>;
    loadTargetEvidence(claim: AnalysisV2StageReadClaim):
        Promise<AnalysisV2TargetEvidenceStagingSnapshot>;
}

export interface AnalysisV2ReverseLikeCollectionInput {
    candidateId: string;
    postUrl: string;
    declaredLikesCount: number;
    declaredLikesCountKnown?: boolean;
}

export interface AnalysisV2ReverseLikeCollectionResult {
    candidateId: string;
    status: 'observed' | 'not_observed' | 'not_collected';
}

export interface AnalysisV2ReverseLikeCollector {
    collect(input: {
        requestId: string;
        jobKey: string;
        claimToken: string;
        jobInputHash: string;
        targetUsername: string;
        candidates: readonly AnalysisV2ReverseLikeCollectionInput[];
        limitPerPost: 100;
    }): Promise<Readonly<{
        operationKey: string | null;
        results: readonly AnalysisV2ReverseLikeCollectionResult[];
    }>>;
}

type DevStandardEvalBuilder = (expiresAt: number) => Promise<DevStandardEvalBundle | null>;

export interface AnalysisV2AiScoringExecutorDependencies {
    profileBatches: AnalysisV2ProfileBatchReadModel;
    evidence: AnalysisV2RelationshipEvidenceReadModel;
    targetProfiles: AnalysisV2TargetProfileReadModel;
    stageStore: AnalysisV2AiScoringStageStore;
    resultStore: Pick<AnalysisV2ResultStore,
        | 'checkpointFeatureBatch'
        | 'checkpointPreliminaryScores'
        | 'checkpointReverseLikes'
        | 'checkpointPartnerSafety'
        | 'checkpointPrivateNames'
        | 'checkpointScores'
        | 'checkpointNarratives'
        | 'checkpointRevenueResolverOutcomes'
        | 'loadRevenueResolverOutcomes'
        | 'finalize'
        | 'loadStageSnapshot'>;
    resultImages?: {
        capture(input: AnalysisV2StageReadClaim & {
            sources: readonly ResultImageCaptureSource[];
            orderedManifestHash: string;
            expectedRows: number;
        }): Promise<unknown>;
    };
    orderAuditBundle?: {
        enqueue: OrderAuditBundleEnqueue;
    };
    mediaStore: AnalysisV2MediaArtifactStore;
    /** Required archive for every normalized image set actually passed to V2 AI. */
    sourceMediaArchive: AnalysisV2SourceMediaArchiveStore;
    profileMediaInputs?: ProfileMediaInputStore;
    devStandardEvalCapture?: (build: DevStandardEvalBuilder) => Promise<void>;
    ai: AnalysisV2AiStageRuntime;
    reverseLikes: AnalysisV2ReverseLikeCollector;
    normalizeMedia(media: SelectedAnalysisMedia): Promise<Buffer>;
    createContactSheet?: typeof createPartnerSafetyContactSheet;
    profileAiConcurrency?: number;
    partnerSafetyConcurrency?: number;
    narrativeConcurrency?: number;
    analysisLifecycleEventEmitter?: typeof emitAnalysisLifecycleEvent;
    /**
     * Strict test-entitlement only: verify the immutable primary-join quality
     * checkpoint immediately before auto-finalization. Production and Plus
     * never consult it because their relationship state has no strict marker.
     */
    revenueFinalQualityGate?: AnalysisV2RevenueFinalQualityGate;
    /**
     * Strict request-scoped resolver admission. It is queried only after the
     * immutable strict relationship-selection marker at primary_join, after
     * every profile-AI batch is durable and before screening.
     */
    revenueResolverCapacity?: AnalysisV2RevenueResolverCapacity;
}

export function buildAnalysisV2ResultImageSources(input: {
    targetProfileImageUrl: string | null;
    stage: AnalysisV2ResultStageSnapshot;
}): ResultImageCaptureSource[] {
    const featureByCandidate = new Map(
        input.stage.profileClassifications.map(row => [
            row.candidateId,
            row,
        ])
    );
    const female = [...input.stage.finalScores]
        .sort((left, right) => (
            right.displayScore - left.displayScore
            || left.candidateId.localeCompare(right.candidateId)
        ))
        .map(score => {
            const feature = featureByCandidate.get(score.candidateId);
            if (!feature || feature.classification !== 'verified_female') {
                throw new Error(
                    'ANALYSIS_V2_RESULT_IMAGE_SOURCE_NOT_READY'
                );
            }
            return {
                candidateLocator: score.candidateId,
                sourceUrl: feature.profileImageUrl,
            };
        });
    const privateRows = [...input.stage.privateNames]
        .sort((left, right) => (
            right.nameFemaleScore - left.nameFemaleScore
            || right.nameConfidence - left.nameConfidence
            || left.instagramId.localeCompare(right.instagramId)
        ));

    return [
        {
            kind: 'target',
            candidateLocator: 'target',
            sortOrdinal: 0,
            sourceUrl: input.targetProfileImageUrl,
        },
        ...female.map((row, index) => ({
            kind: 'female' as const,
            candidateLocator: row.candidateLocator,
            sortOrdinal: index + 1,
            sourceUrl: row.sourceUrl,
        })),
        ...privateRows.map((row, index) => ({
            kind: 'private' as const,
            candidateLocator: row.candidateId,
            sortOrdinal: female.length + index + 1,
            sourceUrl: row.profileImageUrl,
        })),
    ];
}

function sha256(domain: string, value: unknown): string {
    return createHash('sha256')
        .update(`${domain}\n${canonicalJson(value)}`, 'utf8')
        .digest('hex');
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
        return JSON.stringify(value);
    }
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error('ANALYSIS_V2_STAGE_INVALID_JSON');
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const record = value as Record<string, unknown>;
        return `{${Object.keys(record).sort().map(key => (
            `${JSON.stringify(key)}:${canonicalJson(record[key])}`
        )).join(',')}}`;
    }
    throw new Error('ANALYSIS_V2_STAGE_INVALID_JSON');
}

export function analysisV2CandidateId(username: string): string {
    const normalized = normalizeUsername(username);
    return `candidate:${createHash('sha256').update(
        `analysis-v2-candidate-id-v1\n${normalized}`,
        'utf8'
    ).digest('hex').slice(0, 40)}`;
}

export function analysisV2CandidateBundleId(candidateId: string): string {
    return `bundle:${createHash('sha256').update(
        `analysis-v2-candidate-bundle-v1\n${candidateId}`,
        'utf8'
    ).digest('hex')}`;
}

export function analysisV2PartnerSafetyBundleId(candidateId: string): string {
    return `bundle:${createHash('sha256').update(
        `analysis-v2-partner-safety-bundle:v1\n${candidateId}`,
        'utf8'
    ).digest('hex')}`;
}

function normalizeUsername(value: string): string {
    const normalized = value.trim().replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9._]{1,30}$/.test(normalized)) {
        throw new Error('ANALYSIS_V2_STAGE_INVALID_USERNAME');
    }
    return normalized;
}

type AnalysisV2StageIdSubset =
    | 'profile_ai'
    | 'private_names'
    | 'primary_join'
    | 'screening'
    | 'reverse_likes'
    | 'partner_safety'
    | 'final_score'
    | 'narrative'
    | 'finalize';

async function runBounded<T, R>(
    values: readonly T[],
    concurrency: number,
    task: (value: T, index: number) => Promise<R>
): Promise<R[]> {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 16) {
        throw new Error('ANALYSIS_V2_STAGE_INVALID_CONCURRENCY');
    }
    const results = new Array<R>(values.length);
    let next = 0;
    let firstError: unknown;
    let failed = false;
    async function worker() {
        while (!failed && next < values.length) {
            const index = next++;
            try {
                results[index] = await task(values[index], index);
            } catch (error) {
                if (!failed) {
                    failed = true;
                    firstError = error;
                }
            }
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
    if (failed) throw firstError;
    return results;
}

async function awaitArchivedAi<T>(
    ai: Promise<T>,
    archive: Promise<void>,
): Promise<T> {
    const [aiResult, archiveResult] = await Promise.allSettled([ai, archive]);
    if (archiveResult.status === 'rejected') throw archiveResult.reason;
    if (aiResult.status === 'rejected') throw aiResult.reason;
    return aiResult.value;
}

function mediaPolicy(
    profile: AnalysisV2CheckpointProfile,
    inputQualityV28 = false,
) {
    const latestPosts = profile.latestPosts ?? [];
    if (
        !profile.isPrivate
        && latestPosts.length < Math.min(profile.postsCount, MAX_RECENT_POSTS)
    ) {
        throw new Error('ANALYSIS_V2_PROFILE_MEDIA_STRUCTURAL_INCOMPLETE');
    }
    const policy = selectAnalysisMedia({
        profile: profile.profilePicUrl
            ? { id: profile.username, imageUrl: profile.profilePicUrl }
            : undefined,
        posts: latestPosts,
    }, inputQualityV28 ? { carouselDiversity: true } : undefined);
    if (policy.carouselCoverage.incompletePostIds.length > 0) {
        throw new Error('ANALYSIS_V2_PROFILE_MEDIA_STRUCTURAL_INCOMPLETE');
    }
    return policy;
}

function remainingFeatureMedia(policy: ReturnType<typeof mediaPolicy>) {
    const triage = new Set(policy.triage.selectionIds);
    return policy.feature.media.filter(item => !triage.has(item.selectionId));
}

function mediaSelectionProvenance(
    policy: ReturnType<typeof mediaPolicy>
): AnalysisV2ProfileAiOutcome['mediaSelectionProvenance'] {
    const selectedKinds = {
        profile: 0,
        postRepresentative: 0,
        carouselContext: 0,
    };
    for (const media of policy.feature.media) {
        if (media.role === 'profile') selectedKinds.profile += 1;
        else if (media.role === 'post_representative') selectedKinds.postRepresentative += 1;
        else if (media.role === 'carousel_context') selectedKinds.carouselContext += 1;
    }
    return Object.freeze({
        triageSelectedCount: policy.triage.media.length,
        featureSelectedCount: policy.feature.media.length,
        selectedKinds: Object.freeze(selectedKinds),
    });
}

async function retainedDevEvalCandidate(input: {
    requestId: string;
    outcome: AnalysisV2ProfileAiOutcome;
    archive: AnalysisV2SourceMediaArchiveStore;
}): Promise<DevStandardEvalBundle['candidates'][number]> {
    const { requestId, outcome, archive } = input;
    if (!outcome.profile || !outcome.triage || !outcome.feature || !outcome.featureOperationKey) {
        throw new Error('DEV_STANDARD_EVAL_FEATURE_MISSING');
    }
    const { profile, triage, candidateId } = outcome;
    const plan = mediaPolicy(profile, true);
    const triageIds = new Set(plan.triage.selectionIds);
    const normalizedIds = new Set(outcome.normalizedSelectionIds);
    const remainderIds = plan.feature.selectionIds.filter(id => !triageIds.has(id) && normalizedIds.has(id));
    const read = async (
        stage: 'triage' | 'feature_remainder',
        ids: readonly string[],
        contentSha256?: string | null,
    ) => {
        if ((!ids.length && contentSha256) || (ids.length && contentSha256 === null)) {
            throw new Error('DEV_STANDARD_EVAL_MEDIA_MISSING');
        }
        if (!ids.length) return [];
        const items = await archive.loadBundle({
            requestId,
            archiveId: analysisV2SourceMediaArchiveId({ candidateId, stage }),
            ...(contentSha256 ? { contentSha256 } : {}),
            expectedSelectionIds: ids,
        });
        if (!items) throw new Error('DEV_STANDARD_EVAL_MEDIA_MISSING');
        return items;
    };
    const [triageMedia, remainderMedia] = await Promise.all([
        read('triage', triage.analyzedSelectionIds, outcome.sourceMediaArchive?.triageSha256),
        read('feature_remainder', remainderIds, outcome.sourceMediaArchive?.featureRemainderSha256),
    ]);
    const byId = new Map([...triageMedia, ...remainderMedia].map(item => [item.selectionId, item.normalizedJpeg]));
    const media = plan.feature.media.filter(item => normalizedIds.has(item.selectionId)).map(item => {
        const bytes = byId.get(item.selectionId);
        if (!bytes) throw new Error('DEV_STANDARD_EVAL_MEDIA_MISSING');
        return {
            selectionId: item.selectionId,
            kind: item.role === 'profile' ? 'profile' as const : 'feed' as const,
            normalizedJpegBase64: bytes.toString('base64'),
            ...(item.postId ? { postId: item.postId } : {}),
        };
    });
    const featureInput: FeatureAnalysisInput = {
        triage,
        bio: profile.bio ?? null,
        media,
        captions: [...outcome.captions],
        accountProfile: {
            fullName: profile.fullName ?? null,
            hasProfileImage: Boolean(profile.profilePicUrl?.trim()),
            bio: profile.bio ?? null,
        },
    };
    const identity = createFeatureAnalysisResultIdentity(featureInput, AI_STAGE_POLICY_V211_VERSION);
    if (identity.operationKey !== outcome.featureOperationKey) {
        throw new Error('DEV_STANDARD_EVAL_FEATURE_IDENTITY_CHANGED');
    }
    return {
        candidateId,
        input: featureInput,
        featureOperationKey: identity.operationKey,
        featureResult: outcome.feature,
    };
}

async function captureDevStandardEval(
    context: AnalysisV2StageExecutorContext<'final_score'>,
    capture: AnalysisV2AiScoringExecutorDependencies['devStandardEvalCapture'],
    build: DevStandardEvalBuilder,
) {
    if (!capture || context.riskPolicyVersion !== 'risk-policy-v2.5') return;
    try {
        const policy = await context.loadAiPolicy?.() ?? context;
        if (policy.aiStagePolicyVersion === AI_STAGE_POLICY_V211_VERSION) await capture(build);
    } catch {
        // The optional evaluation must never block either score checkpoint.
        console.warn('DEV_STANDARD_EVAL_CAPTURE_FAILED');
    }
}

function policySupports(
    version: string,
    capability: AiStagePolicyCapability,
): boolean {
    try {
        return aiStagePolicySupports(assertSupportedAiStagePolicyVersion(version), capability);
    } catch {
        return false;
    }
}

function isAnalysisV2StageMediaCoverageUsable(
    coverage: AnalysisV2ProfileMediaCoverage,
    aiStagePolicyVersion: string,
): boolean {
    const usable = policySupports(aiStagePolicyVersion, 'partialMediaCoverage')
        ? isAnalysisV2PartialMediaCoverageAllowed(coverage)
        : coverage.normalizedCount >= 1 && coverage.failures.length === 0;
    if (!usable && coverage.failures.some(failure => failure.disposition === 'transient')) {
        const failureReasons = coverage.failures.reduce<Record<string, number>>(
            (counts, failure) => {
                counts[failure.reason] = (counts[failure.reason] ?? 0) + 1;
                return counts;
            },
            {},
        );
        console.warn('Analysis V2 media preparation has transient failures', {
            selectedCount: coverage.selectedCount,
            failureReasons,
        });
        throw new AnalysisV2TransientMediaPreparationError();
    }
    return usable;
}

function mergeNormalizedSelections(
    selected: readonly SelectedAnalysisMedia[],
    parts: readonly Awaited<ReturnType<typeof normalizeAnalysisV2MediaSelections>>[]
): Awaited<ReturnType<typeof normalizeAnalysisV2MediaSelections>> {
    const bytes = new Map(parts.flatMap(part => [...part.bytes.entries()]));
    const failures = new Map(parts.flatMap(part => part.coverage.failures.map(failure => [
        failure.selectionId,
        failure,
    ] as const)));
    const media = selected.flatMap(item => {
        const normalized = bytes.get(item.selectionId);
        if (!normalized) return [];
        return [{
            selectionId: item.selectionId,
            kind: item.role === 'profile' ? 'profile' as const : 'feed' as const,
            normalizedJpegBase64: normalized.toString('base64'),
            ...(item.postId ? { postId: item.postId } : {}),
        }];
    });
    if (media.length + failures.size !== selected.length) {
        throw new Error('ANALYSIS_V2_MEDIA_PREPARATION_COVERAGE_DRIFT');
    }
    return {
        media,
        bytes,
        coverage: Object.freeze({
            selectedCount: selected.length,
            normalizedCount: media.length,
            failures: Object.freeze([...failures.values()]),
        }),
    };
}

function finalProfileResults(
    batch: Awaited<ReturnType<AnalysisV2ProfileBatchReadModel['loadExactBatch']>>
) {
    if (!batch) throw new Error('ANALYSIS_V2_PROFILE_AI_BATCH_NOT_READY');
    if (
        batch.requestedUsernames.length !== batch.results.length
        || batch.requestedUsernames.some((username, index) => (
            normalizeUsername(username) !== normalizeUsername(batch.results[index].username)
        ))
    ) {
        throw new Error('ANALYSIS_V2_PROFILE_AI_BATCH_DRIFT');
    }
    if (batch.results.some(result => result.status === 'failed')) {
        throw new Error('ANALYSIS_V2_PROFILE_CONSUMER_RETRYABLE_OUTCOME');
    }
    return batch.results;
}

function strongFeaturePartnerEvidence(feature: FeatureAnalysisResult): boolean {
    return feature.features.partnerExclusionContext === 'none'
        && (
            feature.features.marriageEvidence === 'strong'
            || feature.features.partnerEvidence === 'strong'
        );
}

function weakFeaturePartnerEvidence(feature: FeatureAnalysisResult): boolean {
    return feature.features.partnerExclusionContext === 'none'
        && !strongFeaturePartnerEvidence(feature)
        && (
            feature.features.marriageEvidence === 'possible'
            || feature.features.partnerEvidence === 'weak'
        );
}

function analyzedPosts(outcome: AnalysisV2ProfileAiOutcome) {
    if (!outcome.profile) return [];
    const normalizedSelectionIds = new Set(outcome.normalizedSelectionIds);
    const policy = mediaPolicy(outcome.profile, outcome.mediaSelectionProvenance !== undefined);
    const selectedPostIds = new Set([
        ...policy.triage.media,
        ...policy.feature.media,
    ].flatMap(media => (
        media.postId && normalizedSelectionIds.has(media.selectionId) ? [media.postId] : []
    )));
    const emittedPostIds = new Set<string>();
    return (outcome.profile.latestPosts ?? []).flatMap(post => {
        const postId = post.id.trim();
        if (!selectedPostIds.has(postId) || emittedPostIds.has(postId)) return [];
        emittedPostIds.add(postId);
        return [{
            postId,
            taggedUsers: post.taggedUsers,
            mentionedUsers: post.mentionedUsers,
        }];
    });
}

function screenedAccountContext(
    outcome: AnalysisV2ProfileAiOutcome,
    exactV28Policy = false,
): AccountContext {
    const modelContext = outcome.feature?.features.accountContext ?? 'uncertain';
    // Legacy requests intentionally ignore v2.8-only fields. Exact request policy,
    // not field sniffing, chooses the semantic branch.
    if (!exactV28Policy) return modelContext;
    const hasCompleteV28Provenance =
        (
            policySupports(outcome.aiStagePolicyVersion ?? '', 'inputQualityV28')
        )
        && outcome.inputQualityPolicy === 'input-quality-v2.8'
        && outcome.mediaSelectionProvenance !== undefined
        && outcome.accountContextOverride !== undefined
        && outcome.officialScreeningStatus !== undefined
        && outcome.officialExclusionReason !== undefined;
    if (!hasCompleteV28Provenance) return 'uncertain';
    if (!outcome.profile) return 'uncertain';
    let expectedMedia: AnalysisV2ProfileAiOutcome['mediaSelectionProvenance'];
    try {
        expectedMedia = mediaSelectionProvenance(mediaPolicy(outcome.profile, true));
    } catch {
        return 'uncertain';
    }
    if (
        expectedMedia === undefined
        || canonicalJson(expectedMedia) !== canonicalJson(outcome.mediaSelectionProvenance)
    ) {
        return 'uncertain';
    }
    const canonicalScreening = screenAnalysisV2OfficialAccount({
        modelAccountContext: modelContext,
        fullName: outcome.profile.fullName ?? null,
        bio: outcome.profile.bio ?? null,
    });
    const canonicalContext = modelContext === 'official_group_or_brand'
        ? canonicalScreening.accountContext
        : modelContext;
    const canonicalStatus = modelContext !== 'official_group_or_brand'
        ? 'not_model_official'
        : canonicalScreening.exclusionReason
            ? 'corroborated_official'
            : 'uncorroborated_official';
    if (
        outcome.accountContextOverride !== canonicalContext
        || outcome.officialScreeningStatus !== canonicalStatus
        || outcome.officialExclusionReason !== canonicalScreening.exclusionReason
    ) {
        return 'uncertain';
    }
    if (outcome.officialScreeningStatus === 'not_model_official') {
        return modelContext !== 'official_group_or_brand'
            && outcome.accountContextOverride === modelContext
            && outcome.officialExclusionReason === null
            ? modelContext
            : 'uncertain';
    }
    if (modelContext !== 'official_group_or_brand') return 'uncertain';
    if (
        outcome.officialScreeningStatus === 'corroborated_official'
        && outcome.accountContextOverride === 'official_group_or_brand'
        && outcome.officialExclusionReason === 'model_group_context_plus_profile_signals'
    ) {
        return 'official_group_or_brand';
    }
    if (
        outcome.officialScreeningStatus === 'uncorroborated_official'
        && outcome.accountContextOverride === 'uncertain'
        && outcome.officialExclusionReason === null
    ) {
        return 'uncertain';
    }
    return 'uncertain';
}

function publicFeatureRow(
    outcome: AnalysisV2ProfileAiOutcome,
    exactV28Policy = false,
): AnalysisV2VerifiedFemaleFeatureRow {
    if (
        outcome.status === 'fetch_unavailable'
        || outcome.status === 'media_unavailable'
        || outcome.status === 'analysis_unavailable'
    ) {
        const mediaUnavailable = outcome.status === 'media_unavailable';
        return {
            candidateId: outcome.candidateId,
            instagramId: outcome.instagramId,
            fullName: outcome.profile?.fullName ?? null,
            profileImageUrl: outcome.profile?.profilePicUrl ?? null,
            bio: outcome.profile?.bio ?? null,
            classification: mediaUnavailable ? 'media_unavailable' : 'unavailable',
            mediaContext: null,
            genderOperationKey: null,
            genderResultHash: null,
            featureOperationKey: null,
            featureResultHash: null,
            baselineClassification: outcome.baselineClassification,
            classificationSource: outcome.classificationSource,
            genderResolutionStatus: outcome.genderResolutionStatus,
            genderResolutionOperationKey: outcome.genderResolutionOperationKey,
            genderResolutionResultHash: outcome.genderResolutionResultHash,
            feature: null,
        };
    }
    if (!outcome.profile || !outcome.triage || !outcome.genderOperationKey
        || !outcome.genderResultHash || outcome.normalizedSelectionIds.length === 0) {
        throw new Error('ANALYSIS_V2_ANALYZED_PROFILE_INCOMPLETE');
    }
    const classification = outcome.status;
    const posts = analyzedPosts(outcome);
    // The v2.9-v2.11 admission marker records an actual triage-only stop,
    // rather than the earlier routing decision. A resolver-eligible candidate
    // may carry a non-eligible initial admission but still complete feature
    // analysis concurrently; tagging that completed row as pre-feature makes
    // it invalid by design in the result checkpoint contract.
    const preFeatureAdmission = outcome.feature === null
        && outcome.featureOperationKey === null
        && outcome.featureResultHash === null
        && (
            outcome.v29FeatureAdmission === 'nonpersonal_or_official'
            || outcome.v29FeatureAdmission === 'unsupported_unknown'
        )
        ? outcome.v29FeatureAdmission
        : null;
    const preFeaturePolicyVersion = (
        outcome.aiStagePolicyVersion === 'ai-stage-policy-v2.9'
        || outcome.aiStagePolicyVersion === 'ai-stage-policy-v2.10'
        || outcome.aiStagePolicyVersion === 'ai-stage-policy-v2.11'
    ) && preFeatureAdmission !== null
        ? outcome.aiStagePolicyVersion
        : null;
    return {
        candidateId: outcome.candidateId,
        instagramId: outcome.instagramId,
        fullName: outcome.profile.fullName ?? null,
        profileImageUrl: outcome.profile.profilePicUrl ?? null,
        bio: outcome.profile.bio ?? null,
        classification,
        mediaContext: {
            bundleId: analysisV2CandidateBundleId(outcome.candidateId),
            selectionIds: outcome.normalizedSelectionIds,
            triageAnalyzedSelectionIds: outcome.triage.analyzedSelectionIds,
            featureAnalyzedSelectionIds: outcome.feature?.analyzedSelectionIds ?? [],
            captions: outcome.captions,
            posts,
        },
        genderOperationKey: outcome.genderOperationKey,
        genderResultHash: outcome.genderResultHash,
        featureOperationKey: outcome.featureOperationKey,
        featureResultHash: outcome.featureResultHash,
        baselineClassification: outcome.baselineClassification,
        classificationSource: outcome.classificationSource,
        genderResolutionStatus: outcome.genderResolutionStatus,
        genderResolutionOperationKey: outcome.genderResolutionOperationKey,
        genderResolutionResultHash: outcome.genderResolutionResultHash,
        ...(preFeaturePolicyVersion && preFeatureAdmission
            ? {
                preFeaturePolicyVersion,
                preFeatureAdmission,
            }
            : {}),
        feature: outcome.status === 'verified_female' && outcome.feature
            ? {
                appearanceGrade: outcome.feature.features.appearanceGrade as AppearanceGrade,
                exposureScore: outcome.feature.features.exposureScore,
                isBusinessAccount: [
                    'individual_creator',
                    'official_group_or_brand',
                ].includes(screenedAccountContext(outcome, exactV28Policy)),
                featurePartnerEvidenceStrong: strongFeaturePartnerEvidence(outcome.feature),
                oneLineOverview: outcome.feature.features.oneLineOverview,
            }
            : null,
    };
}

function assertCheckpointCount(
    checkpoint: AnalysisV2ResultCheckpointManifest,
    expected: number,
    label: string
): void {
    if (checkpoint.itemCount !== expected) {
        throw new Error(`ANALYSIS_V2_${label}_CHECKPOINT_COUNT_DRIFT`);
    }
}

function topologyBatch(
    context: AnalysisV2StageExecutorContext<'profile_ai' | 'private_names'>,
    kind: 'profile' | 'private'
) {
    if (context.job.batch === null) throw new Error('ANALYSIS_V2_BATCH_MISSING');
    const batches = kind === 'profile'
        ? context.state.relationships?.profileBatches
        : context.state.relationships?.privateNameBatches;
    const batch = batches?.find(item => item.batch === context.job.batch);
    if (!batch) throw new Error('ANALYSIS_V2_BATCH_TOPOLOGY_MISSING');
    return batch;
}

function relationshipRowsByBatch(
    relationship: AnalysisV2RelationshipStagingSnapshot,
    batch: number,
    itemCount: number
) {
    const rows = relationship.privateMutualRows.slice(batch * 100, batch * 100 + itemCount);
    if (rows.length !== itemCount) throw new Error('ANALYSIS_V2_PRIVATE_BATCH_COUNT_DRIFT');
    return rows;
}

function latestPostLikeScope(profile: AnalysisV2CheckpointProfile): Readonly<{
    postUrl: string;
    declaredLikesCount: number;
    declaredLikesCountKnown: boolean;
}> | null {
    const post = profile.latestPosts?.slice().sort((left, right) => (
        Date.parse(right.timestamp) - Date.parse(left.timestamp)
        || left.id.localeCompare(right.id)
    ))[0];
    if (!post) return null;
    const kind = post.type === 'reel' ? 'reel' : 'p';
    return Object.freeze({
        postUrl: `https://www.instagram.com/${kind}/${post.shortCode}/`,
        declaredLikesCount: post.likesCount,
        declaredLikesCountKnown: post.likesCountHidden !== true,
    });
}

function evidenceRef(domain: string, value: unknown): string {
    return `evidence:${sha256(domain, value).slice(0, 48)}`;
}

function validateReverseLikeCollection(
    inputs: readonly AnalysisV2ReverseLikeCollectionInput[],
    collected: Awaited<ReturnType<AnalysisV2ReverseLikeCollector['collect']>>
): void {
    if (inputs.length === 0) {
        if (collected.operationKey !== null || collected.results.length !== 0) {
            throw new Error('ANALYSIS_V2_REVERSE_LIKE_EMPTY_SCOPE_DRIFT');
        }
        return;
    }
    const operationKeyPattern = currentDevStandardArchive()?.mode === 'replay'
        ? /^archive-candidate-likers:[a-f0-9]{64}$/
        : /^candidate-likers:[a-f0-9]{64}$/;
    if (!operationKeyPattern.test(collected.operationKey ?? '')) {
        throw new Error('ANALYSIS_V2_REVERSE_LIKE_OPERATION_MISSING');
    }
    const requested = new Set(inputs.map(row => row.candidateId));
    const seen = new Set<string>();
    for (const result of collected.results) {
        if (!requested.has(result.candidateId) || seen.has(result.candidateId)) {
            throw new Error('ANALYSIS_V2_REVERSE_LIKE_RESULT_SCOPE_DRIFT');
        }
        seen.add(result.candidateId);
    }
    if (seen.size !== inputs.length) {
        throw new Error('ANALYSIS_V2_REVERSE_LIKE_RESULT_SCOPE_DRIFT');
    }
}

function interactionObservation(
    rows: readonly AnalysisV2CanonicalTargetEvidenceRow[],
    signal: 'target_post_like' | 'target_post_comment'
) {
    const selected = rows.filter(row => row.signal === signal);
    return selected.length > 0
        ? {
            status: 'observed' as const,
            evidenceRefIds: selected.slice(0, 8).map(row => evidenceRef(
                'analysis-v2-interaction-ref-v1',
                row.sourceInteractionId
            )),
        }
        : { status: 'not_observed' as const, evidenceRefIds: [] as string[] };
}

function profileMentionObservation(input: {
    posts: readonly Pick<NonNullable<AnalysisV2CheckpointProfile['latestPosts']>[number], 'id' | 'taggedUsers' | 'mentionedUsers'>[];
    username: string;
    field: 'taggedUsers' | 'mentionedUsers';
    domain: string;
}) {
    const subject = input.username.trim().replace(/^@/u, '').toLowerCase();
    const matchingPostIds = input.posts
        .filter(post => post[input.field].some(value => (
            value.trim().replace(/^@/u, '').toLowerCase() === subject
        )))
        .map(post => post.id)
        .slice(0, 8);
    return matchingPostIds.length > 0
        ? {
            status: 'observed' as const,
            evidenceRefIds: matchingPostIds.map(postId => evidenceRef(input.domain, postId)),
        }
        : { status: 'not_observed' as const, evidenceRefIds: [] as string[] };
}

function targetCoverageStatus(snapshot: AnalysisV2TargetEvidenceStagingSnapshot) {
    const sources = [snapshot.likerSource, snapshot.commentSource];
    if (sources.every(source => source.status === 'not_applicable')) return 'unknown' as const;
    const coverage = sources.flatMap(source => source.coverage);
    if (coverage.length === 0) return 'unknown' as const;
    return coverage.every(row => row.returnedCount >= Math.min(
        row.declaredCount,
        row.requestedLimit
    )) ? 'complete' as const : 'partial' as const;
}

function narrativeInput(input: {
    targetUsername: string;
    targetFullName: string | null;
    outcome: AnalysisV2ProfileAiOutcome;
    media: readonly NormalizedAiMediaSelection[];
    carouselCaptionDossier: Readonly<{ evidenceRefId: string; text: string }> | null;
    targetEvidence: AnalysisV2TargetEvidenceStagingSnapshot;
    targetPosts: readonly Pick<NonNullable<AnalysisV2CheckpointProfile['latestPosts']>[number], 'id' | 'taggedUsers' | 'mentionedUsers'>[];
    reverse: AnalysisV2ReverseLikeRow | undefined;
}): HighRiskNarrativeInput {
    const candidateRows = input.targetEvidence.rows.filter(row => (
        row.actorUsername === input.outcome.instagramId
    ));
    const commentRows = candidateRows.filter(row => (
        row.signal === 'target_post_comment' && row.content
    )).slice(0, 12);
    const commentRefs = new Map(commentRows.map(row => [
        row.sourceInteractionId,
        evidenceRef('analysis-v2-comment-ref-v1', row.sourceInteractionId),
    ]));
    const candidateCommentObservation = commentRows.length > 0
        ? {
            status: 'observed' as const,
            evidenceRefIds: commentRows.map(row => commentRefs.get(row.sourceInteractionId)!),
        }
        : { status: 'not_observed' as const, evidenceRefIds: [] as string[] };
    const reverseStatus = input.reverse?.status === 'observed'
        ? 'observed' as const
        : input.reverse?.status === 'observed_not_found'
            ? 'not_observed' as const
            : 'not_collected' as const;
    return {
        forbiddenIdentifiers: {
            targetUsername: input.targetUsername,
            candidateUsername: input.outcome.instagramId,
        },
        publicSubjects: {
            targetFullName: input.targetFullName,
            candidateFullName: input.outcome.profile?.fullName ?? null,
        },
        appearance: {
            isReliable: Boolean(
                input.outcome.feature
                && input.outcome.feature.features.appearanceGrade >= 4
                && input.outcome.feature.features.evidenceSelectionIds.appearance.length > 0
                && input.media.length > 0
            ),
        },
        bio: input.outcome.profile?.bio ?? null,
        media: [...input.media],
        captions: [...input.outcome.captions],
        carouselCaptionDossier: input.carouselCaptionDossier,
        interactions: {
            candidateToTargetLike: interactionObservation(
                candidateRows,
                'target_post_like'
            ),
            targetToCandidateLike: {
                status: reverseStatus,
                evidenceRefIds: reverseStatus === 'observed'
                    ? [evidenceRef('analysis-v2-reverse-like-ref-v1', input.outcome.candidateId)]
                    : [],
            },
            candidateToTargetComment: candidateCommentObservation,
            targetToCandidateComment: {
                status: 'not_collected',
                evidenceRefIds: [],
            },
            candidateToTargetTag: profileMentionObservation({
                posts: input.outcome.profile?.latestPosts ?? [],
                username: input.targetUsername,
                field: 'taggedUsers',
                domain: 'analysis-v2-candidate-to-target-tag-ref-v1',
            }),
            targetToCandidateTag: profileMentionObservation({
                posts: input.targetPosts,
                username: input.outcome.instagramId,
                field: 'taggedUsers',
                domain: 'analysis-v2-target-to-candidate-tag-ref-v1',
            }),
            candidateToTargetMention: profileMentionObservation({
                posts: input.outcome.profile?.latestPosts ?? [],
                username: input.targetUsername,
                field: 'mentionedUsers',
                domain: 'analysis-v2-candidate-to-target-mention-ref-v1',
            }),
            targetToCandidateMention: profileMentionObservation({
                posts: input.targetPosts,
                username: input.outcome.instagramId,
                field: 'mentionedUsers',
                domain: 'analysis-v2-target-to-candidate-mention-ref-v1',
            }),
            comments: commentRows.map(row => ({
                evidenceRefId: commentRefs.get(row.sourceInteractionId)!,
                targetPostEvidenceRefId: evidenceRef(
                    'analysis-v2-target-post-ref-v1',
                    row.postId
                ),
                text: row.content!,
            })),
            coverage: {
                status: targetCoverageStatus(input.targetEvidence),
                evidenceRefId: evidenceRef(
                    'analysis-v2-target-coverage-ref-v1',
                    input.targetEvidence.manifest.resultHash
                ),
            },
        },
    };
}

function checkpointClaim(context: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>) {
    return {
        requestId: context.claim.requestId,
        jobKey: context.claim.jobKey,
        claimToken: context.claim.claimToken,
        jobInputHash: context.claim.inputHash,
    };
}

interface AnalysisV2FinalRevenueCoverage {
    publicMutualCount: number;
    screenedCount: number;
    notScreenedCount: number;
    unknownBurdenCount: number;
    coverageValid: boolean;
    passesUnknownGate: boolean;
}

/**
 * This marker is written only by the exact Basic/Standard test-entitlement
 * relationship collector. It is intentionally the first discriminator for
 * strict-only work: production, Plus, and every legacy cohort must retain the
 * original executor path without a context-store, stage-store, revenue, or AI
 * call introduced by this feature.
 */
function hasStrictRevenueRelationshipSelection(
    context: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>,
): boolean {
    const relationships = context.state.relationships;
    const policy = relationships?.relationshipSelectionPolicy;
    if (!relationships || !policy) return false;
    const cap = policy.planId === 'basic' ? 100 : 200;
    return policy.policyVersion === 'gender-routing-v1'
        && context.state.planId === policy.planId
        && relationships.resultHash === policy.relationshipCheckpointId
        && policy.selectedCount === relationships.detailedSelectedPublicCount
        && policy.publicPopulationCount === relationships.publicCount
        && relationships.notScreenedPublicCount === (
            relationships.publicCount - relationships.detailedSelectedPublicCount
        )
        && policy.selectedCount <= cap;
}

/**
 * The durable relationship checkpoint is the cohort authority. A profile AI
 * terminal state represents exactly one selected candidate, so the unknown
 * burden is intentionally a union, not a sum of unavailable categories.
 */
function finalRevenueCoverage(
    context: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>,
    outcomes: readonly AnalysisV2ProfileAiOutcome[],
): AnalysisV2FinalRevenueCoverage {
    const relationships = context.state.relationships;
    const publicMutualCount = relationships?.publicCount ?? 0;
    const screenedCount = relationships?.detailedSelectedPublicCount ?? 0;
    const notScreenedCount = relationships?.notScreenedPublicCount ?? 0;
    const unavailableReasonCounts = {
        fetch_unavailable: 0,
        media_unavailable: 0,
        analysis_unavailable: 0,
    };
    const candidateIds = new Set<string>();
    let unknownBurdenCount = 0;

    for (const outcome of outcomes) {
        if (!candidateIds.add(outcome.candidateId)) continue;
        if (
            outcome.status !== 'verified_female'
            && outcome.status !== 'verified_non_female'
        ) {
            // `unresolved` and `unresolved_stage_conflict` are the explicit
            // "other unknown" bucket. Each terminal row increments once even
            // when it also has a fetch/media/analysis unavailable reason.
            unknownBurdenCount += 1;
        }
        if (outcome.status === 'fetch_unavailable') {
            unavailableReasonCounts.fetch_unavailable += 1;
        } else if (outcome.status === 'media_unavailable') {
            unavailableReasonCounts.media_unavailable += 1;
        } else if (outcome.status === 'analysis_unavailable') {
            unavailableReasonCounts.analysis_unavailable += 1;
        }
    }

    let coverageValid = relationships !== undefined
        && candidateIds.size === outcomes.length
        && outcomes.length === screenedCount;
    let passesUnknownGate = false;
    try {
        const coverage = assertCoverageInvariant({
            publicMutualCount,
            screenedCount,
            notScreenedCount,
            unknownBurdenCount,
            unavailableReasonCounts,
        });
        passesUnknownGate = coverage.passesUnknownGate;
    } catch {
        coverageValid = false;
    }
    return {
        publicMutualCount,
        screenedCount,
        notScreenedCount,
        unknownBurdenCount,
        coverageValid,
        passesUnknownGate,
    };
}

type RevenueResolverPriority = 0 | 1 | 2 | 3;

function isFinalRevenueUnknown(outcome: AnalysisV2ProfileAiOutcome): boolean {
    return outcome.status !== 'verified_female'
        && outcome.status !== 'verified_non_female';
}

function revenueResolverPriority(outcome: AnalysisV2ProfileAiOutcome): RevenueResolverPriority {
    switch (outcome.status) {
        case 'analysis_unavailable': return 0;
        case 'media_unavailable': return 1;
        case 'fetch_unavailable': return 2;
        default: return 3;
    }
}

interface RevenueFinalResolverCandidate {
    outcome: AnalysisV2ProfileAiOutcome;
    /** Profile-AI batches preserve the selected routing-manifest HMAC order. */
    manifestOrdinal: number;
}

function finalRevenueResolverCandidates(
    outcomes: readonly AnalysisV2ProfileAiOutcome[],
): readonly RevenueFinalResolverCandidate[] {
    return outcomes
        .map((outcome, manifestOrdinal) => ({ outcome, manifestOrdinal }))
        .filter(({ outcome }) => isFinalRevenueUnknown(outcome))
        .sort((left, right) => (
            revenueResolverPriority(left.outcome) - revenueResolverPriority(right.outcome)
            || left.manifestOrdinal - right.manifestOrdinal
        ));
}

function finalRevenueResolverPlanHash(
    candidates: readonly RevenueFinalResolverCandidate[],
): string {
    return sha256('analysis-v2-revenue-final-resolver-plan:v1', candidates.map(candidate => ({
        // This is an opaque candidate-id digest, never a username, profile URL,
        // raw manifest key, input HMAC, or model payload.
        candidateHash: sha256('analysis-v2-revenue-final-resolver-candidate:v1',
            candidate.outcome.candidateId),
        priority: revenueResolverPriority(candidate.outcome),
        manifestOrdinal: candidate.manifestOrdinal,
    })));
}

interface RevenueResolverMediaPreparation {
    media: NormalizedAiMediaSelection[];
    /**
     * Retained detail media is optional.  Resolver classification must not be
     * made conditional on a feature payload: analysis/media-unavailable rows
     * normally have none, but can still be safely classified from freshly
     * normalized profile media.
     */
    bundleMedia: readonly AnalysisV2NormalizedMediaBundleItem[] | null;
}

async function finalRevenueResolverMedia(input: {
    outcome: AnalysisV2ProfileAiOutcome;
    aiStagePolicyVersion: string;
    normalizeMedia: AnalysisV2AiScoringExecutorDependencies['normalizeMedia'];
}): Promise<RevenueResolverMediaPreparation | null> {
    // Fetch-unavailable has no profile snapshot. Media-unavailable may recover
    // transiently, so it is deliberately skipped only if this bounded retry
    // cannot form the existing resolver's valid media input; the next priority
    // candidate is then considered.
    if (
        !input.outcome.profile
        || input.outcome.profile.isPrivate
    ) return null;
    try {
        const policy = mediaPolicy(
            input.outcome.profile,
            policySupports(input.aiStagePolicyVersion, 'inputQualityV28'),
        );
        const normalized = await normalizeAnalysisV2MediaSelections(
            policy.feature.media,
            input.normalizeMedia,
            input.aiStagePolicyVersion,
        );
        if (!isAnalysisV2StageMediaCoverageUsable(
            normalized.coverage,
            input.aiStagePolicyVersion,
        )) return null;
        const resolverMedia = policySupports(
            input.aiStagePolicyVersion,
            'genderTriageMicrobatchV29',
        )
            ? selectAnalysisV2GenderResolverMedia(normalized.media)
            : normalized.media;
        // The approved opportunistic resolver keeps its existing conservative
        // two-distinct-image minimum. A one-image or failed download is an
        // explicit skip, never a fabricated classification.
        if (resolverMedia.length < 2) return null;
        const featureSelectionIds = input.outcome.feature?.analyzedSelectionIds ?? [];
        const bundleMedia = featureSelectionIds.flatMap(selectionId => {
            const normalizedJpeg = normalized.bytes.get(selectionId);
            return normalizedJpeg ? [{ selectionId, normalizedJpeg }] : [];
        });
        // A missing retained feature bundle must not turn a valid
        // analysis/media-unavailable resolver input into an artificial skip.
        // Only featureful candidates with a complete retained bundle are
        // later eligible for detail materialization.
        return {
            media: resolverMedia,
            bundleMedia: featureSelectionIds.length > 0
                && new Set(featureSelectionIds).size === featureSelectionIds.length
                && bundleMedia.length === featureSelectionIds.length
                ? bundleMedia
                : null,
        };
    } catch (error) {
        if (error instanceof AnalysisV2AiResultRecoveryPendingError
            || error instanceof DevStandardArchiveError
            || error instanceof DevStandardArchiveStorageRetryError) throw error;
        return null;
    }
}

function applyRevenueResolverPatches(
    outcomes: readonly AnalysisV2ProfileAiOutcome[],
    patches: readonly AnalysisV2RevenueResolverOutcomePatch[],
): readonly AnalysisV2ProfileAiOutcome[] {
    const patchByCandidate = new Map(patches.map(patch => [patch.candidateId, patch]));
    const effective = outcomes.map(outcome => {
        const patch = patchByCandidate.get(outcome.candidateId);
        if (!patch) return outcome;
        if (
            ![
                'unresolved',
                'unresolved_stage_conflict',
                'media_unavailable',
                'analysis_unavailable',
            ].includes(
                outcome.baselineClassification,
            )
            || outcome.status === 'verified_female'
            || outcome.status === 'verified_non_female'
        ) {
            throw new Error('ANALYSIS_V2_REVENUE_RESOLVER_OVERLAY_DRIFT');
        }
        patchByCandidate.delete(outcome.candidateId);
        return {
            ...outcome,
            status: patch.classification,
            classificationSource: 'gender_resolution' as const,
            genderResolutionStatus: 'ready_applied' as const,
            genderResolutionOperationKey: patch.operationKey,
            genderResolutionResultHash: patch.resultHash,
            // Resolver provenance is authoritative independently of a
            // detail feature bundle.  A featureless verified woman belongs in
            // primary membership but is intentionally screened out later.
            mediaBundlePersisted: outcome.mediaBundlePersisted,
        };
    });
    if (patchByCandidate.size !== 0) {
        throw new Error('ANALYSIS_V2_REVENUE_RESOLVER_OVERLAY_DRIFT');
    }
    return effective;
}

async function runPrimaryRevenueResolverPass(input: {
    dependencies: AnalysisV2AiScoringExecutorDependencies;
    context: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>;
    /** Immutable original profile outcomes define plan order and pass identity. */
    plannedOutcomes: readonly AnalysisV2ProfileAiOutcome[];
    /** Existing durable patches are merged here before recovery resumes. */
    outcomes: readonly AnalysisV2ProfileAiOutcome[];
    admission: AnalysisV2RevenueResolverCapacityAdmission;
    coverage: AnalysisV2FinalRevenueCoverage;
}): Promise<{
    outcomes: readonly AnalysisV2ProfileAiOutcome[];
    patches: readonly AnalysisV2RevenueResolverOutcomePatch[];
}> {
    const candidates = finalRevenueResolverCandidates(input.plannedOutcomes);
    const aiFence = aiJobFence(input.context, await input.context.loadAiPolicy?.());
    await input.admission.begin({
        planHash: finalRevenueResolverPlanHash(candidates),
        screenedCount: input.coverage.screenedCount,
        unknownBurdenCount: input.coverage.unknownBurdenCount,
    });
    if (!policySupports(aiFence.aiStagePolicyVersion, 'genderResolution')) {
        return { outcomes: input.outcomes, patches: [] };
    }
    const policyVersion = assertSupportedAiStagePolicyVersion(
        aiFence.aiStagePolicyVersion,
    );
    const resolved = [...input.outcomes];
    const patches: AnalysisV2RevenueResolverOutcomePatch[] = [];
    let acceptedReservations = 0;
    for (const candidate of candidates) {
        const current = resolved[candidate.manifestOrdinal]!;
        // A prior invocation persisted this exact outcome before its primary
        // checkpoint. Recovery must reuse it, never re-bill or re-call Gemini.
        if (!isFinalRevenueUnknown(current)) continue;
        const media = await finalRevenueResolverMedia({
            outcome: current,
            aiStagePolicyVersion: aiFence.aiStagePolicyVersion,
            normalizeMedia: input.dependencies.normalizeMedia,
        });
        if (!media) continue;
        // The database reservation is the cross-recovery authority.  This
        // local ceiling mirrors it so a malformed or overly permissive
        // external adapter cannot issue a twenty-first Basic / forty-first
        // Standard call inside one execution either.
        if (acceptedReservations >= input.admission.capacityLimit) break;
        const identity = createGenderResolutionResultIdentity(
            { media: media.media },
            policyVersion,
        );
        // Reserve before the model boundary. The runtime receives a matching
        // cached admission only to retain its own immediate-before-call fence.
        const disposition = await input.admission.reserve(identity.operationKey);
        if (disposition !== 'accepted') break;
        acceptedReservations += 1;
        const resolver = input.dependencies.ai.startGenderResolution({ media: media.media }, {
            ...aiFence,
            reserveGenderResolutionCapacity: async operationKey => {
                if (operationKey !== identity.operationKey) {
                    throw new Error('ANALYSIS_V2_REVENUE_RESOLVER_OPERATION_DRIFT');
                }
                return 'accepted';
            },
        });
        await resolver.completion;
        const state = resolver.peek();
        if (state.status === 'budget_reservation_pending') throw state.error;
        if (state.status === 'terminal_unavailable' && state.budgetError) {
            throw new Error(state.budgetError);
        }
        if (state.status === 'recovery_pending') {
            throw new AnalysisV2AiResultRecoveryPendingError();
        }
        if (state.status !== 'ready') continue;
        const reconciliation = applyGenderResolution({
            baselineClassification: current.baselineClassification,
            baselineSource: current.baselineClassification === 'verified_female'
                || current.baselineClassification === 'verified_non_female'
                ? 'feature'
                : 'unknown',
            triage: current.triage?.assessment ?? null,
            feature: current.feature,
            resolver: state.value.result,
        });
        if (
            !reconciliation.resolverApplied
            || (
                reconciliation.finalClassification !== 'verified_female'
                && reconciliation.finalClassification !== 'verified_non_female'
            )
            || state.value.resultHash === null
        ) continue;
        if (
            reconciliation.finalClassification === 'verified_female'
            && current.feature
            && media.bundleMedia
        ) {
            await input.dependencies.mediaStore.persistBundle({
                requestId: input.context.claim.requestId,
                jobKey: input.context.claim.jobKey,
                claimToken: input.context.claim.claimToken,
                bundleId: analysisV2CandidateBundleId(current.candidateId),
                media: media.bundleMedia,
            });
        }
        resolved[candidate.manifestOrdinal] = {
            ...current,
            status: reconciliation.finalClassification,
            classificationSource: reconciliation.classificationSource,
            genderResolutionStatus: 'ready_applied',
            genderResolutionOperationKey: state.value.operationKey,
            genderResolutionResultHash: state.value.resultHash,
            mediaBundlePersisted: reconciliation.finalClassification === 'verified_female'
                && current.feature
                && media.bundleMedia !== null
                ? true
                : current.mediaBundlePersisted,
        };
        patches.push({
            candidateId: current.candidateId,
            classification: reconciliation.finalClassification,
            operationKey: state.value.operationKey,
            resultHash: state.value.resultHash,
        });
    }
    return { outcomes: resolved, patches };
}

async function enforceRevenueFinalQualityGate(
    dependencies: AnalysisV2AiScoringExecutorDependencies,
    context: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>,
): Promise<void> {
    // The immutable relationship marker is the *first* branch. It prevents
    // every new gate/context/stage/resolver/assessor call on production, Plus,
    // and non-strict legacy cohorts.
    if (!hasStrictRevenueRelationshipSelection(context)) return;
    if (context.claim.jobKey !== 'coordinator:finalize') {
        throw new Error('ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_CLAIM_MISMATCH');
    }
    const claim = {
        ...checkpointClaim(context),
        jobKey: 'coordinator:finalize' as const,
    };
    const gate = dependencies.revenueFinalQualityGate;
    if (!gate) {
        throw new Error('ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_REQUIRED');
    }
    // The marker is immutable strict lineage. A mismatch with the dependency's
    // durable context proof is a fence violation, never permission to fall
    // through to automatic completion.
    if (!(await gate.isApplicable(claim))) {
        throw new Error('ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_REQUIRED');
    }
    const disposition = await gate.verify(claim);
    if (disposition !== 'approved') {
        throw new Error('ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_FAILED');
    }
}

async function resolveStrictPrimaryRevenueOutcomes(
    dependencies: AnalysisV2AiScoringExecutorDependencies,
    context: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>,
    plannedOutcomes: readonly AnalysisV2ProfileAiOutcome[],
): Promise<readonly AnalysisV2ProfileAiOutcome[]> {
    if (context.claim.jobKey !== 'coordinator:join:primary-evidence') {
        throw new Error('ANALYSIS_V2_REVENUE_PRIMARY_QUALITY_CLAIM_MISMATCH');
    }
    const admissionFactory = dependencies.revenueResolverCapacity;
    if (!admissionFactory) {
        throw new Error('ANALYSIS_V2_REVENUE_PRIMARY_QUALITY_REQUIRED');
    }
    const claim = {
        ...checkpointClaim(context),
        jobKey: 'coordinator:join:primary-evidence' as const,
    };
    const admission = await admissionFactory.bind(claim);
    // A state marker without the matching durable test-entitlement lineage is
    // an integrity violation. It must not silently take the non-strict path.
    if (!admission) {
        throw new Error('ANALYSIS_V2_REVENUE_PRIMARY_QUALITY_REQUIRED');
    }

    const durablePatches = await dependencies.resultStore
        .loadRevenueResolverOutcomes(claim);
    let outcomes = applyRevenueResolverPatches(plannedOutcomes, durablePatches);
    const initialCoverage = finalRevenueCoverage(context, plannedOutcomes);
    let finalCoverage = finalRevenueCoverage(context, outcomes);
    const resolverPassStarted = initialCoverage.unknownBurdenCount * 10
        > initialCoverage.screenedCount * 3;

    if (initialCoverage.coverageValid && !initialCoverage.passesUnknownGate) {
        const pass = await runPrimaryRevenueResolverPass({
            dependencies,
            context,
            plannedOutcomes,
            outcomes,
            admission,
            coverage: initialCoverage,
        });
        outcomes = pass.outcomes;
        if (pass.patches.length > 0) {
            // Result materialization is updated before the membership checkpoint
            // becomes authoritative. A crash/replay observes these same opaque
            // patches and cannot invoke a successful resolver again.
            await dependencies.resultStore.checkpointRevenueResolverOutcomes({
                ...claim,
                rows: pass.patches,
            });
        }
        finalCoverage = finalRevenueCoverage(context, outcomes);
    }

    // This call is the durable primary-join quality decision for both a
    // resolver-free <=30% cohort and a completed >30% pass. Recovery-pending
    // errors above deliberately bubble before it; only confirmed terminal
    // coverage failure is converted to durable manual_review by the RPC.
    const disposition = await admission.complete({
        publicMutualCount: finalCoverage.publicMutualCount,
        screenedCount: finalCoverage.screenedCount,
        notScreenedCount: finalCoverage.notScreenedCount,
        initialUnknownBurdenCount: initialCoverage.unknownBurdenCount,
        finalUnknownBurdenCount: finalCoverage.unknownBurdenCount,
        coverageValid: finalCoverage.coverageValid && finalCoverage.passesUnknownGate,
        resolverPassStarted,
    });
    if (disposition !== 'approved') {
        throw new Error('ANALYSIS_V2_REVENUE_PRIMARY_QUALITY_FAILED');
    }
    return outcomes;
}

function aiJobFence(
    context: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>,
    policy: Pick<typeof context, 'aiStagePolicyVersion' | 'schedulerCapability'> = context,
) {
    if (!policy.aiStagePolicyVersion) {
        throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
    }
    return {
        ...checkpointClaim(context),
        aiStagePolicyVersion: policy.aiStagePolicyVersion,
        schedulerCapability: policy.schedulerCapability,
        handlerDeadlineAtMs: context.handlerDeadlineAtMs,
    };
}

function partnerScoreSource(row: AnalysisV2PartnerSafetyRow | undefined):
AnalysisV2CandidateScoreRow['partnerSafetySource'] {
    if (!row) return 'not_collected';
    return row.result.source;
}

function partnerEvidenceSelectionIds(
    outcome: AnalysisV2ProfileAiOutcome,
    result: PartnerSafetyResult | null
): string[] {
    if (!outcome.feature) return [];
    const includesFeatureEvidence = result?.strongEvidenceBasis === 'feature'
        || result?.strongEvidenceBasis === 'both'
        || Boolean(result?.hasWeakNonExcludedMalePairEvidence
            && weakFeaturePartnerEvidence(outcome.feature))
        || (result === null && (
            strongFeaturePartnerEvidence(outcome.feature)
            || weakFeaturePartnerEvidence(outcome.feature)
        ));
    const featureIds = includesFeatureEvidence
        ? outcome.feature.features.evidenceSelectionIds.marriagePartner
        : [];
    const includesContactEvidence = result?.strongEvidenceBasis === 'contact_sheet'
        || result?.strongEvidenceBasis === 'both'
        || Boolean(
            result?.hasWeakNonExcludedMalePairEvidence
            && result.assessment?.exclusionContext === 'none'
            && result.assessment.partnerEvidence === 'weak'
        );
    const contactIds = includesContactEvidence
        ? result?.assessment?.evidenceSourceSelectionIds ?? []
        : [];
    return [...new Set([...featureIds, ...contactIds])].slice(0, 8);
}

function preliminaryStoreRow(
    candidate: V2PreliminaryCandidateScore,
    riskPolicyVersion: RiskPolicyVersion
): AnalysisV2PreliminaryScoreRow {
    const risk = calculateRiskPolicy({
        uniqueTargetPostsLikedByCandidate: candidate.uniqueTargetPostsLikedByCandidate,
        boundedCandidateCommentsOnTarget: candidate.boundedCandidateCommentsOnTarget,
        reverseLikeStatus: 'not_collected',
        hasCandidateToTargetTagOrCaptionMention:
            candidate.hasCandidateToTargetTagOrCaptionMention,
        hasTargetToCandidateTagOrCaptionMention:
            candidate.hasTargetToCandidateTagOrCaptionMention,
        recentFemaleMutualRank: candidate.recentFemaleMutualRank,
        appearanceGrade: candidate.appearanceGrade,
        exposureScore: candidate.exposureScore,
        accountContext: candidate.accountContext,
        // Preliminary persistence intentionally precedes partner-safety and
        // therefore stores no weak adjustment or strong-evidence cap.
        hasWeakPartnerEvidence: false,
        hasStrongPartnerEvidence: false,
    }, riskPolicyVersion);
    return {
        candidateId: candidate.candidateId,
        components: risk.components,
        preScore: risk.preScore,
        possibleUpperBound: risk.possibleUpperBound,
        recentMutualRank: candidate.recentFemaleMutualRank,
        verificationShortlistRank: candidate.verificationShortlistRank,
    };
}

/** Registry entries can be merged with relationship/profile collection executors by the worker. */
export function createAnalysisV2AiScoringExecutorRegistry(
    dependencies: AnalysisV2AiScoringExecutorDependencies
): AnalysisV2StageExecutorRegistry {
    const createContactSheet = dependencies.createContactSheet
        ?? createPartnerSafetyContactSheet;
    const captureSourceArchiveRevisions = Boolean(dependencies.devStandardEvalCapture);
    const configuredProfileConcurrency = dependencies.profileAiConcurrency;
    const partnerConcurrency = dependencies.partnerSafetyConcurrency
        ?? MAX_PARTNER_SAFETY_CONCURRENCY;
    const narrativeConcurrency = dependencies.narrativeConcurrency
        ?? MAX_NARRATIVE_CONCURRENCY;

    return {
        async profile_ai(context) {
            const topology = topologyBatch(context, 'profile');
            const producerJobKey = `${PROFILE_BATCH_JOB_PREFIX}${context.job.batch}`;
            const producer = context.state.profileFetchBatches?.find(item => (
                item.batch === context.job.batch
            ));
            if (!producer || producer.itemCount !== topology.itemCount) {
                throw new Error('ANALYSIS_V2_PROFILE_AI_PRODUCER_MISSING');
            }
            const loaded = await dependencies.profileBatches.loadExactBatch({
                requestId: context.claim.requestId,
                consumerJobKey: context.claim.jobKey,
                consumerClaimToken: context.claim.claimToken,
                consumerInputHash: context.claim.inputHash,
                producerJobKey,
                batch: context.job.batch!,
                expectedItemCount: topology.itemCount,
                expectedProducerInputHash: producer.producerInputHash,
            });
            const results = finalProfileResults(loaded);
            if (results.length !== topology.itemCount) {
                throw new Error('ANALYSIS_V2_PROFILE_AI_ITEM_COUNT_DRIFT');
            }
            const aiFence = aiJobFence(context);
            const profileConcurrency = analysisV2ProfilePipelineConcurrency(
                aiFence.aiStagePolicyVersion,
                aiFence.schedulerCapability,
                configuredProfileConcurrency,
            );
            const genderResolutionEnabled = policySupports(
                aiFence.aiStagePolicyVersion,
                'genderResolution',
            );
            const inputQualityV28 = policySupports(
                aiFence.aiStagePolicyVersion,
                'inputQualityV28',
            );
            const inputQualityPolicyVersion = assertSupportedAiStagePolicyVersion(
                aiFence.aiStagePolicyVersion,
            );
            const defaultGenderResolutionStatus = genderResolutionEnabled
                ? 'not_eligible' as const
                : 'disabled' as const;
            // Strict revenue cohorts defer all resolver work until primary_join
            // knows the request-wide unknown burden. The immutable relationship
            // marker is checked locally, so non-strict profile work gains no
            // context-store or revenue-admission dependency call.
            const strictRevenueResolverDeferred = hasStrictRevenueRelationshipSelection(context);
            const resolverFence = aiFence;
            const startedResolverHandles: AnalysisV2GenderResolutionHandle[] = [];
            const requiresGenderPlan = context.state.planId === 'standard'
                && aiFence.aiStagePolicyVersion === AI_STAGE_POLICY_V211_VERSION
                && aiFence.schedulerCapability === 'scheduler-v1';
            const plannedGender = requiresGenderPlan ? dependencies.ai.profileGender : undefined;
            if (requiresGenderPlan && !plannedGender) {
                throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_PERSISTENCE_ERROR');
            }
            const inputStore = plannedGender ? dependencies.profileMediaInputs ?? profileMediaInputStore : null;
            const inputFence = { ...aiFence, inputHash: context.claim.inputHash };
            const saved = await inputStore?.load(inputFence) ?? {
                inputs: [], hasGenderHistory: false, hasUnownedFeatureHistory: false,
            };
            if (saved.inputs.some(row => row.ordinal >= results.length)) {
                throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT');
            }
            const savedBySlot = new Map(saved.inputs.map(row => [`${row.ordinal}:${row.stage}`, row]));
            const newTriageInputs: ProfileMediaInput[] = [];
            let retainedBytes = 0;
            let preparedOutcomes: AnalysisV2PreparedProfileAiOutcome[];
            try {
                async function prepareProfile(
                    item: (typeof results)[number], index: number,
                ): Promise<AnalysisV2PreparedProfileAiOutcome | PlannedProfile> {
                    const signal = {
                        currentOrdinal: index + 1,
                        totalCount: results.length,
                        callPhase: 'analyzing' as const,
                    };
                    let preview;
                    if (
                        currentDevStandardArchive()?.mode !== 'replay'
                        && item.status === 'success'
                        && item.profile
                        && !item.profile.isPrivate
                    ) {
                        try {
                            preview = selectAnalysisV2ProgressCandidateMedia(item.profile);
                        } catch {
                            // Progress presentation must never affect candidate analysis.
                            preview = undefined;
                        }
                    }
                    await context.reportActiveProfile?.(item.username, preview, signal);
                    const candidateId = analysisV2CandidateId(item.username);
                    const savedTriage = savedBySlot.get(`${index}:triage`);
                    if (item.status !== 'success' || !item.profile || item.profile.isPrivate) {
                        if (savedTriage && savedTriage.selectedCount !== 0) {
                            throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT');
                        }
                        if (inputStore && !savedTriage) {
                            newTriageInputs.push({
                                ordinal: index, stage: 'triage', selectedCount: 0, failures: [],
                                archiveSha256: null, operationKey: null,
                            });
                        }
                        return {
                            candidateId,
                            instagramId: normalizeUsername(item.username),
                            status: 'fetch_unavailable' as const,
                            unavailableReason: 'profile_fetch' as const,
                            profile: null,
                            triage: null,
                            feature: null,
                            normalizedSelectionIds: [],
                            mediaCoverage: {
                                selectedCount: 0,
                                normalizedCount: 0,
                                failures: [],
                            },
                            captions: [],
                            genderOperationKey: null,
                            genderResultHash: null,
                            featureOperationKey: null,
                            featureResultHash: null,
                            baselineClassification: 'fetch_unavailable' as const,
                            classificationSource: 'unavailable' as const,
                            genderResolutionStatus: defaultGenderResolutionStatus,
                            genderResolutionOperationKey: null,
                            genderResolutionResultHash: null,
                            mediaBundlePersisted: false,
                        };
                    }
                    const profile = item.profile;

                    const policy = mediaPolicy(profile, inputQualityV28);
                    const selectionProvenance = inputQualityV28
                        ? mediaSelectionProvenance(policy)
                        : undefined;
                    const profileEvidence = inputQualityV28
                        ? {
                            fullName: profile.fullName ?? null,
                            hasProfileImage: Boolean(profile.profilePicUrl?.trim()),
                            ...(policySupports(
                                aiFence.aiStagePolicyVersion,
                                'genderTriageMicrobatchV29',
                            )
                                ? { bio: profile.bio ?? null }
                                : {}),
                        }
                        : undefined;
                    const triageNormalized = savedTriage
                        ? await restoreProfileMedia(savedTriage, policy.triage.media, candidateId,
                            inputFence.requestId, dependencies.sourceMediaArchive)
                        : await normalizeAnalysisV2MediaSelections(
                            policy.triage.media, dependencies.normalizeMedia, aiFence.aiStagePolicyVersion,
                        );
                    if (context.state.planId === 'standard' && currentDevStandardArchive()?.mode === 'capture'
                        && policySupports(aiFence.aiStagePolicyVersion, 'partialMediaCoverage')) {
                        // A later model can choose features even when this capture skips them.
                        // Only the archive observes these extra inputs. The normal stage keeps
                        // its own coverage, checkpoints and model admission.
                        if (savedTriage) {
                            await captureDevStandardMediaSelection(policy.triage.media, dependencies.normalizeMedia,
                                aiFence.aiStagePolicyVersion, async () => triageNormalized);
                        }
                        const remainder = remainingFeatureMedia(policy);
                        const pinned = savedBySlot.get(`${index}:feature_remainder`);
                        await captureDevStandardMediaSelection(remainder, dependencies.normalizeMedia, aiFence.aiStagePolicyVersion,
                            pinned ? () => restoreProfileMedia(pinned, remainder, candidateId,
                                inputFence.requestId, dependencies.sourceMediaArchive) : undefined);
                    }
                    const usable = isAnalysisV2StageMediaCoverageUsable(triageNormalized.coverage, aiFence.aiStagePolicyVersion);
                    const archiveTriage = usable || inputStore !== null;
                    const triageSha256 = savedTriage ? savedTriage.archiveSha256 : archiveTriage
                        ? await persistProfileMedia(triageNormalized, inputFence.requestId, candidateId, 'triage', dependencies.sourceMediaArchive)
                        : null;
                    if (inputStore && !savedTriage) {
                        newTriageInputs.push(profileMediaReceipt(
                            index, 'triage', policy.triage.media, triageNormalized, triageSha256, null,
                        ));
                    }
                    if (!usable) {
                        return {
                            candidateId,
                            instagramId: normalizeUsername(item.username),
                            status: 'media_unavailable' as const,
                            unavailableReason: null,
                            profile: item.profile,
                            triage: null,
                            feature: null,
                            normalizedSelectionIds: triageNormalized.media.map(
                                row => row.selectionId
                            ),
                            mediaCoverage: triageNormalized.coverage,
                            captions: [],
                            genderOperationKey: null,
                            genderResultHash: null,
                            featureOperationKey: null,
                            featureResultHash: null,
                            baselineClassification: 'media_unavailable' as const,
                            classificationSource: 'unavailable' as const,
                            genderResolutionStatus: defaultGenderResolutionStatus,
                            genderResolutionOperationKey: null,
                            genderResolutionResultHash: null,
                            mediaBundlePersisted: false,
                        };
                    }
                    if (triageSha256 === null) throw new Error('ANALYSIS_V2_MEDIA_SELECTION_DRIFT');
                    const evidence = {
                        ordinal: index, username: item.username, candidateId, profile, policy, selectionProvenance,
                        profileEvidence, triageSha256,
                    };
                    const input = profileGenderInput(triageNormalized, evidence);
                    if (!plannedGender) {
                        return analyzePreparedProfile(evidence, triageNormalized, () => dependencies.ai.gender(input, aiFence));
                    }
                    const byteSize = [...triageNormalized.bytes.values()].reduce((sum, bytes) => sum + bytes.length, 0);
                    const retain = retainedBytes + byteSize <= ANALYSIS_V2_MEDIA_BUNDLE_MAX_BYTES;
                    if (retain) retainedBytes += byteSize;
                    return {
                        kind: 'planned_gender',
                        account: prepareGenderTriagePlanAccount(input, inputQualityPolicyVersion),
                        evidence,
                        load: profileTriageLoader(triageNormalized, retain, dependencies.sourceMediaArchive, {
                            requestId: context.claim.requestId,
                            archiveId: analysisV2SourceMediaArchiveId({ candidateId, stage: 'triage' }),
                            contentSha256: triageSha256,
                        }),
                    };
                }

                async function analyzePreparedProfile(
                    evidence: ProfileGenderEvidence,
                    triageNormalized: TriageMedia,
                    evaluate: GenderEvaluation,
                    retryRemainder?: ProfileMediaInput,
                ): Promise<AnalysisV2PreparedProfileAiOutcome> {
                    const { username, candidateId, profile, policy, selectionProvenance, profileEvidence, triageSha256 } = evidence;
                    const triageArchiveCheckpoint = captureSourceArchiveRevisions
                        ? { sourceMediaArchive: { triageSha256, featureRemainderSha256: null } }
                        : {};
                    let gender: Awaited<ReturnType<AnalysisV2AiStageRuntime['gender']>>;
                    try {
                        gender = await evaluate();
                    } catch (error) {
                        if (isAnalysisV2AiDeterministicFallbackError(error)) {
                            return analysisUnavailableOutcome(
                                candidateId,
                                username,
                                profile,
                                defaultGenderResolutionStatus,
                            );
                        }
                        throw error;
                    }
                    if (gender.result.routingDecision === 'exclude_high_confidence_male') {
                        return {
                            candidateId,
                            instagramId: normalizeUsername(username),
                            status: 'verified_non_female' as const,
                            unavailableReason: null,
                            profile: profile,
                            triage: gender.result,
                            feature: null,
                            normalizedSelectionIds: triageNormalized.media.map(
                                row => row.selectionId
                            ),
                            mediaCoverage: triageNormalized.coverage,
                            captions: [],
                            genderOperationKey: gender.operationKey,
                            genderResultHash: gender.resultHash,
                            featureOperationKey: null,
                            featureResultHash: null,
                            baselineClassification: 'verified_non_female' as const,
                            classificationSource: 'triage' as const,
                            genderResolutionStatus: defaultGenderResolutionStatus,
                            genderResolutionOperationKey: null,
                            genderResolutionResultHash: null,
                            mediaBundlePersisted: false,
                            ...triageArchiveCheckpoint,
                        };
                    }
                    const v29Admission = policySupports(
                        aiFence.aiStagePolicyVersion,
                        'genderTriageMicrobatchV29',
                    )
                        ? policySupports(
                            aiFence.aiStagePolicyVersion,
                            'genderSummaryQualityV211',
                        )
                            ? v211FeatureAdmission(gender.result, profile)
                            : v29FeatureAdmission(gender.result, profile)
                        : null;
                    const featureRemainder = remainingFeatureMedia(policy);
                    const savedRemainder = savedBySlot.get(`${evidence.ordinal}:feature_remainder`);
                    const previousRemainder = savedRemainder ?? retryRemainder;
                    const remainderNormalized = previousRemainder
                        ? await restoreProfileMedia(previousRemainder, featureRemainder, candidateId,
                            inputFence.requestId, dependencies.sourceMediaArchive)
                        : await normalizeAnalysisV2MediaSelections(
                            featureRemainder, dependencies.normalizeMedia, aiFence.aiStagePolicyVersion,
                        );
                    const featureMedia = {
                        ordinal: evidence.ordinal, candidateId, selected: featureRemainder, normalized: remainderNormalized,
                        saved: savedRemainder, deferred: retryRemainder, fence: inputFence,
                        store: inputStore, archive: dependencies.sourceMediaArchive,
                    };
                    const normalized = mergeNormalizedSelections(
                        policy.feature.media,
                        [triageNormalized, remainderNormalized]
                    );
                    if (!isAnalysisV2StageMediaCoverageUsable(
                        normalized.coverage,
                        aiFence.aiStagePolicyVersion,
                    )) {
                        await pinProfileFeatureMedia(featureMedia, null, false);
                        return {
                            candidateId,
                            instagramId: normalizeUsername(username),
                            status: 'media_unavailable' as const,
                            unavailableReason: null,
                            profile: profile,
                            triage: null,
                            feature: null,
                            normalizedSelectionIds: normalized.media.map(
                                row => row.selectionId
                            ),
                            mediaCoverage: normalized.coverage,
                            captions: [],
                            genderOperationKey: null,
                            genderResultHash: null,
                            featureOperationKey: null,
                            featureResultHash: null,
                            baselineClassification: 'media_unavailable' as const,
                            classificationSource: 'unavailable' as const,
                            genderResolutionStatus: defaultGenderResolutionStatus,
                            genderResolutionOperationKey: null,
                            genderResolutionResultHash: null,
                            mediaBundlePersisted: false,
                        };
                    }
                    const normalizedSelectionIds = new Set(
                        normalized.media.map(row => row.selectionId)
                    );
                    const captionPolicy = buildCarouselCaptionPolicy({
                        targetUsername: profile.username,
                        profile: profile,
                        featureSelections: policy.feature.media,
                        partnerSelections: policy.partnerSafetyContactSheetCandidates.media,
                    });
                    const captions = captionPolicy.featureCaptions.filter(caption => (
                        normalizedSelectionIds.has(caption.selectionId)
                    ));
                    const triageAssessment = gender.result.assessment;
                    const resolverMedia =
                        policySupports(
                            aiFence.aiStagePolicyVersion,
                            'genderTriageMicrobatchV29',
                        )
                            ? selectAnalysisV2GenderResolverMedia(normalized.media)
                            : normalized.media;
                    const resolverEligible = genderResolutionEnabled && (
                        policySupports(
                            aiFence.aiStagePolicyVersion,
                            'genderTriageMicrobatchV29',
                        )
                            ? v29GenderResolverAdmission(
                                gender.result,
                                resolverMedia.length,
                            ) === 'eligible'
                            : !(
                                triageAssessment.inferredGender === 'female'
                                && triageAssessment.confidence === 'high'
                                && triageAssessment.ownerConsistency === 'same_person'
                            )
                    );
                    const shouldStartResolver = resolverEligible && !strictRevenueResolverDeferred;
                    if (
                        v29Admission !== null
                        && v29Admission !== 'eligible'
                        && !shouldStartResolver
                    ) {
                        await pinProfileFeatureMedia(featureMedia, null, false);
                        return {
                            candidateId,
                            instagramId: normalizeUsername(username),
                            status: 'unresolved' as const,
                            unavailableReason: null,
                            profile: profile,
                            triage: gender.result,
                            feature: null,
                            normalizedSelectionIds: normalized.media.map(
                                row => row.selectionId
                            ),
                            mediaCoverage: normalized.coverage,
                            captions,
                            genderOperationKey: gender.operationKey,
                            genderResultHash: gender.resultHash,
                            featureOperationKey: null,
                            featureResultHash: null,
                            baselineClassification: 'unresolved' as const,
                            classificationSource: 'unknown' as const,
                            genderResolutionStatus: 'not_eligible' as const,
                            genderResolutionOperationKey: null,
                            genderResolutionResultHash: null,
                            mediaBundlePersisted: false,
                            ...triageArchiveCheckpoint,
                            aiStagePolicyVersion: inputQualityPolicyVersion,
                            v29FeatureAdmission: v29Admission,
                        };
                    }
                    const featureInput: FeatureAnalysisInput = {
                        triage: gender.result, bio: profile.bio ?? null, media: normalized.media, captions,
                        ...(profileEvidence ? { accountProfile: profileEvidence } : {}),
                    };
                    const featureKey = inputStore
                        ? createFeatureAnalysisResultIdentity(featureInput, inputQualityPolicyVersion).operationKey : null;
                    const featureRemainderSha256 = await pinProfileFeatureMedia(featureMedia, featureKey, true);
                    const resolverHandle = shouldStartResolver
                        ? dependencies.ai.startGenderResolution({ media: resolverMedia }, resolverFence)
                        : null;
                    if (resolverHandle) {
                        startedResolverHandles.push(resolverHandle);
                    }
                    let features: Awaited<ReturnType<AnalysisV2AiStageRuntime['features']>>;
                    try {
                        features = await dependencies.ai.features(featureInput, aiFence);
                    } catch (error) {
                        if (isAnalysisV2AiDeterministicFallbackError(error)) {
                            return {
                                kind: 'resolver_pending',
                                resolverHandle,
                                finalize: async resolverState => {
                                    const readyResolver =
                                        resolverState?.status === 'ready'
                                            ? resolverState.value
                                            : null;
                                    const resolverFailureStatus =
                                        !resolverHandle
                                            ? defaultGenderResolutionStatus
                                            : resolverState?.status === 'ready'
                                                ? 'ready_not_needed' as const
                                                : resolverState?.status === 'capacity_skipped'
                                                    ? 'capacity_skipped' as const
                                                    : resolverState?.status
                                                        === 'terminal_unavailable'
                                                        ? 'terminal_unavailable' as const
                                                        : 'cutoff' as const;
                                    return analysisUnavailableOutcome(
                                        candidateId,
                                        username,
                                        profile,
                                        resolverFailureStatus,
                                        readyResolver?.operationKey ?? null,
                                        readyResolver?.resultHash ?? null,
                                    );
                                },
                            };
                        }
                        const resolverState = await settleOptionalGenderResolution(
                            resolverHandle
                        );
                        if (resolverState?.status === 'recovery_pending') {
                            throw new AnalysisV2AiResultRecoveryPendingError();
                        }
                        throw error;
                    }
                    const baselineClassification =
                        features.result.finalGenderDecision === 'verified_female'
                        ? 'verified_female' as const
                        : features.result.finalGenderDecision === 'verified_non_female'
                            ? 'verified_non_female' as const
                            : features.result.finalGenderDecision === 'unresolved_stage_conflict'
                                ? 'unresolved_stage_conflict' as const
                                : 'unresolved' as const;
                    const normalizedSelectionIdList = normalized.media.map(
                        row => row.selectionId
                    );
                    const normalizedCoverage = normalized.coverage;
                    const officialScreening = inputQualityV28
                        ? screenAnalysisV2OfficialAccount({
                            modelAccountContext: features.result.features.accountContext,
                            fullName: profile.fullName ?? null,
                            bio: profile.bio ?? null,
                        })
                        : null;
                    const modelAccountContext = features.result.features.accountContext;
                    const accountContextOverride = inputQualityV28
                        ? modelAccountContext === 'official_group_or_brand'
                            ? officialScreening!.accountContext
                            : modelAccountContext
                        : undefined;
                    const officialScreeningStatus = inputQualityV28
                        ? modelAccountContext !== 'official_group_or_brand'
                            ? 'not_model_official' as const
                            : officialScreening!.exclusionReason
                                ? 'corroborated_official' as const
                                : 'uncorroborated_official' as const
                        : undefined;
                    const couldResolveFemale = resolverHandle !== null
                        && (
                            baselineClassification === 'unresolved'
                            || baselineClassification === 'unresolved_stage_conflict'
                        );
                    const deferredBundleMedia: AnalysisV2NormalizedMediaBundleItem[] =
                        couldResolveFemale
                            ? features.result.analyzedSelectionIds.map(selectionId => {
                                const bytes = normalized.bytes.get(selectionId);
                                if (!bytes) {
                                    throw new Error('ANALYSIS_V2_MEDIA_SELECTION_DRIFT');
                                }
                                return { selectionId, normalizedJpeg: bytes };
                            })
                            : [];
                    let baselineMediaBundlePersisted = false;
                    if (baselineClassification === 'verified_female') {
                        const bundleMedia: AnalysisV2NormalizedMediaBundleItem[] =
                            features.result.analyzedSelectionIds.map(selectionId => {
                                const bytes = normalized.bytes.get(selectionId);
                                if (!bytes) {
                                    throw new Error('ANALYSIS_V2_MEDIA_SELECTION_DRIFT');
                                }
                                return { selectionId, normalizedJpeg: bytes };
                            });
                        await dependencies.mediaStore.persistBundle({
                            requestId: context.claim.requestId,
                            jobKey: context.claim.jobKey,
                            claimToken: context.claim.claimToken,
                            bundleId: analysisV2CandidateBundleId(candidateId),
                            media: bundleMedia,
                        });
                        baselineMediaBundlePersisted = true;
                    }
                    return {
                        kind: 'resolver_pending',
                        resolverHandle,
                        finalize: async settledResolverState => {
                            const readyResolver =
                                settledResolverState?.status === 'ready'
                                    ? settledResolverState.value
                                    : null;
                            const reconciliation = applyGenderResolution({
                                baselineClassification,
                                baselineSource: baselineClassification === 'verified_female'
                                    || baselineClassification === 'verified_non_female'
                                    ? 'feature'
                                    : 'unknown',
                                triage: gender.result.assessment,
                                feature: features.result,
                                resolver: readyResolver?.result ?? null,
                            });
                            const status = reconciliation.finalClassification;
                            const genderResolutionStatus =
                                !genderResolutionEnabled
                                    ? 'disabled' as const
                                    : !resolverHandle
                                        ? 'not_eligible' as const
                                        : settledResolverState?.status === 'ready'
                                            ? reconciliation.resolverApplied
                                                ? 'ready_applied' as const
                                                : baselineClassification === 'verified_female'
                                                    || baselineClassification
                                                        === 'verified_non_female'
                                                    ? 'ready_not_needed' as const
                                                    : 'ready_inconclusive' as const
                                            : settledResolverState?.status
                                                === 'capacity_skipped'
                                                ? 'capacity_skipped' as const
                                                : settledResolverState?.status
                                                    === 'terminal_unavailable'
                                                    ? 'terminal_unavailable' as const
                                                    : 'cutoff' as const;
                            let mediaBundlePersisted = baselineMediaBundlePersisted;
                            if (status === 'verified_female' && !mediaBundlePersisted) {
                                if (deferredBundleMedia.length === 0) {
                                    throw new Error('ANALYSIS_V2_MEDIA_SELECTION_DRIFT');
                                }
                                await dependencies.mediaStore.persistBundle({
                                    requestId: context.claim.requestId,
                                    jobKey: context.claim.jobKey,
                                    claimToken: context.claim.claimToken,
                                    bundleId: analysisV2CandidateBundleId(candidateId),
                                    media: deferredBundleMedia,
                                });
                                mediaBundlePersisted = true;
                            }
                            return {
                                candidateId,
                                instagramId: normalizeUsername(username),
                                status,
                                unavailableReason: null,
                                profile,
                                triage: gender.result,
                                feature: features.result,
                                normalizedSelectionIds: normalizedSelectionIdList,
                                mediaCoverage: normalizedCoverage,
                                captions,
                                genderOperationKey: gender.operationKey,
                                genderResultHash: gender.resultHash,
                                featureOperationKey: features.operationKey,
                                featureResultHash: features.resultHash,
                                baselineClassification,
                                classificationSource: reconciliation.classificationSource,
                                genderResolutionStatus,
                                genderResolutionOperationKey:
                                    readyResolver?.operationKey ?? null,
                                genderResolutionResultHash:
                                    readyResolver?.resultHash ?? null,
                                mediaBundlePersisted,
                                ...(captureSourceArchiveRevisions
                                    ? { sourceMediaArchive: { triageSha256, featureRemainderSha256 } }
                                    : {}),
                                ...(selectionProvenance
                                    ? {
                                        aiStagePolicyVersion: inputQualityPolicyVersion,
                                        mediaSelectionProvenance: selectionProvenance,
                                        inputQualityPolicy: 'input-quality-v2.8' as const,
                                    }
                                    : {}),
                                ...(accountContextOverride
                                    ? { accountContextOverride }
                                    : {}),
                                ...(officialScreeningStatus
                                    ? { officialScreeningStatus }
                                    : {}),
                                ...(officialScreening
                                    ? { officialExclusionReason: officialScreening.exclusionReason }
                                    : {}),
                            };
                        },
                    };
                }
                const prepared = await runBounded(results, profileConcurrency, prepareProfile);
                preparedOutcomes = new Array(prepared.length);
                const byAccount = new Map<string, { index: number; work: PlannedProfile }[]>();
                const accounts: GenderTriagePlanAccount[] = [];
                prepared.forEach((work, index) => {
                    if ('kind' in work && work.kind === 'planned_gender') {
                        const entries = byAccount.get(work.account.accountId) ?? [];
                        entries.push({ index, work });
                        byAccount.set(work.account.accountId, entries);
                        accounts.push(work.account);
                    } else {
                        preparedOutcomes[index] = work;
                    }
                });
                if (plannedGender) {
                    newTriageInputs.sort((a, b) => a.ordinal - b.ordinal);
                    if (!saved.hasGenderHistory && newTriageInputs.length) {
                        await inputStore!.pin(inputFence, newTriageInputs);
                    }
                    const plan = await plannedGender.plan(accounts, inputFence);
                    // Legacy paid jobs predate input receipts. Reproduce their historical keys before
                    // freezing this observed normalization outcome for the next delivery.
                    if (saved.hasGenderHistory && newTriageInputs.length) {
                        await inputStore!.pin(inputFence, newTriageInputs);
                    }
                    const deferred: {
                        work: PlannedProfile;
                        index: number;
                        gender: Awaited<ReturnType<GenderEvaluation>>;
                        receipt: ProfileMediaInput;
                    }[] = [];
                    await runProfileGroups(plan, profileConcurrency, group => (
                        group.accountIds.reduce((count, id) => count + byAccount.get(id)!.length, 0)
                    ), async (group, slots) => {
                        const entries = group.accountIds.map(id => byAccount.get(id)!);
                        const media = await Promise.all(entries.map(rows => rows[0]!.work.load()));
                        const gender = plannedGender.run(
                            entries.map((rows, index) => profileGenderInput(media[index]!, rows[0]!.work.evidence)), group, aiFence,
                        );
                        const rows = entries.flatMap((members, memberIndex) => members.map((item, ordinal) => (
                            { ...item, memberIndex, ordinal }
                        )));
                        await runBounded(rows, slots, async ({ index, work, memberIndex, ordinal }) => {
                            const ownMedia = ordinal === 0 ? media[memberIndex]! : await work.load();
                            const evaluate = async () => (await gender)[memberIndex]!;
                            try {
                                preparedOutcomes[index] = await analyzePreparedProfile(work.evidence, ownMedia, evaluate);
                            } catch (error) {
                                if (!(error instanceof DeferredProfileFeatureInput)) throw error;
                                deferred.push({ work, index, gender: await evaluate(), receipt: error.receipt });
                            }
                        });
                    });
                    // A historical feature key may belong to a later group. Only its exact owner can
                    // adopt it. Keep the earlier candidates' archive references while that owner runs.
                    if (saved.hasUnownedFeatureHistory || deferred.length) {
                        if ((await inputStore!.load(inputFence)).hasUnownedFeatureHistory) {
                            throw new Error('ANALYSIS_V2_PROFILE_GENDER_PLAN_DRIFT');
                        }
                        await runBounded(deferred, profileConcurrency, async ({ work, index, gender, receipt }) => {
                            preparedOutcomes[index] = await analyzePreparedProfile(
                                work.evidence, await work.load(), async () => gender, receipt,
                            );
                        });
                    }
                }
            } catch (error) {
                const cleanupStates = await Promise.all(
                    startedResolverHandles.map(settleOptionalGenderResolution)
                );
                if (cleanupStates.some(state => state?.status === 'recovery_pending')) {
                    throw new AnalysisV2AiResultRecoveryPendingError();
                }
                throw error;
            }
            const resolverStates = await Promise.all(preparedOutcomes.map(outcome => (
                isDeferredProfileAiOutcome(outcome)
                    ? settleOptionalGenderResolution(outcome.resolverHandle)
                    : Promise.resolve(null)
            )));
            if (resolverStates.some(state => state?.status === 'recovery_pending')) {
                throw new AnalysisV2AiResultRecoveryPendingError();
            }
            const budgetWait = resolverStates.find(state => state?.status === 'budget_reservation_pending');
            if (budgetWait?.status === 'budget_reservation_pending') throw budgetWait.error;
            const outcomes = await runBounded(
                preparedOutcomes,
                profileConcurrency,
                async (outcome, index) => (
                    isDeferredProfileAiOutcome(outcome)
                        ? outcome.finalize(resolverStates[index] ?? null)
                        : outcome
                ),
            );
            const publicCheckpoint = await dependencies.resultStore.checkpointFeatureBatch({
                ...checkpointClaim(context),
                batch: context.job.batch!,
                analyzedCount: outcomes.length,
                rows: outcomes.map(outcome => publicFeatureRow(outcome, inputQualityV28)),
            });
            assertCheckpointCount(publicCheckpoint, outcomes.length, 'PROFILE_AI');
            const stored = await dependencies.stageStore.checkpointProfileAiBatch({
                ...checkpointClaim(context),
                batch: context.job.batch!,
                ...(inputQualityV28
                    ? { aiStagePolicyVersion: inputQualityPolicyVersion }
                    : {}),
                outcomes,
            });
            if (stored.itemCount !== topology.itemCount) {
                throw new Error('ANALYSIS_V2_PROFILE_AI_STAGE_COUNT_DRIFT');
            }
            return {
                checkpoint: {
                    kind: 'profile_ai_batch',
                    manifest: {
                        batch: context.job.batch!,
                        itemCount: topology.itemCount,
                        producerInputHash: context.job.inputHash,
                        revision: stored.revision,
                        resultHash: stored.resultHash,
                    },
                },
            };
        },

        async private_names(context) {
            const topology = topologyBatch(context, 'private');
            const relationship = await dependencies.evidence.loadRelationships(
                checkpointClaim(context)
            );
            const rows = relationshipRowsByBatch(
                relationship,
                context.job.batch!,
                topology.itemCount
            );
            const analyzed = await dependencies.ai.privateNames(rows.map(row => ({
                id: analysisV2CandidateId(row.username),
                username: row.username,
                ...(row.fullName ? { fullName: row.fullName } : {}),
            })), aiJobFence(context));
            if (analyzed.results.length !== rows.length) {
                throw new Error('ANALYSIS_V2_PRIVATE_NAME_COUNT_DRIFT');
            }
            const resultById = new Map(analyzed.results.map(result => [result.id, result]));
            const persistedRows: AnalysisV2PrivateNameRow[] = rows.map(row => {
                const candidateId = analysisV2CandidateId(row.username);
                const result = resultById.get(candidateId);
                if (!result) throw new Error('ANALYSIS_V2_PRIVATE_NAME_RESULT_MISSING');
                return {
                    candidateId,
                    instagramId: row.username,
                    fullName: row.fullName,
                    profileImageUrl: row.profilePicUrl,
                    nameFemaleScore: result.femaleScore,
                    nameIsName: result.isName,
                    nameConfidence: result.confidence,
                };
            });
            const checkpoint = await dependencies.resultStore.checkpointPrivateNames({
                ...checkpointClaim(context),
                batch: context.job.batch!,
                source: analyzed.source as AnalysisV2AiFallbackSource,
                operationKey: analyzed.operationKey,
                aiResultHash: analyzed.resultHash,
                rows: persistedRows,
            });
            assertCheckpointCount(checkpoint, rows.length, 'PRIVATE_NAME');
            return {
                checkpoint: {
                    kind: 'private_name_batch',
                    manifest: {
                        batch: context.job.batch!,
                        itemCount: rows.length,
                        producerInputHash: context.job.inputHash,
                        revision: 1,
                        resultHash: checkpoint.resultHash,
                    },
                },
            };
        },

        async primary_join(context) {
            const strictRevenue = hasStrictRevenueRelationshipSelection(context);
            // Preserve the legacy Promise.all shape exactly for every request
            // without the immutable strict marker. No revenue/context/result
            // dependency is even referenced on that path.
            const [relationship, targetEvidence, plannedOutcomes] = await Promise.all([
                dependencies.evidence.loadRelationships(checkpointClaim(context)),
                dependencies.evidence.loadTargetEvidence(checkpointClaim(context)),
                dependencies.stageStore.loadProfileAiOutcomes(checkpointClaim(context)),
            ]);
            const outcomes = strictRevenue
                ? await resolveStrictPrimaryRevenueOutcomes(
                    dependencies,
                    context,
                    plannedOutcomes,
                )
                : plannedOutcomes;
            const excluded = relationship.excludedUsername;
            const verified = outcomes.filter(outcome => (
                outcome.status === 'verified_female'
                && outcome.instagramId !== excluded
            ));
            const joined = joinVerifiedFemaleTargetInteractions({
                evidence: targetEvidence.rows.map(row => ({
                    actorUsername: row.actorUsername,
                    postId: row.postId,
                    signal: row.signal,
                    sourceInteractionId: row.sourceInteractionId,
                    ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
                    ...(row.content ? { content: row.content } : {}),
                })),
                verifiedFemaleUsernames: verified.map(row => row.instagramId),
                excludedUsername: excluded,
            });
            const joinedByUsername = new Map<string, InteractionEvidenceRow[]>();
            for (const row of joined) {
                const list = joinedByUsername.get(row.candidateUsername) ?? [];
                list.push(row);
                joinedByUsername.set(row.candidateUsername, list);
            }
            const candidates = verified.map(outcome => ({
                candidateId: outcome.candidateId,
                instagramId: outcome.instagramId,
                interactions: joinedByUsername.get(outcome.instagramId) ?? [],
            }));
            // `candidates` is the durable resolver-adjusted female-membership
            // authority.  Its stage-manifest count remains the downstream
            // detail count, because a featureless resolver-verified woman is
            // intentionally excluded by screening and must not make result
            // materialization expect a score row that cannot exist.
            const screenableCandidateIds = new Set(verified.flatMap(outcome => (
                outcome.profile && outcome.feature ? [outcome.candidateId] : []
            )));
            const stored = await dependencies.stageStore.checkpointPrimaryJoin({
                ...checkpointClaim(context),
                candidates,
            });
            return {
                checkpoint: {
                    kind: 'primary_join',
                    manifest: {
                        revision: stored.revision,
                        resultHash: stored.resultHash,
                        verifiedFemaleCount: candidates.filter(candidate => (
                            screenableCandidateIds.has(candidate.candidateId)
                        )).length,
                    },
                },
            };
        },

        async screening(context) {
            const [relationship, target, outcomes, joined] = await Promise.all([
                dependencies.evidence.loadRelationships(checkpointClaim(context)),
                dependencies.targetProfiles.loadTargetProfile(checkpointClaim(context)),
                dependencies.stageStore.loadProfileAiOutcomes(checkpointClaim(context)),
                dependencies.stageStore.loadPrimaryJoin(checkpointClaim(context)),
            ]);
            if (!joined) throw new Error('ANALYSIS_V2_PRIMARY_JOIN_NOT_READY');
            const strictRevenue = hasStrictRevenueRelationshipSelection(context);
            const joinedById = new Map(joined.candidates.map(row => [row.candidateId, row]));
            const verified = outcomes.filter(outcome => (
                // The strict primary checkpoint is the durable authority after
                // its resolver overlay. It must not be negated here by the
                // immutable profile-AI baseline status, or a newly resolved
                // woman would disappear before score/materialization.
                (strictRevenue
                    ? joinedById.has(outcome.candidateId)
                    : outcome.status === 'verified_female')
                && outcome.feature
                && outcome.profile
                && outcome.instagramId !== relationship.excludedUsername
                && joinedById.has(outcome.candidateId)
            ));
            const summaries = summarizeCandidateTargetInteractions(
                joined.candidates.flatMap(row => row.interactions)
            );
            const summaryByUsername = new Map(
                summaries.map(summary => [summary.candidateUsername, summary])
            );
            const candidateEvidence = verified.map(outcome => {
                    const summary = summaryByUsername.get(outcome.instagramId);
                    const tagEvidence = hasCandidateTargetMention({
                        targetUsername: target.username,
                        candidateUsername: outcome.instagramId,
                        targetPosts: target.latestPosts ?? [],
                        candidatePosts: outcome.profile!.latestPosts ?? [],
                    });
                    return {
                        candidateId: outcome.candidateId,
                        username: outcome.instagramId,
                        appearanceGrade: outcome.feature!.features.appearanceGrade as AppearanceGrade,
                        exposureScore: outcome.feature!.features.exposureScore,
                        // v2.8 may conservatively downgrade an uncorroborated
                        // model official label to uncertain. The v2.4 scorer then
                        // consumes this existing account-context input unchanged.
                        accountContext: screenedAccountContext(
                            outcome,
                            policySupports(
                                aiJobFence(context).aiStagePolicyVersion,
                                'inputQualityV28',
                            ),
                        ),
                        hasWeakPartnerEvidence: weakFeaturePartnerEvidence(outcome.feature!),
                        hasStrongPartnerEvidence: strongFeaturePartnerEvidence(outcome.feature!),
                        uniqueTargetPostsLikedByCandidate:
                            summary?.uniqueTargetPostsLikedByCandidate ?? 0,
                        boundedCandidateCommentsOnTarget:
                            summary?.boundedCandidateCommentsOnTarget ?? 0,
                        hasCandidateToTargetTagOrCaptionMention:
                            tagEvidence.candidateToTargetTagOrCaptionMention,
                        hasTargetToCandidateTagOrCaptionMention:
                            tagEvidence.targetToCandidateTagOrCaptionMention,
                    };
                });
            const orderedMutualUsernames = relationship.mutualRows
                .slice()
                .sort((left, right) => left.mutualOrdinal - right.mutualOrdinal)
                .map(row => row.username);
            const legacyRecovery = context.riskPolicyVersion === 'risk-policy-v2.3';
            const liveRiskPolicyVersion = context.riskPolicyVersion as RiskPolicyVersion;
            const preliminary = legacyRecovery
                ? calculateLegacyV23PreliminaryScores({
                    candidates: candidateEvidence.map(row => ({
                        ...row,
                        hasTagOrCaptionMention:
                            row.hasCandidateToTargetTagOrCaptionMention
                            || row.hasTargetToCandidateTagOrCaptionMention,
                    })),
                    orderedMutualUsernames,
                    excludedUsername: relationship.excludedUsername,
                })
                : calculateV2PreliminaryScores({
                    candidates: candidateEvidence,
                    orderedMutualUsernames,
                    excludedUsername: relationship.excludedUsername,
                    riskPolicyVersion: liveRiskPolicyVersion,
                });
            const shortlistIds = preliminary
                .filter(row => row.verificationShortlistRank !== null)
                .sort((left, right) => (
                    left.verificationShortlistRank! - right.verificationShortlistRank!
                ))
                .map(row => row.candidateId);
            const shortlistHash = sha256('analysis-v2-verification-shortlist-v1', shortlistIds);
            const publicCheckpoint = await dependencies.resultStore.checkpointPreliminaryScores({
                ...checkpointClaim(context),
                rows: legacyRecovery
                    ? (preliminary as readonly LegacyV23PreliminaryCandidate[]).map(candidate => {
                        const risk = calculateLegacyV23PreliminaryRisk(candidate);
                        return {
                            candidateId: candidate.candidateId,
                            components: risk.components,
                            preScore: risk.preScore,
                            possibleUpperBound: risk.possibleUpperBound,
                            recentMutualRank: candidate.recentFemaleMutualRank,
                            verificationShortlistRank: candidate.verificationShortlistRank,
                        };
                    })
                    : (preliminary as readonly V2PreliminaryCandidateScore[])
                        .map(candidate => preliminaryStoreRow(
                            candidate,
                            liveRiskPolicyVersion
                        )),
                riskPolicyVersion: context.riskPolicyVersion!,
            });
            assertCheckpointCount(publicCheckpoint, preliminary.length, 'SCREENING');
            const stored = await dependencies.stageStore.checkpointScreening({
                ...checkpointClaim(context),
                candidates: preliminary as readonly V2PreliminaryCandidateScore[],
                shortlistHash,
                riskPolicyVersion: context.riskPolicyVersion!,
            });
            if (stored.shortlistHash !== shortlistHash) {
                throw new Error('ANALYSIS_V2_SHORTLIST_HASH_DRIFT');
            }
            return {
                checkpoint: {
                    kind: 'screening',
                    manifest: {
                        revision: stored.revision,
                        resultHash: stored.resultHash,
                        verifiedFemaleCount: preliminary.length,
                        shortlistCount: shortlistIds.length,
                        shortlistHash,
                    },
                },
            };
        },

        async reverse_likes(context) {
            const [screening, outcomes, target] = await Promise.all([
                dependencies.stageStore.loadScreening(checkpointClaim(context)),
                dependencies.stageStore.loadProfileAiOutcomes(checkpointClaim(context)),
                dependencies.targetProfiles.loadTargetProfile(checkpointClaim(context)),
            ]);
            if (!screening) throw new Error('ANALYSIS_V2_SCREENING_NOT_READY');
            if ((screening.riskPolicyVersion ?? 'risk-policy-v2.4') !== context.riskPolicyVersion) {
                throw new Error('ANALYSIS_V2_LEGACY_POLICY_INVALID');
            }
            const legacyRecovery = context.riskPolicyVersion === 'risk-policy-v2.3';
            const outcomeById = new Map(outcomes.map(row => [row.candidateId, row]));
            const shortlist = screening.candidates
                .filter(row => row.verificationShortlistRank !== null)
                .sort((left, right) => (
                    left.verificationShortlistRank! - right.verificationShortlistRank!
                ));
            const collectionInputs = shortlist.flatMap(row => {
                const profile = outcomeById.get(row.candidateId)?.profile;
                const scope = profile ? latestPostLikeScope(profile) : null;
                return scope ? [{ candidateId: row.candidateId, ...scope }] : [];
            });
            const collected = await dependencies.reverseLikes.collect({
                ...checkpointClaim(context),
                targetUsername: target.username,
                candidates: collectionInputs,
                limitPerPost: REVERSE_LIKE_LIMIT,
            });
            validateReverseLikeCollection(collectionInputs, collected);
            const resultById = new Map(collected.results.map(row => [row.candidateId, row]));
            const rows = shortlist.map(candidate => {
                const result = resultById.get(candidate.candidateId);
                const status: AnalysisV2ReverseLikeObservation = result?.status === 'observed'
                    ? 'observed'
                    : result?.status === 'not_observed'
                        ? 'observed_not_found'
                        : 'not_collected';
                return {
                    candidateId: candidate.candidateId,
                    shortlistRank: candidate.verificationShortlistRank!,
                    status,
                    operationKey: result ? collected.operationKey : null,
                };
            });
            const reverseById = new Map(rows.map(row => [row.candidateId, row]));
            const publicRows: AnalysisV2StoredReverseLikeRow[] = screening.candidates.map(
                candidate => {
                    const row = reverseById.get(candidate.candidateId);
                    const status = row?.status ?? 'not_collected';
                    return {
                        candidateId: candidate.candidateId,
                        status: status === 'observed_not_found' ? 'not_observed' : status,
                        componentScore: status === 'observed' ? (legacyRecovery ? 3 : 5) : 0,
                        evidenceRefIds: status === 'observed'
                            ? [evidenceRef(
                                'analysis-v2-reverse-like-ref-v1',
                                candidate.candidateId
                            )]
                            : [],
                    };
                }
            );
            const publicCheckpoint = await dependencies.resultStore.checkpointReverseLikes({
                ...checkpointClaim(context),
                rows: publicRows,
                ...(legacyRecovery ? { riskPolicyVersion: 'risk-policy-v2.3' as const } : {}),
            });
            assertCheckpointCount(
                publicCheckpoint,
                screening.candidates.length,
                'REVERSE_LIKES'
            );
            const stored = await dependencies.stageStore.checkpointReverseLikes({
                ...checkpointClaim(context),
                rows,
            });
            return {
                checkpoint: {
                    kind: 'reverse_likes',
                    manifest: {
                        revision: stored.revision,
                        resultHash: stored.resultHash,
                        shortlistCount: rows.length,
                    },
                },
            };
        },

        async partner_safety(context) {
            const [screening, outcomes, target] = await Promise.all([
                dependencies.stageStore.loadScreening(checkpointClaim(context)),
                dependencies.stageStore.loadProfileAiOutcomes(checkpointClaim(context)),
                dependencies.targetProfiles.loadTargetProfile(checkpointClaim(context)),
            ]);
            if (!screening) throw new Error('ANALYSIS_V2_SCREENING_NOT_READY');
            const outcomeById = new Map(outcomes.map(row => [row.candidateId, row]));
            const shortlist = screening.candidates
                .filter(row => row.verificationShortlistRank !== null)
                .sort((left, right) => (
                    left.verificationShortlistRank! - right.verificationShortlistRank!
                ));
            const rows = await runBounded(shortlist, partnerConcurrency, async candidate => {
                const outcome = outcomeById.get(candidate.candidateId);
                if (!outcome?.profile || !outcome.feature) {
                    throw new Error('ANALYSIS_V2_PARTNER_FEATURE_MISSING');
                }
                const selected = mediaPolicy(
                    outcome.profile,
                    policySupports(aiJobFence(context).aiStagePolicyVersion, 'inputQualityV28'),
                );
                const contactCandidates = selected.partnerSafetyContactSheetCandidates.media;
                const captionPolicy = buildCarouselCaptionPolicy({
                    targetUsername: target.username,
                    profile: outcome.profile,
                    featureSelections: selected.feature.media,
                    partnerSelections: contactCandidates,
                });
                const normalized = await normalizeAnalysisV2MediaSelections(
                    contactCandidates,
                    dependencies.normalizeMedia
                );
                const contactSheetCoverageComplete = normalized.coverage.failures.length === 0;
                const previouslyArchived = new Set(outcome.normalizedSelectionIds);
                const contactBundleMedia = contactSheetCoverageComplete
                    ? normalized.media.filter(media => (
                        !previouslyArchived.has(media.selectionId)
                    )).map(media => {
                        const normalizedJpeg = normalized.bytes.get(media.selectionId);
                        if (!normalizedJpeg) {
                            throw new Error('ANALYSIS_V2_PARTNER_MEDIA_SELECTION_DRIFT');
                        }
                        return { selectionId: media.selectionId, normalizedJpeg };
                    })
                    : [];
                const contactSheet = contactSheetCoverageComplete && normalized.media.length > 0
                    ? await createContactSheet(normalized.media.map(media => ({
                            selectionId: media.selectionId,
                            normalizedJpegBase64: media.normalizedJpegBase64,
                        })))
                    : null;
                const persistenceTasks: Promise<unknown>[] = [];
                if (contactSheet) {
                    persistenceTasks.push(dependencies.mediaStore.persistBundle({
                        requestId: context.claim.requestId,
                        jobKey: context.claim.jobKey,
                        claimToken: context.claim.claimToken,
                        bundleId: analysisV2PartnerSafetyBundleId(candidate.candidateId),
                        media: contactSheet.sourceSelectionIds.map(selectionId => {
                            const normalizedJpeg = normalized.bytes.get(selectionId);
                            if (!normalizedJpeg) {
                                throw new Error('ANALYSIS_V2_PARTNER_MEDIA_SELECTION_DRIFT');
                            }
                            return { selectionId, normalizedJpeg };
                        }),
                    }));
                }
                const normalizedSelectionIds = new Set(
                    normalized.media.map(media => media.selectionId)
                );
                const contactSheetSelectionIds = new Set(contactSheet?.sourceSelectionIds ?? []);
                const partnerCaptions = contactSheet
                    ? captionPolicy.partnerCaptions.filter(caption => (
                        normalizedSelectionIds.has(caption.selectionId)
                        && contactSheetSelectionIds.has(caption.selectionId)
                    ))
                    : [];
                if (contactBundleMedia.length > 0) {
                    persistenceTasks.push(dependencies.sourceMediaArchive.persistBundle({
                        requestId: context.claim.requestId,
                        archiveId: analysisV2SourceMediaArchiveId({
                            candidateId: candidate.candidateId,
                            stage: 'partner_contact_remainder',
                        }),
                        media: contactBundleMedia,
                    }));
                }
                if (contactSheet) {
                    persistenceTasks.push(dependencies.sourceMediaArchive.persistBundle({
                        requestId: context.claim.requestId,
                        archiveId: analysisV2SourceMediaArchiveId({
                            candidateId: candidate.candidateId,
                            stage: 'partner_contact_sheet',
                        }),
                        media: [{
                            selectionId: contactSheet.selectionId,
                            normalizedJpeg: Buffer.from(
                                contactSheet.normalizedJpegBase64,
                                'base64',
                            ),
                        }],
                    }));
                }
                const persistence = Promise.all(persistenceTasks).then(() => undefined);
                const analyzed = await awaitArchivedAi(
                    dependencies.ai.partnerSafety({
                        feature: outcome.feature,
                        contactSheet,
                        partnerCaptions,
                    }, aiJobFence(context)),
                    persistence,
                );
                return {
                    candidateId: candidate.candidateId,
                    shortlistRank: candidate.verificationShortlistRank!,
                    result: analyzed.result,
                    operationKey: analyzed.operationKey || null,
                    resultHash: analyzed.resultHash,
                    mediaCoverage: normalized.coverage,
                };
            });
            const partnerById = new Map(rows.map(row => [row.candidateId, row]));
            const publicRows: AnalysisV2StoredPartnerSafetyRow[] = screening.candidates.map(
                candidate => {
                    const row = partnerById.get(candidate.candidateId);
                    const outcome = outcomeById.get(candidate.candidateId);
                    if (!outcome?.feature) {
                        throw new Error('ANALYSIS_V2_PARTNER_FEATURE_MISSING');
                    }
                    if (row) {
                        return {
                            candidateId: row.candidateId,
                            source: row.result.source,
                            hasStrongPartnerEvidence: row.result.hasStrongPartnerEvidence,
                            hasWeakPartnerEvidence:
                                row.result.hasWeakNonExcludedMalePairEvidence
                                && !row.result.hasStrongPartnerEvidence,
                            strongEvidenceBasis: row.result.strongEvidenceBasis,
                            evidenceSelectionIds: partnerEvidenceSelectionIds(
                                outcome,
                                row.result
                            ),
                            bundleId: row.result.source === 'gemini'
                                || row.result.source === 'safe_fallback'
                                ? analysisV2PartnerSafetyBundleId(row.candidateId)
                                : null,
                            operationKey: row.operationKey,
                            aiResultHash: row.resultHash,
                        };
                    }
                    const strong = strongFeaturePartnerEvidence(outcome.feature);
                    const weak = weakFeaturePartnerEvidence(outcome.feature) && !strong;
                    return {
                        candidateId: candidate.candidateId,
                        source: 'not_collected',
                        hasStrongPartnerEvidence: strong,
                        hasWeakPartnerEvidence: weak,
                        strongEvidenceBasis: strong ? 'feature' : 'none',
                        evidenceSelectionIds: strong || weak
                            ? partnerEvidenceSelectionIds(outcome, null)
                            : [],
                        bundleId: null,
                        operationKey: null,
                        aiResultHash: null,
                    };
                }
            );
            const publicCheckpoint = await dependencies.resultStore.checkpointPartnerSafety({
                ...checkpointClaim(context),
                rows: publicRows,
            });
            assertCheckpointCount(
                publicCheckpoint,
                screening.candidates.length,
                'PARTNER_SAFETY'
            );
            const stored = await dependencies.stageStore.checkpointPartnerSafety({
                ...checkpointClaim(context),
                rows,
            });
            return {
                checkpoint: {
                    kind: 'partner_safety',
                    manifest: {
                        revision: stored.revision,
                        resultHash: stored.resultHash,
                        shortlistCount: rows.length,
                    },
                },
            };
        },

        async final_score(context) {
            const [screening, reverse, partner, outcomes] = await Promise.all([
                dependencies.stageStore.loadScreening(checkpointClaim(context)),
                dependencies.stageStore.loadReverseLikes(checkpointClaim(context)),
                dependencies.stageStore.loadPartnerSafety(checkpointClaim(context)),
                dependencies.stageStore.loadProfileAiOutcomes(checkpointClaim(context)),
            ]);
            if (!screening || !reverse || !partner) {
                throw new Error('ANALYSIS_V2_FINAL_SCORE_DEPENDENCY_MISSING');
            }
            if ((screening.riskPolicyVersion ?? 'risk-policy-v2.4') !== context.riskPolicyVersion) {
                throw new Error('ANALYSIS_V2_LEGACY_POLICY_INVALID');
            }
            const legacyRecovery = context.riskPolicyVersion === 'risk-policy-v2.3';
            const liveRiskPolicyVersion = context.riskPolicyVersion as RiskPolicyVersion;
            const partnerById = new Map(partner.rows.map(row => [row.candidateId, row]));
            const outcomeById = new Map(outcomes.map(row => [row.candidateId, row]));
            const preliminary = screening.candidates.map(candidate => {
                const partnerResult = partnerById.get(candidate.candidateId)?.result;
                const hasStrongPartnerEvidence = partnerResult?.hasStrongPartnerEvidence
                    ?? candidate.hasStrongPartnerEvidence;
                const hasWeakPartnerEvidence = (
                    partnerResult?.hasWeakNonExcludedMalePairEvidence
                    ?? candidate.hasWeakPartnerEvidence
                ) && !hasStrongPartnerEvidence;
                return {
                    ...candidate,
                    hasWeakPartnerEvidence,
                    hasStrongPartnerEvidence,
                };
            });
            const observed = new Set(reverse.rows
                .filter(row => row.status === 'observed')
                .map(row => row.candidateId));
            const notCollected = new Set(reverse.rows
                .filter(row => row.status === 'not_collected')
                .map(row => row.candidateId));
            const candidates = legacyRecovery
                ? calculateLegacyV23FinalScores({
                    preliminary: preliminary as unknown as readonly LegacyV23PreliminaryCandidate[],
                    observedReverseLikeCandidateIds: observed,
                    notCollectedCandidateIds: notCollected,
                })
                : calculateV2FinalScores({
                    preliminary,
                    observedReverseLikeCandidateIds: observed,
                    notCollectedCandidateIds: notCollected,
                    riskPolicyVersion: liveRiskPolicyVersion,
                });
            const narrativeCandidateIds = candidates
                .filter(row => row.riskBand === 'high_risk' && row.featuredRank !== null)
                .sort((left, right) => left.featuredRank! - right.featuredRank!)
                .slice(0, 3)
                .map(row => row.candidateId);
            await captureDevStandardEval(context, dependencies.devStandardEvalCapture, async expiresAt => {
                const finalCandidates = candidates as readonly V2FinalCandidateScore[];
                const selected = finalCandidates.filter(row => {
                    const outcome = outcomeById.get(row.candidateId);
                    return outcome?.baselineClassification === 'verified_female'
                        && outcome.feature?.finalGenderDecision === 'verified_female';
                }).sort((left, right) =>
                    Number(right.riskBand === 'high_risk') - Number(left.riskBand === 'high_risk')
                    || right.displayScore - left.displayScore
                    || left.candidateId.localeCompare(right.candidateId)
                ).slice(0, 3);
                if (selected.length !== 3) return null;
                const samples = await Promise.all(selected.map(row => retainedDevEvalCandidate({
                    requestId: context.claim.requestId,
                    outcome: outcomeById.get(row.candidateId)!,
                    archive: dependencies.sourceMediaArchive,
                })));
                return devStandardEvalBundleSchema.parse({
                    version: 1,
                    expiresAt,
                    candidates: samples,
                    preliminary: preliminary.map((row, index) => ({ ...row, username: `eval_${index + 1}` })),
                    observed: [...observed],
                    notCollected: [...notCollected],
                    partnerOverrides: partner.rows.flatMap(row => {
                        const evidence = row.result.assessment?.partnerEvidence;
                        return row.result.assessment?.exclusionContext === 'none'
                            && (evidence === 'weak' || evidence === 'strong')
                            ? [{ candidateId: row.candidateId, evidence }] : [];
                    }),
                    originalHighRiskIds: finalCandidates
                        .filter(row => row.riskBand === 'high_risk')
                        .map(row => row.candidateId),
                });
            });
            const narrativeBatchHash = sha256(
                'analysis-v2-narrative-batch-v1',
                narrativeCandidateIds
            );
            const scoreRows: AnalysisV2CandidateScoreRow[] = candidates.map(candidate => {
                const partnerRow = partnerById.get(candidate.candidateId);
                const outcome = outcomeById.get(candidate.candidateId);
                if (!outcome?.feature) {
                    throw new Error('ANALYSIS_V2_PARTNER_FEATURE_MISSING');
                }
                return {
                    candidateId: candidate.candidateId,
                    ...(legacyRecovery ? {} : { accountContext: candidate.accountContext as AccountContext }),
                    displayScore: candidate.displayScore,
                    riskBand: candidate.riskBand as RiskBand,
                    featuredRank: candidate.featuredRank,
                    recentMutualRank: candidate.recentFemaleMutualRank,
                    verificationShortlistRank: candidate.verificationShortlistRank,
                    partnerSafetySource: partnerScoreSource(partnerRow),
                    partnerSafetyOperationKey: partnerRow?.operationKey ?? null,
                    partnerSafetyResultHash: partnerRow?.resultHash ?? null,
                    components: candidate.risk.components,
                    weakPartnerAdjustment: candidate.risk.weakPartnerAdjustment,
                    preScore: candidate.risk.preScore,
                    rawScore: candidate.risk.rawScore,
                    possibleUpperBound: candidate.risk.possibleUpperBound,
                    publicScore: candidate.risk.publicScore,
                    possibleUpperPublicScore: candidate.risk.possibleUpperPublicScore,
                    partnerCapApplied: candidate.risk.partnerCapApplied,
                    partnerEvidenceSelectionIds:
                        partnerEvidenceSelectionIds(
                            outcome,
                            partnerRow?.result ?? null
                        ),
                } as AnalysisV2CandidateScoreRow;
            });
            const publicCheckpoint = await dependencies.resultStore.checkpointScores({
                ...checkpointClaim(context),
                rows: scoreRows,
                riskPolicyVersion: context.riskPolicyVersion!,
            });
            assertCheckpointCount(publicCheckpoint, candidates.length, 'FINAL_SCORE');
            const stored = await dependencies.stageStore.checkpointFinalScores({
                ...checkpointClaim(context),
                candidates: candidates as unknown as readonly V2FinalCandidateScore[],
                narrativeCandidateIds,
                narrativeBatchHash,
                riskPolicyVersion: context.riskPolicyVersion!,
            });
            return {
                checkpoint: {
                    kind: 'final_score',
                    manifest: {
                        revision: stored.revision,
                        resultHash: stored.resultHash,
                        featuredHighRiskCount: narrativeCandidateIds.length,
                        narrativeCount: narrativeCandidateIds.length,
                        narrativeBatchHash,
                    },
                },
            };
        },

        async narrative(context) {
            const [finalScores, outcomes, targetEvidence, reverse, target] = await Promise.all([
                dependencies.stageStore.loadFinalScores(checkpointClaim(context)),
                dependencies.stageStore.loadProfileAiOutcomes(checkpointClaim(context)),
                dependencies.evidence.loadTargetEvidence(checkpointClaim(context)),
                dependencies.stageStore.loadReverseLikes(checkpointClaim(context)),
                dependencies.targetProfiles.loadTargetProfile(checkpointClaim(context)),
            ]);
            if (!finalScores || !reverse) {
                throw new Error('ANALYSIS_V2_NARRATIVE_DEPENDENCY_MISSING');
            }
            if ((finalScores.riskPolicyVersion ?? 'risk-policy-v2.4') !== context.riskPolicyVersion) {
                throw new Error('ANALYSIS_V2_LEGACY_POLICY_INVALID');
            }
            const outcomeById = new Map(outcomes.map(row => [row.candidateId, row]));
            const reverseById = new Map(reverse.rows.map(row => [row.candidateId, row]));
            const fence = aiJobFence(context);
            const v211SubjectsByCandidate = policySupports(fence.aiStagePolicyVersion, 'genderSummaryQualityV211')
                ? new Map<string, V211CopySubjects>()
                : undefined;
            const rows = await runBounded(
                finalScores.narrativeCandidateIds,
                narrativeConcurrency,
                async candidateId => {
                    const outcome = outcomeById.get(candidateId);
                    if (
                        !outcome?.profile
                        || !outcome.feature
                        || (!outcome.mediaBundlePersisted
                            && !hasStrictRevenueRelationshipSelection(context))
                    ) {
                        throw new Error('ANALYSIS_V2_NARRATIVE_FEATURE_MISSING');
                    }
                    const bundle = await dependencies.mediaStore.loadBundle({
                        requestId: context.claim.requestId,
                        jobKey: context.claim.jobKey,
                        claimToken: context.claim.claimToken,
                        bundleId: analysisV2CandidateBundleId(candidateId),
                        expectedSelectionIds: outcome.feature.analyzedSelectionIds,
                    });
                    if (!bundle) throw new Error('ANALYSIS_V2_NARRATIVE_BUNDLE_MISSING');
                    const selected = mediaPolicy(
                        outcome.profile,
                        policySupports(aiJobFence(context).aiStagePolicyVersion, 'inputQualityV28'),
                    );
                    const captionPolicy = buildCarouselCaptionPolicy({
                        targetUsername: target.username,
                        profile: outcome.profile,
                        featureSelections: selected.feature.media,
                        partnerSelections: selected.partnerSafetyContactSheetCandidates.media,
                    });
                    const postBySelection = new Map(selected.feature.media
                        .map(media => [media.selectionId, media]));
                    const media: NormalizedAiMediaSelection[] = bundle.map(item => {
                        const selected = postBySelection.get(item.selectionId);
                        return {
                            selectionId: item.selectionId,
                            kind: selected?.role === 'profile' ? 'profile' : 'feed',
                            normalizedJpegBase64: item.normalizedJpeg.toString('base64'),
                            ...(selected?.postId ? { postId: selected.postId } : {}),
                        };
                    });
                    const input = narrativeInput({
                        targetUsername: target.username,
                        targetFullName: target.fullName ?? null,
                        outcome,
                        media,
                        carouselCaptionDossier: captionPolicy.dossier,
                        targetEvidence,
                        targetPosts: target.latestPosts ?? [],
                        reverse: reverseById.get(candidateId),
                    });
                    v211SubjectsByCandidate?.set(candidateId, {
                        ...input.forbiddenIdentifiers,
                        ...input.publicSubjects,
                    });
                    const analyzed = await dependencies.ai.narrative(input, fence);
                    return {
                        candidateId,
                        lines: analyzed.result.lines,
                        source: analyzed.source === 'safe_fallback'
                            ? 'safe_fallback' as const
                            : 'checkpoint' as const,
                        operationKey: analyzed.operationKey,
                        aiResultHash: analyzed.resultHash,
                    };
                }
            );
            const publicCheckpoint = await dependencies.resultStore.checkpointNarratives({
                ...checkpointClaim(context),
                rows,
                v211SubjectsByCandidate,
            });
            assertCheckpointCount(publicCheckpoint, rows.length, 'NARRATIVE');
            const stored = await dependencies.stageStore.checkpointNarratives({
                ...checkpointClaim(context),
                rows,
            });
            return {
                checkpoint: {
                    kind: 'narrative',
                    manifest: {
                        revision: stored.revision,
                        resultHash: stored.resultHash,
                        narrativeCount: rows.length,
                    },
                },
            };
        },

        async finalize(context) {
            const archive = currentDevStandardArchive();
            if (archive && !dependencies.resultImages) return archive.fail();
            const target = await dependencies.targetProfiles.loadTargetProfile(
                checkpointClaim(context)
            );
            let resultImageManifest:
                | { orderedManifestHash: string; expectedRows: number }
                | undefined;
            if (dependencies.resultImages) {
                const stage = await dependencies.resultStore
                    .loadStageSnapshot({
                        requestId: context.claim.requestId,
                    });
                if (!stage) {
                    throw new Error(
                        'ANALYSIS_V2_RESULT_IMAGE_SOURCE_NOT_READY'
                    );
                }
                const sources = buildAnalysisV2ResultImageSources({
                    targetProfileImageUrl: target.profilePicUrl ?? null,
                    stage,
                });
                const orderedManifestHash =
                    resultImageOrderedManifestHash(sources);
                await dependencies.resultImages.capture({
                    ...checkpointClaim(context),
                    sources,
                    orderedManifestHash,
                    expectedRows: sources.length,
                });
                resultImageManifest = {
                    orderedManifestHash,
                    expectedRows: sources.length,
                };
                if (archive?.mode === 'capture') {
                    await archive.capture('result-image-manifest-v1', [normalizeUsername(target.username)], {
                        orderedManifestHash,
                        expectedRows: sources.length,
                        imageCount: sources.filter(source => source.sourceUrl !== null).length,
                        imageInputs: sources.map(resultImageArchiveIdentity),
                    });
                }
            }
            // This is deliberately the last durable gate before resultStore.finalize:
            // a strict cohort that fails coverage is manual-review only and must
            // never emit analysis_completed.
            await enforceRevenueFinalQualityGate(dependencies, context);
            await sealDevStandardArchive({
                profileBatches: context.state.relationships?.profileBatches.map(batch => batch.batch) ?? [],
            });
            await dependencies.resultStore.finalize({
                ...checkpointClaim(context),
                targetProfileImageUrl: target.profilePicUrl ?? null,
                ...(resultImageManifest ? { resultImageManifest } : {}),
            });
            await enqueueFinalizedAnalysisOrderAuditBundle(
                dependencies.orderAuditBundle?.enqueue,
                context.claim.requestId,
            );
            try {
                await (dependencies.analysisLifecycleEventEmitter ?? emitAnalysisLifecycleEvent)({
                    requestId: context.claim.requestId,
                    eventName: 'analysis_completed',
                });
            } catch {
                // Analytics is advisory after the result finalization is durable.
            }
            await dependencies.stageStore.purgeTerminal(checkpointClaim(context));
            try {
                await dependencies.mediaStore.cleanupTerminal();
            } catch {
                // Finalization is already durable; bucket lifecycle cleanup remains the backstop.
            }
            return { checkpoint: null };
        },
    };
}
