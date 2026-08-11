import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    ACCOUNT_CONTEXT_SOFT_MULTIPLIERS,
    FEATURED_RISK_LIMITS,
    STRONG_PARTNER_PUBLIC_SCORE_CAP,
} from '@/lib/domain/analysis/risk-policy';
import type {
    FeatureAnalysisResult,
    GenderTriageResult,
    PartnerSafetyResult,
} from '@/lib/services/ai/v2-staged-analysis';
import { featureAnalysisInputSchema } from '@/lib/services/ai/v2-staged-analysis';
import { AnalysisImagePreparationError } from '@/lib/services/ai/image-preprocessing';
import {
    AI_STAGE_POLICY_LATEST_VERSION,
    AI_STAGE_POLICY_V210_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
    AI_STAGE_POLICY_VERSION,
} from '@/lib/services/ai/stage-policy';
import type { AnalysisV2CheckpointProfile } from './v2-profile-fetch-store';
import type {
    AnalysisV2RelationshipStagingSnapshot,
    AnalysisV2TargetEvidenceStagingSnapshot,
} from './v2-evidence-store';
import {
    createSupabaseAnalysisV2ResultStore,
    type AnalysisV2ProfileClassificationRow,
    type AnalysisV2ResultCheckpointManifest,
    type AnalysisV2RevenueResolverOutcomePatch,
    type AnalysisV2ResultStageSnapshot,
    type AnalysisV2ResultSupabaseClient,
} from './v2-result-store';
import type { AnalysisV2StageExecutorContext, AnalysisV2StageId } from './v2-worker';
import type { AnalysisV2ProgressCandidateMediaPreview } from './progress-candidate-media';
import * as progressCandidateMedia from './progress-candidate-media';
import {
    AnalysisV2GenderResolutionCutoffPersistenceError,
    type AnalysisV2AiStageRuntime,
} from './v2-ai-stage-runtime';
import type { AnalysisV2MediaArtifactStore } from './v2-media-artifact-store';
import {
    analysisV2SourceMediaArchiveId,
    type AnalysisV2SourceMediaArchiveStore,
} from './v2-source-media-archive';
import type { AnalysisV2DagState } from './v2-dag-planner';
import { AnalysisV2AiResultRateLimitExhaustedError } from './v2-ai-result-store';
import {
    createSupabaseAnalysisV2AiScoringStageStore,
    type AnalysisV2AiScoringStageSupabaseClient,
} from './v2-ai-scoring-stage-store';
import {
    analysisV2CandidateBundleId,
    analysisV2CandidateId,
    analysisV2PartnerSafetyBundleId,
    analysisV2ProfilePipelineConcurrency,
    createAnalysisV2AiScoringExecutorRegistry,
    isAnalysisV2PartialMediaCoverageAllowed,
    type AnalysisV2AiScoringExecutorDependencies,
    type AnalysisV2AiScoringStageStore,
    type AnalysisV2FinalScoreSnapshot,
    type AnalysisV2NarrativeSnapshot,
    type AnalysisV2PartnerSafetySnapshot,
    type AnalysisV2PrimaryJoinSnapshot,
    type AnalysisV2ProfileAiOutcome,
    type AnalysisV2ReverseLikeSnapshot,
    type AnalysisV2ScreeningSnapshot,
} from './v2-ai-scoring-executors';
import {
    calculateV2FinalScores,
    calculateV2PreliminaryScores,
    type V2FemaleCandidateEvidence,
} from './v2-candidate-scoring';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

describe('analysis V2 profile AI scheduler concurrency', () => {
    it('opens six candidate pipelines only for the exact persisted scheduler-v1 policy', () => {
        expect(analysisV2ProfilePipelineConcurrency(
            'ai-stage-policy-v2.8',
            'scheduler-v1',
        )).toBe(6);
        expect(analysisV2ProfilePipelineConcurrency(
            AI_STAGE_POLICY_V29_VERSION,
            'scheduler-v1',
        )).toBe(6);
        expect(analysisV2ProfilePipelineConcurrency(
            'ai-stage-policy-v2.8',
            'legacy',
        )).toBe(4);
        expect(analysisV2ProfilePipelineConcurrency(
            AI_STAGE_POLICY_VERSION,
            'scheduler-v1',
        )).toBe(4);
        expect(analysisV2ProfilePipelineConcurrency(
            'ai-stage-policy-v2.8',
            'scheduler-v1',
            2,
        )).toBe(2);
    });
});

const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';
const CLAIM_TOKEN = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow
const RESERVATION_TOKEN = '323e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow

function digest(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function resultManifest(
    jobKey: string,
    itemCount: number,
    rowCount = itemCount
): AnalysisV2ResultCheckpointManifest {
    return {
        requestId: REQUEST_ID,
        jobKey,
        batch: jobKey.includes(':batch:') ? 0 : null,
        itemCount,
        rowCount,
        resultHash: digest(`${jobKey}:${itemCount}:${rowCount}`),
    };
}

function state(overrides: Partial<AnalysisV2DagState> = {}): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: digest('request'),
        planId: 'basic',
        planSnapshotHash: digest('plan'),
        girlfriendExclusion: { decisionHash: digest('exclude'), excludedCount: 1 },
        relationships: {
            revision: 1,
            resultHash: digest('relationships'),
            detectedMutualCount: 3,
            publicCount: 3,
            privateCount: 0,
            detailedSelectedPublicCount: 3,
            notScreenedPublicCount: 0,
            profileBatches: [{ batch: 0, itemCount: 3, inputHash: digest('profile-topology') }],
            privateNameBatches: [],
        },
        profileFetchBatches: [{
            batch: 0,
            itemCount: 3,
            producerInputHash: digest('profile-producer'),
            revision: 1,
            resultHash: digest('profile-result'),
        }],
        ...overrides,
    };
}

function context<S extends AnalysisV2StageId>(
    stage: S,
    options: {
        jobKey?: string;
        batch?: number | null;
        state?: AnalysisV2DagState;
        reportActiveProfile?: (
            username: string,
            preview?: AnalysisV2ProgressCandidateMediaPreview
        ) => Promise<void>;
        aiStagePolicyVersion?: string;
        riskPolicyVersion?: 'risk-policy-v2.3' | 'risk-policy-v2.4';
    } = {}
): AnalysisV2StageExecutorContext<S> {
    const jobKey = options.jobKey ?? `test:${stage}`;
    const batch = options.batch === undefined ? null : options.batch;
    const inputHash = digest(`${jobKey}:input`);
    return {
        stage,
        claim: {
            requestId: REQUEST_ID,
            jobKey,
            track: stage,
            kind: 'test',
            batch,
            inputHash,
            generation: 1,
            reservationToken: RESERVATION_TOKEN,
            claimToken: CLAIM_TOKEN,
            attemptCount: 1,
        },
        job: {
            jobKey,
            track: stage,
            kind: 'test',
            batch,
            inputHash,
            requiredJobKeys: [],
        },
        state: options.state ?? state(),
        aiStagePolicyVersion: options.aiStagePolicyVersion ?? AI_STAGE_POLICY_VERSION,
        riskPolicyVersion: options.riskPolicyVersion ?? 'risk-policy-v2.4',
        ...(options.reportActiveProfile
            ? { reportActiveProfile: options.reportActiveProfile }
            : {}),
    };
}

function profile(username: string, options: {
    fullName?: string;
    bio?: string;
    postCount?: number;
} = {}): AnalysisV2CheckpointProfile {
    const postCount = options.postCount ?? 2;
    return {
        username,
        fullName: options.fullName ?? `${username} name`,
        bio: options.bio ?? '공개 프로필 소개',
        profilePicUrl: `https://cdninstagram.com/${username}/profile.jpg`,
        followersCount: 100,
        followingCount: 100,
        postsCount: postCount,
        isPrivate: false,
        isVerified: false,
        latestPosts: Array.from({ length: postCount }, (_, index) => ({
            id: `${username}-post-${index}`,
            shortCode: `${username.replaceAll('.', '_')}${index}`,
            caption: index === 0 ? '첫 게시물 캡션' : '일상 기록',
            imageUrl: `https://cdninstagram.com/${username}/post-${index}.jpg`,
            type: 'image' as const,
            likesCount: 0,
            commentsCount: 0,
            timestamp: new Date(Date.UTC(2026, 6, 10 - index)).toISOString(),
            taggedUsers: [],
            mentionedUsers: [],
        })),
    };
}

function triage(
    mediaIds: readonly string[],
    gender: 'female' | 'male' | 'unknown' = 'unknown'
): GenderTriageResult {
    const excluded = gender === 'male';
    return {
        assessment: {
            inferredGender: gender,
            confidence: excluded ? 'high' : 'low',
            ownerConsistency: excluded ? 'same_person' : 'multiple_or_unclear',
            evidenceSelectionIds: mediaIds.slice(0, 1),
        },
        routingDecision: excluded
            ? 'exclude_high_confidence_male'
            : 'route_to_feature_analysis',
        routingReason: excluded
            ? 'high_confidence_same_owner_male'
            : 'conserve_female_recall',
        analyzedSelectionIds: mediaIds.slice(0, 5),
    };
}

function feature(
    mediaIds: readonly string[],
    decision: FeatureAnalysisResult['finalGenderDecision'] = 'verified_female',
    options: {
        business?: boolean;
        strongPartner?: boolean;
        weakPartner?: boolean;
        grade?: number;
    } = {}
): FeatureAnalysisResult {
    return {
        features: {
            gender: decision === 'verified_non_female' ? 'male' : 'female',
            genderConfidence: 'high',
            ownerConsistency: 'same_person',
            appearanceGrade: options.grade ?? 4,
            exposureScore: 2,
            businessClassification: options.business ? 'business' : 'personal',
            businessConfidence: 'high',
            accountContext: options.business ? 'individual_creator' : 'personal',
            marriageEvidence: options.strongPartner
                ? 'strong'
                : options.weakPartner ? 'possible' : 'none',
            partnerEvidence: 'none',
            partnerExclusionContext: 'none',
            evidenceSelectionIds: {
                gender: mediaIds.slice(0, 1),
                appearance: mediaIds.slice(0, 1),
                exposure: mediaIds.slice(0, 1),
                business: options.business ? mediaIds.slice(0, 1) : [],
                accountContext: mediaIds.slice(0, 1),
                marriagePartner: options.strongPartner || options.weakPartner
                    ? mediaIds.slice(0, 1)
                    : [],
            },
            oneLineOverview:
                '차분한 일상을 야무지게 기록해 두어서, 판독관은 오히려 숨은 취향부터 궁금해집니다.',
        },
        finalGenderDecision: decision,
        analyzedSelectionIds: [...mediaIds],
    };
}

function partnerResult(strong = false, weak = false): PartnerSafetyResult {
    return {
        assessment: null,
        hasWeakNonExcludedMalePairEvidence: weak && !strong,
        hasStrongPartnerEvidence: strong,
        strongEvidenceBasis: strong ? 'feature' : 'none',
        weakAdjustmentStatus: weak && !strong ? 'applied_policy_v2_2' : 'not_applicable',
        source: 'feature_only',
        analyzedContactSheetSelectionId: null,
    };
}

interface MemoryState {
    outcomes: AnalysisV2ProfileAiOutcome[];
    resolverPatches: AnalysisV2RevenueResolverOutcomePatch[];
    primary: AnalysisV2PrimaryJoinSnapshot | null;
    screening: AnalysisV2ScreeningSnapshot | null;
    reverse: AnalysisV2ReverseLikeSnapshot | null;
    partner: AnalysisV2PartnerSafetySnapshot | null;
    final: AnalysisV2FinalScoreSnapshot | null;
    narrative: AnalysisV2NarrativeSnapshot | null;
}

function memoryStageStore(memory: MemoryState): AnalysisV2AiScoringStageStore {
    return {
        async checkpointProfileAiBatch(input) {
            memory.outcomes = [...input.outcomes];
            return { revision: 1, resultHash: digest('profile-ai'), itemCount: input.outcomes.length };
        },
        async loadProfileAiOutcomes() { return memory.outcomes; },
        async checkpointPrimaryJoin(input) {
            memory.primary = { revision: 1, resultHash: digest('primary'), candidates: input.candidates };
            return memory.primary;
        },
        async loadPrimaryJoin() { return memory.primary; },
        async checkpointScreening(input) {
            memory.screening = {
                revision: 1,
                resultHash: digest('screening'),
                riskPolicyVersion: input.riskPolicyVersion,
                shortlistHash: input.shortlistHash,
                candidates: input.candidates,
            };
            return memory.screening;
        },
        async loadScreening() { return memory.screening; },
        async checkpointReverseLikes(input) {
            memory.reverse = { revision: 1, resultHash: digest('reverse'), rows: input.rows };
            return memory.reverse;
        },
        async loadReverseLikes() { return memory.reverse; },
        async checkpointPartnerSafety(input) {
            memory.partner = { revision: 1, resultHash: digest('partner'), rows: input.rows };
            return memory.partner;
        },
        async loadPartnerSafety() { return memory.partner; },
        async checkpointFinalScores(input) {
            memory.final = {
                revision: 1,
                resultHash: digest('final'),
                riskPolicyVersion: input.riskPolicyVersion,
                candidates: input.candidates,
                narrativeCandidateIds: input.narrativeCandidateIds,
                narrativeBatchHash: input.narrativeBatchHash,
            };
            return memory.final;
        },
        async loadFinalScores() { return memory.final; },
        async checkpointNarratives(input) {
            memory.narrative = {
                revision: 1,
                resultHash: digest('narrative'),
                rows: input.rows,
            };
            return memory.narrative;
        },
        async purgeTerminal() { return 0; },
    };
}

function relationshipSnapshot(input: {
    excluded?: string | null;
    usernames?: readonly string[];
} = {}): AnalysisV2RelationshipStagingSnapshot {
    const usernames = input.usernames ?? ['man', 'woman.one', 'woman.two'];
    const rows = usernames.map((username, index) => ({
        username,
        isPrivate: false,
        isVerified: false,
        fullName: `${username} name`,
        profilePicUrl: `https://cdninstagram.com/${username}.jpg`,
        mutualOrdinal: index + 1,
        followingOrdinal: index + 1,
        detailedOrdinal: index + 1,
    }));
    const side = {
        side: 'followers' as const,
        revision: 1,
        declaredCount: rows.length,
        collectedCount: rows.length,
        coverageBps: 10_000,
        sourceStatus: 'collected' as const,
        inputHash: digest('side-input'),
        resultHash: digest('side-result'),
        provider: 'apify' as const,
        providerRunId: 'provider01',
        providerOperationKey: 'provider-op',
        providerCredentialSlot: 'primary' as const,
        rows,
    };
    return {
        requestId: REQUEST_ID,
        jobKey: 'track:relationships:collect',
        excludedUsername: input.excluded === undefined ? 'girlfriend' : input.excluded,
        detailedMutualLimit: 300,
        manifest: {
            revision: 1,
            resultHash: digest('relationships'),
            exclusionDecisionHash: digest('exclude'),
            followersResultHash: digest('followers'),
            followingResultHash: digest('following'),
            mutualCount: rows.length,
            publicCount: rows.length,
            privateCount: 0,
            detailedPublicCount: rows.length,
            unscreenedPublicCount: 0,
        },
        followers: side,
        following: { ...side, side: 'following' },
        mutualRows: rows,
        detailedPublicUsernames: [...usernames],
        privateMutualUsernames: [],
        privateMutualRows: [],
    };
}

function targetEvidence(
    rows: AnalysisV2TargetEvidenceStagingSnapshot['rows'] = []
): AnalysisV2TargetEvidenceStagingSnapshot {
    const source = {
        status: 'collected' as const,
        inputHash: digest('target-source'),
        provider: 'apify' as const,
        providerRunId: 'provider02',
        providerOperationKey: 'provider-op-2',
        providerCredentialSlot: 'primary' as const,
        coverage: [{ postId: 'target-post', declaredCount: 1, returnedCount: 1, requestedLimit: 15 }],
    };
    return {
        requestId: REQUEST_ID,
        jobKey: 'track:target-evidence:collect',
        targetUsername: 'target.account',
        excludedUsername: 'girlfriend',
        manifest: {
            revision: 1,
            resultHash: digest('target-evidence'),
            inputHash: digest('target-input'),
            interactorCount: new Set(rows.map(row => row.actorUsername)).size,
            likerCount: rows.filter(row => row.signal === 'target_post_like').length,
            commentCount: rows.filter(row => row.signal === 'target_post_comment').length,
        },
        likerSource: source,
        commentSource: source,
        rows,
    };
}

function memory(): MemoryState {
    return {
        outcomes: [], resolverPatches: [], primary: null, screening: null, reverse: null,
        partner: null, final: null, narrative: null,
    };
}

function dependencies(
    memoryState: MemoryState,
    overrides: Partial<AnalysisV2AiScoringExecutorDependencies> = {}
): AnalysisV2AiScoringExecutorDependencies {
    const checkpoint = (jobKey: string, count: number) => resultManifest(jobKey, count);
    return {
        profileBatches: {
            loadExactBatch: vi.fn(async () => null),
        },
        evidence: {
            loadRelationships: vi.fn(async () => relationshipSnapshot()),
            loadTargetEvidence: vi.fn(async () => targetEvidence()),
        },
        targetProfiles: {
            loadTargetProfile: vi.fn(async () => profile('target.account')),
        },
        stageStore: memoryStageStore(memoryState),
        resultStore: {
            checkpointFeatureBatch: vi.fn(async input => checkpoint(input.jobKey, input.analyzedCount)),
            checkpointPreliminaryScores: vi.fn(async input => checkpoint(input.jobKey, input.rows.length)),
            checkpointReverseLikes: vi.fn(async input => checkpoint(input.jobKey, input.rows.length)),
            checkpointPartnerSafety: vi.fn(async input => checkpoint(input.jobKey, input.rows.length)),
            checkpointScores: vi.fn(async input => checkpoint(input.jobKey, input.rows.length)),
            checkpointPrivateNames: vi.fn(async input => checkpoint(input.jobKey, input.rows.length)),
            checkpointNarratives: vi.fn(async input => checkpoint(input.jobKey, input.rows.length)),
            checkpointRevenueResolverOutcomes: vi.fn(async input => {
                const byCandidate = new Map(memoryState.resolverPatches.map(row => [
                    row.candidateId,
                    row,
                ]));
                for (const row of input.rows) byCandidate.set(row.candidateId, row);
                memoryState.resolverPatches = [...byCandidate.values()];
                return memoryState.resolverPatches;
            }),
            loadRevenueResolverOutcomes: vi.fn(async () => memoryState.resolverPatches),
            loadStageSnapshot: vi.fn(async () => null),
            finalize: vi.fn(async () => ({
                finalized: true,
                requestStatus: 'completed' as const,
                summary: {
                    targetInstagramId: 'target.account',
                    targetFullName: null,
                    targetProfileImage: null,
                    planId: 'basic' as const,
                    followers: {
                        declared: 0, collected: 0, coverageRatio: 1,
                        meetsCoverageGate: true, exactCountMatch: true,
                    },
                    following: {
                        declared: 0, collected: 0, coverageRatio: 1,
                        meetsCoverageGate: true, exactCountMatch: true,
                    },
                    detectedMutuals: 0,
                    publicMutuals: 0,
                    screenedMutuals: 0,
                    genderStats: { male: 0, female: 0, unknown: 0 },
                    successfullyScreenedMutuals: 0,
                    fetchUnavailableMutuals: 0,
                    mediaUnavailableMutuals: 0,
                    analysisUnavailableMutuals: 0,
                    notScreenedMutuals: 0,
                    privateMutuals: 0,
                    exclusionApplied: false,
                    scorePolicyVersion: 'risk-policy-v2.4' as const,
                },
            })),
        },
        mediaStore: {
            persist: vi.fn(),
            load: vi.fn(),
            persistBundle: vi.fn(async input => ({
                requestId: input.requestId,
                artifactKey: digest(input.bundleId),
                artifactKind: 'media_bundle' as const,
                contentSha256: digest('bundle'),
                contentType: 'application/octet-stream' as const,
                objectName: 'object',
                objectGeneration: '1',
                byteSize: 4,
            })),
            loadBundle: vi.fn(async () => null),
            cleanupTerminal: vi.fn(async () => ({ claimed: 0, deleted: 0, failed: 0 })),
        },
        sourceMediaArchive: {
            persistBundle: vi.fn(async () => undefined),
            loadBundle: vi.fn(async () => null),
        },
        ai: {
            gender: vi.fn(async (input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]) => ({
                result: triage(input.media.map(row => row.selectionId)),
                operationKey: `gender-triage:${digest('gender')}`,
                resultHash: digest('gender-result'),
                source: 'checkpoint' as const,
            })),
            startGenderResolution: vi.fn(() => ({
                operationKey: `gender-resolution:${digest('resolver')}`,
                completion: Promise.resolve(),
                peek: () => ({ status: 'terminal_unavailable' as const }),
                cutoff: vi.fn().mockResolvedValue(undefined),
            })),
            features: vi.fn(async (input: Parameters<AnalysisV2AiStageRuntime['features']>[0]) => ({
                result: feature(input.media.map(row => row.selectionId)),
                operationKey: `feature-analysis:${digest('feature')}`,
                resultHash: digest('feature-result'),
                source: 'checkpoint' as const,
            })),
            privateNames: vi.fn(async () => ({
                results: [], operationKey: `private-account-name:${digest('private')}`,
                resultHash: digest('private-result'), source: 'checkpoint' as const,
            })),
            partnerSafety: vi.fn(async input => ({
                result: partnerResult(
                    input.feature.features.marriageEvidence === 'strong'
                        || input.feature.features.partnerEvidence === 'strong',
                    input.feature.features.marriageEvidence === 'possible'
                        || input.feature.features.partnerEvidence === 'weak'
                ), operationKey: '', resultHash: null,
                source: 'feature_only' as const,
            })),
            narrative: vi.fn(async (input: Parameters<AnalysisV2AiStageRuntime['narrative']>[0]) => {
                void input;
                return ({ result: {
                    lines: ['차분한 일상을 모아둔 계정이에요.', '실제 댓글 흔적은 꽤 눈에 띄네요.'] as [string, string],
                    evidenceRefs: [['profile:bio'], ['evidence:comment']] as [string[], string[]],
                    source: 'gemini' as const,
                },
                operationKey: `high-risk-narrative:${digest('narrative')}`,
                resultHash: digest('narrative-result'),
                source: 'checkpoint' as const,
                });
            }),
        },
        reverseLikes: {
            collect: vi.fn(async () => ({ operationKey: 'provider-op', results: [] })),
        },
        normalizeMedia: vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
        createContactSheet: vi.fn(),
        ...overrides,
    };
}

