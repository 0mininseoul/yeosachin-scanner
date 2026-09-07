import { closeSync, constants as fsConstants, createReadStream, fstatSync, openSync, readSync } from 'node:fs';
import { Socket } from 'node:net';
import {
    MANIFEST_KEYS,
    ROLES,
    SLOTS,
    canonicalIamBindingDigests,
    canonicalIamPolicyDigest,
    canonicalQueueConfiguration,
    canonicalRuntimeInputDigest,
    canonicalDigest,
    epochFail,
    hasExactKeys,
    isDigest,
    isObject,
    isRole,
    isSha,
    type CapacityEpochPacket,
    type CapacityManifest,
    type EpochErrorCode,
    type ProtectedBuildInput,
    type ProtectedIamBinding,
    type ProtectedIamInput,
    type ProtectedIamPolicySnapshot,
    type ProtectedIdentity,
    type ProtectedIamInputs,
    type ProtectedObservationTargets,
    type ProtectedOldObservations,
    type ProtectedPlatformInputs,
    type ProtectedProviderScope,
    type ProtectedQueueInput,
    type ProtectedRetentionInput,
    type ProtectedRuntimeInput,
    type ProtectedSchedulerInput,
    type Role,
    type Slot,
    type RuntimeSettings,
} from './contracts';
import { EpochError } from './contracts';

export { ROLES, SLOTS } from './contracts';

const SERVICE_ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
const SCOPED_IAM_ROLES = new Set([
    'roles/run.invoker', 'roles/cloudtasks.enqueuer', 'roles/cloudtasks.viewer',
    'roles/iam.serviceAccountUser', 'roles/iam.serviceAccountTokenCreator',
]);
const IAM_ROLES_BY_KIND: Record<'run' | 'queue' | 'taskCaller' | 'maintenance', ReadonlySet<string>> = {
    run: new Set(['roles/run.invoker']),
    queue: new Set(['roles/cloudtasks.enqueuer', 'roles/cloudtasks.viewer']),
    taskCaller: new Set(['roles/iam.serviceAccountUser']),
    // The maintenance identity is a second private Run invoker.  It does not
    // receive a self-granted token-creator role.
    maintenance: new Set(['roles/run.invoker']),
};
const SOURCE_KEYS = [
    'oldSha', 'oldRevision', 'desiredSha', 'desiredBuildDigest', 'desiredRuntimeDigest',
    'desiredRuntimeEnvironment', 'desiredRuntimeSettings', 'revisionPlan', 'desiredRevisionId',
] as const;
const PRODUCER_KEYS = ['sourceSha', 'fingerprintVersion', 'fingerprint', 'admissionEnabled'] as const;
const QUEUE_KEYS = ['resource', 'project', 'location', 'targetDigest', 'configDigest', 'state', 'empty', 'tasksDigest'] as const;
const SCHEDULER_KEYS = ['resource', 'project', 'location', 'targetDigest', 'configDigest', 'state', 'pauseEpochMs', 'lastAttemptMs'] as const;
const RETENTION_KEYS = ['resource', 'project', 'location', 'enabled', 'configDigest'] as const;
const IAM_KEYS = ['policyDigest', 'desiredBindings', 'retiredBindings'] as const;
const READINESS_KEYS = [
    'schemaVersion', 'sourceSha', 'legacyTargetResource', 'preflightFingerprint', 'paidFingerprint',
    'analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled',
] as const;
const PLATFORM_KEYS = ['build', 'runtime', 'queues', 'schedulers', 'iam', 'retention'] as const;
const BUILD_INPUT_KEYS = ['identity', 'sourceSha', 'sourceContext', 'buildArguments'] as const;
const RUNTIME_INPUT_KEYS = [
    'role', 'service', 'project', 'location', 'identity', 'sourceSha', 'environment',
    'secretReferences', 'settings', 'target', 'noTraffic', 'providerAdmissionEnabled',
] as const;
const RUNTIME_SETTINGS_KEYS = ['cpu', 'memory', 'concurrency', 'timeoutSeconds', 'maxInstances'] as const;
const TARGET_KEYS = ['url', 'audience'] as const;
const QUEUE_INPUT_KEYS = ['resource', 'project', 'location', 'target', 'configuration'] as const;
const QUEUE_TARGET_KEYS = ['url', 'audience', 'callerIdentity'] as const;
const SCHEDULER_INPUT_KEYS = ['resource', 'project', 'location', 'target', 'configuration', 'state', 'pauseEpochMs', 'lastAttemptMs'] as const;
const SCHEDULER_TARGET_KEYS = ['uri', 'audience', 'identity'] as const;
const IAM_INPUT_KEYS = ['kind', 'resource', 'project', 'etag', 'bindings', 'previous'] as const;
const IAM_SNAPSHOT_KEYS = ['resource', 'project', 'etag', 'bindings'] as const;
const IAM_INPUT_MAP_KEYS = ['run', 'queue', 'taskCaller', 'maintenance'] as const;
const IAM_BINDING_KEYS = ['role', 'member', 'condition'] as const;
const RETENTION_INPUT_KEYS = ['resource', 'project', 'location', 'enabled', 'configuration'] as const;
const PROVIDER_SCOPE_KEYS = [
    'bucket', 'publicReadinessUrl', 'googleProjectId', 'vercelProjectId', 'vercelTeamId',
    'vercelDeploymentId', 'vercelExpectedOldDeploymentId', 'vercelProducerAlias',
] as const;
const PROVIDER_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const PROVIDER_RESOURCE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROVIDER_BUCKET_PATTERN = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const PROVIDER_ALIAS_PATTERN = /^[A-Za-z0-9.-]{1,253}$/;

const INITIAL_FIXED_RUNTIME_ENVIRONMENT: Readonly<Record<string, string>> = {
    ANALYSIS_CAPACITY_STAGE: 'initial',
    ANALYSIS_CAPACITY_EXPANSION_CANARY: 'false',
    ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
    ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
    ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
    ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED: 'true',
    ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED: 'true',
    ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED: 'true',
    ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
    ANALYSIS_BETA_PREPARE_ENABLED: 'false',
};
const PREFLIGHT_APIFY_SLOTS = [
    'primary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary', 'octonary', 'nonary', 'tenth',
] as const;
const APIFY_SLOTS = [
    'primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary', 'octonary', 'nonary', 'tenth',
] as const;
const FIXED_SECRET_REFERENCE_NAMES = [
    'SUPABASE_SERVICE_ROLE_KEY',
    'IMAGE_PROXY_SIGNING_SECRET',
    'ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET',
    'ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET',
] as const;
const OLD_OBSERVATION_KEYS = ['source', 'runtime', 'queues', 'schedulers', 'iam', 'retention', 'readiness'] as const;
const OBSERVATION_TARGET_KEYS = ['source', 'runtime', 'queues', 'schedulers', 'iam', 'retention', 'readiness', 'zeroWorkSources'] as const;
const SOURCE_OBSERVATION_KEYS = ['sourceSha', 'revision', 'metadataDigest'] as const;
const RUNTIME_OBSERVATION_KEYS = [
    'sourceSha', 'service', 'project', 'location', 'revision', 'generation', 'resourceVersion',
    'identity', 'providerAdmissionEnabled', 'noTraffic', 'runtimeDigest', 'buildDigest',
] as const;
const QUEUE_OBSERVATION_KEYS = ['resource', 'project', 'location', 'state', 'configuration', 'tasks', 'complete'] as const;
const TASK_OBSERVATION_KEYS = ['name', 'payloadDigest', 'createTime'] as const;
const SCHEDULER_OBSERVATION_KEYS = ['resource', 'project', 'location', 'state', 'pauseEpochMs', 'lastAttemptMs', 'configuration'] as const;
const ZERO_WORK_KEYS = ['windowStartMs', 'windowEndMs', 'complete', 'providerLedgerDigest', 'billingLedgerDigest', 'taskAuditDigest', 'receiverLogDigest'] as const;
const SOURCE_TARGET_KEYS = ['sourceSha', 'revisionPlan', 'desiredBuildDigest', 'desiredRuntimeDigest'] as const;
const EVIDENCE_SOURCE_KEYS = ['source', 'lookbackMs'] as const;
const PACKET_INPUT_KEYS = [
    'epochId', 'lockNamespace', 'roleSet', 'oldManifest', 'desiredManifest', 'protectedInputs', 'oldManifestDigest',
    'providerScope', 'desiredManifestDigest', 'capabilityDigest', 'roleSetDigest', 'sourcePlanDigest', 'activation',
    'quiescence', 'observationInputs', 'protectedObservations', 'probe',
] as const;

export type ProtectedPacketInput = Omit<CapacityEpochPacket,
    'oldManifestDigest' | 'desiredManifestDigest' | 'capabilityDigest' | 'roleSetDigest' | 'sourcePlanDigest'>;

export type CoordinatorCapability = object;
type CapabilityBinding = Readonly<{
    epochId: string;
    packetDigest: string;
    roleSetDigest: string;
    lockNamespace: string;
    ownerDigest: string;
}>;

const capabilityRegistry = new WeakMap<object, CapabilityBinding>();

function safeString(value: unknown, max = 512): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= max
        && !/[\u0000-\u001f\u007f]/.test(value);
}

function validDigest(value: unknown): value is string {
    return isDigest(value) && HEX_DIGEST.test(value);
}

