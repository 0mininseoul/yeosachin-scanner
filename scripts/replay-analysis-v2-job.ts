import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
    constants as fileConstants,
    lstatSync,
    realpathSync,
} from 'node:fs';
import {
    link,
    lstat,
    open,
    realpath,
    rename,
    unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
    createReplayJobGcsClient,
    type ReplayJobGcsClient,
} from '../lib/services/analysis/replay/replay-job-gcs';
import {
    readAuthenticatedReplayBundle,
    removeOwnedReplayArtifacts,
    type AnalysisV2ReplayBundle,
} from '../lib/services/analysis/replay/replay-bundle';
import { installReplayArtifactSignalCleanup } from '../lib/services/analysis/replay/replay-artifact-lifecycle';
import { createReplayStagedAiAdapter } from '../lib/services/analysis/replay/replay-staged-ai-adapter';
import { runAnalysisV2AiReplay } from '../lib/services/analysis/replay/replay-runner';
import {
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY,
} from '../lib/services/analysis/replay/replay-source-lineage';
import {
    parseDiagnosticPartialCoverageCliCapability,
} from '../lib/services/analysis/replay/diagnostic-partial-coverage-capability';

const V212_EVALUATION = Object.freeze({
    capability: HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.12' as const,
});

const FALSE_GATES = [
    'ANALYSIS_TASKS_ENABLED',
    'ANALYSIS_TEST_ENTITLEMENTS_ENABLED',
    'ANALYSIS_V2_ADMISSION_ENABLED',
    'ANALYSIS_V2_AI_MICROBATCH_V29_ROLLOUT',
    'ANALYSIS_V2_AI_SCHEDULER_ROLLOUT',
    'ANALYSIS_V2_AUTHORIZED_TEST_SHARDING_ENABLED',
    'ANALYSIS_V2_GENDER_RESOLUTION_ROLLOUT',
    'ANALYSIS_V2_NARRATIVE_V28_ROLLOUT',
    'ANALYSIS_V2_REPLAY_CAPTURE_ENABLED',
    'ANALYSIS_V2_RESULT_IMAGES_ENABLED',
    'ANALYSIS_V2_TASKS_ENABLED',
    'ANALYSIS_V2_WORKER_ENABLED',
    'ANALYSIS_V2_WORKER_EXECUTION_ENABLED',
    'ANALYSIS_V2_RECOVERY_ENABLED',
    'DEMO_ANALYSIS_ENABLED',
    'EARLYBIRD_AUTOMATIC_FULFILLMENT_ENABLED',
    'PREFLIGHT_LOCAL_AFTER_ENABLED',
    'PREFLIGHT_TASKS_ENABLED',
] as const;

