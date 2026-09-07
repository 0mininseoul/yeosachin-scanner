import { describe, expect, it } from 'vitest';
import {
    EpochJournal,
    type JournalStorage,
    type StoredObject,
} from './journal';
import { EpochError, canonicalDigest, type EpochHeader, type EpochTransition } from './contracts';

class MemoryStorage implements JournalStorage {
    private readonly objects = new Map<string, StoredObject>();
    private generation = 0;

    async get(key: string): Promise<StoredObject | null> {
        return this.objects.get(key) ?? null;
    }

    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<StoredObject> {
        const current = this.objects.get(key);
        if (options.ifGenerationMatch === '0' ? current !== undefined : current?.generation !== options.ifGenerationMatch) {
            throw new EpochError('GENERATION_PRECONDITION_FAILED');
        }
        const stored = { generation: String(++this.generation), value };
        this.objects.set(key, stored);
        return stored;
    }

    async list(prefix: string): Promise<ReadonlyArray<StoredObject & { key: string }>> {
        return [...this.objects.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, ...value }));
    }

    async delete(key: string, options: { ifGenerationMatch: string }): Promise<void> {
        const current = this.objects.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        this.objects.delete(key);
    }
}

class TakeoverDuringAppendStorage extends MemoryStorage {
    lockKey: string | undefined;
    journalPrefix: string | undefined;
    takeoverOwner: string | undefined;
    private takenOver = false;

    override async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<StoredObject> {
        const stored = await super.put(key, value, options);
        if (!this.takenOver && this.lockKey && this.journalPrefix && key.startsWith(this.journalPrefix) && this.takeoverOwner) {
            const lock = await this.get(this.lockKey);
            if (!lock) throw new Error('missing lock fixture');
            const current = lock.value as EpochHeader & { ownerDigest: string; lockFence: string; lockExpiresAt: string; epochHeaderDigest: string };
            await super.put(this.lockKey, {
                ...current,
                ownerDigest: this.takeoverOwner,
                lockFence: '2',
                lockExpiresAt: '2026-09-07T00:01:00.000Z',
            }, { ifGenerationMatch: lock.generation });
            this.takenOver = true;
        }
        return stored;
    }
}

const digest = (value: string) => canonicalDigest(value);
const header: EpochHeader = {
    epochIdDigest: digest('epoch'), capabilityDigest: digest('capability'), oldManifestDigest: digest('old'),
    desiredManifestDigest: digest('desired'), roleSetDigest: digest('roles'), sourcePlanDigest: digest('source'),
    createdAt: '2026-09-07T00:00:00.000Z',
};

function transition(sequence: number, fromState: EpochTransition['fromState'], toState: EpochTransition['toState'], fence: string): EpochTransition {
    return {
        sequence, epochIdDigest: header.epochIdDigest, fromState, toState, stateVersion: sequence,
        lockFence: fence, preconditionDigest: digest(`precondition-${sequence}`), mutationDigest: digest(`mutation-${sequence}`),
        postconditionDigest: digest(`postcondition-${sequence}`), proofDigest: digest(`proof-${sequence}`),
        nativeConcurrencyTokenDigest: digest(`native-${sequence}`), resourceObservationDigest: digest(`resource-${sequence}`),
        resultCode: 'OK', recordedAt: `2026-09-07T00:00:0${sequence}.000Z`,
    };
}

