import {
    STATES,
    canonicalDigest,
    hasExactKeys,
    isDigest,
    isState,
    EpochError,
    epochFail,
    isObject,
    type EpochHeader,
    type EpochLock,
    type EpochTransition,
    type State,
} from './contracts';
import { CapacityReservation } from './exclusion';
import type { GuardedJournalStorage } from './gcs';

export type StoredObject = Readonly<{
    generation: string;
    value: unknown;
}>;

export interface JournalStorage {
    get(key: string): Promise<StoredObject | null>;
    put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<StoredObject>;
    list(prefix: string): Promise<ReadonlyArray<StoredObject & { key: string }>>;
    delete?(key: string, options: { ifGenerationMatch: string }): Promise<void>;
}

export type JournalLease = Readonly<{
    generation: string;
    lock: EpochLock;
}>;

export type JournalEvidenceBaseline = Readonly<{
    capturedAtMs: number;
    digest: string;
    epochHeaderDigest: string;
    packetDigest: string;
    transitionCommitment: string;
    ownerDigest: string;
    lockFence: string;
}>;

const HEADER_KEYS = [
    'epochIdDigest', 'capabilityDigest', 'oldManifestDigest', 'desiredManifestDigest',
    'roleSetDigest', 'sourcePlanDigest', 'createdAt',
] as const;
const LOCK_KEYS = ['epochHeaderDigest', 'ownerDigest', 'lockFence', 'lockExpiresAt'] as const;
const TRANSITION_KEYS = [
    'sequence', 'epochIdDigest', 'fromState', 'toState', 'stateVersion', 'lockFence',
    'preconditionDigest', 'mutationDigest', 'postconditionDigest', 'proofDigest',
    'nativeConcurrencyTokenDigest', 'resourceObservationDigest', 'resultCode', 'recordedAt',
] as const;
const GENERATION = /^[1-9][0-9]*$/;
const OWNER = /^[0-9a-f]{64}$/;
const MAX_LEASE_MS = 15 * 60_000;

function safeTimestamp(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value));
}

function assertGeneration(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !GENERATION.test(value)) epochFail('JOURNAL_INVALID');
}

function validateHeader(value: unknown): asserts value is EpochHeader {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !hasExactKeys(value, HEADER_KEYS)) epochFail('JOURNAL_INVALID');
    const header = value as Record<string, unknown>;
    if (!isDigest(header.epochIdDigest) || !isDigest(header.capabilityDigest)
        || !isDigest(header.oldManifestDigest) || !isDigest(header.desiredManifestDigest)
        || !isDigest(header.roleSetDigest) || !isDigest(header.sourcePlanDigest)
        || !safeTimestamp(header.createdAt)) epochFail('JOURNAL_INVALID');
}

/** Validate a retained header before it is adopted for a resumed bootstrap. */
export function validateEpochHeader(value: unknown): asserts value is EpochHeader {
    validateHeader(value);
}

function validateLock(value: unknown, headerDigest: string): asserts value is EpochLock {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !hasExactKeys(value, LOCK_KEYS)) epochFail('JOURNAL_INVALID');
    const lock = value as Record<string, unknown>;
    if (lock.epochHeaderDigest !== headerDigest
        || !isDigest(lock.ownerDigest)
        || typeof lock.lockFence !== 'string' || !GENERATION.test(lock.lockFence)
        || !safeTimestamp(lock.lockExpiresAt)) epochFail('JOURNAL_INVALID');
}

