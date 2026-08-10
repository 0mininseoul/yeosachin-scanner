import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

export type FreshProvenancePlan = Extract<PlanId, 'basic' | 'standard'>;

export interface FreshRevenueRun {
    readonly requestId: string;
    readonly preflightId: string;
    readonly userId: string;
    readonly targetUsername: string;
    readonly planId: FreshProvenancePlan;
    readonly accessMode: 'test_entitlement';
    readonly preflightRefreshedAt: string;
    readonly requestCreatedAt: string;
}

export interface FreshProviderProvenance {
    readonly operationKey: string;
    readonly provider: 'apify';
    readonly runId: string;
    readonly datasetId: string | null;
    readonly startedAt: string;
    readonly preflightId: string;
    readonly requestId: string;
    readonly reused: false;
    readonly adopted: false;
    readonly fromCache: false;
}

export class FreshProvenanceError extends Error {
    constructor(readonly code:
        | 'INVALID_INPUT'
        | 'NOT_FRESH'
        | 'LINEAGE_MISMATCH'
        | 'REUSED_ARTIFACT'
    ) {
        super(`FRESH_PROVENANCE_${code}`);
        this.name = 'FreshProvenanceError';
    }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME = /^[a-z0-9._]{1,30}$/;

function date(value: string): number {
    const result = Date.parse(value);
    if (!Number.isFinite(result)) throw new FreshProvenanceError('INVALID_INPUT');
    return result;
}

export function assertFreshRevenueRun(run: FreshRevenueRun): void {
    if (
        !UUID.test(run.requestId)
        || !UUID.test(run.preflightId)
        || !UUID.test(run.userId)
        || !USERNAME.test(run.targetUsername)
        || !['basic', 'standard'].includes(run.planId)
        || run.accessMode !== 'test_entitlement'
        || date(run.requestCreatedAt) < date(run.preflightRefreshedAt)
    ) throw new FreshProvenanceError('INVALID_INPUT');
}

export function assertFreshProviderProvenance(
    run: FreshRevenueRun,
    providerRun: FreshProviderProvenance,
): void {
    assertFreshRevenueRun(run);
    const startedAt = date(providerRun.startedAt);
    if (
        providerRun.provider !== 'apify'
        || !providerRun.runId
        || (providerRun.datasetId !== null && !providerRun.datasetId)
        || providerRun.requestId !== run.requestId
        || providerRun.preflightId !== run.preflightId
        || startedAt < date(run.preflightRefreshedAt)
        || providerRun.reused
        || providerRun.adopted
        || providerRun.fromCache
    ) throw new FreshProvenanceError(
        providerRun.requestId !== run.requestId || providerRun.preflightId !== run.preflightId
            ? 'LINEAGE_MISMATCH'
            : providerRun.reused || providerRun.adopted || providerRun.fromCache
                ? 'REUSED_ARTIFACT'
                : 'NOT_FRESH',
    );
}

export function assertFreshProviderSet(
    run: FreshRevenueRun,
    providerRuns: readonly FreshProviderProvenance[],
): void {
    if (providerRuns.length === 0) throw new FreshProvenanceError('NOT_FRESH');
    const seen = new Set<string>();
    for (const providerRun of providerRuns) {
        if (seen.has(providerRun.operationKey)) throw new FreshProvenanceError('REUSED_ARTIFACT');
        seen.add(providerRun.operationKey);
        assertFreshProviderProvenance(run, providerRun);
    }
}
