import 'server-only';
import { computePrecheckoutBliteCandidateRange } from './blite-range';
import { inferPrecheckoutBlite } from './blite-inference';
import { BLITE_INFERENCE_DEADLINE_MS } from './blite-deadline';
import {
    precheckoutBliteTerminalStore,
    type PrecheckoutBliteFailureReason,
    type PrecheckoutBliteClaim,
} from './blite-store';
import {
    createPrecheckoutBliteObservability,
    type PrecheckoutBliteObservability,
} from './blite-observability';
import type { AnalysisV2GeminiLeaseStore } from '@/lib/services/analysis/v2-gemini-lease-store';
import {
    createAnalysisV2GeminiLeaseStore,
    AnalysisV2AiCapacityPendingError,
    AnalysisV2AiDeadlineTooShortError,
    AnalysisV2AiQuarantineActiveError,
    AnalysisV2GeminiLeasePersistenceError,
    type AnalysisV2GeminiLease,
} from '@/lib/services/analysis/v2-gemini-lease-store';
import {
    AnalysisProviderAdmissionCapacityPendingError,
} from '@/lib/services/analysis/provider-admission-store';

type TerminalStore = Pick<typeof precheckoutBliteTerminalStore, 'claim' | 'complete' | 'fail'> & {
    deferCapacity?: (input: {
        preflightId: string;
        leaseToken: string;
        dispatchGeneration?: number;
        dispatchToken?: string;
    }) => Promise<boolean>;
};
type PrecheckoutBliteInferenceTelemetry =
    Parameters<PrecheckoutBliteObservability['inferenceAttempt']>[0];

function emitBestEffort(action: () => void): void {
    try {
        action();
    } catch {
        // Observability must never change the durable inference outcome.
    }
}

function inferenceFailureReason(
    nowMs: number,
    submittedAtMs: number,
): PrecheckoutBliteFailureReason {
    return nowMs >= submittedAtMs + BLITE_INFERENCE_DEADLINE_MS
        ? 'inference_timeout'
        : 'inference_response_invalid';
}

