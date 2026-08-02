import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createAnalysisV2SelectedMediaNormalizer } from '../lib/services/ai/image-preprocessing';
import {
    AI_STAGE_POLICY_V210_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
} from '../lib/services/ai/stage-policy';
import { installReplayArtifactSignalCleanup } from '../lib/services/analysis/replay/replay-artifact-lifecycle';
import { captureAnalysisV2ReplayBundle } from '../lib/services/analysis/replay/replay-capture';
import { captureHistoricalPartialAvailableReplayBundle, partialAvailableSafeReport } from '../lib/services/analysis/replay/historical-partial-available-capture';
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
import {
    CURRENT_PRODUCTION_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
    HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY,
    HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY,
    REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY,
    resolveReplayAiStagePolicyVersion,
    type ReplayEvaluationPolicy,
} from '../lib/services/analysis/replay/replay-source-lineage';
import {
    loadCurrentProductionReplayCaptureDescriptor,
    loadHistoricalOfficialE2EReplayCaptureDescriptor,
    loadReplayCaptureDescriptor,
    type CurrentProductionReplaySourceRpcClient,
    type HistoricalOfficialE2EReplaySourceRpcClient,
    type ReplaySourceRpcClient,
} from '../lib/services/analysis/replay/replay-supabase-repository';
import {
    parseDiagnosticPartialCoverageCliCapability,
    type DiagnosticPartialCoverageCliCapability,
} from '../lib/services/analysis/replay/diagnostic-partial-coverage-capability';
import {
    parseFeatureConcurrencyExperimentCliCapability,
    type FeatureConcurrencyExperimentCliCapability,
} from '../lib/services/analysis/replay/feature-concurrency-experiment-capability';

type ReplayCliOptions =
    | { command: 'capture'; target: string; requestId?: string; bundlePath: string; keyPath: string; evaluationPolicy?: ReplayEvaluationPolicy; historicalOfficialE2E?: false }
    | { command: 'capture'; historicalOfficialE2E: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'capture'; historicalPartialAvailable: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'capture'; currentProduction: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'run'; mode: 'dry-run' | 'paid-ai'; bundlePath: string; keyPath: string; evaluationPolicy?: ReplayEvaluationPolicy; historicalOfficialE2E?: true; historicalPartialAvailable?: true; currentProduction?: true; diagnosticPartialCoverageCapability?: DiagnosticPartialCoverageCliCapability; featureConcurrencyExperimentCapability?: FeatureConcurrencyExperimentCliCapability }
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
    '--historical-official-e2e',
    '--historical-partial-available',
    '--current-production',
    '--allow-low-partial-coverage',
    '--confirm-low-partial-coverage',
    '--feature-concurrency-4',
    '--confirm-feature-concurrency-4',
]);

