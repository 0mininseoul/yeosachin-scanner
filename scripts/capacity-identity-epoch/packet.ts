import { fstatSync, readSync } from 'node:fs';
import {
    MANIFEST_KEYS,
    ROLES,
    SLOTS,
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
    type ProtectedIamInput,
    type ProtectedIdentity,
    type ProtectedObservationTargets,
    type ProtectedOldObservations,
    type ProtectedPlatformInputs,
    type ProtectedQueueInput,
    type ProtectedRetentionInput,
    type ProtectedRuntimeInput,
    type ProtectedSchedulerInput,
    type Role,
    type Slot,
} from './contracts';
import { EpochError } from './contracts';

export { ROLES, SLOTS } from './contracts';

const SERVICE_ACCOUNT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,255}$/;
const HEX_DIGEST = /^[0-9a-f]{64}$/;
const REVISION_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

const SOURCE_KEYS = [
    'oldSha', 'oldRevision', 'desiredSha', 'desiredBuildDigest', 'desiredRuntimeDigest', 'revisionPlan', 'desiredRevisionId',
] as const;
const PRODUCER_KEYS = ['sourceSha', 'fingerprintVersion', 'fingerprint', 'admissionEnabled'] as const;
const QUEUE_KEYS = ['resource', 'project', 'location', 'configDigest', 'state', 'empty', 'tasksDigest'] as const;
const SCHEDULER_KEYS = ['resource', 'project', 'location', 'configDigest', 'state', 'pauseEpochMs', 'lastAttemptMs'] as const;
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
const IAM_INPUT_KEYS = ['resource', 'project', 'etag', 'bindings'] as const;
const IAM_BINDING_KEYS = ['role', 'member', 'condition'] as const;
const RETENTION_INPUT_KEYS = ['resource', 'project', 'location', 'enabled', 'configuration'] as const;
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
    'desiredManifestDigest', 'capabilityDigest', 'roleSetDigest', 'sourcePlanDigest', 'activation',
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

function assertKeys(value: unknown, keys: readonly string[], code: EpochErrorCode = 'INVALID_SCHEMA'): asserts value is Record<string, unknown> {
    if (!isObject(value) || !hasExactKeys(value, keys)) epochFail(code);
}

function validateProtectedIdentity(value: unknown): asserts value is ProtectedIdentity {
    assertKeys(value, ['identity', 'project'], 'IDENTITY_INVALID');
    if (typeof value.identity !== 'string' || typeof value.project !== 'string') epochFail('IDENTITY_INVALID');
    const match = value.identity.match(SERVICE_ACCOUNT_PATTERN);
    if (!match || match[1] !== value.project) epochFail('IDENTITY_INVALID');
}

function validateRevision(value: unknown): void {
    if (!isObject(value)
        || (!hasExactKeys(value, SOURCE_KEYS.slice(0, -1)) && !hasExactKeys(value, SOURCE_KEYS))) {
        epochFail('SOURCE_INVALID');
    }
    if (!isSha(value.oldSha) || !safeString(value.oldRevision, 128) || !isSha(value.desiredSha)
        || !validDigest(value.desiredBuildDigest) || !validDigest(value.desiredRuntimeDigest)
        || !isObject(value.revisionPlan)) epochFail('SOURCE_INVALID');
    assertKeys(value.revisionPlan, ['prefix', 'suffix'], 'SOURCE_INVALID');
    if (!safeString(value.revisionPlan.prefix, 64)
        || !safeString(value.revisionPlan.suffix, 64)
        || (value.desiredRevisionId !== undefined
            && (typeof value.desiredRevisionId !== 'string'
                || !REVISION_PATTERN.test(value.desiredRevisionId)
                || value.desiredRevisionId.includes('latest')))) {
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
        || !validDigest(value.configDigest) || typeof value.state !== 'string'
        || !['PAUSED', 'RUNNING'].includes(value.state)
        || typeof value.empty !== 'boolean' || !validDigest(value.tasksDigest)) {
        epochFail('RESOURCE_INVALID');
    }
}

