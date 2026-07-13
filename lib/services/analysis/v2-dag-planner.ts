import { createHash } from 'node:crypto';
import {
    PLAN_IDS,
    getAnalysisPlan,
    type PlanId,
} from '../../domain/analysis/plan-catalog';
import {
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    analysisV2JobInputHash,
} from './v2-coordinator';
import type { AnalysisV2JobSuccessor } from './v2-job-store';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const JOB_KEY_PATTERN = /^[a-z0-9][a-z0-9:._-]{0,159}$/;
const INPUT_HASH_DOMAIN = 'analysis-v2-dag-job-input-v2';
const MANIFEST_HASH_DOMAIN = 'analysis-v2-dag-manifest-v2';

export const ANALYSIS_V2_PROFILE_BATCH_LIMIT = 30;
export const ANALYSIS_V2_PRIVATE_NAME_BATCH_LIMIT = 100;
export const ANALYSIS_V2_MAX_DETECTED_MUTUALS = 1_200;
export const ANALYSIS_V2_TARGET_INTERACTOR_LIMIT = 690;
export const ANALYSIS_V2_SHORTLIST_LIMIT = 10;
export const ANALYSIS_V2_FEATURED_HIGH_RISK_LIMIT = 3;

export { ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY };
export const ANALYSIS_V2_CANDIDATE_SCREENING_JOB_KEY = 'coordinator:candidate-screening' as const;
export const ANALYSIS_V2_REVERSE_LIKES_JOB_KEY = 'track:reverse-likes:collect' as const;
export const ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY = 'track:partner-safety:batch:0' as const;
export const ANALYSIS_V2_FINAL_SCORE_JOB_KEY = 'coordinator:join:final-score' as const;
export const ANALYSIS_V2_NARRATIVE_JOB_KEY = 'track:narratives:batch:0' as const;
export const ANALYSIS_V2_FINALIZE_JOB_KEY = 'coordinator:finalize' as const;

export interface AnalysisV2DagBatchManifest {
    batch: number;
    itemCount: number;
    inputHash: string;
}

export interface AnalysisV2DagBatchResultManifest {
    batch: number;
    itemCount: number;
    producerInputHash: string;
    revision: number;
    resultHash: string;
}

export interface AnalysisV2DagResultManifest {
    revision: number;
    resultHash: string;
}

export interface AnalysisV2DagRelationshipManifest extends AnalysisV2DagResultManifest {
    detectedMutualCount: number;
    publicCount: number;
    privateCount: number;
    detailedSelectedPublicCount: number;
    notScreenedPublicCount: number;
    profileBatches: readonly AnalysisV2DagBatchManifest[];
    privateNameBatches: readonly AnalysisV2DagBatchManifest[];
}

export interface AnalysisV2DagTargetEvidenceManifest extends AnalysisV2DagResultManifest {
    interactorCount: number;
}

export interface AnalysisV2DagPrimaryJoinResultManifest extends AnalysisV2DagResultManifest {
    verifiedFemaleCount: number;
}

export interface AnalysisV2DagScreeningManifest extends AnalysisV2DagResultManifest {
    verifiedFemaleCount: number;
    shortlistCount: number;
    shortlistHash: string;
}

export interface AnalysisV2DagShortlistResultManifest extends AnalysisV2DagResultManifest {
    shortlistCount: number;
}

export interface AnalysisV2DagFinalScoreManifest extends AnalysisV2DagResultManifest {
    featuredHighRiskCount: number;
    narrativeCount: number;
    narrativeBatchHash: string;
}

export interface AnalysisV2DagNarrativeManifest extends AnalysisV2DagResultManifest {
    narrativeCount: number;
}

/**
 * Append-only checkpoint state. A field may be omitted only until that stage has produced a
 * terminal result. Later-stage placeholders are rejected by dependency validation.
 */
export interface AnalysisV2DagState {
    schemaVersion: 2;
    requestSnapshotHash: string;
    planId: PlanId;
    planSnapshotHash: string;
    girlfriendExclusion: {
        decisionHash: string;
        excludedCount: 0 | 1;
    };
    relationships?: AnalysisV2DagRelationshipManifest;
    targetEvidence?: AnalysisV2DagTargetEvidenceManifest;
    profileFetchBatches?: readonly AnalysisV2DagBatchResultManifest[];
    profileAiBatches?: readonly AnalysisV2DagBatchResultManifest[];
    privateNameBatches?: readonly AnalysisV2DagBatchResultManifest[];
    primaryJoin?: AnalysisV2DagPrimaryJoinResultManifest;
    screening?: AnalysisV2DagScreeningManifest;
    reverseLikes?: AnalysisV2DagShortlistResultManifest;
    partnerSafety?: AnalysisV2DagShortlistResultManifest;
    finalScore?: AnalysisV2DagFinalScoreManifest;
    narrative?: AnalysisV2DagNarrativeManifest;
}

export interface AnalysisV2DagJob extends AnalysisV2JobSuccessor {
    requiredJobKeys: readonly string[];
}

export interface AnalysisV2DagFanoutProposal {
    completedJobKey: string;
    completedInputHash: string;
    successors: readonly AnalysisV2DagJob[];
}

export type AnalysisV2DagReadinessRequirement =
    | 'relationships'
    | 'target_evidence'
    | 'profile_fetch_batches'
    | 'profile_ai_batches'
    | 'primary_join_result'
    | 'screening_result'
    | 'reverse_likes_result'
    | 'partner_safety_result'
    | 'final_score_result'
    | 'narrative_result'
    | 'private_name_batches';

