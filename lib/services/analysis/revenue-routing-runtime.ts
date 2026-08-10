import {
    buildGenderRoutingManifest,
    genderRoutingRetryCandidateKeys,
    GENDER_ROUTING_CAPS,
    type GenderRoutingAssessment,
    type GenderRoutingCandidateInput,
    type GenderRoutingManifest,
    type GenderRoutingPlan,
} from './gender-routing';

export interface RevenueRoutingCandidate extends GenderRoutingCandidateInput {
    /** Links back to the durable relationship row without copying its username into the manifest. */
    readonly mutualOrdinal: number;
}

export interface RevenueGenderRoutingResult {
    readonly manifest: GenderRoutingManifest;
    readonly selectedMutualOrdinals: readonly number[];
}

export interface RouteRevenueGenderCandidatesInput {
    readonly requestId: string;
    readonly relationshipCheckpointId: string;
    readonly accessMode: 'production' | 'test_entitlement';
    readonly planId: GenderRoutingPlan | 'plus';
    readonly candidates: readonly RevenueRoutingCandidate[];
    readonly hmacSecret: string;
    /** The only runtime boundary that can invoke the stage-one model. */
    assess(
        candidates: readonly RevenueRoutingCandidate[],
        attempt: 1 | 2,
    ): Promise<ReadonlyMap<string, GenderRoutingAssessment>>;
}

/** New routing is intentionally unavailable to production and Plus request lineages. */
export function usesRevenueGenderRouting(input: Pick<
    RouteRevenueGenderCandidatesInput,
    'accessMode' | 'planId'
>): input is Pick<RouteRevenueGenderCandidatesInput, 'accessMode' | 'planId'> & {
    accessMode: 'test_entitlement';
    planId: GenderRoutingPlan;
} {
    return input.accessMode === 'test_entitlement'
        && (input.planId === 'basic' || input.planId === 'standard');
}

export async function routeRevenueGenderCandidates(
    input: RouteRevenueGenderCandidatesInput,
): Promise<RevenueGenderRoutingResult | null> {
    if (!usesRevenueGenderRouting(input)) return null;

    const inputByKey = new Map(input.candidates.map(candidate => [candidate.candidateKey, candidate]));
    if (inputByKey.size !== input.candidates.length
        || input.candidates.some(candidate => !Number.isSafeInteger(candidate.mutualOrdinal)
            || candidate.mutualOrdinal < 1)) {
        throw new Error('REVENUE_GENDER_ROUTING_INVALID_CANDIDATES');
    }

    const initial = input.candidates.length <= GENDER_ROUTING_CAPS[input.planId].detailed
        ? undefined
        : await input.assess(input.candidates, 1);
    const retryKeys = initial === undefined
        ? []
        : genderRoutingRetryCandidateKeys({
            candidates: input.candidates,
            assessments: initial,
            hmacSecret: input.hmacSecret,
        });
    const retryCandidates = retryKeys.map(candidateKey => inputByKey.get(candidateKey))
        .filter((candidate): candidate is RevenueRoutingCandidate => candidate !== undefined);
    const retry = retryCandidates.length === 0
        ? undefined
        : await input.assess(retryCandidates, 2);
    const manifest = buildGenderRoutingManifest({
        planId: input.planId,
        requestId: input.requestId,
        relationshipCheckpointId: input.relationshipCheckpointId,
        candidates: input.candidates,
        assessments: initial,
        ...(retry ? { retryAssessments: retry } : {}),
        hmacSecret: input.hmacSecret,
    });
    const selectedMutualOrdinals = manifest.rows
        .filter(row => row.selected)
        .map(row => inputByKey.get(row.candidateKey)?.mutualOrdinal)
        .filter((ordinal): ordinal is number => ordinal !== undefined);
    if (selectedMutualOrdinals.length !== manifest.selectedCount
        || new Set(selectedMutualOrdinals).size !== selectedMutualOrdinals.length) {
        throw new Error('REVENUE_GENDER_ROUTING_SELECTION_DRIFT');
    }
    return Object.freeze({
        manifest,
        selectedMutualOrdinals: Object.freeze(selectedMutualOrdinals),
    });
}
