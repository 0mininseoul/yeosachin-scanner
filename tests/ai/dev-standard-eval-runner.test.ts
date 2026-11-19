import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    createFeatureAnalysisResultIdentity,
    projectV211FeatureEvaluation,
    type FeatureAnalysisInput,
    type FeatureAnalysisResult,
} from '@/lib/services/ai/v2-staged-analysis';
import { AI_STAGE_POLICY_V211_VERSION } from '@/lib/services/ai/stage-policy';
import type { V2PreliminaryCandidateScore } from '@/lib/services/analysis/v2-candidate-scoring';
import {
    generateDevStandardEvalFeature,
    runDevStandardEval,
    type DevStandardEvalGenerate,
} from '@/lib/services/dev-ui/standard-eval-runner';

const mocks = vi.hoisted(() => ({ analyzeWithGemini: vi.fn() }));
vi.mock('@/lib/services/ai/gemini', async importOriginal => ({
    ...await importOriginal<typeof import('@/lib/services/ai/gemini')>(),
    analyzeWithGemini: mocks.analyzeWithGemini,
}));

function fixture() {
    const candidates = [1, 2, 3].map(ordinal => {
        const candidateId = `candidate:${ordinal.toString(16).padStart(40, '0')}`;
        const profile = `profile:fixture_${ordinal}`;
        const post = `post:${ordinal}:thumbnail`;
        const input: FeatureAnalysisInput = {
            triage: {
                assessment: {
                    inferredGender: 'unknown', confidence: 'low', ownerConsistency: 'multiple_or_unclear',
                    evidenceSelectionIds: [profile],
                },
                routingDecision: 'route_to_feature_analysis', routingReason: 'conserve_female_recall',
                analyzedSelectionIds: [profile, post],
            },
            bio: `여행과 일상 기록 ${ordinal}`,
            media: [
                { selectionId: profile, kind: 'profile', normalizedJpegBase64: '/9j/2Q==' },
                { selectionId: post, kind: 'feed', normalizedJpegBase64: '/9j/2Q==', postId: String(ordinal) },
            ],
            captions: [{ evidenceRefId: `caption:${ordinal}`, selectionId: post, text: '여행 사진' }],
        };
        const featureResult: FeatureAnalysisResult = {
            finalGenderDecision: 'verified_female',
            analyzedSelectionIds: [profile, post],
            features: {
                gender: 'female', genderConfidence: 'high', ownerConsistency: 'same_person',
                appearanceGrade: 4, exposureScore: 2, accountContext: 'personal',
                businessClassification: 'personal', businessConfidence: 'high',
                marriageEvidence: 'none', partnerEvidence: 'none', partnerExclusionContext: 'none',
                evidenceSelectionIds: {
                    gender: [profile, post], appearance: [post], exposure: [post],
                    business: [profile], accountContext: [profile], marriagePartner: [],
                },
                oneLineOverview: '여행 사진과 짧은 기록이 일정표처럼 또렷하게 정돈된 피드입니다.',
            },
        };
        return {
            candidateId, input, featureResult,
            featureOperationKey: createFeatureAnalysisResultIdentity(input, AI_STAGE_POLICY_V211_VERSION).operationKey,
        };
    });
    const preliminary: V2PreliminaryCandidateScore[] = candidates.map((candidate, index) => ({
        candidateId: candidate.candidateId, username: `eval_${index + 1}`, appearanceGrade: 4,
        exposureScore: 2, accountContext: 'personal',
        hasWeakPartnerEvidence: false, hasStrongPartnerEvidence: false,
        uniqueTargetPostsLikedByCandidate: index === 0 ? 4 : 0,
        boundedCandidateCommentsOnTarget: 0, hasCandidateToTargetTagOrCaptionMention: index === 0,
        hasTargetToCandidateTagOrCaptionMention: false, recentFemaleMutualRank: null,
        recentMutualBadgeRank: null, preScore: 20, verificationShortlistRank: index + 1,
    }));
    const frozenOutsideSample = {
        ...preliminary[1]!,
        candidateId: `candidate:${'a'.repeat(40)}`, username: 'eval_4', verificationShortlistRank: 4,
    };
    preliminary.push(frozenOutsideSample);
    return {
        version: 1, expiresAt: Date.now() + 60_000, candidates, preliminary,
        observed: [], notCollected: [], partnerOverrides: [],
        originalHighRiskIds: [candidates[0]!.candidateId],
    };
}

