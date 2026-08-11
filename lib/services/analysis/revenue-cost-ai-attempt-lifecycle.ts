import 'server-only';

import type {
    GeminiAttemptStartTelemetry,
    GeminiAttemptTelemetry,
} from '@/lib/services/ai/gemini';
import type {
    RevenueCostLiveSource,
    RevenueCostOperationOutcome,
    SettleRevenueCostOperationV2,
} from './revenue-cost-operation-store';

/**
 * The runner supplies this from its already-authoritative entitlement decision. This adapter is
 * deliberately a gate, not another eligibility authority: only the test entitlement Basic and
 * Standard paths may issue revenue-cost RPCs.
 */
export interface RevenueCostAiAttemptExecutionScope {
    readonly accessMode: 'production' | 'test_entitlement';
    readonly planId: 'basic' | 'standard' | 'plus';
}

/**
 * The later trusted-assessor wiring obtains these values from the durable job and audit context.
 * It deliberately does not ask each Gemini callback to recreate a mutable RevenueCostLiveSource:
 * source_kind and source_attempt are fixed here from the callback's exact attempt identity.
 */
export interface RevenueCostAiAttemptLiveFence {
    readonly requestId: string;
    readonly jobKey: string;
    readonly jobClaimToken: string;
    readonly jobInputHash: string;
    readonly operationKey: string;
}

export interface RevenueCostAiAttemptOperationStore {
    reserveV2(input: RevenueCostLiveSource): Promise<RevenueCostOperationOutcome>;
    markStartedV2(input: RevenueCostLiveSource): Promise<RevenueCostOperationOutcome>;
    settleV2(input: SettleRevenueCostOperationV2): Promise<RevenueCostOperationOutcome>;
    releaseV2(input: RevenueCostLiveSource): Promise<RevenueCostOperationOutcome>;
    manualReview(input: {
        requestId: string;
        reasonCode: 'ambiguous_external_call';
    }): Promise<RevenueCostOperationOutcome>;
}

export class RevenueCostAiAttemptCostDeniedError extends Error {
    constructor() {
        super('ANALYSIS_V2_REVENUE_COST_DENIED');
        this.name = 'RevenueCostAiAttemptCostDeniedError';
    }
}

export class RevenueCostAiAttemptLifecycleError extends Error {
    constructor(message = 'ANALYSIS_V2_REVENUE_COST_LIFECYCLE_ERROR') {
        super(message);
        this.name = 'RevenueCostAiAttemptLifecycleError';
    }
}

function eligible(scope: RevenueCostAiAttemptExecutionScope): boolean {
    return scope.accessMode === 'test_entitlement'
        && (scope.planId === 'basic' || scope.planId === 'standard');
}

function assertAiAttemptSource(source: RevenueCostLiveSource): void {
    // The generic operation store also serves provider-run accounting. This adapter must never
    // become a second way to enter that path, even if a caller bypasses TypeScript at runtime.
    if (source.sourceKind !== 'ai_attempt'
        || !Number.isSafeInteger(source.sourceAttempt)
        || source.sourceAttempt < 1
        || source.sourceAttempt > 4) {
        throw new RevenueCostAiAttemptLifecycleError();
    }
}

function assertAttemptIdentity(attempt: number, retryCount: number): void {
    if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 4
        || !Number.isSafeInteger(retryCount) || retryCount !== attempt - 1) {
        throw new RevenueCostAiAttemptLifecycleError();
    }
}

function sourceForAttempt(
    fence: RevenueCostAiAttemptLiveFence,
    attempt: number,
    retryCount: number,
): RevenueCostLiveSource {
    assertAttemptIdentity(attempt, retryCount);
    const source: RevenueCostLiveSource = {
        requestId: fence.requestId,
        jobKey: fence.jobKey,
        jobClaimToken: fence.jobClaimToken,
        jobInputHash: fence.jobInputHash,
        sourceKind: 'ai_attempt',
        sourceOperationKey: fence.operationKey,
        sourceAttempt: attempt,
    };
    assertAiAttemptSource(source);
    return source;
}

function sourceForStartTelemetry(
    fence: RevenueCostAiAttemptLiveFence,
    telemetry: GeminiAttemptStartTelemetry,
): RevenueCostLiveSource {
    if (typeof telemetry.requestId !== 'string' || typeof fence.requestId !== 'string'
        || telemetry.requestId.toLowerCase() !== fence.requestId.toLowerCase()) {
        throw new RevenueCostAiAttemptLifecycleError();
    }
    return sourceForAttempt(fence, telemetry.attempt, telemetry.retryCount);
}