function validateProviderScope(value: unknown): asserts value is ProtectedProviderScope {
    assertKeys(value, PROVIDER_SCOPE_KEYS, 'RESOURCE_INVALID');
    if (!PROVIDER_BUCKET_PATTERN.test(value.bucket as string)
        || !PROVIDER_PROJECT_PATTERN.test(value.googleProjectId as string)
        || !PROVIDER_RESOURCE_PATTERN.test(value.vercelProjectId as string)
        || !PROVIDER_RESOURCE_PATTERN.test(value.vercelTeamId as string)
        || !PROVIDER_RESOURCE_PATTERN.test(value.vercelDeploymentId as string)
        || !PROVIDER_RESOURCE_PATTERN.test(value.vercelExpectedOldDeploymentId as string)
        || !PROVIDER_ALIAS_PATTERN.test(value.vercelProducerAlias as string)
        || typeof value.bucket !== 'string'
        || typeof value.publicReadinessUrl !== 'string'
        || typeof value.googleProjectId !== 'string'
        || typeof value.vercelProjectId !== 'string'
        || typeof value.vercelTeamId !== 'string'
        || typeof value.vercelDeploymentId !== 'string'
        || typeof value.vercelExpectedOldDeploymentId !== 'string'
        || typeof value.vercelProducerAlias !== 'string') epochFail('RESOURCE_INVALID');
    let parsed: URL;
    try { parsed = new URL(value.publicReadinessUrl); } catch { epochFail('RESOURCE_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
        || parsed.pathname !== '/api/analysis/capacity/readiness') epochFail('RESOURCE_INVALID');
}

function assertKeys(value: unknown, keys: readonly string[], code: EpochErrorCode = 'INVALID_SCHEMA'): asserts value is Record<string, unknown> {
    if (!isObject(value) || !hasExactKeys(value, keys)) epochFail(code);
}

function validateProtectedIdentity(value: unknown): asserts value is ProtectedIdentity {
    assertKeys(value, ['identity', 'project'], 'IDENTITY_INVALID');
    if (typeof value.identity !== 'string' || typeof value.project !== 'string') epochFail('IDENTITY_INVALID');
    const match = value.identity.match(SERVICE_ACCOUNT_PATTERN);
    if (!match || match[1] !== value.project) epochFail('IDENTITY_INVALID');
}

function validateRuntimeSettings(value: unknown): asserts value is RuntimeSettings {
    if (!isObject(value) || !hasExactKeys(value, RUNTIME_SETTINGS_KEYS)
        || !safeString(value.cpu, 16) || !safeString(value.memory, 32)
        || !Number.isSafeInteger(value.concurrency) || (value.concurrency as number) <= 0
        || !Number.isSafeInteger(value.timeoutSeconds) || (value.timeoutSeconds as number) <= 0
        || !Number.isSafeInteger(value.maxInstances) || (value.maxInstances as number) <= 0) {
        epochFail('SOURCE_INVALID');
    }
}

function validateRuntimeEnvironment(value: unknown): asserts value is Record<string, string> {
    if (!isObject(value) || Object.keys(value).length === 0
        || Object.keys(value).some(key => !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(key))
        || !Object.values(value).every(item => safeString(item, 2048))) {
        epochFail('SOURCE_INVALID');
    }
    // Provider credentials must be represented only as exact numeric-pinned
    // secret references. A plaintext key in ordinary runtime env is invalid
    // even when every packet copy is changed together.
    const forbiddenSecretEnvNames = new Set([
        ...APIFY_SLOTS.map(slot => `APIFY_${slot.toUpperCase()}_API_TOKEN`),
        ...FIXED_SECRET_REFERENCE_NAMES,
    ]);
    if (Object.keys(value).some(key => forbiddenSecretEnvNames.has(key))) epochFail('SOURCE_INVALID');
}

function validateRevision(value: unknown): void {
    if (!isObject(value)
        || !hasExactKeys(value, SOURCE_KEYS.slice(0, -1))) {
        epochFail('SOURCE_INVALID');
    }
    if (!isSha(value.oldSha) || typeof value.oldRevision !== 'string' || !REVISION_PATTERN.test(value.oldRevision) || value.oldRevision === 'latest' || !isSha(value.desiredSha)
        || !validDigest(value.desiredBuildDigest) || !validDigest(value.desiredRuntimeDigest)
        || !isObject(value.revisionPlan)) epochFail('SOURCE_INVALID');
    validateRuntimeEnvironment(value.desiredRuntimeEnvironment);
    validateRuntimeSettings(value.desiredRuntimeSettings);
    assertKeys(value.revisionPlan, ['prefix', 'suffix'], 'SOURCE_INVALID');
    if (!safeString(value.revisionPlan.prefix, 64)
        || !safeString(value.revisionPlan.suffix, 64)) {
        epochFail('SOURCE_INVALID');
    }
}

function validateProducer(value: unknown, role: Role): void {
    assertKeys(value, PRODUCER_KEYS);
    if (!isSha(value.sourceSha) || !safeString(value.fingerprintVersion, 96)
        || !validDigest(value.fingerprint) || typeof value.admissionEnabled !== 'boolean'
        || value.fingerprintVersion !== `${role}-producer-config-v1`) {
        epochFail('SOURCE_INVALID');
    }
}

function validateQueue(value: unknown): void {
    assertKeys(value, QUEUE_KEYS);
    if (!safeString(value.resource) || !safeString(value.project) || !safeString(value.location)
        || !validDigest(value.targetDigest) || !validDigest(value.configDigest) || typeof value.state !== 'string'
        || !['PAUSED', 'RUNNING'].includes(value.state)
        || typeof value.empty !== 'boolean' || !validDigest(value.tasksDigest)
        || (value.empty === true && value.tasksDigest !== canonicalDigest([]))) {
        epochFail('RESOURCE_INVALID');
    }
}

function validateScheduler(value: unknown): void {
    assertKeys(value, SCHEDULER_KEYS);
    const pauseEpochMs = value.pauseEpochMs as unknown;
    const lastAttemptMs = value.lastAttemptMs as unknown;
    if (!safeString(value.resource) || !safeString(value.project) || !safeString(value.location)
        || !validDigest(value.targetDigest) || !validDigest(value.configDigest) || typeof value.state !== 'string'
        || !['PAUSED', 'ENABLED'].includes(value.state)
        || !Number.isSafeInteger(pauseEpochMs) || (pauseEpochMs as number) < 0
        || (value.state === 'PAUSED' && (pauseEpochMs as number) <= 0)
        || (lastAttemptMs !== null
            && (!Number.isSafeInteger(lastAttemptMs) || (lastAttemptMs as number) < 0))) {
        epochFail('RESOURCE_INVALID');
    }
}

function validateRetention(value: unknown): void {
    assertKeys(value, RETENTION_KEYS);
    if (!safeString(value.resource) || !safeString(value.project) || !safeString(value.location)
        || typeof value.enabled !== 'boolean' || !validDigest(value.configDigest)) epochFail('RESOURCE_INVALID');
}

function validateIam(value: unknown): void {
    assertKeys(value, IAM_KEYS);
    if (!validDigest(value.policyDigest) || !Array.isArray(value.desiredBindings)
        || !Array.isArray(value.retiredBindings)
        || !value.desiredBindings.every(item => validDigest(item))
        || !value.retiredBindings.every(item => validDigest(item))) epochFail('RESOURCE_INVALID');
}

function validateReadiness(value: unknown): void {
    assertKeys(value, READINESS_KEYS);
    if (value.schemaVersion !== 'analysis-public-freeze-readiness-v3'
        || !isSha(value.sourceSha)
        || !safeString(value.legacyTargetResource)
        || !validDigest(value.preflightFingerprint)
        || !validDigest(value.paidFingerprint)
        || typeof value.analysisV2AdmissionEnabled !== 'boolean'
        || typeof value.earlybirdWebhookAutoAdmissionEnabled !== 'boolean') epochFail('READINESS_INVALID');
}

export function validateManifest(value: unknown): asserts value is CapacityManifest {
    assertKeys(value, MANIFEST_KEYS);
    if (!isObject(value.roleSlots) || !hasExactKeys(value.roleSlots, SLOTS)) epochFail('INVALID_SCHEMA');
    for (const slot of SLOTS) validateProtectedIdentity(value.roleSlots[slot]);
    validateProtectedIdentity(value.build);
    if (!isObject(value.source) || !hasExactKeys(value.source, ROLES)) epochFail('SOURCE_INVALID');
    if (!isObject(value.producer) || !hasExactKeys(value.producer, ROLES)) epochFail('SOURCE_INVALID');
    if (!isObject(value.queues) || !hasExactKeys(value.queues, ROLES)) epochFail('RESOURCE_INVALID');
    if (!isObject(value.recoverySchedulers) || !hasExactKeys(value.recoverySchedulers, ROLES)) epochFail('RESOURCE_INVALID');
    if (!isObject(value.iam) || !hasExactKeys(value.iam, ROLES)) epochFail('RESOURCE_INVALID');
    for (const role of ROLES) {
        validateRevision(value.source[role]);
        validateProducer(value.producer[role], role);
        validateQueue(value.queues[role]);
        validateScheduler(value.recoverySchedulers[role]);
        validateIam(value.iam[role]);
    }
    validateRetention(value.retention);
    validateReadiness(value.readiness);
    const readiness = value.readiness as Record<string, unknown>;
    for (const role of ROLES) {
        const producer = value.producer[role] as Record<string, unknown>;
        if (producer.sourceSha !== readiness.sourceSha
            || producer.fingerprint !== (role === 'preflight' ? readiness.preflightFingerprint : readiness.paidFingerprint)
            || producer.admissionEnabled !== (role === 'preflight' ? readiness.analysisV2AdmissionEnabled : readiness.earlybirdWebhookAutoAdmissionEnabled)) {
            epochFail('SOURCE_INVALID');
        }
    }
    const buildIdentity = value.build as unknown as ProtectedIdentity;
    const firstSlotIdentity = value.roleSlots[SLOTS[0]] as unknown as ProtectedIdentity;
    if (buildIdentity.identity === firstSlotIdentity.identity) {
        // The complete comparison below reports the same safe code, but this
        // early check avoids treating build identity as a workload principal.
        epochFail('IDENTITY_CONFLICT');
    }
}

function validateUrl(value: unknown, uri = false): asserts value is string {
    if (typeof value !== 'string' || value.length > 2048) epochFail('RESOURCE_INVALID');
    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        epochFail('RESOURCE_INVALID');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash
        || (!uri && parsed.search)) epochFail('RESOURCE_INVALID');
}

function roleWorkerPath(role: Role): string {
    return role === 'preflight' ? '/api/analysis/preflight/worker' : '/api/analysis/v2/worker';
}

function roleRecoveryPath(role: Role): string {
    return role === 'preflight' ? '/api/analysis/preflight/recover' : '/api/analysis/v2/recover';
}

function validateRoleWorkerTarget(value: unknown, role: Role): void {
    if (!isObject(value)) epochFail('RESOURCE_INVALID');
    validateUrl(value.url);
    validateUrl(value.audience);
    const url = new URL(value.url as string);
    const audience = new URL(value.audience as string);
    if (url.pathname !== roleWorkerPath(role) || url.origin !== audience.origin || audience.pathname !== '/') epochFail('RESOURCE_INVALID');
}

function validateRoleRecoveryTarget(value: unknown, role: Role): void {
    if (!isObject(value)) epochFail('RESOURCE_INVALID');
    validateUrl(value.uri, true);
    validateUrl(value.audience);
    const uri = new URL(value.uri as string);
    const audience = new URL(value.audience as string);
    if (uri.pathname !== roleRecoveryPath(role) || uri.origin !== audience.origin || audience.pathname !== '/') epochFail('RESOURCE_INVALID');
    validateProtectedIdentity(value.identity);
}

function validateConfigObject(value: unknown): asserts value is Record<string, unknown> {
    if (!isObject(value) || Object.keys(value).length === 0) epochFail('RESOURCE_INVALID');
    // Canonicalization detects cycles/non-finite values while keeping the
    // actual protected configuration in memory for the live adapter.
    canonicalDigest(value);
}

function validateBuildInput(value: unknown): asserts value is ProtectedBuildInput {
    assertKeys(value, BUILD_INPUT_KEYS, 'SOURCE_INVALID');
    validateProtectedIdentity(value.identity);
    if (!isSha(value.sourceSha) || !safeString(value.sourceContext, 2048)
        || !isObject(value.buildArguments)
        || !Object.values(value.buildArguments).every(item => safeString(item, 2048))) epochFail('SOURCE_INVALID');
}

