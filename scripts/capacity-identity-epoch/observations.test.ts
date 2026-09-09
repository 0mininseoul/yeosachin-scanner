import { describe, expect, it } from 'vitest';
import {
    validateIamObservation,
    validateQueueObservation,
    validateReadinessObservation,
    validateRetentionObservation,
    validateRuntimeObservation,
    validateSchedulerObservation,
    validateSourceObservation,
    validateZeroWorkObservation,
} from './observations';
import { EpochError, canonicalDigest, canonicalRuntimeInputDigest, type ProtectedQueueInput, type ProtectedRuntimeInput, type ProtectedSchedulerInput, type ProtectedRetentionInput } from './contracts';

const project = 'example-project';
const identity = { identity: 'preflight-runtime@example-project.iam.gserviceaccount.com', project };
const digest = (value: unknown) => canonicalDigest(value);
const runtime: ProtectedRuntimeInput = {
    role: 'preflight', service: 'preflight-worker', project, location: 'asia-northeast3', identity,
    sourceSha: 'b'.repeat(40), environment: { ANALYSIS_PROVIDER_ADMISSION_ENABLED: 'true', ROLE: 'preflight' },
    secretReferences: { API: 'secret:version' },
    settings: { cpu: '2', memory: '2Gi', concurrency: 1, timeoutSeconds: 600, maxInstances: 4 },
    target: { url: 'https://preflight.example.com/api/worker', audience: 'https://preflight.example.com' },
    noTraffic: true, providerAdmissionEnabled: true,
};
const runtimeDigest = canonicalRuntimeInputDigest(runtime);
const queue: ProtectedQueueInput = {
    resource: `projects/${project}/locations/asia-northeast3/queues/preflight`, project, location: 'asia-northeast3',
    target: { url: runtime.target.url, audience: runtime.target.audience, callerIdentity: identity },
    configuration: { maxConcurrentDispatches: 2 },
};
const observedQueueTarget = { ...queue.target, uriOverride: null, wireConfigurationDigest: digest('queue-wire') };
const scheduler: ProtectedSchedulerInput = {
    resource: `projects/${project}/locations/asia-northeast3/jobs/preflight-recovery`, project, location: 'asia-northeast3',
    target: { uri: 'https://preflight.example.com/api/recover', audience: runtime.target.audience, identity },
    configuration: { schedule: '* * * * *', method: 'POST' }, state: 'PAUSED', pauseEpochMs: 1_000, lastAttemptMs: null,
};
const retention: ProtectedRetentionInput = {
    resource: `projects/${project}/locations/asia-northeast3/jobs/retention`, project, location: 'asia-northeast3',
    enabled: true, configuration: { enabled: true },
};

