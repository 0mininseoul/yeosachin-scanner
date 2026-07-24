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
            hasTagOrCaptionMention: false,
        }],
        orderedMutualUsernames: ['woman.one'],
        excludedUsername: null,
    });
}

describe('analysis V2 AI/scoring stage store', () => {
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
                payload: { shortlistHash, candidates },
            },
            error: null,
        });
        const store = createSupabaseAnalysisV2AiScoringStageStore(fake.client);

        const stored = await store.checkpointScreening({
            ...claim(),
            shortlistHash,
            candidates,
        });

        expect(stored).toEqual({ revision: 1, resultHash, shortlistHash, candidates });
        expect(fake.rpc).toHaveBeenCalledWith(
            ANALYSIS_V2_AI_SCORING_STAGE_DATABASE_NAMES.checkpointRpc,
            expect.objectContaining({
                p_request_id: requestId,
                p_job_key: 'coordinator:candidate-screening',
                p_stage_kind: 'screening',
                p_batch: null,
                p_item_count: 1,
                p_payload: { shortlistHash, candidates },
            })
        );
    });

    it('persists calibrated v2.3 fields and rejects v2.2 final-score replay', async () => {
        const candidates = calculateV2FinalScores({
            preliminary: preliminary(),
            observedReverseLikeCandidateIds: new Set(),
        });
        const narrativeBatchHash = digest('narrative-batch');
        const resultHash = digest('final-score');
        const payload = {
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
                risk: expect.objectContaining({ policyVersion: 'risk-policy-v2.3' }),
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