function validateRuntimeInput(value: unknown, role: Role): asserts value is ProtectedRuntimeInput {
    assertKeys(value, RUNTIME_INPUT_KEYS, 'SOURCE_INVALID');
    if (value.role !== role || !safeString(value.service, 128) || !safeString(value.project, 128)
        || !safeString(value.location, 128) || !isSha(value.sourceSha)) epochFail('SOURCE_INVALID');
    validateProtectedIdentity(value.identity);
    const environment = value.environment as Record<string, unknown>;
    if (!isObject(value.environment) || !Object.values(environment).every(item => typeof item === 'string')
        || environment.ANALYSIS_WORKLOAD_ROLE !== role
        || !isObject(value.secretReferences) || !Object.values(value.secretReferences).every(item => typeof item === 'string' && /^.{1,240}:[1-9][0-9]*$/.test(item))
        || !isObject(value.target) || !hasExactKeys(value.target, TARGET_KEYS)) epochFail('SOURCE_INVALID');
    validateRuntimeSettings(value.settings);
    validateRoleWorkerTarget(value.target, role);
    if (typeof value.noTraffic !== 'boolean' || typeof value.providerAdmissionEnabled !== 'boolean'
        || environment.ANALYSIS_PROVIDER_ADMISSION_ENABLED !== String(value.providerAdmissionEnabled)) epochFail('SOURCE_INVALID');
}

function validateDesiredInitialRuntimeContract(
    role: Role,
    runtime: ProtectedRuntimeInput,
    queue: ProtectedQueueInput,
    scheduler: ProtectedSchedulerInput,
    expectedEnvironment: Readonly<Record<string, string>>,
    expectedSettings: RuntimeSettings,
): void {
    // Stage, freeze, and gate semantics are fixed by the approved INITIAL
    // epoch.  CPU/memory remain reviewed manifest values and are checked
    // against the protected settings below rather than a process default.
    for (const [key, expected] of Object.entries(INITIAL_FIXED_RUNTIME_ENVIRONMENT)) {
        if (expectedEnvironment[key] !== expected || runtime.environment[key] !== expected) epochFail('SOURCE_INVALID');
    }
    const expectedGates: Readonly<Record<string, string>> = {
        PREFLIGHT_TASKS_ENABLED: role === 'preflight' ? 'true' : 'false',
        ANALYSIS_V2_TASKS_ENABLED: role === 'paid' ? 'true' : 'false',
        ANALYSIS_V2_WORKER_ENABLED: role === 'paid' ? 'true' : 'false',
        PREFLIGHT_TASKS_RECOVERY_ENABLED: role === 'preflight' ? 'true' : 'false',
        ANALYSIS_V2_RECOVERY_ENABLED: role === 'paid' ? 'true' : 'false',
    };
    for (const [key, expected] of Object.entries(expectedGates)) {
        if (expectedEnvironment[key] !== expected || runtime.environment[key] !== expected) epochFail('SOURCE_INVALID');
    }
    if (expectedEnvironment.ANALYSIS_WORKLOAD_ROLE !== role
        || runtime.environment.ANALYSIS_WORKLOAD_ROLE !== role
        || expectedEnvironment.ANALYSIS_CAPACITY_WORKER_CPU !== expectedSettings.cpu
        || expectedEnvironment.ANALYSIS_CAPACITY_WORKER_MEMORY !== expectedSettings.memory
        || runtime.environment.ANALYSIS_CAPACITY_WORKER_CPU !== runtime.settings.cpu
        || runtime.environment.ANALYSIS_CAPACITY_WORKER_MEMORY !== runtime.settings.memory
        || canonicalDigest(runtime.settings) !== canonicalDigest(expectedSettings)) epochFail('SOURCE_INVALID');

    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const maintenancePrefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2';
    const queueName = queue.resource.slice(queue.resource.lastIndexOf('/') + 1);
    const expectedResourceEnvironment: Readonly<Record<string, string>> = {
        [`${prefix}_PROJECT`]: runtime.project,
        [`${prefix}_LOCATION`]: runtime.location,
        [`${prefix}_QUEUE`]: queueName,
        [`${prefix}_TARGET_URL`]: runtime.target.url,
        [`${prefix}_OIDC_AUDIENCE`]: runtime.target.audience,
        [`${prefix}_SERVICE_ACCOUNT_EMAIL`]: queue.target.callerIdentity.identity,
        [`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL`]: scheduler.target.identity.identity,
        [`${maintenancePrefix}_MAINTENANCE_OIDC_AUDIENCE`]: scheduler.target.audience,
    };
    for (const [key, expected] of Object.entries(expectedResourceEnvironment)) {
        if (expectedEnvironment[key] !== expected || runtime.environment[key] !== expected) epochFail('SOURCE_INVALID');
    }
    if (expectedSettings.concurrency !== 1
        || expectedSettings.timeoutSeconds !== 600
        || expectedSettings.maxInstances !== (role === 'preflight' ? 32 : 8)) epochFail('SOURCE_INVALID');

    const selectedSlot = expectedEnvironment.ANALYSIS_V2_APIFY_API_TOKEN_SLOT;
    const requiredApifySlots = role === 'preflight' ? PREFLIGHT_APIFY_SLOTS : APIFY_SLOTS;
    if (role === 'paid' && selectedSlot !== 'secondary') epochFail('SOURCE_INVALID');
    if (role === 'preflight' && !PREFLIGHT_APIFY_SLOTS.includes(selectedSlot as typeof PREFLIGHT_APIFY_SLOTS[number])) epochFail('SOURCE_INVALID');
    if (role === 'preflight'
        && expectedEnvironment.PREFLIGHT_APIFY_API_TOKEN_SLOTS !== PREFLIGHT_APIFY_SLOTS.join(',')) epochFail('SOURCE_INVALID');
    if (role === 'paid' && Object.prototype.hasOwnProperty.call(expectedEnvironment, 'PREFLIGHT_APIFY_API_TOKEN_SLOTS')) epochFail('SOURCE_INVALID');
    const expectedSecretNames = [
        ...requiredApifySlots.map(slot => `APIFY_${slot.toUpperCase()}_API_TOKEN`),
        ...FIXED_SECRET_REFERENCE_NAMES,
    ].sort();
    const actualSecretNames = Object.keys(runtime.secretReferences).sort();
    if (actualSecretNames.length !== expectedSecretNames.length
        || actualSecretNames.some((name, index) => name !== expectedSecretNames[index])) epochFail('SOURCE_INVALID');
    if (!Object.values(runtime.secretReferences).every(reference => /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}:[1-9][0-9]*$/.test(reference))) epochFail('SOURCE_INVALID');
}

function validateQueueInput(value: unknown, role: Role): asserts value is ProtectedQueueInput {
    assertKeys(value, QUEUE_INPUT_KEYS, 'RESOURCE_INVALID');
    if (!safeString(value.resource) || !RESOURCE_PATTERN.test(value.resource)
        || !safeString(value.project, 128) || !safeString(value.location, 128)
        || !isObject(value.target) || !hasExactKeys(value.target, QUEUE_TARGET_KEYS)) epochFail('RESOURCE_INVALID');
    validateRoleWorkerTarget(value.target, role);
    validateProtectedIdentity(value.target.callerIdentity);
    validateConfigObject(value.configuration);
}

function validateSchedulerInput(value: unknown, role: Role): asserts value is ProtectedSchedulerInput {
    assertKeys(value, SCHEDULER_INPUT_KEYS, 'RESOURCE_INVALID');
    if (!safeString(value.resource) || !RESOURCE_PATTERN.test(value.resource)
        || !safeString(value.project, 128) || !safeString(value.location, 128)
        || !isObject(value.target) || !hasExactKeys(value.target, SCHEDULER_TARGET_KEYS)) epochFail('RESOURCE_INVALID');
    validateRoleRecoveryTarget(value.target, role);
    validateConfigObject(value.configuration);
    const pauseEpochMs = value.pauseEpochMs as unknown;
    const lastAttemptMs = value.lastAttemptMs as unknown;
    if (typeof value.state !== 'string' || !['PAUSED', 'ENABLED'].includes(value.state)
        || !Number.isSafeInteger(pauseEpochMs) || (pauseEpochMs as number) < 0
        || (value.state === 'PAUSED' && (pauseEpochMs as number) <= 0)
        || (lastAttemptMs !== null
            && (!Number.isSafeInteger(lastAttemptMs) || (lastAttemptMs as number) < 0))) epochFail('RESOURCE_INVALID');
}

const CLOUD_TASKS_SERVICE_AGENT = /^serviceAccount:service-([0-9]{6,20})@gcp-sa-cloudtasks\.iam\.gserviceaccount\.com$/;
const PRINCIPAL_MEMBER = /^(?:user|group|domain|principal|principalSet):[^\u0000-\u001f\u007f]{1,511}$/;
const DELETED_MEMBER = /^deleted:(?:user|group|domain|serviceAccount|principal|principalSet):[^\s\u0000-\u001f\u007f]{1,1023}$/;

function validateIamBinding(value: unknown, expectedProject?: string): asserts value is ProtectedIamBinding {
    assertKeys(value, IAM_BINDING_KEYS, 'RESOURCE_INVALID');
    if (!safeString(value.role, 256) || !/^roles\/[A-Za-z0-9.]{1,240}$/.test(value.role)
        || !safeString(value.member, 1024)
        || (value.condition !== null && typeof value.condition !== 'string' && !isObject(value.condition))) {
        epochFail('RESOURCE_INVALID');
    }
    if (typeof value.condition === 'string' && !safeString(value.condition, 4096)) epochFail('RESOURCE_INVALID');
    if (isObject(value.condition)) {
        if (!Object.keys(value.condition).every(key => ['title', 'description', 'expression'].includes(key))
            || !Object.values(value.condition).every(item => typeof item === 'string' && safeString(item, 4096))) epochFail('RESOURCE_INVALID');
    }
    if (value.member.startsWith('serviceAccount:')) {
        const member = value.member.slice('serviceAccount:'.length);
        const serviceAgent = value.member.match(CLOUD_TASKS_SERVICE_AGENT);
        const match = member.match(SERVICE_ACCOUNT_PATTERN);
        if (serviceAgent) return;
        if (!match || (expectedProject !== undefined && match[1] !== expectedProject)) epochFail('IDENTITY_INVALID');
        return;
    }
    if (!PRINCIPAL_MEMBER.test(value.member) && !DELETED_MEMBER.test(value.member)
        && value.member !== 'allUsers' && value.member !== 'allAuthenticatedUsers') {
        epochFail('RESOURCE_INVALID');
    }
}

function validateIamSnapshot(value: unknown, expectedProject?: string): asserts value is ProtectedIamPolicySnapshot {
    assertKeys(value, IAM_SNAPSHOT_KEYS, 'RESOURCE_INVALID');
    if (!safeString(value.resource) || !RESOURCE_PATTERN.test(value.resource)
        || !safeString(value.project, 128) || !safeString(value.etag, 512)
        || !Array.isArray(value.bindings)) epochFail('RESOURCE_INVALID');
    if (expectedProject !== undefined && value.project !== expectedProject) epochFail('PROJECT_MISMATCH');
    for (const binding of value.bindings) validateIamBinding(binding, expectedProject);
}

