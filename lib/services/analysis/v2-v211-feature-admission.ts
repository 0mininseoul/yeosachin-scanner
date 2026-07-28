import type { GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';
import {
    hasAnalysisV2PreFeatureOfficialSignals,
    screenAnalysisV2OfficialAccount,
} from './v2-official-account-screening';
import type { AnalysisV29FeatureAdmission } from './v2-v29-feature-admission';

/**
 * Evaluation-only v2.11 admission. Triage still cuts off only a high-confidence same-owner
 * male. Every other candidate gets the richer strict feature decision unless an independently
 * corroborated official/group page is already known.
 */
export function v211FeatureAdmission(
    triage: GenderTriageResult,
    profile: { fullName?: string | null; bio?: string | null },
): AnalysisV29FeatureAdmission {
    if (hasAnalysisV2PreFeatureOfficialSignals({
        fullName: profile.fullName ?? null,
        bio: profile.bio ?? null,
    })) {
        return 'nonpersonal_or_official';
    }
    if (triage.v29AccountContext === 'official_group_or_brand') {
        const screening = screenAnalysisV2OfficialAccount({
            modelAccountContext: triage.v29AccountContext,
            fullName: profile.fullName ?? null,
            bio: profile.bio ?? null,
        });
        if (screening.exclusionReason) return 'nonpersonal_or_official';
    }
    return 'eligible';
}

/** A feature-stage collective label is a hard resolver stop, even if scoring later downgrades it. */
export function v211FeatureResolverExcluded(
    accountContext: 'personal' | 'individual_creator' | 'official_group_or_brand' | 'uncertain',
): boolean {
    return accountContext === 'official_group_or_brand';
}
