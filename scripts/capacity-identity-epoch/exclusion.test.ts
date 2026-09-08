import { describe, expect, it } from 'vitest';
import { CapacityReservation, reservationScopeDigest, type ReservationStorage } from './exclusion';
import { EpochError, canonicalDigest } from './contracts';

class MemoryStorage implements ReservationStorage {
    private readonly objects = new Map<string, { generation: string; value: unknown }>();
    private generation = 0;
    writes = 0;
    deletes = 0;
    failPutKey: string | undefined;

    seed(key: string, generation: string, value: unknown): void { this.objects.set(key, { generation, value }); }

    async get(key: string) { return this.objects.get(key) ?? null; }
    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }) {
        if (this.failPutKey === key) {
            this.failPutKey = undefined;
            throw new EpochError('ADAPTER_TIMEOUT');
        }
        const current = this.objects.get(key);
        if (options.ifGenerationMatch === '0' ? current : current?.generation !== options.ifGenerationMatch) {
            throw new EpochError('GENERATION_PRECONDITION_FAILED');
        }
        const stored = { generation: String(++this.generation), value };
        this.writes += 1;
        this.objects.set(key, stored);
        return stored;
    }
    async delete(key: string, options: { ifGenerationMatch: string }) {
        const current = this.objects.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        this.objects.delete(key);
        this.deletes += 1;
    }
}

const digest = (value: string) => canonicalDigest(value);