function validatedProfileStores() {
    const resultRpc = vi.fn<(
        name: string,
        params: Record<string, unknown>
    ) => Promise<{
        data: AnalysisV2ResultCheckpointManifest;
        error: null;
    }>>(async () => ({
        data: resultManifest('track:profile-ai:batch:0', 1),
        error: null,
    }));
    const stageRpc = vi.fn(async (
        _name: string,
        params: Record<string, unknown>,
    ) => ({
        data: {
            stageKind: params.p_stage_kind,
            batch: params.p_batch,
            revision: 1,
            resultHash: digest('validated-profile-stage'),
            itemCount: params.p_item_count,
            payload: params.p_payload,
        },
        error: null,
    }));
    return {
        resultRpc,
        resultStore: createSupabaseAnalysisV2ResultStore({
            rpc: resultRpc,
        } as AnalysisV2ResultSupabaseClient),
        stageRpc,
        stageStore: createSupabaseAnalysisV2AiScoringStageStore({
            rpc: stageRpc,
        } as AnalysisV2AiScoringStageSupabaseClient),
    };
}

function verifiedOutcome(
    username: string,
    options: { strongPartner?: boolean; weakPartner?: boolean; business?: boolean } = {}
): AnalysisV2ProfileAiOutcome {
    const account = profile(username);
    const ids = [`profile:${username}`];
    return {
        candidateId: analysisV2CandidateId(username),
        instagramId: username,
        status: 'verified_female',
        unavailableReason: null,
        profile: account,
        triage: triage(ids, 'female'),
        feature: feature(ids, 'verified_female', options),
        normalizedSelectionIds: ids,
        mediaCoverage: {
            selectedCount: ids.length,
            normalizedCount: ids.length,
            failures: [],
        },
        captions: [],
        genderOperationKey: `gender-triage:${digest(`gender:${username}`)}`,
        genderResultHash: digest(`gender-result:${username}`),
        featureOperationKey: `feature-analysis:${digest(`feature:${username}`)}`,
        featureResultHash: digest(`feature-result:${username}`),
        baselineClassification: 'verified_female',
        classificationSource: 'feature',
        genderResolutionStatus: 'disabled',
        genderResolutionOperationKey: null,
        genderResolutionResultHash: null,
        mediaBundlePersisted: true,
    };
}

function completeCarouselOutcome(username: string): AnalysisV2ProfileAiOutcome {
    const candidate = verifiedOutcome(username);
    candidate.profile = {
        ...candidate.profile!,
        postsCount: 1,
        latestPosts: [{
            id: 'carousel-post',
            shortCode: 'carouselpost',
            caption: 'parent carousel caption',
            imageUrl: 'https://cdninstagram.com/carousel/cover.jpg',
            type: 'carousel',
            mediaItems: Array.from({ length: 20 }, (_, index) => ({
                id: `frame-${index + 1}`,
                type: 'image' as const,
                caption: `slide ${index + 1} ${String(index % 10).repeat(180)}`,
                imageUrl: `https://cdninstagram.com/carousel/frame-${index + 1}.jpg`,
            })),
            declaredMediaCount: 20,
            childrenComplete: true,
            likesCount: 0,
            commentsCount: 0,
            timestamp: new Date(Date.UTC(2026, 6, 10)).toISOString(),
            taggedUsers: [],
            mentionedUsers: [],
        }],
    };
    return candidate;
}