const aggregateCount = z.number().int().min(0).max(100_000_000);
const aggregateRate = z.number().finite().min(0).max(1);
const replayOutcomeCounts = z.object({
    ok: aggregateCount.optional(),
    rate_limited: aggregateCount.optional(),
    retry_exhausted: aggregateCount.optional(),
    rejected: aggregateCount.optional(),
    failed: aggregateCount.optional(),
    capacity_skipped: aggregateCount.optional(),
}).strict();
const stageFailureDispositionCounts = z.object({
    success: aggregateCount.optional(),
    rate_limited: aggregateCount.optional(),
    ambiguous: aggregateCount.optional(),
    rejected: aggregateCount.optional(),
    response_rejected: aggregateCount.optional(),
    retry_exhausted: aggregateCount.optional(),
    failed: aggregateCount.optional(),
    capacity_skipped: aggregateCount.optional(),
    cutoff: aggregateCount.optional(),
}).strict();
const stageFailureKindCounts = z.object({
    http_408: aggregateCount.optional(),
    http_429: aggregateCount.optional(),
    http_4xx: aggregateCount.optional(),
    http_5xx: aggregateCount.optional(),
    transport: aggregateCount.optional(),
    unknown_sdk: aggregateCount.optional(),
}).strict();
const triageSourceCounts = z.object({
    checkpoint: aggregateCount.optional(),
    safe_fallback: aggregateCount.optional(),
    unknown: aggregateCount.optional(),
    non_ok: aggregateCount.optional(),
}).strict();
const genderConfidenceCounts = z.object({
    'female:low': aggregateCount.optional(),
    'female:medium': aggregateCount.optional(),
    'female:high': aggregateCount.optional(),
    'male:low': aggregateCount.optional(),
    'male:medium': aggregateCount.optional(),
    'male:high': aggregateCount.optional(),
    'unknown:low': aggregateCount.optional(),
    'unknown:medium': aggregateCount.optional(),
    'unknown:high': aggregateCount.optional(),
}).strict();
const triageAccountContextCounts = z.object({
    personal: aggregateCount.optional(),
    individual_creator: aggregateCount.optional(),
    official_group_or_brand: aggregateCount.optional(),
    uncertain: aggregateCount.optional(),
    absent: aggregateCount.optional(),
}).strict();
const featureAdmissionCounts = z.object({
    eligible: aggregateCount.optional(),
    nonpersonal_or_official: aggregateCount.optional(),
    unsupported_unknown: aggregateCount.optional(),
}).strict();
const featureFinalDecisionCounts = z.object({
    verified_female: aggregateCount.optional(),
    verified_non_female: aggregateCount.optional(),
    unresolved: aggregateCount.optional(),
    unresolved_stage_conflict: aggregateCount.optional(),
}).strict();
const featureAccountContextCounts = z.object({
    personal: aggregateCount.optional(),
    individual_creator: aggregateCount.optional(),
    official_group_or_brand: aggregateCount.optional(),
    uncertain: aggregateCount.optional(),
}).strict();
const featureRouteTerminalCounts = z.object({
    not_routed_high_male: aggregateCount.optional(),
    excluded_official: aggregateCount.optional(),
    completed: aggregateCount.optional(),
    provider_non_ok: aggregateCount.optional(),
    triage_non_ok: aggregateCount.optional(),
}).strict();
const resolverOutcomeCounts = replayOutcomeCounts.extend({
    official_excluded: aggregateCount.optional(),
    cutoff: aggregateCount.optional(),
}).strict();
const finalClassificationSourceCounts = z.object({
    triage: aggregateCount.optional(),
    feature: aggregateCount.optional(),
    gender_resolution: aggregateCount.optional(),
    unknown: aggregateCount.optional(),
    unavailable: aggregateCount.optional(),
    triage_non_ok: aggregateCount.optional(),
}).strict();
const stageMetricsSchema = z.object({
    calls: aggregateCount,
    rate_limited: aggregateCount,
    retries: aggregateCount,
    mean_latency_ms: z.number().finite().min(0).max(3_600_000),
    p50_latency_ms: z.number().finite().min(0).max(3_600_000),
    p95_latency_ms: z.number().finite().min(0).max(3_600_000),
    failure_disposition: stageFailureDispositionCounts,
    failure_kind: stageFailureKindCounts,
}).strict();
const replayAnalysisV2JobTerminalSchema = z.object({
    status: z.literal('ok'),
    benchmark_scope: z.literal('ai-only-historical-partial-available'),
    source_plan: z.literal('standard'),
    source_pipeline: z.literal('v2'),
    source_ai_policy: z.literal('ai-stage-policy-v2.7'),
    source_risk_policy: z.literal('risk-policy-v2.3'),
    evaluation_ai_policy: z.literal('ai-stage-policy-v2.12'),
    replay_ai_policy: z.literal('ai-stage-policy-v2.12'),
    full_e2e_evidence: z.literal(false),
    not_exact: z.literal(true),
    no_media_substitution: z.literal(true),
    diagnostic_partial_coverage_override: z.object({
        used: z.literal(true),
        retained_profiles: aggregateCount,
        source_profiles: aggregateCount,
        retained_media: aggregateCount,
        exact_selected_media: aggregateCount,
        profile_retention_bps: z.number().int().min(0).max(10_000),
        media_retention_bps: z.number().int().min(0).max(10_000),
    }).strict(),
    total_elapsed_ms: z.number().finite().min(0).max(86_400_000),
    stages: z.object({
        genderTriage: stageMetricsSchema,
        featureAnalysis: stageMetricsSchema,
        privateAccountName: stageMetricsSchema,
        genderResolution: stageMetricsSchema,
    }).strict(),
    gender: z.object({
        male: aggregateCount,
        female: aggregateCount,
        unknown: aggregateCount,
        unknownRate: aggregateRate,
    }).strict(),
    resolver: z.object({
        ready: aggregateCount,
        applied: aggregateCount,
        inconclusive: aggregateCount,
        cutoff: aggregateCount,
        capacitySkipped: aggregateCount,
        admission: z.object({
            eligible: aggregateCount,
            alreadyVerified: aggregateCount,
            officialOrGroup: aggregateCount,
            uncertainOrAbsent: aggregateCount,
            insufficientMedia: aggregateCount,
        }).strict(),
        outcomes: z.object({
            readyHighConfirmed: aggregateCount,
            evidenceInsufficient: aggregateCount,
            mixed: aggregateCount,
            unknown: aggregateCount,
            reconciliationApplied: aggregateCount,
            reconciliationInconclusive: aggregateCount,
            cutoff: aggregateCount,
            capacitySkipped: aggregateCount,
        }).strict(),
    }).strict(),
    gender_quality: z.object({
        triage: z.object({
            nonOk: aggregateCount,
            capacity: aggregateCount,
            outcome: replayOutcomeCounts,
            source: triageSourceCounts,
            genderConfidence: genderConfidenceCounts,
            accountContext: triageAccountContextCounts,
        }).strict(),
        feature: z.object({
            admission: featureAdmissionCounts,
            finalDecision: featureFinalDecisionCounts,
            accountContext: featureAccountContextCounts,
            routeTerminal: featureRouteTerminalCounts,
        }).strict(),
        resolver: z.object({
            earlyAdmission: aggregateCount,
            lateAdmission: aggregateCount,
            outcome: resolverOutcomeCounts,
        }).strict(),
        finalClassificationSource: finalClassificationSourceCounts,
        qualityGate: z.object({
            observedUnknownRate: aggregateRate,
            worstCaseUnknownRate: aggregateRate,
            observedPass: z.boolean(),
            worstCasePass: z.boolean(),
        }).strict(),
    }).strict(),
}).strict();

