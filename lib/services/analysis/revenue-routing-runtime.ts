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
    /** Immutable transport of the exact normalized bytes bound into imageContentHmac. */
    readonly imageBase64: string | null;
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
    assess?(
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
    readonly evidenceByCandidateKey: ReadonlyMap<string, Readonly<{
        fullname: string | null;
        imageBytes: Uint8Array | null;
    }>>;
}

/** A bounded request-local ceiling; assessor payloads are separately capped at ten rows. */
export const REVENUE_GENDER_ROUTING_MAX_AGGREGATE_NORMALIZED_IMAGE_BYTES = 8 * 1024 * 1024;
export const REVENUE_GENDER_ROUTING_ASSESSOR_MICROBATCH_SIZE = 10;

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
        evidenceByCandidateKey: new Map(),
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
    const evidenceByCandidateKey = new Map<string, Readonly<{
        fullname: string | null;
        imageBytes: Uint8Array | null;
    }>>();
    const normalizedImageByHmac = new Map<string, Uint8Array>();
    let aggregateNormalizedImageBytes = 0;
    for (const source of input.candidates) {
        const candidate = byKey.get(source.candidateKey)!;
        if (
            candidate.candidateKey !== source.candidateKey
            || candidate.fullname !== source.fullname
            || candidate.fullname !== null && typeof candidate.fullname !== 'string'
            || candidate.imageBytes !== null && !(candidate.imageBytes instanceof Uint8Array)
            || candidate.imageBytes !== null && (candidate.imageBytes.byteLength < 1 || candidate.imageBytes.byteLength > 256 * 1024)
        ) throw new Error('REVENUE_GENDER_ROUTING_PREPARATION_DRIFT');
        const fullname = normalizeGenderRoutingFullname(candidate.fullname);
        const imageContentHmac = candidate.imageBytes === null
            ? null
            : createGenderRoutingImageContentHmac({
                hmacSecret: input.hmacSecret,
                imageBytes: candidate.imageBytes,
            });
        let imageBytes: Uint8Array | null = null;
        if (candidate.imageBytes !== null) {
            imageBytes = normalizedImageByHmac.get(imageContentHmac!) ?? null;
            if (imageBytes === null) {
                if (aggregateNormalizedImageBytes + candidate.imageBytes.byteLength
                    > REVENUE_GENDER_ROUTING_MAX_AGGREGATE_NORMALIZED_IMAGE_BYTES) {
                    throw new Error('REVENUE_GENDER_ROUTING_IMAGE_BUDGET_EXCEEDED');
                }
                // Detach the durable-in-memory evidence snapshot from a mutable preparer result.
                imageBytes = new Uint8Array(candidate.imageBytes);
                normalizedImageByHmac.set(imageContentHmac!, imageBytes);
                aggregateNormalizedImageBytes += imageBytes.byteLength;
            }
        }
        candidates.push(Object.freeze({ candidateKey: candidate.candidateKey, fullname, imageContentHmac }));
        evidenceByCandidateKey.set(candidate.candidateKey, Object.freeze({
            fullname,
            imageBytes,
        }));
    }
    return Object.freeze({ candidates: Object.freeze(candidates), evidenceByCandidateKey });
}

function modelCandidatesForKeys(
    candidateKeys: readonly string[],
    population: PreparedRevenueRoutingPopulation,
): readonly RevenueGenderRoutingModelCandidate[] {
    return Object.freeze(candidateKeys.map(candidateKey => {
        const evidence = population.evidenceByCandidateKey.get(candidateKey);
        if (!evidence) throw new Error('REVENUE_GENDER_ROUTING_PREPARATION_DRIFT');
        return Object.freeze({
            candidateKey,
            fullname: evidence.fullname,
            imageBase64: evidence.imageBytes === null
                ? null
                : Buffer.from(evidence.imageBytes).toString('base64'),
        });
    }));
}

async function assessMicrobatches(
    input: RouteRevenueGenderCandidatesInput,
    population: PreparedRevenueRoutingPopulation,
    candidateKeys: readonly string[],
    attempt: 1 | 2,
): Promise<ReadonlyMap<string, GenderRoutingAssessment>> {
    if (!input.assess) throw new Error('ANALYSIS_V2_GENDER_ROUTING_ASSESSOR_MISSING');
    const assessments = new Map<string, GenderRoutingAssessment>();
    for (let start = 0; start < candidateKeys.length; start += REVENUE_GENDER_ROUTING_ASSESSOR_MICROBATCH_SIZE) {
        const batch = modelCandidatesForKeys(
            candidateKeys.slice(start, start + REVENUE_GENDER_ROUTING_ASSESSOR_MICROBATCH_SIZE),
            population,
        );
        const result = await input.assess(batch, attempt);
        for (const [candidateKey, assessment] of result) {
            if (!batch.some(candidate => candidate.candidateKey === candidateKey)) {
                throw new Error('REVENUE_GENDER_ROUTING_ASSESSMENT_DRIFT');
            }
            assessments.set(candidateKey, assessment);
        }
    }
    return assessments;
}

async function routePreparedRevenueGenderCandidates(input: RouteRevenueGenderCandidatesInput, population: PreparedRevenueRoutingPopulation): Promise<RevenueGenderRoutingResult> {
    const inputByKey = assertRevenueRoutingCandidates(input);
    const callableCandidateKeys = population.candidates
        .filter(candidate => candidate.imageContentHmac !== null || candidate.fullname !== null)
        .map(candidate => candidate.candidateKey);
    const initial = input.candidates.length <= GENDER_ROUTING_CAPS[input.planId as GenderRoutingPlan].detailed
        ? undefined
        : await assessMicrobatches(input, population, callableCandidateKeys, 1);
    const retryKeys = initial === undefined
        ? []
        : genderRoutingRetryCandidateKeys({
            candidates: population.candidates,
            assessments: initial,
            hmacSecret: input.hmacSecret,
        });
    const retry = retryKeys.length === 0
        ? undefined
        : await assessMicrobatches(input, population, retryKeys, 2);
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

    const current = await input.manifestStore.loadCurrentComplete({
        requestId: input.requestId,
        jobKey: input.jobKey,
        claimToken: input.claimToken,
        jobInputHash: input.jobInputHash,
        relationshipCheckpointId: input.relationshipCheckpointId,
        policyVersion: 'gender-routing-v1',
        planId: input.planId,
    });
    if (current !== null) {
        const cap = GENDER_ROUTING_CAPS[input.planId];
        if (
            current.selected.length !== current.header.selectedCount
            || current.selected.length > cap.detailed
        ) throw new Error('REVENUE_GENDER_ROUTING_SELECTION_DRIFT');
        return Object.freeze({
            header: current.header,
            canonicalInputHmac: current.header.canonicalInputHmac,
            selectedMutualOrdinals: Object.freeze(current.selected.map(row => row.mutualOrdinal)),
        });
    }

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