describe('V2 AI and scoring executors', () => {
    it('allows at most twenty percent partial media only when one image remains', () => {
        const allowed = (selectedCount: number, failureCount: number) => (
            isAnalysisV2PartialMediaCoverageAllowed({
                selectedCount,
                normalizedCount: selectedCount - failureCount,
                failures: Array.from({ length: failureCount }, (_, index) => ({
                    selectionId: `failed:${index}`,
                    reason: 'source_missing' as const,
                    disposition: 'permanent' as const,
                })),
            })
        );
        expect(allowed(5, 1)).toBe(true);
        expect(allowed(10, 2)).toBe(true);
        expect(allowed(11, 2)).toBe(true);
        expect(allowed(5, 2)).toBe(false);
        expect(allowed(10, 3)).toBe(false);
        expect(allowed(11, 3)).toBe(false);
        expect(allowed(1, 1)).toBe(false);
    });

    it('excludes only high-confidence same-owner men, routes unknowns, and persists every terminal result', async () => {
        const memoryState = memory();
        const male = profile('male.account');
        const unknown = profile('unknown.account');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['male.account', 'unknown.account', 'missing.account'],
                    results: [
                        { username: 'male.account', status: 'success' as const, profile: male },
                        { username: 'unknown.account', status: 'success' as const, profile: unknown },
                        { username: 'missing.account', status: 'unavailable' as const },
                    ],
                })),
            },
        });
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]
        ) => {
            const isMale = input.media.some(row => row.selectionId.includes('male.account'));
            return {
                result: triage(input.media.map(row => row.selectionId), isMale ? 'male' : 'unknown'),
                operationKey: `gender-triage:${digest(isMale ? 'male' : 'unknown')}`,
                resultHash: digest(isMale ? 'male-result' : 'unknown-result'),
                source: 'checkpoint' as const,
            };
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);
        const output = await registry.profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
        }));

        expect(output.checkpoint.manifest.itemCount).toBe(3);
        expect(memoryState.outcomes.map(row => row.status)).toEqual([
            'verified_non_female', 'verified_female', 'fetch_unavailable',
        ]);
        expect(memoryState.outcomes.map(row => row.unavailableReason)).toEqual([
            null, null, 'profile_fetch',
        ]);
        expect(deps.ai.features).toHaveBeenCalledTimes(1);
        expect(deps.sourceMediaArchive.persistBundle).toHaveBeenCalledTimes(2);
        expect(deps.sourceMediaArchive.persistBundle).toHaveBeenCalledWith(
            expect.objectContaining({
                archiveId: analysisV2SourceMediaArchiveId({
                    candidateId: analysisV2CandidateId('male.account'),
                    stage: 'triage',
                }),
            })
        );
        expect(deps.mediaStore.persistBundle).toHaveBeenCalledTimes(1);
        expect(deps.mediaStore.persistBundle).toHaveBeenCalledWith(expect.objectContaining({
            bundleId: analysisV2CandidateBundleId(analysisV2CandidateId('unknown.account')),
        }));
        const featureCheckpoint = vi.mocked(deps.resultStore.checkpointFeatureBatch);
        expect(featureCheckpoint.mock.calls[0][0].rows.map(row => row.classification)).toEqual([
            'verified_non_female', 'verified_female', 'unavailable',
        ]);
    });

    it('fails closed before checkpointing when a required source-media archive write fails', async () => {
        const memoryState = memory();
        const account = profile('archive.failure');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
            sourceMediaArchive: {
                persistBundle: vi.fn(async () => {
                    throw new Error('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR');
                }),
                loadBundle: vi.fn(async () => null),
            },
        });

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                state: state({
                    relationships: {
                        ...state().relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('profile-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('profile-producer'),
                        revision: 1,
                        resultHash: digest('profile-result'),
                    }],
                }),
            })
        )).rejects.toThrow('ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR');
        expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
        expect(memoryState.outcomes).toEqual([]);
    });

    it('uses v2.8 profile evidence and records privacy-safe media/official provenance without extra normalization', async () => {
        const memoryState = memory();
        const account = profile('blackcherry.club', {
            fullName: 'Black Cherry Club',
            bio: 'Official band · new single out now',
        });
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{ username: account.username, status: 'success' as const, profile: account }],
                })),
            },
        });
        deps.ai.features = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['features']>[0]
        ) => {
            const result = feature(input.media.map(row => row.selectionId));
            result.features.accountContext = 'official_group_or_brand';
            return {
                result,
                operationKey: `feature-analysis:${digest('official-feature')}`,
                resultHash: digest('official-feature-result'),
                source: 'checkpoint' as const,
            };
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await registry.profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
            aiStagePolicyVersion: 'ai-stage-policy-v2.8',
            state: state({
                relationships: {
                    ...state().relationships!,
                    profileBatches: [{ batch: 0, itemCount: 1, inputHash: digest('profile-topology') }],
                },
                profileFetchBatches: [{
                    batch: 0,
                    itemCount: 1,
                    producerInputHash: digest('profile-producer'),
                    revision: 1,
                    resultHash: digest('profile-result'),
                }],
            }),
        }));

        expect(deps.ai.gender).toHaveBeenCalledWith(expect.objectContaining({
            accountProfile: { fullName: 'Black Cherry Club', hasProfileImage: true },
        }), expect.any(Object));
        expect(deps.ai.features).toHaveBeenCalledWith(expect.objectContaining({
            accountProfile: { fullName: 'Black Cherry Club', hasProfileImage: true },
        }), expect.any(Object));
        expect(deps.normalizeMedia).toHaveBeenCalledTimes(3);
        expect(new Set(vi.mocked(deps.normalizeMedia).mock.calls.map(([row]) => row.selectionId)).size)
            .toBe(3);
        expect(memoryState.outcomes[0]).toMatchObject({
            aiStagePolicyVersion: 'ai-stage-policy-v2.8',
            inputQualityPolicy: 'input-quality-v2.8',
            accountContextOverride: 'official_group_or_brand',
            officialScreeningStatus: 'corroborated_official',
            officialExclusionReason: 'model_group_context_plus_profile_signals',
            mediaSelectionProvenance: {
                triageSelectedCount: 3,
                featureSelectedCount: 3,
                selectedKinds: { profile: 1, postRepresentative: 2, carouselContext: 0 },
            },
        });
    });

    it.each([
        AI_STAGE_POLICY_V29_VERSION,
        AI_STAGE_POLICY_V210_VERSION,
    ] as const)(
        '%s skips feature and resolver for official and uncertain accounts',
        async aiStagePolicyVersion => {
        const memoryState = memory();
        const male = profile('male.account');
        const blackCherry = profile('blackcherry.club', {
            fullName: 'Black Cherry Club',
            bio: 'Official band · new single out now',
        });
        // "club" alone is adversarial text, not a source-bound official signal.
        const personalClub = profile('alice.club', {
            fullName: 'Alice Club',
            bio: 'photographer and personal diary',
        });
        const unknown = profile('unknown.account');
        const profiles = [male, blackCherry, personalClub, unknown];
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: profiles.map(item => item.username),
                    results: profiles.map(item => ({
                        username: item.username,
                        status: 'success' as const,
                        profile: item,
                    })),
                })),
            },
        });
        const confirmed = (
            mediaIds: readonly string[],
            accountContext: NonNullable<GenderTriageResult['v29AccountContext']>,
        ): GenderTriageResult => ({
            assessment: {
                inferredGender: 'female', confidence: 'high', ownerConsistency: 'same_person',
                evidenceSelectionIds: mediaIds.slice(0, 2),
            },
            routingDecision: 'route_to_feature_analysis',
            routingReason: 'conserve_female_recall',
            analyzedSelectionIds: mediaIds.slice(0, 5),
            v29AccountContext: accountContext,
        });
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]
        ) => {
            const mediaIds = input.media.map(item => item.selectionId);
            if (mediaIds.some(id => id.includes('male.account'))) {
                return {
                    result: triage(mediaIds, 'male'),
                    operationKey: `gender-triage:${digest('v29-male')}`,
                    resultHash: digest('v29-male'), source: 'checkpoint' as const,
                };
            }
            const accountContext = mediaIds.some(id => id.includes('blackcherry.club'))
                ? 'official_group_or_brand' as const
                : mediaIds.some(id => id.includes('alice.club'))
                    ? 'personal' as const
                    : 'uncertain' as const;
            return {
                result: accountContext === 'uncertain'
                    ? { ...triage(mediaIds), v29AccountContext: accountContext }
                    : confirmed(mediaIds, accountContext),
                operationKey: `gender-triage:${digest(`v29:${accountContext}:${mediaIds[0]}`)}`,
                resultHash: digest(`v29:${accountContext}:${mediaIds[0]}`),
                source: 'checkpoint' as const,
            };
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);
        await registry.profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
            aiStagePolicyVersion,
            state: state({
                relationships: {
                    ...state().relationships!,
                    profileBatches: [{ batch: 0, itemCount: profiles.length, inputHash: digest('v29-topology') }],
                },
                profileFetchBatches: [{
                    batch: 0, itemCount: profiles.length,
                    producerInputHash: digest('v29-producer'), revision: 1,
                    resultHash: digest('v29-profile-result'),
                }],
            }),
        }));

        expect(deps.ai.features).toHaveBeenCalledTimes(1);
        expect(deps.ai.startGenderResolution).not.toHaveBeenCalled();
        expect(vi.mocked(deps.ai.features).mock.calls[0]![0].accountProfile).toEqual({
            fullName: 'Alice Club', hasProfileImage: true, bio: 'photographer and personal diary',
        });
        expect(memoryState.outcomes.map(outcome => outcome.status)).toEqual([
            'verified_non_female', 'unresolved', 'verified_female', 'unresolved',
        ]);
        expect(memoryState.outcomes[1]).toMatchObject({
            v29FeatureAdmission: 'nonpersonal_or_official', feature: null,
        });
        expect(memoryState.outcomes[3]).toMatchObject({
            v29FeatureAdmission: 'unsupported_unknown', feature: null,
        });
        const publicRows = vi.mocked(deps.resultStore.checkpointFeatureBatch)
            .mock.calls[0]![0].rows;
        expect(publicRows[1]).toMatchObject({
            classification: 'unresolved',
            featureOperationKey: null,
            featureResultHash: null,
            feature: null,
            preFeaturePolicyVersion: aiStagePolicyVersion,
            preFeatureAdmission: 'nonpersonal_or_official',
        });
        expect(publicRows[3]).toMatchObject({
            classification: 'unresolved',
            featureOperationKey: null,
            featureResultHash: null,
            feature: null,
            preFeaturePolicyVersion: aiStagePolicyVersion,
            preFeatureAdmission: 'unsupported_unknown',
        });
    });

    it('starts feature and eligible resolver in the same turn and applies only a ready resolver', async () => {
        const memoryState = memory();
        const account = profile('resolver.ready');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
        });
        let releaseFeature!: (value: Awaited<
            ReturnType<AnalysisV2AiStageRuntime['features']>
        >) => void;
        deps.ai.features = vi.fn<
            AnalysisV2AiStageRuntime['features']
        >(() => new Promise(resolve => {
            releaseFeature = resolve;
        }));
        let resolverState: ReturnType<
            ReturnType<AnalysisV2AiStageRuntime['startGenderResolution']>['peek']
        > = { status: 'pending' };
        const resolverOperationKey = `gender-resolution:${digest('ready-resolver')}`;
        const resolverResultHash = digest('ready-resolver-result');
        const cutoff = vi.fn().mockResolvedValue(undefined);
        deps.ai.startGenderResolution = vi.fn(() => ({
            operationKey: resolverOperationKey,
            completion: Promise.resolve(),
            peek: () => resolverState,
            cutoff,
        }));
        const base = state();
        const execution = createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('resolver-ready-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('resolver-ready-producer'),
                        revision: 1,
                        resultHash: digest('resolver-ready-result'),
                    }],
                }),
            }),
        );

        await vi.waitFor(() => {
            expect(deps.ai.features).toHaveBeenCalledOnce();
            expect(deps.ai.startGenderResolution).toHaveBeenCalledOnce();
        });
        expect(vi.mocked(deps.ai.startGenderResolution).mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(deps.ai.features).mock.invocationCallOrder[0]!);
        const featureInput = vi.mocked(deps.ai.features).mock.calls[0]![0];
        resolverState = {
            status: 'ready',
            value: {
                result: {
                    assessment: {
                        inferredGender: 'female',
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: featureInput.media
                            .slice(0, 2)
                            .map((row: { selectionId: string }) => row.selectionId),
                    },
                    analyzedSelectionIds: featureInput.media
                        .slice(0, 5)
                        .map((row: { selectionId: string }) => row.selectionId),
                },
                operationKey: resolverOperationKey,
                resultHash: resolverResultHash,
                source: 'checkpoint',
            },
        };
        releaseFeature({
            result: feature(
                featureInput.media.map(row => row.selectionId),
                'unresolved',
            ),
            operationKey: `feature-analysis:${digest('resolver-ready-feature')}`,
            resultHash: digest('resolver-ready-feature-result'),
            source: 'checkpoint',
        });

        await execution;

        expect(memoryState.outcomes[0]).toMatchObject({
            status: 'verified_female',
            baselineClassification: 'unresolved',
            classificationSource: 'gender_resolution',
            genderResolutionStatus: 'ready_applied',
            genderResolutionOperationKey: resolverOperationKey,
            genderResolutionResultHash: resolverResultHash,
        });
        expect(cutoff).not.toHaveBeenCalled();
    });

    it.each([
        [AI_STAGE_POLICY_V29_VERSION, 'personal', 'female'],
        [AI_STAGE_POLICY_V29_VERSION, 'personal', 'male'],
        [AI_STAGE_POLICY_V29_VERSION, 'individual_creator', 'female'],
        [AI_STAGE_POLICY_V29_VERSION, 'individual_creator', 'male'],
        [AI_STAGE_POLICY_V210_VERSION, 'personal', 'female'],
        [AI_STAGE_POLICY_V210_VERSION, 'personal', 'male'],
        [AI_STAGE_POLICY_V210_VERSION, 'individual_creator', 'female'],
        [AI_STAGE_POLICY_V210_VERSION, 'individual_creator', 'male'],
    ] as const)(
        'runs feature and resolver concurrently for a non-feature-admitted %s %s %s result',
        async (aiStagePolicyVersion, accountContext, resolverGender) => {
        const memoryState = memory();
        const account = profile(
            `resolver.${aiStagePolicyVersion.endsWith('2.9') ? 'v29' : 'v210'}`
            + `.${accountContext === 'personal' ? 'p' : 'c'}.${resolverGender[0]}`
        );
        const validated = validatedProfileStores();
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
            resultStore: validated.resultStore,
            stageStore: validated.stageStore,
        });
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0],
        ) => {
            const mediaIds = input.media.map(row => row.selectionId);
            return {
                result: {
                    ...triage(mediaIds),
                    v29AccountContext: accountContext,
                },
                operationKey: `gender-triage:${digest('resolver-personal-triage')}`,
                resultHash: digest('resolver-personal-triage'),
                source: 'checkpoint' as const,
            };
        });
        let releaseFeature!: (value: Awaited<
            ReturnType<AnalysisV2AiStageRuntime['features']>
        >) => void;
        deps.ai.features = vi.fn<AnalysisV2AiStageRuntime['features']>(
            () => new Promise(resolve => {
                releaseFeature = resolve;
            })
        );
        const resolverOperationKey =
            `gender-resolution:${digest(`resolver-personal-ready:${resolverGender}`)}`;
        const resolverResultHash = digest(`resolver-personal-result:${resolverGender}`);
        type ResolverState = ReturnType<
            ReturnType<AnalysisV2AiStageRuntime['startGenderResolution']>['peek']
        >;
        let resolverState: ResolverState = { status: 'pending' };
        const cutoff = vi.fn(async () => {
            resolverState = { status: 'cutoff' };
        });
        deps.ai.startGenderResolution = vi.fn(() => ({
            operationKey: resolverOperationKey,
            completion: Promise.resolve(),
            peek: () => resolverState,
            cutoff,
        }));
        const base = state();

        const execution = createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('resolver-personal-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('resolver-personal-producer'),
                        revision: 1,
                        resultHash: digest('resolver-personal-profile-result'),
                    }],
                }),
            }),
        );
        void execution.catch(() => undefined);

        await vi.waitFor(() => {
            expect(deps.ai.startGenderResolution).toHaveBeenCalledOnce();
            expect(deps.ai.features).toHaveBeenCalledOnce();
        });
        expect(resolverState).toEqual({ status: 'pending' });
        expect(vi.mocked(deps.ai.startGenderResolution).mock.invocationCallOrder[0])
            .toBeLessThan(vi.mocked(deps.ai.features).mock.invocationCallOrder[0]!);
        const featureInput = vi.mocked(deps.ai.features).mock.calls[0]![0];
        resolverState = {
            status: 'ready',
            value: {
                result: {
                    assessment: {
                        inferredGender: resolverGender,
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: featureInput.media
                            .slice(0, 2)
                            .map(row => row.selectionId),
                    },
                    analyzedSelectionIds: featureInput.media
                        .slice(0, 5)
                        .map(row => row.selectionId),
                },
                operationKey: resolverOperationKey,
                resultHash: resolverResultHash,
                source: 'checkpoint',
            },
        };
        releaseFeature({
            result: feature(
                featureInput.media.map(row => row.selectionId),
                'unresolved',
            ),
            operationKey: `feature-analysis:${digest(`resolver-feature:${resolverGender}`)}`,
            resultHash: digest(`resolver-feature-result:${resolverGender}`),
            source: 'checkpoint',
        });

        await expect(execution).resolves.toBeDefined();

        const stagePayload = validated.stageRpc.mock.calls[0]![1].p_payload as {
            outcomes: AnalysisV2ProfileAiOutcome[];
        };
        const outcome = stagePayload.outcomes[0]!;
        expect(outcome).toMatchObject({
            status: resolverGender === 'female'
                ? 'verified_female'
                : 'verified_non_female',
            feature: expect.objectContaining({
                finalGenderDecision: 'unresolved',
            }),
            featureOperationKey: expect.stringMatching(/^feature-analysis:/),
            featureResultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
            baselineClassification: 'unresolved',
            classificationSource: 'gender_resolution',
            genderResolutionStatus: 'ready_applied',
            genderResolutionOperationKey: resolverOperationKey,
            genderResolutionResultHash: resolverResultHash,
            mediaBundlePersisted: resolverGender === 'female',
        });
        const resultRows = validated.resultRpc.mock.calls[0]![1]
            .p_rows as AnalysisV2ProfileClassificationRow[];
        expect(resultRows[0]).toMatchObject({
            classification: outcome.status,
            featureOperationKey: outcome.featureOperationKey,
            featureResultHash: outcome.featureResultHash,
            feature: resolverGender === 'female'
                ? expect.objectContaining({ appearanceGrade: 4 })
                : null,
        });
        // The initial V2.9/V2.10 admission remains useful in the internal
        // outcome, but this row completed feature analysis. It must not be
        // serialized as a triage-only pre-feature checkpoint.
        expect(resultRows[0]).not.toHaveProperty('preFeaturePolicyVersion');
        expect(resultRows[0]).not.toHaveProperty('preFeatureAdmission');
        expect(cutoff).not.toHaveBeenCalled();
    });

    it('keeps an early pending resolver alive until the profile batch barrier', async () => {
        const memoryState = memory();
        const usernames = ['resolver.early', 'feature.slow'];
        const accounts = usernames.map(username => profile(username));
        const deps = dependencies(memoryState, {
            profileAiConcurrency: 2,
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: usernames,
                    results: accounts.map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        let releaseSlowFeature!: (value: Awaited<
            ReturnType<AnalysisV2AiStageRuntime['features']>
        >) => void;
        deps.ai.features = vi.fn<AnalysisV2AiStageRuntime['features']>(async input => {
            const selectionIds = input.media.map(row => row.selectionId);
            if (selectionIds.some(id => id.includes('feature.slow'))) {
                return await new Promise(resolve => {
                    releaseSlowFeature = resolve;
                });
            }
            return {
                result: feature(selectionIds, 'unresolved'),
                operationKey: `feature-analysis:${digest('early-feature')}`,
                resultHash: digest('early-feature-result'),
                source: 'checkpoint' as const,
            };
        });
        type ResolverState = ReturnType<
            ReturnType<AnalysisV2AiStageRuntime['startGenderResolution']>['peek']
        >;
        const resolverStates = new Map<string, ResolverState>();
        const cutoffs = new Map<string, ReturnType<typeof vi.fn>>();
        deps.ai.startGenderResolution = vi.fn((
            input: Parameters<AnalysisV2AiStageRuntime['startGenderResolution']>[0]
        ) => {
            const username = input.media.some(row => row.selectionId.includes('resolver.early'))
                ? 'resolver.early'
                : 'feature.slow';
            const operationKey = `gender-resolution:${digest(username)}`;
            resolverStates.set(username, { status: 'pending' });
            const cutoff = vi.fn(async () => {
                resolverStates.set(username, { status: 'cutoff' });
            });
            cutoffs.set(username, cutoff);
            return {
                operationKey,
                completion: new Promise<void>(() => undefined),
                peek: () => resolverStates.get(username)!,
                cutoff,
            };
        });
        const base = state();
        const execution = createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 2,
                            inputHash: digest('resolver-barrier-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 2,
                        producerInputHash: digest('resolver-barrier-producer'),
                        revision: 1,
                        resultHash: digest('resolver-barrier-result'),
                    }],
                }),
            }),
        );

        await vi.waitFor(() => {
            expect(deps.ai.features).toHaveBeenCalledTimes(2);
            expect(deps.ai.startGenderResolution).toHaveBeenCalledTimes(2);
        });
        expect(cutoffs.get('resolver.early')).not.toHaveBeenCalled();
        const earlyFeatureInput = vi.mocked(deps.ai.features).mock.calls
            .map(([input]) => input)
            .find(input => input.media.some(row => row.selectionId.includes('resolver.early')))!;
        resolverStates.set('resolver.early', {
            status: 'ready',
            value: {
                result: {
                    assessment: {
                        inferredGender: 'female',
                        confidence: 'high',
                        ownerConsistency: 'same_person',
                        evidenceSelectionIds: earlyFeatureInput.media
                            .slice(0, 2)
                            .map(row => row.selectionId),
                    },
                    analyzedSelectionIds: earlyFeatureInput.media
                        .slice(0, 5)
                        .map(row => row.selectionId),
                },
                operationKey: `gender-resolution:${digest('resolver.early')}`,
                resultHash: digest('resolver.early-result'),
                source: 'checkpoint',
            },
        });
        const slowFeatureInput = vi.mocked(deps.ai.features).mock.calls
            .map(([input]) => input)
            .find(input => input.media.some(row => row.selectionId.includes('feature.slow')))!;
        releaseSlowFeature({
            result: feature(
                slowFeatureInput.media.map(row => row.selectionId),
                'unresolved',
            ),
            operationKey: `feature-analysis:${digest('slow-feature')}`,
            resultHash: digest('slow-feature-result'),
            source: 'checkpoint',
        });

        await execution;

        expect(cutoffs.get('resolver.early')).not.toHaveBeenCalled();
        expect(cutoffs.get('feature.slow')).toHaveBeenCalledOnce();
        expect(memoryState.outcomes.map(outcome => ({
            status: outcome.status,
            resolver: outcome.genderResolutionStatus,
        }))).toEqual([
            { status: 'verified_female', resolver: 'ready_applied' },
            { status: 'unresolved', resolver: 'cutoff' },
        ]);
    });

    it('cuts off every started resolver when a sibling prevents the batch barrier', async () => {
        const memoryState = memory();
        const usernames = ['feature.healthy', 'feature.fatal'];
        const accounts = usernames.map(username => profile(username));
        const deps = dependencies(memoryState, {
            profileAiConcurrency: 2,
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: usernames,
                    results: accounts.map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        deps.ai.features = vi.fn<AnalysisV2AiStageRuntime['features']>(async input => {
            const selectionIds = input.media.map(row => row.selectionId);
            if (selectionIds.some(id => id.includes('feature.fatal'))) {
                throw new Error('NONRECOVERABLE_PROFILE_AI_FAILURE');
            }
            return {
                result: feature(selectionIds, 'unresolved'),
                operationKey: `feature-analysis:${digest('healthy-feature')}`,
                resultHash: digest('healthy-feature-result'),
                source: 'checkpoint' as const,
            };
        });
        const cutoffs = new Map<string, ReturnType<typeof vi.fn>>();
        deps.ai.startGenderResolution = vi.fn((
            input: Parameters<AnalysisV2AiStageRuntime['startGenderResolution']>[0]
        ) => {
            const username = input.media.some(row => row.selectionId.includes('feature.healthy'))
                ? 'feature.healthy'
                : 'feature.fatal';
            let status: 'pending' | 'cutoff' = 'pending';
            const cutoff = vi.fn(async () => {
                status = 'cutoff';
            });
            cutoffs.set(username, cutoff);
            return {
                operationKey: `gender-resolution:${digest(username)}`,
                completion: new Promise<void>(() => undefined),
                peek: () => ({ status } as const),
                cutoff,
            };
        });
        const base = state();

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 2,
                            inputHash: digest('resolver-failure-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 2,
                        producerInputHash: digest('resolver-failure-producer'),
                        revision: 1,
                        resultHash: digest('resolver-failure-result'),
                    }],
                }),
            }),
        )).rejects.toThrow('NONRECOVERABLE_PROFILE_AI_FAILURE');

        expect(cutoffs.get('feature.healthy')).toHaveBeenCalledOnce();
        expect(cutoffs.get('feature.fatal')).toHaveBeenCalledOnce();
        expect(memoryState.outcomes).toEqual([]);
        expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
    });

    it('cuts off a pending resolver after feature completion without waiting for it', async () => {
        const memoryState = memory();
        const account = profile('resolver.pending');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
        });
        const cutoff = vi.fn().mockResolvedValue(undefined);
        deps.ai.features = vi.fn<AnalysisV2AiStageRuntime['features']>(async input => ({
            result: feature(input.media.map(row => row.selectionId), 'unresolved'),
            operationKey: `feature-analysis:${digest('resolver-pending-feature')}`,
            resultHash: digest('resolver-pending-feature-result'),
            source: 'checkpoint' as const,
        }));
        deps.ai.startGenderResolution = vi.fn(() => ({
            operationKey: `gender-resolution:${digest('pending-resolver')}`,
            completion: new Promise<void>(() => undefined),
            peek: () => ({ status: 'pending' as const }),
            cutoff,
        }));
        const base = state();

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('resolver-pending-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('resolver-pending-producer'),
                        revision: 1,
                        resultHash: digest('resolver-pending-result'),
                    }],
                }),
            }),
        );

        expect(cutoff).toHaveBeenCalledOnce();
        expect(memoryState.outcomes[0]).toMatchObject({
            status: 'unresolved',
            baselineClassification: 'unresolved',
            classificationSource: 'unknown',
            genderResolutionStatus: 'cutoff',
            genderResolutionOperationKey: null,
            genderResolutionResultHash: null,
        });
    });

    it('fails closed without checkpointing while an exact resolver attempt awaits recovery', async () => {
        const memoryState = memory();
        const account = profile('resolver.recovery.pending');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
        });
        deps.ai.features = vi.fn<AnalysisV2AiStageRuntime['features']>(async input => ({
            result: feature(input.media.map(row => row.selectionId), 'unresolved'),
            operationKey: `feature-analysis:${digest('resolver-recovery-feature')}`,
            resultHash: digest('resolver-recovery-feature-result'),
            source: 'checkpoint' as const,
        }));
        deps.ai.startGenderResolution = vi.fn(() => ({
            operationKey: `gender-resolution:${digest('recovery-pending-resolver')}`,
            completion: Promise.resolve(),
            peek: () => ({ status: 'recovery_pending' as const }),
            cutoff: vi.fn().mockResolvedValue(undefined),
        }));
        const base = state();

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('resolver-recovery-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('resolver-recovery-producer'),
                        revision: 1,
                        resultHash: digest('resolver-recovery-result'),
                    }],
                }),
            }),
        )).rejects.toThrow('ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING');
        expect(memoryState.outcomes).toEqual([]);
        expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
    });

    it('preserves ready resolver provenance when feature analysis becomes unavailable', async () => {
        const memoryState = memory();
        const account = profile('resolver.ready.rejected');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
        });
        const resolverOperationKey = `gender-resolution:${digest('ready-before-rejection')}`;
        const resolverResultHash = digest('ready-before-rejection-result');
        deps.ai.features = vi.fn<AnalysisV2AiStageRuntime['features']>(async () => {
            throw new Error(
                'AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.'
            );
        });
        deps.ai.startGenderResolution = vi.fn((
            input: Parameters<AnalysisV2AiStageRuntime['startGenderResolution']>[0]
        ) => ({
            operationKey: resolverOperationKey,
            completion: Promise.resolve(),
            peek: () => ({
                status: 'ready' as const,
                value: {
                    result: {
                        assessment: {
                            inferredGender: 'female' as const,
                            confidence: 'high' as const,
                            ownerConsistency: 'same_person' as const,
                            evidenceSelectionIds: input.media
                                .slice(0, 2)
                                .map(row => row.selectionId),
                        },
                        analyzedSelectionIds: input.media.map(row => row.selectionId),
                    },
                    operationKey: resolverOperationKey,
                    resultHash: resolverResultHash,
                    source: 'checkpoint' as const,
                },
            }),
            cutoff: vi.fn().mockResolvedValue(undefined),
        }));
        const base = state();

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('resolver-ready-rejection-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('resolver-ready-rejection-producer'),
                        revision: 1,
                        resultHash: digest('resolver-ready-rejection-result'),
                    }],
                }),
            }),
        );

        expect(memoryState.outcomes[0]).toMatchObject({
            status: 'analysis_unavailable',
            baselineClassification: 'analysis_unavailable',
            classificationSource: 'unavailable',
            genderResolutionStatus: 'ready_not_needed',
            genderResolutionOperationKey: resolverOperationKey,
            genderResolutionResultHash: resolverResultHash,
        });
    });

    it('isolates a recoverable gender rejection and checkpoints the rest of the same batch', async () => {
        const memoryState = memory();
        const usernames = ['rejected.gender', 'male.sibling', 'female.sibling'];
        const accounts = usernames.map(username => profile(username));
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: usernames,
                    results: accounts.map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]
        ) => {
            const ids = input.media.map(row => row.selectionId);
            if (ids.some(id => id.includes('rejected.gender'))) {
                throw new Error(
                    'AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.'
                );
            }
            const isMale = ids.some(id => id === 'profile:male.sibling');
            return {
                result: triage(ids, isMale ? 'male' : 'unknown'),
                operationKey: `gender-triage:${digest(isMale ? 'isolated-male' : 'isolated-female')}`,
                resultHash: digest(isMale ? 'isolated-male-result' : 'isolated-female-result'),
                source: 'checkpoint' as const,
            };
        });

        const output = await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', { jobKey: 'track:profile-ai:batch:0', batch: 0 })
        );

        expect(output.checkpoint.manifest.itemCount).toBe(3);
        expect(memoryState.outcomes.map(row => row.status)).toEqual([
            'analysis_unavailable', 'verified_non_female', 'verified_female',
        ]);
        expect(memoryState.outcomes[0]).toMatchObject({
            unavailableReason: 'ai_response',
            profile: accounts[0],
            triage: null,
            feature: null,
            normalizedSelectionIds: [],
            captions: [],
            genderOperationKey: null,
            genderResultHash: null,
            featureOperationKey: null,
            featureResultHash: null,
            mediaBundlePersisted: false,
        });
        expect(memoryState.outcomes[0]!.mediaCoverage).toEqual({
            selectedCount: 0,
            normalizedCount: 0,
            failures: [],
        });
        expect(vi.mocked(deps.ai.gender).mock.calls.filter(([input]) => (
            input.media.some(row => row.selectionId.includes('rejected.gender'))
        ))).toHaveLength(1);
        expect(deps.ai.gender).toHaveBeenCalledTimes(3);
        expect(deps.ai.features).toHaveBeenCalledOnce();
        expect(vi.mocked(deps.resultStore.checkpointFeatureBatch).mock.calls[0]![0].rows
            .map(row => row.classification)).toEqual([
            'unavailable', 'verified_non_female', 'verified_female',
        ]);
    });

    it('replays a durable response rejection without another generation after checkpoint failure', async () => {
        const memoryState = memory();
        const usernames = ['replay.rejected', 'replay.first', 'replay.second'];
        const accounts = usernames.map(username => profile(username));
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: usernames,
                    results: accounts.map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        let generationCount = 0;
        const durableGender = new Map<string, 'response_rejected' | GenderTriageResult>();
        const durableFeatures = new Map<string, FeatureAnalysisResult>();
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]
        ) => {
            const key = input.media.map(row => row.selectionId).join(':');
            let stored = durableGender.get(key);
            if (!stored) {
                generationCount += 1;
                stored = key.includes('replay.rejected')
                    ? 'response_rejected'
                    : triage(input.media.map(row => row.selectionId));
                durableGender.set(key, stored);
            }
            if (stored === 'response_rejected') {
                throw new Error(
                    'AI_GENERATION_RESPONSE_REJECTED_ERROR: durable response rejection.'
                );
            }
            return {
                result: stored,
                operationKey: `gender-triage:${digest(key)}`,
                resultHash: digest(`gender-result:${key}`),
                source: 'checkpoint' as const,
            };
        });
        deps.ai.features = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['features']>[0]
        ) => {
            const key = input.media.map(row => row.selectionId).join(':');
            let stored = durableFeatures.get(key);
            if (!stored) {
                generationCount += 1;
                stored = feature(input.media.map(row => row.selectionId));
                durableFeatures.set(key, stored);
            }
            return {
                result: stored,
                operationKey: `feature-analysis:${digest(key)}`,
                resultHash: digest(`feature-result:${key}`),
                source: 'checkpoint' as const,
            };
        });
        vi.mocked(deps.resultStore.checkpointFeatureBatch)
            .mockRejectedValueOnce(new Error('PUBLIC_CHECKPOINT_FAILED'));
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);
        const stageContext = context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
        });

        await expect(registry.profile_ai!(stageContext)).rejects.toThrow(
            'PUBLIC_CHECKPOINT_FAILED'
        );
        const generationsAfterFirstExecution = generationCount;
        expect(generationsAfterFirstExecution).toBe(5);
        expect(memoryState.outcomes).toEqual([]);

        const output = await registry.profile_ai!(stageContext);

        expect(generationCount).toBe(generationsAfterFirstExecution);
        expect(output.checkpoint.manifest.itemCount).toBe(3);
        expect(memoryState.outcomes.map(row => row.status)).toEqual([
            'analysis_unavailable', 'verified_female', 'verified_female',
        ]);
        expect(memoryState.outcomes[0]).toMatchObject({
            instagramId: 'replay.rejected',
            unavailableReason: 'ai_response',
            triage: null,
            feature: null,
        });
        expect(deps.resultStore.checkpointFeatureBatch).toHaveBeenCalledTimes(2);
        expect(deps.ai.gender).toHaveBeenCalledTimes(6);
        expect(deps.ai.features).toHaveBeenCalledTimes(4);
    });

    it('isolates a recoverable feature rejection without retaining partial AI output', async () => {
        const memoryState = memory();
        const usernames = ['rejected.feature', 'first.sibling', 'second.sibling'];
        const accounts = usernames.map(username => profile(username));
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: usernames,
                    results: accounts.map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        deps.ai.features = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['features']>[0]
        ) => {
            const ids = input.media.map(row => row.selectionId);
            if (ids.some(id => id.includes('rejected.feature'))) {
                throw new Error(
                    'AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.'
                );
            }
            return {
                result: feature(ids),
                operationKey: `feature-analysis:${digest(ids.join(':'))}`,
                resultHash: digest(`feature-result:${ids.join(':')}`),
                source: 'checkpoint' as const,
            };
        });

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', { jobKey: 'track:profile-ai:batch:0', batch: 0 })
        );

        expect(memoryState.outcomes.map(row => row.status)).toEqual([
            'analysis_unavailable', 'verified_female', 'verified_female',
        ]);
        expect(memoryState.outcomes[0]).toMatchObject({
            unavailableReason: 'ai_response',
            profile: accounts[0],
            triage: null,
            feature: null,
            normalizedSelectionIds: [],
            captions: [],
            genderOperationKey: null,
            genderResultHash: null,
            featureOperationKey: null,
            featureResultHash: null,
            mediaBundlePersisted: false,
        });
        expect(vi.mocked(deps.ai.features).mock.calls.filter(([input]) => (
            input.media.some(row => row.selectionId.includes('rejected.feature'))
        ))).toHaveLength(1);
        expect(deps.ai.gender).toHaveBeenCalledTimes(3);
        expect(deps.ai.features).toHaveBeenCalledTimes(3);
        expect(deps.mediaStore.persistBundle).toHaveBeenCalledTimes(2);
        expect(vi.mocked(deps.resultStore.checkpointFeatureBatch).mock.calls[0]![0].rows
            .map(row => row.classification)).toEqual([
            'unavailable', 'verified_female', 'verified_female',
        ]);
    });

    it('does not fail a mixed batch when optional resolver cutoff bookkeeping is slow', async () => {
        const memoryState = memory();
        const usernames = ['resolver.ambiguous', 'feature.rejected', 'healthy.sibling'];
        const accounts = usernames.map(username => profile(username));
        const deps = dependencies(memoryState, {
            profileAiConcurrency: 1,
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: usernames,
                    results: accounts.map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        deps.ai.features = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['features']>[0]
        ) => {
            const ids = input.media.map(row => row.selectionId);
            if (ids.some(id => id.includes('feature.rejected'))) {
                throw new Error(
                    'AI_GENERATION_RESPONSE_REJECTED_ERROR: generated response failed strict validation.'
                );
            }
            return {
                result: feature(ids, 'unresolved'),
                operationKey: `feature-analysis:${digest(ids.join(':'))}`,
                resultHash: digest(`feature-result:${ids.join(':')}`),
                source: 'checkpoint' as const,
            };
        });
        deps.ai.startGenderResolution = vi.fn(input => {
            const account = input.media[0]?.selectionId ?? '';
            if (account.includes('resolver.ambiguous')) {
                return {
                    operationKey: `gender-resolution:${digest(account)}`,
                    completion: Promise.resolve(),
                    peek: () => ({ status: 'terminal_unavailable' as const }),
                    cutoff: vi.fn().mockResolvedValue(undefined),
                };
            }
            let status: 'pending' | 'cutoff' = 'pending';
            return {
                operationKey: `gender-resolution:${digest(account)}`,
                completion: Promise.resolve(),
                peek: () => ({ status } as const),
                cutoff: vi.fn(async () => {
                    status = 'cutoff';
                    throw new AnalysisV2GenderResolutionCutoffPersistenceError();
                }),
            };
        });
        const base = state();

        const output = await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 3,
                            inputHash: digest('mixed-resolver-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 3,
                        producerInputHash: digest('mixed-resolver-producer'),
                        revision: 1,
                        resultHash: digest('mixed-resolver-result'),
                    }],
                }),
            }),
        );

        expect(output.checkpoint.manifest.itemCount).toBe(3);
        expect(memoryState.outcomes.map(row => row.status)).toEqual([
            'unresolved', 'analysis_unavailable', 'unresolved',
        ]);
        expect(memoryState.outcomes.map(row => row.genderResolutionStatus)).toEqual([
            'terminal_unavailable', 'cutoff', 'cutoff',
        ]);
        expect(deps.resultStore.checkpointFeatureBatch).toHaveBeenCalledOnce();
    });

    it('fails closed when optional resolver cutoff bookkeeping rejects immediately', async () => {
        const memoryState = memory();
        const account = profile('resolver.persistence.failure');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
        });
        deps.ai.features = vi.fn<AnalysisV2AiStageRuntime['features']>(async input => ({
            result: feature(input.media.map(row => row.selectionId), 'unresolved'),
            operationKey: `feature-analysis:${digest('cutoff-rejection-feature')}`,
            resultHash: digest('cutoff-rejection-feature-result'),
            source: 'checkpoint' as const,
        }));
        deps.ai.startGenderResolution = vi.fn(() => ({
            operationKey: `gender-resolution:${digest('cutoff-rejection-resolver')}`,
            completion: Promise.resolve(),
            peek: () => ({ status: 'pending' as const }),
            cutoff: vi.fn().mockRejectedValue(new Error('DATABASE_FENCE_REJECTED')),
        }));
        const base = state();

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('cutoff-rejection-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('cutoff-rejection-producer'),
                        revision: 1,
                        resultHash: digest('cutoff-rejection-result'),
                    }],
                }),
            }),
        )).rejects.toThrow('DATABASE_FENCE_REJECTED');

        expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
        expect(memoryState.outcomes).toEqual([]);
    });

    it.each([
        { stage: 'gender' as const, source: 'live' as const },
        { stage: 'gender' as const, source: 'replay' as const },
        { stage: 'features' as const, source: 'live' as const },
        { stage: 'features' as const, source: 'replay' as const },
    ])('isolates $source rate-limit exhaustion in $stage and checkpoints batch coverage', async ({
        stage,
        source,
    }) => {
        const memoryState = memory();
        const usernames = ['rate.limit', 'first.sibling', 'second.sibling'];
        const accounts = usernames.map(username => profile(username));
        const deps = dependencies(memoryState, {
            profileAiConcurrency: 1,
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: usernames,
                    results: accounts.map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        const failure = () => source === 'live'
            ? new Error(
                'AI_RATE_LIMIT_ERROR: Gemini rejected the request due to rate limiting.'
            )
            : new AnalysisV2AiResultRateLimitExhaustedError();
        const baseGender = deps.ai.gender;
        const baseFeatures = deps.ai.features;
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0],
            fence: Parameters<AnalysisV2AiStageRuntime['gender']>[1]
        ) => {
            if (
                stage === 'gender'
                && input.media.some(row => row.selectionId.includes('rate.limit'))
            ) {
                throw failure();
            }
            return baseGender(input, fence);
        });
        deps.ai.features = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['features']>[0],
            fence: Parameters<AnalysisV2AiStageRuntime['features']>[1]
        ) => {
            if (
                stage === 'features'
                && input.media.some(row => row.selectionId.includes('rate.limit'))
            ) {
                throw failure();
            }
            return baseFeatures(input, fence);
        });

        const output = await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', { jobKey: 'track:profile-ai:batch:0', batch: 0 })
        );

        expect(output.checkpoint.manifest.itemCount).toBe(3);
        expect(memoryState.outcomes.map(row => row.status)).toEqual([
            'analysis_unavailable', 'verified_female', 'verified_female',
        ]);
        expect(memoryState.outcomes.filter(row => (
            row.status === 'analysis_unavailable'
        ))).toHaveLength(1);
        expect(memoryState.outcomes[0]).toMatchObject({
            instagramId: 'rate.limit',
            unavailableReason: 'ai_response',
            triage: null,
            feature: null,
            genderOperationKey: null,
            featureOperationKey: null,
        });
        expect(deps.ai.gender).toHaveBeenCalledTimes(3);
        expect(deps.ai.features).toHaveBeenCalledTimes(stage === 'gender' ? 2 : 3);
        expect(deps.resultStore.checkpointFeatureBatch).toHaveBeenCalledOnce();
        expect(vi.mocked(deps.resultStore.checkpointFeatureBatch).mock.calls[0]![0])
            .toMatchObject({
                analyzedCount: 3,
                rows: [
                    { instagramId: 'rate.limit', classification: 'unavailable' },
                    { instagramId: 'first.sibling', classification: 'verified_female' },
                    { instagramId: 'second.sibling', classification: 'verified_female' },
                ],
            });
    });

    it.each([
        'AI_AMBIGUOUS_GENERATION_ERROR: transport outcome is unknown.',
        'AI_ATTEMPT_AUDIT_PERSISTENCE_ERROR: Gemini attempt result was not durably stored.',
        'ANALYSIS_V2_AI_RESULT_REPLAY_BLOCKED',
        'ANALYSIS_V2_AI_RESULT_RATE_LIMIT_EXHAUSTED',
        'NONRECOVERABLE_PROFILE_AI_FAILURE',
    ])('still rejects the profile job for nonrecoverable AI failure: %s', async message => {
        const memoryState = memory();
        const accounts = ['one.account', 'two.account', 'three.account'].map(username => (
            profile(username)
        ));
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: accounts.map(account => account.username),
                    results: accounts.map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        deps.ai.gender = vi.fn().mockRejectedValue(new Error(message));

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', { jobKey: 'track:profile-ai:batch:0', batch: 0 })
        )).rejects.toThrow(message);
        expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
        expect(memoryState.outcomes).toEqual([]);
    });

    it('reports each real profile AI task start with its already-loaded bounded media preview', async () => {
        const memoryState = memory();
        const reportActiveProfile = vi.fn(async () => undefined);
        const account = profile('woman.parallel');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['woman.parallel'],
                    results: [{
                        username: 'woman.parallel', status: 'success' as const, profile: account,
                    }],
                })),
            },
        });
        const base = state();
        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                reportActiveProfile,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        detectedMutualCount: 1,
                        publicCount: 1,
                        detailedSelectedPublicCount: 1,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('profile-topology-heartbeat'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('profile-producer-heartbeat'),
                        revision: 1,
                        resultHash: digest('profile-result-heartbeat'),
                    }],
                }),
            })
        );

        expect(deps.profileBatches.loadExactBatch).toHaveBeenCalledOnce();
        expect(deps.ai.gender).toHaveBeenCalledOnce();
        expect(reportActiveProfile).toHaveBeenCalledExactlyOnceWith('woman.parallel', {
            profilePicUrl: 'https://cdninstagram.com/woman.parallel/profile.jpg',
            feedImageUrls: [
                'https://cdninstagram.com/woman.parallel/post-0.jpg',
                'https://cdninstagram.com/woman.parallel/post-1.jpg',
            ],
        });
    });

    it('reports a private checkpoint once without deriving or exposing preview media', async () => {
        const memoryState = memory();
        const reportActiveProfile = vi.fn(async () => undefined);
        const account = { ...profile('private.preview'), isPrivate: true };
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['private.preview'],
                    results: [{
                        username: 'private.preview', status: 'success' as const, profile: account,
                    }],
                })),
            },
        });
        const selectPreview = vi.spyOn(
            progressCandidateMedia,
            'selectAnalysisV2ProgressCandidateMedia',
        );

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0', batch: 0, reportActiveProfile,
                state: state({
                    relationships: {
                        ...state().relationships!,
                        detectedMutualCount: 1, publicCount: 1, detailedSelectedPublicCount: 1,
                        profileBatches: [{ batch: 0, itemCount: 1, inputHash: digest('private-preview') }],
                    },
                    profileFetchBatches: [{
                        batch: 0, itemCount: 1, producerInputHash: digest('private-preview-producer'),
                        revision: 1, resultHash: digest('private-preview-result'),
                    }],
                }),
            })
        );

        expect(deps.profileBatches.loadExactBatch).toHaveBeenCalledOnce();
        expect(selectPreview).not.toHaveBeenCalled();
        expect(deps.normalizeMedia).not.toHaveBeenCalled();
        expect(deps.ai.gender).not.toHaveBeenCalled();
        expect(reportActiveProfile).toHaveBeenCalledOnce();
        expect(reportActiveProfile.mock.calls[0]).toEqual(['private.preview']);
    });

    it('reports an unavailable checkpoint once without selector, media, or AI work', async () => {
        const memoryState = memory();
        const reportActiveProfile = vi.fn(async () => undefined);
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['unavailable.preview'],
                    results: [{ username: 'unavailable.preview', status: 'unavailable' as const }],
                })),
            },
        });
        const selectPreview = vi.spyOn(
            progressCandidateMedia,
            'selectAnalysisV2ProgressCandidateMedia',
        );

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0', batch: 0, reportActiveProfile,
                state: state({
                    relationships: {
                        ...state().relationships!,
                        detectedMutualCount: 1, publicCount: 1, detailedSelectedPublicCount: 1,
                        profileBatches: [{ batch: 0, itemCount: 1, inputHash: digest('unavailable-preview') }],
                    },
                    profileFetchBatches: [{
                        batch: 0, itemCount: 1, producerInputHash: digest('unavailable-preview-producer'),
                        revision: 1, resultHash: digest('unavailable-preview-result'),
                    }],
                }),
            })
        );

        expect(deps.profileBatches.loadExactBatch).toHaveBeenCalledOnce();
        expect(selectPreview).not.toHaveBeenCalled();
        expect(deps.normalizeMedia).not.toHaveBeenCalled();
        expect(deps.ai.gender).not.toHaveBeenCalled();
        expect(reportActiveProfile).toHaveBeenCalledOnce();
        expect(reportActiveProfile.mock.calls[0]).toEqual(['unavailable.preview']);
    });

    it('continues candidate analysis when progress-media derivation unexpectedly fails', async () => {
        const memoryState = memory();
        const reportActiveProfile = vi.fn(async () => undefined);
        const account = profile('media.failure');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['media.failure'],
                    results: [{
                        username: 'media.failure', status: 'success' as const, profile: account,
                    }],
                })),
            },
        });
        vi.spyOn(progressCandidateMedia, 'selectAnalysisV2ProgressCandidateMedia')
            .mockImplementationOnce(() => { throw new Error('PREVIEW_DERIVATION_FAILED'); });

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0', batch: 0, reportActiveProfile,
                state: state({
                    relationships: {
                        ...state().relationships!,
                        detectedMutualCount: 1, publicCount: 1, detailedSelectedPublicCount: 1,
                        profileBatches: [{ batch: 0, itemCount: 1, inputHash: digest('preview-fail') }],
                    },
                    profileFetchBatches: [{
                        batch: 0, itemCount: 1, producerInputHash: digest('preview-fail-producer'),
                        revision: 1, resultHash: digest('preview-fail-result'),
                    }],
                }),
            })
        );

        expect(deps.profileBatches.loadExactBatch).toHaveBeenCalledOnce();
        expect(deps.ai.gender).toHaveBeenCalledOnce();
        expect(reportActiveProfile).toHaveBeenCalledExactlyOnceWith('media.failure', undefined);
    });

    it('drains in-flight Gemini work before surfacing the first bounded worker failure', async () => {
        const memoryState = memory();
        const first = profile('first.account', { postCount: 0 });
        const sibling = profile('sibling.account', { postCount: 0 });
        const neverStarted = profile('queued.account', { postCount: 0 });
        let markSiblingStarted!: () => void;
        let releaseSibling!: () => void;
        const siblingStarted = new Promise<void>(resolve => { markSiblingStarted = resolve; });
        const siblingRelease = new Promise<void>(resolve => { releaseSibling = resolve; });
        const deps = dependencies(memoryState, {
            profileAiConcurrency: 2,
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['first.account', 'sibling.account', 'queued.account'],
                    results: [first, sibling, neverStarted].map(account => ({
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    })),
                })),
            },
        });
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]
        ) => {
            const ids = input.media.map(row => row.selectionId);
            if (ids.some(id => id.includes('first.account'))) {
                await siblingStarted;
                throw new Error('FIRST_GEMINI_FAILURE');
            }
            markSiblingStarted();
            await siblingRelease;
            return {
                result: triage(ids, 'male'),
                operationKey: `gender-triage:${digest('drained-sibling')}`,
                resultHash: digest('drained-sibling-result'),
                source: 'checkpoint' as const,
            };
        });
        const execution = createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
            })
        );
        let settled = false;
        void execution.then(
            () => { settled = true; },
            () => { settled = true; }
        );

        await siblingStarted;
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(false);

        releaseSibling();
        await expect(execution).rejects.toThrow('FIRST_GEMINI_FAILURE');
        expect(deps.ai.gender).toHaveBeenCalledTimes(2);
        expect(JSON.stringify(vi.mocked(deps.ai.gender).mock.calls))
            .not.toContain('queued.account');
        expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
    });

    it('excludes a relationship-public profile that drifted private before any media or AI work', async () => {
        const memoryState = memory();
        const drifted = {
            ...profile('privacy.drift'),
            isPrivate: true,
        };
        const normalizeMedia = vi.fn(async () => Buffer.from('should-not-run'));
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['privacy.drift'],
                    results: [{
                        username: 'privacy.drift', status: 'success' as const, profile: drifted,
                    }],
                })),
            },
            normalizeMedia,
        });
        const base = state();

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        detectedMutualCount: 1,
                        publicCount: 1,
                        detailedSelectedPublicCount: 1,
                        profileBatches: [{
                            batch: 0, itemCount: 1, inputHash: digest('privacy-drift-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0, itemCount: 1,
                        producerInputHash: digest('privacy-drift-producer'),
                        revision: 1, resultHash: digest('privacy-drift-result'),
                    }],
                }),
            })
        );

        expect(memoryState.outcomes).toEqual([
            expect.objectContaining({
                instagramId: 'privacy.drift',
                status: 'fetch_unavailable',
                profile: null,
            }),
        ]);
        expect(normalizeMedia).not.toHaveBeenCalled();
        expect(deps.ai.gender).not.toHaveBeenCalled();
        expect(deps.ai.features).not.toHaveBeenCalled();
        expect(vi.mocked(deps.resultStore.checkpointFeatureBatch).mock.calls[0]![0].rows)
            .toEqual([expect.objectContaining({ classification: 'unavailable' })]);
    });

    it('retries a profile batch with an unresolved failed producer outcome', async () => {
        const memoryState = memory();
        const base = state();
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['retry.account'],
                    results: [{ username: 'retry.account', status: 'failed' as const }],
                })),
            },
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await expect(registry.profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
            state: state({
                relationships: {
                    ...base.relationships!,
                    detectedMutualCount: 1,
                    publicCount: 1,
                    detailedSelectedPublicCount: 1,
                    profileBatches: [{
                        batch: 0,
                        itemCount: 1,
                        inputHash: digest('profile-topology-retry'),
                    }],
                },
                profileFetchBatches: [{
                    batch: 0,
                    itemCount: 1,
                    producerInputHash: digest('profile-producer-retry'),
                    revision: 1,
                    resultHash: digest('profile-result-retry'),
                }],
            }),
        }))).rejects.toThrow('ANALYSIS_V2_PROFILE_CONSUMER_RETRYABLE_OUTCOME');
        expect(deps.ai.gender).not.toHaveBeenCalled();
        expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
    });

    it('fails closed before gender inference when a public post snapshot is structural partial', async () => {
        const memoryState = memory();
        const full = profile('woman.partial', { postCount: 8 });
        const account = { ...full, latestPosts: full.latestPosts!.slice(0, 2) };
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['woman.partial'],
                    results: [{
                        username: 'woman.partial', status: 'success' as const, profile: account,
                    }],
                })),
            },
        });
        const base = state();
        const execution = createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        detectedMutualCount: 1,
                        publicCount: 1,
                        detailedSelectedPublicCount: 1,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('profile-topology-structural-partial'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('profile-producer-structural-partial'),
                        revision: 1,
                        resultHash: digest('profile-result-structural-partial'),
                    }],
                }),
            })
        );

        await expect(execution).rejects.toThrow(
            'ANALYSIS_V2_PROFILE_MEDIA_STRUCTURAL_INCOMPLETE'
        );
        expect(deps.ai.gender).not.toHaveBeenCalled();
        expect(deps.ai.features).not.toHaveBeenCalled();
        expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
    });

    it('downloads only triage media first, then reuses it while expanding routed accounts', async () => {
        const memoryState = memory();
        const account = profile('woman.deep', { postCount: 8 });
        const normalizeMedia = vi.fn(async (media: { selectionId: string }) => (
            Buffer.from(media.selectionId)
        ));
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['woman.deep'],
                    results: [{
                        username: 'woman.deep', status: 'success' as const, profile: account,
                    }],
                })),
            },
            normalizeMedia,
        });
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]
        ) => ({
            result: triage(input.media.map(row => row.selectionId), 'unknown'),
            operationKey: `gender-triage:${digest('triage-two-phase')}`,
            resultHash: digest('triage-two-phase-result'),
            source: 'checkpoint' as const,
        }));
        deps.ai.features = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['features']>[0]
        ) => ({
            result: feature(input.media.map(row => row.selectionId)),
            operationKey: `feature-analysis:${digest('feature-two-phase')}`,
            resultHash: digest('feature-two-phase-result'),
            source: 'checkpoint' as const,
        }));
        const base = state();
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await registry.profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
            state: state({
                relationships: {
                    ...base.relationships!,
                    detectedMutualCount: 1,
                    publicCount: 1,
                    detailedSelectedPublicCount: 1,
                    profileBatches: [{
                        batch: 0,
                        itemCount: 1,
                        inputHash: digest('profile-topology-one'),
                    }],
                },
                profileFetchBatches: [{
                    batch: 0,
                    itemCount: 1,
                    producerInputHash: digest('profile-producer-one'),
                    revision: 1,
                    resultHash: digest('profile-result-one'),
                }],
            }),
        }));

        const genderInput = vi.mocked(deps.ai.gender).mock.calls[0]![0];
        const featureInput = vi.mocked(deps.ai.features).mock.calls[0]![0];
        expect(deps.ai.features).toHaveBeenCalledOnce();
        expect(genderInput.media).toHaveLength(5);
        expect(featureInput.media).toHaveLength(9);
        expect(normalizeMedia).toHaveBeenCalledTimes(9);
        expect(new Set(normalizeMedia.mock.calls.map(([media]) => media.selectionId)).size).toBe(9);
        expect(memoryState.outcomes[0].mediaCoverage).toEqual({
            selectedCount: 9,
            normalizedCount: 9,
            failures: [],
        });
    });

    it('checkpoints every triage-referenced post for an early-exit man', async () => {
        const memoryState = memory();
        const baseAccount = profile('man.triage_posts', { postCount: 2 });
        const sharedUrl = 'https://cdninstagram.com/triage/shared.jpg';
        const carouselPost = {
            ...baseAccount.latestPosts![0]!,
            id: 'triage-carousel-post',
            shortCode: 'triagecarouselpost',
            type: 'carousel' as const,
            imageUrl: 'https://cdninstagram.com/triage/carousel-cover.jpg',
            mediaItems: [{
                id: 'triage-carousel-first',
                type: 'image' as const,
                imageUrl: 'https://cdninstagram.com/triage/carousel-first.jpg',
            }, {
                id: 'triage-carousel-middle',
                type: 'image' as const,
                imageUrl: sharedUrl,
            }, {
                id: 'triage-carousel-last',
                type: 'image' as const,
                imageUrl: 'https://cdninstagram.com/triage/carousel-last.jpg',
            }],
            declaredMediaCount: 3,
            childrenComplete: true,
            taggedUsers: ['tagged.carousel'],
            mentionedUsers: ['mentioned.carousel'],
        };
        const laterPost = {
            ...baseAccount.latestPosts![1]!,
            id: 'triage-later-post',
            shortCode: 'triagelaterpost',
            imageUrl: sharedUrl,
            taggedUsers: ['tagged.later'],
            mentionedUsers: ['mentioned.later'],
        };
        const account: AnalysisV2CheckpointProfile = {
            ...baseAccount,
            latestPosts: [laterPost, carouselPost],
        };
        const rpc = vi.fn<(
            name: string,
            params: Record<string, unknown>
        ) => Promise<{
            data: AnalysisV2ResultCheckpointManifest;
            error: null;
        }>>(async () => ({
            data: resultManifest('track:profile-ai:batch:0', 1),
            error: null,
        }));
        const resultStore = createSupabaseAnalysisV2ResultStore({
            rpc,
        } as AnalysisV2ResultSupabaseClient);
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
            resultStore,
        });
        deps.ai.gender = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]
        ) => ({
            result: triage(input.media.map(row => row.selectionId), 'male'),
            operationKey: `gender-triage:${digest('triage-post-projection-male')}`,
            resultHash: digest('triage-post-projection-male-result'),
            source: 'checkpoint' as const,
        }));
        const base = state();

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        detectedMutualCount: 1,
                        publicCount: 1,
                        detailedSelectedPublicCount: 1,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('profile-topology-triage-posts'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('profile-producer-triage-posts'),
                        revision: 1,
                        resultHash: digest('profile-result-triage-posts'),
                    }],
                }),
            })
        );

        const genderInput = vi.mocked(deps.ai.gender).mock.calls[0]![0];
        expect(genderInput.media.flatMap(media => (
            media.postId ? [media.postId] : []
        ))).toEqual(['triage-carousel-post', 'triage-later-post']);
        expect(deps.ai.features).not.toHaveBeenCalled();
        const rows = rpc.mock.calls[0]![1].p_rows as AnalysisV2ProfileClassificationRow[];
        expect(rows[0]!.classification).toBe('verified_non_female');
        expect(rows[0]!.mediaContext!.selectionIds).toEqual(
            genderInput.media.map(media => media.selectionId)
        );
        expect(rows[0]!.mediaContext!.posts).toEqual([{
            postId: 'triage-later-post',
            taggedUsers: ['tagged.later'],
            mentionedUsers: ['mentioned.later'],
        }, {
            postId: 'triage-carousel-post',
            taggedUsers: ['tagged.carousel'],
            mentionedUsers: ['mentioned.carousel'],
        }]);
    });

    it('checkpoints only posts referenced by analyzed media from a twelve-post profile', async () => {
        const memoryState = memory();
        const baseAccount = profile('woman.twelve', { postCount: 12 });
        const unavailablePostId = baseAccount.latestPosts![3]!.id;
        const remainingPostsInOriginalOrder = [
            baseAccount.latestPosts![2]!,
            baseAccount.latestPosts![1]!,
            ...baseAccount.latestPosts!.slice(3),
        ];
        const account: AnalysisV2CheckpointProfile = {
            ...baseAccount,
            latestPosts: [{
                ...baseAccount.latestPosts![0],
                id: 'newest-carousel-post',
                shortCode: 'newestcarouselpost',
                type: 'carousel',
                imageUrl: 'https://cdninstagram.com/carousel/cover.jpg',
                mediaItems: Array.from({ length: 5 }, (_, index) => ({
                    id: `newest-carousel-frame-${index + 1}`,
                    type: 'image' as const,
                    caption: `carousel caption ${index + 1}`,
                    imageUrl: `https://cdninstagram.com/carousel/frame-${index + 1}.jpg`,
                })),
                declaredMediaCount: 5,
                childrenComplete: true,
                taggedUsers: ['tagged.carousel'],
                mentionedUsers: ['mentioned.carousel'],
            }, ...remainingPostsInOriginalOrder.map((post, index) => ({
                ...post,
                ...(post.id === unavailablePostId ? { imageUrl: undefined } : {}),
                taggedUsers: [`tagged.${index + 1}`],
                mentionedUsers: [`mentioned.${index + 1}`],
            }))],
        };
        const rpc = vi.fn<(
            name: string,
            params: Record<string, unknown>
        ) => Promise<{
            data: AnalysisV2ResultCheckpointManifest;
            error: null;
        }>>(async () => ({
            data: resultManifest('track:profile-ai:batch:0', 1),
            error: null,
        }));
        const resultStore = createSupabaseAnalysisV2ResultStore({
            rpc,
        } as AnalysisV2ResultSupabaseClient);
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
            resultStore,
        });
        const base = state();

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        detectedMutualCount: 1,
                        publicCount: 1,
                        detailedSelectedPublicCount: 1,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('profile-topology-twelve-posts'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('profile-producer-twelve-posts'),
                        revision: 1,
                        resultHash: digest('profile-result-twelve-posts'),
                    }],
                }),
            })
        )).resolves.toBeDefined();

        const featureInput = vi.mocked(deps.ai.features).mock.calls[0]![0];
        const selectedPostIds = new Set(featureInput.media.flatMap(media => (
            media.postId ? [media.postId] : []
        )));
        const expectedPosts = account.latestPosts!.flatMap(post => (
            selectedPostIds.has(post.id)
                ? [{
                    postId: post.id,
                    taggedUsers: post.taggedUsers,
                    mentionedUsers: post.mentionedUsers,
                }]
                : []
        ));
        const rows = rpc.mock.calls[0]![1].p_rows as AnalysisV2ProfileClassificationRow[];
        const checkpointPosts = rows[0]!.mediaContext!.posts;

        expect(featureInput.media.filter(media => (
            media.postId === 'newest-carousel-post'
        ))).toHaveLength(3);
        expect(expectedPosts).toHaveLength(7);
        expect(expectedPosts.map(post => post.postId)).not.toContain(unavailablePostId);
        expect(checkpointPosts).toEqual(expectedPosts);
        expect(checkpointPosts).toHaveLength(new Set(
            checkpointPosts.map(post => post.postId)
        ).size);
        expect(checkpointPosts.length).toBeLessThanOrEqual(8);
    });

    it('aligns first, middle, and last child captions with the canonical feature selections', async () => {
        const memoryState = memory();
        const baseAccount = profile('woman.carousel_caption', { postCount: 8 });
        const account: AnalysisV2CheckpointProfile = {
            ...baseAccount,
            latestPosts: [{
                ...baseAccount.latestPosts![0],
                id: 'caption-carousel-post',
                shortCode: 'captioncarouselpost',
                type: 'carousel',
                imageUrl: 'https://cdninstagram.com/carousel/cover.jpg',
                mediaItems: Array.from({ length: 20 }, (_, index) => ({
                    id: `caption-frame-${index + 1}`,
                    type: 'image' as const,
                    caption: `slide caption ${index + 1}`,
                    imageUrl: `https://cdninstagram.com/carousel/frame-${index + 1}.jpg`,
                })),
                declaredMediaCount: 20,
                childrenComplete: true,
            }, ...baseAccount.latestPosts!.slice(1)],
        };
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username, status: 'success' as const, profile: account,
                    }],
                })),
            },
        });
        deps.ai.features = vi.fn(async rawInput => {
            const input = featureAnalysisInputSchema.parse(rawInput);
            return {
                result: feature(input.media.map(row => row.selectionId)),
                operationKey: `feature-analysis:${digest('feature-carousel-caption')}`,
                resultHash: digest('feature-carousel-caption-result'),
                source: 'checkpoint' as const,
            };
        });
        const base = state();

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        detectedMutualCount: 1,
                        publicCount: 1,
                        detailedSelectedPublicCount: 1,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('profile-topology-carousel-caption'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('profile-producer-carousel-caption'),
                        revision: 1,
                        resultHash: digest('profile-result-carousel-caption'),
                    }],
                }),
            })
        )).resolves.toBeDefined();

        const featureInput = vi.mocked(deps.ai.features).mock.calls[0]![0];
        expect(deps.ai.features).toHaveBeenCalledOnce();
        expect(featureInput.media.filter(media => (
            media.postId === 'caption-carousel-post'
        ))).toHaveLength(3);
        expect(featureInput.captions.filter(caption => (
            caption.selectionId.includes('caption-carousel-post')
        )).map(caption => [caption.selectionId, caption.text])).toEqual([
            [expect.stringContaining(':media:0:'), 'slide caption 1'],
            [expect.stringContaining(':media:10:'), 'slide caption 11'],
            [expect.stringContaining(':media:19:'), 'slide caption 20'],
        ]);
        expect(new Set(featureInput.captions.map(caption => caption.evidenceRefId)).size)
            .toBe(featureInput.captions.length);
    });

    it('distinguishes successful profile fetches with zero usable media from fetch failures', async () => {
        const memoryState = memory();
        const account = profile('media.broken');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['media.broken'],
                    results: [{
                        username: 'media.broken', status: 'success' as const, profile: account,
                    }],
                })),
            },
            normalizeMedia: vi.fn(async () => {
                throw new AnalysisImagePreparationError('decode_failed', 'permanent');
            }),
        });
        const base = state();
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await registry.profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
            state: state({
                relationships: {
                    ...base.relationships!,
                    detectedMutualCount: 1,
                    publicCount: 1,
                    detailedSelectedPublicCount: 1,
                    profileBatches: [{
                        batch: 0, itemCount: 1, inputHash: digest('topology-broken'),
                    }],
                },
                profileFetchBatches: [{
                    batch: 0, itemCount: 1,
                    producerInputHash: digest('producer-broken'),
                    revision: 1, resultHash: digest('result-broken'),
                }],
            }),
        }));

        expect(memoryState.outcomes[0]).toMatchObject({
            status: 'media_unavailable',
            profile: account,
            mediaCoverage: { selectedCount: 3, normalizedCount: 0 },
        });
        expect(memoryState.outcomes[0].mediaCoverage.failures).toHaveLength(3);
        expect(memoryState.outcomes[0].mediaCoverage.failures).toEqual(
            expect.arrayContaining([expect.objectContaining({
                reason: 'decode_failed',
                disposition: 'permanent',
            })])
        );
        expect(deps.normalizeMedia).toHaveBeenCalledTimes(3);
        expect(deps.ai.gender).not.toHaveBeenCalled();
        expect(vi.mocked(deps.resultStore.checkpointFeatureBatch).mock.calls[0]![0]
            .rows[0].classification).toBe('media_unavailable');
    });

    it('retries transient media preparation once and escalates an all-transient batch', async () => {
        const memoryState = memory();
        const account = profile('media.timeout');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const normalizeMedia = vi.fn(async () => {
            throw new AnalysisImagePreparationError('timeout', 'transient');
        });
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['media.timeout'],
                    results: [{
                        username: 'media.timeout', status: 'success' as const, profile: account,
                    }],
                })),
            },
            normalizeMedia,
        });
        const base = state();
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        try {
            await expect(registry.profile_ai!(context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0, itemCount: 1, inputHash: digest('topology-timeout'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0, itemCount: 1,
                        producerInputHash: digest('producer-timeout'),
                        revision: 1, resultHash: digest('result-timeout'),
                    }],
                }),
            }))).rejects.toThrow('ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT');

            expect(normalizeMedia).toHaveBeenCalledTimes(6);
            expect(deps.ai.gender).not.toHaveBeenCalled();
            expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
            expect(warning).toHaveBeenCalledWith(
                'Analysis V2 media preparation has transient failures',
                { selectedCount: 3, failureReasons: { timeout: 3 } }
            );
            expect(JSON.stringify(warning.mock.calls)).not.toContain('media.timeout');
        } finally {
            warning.mockRestore();
        }
    });

    it('retries the exact job when even one required media item remains transient', async () => {
        const memoryState = memory();
        const account = profile('media.partial_timeout');
        const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const normalizeMedia = vi.fn(async (media: { selectionId: string }) => {
            if (media.selectionId.startsWith('profile:')) return Buffer.from(media.selectionId);
            throw new AnalysisImagePreparationError('timeout', 'transient');
        });
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['media.partial_timeout'],
                    results: [{
                        username: 'media.partial_timeout',
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
            normalizeMedia,
        });
        const base = state();
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        try {
            await expect(registry.profile_ai!(context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0, itemCount: 1,
                            inputHash: digest('topology-partial-timeout'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0, itemCount: 1,
                        producerInputHash: digest('producer-partial-timeout'),
                        revision: 1, resultHash: digest('result-partial-timeout'),
                    }],
                }),
            }))).rejects.toThrow('ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT');

            expect(deps.ai.gender).not.toHaveBeenCalled();
            expect(deps.resultStore.checkpointFeatureBatch).not.toHaveBeenCalled();
        } finally {
            warning.mockRestore();
        }
    });

    it('records permanent partial media as unavailable without running gender or feature AI', async () => {
        const memoryState = memory();
        const account = profile('media.partial_permanent');
        const normalizeMedia = vi.fn(async (media: { selectionId: string }) => {
            if (media.selectionId.includes('post-1')) {
                throw new AnalysisImagePreparationError('source_missing', 'permanent');
            }
            return Buffer.from(media.selectionId);
        });
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['media.partial_permanent'],
                    results: [{
                        username: 'media.partial_permanent',
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
            normalizeMedia,
        });
        const base = state();
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await registry.profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
            state: state({
                relationships: {
                    ...base.relationships!,
                    profileBatches: [{
                        batch: 0, itemCount: 1, inputHash: digest('topology-partial-permanent'),
                    }],
                },
                profileFetchBatches: [{
                    batch: 0, itemCount: 1,
                    producerInputHash: digest('producer-partial-permanent'),
                    revision: 1, resultHash: digest('result-partial-permanent'),
                }],
            }),
        }));

        expect(memoryState.outcomes[0]).toMatchObject({
            status: 'media_unavailable',
            mediaCoverage: { selectedCount: 3, normalizedCount: 2 },
        });
        expect(memoryState.outcomes[0].normalizedSelectionIds).toHaveLength(2);
        expect(deps.ai.gender).not.toHaveBeenCalled();
        expect(deps.ai.features).not.toHaveBeenCalled();
    });

    it('lets v2.7 continue with successful media when failures stay at twenty percent', async () => {
        const memoryState = memory();
        const account = profile('media.v27_partial', { postCount: 4 });
        const normalizeMedia = vi.fn(async (media: { selectionId: string }) => {
            if (media.selectionId.includes('post-3')) {
                throw new AnalysisImagePreparationError('source_missing', 'permanent');
            }
            return Buffer.from(media.selectionId);
        });
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
            normalizeMedia,
        });
        const base = state();

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(
            context('profile_ai', {
                jobKey: 'track:profile-ai:batch:0',
                batch: 0,
                aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
                state: state({
                    relationships: {
                        ...base.relationships!,
                        profileBatches: [{
                            batch: 0,
                            itemCount: 1,
                            inputHash: digest('v27-partial-topology'),
                        }],
                    },
                    profileFetchBatches: [{
                        batch: 0,
                        itemCount: 1,
                        producerInputHash: digest('v27-partial-producer'),
                        revision: 1,
                        resultHash: digest('v27-partial-result'),
                    }],
                }),
            }),
        );

        expect(memoryState.outcomes[0]).toMatchObject({
            status: 'verified_female',
            mediaCoverage: { selectedCount: 5, normalizedCount: 4 },
        });
        expect(memoryState.outcomes[0]!.mediaCoverage.failures).toHaveLength(1);
        expect(deps.ai.gender).toHaveBeenCalledOnce();
        expect(deps.ai.features).toHaveBeenCalledOnce();
    });

    it('keeps a transient media success after its bounded retry', async () => {
        const memoryState = memory();
        const account = profile('media.recovers', { postCount: 0 });
        const attempts = new Map<string, number>();
        const normalizeMedia = vi.fn(async (media: { selectionId: string }) => {
            const attempt = (attempts.get(media.selectionId) ?? 0) + 1;
            attempts.set(media.selectionId, attempt);
            if (attempt === 1) {
                throw new AnalysisImagePreparationError('network_failure', 'transient');
            }
            return Buffer.from(media.selectionId);
        });
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: ['media.recovers'],
                    results: [{
                        username: 'media.recovers', status: 'success' as const, profile: account,
                    }],
                })),
            },
            normalizeMedia,
        });
        const base = state();
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await expect(registry.profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
            state: state({
                relationships: {
                    ...base.relationships!,
                    profileBatches: [{
                        batch: 0, itemCount: 1, inputHash: digest('topology-recovers'),
                    }],
                },
                profileFetchBatches: [{
                    batch: 0, itemCount: 1,
                    producerInputHash: digest('producer-recovers'),
                    revision: 1, resultHash: digest('result-recovers'),
                }],
            }),
        }))).resolves.toBeDefined();

        expect(normalizeMedia).toHaveBeenCalledTimes(2);
        expect(memoryState.outcomes[0].mediaCoverage).toEqual({
            selectedCount: 1,
            normalizedCount: 1,
            failures: [],
        });
        expect(deps.ai.gender).toHaveBeenCalledOnce();
    });

    it('passes only the 17 bounded captions aligned with successful contact-sheet cells', async () => {
        const memoryState = memory();
        const candidate = completeCarouselOutcome('woman.carousel');
        memoryState.outcomes = [candidate];
        memoryState.screening = {
            revision: 1,
            resultHash: digest('screening-carousel-captions'),
            shortlistHash: digest('shortlist-carousel-captions'),
            candidates: calculateV2PreliminaryScores({
                candidates: [{
                    candidateId: candidate.candidateId,
                    username: candidate.instagramId,
                    appearanceGrade: 3,
                    exposureScore: 1,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                    uniqueTargetPostsLikedByCandidate: 0,
                    boundedCandidateCommentsOnTarget: 0,
                    hasCandidateToTargetTagOrCaptionMention: false,
                    hasTargetToCandidateTagOrCaptionMention: false,
                }],
                orderedMutualUsernames: [candidate.instagramId],
                excludedUsername: null,
            }),
        };
        const contactSheetJpeg = Buffer.from([0xff, 0xd8, 0x55, 0xff, 0xd9]);
        const createContactSheet = vi.fn(async (
            sources: readonly { selectionId: string; normalizedJpegBase64: string }[]
        ) => ({
            selectionId: `contact-sheet:${digest(sources.map(row => row.selectionId).join('|'))}`,
            normalizedJpegBase64: contactSheetJpeg.toString('base64'),
            sourceSelectionIds: sources.map(row => row.selectionId),
            width: 768,
            height: 960,
        }));
        const archiveReleases: Array<() => void> = [];
        const sourceMediaArchive: AnalysisV2SourceMediaArchiveStore = {
            persistBundle: vi.fn(async input => {
                void input;
                await new Promise<void>(resolve => archiveReleases.push(resolve));
            }),
            loadBundle: vi.fn(async () => null),
        };
        const deps = dependencies(memoryState, { createContactSheet, sourceMediaArchive });
        const artifactReleases: Array<() => void> = [];
        deps.mediaStore.persistBundle = vi.fn(async input => {
            await new Promise<void>(resolve => artifactReleases.push(resolve));
            return {
                requestId: input.requestId,
                artifactKey: digest(input.bundleId),
                artifactKind: 'media_bundle' as const,
                contentSha256: digest('partner-bundle'),
                contentType: 'application/octet-stream' as const,
                objectName: 'object',
                objectGeneration: '1',
                byteSize: 4,
            };
        });
        deps.ai.partnerSafety = vi.fn(async input => {
            const contactSheet = input.contactSheet!;
            return {
                result: {
                    assessment: {
                        companionPattern: 'single_two_person' as const,
                        partnerEvidence: 'weak' as const,
                        exclusionContext: 'none' as const,
                        confidence: 'medium' as const,
                        evidenceSourceSelectionIds: [contactSheet.sourceSelectionIds[0]!],
                    },
                    hasWeakNonExcludedMalePairEvidence: true,
                    hasStrongPartnerEvidence: false,
                    strongEvidenceBasis: 'none' as const,
                    weakAdjustmentStatus: 'applied_policy_v2_2' as const,
                    source: 'gemini' as const,
                    analyzedContactSheetSelectionId: contactSheet.selectionId,
                },
                operationKey: `partner-safety:${digest('carousel-partner')}`,
                resultHash: digest('carousel-partner-result'),
                source: 'checkpoint' as const,
            };
        });

        const execution = createAnalysisV2AiScoringExecutorRegistry(deps).partner_safety!(
            context('partner_safety')
        );
        await vi.waitFor(() => expect(deps.ai.partnerSafety).toHaveBeenCalledOnce());
        expect(sourceMediaArchive.persistBundle).toHaveBeenCalledTimes(2);
        expect(deps.mediaStore.persistBundle).toHaveBeenCalledOnce();
        artifactReleases.forEach(release => release());
        archiveReleases.forEach(release => release());
        await execution;

        expect(deps.ai.partnerSafety).toHaveBeenCalledOnce();
        expect(deps.targetProfiles.loadTargetProfile).toHaveBeenCalledOnce();
        const partnerInput = vi.mocked(deps.ai.partnerSafety).mock.calls[0]![0];
        expect(partnerInput.contactSheet?.sourceSelectionIds).toHaveLength(17);
        expect(partnerInput.partnerCaptions).toHaveLength(17);
        expect(partnerInput.partnerCaptions?.map(row => row.selectionId)).toEqual(
            partnerInput.contactSheet?.sourceSelectionIds
        );
        expect(partnerInput.partnerCaptions?.reduce(
            (total, row) => total + row.text.length,
            0
        )).toBeLessThanOrEqual(2_000);
        expect(deps.mediaStore.persistBundle).toHaveBeenCalledWith(expect.objectContaining({
            bundleId: analysisV2PartnerSafetyBundleId(candidate.candidateId),
            media: expect.arrayContaining(partnerInput.contactSheet!.sourceSelectionIds.map(
                selectionId => expect.objectContaining({ selectionId })
            )),
        }));
        expect(deps.sourceMediaArchive.persistBundle).toHaveBeenCalledWith(
            expect.objectContaining({
                archiveId: analysisV2SourceMediaArchiveId({
                    candidateId: candidate.candidateId,
                    stage: 'partner_contact_remainder',
                }),
                media: expect.arrayContaining(partnerInput.contactSheet!.sourceSelectionIds.map(
                    selectionId => expect.objectContaining({ selectionId })
                )),
            })
        );
        expect(deps.sourceMediaArchive.persistBundle).toHaveBeenCalledWith(
            expect.objectContaining({
                archiveId: analysisV2SourceMediaArchiveId({
                    candidateId: candidate.candidateId,
                    stage: 'partner_contact_sheet',
                }),
                media: [{
                    selectionId: partnerInput.contactSheet!.selectionId,
                    normalizedJpeg: contactSheetJpeg,
                }],
            })
        );
        const remainderCall = vi.mocked(sourceMediaArchive.persistBundle).mock.calls.find(
            ([input]) => input.archiveId === analysisV2SourceMediaArchiveId({
                candidateId: candidate.candidateId,
                stage: 'partner_contact_remainder',
            })
        );
        const remainderSelectionIds = remainderCall?.[0].media.map(
            media => media.selectionId
        ) ?? [];
        const remainderIds = new Set(remainderSelectionIds);
        expect(remainderSelectionIds).toHaveLength(remainderIds.size);
        expect([...remainderIds].some(id => candidate.normalizedSelectionIds.includes(id)))
            .toBe(false);
        expect([...remainderIds].every(id => (
            partnerInput.contactSheet!.sourceSelectionIds.includes(id)
        ))).toBe(true);
        expect(partnerInput.contactSheet!.sourceSelectionIds.every(id => (
            candidate.normalizedSelectionIds.includes(id) || remainderIds.has(id)
        ))).toBe(true);
        const contactIds = new Set(partnerInput.contactSheet!.sourceSelectionIds);
        const exactCoveredContactIds = new Set([
            ...candidate.normalizedSelectionIds.filter(id => contactIds.has(id)),
            ...remainderIds,
        ]);
        expect([...exactCoveredContactIds].sort()).toEqual([...contactIds].sort());
        expect(vi.mocked(deps.resultStore.checkpointPartnerSafety).mock.calls[0]![0].rows[0])
            .toMatchObject({
                source: 'gemini',
                bundleId: analysisV2PartnerSafetyBundleId(candidate.candidateId),
                evidenceSelectionIds: [partnerInput.contactSheet!.sourceSelectionIds[0]],
            });
    });

    it.each([
        ['retained archive', 'ANALYSIS_V2_SOURCE_MEDIA_ARCHIVE_OBJECT_ERROR'],
        ['short-lived artifact', 'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR'],
    ] as const)(
        'runs partner AI concurrently but refuses its checkpoint when %s persistence fails',
        async (failureTarget, failureCode) => {
        const memoryState = memory();
        const candidate = completeCarouselOutcome('archive.failure');
        memoryState.outcomes = [candidate];
        memoryState.screening = {
            revision: 1,
            resultHash: digest('screening-partner-archive-failure'),
            shortlistHash: digest('shortlist-partner-archive-failure'),
            candidates: calculateV2PreliminaryScores({
                candidates: [{
                    candidateId: candidate.candidateId,
                    username: candidate.instagramId,
                    appearanceGrade: 3,
                    exposureScore: 1,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                    uniqueTargetPostsLikedByCandidate: 0,
                    boundedCandidateCommentsOnTarget: 0,
                    hasCandidateToTargetTagOrCaptionMention: false,
                    hasTargetToCandidateTagOrCaptionMention: false,
                }],
                orderedMutualUsernames: [candidate.instagramId],
                excludedUsername: null,
            }),
        };
        const deps = dependencies(memoryState, {
            createContactSheet: vi.fn(async (
                sources: readonly { selectionId: string; normalizedJpegBase64: string }[]
            ) => ({
                selectionId: `contact-sheet:${digest('archive-failure')}`,
                normalizedJpegBase64: Buffer.from([
                    0xff, 0xd8, 0x66, 0xff, 0xd9,
                ]).toString('base64'),
                sourceSelectionIds: sources.map(source => source.selectionId),
                width: 768,
                height: 960,
            })),
            sourceMediaArchive: {
                persistBundle: vi.fn(async () => {
                    if (failureTarget === 'retained archive') throw new Error(failureCode);
                }),
                loadBundle: vi.fn(async () => null),
            },
        });
        if (failureTarget === 'short-lived artifact') {
            deps.mediaStore.persistBundle = vi.fn(async () => {
                throw new Error(failureCode);
            });
        }

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).partner_safety!(
            context('partner_safety')
        )).rejects.toThrow(failureCode);
        expect(deps.ai.partnerSafety).toHaveBeenCalledOnce();
        expect(deps.resultStore.checkpointPartnerSafety).not.toHaveBeenCalled();
        expect(memoryState.partner).toBeNull();
        }
    );

    it('never treats a partially prepared carousel contact sheet as partner absence', async () => {
        const memoryState = memory();
        const candidate = verifiedOutcome('woman.carousel');
        candidate.profile = {
            ...candidate.profile!,
            postsCount: 1,
            latestPosts: [{
                id: 'carousel-post',
                shortCode: 'carouselpost',
                caption: 'carousel',
                imageUrl: 'https://cdninstagram.com/carousel/cover.jpg',
                type: 'carousel',
                mediaItems: Array.from({ length: 4 }, (_, index) => ({
                    id: `frame-${index + 1}`,
                    type: 'image' as const,
                    imageUrl: `https://cdninstagram.com/carousel/frame-${index + 1}.jpg`,
                })),
                declaredMediaCount: 4,
                childrenComplete: true,
                likesCount: 0,
                commentsCount: 0,
                timestamp: new Date(Date.UTC(2026, 6, 10)).toISOString(),
                taggedUsers: [],
                mentionedUsers: [],
            }],
        };
        memoryState.outcomes = [candidate];
        memoryState.screening = {
            revision: 1,
            resultHash: digest('screening-carousel'),
            shortlistHash: digest('shortlist-carousel'),
            candidates: calculateV2PreliminaryScores({
                candidates: [{
                    candidateId: candidate.candidateId,
                    username: candidate.instagramId,
                    appearanceGrade: 3,
                    exposureScore: 1,
                    accountContext: 'personal',
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                    uniqueTargetPostsLikedByCandidate: 0,
                    boundedCandidateCommentsOnTarget: 0,
                    hasCandidateToTargetTagOrCaptionMention: false,
                    hasTargetToCandidateTagOrCaptionMention: false,
                }],
                orderedMutualUsernames: [candidate.instagramId],
                excludedUsername: null,
            }),
        };
        const normalizeMedia = vi.fn(async () => {
            throw new AnalysisImagePreparationError('source_missing', 'permanent');
        });
        const deps = dependencies(memoryState, { normalizeMedia });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await registry.partner_safety!(context('partner_safety'));

        expect(deps.createContactSheet).not.toHaveBeenCalled();
        expect(deps.ai.partnerSafety).toHaveBeenCalledWith(
            expect.objectContaining({ contactSheet: null, partnerCaptions: [] }),
            expect.any(Object)
        );
        expect(memoryState.partner?.rows[0]).toMatchObject({
            result: { source: 'feature_only' },
            mediaCoverage: { selectedCount: 1, normalizedCount: 0 },
        });
    });

    it('defensively excludes the girlfriend and preserves the actual sanitized comment', async () => {
        const memoryState = memory();
        memoryState.outcomes = [verifiedOutcome('girlfriend'), verifiedOutcome('woman.one')];
        const evidenceRows = [
            {
                actorUsername: 'girlfriend', postId: 'target-post',
                signal: 'target_post_comment' as const, sourceInteractionId: 'comment-gf',
                occurredAt: null, content: '제외되어야 하는 댓글',
            },
            {
                actorUsername: 'woman.one', postId: 'target-post',
                signal: 'target_post_comment' as const, sourceInteractionId: 'comment-one',
                occurredAt: null, content: '오늘 사진 진짜 좋다',
            },
        ];
        const deps = dependencies(memoryState, {
            evidence: {
                loadRelationships: vi.fn(async () => relationshipSnapshot({
                    excluded: 'girlfriend', usernames: ['girlfriend', 'woman.one'],
                })),
                loadTargetEvidence: vi.fn(async () => targetEvidence(evidenceRows)),
            },
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);
        await registry.primary_join!(context('primary_join'));

        expect(memoryState.primary?.candidates).toHaveLength(1);
        expect(memoryState.primary?.candidates[0].instagramId).toBe('woman.one');
        expect(memoryState.primary?.candidates[0].interactions[0].content)
            .toBe('오늘 사진 진짜 좋다');
    });

    it('ranks recent mutuals among verified women only and freezes exactly the deterministic Top 10', async () => {
        const memoryState = memory();
        const women = Array.from({ length: 12 }, (_, index) => `woman.${index + 1}`);
        memoryState.outcomes = women.map(username => verifiedOutcome(username));
        memoryState.primary = {
            revision: 1,
            resultHash: digest('primary'),
            candidates: memoryState.outcomes.map(outcome => ({
                candidateId: outcome.candidateId,
                instagramId: outcome.instagramId,
                interactions: [],
            })),
        };
        const deps = dependencies(memoryState, {
            evidence: {
                loadRelationships: vi.fn(async () => relationshipSnapshot({
                    excluded: null,
                    usernames: ['male.first', ...women],
                })),
                loadTargetEvidence: vi.fn(async () => targetEvidence()),
            },
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);
        await registry.screening!(context('screening'));

        const firstWoman = memoryState.screening?.candidates.find(row => row.username === 'woman.1');
        expect(firstWoman?.recentFemaleMutualRank).toBe(1);
        const shortlist = memoryState.screening?.candidates
            .filter(row => row.verificationShortlistRank !== null) ?? [];
        expect(shortlist).toHaveLength(10);
        expect(new Set(shortlist.map(row => row.verificationShortlistRank)).size).toBe(10);
    });

    it('feeds only corroborated v2.8 official screening into the unchanged v2.4 ranking input', async () => {
        const provenance = {
            triageSelectedCount: 3,
            featureSelectedCount: 3,
            selectedKinds: {
                profile: 1,
                postRepresentative: 2,
                carouselContext: 0,
            },
        } as const;
        const screened = verifiedOutcome('band.account');
        screened.profile = {
            ...screened.profile!,
            fullName: 'Black Cherry Club',
            bio: 'Single [콜드브루] Out now',
        };
        screened.feature!.features.accountContext = 'official_group_or_brand';
        screened.aiStagePolicyVersion = 'ai-stage-policy-v2.8';
        screened.inputQualityPolicy = 'input-quality-v2.8';
        screened.mediaSelectionProvenance = provenance;
        screened.accountContextOverride = 'official_group_or_brand';
        screened.officialScreeningStatus = 'corroborated_official';
        screened.officialExclusionReason = 'model_group_context_plus_profile_signals';
        const uncorroborated = verifiedOutcome('person.club');
        uncorroborated.feature!.features.accountContext = 'official_group_or_brand';
        uncorroborated.aiStagePolicyVersion = 'ai-stage-policy-v2.8';
        uncorroborated.inputQualityPolicy = 'input-quality-v2.8';
        uncorroborated.mediaSelectionProvenance = provenance;
        uncorroborated.accountContextOverride = 'uncertain';
        uncorroborated.officialScreeningStatus = 'uncorroborated_official';
        uncorroborated.officialExclusionReason = null;
        const missingCheckpoint = verifiedOutcome('partial.checkpoint');
        missingCheckpoint.feature!.features.accountContext = 'official_group_or_brand';
        missingCheckpoint.aiStagePolicyVersion = 'ai-stage-policy-v2.8';
        missingCheckpoint.inputQualityPolicy = 'input-quality-v2.8';
        missingCheckpoint.mediaSelectionProvenance = provenance;
        const missingEntireCheckpoint = verifiedOutcome('missing.checkpoint');
        missingEntireCheckpoint.feature!.features.accountContext = 'official_group_or_brand';
        const screeningFieldsOnly = verifiedOutcome('screening.fields.only');
        screeningFieldsOnly.feature!.features.accountContext = 'official_group_or_brand';
        screeningFieldsOnly.accountContextOverride = 'official_group_or_brand';
        screeningFieldsOnly.officialScreeningStatus = 'corroborated_official';
        screeningFieldsOnly.officialExclusionReason =
            'model_group_context_plus_profile_signals';
        const forgedCoherent = verifiedOutcome('forged.coherent');
        forgedCoherent.feature!.features.accountContext = 'official_group_or_brand';
        forgedCoherent.aiStagePolicyVersion = 'ai-stage-policy-v2.8';
        forgedCoherent.inputQualityPolicy = 'input-quality-v2.8';
        forgedCoherent.mediaSelectionProvenance = provenance;
        forgedCoherent.accountContextOverride = 'official_group_or_brand';
        forgedCoherent.officialScreeningStatus = 'corroborated_official';
        forgedCoherent.officialExclusionReason =
            'model_group_context_plus_profile_signals';
        const memoryState = memory();
        memoryState.outcomes = [
            screened,
            uncorroborated,
            missingCheckpoint,
            missingEntireCheckpoint,
            screeningFieldsOnly,
            forgedCoherent,
        ];
        memoryState.primary = {
            revision: 1,
            resultHash: digest('primary'),
            candidates: memoryState.outcomes.map(outcome => ({
                candidateId: outcome.candidateId,
                instagramId: outcome.instagramId,
                interactions: [],
            })),
        };
        const deps = dependencies(memoryState, {
            evidence: {
                loadRelationships: vi.fn(async () => relationshipSnapshot({
                    excluded: null,
                    usernames: [
                        screened.instagramId,
                        uncorroborated.instagramId,
                        missingCheckpoint.instagramId,
                        missingEntireCheckpoint.instagramId,
                        screeningFieldsOnly.instagramId,
                        forgedCoherent.instagramId,
                    ],
                })),
                loadTargetEvidence: vi.fn(async () => targetEvidence()),
            },
        });

        await createAnalysisV2AiScoringExecutorRegistry(deps).screening!(context('screening', {
            aiStagePolicyVersion: 'ai-stage-policy-v2.8',
        }));

        expect(memoryState.screening?.candidates.map(candidate => ({
            username: candidate.username,
            accountContext: candidate.accountContext,
        }))).toEqual([
            { username: 'band.account', accountContext: 'official_group_or_brand' },
            { username: 'person.club', accountContext: 'uncertain' },
            { username: 'partial.checkpoint', accountContext: 'uncertain' },
            { username: 'missing.checkpoint', accountContext: 'uncertain' },
            { username: 'screening.fields.only', accountContext: 'uncertain' },
            { username: 'forged.coherent', accountContext: 'uncertain' },
        ]);
    });

    it.each([
        'ai-stage-policy-v2.6',
        'ai-stage-policy-v2.7',
    ])('preserves clean legacy official context under %s', async aiStagePolicyVersion => {
        const legacyOfficial = verifiedOutcome('legacy.official');
        legacyOfficial.feature!.features.accountContext = 'official_group_or_brand';
        legacyOfficial.accountContextOverride = 'uncertain';
        legacyOfficial.officialScreeningStatus = 'uncorroborated_official';
        legacyOfficial.officialExclusionReason = null;
        const memoryState = memory();
        memoryState.outcomes = [legacyOfficial];
        memoryState.primary = {
            revision: 1,
            resultHash: digest('legacy-primary'),
            candidates: [{
                candidateId: legacyOfficial.candidateId,
                instagramId: legacyOfficial.instagramId,
                interactions: [],
            }],
        };
        const deps = dependencies(memoryState, {
            evidence: {
                loadRelationships: vi.fn(async () => relationshipSnapshot({
                    excluded: null,
                    usernames: [legacyOfficial.instagramId],
                })),
                loadTargetEvidence: vi.fn(async () => targetEvidence()),
            },
        });

        await createAnalysisV2AiScoringExecutorRegistry(deps).screening!(context('screening', {
            aiStagePolicyVersion,
        }));

        expect(memoryState.screening?.candidates[0]?.accountContext)
            .toBe('official_group_or_brand');
    });

    it('defers the weak-partner adjustment until final scoring', async () => {
        const memoryState = memory();
        const weakCandidate = verifiedOutcome('woman.weak', { weakPartner: true });
        memoryState.outcomes = [weakCandidate];
        memoryState.primary = {
            revision: 1,
            resultHash: digest('primary'),
            candidates: [{
                candidateId: weakCandidate.candidateId,
                instagramId: weakCandidate.instagramId,
                interactions: [],
            }],
        };
        const deps = dependencies(memoryState, {
            evidence: {
                loadRelationships: vi.fn(async () => relationshipSnapshot({
                    excluded: null,
                    usernames: [weakCandidate.instagramId],
                })),
                loadTargetEvidence: vi.fn(async () => targetEvidence()),
            },
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await registry.screening!(context('screening'));

        const publicRow = vi.mocked(deps.resultStore.checkpointPreliminaryScores)
            .mock.calls[0]![0].rows[0]!;
        const componentTotal = Object.values(publicRow.components)
            .reduce((total, component) => total + component, 0);
        expect(publicRow.preScore).toBe(componentTotal);
        expect(memoryState.screening?.candidates[0]).toMatchObject({
            hasWeakPartnerEvidence: true,
            preScore: componentTotal,
        });

        const final = calculateV2FinalScores({
            preliminary: memoryState.screening!.candidates,
            observedReverseLikeCandidateIds: new Set(),
        });
        expect(final[0]!.risk).toMatchObject({
            weakPartnerAdjustment: -5,
            preScore: Math.max(0, componentTotal - 5),
        });
    });

    it('checkpoints every candidate publicly while keeping paid verification frozen to Top 10', async () => {
        const memoryState = memory();
        const women = Array.from({ length: 12 }, (_, index) => `woman.${index + 1}`);
        memoryState.outcomes = women.map((username, index) => verifiedOutcome(
            username,
            {
                weakPartner: index === 0,
                strongPartner: index === women.length - 1,
            }
        ));
        const preliminary = calculateV2PreliminaryScores({
            candidates: memoryState.outcomes.map(outcome => ({
                candidateId: outcome.candidateId,
                username: outcome.instagramId,
                appearanceGrade: 4,
                exposureScore: 2,
                accountContext: 'personal',
                hasWeakPartnerEvidence:
                    outcome.feature!.features.marriageEvidence === 'possible',
                hasStrongPartnerEvidence:
                    outcome.feature!.features.marriageEvidence === 'strong',
                uniqueTargetPostsLikedByCandidate: 0,
                boundedCandidateCommentsOnTarget: 0,
                hasCandidateToTargetTagOrCaptionMention: false,
                hasTargetToCandidateTagOrCaptionMention: false,
            })),
            orderedMutualUsernames: women,
            excludedUsername: null,
        });
        memoryState.screening = {
            revision: 1,
            resultHash: digest('screening'),
            shortlistHash: digest('shortlist'),
            candidates: preliminary,
        };
        const operationKey = `candidate-likers:${digest('top-ten')}`;
        const deps = dependencies(memoryState, {
            reverseLikes: {
                collect: vi.fn(async (
                    input: Parameters<
                        AnalysisV2AiScoringExecutorDependencies['reverseLikes']['collect']
                    >[0]
                ) => ({
                    operationKey,
                    results: input.candidates.map((candidate: { candidateId: string }) => ({
                        candidateId: candidate.candidateId,
                        status: 'not_observed' as const,
                    })),
                })),
            },
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        const reverseOutput = await registry.reverse_likes!(context('reverse_likes'));
        const publicReverse = vi.mocked(deps.resultStore.checkpointReverseLikes)
            .mock.calls[0]![0].rows;
        const nonShortlisted = new Set(preliminary
            .filter(row => row.verificationShortlistRank === null)
            .map(row => row.candidateId));
        expect(vi.mocked(deps.reverseLikes.collect).mock.calls[0]![0].candidates)
            .toHaveLength(10);
        expect(memoryState.reverse?.rows).toHaveLength(10);
        expect(publicReverse).toHaveLength(12);
        const unverifiedReverse = publicReverse.filter(
            row => nonShortlisted.has(row.candidateId)
        );
        expect(unverifiedReverse).toHaveLength(2);
        expect(unverifiedReverse.every(row => (
            row.status === 'not_collected' && row.componentScore === 0
        ))).toBe(true);
        expect(reverseOutput.checkpoint.manifest.resultHash).toBe(digest('reverse'));

        const partnerOutput = await registry.partner_safety!(context('partner_safety'));
        const publicPartner = vi.mocked(deps.resultStore.checkpointPartnerSafety)
            .mock.calls[0]![0].rows;
        expect(memoryState.partner?.rows).toHaveLength(10);
        expect(publicPartner).toHaveLength(12);
        const unverifiedPartner = publicPartner.filter(
            row => nonShortlisted.has(row.candidateId)
        );
        expect(unverifiedPartner).toHaveLength(2);
        expect(unverifiedPartner.every(row => row.source === 'not_collected')).toBe(true);
        expect(partnerOutput.checkpoint.manifest.resultHash).toBe(digest('partner'));

        await registry.final_score!(context('final_score'));
        const strongCandidate = memoryState.outcomes.at(-1)!;
        const publicPartnerStrong = publicPartner.find(
            row => row.candidateId === strongCandidate.candidateId
        );
        const publicScoreStrong = vi.mocked(deps.resultStore.checkpointScores)
            .mock.calls[0]![0].rows.find(
                row => row.candidateId === strongCandidate.candidateId
            );
        expect(publicPartnerStrong).toMatchObject({
            source: 'not_collected',
            hasStrongPartnerEvidence: true,
            strongEvidenceBasis: 'feature',
            evidenceSelectionIds: [`profile:${strongCandidate.instagramId}`],
        });
        expect(publicScoreStrong?.partnerEvidenceSelectionIds)
            .toEqual(publicPartnerStrong?.evidenceSelectionIds);
        expect(publicScoreStrong?.accountContext).toBe('personal');
        const weakCandidate = memoryState.outcomes[0];
        const publicPartnerWeak = publicPartner.find(
            row => row.candidateId === weakCandidate.candidateId
        );
        const publicScoreWeak = vi.mocked(deps.resultStore.checkpointScores)
            .mock.calls[0]![0].rows.find(
                row => row.candidateId === weakCandidate.candidateId
            );
        expect(publicPartnerWeak).toMatchObject({
            hasWeakPartnerEvidence: true,
            hasStrongPartnerEvidence: false,
            evidenceSelectionIds: [`profile:${weakCandidate.instagramId}`],
        });
        expect(publicScoreWeak).toMatchObject({ weakPartnerAdjustment: -5 });
        const tenthRecent = preliminary.find(row => row.recentFemaleMutualRank === 10)!;
        expect(tenthRecent.recentMutualBadgeRank).toBeNull();
        expect(vi.mocked(deps.resultStore.checkpointScores).mock.calls[0]![0].rows.find(
            row => row.candidateId === tenthRecent.candidateId
        )?.recentMutualRank).toBe(10);
    });

    it('keeps missing reverse-like evidence as not_collected instead of inferring no relationship', async () => {
        const memoryState = memory();
        const candidate = verifiedOutcome('woman.one');
        memoryState.outcomes = [candidate];
        const preliminary = calculateV2PreliminaryScores({
            candidates: [{
                candidateId: candidate.candidateId,
                username: candidate.instagramId,
                appearanceGrade: 5,
                exposureScore: 5,
                accountContext: 'personal',
                hasWeakPartnerEvidence: false,
                hasStrongPartnerEvidence: false,
                uniqueTargetPostsLikedByCandidate: 4,
                boundedCandidateCommentsOnTarget: 12,
                hasCandidateToTargetTagOrCaptionMention: true,
                hasTargetToCandidateTagOrCaptionMention: false,
            }],
            orderedMutualUsernames: [candidate.instagramId],
            excludedUsername: null,
        });
        memoryState.screening = {
            revision: 1, resultHash: digest('screening'), shortlistHash: digest('shortlist'),
            candidates: preliminary,
        };
        memoryState.reverse = {
            revision: 1, resultHash: digest('reverse'),
            rows: [{ candidateId: candidate.candidateId, shortlistRank: 1, status: 'not_collected', operationKey: null }],
        };
        memoryState.partner = {
            revision: 1, resultHash: digest('partner'),
            rows: [{
                candidateId: candidate.candidateId, shortlistRank: 1,
                result: partnerResult(), operationKey: null, resultHash: null,
                mediaCoverage: { selectedCount: 0, normalizedCount: 0, failures: [] },
            }],
        };
        const deps = dependencies(memoryState);
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);
        await expect(registry.final_score!(context('final_score')))
            .resolves.toMatchObject({ checkpoint: { kind: 'final_score' } });

        expect(memoryState.final?.candidates[0].reverseLikeStatus).toBe('not_collected');
        expect(memoryState.final?.candidates[0].risk.possibleUpperBound)
            .toBe(memoryState.final!.candidates[0].risk.preScore + 5);
    });

    it('reuses the exact private bundle for narrative grounding and never redownloads Instagram media', async () => {
        const memoryState = memory();
        const candidate = completeCarouselOutcome('woman.one');
        const selectedCaptionIds = [0, 10, 19].map(index => (
            `post:carousel-post:media:${index}:frame-${index + 1}`
        ));
        candidate.feature = {
            ...candidate.feature!,
            analyzedSelectionIds: selectedCaptionIds,
        };
        candidate.normalizedSelectionIds = selectedCaptionIds;
        candidate.captions = selectedCaptionIds.map((selectionId, index) => ({
            evidenceRefId: `caption:${digest(`selected-caption-${index}`)}`,
            selectionId,
            text: `selected caption ${index + 1}`,
        }));
        memoryState.outcomes = [candidate];
        memoryState.reverse = {
            revision: 1, resultHash: digest('reverse'),
            rows: [{ candidateId: candidate.candidateId, shortlistRank: 1, status: 'observed_not_found', operationKey: 'provider-op' }],
        };
        memoryState.final = {
            revision: 1,
            resultHash: digest('final'),
            candidates: [],
            narrativeCandidateIds: [candidate.candidateId],
            narrativeBatchHash: digest('narrative-batch'),
        };
        const actualComment = '오늘 사진 진짜 예쁘다';
        const normalizeMedia = vi.fn(async () => Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
        const narrative = vi.fn(async (
            input: Parameters<AnalysisV2AiStageRuntime['narrative']>[0]
        ) => {
            void input;
            return ({ result: {
                lines: ['차분한 일상을 기록하는 계정이에요.', `실제 댓글 '${actualComment}'가 눈에 띄네요.`] as [string, string],
                evidenceRefs: [['profile:bio'], ['evidence:comment']] as [string[], string[]],
                source: 'gemini' as const,
            },
            operationKey: `high-risk-narrative:${digest('narrative')}`,
            resultHash: digest('narrative-result'),
            source: 'checkpoint' as const,
            });
        });
        const deps = dependencies(memoryState, {
            normalizeMedia,
            evidence: {
                loadRelationships: vi.fn(async () => relationshipSnapshot()),
                loadTargetEvidence: vi.fn(async () => targetEvidence([{
                    actorUsername: 'woman.one', postId: 'target-post',
                    signal: 'target_post_comment', sourceInteractionId: 'comment-1',
                    occurredAt: null, content: actualComment,
                }])),
            },
        });
        deps.ai.narrative = narrative;
        deps.mediaStore.loadBundle = vi.fn(async (
            input: Parameters<AnalysisV2MediaArtifactStore['loadBundle']>[0]
        ) => input.expectedSelectionIds.map((selectionId: string) => ({
            selectionId,
            normalizedJpeg: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
        })));
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);
        await registry.narrative!(context('narrative'));

        expect(normalizeMedia).not.toHaveBeenCalled();
        expect(deps.mediaStore.loadBundle).toHaveBeenCalledWith(expect.objectContaining({
            bundleId: analysisV2CandidateBundleId(candidate.candidateId),
            expectedSelectionIds: candidate.feature!.analyzedSelectionIds,
        }));
        const narrativeInput = narrative.mock.calls[0]![0];
        expect(narrative).toHaveBeenCalledOnce();
        expect(narrativeInput.interactions.comments[0].text).toBe(actualComment);
        expect(narrativeInput.captions).toEqual(candidate.captions);
        expect(narrativeInput.carouselCaptionDossier?.text).toContain('[슬라이드 1]');
        expect(narrativeInput.carouselCaptionDossier?.text.length).toBeLessThanOrEqual(2_000);
        expect(memoryState.narrative?.rows[0].lines[1]).toContain(actualComment);
    });
});

describe('V2 retained result image finalization', () => {
    function strictFinalizerState(screenedCount: number) {
        const relationshipResultHash = digest(`strict-relationships:${screenedCount}`);
        return state({
            relationships: {
                revision: 1,
                resultHash: relationshipResultHash,
                detectedMutualCount: screenedCount,
                publicCount: screenedCount,
                privateCount: 0,
                detailedSelectedPublicCount: screenedCount,
                notScreenedPublicCount: 0,
                profileBatches: [{
                    batch: 0,
                    itemCount: screenedCount,
                    inputHash: digest(`strict-profile:${screenedCount}`),
                }],
                privateNameBatches: [],
                relationshipSelectionPolicy: {
                    policyVersion: 'gender-routing-v1',
                    relationshipCheckpointId: relationshipResultHash,
                    relationshipJobInputHash: digest(`strict-relationship-input:${screenedCount}`),
                    planId: 'basic',
                    publicPopulationCount: screenedCount,
                    selectedCount: screenedCount,
                },
            },
        });
    }

    function unresolvedOutcome(username: string): AnalysisV2ProfileAiOutcome {
        const baseline = verifiedOutcome(username);
        const mediaIds = baseline.normalizedSelectionIds;
        return {
            ...baseline,
            status: 'unresolved',
            baselineClassification: 'unresolved',
            classificationSource: 'unknown',
            feature: feature(mediaIds, 'unresolved'),
            genderResolutionStatus: 'not_eligible',
            genderResolutionOperationKey: null,
            genderResolutionResultHash: null,
            mediaBundlePersisted: false,
        };
    }

    function unavailableOutcome(
        username: string,
        status: 'analysis_unavailable' | 'media_unavailable' | 'fetch_unavailable',
    ): AnalysisV2ProfileAiOutcome {
        const baseline = verifiedOutcome(username);
        return {
            ...baseline,
            status,
            unavailableReason: status === 'analysis_unavailable' ? 'ai_response'
                : status === 'fetch_unavailable' ? 'profile_fetch' : null,
            profile: status === 'fetch_unavailable' ? null : baseline.profile,
            triage: null,
            feature: null,
            normalizedSelectionIds: [],
            mediaCoverage: { selectedCount: 0, normalizedCount: 0, failures: [] },
            captions: [],
            genderOperationKey: null,
            genderResultHash: null,
            featureOperationKey: null,
            featureResultHash: null,
            baselineClassification: status,
            classificationSource: 'unavailable',
            genderResolutionStatus: 'not_eligible',
            genderResolutionOperationKey: null,
            genderResolutionResultHash: null,
            mediaBundlePersisted: false,
        };
    }

    function strictResolverAdmission(capacityLimit: 20 | 40 = 20) {
        return {
            capacityLimit,
            begin: vi.fn(async () => 'accepted' as const),
            reserve: vi.fn(async () => 'accepted' as const),
            complete: vi.fn(async (): Promise<'approved' | 'manual_review'> => 'approved'),
        };
    }

    it('defers otherwise eligible strict profile resolver work until the primary unknown-burden checkpoint', async () => {
        const memoryState = memory();
        const account = profile('strict.deferred');
        const deps = dependencies(memoryState, {
            profileBatches: {
                loadExactBatch: vi.fn(async () => ({
                    requestedUsernames: [account.username],
                    results: [{
                        username: account.username,
                        status: 'success' as const,
                        profile: account,
                    }],
                })),
            },
        });
        const strictState = {
            ...strictFinalizerState(1),
            profileFetchBatches: [{
                batch: 0,
                itemCount: 1,
                producerInputHash: digest('strict-deferred-producer'),
                revision: 1,
                resultHash: digest('strict-deferred-profile'),
            }],
        };

        await createAnalysisV2AiScoringExecutorRegistry(deps).profile_ai!(context('profile_ai', {
            jobKey: 'track:profile-ai:batch:0',
            batch: 0,
            state: strictState,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        }));

        expect(deps.ai.gender).toHaveBeenCalledOnce();
        expect(deps.ai.features).toHaveBeenCalledOnce();
        expect(deps.ai.startGenderResolution).not.toHaveBeenCalled();
        expect(memoryState.outcomes[0]).toMatchObject({
            baselineClassification: 'verified_female',
            genderResolutionStatus: 'not_eligible',
        });
    });

    it('uses only the durable primary quality receipt at strict finalization and suppresses completion on manual review', async () => {
        const memoryState = memory();
        const verify = vi.fn(async () => 'manual_review' as const);
        const admission = strictResolverAdmission();
        const completed = vi.fn(async () => undefined);
        const deps = dependencies(memoryState, {
            revenueFinalQualityGate: {
                isApplicable: vi.fn(async () => true),
                verify,
                evaluate: vi.fn(async () => 'approved' as const),
            },
            revenueResolverCapacity: { bind: vi.fn(async () => admission) },
            analysisLifecycleEventEmitter: completed,
        } as never);
        const strictState = strictFinalizerState(1);

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).finalize!(context('finalize', {
            jobKey: 'coordinator:finalize',
            state: strictState,
        }))).rejects.toThrow('ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_FAILED');

        expect(verify).toHaveBeenCalledWith(expect.objectContaining({
            jobKey: 'coordinator:finalize',
        }));
        expect(vi.mocked(deps.revenueResolverCapacity!.bind)).not.toHaveBeenCalled();
        expect(deps.resultStore.finalize).not.toHaveBeenCalled();
        expect(completed).not.toHaveBeenCalled();
    });

    it('keeps a strict primary join at the exact thirty-percent boundary resolver-free', async () => {
        const memoryState = memory();
        memoryState.outcomes = [
            ...Array.from({ length: 7 }, (_, index) => verifiedOutcome(`verified.${index}`)),
            ...Array.from({ length: 3 }, (_, index) => unresolvedOutcome(`unknown.${index}`)),
        ];
        const admission = strictResolverAdmission();
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind: vi.fn(async () => admission) },
        } as never);

        await createAnalysisV2AiScoringExecutorRegistry(deps).primary_join!(context('primary_join', {
            jobKey: 'coordinator:join:primary-evidence',
            state: strictFinalizerState(10),
        }));

        expect(admission.begin).not.toHaveBeenCalled();
        expect(admission.reserve).not.toHaveBeenCalled();
        expect(deps.ai.startGenderResolution).not.toHaveBeenCalled();
        expect(admission.complete).toHaveBeenCalledWith(expect.objectContaining({
            initialUnknownBurdenCount: 3,
            finalUnknownBurdenCount: 3,
            coverageValid: true,
            resolverPassStarted: false,
        }));
        expect(deps.resultStore.checkpointRevenueResolverOutcomes).not.toHaveBeenCalled();
        expect(memoryState.primary?.candidates).toHaveLength(7);
    });

    it('handles a strict screened-zero cohort without beginning a resolver pass', async () => {
        const memoryState = memory();
        const admission = strictResolverAdmission();
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind: vi.fn(async () => admission) },
        } as never);

        await createAnalysisV2AiScoringExecutorRegistry(deps).primary_join!(context('primary_join', {
            jobKey: 'coordinator:join:primary-evidence',
            state: strictFinalizerState(0),
        }));

        expect(admission.begin).not.toHaveBeenCalled();
        expect(admission.reserve).not.toHaveBeenCalled();
        expect(deps.ai.startGenderResolution).not.toHaveBeenCalled();
        expect(admission.complete).toHaveBeenCalledWith({
            publicMutualCount: 0,
            screenedCount: 0,
            notScreenedCount: 0,
            initialUnknownBurdenCount: 0,
            finalUnknownBurdenCount: 0,
            coverageValid: true,
            resolverPassStarted: false,
        });
        expect(memoryState.primary?.candidates).toEqual([]);
    });

    it('runs one Basic primary-join resolver pass in approved priority order and never consumes more than twenty request slots', async () => {
        const memoryState = memory();
        memoryState.outcomes = [
            unavailableOutcome('analysis.unavailable', 'analysis_unavailable'),
            unavailableOutcome('media.unavailable', 'media_unavailable'),
            unavailableOutcome('fetch.unavailable', 'fetch_unavailable'),
            ...Array.from({ length: 22 }, (_, index) => unresolvedOutcome(
                `other.${String(index + 1).padStart(2, '0')}`,
            )),
        ];
        const admission = strictResolverAdmission(20);
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind: vi.fn(async () => admission) },
        } as never);
        deps.ai.startGenderResolution = vi.fn((
            input: Parameters<AnalysisV2AiStageRuntime['startGenderResolution']>[0],
        ) => ({
            operationKey: `gender-resolution:${digest(input.media[0]!.selectionId)}`,
            completion: Promise.resolve(),
            peek: () => ({
                status: 'ready' as const,
                value: {
                    result: {
                        assessment: {
                            inferredGender: 'female' as const,
                            confidence: 'high' as const,
                            ownerConsistency: 'same_person' as const,
                            evidenceSelectionIds: input.media.slice(0, 2).map(row => row.selectionId),
                        },
                        analyzedSelectionIds: input.media.map(row => row.selectionId),
                    },
                    operationKey: `gender-resolution:${digest(input.media[0]!.selectionId)}`,
                    resultHash: digest(`resolver:${input.media[0]!.selectionId}`),
                    source: 'checkpoint' as const,
                },
            }),
            cutoff: vi.fn(async () => undefined),
        }));

        await createAnalysisV2AiScoringExecutorRegistry(deps).primary_join!(context('primary_join', {
            jobKey: 'coordinator:join:primary-evidence',
            state: strictFinalizerState(25),
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        }));

        expect(admission.begin).toHaveBeenCalledOnce();
        expect(admission.begin).toHaveBeenCalledWith(expect.objectContaining({
            screenedCount: 25,
            unknownBurdenCount: 25,
        }));
        expect(admission.reserve).toHaveBeenCalledTimes(20);
        const resolverProfiles = vi.mocked(deps.ai.startGenderResolution).mock.calls.map(
            ([input]) => input.media[0]!.selectionId,
        );
        expect(resolverProfiles).toEqual([
            'profile:analysis.unavailable',
            'profile:media.unavailable',
            ...Array.from({ length: 18 }, (_, index) => (
                `profile:other.${String(index + 1).padStart(2, '0')}`
            )),
        ]);
        expect(resolverProfiles).not.toContain('profile:fetch.unavailable');
        expect(admission.complete).toHaveBeenCalledWith(expect.objectContaining({
            initialUnknownBurdenCount: 25,
            finalUnknownBurdenCount: 5,
            coverageValid: true,
            resolverPassStarted: true,
        }));
        expect(deps.resultStore.checkpointRevenueResolverOutcomes).toHaveBeenCalledOnce();
        expect(memoryState.primary?.candidates).toHaveLength(20);
    });

    it('resolves featureless analysis/media outages, skips fetch, and keeps only featureful women in screening', async () => {
        const memoryState = memory();
        const analysisUnavailable = unavailableOutcome(
            'analysis.unavailable',
            'analysis_unavailable',
        );
        const mediaUnavailable = unavailableOutcome(
            'media.unavailable',
            'media_unavailable',
        );
        const fetchUnavailable = unavailableOutcome(
            'fetch.unavailable',
            'fetch_unavailable',
        );
        const otherUnknown = unresolvedOutcome('other.unknown');
        memoryState.outcomes = [
            ...Array.from({ length: 6 }, (_, index) => verifiedOutcome(`verified.${index}`)),
            analysisUnavailable,
            mediaUnavailable,
            fetchUnavailable,
            otherUnknown,
        ];
        const admission = strictResolverAdmission();
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind: vi.fn(async () => admission) },
        } as never);
        deps.ai.startGenderResolution = vi.fn((
            input: Parameters<AnalysisV2AiStageRuntime['startGenderResolution']>[0],
        ) => {
            const selectionId = input.media[0]!.selectionId;
            return {
                operationKey: `gender-resolution:${digest(`resolver:${selectionId}`)}`,
                completion: Promise.resolve(),
                peek: () => ({
                    status: 'ready' as const,
                    value: {
                        result: {
                            assessment: {
                                inferredGender: 'female' as const,
                                confidence: 'high' as const,
                                ownerConsistency: 'same_person' as const,
                                evidenceSelectionIds: input.media.slice(0, 2).map(row => row.selectionId),
                            },
                            analyzedSelectionIds: input.media.map(row => row.selectionId),
                        },
                        operationKey: `gender-resolution:${digest(`resolver:${selectionId}`)}`,
                        resultHash: digest(`resolver-result:${selectionId}`),
                        source: 'checkpoint' as const,
                    },
                }),
                cutoff: vi.fn(async () => undefined),
            };
        });
        const strictState = strictFinalizerState(10);
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await registry.primary_join!(context('primary_join', {
            jobKey: 'coordinator:join:primary-evidence',
            state: strictState,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        }));

        const resolverProfiles = vi.mocked(deps.ai.startGenderResolution).mock.calls.map(
            ([input]) => input.media[0]!.selectionId,
        );
        // analysis/media are attempted with freshly normalized profile media;
        // no-profile fetch is skipped and the subsequent "other" candidate
        // still receives its opportunity.
        expect(resolverProfiles).toEqual([
            'profile:analysis.unavailable',
            'profile:media.unavailable',
            'profile:other.unknown',
        ]);
        expect(admission.complete).toHaveBeenCalledWith(expect.objectContaining({
            initialUnknownBurdenCount: 4,
            finalUnknownBurdenCount: 1,
            coverageValid: true,
        }));
        const overlayRows = memoryState.resolverPatches;
        expect(overlayRows.map(row => row.candidateId)).toEqual([
            analysisUnavailable.candidateId,
            mediaUnavailable.candidateId,
            otherUnknown.candidateId,
        ]);
        expect(overlayRows.every(row => !Object.hasOwn(row, 'feature'))).toBe(true);
        expect(vi.mocked(deps.resultStore.checkpointRevenueResolverOutcomes))
            .toHaveBeenCalledWith(expect.objectContaining({
                rows: expect.arrayContaining([
                    expect.not.objectContaining({ feature: expect.anything() }),
                ]),
            }));
        // Both featureless women are durable membership, while the fetch
        // outage remains unknown.  Only the formerly unresolved, featureful
        // candidate needs a retained detail bundle.
        expect(memoryState.primary?.candidates.map(row => row.candidateId)).toEqual([
            ...Array.from({ length: 6 }, (_, index) => analysisV2CandidateId(`verified.${index}`)),
            analysisUnavailable.candidateId,
            mediaUnavailable.candidateId,
            otherUnknown.candidateId,
        ]);
        expect(deps.mediaStore.persistBundle).toHaveBeenCalledTimes(1);

        await registry.screening!(context('screening', {
            jobKey: 'coordinator:candidate-screening',
            state: strictState,
        }));
        expect(memoryState.screening?.candidates.map(row => row.candidateId)).toEqual([
            ...Array.from({ length: 6 }, (_, index) => analysisV2CandidateId(`verified.${index}`)),
            otherUnknown.candidateId,
        ]);
        expect(memoryState.screening?.candidates.map(row => row.candidateId)).not.toContain(
            analysisUnavailable.candidateId,
        );
        expect(memoryState.screening?.candidates.map(row => row.candidateId)).not.toContain(
            mediaUnavailable.candidateId,
        );
    });

    it('bubbles a strict primary resolver recovery-pending state without checkpointing manual review', async () => {
        const memoryState = memory();
        memoryState.outcomes = [
            ...Array.from({ length: 6 }, (_, index) => verifiedOutcome(`verified.${index}`)),
            ...Array.from({ length: 4 }, (_, index) => unresolvedOutcome(`unknown.${index}`)),
        ];
        const admission = strictResolverAdmission();
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind: vi.fn(async () => admission) },
        } as never);
        deps.ai.startGenderResolution = vi.fn(() => ({
            operationKey: `gender-resolution:${digest('primary-recovery-pending')}`,
            completion: Promise.resolve(),
            peek: () => ({ status: 'recovery_pending' as const }),
            cutoff: vi.fn().mockResolvedValue(undefined),
        }));

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).primary_join!(context('primary_join', {
            jobKey: 'coordinator:join:primary-evidence',
            state: strictFinalizerState(10),
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        }))).rejects.toThrow('ANALYSIS_V2_AI_RESULT_RECOVERY_PENDING');

        expect(admission.begin).toHaveBeenCalledOnce();
        expect(admission.reserve).toHaveBeenCalledOnce();
        expect(admission.complete).not.toHaveBeenCalled();
        expect(deps.resultStore.checkpointRevenueResolverOutcomes).not.toHaveBeenCalled();
        expect(memoryState.primary).toBeNull();
    });

    it('replays featureless resolver overlays by audited identity without another model call or feature payload', async () => {
        const memoryState = memory();
        const analysisUnavailable = unavailableOutcome(
            'analysis.replay',
            'analysis_unavailable',
        );
        const mediaUnavailable = unavailableOutcome(
            'media.replay',
            'media_unavailable',
        );
        const fetchUnavailable = unavailableOutcome(
            'fetch.replay',
            'fetch_unavailable',
        );
        const otherUnknown = unresolvedOutcome('other.replay');
        memoryState.outcomes = [
            ...Array.from({ length: 6 }, (_, index) => verifiedOutcome(`replay.verified.${index}`)),
            analysisUnavailable,
            mediaUnavailable,
            fetchUnavailable,
            otherUnknown,
        ];
        const admission = strictResolverAdmission();
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind: vi.fn(async () => admission) },
        } as never);
        deps.ai.startGenderResolution = vi.fn((
            input: Parameters<AnalysisV2AiStageRuntime['startGenderResolution']>[0],
        ) => {
            const selectionId = input.media[0]!.selectionId;
            const operationKey = `gender-resolution:${digest(`replay:${selectionId}`)}`;
            return {
                operationKey,
                completion: Promise.resolve(),
                peek: () => ({
                    status: 'ready' as const,
                    value: {
                        result: {
                            assessment: {
                                inferredGender: 'female' as const,
                                confidence: 'high' as const,
                                ownerConsistency: 'same_person' as const,
                                evidenceSelectionIds: input.media.slice(0, 2).map(row => row.selectionId),
                            },
                            analyzedSelectionIds: input.media.map(row => row.selectionId),
                        },
                        operationKey,
                        resultHash: digest(`replay-result:${selectionId}`),
                        source: 'checkpoint' as const,
                    },
                }),
                cutoff: vi.fn(async () => undefined),
            };
        });
        const strictState = strictFinalizerState(10);
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);
        const primaryContext = context('primary_join', {
            jobKey: 'coordinator:join:primary-evidence',
            state: strictState,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        await registry.primary_join!(primaryContext);
        const persistedIdentity = memoryState.resolverPatches.map(row => ({
            candidateId: row.candidateId,
            operationKey: row.operationKey,
            resultHash: row.resultHash,
        }));
        const modelCallsBeforeReplay = vi.mocked(deps.ai.startGenderResolution).mock.calls.length;
        const reserveCallsBeforeReplay = admission.reserve.mock.calls.length;

        // Simulates a crash after overlay persistence but before the primary
        // job's terminal acknowledgement. Loading the immutable overlay makes
        // all successful rows terminal before the resolver loop starts.
        await registry.primary_join!(primaryContext);

        expect(vi.mocked(deps.ai.startGenderResolution)).toHaveBeenCalledTimes(
            modelCallsBeforeReplay,
        );
        expect(admission.reserve).toHaveBeenCalledTimes(reserveCallsBeforeReplay);
        expect(memoryState.resolverPatches.map(row => ({
            candidateId: row.candidateId,
            operationKey: row.operationKey,
            resultHash: row.resultHash,
        }))).toEqual(persistedIdentity);
        expect(memoryState.resolverPatches.every(row => !Object.hasOwn(row, 'feature')))
            .toBe(true);
    });

    it('durably blocks the primary join when the single resolver pass leaves the unknown burden above thirty percent', async () => {
        const memoryState = memory();
        memoryState.outcomes = [
            ...Array.from({ length: 6 }, (_, index) => verifiedOutcome(`verified.${index}`)),
            ...Array.from({ length: 4 }, (_, index) => unresolvedOutcome(`unknown.${index}`)),
        ];
        const admission = strictResolverAdmission();
        admission.complete.mockResolvedValue('manual_review');
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind: vi.fn(async () => admission) },
        } as never);

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).primary_join!(context('primary_join', {
            jobKey: 'coordinator:join:primary-evidence',
            state: strictFinalizerState(10),
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        }))).rejects.toThrow('ANALYSIS_V2_REVENUE_PRIMARY_QUALITY_FAILED');

        expect(admission.begin).toHaveBeenCalledOnce();
        expect(admission.reserve).toHaveBeenCalledTimes(4);
        expect(admission.complete).toHaveBeenCalledWith(expect.objectContaining({
            initialUnknownBurdenCount: 4,
            finalUnknownBurdenCount: 4,
            coverageValid: false,
        }));
        expect(memoryState.primary).toBeNull();
    });

    it('keeps every marker-free primary join free of resolver admission, overlay, and model work', async () => {
        const memoryState = memory();
        memoryState.outcomes = [verifiedOutcome('legacy.woman')];
        const bind = vi.fn();
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind } as never,
        } as never);
        const loadOverlay = vi.mocked(deps.resultStore.loadRevenueResolverOutcomes);
        const checkpointOverlay = vi.mocked(deps.resultStore.checkpointRevenueResolverOutcomes);

        await createAnalysisV2AiScoringExecutorRegistry(deps).primary_join!(context('primary_join', {
            jobKey: 'coordinator:join:primary-evidence',
            // `state()` deliberately has no relationshipSelectionPolicy;
            // production, Plus, and every historical cohort take this exact
            // marker-free path without a new context/revenue/model boundary.
        }));

        expect(bind).not.toHaveBeenCalled();
        expect(loadOverlay).not.toHaveBeenCalled();
        expect(checkpointOverlay).not.toHaveBeenCalled();
        expect(deps.ai.startGenderResolution).not.toHaveBeenCalled();
        expect(memoryState.primary?.candidates).toHaveLength(1);
    });

    it('leaves production and Plus finalizers free of new outcome, gate-RPC, assessor, and resolver work', async () => {
        for (const lineage of ['production', 'plus'] as const) {
            const memoryState = memory();
            const deps = dependencies(memoryState);
            const originalStore = deps.stageStore;
            const loadProfileAiOutcomes = vi.fn(async () => memoryState.outcomes);
            deps.stageStore = { ...originalStore, loadProfileAiOutcomes };
            const isApplicable = vi.fn(async () => false);
            const verify = vi.fn(async () => 'approved' as const);
            const evaluate = vi.fn(async () => 'approved' as const);
            const bind = vi.fn();
            deps.revenueFinalQualityGate = { isApplicable, verify, evaluate };
            deps.revenueResolverCapacity = { bind } as never;

            await createAnalysisV2AiScoringExecutorRegistry(deps).finalize!(context('finalize', {
                jobKey: 'coordinator:finalize',
            }));

            expect(isApplicable, lineage).not.toHaveBeenCalled();
            expect(verify, lineage).not.toHaveBeenCalled();
            expect(loadProfileAiOutcomes, lineage).not.toHaveBeenCalled();
            expect(evaluate, lineage).not.toHaveBeenCalled();
            expect(bind, lineage).not.toHaveBeenCalled();
            expect(deps.ai.startGenderResolution, lineage).not.toHaveBeenCalled();
            expect(deps.resultStore.finalize, lineage).toHaveBeenCalledOnce();
        }
    });

    it('fails closed when a strict relationship marker is present without its final quality gate', async () => {
        const memoryState = memory();
        const deps = dependencies(memoryState, {
            revenueResolverCapacity: { bind: vi.fn(async () => strictResolverAdmission()) },
        } as never);
        const originalStore = deps.stageStore;
        const loadProfileAiOutcomes = vi.fn(async () => memoryState.outcomes);
        deps.stageStore = { ...originalStore, loadProfileAiOutcomes };

        await expect(createAnalysisV2AiScoringExecutorRegistry(deps).finalize!(context('finalize', {
            jobKey: 'coordinator:finalize',
            state: strictFinalizerState(1),
        }))).rejects.toThrow('ANALYSIS_V2_REVENUE_FINAL_QUALITY_GATE_REQUIRED');

        expect(loadProfileAiOutcomes).not.toHaveBeenCalled();
        expect(deps.resultStore.finalize).not.toHaveBeenCalled();
    });

    it('captures target, ranked women, and name-ranked private images before finalization', async () => {
        const memoryState = memory();
        const deps = dependencies(memoryState);
        const imageCapture = vi.fn(async (
            _input: Parameters<
                NonNullable<
                    AnalysisV2AiScoringExecutorDependencies[
                        'resultImages'
                    ]
                >['capture']
            >[0]
        ) => {
            void _input;
            return undefined;
        });
        deps.resultImages = { capture: imageCapture };
        const stage = {
            requestId: REQUEST_ID,
            profileClassifications: [
                {
                    candidateId: 'candidate:one',
                    classification: 'verified_female',
                    profileImageUrl:
                        'https://cdninstagram.com/woman.one.jpg',
                },
                {
                    candidateId: 'candidate:two',
                    classification: 'verified_female',
                    profileImageUrl:
                        'https://cdninstagram.com/woman.two.jpg',
                },
            ],
            preliminaryScores: [],
            reverseLikes: [],
            partnerSafety: [],
            finalScores: [
                { candidateId: 'candidate:one', displayScore: 4.2 },
                { candidateId: 'candidate:two', displayScore: 8.1 },
            ],
            privateNames: [
                {
                    candidateId: 'candidate:private-low',
                    instagramId: 'private.low',
                    profileImageUrl:
                        'https://cdninstagram.com/private.low.jpg',
                    nameFemaleScore: 0.7,
                    nameConfidence: 0.8,
                },
                {
                    candidateId: 'candidate:private-high',
                    instagramId: 'private.high',
                    profileImageUrl:
                        'https://cdninstagram.com/private.high.jpg',
                    nameFemaleScore: 0.9,
                    nameConfidence: 0.9,
                },
            ],
            narratives: [],
        } as unknown as AnalysisV2ResultStageSnapshot;
        vi.mocked(deps.resultStore.loadStageSnapshot)
            .mockResolvedValue(stage);
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        await registry.finalize!(context('finalize', {
            jobKey: 'coordinator:finalize',
        }));

        const captureInput = imageCapture.mock.calls[0]![0];
        expect(captureInput.sources.map(row => [
            row.kind,
            row.candidateLocator,
            row.sortOrdinal,
        ])).toEqual([
            ['target', 'target', 0],
            ['female', 'candidate:two', 1],
            ['female', 'candidate:one', 2],
            ['private', 'candidate:private-high', 3],
            ['private', 'candidate:private-low', 4],
        ]);
        expect(captureInput.orderedManifestHash)
            .toMatch(/^[a-f0-9]{64}$/);
        expect(deps.resultStore.finalize).toHaveBeenCalledWith(
            expect.objectContaining({
                resultImageManifest: {
                    orderedManifestHash:
                        captureInput.orderedManifestHash,
                    expectedRows: 5,
                },
            })
        );
        expect(deps.mediaStore.cleanupTerminal).toHaveBeenCalledOnce();
    });
});

