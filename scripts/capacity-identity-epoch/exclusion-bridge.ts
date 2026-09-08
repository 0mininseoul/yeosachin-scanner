import { canonicalDigest, EpochError, epochFail, type Role } from './contracts';
import {
    CapacityReservation,
    reservationResourceDigest,
    type ReservationLease,
    type ReservationStorage,
} from './exclusion';
import type { GcsRawStorage } from './gcs';

const DIGEST = /^[0-9a-f]{64}$/;
const GENERATION = /^[1-9][0-9]*$/;
const SAFE_RESOURCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,1023}$/;

export type ExclusionEntryPoint =
    | 'epoch'
    | 'role-deployer'
    | 'capacity-queue'
    | 'preflight-maintenance'
    | 'paid-maintenance';

export type ExclusionResourceKind = 'service' | 'queue' | 'scheduler' | 'iam' | 'retention' | 'vercel';

export type ExclusionResource = Readonly<{
    kind: ExclusionResourceKind;
    resource: string;
}>;

export type EntryPointResourcePlan = Readonly<{
    entryPoint: ExclusionEntryPoint;
    role?: Role;
    resources: readonly ExclusionResource[];
}>;

export type LegacyServiceSelector = Readonly<{
    bucket: string;
    project: string;
    region: string;
    service: string;
}>;

export type LegacyLockObject = Readonly<{
    key: string;
    generation: string;
    payloadDigest: string;
}>;

export interface LegacyLockStorage {
    getRaw(key: string): Promise<Readonly<{ generation: string; body: string }> | null>;
    putRaw(key: string, body: string, options: { ifGenerationMatch: '0' | string }): Promise<Readonly<{ generation: string; body: string }>>;
    deleteRaw(key: string, options: { ifGenerationMatch: string }): Promise<void>;
}

function requireDigest(value: string): void {
    if (!DIGEST.test(value)) epochFail('CAPABILITY_INVALID');
}

function requireGeneration(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !GENERATION.test(value)) epochFail('JOURNAL_INVALID');
}

function requireResource(resource: string): void {
    if (typeof resource !== 'string' || !SAFE_RESOURCE.test(resource)) epochFail('RESOURCE_INVALID');
}

function canonicalResource(resource: ExclusionResource): string {
    if (!resource || typeof resource !== 'object' || !['service', 'queue', 'scheduler', 'iam', 'retention', 'vercel'].includes(resource.kind)) {
        epochFail('RESOURCE_INVALID');
    }
    requireResource(resource.resource);
    return `${resource.kind}:${resource.resource}`;
}

function uniqueResources(resources: readonly ExclusionResource[]): readonly string[] {
    if (!Array.isArray(resources) || resources.length === 0) epochFail('RESOURCE_INVALID');
    const values = resources.map(canonicalResource);
    const unique = [...new Set(values)].sort();
    if (unique.length !== values.length) epochFail('RESOURCE_INVALID');
    return Object.freeze(unique);
}

function requireKinds(resources: readonly ExclusionResource[], required: readonly ExclusionResourceKind[]): void {
    const kinds = new Set(resources.map(resource => resource.kind));
    for (const kind of required) if (!kinds.has(kind)) epochFail('RESOURCE_INVALID');
}

/**
 * Validate the exact resource shape owned by each legacy entry point. A
 * generic queue command cannot become capacity-owned by omitting its role;
 * nested callers must pass a reviewed role and resource set as well.
 */
