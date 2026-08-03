import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { createAnalysisV2SelectedMediaNormalizer } from '../lib/services/ai/image-preprocessing';
import {
    AI_STAGE_POLICY_V210_VERSION,
    AI_STAGE_POLICY_V211_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
} from '../lib/services/ai/stage-policy';
import { installReplayArtifactSignalCleanup } from '../lib/services/analysis/replay/replay-artifact-lifecycle';
import { captureAnalysisV2ReplayBundle } from '../lib/services/analysis/replay/replay-capture';
import { captureHistoricalPartialAvailableReplayBundle, partialAvailableSafeReport } from '../lib/services/analysis/replay/historical-partial-available-capture';
import {
    analysisV2ReplaySemanticInputFingerprint,
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
    BETATEST_FREE_POOL_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
    TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_REPLAY_CAPABILITY,
    TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_TEXT_ONLY_REPLAY_CAPABILITY,
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
    loadBetatestFreePoolReplayCaptureDescriptor,
    loadTestEntitlementLegacySecondaryReplayCaptureDescriptor,
    loadTestEntitlementLegacySecondaryTextOnlyReplayCaptureDescriptor,
    type BetatestFreePoolReplaySourceRpcClient,
    type TestEntitlementLegacySecondaryReplaySourceRpcClient,
    type TestEntitlementLegacySecondaryTextOnlyReplaySourceRpcClient,
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
import { applyV211LegacySecondaryPreview, createV211LegacySecondaryPreview, verifyV211LegacySecondaryPreview } from '../lib/services/analysis/replay/v211-legacy-secondary-preview';

type ReplayCliOptions =
    | { command: 'capture'; target: string; requestId?: string; bundlePath: string; keyPath: string; evaluationPolicy?: ReplayEvaluationPolicy; historicalOfficialE2E?: false }
    | { command: 'capture'; historicalOfficialE2E: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'capture'; historicalPartialAvailable: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'capture'; currentProduction: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'capture'; betatestFreePool: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'capture'; legacySecondary: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'capture'; legacySecondaryTextOnly: true; requestId: string; bundlePath: string; keyPath: string; evaluationPolicy: ReplayEvaluationPolicy }
    | { command: 'run'; mode: 'dry-run' | 'paid-ai'; bundlePath: string; keyPath: string; previewPath?: string; evaluationPolicy?: ReplayEvaluationPolicy; historicalOfficialE2E?: true; historicalPartialAvailable?: true; currentProduction?: true; betatestFreePool?: true; legacySecondary?: true; legacySecondaryTextOnly?: true; diagnosticPartialCoverageCapability?: DiagnosticPartialCoverageCliCapability; featureConcurrencyExperimentCapability?: FeatureConcurrencyExperimentCliCapability }
    | { command: 'apply'; previewPath: string; legacySecondaryTextOnly?: true }
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
    '--betatest-free-pool',
    '--legacy-secondary',
    '--legacy-secondary-text-only',
    '--allow-low-partial-coverage',
    '--confirm-low-partial-coverage',
    '--feature-concurrency-4',
    '--confirm-feature-concurrency-4',
    '--apply',
    '--confirm-apply',
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
    if (parsed.has('--apply')) {
        const previewPath = parsed.get('--preview')?.trim();
        const textOnly = parsed.has('--legacy-secondary-text-only');
        if (!previewPath || !parsed.has('--confirm-apply') || parsed.size !== (textOnly ? 4 : 3)) throw new Error('ANALYSIS_V2_V211_APPLY_CONFIRMATION_REQUIRED');
        return { command: 'apply', previewPath, ...(textOnly ? { legacySecondaryTextOnly: true } : {}) };
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
        const betatestFreePool = parsed.has('--betatest-free-pool');
        const legacySecondary = parsed.has('--legacy-secondary');
        const legacySecondaryTextOnly = parsed.has('--legacy-secondary-text-only');
        if ([historicalOfficialE2E, historicalPartialAvailable, currentProduction, betatestFreePool, legacySecondary, legacySecondaryTextOnly].filter(Boolean).length > 1) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
        if (legacySecondaryTextOnly) {
            const allowed = new Set(['--capture', '--legacy-secondary-text-only', '--request-id', '--bundle', '--key']);
            const requestId = parsed.get('--request-id')?.trim();
            if (!requestId || [...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
            return {
                command: 'capture', legacySecondaryTextOnly: true, requestId, bundlePath, keyPath,
                evaluationPolicy: {
                    capability: TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_TEXT_ONLY_REPLAY_CAPABILITY,
                    aiStage: AI_STAGE_POLICY_V211_VERSION,
                },
            };
        }
        if (legacySecondary) {
            const allowed = new Set(['--capture', '--legacy-secondary', '--request-id', '--bundle', '--key']);
            const requestId = parsed.get('--request-id')?.trim();
            if (!requestId || [...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
            return {
                command: 'capture', legacySecondary: true, requestId, bundlePath, keyPath,
                evaluationPolicy: {
                    capability: TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_REPLAY_CAPABILITY,
                    aiStage: AI_STAGE_POLICY_V211_VERSION,
                },
            };
        }
        if (betatestFreePool) {
            const allowed = new Set(['--capture', '--betatest-free-pool', '--request-id', '--bundle', '--key']);
            const requestId = parsed.get('--request-id')?.trim();
            if (!requestId || [...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
            return {
                command: 'capture', betatestFreePool: true, requestId, bundlePath, keyPath,
                evaluationPolicy: {
                    capability: BETATEST_FREE_POOL_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
                    aiStage: AI_STAGE_POLICY_V210_VERSION,
                },
            };
        }
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
    const betatestFreePool = parsed.has('--betatest-free-pool');
    const legacySecondary = parsed.has('--legacy-secondary');
    const legacySecondaryTextOnly = parsed.has('--legacy-secondary-text-only');
    if ([historicalOfficialE2E, historicalPartialAvailable, currentProduction, betatestFreePool, legacySecondary, legacySecondaryTextOnly].filter(Boolean).length > 1) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    const allowed = new Set(['--run', '--dry-run', '--paid-ai', '--confirm-paid-ai', '--historical-official-e2e', '--historical-partial-available', '--current-production', '--betatest-free-pool', '--legacy-secondary', '--legacy-secondary-text-only', '--allow-low-partial-coverage', '--confirm-low-partial-coverage', '--feature-concurrency-4', '--confirm-feature-concurrency-4', '--bundle', '--key', '--preview', '--evaluation-ai-policy']);
    if ([...parsed.keys()].some(key => !allowed.has(key))) throw new Error('ANALYSIS_V2_REPLAY_CLI_USAGE');
    if (currentProduction && (parsed.has('--evaluation-ai-policy') || !paid)) {
        throw new Error('ANALYSIS_V2_REPLAY_CURRENT_PRODUCTION_PAID_SCOPE_REQUIRED');
    }
    if (betatestFreePool && (parsed.has('--evaluation-ai-policy') || !paid)) {
        throw new Error('ANALYSIS_V2_REPLAY_BETATEST_FREE_POOL_PAID_SCOPE_REQUIRED');
    }
    if (legacySecondary && (parsed.has('--evaluation-ai-policy') || !paid)) {
        throw new Error('ANALYSIS_V2_REPLAY_LEGACY_SECONDARY_PAID_SCOPE_REQUIRED');
    }
    if (legacySecondaryTextOnly && (parsed.has('--evaluation-ai-policy') || !paid)) {
        throw new Error('ANALYSIS_V2_REPLAY_LEGACY_SECONDARY_TEXT_ONLY_PAID_SCOPE_REQUIRED');
    }
    const previewPath = parsed.get('--preview')?.trim();
    if ((legacySecondary || legacySecondaryTextOnly) !== Boolean(previewPath)) {
        throw new Error('ANALYSIS_V2_REPLAY_LEGACY_SECONDARY_PREVIEW_REQUIRED');
    }
    const evaluation = currentProduction
        ? {
            capability: CURRENT_PRODUCTION_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
            aiStage: AI_STAGE_POLICY_V210_VERSION,
        } as const
        : betatestFreePool
            ? {
                capability: BETATEST_FREE_POOL_STANDARD_V210_EXACT_REPLAY_CAPABILITY,
                aiStage: AI_STAGE_POLICY_V210_VERSION,
            } as const
        : legacySecondary
            ? {
                capability: TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_REPLAY_CAPABILITY,
                aiStage: AI_STAGE_POLICY_V211_VERSION,
            } as const
        : legacySecondaryTextOnly
            ? {
                capability: TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_TEXT_ONLY_REPLAY_CAPABILITY,
                aiStage: AI_STAGE_POLICY_V211_VERSION,
            } as const
        : evaluationPolicy(parsed.get('--evaluation-ai-policy'), historicalOfficialE2E, historicalPartialAvailable);
    if (historicalOfficialE2E && (!paid || !evaluation)) throw new Error('ANALYSIS_V2_REPLAY_HISTORICAL_E2E_CAPABILITY_REQUIRED');
    if (historicalPartialAvailable && !evaluation) throw new Error('ANALYSIS_V2_REPLAY_PARTIAL_CAPABILITY_REQUIRED');
    const diagnosticPartialCoverageCapability =
        parseDiagnosticPartialCoverageCliCapability(args);
    const featureConcurrencyExperimentCapability =
        parseFeatureConcurrencyExperimentCliCapability(args);
    return { command: 'run', mode: paid ? 'paid-ai' : 'dry-run', bundlePath, keyPath, ...(previewPath ? { previewPath } : {}), ...(historicalOfficialE2E ? { historicalOfficialE2E: true } : {}), ...(historicalPartialAvailable ? { historicalPartialAvailable: true } : {}), ...(currentProduction ? { currentProduction: true } : {}), ...(betatestFreePool ? { betatestFreePool: true } : {}), ...(legacySecondary ? { legacySecondary: true } : {}), ...(legacySecondaryTextOnly ? { legacySecondaryTextOnly: true } : {}), ...(diagnosticPartialCoverageCapability ? { diagnosticPartialCoverageCapability } : {}), ...(featureConcurrencyExperimentCapability ? { featureConcurrencyExperimentCapability } : {}), ...(evaluation ? { evaluationPolicy: evaluation } : {}) };
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

function tokenForSlot(slot: string, legacySecondary = false): string {
    const allowed = new Set([
        'primary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary',
    ]);
    if (legacySecondary) allowed.add('secondary');
    if (!allowed.has(slot)) {
        throw new Error('ANALYSIS_V2_REPLAY_APIFY_CREDENTIAL_SLOT_FORBIDDEN');
    }
    const key = `APIFY_${slot.toUpperCase()}_API_TOKEN`;
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
        const betatestFreePool = 'betatestFreePool' in options && options.betatestFreePool === true;
        const legacySecondary = 'legacySecondary' in options && options.legacySecondary === true;
        const legacySecondaryTextOnly = 'legacySecondaryTextOnly' in options && options.legacySecondaryTextOnly === true;
        const descriptor = legacySecondaryTextOnly
            ? await loadTestEntitlementLegacySecondaryTextOnlyReplayCaptureDescriptor(
                supabase as unknown as TestEntitlementLegacySecondaryTextOnlyReplaySourceRpcClient,
                options.requestId!,
            )
            : legacySecondary
            ? await loadTestEntitlementLegacySecondaryReplayCaptureDescriptor(
                supabase as unknown as TestEntitlementLegacySecondaryReplaySourceRpcClient,
                options.requestId!,
            )
            : betatestFreePool
            ? await loadBetatestFreePoolReplayCaptureDescriptor(
                supabase as unknown as BetatestFreePoolReplaySourceRpcClient,
                options.requestId!,
            )
            : currentProduction
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
            const created = createReplayReadonlyApifyClient(tokenForSlot(slot, legacySecondary || legacySecondaryTextOnly)); clients.set(slot, created); return created;
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
            ...((legacySecondary || legacySecondaryTextOnly) && 'originalFemaleRows' in descriptor
                ? { legacySecondary: {
                    requestId: descriptor.requestId,
                    sourceFingerprint: descriptor.sourceFingerprint,
                    currentRevision: descriptor.currentRevision,
                    originalFemaleRows: descriptor.originalFemaleRows,
                    ...(legacySecondaryTextOnly && 'canonicalCounts' in descriptor
                        ? { textOnly: { canonicalCounts: descriptor.canonicalCounts } }
                        : {}),
                } }
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
            source_kind: legacySecondaryTextOnly
                ? 'test_entitlement_v211_legacy_secondary_text_only'
                : legacySecondary
                ? 'test_entitlement_v211_legacy_secondary'
                : betatestFreePool
                ? 'betatest_free_pool'
                : currentProduction
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
            semantic_input_fingerprint:
                analysisV2ReplaySemanticInputFingerprint(bundle),
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
    if (options.command === 'apply') {
        const raw = await readFile(options.previewPath, 'utf8');
        const preview = verifyV211LegacySecondaryPreview(JSON.parse(raw));
        if (Boolean(preview.textOnly) !== Boolean(options.legacySecondaryTextOnly)) {
            throw new Error('ANALYSIS_V2_V211_TEXT_ONLY_APPLY_SCOPE_REQUIRED');
        }
        const serviceKey = requiredEnvironment('SUPABASE_SERVICE_ROLE_KEY');
        if (serviceKey.startsWith('sb_publishable_') || serviceKey === process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim()) throw new Error('ANALYSIS_V2_REPLAY_CONFIGURATION_INVALID');
        const supabase = createClient(requiredEnvironment('NEXT_PUBLIC_SUPABASE_URL'), serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
        const result = await applyV211LegacySecondaryPreview(supabase as never, preview) as { revisionNumber?: number; payloadHash?: string; idempotent?: boolean } | null;
        if (!result || !Number.isInteger(result.revisionNumber) || !/^[a-f0-9]{64}$/.test(result.payloadHash ?? '') || typeof result.idempotent !== 'boolean') throw new Error('ANALYSIS_V2_V211_REVISION_APPLY_INVALID');
        process.stdout.write(`${JSON.stringify({ status: 'ok', command: 'apply', revision_number: result.revisionNumber, payload_hash: result.payloadHash, idempotent: result.idempotent })}\n`);
        return { exitCode: 0 };
    }
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
        if (options.legacySecondary || options.legacySecondaryTextOnly) {
            const legacy = authenticated.bundle.capture.legacySecondary;
            if (
                authenticated.bundle.schemaVersion !== 1
                || authenticated.bundle.capture.evaluationPolicy?.capability
                    !== (options.legacySecondaryTextOnly
                        ? TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_TEXT_ONLY_REPLAY_CAPABILITY
                        : TEST_ENTITLEMENT_STANDARD_V211_LEGACY_SECONDARY_REPLAY_CAPABILITY)
                || !legacy
                || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(legacy.requestId)
                || !/^[a-f0-9]{64}$/.test(legacy.sourceFingerprint)
                || !Number.isInteger(legacy.currentRevision)
                || !Array.isArray(legacy.originalFemaleRows)
                || (options.legacySecondaryTextOnly && !legacy.textOnly)
            ) throw new Error('ANALYSIS_V2_REPLAY_LEGACY_SECONDARY_ARTIFACT_INVALID');
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
        const report = await runAnalysisV2AiReplay({
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
        if (options.legacySecondary || options.legacySecondaryTextOnly) {
            const preview = createV211LegacySecondaryPreview({
                requestId: authenticated.bundle.capture.legacySecondary!.requestId,
                bundle: authenticated.bundle,
                accountOutputs: report.accountOutputs,
                semanticInputFingerprint: report.semanticInputFingerprint,
            });
            await writeFile(options.previewPath!, `${JSON.stringify(preview)}\n`, {
                encoding: 'utf8', mode: 0o600, flag: 'wx',
            });
            process.stdout.write(`${JSON.stringify({
                status: 'ok', command: 'preview', source_kind: report.sourceKind,
                preview_hash: preview.previewHash, counts: preview.counts,
            })}\n`);
        }
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
