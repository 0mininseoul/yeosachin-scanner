import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
    canonicalDigest,
    canonicalIamBindingDigests,
    canonicalIamPolicyDigest,
    canonicalQueueConfiguration,
    canonicalRuntimeInputDigest,
    CLOUD_LOG_ID_PATTERN,
    EpochError,
    epochFail,
    isObject,
    isBuildArgumentValue,
    isSha,
    PROJECT_ID_PATTERN,
    ROLES,
    SLOTS,
    type CapacityManifest,
    type ProtectedBuildInput,
    type ProtectedIamBinding,
    type ProtectedIamInputs,
    type ProtectedIamInput,
    type ProtectedIamPolicySnapshot,
    type ProtectedIdentity,
    type ProtectedObservationTargets,
    type ProtectedOldObservations,
    type ProtectedPlatformInputs,
    type ProtectedProviderScope,
    type ProtectedQueueInput,
    type ProtectedRetentionInput,
    type ProtectedRuntimeInput,
    type ProtectedSchedulerInput,
    type ReadinessContract,
    type Role,
    type Slot,
    type RuntimeSettings,
} from './contracts';
import {
    captureSupabaseServiceRoleKey,
    createOwnerProtectedTransports,
    loadOwnerAuthBoundary,
    readOwnerBoundedFile,
    type OwnerAuthBoundary,
    type OwnerProtectedTransports,
} from './owner-auth';
import {
    collectFullyPaged,
    normalizePageToken,
    readExactVercelProductionEnvValues,
    type ExactVercelProductionEnvValues,
} from './owner-discovery';
import {
    deterministicIdentityForSlot,
    selectDesiredIdentityGraph,
    type DesiredIdentityGraph,
    type IdentityAccountObservation,
    type IdentityGraphObservation,
} from './owner-preparation';
import { OwnerPreparationOperator, type PreparationMutator, type PreparationObservation } from './owner-preparation-operator';
import type { OwnerDescriptorAssemblyInput } from './owner-descriptors';
import type { OwnerFdBridgeOptions } from './owner-fd-bridge';
import { CloudRunAdapter, type CloudRunRevisionObservation, type CloudRunServiceObservation } from './cloud-run';
import { createSchedulerPauseProvenanceReader } from './scheduler-pause-evidence';
import { createOwnerReadinessTransport } from './vercel-readiness';
import { IamAdapter } from './iam';
import {
    WorkPlaneClient,
    type PauseProvenance,
    type QueueObservation,
    type SchedulerObservation,
} from './work-planes';
import { AuthenticatedProtectedTransport, FetchProtectedTransport, type ProtectedTransport } from './platform';
import { CloudBuildAdapter, immutableImageReference, observedBuildMetadataDigest } from './cloud-build';
import { createStorageSourceVerifier, normalizeStorageSource, storageSourceContext, type StorageSourceVerifier } from './storage-source';
import { parsePublicReadinessJson } from '../../lib/services/analysis/public-readiness-contract';
import type { LegacyPublicReadiness } from '../../lib/services/analysis/legacy-analysis-public-readiness';
import {
    enqueuerIdentityFingerprint,
    PAID_ENQUEUER_IDENTITY_FINGERPRINT_VERSION,
    PREFLIGHT_ENQUEUER_IDENTITY_FINGERPRINT_VERSION,
} from '../../lib/services/analysis/legacy-analysis-public-readiness';
import { deriveObservationInputDigests, createProtectedPacket, deriveRetiredIamBindingDigests, type ProtectedPacketInput } from './packet';
import { evidenceSelectorDigest, LiveEvidenceCollector, type LiveZeroWorkSources } from './live-evidence';
import { rejectDuplicateJsonKeys } from './packet';
import { createFrozenGateReader } from './vercel-readiness';
import { VercelAdapter } from './vercel';

/**
 * The owner adapter is the only production construction path for the
 * preparation CLI.  It resolves local owner material and then builds all
 * provider readers from the resulting in-memory token providers; it never
 * reads dotenv or the ambient process environment.
 */

const VERCEL_HOSTS = new Set(['api.vercel.com']);
const VERCEL_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const SERVICE = /^[a-z][a-z0-9-]{0,62}$/;
const LOCATION = /^[a-z][a-z0-9-]{0,62}$/;
const QUEUE = /^[A-Za-z0-9-]{1,100}$/;
const SCHEDULER = /^[A-Za-z0-9_-]{1,500}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const SUPABASE_ORIGIN = /^https:\/\/[a-z]{20}\.supabase\.co\/$/;
const SUPABASE_ORIGIN_INPUT = /^https:\/\/[a-z]{20}\.supabase\.co\/?$/;
const SUPABASE_CLI_VERSION = '2.102.0';
const SUPABASE_CLI_LINK_TARGET = '../supabase/dist/supabase.js';
const SUPABASE_CLI_BIN_TARGET = 'dist/supabase.js';
const IMAGE = /^[^\s\u0000-\u001f\u007f]{1,2048}@sha256:[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const SAFE = /^[^\u0000-\u001f\u007f]{1,4096}$/;
const MAX_PAGES = 100;
const QUIESCENCE = Object.freeze({ timeoutMs: 60_000, graceMs: 5_000 });
const MAX_GIT_OUTPUT_BYTES = 8 * 1024;
const GIT_ENV = Object.freeze({
    PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    NODE_ENV: 'production',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
});

const ENV_KEYS = Object.freeze(new Set([
    'ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET',
    'ANALYSIS_CAPACITY_DESIRED_WORKER_IMAGE',
    'ANALYSIS_CAPACITY_LEGACY_TARGET_RESOURCE',
    'ANALYSIS_CAPACITY_TASK_AUDIT_LOG_NAME',
    'ANALYSIS_CAPACITY_TASK_AUDIT_SINK_NAME',
    'ANALYSIS_CAPACITY_TASK_AUDIT_BUCKET_RESOURCE',
    'ANALYSIS_CAPACITY_TASK_AUDIT_CORRELATION',
    'ANALYSIS_CAPACITY_SCHEDULER_AUDIT_LOG_NAME',
    'ANALYSIS_CAPACITY_SCHEDULER_AUDIT_SINK_NAME',
    'ANALYSIS_CAPACITY_SCHEDULER_AUDIT_BUCKET_RESOURCE',
    'ANALYSIS_CAPACITY_SCHEDULER_AUDIT_CORRELATION',
    'VERCEL_PRODUCER_ALIAS',
    'PREFLIGHT_TASKS_PROJECT', 'PREFLIGHT_TASKS_LOCATION', 'PREFLIGHT_TASKS_QUEUE',
    'PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL',
    'PREFLIGHT_TASKS_CLOUD_RUN_SERVICE', 'PREFLIGHT_TASKS_CLOUD_RUN_REGION',
    'PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB', 'PREFLIGHT_TASKS_MAINTENANCE_LOCATION',
    'ANALYSIS_V2_TASKS_PROJECT', 'ANALYSIS_V2_TASKS_LOCATION', 'ANALYSIS_V2_TASKS_QUEUE',
    'ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL',
    'ANALYSIS_V2_TASKS_CLOUD_RUN_SERVICE', 'ANALYSIS_V2_TASKS_CLOUD_RUN_REGION',
    'ANALYSIS_V2_RECOVERY_SCHEDULER_JOB', 'ANALYSIS_V2_MAINTENANCE_LOCATION',
    'ANALYSIS_V2_RETENTION_SCHEDULER_JOB',
    'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'NEXT_PUBLIC_SUPABASE_ANON_KEY',
]) as ReadonlySet<string>);

const SUPABASE_ENV_KEYS = new Set([
    'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
]);
// Overrides are a test/owner-session seam only. Keep the allowlist derived
// from the existing production reader and explicitly exclude every Supabase
// value, including the service-role credential.
const RESOURCE_SELECTOR_OVERRIDE_KEYS = new Set([...ENV_KEYS].filter(key => !SUPABASE_ENV_KEYS.has(key)));

type Env = Readonly<Record<string, string>>;
type RoleMap<T> = Readonly<Record<Role, T>>;

export type OwnerResourceSelectorOverrides = Readonly<Record<string, string>>;
export type OwnerDesiredDeploymentSelector = Readonly<{ id: string; sourceSha: string }>;

function fail(code: Parameters<typeof epochFail>[0]): never {
    epochFail(code);
}

function unavailable(): never {
    fail('OWNER_AUTH_UNAVAILABLE');
}

function object(value: unknown, code: 'ADAPTER_RESPONSE_INVALID' | 'EVIDENCE_UNAVAILABLE' = 'ADAPTER_RESPONSE_INVALID'): Record<string, unknown> {
    if (!isObject(value)) fail(code);
    return value;
}

function required(env: Env, key: string): string {
    const value = env[key];
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || !SAFE.test(value)) fail('EVIDENCE_UNAVAILABLE');
    return value;
}

function optional(env: Env, key: string): string | undefined {
    const value = env[key];
    if (value === undefined) return undefined;
    if (value.length === 0 || value.length > 8192 || !SAFE.test(value)) fail('EVIDENCE_UNAVAILABLE');
    return value;
}

/** Validate the narrow, non-credential in-memory selector override seam. */
export function parseOwnerResourceSelectorOverrides(value: unknown): OwnerResourceSelectorOverrides {
    if (value === undefined) return Object.freeze({});
    if (!isObject(value)) fail('ADAPTER_REQUEST_INVALID');
    const result: Record<string, string> = {};
    for (const [key, override] of Object.entries(value)) {
        if (!RESOURCE_SELECTOR_OVERRIDE_KEYS.has(key)
            || typeof override !== 'string' || override.length === 0 || !SAFE.test(override)) fail('ADAPTER_REQUEST_INVALID');
        result[key] = override;
    }
    return Object.freeze(result);
}

/** Merge only missing selector values; a readable production value wins. */
export function mergeOwnerResourceSelectorOverrides(
    productionEnv: Readonly<{ values: Readonly<Record<string, string>> }>,
    value: unknown,
): Env {
    const overrides = parseOwnerResourceSelectorOverrides(value);
    const result: Record<string, string> = { ...productionEnv.values };
    for (const [key, override] of Object.entries(overrides)) {
        const readable = productionEnv.values[key];
        if (readable !== undefined && readable !== override) fail('CAPABILITY_BINDING_MISMATCH');
        result[key] = override;
    }
    return Object.freeze(result);
}

function ownerDirectory(path: string, expectedUid: number): string {
    if (!SAFE.test(path)) unavailable();
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(path); } catch { unavailable(); }
    if (!stat.isDirectory() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) unavailable();
    return path;
}

function gitCommonDirectory(cwd: string): string {
    let raw: string;
    try {
        raw = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
            cwd,
            env: { ...GIT_ENV },
            shell: false,
            stdio: ['ignore', 'pipe', 'ignore'],
            encoding: 'utf8',
            timeout: 5_000,
            maxBuffer: MAX_GIT_OUTPUT_BYTES,
        }) as string;
    } catch { unavailable(); }
    if (!raw.endsWith('\n')) unavailable();
    const commonDirRaw = raw.slice(0, -1);
    if (commonDirRaw.length === 0 || commonDirRaw.includes('\n') || commonDirRaw.includes('\r') || !SAFE.test(commonDirRaw)) unavailable();
    const commonDir = resolve(commonDirRaw);
    if (commonDir !== commonDirRaw || !commonDir.endsWith('/.git')) unavailable();
    return commonDir;
}

/**
 * Resolve the fixed owner Supabase workdir from Git's common directory. A
 * linked worktree's own root is intentionally not used for the project-ref:
 * the owner workdir is the canonical `.worktrees/final-main-20260725`
 * worktree, and it must belong to the same repository as the current one.
 */
function primaryRepositoryRoot(cwd: string, expectedUid: number): string {
    const commonDir = gitCommonDirectory(cwd);
    ownerDirectory(dirname(commonDir), expectedUid);
    ownerDirectory(commonDir, expectedUid);
    const primary = dirname(commonDir);
    const worktreesDirectory = join(primary, '.worktrees');
    ownerDirectory(worktreesDirectory, expectedUid);
    const candidate = join(worktreesDirectory, 'final-main-20260725');
    ownerDirectory(candidate, expectedUid);
    let realCandidate: string;
    try { realCandidate = realpathSync(candidate); } catch { unavailable(); }
    ownerDirectory(realCandidate, expectedUid);
    if (gitCommonDirectory(realCandidate) !== commonDir) unavailable();
    return realCandidate;
}

export function resolvePrimaryRepositoryRootForOwner(cwd: string): string {
    if (!SAFE.test(cwd)) unavailable();
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (!Number.isSafeInteger(uid) || uid < 0) unavailable();
    return primaryRepositoryRoot(resolve(cwd), uid);
}

/** Resolve the pinned Supabase executable from the current worktree only. */
export function resolveLocalSupabaseCliPathForOwner(cwd: string): string {
    if (!SAFE.test(cwd)) unavailable();
    const currentWorktree = resolve(cwd);
    const uid = typeof process.getuid === 'function' ? process.getuid() : -1;
    if (!Number.isSafeInteger(uid) || uid < 0) unavailable();
    const nodeModules = join(currentWorktree, 'node_modules');
    const binDirectory = join(nodeModules, '.bin');
    const packageDirectory = join(nodeModules, 'supabase');
    const distributionDirectory = join(packageDirectory, 'dist');
    ownerDirectory(currentWorktree, uid);
    ownerDirectory(nodeModules, uid);
    ownerDirectory(binDirectory, uid);
    ownerDirectory(packageDirectory, uid);
    ownerDirectory(distributionDirectory, uid);
    const command = join(currentWorktree, 'node_modules', '.bin', 'supabase');
    if (!SAFE.test(command)) unavailable();
    let commandStat: ReturnType<typeof lstatSync>;
    try { commandStat = lstatSync(command); } catch { unavailable(); }
    if (!commandStat.isSymbolicLink() || commandStat.uid !== uid) unavailable();
    let linkTarget: string;
    try { linkTarget = readlinkSync(command); } catch { unavailable(); }
    if (linkTarget !== SUPABASE_CLI_LINK_TARGET) unavailable();

    const executable = join(distributionDirectory, 'supabase.js');
    let resolvedCommand: string;
    let resolvedExecutable: string;
    try { resolvedCommand = realpathSync(command); } catch { unavailable(); }
    try { resolvedExecutable = realpathSync(executable); } catch { unavailable(); }
    if (resolvedCommand !== resolvedExecutable) unavailable();
    let executableStat: ReturnType<typeof lstatSync>;
    try { executableStat = lstatSync(executable); } catch { unavailable(); }
    if (!executableStat.isFile() || executableStat.uid !== uid || (executableStat.mode & 0o022) !== 0
        || (executableStat.mode & 0o100) === 0) unavailable();

    const packageJsonPath = join(packageDirectory, 'package.json');
    const packageJson = readOwnerBoundedFile(packageJsonPath, uid);
    if (packageJson === undefined) unavailable();
    let packageValue: unknown;
    try {
        rejectDuplicateJsonKeys(packageJson);
        packageValue = JSON.parse(packageJson) as unknown;
    } catch { unavailable(); }
    if (!isObject(packageValue) || packageValue.version !== SUPABASE_CLI_VERSION
        || !isObject(packageValue.bin) || packageValue.bin.supabase !== SUPABASE_CLI_BIN_TARGET) unavailable();
    return command;
}

function project(value: string): string {
    if (!PROJECT_ID_PATTERN.test(value)) fail('PROJECT_MISMATCH');
    return value;
}