export interface ReplayAnalysisV2JobConfig {
    bundlePath: string;
    keyPath: string;
    bucket: string;
    bundleObject: string;
    bundleGeneration: string;
    bundleBytes: number;
    bundleSha256: string;
    claimObject: string;
    reportObject: string;
}

function required(
    env: Record<string, string | undefined>,
    key: string,
): string {
    const value = env[key];
    if (!value) throw new Error('ANALYSIS_V2_REPLAY_JOB_CONFIGURATION_INVALID');
    return value;
}

function equalSecret(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function forbiddenEnvironmentKey(key: string): boolean {
    if (
        key === 'ANALYSIS_V2_REPLAY_JOB_TOKEN'
        || key === 'ANALYSIS_V2_REPLAY_JOB_EXPECTED_TOKEN'
    ) {
        return false;
    }
    return (
        key.startsWith('APIFY')
        || /SUPABASE.*(?:URL|KEY)/.test(key)
        || key.startsWith('R2')
        || key.includes('_R2_')
        || key.includes('QUEUE')
        || key.includes('MAINTENANCE')
        || /TASKS_.*(?:URL|SECRET|TOKEN|KEY|AUDIENCE)/.test(key)
        || /^GOOGLE_.*(?:APPLICATION_CREDENTIALS|JSON|KEY_BASE64|PRIVATE_KEY)$/.test(key)
        || /^(?:GOOGLE|GEMINI)_API_KEY$/.test(key)
        || /(?:^|_)(?:SECRET|PASSWORD|PASSWD)(?:_|$)/.test(key)
        || /(?:^|_)TOKEN(?:_|$)/.test(key)
        || /(?:^|_)(?:SIGNING|HMAC)_(?:KEY|SECRET)(?:_|$)/.test(key)
        || /(?:^|_)API_KEY(?:_|$)/.test(key)
        || /^(?:DATABASE|DB|POSTGRES)_URL$/.test(key)
    );
}

export function validateReplayAnalysisV2JobEnvironment(
    env: Record<string, string | undefined>,
): ReplayAnalysisV2JobConfig {
    if (
        env.CLOUD_RUN_TASK_COUNT !== '1'
        || env.CLOUD_RUN_TASK_INDEX !== '0'
        || env.CLOUD_RUN_TASK_ATTEMPT !== '0'
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_TASK_CONFIGURATION_INVALID');
    }
    const execution = required(env, 'CLOUD_RUN_EXECUTION');
    const executionToken = required(env, 'ANALYSIS_V2_REPLAY_JOB_TOKEN');
    const expectedToken = required(
        env,
        'ANALYSIS_V2_REPLAY_JOB_EXPECTED_TOKEN',
    );
    if (
        execution !== required(
            env,
            'ANALYSIS_V2_REPLAY_JOB_EXPECTED_EXECUTION',
        )
        || !/^[A-Za-z0-9_-]{43,128}$/.test(executionToken)
        || !equalSecret(executionToken, expectedToken)
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_EXECUTION_MISMATCH');
    }
    for (const gate of FALSE_GATES) {
        if (env[gate] !== 'false') {
            throw new Error('ANALYSIS_V2_REPLAY_JOB_GATE_CONFIGURATION_INVALID');
        }
    }
    if (Object.keys(env).some(forbiddenEnvironmentKey)) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_FORBIDDEN_ENVIRONMENT');
    }
    const bundleBytes = Number(required(
        env,
        'ANALYSIS_V2_REPLAY_JOB_BUNDLE_BYTES',
    ));
    if (!Number.isSafeInteger(bundleBytes) || bundleBytes < 1) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_CONFIGURATION_INVALID');
    }
    return {
        bundlePath: required(env, 'ANALYSIS_V2_REPLAY_JOB_BUNDLE_PATH'),
        keyPath: required(env, 'ANALYSIS_V2_REPLAY_JOB_KEY_PATH'),
        bucket: required(env, 'ANALYSIS_V2_REPLAY_JOB_GCS_BUCKET'),
        bundleObject: required(env, 'ANALYSIS_V2_REPLAY_JOB_BUNDLE_OBJECT'),
        bundleGeneration: required(
            env,
            'ANALYSIS_V2_REPLAY_JOB_BUNDLE_GENERATION',
        ),
        bundleBytes,
        bundleSha256: required(
            env,
            'ANALYSIS_V2_REPLAY_JOB_BUNDLE_SHA256',
        ),
        claimObject: required(
            env,
            'ANALYSIS_V2_REPLAY_JOB_CLAIM_OBJECT',
        ),
        reportObject: required(
            env,
            'ANALYSIS_V2_REPLAY_JOB_REPORT_OBJECT',
        ),
    };
}

