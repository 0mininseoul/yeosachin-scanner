import { describe, expect, it, vi } from 'vitest';
import {
    analysisTaskStateFromRow,
    analysisTaskStateKey,
    createCloudTasksClient,
    enqueueAnalysisTask,
    getAnalysisTasksConfig,
    startAnalysisInBackground,
    verifyAnalysisTaskAuthorization,
    type AnalysisTasksConfig,
} from './background-tasks';

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const config: AnalysisTasksConfig = {
    project: 'gen-lang-client-0311522474',
    location: 'asia-northeast3',
    queue: 'analysis-pipeline',
    targetUrl: 'https://example.com/api/analysis/step',
    oidcAudience: 'https://example.com',
    serviceAccountEmail: 'analysis-task@example-project.iam.gserviceaccount.com',
};

describe('analysis background tasks', () => {
    it('prepares deployment ADC before constructing the Cloud Tasks client', async () => {
        const order: string[] = [];
        const client = {} as never;

        await expect(createCloudTasksClient(
            () => { order.push('credentials'); },
            async () => {
                order.push('client');
                return client;
            }
        )).resolves.toBe(client);
        expect(order).toEqual(['credentials', 'client']);
    });

    it('is disabled by default and fails closed on partial configuration', () => {
        expect(getAnalysisTasksConfig({})).toBeNull();
        expect(() => getAnalysisTasksConfig({ ANALYSIS_TASKS_ENABLED: 'true' }))
            .toThrow('ANALYSIS_TASKS_CONFIG_ERROR');
        expect(getAnalysisTasksConfig({
            ANALYSIS_TASKS_ENABLED: 'true',
            ANALYSIS_TASKS_PROJECT: config.project,
            ANALYSIS_TASKS_LOCATION: config.location,
            ANALYSIS_TASKS_QUEUE: config.queue,
            ANALYSIS_TASKS_TARGET_URL: config.targetUrl,
            ANALYSIS_TASKS_OIDC_AUDIENCE: config.oidcAudience,
            ANALYSIS_TASKS_SERVICE_ACCOUNT_EMAIL: config.serviceAccountEmail,
        })).toEqual(config);
    });

    it('derives a deterministic task name from resumable batch state', () => {
        const first = analysisTaskStateKey(requestId, {
            currentStep: 'profiles',
            progress: 40,
            stepData: { profileBatchIndex: 2 },
        });
        expect(first).toBe(analysisTaskStateKey(requestId, {
            currentStep: 'profiles',
            progress: 40,
            stepData: { profileBatchIndex: 2 },
        }));
        expect(first).not.toBe(analysisTaskStateKey(requestId, {
            currentStep: 'profiles',
            progress: 45,
            stepData: { profileBatchIndex: 3 },
        }));
    });

    it('reads only bounded resumable state from the persisted request row', () => {
        expect(analysisTaskStateFromRow({
            current_step: 'interactions',
            progress: 88,
            step_data: {
                profileBatchIndex: 4,
                analyzeBatchIndex: 3,
                interactionStage: 'candidates',
                interactionCandidateBatchIndex: 2,
                deepAnalysisStage: 'profiles',
                ignoredLargePayload: ['not', 'copied'],
            },
        })).toEqual({
            currentStep: 'interactions',
            progress: 88,
            stepData: {
                profileBatchIndex: 4,
                analyzeBatchIndex: 3,
                interactionStage: 'candidates',
                interactionCandidateBatchIndex: 2,
                deepAnalysisStage: 'profiles',
            },
        });
        expect(() => analysisTaskStateFromRow({
            current_step: 'interactions',
            progress: 101,
            step_data: {},
        })).toThrow('ANALYSIS_TASKS_STATE_ERROR');
    });

    it('creates one bounded OIDC task and treats an existing state task as success', async () => {
        const createTask = vi.fn<(
            request: Record<string, unknown>
        ) => Promise<[unknown]>>().mockResolvedValue([{}]);
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p, _l, _q, task) => `queue-path/tasks/${task}`),
            createTask,
        };
        await expect(enqueueAnalysisTask(requestId, {
            currentStep: 'pending',
            progress: 0,
        }, { config, client, delaySeconds: 2 })).resolves.toBe('enqueued');

        const request = createTask.mock.calls[0]?.[0] as {
            task: {
                dispatchDeadline: { seconds: number };
                httpRequest: {
                    oidcToken: { audience: string; serviceAccountEmail: string };
                    body: string;
                };
            };
        };
        expect(request.task.dispatchDeadline.seconds).toBe(300);
        expect(request.task.httpRequest.oidcToken).toEqual({
            audience: config.oidcAudience,
            serviceAccountEmail: config.serviceAccountEmail,
        });
        expect(JSON.parse(Buffer.from(request.task.httpRequest.body, 'base64').toString()))
            .toEqual({ requestId });

        client.createTask.mockRejectedValueOnce({ code: 6 });
        await expect(enqueueAnalysisTask(requestId, {
            currentStep: 'pending',
            progress: 0,
        }, { config, client })).resolves.toBe('exists');
    });

    it('accepts only the configured verified service-account email', async () => {
        const verifier = {
            verifyIdToken: vi.fn(async () => ({
                getPayload: () => ({
                    email: config.serviceAccountEmail,
                    email_verified: true,
                }),
            })),
        };
        await expect(verifyAnalysisTaskAuthorization('Bearer signed-token', {
            config,
            verifier,
        })).resolves.toBe(true);
        expect(verifier.verifyIdToken).toHaveBeenCalledWith({
            idToken: 'signed-token',
            audience: config.oidcAudience,
        });

        await expect(verifyAnalysisTaskAuthorization('Bearer signed-token', {
            config,
            verifier: {
                verifyIdToken: async () => ({
                    getPayload: () => ({ email: 'other@example.com', email_verified: true }),
                }),
            },
        })).resolves.toBe(false);
    });

    it('marks background mode only after the initial task is safely enqueued', async () => {
        const events: string[] = [];
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn((_p, _l, _q, task) => `queue-path/tasks/${task}`),
            createTask: vi.fn<(
                request: Record<string, unknown>
            ) => Promise<[unknown]>>().mockImplementation(async () => {
                events.push('enqueued');
                return [{}] as [unknown];
            }),
        };

        await expect(startAnalysisInBackground(
            requestId,
            { currentStep: 'pending', progress: 0 },
            async () => { events.push('marked'); },
            { config, client }
        )).resolves.toBe(true);
        expect(events).toEqual(['enqueued', 'marked']);

        const markDisabled = vi.fn();
        await expect(startAnalysisInBackground(
            requestId,
            { currentStep: 'pending', progress: 0 },
            markDisabled,
            { config: null, client }
        )).resolves.toBe(false);
        expect(markDisabled).not.toHaveBeenCalled();

        const markFailed = vi.fn();
        client.createTask.mockRejectedValueOnce(new Error('queue unavailable'));
        await expect(startAnalysisInBackground(
            requestId,
            { currentStep: 'collect', progress: 5 },
            markFailed,
            { config, client }
        )).rejects.toThrow('ANALYSIS_TASKS_ENQUEUE_ERROR');
        expect(markFailed).not.toHaveBeenCalled();
    });
});
