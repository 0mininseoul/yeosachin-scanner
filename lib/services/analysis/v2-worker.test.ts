import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
    ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    ANALYSIS_V2_RELATIONSHIPS_JOB_KEY,
    ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY,
    analysisV2JobInputHash,
} from './v2-coordinator';
import {
    ANALYSIS_V2_FINALIZE_JOB_KEY,
    buildAnalysisV2DagPlan,
    type AnalysisV2DagRelationshipManifest,
    type AnalysisV2DagState,
} from './v2-dag-planner';
import type { AnalysisV2DagStateStore } from './v2-dag-state-store';
import type { AnalysisV2ProgressReporter } from './v2-progress-reporter';
import type {
    AnalysisV2JobStore,
    ClaimedAnalysisV2Job,
} from './v2-job-store';
import { AnalysisV2JobFenceError } from './v2-job-store';
import {
    ANALYSIS_V2_FINALIZER_MAX_ATTEMPTS,
    ANALYSIS_V2_JOB_MAX_ATTEMPTS,
    AnalysisV2JobExecutionError,
    classifyAnalysisV2JobFailure,
    executeAnalysisV2DagJob,
    executeAnalysisV2FoundationJob,
    finalizeAnalysisV2TerminalFailure,
    processAnalysisV2TaskDelivery as processAnalysisV2TaskDeliveryImpl,
    type AnalysisV2StageExecutorRegistry,
} from './v2-worker';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const reservationToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const claimToken = '323e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow -- UUID fixture
const delivery = {
    requestId,
    jobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
    generation: 1,
    reservationToken,
};
const bootstrapClaim: ClaimedAnalysisV2Job = {
    ...delivery,
    track: 'coordinator',
    kind: 'bootstrap',
    batch: null,
    inputHash: analysisV2JobInputHash(requestId, ANALYSIS_V2_BOOTSTRAP_JOB_KEY),
    claimToken,
    attemptCount: 1,
};

const processAnalysisV2TaskDelivery: typeof processAnalysisV2TaskDeliveryImpl = (
    taskDelivery,
    dependencies = {}
) => processAnalysisV2TaskDeliveryImpl(taskDelivery, {
    terminalFailureIntentLoader: async () => null,
    ...dependencies,
});

function digest(label: string): string {
    return createHash('sha256').update(label, 'utf8').digest('hex');
}

function baseState(): AnalysisV2DagState {
    return {
        schemaVersion: 2,
        requestSnapshotHash: digest('request'),
        planId: 'basic',
        planSnapshotHash: digest('plan'),
        girlfriendExclusion: {
            decisionHash: digest('girlfriend-exclusion'),
            excludedCount: 1,
        },
    };
}

function relationshipManifest(): AnalysisV2DagRelationshipManifest {
    return {
        revision: 1,
        resultHash: digest('relationships'),
        detectedMutualCount: 32,
        publicCount: 31,
        privateCount: 1,
        detailedSelectedPublicCount: 31,
        notScreenedPublicCount: 0,
        profileBatches: [
            { batch: 0, itemCount: 30, inputHash: digest('profile-topology:0') },
            { batch: 1, itemCount: 1, inputHash: digest('profile-topology:1') },
        ],
        privateNameBatches: [
            { batch: 0, itemCount: 1, inputHash: digest('private-topology:0') },
        ],
    };
}

function claimFor(
    state: AnalysisV2DagState,
    jobKey: string,
    overrides: Partial<ClaimedAnalysisV2Job> = {}
): ClaimedAnalysisV2Job {
    const job = buildAnalysisV2DagPlan(requestId, state).jobs
        .find(candidate => candidate.jobKey === jobKey);
    if (!job) throw new Error(`Missing planned job ${jobKey}`);
    return {
        requestId,
        jobKey: job.jobKey,
        track: job.track,
        kind: job.kind,
        batch: job.batch,
        inputHash: job.inputHash,
        generation: 1,
        reservationToken,
        claimToken,
        attemptCount: 1,
        ...overrides,
    };
}

function store(
    claimed: ClaimedAnalysisV2Job = bootstrapClaim,
    overrides: Partial<AnalysisV2JobStore> = {}
): AnalysisV2JobStore {
    return {
        reserveDispatch: vi.fn(),
        rearmDispatch: vi.fn(),
        deferRecovery: vi.fn(),
        markDispatched: vi.fn(),
        claim: vi.fn(async () => claimed),
        deferTerminalCleanup: vi.fn(async () => ({
            released: true,
            status: 'pending' as const,
            attemptCount: claimed.attemptCount,
            requestStatus: 'processing',
        })),
        deferAiCapacity: vi.fn(async () => ({
            released: true,
            status: 'pending' as const,
            attemptCount: claimed.attemptCount - 1,
            requestStatus: 'processing',
        })),
        releaseClaim: vi.fn(async (_claim, failure) => ({
            released: true,
            status: failure?.retryable === false ? 'failed' as const : 'pending' as const,
            attemptCount: 1,
            requestStatus: failure?.retryable === false ? 'failed' : 'processing',
        })),
        completeAndFanout: vi.fn(async () => []),
        listDispatchable: vi.fn(),
        ...overrides,
    };
}

function stateStore(
    state: AnalysisV2DagState | null = baseState(),
    overrides: Partial<AnalysisV2DagStateStore> = {}
): AnalysisV2DagStateStore {
    return {
        initializeScope: vi.fn(async () => {
            if (!state) throw new Error('missing fixture state');
            return state;
        }),
        checkpointManifest: vi.fn(async () => {
            if (!state) throw new Error('missing fixture state');
            return state;
        }),
        load: vi.fn(async () => state),
        ...overrides,
    };
}

