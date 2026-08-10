import {
    buildGenderRoutingManifest,
    createGenderRoutingCanonicalInputHmac,
    createGenderRoutingImageContentHmac,
    GenderRoutingError,
    genderRoutingRetryCandidateKeys,
    GENDER_ROUTING_CAPS,
    normalizeGenderRoutingFullname,
    type GenderRoutingAssessment,
    type GenderRoutingCandidateInput,
    type GenderRoutingManifest,
    type GenderRoutingPlan,
} from './gender-routing';
import type {
    AnalysisV2GenderRoutingManifestHeader,
    AnalysisV2GenderRoutingManifestStore,
} from './gender-routing-manifest-store';

export interface RevenueRoutingCandidate {
    /** Links back to the durable relationship row without copying its username into the manifest. */
    readonly mutualOrdinal: number;
    readonly candidateKey: string;
    /** A fetch locator only. It is never passed to the assessor or persistence RPC. */
    readonly profilePicUrl: string | null;
    readonly fullname: string | null;
}

export interface RevenueGenderRoutingResult {
    readonly manifest: GenderRoutingManifest;
    readonly selectedMutualOrdinals: readonly number[];
}

/** The assessor sees only normalized ephemeral evidence, never an image URL. */
export interface RevenueGenderRoutingModelCandidate {
    readonly candidateKey: string;
    readonly fullname: string | null;
    readonly imageBytes: Uint8Array | null;
}

/** Raw inputs permitted to the stage-one preparation adapter. */
export interface RevenueGenderRoutingPreparationSource {
    readonly candidateKey: string;
    readonly profilePicUrl: string | null;
    readonly fullname: string | null;
}

/**
 * Per-candidate preparation outcome. An image-fetch or normalization failure
 * is represented by imageBytes=null, making the candidate name-only or none.
 */
export interface RevenueGenderRoutingPreparedCandidate {
    readonly candidateKey: string;
    readonly fullname: string | null;
    readonly imageBytes: Uint8Array | null;
}

export type RevenueGenderRoutingInputPreparer = (
    candidates: readonly RevenueGenderRoutingPreparationSource[],
) => Promise<readonly RevenueGenderRoutingPreparedCandidate[]>;

/**
 * The adapter seam intentionally performs no network I/O until the image
 * transport/normalizer is installed. It preserves normalized names and makes
 * every unresolved image URL name-only/none rather than pretending URL
 * presence is image evidence.
 */
export const prepareRevenueGenderRoutingInputs: RevenueGenderRoutingInputPreparer = async candidates => (
    Object.freeze(candidates.map(candidate => Object.freeze({
        candidateKey: candidate.candidateKey,
        fullname: candidate.fullname,
        imageBytes: null,
    })))
);

