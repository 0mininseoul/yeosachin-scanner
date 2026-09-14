import { describe, expect, it } from 'vitest';
import { canonicalDigest, EpochError, type CapacityEpochPacket, type Role } from './contracts';
import { createFixturePacket } from './fixtures';
import {
    assembleOwnerDescriptors,
    buildTwoPassDescriptorProposal,
    serializeProtectedDescriptor,
    type OwnerDescriptorAssemblyInput,
} from './owner-descriptors';

function serviceBodies(packet: CapacityEpochPacket): Record<Role, Record<string, unknown>> {
    return Object.fromEntries((['preflight', 'paid'] as const).map(role => {
        const runtime = packet.protectedInputs.desired.runtime[role];
        const plan = packet.desiredManifest.source[role].revisionPlan;
        const revision = `${plan.prefix}${packet.desiredManifest.source[role].desiredRevisionId ?? `${packet.desiredManifest.source[role].desiredSha.slice(0, 12)}${plan.suffix}`}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
        const image = `region-docker.pkg.dev/${runtime.project}/workers/${role}@sha256:${'c'.repeat(64)}`;
        const env = [
            ...Object.entries(runtime.environment).map(([name, value]) => ({ name, value })),
            ...Object.entries(runtime.secretReferences).map(([name, ref]) => {
                const [secretName, key] = ref.split(':');
                return { name, valueFrom: { secretKeyRef: { name: secretName, key } } };
            }),
        ];
        return [role, {
            metadata: { name: runtime.service, generation: 1, resourceVersion: packet.protectedObservations.old.runtime[role].resourceVersion, labels: {}, annotations: {} },
            spec: {
                template: {
                    metadata: { name: revision, labels: {}, annotations: {
                        'autoscaling.knative.dev/maxScale': String(runtime.settings.maxInstances),
                        'capacity.identity-epoch/source-sha': runtime.sourceSha,
                        'capacity.identity-epoch/build-digest': packet.desiredManifest.source[role].desiredBuildDigest,
                        'capacity.identity-epoch/image-digest': canonicalDigest({ image }),
                    } },
                    spec: { serviceAccountName: runtime.identity.identity, containerConcurrency: runtime.settings.concurrency, timeoutSeconds: runtime.settings.timeoutSeconds, containers: [{ image, env, resources: { limits: { cpu: runtime.settings.cpu, memory: runtime.settings.memory } } }] },
                },
                traffic: [{ revisionName: packet.oldManifest.source[role].oldRevision, percent: 100, tag: null }, { revisionName: revision, percent: 0, tag: null }],
            },
        }];
    })) as unknown as Record<Role, Record<string, unknown>>;
}

function input(packet: CapacityEpochPacket): OwnerDescriptorAssemblyInput {
    return {
        packet,
        ownerDigest: canonicalDigest('fixture-owner'),
        vercelToken: 'fixture-vercel-token',
        serviceBodies: serviceBodies(packet),
        zeroWorkEvidence: null,
    };
}

describe('owner packet/bootstrap descriptor assembly', () => {
    it('binds packet and bootstrap to the exact scope and keeps credentials out of the digest projection', () => {
        const assembled = assembleOwnerDescriptors(input(createFixturePacket()));
        expect(assembled.packetDigest).toBe(canonicalDigest(assembled.packet));
        expect(assembled.bootstrap.packetDigest).toBe(assembled.packetDigest);
        expect(assembled.scopeDigest).toBe(canonicalDigest(assembled.packet.providerScope));
        expect(assembled.bootstrap.scopeDigest).toBe(assembled.scopeDigest);
        expect(assembled.proposalDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(JSON.stringify({
            packetDigest: assembled.packetDigest,
            bootstrapDigest: assembled.bootstrapDigest,
            scopeDigest: assembled.scopeDigest,
            identityGraphDigest: assembled.identityGraphDigest,
        })).not.toContain('fixture-vercel-token');
    });

    it('rejects any packet/runtime drift through the existing protected packet validator', () => {
        const packet = createFixturePacket();
        const runtime = packet.protectedInputs.desired.runtime.preflight;
        const drifted = {
            ...packet,
            protectedInputs: {
                ...packet.protectedInputs,
                desired: {
                    ...packet.protectedInputs.desired,
                    runtime: { ...packet.protectedInputs.desired.runtime, preflight: { ...runtime, settings: { ...runtime.settings, concurrency: 2 } } },
                },
            },
        } as CapacityEpochPacket;
        expect(() => assembleOwnerDescriptors({ ...input(drifted), packet: drifted })).toThrow(EpochError);
    });

    it('requires two fresh read-only passes to produce one stable proposal and rejects drift', async () => {
        const packet = createFixturePacket();
        let reads = 0;
        const stable = await buildTwoPassDescriptorProposal({
            readPass: async () => { reads += 1; return input(packet); },
        });
        expect(reads).toBe(2);
        expect(stable.first.proposalDigest).toBe(stable.second.proposalDigest);
        expect(stable.proposalDigest).toBe(stable.first.proposalDigest);

        let driftReads = 0;
        await expect(buildTwoPassDescriptorProposal({
            readPass: async () => {
                driftReads += 1;
                const current = createFixturePacket();
                if (driftReads === 2) {
                    return { ...input(current), ownerDigest: canonicalDigest('drift-owner') };
                }
                return input(current);
            },
        })).rejects.toThrow('PROPOSAL_STALE');
    });

    it('serializes protected descriptors only for the in-memory pipe boundary', () => {
        const assembled = assembleOwnerDescriptors(input(createFixturePacket()));
        const packetRaw = serializeProtectedDescriptor(assembled.packet);
        const bootstrapRaw = serializeProtectedDescriptor(assembled.bootstrap);
        expect(JSON.parse(packetRaw)).not.toHaveProperty('packetDigest');
        expect(JSON.parse(bootstrapRaw).packetDigest).toBe(assembled.packetDigest);
        expect(packetRaw).toContain('example-project');
        expect(bootstrapRaw).toContain('fixture-vercel-token');
    });
});
