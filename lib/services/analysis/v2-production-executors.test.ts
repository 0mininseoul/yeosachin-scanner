import { describe, expect, it, vi } from 'vitest';
import {
    createAnalysisV2ProductionCollectionDependencies,
    createAnalysisV2ProductionExecutorRegistry,
} from './v2-production-executors';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

describe('analysis V2 production executor registry', () => {
    it('injects the concrete image preparer and the strict-only production assessor factory', () => {
        const preparer = vi.fn();
        const assessorFactory = vi.fn();
        expect(createAnalysisV2ProductionCollectionDependencies({})
            .revenueGenderRoutingInputPreparer).toBeTypeOf('function');
        expect(createAnalysisV2ProductionCollectionDependencies({})
            .revenueGenderRoutingAssessorFactory).toBeTypeOf('function');
        const dependencies = createAnalysisV2ProductionCollectionDependencies({}, {
            revenueGenderRoutingInputPreparer: preparer,
            revenueGenderRoutingAssessorFactory: assessorFactory,
        });

        expect(dependencies.revenueGenderRoutingInputPreparer).toBe(preparer);
        expect(dependencies.revenueGenderRoutingAssessorFactory).toBe(assessorFactory);
        expect(dependencies).not.toHaveProperty('revenueGenderRoutingAssessor');
        expect(() => createAnalysisV2ProductionExecutorRegistry({
            ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: 'analysis-v2-private-media',
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'tertiary',
            APIFY_TERTIARY_API_TOKEN: 'unit-test-token', // gitleaks:allow
        }, {
            revenueGenderRoutingInputPreparer: preparer,
            revenueGenderRoutingAssessorFactory: assessorFactory,
        })).not.toThrow();
    });

    it('contains every durable DAG stage without an empty production fallback', () => {
        const registry = createAnalysisV2ProductionExecutorRegistry({
            ANALYSIS_V2_MEDIA_ARTIFACT_BUCKET: 'analysis-v2-private-media',
            ANALYSIS_V2_APIFY_API_TOKEN_SLOT: 'tertiary',
            APIFY_TERTIARY_API_TOKEN: 'unit-test-token', // gitleaks:allow
        });

        expect(Object.keys(registry).sort()).toEqual([
            'final_score',
            'finalize',
            'narrative',
            'partner_safety',
            'primary_join',
            'private_names',
            'profile_ai',
            'profile_fetch',
            'relationships',
            'reverse_likes',
            'screening',
            'target_evidence',
        ]);
        expect(Object.isFrozen(registry)).toBe(true);
    });
});