type FileIdentity = { device: number; inode: number };

export async function removeReplayAnalysisV2JobLocalArtifact(
    path: string,
    identity?: FileIdentity,
): Promise<void> {
    if (!identity) return;
    const quarantinePath = `${path}.cleanup-${randomUUID()}`;
    try {
        await rename(path, quarantinePath);
    } catch (error) {
        if (
            error instanceof Error
            && 'code' in error
            && error.code === 'ENOENT'
        ) return;
        throw error;
    }
    const quarantined = await lstat(quarantinePath);
    if (
        quarantined.dev !== identity.device
        || quarantined.ino !== identity.inode
    ) {
        try {
            await link(quarantinePath, path);
            await unlink(quarantinePath);
        } catch (cause) {
            throw new Error(
                'ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_RACE',
                { cause },
            );
        }
        throw new Error('ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_RACE');
    }
    await unlink(quarantinePath);
}

async function exactPrivateFile(
    path: string,
    expectedMode: number,
): Promise<FileIdentity> {
    const file = await lstat(path);
    if (
        !file.isFile()
        || file.isSymbolicLink()
        || (file.mode & 0o777) !== expectedMode
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_INVALID');
    }
    return { device: file.dev, inode: file.ino };
}

export async function loadReplayAnalysisV2JobArtifacts(
    config: ReplayAnalysisV2JobConfig,
    gcs: ReplayJobGcsClient,
    registerSignalCleanup?: (cleanup: () => Promise<void>) => void,
): Promise<{ bundle: unknown; cleanup: () => Promise<void> }> {
    const bundlePath = resolve(config.bundlePath);
    const keyPath = resolve(config.keyPath);
    const directory = dirname(bundlePath);
    if (
        dirname(keyPath) !== directory
        || !basename(bundlePath).endsWith('.enc')
        || !basename(keyPath).endsWith('.key')
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_INVALID');
    }
    const [realDirectory, realTemporaryRoot] = await Promise.all([
        realpath(directory),
        realpath(tmpdir()),
    ]);
    const directoryStat = await lstat(realDirectory);
    if (
        !realDirectory.startsWith(`${realTemporaryRoot}${sep}`)
        || !directoryStat.isDirectory()
        || (directoryStat.mode & 0o777) !== 0o700
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_INVALID');
    }
    const keyIdentity = await exactPrivateFile(keyPath, 0o600);
    let bundleIdentity: FileIdentity | undefined;
    registerSignalCleanup?.(async () => {
        await Promise.all([
            removeReplayAnalysisV2JobLocalArtifact(
                bundlePath,
                bundleIdentity,
            ),
            removeReplayAnalysisV2JobLocalArtifact(keyPath, keyIdentity),
        ]);
    });
    try {
        const ciphertext = await gcs.downloadBundle();
        const handle = await open(
            bundlePath,
            fileConstants.O_WRONLY
                | fileConstants.O_CREAT
                | fileConstants.O_EXCL,
            0o600,
        );
        try {
            const opened = await handle.stat();
            if (
                !opened.isFile()
                || (opened.mode & 0o777) !== 0o600
            ) {
                throw new Error(
                    'ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_INVALID',
                );
            }
            bundleIdentity = {
                device: opened.dev,
                inode: opened.ino,
            };
            await handle.writeFile(ciphertext);
            await handle.sync();
        } finally {
            await handle.close();
        }
        const observedBundleIdentity = await exactPrivateFile(
            bundlePath,
            0o600,
        );
        if (
            observedBundleIdentity.device !== bundleIdentity.device
            || observedBundleIdentity.inode !== bundleIdentity.inode
        ) {
            throw new Error('ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_RACE');
        }
        const authenticated = await readAuthenticatedReplayBundle({
            bundlePath,
            keyPath,
        });
        if (
            authenticated.ownedBundle.device !== bundleIdentity.device
            || authenticated.ownedBundle.inode !== bundleIdentity.inode
            || authenticated.ownedKey.device !== keyIdentity.device
            || authenticated.ownedKey.inode !== keyIdentity.inode
        ) {
            throw new Error('ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_RACE');
        }
        return {
            bundle: {
                ...authenticated.bundle,
                expired: authenticated.expired,
            },
            cleanup: () => removeOwnedReplayArtifacts({
                bundlePath,
                keyPath,
                ownedBundle: authenticated.ownedBundle,
                ownedKey: authenticated.ownedKey,
            }),
        };
    } catch (error) {
        await Promise.all([
            removeReplayAnalysisV2JobLocalArtifact(
                bundlePath,
                bundleIdentity,
            ),
            removeReplayAnalysisV2JobLocalArtifact(keyPath, keyIdentity),
        ]);
        throw error;
    }
}

