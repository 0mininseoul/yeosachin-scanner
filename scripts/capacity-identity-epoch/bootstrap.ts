import { createAuthenticatedGcsJournalStorage } from './gcs';
import { EpochJournal, type JournalStorage, validateEpochHeader } from './journal';
import { CloudRunAdapter } from './cloud-run';
import { IamAdapter } from './iam';
import { WorkPlaneClient } from './work-planes';
import { createGoogleProtectedTransport } from './platform';
import { createVercelProtectedTransport, VercelAdapter } from './vercel';
import { EpochCoordinator, LiveEpochControlPlane, type LiveEpochControlPlaneOptions } from './coordinator';
import { issueCoordinatorCapability, readProtectedDescriptor, rejectDuplicateJsonKeys } from './packet';
import { canonicalDigest, epochFail, hasExactKeys, isObject, type CapacityEpochPacket, type EpochHeader, type Role } from './contracts';

const DIGEST = /^[0-9a-f]{64}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const ALIAS = /^[A-Za-z0-9.-]{1,253}$/;
const MAX_BYTES = 1_048_576;

/**
 * Protected, operator-supplied live bootstrap material.  It is read only
 * from a private descriptor and is never copied to ordinary output.  The
 * descriptor binds all provider/resource selectors to the packet before any
 * authenticated client is constructed.
 */
export type ProtectedLiveBootstrapDescriptor = Readonly<{
    packetDigest: string;
    ownerDigest: string;
    lockNamespace: string;
    bucket: string;
    publicReadinessUrl: string;
    /** Google project/resource namespace; must match the protected packet. */
    googleProjectId: string;
    /** Vercel project namespace; intentionally independent from Google. */
    vercelProjectId: string;
    vercelTeamId: string;
    vercelDeploymentId: string;
    vercelExpectedOldDeploymentId: string;
    vercelProducerAlias: string;
    vercelToken: string;
    serviceBodies: Readonly<Record<Role, Readonly<Record<string, unknown>>>>;
    /** Digest of the independently reviewed provider selector contract. */
    scopeDigest: string;
}>;

export type LiveBootstrap = Readonly<{
    coordinator: EpochCoordinator;
    controlPlane: LiveEpochControlPlane;
    journal: EpochJournal;
    missingEvidence: readonly string[];
}>;

const BOOTSTRAP_KEYS = [
    'packetDigest', 'ownerDigest', 'lockNamespace', 'bucket', 'publicReadinessUrl',
    'googleProjectId', 'vercelProjectId', 'vercelTeamId', 'vercelDeploymentId',
    'vercelExpectedOldDeploymentId', 'vercelProducerAlias', 'vercelToken', 'serviceBodies', 'scopeDigest',
] as const;

function fail(code: 'PROTECTED_INPUT_UNAVAILABLE' | 'ADAPTER_REQUEST_INVALID' | 'CAPABILITY_BINDING_MISMATCH' | 'EVIDENCE_UNAVAILABLE' | 'JOURNAL_INVALID'): never {
    epochFail(code);
}

function providerScope(descriptor: Pick<ProtectedLiveBootstrapDescriptor,
    'bucket' | 'publicReadinessUrl' | 'googleProjectId' | 'vercelProjectId' | 'vercelTeamId'
    | 'vercelDeploymentId' | 'vercelExpectedOldDeploymentId' | 'vercelProducerAlias'>): Readonly<Record<string, string>> {
    return {
        bucket: descriptor.bucket,
        publicReadinessUrl: descriptor.publicReadinessUrl,
        googleProjectId: descriptor.googleProjectId,
        vercelProjectId: descriptor.vercelProjectId,
        vercelTeamId: descriptor.vercelTeamId,
        vercelDeploymentId: descriptor.vercelDeploymentId,
        vercelExpectedOldDeploymentId: descriptor.vercelExpectedOldDeploymentId,
        vercelProducerAlias: descriptor.vercelProducerAlias,
    };
}

function validateProviderScope(descriptor: ProtectedLiveBootstrapDescriptor): void {
    if (canonicalDigest(providerScope(descriptor)) !== descriptor.scopeDigest) fail('CAPABILITY_BINDING_MISMATCH');
}

