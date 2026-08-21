import { describe, expect, it } from 'vitest';
import {
    AI_STAGE_NAMES,
    AI_STAGE_NAMES_V27,
    AI_STAGE_POLICIES,
    AI_STAGE_POLICY_LATEST_VERSION,
    AI_STAGE_POLICY_V28_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
    AI_STAGE_POLICY_V210_VERSION,
    AI_STAGE_POLICY_V211_VERSION,
    AI_STAGE_POLICY_REGISTRY,
    AI_STAGE_POLICY_VERSION,
    SUPPORTED_AI_STAGE_POLICY_VERSIONS,
    AI_CONCURRENCY_ENFORCEMENT_SCOPE,
    AI_GEMINI_LEASE_SECONDS,
    AI_GEMINI_MIN_REMAINING_MS,
    AI_GEMINI_SDK_TIMEOUT_MS,
    AI_SHARED_CONCURRENCY_LIMIT,
    assertSupportedAiStagePolicyVersion,
    aiStagePolicySupports,
    getAiStagePolicy,
    isAiStageName,
    selectAiStagePolicyVersion,
} from './stage-policy';

const V26_POLICY_SNAPSHOT = {
    genderTriage: {
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MINIMAL',
        mediaResolution: 'LOW',
        profileImageLimit: 1,
        feedImageLimit: 4,
        maxOutputTokens: 512,
        concurrency: 8,
        promptVersion: 'gender-triage-v2',
        schemaVersion: 2,
    },
    featureAnalysis: {
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MEDIUM',
        mediaResolution: 'MEDIUM',
        profileImageLimit: 1,
        feedImageLimit: 10,
        maxOutputTokens: 2_048,
        concurrency: 8,
        promptVersion: 'feature-analysis-v3',
        schemaVersion: 3,
    },
    partnerSafety: {
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MEDIUM',
        mediaResolution: 'LOW',
        profileImageLimit: 0,
        feedImageLimit: 1,
        maxOutputTokens: 768,
        concurrency: 5,
        promptVersion: 'partner-safety-v2',
        schemaVersion: 2,
    },
    highRiskNarrative: {
        model: 'gemini-3-flash-preview',
        thinkingLevel: 'HIGH',
        mediaResolution: 'MEDIUM',
        profileImageLimit: 1,
        feedImageLimit: 10,
        maxOutputTokens: 4_096,
        concurrency: 3,
        promptVersion: 'high-risk-narrative-v2',
        schemaVersion: 2,
    },
    privateAccountName: {
        model: 'gemini-3.1-flash-lite',
        thinkingLevel: 'MINIMAL',
        mediaResolution: 'LOW',
        profileImageLimit: 0,
        feedImageLimit: 0,
        maxOutputTokens: 8_192,
        concurrency: 4,
        promptVersion: 'private-account-name-v1',
        schemaVersion: 1,
    },
} as const;

