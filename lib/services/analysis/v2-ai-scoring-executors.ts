import { createHash } from 'node:crypto';
import {
    MAX_RECENT_POSTS,
    selectAnalysisMedia,
    type SelectedAnalysisMedia,
} from '@/lib/domain/analysis/media-policy';
import { applyGenderResolution } from '@/lib/services/ai/v2-staged-analysis';
import { buildCarouselCaptionPolicy } from '@/lib/domain/analysis/carousel-caption-policy';
import {
    calculateRiskPolicy,
    type AccountContext,
    type AppearanceGrade,
    type RiskBand,
} from '@/lib/domain/analysis/risk-policy';
import { createPartnerSafetyContactSheet } from '@/lib/services/ai/partner-contact-sheet';
import {
    resultImageOrderedManifestHash,
    type ResultImageCaptureSource,
} from '@/lib/services/media/result-image-capture';
import {
    classifyAnalysisImagePreparationError,
    type AnalysisImagePreparationFailureDisposition,
    type AnalysisImagePreparationFailureReason,
} from '@/lib/services/ai/image-preprocessing';
import type {
    FeatureAnalysisResult,
    GenderTriageResult,
    HighRiskNarrativeInput,
    NormalizedAiMediaSelection,
    PartnerSafetyResult,
} from '@/lib/services/ai/v2-staged-analysis';
import { AI_STAGE_POLICY_LATEST_VERSION } from '@/lib/services/ai/stage-policy';
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
    AnalysisV2ResultStageSnapshot,
    AnalysisV2ResultStore,
    AnalysisV2VerifiedFemaleFeatureRow,
} from './v2-result-store';
import type {
    AnalysisV2MediaArtifactStore,
    AnalysisV2NormalizedMediaBundleItem,
} from './v2-media-artifact-store';
import type {
    AnalysisV2StageExecutorContext,
    AnalysisV2StageExecutorRegistry,
} from './v2-worker';
import {
    AnalysisV2GenderResolutionCutoffPersistenceError,
    type AnalysisV2AiStageRuntime,
    type AnalysisV2GenderResolutionHandle,
    type AnalysisV2GenderResolutionState,
} from './v2-ai-stage-runtime';
import { AnalysisV2AiResultRecoveryPendingError } from './v2-ai-result-store';
import { isAnalysisV2AiDeterministicFallbackError } from './v2-ai-fallback-policy';

const PROFILE_BATCH_JOB_PREFIX = 'track:profiles:batch:';
const MAX_PROFILE_AI_CONCURRENCY = 4;
const MAX_PARTNER_SAFETY_CONCURRENCY = 3;
const MAX_NARRATIVE_CONCURRENCY = 3;
const REVERSE_LIKE_LIMIT = 100;
export const ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS = 2;

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

export interface AnalysisV2ProfileMediaCoverage {
    selectedCount: number;
    normalizedCount: number;
    failures: readonly Readonly<{
        selectionId: string;
        reason: AnalysisImagePreparationFailureReason;
        disposition: AnalysisImagePreparationFailureDisposition;
    }>[];
}

export function isAnalysisV2PartialMediaCoverageAllowed(
    coverage: AnalysisV2ProfileMediaCoverage,
): boolean {
    return coverage.normalizedCount >= 1
        && coverage.failures.length * 5 <= coverage.selectedCount;
}

export class AnalysisV2TransientMediaPreparationError extends Error {
    constructor() {
        super('ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT');
        this.name = 'AnalysisV2TransientMediaPreparationError';
    }
}

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
    riskPolicyVersion?: 'risk-policy-v2.3' | 'risk-policy-v2.4';
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
    riskPolicyVersion?: 'risk-policy-v2.3' | 'risk-policy-v2.4';
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
        riskPolicyVersion?: 'risk-policy-v2.3' | 'risk-policy-v2.4';
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
        | 'finalize'
        | 'loadStageSnapshot'>;
    resultImages?: {
        capture(input: AnalysisV2StageReadClaim & {
            sources: readonly ResultImageCaptureSource[];
            orderedManifestHash: string;
            expectedRows: number;
        }): Promise<unknown>;
    };
    mediaStore: AnalysisV2MediaArtifactStore;
    ai: AnalysisV2AiStageRuntime;
    reverseLikes: AnalysisV2ReverseLikeCollector;
    normalizeMedia(media: SelectedAnalysisMedia): Promise<Buffer>;
    createContactSheet?: typeof createPartnerSafetyContactSheet;
    profileAiConcurrency?: number;
    partnerSafetyConcurrency?: number;
    narrativeConcurrency?: number;
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

