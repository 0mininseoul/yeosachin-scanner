import { createAuthenticatedGcsJournalStorage } from './gcs';
import { EpochJournal, type JournalStorage, validateEpochHeader } from './journal';
import { CloudRunAdapter } from './cloud-run';
import { IamAdapter } from './iam';
import { WorkPlaneClient } from './work-planes';
import {
    createGoogleProtectedTransport,
    createGoogleReceiverTokenProvider,
    FetchProtectedTransport,
    AuthenticatedProtectedTransport,
    type ProtectedTransport,
    type ReceiverTokenProvider,
} from './platform';
import { createVercelProtectedTransport, VercelAdapter } from './vercel';
import { EpochCoordinator, LiveEpochControlPlane, type LiveEpochControlPlaneOptions } from './coordinator';
import { issueCoordinatorCapability, readProtectedDescriptor, rejectDuplicateJsonKeys } from './packet';
import { canonicalDigest, epochFail, hasExactKeys, isObject, type CapacityEpochPacket, type EpochHeader, type Role, type ProtectedRuntimeInput } from './contracts';
import { LiveEvidenceCollector } from './live-evidence';
import { evidenceSelectorDigest, validateLiveZeroWorkSources, type LiveZeroWorkSources } from './live-evidence';
import { CloudBuildAdapter } from './cloud-build';

const DIGEST = /^[0-9a-f]{64}$/;
const PROJECT = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const RESOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const ALIAS = /^[A-Za-z0-9.-]{1,253}$/;
const MAX_BYTES = 1_048_576;
const IMAGE_DIGEST = /^[^\s\u0000-\u001f\u007f]{1,2048}@sha256:[0-9a-f]{64}$/;
const BODY_SOURCE_SHA = 'capacity.identity-epoch/source-sha';
const BODY_BUILD_DIGEST = 'capacity.identity-epoch/build-digest';
const BODY_IMAGE_DIGEST = 'capacity.identity-epoch/image-digest';

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
    /** Reviewed primary-source descriptors; null means evidence is unavailable. */
    zeroWorkEvidence: LiveZeroWorkSources | null;
    /** Optional private inherited Supabase service-role Bearer and apikey. */
    supabaseServiceRoleBearer?: string;
    supabaseApiKey?: string;
    /** Digest of the independently reviewed provider selector contract. */
    scopeDigest: string;
}>;

export type LiveBootstrap = Readonly<{
    coordinator: EpochCoordinator;
    controlPlane: LiveEpochControlPlane;
    journal: EpochJournal;
    missingEvidence: readonly string[];
}>;

const BOOTSTRAP_KEYS_BASE = [
    'packetDigest', 'ownerDigest', 'lockNamespace', 'bucket', 'publicReadinessUrl',
    'googleProjectId', 'vercelProjectId', 'vercelTeamId', 'vercelDeploymentId',
    'vercelExpectedOldDeploymentId', 'vercelProducerAlias', 'vercelToken', 'serviceBodies', 'zeroWorkEvidence', 'scopeDigest',
] as const;
const BOOTSTRAP_KEYS_WITH_SUPABASE_AUTH = [...BOOTSTRAP_KEYS_BASE.slice(0, -1), 'supabaseServiceRoleBearer', 'supabaseApiKey', 'scopeDigest'] as const;

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
    if (!isObject(value) || (!hasExactKeys(value, BOOTSTRAP_KEYS_BASE) && !hasExactKeys(value, BOOTSTRAP_KEYS_WITH_SUPABASE_AUTH))
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
        || !isObject(value.serviceBodies) || !hasExactKeys(value.serviceBodies, ['preflight', 'paid'])
        || (value.supabaseServiceRoleBearer !== undefined && (typeof value.supabaseServiceRoleBearer !== 'string' || value.supabaseServiceRoleBearer.length === 0 || value.supabaseServiceRoleBearer.length > 8192 || /[\u0000-\u001f\u007f]/.test(value.supabaseServiceRoleBearer)))
        || (value.supabaseApiKey !== undefined && (typeof value.supabaseApiKey !== 'string' || value.supabaseApiKey.length === 0 || value.supabaseApiKey.length > 8192 || /[\u0000-\u001f\u007f]/.test(value.supabaseApiKey)))
        || (value.zeroWorkEvidence !== null && !validateLiveZeroWorkSources(value.zeroWorkEvidence, value.googleProjectId))) fail('PROTECTED_INPUT_UNAVAILABLE');
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
    validateZeroWorkEvidenceBinding(packet, descriptor.zeroWorkEvidence);
}

