import { createHmac } from 'node:crypto';
import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

/**
 * Revenue E2E's first gender stage is deliberately kept separate from the
 * existing feature-analysis gender resolver.  It is a bounded selector: it
 * decides which public mutuals may incur detailed-analysis cost, but it never
 * becomes a user-facing gender decision.
 */
export const GENDER_ROUTING_POLICY_VERSION = 'gender-routing-v1';

export const GENDER_ROUTING_CAPS = Object.freeze({
    basic: Object.freeze({ detailed: 100, population: 400, femaleQuota: 80, uncertaintyQuota: 20 }),
    standard: Object.freeze({ detailed: 200, population: 800, femaleQuota: 160, uncertaintyQuota: 40 }),
} as const);

const OPAQUE_KEY = /^[A-Za-z0-9._:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;

export type GenderRoutingPlan = Extract<PlanId, 'basic' | 'standard'>;
export type GenderRoutingBucket = 'female_priority' | 'uncertainty' | 'male_deprioritized';
export type GenderRoutingEvidence = 'image_and_name' | 'image_only' | 'name_only' | 'none';

export interface GenderRoutingCandidateInput {
    readonly candidateKey: string;
    readonly profilePicUrl: string | null;
    readonly fullname: string | null;
    /** Computed from fetched bytes. URL text is never persisted in the manifest. */
    readonly imageContentHmac?: string | null;
}

export interface GenderRoutingAssessment {
    readonly femaleScore: number;
    readonly maleScore: number;
    readonly uncertaintyScore: number;
    readonly evidence: GenderRoutingEvidence;
}

export interface GenderRoutingManifestRow {
    readonly candidateKey: string;
    readonly hasImage: boolean;
    readonly hasName: boolean;
    readonly imageContentHmac: string | null;
    readonly fullnameHmac: string | null;
    readonly femaleScore: number | null;
    readonly maleScore: number | null;
    readonly uncertaintyScore: number | null;
    readonly evidence: GenderRoutingEvidence | null;
    readonly bucket: GenderRoutingBucket;
    readonly routingUnavailable: boolean;
    readonly selected: boolean;
    readonly selectionReason: 'population_within_cap' | 'female_quota' | 'uncertainty_quota' | 'fill' | 'not_selected';
    readonly selectionSlot: 'female' | 'uncertainty' | 'fill' | null;
    readonly ordinal: number | null;
}

export interface GenderRoutingManifest {
    readonly policyVersion: typeof GENDER_ROUTING_POLICY_VERSION;
    readonly planId: GenderRoutingPlan;
    readonly populationCount: number;
    readonly selectedCount: number;
    readonly modelAttemptedCount: number;
    readonly modelValidCount: number;
    readonly modelFailedCount: number;
    readonly modelRetriedCount: number;
    readonly canonicalInputHmac: string;
    readonly quotaShortfalls: Readonly<{ female: number; uncertainty: number }>;
    readonly bucketCounts: Readonly<Record<GenderRoutingBucket, number>>;
    readonly selectedBucketCounts: Readonly<Record<GenderRoutingBucket, number>>;
    readonly rows: readonly GenderRoutingManifestRow[];
}

export class GenderRoutingError extends Error {
    constructor(readonly code: 'INVALID_INPUT' | 'POPULATION_OVER_CAP' | 'ROUTING_UNAVAILABLE') {
        super(`GENDER_ROUTING_${code}`);
        this.name = 'GenderRoutingError';
    }
}

function finiteScore(value: number): boolean {
    return Number.isFinite(value) && value >= 0 && value <= 1;
}

function evidenceFor(candidate: Readonly<{ hasImage: boolean; hasName: boolean }>): GenderRoutingEvidence {
    return candidate.hasImage
        ? candidate.hasName ? 'image_and_name' : 'image_only'
        : candidate.hasName ? 'name_only' : 'none';
}

function validAssessment(
    value: GenderRoutingAssessment,
    candidate: Readonly<{ hasImage: boolean; hasName: boolean }>,
): boolean {
    const scoreTotal = value.femaleScore + value.maleScore + value.uncertaintyScore;
    const expectedEvidence = evidenceFor(candidate);
    return finiteScore(value.femaleScore)
        && finiteScore(value.maleScore)
        && finiteScore(value.uncertaintyScore)
        && scoreTotal >= 0.99
        && scoreTotal <= 1.01
        && value.evidence === expectedEvidence;
}

function normalizedAssessment(value: GenderRoutingAssessment): GenderRoutingAssessment {
    const total = value.femaleScore + value.maleScore + value.uncertaintyScore;
    return {
        femaleScore: value.femaleScore / total,
        maleScore: value.maleScore / total,
        uncertaintyScore: value.uncertaintyScore / total,
        evidence: value.evidence,
    };
}

function hmac(secret: string, value: string): string {
    return createHmac('sha256', secret).update(value, 'utf8').digest('hex');
}

function normalizeCandidate(candidate: GenderRoutingCandidateInput, secret: string) {
    if (
        !OPAQUE_KEY.test(candidate.candidateKey)
        || (candidate.profilePicUrl !== null && (
            typeof candidate.profilePicUrl !== 'string' || candidate.profilePicUrl.length > 8_192
        ))
        || (candidate.fullname !== null && (
            typeof candidate.fullname !== 'string' || candidate.fullname.length > 200
        ))
        || (candidate.imageContentHmac !== undefined
            && candidate.imageContentHmac !== null
            && !HASH.test(candidate.imageContentHmac))
    ) throw new GenderRoutingError('INVALID_INPUT');
    return {
        candidateKey: candidate.candidateKey,
        hasImage: candidate.profilePicUrl !== null,
        hasName: candidate.fullname !== null && candidate.fullname.trim().length > 0,
        imageContentHmac: candidate.imageContentHmac ?? null,
        fullnameHmac: candidate.fullname === null || candidate.fullname.trim().length === 0
            ? null
            : hmac(secret, `gender-routing:fullname:v1\n${candidate.fullname}`),
    };
}

/**
 * Stable binding between the fresh relationship snapshot and a durable routing
 * manifest. This intentionally hashes only locally held inputs and never
 * serializes them into the manifest payload.
 */
export function createGenderRoutingCanonicalInputHmac(input: {
    readonly candidates: readonly GenderRoutingCandidateInput[];
    readonly hmacSecret: string;
}): string {
    const normalized = input.candidates.map(candidate => normalizeCandidate(candidate, input.hmacSecret));
    return hmac(input.hmacSecret, [
        'gender-routing:canonical-input:v1',
        ...[...normalized]
            .sort((left, right) => left.candidateKey.localeCompare(right.candidateKey))
            .map(candidate => [
                candidate.candidateKey,
                candidate.hasImage ? 'image' : 'no_image',
                candidate.hasName ? 'name' : 'no_name',
                candidate.fullnameHmac ?? '',
                candidate.imageContentHmac ?? '',
            ].join('|')),
    ].join('\n'));
}

/**
 * Returns exactly the candidate set permitted one model retry. The runtime uses this before it
 * starts the retry so a valid first response is never charged a second time.
 */
export function genderRoutingRetryCandidateKeys(input: {
    candidates: readonly GenderRoutingCandidateInput[];
    assessments?: ReadonlyMap<string, GenderRoutingAssessment>;
    hmacSecret: string;
}): readonly string[] {
    const normalized = input.candidates.map(candidate => normalizeCandidate(candidate, input.hmacSecret));
    const callable = normalized.filter(candidate => candidate.hasImage || candidate.hasName);
    const failed = callable.filter(candidate => {
        const assessment = input.assessments?.get(candidate.candidateKey);
        return !assessment || !validAssessment(assessment, candidate);
    });
    return Object.freeze(failed.map(candidate => candidate.candidateKey));
}

function bucketFor(assessment: GenderRoutingAssessment): GenderRoutingBucket {
    if (
        assessment.uncertaintyScore >= 0.4
        || Math.abs(assessment.femaleScore - assessment.maleScore) < 0.15
    ) return 'uncertainty';
    if (assessment.femaleScore > assessment.maleScore) return 'female_priority';
    return 'male_deprioritized';
}

function tieBreak(secret: string, requestId: string, checkpointId: string, candidateKey: string): string {
    return hmac(secret, `gender-routing:tie:v1\n${requestId}\n${checkpointId}\n${candidateKey}\n${GENDER_ROUTING_POLICY_VERSION}`);
}

function sorted<T extends {
    candidateKey: string;
    bucket: GenderRoutingBucket;
    assessment: GenderRoutingAssessment;
}>(
    rows: readonly T[],
    secret: string,
    requestId: string,
    checkpointId: string,
): T[] {
    return [...rows].sort((left, right) => {
        const score = left.bucket === 'female_priority'
            ? right.assessment.femaleScore - left.assessment.femaleScore
            : left.bucket === 'uncertainty'
                ? right.assessment.uncertaintyScore - left.assessment.uncertaintyScore
                : right.assessment.femaleScore - left.assessment.femaleScore;
        if (score !== 0) return score;
        const secondary = left.bucket === 'female_priority'
            ? left.assessment.uncertaintyScore - right.assessment.uncertaintyScore
            : left.bucket === 'uncertainty'
                ? right.assessment.femaleScore - left.assessment.femaleScore
                : right.assessment.uncertaintyScore - left.assessment.uncertaintyScore;
        if (secondary !== 0) return secondary;
        return tieBreak(secret, requestId, checkpointId, left.candidateKey)
            .localeCompare(tieBreak(secret, requestId, checkpointId, right.candidateKey));
    });
}

/**
 * Build an immutable routing manifest. Callers must pass assessments only for
 * candidates with an image or a name; missing assessments are represented as
 * unavailable and never trigger a profile-fetch fallback.
 */
export function buildGenderRoutingManifest(input: {
    planId: GenderRoutingPlan;
    requestId: string;
    relationshipCheckpointId: string;
    candidates: readonly GenderRoutingCandidateInput[];
    assessments?: ReadonlyMap<string, GenderRoutingAssessment>;
    retryAssessments?: ReadonlyMap<string, GenderRoutingAssessment>;
    hmacSecret: string;
}): GenderRoutingManifest {
    const cap = GENDER_ROUTING_CAPS[input.planId];
    if (!input.hmacSecret || input.hmacSecret.length < 32 || !input.requestId || !input.relationshipCheckpointId) {
        throw new GenderRoutingError('INVALID_INPUT');
    }
    const normalized = input.candidates.map(candidate => normalizeCandidate(candidate, input.hmacSecret));
    const unique = new Set(normalized.map(row => row.candidateKey));
    if (unique.size !== normalized.length || normalized.length > cap.population) {
        throw new GenderRoutingError('POPULATION_OVER_CAP');
    }
    const ordered = [...normalized].sort((a, b) => tieBreak(input.hmacSecret, input.requestId, input.relationshipCheckpointId, a.candidateKey)
        .localeCompare(tieBreak(input.hmacSecret, input.requestId, input.relationshipCheckpointId, b.candidateKey)));
    const canonicalInputHmac = createGenderRoutingCanonicalInputHmac({
        candidates: input.candidates,
        hmacSecret: input.hmacSecret,
    });
    if (normalized.length <= cap.detailed) {
        const rows = ordered.map((candidate, index): GenderRoutingManifestRow => ({
            ...candidate,
            femaleScore: null,
            maleScore: null,
            uncertaintyScore: null,
            evidence: null,
            bucket: 'female_priority',
            routingUnavailable: false,
            selected: true,
            selectionReason: 'population_within_cap',
            selectionSlot: 'fill',
            ordinal: index + 1,
        }));
        return Object.freeze({
            policyVersion: GENDER_ROUTING_POLICY_VERSION,
            planId: input.planId,
            populationCount: normalized.length,
            selectedCount: normalized.length,
            modelAttemptedCount: 0,
            modelValidCount: 0,
            modelFailedCount: 0,
            modelRetriedCount: 0,
            canonicalInputHmac,
            quotaShortfalls: { female: 0, uncertainty: 0 },
            bucketCounts: { female_priority: normalized.length, uncertainty: 0, male_deprioritized: 0 },
            selectedBucketCounts: { female_priority: normalized.length, uncertainty: 0, male_deprioritized: 0 },
            rows,
        });
    }

    const assessed: { candidateKey: string; bucket: GenderRoutingBucket; assessment: GenderRoutingAssessment; routingUnavailable: boolean }[] = [];
    let attempted = 0;
    let valid = 0;
    let retried = 0;
    const invalidCandidates = new Set<string>();
    for (const candidate of normalized) {
        const assessment = candidate.hasImage || candidate.hasName
            ? input.assessments?.get(candidate.candidateKey)
            : undefined;
        if (candidate.hasImage || candidate.hasName) attempted += 1;
        if (!assessment || !validAssessment(assessment, candidate)) {
            if (candidate.hasImage || candidate.hasName) invalidCandidates.add(candidate.candidateKey);
            assessed.push({
                candidateKey: candidate.candidateKey,
                bucket: 'uncertainty',
                assessment: {
                    femaleScore: 0,
                    maleScore: 0,
                    uncertaintyScore: 1,
                    evidence: evidenceFor(candidate),
                },
                routingUnavailable: true,
            });
            continue;
        }
        valid += 1;
        const normalizedScores = normalizedAssessment(assessment);
        assessed.push({
            candidateKey: candidate.candidateKey,
            bucket: bucketFor(normalizedScores),
            assessment: normalizedScores,
            routingUnavailable: false,
        });
    }
    if (attempted > 0 && invalidCandidates.size > 0) {
        const retryKeys = [...invalidCandidates];
        for (const candidateKey of retryKeys) {
            const candidate = normalized.find(row => row.candidateKey === candidateKey)!;
            const retry = input.retryAssessments?.get(candidateKey);
            retried += 1;
            if (!retry || !validAssessment(retry, candidate)) continue;
            const assessment = normalizedAssessment(retry);
            const index = assessed.findIndex(row => row.candidateKey === candidateKey);
            assessed[index] = {
                candidateKey,
                bucket: bucketFor(assessment),
                assessment,
                routingUnavailable: false,
            };
            valid += 1;
        }
    }
    // The policy gate measures the unresolved candidate burden, not unsuccessful model calls.
    // A recovered first attempt must not remain failed and a retry never dilutes the denominator.
    const finalFailed = assessed.filter(row => {
        const candidate = normalized.find(item => item.candidateKey === row.candidateKey)!;
        return row.routingUnavailable && (candidate.hasImage || candidate.hasName);
    }).length;
    if (attempted === 0 || valid === 0 || finalFailed / attempted > 0.1) {
        throw new GenderRoutingError('ROUTING_UNAVAILABLE');
    }
    const byKey = new Map(assessed.map(row => [row.candidateKey, row]));
    const pools = {
        female_priority: sorted(assessed.filter(row => row.bucket === 'female_priority'), input.hmacSecret, input.requestId, input.relationshipCheckpointId),
        uncertainty: sorted(assessed.filter(row => row.bucket === 'uncertainty'), input.hmacSecret, input.requestId, input.relationshipCheckpointId),
        male_deprioritized: sorted(assessed.filter(row => row.bucket === 'male_deprioritized'), input.hmacSecret, input.requestId, input.relationshipCheckpointId),
    } as const;
    const selected = new Map<string, 'female' | 'uncertainty' | 'fill'>();
    const take = (pool: readonly typeof assessed[number][], count: number, slot: 'female' | 'uncertainty' | 'fill') => {
        for (const row of pool) {
            if (selected.size >= cap.detailed || count <= 0) break;
            if (selected.has(row.candidateKey)) continue;
            selected.set(row.candidateKey, slot);
            count -= 1;
        }
    };
    take(pools.female_priority, cap.femaleQuota, 'female');
    take(pools.uncertainty, cap.uncertaintyQuota, 'uncertainty');
    take(pools.female_priority, cap.detailed, 'fill');
    take(pools.uncertainty, cap.detailed, 'fill');
    take(pools.male_deprioritized, cap.detailed, 'fill');
    const rows = ordered.map(candidate => {
        const selectedSlot = selected.get(candidate.candidateKey) ?? null;
        const scored = byKey.get(candidate.candidateKey)!;
        return {
            ...candidate,
            femaleScore: scored.assessment.femaleScore,
            maleScore: scored.assessment.maleScore,
            uncertaintyScore: scored.assessment.uncertaintyScore,
            evidence: scored.assessment.evidence,
            bucket: scored.bucket,
            routingUnavailable: scored.routingUnavailable,
            selected: selectedSlot !== null,
            selectionReason: selectedSlot === 'female'
                ? 'female_quota'
                : selectedSlot === 'uncertainty'
                    ? 'uncertainty_quota'
                    : selectedSlot === 'fill'
                        ? 'fill'
                        : 'not_selected',
            selectionSlot: selectedSlot,
            ordinal: selectedSlot === null ? null : [...selected.keys()].indexOf(candidate.candidateKey) + 1,
        } satisfies GenderRoutingManifestRow;
    });
    const counts = (predicate: (row: GenderRoutingManifestRow) => boolean) => ({
        female_priority: rows.filter(row => row.bucket === 'female_priority' && predicate(row)).length,
        uncertainty: rows.filter(row => row.bucket === 'uncertainty' && predicate(row)).length,
        male_deprioritized: rows.filter(row => row.bucket === 'male_deprioritized' && predicate(row)).length,
    });
    return Object.freeze({
        policyVersion: GENDER_ROUTING_POLICY_VERSION,
        planId: input.planId,
        populationCount: normalized.length,
        selectedCount: selected.size,
        modelAttemptedCount: attempted,
        modelValidCount: valid,
        modelFailedCount: finalFailed,
        modelRetriedCount: retried,
        canonicalInputHmac,
        quotaShortfalls: {
            female: Math.max(0, cap.femaleQuota - pools.female_priority.length),
            uncertainty: Math.max(0, cap.uncertaintyQuota - pools.uncertainty.length),
        },
        bucketCounts: counts(() => true),
        selectedBucketCounts: counts(row => row.selected),
        rows,
    });
}
