import { describe, expect, it } from 'vitest';
import { deterministicIdentityForSlot, type IdentityGraphObservation } from './owner-preparation';
import {
    OwnerPreparationOperator,
    parsePreparationCommand,
    type PreparationObservation,
} from './owner-preparation-operator';
import { EpochError, SLOTS, type Role } from './contracts';

const PROJECT = 'fixture-project';

function identity(accountId: string) {
    return { identity: `${accountId}@${PROJECT}.iam.gserviceaccount.com`, project: PROJECT };
}

function observation(): PreparationObservation {
    const slots = Object.fromEntries(SLOTS.map(slot => [slot, identity(`${slot.replaceAll('.', '-')}-old`)])) as IdentityGraphObservation['slots'];
    return {
        identityGraph: {
            project: PROJECT,
            build: identity('build-old'),
            slots,
            accounts: SLOTS.map(slot => ({ identity: slots[slot]!, enabled: true, userManagedKeyCount: 0, attachedSlots: [slot] })),
        },
        readiness: { ready: true, analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false },
        queues: { preflight: { resource: 'queue-preflight', state: 'PAUSED', empty: true, complete: true }, paid: { resource: 'queue-paid', state: 'PAUSED', empty: true, complete: true } },
        schedulers: {
            preflight: { resource: 'recovery-preflight', state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null },
            paid: { resource: 'recovery-paid', state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null },
        },
        retention: { resource: 'retention', enabled: true },
    };
}

