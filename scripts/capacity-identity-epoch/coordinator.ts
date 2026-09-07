import {
    STATES,
    EpochError,
    canonicalDigest,
    epochFail,
    isObject,
    type CapacityEpochPacket,
    type EpochErrorCode,
    type EpochTransition,
    type Role,
    type State,
} from './contracts';
import {
    assertCoordinatorCapability,
    issueCoordinatorCapability,
    validateEpochPacket,
    type CoordinatorCapability,
} from './packet';
import { EpochJournal, type JournalLease } from './journal';
import { CloudRunAdapter } from './cloud-run';
import { IamAdapter } from './iam';
import { WorkPlaneClient } from './work-planes';
import { VercelAdapter } from './vercel';
import {
    validateSourceObservation,
    validateRuntimeObservation,
    validateQueueObservation,
    validateSchedulerObservation,
    validateRetentionObservation,
    validateReadinessObservation,
    validateIamObservation,
    validateZeroWorkObservation,
    type RuntimeObservationExpectation,
    type SourceObservation,
    type ZeroWorkObservation,
} from './observations';
import type { ProtectedRuntimeInput, ProtectedQueueInput, ProtectedSchedulerInput, ProtectedIamInput, ProtectedIamBinding } from './contracts';
import { PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION, PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION } from '../../lib/services/analysis/legacy-analysis-public-readiness';

type EvidenceValue = unknown;

/**
 * Control-plane operations return observed values, never caller-supplied
 * success booleans or precomputed transition digests. The coordinator hashes
 * the returned evidence only after the concrete operation has completed.
 */
export type OperationEvidence = Readonly<{
    precondition: EvidenceValue;
    mutation: EvidenceValue;
    postcondition: EvidenceValue;
    proof: EvidenceValue;
    nativeConcurrencyToken: EvidenceValue;
    resourceObservation: EvidenceValue;
}>;

