import { stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createAnalysisV2SelectedMediaNormalizer } from '../lib/services/ai/image-preprocessing';
import { AI_STAGE_POLICY_LATEST_VERSION } from '../lib/services/ai/stage-policy';
import { installReplayArtifactSignalCleanup } from '../lib/services/analysis/replay/replay-artifact-lifecycle';
import { captureAnalysisV2ReplayBundle } from '../lib/services/analysis/replay/replay-capture';
import {
    createReplayArtifactCreationScope,
    createReplayKeyFile,
    readAuthenticatedReplayBundle,
    removeExpiredReplayArtifacts,
    removeOwnedReplayArtifacts,
    removeReplayArtifacts,
    writeReplayBundle,
} from '../lib/services/analysis/replay/replay-bundle';
import { createReplayReadonlyApifyClient, loadReplaySourceFromExistingRuns } from '../lib/services/analysis/replay/replay-live-source';
import { runAnalysisV2AiReplay } from '../lib/services/analysis/replay/replay-runner';
import { createReplayStagedAiAdapter } from '../lib/services/analysis/replay/replay-staged-ai-adapter';
import { loadReplayCaptureDescriptor, type ReplaySourceRpcClient } from '../lib/services/analysis/replay/replay-supabase-repository';

type ReplayCliOptions =
    | { command: 'capture'; target: string; requestId?: string; bundlePath: string; keyPath: string }
    | { command: 'run'; mode: 'dry-run' | 'paid-ai'; bundlePath: string; keyPath: string }
    | { command: 'cleanup'; bundlePath: string; keyPath: string };

function values(args: readonly string[]): Map<string, string> {
    const parsed = new Map<string, string>();
    for (const arg of args) {
        const index = arg.indexOf('=');
        parsed.set(index < 0 ? arg : arg.slice(0, index), index < 0 ? '' : arg.slice(index + 1));
    }
    if (parsed.size !== args.length) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    return parsed;
}

const VALUELESS_FLAGS = new Set([
    '--capture',
    '--cleanup',
    '--run',
    '--dry-run',
    '--paid-ai',
    '--confirm-paid-ai',
]);

export function parseReplayCliArgs(args: readonly string[]): ReplayCliOptions {
    if (args.some(arg => {
        const equalsIndex = arg.indexOf('=');
        return equalsIndex >= 0 && VALUELESS_FLAGS.has(arg.slice(0, equalsIndex));
    })) {
        throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    }
    const parsed = values(args);
    if ([...parsed].some(([key, value]) => VALUELESS_FLAGS.has(key) && value !== '')) {
        throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    }
    const bundlePath = parsed.get('--bundle')?.trim();
    const keyPath = parsed.get('--key')?.trim();
    if (!bundlePath || !keyPath) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    if (parsed.has('--capture')) {
        const target = parsed.get('--target')?.trim();
        const allowed = new Set(['--capture', '--target', '--request-id', '--bundle', '--key']);
        if (!target || [...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
        return { command: 'capture', target, ...(parsed.get('--request-id') ? { requestId: parsed.get('--request-id') } : {}), bundlePath, keyPath };
    }
    if (parsed.has('--cleanup')) {
        if (parsed.size !== 3) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
        return { command: 'cleanup', bundlePath, keyPath };
    }
    if (!parsed.has('--run')) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    const paid = parsed.has('--paid-ai');
    const confirmed = parsed.has('--confirm-paid-ai');
    if (paid !== confirmed || (paid && parsed.has('--dry-run'))) throw new Error('ANALYSIS_V2_REPLAY_PAID_AI_DOUBLE_CONFIRM_REQUIRED');
    const allowed = new Set(['--run', '--dry-run', '--paid-ai', '--confirm-paid-ai', '--bundle', '--key']);
    if ([...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    return { command: 'run', mode: paid ? 'paid-ai' : 'dry-run', bundlePath, keyPath };
}

function requiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error('ANALYSIS_V2_REPLAY_CONFIGURATION_MISSING');
    return value;
}

function tokenForSlot(slot: string): string {
    const key = slot === 'primary' ? 'APIFY_API_TOKEN' : `APIFY_${slot.toUpperCase()}_API_TOKEN`;
    return requiredEnvironment(key);
}

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
        ) return false;
        throw error;
    }
}

