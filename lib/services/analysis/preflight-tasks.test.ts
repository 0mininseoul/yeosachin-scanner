import { describe, expect, it, vi } from 'vitest';
import {
    PreflightTaskEnqueueError,
    enqueueFreshAdmissionTask,
    enqueuePreflightTask,
    freshAdmissionTaskId,
    getPreflightTasksConfig,
    preflightTaskId,
    resolvePreflightDispatchPolicy,
    verifyPreflightTaskAuthorization,
    type PreflightTasksConfig,
} from './preflight-tasks';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const dispatchToken = '123e4567-e89b-42d3-a456-426614174005';
const config: PreflightTasksConfig = {
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-preflight',
    targetUrl: 'https://worker.example.com/api/analysis/preflight/worker',
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'preflight-task@example-project.iam.gserviceaccount.com',
    callerAuth: { mode: 'adc', projectId: 'example-project' },
};

function configEnv(): Record<string, string> {
    return {
        PREFLIGHT_TASKS_ENABLED: 'true',
        PREFLIGHT_TASKS_PROJECT: config.project,
        PREFLIGHT_TASKS_LOCATION: config.location,
        PREFLIGHT_TASKS_QUEUE: config.queue,
        PREFLIGHT_TASKS_TARGET_URL: config.targetUrl,
        PREFLIGHT_TASKS_OIDC_AUDIENCE: config.oidcAudience,
        PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: config.serviceAccountEmail,
        PREFLIGHT_TASKS_CALLER_AUTH_MODE: 'adc',
    };
}

