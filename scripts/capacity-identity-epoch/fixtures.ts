import { canonicalDigest, type CapacityManifest, type ProtectedOldObservations, type ProtectedObservationTargets, type ProtectedPlatformInputs, type Role } from './contracts';
import { ROLES, SLOTS, createProtectedPacket } from './packet';

/** Provider-free, synthetic packet fixture shared by coordinator/integration tests. */
export const FIXTURE_PROJECT = 'example-project';

function identity(value: string) {
    return { identity: value, project: FIXTURE_PROJECT };
}

function runtimeSettings(role: Role) {
    return { cpu: '2', memory: '2Gi', concurrency: 1, timeoutSeconds: 600, maxInstances: role === 'preflight' ? 32 : 8 };
}

function runtimeSecretReferences(role: Role): Record<string, string> {
    const slots = role === 'preflight'
        ? ['primary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary', 'octonary', 'nonary', 'tenth']
        : ['primary', 'secondary', 'tertiary', 'quaternary', 'quinary', 'senary', 'septenary', 'octonary', 'nonary', 'tenth'];
    return Object.fromEntries([
        ...slots.map(slot => [`APIFY_${slot.toUpperCase()}_API_TOKEN`, 'fixture-secret:7']),
        ['SUPABASE_SERVICE_ROLE_KEY', 'fixture-secret:7'],
        ['IMAGE_PROXY_SIGNING_SECRET', 'fixture-secret:7'],
        ['ANALYSIS_V2_PREFLIGHT_IDENTITY_HMAC_SECRET', 'fixture-secret:7'],
        ['ANALYSIS_V2_GENDER_ROUTING_HMAC_SECRET', 'fixture-secret:7'],
    ]);
}

function runtimeEnvironment(role: Role, suffix: 'old' | 'desired'): Record<string, string> {
    const prefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2_TASKS';
    const maintenancePrefix = role === 'preflight' ? 'PREFLIGHT_TASKS' : 'ANALYSIS_V2';
    const targetOrigin = `https://${role}.example.com`;
    const taskCallerIdentity = `${role}-task-caller-${suffix}@example-project.iam.gserviceaccount.com`;
    const maintenanceIdentity = `${role}-maintenance-${suffix}@example-project.iam.gserviceaccount.com`;
    return {
        [`${prefix}_PROJECT`]: FIXTURE_PROJECT,
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
        ...(role === 'preflight' ? { PREFLIGHT_APIFY_API_TOKEN_SLOTS: 'primary,tertiary,quaternary,quinary,senary,septenary,octonary,nonary,tenth' } : {}),
    };
}