function sourceForTerminalTelemetry(
    fence: RevenueCostAiAttemptLiveFence,
    telemetry: GeminiAttemptTelemetry,
): RevenueCostLiveSource {
    return sourceForAttempt(fence, telemetry.attempt, telemetry.retryCount);
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

export interface RevenueCostAiAttemptCallbacks {
    /** Directly assignable to Analysis V2 Gemini's onBeforeAttempt callback. */
    onBeforeAttempt(telemetry: GeminiAttemptStartTelemetry): Promise<void>;
    /** Directly assignable to Analysis V2 Gemini's terminal onAttemptTelemetry callback. */
    onAttemptTelemetry(telemetry: GeminiAttemptTelemetry, parsedResult?: unknown): Promise<void>;
    /** For a proven local pre-dispatch abort before the Gemini SDK boundary. */
    releaseBeforeDispatch(
        telemetry: GeminiAttemptStartTelemetry,
    ): Promise<RevenueCostOperationOutcome | null>;
    /**
     * A post-boundary audit or settlement persistence failure cannot be
     * retried safely. The composer invokes this without inventing telemetry.
     */
    manualReviewAfterExternalBoundary(): Promise<RevenueCostOperationOutcome | null>;
}

export interface RevenueCostAiAttemptLifecycle {
    /**
     * Binds a durable job fence once and returns the exact callback shape the existing Gemini
     * runtime accepts. Runtime wiring remains deliberately separate from this lifecycle module.
     */
    bind(input: {
        readonly scope: RevenueCostAiAttemptExecutionScope;
        readonly fence: RevenueCostAiAttemptLiveFence;
    }): RevenueCostAiAttemptCallbacks;
}

async function reserveWithExactIdentityRetry(
    operations: RevenueCostAiAttemptOperationStore,
    source: RevenueCostLiveSource,
): Promise<void> {
    // A response can be lost after PostgreSQL commits. Repeating the exact immutable source is
    // safe because reserveV2 is idempotent; changing any part of the source would create drift.
    for (let reserveAttempt = 0; reserveAttempt < 2; reserveAttempt += 1) {
        try {
            const reserved = await operations.reserveV2(source);
            if (reserved.disposition === 'denied') {
                throw new RevenueCostAiAttemptCostDeniedError();
            }
            if (isAccepted(reserved)) return;
        } catch (error) {
            if (error instanceof RevenueCostAiAttemptCostDeniedError) throw error;
        }
    }

    // Do not release after an ambiguous reserve response: the exact first call may have committed
    // and therefore represents potentially billable state. Manual review and rejection of the
    // before-attempt callback are the only safe outcome before Gemini is permitted to run.
    try {
        await operations.manualReview({
            requestId: source.requestId,
            reasonCode: 'ambiguous_external_call',
        });
    } catch {
        // A manual-review transport failure does not make the external boundary safe.
    }
    throw new RevenueCostAiAttemptLifecycleError(
        'ANALYSIS_V2_REVENUE_COST_RESERVE_AMBIGUOUS',
    );
}

/**
 * Coordinates the durable ledger with one Gemini attempt. The callback binding ensures the
 * existing V2 onBeforeAttempt/onAttemptTelemetry lifecycle owns the provider boundary without a
 * runExternal closure, while SQL remains the sole economic authority.
 */
export function createRevenueCostAiAttemptLifecycle(
    operations: RevenueCostAiAttemptOperationStore,
): RevenueCostAiAttemptLifecycle {
    return {
        bind({ scope, fence }) {
            return {
                async onBeforeAttempt(telemetry) {
                    const source = sourceForStartTelemetry(fence, telemetry);
                    if (!eligible(scope)) return;

                    await reserveWithExactIdentityRetry(operations, source);
                    try {
                        const started = await operations.markStartedV2(source);
                        if (!isStarted(started)) {
                            throw new RevenueCostAiAttemptLifecycleError();
                        }
                    } catch (error) {
                        // No Gemini call has happened yet. The exact release RPC can prove a
                        // no-call outcome or preserve ambiguity if a start response was lost.
                        try {
                            await operations.releaseV2(source);
                        } catch {
                            // The original start failure carries the boundary fence.
                        }
                        throw error;
                    }
                },

                async onAttemptTelemetry(telemetry) {
                    const source = sourceForTerminalTelemetry(fence, telemetry);
                    if (!eligible(scope)) return;
                    try {
                        const settled = await operations.settleV2(settlementSource(source));
                        if (settled.disposition === 'ambiguous' || settled.disposition === 'manual_review') {
                            throw new RevenueCostAiAttemptLifecycleError(
                                'ANALYSIS_V2_REVENUE_COST_SETTLEMENT_AMBIGUOUS',
                            );
                        }
                    } catch (error) {
                        try {
                            await operations.manualReview({
                                requestId: source.requestId,
                                reasonCode: 'ambiguous_external_call',
                            });
                        } catch {
                            // The original terminal persistence error already fences dispatch.
                        }
                        throw error;
                    }
                },

                async releaseBeforeDispatch(telemetry) {
                    const source = sourceForStartTelemetry(fence, telemetry);
                    if (!eligible(scope)) return null;
                    return operations.releaseV2(source);
                },

                async manualReviewAfterExternalBoundary() {
                    if (!eligible(scope)) return null;
                    return operations.manualReview({
                        requestId: fence.requestId,
                        reasonCode: 'ambiguous_external_call',
                    });
                },
            };
        },
    };
}
