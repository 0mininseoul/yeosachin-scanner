import {
    STATES,
    canonicalDigest,
    hasExactKeys,
    isDigest,
    isState,
    EpochError,
    epochFail,
    type EpochHeader,
    type EpochLock,
    type EpochTransition,
    type State,
} from './contracts';

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
    if (!Number.isSafeInteger(sequence) || (sequence as number) < 1
        || !Number.isSafeInteger(stateVersion) || stateVersion !== sequence
        || transition.epochIdDigest !== header.epochIdDigest
        || (transition.fromState !== null && !isState(transition.fromState))
        || !isState(transition.toState)
        || typeof transition.lockFence !== 'string' || !GENERATION.test(transition.lockFence)
        || (expectedFence !== undefined && transition.lockFence !== expectedFence)
        || !isDigest(transition.preconditionDigest) || !isDigest(transition.mutationDigest)
        || !isDigest(transition.postconditionDigest) || !isDigest(transition.proofDigest)
        || !isDigest(transition.nativeConcurrencyTokenDigest) || !isDigest(transition.resourceObservationDigest)
        || !['OK', 'RECONCILED', 'ABORTED'].includes(String(transition.resultCode))
        || !safeTimestamp(transition.recordedAt)) epochFail('JOURNAL_INVALID');
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
    readonly epochHeaderDigest: string;
    readonly headerKey: string;
    readonly lockKey: string;
    readonly journalPrefix: string;
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
        this.header = options.header;
        this.epochHeaderDigest = canonicalDigest(options.header);
        const prefix = options.keyPrefix ?? 'epoch';
        if (!/^[a-z0-9-]{1,32}$/.test(prefix)) epochFail('JOURNAL_INVALID');
        this.headerKey = `${prefix}/epoch-header/${this.epochHeaderDigest}.json`;
        this.lockKey = `${prefix}/epoch-lock/${this.epochHeaderDigest}.lock`;
        this.journalPrefix = `${prefix}/epoch-journal/${this.epochHeaderDigest}/`;
        this.now = options.now ?? (() => Date.now());
        this.leaseMs = options.leaseMs ?? 60_000;
        if (!Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0 || this.leaseMs > MAX_LEASE_MS) epochFail('JOURNAL_INVALID');
    }

    async ensureHeader(): Promise<void> {
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
                const raced = await this.storage.get(this.headerKey);
                if (raced) {
                    validateHeader(raced.value);
                    if (canonicalDigest(raced.value) === this.epochHeaderDigest) return;
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
        } catch {
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async renew(lease: JournalLease): Promise<JournalLease> {
        const current = await this.readLiveLock(lease);
        if (isExpired(current.lock, this.now())) epochFail('LOCK_LOST');
        const renewed: EpochLock = { ...current.lock, lockExpiresAt: lockExpiry(this.now(), this.leaseMs) };
        try {
            const stored = await this.storage.put(this.lockKey, renewed, { ifGenerationMatch: current.generation });
            assertGeneration(stored.generation);
            return { generation: stored.generation, lock: renewed };
        } catch {
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async append(lease: JournalLease, transition: EpochTransition): Promise<void> {
        const currentLock = await this.readLiveLock(lease);
        if (isExpired(currentLock.lock, this.now())) epochFail('LOCK_LOST');
        validateTransition(transition, this.header, currentLock.lock.lockFence);
        const transitionDigest = canonicalDigest(transition);
        const key = `${this.journalPrefix}${String(transition.sequence).padStart(8, '0')}-${transitionDigest}.json`;
        const existing = await this.storage.get(key);
        if (existing) epochFail('GENERATION_PRECONDITION_FAILED');
        const current = await this.deriveState();
        const expectedSequence = current.transitions.length + 1;
        if (transition.sequence !== expectedSequence
            || transition.fromState !== current.state
            || STATES.indexOf(transition.toState) !== STATES.indexOf(current.state as State) + 1) epochFail('JOURNAL_INVALID');
        try {
            const stored = await this.storage.put(key, transition, { ifGenerationMatch: '0' });
            assertGeneration(stored.generation);
        } catch {
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
        await this.deriveState();
    }

    async assertLive(lease: JournalLease): Promise<void> {
        await this.readLiveLock(lease);
    }

    async deriveState(): Promise<{ state: State | null; transitions: readonly EpochTransition[] }> {
        const headerObject = await this.storage.get(this.headerKey);
        if (!headerObject) epochFail('JOURNAL_INVALID');
        validateHeader(headerObject.value);
        if (canonicalDigest(headerObject.value) !== this.epochHeaderDigest) epochFail('JOURNAL_INVALID');
        const entries = await this.storage.list(this.journalPrefix);
        const transitions: EpochTransition[] = [];
        const sequences = new Set<number>();
        let previousFence = '0';
        for (const entry of entries) {
            assertGeneration(entry.generation);
            validateTransition(entry.value, this.header);
            const transition = entry.value as EpochTransition;
            const suffix = entry.key.slice(this.journalPrefix.length).match(/^([0-9]{8})-([0-9a-f]{64})\.json$/);
            if (!suffix || Number(suffix[1]) !== transition.sequence || suffix[2] !== canonicalDigest(transition)
                || sequences.has(transition.sequence)) epochFail('JOURNAL_INVALID');
            const fence = transition.lockFence;
            if (compareDecimal(fence, previousFence) < 0) epochFail('JOURNAL_INVALID');
            previousFence = fence;
            sequences.add(transition.sequence);
            transitions.push(transition);
        }
        transitions.sort((left, right) => left.sequence - right.sequence);
        let state: State | null = null;
        for (let index = 0; index < transitions.length; index += 1) {
            const transition = transitions[index]!;
            if (transition.sequence !== index + 1
                || transition.fromState !== state
                || STATES.indexOf(transition.toState) !== STATES.indexOf(state as State) + 1) epochFail('JOURNAL_INVALID');
            state = transition.toState;
        }
        return { state, transitions };
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
}

export { EpochError };