describe('common epoch/ordinary capacity reservation', () => {
    it('allows one owner across epochs and fences ordinary mutation intervals', async () => {
        const storage = new MemoryStorage();
        const reservation = new CapacityReservation(storage, { namespace: 'both-planes', now: () => 1_000, leaseMs: 1_000 });
        const first = await reservation.acquire(digest('epoch-a'), digest('owner-a'));
        await expect(reservation.acquire(digest('epoch-b'), digest('owner-b'))).rejects.toThrow('LOCK_LOST');
        await reservation.assert(first);
        await expect(reservation.assert({ ...first, generation: '1' })).resolves.toBeUndefined();
        await reservation.release(first);
        const second = await reservation.acquire(digest('epoch-b'), digest('owner-b'));
        expect(second.record.epochDigest).toBe(digest('epoch-b'));
    });

    it('requires a new fence after expiry and rejects stale release/renewal', async () => {
        let now = 1_000;
        const storage = new MemoryStorage();
        const reservation = new CapacityReservation(storage, { namespace: 'plane', now: () => now, leaseMs: 100 });
        const first = await reservation.acquire(digest('epoch-a'), digest('owner-a'));
        now = 1_101;
        const second = await reservation.acquire(digest('epoch-b'), digest('owner-b'));
        expect(Number(second.record.lockFence)).toBeGreaterThan(Number(first.record.lockFence));
        await expect(reservation.assert(first)).rejects.toThrow('LOCK_LOST');
        await expect(reservation.release(first)).rejects.toThrow('LOCK_LOST');
        await reservation.release(second);
    });

    it('rejects malformed owner/epoch/namespace values before storage access', async () => {
        const storage = new MemoryStorage();
        expect(() => new CapacityReservation(storage, { namespace: 'bad/name', now: Date.now })).toThrow(EpochError);
        const reservation = new CapacityReservation(storage, { namespace: 'plane', now: Date.now });
        await expect(reservation.acquire('not-a-digest', digest('owner'))).rejects.toThrow('CAPABILITY_INVALID');
        await expect(reservation.acquire(digest('epoch'), 'not-a-digest')).rejects.toThrow('CAPABILITY_INVALID');
    });

    it('rejects malformed stored owner records before expired takeover writes', async () => {
        const now = 10_000;
        const storage = new MemoryStorage();
        const reservation = new CapacityReservation(storage, { namespace: 'malformed-owner', now: () => now, leaseMs: 100 });
        storage.seed(reservation.key, '1', {
            epochDigest: digest('epoch-a'), ownerDigest: 42, lockFence: '1', lockExpiresAt: new Date(1_000).toISOString(),
        });
        await expect(reservation.acquire(digest('epoch-b'), digest('owner-b'))).rejects.toThrow('JOURNAL_INVALID');
        expect(storage.writes).toBe(0);
    });

    it('derives one key from exact resources so renamed epochs still contend', async () => {
        const storage = new MemoryStorage();
        const resources = ['cloud-tasks-queue:projects/test/locations/region/queues/preflight', 'cloud-run-service:projects/test/locations/region/services/preflight'];
        const first = new CapacityReservation(storage, { namespace: 'epoch-a', now: () => 1_000, leaseMs: 1_000 });
        const resourceFirst = new CapacityReservation(storage, { resources, now: () => 1_000, leaseMs: 1_000 });
        const resourceSecond = new CapacityReservation(storage, { resources: [...resources].reverse(), now: () => 1_000, leaseMs: 1_000 });
        expect(resourceFirst.key).toBe(resourceSecond.key);
        expect(resourceFirst.scopeDigest).toBe(reservationScopeDigest(resources));
        const lease = await resourceFirst.acquire(digest('epoch-a'), digest('owner-a'));
        await expect(resourceSecond.acquire(digest('epoch-b'), digest('owner-b'))).rejects.toThrow('LOCK_LOST');
        await resourceFirst.release(lease);
        await first.acquire(digest('epoch-a'), digest('owner-a'));
        expect(first.key).not.toBe(resourceFirst.key);
    });

    it('does not merge distinct exact resource sets merely because their epoch labels match', async () => {
        const storage = new MemoryStorage();
        const left = new CapacityReservation(storage, { resources: ['queue:left'], now: () => 1_000, leaseMs: 1_000 });
        const right = new CapacityReservation(storage, { resources: ['queue:right'], now: () => 1_000, leaseMs: 1_000 });
        expect(left.key).not.toBe(right.key);
        await expect(Promise.all([
            left.acquire(digest('epoch-a'), digest('owner-a')),
            right.acquire(digest('epoch-b'), digest('owner-b')),
        ])).resolves.toHaveLength(2);
    });

    it('fences partially overlapping resource sets through each shared member lock', async () => {
        const storage = new MemoryStorage();
        const epoch = new CapacityReservation(storage, {
            resources: ['service:shared', 'queue:shared', 'scheduler:shared'], now: () => 1_000, leaseMs: 1_000,
        });
        const maintenance = new CapacityReservation(storage, {
            resources: ['service:shared', 'scheduler:shared'], now: () => 1_000, leaseMs: 1_000,
        });
        const lease = await epoch.acquire(digest('epoch-a'), digest('owner-a'));
        await expect(maintenance.acquire(digest('epoch-b'), digest('owner-b'))).rejects.toThrow('LOCK_LOST');
        await epoch.assert(lease);
        await epoch.release(lease);
        const maintenanceLease = await maintenance.acquire(digest('epoch-b'), digest('owner-b'));
        await maintenance.assert(maintenanceLease);
    });

    it('cleans up every owned member after a partial whole-scope renewal failure', async () => {
        const storage = new MemoryStorage();
        const reservation = new CapacityReservation(storage, {
            resources: ['service:partial', 'queue:partial', 'scheduler:partial'], now: () => 1_000, leaseMs: 1_000,
        });
        const lease = await reservation.acquire(digest('epoch-partial'), digest('owner-partial'));
        const failedKey = lease.members?.[1]?.key;
        if (!failedKey) throw new Error('missing multi-resource member');
        storage.failPutKey = failedKey;
        await expect(reservation.renew(lease)).rejects.toThrow('ADAPTER_TIMEOUT');
        expect(storage.deletes).toBe(3);
        expect(await storage.get(lease.members?.[0]?.key ?? '')).toBeNull();
        expect(await storage.get(lease.members?.[1]?.key ?? '')).toBeNull();
        expect(await storage.get(lease.members?.[2]?.key ?? '')).toBeNull();
    });

    it('binds the persisted reservation record to its exact scope digest', async () => {
        const storage = new MemoryStorage();
        const reservation = new CapacityReservation(storage, { resources: ['queue:bound'], now: () => 1_000, leaseMs: 1_000 });
        const lease = await reservation.acquire(digest('epoch-a'), digest('owner-a'));
        const current = await storage.get(reservation.key);
        if (!current) throw new Error('missing reservation');
        storage.seed(reservation.key, current.generation, { ...lease.record, scopeDigest: digest('foreign-scope') });
        await expect(reservation.assert(lease)).rejects.toThrow('LOCK_LOST');
    });
});
