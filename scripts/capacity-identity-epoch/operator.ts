import {
    canonicalDigest,
    epochFail,
    isDigest,
    isObject,
    type CapacityEpochPacket,
    type EpochErrorCode,
    type Role,
    type State,
} from './contracts';
import { validateEpochPacket } from './packet';
import {
    validateIamObservation,
    validateQueueObservation,
    validateReadinessObservation,
    validateRetentionObservation,
    validateRuntimeObservation,
    validateSchedulerObservation,
    validateSourceObservation,
    validateZeroWorkObservation,
} from './observations';

const ROLES = ['preflight', 'paid'] as const;
const IAM_KINDS = ['run', 'queue', 'taskCaller', 'maintenance'] as const;
const SAFE_REVISION = /^[a-z][a-z0-9-]{0,62}$/;

/**
 * The operator's live graph is deliberately structural here.  The concrete
 * production implementation is LiveBootstrap, while tests may provide only
 * the authenticated read-only admission seam.  No fixture flag or caller
 * supplied success bit is accepted by this boundary.
 */
export type ProductionOperatorLive = Readonly<{
    missingEvidence: readonly string[];
    coordinator: Readonly<{
        packet: CapacityEpochPacket;
        runThroughVerified: () => Promise<Readonly<{ state: 'VERIFIED'; lease: unknown; proofDigest: string }>>;
    }>;
    controlPlane: Readonly<{
        admit?: (input: Readonly<{ packet: CapacityEpochPacket }>) => Promise<void>;
    }>;
}>;

export type PreparedProductionEpoch = Readonly<{
    /** The exact frozen in-memory packet used for both admission and apply. */
    packet: CapacityEpochPacket;
    packetDigest: string;
    sourcePlanDigest: string;
    deterministicDigest: string;
    revisionNames: Readonly<Record<Role, string>>;
}>;

