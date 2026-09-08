/**
 * Protected FD bridge for ordinary capacity mutation entry points.
 *
 * The descriptor carries reviewed resource selectors and digests; argv only
 * selects acquire/assert/renew/release. No resource value, payload, or
 * arbitrary shell command is accepted from argv or printed to output.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { createAuthenticatedGcsJournalStorage } from './capacity-identity-epoch/gcs';
import { readProtectedDescriptor, rejectDuplicateJsonKeys } from './capacity-identity-epoch/packet';
import { epochFail, EpochError, hasExactKeys, isObject, type Role } from './capacity-identity-epoch/contracts';
import {
    acquireExclusion,
    assertExclusion,
    deriveEntryPointResources,
    legacyServiceLockPayloadDigest,
    legacyServiceLockKey,
    LegacyServiceLock,
    releaseExclusion,
    renewExclusion,
    type ExclusionEntryPoint,
    type ExclusionResource,
    type ExclusionSession,
    type LegacyLockObject,
    type LegacyServiceSelector,
} from './capacity-identity-epoch/exclusion-bridge';
import {
    CapacityReservation,
    reservationResourceDigest,
    reservationResourceKey,
    type ReservationLease,
    type ReservationRecord,
} from './capacity-identity-epoch/exclusion';

const DIGEST = /^[0-9a-f]{64}$/;
const FD = /^\d{1,9}$/;
const BUCKET = /^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$/;
const SAFE_RESOURCE = /^[^\u0000-\u001f\u007f]{1,1024}$/;
const ENTRY_POINTS = ['epoch', 'role-deployer', 'capacity-queue', 'preflight-maintenance', 'paid-maintenance'] as const;
const ROLES = ['preflight', 'paid'] as const;
const RESOURCE_KINDS = ['service', 'queue', 'scheduler', 'iam', 'retention', 'vercel'] as const;

type Command = 'acquire' | 'assert' | 'renew' | 'release';

type SerializedReservationLease = Readonly<{
    generation: string;
    record: ReservationLease['record'];
    members: NonNullable<ReservationLease['members']> | null;
}>;

type SerializedLegacyLease = Readonly<{
    generation: string;
    payloadDigest: string;
}>;

export type SerializedLease = Readonly<{
    reservationLease: SerializedReservationLease;
    legacyLeases: readonly SerializedLegacyLease[];
}>;

export type BridgeDescriptor = Readonly<{
    bucket: string;
    entryPoint: ExclusionEntryPoint;
    role: Role | null;
    resources: readonly ExclusionResource[];
    legacyServices: readonly LegacyServiceSelector[];
    epochDigest: string;
    ownerDigest: string;
    leaseMs: number;
    lease: SerializedLease | null;
}>;

const DESCRIPTOR_KEYS = ['bucket', 'entryPoint', 'epochDigest', 'lease', 'leaseMs', 'legacyServices', 'ownerDigest', 'resources', 'role'] as const;

function fail(code: 'ADAPTER_REQUEST_INVALID' | 'PROTECTED_INPUT_UNAVAILABLE' | 'CAPABILITY_INVALID' | 'CAPABILITY_BINDING_MISMATCH' | 'RESOURCE_INVALID' | 'JOURNAL_INVALID' | 'LOCK_LOST' | 'GENERATION_PRECONDITION_FAILED'): never {
    epochFail(code);
}

function parseFd(value: string | undefined): number {
    if (value === undefined || !FD.test(value)) fail('ADAPTER_REQUEST_INVALID');
    const fd = Number(value);
    if (!Number.isSafeInteger(fd)) fail('ADAPTER_REQUEST_INVALID');
    return fd;
}

function requireDigest(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !DIGEST.test(value)) fail('CAPABILITY_INVALID');
}

export function validateDescriptor(value: unknown): BridgeDescriptor {
    if (!isObject(value) || !hasExactKeys(value, DESCRIPTOR_KEYS)
        || typeof value.bucket !== 'string' || !BUCKET.test(value.bucket)
        || typeof value.entryPoint !== 'string' || !ENTRY_POINTS.includes(value.entryPoint as ExclusionEntryPoint)
        || (value.role !== null && (typeof value.role !== 'string' || !ROLES.includes(value.role as Role)))
        || !Array.isArray(value.resources) || !Array.isArray(value.legacyServices)
        || typeof value.leaseMs !== 'number' || !Number.isSafeInteger(value.leaseMs) || value.leaseMs <= 0 || value.leaseMs > 15 * 60_000
        || (value.lease !== null && !isObject(value.lease))) fail('PROTECTED_INPUT_UNAVAILABLE');
    requireDigest(value.epochDigest);
    requireDigest(value.ownerDigest);
    const resources: ExclusionResource[] = [];
    for (const resource of value.resources) {
        if (!isObject(resource) || !hasExactKeys(resource, ['kind', 'resource'])
            || typeof resource.kind !== 'string' || !RESOURCE_KINDS.includes(resource.kind as ExclusionResource['kind'])
            || typeof resource.resource !== 'string' || !SAFE_RESOURCE.test(resource.resource)) fail('PROTECTED_INPUT_UNAVAILABLE');
        resources.push(resource as ExclusionResource);
    }
    const legacyServices: LegacyServiceSelector[] = [];
    const lockKeys = new Set<string>();
    for (const selector of value.legacyServices) {
        if (!isObject(selector) || !hasExactKeys(selector, ['bucket', 'project', 'region', 'service'])
            || typeof selector.bucket !== 'string' || selector.bucket !== value.bucket
            || typeof selector.project !== 'string' || !SAFE_RESOURCE.test(selector.project)
            || typeof selector.region !== 'string' || !SAFE_RESOURCE.test(selector.region)
            || typeof selector.service !== 'string' || !SAFE_RESOURCE.test(selector.service)) fail('PROTECTED_INPUT_UNAVAILABLE');
        const typed = selector as LegacyServiceSelector;
        const key = legacyServiceLockKey(typed);
        if (lockKeys.has(key)) fail('PROTECTED_INPUT_UNAVAILABLE');
        lockKeys.add(key);
        legacyServices.push(typed);
    }
    deriveEntryPointResources({
        entryPoint: value.entryPoint as ExclusionEntryPoint,
        role: value.role === null ? undefined : value.role as Role,
        resources,
    });
    const lease = value.lease === null ? null : validateSerializedLease(value.lease);
    const descriptor = Object.freeze({
        bucket: value.bucket,
        entryPoint: value.entryPoint as ExclusionEntryPoint,
        role: value.role === null ? null : value.role as Role,
        resources: Object.freeze(resources),
        legacyServices: Object.freeze(legacyServices),
        epochDigest: value.epochDigest,
        ownerDigest: value.ownerDigest,
        leaseMs: value.leaseMs,
        lease,
    });
    assertLeaseBinding(descriptor);
    return descriptor;
}

export function validateSerializedLease(value: unknown): SerializedLease {
    if (!isObject(value) || !hasExactKeys(value, ['legacyLeases', 'reservationLease'])
        || !isObject(value.reservationLease) || !Array.isArray(value.legacyLeases)) fail('PROTECTED_INPUT_UNAVAILABLE');
    const reservationLease = value.reservationLease as Record<string, unknown>;
    if (!hasExactKeys(reservationLease, ['generation', 'record', 'members'])
        || typeof reservationLease.generation !== 'string' || !/^[1-9][0-9]*$/.test(reservationLease.generation)
        || !isObject(reservationLease.record)
        || (reservationLease.members !== null && !Array.isArray(reservationLease.members))) fail('PROTECTED_INPUT_UNAVAILABLE');
    const record = reservationLease.record as Record<string, unknown>;
    if (!hasExactKeys(record, ['epochDigest', 'lockExpiresAt', 'lockFence', 'ownerDigest', 'scopeDigest'])
        || typeof record.epochDigest !== 'string' || !DIGEST.test(record.epochDigest)
        || typeof record.ownerDigest !== 'string' || !DIGEST.test(record.ownerDigest)
        || typeof record.scopeDigest !== 'string' || !DIGEST.test(record.scopeDigest)
        || typeof record.lockFence !== 'string' || !/^[1-9][0-9]*$/.test(record.lockFence)
        || typeof record.lockExpiresAt !== 'string' || !Number.isFinite(Date.parse(record.lockExpiresAt))) fail('PROTECTED_INPUT_UNAVAILABLE');
    const members = reservationLease.members === null ? undefined : (reservationLease.members as unknown[]).map((memberValue: unknown) => {
        if (!isObject(memberValue) || !hasExactKeys(memberValue, ['key', 'generation', 'record'])
            || typeof memberValue.key !== 'string' || !/^epoch-reservation\/[0-9a-f]{64}\.lock$/.test(memberValue.key)
            || typeof memberValue.generation !== 'string' || !/^[1-9][0-9]*$/.test(memberValue.generation)
            || !isObject(memberValue.record)) fail('PROTECTED_INPUT_UNAVAILABLE');
        const memberRecord = memberValue.record as Record<string, unknown>;
        if (!hasExactKeys(memberRecord, ['epochDigest', 'lockExpiresAt', 'lockFence', 'ownerDigest', 'scopeDigest'])
            || typeof memberRecord.epochDigest !== 'string' || !DIGEST.test(memberRecord.epochDigest)
            || typeof memberRecord.ownerDigest !== 'string' || !DIGEST.test(memberRecord.ownerDigest)
            || typeof memberRecord.scopeDigest !== 'string' || !DIGEST.test(memberRecord.scopeDigest)
            || typeof memberRecord.lockFence !== 'string' || !/^[1-9][0-9]*$/.test(memberRecord.lockFence)
            || typeof memberRecord.lockExpiresAt !== 'string' || !Number.isFinite(Date.parse(memberRecord.lockExpiresAt))) fail('PROTECTED_INPUT_UNAVAILABLE');
        return memberValue as unknown as NonNullable<ReservationLease['members']>[number];
    });
    const legacyLeases = value.legacyLeases.map((legacyValue: unknown) => {
        if (!isObject(legacyValue) || !hasExactKeys(legacyValue, ['generation', 'payloadDigest'])
            || typeof legacyValue.generation !== 'string' || !/^[1-9][0-9]*$/.test(legacyValue.generation)
            || typeof legacyValue.payloadDigest !== 'string' || !DIGEST.test(legacyValue.payloadDigest)) fail('PROTECTED_INPUT_UNAVAILABLE');
        return { generation: legacyValue.generation, payloadDigest: legacyValue.payloadDigest };
    });
    return Object.freeze({
        reservationLease: Object.freeze({
            generation: reservationLease.generation as string,
            record: record as unknown as ReservationLease['record'],
            members: members ?? null,
        }),
        legacyLeases: Object.freeze(legacyLeases),
    });
}

function sameReservationRecord(left: ReservationRecord, right: ReservationRecord): boolean {
    return left.scopeDigest === right.scopeDigest
        && left.epochDigest === right.epochDigest
        && left.ownerDigest === right.ownerDigest
        && left.lockFence === right.lockFence
        && left.lockExpiresAt === right.lockExpiresAt;
}

function assertLeaseBinding(descriptor: BridgeDescriptor): void {
    const lease = descriptor.lease;
    if (!lease) return;
    const resources = deriveEntryPointResources({
        entryPoint: descriptor.entryPoint,
        role: descriptor.role ?? undefined,
        resources: descriptor.resources,
    });
    const reservation = lease.reservationLease;
    if (reservation.record.epochDigest !== descriptor.epochDigest
        || reservation.record.ownerDigest !== descriptor.ownerDigest) {
        fail('CAPABILITY_BINDING_MISMATCH');
    }
    if (reservation.members === null) {
        if (resources.length !== 1
            || reservation.record.scopeDigest !== reservationResourceDigest(resources[0]!)) {
            fail('CAPABILITY_BINDING_MISMATCH');
        }
    } else {
        if (reservation.members.length !== resources.length) fail('CAPABILITY_BINDING_MISMATCH');
        for (let index = 0; index < resources.length; index += 1) {
            const member = reservation.members[index]!;
            if (member.key !== reservationResourceKey(resources[index]!)
                || member.record.scopeDigest !== reservationResourceDigest(resources[index]!)
                || member.record.epochDigest !== descriptor.epochDigest
                || member.record.ownerDigest !== descriptor.ownerDigest) {
                fail('CAPABILITY_BINDING_MISMATCH');
            }
        }
        const first = reservation.members[0]!;
        if (reservation.generation !== first.generation
            || !sameReservationRecord(reservation.record, first.record)) {
            fail('CAPABILITY_BINDING_MISMATCH');
        }
    }
    const selectors = [...descriptor.legacyServices]
        .sort((left, right) => legacyServiceLockKey(left).localeCompare(legacyServiceLockKey(right)));
    if (lease.legacyLeases.length !== selectors.length) fail('CAPABILITY_BINDING_MISMATCH');
    for (let index = 0; index < selectors.length; index += 1) {
        if (lease.legacyLeases[index]!.payloadDigest !== legacyServiceLockPayloadDigest(selectors[index]!, descriptor.ownerDigest)) {
            fail('CAPABILITY_BINDING_MISMATCH');
        }
    }
}

export function serializeSession(
    session: ExclusionSession,
    requestedResources?: readonly string[],
    includeLegacy = true,
): SerializedLease {
    let reservationLease = session.reservationLease;
    if (requestedResources !== undefined) {
        const resources = [...session.resources].sort();
        const requested = [...requestedResources].sort();
        if (requested.length === 0
            || requested.some(resource => typeof resource !== 'string')
            || new Set(requested).size !== requestedResources.length
            || requested.some(resource => !resources.includes(resource))) {
            fail('CAPABILITY_BINDING_MISMATCH');
        }
        if (reservationLease.members === undefined) {
            if (resources.length !== 1 || requested.length !== 1) fail('CAPABILITY_BINDING_MISMATCH');
        } else {
            if (reservationLease.members.length !== resources.length) fail('CAPABILITY_BINDING_MISMATCH');
            const memberByResource = new Map(resources.map((resource, index) => [resource, reservationLease.members![index]!] as const));
            const selectedMembers = requested.map(resource => memberByResource.get(resource));
            if (selectedMembers.some(member => member === undefined)) fail('CAPABILITY_BINDING_MISMATCH');
            const selected = selectedMembers as NonNullable<ReservationLease['members']>;
            const first = selected[0]!;
            reservationLease = {
                generation: first.generation,
                record: first.record,
                ...(selected.length === 1 ? {} : { members: selected }),
            };
        }
    }
    return {
        reservationLease: {
            ...reservationLease,
            members: reservationLease.members ?? null,
        },
        // Never emit the legacy object key: it contains project/region/service
        // identity. The descriptor already binds the sorted lock order.
        legacyLeases: includeLegacy ? session.legacyLeases.map(lease => ({
            generation: lease.generation,
            payloadDigest: lease.payloadDigest,
        })) : [],
    };
}

export function restoreSession(descriptor: BridgeDescriptor, storage: ReturnType<typeof createAuthenticatedGcsJournalStorage>): ExclusionSession {
    if (!descriptor.lease) fail('PROTECTED_INPUT_UNAVAILABLE');
    const resources = deriveEntryPointResources({ entryPoint: descriptor.entryPoint, role: descriptor.role ?? undefined, resources: descriptor.resources });
    const reservation = new CapacityReservation(storage, { resources, leaseMs: descriptor.leaseMs });
    const legacyLocks = [...descriptor.legacyServices]
        .sort((left, right) => legacyServiceLockKey(left).localeCompare(legacyServiceLockKey(right)))
        .map(selector => new LegacyServiceLock(storage, selector));
    if (legacyLocks.length !== descriptor.lease.legacyLeases.length) fail('CAPABILITY_BINDING_MISMATCH');
    const legacyLeases: LegacyLockObject[] = descriptor.lease.legacyLeases.map((lease, index) => ({
        key: legacyLocks[index]!.key,
        generation: lease.generation,
        payloadDigest: lease.payloadDigest,
    }));
    return Object.freeze({
        resources,
        reservation,
        reservationLease: {
            ...descriptor.lease.reservationLease,
            members: descriptor.lease.reservationLease.members ?? undefined,
        },
        legacyLocks: Object.freeze(legacyLocks),
        legacyLeases: Object.freeze(legacyLeases),
    });
}

function parseCommand(argv: readonly string[]): Readonly<{ command: Command; fd: number }> {
    const command = argv[0];
    if (command !== 'acquire' && command !== 'assert' && command !== 'renew' && command !== 'release') fail('ADAPTER_REQUEST_INVALID');
    if (argv.length !== 3 || argv[1] !== '--descriptor-fd') fail('ADAPTER_REQUEST_INVALID');
    return { command, fd: parseFd(argv[2]) };
}

export async function readBridgeDescriptor(fd: number): Promise<BridgeDescriptor> {
    const raw = await readProtectedDescriptor(fd);
    rejectDuplicateJsonKeys(raw);
    let decoded: unknown;
    try { decoded = JSON.parse(raw) as unknown; } catch { fail('PROTECTED_INPUT_UNAVAILABLE'); }
    return validateDescriptor(decoded);
}

export async function runExclusionBridge(argv: readonly string[]): Promise<void> {
    const { command, fd } = parseCommand(argv);
    const descriptor = await readBridgeDescriptor(fd);
    const storage = createAuthenticatedGcsJournalStorage({ bucket: descriptor.bucket });
    if (command === 'acquire') {
        if (descriptor.lease !== null) fail('CAPABILITY_BINDING_MISMATCH');
        const session = await acquireExclusion({
            storage,
            rawStorage: storage,
            resources: deriveEntryPointResources({ entryPoint: descriptor.entryPoint, role: descriptor.role ?? undefined, resources: descriptor.resources }),
            epochDigest: descriptor.epochDigest,
            ownerDigest: descriptor.ownerDigest,
            leaseMs: descriptor.leaseMs,
            legacyServices: descriptor.legacyServices,
        });
        process.stdout.write(`${JSON.stringify({ status: 'ACQUIRED', lease: serializeSession(session) })}\n`);
        return;
    }
    const session = restoreSession(descriptor, storage);
    if (command === 'assert') {
        await assertExclusion(session);
        process.stdout.write('ASSERT_OK\n');
        return;
    }
    if (command === 'renew') {
        const renewed = await renewExclusion(session);
        process.stdout.write(`${JSON.stringify({ status: 'RENEWED', lease: serializeSession(renewed) })}\n`);
        return;
    }
    await releaseExclusion(session);
    process.stdout.write('RELEASED\n');
}

const invokedScript = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedScript) {
    void runExclusionBridge(process.argv.slice(2)).catch((error: unknown) => {
        if (error instanceof EpochError) {
            process.stderr.write(`${error.code}\n`);
            process.exitCode = 2;
        } else {
            process.stderr.write('ADAPTER_REQUEST_INVALID\n');
            process.exitCode = 2;
        }
    });
}