function validateScheduler(value: unknown): void {
    assertKeys(value, SCHEDULER_KEYS);
    const pauseEpochMs = value.pauseEpochMs as unknown;
    const lastAttemptMs = value.lastAttemptMs as unknown;
    if (!safeString(value.resource) || !safeString(value.project) || !safeString(value.location)
        || !validDigest(value.configDigest) || typeof value.state !== 'string'
        || !['PAUSED', 'ENABLED'].includes(value.state)
        || !Number.isSafeInteger(pauseEpochMs) || (pauseEpochMs as number) < 0
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
        || !value.desiredBindings.every(item => safeString(item, 512))
        || !value.retiredBindings.every(item => safeString(item, 512))) epochFail('RESOURCE_INVALID');
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
    const settings = value.settings as Record<string, unknown>;
    const environment = value.environment as Record<string, unknown>;
    if (!isObject(value.environment) || !Object.values(environment).every(item => typeof item === 'string')
        || !isObject(value.secretReferences) || !Object.values(value.secretReferences).every(item => safeString(item, 256))
        || !isObject(value.settings) || !hasExactKeys(settings, RUNTIME_SETTINGS_KEYS)
        || !safeString(settings.cpu, 16) || !safeString(settings.memory, 32)
        || !Number.isSafeInteger(settings.concurrency) || (settings.concurrency as number) <= 0
        || !Number.isSafeInteger(settings.timeoutSeconds) || (settings.timeoutSeconds as number) <= 0
        || !Number.isSafeInteger(settings.maxInstances) || (settings.maxInstances as number) <= 0
        || !isObject(value.target) || !hasExactKeys(value.target, TARGET_KEYS)) epochFail('SOURCE_INVALID');
    validateUrl(value.target.url);
    validateUrl(value.target.audience);
    if (typeof value.noTraffic !== 'boolean' || typeof value.providerAdmissionEnabled !== 'boolean'
        || environment.ANALYSIS_PROVIDER_ADMISSION_ENABLED !== String(value.providerAdmissionEnabled)) epochFail('SOURCE_INVALID');
}

function validateQueueInput(value: unknown): asserts value is ProtectedQueueInput {
    assertKeys(value, QUEUE_INPUT_KEYS, 'RESOURCE_INVALID');
    if (!safeString(value.resource) || !RESOURCE_PATTERN.test(value.resource)
        || !safeString(value.project, 128) || !safeString(value.location, 128)
        || !isObject(value.target) || !hasExactKeys(value.target, QUEUE_TARGET_KEYS)) epochFail('RESOURCE_INVALID');
    validateUrl(value.target.url);
    validateUrl(value.target.audience);
    validateProtectedIdentity(value.target.callerIdentity);
    validateConfigObject(value.configuration);
}

function validateSchedulerInput(value: unknown): asserts value is ProtectedSchedulerInput {
    assertKeys(value, SCHEDULER_INPUT_KEYS, 'RESOURCE_INVALID');
    if (!safeString(value.resource) || !RESOURCE_PATTERN.test(value.resource)
        || !safeString(value.project, 128) || !safeString(value.location, 128)
        || !isObject(value.target) || !hasExactKeys(value.target, SCHEDULER_TARGET_KEYS)) epochFail('RESOURCE_INVALID');
    validateUrl(value.target.uri, true);
    validateUrl(value.target.audience);
    validateProtectedIdentity(value.target.identity);
    validateConfigObject(value.configuration);
    const pauseEpochMs = value.pauseEpochMs as unknown;
    const lastAttemptMs = value.lastAttemptMs as unknown;
    if (typeof value.state !== 'string' || !['PAUSED', 'ENABLED'].includes(value.state)
        || !Number.isSafeInteger(pauseEpochMs) || (pauseEpochMs as number) < 0
        || (lastAttemptMs !== null
            && (!Number.isSafeInteger(lastAttemptMs) || (lastAttemptMs as number) < 0))) epochFail('RESOURCE_INVALID');
}