function progressReporter(): AnalysisV2ProgressReporter {
    return {
        initialize: vi.fn(async () => ({
            snapshot: {} as never,
            event: null,
            advanced: true,
        })),
        report: vi.fn(async () => ({
            snapshot: {} as never,
            event: null,
            advanced: true,
        })),
    };
}

describe('analysis V2 durable DAG worker', () => {
    it('blocks a cross-version AI stage before invoking its executor', async () => {
        const relationshipState: AnalysisV2DagState = {
            ...baseState(),
            relationships: relationshipManifest(),
        };
        const fetchJob = buildAnalysisV2DagPlan(requestId, relationshipState).jobs
            .find(job => job.jobKey === 'track:profiles:batch:0');
        if (!fetchJob) throw new Error('Missing profile fetch fixture job');
        const initial: AnalysisV2DagState = {
            ...relationshipState,
            profileFetchBatches: [{
                batch: 0,
                itemCount: relationshipState.relationships!.profileBatches[0]!.itemCount,
                producerInputHash: fetchJob.inputHash,
                revision: 1,
                resultHash: digest('profile-fetch-result:0'),
            }],
        };
        const profileAiClaim = claimFor(initial, 'track:profile-ai:batch:0');
        const executor = vi.fn();
        const loadAiStagePolicyVersion = vi.fn(async () => 'ai-stage-policy-v2.3');

        await expect(executeAnalysisV2DagJob(profileAiClaim, {
            stateStore: stateStore(initial),
            executors: { profile_ai: executor },
            aiPolicyStore: { loadAiStagePolicyVersion },
        })).rejects.toMatchObject({
            code: 'ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH',
            disposition: 'permanent',
        });

        expect(loadAiStagePolicyVersion).toHaveBeenCalledWith(requestId);
        expect(executor).not.toHaveBeenCalled();
    });

    it('confirms provider cleanup before invoking the request failure RPC', async () => {
        const order: string[] = [];
        const prepareProviderRuns = vi.fn(async input => {
            order.push('provider');
            expect(input).toEqual({
                requestId,
                jobKey: bootstrapClaim.jobKey,
                claimToken,
                jobInputHash: bootstrapClaim.inputHash,
                errorCode: 'JOB_ATTEMPTS_EXHAUSTED',
            });
            return {
                scanned: 1,
                settled: 1,
                failed: 0,
                unconfirmedStarts: 0,
                hasMore: false,
            };
        });
        const failRequest = vi.fn(async () => {
            order.push('request');
        });

        await finalizeAnalysisV2TerminalFailure(
            bootstrapClaim,
            'JOB_ATTEMPTS_EXHAUSTED',
            { prepareProviderRuns, failRequest }
        );
        expect(order).toEqual(['provider', 'request']);
    });

    it('never invokes request failure when provider cleanup is unresolved', async () => {
        const failRequest = vi.fn();
        await expect(finalizeAnalysisV2TerminalFailure(
            bootstrapClaim,
            'JOB_ATTEMPTS_EXHAUSTED',
            {
                prepareProviderRuns: async () => {
                    throw new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
                },
                failRequest,
            }
        )).rejects.toThrow('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
        expect(failRequest).not.toHaveBeenCalled();
    });

    it('resumes the original persisted terminal failure without rerunning a job or changing its code', async () => {
        const handler = vi.fn();
        const terminalFailureFinalizer = vi.fn(async () => undefined);
        const terminalFailureIntentLoader = vi.fn(async () => 'ORIGINAL_PROVIDER_FAILURE');

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: store({ ...bootstrapClaim, attemptCount: 7 }),
            handler,
            terminalFailureIntentLoader,
            terminalFailureFinalizer,
            terminalMediaCleanup: vi.fn(async () => undefined),
        })).resolves.toEqual({
            status: 'failed',
            errorCode: 'ORIGINAL_PROVIDER_FAILURE',
        });
        expect(handler).not.toHaveBeenCalled();
        expect(terminalFailureFinalizer).toHaveBeenCalledWith(
            expect.objectContaining({ claimToken }),
            'ORIGINAL_PROVIDER_FAILURE'
        );
        expect(terminalFailureFinalizer).not.toHaveBeenCalledWith(
            expect.anything(),
            'JOB_ATTEMPTS_EXHAUSTED'
        );
    });

    it('defers a new permanent failure while provider cleanup is still pending', async () => {
        const jobStore = store(bootstrapClaim);
        const terminalMediaCleanup = vi.fn(async () => undefined);
        const terminalFailureFinalizer = vi.fn(async () => {
            throw new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
        });

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('SCRAPING_PROVIDER_QUOTA_ERROR');
            },
            terminalFailureFinalizer,
            terminalMediaCleanup,
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
        });
        expect(terminalFailureFinalizer).toHaveBeenCalledWith(
            bootstrapClaim,
            'SCRAPING_PROVIDER_QUOTA_ERROR'
        );
        expect(jobStore.deferTerminalCleanup).toHaveBeenCalledWith(bootstrapClaim);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(terminalMediaCleanup).not.toHaveBeenCalled();
    });

    it('defers a sibling whose concurrent terminal failure loses the cleanup-intent race', async () => {
        const jobStore = store(bootstrapClaim);
        const terminalMediaCleanup = vi.fn(async () => undefined);

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('SCRAPING_PROVIDER_QUOTA_ERROR');
            },
            terminalFailureFinalizer: async () => {
                throw new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_INTENT_CONFLICT');
            },
            terminalMediaCleanup,
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
        });
        expect(jobStore.deferTerminalCleanup).toHaveBeenCalledWith(bootstrapClaim);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(terminalMediaCleanup).not.toHaveBeenCalled();
    });

    it('defers a persisted terminal failure while provider cleanup is still pending', async () => {
        const jobStore = store(bootstrapClaim);
        const handler = vi.fn();
        const terminalMediaCleanup = vi.fn(async () => undefined);
        const terminalFailureFinalizer = vi.fn(async () => {
            throw new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
        });

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler,
            terminalFailureIntentLoader: async () => 'ORIGINAL_PROVIDER_FAILURE',
            terminalFailureFinalizer,
            terminalMediaCleanup,
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
        });
        expect(handler).not.toHaveBeenCalled();
        expect(terminalFailureFinalizer).toHaveBeenCalledWith(
            bootstrapClaim,
            'ORIGINAL_PROVIDER_FAILURE'
        );
        expect(jobStore.deferTerminalCleanup).toHaveBeenCalledWith(bootstrapClaim);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(terminalMediaCleanup).not.toHaveBeenCalled();
    });

    it('defers the claim when loading a sibling terminal intent requires provider cleanup', async () => {
        const jobStore = store(bootstrapClaim);
        const handler = vi.fn();
        const terminalFailureFinalizer = vi.fn(async () => undefined);
        const terminalMediaCleanup = vi.fn(async () => undefined);

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler,
            terminalFailureIntentLoader: async () => {
                throw new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
            },
            terminalFailureFinalizer,
            terminalMediaCleanup,
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
        });
        expect(jobStore.deferTerminalCleanup).toHaveBeenCalledWith(bootstrapClaim);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
        expect(terminalFailureFinalizer).not.toHaveBeenCalled();
        expect(terminalMediaCleanup).not.toHaveBeenCalled();
    });

    it('fails closed when loading a terminal failure intent throws an unrelated error', async () => {
        const jobStore = store(bootstrapClaim);
        const handler = vi.fn();

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler,
            terminalFailureIntentLoader: async () => {
                throw new Error('unexpected intent load failure');
            },
        })).rejects.toThrow('unexpected intent load failure');
        expect(jobStore.deferTerminalCleanup).not.toHaveBeenCalled();
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(handler).not.toHaveBeenCalled();
    });

    it('fails closed when terminal failure finalization throws an unrelated error', async () => {
        const jobStore = store(bootstrapClaim);
        const terminalMediaCleanup = vi.fn(async () => undefined);

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('SCRAPING_PROVIDER_QUOTA_ERROR');
            },
            terminalFailureFinalizer: async () => {
                throw new Error('unexpected finalizer failure');
            },
            terminalMediaCleanup,
        })).rejects.toThrow('unexpected finalizer failure');
        expect(jobStore.deferTerminalCleanup).not.toHaveBeenCalled();
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(terminalMediaCleanup).not.toHaveBeenCalled();
    });

    it('defers cleanup without consuming another handler attempt on the final attempt', async () => {
        const finalAttemptClaim = {
            ...bootstrapClaim,
            attemptCount: ANALYSIS_V2_JOB_MAX_ATTEMPTS,
        };
        const jobStore = store(finalAttemptClaim);
        const terminalMediaCleanup = vi.fn(async () => undefined);

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('SCRAPING_PROVIDER_QUOTA_ERROR');
            },
            terminalFailureFinalizer: async () => {
                throw new Error('ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED');
            },
            terminalMediaCleanup,
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED',
        });
        expect(jobStore.deferTerminalCleanup).toHaveBeenCalledWith(finalAttemptClaim);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(terminalMediaCleanup).not.toHaveBeenCalled();
    });

    it.each([
        'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_REQUIRED: detail',
        'ANALYSIS_V2_PROVIDER_RUN_CLEANUP_NOT_READY',
    ])('fails closed on a near-match provider cleanup error: %s', async errorMessage => {
        const jobStore = store(bootstrapClaim);

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('SCRAPING_PROVIDER_QUOTA_ERROR');
            },
            terminalFailureFinalizer: async () => {
                throw new Error(errorMessage);
            },
        })).rejects.toThrow(errorMessage);
        expect(jobStore.deferTerminalCleanup).not.toHaveBeenCalled();
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
    });

    it('initializes bootstrap under its live claim and fans out canonical root jobs', async () => {
        const dagStore = stateStore();
        const progress = progressReporter();
        const jobStore = store(bootstrapClaim, {
            completeAndFanout: vi.fn(async () => [
                { requestId, jobKey: ANALYSIS_V2_RELATIONSHIPS_JOB_KEY },
                { requestId, jobKey: ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY },
            ]),
        });
        const dispatch = vi.fn()
            .mockResolvedValueOnce('enqueued')
            .mockRejectedValueOnce(new Error('queue unavailable'));

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            stateStore: dagStore,
            progressReporter: progress,
            dispatch,
        })).resolves.toEqual({
            status: 'completed',
            successorCount: 2,
            pendingRecoveryCount: 1,
        });
        expect(dagStore.initializeScope).toHaveBeenCalledWith({
            requestId,
            jobKey: ANALYSIS_V2_BOOTSTRAP_JOB_KEY,
            inputHash: bootstrapClaim.inputHash,
            claimToken,
        });
        expect(progress.initialize).toHaveBeenCalledWith({
            claim: bootstrapClaim,
            state: baseState(),
        });
        expect(jobStore.completeAndFanout).toHaveBeenCalledWith(
            bootstrapClaim,
            expect.arrayContaining([
                expect.objectContaining({ jobKey: ANALYSIS_V2_RELATIONSHIPS_JOB_KEY }),
                expect.objectContaining({ jobKey: ANALYSIS_V2_TARGET_EVIDENCE_JOB_KEY }),
            ])
        );
        const successors = vi.mocked(jobStore.completeAndFanout).mock.calls[0][1];
        expect(successors[0].inputHash).not.toBe(
            analysisV2JobInputHash(requestId, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY)
        );
        expect(dispatch).toHaveBeenCalledTimes(2);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
    });

    it('does not run or fan out an already-terminal delivery', async () => {
        const jobStore = store(bootstrapClaim, { claim: vi.fn(async () => null) });
        const handler = vi.fn();
        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler,
        })).resolves.toEqual({ status: 'already_terminal' });
        expect(handler).not.toHaveBeenCalled();
        expect(jobStore.completeAndFanout).not.toHaveBeenCalled();
    });

    it('rejects a corrupted bootstrap input before initializing durable scope', async () => {
        const dagStore = stateStore();
        await expect(executeAnalysisV2FoundationJob({
            ...bootstrapClaim,
            inputHash: '0'.repeat(64),
        }, { stateStore: dagStore })).rejects.toMatchObject({
            code: 'ANALYSIS_V2_JOB_INPUT_MISMATCH',
            retryable: false,
        });
        expect(dagStore.initializeScope).not.toHaveBeenCalled();
    });

    it('fails a non-bootstrap job when its canonical scope is missing', async () => {
        const initial = baseState();
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const jobStore = store(relationshipClaim);
        const terminalFailureFinalizer = vi.fn(async () => undefined);
        const terminalMediaCleanup = vi.fn(async () => undefined);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: stateStore(null),
            terminalFailureFinalizer,
            terminalMediaCleanup,
        })).resolves.toEqual({
            status: 'failed',
            errorCode: 'ANALYSIS_V2_DAG_SCOPE_MISSING',
        });
        expect(terminalFailureFinalizer).toHaveBeenCalledWith(
            relationshipClaim,
            'ANALYSIS_V2_DAG_SCOPE_MISSING'
        );
        expect(terminalMediaCleanup).toHaveBeenCalledOnce();
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
    });

    it('retries a known dynamic job whose producer checkpoint is not ready', async () => {
        const notReadyClaim: ClaimedAnalysisV2Job = {
            ...bootstrapClaim,
            jobKey: 'track:profiles:batch:0',
            track: 'profiles',
            kind: 'profile_fetch',
            batch: 0,
            inputHash: digest('not-ready-profile'),
        };
        const jobStore = store(notReadyClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: notReadyClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: stateStore(),
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_JOB_DEPENDENCY_NOT_READY',
        });
        expect(jobStore.releaseClaim).toHaveBeenCalledWith(
            notReadyClaim,
            expect.objectContaining({ retryable: true })
        );
    });

    it('rejects exact input and durable job-definition drift before stage execution', async () => {
        const initial = baseState();
        const canonical = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const executor = vi.fn();
        const executors = { relationships: executor } as AnalysisV2StageExecutorRegistry;
        const terminalFailureFinalizer = vi.fn(async () => undefined);

        for (const drifted of [
            { ...canonical, inputHash: digest('drifted-input') },
            { ...canonical, track: 'target_evidence' },
        ]) {
            const jobStore = store(drifted);
            await expect(processAnalysisV2TaskDelivery({
                ...delivery,
                jobKey: drifted.jobKey,
            }, {
                store: jobStore,
                stateStore: stateStore(initial),
                executors,
                terminalFailureFinalizer,
            })).resolves.toMatchObject({ status: 'failed' });
        }
        expect(executor).not.toHaveBeenCalled();
        expect(terminalFailureFinalizer).toHaveBeenCalledTimes(2);
    });

    it('persists a stage checkpoint, reloads state, and derives dynamic batch fanout', async () => {
        const initial = baseState();
        const manifest = relationshipManifest();
        const completed: AnalysisV2DagState = { ...initial, relationships: manifest };
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        let current = initial;
        const dagStore = stateStore(initial, {
            load: vi.fn(async () => current),
            checkpointManifest: vi.fn(async () => {
                current = completed;
                return current;
            }),
        });
        const executor = vi.fn(async () => ({
            checkpoint: { kind: 'relationships' as const, manifest },
        }));
        const progress = progressReporter();
        const jobStore = store(relationshipClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: dagStore,
            executors: { relationships: executor },
            progressReporter: progress,
        })).resolves.toEqual({
            status: 'completed',
            successorCount: 0,
            pendingRecoveryCount: 0,
        });
        expect(executor).toHaveBeenCalledWith(expect.objectContaining({
            stage: 'relationships',
            claim: relationshipClaim,
            state: initial,
        }));
        expect(dagStore.checkpointManifest).toHaveBeenCalledWith(
            relationshipClaim,
            { kind: 'relationships', manifest }
        );
        expect(dagStore.load).toHaveBeenCalledTimes(2);
        expect(progress.report).toHaveBeenCalledWith({
            claim: relationshipClaim,
            state: completed,
            stage: 'relationships',
        });
        const fanout = vi.mocked(jobStore.completeAndFanout).mock.calls[0][1];
        expect(fanout.map(job => job.jobKey)).toEqual([
            'track:profiles:batch:0',
            'track:profiles:batch:1',
            'track:private-names:batch:0',
        ]);
        expect(fanout.every(job => job.requiredJobKeys?.includes(relationshipClaim.jobKey)))
            .toBe(true);
    });

    it('wires an exact profile-start callback to the fenced progress heartbeat', async () => {
        const initial: AnalysisV2DagState = {
            ...baseState(),
            relationships: relationshipManifest(),
        };
        const profileClaim = claimFor(initial, 'track:profiles:batch:0');
        const profileManifest = {
            batch: 0,
            itemCount: 30,
            producerInputHash: profileClaim.inputHash,
            revision: 1,
            resultHash: digest('profile-fetch-result'),
        };
        const completed: AnalysisV2DagState = {
            ...initial,
            profileFetchBatches: [profileManifest],
        };
        let current = initial;
        const dagStore = stateStore(initial, {
            load: vi.fn(async () => current),
            checkpointManifest: vi.fn(async () => {
                current = completed;
                return current;
            }),
        });
        const progress = progressReporter();
        progress.heartbeat = vi.fn(async () => true);
        const executor: NonNullable<AnalysisV2StageExecutorRegistry['profile_fetch']> =
            vi.fn(async (context) => {
                await context.reportActiveProfile?.('Candidate.One');
                await context.reportActiveProfile?.('Candidate.Two');
                return {
                    checkpoint: {
                        kind: 'profile_fetch_batch' as const,
                        manifest: profileManifest,
                    },
                };
            });

        await executeAnalysisV2FoundationJob(profileClaim, {
            stateStore: dagStore,
            executors: { profile_fetch: executor },
            progressReporter: progress,
        });

        expect(progress.heartbeat).toHaveBeenNthCalledWith(1, expect.objectContaining({
            claim: profileClaim,
            stage: 'profile_fetch',
            username: 'Candidate.One',
            startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            totalCount: 30,
        }));
        expect(progress.heartbeat).toHaveBeenNthCalledWith(2, expect.objectContaining({
            claim: profileClaim,
            stage: 'profile_fetch',
            username: 'Candidate.Two',
            startedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
            totalCount: 30,
        }));
        const calls = vi.mocked(progress.heartbeat!).mock.calls;
        expect(Date.parse(calls[1]![0].startedAt)).toBeGreaterThan(
            Date.parse(calls[0]![0].startedAt)
        );
        expect(progress.report).toHaveBeenCalledOnce();
        expect(dagStore.checkpointManifest).toHaveBeenCalledBefore(
            vi.mocked(progress.report)
        );
    });

    it('does not advance canonical progress when durable manifest persistence fails', async () => {
        const initial: AnalysisV2DagState = {
            ...baseState(),
            relationships: relationshipManifest(),
        };
        const profileClaim = claimFor(initial, 'track:profiles:batch:0');
        const profileManifest = {
            batch: 0,
            itemCount: 30,
            producerInputHash: profileClaim.inputHash,
            revision: 1,
            resultHash: digest('profile-fetch-result-persistence-failure'),
        };
        const dagStore = stateStore(initial, {
            checkpointManifest: vi.fn(async () => {
                throw new Error('MANIFEST_PERSISTENCE_FAILED');
            }),
        });
        const progress = progressReporter();
        progress.heartbeat = vi.fn(async () => true);
        const executor: NonNullable<AnalysisV2StageExecutorRegistry['profile_fetch']> =
            vi.fn(async context => {
                await context.reportActiveProfile?.('Candidate.One');
                return {
                    checkpoint: {
                        kind: 'profile_fetch_batch' as const,
                        manifest: profileManifest,
                    },
                };
            });

        await expect(executeAnalysisV2FoundationJob(profileClaim, {
            stateStore: dagStore,
            executors: { profile_fetch: executor },
            progressReporter: progress,
        })).rejects.toThrow('MANIFEST_PERSISTENCE_FAILED');

        expect(progress.heartbeat).toHaveBeenCalledOnce();
        expect(progress.report).not.toHaveBeenCalled();
    });

    it('replays a persisted checkpoint without repeating provider work after completion failure', async () => {
        const initial = baseState();
        const manifest = relationshipManifest();
        const completed: AnalysisV2DagState = { ...initial, relationships: manifest };
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        let current = initial;
        const dagStore = stateStore(initial, {
            load: vi.fn(async () => current),
            checkpointManifest: vi.fn(async () => {
                current = completed;
                return current;
            }),
        });
        const executor = vi.fn(async () => ({
            checkpoint: { kind: 'relationships' as const, manifest },
        }));
        const completeAndFanout = vi.fn()
            .mockRejectedValueOnce(new Error('completion RPC unavailable'))
            .mockResolvedValueOnce([]);
        const jobStore = store(relationshipClaim, { completeAndFanout });
        const input = {
            store: jobStore,
            stateStore: dagStore,
            executors: { relationships: executor },
        };
        const relationshipDelivery = { ...delivery, jobKey: relationshipClaim.jobKey };

        await expect(processAnalysisV2TaskDelivery(relationshipDelivery, input))
            .rejects.toThrow('completion RPC unavailable');
        await expect(processAnalysisV2TaskDelivery(relationshipDelivery, input))
            .resolves.toMatchObject({ status: 'completed' });

        expect(executor).toHaveBeenCalledOnce();
        expect(dagStore.checkpointManifest).toHaveBeenCalledOnce();
        expect(completeAndFanout).toHaveBeenCalledTimes(2);
        expect(completeAndFanout).toHaveBeenLastCalledWith(
            relationshipClaim,
            expect.arrayContaining([
                expect.objectContaining({ jobKey: 'track:profiles:batch:0' }),
            ])
        );
    });

    it('fails closed when a concrete stage has no registered executor', async () => {
        const initial = baseState();
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const jobStore = store(relationshipClaim);
        const terminalFailureFinalizer = vi.fn(async () => undefined);
        const terminalMediaCleanup = vi.fn(async () => undefined);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: stateStore(initial),
            terminalFailureFinalizer,
            terminalMediaCleanup,
        })).resolves.toEqual({
            status: 'failed',
            errorCode: 'ANALYSIS_V2_JOB_HANDLER_UNAVAILABLE',
        });
        expect(terminalFailureFinalizer).toHaveBeenCalledOnce();
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(jobStore.completeAndFanout).not.toHaveBeenCalled();
    });

    it('classifies deterministic, transient, and fence executor failures explicitly', () => {
        for (const message of [
            'ANALYSIS_V2_STAGE_INVALID_JSON',
            'ANALYSIS_V2_REVERSE_LIKE_BUDGET_EXCEEDED',
            'ANALYSIS_V2_PROFILE_AI_BATCH_DRIFT',
            'ANALYSIS_V2_PROFILE_EVIDENCE_INCOMPLETE',
            'ANALYSIS_V2_REVERSE_LIKE_RESULT_LIMIT_EXCEEDED',
            'ANALYSIS_V2_AI_SCORING_STAGE_CONFLICT',
            'ANALYSIS_V2_RESULT_VALIDATION_ERROR: invalid result.',
            'ANALYSIS_V2_AI_RESULT_PERSISTENCE_ERROR: invalid cache response.',
            'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: invalid load response.',
            'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: metadata mismatch.',
            'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: object read failed (403).',
        ]) {
            expect(classifyAnalysisV2JobFailure(new Error(message))).toMatchObject({
                disposition: 'permanent',
                retryable: false,
            });
        }
        for (const message of [
            'ANALYSIS_V2_PROFILE_CONSUMER_NOT_READY',
            'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: reserve failed (08006).',
            'ANALYSIS_V2_AI_SCORING_STAGE_PERSISTENCE_ERROR: rpc failed (08006).',
            'ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT',
            'AI_RATE_LIMIT_ERROR: provider rejected before generation.',
            'fetch failed: ECONNRESET',
            'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: primary checkpoint failed (08006).',
            'ANALYSIS_V2_PROFILE_CHECKPOINT_ERROR: fallback checkpoint failed (PGRST000).',
            'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: object write failed (429).',
            'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: object read failed (503).',
            'ANALYSIS_V2_MEDIA_ARTIFACT_OBJECT_ERROR: object read failed (unknown).',
        ]) {
            expect(classifyAnalysisV2JobFailure(new Error(message))).toMatchObject({
                disposition: 'transient',
                retryable: true,
            });
        }
        expect(classifyAnalysisV2JobFailure(
            new Error('ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR: reserve failed (08006).')
        )).toMatchObject({
            code: 'ANALYSIS_V2_AI_ATTEMPT_PERSISTENCE_ERROR',
            disposition: 'transient',
            retryable: true,
        });
        for (const code of [
            'ANALYSIS_V2_PROFILE_AI_CHECKPOINT_COUNT_DRIFT',
            'ANALYSIS_V2_PRIVATE_NAME_CHECKPOINT_COUNT_DRIFT',
            'ANALYSIS_V2_SCREENING_CHECKPOINT_COUNT_DRIFT',
            'ANALYSIS_V2_REVERSE_LIKES_CHECKPOINT_COUNT_DRIFT',
            'ANALYSIS_V2_PARTNER_SAFETY_CHECKPOINT_COUNT_DRIFT',
            'ANALYSIS_V2_FINAL_SCORE_CHECKPOINT_COUNT_DRIFT',
            'ANALYSIS_V2_NARRATIVE_CHECKPOINT_COUNT_DRIFT',
            'INVALID_CAROUSEL_METADATA',
            'CAROUSEL_COMPLETENESS_MISMATCH',
            'RISK_POLICY_ERROR',
        ]) {
            expect(classifyAnalysisV2JobFailure(new Error(code))).toMatchObject({
                code,
                disposition: 'permanent',
                retryable: false,
            });
        }
        expect(classifyAnalysisV2JobFailure(
            new Error('ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH')
        )).toMatchObject({ disposition: 'fence', retryable: false });
        expect(classifyAnalysisV2JobFailure(
            new Error('schema rejected https://private.example/user.name')
        )).toMatchObject({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            disposition: 'permanent',
        });
        expect(classifyAnalysisV2JobFailure(
            new Error(`${'A'.repeat(65)}: oversized provider prefix`)
        )).toMatchObject({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            disposition: 'permanent',
            retryable: false,
        });
        expect(classifyAnalysisV2JobFailure(
            new Error('APIFY_TOKEN_PROVIDER_SECRET_ERROR: provider-secret')
        )).toMatchObject({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            disposition: 'permanent',
            retryable: false,
        });
        expect(new AnalysisV2JobExecutionError(
            'APIFY_TOKEN_PROVIDER_SECRET_ERROR',
            true
        )).toMatchObject({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            disposition: 'permanent',
            retryable: false,
        });
        expect(new AnalysisV2JobExecutionError('A'.repeat(65), true)).toMatchObject({
            code: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
            disposition: 'permanent',
            retryable: false,
        });
    });

    it('terminalizes a deterministic executor error after one call', async () => {
        const handler = vi.fn(async () => {
            throw new Error('ANALYSIS_V2_RUNTIME_DEPENDENCY_VALIDATION_ERROR: invalid input.');
        });
        const jobStore = store(bootstrapClaim);
        const terminalFailureFinalizer = vi.fn(async () => undefined);

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler,
            terminalFailureFinalizer,
            terminalMediaCleanup: vi.fn(async () => undefined),
        })).resolves.toEqual({
            status: 'failed',
            errorCode: 'ANALYSIS_V2_RUNTIME_DEPENDENCY_VALIDATION_ERROR',
        });
        expect(handler).toHaveBeenCalledOnce();
        expect(terminalFailureFinalizer).toHaveBeenCalledOnce();
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
    });

    it('acknowledges a lost stage fence without terminalizing through a stale claim', async () => {
        const jobStore = store(bootstrapClaim);
        const terminalFailureFinalizer = vi.fn(async () => undefined);
        const terminalMediaCleanup = vi.fn(async () => undefined);

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('ANALYSIS_V2_AI_SCORING_STAGE_FENCE_MISMATCH');
            },
            terminalFailureFinalizer,
            terminalMediaCleanup,
        })).rejects.toBeInstanceOf(AnalysisV2JobFenceError);
        expect(terminalFailureFinalizer).not.toHaveBeenCalled();
        expect(terminalMediaCleanup).not.toHaveBeenCalled();
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
    });

    it('retries only transient failures and terminalizes the seventh call', async () => {
        const handler = vi.fn(async () => {
            throw new Error('ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT');
        });
        const terminalFailureFinalizer = vi.fn(async () => undefined);
        const outcomes: Awaited<ReturnType<typeof processAnalysisV2TaskDelivery>>[] = [];
        for (let attemptCount = 1; attemptCount <= ANALYSIS_V2_JOB_MAX_ATTEMPTS; attemptCount++) {
            const claimed = { ...bootstrapClaim, attemptCount };
            outcomes.push(await processAnalysisV2TaskDelivery(delivery, {
                store: store(claimed),
                handler,
                terminalFailureFinalizer,
                terminalMediaCleanup: vi.fn(async () => undefined),
            }));
        }

        expect(handler).toHaveBeenCalledTimes(ANALYSIS_V2_JOB_MAX_ATTEMPTS);
        expect(outcomes.slice(0, -1)).toEqual(Array.from(
            { length: ANALYSIS_V2_JOB_MAX_ATTEMPTS - 1 },
            () => ({ status: 'retry', errorCode: 'ANALYSIS_V2_MEDIA_PREPARATION_TRANSIENT' })
        ));
        expect(outcomes.at(-1)).toEqual({
            status: 'failed',
            errorCode: 'JOB_ATTEMPTS_EXHAUSTED',
        });
        expect(terminalFailureFinalizer).toHaveBeenCalledOnce();
    });

    it('keeps a dependency-complete finalizer retryable beyond the generic limit', async () => {
        const finalizerClaim: ClaimedAnalysisV2Job = {
            ...bootstrapClaim,
            jobKey: ANALYSIS_V2_FINALIZE_JOB_KEY,
            kind: 'finalizer',
            attemptCount: ANALYSIS_V2_JOB_MAX_ATTEMPTS,
        };
        const jobStore = store(finalizerClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: ANALYSIS_V2_FINALIZE_JOB_KEY,
        }, {
            store: jobStore,
            handler: async () => {
                throw new Error('ANALYSIS_V2_RESULT_NOT_READY');
            },
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_RESULT_NOT_READY',
        });
        expect(jobStore.releaseClaim).toHaveBeenCalledWith(
            finalizerClaim,
            {
                errorCode: 'ANALYSIS_V2_RESULT_NOT_READY',
                retryable: true,
                maxAttempts: ANALYSIS_V2_FINALIZER_MAX_ATTEMPTS,
            }
        );
    });

    it.each([
        'ANALYSIS_V2_AI_CAPACITY_PENDING',
        'ANALYSIS_V2_AI_DEADLINE_TOO_SHORT',
        'ANALYSIS_V2_AI_QUARANTINE_ACTIVE',
    ] as const)('defers %s without consuming the job failure budget', async code => {
        const claimed = {
            ...bootstrapClaim,
            attemptCount: ANALYSIS_V2_JOB_MAX_ATTEMPTS,
        };
        const jobStore = store(claimed);
        const terminalFailureFinalizer = vi.fn();

        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error(code);
            },
            terminalFailureFinalizer,
        })).resolves.toEqual({
            status: 'retry',
            errorCode: code,
        });
        expect(jobStore.deferAiCapacity).toHaveBeenCalledWith(claimed, code);
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(terminalFailureFinalizer).not.toHaveBeenCalled();
    });

    it('classifies transient checkpoint persistence and explicit provider failures as retryable', async () => {
        const initial = baseState();
        const manifest = relationshipManifest();
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const persistenceStore = stateStore(initial, {
            checkpointManifest: vi.fn(async () => {
                throw new Error('ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR: unavailable.');
            }),
        });
        const executor = vi.fn(async () => ({
            checkpoint: { kind: 'relationships' as const, manifest },
        }));

        const persistenceJobStore = store(relationshipClaim);
        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: persistenceJobStore,
            stateStore: persistenceStore,
            executors: { relationships: executor },
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'ANALYSIS_V2_DAG_STATE_PERSISTENCE_ERROR',
        });

        const providerJobStore = store(relationshipClaim);
        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: providerJobStore,
            stateStore: stateStore(initial),
            executors: {
                relationships: async () => {
                    throw new AnalysisV2JobExecutionError('PROVIDER_RATE_LIMITED', true);
                },
            },
        })).resolves.toEqual({
            status: 'retry',
            errorCode: 'PROVIDER_RATE_LIMITED',
        });
        expect(providerJobStore.releaseClaim).toHaveBeenCalledWith(
            relationshipClaim,
            {
                errorCode: 'PROVIDER_RATE_LIMITED',
                retryable: true,
                maxAttempts: ANALYSIS_V2_JOB_MAX_ATTEMPTS,
            }
        );
    });

    it.each([
        'SCRAPING_RUN_PENDING_ERROR: retry the persisted Actor run.',
        'SCRAPING_DATASET_TRANSIENT_ERROR: retry the persisted Actor dataset.',
    ])('classifies resumable paid-provider lifecycle errors as transient: %s', async message => {
        const initial = baseState();
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY);
        const jobStore = store(relationshipClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: stateStore(initial),
            executors: {
                relationships: async () => {
                    throw new Error(message);
                },
            },
        })).resolves.toMatchObject({
            status: 'retry',
            errorCode: message.split(':', 1)[0],
        });
        expect(jobStore.releaseClaim).toHaveBeenCalledOnce();
    });

    it('does not retry ambiguous starts or truly terminal Actor failures', () => {
        expect(classifyAnalysisV2JobFailure(
            new Error('SCRAPING_AMBIGUOUS_START_ERROR: start response was not confirmed.')
        )).toMatchObject({ disposition: 'permanent', retryable: false });
        expect(classifyAnalysisV2JobFailure(
            new Error('SCRAPING_ERROR: Apify actor failed (status=FAILED).')
        )).toMatchObject({ disposition: 'permanent', retryable: false });
        expect(classifyAnalysisV2JobFailure(
            new Error('SCRAPING_ERROR: Apify actor failed (status=ABORTED).')
        )).toMatchObject({ disposition: 'permanent', retryable: false });
        expect(classifyAnalysisV2JobFailure(
            new Error('SCRAPING_ERROR: Apify actor failed (status=TIMED-OUT).')
        )).toMatchObject({ disposition: 'permanent', retryable: false });
        expect(classifyAnalysisV2JobFailure(
            new Error('SCRAPING_PROVIDER_QUOTA_ERROR')
        )).toMatchObject({
            code: 'SCRAPING_PROVIDER_QUOTA_ERROR',
            disposition: 'permanent',
            retryable: false,
        });
    });

    it('atomically terminalizes a retryable failure on the final attempt', async () => {
        const initial = baseState();
        const relationshipClaim = claimFor(initial, ANALYSIS_V2_RELATIONSHIPS_JOB_KEY, {
            attemptCount: ANALYSIS_V2_JOB_MAX_ATTEMPTS,
        });
        const jobStore = store(relationshipClaim);
        const terminalFailureFinalizer = vi.fn(async () => undefined);
        const terminalMediaCleanup = vi.fn(async () => {
            throw new Error('temporary cleanup failure');
        });

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: relationshipClaim.jobKey,
        }, {
            store: jobStore,
            handler: async () => {
                throw new AnalysisV2JobExecutionError('PROVIDER_RATE_LIMITED', true);
            },
            terminalFailureFinalizer,
            terminalMediaCleanup,
        })).resolves.toEqual({
            status: 'failed',
            errorCode: 'JOB_ATTEMPTS_EXHAUSTED',
        });
        expect(terminalFailureFinalizer).toHaveBeenCalledWith(
            relationshipClaim,
            'JOB_ATTEMPTS_EXHAUSTED'
        );
        expect(terminalMediaCleanup).toHaveBeenCalledOnce();
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
    });

    it('completes an idempotent finalizer with no DAG checkpoint or successor', async () => {
        const completeState: AnalysisV2DagState = {
            ...baseState(),
            relationships: {
                revision: 1,
                resultHash: digest('empty-relationships'),
                detectedMutualCount: 0,
                publicCount: 0,
                privateCount: 0,
                detailedSelectedPublicCount: 0,
                notScreenedPublicCount: 0,
                profileBatches: [],
                privateNameBatches: [],
            },
            targetEvidence: {
                revision: 1,
                resultHash: digest('empty-target-evidence'),
                interactorCount: 0,
            },
            primaryJoin: {
                revision: 1,
                resultHash: digest('empty-primary-join'),
                verifiedFemaleCount: 0,
            },
            screening: {
                revision: 1,
                resultHash: digest('empty-screening'),
                verifiedFemaleCount: 0,
                shortlistCount: 0,
                shortlistHash: digest('empty-shortlist'),
            },
            reverseLikes: {
                revision: 1,
                resultHash: digest('empty-reverse-likes'),
                shortlistCount: 0,
            },
            partnerSafety: {
                revision: 1,
                resultHash: digest('empty-partner-safety'),
                shortlistCount: 0,
            },
            finalScore: {
                revision: 1,
                resultHash: digest('empty-final-score'),
                featuredHighRiskCount: 0,
                narrativeCount: 0,
                narrativeBatchHash: digest('empty-narrative-batch'),
            },
            narrative: {
                revision: 1,
                resultHash: digest('empty-narrative'),
                narrativeCount: 0,
            },
        };
        const finalizerClaim = claimFor(completeState, ANALYSIS_V2_FINALIZE_JOB_KEY);
        const dagStore = stateStore(completeState);
        const finalizer = vi.fn(async () => ({ checkpoint: null }));
        const jobStore = store(finalizerClaim);

        await expect(processAnalysisV2TaskDelivery({
            ...delivery,
            jobKey: finalizerClaim.jobKey,
        }, {
            store: jobStore,
            stateStore: dagStore,
            executors: { finalize: finalizer },
        })).resolves.toEqual({
            status: 'completed',
            successorCount: 0,
            pendingRecoveryCount: 0,
        });
        expect(finalizer).toHaveBeenCalledOnce();
        expect(dagStore.checkpointManifest).not.toHaveBeenCalled();
        expect(jobStore.completeAndFanout).toHaveBeenCalledWith(finalizerClaim, []);
    });

    it('fails closed on an opaque legacy handler error without retrying private details', async () => {
        const jobStore = store(bootstrapClaim);
        const terminalFailureFinalizer = vi.fn(async () => undefined);
        await expect(processAnalysisV2TaskDelivery(delivery, {
            store: jobStore,
            handler: async () => {
                throw new Error('provider detail');
            },
            terminalFailureFinalizer,
            terminalMediaCleanup: vi.fn(async () => undefined),
        })).resolves.toEqual({
            status: 'failed',
            errorCode: 'ANALYSIS_V2_JOB_HANDLER_FAILED',
        });
        expect(terminalFailureFinalizer).toHaveBeenCalledWith(
            bootstrapClaim,
            'ANALYSIS_V2_JOB_HANDLER_FAILED'
        );
        expect(jobStore.releaseClaim).not.toHaveBeenCalled();
        expect(jobStore.completeAndFanout).not.toHaveBeenCalled();
    });
});
