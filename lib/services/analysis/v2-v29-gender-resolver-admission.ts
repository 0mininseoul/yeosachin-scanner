import type { GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';

export type AnalysisV29GenderResolverAdmission =
    | 'eligible'
    | 'already_verified'
    | 'nonpersonal_or_unknown'
    | 'insufficient_media';

export function v29GenderResolverAdmission(
    triage: GenderTriageResult,
    resolverMediaCount: number,
): AnalysisV29GenderResolverAdmission {
    const assessment = triage.assessment;
    const alreadyVerified = (
        assessment.inferredGender === 'female'
        || assessment.inferredGender === 'male'
    )
        && assessment.confidence === 'high'
        && assessment.ownerConsistency === 'same_person'
        && new Set(assessment.evidenceSelectionIds).size >= 2;
    if (alreadyVerified) return 'already_verified';
    if (
        triage.v29AccountContext !== 'personal'
        && triage.v29AccountContext !== 'individual_creator'
    ) {
        return 'nonpersonal_or_unknown';
    }
    return resolverMediaCount >= 2 ? 'eligible' : 'insufficient_media';
}
