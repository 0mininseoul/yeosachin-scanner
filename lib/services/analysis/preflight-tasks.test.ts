import { describe, expect, it, vi } from 'vitest';
import {
    enqueuePreflightTask,
    getPreflightTasksConfig,
    preflightTaskId,
    resolvePreflightDispatchPolicy,
    verifyPreflightTaskAuthorization,
    type PreflightTasksConfig,
} from './preflight-tasks';

const preflightId = '123e4567-e89b-42d3-a456-426614174000';
const config: PreflightTasksConfig = {
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-preflight',
    targetUrl: 'https://worker.example.com/api/analysis/preflight/worker',
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'preflight-task@example-project.iam.gserviceaccount.com',
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
