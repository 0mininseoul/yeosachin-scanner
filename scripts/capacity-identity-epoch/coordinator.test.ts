import { describe, expect, it } from 'vitest';
import { EpochError, canonicalDigest, type EpochHeader, type State } from './contracts';
import { EpochJournal, type JournalStorage, type StoredObject } from './journal';
import { EpochCoordinator, type EpochControlPlane, type OperationEvidence } from './coordinator';
import { createFixturePacket } from './fixtures';
import { issueCoordinatorCapability } from './packet';

class MemoryStorage implements JournalStorage {
    private readonly values = new Map<string, StoredObject>();
    private generation = 0;

    async get(key: string): Promise<StoredObject | null> { return this.values.get(key) ?? null; }
    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }): Promise<StoredObject> {
        const current = this.values.get(key);
        if (options.ifGenerationMatch === '0' ? current !== undefined : current?.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        const stored = { generation: String(++this.generation), value };
        this.values.set(key, stored);
        return stored;
    }
    async list(prefix: string): Promise<ReadonlyArray<StoredObject & { key: string }>> {
        return [...this.values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, ...value }));
    }
    async delete(key: string, options: { ifGenerationMatch: string }): Promise<void> {
        const current = this.values.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        this.values.delete(key);
    }
}

function evidence(state: string, sequence: number): OperationEvidence {
    return {
        precondition: { state, sequence }, mutation: { state }, postcondition: { state, sequence },
        proof: { state, sequence }, nativeConcurrencyToken: { sequence }, resourceObservation: { state, sequence },
    };
}

class FixtureControlPlane implements EpochControlPlane {
    readonly calls: string[] = [];
    failAt: string | undefined;

    private run(state: string): OperationEvidence {
        this.calls.push(state);
        if (this.failAt === state) throw new EpochError('PROBE_FAILED');
        return evidence(state, this.calls.length);
    }
    async prepare(): Promise<OperationEvidence> { return this.run('PREPARED'); }
    async stage(): Promise<OperationEvidence> { return this.run('STAGED'); }
    async closeAndAlignProducers(): Promise<OperationEvidence> { return this.run('PRODUCERS_CLOSED_ALIGNED'); }
    async alignQueues(): Promise<OperationEvidence> { return this.run('QUEUES_ALIGNED'); }
    async rotateInvokers(): Promise<OperationEvidence> { return this.run('INVOKERS_ROTATED'); }
    async promote(): Promise<OperationEvidence> { return this.run('SERVICES_PROMOTED'); }
    async verify(): Promise<OperationEvidence> { return this.run('VERIFIED'); }
    async reconcile(input: { state: State }): Promise<OperationEvidence> { return this.run(`RECONCILE_${input.state}`); }
    async compensateActivation(): Promise<OperationEvidence> { return this.run('COMPENSATED'); }
    async activate(): Promise<OperationEvidence> { return this.run('ACTIVATED'); }
}

function setup(now = 1_000) {
    const packet = createFixturePacket();
    const header: EpochHeader = {
        epochIdDigest: canonicalDigest(packet.epochId), capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest, desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest, sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: '2026-09-07T00:00:00.000Z',
    };
    const storage = new MemoryStorage();
    const journal = new EpochJournal(storage, { header, now: () => now, leaseMs: 10_000 });
    const controlPlane = new FixtureControlPlane();
    const coordinator = new EpochCoordinator({ packet, journal, controlPlane, ownerDigest: canonicalDigest('fixture-owner'), now: () => now });
    return { packet, storage, journal, controlPlane, coordinator };
}

describe('ordered coordinator', () => {
    it('runs concrete operation barriers exactly through VERIFIED and keeps gates closed', async () => {
        const { coordinator, controlPlane, journal } = setup();
        const result = await coordinator.runThroughVerified();
        expect(result.state).toBe('VERIFIED');
        expect(controlPlane.calls).toEqual(['PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED', 'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED']);
        const state = await journal.readValidatedState(result.lease);
        expect(state.state).toBe('VERIFIED');
        expect(state.transitions).toHaveLength(7);
        expect(state.transitions.map(transition => transition.toState)).toEqual(['PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED', 'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED']);
    });

    it('resumes idempotently at VERIFIED without any operation or activation', async () => {
        const first = setup();
        await first.coordinator.runThroughVerified();
        const resumed = await first.coordinator.runThroughVerified();
        expect(resumed.state).toBe('VERIFIED');
        expect(first.controlPlane.calls).toEqual(['PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED', 'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED', 'VERIFIED']);
    });

    it('requires opaque fresh authorization for offline activation and rejects copied tokens', async () => {
        const { coordinator, controlPlane } = setup();
        const result = await coordinator.runThroughVerified();
        const authorization = coordinator.issueActivationAuthorization();
        await expect(coordinator.activate(Object.create(authorization))).rejects.toThrow('ACTIVATION_AUTH_REQUIRED');
        const activated = await coordinator.activate(authorization);
        expect(activated.state).toBe('ACTIVATED');
        expect(controlPlane.calls.at(-1)).toBe('ACTIVATED');
        expect(result.proofDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('persists an abort marker retaining the last state and blocks continuation', async () => {
        const { coordinator, journal } = setup();
        await coordinator.runThroughVerified();
        const aborted = await coordinator.abort('OPERATOR_ABORT');
        expect(aborted).toMatchObject({ state: 'VERIFIED', aborted: true });
        await expect(coordinator.runThroughVerified()).rejects.toThrow('ABORTED_EPOCH');
        const state = await journal.readValidatedState((await journal.acquire(canonicalDigest('fixture-owner'))));
        expect(state).toMatchObject({ state: 'VERIFIED', aborted: true });
    });

    it('does not append a state when an operation fails before its postcondition', async () => {
        const { coordinator, controlPlane, journal } = setup();
        controlPlane.failAt = 'QUEUES_ALIGNED';
        await expect(coordinator.runThroughVerified()).rejects.toThrow('PROBE_FAILED');
        const lease = await journal.acquire(canonicalDigest('fixture-owner'));
        const state = await journal.readValidatedState(lease);
        expect(state.state).toBe('PRODUCERS_CLOSED_ALIGNED');
        expect(state.transitions).toHaveLength(3);
    });

    it('rejects a capability bound to a different owner before journal work', () => {
        const packet = createFixturePacket();
        const header: EpochHeader = {
            epochIdDigest: canonicalDigest(packet.epochId), capabilityDigest: packet.capabilityDigest,
            oldManifestDigest: packet.oldManifestDigest, desiredManifestDigest: packet.desiredManifestDigest,
            roleSetDigest: packet.roleSetDigest, sourcePlanDigest: packet.sourcePlanDigest,
            createdAt: '2026-09-07T00:00:00.000Z',
        };
        const journal = new EpochJournal(new MemoryStorage(), { header, now: () => 1_000, leaseMs: 10_000 });
        const capability = issueCoordinatorCapability(packet, canonicalDigest('owner-a'));
        expect(() => new EpochCoordinator({ packet, journal, controlPlane: new FixtureControlPlane(), ownerDigest: canonicalDigest('owner-b'), capability })).toThrow('CAPABILITY_BINDING_MISMATCH');
    });

    it('freezes nested protected packet input after bootstrap', () => {
        const { packet } = setup();
        expect(Object.isFrozen(packet)).toBe(true);
        expect(Object.isFrozen(packet.protectedInputs.desired.runtime.preflight.environment)).toBe(true);
        expect(() => {
            (packet.protectedInputs.desired.runtime.preflight.environment as Record<string, string>).MUTATED = 'true';
        }).toThrow();
    });
});
