import { pathToFileURL } from 'node:url';
import { readReplayBundle } from '../lib/services/analysis/replay/replay-bundle';
import { runAnalysisV2AiReplay } from '../lib/services/analysis/replay/replay-runner';

interface ReplayCliOptions { bundlePath: string; keyPath: string; dryRun: boolean; }

export function parseReplayCliArgs(args: readonly string[]): ReplayCliOptions {
    const values = new Map(args.map(arg => {
        const [key, ...rest] = arg.split('=');
        return [key, rest.join('=')];
    }));
    const bundlePath = values.get('--bundle')?.trim();
    const keyPath = values.get('--key')?.trim();
    if (args.length !== 3 || values.get('--dry-run') !== '' || !bundlePath || !keyPath) {
        throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    }
    return { bundlePath, keyPath, dryRun: true };
}

export async function runReplayValidationCli(args: readonly string[]): Promise<{ exitCode: 0 | 1 }> {
    const options = parseReplayCliArgs(args);
    const bundle = await readReplayBundle({ bundlePath: options.bundlePath, keyPath: options.keyPath });
    await runAnalysisV2AiReplay({ bundle, runner: {}, mode: 'dry-run', write: line => process.stdout.write(`${line}\n`) });
    return { exitCode: 0 };
}

function isDirectExecution(): boolean {
    const entry = process.argv[1];
    return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isDirectExecution()) {
    runReplayValidationCli(process.argv.slice(2)).then(result => { process.exitCode = result.exitCode; }).catch(error => {
        const code = error instanceof Error && /^ANALYSIS_V2_REPLAY_[A-Z_]+$/.test(error.message)
            ? error.message
            : 'ANALYSIS_V2_REPLAY_FAILED';
        process.stderr.write(`${JSON.stringify({ status: 'failed', errorCode: code })}\n`);
        process.exitCode = 1;
    });
}
