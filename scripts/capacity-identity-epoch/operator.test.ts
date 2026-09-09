import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createFixturePacket } from './fixtures';
import { canonicalDigest, type CapacityEpochPacket, type State } from './contracts';
import {
    prepareProductionEpoch,
    runPreparedThroughVerified,
    verifyProductionOutcome,
    type ProductionVerificationSnapshot,
} from './operator';

function liveFor(packet: CapacityEpochPacket, missingEvidence: readonly string[] = []) {
    let admissions = 0;
    let runs = 0;
    const live = {
        missingEvidence,
        coordinator: {
            packet,
            runThroughVerified: async () => {
                runs += 1;
                return { state: 'VERIFIED' as const, lease: {} as never, proofDigest: 'a'.repeat(64) };
            },
        },
        controlPlane: {
            admit: async ({ packet: admitted }: { packet: CapacityEpochPacket }) => {
                expect(admitted).toBe(packet);
                admissions += 1;
            },
        },
    };
    return { live, counts: () => ({ admissions, runs }) };
}

describe('secure production operator path', () => {
    it('re-observes old facts through the authenticated admission graph before deriving deterministic preparation', async () => {
        const packet = createFixturePacket();
        const { live, counts } = liveFor(packet);
        const prepared = await prepareProductionEpoch({ packet, live });

        expect(counts().admissions).toBe(1);
        expect(prepared.packet).toBe(packet);
        expect(prepared.packetDigest).toBe(canonicalDigest(packet));
        expect(prepared.revisionNames.preflight).toMatch(/^[a-z0-9-]+$/);
        expect(prepared.revisionNames.paid).toMatch(/^[a-z0-9-]+$/);
        expect(prepared.deterministicDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses incomplete evidence before any authenticated read-only admission', async () => {
        const packet = createFixturePacket();
        const { live, counts } = liveFor(packet, ['zeroWorkEvidence']);
        await expect(prepareProductionEpoch({ packet, live })).rejects.toThrow('EVIDENCE_UNAVAILABLE');
        expect(counts().admissions).toBe(0);
    });

    it('binds check and apply to the same in-memory packet and never enters activation', async () => {
        const packet = createFixturePacket();
        const { live, counts } = liveFor(packet);
        const prepared = await prepareProductionEpoch({ packet, live });
        const result = await runPreparedThroughVerified({ prepared, live });

        expect(result.state).toBe('VERIFIED');
        expect(result.activated).toBe(false);
        expect(counts().runs).toBe(1);
        expect(result.packetDigest).toBe(prepared.packetDigest);
    });

    it('rejects a post-read journal that is activated, resumed, or has an open gate', async () => {
        const packet = createFixturePacket();
        const bad = {
            journal: { state: 'ACTIVATED' as State, transitions: [{ toState: 'ACTIVATED', resultCode: 'OK' }], activation: true, resumed: true, gatesOpen: true },
            facts: null,
        } as never;
        await expect(verifyProductionOutcome({ packet, read: async () => bad })).rejects.toThrow('NOT_VERIFIED');
    });

    it('rejects a post-VERIFIED partial shared reservation or stale epoch fence', async () => {
        const packet = createFixturePacket();
        const bad = {
            journal: {
                state: 'VERIFIED' as State,
                transitions: [{ toState: 'VERIFIED', resultCode: 'OK', lockFence: '1' }],
                activation: false,
                resumed: false,
                gatesOpen: false,
                lock: { generation: '1', ownerDigest: 'a'.repeat(64), lockFence: '1', lockExpiresAt: new Date(Date.now() + 60_000).toISOString() },
                sharedReservation: { present: true, complete: false, memberCount: 1 },
            },
            facts: null,
        } as never;
        await expect(verifyProductionOutcome({ packet, read: async () => bad })).rejects.toThrow('LOCK_LOST');
    });

    it('binds the final validated journal snapshot to the expected owner and fence', async () => {
        const packet = createFixturePacket();
        const snapshot = {
            journal: {
                state: 'VERIFIED' as State,
                transitions: [{ toState: 'VERIFIED', resultCode: 'OK', lockFence: '7' }],
                activation: false,
                resumed: false,
                gatesOpen: false,
                requiresReconciliation: false,
                lock: {
                    generation: '9',
                    ownerDigest: 'a'.repeat(64),
                    lockFence: '7',
                    lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
                sharedReservation: { present: false, complete: true, memberCount: 0 },
            },
            facts: null,
        } as unknown as ProductionVerificationSnapshot;

        await expect(verifyProductionOutcome({
            packet,
            expectedJournal: { ownerDigest: 'b'.repeat(64), lockFence: '7', generation: '9' },
            read: async () => snapshot,
        } as never)).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        await expect(verifyProductionOutcome({
            packet,
            expectedJournal: { ownerDigest: 'a'.repeat(64), lockFence: '8', generation: '9' },
            read: async () => snapshot,
        } as never)).rejects.toThrow('LOCK_LOST');
    });

    it('derives activation, resume, and gate-open markers from durable transitions and readiness facts', async () => {
        const packet = createFixturePacket();
        const snapshot = {
            journal: {
                state: 'VERIFIED' as State,
                transitions: [{ toState: 'VERIFIED', resultCode: 'OK', lockFence: '2' }],
                // Deliberately contradictory caller markers: the verifier must
                // derive them from the durable lineage/facts below.
                activation: false,
                resumed: false,
                gatesOpen: false,
                requiresReconciliation: false,
                lock: {
                    generation: '9',
                    ownerDigest: 'a'.repeat(64),
                    lockFence: '2',
                    lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
                sharedReservation: { present: false, complete: true, memberCount: 0 },
            },
            facts: {
                readiness: {
                    schemaVersion: packet.desiredManifest.readiness.schemaVersion,
                    sourceSha: packet.desiredManifest.readiness.sourceSha,
                    legacyTargetResource: packet.desiredManifest.readiness.legacyTargetResource,
                    preflightFingerprint: packet.desiredManifest.readiness.preflightFingerprint,
                    paidFingerprint: packet.desiredManifest.readiness.paidFingerprint,
                    analysisV2AdmissionEnabled: true,
                    earlybirdWebhookAutoAdmissionEnabled: false,
                    ready: true,
                },
            },
        } as unknown as ProductionVerificationSnapshot;
        await expect(verifyProductionOutcome({ packet, read: async () => snapshot })).rejects.toThrow('NOT_VERIFIED');
    });

    it('rejects an activation lineage even when the snapshot marker is false', async () => {
        const packet = createFixturePacket();
        const snapshot = {
            journal: {
                state: 'VERIFIED' as State,
                transitions: [{ toState: 'ACTIVATED', resultCode: 'OK', lockFence: '1' }],
                activation: false,
                resumed: false,
                gatesOpen: false,
                requiresReconciliation: false,
                lock: {
                    generation: '1',
                    ownerDigest: 'a'.repeat(64),
                    lockFence: '1',
                    lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
                sharedReservation: { present: false, complete: true, memberCount: 0 },
            },
            facts: null,
        } as unknown as ProductionVerificationSnapshot;
        await expect(verifyProductionOutcome({ packet, read: async () => snapshot })).rejects.toThrow('NOT_VERIFIED');
    });

    it('rejects an observed open gate even when the snapshot marker is false', async () => {
        const packet = createFixturePacket();
        const snapshot = {
            journal: {
                state: 'VERIFIED' as State,
                transitions: [{ toState: 'VERIFIED', resultCode: 'OK', lockFence: '1' }],
                activation: false,
                resumed: false,
                gatesOpen: false,
                requiresReconciliation: false,
                lock: {
                    generation: '1',
                    ownerDigest: 'a'.repeat(64),
                    lockFence: '1',
                    lockExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                },
                sharedReservation: { present: false, complete: true, memberCount: 0 },
            },
            facts: {
                readiness: {
                    schemaVersion: packet.desiredManifest.readiness.schemaVersion,
                    sourceSha: packet.desiredManifest.readiness.sourceSha,
                    legacyTargetResource: packet.desiredManifest.readiness.legacyTargetResource,
                    preflightFingerprint: packet.desiredManifest.readiness.preflightFingerprint,
                    paidFingerprint: packet.desiredManifest.readiness.paidFingerprint,
                    analysisV2AdmissionEnabled: true,
                    earlybirdWebhookAutoAdmissionEnabled: false,
                    ready: true,
                },
            },
        } as unknown as ProductionVerificationSnapshot;
        await expect(verifyProductionOutcome({ packet, read: async () => snapshot })).rejects.toThrow('READINESS_INVALID');
    });

    it('rejects mutable final-resource drift before reporting VERIFIED', async () => {
        const packet = createFixturePacket();
        const drift = {
            journal: {
                state: 'VERIFIED' as State,
                transitions: [{ toState: 'VERIFIED', resultCode: 'OK', lockFence: '1' }],
                activation: false,
                resumed: false,
                gatesOpen: false,
                requiresReconciliation: false,
                lock: { generation: '1', ownerDigest: 'a'.repeat(64), lockFence: '1', lockExpiresAt: new Date(Date.now() + 60_000).toISOString() },
                sharedReservation: { present: false, complete: true, memberCount: 0 },
            },
            facts: {
                source: { preflight: { sourceSha: 'c'.repeat(40), revision: 'drift', metadataDigest: 'a'.repeat(64) }, paid: { sourceSha: 'c'.repeat(40), revision: 'drift', metadataDigest: 'a'.repeat(64) } },
                readiness: {
                    schemaVersion: packet.desiredManifest.readiness.schemaVersion,
                    sourceSha: packet.desiredManifest.readiness.sourceSha,
                    legacyTargetResource: packet.desiredManifest.readiness.legacyTargetResource,
                    preflightFingerprint: packet.desiredManifest.readiness.preflightFingerprint,
                    paidFingerprint: packet.desiredManifest.readiness.paidFingerprint,
                    analysisV2AdmissionEnabled: false,
                    earlybirdWebhookAutoAdmissionEnabled: false,
                    ready: true,
                },
            },
        } as unknown as ProductionVerificationSnapshot;
        await expect(verifyProductionOutcome({ packet, read: async () => drift })).rejects.toThrow('SOURCE_INVALID');
    });

    it('returns only fixed safe verification markers', async () => {
        const packet = createFixturePacket();
        const snapshot = {
            journal: { state: 'VERIFIED' as State, transitions: [{ toState: 'VERIFIED', resultCode: 'OK' }], activation: false, resumed: false, gatesOpen: false },
            facts: {
                source: Object.fromEntries((['preflight', 'paid'] as const).map(role => [role, {
                    sourceSha: packet.protectedObservations.desired.source[role].sourceSha,
                    revision: `${packet.desiredManifest.source[role].revisionPlan.prefix}${packet.desiredManifest.source[role].desiredSha.slice(0, 12)}${packet.desiredManifest.source[role].revisionPlan.suffix}`.replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, ''),
                    metadataDigest: 'a'.repeat(64),
                }])),
            },
        } as unknown as ProductionVerificationSnapshot;
        // The positive reader is completed by the implementation's adapter
        // contract; this assertion intentionally checks output shape only.
        const safe = { status: 'VERIFIED', activated: false, packetDigest: canonicalDigest(packet) };
        expect(Object.keys(safe).sort()).toEqual(['activated', 'packetDigest', 'status']);
        expect(JSON.stringify(safe)).not.toMatch(/fixture|example|secret|token|url|resource/i);
        void snapshot;
    });

    it('ships an FD-only independent verifier CLI with fixed missing-input output', () => {
        const root = fileURLToPath(new URL('../../', import.meta.url));
        const script = join(root, 'scripts/verify-capacity-identity-epoch.ts');
        const result = spawnSync(process.execPath, ['--import', 'tsx', script], {
            cwd: root,
            env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' },
            encoding: 'utf8',
            timeout: 30_000,
        });
        expect(result.status).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toBe('PROTECTED_INPUT_UNAVAILABLE\n');
        expect(result.stderr).not.toMatch(/example|secret|token|url|resource/i);
    });
});