function authenticatedV212Bundle(value: unknown): AnalysisV2ReplayBundle {
    const candidate = value as AnalysisV2ReplayBundle & { expired?: unknown };
    const { expired, ...withoutExpiry } = candidate;
    const bundle = withoutExpiry as AnalysisV2ReplayBundle;
    const policy = bundle?.capture?.evaluationPolicy;
    const lineage = bundle?.capture?.sourceLineage;
    if (
        bundle?.schemaVersion !== 2
        || expired !== false
        || bundle.capture.scope !== 'ai-only-historical-partial-available'
        || policy?.capability
            !== HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V212_CAPABILITY
        || policy.aiStage !== 'ai-stage-policy-v2.12'
        || lineage.selectedPlanId !== 'standard'
        || lineage.policyVersions.pipeline !== 'v2'
        || lineage.policyVersions.aiStage !== 'ai-stage-policy-v2.7'
        || lineage.policyVersions.risk !== 'risk-policy-v2.3'
        || 'scheduler' in lineage.policyVersions
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_BUNDLE_CAPABILITY_MISMATCH');
    }
    return bundle;
}

export function validateReplayAnalysisV2JobTerminalLine(
    raw: string | undefined,
): string {
    if (!raw) throw new Error('ANALYSIS_V2_REPLAY_JOB_REPORT_MISSING');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    if (!replayAnalysisV2JobTerminalSchema.safeParse(parsed).success) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    return raw;
}