export interface AnalysisV2DagStageReadiness {
    ready: boolean;
    missing: readonly AnalysisV2DagReadinessRequirement[];
}

export interface AnalysisV2DagReadiness {
    relationshipFanout: AnalysisV2DagStageReadiness;
    primaryJoin: AnalysisV2DagStageReadiness;
    finalScore: AnalysisV2DagStageReadiness;
    finalize: AnalysisV2DagStageReadiness;
}

export interface AnalysisV2DagPlan {
    manifestFingerprint: string;
    jobs: readonly AnalysisV2DagJob[];
    proposals: readonly AnalysisV2DagFanoutProposal[];
    readiness: AnalysisV2DagReadiness;
    primaryJoinProposers: readonly string[];
    finalScoreProposers: readonly string[];
    finalizeProposers: readonly string[];
}

interface NormalizedState {
    schemaVersion: 2;
    requestSnapshotHash: string;
    planId: PlanId;
    planSnapshotHash: string;
    girlfriendExclusion: Readonly<{
        decisionHash: string;
        excludedCount: 0 | 1;
    }>;
    relationships: Readonly<AnalysisV2DagRelationshipManifest> | null;
    targetEvidence: Readonly<AnalysisV2DagTargetEvidenceManifest> | null;
    profileFetchBatches: readonly Readonly<AnalysisV2DagBatchResultManifest>[];
    profileAiBatches: readonly Readonly<AnalysisV2DagBatchResultManifest>[];
    privateNameBatches: readonly Readonly<AnalysisV2DagBatchResultManifest>[];
    primaryJoin: Readonly<AnalysisV2DagPrimaryJoinResultManifest> | null;
    screening: Readonly<AnalysisV2DagScreeningManifest> | null;
    reverseLikes: Readonly<AnalysisV2DagShortlistResultManifest> | null;
    partnerSafety: Readonly<AnalysisV2DagShortlistResultManifest> | null;
    finalScore: Readonly<AnalysisV2DagFinalScoreManifest> | null;
    narrative: Readonly<AnalysisV2DagNarrativeManifest> | null;
}

function fail(detail: string): never {
    throw new Error(`ANALYSIS_V2_DAG_PLAN_ERROR: ${detail}.`);
}

function record(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(`invalid ${label}`);
    }
    return value as Record<string, unknown>;
}

function assertKeys(
    value: Record<string, unknown>,
    required: readonly string[],
    optional: readonly string[],
    label: string
): void {
    const allowed = new Set([...required, ...optional]);
    if (
        required.some(key => !Object.prototype.hasOwnProperty.call(value, key))
        || Object.keys(value).some(key => !allowed.has(key))
    ) {
        fail(`invalid ${label} fields`);
    }
}

function hash(value: unknown, label: string): string {
    if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
        fail(`invalid ${label} hash`);
    }
    return value;
}

function integer(value: unknown, label: string, minimum: number, maximum: number): number {
    if (
        typeof value !== 'number'
        || !Number.isSafeInteger(value)
        || value < minimum
        || value > maximum
    ) {
        fail(`invalid ${label}`);
    }
    return value;
}

function normalizePlanId(value: unknown): PlanId {
    if (typeof value !== 'string' || !PLAN_IDS.includes(value as PlanId)) {
        fail('invalid plan id');
    }
    return value as PlanId;
}

function normalizeResultManifest(
    value: unknown,
    label: string
): Readonly<AnalysisV2DagResultManifest> {
    const item = record(value, label);
    assertKeys(item, ['revision', 'resultHash'], [], label);
    return Object.freeze({
        revision: integer(item.revision, `${label} revision`, 1, 1_000_000),
        resultHash: hash(item.resultHash, `${label} result`),
    });
}

function normalizeBatches(
    value: unknown,
    label: string,
    itemLimit: number,
    expectedItems: number
): readonly Readonly<AnalysisV2DagBatchManifest>[] {
    if (!Array.isArray(value)) fail(`invalid ${label}`);
    const expectedBatchCount = Math.ceil(expectedItems / itemLimit);
    if (value.length !== expectedBatchCount) fail(`invalid ${label} batch count`);

    const batches = value.map(entry => {
        const item = record(entry, `${label} batch`);
        assertKeys(item, ['batch', 'itemCount', 'inputHash'], [], `${label} batch`);
        return {
            batch: integer(item.batch, `${label} batch`, 0, 100_000),
            itemCount: integer(item.itemCount, `${label} item count`, 1, itemLimit),
            inputHash: hash(item.inputHash, `${label} input`),
        };
    }).sort((left, right) => left.batch - right.batch);

    batches.forEach((batch, index) => {
        const expectedItemCount = Math.min(itemLimit, expectedItems - index * itemLimit);
        if (batch.batch !== index) fail(`non-contiguous ${label} batches`);
        if (batch.itemCount !== expectedItemCount) fail(`non-canonical ${label} batch size`);
    });

    return Object.freeze(batches.map(batch => Object.freeze(batch)));
}

