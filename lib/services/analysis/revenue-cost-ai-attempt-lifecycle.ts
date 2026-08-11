import 'server-only';

import type {
    RevenueCostLiveSource,
    RevenueCostOperationOutcome,
    SettleRevenueCostOperationV2,
} from './revenue-cost-operation-store';

/**
 * The runner supplies this from its already-authoritative entitlement decision.  This adapter is
 * deliberately a gate, not another eligibility authority: only the test entitlement Basic and
 * Standard paths may issue revenue-cost RPCs.
 */
export interface RevenueCostAiAttemptExecutionScope {
    readonly accessMode: 'production' | 'test_entitlement';
    readonly planId: 'basic' | 'standard' | 'plus';
}

export interface RevenueCostAiAttemptOperationStore {
    reserveV2(input: RevenueCostLiveSource): Promise<RevenueCostOperationOutcome>;
    markStartedV2(input: RevenueCostLiveSource): Promise<RevenueCostOperationOutcome>;
    settleV2(input: SettleRevenueCostOperationV2): Promise<RevenueCostOperationOutcome>;
    releaseV2(input: RevenueCostLiveSource): Promise<RevenueCostOperationOutcome>;
}

export class RevenueCostAiAttemptCostDeniedError extends Error {
    constructor() {
        super('ANALYSIS_V2_REVENUE_COST_DENIED');
        this.name = 'RevenueCostAiAttemptCostDeniedError';
    }
}

export class RevenueCostAiAttemptLifecycleError extends Error {
    constructor() {
        super('ANALYSIS_V2_REVENUE_COST_LIFECYCLE_ERROR');
        this.name = 'RevenueCostAiAttemptLifecycleError';
    }
}

function eligible(scope: RevenueCostAiAttemptExecutionScope): boolean {
    return scope.accessMode === 'test_entitlement'
        && (scope.planId === 'basic' || scope.planId === 'standard');
}

function assertAiAttemptSource(source: RevenueCostLiveSource): void {
    // The generic operation store also serves provider-run accounting.  This
    // adapter must never become a second way to enter that path, even if a
    // caller bypasses TypeScript with deserialized runtime data.
    if (source.sourceKind !== 'ai_attempt'
        || !Number.isSafeInteger(source.sourceAttempt)
        || source.sourceAttempt < 1
        || source.sourceAttempt > 4) {
        throw new RevenueCostAiAttemptLifecycleError();
    }
}

function settlementSource(source: RevenueCostLiveSource): SettleRevenueCostOperationV2 {
    return {
        requestId: source.requestId,
        jobKey: source.jobKey,
        sourceKind: source.sourceKind,
        sourceOperationKey: source.sourceOperationKey,
        sourceAttempt: source.sourceAttempt,
    };
}

function isAccepted(outcome: RevenueCostOperationOutcome): boolean {
    return outcome.disposition === 'accepted';
}

function isStarted(outcome: RevenueCostOperationOutcome): boolean {
    return outcome.disposition === 'started';
}

export interface RevenueCostAiAttemptLifecycle {
    runMarked<T>(input: {
        readonly scope: RevenueCostAiAttemptExecutionScope;
        readonly source: RevenueCostLiveSource;
        readonly runExternal: () => Promise<T>;
    }): Promise<T>;
    settleAfterTerminal(input: {
        readonly scope: RevenueCostAiAttemptExecutionScope;
        readonly source: RevenueCostLiveSource;
    }): Promise<RevenueCostOperationOutcome | null>;
    releaseOrAmbiguousBeforeDispatch(input: {
        readonly scope: RevenueCostAiAttemptExecutionScope;
        readonly source: RevenueCostLiveSource;
    }): Promise<RevenueCostOperationOutcome | null>;
}

/**
 * Coordinates the durable ledger with one Gemini attempt.  Callers must place runMarked around
 * the external provider boundary; this module never receives usage, prices, or a provider result,
 * so the database remains the sole economic authority.
 */
export function createRevenueCostAiAttemptLifecycle(
    operations: RevenueCostAiAttemptOperationStore,
): RevenueCostAiAttemptLifecycle {
    return {
        async runMarked({ scope, source, runExternal }) {
            assertAiAttemptSource(source);
            if (!eligible(scope)) return runExternal();

            const reserved = await operations.reserveV2(source);
            if (reserved.disposition === 'denied') {
                throw new RevenueCostAiAttemptCostDeniedError();
            }
            if (!isAccepted(reserved)) {
                throw new RevenueCostAiAttemptLifecycleError();
            }

            try {
                const started = await operations.markStartedV2(source);
                if (!isStarted(started)) {
                    throw new RevenueCostAiAttemptLifecycleError();
                }
            } catch (error) {
                // No external call has happened yet.  Try to release the exact reservation before
                // surfacing the persistence failure; a failed release is still fail-closed because
                // this method never crosses the provider boundary.
                try {
                    await operations.releaseV2(source);
                } catch {
                    // The original start failure carries the actionable boundary fence.
                }
                throw error;
            }

            return runExternal();
        },

        async settleAfterTerminal({ scope, source }) {
            assertAiAttemptSource(source);
            if (!eligible(scope)) return null;
            return operations.settleV2(settlementSource(source));
        },

        async releaseOrAmbiguousBeforeDispatch({ scope, source }) {
            assertAiAttemptSource(source);
            if (!eligible(scope)) return null;
            return operations.releaseV2(source);
        },
    };
}
