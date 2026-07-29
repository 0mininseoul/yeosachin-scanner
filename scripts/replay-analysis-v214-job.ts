import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    runReplayAnalysisV2Job,
    V214_EVALUATION,
} from './replay-analysis-v2-job';

/** Build-time entry marker: lets artifact verification distinguish this from V2.13. */
export const REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY = V214_EVALUATION;

/** Injectable V2.14 entry bootstrap; the direct entry below uses this exact path. */
export function runV214ReplayAnalysisV2Job(
    dependencies: Parameters<typeof runReplayAnalysisV2Job>[0] = {},
): Promise<void> {
    return runReplayAnalysisV2Job(dependencies, V214_EVALUATION);
}

function isDirectExecution(): boolean {
    return Boolean(process.argv[1])
        && import.meta.url === pathToFileURL(
            realpathSync(process.argv[1]!),
        ).href;
}

if (isDirectExecution()) {
    runV214ReplayAnalysisV2Job().catch(error => {
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