function normalizeRelationships(
    value: unknown,
    planId: PlanId
): Readonly<AnalysisV2DagRelationshipManifest> {
    const item = record(value, 'relationships manifest');
    assertKeys(item, [
        'revision',
        'resultHash',
        'detectedMutualCount',
        'publicCount',
        'privateCount',
        'detailedSelectedPublicCount',
        'notScreenedPublicCount',
        'profileBatches',
        'privateNameBatches',
    ], [], 'relationships manifest');
    const plan = getAnalysisPlan(planId);
    const maximumDetected = Math.min(
        plan.relationshipCapacity.followers,
        plan.relationshipCapacity.following
    );
    const detectedMutualCount = integer(
        item.detectedMutualCount,
        'detected mutual count',
        0,
        maximumDetected
    );
    const publicCount = integer(item.publicCount, 'public count', 0, detectedMutualCount);
    const privateCount = integer(item.privateCount, 'private count', 0, detectedMutualCount);
    if (publicCount + privateCount !== detectedMutualCount) {
        fail('relationship privacy split mismatch');
    }
    const detailedSelectedPublicCount = integer(
        item.detailedSelectedPublicCount,
        'detailed selected public count',
        0,
        plan.detailedMutualLimit
    );
    const expectedDetailed = Math.min(publicCount, plan.detailedMutualLimit);
    if (detailedSelectedPublicCount !== expectedDetailed) {
        fail('detailed public selection mismatch');
    }
    const notScreenedPublicCount = integer(
        item.notScreenedPublicCount,
        'not screened public count',
        0,
        publicCount
    );
    if (notScreenedPublicCount !== publicCount - detailedSelectedPublicCount) {
        fail('not screened public count mismatch');
    }

    const base = normalizeResultManifest({
        revision: item.revision,
        resultHash: item.resultHash,
    }, 'relationships');
    return Object.freeze({
        ...base,
        detectedMutualCount,
        publicCount,
        privateCount,
        detailedSelectedPublicCount,
        notScreenedPublicCount,
        profileBatches: normalizeBatches(
            item.profileBatches,
            'profile',
            ANALYSIS_V2_PROFILE_BATCH_LIMIT,
            detailedSelectedPublicCount
        ),
        privateNameBatches: normalizeBatches(
            item.privateNameBatches,
            'private name',
            ANALYSIS_V2_PRIVATE_NAME_BATCH_LIMIT,
            privateCount
        ),
    });
}

function normalizeBatchResults(
    value: unknown,
    label: string,
    expectedBatches: readonly Readonly<AnalysisV2DagBatchManifest>[]
): readonly Readonly<AnalysisV2DagBatchResultManifest>[] {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value) || value.length > expectedBatches.length) {
        fail(`invalid ${label}`);
    }
    const results = value.map(entry => {
        const item = record(entry, `${label} batch`);
        assertKeys(
            item,
            ['batch', 'itemCount', 'producerInputHash', 'revision', 'resultHash'],
            [],
            `${label} batch`
        );
        return {
            batch: integer(item.batch, `${label} batch`, 0, 100_000),
            itemCount: integer(item.itemCount, `${label} item count`, 1, 1_200),
            producerInputHash: hash(item.producerInputHash, `${label} producer input`),
            revision: integer(item.revision, `${label} revision`, 1, 1_000_000),
            resultHash: hash(item.resultHash, `${label} result`),
        };
    }).sort((left, right) => left.batch - right.batch);

    if (new Set(results.map(result => result.batch)).size !== results.length) {
        fail(`duplicate ${label} batch`);
    }
    results.forEach(result => {
        const expected = expectedBatches.find(batch => batch.batch === result.batch);
        if (!expected || expected.itemCount !== result.itemCount) {
            fail(`${label} topology mismatch`);
        }
    });
    return Object.freeze(results.map(result => Object.freeze(result)));
}

function normalizeTargetEvidence(value: unknown): Readonly<AnalysisV2DagTargetEvidenceManifest> {
    const item = record(value, 'target evidence manifest');
    assertKeys(item, ['revision', 'resultHash', 'interactorCount'], [], 'target evidence manifest');
    return Object.freeze({
        ...normalizeResultManifest({
            revision: item.revision,
            resultHash: item.resultHash,
        }, 'target evidence'),
        interactorCount: integer(
            item.interactorCount,
            'target interactor count',
            0,
            ANALYSIS_V2_TARGET_INTERACTOR_LIMIT
        ),
    });
}

function normalizePrimaryJoin(
    value: unknown,
    maximumVerifiedFemaleCount: number
): Readonly<AnalysisV2DagPrimaryJoinResultManifest> {
    const item = record(value, 'primary join manifest');
    assertKeys(item, ['revision', 'resultHash', 'verifiedFemaleCount'], [], 'primary join manifest');
    return Object.freeze({
        ...normalizeResultManifest({
            revision: item.revision,
            resultHash: item.resultHash,
        }, 'primary join'),
        verifiedFemaleCount: integer(
            item.verifiedFemaleCount,
            'verified female count',
            0,
            maximumVerifiedFemaleCount
        ),
    });
}

function normalizeScreening(
    value: unknown,
    expectedVerifiedFemaleCount: number
): Readonly<AnalysisV2DagScreeningManifest> {
    const item = record(value, 'screening manifest');
    assertKeys(item, [
        'revision',
        'resultHash',
        'verifiedFemaleCount',
        'shortlistCount',
        'shortlistHash',
    ], [], 'screening manifest');
    const verifiedFemaleCount = integer(
        item.verifiedFemaleCount,
        'verified female count',
        0,
        expectedVerifiedFemaleCount
    );
    if (verifiedFemaleCount !== expectedVerifiedFemaleCount) {
        fail('screening verified female count mismatch');
    }
    const shortlistCount = integer(
        item.shortlistCount,
        'shortlist count',
        0,
        ANALYSIS_V2_SHORTLIST_LIMIT
    );
    if (shortlistCount !== Math.min(verifiedFemaleCount, ANALYSIS_V2_SHORTLIST_LIMIT)) {
        fail('shortlist count mismatch');
    }
    return Object.freeze({
        ...normalizeResultManifest({
            revision: item.revision,
            resultHash: item.resultHash,
        }, 'screening'),
        verifiedFemaleCount,
        shortlistCount,
        shortlistHash: hash(item.shortlistHash, 'shortlist'),
    });
}