function identity(value: string, expectedProject: string): ProtectedIdentity {
    const match = ACCOUNT.exec(value);
    if (!match || match[1] !== expectedProject) fail('IDENTITY_INVALID');
    return { identity: value, project: expectedProject };
}

function parseTimestamp(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') fail('ADAPTER_RESPONSE_INVALID');
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) fail('ADAPTER_RESPONSE_INVALID');
    return parsed;
}

function originUrl(value: string): string {
    const origin = targetOrigin(value, 'ADAPTER_RESPONSE_INVALID');
    let parsed: URL;
    try { parsed = new URL(value); } catch { fail('ADAPTER_RESPONSE_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/') fail('ADAPTER_RESPONSE_INVALID');
    return origin;
}

function targetOrigin(value: string, code: 'ADAPTER_RESPONSE_INVALID' | 'SOURCE_INVALID' | 'RESOURCE_INVALID' = 'ADAPTER_RESPONSE_INVALID'): string {
    let parsed: URL;
    try { parsed = new URL(value); } catch { fail(code); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash) fail(code);
    return parsed.origin;
}

function targetUrl(value: string, path: string): string {
    let parsed: URL;
    try { parsed = new URL(value); } catch { fail('SOURCE_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== path) fail('SOURCE_INVALID');
    return parsed.toString();
}

function targetAudience(value: string, expectedOrigin: string): string {
    const origin = originUrl(value);
    if (origin !== expectedOrigin) fail('RESOURCE_INVALID');
    return origin;
}

function accountFromSlot(graph: Readonly<Record<string, ProtectedIdentity>>, slot: string): ProtectedIdentity {
    const value = graph[slot];
    if (!value) fail('IDENTITY_CONFLICT');
    return value;
}

function envForRole(role: Role): Readonly<{
    project: string;
    location: string;
    cloudRunRegion: string;
    service: string;
    queue: string;
    recoveryJob: string;
    maintenanceLocation: string;
}> {
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const projectName = `${prefix}_PROJECT`;
    const locationName = `${prefix}_LOCATION`;
    const queueName = `${prefix}_QUEUE`;
    const serviceName = `${prefix}_CLOUD_RUN_SERVICE`;
    const regionName = `${prefix}_CLOUD_RUN_REGION`;
    const recoveryName = role === 'preflight' ? 'PREFLIGHT_TASKS_RECOVERY_SCHEDULER_JOB' : 'ANALYSIS_V2_RECOVERY_SCHEDULER_JOB';
    const maintenanceName = role === 'preflight' ? 'PREFLIGHT_TASKS_MAINTENANCE_LOCATION' : 'ANALYSIS_V2_MAINTENANCE_LOCATION';
    return {
        project: projectName,
        location: locationName,
        cloudRunRegion: regionName,
        service: serviceName,
        queue: queueName,
        recoveryJob: recoveryName,
        maintenanceLocation: maintenanceName,
    };
}

function readRoleSelector(env: Env, role: Role): Readonly<{
    project: string;
    location: string;
    cloudRunRegion: string;
    service: string;
    queue?: string;
    recoveryJob: string;
    maintenanceLocation: string;
}> {
    const names = envForRole(role);
    const queue = role === 'paid' ? optional(env, names.queue) : required(env, names.queue);
    const result = {
        project: project(required(env, names.project)),
        location: required(env, names.location),
        cloudRunRegion: required(env, names.cloudRunRegion),
        service: required(env, names.service),
        recoveryJob: required(env, names.recoveryJob),
        maintenanceLocation: required(env, names.maintenanceLocation),
        ...(queue === undefined ? {} : { queue }),
    };
    if (!LOCATION.test(result.location) || !LOCATION.test(result.cloudRunRegion) || !SERVICE.test(result.service)
        || !SCHEDULER.test(result.recoveryJob) || !LOCATION.test(result.maintenanceLocation)) fail('ADAPTER_REQUEST_INVALID');
    if (result.queue !== undefined && !QUEUE.test(result.queue)) fail('ADAPTER_REQUEST_INVALID');
    return result;
}

type RoleSelector = ReturnType<typeof readRoleSelector>;
type BoundRoleSelector = RoleSelector & Readonly<{ queue: string }>;

function serviceResource(selector: RoleSelector): string {
    return `projects/${selector.project}/locations/${selector.cloudRunRegion}/services/${selector.service}`;
}

function schedulerResource(role: Role, selector: RoleSelector): string {
    return `projects/${selector.project}/locations/${selector.maintenanceLocation}/jobs/${selector.recoveryJob}`;
}

function roleResource(role: Role, selector: BoundRoleSelector): Readonly<{
    service: string;
    queue: string;
    scheduler: string;
}> {
    return {
        service: serviceResource(selector),
        queue: `projects/${selector.project}/locations/${selector.location}/queues/${selector.queue}`,
        scheduler: schedulerResource(role, selector),
    };
}

/**
 * Resolve the queue only after the exact project/region/service Cloud Run
 * observation has been authenticated. Any readable Vercel queue selector is
 * a cross-check, never an authority for selecting the resource.
 */
export function resolveRoleSelectorFromCloudRun(input: Readonly<{
    role: Role;
    selector: RoleSelector;
    runtime: Readonly<Pick<CloudRunServiceObservation, 'resource' | 'project' | 'location' | 'service' | 'environment'>>;
}>): BoundRoleSelector {
    const prefix = input.role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const runtimeProject = input.runtime.environment[`${prefix}_PROJECT`];
    const runtimeLocation = input.runtime.environment[`${prefix}_LOCATION`];
    const runtimeQueue = input.runtime.environment[`${prefix}_QUEUE`];
    if ((input.role !== 'paid' && input.selector.queue === undefined)
        || input.runtime.resource !== serviceResource(input.selector)
        || input.runtime.project !== input.selector.project
        || input.runtime.location !== input.selector.cloudRunRegion
        || input.runtime.service !== input.selector.service
        || runtimeProject !== input.selector.project
        || runtimeLocation !== input.selector.location
        || typeof runtimeQueue !== 'string' || !QUEUE.test(runtimeQueue)
        || (input.selector.queue !== undefined && input.selector.queue !== runtimeQueue)) fail('CAPABILITY_BINDING_MISMATCH');
    return Object.freeze({ ...input.selector, queue: runtimeQueue });
}

function requireProjectAgreement(selectors: RoleMap<ReturnType<typeof readRoleSelector>>): string {
    const projects = new Set(ROLES.map(role => selectors[role].project));
    if (projects.size !== 1) fail('PROJECT_MISMATCH');
    return [...projects][0]!;
}

function localCredentialPath(cwd = process.cwd()): Readonly<{ linkedMetadataPath: string; credentialStorePath: string; cwd: string; supabaseWorkdir: string; supabaseCliPath: string }> {
    if (!SAFE.test(cwd)) unavailable();
    const currentWorktree = resolve(cwd);
    let linkedMetadataPath: string | undefined;
    for (let directory = currentWorktree;; directory = dirname(directory)) {
        const projectPath = join(directory, '.vercel', 'project.json');
        const repoPath = join(directory, '.vercel', 'repo.json');
        try {
            if (lstatSync(projectPath).isFile()) {
                linkedMetadataPath = projectPath;
                break;
            }
        } catch { /* try the repository link below */ }
        try {
            if (lstatSync(repoPath).isFile()) {
                linkedMetadataPath = repoPath;
                break;
            }
        } catch { /* continue to the next worktree ancestor */ }
        const parent = dirname(directory);
        if (parent === directory) break;
        try {
            if (lstatSync(join(directory, '.git')).isFile() || lstatSync(join(directory, '.git')).isDirectory()) break;
        } catch { /* a repository root marker is optional for test seams */ }
    }
    // Keep the legacy path as the failure target when no link is present; the
    // owner boundary still performs the strict lstat/uid/mode validation.
    linkedMetadataPath ??= resolve(currentWorktree, '.vercel', 'project.json');
    const candidates = [
        join(homedir(), '.local', 'share', 'com.vercel.cli', 'auth.json'),
        join(homedir(), 'Library', 'Application Support', 'com.vercel.cli', 'auth.json'),
        join(homedir(), '.config', 'com.vercel.cli', 'auth.json'),
    ];
    const existing = candidates.filter(candidate => {
        try { return lstatSync(candidate).isFile(); } catch { return false; }
    });
    if (existing.length !== 1) unavailable();
    const primaryRoot = resolvePrimaryRepositoryRootForOwner(currentWorktree);
    return {
        linkedMetadataPath,
        credentialStorePath: existing[0]!,
        cwd: currentWorktree,
        supabaseWorkdir: primaryRoot,
        supabaseCliPath: resolveLocalSupabaseCliPathForOwner(currentWorktree),
    };
}

async function readProductionEnv(transport: AuthenticatedProtectedTransport, auth: OwnerAuthBoundary): Promise<ExactVercelProductionEnvValues> {
    return readExactVercelProductionEnvValues({
        transport,
        projectId: auth.vercelProjectId,
        teamId: auth.vercelTeamId,
        allowedKeys: ENV_KEYS,
    });
}

type VercelDeploymentInventoryRecord = Readonly<{
    id: string;
    readyState: string;
    createdAt: number;
}>;

type DeploymentRecord = Readonly<{
    id: string;
    readyState: string;
    createdAt: number;
    origin: string;
    sourceSha: string;
}>;

/**
 * The v6 endpoint is an inventory source only. Its rows are intentionally
 * parsed without URL or Git fields; immutable source proof comes from the
 * exact v13 detail read for the selected deployment.
 */
export function parseVercelDeploymentInventory(value: unknown): VercelDeploymentInventoryRecord {
    const deployment = object(value);
    const id = deployment.uid ?? deployment.id;
    const readyState = deployment.readyState;
    const createdAt = deployment.createdAt;
    if (typeof id !== 'string' || !VERCEL_ID.test(id) || typeof readyState !== 'string'
        || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0) fail('ADAPTER_RESPONSE_INVALID');
    return { id, readyState, createdAt };
}

export async function readVercelDeployments(transport: AuthenticatedProtectedTransport, projectId: string, teamId: string): Promise<readonly VercelDeploymentInventoryRecord[]> {
    const path = '/v6/deployments';
    const rows = await collectFullyPaged({
        readPage: async (until) => {
            const query = new URLSearchParams({ projectId, teamId, target: 'production', limit: '100' });
            if (until !== undefined) query.set('until', until);
            const { value } = await transport.json({
                method: 'GET', url: `https://api.vercel.com${path}?${query.toString()}`,
                allowedHosts: VERCEL_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['GET'],
                allowedQueryKeys: until === undefined ? ['limit', 'projectId', 'target', 'teamId'] : ['limit', 'projectId', 'target', 'teamId', 'until'], acceptedStatuses: [200],
            });
            const body = object(value);
            if (!Array.isArray(body.deployments)) fail('ADAPTER_RESPONSE_INVALID');
            const pagination = object(body.pagination ?? {});
            const next = normalizePageToken(pagination.next);
            return { items: body.deployments, ...(next === undefined ? {} : { nextPageToken: next }) };
        },
    });
    return Object.freeze(rows.map(parseVercelDeploymentInventory));
}

/*
 * Keep the existing bounded inventory selection rule in this compatibility
 * seam. A reviewed exact desired deployment/SHA selector is a separate
 * integration change; this function must not infer one from detail metadata.
 */
export function selectDeployment(rows: readonly VercelDeploymentInventoryRecord[], oldId: string): VercelDeploymentInventoryRecord {
    const candidates = rows.filter(row => row.readyState === 'READY' && row.id !== oldId);
    if (candidates.length === 0) fail('DISCOVERY_AMBIGUOUS');
    const max = Math.max(...candidates.map(row => row.createdAt));
    const latest = candidates.filter(row => row.createdAt === max);
    if (latest.length !== 1) fail('DISCOVERY_AMBIGUOUS');
    return latest[0]!;
}

async function readCurrentAlias(transport: AuthenticatedProtectedTransport, alias: string, projectId: string, teamId: string): Promise<string> {
    const path = `/v4/aliases/${encodeURIComponent(alias)}`;
    const { value } = await transport.json({
        method: 'GET', url: `https://api.vercel.com${path}?teamId=${encodeURIComponent(teamId)}`,
        allowedHosts: VERCEL_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: ['teamId'], acceptedStatuses: [200],
    });
    const row = object(value);
    if (row.alias !== alias || row.projectId !== projectId || typeof row.deploymentId !== 'string' || !VERCEL_ID.test(row.deploymentId)) fail('ADAPTER_RESPONSE_INVALID');
    return row.deploymentId;
}

/** Parse only the exact v13 deployment detail, including native Git SHA proof. */
export function parseVercelDeploymentDetail(value: unknown, projectId: string, teamId: string, deploymentId: string): DeploymentRecord {
    const row = object(value);
    const projectValue = object(row.project);
    const teamValue = object(row.team);
    const gitSource = object(row.gitSource ?? {});
    const url = row.url;
    const createdAt = row.createdAt;
    if (createdAt !== undefined && (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt < 0)) fail('ADAPTER_RESPONSE_INVALID');
    if (row.id !== deploymentId || projectValue.id !== projectId || teamValue.id !== teamId || row.readyState !== 'READY'
        || typeof url !== 'string' || typeof gitSource.sha !== 'string' || !SHA.test(gitSource.sha)) fail('ADAPTER_RESPONSE_INVALID');
    return { id: deploymentId, readyState: 'READY', createdAt: typeof createdAt === 'number' ? createdAt : 0, origin: originUrl(`https://${url}`), sourceSha: gitSource.sha };
}

export function parseOwnerDesiredDeploymentSelector(value: unknown): OwnerDesiredDeploymentSelector | undefined {
    if (value === undefined) return undefined;
    if (!isObject(value)
        || !Object.keys(value).every(key => key === 'id' || key === 'sourceSha')
        || typeof value.id !== 'string' || !VERCEL_ID.test(value.id)
        || typeof value.sourceSha !== 'string' || !SHA.test(value.sourceSha)) fail('ADAPTER_REQUEST_INVALID');
    return Object.freeze({ id: value.id, sourceSha: value.sourceSha });
}

/** Bind an explicit desired selector to the native Vercel detail response. */
export function assertOwnerDesiredDeployment(
    expected: OwnerDesiredDeploymentSelector,
    observed: DeploymentRecord,
): DeploymentRecord {
    if (observed.id !== expected.id || observed.sourceSha !== expected.sourceSha) fail('SOURCE_INVALID');
    return observed;
}

export async function readVercelDeployment(transport: AuthenticatedProtectedTransport, projectId: string, teamId: string, deploymentId: string): Promise<DeploymentRecord> {
    const path = `/v13/deployments/${encodeURIComponent(deploymentId)}`;
    const { value } = await transport.json({
        method: 'GET', url: `https://api.vercel.com${path}?withGitRepoInfo=true&teamId=${encodeURIComponent(teamId)}`,
        allowedHosts: VERCEL_HOSTS, allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: ['teamId', 'withGitRepoInfo'], acceptedStatuses: [200],
    });
    return parseVercelDeploymentDetail(value, projectId, teamId, deploymentId);
}

async function readPublicReadiness(url: string, expectedSourceSha: string, publicTransport: ProtectedTransport): Promise<Readonly<{ dto: LegacyPublicReadiness; contract: ReadinessContract }>> {
    let parsed: URL;
    try { parsed = new URL(url); } catch { fail('ADAPTER_REQUEST_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || parsed.pathname !== '/api/analysis/capacity/readiness') fail('ADAPTER_NOT_ALLOWED');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Awaited<ReturnType<ProtectedTransport['request']>>;
    try {
        response = await publicTransport.request({ method: 'GET', url: parsed.toString(), headers: { accept: 'application/json' } }, controller.signal);
    } catch (error) {
        if (error instanceof Error && error.name === 'EpochError') throw error;
        fail('ADAPTER_TIMEOUT');
    } finally {
        clearTimeout(timer);
    }
    if (response.status !== 200) fail('READINESS_INVALID');
    let dto: LegacyPublicReadiness;
    try { dto = parsePublicReadinessJson(response.body); } catch { fail('READINESS_INVALID'); }
    if (!dto.ready || dto.sourceSha !== expectedSourceSha || dto.legacyTargetResource === null
        || dto.preflightProducerConfigFingerprint === null || dto.paidProducerConfigFingerprint === null
        || dto.analysisV2AdmissionEnabled || dto.earlybirdWebhookAutoAdmissionEnabled) fail('READINESS_INVALID');
    return {
        dto,
        contract: {
            schemaVersion: dto.schemaVersion,
            sourceSha: expectedSourceSha,
            legacyTargetResource: dto.legacyTargetResource,
            preflightFingerprint: dto.preflightProducerConfigFingerprint,
            paidFingerprint: dto.paidProducerConfigFingerprint,
            analysisV2AdmissionEnabled: dto.analysisV2AdmissionEnabled,
            earlybirdWebhookAutoAdmissionEnabled: dto.earlybirdWebhookAutoAdmissionEnabled,
        },
    };
}

type BuildCandidate = Readonly<{
    raw: Readonly<Record<string, unknown>>;
    images: readonly string[];
}>;
type BuildRecord = BuildCandidate & Readonly<{ input: ProtectedBuildInput }>;

async function buildSource(raw: Record<string, unknown>, reviewedSha: string, verifyStorage: StorageSourceVerifier): Promise<Readonly<{ sha: string; context: string }>> {
    const provenance = object(raw.sourceProvenance);
    const repo = isObject(provenance.resolvedRepoSource) ? provenance.resolvedRepoSource : undefined;
    const storage = normalizeStorageSource(provenance.resolvedStorageSource);
    if (!SHA.test(reviewedSha) || (repo !== undefined && storage !== null)) fail('SOURCE_INVALID');
    if (storage !== null) {
        const proof = await verifyStorage({ source: storage, reviewedSha });
        if (!proof || proof.reviewedSha !== reviewedSha || proof.sourceContext !== storageSourceContext(storage)
            || proof.sourceBucket !== storage.bucket || proof.sourceObject !== storage.object
            || proof.sourceGeneration !== storage.generation || !/^[0-9a-f]{64}$/.test(proof.archiveSha256)) fail('SOURCE_INVALID');
        return { sha: proof.reviewedSha, context: proof.sourceContext };
    }
    const sha = repo?.commitSha ?? repo?.revision;
    if (sha !== reviewedSha) fail('SOURCE_INVALID');
    const context = repo?.repoName ?? repo?.url ?? repo?.dir;
    if (typeof context !== 'string' || !SAFE.test(context)) fail('SOURCE_INVALID');
    return { sha, context };
}

function buildArguments(raw: Record<string, unknown>): Readonly<Record<string, string>> {
    const substitutions = object(raw.substitutions);
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(substitutions)) {
        if (!key.startsWith('_')) continue;
        if (!isBuildArgumentValue(value)) fail('SOURCE_INVALID');
        result[key.slice(1)] = value;
    }
    return Object.freeze(result);
}

function buildImages(raw: Record<string, unknown>): readonly string[] {
    const results = object(raw.results);
    if (!Array.isArray(results.images)) fail('SOURCE_INVALID');
    return Object.freeze(results.images.map(item => {
        const image = object(item);
        if (typeof image.name !== 'string' || typeof image.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(image.digest)) fail('SOURCE_INVALID');
        const full = `${image.name}@${image.digest}`;
        if (!IMAGE.test(full)) fail('SOURCE_INVALID');
        return full;
    }));
}

async function buildInput(raw: Record<string, unknown>, expectedProject: string, reviewedSha: string, verifyStorage: StorageSourceVerifier): Promise<ProtectedBuildInput> {
    const rawServiceAccount = raw.serviceAccount;
    if (typeof rawServiceAccount !== 'string') fail('SOURCE_INVALID');
    // Cloud Build returns this field as the canonical resource name in the
    // REST API (`projects/{project}/serviceAccounts/{account}`), while the
    // existing protected build contract carries the email identity. Accept
    // the resource form only when its project is exact; unique-id forms are
    // intentionally rejected because resolving them would require a second,
    // ambiguous account lookup.
    let serviceAccount = rawServiceAccount;
    if (rawServiceAccount.startsWith('projects/')) {
        const match = /^projects\/([^/]+)\/serviceAccounts\/([^/]+)$/.exec(rawServiceAccount);
        if (!match) fail('SOURCE_INVALID');
        if (match[1] !== expectedProject) fail('PROJECT_MISMATCH');
        serviceAccount = match[2]!;
    }
    const accountDomain = serviceAccount.includes('@') ? serviceAccount.slice(serviceAccount.indexOf('@') + 1) : '';
    const accountProject = accountDomain.endsWith('.iam.gserviceaccount.com')
        ? accountDomain.slice(0, -'.iam.gserviceaccount.com'.length)
        : '';
    if (accountProject !== '' && accountProject !== expectedProject) fail('PROJECT_MISMATCH');
    const buildIdentity = identity(serviceAccount, expectedProject);
    const argumentsValue = buildArguments(raw);
    const source = await buildSource(raw, reviewedSha, verifyStorage);
    return {
        identity: buildIdentity,
        sourceSha: source.sha,
        sourceContext: source.context,
        buildArguments: argumentsValue,
    };
}

async function readBuilds(google: AuthenticatedProtectedTransport, projectId: string, location: string): Promise<readonly BuildCandidate[]> {
    if (!PROJECT_ID_PATTERN.test(projectId) || !LOCATION.test(location)) fail('ADAPTER_REQUEST_INVALID');
    const path = `/v1/projects/${encodeURIComponent(projectId)}/locations/${encodeURIComponent(location)}/builds`;
    const rows = await collectFullyPaged({
        readPage: async (pageToken) => {
            const query = new URLSearchParams({ filter: 'status="SUCCESS"', pageSize: '100' });
            if (pageToken !== undefined) query.set('pageToken', pageToken);
            const { value } = await google.json({
                method: 'GET', url: `https://cloudbuild.googleapis.com${path}?${query.toString()}`,
                allowedHosts: new Set(['cloudbuild.googleapis.com']), allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: pageToken === undefined ? ['filter', 'pageSize'] : ['filter', 'pageSize', 'pageToken'], acceptedStatuses: [200],
            });
            const body = object(value);
            if (body.builds !== undefined && !Array.isArray(body.builds)) fail('ADAPTER_RESPONSE_INVALID');
            const next = body.nextPageToken;
            if (next !== undefined && typeof next !== 'string') fail('PAGINATION_INCOMPLETE');
            return { items: (body.builds ?? []) as unknown[], ...(typeof next === 'string' && next.length > 0 ? { nextPageToken: next } : {}) };
        },
    });
    const result: BuildCandidate[] = [];
    for (const value of rows) {
        const raw = object(value);
        if (raw.status !== 'SUCCESS') continue;
        // Only image metadata is needed to narrow this historical inventory.
        // Validate identity and source after exact image selection, so no
        // unrelated source archive is downloaded during discovery.
        try {
            result.push(Object.freeze({ raw, images: buildImages(raw) }));
        } catch (error) {
            if (error instanceof EpochError && error.code === 'PROJECT_MISMATCH') throw error;
        }
    }
    return Object.freeze(result);
}

export async function resolveOwnerBuildForImage(records: readonly BuildCandidate[], sourceSha: string, image: string, project: string, verifyStorage: StorageSourceVerifier): Promise<BuildRecord> {
    if (!SHA.test(sourceSha) || !IMAGE.test(image)) fail('SOURCE_INVALID');
    // Select the exact immutable image before downloading any source archive.
    // An image selector narrows discovery; only content proof establishes SHA.
    const candidates = records.filter(record => record.images.includes(image));
    if (candidates.length !== 1) fail('DISCOVERY_AMBIGUOUS');
    const candidate = candidates[0]!;
    return Object.freeze({ ...candidate, input: await buildInput(candidate.raw, project, sourceSha, verifyStorage) });
}

async function selectUniqueBuildForSource(records: readonly BuildCandidate[], sourceSha: string, selectedImage: string | undefined, project: string, verifyStorage: StorageSourceVerifier): Promise<Readonly<{ build: BuildRecord; image: string }>> {
    if (!SHA.test(sourceSha)) fail('SOURCE_INVALID');
    if (selectedImage !== undefined) return { build: await resolveOwnerBuildForImage(records, sourceSha, selectedImage, project, verifyStorage), image: selectedImage };
    // Repo-backed builds remain discoverable by provider commit SHA. Uploaded
    // sources need a reviewed immutable image anchor, never a latest-build guess.
    const candidates = records.filter(record => {
        const provenance = record.raw.sourceProvenance;
        if (!isObject(provenance) || !isObject(provenance.resolvedRepoSource)) return false;
        return (provenance.resolvedRepoSource.commitSha ?? provenance.resolvedRepoSource.revision) === sourceSha;
    });
    if (candidates.length !== 1 || candidates[0]!.images.length !== 1) fail('DISCOVERY_AMBIGUOUS');
    const image = candidates[0]!.images[0]!;
    return { build: await resolveOwnerBuildForImage(candidates, sourceSha, image, project, verifyStorage), image };
}

function assertSameBuild(left: BuildRecord, right: BuildRecord): void {
    if (canonicalDigest(left.input) !== canonicalDigest(right.input)) fail('SOURCE_INVALID');
}

function runtimeEnvironment(old: CloudRunServiceObservation, role: Role, selector: BoundRoleSelector, desired: Readonly<Record<string, ProtectedIdentity>>, schedulerTarget: Readonly<{ audience: string }>, queueTarget: Readonly<{ url: string; audience: string }>): Readonly<Record<string, string>> {
    if (old.environment.ANALYSIS_PROVIDER_ADMISSION_ENABLED !== 'true') fail('SOURCE_INVALID');
    const env = { ...old.environment };
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const maintenancePrefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2';
    env[`${prefix}_PROJECT`] = selector.project;
    env[`${prefix}_LOCATION`] = selector.location;
    env[`${prefix}_QUEUE`] = selector.queue;
    env[`${prefix}_TARGET_URL`] = queueTarget.url;
    env[`${prefix}_OIDC_AUDIENCE`] = queueTarget.audience;
    env[`${prefix}_SERVICE_ACCOUNT_EMAIL`] = desired[`${role}.task-caller`].identity;
    if (`${prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL` in env) env[`${prefix}_ENQUEUER_SERVICE_ACCOUNT_EMAIL`] = desired[`${role}.enqueuer`].identity;
    const runtimeKey = role === 'preflight' ? 'PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL' : 'ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL';
    if (runtimeKey in env) env[runtimeKey] = desired[`${role}.runtime`].identity;
    env[`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL`] = desired[`${role}.maintenance`].identity;
    env[`${maintenancePrefix}_MAINTENANCE_OIDC_AUDIENCE`] = schedulerTarget.audience;
    return Object.freeze(env);
}

function roleTargetFromEnvironment(environment: Readonly<Record<string, string>>, role: Role): Readonly<{ url: string; audience: string }> {
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const path = role === 'preflight' ? '/api/analysis/preflight/worker' : '/api/analysis/v2/worker';
    const rawUrl = environment[`${prefix}_TARGET_URL`];
    const rawAudience = environment[`${prefix}_OIDC_AUDIENCE`];
    if (typeof rawUrl !== 'string' || typeof rawAudience !== 'string') fail('SOURCE_INVALID');
    const audience = targetAudience(rawAudience, targetOrigin(rawUrl, 'SOURCE_INVALID'));
    return { url: targetUrl(rawUrl, path), audience };
}

function maintenanceTargetFromEnvironment(environment: Readonly<Record<string, string>>, role: Role): Readonly<{ identity: ProtectedIdentity; audience: string }> {
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2';
    const identityValue = environment[`${prefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL`];
    const audienceValue = environment[`${prefix}_MAINTENANCE_OIDC_AUDIENCE`];
    if (typeof identityValue !== 'string' || typeof audienceValue !== 'string') fail('SOURCE_INVALID');
    const projectValue = environment[role === 'preflight' ? 'PREFLIGHT_TASKS_PROJECT' : 'ANALYSIS_V2_TASKS_PROJECT'];
    if (typeof projectValue !== 'string') fail('SOURCE_INVALID');
    const expectedIdentity = identity(identityValue, projectValue);
    const audience = targetAudience(audienceValue, targetOrigin(audienceValue, 'SOURCE_INVALID'));
    return { identity: expectedIdentity, audience };
}

function recoveryTargetFromWire(raw: Record<string, unknown>, projectId: string): Readonly<{ uri: string; audience: string; identity: ProtectedIdentity }> {
    const httpTarget = object(raw.httpTarget);
    if (typeof httpTarget.uri !== 'string') fail('ADAPTER_RESPONSE_INVALID');
    const uri = targetUrlAllowQuery(httpTarget.uri);
    const oidc = object(httpTarget.oidcToken);
    if (typeof oidc.serviceAccountEmail !== 'string' || typeof oidc.audience !== 'string') fail('ADAPTER_RESPONSE_INVALID');
    const id = identity(oidc.serviceAccountEmail, projectId);
    const audience = targetAudience(oidc.audience, targetOrigin(uri));
    return { uri, audience, identity: id };
}

function targetUrlAllowQuery(value: string): string {
    let parsed: URL;
    try { parsed = new URL(value); } catch { fail('ADAPTER_RESPONSE_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) fail('ADAPTER_RESPONSE_INVALID');
    return parsed.toString();
}

function queueConfigurationFromWire(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
    if (raw.appEngineRoutingOverride !== undefined) fail('RESOURCE_INVALID');
    const result: Record<string, unknown> = {};
    for (const key of ['rateLimits', 'retryConfig', 'stackdriverLoggingConfig', 'appEngineHttpTarget']) if (raw[key] !== undefined) result[key] = raw[key];
    if (raw.httpTarget !== undefined) {
        const target = object(raw.httpTarget);
        const stable = { ...target };
        delete stable.oidcToken;
        delete stable.uri;
        result.httpTarget = stable;
    }
    return Object.freeze(result);
}

function schedulerConfigurationFromWire(raw: Record<string, unknown>): Readonly<Record<string, unknown>> {
    const result: Record<string, unknown> = {};
    for (const key of ['schedule', 'timeZone', 'retryConfig', 'attemptDeadline', 'pubsubTarget', 'appEngineHttpTarget']) if (raw[key] !== undefined) result[key] = raw[key];
    const target = isObject(raw.httpTarget) ? { ...raw.httpTarget } : undefined;
    if (target && typeof target.httpMethod === 'string') result.method = target.httpMethod;
    if (target) {
        delete target.uri;
        delete target.oidcToken;
        if (Object.keys(target).length > 0) result.httpTarget = target;
    }
    if (Object.keys(result).length === 0) fail('RESOURCE_INVALID');
    return Object.freeze(result);
}

async function readQueueWire(google: AuthenticatedProtectedTransport, resource: string): Promise<Record<string, unknown>> {
    const path = `/v2/${resource}`;
    const { value } = await google.json({ method: 'GET', url: `https://cloudtasks.googleapis.com${path}`, allowedHosts: new Set(['cloudtasks.googleapis.com']), allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: [], acceptedStatuses: [200] });
    return object(value);
}

async function readSchedulerWire(google: AuthenticatedProtectedTransport, resource: string): Promise<Record<string, unknown>> {
    const path = `/v1/${resource}`;
    const { value } = await google.json({ method: 'GET', url: `https://cloudscheduler.googleapis.com${path}`, allowedHosts: new Set(['cloudscheduler.googleapis.com']), allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: [], acceptedStatuses: [200] });
    return object(value);
}

function validateAuditSelectors(env: Env, prefix: 'TASK' | 'SCHEDULER'): Readonly<{
    logName: string;
    sinkName: string;
    bucketResource: string;
    correlation: string;
}> {
    const names = prefix === 'TASK'
        ? {
            logName: 'ANALYSIS_CAPACITY_TASK_AUDIT_LOG_NAME',
            sinkName: 'ANALYSIS_CAPACITY_TASK_AUDIT_SINK_NAME',
            bucketResource: 'ANALYSIS_CAPACITY_TASK_AUDIT_BUCKET_RESOURCE',
            correlation: 'ANALYSIS_CAPACITY_TASK_AUDIT_CORRELATION',
        }
        : {
            logName: 'ANALYSIS_CAPACITY_SCHEDULER_AUDIT_LOG_NAME',
            sinkName: 'ANALYSIS_CAPACITY_SCHEDULER_AUDIT_SINK_NAME',
            bucketResource: 'ANALYSIS_CAPACITY_SCHEDULER_AUDIT_BUCKET_RESOURCE',
            correlation: 'ANALYSIS_CAPACITY_SCHEDULER_AUDIT_CORRELATION',
        };
    const logName = required(env, names.logName);
    const sinkName = required(env, names.sinkName);
    const bucketResource = required(env, names.bucketResource);
    const correlation = required(env, names.correlation);
    const log = /^projects\/[A-Za-z0-9-]{6,30}\/logs\/([^/]+)$/.exec(logName);
    if (log === null || !CLOUD_LOG_ID_PATTERN.test(log[1]!)
        || !/^[A-Za-z0-9_-]{1,128}$/.test(sinkName)
        || !/^projects\/[A-Za-z0-9-]{6,30}\/locations\/[a-z][a-z0-9-]{0,62}\/buckets\/[A-Za-z0-9_-]{1,128}$/.test(bucketResource)
        || !/^[A-Za-z0-9_.:-]{1,256}$/.test(correlation)) fail('EVIDENCE_UNAVAILABLE');
    return { logName, sinkName, bucketResource, correlation };
}

function pauseProvenanceReader(google: AuthenticatedProtectedTransport, env: Env, now: () => number) {
    const selectors = validateAuditSelectors(env, 'SCHEDULER');
    const project = readRoleSelector(env, 'preflight').project;
    if (selectors.logName !== `projects/${project}/logs/cloudaudit.googleapis.com%2Factivity`
        || selectors.sinkName !== '_Required'
        || selectors.bucketResource !== `projects/${project}/locations/global/buckets/_Required`) fail('EVIDENCE_UNAVAILABLE');
    return createSchedulerPauseProvenanceReader({ transport: google, project,
        resources: ROLES.map(role => schedulerResource(role, readRoleSelector(env, role))), now });
}

function queueInput(role: Role, selector: BoundRoleSelector, runtime: CloudRunServiceObservation, raw: Record<string, unknown>, caller: ProtectedIdentity): ProtectedQueueInput {
    const target = roleTargetFromEnvironment(runtime.environment, role);
    const expectedCaller = role === 'preflight' ? runtime.environment.PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL : runtime.environment.ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL;
    if (expectedCaller !== caller.identity) fail('CAPABILITY_BINDING_MISMATCH');
    return {
        resource: roleResource(role, selector).queue,
        project: selector.project,
        location: selector.location,
        target: { ...target, callerIdentity: caller },
        configuration: queueConfigurationFromWire(raw),
    };
}

function schedulerInput(role: Role, selector: RoleSelector, raw: Record<string, unknown>, maintenance: ProtectedIdentity): ProtectedSchedulerInput {
    const resource = schedulerResource(role, selector);
    const target = recoveryTargetFromWire(raw, selector.project);
    if (target.identity.identity !== maintenance.identity) fail('CAPABILITY_BINDING_MISMATCH');
    const state = raw.state;
    if (state !== 'PAUSED' && state !== 'ENABLED') fail('ADAPTER_RESPONSE_INVALID');
    return { resource, project: selector.project, location: selector.maintenanceLocation, target, configuration: schedulerConfigurationFromWire(raw), state, pauseEpochMs: state === 'PAUSED' ? 1 : 0, lastAttemptMs: parseTimestamp(raw.lastAttemptTime) };
}

function readinessEnqueuerFingerprint(
    readiness: LegacyPublicReadiness,
    role: Role,
): string | null | undefined {
    return role === 'preflight'
        ? readiness.preflightEnqueuerIdentityFingerprint
        : readiness.paidEnqueuerIdentityFingerprint;
}

function readinessEnqueuerVersion(role: Role): string {
    return role === 'preflight'
        ? PREFLIGHT_ENQUEUER_IDENTITY_FINGERPRINT_VERSION
        : PAID_ENQUEUER_IDENTITY_FINGERPRINT_VERSION;
}

function requiredEnqueuerReadinessFingerprint(
    readiness: LegacyPublicReadiness,
    role: Role,
): string {
    const version = role === 'preflight'
        ? readiness.preflightEnqueuerIdentityFingerprintVersion
        : readiness.paidEnqueuerIdentityFingerprintVersion;
    const fingerprint = readinessEnqueuerFingerprint(readiness, role);
    if (version !== readinessEnqueuerVersion(role)
        || typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(fingerprint)) fail('READINESS_INVALID');
    return fingerprint;
}

function assertEnqueuerReadinessHashes(
    readiness: LegacyPublicReadiness,
    graph: Readonly<{ slots: Readonly<Record<string, ProtectedIdentity>> }>,
): void {
    for (const role of ROLES) {
        const fingerprint = requiredEnqueuerReadinessFingerprint(readiness, role);
        const selected = graph.slots[`${role}.enqueuer`];
        if (!selected || enqueuerIdentityFingerprint(role, selected.identity) !== fingerprint) fail('READINESS_INVALID');
    }
}

export function identitySlots(
    role: Role,
    runtime: CloudRunServiceObservation,
    queue: QueueObservation,
    scheduler: SchedulerObservation,
    selector: ReturnType<typeof readRoleSelector>,
    env: Env,
    expectedEnqueuerFingerprint?: string | null,
): Readonly<Record<`${Role}.${'task-caller' | 'enqueuer' | 'runtime' | 'maintenance'}`, ProtectedIdentity>> {
    const callerKey = role === 'preflight' ? 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL' : 'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL';
    const caller = queue.target?.callerIdentity ?? (queue.target === null && queue.httpTargetPresent === false
        ? identity(required(runtime.environment, callerKey), selector.project) : undefined);
    if (!caller) fail('RESOURCE_INVALID');
    const runtimeIdentity = runtime.identity;
    const maintenance = scheduler.target.identity;
    const enqueuerKey = role === 'preflight' ? 'PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL' : 'ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL';
    const configured = expectedEnqueuerFingerprint === undefined || expectedEnqueuerFingerprint === null
        ? required(env, enqueuerKey)
        : env[enqueuerKey];
    const runtimeConfigured = runtime.environment[enqueuerKey];
    if (runtime.secretReferences?.[enqueuerKey] !== undefined) fail('CAPABILITY_BINDING_MISMATCH');
    const candidates = new Map<string, ProtectedIdentity>();
    for (const value of [configured, runtimeConfigured, caller.identity]) {
        if (value === undefined) continue;
        const candidate = identity(value, selector.project);
        candidates.set(candidate.identity, candidate);
    }
    let selected: ProtectedIdentity | undefined;
    if (expectedEnqueuerFingerprint === undefined || expectedEnqueuerFingerprint === null) {
        // Historical readiness payloads predate the digest. Preserve the
        // existing exact project-env binding for old-only preparation, while
        // still requiring agreement whenever the runtime exposes the slot.
        if (runtimeConfigured !== undefined && runtimeConfigured !== configured) fail('CAPABILITY_BINDING_MISMATCH');
        selected = candidates.get(configured);
    } else {
        const matching = [...candidates.values()].filter(candidate => enqueuerIdentityFingerprint(role, candidate.identity) === expectedEnqueuerFingerprint);
        if (matching.length !== 1) fail('CAPABILITY_BINDING_MISMATCH');
        selected = matching[0];
    }
    if (!selected) fail('CAPABILITY_BINDING_MISMATCH');
    return {
        [`${role}.task-caller`]: caller,
        [`${role}.enqueuer`]: selected,
        [`${role}.runtime`]: runtimeIdentity,
        [`${role}.maintenance`]: maintenance,
    } as Readonly<Record<`${Role}.${'task-caller' | 'enqueuer' | 'runtime' | 'maintenance'}`, ProtectedIdentity>>;
}

function serviceAccountResource(projectId: string, account: string): string {
    return `projects/${projectId}/serviceAccounts/${account}`;
}

function policyInput(kind: ProtectedIamInput['kind'], snapshot: ProtectedIamPolicySnapshot, previous: ProtectedIamPolicySnapshot | null = null): ProtectedIamInput {
    return { kind, resource: snapshot.resource, project: snapshot.project, etag: snapshot.etag, bindings: snapshot.bindings, previous };
}

function member(identityValue: ProtectedIdentity): string {
    return `serviceAccount:${identityValue.identity}`;
}

type RoleLive = Readonly<{
    role: Role;
    selector: BoundRoleSelector;
    resources: ReturnType<typeof roleResource>;
    runtime: CloudRunServiceObservation;
    revision: CloudRunRevisionObservation;
    queueInput: ProtectedQueueInput;
    queueObservation: QueueObservation;
    schedulerInput: ProtectedSchedulerInput;
    schedulerObservation: SchedulerObservation;
    retentionInput: ProtectedRetentionInput;
    iam: Readonly<{ run: ProtectedIamPolicySnapshot; queue: ProtectedIamPolicySnapshot; taskCaller: ProtectedIamPolicySnapshot; maintenance: ProtectedIamPolicySnapshot }>;
    oldBuild: BuildRecord;
    slots: Readonly<Record<string, ProtectedIdentity>>;
}>;

type FullRoleLive = RoleLive & Readonly<{
    desiredBuild: BuildRecord;
    desiredImage: string;
}>;

type OwnerOldPass = Readonly<{
    env: Env;
    supabaseServiceRoleSensitive: boolean;
    auth: OwnerAuthBoundary;
    transports: OwnerProtectedTransports;
    storageSourceVerifier: StorageSourceVerifier;
    project: string;
    accounts: readonly IdentityAccountObservation[];
    roles: RoleMap<RoleLive>;
    oldReadiness: Readonly<{ dto: LegacyPublicReadiness; contract: ReadinessContract }>;
    oldDeployment: DeploymentRecord;
    alias: string;
    bucket: string;
    supabaseOrigin: string;
}>;

type OwnerPass = Omit<OwnerOldPass, 'roles'> & Readonly<{
    roles: RoleMap<FullRoleLive>;
    desiredReadiness: Readonly<{ dto: LegacyPublicReadiness; contract: ReadinessContract }>;
    desiredDeployment: DeploymentRecord;
}>;

type OwnerOldDiscovery = Readonly<{
    pass: OwnerOldPass;
    buildsByLocation: Readonly<Record<string, readonly BuildCandidate[]>>;
}>;

type OwnerReadOptions = Readonly<{
    cwd: string;
    resourceSelectorOverrides: OwnerResourceSelectorOverrides;
    desiredDeployment?: OwnerDesiredDeploymentSelector;
    publicReadinessTransport?: ProtectedTransport;
}>;

export function assertCloudRunTargetOrigin(
    runtime: Readonly<Pick<CloudRunServiceObservation, 'url'>>,
    targetUrl: string,
    providerUrls: readonly string[],
): void {
    const target = targetOrigin(targetUrl, 'RESOURCE_INVALID');
    const observed = [runtime.url, ...providerUrls].map(value => targetOrigin(value, 'RESOURCE_INVALID'));
    if (!observed.includes(target)) fail('RESOURCE_INVALID');
}

async function buildRoleLive(input: Readonly<{
    role: Role;
    env: Env;
    enqueuerFingerprint?: string | null;
    selector: RoleSelector;
    google: AuthenticatedProtectedTransport;
    workPlanes: WorkPlaneClient;
    iamAdapter: IamAdapter;
    storageSourceVerifier: StorageSourceVerifier;
    }>, buildsByLocation: Readonly<Record<string, readonly BuildCandidate[]>>): Promise<RoleLive> {
    const cloudRun = new CloudRunAdapter({ transport: input.google });
    const runtime = await cloudRun.getService(serviceResource(input.selector));
    const runtimeUrls = await cloudRun.getServiceUrls(runtime.resource);
    if (runtime.project !== input.selector.project || runtime.location !== input.selector.cloudRunRegion || runtime.service !== input.selector.service
        || runtime.latestReadyRevision === null || !runtime.ready || runtime.observedGeneration !== runtime.generation || !IMAGE.test(runtime.image)) fail('SOURCE_INVALID');
    const selector = resolveRoleSelectorFromCloudRun({ role: input.role, selector: input.selector, runtime });
    const resources = roleResource(input.role, selector);
    const revision = await cloudRun.observeRevision(runtime.project, runtime.location, runtime.latestReadyRevision);
    const runtimeImage = immutableImageReference(runtime.image);
    if (!revision.ready || revision.identity.identity !== runtime.identity.identity || runtimeImage === null
        || immutableImageReference(revision.image) !== runtimeImage
        || revision.runtimeDigest !== runtime.runtimeDigest) fail('SOURCE_INVALID');
    // Labels select the historical commit to check; independent Build/Git
    // content proof below is what establishes that source, not the label.
    const revisionMetadata = object(revision.raw.metadata);
    const sourceCandidates = [object(revisionMetadata.labels ?? {})['analysis-v2-source-commit'],
        object(revisionMetadata.annotations ?? {})['capacity.identity-epoch/source-sha']].filter(value => value !== undefined);
    if (sourceCandidates.length === 0 || sourceCandidates.some(value => typeof value !== 'string' || !SHA.test(value))
        || new Set(sourceCandidates).size !== 1) fail('SOURCE_INVALID');
    const oldSourceSha = sourceCandidates[0] as string;
    const runtimeTarget = roleTargetFromEnvironment(runtime.environment, input.role);
    assertCloudRunTargetOrigin(runtime, runtimeTarget.url, runtimeUrls);
    const runtimeIdentityKey = input.role === 'preflight' ? 'PREFLIGHT_TASKS_RUNTIME_SERVICE_ACCOUNT_EMAIL' : 'ANALYSIS_V2_WORKER_RUNTIME_SERVICE_ACCOUNT_EMAIL';
    const configuredRuntimeIdentity = runtime.environment[runtimeIdentityKey];
    if (configuredRuntimeIdentity !== undefined && configuredRuntimeIdentity !== runtime.identity.identity) fail('CAPABILITY_BINDING_MISMATCH');
    const queueRaw = await readQueueWire(input.google, resources.queue);
    const state = queueRaw.state;
    if (state !== 'PAUSED' && state !== 'RUNNING') fail('ADAPTER_RESPONSE_INVALID');
    const callerKey = input.role === 'preflight' ? 'PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL' : 'ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL';
    const queueCaller = queueRaw.httpTarget === undefined && queueRaw.appEngineHttpTarget === undefined
        ? runtime.environment[callerKey]
        : isObject(queueRaw.httpTarget) && isObject(queueRaw.httpTarget.oidcToken)
            ? queueRaw.httpTarget.oidcToken.serviceAccountEmail : undefined;
    if (typeof queueCaller !== 'string') fail('ADAPTER_RESPONSE_INVALID');
    const caller = identity(queueCaller, selector.project);
    const queueInputValue = queueInput(input.role, selector, runtime, queueRaw, caller);
    const queueObservation = await input.workPlanes.observeQueue(queueInputValue);
    // Cloud Tasks does not expose a fixed worker URL on the queue resource;
    // its HTTP target is carried by each task. The queue-level OIDC tuple and
    // URI-override wire shape are still live facts and must agree with the
    // exact selector used to build the packet.
    if (queueObservation.target === null ? queueObservation.httpTargetPresent || queueRaw.httpTarget !== undefined
        : queueObservation.target.audience !== queueInputValue.target.audience
            || canonicalDigest(queueObservation.target.callerIdentity) !== canonicalDigest(queueInputValue.target.callerIdentity)) fail('CAPABILITY_BINDING_MISMATCH');
    const schedulerRaw = await readSchedulerWire(input.google, resources.scheduler);
    const schedulerTarget = recoveryTargetFromWire(schedulerRaw, selector.project);
    const expectedMaintenance = maintenanceTargetFromEnvironment(runtime.environment, input.role);
    if (schedulerTarget.identity.identity !== expectedMaintenance.identity.identity
        || schedulerTarget.audience !== expectedMaintenance.audience) fail('CAPABILITY_BINDING_MISMATCH');
    const schedulerInputValue = schedulerInput(input.role, selector, schedulerRaw, expectedMaintenance.identity);
    const schedulerObservation = await input.workPlanes.observeScheduler(schedulerInputValue);
    const retentionResource = `projects/${selector.project}/locations/${selector.maintenanceLocation}/jobs/${required(input.env, 'ANALYSIS_V2_RETENTION_SCHEDULER_JOB')}`;
    const retentionInputValue: ProtectedRetentionInput = { resource: retentionResource, project: selector.project, location: selector.maintenanceLocation, enabled: true, configuration: { enabled: true } };
    const retention = await input.workPlanes.observeRetention(retentionInputValue);
    if (!retention.enabled) fail('EVIDENCE_UNAVAILABLE');
    const iam = {
        run: await input.iamAdapter.getPolicy({ kind: 'run', resource: resources.service, project: selector.project }),
        maintenance: await input.iamAdapter.getPolicy({ kind: 'maintenance', resource: resources.service, project: selector.project }),
        queue: await input.iamAdapter.getPolicy({ kind: 'queue', resource: resources.queue, project: selector.project }),
        taskCaller: await input.iamAdapter.getPolicy({ kind: 'taskCaller', resource: serviceAccountResource(selector.project, caller.identity), project: selector.project }),
    };
    if (canonicalDigest(iam.run.bindings) !== canonicalDigest(iam.maintenance.bindings) || iam.run.etag !== iam.maintenance.etag) fail('RESOURCE_INVALID');
    const buildRecords = Object.values(buildsByLocation).flat();
    if (buildRecords.length === 0) fail('EVIDENCE_UNAVAILABLE');
    const oldBuild = await resolveOwnerBuildForImage(buildRecords, oldSourceSha, runtime.image, selector.project, input.storageSourceVerifier);
    return {
        role: input.role, selector, resources, runtime, revision, queueInput: queueInputValue, queueObservation,
        schedulerInput: { ...schedulerInputValue, state: schedulerObservation.state, pauseEpochMs: schedulerObservation.pauseEpochMs, lastAttemptMs: schedulerObservation.lastAttemptMs }, schedulerObservation, retentionInput: retentionInputValue, iam,
        oldBuild,
        slots: identitySlots(input.role, runtime, queueObservation, schedulerObservation, selector, input.env, input.enqueuerFingerprint),
    };
}

async function attachDesiredBuild(
    live: RoleLive,
    desiredSourceSha: string,
    desiredImage: string,
    buildsByLocation: Readonly<Record<string, readonly BuildCandidate[]>>,
    storageSourceVerifier: StorageSourceVerifier,
): Promise<FullRoleLive> {
    const buildRecords = Object.values(buildsByLocation).flat();
    const desiredBuild = await resolveOwnerBuildForImage(buildRecords, desiredSourceSha, desiredImage, live.selector.project, storageSourceVerifier);
    return Object.freeze({ ...live, desiredBuild, desiredImage });
}

function identityFromWire(raw: Record<string, unknown>, projectId: string): ProtectedIdentity {
    const target = object(raw.httpTarget);
    const oidc = object(target.oidcToken);
    if (typeof oidc.serviceAccountEmail !== 'string') fail('ADAPTER_RESPONSE_INVALID');
    return identity(oidc.serviceAccountEmail, projectId);
}

async function readServiceAccounts(google: AuthenticatedProtectedTransport, projectId: string, slots: Readonly<Record<string, ProtectedIdentity>>): Promise<readonly IdentityAccountObservation[]> {
    const path = `/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts`;
    const rows = await collectFullyPaged({
        readPage: async (pageToken) => {
            const query = new URLSearchParams({ pageSize: '100' });
            if (pageToken !== undefined) query.set('pageToken', pageToken);
            const { value } = await google.json({ method: 'GET', url: `https://iam.googleapis.com${path}?${query.toString()}`, allowedHosts: new Set(['iam.googleapis.com']), allowedPath: candidate => candidate === path, allowedMethods: ['GET'], allowedQueryKeys: pageToken === undefined ? ['pageSize'] : ['pageSize', 'pageToken'], acceptedStatuses: [200] });
            const body = object(value);
            if (!Array.isArray(body.accounts)) fail('ADAPTER_RESPONSE_INVALID');
            const next = body.nextPageToken;
            if (next !== undefined && typeof next !== 'string') fail('PAGINATION_INCOMPLETE');
            return { items: body.accounts, ...(typeof next === 'string' && next.length > 0 ? { nextPageToken: next } : {}) };
        },
    });
    const slotsByIdentity = new Map<string, string[]>();
    for (const [slot, value] of Object.entries(slots)) {
        const current = slotsByIdentity.get(value.identity) ?? [];
        current.push(slot);
        slotsByIdentity.set(value.identity, current);
    }
    const deterministicIdentities = new Set(SLOTS.map(slot => deterministicIdentityForSlot(projectId, slot).identity));
    const result: IdentityAccountObservation[] = [];
    for (const value of rows) {
        const account = object(value);
        const email = account.email;
        if (typeof email !== 'string' || email.length > 256
            || !/^[a-z0-9][a-z0-9.-]*@[a-z0-9.-]+\.gserviceaccount\.com$/.test(email)
            || account.name !== `projects/${projectId}/serviceAccounts/${email}`) fail('ADAPTER_RESPONSE_INVALID');
        if (account.projectId !== projectId) fail('PROJECT_MISMATCH');
        // The IAM inventory also contains provider-managed/default accounts
        // whose local IDs may begin with a digit. They are not candidates for
        // this identity graph, so validate their project and then discard
        // them without fetching key metadata. Exact old-slot accounts and
        // deterministic desired candidates are the only identities retained.
        if (!slotsByIdentity.has(email) && !deterministicIdentities.has(email)) continue;
        if (!ACCOUNT.test(email)) fail('ADAPTER_RESPONSE_INVALID');
        const disabled = account.disabled;
        if (disabled !== undefined && typeof disabled !== 'boolean') fail('ADAPTER_RESPONSE_INVALID');
        const keyPath = `/v1/projects/${encodeURIComponent(projectId)}/serviceAccounts/${encodeURIComponent(email)}/keys`;
        const { value: keyValue } = await google.json({ method: 'GET', url: `https://iam.googleapis.com${keyPath}`, allowedHosts: new Set(['iam.googleapis.com']), allowedPath: candidate => candidate === keyPath, allowedMethods: ['GET'], allowedQueryKeys: [], acceptedStatuses: [200] });
        const keyBody = object(keyValue);
        const keys = keyBody.keys;
        if (keys !== undefined && !Array.isArray(keys)) fail('ADAPTER_RESPONSE_INVALID');
        const keyRows = (keys ?? []).map(item => object(item));
        if (keyRows.some(item => typeof item.keyType !== 'string' || (item.keyType !== 'USER_MANAGED' && item.keyType !== 'SYSTEM_MANAGED'))) fail('ADAPTER_RESPONSE_INVALID');
        const userManagedKeyCount = keyRows.filter(item => item.keyType === 'USER_MANAGED').length;
        result.push({ identity: { identity: email, project: projectId }, enabled: disabled !== true, userManagedKeyCount, attachedSlots: Object.freeze((slotsByIdentity.get(email) ?? []).map(slot => slot as never)) });
    }
    return Object.freeze(result);
}

function makeSupabaseOrigin(env: Env): string {
    const next = optional(env, 'NEXT_PUBLIC_SUPABASE_URL');
    const server = optional(env, 'SUPABASE_URL');
    if (next === undefined && server === undefined) fail('EVIDENCE_UNAVAILABLE');
    const configured = (value: string): string => {
        let parsed: URL;
        try { parsed = new URL(value); } catch { fail('PROJECT_MISMATCH'); }
        const origin = `${parsed.origin}/`;
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
            || parsed.pathname !== '/' || parsed.search || parsed.hash
            || !SUPABASE_ORIGIN_INPUT.test(value) || !SUPABASE_ORIGIN.test(origin)) fail('PROJECT_MISMATCH');
        return origin;
    };
    const origin = configured(next ?? server!);
    if (next !== undefined && server !== undefined && configured(server) !== origin) fail('PROJECT_MISMATCH');
    return origin;
}

export function ownerZeroWorkLookbackMs(nowMs: number, earliestMs: number): number {
    if (!Number.isSafeInteger(nowMs) || !Number.isSafeInteger(earliestMs)
        || earliestMs < 0 || earliestMs > nowMs) fail('EVIDENCE_UNAVAILABLE');
    // This is a selector duration, not an observation timestamp. Round up so
    // successive fresh passes share a plan while retaining the full pause
    // and last-attempt window. Actual observation times remain unrounded.
    const dayMs = 86_400_000;
    const requiredMs = nowMs - earliestMs + QUIESCENCE.timeoutMs + QUIESCENCE.graceMs;
    const lookbackMs = Math.ceil(requiredMs / dayMs) * dayMs;
    if (!Number.isSafeInteger(lookbackMs) || lookbackMs <= 0) fail('EVIDENCE_UNAVAILABLE');
    return lookbackMs;
}

function buildZeroWorkSources(env: Env, projectId: string, roles: RoleMap<RoleLive>, nowMs: number, desiredGraph: DesiredIdentityGraph): LiveZeroWorkSources {
    const minPause = Math.min(...ROLES.map(role => roles[role].schedulerObservation.pauseEpochMs));
    const lastAttempts = ROLES.map(role => roles[role].schedulerObservation.lastAttemptMs).filter((value): value is number => value !== null);
    const earliest = Math.min(minPause, ...(lastAttempts.length === 0 ? [nowMs] : lastAttempts));
    const lookbackMs = ownerZeroWorkLookbackMs(nowMs, earliest);
    const origin = makeSupabaseOrigin(env);
    const supabase = (source: string, table: string, columns: readonly string[]) => {
        const selector = { kind: 'supabase' as const, source, origin, table, columns, eventTimeColumn: 'created_at', lookbackMs, selectorDigest: '' };
        return { ...selector, selectorDigest: evidenceSelectorDigest(selector) };
    };
    const queueResources = ROLES.map(role => roles[role].queueInput.resource).sort();
    const taskSource = {
        kind: 'paused-queue-conservation' as const,
        source: 'cloud-tasks:paused-queue-conservation-v1' as const,
        project: projectId,
        queueResources,
        controlledIdentities: [...new Set([...Object.values(mapOldSlots(roles)), ...Object.values(desiredGraph.slots)].map(value => value.identity))].sort(),
        lookbackMs,
        selectorDigest: '',
    };
    return {
        providerLedger: supabase('supabase:public.analysis_provider_cost_ledger', 'analysis_provider_cost_ledger', ['run_id', 'request_id', 'operation_key', 'status', 'created_at']),
        billingLedger: supabase('supabase:public.analysis_revenue_cost_operations', 'analysis_revenue_cost_operations', ['request_id', 'owner_kind', 'owner_key_hash', 'operation_kind', 'status', 'created_at']),
        taskAudit: { ...taskSource, selectorDigest: evidenceSelectorDigest(taskSource) },
        receiverLog: supabase('supabase:public.analysis_step_events', 'analysis_step_events', ['id', 'request_id', 'step', 'event_type', 'created_at']),
    };
}

function mapOldSlots(roles: RoleMap<RoleLive>): Readonly<Record<(typeof SLOTS)[number], ProtectedIdentity>> {
    const slots: Record<string, ProtectedIdentity> = {};
    for (const role of ROLES) for (const slot of ['task-caller', 'enqueuer', 'runtime', 'maintenance'] as const) slots[`${role}.${slot}`] = roles[role].slots[`${role}.${slot}`]!;
    return slots as Readonly<Record<(typeof SLOTS)[number], ProtectedIdentity>>;
}

function accountGraph(pass: Readonly<{ project: string; roles: RoleMap<RoleLive>; accounts: readonly IdentityAccountObservation[] }>): IdentityGraphObservation {
    const oldBuild = pass.roles.preflight.oldBuild.input;
    if (canonicalDigest(oldBuild.identity) !== canonicalDigest(pass.roles.paid.oldBuild.input.identity)) fail('SOURCE_INVALID');
    return {
        project: pass.project,
        build: oldBuild.identity,
        slots: mapOldSlots(pass.roles),
        accounts: pass.accounts,
        schedulerStates: Object.fromEntries(ROLES.map(role => [role, pass.roles[role].schedulerObservation.state])) as Readonly<Record<Role, 'PAUSED' | 'ENABLED'>>,
        schedulerResources: Object.fromEntries(ROLES.map(role => [role, pass.roles[role].schedulerInput.resource])) as Readonly<Record<Role, string>>,
        retentionSchedulerResource: pass.roles.preflight.retentionInput.resource,
    };
}

async function readOwnerOldPass(
    auth: OwnerAuthBoundary,
    transports: OwnerProtectedTransports,
    now: () => number,
    storageSourceVerifier: StorageSourceVerifier,
    resourceSelectorOverrides: OwnerResourceSelectorOverrides,
    publicReadinessTransport?: ProtectedTransport,
): Promise<OwnerOldDiscovery> {
    const productionEnv = await readProductionEnv(transports.vercel, auth);
    const env = mergeOwnerResourceSelectorOverrides(productionEnv, resourceSelectorOverrides);
    const selectors = Object.fromEntries(ROLES.map(role => [role, readRoleSelector(env, role)])) as RoleMap<ReturnType<typeof readRoleSelector>>;
    const projectId = requireProjectAgreement(selectors);
    if (auth.vercelProjectId.length === 0 || auth.vercelTeamId.length === 0) unavailable();
    const alias = required(env, 'VERCEL_PRODUCER_ALIAS');
    if (!/^[A-Za-z0-9.-]{1,253}$/.test(alias)) fail('ADAPTER_REQUEST_INVALID');
    const oldId = await readCurrentAlias(transports.vercel, alias, auth.vercelProjectId, auth.vercelTeamId);
    const oldDeployment = await readVercelDeployment(transports.vercel, auth.vercelProjectId, auth.vercelTeamId, oldId);
    const publicTransport = publicReadinessTransport ?? new FetchProtectedTransport(65_536);
    const oldReadiness = await readPublicReadiness(`https://${alias}/api/analysis/capacity/readiness`, oldDeployment.sourceSha, publicTransport);
    const google = transports.google;
    const pauseProvenance = pauseProvenanceReader(google, env, now);
    const workPlanes = new WorkPlaneClient({ transport: google, pauseProvenance, now, pauseProvenanceTimeoutMs: 60_000 });
    const iamAdapter = new IamAdapter({ transport: google });
    const locations = new Set(['global', ...ROLES.flatMap(role => [selectors[role].location, selectors[role].cloudRunRegion, selectors[role].maintenanceLocation])]);
    const buildsByLocation: Record<string, readonly BuildCandidate[]> = {};
    for (const location of locations) buildsByLocation[location] = await readBuilds(google, projectId, location);
    const roleValues = await Promise.all(ROLES.map(role => buildRoleLive({
        role,
        env,
        enqueuerFingerprint: readinessEnqueuerFingerprint(oldReadiness.dto, role),
        selector: selectors[role],
        google,
        workPlanes,
        iamAdapter,
        storageSourceVerifier,
    }, buildsByLocation)));
    const roles = Object.fromEntries(roleValues.map(value => [value.role, value])) as RoleMap<RoleLive>;
    const buildOld = roles.preflight.oldBuild;
    if (canonicalDigest(buildOld.input.identity) !== canonicalDigest(roles.paid.oldBuild.input.identity)) fail('SOURCE_INVALID');
    const slots = mapOldSlots(roles);
    const accounts = await readServiceAccounts(google, projectId, slots);
    const bucket = required(env, 'ANALYSIS_CAPACITY_DEPLOY_LOCK_BUCKET');
    if (!BUCKET.test(bucket)) fail('ADAPTER_REQUEST_INVALID');
    const pass: OwnerOldPass = Object.freeze({
        env,
        supabaseServiceRoleSensitive: productionEnv.sensitiveKeys.includes('SUPABASE_SERVICE_ROLE_KEY'),
        auth, transports, storageSourceVerifier, project: projectId, accounts, roles, oldReadiness,
        oldDeployment, alias, bucket,
        supabaseOrigin: makeSupabaseOrigin(env),
    });
    return Object.freeze({ pass, buildsByLocation: Object.freeze({ ...buildsByLocation }) });
}

async function readOwnerPass(
    auth: OwnerAuthBoundary,
    transports: OwnerProtectedTransports,
    now: () => number,
    storageSourceVerifier: StorageSourceVerifier,
    options: OwnerReadOptions,
): Promise<OwnerPass> {
    const oldPublicTransport = options.publicReadinessTransport ?? new FetchProtectedTransport(65_536);
    const old = await readOwnerOldPass(auth, transports, now, storageSourceVerifier, options.resourceSelectorOverrides, oldPublicTransport);
    const { pass: oldPass, buildsByLocation } = old;
    const oldDeployment = oldPass.oldDeployment;
    let desired: DeploymentRecord;
    if (options.desiredDeployment !== undefined) {
        if (options.desiredDeployment.id === oldDeployment.id) fail('DISCOVERY_AMBIGUOUS');
        desired = assertOwnerDesiredDeployment(options.desiredDeployment,
            await readVercelDeployment(transports.vercel, auth.vercelProjectId, auth.vercelTeamId, options.desiredDeployment.id));
    } else {
        const deployments = await readVercelDeployments(transports.vercel, auth.vercelProjectId, auth.vercelTeamId);
        const desiredCandidate = selectDeployment(deployments, oldDeployment.id);
        desired = await readVercelDeployment(transports.vercel, auth.vercelProjectId, auth.vercelTeamId, desiredCandidate.id);
    }
    const desiredPublicTransport = options.publicReadinessTransport ?? createOwnerReadinessTransport({
        transport: transports.vercel,
        projectId: auth.vercelProjectId,
        teamId: auth.vercelTeamId,
        deploymentIds: [oldDeployment.id, desired.id],
        publicReadinessOrigin: `https://${oldPass.alias}`,
        cwd: options.cwd,
    });
    const desiredReadiness = await readPublicReadiness(`${desired.origin}/api/analysis/capacity/readiness`, desired.sourceSha, desiredPublicTransport);
    if (oldPass.oldReadiness.contract.legacyTargetResource !== desiredReadiness.contract.legacyTargetResource) fail('READINESS_INVALID');
    if (oldPass.oldReadiness.contract.schemaVersion !== desiredReadiness.contract.schemaVersion) fail('READINESS_INVALID');
    for (const role of ROLES) {
        requiredEnqueuerReadinessFingerprint(oldPass.oldReadiness.dto, role);
        requiredEnqueuerReadinessFingerprint(desiredReadiness.dto, role);
    }
    const allBuilds = Object.values(buildsByLocation).flat();
    const desiredArtifact = await selectUniqueBuildForSource(allBuilds, desired.sourceSha, oldPass.env.ANALYSIS_CAPACITY_DESIRED_WORKER_IMAGE, oldPass.project, storageSourceVerifier);
    const roleValues = await Promise.all(ROLES.map(role => attachDesiredBuild(
        oldPass.roles[role], desired.sourceSha, desiredArtifact.image, buildsByLocation, storageSourceVerifier,
    )));
    const roles = Object.fromEntries(roleValues.map(value => [value.role, value])) as RoleMap<FullRoleLive>;
    const buildOld = roles.preflight.oldBuild;
    const buildDesired = roles.preflight.desiredBuild;
    if (canonicalDigest(buildOld.input.identity) !== canonicalDigest(roles.paid.oldBuild.input.identity)) fail('SOURCE_INVALID');
    assertSameBuild(buildDesired, roles.paid.desiredBuild);
    for (const role of ROLES) {
        if (roles[role].desiredBuild.input.sourceSha !== desired.sourceSha) fail('SOURCE_INVALID');
    }
    return Object.freeze({
        ...oldPass,
        roles,
        desiredReadiness,
        desiredDeployment: desired,
    });
}

function roleSlotsForGraph(graph: DesiredIdentityGraph): Readonly<Record<(typeof SLOTS)[number], ProtectedIdentity>> {
    return graph.slots;
}

function buildDesiredRuntime(role: Role, live: FullRoleLive, graph: DesiredIdentityGraph): ProtectedRuntimeInput {
    const queueTarget = live.queueInput.target;
    const schedulerTarget = live.schedulerInput.target;
    const environment = runtimeEnvironment(live.runtime, role, live.selector, graph.slots, schedulerTarget, queueTarget);
    return {
        role,
        service: live.runtime.service,
        project: live.runtime.project,
        location: live.runtime.location,
        identity: accountFromSlot(graph.slots, `${role}.runtime`),
        sourceSha: live.desiredBuild.input.sourceSha,
        environment,
        secretReferences: live.runtime.secretReferences,
        settings: live.runtime.settings,
        target: { url: live.queueInput.target.url, audience: live.queueInput.target.audience },
        noTraffic: true,
        providerAdmissionEnabled: true,
    };
}

function buildOldRuntime(role: Role, live: RoleLive, sourceSha: string): ProtectedRuntimeInput {
    return {
        role,
        service: live.runtime.service,
        project: live.runtime.project,
        location: live.runtime.location,
        identity: live.runtime.identity,
        sourceSha,
        environment: live.runtime.environment,
        secretReferences: live.runtime.secretReferences,
        settings: live.runtime.settings,
        target: { url: live.queueInput.target.url, audience: live.queueInput.target.audience },
        noTraffic: live.runtime.noTraffic,
        providerAdmissionEnabled: live.runtime.environment.ANALYSIS_PROVIDER_ADMISSION_ENABLED === 'true',
    };
}

function buildDesiredQueue(live: RoleLive, graph: DesiredIdentityGraph): ProtectedQueueInput {
    return {
        ...live.queueInput,
        target: {
            ...live.queueInput.target,
            callerIdentity: accountFromSlot(graph.slots, `${live.role}.task-caller`),
        },
    };
}

function buildDesiredScheduler(live: RoleLive, graph: DesiredIdentityGraph): ProtectedSchedulerInput {
    return {
        ...live.schedulerInput,
        target: {
            ...live.schedulerInput.target,
            identity: accountFromSlot(graph.slots, `${live.role}.maintenance`),
        },
        state: live.schedulerObservation.state,
    };
}

function normalizePolicyBindings(bindings: readonly ProtectedIamBinding[]): readonly ProtectedIamBinding[] {
    const seen = new Set<string>();
    const result: ProtectedIamBinding[] = [];
    for (const binding of bindings) {
        const key = canonicalDigest(binding);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(binding);
    }
    return Object.freeze(result.sort((left, right) => canonicalDigest(left).localeCompare(canonicalDigest(right))));
}

async function buildDesiredIam(
    live: RoleLive,
    graph: DesiredIdentityGraph,
    iamAdapter: IamAdapter,
): Promise<ProtectedIamInputsForRole> {
    const role = live.role;
    const desiredRuntime = accountFromSlot(graph.slots, `${role}.runtime`);
    const desiredTaskCaller = accountFromSlot(graph.slots, `${role}.task-caller`);
    const desiredEnqueuer = accountFromSlot(graph.slots, `${role}.enqueuer`);
    const desiredMaintenance = accountFromSlot(graph.slots, `${role}.maintenance`);
    const desiredTaskResource = serviceAccountResource(live.selector.project, desiredTaskCaller.identity);
    const taskCurrent = desiredTaskResource === live.iam.taskCaller.resource
        ? live.iam.taskCaller
        : await iamAdapter.getPolicy({ kind: 'taskCaller', resource: desiredTaskResource, project: live.selector.project });
    const runBindings = normalizePolicyBindings([
        ...live.iam.run.bindings,
        { role: 'roles/run.invoker', member: member(desiredTaskCaller), condition: null },
        { role: 'roles/run.invoker', member: member(desiredMaintenance), condition: null },
    ]);
    const queueBindings = normalizePolicyBindings([
        ...live.iam.queue.bindings,
        { role: 'roles/cloudtasks.enqueuer', member: member(desiredEnqueuer), condition: null },
        { role: 'roles/cloudtasks.enqueuer', member: member(desiredRuntime), condition: null },
        { role: 'roles/cloudtasks.viewer', member: member(desiredRuntime), condition: null },
    ]);
    const cloudTasksAgentBindings = live.iam.taskCaller.bindings.filter(binding => binding.role === 'roles/iam.serviceAccountUser'
        && /^serviceAccount:service-[0-9]{6,20}@gcp-sa-cloudtasks\.iam\.gserviceaccount\.com$/.test(binding.member));
    const taskBindings = normalizePolicyBindings([
        ...taskCurrent.bindings,
        ...cloudTasksAgentBindings,
        { role: 'roles/iam.serviceAccountUser', member: member(desiredEnqueuer), condition: null },
        { role: 'roles/iam.serviceAccountUser', member: member(desiredRuntime), condition: null },
    ]);
    const previous = desiredTaskResource === live.iam.taskCaller.resource ? null : live.iam.taskCaller;
    const run = policyInput('run', { ...live.iam.run, bindings: runBindings });
    const queue = policyInput('queue', { ...live.iam.queue, bindings: queueBindings });
    const taskCaller = policyInput('taskCaller', { ...taskCurrent, bindings: taskBindings }, previous);
    const maintenance = policyInput('maintenance', { ...live.iam.maintenance, bindings: runBindings });
    return { run, queue, taskCaller, maintenance };
}

type ProtectedIamInputsForRole = Readonly<{
    run: ProtectedIamInput;
    queue: ProtectedIamInput;
    taskCaller: ProtectedIamInput;
    maintenance: ProtectedIamInput;
}>;

function oldIam(live: RoleLive): ProtectedIamInputsForRole {
    return {
        run: policyInput('run', live.iam.run),
        queue: policyInput('queue', live.iam.queue),
        taskCaller: policyInput('taskCaller', live.iam.taskCaller),
        maintenance: policyInput('maintenance', live.iam.maintenance),
    };
}

function sourceContract(role: Role, live: RoleLive, oldSourceSha: string, desiredSourceSha: string, desiredRuntime: ProtectedRuntimeInput, desiredBuild: ProtectedBuildInput): CapacityManifest['source'][Role] {
    // A fresh plan after a service change must not reuse an immutable revision
    // created by an interrupted epoch, even when its source is unchanged.
    const suffix = canonicalDigest({
        project: live.selector.project, role, sourceSha: desiredSourceSha,
        priorGeneration: live.runtime.generation,
        priorResourceVersion: live.runtime.resourceVersion,
    }).slice(0, 20);
    const revisionPlan = { prefix: `${live.runtime.service}-`, suffix };
    return {
        oldSha: oldSourceSha,
        oldRevision: live.runtime.latestReadyRevision!,
        desiredSha: desiredSourceSha,
        desiredBuildDigest: canonicalDigest(desiredBuild),
        desiredRuntimeDigest: canonicalRuntimeInputDigest(desiredRuntime),
        desiredRuntimeEnvironment: desiredRuntime.environment,
        desiredRuntimeSettings: desiredRuntime.settings,
        revisionPlan,
    };
}

function queueContract(live: RoleLive, input: ProtectedQueueInput = live.queueInput): CapacityManifest['queues'][Role] {
    return {
        resource: input.resource,
        project: input.project,
        location: input.location,
        targetDigest: canonicalDigest(input.target),
        configDigest: canonicalDigest(canonicalQueueConfiguration(input.configuration)),
        state: live.queueObservation.state,
        empty: live.queueObservation.tasks.length === 0,
        tasksDigest: canonicalDigest(live.queueObservation.tasks),
    };
}

function schedulerContract(live: RoleLive, input: ProtectedSchedulerInput = live.schedulerInput): CapacityManifest['recoverySchedulers'][Role] {
    return {
        resource: input.resource,
        project: input.project,
        location: input.location,
        targetDigest: canonicalDigest(input.target),
        configDigest: canonicalDigest(input.configuration),
        state: live.schedulerObservation.state,
        pauseEpochMs: live.schedulerObservation.pauseEpochMs,
        lastAttemptMs: live.schedulerObservation.lastAttemptMs,
    };
}

function iamContract(value: ProtectedIamInputsForRole, retiredBindings: readonly string[] = []): CapacityManifest['iam'][Role] {
    return {
        policyDigest: canonicalIamPolicyDigest(value),
        desiredBindings: canonicalIamBindingDigests(value),
        retiredBindings,
    };
}

function oldObservations(
    pass: OwnerPass,
    oldInputs: ProtectedPlatformInputs,
    oldReadiness: Readonly<{ contract: ReadinessContract }>,
): ProtectedOldObservations {
    const source = Object.fromEntries(ROLES.map(role => [role, {
        sourceSha: pass.roles[role].oldBuild.input.sourceSha,
        revision: pass.roles[role].runtime.latestReadyRevision!,
        metadataDigest: observedBuildMetadataDigest(pass.roles[role].oldBuild.raw, pass.roles[role].oldBuild.input),
    }])) as ProtectedOldObservations['source'];
    const runtime = Object.fromEntries(ROLES.map(role => {
        const live = pass.roles[role];
        return [role, {
            sourceSha: live.oldBuild.input.sourceSha,
            service: live.runtime.service,
            project: live.runtime.project,
            location: live.runtime.location,
            revision: live.runtime.latestReadyRevision!,
            generation: live.runtime.generation,
            resourceVersion: live.runtime.resourceVersion,
            identity: live.runtime.identity,
            providerAdmissionEnabled: live.runtime.environment.ANALYSIS_PROVIDER_ADMISSION_ENABLED === 'true',
            noTraffic: live.runtime.noTraffic,
            runtimeDigest: live.runtime.runtimeDigest,
            buildDigest: live.runtime.buildDigest,
        }];
    })) as ProtectedOldObservations['runtime'];
    const queues = Object.fromEntries(ROLES.map(role => {
        const live = pass.roles[role];
        return [role, { resource: live.queueObservation.resource, project: live.queueObservation.project, location: live.queueObservation.location, state: live.queueObservation.state, configuration: live.queueObservation.configuration, tasks: live.queueObservation.tasks, complete: live.queueObservation.complete }];
    })) as ProtectedOldObservations['queues'];
    const schedulers = Object.fromEntries(ROLES.map(role => {
        const live = pass.roles[role];
        return [role, { resource: live.schedulerObservation.resource, project: live.schedulerObservation.project, location: live.schedulerObservation.location, state: live.schedulerObservation.state, pauseEpochMs: live.schedulerObservation.pauseEpochMs, lastAttemptMs: live.schedulerObservation.lastAttemptMs, configuration: live.schedulerObservation.configuration }];
    })) as ProtectedOldObservations['schedulers'];
    return {
        source,
        runtime,
        queues,
        schedulers,
        iam: oldInputs.iam,
        retention: oldInputs.retention,
        readiness: { ...oldReadiness.contract, ready: true },
    };
}

function desiredObservations(
    pass: OwnerPass,
    desiredInputs: ProtectedPlatformInputs,
    desiredSourceSha: string,
    desiredBuild: ProtectedBuildInput,
    desiredReadiness: ReadinessContract,
    zeroWorkSources: LiveZeroWorkSources,
    sourceContracts: CapacityManifest['source'],
): ProtectedObservationTargets {
    const source = Object.fromEntries(ROLES.map(role => [role, {
        sourceSha: desiredSourceSha,
        revisionPlan: sourceContracts[role].revisionPlan,
        desiredBuildDigest: sourceContracts[role].desiredBuildDigest,
        desiredRuntimeDigest: sourceContracts[role].desiredRuntimeDigest,
    }])) as ProtectedObservationTargets['source'];
    const zeroWork = Object.fromEntries(Object.entries(zeroWorkSources).map(([name, value]) => [name, { source: value.source, lookbackMs: value.lookbackMs, selectorDigest: value.selectorDigest }])) as ProtectedObservationTargets['zeroWorkSources'];
    void pass;
    void desiredBuild;
    return {
        source,
        runtime: desiredInputs.runtime,
        queues: desiredInputs.queues,
        schedulers: desiredInputs.schedulers,
        iam: desiredInputs.iam,
        retention: desiredInputs.retention,
        readiness: desiredReadiness,
        zeroWorkSources: zeroWork,
    };
}

function buildServiceBody(role: Role, live: RoleLive, desiredRuntime: ProtectedRuntimeInput, desiredBuildDigest: string, desiredImage: string, sourceSha: string, revisionPlan: Readonly<{ prefix: string; suffix: string }>): Readonly<Record<string, unknown>> {
    const revision = `${revisionPlan.prefix}${sourceSha.slice(0, 12)}${revisionPlan.suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(revision)) fail('RESOURCE_INVALID');
    const env = [
        ...Object.entries(desiredRuntime.environment).map(([name, value]) => ({ name, value })),
        ...Object.entries(desiredRuntime.secretReferences).map(([name, value]) => {
            const separator = value.lastIndexOf(':');
            if (separator <= 0) fail('SOURCE_INVALID');
            return { name, valueFrom: { secretKeyRef: { name: value.slice(0, separator), key: value.slice(separator + 1) } } };
        }),
    ];
    const body = {
        apiVersion: 'serving.knative.dev/v1',
        kind: 'Service',
        metadata: { name: live.runtime.service, generation: Number(live.runtime.generation), resourceVersion: live.runtime.resourceVersion, labels: {}, annotations: {} },
        spec: {
            template: {
                metadata: {
                    name: revision,
                    labels: {},
                    annotations: {
                        'autoscaling.knative.dev/maxScale': String(desiredRuntime.settings.maxInstances),
                        'capacity.identity-epoch/source-sha': sourceSha,
                        'capacity.identity-epoch/build-digest': desiredBuildDigest,
                        'capacity.identity-epoch/image-digest': canonicalDigest({ image: desiredImage }),
                    },
                },
                spec: {
                    serviceAccountName: desiredRuntime.identity.identity,
                    containerConcurrency: desiredRuntime.settings.concurrency,
                    timeoutSeconds: desiredRuntime.settings.timeoutSeconds,
                    containers: [{ image: desiredImage, env, resources: { limits: { cpu: desiredRuntime.settings.cpu, memory: desiredRuntime.settings.memory } } }],
                },
            },
            traffic: [
                { revisionName: live.runtime.latestReadyRevision!, percent: 100, tag: null },
                { revisionName: revision, percent: 0, tag: null },
            ],
        },
    };
    void role;
    return body;
}

function preparationObservation(pass: OwnerOldPass): PreparationObservation {
    const graph = accountGraph(pass);
    const queues = Object.fromEntries(ROLES.map(role => {
        const observation = pass.roles[role].queueObservation;
        return [role, {
            resource: observation.resource,
            state: observation.state,
            empty: observation.tasks.length === 0,
            complete: observation.complete,
        }];
    })) as PreparationObservation['queues'];
    const schedulers = Object.fromEntries(ROLES.map(role => {
        const observation = pass.roles[role].schedulerObservation;
        return [role, {
            resource: observation.resource,
            state: observation.state,
            pauseEpochMs: observation.pauseEpochMs,
            lastAttemptMs: observation.lastAttemptMs,
        }];
    })) as PreparationObservation['schedulers'];
    return Object.freeze({
        identityGraph: graph,
        readiness: {
            ready: pass.oldReadiness.dto.ready,
            analysisV2AdmissionEnabled: pass.oldReadiness.dto.analysisV2AdmissionEnabled,
            earlybirdWebhookAutoAdmissionEnabled: pass.oldReadiness.dto.earlybirdWebhookAutoAdmissionEnabled,
        },
        queues,
        schedulers,
        retention: {
            resource: pass.roles.preflight.retentionInput.resource,
            enabled: pass.roles.preflight.retentionInput.enabled,
        },
    });
}

function assertEpochPreconditions(pass: OwnerPass, nowMs: number): void {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('EVIDENCE_UNAVAILABLE');
    if (!pass.oldReadiness.dto.ready
        || pass.oldReadiness.dto.analysisV2AdmissionEnabled
        || pass.oldReadiness.dto.earlybirdWebhookAutoAdmissionEnabled) fail('READINESS_INVALID');
    if (!pass.roles.preflight.retentionInput.enabled
        || !pass.roles.paid.retentionInput.enabled
        || pass.roles.preflight.retentionInput.resource !== pass.roles.paid.retentionInput.resource) fail('RESOURCE_INVALID');
    for (const role of ROLES) {
        const live = pass.roles[role];
        if (live.queueObservation.state !== 'PAUSED' || !live.queueObservation.complete || live.queueObservation.tasks.length !== 0) fail('QUEUE_NOT_EMPTY');
        const scheduler = live.schedulerObservation;
        if (scheduler.state !== 'PAUSED' || scheduler.pauseEpochMs <= 0 || scheduler.pauseEpochMs > nowMs
            || nowMs - scheduler.pauseEpochMs < QUIESCENCE.timeoutMs + QUIESCENCE.graceMs
            || (scheduler.lastAttemptMs !== null && (scheduler.lastAttemptMs > nowMs || nowMs - scheduler.lastAttemptMs < QUIESCENCE.timeoutMs + QUIESCENCE.graceMs))) fail('QUIESCENCE_PENDING');
    }
}

function producerContract(role: Role, readiness: ReadinessContract): CapacityManifest['producer'][Role] {
    return {
        sourceSha: readiness.sourceSha,
        fingerprintVersion: `${role}-producer-config-v1`,
        fingerprint: role === 'preflight' ? readiness.preflightFingerprint : readiness.paidFingerprint,
        admissionEnabled: role === 'preflight' ? readiness.analysisV2AdmissionEnabled : readiness.earlybirdWebhookAutoAdmissionEnabled,
    };
}

function buildManifest(
    pass: OwnerPass,
    phase: 'old' | 'desired',
    graph: DesiredIdentityGraph,
    platform: ProtectedPlatformInputs,
    readiness: ReadinessContract,
    sourceContracts: Readonly<Record<Role, CapacityManifest['source'][Role]>>,
    retiredBindings: Readonly<Record<Role, readonly string[]>>,
): CapacityManifest {
    const roleSlots = roleSlotsForGraph(graph);
    const queues = Object.fromEntries(ROLES.map(role => [role, queueContract(pass.roles[role], platform.queues[role])])) as Record<Role, CapacityManifest['queues'][Role]>;
    const schedulers = Object.fromEntries(ROLES.map(role => [role, schedulerContract(pass.roles[role], platform.schedulers[role])])) as Record<Role, CapacityManifest['recoverySchedulers'][Role]>;
    const iam = Object.fromEntries(ROLES.map(role => [role, iamContract(platform.iam[role], retiredBindings[role] ?? [])])) as Record<Role, CapacityManifest['iam'][Role]>;
    const retention = {
        resource: platform.retention.resource,
        project: platform.retention.project,
        location: platform.retention.location,
        enabled: platform.retention.enabled,
        configDigest: canonicalDigest(platform.retention.configuration),
    };
    const build = platform.build.identity;
    if (build.project !== pass.project || graph.project !== pass.project) fail('PROJECT_MISMATCH');
    return Object.freeze({
        roleSlots,
        build,
        source: sourceContracts,
        producer: Object.fromEntries(ROLES.map(role => [role, producerContract(role, readiness)])) as Record<Role, CapacityManifest['producer'][Role]>,
        queues,
        recoverySchedulers: schedulers,
        retention,
        iam,
        readiness,
        // Keep the phase explicit at the call site so a future adapter cannot
        // accidentally swap a live build identity into the desired graph.
        ...(phase === 'old' ? {} : {}),
    });
}

function buildOldPlatform(pass: OwnerPass): ProtectedPlatformInputs {
    const runtime = Object.fromEntries(ROLES.map(role => [role, buildOldRuntime(role, pass.roles[role], pass.roles[role].oldBuild.input.sourceSha)])) as Record<Role, ProtectedRuntimeInput>;
    const queues = Object.fromEntries(ROLES.map(role => [role, pass.roles[role].queueInput])) as Record<Role, ProtectedQueueInput>;
    const schedulers = Object.fromEntries(ROLES.map(role => [role, pass.roles[role].schedulerInput])) as Record<Role, ProtectedSchedulerInput>;
    const iam = Object.fromEntries(ROLES.map(role => [role, oldIam(pass.roles[role])])) as ProtectedIamInputs;
    return Object.freeze({
        build: pass.roles.preflight.oldBuild.input,
        runtime,
        queues,
        schedulers,
        iam,
        retention: pass.roles.preflight.retentionInput,
    });
}

async function buildDesiredPlatform(pass: OwnerPass, graph: DesiredIdentityGraph, desiredSourceSha: string): Promise<ProtectedPlatformInputs> {
    const runtime = Object.fromEntries(ROLES.map(role => [role, buildDesiredRuntime(role, pass.roles[role], graph)])) as Record<Role, ProtectedRuntimeInput>;
    const queues = Object.fromEntries(ROLES.map(role => [role, buildDesiredQueue(pass.roles[role], graph)])) as Record<Role, ProtectedQueueInput>;
    const schedulers = Object.fromEntries(ROLES.map(role => [role, buildDesiredScheduler(pass.roles[role], graph)])) as Record<Role, ProtectedSchedulerInput>;
    if (Object.values(runtime).some(value => value.sourceSha !== desiredSourceSha)) fail('SOURCE_INVALID');
    const iamAdapter = new IamAdapter({ transport: pass.transports.google });
    const iamValues = await Promise.all(ROLES.map(role => buildDesiredIam(pass.roles[role], graph, iamAdapter)));
    const iam = Object.fromEntries(iamValues.map((value, index) => [ROLES[index]!, value])) as ProtectedIamInputs;
    return Object.freeze({
        build: pass.roles.preflight.desiredBuild.input,
        runtime,
        queues,
        schedulers,
        iam,
        retention: pass.roles.preflight.retentionInput,
    });
}

function buildOwnerScope(pass: OwnerPass): ProtectedProviderScope {
    const publicReadinessUrl = `https://${pass.alias}/api/analysis/capacity/readiness`;
    return Object.freeze({
        bucket: pass.bucket,
        publicReadinessUrl,
        googleProjectId: pass.project,
        vercelProjectId: pass.auth.vercelProjectId,
        vercelTeamId: pass.auth.vercelTeamId,
        vercelDeploymentId: pass.desiredDeployment.id,
        vercelExpectedOldDeploymentId: pass.oldDeployment.id,
        vercelProducerAlias: pass.alias,
    });
}

async function buildOwnerPacket(pass: OwnerPass, nowMs: number): Promise<Readonly<{
    packet: ReturnType<typeof createProtectedPacket>;
    serviceBodies: Readonly<Record<Role, Readonly<Record<string, unknown>>>>;
    identityGraph: DesiredIdentityGraph;
    zeroWorkEvidence: LiveZeroWorkSources;
}>> {
    assertEpochPreconditions(pass, nowMs);
    const oldSourceSha = pass.oldReadiness.contract.sourceSha;
    const desiredSourceSha = pass.desiredReadiness.contract.sourceSha;
    if (oldSourceSha !== pass.oldDeployment.sourceSha || desiredSourceSha !== pass.desiredDeployment.sourceSha
        || pass.oldReadiness.contract.legacyTargetResource !== pass.desiredReadiness.contract.legacyTargetResource) fail('SOURCE_INVALID');
    const oldGraph = accountGraph(pass);
    assertEnqueuerReadinessHashes(pass.oldReadiness.dto, oldGraph);
    const selection = selectDesiredIdentityGraph(oldGraph);
    if (selection.actions.length !== 0 || selection.missingAccounts.length !== 0) fail('EVIDENCE_UNAVAILABLE');
    const desiredGraph = selection.desired;
    assertEnqueuerReadinessHashes(pass.desiredReadiness.dto, desiredGraph);
    const oldInputs = buildOldPlatform(pass);
    const desiredInputs = await buildDesiredPlatform(pass, desiredGraph, desiredSourceSha);
    const sourceContracts = Object.fromEntries(ROLES.map(role => [role, sourceContract(
        role,
        pass.roles[role],
        pass.roles[role].oldBuild.input.sourceSha,
        desiredSourceSha,
        desiredInputs.runtime[role],
        desiredInputs.build,
    )])) as Record<Role, CapacityManifest['source'][Role]>;
    const oldManifest = buildManifest(pass, 'old', oldGraphToDesired(oldGraph), oldInputs, pass.oldReadiness.contract, sourceContracts, { preflight: [], paid: [] });
    const desiredManifestBase = buildManifest(pass, 'desired', desiredGraph, desiredInputs, pass.desiredReadiness.contract, sourceContracts, { preflight: [], paid: [] });
    const retired = deriveRetiredIamBindingDigests(oldManifest, desiredManifestBase, oldInputs);
    const desiredManifest = buildManifest(pass, 'desired', desiredGraph, desiredInputs, pass.desiredReadiness.contract, sourceContracts, retired);
    const zeroWorkEvidence = buildZeroWorkSources(pass.env, pass.project, pass.roles, nowMs, desiredGraph);
    const oldObservationsValue = oldObservations(pass, oldInputs, pass.oldReadiness);
    const desiredObservationsValue = desiredObservations(
        pass,
        desiredInputs,
        desiredSourceSha,
        desiredInputs.build,
        pass.desiredReadiness.contract,
        zeroWorkEvidence,
        sourceContracts,
    );
    const scope = buildOwnerScope(pass);
    const epochDigest = canonicalDigest({
        project: pass.project,
        alias: pass.alias,
        oldDeployment: pass.oldDeployment.id,
        desiredDeployment: pass.desiredDeployment.id,
        oldSourceSha,
        desiredSourceSha,
        // A corrected immutable revision plan is a new epoch. Preserve any
        // failed journal for the previous plan instead of reusing its key.
        sourceContracts,
    });
    const baseInput = {
        epochId: `identity-epoch-${epochDigest.slice(0, 48)}`,
        lockNamespace: `${pass.bucket}-identity-epoch`,
        roleSet: [...ROLES],
        oldManifest,
        desiredManifest,
        protectedInputs: { old: oldInputs, desired: desiredInputs },
        providerScope: scope,
        activation: { analysisV2AdmissionEnabled: true, earlybirdWebhookAutoAdmissionEnabled: true },
        quiescence: QUIESCENCE,
        protectedObservations: { old: oldObservationsValue, desired: desiredObservationsValue },
        probe: {
            bodyDigest: canonicalDigest('{'),
            expectedStatuses: { preflight: 400, paid: 400 } as const,
            expectedCodes: { preflight: 'INVALID_REQUEST', paid: 'INVALID_REQUEST' } as const,
        },
    };
    const packetInput = { ...baseInput, observationInputs: deriveObservationInputDigests(baseInput) } as ProtectedPacketInput;
    const packet = createProtectedPacket(packetInput);
    const serviceBodies = Object.fromEntries(ROLES.map(role => [role, buildServiceBody(
        role,
        pass.roles[role],
        desiredInputs.runtime[role],
        sourceContracts[role].desiredBuildDigest,
        pass.roles[role].desiredImage,
        desiredSourceSha,
        sourceContracts[role].revisionPlan,
    )])) as Record<Role, Readonly<Record<string, unknown>>>;
    // Descriptor assembly validates the bodies against this packet before the
    // protected values cross the inherited-FD boundary.
    return Object.freeze({ packet, serviceBodies, identityGraph: desiredGraph, zeroWorkEvidence });
}

/**
 * Epoch inspection must prove the selected zero-work sources are live before
 * a descriptor can be approved. This is deliberately a read-only collector
 * pass over the exact sink/table selectors that will be inherited later.
 */
async function assertOwnerZeroWorkCoverage(pass: OwnerPass, built: Readonly<{
    packet: ReturnType<typeof createProtectedPacket>;
    zeroWorkEvidence: LiveZeroWorkSources;
}>, nowMs: number, supabaseServiceRoleBearer: string): Promise<void> {
    const hosts = new Set<string>();
    for (const source of Object.values(built.zeroWorkEvidence)) {
        if (source.kind !== 'supabase') continue;
        let origin: URL;
        try { origin = new URL(source.origin); } catch { fail('EVIDENCE_UNAVAILABLE'); }
        if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port
            || origin.pathname !== '/' || origin.search || origin.hash) fail('EVIDENCE_UNAVAILABLE');
        hosts.add(origin.hostname);
    }
    if (hosts.size === 0) fail('EVIDENCE_UNAVAILABLE');
    const supabase = new AuthenticatedProtectedTransport({
        transport: new FetchProtectedTransport(),
        tokenProvider: async () => supabaseServiceRoleBearer,
        additionalAllowedHosts: hosts,
    });
    const cloudBuild = new CloudBuildAdapter({
        transport: pass.transports.google,
        storageSourceVerifier: pass.storageSourceVerifier,
        oldObservations: built.packet.protectedObservations.old,
        builds: { old: built.packet.protectedInputs.old.build, desired: built.packet.protectedInputs.desired.build },
        runtimes: { old: built.packet.protectedInputs.old.runtime, desired: built.packet.protectedInputs.desired.runtime },
    });
    const evidence = new LiveEvidenceCollector({
        cloudBuild,
        loggingTransport: pass.transports.google,
        tasksTransport: pass.transports.google,
        supabaseTransport: supabase,
        supabaseApiKey: supabaseServiceRoleBearer,
        sources: built.zeroWorkEvidence,
        frozenGates: createFrozenGateReader(built.packet, new VercelAdapter({
            transport: pass.transports.vercel, publicReadinessOrigin: `https://${pass.alias}`,
        })),
        receiverTokenProvider: async () => pass.auth.googleTokenProvider(),
        now: () => Date.now(),
    });
    try {
        await evidence.zeroWorkBaseline({ nowMs });
    } catch {
        // A descriptor is never approved from a selector-only claim. Provider
        // errors and incomplete coverage are intentionally indistinguishable.
        fail('EVIDENCE_UNAVAILABLE');
    }
}

function oldGraphToDesired(graph: IdentityGraphObservation): DesiredIdentityGraph {
    return Object.freeze({ project: graph.project, build: graph.build, slots: graph.slots });
}

async function readOwnerDescriptorPass(pass: OwnerPass, nowMs: number, supabaseWorkdir: string, supabaseCliPath: string): Promise<OwnerDescriptorAssemblyInput> {
    const built = await buildOwnerPacket(pass, nowMs);
    const ownerDigest = canonicalDigest({
        project: pass.project,
        vercelProjectId: pass.auth.vercelProjectId,
        vercelTeamId: pass.auth.vercelTeamId,
        alias: pass.alias,
    });
    const supabaseServiceRoleBearer = pass.env.SUPABASE_SERVICE_ROLE_KEY ?? (pass.supabaseServiceRoleSensitive
        ? await captureSupabaseServiceRoleKey({
            origin: pass.supabaseOrigin,
            workdir: supabaseWorkdir,
            command: supabaseCliPath,
        })
        : unavailable());
    await assertOwnerZeroWorkCoverage(pass, built, nowMs, supabaseServiceRoleBearer);
    const vercelToken = await pass.auth.vercelTokenProvider();
    const googleAccessToken = await pass.auth.googleTokenProvider();
    return Object.freeze({
        packet: built.packet,
        ownerDigest,
        googleAccessToken,
        vercelToken,
        serviceBodies: built.serviceBodies,
        zeroWorkEvidence: built.zeroWorkEvidence,
        supabaseServiceRoleBearer,
        supabaseApiKey: supabaseServiceRoleBearer,
        identityGraph: built.identityGraph,
    });
}

async function readAccountObservation(google: AuthenticatedProtectedTransport, expected: ProtectedIdentity): Promise<IdentityAccountObservation> {
    const resource = serviceAccountResource(expected.project, expected.identity);
    const path = `/v1/${resource}`;
    // IAM account and key-list indexes can become visible separately after
    // create. Retry exact reads only; never repeat the account mutation.
    const readIndexed = async (readPath: string): Promise<unknown> => {
        for (let attempt = 0; attempt < 24; attempt += 1) {
            const result = await google.json({ method: 'GET', url: `https://iam.googleapis.com${readPath}`, allowedHosts: new Set(['iam.googleapis.com']), allowedPath: candidate => candidate === readPath, allowedMethods: ['GET'], allowedQueryKeys: [], acceptedStatuses: [200, 404] });
            if (result.response.status === 200) return result.value;
            if (attempt === 23) fail('EVIDENCE_UNAVAILABLE');
            await new Promise(resolve => setTimeout(resolve, 2_000));
        }
        fail('EVIDENCE_UNAVAILABLE');
    };
    const account = object(await readIndexed(path));
    if (account.email !== expected.identity || (account.disabled !== undefined && typeof account.disabled !== 'boolean')) fail('OBSERVATION_RACE');
    const keyPath = `${path}/keys`;
    const keyValue = await readIndexed(keyPath);
    const keyBody = object(keyValue);
    if (keyBody.keys !== undefined && !Array.isArray(keyBody.keys)) fail('ADAPTER_RESPONSE_INVALID');
    const keys = (keyBody.keys ?? []).map(item => object(item));
    if (keys.some(item => item.keyType !== 'USER_MANAGED' && item.keyType !== 'SYSTEM_MANAGED')) fail('ADAPTER_RESPONSE_INVALID');
    return Object.freeze({
        identity: expected,
        enabled: account.disabled !== true,
        userManagedKeyCount: keys.filter(item => item.keyType === 'USER_MANAGED').length,
        attachedSlots: Object.freeze([]),
    });
}

async function createKeylessAccount(google: AuthenticatedProtectedTransport, input: Readonly<{ slot: Slot; identity: ProtectedIdentity }>): Promise<void> {
    if (!SLOTS.includes(input.slot) || input.identity.project !== input.identity.identity.split('@')[1]!.replace(/\.iam\.gserviceaccount\.com$/, '')) fail('IDENTITY_INVALID');
    const local = input.identity.identity.slice(0, input.identity.identity.indexOf('@'));
    if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(local)) fail('IDENTITY_INVALID');
    const path = `/v1/projects/${encodeURIComponent(input.identity.project)}/serviceAccounts`;
    const { value } = await google.json({
        method: 'POST', url: `https://iam.googleapis.com${path}`, allowedHosts: new Set(['iam.googleapis.com']), allowedPath: candidate => candidate === path,
        allowedMethods: ['POST'], allowedQueryKeys: [], acceptedStatuses: [200, 201], body: { accountId: local, serviceAccount: { displayName: local } },
    });
    if (isObject(value) && value.email !== undefined && value.email !== input.identity.identity) fail('OBSERVATION_RACE');
}

async function pauseRecoveryScheduler(google: AuthenticatedProtectedTransport, env: Env, role: Role, resource: string): Promise<void> {
    const selector = readRoleSelector(env, role);
    const expected = schedulerResource(role, selector);
    if (resource !== expected) fail('CAPABILITY_BINDING_MISMATCH');
    const before = await readSchedulerWire(google, resource);
    if (before.state !== 'ENABLED') fail('OBSERVATION_RACE');
    const path = `/v1/${resource}:pause`;
    await google.json({ method: 'POST', url: `https://cloudscheduler.googleapis.com${path}`, allowedHosts: new Set(['cloudscheduler.googleapis.com']), allowedPath: candidate => candidate === path, allowedMethods: ['POST'], allowedQueryKeys: [], acceptedStatuses: [200], body: {} });
}

async function readPreparationScheduler(google: AuthenticatedProtectedTransport, env: Env, now: () => number, role: Role, resource: string): Promise<PreparationObservation['schedulers'][Role]> {
    const selector = readRoleSelector(env, role);
    const expected = schedulerResource(role, selector);
    if (resource !== expected) fail('CAPABILITY_BINDING_MISMATCH');
    const raw = await readSchedulerWire(google, resource);
    const maintenance = identityFromWire(raw, selector.project);
    const input = schedulerInput(role, selector, raw, maintenance);
    const workPlanes = new WorkPlaneClient({ transport: google, pauseProvenance: pauseProvenanceReader(google, env, now), now, pauseProvenanceTimeoutMs: 60_000 });
    const observation = await workPlanes.observeScheduler(input);
    return Object.freeze({ resource: observation.resource, state: observation.state, pauseEpochMs: observation.pauseEpochMs, lastAttemptMs: observation.lastAttemptMs });
}

export type OwnerProductionCliDependencies = Readonly<{
    ownerAuth: OwnerAuthBoundary;
    preparation: Pick<OwnerPreparationOperator, 'inspect' | 'apply'>;
    readDescriptorPass: () => Promise<OwnerDescriptorAssemblyInput>;
    bridgeOptions?: OwnerFdBridgeOptions;
}>;

export type OwnerProductionCliOptions = Readonly<{
    cwd?: string;
    now?: () => number;
    /** Canonical in-memory selector seam; never persisted as production env. */
    resourceSelectorOverrides?: OwnerResourceSelectorOverrides;
    /** Exact desired deployment and native Vercel Git SHA for full descriptor reads. */
    desiredDeployment?: OwnerDesiredDeploymentSelector;
    /** In-memory seam for the old/desired public readiness reads. */
    publicReadinessTransport?: ProtectedTransport;
}>;

function factoryResourceSelectorOverrides(options: OwnerProductionCliOptions): OwnerResourceSelectorOverrides {
    return parseOwnerResourceSelectorOverrides(options.resourceSelectorOverrides);
}

export async function createOwnerProductionCliDependencies(options: OwnerProductionCliOptions = {}): Promise<OwnerProductionCliDependencies> {
    // Validate all caller-provided seams before touching owner credentials or
    // the filesystem. Overrides remain in memory and are merged only after
    // the authenticated production environment has been read.
    const resourceSelectorOverrides = factoryResourceSelectorOverrides(options);
    const desiredDeployment = parseOwnerDesiredDeploymentSelector(options.desiredDeployment);
    const paths = localCredentialPath(options.cwd ?? process.cwd());
    const ownerAuth = await loadOwnerAuthBoundary(paths);
    const transports = createOwnerProtectedTransports({
        vercelTokenProvider: ownerAuth.vercelTokenProvider,
        googleTokenProvider: ownerAuth.googleTokenProvider,
    });
    const now = options.now ?? (() => Date.now());
    const storageSourceVerifier = createStorageSourceVerifier({
        repoCwd: options.cwd ?? process.cwd(),
        tokenProvider: ownerAuth.googleTokenProvider,
    });
    const readOldPass = async (): Promise<OwnerOldPass> => (await readOwnerOldPass(
        ownerAuth, transports, now, storageSourceVerifier, resourceSelectorOverrides, options.publicReadinessTransport,
    )).pass;
    const readPass = async (): Promise<OwnerPass> => readOwnerPass(ownerAuth, transports, now, storageSourceVerifier, {
        cwd: paths.cwd,
        resourceSelectorOverrides,
        publicReadinessTransport: options.publicReadinessTransport,
        ...(desiredDeployment === undefined ? {} : { desiredDeployment }),
    });
    const discover = async (): Promise<PreparationObservation> => preparationObservation(await readOldPass());
    const readEffectiveEnv = async (): Promise<Env> => {
        const productionEnv = await readProductionEnv(transports.vercel, ownerAuth);
        return mergeOwnerResourceSelectorOverrides(productionEnv, resourceSelectorOverrides);
    };
    const mutate: PreparationMutator = {
        createAccount: input => createKeylessAccount(transports.google, input),
        readAccount: input => readAccountObservation(transports.google, input.identity),
        pauseScheduler: async input => pauseRecoveryScheduler(transports.google, await readEffectiveEnv(), input.role, input.resource),
        readScheduler: async input => {
            const env = await readEffectiveEnv();
            return readPreparationScheduler(transports.google, env, now, input.role, input.resource);
        },
    };
    const preparation = new OwnerPreparationOperator({ discover, mutate, now, quiescence: QUIESCENCE });
    const readDescriptorPass = async (): Promise<OwnerDescriptorAssemblyInput> => readOwnerDescriptorPass(await readPass(), now(), paths.supabaseWorkdir, paths.supabaseCliPath);
    return Object.freeze({ ownerAuth, preparation, readDescriptorPass });
}
