import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

import type {
    AnalysisV2JobDispatchReservation,
    AnalysisV2JobStore,
} from './v2-job-store';
import {
    analysisV2TaskId,
    assertAnalysisV2TasksConfigured,
    dispatchAnalysisV2Job,
    enqueueAnalysisV2Task,
    getAnalysisV2TasksConfig,
    lookupAnalysisV2Task,
    parseAnalysisV2TaskPayload,
    verifyAnalysisV2TaskAuthorization,
    type AnalysisV2TasksConfig,
} from './v2-tasks';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const jobKey = 'coordinator:bootstrap';
const config: AnalysisV2TasksConfig = {
    project: 'example-project',
    location: 'asia-northeast3',
    queue: 'analysis-v2',
    targetUrl: 'https://worker.example.com/api/analysis/v2/worker',
    oidcAudience: 'https://worker.example.com',
    serviceAccountEmail: 'analysis-v2-task@example-project.iam.gserviceaccount.com',
    callerAuth: { mode: 'adc', projectId: 'example-project' },
};

function configEnv(): Record<string, string> {
    return {
        ANALYSIS_V2_TASKS_ENABLED: 'true',
        ANALYSIS_V2_TASKS_PROJECT: config.project,
        ANALYSIS_V2_TASKS_LOCATION: config.location,
        ANALYSIS_V2_TASKS_QUEUE: config.queue,
        ANALYSIS_V2_TASKS_TARGET_URL: config.targetUrl,
        ANALYSIS_V2_TASKS_OIDC_AUDIENCE: config.oidcAudience,
        ANALYSIS_V2_TASKS_SERVICE_ACCOUNT_EMAIL: config.serviceAccountEmail,
        ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: 'adc',
    };
}

function queueClient(createTask = vi.fn().mockResolvedValue([{}])) {
    return {
        queuePath: vi.fn(() => 'queue-path'),
        taskPath: vi.fn((_project, _location, _queue, task) => (
            `queue-path/tasks/${task}`
        )),
        createTask,
    };
}

function dispatchReservation(
    dispatchFence = randomUUID()
): AnalysisV2JobDispatchReservation {
    return {
        requestId,
        jobKey,
        reserved: true,
        generation: 1,
        reservationToken: dispatchFence,
        status: 'pending',
        dispatchState: 'reserved',
        taskName: null,
    };
}

function mockStore(
    reservation: AnalysisV2JobDispatchReservation = dispatchReservation()
): AnalysisV2JobStore {
    return {
        reserveDispatch: vi.fn().mockResolvedValue(reservation),
        rearmDispatch: vi.fn(),
        deferRecovery: vi.fn(),
        markDispatched: vi.fn().mockResolvedValue(undefined),
        claim: vi.fn(),
        deferTerminalCleanup: vi.fn(),
        deferAiCapacity: vi.fn(),
        releaseClaim: vi.fn(),
        completeAndFanout: vi.fn(),
        listDispatchable: vi.fn(),
    };
}

