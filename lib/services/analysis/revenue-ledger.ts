import type { PlanId } from '@/lib/domain/analysis/plan-catalog';

export type RevenuePlan = Extract<PlanId, 'basic' | 'standard'>;
export type RevenueLedgerOperation =
    | 'routing'
    | 'routing_retry'
    | 'profile'
    | 'media'
    | 'interaction'
    | 'resolver';

/** KRW caps from the approved gender-routing cost policy. */
export const REVENUE_COST_CAP_KRW = Object.freeze({ basic: 1_808, standard: 3_634 } as const);
export const REVENUE_MARGIN_TARGET_KRW = Object.freeze({ basic: 904, standard: 1_817 } as const);
export const REVENUE_OPERATION_LIMITS = Object.freeze({
    basic: Object.freeze({ routing: 400, routing_retry: 400, profile: 100, media: 100, interaction: 100, resolver: 20 }),
    standard: Object.freeze({ routing: 800, routing_retry: 800, profile: 200, media: 200, interaction: 200, resolver: 40 }),
} as const);

export interface CostReservation {
    readonly reservationId: string;
    readonly planId: RevenuePlan;
    readonly operation: RevenueLedgerOperation;
    readonly units: number;
    readonly estimatedCostKrw: number;
}

export class RevenueLedgerError extends Error {
    constructor(readonly code:
        | 'INVALID_INPUT'
        | 'BUDGET_EXCEEDED'
        | 'OPERATION_LIMIT_EXCEEDED'
        | 'RESERVATION_CONFLICT'
        | 'COVERAGE_INVARIANT_FAILED'
        | 'UNKNOWN_RATIO_EXCEEDED'
    ) {
        super(`REVENUE_LEDGER_${code}`);
        this.name = 'RevenueLedgerError';
    }
}

function nonNegativeInteger(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0;
}

export function assertCoverageInvariant(input: {
    publicMutualCount: number;
    screenedCount: number;
    notScreenedCount: number;
    unknownBurdenCount: number;
    unavailableReasonCounts?: Partial<Record<'fetch_unavailable' | 'media_unavailable' | 'analysis_unavailable', number>>;
}): { unknownRatio: number; passesUnknownGate: boolean } {
    const values = [input.publicMutualCount, input.screenedCount, input.notScreenedCount, input.unknownBurdenCount];
    if (values.some(value => !nonNegativeInteger(value))
        || input.screenedCount + input.notScreenedCount !== input.publicMutualCount
        || input.unknownBurdenCount > input.screenedCount
        || (input.publicMutualCount > 0 && input.screenedCount === 0)) {
        throw new RevenueLedgerError('COVERAGE_INVARIANT_FAILED');
    }
    for (const value of Object.values(input.unavailableReasonCounts ?? {})) {
        if (!nonNegativeInteger(value) || value > input.unknownBurdenCount) {
            throw new RevenueLedgerError('COVERAGE_INVARIANT_FAILED');
        }
    }
    const passesUnknownGate = input.unknownBurdenCount * 10 <= input.screenedCount * 3;
    return {
        unknownRatio: input.screenedCount === 0 ? 0 : input.unknownBurdenCount / input.screenedCount,
        passesUnknownGate,
    };
}

export class RevenueCostLedger {
    private readonly reservations = new Map<string, CostReservation>();
    private readonly actuals = new Map<string, number>();

    constructor(private readonly planId: RevenuePlan) {}

    get reservedKrw(): number {
        return [...this.reservations.values()].reduce((sum, row) => sum + row.estimatedCostKrw, 0);
    }

    get actualKrw(): number {
        return [...this.actuals.values()].reduce((sum, amount) => sum + amount, 0);
    }

    reserve(input: Omit<CostReservation, 'planId'>): CostReservation {
        if (
            !input.reservationId
            || this.reservations.has(input.reservationId)
            || !nonNegativeInteger(input.units)
            || input.units === 0
            || !Number.isSafeInteger(input.estimatedCostKrw)
            || input.estimatedCostKrw < 0
        ) throw new RevenueLedgerError('INVALID_INPUT');
        const limit = REVENUE_OPERATION_LIMITS[this.planId][input.operation];
        if (input.units > limit) throw new RevenueLedgerError('OPERATION_LIMIT_EXCEEDED');
        if (this.actualKrw + this.reservedKrw + input.estimatedCostKrw > REVENUE_COST_CAP_KRW[this.planId]) {
            throw new RevenueLedgerError('BUDGET_EXCEEDED');
        }
        const reservation = Object.freeze({ ...input, planId: this.planId });
        this.reservations.set(input.reservationId, reservation);
        return reservation;
    }

    settle(reservationId: string, actualCostKrw: number): void {
        const reservation = this.reservations.get(reservationId);
        if (!reservation || !Number.isSafeInteger(actualCostKrw) || actualCostKrw < 0) {
            throw new RevenueLedgerError('RESERVATION_CONFLICT');
        }
        if (actualCostKrw > reservation.estimatedCostKrw) {
            throw new RevenueLedgerError('BUDGET_EXCEEDED');
        }
        this.actuals.set(reservationId, actualCostKrw);
        this.reservations.delete(reservationId);
    }

    release(reservationId: string): void {
        if (!this.reservations.delete(reservationId)) throw new RevenueLedgerError('RESERVATION_CONFLICT');
    }

    assertWithinCap(): { actualKrw: number; marginTargetPassed: boolean; negativeMarginPilot: boolean } {
        if (this.reservedKrw !== 0 || this.actualKrw > REVENUE_COST_CAP_KRW[this.planId]) {
            throw new RevenueLedgerError('BUDGET_EXCEEDED');
        }
        return {
            actualKrw: this.actualKrw,
            marginTargetPassed: this.actualKrw <= REVENUE_MARGIN_TARGET_KRW[this.planId],
            negativeMarginPilot: this.actualKrw > REVENUE_MARGIN_TARGET_KRW[this.planId],
        };
    }
}