/** Bind every concrete live selector to the packet before authenticated clients exist. */
function validateZeroWorkEvidenceBinding(packet: CapacityEpochPacket, sources: LiveZeroWorkSources | null): void {
    if (sources === null) return;
    const expected = packet.protectedObservations.desired.zeroWorkSources;
    if (packet.observationInputs.zeroWorkDigest !== canonicalDigest(expected)) fail('CAPABILITY_BINDING_MISMATCH');
    const expectedQueueResources = (['preflight', 'paid'] as const)
        .map(role => packet.protectedInputs.desired.queues[role].resource)
        .sort();
    const expectedReceiverRoutes = (['preflight', 'paid'] as const)
        .map(role => packet.protectedInputs.desired.runtime[role].target.url)
        .sort();
    for (const name of ['providerLedger', 'billingLedger', 'taskAudit', 'receiverLog'] as const) {
        const actual = sources[name];
        const target = expected[name];
        if (actual.source !== target.source || actual.lookbackMs !== target.lookbackMs
            || actual.selectorDigest !== target.selectorDigest || evidenceSelectorDigest(actual) !== target.selectorDigest) {
            fail('CAPABILITY_BINDING_MISMATCH');
        }
        if (actual.kind === 'cloud-logging') {
            if (name === 'taskAudit') {
                if (actual.queueResources === undefined
                    || [...actual.queueResources].sort().join('\n') !== expectedQueueResources.join('\n')) {
                    fail('CAPABILITY_BINDING_MISMATCH');
                }
            } else if (actual.receiverRoutes === undefined
                || [...actual.receiverRoutes].sort().join('\n') !== expectedReceiverRoutes.join('\n')) {
                fail('CAPABILITY_BINDING_MISMATCH');
            }
        }
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
    /** Low-level transports are injectable for provider-free adapter tests. */
    googleTransport?: AuthenticatedProtectedTransport;
    vercelTransport?: AuthenticatedProtectedTransport;
    vercelPublicTransport?: ProtectedTransport;
    evidenceTransport?: AuthenticatedProtectedTransport;
    receiverTransport?: ProtectedTransport;
    receiverTokenProvider?: ReceiverTokenProvider;
    supabaseTransport?: AuthenticatedProtectedTransport;
    /** PostgREST apikey inherited privately with the service-role Bearer path. */
    supabaseApiKey?: string;
}>;

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    return Object.keys(value).every(key => allowed.includes(key));
}

function runtimeEnvironmentDigest(runtime: ProtectedRuntimeInput): string {
    return canonicalDigest({ environment: runtime.environment, secretReferences: runtime.secretReferences });
}

/**
 * Validate the reviewed Cloud Run request body before constructing a live
 * mutation graph.  The annotations are an operator-reviewed bridge from the
 * body to packet source/build commitments; the image annotation additionally
 * binds the digest-pinned image bytes to the exact reviewed body.
 */