function validateIamInput(value: unknown, expectedProject?: string, expectedKind?: ProtectedIamInput['kind']): asserts value is ProtectedIamInput {
    assertKeys(value, IAM_INPUT_KEYS, 'RESOURCE_INVALID');
    if ((value.kind !== 'run' && value.kind !== 'queue' && value.kind !== 'taskCaller' && value.kind !== 'maintenance')
        || (expectedKind !== undefined && value.kind !== expectedKind)
        || !safeString(value.resource) || !RESOURCE_PATTERN.test(value.resource)
        || !safeString(value.project, 128) || !safeString(value.etag, 512)
        || !Array.isArray(value.bindings)
        || (value.previous !== null && !isObject(value.previous))) epochFail('RESOURCE_INVALID');
    if (expectedProject !== undefined && value.project !== expectedProject) epochFail('PROJECT_MISMATCH');
    for (const binding of value.bindings) validateIamBinding(binding, expectedProject);
    if (value.previous !== null) validateIamSnapshot(value.previous, expectedProject);
}

function validateRetentionInput(value: unknown): asserts value is ProtectedRetentionInput {
    assertKeys(value, RETENTION_INPUT_KEYS, 'RESOURCE_INVALID');
    if (!safeString(value.resource) || !RESOURCE_PATTERN.test(value.resource)
        || !safeString(value.project, 128) || !safeString(value.location, 128)
        || typeof value.enabled !== 'boolean') epochFail('RESOURCE_INVALID');
    validateConfigObject(value.configuration);
}

function validateQualifiedResource(resource: string, project: string): void {
    const match = resource.match(/^projects\/([^/]+)\/.+/);
    if (!match || match[1] !== project) epochFail('PROJECT_MISMATCH');
}

function validateScopedResource(resource: string, project: string, location: string, kind: 'queues' | 'jobs' | 'services'): void {
    const namePattern = kind === 'queues' ? '[A-Za-z0-9_-]{1,100}' : kind === 'jobs' ? '[A-Za-z0-9_-]{1,500}' : '[a-z][a-z0-9-]{0,62}';
    const match = resource.match(new RegExp(`^projects/([^/]+)/locations/([^/]+)\\/(queues|jobs|services)\\/(${namePattern})$`));
    if (!match || match[1] !== project || match[2] !== location || match[3] !== kind) epochFail('RESOURCE_INVALID');
}

function validateServiceAccountResource(resource: string, project: string, identity: string): void {
    if (resource !== `projects/${project}/serviceAccounts/${identity}`) epochFail('RESOURCE_INVALID');
}

function validatePlatformInputs(value: unknown, manifest: CapacityManifest, phase: 'old' | 'desired' = 'old'): asserts value is ProtectedPlatformInputs {
    assertKeys(value, PLATFORM_KEYS, 'INVALID_PACKET');
    validateBuildInput(value.build);
    validateProtectedIdentity(manifest.build);
    if (value.build.identity.identity !== manifest.build.identity
        || value.build.identity.project !== manifest.build.project) epochFail('SOURCE_INVALID');
    const expectedProject = manifest.build.project;
    if (value.build.identity.project !== expectedProject) epochFail('PROJECT_MISMATCH');
    if (phase === 'desired') {
        const expectedBuildSource = manifest.source[ROLES[0]].desiredSha;
        if (value.build.sourceSha !== expectedBuildSource
            || !ROLES.every(role => manifest.source[role].desiredSha === expectedBuildSource)) epochFail('SOURCE_INVALID');
    }
    if (!isObject(value.runtime) || !hasExactKeys(value.runtime, ROLES)
        || !isObject(value.queues) || !hasExactKeys(value.queues, ROLES)
        || !isObject(value.schedulers) || !hasExactKeys(value.schedulers, ROLES)
        || !isObject(value.iam) || !hasExactKeys(value.iam, ROLES)) epochFail('INVALID_PACKET');
    const runtimeInputs = value.runtime as ProtectedPlatformInputs['runtime'];
    const queueInputs = value.queues as ProtectedPlatformInputs['queues'];
    const schedulerInputs = value.schedulers as ProtectedPlatformInputs['schedulers'];
    const iamInputs = value.iam as ProtectedPlatformInputs['iam'];
    for (const role of ROLES) {
        validateRuntimeInput(runtimeInputs[role], role);
        const expectedSourceSha = phase === 'desired' ? manifest.source[role].desiredSha : manifest.source[role].oldSha;
        if (runtimeInputs[role].sourceSha !== expectedSourceSha) epochFail('SOURCE_INVALID');
        if (phase === 'desired' && runtimeInputs[role].providerAdmissionEnabled !== true) epochFail('SOURCE_INVALID');
        if (phase === 'desired'
            && (canonicalDigest(value.build) !== manifest.source[role].desiredBuildDigest
                || canonicalRuntimeInputDigest(runtimeInputs[role]) !== manifest.source[role].desiredRuntimeDigest)) epochFail('SOURCE_INVALID');
        validateQueueInput(queueInputs[role], role);
        validateSchedulerInput(schedulerInputs[role], role);
        validateScopedResource(queueInputs[role].resource, expectedProject, queueInputs[role].location, 'queues');
        validateScopedResource(schedulerInputs[role].resource, expectedProject, schedulerInputs[role].location, 'jobs');
        if (queueInputs[role].resource !== manifest.queues[role].resource
            || schedulerInputs[role].resource !== manifest.recoverySchedulers[role].resource
            || canonicalDigest(queueInputs[role].target) !== manifest.queues[role].targetDigest
            || canonicalDigest(schedulerInputs[role].target) !== manifest.recoverySchedulers[role].targetDigest) epochFail('RESOURCE_INVALID');
        if (manifest.queues[role].configDigest !== canonicalDigest(canonicalQueueConfiguration(queueInputs[role].configuration))) epochFail('RESOURCE_INVALID');
        if (manifest.recoverySchedulers[role].configDigest !== canonicalDigest(schedulerInputs[role].configuration)) epochFail('RESOURCE_INVALID');
        if (phase === 'desired' && runtimeInputs[role].noTraffic !== true) epochFail('SOURCE_INVALID');
        if (phase === 'desired') {
            if (canonicalDigest(runtimeInputs[role].environment)
                !== canonicalDigest(manifest.source[role].desiredRuntimeEnvironment)
                || canonicalDigest(runtimeInputs[role].settings)
                !== canonicalDigest(manifest.source[role].desiredRuntimeSettings)) epochFail('SOURCE_INVALID');
            validateDesiredInitialRuntimeContract(
                role,
                runtimeInputs[role],
                queueInputs[role],
                schedulerInputs[role],
                manifest.source[role].desiredRuntimeEnvironment,
                manifest.source[role].desiredRuntimeSettings,
            );
        }
        if (!isObject(iamInputs[role]) || !hasExactKeys(iamInputs[role], IAM_INPUT_MAP_KEYS)) epochFail('RESOURCE_INVALID');
        for (const kind of IAM_INPUT_MAP_KEYS) validateIamInput(iamInputs[role][kind], expectedProject, kind);
        const manifestIam = manifest.iam[role];
        const expectedIamBindings = canonicalIamBindingDigests(iamInputs[role]);
        if (manifestIam.policyDigest !== canonicalIamPolicyDigest(iamInputs[role])
            || manifestIam.desiredBindings.length !== expectedIamBindings.length
            || manifestIam.desiredBindings.some((digest, index) => digest !== expectedIamBindings[index])) epochFail('RESOURCE_INVALID');
        validateScopedResource(iamInputs[role].run.resource, expectedProject, runtimeInputs[role].location, 'services');
        validateScopedResource(iamInputs[role].maintenance.resource, expectedProject, runtimeInputs[role].location, 'services');
        validateScopedResource(iamInputs[role].queue.resource, expectedProject, queueInputs[role].location, 'queues');
        validateServiceAccountResource(iamInputs[role].taskCaller.resource, expectedProject, queueInputs[role].target.callerIdentity.identity);
        if (iamInputs[role].run.resource !== iamInputs[role].maintenance.resource
            || iamInputs[role].run.project !== iamInputs[role].maintenance.project
            || iamInputs[role].run.etag !== iamInputs[role].maintenance.etag
            || canonicalDigest(iamInputs[role].run.bindings) !== canonicalDigest(iamInputs[role].maintenance.bindings)) epochFail('RESOURCE_INVALID');
        if (runtimeInputs[role].project !== expectedProject
            || runtimeInputs[role].identity.project !== expectedProject
            || queueInputs[role].project !== expectedProject
            || queueInputs[role].target.callerIdentity.project !== expectedProject
            || schedulerInputs[role].project !== expectedProject
            || schedulerInputs[role].target.identity.project !== expectedProject) epochFail('PROJECT_MISMATCH');
        validateQualifiedResource(queueInputs[role].resource, expectedProject);
        validateQualifiedResource(schedulerInputs[role].resource, expectedProject);
        for (const kind of IAM_INPUT_MAP_KEYS) validateQualifiedResource(iamInputs[role][kind].resource, expectedProject);
        if (runtimeInputs[role].identity.identity !== manifest.roleSlots[`${role}.runtime` as Slot].identity
            || queueInputs[role].target.callerIdentity.identity !== manifest.roleSlots[`${role}.task-caller` as Slot].identity
            || schedulerInputs[role].target.identity.identity !== manifest.roleSlots[`${role}.maintenance` as Slot].identity) epochFail('IDENTITY_CONFLICT');
    }
    validateRetentionInput(value.retention);
    validateScopedResource(value.retention.resource, expectedProject, value.retention.location, 'jobs');
    if (manifest.retention.configDigest !== canonicalDigest(value.retention.configuration)) epochFail('RESOURCE_INVALID');
    if (value.retention.project !== expectedProject) epochFail('PROJECT_MISMATCH');
    validateQualifiedResource(value.retention.resource, expectedProject);
    validateScopedIamGraph(value as ProtectedPlatformInputs, manifest);
}

function bindingKey(binding: ProtectedIamBinding): string {
    return canonicalDigest(binding);
}

function bindingSet(bindings: readonly ProtectedIamBinding[]): Set<string> {
    return new Set(bindings.map(bindingKey));
}

function validateScopedIamGraph(value: ProtectedPlatformInputs, manifest: CapacityManifest): void {
    for (const role of ROLES) {
        const resources = value.iam[role];
        const runtimeIdentity = manifest.roleSlots[`${role}.runtime` as Slot].identity;
        const taskCallerIdentity = manifest.roleSlots[`${role}.task-caller` as Slot].identity;
        const enqueuerIdentity = manifest.roleSlots[`${role}.enqueuer` as Slot].identity;
        const maintenanceIdentity = manifest.roleSlots[`${role}.maintenance` as Slot].identity;
        const has = (kind: keyof typeof resources, requiredRole: string, member: string): boolean =>
            resources[kind].bindings.some(binding => binding.role === requiredRole
                && binding.member === `serviceAccount:${member}` && binding.condition === null);
        for (const kind of ['run', 'maintenance'] as const) {
            if (resources[kind].bindings.some(binding => binding.role === 'roles/run.invoker'
                && (binding.member === 'allUsers' || binding.member === 'allAuthenticatedUsers'))) epochFail('RESOURCE_INVALID');
        }
        if (!has('run', 'roles/run.invoker', taskCallerIdentity)
            || !has('run', 'roles/run.invoker', maintenanceIdentity)
            || !has('queue', 'roles/cloudtasks.enqueuer', enqueuerIdentity)
            || !has('queue', 'roles/cloudtasks.enqueuer', runtimeIdentity)
            || !has('queue', 'roles/cloudtasks.viewer', runtimeIdentity)
            || !has('taskCaller', 'roles/iam.serviceAccountUser', enqueuerIdentity)
            || !has('taskCaller', 'roles/iam.serviceAccountUser', runtimeIdentity)
            || !resources.taskCaller.bindings.some(binding => binding.role === 'roles/iam.serviceAccountUser'
                && binding.condition === null && CLOUD_TASKS_SERVICE_AGENT.test(binding.member))) epochFail('RESOURCE_INVALID');
        if (!resources.run.resource.endsWith(`/services/${value.runtime[role].service}`)
            || resources.maintenance.resource !== resources.run.resource
            || resources.queue.resource !== value.queues[role].resource
            || resources.taskCaller.resource !== `projects/${value.runtime[role].project}/serviceAccounts/${taskCallerIdentity}`) epochFail('RESOURCE_INVALID');
    }
}