function validateIamInput(value: unknown, expectedProject?: string): asserts value is ProtectedIamInput {
    assertKeys(value, IAM_INPUT_KEYS, 'RESOURCE_INVALID');
    if (!safeString(value.resource) || !RESOURCE_PATTERN.test(value.resource)
        || !safeString(value.project, 128) || !safeString(value.etag, 512)
        || !Array.isArray(value.bindings)) epochFail('RESOURCE_INVALID');
    if (expectedProject !== undefined && value.project !== expectedProject) epochFail('PROJECT_MISMATCH');
    for (const binding of value.bindings) {
        assertKeys(binding, IAM_BINDING_KEYS, 'RESOURCE_INVALID');
        if (!safeString(binding.role, 128) || !safeString(binding.member, 512)
            || (binding.condition !== null && !safeString(binding.condition, 2048))) epochFail('RESOURCE_INVALID');
        if (!binding.member.startsWith('serviceAccount:')) epochFail('RESOURCE_INVALID');
        const member = binding.member.slice('serviceAccount:'.length);
        const match = member.match(SERVICE_ACCOUNT_PATTERN);
        if (!match || (expectedProject !== undefined && match[1] !== expectedProject)) epochFail('IDENTITY_INVALID');
    }
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

function validatePlatformInputs(value: unknown, manifest: CapacityManifest): asserts value is ProtectedPlatformInputs {
    assertKeys(value, PLATFORM_KEYS, 'INVALID_PACKET');
    validateBuildInput(value.build);
    validateProtectedIdentity(manifest.build);
    if (value.build.identity.identity !== manifest.build.identity
        || value.build.identity.project !== manifest.build.project) epochFail('SOURCE_INVALID');
    const expectedProject = manifest.build.project;
    if (value.build.identity.project !== expectedProject) epochFail('PROJECT_MISMATCH');
    if (!isObject(value.runtime) || !hasExactKeys(value.runtime, ROLES)
        || !isObject(value.queues) || !hasExactKeys(value.queues, ROLES)
        || !isObject(value.schedulers) || !hasExactKeys(value.schedulers, ROLES)
        || !isObject(value.iam) || !hasExactKeys(value.iam, ROLES)) epochFail('INVALID_PACKET');
    for (const role of ROLES) {
        validateRuntimeInput(value.runtime[role], role);
        validateQueueInput(value.queues[role]);
        validateSchedulerInput(value.schedulers[role]);
        validateIamInput(value.iam[role], expectedProject);
        if (value.runtime[role].project !== expectedProject
            || value.runtime[role].identity.project !== expectedProject
            || value.queues[role].project !== expectedProject
            || value.queues[role].target.callerIdentity.project !== expectedProject
            || value.schedulers[role].project !== expectedProject
            || value.schedulers[role].target.identity.project !== expectedProject) epochFail('PROJECT_MISMATCH');
        validateQualifiedResource(value.queues[role].resource, expectedProject);
        validateQualifiedResource(value.schedulers[role].resource, expectedProject);
        validateQualifiedResource(value.iam[role].resource, expectedProject);
        if (value.runtime[role].identity.identity !== manifest.roleSlots[`${role}.runtime` as Slot].identity
            || value.queues[role].target.callerIdentity.identity !== manifest.roleSlots[`${role}.task-caller` as Slot].identity
            || value.schedulers[role].target.identity.identity !== manifest.roleSlots[`${role}.maintenance` as Slot].identity) epochFail('IDENTITY_CONFLICT');
    }
    validateRetentionInput(value.retention);
    if (value.retention.project !== expectedProject) epochFail('PROJECT_MISMATCH');
    validateQualifiedResource(value.retention.resource, expectedProject);
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
            || canonicalDigest(queues[role].configuration) !== canonicalDigest(expectedQueue.configuration)
            || !Array.isArray(queues[role].tasks)) epochFail('RESOURCE_INVALID');
        if (queues[role].tasks.length > 0 && manifest.queues[role].empty) epochFail('EVIDENCE_UNAVAILABLE');
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
    }

    const iam = value.iam as Record<Role, unknown>;
    for (const role of ROLES) {
        validateIamInput(iam[role], manifest.build.project);
        if (canonicalDigest(iam[role]) !== canonicalDigest(platform.iam[role])) epochFail('RESOURCE_INVALID');
    }
    validateRetentionInput(value.retention);
    if (canonicalDigest(value.retention) !== canonicalDigest(platform.retention)) epochFail('RESOURCE_INVALID');

    const readiness = value.readiness;
    if (!hasExactKeys(readiness, [...READINESS_KEYS, 'ready']) || typeof readiness.ready !== 'boolean') epochFail('READINESS_INVALID');
    const readinessWithoutAggregate = { ...readiness };
    delete readinessWithoutAggregate.ready;
    validateReadiness(readinessWithoutAggregate);
    if (canonicalDigest(readinessWithoutAggregate) !== canonicalDigest(manifest.readiness)) epochFail('READINESS_INVALID');
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
    validatePlatformInputs(targetPlatform, manifest);
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

