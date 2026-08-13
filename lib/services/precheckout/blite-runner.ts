import 'server-only';
import { computePrecheckoutBliteCandidateRange } from './blite-range';
import { inferPrecheckoutBlite } from './blite-inference';
import {
    precheckoutBliteTerminalStore,
    type PrecheckoutBliteFailureReason,
    type PrecheckoutBliteClaim,
} from './blite-store';

const INFERENCE_WINDOW_MS = 56_000;

type TerminalStore = Pick<typeof precheckoutBliteTerminalStore, 'claim' | 'complete' | 'fail'>;

function inferenceFailureReason(nowMs: number, submittedAtMs: number): PrecheckoutBliteFailureReason {
    return nowMs >= submittedAtMs + INFERENCE_WINDOW_MS
        ? 'inference_timeout'
        : 'inference_response_invalid';
}

export async function runPrecheckoutBlite(
    preflightId: string,
    dependencies: {
        terminalStore?: TerminalStore;
        infer?: typeof inferPrecheckoutBlite;
        now?: () => number;
    } = {},
): Promise<'noop' | 'pending' | 'complete' | 'failed'> {
    const terminalStore = dependencies.terminalStore ?? precheckoutBliteTerminalStore;
    const claim = await terminalStore.claim({ preflightId });
    if (claim.disposition === 'pending') return 'pending';
    if (claim.disposition === 'complete') return 'complete';
    if (claim.disposition === 'failed') return 'failed';

    const claimed: Extract<PrecheckoutBliteClaim, { disposition: 'claimed' }> = claim;
    const submittedAtMs = Date.parse(claimed.submittedAt);
    const deadlineAtMs = submittedAtMs + INFERENCE_WINDOW_MS;
    const now = dependencies.now ?? Date.now;
    if (!Number.isFinite(submittedAtMs) || !Number.isFinite(deadlineAtMs) || now() >= deadlineAtMs) {
        await terminalStore.fail({
            preflightId,
            leaseToken: claimed.leaseToken,
            reason: 'inference_timeout',
        });
        return 'failed';
    }

    const dto = await (dependencies.infer ?? inferPrecheckoutBlite)(claimed.source, {
        requestId: preflightId,
        submittedAtMs,
        deadlineAtMs,
        candidateRange: computePrecheckoutBliteCandidateRange(
            claimed.followersCount,
            claimed.followingCount,
        ),
    });
    if (!dto) {
        await terminalStore.fail({
            preflightId,
            leaseToken: claimed.leaseToken,
            reason: inferenceFailureReason(now(), submittedAtMs),
        });
        return 'failed';
    }
    await terminalStore.complete({ preflightId, leaseToken: claimed.leaseToken, dto });
    return 'complete';
}
