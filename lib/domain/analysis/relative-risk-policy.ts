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

export function assignRelativeRiskTiers(
    candidates: readonly RelativeRiskCandidate[]
): RelativeRiskAssignment[] {
    validateCandidates(candidates);
    const eligible = candidates
        .filter(candidate => !candidate.partnerCapApplied)
        .slice()
        .sort((left, right) => (
            right.naturalPublicScore - left.naturalPublicScore
            || left.candidateId.localeCompare(right.candidateId)
        ));

    if (eligible.length < 3) {
        return candidates.map(naturalAssignment);
    }

    const naturalHighCount = eligible
        .filter(candidate => candidate.naturalRiskBand === 'high_risk')
        .length;
    const naturalCautionOrHighCount = eligible
        .filter(candidate => candidate.naturalRiskBand !== 'normal')
        .length;
    const highCount = Math.max(
        1,
        Math.min(eligible.length - 2, naturalHighCount)
    );
    const cautionCount = Math.min(
        eligible.length - highCount,
        Math.max(2, naturalCautionOrHighCount - highCount)
    );
    const assignments = new Map<string, RelativeRiskAssignment>();

    for (const [index, candidate] of eligible.entries()) {
        const riskBand: RiskBand = index < highCount
            ? 'high_risk'
            : index < highCount + cautionCount
                ? 'caution'
                : 'normal';
        assignments.set(candidate.candidateId, {
            candidateId: candidate.candidateId,
            displayScore: calibratedScore(candidate.naturalDisplayScore, riskBand),
            riskBand,
            relativeTierApplied: true,
        });
    }

    return candidates.map(candidate =>
        assignments.get(candidate.candidateId) ?? naturalAssignment(candidate));
}