function deriveCapabilityDigest(packet: CapacityEpochPacket): string {
    return canonicalDigest({
        epochId: packet.epochId,
        lockNamespace: packet.lockNamespace,
        roleSetDigest: packet.roleSetDigest,
        oldManifestDigest: packet.oldManifestDigest,
        desiredManifestDigest: packet.desiredManifestDigest,
        sourcePlanDigest: packet.sourcePlanDigest,
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
    const protectedObservations = value.protectedObservations as Record<string, unknown>;
    const activation = value.activation as Record<string, unknown>;
    const quiescence = value.quiescence as Record<string, unknown>;
    const observationInputs = value.observationInputs as Record<string, unknown>;
    const probe = value.probe as Record<string, unknown>;
    if (!safeString(value.epochId, 128) || !safeString(value.lockNamespace, 128)
        || !Array.isArray(value.roleSet) || value.roleSet.length !== ROLES.length
        || !value.roleSet.every(isRole) || new Set(value.roleSet).size !== ROLES.length
        || !isObject(protectedInputs) || !hasExactKeys(protectedInputs, ['old', 'desired'])
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
    validateManifest(value.oldManifest);
    validateManifest(value.desiredManifest);
    validateManifestComparison(value.oldManifest, value.desiredManifest);
    validatePlatformInputs(protectedInputs.old, value.oldManifest);
    validatePlatformInputs(protectedInputs.desired, value.desiredManifest);
    validateOldObservations(protectedObservations.old, value.oldManifest, protectedInputs.old);
    validateObservationTargets(protectedObservations.desired, value.desiredManifest, protectedInputs.desired);
    if (!isDigest(value.oldManifestDigest) || !isDigest(value.desiredManifestDigest)
        || !isDigest(value.capabilityDigest) || !isDigest(value.roleSetDigest) || !isDigest(value.sourcePlanDigest)) epochFail('INVALID_PACKET');
}

export function createProtectedPacket(input: ProtectedPacketInput): CapacityEpochPacket {
    if (!Array.isArray(input.roleSet) || input.roleSet.length !== ROLES.length
        || !input.roleSet.every(isRole) || new Set(input.roleSet).size !== ROLES.length) epochFail('INVALID_PACKET');
    validateManifest(input.oldManifest);
    validateManifest(input.desiredManifest);
    validateManifestComparison(input.oldManifest, input.desiredManifest);
    validatePlatformInputs(input.protectedInputs.old, input.oldManifest);
    validatePlatformInputs(input.protectedInputs.desired, input.desiredManifest);
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

export function assertCoordinatorCapability(packet: CapacityEpochPacket, capability: CoordinatorCapability): void {
    if ((typeof capability !== 'object' && typeof capability !== 'function') || capability === null) epochFail('CAPABILITY_INVALID');
    const binding = capabilityRegistry.get(capability);
    if (!binding) epochFail('CAPABILITY_INVALID');
    if (binding.epochId !== packet.epochId
        || binding.packetDigest !== canonicalDigest(packet)
        || binding.roleSetDigest !== packet.roleSetDigest
        || binding.lockNamespace !== packet.lockNamespace) epochFail('CAPABILITY_BINDING_MISMATCH');
}

export type ProtectedPacketDescriptor = Readonly<{ fd: number; maxBytes?: number }>;

/** Parse JSON structure only to reject duplicate decoded object keys. */
function rejectDuplicateJsonKeys(raw: string): void {
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
    if ((!stat.isFile() && !stat.isFIFO())
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

export const parseProtectedPacket = loadProtectedPacket;

// Keep the imported class visible to callers that use `instanceof` while
// ensuring all actual messages stay fixed-code.
export { EpochError };