function manifest(kind: 'old' | 'desired'): CapacityManifest {
    const suffix = kind === 'old' ? 'old' : 'desired';
    const roleSlots = Object.fromEntries(SLOTS.map(slot => [slot, identity(`${slot.replaceAll('.', '-')}-${suffix}@example-project.iam.gserviceaccount.com`)]));
    const buildInput = {
        identity: identity(kind === 'old' ? 'old-build@example-project.iam.gserviceaccount.com' : 'new-build@example-project.iam.gserviceaccount.com'),
        sourceSha: kind === 'old' ? 'a'.repeat(40) : 'b'.repeat(40), sourceContext: 'fixture-source-context', buildArguments: { NODE_ENV: 'production' },
    };
    const runtimeTarget = (role: Role) => ({
        role, service: `${role}-worker`, project: FIXTURE_PROJECT, location: 'asia-northeast3',
        identity: identity(`${role}-runtime-desired@example-project.iam.gserviceaccount.com`), sourceSha: 'b'.repeat(40),
        environment: runtimeEnvironment(role, 'desired'), secretReferences: runtimeSecretReferences(role), settings: runtimeSettings(role),
        target: { url: `https://${role}.example.com/api/analysis/${role}/worker`, audience: `https://${role}.example.com` }, noTraffic: true, providerAdmissionEnabled: true,
    });
    const source = (role: Role) => ({
        oldSha: 'a'.repeat(40), oldRevision: `${role}-old-revision`, desiredSha: 'b'.repeat(40),
        desiredBuildDigest: canonicalDigest(buildInput), desiredRuntimeDigest: canonicalDigest(runtimeTarget(role)),
        desiredRuntimeEnvironment: runtimeEnvironment(role, 'desired'), desiredRuntimeSettings: runtimeSettings(role), revisionPlan: { prefix: `${role}-epoch`, suffix: 'fixture' },
    });
    const producer = (role: Role) => ({ sourceSha: 'b'.repeat(40), fingerprintVersion: `${role}-producer-config-v1`, fingerprint: role === 'preflight' ? 'e'.repeat(64) : 'f'.repeat(64), admissionEnabled: false });
    const queueTarget = (role: Role) => ({ url: `https://${role}.example.com/api/analysis/${role}/worker`, audience: `https://${role}.example.com`, callerIdentity: identity(`${role}-task-caller-${suffix}@example-project.iam.gserviceaccount.com`) });
    const schedulerTarget = (role: Role) => ({ uri: `https://${role}.example.com/api/analysis/${role}/recover`, audience: `https://${role}.example.com`, identity: identity(`${role}-maintenance-${suffix}@example-project.iam.gserviceaccount.com`) });
    const queue = (role: Role) => ({ resource: `projects/${FIXTURE_PROJECT}/locations/asia-northeast3/queues/${role}`, project: FIXTURE_PROJECT, location: 'asia-northeast3', targetDigest: canonicalDigest(queueTarget(role)), configDigest: '1'.repeat(64), state: 'PAUSED' as const, empty: true, tasksDigest: '2'.repeat(64) });
    const scheduler = (role: Role) => ({ resource: `projects/${FIXTURE_PROJECT}/locations/asia-northeast3/jobs/${role}-recovery`, project: FIXTURE_PROJECT, location: 'asia-northeast3', targetDigest: canonicalDigest(schedulerTarget(role)), configDigest: '3'.repeat(64), state: 'PAUSED' as const, pauseEpochMs: 1, lastAttemptMs: null });
    const iam = (role: Role) => ({ policyDigest: '4'.repeat(64), desiredBindings: [`${role}:desired`], retiredBindings: [] });
    return {
        roleSlots,
        build: identity(kind === 'old' ? 'old-build@example-project.iam.gserviceaccount.com' : 'new-build@example-project.iam.gserviceaccount.com'),
        source: { preflight: source('preflight'), paid: source('paid') }, producer: { preflight: producer('preflight'), paid: producer('paid') },
        queues: { preflight: queue('preflight'), paid: queue('paid') }, recoverySchedulers: { preflight: scheduler('preflight'), paid: scheduler('paid') },
        retention: { resource: `projects/${FIXTURE_PROJECT}/locations/asia-northeast3/jobs/retention`, project: FIXTURE_PROJECT, location: 'asia-northeast3', enabled: true, configDigest: '5'.repeat(64) },
        iam: { preflight: iam('preflight'), paid: iam('paid') },
        readiness: { schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40), legacyTargetResource: 'fixture-target', preflightFingerprint: 'e'.repeat(64), paidFingerprint: 'f'.repeat(64), analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false },
    } as unknown as CapacityManifest;
}

