import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    runReplayAnalysisV2Job as runSharedReplayAnalysisV2Job,
    V217_EVALUATION,
} from './replay-analysis-v2-job';

/** Build-time entry marker: lets artifact verification distinguish V2.17. */
export const REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY = V217_EVALUATION;

/** Injectable V2.17 entry bootstrap; the direct entry below uses this exact path. */
export function runV217ReplayAnalysisV2Job(
    dependencies: Parameters<typeof runSharedReplayAnalysisV2Job>[0] = {},
): Promise<void> {
    return runSharedReplayAnalysisV2Job(dependencies, V217_EVALUATION);
}

/** Cloud bootstrap compatibility: this common name remains pinned to V2.17. */
export const runReplayAnalysisV2Job = runV217ReplayAnalysisV2Job;

function isDirectExecution(): boolean {
    return Boolean(process.argv[1])
        && import.meta.url === pathToFileURL(
            realpathSync(process.argv[1]!),
        ).href;
}

if (isDirectExecution()) {
    runV217ReplayAnalysisV2Job().catch(error => {
        const message = error instanceof Error
            && /^ANALYSIS_V2_REPLAY_JOB_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'ANALYSIS_V2_REPLAY_JOB_FAILED';
        process.stderr.write(`${JSON.stringify({
            status: 'failed',
            errorCode: message,
        })}\n`);
        process.exitCode = 1;
    });
}
