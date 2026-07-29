import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
    createV219ReplayPreflightReport,
} from '../lib/services/analysis/replay/replay-v219-preflight';
import type {
    runReplayAnalysisV2Job as RunSharedReplayAnalysisV2Job,
} from './replay-analysis-v2-job';

/** Build-time entry marker: distinguishes the immutable V2.19 package. */
export const REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY = Object.freeze({
    capability:
        'historical-partial-available-standard-v27-risk-v23-to-ai-v219-pro-gender-second-look-shadow',
    aiStage: 'ai-stage-policy-v2.19' as const,
});

/** V2.19 always derives the issued budget from its authenticated source. */
export async function runV219ReplayAnalysisV2Job(
    dependencies: Parameters<typeof RunSharedReplayAnalysisV2Job>[0] = {},
): Promise<void> {
    // This entry is the first executable V2.19 module in the immutable job.
    // Pin global before importing the shared adapter, whose Gemini client
    // snapshots the location at module initialization.
    process.env.GOOGLE_CLOUD_LOCATION = 'global';
    const {
        runReplayAnalysisV2Job: runSharedReplayAnalysisV2Job,
    } = await import('./replay-analysis-v2-job');
    return runSharedReplayAnalysisV2Job({
        ...dependencies,
        preflightV219:
            dependencies.preflightV219
                ?? createV219ReplayPreflightReport,
    }, REPLAY_ANALYSIS_V2_JOB_ENTRY_POLICY);
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