function platformInputs(kind: 'old' | 'desired'): ProtectedPlatformInputs {
    const suffix = kind === 'old' ? 'old' : 'desired';
    const sourceSha = kind === 'old' ? 'a'.repeat(40) : 'b'.repeat(40);
    const roleInput = (role: Role) => ({ role, service: `${role}-worker`, project: FIXTURE_PROJECT, location: 'asia-northeast3', identity: identity(`${role}-runtime-${suffix}@example-project.iam.gserviceaccount.com`), sourceSha, environment: runtimeEnvironment(role, suffix), secretReferences: runtimeSecretReferences(role), settings: runtimeSettings(role), target: { url: `https://${role}.example.com/api/analysis/${role}/worker`, audience: `https://${role}.example.com` }, noTraffic: true, providerAdmissionEnabled: true });
    const queueInput = (role: Role) => ({ resource: `projects/${FIXTURE_PROJECT}/locations/asia-northeast3/queues/${role}`, project: FIXTURE_PROJECT, location: 'asia-northeast3', target: { url: `https://${role}.example.com/api/analysis/${role}/worker`, audience: `https://${role}.example.com`, callerIdentity: identity(`${role}-task-caller-${suffix}@example-project.iam.gserviceaccount.com`) }, configuration: { maxDispatchesPerSecond: 2, maxConcurrentDispatches: 2 } });
    const schedulerInput = (role: Role) => ({ resource: `projects/${FIXTURE_PROJECT}/locations/asia-northeast3/jobs/${role}-recovery`, project: FIXTURE_PROJECT, location: 'asia-northeast3', target: { uri: `https://${role}.example.com/api/analysis/${role}/recover`, audience: `https://${role}.example.com`, identity: identity(`${role}-maintenance-${suffix}@example-project.iam.gserviceaccount.com`) }, configuration: { schedule: '* * * * *', method: 'POST' }, state: 'PAUSED' as const, pauseEpochMs: 1, lastAttemptMs: null });
    const iamInput = (role: Role) => {
        const oldTask = `${role}-task-caller-old@example-project.iam.gserviceaccount.com`, desiredTask = `${role}-task-caller-desired@example-project.iam.gserviceaccount.com`;
        const oldMaintenance = `${role}-maintenance-old@example-project.iam.gserviceaccount.com`, desiredMaintenance = `${role}-maintenance-desired@example-project.iam.gserviceaccount.com`;
        const oldEnqueuer = `${role}-enqueuer-old@example-project.iam.gserviceaccount.com`, desiredEnqueuer = `${role}-enqueuer-desired@example-project.iam.gserviceaccount.com`;
        const oldRuntime = `${role}-runtime-old@example-project.iam.gserviceaccount.com`, desiredRuntime = `${role}-runtime-desired@example-project.iam.gserviceaccount.com`;
        const old = kind === 'old'; const members = (left: string, right: string) => old ? [left] : [left, right];
        const runResource = `projects/${FIXTURE_PROJECT}/locations/asia-northeast3/services/${role}-worker`, queueResource = `projects/${FIXTURE_PROJECT}/locations/asia-northeast3/queues/${role}`;
        const agent = 'serviceAccount:service-123456789012@gcp-sa-cloudtasks.iam.gserviceaccount.com';
        const runBindings = [...members(oldTask, desiredTask), ...members(oldMaintenance, desiredMaintenance)].map(member => ({ role: 'roles/run.invoker', member: `serviceAccount:${member}`, condition: null }));
        const queueBindings = [...members(oldEnqueuer, desiredEnqueuer).map(member => ({ role: 'roles/cloudtasks.enqueuer', member: `serviceAccount:${member}`, condition: null })), ...members(oldRuntime, desiredRuntime).flatMap(member => [{ role: 'roles/cloudtasks.enqueuer', member: `serviceAccount:${member}`, condition: null }, { role: 'roles/cloudtasks.viewer', member: `serviceAccount:${member}`, condition: null }])];
        const oldTaskBindings = [{ role: 'roles/iam.serviceAccountUser', member: `serviceAccount:${oldEnqueuer}`, condition: null }, { role: 'roles/iam.serviceAccountUser', member: `serviceAccount:${oldRuntime}`, condition: null }, { role: 'roles/iam.serviceAccountUser', member: agent, condition: null }];
        const taskBindings = [...members(oldEnqueuer, desiredEnqueuer), ...members(oldRuntime, desiredRuntime)].map(member => ({ role: 'roles/iam.serviceAccountUser', member: `serviceAccount:${member}`, condition: null })).concat({ role: 'roles/iam.serviceAccountUser', member: agent, condition: null });
        const previous = (resource: string, bindings: readonly { role: string; member: string; condition: null }[]) => old ? null : { resource, project: FIXTURE_PROJECT, etag: 'Bwfixture', bindings };
        return {
            run: { kind: 'run' as const, resource: runResource, project: FIXTURE_PROJECT, etag: 'Bwfixture', bindings: runBindings, previous: previous(runResource, runBindings.filter(binding => binding.member.includes('-old@'))) },
            queue: { kind: 'queue' as const, resource: queueResource, project: FIXTURE_PROJECT, etag: 'Bwfixture', bindings: queueBindings, previous: previous(queueResource, queueBindings.filter(binding => binding.member.includes('-old@'))) },
            taskCaller: { kind: 'taskCaller' as const, resource: `projects/${FIXTURE_PROJECT}/serviceAccounts/${old ? oldTask : desiredTask}`, project: FIXTURE_PROJECT, etag: 'Bwfixture', bindings: taskBindings, previous: previous(`projects/${FIXTURE_PROJECT}/serviceAccounts/${oldTask}`, oldTaskBindings) },
            maintenance: { kind: 'maintenance' as const, resource: runResource, project: FIXTURE_PROJECT, etag: 'Bwfixture', bindings: [...runBindings], previous: previous(runResource, runBindings.filter(binding => binding.member.includes('-old@'))) },
        };
    };
    return {
        build: { identity: identity(kind === 'old' ? 'old-build@example-project.iam.gserviceaccount.com' : 'new-build@example-project.iam.gserviceaccount.com'), sourceSha, sourceContext: 'fixture-source-context', buildArguments: { NODE_ENV: 'production' } },
        runtime: { preflight: roleInput('preflight'), paid: roleInput('paid') }, queues: { preflight: queueInput('preflight'), paid: queueInput('paid') }, schedulers: { preflight: schedulerInput('preflight'), paid: schedulerInput('paid') }, iam: { preflight: iamInput('preflight'), paid: iamInput('paid') },
        retention: { resource: `projects/${FIXTURE_PROJECT}/locations/asia-northeast3/jobs/retention`, project: FIXTURE_PROJECT, location: 'asia-northeast3', enabled: true, configuration: { enabled: true } },
    } as unknown as ProtectedPlatformInputs;
}

