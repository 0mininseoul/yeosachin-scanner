import { epochFail, canonicalDigest, type CapacityEpochPacket, isDigest, isObject } from './contracts';
import { assertCoordinatorCapability, type CoordinatorCapability } from './packet';
import { EpochJournal, type JournalLease } from './journal';

/**
 * Operation-local owner/fence capability.  The registry is intentionally
 * module-private: a copied function, an arbitrary async no-op, or a callback
 * reconstructed from packet data is not an adapter authority.
 */
export type LeaseCheck = () => Promise<void>;

const issued = new WeakSet<object>();
const bindings = new WeakMap<object, Readonly<{
    packetDigest: string;
    epochId: string;
    roleSetDigest: string;
    lockNamespace: string;
    ownerDigest: string;
    lockFence: string;
    resources: readonly string[];
    operations: readonly string[];
}>>();

const GENERATION = /^[1-9][0-9]*$/;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]{1,512}$/;

function validateOperation(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !SAFE_TEXT.test(value)) epochFail('CAPABILITY_INVALID');
}

function validateResource(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !SAFE_TEXT.test(value)) epochFail('CAPABILITY_INVALID');
}

function validateLease(lease: JournalLease, journal: EpochJournal, ownerDigest: string): void {
    if (!isObject(lease) || typeof lease.generation !== 'string' || !GENERATION.test(lease.generation)
        || !isObject(lease.lock) || lease.lock.epochHeaderDigest !== journal.epochHeaderDigest
        || lease.lock.ownerDigest !== ownerDigest || typeof lease.lock.lockFence !== 'string'
        || !GENERATION.test(lease.lock.lockFence)) epochFail('CAPABILITY_BINDING_MISMATCH');
}

function validatePacketHeader(packet: CapacityEpochPacket, journal: EpochJournal): void {
    const header = journal.epochHeader;
    if (header.epochIdDigest !== canonicalDigest(packet.epochId)
        || header.capabilityDigest !== packet.capabilityDigest
        || header.oldManifestDigest !== packet.oldManifestDigest
        || header.desiredManifestDigest !== packet.desiredManifestDigest
        || header.roleSetDigest !== packet.roleSetDigest
        || header.sourcePlanDigest !== packet.sourcePlanDigest
        || canonicalDigest(header) !== journal.epochHeaderDigest) epochFail('CAPABILITY_BINDING_MISMATCH');
}

function serviceResource(runtime: Readonly<{ project: string; location: string; service: string }>): string {
    return `projects/${runtime.project}/locations/${runtime.location}/services/${runtime.service}`;
}

function packetResourceScope(packet: CapacityEpochPacket): ReadonlySet<string> {
    const resources = new Set<string>([packet.providerScope.vercelProducerAlias]);
    for (const inputs of [packet.protectedInputs.old, packet.protectedInputs.desired]) {
        for (const role of ['preflight', 'paid'] as const) {
            resources.add(serviceResource(inputs.runtime[role]));
            resources.add(inputs.queues[role].resource);
            resources.add(inputs.schedulers[role].resource);
            for (const kind of ['run', 'queue', 'taskCaller', 'maintenance'] as const) {
                resources.add(inputs.iam[role][kind].resource);
            }
        }
        resources.add(inputs.retention.resource);
    }
    return resources;
}

function immutableLease(lease: JournalLease): JournalLease {
    return Object.freeze({
        generation: lease.generation,
        lock: Object.freeze({ ...lease.lock }),
    });
}

export type BoundLeaseCheck = LeaseCheck & { currentLease: () => JournalLease };

/**
 * Issue a capability only from the validated coordinator graph.  The
 * provider adapters never receive an arbitrary callback: the packet,
 * coordinator capability, owner, namespace, operation and real journal are
 * bound before the closure enters the registry.
 */
