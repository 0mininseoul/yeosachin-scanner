import { createHash } from 'node:crypto';
import {
    canonicalDigest,
    epochFail,
    hasExactKeys,
    isObject,
    isRole,
    isSlot,
    PROJECT_ID_PATTERN,
    ROLES,
    SLOTS,
    type ProtectedIdentity,
    type Role,
    type Slot,
} from './contracts';

/**
 * The preparation process has a deliberately tiny mutation surface.  Keep
 * this list as a literal tuple so a new provider action cannot be added by
 * widening a string union in a caller.
 */
export const ALLOWED_PREPARATION_ACTION_KINDS = ['account.create', 'scheduler.pause'] as const;
export type PreparationActionKind = typeof ALLOWED_PREPARATION_ACTION_KINDS[number];

export type IdentityAccountObservation = Readonly<{
    identity: ProtectedIdentity;
    enabled: boolean;
    /** Number of user-managed keys observed on this account. */
    userManagedKeyCount: number;
    /** Exact workload slots attached to the account in the old graph. */
    attachedSlots: readonly Slot[];
}>;

/**
 * Old identity evidence is intentionally independent of runtime/env input.
 * The optional scheduler fields let the pure policy also produce the small
 * preparation action list without giving it a provider client.
 */
export type IdentityGraphObservation = Readonly<{
    project: string;
    build: ProtectedIdentity;
    /** The observed old role-slot graph. */
    slots: Readonly<Record<Slot, ProtectedIdentity>>;
    /** Optional reviewed desired identities; absent slots use same-slot reuse. */
    desiredSlots?: Readonly<Partial<Record<Slot, ProtectedIdentity>>>;
    accounts: readonly IdentityAccountObservation[];
    schedulerStates?: Readonly<Record<Role, 'PAUSED' | 'ENABLED'>>;
    schedulerResources?: Readonly<Record<Role, string>>;
    retentionSchedulerResource?: string;
}>;

export type DesiredIdentityGraph = Readonly<{
    project: string;
    build: ProtectedIdentity;
    slots: Readonly<Record<Slot, ProtectedIdentity>>;
}>;

export type AccountCreationAction = Readonly<{
    kind: 'account.create';
    slot: Slot;
    identity: ProtectedIdentity;
}>;

export type SchedulerPauseAction = Readonly<{
    kind: 'scheduler.pause';
    role: Role;
    resource: string;
}>;

export type PreparationAction = AccountCreationAction | SchedulerPauseAction;

export type MissingIdentity = Readonly<{
    slot: Slot;
    identity: ProtectedIdentity;
}>;

export type IdentitySelection = Readonly<{
    desired: DesiredIdentityGraph;
    reusedSlots: readonly Slot[];
    missingAccounts: readonly MissingIdentity[];
    actions: readonly PreparationAction[];
    identityGraphDigest: string;
    /** Digest of the complete in-memory policy projection. */
    preparationDigest: string;
}>;

export type PreparationSafeSummary = Readonly<{
    proposalDigest: string;
    identityGraphDigest: string;
    reusedCount: number;
    missingCount: number;
    conflictFree: true;
    actionKinds: Readonly<Record<PreparationActionKind, number>>;
}>;

const SERVICE_ACCOUNT = /^[a-z][a-z0-9-]{0,62}@([a-z][a-z0-9-]{4,28}[a-z0-9])\.iam\.gserviceaccount\.com$/;
const ACCOUNT_ID = /^[a-z][a-z0-9-]{0,29}$/;
const RESOURCE = /^[^\u0000-\u001f\u007f]{1,1024}$/;

function identityError(): never {
    epochFail('IDENTITY_INVALID');
}

function conflict(): never {
    epochFail('IDENTITY_CONFLICT');
}

function safeIdentity(value: unknown, project: string): value is ProtectedIdentity {
    if (!isObject(value)
        || !hasExactKeys(value, ['identity', 'project'])
        || typeof value.identity !== 'string'
        || typeof value.project !== 'string'
        || value.project !== project) return false;
    const match = value.identity.match(SERVICE_ACCOUNT);
    return match !== null && match[1] === project;
}

function assertIdentity(value: unknown, project: string): asserts value is ProtectedIdentity {
    if (!safeIdentity(value, project)) identityError();
}

function assertSlots(value: unknown): asserts value is Readonly<Record<Slot, ProtectedIdentity>> {
    if (!isObject(value) || !hasExactKeys(value, SLOTS)) identityError();
}

function assertSlotArray(value: unknown): asserts value is readonly Slot[] {
    if (!Array.isArray(value) || new Set(value).size !== value.length || !value.every(isSlot)) conflict();
}

function accountId(identity: string): string {
    const local = identity.slice(0, identity.indexOf('@'));
    if (!ACCOUNT_ID.test(local)) identityError();
    return local;
}

function schedulerState(value: unknown): value is 'PAUSED' | 'ENABLED' {
    return value === 'PAUSED' || value === 'ENABLED';
}

