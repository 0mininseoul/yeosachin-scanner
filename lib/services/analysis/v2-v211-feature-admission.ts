import type { GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';
import { screenAnalysisV2OfficialAccount } from './v2-official-account-screening';
import type { AnalysisV29FeatureAdmission } from './v2-v29-feature-admission';

/**
 * The v2.11 quality pass retains the cheap high-confidence male exclusion, but
 * lets every remaining non-official account reach the richer feature classifier.
 * Feature evidence rules still decide whether a final binary classification is
 * verified, so an uncertain triage result is never promoted by this admission.
 */
export function v211FeatureAdmission(
    triage: GenderTriageResult,
    profile: { fullName?: string | null; bio?: string | null },
): AnalysisV29FeatureAdmission {
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