function validateIamPreservesOld(oldInputs: ProtectedPlatformInputs, desiredInputs: ProtectedPlatformInputs): void {
    for (const role of ROLES) {
        for (const kind of IAM_INPUT_MAP_KEYS) {
            const oldResource = oldInputs.iam[role][kind];
            const desiredResource = desiredInputs.iam[role][kind];
            if (oldResource.resource === desiredResource.resource) {
                const desiredBindings = new Set(desiredResource.bindings.map(bindingKey));
                for (const binding of oldResource.bindings) {
                    if (!desiredBindings.has(bindingKey(binding))) epochFail('RESOURCE_INVALID');
                }
                if (desiredResource.previous !== null
                    && (desiredResource.previous.resource !== oldResource.resource
                        || desiredResource.previous.bindings.length !== oldResource.bindings.length
                        || ![...bindingSet(desiredResource.previous.bindings)].every(binding => bindingSet(oldResource.bindings).has(binding)))) epochFail('RESOURCE_INVALID');
                continue;
            }
            // A roll-forward may move the task-caller policy to a new service
            // account.  The exact old policy remains a separate protected
            // snapshot; it is never silently replaced by the new policy.
            if (desiredResource.previous === null
                || desiredResource.previous.resource !== oldResource.resource
                || desiredResource.previous.project !== oldResource.project
                || desiredResource.previous.bindings.length !== oldResource.bindings.length
                || ![...bindingSet(desiredResource.previous.bindings)].every(binding => bindingSet(oldResource.bindings).has(binding))) epochFail('RESOURCE_INVALID');
        }
    }
}