export function deriveEntryPointResources(input: EntryPointResourcePlan): readonly string[] {
    if (input.entryPoint === 'capacity-queue' && (input.role !== 'preflight' && input.role !== 'paid')) {
        epochFail('ADAPTER_REQUEST_INVALID');
    }
    if (input.entryPoint === 'preflight-maintenance' && input.role !== 'preflight') {
        epochFail('CAPABILITY_BINDING_MISMATCH');
    }
    if (input.entryPoint === 'paid-maintenance' && input.role !== 'paid') {
        epochFail('CAPABILITY_BINDING_MISMATCH');
    }
    if (input.entryPoint === 'epoch' && input.role !== undefined) epochFail('CAPABILITY_BINDING_MISMATCH');
    switch (input.entryPoint) {
        case 'epoch': requireKinds(input.resources, ['service', 'queue', 'scheduler', 'iam']); break;
        case 'role-deployer': requireKinds(input.resources, ['service']); break;
        // The capacity-owned generic queue command may intentionally mutate
        // only its reviewed queue target.  Role binding remains mandatory;
        // requiring a service here would make the documented queue-only mode
        // diverge from the IPC selector and tempt callers to add an unrelated
        // service merely to satisfy the bridge.
        case 'capacity-queue': requireKinds(input.resources, ['queue']); break;
        case 'preflight-maintenance': requireKinds(input.resources, ['service', 'scheduler', 'iam']); break;
        case 'paid-maintenance': requireKinds(input.resources, ['service', 'scheduler', 'iam', 'retention']); break;
    }
    return uniqueResources(input.resources);
}

/**
 * The old deployers use exactly `project/region/service.lock` below the
 * configured lock bucket. The bucket is storage context, not part of the
 * object name, and is retained only for binding validation.
 */
export function legacyServiceLockKey(selector: LegacyServiceSelector): string {
    for (const value of [selector.bucket, selector.project, selector.region, selector.service]) requireResource(value);
    return `${selector.project}/${selector.region}/${selector.service}.lock`;
}

function ownerPayload(ownerDigest: string): string {
    requireDigest(ownerDigest);
    return `capacity-identity-epoch-v1:${ownerDigest}`;
}

/** Opaque legacy lease binding used when a descriptor crosses a process. */
export function legacyServiceLockPayloadDigest(selector: LegacyServiceSelector, ownerDigest: string): string {
    const key = legacyServiceLockKey(selector);
    const selectorDigest = canonicalDigest({ kind: 'legacy-service-lock-v1', bucket: selector.bucket, key });
    return canonicalDigest({ selector: selectorDigest, body: ownerPayload(ownerDigest) });
}

/**
 * Generation-fenced adapter for the pre-epoch plain-text service lock. Any
 * existing payload is occupied, including arbitrary legacy text with no
 * timestamp. This bridge never invents a TTL or deletes an unknown owner.
 */
export class LegacyServiceLock {
    readonly key: string;
    private readonly storage: LegacyLockStorage;
    private readonly selector: LegacyServiceSelector;
    private readonly selectorDigest: string;

    constructor(storage: LegacyLockStorage, selector: LegacyServiceSelector) {
        this.storage = storage;
        this.selector = { ...selector };
        this.key = legacyServiceLockKey(this.selector);
        this.selectorDigest = canonicalDigest({ kind: 'legacy-service-lock-v1', bucket: this.selector.bucket, key: this.key });
    }

