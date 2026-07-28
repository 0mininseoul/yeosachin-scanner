export interface ReplayGenderQualityGateInput {
    male: number;
    female: number;
    unknown: number;
    /** Public profiles absent from an AI-only artifact are conservatively counted as unknown. */
    missingPublic: number;
}

export interface ReplayGenderQualityGateResult {
    observedUnknownRate: number;
    worstCaseUnknownRate: number;
    observedPass: boolean;
    worstCasePass: boolean;
}

function rate(unknown: number, total: number): number {
    return total === 0 ? 0 : Number((unknown / total).toFixed(4));
}

/** The v2.11 gate intentionally makes partial-public coverage visible rather than optimistic. */
export function evaluateReplayGenderQualityGate(
    input: ReplayGenderQualityGateInput,
): ReplayGenderQualityGateResult {
    const observedTotal = input.male + input.female + input.unknown;
    const observedUnknownRate = rate(input.unknown, observedTotal);
    const worstCaseUnknownRate = rate(
        input.unknown + input.missingPublic,
        observedTotal + input.missingPublic,
    );
    // The displayed rates are rounded for reports only. Gate decisions compare raw integer
    // counts so 1/5 passes exactly and the next representable fraction above 20% fails.
    const observedPass = input.unknown * 5 <= observedTotal;
    const worstTotal = observedTotal + input.missingPublic;
    const worstUnknown = input.unknown + input.missingPublic;
    const worstCasePass = worstUnknown * 5 <= worstTotal;
    return {
        observedUnknownRate,
        worstCaseUnknownRate: rate(worstUnknown, worstTotal),
        observedPass,
        worstCasePass,
    };
}
