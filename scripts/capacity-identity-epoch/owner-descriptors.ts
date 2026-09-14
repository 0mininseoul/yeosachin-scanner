import {
    canonicalDigest,
    epochFail,
    isDigest,
    isObject,
    type CapacityEpochPacket,
    type ProtectedProviderScope,
    type Role,
} from './contracts';
import {
    createProtectedPacket,
    deriveObservationInputDigests,
    validateEpochPacket,
    type ProtectedPacketInput,
} from './packet';
import {
    evidenceSelectorDigest,
    validateLiveZeroWorkSources,
    type LiveZeroWorkSources,
} from './live-evidence';
import {
    canonicalIdentityGraphProjection,
    type DesiredIdentityGraph,
} from './owner-preparation';
import type { ProtectedLiveBootstrapDescriptor } from './bootstrap';
import { validateServiceBodies } from './bootstrap';

const SAFE_TOKEN = /^[^\u0000-\u001f\u007f\s]{1,8192}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function fail(code: 'INVALID_PACKET' | 'PROTECTED_INPUT_UNAVAILABLE' | 'CAPABILITY_BINDING_MISMATCH' | 'EVIDENCE_UNAVAILABLE' | 'PROPOSAL_STALE' | 'OWNER_AUTH_UNAVAILABLE'): never {
    epochFail(code);
}

export type OwnerDescriptorAssemblyInput = Readonly<{
    /** An already-created packet from a fresh discovery pass. */
    packet?: CapacityEpochPacket;
    /** Or a packet seed; the packet is created and validated here. */
    packetSeed?: ProtectedPacketInput;
    ownerDigest: string;
    /** Optional owner-session Google token kept only in the inherited FD descriptor. */
    googleAccessToken?: string;
    vercelToken: string;
    serviceBodies: Readonly<Record<Role, Readonly<Record<string, unknown>>>>;
    zeroWorkEvidence: LiveZeroWorkSources | null;
    supabaseServiceRoleBearer?: string;
    supabaseApiKey?: string;
    /** Supplied by the identity policy; otherwise derived from packet slots. */
    identityGraph?: DesiredIdentityGraph;
}>;

export type OwnerDescriptors = Readonly<{
    packet: CapacityEpochPacket;
    bootstrap: ProtectedLiveBootstrapDescriptor;
    packetDigest: string;
    bootstrapDigest: string;
    scopeDigest: string;
    identityGraphDigest: string;
    proposalDigest: string;
}>;

export type TwoPassDescriptorProposal = Readonly<{
    first: OwnerDescriptors;
    second: OwnerDescriptors;
    proposalDigest: string;
}>;

function assertSafeToken(value: unknown, code: 'OWNER_AUTH_UNAVAILABLE' | 'PROTECTED_INPUT_UNAVAILABLE'): asserts value is string {
    if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) epochFail(code);
}

function packetFromInput(input: OwnerDescriptorAssemblyInput): CapacityEpochPacket {
    if ((input.packet === undefined) === (input.packetSeed === undefined)) fail('INVALID_PACKET');
    if (input.packet !== undefined) {
        validateEpochPacket(input.packet);
        return input.packet;
    }
    const seed = input.packetSeed!;
    const observationInputs = deriveObservationInputDigests(seed);
    return createProtectedPacket({ ...seed, observationInputs });
}

function scopeOf(packet: CapacityEpochPacket): ProtectedProviderScope {
    return packet.providerScope;
}

function identityGraphOf(packet: CapacityEpochPacket, input: OwnerDescriptorAssemblyInput): DesiredIdentityGraph {
    if (input.identityGraph !== undefined) {
        if (!isObject(input.identityGraph.build) || typeof input.identityGraph.build.identity !== 'string'
            || !isObject(input.identityGraph.slots)) fail('CAPABILITY_BINDING_MISMATCH');
        let graphSlotsDigest: string;
        try {
            graphSlotsDigest = canonicalDigest(input.identityGraph.slots);
        } catch {
            fail('CAPABILITY_BINDING_MISMATCH');
        }
        if (input.identityGraph.project !== packet.desiredManifest.build.project
            || input.identityGraph.build.identity !== packet.desiredManifest.build.identity
            || graphSlotsDigest !== canonicalDigest(packet.desiredManifest.roleSlots)) fail('CAPABILITY_BINDING_MISMATCH');
        return input.identityGraph;
    }
    const slots = Object.fromEntries((Object.keys(packet.desiredManifest.roleSlots) as Array<keyof typeof packet.desiredManifest.roleSlots>).map(slot => [slot, packet.desiredManifest.roleSlots[slot]])) as DesiredIdentityGraph['slots'];
    return {
        project: packet.desiredManifest.build.project,
        build: packet.desiredManifest.build,
        slots,
    };
}

