import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { createFixturePacket, FIXTURE_ZERO_WORK_SELECTOR_DIGESTS } from './capacity-identity-epoch/fixtures';
import { EpochCoordinator, type EpochControlPlane, type OperationEvidence } from './capacity-identity-epoch/coordinator';
import { EpochJournal, type JournalStorage, type StoredObject } from './capacity-identity-epoch/journal';
import { canonicalDigest, EpochError, type EpochHeader, type State } from './capacity-identity-epoch/contracts';
import { buildLiveBootstrap, loadProtectedLiveBootstrap } from './capacity-identity-epoch/bootstrap';
import { evidenceSelectorDigest, type LiveZeroWorkSources, type SupabaseLedgerSource } from './capacity-identity-epoch/live-evidence';
import { AuthenticatedProtectedTransport, type ProtectedHttpResponse, type ProtectedTransport } from './capacity-identity-epoch/platform';
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

/**
 * The bootstrap graph performs authenticated transport preflight even when
 * evidence is intentionally absent.  Keep this provider-free integration
 * test independent of a runner's ambient ADC or metadata service while still
 * constructing the production AuthenticatedProtectedTransport adapters.
 */
class FixtureProtectedTransport implements ProtectedTransport {
    async request(): Promise<ProtectedHttpResponse> {
        throw new EpochError('ADAPTER_REQUEST_INVALID');
    }
}

