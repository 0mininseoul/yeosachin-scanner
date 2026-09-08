import { describe, expect, it } from 'vitest';
import { createFixturePacket } from './fixtures';
import { EpochError, canonicalDigest } from './contracts';
import { EpochJournal, type JournalStorage } from './journal';
import { issueCoordinatorCapability } from './packet';
import { issueLeaseCheck } from './lease-capability';
import { AuthenticatedProtectedTransport, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from './platform';
import { WorkPlaneClient } from './work-planes';

class MemoryStorage implements JournalStorage {
    private readonly values = new Map<string, { generation: string; value: unknown }>();
    private nextGeneration = 2;

    async get(key: string) { return this.values.get(key) ?? null; }

    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }) {
        const current = this.values.get(key);
        if (options.ifGenerationMatch === '0' ? current !== undefined : current?.generation !== options.ifGenerationMatch) {
            throw new EpochError('GENERATION_PRECONDITION_FAILED');
        }
        const stored = { generation: String(this.nextGeneration++), value };
        this.values.set(key, stored);
        return stored;
    }

    async list(prefix: string) {
        return [...this.values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, ...value }));
    }

    seed(key: string, value: unknown): void {
        this.values.set(key, { generation: '1', value });
    }
}

function authority(packet = createFixturePacket(), ownerDigest = 'a'.repeat(64)) {
    const header = {
        epochIdDigest: canonicalDigest(packet.epochId), capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest, desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest, sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: '2026-09-08T00:00:00.000Z',
    } as const;
    const storage = new MemoryStorage();
    const journal = new EpochJournal(storage, { header, now: () => 100_000 });
    const lease = {
        generation: '1',
        lock: { epochHeaderDigest: journal.epochHeaderDigest, ownerDigest, lockFence: '1', lockExpiresAt: '2099-01-01T00:00:00.000Z' },
    };
    storage.seed(journal.headerKey, header);
    storage.seed(journal.lockKey, lease.lock);
    return { packet, journal, lease, capability: issueCoordinatorCapability(packet, ownerDigest), ownerDigest };
}

function checkFor(
    current: ReturnType<typeof authority>,
    operation: string | readonly string[],
    resource: string | readonly string[],
    options: { renew?: boolean } = {},
) {
    return issueLeaseCheck({
        packet: current.packet,
        capability: current.capability,
        ownerDigest: current.ownerDigest,
        lease: current.lease,
        operation,
        resource,
        journal: current.journal,
        ...options,
    });
}

class ForbiddenTransport implements ProtectedTransport {
    requests: ProtectedHttpRequest[] = [];
    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> {
        this.requests.push(request);
        throw new Error('provider must not run');
    }
}

describe('opaque lease capability authority', () => {
    it('rejects a valid coordinator capability paired with another owner lease at issuance', () => {
        const packet = createFixturePacket();
        const ownerA = authority(packet, 'a'.repeat(64));
        const ownerB = authority(packet, 'b'.repeat(64));
        expect(() => issueLeaseCheck({
            packet,
            capability: ownerA.capability,
            ownerDigest: ownerA.ownerDigest,
            lease: ownerB.lease,
            operation: 'queue.pause',
            resource: packet.protectedInputs.desired.queues.preflight.resource,
            journal: ownerB.journal,
        })).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('rejects a journal header from a different packet even when owner and fence match', () => {
        const first = authority(createFixturePacket(), 'a'.repeat(64));
        const foreignStorage = new MemoryStorage();
        const foreignHeader = { ...first.journal.epochHeader, epochIdDigest: 'c'.repeat(64) };
        const foreignJournal = new EpochJournal(foreignStorage, { header: foreignHeader, now: () => 100_000 });
        const foreignLease = {
            generation: '1',
            lock: { epochHeaderDigest: foreignJournal.epochHeaderDigest, ownerDigest: first.ownerDigest, lockFence: '1', lockExpiresAt: '2099-01-01T00:00:00.000Z' },
        };
        foreignStorage.seed(foreignJournal.headerKey, foreignHeader);
        foreignStorage.seed(foreignJournal.lockKey, foreignLease.lock);
        expect(() => issueLeaseCheck({
            packet: first.packet,
            capability: first.capability,
            ownerDigest: first.ownerDigest,
            lease: foreignLease,
            operation: 'queue.pause',
            resource: first.packet.protectedInputs.desired.queues.preflight.resource,
            journal: foreignJournal,
        })).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('rejects a resource outside the reviewed packet scope before issuance', () => {
        const current = authority();
        expect(() => checkFor(
            current,
            'queue.pause',
            'projects/example-project/locations/asia-northeast3/queues/foreign',
        )).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('rejects pause authority at the resume adapter entry before provider access', async () => {
        const current = authority();
        const queue = current.packet.protectedInputs.desired.queues.preflight;
        const pauseCheck = checkFor(current, 'queue.pause', queue.resource);
        const transport = new ForbiddenTransport();
        const client = new WorkPlaneClient({ transport: new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' }) });
        await expect(client.resumeQueue(queue, pauseCheck)).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        expect(transport.requests).toHaveLength(0);
    });

    it('rejects a same-packet capability when an adapter claims a foreign resource', async () => {
        const current = authority();
        const queue = current.packet.protectedInputs.desired.queues.preflight;
        const pauseCheck = checkFor(current, 'queue.pause', queue.resource);
        const foreignQueue = { ...queue, resource: 'projects/example-project/locations/asia-northeast3/queues/foreign' };
        const transport = new ForbiddenTransport();
        const client = new WorkPlaneClient({ transport: new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token' }) });
        await expect(client.pauseQueue(foreignQueue, pauseCheck)).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        expect(transport.requests).toHaveLength(0);
    });

    it('rejects a capability after a durable ABORTED journal transition', async () => {
        const current = authority();
        const queue = current.packet.protectedInputs.desired.queues.preflight;
        const check = checkFor(current, 'queue.pause', queue.resource);
        const digest = 'f'.repeat(64);
        await current.journal.append(current.lease, {
            sequence: 1, epochIdDigest: current.journal.epochIdDigest, fromState: null, toState: null,
            stateVersion: 1, lockFence: current.lease.lock.lockFence,
            preconditionDigest: digest, mutationDigest: digest, postconditionDigest: digest,
            proofDigest: digest, nativeConcurrencyTokenDigest: digest, resourceObservationDigest: digest,
            resultCode: 'ABORTED', recordedAt: '2026-09-08T00:00:01.000Z',
        });
        await expect(current.journal.readValidatedState(current.lease)).resolves.toMatchObject({ aborted: true });
        await expect(check()).rejects.toThrow('ABORTED_EPOCH');
    });

    it('carries renewed storage generations through an operation-local check', async () => {
        const current = authority();
        const queue = current.packet.protectedInputs.desired.queues.preflight;
        const check = checkFor(current, 'queue.pause', queue.resource, { renew: true });
        await check();
        expect(check.currentLease().generation).toBe('2');
        await check();
        expect(check.currentLease().generation).toBe('3');

        const staleChild = issueLeaseCheck({
            packet: current.packet,
            capability: current.capability,
            ownerDigest: current.ownerDigest,
            lease: current.lease,
            operation: 'queue.resume',
            resource: queue.resource,
            journal: current.journal,
        });
        await expect(staleChild()).rejects.toThrow('LOCK_LOST');
    });
});
