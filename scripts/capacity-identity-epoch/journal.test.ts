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
        await journal.ensureHeader();
        await journal.ensureHeader();
        const lease = await journal.acquire(digest('owner-a'));
        await journal.append(lease, transition(1, null, 'PREPARED', lease.lock.lockFence));
        await journal.append(lease, transition(2, 'PREPARED', 'STAGED', lease.lock.lockFence));
        const state = await journal.deriveState();
        expect(state.state).toBe('STAGED');
        expect(state.transitions).toHaveLength(2);
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
        await storage.put(`${journal.journalPrefix}00000001-${digest('other')}.json`, duplicate, { ifGenerationMatch: '0' });
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
});