function fixtureAuthenticatedTransport(token: string): AuthenticatedProtectedTransport {
    return new AuthenticatedProtectedTransport({
        transport: new FixtureProtectedTransport(),
        tokenProvider: async () => token,
        timeoutMs: 1_000,
    });
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

function reviewedServiceBodies(packet: ReturnType<typeof createFixturePacket>): Record<'preflight' | 'paid', Record<string, unknown>> {
    return Object.fromEntries((['preflight', 'paid'] as const).map(role => {
        const runtime = packet.protectedInputs.desired.runtime[role];
        const image = `asia-northeast3-docker.pkg.dev/${runtime.project}/workers/${role}@sha256:${'b'.repeat(64)}`;
        const plan = packet.desiredManifest.source[role].revisionPlan;
        const suffix = packet.desiredManifest.source[role].desiredRevisionId
            ?? `${packet.desiredManifest.source[role].desiredSha.slice(0, 12)}${plan.suffix}`;
        const desiredRevision = `${plan.prefix}${suffix}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 63).replace(/-+$/, '');
        const env = [
            ...Object.entries(runtime.environment).map(([name, value]) => ({ name, value })),
            ...Object.entries(runtime.secretReferences).map(([name, value]) => {
                const [secretName, key] = value.split(':');
                return { name, valueFrom: { secretKeyRef: { name: secretName, key } } };
            }),
        ];
        return [role, {
            metadata: { name: runtime.service, generation: 1, resourceVersion: packet.protectedObservations.old.runtime[role].resourceVersion, labels: {}, annotations: {} },
            spec: {
                template: {
                    metadata: {
                        name: desiredRevision,
                        labels: {},
                        annotations: {
                            'autoscaling.knative.dev/maxScale': String(runtime.settings.maxInstances),
                            'capacity.identity-epoch/source-sha': runtime.sourceSha,
                            'capacity.identity-epoch/build-digest': packet.desiredManifest.source[role].desiredBuildDigest,
                            'capacity.identity-epoch/image-digest': canonicalDigest({ image }),
                        },
                    },
                    spec: {
                        serviceAccountName: runtime.identity.identity,
                        containerConcurrency: runtime.settings.concurrency,
                        timeoutSeconds: runtime.settings.timeoutSeconds,
                        containers: [{ image, env, resources: { limits: { cpu: runtime.settings.cpu, memory: runtime.settings.memory } } }],
                    },
                },
                traffic: [
                    { revisionName: packet.oldManifest.source[role].oldRevision, percent: 100, tag: null },
                    { revisionName: desiredRevision, percent: 0, tag: null },
                ],
            },
        }];
    })) as unknown as Record<'preflight' | 'paid', Record<string, unknown>>;
}

function reviewedZeroWorkSources(packet: ReturnType<typeof createFixturePacket>): LiveZeroWorkSources {
    const project = packet.protectedInputs.desired.runtime.preflight.project;
    const queueUnion = [
        packet.protectedInputs.desired.queues.preflight.resource,
        packet.protectedInputs.desired.queues.paid.resource,
    ] as const;
    const origin = 'https://supabase.example.invalid/';
    const supabase = (base: Omit<SupabaseLedgerSource, 'lookbackMs' | 'selectorDigest' | 'kind' | 'origin'>): SupabaseLedgerSource => {
        const withWindow = { kind: 'supabase' as const, origin, ...base, lookbackMs: 60_000 };
        return { ...withWindow, selectorDigest: evidenceSelectorDigest({ ...withWindow, selectorDigest: '0'.repeat(64) }) };
    };
    const taskBase = {
        kind: 'cloud-logging' as const, source: 'fixture-task-audit', project, logName: `projects/${project}/logs/fixture-task-audit`,
        resourceType: 'cloud_tasks_queue' as const, correlation: 'fixture-task-audit', queueResources: queueUnion,
        sinkName: 'fixture-task-audit-sink', bucketResource: `projects/${project}/locations/global/buckets/fixture-task-audit`, lookbackMs: 60_000,
    };
    return {
        providerLedger: supabase({ source: 'supabase:public.analysis_provider_cost_ledger', table: 'analysis_provider_cost_ledger', columns: ['run_id', 'request_id', 'operation_key', 'status', 'created_at'], eventTimeColumn: 'created_at' }),
        billingLedger: supabase({ source: 'supabase:public.analysis_revenue_cost_operations', table: 'analysis_revenue_cost_operations', columns: ['request_id', 'owner_kind', 'owner_key_hash', 'operation_kind', 'status', 'created_at'], eventTimeColumn: 'created_at' }),
        taskAudit: { ...taskBase, selectorDigest: FIXTURE_ZERO_WORK_SELECTOR_DIGESTS.taskAudit },
        receiverLog: supabase({ source: 'supabase:public.analysis_step_events', table: 'analysis_step_events', columns: ['id', 'request_id', 'step', 'event_type', 'created_at'], eventTimeColumn: 'created_at' }),
    };
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
            serviceBodies: reviewedServiceBodies(packet), zeroWorkEvidence: null,
        } as const;
        const directory = mkdtempSync(join(tmpdir(), 'identity-epoch-bootstrap-'));
        const descriptorPath = join(directory, 'bootstrap.json');
        writeFileSync(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
        const fd = openSync(descriptorPath, 'r');
        const googleTransport = fixtureAuthenticatedTransport('fixture-google-token');
        const vercelTransport = fixtureAuthenticatedTransport('fixture-vercel-token');
        try {
            chmodSync(descriptorPath, 0o600);
            const loaded = await loadProtectedLiveBootstrap(fd);
            const storage = new MemoryStorage();
            const live = await buildLiveBootstrap(packet, loaded, { storage, now: () => 1_000, googleTransport, vercelTransport });
            await live.journal.ensureHeader();
            const resumed = await buildLiveBootstrap(packet, loaded, { storage, now: () => 2_000, googleTransport, vercelTransport });
            expect(live.missingEvidence).toEqual(['zeroWorkEvidence']);
            expect(live.journal.headerKey).toContain('epoch-header');
            expect(resumed.journal.headerKey).toBe(live.journal.headerKey);
            expect(resumed.journal.epochHeaderDigest).toBe(live.journal.epochHeaderDigest);
            expect(resumed.journal.lockKey).toBe(live.journal.lockKey);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
        await expect(buildLiveBootstrap(packet, { ...descriptor, packetDigest: 'f'.repeat(64) }, { resolveRetainedHeader: false })).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        const wrongImage = {
            ...descriptor,
            serviceBodies: {
                ...descriptor.serviceBodies,
                preflight: {
                    ...descriptor.serviceBodies.preflight,
                    spec: {
                        ...(descriptor.serviceBodies.preflight.spec as Record<string, unknown>),
                        template: {
                            ...((descriptor.serviceBodies.preflight.spec as Record<string, unknown>).template as Record<string, unknown>),
                            spec: {
                                ...(((descriptor.serviceBodies.preflight.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>),
                                containers: [{
                                    ...((((descriptor.serviceBodies.preflight.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>).containers as unknown[])[0] as Record<string, unknown>,
                                    image: 'asia-northeast3-docker.pkg.dev/example-project/workers/preflight@sha256:' + 'c'.repeat(64),
                                }],
                            },
                        },
                    },
                },
            },
        };
        await expect(buildLiveBootstrap(packet, wrongImage, { resolveRetainedHeader: false, storage: new MemoryStorage() })).rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        const bodyMutationCases = [
            ['wrong environment', (body: Record<string, unknown>) => {
                const container = (((body.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>).containers as Array<Record<string, unknown>>;
                container[0]!.env = [...container[0]!.env as Array<Record<string, unknown>>, { name: 'UNREVIEWED', value: 'true' }];
            }],
            ['wrong secret', (body: Record<string, unknown>) => {
                const container = (((body.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>).containers as Array<Record<string, unknown>>;
                const env = container[0]!.env as Array<Record<string, unknown>>;
                const secret = env.find(item => item.valueFrom !== undefined)!;
                secret.valueFrom = { secretKeyRef: { name: 'other-secret', key: '7' } };
            }],
            ['extra field', (body: Record<string, unknown>) => {
                const container = (((body.spec as Record<string, unknown>).template as Record<string, unknown>).spec as Record<string, unknown>).containers as Array<Record<string, unknown>>;
                container[0]!.command = ['unreviewed'];
            }],
        ] as const;
        for (const [label, mutate] of bodyMutationCases) {
            const serviceBodies = JSON.parse(JSON.stringify(descriptor.serviceBodies)) as Record<'preflight' | 'paid', Record<string, unknown>>;
            mutate(serviceBodies.preflight);
            await expect(buildLiveBootstrap(packet, { ...descriptor, serviceBodies }, { resolveRetainedHeader: false, storage: new MemoryStorage() }), label)
                .rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        }
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
            googleTransport,
            vercelTransport,
        })).rejects.toThrow('JOURNAL_INVALID');

        const mismatchedStorage = new MemoryStorage();
        await mismatchedStorage.put(headerKey, { ...retainedHeader, sourcePlanDigest: '0'.repeat(64) }, { ifGenerationMatch: '0' });
        await expect(buildLiveBootstrap(packet, descriptor, {
            storage: mismatchedStorage,
            now: () => 2_000,
            googleTransport,
            vercelTransport,
        })).rejects.toThrow('JOURNAL_INVALID');
    });

    it('rejects selector retargeting before constructing authenticated clients or touching journal storage', async () => {
        const packet = createFixturePacket();
        const scope = packet.providerScope;
        const evidence = reviewedZeroWorkSources(packet);
        expect(evidenceSelectorDigest(evidence.taskAudit)).toBe(evidence.taskAudit.selectorDigest);
        const descriptor = {
            packetDigest: canonicalDigest(packet), ownerDigest: canonicalDigest('selector-binding-owner'), lockNamespace: packet.lockNamespace,
            ...scope, scopeDigest: canonicalDigest(scope), vercelToken: 'fixture-vercel-token', serviceBodies: reviewedServiceBodies(packet), zeroWorkEvidence: evidence,
        } as const;
        const cases = [
            ['source', { ...evidence, providerLedger: { ...evidence.providerLedger, source: 'retargeted-provider' } }],
            ['lookback', { ...evidence, providerLedger: { ...evidence.providerLedger, lookbackMs: 120_000 } }],
            ['table selector', (() => {
                const providerLedger = { ...evidence.providerLedger, table: 'analysis_provider_cost_ledger_other' };
                return { ...evidence, providerLedger: { ...providerLedger, selectorDigest: evidenceSelectorDigest(providerLedger) } };
            })()],
            ['queue selector', (() => {
                const taskAudit = { ...evidence.taskAudit, queueResources: [...(evidence.taskAudit.queueResources ?? [])].map((resource, index) => index === 0 ? resource.replace('/locations/asia-northeast3/', '/locations/other-region/') : resource) };
                return { ...evidence, taskAudit: { ...taskAudit, selectorDigest: evidenceSelectorDigest(taskAudit) } };
            })()],
            ['queue role substitution', (() => {
                const queueResources = [...(evidence.taskAudit.queueResources ?? [])];
                queueResources[1] = queueResources[1]!.replace('/queues/paid', '/queues/another-role');
                const taskAudit = { ...evidence.taskAudit, queueResources };
                return { ...evidence, taskAudit: { ...taskAudit, selectorDigest: evidenceSelectorDigest(taskAudit) } };
            })()],
            ['receiver table selector', (() => {
                const receiverLog = { ...evidence.receiverLog, table: 'analysis_step_events_other' };
                return { ...evidence, receiverLog: { ...receiverLog, selectorDigest: evidenceSelectorDigest(receiverLog) } };
            })()],
        ] as const;
        for (const [label, changed] of cases) {
            await expect(buildLiveBootstrap(packet, { ...descriptor, zeroWorkEvidence: changed }, { resolveRetainedHeader: false, storage: new MemoryStorage() }), label)
                .rejects.toThrow('CAPABILITY_BINDING_MISMATCH');
        }
    });

});
