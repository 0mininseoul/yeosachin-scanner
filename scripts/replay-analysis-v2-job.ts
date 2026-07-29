import { timingSafeEqual } from 'node:crypto';
import { constants as fileConstants } from 'node:fs';
import { lstat, open, realpath, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
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

const SAFE_REPORT_KEYS = new Set([
    'status',
    'benchmark_scope',
    'source_plan',
    'source_pipeline',
    'source_ai_policy',
    'source_risk_policy',
    'evaluation_ai_policy',
    'replay_ai_policy',
    'full_e2e_evidence',
    'not_exact',
    'no_media_substitution',
    'diagnostic_coverage_override',
    'total_elapsed_ms',
    'stages',
    'gender',
    'resolver',
    'gender_quality',
]);

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
    return (
        key.startsWith('APIFY')
        || /SUPABASE.*(?:URL|KEY)/.test(key)
        || key.startsWith('R2')
        || key.includes('_R2_')
        || key.includes('QUEUE')
        || key.includes('MAINTENANCE')
        || /TASKS_.*(?:URL|SECRET|TOKEN|KEY|AUDIENCE)/.test(key)
        || /^GOOGLE_.*(?:APPLICATION_CREDENTIALS|JSON|KEY_BASE64|PRIVATE_KEY)$/.test(key)
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

async function unlinkIdentity(
    path: string,
    identity?: FileIdentity,
): Promise<void> {
    if (!identity) return;
    try {
        const file = await lstat(path);
        if (file.dev === identity.device && file.ino === identity.inode) {
            await unlink(path);
        }
    } catch {
        return;
    }
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
            await handle.writeFile(ciphertext);
            await handle.sync();
        } finally {
            await handle.close();
        }
        bundleIdentity = await exactPrivateFile(bundlePath, 0o600);
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
            unlinkIdentity(bundlePath, bundleIdentity),
            unlinkIdentity(keyPath, keyIdentity),
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

function assertSafeTerminalLine(raw: string | undefined): string {
    if (!raw) throw new Error('ANALYSIS_V2_REPLAY_JOB_REPORT_MISSING');
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    if (
        !parsed
        || typeof parsed !== 'object'
        || Array.isArray(parsed)
        || (parsed as { status?: unknown }).status !== 'ok'
        || Object.keys(parsed).some(key => !SAFE_REPORT_KEYS.has(key))
    ) {
        throw new Error('ANALYSIS_V2_REPLAY_JOB_UNSAFE_OUTPUT');
    }
    return raw;
}

interface ReplayAnalysisV2JobDependencies {
    env?: Record<string, string | undefined>;
    loadArtifacts?: (
        config: ReplayAnalysisV2JobConfig,
        gcs: ReplayJobGcsClient,
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
    installSignalCleanup?: typeof installReplayArtifactSignalCleanup;
    writeStdout?: (line: string) => void;
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
    const loaded = await (
        dependencies.loadArtifacts ?? loadReplayAnalysisV2JobArtifacts
    )(config, gcs);
    const uninstallSignals = (
        dependencies.installSignalCleanup
            ?? installReplayArtifactSignalCleanup
    )({ cleanup: loaded.cleanup });
    let terminalLine: string | undefined;
    try {
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
        terminalLine = assertSafeTerminalLine(terminalLine);
        await gcs.createReport(terminalLine);
    } finally {
        uninstallSignals();
        await loaded.cleanup();
    }
    (dependencies.writeStdout ?? (line => process.stdout.write(line)))(
        `${terminalLine}\n`,
    );
}

function isDirectExecution(): boolean {
    return Boolean(process.argv[1])
        && import.meta.url === pathToFileURL(process.argv[1]!).href;
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
