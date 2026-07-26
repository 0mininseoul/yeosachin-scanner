import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    calculateV2FinalScores,
    calculateV2PreliminaryScores,
} from './v2-candidate-scoring';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import {
    ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES,
    AnalysisV2AiScoringStageConflictError,
    AnalysisV2AiScoringStageFenceError,
    createSupabaseAnalysisV2AiScoringStageStore,
    type AnalysisV2AiScoringStageSupabaseClient,
} from './v2-ai-scoring-stage-store';
import type { AnalysisV2ProfileAiOutcome } from './v2-ai-scoring-executors';

// gitleaks:allow -- UUID fixture
const requestId = '7df77338-2672-4ef2-93fe-13a0683ec9b4';
// gitleaks:allow -- UUID fixture
const claimToken = '51b42f42-204d-4dfb-86f8-9658d21c78f1';
const inputHash = 'a'.repeat(64);

function digest(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

function claim(jobKey = 'coordinator:candidate-screening') {
    return { requestId, jobKey, claimToken, jobInputHash: inputHash };
}

function clientWith(...responses: Array<{
    data: unknown;
    error: null | { code?: string; message?: string };
}>) {
    const rpc = vi.fn(async () => responses.shift() ?? { data: null, error: null });
    return {
        rpc,
        client: { rpc } as AnalysisV2AiScoringStageSupabaseClient,
    };
}

function preliminary() {
    return calculateV2PreliminaryScores({
        candidates: [{
            candidateId: 'candidate:one',
            username: 'woman.one',
            appearanceGrade: 4,
            exposureScore: 2,
            accountContext: 'personal',
            hasWeakPartnerEvidence: false,
            hasStrongPartnerEvidence: false,
            uniqueTargetPostsLikedByCandidate: 1,
            boundedCandidateCommentsOnTarget: 2,
            hasCandidateToTargetTagOrCaptionMention: false,
            hasTargetToCandidateTagOrCaptionMention: false,
        }],
        orderedMutualUsernames: ['woman.one'],
        excludedUsername: null,
    });
}

function legacyPreliminary() {
    const [candidate] = preliminary();
    if (!candidate) throw new Error('fixture missing candidate');
    const {
        hasCandidateToTargetTagOrCaptionMention: candidateToTargetMention,
        hasTargetToCandidateTagOrCaptionMention: targetToCandidateMention,
        ...legacy
    } = candidate;
    return {
        ...legacy,
        hasTagOrCaptionMention: candidateToTargetMention || targetToCandidateMention,
    };
}

function legacyFinal() {
    const candidate = legacyPreliminary();
    return {
        ...candidate,
        reverseLikeStatus: 'not_collected' as const,
        risk: {
            policyVersion: 'risk-policy-v2.3' as const,
            components: {
                candidateToTargetLikes: 0,
                candidateToTargetComments: 0,
                targetToCandidateLike: 0,
                tagOrCaptionMention: 0,
                recentMutual: 0,
                appearanceExposure: 0,
            },
            softContextBeforeBusinessAdjustment: { recentMutual: 0, appearanceExposure: 0 },
            softContextMultiplier: 1 as const,
            weakPartnerAdjustment: 0 as const,
            preScore: candidate.preScore,
            rawScore: candidate.preScore,
            possibleUpperBound: candidate.preScore,
            publicScore: 1,
            displayScore: 1,
            possibleUpperPublicScore: 1,
            possibleUpperDisplayScore: 1,
            riskBand: 'normal' as const,
            partnerCapApplied: false,
        },
        displayScore: 1,
        riskBand: 'normal' as const,
        relativeTierApplied: false,
        featuredRank: null,
        relativeWatchRank: null,
    };
}

function v28ProfileOutcome(): AnalysisV2ProfileAiOutcome {
    const selectionId = 'profile:screening-fixture';
    return {
        candidateId: `candidate:${'1'.repeat(40)}`,
        instagramId: 'screening.fixture',
        status: 'verified_female',
        unavailableReason: null,
        profile: {
            username: 'screening.fixture',
            fullName: 'Screening Fixture Band',
            bio: 'Official band · new single out now',
            profilePicUrl: 'https://cdn.example/screening.jpg',
            followersCount: 10,
            followingCount: 10,
            postsCount: 0,
            isPrivate: false,
            isVerified: false,
            latestPosts: [],
        },
        triage: {
            assessment: {
                inferredGender: 'female',
                confidence: 'high',
                ownerConsistency: 'same_person',
                evidenceSelectionIds: [selectionId],
            },
            routingDecision: 'route_to_feature_analysis',
            routingReason: 'conserve_female_recall',
            analyzedSelectionIds: [selectionId],
        },
        feature: {
            features: {
                gender: 'female',
                genderConfidence: 'high',
                ownerConsistency: 'same_person',
                appearanceGrade: 1,
                exposureScore: 0,
                businessClassification: 'business',
                businessConfidence: 'high',
                accountContext: 'official_group_or_brand',
                marriageEvidence: 'none',
                partnerEvidence: 'none',
                partnerExclusionContext: 'none',
                evidenceSelectionIds: {
                    gender: [selectionId],
                    appearance: [],
                    exposure: [],
                    business: [selectionId],
                    accountContext: [selectionId],
                    marriagePartner: [],
                },
                oneLineOverview:
                    '공식 밴드와 신곡 발매 문구가 함께 보여 개인 계정보다 조직 활동을 먼저 볼 만합니다.',
            },
            finalGenderDecision: 'verified_female',
            analyzedSelectionIds: [selectionId],
        },
        normalizedSelectionIds: [selectionId],
        captions: [],
        mediaCoverage: { selectedCount: 1, normalizedCount: 1, failures: [] },
        genderOperationKey: `gender-triage:${digest('gender')}`,
        genderResultHash: digest('gender-result'),
        featureOperationKey: `feature-analysis:${digest('feature')}`,
        featureResultHash: digest('feature-result'),
        baselineClassification: 'verified_female',
        classificationSource: 'feature',
        genderResolutionStatus: 'not_eligible',
        genderResolutionOperationKey: null,
        genderResolutionResultHash: null,
        mediaBundlePersisted: true,
        inputQualityPolicy: 'input-quality-v2.8',
        mediaSelectionProvenance: {
            triageSelectedCount: 1,
            featureSelectedCount: 1,
            selectedKinds: {
                profile: 1,
                postRepresentative: 0,
                carouselContext: 0,
            },
        },
        accountContextOverride: 'official_group_or_brand',
        officialScreeningStatus: 'corroborated_official',
        officialExclusionReason: 'model_group_context_plus_profile_signals',
    };
}

describe('analysis V2 AI/scoring stage store', () => {
    it.each([
        ['missing screening fields', (outcome: AnalysisV2ProfileAiOutcome) => {
            delete outcome.accountContextOverride;
            delete outcome.officialScreeningStatus;
            delete outcome.officialExclusionReason;
        }],
        ['partial screening fields', (outcome: AnalysisV2ProfileAiOutcome) => {
            delete outcome.officialScreeningStatus;
            delete outcome.officialExclusionReason;
        }],
    ] as const)('rejects v2.8 profile checkpoints with %s', async (_label, mutate) => {
        const outcome = v28ProfileOutcome();
        mutate(outcome);
        const store = createSupabaseAnalysisV2AiScoringStageStore(clientWith().client);
        await expect(store.checkpointProfileAiBatch({
            ...claim('track:profile-ai:batch:0'),
            batch: 0,
            outcomes: [outcome],
        })).rejects.toThrow('v2.8 input-quality provenance is incomplete');
    });

    it('validates and checkpoints a fully typed screening payload behind the live claim', async () => {
        const candidates = preliminary();
        const shortlistHash = digest('shortlist');
        const resultHash = digest('screening');
        const fake = clientWith({
            data: {
                stageKind: 'screening',
                batch: null,
                revision: 1,
                resultHash,
                itemCount: 1,
                payload: { riskPolicyVersion: 'risk-policy-v2.4', shortlistHash, candidates },
            },
            error: null,
        });
        const store = createSupabaseAnalysisV2AiScoringStageStore(fake.client);

        const stored = await store.checkpointScreening({
            ...claim(),
            shortlistHash,
            candidates,
        });

        expect(stored).toEqual({
            revision: 1,
            resultHash,
            riskPolicyVersion: 'risk-policy-v2.4',
            shortlistHash,
            candidates,
        });
        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.checkpointRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: 'coordinator:candidate-screening',
                p_stage_kind: 'screening',
                p_batch: null,
                p_item_count: 1,
                p_payload: { riskPolicyVersion: 'risk-policy-v2.4', shortlistHash, candidates },
            })
        );
    });

    it('persists calibrated v2.4 fields and rejects v2.2 final-score replay', async () => {
        const candidates = calculateV2FinalScores({
            preliminary: preliminary(),
            observedReverseLikeCandidateIds: new Set(),
        });
        const narrativeBatchHash = digest('narrative-batch');
        const resultHash = digest('final-score');
        const payload = {
            riskPolicyVersion: 'risk-policy-v2.4' as const,
            candidates,
            narrativeCandidateIds: [],
            narrativeBatchHash,
        };
        const accepted = clientWith({
            data: {
                stageKind: 'final_score',
                batch: null,
                revision: 1,
                resultHash,
                itemCount: 1,
                payload,
            },
            error: null,
        });
        const store = createSupabaseAnalysisV2AiScoringStageStore(accepted.client);

        await expect(store.checkpointFinalScores({
            ...claim('track:final-score'),
            ...payload,
        })).resolves.toMatchObject({
            resultHash,
            candidates: [expect.objectContaining({
                displayScore: expect.any(Number),
                riskBand: expect.any(String),
                relativeTierApplied: false,
                risk: expect.objectContaining({ policyVersion: 'risk-policy-v2.4' }),
            })],
        });

        const legacyPayload = structuredClone(payload);
        Object.assign(legacyPayload.candidates[0]!.risk, {
            policyVersion: 'risk-policy-v2.2',
        });
        const rejected = clientWith({
            data: {
                stageKind: 'final_score',
                batch: null,
                revision: 1,
                resultHash,
                itemCount: 1,
                payload: legacyPayload,
            },
            error: null,
        });
        await expect(createSupabaseAnalysisV2AiScoringStageStore(rejected.client)
            .loadFinalScores(claim('track:final-score')))
            .rejects.toThrow('invalid payload');
    });

    it('recovers an exact v2.3 screening checkpoint without converting its policy snapshot', async () => {
        const shortlistHash = digest('legacy-shortlist');
        const resultHash = digest('legacy-screening');
        const candidates = [legacyPreliminary()];
        const store = createSupabaseAnalysisV2AiScoringStageStore(clientWith({
            data: {
                stageKind: 'screening', batch: null, revision: 1, resultHash, itemCount: 1,
                payload: { shortlistHash, candidates },
            },
            error: null,
        }).client);

        await expect(store.loadScreening(claim('track:reverse-likes:collect'))).resolves.toEqual({
            revision: 1,
            resultHash,
            riskPolicyVersion: 'risk-policy-v2.3',
            shortlistHash,
            candidates,
        });
    });

    it('recovers an exact v2.3 final checkpoint and rejects hybrid policy payloads', async () => {
        const narrativeBatchHash = digest('legacy-narrative');
        const resultHash = digest('legacy-final');
        const candidates = [legacyFinal()];
        const legacyStore = createSupabaseAnalysisV2AiScoringStageStore(clientWith({
            data: {
                stageKind: 'final_score', batch: null, revision: 1, resultHash, itemCount: 1,
                payload: { candidates, narrativeCandidateIds: [], narrativeBatchHash },
            },
            error: null,
        }).client);
        await expect(legacyStore.loadFinalScores(claim('track:final-score'))).resolves.toEqual({
            revision: 1,
            resultHash,
            riskPolicyVersion: 'risk-policy-v2.3',
            candidates,
            narrativeCandidateIds: [],
            narrativeBatchHash,
        });

        const hybridStore = createSupabaseAnalysisV2AiScoringStageStore(clientWith({
            data: {
                stageKind: 'screening', batch: null, revision: 1,
                resultHash: digest('hybrid-screening'), itemCount: 1,
                payload: {
                    riskPolicyVersion: 'risk-policy-v2.4',
                    shortlistHash: digest('hybrid-shortlist'),
                    candidates: [legacyPreliminary()],
                },
            },
            error: null,
        }).client);
        await expect(hybridStore.loadScreening(claim('track:reverse-likes:collect')))
            .rejects.toThrow('invalid payload');
    });

    it('loads profile batches in batch order and retains media failure coverage', async () => {
        const unavailable = (candidateId: string, instagramId: string) => ({
            candidateId,
            instagramId,
            status: 'fetch_unavailable' as const,
            profile: null,
            triage: null,
            feature: null,
            normalizedSelectionIds: [],
            mediaCoverage: { selectedCount: 0, normalizedCount: 0, failures: [] },
            captions: [],
            genderOperationKey: null,
            genderResultHash: null,
            featureOperationKey: null,
            featureResultHash: null,
            mediaBundlePersisted: false,
        });
        const batch0 = {
            ...unavailable('candidate:zero', 'zero'),
            status: 'media_unavailable' as const,
            profile: {
                username: 'zero',
                followersCount: 0,
                followingCount: 0,
                postsCount: 0,
                isPrivate: false,
                isVerified: false,
            },
        };
        const batch1 = unavailable('candidate:one', 'one');
        const fake = clientWith({
            data: [
                {
                    stageKind: 'profile_ai_batch', batch: 1, revision: 1,
                    resultHash: digest('one'), itemCount: 1,
                    payload: { outcomes: [batch1] },
                },
                {
                    stageKind: 'profile_ai_batch', batch: 0, revision: 1,
                    resultHash: digest('zero'), itemCount: 1,
                    payload: { outcomes: [batch0] },
                },
            ],
            error: null,
        });
        const store = createSupabaseAnalysisV2AiScoringStageStore(fake.client);

        const loaded = await store.loadProfileAiOutcomes(claim());

        expect(loaded.map(row => row.instagramId)).toEqual(['zero', 'one']);
        expect(loaded.map(row => row.status)).toEqual([
            'media_unavailable',
            'fetch_unavailable',
        ]);
        expect(loaded.every(row => row.mediaCoverage.selectedCount === 0)).toBe(true);
        expect(loaded.map(row => ({
            baseline: row.baselineClassification,
            source: row.classificationSource,
            resolver: row.genderResolutionStatus,
        }))).toEqual([
            { baseline: 'media_unavailable', source: 'unavailable', resolver: 'disabled' },
            { baseline: 'fetch_unavailable', source: 'unavailable', resolver: 'disabled' },
        ]);
    });

    it('round-trips an analysis-unavailable profile without AI or media data', async () => {
        const outcome = {
            candidateId: 'candidate:analysis-unavailable',
            instagramId: 'analysis.unavailable',
            status: 'analysis_unavailable' as const,
            unavailableReason: 'ai_response' as const,
            profile: {
                username: 'analysis.unavailable',
                fullName: '분석 불가 계정',
                followersCount: 10,
                followingCount: 20,
                postsCount: 0,
                isPrivate: false,
                isVerified: false,
            },
            triage: null,
            feature: null,
            normalizedSelectionIds: [],
            mediaCoverage: { selectedCount: 0, normalizedCount: 0, failures: [] },
            captions: [],
            genderOperationKey: null,
            genderResultHash: null,
            featureOperationKey: null,
            featureResultHash: null,
            baselineClassification: 'analysis_unavailable' as const,
            classificationSource: 'unavailable' as const,
            genderResolutionStatus: 'disabled' as const,
            genderResolutionOperationKey: null,
            genderResolutionResultHash: null,
            mediaBundlePersisted: false,
        };
        const envelope = {
            stageKind: 'profile_ai_batch',
            batch: 0,
            revision: 1,
            resultHash: digest('analysis-unavailable'),
            itemCount: 1,
            payload: { outcomes: [outcome] },
        };
        const fake = clientWith(
            { data: envelope, error: null },
            { data: [envelope], error: null }
        );
        const store = createSupabaseAnalysisV2AiScoringStageStore(fake.client);

        await expect(store.checkpointProfileAiBatch({
            ...claim('track:profile-ai:batch:0'),
            batch: 0,
            outcomes: [outcome],
        })).resolves.toEqual({
            revision: 1,
            resultHash: digest('analysis-unavailable'),
            itemCount: 1,
        });
        await expect(store.loadProfileAiOutcomes(claim())).resolves.toEqual([outcome]);
        expect(fake.rpc).toHaveBeenNthCalledWith(
            1,
            ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.checkpointRpc,
            expect.objectContaining({ p_payload: { outcomes: [outcome] } })
        );

        const invalid = createSupabaseAnalysisV2AiScoringStageStore(clientWith().client);
        await expect(invalid.checkpointProfileAiBatch({
            ...claim('track:profile-ai:batch:0'),
            batch: 0,
            outcomes: [{
                ...outcome,
                genderResolutionStatus: 'ready_inconclusive',
            }],
        })).rejects.toThrow('Ready gender resolution provenance is incomplete');
    });

    it('rejects inconsistent analysis-unavailable outcomes before persistence', async () => {
        const base = {
            candidateId: 'candidate:analysis-unavailable',
            instagramId: 'analysis.unavailable',
            status: 'analysis_unavailable' as const,
            unavailableReason: 'ai_response' as const,
            profile: {
                username: 'analysis.unavailable',
                followersCount: 10,
                followingCount: 20,
                postsCount: 0,
                isPrivate: false,
                isVerified: false,
            },
            triage: null,
            feature: null,
            normalizedSelectionIds: [],
            mediaCoverage: { selectedCount: 0, normalizedCount: 0, failures: [] },
            captions: [],
            genderOperationKey: null,
            genderResultHash: null,
            featureOperationKey: null,
            featureResultHash: null,
            baselineClassification: 'analysis_unavailable' as const,
            classificationSource: 'unavailable' as const,
            genderResolutionStatus: 'disabled' as const,
            genderResolutionOperationKey: null,
            genderResolutionResultHash: null,
            mediaBundlePersisted: false,
        };

        for (const inconsistent of [
            { ...base, unavailableReason: 'profile_fetch' as const },
            { ...base, profile: null },
            {
                ...base,
                normalizedSelectionIds: ['profile:analysis.unavailable'],
                mediaCoverage: { selectedCount: 1, normalizedCount: 1, failures: [] },
            },
            {
                ...base,
                captions: [{
                    evidenceRefId: 'caption:one',
                    selectionId: 'profile:analysis.unavailable',
                    text: 'retained caption',
                }],
            },
        ]) {
            const fake = clientWith();
            const store = createSupabaseAnalysisV2AiScoringStageStore(fake.client);
            await expect(store.checkpointProfileAiBatch({
                ...claim('track:profile-ai:batch:0'),
                batch: 0,
                outcomes: [inconsistent],
            })).rejects.toThrow();
            expect(fake.rpc).not.toHaveBeenCalled();
        }
    });

    it('maps immutable replay and lease failures to distinct typed errors', async () => {
        const conflict = createSupabaseAnalysisV2AiScoringStageStore(clientWith({
            data: null,
            error: { code: 'P0001', message: 'ANALYSIS_V2_AI_SCORING_STAGE_CONFLICT' },
        }).client);
        await expect(conflict.checkpointScreening({
            ...claim(),
            shortlistHash: digest('shortlist'),
            candidates: preliminary(),
        })).rejects.toBeInstanceOf(AnalysisV2AiScoringStageConflictError);

        const fenced = createSupabaseAnalysisV2AiScoringStageStore(clientWith({
            data: null,
            error: { code: 'P0001', message: 'ANALYSIS_V2_JOB_LEASE_FENCE_MISMATCH' },
        }).client);
        await expect(fenced.loadScreening(claim('track:reverse-likes:collect')))
            .rejects.toBeInstanceOf(AnalysisV2AiScoringStageFenceError);
    });

    it('rejects malformed checkpoint payloads and validates terminal purge counts', async () => {
        const malformed = createSupabaseAnalysisV2AiScoringStageStore(clientWith({
            data: {
                stageKind: 'screening', batch: null, revision: 1,
                resultHash: digest('bad'), itemCount: 1,
                payload: { shortlistHash: digest('shortlist'), candidates: [{}] },
            },
            error: null,
        }).client);
        await expect(malformed.loadScreening(claim('track:reverse-likes:collect')))
            .rejects.toThrow('invalid payload');

        const fake = clientWith({ data: 7, error: null });
        const store = createSupabaseAnalysisV2AiScoringStageStore(fake.client);
        await expect(store.purgeTerminal(claim('coordinator:finalize'))).resolves.toBe(7);
        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.purgeRpc,
            expect.objectContaining({ p_job_key: 'coordinator:finalize' })
        );
    });
});
