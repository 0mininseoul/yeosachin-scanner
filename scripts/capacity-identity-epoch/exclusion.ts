import { EpochError, canonicalDigest, epochFail } from './contracts';

export type ReservationObject = Readonly<{ generation: string; value: unknown }>;

export interface ReservationStorage {
    get(key: string): Promise<ReservationObject | null>;
    put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<ReservationObject>;
    delete?(key: string, options: { ifGenerationMatch: string }): Promise<void>;
}

interface GuardedReservationStorage extends ReservationStorage {
    putWithDispatchGuard(
        key: string,
        value: unknown,
        options: { ifGenerationMatch: '0' | string },
        beforeDispatch: () => Promise<void>,
    ): Promise<ReservationObject>;
}

export type ReservationRecord = Readonly<{
    scopeDigest: string;
    epochDigest: string;
    ownerDigest: string;
    lockFence: string;
    lockExpiresAt: string;
}>;

export type ReservationLease = Readonly<{
    generation: string;
    record: ReservationRecord;
    /** One member per exact resource for a resource-set reservation. */
    members?: readonly ReservationLeaseMember[];
}>;

export type ReservationLeaseMember = Readonly<{
    key: string;
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

function resourceScope(resources: readonly string[]): readonly string[] {
    if (resources.length === 0 || resources.some(resource => typeof resource !== 'string' || resource.length === 0 || resource.length > 1024)) {
        epochFail('RESOURCE_INVALID');
    }
    const unique = [...new Set(resources)].sort();
    if (unique.length !== resources.length) epochFail('RESOURCE_INVALID');
    return Object.freeze(unique);
}

/**
 * Stable digest for the exact provider resources protected by a mutation
 * interval.  The resource strings never enter the journal record or logs;
 * only this digest is persisted.  Callers must derive this list from a
 * reviewed packet or an exact legacy entry-point selector, never from an
 * arbitrary epoch label.
 */
export function reservationScopeDigest(resources: readonly string[]): string {
    return canonicalDigest({ kind: 'capacity-resource-scope-v1', resources: resourceScope(resources) });
}

/** Digest/key for one exact resource in an overlapping reservation set. */
export function reservationResourceDigest(resource: string): string {
    const [validated] = resourceScope([resource]);
    return canonicalDigest({ kind: 'capacity-resource-v1', resource: validated });
}

export function reservationResourceKey(resource: string): string {
    return `epoch-reservation/${reservationResourceDigest(resource)}.lock`;
}

function ensureGeneration(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !GENERATION.test(value)) epochFail('JOURNAL_INVALID');
}

function ensureRecord(value: unknown): asserts value is ReservationRecord {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) epochFail('JOURNAL_INVALID');
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'epochDigest,lockExpiresAt,lockFence,ownerDigest,scopeDigest'
        || typeof record.scopeDigest !== 'string' || !DIGEST.test(record.scopeDigest)
        || typeof record.epochDigest !== 'string' || !DIGEST.test(record.epochDigest)
        || typeof record.ownerDigest !== 'string' || !DIGEST.test(record.ownerDigest)
        || typeof record.lockFence !== 'string' || !FENCE.test(record.lockFence)
        || typeof record.lockExpiresAt !== 'string' || !Number.isFinite(Date.parse(record.lockExpiresAt))) epochFail('JOURNAL_INVALID');
}

function expired(record: ReservationRecord, now: number): boolean {
    return Date.parse(record.lockExpiresAt) <= now;
}

export class CapacityReservation {
    readonly reservationDigest: string;
    readonly scopeDigest: string;
    readonly key: string;
    readonly keys: readonly string[];
    private readonly storage: ReservationStorage;
    private readonly now: () => number;
    private readonly leaseMs: number;
    private readonly members: readonly Readonly<{ key: string; scopeDigest: string }>[];

