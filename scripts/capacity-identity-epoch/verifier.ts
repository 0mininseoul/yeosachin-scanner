import {
    canonicalDigest,
    canonicalRuntimeInputDigest,
    epochFail,
    isObject,
    type CapacityEpochPacket,
    type ProtectedRuntimeInput,
    type Role,
} from './contracts';
import { EpochJournal, type JournalLease } from './journal';
import { sharedReservationResources } from './coordinator';
import { CloudBuildAdapter } from './cloud-build';
import { CloudRunAdapter } from './cloud-run';
import { IamAdapter } from './iam';
import { WorkPlaneClient, type PauseProvenance } from './work-planes';
import { VercelAdapter } from './vercel';
import { LiveEvidenceCollector } from './live-evidence';
import { verifyProductionOutcome, type ProductionVerificationResult, type ProductionVerificationSnapshot } from './operator';
import { PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION, PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION } from '../../lib/services/analysis/legacy-analysis-public-readiness';

const ROLES = ['preflight', 'paid'] as const;
const IAM_KINDS = ['run', 'queue', 'taskCaller', 'maintenance'] as const;

export type LiveProductionVerifierOptions = Readonly<{
    packet: CapacityEpochPacket;
    journal: EpochJournal;
    cloudBuild: CloudBuildAdapter;
    cloudRun: CloudRunAdapter;
    iam: IamAdapter;
    workPlanes: WorkPlaneClient;
    vercel: VercelAdapter;
    evidence: LiveEvidenceCollector;
    publicReadinessUrl: string;
    now?: () => number;
    pauseProvenance?: (input: Readonly<{ resource: string; project: string; location: string; signal?: AbortSignal }>) => Promise<PauseProvenance>;
}>;

export type LiveProductionVerifier = Readonly<{
    verify: (lease?: JournalLease) => Promise<ProductionVerificationResult>;
}>;

function fail(code: 'EVIDENCE_UNAVAILABLE' | 'OBSERVATION_INVALID' | 'SOURCE_INVALID' | 'RUNTIME_MISMATCH' | 'SCHEDULER_NOT_QUIESCENT'): never {
    epochFail(code);
}

function desiredRevision(packet: CapacityEpochPacket, role: Role): string {
    const plan = packet.desiredManifest.source[role].revisionPlan;
    const suffix = packet.desiredManifest.source[role].desiredRevisionId
        ?? `${packet.desiredManifest.source[role].desiredSha.slice(0, 12)}${plan.suffix}`;
    return `${plan.prefix}${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
}

function serviceResource(runtime: ProtectedRuntimeInput): string {
    return `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
}

function runtimeObservation(expected: ProtectedRuntimeInput, observed: Readonly<{
    identity: ProtectedRuntimeInput['identity'];
    environment: Readonly<Record<string, string>>;
    secretReferences: Readonly<Record<string, string>>;
    settings: ProtectedRuntimeInput['settings'];
    noTraffic: boolean;
    generation: string;
    resourceVersion: string;
    traffic: readonly Readonly<{ revisionName: string | null; percent: number }>[];
    url: string;
}>, sourceSha: string, revision: string, buildDigest: string): Record<string, unknown> {
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
        mode: 'PROMOTED',
        revision,
        generation: observed.generation,
        resourceVersion: observed.resourceVersion,
        runtimeDigest: canonicalRuntimeInputDigest(runtime),
        buildDigest,
        traffic,
    };
}

function readinessExpected(packet: CapacityEpochPacket) {
    const expected = packet.desiredManifest.readiness;
    return {
        sourceSha: expected.sourceSha,
        legacyTargetResource: expected.legacyTargetResource,
        preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        preflightProducerConfigFingerprint: expected.preflightFingerprint,
        paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        paidProducerConfigFingerprint: expected.paidFingerprint,
        analysisV2AdmissionEnabled: false,
        earlybirdWebhookAutoAdmissionEnabled: false,
        ready: true,
    } as const;
}

function safeReadiness(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
    return {
        schemaVersion: value.schemaVersion,
        sourceSha: value.sourceSha,
        legacyTargetResource: value.legacyTargetResource,
        preflightFingerprint: value.preflightProducerConfigFingerprint,
        paidFingerprint: value.paidProducerConfigFingerprint,
        analysisV2AdmissionEnabled: value.analysisV2AdmissionEnabled,
        earlybirdWebhookAutoAdmissionEnabled: value.earlybirdWebhookAutoAdmissionEnabled,
        ready: value.ready,
    };
}

/**
 * Build an independent read-only post-read verifier from the same concrete
 * adapters as the live graph. It does not call coordinator.verify, does not
 * mutate any provider resource, and only returns fixed safe status markers.
 */