export interface EpochControlPlane {
    prepare(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
    stage(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
    closeAndAlignProducers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
    alignQueues(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
    rotateInvokers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
    promote(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
    verify(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
    reconcile(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease; state: State }>): Promise<OperationEvidence>;
    compensateActivation(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
    activate?(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence>;
}

type StateOperation = Exclude<State, 'ACTIVATED'>;
const STATE_OPERATIONS: readonly StateOperation[] = [
    'PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED',
    'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED',
];

function fail(code: EpochErrorCode): never {
    epochFail(code);
}

function evidenceDigest(value: unknown): string {
    // Canonicalization rejects cycles/non-finite values and therefore keeps
    // transition records bounded to deterministic, non-secret digests.
    return canonicalDigest(value);
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
    if (typeof value !== 'object' || value === null || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
    Object.freeze(value);
    return value;
}

function validateEvidence(value: unknown): asserts value is OperationEvidence {
    if (!isObject(value) || Object.keys(value).sort().join(',') !== 'mutation,nativeConcurrencyToken,postcondition,precondition,proof,resourceObservation') {
        fail('PROBE_FAILED');
    }
    // Hash every field before accepting it. This rejects cyclic or non-finite
    // fake evidence without ever emitting its contents.
    for (const key of ['precondition', 'mutation', 'postcondition', 'proof', 'nativeConcurrencyToken', 'resourceObservation']) {
        evidenceDigest(value[key]);
    }
}

function transitionForEvidence(sequence: number, epochIdDigest: string, fromState: State | null, toState: State, fence: string, evidence: OperationEvidence, nowMs: number, resultCode: 'OK' | 'RECONCILED' = 'OK'): EpochTransition {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail('JOURNAL_INVALID');
    validateEvidence(evidence);
    return {
        sequence,
        epochIdDigest,
        fromState,
        toState,
        stateVersion: sequence,
        lockFence: fence,
        preconditionDigest: evidenceDigest(evidence.precondition),
        mutationDigest: evidenceDigest(evidence.mutation),
        postconditionDigest: evidenceDigest(evidence.postcondition),
        proofDigest: evidenceDigest(evidence.proof),
        nativeConcurrencyTokenDigest: evidenceDigest(evidence.nativeConcurrencyToken),
        resourceObservationDigest: evidenceDigest(evidence.resourceObservation),
        resultCode,
        recordedAt: new Date(nowMs).toISOString(),
    };
}

const activationRegistry = new WeakMap<object, Readonly<{
    packetDigest: string;
    verifiedProofDigest: string;
    ownerDigest: string;
    lockFence: string;
    expiresAtMs: number;
    gates: Readonly<{ analysisV2AdmissionEnabled: boolean; earlybirdWebhookAutoAdmissionEnabled: boolean }>;
}>>();

export type ActivationAuthorization = object;

export type EpochCoordinatorOptions = Readonly<{
    packet: CapacityEpochPacket;
    journal: EpochJournal;
    controlPlane: EpochControlPlane;
    ownerDigest: string;
    capability?: CoordinatorCapability;
    now?: () => number;
}>;

export class EpochCoordinator {
    readonly packet: CapacityEpochPacket;
    readonly journal: EpochJournal;
    private readonly controlPlane: EpochControlPlane;
    private readonly ownerDigest: string;
    private readonly capability: CoordinatorCapability;
    private readonly now: () => number;
    private lease: JournalLease | undefined;
    private verifiedProofDigest: string | undefined;

    constructor(options: EpochCoordinatorOptions) {
        validateEpochPacket(options.packet);
        this.packet = freezeDeep(options.packet);
        this.journal = options.journal;
        this.controlPlane = options.controlPlane;
        this.ownerDigest = options.ownerDigest;
        this.capability = options.capability ?? issueCoordinatorCapability(this.packet, options.ownerDigest);
        assertCoordinatorCapability(this.packet, this.capability, options.ownerDigest);
        this.now = options.now ?? (() => Date.now());
    }

    /** Runs the closed rollout through VERIFIED. It never invokes activation. */
    async runThroughVerified(): Promise<Readonly<{ state: 'VERIFIED'; lease: JournalLease; proofDigest: string }>> {
        this.assertCapabilityBinding();
        await this.journal.ensureHeader();
        this.lease = await this.journal.acquire(this.ownerDigest);
        let state = await this.journal.readValidatedState(this.lease);
        if (state.aborted) fail('ABORTED_EPOCH');
        state = await this.reconcileUntilStable(state);

        const verifiedIndex = STATES.indexOf('VERIFIED');
        let nextIndex = state.state === null ? 0 : STATES.indexOf(state.state) + 1;
        if (nextIndex > verifiedIndex) {
            if (state.state !== 'VERIFIED') fail('JOURNAL_INVALID');
            // A VERIFIED journal transition is not a cached authorization. A
            // fresh resume must repeat the read-only proof under the live
            // fence before returning a proof to the caller.
            this.assertCapabilityBinding();
            await this.journal.assertLive(this.lease);
            const before = await this.journal.readValidatedState(this.lease);
            const evidence = await this.controlPlane.verify({ packet: this.packet, lease: this.lease });
            validateEvidence(evidence);
            const after = await this.journal.readValidatedState(this.lease);
            if (after.state !== 'VERIFIED' || after.activeFence !== before.activeFence || after.transitions.length !== before.transitions.length) fail('OBSERVATION_RACE');
            this.verifiedProofDigest = evidenceDigest(evidence.proof);
            return { state: 'VERIFIED', lease: this.lease, proofDigest: this.verifiedProofDigest };
        }

        while (nextIndex <= verifiedIndex) {
            this.assertCapabilityBinding();
            await this.journal.assertLive(this.lease);
            state = await this.reconcileUntilStable(await this.journal.readValidatedState(this.lease));
            if (state.aborted) fail('ABORTED_EPOCH');
            nextIndex = state.state === null ? 0 : STATES.indexOf(state.state) + 1;
            if (nextIndex > verifiedIndex) break;
            const target = STATE_OPERATIONS[nextIndex];
            if (!target) fail('JOURNAL_INVALID');
            const evidence = await this.runOperation(target, this.lease);
            const current = await this.journal.readValidatedState(this.lease);
            if (current.aborted) fail('ABORTED_EPOCH');
            if (current.state !== (nextIndex === 0 ? null : STATES[nextIndex - 1])) {
                // A late append can arrive after the operation's observation
                // but before our journal read. Reconcile that exact new phase
                // before considering another mutation.
                state = await this.reconcileUntilStable(current);
                continue;
            }
            const transition = transitionForEvidence(
                current.transitions.length + 1,
                this.journal.epochIdDigest,
                current.state,
                target,
                this.lease.lock.lockFence,
                evidence,
                this.now(),
            );
            await this.journal.append(this.lease, transition);
            state = await this.journal.readValidatedState(this.lease);
            state = await this.reconcileUntilStable(state);
            nextIndex = state.state === null ? 0 : STATES.indexOf(state.state) + 1;
        }
        const final = await this.journal.readValidatedState(this.lease);
        if (final.state !== 'VERIFIED' || final.aborted) fail('NOT_VERIFIED');
        this.verifiedProofDigest = final.transitions[final.transitions.length - 1]?.proofDigest;
        if (!this.verifiedProofDigest) fail('NOT_VERIFIED');
        return { state: 'VERIFIED', lease: this.lease, proofDigest: this.verifiedProofDigest };
    }

    issueActivationAuthorization(): ActivationAuthorization {
        if (!this.lease || !this.verifiedProofDigest) fail('NOT_VERIFIED');
        const token = Object.freeze(Object.create(null)) as ActivationAuthorization;
        activationRegistry.set(token, {
            packetDigest: canonicalDigest(this.packet),
            verifiedProofDigest: this.verifiedProofDigest,
            ownerDigest: this.ownerDigest,
            lockFence: this.lease.lock.lockFence,
            expiresAtMs: this.now() + 5 * 60_000,
            gates: this.packet.activation,
        });
        return token;
    }

    /** Separate, proof-bound activation. The normal CLI does not call this. */
    async activate(authorization: ActivationAuthorization): Promise<Readonly<{ state: 'ACTIVATED'; lease: JournalLease }>> {
        if (!isObject(authorization)) fail('ACTIVATION_AUTH_REQUIRED');
        const binding = activationRegistry.get(authorization);
        if (!binding || binding.packetDigest !== canonicalDigest(this.packet)
            || binding.verifiedProofDigest !== this.verifiedProofDigest
            || binding.ownerDigest !== this.ownerDigest || binding.expiresAtMs < this.now()
            || binding.gates.analysisV2AdmissionEnabled !== this.packet.activation.analysisV2AdmissionEnabled
            || binding.gates.earlybirdWebhookAutoAdmissionEnabled !== this.packet.activation.earlybirdWebhookAutoAdmissionEnabled) fail('ACTIVATION_AUTH_REQUIRED');
        if (!this.lease) fail('ACTIVATION_AUTH_REQUIRED');
        const state = await this.journal.readValidatedState(this.lease);
        if (state.state !== 'VERIFIED' || state.aborted || state.transitions[state.transitions.length - 1]?.proofDigest !== binding.verifiedProofDigest) fail('NOT_VERIFIED');
        await this.journal.assertLive(this.lease);
        if (!this.controlPlane.activate) fail('ACTIVATION_AUTH_REQUIRED');
        try {
            const evidence = await this.controlPlane.activate({ packet: this.packet, lease: this.lease });
            const current = await this.journal.readValidatedState(this.lease);
            const transition = transitionForEvidence(current.transitions.length + 1, this.journal.epochIdDigest, 'VERIFIED', 'ACTIVATED', this.lease.lock.lockFence, evidence, this.now());
            await this.journal.append(this.lease, transition);
            return { state: 'ACTIVATED', lease: this.lease };
        } catch (error) {
            try { await this.controlPlane.compensateActivation({ packet: this.packet, lease: this.lease }); } catch { /* closure remains unknown and is never claimed successful */ }
            throw error instanceof EpochError ? error : new EpochError('PROBE_FAILED');
        }
    }

    async abort(reasonCode: 'OPERATOR_ABORT' | 'CONTROL_PLANE_FAILURE'): Promise<Readonly<{ state: State | null; aborted: true }>> {
        this.assertCapabilityBinding();
        if (!this.lease) {
            await this.journal.ensureHeader();
            this.lease = await this.journal.acquire(this.ownerDigest);
        }
        const state = await this.journal.readValidatedState(this.lease);
        if (state.aborted) fail('ABORTED_EPOCH');
        const evidence: OperationEvidence = {
            precondition: { state: state.state, fence: this.lease.lock.lockFence },
            mutation: { action: 'ABORTED', reasonCode },
            // An abort marker is durable journal state only; closure of each
            // producer/work plane must be independently observed and is never
            // claimed by this marker.
            postcondition: { status: 'ABORTED_MARKER_ONLY' },
            proof: { reasonCode },
            nativeConcurrencyToken: null,
            resourceObservation: { state: state.state },
        };
        await this.journal.append(this.lease, {
            ...transitionForEvidence(state.transitions.length + 1, this.journal.epochIdDigest, state.state, state.state ?? 'PREPARED', this.lease.lock.lockFence, evidence, this.now()),
            toState: state.state,
            resultCode: 'ABORTED',
        });
        return { state: state.state, aborted: true };
    }

    private assertCapabilityBinding(): void {
        assertCoordinatorCapability(this.packet, this.capability, this.ownerDigest);
    }

    private reconciliationMarker(state: Awaited<ReturnType<EpochJournal['readValidatedState']>>): string {
        return canonicalDigest({
            sequence: state.transitions.length,
            state: state.state,
            activeFence: state.activeFence,
            tail: state.transitions[state.transitions.length - 1] ?? null,
        });
    }

    /**
     * Reconcile the exact phase observed under the active fence. A journal
     * object can arrive between reconciliation and the next state read; in
     * that case the new sequence/phase is itself reconciled before mutation.
     */
    private async reconcileUntilStable(initial: Awaited<ReturnType<EpochJournal['readValidatedState']>>): Promise<Awaited<ReturnType<EpochJournal['readValidatedState']>>> {
        let state = initial;
        let mustReconcile = state.requiresReconciliation;
        for (let attempt = 0; attempt < 4; attempt += 1) {
            this.assertCapabilityBinding();
            if (!this.lease) fail('LOCK_LOST');
            const confirmed = await this.journal.readValidatedState(this.lease);
            if (this.reconciliationMarker(confirmed) !== this.reconciliationMarker(state)) {
                state = confirmed;
                mustReconcile = true;
            } else {
                state = confirmed;
            }
            if (state.aborted) fail('ABORTED_EPOCH');
            if (!mustReconcile) return state;
            const evidence = await this.controlPlane.reconcile({ packet: this.packet, lease: this.lease, state: state.state ?? 'PREPARED' });
            validateEvidence(evidence);
            const after = await this.journal.readValidatedState(this.lease);
            if (this.reconciliationMarker(after) === this.reconciliationMarker(state)) return after;
            state = after;
            mustReconcile = true;
        }
        fail('OBSERVATION_RACE');
    }

    private async runOperation(target: StateOperation, lease: JournalLease): Promise<OperationEvidence> {
        const input = { packet: this.packet, lease };
        switch (target) {
            case 'PREPARED': return this.controlPlane.prepare(input);
            case 'STAGED': return this.controlPlane.stage(input);
            case 'PRODUCERS_CLOSED_ALIGNED': return this.controlPlane.closeAndAlignProducers(input);
            case 'QUEUES_ALIGNED': return this.controlPlane.alignQueues(input);
            case 'INVOKERS_ROTATED': return this.controlPlane.rotateInvokers(input);
            case 'SERVICES_PROMOTED': return this.controlPlane.promote(input);
            case 'VERIFIED': return this.controlPlane.verify(input);
            default: fail('JOURNAL_INVALID');
        }
    }
}

/**
 * Concrete live control-plane wiring. It intentionally requires protected
 * operator inputs that are not present in a digest-only packet (readiness URL,
 * deployment alias, and reviewed service templates); omission fails closed.
 * This class performs real adapter calls and is never used by offline fakes.
 */
export type LiveEpochControlPlaneOptions = Readonly<{
    cloudRun: CloudRunAdapter;
    iam: IamAdapter;
    workPlanes: WorkPlaneClient;
    vercel: VercelAdapter;
    publicReadinessUrl: string;
    projectId: string;
    teamId: string;
    deploymentId: string;
    expectedOldDeploymentId: string;
    producerAlias: string;
    serviceBodies: Readonly<Record<Role, Readonly<Record<string, unknown>>>>;
    /** Journal fencing is checked immediately before every provider mutation. */
    journal?: EpochJournal;
    /** Source/revision evidence is an independent Git/provider observation. */
    sourceObservation?: (input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; runtime: ProtectedRuntimeInput }>) => Promise<unknown>;
    /** Build/source provenance binds the deployed image to the reviewed build input. */
    buildObservation?: (input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; image: string }>) => Promise<unknown>;
    /** Ledger/log evidence is fetched only at VERIFIED, never supplied as a success bit. */
    zeroWorkObservation?: (input: Readonly<{ windowStartMs: number; windowEndMs: number; nowMs: number; baselineDigest?: string }>) => Promise<unknown>;
    /** Captured before the first authorized mutation; only its digest survives. */
    zeroWorkBaseline?: (input: Readonly<{ nowMs: number }>) => Promise<unknown>;
    /** Provider-free probes are executed by the reviewed probe harness. */
    probe?: (input: Readonly<{ role: Role; runtime: ProtectedRuntimeInput; revision: string }>) => Promise<unknown>;
    /** Activation compensation closes both producer gates before pausing resources. */
    closeAdmissionGates?: (input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>) => Promise<unknown>;
    now?: () => number;
}>;

export class LiveEpochControlPlane implements EpochControlPlane {
    private readonly options: LiveEpochControlPlaneOptions;
    private readonly capturedRevisions = new Map<Role, string>();
    private readonly now: () => number;
    private zeroWorkBaseline: Readonly<{ capturedAtMs: number; digest: string }> | undefined;

    constructor(options: LiveEpochControlPlaneOptions) {
        this.options = options;
        this.now = options.now ?? (() => Date.now());
    }

    async prepare(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const packet = input.packet;
        await this.captureZeroWorkBaseline();
        const readiness = await this.readReadiness(packet, 'old');
        const services: unknown[] = [];
        const queues: unknown[] = [];
        const schedulers: unknown[] = [];
        const policies: unknown[] = [];
        const sourceFacts: unknown[] = [];
        const queueFacts: unknown[] = [];
        const schedulerFacts: unknown[] = [];
        const iamFacts: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const runtime = packet.protectedInputs.old.runtime[role];
            const source = await this.readSource({ role, phase: 'old', revision: packet.oldManifest.source[role].oldRevision, runtime });
            if (source.metadataDigest !== packet.protectedObservations.old.source[role].metadataDigest) fail('SOURCE_INVALID');
            const service = await this.options.cloudRun.getService(this.serviceResource(runtime));
            const buildDigest = await this.readBuildDigest({ role, phase: 'old', revision: packet.oldManifest.source[role].oldRevision, image: service.image });
            const mode = service.noTraffic ? 'STAGED' as const : 'PROMOTED' as const;
            const runtimeObservation = this.runtimeObservation(runtime, service, source.sourceSha, packet.oldManifest.source[role].oldRevision, mode, buildDigest);
            validateRuntimeObservation(runtimeObservation, runtime, {
                mode,
                revision: packet.oldManifest.source[role].oldRevision,
                runtimeDigest: (runtimeObservation as { runtimeDigest: string }).runtimeDigest,
                buildDigest: (runtimeObservation as { buildDigest: string }).buildDigest,
            });
            if (runtimeObservation.runtimeDigest !== packet.protectedObservations.old.runtime[role].runtimeDigest
                || runtimeObservation.buildDigest !== packet.protectedObservations.old.runtime[role].buildDigest) fail('RUNTIME_MISMATCH');
            sourceFacts.push(source);
            if (runtimeObservation.generation !== packet.protectedObservations.old.runtime[role].generation
                || runtimeObservation.resourceVersion !== packet.protectedObservations.old.runtime[role].resourceVersion) fail('OBSERVATION_RACE');
            const queue = await this.options.workPlanes.observeQueue(packet.protectedInputs.old.queues[role]);
            const queueObservation = { role, ...queue };
            validateQueueObservation(queueObservation, packet.protectedInputs.old.queues[role], packet.oldManifest.queues[role].configDigest, role);
            const expectedQueue = packet.protectedObservations.old.queues[role];
            if (queueObservation.resource !== expectedQueue.resource
                || queueObservation.project !== expectedQueue.project
                || queueObservation.location !== expectedQueue.location
                || queueObservation.state !== expectedQueue.state
                || queueObservation.complete !== expectedQueue.complete
                || canonicalDigest(queueObservation.configuration) !== canonicalDigest(expectedQueue.configuration)
                || canonicalDigest(queueObservation.tasks) !== canonicalDigest(expectedQueue.tasks)) fail('OBSERVATION_RACE');
            queueFacts.push(queueObservation);
            const scheduler = await this.options.workPlanes.observeScheduler(packet.protectedInputs.old.schedulers[role]);
            const schedulerObservation = { role, ...scheduler, nowMs: this.now() };
            validateSchedulerObservation(schedulerObservation, packet.protectedInputs.old.schedulers[role], this.now(), packet.quiescence.timeoutMs, packet.quiescence.graceMs, role);
            if (scheduler.pauseEpochMs !== packet.protectedObservations.old.schedulers[role].pauseEpochMs
                || scheduler.lastAttemptMs !== packet.protectedObservations.old.schedulers[role].lastAttemptMs) fail('OBSERVATION_RACE');
            schedulerFacts.push(schedulerObservation);
            services.push({ role, revision: source.revision, generation: service.generation, resourceVersion: service.resourceVersion, digest: service.rawDigest });
            queues.push({ role, digest: canonicalDigest(queueObservation) });
            schedulers.push({ role, digest: canonicalDigest(schedulerObservation) });
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                const policyInput = packet.protectedInputs.old.iam[role][kind];
                const observed = await this.options.iam.getPolicy(policyInput);
                const observation = { role, resource: observed.resource, project: observed.project, etag: observed.etag, bindings: observed.bindings };
                validateIamObservation(observation, { role, resource: policyInput.resource, project: policyInput.project, etag: policyInput.etag, bindings: policyInput.bindings });
                iamFacts.push({ kind, ...observation });
                policies.push({ role, kind, digest: canonicalDigest(observation) });
            }
        }
        const retention = await this.options.workPlanes.observeRetention(packet.protectedInputs.old.retention);
        validateRetentionObservation(retention, packet.protectedInputs.old.retention);
        if (canonicalDigest(readiness) !== canonicalDigest(packet.protectedObservations.old.readiness)
            || canonicalDigest(retention) !== canonicalDigest({ role: 'retention', ...packet.protectedObservations.old.retention })) fail('OBSERVATION_RACE');
        this.assertObservationDigest(packet, 'sourceDigest', sourceFacts);
        this.assertObservationDigest(packet, 'queueDigest', queueFacts);
        this.assertObservationDigest(packet, 'schedulerDigest', schedulerFacts);
        this.assertObservationDigest(packet, 'iamDigest', iamFacts);
        this.assertObservationDigest(packet, 'retentionDigest', retention);
        this.assertObservationDigest(packet, 'readinessDigest', readiness);
        return this.evidence('PREPARED', { readiness, services, queues, schedulers, policies, retention }, input.lease.lock.lockFence);
    }

    async stage(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const staged: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            await this.assertLive(input.lease);
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const serviceResource = `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
            const before = await this.options.cloudRun.getService(serviceResource);
            const revision = this.desiredRevisionCandidate(input.packet, role);
            const after = await this.options.cloudRun.stageRevision({ runtime, revision, expectedGeneration: before.generation, serviceBody: this.options.serviceBodies[role] });
            const captured = after.latestReadyRevision === revision || after.latestCreatedRevision === revision ? revision : null;
            if (!captured) fail('SOURCE_INVALID');
            this.capturedRevisions.set(role, captured);
            const source = await this.readSource({ role, phase: 'desired', revision: captured, runtime });
            const buildDigest = await this.readBuildDigest({ role, phase: 'desired', revision: captured, image: after.image });
            const runtimeObservation = this.runtimeObservation(runtime, after, source.sourceSha, captured, 'STAGED', buildDigest);
            validateRuntimeObservation(runtimeObservation, runtime, {
                mode: 'STAGED', revision: captured,
                runtimeDigest: input.packet.desiredManifest.source[role].desiredRuntimeDigest,
                buildDigest: input.packet.desiredManifest.source[role].desiredBuildDigest,
            });
            staged.push({ role, revision, generation: after.generation, digest: after.rawDigest });
        }
        return this.evidence('STAGED', staged, input.lease.lock.lockFence);
    }

    async closeAndAlignProducers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        await this.assertLive(input.lease);
        // The mutable public alias still serves OLD at this boundary. Prove
        // its closed facts first, then independently prove the immutable
        // desired deployment before any alias mutation.
        const oldReadiness = await this.readReadiness(input.packet, 'old');
        const deployment = await this.options.vercel.getDeployment({ projectId: this.options.projectId, teamId: this.options.teamId, deploymentId: this.options.deploymentId });
        if (deployment.readyState !== 'READY' || deployment.sourceSha !== input.packet.desiredManifest.readiness.sourceSha) fail('SOURCE_INVALID');
        // The mutable alias is not runtime evidence. Prove the immutable
        // desired deployment's closed-gate readiness before assigning it.
        const desired = input.packet.desiredManifest.readiness;
        const deploymentReadiness = await this.options.vercel.readDeploymentReadiness({
            deployment,
            expected: {
                sourceSha: desired.sourceSha,
                legacyTargetResource: desired.legacyTargetResource,
                preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                preflightProducerConfigFingerprint: desired.preflightFingerprint,
                paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                paidProducerConfigFingerprint: desired.paidFingerprint,
                analysisV2AdmissionEnabled: false,
                earlybirdWebhookAutoAdmissionEnabled: false,
                ready: true,
            },
        });
        await this.assertLive(input.lease);
        const aliases = await this.options.vercel.assignAlias({ projectId: this.options.projectId, teamId: this.options.teamId, deploymentId: this.options.deploymentId, expectedOldDeploymentId: this.options.expectedOldDeploymentId, expectedSourceSha: input.packet.desiredManifest.readiness.sourceSha, alias: this.options.producerAlias });
        const readiness = await this.readReadiness(input.packet, 'desired');
        return this.evidence('PRODUCERS_CLOSED_ALIGNED', { oldReadiness, aliases, deployment, deploymentReadiness: { sourceSha: deploymentReadiness.sourceSha, ready: deploymentReadiness.ready, analysisV2AdmissionEnabled: deploymentReadiness.analysisV2AdmissionEnabled, earlybirdWebhookAutoAdmissionEnabled: deploymentReadiness.earlybirdWebhookAutoAdmissionEnabled }, readiness }, input.lease.lock.lockFence);
    }

    async alignQueues(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const queues: unknown[] = [];
        const schedulers: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            await this.assertLive(input.lease);
            const schedulerInput = input.packet.protectedInputs.desired.schedulers[role];
            const queueInput = input.packet.protectedInputs.desired.queues[role];
            const oldSchedulerInput = input.packet.protectedInputs.old.schedulers[role];
            const oldQueueInput = input.packet.protectedInputs.old.queues[role];
            let scheduler = await this.options.workPlanes.observeScheduler(schedulerInput);
            let queue = await this.options.workPlanes.observeQueue(queueInput);
            if (scheduler.state !== 'PAUSED') {
                await this.assertLive(input.lease);
                scheduler = await this.options.workPlanes.pauseScheduler(schedulerInput);
            }
            if (queue.state !== 'PAUSED') {
                await this.assertLive(input.lease);
                queue = await this.options.workPlanes.pauseQueue(queueInput);
            }
            if (canonicalDigest(scheduler.target) === canonicalDigest(oldSchedulerInput.target)) {
                await this.assertLive(input.lease);
                scheduler = await this.options.workPlanes.updateSchedulerTarget({ input: schedulerInput, expectedOldTarget: oldSchedulerInput.target, desiredTarget: schedulerInput.target });
            } else if (canonicalDigest(scheduler.target) !== canonicalDigest(schedulerInput.target)) fail('OBSERVATION_RACE');
            if (queueTargetMatches(queue.target, oldQueueInput.target)) {
                await this.assertLive(input.lease);
                queue = await this.options.workPlanes.updateQueueTarget({ input: queueInput, expectedOldTarget: oldQueueInput.target, desiredTarget: queueInput.target });
            } else if (queue.target !== null && !queueTargetMatches(queue.target, queueInput.target)) fail('OBSERVATION_RACE');
            if (queue.tasks.length !== 0) fail('QUEUE_NOT_EMPTY');
            validateQueueObservation({ role, ...queue }, queueInput, input.packet.desiredManifest.queues[role].configDigest, role);
            validateSchedulerObservation({ role, ...scheduler, nowMs: this.now() }, schedulerInput, this.now(), input.packet.quiescence.timeoutMs, input.packet.quiescence.graceMs, role);
            schedulers.push({ role, digest: canonicalDigest(scheduler) });
            queues.push({ role, digest: canonicalDigest(queue) });
        }
        return this.evidence('QUEUES_ALIGNED', { queues, schedulers }, input.lease.lock.lockFence);
    }

    async rotateInvokers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const policies: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const iam = input.packet.protectedInputs.desired.iam[role];
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                await this.assertLive(input.lease);
                const target = iam[kind];
                const observed = await this.ensureIamBindings(target, role, target.bindings, input.lease);
                policies.push({ role, kind, digest: canonicalDigest(observed) });
            }
        }
        return this.evidence('INVOKERS_ROTATED', policies, input.lease.lock.lockFence);
    }

    async promote(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const promoted: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            await this.assertLive(input.lease);
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const resource = this.serviceResource(runtime);
            const before = await this.options.cloudRun.getService(resource);
            const revision = this.desiredRevisionCandidate(input.packet, role);
            const after = await this.options.cloudRun.setTraffic({ resource, expectedGeneration: before.generation, expectedRevision: revision, expectedPercent: 100, traffic: [{ revisionName: revision, percent: 100 }] });
            this.capturedRevisions.set(role, revision);
            const source = await this.readSource({ role, phase: 'desired', revision, runtime });
            const buildDigest = await this.readBuildDigest({ role, phase: 'desired', revision, image: after.image });
            const observation = this.runtimeObservation(runtime, after, source.sourceSha, revision, 'PROMOTED', buildDigest);
            validateRuntimeObservation(observation, runtime, {
                mode: 'PROMOTED', revision,
                runtimeDigest: input.packet.desiredManifest.source[role].desiredRuntimeDigest,
                buildDigest: input.packet.desiredManifest.source[role].desiredBuildDigest,
            });
            promoted.push({ role, digest: canonicalDigest(observation) });
        }
        // Old grants remain until both exact serving proofs above have passed.
        // Retirement is a fresh etag-CAS operation and never restores a stale policy.
        for (const role of ['preflight', 'paid'] as const) {
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                await this.assertLive(input.lease);
                const target = input.packet.protectedInputs.desired.iam[role][kind];
                const old = input.packet.protectedInputs.old.iam[role][kind];
                const resourceInput = target.resource === old.resource ? target : old;
                const observed = await this.options.iam.getPolicy(resourceInput);
                const retired = this.retiredBindings(input.packet, role, kind, observed.bindings);
                const remaining = observed.bindings.filter(binding => !retired.some(item => canonicalDigest(item) === canonicalDigest(binding)));
                if (remaining.length !== observed.bindings.length) {
                    await this.assertLive(input.lease);
                    const result = await this.options.iam.replaceBindings({ ...resourceInput, etag: observed.etag }, remaining);
                    promoted.push({ role, kind, retired: retired.length, digest: canonicalDigest(result) });
                }
            }
        }
        return this.evidence('SERVICES_PROMOTED', promoted, input.lease.lock.lockFence);
    }

    async verify(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const packet = input.packet;
        const readiness = await this.readReadiness(packet, 'desired');
        const runtimes: unknown[] = [];
        const queues: unknown[] = [];
        const schedulers: unknown[] = [];
        const policies: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            await this.assertLive(input.lease);
            const runtime = packet.protectedInputs.desired.runtime[role];
            const revision = this.desiredRevisionCandidate(packet, role);
            const source = await this.readSource({ role, phase: 'desired', revision, runtime });
            const service = await this.options.cloudRun.getService(this.serviceResource(runtime));
            const buildDigest = await this.readBuildDigest({ role, phase: 'desired', revision, image: service.image });
            const runtimeObservation = this.runtimeObservation(runtime, service, source.sourceSha, revision, 'PROMOTED', buildDigest);
            validateRuntimeObservation(runtimeObservation, runtime, {
                mode: 'PROMOTED', revision,
                runtimeDigest: packet.desiredManifest.source[role].desiredRuntimeDigest,
                buildDigest: packet.desiredManifest.source[role].desiredBuildDigest,
            });
            runtimes.push({ role, digest: canonicalDigest(runtimeObservation) });
            const queue = await this.options.workPlanes.observeQueue(packet.protectedInputs.desired.queues[role]);
            validateQueueObservation({ role, ...queue }, packet.protectedInputs.desired.queues[role], packet.desiredManifest.queues[role].configDigest, role);
            queues.push({ role, digest: canonicalDigest(queue) });
            const scheduler = await this.options.workPlanes.observeScheduler(packet.protectedInputs.desired.schedulers[role]);
            validateSchedulerObservation({ role, ...scheduler, nowMs: this.now() }, packet.protectedInputs.desired.schedulers[role], this.now(), packet.quiescence.timeoutMs, packet.quiescence.graceMs, role);
            schedulers.push({ role, digest: canonicalDigest(scheduler) });
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                const target = packet.protectedInputs.desired.iam[role][kind];
                const observed = await this.options.iam.getPolicy(target);
                const expectedBindings = this.desiredBindingsAfterRetirement(packet, role, kind, target.bindings);
                if (canonicalDigest(observed.bindings) !== canonicalDigest(expectedBindings)) fail('OBSERVATION_RACE');
                policies.push({ role, kind, digest: canonicalDigest(observed) });
            }
        }
        const retention = await this.options.workPlanes.observeRetention(packet.protectedInputs.desired.retention);
        validateRetentionObservation(retention, packet.protectedInputs.desired.retention);
        if (!this.options.zeroWorkObservation || !this.options.probe || !this.zeroWorkBaseline) fail('EVIDENCE_UNAVAILABLE');
        const probes: unknown[] = [];
        let lastProbeMs = this.now();
        for (const role of ['preflight', 'paid'] as const) {
            const runtime = packet.protectedInputs.desired.runtime[role];
            const revision = this.desiredRevisionCandidate(packet, role);
            const probe = await this.options.probe({ role, runtime, revision });
            if (!isObject(probe) || probe.status !== 400 || probe.code !== 'INVALID_REQUEST') fail('PROBE_FAILED');
            probes.push({ role, digest: canonicalDigest(probe) });
            lastProbeMs = this.now();
        }
        const nowMs = this.now();
        if (!Number.isSafeInteger(nowMs) || nowMs < lastProbeMs || nowMs < this.zeroWorkBaseline.capturedAtMs) fail('EVIDENCE_UNAVAILABLE');
        const windowStartMs = this.zeroWorkBaseline.capturedAtMs;
        const windowEndMs = nowMs;
        if (windowEndMs <= windowStartMs) fail('EVIDENCE_UNAVAILABLE');
        const zeroWork = await this.options.zeroWorkObservation({ windowStartMs, windowEndMs, nowMs, baselineDigest: this.zeroWorkBaseline.digest });
        const expectedWindow = {
            windowStartMs,
            windowEndMs,
            provenance: Object.fromEntries(Object.entries(packet.protectedObservations.desired.zeroWorkSources).map(([name, source]) => [name, source.source])),
        } as never;
        validateZeroWorkObservation(zeroWork, nowMs, expectedWindow);
        return this.evidence('VERIFIED', { readiness, runtimes, queues, schedulers, policies, retention: canonicalDigest(retention), zeroWork: { digest: canonicalDigest(zeroWork), baselineDigest: this.zeroWorkBaseline.digest, windowStartMs, windowEndMs }, probes }, input.lease.lock.lockFence);
    }

    private async reconcileStaged(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const runtimes: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            await this.assertLive(input.lease);
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const revision = this.desiredRevisionCandidate(input.packet, role);
            const service = await this.options.cloudRun.getService(this.serviceResource(runtime));
            if (!service.noTraffic || (service.latestReadyRevision !== revision && service.latestCreatedRevision !== revision)) fail('RUNTIME_MISMATCH');
            const source = await this.readSource({ role, phase: 'desired', revision, runtime });
            const buildDigest = await this.readBuildDigest({ role, phase: 'desired', revision, image: service.image });
            const observation = this.runtimeObservation(runtime, service, source.sourceSha, revision, 'STAGED', buildDigest);
            validateRuntimeObservation(observation, runtime, {
                mode: 'STAGED', revision,
                runtimeDigest: input.packet.desiredManifest.source[role].desiredRuntimeDigest,
                buildDigest: input.packet.desiredManifest.source[role].desiredBuildDigest,
            });
            runtimes.push({ role, digest: canonicalDigest(observation) });
        }
        return this.evidence('RECONCILE_STAGED', runtimes, input.lease.lock.lockFence);
    }

    private async reconcileProducers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const readiness = await this.readReadiness(input.packet, 'desired');
        const deployment = await this.options.vercel.getDeployment({ projectId: this.options.projectId, teamId: this.options.teamId, deploymentId: this.options.deploymentId });
        if (deployment.readyState !== 'READY' || deployment.sourceSha !== input.packet.desiredManifest.readiness.sourceSha) fail('SOURCE_INVALID');
        const desired = input.packet.desiredManifest.readiness;
        const immutable = await this.options.vercel.readDeploymentReadiness({
            deployment,
            expected: {
                sourceSha: desired.sourceSha, legacyTargetResource: desired.legacyTargetResource,
                preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                preflightProducerConfigFingerprint: desired.preflightFingerprint,
                paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                paidProducerConfigFingerprint: desired.paidFingerprint,
                analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false, ready: true,
            },
        });
        const aliases = await this.options.vercel.getAliases({ deploymentId: this.options.deploymentId, teamId: this.options.teamId });
        if (!aliases.includes(this.options.producerAlias)) fail('OBSERVATION_RACE');
        return this.evidence('RECONCILE_PRODUCERS_CLOSED_ALIGNED', { readiness, immutable: { sourceSha: immutable.sourceSha, ready: immutable.ready }, aliases }, input.lease.lock.lockFence);
    }

    private async reconcileQueues(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const queues: unknown[] = [];
        const schedulers: unknown[] = [];
        const nowMs = this.now();
        for (const role of ['preflight', 'paid'] as const) {
            const queueInput = input.packet.protectedInputs.desired.queues[role];
            const schedulerInput = input.packet.protectedInputs.desired.schedulers[role];
            const queue = await this.options.workPlanes.observeQueue(queueInput);
            validateQueueObservation({ role, ...queue }, queueInput, input.packet.desiredManifest.queues[role].configDigest, role);
            const scheduler = await this.options.workPlanes.observeScheduler(schedulerInput);
            validateSchedulerObservation({ role, ...scheduler, nowMs }, schedulerInput, nowMs, input.packet.quiescence.timeoutMs, input.packet.quiescence.graceMs, role);
            queues.push({ role, digest: canonicalDigest(queue) });
            schedulers.push({ role, digest: canonicalDigest(scheduler) });
        }
        return this.evidence('RECONCILE_QUEUES_ALIGNED', { queues, schedulers }, input.lease.lock.lockFence);
    }

    private async reconcileInvokers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const policies: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                const target = input.packet.protectedInputs.desired.iam[role][kind];
                const observed = await this.options.iam.getPolicy(target);
                for (const expected of target.bindings) if (!observed.bindings.some(actual => canonicalDigest(actual) === canonicalDigest(expected))) fail('OBSERVATION_RACE');
                policies.push({ role, kind, digest: canonicalDigest(observed) });
            }
        }
        return this.evidence('RECONCILE_INVOKERS_ROTATED', policies, input.lease.lock.lockFence);
    }

    private async reconcilePromoted(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const runtimes: unknown[] = [];
        const policies: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const revision = this.desiredRevisionCandidate(input.packet, role);
            const service = await this.options.cloudRun.getService(this.serviceResource(runtime));
            const source = await this.readSource({ role, phase: 'desired', revision, runtime });
            const buildDigest = await this.readBuildDigest({ role, phase: 'desired', revision, image: service.image });
            const observation = this.runtimeObservation(runtime, service, source.sourceSha, revision, 'PROMOTED', buildDigest);
            validateRuntimeObservation(observation, runtime, {
                mode: 'PROMOTED', revision,
                runtimeDigest: input.packet.desiredManifest.source[role].desiredRuntimeDigest,
                buildDigest: input.packet.desiredManifest.source[role].desiredBuildDigest,
            });
            runtimes.push({ role, digest: canonicalDigest(observation) });
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                const target = input.packet.protectedInputs.desired.iam[role][kind];
                const observed = await this.options.iam.getPolicy(target);
                const expected = this.desiredBindingsAfterRetirement(input.packet, role, kind, target.bindings);
                if (canonicalDigest(observed.bindings) !== canonicalDigest(expected)) fail('OBSERVATION_RACE');
                policies.push({ role, kind, digest: canonicalDigest(observed) });
            }
        }
        return this.evidence('RECONCILE_SERVICES_PROMOTED', { runtimes, policies }, input.lease.lock.lockFence);
    }

    async reconcile(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease; state: State }>): Promise<OperationEvidence> {
        switch (input.state) {
            case 'PREPARED': return this.prepare(input);
            case 'STAGED': return this.reconcileStaged(input);
            case 'PRODUCERS_CLOSED_ALIGNED': return this.reconcileProducers(input);
            case 'QUEUES_ALIGNED': return this.reconcileQueues(input);
            case 'INVOKERS_ROTATED': return this.reconcileInvokers(input);
            case 'SERVICES_PROMOTED': return this.reconcilePromoted(input);
            case 'VERIFIED': return this.verify(input);
            default: fail('JOURNAL_INVALID');
        }
    }

    async compensateActivation(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const resources: unknown[] = [];
        if (this.options.closeAdmissionGates) {
            try {
                await this.options.closeAdmissionGates(input);
                resources.push({ action: 'CLOSE_ADMISSION_GATES', result: 'OBSERVED' });
            } catch (error) {
                resources.push({ action: 'CLOSE_ADMISSION_GATES', result: error instanceof EpochError ? error.code : 'PROBE_FAILED' });
            }
        } else {
            resources.push({ action: 'CLOSE_ADMISSION_GATES', result: 'EVIDENCE_UNAVAILABLE' });
        }
        for (const role of ['preflight', 'paid'] as const) {
            try {
                await this.options.workPlanes.pauseScheduler(input.packet.protectedInputs.desired.schedulers[role]);
                resources.push({ role, plane: 'scheduler', result: 'OBSERVED' });
            } catch (error) {
                resources.push({ role, plane: 'scheduler', result: error instanceof EpochError ? error.code : 'PROBE_FAILED' });
            }
            try {
                await this.options.workPlanes.pauseQueue(input.packet.protectedInputs.desired.queues[role]);
                resources.push({ role, plane: 'queue', result: 'OBSERVED' });
            } catch (error) {
                resources.push({ role, plane: 'queue', result: error instanceof EpochError ? error.code : 'PROBE_FAILED' });
            }
        }
        return this.evidence('COMPENSATED', resources, input.lease.lock.lockFence);
    }

    async activate(): Promise<OperationEvidence> {
        // Gate mutation requires a separately reviewed Vercel deployment/env
        // channel not carried by this packet; refusing here prevents a live
        // coordinator from claiming ACTIVATED with an unreviewed endpoint.
        fail('ACTIVATION_AUTH_REQUIRED');
    }

    private async assertLive(lease: JournalLease): Promise<void> {
        if (this.options.journal) await this.options.journal.assertLive(lease);
    }

    private async captureZeroWorkBaseline(): Promise<void> {
        if (this.zeroWorkBaseline || !this.options.zeroWorkBaseline) return;
        const capturedAtMs = this.now();
        if (!Number.isSafeInteger(capturedAtMs) || capturedAtMs < 0) fail('EVIDENCE_UNAVAILABLE');
        const baseline = await this.options.zeroWorkBaseline({ nowMs: capturedAtMs });
        if (!isObject(baseline) || typeof baseline.capturedAtMs !== 'number'
            || !Number.isSafeInteger(baseline.capturedAtMs) || baseline.capturedAtMs < 0
            || baseline.capturedAtMs > capturedAtMs) fail('EVIDENCE_UNAVAILABLE');
        this.zeroWorkBaseline = { capturedAtMs: baseline.capturedAtMs, digest: canonicalDigest(baseline) };
    }

    private serviceResource(runtime: ProtectedRuntimeInput): string {
        return `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
    }

    private async readSource(input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; runtime: ProtectedRuntimeInput }>): Promise<SourceObservation> {
        if (!this.options.sourceObservation) fail('EVIDENCE_UNAVAILABLE');
        const value = await this.options.sourceObservation(input);
        validateSourceObservation(value, {
            role: input.role,
            oldSha: input.phase === 'old' ? input.runtime.sourceSha : input.runtime.sourceSha,
            oldRevision: input.phase === 'old' ? input.revision : 'unused-old-revision',
            desiredSha: input.runtime.sourceSha,
            ...(input.phase === 'desired' ? { desiredRevisionId: input.revision } : {}),
        }, input.phase);
        return value;
    }

    private async readBuildDigest(input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; image: string }>): Promise<string> {
        if (!this.options.buildObservation) fail('EVIDENCE_UNAVAILABLE');
        const value = await this.options.buildObservation(input);
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('SOURCE_INVALID');
        return value;
    }

    private async ensureIamBindings(input: ProtectedIamInput, role: Role, expectedBindings: readonly ProtectedIamBinding[], lease: JournalLease): Promise<Readonly<{ resource: string; project: string; etag: string; bindings: readonly ProtectedIamBinding[] }>> {
        const observed = await this.options.iam.getPolicy(input);
        const missing = expectedBindings.filter(expected => !observed.bindings.some(actual => canonicalDigest(actual) === canonicalDigest(expected)));
        if (missing.length === 0) return observed;
        if (observed.etag !== input.etag) fail('OBSERVATION_RACE');
        await this.assertLive(lease);
        return this.options.iam.addBindings({ ...input, etag: observed.etag }, missing);
    }

    private retiredIdentitySet(packet: CapacityEpochPacket): ReadonlySet<string> {
        const desired = new Set(Object.values(packet.desiredManifest.roleSlots).map(identity => identity.identity));
        return new Set(Object.values(packet.oldManifest.roleSlots).map(identity => identity.identity).filter(identity => !desired.has(identity)));
    }

    private retiredBindings(packet: CapacityEpochPacket, role: Role, kind: 'run' | 'queue' | 'taskCaller' | 'maintenance', bindings: readonly ProtectedIamBinding[]): readonly ProtectedIamBinding[] {
        const retired = this.retiredIdentitySet(packet);
        const roles = kind === 'queue' ? new Set(['roles/cloudtasks.enqueuer', 'roles/cloudtasks.viewer']) : kind === 'taskCaller' ? new Set(['roles/iam.serviceAccountUser']) : new Set(['roles/run.invoker']);
        void role;
        return bindings.filter(binding => roles.has(binding.role) && retired.has(binding.member.slice('serviceAccount:'.length)));
    }

    private desiredBindingsAfterRetirement(packet: CapacityEpochPacket, role: Role, kind: 'run' | 'queue' | 'taskCaller' | 'maintenance', bindings: readonly ProtectedIamBinding[]): readonly ProtectedIamBinding[] {
        const retired = new Set(this.retiredBindings(packet, role, kind, bindings).map(binding => canonicalDigest(binding)));
        return bindings.filter(binding => !retired.has(canonicalDigest(binding)));
    }

    private assertObservationDigest(packet: CapacityEpochPacket, key: keyof CapacityEpochPacket['observationInputs'], value: unknown): void {
        if (canonicalDigest(value) !== packet.observationInputs[key]) fail('OBSERVATION_RACE');
    }

    private runtimeObservation(
        expected: ProtectedRuntimeInput,
        observed: Readonly<{ identity: ProtectedRuntimeInput['identity']; environment: Readonly<Record<string, string>>; secretReferences: Readonly<Record<string, string>>; settings: ProtectedRuntimeInput['settings']; noTraffic: boolean; generation: string; resourceVersion: string; traffic: readonly Readonly<{ revisionName: string | null; percent: number }>[]}>,
        sourceSha: string,
        revision: string,
        mode: 'STAGED' | 'PROMOTED',
        buildDigest: string,
    ): Record<string, unknown> {
        const runtime = {
            ...expected,
            sourceSha,
            identity: observed.identity,
            environment: observed.environment,
            secretReferences: observed.secretReferences,
            settings: observed.settings,
            noTraffic: observed.noTraffic,
        };
        const traffic: Record<string, number> = {};
        for (const entry of observed.traffic) if (entry.revisionName !== null) traffic[entry.revisionName] = entry.percent;
        return {
            ...runtime,
            mode,
            revision,
            generation: observed.generation,
            resourceVersion: observed.resourceVersion,
            runtimeDigest: canonicalDigest(runtime),
            buildDigest,
            traffic,
        };
    }

    private async readReadiness(packet: CapacityEpochPacket, phase: 'old' | 'desired'): Promise<Readonly<Record<string, unknown>>> {
        const expected = phase === 'old' ? packet.oldManifest.readiness : packet.desiredManifest.readiness;
        const readiness = await this.options.vercel.readPublicReadiness({
            url: this.options.publicReadinessUrl,
            expected: {
                sourceSha: expected.sourceSha,
                legacyTargetResource: expected.legacyTargetResource,
                preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                preflightProducerConfigFingerprint: expected.preflightFingerprint,
                paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                paidProducerConfigFingerprint: expected.paidFingerprint,
                analysisV2AdmissionEnabled: false,
                earlybirdWebhookAutoAdmissionEnabled: false,
                ready: true,
            },
        });
        const observation = {
            schemaVersion: readiness.schemaVersion,
            sourceSha: readiness.sourceSha,
            legacyTargetResource: readiness.legacyTargetResource,
            preflightFingerprint: readiness.preflightProducerConfigFingerprint,
            paidFingerprint: readiness.paidProducerConfigFingerprint,
            analysisV2AdmissionEnabled: readiness.analysisV2AdmissionEnabled,
            earlybirdWebhookAutoAdmissionEnabled: readiness.earlybirdWebhookAutoAdmissionEnabled,
            ready: readiness.ready,
        };
        validateReadinessObservation(observation, expected);
        if (readiness.preflightProducerConfigReady !== true || readiness.paidProducerConfigReady !== true) fail('READINESS_INVALID');
        return observation;
    }

    private desiredRevisionCandidate(packet: CapacityEpochPacket, role: Role): string {
        return this.capturedRevisions.get(role) ?? this.desiredRevision(packet, role);
    }

    private desiredRevision(packet: CapacityEpochPacket, role: Role): string {
        const plan = packet.desiredManifest.source[role].revisionPlan;
        const suffix = packet.desiredManifest.source[role].desiredRevisionId ?? `${packet.desiredManifest.source[role].desiredSha.slice(0, 12)}${plan.suffix}`;
        const revision = `${plan.prefix}${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
        if (!/^[a-z][a-z0-9-]{0,62}$/.test(revision) || revision === 'latest') fail('SOURCE_INVALID');
        return revision;
    }

    private evidence(action: string, value: unknown, fence: string): OperationEvidence {
        return {
            precondition: { action, fence }, mutation: { action }, postcondition: value,
            proof: { action, digest: canonicalDigest(value) }, nativeConcurrencyToken: { fence }, resourceObservation: value,
        };
    }
}

export { EpochError };

function queueTargetMatches(actual: unknown, expected: Readonly<{ audience: string; callerIdentity: Readonly<{ identity: string; project: string }> }>): boolean {
    return isObject(actual)
        && actual.audience === expected.audience
        && canonicalDigest(actual.callerIdentity) === canonicalDigest(expected.callerIdentity);
}
