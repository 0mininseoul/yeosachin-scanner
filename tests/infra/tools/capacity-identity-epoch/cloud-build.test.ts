import { describe, expect, it } from 'vitest';
import { createFixturePacket } from '../../../../scripts/capacity-identity-epoch/fixtures';
import { CloudBuildAdapter, observedBuildMetadataDigest } from '../../../../scripts/capacity-identity-epoch/cloud-build';
import { AuthenticatedProtectedTransport, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from '../../../../scripts/capacity-identity-epoch/platform';
import { canonicalDigest } from '../../../../scripts/capacity-identity-epoch/contracts';
import { storageSourceContext, type StorageSourceVerifier } from '../../../../scripts/capacity-identity-epoch/storage-source';

const IMAGE = (role: 'preflight' | 'paid', digest: string) => `asia-northeast3-docker.pkg.dev/example-project/workers/${role}@sha256:${digest}`;

class BuildTransport implements ProtectedTransport {
    readonly requests: ProtectedHttpRequest[] = [];
    readonly pages: readonly Record<string, unknown>[];
    constructor(pages: readonly Record<string, unknown>[]) { this.pages = pages; }
    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> {
        this.requests.push(request);
        const pageToken = new URL(request.url).searchParams.get('pageToken');
        const index = pageToken === 'page-2' ? 1 : 0;
        return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(this.pages[index] ?? { builds: [] }), url: request.url };
    }
}

function buildFor(packet: ReturnType<typeof createFixturePacket>, phase: 'old' | 'desired'): Record<string, unknown> {
    const input = packet.protectedInputs[phase].build;
    return {
        id: `fixture-${phase}`, status: 'SUCCESS',
        serviceAccount: `projects/${input.identity.project}/serviceAccounts/${input.identity.identity}`,
        sourceProvenance: { resolvedRepoSource: { repoName: input.sourceContext, commitSha: input.sourceSha } },
        substitutions: { _NODE_ENV: 'production' },
        results: { images: [{ name: IMAGE('preflight', phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)).split('@')[0], digest: `sha256:${phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)}` }, { name: IMAGE('paid', phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)).split('@')[0], digest: `sha256:${phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)}` }] },
    };
}

function storagePacket(packet: ReturnType<typeof createFixturePacket>, phase: 'old' | 'desired') {
    const source = { bucket: 'fixture-bucket', object: 'source.zip', generation: 42 };
    return {
        ...packet,
        protectedInputs: {
            ...packet.protectedInputs,
            [phase]: {
                ...packet.protectedInputs[phase],
                build: { ...packet.protectedInputs[phase].build, sourceContext: storageSourceContext(source) },
            },
        },
    } as typeof packet;
}

function storageBuildFor(packet: ReturnType<typeof createFixturePacket>, phase: 'old' | 'desired'): Record<string, unknown> {
    const source = { bucket: 'fixture-bucket', object: 'source.zip', generation: 42 };
    return { ...buildFor(storagePacket(packet, phase), phase), sourceProvenance: { resolvedStorageSource: source } };
}

function adapter(transport: BuildTransport, packet = createFixturePacket(), storageSourceVerifier?: StorageSourceVerifier): CloudBuildAdapter {
    const authenticated = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000 });
    return new CloudBuildAdapter({
        transport: authenticated,
        builds: { old: packet.protectedInputs.old.build, desired: packet.protectedInputs.desired.build },
        runtimes: { old: packet.protectedInputs.old.runtime, desired: packet.protectedInputs.desired.runtime },
        storageSourceVerifier,
    });
}