export interface RouteRevenueGenderCandidatesInput {
    readonly requestId: string;
    readonly relationshipCheckpointId: string;
    readonly accessMode: 'production' | 'test_entitlement';
    readonly planId: GenderRoutingPlan | 'plus';
    readonly candidates: readonly RevenueRoutingCandidate[];
    readonly hmacSecret: string;
    /** Called only for N > detailed cap, before the durable manifest begin. */
    readonly inputPreparer?: RevenueGenderRoutingInputPreparer;
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

interface PreparedRevenueRoutingPopulation {
    readonly candidates: readonly GenderRoutingCandidateInput[];
    readonly modelCandidates: readonly RevenueGenderRoutingModelCandidate[];
}

function assertRevenueRoutingCandidates(input: RouteRevenueGenderCandidatesInput): Map<string, RevenueRoutingCandidate> {
    const cap = GENDER_ROUTING_CAPS[input.planId as GenderRoutingPlan];
    if (input.candidates.length > cap.population) {
        throw new GenderRoutingError('POPULATION_OVER_CAP');
    }
    const inputByKey = new Map(input.candidates.map(candidate => [candidate.candidateKey, candidate]));
    if (inputByKey.size !== input.candidates.length
        || input.candidates.some(candidate => !Number.isSafeInteger(candidate.mutualOrdinal)
            || candidate.mutualOrdinal < 1)) {
        throw new Error('REVENUE_GENDER_ROUTING_INVALID_CANDIDATES');
    }
    return inputByKey;
}

function stageSkippedPopulation(candidates: readonly RevenueRoutingCandidate[]): PreparedRevenueRoutingPopulation {
    return Object.freeze({
        candidates: Object.freeze(candidates.map(candidate => Object.freeze({
            candidateKey: candidate.candidateKey,
            fullname: candidate.fullname,
            imageContentHmac: null,
        }))),
        modelCandidates: Object.freeze([]),
    });
}

async function prepareRevenueRoutingPopulation(
    input: RouteRevenueGenderCandidatesInput,
): Promise<PreparedRevenueRoutingPopulation> {
    const cap = GENDER_ROUTING_CAPS[input.planId as GenderRoutingPlan];
    if (input.candidates.length <= cap.detailed) return stageSkippedPopulation(input.candidates);

    const sources = Object.freeze(input.candidates.map(candidate => Object.freeze({
        candidateKey: candidate.candidateKey,
        profilePicUrl: candidate.profilePicUrl,
        fullname: candidate.fullname,
    })));
    const prepared = await (input.inputPreparer ?? prepareRevenueGenderRoutingInputs)(sources);
    const byKey = new Map(prepared.map(candidate => [candidate.candidateKey, candidate]));
    if (prepared.length !== input.candidates.length || byKey.size !== input.candidates.length
        || input.candidates.some(candidate => !byKey.has(candidate.candidateKey))) {
        throw new Error('REVENUE_GENDER_ROUTING_PREPARATION_DRIFT');
    }

    const candidates: GenderRoutingCandidateInput[] = [];
    const modelCandidates: RevenueGenderRoutingModelCandidate[] = [];
    for (const source of input.candidates) {
        const candidate = byKey.get(source.candidateKey)!;
        if (
            candidate.fullname !== null && typeof candidate.fullname !== 'string'
            || candidate.imageBytes !== null && !(candidate.imageBytes instanceof Uint8Array)
            || candidate.imageBytes !== null && (candidate.imageBytes.byteLength < 1 || candidate.imageBytes.byteLength > 256 * 1024)
        ) throw new Error('REVENUE_GENDER_ROUTING_PREPARATION_INVALID');
        const fullname = normalizeGenderRoutingFullname(candidate.fullname);
        const imageContentHmac = candidate.imageBytes === null
            ? null
            : createGenderRoutingImageContentHmac({
                hmacSecret: input.hmacSecret,
                imageBytes: candidate.imageBytes,
            });
        candidates.push(Object.freeze({ candidateKey: candidate.candidateKey, fullname, imageContentHmac }));
        modelCandidates.push(Object.freeze({
            candidateKey: candidate.candidateKey,
            fullname,
            imageBytes: candidate.imageBytes,
        }));
    }
    return Object.freeze({ candidates: Object.freeze(candidates), modelCandidates: Object.freeze(modelCandidates) });
}

async function routePreparedRevenueGenderCandidates(input: RouteRevenueGenderCandidatesInput, population: PreparedRevenueRoutingPopulation): Promise<RevenueGenderRoutingResult> {
    const inputByKey = assertRevenueRoutingCandidates(input);
    const callableModelCandidates = population.modelCandidates.filter(candidate => (
        candidate.imageBytes !== null || candidate.fullname !== null
    ));
    const initial = input.candidates.length <= GENDER_ROUTING_CAPS[input.planId as GenderRoutingPlan].detailed
        ? undefined
        : await input.assess(callableModelCandidates, 1);
    const retryKeys = initial === undefined
        ? []
        : genderRoutingRetryCandidateKeys({
            candidates: population.candidates,
            assessments: initial,
            hmacSecret: input.hmacSecret,
        });
    const retryCandidates = retryKeys.map(candidateKey => population.modelCandidates.find(candidate => candidate.candidateKey === candidateKey))
        .filter((candidate): candidate is RevenueGenderRoutingModelCandidate => candidate !== undefined);
    const retry = retryCandidates.length === 0
        ? undefined
        : await input.assess(retryCandidates, 2);
    const manifest = buildGenderRoutingManifest({
        planId: input.planId as GenderRoutingPlan,
        requestId: input.requestId,
        relationshipCheckpointId: input.relationshipCheckpointId,
        candidates: population.candidates,
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

export async function routeRevenueGenderCandidates(
    input: RouteRevenueGenderCandidatesInput,
): Promise<RevenueGenderRoutingResult | null> {
    if (!usesRevenueGenderRouting(input)) return null;
    assertRevenueRoutingCandidates(input);
    return routePreparedRevenueGenderCandidates(input, await prepareRevenueRoutingPopulation(input));
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

    const population = await prepareRevenueRoutingPopulation(input);
    const canonicalInputHmac = createGenderRoutingCanonicalInputHmac({
        candidates: population.candidates,
        hmacSecret: input.hmacSecret,
    });
    const manifestIdentity = {
        requestId: input.requestId,
        relationshipCheckpointId: input.relationshipCheckpointId,
        policyVersion: 'gender-routing-v1' as const,
        planId: input.planId,
        canonicalInputHmac,
    };
    const begin = await input.manifestStore.begin({
        ...manifestIdentity,
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
        const routed = await routePreparedRevenueGenderCandidates(input, population);
        const ordinalByCandidateKey = new Map(input.candidates.map(candidate => [
            candidate.candidateKey,
            candidate.mutualOrdinal,
        ]));
        header = await input.manifestStore.publish({
            ...manifestIdentity,
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
    const selected = await input.manifestStore.loadSelected({
        requestId: input.requestId,
        relationshipCheckpointId: input.relationshipCheckpointId,
        policyVersion: 'gender-routing-v1',
        planId: input.planId,
    });
    if (selected.length !== header.selectedCount || selected.length > cap.detailed) {
        throw new Error('REVENUE_GENDER_ROUTING_SELECTION_DRIFT');
    }
    return Object.freeze({
        header,
        canonicalInputHmac,
        selectedMutualOrdinals: Object.freeze(selected.map(row => row.mutualOrdinal)),
    });
}
