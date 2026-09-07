import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    ROLES,
    SLOTS,
    createProtectedPacket,
    issueCoordinatorCapability,
    loadProtectedPacket,
    validateEpochPacket,
    validateManifestComparison,
} from './packet';
import { EpochError, canonicalDigest } from './contracts';
import type { CapacityManifest, ProtectedOldObservations, ProtectedObservationTargets, ProtectedPlatformInputs } from './contracts';

const PROJECT = 'example-project';
const oldIdentity = (slot: string) => `${slot.replaceAll('.', '-')}-old@example-project.iam.gserviceaccount.com`;
const desiredIdentity = (slot: string) => `${slot.replaceAll('.', '-')}-desired@example-project.iam.gserviceaccount.com`;

function identity(value: string) {
    return { identity: value, project: PROJECT };
}

function runtimeSettings(role: 'preflight' | 'paid') {
    return { cpu: '2', memory: '2Gi', concurrency: 1, timeoutSeconds: 600, maxInstances: role === 'preflight' ? 32 : 8 };
}

function runtimeEnvironment(role: 'preflight' | 'paid', suffix: 'old' | 'desired') {
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const maintenancePrefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2';
    const targetOrigin = `https://${role}.example.com`;
    const taskCallerIdentity = `${role}-task-caller-${suffix}@example-project.iam.gserviceaccount.com`;
    const maintenanceIdentity = `${role}-maintenance-${suffix}@example-project.iam.gserviceaccount.com`;
    return {
        [`${prefix}_PROJECT`]: PROJECT,
        [`${prefix}_LOCATION`]: 'asia-northeast3',
        [`${prefix}_QUEUE`]: role,
        [`${prefix}_TARGET_URL`]: `${targetOrigin}/api/analysis/${role}/worker`,
        [`${prefix}_OIDC_AUDIENCE`]: targetOrigin,
        [`${prefix}_SERVICE_ACCOUNT_EMAIL`]: taskCallerIdentity,
        [`${maintenancePrefix}_MAINTENANCE_SERVICE_ACCOUNT_EMAIL`]: maintenanceIdentity,
        [`${maintenancePrefix}_MAINTENANCE_OIDC_AUDIENCE`]: targetOrigin,
        [`${role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS'}_RECOVERY_ENABLED`]: 'true',
        ANALYSIS_WORKLOAD_ROLE: role,
        ANALYSIS_CAPACITY_STAGE: 'initial',
        ANALYSIS_CAPACITY_EXPANSION_CANARY: 'false',
        ANALYSIS_CAPACITY_WORKER_CPU: '2',
        ANALYSIS_CAPACITY_WORKER_MEMORY: '2Gi',
        ANALYSIS_CAPACITY_PUBLIC_FREEZE_ENABLED: 'true',
        ANALYSIS_CAPACITY_LEGACY_FREEZE_MODE: 'drain-and-block',
        ANALYSIS_CAPACITY_LEGACY_PRODUCERS_FROZEN: 'true',
        ANALYSIS_CAPACITY_LEGACY_TASKS_DRAINED: 'true',
        ANALYSIS_CAPACITY_LEGACY_TARGETS_BLOCKED: 'true',
        ANALYSIS_CAPACITY_LEGACY_QUEUE_PAUSE_CONFIRMED: 'true',
        ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true',
        ANALYSIS_BETA_PREPARE_ENABLED: 'false',
        PREFLIGHT_TASKS_ENABLED: role === 'preflight' ? 'true' : 'false',
        ANALYSIS_V2_TASKS_ENABLED: role === 'paid' ? 'true' : 'false',
        ANALYSIS_V2_WORKER_ENABLED: role === 'paid' ? 'true' : 'false',
        PREFLIGHT_TASKS_RECOVERY_ENABLED: role === 'preflight' ? 'true' : 'false',
        ANALYSIS_V2_RECOVERY_ENABLED: role === 'paid' ? 'true' : 'false',
        ANALYSIS_V2_APIFY_API_TOKEN_SLOT: role === 'preflight' ? 'senary' : 'secondary',
        ...(role === 'preflight' ? { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,quinary,senary' } : {}),
    };
}

function manifest(kind: 'old' | 'desired'): CapacityManifest {
    const suffix = kind === 'old' ? 'old' : 'desired';
    const roleSlots = Object.fromEntries(SLOTS.map(slot => [
        slot,
        identity(kind === 'old' ? oldIdentity(slot) : desiredIdentity(slot)),
    ]));
    const buildInput = {
        identity: identity('new-build@example-project.iam.gserviceaccount.com'),
        sourceSha: 'b'.repeat(40), sourceContext: 'fixture-source-context', buildArguments: { NODE_ENV: 'production' },
    };
    const runtimeTarget = (role: 'preflight' | 'paid') => ({
        role,
        service: `${role}-worker`, project: PROJECT, location: 'asia-northeast3',
        identity: identity(`${role}.runtime-desired`.replace('.', '-') + '@example-project.iam.gserviceaccount.com'),
        sourceSha: 'b'.repeat(40),
        environment: runtimeEnvironment(role, 'desired'),
        secretReferences: { ANALYSIS_SECRET: 'secret:7' },
        settings: runtimeSettings(role),
        target: { url: `https://${role}.example.com/api/analysis/${role}/worker`, audience: `https://${role}.example.com` },
        noTraffic: true, providerAdmissionEnabled: true,
    });
    const queueTarget = (role: 'preflight' | 'paid') => ({
        url: `https://${role}.example.com/api/analysis/${role}/worker`, audience: `https://${role}.example.com`,
        callerIdentity: identity(`${role}.task-caller-${suffix}`.replace('.', '-') + '@example-project.iam.gserviceaccount.com'),
    });
    const schedulerTarget = (role: 'preflight' | 'paid') => ({
        uri: `https://${role}.example.com/api/analysis/${role}/recover`, audience: `https://${role}.example.com`,
        identity: identity(`${role}.maintenance-${suffix}`.replace('.', '-') + '@example-project.iam.gserviceaccount.com'),
    });
    const revision = (role: 'preflight' | 'paid') => ({
        oldSha: 'a'.repeat(40),
        oldRevision: `${role}-old-revision`,
        desiredSha: 'b'.repeat(40),
        desiredBuildDigest: canonicalDigest(buildInput),
        desiredRuntimeDigest: canonicalDigest(runtimeTarget(role)),
        desiredRuntimeEnvironment: runtimeEnvironment(role, 'desired'),
        desiredRuntimeSettings: runtimeSettings(role),
        revisionPlan: { prefix: `${role}-epoch`, suffix: 'fixture' },
    });
    const producer = (role: 'preflight' | 'paid') => ({
        sourceSha: 'b'.repeat(40),
        fingerprintVersion: `${role}-producer-config-v1`,
        fingerprint: role === 'preflight' ? 'e'.repeat(64) : 'f'.repeat(64),
        admissionEnabled: false,
    });
    const queue = (role: 'preflight' | 'paid') => ({
        resource: `projects/${PROJECT}/locations/asia-northeast3/queues/${role}`, project: PROJECT, location: 'asia-northeast3',
        targetDigest: canonicalDigest(queueTarget(role)),
        configDigest: '1'.repeat(64), state: 'PAUSED', empty: true, tasksDigest: '2'.repeat(64),
    });
    const scheduler = (role: 'preflight' | 'paid') => ({
        resource: `projects/${PROJECT}/locations/asia-northeast3/jobs/${role}-recovery`, project: PROJECT, location: 'asia-northeast3',
        targetDigest: canonicalDigest(schedulerTarget(role)),
        configDigest: '3'.repeat(64), state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
    });
    const iam = (role: 'preflight' | 'paid') => ({
        policyDigest: '4'.repeat(64), desiredBindings: [`${role}:desired`], retiredBindings: [],
    });
    return {
        roleSlots,
        build: identity(kind === 'old' ? 'old-build@example-project.iam.gserviceaccount.com' : 'new-build@example-project.iam.gserviceaccount.com'),
        source: { preflight: revision('preflight'), paid: revision('paid') },
        producer: { preflight: producer('preflight'), paid: producer('paid') },
        queues: { preflight: queue('preflight'), paid: queue('paid') },
        recoverySchedulers: { preflight: scheduler('preflight'), paid: scheduler('paid') },
        retention: { resource: `projects/${PROJECT}/locations/asia-northeast3/jobs/retention`, project: PROJECT, location: 'asia-northeast3', enabled: true, configDigest: '5'.repeat(64) },
        iam: { preflight: iam('preflight'), paid: iam('paid') },
        readiness: {
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40),
            legacyTargetResource: 'fixture-target', preflightFingerprint: 'e'.repeat(64), paidFingerprint: 'f'.repeat(64),
            analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false,
        },
    } as unknown as CapacityManifest;
}

function platformInputs(kind: 'old' | 'desired'): ProtectedPlatformInputs {
    const suffix = kind === 'old' ? 'old' : 'desired';
    const sourceSha = kind === 'old' ? 'a'.repeat(40) : 'b'.repeat(40);
    const roleInput = (role: 'preflight' | 'paid') => ({
        role,
        service: `${role}-worker`, project: PROJECT, location: 'asia-northeast3',
        identity: identity(`${role}.runtime-${suffix}`.replace('.', '-') + '@example-project.iam.gserviceaccount.com'),
        sourceSha,
        environment: runtimeEnvironment(role, suffix),
        secretReferences: { ANALYSIS_SECRET: 'secret:7' },
        settings: runtimeSettings(role),
        target: { url: `https://${role}.example.com/api/analysis/${role}/worker`, audience: `https://${role}.example.com` },
        noTraffic: true,
        providerAdmissionEnabled: true,
    });
    const queueInput = (role: 'preflight' | 'paid') => ({
        resource: `projects/${PROJECT}/locations/asia-northeast3/queues/${role}`,
        project: PROJECT,
        location: 'asia-northeast3',
        target: {
            url: `https://${role}.example.com/api/analysis/${role}/worker`,
            audience: `https://${role}.example.com`,
            callerIdentity: identity(`${role}.task-caller-${suffix}`.replace('.', '-') + '@example-project.iam.gserviceaccount.com'),
        },
        configuration: { maxDispatchesPerSecond: 2, maxConcurrentDispatches: 2 },
    });
    const schedulerInput = (role: 'preflight' | 'paid') => ({
        resource: `projects/${PROJECT}/locations/asia-northeast3/jobs/${role}-recovery`,
        project: PROJECT,
        location: 'asia-northeast3',
        target: {
            uri: `https://${role}.example.com/api/analysis/${role}/recover`,
            audience: `https://${role}.example.com`,
            identity: identity(`${role}.maintenance-${suffix}`.replace('.', '-') + '@example-project.iam.gserviceaccount.com'),
        },
        configuration: { schedule: '* * * * *', method: 'POST' },
        state: 'PAUSED' as const, pauseEpochMs: 1, lastAttemptMs: null,
    });
    const iamInput = (role: 'preflight' | 'paid') => {
        const oldTaskCaller = `${role}-task-caller-old@example-project.iam.gserviceaccount.com`;
        const desiredTaskCaller = `${role}-task-caller-desired@example-project.iam.gserviceaccount.com`;
        const oldMaintenance = `${role}-maintenance-old@example-project.iam.gserviceaccount.com`;
        const desiredMaintenance = `${role}-maintenance-desired@example-project.iam.gserviceaccount.com`;
        const oldEnqueuer = `${role}-enqueuer-old@example-project.iam.gserviceaccount.com`;
        const desiredEnqueuer = `${role}-enqueuer-desired@example-project.iam.gserviceaccount.com`;
        const oldRuntime = `${role}-runtime-old@example-project.iam.gserviceaccount.com`;
        const desiredRuntime = `${role}-runtime-desired@example-project.iam.gserviceaccount.com`;
        const includeOld = kind === 'desired';
        const members = (oldValue: string, desiredValue: string) => includeOld ? [oldValue, desiredValue] : [oldValue];
        const agent = 'serviceAccount:service-123456789012@gcp-sa-cloudtasks.iam.gserviceaccount.com';
        const runResource = `projects/${PROJECT}/locations/asia-northeast3/services/${role}-worker`;
        const queueResource = `projects/${PROJECT}/locations/asia-northeast3/queues/${role}`;
        const taskCallerResource = `projects/${PROJECT}/serviceAccounts/${kind === 'old' ? oldTaskCaller : desiredTaskCaller}`;
        const runBindings = [
            ...members(oldTaskCaller, desiredTaskCaller).map(member => ({ role: 'roles/run.invoker', member: `serviceAccount:${member}`, condition: null })),
            ...members(oldMaintenance, desiredMaintenance).map(member => ({ role: 'roles/run.invoker', member: `serviceAccount:${member}`, condition: null })),
        ];
        const queueBindings = [
            ...members(oldEnqueuer, desiredEnqueuer).map(member => ({ role: 'roles/cloudtasks.enqueuer', member: `serviceAccount:${member}`, condition: null })),
            ...members(oldRuntime, desiredRuntime).map(member => ({ role: 'roles/cloudtasks.enqueuer', member: `serviceAccount:${member}`, condition: null })),
            ...members(oldRuntime, desiredRuntime).map(member => ({ role: 'roles/cloudtasks.viewer', member: `serviceAccount:${member}`, condition: null })),
        ];
        const oldTaskCallerBindings = [
            { role: 'roles/iam.serviceAccountUser', member: `serviceAccount:${oldEnqueuer}`, condition: null },
            { role: 'roles/iam.serviceAccountUser', member: `serviceAccount:${oldRuntime}`, condition: null },
            { role: 'roles/iam.serviceAccountUser', member: agent, condition: null },
        ];
        const taskCallerBindings = [
            ...members(oldEnqueuer, desiredEnqueuer).map(member => ({ role: 'roles/iam.serviceAccountUser', member: `serviceAccount:${member}`, condition: null })),
            ...members(oldRuntime, desiredRuntime).map(member => ({ role: 'roles/iam.serviceAccountUser', member: `serviceAccount:${member}`, condition: null })),
            { role: 'roles/iam.serviceAccountUser', member: agent, condition: null },
        ];
        const previous = (resource: string, bindings: readonly { role: string; member: string; condition: null }[]) =>
            kind === 'old' ? null : { resource, project: PROJECT, etag: 'Bwfixture', bindings };
        return {
            run: { kind: 'run' as const, resource: runResource, project: PROJECT, etag: 'Bwfixture', bindings: runBindings, previous: previous(runResource, runBindings.filter(binding => binding.member.includes('-old@'))) },
            queue: { kind: 'queue' as const, resource: queueResource, project: PROJECT, etag: 'Bwfixture', bindings: queueBindings, previous: previous(queueResource, queueBindings.filter(binding => binding.member.includes('-old@'))) },
            taskCaller: { kind: 'taskCaller' as const, resource: taskCallerResource, project: PROJECT, etag: 'Bwfixture', bindings: taskCallerBindings, previous: previous(`projects/${PROJECT}/serviceAccounts/${oldTaskCaller}`, oldTaskCallerBindings) },
            maintenance: { kind: 'maintenance' as const, resource: runResource, project: PROJECT, etag: 'Bwfixture', bindings: [...runBindings], previous: previous(runResource, runBindings.filter(binding => binding.member.includes('-old@'))) },
        };
    };
    return {
        build: {
            identity: identity(`${kind === 'old' ? 'old' : 'new'}-build@example-project.iam.gserviceaccount.com`),
            sourceSha,
            sourceContext: 'fixture-source-context',
            buildArguments: { NODE_ENV: 'production' },
        },
        runtime: { preflight: roleInput('preflight'), paid: roleInput('paid') },
        queues: { preflight: queueInput('preflight'), paid: queueInput('paid') },
        schedulers: { preflight: schedulerInput('preflight'), paid: schedulerInput('paid') },
        iam: { preflight: iamInput('preflight'), paid: iamInput('paid') },
        retention: {
            resource: `projects/${PROJECT}/locations/asia-northeast3/jobs/retention`,
            project: PROJECT, location: 'asia-northeast3', enabled: true,
            configuration: { enabled: true },
        },
    } as unknown as ProtectedPlatformInputs;
}

function oldObservations(): ProtectedOldObservations {
    const platform = platformInputs('old');
    const sourceSha = 'a'.repeat(40);
    const sourceRevision = (role: 'preflight' | 'paid') => `${role}-old-revision`;
    return {
        source: {
            preflight: { sourceSha, revision: sourceRevision('preflight'), metadataDigest: '1'.repeat(64) },
            paid: { sourceSha, revision: sourceRevision('paid'), metadataDigest: '2'.repeat(64) },
        },
        runtime: {
            preflight: {
                sourceSha, service: platform.runtime.preflight.service, project: PROJECT, location: 'asia-northeast3',
                revision: sourceRevision('preflight'), generation: 'generation-preflight', resourceVersion: 'resource-preflight',
                identity: platform.runtime.preflight.identity, providerAdmissionEnabled: true, noTraffic: true,
                runtimeDigest: '7'.repeat(64), buildDigest: '8'.repeat(64),
            },
            paid: {
                sourceSha, service: platform.runtime.paid.service, project: PROJECT, location: 'asia-northeast3',
                revision: sourceRevision('paid'), generation: 'generation-paid', resourceVersion: 'resource-paid',
                identity: platform.runtime.paid.identity, providerAdmissionEnabled: true, noTraffic: true,
                runtimeDigest: '9'.repeat(64), buildDigest: 'a'.repeat(64),
            },
        },
        queues: {
            preflight: {
                resource: platform.queues.preflight.resource, project: PROJECT, location: 'asia-northeast3',
                state: 'PAUSED', configuration: platform.queues.preflight.configuration,
                tasks: [], complete: true,
            },
            paid: {
                resource: platform.queues.paid.resource, project: PROJECT, location: 'asia-northeast3',
                state: 'PAUSED', configuration: platform.queues.paid.configuration,
                tasks: [], complete: true,
            },
        },
        schedulers: {
            preflight: {
                resource: platform.schedulers.preflight.resource, project: PROJECT, location: 'asia-northeast3',
                state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
                configuration: platform.schedulers.preflight.configuration,
            },
            paid: {
                resource: platform.schedulers.paid.resource, project: PROJECT, location: 'asia-northeast3',
                state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null,
                configuration: platform.schedulers.paid.configuration,
            },
        },
        iam: platform.iam,
        retention: platform.retention,
        readiness: { ...manifest('old').readiness, ready: true },
    } as ProtectedOldObservations;
}

function observationTargets(): ProtectedObservationTargets {
    const platform = platformInputs('desired');
    return {
        source: {
            preflight: {
                sourceSha: 'b'.repeat(40), revisionPlan: manifest('desired').source.preflight.revisionPlan,
                desiredBuildDigest: manifest('desired').source.preflight.desiredBuildDigest,
                desiredRuntimeDigest: manifest('desired').source.preflight.desiredRuntimeDigest,
            },
            paid: {
                sourceSha: 'b'.repeat(40), revisionPlan: manifest('desired').source.paid.revisionPlan,
                desiredBuildDigest: manifest('desired').source.paid.desiredBuildDigest,
                desiredRuntimeDigest: manifest('desired').source.paid.desiredRuntimeDigest,
            },
        },
        runtime: platform.runtime,
        queues: platform.queues,
        schedulers: platform.schedulers,
        iam: platform.iam,
        retention: platform.retention,
        readiness: manifest('desired').readiness,
        zeroWorkSources: {
            providerLedger: { source: 'fixture-provider-ledger', lookbackMs: 60_000 },
            billingLedger: { source: 'fixture-billing-ledger', lookbackMs: 60_000 },
            taskAudit: { source: 'fixture-task-audit', lookbackMs: 60_000 },
            receiverLog: { source: 'fixture-receiver-log', lookbackMs: 60_000 },
        },
    } as ProtectedObservationTargets;
}

function packet() {
    return createProtectedPacket({
        epochId: 'epoch-fixture', lockNamespace: 'fixture-lock', roleSet: [...ROLES],
        oldManifest: manifest('old'), desiredManifest: manifest('desired'),
        protectedInputs: { old: platformInputs('old'), desired: platformInputs('desired') },
        activation: { analysisV2AdmissionEnabled: true, earlybirdWebhookAutoAdmissionEnabled: true },
        quiescence: { timeoutMs: 60_000, graceMs: 5_000 },
        observationInputs: { sourceDigest: '6'.repeat(64), iamDigest: '7'.repeat(64), queueDigest: '8'.repeat(64), schedulerDigest: '9'.repeat(64), retentionDigest: 'a'.repeat(64), readinessDigest: 'b'.repeat(64), zeroWorkDigest: 'c'.repeat(64) },
        protectedObservations: { old: oldObservations(), desired: observationTargets() },
        probe: {
            bodyDigest: 'd'.repeat(64), expectedStatuses: { preflight: 400, paid: 400 },
            expectedCodes: { preflight: 'INVALID_REQUEST', paid: 'INVALID_REQUEST' },
        },
    });
}

describe('coordinated epoch protected packet', () => {
    it('accepts complete old and desired manifests and binds non-secret digests', () => {
        const value = packet() as any;
        expect(value.oldManifestDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(value.desiredManifestDigest).toMatch(/^[0-9a-f]{64}$/);
        expect(validateEpochPacket(value).epochId).toBe('epoch-fixture');
    });

    it('rejects every missing or additional fixed slot before capability issuance', () => {
        for (const slot of SLOTS) {
            const value = packet() as any;
            delete (value.desiredManifest.roleSlots as Record<string, unknown>)[slot];
            expect(() => validateEpochPacket(value)).toThrow(EpochError);
        }
        const extra = packet();
        (extra.desiredManifest.roleSlots as Record<string, unknown>)['extra.slot'] = identity('extra@example-project.iam.gserviceaccount.com');
        expect(() => validateEpochPacket(extra)).toThrow(EpochError);
    });

    it('rejects all 28 desired workload identity collisions and build collisions', () => {
        for (let left = 0; left < SLOTS.length; left += 1) {
            for (let right = left + 1; right < SLOTS.length; right += 1) {
                const value = packet() as any;
                const source = value.desiredManifest.roleSlots[SLOTS[left]];
                value.desiredManifest.roleSlots[SLOTS[right]] = source;
                expect(() => validateEpochPacket(value)).toThrow('IDENTITY_CONFLICT');
            }
        }
        const buildCollision = packet() as any;
        buildCollision.desiredManifest.build = buildCollision.desiredManifest.roleSlots[SLOTS[0]];
        expect(() => validateEpochPacket(buildCollision)).toThrow('IDENTITY_CONFLICT');
    });

    it('allows only same-slot unchanged identity and rejects old shared/retired reuse', () => {
        const unchanged = packet() as any;
        unchanged.desiredManifest.roleSlots[SLOTS[0]] = unchanged.oldManifest.roleSlots[SLOTS[0]];
        expect(() => validateManifestComparison(unchanged.oldManifest, unchanged.desiredManifest)).not.toThrow();

        const moved = packet() as any;
        moved.desiredManifest.roleSlots[SLOTS[1]] = moved.oldManifest.roleSlots[SLOTS[0]];
        expect(() => validateManifestComparison(moved.oldManifest, moved.desiredManifest)).toThrow('IDENTITY_CONFLICT');

        const shared = packet() as any;
        shared.oldManifest.roleSlots[SLOTS[0]] = shared.oldManifest.roleSlots[SLOTS[1]];
        expect(() => validateManifestComparison(shared.oldManifest, shared.desiredManifest)).not.toThrow();
        shared.desiredManifest.roleSlots[SLOTS[2]] = shared.oldManifest.roleSlots[SLOTS[0]];
        expect(() => validateManifestComparison(shared.oldManifest, shared.desiredManifest)).toThrow('IDENTITY_CONFLICT');
    });

    it('allows heterogeneous old source provenance when each role is bound independently', () => {
        const value = packet() as any;
        const paidOldSha = 'c'.repeat(40);
        value.oldManifest.source.paid.oldSha = paidOldSha;
        value.protectedInputs.old.runtime.paid.sourceSha = paidOldSha;
        value.protectedObservations.old.source.paid.sourceSha = paidOldSha;
        value.protectedObservations.old.runtime.paid.sourceSha = paidOldSha;
        expect(() => createProtectedPacket(value)).not.toThrow();
    });

    it('rejects every old workload/build alias reused by the desired build or workload set', () => {
        for (const slot of SLOTS) {
            const value = packet() as any;
            value.desiredManifest.build = value.oldManifest.roleSlots[slot];
            expect(() => validateManifestComparison(value.oldManifest, value.desiredManifest)).toThrow('IDENTITY_CONFLICT');
        }
        const oldBuildMoved = packet() as any;
        oldBuildMoved.desiredManifest.roleSlots[SLOTS[0]] = oldBuildMoved.oldManifest.build;
        expect(() => validateManifestComparison(oldBuildMoved.oldManifest, oldBuildMoved.desiredManifest)).toThrow('IDENTITY_CONFLICT');
    });

    it('binds protected execution/observation contracts and probe status to the packet digests', () => {
        const runtimeMutation = packet() as any;
        runtimeMutation.protectedInputs.desired.runtime.preflight.environment.NODE_ENV = 'test';
        expect(() => validateEpochPacket(runtimeMutation)).toThrow(EpochError);

        const observationMutation = packet() as any;
        observationMutation.protectedObservations.desired.zeroWorkSources.providerLedger.lookbackMs = 0;
        expect(() => validateEpochPacket(observationMutation)).toThrow(EpochError);

        const statusMutation = packet() as any;
        statusMutation.probe.expectedStatuses.preflight = 403;
        expect(() => validateEpochPacket(statusMutation)).toThrow('PROBE_FAILED');

        const codeMutation = packet() as any;
        codeMutation.probe.expectedCodes.paid = 'UNEXPECTED';
        expect(() => validateEpochPacket(codeMutation)).toThrow('PROBE_FAILED');

        const iamMutation = packet() as any;
        iamMutation.protectedInputs.desired.iam.paid.run.bindings.push({
            role: 'roles/run.invoker', member: 'allUsers', condition: null,
        });
        expect(() => validateEpochPacket(iamMutation)).toThrow('RESOURCE_INVALID');
    });

    it('rejects semantically invalid candidates even when their fresh digests are rebuilt', () => {
        const badRole = packet() as any;
        badRole.protectedInputs.desired.iam.paid.run.bindings[0].role = 'roles/owner';
        badRole.protectedObservations.desired.iam.paid.run.bindings[0].role = 'roles/owner';
        expect(() => createProtectedPacket(badRole)).toThrow(EpochError);

        const badSource = packet() as any;
        badSource.protectedInputs.desired.runtime.preflight.sourceSha = 'c'.repeat(40);
        badSource.protectedObservations.desired.runtime.preflight.sourceSha = 'c'.repeat(40);
        expect(() => createProtectedPacket(badSource)).toThrow(EpochError);

        const badGate = packet() as any;
        badGate.protectedInputs.desired.runtime.preflight.providerAdmissionEnabled = false;
        badGate.protectedInputs.desired.runtime.preflight.environment.ANALYSIS_PROVIDER_ADMISSION_ENABLED = 'false';
        badGate.protectedObservations.desired.runtime.preflight.providerAdmissionEnabled = false;
        expect(() => createProtectedPacket(badGate)).toThrow(EpochError);

        const badResource = packet() as any;
        badResource.desiredManifest.queues.preflight.resource = 'projects/example-project/locations/asia-northeast3/queues/unrelated';
        expect(() => createProtectedPacket(badResource)).toThrow(EpochError);
    });

    it('rejects auth-graph, build, runtime, secret, and capacity setting drift with copied targets', () => {
        const wrongInvoker = packet() as any;
        const wrongInvokerGrant = {
            role: 'roles/run.invoker',
            member: `serviceAccount:${desiredIdentity('paid.runtime')}`,
            condition: null,
        };
        wrongInvoker.protectedInputs.desired.iam.preflight.run.bindings.push(wrongInvokerGrant);
        wrongInvoker.protectedObservations.desired.iam.preflight.run.bindings.push(wrongInvokerGrant);
        expect(() => createProtectedPacket(wrongInvoker)).toThrow('RESOURCE_INVALID');

        const arbitraryAgent = packet() as any;
        const agentGrant = {
            role: 'roles/iam.serviceAccountUser',
            member: 'serviceAccount:service-999999999999@gcp-sa-cloudtasks.iam.gserviceaccount.com',
            condition: null,
        };
        arbitraryAgent.protectedInputs.desired.iam.preflight.taskCaller.bindings.push(agentGrant);
        arbitraryAgent.protectedObservations.desired.iam.preflight.taskCaller.bindings.push(agentGrant);
        expect(() => createProtectedPacket(arbitraryAgent)).toThrow('RESOURCE_INVALID');

        const wrongBuildSource = packet() as any;
        wrongBuildSource.protectedInputs.desired.build.sourceSha = 'c'.repeat(40);
        wrongBuildSource.protectedObservations.desired.source.preflight.sourceSha = 'c'.repeat(40);
        expect(() => createProtectedPacket(wrongBuildSource)).toThrow('SOURCE_INVALID');

        const trafficEnabled = packet() as any;
        trafficEnabled.protectedInputs.desired.runtime.preflight.noTraffic = false;
        trafficEnabled.protectedObservations.desired.runtime.preflight.noTraffic = false;
        expect(() => createProtectedPacket(trafficEnabled)).toThrow('SOURCE_INVALID');

        const mutableSecret = packet() as any;
        mutableSecret.protectedInputs.desired.runtime.preflight.secretReferences.ANALYSIS_SECRET = 'secret:latest';
        mutableSecret.protectedObservations.desired.runtime.preflight.secretReferences.ANALYSIS_SECRET = 'secret:latest';
        expect(() => createProtectedPacket(mutableSecret)).toThrow('SOURCE_INVALID');

        const wrongCapacity = packet() as any;
        wrongCapacity.protectedInputs.desired.runtime.preflight.settings.maxInstances = 99;
        wrongCapacity.protectedObservations.desired.runtime.preflight.settings.maxInstances = 99;
        expect(() => createProtectedPacket(wrongCapacity)).toThrow('SOURCE_INVALID');
    });

    it('rejects a coherently copied expanded desired contract and disabled required task gate', () => {
        const value = packet() as any;
        const desiredRuntime = value.protectedInputs.desired.runtime.preflight;
        desiredRuntime.environment.ANALYSIS_CAPACITY_STAGE = 'expanded';
        desiredRuntime.environment.ANALYSIS_CAPACITY_EXPANSION_CANARY = 'true';
        desiredRuntime.environment.PREFLIGHT_TASKS_ENABLED = 'false';
        desiredRuntime.settings.maxInstances = 64;
        value.protectedObservations.desired.runtime.preflight = JSON.parse(JSON.stringify(desiredRuntime));
        value.desiredManifest.source.preflight.desiredRuntimeEnvironment = JSON.parse(JSON.stringify(desiredRuntime.environment));
        value.desiredManifest.source.preflight.desiredRuntimeSettings = { ...desiredRuntime.settings };
        value.desiredManifest.source.preflight.desiredRuntimeDigest = canonicalDigest(desiredRuntime);
        value.protectedObservations.desired.source.preflight.desiredRuntimeDigest = value.desiredManifest.source.preflight.desiredRuntimeDigest;
        expect(() => createProtectedPacket(value)).toThrow('SOURCE_INVALID');
    });

    it('preserves unrelated old IAM policy bindings and rejects unapproved additions', () => {
        const preserved = packet() as any;
        const unrelated = { role: 'roles/logging.viewer', member: 'user:operator@example.test', condition: null };
        preserved.protectedInputs.old.iam.preflight.run.bindings.push(unrelated);
        preserved.protectedInputs.desired.iam.preflight.run.bindings.push(unrelated);
        preserved.protectedInputs.desired.iam.preflight.run.previous.bindings.push(unrelated);
        preserved.protectedInputs.old.iam.preflight.maintenance.bindings.push(unrelated);
        preserved.protectedInputs.desired.iam.preflight.maintenance.bindings.push(unrelated);
        preserved.protectedInputs.desired.iam.preflight.maintenance.previous.bindings.push(unrelated);
        preserved.protectedObservations.old.iam = JSON.parse(JSON.stringify(preserved.protectedInputs.old.iam));
        preserved.protectedObservations.desired.iam = JSON.parse(JSON.stringify(preserved.protectedInputs.desired.iam));
        expect(() => createProtectedPacket(preserved)).not.toThrow();

        const dropped = packet() as any;
        dropped.protectedInputs.old.iam.preflight.run.bindings.push(unrelated);
        expect(() => createProtectedPacket(dropped)).toThrow('RESOURCE_INVALID');

        const inventedMaintenanceGrant = packet() as any;
        inventedMaintenanceGrant.protectedInputs.desired.iam.preflight.maintenance.bindings.push({
            role: 'roles/iam.serviceAccountTokenCreator',
            member: `serviceAccount:${oldIdentity('preflight.maintenance')}`,
            condition: null,
        });
        expect(() => createProtectedPacket(inventedMaintenanceGrant)).toThrow('RESOURCE_INVALID');
    });

    it('rejects malformed, cross-project, wildcard, and user-managed-key identities', () => {
        for (const bad of [
            '*@example-project.iam.gserviceaccount.com',
            'not-an-email',
            'user@example.com',
            'worker@example-other.iam.gserviceaccount.com',
            'worker@example-project.iam.gserviceaccount.com/keys/key',
        ]) {
            const value = packet() as any;
            value.desiredManifest.roleSlots[SLOTS[0]] = identity(bad);
            expect(() => validateEpochPacket(value)).toThrow(EpochError);
        }
    });

    it('issues an opaque capability bound to epoch, packet digest, role set, and namespace', () => {
        const value = packet() as any;
        const capability = issueCoordinatorCapability(value, 'owner-digest');
        expect(() => validateEpochPacket(value, capability)).not.toThrow();
        expect(() => validateEpochPacket(value, { ...capability })).toThrow('CAPABILITY_INVALID');
        const altered = { ...value, desiredManifestDigest: 'f'.repeat(64) };
        expect(() => validateEpochPacket(altered, capability)).toThrow('CAPABILITY_BINDING_MISMATCH');
        expect(() => issueCoordinatorCapability(value, 'owner-digest', 'other-lock')).toThrow('LOCK_NAMESPACE_MISMATCH');
    });

    it('loads only from an inherited descriptor and rejects an ordinary path descriptor', () => {
        expect(() => loadProtectedPacket({ path: '/tmp/packet.json' } as never)).toThrow('PROTECTED_INPUT_UNAVAILABLE');
    });

    it('bounds inherited descriptor reads and rejects decoded duplicate object keys', () => {
        const directory = mkdtempSync(join(tmpdir(), 'epoch-packet-'));
        const duplicatePath = join(directory, 'duplicate.json');
        writeFileSync(duplicatePath, '{"epochId":"epoch-fixture","\\u0065pochId":"other"}', { mode: 0o600 });
        const duplicateFd = openSync(duplicatePath, 'r');
        try {
            expect(() => loadProtectedPacket({ fd: duplicateFd })).toThrow('INVALID_PACKET');
        } finally {
            closeSync(duplicateFd);
        }

        const oversizedPath = join(directory, 'oversized.json');
        writeFileSync(oversizedPath, '{"padding":"' + 'x'.repeat(128) + '"}', { mode: 0o600 });
        const oversizedFd = openSync(oversizedPath, 'r');
        try {
            expect(() => loadProtectedPacket({ fd: oversizedFd, maxBytes: 16 })).toThrow('PROTECTED_INPUT_UNAVAILABLE');
        } finally {
            closeSync(oversizedFd);
        }

        const publicPath = join(directory, 'public.json');
        writeFileSync(publicPath, '{}', { mode: 0o644 });
        chmodSync(publicPath, 0o644);
        const publicFd = openSync(publicPath, 'r');
        try {
            expect(() => loadProtectedPacket({ fd: publicFd })).toThrow('PROTECTED_INPUT_UNAVAILABLE');
        } finally {
            closeSync(publicFd);
            rmSync(directory, { recursive: true, force: true });
        }
    });
});