function normalizeShortlistResult(
    value: unknown,
    label: string,
    expectedShortlistCount: number
): Readonly<AnalysisV2DagShortlistResultManifest> {
    const item = record(value, `${label} manifest`);
    assertKeys(item, ['revision', 'resultHash', 'shortlistCount'], [], `${label} manifest`);
    const shortlistCount = integer(
        item.shortlistCount,
        `${label} shortlist count`,
        0,
        ANALYSIS_V2_SHORTLIST_LIMIT
    );
    if (shortlistCount !== expectedShortlistCount) fail(`${label} shortlist count mismatch`);
    return Object.freeze({
        ...normalizeResultManifest({
            revision: item.revision,
            resultHash: item.resultHash,
        }, label),
        shortlistCount,
    });
}

function normalizeFinalScore(
    value: unknown,
    verifiedFemaleCount: number
): Readonly<AnalysisV2DagFinalScoreManifest> {
    const item = record(value, 'final score manifest');
    assertKeys(item, [
        'revision',
        'resultHash',
        'featuredHighRiskCount',
        'narrativeCount',
        'narrativeBatchHash',
    ], [], 'final score manifest');
    const featuredHighRiskCount = integer(
        item.featuredHighRiskCount,
        'featured high risk count',
        0,
        Math.min(verifiedFemaleCount, ANALYSIS_V2_FEATURED_HIGH_RISK_LIMIT)
    );
    const narrativeCount = integer(
        item.narrativeCount,
        'narrative count',
        0,
        ANALYSIS_V2_FEATURED_HIGH_RISK_LIMIT
    );
    if (narrativeCount !== featuredHighRiskCount) fail('narrative count mismatch');
    return Object.freeze({
        ...normalizeResultManifest({
            revision: item.revision,
            resultHash: item.resultHash,
        }, 'final score'),
        featuredHighRiskCount,
        narrativeCount,
        narrativeBatchHash: hash(item.narrativeBatchHash, 'narrative batch'),
    });
}

function normalizeNarrative(
    value: unknown,
    expectedNarrativeCount: number
): Readonly<AnalysisV2DagNarrativeManifest> {
    const item = record(value, 'narrative manifest');
    assertKeys(item, ['revision', 'resultHash', 'narrativeCount'], [], 'narrative manifest');
    const narrativeCount = integer(
        item.narrativeCount,
        'narrative count',
        0,
        ANALYSIS_V2_FEATURED_HIGH_RISK_LIMIT
    );
    if (narrativeCount !== expectedNarrativeCount) fail('narrative result count mismatch');
    return Object.freeze({
        ...normalizeResultManifest({
            revision: item.revision,
            resultHash: item.resultHash,
        }, 'narrative'),
        narrativeCount,
    });
}

function allBatchResultsReady(
    topology: readonly Readonly<AnalysisV2DagBatchManifest>[],
    results: readonly Readonly<AnalysisV2DagBatchResultManifest>[]
): boolean {
    return topology.length === results.length
        && topology.every((batch, index) => (
            batch.batch === results[index]?.batch
            && batch.itemCount === results[index]?.itemCount
        ));
}

function stageReadiness(
    missing: readonly AnalysisV2DagReadinessRequirement[]
): AnalysisV2DagStageReadiness {
    return Object.freeze({
        ready: missing.length === 0,
        missing: Object.freeze([...missing]),
    });
}

function readinessFor(state: NormalizedState): AnalysisV2DagReadiness {
    const relationshipFanoutMissing: AnalysisV2DagReadinessRequirement[] = [];
    if (!state.relationships) relationshipFanoutMissing.push('relationships');

    const primaryMissing: AnalysisV2DagReadinessRequirement[] = [];
    if (!state.relationships) primaryMissing.push('relationships');
    if (!state.targetEvidence) primaryMissing.push('target_evidence');
    if (state.relationships && !allBatchResultsReady(
        state.relationships.profileBatches,
        state.profileFetchBatches
    )) primaryMissing.push('profile_fetch_batches');
    if (state.relationships && !allBatchResultsReady(
        state.relationships.profileBatches,
        state.profileAiBatches
    )) primaryMissing.push('profile_ai_batches');

    const finalScoreMissing: AnalysisV2DagReadinessRequirement[] = [];
    if (!state.screening) finalScoreMissing.push('screening_result');
    if (!state.reverseLikes) finalScoreMissing.push('reverse_likes_result');
    if (!state.partnerSafety) finalScoreMissing.push('partner_safety_result');

    const finalizeMissing: AnalysisV2DagReadinessRequirement[] = [];
    if (!state.narrative) finalizeMissing.push('narrative_result');
    if (!state.relationships) {
        finalizeMissing.push('relationships');
    } else if (!allBatchResultsReady(
        state.relationships.privateNameBatches,
        state.privateNameBatches
    )) {
        finalizeMissing.push('private_name_batches');
    }

    return Object.freeze({
        relationshipFanout: stageReadiness(relationshipFanoutMissing),
        primaryJoin: stageReadiness(primaryMissing),
        finalScore: stageReadiness(finalScoreMissing),
        finalize: stageReadiness(finalizeMissing),
    });
}

