import {
    buildGenderRoutingManifest,
    createGenderRoutingCanonicalInputHmac,
    GenderRoutingError,
    genderRoutingRetryCandidateKeys,
    GENDER_ROUTING_CAPS,
    type GenderRoutingAssessment,
    type GenderRoutingCandidateInput,
    type GenderRoutingManifest,
    type GenderRoutingPlan,
} from './gender-routing';
import type {
    AnalysisV2GenderRoutingManifestHeader,
    AnalysisV2GenderRoutingManifestStore,
} from './gender-routing-manifest-store';

export interface RevenueRoutingCandidate extends GenderRoutingCandidateInput {
    /** Links back to the durable relationship row without copying its username into the manifest. */
    readonly mutualOrdinal: number;
}

export interface RevenueGenderRoutingResult {
    readonly manifest: GenderRoutingManifest;
    readonly selectedMutualOrdinals: readonly number[];
}

/** The assessor sees no relationship identity or cached profile material. */
export interface RevenueGenderRoutingModelCandidate {
    readonly candidateKey: string;
    readonly profilePicUrl: string | null;
    readonly fullname: string | null;
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
        candidates: readonly RevenueGenderRoutingModelCandidate[],
        attempt: 1 | 2,
    ): Promise<ReadonlyMap<string, GenderRoutingAssessment>>;
}

export interface PersistRevenueGenderRoutingInput extends RouteRevenueGenderCandidatesInput {
    readonly jobKey: 'track:relationships:collect';
    readonly claimToken: string;
    readonly jobInputHash: string;
    readonly manifestStore: AnalysisV2GenderRoutingManifestStore;
}

export interface PersistedRevenueGenderRoutingResult {
    readonly header: Extract<AnalysisV2GenderRoutingManifestHeader, { status: 'complete' }>;
    readonly canonicalInputHmac: string;
    readonly selectedMutualOrdinals: readonly number[];
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

    if (input.candidates.length > GENDER_ROUTING_CAPS[input.planId].population) {
        throw new GenderRoutingError('POPULATION_OVER_CAP');
    }

    const inputByKey = new Map(input.candidates.map(candidate => [candidate.candidateKey, candidate]));
    if (inputByKey.size !== input.candidates.length
        || input.candidates.some(candidate => !Number.isSafeInteger(candidate.mutualOrdinal)
            || candidate.mutualOrdinal < 1)) {
        throw new Error('REVENUE_GENDER_ROUTING_INVALID_CANDIDATES');
    }

    const modelCandidates: readonly RevenueGenderRoutingModelCandidate[] = Object.freeze(input.candidates.map(candidate => ({
        candidateKey: candidate.candidateKey,
        profilePicUrl: candidate.profilePicUrl,
        fullname: candidate.fullname,
    })));
    const callableModelCandidates = modelCandidates.filter(candidate => (
        candidate.profilePicUrl !== null
        || (candidate.fullname !== null && candidate.fullname.trim().length > 0)
    ));
    const initial = input.candidates.length <= GENDER_ROUTING_CAPS[input.planId].detailed
        ? undefined
        : await input.assess(callableModelCandidates, 1);
    const retryKeys = initial === undefined
        ? []
        : genderRoutingRetryCandidateKeys({
            candidates: input.candidates,
            assessments: initial,
            hmacSecret: input.hmacSecret,
        });
    const retryCandidates = retryKeys.map(candidateKey => modelCandidates.find(candidate => candidate.candidateKey === candidateKey))
        .filter((candidate): candidate is RevenueGenderRoutingModelCandidate => candidate !== undefined);
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

/**
 * Publishes the selector result as the sole durable routing authority. A
 * completed manifest is loaded without model work; a building manifest is
 * published atomically before its selected ordinals are exposed.
 */
export async function routeAndPersistRevenueGenderCandidates(
    input: PersistRevenueGenderRoutingInput,
): Promise<PersistedRevenueGenderRoutingResult | null> {
    if (!usesRevenueGenderRouting(input)) return null;

    const cap = GENDER_ROUTING_CAPS[input.planId];
    if (
        input.candidates.length > cap.population
        || new Set(input.candidates.map(candidate => candidate.mutualOrdinal)).size !== input.candidates.length
        || input.candidates.some(candidate => candidate.candidateKey !== `mutual:${candidate.mutualOrdinal}`)
    ) throw new Error('REVENUE_GENDER_ROUTING_INVALID_CANDIDATES');

    const canonicalInputHmac = createGenderRoutingCanonicalInputHmac({
        candidates: input.candidates,
        hmacSecret: input.hmacSecret,
    });
    const identity = {
        requestId: input.requestId,
        relationshipCheckpointId: input.relationshipCheckpointId,
        policyVersion: 'gender-routing-v1' as const,
        planId: input.planId,
        canonicalInputHmac,
    };
    const begin = await input.manifestStore.begin({
        ...identity,
        jobKey: input.jobKey,
        claimToken: input.claimToken,
        jobInputHash: input.jobInputHash,
        populationCount: input.candidates.length,
        detailedCap: cap.detailed,
    });
    let header = begin;
    if (begin.status !== 'complete') {
        if (begin.status !== 'building') {
            throw new Error('REVENUE_GENDER_ROUTING_MANIFEST_UNAVAILABLE');
        }
        const routed = await routeRevenueGenderCandidates(input);
        if (!routed) throw new Error('REVENUE_GENDER_ROUTING_MANIFEST_UNAVAILABLE');
        const ordinalByCandidateKey = new Map(input.candidates.map(candidate => [
            candidate.candidateKey,
            candidate.mutualOrdinal,
        ]));
        header = await input.manifestStore.publish({
            ...identity,
            jobKey: input.jobKey,
            claimToken: input.claimToken,
            jobInputHash: input.jobInputHash,
            populationCount: routed.manifest.populationCount,
            detailedCap: cap.detailed,
            selectedCount: routed.manifest.selectedCount,
            modelAttemptedCount: routed.manifest.modelAttemptedCount,
            modelValidCount: routed.manifest.modelValidCount,
            modelFailedCount: routed.manifest.modelFailedCount,
            modelRetriedCount: routed.manifest.modelRetriedCount,
            quotaShortfalls: routed.manifest.quotaShortfalls,
            bucketCounts: routed.manifest.bucketCounts,
            selectedBucketCounts: routed.manifest.selectedBucketCounts,
            rows: routed.manifest.rows.map(row => ({
                ...row,
                mutualOrdinal: ordinalByCandidateKey.get(row.candidateKey) ?? 0,
            })),
        });
    }
    if (header.status !== 'complete') {
        throw new Error('REVENUE_GENDER_ROUTING_MANIFEST_UNAVAILABLE');
    }
    const selected = await input.manifestStore.loadSelected(identity);
    if (selected.length !== header.selectedCount || selected.length > cap.detailed) {
        throw new Error('REVENUE_GENDER_ROUTING_SELECTION_DRIFT');
    }
    return Object.freeze({
        header,
        canonicalInputHmac,
        selectedMutualOrdinals: Object.freeze(selected.map(row => row.mutualOrdinal)),
    });
}
