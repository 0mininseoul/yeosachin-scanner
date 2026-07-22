import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    BUSINESS_SOFT_CONTEXT_MULTIPLIER,
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
import { AI_STAGE_POLICY_VERSION } from '@/lib/services/ai/stage-policy';
import type { AnalysisV2CheckpointProfile } from './v2-profile-fetch-store';
import type {
    AnalysisV2RelationshipStagingSnapshot,
    AnalysisV2TargetEvidenceStagingSnapshot,
} from './v2-evidence-store';
import {
    createSupabaseAnalysisV2ResultStore,
    type AnalysisV2ProfileClassificationRow,
    type AnalysisV2ResultCheckpointManifest,
    type AnalysisV2ResultSupabaseClient,
} from './v2-result-store';
import type { AnalysisV2StageExecutorContext, AnalysisV2StageId } from './v2-worker';
import type { AnalysisV2AiStageRuntime } from './v2-ai-stage-runtime';
import type { AnalysisV2MediaArtifactStore } from './v2-media-artifact-store';
import type { AnalysisV2DagState } from './v2-dag-planner';
import { AnalysisV2AiResultRateLimitExhaustedError } from './v2-ai-result-store';
import {
    analysisV2CandidateBundleId,
    analysisV2CandidateId,
    analysisV2PartnerSafetyBundleId,
    createAnalysisV2AiScoringExecutorRegistry,
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
        reportActiveProfile?: (username: string) => Promise<void>;
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
        aiStagePolicyVersion: AI_STAGE_POLICY_VERSION,
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
                marriagePartner: options.strongPartner || options.weakPartner
                    ? mediaIds.slice(0, 1)
                    : [],
            },
            oneLineOverview: '차분한 일상을 기록하는 공개 계정',
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
        outcomes: [], primary: null, screening: null, reverse: null,
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
            finalize: vi.fn(async () => ({
                finalized: true,
                requestStatus: 'completed' as const,
                summary: {
                    targetInstagramId: 'target.account',
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
                    successfullyScreenedMutuals: 0,
                    fetchUnavailableMutuals: 0,
                    mediaUnavailableMutuals: 0,
                    analysisUnavailableMutuals: 0,
                    notScreenedMutuals: 0,
                    privateMutuals: 0,
                    exclusionApplied: false,
                    scorePolicyVersion: 'risk-policy-v2.2' as const,
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
        ai: {
            gender: vi.fn(async (input: Parameters<AnalysisV2AiStageRuntime['gender']>[0]) => ({
                result: triage(input.media.map(row => row.selectionId)),
                operationKey: `gender-triage:${digest('gender')}`,
                resultHash: digest('gender-result'),
                source: 'checkpoint' as const,
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
        expect(deps.mediaStore.persistBundle).toHaveBeenCalledTimes(1);
        expect(deps.mediaStore.persistBundle).toHaveBeenCalledWith(expect.objectContaining({
            bundleId: analysisV2CandidateBundleId(analysisV2CandidateId('unknown.account')),
        }));
        const featureCheckpoint = vi.mocked(deps.resultStore.checkpointFeatureBatch);
        expect(featureCheckpoint.mock.calls[0][0].rows.map(row => row.classification)).toEqual([
            'verified_non_female', 'verified_female', 'unavailable',
        ]);
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

    it('reports each real profile AI task start without exposing media URLs', async () => {
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

        expect(reportActiveProfile).toHaveBeenCalledExactlyOnceWith('woman.parallel');
        expect(JSON.stringify(reportActiveProfile.mock.calls)).not.toContain('cdninstagram');
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
                    isBusinessAccount: false,
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                    uniqueTargetPostsLikedByCandidate: 0,
                    boundedCandidateCommentsOnTarget: 0,
                    hasTagOrCaptionMention: false,
                }],
                orderedMutualUsernames: [candidate.instagramId],
                excludedUsername: null,
            }),
        };
        const createContactSheet = vi.fn(async (
            sources: readonly { selectionId: string; normalizedJpegBase64: string }[]
        ) => ({
            selectionId: `contact-sheet:${digest(sources.map(row => row.selectionId).join('|'))}`,
            normalizedJpegBase64: Buffer.from('sheet').toString('base64'),
            sourceSelectionIds: sources.map(row => row.selectionId),
            width: 768,
            height: 960,
        }));
        const deps = dependencies(memoryState, { createContactSheet });
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

        await createAnalysisV2AiScoringExecutorRegistry(deps).partner_safety!(
            context('partner_safety')
        );

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
        expect(vi.mocked(deps.resultStore.checkpointPartnerSafety).mock.calls[0]![0].rows[0])
            .toMatchObject({
                source: 'gemini',
                bundleId: analysisV2PartnerSafetyBundleId(candidate.candidateId),
                evidenceSelectionIds: [partnerInput.contactSheet!.sourceSelectionIds[0]],
            });
    });

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
                    isBusinessAccount: false,
                    hasWeakPartnerEvidence: false,
                    hasStrongPartnerEvidence: false,
                    uniqueTargetPostsLikedByCandidate: 0,
                    boundedCandidateCommentsOnTarget: 0,
                    hasTagOrCaptionMention: false,
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
                isBusinessAccount: false,
                hasWeakPartnerEvidence:
                    outcome.feature!.features.marriageEvidence === 'possible',
                hasStrongPartnerEvidence:
                    outcome.feature!.features.marriageEvidence === 'strong',
                uniqueTargetPostsLikedByCandidate: 0,
                boundedCandidateCommentsOnTarget: 0,
                hasTagOrCaptionMention: false,
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
                    results: input.candidates.map(candidate => ({
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
                isBusinessAccount: false,
                hasWeakPartnerEvidence: false,
                hasStrongPartnerEvidence: false,
                uniqueTargetPostsLikedByCandidate: 4,
                boundedCandidateCommentsOnTarget: 12,
                hasTagOrCaptionMention: true,
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
        await registry.final_score!(context('final_score'));

        expect(memoryState.final?.candidates[0].reverseLikeStatus).toBe('not_collected');
        expect(memoryState.final?.candidates[0].risk.possibleUpperBound)
            .toBe(memoryState.final!.candidates[0].risk.preScore + 3);
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

describe('V2 final score invariants', () => {
    function candidate(index: number, overrides: Partial<V2FemaleCandidateEvidence> = {}): V2FemaleCandidateEvidence {
        return {
            candidateId: `candidate:${String(index).padStart(2, '0')}`,
            username: `woman.${index}`,
            appearanceGrade: 3,
            exposureScore: 1,
            isBusinessAccount: false,
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
            uniqueTargetPostsLikedByCandidate: 0,
            boundedCandidateCommentsOnTarget: 0,
            hasTagOrCaptionMention: false,
            ...overrides,
        };
    }

    it('applies the business multiplier only to soft context and caps strong partner evidence at 3.4', () => {
        const preliminary = calculateV2PreliminaryScores({
            candidates: [
                candidate(1, {
                    isBusinessAccount: false,
                    uniqueTargetPostsLikedByCandidate: 4,
                    boundedCandidateCommentsOnTarget: 12,
                    appearanceGrade: 5,
                    exposureScore: 5,
                }),
                candidate(2, {
                    isBusinessAccount: true,
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
        expect(business.risk.businessSoftContextMultiplier)
            .toBe(BUSINESS_SOFT_CONTEXT_MULTIPLIER);
        expect(business.risk.publicScore).toBeLessThanOrEqual(STRONG_PARTNER_PUBLIC_SCORE_CAP);
    });

    it('keeps reverse-like verification inside the frozen Top 10 and enforces 3/15 featured caps', () => {
        const candidates = Array.from({ length: 30 }, (_, index) => candidate(index + 1, {
            appearanceGrade: 5,
            exposureScore: 5,
            uniqueTargetPostsLikedByCandidate: index < 20 ? 4 : 2,
            boundedCandidateCommentsOnTarget: index < 20 ? 12 : 5,
            hasTagOrCaptionMention: index < 20,
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
            .toBe(3);
        expect(final.filter(row => row.risk.riskBand === 'high_risk' && row.featuredRank !== null))
            .toHaveLength(FEATURED_RISK_LIMITS.high_risk);
        expect(final.filter(row => row.risk.riskBand === 'caution' && row.featuredRank !== null).length)
            .toBeLessThanOrEqual(FEATURED_RISK_LIMITS.caution);
    });

    it('does not force a high-risk account when every absolute score is low', () => {
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
        expect(final.filter(row => row.risk.riskBand === 'high_risk')).toHaveLength(0);
        expect(final.filter(row => row.featuredRank !== null)).toHaveLength(0);
        expect(final.filter(row => row.relativeWatchRank !== null)).toHaveLength(2);
    });
});
