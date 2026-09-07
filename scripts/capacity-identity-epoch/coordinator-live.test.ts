import { describe, expect, it } from 'vitest';
import { createFixturePacket } from './fixtures';
import { LiveEpochControlPlane } from './coordinator';
import { VercelAdapter } from './vercel';
import { AuthenticatedProtectedTransport, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from './platform';
import { PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION, PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION } from '../../lib/services/analysis/legacy-analysis-public-readiness';
import type { EpochLock } from './contracts';

class FakeTransport implements ProtectedTransport {
    constructor(private readonly responder: (request: ProtectedHttpRequest) => ProtectedHttpResponse) {}
    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> { return this.responder(request); }
}

function json(request: ProtectedHttpRequest, value: unknown): ProtectedHttpResponse {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), url: request.url };
}

function readiness(packet: ReturnType<typeof createFixturePacket>) {
    const expected = packet.desiredManifest.readiness;
    return {
        schemaVersion: 'analysis-public-freeze-readiness-v3', ready: true,
        stage: 'initial', freezeMode: 'drain-and-block', publicFreezeEnabled: true,
        sourceSha: expected.sourceSha, legacyTargetResource: expected.legacyTargetResource,
        preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        preflightProducerConfigFingerprint: expected.preflightFingerprint, preflightProducerConfigReady: true,
        paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
        paidProducerConfigFingerprint: expected.paidFingerprint, paidProducerConfigReady: true,
        routes: {
            '/api/analysis/start': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
            '/api/analysis/step': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
            '/api/analysis/run': { gateState: 'frozen', expectedStatus: 410, gateBeforeRuntime: true },
        },
        analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false,
    };
}

describe('live coordinator producer wire ordering', () => {
    it('proves OLD public, DESIRED immutable, then PUBLIC desired around alias assignment', async () => {
        const packet = createFixturePacket();
        const events: string[] = [];
        let aliasDeployment = 'dpl-old';
        const sourceSha = packet.desiredManifest.readiness.sourceSha;
        const fake = new FakeTransport(request => {
            const url = new URL(request.url);
            if (url.pathname.startsWith('/v13/deployments/')) {
                events.push('deployment');
                return json(request, {
                    id: 'dpl-desired', url: 'desired-fixture.vercel.app', readyState: 'READY',
                    project: { id: 'project-fixture' }, team: { id: 'team-fixture' },
                    gitSource: { sha: sourceSha }, target: 'production', alias: [],
                });
            }
            if (url.pathname === '/v4/aliases/desired.example.invalid') {
                events.push('alias-read');
                return json(request, { alias: 'desired.example.invalid', projectId: 'project-fixture', deploymentId: aliasDeployment });
            }
            if (url.pathname === '/v2/deployments/dpl-desired/aliases' && request.method === 'POST') {
                events.push('alias-post');
                aliasDeployment = 'dpl-desired';
                return json(request, { alias: 'desired.example.invalid', projectId: 'project-fixture', deploymentId: aliasDeployment });
            }
            if (url.pathname === '/v2/deployments/dpl-desired/aliases') {
                events.push('aliases');
                return json(request, { aliases: [{ alias: 'desired.example.invalid' }] });
            }
            throw new Error('unexpected protected request');
        });
        const adapter = new VercelAdapter({
            transport: new AuthenticatedProtectedTransport({ transport: fake, tokenProvider: async () => 'fixture-token' }),
            publicReadinessOrigin: 'https://public.example.invalid',
            readinessFetcher: async (url: string) => {
                events.push(url.startsWith('https://public.example.invalid') ? 'public-old-or-post' : 'immutable-desired');
                return { status: 200, headers: {}, body: JSON.stringify(readiness(packet)), url };
            },
        });
        const control = new LiveEpochControlPlane({
            cloudRun: {} as never,
            iam: {} as never,
            workPlanes: {} as never,
            vercel: adapter,
            publicReadinessUrl: 'https://public.example.invalid/api/analysis/capacity/readiness',
            projectId: 'project-fixture', teamId: 'team-fixture', deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old',
            producerAlias: 'desired.example.invalid', serviceBodies: { preflight: {}, paid: {} },
        });
        const lock: EpochLock = { epochHeaderDigest: 'a'.repeat(64), ownerDigest: 'b'.repeat(64), lockFence: '1', lockExpiresAt: '2099-01-01T00:00:00.000Z' };
        const result = await control.closeAndAlignProducers({ packet, lease: { generation: '1', lock } });
        expect(result.proof).toMatchObject({ action: 'PRODUCERS_CLOSED_ALIGNED' });
        expect(events.slice(0, 4)).toEqual(['public-old-or-post', 'deployment', 'immutable-desired', 'deployment']);
        expect(events.indexOf('alias-post')).toBeGreaterThan(events.indexOf('immutable-desired'));
        expect(events.at(-1)).toBe('public-old-or-post');
    });
});
