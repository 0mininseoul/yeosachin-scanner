import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
    close as closeDescriptor,
    closeSync,
    constants as fileConstants,
    fstatSync,
    fsync as syncDescriptor,
    lstatSync,
    openSync,
    realpathSync,
    write as writeDescriptor,
} from 'node:fs';
import {
    link,
    lstat,
    realpath,
    rename,
    unlink,
} from 'node:fs/promises';
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
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V213_CAPABILITY,
    HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V214_CAPABILITY,
} from '../lib/services/analysis/replay/replay-source-lineage';
import {
    parseDiagnosticPartialCoverageCliCapability,
} from '../lib/services/analysis/replay/diagnostic-partial-coverage-capability';
export {
    validateReplayAnalysisV2JobTerminalLine,
} from '../lib/services/analysis/replay/replay-job-report-contract';
import {
    validateReplayAnalysisV2JobTerminalLine,
} from '../lib/services/analysis/replay/replay-job-report-contract';

const V213_EVALUATION = Object.freeze({
    capability: HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V213_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.13' as const,
});
export const V214_EVALUATION = Object.freeze({
    capability: HISTORICAL_PARTIAL_AVAILABLE_REPLAY_V214_CAPABILITY,
    aiStage: 'ai-stage-policy-v2.14' as const,
});
type FeatureShadowEvaluation = typeof V213_EVALUATION | typeof V214_EVALUATION;
declare const __ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST__: string;
const BUILT_IMAGE_DIGEST = typeof __ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST__
    === 'string'
    ? __ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST__
    : undefined;
const IMMUTABLE_IMAGE_DIGEST =
    /^[a-z0-9][a-z0-9._-]*(?:[./][a-z0-9][a-z0-9._-]*)+@sha256:[a-f0-9]{64}$/;

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
    runtimeImageDigest: string | undefined = BUILT_IMAGE_DIGEST,
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
    const expectedImageDigest = required(
        env,
        'ANALYSIS_V2_REPLAY_JOB_EXPECTED_IMAGE_DIGEST',
    );
    if (
        !IMMUTABLE_IMAGE_DIGEST.test(expectedImageDigest)
        || !runtimeImageDigest
        || !IMMUTABLE_IMAGE_DIGEST.test(runtimeImageDigest)
        || runtimeImageDigest !== expectedImageDigest
    ) {
        throw new Error(
            'ANALYSIS_V2_REPLAY_JOB_IMAGE_DIGEST_MISMATCH',
        );
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

async function writeReplayJobArtifact(
    descriptor: number,
    bytes: Buffer,
): Promise<void> {
    let offset = 0;
    while (offset < bytes.byteLength) {
        const written = await new Promise<number>((resolveWrite, rejectWrite) => {
            writeDescriptor(
                descriptor,
                bytes,
                offset,
                bytes.byteLength - offset,
                null,
                (error, count) => {
                    if (error) rejectWrite(error);
                    else resolveWrite(count);
                },
            );
        });
        if (written <= 0) {
            throw new Error('ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_INVALID');
        }
        offset += written;
    }
    await new Promise<void>((resolveSync, rejectSync) => {
        syncDescriptor(descriptor, error => {
            if (error) rejectSync(error);
            else resolveSync();
        });
    });
}

function closeReplayJobArtifact(descriptor: number): Promise<void> {
    return new Promise<void>((resolveClose, rejectClose) => {
        closeDescriptor(descriptor, error => {
            if (error) rejectClose(error);
            else resolveClose();
        });
    });
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
        const descriptor = openSync(
            bundlePath,
            fileConstants.O_WRONLY
                | fileConstants.O_CREAT
                | fileConstants.O_EXCL,
            0o600,
        );
        let ownershipRegistered = false;
        try {
            const opened = fstatSync(descriptor);
            bundleIdentity = {
                device: opened.dev,
                inode: opened.ino,
            };
            ownershipRegistered = true;
            if (
                !opened.isFile()
                || (opened.mode & 0o777) !== 0o600
            ) {
                throw new Error(
                    'ANALYSIS_V2_REPLAY_JOB_LOCAL_ARTIFACT_INVALID',
                );
            }
            await writeReplayJobArtifact(descriptor, ciphertext);
        } finally {
            if (ownershipRegistered) {
                await closeReplayJobArtifact(descriptor);
            } else {
                closeSync(descriptor);
            }
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

function authenticatedFeatureShadowBundle(
    value: unknown,
    evaluation: FeatureShadowEvaluation,
): AnalysisV2ReplayBundle {
    const candidate = value as AnalysisV2ReplayBundle & { expired?: unknown };
    const { expired, ...withoutExpiry } = candidate;
    const bundle = withoutExpiry as AnalysisV2ReplayBundle;
    const policy = bundle?.capture?.evaluationPolicy;
    const lineage = bundle?.capture?.sourceLineage;
    if (
        bundle?.schemaVersion !== 2
        || expired !== false
        || bundle.capture.scope !== 'ai-only-historical-partial-available'
        || policy?.capability !== evaluation.capability
        || policy.aiStage !== evaluation.aiStage
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


interface ReplayAnalysisV2JobDependencies {
    env?: Record<string, string | undefined>;
    runtimeImageDigest?: string;
    loadArtifacts?: (
        config: ReplayAnalysisV2JobConfig,
        gcs: ReplayJobGcsClient,
        registerSignalCleanup: (cleanup: () => Promise<void>) => void,
    ) => Promise<{ bundle: unknown; cleanup: () => Promise<void> }>;
    createGcsClient?: (
        config: ReplayAnalysisV2JobConfig,
    ) => ReplayJobGcsClient;
    createRunner?: (policy: FeatureShadowEvaluation['aiStage']) => unknown;
    runReplay?: (input: {
        bundle: AnalysisV2ReplayBundle;
        runner: unknown;
        mode: 'paid-ai';
        paidAiOptIn: true;
        evaluationPolicy: FeatureShadowEvaluation;
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
    evaluation: FeatureShadowEvaluation = V213_EVALUATION,
): Promise<void> {
    const config = validateReplayAnalysisV2JobEnvironment(
        dependencies.env ?? process.env,
        dependencies.runtimeImageDigest,
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
        const bundle = authenticatedFeatureShadowBundle(loaded.bundle, evaluation);
        await gcs.createClaim(JSON.stringify({
            status: 'claimed',
            schema: 'analysis-v2-replay-job-claim-v1',
        }));
        const runner = (
            dependencies.createRunner
                ?? (policy => createReplayStagedAiAdapter(policy))
        )(evaluation.aiStage);
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
                evaluationPolicy: evaluation,
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
