import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('v2.9 gender resolver admission', () => {
    it('admits an ambiguous personal account with sufficient resolver media', () => {
        expect(v29GenderResolverAdmission(triage(), 2)).toBe('eligible');
    });

    // Criterion 1: an unconfirmed/non-personal account context no longer blocks
    // the resolver by itself once media is sufficient (the bottleneck this
    // change targets - most of the 45 canary "unknown" drops were exactly this).
    it.each([
        'uncertain',
        undefined,
    ] as const)('admits a %s account context under wide admission (default) when media is sufficient', accountContext => {
        const input = triage({}, accountContext as GenderTriageResult['v29AccountContext']);
        if (accountContext === undefined) delete input.v29AccountContext;
        expect(v29GenderResolverAdmission(input, 2)).toBe('eligible');
    });

    // Criterion 2: the official/group/brand exclusion is untouched by the gate removal.
    it('still excludes an official_group_or_brand account regardless of media', () => {
        expect(v29GenderResolverAdmission(triage({}, 'official_group_or_brand'), 2))
            .toBe('official_or_group');
    });

    // Criterion 3: an already-confirmed account is still never re-resolved.
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

    // Criterion 4: the physical media-count floor still applies, now for any
    // context (previously only reachable for personal/individual_creator).
    it('requires at least two resolver media items', () => {
        expect(v29GenderResolverAdmission(triage(), 1)).toBe('insufficient_media');
    });

    it('requires at least two resolver media items for an uncertain account context too', () => {
        expect(v29GenderResolverAdmission(triage({}, 'uncertain'), 1)).toBe('insufficient_media');
    });

    // Criterion 5: the kill switch restores the legacy account-context gate.
    it('falls back to the legacy account-context gate when the kill switch is off', () => {
        vi.stubEnv('CONCIERGE_BATCH_RESOLVER_WIDE_ADMISSION', 'false');
        expect(v29GenderResolverAdmission(triage({}, 'uncertain'), 2)).toBe('uncertain_or_absent');

        const input = triage();
        delete input.v29AccountContext;
        expect(v29GenderResolverAdmission(input, 2)).toBe('uncertain_or_absent');

        // Official/already-verified/media-floor checks still run first even
        // with the kill switch off - only the uncertain-context path reverts.
        expect(v29GenderResolverAdmission(triage({}, 'official_group_or_brand'), 2))
            .toBe('official_or_group');
        expect(v29GenderResolverAdmission(triage(), 1)).toBe('insufficient_media');
        expect(v29GenderResolverAdmission(triage(), 2)).toBe('eligible');
    });

    it.each(['false', '0'] as const)('treats %s as the kill switch value', flag => {
        vi.stubEnv('CONCIERGE_BATCH_RESOLVER_WIDE_ADMISSION', flag);
        expect(v29GenderResolverAdmission(triage({}, 'uncertain'), 2)).toBe('uncertain_or_absent');
    });
});