function validateEvidence(packet: CapacityEpochPacket, evidence: LiveZeroWorkSources | null): void {
    if (evidence === null) return;
    const project = packet.providerScope.googleProjectId;
    if (!validateLiveZeroWorkSources(evidence, project)) fail('EVIDENCE_UNAVAILABLE');
    for (const source of Object.values(evidence)) {
        if (evidenceSelectorDigest(source) !== source.selectorDigest) fail('CAPABILITY_BINDING_MISMATCH');
    }
}

function validateAuthFields(input: OwnerDescriptorAssemblyInput): void {
    if (typeof input.ownerDigest !== 'string' || !DIGEST.test(input.ownerDigest)) fail('OWNER_AUTH_UNAVAILABLE');
    if (input.googleAccessToken !== undefined) assertSafeToken(input.googleAccessToken, 'OWNER_AUTH_UNAVAILABLE');
    assertSafeToken(input.vercelToken, 'OWNER_AUTH_UNAVAILABLE');
    for (const value of [input.supabaseServiceRoleBearer, input.supabaseApiKey]) {
        if (value !== undefined) assertSafeToken(value, 'OWNER_AUTH_UNAVAILABLE');
    }
    if (input.zeroWorkEvidence !== null
        && (input.supabaseServiceRoleBearer === undefined || input.supabaseApiKey === undefined)) fail('EVIDENCE_UNAVAILABLE');
}

function descriptorDigestProjection(value: OwnerDescriptors): Readonly<Record<string, unknown>> {
    return {
        packetDigest: value.packetDigest,
        bootstrapDigest: value.bootstrapDigest,
        scopeDigest: value.scopeDigest,
        identityGraphDigest: value.identityGraphDigest,
    };
}

function descriptorDigest(value: OwnerDescriptors): string {
    return canonicalDigest(descriptorDigestProjection(value));
}

/**
 * Assemble the packet and live bootstrap descriptor in memory. No file,
 * environment, journal, or logging API is used by this function.
 */
