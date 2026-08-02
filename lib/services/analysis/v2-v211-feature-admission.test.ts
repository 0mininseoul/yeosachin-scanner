import { describe, expect, it } from 'vitest';
import { v211FeatureAdmission } from './v2-v211-feature-admission';

function triage(overrides: Record<string, unknown> = {}) {
    return {
        assessment: {
            inferredGender: 'unknown' as const,
            confidence: 'low' as const,
            ownerConsistency: 'not_visible' as const,
            evidenceSelectionIds: [],
        },
        routingDecision: 'route_to_feature_analysis' as const,
        routingReason: 'conserve_female_recall' as const,
        analyzedSelectionIds: [],
        v29AccountContext: 'uncertain' as const,
        ...overrides,
    };
}

describe('v2.11 feature admission', () => {
    it('admits an uncertain personal candidate for evidence-based feature classification', () => {
        expect(v211FeatureAdmission(triage(), {
            fullName: '테스트', bio: '일상 기록',
        })).toBe('eligible');
    });

    it('still excludes a corroborated official group account', () => {
        expect(v211FeatureAdmission(triage({
            v29AccountContext: 'official_group_or_brand',
        }), {
            fullName: 'Example Records Official',
            bio: 'New single out now · 공연 예매 문의',
        })).toBe('nonpersonal_or_official');
    });
});
