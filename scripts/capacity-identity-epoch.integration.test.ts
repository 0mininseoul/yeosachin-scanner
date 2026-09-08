import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createFixturePacket } from './capacity-identity-epoch/fixtures';
import { EpochCoordinator, type EpochControlPlane, type OperationEvidence } from './capacity-identity-epoch/coordinator';
import { EpochJournal, type JournalStorage, type StoredObject } from './capacity-identity-epoch/journal';
import { canonicalDigest, EpochError, type EpochHeader, type State } from './capacity-identity-epoch/contracts';
import { buildLiveBootstrap, loadProtectedLiveBootstrap } from './capacity-identity-epoch/bootstrap';
import { chmodSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const root = fileURLToPath(new URL('../', import.meta.url));

class MemoryStorage implements JournalStorage {
    private readonly objects = new Map<string, StoredObject>();
    private generation = 0;

    async get(key: string): Promise<StoredObject | null> { return this.objects.get(key) ?? null; }

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
        if (!current || current.generation !== options.ifGenerationMatch) {
            throw new EpochError('GENERATION_PRECONDITION_FAILED');
        }
        this.objects.delete(key);
    }
}

function evidence(state: string, sequence: number): OperationEvidence {
    return {
        precondition: { state, sequence }, mutation: { state }, postcondition: { state, sequence },
        proof: { state, sequence }, nativeConcurrencyToken: { sequence }, resourceObservation: { state, sequence },
    };
}

class ProviderFreeControlPlane implements EpochControlPlane {
    readonly calls: string[] = [];
    readonly effects = { providers: 0, billable: 0, tasks: 0, userWork: 0 };

    private complete(state: string): OperationEvidence {
        this.calls.push(state);
        // These methods model only independently returned fixture evidence;
        // forbidden provider/task/billing/work counters never change.
        return evidence(state, this.calls.length);
    }

    async prepare(): Promise<OperationEvidence> { return this.complete('PREPARED'); }
    async stage(): Promise<OperationEvidence> { return this.complete('STAGED'); }
    async closeAndAlignProducers(): Promise<OperationEvidence> { return this.complete('PRODUCERS_CLOSED_ALIGNED'); }
    async alignQueues(): Promise<OperationEvidence> { return this.complete('QUEUES_ALIGNED'); }
    async rotateInvokers(): Promise<OperationEvidence> { return this.complete('INVOKERS_ROTATED'); }
    async promote(): Promise<OperationEvidence> { return this.complete('SERVICES_PROMOTED'); }
    async verify(): Promise<OperationEvidence> { return this.complete('VERIFIED'); }
    async reconcile(input: { state: State }): Promise<OperationEvidence> { return this.complete(`RECONCILE_${input.state}`); }
    async compensateActivation(): Promise<OperationEvidence> { return this.complete('COMPENSATED'); }
    async activate(): Promise<OperationEvidence> { return this.complete('ACTIVATED'); }
}

function setup() {
    const packet = createFixturePacket();
    const header: EpochHeader = {
        epochIdDigest: canonicalDigest(packet.epochId), capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest, desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest, sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: '2026-09-07T00:00:00.000Z',
    };
    const journal = new EpochJournal(new MemoryStorage(), { header, now: () => 100_000, leaseMs: 10_000 });
    const controlPlane = new ProviderFreeControlPlane();
    const coordinator = new EpochCoordinator({ packet, journal, controlPlane, ownerDigest: canonicalDigest('provider-free-owner'), now: () => 100_000 });
    return { coordinator, controlPlane, journal };
}

