import {
    STATES,
    EpochError,
    canonicalDigest,
    canonicalQueueConfiguration,
    canonicalRuntimeInputDigest,
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
import { EpochJournal, transitionCommitment, type JournalLease } from './journal';
import { type CapacityReservation, type ReservationLease } from './exclusion';
import { CloudRunAdapter, type LeaseCheck } from './cloud-run';
import { issueLeaseCheck } from './lease-capability';
import { IamAdapter } from './iam';
import { WorkPlaneClient } from './work-planes';
import { VercelAdapter } from './vercel';
import { issueReceiverProbeAuthority, type ReceiverProbeAuthority } from './platform';
import {
    validateSourceObservation,
    validateRuntimeObservation,
    validateQueueObservation,
    validateSchedulerObservation,
    validateRetentionObservation,
    validateReadinessObservation,
    validateIamObservation,
    validateZeroWorkObservation,
    type SourceObservation,
} from './observations';
import type { ProtectedRuntimeInput, ProtectedQueueInput, ProtectedIamInput, ProtectedIamBinding } from './contracts';
import { PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION, PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION } from '../../lib/services/analysis/legacy-analysis-public-readiness';

type EvidenceValue = unknown;
type BoundLeaseCheck = LeaseCheck & { currentLease: () => JournalLease };

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
    /**
     * Read-only admission for a cold epoch.  Implementations must complete
     * all PREPARED observations before the journal header/lock is initialized.
     * Resumed epochs skip this hook after a retained header is found.
     */
    admit?(input: Readonly<{ packet: CapacityEpochPacket }>): Promise<void>;
    /** Restore digest-only evidence retained by the journal before resume. */
    resume?(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease; state: State | null }>): Promise<void>;
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
    /** Live implementations notify the coordinator when a lease is renewed mid-operation. */
    bindLeaseUpdated?(callback: (lease: JournalLease) => Promise<void> | void): void;
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

function bindingsDigest(bindings: readonly unknown[]): string {
    return canonicalDigest([...bindings].sort((left, right) => canonicalDigest(left).localeCompare(canonicalDigest(right))));
}

/**
 * Derive the common mutation scope from the reviewed packet's exact provider
 * identities.  `lockNamespace` is intentionally absent: two epochs with
 * different labels but the same services, queues, schedulers, IAM policies,
 * retention job, and Vercel producer resources must contend on one key.
 */
