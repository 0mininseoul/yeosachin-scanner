import { describe, expect, it } from 'vitest';
import {
    ALLOWED_PREPARATION_ACTION_KINDS,
    canonicalIdentityGraphProjection,
    canonicalPreparationProjection,
    deterministicIdentityForSlot,
    selectDesiredIdentityGraph,
    summarizePreparation,
    type IdentityGraphObservation,
} from './owner-preparation';
import { canonicalDigest, EpochError, SLOTS, type ProtectedIdentity, type Slot } from './contracts';

const PROJECT = 'fixture-project';

function identity(accountId: string, project = PROJECT): ProtectedIdentity {
    return { identity: `${accountId}@${project}.iam.gserviceaccount.com`, project };
}

function graph(overrides: Partial<{
    slots: Partial<Record<Slot, ProtectedIdentity>>;
    desiredSlots: Partial<Record<Slot, ProtectedIdentity>>;
    accounts: IdentityGraphObservation['accounts'];
    build: ProtectedIdentity;
}> = {}): IdentityGraphObservation {
    const slots = Object.fromEntries(SLOTS.map(slot => [
        slot,
        overrides.slots?.[slot] ?? identity(`${slot.replaceAll('.', '-')}-old`),
    ])) as Record<Slot, ProtectedIdentity>;
    return {
        project: PROJECT,
        build: overrides.build ?? identity('build-old'),
        slots,
        ...(overrides.desiredSlots === undefined ? {} : { desiredSlots: overrides.desiredSlots }),
        accounts: overrides.accounts ?? SLOTS.map(slot => ({
            identity: slots[slot]!,
            enabled: true,
            userManagedKeyCount: 0,
            attachedSlots: [slot],
        })),
    };
}

describe('owner identity preparation policy', () => {
    it('reuses only an exact same-slot account and reports deterministic missing accounts', () => {
        const observed = graph();
        const result = selectDesiredIdentityGraph(observed);

        expect(result.reusedSlots).toEqual([...SLOTS]);
        expect(result.missingAccounts).toEqual([]);
        expect(result.desired.slots).toEqual(observed.slots);
        expect(result.identityGraphDigest).toBe(canonicalDigest(canonicalIdentityGraphProjection(result.desired)));
        expect(summarizePreparation(result)).toMatchObject({
            reusedCount: SLOTS.length,
            missingCount: 0,
            conflictFree: true,
            actionKinds: { 'account.create': 0, 'scheduler.pause': 0 },
        });
    });

    it.each([
        ['shared', (base: IdentityGraphObservation) => ({
            ...base,
            slots: { ...base.slots, 'paid.runtime': base.slots['preflight.runtime']! },
        })],
        ['cross-slot', (base: IdentityGraphObservation) => ({
            ...base,
            slots: {
                ...base.slots,
                'paid.runtime': base.slots['preflight.runtime']!,
                'preflight.runtime': identity('preflight-runtime-replaced'),
            },
        })],
        ['keyed', (base: IdentityGraphObservation) => ({
            ...base,
            accounts: base.accounts.map(account => account.identity.identity.includes('preflight-runtime')
                ? { ...account, userManagedKeyCount: 1 }
                : account),
        })],
        ['disabled', (base: IdentityGraphObservation) => ({
            ...base,
            accounts: base.accounts.map(account => account.identity.identity.includes('preflight-runtime')
                ? { ...account, enabled: false }
                : account),
        })],
        ['build collision', (base: IdentityGraphObservation) => ({
            ...base,
            build: base.slots['preflight.runtime']!,
        })],
    ])('rejects %s identity conflicts', (_label, mutate) => {
        const observed = mutate(graph());
        expect(() => selectDesiredIdentityGraph(observed)).toThrow(EpochError);
        expect(() => selectDesiredIdentityGraph(observed)).toThrow(/IDENTITY_CONFLICT/);
    });

    it('uses an existing deterministic identity only when it is keyless, enabled, and unattached', () => {
        const base = graph({
            slots: { 'preflight.runtime': identity('preflight-runtime-replaced') },
            desiredSlots: { 'preflight.runtime': deterministicIdentityForSlot(PROJECT, 'preflight.runtime') },
        });
        const desired = deterministicIdentityForSlot(PROJECT, 'preflight.runtime');
        const result = selectDesiredIdentityGraph({
            ...base,
            accounts: [...base.accounts, {
                identity: desired,
                enabled: true,
                userManagedKeyCount: 0,
                attachedSlots: [],
            }],
        });
        expect(result.reusedSlots).not.toContain('preflight.runtime');
        expect(result.missingAccounts).toEqual([]);
        expect(result.desired.slots['preflight.runtime']).toEqual(desired);
        expect(result.actions.filter(action => action.kind === 'account.create')).toHaveLength(0);
    });

    it('rejects an existing deterministic account with a key or attachment instead of suffixing it', () => {
        const base = graph({
            slots: { 'preflight.runtime': identity('preflight-runtime-replaced') },
            desiredSlots: { 'preflight.runtime': deterministicIdentityForSlot(PROJECT, 'preflight.runtime') },
        });
        const desired = deterministicIdentityForSlot(PROJECT, 'preflight.runtime');
        for (const account of [
            { identity: desired, enabled: true, userManagedKeyCount: 1, attachedSlots: [] },
            { identity: desired, enabled: false, userManagedKeyCount: 0, attachedSlots: [] },
            { identity: desired, enabled: true, userManagedKeyCount: 0, attachedSlots: ['paid.runtime' as Slot] },
        ]) {
            expect(() => selectDesiredIdentityGraph({ ...base, accounts: [...base.accounts, account] })).toThrow(/IDENTITY_CONFLICT/);
        }
    });

    it('allows only account creation and recovery scheduler pause actions', () => {
        const base = graph({
            slots: { 'preflight.runtime': identity('preflight-runtime-replaced') },
            desiredSlots: { 'preflight.runtime': deterministicIdentityForSlot(PROJECT, 'preflight.runtime') },
        });
        const result = selectDesiredIdentityGraph({
            ...base,
            schedulerStates: { preflight: 'ENABLED', paid: 'PAUSED' },
            schedulerResources: {
                preflight: 'projects/fixture-project/locations/fixture/jobs/recovery-a',
                paid: 'projects/fixture-project/locations/fixture/jobs/recovery-b',
            },
        });
        expect(ALLOWED_PREPARATION_ACTION_KINDS).toEqual(['account.create', 'scheduler.pause']);
        expect(result.actions.map(action => action.kind)).toEqual(['account.create', 'scheduler.pause']);
        expect(() => selectDesiredIdentityGraph({
            ...base,
            schedulerStates: { preflight: 'ENABLED', paid: 'ENABLED' },
            retentionSchedulerResource: 'projects/fixture-project/locations/fixture/jobs/recovery-a',
        })).toThrow(/IDENTITY_(?:INVALID|CONFLICT)/);
        expect(result.actions.every(action =>
            action.kind === 'account.create' || action.kind === 'scheduler.pause')).toBe(true);
    });
});