describe('provider-free coordinated identity epoch integration', () => {
    it('runs through VERIFIED without provider, billing, task, or user-work effects', async () => {
        const { coordinator, controlPlane, journal } = setup();
        const result = await coordinator.runThroughVerified();
        const state = await journal.readValidatedState(result.lease);
        expect(result.state).toBe('VERIFIED');
        expect(controlPlane.calls).toEqual([
            'PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED',
            'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED',
        ]);
        expect(controlPlane.effects).toEqual({ providers: 0, billable: 0, tasks: 0, userWork: 0 });
        expect(state.transitions.map(transition => transition.toState)).toEqual([
            'PREPARED', 'STAGED', 'PRODUCERS_CLOSED_ALIGNED', 'QUEUES_ALIGNED',
            'INVOKERS_ROTATED', 'SERVICES_PROMOTED', 'VERIFIED',
        ]);
    });

    it('refuses live CLI construction without an inherited protected packet descriptor', () => {
        const script = join(root, 'scripts/run-capacity-identity-epoch.ts');
        const result = spawnSync(process.execPath, ['--import', 'tsx', script, 'check'], {
            cwd: root,
            env: { ...process.env, NODE_ENV: 'test' },
            encoding: 'utf8',
            timeout: 30_000,
        });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('PROTECTED_INPUT_UNAVAILABLE\n');
        expect(result.stdout).not.toMatch(/example-project|https?:\/\//);
        expect(result.stderr).not.toMatch(/example-project|https?:\/\//);
    });

    it('constructs the real adapter graph only after packet-bound bootstrap validation', async () => {
        const packet = createFixturePacket();
        const scope = packet.providerScope;
        const descriptor = {
            packetDigest: canonicalDigest(packet), ownerDigest: canonicalDigest('provider-free-bootstrap-owner'), lockNamespace: packet.lockNamespace,
            ...scope, scopeDigest: canonicalDigest(scope), vercelToken: 'fixture-vercel-token',
            serviceBodies: { preflight: { spec: {} }, paid: { spec: {} } },
        } as const;
        const directory = mkdtempSync(join(tmpdir(), 'identity-epoch-bootstrap-'));
        const descriptorPath = join(directory, 'bootstrap.json');
        writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
        const fd = openSync(descriptorPath, 'r');
        try {
            chmodSync(descriptorPath, 0o600);
            const loaded = await loadProtectedLiveBootstrap(fd);
            const storage = new MemoryStorage();
            const live = await buildLiveBootstrap(packet, loaded, { storage, now: () => 1_000 });
            await live.journal.ensureHeader();
            const resumed = await buildLiveBootstrap(packet, loaded, { storage, now: () => 2_000 });
            expect(live.missingEvidence).toEqual([
                'sourceObservation', 'buildObservation', 'pauseProvenance',
                'zeroWorkBaseline', 'zeroWorkObservation', 'probe',
            ]);
            expect(live.journal.headerKey).toContain('epoch-header');
            expect(resumed.journal.headerKey).toBe(live.journal.headerKey);
            expect(resumed.journal.epochHeaderDigest).toBe(live.journal.epochHeaderDigest);
            expect(resumed.journal.lockKey).toBe(live.journal.lockKey);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
        await expect(buildLiveBootstrap(packet, { ...descriptor, packetDigest: 'f'.repeat(64) }, { resolveRetainedHeader: false })).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        const replacements: { [K in keyof typeof packet.providerScope]: string } = {
            bucket: 'other-epoch-bucket',
            publicReadinessUrl: 'https://other.example.invalid/api/analysis/capacity/readiness',
            googleProjectId: 'other-project',
            vercelProjectId: 'other-vercel-project',
            vercelTeamId: 'other-team',
            vercelDeploymentId: 'dpl-other',
            vercelExpectedOldDeploymentId: 'dpl-previous',
            vercelProducerAlias: 'other.example.invalid',
        };
        for (const key of Object.keys(replacements) as Array<keyof typeof packet.providerScope>) {
            const retargetedScope = { ...packet.providerScope, [key]: replacements[key] };
            await expect(buildLiveBootstrap(packet, {
                ...descriptor,
                ...retargetedScope,
                scopeDigest: canonicalDigest(retargetedScope),
            }, { resolveRetainedHeader: false })).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        }

        const headerKey = `${'epoch'}/epoch-header/${canonicalDigest(packet.epochId)}/${packet.desiredManifestDigest}.json`;
        const retainedHeader = {
            epochIdDigest: canonicalDigest(packet.epochId), capabilityDigest: packet.capabilityDigest,
            oldManifestDigest: packet.oldManifestDigest, desiredManifestDigest: packet.desiredManifestDigest,
            roleSetDigest: packet.roleSetDigest, sourcePlanDigest: packet.sourcePlanDigest,
            createdAt: new Date(1_000).toISOString(),
        } as const;
        const malformedStorage = new MemoryStorage();
        await malformedStorage.put(headerKey, { ...retainedHeader, unexpected: true }, { ifGenerationMatch: '0' });
        await expect(buildLiveBootstrap(packet, descriptor, {
            storage: malformedStorage,
            now: () => 2_000,
        })).rejects.toThrow('JOURNAL_INVALID');

        const mismatchedStorage = new MemoryStorage();
        await mismatchedStorage.put(headerKey, { ...retainedHeader, sourcePlanDigest: '0'.repeat(64) }, { ifGenerationMatch: '0' });
        await expect(buildLiveBootstrap(packet, descriptor, {
            storage: mismatchedStorage,
            now: () => 2_000,
        })).rejects.toThrow('JOURNAL_INVALID');
    });
});