export function sharedReservationResources(packet: CapacityEpochPacket): readonly string[] {
    const resources = new Set<string>();
    // Bucket/project/team values are validation context, not mutation atoms.
    // Reserve only the exact provider resources that ordinary entry points
    // can mutate, using the same kind:value spelling as the bridge.
    resources.add(`vercel:deployment:${packet.providerScope.vercelDeploymentId}`);
    resources.add(`vercel:deployment:${packet.providerScope.vercelExpectedOldDeploymentId}`);
    resources.add(`vercel:alias:${packet.providerScope.vercelProducerAlias}`);
    for (const phase of ['old', 'desired'] as const) {
        const inputs = packet.protectedInputs[phase];
        for (const role of ['preflight', 'paid'] as const) {
            const runtime = inputs.runtime[role];
            resources.add(`service:projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`);
            const queue = inputs.queues[role];
            resources.add(`queue:${queue.resource}`);
            const scheduler = inputs.schedulers[role];
            resources.add(`scheduler:${scheduler.resource}`);
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                const iam = inputs.iam[role][kind];
                resources.add(`iam:${iam.resource}`);
                if (iam.previous) resources.add(`iam:${iam.previous.resource}`);
            }
        }
        resources.add(`retention:${inputs.retention.resource}`);
    }
    return Object.freeze([...resources].sort());
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
    /** Fresh read-only proof held by the caller at authorization time. */
    freshVerifiedProofDigest: string;
    /** Immutable journal proof anchoring the VERIFIED transition. */
    durableVerifiedProofDigest: string;
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
    /** Common reservation shared with ordinary capacity writers. */
    private readonly sharedReservation: CapacityReservation;
    private sharedReservationLease: ReservationLease | undefined;
    private lease: JournalLease | undefined;
    private verifiedProofDigest: string | undefined;
    private durableVerifiedProofDigest: string | undefined;

    constructor(options: EpochCoordinatorOptions) {
        validateEpochPacket(options.packet);
        this.packet = freezeDeep(options.packet);
        this.journal = options.journal;
        this.controlPlane = options.controlPlane;
        this.ownerDigest = options.ownerDigest;
        this.capability = options.capability ?? issueCoordinatorCapability(this.packet, options.ownerDigest);
        assertCoordinatorCapability(this.packet, this.capability, options.ownerDigest);
        this.now = options.now ?? (() => Date.now());
        this.sharedReservation = options.journal.createSharedReservation(sharedReservationResources(this.packet));
        this.controlPlane.bindLeaseUpdated?.(async (lease) => {
            this.lease = lease;
            await this.renewSharedReservation();
        });
    }

    /** Runs the closed rollout through VERIFIED. It never invokes activation. */
    async runThroughVerified(): Promise<Readonly<{ state: 'VERIFIED'; lease: JournalLease; proofDigest: string }>> {
        this.assertCapabilityBinding();
        try {
        // A proof is scoped to this invocation's fresh observations. Do not
        // let a prior run on the same coordinator instance suppress a new
        // owner/current-fence proof on a later resume.
        this.verifiedProofDigest = undefined;
        this.durableVerifiedProofDigest = undefined;
        if (!(await this.journal.hasHeader())) {
            await this.controlPlane.admit?.({ packet: this.packet });
        }
        await this.ensureSharedReservation();
        await this.journal.ensureHeader();
        this.lease = await this.journal.acquire(this.ownerDigest);
        let state = await this.journal.readValidatedState(this.lease);
        if (state.aborted) fail('ABORTED_EPOCH');
        await this.controlPlane.resume?.({ packet: this.packet, lease: this.lease, state: state.state });
        state = await this.reconcileUntilStable(state);

        const verifiedIndex = STATES.indexOf('VERIFIED');
        let nextIndex = state.state === null ? 0 : STATES.indexOf(state.state) + 1;
        if (nextIndex > verifiedIndex) {
            if (state.state !== 'VERIFIED') fail('JOURNAL_INVALID');
            // A VERIFIED journal transition is not a cached authorization. A
            // new owner gets exactly one fresh read-only proof during
            // reconciliation; do not execute the probe-bearing verification a
            // second time merely because the historical fence is older.
            if (!this.verifiedProofDigest || !this.durableVerifiedProofDigest) {
                this.assertCapabilityBinding();
                await this.journal.assertLive(this.lease);
                const before = await this.journal.readValidatedState(this.lease);
                const evidence = await this.controlPlane.verify({ packet: this.packet, lease: this.lease });
                validateEvidence(evidence);
                const after = await this.journal.readValidatedState(this.lease);
                if (after.state !== 'VERIFIED' || after.activeFence !== before.activeFence || after.transitions.length !== before.transitions.length) fail('OBSERVATION_RACE');
                this.durableVerifiedProofDigest = before.transitions[before.transitions.length - 1]?.proofDigest;
                if (!this.durableVerifiedProofDigest) fail('NOT_VERIFIED');
                this.verifiedProofDigest = evidenceDigest(evidence.proof);
            }
            const result = { state: 'VERIFIED' as const, lease: this.lease, proofDigest: this.verifiedProofDigest };
            await this.releaseSharedReservation();
            return result;
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
            await this.assertSharedReservation();
            await this.journal.append(this.lease, transition);
            state = await this.journal.readValidatedState(this.lease);
            state = await this.reconcileUntilStable(state);
            nextIndex = state.state === null ? 0 : STATES.indexOf(state.state) + 1;
        }
        const final = await this.journal.readValidatedState(this.lease);
        if (final.state !== 'VERIFIED' || final.aborted) fail('NOT_VERIFIED');
        this.verifiedProofDigest = final.transitions[final.transitions.length - 1]?.proofDigest;
        this.durableVerifiedProofDigest = this.verifiedProofDigest;
        if (!this.verifiedProofDigest || !this.durableVerifiedProofDigest) fail('NOT_VERIFIED');
        const result = { state: 'VERIFIED' as const, lease: this.lease, proofDigest: this.verifiedProofDigest };
        await this.releaseSharedReservation();
            return result;
        } catch (error) {
            try { await this.releaseSharedReservation(); } catch { /* retain the original fail-closed error */ }
            throw error;
        }
    }

    issueActivationAuthorization(): ActivationAuthorization {
        if (!this.lease || !this.verifiedProofDigest || !this.durableVerifiedProofDigest) fail('NOT_VERIFIED');
        const token = Object.freeze(Object.create(null)) as ActivationAuthorization;
        activationRegistry.set(token, {
            packetDigest: canonicalDigest(this.packet),
            freshVerifiedProofDigest: this.verifiedProofDigest,
            durableVerifiedProofDigest: this.durableVerifiedProofDigest,
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
            || binding.freshVerifiedProofDigest !== this.verifiedProofDigest
            || binding.durableVerifiedProofDigest !== this.durableVerifiedProofDigest
            || binding.ownerDigest !== this.ownerDigest || binding.expiresAtMs < this.now()
            || binding.gates.analysisV2AdmissionEnabled !== this.packet.activation.analysisV2AdmissionEnabled
            || binding.gates.earlybirdWebhookAutoAdmissionEnabled !== this.packet.activation.earlybirdWebhookAutoAdmissionEnabled) fail('ACTIVATION_AUTH_REQUIRED');
        if (!this.lease) fail('ACTIVATION_AUTH_REQUIRED');
        await this.ensureSharedReservation();
        const state = await this.journal.readValidatedState(this.lease);
        if (state.state !== 'VERIFIED' || state.aborted || state.transitions[state.transitions.length - 1]?.proofDigest !== binding.durableVerifiedProofDigest) fail('NOT_VERIFIED');
        await this.journal.assertLive(this.lease);
        if (!this.controlPlane.activate) fail('ACTIVATION_AUTH_REQUIRED');
        try {
            const evidence = await this.controlPlane.activate({ packet: this.packet, lease: this.lease });
            const current = await this.journal.readValidatedState(this.lease);
            const transition = transitionForEvidence(current.transitions.length + 1, this.journal.epochIdDigest, 'VERIFIED', 'ACTIVATED', this.lease.lock.lockFence, evidence, this.now());
            await this.journal.append(this.lease, transition);
            const result = { state: 'ACTIVATED' as const, lease: this.lease };
            await this.releaseSharedReservation();
            return result;
        } catch (error) {
            try { await this.controlPlane.compensateActivation({ packet: this.packet, lease: this.lease }); } catch { /* closure remains unknown and is never claimed successful */ }
            try { await this.releaseSharedReservation(); } catch { /* preserve the activation failure */ }
            throw error instanceof EpochError ? error : new EpochError('PROBE_FAILED');
        }
    }

    async abort(reasonCode: 'OPERATOR_ABORT' | 'CONTROL_PLANE_FAILURE'): Promise<Readonly<{ state: State | null; aborted: true }>> {
        this.assertCapabilityBinding();
        if (!this.lease) {
            await this.ensureSharedReservation();
            await this.journal.ensureHeader();
            this.lease = await this.journal.acquire(this.ownerDigest);
        } else {
            await this.ensureSharedReservation();
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
        await this.releaseSharedReservation();
        return { state: state.state, aborted: true };
    }

    private async ensureSharedReservation(): Promise<void> {
        if (this.sharedReservationLease) {
            await this.sharedReservation.assert(this.sharedReservationLease);
            return;
        }
        this.sharedReservationLease = await this.sharedReservation.acquire(this.journal.epochIdDigest, this.ownerDigest);
    }

    private async assertSharedReservation(): Promise<void> {
        if (!this.sharedReservationLease) fail('LOCK_LOST');
        await this.sharedReservation.assert(this.sharedReservationLease);
    }

    private async renewSharedReservation(): Promise<void> {
        const lease = this.sharedReservationLease;
        if (!lease) fail('LOCK_LOST');
        this.sharedReservationLease = await this.sharedReservation.renew(lease);
    }

    private async releaseSharedReservation(): Promise<void> {
        const lease = this.sharedReservationLease;
        if (!lease) return;
        await this.sharedReservation.release(lease);
        this.sharedReservationLease = undefined;
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
            await this.assertSharedReservation();
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
            if (this.reconciliationMarker(after) === this.reconciliationMarker(state)) {
                if (state.state === 'VERIFIED' && after.state === 'VERIFIED') {
                    this.durableVerifiedProofDigest = after.transitions[after.transitions.length - 1]?.proofDigest;
                    this.verifiedProofDigest = evidenceDigest(evidence.proof);
                    if (!this.durableVerifiedProofDigest) fail('NOT_VERIFIED');
                }
                return after;
            }
            state = after;
            mustReconcile = true;
        }
        fail('OBSERVATION_RACE');
    }

    private async runOperation(target: StateOperation, lease: JournalLease): Promise<OperationEvidence> {
        await this.assertSharedReservation();
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
    journal: EpochJournal;
    /** Opaque coordinator capability bound to this packet and owner. */
    capability: CoordinatorCapability;
    /** Owner digest bound to the immutable operation capabilities. */
    ownerDigest: string;
    /** Renew the active GCS lease before each concrete submutation/poll. */
    renewLease?: (lease: JournalLease) => Promise<JournalLease>;
    /** Source/revision evidence is an independent Git/provider observation. */
    sourceObservation?: (input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; runtime: ProtectedRuntimeInput }>) => Promise<unknown>;
    /** Build/source provenance binds the deployed image to the reviewed build input. */
    buildObservation?: (input: Readonly<{ role: Role; phase: 'old' | 'desired'; revision: string; image: string }>) => Promise<unknown>;
    /** Ledger/log evidence is fetched only at VERIFIED, never supplied as a success bit. */
    zeroWorkObservation?: (input: Readonly<{ windowStartMs: number; windowEndMs: number; nowMs: number; baselineDigest?: string }>) => Promise<unknown>;
    /** Captured before the first authorized mutation; only its digest survives. */
    zeroWorkBaseline?: (input: Readonly<{ nowMs: number }>) => Promise<unknown>;
    /** Provider-free probes are executed by the reviewed probe harness. */
    probe?: (input: Readonly<{ role: Role; runtime: ProtectedRuntimeInput; revision: string; authority: ReceiverProbeAuthority }>) => Promise<unknown>;
    /** Activation compensation closes both producer gates before pausing resources. */
    closeAdmissionGates?: (input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>) => Promise<unknown>;
    now?: () => number;
}>;

