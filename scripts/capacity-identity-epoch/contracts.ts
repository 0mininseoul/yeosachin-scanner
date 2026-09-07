import { createHash } from 'node:crypto';

export const ROLES = ['preflight', 'paid'] as const;
export const SLOTS = [
    'preflight.task-caller', 'preflight.enqueuer', 'preflight.runtime',
    'preflight.maintenance', 'paid.task-caller', 'paid.enqueuer',
    'paid.runtime', 'paid.maintenance',
] as const;
export const STATES = [
    'PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED',
    'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED', 'ACTIVATED',
] as const;

export type Role = typeof ROLES[number];
export type Slot = typeof SLOTS[number];
export type State = typeof STATES[number];

export type EpochErrorCode =
    | 'INVALID_PACKET'
    | 'INVALID_SCHEMA'
    | 'IDENTITY_INVALID'
    | 'IDENTITY_CONFLICT'
    | 'PROJECT_MISMATCH'
    | 'CAPABILITY_INVALID'
    | 'CAPABILITY_BINDING_MISMATCH'
    | 'LOCK_NAMESPACE_MISMATCH'
    | 'PROTECTED_INPUT_UNAVAILABLE'
    | 'SOURCE_INVALID'
    | 'READINESS_INVALID'
    | 'RESOURCE_INVALID'
    | 'ACTIVATION_INVALID'
    | 'EVIDENCE_UNAVAILABLE'
    | 'LOCK_LOST'
    | 'JOURNAL_INVALID'
    | 'GENERATION_PRECONDITION_FAILED'
    | 'OBSERVATION_RACE'
    | 'PROBE_FAILED'
    | 'OBSERVATION_INVALID'
    | 'SCHEDULER_NOT_QUIESCENT'
    | 'QUEUE_NOT_EMPTY'
    | 'RUNTIME_MISMATCH'
    | 'IAM_ETAG_REQUIRED'
    | 'PAGINATION_INCOMPLETE'
    | 'ZERO_WORK_INCOMPLETE'
    | 'PRODUCER_INVALID'
    | 'ABORTED_EPOCH'
    | 'NOT_VERIFIED'
    | 'ACTIVATION_AUTH_REQUIRED'
    | 'ADAPTER_REQUEST_INVALID'
    | 'ADAPTER_RESPONSE_INVALID'
    | 'ADAPTER_TIMEOUT'
    | 'ADAPTER_REDIRECT'
    | 'ADAPTER_NOT_ALLOWED'
    | 'PROVIDER_NETWORK_FORBIDDEN';

/** Errors contain only an allowlisted code, never provider input or raw errors. */
export class EpochError extends Error {
    readonly code: EpochErrorCode;

    constructor(code: EpochErrorCode) {
        super(code);
        this.name = 'EpochError';
        this.code = code;
    }
}

export function epochFail(code: EpochErrorCode): never {
    throw new EpochError(code);
}

export type ProtectedIdentity = Readonly<{
    identity: string;
    project: string;
}>;

export type RevisionContract = Readonly<{
    oldSha: string;
    oldRevision: string;
    desiredSha: string;
    desiredBuildDigest: string;
    desiredRuntimeDigest: string;
    revisionPlan: Readonly<{ prefix: string; suffix: string }>;
    desiredRevisionId?: string;
}>;

export type ProducerContract = Readonly<{
    sourceSha: string;
    fingerprintVersion: string;
    fingerprint: string;
    admissionEnabled: boolean;
}>;

export type QueueContract = Readonly<{
    resource: string;
    project: string;
    location: string;
    configDigest: string;
    state: 'PAUSED' | 'RUNNING';
    empty: boolean;
    tasksDigest: string;
}>;

export type SchedulerContract = Readonly<{
    resource: string;
    project: string;
    location: string;
    configDigest: string;
    state: 'PAUSED' | 'ENABLED';
    pauseEpochMs: number;
    lastAttemptMs: number | null;
}>;

export type RetentionContract = Readonly<{
    resource: string;
    project: string;
    location: string;
    enabled: boolean;
    configDigest: string;
}>;

export type IamContract = Readonly<{
    policyDigest: string;
    desiredBindings: readonly string[];
    retiredBindings: readonly string[];
}>;

export type ReadinessContract = Readonly<{
    schemaVersion: 'analysis-public-freeze-readiness-v3';
    sourceSha: string;
    legacyTargetResource: string;
    preflightFingerprint: string;
    paidFingerprint: string;
    analysisV2AdmissionEnabled: boolean;
    earlybirdWebhookAutoAdmissionEnabled: boolean;
}>;

/**
 * Protected execution inputs are retained only in the in-process packet. They
 * are deliberately separate from the digest-only journal projection so live
 * adapters can execute the reviewed transition without accepting caller-made
 * success digests as a substitute for actual resources/configuration.
 */
