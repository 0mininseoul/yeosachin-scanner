import type { GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';

type Context = 'personal' | 'individual_creator' | 'official_group_or_brand' | 'uncertain';
type Decision = 'verified_female' | 'verified_non_female' | 'unresolved' | 'unresolved_stage_conflict';

/** Late resolution is recovery for triage uncertainty, never an override path for a high binary. */
export function v211LateGenderResolverEligible(
    triage: GenderTriageResult,
    featureContext: Context,
    featureDecision: Decision,
    resolverMediaCount: number,
): boolean {
    const assessment = triage.assessment;
    const highBinary = (assessment.inferredGender === 'female' || assessment.inferredGender === 'male')
        && assessment.confidence === 'high'
        && assessment.ownerConsistency === 'same_person'
        && new Set(assessment.evidenceSelectionIds).size >= 2;
    return !highBinary
        && (triage.v29AccountContext === 'uncertain' || triage.v29AccountContext === undefined)
        && (featureContext === 'personal' || featureContext === 'individual_creator')
        && (featureDecision === 'unresolved' || featureDecision === 'unresolved_stage_conflict')
        && resolverMediaCount >= 2;
}