function validateObservation(observation: IdentityGraphObservation): Map<string, IdentityAccountObservation> {
    if (!isObject(observation)
        || typeof observation.project !== 'string'
        || !PROJECT_ID_PATTERN.test(observation.project)) identityError();
    assertIdentity(observation.build, observation.project);
    assertSlots(observation.slots);
    if (observation.desiredSlots !== undefined) {
        if (!isObject(observation.desiredSlots)
            || Object.keys(observation.desiredSlots).some(key => !isSlot(key))) identityError();
        for (const [slot, value] of Object.entries(observation.desiredSlots)) {
            assertIdentity(value, observation.project);
            if (!isSlot(slot)) identityError();
        }
    }

    const slotIdentityCounts = new Map<string, Slot[]>();
    for (const slot of SLOTS) {
        const value = observation.slots[slot];
        assertIdentity(value, observation.project);
        const prior = slotIdentityCounts.get(value.identity) ?? [];
        prior.push(slot);
        slotIdentityCounts.set(value.identity, prior);
    }
    // Shared or cross-slot old accounts are never silently split.
    if ([...slotIdentityCounts.values()].some(slots => slots.length !== 1)) conflict();
    if (SLOTS.some(slot => observation.slots[slot].identity === observation.build.identity)) conflict();

    if (!Array.isArray(observation.accounts)) identityError();
    const accounts = new Map<string, IdentityAccountObservation>();
    for (const account of observation.accounts) {
        const userManagedKeyCount = isObject(account) ? account.userManagedKeyCount : undefined;
        if (!isObject(account)
            || !safeIdentity(account.identity, observation.project)
            || typeof account.enabled !== 'boolean'
            || typeof userManagedKeyCount !== 'number'
            || !Number.isSafeInteger(userManagedKeyCount)
            || userManagedKeyCount < 0) identityError();
        assertSlotArray(account.attachedSlots);
        if (accounts.has(account.identity.identity)) conflict();
        accounts.set(account.identity.identity, account as IdentityAccountObservation);
    }

    for (const slot of SLOTS) {
        const expected = observation.slots[slot];
        const account = accounts.get(expected.identity);
        // A graph entry without a corresponding account is incomplete old
        // evidence. It must not be treated as a clean account ready for reuse.
        if (!account) conflict();
        if (account.attachedSlots.length !== 1 || account.attachedSlots[0] !== slot) conflict();
        if (!account.enabled || account.userManagedKeyCount !== 0) conflict();
    }

    if (observation.schedulerStates !== undefined) {
        if (!isObject(observation.schedulerStates) || !hasExactKeys(observation.schedulerStates, ROLES)
            || !ROLES.every(role => schedulerState(observation.schedulerStates![role]))) identityError();
        if (observation.schedulerResources === undefined
            || !isObject(observation.schedulerResources)
            || !hasExactKeys(observation.schedulerResources, ROLES)
            || !ROLES.every(role => typeof observation.schedulerResources![role] === 'string' && RESOURCE.test(observation.schedulerResources![role]!))) identityError();
        if (observation.retentionSchedulerResource !== undefined
            && typeof observation.retentionSchedulerResource !== 'string') identityError();
        if (observation.retentionSchedulerResource !== undefined
            && ROLES.some(role => observation.schedulerResources![role] === observation.retentionSchedulerResource)) conflict();
    } else if (observation.schedulerResources !== undefined || observation.retentionSchedulerResource !== undefined) {
        identityError();
    }
    return accounts;
}

/**
 * Calculate a stable service-account identity for a role-slot.  The account
 * id deliberately contains no user/provider value and is bounded to the
 * Google account-id limit.  The project remains an explicit input so the
 * same slot cannot accidentally target another project.
 */
export function deterministicIdentityForSlot(project: string, slot: Slot): ProtectedIdentity {
    if (!PROJECT_ID_PATTERN.test(project) || !isSlot(slot)) identityError();
    const digest = createHash('sha256').update(`${project}\u0000${slot}`, 'utf8').digest('hex');
    const local = `epoch-${digest.slice(0, 24)}`;
    return { identity: `${local}@${project}.iam.gserviceaccount.com`, project };
}

export const desiredIdentityForSlot = deterministicIdentityForSlot;

export function canonicalIdentityGraphProjection(graph: DesiredIdentityGraph): Readonly<{
    project: string;
    build: ProtectedIdentity;
    slots: Readonly<Record<Slot, ProtectedIdentity>>;
}> {
    return {
        project: graph.project,
        build: graph.build,
        slots: Object.fromEntries(SLOTS.map(slot => [slot, graph.slots[slot]])) as Record<Slot, ProtectedIdentity>,
    };
}

function actionProjection(action: PreparationAction): Record<string, unknown> {
    if (action.kind === 'account.create') return { kind: action.kind, slot: action.slot, identity: action.identity };
    return { kind: action.kind, role: action.role, resource: action.resource };
}

export function canonicalPreparationProjection(selection: Pick<IdentitySelection, 'desired' | 'reusedSlots' | 'missingAccounts' | 'actions'>): Readonly<Record<string, unknown>> {
    return {
        desired: canonicalIdentityGraphProjection(selection.desired),
        reusedSlots: [...selection.reusedSlots],
        missingAccounts: selection.missingAccounts.map(item => ({ slot: item.slot, identity: item.identity })),
        actions: selection.actions.map(actionProjection),
    };
}