async function readPrivateJson(fd: number): Promise<unknown> {
    const raw = await readProtectedDescriptor(fd, MAX_BYTES);
    rejectDuplicateJsonKeys(raw);
    try { return JSON.parse(raw) as unknown; } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
}

export async function loadProtectedLiveBootstrap(fd: number): Promise<ProtectedLiveBootstrapDescriptor> {
    const value = await readPrivateJson(fd);
    if (!isObject(value) || !hasExactKeys(value, BOOTSTRAP_KEYS)
        || typeof value.packetDigest !== 'string' || !DIGEST.test(value.packetDigest)
        || typeof value.ownerDigest !== 'string' || !DIGEST.test(value.ownerDigest)
        || typeof value.lockNamespace !== 'string' || value.lockNamespace.length === 0 || value.lockNamespace.length > 128
        || typeof value.bucket !== 'string' || !BUCKET.test(value.bucket)
        || typeof value.publicReadinessUrl !== 'string'
        || typeof value.googleProjectId !== 'string' || !PROJECT.test(value.googleProjectId)
        || typeof value.vercelProjectId !== 'string' || !RESOURCE_ID.test(value.vercelProjectId)
        || typeof value.vercelTeamId !== 'string' || !RESOURCE_ID.test(value.vercelTeamId)
        || typeof value.vercelDeploymentId !== 'string' || !RESOURCE_ID.test(value.vercelDeploymentId)
        || typeof value.vercelExpectedOldDeploymentId !== 'string' || !RESOURCE_ID.test(value.vercelExpectedOldDeploymentId)
        || typeof value.vercelProducerAlias !== 'string' || !ALIAS.test(value.vercelProducerAlias)
        || typeof value.vercelToken !== 'string' || value.vercelToken.length === 0 || value.vercelToken.length > 8192
        || typeof value.scopeDigest !== 'string' || !DIGEST.test(value.scopeDigest)
        || !isObject(value.serviceBodies) || !hasExactKeys(value.serviceBodies, ['preflight', 'paid'])) fail('PROTECTED_INPUT_UNAVAILABLE');
    for (const role of ['preflight', 'paid'] as const) {
        if (!isObject(value.serviceBodies[role]) || Object.keys(value.serviceBodies[role]).length === 0) fail('PROTECTED_INPUT_UNAVAILABLE');
    }
    let parsed: URL;
    try { parsed = new URL(value.publicReadinessUrl); } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
        || parsed.pathname !== '/api/analysis/capacity/readiness') fail('PROTECTED_INPUT_UNAVAILABLE');
    const descriptor = value as ProtectedLiveBootstrapDescriptor;
    validateProviderScope(descriptor);
    return descriptor;
}

function validateBinding(packet: CapacityEpochPacket, descriptor: ProtectedLiveBootstrapDescriptor): void {
    if (descriptor.packetDigest !== canonicalDigest(packet)
        || descriptor.lockNamespace !== packet.lockNamespace) fail('CAPABILITY_BINDING_MISMATCH');
    // The descriptor's self-attested scope digest is not sufficient: a caller
    // must not be able to retarget a valid packet by changing selectors and
    // recomputing that digest. The reviewed packet carries the canonical
    // provider selector contract independently of live observations.
    if (canonicalDigest(packet.providerScope) !== descriptor.scopeDigest) fail('CAPABILITY_BINDING_MISMATCH');
    const project = packet.protectedInputs.old.build.identity.project;
    if (descriptor.googleProjectId !== project) fail('CAPABILITY_BINDING_MISMATCH');
    for (const role of ['preflight', 'paid'] as const) {
        const runtime = packet.protectedInputs.desired.runtime[role];
        if (runtime.project !== project || packet.protectedInputs.desired.queues[role].project !== project
            || packet.protectedInputs.desired.schedulers[role].project !== project) fail('CAPABILITY_BINDING_MISMATCH');
    }
}

