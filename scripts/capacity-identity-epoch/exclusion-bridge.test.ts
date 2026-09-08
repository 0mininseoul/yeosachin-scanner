import { describe, expect, it } from 'vitest';
import { EpochError, canonicalDigest } from './contracts';
import {
    acquireExclusion,
    adoptNestedExclusion,
    deriveEntryPointResources,
    legacyServiceLockKey,
    LegacyServiceLock,
    renewExclusion,
    withExclusion,
    type LegacyLockStorage,
} from './exclusion-bridge';
import type { ReservationStorage } from './exclusion';

class MemoryStorage implements ReservationStorage {
    private readonly objects = new Map<string, { generation: string; value: unknown }>();
    private nextGeneration = 0;
    writes = 0;
    deletes = 0;
    renewPutGate: Readonly<{ started: () => void; wait: Promise<void> }> | undefined;
    get size(): number { return this.objects.size; }

    async get(key: string) { return this.objects.get(key) ?? null; }
    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }) {
        const gate = this.renewPutGate;
        if (gate) {
            this.renewPutGate = undefined;
            gate.started();
            await gate.wait;
        }
        const current = this.objects.get(key);
        if (options.ifGenerationMatch === '0' ? current : current?.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        const stored = { generation: String(++this.nextGeneration), value };
        this.objects.set(key, stored);
        this.writes += 1;
        return stored;
    }
    async delete(key: string, options: { ifGenerationMatch: string }) {
        const current = this.objects.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        this.objects.delete(key);
        this.deletes += 1;
    }
}

class MemoryRawStorage implements LegacyLockStorage {
    private readonly objects = new Map<string, { generation: string; body: string }>();
    private nextGeneration = 0;
    puts = 0;
    deletes = 0;
    failDeletes = 0;