async function capture(options: Extract<ReplayCliOptions, { command: 'capture' }>): Promise<void> {
    const started = performance.now();
    const ownership: Parameters<typeof removeOwnedReplayArtifacts>[0] = {
        bundlePath: options.bundlePath,
        keyPath: options.keyPath,
    };
    const creationScope = createReplayArtifactCreationScope();
    const cleanup = async () => {
        await creationScope.cleanupActive();
        await removeOwnedReplayArtifacts(ownership);
    };
    const [bundleExists, keyExists] = await Promise.all([
        exists(options.bundlePath),
        exists(options.keyPath),
    ]);
    if (bundleExists !== keyExists) {
        throw new Error('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
    }
    if (bundleExists) {
        const removed = await removeExpiredReplayArtifacts({
            bundlePath: options.bundlePath,
            keyPath: options.keyPath,
        });
        if (!removed) {
            throw new Error('ANALYSIS_V2_REPLAY_ARTIFACT_ALREADY_EXISTS');
        }
    }
    const uninstallSignals = installReplayArtifactSignalCleanup({ cleanup });
    try {
        const serviceKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
        if (serviceKey.startsWith('sb_publishable_') || serviceKey === process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) throw new Error('ANALYSIS_V2_REPLAY_CONFIGURATION_INVALID');
        const supabase = createClient(requiredEnvironment('NEXT_PUBLIC_SUPABASE_URL'), serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const descriptor = await loadReplayCaptureDescriptor(supabase as unknown as ReplaySourceRpcClient, { targetUsername: options.target, ...(options.requestId ? { requestId: options.requestId } : {}) });
        const clients = new Map<string, ReturnType<typeof createReplayReadonlyApifyClient>>();
        const source = await loadReplaySourceFromExistingRuns({ descriptor, clientForSlot: slot => {
            const existing = clients.get(slot); if (existing) return existing;
            const created = createReplayReadonlyApifyClient(tokenForSlot(slot)); clients.set(slot, created); return created;
        } });
        const bundle = await captureAnalysisV2ReplayBundle({
            selector: { targetUsername: descriptor.targetUsername },
            repository: {
                findCompletedReplaySourceExact: async () => ({
                    requestFingerprint: descriptor.requestFingerprint,
                    sourceLineage: descriptor.sourceLineage,
                    completed: true,
                }),
                loadReplaySource: async () => source,
            },
            normalizeMedia: createAnalysisV2SelectedMediaNormalizer(),
        });
        ownership.ownedKey = await createReplayKeyFile(options.keyPath, {
            scope: creationScope,
        });
        ownership.ownedBundle = await writeReplayBundle({
            bundle,
            bundlePath: options.bundlePath,
            keyPath: options.keyPath,
            artifactWrite: { scope: creationScope },
        });
        const bytes = (await stat(options.bundlePath)).size;
        process.stdout.write(`${JSON.stringify({
            status: 'ok',
            command: 'capture',
            benchmark_scope: 'ai-only-exact-replay',
            source_plan: descriptor.sourceLineage.selectedPlanId,
            source_pipeline: descriptor.sourceLineage.policyVersions.pipeline,
            source_ai_policy: descriptor.sourceLineage.policyVersions.aiStage,
            source_risk_policy: descriptor.sourceLineage.policyVersions.risk,
            replay_ai_policy: AI_STAGE_POLICY_LATEST_VERSION,
            full_e2e_evidence: false,
            profiles: bundle.profiles.length,
            public: bundle.profiles.filter(p => !p.isPrivate).length,
            private: bundle.profiles.filter(p => p.isPrivate).length,
            media: bundle.profiles.reduce((sum, p) => sum + p.media.length, 0),
            bytes,
            elapsed_ms: Math.round(performance.now() - started),
        })}\n`);
    } catch (error) {
        await cleanup();
        throw error;
    } finally {
        uninstallSignals();
    }
}

export async function runReplayCli(
    args: readonly string[],
    dependencies: {
        beforeOwnedArtifactRemoval?: () => Promise<void>;
    } = {},
): Promise<{ exitCode: 0 | 1 }> {
    const options = parseReplayCliArgs(args);
    if (options.command === 'cleanup') { await removeReplayArtifacts(options); process.stdout.write(`${JSON.stringify({ status: 'ok', command: 'cleanup', removed: 2 })}\n`); return { exitCode: 0 }; }
    if (options.command === 'capture') { await capture(options); return { exitCode: 0 }; }
    const ownership: Parameters<typeof removeOwnedReplayArtifacts>[0] = {
        bundlePath: options.bundlePath,
        keyPath: options.keyPath,
    };
    let beforeRemovalCalled = false;
    const cleanup = async () => {
        if (!ownership.ownedBundle || !ownership.ownedKey) return;
        if (!beforeRemovalCalled) {
            beforeRemovalCalled = true;
            await dependencies.beforeOwnedArtifactRemoval?.();
        }
        await removeOwnedReplayArtifacts(ownership);
    };
    const uninstallSignals = installReplayArtifactSignalCleanup({ cleanup });
    try {
        const authenticated = await readAuthenticatedReplayBundle(options);
        ownership.ownedBundle = authenticated.ownedBundle;
        ownership.ownedKey = authenticated.ownedKey;
        if (authenticated.expired) {
            throw new Error('ANALYSIS_V2_REPLAY_BUNDLE_EXPIRED');
        }
        await runAnalysisV2AiReplay({ bundle: authenticated.bundle, runner: options.mode === 'paid-ai' ? createReplayStagedAiAdapter() : {}, mode: options.mode, paidAiOptIn: options.mode === 'paid-ai', write: line => process.stdout.write(`${line}\n`) });
        return { exitCode: 0 };
    } finally {
        uninstallSignals();
        await cleanup();
    }
}

function isDirectExecution(): boolean { const entry = process.argv[1]; return Boolean(entry) && import.meta.url === pathToFileURL(entry).href; }
if (isDirectExecution()) runReplayCli(process.argv.slice(2)).then(result => { process.exitCode = result.exitCode; }).catch(error => {
    const code = error instanceof Error && /^ANALYSIS_V2_REPLAY_[A-Z_]+$/.test(error.message) ? error.message : 'ANALYSIS_V2_REPLAY_FAILED';
    process.stderr.write(`${JSON.stringify({ status: 'failed', errorCode: code })}\n`); process.exitCode = 1;
});