function oldObservations(): ProtectedOldObservations {
    const platform = platformInputs('old');
    return {
        source: { preflight: { sourceSha: 'a'.repeat(40), revision: 'preflight-old-revision', metadataDigest: '1'.repeat(64) }, paid: { sourceSha: 'a'.repeat(40), revision: 'paid-old-revision', metadataDigest: '2'.repeat(64) } },
        runtime: { preflight: { sourceSha: 'a'.repeat(40), service: platform.runtime.preflight.service, project: FIXTURE_PROJECT, location: 'asia-northeast3', revision: 'preflight-old-revision', generation: 'generation-preflight', resourceVersion: 'resource-preflight', identity: platform.runtime.preflight.identity, providerAdmissionEnabled: true, noTraffic: true, runtimeDigest: '7'.repeat(64), buildDigest: '8'.repeat(64) }, paid: { sourceSha: 'a'.repeat(40), service: platform.runtime.paid.service, project: FIXTURE_PROJECT, location: 'asia-northeast3', revision: 'paid-old-revision', generation: 'generation-paid', resourceVersion: 'resource-paid', identity: platform.runtime.paid.identity, providerAdmissionEnabled: true, noTraffic: true, runtimeDigest: '9'.repeat(64), buildDigest: 'a'.repeat(64) } },
        queues: { preflight: { resource: platform.queues.preflight.resource, project: FIXTURE_PROJECT, location: 'asia-northeast3', state: 'PAUSED', configuration: platform.queues.preflight.configuration, tasks: [], complete: true }, paid: { resource: platform.queues.paid.resource, project: FIXTURE_PROJECT, location: 'asia-northeast3', state: 'PAUSED', configuration: platform.queues.paid.configuration, tasks: [], complete: true } },
        schedulers: { preflight: { resource: platform.schedulers.preflight.resource, project: FIXTURE_PROJECT, location: 'asia-northeast3', state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null, configuration: platform.schedulers.preflight.configuration }, paid: { resource: platform.schedulers.paid.resource, project: FIXTURE_PROJECT, location: 'asia-northeast3', state: 'PAUSED', pauseEpochMs: 1, lastAttemptMs: null, configuration: platform.schedulers.paid.configuration } },
        iam: platform.iam, retention: platform.retention, readiness: { ...manifest('old').readiness, ready: true },
    } as ProtectedOldObservations;
}

function observationTargets(): ProtectedObservationTargets {
    const platform = platformInputs('desired');
    const desired = manifest('desired');
    return {
        source: { preflight: { sourceSha: 'b'.repeat(40), revisionPlan: desired.source.preflight.revisionPlan, desiredBuildDigest: desired.source.preflight.desiredBuildDigest, desiredRuntimeDigest: desired.source.preflight.desiredRuntimeDigest }, paid: { sourceSha: 'b'.repeat(40), revisionPlan: desired.source.paid.revisionPlan, desiredBuildDigest: desired.source.paid.desiredBuildDigest, desiredRuntimeDigest: desired.source.paid.desiredRuntimeDigest } },
        runtime: platform.runtime, queues: platform.queues, schedulers: platform.schedulers, iam: platform.iam, retention: platform.retention, readiness: desired.readiness,
        zeroWorkSources: { providerLedger: { source: 'fixture-provider-ledger', lookbackMs: 60_000 }, billingLedger: { source: 'fixture-billing-ledger', lookbackMs: 60_000 }, taskAudit: { source: 'fixture-task-audit', lookbackMs: 60_000 }, receiverLog: { source: 'fixture-receiver-log', lookbackMs: 60_000 } },
    } as ProtectedObservationTargets;
}

export function createFixturePacket(): ReturnType<typeof createProtectedPacket> {
    return createProtectedPacket({
        epochId: 'epoch-fixture', lockNamespace: 'fixture-lock', roleSet: [...ROLES], oldManifest: manifest('old'), desiredManifest: manifest('desired'), protectedInputs: { old: platformInputs('old'), desired: platformInputs('desired') },
        activation: { analysisV2AdmissionEnabled: true, earlybirdWebhookAutoAdmissionEnabled: true }, quiescence: { timeoutMs: 60_000, graceMs: 5_000 },
        observationInputs: { sourceDigest: '6'.repeat(64), iamDigest: '7'.repeat(64), queueDigest: '8'.repeat(64), schedulerDigest: '9'.repeat(64), retentionDigest: 'a'.repeat(64), readinessDigest: 'b'.repeat(64), zeroWorkDigest: 'c'.repeat(64) },
        protectedObservations: { old: oldObservations(), desired: observationTargets() }, probe: { bodyDigest: 'd'.repeat(64), expectedStatuses: { preflight: 400, paid: 400 }, expectedCodes: { preflight: 'INVALID_REQUEST', paid: 'INVALID_REQUEST' } },
    });
}
