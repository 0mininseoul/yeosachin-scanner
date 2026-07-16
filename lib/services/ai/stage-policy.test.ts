import { describe, expect, it } from 'vitest';
import {
    AI_STAGE_NAMES,
    AI_STAGE_POLICIES,
    AI_STAGE_POLICY_VERSION,
    AI_CONCURRENCY_ENFORCEMENT_SCOPE,
    AI_SHARED_CONCURRENCY_LIMIT,
    getAiStagePolicy,
    isAiStageName,
} from './stage-policy';

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
        expect(AI_STAGE_POLICY_VERSION).toBe('ai-stage-policy-v2.3');
        expect(AI_SHARED_CONCURRENCY_LIMIT).toBe(10);
        expect(Math.max(...Object.values(AI_STAGE_POLICIES).map(policy => policy.concurrency)))
            .toBeLessThanOrEqual(AI_SHARED_CONCURRENCY_LIMIT);
    });

    it('versions only the caption-aware partner and narrative contracts at v2', () => {
        expect(getAiStagePolicy('partnerSafety')).toMatchObject({
            promptVersion: 'partner-safety-v2',
            schemaVersion: 2,
        });
        expect(getAiStagePolicy('highRiskNarrative')).toMatchObject({
            promptVersion: 'high-risk-narrative-v2',
            schemaVersion: 2,
        });
        expect(getAiStagePolicy('genderTriage')).toMatchObject({
            promptVersion: 'gender-triage-v1',
            schemaVersion: 1,
        });
        expect(getAiStagePolicy('featureAnalysis')).toMatchObject({
            promptVersion: 'feature-analysis-v1',
            schemaVersion: 1,
        });
        expect(getAiStagePolicy('privateAccountName')).toMatchObject({
            promptVersion: 'private-account-name-v1',
            schemaVersion: 1,
        });
    });

    it('states that concurrency is process-local and keeps 100-row name output capacity', () => {
        expect(AI_CONCURRENCY_ENFORCEMENT_SCOPE).toBe('process');
        expect(getAiStagePolicy('privateAccountName').maxOutputTokens).toBe(8_192);
    });
});