function mediaPolicy(profile: AnalysisV2CheckpointProfile) {
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
    });
    if (policy.carouselCoverage.incompletePostIds.length > 0) {
        throw new Error('ANALYSIS_V2_PROFILE_MEDIA_STRUCTURAL_INCOMPLETE');
    }
    return policy;
}

async function normalizedSelections(
    selected: readonly SelectedAnalysisMedia[],
    normalizeMedia: (media: SelectedAnalysisMedia) => Promise<Buffer>,
    aiStagePolicyVersion: string = 'ai-stage-policy-v2.6',
): Promise<Readonly<{
    media: NormalizedAiMediaSelection[];
    bytes: Map<string, Buffer>;
    coverage: AnalysisV2ProfileMediaCoverage;
}>> {
    const prepared = await Promise.all(selected.map(async item => {
        for (let attempt = 1; attempt <= ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS; attempt++) {
            try {
                return { status: 'success' as const, item, bytes: await normalizeMedia(item) };
            } catch (error) {
                const failure = classifyAnalysisImagePreparationError(error, 'download');
                if (
                    failure.disposition === 'transient'
                    && attempt < ANALYSIS_V2_MEDIA_NORMALIZATION_MAX_ATTEMPTS
                ) {
                    continue;
                }
                return {
                    status: 'failure' as const,
                    item,
                    failure: {
                        selectionId: item.selectionId,
                        reason: failure.reason,
                        disposition: failure.disposition,
                    },
                };
            }
        }
        throw new Error('ANALYSIS_V2_MEDIA_PREPARATION_ATTEMPT_DRIFT');
    }));
    const successful = prepared.filter(item => item.status === 'success');
    const failures = prepared.flatMap(item => item.status === 'failure' ? [item.failure] : []);
    if (
        aiStagePolicyVersion !== AI_STAGE_POLICY_LATEST_VERSION
        && failures.some(failure => failure.disposition === 'transient')
    ) {
        const failureReasons = failures.reduce<Record<string, number>>((counts, failure) => {
            counts[failure.reason] = (counts[failure.reason] ?? 0) + 1;
            return counts;
        }, {});
        console.warn('Analysis V2 media preparation has transient failures', {
            selectedCount: selected.length,
            failureReasons,
        });
        throw new AnalysisV2TransientMediaPreparationError();
    }
    const media: NormalizedAiMediaSelection[] = successful.map(({ item, bytes }) => ({
        selectionId: item.selectionId,
        kind: item.role === 'profile' ? 'profile' : 'feed',
        normalizedJpegBase64: bytes.toString('base64'),
        ...(item.postId ? { postId: item.postId } : {}),
    }));
    return {
        media,
        bytes: new Map(successful.map(item => [item.item.selectionId, item.bytes])),
        coverage: Object.freeze({
            selectedCount: selected.length,
            normalizedCount: successful.length,
            failures: Object.freeze(failures),
        }),
    };
}