interface ReplayAnalysisV2JobDependencies {
    env?: Record<string, string | undefined>;
    loadArtifacts?: (
        config: ReplayAnalysisV2JobConfig,
        gcs: ReplayJobGcsClient,
        registerSignalCleanup: (cleanup: () => Promise<void>) => void,
    ) => Promise<{ bundle: unknown; cleanup: () => Promise<void> }>;
    createGcsClient?: (
        config: ReplayAnalysisV2JobConfig,
    ) => ReplayJobGcsClient;
    createRunner?: (policy: 'ai-stage-policy-v2.12') => unknown;
    runReplay?: (input: {
        bundle: AnalysisV2ReplayBundle;
        runner: unknown;
        mode: 'paid-ai';
        paidAiOptIn: true;
        evaluationPolicy: typeof V212_EVALUATION;
        diagnosticPartialCoverageCapability: object;
        write: (line: string) => void;
    }) => Promise<unknown>;
    bindLocalCleanup?: (
        config: ReplayAnalysisV2JobConfig,
    ) => () => Promise<void>;
    installSignalCleanup?: typeof installReplayArtifactSignalCleanup;
    writeStdout?: (line: string) => void;
}

function localArtifactInvalid(): never {
    throw new Error('ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_INVALID');
}

function bindReplayAnalysisV2JobLocalCleanup(
    config: ReplayAnalysisV2JobConfig,
): () => Promise<void> {
    const bundlePath = resolve(config.bundlePath);
    const keyPath = resolve(config.keyPath);
    const directory = dirname(bundlePath);
    if (
        dirname(keyPath) !== directory
        || !basename(bundlePath).endsWith('.enc')
        || !basename(keyPath).endsWith('.key')
    ) {
        localArtifactInvalid();
    }

    let realDirectory: string;
    let realTemporaryRoot: string;
    let directoryStat: ReturnType<typeof lstatSync>;
    let keyStat: ReturnType<typeof lstatSync>;
    try {
        realDirectory = realpathSync(directory);
        realTemporaryRoot = realpathSync(tmpdir());
        directoryStat = lstatSync(realDirectory);
        keyStat = lstatSync(keyPath);
    } catch {
        localArtifactInvalid();
    }
    if (
        !realDirectory.startsWith(`${realTemporaryRoot}${sep}`)
        || !directoryStat.isDirectory()
        || (directoryStat.mode & 0o777) !== 0o700
        || !keyStat.isFile()
        || keyStat.isSymbolicLink()
        || (keyStat.mode & 0o777) !== 0o600
    ) {
        localArtifactInvalid();
    }
    try {
        lstatSync(bundlePath);
        localArtifactInvalid();
    } catch (error) {
        if (
            !(error instanceof Error)
            || !('code' in error)
            || error.code !== 'ENOENT'
        ) {
            throw error;
        }
    }
    const keyIdentity = {
        device: keyStat.dev,
        inode: keyStat.ino,
    };
    return async () => {
        await Promise.all([
            removeReplayAnalysisV2JobLocalArtifact(bundlePath),
            removeReplayAnalysisV2JobLocalArtifact(
                keyPath,
                keyIdentity,
            ),
        ]);
    };
}

