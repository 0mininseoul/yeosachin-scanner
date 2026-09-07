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
import { EpochError } from './contracts';
import type { CapacityManifest, ProtectedOldObservations, ProtectedObservationTargets, ProtectedPlatformInputs } from './contracts';

const PROJECT = 'example-project';
const oldIdentity = (slot: string) => `${slot.replaceAll('.', '-')}-old@example-project.iam.gserviceaccount.com`;
const desiredIdentity = (slot: string) => `${slot.replaceAll('.', '-')}-desired@example-project.iam.gserviceaccount.com`;

function identity(value: string) {
    return { identity: value, project: PROJECT };
}

function manifest(kind: 'old' | 'desired'): CapacityManifest {
    const roleSlots = Object.fromEntries(SLOTS.map(slot => [
        slot,
        identity(kind === 'old' ? oldIdentity(slot) : desiredIdentity(slot)),
    ]));
    const revision = (role: 'preflight' | 'paid') => ({
        oldSha: 'a'.repeat(40),
        oldRevision: `${role}-old-revision`,
        desiredSha: 'b'.repeat(40),
        desiredBuildDigest: 'c'.repeat(64),
        desiredRuntimeDigest: 'd'.repeat(64),
        revisionPlan: { prefix: `${role}-epoch`, suffix: 'fixture' },
    });
    const producer = (role: 'preflight' | 'paid') => ({
        sourceSha: 'b'.repeat(40),
        fingerprintVersion: `${role}-producer-config-v1`,
        fingerprint: role === 'preflight' ? 'e'.repeat(64) : 'f'.repeat(64),
        admissionEnabled: false,
    });
    const queue = (role: 'preflight' | 'paid') => ({
        resource: `${role}-queue`, project: PROJECT, location: 'asia-northeast3',
        configDigest: '1'.repeat(64), state: 'PAUSED', empty: true, tasksDigest: '2'.repeat(64),
    });
    const scheduler = (role: 'preflight' | 'paid') => ({
        resource: `${role}-scheduler`, project: PROJECT, location: 'asia-northeast3',
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
        retention: { resource: 'retention-scheduler', project: PROJECT, location: 'asia-northeast3', enabled: true, configDigest: '5'.repeat(64) },
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
    const sourceSha = 'a'.repeat(40);
    const roleInput = (role: 'preflight' | 'paid') => ({
        role,
        service: `${role}-worker`, project: PROJECT, location: 'asia-northeast3',
        identity: identity(`${role}.runtime-${suffix}`.replace('.', '-') + '@example-project.iam.gserviceaccount.com'),
        sourceSha,
        environment: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true', ANALYSIS_WORKLOAD_ROLE: role },
        secretReferences: { ANALYSIS_SECRET: 'secret:7' },
        settings: { cpu: '2', memory: '2Gi', concurrency: 1, timeoutSeconds: 600, maxInstances: role === 'preflight' ? 32 : 8 },
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
    const iamInput = (role: 'preflight' | 'paid') => ({
        resource: `projects/${PROJECT}/locations/asia-northeast3/services/${role}-worker`,
        project: PROJECT,
        etag: 'Bwfixture',
        bindings: [{ role: 'roles/run.invoker', member: `serviceAccount:${role}-task-caller-${suffix}@example-project.iam.gserviceaccount.com`, condition: null }],
    });
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
        iamMutation.protectedInputs.desired.iam.paid.bindings.push({
            role: 'roles/run.invoker', member: 'allUsers', condition: null,
        });
        expect(() => validateEpochPacket(iamMutation)).toThrow('RESOURCE_INVALID');
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