function isAnalysisV2StageMediaCoverageUsable(
    coverage: AnalysisV2ProfileMediaCoverage,
    aiStagePolicyVersion: string,
): boolean {
    const usable = aiStagePolicyVersion === AI_STAGE_POLICY_LATEST_VERSION
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
    parts: readonly Awaited<ReturnType<typeof normalizedSelections>>[]
): Awaited<ReturnType<typeof normalizedSelections>> {
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
    const policy = mediaPolicy(outcome.profile);
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

function publicFeatureRow(outcome: AnalysisV2ProfileAiOutcome): AnalysisV2VerifiedFemaleFeatureRow {
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
        feature: outcome.status === 'verified_female' && outcome.feature
            ? {
                appearanceGrade: outcome.feature.features.appearanceGrade as AppearanceGrade,
                exposureScore: outcome.feature.features.exposureScore,
                isBusinessAccount: [
                    'individual_creator',
                    'official_group_or_brand',
                ].includes(outcome.feature.features.accountContext),
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
    if (!/^candidate-likers:[a-f0-9]{64}$/.test(collected.operationKey ?? '')) {
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
    outcome: AnalysisV2ProfileAiOutcome;
    media: readonly NormalizedAiMediaSelection[];
    carouselCaptionDossier: Readonly<{ evidenceRefId: string; text: string }> | null;
    targetEvidence: AnalysisV2TargetEvidenceStagingSnapshot;
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

function aiJobFence(context: AnalysisV2StageExecutorContext<AnalysisV2StageIdSubset>) {
    if (!context.aiStagePolicyVersion) {
        throw new Error('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
    }
    return {
        ...checkpointClaim(context),
        aiStagePolicyVersion: context.aiStagePolicyVersion,
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
    candidate: V2PreliminaryCandidateScore
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
    });
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
    const profileConcurrency = dependencies.profileAiConcurrency
        ?? MAX_PROFILE_AI_CONCURRENCY;
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
            const genderResolutionEnabled =
                aiFence.aiStagePolicyVersion === AI_STAGE_POLICY_LATEST_VERSION;
            const defaultGenderResolutionStatus = genderResolutionEnabled
                ? 'not_eligible' as const
                : 'disabled' as const;
            const startedResolverHandles: AnalysisV2GenderResolutionHandle[] = [];
            let preparedOutcomes: AnalysisV2PreparedProfileAiOutcome[];
            try {
                preparedOutcomes = await runBounded(
                    results,
                    profileConcurrency,
                    async (item): Promise<AnalysisV2PreparedProfileAiOutcome> => {
                        await context.reportActiveProfile?.(item.username);
                    const candidateId = analysisV2CandidateId(item.username);
                    if (item.status !== 'success' || !item.profile || item.profile.isPrivate) {
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

                    const policy = mediaPolicy(profile);
                    const triageNormalized = await normalizedSelections(
                        policy.triage.media,
                        dependencies.normalizeMedia,
                        aiFence.aiStagePolicyVersion,
                    );
                    if (
                        !isAnalysisV2StageMediaCoverageUsable(
                            triageNormalized.coverage,
                            aiFence.aiStagePolicyVersion,
                        )
                    ) {
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
                    let gender: Awaited<ReturnType<AnalysisV2AiStageRuntime['gender']>>;
                    try {
                        gender = await dependencies.ai.gender({
                            media: triageNormalized.media,
                        }, aiFence);
                    } catch (error) {
                        if (isAnalysisV2AiDeterministicFallbackError(error)) {
                            return analysisUnavailableOutcome(
                                candidateId,
                                item.username,
                                item.profile,
                                defaultGenderResolutionStatus,
                            );
                        }
                        throw error;
                    }
                    if (gender.result.routingDecision === 'exclude_high_confidence_male') {
                        return {
                            candidateId,
                            instagramId: normalizeUsername(item.username),
                            status: 'verified_non_female' as const,
                            unavailableReason: null,
                            profile: item.profile,
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
                        };
                    }
                    const triageAttempted = new Set(policy.triage.selectionIds);
                    const featureRemainder = policy.feature.media.filter(media => (
                        !triageAttempted.has(media.selectionId)
                    ));
                    const remainderNormalized = await normalizedSelections(
                        featureRemainder,
                        dependencies.normalizeMedia,
                        aiFence.aiStagePolicyVersion,
                    );
                    const normalized = mergeNormalizedSelections(
                        policy.feature.media,
                        [triageNormalized, remainderNormalized]
                    );
                    if (!isAnalysisV2StageMediaCoverageUsable(
                        normalized.coverage,
                        aiFence.aiStagePolicyVersion,
                    )) {
                        return {
                            candidateId,
                            instagramId: normalizeUsername(item.username),
                            status: 'media_unavailable' as const,
                            unavailableReason: null,
                            profile: item.profile,
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
                        targetUsername: item.profile.username,
                        profile: item.profile,
                        featureSelections: policy.feature.media,
                        partnerSelections: policy.partnerSafetyContactSheetCandidates.media,
                    });
                    const captions = captionPolicy.featureCaptions.filter(caption => (
                        normalizedSelectionIds.has(caption.selectionId)
                    ));
                    const featureTask = dependencies.ai.features({
                        triage: gender.result,
                        bio: item.profile.bio ?? null,
                        media: normalized.media,
                        captions,
                    }, aiFence);
                    const triageAssessment = gender.result.assessment;
                    const resolverEligible = genderResolutionEnabled && !(
                        triageAssessment.inferredGender === 'female'
                        && triageAssessment.confidence === 'high'
                        && triageAssessment.ownerConsistency === 'same_person'
                    );
                    const resolverHandle = resolverEligible
                        ? dependencies.ai.startGenderResolution({
                            media: normalized.media,
                        }, aiFence)
                        : null;
                    if (resolverHandle) {
                        startedResolverHandles.push(resolverHandle);
                    }
                    let features: Awaited<ReturnType<AnalysisV2AiStageRuntime['features']>>;
                    try {
                        features = await featureTask;
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
                                        item.username,
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
                                instagramId: normalizeUsername(item.username),
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
                            };
                        },
                    };
                    },
                );
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
                rows: outcomes.map(publicFeatureRow),
            });
            assertCheckpointCount(publicCheckpoint, outcomes.length, 'PROFILE_AI');
            const stored = await dependencies.stageStore.checkpointProfileAiBatch({
                ...checkpointClaim(context),
                batch: context.job.batch!,
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
            const [relationship, targetEvidence, outcomes] = await Promise.all([
                dependencies.evidence.loadRelationships(checkpointClaim(context)),
                dependencies.evidence.loadTargetEvidence(checkpointClaim(context)),
                dependencies.stageStore.loadProfileAiOutcomes(checkpointClaim(context)),
            ]);
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
                        verifiedFemaleCount: candidates.length,
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
            const joinedById = new Map(joined.candidates.map(row => [row.candidateId, row]));
            const verified = outcomes.filter(outcome => (
                outcome.status === 'verified_female'
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
            const preliminary = calculateV2PreliminaryScores({
                candidates: verified.map(outcome => {
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
                        accountContext: outcome.feature!.features.accountContext,
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
                }),
                orderedMutualUsernames: relationship.mutualRows
                    .slice()
                    .sort((left, right) => left.mutualOrdinal - right.mutualOrdinal)
                    .map(row => row.username),
                excludedUsername: relationship.excludedUsername,
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
                rows: preliminary.map(preliminaryStoreRow),
            });
            assertCheckpointCount(publicCheckpoint, preliminary.length, 'SCREENING');
            const stored = await dependencies.stageStore.checkpointScreening({
                ...checkpointClaim(context),
                candidates: preliminary,
                shortlistHash,
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
            const legacyRecovery = screening.riskPolicyVersion === 'risk-policy-v2.3';
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
                const selected = mediaPolicy(outcome.profile);
                const contactCandidates = selected.partnerSafetyContactSheetCandidates.media;
                const captionPolicy = buildCarouselCaptionPolicy({
                    targetUsername: target.username,
                    profile: outcome.profile,
                    featureSelections: selected.feature.media,
                    partnerSelections: contactCandidates,
                });
                const normalized = await normalizedSelections(
                    contactCandidates,
                    dependencies.normalizeMedia
                );
                const contactSheetCoverageComplete = normalized.coverage.failures.length === 0;
                const contactSheet = contactSheetCoverageComplete && normalized.media.length > 0
                    ? await createContactSheet(normalized.media.map(media => ({
                        selectionId: media.selectionId,
                        normalizedJpegBase64: media.normalizedJpegBase64,
                    })))
                    : null;
                if (contactSheet) {
                    await dependencies.mediaStore.persistBundle({
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
                    });
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
                const analyzed = await dependencies.ai.partnerSafety({
                    feature: outcome.feature,
                    contactSheet,
                    partnerCaptions,
                }, aiJobFence(context));
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
            const legacyRecovery = screening.riskPolicyVersion === 'risk-policy-v2.3';
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
                });
            const narrativeCandidateIds = candidates
                .filter(row => row.riskBand === 'high_risk' && row.featuredRank !== null)
                .sort((left, right) => left.featuredRank! - right.featuredRank!)
                .slice(0, 3)
                .map(row => row.candidateId);
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
                ...(legacyRecovery ? { riskPolicyVersion: 'risk-policy-v2.3' as const } : {}),
            });
            assertCheckpointCount(publicCheckpoint, candidates.length, 'FINAL_SCORE');
            const stored = await dependencies.stageStore.checkpointFinalScores({
                ...checkpointClaim(context),
                candidates: candidates as unknown as readonly V2FinalCandidateScore[],
                narrativeCandidateIds,
                narrativeBatchHash,
                ...(legacyRecovery ? { riskPolicyVersion: 'risk-policy-v2.3' as const } : {}),
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
            const outcomeById = new Map(outcomes.map(row => [row.candidateId, row]));
            const reverseById = new Map(reverse.rows.map(row => [row.candidateId, row]));
            const rows = await runBounded(
                finalScores.narrativeCandidateIds,
                narrativeConcurrency,
                async candidateId => {
                    const outcome = outcomeById.get(candidateId);
                    if (
                        !outcome?.profile
                        || !outcome.feature
                        || !outcome.mediaBundlePersisted
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
                    const selected = mediaPolicy(outcome.profile);
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
                    const analyzed = await dependencies.ai.narrative(narrativeInput({
                        targetUsername: target.username,
                        outcome,
                        media,
                        carouselCaptionDossier: captionPolicy.dossier,
                        targetEvidence,
                        reverse: reverseById.get(candidateId),
                    }), aiJobFence(context));
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
            }
            await dependencies.resultStore.finalize({
                ...checkpointClaim(context),
                targetProfileImageUrl: target.profilePicUrl ?? null,
                ...(resultImageManifest ? { resultImageManifest } : {}),
            });
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
