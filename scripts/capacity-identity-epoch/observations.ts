import {
    canonicalDigest,
    epochFail,
    hasExactKeys,
    isDigest,
    isObject,
    isSha,
    type ProducerContract,
    type ProtectedQueueInput,
    type ProtectedIdentity,
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
const IMMUTABLE_REVISION = /^[a-z][a-z0-9-]{0,62}$/;

export type SourceObservation = Readonly<{
    role: Role;
    sourceSha: string;
    revision: string;
    metadataDigest: string;
}>;

export type RuntimeObservation = ProtectedRuntimeInput & Readonly<{
    mode: 'STAGED' | 'PROMOTED';
    revision: string;
    generation: string;
    resourceVersion: string;
    runtimeDigest: string;
    buildDigest: string;
    traffic: Readonly<Record<string, number>>;
}>;

export type QueueTargetObservation = Readonly<{
    url: string | null;
    audience: string;
    callerIdentity: ProtectedIdentity;
    uriOverride: Readonly<Record<string, unknown>> | null;
}>;

export type QueueObservation = Omit<ProtectedQueueInput, 'target'> & Readonly<{
    role: Role;
    target: QueueTargetObservation | null;
    httpTargetPresent: boolean;
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
    bindings: readonly Readonly<{ role: string; member: string; condition: string | null | Readonly<Record<string, string>> }>[];
}>;

export type RetentionObservation = ProtectedRetentionInput & Readonly<{ role: 'retention' }>;
export type ReadinessObservation = ReadinessContract & Readonly<{ ready: boolean }>;

export type ZeroWorkObservation = Readonly<{
    windowStartMs: number;
    windowEndMs: number;
    providerLedger: ZeroWorkEvidence;
    billingLedger: ZeroWorkEvidence;
    taskAudit: ZeroWorkEvidence;
    receiverLog: ZeroWorkEvidence;
}>;

export type ZeroWorkEvidence = Readonly<{
    provenance: string;
    digest: string;
    observedAtMs: number;
    coveredStartMs: number;
    coveredEndMs: number;
    coverageLagMs: number;
    freshnessLagMs: number;
    complete: boolean;
    eventCount: number;
    deltaCount: number;
}>;

export type RuntimeObservationExpectation = Readonly<{
    mode: 'STAGED' | 'PROMOTED';
    revision: string;
    runtimeDigest: string;
    buildDigest: string;
}>;

export const ZERO_WORK_SOURCES = ['providerLedger', 'billingLedger', 'taskAudit', 'receiverLog'] as const;
export type ZeroWorkSource = typeof ZERO_WORK_SOURCES[number];
export type ZeroWorkWindowExpectation = Readonly<{
    windowStartMs: number;
    windowEndMs: number;
    provenance: Readonly<Record<ZeroWorkSource, string>>;
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

export function validateSourceObservation(value: unknown, expected: Pick<RevisionContract, 'oldSha' | 'oldRevision' | 'desiredSha'> & Readonly<{ role: Role; desiredRevisionId?: string }>, phase: 'old' | 'desired'): asserts value is SourceObservation {
    if (!isObject(value) || !hasExactKeys(value, ['role', 'sourceSha', 'revision', 'metadataDigest'])
        || value.role !== expected.role || !isSha(value.sourceSha)
        || !safe(value.revision, 128) || !isDigest(value.metadataDigest)) epochFail('SOURCE_INVALID');
    if (phase === 'old' && (value.sourceSha !== expected.oldSha || value.revision !== expected.oldRevision)) epochFail('SOURCE_INVALID');
    if (phase === 'desired' && (!expected.desiredRevisionId
        || value.sourceSha !== expected.desiredSha || value.revision !== expected.desiredRevisionId
        || value.revision === 'latest')) epochFail('SOURCE_INVALID');
}

export function validateRuntimeObservation(value: unknown, expected: ProtectedRuntimeInput, options: RuntimeObservationExpectation): asserts value is RuntimeObservation {
    if (!isObject(options) || (options.mode !== 'STAGED' && options.mode !== 'PROMOTED')
        || !safe(options.revision, 128) || !IMMUTABLE_REVISION.test(options.revision) || options.revision === 'latest'
        || !isDigest(options.runtimeDigest) || !isDigest(options.buildDigest)) epochFail('RUNTIME_MISMATCH');
    const mode = options.mode;
    const keys = ['role', 'service', 'project', 'location', 'identity', 'sourceSha', 'environment', 'secretReferences', 'settings', 'target', 'noTraffic', 'providerAdmissionEnabled', 'mode', 'revision', 'generation', 'resourceVersion', 'runtimeDigest', 'buildDigest', 'traffic'];
    if (!isObject(value) || !hasExactKeys(value, keys) || value.role !== expected.role
        || value.service !== expected.service || value.project !== expected.project || value.location !== expected.location
        || value.sourceSha !== expected.sourceSha || value.mode !== mode || value.revision !== options.revision
        || value.providerAdmissionEnabled !== true || value.runtimeDigest !== options.runtimeDigest
        || value.buildDigest !== options.buildDigest
        || !safe(value.generation, 128) || !safe(value.resourceVersion, 256)
        || !isDigest(value.runtimeDigest) || !isDigest(value.buildDigest) || !isObject(value.environment)
        || !isObject(value.secretReferences) || !isObject(value.settings) || !isObject(value.target)
        || !isObject(value.traffic)) epochFail('RUNTIME_MISMATCH');
    if (mode === 'STAGED' && (value.noTraffic !== true || Object.keys(value.traffic).length !== 0)) epochFail('RUNTIME_MISMATCH');
    if (mode === 'PROMOTED' && (value.noTraffic !== false
        || Object.keys(value.traffic).length !== 1
        || value.traffic[options.revision] !== 100)) epochFail('RUNTIME_MISMATCH');
    if (!Object.entries(value.traffic).every(([revision, percentage]) => safe(revision, 128)
        && revision !== 'latest' && typeof percentage === 'number'
        && Number.isSafeInteger(percentage) && percentage >= 0 && percentage <= 100)) epochFail('RUNTIME_MISMATCH');
    identity(value.identity);
    if (canonicalDigest(value.identity) !== canonicalDigest(expected.identity)
        || canonicalDigest(value.environment) !== canonicalDigest(expected.environment)
        || canonicalDigest(value.secretReferences) !== canonicalDigest(expected.secretReferences)
        || canonicalDigest(value.settings) !== canonicalDigest(expected.settings)
        || canonicalDigest(value.target) !== canonicalDigest(expected.target)) epochFail('RUNTIME_MISMATCH');
    https(value.target.url);
    https(value.target.audience);
}

export function validateQueueObservation(value: unknown, expected: ProtectedQueueInput, expectedConfigurationDigest: string, expectedRole: Role): asserts value is QueueObservation {
    if (!isObject(value) || !hasExactKeys(value, ['role', 'resource', 'project', 'location', 'target', 'httpTargetPresent', 'configuration', 'configurationDigest', 'state', 'tasks', 'complete'])
        || value.role !== expectedRole || value.resource !== expected.resource
        || value.project !== expected.project || value.location !== expected.location
        || typeof value.httpTargetPresent !== 'boolean' || !isObject(value.configuration) || value.configurationDigest !== expectedConfigurationDigest
        || value.state !== 'PAUSED' || !Array.isArray(value.tasks)) epochFail('OBSERVATION_INVALID');
    if (canonicalDigest(value.configuration) !== canonicalDigest(expected.configuration)) epochFail('OBSERVATION_INVALID');
    if (value.httpTargetPresent !== (value.target !== null)) epochFail('OBSERVATION_INVALID');
    if (value.target === null) {
        // An omitted Cloud Tasks httpTarget is an observed fact. It is not
        // equivalent to the reviewed packet target and must remain explicit.
        if (isObject(expected.configuration.httpTarget)) epochFail('OBSERVATION_INVALID');
    } else {
        const target = value.target;
        if (!isObject(target) || !hasExactKeys(target, ['url', 'audience', 'callerIdentity', 'uriOverride'])
            || (target.url !== null && typeof target.url !== 'string')
            || typeof target.audience !== 'string' || !isObject(target.callerIdentity)
            || (target.uriOverride !== null && !isObject(target.uriOverride))) epochFail('OBSERVATION_INVALID');
        if (target.url !== null) https(target.url);
        https(target.audience);
        identity(target.callerIdentity);
        if (target.audience !== expected.target.audience
            || canonicalDigest(target.callerIdentity) !== canonicalDigest(expected.target.callerIdentity)) epochFail('OBSERVATION_INVALID');
        const expectedHttpTarget = isObject(expected.configuration.httpTarget) ? expected.configuration.httpTarget : null;
        const expectedOverride = expectedHttpTarget?.uriOverride ?? null;
        if (canonicalDigest(target.uriOverride) !== canonicalDigest(expectedOverride)) epochFail('OBSERVATION_INVALID');
        if (target.url !== null && target.url !== expected.target.url) epochFail('OBSERVATION_INVALID');
    }
    if (value.tasks.length > 0) epochFail('QUEUE_NOT_EMPTY');
    for (const task of value.tasks) {
        if (!isObject(task) || !hasExactKeys(task, ['name', 'payloadDigest', 'createTime'])
            || !safe(task.name, 512) || !RESOURCE.test(task.name) || !isDigest(task.payloadDigest) || !safe(task.createTime, 64)) epochFail('OBSERVATION_INVALID');
    }
    if (value.complete !== true) epochFail('PAGINATION_INCOMPLETE');
}

export function validateSchedulerObservation(value: unknown, expected: ProtectedSchedulerInput, nowMs: number, timeoutMs: number, graceMs: number, expectedRole: Role): asserts value is SchedulerObservation {
    if (!isObject(value) || !hasExactKeys(value, ['role', 'resource', 'project', 'location', 'target', 'configuration', 'configurationDigest', 'state', 'pauseEpochMs', 'lastAttemptMs', 'nowMs'])
        || value.role !== expectedRole || value.resource !== expected.resource
        || value.project !== expected.project || value.location !== expected.location || value.state !== 'PAUSED'
        || value.nowMs !== nowMs || !Number.isSafeInteger(value.pauseEpochMs) || (value.pauseEpochMs as number) < 0
        || !Number.isSafeInteger(value.lastAttemptMs) && value.lastAttemptMs !== null
        || (value.lastAttemptMs !== null && (value.lastAttemptMs as number) < 0)
        || !isObject(value.target) || !isObject(value.configuration) || value.configurationDigest !== canonicalDigest(expected.configuration)
        || canonicalDigest(value.configuration) !== canonicalDigest(expected.configuration)
        || canonicalDigest(value.target) !== canonicalDigest(expected.target)) epochFail('OBSERVATION_INVALID');
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
        || !safe(value.etag, 512) || value.etag !== expected.etag || !Array.isArray(value.bindings)) epochFail('IAM_ETAG_REQUIRED');
    if (canonicalDigest(value.bindings) !== canonicalDigest(expected.bindings)) epochFail('OBSERVATION_INVALID');
    for (const binding of value.bindings) {
        if (!isObject(binding) || !hasExactKeys(binding, ['role', 'member', 'condition']) || !safe(binding.role, 128)
            || typeof binding.member !== 'string' || !safe(binding.member, 1024)
            || (binding.condition !== null && typeof binding.condition !== 'string' && !isObject(binding.condition))) epochFail('OBSERVATION_INVALID');
        if (typeof binding.condition === 'string' && !safe(binding.condition, 2048)) epochFail('OBSERVATION_INVALID');
        if (isObject(binding.condition) && (!Object.keys(binding.condition).every(key => ['title', 'description', 'expression', 'location'].includes(key))
            || !Object.values(binding.condition).every(item => typeof item === 'string' && safe(item, 4096)))) epochFail('OBSERVATION_INVALID');
        if (binding.member !== 'allUsers' && binding.member !== 'allAuthenticatedUsers'
            && !/^(?:user|group|domain|principal|principalSet|serviceAccount):[^\u0000-\u001f\u007f]{1,1023}$/.test(binding.member)) epochFail('OBSERVATION_INVALID');
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
        || typeof value.ready !== 'boolean'
        || value.analysisV2AdmissionEnabled !== expected.analysisV2AdmissionEnabled
        || value.earlybirdWebhookAutoAdmissionEnabled !== expected.earlybirdWebhookAutoAdmissionEnabled
        || value.ready !== true) epochFail('READINESS_INVALID');
}

export function validateZeroWorkObservation(value: unknown, nowMs: number, expectedWindow: ZeroWorkWindowExpectation, maxLagMs = 300_000, maxCoverageLagMs = maxLagMs): asserts value is ZeroWorkObservation {
    const evidenceKeys = ['provenance', 'digest', 'observedAtMs', 'coveredStartMs', 'coveredEndMs', 'coverageLagMs', 'freshnessLagMs', 'complete', 'eventCount', 'deltaCount'];
    const rootKeys = ['windowStartMs', 'windowEndMs', 'providerLedger', 'billingLedger', 'taskAudit', 'receiverLog'];
    if (!isObject(value) || !hasExactKeys(value, rootKeys) || !isObject(expectedWindow)
        || !Number.isSafeInteger(nowMs) || nowMs < 0
        || !Number.isSafeInteger(expectedWindow.windowStartMs) || !Number.isSafeInteger(expectedWindow.windowEndMs)
        || expectedWindow.windowStartMs < 0 || expectedWindow.windowEndMs <= expectedWindow.windowStartMs
        || expectedWindow.windowEndMs > nowMs || !isObject(expectedWindow.provenance)
        || !hasExactKeys(expectedWindow.provenance, ZERO_WORK_SOURCES)
        || !ZERO_WORK_SOURCES.every(source => safe(expectedWindow.provenance[source], 2048))
        || !Number.isSafeInteger(value.windowStartMs) || !Number.isSafeInteger(value.windowEndMs)
        || value.windowStartMs !== expectedWindow.windowStartMs || value.windowEndMs !== expectedWindow.windowEndMs) epochFail('ZERO_WORK_INCOMPLETE');
    for (const source of ZERO_WORK_SOURCES) {
        const proof = value[source];
        if (!isObject(proof) || !hasExactKeys(proof, evidenceKeys) || proof.provenance !== expectedWindow.provenance[source]
            || !safe(proof.provenance, 2048) || !isDigest(proof.digest)
            || !Number.isSafeInteger(proof.observedAtMs) || (proof.observedAtMs as number) < (value.windowEndMs as number)
            || (proof.observedAtMs as number) > nowMs || proof.complete !== true
            || proof.coveredStartMs !== value.windowStartMs || proof.coveredEndMs !== value.windowEndMs
            || (proof.coveredEndMs as number) > (proof.observedAtMs as number)
            || !Number.isSafeInteger(proof.coverageLagMs) || proof.coverageLagMs !== (proof.observedAtMs as number) - (proof.coveredEndMs as number)
            || proof.coverageLagMs < 0 || proof.coverageLagMs > maxCoverageLagMs
            || !Number.isSafeInteger(proof.freshnessLagMs) || proof.freshnessLagMs !== nowMs - (proof.observedAtMs as number)
            || proof.freshnessLagMs < 0 || proof.freshnessLagMs > maxLagMs
            || proof.eventCount !== 0 || proof.deltaCount !== 0) epochFail('ZERO_WORK_INCOMPLETE');
    }
}

export function validateProducerObservation(value: unknown, expected: ProducerContract): void {
    if (!isObject(value) || !hasExactKeys(value, ['sourceSha', 'fingerprintVersion', 'fingerprint', 'admissionEnabled'])
        || value.sourceSha !== expected.sourceSha || value.fingerprintVersion !== expected.fingerprintVersion
        || value.fingerprint !== expected.fingerprint || value.admissionEnabled !== expected.admissionEnabled) epochFail('PRODUCER_INVALID');
}
