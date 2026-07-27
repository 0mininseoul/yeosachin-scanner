import type { GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';

export type AnalysisV29GenderResolverAdmission =
    | 'eligible'
    | 'already_verified'
    | 'official_or_group'
    | 'uncertain_or_absent'
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
    if (triage.v29AccountContext === 'official_group_or_brand') {
        return 'official_or_group';
    }
    if (
        triage.v29AccountContext !== 'personal'
        && triage.v29AccountContext !== 'individual_creator'
    ) return 'uncertain_or_absent';
    return resolverMediaCount >= 2 ? 'eligible' : 'insufficient_media';
}