export function validateServiceBodies(
    packet: CapacityEpochPacket,
    serviceBodies: Readonly<Record<Role, Readonly<Record<string, unknown>>>>,
): void {
    if (!isObject(serviceBodies) || !hasExactKeys(serviceBodies, ['preflight', 'paid'])) fail('PROTECTED_INPUT_UNAVAILABLE');
    for (const role of ['preflight', 'paid'] as const) {
        const runtime = packet.protectedInputs.desired.runtime[role];
        const body = serviceBodies[role];
        if (!isObject(body) || !hasExactKeys(body, ['metadata', 'spec'])) fail('PROTECTED_INPUT_UNAVAILABLE');
        const metadata = body.metadata;
        const spec = body.spec;
        if (!isObject(metadata) || !exactKeys(metadata, ['name', 'generation', 'resourceVersion', 'labels', 'annotations'])
            || !isObject(spec) || !hasExactKeys(spec, ['template', 'traffic'])) fail('PROTECTED_INPUT_UNAVAILABLE');
        const template = spec.template;
        if (!isObject(template) || !hasExactKeys(template, ['metadata', 'spec'])) fail('PROTECTED_INPUT_UNAVAILABLE');
        const templateMetadata = template.metadata;
        const templateSpec = template.spec;
        if (!isObject(templateMetadata) || !exactKeys(templateMetadata, ['name', 'labels', 'annotations'])
            || !isObject(templateSpec) || !hasExactKeys(templateSpec, ['serviceAccountName', 'containerConcurrency', 'timeoutSeconds', 'containers'])) {
            fail('PROTECTED_INPUT_UNAVAILABLE');
        }
        if (templateSpec.serviceAccountName !== runtime.identity.identity
            || templateSpec.containerConcurrency !== runtime.settings.concurrency
            || templateSpec.timeoutSeconds !== runtime.settings.timeoutSeconds
            || !Array.isArray(templateSpec.containers) || templateSpec.containers.length !== 1) fail('CAPABILITY_BINDING_MISMATCH');
        const container = templateSpec.containers[0];
        if (!isObject(container) || !hasExactKeys(container, ['image', 'env', 'resources'])
            || typeof container.image !== 'string' || !IMAGE_DIGEST.test(container.image)
            || !Array.isArray(container.env) || !isObject(container.resources)) fail('CAPABILITY_BINDING_MISMATCH');
        const env: Record<string, string> = {};
        const secrets: Record<string, string> = {};
        for (const item of container.env) {
            if (!isObject(item) || typeof item.name !== 'string' || (typeof item.value !== 'string' && item.valueFrom === undefined)
                || (item.value !== undefined && item.valueFrom !== undefined)) fail('CAPABILITY_BINDING_MISMATCH');
            if (item.value !== undefined) {
                if (Object.prototype.hasOwnProperty.call(env, item.name) || Object.prototype.hasOwnProperty.call(secrets, item.name)) fail('CAPABILITY_BINDING_MISMATCH');
                env[item.name] = item.value as string;
            } else {
                if (!isObject(item.valueFrom) || !hasExactKeys(item.valueFrom, ['secretKeyRef']) || !isObject(item.valueFrom.secretKeyRef)
                    || !hasExactKeys(item.valueFrom.secretKeyRef, ['name', 'key'])
                    || typeof item.valueFrom.secretKeyRef.name !== 'string' || typeof item.valueFrom.secretKeyRef.key !== 'string') fail('CAPABILITY_BINDING_MISMATCH');
                const key = item.valueFrom.secretKeyRef.key;
                if (Object.prototype.hasOwnProperty.call(env, item.name) || Object.prototype.hasOwnProperty.call(secrets, item.name)) fail('CAPABILITY_BINDING_MISMATCH');
                secrets[item.name] = `${item.valueFrom.secretKeyRef.name}:${key}`;
            }
        }
        if (runtimeEnvironmentDigest({ ...runtime, environment: env, secretReferences: secrets }) !== runtimeEnvironmentDigest(runtime)) fail('CAPABILITY_BINDING_MISMATCH');
        const resources = container.resources;
        if (!hasExactKeys(resources, ['limits']) || !isObject(resources.limits)
            || !hasExactKeys(resources.limits, ['cpu', 'memory'])
            || resources.limits.cpu !== runtime.settings.cpu || resources.limits.memory !== runtime.settings.memory) fail('CAPABILITY_BINDING_MISMATCH');
        const annotations = templateMetadata.annotations;
        if (!isObject(annotations) || !exactKeys(annotations, ['autoscaling.knative.dev/maxScale', BODY_SOURCE_SHA, BODY_BUILD_DIGEST, BODY_IMAGE_DIGEST])
            || annotations['autoscaling.knative.dev/maxScale'] !== String(runtime.settings.maxInstances)
            || annotations[BODY_SOURCE_SHA] !== runtime.sourceSha
            || annotations[BODY_BUILD_DIGEST] !== packet.desiredManifest.source[role].desiredBuildDigest
            || annotations[BODY_IMAGE_DIGEST] !== canonicalDigest({ image: container.image })) fail('CAPABILITY_BINDING_MISMATCH');
        if (!Array.isArray(spec.traffic) || spec.traffic.length === 0) fail('CAPABILITY_BINDING_MISMATCH');
        const trafficRevisions = new Set<string>();
        for (const traffic of spec.traffic) {
            const percent = isObject(traffic) ? traffic.percent : undefined;
            if (!isObject(traffic) || !hasExactKeys(traffic, ['revisionName', 'percent', 'tag'])
                || typeof traffic.revisionName !== 'string' || !Number.isSafeInteger(percent)
                || (percent as number) < 0 || (percent as number) > 100 || (traffic.tag !== null && typeof traffic.tag !== 'string')
                || trafficRevisions.has(traffic.revisionName)) fail('CAPABILITY_BINDING_MISMATCH');
            trafficRevisions.add(traffic.revisionName);
        }
    }
}