describe('generation-fenced epoch journal', () => {
    it('creates an immutable header and derives contiguous state', async () => {
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => 1_000, leaseMs: 10_000 });
        expect(journal.headerKey).toBe(`epoch/epoch-header/${header.epochIdDigest}/${header.desiredManifestDigest}.json`);
        expect(journal.journalPrefix).toBe(`epoch/epoch-journal/${header.epochIdDigest}/`);
        await journal.ensureHeader();
        await journal.ensureHeader();
        const lease = await journal.acquire(digest('owner-a'));
        await journal.append(lease, transition(1, null, 'PREPARED', lease.lock.lockFence));
        await journal.append(lease, transition(2, 'PREPARED', 'STAGED', lease.lock.lockFence));
        const state = await journal.deriveState();
        expect(state.state).toBe('STAGED');
        expect(state.transitions).toHaveLength(2);
    });

    it('rejects a conflicting desired header in the same epoch namespace', async () => {
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => 1_000, leaseMs: 10_000 });
        const conflicting = { ...header, desiredManifestDigest: digest('other-desired') };
        await storage.put(`epoch/epoch-header/${header.epochIdDigest}/${conflicting.desiredManifestDigest}.json`, conflicting, { ifGenerationMatch: '0' });
        await expect(journal.ensureHeader()).rejects.toThrow('JOURNAL_INVALID');
    });

    it('makes ABORTED a terminal append marker', async () => {
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => 1_000, leaseMs: 10_000 });
        await journal.ensureHeader();
        const lease = await journal.acquire(digest('owner-abort'));
        await journal.append(lease, { ...transition(1, null, null, lease.lock.lockFence), resultCode: 'ABORTED' });
        const state = await journal.deriveState();
        expect(state).toMatchObject({ state: null, aborted: true });
        await expect(journal.append(lease, transition(2, null, 'PREPARED', lease.lock.lockFence))).rejects.toThrow('ABORTED_EPOCH');

        const laterStorage = new MemoryStorage();
        const laterJournal = new EpochJournal(laterStorage, { header, now: () => 1_000, leaseMs: 10_000 });
        await laterJournal.ensureHeader();
        const laterLease = await laterJournal.acquire(digest('owner-abort-later'));
        await laterJournal.append(laterLease, transition(1, null, 'PREPARED', laterLease.lock.lockFence));
        await laterJournal.append(laterLease, { ...transition(2, 'PREPARED', 'STAGED', laterLease.lock.lockFence) });
        await laterJournal.append(laterLease, { ...transition(3, 'STAGED', 'STAGED', laterLease.lock.lockFence), resultCode: 'ABORTED' });
        await expect(laterJournal.append(laterLease, transition(4, 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', laterLease.lock.lockFence))).rejects.toThrow('ABORTED_EPOCH');
        expect((await laterJournal.deriveState()).state).toBe('STAGED');
    });

    it('rejects duplicate, missing, reordered, or content-mismatched transitions', async () => {
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => 1_000, leaseMs: 10_000 });
        await journal.ensureHeader();
        const lease = await journal.acquire(digest('owner-b'));
        const first = transition(1, null, 'PREPARED', lease.lock.lockFence);
        await journal.append(lease, first);
        await expect(journal.append(lease, first)).rejects.toThrow('GENERATION_PRECONDITION_FAILED');
        await expect(journal.append(lease, transition(3, 'PREPARED', 'STAGED', lease.lock.lockFence))).rejects.toThrow('JOURNAL_INVALID');

        const entries = await storage.list(journal.journalPrefix);
        const duplicate = transition(1, null, 'PREPARED', lease.lock.lockFence);
        await storage.put(`${journal.journalPrefix}00000001/${digest('other')}.json`, duplicate, { ifGenerationMatch: '0' });
        await expect(journal.deriveState()).rejects.toThrow('JOURNAL_INVALID');
        expect(entries.length).toBe(1);
    });

    it('fences an expired owner and permits takeover only with a new fence', async () => {
        let now = 1_000;
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => now, leaseMs: 100 });
        await journal.ensureHeader();
        const first = await journal.acquire(digest('owner-c'));
        now = 1_101;
        await expect(journal.append(first, transition(1, null, 'PREPARED', first.lock.lockFence))).rejects.toThrow('LOCK_LOST');
        const second = await journal.acquire(digest('owner-d'));
        expect(Number(second.lock.lockFence)).toBeGreaterThan(Number(first.lock.lockFence));
        await journal.append(second, transition(1, null, 'PREPARED', second.lock.lockFence));
        await expect(journal.renew(first)).rejects.toThrow('LOCK_LOST');
    });

    it('rejects malformed headers, stale fence transitions, and generation races', async () => {
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => 1_000, leaseMs: 10_000 });
        await journal.ensureHeader();
        const lease = await journal.acquire(digest('owner-e'));
        const stale = { ...lease, generation: '0' };
        await expect(journal.append(stale, transition(1, null, 'PREPARED', lease.lock.lockFence))).rejects.toThrow('LOCK_LOST');
        const bad = { ...transition(1, null, 'PREPARED', lease.lock.lockFence), epochIdDigest: digest('wrong-epoch') };
        await expect(journal.append(lease, bad)).rejects.toThrow(EpochError);
    });

    it('rejects a transition carrying a future fence and requires a live lock for inspection', async () => {
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => 1_000, leaseMs: 10_000 });
        await journal.ensureHeader();
        const lease = await journal.acquire(digest('owner-future'));
        await journal.append(lease, transition(1, null, 'PREPARED', lease.lock.lockFence));
        const future = transition(2, 'PREPARED', 'STAGED', '999');
        await storage.put(`${journal.journalPrefix}00000002/${canonicalDigest(future)}.json`, future, { ifGenerationMatch: '0' });
        await expect(journal.deriveState(lease)).rejects.toThrow('JOURNAL_INVALID');

        const lock = await storage.get(journal.lockKey);
        if (!lock) throw new Error('missing lock fixture');
        await storage.delete!(journal.lockKey, { ifGenerationMatch: lock.generation });
        await expect(journal.deriveState()).rejects.toThrow('LOCK_LOST');
    });

    it('rejects malformed active locks and marks older-fence history for fresh reconciliation', async () => {
        let now = 1_000;
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => now, leaseMs: 100 });
        await journal.ensureHeader();
        const first = await journal.acquire(digest('owner-history'));
        await journal.append(first, transition(1, null, 'PREPARED', first.lock.lockFence));
        now = 1_101;
        const second = await journal.acquire(digest('owner-history-new'));
        const resumed = await journal.readValidatedState(second);
        expect(resumed).toMatchObject({ state: 'PREPARED', activeFence: '2', requiresReconciliation: true });

        const lock = await storage.get(journal.lockKey);
        if (!lock) throw new Error('missing lock fixture');
        await storage.put(journal.lockKey, { malformed: true }, { ifGenerationMatch: lock.generation });
        await expect(journal.deriveState()).rejects.toThrow('JOURNAL_INVALID');
    });

    it('rejects an expired active lock for unleased replay inspection', async () => {
        let now = 1_000;
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => now, leaseMs: 100 });
        await journal.ensureHeader();
        const lease = await journal.acquire(digest('owner-expired-inspection'));
        await journal.append(lease, transition(1, null, 'PREPARED', lease.lock.lockFence));
        now = 1_101;
        await expect(journal.readValidatedState()).rejects.toThrow('LOCK_LOST');
    });

    it('retains a late stale append but forces resumed-owner reconciliation', async () => {
        const storage = new TakeoverDuringAppendStorage();
        const journal = new EpochJournal(storage, { header, now: () => 1_000, leaseMs: 10_000 });
        await journal.ensureHeader();
        const ownerA = await journal.acquire(digest('owner-late-a'));
        storage.lockKey = journal.lockKey;
        storage.journalPrefix = journal.journalPrefix;
        storage.takeoverOwner = digest('owner-late-b');
        await expect(journal.append(ownerA, transition(1, null, 'PREPARED', ownerA.lock.lockFence))).rejects.toThrow('LOCK_LOST');

        const ownerB = await journal.acquire(digest('owner-late-b'));
        const resumed = await journal.readValidatedState(ownerB);
        expect(resumed).toMatchObject({ state: 'PREPARED', activeFence: '2', requiresReconciliation: true });
        expect(resumed.transitions[0]?.lockFence).toBe('1');
    });
});
