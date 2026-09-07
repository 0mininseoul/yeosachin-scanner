import {
    canonicalDigest,
    epochFail,
    hasExactKeys,
    isDigest,
    isObject,
    isSha,
    type ProducerContract,
    type ProtectedQueueInput,
    type ProtectedRetentionInput,
    type ProtectedRuntimeInput,
    type ProtectedSchedulerInput,
    type ReadinessContract,
    type RevisionContract,
    type Role,
} from './contracts';

const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;
const SAFE = /^[^\u0000-\u001f\u007f]{1,4096}$/;

export type SourceObservation = Readonly<{
    role: Role;
    sourceSha: string;
    revision: string;
    metadataDigest: string;
}>;

export type RuntimeObservation = ProtectedRuntimeInput & Readonly<{
    generation: string;
    resourceVersion: string;
    runtimeDigest: string;
    buildDigest: string;
    traffic: Readonly<Record<string, number>>;
}>;

export type QueueObservation = ProtectedQueueInput & Readonly<{
    role: Role;
    configurationDigest: string;
    state: 'PAUSED' | 'RUNNING';
    tasks: readonly Readonly<{ name: string; payloadDigest: string; createTime: string }>[];
    complete: boolean;
}>;

export type SchedulerObservation = ProtectedSchedulerInput & Readonly<{
    role: Role;
    configurationDigest: string;
    nowMs: number;
}>;

export type IamObservation = Readonly<{
    role: Role;
    resource: string;
    project: string;
    etag: string;
    bindings: readonly Readonly<{ role: string; member: string; condition: string | null }>[];
}>;

export type RetentionObservation = ProtectedRetentionInput & Readonly<{ role: 'retention' }>;
export type ReadinessObservation = ReadinessContract & Readonly<{ ready: boolean }>;

export type ZeroWorkObservation = Readonly<{
    windowStartMs: number;
    windowEndMs: number;
    providerLedger: Readonly<{ digest: string; observedAtMs: number; complete: boolean }>;
    billingLedger: Readonly<{ digest: string; observedAtMs: number; complete: boolean }>;
    taskAudit: Readonly<{ digest: string; observedAtMs: number; complete: boolean }>;
    receiverLog: Readonly<{ digest: string; observedAtMs: number; complete: boolean }>;
}>;

function safe(value: unknown, max = 4096): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= max && SAFE.test(value);
}

function identity(value: unknown): void {
    if (!isObject(value) || !hasExactKeys(value, ['identity', 'project'])
        || typeof value.identity !== 'string' || typeof value.project !== 'string') epochFail('OBSERVATION_INVALID');
    const match = value.identity.match(SERVICE_ACCOUNT);
    if (!match || match[1] !== value.project) epochFail('OBSERVATION_INVALID');
}