export class LiveEpochControlPlane implements EpochControlPlane {
    private readonly options: LiveEpochControlPlaneOptions;
    private readonly capturedRevisions = new Map<Role, string>();
    private readonly now: () => number;
    private zeroWorkBaseline: Readonly<{ capturedAtMs: number; digest: string }> | undefined;
    private leaseUpdated?: (lease: JournalLease) => Promise<void> | void;

    constructor(options: LiveEpochControlPlaneOptions) {
        this.options = options;
        this.now = options.now ?? (() => Date.now());
    }

    bindLeaseUpdated(callback: (lease: JournalLease) => Promise<void> | void): void {
        this.leaseUpdated = callback;
    }

    /**
     * Create an immutable operation-local fence capability.  Renewal state is
     * captured by this closure, so concurrent operations cannot replace one
     * another's lease or let an older request borrow a newer owner.
     */
    private leaseCheckFor(
        packet: CapacityEpochPacket,
        lease: JournalLease,
        operation: string,
        resources: string | readonly string[],
    ): BoundLeaseCheck {
        return issueLeaseCheck({
            packet,
            capability: this.options.capability,
            ownerDigest: this.options.ownerDigest,
            lease,
            operation,
            resource: resources,
            journal: this.options.journal,
            renew: this.options.renewLease !== undefined,
            onRenew: async updated => { await this.leaseUpdated?.(updated); },
        });
    }

    /** Run complete read-only PREPARED admission before journal initialization. */
    async admit(input: Readonly<{ packet: CapacityEpochPacket }>): Promise<void> {
        await this.prepare({ packet: input.packet });
    }