    seed(key: string, body: string): void { this.objects.set(key, { generation: '1', body }); }
    async getRaw(key: string) { return this.objects.get(key) ?? null; }
    async putRaw(key: string, body: string, options: { ifGenerationMatch: '0' | string }) {
        const current = this.objects.get(key);
        if (options.ifGenerationMatch === '0' ? current : current?.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        const stored = { generation: String(++this.nextGeneration), body };
        this.objects.set(key, stored);
        this.puts += 1;
        return stored;
    }
    async deleteRaw(key: string, options: { ifGenerationMatch: string }) {
        const current = this.objects.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        if (this.failDeletes > 0) {
            this.failDeletes -= 1;
            throw new Error('legacy release failed');
        }
        this.objects.delete(key);
        this.deletes += 1;
    }

    has(key: string): boolean { return this.objects.has(key); }
}

const digest = (value: string) => canonicalDigest(value);
const resources = [
    { kind: 'service' as const, resource: 'projects/test/locations/region/services/preflight' },
    { kind: 'queue' as const, resource: 'projects/test/locations/region/queues/preflight' },
    { kind: 'scheduler' as const, resource: 'projects/test/locations/region/jobs/preflight-recovery' },
    { kind: 'iam' as const, resource: 'projects/test/locations/region/services/preflight' },
];

describe('ordinary mutation exclusion bridge', () => {
    it('requires a concrete role for direct capacity-owned queue entry', () => {
        expect(() => deriveEntryPointResources({ entryPoint: 'capacity-queue', resources })).toThrow('ADAPTER_REQUEST_INVALID');
        expect(() => deriveEntryPointResources({ entryPoint: 'capacity-queue', role: 'preflight', resources })).not.toThrow();
    });

    it('allows the reviewed capacity-owned generic queue-only mode without a service bypass', () => {
        expect(deriveEntryPointResources({
            entryPoint: 'capacity-queue',
            role: 'preflight',
            resources: [{ kind: 'queue', resource: resources[1]!.resource }],
        })).toEqual([`queue:${resources[1]!.resource}`]);
    });

    it('makes epoch and overlapping standalone selectors contend while unrelated sets proceed', async () => {
        const storage = new MemoryStorage();
        const epochResources = deriveEntryPointResources({ entryPoint: 'epoch', resources });
        const maintenanceResources = deriveEntryPointResources({
            entryPoint: 'preflight-maintenance', role: 'preflight', resources: [resources[0]!, resources[2]!, resources[3]!],
        });
        const unrelatedResources = deriveEntryPointResources({
            entryPoint: 'paid-maintenance', role: 'paid', resources: [
                { kind: 'service', resource: 'projects/test/locations/region/services/paid' },
                { kind: 'scheduler', resource: 'projects/test/locations/region/jobs/paid-recovery' },
                { kind: 'iam', resource: 'projects/test/locations/region/services/paid' },
                { kind: 'retention', resource: 'projects/test/locations/region/jobs/retention' },
            ],
        });
        const first = await acquireExclusion({ storage, resources: epochResources, epochDigest: digest('epoch-a'), ownerDigest: digest('owner-a') });
        await expect(acquireExclusion({ storage, resources: maintenanceResources, epochDigest: digest('epoch-b'), ownerDigest: digest('owner-b') })).rejects.toThrow('LOCK_LOST');
        const unrelated = await acquireExclusion({ storage, resources: unrelatedResources, epochDigest: digest('epoch-c'), ownerDigest: digest('owner-c') });
        await first.reservation.assert(first.reservationLease);
        await unrelated.reservation.assert(unrelated.reservationLease);
        await unrelated.reservation.release(unrelated.reservationLease);
        await first.reservation.release(first.reservationLease);
    });

    it('converges shared individual resources across a larger epoch set and a smaller standalone set', async () => {
        const storage = new MemoryStorage();
        const epoch = await acquireExclusion({
            storage,
            resources: ['service:shared', 'queue:shared', 'scheduler:shared'],
            epochDigest: digest('epoch-large'),
            ownerDigest: digest('owner-large'),
        });
        await expect(acquireExclusion({
            storage,
            resources: ['service:shared', 'scheduler:shared'],
            epochDigest: digest('standalone-overlap'),
            ownerDigest: digest('owner-overlap'),
        })).rejects.toThrow('LOCK_LOST');
        const disjoint = await acquireExclusion({
            storage,
            resources: ['service:other', 'scheduler:other'],
            epochDigest: digest('standalone-disjoint'),
            ownerDigest: digest('owner-disjoint'),
        });
        await epoch.reservation.assert(epoch.reservationLease);
        await disjoint.reservation.assert(disjoint.reservationLease);
        await disjoint.reservation.release(disjoint.reservationLease);
        await epoch.reservation.release(epoch.reservationLease);
    });

    it('treats arbitrary legacy text as occupied and never invents expiration', async () => {
        const storage = new MemoryRawStorage();
        const selector = { bucket: 'bucket', project: 'project', region: 'region', service: 'service' } as const;
        const key = legacyServiceLockKey(selector);
        storage.seed(key, 'legacy payload with no timestamp');
        const lock = new LegacyServiceLock(storage, selector);
        await expect(lock.acquire(digest('owner'))).rejects.toThrow('LOCK_LOST');
        expect(storage.puts).toBe(0);
        expect(storage.deletes).toBe(0);
        expect(await storage.getRaw(key)).not.toBeNull();
    });

    it('uses the old service-lock object key and generation-fences stale release', async () => {
        const storage = new MemoryRawStorage();
        const selector = { bucket: 'bucket', project: 'project', region: 'region', service: 'service' } as const;
        const lock = new LegacyServiceLock(storage, selector);
        const lease = await lock.acquire(digest('owner'));
        await expect(lock.assert(lease)).resolves.toBeUndefined();
        await expect(lock.release({ ...lease, generation: '2' })).rejects.toThrow('LOCK_LOST');
        await lock.release(lease);
        expect(await storage.getRaw(legacyServiceLockKey(selector))).toBeNull();
    });

    it('proves nested ownership through an opaque token without reacquiring its own locks', async () => {
        const storage = new MemoryStorage();
        let token: object | undefined;
        let writesAfterAcquire = 0;
        let writesAfterRenew = 0;
        await withExclusion({
            storage, resources: ['service:shared', 'scheduler:shared'], epochDigest: digest('epoch'), ownerDigest: digest('owner'),
        }, async context => {
            token = context.delegate();
            writesAfterAcquire = storage.writes;
            await expect(adoptNestedExclusion(token, ['service:shared'])).resolves.toBeDefined();
            await context.renew();
            writesAfterRenew = storage.writes;
            await context.assertLive();
            await expect(adoptNestedExclusion(token, ['service:shared'])).resolves.toBeDefined();
            expect(writesAfterRenew).toBeGreaterThan(writesAfterAcquire);
            return undefined;
        });
        expect(token).toBeDefined();
        await expect(adoptNestedExclusion(token!, ['service:shared'])).rejects.toThrow('LOCK_LOST');
    });

    it('renews every shared resource and returns the current generations', async () => {
        let now = 1_000;
        const storage = new MemoryStorage();
        const session = await acquireExclusion({
            storage, resources: ['service:renew', 'scheduler:renew'], epochDigest: digest('epoch'), ownerDigest: digest('owner'), now: () => now, leaseMs: 100,
        });
        now = 1_099;
        const renewed = await renewExclusion(session);
        await renewed.reservation.assert(renewed.reservationLease);
        now = 1_200;
        await expect(renewed.reservation.assert(renewed.reservationLease)).rejects.toThrow('LOCK_LOST');
        await renewed.reservation.release(renewed.reservationLease).catch(() => undefined);
    });

    it('coalesces concurrent same-owner renewals on one retained generation', async () => {
        const storage = new MemoryStorage();
        const session = await acquireExclusion({
            storage,
            resources: ['service:concurrent', 'scheduler:concurrent'],
            epochDigest: digest('epoch-concurrent'),
            ownerDigest: digest('owner-concurrent'),
        });
        const first = renewExclusion(session);
        const second = renewExclusion(session);
        const [renewed, coalesced] = await Promise.all([first, second]);
        expect(coalesced).toBe(renewed);
        await renewed.reservation.assert(renewed.reservationLease);
        await renewed.reservation.release(renewed.reservationLease);
    });

    it('waits for a heartbeat response before releasing the final lease', async () => {
        const storage = new MemoryStorage();
        let started!: () => void;
        const startedPromise = new Promise<void>(resolve => { started = resolve; });
        let releaseHeartbeat!: () => void;
        const heartbeatResponse = new Promise<void>(resolve => { releaseHeartbeat = resolve; });
        await withExclusion({
            storage,
            resources: ['service:finish', 'scheduler:finish'],
            epochDigest: digest('epoch-finish'),
            ownerDigest: digest('owner-finish'),
            renewEveryMs: 1,
        }, async () => {
            storage.renewPutGate = { started, wait: heartbeatResponse };
            await startedPromise;
            setTimeout(releaseHeartbeat, 0);
            return 'finished';
        }).then(result => expect(result).toBe('finished'));
        expect(storage.size).toBe(0);
    });

    it('releases the shared reservation after a legacy cleanup failure and preserves the action error', async () => {
        const storage = new MemoryStorage();
        const rawStorage = new MemoryRawStorage();
        const selectors = [
            { bucket: 'bucket', project: 'project', region: 'region', service: 'service-a' },
            { bucket: 'bucket', project: 'project', region: 'region', service: 'service-b' },
        ] as const;
        const primary = new Error('primary action failure');
        rawStorage.failDeletes = 1;

        await expect(withExclusion({
            storage,
            rawStorage,
            resources: ['service:shared'],
            epochDigest: digest('epoch-cleanup-primary'),
            ownerDigest: digest('owner-cleanup-primary'),
            legacyServices: selectors,
        }, async () => { throw primary; })).rejects.toBe(primary);

        expect(storage.size).toBe(0);
        expect(rawStorage.has(legacyServiceLockKey(selectors[0]))).toBe(false);
        expect(rawStorage.has(legacyServiceLockKey(selectors[1]))).toBe(true);
    });

    it('lets nested adoption await an in-flight same-owner renewal', async () => {
        const storage = new MemoryStorage();
        let started!: () => void;
        const startedPromise = new Promise<void>(resolve => { started = resolve; });
        let releaseHeartbeat!: () => void;
        const heartbeatResponse = new Promise<void>(resolve => { releaseHeartbeat = resolve; });
        await withExclusion({
            storage,
            resources: ['service:nested-renew', 'scheduler:nested-renew'],
            epochDigest: digest('epoch-nested-renew'),
            ownerDigest: digest('owner-nested-renew'),
        }, async context => {
            const token = context.delegate();
            storage.renewPutGate = { started, wait: heartbeatResponse };
            const renewal = context.renew();
            await startedPromise;
            const nested = adoptNestedExclusion(token, ['service:nested-renew']);
            setTimeout(releaseHeartbeat, 0);
            await expect(nested).resolves.toBeDefined();
            await renewal;
            return undefined;
        });
        expect(storage.size).toBe(0);
    });
});
