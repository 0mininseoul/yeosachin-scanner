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
import { EpochError, canonicalDigest, type ProtectedQueueInput, type ProtectedRuntimeInput, type ProtectedSchedulerInput, type ProtectedRetentionInput } from './contracts';

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
const queue: ProtectedQueueInput = {
    resource: `projects/${project}/locations/asia-northeast3/queues/preflight`, project, location: 'asia-northeast3',
    target: { url: runtime.target.url, audience: runtime.target.audience, callerIdentity: identity },
    configuration: { maxConcurrentDispatches: 2 },
};
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
        }, { oldSha: 'a'.repeat(40), oldRevision: 'preflight-old' }, 'old')).not.toThrow();
        expect(() => validateRuntimeObservation({
            ...runtime, generation: '17', resourceVersion: 'resource-version', runtimeDigest: digest('runtime'),
            buildDigest: digest('build'), traffic: {},
        }, runtime)).not.toThrow();
        expect(() => validateReadinessObservation({
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40),
            legacyTargetResource: 'legacy-target', preflightFingerprint: digest('preflight'), paidFingerprint: digest('paid'),
            analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false, ready: true,
        }, {
            schemaVersion: 'analysis-public-freeze-readiness-v3', sourceSha: 'b'.repeat(40), legacyTargetResource: 'legacy-target',
            preflightFingerprint: digest('preflight'), paidFingerprint: digest('paid'),
            analysisV2AdmissionEnabled: false, earlybirdWebhookAutoAdmissionEnabled: false,
        })).not.toThrow();
    });

    it('rejects runtime drift, mutable traffic, and wrong private provider gate', () => {
        const observed = {
            ...runtime, generation: '17', resourceVersion: 'resource-version', runtimeDigest: digest('runtime'),
            buildDigest: digest('build'), traffic: {},
        };
        expect(() => validateRuntimeObservation({ ...observed, environment: { ...runtime.environment, DRIFT: '1' } }, runtime)).toThrow('RUNTIME_MISMATCH');
        expect(() => validateRuntimeObservation({ ...observed, traffic: { latest: 100 } }, runtime)).toThrow('RUNTIME_MISMATCH');
        expect(() => validateRuntimeObservation({ ...observed, providerAdmissionEnabled: false }, runtime)).toThrow('RUNTIME_MISMATCH');
    });

    it('requires a complete paused empty queue and an aged scheduler pause', () => {
        expect(() => validateQueueObservation({
            role: 'preflight', ...queue, configurationDigest: digest(queue.configuration), state: 'PAUSED', tasks: [], complete: true,
        }, queue, digest(queue.configuration))).not.toThrow();
        expect(() => validateQueueObservation({
            role: 'preflight', ...queue, configurationDigest: digest(queue.configuration), state: 'PAUSED',
            tasks: [{ name: 'task', payloadDigest: digest('task'), createTime: new Date(1_000).toISOString() }], complete: true,
        }, queue, digest(queue.configuration))).toThrow('QUEUE_NOT_EMPTY');
        expect(() => validateQueueObservation({
            role: 'preflight', ...queue, configurationDigest: digest(queue.configuration), state: 'PAUSED', tasks: [], complete: false,
        }, queue, digest(queue.configuration))).toThrow('PAGINATION_INCOMPLETE');
        expect(() => validateSchedulerObservation({
            role: 'preflight', ...scheduler, configurationDigest: digest(scheduler.configuration), pauseEpochMs: 15_000, nowMs: 20_000,
        }, scheduler, 20_000, 5_000, 5_000)).toThrow('SCHEDULER_NOT_QUIESCENT');
        expect(() => validateSchedulerObservation({
            role: 'preflight', ...scheduler, configurationDigest: digest(scheduler.configuration), pauseEpochMs: 1_000,
            nowMs: 20_000,
        }, scheduler, 20_000, 5_000, 5_000)).not.toThrow();
    });

    it('binds IAM etag/read-back, retention, and independent zero-work coverage', () => {
        const iam = {
            role: 'preflight' as const, resource: `projects/${project}/locations/asia-northeast3/services/preflight-worker`, project,
            etag: 'Bwfixture', bindings: [{ role: 'roles/run.invoker', member: `serviceAccount:${identity.identity}`, condition: null }],
        };
        expect(() => validateIamObservation(iam, iam)).not.toThrow();
        expect(() => validateIamObservation({ ...iam, etag: '' }, iam)).toThrow('IAM_ETAG_REQUIRED');
        expect(() => validateRetentionObservation({ role: 'retention', ...retention }, retention)).not.toThrow();
        const zeroWork = {
            windowStartMs: 1_000, windowEndMs: 20_000,
            providerLedger: { digest: digest('provider'), observedAtMs: 20_000, complete: true },
            billingLedger: { digest: digest('billing'), observedAtMs: 20_000, complete: true },
            taskAudit: { digest: digest('tasks'), observedAtMs: 20_000, complete: true },
            receiverLog: { digest: digest('logs'), observedAtMs: 20_000, complete: true },
        };
        expect(() => validateZeroWorkObservation(zeroWork, 20_000)).not.toThrow();
        expect(() => validateZeroWorkObservation({ ...zeroWork, receiverLog: { ...zeroWork.receiverLog, complete: false } }, 20_000)).toThrow('ZERO_WORK_INCOMPLETE');
        expect(() => validateZeroWorkObservation({ ...zeroWork, windowEndMs: 30_000 }, 20_000)).toThrow(EpochError);
    });
});
