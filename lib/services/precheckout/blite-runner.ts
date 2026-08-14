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

type TerminalStore = Pick<typeof precheckoutBliteTerminalStore, 'claim' | 'complete' | 'fail'>;
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
        now?: () => number;
    } = {},
): Promise<'noop' | 'pending' | 'complete' | 'failed'> {
    const terminalStore = dependencies.terminalStore ?? precheckoutBliteTerminalStore;
    const now = dependencies.now ?? Date.now;
    const claim = await terminalStore.claim({ preflightId });
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
    const onAttemptTelemetry = (telemetry: PrecheckoutBliteInferenceTelemetry): void => {
        emitBestEffort(() => observability.inferenceAttempt(telemetry));
    };
    const failInference = async (
        reason: PrecheckoutBliteFailureReason,
    ): Promise<'failed'> => {
        const failed = await terminalStore.fail({
            preflightId,
            leaseToken: claimed.leaseToken,
            reason,
        });
        if (failed !== false) {
            emitBestEffort(() => observability.inferenceFailed(
                reason === 'inference_timeout'
                    ? 'timeout'
                    : reason === 'inference_response_invalid'
                    ? 'invalid'
                    : 'provider',
            ));
        }
        return 'failed';
    };
    if (!Number.isFinite(submittedAtMs) || !Number.isFinite(deadlineAtMs) || now() >= deadlineAtMs) {
        return failInference('inference_timeout');
    }

    const dto = await (dependencies.infer ?? inferPrecheckoutBlite)(claimed.source, {
        requestId: preflightId,
        submittedAtMs,
        deadlineAtMs,
        candidateRange: computePrecheckoutBliteCandidateRange(
            claimed.followersCount,
            claimed.followingCount,
        ),
        onAttemptTelemetry,
    });
    if (!dto) {
        return failInference(inferenceFailureReason(now(), submittedAtMs));
    }
    const completed = await terminalStore.complete({ preflightId, leaseToken: claimed.leaseToken, dto });
    if (completed !== false) emitBestEffort(() => observability.completed());
    return 'complete';
}
