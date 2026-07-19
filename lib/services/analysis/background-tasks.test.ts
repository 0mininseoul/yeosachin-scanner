import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const observabilityMocks = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: observabilityMocks.emit },
}));

import { GoogleAuth } from 'google-gax';
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
    beforeEach(() => {
        observabilityMocks.emit.mockReset();
    });

    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('prepares deployment ADC before constructing the Cloud Tasks client', async () => {
        const order: string[] = [];
        const client = {} as never;

        await expect(createCloudTasksClient({
            prepareLegacyCredentials: () => { order.push('credentials'); },
            createClient: async () => {
                order.push('client');
                return client;
            },
        })).resolves.toBe(client);
        expect(order).toEqual(['credentials', 'client']);
    });

    it('uses attached ADC explicitly without preparing legacy V1 credentials', async () => {
        const prepareLegacyCredentials = vi.fn();
        const auth = new GoogleAuth({ projectId: config.project });
        const createAdcGoogleAuth = vi.fn(() => auth);
        const createClient = vi.fn(async () => ({} as never));

        await createCloudTasksClient({
            callerAuth: { mode: 'adc', projectId: config.project },
            prepareLegacyCredentials,
            createAdcGoogleAuth,
            createClient,
        });

        expect(prepareLegacyCredentials).not.toHaveBeenCalled();
        expect(createAdcGoogleAuth).toHaveBeenCalledWith(config.project);
        expect(createClient).toHaveBeenCalledWith({
            auth,
            projectId: config.project,
        });
    });

    it('injects the federated enqueuer only for an explicit WIF caller', async () => {
        const prepareLegacyCredentials = vi.fn();
        const auth = new GoogleAuth({ projectId: config.project });
        const createWifGoogleAuth = vi.fn(() => auth);
        const createClient = vi.fn(async () => ({} as never));
        const providerResource =
            'projects/123456789012/locations/global/workloadIdentityPools/'
            + 'vercel-production/providers/ai-baram-detector';
        const callerAuth = {
            mode: 'vercel-wif' as const,
            projectId: config.project,
            providerResource,
            stsAudience: `//iam.googleapis.com/${providerResource}`,
            oidcTokenAudience: `https://iam.googleapis.com/${providerResource}`,
            enqueuerServiceAccountEmail:
                'analysis-v2-enqueuer@example-project.iam.gserviceaccount.com',
            serviceAccountImpersonationUrl:
                'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/'
                + 'analysis-v2-enqueuer@example-project.iam.gserviceaccount.com:'
                + 'generateAccessToken',
        };

        await createCloudTasksClient({
            callerAuth,
            prepareLegacyCredentials,
            createWifGoogleAuth,
            createClient,
        });

        expect(prepareLegacyCredentials).not.toHaveBeenCalled();
        expect(createWifGoogleAuth).toHaveBeenCalledWith(callerAuth);
        expect(createClient).toHaveBeenCalledWith({
            auth,
            projectId: config.project,
        });
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

        expect(observabilityMocks.emit.mock.calls.map(call => call[0])).toEqual([
            expect.objectContaining({
                event: 'cloud_task.enqueue_completed',
                severity: 'info',
                fields: expect.objectContaining({
                    analysis_request_id: requestId,
                    queue_name: 'analysis-pipeline',
                    operation: 'enqueue',
                    phase: 'pending',
                    progress: 0,
                    disposition: 'enqueued',
                }),
            }),
            expect.objectContaining({
                event: 'cloud_task.enqueue_completed',
                fields: expect.objectContaining({ disposition: 'exists' }),
            }),
        ]);
        expect(JSON.stringify(observabilityMocks.emit.mock.calls)).not.toMatch(
            /analysis-task@|example-project|worker\.example|eyJ|oidc/i
        );
    });

    it('logs disabled queues as an intentional completion without validating the request', async () => {
        await expect(enqueueAnalysisTask('not-a-uuid', {
            currentStep: 'pending',
            progress: 0,
        }, { config: null })).resolves.toBe('disabled');

        expect(observabilityMocks.emit).toHaveBeenCalledWith({
            event: 'cloud_task.enqueue_completed',
            severity: 'info',
            fields: expect.objectContaining({
                operation: 'enqueue',
                phase: 'pending',
                progress: 0,
                disposition: 'disabled',
            }),
        });
    });

    it('logs config, client, and create failures without changing thrown behavior', async () => {
        vi.stubEnv('ANALYSIS_TASKS_ENABLED', 'invalid-setting');
        await expect(enqueueAnalysisTask(requestId, {
            currentStep: 'pending',
            progress: 0,
        })).rejects.toThrow(
            'ANALYSIS_TASKS_CONFIG_ERROR: ANALYSIS_TASKS_ENABLED must be boolean.'
        );
        vi.unstubAllEnvs();

        const clientFailure = new Error('private service account and project');
        const client = {
            queuePath: vi.fn(() => { throw clientFailure; }),
            taskPath: vi.fn(),
            createTask: vi.fn(),
        };
        await expect(enqueueAnalysisTask(requestId, {
            currentStep: 'collect',
            progress: 5,
        }, { config, client })).rejects.toBe(clientFailure);

        const createTask = vi.fn().mockRejectedValue(
            new Error('private payload target and credentials')
        );
        await expect(enqueueAnalysisTask(requestId, {
            currentStep: 'collect',
            progress: 5,
        }, {
            config,
            client: {
                queuePath: vi.fn(() => 'queue-path'),
                taskPath: vi.fn(() => 'task-path'),
                createTask,
            },
        })).rejects.toThrow(
            'ANALYSIS_TASKS_ENQUEUE_ERROR: continuation task creation failed.'
        );

        const failures = observabilityMocks.emit.mock.calls
            .map(call => call[0])
            .filter(event => event.event === 'cloud_task.enqueue_failed');
        expect(failures).toHaveLength(3);
        expect(failures.map(event => event.fields)).toEqual([
            expect.objectContaining({ error_code: 'VALIDATION_ERROR', retryable: false }),
            expect.objectContaining({ error_code: 'PROVIDER_ERROR', retryable: true }),
            expect.objectContaining({ error_code: 'PROVIDER_ERROR', retryable: true }),
        ]);
        expect(JSON.stringify(failures)).not.toMatch(
            /private service account|private payload|credentials|target/
        );
    });

    it('keeps a successful enqueue fail-open when the logger throws', async () => {
        observabilityMocks.emit.mockImplementation(() => {
            throw new Error('Axiom unavailable');
        });
        const client = {
            queuePath: vi.fn(() => 'queue-path'),
            taskPath: vi.fn(() => 'task-path'),
            createTask: vi.fn().mockResolvedValue([{}]),
        };

        await expect(enqueueAnalysisTask(requestId, {
            currentStep: 'pending',
            progress: 0,
        }, { config, client })).resolves.toBe('enqueued');
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