export type ProtectedBuildInput = Readonly<{
    identity: ProtectedIdentity;
    sourceSha: string;
    sourceContext: string;
    buildArguments: Readonly<Record<string, string>>;
}>;

export type ProtectedRuntimeInput = Readonly<{
    role: Role;
    service: string;
    project: string;
    location: string;
    identity: ProtectedIdentity;
    sourceSha: string;
    environment: Readonly<Record<string, string>>;
    secretReferences: Readonly<Record<string, string>>;
    settings: Readonly<{
        cpu: string;
        memory: string;
        concurrency: number;
        timeoutSeconds: number;
        maxInstances: number;
    }>;
    target: Readonly<{ url: string; audience: string }>;
    noTraffic: boolean;
    providerAdmissionEnabled: boolean;
}>;

export type ProtectedQueueInput = Readonly<{
    resource: string;
    project: string;
    location: string;
    target: Readonly<{ url: string; audience: string; callerIdentity: ProtectedIdentity }>;
    configuration: Readonly<Record<string, unknown>>;
}>;

export type ProtectedSchedulerInput = Readonly<{
    resource: string;
    project: string;
    location: string;
    target: Readonly<{ uri: string; audience: string; identity: ProtectedIdentity }>;
    configuration: Readonly<Record<string, unknown>>;
    state: 'PAUSED' | 'ENABLED';
    pauseEpochMs: number;
    lastAttemptMs: number | null;
}>;

export type ProtectedIamInput = Readonly<{
    resource: string;
    project: string;
    etag: string;
    bindings: readonly Readonly<{
        role: string;
        member: string;
        condition: string | null;
    }>[];
}>;

export type ProtectedRetentionInput = Readonly<{
    resource: string;
    project: string;
    location: string;
    enabled: boolean;
    configuration: Readonly<Record<string, unknown>>;
}>;

export type ProtectedPlatformInputs = Readonly<{
    build: ProtectedBuildInput;
    runtime: Readonly<Record<Role, ProtectedRuntimeInput>>;
    queues: Readonly<Record<Role, ProtectedQueueInput>>;
    schedulers: Readonly<Record<Role, ProtectedSchedulerInput>>;
    iam: Readonly<Record<Role, ProtectedIamInput>>;
    retention: ProtectedRetentionInput;
}>;

/**
 * Old-state observations are required before preparation.  They are the
 * only live success facts in a prepared packet; desired revisions and
 * verification windows do not exist yet and are therefore never represented
 * as caller-supplied observations.
 */
export type ProtectedOldObservations = Readonly<{
    source: Readonly<Record<Role, Readonly<{
        sourceSha: string;
        revision: string;
        metadataDigest: string;
    }>>>;
    runtime: Readonly<Record<Role, Readonly<{
        sourceSha: string;
        service: string;
        project: string;
        location: string;
        revision: string;
        generation: string;
        resourceVersion: string;
        identity: ProtectedIdentity;
        providerAdmissionEnabled: boolean;
        noTraffic: boolean;
        runtimeDigest: string;
        buildDigest: string;
    }>>>;
    queues: Readonly<Record<Role, Readonly<{
        resource: string;
        project: string;
        location: string;
        state: 'PAUSED' | 'RUNNING';
        configuration: Readonly<Record<string, unknown>>;
        tasks: readonly Readonly<{
            name: string;
            payloadDigest: string;
            createTime: string;
        }>[];
        complete: boolean;
    }>>>;
    schedulers: Readonly<Record<Role, Readonly<{
        resource: string;
        project: string;
        location: string;
        state: 'PAUSED' | 'ENABLED';
        pauseEpochMs: number;
        lastAttemptMs: number | null;
        configuration: Readonly<Record<string, unknown>>;
    }>>>;
    iam: Readonly<Record<Role, ProtectedIamInput>>;
    retention: ProtectedRetentionInput;
    readiness: Readonly<ReadinessContract & { ready: boolean }>;
}>;

/**
 * Desired observation targets are executable expectations/configuration. They
 * intentionally have no desired revision ID, generation, task listing, or
 * zero-work success bit; those facts are fetched afresh by each state adapter.
 */
export type ProtectedObservationTargets = Readonly<{
    source: Readonly<Record<Role, Readonly<{
        sourceSha: string;
        revisionPlan: Readonly<{ prefix: string; suffix: string }>;
        desiredBuildDigest: string;
        desiredRuntimeDigest: string;
    }>>>;
    runtime: Readonly<Record<Role, ProtectedRuntimeInput>>;
    queues: Readonly<Record<Role, ProtectedQueueInput>>;
    schedulers: Readonly<Record<Role, ProtectedSchedulerInput>>;
    iam: Readonly<Record<Role, ProtectedIamInput>>;
    retention: ProtectedRetentionInput;
    readiness: ReadinessContract;
    zeroWorkSources: Readonly<Record<'providerLedger' | 'billingLedger' | 'taskAudit' | 'receiverLog', Readonly<{
        source: string;
        lookbackMs: number;
    }>>>;
}>;