describe('owner preparation inspect/apply operator', () => {
    it('accepts only the four strict command forms', () => {
        expect(parsePreparationCommand(['prepare', 'inspect'])).toEqual({ command: 'prepare.inspect' });
        expect(parsePreparationCommand(['prepare', 'apply', '--approved-digest', 'a'.repeat(64)])).toEqual({ command: 'prepare.apply', approvedDigest: 'a'.repeat(64) });
        expect(parsePreparationCommand(['epoch', 'inspect'])).toEqual({ command: 'epoch.inspect' });
        expect(parsePreparationCommand(['epoch', 'apply', '--approved-digest', 'a'.repeat(64), '--through', 'VERIFIED'])).toEqual({ command: 'epoch.apply', approvedDigest: 'a'.repeat(64), through: 'VERIFIED' });
        for (const argv of [
            ['prepare', 'apply'], ['prepare', 'inspect', '--approved-digest', 'a'.repeat(64)],
            ['epoch', 'apply', '--approved-digest', 'a'.repeat(64)], ['epoch', 'apply', '--approved-digest', 'a'.repeat(64), '--through', 'ACTIVATED'],
            ['prepare', 'apply', '--approved-digest', 'example'],
        ]) expect(() => parsePreparationCommand(argv)).toThrow('ADAPTER_REQUEST_INVALID');
    });

    it('keeps inspect read-only and exposes only safe proposal summary fields', async () => {
        let discovered = 0;
        let mutations = 0;
        const operator = new OwnerPreparationOperator({
            discover: async () => { discovered += 1; return observation(); },
            mutate: {
                createAccount: async () => { mutations += 1; },
                readAccount: async input => ({ identity: input.identity, enabled: true, userManagedKeyCount: 0, attachedSlots: [] }),
                pauseScheduler: async () => { mutations += 1; },
                readScheduler: async input => ({ ...input, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null }),
            },
            now: () => 100_000,
            quiescence: { timeoutMs: 60_000, graceMs: 5_000 },
        });
        const result = await operator.inspect();
        expect(discovered).toBe(1);
        expect(mutations).toBe(0);
        expect(Object.keys(result.summary).sort()).toEqual(['actionKinds', 'conflictFree', 'discoveryDigest', 'identityGraphDigest', 'missingCount', 'proposalDigest', 'reusedCount']);
        expect(JSON.stringify(result.summary)).not.toMatch(/fixture|old|secret|token|resource/i);
    });

    it('stops on a stale digest before the first account or scheduler mutation', async () => {
        let current = observation();
        const calls: string[] = [];
        const operator = new OwnerPreparationOperator({
            discover: async () => current,
            mutate: {
                createAccount: async () => { calls.push('account.create'); },
                readAccount: async input => ({ identity: input.identity, enabled: true, userManagedKeyCount: 0, attachedSlots: [] }),
                pauseScheduler: async () => { calls.push('scheduler.pause'); },
                readScheduler: async input => ({ ...input, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null }),
            },
            now: () => 100_000,
            quiescence: { timeoutMs: 60_000, graceMs: 5_000 },
        });
        const inspection = await operator.inspect();
        current = { ...current, queues: { ...current.queues, paid: { ...current.queues.paid, empty: false } } };
        await expect(operator.apply(inspection.summary.discoveryDigest)).rejects.toThrow('PROPOSAL_STALE');
        expect(calls).toEqual([]);
    });

    it('executes only missing-account creation and recovery pause, then fails closed until grace matures', async () => {
        const base = observation();
        const desired = deterministicIdentityForSlot(PROJECT, 'preflight.runtime');
        const current: PreparationObservation = {
            ...base,
            identityGraph: {
                ...base.identityGraph,
                desiredSlots: { 'preflight.runtime': desired },
            },
            schedulers: {
                ...base.schedulers,
                preflight: { ...base.schedulers.preflight, state: 'ENABLED', pauseEpochMs: 0 },
            },
        };
        const calls: string[] = [];
        const operator = new OwnerPreparationOperator({
            discover: async () => current,
            mutate: {
                createAccount: async input => { calls.push(`account.create:${input.slot}`); },
                readAccount: async input => ({ identity: input.identity, enabled: true, userManagedKeyCount: 0, attachedSlots: [] }),
                pauseScheduler: async input => { calls.push(`scheduler.pause:${input.role}`); },
                readScheduler: async input => ({ ...input, state: 'PAUSED', pauseEpochMs: 99_000, lastAttemptMs: null }),
            },
            now: () => 100_000,
            quiescence: { timeoutMs: 60_000, graceMs: 5_000 },
        });
        const inspection = await operator.inspect();
        await expect(operator.apply(inspection.summary.discoveryDigest)).rejects.toThrow('QUIESCENCE_PENDING');
        expect(calls).toEqual(['scheduler.pause:preflight', 'account.create:preflight.runtime']);
    });

    it('pauses enabled recovery schedulers before account creation and stops on a partial pause failure', async () => {
        const base = observation();
        const current: PreparationObservation = {
            ...base,
            identityGraph: {
                ...base.identityGraph,
                desiredSlots: { 'preflight.runtime': deterministicIdentityForSlot(PROJECT, 'preflight.runtime') },
            },
            schedulers: {
                preflight: { ...base.schedulers.preflight, state: 'ENABLED', pauseEpochMs: 0 },
                paid: { ...base.schedulers.paid, state: 'ENABLED', pauseEpochMs: 0 },
            },
        };
        const calls: string[] = [];
        const operator = new OwnerPreparationOperator({
            discover: async () => current,
            mutate: {
                createAccount: async input => { calls.push(`account.create:${input.slot}`); },
                readAccount: async input => ({ identity: input.identity, enabled: true, userManagedKeyCount: 0, attachedSlots: [] }),
                pauseScheduler: async input => {
                    calls.push(`scheduler.pause:${input.role}`);
                    if (input.role === 'paid') throw new Error('pause failed');
                },
                readScheduler: async input => ({ ...input, state: 'PAUSED', pauseEpochMs: 99_000, lastAttemptMs: null }),
            },
            now: () => 100_000,
            quiescence: { timeoutMs: 60_000, graceMs: 5_000 },
        });
        const inspection = await operator.inspect();
        await expect(operator.apply(inspection.summary.discoveryDigest)).rejects.toThrow(EpochError);
        expect(calls).toEqual(['scheduler.pause:preflight', 'scheduler.pause:paid']);
    });

    it('keeps the next mutation closed when an account create crashes', async () => {
        const current = { ...observation(), identityGraph: { ...observation().identityGraph, desiredSlots: { 'preflight.runtime': deterministicIdentityForSlot(PROJECT, 'preflight.runtime') } } };
        const calls: string[] = [];
        const operator = new OwnerPreparationOperator({
            discover: async () => current,
            mutate: {
                createAccount: async () => { calls.push('account.create'); throw new Error('protected provider error'); },
                readAccount: async input => ({ identity: input.identity, enabled: true, userManagedKeyCount: 0, attachedSlots: [] }),
                pauseScheduler: async () => { calls.push('scheduler.pause'); },
                readScheduler: async input => ({ ...input, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null }),
            },
            now: () => 100_000,
            quiescence: { timeoutMs: 60_000, graceMs: 5_000 },
        });
        const inspection = await operator.inspect();
        await expect(operator.apply(inspection.summary.discoveryDigest)).rejects.toThrow(EpochError);
        await expect(operator.apply(inspection.summary.discoveryDigest)).rejects.not.toThrow(/protected provider error/);
        expect(calls).toEqual(['account.create', 'account.create']);
    });
});