function https(value: unknown, allowQuery = false): void {
    if (typeof value !== 'string' || value.length > 2048) epochFail('OBSERVATION_INVALID');
    let parsed: URL;
    try { parsed = new URL(value); } catch { epochFail('OBSERVATION_INVALID'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || (!allowQuery && parsed.search)) epochFail('OBSERVATION_INVALID');
}

export function validateSourceObservation(value: unknown, expected: Pick<RevisionContract, 'oldSha' | 'oldRevision'>, phase: 'old' | 'desired'): asserts value is SourceObservation {
    if (!isObject(value) || !hasExactKeys(value, ['role', 'sourceSha', 'revision', 'metadataDigest'])
        || (value.role !== 'preflight' && value.role !== 'paid') || !isSha(value.sourceSha)
        || !safe(value.revision, 128) || !isDigest(value.metadataDigest)) epochFail('SOURCE_INVALID');
    if (phase === 'old' && (value.sourceSha !== expected.oldSha || value.revision !== expected.oldRevision)) epochFail('SOURCE_INVALID');
}

export function validateRuntimeObservation(value: unknown, expected: ProtectedRuntimeInput): asserts value is RuntimeObservation {
    const keys = ['role', 'service', 'project', 'location', 'identity', 'sourceSha', 'environment', 'secretReferences', 'settings', 'target', 'noTraffic', 'providerAdmissionEnabled', 'generation', 'resourceVersion', 'runtimeDigest', 'buildDigest', 'traffic'];
    if (!isObject(value) || !hasExactKeys(value, keys) || value.role !== expected.role
        || value.service !== expected.service || value.project !== expected.project || value.location !== expected.location
        || value.sourceSha !== expected.sourceSha || value.noTraffic !== true || value.providerAdmissionEnabled !== true
        || !safe(value.generation, 128) || !safe(value.resourceVersion, 256)
        || !isDigest(value.runtimeDigest) || !isDigest(value.buildDigest) || !isObject(value.environment)
        || !isObject(value.secretReferences) || !isObject(value.settings) || !isObject(value.target)
        || !isObject(value.traffic) || Object.keys(value.traffic).length !== 0) epochFail('RUNTIME_MISMATCH');
    identity(value.identity);
    if (canonicalDigest(value.identity) !== canonicalDigest(expected.identity)
        || canonicalDigest(value.environment) !== canonicalDigest(expected.environment)
        || canonicalDigest(value.secretReferences) !== canonicalDigest(expected.secretReferences)
        || canonicalDigest(value.settings) !== canonicalDigest(expected.settings)
        || canonicalDigest(value.target) !== canonicalDigest(expected.target)) epochFail('RUNTIME_MISMATCH');
    https(value.target.url);
    https(value.target.audience);
}

export function validateQueueObservation(value: unknown, expected: ProtectedQueueInput, expectedConfigurationDigest: string): asserts value is QueueObservation {
    if (!isObject(value) || !hasExactKeys(value, ['role', 'resource', 'project', 'location', 'target', 'configuration', 'configurationDigest', 'state', 'tasks', 'complete'])
        || (value.role !== 'preflight' && value.role !== 'paid') || value.resource !== expected.resource
        || value.project !== expected.project || value.location !== expected.location
        || !isObject(value.target) || !isObject(value.configuration) || value.configurationDigest !== expectedConfigurationDigest
        || value.state !== 'PAUSED' || !Array.isArray(value.tasks)) epochFail('OBSERVATION_INVALID');
    if (canonicalDigest(value.configuration) !== canonicalDigest(expected.configuration)) epochFail('OBSERVATION_INVALID');
    https(value.target.url);
    https(value.target.audience);
    identity(value.target.callerIdentity);
    if (value.tasks.length > 0) epochFail('QUEUE_NOT_EMPTY');
    for (const task of value.tasks) {
        if (!isObject(task) || !hasExactKeys(task, ['name', 'payloadDigest', 'createTime'])
            || !safe(task.name, 512) || !RESOURCE.test(task.name) || !isDigest(task.payloadDigest) || !safe(task.createTime, 64)) epochFail('OBSERVATION_INVALID');
    }
    if (value.complete !== true) epochFail('PAGINATION_INCOMPLETE');
}

export function validateSchedulerObservation(value: unknown, expected: ProtectedSchedulerInput, nowMs: number, timeoutMs: number, graceMs: number): asserts value is SchedulerObservation {
    if (!isObject(value) || !hasExactKeys(value, ['role', 'resource', 'project', 'location', 'target', 'configuration', 'configurationDigest', 'state', 'pauseEpochMs', 'lastAttemptMs', 'nowMs'])
        || (value.role !== 'preflight' && value.role !== 'paid') || value.resource !== expected.resource
        || value.project !== expected.project || value.location !== expected.location || value.state !== 'PAUSED'
        || value.nowMs !== nowMs || !Number.isSafeInteger(value.pauseEpochMs) || (value.pauseEpochMs as number) < 0
        || !Number.isSafeInteger(value.lastAttemptMs) && value.lastAttemptMs !== null
        || (value.lastAttemptMs !== null && (value.lastAttemptMs as number) < 0)
        || !isObject(value.target) || !isObject(value.configuration) || value.configurationDigest !== canonicalDigest(expected.configuration)
        || canonicalDigest(value.configuration) !== canonicalDigest(expected.configuration)) epochFail('OBSERVATION_INVALID');
    if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
        || !Number.isSafeInteger(graceMs) || graceMs < 0 || (value.pauseEpochMs as number) > nowMs
        || nowMs - (value.pauseEpochMs as number) < timeoutMs + graceMs
        || (value.lastAttemptMs !== null && nowMs - (value.lastAttemptMs as number) < timeoutMs + graceMs)) epochFail('SCHEDULER_NOT_QUIESCENT');
    const target = value.target as Record<string, unknown>;
    if (!hasExactKeys(target, ['uri', 'audience', 'identity'])) epochFail('OBSERVATION_INVALID');
    https(target.uri, true);
    https(target.audience);
    identity(target.identity);
}