describe('V2 final score invariants', () => {
    function candidate(index: number, overrides: Partial<V2FemaleCandidateEvidence> = {}): V2FemaleCandidateEvidence {
        return {
            candidateId: `candidate:${String(index).padStart(2, '0')}`,
            username: `woman.${index}`,
            appearanceGrade: 3,
            exposureScore: 1,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
            uniqueTargetPostsLikedByCandidate: 0,
            boundedCandidateCommentsOnTarget: 0,
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
            ...overrides,
        };
    }

    it('applies the business multiplier only to soft context and caps strong partner evidence at 3.4', () => {
        const preliminary = calculateV2PreliminaryScores({
            candidates: [
                candidate(1, {
                    accountContext: 'personal',
                    uniqueTargetPostsLikedByCandidate: 4,
                    boundedCandidateCommentsOnTarget: 12,
                    appearanceGrade: 5,
                    exposureScore: 5,
                }),
                candidate(2, {
                    accountContext: 'individual_creator',
                    uniqueTargetPostsLikedByCandidate: 4,
                    boundedCandidateCommentsOnTarget: 12,
                    appearanceGrade: 5,
                    exposureScore: 5,
                    hasStrongPartnerEvidence: true,
                }),
            ],
            orderedMutualUsernames: ['woman.1', 'woman.2'],
            excludedUsername: null,
        });
        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set(),
        });
        const personal = final.find(row => row.username === 'woman.1')!;
        const business = final.find(row => row.username === 'woman.2')!;

        expect(business.risk.components.candidateToTargetLikes)
            .toBe(personal.risk.components.candidateToTargetLikes);
        expect(business.risk.components.candidateToTargetComments)
            .toBe(personal.risk.components.candidateToTargetComments);
        expect(business.risk.softContextMultiplier)
            .toBe(ACCOUNT_CONTEXT_SOFT_MULTIPLIERS.individual_creator);
        expect(business.risk.publicScore).toBeLessThanOrEqual(STRONG_PARTNER_PUBLIC_SCORE_CAP);
    });

    it('keeps reverse-like verification inside the frozen Top 10 and enforces 3/10 featured caps', () => {
        const candidates = Array.from({ length: 30 }, (_, index) => candidate(index + 1, {
            appearanceGrade: 5,
            exposureScore: 5,
            uniqueTargetPostsLikedByCandidate: index < 20 ? 4 : 2,
            boundedCandidateCommentsOnTarget: index < 20 ? 12 : 5,
            hasCandidateToTargetTagOrCaptionMention: index < 20,
        }));
        const preliminary = calculateV2PreliminaryScores({
            candidates,
            orderedMutualUsernames: candidates.map(row => row.username),
            excludedUsername: null,
        });
        const shortlist = preliminary.filter(row => row.verificationShortlistRank !== null);
        const observedId = shortlist.at(-1)!.candidateId;
        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set([observedId]),
        });

        expect(shortlist).toHaveLength(10);
        expect(final.find(row => row.candidateId === observedId)!.risk.components.targetToCandidateLike)
            .toBe(5);
        expect(final.filter(row => row.riskBand === 'high_risk' && row.featuredRank !== null))
            .toHaveLength(FEATURED_RISK_LIMITS.high_risk);
        expect(final.filter(row => row.riskBand === 'caution' && row.featuredRank !== null).length)
            .toBeLessThanOrEqual(FEATURED_RISK_LIMITS.caution);
    });

    it('assigns relative tiers when every natural score is low', () => {
        const candidates = Array.from({ length: 20 }, (_, index) => candidate(index + 1, {
            appearanceGrade: 1,
            exposureScore: 0,
        }));
        const preliminary = calculateV2PreliminaryScores({
            candidates,
            orderedMutualUsernames: [],
            excludedUsername: null,
        });
        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set(),
        });
        expect(final.every(row => row.risk.riskBand === 'normal')).toBe(true);
        expect(final.filter(row => row.riskBand === 'high_risk')).toHaveLength(2);
        expect(final.filter(row => row.riskBand === 'caution')).toHaveLength(2);
        expect(final.filter(row => row.featuredRank !== null)).toHaveLength(4);
        expect(final.filter(row => row.relativeWatchRank !== null)).toHaveLength(2);
    });

    it('reclaims a persisted v2.3 screening checkpoint through final-score recovery', async () => {
        const memoryState = memory();
        const outcome = verifiedOutcome('woman.one');
        memoryState.outcomes = [outcome];
        memoryState.primary = {
            revision: 1,
            resultHash: digest('legacy-primary'),
            candidates: [{
                candidateId: outcome.candidateId,
                instagramId: outcome.instagramId,
                interactions: [],
            }],
        };
        memoryState.reverse = { revision: 1, resultHash: digest('legacy-reverse'), rows: [] };
        memoryState.partner = { revision: 1, resultHash: digest('legacy-partner'), rows: [] };
        const deps = dependencies(memoryState, {
            reverseLikes: {
                collect: vi.fn(async (input: { candidates: readonly { candidateId: string }[] }) => ({
                    operationKey: `candidate-likers:${digest('legacy-observed')}`,
                    results: input.candidates.map(candidate => ({
                        candidateId: candidate.candidateId,
                        status: 'observed' as const,
                    })),
                })),
            },
        });
        const registry = createAnalysisV2AiScoringExecutorRegistry(deps);

        const legacyContext = { riskPolicyVersion: 'risk-policy-v2.3' as const };
        await registry.screening!(context('screening', {
            jobKey: 'coordinator:candidate-screening', ...legacyContext,
        }));
        expect(deps.resultStore.checkpointPreliminaryScores).toHaveBeenCalledWith(
            expect.objectContaining({
                riskPolicyVersion: 'risk-policy-v2.3',
                rows: [expect.objectContaining({
                    components: expect.objectContaining({ tagOrCaptionMention: 0 }),
                    possibleUpperBound: expect.any(Number),
                })],
            })
        );
        expect(memoryState.screening?.riskPolicyVersion).toBe('risk-policy-v2.3');
        await registry.reverse_likes!(context('reverse_likes', {
            jobKey: 'track:reverse-likes:collect', ...legacyContext,
        }));
        expect(deps.resultStore.checkpointReverseLikes).toHaveBeenCalledWith(expect.objectContaining({
            riskPolicyVersion: 'risk-policy-v2.3',
            rows: [expect.objectContaining({ status: 'observed', componentScore: 3 })],
        }));
        await expect(registry.final_score!(context('final_score', {
            jobKey: 'track:final-score', ...legacyContext,
        }))).resolves.toMatchObject({ checkpoint: { kind: 'final_score' } });
        expect(deps.resultStore.checkpointScores).toHaveBeenCalledWith(expect.objectContaining({
            riskPolicyVersion: 'risk-policy-v2.3',
            rows: [expect.objectContaining({
                components: expect.objectContaining({
                    tagOrCaptionMention: 0,
                    targetToCandidateLike: 3,
                }),
                possibleUpperBound: expect.any(Number),
            })],
        }));
        expect(memoryState.final?.riskPolicyVersion).toBe('risk-policy-v2.3');
    });
});