function desiredRevisionName(packet: CapacityEpochPacket, role: Role): string {
    const plan = packet.desiredManifest.source[role].revisionPlan;
    const suffix = packet.desiredManifest.source[role].desiredRevisionId
        ?? `${packet.desiredManifest.source[role].desiredSha.slice(0, 12)}${plan.suffix}`;
    const result = `${plan.prefix}${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
    if (!SAFE_REVISION.test(result)) epochFail('RESOURCE_INVALID');
    return result;
}

export function deriveProductionRevisionNames(packet: CapacityEpochPacket): Readonly<Record<Role, string>> {
    validateEpochPacket(packet);
    return Object.freeze({
        preflight: desiredRevisionName(packet, 'preflight'),
        paid: desiredRevisionName(packet, 'paid'),
    });
}

/**
 * Re-observe the complete OLD graph through the concrete authenticated
 * control-plane admission hook before deriving any operator material.  The
 * hook is read-only and must fail closed on a missing source/build/pause or
 * ledger proof.  Only deterministic digests and revision names leave this
 * preparation boundary.
 */
export async function prepareProductionEpoch(input: Readonly<{
    packet: CapacityEpochPacket;
    live: ProductionOperatorLive;
}>): Promise<PreparedProductionEpoch> {
    validateEpochPacket(input.packet);
    if (!Array.isArray(input.live.missingEvidence) || input.live.missingEvidence.length > 0) epochFail('EVIDENCE_UNAVAILABLE');
    if (typeof input.live.controlPlane.admit !== 'function') epochFail('EVIDENCE_UNAVAILABLE');
    if (input.live.coordinator.packet !== input.packet) epochFail('CAPABILITY_BINDING_MISMATCH');
    const packetDigest = canonicalDigest(input.packet);
    await input.live.controlPlane.admit({ packet: input.packet });
    const revisionNames = deriveProductionRevisionNames(input.packet);
    const deterministicDigest = canonicalDigest({
        packetDigest,
        sourcePlanDigest: input.packet.sourcePlanDigest,
        roleSetDigest: input.packet.roleSetDigest,
        revisionNames,
    });
    return Object.freeze({
        packet: input.packet,
        packetDigest,
        sourcePlanDigest: input.packet.sourcePlanDigest,
        deterministicDigest,
        revisionNames,
    });
}

/**
 * Apply is intentionally only reachable with the exact PreparedProductionEpoch
 * object returned above.  This keeps check-to-apply byte binding in memory and
 * gives the coordinator no activation entry point.
 */
export async function runPreparedThroughVerified(input: Readonly<{
    prepared: PreparedProductionEpoch;
    live: ProductionOperatorLive;
}>): Promise<Readonly<{ state: 'VERIFIED'; activated: false; packetDigest: string; proofDigest: string }>> {
    if (input.live.coordinator.packet !== input.prepared.packet
        || canonicalDigest(input.prepared.packet) !== input.prepared.packetDigest) epochFail('CAPABILITY_BINDING_MISMATCH');
    const result = await input.live.coordinator.runThroughVerified();
    if (result.state !== 'VERIFIED') epochFail('NOT_VERIFIED');
    return Object.freeze({ state: 'VERIFIED', activated: false, packetDigest: input.prepared.packetDigest, proofDigest: result.proofDigest });
}

export type ProductionVerificationSnapshot = Readonly<{
    journal: Readonly<{
        state: State | null;
        transitions: readonly Readonly<{ toState: State | null; resultCode: string }>[];
        activation: boolean;
        resumed: boolean;
        gatesOpen: boolean;
        requiresReconciliation: boolean;
        lock: Readonly<{
            generation: string;
            ownerDigest: string;
            lockFence: string;
            lockExpiresAt: string;
        }>;
        sharedReservation: Readonly<{
            present: boolean;
            complete: boolean;
            memberCount: number;
        }>;
    }>;
    facts: Readonly<{
        /** Exact adapter observations are retained only in memory. */
        source?: Readonly<Record<Role, unknown>>;
        runtime?: Readonly<Record<Role, unknown>>;
        queues?: Readonly<Record<Role, unknown>>;
        schedulers?: Readonly<Record<Role, unknown>>;
        pauseProvenance?: Readonly<Record<Role, unknown>>;
        iam?: Readonly<Record<Role, Readonly<Record<typeof IAM_KINDS[number], unknown>>>>;
        retention?: unknown;
        readiness?: unknown;
        zeroWork?: unknown;
        zeroWorkNowMs?: number;
        effects?: Readonly<{ provider: number; billing: number; task: number; userWork: number }>;
    }>;
}>;

export type ProductionVerificationResult = Readonly<{
    status: 'VERIFIED';
    activated: false;
    packetDigest: string;
}>;

function requireObject(value: unknown, code: EpochErrorCode): Record<string, unknown> {
    if (!isObject(value)) epochFail(code);
    return value;
}

function expectedRevision(packet: CapacityEpochPacket, role: Role): string {
    return deriveProductionRevisionNames(packet)[role];
}

/**
 * Independent post-read gate.  A caller supplies a reader backed by the
 * concrete adapters; this function never trusts a journal state marker alone.
 * It compares every source/runtime/queue/scheduler/IAM/readiness/retention and
 * zero-work fact against packet-bound expectations and emits only fixed codes.
 */
export async function verifyProductionOutcome(input: Readonly<{
    packet: CapacityEpochPacket;
    read: () => Promise<ProductionVerificationSnapshot>;
}>): Promise<ProductionVerificationResult> {
    validateEpochPacket(input.packet);
    let snapshot: ProductionVerificationSnapshot;
    try {
        snapshot = await input.read();
    } catch (error) {
        if (error instanceof Error && error.message === 'NOT_VERIFIED') epochFail('NOT_VERIFIED');
        epochFail('EVIDENCE_UNAVAILABLE');
    }
    const journal = requireObject(snapshot.journal, 'EVIDENCE_UNAVAILABLE');
    if (journal.state !== 'VERIFIED' || journal.activation !== false || journal.resumed !== false || journal.gatesOpen !== false
        || journal.requiresReconciliation === true
        || !Array.isArray(journal.transitions)
        || journal.transitions.some(transition => !isObject(transition) || transition.toState === 'ACTIVATED' || transition.resultCode === 'ACTIVATED')) epochFail('NOT_VERIFIED');
    const lock = requireObject(journal.lock, 'LOCK_LOST');
    if (typeof lock.generation !== 'string' || typeof lock.ownerDigest !== 'string' || !isDigest(lock.ownerDigest)
        || typeof lock.lockFence !== 'string' || !/^\d+$/.test(lock.lockFence)
        || typeof lock.lockExpiresAt !== 'string' || !Number.isFinite(Date.parse(lock.lockExpiresAt))) epochFail('LOCK_LOST');
    const sharedReservation = requireObject(journal.sharedReservation, 'LOCK_LOST');
    if (sharedReservation.present !== false || sharedReservation.complete !== true || sharedReservation.memberCount !== 0) epochFail('LOCK_LOST');
    const facts = requireObject(snapshot.facts, 'EVIDENCE_UNAVAILABLE');
    const source = requireObject(facts.source, 'SOURCE_INVALID') as unknown as Record<Role, unknown>;
    for (const role of ROLES) {
        const expected = input.packet.desiredManifest.source[role];
        validateSourceObservation(source[role], {
            role,
            oldSha: expected.desiredSha,
            oldRevision: expectedRevision(input.packet, role),
            desiredSha: expected.desiredSha,
            desiredRevisionId: expectedRevision(input.packet, role),
        }, 'desired');
    }
    const runtime = requireObject(facts.runtime, 'RUNTIME_MISMATCH') as unknown as Record<Role, unknown>;
    const queues = requireObject(facts.queues, 'OBSERVATION_INVALID') as unknown as Record<Role, unknown>;
    const schedulers = requireObject(facts.schedulers, 'SCHEDULER_NOT_QUIESCENT') as unknown as Record<Role, unknown>;
    const pauseProvenance = requireObject(facts.pauseProvenance, 'SCHEDULER_NOT_QUIESCENT') as unknown as Record<Role, unknown>;
    const iam = requireObject(facts.iam, 'IAM_ETAG_REQUIRED') as unknown as Record<Role, Record<typeof IAM_KINDS[number], unknown>>;
    const retention = facts.retention;
    const readiness = facts.readiness;
    const zeroWork = facts.zeroWork;
    for (const role of ROLES) {
        validateRuntimeObservation(runtime[role], input.packet.protectedInputs.desired.runtime[role], {
            mode: 'PROMOTED', revision: expectedRevision(input.packet, role),
            runtimeDigest: input.packet.desiredManifest.source[role].desiredRuntimeDigest,
            buildDigest: input.packet.desiredManifest.source[role].desiredBuildDigest,
        });
        const queueInput = input.packet.protectedInputs.desired.queues[role];
        validateQueueObservation({ role, ...(queues[role] as Record<string, unknown>) }, queueInput, input.packet.desiredManifest.queues[role].configDigest, role);
        const schedulerFact = requireObject(schedulers[role], 'SCHEDULER_NOT_QUIESCENT');
        const schedulerInput = input.packet.protectedInputs.desired.schedulers[role];
        const schedulerNowMs = schedulerFact.nowMs;
        if (typeof schedulerNowMs !== 'number' || !Number.isSafeInteger(schedulerNowMs)) epochFail('SCHEDULER_NOT_QUIESCENT');
        validateSchedulerObservation(schedulerFact, schedulerInput, schedulerNowMs, input.packet.quiescence.timeoutMs, input.packet.quiescence.graceMs, role);
        const provenance = requireObject(pauseProvenance[role], 'SCHEDULER_NOT_QUIESCENT');
        if (provenance.resource !== schedulerInput.resource || !isObject(provenance.evidence) || provenance.evidence.operation !== 'PAUSE'
            || provenance.pauseEpochMs !== schedulerFact.pauseEpochMs || provenance.complete !== true
            || typeof provenance.observedAtMs !== 'number' || provenance.observedAtMs < schedulerFact.pauseEpochMs || !isDigest(provenance.evidenceDigest)) epochFail('SCHEDULER_NOT_QUIESCENT');
        const roleIam = requireObject(iam[role], 'IAM_ETAG_REQUIRED') as unknown as Record<typeof IAM_KINDS[number], unknown>;
        for (const kind of IAM_KINDS) {
            const iamFact = requireObject(roleIam[kind], 'IAM_ETAG_REQUIRED');
            if (iamFact.resource !== input.packet.protectedInputs.desired.iam[role][kind].resource
                || iamFact.project !== input.packet.protectedInputs.desired.iam[role][kind].project
                || !Array.isArray(iamFact.bindings)) epochFail('OBSERVATION_INVALID');
            if (typeof iamFact.etag !== 'string') epochFail('IAM_ETAG_REQUIRED');
            validateIamObservation({ role, ...iamFact }, {
                role,
                resource: input.packet.protectedInputs.desired.iam[role][kind].resource,
                project: input.packet.protectedInputs.desired.iam[role][kind].project,
                etag: iamFact.etag,
                bindings: input.packet.protectedInputs.desired.iam[role][kind].bindings.filter(binding =>
                    !input.packet.desiredManifest.iam[role].retiredBindings.includes(canonicalDigest(binding))),
            });
        }
    }
    validateRetentionObservation(retention, input.packet.protectedInputs.desired.retention);
    validateReadinessObservation(readiness, input.packet.desiredManifest.readiness);
    if (typeof facts.zeroWorkNowMs !== 'number' || !Number.isSafeInteger(facts.zeroWorkNowMs)) epochFail('ZERO_WORK_INCOMPLETE');
    if (Date.parse(lock.lockExpiresAt) <= facts.zeroWorkNowMs) epochFail('LOCK_LOST');
    const zeroWorkValue = requireObject(zeroWork, 'ZERO_WORK_INCOMPLETE');
    const provenance = {
        providerLedger: input.packet.protectedObservations.desired.zeroWorkSources.providerLedger.source,
        billingLedger: input.packet.protectedObservations.desired.zeroWorkSources.billingLedger.source,
        taskAudit: input.packet.protectedObservations.desired.zeroWorkSources.taskAudit.source,
        receiverLog: input.packet.protectedObservations.desired.zeroWorkSources.receiverLog.source,
    };
    if (typeof zeroWorkValue.windowStartMs !== 'number' || typeof zeroWorkValue.windowEndMs !== 'number') epochFail('ZERO_WORK_INCOMPLETE');
    validateZeroWorkObservation(zeroWorkValue, facts.zeroWorkNowMs, {
        windowStartMs: zeroWorkValue.windowStartMs,
        windowEndMs: zeroWorkValue.windowEndMs,
        provenance,
    });
    for (const name of ['providerLedger', 'billingLedger', 'taskAudit', 'receiverLog'] as const) {
        const evidence = requireObject(zeroWorkValue[name], 'ZERO_WORK_INCOMPLETE');
        if (evidence.complete !== true || evidence.eventCount !== 0) epochFail('ZERO_WORK_INCOMPLETE');
    }
    if (facts.effects !== undefined) {
        const effects = requireObject(facts.effects, 'ZERO_WORK_INCOMPLETE');
        if (effects.provider !== 0 || effects.billing !== 0 || effects.task !== 0 || effects.userWork !== 0) epochFail('ZERO_WORK_INCOMPLETE');
    }
    return Object.freeze({ status: 'VERIFIED', activated: false, packetDigest: canonicalDigest(input.packet) });
}
