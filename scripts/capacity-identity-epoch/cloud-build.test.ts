import { describe, expect, it } from 'vitest';
import { createFixturePacket } from './fixtures';
import { CloudBuildAdapter } from './cloud-build';
import { AuthenticatedProtectedTransport, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from './platform';
import { canonicalDigest } from './contracts';

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
        id: `fixture-${phase}`, status: 'SUCCESS', serviceAccount: input.identity.identity,
        sourceProvenance: { resolvedRepoSource: { repoName: input.sourceContext, commitSha: input.sourceSha } },
        substitutions: { _NODE_ENV: 'production' },
        results: { images: [{ name: IMAGE('preflight', phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)).split('@')[0], digest: `sha256:${phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)}` }, { name: IMAGE('paid', phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)).split('@')[0], digest: `sha256:${phase === 'old' ? 'a'.repeat(64) : 'b'.repeat(64)}` }] },
    };
}

function adapter(transport: BuildTransport, packet = createFixturePacket()): CloudBuildAdapter {
    const authenticated = new AuthenticatedProtectedTransport({ transport, tokenProvider: async () => 'fixture-token', timeoutMs: 1_000 });
    return new CloudBuildAdapter({ transport: authenticated, builds: { old: packet.protectedInputs.old.build, desired: packet.protectedInputs.desired.build }, runtimes: { old: packet.protectedInputs.old.runtime, desired: packet.protectedInputs.desired.runtime } });
}

describe('Cloud Build provenance adapter contracts', () => {
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