function normalizeState(input: AnalysisV2DagState): NormalizedState {
    const state = record(input, 'state');
    assertKeys(state, [
        'schemaVersion',
        'requestSnapshotHash',
        'planId',
        'planSnapshotHash',
        'girlfriendExclusion',
    ], [
        'relationships',
        'targetEvidence',
        'profileFetchBatches',
        'profileAiBatches',
        'privateNameBatches',
        'primaryJoin',
        'screening',
        'reverseLikes',
        'partnerSafety',
        'finalScore',
        'narrative',
    ], 'state');
    if (state.schemaVersion !== 2) fail('invalid schema version');
    const planId = normalizePlanId(state.planId);
    const exclusion = record(state.girlfriendExclusion, 'girlfriend exclusion');
    assertKeys(exclusion, ['decisionHash', 'excludedCount'], [], 'girlfriend exclusion');
    const excludedCount = integer(exclusion.excludedCount, 'excluded count', 0, 1) as 0 | 1;
    const relationships = state.relationships === undefined
        ? null
        : normalizeRelationships(state.relationships, planId);
    const expectedProfileBatches = relationships?.profileBatches ?? Object.freeze([]);
    const expectedPrivateBatches = relationships?.privateNameBatches ?? Object.freeze([]);
    const profileFetchBatches = normalizeBatchResults(
        state.profileFetchBatches,
        'profile fetch',
        expectedProfileBatches
    );
    const profileAiBatches = normalizeBatchResults(
        state.profileAiBatches,
        'profile AI',
        expectedProfileBatches
    );
    const privateNameBatches = normalizeBatchResults(
        state.privateNameBatches,
        'private name',
        expectedPrivateBatches
    );
    profileAiBatches.forEach(result => {
        if (!profileFetchBatches.some(fetch => fetch.batch === result.batch)) {
            fail('profile AI result without profile fetch result');
        }
    });

    const targetEvidence = state.targetEvidence === undefined
        ? null
        : normalizeTargetEvidence(state.targetEvidence);
    const preliminary: NormalizedState = {
        schemaVersion: 2,
        requestSnapshotHash: hash(state.requestSnapshotHash, 'request snapshot'),
        planId,
        planSnapshotHash: hash(state.planSnapshotHash, 'plan snapshot'),
        girlfriendExclusion: Object.freeze({
            decisionHash: hash(exclusion.decisionHash, 'girlfriend exclusion decision'),
            excludedCount,
        }),
        relationships,
        targetEvidence,
        profileFetchBatches,
        profileAiBatches,
        privateNameBatches,
        primaryJoin: null,
        screening: null,
        reverseLikes: null,
        partnerSafety: null,
        finalScore: null,
        narrative: null,
    };
    const primaryReady = readinessFor(preliminary).primaryJoin.ready;
    if (state.primaryJoin !== undefined && !primaryReady) {
        fail('primary join result before dependencies are ready');
    }
    const primaryJoin = state.primaryJoin === undefined
        ? null
        : normalizePrimaryJoin(
            state.primaryJoin,
            relationships?.detailedSelectedPublicCount ?? 0
        );
    if (state.screening !== undefined && !primaryJoin) {
        fail('screening result before primary join result');
    }
    const screening = state.screening === undefined
        ? null
        : normalizeScreening(state.screening, primaryJoin?.verifiedFemaleCount ?? 0);
    if ((state.reverseLikes !== undefined || state.partnerSafety !== undefined) && !screening) {
        fail('shortlist result before screening result');
    }
    const reverseLikes = state.reverseLikes === undefined
        ? null
        : normalizeShortlistResult(state.reverseLikes, 'reverse likes', screening?.shortlistCount ?? 0);
    const partnerSafety = state.partnerSafety === undefined
        ? null
        : normalizeShortlistResult(state.partnerSafety, 'partner safety', screening?.shortlistCount ?? 0);
    if (state.finalScore !== undefined && (!reverseLikes || !partnerSafety)) {
        fail('final score result before dependencies are ready');
    }
    const finalScore = state.finalScore === undefined
        ? null
        : normalizeFinalScore(state.finalScore, screening?.verifiedFemaleCount ?? 0);
    if (state.narrative !== undefined && !finalScore) {
        fail('narrative result before final score result');
    }
    const narrative = state.narrative === undefined
        ? null
        : normalizeNarrative(state.narrative, finalScore?.narrativeCount ?? 0);

    return Object.freeze({
        ...preliminary,
        primaryJoin,
        screening,
        reverseLikes,
        partnerSafety,
        finalScore,
        narrative,
    });
}

