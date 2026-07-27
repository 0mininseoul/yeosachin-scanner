import type { GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';
import { screenAnalysisV2OfficialAccount } from './v2-official-account-screening';

export type AnalysisV29FeatureAdmission =
    | 'eligible'
    | 'nonpersonal_or_official'
    | 'unsupported_unknown';

/**
 * Shared production/replay admission for the v2.9 feature stage.
 */
export function v29FeatureAdmission(
    triage: GenderTriageResult,
    profile: { fullName?: string | null; bio?: string | null },
): AnalysisV29FeatureAdmission {
    const assessment = triage.assessment;
    const confirmedFemale = assessment.inferredGender === 'female'
        && assessment.confidence === 'high'
        && assessment.ownerConsistency === 'same_person'
        && new Set(assessment.evidenceSelectionIds).size >= 2;
    if (!confirmedFemale) return 'unsupported_unknown';

    const modelAccountContext = triage.v29AccountContext;
    if (!modelAccountContext) return 'unsupported_unknown';
    const screened = screenAnalysisV2OfficialAccount({
        modelAccountContext,
        fullName: profile.fullName ?? null,
        bio: profile.bio ?? null,
    });
    if (modelAccountContext === 'official_group_or_brand') {
        return screened.exclusionReason
            ? 'nonpersonal_or_official'
            : 'unsupported_unknown';
    }
    if (
        modelAccountContext === 'personal'
        || modelAccountContext === 'individual_creator'
    ) {
        return 'eligible';
    }
    return 'unsupported_unknown';
}