describe('preflight Cloud Tasks', () => {
    it('validates the full HTTPS path, audience, and service account configuration', () => {
        expect(getPreflightTasksConfig(configEnv())).toEqual(config);
        expect(() => getPreflightTasksConfig({
            ...configEnv(),
            PREFLIGHT_TASKS_TARGET_URL: 'https://worker.example.com/api/analysis/step',
        })).toThrow('task target must be /api/analysis/preflight/worker');
        expect(() => getPreflightTasksConfig({
            ...configEnv(),
            PREFLIGHT_TASKS_OIDC_AUDIENCE: 'https://other.example.com',
        })).toThrow('OIDC audience');
        expect(() => getPreflightTasksConfig({
            ...configEnv(),
            PREFLIGHT_TASKS_SERVICE_ACCOUNT_EMAIL: 'not-an-email',
        })).toThrow('invalid service account');
        expect(() => getPreflightTasksConfig({
            ...configEnv(),
            PREFLIGHT_TASKS_CALLER_AUTH_MODE: '',
        })).toThrow('PREFLIGHT_TASKS_CALLER_AUTH_MODE');
        expect(() => getPreflightTasksConfig({
            ...configEnv(),
            K_SERVICE: 'analysis-worker',
            PREFLIGHT_TASKS_CALLER_AUTH_MODE: 'vercel-wif',
        })).toThrow('Cloud Run must use attached ADC');
    });

    it('uses the same dedicated WIF caller while preserving the preflight task identity', () => {
        const providerResource =
            'projects/123456789012/locations/global/workloadIdentityPools/'
            + 'vercel-production/providers/ai-baram-detector';
        const resolved = getPreflightTasksConfig({
            ...configEnv(),
            PREFLIGHT_TASKS_CALLER_AUTH_MODE: 'vercel-wif',
            PREFLIGHT_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL:
                'analysis-v2-enqueuer@example-project.iam.gserviceaccount.com',
            GCP_VERCEL_WIF_PROVIDER_RESOURCE: providerResource,
            VERCEL: '1',
            VERCEL_ENV: 'production',
        });
        expect(resolved?.serviceAccountEmail).toBe(config.serviceAccountEmail);
        expect(resolved?.callerAuth).toMatchObject({
            mode: 'vercel-wif',
            stsAudience: `//iam.googleapis.com/${providerResource}`,
            oidcTokenAudience: `https://iam.googleapis.com/${providerResource}`,
            enqueuerServiceAccountEmail:
                'analysis-v2-enqueuer@example-project.iam.gserviceaccount.com',
        });
    });

    it('permits local after execution only through an explicit non-production switch', () => {
        expect(resolvePreflightDispatchPolicy({})).toEqual({ mode: 'unavailable' });
        expect(resolvePreflightDispatchPolicy({
            NODE_ENV: 'test',
            PREFLIGHT_LOCAL_AFTER_ENABLED: 'true',
        })).toEqual({ mode: 'local_after' });
        expect(() => resolvePreflightDispatchPolicy({
            NODE_ENV: 'production',
            PREFLIGHT_LOCAL_AFTER_ENABLED: 'true',
        })).toThrow('forbidden in production');
        expect(resolvePreflightDispatchPolicy(configEnv())).toEqual({ mode: 'queue', config });
    });

    it('creates one deterministic OIDC task', async () => {
        const createTask = vi.fn<(
            request: Record<string, unknown>
        ) => Promise<unknown[]>>().mockResolvedValue([{}]);
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p, _l, _q, task) => `queue-path/tasks/${task}`),
            createTask,
        };

        expect(preflightTaskId(preflightId, 1)).toBe(`preflight-${preflightId}-g1`);
        await expect(enqueuePreflightTask(preflightId, 1, { config, client }))
            .resolves.toBe('enqueued');
        const request = createTask.mock.calls[0][0] as {
            task: {
                name: string;
                dispatchDeadline: { seconds: number };
                httpRequest: {
                    body: string;
                    oidcToken: { audience: string; serviceAccountEmail: string };
                };
            };
        };
        expect(request.task.name).toContain(`preflight-${preflightId}-g1`);
        expect(request.task.dispatchDeadline.seconds).toBe(120);
        expect(request.task.httpRequest.oidcToken).toEqual({
            audience: config.oidcAudience,
            serviceAccountEmail: config.serviceAccountEmail,
        });
        expect(JSON.parse(Buffer.from(request.task.httpRequest.body, 'base64').toString()))
            .toEqual({ preflightId });
    });

    it('treats the UUID-named task as idempotent when Cloud Tasks reports it exists', async () => {
        const createTask = vi.fn().mockRejectedValue({ code: 6 });
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p: string, _l: string, _q: string, task: string) => (
                `queue-path/tasks/${task}`
            )),
            createTask,
        };

        await expect(enqueuePreflightTask(preflightId, 1, { config, client }))
            .resolves.toBe('exists');
        expect(createTask).toHaveBeenCalledOnce();
    });

    it('confirms an ambiguous response loss through deterministic ALREADY_EXISTS replay', async () => {
        const createTask = vi.fn()
            .mockRejectedValueOnce({ code: 4 })
            .mockRejectedValueOnce({ code: 6 });
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p: string, _l: string, _q: string, task: string) => (
                `queue-path/tasks/${task}`
            )),
            createTask,
        };

        await expect(enqueuePreflightTask(preflightId, 1, { config, client }))
            .resolves.toBe('exists');
        expect(createTask).toHaveBeenCalledTimes(2);
        expect(createTask.mock.calls[0][0]).toEqual(createTask.mock.calls[1][0]);
    });

    it('retries one ambiguous failure and accepts a subsequent create', async () => {
        const createTask = vi.fn()
            .mockRejectedValueOnce({ code: 14 })
            .mockResolvedValueOnce([{}]);
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p: string, _l: string, _q: string, task: string) => (
                `queue-path/tasks/${task}`
            )),
            createTask,
        };

        await expect(enqueuePreflightTask(preflightId, 1, { config, client }))
            .resolves.toBe('enqueued');
        expect(createTask).toHaveBeenCalledTimes(2);
        expect(createTask.mock.calls[0][0]).toEqual(createTask.mock.calls[1][0]);
    });

    it('classifies a definitive rejection without retrying', async () => {
        const createTask = vi.fn().mockRejectedValue({ code: 7 });
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p: string, _l: string, _q: string, task: string) => (
                `queue-path/tasks/${task}`
            )),
            createTask,
        };

        const error = await enqueuePreflightTask(preflightId, 1, { config, client })
            .catch(caught => caught);
        expect(error).toBeInstanceOf(PreflightTaskEnqueueError);
        expect(error).toMatchObject({ disposition: 'terminal' });
        expect(createTask).toHaveBeenCalledOnce();
    });

    it('keeps resource exhaustion replayable after the bounded retry', async () => {
        const createTask = vi.fn().mockRejectedValue({ code: 8 });
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p: string, _l: string, _q: string, task: string) => (
                `queue-path/tasks/${task}`
            )),
            createTask,
        };

        const error = await enqueuePreflightTask(preflightId, 1, { config, client })
            .catch(caught => caught);
        expect(error).toBeInstanceOf(PreflightTaskEnqueueError);
        expect(error).toMatchObject({ disposition: 'replayable' });
        expect(createTask).toHaveBeenCalledTimes(2);
    });

    it('preserves an ambiguous outcome after the bounded deterministic retry', async () => {
        const createTask = vi.fn()
            .mockRejectedValueOnce({ code: 4 })
            .mockRejectedValueOnce({ code: 7 });
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p: string, _l: string, _q: string, task: string) => (
                `queue-path/tasks/${task}`
            )),
            createTask,
        };

        const error = await enqueuePreflightTask(preflightId, 1, { config, client })
            .catch(caught => caught);
        expect(error).toBeInstanceOf(PreflightTaskEnqueueError);
        expect(error).toMatchObject({ disposition: 'replayable' });
        expect(createTask).toHaveBeenCalledTimes(2);
        expect(createTask.mock.calls[0][0]).toEqual(createTask.mock.calls[1][0]);
    });

    it('creates a separately named, generation-fenced fresh-admission task', async () => {
        const createTask = vi.fn().mockResolvedValue([{}]);
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p: string, _l: string, _q: string, task: string) => (
                `queue-path/tasks/${task}`
            )),
            createTask,
        };

        expect(freshAdmissionTaskId(preflightId, 3, 2))
            .toBe(`preflight-admission-${preflightId}-g3-d2`);
        await expect(enqueueFreshAdmissionTask(
            preflightId,
            3,
            2,
            dispatchToken,
            { config, client }
        ))
            .resolves.toBe('enqueued');
        const request = createTask.mock.calls[0][0] as {
            task: { httpRequest: { body: string } };
        };
        expect(JSON.parse(Buffer.from(request.task.httpRequest.body, 'base64').toString()))
            .toEqual({
                preflightId,
                kind: 'fresh_admission',
                generation: 3,
                dispatchGeneration: 2,
                dispatchToken,
            });
    });

    it('accepts only a verified token from the configured service account', async () => {
        const verifier = {
            verifyIdToken: vi.fn(async () => ({
                getPayload: () => ({
                    email: config.serviceAccountEmail,
                    email_verified: true,
                }),
            })),
        };
        await expect(verifyPreflightTaskAuthorization('Bearer signed', {
            config,
            verifier,
        })).resolves.toBe(true);
        expect(verifier.verifyIdToken).toHaveBeenCalledWith({
            idToken: 'signed',
            audience: config.oidcAudience,
        });
        await expect(verifyPreflightTaskAuthorization('Bearer signed', {
            config,
            verifier: {
                verifyIdToken: async () => ({
                    getPayload: () => ({ email: 'other@example.com', email_verified: true }),
                }),
            },
        })).resolves.toBe(false);
    });
});