function createCleanupCoordinator(
    initialCleanup: () => Promise<void>,
): {
    cleanup: () => Promise<void>;
    replace: (cleanup: () => Promise<void>) => void;
} {
    let cleanup = initialCleanup;
    let generation = 0;
    let completedGeneration = -1;
    let active: Promise<void> | undefined;
    return {
        replace(nextCleanup) {
            cleanup = nextCleanup;
            generation += 1;
        },
        async cleanup() {
            while (completedGeneration < generation) {
                if (active) {
                    await active;
                    continue;
                }
                const runningGeneration = generation;
                const running = Promise.resolve().then(() => cleanup());
                active = running;
                try {
                    await running;
                    completedGeneration = Math.max(
                        completedGeneration,
                        runningGeneration,
                    );
                } finally {
                    if (active === running) {
                        active = undefined;
                    }
                }
            }
        },
    };
}

export async function runReplayAnalysisV2Job(
    dependencies: ReplayAnalysisV2JobDependencies = {},
): Promise<void> {
    const config = validateReplayAnalysisV2JobEnvironment(
        dependencies.env ?? process.env,
    );
    const gcs = (dependencies.createGcsClient ?? (value => (
        createReplayJobGcsClient(value)
    )))(config);
    const initialCleanup = dependencies.bindLocalCleanup?.(config)
        ?? bindReplayAnalysisV2JobLocalCleanup(config);
    const cleanupCoordinator = createCleanupCoordinator(initialCleanup);
    const uninstallSignals = (
        dependencies.installSignalCleanup
            ?? installReplayArtifactSignalCleanup
    )({ cleanup: cleanupCoordinator.cleanup });
    let loaded: Awaited<ReturnType<
        typeof loadReplayAnalysisV2JobArtifacts
    >> | undefined;
    let terminalLine: string | undefined;
    try {
        loaded = await (
            dependencies.loadArtifacts ?? loadReplayAnalysisV2JobArtifacts
        )(config, gcs, cleanup => {
            cleanupCoordinator.replace(cleanup);
        });
        cleanupCoordinator.replace(loaded.cleanup);
        const bundle = authenticatedV212Bundle(loaded.bundle);
        await gcs.createClaim(JSON.stringify({
            status: 'claimed',
            schema: 'analysis-v2-replay-job-claim-v1',
        }));
        const runner = (
            dependencies.createRunner
                ?? (policy => createReplayStagedAiAdapter(policy))
        )('ai-stage-policy-v2.12');
        const diagnosticPartialCoverageCapability =
            parseDiagnosticPartialCoverageCliCapability([
                '--run',
                '--paid-ai',
                '--confirm-paid-ai',
                '--historical-partial-available',
                '--allow-low-partial-coverage',
                '--confirm-low-partial-coverage',
            ]);
        if (!diagnosticPartialCoverageCapability) {
            throw new Error('ANALYSIS_V2_REPLAY_JOB_CAPABILITY_MISSING');
        }
        const originalConsoleLog = console.log;
        console.log = () => undefined;
        try {
            await (dependencies.runReplay ?? (input => (
                runAnalysisV2AiReplay(input as Parameters<
                    typeof runAnalysisV2AiReplay
                >[0])
            )))({
                bundle,
                runner,
                mode: 'paid-ai',
                paidAiOptIn: true,
                evaluationPolicy: V212_EVALUATION,
                diagnosticPartialCoverageCapability,
                write: line => {
                    if (terminalLine !== undefined) {
                        throw new Error(
                            'ANALYSIS_V2_REPLAY_JOB_REPORT_MULTIPLE',
                        );
                    }
                    terminalLine = line;
                },
            });
        } finally {
            console.log = originalConsoleLog;
        }
        terminalLine = validateReplayAnalysisV2JobTerminalLine(terminalLine);
        await gcs.createReport(terminalLine);
    } finally {
        try {
            await cleanupCoordinator.cleanup();
        } finally {
            uninstallSignals();
        }
    }
    (dependencies.writeStdout ?? (line => process.stdout.write(line)))(
        `${terminalLine}\n`,
    );
}

function isDirectExecution(): boolean {
    return Boolean(process.argv[1])
        && import.meta.url === pathToFileURL(
            realpathSync(process.argv[1]!),
        ).href;
}

if (isDirectExecution()) {
    runReplayAnalysisV2Job().catch(error => {
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
