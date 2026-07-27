import { describe, expect, it } from 'vitest';
import type { GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';
import { v29GenderResolverAdmission } from './v2-v29-gender-resolver-admission';

function triage(
    overrides: Partial<GenderTriageResult['assessment']> = {},
    accountContext: GenderTriageResult['v29AccountContext'] = 'personal',
): GenderTriageResult {
    return {
        assessment: {
            inferredGender: 'unknown',
            confidence: 'low',
            ownerConsistency: 'multiple_or_unclear',
            evidenceSelectionIds: ['m1'],
            ...overrides,
        },
        routingDecision: 'route_to_feature_analysis',
        routingReason: 'conserve_female_recall',
        analyzedSelectionIds: ['m1', 'm2'],
        v29AccountContext: accountContext,
    };
}

describe('v2.9 gender resolver admission', () => {
    it('admits an ambiguous personal account with sufficient resolver media', () => {
        expect(v29GenderResolverAdmission(triage(), 2)).toBe('eligible');
    });

    it('does not resolve an already verified female account', () => {
        expect(v29GenderResolverAdmission(triage({
            inferredGender: 'female',
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['m1', 'm2'],
        }), 2)).toBe('already_verified');
    });

    it('reports explicit official context before already-verified appearance', () => {
        expect(v29GenderResolverAdmission(triage({
            inferredGender: 'female',
            confidence: 'high',
            ownerConsistency: 'same_person',
            evidenceSelectionIds: ['m1', 'm2'],
        }, 'official_group_or_brand'), 2)).toBe('official_or_group');
    });

    it.each([
        'official_group_or_brand',
        'uncertain',
    ] as const)('fails closed for %s account context', accountContext => {
        expect(v29GenderResolverAdmission(
            triage({}, accountContext),
            2,
        )).toBe(
            accountContext === 'official_group_or_brand'
                ? 'official_or_group'
                : 'uncertain_or_absent',
        );
    });

    it('fails closed when account context is absent', () => {
        const input = triage();
        delete input.v29AccountContext;
        expect(v29GenderResolverAdmission(input, 2)).toBe('uncertain_or_absent');
    });

    it('requires at least two resolver media items', () => {
        expect(v29GenderResolverAdmission(triage(), 1)).toBe('insufficient_media');
    });
});
