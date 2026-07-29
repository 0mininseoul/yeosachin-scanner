import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    createV219ReplayPreflightReport,
} from '../lib/services/analysis/replay/replay-v219-preflight';
import {
    runReplayAnalysisV2Job as runSharedReplayAnalysisV2Job,
    V219_EVALUATION,
} from './replay-analysis-v2-job';

/** Build-time entry marker: distinguishes the immutable V2.19 package. */
export const REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY = V219_EVALUATION;

/** V2.19 always derives the issued budget from its authenticated source. */
export function runV219ReplayAnalysisV2Job(
    dependencies: Parameters<typeof runSharedReplayAnalysisV2Job>[0] = {},
): Promise<void> {
    return runSharedReplayAnalysisV2Job({
        ...dependencies,
        preflightV219:
            dependencies.preflightV219
                ?? createV219ReplayPreflightReport,
    }, V219_EVALUATION);
}

/** Cloud bootstrap compatibility pinned to V2.19. */
export const runReplayAnalysisV2Job = runV219ReplayAnalysisV2Job;

function isDirectExecution(): boolean {
    return Boolean(process.argv[1])
        && import.meta.url === pathToFileURL(
            realpathSync(process.argv[1]!),
        ).href;
}

if (isDirectExecution()) {
    runV219ReplayAnalysisV2Job().catch(error => {
        const message = error instanceof Error
            && /^ANALYSIS_V2_REPLAY_JOB_[A-Z0-9_]+$/.test(error.message)
            ? error.message
            : 'ANALYSIS_V2_REPLAY_JOB_FAILED';
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            errorCode: message,
        })}\n`);
        process.exitCode = 1;
    });
}
