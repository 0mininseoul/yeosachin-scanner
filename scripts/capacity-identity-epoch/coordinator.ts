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
import { validateSourceObservation, validateRuntimeObservation, validateQueueObservation, validateSchedulerObservation, validateRetentionObservation, validateReadinessObservation, type RuntimeObservationExpectation } from './observations';
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
        this.packet = options.packet;
        this.journal = options.journal;
        this.controlPlane = options.controlPlane;
        this.ownerDigest = options.ownerDigest;
        this.capability = options.capability ?? issueCoordinatorCapability(options.packet, options.ownerDigest);
        assertCoordinatorCapability(options.packet, this.capability);
        this.now = options.now ?? (() => Date.now());
    }

    /** Runs the closed rollout through VERIFIED. It never invokes activation. */
    async runThroughVerified(): Promise<Readonly<{ state: 'VERIFIED'; lease: JournalLease; proofDigest: string }>> {
        await this.journal.ensureHeader();
        this.lease = await this.journal.acquire(this.ownerDigest);
        let state = await this.journal.readValidatedState(this.lease);
        if (state.aborted) fail('ABORTED_EPOCH');
        let reconciledFence: string | undefined;

        if (state.requiresReconciliation && state.state !== null) {
            const evidence = await this.controlPlane.reconcile({ packet: this.packet, lease: this.lease, state: state.state });
            validateEvidence(evidence);
            state = await this.journal.readValidatedState(this.lease);
            reconciledFence = state.activeFence;
            // Reconciliation is an observation barrier, not a synthetic state
            // append. The next transition records its fresh precondition.
            void evidence;
        }

        const verifiedIndex = STATES.indexOf('VERIFIED');
        let nextIndex = state.state === null ? 0 : STATES.indexOf(state.state) + 1;
        if (nextIndex > verifiedIndex) {
            if (state.state !== 'VERIFIED') fail('JOURNAL_INVALID');
            this.verifiedProofDigest = state.transitions[state.transitions.length - 1]?.proofDigest;
            if (!this.verifiedProofDigest) fail('NOT_VERIFIED');
            return { state: 'VERIFIED', lease: this.lease, proofDigest: this.verifiedProofDigest };
        }

        while (nextIndex <= verifiedIndex) {
            await this.journal.assertLive(this.lease);
            if (state.requiresReconciliation && reconciledFence !== state.activeFence) {
                const evidence = await this.controlPlane.reconcile({ packet: this.packet, lease: this.lease, state: state.state ?? 'PREPARED' });
                validateEvidence(evidence);
                reconciledFence = state.activeFence;
            }
            const target = STATE_OPERATIONS[nextIndex];
            if (!target) fail('JOURNAL_INVALID');
            const evidence = await this.runOperation(target, this.lease);
            const current = await this.journal.readValidatedState(this.lease);
            if (current.aborted || current.state !== (nextIndex === 0 ? null : STATES[nextIndex - 1])) fail('JOURNAL_INVALID');
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
            nextIndex += 1;
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
        if (!this.lease) {
            await this.journal.ensureHeader();
            this.lease = await this.journal.acquire(this.ownerDigest);
        }
        const state = await this.journal.readValidatedState(this.lease);
        if (state.aborted) fail('ABORTED_EPOCH');
        const evidence: OperationEvidence = {
            precondition: { state: state.state, fence: this.lease.lock.lockFence },
            mutation: { action: 'ABORTED', reasonCode },
            postcondition: { closed: true },
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
    deploymentId: string;
    producerAlias: string;
    serviceBodies: Readonly<Record<Role, Readonly<Record<string, unknown>>>>;
}>;

export class LiveEpochControlPlane implements EpochControlPlane {
    private readonly options: LiveEpochControlPlaneOptions;

    constructor(options: LiveEpochControlPlaneOptions) {
        this.options = options;
    }

    async prepare(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const packet = input.packet;
        const readiness = await this.options.vercel.readPublicReadiness({
            url: this.options.publicReadinessUrl,
            expected: {
                sourceSha: packet.desiredManifest.readiness.sourceSha,
                legacyTargetResource: packet.desiredManifest.readiness.legacyTargetResource,
                preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                preflightProducerConfigFingerprint: packet.desiredManifest.readiness.preflightFingerprint,
                paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                paidProducerConfigFingerprint: packet.desiredManifest.readiness.paidFingerprint,
                analysisV2AdmissionEnabled: false,
                earlybirdWebhookAutoAdmissionEnabled: false,
                ready: true,
            },
        });
        const services = await Promise.all(Object.values(packet.protectedInputs.old.runtime).map(runtime => this.options.cloudRun.getService(`projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`)));
        const queues = await Promise.all(Object.values(packet.protectedInputs.old.runtime).map((runtime, index) => {
            const role: Role = index === 0 ? 'preflight' : 'paid';
            return this.options.workPlanes.observeQueue(packet.protectedInputs.old.queues[role]);
        }));
        const schedulers = await Promise.all(Object.values(packet.protectedInputs.old.schedulers).map(scheduler => this.options.workPlanes.observeScheduler(scheduler)));
        return {
            precondition: { readiness, fence: input.lease.lock.lockFence },
            mutation: null,
            postcondition: { readiness: readiness.ready, services: services.map(item => item.rawDigest), queues: queues.map(item => item.configurationDigest), schedulers: schedulers.map(item => item.configurationDigest) },
            proof: { state: 'PREPARED' },
            nativeConcurrencyToken: services.map(item => ({ generation: item.generation, resourceVersion: item.resourceVersion })),
            resourceObservation: { services, queues, schedulers },
        };
    }

    async stage(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const staged: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const serviceResource = `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
            const before = await this.options.cloudRun.getService(serviceResource);
            const revision = this.desiredRevision(input.packet, role);
            const after = await this.options.cloudRun.stageRevision({ runtime, revision, expectedGeneration: before.generation, serviceBody: this.options.serviceBodies[role] });
            staged.push({ role, revision, generation: after.generation, digest: after.rawDigest });
        }
        return this.evidence('STAGED', staged, input.lease.lock.lockFence);
    }

    async closeAndAlignProducers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const aliases = await this.options.vercel.assignAlias({ projectId: this.options.projectId, deploymentId: this.options.deploymentId, alias: this.options.producerAlias });
        const deployment = await this.options.vercel.getDeployment({ projectId: this.options.projectId, deploymentId: this.options.deploymentId });
        if (deployment.sourceSha !== input.packet.desiredManifest.readiness.sourceSha) fail('SOURCE_INVALID');
        const readiness = await this.options.vercel.readPublicReadiness({
            url: this.options.publicReadinessUrl,
            expected: {
                sourceSha: input.packet.desiredManifest.readiness.sourceSha,
                legacyTargetResource: input.packet.desiredManifest.readiness.legacyTargetResource,
                preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                preflightProducerConfigFingerprint: input.packet.desiredManifest.readiness.preflightFingerprint,
                paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                paidProducerConfigFingerprint: input.packet.desiredManifest.readiness.paidFingerprint,
                analysisV2AdmissionEnabled: false,
                earlybirdWebhookAutoAdmissionEnabled: false,
                ready: true,
            },
        });
        return this.evidence('PRODUCERS_CLOSED_ALIGNED', { aliases, deployment, readiness }, input.lease.lock.lockFence);
    }

    async alignQueues(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const queues: unknown[] = [];
        const schedulers: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const schedulerInput = input.packet.protectedInputs.desired.schedulers[role];
            const queueInput = input.packet.protectedInputs.desired.queues[role];
            const scheduler = await this.options.workPlanes.observeScheduler(schedulerInput);
            const queue = await this.options.workPlanes.observeQueue(queueInput);
            const pausedScheduler = scheduler.state === 'PAUSED' ? scheduler : await this.options.workPlanes.pauseScheduler(schedulerInput);
            const pausedQueue = queue.state === 'PAUSED' ? queue : await this.options.workPlanes.pauseQueue(queueInput);
            if (pausedQueue.tasks.length !== 0) fail('QUEUE_NOT_EMPTY');
            schedulers.push(pausedScheduler);
            queues.push(pausedQueue);
        }
        return this.evidence('QUEUES_ALIGNED', { queues, schedulers }, input.lease.lock.lockFence);
    }

    async rotateInvokers(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const policies: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const iam = input.packet.protectedInputs.desired.iam[role];
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                const target = iam[kind];
                policies.push(await this.options.iam.addBindings(target, target.bindings));
            }
        }
        return this.evidence('INVOKERS_ROTATED', policies, input.lease.lock.lockFence);
    }

    async promote(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const promoted: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            const runtime = input.packet.protectedInputs.desired.runtime[role];
            const resource = `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
            const before = await this.options.cloudRun.getService(resource);
            const revision = this.desiredRevision(input.packet, role);
            promoted.push(await this.options.cloudRun.setTraffic({ resource, expectedGeneration: before.generation, expectedRevision: revision, expectedPercent: 100, traffic: [{ revisionName: revision, percent: 100 }] }));
        }
        return this.evidence('SERVICES_PROMOTED', promoted, input.lease.lock.lockFence);
    }

    async verify(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        return this.prepare(input);
    }

    async reconcile(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease; state: State }>): Promise<OperationEvidence> {
        return this.prepare(input);
    }

    async compensateActivation(input: Readonly<{ packet: CapacityEpochPacket; lease: JournalLease }>): Promise<OperationEvidence> {
        const resources: unknown[] = [];
        for (const role of ['preflight', 'paid'] as const) {
            resources.push(await this.options.workPlanes.pauseScheduler(input.packet.protectedInputs.desired.schedulers[role]));
            resources.push(await this.options.workPlanes.pauseQueue(input.packet.protectedInputs.desired.queues[role]));
        }
        return this.evidence('COMPENSATED', resources, input.lease.lock.lockFence);
    }

    async activate(): Promise<OperationEvidence> {
        // Gate mutation requires a separately reviewed Vercel deployment/env
        // channel not carried by this packet; refusing here prevents a live
        // coordinator from claiming ACTIVATED with an unreviewed endpoint.
        fail('ACTIVATION_AUTH_REQUIRED');
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