/**
 * Construct the real protected control-plane graph.  Evidence collectors are
 * intentionally not replaced with callbacks or packet assertions: until the
 * reviewed source/build/ledger/probe channels are supplied, the returned
 * graph exposes a fixed missing-evidence list and the coordinator remains
 * unable to claim PREPARED or VERIFIED.
 */
export type LiveBootstrapOptions = Readonly<{
    /** Provider-free tests inject storage; production defaults to authenticated GCS. */
    storage?: JournalStorage;
    now?: () => number;
    /** `check` deliberately avoids a GCS read; apply/resume adopts a retained header. */
    resolveRetainedHeader?: boolean;
}>;

function candidateHeader(packet: CapacityEpochPacket, now: () => number): EpochHeader {
    return {
        epochIdDigest: canonicalDigest(packet.epochId),
        capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest,
        desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest,
        sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: new Date(now()).toISOString(),
    };
}

async function resolveHeader(storage: JournalStorage, candidate: EpochHeader, now: () => number): Promise<EpochHeader> {
    const candidateJournal = new EpochJournal(storage, { header: candidate, now });
    const existing = await storage.get(candidateJournal.headerKey);
    if (!existing) return candidate;
    if (!/^[1-9][0-9]*$/.test(existing.generation)) fail('JOURNAL_INVALID');
    validateEpochHeader(existing.value);
    const retained = existing.value as EpochHeader;
    if (retained.epochIdDigest !== candidate.epochIdDigest
        || retained.capabilityDigest !== candidate.capabilityDigest
        || retained.oldManifestDigest !== candidate.oldManifestDigest
        || retained.desiredManifestDigest !== candidate.desiredManifestDigest
        || retained.roleSetDigest !== candidate.roleSetDigest
        || retained.sourcePlanDigest !== candidate.sourcePlanDigest) fail('JOURNAL_INVALID');
    return retained;
}

export async function buildLiveBootstrap(
    packet: CapacityEpochPacket,
    descriptor: ProtectedLiveBootstrapDescriptor,
    bootstrapOptions: LiveBootstrapOptions = {},
): Promise<LiveBootstrap> {
    validateBinding(packet, descriptor);
    validateProviderScope(descriptor);
    const google = createGoogleProtectedTransport();
    const vercelTransport = createVercelProtectedTransport({ tokenProvider: async () => descriptor.vercelToken });
    const cloudRun = new CloudRunAdapter({ transport: google });
    const iam = new IamAdapter({ transport: google });
    const workPlanes = new WorkPlaneClient({ transport: google });
    const vercel = new VercelAdapter({
        transport: vercelTransport,
        publicReadinessOrigin: new URL(descriptor.publicReadinessUrl).origin,
    });
    const now = bootstrapOptions.now ?? (() => Date.now());
    const candidate = candidateHeader(packet, now);
    const storage = bootstrapOptions.storage ?? createAuthenticatedGcsJournalStorage({ bucket: descriptor.bucket });
    const header = bootstrapOptions.resolveRetainedHeader === false
        ? candidate
        : await resolveHeader(storage, candidate, now);
    const journal = new EpochJournal(storage, { header, now });
    const options: LiveEpochControlPlaneOptions = {
        cloudRun,
        iam,
        workPlanes,
        vercel,
        publicReadinessUrl: descriptor.publicReadinessUrl,
        projectId: descriptor.vercelProjectId,
        teamId: descriptor.vercelTeamId,
        deploymentId: descriptor.vercelDeploymentId,
        expectedOldDeploymentId: descriptor.vercelExpectedOldDeploymentId,
        producerAlias: descriptor.vercelProducerAlias,
        serviceBodies: descriptor.serviceBodies,
        journal,
        now,
    };
    const controlPlane = new LiveEpochControlPlane(options);
    const capability = issueCoordinatorCapability(packet, descriptor.ownerDigest);
    const coordinator = new EpochCoordinator({ packet, journal, controlPlane, ownerDigest: descriptor.ownerDigest, capability, now });
    return {
        coordinator,
        controlPlane,
        journal,
        missingEvidence: ['sourceObservation', 'buildObservation', 'pauseProvenance', 'zeroWorkBaseline', 'zeroWorkObservation', 'probe'],
    };
}