    constructor(storage: ReservationStorage, options: {
        /** Compatibility-only selector for old unit callers. New bridges must use resources. */
        namespace?: string;
        /** Exact affected provider resource identities for this reservation. */
        resources?: readonly string[];
        now?: () => number;
        leaseMs?: number;
    }) {
        const hasNamespace = options.namespace !== undefined;
        const hasResources = options.resources !== undefined;
        if (hasNamespace === hasResources) epochFail('RESOURCE_INVALID');
        if (hasNamespace && !/^[a-z0-9-]{1,48}$/.test(options.namespace!)) epochFail('LOCK_NAMESPACE_MISMATCH');
        const resources = hasResources ? resourceScope(options.resources!) : undefined;
        const scopeDigest = resources
            ? reservationScopeDigest(resources)
            : canonicalDigest({ kind: 'legacy-namespace-scope-v1', namespace: options.namespace });
        this.storage = storage;
        this.scopeDigest = scopeDigest;
        this.reservationDigest = scopeDigest;
        this.members = Object.freeze(resources
            ? resources.map(resource => ({ key: reservationResourceKey(resource), scopeDigest: reservationResourceDigest(resource) }))
            : [{ key: `epoch-reservation/${scopeDigest}.lock`, scopeDigest }]);
        this.keys = Object.freeze(this.members.map(member => member.key));
        this.key = this.keys[0]!;
        this.now = options.now ?? (() => Date.now());
        this.leaseMs = options.leaseMs ?? 60_000;
        if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0 || this.leaseMs > 15 * 60_000) epochFail('JOURNAL_INVALID');
    }

    async acquire(epochDigest: string, ownerDigest: string): Promise<ReservationLease> {
        ensureDigest(epochDigest);
        ensureDigest(ownerDigest);
        const acquired: ReservationLeaseMember[] = [];
        try {
            for (const member of this.members) {
                acquired.push(await this.acquireOne(member, epochDigest, ownerDigest));
            }
        } catch (error) {
            for (const member of acquired.reverse()) {
                try { await this.releaseOne(member); } catch { /* retain the original failure; caller must stop closed */ }
            }
            throw error;
        }
        if (acquired.length === 1) {
            const only = acquired[0]!;
            return { generation: only.generation, record: only.record };
        }
        const first = acquired[0]!;
        return { generation: first.generation, record: first.record, members: Object.freeze(acquired) };
    }

    private async acquireOne(member: Readonly<{ key: string; scopeDigest: string }>, epochDigest: string, ownerDigest: string): Promise<ReservationLeaseMember> {
        const existing = await this.storage.get(member.key);
        if (!existing) {
            const record: ReservationRecord = {
                scopeDigest: member.scopeDigest,
                epochDigest, ownerDigest, lockFence: '1',
                lockExpiresAt: new Date(this.now() + this.leaseMs).toISOString(),
            };
            try {
                const created = await this.storage.put(member.key, record, { ifGenerationMatch: '0' });
                ensureGeneration(created.generation);
                return { key: member.key, generation: created.generation, record };
            } catch {
                epochFail('GENERATION_PRECONDITION_FAILED');
            }
        }
        ensureGeneration(existing.generation);
        ensureRecord(existing.value);
        const current = existing.value as ReservationRecord;
        if (!expired(current, this.now())) epochFail('LOCK_LOST');
        const record: ReservationRecord = {
            scopeDigest: member.scopeDigest,
            epochDigest, ownerDigest,
            lockFence: incrementDecimal(current.lockFence),
            lockExpiresAt: new Date(this.now() + this.leaseMs).toISOString(),
        };
        try {
            const replaced = await this.storage.put(member.key, record, { ifGenerationMatch: existing.generation });
            ensureGeneration(replaced.generation);
            return { key: member.key, generation: replaced.generation, record };
        } catch {
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async assert(lease: ReservationLease): Promise<void> {
        const members = this.leaseMembers(lease);
        for (const member of members) {
            const current = await this.currentMember(member);
            if (expired(current.record, this.now())) epochFail('LOCK_LOST');
        }
    }

    async renew(lease: ReservationLease): Promise<ReservationLease> {
        const members = this.leaseMembers(lease);
        const renewed: ReservationLeaseMember[] = [];
        try {
            for (const member of members) {
                const current = await this.currentMember(member);
                if (expired(current.record, this.now())) epochFail('LOCK_LOST');
                const record: ReservationRecord = { ...current.record, lockExpiresAt: new Date(this.now() + this.leaseMs).toISOString() };
                const replaced = await this.putWithDispatchGuard(
                    member.key,
                    record,
                    { ifGenerationMatch: current.generation },
                    async () => {
                        const live = await this.currentMember(member);
                        if (expired(live.record, this.now())) epochFail('LOCK_LOST');
                    },
                );
                ensureGeneration(replaced.generation);
                renewed.push({ key: member.key, generation: replaced.generation, record });
            }
        } catch (error) {
            const candidates = [...members, ...renewed];
            const seen = new Set<string>();
            for (const member of candidates) {
                if (seen.has(member.key)) continue;
                seen.add(member.key);
                try {
                    await this.releaseOwnedMember(member);
                } catch {
                    // Never remove an unknown or foreign generation while
                    // attempting to clean only this renewal's owned writes.
                }
            }
            if (error instanceof EpochError) throw error;
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
        const first = renewed[0]!;
        if (renewed.length === 1) return { generation: first.generation, record: first.record };
        return { generation: first.generation, record: first.record, members: Object.freeze(renewed) };
    }

    private leaseMembers(lease: ReservationLease): readonly ReservationLeaseMember[] {
        if (this.members.length === 1) {
            if (lease.members !== undefined) epochFail('LOCK_LOST');
            return [{ key: this.key, generation: lease.generation, record: lease.record }];
        }
        if (lease.members === undefined || lease.members.length !== this.members.length) epochFail('LOCK_LOST');
        for (let index = 0; index < this.members.length; index += 1) {
            if (lease.members[index]!.key !== this.members[index]!.key) epochFail('LOCK_LOST');
        }
        return lease.members;
    }

    async release(lease: ReservationLease): Promise<void> {
        const members = this.leaseMembers(lease);
        if (!this.storage.delete) epochFail('ADAPTER_REQUEST_INVALID');
        let firstError: unknown;
        for (const member of members) {
            try {
                const existing = await this.storage.get(member.key);
                if (!existing) continue;
                const current = await this.currentMember(member);
                await this.releaseOne(current);
            } catch (error) {
                firstError ??= error;
            }
        }
        if (firstError instanceof EpochError) throw firstError;
        if (firstError !== undefined) epochFail('GENERATION_PRECONDITION_FAILED');
    }

    private async putWithDispatchGuard(
        key: string,
        value: unknown,
        options: { ifGenerationMatch: '0' | string },
        beforeDispatch: () => Promise<void>,
    ): Promise<ReservationObject> {
        const guarded = this.storage as GuardedReservationStorage;
        if (typeof guarded.putWithDispatchGuard === 'function') {
            return guarded.putWithDispatchGuard(key, value, options, beforeDispatch);
        }
        await beforeDispatch();
        return this.storage.put(key, value, options);
    }

    private async releaseOwnedMember(member: ReservationLeaseMember): Promise<void> {
        if (!this.storage.delete) epochFail('ADAPTER_REQUEST_INVALID');
        const existing = await this.storage.get(member.key);
        if (!existing) return;
        ensureGeneration(existing.generation);
        ensureRecord(existing.value);
        const record = existing.value as ReservationRecord;
        if (record.scopeDigest !== member.record.scopeDigest
            || record.epochDigest !== member.record.epochDigest
            || record.ownerDigest !== member.record.ownerDigest
            || record.lockFence !== member.record.lockFence) return;
        await this.releaseOne({ key: member.key, generation: existing.generation, record });
    }

    private async currentMember(lease: ReservationLeaseMember): Promise<ReservationLeaseMember> {
        ensureGeneration(lease.generation);
        ensureRecord(lease.record);
        const current = await this.storage.get(lease.key);
        if (!current) epochFail('LOCK_LOST');
        ensureGeneration(current.generation);
        ensureRecord(current.value);
        const record = current.value as ReservationRecord;
        if (current.generation !== lease.generation
            || record.scopeDigest !== lease.record.scopeDigest
            || record.epochDigest !== lease.record.epochDigest
            || record.ownerDigest !== lease.record.ownerDigest
            || record.lockFence !== lease.record.lockFence) epochFail('LOCK_LOST');
        return { key: lease.key, generation: current.generation, record };
    }

    private async releaseOne(member: ReservationLeaseMember): Promise<void> {
        if (!this.storage.delete) epochFail('ADAPTER_REQUEST_INVALID');
        try {
            await this.storage.delete(member.key, { ifGenerationMatch: member.generation });
        } catch (error) {
            if (error instanceof EpochError) throw error;
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }
}

export { EpochError };
