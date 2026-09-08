import { describe, expect, it } from 'vitest';
import { createFixturePacket } from './fixtures';
import { LiveEpochControlPlane } from './coordinator';
import { EpochJournal, transitionCommitment, type JournalStorage } from './journal';
import { issueCoordinatorCapability } from './packet';
import { VercelAdapter } from './vercel';
import { AuthenticatedProtectedTransport, type ProtectedHttpRequest, type ProtectedHttpResponse, type ProtectedTransport } from './platform';
import { PAID_PRODUCER_CONFIG_FINGERPRINT_VERSION, PREFLIGHT_PRODUCER_CONFIG_FINGERPRINT_VERSION } from '../../lib/services/analysis/legacy-analysis-public-readiness';
import { canonicalDigest, canonicalQueueConfiguration, canonicalRuntimeInputDigest, EpochError, type EpochLock, type EpochTransition, type ProtectedIamInput, type ProtectedQueueInput, type ProtectedRetentionInput, type ProtectedSchedulerInput, type Role } from './contracts';
import type { PublicReadinessExpected } from '../../lib/services/analysis/public-readiness-contract';

class MemoryStorage implements JournalStorage {
    private readonly values = new Map<string, { generation: string; value: unknown }>();
    private nextGeneration = 1;

    async get(key: string) { return this.values.get(key) ?? null; }
    async put(key: string, value: unknown, options: { ifGenerationMatch: '0' | string }) {
        const existing = this.values.get(key);
        if (options.ifGenerationMatch === '0' ? existing !== undefined : existing?.generation !== options.ifGenerationMatch) {
            throw new EpochError('GENERATION_PRECONDITION_FAILED');
        }
        const stored = { generation: String(this.nextGeneration++), value };
        this.values.set(key, stored);
        return stored;
    }
    async list(prefix: string) {
        return [...this.values.entries()]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, value]) => ({ key, ...value }));
    }

    async delete(key: string, options: { ifGenerationMatch: string }) {
        const current = this.values.get(key);
        if (!current || current.generation !== options.ifGenerationMatch) throw new EpochError('GENERATION_PRECONDITION_FAILED');
        this.values.delete(key);
    }

    seed(key: string, generation: string, value: unknown): void {
        this.values.set(key, { generation, value });
    }
}

function liveAuthority(
    packet: ReturnType<typeof createFixturePacket>,
    ownerDigest = 'b'.repeat(64),
    lockFence = '1',
    assertLive?: (lease: { lock: EpochLock }) => Promise<void>,
) {
    const header = {
        epochIdDigest: canonicalDigest(packet.epochId),
        capabilityDigest: packet.capabilityDigest,
        oldManifestDigest: packet.oldManifestDigest,
        desiredManifestDigest: packet.desiredManifestDigest,
        roleSetDigest: packet.roleSetDigest,
        sourcePlanDigest: packet.sourcePlanDigest,
        createdAt: '2026-09-08T00:00:00.000Z',
    } as const;
    const storage = new MemoryStorage();
    const journal = new EpochJournal(storage, { header, now: () => 100_000 });
    const lease = {
        generation: '1',
        lock: {
            epochHeaderDigest: journal.epochHeaderDigest,
            ownerDigest,
            lockFence,
            lockExpiresAt: '2099-01-01T00:00:00.000Z',
        },
    };
    storage.seed(journal.headerKey, '1', header);
    storage.seed(journal.lockKey, '1', lease.lock);
    if (assertLive) {
        journal.assertLive = assertLive as typeof journal.assertLive;
        journal.readValidatedState = (async (currentLease?: { generation: string; lock: EpochLock }) => {
            await journal.assertLive(currentLease!);
            return {
                state: null,
                transitions: [],
                aborted: false,
                activeFence: currentLease!.lock.lockFence,
                resumed: false,
                requiresReconciliation: false,
                lock: {
                    generation: currentLease!.generation,
                    ownerDigest: currentLease!.lock.ownerDigest,
                    lockFence: currentLease!.lock.lockFence,
                    lockExpiresAt: currentLease!.lock.lockExpiresAt,
                },
            };
        }) as typeof journal.readValidatedState;
    }
    return { journal, storage, capability: issueCoordinatorCapability(packet, ownerDigest), ownerDigest, lease };
}

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