function freezeServiceBodies<T>(value: T, seen = new WeakSet<object>()): T {
    if (typeof value !== 'object' || value === null || seen.has(value)) return value;
    seen.add(value);
    for (const child of Object.values(value as Record<string, unknown>)) freezeServiceBodies(child, seen);
    Object.freeze(value);
    return value;
}

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
    validateServiceBodies(packet, descriptor.serviceBodies);
    let supabaseTransport = bootstrapOptions.supabaseTransport;
    const supabaseApiKey = bootstrapOptions.supabaseApiKey ?? descriptor.supabaseApiKey;
    if (descriptor.zeroWorkEvidence !== null) {
        const bearer = descriptor.supabaseServiceRoleBearer;
        const validSecret = (value: unknown): value is string => typeof value === 'string'
            && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f\u007f]/.test(value);
        if (!validSecret(supabaseApiKey)) fail('EVIDENCE_UNAVAILABLE');
        if (!supabaseTransport) {
            if (!validSecret(bearer)) fail('EVIDENCE_UNAVAILABLE');
            const hosts = new Set<string>();
            for (const source of Object.values(descriptor.zeroWorkEvidence)) {
                if (source.kind !== 'supabase') continue;
                try {
                    const origin = new URL(source.origin);
                    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/' || origin.search || origin.hash) fail('EVIDENCE_UNAVAILABLE');
                    hosts.add(origin.hostname);
                } catch {
                    fail('EVIDENCE_UNAVAILABLE');
                }
            }
            if (hosts.size === 0) fail('EVIDENCE_UNAVAILABLE');
            supabaseTransport = new AuthenticatedProtectedTransport({
                transport: new FetchProtectedTransport(),
                tokenProvider: async () => bearer,
                additionalAllowedHosts: hosts,
            });
        }
    }
    const now = bootstrapOptions.now ?? (() => Date.now());
    const google = bootstrapOptions.googleTransport ?? createGoogleProtectedTransport();
    const vercelTransport = bootstrapOptions.vercelTransport
        ?? createVercelProtectedTransport({ tokenProvider: async () => descriptor.vercelToken });
    const cloudRun = new CloudRunAdapter({ transport: google });
    const iam = new IamAdapter({ transport: google });
    const workPlanes = new WorkPlaneClient({ transport: google, defaultPauseProvenance: true, now: bootstrapOptions.now });
    const vercel = new VercelAdapter({
        transport: vercelTransport,
        publicTransport: bootstrapOptions.vercelPublicTransport,
        publicReadinessOrigin: new URL(descriptor.publicReadinessUrl).origin,
    });
    const cloudBuild = new CloudBuildAdapter({
        transport: google,
        builds: { old: packet.protectedInputs.old.build, desired: packet.protectedInputs.desired.build },
        runtimes: packet.protectedInputs.desired.runtime,
    });
    const evidence = new LiveEvidenceCollector({
        cloudBuild,
        loggingTransport: bootstrapOptions.googleTransport ?? google,
        tasksTransport: google,
        supabaseTransport,
        supabaseApiKey,
        sources: descriptor.zeroWorkEvidence ?? undefined,
        receiverTransport: bootstrapOptions.receiverTransport,
        receiverTokenProvider: bootstrapOptions.receiverTokenProvider ?? createGoogleReceiverTokenProvider(),
        now,
    });
    const candidate = candidateHeader(packet, now);
    const storage = bootstrapOptions.storage ?? createAuthenticatedGcsJournalStorage({ bucket: descriptor.bucket });
    const header = bootstrapOptions.resolveRetainedHeader === false
        ? candidate
        : await resolveHeader(storage, candidate, now);
    const journal = new EpochJournal(storage, { header, now });
    const capability = issueCoordinatorCapability(packet, descriptor.ownerDigest);
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
        serviceBodies: freezeServiceBodies(descriptor.serviceBodies),
        journal,
        capability,
        ownerDigest: descriptor.ownerDigest,
        renewLease: (lease) => journal.renew(lease),
        sourceObservation: evidence.sourceObservation.bind(evidence),
        buildObservation: evidence.buildObservation.bind(evidence),
        zeroWorkBaseline: evidence.zeroWorkBaseline.bind(evidence),
        zeroWorkObservation: evidence.zeroWorkObservation.bind(evidence),
        probe: evidence.probe.bind(evidence),
        now,
    };
    const controlPlane = new LiveEpochControlPlane(options);
    const coordinator = new EpochCoordinator({ packet, journal, controlPlane, ownerDigest: descriptor.ownerDigest, capability, now });
    return {
        coordinator,
        controlPlane,
        journal,
        missingEvidence: descriptor.zeroWorkEvidence === null ? ['zeroWorkEvidence'] : [],
    };
}