/** Validate the runtime action allowlist before any operator dispatch. */
export function assertPreparationAction(value: unknown): asserts value is PreparationAction {
    if (!isObject(value) || !ALLOWED_PREPARATION_ACTION_KINDS.includes(value.kind as PreparationActionKind)) conflict();
    if (value.kind === 'account.create') {
        const identity = value.identity;
        if (!isSlot(value.slot) || !isObject(identity) || typeof identity.project !== 'string' || !safeIdentity(identity, identity.project)) conflict();
        return;
    }
    if (!isRole(value.role) || typeof value.resource !== 'string' || !RESOURCE.test(value.resource)) conflict();
}

/**
 * Produce the deterministic desired graph and the only preparation actions.
 * Existing same-slot accounts are retained. Slots that do not have a
 * reusable account receive the deterministic account id; an already existing
 * deterministic account must itself be clean or the proposal is rejected.
 */
export function selectDesiredIdentityGraph(observation: IdentityGraphObservation): IdentitySelection {
    const accounts = validateObservation(observation);
    const desiredSlots = {} as Record<Slot, ProtectedIdentity>;
    const reusedSlots: Slot[] = [];
    const missingAccounts: MissingIdentity[] = [];
    const actions: PreparationAction[] = [];

    // Recovery schedulers are the first mutable boundary. Pause every
    // enabled scheduler before any account-create action can run.
    if (observation.schedulerStates !== undefined && observation.schedulerResources !== undefined) {
        for (const role of ROLES) {
            if (observation.schedulerStates[role] === 'ENABLED') {
                const resource = observation.schedulerResources[role];
                actions.push({ kind: 'scheduler.pause', role, resource });
            }
        }
    }

    for (const slot of SLOTS) {
        const oldIdentity = observation.slots[slot];
        const requested = observation.desiredSlots?.[slot] ?? oldIdentity;
        assertIdentity(requested, observation.project);
        const current = accounts.get(oldIdentity.identity);
        // validateObservation already proved this is exact same-slot,
        // enabled, keyless, and conflict-free.
        if (requested.identity === oldIdentity.identity && current) {
            desiredSlots[slot] = current.identity;
            reusedSlots.push(slot);
            continue;
        }
        const desired = requested.identity === oldIdentity.identity
            ? deterministicIdentityForSlot(observation.project, slot)
            : requested;
        if (requested.identity !== oldIdentity.identity
            && requested.identity !== deterministicIdentityForSlot(observation.project, slot).identity) conflict();
        const existing = accounts.get(desired.identity);
        if (existing !== undefined) {
            if (!existing.enabled || existing.userManagedKeyCount !== 0
                || existing.attachedSlots.length !== 0) conflict();
            desiredSlots[slot] = existing.identity;
        } else {
            desiredSlots[slot] = desired;
            missingAccounts.push({ slot, identity: desired });
            actions.push({ kind: 'account.create', slot, identity: desired });
        }
    }

    const desiredIds = SLOTS.map(slot => desiredSlots[slot].identity);
    if (new Set(desiredIds).size !== desiredIds.length
        || desiredIds.includes(observation.build.identity)) conflict();
    for (const item of missingAccounts) assertPreparationAction(actions.find(action => action.kind === 'account.create' && action.slot === item.slot));

    for (const action of actions) assertPreparationAction(action);

    const desired: DesiredIdentityGraph = Object.freeze({
        project: observation.project,
        build: observation.build,
        slots: Object.freeze(Object.fromEntries(SLOTS.map(slot => [slot, desiredSlots[slot]])) as Record<Slot, ProtectedIdentity>),
    });
    const identityGraphDigest = canonicalDigest(canonicalIdentityGraphProjection(desired));
    const preparationDigest = canonicalDigest(canonicalPreparationProjection({ desired, reusedSlots, missingAccounts, actions }));
    return Object.freeze({
        desired,
        reusedSlots: Object.freeze([...reusedSlots]),
        missingAccounts: Object.freeze(missingAccounts.map(item => Object.freeze({ ...item }))),
        actions: Object.freeze(actions.map(action => Object.freeze({ ...action }))),
        identityGraphDigest,
        preparationDigest,
    });
}

export function summarizePreparation(selection: IdentitySelection): PreparationSafeSummary {
    const actionKinds: Record<PreparationActionKind, number> = { 'account.create': 0, 'scheduler.pause': 0 };
    for (const action of selection.actions) {
        assertPreparationAction(action);
        actionKinds[action.kind] += 1;
    }
    return Object.freeze({
        proposalDigest: selection.preparationDigest,
        identityGraphDigest: selection.identityGraphDigest,
        reusedCount: selection.reusedSlots.length,
        missingCount: selection.missingAccounts.length,
        conflictFree: true,
        actionKinds: Object.freeze(actionKinds),
    });
}

export function assertPreparationDigest(selection: IdentitySelection, digest: string): void {
    if (typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)
        || digest !== selection.preparationDigest) epochFail('PROPOSAL_STALE');
}