function validateIamAdditions(oldInputs: ProtectedPlatformInputs, desiredInputs: ProtectedPlatformInputs, desiredManifest: CapacityManifest): void {
    for (const role of ROLES) {
        for (const kind of IAM_INPUT_MAP_KEYS) {
            const oldResource = oldInputs.iam[role][kind];
            const desiredResource = desiredInputs.iam[role][kind];
            const baseline = desiredResource.resource === oldResource.resource
                ? oldResource.bindings
                : desiredResource.previous?.bindings;
            if (baseline === undefined) epochFail('RESOURCE_INVALID');
            const baselineKeys = bindingSet(baseline);
            const allowedMembers: Record<typeof kind, readonly string[]> = {
                run: [
                    desiredManifest.roleSlots[`${role}.task-caller` as Slot].identity,
                    desiredManifest.roleSlots[`${role}.maintenance` as Slot].identity,
                ],
                queue: [
                    desiredManifest.roleSlots[`${role}.enqueuer` as Slot].identity,
                    desiredManifest.roleSlots[`${role}.runtime` as Slot].identity,
                ],
                taskCaller: [
                    desiredManifest.roleSlots[`${role}.enqueuer` as Slot].identity,
                    desiredManifest.roleSlots[`${role}.runtime` as Slot].identity,
                ],
                maintenance: [
                    desiredManifest.roleSlots[`${role}.task-caller` as Slot].identity,
                    desiredManifest.roleSlots[`${role}.maintenance` as Slot].identity,
                ],
            };
            const oldTaskCallerAgents = oldResource.kind === 'taskCaller'
                ? oldResource.bindings.filter(binding => binding.role === 'roles/iam.serviceAccountUser' && CLOUD_TASKS_SERVICE_AGENT.test(binding.member)).map(binding => binding.member)
                : [];
            for (const binding of desiredResource.bindings) {
                if (baselineKeys.has(bindingKey(binding))) continue;
                const member = binding.member.slice('serviceAccount:'.length);
                const taskCallerMemberAllowed = kind !== 'taskCaller'
                    || (CLOUD_TASKS_SERVICE_AGENT.test(binding.member)
                        ? oldTaskCallerAgents.includes(binding.member)
                        : /^serviceAccount:[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/.test(binding.member));
                if (!IAM_ROLES_BY_KIND[kind].has(binding.role)
                    || binding.condition !== null
                    || !binding.member.startsWith('serviceAccount:')
                    || !taskCallerMemberAllowed
                    || !allowedMembers[kind].includes(member)) epochFail('RESOURCE_INVALID');
            }
        }
    }
}

/** Digests of old workload grants that are intentionally removed after both promotions. */
export function deriveRetiredIamBindingDigests(
    oldManifest: CapacityManifest,
    desiredManifest: CapacityManifest,
    oldInputs: ProtectedPlatformInputs,
): Readonly<Record<Role, readonly string[]>> {
    const desiredIds = new Set(Object.values(desiredManifest.roleSlots).map(identity => identity.identity));
    const oldIds = new Set(Object.values(oldManifest.roleSlots).map(identity => identity.identity));
    const result = {} as Record<Role, readonly string[]>;
    for (const role of ROLES) {
        const digests: string[] = [];
        for (const kind of IAM_INPUT_MAP_KEYS) {
            for (const binding of oldInputs.iam[role][kind].bindings) {
                if (!binding.member.startsWith('serviceAccount:')) continue;
                const member = binding.member.slice('serviceAccount:'.length);
                if (oldIds.has(member) && !desiredIds.has(member)) digests.push(bindingKey(binding));
            }
        }
        result[role] = digests.sort();
    }
    return result;
}

function validateIamManifestRetirements(
    oldManifest: CapacityManifest,
    desiredManifest: CapacityManifest,
    oldInputs: ProtectedPlatformInputs,
): void {
    const expected = deriveRetiredIamBindingDigests(oldManifest, desiredManifest, oldInputs);
    for (const role of ROLES) {
        const actual = [...desiredManifest.iam[role].retiredBindings].sort();
        if (actual.length !== expected[role].length || actual.some((digest, index) => digest !== expected[role][index])) epochFail('RESOURCE_INVALID');
    }
}

function validateSecretReferencePreservation(oldInputs: ProtectedPlatformInputs, desiredInputs: ProtectedPlatformInputs): void {
    for (const role of ROLES) {
        if (canonicalDigest(oldInputs.runtime[role].secretReferences)
            !== canonicalDigest(desiredInputs.runtime[role].secretReferences)) epochFail('SOURCE_INVALID');
    }
}

function validateOldObservations(
    value: unknown,
    manifest: CapacityManifest,
    platform: ProtectedPlatformInputs,
): asserts value is ProtectedOldObservations {
    assertKeys(value, OLD_OBSERVATION_KEYS, 'INVALID_PACKET');
    if (!isObject(value.source) || !hasExactKeys(value.source, ROLES)
        || !isObject(value.runtime) || !hasExactKeys(value.runtime, ROLES)
        || !isObject(value.queues) || !hasExactKeys(value.queues, ROLES)
        || !isObject(value.schedulers) || !hasExactKeys(value.schedulers, ROLES)
        || !isObject(value.iam) || !hasExactKeys(value.iam, ROLES)
        || !isObject(value.readiness)) epochFail('INVALID_PACKET');

    const source = value.source as Record<Role, Record<string, unknown>>;
    for (const role of ROLES) {
        assertKeys(source[role], SOURCE_OBSERVATION_KEYS, 'SOURCE_INVALID');
        if (!isSha(source[role].sourceSha)
            || source[role].sourceSha !== manifest.source[role].oldSha
            || source[role].revision !== manifest.source[role].oldRevision
            || !safeString(source[role].revision, 128)
            || !validDigest(source[role].metadataDigest)) epochFail('SOURCE_INVALID');
    }

    const runtime = value.runtime as Record<Role, Record<string, unknown>>;
    for (const role of ROLES) {
        assertKeys(runtime[role], RUNTIME_OBSERVATION_KEYS, 'SOURCE_INVALID');
        const expectedRuntime = platform.runtime[role];
        if (!isSha(runtime[role].sourceSha)
            || runtime[role].sourceSha !== expectedRuntime.sourceSha
            || runtime[role].service !== expectedRuntime.service
            || runtime[role].project !== expectedRuntime.project
            || runtime[role].location !== expectedRuntime.location
            || !safeString(runtime[role].revision, 128)
            || !safeString(runtime[role].generation, 128)
            || !safeString(runtime[role].resourceVersion, 128)
            || typeof runtime[role].providerAdmissionEnabled !== 'boolean'
            || typeof runtime[role].noTraffic !== 'boolean'
            || !validDigest(runtime[role].runtimeDigest)
            || !validDigest(runtime[role].buildDigest)) epochFail('SOURCE_INVALID');
        validateProtectedIdentity(runtime[role].identity);
        if (runtime[role].identity.identity !== expectedRuntime.identity.identity
            || runtime[role].identity.project !== expectedRuntime.identity.project
            || runtime[role].providerAdmissionEnabled !== expectedRuntime.providerAdmissionEnabled
            || runtime[role].noTraffic !== expectedRuntime.noTraffic) epochFail('SOURCE_INVALID');
    }

    const queues = value.queues as Record<Role, Record<string, unknown>>;
    for (const role of ROLES) {
        assertKeys(queues[role], QUEUE_OBSERVATION_KEYS, 'RESOURCE_INVALID');
        const expectedQueue = platform.queues[role];
        if (queues[role].resource !== expectedQueue.resource
            || queues[role].project !== expectedQueue.project
            || queues[role].location !== expectedQueue.location
            || queues[role].state !== 'PAUSED'
            || queues[role].complete !== true
            || !isObject(queues[role].configuration)
            || canonicalDigest(canonicalQueueConfiguration(queues[role].configuration)) !== canonicalDigest(canonicalQueueConfiguration(expectedQueue.configuration))
            || !Array.isArray(queues[role].tasks)) epochFail('RESOURCE_INVALID');
        validateScopedResource(queues[role].resource as string, expectedQueue.project, expectedQueue.location, 'queues');
        if (queues[role].tasks.length > 0 || !manifest.queues[role].empty) epochFail('QUEUE_NOT_EMPTY');
        for (const task of queues[role].tasks) {
            assertKeys(task, TASK_OBSERVATION_KEYS, 'RESOURCE_INVALID');
            if (!safeString(task.name, 512) || !RESOURCE_PATTERN.test(task.name)
                || !validDigest(task.payloadDigest) || !safeString(task.createTime, 64)) epochFail('RESOURCE_INVALID');
        }
    }

    const schedulers = value.schedulers as Record<Role, Record<string, unknown>>;
    for (const role of ROLES) {
        assertKeys(schedulers[role], SCHEDULER_OBSERVATION_KEYS, 'RESOURCE_INVALID');
        const expectedScheduler = platform.schedulers[role];
        if (schedulers[role].resource !== expectedScheduler.resource
            || schedulers[role].project !== expectedScheduler.project
            || schedulers[role].location !== expectedScheduler.location
            || schedulers[role].state !== expectedScheduler.state
            || schedulers[role].pauseEpochMs !== expectedScheduler.pauseEpochMs
            || schedulers[role].lastAttemptMs !== expectedScheduler.lastAttemptMs
            || !isObject(schedulers[role].configuration)
            || canonicalDigest(schedulers[role].configuration) !== canonicalDigest(expectedScheduler.configuration)) epochFail('RESOURCE_INVALID');
        validateScopedResource(schedulers[role].resource as string, expectedScheduler.project, expectedScheduler.location, 'jobs');
        if (schedulers[role].state !== 'PAUSED' || manifest.recoverySchedulers[role].state !== 'PAUSED') epochFail('EVIDENCE_UNAVAILABLE');
    }

    const iam = value.iam as ProtectedIamInputs;
    for (const role of ROLES) {
        for (const kind of IAM_INPUT_MAP_KEYS) {
            validateIamInput(iam[role][kind], manifest.build.project, kind);
            if (canonicalDigest(iam[role][kind]) !== canonicalDigest(platform.iam[role][kind])) epochFail('RESOURCE_INVALID');
        }
    }
    validateRetentionInput(value.retention);
    if (canonicalDigest(value.retention) !== canonicalDigest(platform.retention)) epochFail('RESOURCE_INVALID');

    const readiness = value.readiness;
    if (!hasExactKeys(readiness, [...READINESS_KEYS, 'ready']) || typeof readiness.ready !== 'boolean') epochFail('READINESS_INVALID');
    const readinessWithoutAggregate = { ...readiness };
    delete readinessWithoutAggregate.ready;
    validateReadiness(readinessWithoutAggregate);
    if (readiness.ready !== true || readiness.analysisV2AdmissionEnabled !== false || readiness.earlybirdWebhookAutoAdmissionEnabled !== false) epochFail('READINESS_INVALID');
    if (canonicalDigest(readinessWithoutAggregate) !== canonicalDigest(manifest.readiness)) epochFail('READINESS_INVALID');
    if (!manifest.queues.preflight.empty || !manifest.queues.paid.empty
        || manifest.queues.preflight.state !== 'PAUSED' || manifest.queues.paid.state !== 'PAUSED'
        || manifest.recoverySchedulers.preflight.state !== 'PAUSED' || manifest.recoverySchedulers.paid.state !== 'PAUSED'
        || !manifest.retention.enabled) epochFail('EVIDENCE_UNAVAILABLE');
}

function validateObservationTargets(
    value: unknown,
    manifest: CapacityManifest,
    platform: ProtectedPlatformInputs,
): asserts value is ProtectedObservationTargets {
    assertKeys(value, OBSERVATION_TARGET_KEYS, 'INVALID_PACKET');
    if (!isObject(value.source) || !hasExactKeys(value.source, ROLES)
        || !isObject(value.runtime) || !hasExactKeys(value.runtime, ROLES)
        || !isObject(value.queues) || !hasExactKeys(value.queues, ROLES)
        || !isObject(value.schedulers) || !hasExactKeys(value.schedulers, ROLES)
        || !isObject(value.iam) || !hasExactKeys(value.iam, ROLES)
        || !isObject(value.readiness) || !isObject(value.zeroWorkSources)) epochFail('INVALID_PACKET');

    const source = value.source as Record<Role, Record<string, unknown>>;
    for (const role of ROLES) {
        assertKeys(source[role], SOURCE_TARGET_KEYS, 'SOURCE_INVALID');
        if (!isSha(source[role].sourceSha)
            || source[role].sourceSha !== manifest.source[role].desiredSha
            || !isObject(source[role].revisionPlan)
            || !hasExactKeys(source[role].revisionPlan, ['prefix', 'suffix'])
            || canonicalDigest(source[role].revisionPlan) !== canonicalDigest(manifest.source[role].revisionPlan)
            || !validDigest(source[role].desiredBuildDigest)
            || !validDigest(source[role].desiredRuntimeDigest)
            || source[role].desiredBuildDigest !== manifest.source[role].desiredBuildDigest
            || source[role].desiredRuntimeDigest !== manifest.source[role].desiredRuntimeDigest) epochFail('SOURCE_INVALID');
    }

    const targetPlatform: ProtectedPlatformInputs = {
        build: platform.build,
        runtime: value.runtime as ProtectedPlatformInputs['runtime'],
        queues: value.queues as ProtectedPlatformInputs['queues'],
        schedulers: value.schedulers as ProtectedPlatformInputs['schedulers'],
        iam: value.iam as ProtectedPlatformInputs['iam'],
        retention: value.retention as ProtectedPlatformInputs['retention'],
    };
    validatePlatformInputs(targetPlatform, manifest, 'desired');
    if (canonicalDigest(targetPlatform.runtime) !== canonicalDigest(platform.runtime)
        || canonicalDigest(targetPlatform.queues) !== canonicalDigest(platform.queues)
        || canonicalDigest(targetPlatform.schedulers) !== canonicalDigest(platform.schedulers)
        || canonicalDigest(targetPlatform.iam) !== canonicalDigest(platform.iam)
        || canonicalDigest(targetPlatform.retention) !== canonicalDigest(platform.retention)) epochFail('RESOURCE_INVALID');

    validateReadiness(value.readiness);
    if (canonicalDigest(value.readiness) !== canonicalDigest(manifest.readiness)) epochFail('READINESS_INVALID');
    const sources = value.zeroWorkSources as Record<string, Record<string, unknown>>;
    const sourceNames = ['providerLedger', 'billingLedger', 'taskAudit', 'receiverLog'] as const;
    if (!hasExactKeys(sources, sourceNames)) epochFail('EVIDENCE_UNAVAILABLE');
    for (const sourceName of sourceNames) {
        assertKeys(sources[sourceName], EVIDENCE_SOURCE_KEYS, 'EVIDENCE_UNAVAILABLE');
        if (!safeString(sources[sourceName].source, 2048)
            || !Number.isSafeInteger(sources[sourceName].lookbackMs)
            || (sources[sourceName].lookbackMs as number) <= 0) epochFail('EVIDENCE_UNAVAILABLE');
    }
}

function validateProjects(manifest: CapacityManifest): void {
    const projects = new Set(Object.values(manifest.roleSlots).map(identity => identity.project));
    projects.add(manifest.build.project);
    for (const role of ROLES) {
        projects.add(manifest.queues[role].project);
        projects.add(manifest.recoverySchedulers[role].project);
    }
    projects.add(manifest.retention.project);
    if (projects.size !== 1) epochFail('PROJECT_MISMATCH');
}

function manifestProject(manifest: CapacityManifest): string {
    const project = manifest.build.project;
    if (!safeString(project)) epochFail('PROJECT_MISMATCH');
    return project;
}

export function validateManifestComparison(oldManifest: CapacityManifest, desiredManifest: CapacityManifest): void {
    validateManifest(oldManifest);
    validateManifest(desiredManifest);
    validateProjects(oldManifest);
    validateProjects(desiredManifest);
    if (manifestProject(oldManifest) !== manifestProject(desiredManifest)) epochFail('PROJECT_MISMATCH');
    const desiredIds = SLOTS.map(slot => desiredManifest.roleSlots[slot].identity);
    if (new Set(desiredIds).size !== SLOTS.length
        || desiredIds.includes(desiredManifest.build.identity)) epochFail('IDENTITY_CONFLICT');
    const oldSlotsByIdentity = new Map<string, Slot[]>();
    for (const slot of SLOTS) {
        const identity = oldManifest.roleSlots[slot].identity;
        const slots = oldSlotsByIdentity.get(identity) ?? [];
        slots.push(slot);
        oldSlotsByIdentity.set(identity, slots);
    }
    for (const slot of SLOTS) {
        const oldIdentity = oldManifest.roleSlots[slot].identity;
        const desiredIdentity = desiredManifest.roleSlots[slot].identity;
        const priorSlots = oldSlotsByIdentity.get(desiredIdentity) ?? [];
        if (priorSlots.length > 0
            && (priorSlots.length !== 1 || priorSlots[0] !== slot)) epochFail('IDENTITY_CONFLICT');
        if (desiredIdentity === oldIdentity && priorSlots.length !== 1) epochFail('IDENTITY_CONFLICT');
    }
    const oldBuild = oldManifest.build.identity;
    const oldWorkloadIds = new Set(SLOTS.map(slot => oldManifest.roleSlots[slot].identity));
    // A retired workload may not become the desired build, and the old build
    // may not be smuggled back into a workload slot.  This check applies even
    // when the old workload was shared across two slots: shared identities are
    // valid only when absent from the complete desired workload/build set.
    if (oldWorkloadIds.has(desiredManifest.build.identity)
        || desiredIds.includes(oldBuild)) epochFail('IDENTITY_CONFLICT');
}

function validateProbe(value: unknown): void {
    assertKeys(value, ['bodyDigest', 'expectedStatuses', 'expectedCodes'], 'PROBE_FAILED');
    const expectedStatuses = value.expectedStatuses as Record<string, unknown>;
    const expectedCodes = value.expectedCodes as Record<string, unknown>;
    if (!validDigest(value.bodyDigest) || !isObject(expectedStatuses) || !isObject(expectedCodes)
        || !hasExactKeys(expectedStatuses, ROLES) || !hasExactKeys(expectedCodes, ROLES)
        || !ROLES.every(role => expectedStatuses[role] === 400 && expectedCodes[role] === 'INVALID_REQUEST')) epochFail('PROBE_FAILED');
}

function deriveSourcePlanDigest(packet: CapacityEpochPacket): string {
    return canonicalDigest({
        old: {
            source: packet.oldManifest.source,
            build: packet.protectedInputs.old.build,
            runtime: packet.protectedInputs.old.runtime,
            observedSource: packet.protectedObservations.old.source,
        },
        desired: {
            source: packet.desiredManifest.source,
            build: packet.protectedInputs.desired.build,
            runtime: packet.protectedInputs.desired.runtime,
            targetSource: packet.protectedObservations.desired.source,
        },
    });
}

export type ProtectedObservationDigestInput = Pick<CapacityEpochPacket,
    'oldManifest' | 'desiredManifest' | 'protectedInputs' | 'protectedObservations'>;

/**
 * Every observation-input digest is derived from the complete reviewed
 * manifest, protected execution input, and its live/target evidence payload.
 * A caller-provided marker can therefore never stand in for a real contract,
 * while the projection remains safe to carry in the digest-only journal.
 */
export function deriveObservationInputDigests(input: ProtectedObservationDigestInput): CapacityEpochPacket['observationInputs'] {
    const old = input.protectedObservations.old;
    const desired = input.protectedObservations.desired;
    return {
        sourceDigest: canonicalDigest({
            old: { manifest: input.oldManifest.source, input: { build: input.protectedInputs.old.build, runtime: input.protectedInputs.old.runtime }, observation: old.source },
            desired: { manifest: input.desiredManifest.source, input: { build: input.protectedInputs.desired.build, runtime: input.protectedInputs.desired.runtime }, target: desired.source },
        }),
        iamDigest: canonicalDigest({
            old: { manifest: input.oldManifest.iam, input: input.protectedInputs.old.iam, observation: old.iam },
            desired: { manifest: input.desiredManifest.iam, input: input.protectedInputs.desired.iam, target: desired.iam },
        }),
        queueDigest: canonicalDigest({
            old: { manifest: input.oldManifest.queues, input: input.protectedInputs.old.queues, observation: old.queues },
            desired: { manifest: input.desiredManifest.queues, input: input.protectedInputs.desired.queues, target: desired.queues },
        }),
        schedulerDigest: canonicalDigest({
            old: { manifest: input.oldManifest.recoverySchedulers, input: input.protectedInputs.old.schedulers, observation: old.schedulers },
            desired: { manifest: input.desiredManifest.recoverySchedulers, input: input.protectedInputs.desired.schedulers, target: desired.schedulers },
        }),
        retentionDigest: canonicalDigest({
            old: { manifest: input.oldManifest.retention, input: input.protectedInputs.old.retention, observation: old.retention },
            desired: { manifest: input.desiredManifest.retention, input: input.protectedInputs.desired.retention, target: desired.retention },
        }),
        readinessDigest: canonicalDigest({
            old: { manifest: input.oldManifest.readiness, observation: old.readiness },
            desired: { manifest: input.desiredManifest.readiness, target: desired.readiness },
        }),
        zeroWorkDigest: canonicalDigest(desired.zeroWorkSources),
    };
}

function deriveCapabilityDigest(packet: CapacityEpochPacket): string {
    return canonicalDigest({
        epochId: packet.epochId,
        lockNamespace: packet.lockNamespace,
        roleSetDigest: packet.roleSetDigest,
        oldManifestDigest: packet.oldManifestDigest,
        desiredManifestDigest: packet.desiredManifestDigest,
        sourcePlanDigest: packet.sourcePlanDigest,
        providerScope: packet.providerScope,
        activation: packet.activation,
        quiescence: packet.quiescence,
        observationInputs: packet.observationInputs,
        protectedObservations: packet.protectedObservations,
        probe: packet.probe,
    });
}

function validatePacketShape(value: unknown): asserts value is CapacityEpochPacket {
    assertKeys(value, PACKET_INPUT_KEYS, 'INVALID_PACKET');
    const protectedInputs = value.protectedInputs as Record<string, unknown>;
    const providerScope = value.providerScope;
    const protectedObservations = value.protectedObservations as Record<string, unknown>;
    const activation = value.activation as Record<string, unknown>;
    const quiescence = value.quiescence as Record<string, unknown>;
    const observationInputs = value.observationInputs as Record<string, unknown>;
    const probe = value.probe as Record<string, unknown>;
    if (!safeString(value.epochId, 128) || !safeString(value.lockNamespace, 128)
        || !Array.isArray(value.roleSet) || value.roleSet.length !== ROLES.length
        || !value.roleSet.every(isRole) || new Set(value.roleSet).size !== ROLES.length
        || !isObject(protectedInputs) || !hasExactKeys(protectedInputs, ['old', 'desired'])
        || !isObject(providerScope)
        || !isObject(protectedObservations) || !hasExactKeys(protectedObservations, ['old', 'desired'])
        || !isObject(activation) || !isObject(quiescence)
        || !isObject(observationInputs) || !isObject(probe)) epochFail('INVALID_PACKET');
    if (!hasExactKeys(activation, ['analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled'])
        || typeof activation.analysisV2AdmissionEnabled !== 'boolean'
        || typeof activation.earlybirdWebhookAutoAdmissionEnabled !== 'boolean') epochFail('ACTIVATION_INVALID');
    const timeoutMs = quiescence.timeoutMs as unknown;
    const graceMs = quiescence.graceMs as unknown;
    if (!hasExactKeys(quiescence, ['timeoutMs', 'graceMs'])
        || !Number.isSafeInteger(timeoutMs) || (timeoutMs as number) <= 0
        || !Number.isSafeInteger(graceMs) || (graceMs as number) < 0) epochFail('INVALID_PACKET');
    const digestKeys = ['sourceDigest', 'iamDigest', 'queueDigest', 'schedulerDigest', 'retentionDigest', 'readinessDigest', 'zeroWorkDigest'] as const;
    if (!hasExactKeys(observationInputs, digestKeys)
        || !digestKeys.every(key => validDigest(observationInputs[key]))) epochFail('INVALID_PACKET');
    validateProbe(probe);
    validateProviderScope(providerScope);
    validateManifest(value.oldManifest);
    validateManifest(value.desiredManifest);
    validateManifestComparison(value.oldManifest, value.desiredManifest);
    validatePlatformInputs(protectedInputs.old, value.oldManifest, 'old');
    validatePlatformInputs(protectedInputs.desired, value.desiredManifest, 'desired');
    if (providerScope.googleProjectId !== value.oldManifest.build.project
        || providerScope.googleProjectId !== value.desiredManifest.build.project) epochFail('PROJECT_MISMATCH');
    validateSecretReferencePreservation(protectedInputs.old, protectedInputs.desired);
    validateIamPreservesOld(protectedInputs.old, protectedInputs.desired);
    validateIamAdditions(protectedInputs.old, protectedInputs.desired, value.desiredManifest);
    validateIamManifestRetirements(value.oldManifest, value.desiredManifest, protectedInputs.old);
    validateOldObservations(protectedObservations.old, value.oldManifest, protectedInputs.old);
    validateObservationTargets(protectedObservations.desired, value.desiredManifest, protectedInputs.desired);
    const derivedObservationInputs = deriveObservationInputDigests(value as CapacityEpochPacket);
    if (Object.keys(derivedObservationInputs).some(key => derivedObservationInputs[key as keyof typeof derivedObservationInputs] !== observationInputs[key])) epochFail('INVALID_PACKET');
    if (!isDigest(value.oldManifestDigest) || !isDigest(value.desiredManifestDigest)
        || !isDigest(value.capabilityDigest) || !isDigest(value.roleSetDigest) || !isDigest(value.sourcePlanDigest)) epochFail('INVALID_PACKET');
}

export function createProtectedPacket(input: ProtectedPacketInput): CapacityEpochPacket {
    if (!Array.isArray(input.roleSet) || input.roleSet.length !== ROLES.length
        || !input.roleSet.every(isRole) || new Set(input.roleSet).size !== ROLES.length) epochFail('INVALID_PACKET');
    validateManifest(input.oldManifest);
    validateManifest(input.desiredManifest);
    validateManifestComparison(input.oldManifest, input.desiredManifest);
    validateProviderScope(input.providerScope);
    if (input.providerScope.googleProjectId !== input.oldManifest.build.project
        || input.providerScope.googleProjectId !== input.desiredManifest.build.project) epochFail('PROJECT_MISMATCH');
    validatePlatformInputs(input.protectedInputs.old, input.oldManifest, 'old');
    validatePlatformInputs(input.protectedInputs.desired, input.desiredManifest, 'desired');
    validateSecretReferencePreservation(input.protectedInputs.old, input.protectedInputs.desired);
    validateIamPreservesOld(input.protectedInputs.old, input.protectedInputs.desired);
    validateIamAdditions(input.protectedInputs.old, input.protectedInputs.desired, input.desiredManifest);
    validateIamManifestRetirements(input.oldManifest, input.desiredManifest, input.protectedInputs.old);
    validateOldObservations(input.protectedObservations.old, input.oldManifest, input.protectedInputs.old);
    validateObservationTargets(input.protectedObservations.desired, input.desiredManifest, input.protectedInputs.desired);
    const derivedObservationInputs = deriveObservationInputDigests(input);
    if (Object.keys(derivedObservationInputs).some(key => derivedObservationInputs[key as keyof typeof derivedObservationInputs] !== input.observationInputs[key as keyof typeof input.observationInputs])) epochFail('INVALID_PACKET');
    const oldManifestDigest = canonicalDigest(input.oldManifest);
    const desiredManifestDigest = canonicalDigest(input.desiredManifest);
    const roleSetDigest = canonicalDigest([...input.roleSet].sort());
    const packet = {
        ...input,
        roleSet: [...input.roleSet],
        oldManifestDigest,
        desiredManifestDigest,
        roleSetDigest,
        sourcePlanDigest: '',
        capabilityDigest: '',
    } as CapacityEpochPacket;
    packet.sourcePlanDigest = deriveSourcePlanDigest(packet);
    packet.capabilityDigest = deriveCapabilityDigest(packet);
    validateEpochPacket(packet);
    return packet;
}

export function validateEpochPacket(value: unknown, capability?: CoordinatorCapability): CapacityEpochPacket {
    validatePacketShape(value);
    const packet = value as CapacityEpochPacket;
    if (capability !== undefined) assertCoordinatorCapability(packet, capability);
    if (canonicalDigest(packet.oldManifest) !== packet.oldManifestDigest
        || canonicalDigest(packet.desiredManifest) !== packet.desiredManifestDigest
        || canonicalDigest([...packet.roleSet].sort()) !== packet.roleSetDigest
        || deriveSourcePlanDigest(packet) !== packet.sourcePlanDigest
        || deriveCapabilityDigest(packet) !== packet.capabilityDigest) epochFail('INVALID_PACKET');
    return packet;
}

export function issueCoordinatorCapability(
    packet: CapacityEpochPacket,
    ownerDigest: string,
    lockNamespace = packet.lockNamespace,
): CoordinatorCapability {
    validateEpochPacket(packet);
    if (lockNamespace !== packet.lockNamespace) epochFail('LOCK_NAMESPACE_MISMATCH');
    if (!safeString(ownerDigest, 128)) epochFail('CAPABILITY_INVALID');
    const token = Object.freeze(Object.create(null)) as CoordinatorCapability;
    capabilityRegistry.set(token, {
        epochId: packet.epochId,
        packetDigest: canonicalDigest(packet),
        roleSetDigest: packet.roleSetDigest,
        lockNamespace: packet.lockNamespace,
        ownerDigest,
    });
    return token;
}

export function assertCoordinatorCapability(packet: CapacityEpochPacket, capability: CoordinatorCapability, ownerDigest?: string): void {
    if ((typeof capability !== 'object' && typeof capability !== 'function') || capability === null) epochFail('CAPABILITY_INVALID');
    const binding = capabilityRegistry.get(capability);
    if (!binding) epochFail('CAPABILITY_INVALID');
    if (binding.epochId !== packet.epochId
        || binding.packetDigest !== canonicalDigest(packet)
        || binding.roleSetDigest !== packet.roleSetDigest
        || binding.lockNamespace !== packet.lockNamespace
        || (ownerDigest !== undefined && binding.ownerDigest !== ownerDigest)) epochFail('CAPABILITY_BINDING_MISMATCH');
}

export type ProtectedPacketDescriptor = Readonly<{ fd: number; maxBytes?: number }>;

const PROTECTED_DESCRIPTOR_TIMEOUT_MS = 5_000;

function validateProtectedDescriptor(fd: number, maxBytes: number): ReturnType<typeof fstatSync> {
    if (!Number.isInteger(fd) || fd < 0
        || !Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 4_194_304) {
        epochFail('PROTECTED_INPUT_UNAVAILABLE');
    }
    let stat;
    try {
        stat = fstatSync(fd);
    } catch {
        epochFail('PROTECTED_INPUT_UNAVAILABLE');
    }
    // A live invocation receives the packet through an inherited regular file
    // or FIFO. Never resolve a path, and never accept a public descriptor.
    const inheritedPipe = stat.isFIFO() || stat.isSocket();
    if ((!stat.isFile() && !inheritedPipe)
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        // Permission bits on an inherited anonymous pipe are implementation
        // metadata rather than a path-access boundary. Regular files still
        // require owner-only mode; FIFO/socket descriptors are already scoped
        // by the inherited handle and owner check above.
        || (stat.isFile() && (stat.mode & 0o077) !== 0)) epochFail('PROTECTED_INPUT_UNAVAILABLE');
    return stat;
}

/**
 * Read a bounded inherited protected descriptor without persisting its
 * contents. The async path is required for FIFOs so a closed writer and a
 * stalled writer both produce a bounded result.
 */
export async function readProtectedDescriptor(fd: number, maxBytes = 1_048_576): Promise<string> {
    const stat = validateProtectedDescriptor(fd, maxBytes);
    if (stat.isFIFO() || stat.isSocket()) return readProtectedIpcDescriptor(fd, maxBytes);
    return readProtectedRegularFile(fd, maxBytes);
}

async function readProtectedIpcDescriptor(fd: number, maxBytes: number): Promise<string> {
    let socket: Socket;
    try {
        // The inherited IPC descriptor is consumed by this socket. It is
        // never connected to a host; destroy() is the cancellation/ownership
        // boundary that closes the descriptor and unblocks the event loop.
        socket = new Socket({ fd, readable: true, writable: false });
    } catch {
        try { closeSync(fd); } catch { /* best-effort ownership cleanup */ }
        epochFail('PROTECTED_INPUT_UNAVAILABLE');
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = (error?: unknown): void => {
                if (settled) return;
                settled = true;
                if (error === undefined) resolve();
                else reject(error);
            };
            const timer = setTimeout(() => {
                socket.destroy();
                settle(new EpochError('PROTECTED_INPUT_UNAVAILABLE'));
            }, PROTECTED_DESCRIPTOR_TIMEOUT_MS);
            const clear = (): void => clearTimeout(timer);
            socket.on('data', chunk => {
                totalBytes += chunk.byteLength;
                if (totalBytes > maxBytes) {
                    clear();
                    socket.destroy();
                    settle(new EpochError('PROTECTED_INPUT_UNAVAILABLE'));
                    return;
                }
                chunks.push(chunk);
            });
            socket.once('end', () => { clear(); socket.destroy(); settle(); });
            socket.once('error', error => { clear(); settle(error); });
        });
    } catch (error) {
        if (error instanceof EpochError) throw error;
        epochFail('PROTECTED_INPUT_UNAVAILABLE');
    } finally {
        socket.destroy();
    }
    return Buffer.concat(chunks).toString('utf8');
}