export function validateIamObservation(value: unknown, expected: IamObservation): asserts value is IamObservation {
    if (!isObject(value) || !hasExactKeys(value, ['role', 'resource', 'project', 'etag', 'bindings'])
        || value.role !== expected.role || value.resource !== expected.resource || value.project !== expected.project
        || !safe(value.etag, 512) || !Array.isArray(value.bindings)) epochFail('IAM_ETAG_REQUIRED');
    if (canonicalDigest(value.bindings) !== canonicalDigest(expected.bindings)) epochFail('OBSERVATION_INVALID');
    for (const binding of value.bindings) {
        if (!isObject(binding) || !hasExactKeys(binding, ['role', 'member', 'condition']) || !safe(binding.role, 128)
            || typeof binding.member !== 'string' || !binding.member.startsWith('serviceAccount:')
            || (binding.condition !== null && !safe(binding.condition, 2048))) epochFail('OBSERVATION_INVALID');
        const member = binding.member.slice('serviceAccount:'.length);
        const match = member.match(SERVICE_ACCOUNT);
        if (!match) epochFail('OBSERVATION_INVALID');
    }
}

export function validateRetentionObservation(value: unknown, expected: ProtectedRetentionInput): asserts value is RetentionObservation {
    if (!isObject(value) || !hasExactKeys(value, ['role', 'resource', 'project', 'location', 'enabled', 'configuration'])
        || value.role !== 'retention' || value.resource !== expected.resource || value.project !== expected.project
        || value.location !== expected.location || value.enabled !== true || !isObject(value.configuration)
        || canonicalDigest(value.configuration) !== canonicalDigest(expected.configuration)) epochFail('OBSERVATION_INVALID');
}

export function validateReadinessObservation(value: unknown, expected: ReadinessContract): asserts value is ReadinessObservation {
    const keys = ['schemaVersion', 'sourceSha', 'legacyTargetResource', 'preflightFingerprint', 'paidFingerprint', 'analysisV2AdmissionEnabled', 'earlybirdWebhookAutoAdmissionEnabled', 'ready'];
    if (!isObject(value) || !hasExactKeys(value, keys) || value.schemaVersion !== expected.schemaVersion
        || value.sourceSha !== expected.sourceSha || value.legacyTargetResource !== expected.legacyTargetResource
        || value.preflightFingerprint !== expected.preflightFingerprint || value.paidFingerprint !== expected.paidFingerprint
        || typeof value.analysisV2AdmissionEnabled !== 'boolean' || typeof value.earlybirdWebhookAutoAdmissionEnabled !== 'boolean'
        || typeof value.ready !== 'boolean') epochFail('READINESS_INVALID');
}

export function validateZeroWorkObservation(value: unknown, nowMs: number): asserts value is ZeroWorkObservation {
    const evidenceKeys = ['digest', 'observedAtMs', 'complete'];
    const rootKeys = ['windowStartMs', 'windowEndMs', 'providerLedger', 'billingLedger', 'taskAudit', 'receiverLog'];
    if (!isObject(value) || !hasExactKeys(value, rootKeys)
        || !Number.isSafeInteger(value.windowStartMs) || !Number.isSafeInteger(value.windowEndMs)
        || (value.windowStartMs as number) < 0 || (value.windowEndMs as number) < (value.windowStartMs as number)
        || (value.windowEndMs as number) > nowMs) epochFail('ZERO_WORK_INCOMPLETE');
    for (const source of ['providerLedger', 'billingLedger', 'taskAudit', 'receiverLog'] as const) {
        const proof = value[source];
        if (!isObject(proof) || !hasExactKeys(proof, evidenceKeys) || !isDigest(proof.digest)
            || !Number.isSafeInteger(proof.observedAtMs) || (proof.observedAtMs as number) > nowMs || proof.complete !== true) epochFail('ZERO_WORK_INCOMPLETE');
    }
}

export function validateProducerObservation(value: unknown, expected: ProducerContract): void {
    if (!isObject(value) || !hasExactKeys(value, ['sourceSha', 'fingerprintVersion', 'fingerprint', 'admissionEnabled'])
        || value.sourceSha !== expected.sourceSha || value.fingerprintVersion !== expected.fingerprintVersion
        || value.fingerprint !== expected.fingerprint || value.admissionEnabled !== expected.admissionEnabled) epochFail('PRODUCER_INVALID');
}
