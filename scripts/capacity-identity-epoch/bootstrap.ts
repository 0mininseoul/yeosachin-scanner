import { fstatSync, readSync } from 'node:fs';
import { createAuthenticatedGcsJournalStorage } from './gcs';
import { EpochJournal } from './journal';
import { CloudRunAdapter } from './cloud-run';
import { IamAdapter } from './iam';
import { WorkPlaneClient } from './work-planes';
import { createGoogleProtectedTransport } from './platform';
import { createVercelProtectedTransport, VercelAdapter } from './vercel';
import { EpochCoordinator, LiveEpochControlPlane, type LiveEpochControlPlaneOptions } from './coordinator';
import { issueCoordinatorCapability } from './packet';
import { canonicalDigest, EpochError, epochFail, hasExactKeys, isObject, type CapacityEpochPacket, type EpochHeader, type Role } from './contracts';

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
    projectId: string;
    teamId: string;
    deploymentId: string;
    expectedOldDeploymentId: string;
    producerAlias: string;
    vercelToken: string;
    serviceBodies: Readonly<Record<Role, Readonly<Record<string, unknown>>>>;
}>;

export type LiveBootstrap = Readonly<{
    coordinator: EpochCoordinator;
    controlPlane: LiveEpochControlPlane;
    journal: EpochJournal;
    missingEvidence: readonly string[];
}>;

const BOOTSTRAP_KEYS = [
    'packetDigest', 'ownerDigest', 'lockNamespace', 'bucket', 'publicReadinessUrl',
    'projectId', 'teamId', 'deploymentId', 'expectedOldDeploymentId', 'producerAlias',
    'vercelToken', 'serviceBodies',
] as const;

function fail(code: 'PROTECTED_INPUT_UNAVAILABLE' | 'ADAPTER_REQUEST_INVALID' | 'CAPABILITY_BINDING_MISMATCH' | 'EVIDENCE_UNAVAILABLE'): never {
    epochFail(code);
}

function readPrivateJson(fd: number): unknown {
    if (!Number.isInteger(fd) || fd < 0) fail('PROTECTED_INPUT_UNAVAILABLE');
    let stat;
    try { stat = fstatSync(fd); } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
    // Synchronous regular-file reads are deliberately used only for a bounded
    // inherited descriptor; FIFOs could block indefinitely and are rejected.
    if (!stat.isFile()
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
        || (stat.mode & 0o077) !== 0) fail('PROTECTED_INPUT_UNAVAILABLE');
    const chunks: Buffer[] = [];
    let total = 0;
    try {
        while (true) {
            const remaining = MAX_BYTES + 1 - total;
            if (remaining <= 0) fail('PROTECTED_INPUT_UNAVAILABLE');
            const chunk = Buffer.allocUnsafe(Math.min(65_536, remaining));
            const count = readSync(fd, chunk, 0, chunk.length, null);
            if (count === 0) break;
            total += count;
            if (total > MAX_BYTES) fail('PROTECTED_INPUT_UNAVAILABLE');
            chunks.push(chunk.subarray(0, count));
        }
    } catch (error) {
        if (error instanceof EpochError) throw error;
        fail('PROTECTED_INPUT_UNAVAILABLE');
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
}

export function loadProtectedLiveBootstrap(fd: number): ProtectedLiveBootstrapDescriptor {
    const value = readPrivateJson(fd);
    if (!isObject(value) || !hasExactKeys(value, BOOTSTRAP_KEYS)
        || typeof value.packetDigest !== 'string' || !DIGEST.test(value.packetDigest)
        || typeof value.ownerDigest !== 'string' || !DIGEST.test(value.ownerDigest)
        || typeof value.lockNamespace !== 'string' || value.lockNamespace.length === 0 || value.lockNamespace.length > 128
        || typeof value.bucket !== 'string' || !BUCKET.test(value.bucket)
        || typeof value.publicReadinessUrl !== 'string'
        || typeof value.projectId !== 'string' || !PROJECT.test(value.projectId)
        || typeof value.teamId !== 'string' || !RESOURCE_ID.test(value.teamId)
        || typeof value.deploymentId !== 'string' || !RESOURCE_ID.test(value.deploymentId)
        || typeof value.expectedOldDeploymentId !== 'string' || !RESOURCE_ID.test(value.expectedOldDeploymentId)
        || typeof value.producerAlias !== 'string' || !ALIAS.test(value.producerAlias)
        || typeof value.vercelToken !== 'string' || value.vercelToken.length === 0 || value.vercelToken.length > 8192
        || !isObject(value.serviceBodies) || !hasExactKeys(value.serviceBodies, ['preflight', 'paid'])) fail('PROTECTED_INPUT_UNAVAILABLE');
    for (const role of ['preflight', 'paid'] as const) {
        if (!isObject(value.serviceBodies[role]) || Object.keys(value.serviceBodies[role]).length === 0) fail('PROTECTED_INPUT_UNAVAILABLE');
    }
    let parsed: URL;
    try { parsed = new URL(value.publicReadinessUrl); } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash
        || parsed.pathname !== '/api/analysis/capacity/readiness') fail('PROTECTED_INPUT_UNAVAILABLE');
    return value as ProtectedLiveBootstrapDescriptor;
}

function validateBinding(packet: CapacityEpochPacket, descriptor: ProtectedLiveBootstrapDescriptor): void {
    if (descriptor.packetDigest !== canonicalDigest(packet)
        || descriptor.lockNamespace !== packet.lockNamespace) fail('CAPABILITY_BINDING_MISMATCH');
    const project = packet.protectedInputs.old.build.identity.project;
    if (descriptor.projectId !== project) fail('CAPABILITY_BINDING_MISMATCH');
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
export function buildLiveBootstrap(packet: CapacityEpochPacket, descriptor: ProtectedLiveBootstrapDescriptor): LiveBootstrap {
    validateBinding(packet, descriptor);
    const google = createGoogleProtectedTransport();
    const vercelTransport = createVercelProtectedTransport({ tokenProvider: async () => descriptor.vercelToken });
    const cloudRun = new CloudRunAdapter({ transport: google });
    const iam = new IamAdapter({ transport: google });
    const workPlanes = new WorkPlaneClient({ transport: google });
    const vercel = new VercelAdapter({
        transport: vercelTransport,
        publicReadinessOrigin: new URL(descriptor.publicReadinessUrl).origin,
    });
    const now = () => Date.now();
    const header: EpochHeader = {
        epochIdDigest: canonicalDigest(packet.epochId),
        capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest,
        desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest,
        sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: new Date(now()).toISOString(),
    };
    const storage = createAuthenticatedGcsJournalStorage({ bucket: descriptor.bucket });
    const journal = new EpochJournal(storage, { header, now });
    const options: LiveEpochControlPlaneOptions = {
        cloudRun,
        iam,
        workPlanes,
        vercel,
        publicReadinessUrl: descriptor.publicReadinessUrl,
        projectId: descriptor.projectId,
        teamId: descriptor.teamId,
        deploymentId: descriptor.deploymentId,
        expectedOldDeploymentId: descriptor.expectedOldDeploymentId,
        producerAlias: descriptor.producerAlias,
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