export function assembleOwnerDescriptors(input: OwnerDescriptorAssemblyInput): OwnerDescriptors {
    validateAuthFields(input);
    const packet = packetFromInput(input);
    const scope = scopeOf(packet);
    const scopeDigest = canonicalDigest(scope);
    validateEvidence(packet, input.zeroWorkEvidence);
    if (!isObject(input.serviceBodies)) fail('PROTECTED_INPUT_UNAVAILABLE');
    validateServiceBodies(packet, input.serviceBodies);
    const identityGraph = identityGraphOf(packet, input);
    const identityGraphDigest = canonicalDigest(canonicalIdentityGraphProjection(identityGraph));
    const bootstrap: ProtectedLiveBootstrapDescriptor = {
        packetDigest: canonicalDigest(packet),
        ownerDigest: input.ownerDigest,
        lockNamespace: packet.lockNamespace,
        ...scope,
        ...(input.googleAccessToken === undefined ? {} : { googleAccessToken: input.googleAccessToken }),
        vercelToken: input.vercelToken,
        serviceBodies: input.serviceBodies,
        zeroWorkEvidence: input.zeroWorkEvidence,
        ...(input.supabaseServiceRoleBearer === undefined ? {} : { supabaseServiceRoleBearer: input.supabaseServiceRoleBearer }),
        ...(input.supabaseApiKey === undefined ? {} : { supabaseApiKey: input.supabaseApiKey }),
        scopeDigest,
    };
    // The bootstrap loader enforces exact descriptor keys and packet/source
    // binding. Avoid opening an FD here, but retain a structural assertion for
    // every field that can be checked without a provider.
    if (bootstrap.packetDigest !== canonicalDigest(packet)
        || bootstrap.lockNamespace !== packet.lockNamespace
        || canonicalDigest({
            bucket: bootstrap.bucket,
            publicReadinessUrl: bootstrap.publicReadinessUrl,
            googleProjectId: bootstrap.googleProjectId,
            vercelProjectId: bootstrap.vercelProjectId,
            vercelTeamId: bootstrap.vercelTeamId,
            vercelDeploymentId: bootstrap.vercelDeploymentId,
            vercelExpectedOldDeploymentId: bootstrap.vercelExpectedOldDeploymentId,
            vercelProducerAlias: bootstrap.vercelProducerAlias,
        }) !== scopeDigest) fail('CAPABILITY_BINDING_MISMATCH');
    const packetDigest = canonicalDigest(packet);
    const bootstrapDigest = canonicalDigest({
        packetDigest,
        ownerDigest: input.ownerDigest,
        scopeDigest,
        serviceBodies: input.serviceBodies,
        zeroWorkSelectors: input.zeroWorkEvidence === null ? null : Object.fromEntries(Object.entries(input.zeroWorkEvidence).map(([name, source]) => [name, source.selectorDigest])),
        // Credential bytes are not included, but their digest binds two fresh
        // passes to the same in-memory owner session without exposing them.
        googleCredentialDigest: input.googleAccessToken === undefined ? null : canonicalDigest(input.googleAccessToken),
        vercelCredentialDigest: canonicalDigest(input.vercelToken),
        supabaseCredentialDigest: input.supabaseServiceRoleBearer === undefined ? null : canonicalDigest(input.supabaseServiceRoleBearer),
        supabaseApiKeyDigest: input.supabaseApiKey === undefined ? null : canonicalDigest(input.supabaseApiKey),
    });
    const assembled = Object.freeze({
        packet,
        bootstrap: Object.freeze(bootstrap),
        packetDigest,
        bootstrapDigest,
        scopeDigest,
        identityGraphDigest,
        proposalDigest: '',
    }) as OwnerDescriptors;
    return Object.freeze({ ...assembled, proposalDigest: descriptorDigest(assembled) });
}

/** JSON serialization is restricted to the parent-to-child anonymous pipe. */
export function serializeProtectedDescriptor(value: unknown): string {
    let raw: string;
    try { raw = JSON.stringify(value); } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
    if (typeof raw !== 'string' || raw.length === 0) fail('PROTECTED_INPUT_UNAVAILABLE');
    return raw;
}

/**
 * Two sequential provider-backed passes must agree on every safe proposal
 * digest before the epoch proposal is exposed to an operator.
 */
export async function buildTwoPassDescriptorProposal(options: Readonly<{
    readPass: () => Promise<OwnerDescriptorAssemblyInput>;
}>): Promise<TwoPassDescriptorProposal> {
    let firstInput: OwnerDescriptorAssemblyInput;
    let secondInput: OwnerDescriptorAssemblyInput;
    try {
        firstInput = await options.readPass();
        const first = assembleOwnerDescriptors(firstInput);
        secondInput = await options.readPass();
        const second = assembleOwnerDescriptors(secondInput);
        if (first.proposalDigest !== second.proposalDigest
            || first.packetDigest !== second.packetDigest
            || first.bootstrapDigest !== second.bootstrapDigest
            || first.scopeDigest !== second.scopeDigest
            || first.identityGraphDigest !== second.identityGraphDigest) fail('PROPOSAL_STALE');
        return Object.freeze({ first, second, proposalDigest: first.proposalDigest });
    } catch (error) {
        if (error instanceof Error && error.name === 'EpochError') throw error;
        fail('EVIDENCE_UNAVAILABLE');
    }
}

export function descriptorSafeSummary(value: OwnerDescriptors): Readonly<{
    proposalDigest: string;
    packetDigest: string;
    bootstrapDigest: string;
    scopeDigest: string;
    identityGraphDigest: string;
}> {
    return Object.freeze({
        proposalDigest: value.proposalDigest,
        packetDigest: value.packetDigest,
        bootstrapDigest: value.bootstrapDigest,
        scopeDigest: value.scopeDigest,
        identityGraphDigest: value.identityGraphDigest,
    });
}