async function readProtectedRegularFile(fd: number, maxBytes: number): Promise<string> {
    let stream: ReturnType<typeof createReadStream> | undefined;
    let streamFd: number | undefined;
    try {
        // Duplicate only the already validated inherited descriptor. The
        // stream owns the duplicate, so timeout/oversize cleanup is distinct
        // from consuming the inherited descriptor exactly once below.
        streamFd = openSync(`/dev/fd/${fd}`, fsConstants.O_RDONLY);
        stream = createReadStream(null as unknown as string, { fd: streamFd, autoClose: true });
    } catch {
        epochFail('PROTECTED_INPUT_UNAVAILABLE');
    }
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = (error?: unknown): void => {
                if (settled) return;
                settled = true;
                if (error === undefined) resolve();
                else reject(error);
            };
            const timer = setTimeout(() => {
                stream.destroy();
                settle(new EpochError('PROTECTED_INPUT_UNAVAILABLE'));
            }, PROTECTED_DESCRIPTOR_TIMEOUT_MS);
            const clear = (): void => clearTimeout(timer);
            stream.on('data', chunk => {
                const data = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
                totalBytes += data.byteLength;
                if (totalBytes > maxBytes) {
                    clear();
                    stream.destroy();
                    settle(new EpochError('PROTECTED_INPUT_UNAVAILABLE'));
                    return;
                }
                chunks.push(data);
            });
            stream.once('end', () => { clear(); settle(); });
            stream.once('error', error => { clear(); settle(error); });
        });
    } catch (error) {
        if (error instanceof EpochError) throw error;
        epochFail('PROTECTED_INPUT_UNAVAILABLE');
    } finally {
        stream?.destroy();
        try { closeSync(fd); } catch { /* inherited descriptor may already be closed by the caller */ }
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** Parse JSON structure only to reject duplicate decoded object keys. */
export function rejectDuplicateJsonKeys(raw: string): void {
    let index = 0;
    const maxDepth = 16;

    const skipWhitespace = (): void => {
        while (index < raw.length && /[\u0009\u000a\u000d\u0020]/.test(raw[index]!)) index += 1;
    };
    const parseString = (): string => {
        if (raw[index] !== '"') epochFail('INVALID_PACKET');
        const start = index;
        index += 1;
        while (index < raw.length) {
            const code = raw.charCodeAt(index);
            if (code < 0x20) epochFail('INVALID_PACKET');
            if (raw[index] === '\\') {
                index += 2;
                if (index > raw.length) epochFail('INVALID_PACKET');
                continue;
            }
            if (raw[index] === '"') {
                index += 1;
                try {
                    const parsed = JSON.parse(raw.slice(start, index));
                    if (typeof parsed !== 'string') epochFail('INVALID_PACKET');
                    return parsed;
                } catch {
                    epochFail('INVALID_PACKET');
                }
            }
            index += 1;
        }
        epochFail('INVALID_PACKET');
    };
    const parseValue = (depth: number): void => {
        if (depth > maxDepth) epochFail('INVALID_PACKET');
        skipWhitespace();
        const token = raw[index];
        if (token === '{') return parseObject(depth + 1);
        if (token === '[') return parseArray(depth + 1);
        if (token === '"') {
            parseString();
            return;
        }
        if (raw.startsWith('true', index)) {
            index += 4;
            return;
        }
        if (raw.startsWith('false', index)) {
            index += 5;
            return;
        }
        if (raw.startsWith('null', index)) {
            index += 4;
            return;
        }
        const number = raw.slice(index).match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/);
        if (number) {
            index += number[0].length;
            return;
        }
        epochFail('INVALID_PACKET');
    };
    const parseArray = (depth: number): void => {
        index += 1;
        skipWhitespace();
        if (raw[index] === ']') {
            index += 1;
            return;
        }
        while (index < raw.length) {
            parseValue(depth);
            skipWhitespace();
            if (raw[index] === ',') {
                index += 1;
                continue;
            }
            if (raw[index] === ']') {
                index += 1;
                return;
            }
            epochFail('INVALID_PACKET');
        }
        epochFail('INVALID_PACKET');
    };
    const parseObject = (depth: number): void => {
        index += 1;
        skipWhitespace();
        const keys = new Set<string>();
        if (raw[index] === '}') {
            index += 1;
            return;
        }
        while (index < raw.length) {
            const key = parseString();
            if (keys.has(key)) epochFail('INVALID_PACKET');
            keys.add(key);
            skipWhitespace();
            if (raw[index] !== ':') epochFail('INVALID_PACKET');
            index += 1;
            parseValue(depth);
            skipWhitespace();
            if (raw[index] === ',') {
                index += 1;
                skipWhitespace();
                continue;
            }
            if (raw[index] === '}') {
                index += 1;
                return;
            }
            epochFail('INVALID_PACKET');
        }
        epochFail('INVALID_PACKET');
    };

    skipWhitespace();
    parseValue(0);
    skipWhitespace();
    if (index !== raw.length) epochFail('INVALID_PACKET');
}