    async resume(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease; state: State | null }>): Promise<void> {
        const retained = await this.options.journal.readEvidenceBaseline(input.lease);
        if (retained) {
            if (retained.packetDigest !== canonicalDigest(input.packet)
                || retained.epochHeaderDigest !== this.options.journal.epochHeaderDigest) fail('CAPABILITY_BINDING_MISMATCH');
            if (input.state === null
                && (retained.ownerDigest !== input.lease.lock.ownerDigest || retained.lockFence !== input.lease.lock.lockFence)) {
                // A baseline written before PREPARED belongs to the fence
                // that captured it. Once that owner is taken over before the
                // transition append, fail closed rather than silently
                // recapturing a later window under a new fence.
                fail('LOCK_LOST');
            }
            // Re-read the original ledger checkpoint at its retained timestamp
            // before adopting the journal value. This is a provenance check,
            // not a fresh capture: a tampered timestamp/digest cannot become
            // the new zero-work window after a crash before PREPARED append.
            if (!this.options.zeroWorkBaseline) fail('EVIDENCE_UNAVAILABLE');
            const observedBaseline = await this.options.zeroWorkBaseline({ nowMs: retained.capturedAtMs });
            if (!isObject(observedBaseline) || observedBaseline.capturedAtMs !== retained.capturedAtMs
                || canonicalDigest(observedBaseline) !== retained.digest) fail('OBSERVATION_RACE');
            if (input.state !== null) {
                const state = await this.options.journal.readValidatedState(input.lease);
                const prepared = state.transitions[0];
                if (!prepared || prepared.toState !== 'PREPARED'
                    || transitionCommitment(prepared) !== retained.transitionCommitment) fail('OBSERVATION_RACE');
            }
            this.zeroWorkBaseline = retained;
            return;
        }
        if (input.state !== null) fail('EVIDENCE_UNAVAILABLE');
    }

    async prepare(input: Readonly<{ packet: CapacityEpochPacket; lease?: JournalLease }>): Promise<OperationEvidence> {
        const packet = input.packet;
        const initialState = input.lease ? await this.options.journal.readValidatedState(input.lease) : undefined;
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
                || canonicalDigest(canonicalQueueConfiguration(queueObservation.configuration)) !== canonicalDigest(canonicalQueueConfiguration(expectedQueue.configuration))
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
            || canonicalDigest(retention) !== canonicalDigest({ role: 'retention', ...packet.protectedObservations.old.retention, configurationDigest: canonicalDigest(packet.protectedObservations.old.retention.configuration) })) fail('OBSERVATION_RACE');
        // observationInputs are reviewed packet/input digests, not hashes of
        // a differently-shaped live response. Keep both projections distinct:
        // exact field-by-field checks above prove the old state, while these
        // safe digests retain the observed payload for the journal.
        const prepared = this.evidence('PREPARED', {
            readiness,
            services,
            queues,
            schedulers,
            policies,
                retention,
                packetObservationInputs: packet.observationInputs,
                zeroWorkBaseline: this.zeroWorkBaseline
                    ? { capturedAtMs: this.zeroWorkBaseline.capturedAtMs, digest: this.zeroWorkBaseline.digest }
                    : null,
                observedDigests: {
                source: canonicalDigest(sourceFacts),
                queue: canonicalDigest(queueFacts),
                scheduler: canonicalDigest(schedulerFacts),
                iam: canonicalDigest(iamFacts),
                retention: canonicalDigest(retention),
                readiness: canonicalDigest(readiness),
            },
        }, input.lease?.lock.lockFence ?? 'admission');
        if (input.lease && this.zeroWorkBaseline && initialState?.state === null) {
            const current = await this.options.journal.readValidatedState(input.lease);
            if (current.state !== null || current.transitions.length !== initialState.transitions.length) fail('OBSERVATION_RACE');
            const sequence = current.transitions.length + 1;
            const committed = transitionCommitment({
                sequence,
                fromState: current.state,
                toState: 'PREPARED',
                stateVersion: sequence,
                lockFence: input.lease.lock.lockFence,
                preconditionDigest: canonicalDigest(prepared.precondition),
                mutationDigest: canonicalDigest(prepared.mutation),
                postconditionDigest: canonicalDigest(prepared.postcondition),
                proofDigest: canonicalDigest(prepared.proof),
                nativeConcurrencyTokenDigest: canonicalDigest(prepared.nativeConcurrencyToken),
                resourceObservationDigest: canonicalDigest(prepared.resourceObservation),
                resultCode: 'OK',
            });
            await this.options.journal.persistEvidenceBaseline(input.lease, {
                ...this.zeroWorkBaseline,
                epochHeaderDigest: this.options.journal.epochHeaderDigest,
                packetDigest: canonicalDigest(packet),
                transitionCommitment: committed,
                ownerDigest: input.lease.lock.ownerDigest,
                lockFence: input.lease.lock.lockFence,
            });
        }
        return prepared;
    }

    async stage(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const serviceResources = (['preflight', 'paid'] as const).map(role => this.serviceResource(input.packet.protectedInputs.desired.runtime[role]));
        const leaseCheck = this.leaseCheckFor(input.packet, input.lease, 'cloud-run.stage', serviceResources);
        const staged: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            await leaseCheck();
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const serviceResource = `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
            const before = await this.options.cloudRun.getService(serviceResource);
            const revision = this.desiredRevisionCandidate(input.packet, role);
            const after = await this.options.cloudRun.stageRevision({ runtime, revision, expectedGeneration: before.generation, serviceBody: this.options.serviceBodies[role], leaseCheck });
            const captured = after.latestReadyRevision === revision || after.latestCreatedRevision === revision ? revision : null;
            if (!captured) fail('SOURCE_INVALID');
            this.capturedRevisions.set(role, captured);
            const source = await this.readSource({ role, phase: 'desired', revision: captured, runtime });
            // The service status may still legitimately report OLD=100 while
            // the newly-created immutable revision receives 0%. Read the
            // revision itself and construct STAGED evidence from that scoped
            // object instead of relabeling whole-service traffic as no-op.
            const revisionObservation = await this.options.cloudRun.observeRevision(runtime.project, runtime.location, captured);
            const buildDigest = await this.readBuildDigest({ role, phase: 'desired', revision: captured, image: revisionObservation.image });
            const runtimeObservation = this.runtimeObservation(runtime, {
                ...revisionObservation,
                noTraffic: true,
                traffic: [],
                url: after.url,
            }, source.sourceSha, captured, 'STAGED', buildDigest);
            validateRuntimeObservation(runtimeObservation, runtime, {
                mode: 'STAGED', revision: captured,
                runtimeDigest: input.packet.desiredManifest.source[role].desiredRuntimeDigest,
                buildDigest: input.packet.desiredManifest.source[role].desiredBuildDigest,
            });
            staged.push({
                role,
                revision,
                generation: after.generation,
                digest: after.rawDigest,
                sourceSha: runtimeObservation.sourceSha,
                runtimeDigest: runtimeObservation.runtimeDigest,
                buildDigest: runtimeObservation.buildDigest,
            });
        }
        return this.evidence('STAGED', staged, leaseCheck.currentLease().lock.lockFence);
    }

    async closeAndAlignProducers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const leaseCheck = this.leaseCheckFor(input.packet, input.lease, 'alias.assign', [this.options.producerAlias]);
        await leaseCheck();
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
        await leaseCheck();
        const aliases = await this.options.vercel.assignAlias({ projectId: this.options.projectId, teamId: this.options.teamId, deploymentId: this.options.deploymentId, expectedOldDeploymentId: this.options.expectedOldDeploymentId, expectedSourceSha: input.packet.desiredManifest.readiness.sourceSha, alias: this.options.producerAlias, leaseCheck });
        const readiness = await this.readReadiness(input.packet, 'desired');
        return this.evidence('PRODUCERS_CLOSED_ALIGNED', { oldReadiness, aliases, deployment, deploymentReadiness: { sourceSha: deploymentReadiness.sourceSha, ready: deploymentReadiness.ready, analysisV2AdmissionEnabled: deploymentReadiness.analysisV2AdmissionEnabled, earlybirdWebhookAutoAdmissionEnabled: deploymentReadiness.earlybirdWebhookAutoAdmissionEnabled }, readiness }, leaseCheck.currentLease().lock.lockFence);
    }

    async alignQueues(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        let currentLease = input.lease;
        const queues: unknown[] = [];
        const schedulers: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const schedulerPauseLease = this.leaseCheckFor(input.packet, currentLease, 'scheduler.pause', input.packet.protectedInputs.desired.schedulers[role].resource);
            await schedulerPauseLease();
            const schedulerInput = input.packet.protectedInputs.desired.schedulers[role];
            const queueInput = input.packet.protectedInputs.desired.queues[role];
            const oldSchedulerInput = input.packet.protectedInputs.old.schedulers[role];
            const oldQueueInput = input.packet.protectedInputs.old.queues[role];
            let scheduler = await this.options.workPlanes.observeScheduler(schedulerInput);
            let queue = await this.options.workPlanes.observeQueue(queueInput);
            if (scheduler.state !== 'PAUSED') {
                await schedulerPauseLease();
                scheduler = await this.options.workPlanes.pauseScheduler(schedulerInput, schedulerPauseLease);
            }
            currentLease = schedulerPauseLease.currentLease();
            const queuePauseLease = this.leaseCheckFor(input.packet, currentLease, 'queue.pause', input.packet.protectedInputs.desired.queues[role].resource);
            if (queue.state !== 'PAUSED') {
                await queuePauseLease();
                queue = await this.options.workPlanes.pauseQueue(queueInput, queuePauseLease);
            }
            // QUEUES_ALIGNED proves pause, quiescence, and the phase-correct
            // OLD auth chain only. Desired OIDC identities are aligned later,
            // after every desired IAM addition has independently read back.
            if (canonicalDigest(scheduler.target) !== canonicalDigest(oldSchedulerInput.target)
                || !queueTargetMatchesOrAbsent(queue.target, oldQueueInput)) fail('OBSERVATION_RACE');
            if (queue.tasks.length !== 0) fail('QUEUE_NOT_EMPTY');
            validateQueueObservation({ role, ...queue }, oldQueueInput, input.packet.oldManifest.queues[role].configDigest, role);
            validateSchedulerObservation({ role, ...scheduler, nowMs: this.now() }, oldSchedulerInput, this.now(), input.packet.quiescence.timeoutMs, input.packet.quiescence.graceMs, role);
            schedulers.push({ role, digest: canonicalDigest(scheduler) });
            queues.push({ role, digest: canonicalDigest(queue) });
            currentLease = queuePauseLease.currentLease();
        }
        return this.evidence('QUEUES_ALIGNED', { queues, schedulers }, currentLease.lock.lockFence);
    }

    async rotateInvokers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const iamResources = [...new Set((['preflight', 'paid'] as const).flatMap(role =>
            (['run', 'queue', 'taskCaller', 'maintenance'] as const).flatMap(kind => [
                input.packet.protectedInputs.desired.iam[role][kind].resource,
                input.packet.protectedInputs.old.iam[role][kind].resource,
            ])))];
        const leaseCheck = this.leaseCheckFor(input.packet, input.lease, 'iam.add', iamResources);
        const policies: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const iam = input.packet.protectedInputs.desired.iam[role];
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                await leaseCheck();
                const target = iam[kind];
                const observed = await this.ensureIamBindings(target, role, target.bindings, leaseCheck);
                policies.push({ role, kind, digest: canonicalDigest(observed) });
            }
        }
        const alignments: unknown[] = [];
        // IAM additions are complete and read back before touching any
        // paused Scheduler/Tasks OIDC target. This ordering closes the auth
        // chain before the first serving promotion.
        let currentLease = leaseCheck.currentLease();
        for (const role of ['preflight', 'paid'] as const) {
            const schedulerTargetLease = this.leaseCheckFor(input.packet, currentLease, 'scheduler.target', input.packet.protectedInputs.desired.schedulers[role].resource);
            await schedulerTargetLease();
            const desiredScheduler = input.packet.protectedInputs.desired.schedulers[role];
            const oldScheduler = input.packet.protectedInputs.old.schedulers[role];
            let scheduler = await this.options.workPlanes.observeScheduler(desiredScheduler);
            if (scheduler.state !== 'PAUSED') fail('SCHEDULER_NOT_QUIESCENT');
            if (canonicalDigest(scheduler.target) === canonicalDigest(oldScheduler.target)) {
                await schedulerTargetLease();
                scheduler = await this.options.workPlanes.updateSchedulerTarget({ input: desiredScheduler, expectedOldTarget: oldScheduler.target, desiredTarget: desiredScheduler.target, leaseCheck: schedulerTargetLease });
            } else if (canonicalDigest(scheduler.target) !== canonicalDigest(desiredScheduler.target)) fail('OBSERVATION_RACE');
            currentLease = schedulerTargetLease.currentLease();
            const queueTargetLease = this.leaseCheckFor(input.packet, currentLease, 'queue.target', input.packet.protectedInputs.desired.queues[role].resource);
            const desiredQueue = input.packet.protectedInputs.desired.queues[role];
            const oldQueue = input.packet.protectedInputs.old.queues[role];
            let queue = await this.options.workPlanes.observeQueue(desiredQueue);
            if (queue.state !== 'PAUSED') fail('QUEUE_NOT_EMPTY');
            const queueHasNoHttpTarget = queue.target === null && !isObject(desiredQueue.configuration.httpTarget);
            if (queueTargetMatches(queue.target, oldQueue.target)) {
                await queueTargetLease();
                queue = await this.options.workPlanes.updateQueueTarget({ input: desiredQueue, expectedOldTarget: oldQueue.target, desiredTarget: desiredQueue.target, leaseCheck: queueTargetLease });
            } else if (!queueTargetMatches(queue.target, desiredQueue.target) && !queueHasNoHttpTarget) fail('OBSERVATION_RACE');
            validateSchedulerObservation({ role, ...scheduler, nowMs: this.now() }, desiredScheduler, this.now(), input.packet.quiescence.timeoutMs, input.packet.quiescence.graceMs, role);
            validateQueueObservation({ role, ...queue }, desiredQueue, input.packet.desiredManifest.queues[role].configDigest, role);
            alignments.push({ role, scheduler: canonicalDigest(scheduler), queue: canonicalDigest(queue) });
            currentLease = queueTargetLease.currentLease();
        }
        return this.evidence('INVOKERS_ROTATED', { policies, alignments }, currentLease.lock.lockFence);
    }

    async promote(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const serviceResources = (['preflight', 'paid'] as const).map(role => this.serviceResource(input.packet.protectedInputs.desired.runtime[role]));
        const leaseCheck = this.leaseCheckFor(input.packet, input.lease, 'cloud-run.promote', serviceResources);
        const promoted: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            await leaseCheck();
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const resource = this.serviceResource(runtime);
            const before = await this.options.cloudRun.getService(resource);
            const revision = this.desiredRevisionCandidate(input.packet, role);
            const after = await this.options.cloudRun.setTraffic({ resource, expectedGeneration: before.generation, expectedRevision: revision, expectedPercent: 100, traffic: [{ revisionName: revision, percent: 100 }], leaseCheck });
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
        const iamResources = [...new Set((['preflight', 'paid'] as const).flatMap(role =>
            (['run', 'queue', 'taskCaller', 'maintenance'] as const).flatMap(kind => [
                input.packet.protectedInputs.desired.iam[role][kind].resource,
                input.packet.protectedInputs.old.iam[role][kind].resource,
            ])))];
        const iamLeaseCheck = this.leaseCheckFor(input.packet, leaseCheck.currentLease(), 'iam.remove', iamResources);
        // Old grants remain until both exact serving proofs above have passed.
        // Retirement is a fresh etag-CAS operation and never restores a stale policy.
        for (const role of ['preflight', 'paid'] as const) {
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                await iamLeaseCheck();
                const target = input.packet.protectedInputs.desired.iam[role][kind];
                const old = input.packet.protectedInputs.old.iam[role][kind];
                const resourceInputs = target.resource === old.resource ? [target] : [old, target];
                for (const resourceInput of resourceInputs) {
                    await iamLeaseCheck();
                    const observed = await this.options.iam.getPolicy(resourceInput);
                    const retired = this.retiredBindings(input.packet, role, kind, observed.bindings);
                    const remaining = observed.bindings.filter(binding => !retired.some(item => canonicalDigest(item) === canonicalDigest(binding)));
                    if (remaining.length !== observed.bindings.length) {
                        await iamLeaseCheck();
                        const result = await this.options.iam.replaceBindings({ ...resourceInput, etag: observed.etag }, remaining, iamLeaseCheck);
                        promoted.push({ role, kind, resource: resourceInput.resource, retired: retired.length, digest: canonicalDigest(result) });
                    }
                }
            }
        }
        return this.evidence('SERVICES_PROMOTED', promoted, iamLeaseCheck.currentLease().lock.lockFence);
    }

    async verify(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const packet = input.packet;
        const readiness = await this.readReadiness(packet, 'desired');
        const runtimes: unknown[] = [];
        const queues: unknown[] = [];
        const schedulers: unknown[] = [];
        const policies: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
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
                if (bindingsDigest(observed.bindings) !== bindingsDigest(expectedBindings)) fail('OBSERVATION_RACE');
                policies.push({ role, kind, digest: canonicalDigest(observed) });
            }
        }
        const retention = await this.options.workPlanes.observeRetention(packet.protectedInputs.desired.retention);
        validateRetentionObservation(retention, packet.protectedInputs.desired.retention);
        if (!this.options.zeroWorkObservation || !this.options.probe || !this.zeroWorkBaseline) fail('EVIDENCE_UNAVAILABLE');
        const probes: unknown[] = [];
        let currentLease = input.lease;
        let lastProbeMs = this.now();
        for (const role of ['preflight', 'paid'] as const) {
            const runtime = packet.protectedInputs.desired.runtime[role];
            const revision = this.desiredRevisionCandidate(packet, role);
            const resource = this.serviceResource(runtime);
            const probeLeaseCheck = this.leaseCheckFor(packet, currentLease, 'probe.malformed', resource);
            const authority = issueReceiverProbeAuthority({
                packet,
                role,
                ownerDigest: this.options.ownerDigest,
                lease: currentLease,
                leaseCheck: probeLeaseCheck,
            });
            await probeLeaseCheck();
            const probe = await this.options.probe({ role, runtime, revision, authority });
            currentLease = probeLeaseCheck.currentLease();
            if (!isObject(probe) || probe.status !== packet.probe.expectedStatuses[role] || probe.code !== packet.probe.expectedCodes[role]) fail('PROBE_FAILED');
            probes.push({ role, digest: canonicalDigest(probe) });
            lastProbeMs = this.now();
        }
        // Freeze the end of the pre-activation evidence window immediately
        // after the last provider-free probe.  The collector may need to wait
        // for ingestion, so it must not be handed a clock value that is later
        // reused as the validation boundary.
        const windowEndMs = this.now();
        if (!Number.isSafeInteger(windowEndMs) || windowEndMs < lastProbeMs || windowEndMs < this.zeroWorkBaseline.capturedAtMs) fail('EVIDENCE_UNAVAILABLE');
        const windowStartMs = this.zeroWorkBaseline.capturedAtMs;
        if (windowEndMs <= windowStartMs) fail('EVIDENCE_UNAVAILABLE');
        const zeroWork = await this.options.zeroWorkObservation({ windowStartMs, windowEndMs, nowMs: windowEndMs, baselineDigest: this.zeroWorkBaseline.digest });
        // Validate freshness at a new trusted boundary after the asynchronous
        // collector returns.  This accepts honest positive collector latency
        // without moving the covered interval beyond the last probe.
        const validationNowMs = this.now();
        if (!Number.isSafeInteger(validationNowMs) || validationNowMs < windowEndMs) fail('EVIDENCE_UNAVAILABLE');
        const expectedWindow = {
            windowStartMs,
            windowEndMs,
            provenance: Object.fromEntries(Object.entries(packet.protectedObservations.desired.zeroWorkSources).map(([name, source]) => [name, source.source])),
        } as never;
        validateZeroWorkObservation(zeroWork, validationNowMs, expectedWindow);
        return this.evidence('VERIFIED', { readiness, runtimes, queues, schedulers, policies, retention: canonicalDigest(retention), zeroWork: { digest: canonicalDigest(zeroWork), baselineDigest: this.zeroWorkBaseline.digest, windowStartMs, windowEndMs }, probes }, currentLease.lock.lockFence);
    }

    private async reconcileStaged(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const runtimes: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const revision = this.desiredRevisionCandidate(input.packet, role);
            const service = await this.options.cloudRun.getService(this.serviceResource(runtime));
            const stagedTraffic = service.traffic.find(entry => entry.revisionName === revision);
            if ((stagedTraffic !== undefined && stagedTraffic.percent !== 0)
                || (service.latestReadyRevision !== revision && service.latestCreatedRevision !== revision)) fail('RUNTIME_MISMATCH');
            const source = await this.readSource({ role, phase: 'desired', revision, runtime });
            const revisionObservation = await this.options.cloudRun.observeRevision(runtime.project, runtime.location, revision);
            const buildDigest = await this.readBuildDigest({ role, phase: 'desired', revision, image: revisionObservation.image });
            const observation = this.runtimeObservation(runtime, {
                ...revisionObservation,
                noTraffic: true,
                traffic: [],
                url: service.url,
            }, source.sourceSha, revision, 'STAGED', buildDigest);
            validateRuntimeObservation(observation, runtime, {
                mode: 'STAGED', revision,
                runtimeDigest: input.packet.desiredManifest.source[role].desiredRuntimeDigest,
                buildDigest: input.packet.desiredManifest.source[role].desiredBuildDigest,
            });
            runtimes.push({
                role,
                digest: canonicalDigest(observation),
                sourceSha: observation.sourceSha,
                runtimeDigest: observation.runtimeDigest,
                buildDigest: observation.buildDigest,
            });
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
            // QUEUES_ALIGNED is recorded immediately after the old auth chain
            // is paused and quiescent. Desired OIDC targets are not changed
            // until INVOKERS_ROTATED, so a resumed owner must reconcile the
            // exact OLD contracts rather than treating the desired packet as
            // a current provider state assertion.
            const queueInput = input.packet.protectedInputs.old.queues[role];
            const schedulerInput = input.packet.protectedInputs.old.schedulers[role];
            const queue = await this.options.workPlanes.observeQueue(queueInput);
            const desiredQueueInput = input.packet.protectedInputs.desired.queues[role];
            const queueTargetIsOld = queueTargetMatchesOrAbsent(queue.target, queueInput);
            const queueTargetIsDesired = queueTargetMatches(queue.target, desiredQueueInput.target)
                || (queue.target === null && !isObject(desiredQueueInput.configuration.httpTarget));
            if (!queueTargetIsOld && !queueTargetIsDesired) fail('OBSERVATION_RACE');
            // A target can be the exact desired postcondition when a writer
            // crashed after its PATCH but before INVOKERS_ROTATED append. The
            // queue remains otherwise governed by the durable OLD phase:
            // config, pause, emptiness, pagination and target identity are all
            // revalidated before the next phase re-proves IAM.
            const queueExpectation = queueTargetIsDesired
                ? { ...queueInput, target: desiredQueueInput.target }
                : queueInput;
            validateQueueObservation({ role, ...queue }, queueExpectation, input.packet.oldManifest.queues[role].configDigest, role);
            const scheduler = await this.options.workPlanes.observeScheduler(schedulerInput);
            const schedulerTargetIsOld = canonicalDigest(scheduler.target) === canonicalDigest(schedulerInput.target);
            const desiredSchedulerInput = input.packet.protectedInputs.desired.schedulers[role];
            const schedulerTargetIsDesired = canonicalDigest(scheduler.target) === canonicalDigest(desiredSchedulerInput.target);
            if (!schedulerTargetIsOld && !schedulerTargetIsDesired) fail('OBSERVATION_RACE');
            const schedulerExpectation = schedulerTargetIsDesired
                ? { ...schedulerInput, target: desiredSchedulerInput.target }
                : schedulerInput;
            validateSchedulerObservation({ role, ...scheduler, nowMs }, schedulerExpectation, nowMs, input.packet.quiescence.timeoutMs, input.packet.quiescence.graceMs, role);
            queues.push({ role, target: queue.target === null ? 'ABSENT' : queueTargetIsDesired ? 'DESIRED' : 'OLD', digest: canonicalDigest(queue) });
            schedulers.push({ role, target: schedulerTargetIsDesired ? 'DESIRED' : 'OLD', digest: canonicalDigest(scheduler) });
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
        let currentLease = input.lease;
        const alignments: unknown[] = [];
        // A crash can occur after IAM read-back or after either paused OIDC
        // target update but before the phase append. Reconciliation therefore
        // repeats the exact desired-target proof and adopts only the
        // idempotent postcondition; it never treats desired packet data as a
        // current provider observation.
        for (const role of ['preflight', 'paid'] as const) {
            const desiredScheduler = input.packet.protectedInputs.desired.schedulers[role];
            const oldScheduler = input.packet.protectedInputs.old.schedulers[role];
            const schedulerLeaseCheck = this.leaseCheckFor(input.packet, currentLease, 'scheduler.target', desiredScheduler.resource);
            await schedulerLeaseCheck();
            let scheduler = await this.options.workPlanes.observeScheduler(desiredScheduler);
            if (scheduler.state !== 'PAUSED') fail('SCHEDULER_NOT_QUIESCENT');
            if (canonicalDigest(scheduler.target) === canonicalDigest(oldScheduler.target)) {
                await schedulerLeaseCheck();
                scheduler = await this.options.workPlanes.updateSchedulerTarget({
                    input: desiredScheduler,
                    expectedOldTarget: oldScheduler.target,
                    desiredTarget: desiredScheduler.target,
                    leaseCheck: schedulerLeaseCheck,
                });
            } else if (canonicalDigest(scheduler.target) !== canonicalDigest(desiredScheduler.target)) {
                fail('OBSERVATION_RACE');
            }

            currentLease = schedulerLeaseCheck.currentLease();
            const desiredQueue = input.packet.protectedInputs.desired.queues[role];
            const oldQueue = input.packet.protectedInputs.old.queues[role];
            const queueLeaseCheck = this.leaseCheckFor(input.packet, currentLease, 'queue.target', desiredQueue.resource);
            await queueLeaseCheck();
            let queue = await this.options.workPlanes.observeQueue(desiredQueue);
            if (queue.state !== 'PAUSED') fail('QUEUE_NOT_EMPTY');
            const queueHasNoHttpTarget = queue.target === null && !isObject(desiredQueue.configuration.httpTarget);
            if (queueTargetMatches(queue.target, oldQueue.target)) {
                await queueLeaseCheck();
                queue = await this.options.workPlanes.updateQueueTarget({
                    input: desiredQueue,
                    expectedOldTarget: oldQueue.target,
                    desiredTarget: desiredQueue.target,
                    leaseCheck: queueLeaseCheck,
                });
            } else if (!queueTargetMatches(queue.target, desiredQueue.target) && !queueHasNoHttpTarget) {
                fail('OBSERVATION_RACE');
            }
            validateSchedulerObservation({ role, ...scheduler, nowMs: this.now() }, desiredScheduler, this.now(), input.packet.quiescence.timeoutMs, input.packet.quiescence.graceMs, role);
            validateQueueObservation({ role, ...queue }, desiredQueue, input.packet.desiredManifest.queues[role].configDigest, role);
            alignments.push({ role, scheduler: canonicalDigest(scheduler), queue: canonicalDigest(queue) });
            currentLease = queueLeaseCheck.currentLease();
        }
        return this.evidence('RECONCILE_INVOKERS_ROTATED', { policies, alignments }, currentLease.lock.lockFence);
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
                if (bindingsDigest(observed.bindings) !== bindingsDigest(expected)) fail('OBSERVATION_RACE');
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
        let currentLease = input.lease;
        const resources: unknown[] = [];
        if (this.options.closeAdmissionGates) {
            try {
                const gateLeaseCheck = this.leaseCheckFor(input.packet, currentLease, 'alias.assign', this.options.producerAlias);
                await gateLeaseCheck();
                await this.options.closeAdmissionGates(input);
                currentLease = gateLeaseCheck.currentLease();
                resources.push({ action: 'CLOSE_ADMISSION_GATES', result: 'OBSERVED' });
            } catch (error) {
                resources.push({ action: 'CLOSE_ADMISSION_GATES', result: error instanceof EpochError ? error.code : 'PROBE_FAILED' });
            }
        } else {
            resources.push({ action: 'CLOSE_ADMISSION_GATES', result: 'EVIDENCE_UNAVAILABLE' });
        }
        for (const role of ['preflight', 'paid'] as const) {
            const schedulerLeaseCheck = this.leaseCheckFor(input.packet, currentLease, 'scheduler.pause', input.packet.protectedInputs.desired.schedulers[role].resource);
            try {
                await schedulerLeaseCheck();
                await this.options.workPlanes.pauseScheduler(input.packet.protectedInputs.desired.schedulers[role], schedulerLeaseCheck);
                currentLease = schedulerLeaseCheck.currentLease();
                resources.push({ role, plane: 'scheduler', result: 'OBSERVED' });
            } catch (error) {
                currentLease = schedulerLeaseCheck.currentLease();
                resources.push({ role, plane: 'scheduler', result: error instanceof EpochError ? error.code : 'PROBE_FAILED' });
            }
            const queueLeaseCheck = this.leaseCheckFor(input.packet, currentLease, 'queue.pause', input.packet.protectedInputs.desired.queues[role].resource);
            try {
                await queueLeaseCheck();
                await this.options.workPlanes.pauseQueue(input.packet.protectedInputs.desired.queues[role], queueLeaseCheck);
                currentLease = queueLeaseCheck.currentLease();
                resources.push({ role, plane: 'queue', result: 'OBSERVED' });
            } catch (error) {
                currentLease = queueLeaseCheck.currentLease();
                resources.push({ role, plane: 'queue', result: error instanceof EpochError ? error.code : 'PROBE_FAILED' });
            }
        }
        return this.evidence('COMPENSATED', resources, currentLease.lock.lockFence);
    }

    async activate(): Promise<OperationEvidence> {
        // Gate mutation requires a separately reviewed Vercel deployment/env
        // channel not carried by this packet; refusing here prevents a live
        // coordinator from claiming ACTIVATED with an unreviewed endpoint.
        fail('ACTIVATION_AUTH_REQUIRED');
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

    private async ensureIamBindings(input: ProtectedIamInput, role: Role, expectedBindings: readonly ProtectedIamBinding[], leaseCheck: LeaseCheck): Promise<Readonly<{ resource: string; project: string; etag: string; bindings: readonly ProtectedIamBinding[] }>> {
        await leaseCheck();
        const observed = await this.options.iam.getPolicy(input);
        const missing = expectedBindings.filter(expected => !observed.bindings.some(actual => canonicalDigest(actual) === canonicalDigest(expected)));
        if (missing.length === 0) return observed;
        if (observed.etag !== input.etag) fail('OBSERVATION_RACE');
        await leaseCheck();
        return this.options.iam.addBindings({ ...input, etag: observed.etag }, missing, leaseCheck);
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

    private runtimeObservation(
        expected: ProtectedRuntimeInput,
        observed: Readonly<{ identity: ProtectedRuntimeInput['identity']; environment: Readonly<Record<string, string>>; secretReferences: Readonly<Record<string, string>>; settings: ProtectedRuntimeInput['settings']; noTraffic: boolean; generation: string; resourceVersion: string; traffic: readonly Readonly<{ revisionName: string | null; percent: number }>[]; url: string }>,
        sourceSha: string,
        revision: string,
        mode: 'STAGED' | 'PROMOTED',
        buildDigest: string,
    ): Record<string, unknown> {
        let observedOrigin: string;
        let expectedOrigin: string;
        try {
            observedOrigin = new URL(observed.url).origin;
            expectedOrigin = new URL(expected.target.url).origin;
        } catch {
            fail('RUNTIME_MISMATCH');
        }
        if (observedOrigin !== expectedOrigin) fail('RUNTIME_MISMATCH');
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
            runtimeDigest: canonicalRuntimeInputDigest(runtime),
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

/**
 * A queue without an httpTarget is a real provider state, not an implicit
 * target mismatch.  Accept it only when the reviewed configuration also
 * explicitly omits httpTarget; never synthesize or relabel an identity.
 */
function queueTargetMatchesOrAbsent(actual: unknown, expected: ProtectedQueueInput): boolean {
    return queueTargetMatches(actual, expected.target)
        || (actual === null && !isObject(expected.configuration.httpTarget));
}