describe('Cloud Build provenance adapter contracts', () => {
    it('binds each old role to its own source, build inputs and immutable image', async () => {
        const packet = createFixturePacket();
        const paidSha = 'd'.repeat(40);
        const paidImage = IMAGE('paid', 'e'.repeat(64));
        const paidInput = { ...packet.protectedInputs.old.build, sourceSha: paidSha,
            sourceContext: 'independent-old-paid-source', buildArguments: { NODE_ENV: 'old-paid-build' } };
        const paidBuild = { ...buildFor(packet, 'old'),
            sourceProvenance: { resolvedRepoSource: { repoName: paidInput.sourceContext, commitSha: paidSha } },
            substitutions: { _NODE_ENV: 'old-paid-build' },
            results: { images: [{ name: paidImage.split('@')[0], digest: `sha256:${'e'.repeat(64)}` }] } };
        const old = packet.protectedObservations.old;
        const oldObservations = { ...old,
            source: { ...old.source, paid: { ...old.source.paid, sourceSha: paidSha,
                metadataDigest: observedBuildMetadataDigest(paidBuild, paidInput) } },
            runtime: { ...old.runtime, paid: { ...old.runtime.paid, sourceSha: paidSha,
                buildDigest: canonicalDigest({ image: paidImage }) } },
        };
        const paidRuntime = { ...packet.protectedInputs.old.runtime.paid, sourceSha: paidSha };
        const makeAdapter = (build: Record<string, unknown>) => new CloudBuildAdapter({
            transport: new AuthenticatedProtectedTransport({
                transport: new BuildTransport([{ builds: [buildFor(packet, 'old'), build] }]),
                tokenProvider: async () => 'fixture-token',
            }),
            builds: { old: packet.protectedInputs.old.build, desired: packet.protectedInputs.desired.build },
            runtimes: { old: { ...packet.protectedInputs.old.runtime, paid: paidRuntime }, desired: packet.protectedInputs.desired.runtime },
            oldObservations,
        });
        const request = { role: 'paid' as const, phase: 'old' as const,
            revision: oldObservations.source.paid.revision, runtime: paidRuntime };
        await expect(makeAdapter(paidBuild).sourceObservation(request)).resolves.toMatchObject({
            sourceSha: paidSha, metadataDigest: oldObservations.source.paid.metadataDigest });
        await expect(makeAdapter(paidBuild).buildObservation({ ...request, image: paidImage }))
            .resolves.toBe(canonicalDigest({ image: paidImage }));
        await expect(makeAdapter({ ...paidBuild, substitutions: { _NODE_ENV: 'tampered' } }).sourceObservation(request))
            .rejects.toThrow('EVIDENCE_UNAVAILABLE');
        await expect(makeAdapter({ ...paidBuild, results: { images: [{ name: 'other-image', digest: `sha256:${'e'.repeat(64)}` }] } }).sourceObservation(request))
            .rejects.toThrow('EVIDENCE_UNAVAILABLE');
    });

    it('keeps bare account compatibility without accepting a foreign project resource', async () => {
        const packet = createFixturePacket();
        const old = buildFor(packet, 'old');
        const request = { role: 'preflight' as const, phase: 'old' as const, revision: packet.oldManifest.source.preflight.oldRevision, runtime: packet.protectedInputs.old.runtime.preflight };
        const email = packet.protectedInputs.old.build.identity.identity;
        const bare = new BuildTransport([{ builds: [{ ...old, serviceAccount: email }] }]);
        await expect(adapter(bare).sourceObservation(request)).resolves.toMatchObject({ sourceSha: packet.protectedInputs.old.build.sourceSha });
        const foreign = new BuildTransport([{ builds: [{ ...old, serviceAccount: `projects/other-project/serviceAccounts/${email}` }] }]);
        await expect(adapter(foreign).sourceObservation(request)).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
    });

    it('never treats a storage generation as a Git SHA and fails closed without a verifier', async () => {
        const packet = storagePacket(createFixturePacket(), 'old');
        const old = storageBuildFor(packet, 'old');
        const transport = new BuildTransport([{ builds: [old] }]);
        const request = {
            role: 'preflight' as const,
            phase: 'old' as const,
            revision: packet.oldManifest.source.preflight.oldRevision,
            runtime: packet.protectedInputs.old.runtime.preflight,
        };
        await expect(adapter(transport, packet).sourceObservation(request)).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
    });

    it('accepts a storage source only after an injected full-content proof', async () => {
        const packet = storagePacket(createFixturePacket(), 'old');
        const old = storageBuildFor(packet, 'old');
        const seen: { reviewedSha?: string; generation?: string } = {};
        const verifier: StorageSourceVerifier = async ({ source, reviewedSha }) => {
            seen.reviewedSha = reviewedSha;
            seen.generation = String(source.generation);
            return {
                reviewedSha,
                archiveSha256: 'a'.repeat(64),
                sourceContext: storageSourceContext(source),
                sourceBucket: source.bucket,
                sourceObject: source.object,
                sourceGeneration: String(source.generation),
            };
        };
        const transport = new BuildTransport([{ builds: [old] }]);
        const request = {
            role: 'preflight' as const,
            phase: 'old' as const,
            revision: packet.oldManifest.source.preflight.oldRevision,
            runtime: packet.protectedInputs.old.runtime.preflight,
        };
        await expect(adapter(transport, packet, verifier).sourceObservation(request))
            .resolves.toMatchObject({ sourceSha: packet.protectedInputs.old.build.sourceSha });
        expect(seen.reviewedSha).toBe(packet.protectedInputs.old.build.sourceSha);
        expect(seen.generation).toBe('42');
    });

    it('uses the regional list endpoint and follows an empty page with a continuation token', async () => {
        const packet = createFixturePacket();
        const old = buildFor(packet, 'old');
        const transport = new BuildTransport([{ builds: [], nextPageToken: 'page-2' }, { builds: [old] }]);
        const result = await adapter(transport).sourceObservation({ role: 'preflight', phase: 'old', revision: packet.oldManifest.source.preflight.oldRevision, runtime: packet.protectedInputs.old.runtime.preflight });
        expect(result.sourceSha).toBe(packet.protectedInputs.old.build.sourceSha);
        expect(transport.requests).toHaveLength(2);
        expect(new URL(transport.requests[0]!.url).pathname).toBe('/v1/projects/example-project/locations/asia-northeast3/builds');
        expect(new URL(transport.requests[1]!.url).searchParams.get('pageToken')).toBe('page-2');
        expect(new URL(transport.requests[0]!.url).searchParams.get('filter')).toBe('status="SUCCESS"');
    });

    it('rejects ambiguous matching builds instead of adopting an arbitrary result', async () => {
        const packet = createFixturePacket();
        const old = buildFor(packet, 'old');
        const transport = new BuildTransport([{ builds: [old, { ...old, id: 'duplicate' }] }]);
        await expect(adapter(transport).sourceObservation({ role: 'preflight', phase: 'old', revision: packet.oldManifest.source.preflight.oldRevision, runtime: packet.protectedInputs.old.runtime.preflight })).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
    });

    it('requires the exact image digest and build arguments before returning a build observation', async () => {
        const packet = createFixturePacket();
        const desired = buildFor(packet, 'desired');
        const transport = new BuildTransport([{ builds: [desired] }]);
        const expectedImage = IMAGE('paid', 'b'.repeat(64));
        const digest = await adapter(transport).buildObservation({ role: 'paid', phase: 'desired', revision: 'paid-epochfixture', image: expectedImage });
        expect(digest).toBe(canonicalDigest(packet.protectedInputs.desired.build));
        const wrong = new BuildTransport([{ builds: [desired] }]);
        await expect(adapter(wrong).buildObservation({ role: 'paid', phase: 'desired', revision: 'paid-epochfixture', image: IMAGE('paid', 'c'.repeat(64)) })).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
    });

    it('looks up an old build in the old observation runtime location', async () => {
        const packet = createFixturePacket();
        const packetForTest = {
            ...packet,
            protectedInputs: {
                ...packet.protectedInputs,
                old: {
                    ...packet.protectedInputs.old,
                    runtime: {
                        ...packet.protectedInputs.old.runtime,
                        preflight: { ...packet.protectedInputs.old.runtime.preflight, location: 'us-central1' },
                    },
                },
            },
        } as typeof packet;
        const old = buildFor(packetForTest, 'old');
        const transport = new BuildTransport([{ builds: [old] }]);
        await adapter(transport, packetForTest).sourceObservation({
            role: 'preflight', phase: 'old', revision: packetForTest.oldManifest.source.preflight.oldRevision,
            runtime: packetForTest.protectedInputs.old.runtime.preflight,
        });
        expect(new URL(transport.requests[0]!.url).pathname).toBe('/v1/projects/example-project/locations/us-central1/builds');
    });
});
