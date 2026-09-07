import { EpochError, canonicalDigest, epochFail } from './contracts';

export type ReservationObject = Readonly<{ generation: string; value: unknown }>;

export interface ReservationStorage {
    get(key: string): Promise<ReservationObject | null>;
    put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<ReservationObject>;
    delete(key: string, options: { ifGenerationMatch: string }): Promise<void>;
}

export type ReservationRecord = Readonly<{
    epochDigest: string;
    ownerDigest: string;
    lockFence: string;
    lockExpiresAt: string;
}>;

export type ReservationLease = Readonly<{
    generation: string;
    record: ReservationRecord;
}>;

const DIGEST = /^[0-9a-f]{64}$/;
const FENCE = /^[1-9][0-9]*$/;
const GENERATION = /^[1-9][0-9]*$/;

function incrementDecimal(value: string): string {
    const digits = value.split('');
    let index = digits.length - 1;
    while (index >= 0 && digits[index] === '9') {
        digits[index] = '0';
        index -= 1;
    }
    if (index < 0) digits.unshift('1');
    else digits[index] = String(Number(digits[index]) + 1);
    return digits.join('');
}

function ensureDigest(value: string): void {
    if (!DIGEST.test(value)) epochFail('CAPABILITY_INVALID');
}

function ensureGeneration(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !GENERATION.test(value)) epochFail('JOURNAL_INVALID');
}

function ensureRecord(value: unknown): asserts value is ReservationRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) epochFail('JOURNAL_INVALID');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'epochDigest,lockExpiresAt,lockFence,ownerDigest'
        || typeof record.epochDigest !== 'string' || !DIGEST.test(record.epochDigest)
        || typeof record.lockFence !== 'string' || !FENCE.test(record.lockFence)
        || typeof record.lockExpiresAt !== 'string' || !Number.isFinite(Date.parse(record.lockExpiresAt))) epochFail('JOURNAL_INVALID');
}

function expired(record: ReservationRecord, now: number): boolean {
    return Date.parse(record.lockExpiresAt) <= now;
}

export class CapacityReservation {
    readonly reservationDigest: string;
    readonly key: string;
    private readonly storage: ReservationStorage;
    private readonly now: () => number;
    private readonly leaseMs: number;

    constructor(storage: ReservationStorage, options: { namespace: string; now?: () => number; leaseMs?: number }) {
        if (!/^[a-z0-9-]{1,48}$/.test(options.namespace)) epochFail('LOCK_NAMESPACE_MISMATCH');
        this.storage = storage;
        this.reservationDigest = canonicalDigest(options.namespace);
        this.key = `epoch-reservation/${this.reservationDigest}.lock`;
        this.now = options.now ?? (() => Date.now());
        this.leaseMs = options.leaseMs ?? 60_000;
        if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0 || this.leaseMs > 15 * 60_000) epochFail('JOURNAL_INVALID');
    }

    async acquire(epochDigest: string, ownerDigest: string): Promise<ReservationLease> {
        ensureDigest(epochDigest);
        ensureDigest(ownerDigest);
        const existing = await this.storage.get(this.key);
        if (!existing) {
            const record: ReservationRecord = {
                epochDigest, ownerDigest, lockFence: '1',
                lockExpiresAt: new Date(this.now() + this.leaseMs).toISOString(),
            };
            try {
                const created = await this.storage.put(this.key, record, { ifGenerationMatch: '0' });
                ensureGeneration(created.generation);
                return { generation: created.generation, record };
            } catch {
                epochFail('GENERATION_PRECONDITION_FAILED');
            }
        }
        ensureGeneration(existing.generation);
        ensureRecord(existing.value);
        const current = existing.value as ReservationRecord;
        if (!expired(current, this.now())) epochFail('LOCK_LOST');
        const record: ReservationRecord = {
            epochDigest, ownerDigest,
            lockFence: incrementDecimal(current.lockFence),
            lockExpiresAt: new Date(this.now() + this.leaseMs).toISOString(),
        };
        try {
            const replaced = await this.storage.put(this.key, record, { ifGenerationMatch: existing.generation });
            ensureGeneration(replaced.generation);
            return { generation: replaced.generation, record };
        } catch {
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async assert(lease: ReservationLease): Promise<void> {
        const current = await this.current(lease);
        if (expired(current.record, this.now())) epochFail('LOCK_LOST');
    }

    async renew(lease: ReservationLease): Promise<ReservationLease> {
        const current = await this.current(lease);
        if (expired(current.record, this.now())) epochFail('LOCK_LOST');
        const record = { ...current.record, lockExpiresAt: new Date(this.now() + this.leaseMs).toISOString() };
        try {
            const replaced = await this.storage.put(this.key, record, { ifGenerationMatch: current.generation });
            ensureGeneration(replaced.generation);
            return { generation: replaced.generation, record };
        } catch {
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async release(lease: ReservationLease): Promise<void> {
        const current = await this.current(lease);
        try {
            await this.storage.delete(this.key, { ifGenerationMatch: current.generation });
        } catch (error) {
            if (error instanceof EpochError) throw error;
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    private async current(lease: ReservationLease): Promise<ReservationLease> {
        ensureGeneration(lease.generation);
        ensureRecord(lease.record);
        const current = await this.storage.get(this.key);
        if (!current) epochFail('LOCK_LOST');
        ensureGeneration(current.generation);
        ensureRecord(current.value);
        const record = current.value as ReservationRecord;
        if (current.generation !== lease.generation
            || record.epochDigest !== lease.record.epochDigest
            || record.ownerDigest !== lease.record.ownerDigest
            || record.lockFence !== lease.record.lockFence) epochFail('LOCK_LOST');
        return { generation: current.generation, record };
    }
}

export { EpochError };
