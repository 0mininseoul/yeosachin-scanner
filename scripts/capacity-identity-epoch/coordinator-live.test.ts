import { describe, expect, it } from 'vitest';
import { createFixturePacket } from './fixtures';
import { LiveEpochControlPlane } from './coordinator';
import { VercelAdapter } from './vercel';
import { AuthenticatedProtectedTransport, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from './platform';
import { PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION, PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION } from '../../lib/services/analysis/legacy-analysis-public-readiness';
import { canonicalDigest, canonicalQueueConfiguration, canonicalRuntimeInputDigest, type EpochLock, type Role } from './contracts';

class FakeTransport implements ProtectedTransport {
    constructor(private readonly responder: (request: ProtectedHttpRequest) => ProtectedHttpResponse) {}
    async request(request: ProtectedHttpRequest): Promise<ProtectedHttpResponse> { return this.responder(request); }
}

function json(request: ProtectedHttpRequest, value: unknown): ProtectedHttpResponse {
    return { status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value), url: request.url };
}

function readiness(packet: ReturnType<typeof createFixturePacket>, phase: 'old' | 'desired') {
    const expected = phase === 'old' ? packet.oldManifest.readiness : packet.desiredManifest.readiness;
    const producerVersion = (role: 'preflight' | 'paid') => role === 'preflight'
        ? PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION
        : PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION;
    return {
        schemaVersion: 'analysis-public-freeze-readiness-v3', ready: true,
        stage: 'initial', freezeMode: 'drain-and-block', publicFreezeEnabled: true,
        sourceSha: expected.sourceSha, legacyTargetResource: expected.legacyTargetResource,
        preflightProducerConfigFingerprintVersion: producerVersion('preflight'),
        preflightProducerConfigFingerprint: expected.preflightFingerprint, preflightProducerConfigReady: true,
        paidProducerConfigFingerprintVersion: producerVersion('paid'),
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
        expect(packet.oldManifest.readiness.sourceSha).not.toBe(packet.desiredManifest.readiness.sourceSha);
        expect(packet.oldManifest.readiness.preflightFingerprint).not.toBe(packet.desiredManifest.readiness.preflightFingerprint);
        expect(packet.oldManifest.readiness.paidFingerprint).not.toBe(packet.desiredManifest.readiness.paidFingerprint);
        const events: string[] = [];
        let publicReadinessReads = 0;
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
                if (url.startsWith('https://public.example.invalid')) {
                    publicReadinessReads += 1;
                    events.push('public-old-or-post');
                } else {
                    events.push('immutable-desired');
                }
                return { status: 200, headers: {}, body: JSON.stringify(readiness(packet, url.startsWith('https://public.example.invalid') && publicReadinessReads === 1 ? 'old' : 'desired')), url };
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
        expect(publicReadinessReads).toBe(2);
    });

    it('prepares from complete coherent old observations and rejects one changed live field', async () => {
        const packet = createFixturePacket();
        const now = 100_000;
        const lock: EpochLock = { epochHeaderDigest: 'a'.repeat(64), ownerDigest: 'b'.repeat(64), lockFence: '1', lockExpiresAt: '2099-01-01T00:00:00.000Z' };
        let driftQueue = false;
        const readinessValue = (phase: 'old' | 'desired') => {
            const expected = phase === 'old' ? packet.oldManifest.readiness : packet.desiredManifest.readiness;
            return {
                schemaVersion: expected.schemaVersion, ready: true,
                stage: 'initial', freezeMode: 'drain-and-block', publicFreezeEnabled: true,
                sourceSha: expected.sourceSha, legacyTargetResource: expected.legacyTargetResource,
                preflightProducerConfigFingerprintVersion: PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                preflightProducerConfigFingerprint: expected.preflightFingerprint, preflightProducerConfigReady: true,
                paidProducerConfigFingerprintVersion: PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION,
                paidProducerConfigFingerprint: expected.paidFingerprint, paidProducerConfigReady: true,
                routes: {},
                analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false,
            };
        };
        const service = (role: Role) => {
            const expected = packet.protectedInputs.old.runtime[role];
            const old = packet.protectedObservations.old.runtime[role];
            const image = `fixture-${role}-image`;
            return {
                resource: `projects/${expected.project}/locations/${expected.location}/services/${expected.service}`,
                project: expected.project, location: expected.location, service: expected.service,
                url: expected.target.url.replace(new URL(expected.target.url).pathname, '/'),
                generation: old.generation, resourceVersion: old.resourceVersion, observedGeneration: old.generation,
                ready: true, latestCreatedRevision: old.revision, latestReadyRevision: old.revision, traffic: [],
                identity: expected.identity, environment: expected.environment, secretReferences: expected.secretReferences,
                settings: expected.settings, image, runtimeDigest: canonicalRuntimeInputDigest(expected),
                buildDigest: canonicalDigest({ image }), sourceSha: '', noTraffic: true,
                rawDigest: canonicalDigest({ role, image }), raw: {},
            };
        };
        const fakeWorkPlanes = {
            observeQueue: async (input: any) => ({
                resource: input.resource, project: input.project, location: input.location, state: 'PAUSED',
                target: { url: input.target.url, audience: input.target.audience, callerIdentity: input.target.callerIdentity, uriOverride: null, wireConfigurationDigest: canonicalDigest('wire') },
                httpTargetPresent: true,
                configuration: { rateLimits: driftQueue ? { ...input.configuration, maxConcurrentDispatches: 99 } : input.configuration },
                configurationDigest: canonicalDigest({ rateLimits: driftQueue ? { ...input.configuration, maxConcurrentDispatches: 99 } : input.configuration }), tasks: [], complete: true,
            }),
            observeScheduler: async (input: any) => ({ resource: input.resource, project: input.project, location: input.location, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null, target: input.target, configuration: input.configuration, configurationDigest: canonicalDigest(input.configuration) }),
            observeRetention: async (input: any) => ({ role: 'retention', ...input, configurationDigest: canonicalDigest(input.configuration) }),
        };
        const fakeIam = { getPolicy: async (input: any) => ({ resource: input.resource, project: input.project, etag: input.etag, bindings: input.bindings }) };
        const control = new LiveEpochControlPlane({
            cloudRun: { getService: async (resource: string) => service(resource.includes('/paid-worker') ? 'paid' : 'preflight') } as never,
            iam: fakeIam as never,
            workPlanes: fakeWorkPlanes as never,
            vercel: { readPublicReadiness: async ({ expected }: any) => readinessValue(expected.sourceSha === packet.oldManifest.readiness.sourceSha ? 'old' : 'desired') } as never,
            publicReadinessUrl: 'https://fixture.example.invalid/api/analysis/capacity/readiness',
            projectId: 'fixture-project', teamId: 'fixture-team', deploymentId: 'fixture-deployment', expectedOldDeploymentId: 'fixture-old',
            producerAlias: 'fixture.example.invalid', serviceBodies: { preflight: {}, paid: {} }, now: () => now,
            sourceObservation: async ({ role, runtime, revision }) => ({ role, sourceSha: runtime.sourceSha, revision, metadataDigest: packet.protectedObservations.old.source[role].metadataDigest }),
            buildObservation: async ({ image }) => canonicalDigest({ image }),
        });
        const prepared = await control.prepare({ packet, lease: { generation: '1', lock } });
        expect(prepared.proof).toMatchObject({ action: 'PREPARED' });
        expect((prepared.postcondition as any).observedDigests.source).toMatch(/^[0-9a-f]{64}$/);
        driftQueue = true;
        await expect(control.prepare({ packet, lease: { generation: '1', lock } })).rejects.toThrow('OBSERVATION_INVALID');
    });

    it('reconciles QUEUES_ALIGNED against old paused auth contracts before rotation', async () => {
        const packet = createFixturePacket();
        const lock: EpochLock = { epochHeaderDigest: 'a'.repeat(64), ownerDigest: 'b'.repeat(64), lockFence: '1', lockExpiresAt: '2099-01-01T00:00:00.000Z' };
        const workPlanes = {
            observeQueue: async (input: any) => {
                expect(canonicalDigest(input.target)).toBe(canonicalDigest(packet.protectedInputs.old.queues[input.resource.endsWith('/preflight') ? 'preflight' : 'paid'].target));
                return {
                    resource: input.resource, project: input.project, location: input.location, state: 'PAUSED',
                    target: { url: input.target.url, audience: input.target.audience, callerIdentity: input.target.callerIdentity, uriOverride: null, wireConfigurationDigest: canonicalDigest('wire') },
                    httpTargetPresent: true, configuration: input.configuration, configurationDigest: canonicalDigest(canonicalQueueConfiguration(input.configuration)), tasks: [], complete: true,
                };
            },
            observeScheduler: async (input: any) => {
                expect(canonicalDigest(input.target)).toBe(canonicalDigest(packet.protectedInputs.old.schedulers[input.resource.endsWith('/preflight-recovery') ? 'preflight' : 'paid'].target));
                return { resource: input.resource, project: input.project, location: input.location, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null, target: input.target, configuration: input.configuration, configurationDigest: canonicalDigest(input.configuration) };
            },
        };
        const control = new LiveEpochControlPlane({
            cloudRun: {} as never, iam: {} as never, workPlanes: workPlanes as never, vercel: {} as never,
            publicReadinessUrl: 'https://fixture.example.invalid/api/analysis/capacity/readiness', projectId: 'vercel-project', teamId: 'fixture-team',
            deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', producerAlias: 'desired.example.invalid',
            serviceBodies: { preflight: {}, paid: {} }, now: () => 100_000,
        });
        const result = await control.reconcile({ packet, lease: { generation: '1', lock }, state: 'QUEUES_ALIGNED' });
        expect(result.proof).toMatchObject({ action: 'RECONCILE_QUEUES_ALIGNED' });
    });
});