export type CapacityManifest = Readonly<{
    roleSlots: Readonly<Record<Slot, ProtectedIdentity>>;
    build: ProtectedIdentity;
    source: Readonly<Record<Role, RevisionContract>>;
    producer: Readonly<Record<Role, ProducerContract>>;
    queues: Readonly<Record<Role, QueueContract>>;
    recoverySchedulers: Readonly<Record<Role, SchedulerContract>>;
    retention: RetentionContract;
    iam: Readonly<Record<Role, IamContract>>;
    readiness: ReadinessContract;
}>;

export type ActivationContract = Readonly<{
    analysisV2AdmissionEnabled: boolean;
    earlybirdWebhookAutoAdmissionEnabled: boolean;
}>;

export type CapacityEpochPacket = {
    epochId: string;
    lockNamespace: string;
    roleSet: readonly Role[];
    oldManifest: CapacityManifest;
    desiredManifest: CapacityManifest;
    protectedInputs: Readonly<{
        old: ProtectedPlatformInputs;
        desired: ProtectedPlatformInputs;
    }>;
    oldManifestDigest: string;
    desiredManifestDigest: string;
    capabilityDigest: string;
    roleSetDigest: string;
    sourcePlanDigest: string;
    activation: ActivationContract;
    quiescence: Readonly<{ timeoutMs: number; graceMs: number }>;
    observationInputs: Readonly<Record<'sourceDigest' | 'iamDigest' | 'queueDigest' | 'schedulerDigest' | 'retentionDigest' | 'readinessDigest' | 'zeroWorkDigest', string>>;
    protectedObservations: Readonly<{
        old: ProtectedOldObservations;
        desired: ProtectedObservationTargets;
    }>;
    probe: Readonly<{
        bodyDigest: string;
        expectedStatuses: Readonly<Record<Role, 400>>;
        expectedCodes: Readonly<Record<Role, 'INVALID_REQUEST'>>;
    }>;
};

export type EpochHeader = Readonly<{
    epochIdDigest: string;
    capabilityDigest: string;
    oldManifestDigest: string;
    desiredManifestDigest: string;
    roleSetDigest: string;
    sourcePlanDigest: string;
    createdAt: string;
}>;

export type EpochLock = Readonly<{
    epochHeaderDigest: string;
    ownerDigest: string;
    lockFence: string;
    lockExpiresAt: string;
}>;

export type EpochTransition = Readonly<{
    sequence: number;
    epochIdDigest: string;
    fromState: State | null;
    toState: State;
    stateVersion: number;
    lockFence: string;
    preconditionDigest: string;
    mutationDigest: string;
    postconditionDigest: string;
    proofDigest: string;
    nativeConcurrencyTokenDigest: string;
    resourceObservationDigest: string;
    resultCode: 'OK' | 'RECONCILED' | 'ABORTED';
    recordedAt: string;
}>;

export const MANIFEST_KEYS = [
    'roleSlots', 'build', 'source', 'producer', 'queues', 'recoverySchedulers',
    'retention', 'iam', 'readiness',
] as const;

export function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function hasExactKeys(value: object, expected: readonly string[]): boolean {
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function hasExactOrderedKeys(value: object, expected: readonly string[]): boolean {
    const actual = Object.keys(value);
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalize(value: unknown, seen = new Set<object>()): string {
    if (value === null) return 'null';
    if (typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) epochFail('INVALID_SCHEMA');
        return JSON.stringify(value);
    }
    if (typeof value !== 'object') epochFail('INVALID_SCHEMA');
    if (seen.has(value)) epochFail('INVALID_SCHEMA');
    seen.add(value);
    let result: string;
    if (Array.isArray(value)) {
        result = `[${value.map(item => canonicalize(item, seen)).join(',')}]`;
    } else {
        result = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key], seen)}`).join(',')}}`;
    }
    seen.delete(value);
    return result;
}

export function canonicalJson(value: unknown): string {
    return canonicalize(value);
}

export function canonicalDigest(value: unknown): string {
    return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function isDigest(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function isSha(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export function isState(value: unknown): value is State {
    return typeof value === 'string' && (STATES as readonly string[]).includes(value);
}

export function isRole(value: unknown): value is Role {
    return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

export function isSlot(value: unknown): value is Slot {
    return typeof value === 'string' && (SLOTS as readonly string[]).includes(value);
}