export function issueLeaseCheck(context: Readonly<{
    packet: CapacityEpochPacket;
    capability: CoordinatorCapability;
    ownerDigest: string;
    lease: JournalLease;
    operation: string | readonly string[];
    resource: string | readonly string[];
    journal: EpochJournal;
    renew?: boolean;
    onRenew?: (lease: JournalLease) => void;
}>): BoundLeaseCheck {
    if (!(context.journal instanceof EpochJournal)
        || typeof context.ownerDigest !== 'string' || !isDigest(context.ownerDigest)) epochFail('CAPABILITY_INVALID');
    const operations = typeof context.operation === 'string' ? [context.operation] : [...context.operation];
    if (operations.length === 0) epochFail('CAPABILITY_INVALID');
    for (const operation of operations) validateOperation(operation);
    const resources = typeof context.resource === 'string' ? [context.resource] : [...context.resource];
    if (resources.length === 0) epochFail('CAPABILITY_INVALID');
    for (const resource of resources) validateResource(resource);
    assertCoordinatorCapability(context.packet, context.capability, context.ownerDigest);
    validatePacketHeader(context.packet, context.journal);
    validateLease(context.lease, context.journal, context.ownerDigest);
    const scopedResources = packetResourceScope(context.packet);
    if (resources.some(resource => !scopedResources.has(resource))) epochFail('CAPABILITY_BINDING_MISMATCH');
    const initialOwnerDigest = context.ownerDigest;
    const initialFence = context.lease.lock.lockFence;
    const initialHeaderDigest = context.lease.lock.epochHeaderDigest;
    let current = immutableLease(context.lease);
    const check = (async () => {
        assertCoordinatorCapability(context.packet, context.capability, initialOwnerDigest);
        if (current.lock.ownerDigest !== initialOwnerDigest
            || current.lock.lockFence !== initialFence
            || current.lock.epochHeaderDigest !== initialHeaderDigest
            || current.lock.epochHeaderDigest !== context.journal.epochHeaderDigest) epochFail('LOCK_LOST');
        const before = await context.journal.readValidatedState(current);
        if (before.aborted) epochFail('ABORTED_EPOCH');
        if (context.renew === true) {
            const renewed = await context.journal.renew(current);
            if (renewed.lock.ownerDigest !== initialOwnerDigest
                || renewed.lock.lockFence !== initialFence
                || renewed.lock.epochHeaderDigest !== initialHeaderDigest
                || renewed.lock.epochHeaderDigest !== context.journal.epochHeaderDigest) epochFail('LOCK_LOST');
            const after = await context.journal.readValidatedState(renewed);
            if (after.aborted) epochFail('ABORTED_EPOCH');
            current = immutableLease(renewed);
            context.onRenew?.(current);
            return;
        }
    }) as BoundLeaseCheck;
    Object.defineProperty(check, 'currentLease', {
        configurable: false,
        enumerable: false,
        value: () => current,
        writable: false,
    });
    issued.add(check);
    bindings.set(check, {
        packetDigest: canonicalDigest(context.packet),
        epochId: context.packet.epochId,
        roleSetDigest: context.packet.roleSetDigest,
        lockNamespace: context.packet.lockNamespace,
        ownerDigest: context.ownerDigest,
        lockFence: context.lease.lock.lockFence,
        resources,
        operations,
    });
    return check;
}

export function requireLeaseCheck(value: unknown, expected?: Readonly<{
    resource?: string;
    operation?: string;
}>): LeaseCheck {
    if (typeof value !== 'function' || !issued.has(value)) epochFail('LOCK_LOST');
    const binding = bindings.get(value);
    if (!binding) epochFail('LOCK_LOST');
    if (expected?.resource !== undefined && !binding.resources.includes(expected.resource)) epochFail('CAPABILITY_BINDING_MISMATCH');
    if (expected?.operation !== undefined && !binding.operations.includes(expected.operation)) epochFail('CAPABILITY_BINDING_MISMATCH');
    return value as LeaseCheck;
}

export function assertLeaseBinding(value: unknown, expected: Readonly<{
    packet: CapacityEpochPacket;
    ownerDigest: string;
    operation?: string;
    resource?: string;
    lockFence?: string;
}>): void {
    if (typeof value !== 'function' || !issued.has(value)) epochFail('LOCK_LOST');
    const binding = bindings.get(value);
    if (!binding || binding.packetDigest !== canonicalDigest(expected.packet)
        || binding.epochId !== expected.packet.epochId
        || binding.roleSetDigest !== expected.packet.roleSetDigest
        || binding.lockNamespace !== expected.packet.lockNamespace
        || binding.ownerDigest !== expected.ownerDigest
        || (expected.operation !== undefined && !binding.operations.includes(expected.operation))
        || (expected.resource !== undefined && !binding.resources.includes(expected.resource))
        || (expected.lockFence !== undefined && binding.lockFence !== expected.lockFence)) epochFail('CAPABILITY_BINDING_MISMATCH');
}