describe('analysis V2 Cloud Tasks', () => {
    it('is disabled by default and validates the exact HTTPS worker boundary', () => {
        expect(getAnalysisV2TasksConfig({})).toBeNull();
        expect(() => getAnalysisV2TasksConfig({
            ANALYSIS_V2_TASKS_ENABLED: 'true',
        })).toThrow('ANALYSIS_V2_TASKS_CONFIG_ERROR');
        expect(getAnalysisV2TasksConfig(configEnv())).toEqual(config);
        expect(assertAnalysisV2TasksConfigured(configEnv())).toEqual(config);
        expect(() => assertAnalysisV2TasksConfigured({})).toThrow(
            'ANALYSIS_V2_TASKS_UNAVAILABLE'
        );
        expect(() => getAnalysisV2TasksConfig({
            ...configEnv(),
            ANALYSIS_V2_TASKS_TARGET_URL: 'https://worker.example.com/api/analysis/step',
        })).toThrow('/api/analysis/v2/worker');
        expect(() => getAnalysisV2TasksConfig({
            ...configEnv(),
            ANALYSIS_V2_TASKS_OIDC_AUDIENCE: 'https://worker.example.com/not-root',
        })).toThrow('OIDC audience');
        expect(() => getAnalysisV2TasksConfig({
            ...configEnv(),
            ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: '',
        })).toThrow('ANALYSIS_V2_TASKS_CALLER_AUTH_MODE');
        expect(() => getAnalysisV2TasksConfig({
            ...configEnv(),
            VERCEL: '1',
        })).toThrow('Vercel must use vercel-wif');
    });

    it('resolves the dedicated Vercel WIF enqueuer without changing task OIDC identity', () => {
        const providerResource =
            'projects/123456789012/locations/global/workloadIdentityPools/'
            + 'vercel-production/providers/ai-baram-detector';
        const resolved = getAnalysisV2TasksConfig({
            ...configEnv(),
            ANALYSIS_V2_TASKS_CALLER_AUTH_MODE: 'vercel-wif',
            ANALYSIS_V2_TASKS_ENQUEUER_SERVICE_ACCOUNT_EMAIL:
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

    it('strictly parses only the PII-free task delivery contract', () => {
        const dispatchFence = randomUUID();
        expect(parseAnalysisV2TaskPayload({
            requestId: requestId.toUpperCase(),
            jobKey,
            generation: 1,
            reservationToken: dispatchFence.toUpperCase(),
        })).toEqual({
            requestId,
            jobKey,
            generation: 1,
            reservationToken: dispatchFence,
        });
        expect(() => parseAnalysisV2TaskPayload({
            requestId,
            jobKey,
            generation: 1,
            reservationToken: dispatchFence,
            username: 'must-not-cross-the-queue',
        })).toThrow();
    });

    it('derives the exact deterministic generation task id', () => {
        const digest = createHash('sha256').update(jobKey).digest('hex').slice(0, 24);
        expect(analysisV2TaskId(requestId, jobKey, 3)).toBe(
            `analysis-v2-${requestId}-${digest}-g3`
        );
        expect(() => analysisV2TaskId(requestId, jobKey, 0)).toThrow(
            'invalid dispatch generation'
        );
    });

    it('creates one bounded OIDC task with only the fenced delivery body', async () => {
        const dispatchFence = randomUUID();
        const client = queueClient();
        const result = await enqueueAnalysisV2Task({
            requestId,
            jobKey,
            generation: 1,
            reservationToken: dispatchFence,
        }, { config, client, delaySeconds: 2 });
        expect(result.outcome).toBe('enqueued');

        const request = client.createTask.mock.calls[0][0] as {
            task: {
                name: string;
                dispatchDeadline: { seconds: number };
                scheduleTime: { seconds: number };
                httpRequest: {
                    url: string;
                    body: string;
                    oidcToken: { audience: string; serviceAccountEmail: string };
                };
            };
        };
        expect(request.task.name).toContain(analysisV2TaskId(requestId, jobKey, 1));
        expect(request.task.dispatchDeadline.seconds).toBe(300);
        expect(request.task.httpRequest.url).toBe(config.targetUrl);
        expect(request.task.httpRequest.oidcToken).toEqual({
            audience: config.oidcAudience,
            serviceAccountEmail: config.serviceAccountEmail,
        });
        expect(JSON.parse(Buffer.from(request.task.httpRequest.body, 'base64').toString()))
            .toEqual({
                requestId,
                jobKey,
                generation: 1,
                reservationToken: dispatchFence,
            });
    });

    it('accepts canonical ALREADY_EXISTS but not a message-only imitation', async () => {
        const delivery = {
            requestId,
            jobKey,
            generation: 1,
            reservationToken: randomUUID(),
        };
        await expect(enqueueAnalysisV2Task(delivery, {
            config,
            client: queueClient(vi.fn().mockRejectedValue({ code: 6 })),
        })).resolves.toMatchObject({ outcome: 'exists' });
        await expect(enqueueAnalysisV2Task(delivery, {
            config,
            client: queueClient(vi.fn().mockRejectedValue({
                message: 'ALREADY_EXISTS but this is not a canonical status',
            })),
        })).rejects.toThrow('ANALYSIS_V2_TASKS_ENQUEUE_ERROR');
    });

    it('treats only canonical NOT_FOUND as safe evidence for rearm', async () => {
        const pathClient = {
            taskPath: vi.fn((_project, _location, _queue, task) => `tasks/${task}`),
            getTask: vi.fn().mockRejectedValueOnce({ code: 5 }),
        };
        await expect(lookupAnalysisV2Task({ requestId, jobKey, generation: 1 }, {
            config,
            client: pathClient,
        })).resolves.toBe('not_found');

        pathClient.getTask.mockRejectedValueOnce({
            message: 'NOT_FOUND from an untrusted intermediary',
        });
        await expect(lookupAnalysisV2Task({ requestId, jobKey, generation: 1 }, {
            config,
            client: pathClient,
        })).rejects.toThrow('ANALYSIS_V2_TASKS_LOOKUP_ERROR');

        pathClient.getTask.mockResolvedValueOnce([{}]);
        await expect(lookupAnalysisV2Task({ requestId, jobKey, generation: 1 }, {
            config,
            client: pathClient,
        })).resolves.toBe('exists');
    });

    it('prevalidates configuration then reserves, enqueues, and marks in order', async () => {
        const events: string[] = [];
        const dispatch = dispatchReservation();
        const store = mockStore(dispatch);
        vi.mocked(store.reserveDispatch).mockImplementation(async () => {
            events.push('reserved');
            return dispatch;
        });
        vi.mocked(store.markDispatched).mockImplementation(async () => {
            events.push('marked');
        });
        const client = queueClient(vi.fn().mockImplementation(async () => {
            events.push('enqueued');
            return [{}];
        }));

        await expect(dispatchAnalysisV2Job(requestId, jobKey, {
            config,
            client,
            store,
        })).resolves.toBe('enqueued');
        expect(events).toEqual(['reserved', 'enqueued', 'marked']);
        expect(store.markDispatched).toHaveBeenCalledWith(expect.objectContaining({
            requestId,
            jobKey,
            generation: 1,
            reservationToken: dispatch.reservationToken,
            taskName: expect.stringContaining(analysisV2TaskId(requestId, jobKey, 1)),
        }));

        const disabledStore = mockStore();
        await expect(dispatchAnalysisV2Job(requestId, jobKey, {
            config: null,
            client,
            store: disabledStore,
        })).rejects.toThrow('ANALYSIS_V2_TASKS_UNAVAILABLE');
        expect(disabledStore.reserveDispatch).not.toHaveBeenCalled();
    });

    it('does not mark a failed enqueue and skips a previously dispatched job', async () => {
        const store = mockStore();
        await expect(dispatchAnalysisV2Job(requestId, jobKey, {
            config,
            client: queueClient(vi.fn().mockRejectedValue({ code: 14 })),
            store,
        })).rejects.toThrow('ANALYSIS_V2_TASKS_ENQUEUE_ERROR');
        expect(store.markDispatched).not.toHaveBeenCalled();

        const alreadyDispatched = mockStore({
            ...dispatchReservation(),
            reserved: false,
            dispatchState: 'enqueued',
        });
        const client = queueClient();
        await expect(dispatchAnalysisV2Job(requestId, jobKey, {
            config,
            client,
            store: alreadyDispatched,
        })).resolves.toBe('already_dispatched');
        expect(client.createTask).not.toHaveBeenCalled();
    });

    it('accepts only the verified configured task service account', async () => {
        const verifier = {
            verifyIdToken: vi.fn(async () => ({
                getPayload: () => ({
                    email: config.serviceAccountEmail,
                    email_verified: true,
                }),
            })),
        };
        await expect(verifyAnalysisV2TaskAuthorization('Bearer signed', {
            config,
            verifier,
        })).resolves.toBe(true);
        expect(verifier.verifyIdToken).toHaveBeenCalledWith({
            idToken: 'signed',
            audience: config.oidcAudience,
        });
        await expect(verifyAnalysisV2TaskAuthorization('Bearer signed', {
            config,
            verifier: {
                verifyIdToken: async () => ({
                    getPayload: () => ({
                        email: 'other@example.com',
                        email_verified: true,
                    }),
                }),
            },
        })).resolves.toBe(false);
    });
});