const tokenUsage = { promptTokens: 950, completionTokens: 200, thinkingTokens: 300, totalTokens: 1_450 };

function fullMediaFixture(text: string) {
    const bundle = fixture();
    for (const { input, featureResult } of bundle.candidates) {
        input.bio = text;
        for (let index = 2; index <= 10; index++) {
            const selectionId = `post:bounded:${index}`;
            input.media.push({ selectionId, kind: 'feed', normalizedJpegBase64: '/9j/2Q==' });
            input.captions.push({ evidenceRefId: `caption:bounded:${index}`, selectionId, text });
            featureResult.analyzedSelectionIds.push(selectionId);
        }
    }
    for (const candidate of bundle.candidates) {
        candidate.featureOperationKey = createFeatureAnalysisResultIdentity(candidate.input, AI_STAGE_POLICY_V211_VERSION).operationKey;
    }
    return bundle;
}

describe('paired Standard feature evaluation', () => {
    beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-19T10:00:00Z')));
    afterEach(() => vi.restoreAllMocks());

    it('runs exactly three pairs against the same feature inputs and reports only ordinal and aggregate values', async () => {
        const bundle = fixture();
        const beforeDispatch = vi.fn();
        const generate = vi.fn<DevStandardEvalGenerate>(async request => {
            expect(beforeDispatch).toHaveBeenCalledTimes(1);
            const original = bundle.candidates[request.ordinal - 1]!.featureResult;
            const result: FeatureAnalysisResult = request.ordinal === 1 && request.thinkingLevel === 'MEDIUM'
                ? {
                    ...original,
                    finalGenderDecision: 'unresolved',
                    features: { ...original.features, genderConfidence: 'medium' },
                }
                : original;
            return {
                result,
                tokenUsage: request.thinkingLevel === 'HIGH'
                    ? tokenUsage : { ...tokenUsage, thinkingTokens: 100, totalTokens: 1_250 },
                latencyMs: 25,
            };
        });

        const report = await runDevStandardEval({ bundle, generate, beforeDispatch });

        expect(generate).toHaveBeenCalledTimes(6);
        for (const ordinal of [1, 2, 3]) {
            const arms = generate.mock.calls.map(([request]) => request).filter(request => request.ordinal === ordinal);
            expect(arms.map(arm => arm.thinkingLevel).sort()).toEqual(['HIGH', 'MEDIUM']);
            expect(new Set(arms.map(arm => arm.identity.inputHash)).size).toBe(1);
            expect(new Set(arms.map(arm => arm.identity.mediaSnapshotHash)).size).toBe(1);
            expect(new Set(arms.map(arm => arm.identity.operationKey)).size).toBe(2);
        }
        expect(report.pairs[0]).toMatchObject({ ordinal: 1, originalRiskBand: 'high_risk', high: { riskBand: 'high_risk' }, medium: { riskBand: null } });
        expect(report.reservedUpperUsd).toBe(0.663552);
        expect(report).toMatchObject({
            cohortSize: 4,
            highRiskMissingAtMedium: [1],
            estimatedCurrentRateSavingsUsd: 0.00225,
            arms: {
                high: { featureEligibleCount: 3, estimatedCurrentRateUsd: 0.0077625 },
                medium: { featureEligibleCount: 2, estimatedCurrentRateUsd: 0.0055125 },
            },
        });
        expect(JSON.stringify(report)).not.toMatch(/candidate:|feature-analysis:|fixture_|여행/);
    });

    it('rejects input drift, cohort disagreement, and expiration before claiming a paid run', async () => {
        for (const bundle of [
            { ...fixture(), expiresAt: Date.now() - 1000 },
            { ...fixture(), originalHighRiskIds: [] },
            (() => {
                const bundle = fixture();
                bundle.candidates[0]!.input.bio = '달라진 자료';
                return bundle;
            })(),
        ]) {
            const generate = vi.fn<DevStandardEvalGenerate>();
            const beforeDispatch = vi.fn();
            await expect(runDevStandardEval({ bundle, generate, beforeDispatch })).rejects.toThrow(/^DEV_STANDARD_EVAL_/);
            expect(generate).not.toHaveBeenCalled();
            expect(beforeDispatch).not.toHaveBeenCalled();
        }
    });

    it('does not retry or start further requests after a provider failure', async () => {
        const generate = vi.fn<DevStandardEvalGenerate>();
        generate.mockRejectedValue(new Error('provider detail stays private'));
        await expect(runDevStandardEval({ bundle: fixture(), generate })).rejects.toThrow('DEV_STANDARD_EVAL_GENERATION_FAILED');
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it('admits the normal eleven-image feature envelope under the unchanged six-attempt cap', async () => {
        const bundle = fullMediaFixture('가'.repeat(160));
        const generate = vi.fn<DevStandardEvalGenerate>(async request => ({
            result: bundle.candidates[request.ordinal - 1]!.featureResult, tokenUsage, latencyMs: 20,
        }));
        await expect(runDevStandardEval({ bundle, generate })).resolves.toMatchObject({ reservedUpperUsd: 0.663552 });
        expect(generate).toHaveBeenCalledTimes(6);
        expect(generate.mock.calls.every(([request]) => request.input.media.length === 11)).toBe(true);
    });

    it('rejects the full six-attempt reservation before claiming or dispatching when it exceeds the cap', async () => {
        const bundle = fullMediaFixture('가'.repeat(2_200));
        const beforeDispatch = vi.fn();
        const generate = vi.fn<DevStandardEvalGenerate>();
        await expect(runDevStandardEval({ bundle, generate, beforeDispatch })).rejects.toThrow('DEV_STANDARD_EVAL_BUDGET_EXCEEDED');
        expect(beforeDispatch).not.toHaveBeenCalled();
        expect(generate).not.toHaveBeenCalled();
    });

    it('stops after one result when a provider reports usage outside its allocated envelope', async () => {
        const bundle = fixture();
        const generate = vi.fn<DevStandardEvalGenerate>().mockResolvedValue({
            result: bundle.candidates[0]!.featureResult,
            tokenUsage: { promptTokens: 950, completionTokens: 8193, thinkingTokens: 0, totalTokens: 9143 },
            latencyMs: 20,
        });
        await expect(runDevStandardEval({ bundle, generate })).rejects.toThrow('DEV_STANDARD_EVAL_USAGE_OVER_RESERVATION');
        expect(generate).toHaveBeenCalledTimes(1);
    });

    it('uses the production feature prompt, images, and schema through the native generation seam', async () => {
        const bundle = fixture();
        mocks.analyzeWithGemini.mockReset();
        mocks.analyzeWithGemini.mockImplementation(async (_prompt, _images, options) => {
            const candidate = bundle.candidates[Math.floor((mocks.analyzeWithGemini.mock.calls.length - 1) / 2)]!;
            await options.onAttemptTelemetry({
                attempt: 1, retryCount: 0, disposition: 'success', tokenUsage, latencyMs: 20,
                usageMetadataStatus: 'complete', maxOutputTokens: 8192,
                modelName: 'gemini-3.7-flash', thinkingLevel: options.thinkingLevel, location: 'global', mediaResolution: 'MEDIUM',
            });
            return options.schema.parse(candidate.featureResult.features);
        });

        await expect(runDevStandardEval({ bundle, generate: generateDevStandardEvalFeature }))
            .rejects.toThrow('DEV_STANDARD_EVAL_NATIVE_REQUEST_UNAUTHORIZED');
        expect(mocks.analyzeWithGemini).not.toHaveBeenCalled();
        await runDevStandardEval({ bundle, generate: generateDevStandardEvalFeature, beforeDispatch: vi.fn() });
        const [high, medium] = mocks.analyzeWithGemini.mock.calls;
        expect(high?.slice(0, 2)).toEqual(medium?.slice(0, 2));
        expect(projectV211FeatureEvaluation(bundle.candidates[0]!.input, 'HIGH').responseSchemaUtf8Bytes)
            .toBe(projectV211FeatureEvaluation(bundle.candidates[0]!.input, 'MEDIUM').responseSchemaUtf8Bytes);
        expect(high?.[2]).toMatchObject({ thinkingLevel: 'HIGH', maxAttempts: 1, retryResponseRejections: false });
        expect(medium?.[2]).toMatchObject({ thinkingLevel: 'MEDIUM', maxAttempts: 1, retryResponseRejections: false });
        expect(mocks.analyzeWithGemini).toHaveBeenCalledTimes(6);
    });
});
