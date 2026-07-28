import { describe, expect, it } from 'vitest';
import { v211LateGenderResolverEligible } from './v2-v211-gender-resolver-admission';

const triage = (overrides = {}) => ({
    assessment: { inferredGender: 'unknown' as const, confidence: 'low' as const, ownerConsistency: 'not_visible' as const, evidenceSelectionIds: [] },
    routingDecision: 'route_to_feature_analysis' as const,
    routingReason: 'conserve_female_recall' as const,
    analyzedSelectionIds: [],
    v29AccountContext: 'uncertain' as const,
    ...overrides,
});

describe('v2.11 late resolver admission', () => {
    it('allows only uncertain or absent triage to receive a late resolver', () => {
        expect(v211LateGenderResolverEligible(triage(), 'personal', 'unresolved', 2)).toBe(true);
        expect(v211LateGenderResolverEligible(triage({
            assessment: { inferredGender: 'female', confidence: 'high', ownerConsistency: 'same_person', evidenceSelectionIds: ['a', 'b'] },
            v29AccountContext: 'personal',
        }), 'personal', 'unresolved_stage_conflict', 2)).toBe(false);
    });
});
