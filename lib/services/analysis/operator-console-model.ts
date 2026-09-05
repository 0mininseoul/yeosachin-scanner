export type ConsoleCountPair = {
    key: string;
    declared: number | null;
    collected: number | null;
};

export type FirstDivergence =
    | { key: string; kind: 'divergence'; missing: number }
    | { key: string; kind: 'unknown' };

/** Returns the first stage that cannot prove its declared count was collected. */
export function deriveFirstDivergence(
    stages: readonly ConsoleCountPair[],
): FirstDivergence | null {
    for (const stage of stages) {
        if (stage.declared === null || stage.collected === null) {
            return { key: stage.key, kind: 'unknown' };
        }
        if (stage.collected !== stage.declared) {
            return {
                key: stage.key,
                kind: 'divergence',
                missing: Math.max(0, stage.declared - stage.collected),
            };
        }
    }
    return null;
}

export function displayCreditUsd(input: {
    freshnessState: 'fresh' | 'stale' | 'missing';
    effectiveRemainingUsd: number | null;
}): string {
    if (input.freshnessState !== 'fresh' || input.effectiveRemainingUsd === null) return '미상';
    return `$${input.effectiveRemainingUsd.toFixed(2)}`;
}

export function displayUsd(value: number | null): string {
    return value === null ? '미상' : `$${value.toFixed(value < 1 ? 3 : 2)}`;
}

export function displayCostKnownUsd(value: number | null, status: string): string {
    if (status === 'not_available') return '원장 없음';
    return value === null ? '미확정' : displayUsd(value);
}

export function accountStatus(row: {
    healthState: 'healthy' | 'unhealthy' | 'missing';
    freshnessState: 'fresh' | 'stale' | 'missing';
    effectiveRemainingUsd: number | null;
    manuallyExcluded: boolean;
}): 'healthy' | 'warning' | 'blocked' | 'excluded' {
    if (row.manuallyExcluded) return 'excluded';
    if (row.healthState === 'missing' || row.freshnessState === 'missing') return 'blocked';
    if (row.healthState === 'unhealthy' || row.freshnessState === 'stale') return 'warning';
    if (row.effectiveRemainingUsd === null || row.effectiveRemainingUsd <= 0) return 'blocked';
    return 'healthy';
}