function sha256(parts: readonly string[]): string {
    return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

function scopedInputHash(requestId: string, jobKey: string, scope: unknown): string {
    return sha256([
        INPUT_HASH_DOMAIN,
        requestId.toLowerCase(),
        jobKey,
        JSON.stringify(scope),
    ]);
}

function sortedDependencies(keys: readonly string[]): readonly string[] {
    const sorted = [...keys].sort();
    if (new Set(sorted).size !== sorted.length || sorted.length > 64) {
        fail('invalid job dependencies');
    }
    return Object.freeze(sorted);
}

function job(input: {
    jobKey: string;
    track: string;
    kind: string;
    batch?: number | null;
    inputHash: string;
    requiredJobKeys?: readonly string[];
}): AnalysisV2DagJob {
    if (!JOB_KEY_PATTERN.test(input.jobKey) || !HASH_PATTERN.test(input.inputHash)) {
        fail('invalid generated job');
    }
    return Object.freeze({
        jobKey: input.jobKey,
        track: input.track,
        kind: input.kind,
        batch: input.batch ?? null,
        inputHash: input.inputHash,
        requiredJobKeys: sortedDependencies(input.requiredJobKeys ?? []),
    });
}

function proposal(
    owner: AnalysisV2DagJob,
    successors: readonly AnalysisV2DagJob[]
): AnalysisV2DagFanoutProposal {
    if (successors.length > 100 || new Set(successors.map(item => item.jobKey)).size !== successors.length) {
        fail('invalid successor fanout');
    }
    return Object.freeze({
        completedJobKey: owner.jobKey,
        completedInputHash: owner.inputHash,
        successors: Object.freeze([...successors]),
    });
}

function profileJobKey(batch: number): string {
    return `track:profiles:batch:${batch}`;
}

function profileAiJobKey(batch: number): string {
    return `track:profile-ai:batch:${batch}`;
}

function privateNameJobKey(batch: number): string {
    return `track:private-names:batch:${batch}`;
}

function baseScope(state: NormalizedState) {
    return {
        schemaVersion: state.schemaVersion,
        requestSnapshotHash: state.requestSnapshotHash,
        planId: state.planId,
        planSnapshotHash: state.planSnapshotHash,
        girlfriendExclusion: state.girlfriendExclusion,
    };
}

function immutableResult(result: AnalysisV2DagResultManifest) {
    return { revision: result.revision, resultHash: result.resultHash };
}

/**
 * Builds only jobs whose inputs are available in the append-only checkpoint state. In particular,
 * an early predecessor never invents a future manifest or proposes a reduced dependency join.
 */
export function buildAnalysisV2DagPlan(
    requestId: string,
    input: AnalysisV2DagState
): AnalysisV2DagPlan {
    if (!UUID_PATTERN.test(requestId)) fail('invalid request id');
    const normalizedRequestId = requestId.toLowerCase();
    const state = normalizeState(input);
    const scope = baseScope(state);

    const bootstrap = job({
        jobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
        track: 'coordinator',
        kind: 'bootstrap',
        inputHash: analysisV2JobInputHash(normalizedRequestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY),
    });
    const relationships = job({
        jobKey: ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
        track: 'relationships',
        kind: 'collection',
        inputHash: scopedInputHash(normalizedRequestId, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY, scope),
    });
    const targetEvidence = job({
        jobKey: ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
        track: 'target_evidence',
        kind: 'collection',
        inputHash: scopedInputHash(normalizedRequestId, ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY, scope),
    });

    const profileJobs = state.relationships?.profileBatches.map(batch => job({
        jobKey: profileJobKey(batch.batch),
        track: 'profiles',
        kind: 'profile_fetch',
        batch: batch.batch,
        inputHash: scopedInputHash(normalizedRequestId, profileJobKey(batch.batch), {
            scope,
            relationships: immutableResult(state.relationships!),
            batch,
        }),
        requiredJobKeys: [relationships.jobKey],
    })) ?? [];
    const profileJobByBatch = new Map(profileJobs.map(item => [item.batch, item]));
    const profileAiJobs = state.profileFetchBatches.map(result => {
        const profile = profileJobByBatch.get(result.batch);
        if (!profile) fail('profile fetch result has no planned job');
        return job({
            jobKey: profileAiJobKey(result.batch),
            track: 'profile_ai',
            kind: 'ai',
            batch: result.batch,
            inputHash: scopedInputHash(normalizedRequestId, profileAiJobKey(result.batch), {
                profileFetchInputHash: profile.inputHash,
                profileFetchResult: immutableResult(result),
                itemCount: result.itemCount,
            }),
            requiredJobKeys: [profile.jobKey],
        });
    });
    const profileAiJobByBatch = new Map(profileAiJobs.map(item => [item.batch, item]));
    const privateNameJobs = state.relationships?.privateNameBatches.map(batch => job({
        jobKey: privateNameJobKey(batch.batch),
        track: 'private_names',
        kind: 'ai',
        batch: batch.batch,
        inputHash: scopedInputHash(normalizedRequestId, privateNameJobKey(batch.batch), {
            scope,
            relationships: immutableResult(state.relationships!),
            batch,
        }),
        requiredJobKeys: [relationships.jobKey],
    })) ?? [];

    const validateBatchProducerHashes = (
        results: readonly Readonly<AnalysisV2DagBatchResultManifest>[],
        producers: ReadonlyMap<number | null, AnalysisV2DagJob>,
        label: string
    ): void => {
        results.forEach(result => {
            const producer = producers.get(result.batch);
            if (!producer || producer.inputHash !== result.producerInputHash) {
                fail(`${label} producer input hash mismatch`);
            }
        });
    };
    validateBatchProducerHashes(
        state.profileFetchBatches,
        profileJobByBatch,
        'profile fetch'
    );
    validateBatchProducerHashes(
        state.profileAiBatches,
        profileAiJobByBatch,
        'profile AI'
    );
    validateBatchProducerHashes(
        state.privateNameBatches,
        new Map(privateNameJobs.map(item => [item.batch, item])),
        'private name'
    );
    const readiness = readinessFor(state);

    let primaryJoin: AnalysisV2DagJob | null = null;
    let primaryJoinProposers: readonly string[] = Object.freeze([]);
    if (readiness.primaryJoin.ready) {
        const relationshipManifest = state.relationships!;
        const profileAiOutputs = relationshipManifest.profileBatches.map(batch => {
            const aiJob = profileAiJobByBatch.get(batch.batch);
            const result = state.profileAiBatches.find(item => item.batch === batch.batch);
            if (!aiJob || !result) fail('primary join profile AI result is incomplete');
            return {
                batch: batch.batch,
                itemCount: batch.itemCount,
                jobInputHash: aiJob.inputHash,
                ...immutableResult(result),
            };
        });
        const dependencies = sortedDependencies([
            relationships.jobKey,
            targetEvidence.jobKey,
            ...profileAiJobs.map(item => item.jobKey),
        ]);
        primaryJoin = job({
            jobKey: ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY,
            track: 'coordinator',
            kind: 'join',
            inputHash: scopedInputHash(normalizedRequestId, ANALYSIS_V2_PRIMARY_JOIN_JOB_KEY, {
                scope,
                relationships: relationshipManifest,
                targetEvidence: state.targetEvidence,
                profileAiOutputs,
                dependencies,
            }),
            requiredJobKeys: dependencies,
        });
        primaryJoinProposers = dependencies;
    }

    let candidateScreening: AnalysisV2DagJob | null = null;
    if (state.primaryJoin) {
        if (!primaryJoin) fail('primary join result has no planned job');
        candidateScreening = job({
            jobKey: ANALYSIS_V2_CANDIDATE_SCREENING_JOB_KEY,
            track: 'coordinator',
            kind: 'screening',
            inputHash: scopedInputHash(normalizedRequestId, ANALYSIS_V2_CANDIDATE_SCREENING_JOB_KEY, {
                primaryJoinInputHash: primaryJoin.inputHash,
                primaryJoinResult: state.primaryJoin,
            }),
            requiredJobKeys: [primaryJoin.jobKey],
        });
    }

    let reverseLikes: AnalysisV2DagJob | null = null;
    let partnerSafety: AnalysisV2DagJob | null = null;
    if (state.screening) {
        if (!candidateScreening) fail('screening result has no planned job');
        const screeningScope = {
            candidateScreeningInputHash: candidateScreening.inputHash,
            screening: state.screening,
        };
        reverseLikes = job({
            jobKey: ANALYSIS_V2_REVERSE_LIKES_JOB_KEY,
            track: 'reverse_likes',
            kind: 'collection',
            inputHash: scopedInputHash(
                normalizedRequestId,
                ANALYSIS_V2_REVERSE_LIKES_JOB_KEY,
                screeningScope
            ),
            requiredJobKeys: [candidateScreening.jobKey],
        });
        partnerSafety = job({
            jobKey: ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY,
            track: 'partner_safety',
            kind: 'ai',
            batch: 0,
            inputHash: scopedInputHash(
                normalizedRequestId,
                ANALYSIS_V2_PARTNER_SAFETY_JOB_KEY,
                screeningScope
            ),
            requiredJobKeys: [candidateScreening.jobKey],
        });
    }

    let finalScore: AnalysisV2DagJob | null = null;
    let finalScoreProposers: readonly string[] = Object.freeze([]);
    if (readiness.finalScore.ready) {
        if (!reverseLikes || !partnerSafety) fail('final score dependencies have no planned jobs');
        const dependencies = sortedDependencies([reverseLikes.jobKey, partnerSafety.jobKey]);
        finalScore = job({
            jobKey: ANALYSIS_V2_FINAL_SCORE_JOB_KEY,
            track: 'coordinator',
            kind: 'join',
            inputHash: scopedInputHash(normalizedRequestId, ANALYSIS_V2_FINAL_SCORE_JOB_KEY, {
                reverseLikesInputHash: reverseLikes.inputHash,
                reverseLikesResult: state.reverseLikes,
                partnerSafetyInputHash: partnerSafety.inputHash,
                partnerSafetyResult: state.partnerSafety,
                dependencies,
            }),
            requiredJobKeys: dependencies,
        });
        finalScoreProposers = dependencies;
    }

    let narrative: AnalysisV2DagJob | null = null;
    if (state.finalScore) {
        if (!finalScore) fail('final score result has no planned job');
        narrative = job({
            jobKey: ANALYSIS_V2_NARRATIVE_JOB_KEY,
            track: 'narratives',
            kind: 'ai',
            batch: 0,
            inputHash: scopedInputHash(normalizedRequestId, ANALYSIS_V2_NARRATIVE_JOB_KEY, {
                finalScoreInputHash: finalScore.inputHash,
                finalScoreResult: state.finalScore,
            }),
            requiredJobKeys: [finalScore.jobKey],
        });
    }

    let finalize: AnalysisV2DagJob | null = null;
    let finalizeProposers: readonly string[] = Object.freeze([]);
    if (readiness.finalize.ready) {
        if (!narrative || !state.narrative) fail('finalize narrative is incomplete');
        const privateOutputs = privateNameJobs.map(privateJob => {
            const result = state.privateNameBatches.find(item => item.batch === privateJob.batch);
            if (!result) fail('finalize private name result is incomplete');
            return {
                batch: result.batch,
                itemCount: result.itemCount,
                jobInputHash: privateJob.inputHash,
                ...immutableResult(result),
            };
        });
        const dependencies = sortedDependencies([
            narrative.jobKey,
            ...privateNameJobs.map(item => item.jobKey),
        ]);
        finalize = job({
            jobKey: ANALYSIS_V2_FINALIZE_JOB_KEY,
            track: 'coordinator',
            kind: 'finalizer',
            inputHash: scopedInputHash(normalizedRequestId, ANALYSIS_V2_FINALIZE_JOB_KEY, {
                narrativeInputHash: narrative.inputHash,
                narrativeResult: state.narrative,
                privateOutputs,
                dependencies,
            }),
            requiredJobKeys: dependencies,
        });
        finalizeProposers = dependencies;
    }

    const jobs = Object.freeze([
        bootstrap,
        relationships,
        targetEvidence,
        ...profileJobs,
        ...profileAiJobs,
        ...privateNameJobs,
        ...(primaryJoin ? [primaryJoin] : []),
        ...(candidateScreening ? [candidateScreening] : []),
        ...(reverseLikes ? [reverseLikes] : []),
        ...(partnerSafety ? [partnerSafety] : []),
        ...(finalScore ? [finalScore] : []),
        ...(narrative ? [narrative] : []),
        ...(finalize ? [finalize] : []),
    ]);
    if (new Set(jobs.map(item => item.jobKey)).size !== jobs.length) fail('duplicate planned job');
    const jobByKey = new Map(jobs.map(item => [item.jobKey, item]));
    const proposalMap = new Map<string, AnalysisV2DagJob[]>();
    const add = (owner: AnalysisV2DagJob, ...successors: AnalysisV2DagJob[]): void => {
        const current = proposalMap.get(owner.jobKey) ?? [];
        proposalMap.set(owner.jobKey, [...current, ...successors]);
    };

    add(bootstrap, relationships, targetEvidence);
    if (state.relationships) add(
        relationships,
        ...profileJobs,
        ...privateNameJobs,
        ...(primaryJoin ? [primaryJoin] : [])
    );
    state.profileFetchBatches.forEach(result => {
        const profile = profileJobByBatch.get(result.batch);
        const ai = profileAiJobByBatch.get(result.batch);
        if (!profile || !ai) fail('profile AI fanout is incomplete');
        add(profile, ai);
    });
    if (state.targetEvidence) add(targetEvidence, ...(primaryJoin ? [primaryJoin] : []));
    state.profileAiBatches.forEach(result => {
        const ai = profileAiJobByBatch.get(result.batch);
        if (!ai) fail('primary join proposer has no profile AI job');
        add(ai, ...(primaryJoin ? [primaryJoin] : []));
    });
    state.privateNameBatches.forEach(result => {
        const owner = jobByKey.get(privateNameJobKey(result.batch));
        if (!owner) fail('finalize proposer has no private name job');
        add(owner, ...(finalize ? [finalize] : []));
    });
    if (primaryJoin && state.primaryJoin && candidateScreening) add(primaryJoin, candidateScreening);
    if (candidateScreening && state.screening && reverseLikes && partnerSafety) {
        add(candidateScreening, reverseLikes, partnerSafety);
    }
    if (reverseLikes && state.reverseLikes) add(reverseLikes, ...(finalScore ? [finalScore] : []));
    if (partnerSafety && state.partnerSafety) add(partnerSafety, ...(finalScore ? [finalScore] : []));
    if (finalScore && state.finalScore && narrative) add(finalScore, narrative);
    if (narrative && state.narrative) add(narrative, ...(finalize ? [finalize] : []));
    if (finalize) add(finalize);

    const proposals = Object.freeze([...proposalMap.entries()].map(([ownerKey, successors]) => {
        const owner = jobByKey.get(ownerKey);
        if (!owner) fail('proposal owner is not planned');
        return proposal(owner, successors);
    }));
    const manifestFingerprint = sha256([
        MANIFEST_HASH_DOMAIN,
        normalizedRequestId,
        JSON.stringify(state),
    ]);

    return Object.freeze({
        manifestFingerprint,
        jobs,
        proposals,
        readiness,
        primaryJoinProposers,
        finalScoreProposers,
        finalizeProposers,
    });
}

export function successorsForAnalysisV2Job(
    plan: AnalysisV2DagPlan,
    completed: Readonly<{ jobKey: string; inputHash: string }>
): readonly AnalysisV2DagJob[] {
    const planned = assertAnalysisV2DagJob(plan, completed);
    const fanout = plan.proposals.find(item => item.completedJobKey === completed.jobKey);
    if (!fanout) fail('completed job successors are not ready');
    if (fanout.completedInputHash !== planned.inputHash) fail('completed job proposal drift');
    return fanout.successors;
}

/** Canonical worker integration guard for a claimed durable job. */
export function assertAnalysisV2DagJob(
    plan: AnalysisV2DagPlan,
    claimed: Readonly<{ jobKey: string; inputHash: string }>
): AnalysisV2DagJob {
    if (!JOB_KEY_PATTERN.test(claimed.jobKey) || !HASH_PATTERN.test(claimed.inputHash)) {
        fail('invalid completed job identity');
    }
    const planned = plan.jobs.find(item => item.jobKey === claimed.jobKey);
    if (!planned) fail('unknown completed job key');
    if (planned.inputHash !== claimed.inputHash) fail('completed job input hash mismatch');
    return planned;
}

/** Strict readiness includes producer-input lineage validation for every available batch result. */
export function getAnalysisV2DagReadiness(
    requestId: string,
    input: AnalysisV2DagState
): AnalysisV2DagReadiness {
    return buildAnalysisV2DagPlan(requestId, input).readiness;
}
