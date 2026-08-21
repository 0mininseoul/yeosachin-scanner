import type { GenderTriageResult } from '@/lib/services/ai/v2-staged-analysis';

export type AnalysisV29GenderResolverAdmission =
    | 'eligible'
    | 'already_verified'
    | 'official_or_group'
    | 'uncertain_or_absent'
    | 'insufficient_media';

/**
 * Reads CONCIERGE_BATCH_RESOLVER_WIDE_ADMISSION; default true (wide admission
 * active). Set to 'false' or '0' as a kill switch to revert to the legacy
 * account-context gate below if the increased resolver call volume needs to
 * be rolled back.
 */
export function conciergeBatchResolverWideAdmissionEnabled(
    raw = process.env.CONCIERGE_BATCH_RESOLVER_WIDE_ADMISSION,
): boolean {
    return raw !== 'false' && raw !== '0';
}

export function v29GenderResolverAdmission(
    triage: GenderTriageResult,
    resolverMediaCount: number,
    // Explicit override for callers that need the narrow, account-context-gated
    // decision regardless of the global kill switch - e.g. the strong-uncertain
    // resolver experiment, which relies on 'uncertain_or_absent' to identify its
    // own separate research cohort. Production callers omit this and get the
    // env-driven default.
    wideAdmission: boolean = conciergeBatchResolverWideAdmissionEnabled(),
): AnalysisV29GenderResolverAdmission {
    if (triage.v29AccountContext === 'official_group_or_brand') {
        return 'official_or_group';
    }
    const assessment = triage.assessment;
    const alreadyVerified = (
        assessment.inferredGender === 'female'
        || assessment.inferredGender === 'male'
    )
        && assessment.confidence === 'high'
        && assessment.ownerConsistency === 'same_person'
        && new Set(assessment.evidenceSelectionIds).size >= 2;
    if (alreadyVerified) return 'already_verified';
    // An unconfirmed account context (v2.9 triage often can't tell) used to
    // skip the resolver outright even with usable media. Most of the "unknown
    // gender" drop-off traced back to this gate, not to a real lack of media.
    if (
        !wideAdmission
        && triage.v29AccountContext !== 'personal'
        && triage.v29AccountContext !== 'individual_creator'
    ) return 'uncertain_or_absent';
    return resolverMediaCount >= 2 ? 'eligible' : 'insufficient_media';
}
