import { pathToFileURL } from 'node:url';
import {
    createReplayKeyFile,
    readAuthenticatedReplayBundle,
    removeOwnedReplayArtifacts,
    writeReplayBundle,
} from '../lib/services/analysis/replay/replay-bundle';
import { installReplayArtifactSignalCleanup } from '../lib/services/analysis/replay/replay-artifact-lifecycle';
import {
    deriveStrongUncertainResolverExperiment,
    STRONG_UNCERTAIN_RESOLVER_EXPERIMENT,
} from '../lib/services/analysis/replay/resolver-experiment-artifact';
import { runStrongUncertainResolverExperiment } from '../lib/services/analysis/replay/resolver-experiment-runner';
import { createStrongUncertainResolverExperimentAdapter } from '../lib/services/analysis/replay/replay-staged-ai-adapter';

export type ResolverExperimentCliOptions =
    | {
        command: 'derive';
        parentBundlePath: string;
        parentKeyPath: string;
        bundlePath: string;
        keyPath: string;
    }
    | {
        command: 'run';
        bundlePath: string;
        keyPath: string;
    };

function flags(args: readonly string[]): Map<string, string> {
    const result = new Map<string, string>();
    for (const arg of args) {
        const split = arg.indexOf('=');
        result.set(split < 0 ? arg : arg.slice(0, split), split < 0 ? '' : arg.slice(split + 1));
    }
    return result;
}

export function parseResolverExperimentCliArgs(
    args: readonly string[],
): ResolverExperimentCliOptions {
    const parsed = flags(args);
    if (
        parsed.get('--resolver-experiment') !== STRONG_UNCERTAIN_RESOLVER_EXPERIMENT
        || !parsed.has('--confirm-resolver-experiment')
    ) throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_CONFIRMATION_REQUIRED');
    const bundlePath = parsed.get('--bundle');
    const keyPath = parsed.get('--key');
    if (!bundlePath || !keyPath) throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_PATH_REQUIRED');
    if (parsed.has('--derive') === parsed.has('--run')) {
        throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_COMMAND_INVALID');
    }
    if (parsed.has('--derive')) {
        const parentBundlePath = parsed.get('--parent-bundle');
        const parentKeyPath = parsed.get('--parent-key');
        if (!parentBundlePath || !parentKeyPath) {
            throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_PARENT_REQUIRED');
        }
        return { command: 'derive', parentBundlePath, parentKeyPath, bundlePath, keyPath };
    }
    if (!parsed.has('--paid-ai') || !parsed.has('--confirm-paid-ai')) {
        throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_PAID_CONFIRMATION_REQUIRED');
    }
    return { command: 'run', bundlePath, keyPath };
}

export async function runResolverExperimentCli(
    options: ResolverExperimentCliOptions,
): Promise<Record<string, unknown>> {
    if (options.command === 'derive') {
        const parent = await readAuthenticatedReplayBundle({
            bundlePath: options.parentBundlePath,
            keyPath: options.parentKeyPath,
        });
        if (parent.expired || parent.bundle.schemaVersion !== 2) {
            throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_PARENT_MISMATCH');
        }
        const bundle = deriveStrongUncertainResolverExperiment(parent.bundle);
        const ownedKey = await createReplayKeyFile(options.keyPath);
        try {
            await writeReplayBundle({
                bundle,
                bundlePath: options.bundlePath,
                keyPath: options.keyPath,
            });
        } catch (error) {
            await removeOwnedReplayArtifacts({
                bundlePath: options.bundlePath,
                keyPath: options.keyPath,
                ownedKey,
            });
            throw error;
        }
        return { schemaVersion: 3, experimentId: STRONG_UNCERTAIN_RESOLVER_EXPERIMENT };
    }
    const authenticated = await readAuthenticatedReplayBundle(options);
    const cleanup = () => removeOwnedReplayArtifacts({
        bundlePath: options.bundlePath,
        keyPath: options.keyPath,
        ownedBundle: authenticated.ownedBundle,
        ownedKey: authenticated.ownedKey,
    });
    const uninstall = installReplayArtifactSignalCleanup({ cleanup });
    try {
        if (authenticated.expired || authenticated.bundle.schemaVersion !== 3) {
            throw new Error('ANALYSIS_V2_RESOLVER_EXPERIMENT_CAPABILITY_MISMATCH');
        }
        return await runStrongUncertainResolverExperiment({
            bundle: authenticated.bundle,
            runner: createStrongUncertainResolverExperimentAdapter(),
        }) as unknown as Record<string, unknown>;
    } finally {
        uninstall();
        await cleanup();
    }
}

async function main(): Promise<void> {
    const report = await runResolverExperimentCli(
        parseResolverExperimentCliArgs(process.argv.slice(2)),
    );
    console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
    void main().catch(error => {
        console.error(error instanceof Error ? error.message : 'Resolver experiment failed');
        process.exitCode = 1;
    });
}