function evaluationPolicy(value: string | undefined, historicalOfficialE2E = false, historicalPartialAvailable = false): ReplayEvaluationPolicy | undefined {
    if (value === undefined) return undefined;
    if (value === AI_STAGE_POLICY_V210_VERSION && historicalPartialAvailable) {
        return {
            capability: HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V210_CAPABILITY,
            aiStage: AI_STAGE_POLICY_V210_VERSION,
        };
    }
    if (value === AI_STAGE_POLICY_V210_VERSION && historicalOfficialE2E) {
        return {
            capability: HISTORICAL_OFFICIAL_E2E_REPLAY_V210_CAPABILITY,
            aiStage: AI_STAGE_POLICY_V210_VERSION,
        };
    }
    if (value !== AI_STAGE_POLICY_V29_VERSION) {
        throw new Error('ANALYSIS_V2_REPLAY_EVALUATION_POLICY_UNSUPPORTED');
    }
    return {
        capability: historicalPartialAvailable
            ? HISTORICAL_PARTIAL_AVAILABLE_REPLAY_CAPABILITY
            : historicalOfficialE2E
            ? HISTORICAL_OFFICIAL_E2E_REPLAY_CAPABILITY
            : REPLAY_V29_CROSS_POLICY_EVALUATION_CAPABILITY,
        aiStage: AI_STAGE_POLICY_V29_VERSION,
    };
}

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
    if (dirname(resolve(bundlePath)) !== dirname(resolve(keyPath))) {
        throw new Error('ANALYSIS_V2_REPLAY_ARTIFACT_PATH_INVALID');
    }
    const allowLowPartialCoverage = parsed.has('--allow-low-partial-coverage');
    const confirmLowPartialCoverage = parsed.has('--confirm-low-partial-coverage');
    if (allowLowPartialCoverage !== confirmLowPartialCoverage) {
        throw new Error('ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_DOUBLE_CONFIRM_REQUIRED');
    }
    if (
        allowLowPartialCoverage
        && (
            !parsed.has('--run')
            || !parsed.has('--paid-ai')
            || !parsed.has('--historical-partial-available')
        )
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_LOW_PARTIAL_COVERAGE_SCOPE_REQUIRED');
    }
    if (parsed.has('--capture')) {
        const historicalOfficialE2E = parsed.has('--historical-official-e2e');
        const historicalPartialAvailable = parsed.has('--historical-partial-available');
        const currentProduction = parsed.has('--current-production');
        if ([historicalOfficialE2E, historicalPartialAvailable, currentProduction].filter(Boolean).length > 1) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
        if (currentProduction) {
            const allowed = new Set(['--capture', '--current-production', '--request-id', '--bundle', '--key']);
            const requestId = parsed.get('--request-id')?.trim();
            if (!requestId || [...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
            return {
                command: 'capture',
                currentProduction: true,
                requestId,
                bundlePath,
                keyPath,
                evaluationPolicy: {
                    capability: CURRENT_PRODUCTION_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
                    aiStage: AI_STAGE_POLICY_V210_VERSION,
                },
            };
        }
        if (historicalPartialAvailable) {
            const allowed = new Set(['--capture', '--historical-partial-available', '--request-id', '--evaluation-ai-policy', '--bundle', '--key']);
            const requestId = parsed.get('--request-id')?.trim();
            if (!requestId || [...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
            const evaluation = evaluationPolicy(parsed.get('--evaluation-ai-policy'), false, true);
            if (!evaluation) throw new Error('ANALYSIS_V2_REPLAY_PARTIAL_CAPABILITY_REQUIRED');
            return { command: 'capture', historicalPartialAvailable: true, requestId, bundlePath, keyPath, evaluationPolicy: evaluation };
        }
        if (historicalOfficialE2E) {
            const allowed = new Set(['--capture', '--historical-official-e2e', '--request-id', '--evaluation-ai-policy', '--bundle', '--key']);
            const requestId = parsed.get('--request-id')?.trim();
            if (!requestId || [...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
            const evaluation = evaluationPolicy(parsed.get('--evaluation-ai-policy'), true);
            if (!evaluation) throw new Error('ANALYSIS_V2_REPLAY_HISTORICAL_E2E_CAPABILITY_REQUIRED');
            return { command: 'capture', historicalOfficialE2E: true, requestId, bundlePath, keyPath, evaluationPolicy: evaluation };
        }
        const target = parsed.get('--target')?.trim();
        const allowed = new Set(['--capture', '--target', '--request-id', '--bundle', '--key', '--evaluation-ai-policy']);
        if (!target || [...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
        const evaluation = evaluationPolicy(parsed.get('--evaluation-ai-policy'));
        return { command: 'capture', target, ...(parsed.get('--request-id') ? { requestId: parsed.get('--request-id') } : {}), bundlePath, keyPath, ...(evaluation ? { evaluationPolicy: evaluation } : {}) };
    }
    if (parsed.has('--cleanup')) {
        if (parsed.size !== 3) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
        return { command: 'cleanup', bundlePath, keyPath };
    }
    if (!parsed.has('--run')) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    const paid = parsed.has('--paid-ai');
    const confirmed = parsed.has('--confirm-paid-ai');
    if (paid !== confirmed || (paid && parsed.has('--dry-run'))) throw new Error('ANALYSIS_V2_REPLAY_PAID_AI_DOUBLE_CONFIRM_REQUIRED');
    const historicalOfficialE2E = parsed.has('--historical-official-e2e');
    const historicalPartialAvailable = parsed.has('--historical-partial-available');
    const currentProduction = parsed.has('--current-production');
    if ([historicalOfficialE2E, historicalPartialAvailable, currentProduction].filter(Boolean).length > 1) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    const allowed = new Set(['--run', '--dry-run', '--paid-ai', '--confirm-paid-ai', '--historical-official-e2e', '--historical-partial-available', '--current-production', '--allow-low-partial-coverage', '--confirm-low-partial-coverage', '--feature-concurrency-4', '--confirm-feature-concurrency-4', '--bundle', '--key', '--evaluation-ai-policy']);
    if ([...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    if (currentProduction && (parsed.has('--evaluation-ai-policy') || !paid)) {
        throw new Error('ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_PAID_SCOPE_REQUIRED');
    }
    const evaluation = currentProduction
        ? {
            capability: CURRENT_PRODUCTION_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
            aiStage: AI_STAGE_POLICY_V210_VERSION,
        } as const
        : evaluationPolicy(parsed.get('--evaluation-ai-policy'), historicalOfficialE2E, historicalPartialAvailable);
    if (historicalOfficialE2E && (!paid || !evaluation)) throw new Error('ANALYSIS_V2_REPLAY_HISTORICAL_E2E_CAPABILITY_REQUIRED');
    if (historicalPartialAvailable && !evaluation) throw new Error('ANALYSIS_V2_REPLAY_PARTIAL_CAPABILITY_REQUIRED');
    const diagnosticPartialCoverageCapability =
        parseDiagnosticPartialCoverageCliCapability(args);
    const featureConcurrencyExperimentCapability =
        parseFeatureConcurrencyExperimentCliCapability(args);
    return { command: 'run', mode: paid ? 'paid-ai' : 'dry-run', bundlePath, keyPath, ...(historicalOfficialE2E ? { historicalOfficialE2E: true } : {}), ...(historicalPartialAvailable ? { historicalPartialAvailable: true } : {}), ...(currentProduction ? { currentProduction: true } : {}), ...(diagnosticPartialCoverageCapability ? { diagnosticPartialCoverageCapability } : {}), ...(featureConcurrencyExperimentCapability ? { featureConcurrencyExperimentCapability } : {}), ...(evaluation ? { evaluationPolicy: evaluation } : {}) };
}

function requiredEnvironment(name: string): string {
    const value = process.env[name]?.trim();
    if (!value) throw new Error('ANALYSIS_V2_REPLAY_CONFIGURATION_MISSING');
    return value;
}

const SERVER_ONLY_RUNTIME_MESSAGE =
    'This module cannot be imported from a Client Component module. It should only be used from a Server Component.';

export async function createPaidReplayRunner(
    replayAiPolicy: ReturnType<typeof resolveReplayAiStagePolicyVersion>,
    featureConcurrencyExperimentCapability?: FeatureConcurrencyExperimentCliCapability,
) {
    try {
        const adapter = await import(
            '../lib/services/analysis/replay/replay-staged-ai-adapter'
        );
        return adapter.createReplayStagedAiAdapter(
            replayAiPolicy,
            featureConcurrencyExperimentCapability
                ? { featureAnalysisConcurrency: 4, featureConcurrencyExperimentCapability }
                : undefined,
        );
    } catch (error) {
        if (error instanceof Error && error.message === SERVER_ONLY_RUNTIME_MESSAGE) {
            throw new Error('ANALYSIS_V2_REPLAY_SERVER_RUNTIME_REQUIRED');
        }
        throw error;
    }
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
        const historicalOfficial = 'historicalOfficialE2E' in options && options.historicalOfficialE2E === true;
        const historicalPartial = 'historicalPartialAvailable' in options && options.historicalPartialAvailable === true;
        const currentProduction = 'currentProduction' in options && options.currentProduction === true;
        const descriptor = currentProduction
            ? await loadCurrentProductionReplayCaptureDescriptor(
                supabase as unknown as CurrentProductionReplaySourceRpcClient,
                options.requestId!,
            )
            : historicalOfficial || historicalPartial
            ? await loadHistoricalOfficialE2EReplayCaptureDescriptor(
                supabase as unknown as HistoricalOfficialE2EReplaySourceRpcClient,
                options.requestId!,
            )
            : await loadReplayCaptureDescriptor(
                supabase as unknown as ReplaySourceRpcClient,
                { targetUsername: (options as Extract<ReplayCliOptions, { target: string }>).target, ...(options.requestId ? { requestId: options.requestId } : {}) },
            );
        const replayAiPolicy = resolveReplayAiStagePolicyVersion(
            descriptor.sourceLineage,
            options.evaluationPolicy,
        );
        const clients = new Map<string, ReturnType<typeof createReplayReadonlyApifyClient>>();
        const source = await loadReplaySourceFromExistingRuns({ descriptor, ...(historicalPartial ? { allowHistoricalPartialAvailable: true } : {}), clientForSlot: slot => {
            const existing = clients.get(slot); if (existing) return existing;
            const created = createReplayReadonlyApifyClient(tokenForSlot(slot)); clients.set(slot, created); return created;
        } });
        const captured = historicalPartial
            ? await captureHistoricalPartialAvailableReplayBundle({
                requestFingerprint: descriptor.requestFingerprint,
                sourceLineage: descriptor.sourceLineage,
                evaluationPolicy: options.evaluationPolicy,
                source: {
                    profiles: source.historicalPartialProfiles,
                    evidence: source.evidence,
                },
                normalizeMedia: createAnalysisV2SelectedMediaNormalizer(),
            })
            : { bundle: await captureAnalysisV2ReplayBundle({
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
            ...(options.evaluationPolicy
                ? { evaluationPolicy: options.evaluationPolicy }
                : {}),
        }), report: undefined };
        const bundle = captured.bundle;
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
            ...(historicalPartial
                ? { benchmark_scope: 'ai-only-historical-partial-available' }
                : { benchmark_scope: 'ai-only-exact-replay' }),
            source_kind: currentProduction
                ? 'current_paid_production'
                : historicalOfficial || historicalPartial
                    ? 'historical_official'
                    : 'legacy_selector',
            source_plan: descriptor.sourceLineage.selectedPlanId,
            source_pipeline: descriptor.sourceLineage.policyVersions.pipeline,
            source_ai_policy: descriptor.sourceLineage.policyVersions.aiStage,
            source_risk_policy: descriptor.sourceLineage.policyVersions.risk,
            evaluation_ai_policy: options.evaluationPolicy?.aiStage ?? null,
            replay_ai_policy: replayAiPolicy,
            full_e2e_evidence: false,
            ...(historicalPartial ? { not_exact: true, no_media_substitution: true, partial: partialAvailableSafeReport(captured.report!) } : {}),
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
        const partialArtifact = authenticated.bundle.schemaVersion === 2;
        if (partialArtifact !== Boolean(options.historicalPartialAvailable)) {
            throw new Error('ANALYSIS_V2_REPLAY_ARTIFACT_SCOPE_MISMATCH');
        }
        const replayAiPolicy = resolveReplayAiStagePolicyVersion(
            authenticated.bundle.capture.sourceLineage,
            options.evaluationPolicy,
        );
        const runner = options.mode === 'paid-ai'
            ? await createPaidReplayRunner(
                replayAiPolicy,
                options.featureConcurrencyExperimentCapability,
            )
            : {};
        const { runAnalysisV2AiReplay } = await import('../lib/services/analysis/replay/replay-runner');
        await runAnalysisV2AiReplay({
            bundle: authenticated.bundle,
            runner,
            mode: options.mode,
            paidAiOptIn: options.mode === 'paid-ai',
            ...(options.diagnosticPartialCoverageCapability
                ? {
                    diagnosticPartialCoverageCapability:
                        options.diagnosticPartialCoverageCapability,
                }
                : {}),
            ...(options.featureConcurrencyExperimentCapability
                ? {
                    featureConcurrencyExperimentCapability:
                        options.featureConcurrencyExperimentCapability,
                }
                : {}),
            ...(options.evaluationPolicy
                ? { evaluationPolicy: options.evaluationPolicy }
                : {}),
            write: line => process.stdout.write(`${line}\n`),
        });
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