function validateTransition(value: unknown, header: EpochHeader, expectedFence?: string): asserts value is EpochTransition {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !hasExactKeys(value, TRANSITION_KEYS)) epochFail('JOURNAL_INVALID');
    const transition = value as Record<string, unknown>;
    const sequence = transition.sequence as unknown;
    const stateVersion = transition.stateVersion as unknown;
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1 || (sequence as number) > 99_999_999
        || !Number.isSafeInteger(stateVersion) || stateVersion !== sequence
        || transition.epochIdDigest !== header.epochIdDigest
        || (transition.fromState !== null && !isState(transition.fromState))
        || typeof transition.lockFence !== 'string' || !GENERATION.test(transition.lockFence)
        || (expectedFence !== undefined && transition.lockFence !== expectedFence)
        || !isDigest(transition.preconditionDigest) || !isDigest(transition.mutationDigest)
        || !isDigest(transition.postconditionDigest) || !isDigest(transition.proofDigest)
        || !isDigest(transition.nativeConcurrencyTokenDigest) || !isDigest(transition.resourceObservationDigest)
        || (transition.resultCode !== 'OK' && transition.resultCode !== 'RECONCILED' && transition.resultCode !== 'ABORTED')
        || !safeTimestamp(transition.recordedAt)) epochFail('JOURNAL_INVALID');
    if (transition.resultCode === 'ABORTED') {
        if (transition.toState !== transition.fromState) epochFail('JOURNAL_INVALID');
    } else if (!isState(transition.toState)) {
        epochFail('JOURNAL_INVALID');
    }
}

/**
 * Stable digest of the transition/substep commitment retained with the
 * zero-work baseline.  `recordedAt` and the journal object generation are
 * intentionally excluded so a retry after an append interruption can prove
 * the same PREPARED substep without recapturing a later baseline window.
 */
export function transitionCommitment(transition: Pick<EpochTransition,
    'sequence' | 'fromState' | 'toState' | 'stateVersion' | 'lockFence'
    | 'preconditionDigest' | 'mutationDigest' | 'postconditionDigest'
    | 'proofDigest' | 'nativeConcurrencyTokenDigest' | 'resourceObservationDigest'
    | 'resultCode'>): string {
    return canonicalDigest({
        sequence: transition.sequence,
        fromState: transition.fromState,
        toState: transition.toState,
        stateVersion: transition.stateVersion,
        lockFence: transition.lockFence,
        preconditionDigest: transition.preconditionDigest,
        mutationDigest: transition.mutationDigest,
        postconditionDigest: transition.postconditionDigest,
        proofDigest: transition.proofDigest,
        nativeConcurrencyTokenDigest: transition.nativeConcurrencyTokenDigest,
        resourceObservationDigest: transition.resourceObservationDigest,
        resultCode: transition.resultCode,
    });
}

function lockExpiry(now: number, leaseMs: number): string {
    return new Date(now + leaseMs).toISOString();
}

function isExpired(lock: EpochLock, now: number): boolean {
    const expires = Date.parse(lock.lockExpiresAt);
    return !Number.isFinite(expires) || expires <= now;
}

function compareDecimal(left: string, right: string): number {
    const a = left.replace(/^0+/, '') || '0';
    const b = right.replace(/^0+/, '') || '0';
    return a.length === b.length ? (a === b ? 0 : (a > b ? 1 : -1)) : (a.length > b.length ? 1 : -1);
}

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

function nextFence(lock: EpochLock | null): string {
    return lock ? incrementDecimal(lock.lockFence) : '1';
}

export class EpochJournal {
    readonly epochIdDigest: string;
    readonly epochHeaderDigest: string;
    readonly headerKey: string;
    readonly lockKey: string;
    readonly baselineKey: string;
    readonly journalPrefix: string;
    private readonly headerPrefix: string;
    private readonly storage: JournalStorage;
    private readonly header: EpochHeader;
    private readonly now: () => number;
    private readonly leaseMs: number;