export function loadProtectedPacket(descriptor: ProtectedPacketDescriptor): CapacityEpochPacket {
    if (!descriptor || !Number.isInteger(descriptor.fd) || descriptor.fd < 0) epochFail('PROTECTED_INPUT_UNAVAILABLE');
    const maxBytes = descriptor.maxBytes ?? 1_048_576;
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 4_194_304) epochFail('PROTECTED_INPUT_UNAVAILABLE');
    let stat;
    try {
        stat = fstatSync(descriptor.fd);
    } catch {
        epochFail('PROTECTED_INPUT_UNAVAILABLE');
    }
    // Descriptor reads are synchronous and bounded; a FIFO could block an
    // operator process indefinitely, so only a private regular file is
    // accepted as the inherited protected channel.
    if (!stat.isFile()
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        || (stat.mode & 0o077) !== 0) epochFail('PROTECTED_INPUT_UNAVAILABLE');
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            const remaining = maxBytes + 1 - totalBytes;
            if (remaining <= 0) epochFail('PROTECTED_INPUT_UNAVAILABLE');
            const chunk = Buffer.allocUnsafe(Math.min(65_536, remaining));
            const count = readSync(descriptor.fd, chunk, 0, chunk.length, null);
            if (count === 0) break;
            totalBytes += count;
            if (totalBytes > maxBytes) epochFail('PROTECTED_INPUT_UNAVAILABLE');
            chunks.push(chunk.subarray(0, count));
        }
    } catch (error) {
        if (error instanceof EpochError) throw error;
        epochFail('PROTECTED_INPUT_UNAVAILABLE');
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    rejectDuplicateJsonKeys(raw);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        epochFail('INVALID_PACKET');
    }
    validateEpochPacket(parsed);
    return parsed as CapacityEpochPacket;
}

/** Load the same protected packet contract from an inherited file or FIFO. */
export async function loadProtectedPacketAsync(descriptor: ProtectedPacketDescriptor): Promise<CapacityEpochPacket> {
    if (!descriptor || !Number.isInteger(descriptor.fd) || descriptor.fd < 0) epochFail('PROTECTED_INPUT_UNAVAILABLE');
    const maxBytes = descriptor.maxBytes ?? 1_048_576;
    const raw = await readProtectedDescriptor(descriptor.fd, maxBytes);
    rejectDuplicateJsonKeys(raw);
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        epochFail('INVALID_PACKET');
    }
    validateEpochPacket(parsed);
    return parsed as CapacityEpochPacket;
}

export const parseProtectedPacket = loadProtectedPacket;

// Keep the imported class visible to callers that use `instanceof` while
// ensuring all actual messages stay fixed-code.
export { EpochError };