describe('independent epoch observations', () => {
    it('validates old source, complete runtime and exact readiness facts', () => {
        expect(() => validateSourceObservation({
            role: 'preflight', sourceSha: 'a'.repeat(40), revision: 'preflight-old', metadataDigest: digest('metadata'),
        }, { role: 'preflight', oldSha: 'a'.repeat(40), oldRevision: 'preflight-old', desiredSha: 'b'.repeat(40) }, 'old')).not.toThrow();
        expect(() => validateSourceObservation({
            role: 'preflight', sourceSha: 'b'.repeat(40), revision: 'preflight-staged', metadataDigest: digest('metadata'),
        }, { role: 'preflight', oldSha: 'a'.repeat(40), oldRevision: 'preflight-old', desiredSha: 'b'.repeat(40), desiredRevisionId: 'preflight-staged' }, 'desired')).not.toThrow();
        expect(() => validateSourceObservation({
            role: 'preflight', sourceSha: 'b'.repeat(40), revision: 'latest', metadataDigest: digest('metadata'),
        }, { role: 'preflight', oldSha: 'a'.repeat(40), oldRevision: 'preflight-old', desiredSha: 'b'.repeat(40) }, 'desired')).toThrow('SOURCE_INVALID');
        expect(() => validateSourceObservation({
            role: 'paid', sourceSha: 'b'.repeat(40), revision: 'paid-staged', metadataDigest: digest('metadata'),
        }, { role: 'preflight', oldSha: 'a'.repeat(40), oldRevision: 'preflight-old', desiredSha: 'b'.repeat(40), desiredRevisionId: 'paid-staged' }, 'desired')).toThrow('SOURCE_INVALID');
        expect(() => validateRuntimeObservation({
            ...runtime, mode: 'STAGED', revision: 'preflight-staged', generation: '17', resourceVersion: 'resource-version', runtimeDigest,
            buildDigest: digest('build'), traffic: {},
        }, runtime, { mode: 'STAGED', revision: 'preflight-staged', runtimeDigest, buildDigest: digest('build') })).not.toThrow();
        expect(() => validateReadinessObservation({
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40),
            legacyTargetResource: 'legacy-target', preflightFingerprint: digest('preflight'), paidFingerprint: digest('paid'),
            analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false, ready: true,
        }, {
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40), legacyTargetResource: 'legacy-target',
            preflightFingerprint: digest('preflight'), paidFingerprint: digest('paid'),
            analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false,
        })).not.toThrow();
        expect(() => validateReadinessObservation({
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40),
            legacyTargetResource: 'legacy-target', preflightFingerprint: digest('preflight'), paidFingerprint: digest('paid'),
            analysisV2AdmissionEnabled: true, earlybirdWebhookAutoAdmissionEnabled: false, ready: false,
        }, {
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40), legacyTargetResource: 'legacy-target',
            preflightFingerprint: digest('preflight'), paidFingerprint: digest('paid'),
            analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false,
        })).toThrow('READINESS_INVALID');
        expect(() => validateReadinessObservation({
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40),
            legacyTargetResource: 'legacy-target', preflightFingerprint: digest('preflight'), paidFingerprint: digest('paid'),
            analysisV2AdmissionEnabled: true, earlybirdWebhookAutoAdmissionEnabled: true, ready: true,
        }, {
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40), legacyTargetResource: 'legacy-target',
            preflightFingerprint: digest('preflight'), paidFingerprint: digest('paid'),
            analysisV2AdmissionEnabled: true, earlybirdWebhookAutoAdmissionEnabled: true,
        })).not.toThrow();
    });

    it('rejects runtime drift, mutable traffic, and wrong private provider gate', () => {
        const observed = {
            ...runtime, mode: 'STAGED', revision: 'preflight-staged', generation: '17', resourceVersion: 'resource-version', runtimeDigest,
            buildDigest: digest('build'), traffic: {},
        };
        const staged = { mode: 'STAGED' as const, revision: 'preflight-staged', runtimeDigest, buildDigest: digest('build') };
        expect(() => validateRuntimeObservation(observed, runtime, undefined as never)).toThrow('RUNTIME_MISMATCH');
        expect(() => validateRuntimeObservation(observed, runtime, { mode: 'PROMOTED' } as never)).toThrow('RUNTIME_MISMATCH');
        expect(() => validateRuntimeObservation({ ...observed, environment: { ...runtime.environment, DRIFT: '1' } }, runtime, staged)).toThrow('RUNTIME_MISMATCH');
        expect(() => validateRuntimeObservation({ ...observed, traffic: { latest: 100 } }, runtime, staged)).toThrow('RUNTIME_MISMATCH');
        expect(() => validateRuntimeObservation({ ...observed, providerAdmissionEnabled: false }, runtime, staged)).toThrow('RUNTIME_MISMATCH');
        const promoted = { mode: 'PROMOTED' as const, revision: 'preflight-staged', runtimeDigest, buildDigest: digest('build') };
        expect(() => validateRuntimeObservation({ ...observed, mode: 'PROMOTED', noTraffic: false, traffic: { 'preflight-staged': 100 } }, runtime, promoted)).not.toThrow();
        expect(() => validateRuntimeObservation({ ...observed, mode: 'PROMOTED', noTraffic: false, traffic: { latest: 100 } }, runtime, promoted)).toThrow('RUNTIME_MISMATCH');
        expect(() => validateRuntimeObservation({ ...observed, mode: 'PROMOTED', noTraffic: false, traffic: { 'preflight-staged': 100 } }, runtime, { ...promoted, runtimeDigest: digest('other') })).toThrow('RUNTIME_MISMATCH');
        expect(() => validateRuntimeObservation({ ...observed, mode: 'PROMOTED', noTraffic: false, traffic: { 'preflight-staged': 100 } }, runtime, { mode: 'PROMOTED', revision: 'preflight-staged', runtimeDigest, buildDigest: digest('build') })).not.toThrow();
    });

    it('requires a complete paused empty queue and an aged scheduler pause', () => {
        expect(() => validateQueueObservation({
            role: 'preflight', ...queue, target: observedQueueTarget, httpTargetPresent: true, configurationDigest: digest(queue.configuration), state: 'PAUSED', tasks: [], complete: true,
        }, queue, digest(queue.configuration), 'preflight')).not.toThrow();
        expect(() => validateQueueObservation({
            role: 'paid', ...queue, target: { ...observedQueueTarget, url: 'https://unrelated.example.com/worker' }, httpTargetPresent: true,
            configurationDigest: digest(queue.configuration), state: 'PAUSED', tasks: [], complete: true,
        }, queue, digest(queue.configuration), 'preflight')).toThrow('OBSERVATION_INVALID');
        expect(() => validateQueueObservation({
            role: 'preflight', ...queue, target: observedQueueTarget, httpTargetPresent: true, configurationDigest: digest(queue.configuration), state: 'PAUSED', tasks: [], complete: true,
        }, queue, digest(queue.configuration), undefined as never)).toThrow('OBSERVATION_INVALID');
        expect(() => validateQueueObservation({
            role: 'preflight', ...queue, target: observedQueueTarget, httpTargetPresent: true, configurationDigest: digest(queue.configuration), state: 'PAUSED',
            tasks: [{ name: 'task', payloadDigest: digest('task'), createTime: new Date(1_000).toISOString() }], complete: true,
        }, queue, digest(queue.configuration), 'preflight')).toThrow('QUEUE_NOT_EMPTY');
        expect(() => validateQueueObservation({
            role: 'preflight', ...queue, target: observedQueueTarget, httpTargetPresent: true, configurationDigest: digest(queue.configuration), state: 'PAUSED', tasks: [], complete: false,
        }, queue, digest(queue.configuration), 'preflight')).toThrow('PAGINATION_INCOMPLETE');
        expect(() => validateSchedulerObservation({
            role: 'preflight', ...scheduler, configurationDigest: digest(scheduler.configuration), pauseEpochMs: 15_000, nowMs: 20_000,
        }, scheduler, 20_000, 5_000, 5_000, 'preflight')).toThrow('SCHEDULER_NOT_QUIESCENT');
        expect(() => validateSchedulerObservation({
            role: 'preflight', ...scheduler, configurationDigest: digest(scheduler.configuration), pauseEpochMs: 1_000,
            nowMs: 20_000,
        }, scheduler, 20_000, 5_000, 5_000, 'preflight')).not.toThrow();
        expect(() => validateSchedulerObservation({
            role: 'preflight', ...scheduler, target: { ...scheduler.target, uri: 'https://unrelated.example.com/recovery' },
            configurationDigest: digest(scheduler.configuration), pauseEpochMs: 1_000, nowMs: 20_000,
        }, scheduler, 20_000, 5_000, 5_000, 'preflight')).toThrow('OBSERVATION_INVALID');
    });

    it('binds IAM etag/read-back, retention, and independent zero-work coverage', () => {
        const iam = {
            role: 'preflight' as const, resource: `projects/${project}/locations/asia-northeast3/services/preflight-worker`, project,
            etag: 'Bwfixture', bindings: [{ role: 'roles/run.invoker', member: `serviceAccount:${identity.identity}`, condition: null }],
        };
        expect(() => validateIamObservation(iam, iam)).not.toThrow();
        expect(() => validateIamObservation({ ...iam, etag: '' }, iam)).toThrow('IAM_ETAG_REQUIRED');
        expect(() => validateRetentionObservation({ role: 'retention', ...retention, configurationDigest: digest(retention.configuration) }, retention)).not.toThrow();
        const zeroWork = {
            windowStartMs: 1_000, windowEndMs: 20_000,
            providerLedger: { provenance: 'provider-source', digest: digest('provider'), observedAtMs: 20_000, coveredStartMs: 1_000, coveredEndMs: 20_000, coverageLagMs: 0, freshnessLagMs: 0, complete: true, eventCount: 0, deltaCount: 0 },
            billingLedger: { provenance: 'billing-source', digest: digest('billing'), observedAtMs: 20_000, coveredStartMs: 1_000, coveredEndMs: 20_000, coverageLagMs: 0, freshnessLagMs: 0, complete: true, eventCount: 0, deltaCount: 0 },
            taskAudit: { provenance: 'task-source', digest: digest('tasks'), observedAtMs: 20_000, coveredStartMs: 1_000, coveredEndMs: 20_000, coverageLagMs: 0, freshnessLagMs: 0, complete: true, eventCount: 0, deltaCount: 0 },
            receiverLog: { provenance: 'receiver-source', digest: digest('logs'), observedAtMs: 20_000, coveredStartMs: 1_000, coveredEndMs: 20_000, coverageLagMs: 0, freshnessLagMs: 0, complete: true, eventCount: 0, deltaCount: 0 },
        };
        const window = { windowStartMs: 1_000, windowEndMs: 20_000, provenance: {
            providerLedger: 'provider-source', billingLedger: 'billing-source', taskAudit: 'task-source', receiverLog: 'receiver-source',
        } } as const;
        expect(() => validateZeroWorkObservation(zeroWork, 20_000, undefined as never)).toThrow('ZERO_WORK_INCOMPLETE');
        expect(() => validateZeroWorkObservation(zeroWork, 20_000, window)).not.toThrow();
        // A collector can finish after the source timestamp was captured. Its
        // reported lag must not predict the coordinator's later millisecond
        // clock; freshness is independently bounded from observedAtMs at the
        // trusted validation boundary.
        expect(() => validateZeroWorkObservation(zeroWork, 20_123, window)).not.toThrow();
        expect(() => validateZeroWorkObservation({
            ...zeroWork,
            providerLedger: { ...zeroWork.providerLedger, observedAtMs: 20_000, freshnessLagMs: 0 },
        }, 320_001, window)).toThrow('ZERO_WORK_INCOMPLETE');
        expect(() => validateZeroWorkObservation({ ...zeroWork, receiverLog: { ...zeroWork.receiverLog, complete: false } }, 20_000, window)).toThrow('ZERO_WORK_INCOMPLETE');
        expect(() => validateZeroWorkObservation({ ...zeroWork, windowEndMs: 30_000 }, 20_000, window)).toThrow(EpochError);
        expect(() => validateZeroWorkObservation({ ...zeroWork, taskAudit: { ...zeroWork.taskAudit, deltaCount: 1 } }, 20_000, window)).toThrow('ZERO_WORK_INCOMPLETE');
        expect(() => validateZeroWorkObservation({ ...zeroWork, receiverLog: { ...zeroWork.receiverLog, coveredEndMs: 19_000, coverageLagMs: 1_000 } }, 20_000, window)).toThrow('ZERO_WORK_INCOMPLETE');
        expect(() => validateZeroWorkObservation({ ...zeroWork, windowStartMs: 0, windowEndMs: 0 }, 20_000, { ...window, windowStartMs: 0, windowEndMs: 0 })).toThrow('ZERO_WORK_INCOMPLETE');
        expect(() => validateZeroWorkObservation({ ...zeroWork, providerLedger: { ...zeroWork.providerLedger, provenance: 'unrelated' } }, 20_000, window)).toThrow('ZERO_WORK_INCOMPLETE');
    });
});
