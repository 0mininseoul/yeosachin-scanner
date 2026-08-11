import { describe, expect, it, vi } from 'vitest';
import {
    createProductionAnalysisV2AiScoringExecutorDependencies,
    createProductionAnalysisV2AiScoringExecutorRegistry,
} from './v2-ai-scoring-production';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

describe('analysis V2 production AI/scoring registry', () => {
    it('always wires strict primary/final quality dependencies so a strict marker cannot auto-finalize through an optional gap', () => {
        const dependencies = createProductionAnalysisV2AiScoringExecutorDependencies({
            ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: 'analysis-v2-private-media',
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary',
            APIFY_QUINARY_API_TOKEN: 'unit-test-token', // gitleaks:allow
        });

        expect(dependencies.revenueFinalQualityGate).toMatchObject({
            isApplicable: expect.any(Function),
            verify: expect.any(Function),
        });
        expect(dependencies.revenueResolverCapacity).toMatchObject({
            bind: expect.any(Function),
        });
    });

    it('lazily assembles every post-collection executor with the explicit V2 token slot', () => {
        const registry = createProductionAnalysisV2AiScoringExecutorRegistry({
            ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: 'analysis-v2-private-media',
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary',
            APIFY_QUINARY_API_TOKEN: 'unit-test-token', // gitleaks:allow
        });

        expect(Object.keys(registry).sort()).toEqual([
            'final_score',
            'finalize',
            'narrative',
            'partner_safety',
            'primary_join',
            'private_names',
            'profile_ai',
            'reverse_likes',
            'screening',
        ]);
    });

    it('fails at factory invocation when private storage or the selected token is missing', () => {
        expect(() => createProductionAnalysisV2AiScoringExecutorRegistry({
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary',
            APIFY_QUINARY_API_TOKEN: 'unit-test-token', // gitleaks:allow
        })).toThrow('ANALYSIS_V2_MEDIA_ARTIFACT_CONFIG_ERROR');

        expect(() => createProductionAnalysisV2AiScoringExecutorRegistry({
            ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: 'analysis-v2-private-media',
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary',
        })).toThrow('APIFY_QUINARY_API_TOKEN');
    });

    it('requires complete private R2 configuration only when result images are enabled', () => {
        expect(() => createProductionAnalysisV2AiScoringExecutorRegistry({
            ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: 'analysis-v2-private-media',
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'quinary',
            APIFY_QUINARY_API_TOKEN: 'unit-test-token', // gitleaks:allow
            ANALYSIS_V2_RESULT_IMAGES_ENABLED: 'true',
        })).toThrow('ANALYSIS_V2_RESULT_IMAGE_CONFIG_ERROR');
    });
});