describe('V2 AI stage policy', () => {
    it('uses cheap minimal triage and medium feature analysis', () => {
        expect(getAiStagePolicy('genderTriage')).toMatchObject({
            model: 'gemini-3.1-flash-lite',
            thinkingLevel: 'MINIMAL',
            profileImageLimit: 1,
            feedImageLimit: 4,
        });
        expect(getAiStagePolicy('featureAnalysis')).toMatchObject({
            model: 'gemini-3.1-flash-lite',
            thinkingLevel: 'MEDIUM',
            profileImageLimit: 1,
            feedImageLimit: 10,
        });
    });

    it('reserves high thinking and a concurrency cap of three for narratives', () => {
        expect(getAiStagePolicy('highRiskNarrative')).toMatchObject({
            model: 'gemini-3-flash-preview',
            thinkingLevel: 'HIGH',
            concurrency: 3,
            maxOutputTokens: 4_096,
        });
    });

    it('uses one low-resolution contact sheet with medium reasoning for partner safety', () => {
        expect(getAiStagePolicy('partnerSafety')).toMatchObject({
            model: 'gemini-3.1-flash-lite',
            thinkingLevel: 'MEDIUM',
            mediaResolution: 'LOW',
            profileImageLimit: 0,
            feedImageLimit: 1,
            concurrency: 5,
        });
    });

    it('defines a complete supported request policy for every stage', () => {
        for (const stage of AI_STAGE_NAMES) {
            expect(getAiStagePolicy(stage)).toMatchObject({
                model: expect.stringMatching(/^gemini-/),
                thinkingLevel: expect.stringMatching(/^(MINIMAL|LOW|MEDIUM|HIGH)$/),
                mediaResolution: expect.stringMatching(/^(LOW|MEDIUM|HIGH)$/),
                maxOutputTokens: expect.any(Number),
                concurrency: expect.any(Number),
                promptVersion: expect.any(String),
                schemaVersion: expect.any(Number),
            });
            expect(isAiStageName(stage)).toBe(true);
        }
        expect(isAiStageName('not-a-stage')).toBe(false);
    });

    it('is immutable and explicitly versioned', () => {
        expect(Object.isFrozen(AI_STAGE_POLICIES)).toBe(true);
        expect(Object.isFrozen(AI_STAGE_POLICIES.genderTriage)).toBe(true);
        expect(AI_STAGE_POLICY_VERSION).toBe('ai-stage-policy-v2.6');
        expect(AI_SHARED_CONCURRENCY_LIMIT).toBe(8);
        expect(Math.max(...Object.values(AI_STAGE_POLICIES).map(policy => policy.concurrency)))
            .toBeLessThanOrEqual(AI_SHARED_CONCURRENCY_LIMIT);
        expect(AI_GEMINI_LEASE_SECONDS).toBe(240);
        expect(AI_GEMINI_MIN_REMAINING_MS).toBe(225_000);
        expect(AI_GEMINI_SDK_TIMEOUT_MS).toBe(210_000);
        expect(AI_GEMINI_SDK_TIMEOUT_MS)
            .toBeLessThan(AI_GEMINI_MIN_REMAINING_MS);
    });

    it('versions conservative gender and feature response normalization at v2', () => {
        expect(getAiStagePolicy('partnerSafety')).toMatchObject({
            promptVersion: 'partner-safety-v2',
            schemaVersion: 2,
        });
        expect(getAiStagePolicy('highRiskNarrative')).toMatchObject({
            promptVersion: 'high-risk-narrative-v2',
            schemaVersion: 2,
        });
        expect(getAiStagePolicy('genderTriage')).toMatchObject({
            promptVersion: 'gender-triage-v2',
            schemaVersion: 2,
        });
        expect(getAiStagePolicy('featureAnalysis')).toMatchObject({
            promptVersion: 'feature-analysis-v3',
            schemaVersion: 3,
        });
        expect(getAiStagePolicy('privateAccountName')).toMatchObject({
            promptVersion: 'private-account-name-v1',
            schemaVersion: 1,
        });
    });

    it('states that concurrency is deployment-wide and keeps 100-row name output capacity', () => {
        expect(AI_CONCURRENCY_ENFORCEMENT_SCOPE).toBe('deployment');
        expect(getAiStagePolicy('privateAccountName').maxOutputTokens).toBe(8_192);
    });

    it('freezes the complete v2.6 registry byte-for-byte while adding v2.7 separately', () => {
        expect(SUPPORTED_AI_STAGE_POLICY_VERSIONS).toEqual([
            'ai-stage-policy-v2.6',
            'ai-stage-policy-v2.7',
            'ai-stage-policy-v2.8',
            'ai-stage-policy-v2.9',
            'ai-stage-policy-v2.10',
            'ai-stage-policy-v2.11',
        ]);
        expect(AI_STAGE_POLICY_VERSION).toBe('ai-stage-policy-v2.6');
        expect(AI_STAGE_POLICY_LATEST_VERSION).toBe('ai-stage-policy-v2.7');
        expect(AI_STAGE_POLICY_REGISTRY['ai-stage-policy-v2.6']).toBe(AI_STAGE_POLICIES);
        expect(Object.keys(AI_STAGE_POLICY_REGISTRY['ai-stage-policy-v2.6']))
            .toEqual([...AI_STAGE_NAMES]);
        expect(JSON.stringify(AI_STAGE_POLICY_REGISTRY['ai-stage-policy-v2.6']))
            .toBe(JSON.stringify(V26_POLICY_SNAPSHOT));
        expect(AI_STAGE_NAMES_V27).toEqual([...AI_STAGE_NAMES, 'genderResolution']);
        for (const stage of ['partnerSafety', 'highRiskNarrative'] as const) {
            expect(getAiStagePolicy('ai-stage-policy-v2.7', stage))
                .toBe(getAiStagePolicy('ai-stage-policy-v2.6', stage));
        }
    });

    it('adds immutable v2.8 copy policy without changing v2.6 or v2.7 registries', () => {
        expect(AI_STAGE_POLICY_V28_VERSION).toBe('ai-stage-policy-v2.8');
        expect(SUPPORTED_AI_STAGE_POLICY_VERSIONS).toEqual([
            'ai-stage-policy-v2.6',
            'ai-stage-policy-v2.7',
            'ai-stage-policy-v2.8',
            'ai-stage-policy-v2.9',
            'ai-stage-policy-v2.10',
            'ai-stage-policy-v2.11',
        ]);
        expect(Object.isFrozen(AI_STAGE_POLICY_REGISTRY['ai-stage-policy-v2.8'])).toBe(true);
        expect(getAiStagePolicy('ai-stage-policy-v2.8', 'featureAnalysis')).toMatchObject({
            promptVersion: 'feature-analysis-v4',
            concurrency: 3,
        });
        expect(getAiStagePolicy('ai-stage-policy-v2.8', 'genderTriage')).toMatchObject({
            model: 'gemini-3.1-flash-lite',
            promptVersion: 'gender-triage-v3',
            schemaVersion: 2,
            concurrency: 6,
        });
        expect(getAiStagePolicy('ai-stage-policy-v2.8', 'privateAccountName').concurrency).toBe(2);
        expect(getAiStagePolicy('ai-stage-policy-v2.8', 'highRiskNarrative')).toMatchObject({
            promptVersion: 'high-risk-narrative-v3',
            concurrency: 3,
        });
        expect(JSON.stringify(AI_STAGE_POLICY_REGISTRY['ai-stage-policy-v2.6']))
            .toBe(JSON.stringify(V26_POLICY_SNAPSHOT));
        expect(getAiStagePolicy('ai-stage-policy-v2.7', 'featureAnalysis').promptVersion)
            .toBe('feature-analysis-v3');
        expect(getAiStagePolicy('ai-stage-policy-v2.7', 'genderTriage').promptVersion)
            .toBe('gender-triage-v2');
    });

    it('adds v2.9 as an explicit bounded microbatch policy without mutating v2.8', () => {
        expect(AI_STAGE_POLICY_V29_VERSION).toBe('ai-stage-policy-v2.9');
        expect(getAiStagePolicy(AI_STAGE_POLICY_V29_VERSION, 'genderTriage')).toMatchObject({
            promptVersion: 'gender-triage-microbatch-v1',
            schemaVersion: 3,
            maxOutputTokens: 1_024,
            concurrency: 6,
        });
        expect(getAiStagePolicy(AI_STAGE_POLICY_V28_VERSION, 'genderTriage')).toMatchObject({
            promptVersion: 'gender-triage-v3',
            schemaVersion: 2,
            maxOutputTokens: 512,
        });
        expect(aiStagePolicySupports(AI_STAGE_POLICY_V29_VERSION, 'genderTriageMicrobatchV29'))
            .toBe(true);
    });

    it('adds v2.10 as an immutable v2.9 successor with the safe public-presentation capability', () => {
        expect(AI_STAGE_POLICY_V210_VERSION).toBe('ai-stage-policy-v2.10');
        expect(SUPPORTED_AI_STAGE_POLICY_VERSIONS).toEqual([
            'ai-stage-policy-v2.6',
            'ai-stage-policy-v2.7',
            'ai-stage-policy-v2.8',
            'ai-stage-policy-v2.9',
            'ai-stage-policy-v2.10',
            'ai-stage-policy-v2.11',
        ]);
        expect(AI_STAGE_POLICY_REGISTRY[AI_STAGE_POLICY_V210_VERSION])
            .toEqual(AI_STAGE_POLICY_REGISTRY[AI_STAGE_POLICY_V29_VERSION]);
        expect(aiStagePolicySupports(AI_STAGE_POLICY_V210_VERSION, 'genderTriageMicrobatchV29'))
            .toBe(true);
        expect(aiStagePolicySupports(AI_STAGE_POLICY_V210_VERSION, 'safePublicPresentationV28'))
            .toBe(true);
        expect(aiStagePolicySupports(AI_STAGE_POLICY_V28_VERSION, 'safePublicPresentationV28'))
            .toBe(true);
        // v2.9 shipped without this final presentation inheritance. It must remain replayable.
        expect(aiStagePolicySupports(AI_STAGE_POLICY_V29_VERSION, 'safePublicPresentationV28'))
            .toBe(false);
    });

    it('adds v2.11 as an immutable quality successor that is rollout-gated', () => {
        expect(AI_STAGE_POLICY_V211_VERSION).toBe('ai-stage-policy-v2.11');
        expect(getAiStagePolicy(AI_STAGE_POLICY_V210_VERSION, 'genderTriage'))
            .toMatchObject({ mediaResolution: 'LOW' });
        expect(getAiStagePolicy(AI_STAGE_POLICY_V211_VERSION, 'genderTriage'))
            .toMatchObject({ promptVersion: 'gender-triage-microbatch-v3', mediaResolution: 'MEDIUM' });
        expect(getAiStagePolicy(AI_STAGE_POLICY_V211_VERSION, 'featureAnalysis'))
            .toMatchObject({
                promptVersion: 'feature-analysis-v5',
                model: 'gemini-3.7-flash',
                thinkingLevel: 'HIGH',
            });
        expect(getAiStagePolicy(AI_STAGE_POLICY_V211_VERSION, 'highRiskNarrative'))
            .toMatchObject({ promptVersion: 'high-risk-narrative-v4', maxOutputTokens: 8_192 });
        expect(aiStagePolicySupports(AI_STAGE_POLICY_V211_VERSION, 'genderSummaryQualityV211'))
            .toBe(true);
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'production',
            narrativeV28RolloutMode: 'production',
            microbatchV29RolloutMode: 'production',
            genderSummaryQualityV211RolloutMode: 'production',
            accessMode: 'production',
        })).toBe(AI_STAGE_POLICY_V211_VERSION);
    });

    it('moves featureAnalysis to gemini-3.7-flash only on v2.11, leaving v2.6 through v2.10 untouched', () => {
        for (const version of [
            AI_STAGE_POLICY_VERSION,
            AI_STAGE_POLICY_LATEST_VERSION,
            AI_STAGE_POLICY_V28_VERSION,
            AI_STAGE_POLICY_V29_VERSION,
            AI_STAGE_POLICY_V210_VERSION,
        ] as const) {
            expect(getAiStagePolicy(version, 'featureAnalysis')).toMatchObject({
                model: 'gemini-3.1-flash-lite',
                thinkingLevel: 'MEDIUM',
            });
        }
        expect(getAiStagePolicy(AI_STAGE_POLICY_V211_VERSION, 'featureAnalysis')).toMatchObject({
            model: 'gemini-3.7-flash',
            thinkingLevel: 'HIGH',
        });
        // Every other stage keeps its v2.10 model on v2.11; only featureAnalysis moved.
        for (const stage of ['genderTriage', 'partnerSafety', 'highRiskNarrative', 'privateAccountName'] as const) {
            expect(getAiStagePolicy(AI_STAGE_POLICY_V211_VERSION, stage).model)
                .toBe(getAiStagePolicy(AI_STAGE_POLICY_V210_VERSION, stage).model);
        }
    });

    it('lowers only v2.7 scheduling concurrency for rate-limited early stages', () => {
        const v26 = AI_STAGE_POLICY_REGISTRY['ai-stage-policy-v2.6'];
        const v27 = AI_STAGE_POLICY_REGISTRY['ai-stage-policy-v2.7'];

        expect(v26.genderTriage.concurrency).toBe(8);
        expect(v26.featureAnalysis.concurrency).toBe(8);
        expect(v26.privateAccountName.concurrency).toBe(4);
        expect(AI_SHARED_CONCURRENCY_LIMIT).toBe(8);

        expect(v27.genderTriage.concurrency).toBe(4);
        expect(v27.featureAnalysis.concurrency).toBe(4);
        expect(v27.privateAccountName.concurrency).toBe(2);

        for (const stage of ['genderTriage', 'featureAnalysis', 'privateAccountName'] as const) {
            expect({ ...v27[stage], concurrency: undefined })
                .toEqual({ ...v26[stage], concurrency: undefined });
        }
    });

    it('adds the bounded resolver only to v2.7', () => {
        expect(getAiStagePolicy('ai-stage-policy-v2.7', 'genderResolution')).toEqual({
            model: 'gemini-3-flash-preview',
            thinkingLevel: 'LOW',
            mediaResolution: 'MEDIUM',
            profileImageLimit: 1,
            feedImageLimit: 4,
            maxOutputTokens: 512,
            concurrency: 2,
            promptVersion: 'gender-resolution-v1',
            schemaVersion: 1,
        });
        expect(() => getAiStagePolicy('ai-stage-policy-v2.6', 'genderResolution'))
            .toThrow('Unsupported AI stage');
        expect(isAiStageName('genderResolution')).toBe(true);
    });

    it('accepts only registered immutable policy versions', () => {
        expect(assertSupportedAiStagePolicyVersion('ai-stage-policy-v2.6'))
            .toBe('ai-stage-policy-v2.6');
        expect(assertSupportedAiStagePolicyVersion('ai-stage-policy-v2.7'))
            .toBe('ai-stage-policy-v2.7');
        expect(assertSupportedAiStagePolicyVersion('ai-stage-policy-v2.8'))
            .toBe('ai-stage-policy-v2.8');
        expect(assertSupportedAiStagePolicyVersion('ai-stage-policy-v2.9'))
            .toBe('ai-stage-policy-v2.9');
        expect(assertSupportedAiStagePolicyVersion('ai-stage-policy-v2.10'))
            .toBe('ai-stage-policy-v2.10');
        expect(assertSupportedAiStagePolicyVersion('ai-stage-policy-v2.11'))
            .toBe('ai-stage-policy-v2.11');
        expect(() => assertSupportedAiStagePolicyVersion('ai-stage-policy-v9'))
            .toThrow('Unsupported AI stage policy version');
        expect(Object.isFrozen(AI_STAGE_POLICY_REGISTRY)).toBe(true);
        expect(Object.isFrozen(AI_STAGE_POLICY_REGISTRY['ai-stage-policy-v2.7'])).toBe(true);
    });

    it('inherits resolver and durable lease capabilities from v2.7 into v2.8', () => {
        expect(aiStagePolicySupports('ai-stage-policy-v2.6', 'genderResolution')).toBe(false);
        for (const version of ['ai-stage-policy-v2.7', 'ai-stage-policy-v2.8'] as const) {
            expect(aiStagePolicySupports(version, 'genderResolution')).toBe(true);
            expect(aiStagePolicySupports(version, 'durableGeminiLease')).toBe(true);
            expect(aiStagePolicySupports(version, 'partialMediaCoverage')).toBe(true);
        }
    });

    it('selects v2.7 only for newly eligible rollout requests', () => {
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'off',
            accessMode: 'production',
        })).toBe('ai-stage-policy-v2.6');
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'production',
            narrativeV28RolloutMode: 'production',
            microbatchV29RolloutMode: 'production',
            accessMode: 'production',
        })).toBe('ai-stage-policy-v2.10');
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'test_entitlement',
            narrativeV28RolloutMode: 'test_entitlement',
            accessMode: 'production',
        })).toBe('ai-stage-policy-v2.6');
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'test_entitlement',
            narrativeV28RolloutMode: 'test_entitlement',
            accessMode: 'test_entitlement',
        })).toBe('ai-stage-policy-v2.8');
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'test_entitlement',
            accessMode: 'test_entitlement',
        })).toBe('ai-stage-policy-v2.7');
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'test_entitlement',
            accessMode: 'production',
        })).toBe('ai-stage-policy-v2.6');
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'production',
            accessMode: 'production',
        })).toBe('ai-stage-policy-v2.7');
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'production',
            accessMode: 'test_entitlement',
        })).toBe('ai-stage-policy-v2.7');
        expect(selectAiStagePolicyVersion({
            rolloutMode: 'unexpected',
            accessMode: 'production',
        })).toBe('ai-stage-policy-v2.6');
    });
});