export function createLiveProductionVerifier(options: LiveProductionVerifierOptions): LiveProductionVerifier {
    const now = options.now ?? (() => Date.now());
    return Object.freeze({
        verify: async (lease?: JournalLease) => verifyProductionOutcome({
            packet: options.packet,
            read: async (): Promise<ProductionVerificationSnapshot> => {
                const state = await options.journal.readValidatedState(lease);
                if (state.state !== 'VERIFIED' || state.aborted || state.requiresReconciliation) fail('EVIDENCE_UNAVAILABLE');
                const source: Record<Role, unknown> = {} as Record<Role, unknown>;
                const runtime: Record<Role, unknown> = {} as Record<Role, unknown>;
                const queues: Record<Role, unknown> = {} as Record<Role, unknown>;
                const schedulers: Record<Role, unknown> = {} as Record<Role, unknown>;
                const pauseProvenance: Record<Role, unknown> = {} as Record<Role, unknown>;
                const iam: Record<Role, Record<typeof IAM_KINDS[number], unknown>> = {} as Record<Role, Record<typeof IAM_KINDS[number], unknown>>;
                for (const role of ROLES) {
                    const revision = desiredRevision(options.packet, role);
                    source[role] = await options.cloudBuild.sourceObservation({ role, phase: 'desired', revision, runtime: options.packet.protectedInputs.desired.runtime[role] });
                    const service = await options.cloudRun.getService(serviceResource(options.packet.protectedInputs.desired.runtime[role]));
                    const buildDigest = await options.cloudBuild.buildObservation({ role, phase: 'desired', revision, image: service.image });
                    runtime[role] = runtimeObservation(options.packet.protectedInputs.desired.runtime[role], service, source[role] && isObject(source[role]) && typeof source[role].sourceSha === 'string' ? source[role].sourceSha : '', revision, buildDigest);
                    const queue = await options.workPlanes.observeQueue(options.packet.protectedInputs.desired.queues[role]);
                    queues[role] = { role, ...queue };
                    const scheduler = await options.workPlanes.observeScheduler(options.packet.protectedInputs.desired.schedulers[role]);
                    schedulers[role] = { role, ...scheduler, nowMs: now() };
                    if (!options.pauseProvenance) fail('EVIDENCE_UNAVAILABLE');
                    pauseProvenance[role] = await options.pauseProvenance({
                        resource: options.packet.protectedInputs.desired.schedulers[role].resource,
                        project: options.packet.protectedInputs.desired.schedulers[role].project,
                        location: options.packet.protectedInputs.desired.schedulers[role].location,
                    });
                    iam[role] = {} as Record<typeof IAM_KINDS[number], unknown>;
                    for (const kind of IAM_KINDS) {
                        const policy = await options.iam.getPolicy(options.packet.protectedInputs.desired.iam[role][kind]);
                        iam[role][kind] = { role, ...policy };
                    }
                }
                const retention = await options.workPlanes.observeRetention(options.packet.protectedInputs.desired.retention);
                const readiness = safeReadiness(await options.vercel.readPublicReadiness({ url: options.publicReadinessUrl, expected: readinessExpected(options.packet) }));
                const baseline = await options.journal.readEvidenceBaseline(lease);
                if (!baseline) fail('EVIDENCE_UNAVAILABLE');
                const verificationNow = now();
                const zeroWork = await options.evidence.zeroWorkObservation({
                    windowStartMs: baseline.capturedAtMs,
                    windowEndMs: verificationNow,
                    nowMs: verificationNow,
                    baselineDigest: baseline.digest,
                });
                const validationNow = now();
                // Re-read the journal/epoch lock after every provider fact. A
                // takeover during this read pass must invalidate the snapshot,
                // even when no new transition has appeared yet.
                const finalState = await options.journal.readValidatedState(lease);
                if (finalState.state !== 'VERIFIED' || finalState.aborted || finalState.requiresReconciliation
                    || finalState.activeFence !== state.activeFence
                    || finalState.transitions.length !== state.transitions.length
                    || canonicalDigest(finalState.transitions) !== canonicalDigest(state.transitions)) fail('EVIDENCE_UNAVAILABLE');
                const lock = await options.journal.readCurrentLockState();
                const sharedReservation = await options.journal.inspectSharedReservation(sharedReservationResources(options.packet));
                return {
                    journal: {
                        state: finalState.state,
                        transitions: finalState.transitions.map(transition => ({ toState: transition.toState, resultCode: transition.resultCode })),
                        activation: finalState.transitions.some(transition => transition.toState === 'ACTIVATED'),
                        resumed: false,
                        gatesOpen: readiness.analysisV2AdmissionEnabled === true || readiness.earlybirdWebhookAutoAdmissionEnabled === true,
                        requiresReconciliation: finalState.requiresReconciliation,
                        lock,
                        sharedReservation,
                    },
                    facts: {
                        source, runtime, queues, schedulers, pauseProvenance, iam,
                        retention, readiness, zeroWork, zeroWorkNowMs: validationNow,
                    },
                };
            },
        }),
    });
}