    constructor(storage: JournalStorage, options: {
        header: EpochHeader;
        now?: () => number;
        leaseMs?: number;
        keyPrefix?: string;
    }) {
        validateHeader(options.header);
        this.storage = storage;
        this.header = Object.freeze({ ...options.header });
        this.epochIdDigest = options.header.epochIdDigest;
        this.epochHeaderDigest = canonicalDigest(options.header);
        const prefix = options.keyPrefix ?? 'epoch';
        if (!/^[a-z0-9-]{1,32}$/.test(prefix)) epochFail('JOURNAL_INVALID');
        this.headerPrefix = `${prefix}/epoch-header/${options.header.epochIdDigest}/`;
        this.headerKey = `${this.headerPrefix}${options.header.desiredManifestDigest}.json`;
        this.lockKey = `${prefix}/epoch-lock/${this.epochHeaderDigest}.lock`;
        // Bind the baseline object family to the immutable header, not merely
        // the caller-supplied epoch label.  Reusing an epoch id with a changed
        // packet therefore cannot adopt a prior zero-work window.
        this.baselineKey = `${prefix}/epoch-baseline/${this.epochHeaderDigest}.json`;
        this.journalPrefix = `${prefix}/epoch-journal/${options.header.epochIdDigest}/`;
        this.now = options.now ?? (() => Date.now());
        this.leaseMs = options.leaseMs ?? 60_000;
        if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0 || this.leaseMs > MAX_LEASE_MS) epochFail('JOURNAL_INVALID');
    }

    /**
     * The immutable header projection is part of the authority boundary. A
     * caller may compare it with the reviewed packet before deriving a lease
     * capability, but cannot mutate the journal's header after construction.
     */
    get epochHeader(): EpochHeader {
        return this.header;
    }

    /**
     * Return the generation-fenced reservation shared by epochs and ordinary
     * capacity writers.  It uses this journal's storage and clock, but has a
     * separate reservation object family so it cannot become a second state
     * machine or be mistaken for the append-only epoch journal.
     */
    createSharedReservation(resources: readonly string[], leaseMs = this.leaseMs): CapacityReservation {
        return new CapacityReservation(this.storage, { resources, now: this.now, leaseMs });
    }

    private async putWithLeaseGuard(
        key: string,
        value: unknown,
        options: { ifGenerationMatch: '0' | string },
        guard: () => Promise<void>,
    ): Promise<StoredObject> {
        const guarded = this.storage as JournalStorage & Partial<GuardedJournalStorage>;
        if (typeof guarded.putWithDispatchGuard === 'function') {
            return guarded.putWithDispatchGuard(key, value, options, guard);
        }
        await guard();
        return this.storage.put(key, value, options);
    }

    /**
     * Read-only admission helper.  Callers use this before a fresh epoch is
     * initialized so a rejected PREPARED admission cannot create a header or
     * lock as a side effect.  The retained object is validated exactly as it
     * is during ensureHeader; this method never writes.
     */
    async hasHeader(): Promise<boolean> {
        const existing = await this.storage.get(this.headerKey);
        if (!existing) return false;
        assertGeneration(existing.generation);
        validateHeader(existing.value);
        if (canonicalDigest(existing.value) !== this.epochHeaderDigest) epochFail('JOURNAL_INVALID');
        return true;
    }

    /** Read the digest-only evidence baseline retained for a resumed epoch. */
    async readEvidenceBaseline(lease?: JournalLease): Promise<JournalEvidenceBaseline | null> {
        if (lease) await this.assertWritableLease(lease);
        const existing = await this.storage.get(this.baselineKey);
        if (!existing) {
            if (lease) await this.assertWritableLease(lease);
            return null;
        }
        assertGeneration(existing.generation);
        if (!isObject(existing.value)) epochFail('JOURNAL_INVALID');
        const raw = existing.value as Record<string, unknown>;
        if (!hasExactKeys(raw, ['capturedAtMs', 'digest', 'epochHeaderDigest', 'packetDigest', 'transitionCommitment', 'ownerDigest', 'lockFence'])
            || !Number.isSafeInteger(raw.capturedAtMs) || (raw.capturedAtMs as number) < 0
            || !isDigest(raw.digest) || raw.epochHeaderDigest !== this.epochHeaderDigest
            || !isDigest(raw.packetDigest) || !isDigest(raw.transitionCommitment)
            || !isDigest(raw.ownerDigest) || typeof raw.lockFence !== 'string' || !GENERATION.test(raw.lockFence)) epochFail('JOURNAL_INVALID');
        const baseline = raw as JournalEvidenceBaseline;
        if (lease) await this.readLiveLock(lease);
        return {
            capturedAtMs: baseline.capturedAtMs,
            digest: baseline.digest,
            epochHeaderDigest: baseline.epochHeaderDigest,
            packetDigest: baseline.packetDigest,
            transitionCommitment: baseline.transitionCommitment,
            ownerDigest: baseline.ownerDigest,
            lockFence: baseline.lockFence,
        };
    }

    /**
     * Persist only the digest/timestamp baseline after a real lease exists.
     * A cold admission has no lease and therefore cannot call this method.
     */
    async persistEvidenceBaseline(lease: JournalLease, baseline: JournalEvidenceBaseline): Promise<void> {
        await this.assertWritableLease(lease);
        if (!Number.isSafeInteger(baseline.capturedAtMs) || baseline.capturedAtMs < 0
            || !isDigest(baseline.digest) || baseline.epochHeaderDigest !== this.epochHeaderDigest
            || !isDigest(baseline.packetDigest) || !isDigest(baseline.transitionCommitment)
            || baseline.ownerDigest !== lease.lock.ownerDigest || baseline.lockFence !== lease.lock.lockFence) epochFail('CAPABILITY_BINDING_MISMATCH');
        const existing = await this.storage.get(this.baselineKey);
        // The baseline GET is an awaitable race window. Revalidate both the
        // owner/fence and the derived journal state before adopting or writing
        // anything; an ABORTED marker under the same lock is not writable.
        await this.assertWritableLease(lease);
        if (existing) {
            assertGeneration(existing.generation);
            const retained = await this.readEvidenceBaseline(lease);
            if (!retained || retained.capturedAtMs !== baseline.capturedAtMs || retained.digest !== baseline.digest
                || retained.epochHeaderDigest !== baseline.epochHeaderDigest
                || retained.packetDigest !== baseline.packetDigest
                || retained.transitionCommitment !== baseline.transitionCommitment
                || retained.ownerDigest !== baseline.ownerDigest
                || retained.lockFence !== baseline.lockFence) epochFail('OBSERVATION_RACE');
            await this.assertWritableLease(lease);
            return;
        }
        await this.assertWritableLease(lease);
        try {
            const stored = 'putWithDispatchGuard' in this.storage
                ? await (this.storage as JournalStorage & GuardedJournalStorage).putWithDispatchGuard(
                    this.baselineKey,
                    baseline,
                    { ifGenerationMatch: '0' },
                    async () => { await this.assertWritableLease(lease); },
                )
                : await this.storage.put(this.baselineKey, baseline, { ifGenerationMatch: '0' });
            assertGeneration(stored.generation);
        } catch {
            const retained = await this.readEvidenceBaseline(lease);
            if (!retained || retained.capturedAtMs !== baseline.capturedAtMs || retained.digest !== baseline.digest
                || retained.epochHeaderDigest !== baseline.epochHeaderDigest
                || retained.packetDigest !== baseline.packetDigest
                || retained.transitionCommitment !== baseline.transitionCommitment
                || retained.ownerDigest !== baseline.ownerDigest
                || retained.lockFence !== baseline.lockFence) epochFail('GENERATION_PRECONDITION_FAILED');
        }
        await this.assertWritableLease(lease);
    }

    async ensureHeader(): Promise<void> {
        const headerEntries = await this.storage.list(this.headerPrefix);
        for (const entry of headerEntries) {
            assertGeneration(entry.generation);
            validateHeader(entry.value);
            const entryHeader = entry.value as EpochHeader;
            if (entry.key !== this.headerKey || entryHeader.epochIdDigest !== this.header.epochIdDigest
                || entryHeader.desiredManifestDigest !== this.header.desiredManifestDigest
                || canonicalDigest(entryHeader) !== this.epochHeaderDigest) epochFail('JOURNAL_INVALID');
        }
        const existing = await this.storage.get(this.headerKey);
        if (existing) {
            assertGeneration(existing.generation);
            validateHeader(existing.value);
            if (canonicalDigest(existing.value) !== this.epochHeaderDigest) epochFail('JOURNAL_INVALID');
            return;
        }
        try {
            const created = await this.storage.put(this.headerKey, this.header, { ifGenerationMatch: '0' });
            assertGeneration(created.generation);
        } catch (error) {
            if (error instanceof EpochError && error.code === 'GENERATION_PRECONDITION_FAILED') {
                const racedEntries = await this.storage.list(this.headerPrefix);
                for (const raced of racedEntries) {
                    assertGeneration(raced.generation);
                    validateHeader(raced.value);
                    const racedHeader = raced.value as EpochHeader;
                    if (raced.key === this.headerKey && canonicalDigest(racedHeader) === this.epochHeaderDigest) return;
                    epochFail('JOURNAL_INVALID');
                }
            }
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async acquire(ownerDigest: string): Promise<JournalLease> {
        if (!OWNER.test(ownerDigest)) epochFail('CAPABILITY_INVALID');
        await this.ensureHeader();
        const existing = await this.storage.get(this.lockKey);
        if (!existing) {
            const lock: EpochLock = {
                epochHeaderDigest: this.epochHeaderDigest,
                ownerDigest,
                lockFence: '1',
                lockExpiresAt: lockExpiry(this.now(), this.leaseMs),
            };
            try {
                const created = await this.storage.put(this.lockKey, lock, { ifGenerationMatch: '0' });
                assertGeneration(created.generation);
                return { generation: created.generation, lock };
            } catch {
                epochFail('GENERATION_PRECONDITION_FAILED');
            }
        }
        assertGeneration(existing.generation);
        validateLock(existing.value, this.epochHeaderDigest);
        const current = existing.value as EpochLock;
        if (!isExpired(current, this.now())) {
            if (current.ownerDigest !== ownerDigest) epochFail('LOCK_LOST');
            return { generation: existing.generation, lock: current };
        }
        const takeover: EpochLock = {
            epochHeaderDigest: this.epochHeaderDigest,
            ownerDigest,
            lockFence: nextFence(current),
            lockExpiresAt: lockExpiry(this.now(), this.leaseMs),
        };
        try {
            const replaced = await this.storage.put(this.lockKey, takeover, { ifGenerationMatch: existing.generation });
            assertGeneration(replaced.generation);
            return { generation: replaced.generation, lock: takeover };
        } catch (error) {
            if (error instanceof EpochError) throw error;
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async renew(lease: JournalLease): Promise<JournalLease> {
        const current = await this.readLiveLock(lease);
        if (isExpired(current.lock, this.now())) epochFail('LOCK_LOST');
        const renewed: EpochLock = { ...current.lock, lockExpiresAt: lockExpiry(this.now(), this.leaseMs) };
        try {
            const stored = await this.putWithLeaseGuard(
                this.lockKey,
                renewed,
                { ifGenerationMatch: current.generation },
                async () => { await this.assertWritableLease(lease); },
            );
            assertGeneration(stored.generation);
            return { generation: stored.generation, lock: renewed };
        } catch (error) {
            if (error instanceof EpochError) throw error;
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async append(lease: JournalLease, transition: EpochTransition): Promise<void> {
        const currentLock = await this.readLiveLock(lease);
        if (isExpired(currentLock.lock, this.now())) epochFail('LOCK_LOST');
        validateTransition(transition, this.header, currentLock.lock.lockFence);
        const transitionDigest = canonicalDigest(transition);
        const key = `${this.journalPrefix}${String(transition.sequence).padStart(8, '0')}/${transitionDigest}.json`;
        const existing = await this.storage.get(key);
        if (existing) epochFail('GENERATION_PRECONDITION_FAILED');
        const current = await this.deriveState(lease);
        if (current.aborted) epochFail('ABORTED_EPOCH');
        const expectedSequence = current.transitions.length + 1;
        const expectedNextIndex = current.state === null ? 0 : STATES.indexOf(current.state) + 1;
        const isAbort = transition.resultCode === 'ABORTED';
        if (transition.sequence !== expectedSequence || transition.fromState !== current.state
            || (isAbort
                ? transition.toState !== current.state
                : STATES.indexOf(transition.toState as State) !== expectedNextIndex)) epochFail('JOURNAL_INVALID');
        try {
            const stored = await this.putWithLeaseGuard(
                key,
                transition,
                { ifGenerationMatch: '0' },
                async () => {
                    // Credential acquisition is an asynchronous authority
                    // boundary.  Re-check not only ownership/abort state but
                    // also the exact transition that was eligible before the
                    // upload began; another same-owner writer may have
                    // committed a different transition while the token was
                    // pending.
                    await this.assertWritableAppendIntent(lease, transition, key);
                },
            );
            assertGeneration(stored.generation);
        } catch (error) {
            if (error instanceof EpochError) throw error;
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
        // A takeover can race between the append PUT and its read-back.  The
        // stale owner must fail closed before reporting a successful append.
        await this.readLiveLock(lease);
        await this.deriveState(lease);
    }

    async assertLive(lease: JournalLease): Promise<void> {
        await this.readLiveLock(lease);
    }

    /**
     * Read the append-only state under the current lock fence.  A journal
     * replay is never allowed to inspect an unowned epoch: without a live
     * lock there is no fence against which a late object can be classified.
     * Earlier fences remain valid history after a legitimate takeover, but a
     * transition from a future fence is an invalid (or late) object and must
     * stop resume.
     */
    async deriveState(lease?: JournalLease): Promise<{
        state: State | null;
        transitions: readonly EpochTransition[];
        aborted: boolean;
        activeFence: string;
        requiresReconciliation: boolean;
    }> {
        const activeLock = lease ? await this.readLiveLock(lease) : await this.readCurrentLock();
        const activeFence = activeLock.lock.lockFence;
        const headerObject = await this.storage.get(this.headerKey);
        if (!headerObject) epochFail('JOURNAL_INVALID');
        validateHeader(headerObject.value);
        if (canonicalDigest(headerObject.value) !== this.epochHeaderDigest) epochFail('JOURNAL_INVALID');
        const entries = await this.storage.list(this.journalPrefix);
        const transitions: EpochTransition[] = [];
        const sequences = new Set<number>();
        let previousFence = '0';
        const orderedEntries = [...entries].sort((left, right) => left.key.localeCompare(right.key));
        for (const entry of orderedEntries) {
            assertGeneration(entry.generation);
            validateTransition(entry.value, this.header);
            const transition = entry.value as EpochTransition;
            const suffix = entry.key.slice(this.journalPrefix.length).match(/^([0-9]{8})\/([0-9a-f]{64})\.json$/);
            if (!suffix || Number(suffix[1]) !== transition.sequence || suffix[2] !== canonicalDigest(transition)
                || sequences.has(transition.sequence)) epochFail('JOURNAL_INVALID');
            const fence = transition.lockFence;
            if (compareDecimal(fence, previousFence) < 0) epochFail('JOURNAL_INVALID');
            // A prior owner may have committed valid history before a
            // takeover, but an object carrying a fence newer than the live
            // owner cannot be adopted by this replay.
            if (compareDecimal(fence, activeFence) > 0) epochFail('JOURNAL_INVALID');
            previousFence = fence;
            sequences.add(transition.sequence);
            transitions.push(transition);
        }
        transitions.sort((left, right) => left.sequence - right.sequence);
        let state: State | null = null;
        let aborted = false;
        for (let index = 0; index < transitions.length; index += 1) {
            const transition = transitions[index]!;
            if (transition.sequence !== index + 1 || transition.fromState !== state || aborted) epochFail('JOURNAL_INVALID');
            if (transition.resultCode === 'ABORTED') {
                if (transition.toState !== state) epochFail('JOURNAL_INVALID');
                aborted = true;
                continue;
            }
            const expectedNextIndex = state === null ? 0 : STATES.indexOf(state) + 1;
            if (STATES.indexOf(transition.toState as State) !== expectedNextIndex) epochFail('JOURNAL_INVALID');
            state = transition.toState as State;
        }
        const finalLock = lease ? await this.readLiveLock(lease) : await this.readCurrentLock();
        if (finalLock.generation !== activeLock.generation
            || finalLock.lock.lockFence !== activeLock.lock.lockFence
            || finalLock.lock.ownerDigest !== activeLock.lock.ownerDigest) {
            // The lock changed while the full journal listing was in flight.
            // Replaying a snapshot across two owners is not a safe state
            // source, even if every object is otherwise well formed.
            epochFail('OBSERVATION_RACE');
        }
        const requiresReconciliation = transitions.some((transition) =>
            compareDecimal(transition.lockFence, activeFence) < 0);
        return { state, transitions, aborted, activeFence, requiresReconciliation };
    }

    /** Explicit name used by resume callers; kept separate from mutation. */
    async readValidatedState(lease?: JournalLease): Promise<ReturnType<EpochJournal['deriveState']> extends Promise<infer T> ? T : never> {
        return this.deriveState(lease);
    }

    private async readLiveLock(lease: JournalLease): Promise<JournalLease> {
        const current = await this.storage.get(this.lockKey);
        if (!current) epochFail('LOCK_LOST');
        assertGeneration(current.generation);
        validateLock(current.value, this.epochHeaderDigest);
        const lock = current.value as EpochLock;
        if (lock.ownerDigest !== lease.lock.ownerDigest || lock.lockFence !== lease.lock.lockFence
            || current.generation !== lease.generation || isExpired(lock, this.now())) epochFail('LOCK_LOST');
        return { generation: current.generation, lock };
    }

    /**
     * A valid lock is necessary but not sufficient for a baseline write:
     * ABORTED is durable journal state even when the owner/fence object has
     * not changed.  Derive the state under the same lease before every
     * baseline adoption or mutation boundary.
     */
    private async assertWritableLease(lease: JournalLease): Promise<JournalLease> {
        const current = await this.readLiveLock(lease);
        const state = await this.deriveState(lease);
        if (state.aborted) epochFail('ABORTED_EPOCH');
        return current;
    }

    private async assertWritableAppendIntent(
        lease: JournalLease,
        transition: EpochTransition,
        key: string,
    ): Promise<void> {
        await this.assertWritableLease(lease);
        const current = await this.deriveState(lease);
        const expectedSequence = current.transitions.length + 1;
        const expectedNextIndex = current.state === null ? 0 : STATES.indexOf(current.state) + 1;
        const isAbort = transition.resultCode === 'ABORTED';
        const validState = isAbort
            ? transition.toState === current.state
            : STATES.indexOf(transition.toState as State) === expectedNextIndex;
        if (transition.sequence !== expectedSequence
            || transition.fromState !== current.state
            || !validState
            || current.aborted) epochFail(current.aborted ? 'ABORTED_EPOCH' : 'JOURNAL_INVALID');
        const existing = await this.storage.get(key);
        if (existing) epochFail('GENERATION_PRECONDITION_FAILED');
    }

    private async readCurrentLock(): Promise<JournalLease> {
        const current = await this.storage.get(this.lockKey);
        if (!current) epochFail('LOCK_LOST');
        assertGeneration(current.generation);
        validateLock(current.value, this.epochHeaderDigest);
        const lock = current.value as EpochLock;
        if (isExpired(lock, this.now())) epochFail('LOCK_LOST');
        return { generation: current.generation, lock };
    }
}

export { EpochError };
