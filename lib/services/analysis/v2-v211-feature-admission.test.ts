import { describe, expect, it } from 'vitest';
import { v211FeatureAdmission } from './v2-v211-feature-admission';

const triage = (context: 'personal' | 'individual_creator' | 'official_group_or_brand' | 'uncertain') => ({
    assessment: {
        inferredGender: 'unknown' as const,
        confidence: 'low' as const,
        ownerConsistency: 'not_visible' as const,
        evidenceSelectionIds: [],
    },
    routingDecision: 'route_to_feature_analysis' as const,
    routingReason: 'conserve_female_recall' as const,
    analyzedSelectionIds: [],
    v29AccountContext: context,
});

describe('v2.11 feature admission', () => {
    it('admits uncertain and sparse non-male triage into strict feature analysis', () => {
        expect(v211FeatureAdmission(triage('uncertain'), { fullName: null, bio: null }))
            .toBe('eligible');
    });

    it('excludes a model-official account only after deterministic corroboration', () => {
        expect(v211FeatureAdmission(triage('official_group_or_brand'), {
            fullName: 'Official Team', bio: 'official booking shop',
        })).toBe('nonpersonal_or_official');
        expect(v211FeatureAdmission(triage('official_group_or_brand'), {
            fullName: 'Club', bio: null,
        })).toBe('eligible');
    });

    it('blocks an independently corroborated collective profile even when triage calls it personal', () => {
        expect(v211FeatureAdmission(triage('personal'), {
            fullName: 'Black Cherry Club',
            bio: 'Single [콜드브루] Out now',
        })).toBe('nonpersonal_or_official');
    });
});
