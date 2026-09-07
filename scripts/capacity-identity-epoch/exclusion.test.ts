import { describe, expect, it } from 'vitest';
import { CapacityReservation, type ReservationStorage } from './exclusion';
import { EpochError, canonicalDigest } from './contracts';

class MemoryStorage implements ReservationStorage {
    private readonly objects = new Map<string, { generation: string; value: unknown }>();
    private generation = 0;

    async get(key: string) { return this.objects.get(key) ?? null; }
    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }) {
        const current = this.objects.get(key);
        if (options.ifGenerationMatch === '0' ? current : current?.generation !== options.ifGenerationMatch) {
            throw new EpochError('GENERATION_PRECONDITION_FAILED');
        }
        const stored = { generation: String(++this.generation), value };
        this.objects.set(key, stored);
        return stored;
    }
    async delete(key: string, options: { ifGenerationMatch: string }) {
        const current = this.objects.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        this.objects.delete(key);
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
});