export async function runPrecheckoutBlite(
    preflightId: string,
    dependencies: {
        terminalStore?: TerminalStore;
        infer?: typeof inferPrecheckoutBlite;
        observability?: PrecheckoutBliteObservability;
        geminiLeaseStore?: AnalysisV2GeminiLeaseStore;
        env?: Record<string, string | undefined>;
        now?: () => number;
        dispatchGeneration?: number;
        dispatchToken?: string;
    } = {},
): Promise<'noop' | 'pending' | 'capacity_pending' | 'complete' | 'failed'> {
    const terminalStore = dependencies.terminalStore ?? precheckoutBliteTerminalStore;
    const now = dependencies.now ?? Date.now;
    const claim = await terminalStore.claim({
        preflightId,
        ...(dependencies.dispatchGeneration === undefined
            ? {}
            : { dispatchGeneration: dependencies.dispatchGeneration }),
        ...(dependencies.dispatchToken === undefined
            ? {}
            : { dispatchToken: dependencies.dispatchToken }),
    });
    if (claim.disposition === 'pending') return 'pending';
    if (claim.disposition === 'complete') return 'complete';
    if (claim.disposition === 'failed') return 'failed';

    const claimed: Extract<PrecheckoutBliteClaim, { disposition: 'claimed' }> = claim;
    const submittedAtMs = Date.parse(claimed.submittedAt);
    const deadlineAtMs = submittedAtMs + BLITE_INFERENCE_DEADLINE_MS;
    const observability = dependencies.observability ?? createPrecheckoutBliteObservability({
        preflightId,
        startedAtMs: Number.isFinite(submittedAtMs) ? submittedAtMs : now(),
        now,
    });
    let terminalCommitConfirmed = false;
    const onAttemptTelemetry = (telemetry: PrecheckoutBliteInferenceTelemetry): void => {
        emitBestEffort(() => observability.inferenceAttempt(telemetry));
    };
    const failInference = async (
        reason: PrecheckoutBliteFailureReason,
    ): Promise<'pending' | 'failed'> => {
        let failed: boolean;
        try {
            failed = await terminalStore.fail({
                preflightId,
                leaseToken: claimed.leaseToken,
                reason,
            });
        } catch {
            // A persistence error leaves ownership unknown.  Keep the shared
            // Gemini fence held and make Cloud Tasks redeliver so a later
            // owner can observe the durable cache state.
            return 'pending';
        }
        if (failed !== true) {
            // A false CAS is not proof that terminal failure committed.  The
            // cache may still be pending and its dispatch fence must remain
            // recoverable; acknowledging this delivery would strand it.
            return 'pending';
        }
        terminalCommitConfirmed = true;
        emitBestEffort(() => observability.inferenceFailed(
            reason === 'inference_timeout'
                ? 'timeout'
                : reason === 'inference_response_invalid'
                ? 'invalid'
                : 'provider',
        ));
        return 'failed';
    };
    if (!Number.isFinite(submittedAtMs) || !Number.isFinite(deadlineAtMs) || now() >= deadlineAtMs) {
        return failInference('inference_timeout');
    }
    // Gemini's store uses a monotonic clock (performance.now), while the durable preflight
    // deadline is epoch-based. Convert once at the boundary instead of relying on a unit
    // mismatch that would accidentally pass the 225s standard deadline check.
    const handlerDeadlineAtMonotonicMs = performance.now()
        + Math.max(0, deadlineAtMs - now());

    let geminiLease: AnalysisV2GeminiLease | undefined;
    // The Gemini slot fence is the established database-global eight-slot ceiling and must be
    // acquired in every mode. ANALYSIS_PROVIDER_ADMISSION_ENABLED only controls the additive
    // provider-admission attach inside the store; it is never a switch for Gemini execution.
    const geminiLeaseStore = dependencies.geminiLeaseStore
        ?? createAnalysisV2GeminiLeaseStore({ env: dependencies.env });
    let releaseAttempted = false;
    let capacityDeferInFlight = false;
    const releaseGeminiLease = async (allowBeforeTerminalCommit = false): Promise<void> => {
        if (!geminiLease || !geminiLeaseStore || releaseAttempted) return;
        if (!allowBeforeTerminalCommit && !terminalCommitConfirmed) return;
        releaseAttempted = true;
        // Keep the lease object authoritative until the release RPC returns. If the response
        // is unknown, the underlying Gemini fence remains leased for maintenance recovery and
        // this invocation must not issue a replacement start.
        await geminiLeaseStore.release(geminiLease);
        geminiLease = undefined;
    };
    const deferCapacity = async (error: unknown): Promise<boolean> => {
        if (
            !(
                error instanceof AnalysisV2AiCapacityPendingError
                || error instanceof AnalysisProviderAdmissionCapacityPendingError
                || error instanceof AnalysisV2AiQuarantineActiveError
                || error instanceof AnalysisV2AiDeadlineTooShortError
            )
        ) return false;
        if (!terminalStore.deferCapacity) {
            // An enabled worker without the durable rearm RPC must not turn a capacity wait
            // into a terminal failure or silently drop the cache claim.
            throw new AnalysisV2GeminiLeasePersistenceError();
        }
        capacityDeferInFlight = true;
        const deferred = await terminalStore.deferCapacity({
            preflightId,
            leaseToken: claimed.leaseToken,
            ...(dependencies.dispatchGeneration === undefined
                ? {}
                : { dispatchGeneration: dependencies.dispatchGeneration }),
            ...(dependencies.dispatchToken === undefined
                ? {}
                : { dispatchToken: dependencies.dispatchToken }),
        });
        if (!deferred) {
            capacityDeferInFlight = false;
            return false;
        }
        // The cache rearm is durable before admission is released. A crash between these
        // operations can retain capacity until recovery, but cannot duplicate a provider start.
        await releaseGeminiLease(true);
        capacityDeferInFlight = false;
        return true;
    };

    try {
        geminiLease = await geminiLeaseStore.acquire({
            requestId: preflightId,
            jobKey: 'preflight:blite',
            jobClaimToken: claimed.leaseToken,
            attempt: 1,
            handlerDeadlineAtMs: handlerDeadlineAtMonotonicMs,
            leaseProfile: 'precheckout_blite',
        });
        const dto: Awaited<ReturnType<typeof inferPrecheckoutBlite>> =
            await (dependencies.infer ?? inferPrecheckoutBlite)(claimed.source, {
                requestId: preflightId,
                jobClaimToken: claimed.leaseToken,
                geminiLeaseStore,
                ...(geminiLease ? { geminiLease } : {}),
                env: dependencies.env,
                submittedAtMs,
                deadlineAtMs,
                candidateRange: computePrecheckoutBliteCandidateRange(
                    claimed.followersCount,
                    claimed.followingCount,
                ),
                onAttemptTelemetry,
            });
        if (!dto) {
            const outcome = await failInference(inferenceFailureReason(now(), submittedAtMs));
            await releaseGeminiLease();
            return outcome;
        }
        // Terminal cache commit is the ownership boundary. Release the shared
        // Gemini admission only after it succeeds, so a crash/retry cannot
        // spend twice while the cache remains pending.
        const completed = await terminalStore.complete({ preflightId, leaseToken: claimed.leaseToken, dto });
        if (completed !== true) {
            // A false or unknown terminal checkpoint is not proof that this owner committed.
            // Keep both fences until TTL/recovery; a retry can discover the committed terminal
            // cache row without allowing this worker to free a possibly reused slot.
            return 'pending';
        }
        terminalCommitConfirmed = true;
        emitBestEffort(() => observability.completed());
        await releaseGeminiLease();
        return 'complete';
    } catch (error) {
        if (await deferCapacity(error)) return 'capacity_pending';
        // An uncertain cache rearm must retain the Gemini fence. All other failures release
        // only once and preserve the durable slot fence if the response is ambiguous.
        if (!capacityDeferInFlight) await releaseGeminiLease();
        throw error;
    }
}
