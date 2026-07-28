import {
    RISK_DISPLAY_THRESHOLDS,
    isRiskBandCompatibleWithDisplayScore,
    type RiskBand,
} from './risk-policy';

export interface RelativeRiskCandidate {
    candidateId: string;
    naturalPublicScore: number;
    naturalDisplayScore: number;
    naturalRiskBand: RiskBand;
    partnerCapApplied: boolean;
    /** Direct candidate-to-target evidence controls high-tier eligibility. */
    isInbound: boolean;
    /** Official group/brand accounts are retained but outside personal-relative ranking. */
    personalRiskEligible: boolean;
}

export interface RelativeRiskAssignment {
    candidateId: string;
    displayScore: number;
    riskBand: RiskBand;
    relativeTierApplied: boolean;
}

const DISPLAY_BOUNDS = Object.freeze({
    high_risk: [RISK_DISPLAY_THRESHOLDS.high, 10],
    caution: [RISK_DISPLAY_THRESHOLDS.caution, 6.7],
    normal: [1, 4.1],
} satisfies Record<RiskBand, readonly [number, number]>);

function roundToOneDecimal(value: number): number {
    return Math.round((value + Number.EPSILON) * 10) / 10;
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(Math.max(value, minimum), maximum);
}

function validateCandidates(candidates: readonly RelativeRiskCandidate[]): void {
    const ids = new Set<string>();
    for (const candidate of candidates) {
        if (!candidate.candidateId || ids.has(candidate.candidateId)) {
            throw new Error('RELATIVE_RISK_POLICY_ERROR: candidate IDs must be unique.');
        }
        if (
            !Number.isFinite(candidate.naturalPublicScore)
            || candidate.naturalPublicScore < 1
            || candidate.naturalPublicScore > 10
            ||
            !Number.isFinite(candidate.naturalDisplayScore)
            || roundToOneDecimal(candidate.naturalDisplayScore)
                !== candidate.naturalDisplayScore
            || !isRiskBandCompatibleWithDisplayScore(
                candidate.naturalDisplayScore,
                candidate.naturalRiskBand
            )
        ) {
            throw new Error(
                'RELATIVE_RISK_POLICY_ERROR: natural score and band are incompatible.'
            );
        }
        ids.add(candidate.candidateId);
    }
}

function naturalAssignment(candidate: RelativeRiskCandidate): RelativeRiskAssignment {
    return {
        candidateId: candidate.candidateId,
        displayScore: candidate.naturalDisplayScore,
        riskBand: candidate.naturalRiskBand,
        relativeTierApplied: false,
    };
}

function calibratedScore(naturalDisplayScore: number, riskBand: RiskBand): number {
    const [minimum, maximum] = DISPLAY_BOUNDS[riskBand];
    return roundToOneDecimal(clamp(naturalDisplayScore, minimum, maximum));
}

function assignRelativeRiskTiersForVersion(
    candidates: readonly RelativeRiskCandidate[],
    version: 'risk-policy-v2.4' | 'risk-policy-v2.5'
): RelativeRiskAssignment[] {
    validateCandidates(candidates);
    const eligible = candidates
        .filter(candidate => !candidate.partnerCapApplied && candidate.personalRiskEligible)
        .slice()
        .sort((left, right) => (
            right.naturalPublicScore - left.naturalPublicScore
            || left.candidateId.localeCompare(right.candidateId)
        ));

    const excluded = new Map(candidates
        .filter(candidate => !candidate.personalRiskEligible)
        .map(candidate => [candidate.candidateId, {
            candidateId: candidate.candidateId,
            displayScore: calibratedScore(candidate.naturalDisplayScore, 'normal'),
            riskBand: 'normal' as const,
            relativeTierApplied: false,
        }]));

    if (eligible.length < 3) {
        return candidates.map(candidate => excluded.get(candidate.candidateId) ?? naturalAssignment(candidate));
    }

    const naturalHighCount = eligible
        .filter(candidate => candidate.naturalRiskBand === 'high_risk')
        .length;
    const naturalCautionOrHighCount = eligible
        .filter(candidate => candidate.naturalRiskBand !== 'normal')
        .length;
    const naturalRequestedHighCount = Math.max(
        1,
        Math.min(3, eligible.length - 2, naturalHighCount)
    );
    const inboundEligible = eligible.filter(candidate => candidate.isInbound);
    const highPool = inboundEligible.length > 0 ? inboundEligible : eligible;
    const minimumHighCount = version === 'risk-policy-v2.5' && eligible.length >= 4
        ? (
            eligible.length >= 5
            && highPool.length >= 3
            && highPool[2]!.naturalPublicScore >= RISK_DISPLAY_THRESHOLDS.caution
                ? 3
                : 2
        )
        : 1;
    const requestedHighCount = Math.min(
        3,
        eligible.length - 2,
        highPool.length,
        Math.max(naturalRequestedHighCount, minimumHighCount)
    );
    const highCount = Math.min(requestedHighCount, highPool.length);
    const highIds = new Set(highPool.slice(0, highCount).map(candidate => candidate.candidateId));
    const remaining = eligible.filter(candidate => !highIds.has(candidate.candidateId));
    const cautionCount = Math.min(
        10,
        remaining.length,
        Math.max(2, naturalCautionOrHighCount - highCount)
    );
    const assignments = new Map<string, RelativeRiskAssignment>();

    for (const candidate of eligible) {
        const highIndex = highPool.findIndex(row => row.candidateId === candidate.candidateId);
        const cautionIndex = remaining.findIndex(row => row.candidateId === candidate.candidateId);
        const assignedBand: RiskBand = highIndex >= 0 && highIndex < highCount
            ? 'high_risk'
            : cautionIndex >= 0 && cautionIndex < cautionCount ? 'caution' : 'normal';
        assignments.set(candidate.candidateId, {
            candidateId: candidate.candidateId,
            displayScore: calibratedScore(candidate.naturalDisplayScore, assignedBand),
            riskBand: assignedBand,
            relativeTierApplied: true,
        });
    }

    return candidates.map(candidate =>
        assignments.get(candidate.candidateId) ?? excluded.get(candidate.candidateId) ?? naturalAssignment(candidate));
}

/** Exact predecessor semantics for immutable risk-policy-v2.4 requests. */
export function assignRelativeRiskTiers(
    candidates: readonly RelativeRiskCandidate[]
): RelativeRiskAssignment[] {
    return assignRelativeRiskTiersForVersion(candidates, 'risk-policy-v2.4');
}

/** Forward-only v2.5 successor with evidence-aware two/three high-risk floors. */
export function assignRelativeRiskTiersV25(
    candidates: readonly RelativeRiskCandidate[]
): RelativeRiskAssignment[] {
    return assignRelativeRiskTiersForVersion(candidates, 'risk-policy-v2.5');
}