function preparedTransition(journal: EpochJournal, lockFence: string): EpochTransition {
    const value = canonicalDigest('live-resume-prepared');
    return {
        sequence: 1, epochIdDigest: journal.epochIdDigest, fromState: null, toState: 'PREPARED', stateVersion: 1,
        lockFence, preconditionDigest: value, mutationDigest: value, postconditionDigest: value,
        proofDigest: value, nativeConcurrencyTokenDigest: value, resourceObservationDigest: value,
        resultCode: 'OK', recordedAt: '2026-09-08T00:00:01.000Z',
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
        const authority = liveAuthority(packet);
        const control = new LiveEpochControlPlane({
            cloudRun: {} as never,
            iam: {} as never,
            workPlanes: {} as never,
            vercel: adapter,
            publicReadinessUrl: 'https://public.example.invalid/api/analysis/capacity/readiness',
            projectId: 'project-fixture', teamId: 'team-fixture', deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old',
            producerAlias: 'desired.example.invalid', serviceBodies: { preflight: {}, paid: {} }, ...authority,
        });
        const result = await control.closeAndAlignProducers({ packet, lease: authority.lease });
        expect(result.proof).toMatchObject({ action: 'PRODUCERS_CLOSED_ALIGNED' });
        expect(events.slice(0, 4)).toEqual(['public-old-or-post', 'deployment', 'immutable-desired', 'deployment']);
        expect(events.indexOf('alias-post')).toBeGreaterThan(events.indexOf('immutable-desired'));
        expect(events.at(-1)).toBe('public-old-or-post');
        expect(publicReadinessReads).toBe(2);
    });

    it('prepares from complete coherent old observations and rejects one changed live field', async () => {
        const packet = createFixturePacket();
        const now = 100_000;
        const authority = liveAuthority(packet);
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
            observeQueue: async (input: ProtectedQueueInput) => ({
                resource: input.resource, project: input.project, location: input.location, state: 'PAUSED',
                target: { url: input.target.url, audience: input.target.audience, callerIdentity: input.target.callerIdentity, uriOverride: null, wireConfigurationDigest: canonicalDigest('wire') },
                httpTargetPresent: true,
                configuration: { ...input.configuration, maxConcurrentDispatches: driftQueue ? 99 : input.configuration.maxConcurrentDispatches },
                configurationDigest: canonicalDigest(canonicalQueueConfiguration({ ...input.configuration, maxConcurrentDispatches: driftQueue ? 99 : input.configuration.maxConcurrentDispatches })), tasks: [], complete: true,
            }),
            observeScheduler: async (input: ProtectedSchedulerInput) => ({ resource: input.resource, project: input.project, location: input.location, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null, target: input.target, configuration: input.configuration, configurationDigest: canonicalDigest(input.configuration) }),
            observeRetention: async (input: ProtectedRetentionInput) => ({ role: 'retention', ...input, configurationDigest: canonicalDigest(input.configuration) }),
        };
        const fakeIam = { getPolicy: async (input: ProtectedIamInput) => ({ resource: input.resource, project: input.project, etag: input.etag, bindings: input.bindings }) };
        const control = new LiveEpochControlPlane({
            cloudRun: { getService: async (resource: string) => service(resource.includes('/paid-worker') ? 'paid' : 'preflight') } as never,
            iam: fakeIam as never,
            workPlanes: fakeWorkPlanes as never,
            vercel: { readPublicReadiness: async ({ expected }: { expected: PublicReadinessExpected }) => readinessValue(expected.sourceSha === packet.oldManifest.readiness.sourceSha ? 'old' : 'desired') } as never,
            publicReadinessUrl: 'https://fixture.example.invalid/api/analysis/capacity/readiness',
            projectId: 'fixture-project', teamId: 'fixture-team', deploymentId: 'fixture-deployment', expectedOldDeploymentId: 'fixture-old',
            producerAlias: 'fixture.example.invalid', serviceBodies: { preflight: {}, paid: {} }, now: () => now,
            journal: authority.journal, capability: authority.capability, ownerDigest: authority.ownerDigest,
            sourceObservation: async ({ role, runtime, revision }) => ({ role, sourceSha: runtime.sourceSha, revision, metadataDigest: packet.protectedObservations.old.source[role].metadataDigest }),
            buildObservation: async ({ role }) => packet.protectedObservations.old.runtime[role].buildDigest,
        });
        const prepared = await control.prepare({ packet, lease: authority.lease });
        expect(prepared.proof).toMatchObject({ action: 'PREPARED' });
        expect((prepared.postcondition as { observedDigests: { source: string } }).observedDigests.source).toMatch(/^[0-9a-f]{64}$/);
        driftQueue = true;
        await expect(control.prepare({ packet, lease: authority.lease })).rejects.toThrow('OBSERVATION_INVALID');
    });

    it('reconciles QUEUES_ALIGNED against old paused auth contracts before rotation', async () => {
        const packet = createFixturePacket();
        const authority = liveAuthority(packet);
        const workPlanes = {
            observeQueue: async (input: ProtectedQueueInput) => {
                expect(canonicalDigest(input.target)).toBe(canonicalDigest(packet.protectedInputs.old.queues[input.resource.endsWith('/preflight') ? 'preflight' : 'paid'].target));
                return {
                    resource: input.resource, project: input.project, location: input.location, state: 'PAUSED',
                    target: { url: input.target.url, audience: input.target.audience, callerIdentity: input.target.callerIdentity, uriOverride: null, wireConfigurationDigest: canonicalDigest('wire') },
                    httpTargetPresent: true, configuration: input.configuration, configurationDigest: canonicalDigest(canonicalQueueConfiguration(input.configuration)), tasks: [], complete: true,
                };
            },
            observeScheduler: async (input: ProtectedSchedulerInput) => {
                expect(canonicalDigest(input.target)).toBe(canonicalDigest(packet.protectedInputs.old.schedulers[input.resource.endsWith('/preflight-recovery') ? 'preflight' : 'paid'].target));
                return { resource: input.resource, project: input.project, location: input.location, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null, target: input.target, configuration: input.configuration, configurationDigest: canonicalDigest(input.configuration) };
            },
        };
        const control = new LiveEpochControlPlane({
            cloudRun: {} as never, iam: {} as never, workPlanes: workPlanes as never, vercel: {} as never,
            publicReadinessUrl: 'https://fixture.example.invalid/api/analysis/capacity/readiness', projectId: 'vercel-project', teamId: 'fixture-team',
            deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', producerAlias: 'desired.example.invalid',
            serviceBodies: { preflight: {}, paid: {} }, now: () => 100_000,
            journal: authority.journal, capability: authority.capability, ownerDigest: authority.ownerDigest,
        });
        const result = await control.reconcile({ packet, lease: authority.lease, state: 'QUEUES_ALIGNED' });
        expect(result.proof).toMatchObject({ action: 'RECONCILE_QUEUES_ALIGNED' });
    });

    it('reconciles a single desired OIDC target left by a crash before INVOKERS_ROTATED append', async () => {
        const packet = createFixturePacket();
        const authority = liveAuthority(packet, 'b'.repeat(64), '2');
        const workPlanes = {
            observeQueue: async (input: ProtectedQueueInput) => {
                const role: Role = input.resource.endsWith('/preflight') ? 'preflight' : 'paid';
                const old = packet.protectedInputs.old.queues[role].target;
                const desired = packet.protectedInputs.desired.queues[role].target;
                const target = role === 'preflight'
                    ? { url: null, audience: desired.audience, callerIdentity: desired.callerIdentity, uriOverride: null, wireConfigurationDigest: canonicalDigest('wire') }
                    : { url: null, audience: old.audience, callerIdentity: old.callerIdentity, uriOverride: null, wireConfigurationDigest: canonicalDigest('wire') };
                return {
                    resource: input.resource, project: input.project, location: input.location, state: 'PAUSED',
                    target, httpTargetPresent: true, configuration: input.configuration,
                    configurationDigest: canonicalDigest(canonicalQueueConfiguration(input.configuration)), tasks: [], complete: true,
                };
            },
            observeScheduler: async (input: ProtectedSchedulerInput) => {
                const role: Role = input.resource.endsWith('/preflight-recovery') ? 'preflight' : 'paid';
                const old = packet.protectedInputs.old.schedulers[role].target;
                const desired = packet.protectedInputs.desired.schedulers[role].target;
                return {
                    resource: input.resource, project: input.project, location: input.location, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
                    target: role === 'preflight' ? desired : old, configuration: input.configuration,
                    configurationDigest: canonicalDigest(input.configuration),
                };
            },
        };
        const control = new LiveEpochControlPlane({
            cloudRun: {} as never, iam: {} as never, workPlanes: workPlanes as never, vercel: {} as never,
            publicReadinessUrl: 'https://fixture.example.invalid/api/analysis/capacity/readiness', projectId: 'vercel-project', teamId: 'fixture-team',
            deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', producerAlias: 'desired.example.invalid',
            serviceBodies: { preflight: {}, paid: {} }, now: () => 100_000,
            journal: authority.journal, capability: authority.capability, ownerDigest: authority.ownerDigest,
        });
        const result = await control.reconcile({ packet, lease: authority.lease, state: 'QUEUES_ALIGNED' });
        expect(result.proof).toMatchObject({ action: 'RECONCILE_QUEUES_ALIGNED' });
        expect(result.postcondition).toMatchObject({
            queues: [{ role: 'preflight', target: 'DESIRED' }, { role: 'paid', target: 'OLD' }],
            schedulers: [{ role: 'preflight', target: 'DESIRED' }, { role: 'paid', target: 'OLD' }],
        });
    });

    it('does not let an older align operation borrow a newer owner fence', async () => {
        const packet = createFixturePacket();
        const checks: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
        let firstStarted!: () => void;
        const firstStartedSignal = new Promise<void>(resolve => { firstStarted = resolve; });
        let firstChecks = 0;
        const authority = liveAuthority(packet, 'b'.repeat(64), '1', async (lease: { lock: EpochLock }) => {
            checks.push(lease.lock.lockFence);
            if (lease.lock.lockFence === '1') {
                firstChecks += 1;
                if (firstChecks === 1) {
                    firstStarted();
                    await firstGate;
                    return;
                }
                throw new EpochError('LOCK_LOST');
            }
            throw new EpochError('OBSERVATION_RACE');
        });
        const firstLock = authority.lease.lock;
        const secondLock: EpochLock = { ...firstLock, lockFence: '2' };
        let pauseQueueCalls = 0;
        const workPlanes = {
            observeScheduler: async (input: ProtectedSchedulerInput) => {
                const role: Role = input.resource.endsWith('/preflight-recovery') ? 'preflight' : 'paid';
                const old = packet.protectedInputs.old.schedulers[role];
                return { resource: input.resource, project: input.project, location: input.location, state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null, target: old.target, configuration: old.configuration, configurationDigest: canonicalDigest(old.configuration) };
            },
            observeQueue: async (input: ProtectedQueueInput) => {
                const role: Role = input.resource.endsWith('/preflight') ? 'preflight' : 'paid';
                const old = packet.protectedInputs.old.queues[role];
                return { resource: input.resource, project: input.project, location: input.location, state: 'RUNNING', target: old.target, httpTargetPresent: true, configuration: old.configuration, configurationDigest: canonicalDigest(canonicalQueueConfiguration(old.configuration)), tasks: [], complete: true };
            },
            pauseQueue: async () => { pauseQueueCalls += 1; throw new Error('old operation must fence before pause'); },
        };
        const control = new LiveEpochControlPlane({
            cloudRun: {} as never, iam: {} as never, workPlanes: workPlanes as never, vercel: {} as never,
            publicReadinessUrl: 'https://fixture.example.invalid/api/analysis/capacity/readiness', projectId: 'vercel-project', teamId: 'fixture-team',
            deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', producerAlias: 'desired.example.invalid',
            serviceBodies: { preflight: {}, paid: {} }, journal: authority.journal,
            capability: authority.capability, ownerDigest: authority.ownerDigest,
        });
        const oldOperation = control.alignQueues({ packet, lease: { generation: '1', lock: firstLock } });
        await firstStartedSignal;
        const newOperation = control.alignQueues({ packet, lease: { generation: '2', lock: secondLock } });
        await expect(newOperation).rejects.toThrow('OBSERVATION_RACE');
        releaseFirst();
        await expect(oldOperation).rejects.toThrow('LOCK_LOST');
        expect(checks).toEqual(['1', '2', '1']);
        expect(pauseQueueCalls).toBe(0);
    });

    it('rejects valid-format Live.resume baseline tampering and missing committed evidence', async () => {
        const packet = createFixturePacket();
        const authority = liveAuthority(packet);
        const prepared = preparedTransition(authority.journal, authority.lease.lock.lockFence);
        await authority.journal.append(authority.lease, prepared);
        const observed = { capturedAtMs: 100_000, ledger: 'fixture-baseline' };
        const baseline = {
            capturedAtMs: observed.capturedAtMs,
            digest: canonicalDigest(observed),
            epochHeaderDigest: authority.journal.epochHeaderDigest,
            packetDigest: canonicalDigest(packet),
            transitionCommitment: transitionCommitment(prepared),
            ownerDigest: authority.lease.lock.ownerDigest,
            lockFence: authority.lease.lock.lockFence,
        } as const;
        await authority.storage.put(authority.journal.baselineKey, baseline, { ifGenerationMatch: '0' });

        const control = () => new LiveEpochControlPlane({
            cloudRun: {} as never, iam: {} as never, workPlanes: {} as never, vercel: {} as never,
            publicReadinessUrl: 'https://fixture.example.invalid/api/analysis/capacity/readiness', projectId: 'vercel-project', teamId: 'fixture-team',
            deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', producerAlias: 'desired.example.invalid',
            serviceBodies: { preflight: {}, paid: {} }, journal: authority.journal, capability: authority.capability,
            ownerDigest: authority.ownerDigest, zeroWorkBaseline: async () => observed, now: () => 100_000,
        });
        await expect(control().resume({ packet, lease: authority.lease, state: 'PREPARED' })).resolves.toBeUndefined();
        const tamperCases: readonly [keyof typeof baseline, unknown, string][] = [
            ['capturedAtMs', 100_001, 'OBSERVATION_RACE'],
            ['digest', 'f'.repeat(64), 'OBSERVATION_RACE'],
            ['packetDigest', 'f'.repeat(64), 'CAPABILITY_BINDING_MISMATCH'],
            ['epochHeaderDigest', 'f'.repeat(64), 'JOURNAL_INVALID'],
            ['transitionCommitment', 'f'.repeat(64), 'OBSERVATION_RACE'],
        ];
        for (const [key, value, errorCode] of tamperCases) {
            const current = await authority.storage.get(authority.journal.baselineKey);
            if (!current) throw new Error('missing baseline fixture');
            const tampered = await authority.storage.put(authority.journal.baselineKey, { ...(current.value as object), [key]: value }, { ifGenerationMatch: current.generation });
            await expect(control().resume({ packet, lease: authority.lease, state: 'PREPARED' }), key).rejects.toThrow(errorCode);
            await authority.storage.put(authority.journal.baselineKey, baseline, { ifGenerationMatch: tampered.generation });
        }

        const current = await authority.storage.get(authority.journal.baselineKey);
        if (!current) throw new Error('missing baseline fixture');
        await authority.storage.delete!(authority.journal.baselineKey, { ifGenerationMatch: current.generation });
        await expect(control().resume({ packet, lease: authority.lease, state: 'PREPARED' })).rejects.toThrow('EVIDENCE_UNAVAILABLE');
    });

    it('refuses pre-PREPARED baseline adoption after a real owner takeover without recapturing or mutating', async () => {
        const packet = createFixturePacket();
        const now = { value: 100_000 };
        const header = {
            epochIdDigest: canonicalDigest(packet.epochId),
            capabilityDigest: packet.capabilityDigest,
            oldManifestDigest: packet.oldManifestDigest,
            desiredManifestDigest: packet.desiredManifestDigest,
            roleSetDigest: packet.roleSetDigest,
            sourcePlanDigest: packet.sourcePlanDigest,
            createdAt: '2026-09-08T00:00:00.000Z',
        } as const;
        const storage = new MemoryStorage();
        const journal = new EpochJournal(storage, { header, now: () => now.value, leaseMs: 100 });
        await journal.ensureHeader();
        const oldOwner = 'b'.repeat(64);
        const oldLease = await journal.acquire(oldOwner);
        const observed = { capturedAtMs: 100_000, ledger: 'fixture-baseline' };
        const baseline = {
            capturedAtMs: observed.capturedAtMs,
            digest: canonicalDigest(observed),
            epochHeaderDigest: journal.epochHeaderDigest,
            packetDigest: canonicalDigest(packet),
            transitionCommitment: canonicalDigest('uncommitted-prepared'),
            ownerDigest: oldLease.lock.ownerDigest,
            lockFence: oldLease.lock.lockFence,
        } as const;
        await journal.persistEvidenceBaseline(oldLease, baseline);
        const retainedBefore = await storage.get(journal.baselineKey);
        if (!retainedBefore) throw new Error('missing baseline fixture');
        const newOwner = 'c'.repeat(64);
        now.value += 101;
        const newLease = await journal.acquire(newOwner);
        await expect(journal.assertLive(newLease)).resolves.toBeUndefined();
        let recaptures = 0;
        const control = new LiveEpochControlPlane({
            cloudRun: {} as never, iam: {} as never, workPlanes: {} as never, vercel: {} as never,
            publicReadinessUrl: 'https://fixture.example.invalid/api/analysis/capacity/readiness', projectId: 'vercel-project', teamId: 'fixture-team',
            deploymentId: 'dpl-desired', expectedOldDeploymentId: 'dpl-old', producerAlias: 'desired.example.invalid',
            serviceBodies: { preflight: {}, paid: {} }, journal,
            capability: issueCoordinatorCapability(packet, newOwner), ownerDigest: newOwner,
            zeroWorkBaseline: async () => { recaptures += 1; return observed; }, now: () => now.value,
        });
        await expect(control.resume({ packet, lease: newLease, state: null })).rejects.toThrow('LOCK_LOST');
        expect(recaptures).toBe(0);
        await expect(storage.get(journal.baselineKey)).resolves.toEqual(retainedBefore);
    });
});