    async acquire(ownerDigest: string): Promise<LegacyLockObject> {
        const body = ownerPayload(ownerDigest);
        const existing = await this.storage.getRaw(this.key);
        if (existing !== null) epochFail('LOCK_LOST');
        try {
            const created = await this.storage.putRaw(this.key, body, { ifGenerationMatch: '0' });
            requireGeneration(created.generation);
            if (created.body !== body) epochFail('ADAPTER_RESPONSE_INVALID');
            return { key: this.key, generation: created.generation, payloadDigest: legacyServiceLockPayloadDigest(this.selector, ownerDigest) };
        } catch (error) {
            if (error instanceof EpochError) throw error;
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }

    async assert(lease: LegacyLockObject): Promise<void> {
        requireGeneration(lease.generation);
        const current = await this.storage.getRaw(this.key);
        if (!current || current.generation !== lease.generation
            || canonicalDigest({ selector: this.selectorDigest, body: current.body }) !== lease.payloadDigest) epochFail('LOCK_LOST');
    }

    async release(lease: LegacyLockObject): Promise<void> {
        await this.assert(lease);
        try {
            await this.storage.deleteRaw(this.key, { ifGenerationMatch: lease.generation });
        } catch (error) {
            if (error instanceof EpochError) throw error;
            epochFail('GENERATION_PRECONDITION_FAILED');
        }
    }
}

export type ExclusionSession = Readonly<{
    resources: readonly string[];
    reservation: CapacityReservation;
    reservationLease: ReservationLease;
    legacyLocks: readonly LegacyServiceLock[];
    legacyLeases: readonly LegacyLockObject[];
}>;

export type ExclusionActionContext = Readonly<{
    assertLive(): Promise<void>;
    renew(): Promise<void>;
    delegate(): object;
}>;

export type AcquireExclusionOptions = Readonly<{
    storage: ReservationStorage;
    rawStorage?: LegacyLockStorage;
    resources: readonly string[];
    epochDigest: string;
    ownerDigest: string;
    leaseMs?: number;
    now?: () => number;
    legacyServices?: readonly LegacyServiceSelector[];
}>;

type DelegationState = {
    current: ExclusionSession;
    closed: boolean;
    renewal?: Promise<ExclusionSession>;
    queue: Promise<unknown>;
};

const delegationRegistry = new WeakMap<object, DelegationState>();
type SessionState = {
    current: ExclusionSession;
    queue: Promise<unknown>;
    renewal?: Promise<ExclusionSession>;
};

const sessionRegistry = new WeakMap<object, SessionState>();

function sessionState(session: ExclusionSession): SessionState {
    const existing = sessionRegistry.get(session);
    if (existing) return existing;
    const state: SessionState = { current: session, queue: Promise.resolve() };
    sessionRegistry.set(session, state);
    return state;
}

function enqueue<T>(state: { queue: Promise<unknown> }, operation: () => Promise<T>): Promise<T> {
    const next = state.queue.catch(() => undefined).then(operation);
    state.queue = next;
    void next.catch(() => { /* each caller observes its own operation */ });
    return next;
}

export async function acquireExclusion(options: AcquireExclusionOptions): Promise<ExclusionSession> {
    requireDigest(options.epochDigest);
    requireDigest(options.ownerDigest);
    if (options.resources.length === 0) epochFail('RESOURCE_INVALID');
    const reservation = new CapacityReservation(options.storage, { resources: options.resources, now: options.now, leaseMs: options.leaseMs });
    const reservationLease = await reservation.acquire(options.epochDigest, options.ownerDigest);
    const legacyLocks: LegacyServiceLock[] = [];
    const legacyLeases: LegacyLockObject[] = [];
    try {
        if (options.legacyServices && options.legacyServices.length > 0) {
            if (!options.rawStorage) epochFail('ADAPTER_REQUEST_INVALID');
            const selectors = [...options.legacyServices].sort((left, right) => legacyServiceLockKey(left).localeCompare(legacyServiceLockKey(right)));
            for (const selector of selectors) {
                const lock = new LegacyServiceLock(options.rawStorage, selector);
                legacyLocks.push(lock);
                legacyLeases.push(await lock.acquire(options.ownerDigest));
            }
        }
        return Object.freeze({
            resources: Object.freeze([...options.resources].sort()),
            reservation,
            reservationLease,
            legacyLocks: Object.freeze(legacyLocks),
            legacyLeases: Object.freeze(legacyLeases),
        });
    } catch (error) {
        for (let index = legacyLocks.length - 1; index >= 0; index -= 1) {
            const lease = legacyLeases[index];
            if (lease) {
                try { await legacyLocks[index]!.release(lease); } catch { /* preserve fail-closed outcome */ }
            }
        }
        try { await reservation.release(reservationLease); } catch { /* preserve fail-closed outcome */ }
        throw error;
    }
}

async function assertExclusionUnserialized(session: ExclusionSession): Promise<void> {
    await session.reservation.assert(session.reservationLease);
    for (let index = 0; index < session.legacyLocks.length; index += 1) {
        await session.legacyLocks[index]!.assert(session.legacyLeases[index]!);
    }
}

export function assertExclusion(session: ExclusionSession): Promise<void> {
    const state = sessionState(session);
    return enqueue(state, async () => {
        await assertExclusionUnserialized(state.current);
    });
}

export function renewExclusion(session: ExclusionSession): Promise<ExclusionSession> {
    const state = sessionState(session);
    if (state.renewal) return state.renewal;
    const renewal = enqueue(state, async () => {
        const current = state.current;
        const reservationLease = await current.reservation.renew(current.reservationLease);
        const updated = Object.freeze({ ...current, reservationLease });
        await assertExclusionUnserialized(updated);
        state.current = updated;
        sessionRegistry.set(updated, state);
        return updated;
    });
    state.renewal = renewal;
    void renewal.finally(() => {
        if (state.renewal === renewal) state.renewal = undefined;
    }).catch(() => { /* caller observes the renewal result */ });
    return renewal;
}

export async function releaseExclusion(session: ExclusionSession): Promise<void> {
    for (let index = session.legacyLocks.length - 1; index >= 0; index -= 1) {
        await session.legacyLocks[index]!.release(session.legacyLeases[index]!);
    }
    await session.reservation.release(session.reservationLease);
}

/** Hold all common/native locks around the complete mutation callback. */
export async function withExclusion<T>(
    options: AcquireExclusionOptions & Readonly<{ renewEveryMs?: number }>,
    action: (context: ExclusionActionContext) => Promise<T>,
): Promise<T> {
    let session = await acquireExclusion(options);
    const delegationState: DelegationState = { current: session, closed: false, queue: Promise.resolve() };
    let renewalError: unknown;
    let renewalInFlight: Promise<ExclusionSession> | undefined;
    let actionFailed = false;
    const renewCurrent = (): Promise<ExclusionSession> => {
        if (renewalError !== undefined) return Promise.reject(renewalError);
        if (renewalInFlight) return renewalInFlight;
        const renewal = enqueue(delegationState, async () => {
            if (renewalError !== undefined) throw renewalError;
            const updated = await renewExclusion(delegationState.current);
            session = updated;
            delegationState.current = updated;
            return updated;
        });
        renewalInFlight = renewal;
        delegationState.renewal = renewal;
        void renewal.catch(error => { renewalError ??= error; }).finally(() => {
            if (renewalInFlight === renewal) renewalInFlight = undefined;
            if (delegationState.renewal === renewal) delegationState.renewal = undefined;
        });
        return renewal;
    };
    const interval = options.renewEveryMs === undefined ? undefined : setInterval(() => {
        void renewCurrent().catch(() => { /* assertLive/finish observes renewalError */ });
    }, options.renewEveryMs);
    try {
        let result: T;
        try {
            result = await action({
                assertLive: () => enqueue(delegationState, async () => {
                    if (renewalError !== undefined) throw renewalError;
                    await assertExclusion(delegationState.current);
                }),
                renew: async () => { await renewCurrent(); },
                delegate: () => {
                    const token = Object.freeze({});
                    delegationRegistry.set(token, delegationState);
                    return token;
                },
            });
        } catch (error) {
            actionFailed = true;
            throw error;
        }
        if (renewalError !== undefined) throw renewalError;
        return result;
    } finally {
        if (interval !== undefined) clearInterval(interval);
        // A timer callback may have passed the interval boundary while the
        // action was finishing. Await the serialized queue before releasing
        // the current lease, otherwise a successful heartbeat can retain a
        // newer generation after the old session is deleted.
        try {
            await delegationState.queue;
        } catch (error) {
            renewalError ??= error;
        }
        delegationState.closed = true;
        await releaseExclusion(session);
        if (!actionFailed && renewalError !== undefined) throw renewalError;
    }
}

/** Nested entry points prove live ownership through an opaque in-process capability. */
export async function adoptNestedExclusion(token: object, resources: readonly string[]): Promise<ExclusionSession> {
    const state = delegationRegistry.get(token);
    if (!state) epochFail('CAPABILITY_INVALID');
    return enqueue(state, async () => {
        if (state.closed) epochFail('LOCK_LOST');
        const session = state.current;
        const wanted = new Set(resources);
        if (resources.length === 0 || resources.some(resource => !session.resources.includes(resource)) || wanted.size !== resources.length) {
            epochFail('CAPABILITY_BINDING_MISMATCH');
        }
        await assertExclusion(session);
        return session;
    });
}
