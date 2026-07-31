import { describe, expect, it, vi } from 'vitest';
import {
    AI_STAGE_POLICY_LATEST_VERSION,
    AI_STAGE_POLICY_V28_VERSION,
    AI_STAGE_POLICY_V29_VERSION,
    AI_STAGE_POLICY_V210_VERSION,
    AI_STAGE_POLICY_VERSION,
} from '@/lib/services/ai/stage-policy';
import type { GenderTriageInput } from '@/lib/services/ai/v2-staged-analysis';

vi.mock('@/lib/observability/server', () => ({
    operationalLogger: { emit: vi.fn() },
}));
import {
    createDurableAnalysisV2AiStageRuntime,
    type AnalysisV2AiStageRuntimeDependencies,
} from './v2-ai-stage-runtime';
import {
    AnalysisV2AiResultRecoveredCutoffError,
    AnalysisV2AiResultRecoveryPendingError,
} from './v2-ai-result-store';
import type { AnalysisV2SchedulerRuntimeOptions } from './v2-ai-scheduler-runtime';

vi.mock('@/lib/supabase/admin', () => ({ supabaseAdmin: {} }));

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const claimToken = '223e4567-e89b-42d3-a456-426614174000'; // gitleaks:allow
const fence = {
    requestId,
    claimToken,
    jobKey: 'track:profile-ai:batch:0',
    aiStagePolicyVersion: AI_STAGE_POLICY_VERSION,
};

function cachedAuditFactory(input: {
    gender?: unknown;
    privateNames?: unknown;
}) {
    const beforeAttempt = vi.fn();
    const attemptTelemetry = vi.fn();
    const createAudit: NonNullable<AnalysisV2AiStageRuntimeDependencies['createAudit']> =
        options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            async prepare() {
                const raw = options.resultIdentity.stage === 'genderTriage'
                    ? input.gender
                    : input.privateNames;
                return {
                    result: options.resultSchema.parse(raw),
                    source: 'request',
                    startingAttempt: 1,
                };
            },
            onBeforeAttempt: beforeAttempt,
            onAttemptTelemetry: attemptTelemetry,
        });
    return { createAudit, beforeAttempt, attemptTelemetry };
}

describe('durable V2 AI stage runtime', () => {
    it('rejects every cross-version job before creating an audit or calling Gemini', async () => {
        const dependencies = {
            createAudit: vi.fn(),
            runGender: vi.fn(),
            runGenderResolution: vi.fn(),
            runFeatures: vi.fn(),
            runPrivateNames: vi.fn(),
            runPartnerSafety: vi.fn(),
            runNarrative: vi.fn(),
        } satisfies AnalysisV2AiStageRuntimeDependencies;
        const runtime = createDurableAnalysisV2AiStageRuntime(dependencies);
        const staleFence = { ...fence, aiStagePolicyVersion: 'ai-stage-policy-v2.3' };
        const invocations = [
            () => runtime.gender({ media: [] }, staleFence),
            () => runtime.features({} as never, staleFence),
            () => runtime.privateNames([], staleFence),
            () => runtime.partnerSafety({} as never, staleFence),
            () => runtime.narrative({} as never, staleFence),
        ];

        for (const invoke of invocations) {
            await expect(invoke()).rejects.toThrow('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');
        }
        expect(() => runtime.startGenderResolution({ media: [] }, staleFence))
            .toThrow('ANALYSIS_V2_AI_STAGE_POLICY_MISMATCH');

        for (const dependency of Object.values(dependencies)) {
            expect(dependency).not.toHaveBeenCalled();
        }
    });

    it('starts a v2.7 resolver and exposes only an audited ready result', async () => {
        const onCutoff = vi.fn().mockResolvedValue(undefined);
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: onCutoff,
        }));
        const runGenderResolution = vi.fn().mockResolvedValue({
            assessment: {
                inferredGender: 'female',
                confidence: 'high',
                ownerConsistency: 'same_person',
                evidenceSelectionIds: ['profile:owner', 'post:owner:thumbnail'],
            },
            analyzedSelectionIds: ['profile:owner', 'post:owner:thumbnail'],
        });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({
            media: [{
                selectionId: 'profile:owner',
                kind: 'profile',
                normalizedJpegBase64: '/9j/2Q==',
            }, {
                selectionId: 'post:owner:thumbnail',
                kind: 'feed',
                normalizedJpegBase64: '/9j/2g==',
                postId: 'owner-post',
            }],
        }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        expect(handle.peek()).toEqual({ status: 'pending' });
        await handle.completion;
        expect(handle.peek()).toMatchObject({
            status: 'ready',
            value: {
                result: {
                    assessment: { inferredGender: 'female' },
                },
                operationKey: expect.stringMatching(/^gender-resolution:[a-f0-9]{64}$/),
                resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
                source: 'checkpoint',
            },
        });
        expect(runGenderResolution).toHaveBeenCalledWith(
            expect.any(Object),
            expect.any(Object),
            expect.objectContaining({ abortSignal: expect.any(AbortSignal) }),
        );
        expect(onCutoff).not.toHaveBeenCalled();
    });

    it('keeps the resolver available for v2.8 instead of coupling it to the old latest label', async () => {
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: vi.fn(),
        }));
        const runGenderResolution = vi.fn().mockResolvedValue({
            assessment: {
                inferredGender: 'unknown',
                confidence: 'low',
                ownerConsistency: 'not_visible',
                evidenceSelectionIds: [],
            },
            analyzedSelectionIds: [],
        });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V28_VERSION,
        });
        await handle.completion;
        expect(handle.peek()).toMatchObject({ status: 'ready' });
        expect(runGenderResolution).toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            expect.objectContaining({ aiStagePolicyVersion: AI_STAGE_POLICY_V28_VERSION }),
        );
    });

    it('cuts off a pending resolver without waiting for the provider promise', async () => {
        const onCutoff = vi.fn().mockResolvedValue(undefined);
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: onCutoff,
        }));
        const runGenderResolution = vi.fn<
            NonNullable<AnalysisV2AiStageRuntimeDependencies['runGenderResolution']>
        >((_input, _audit, options) => (
            new Promise<never>((_resolve, reject) => {
                options?.abortSignal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('aborted', 'AbortError')),
                    { once: true },
                );
            })
        ));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        await handle.cutoff();

        expect(handle.peek()).toEqual({ status: 'cutoff' });
        expect(onCutoff).toHaveBeenCalledOnce();
        await handle.completion;
    });

    it.each([
        {
            label: 'never settles',
            cutoff: () => new Promise<void>(() => undefined),
            expectedError: 'ANALYSIS_V2_GENDER_RESOLUTION_CUTOFF_PERSISTENCE_ERROR',
        },
        {
            label: 'rejects',
            cutoff: () => Promise.reject(new Error('temporary cutoff bookkeeping failure')),
            expectedError: 'temporary cutoff bookkeeping failure',
        },
    ])('bounds resolver cutoff bookkeeping when it $label', async scenario => {
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: vi.fn(scenario.cutoff),
        }));
        const runGenderResolution = vi.fn<
            NonNullable<AnalysisV2AiStageRuntimeDependencies['runGenderResolution']>
        >((_input, _audit, options) => (
            new Promise<never>((_resolve, reject) => {
                options?.abortSignal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('aborted', 'AbortError')),
                    { once: true },
                );
            })
        ));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        const outcome = await Promise.race([
            handle.cutoff().then(
                () => ({ status: 'resolved' as const }),
                (error: unknown) => ({ status: 'rejected' as const, error }),
            ),
            new Promise<{ status: 'timed_out' }>(resolve => {
                setTimeout(() => resolve({ status: 'timed_out' }), 100);
            }),
        ]);

        expect(outcome.status).toBe('rejected');
        if (outcome.status === 'rejected') {
            expect(outcome.error).toEqual(expect.objectContaining({
                message: scenario.expectedError,
            }));
        }
        expect(handle.peek()).toEqual({ status: 'cutoff' });
        await handle.completion;
    });

    it('preserves an immediate resolver cutoff bookkeeping rejection', async () => {
        const persistenceFailure = new Error('DATABASE_FENCE_REJECTED');
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn(),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff: vi.fn().mockRejectedValue(persistenceFailure),
        }));
        const runGenderResolution = vi.fn<
            NonNullable<AnalysisV2AiStageRuntimeDependencies['runGenderResolution']>
        >((_input, _audit, options) => (
            new Promise<never>((_resolve, reject) => {
                options?.abortSignal?.addEventListener(
                    'abort',
                    () => reject(new DOMException('aborted', 'AbortError')),
                    { once: true },
                );
            })
        ));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit,
            runGenderResolution,
        });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        await expect(handle.cutoff()).rejects.toBe(persistenceFailure);
        expect(handle.peek()).toEqual({ status: 'cutoff' });
        await handle.completion;
    });

    it.each([
        {
            label: 'reserved attempt awaiting exact recovery',
            error: new AnalysisV2AiResultRecoveryPendingError(),
            status: 'recovery_pending' as const,
            cutoffRejects: true,
        },
        {
            label: 'durably recovered cutoff',
            error: new AnalysisV2AiResultRecoveredCutoffError(),
            status: 'cutoff' as const,
            cutoffRejects: false,
        },
    ])('reconstructs a $label without exposing terminal_unavailable', async scenario => {
        const cutoff = vi.fn().mockRejectedValue(scenario.error);
        const createAudit = vi.fn(options => ({
            requestId: options.requestId,
            operationKey: options.resultIdentity.operationKey,
            resultIdentity: options.resultIdentity,
            resultSchema: options.resultSchema,
            prepare: vi.fn().mockRejectedValue(scenario.error),
            onBeforeAttempt: vi.fn(),
            onAttemptTelemetry: vi.fn(),
            cutoff,
        }));
        const runtime = createDurableAnalysisV2AiStageRuntime({ createAudit });
        const handle = runtime.startGenderResolution({ media: [] }, {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_LATEST_VERSION,
        });

        await handle.completion;
        expect(handle.peek()).toEqual({ status: scenario.status });
        await expect(handle.cutoff()).resolves.toBeUndefined();
        expect(handle.peek()).not.toEqual({ status: 'terminal_unavailable' });
    });

    it('replays the same cached gender operation without opening another provider attempt', async () => {
        const cached = cachedAuditFactory({
            gender: {
                inferredGender: 'male',
                confidence: 'high',
                ownerConsistency: 'same_person',
                evidenceSelectionIds: ['profile:owner', 'post:owner:thumbnail'],
            },
        });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit: cached.createAudit,
        });
        const input = {
            media: [{
                selectionId: 'profile:owner',
                kind: 'profile' as const,
                normalizedJpegBase64: '/9j/2Q==',
            }, {
                selectionId: 'post:owner:thumbnail',
                kind: 'feed' as const,
                normalizedJpegBase64: '/9j/2g==',
                postId: 'owner-post',
            }],
        };

        const first = await runtime.gender(input, fence);
        const replay = await runtime.gender(input, fence);

        expect(first.result.routingDecision).toBe('exclude_high_confidence_male');
        expect(replay.operationKey).toBe(first.operationKey);
        expect(replay.resultHash).toBe(first.resultHash);
        expect(cached.beforeAttempt).not.toHaveBeenCalled();
        expect(cached.attemptTelemetry).not.toHaveBeenCalled();
    });

    it('wraps private-name arrays in a durable object envelope without losing rows', async () => {
        const results = [
            { id: 'candidate:one', femaleScore: 0.9, isName: true, confidence: 0.8 },
            { id: 'candidate:two', femaleScore: 0.5, isName: false, confidence: 0 },
        ];
        const cached = cachedAuditFactory({ privateNames: { results } });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            createAudit: cached.createAudit,
        });

        const analyzed = await runtime.privateNames([
            { id: 'candidate:one', username: 'woman.one', fullName: '하나' },
            { id: 'candidate:two', username: 'brand.two', fullName: '브랜드' },
        ], { ...fence, jobKey: 'track:private-names:batch:0' });

        expect(analyzed.results).toEqual(results);
        expect(analyzed.source).toBe('checkpoint');
        expect(analyzed.operationKey).toMatch(/^private-account-name:[a-f0-9]{64}$/);
        expect(analyzed.resultHash).toMatch(/^[a-f0-9]{64}$/);
        expect(cached.beforeAttempt).not.toHaveBeenCalled();
    });

    it('microbatches concurrent v2.8 gender operations behind one durable scheduler', async () => {
        const runGender = vi.fn(async (input: GenderTriageInput) => ({
            assessment: {
                inferredGender: 'unknown' as const,
                confidence: 'low' as const,
                ownerConsistency: 'not_visible' as const,
                evidenceSelectionIds: [],
            },
            routingDecision: 'route_to_feature_analysis' as const,
            routingReason: 'conserve_female_recall' as const,
            analyzedSelectionIds: input.media.map(item => item.selectionId),
        }));
        const schedulerCalls: AnalysisV2SchedulerRuntimeOptions<unknown>[] = [];
        const runScheduler = vi.fn(async (
            options: AnalysisV2SchedulerRuntimeOptions<unknown>,
        ) => {
            schedulerCalls.push(options);
            const completed = await Promise.all(options.tasks.map(async item => ({
                key: item.key,
                stage: item.stage,
                value: await item.run(),
            })));
            return {
                status: 'completed' as const,
                completed,
                remainingKeys: [],
                recoveryPendingKeys: [],
                terminalUnavailableKeys: [],
                continuationDelayMs: 1_000,
            };
        });
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runGender,
            runScheduler: runScheduler as typeof import(
                './v2-ai-scheduler-runtime'
            ).runAnalysisV2FairAiScheduler,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(),
                commitReady: vi.fn(),
            })) as typeof import(
                './v2-ai-scheduler-operation-store'
            ).createAnalysisV2SchedulerOperationStore,
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(),
                onBeforeAttempt: vi.fn(),
                onAttemptTelemetry: vi.fn(),
            })),
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V28_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };
        const media = (suffix: string) => ({
            media: [{
                selectionId: `profile:${suffix}`,
                kind: 'profile' as const,
                normalizedJpegBase64: '/9j/2Q==',
            }],
        });

        const [first, second] = await Promise.all([
            runtime.gender(media('first'), scheduledFence),
            runtime.gender(media('second'), scheduledFence),
        ]);

        expect(schedulerCalls).toHaveLength(1);
        expect(schedulerCalls[0]!.tasks).toHaveLength(2);
        expect(schedulerCalls[0]!.tasks.every(item => (
            typeof item.recover === 'function'
            && typeof item.terminalFallback === 'function'
        ))).toBe(true);
        expect(runGender).toHaveBeenCalledTimes(2);
        expect(first.operationKey).not.toBe(second.operationKey);
    });

    it('rejects only the scheduler plan reported as terminal unavailable', async () => {
        const runScheduler = vi.fn(async (
            options: AnalysisV2SchedulerRuntimeOptions<unknown>,
        ) => ({
            status: 'completed' as const,
            completed: [],
            remainingKeys: [],
            recoveryPendingKeys: [],
            terminalUnavailableKeys: options.tasks.map(task => task.key),
            continuationDelayMs: 1_000,
        }));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runScheduler: runScheduler as typeof import('./v2-ai-scheduler-runtime')
                .runAnalysisV2FairAiScheduler,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(),
                commitReady: vi.fn(),
            })) as typeof import('./v2-ai-scheduler-operation-store')
                .createAnalysisV2SchedulerOperationStore,
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V28_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };

        await expect(runtime.gender({
            media: [{
                selectionId: 'profile:terminal',
                kind: 'profile',
                normalizedJpegBase64: '/9j/2Q==',
            }],
        }, scheduledFence)).rejects.toThrow('ANALYSIS_V2_AI_TERMINAL_UNAVAILABLE');
    });

    it('keeps v2.10 on the v2.9 microbatch scheduler path while binding its own immutable policy', async () => {
        const runGenderMicrobatch = vi.fn(async (
            accounts: readonly { accountId: string; input: GenderTriageInput }[],
        ) => accounts.map(account => ({
            accountId: account.accountId,
            result: {
                assessment: {
                    inferredGender: 'unknown' as const,
                    confidence: 'low' as const,
                    ownerConsistency: 'not_visible' as const,
                    evidenceSelectionIds: [],
                },
                routingDecision: 'route_to_feature_analysis' as const,
                routingReason: 'conserve_female_recall' as const,
                analyzedSelectionIds: account.input.media.map(item => item.selectionId),
                v29AccountContext: 'uncertain' as const,
            },
            source: 'checkpoint' as const,
        })));
        const runScheduler = vi.fn(async (options: AnalysisV2SchedulerRuntimeOptions<unknown>) => ({
            status: 'completed' as const,
            completed: await Promise.all(options.tasks.map(async task => ({
                key: task.key,
                stage: task.stage,
                value: await task.run(),
            }))),
            remainingKeys: [],
            recoveryPendingKeys: [],
            terminalUnavailableKeys: [],
            continuationDelayMs: 1_000,
        }));
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runGenderMicrobatch,
            runScheduler: runScheduler as typeof import('./v2-ai-scheduler-runtime')
                .runAnalysisV2FairAiScheduler,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(), commitReady: vi.fn(),
            })) as typeof import('./v2-ai-scheduler-operation-store')
                .createAnalysisV2SchedulerOperationStore,
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(), onBeforeAttempt: vi.fn(), onAttemptTelemetry: vi.fn(),
            })),
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V210_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };
        const input = (suffix: string) => ({ media: [{
            selectionId: `profile:${suffix}`,
            kind: 'profile' as const,
            normalizedJpegBase64: '/9j/2Q==',
        }] });

        await Promise.all([
            runtime.gender(input('first'), scheduledFence),
            runtime.gender(input('second'), scheduledFence),
        ]);

        expect(runScheduler).toHaveBeenCalledOnce();
        expect(runGenderMicrobatch).toHaveBeenCalledOnce();
        const call = runGenderMicrobatch.mock.calls[0] as unknown as [
            unknown,
            unknown,
            { aiStagePolicyVersion?: string },
        ];
        expect(call[2]).toEqual({
            aiStagePolicyVersion: AI_STAGE_POLICY_V210_VERSION,
        });
    });

    it('uses one audited v2.9 Gemini batch for two concurrent accounts and no individual calls', async () => {
        const runGender = vi.fn();
        const runGenderMicrobatch = vi.fn(async accounts => accounts.map((account: {
            accountId: string;
            input: GenderTriageInput;
        }) => ({
            accountId: account.accountId,
            source: 'checkpoint' as const,
            result: {
                assessment: {
                    inferredGender: 'female' as const,
                    confidence: 'high' as const,
                    ownerConsistency: 'same_person' as const,
                    evidenceSelectionIds: account.input.media.map(item => item.selectionId),
                },
                routingDecision: 'route_to_feature_analysis' as const,
                routingReason: 'conserve_female_recall' as const,
                analyzedSelectionIds: account.input.media.map(item => item.selectionId),
                v29AccountContext: 'personal' as const,
            },
        })));
        const schedulerCalls: AnalysisV2SchedulerRuntimeOptions<unknown>[] = [];
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runGender,
            runGenderMicrobatch: runGenderMicrobatch as never,
            runScheduler: vi.fn(async (options: AnalysisV2SchedulerRuntimeOptions<unknown>) => {
                schedulerCalls.push(options);
                const completed = await Promise.all(options.tasks.map(async item => ({
                    key: item.key,
                    stage: item.stage,
                    value: await item.run(),
                })));
                return {
                    status: 'completed' as const,
                    completed,
                    remainingKeys: [],
                    recoveryPendingKeys: [],
                    terminalUnavailableKeys: [],
                    continuationDelayMs: 1_000,
                };
            }) as never,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(), commitReady: vi.fn(),
            })) as never,
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(),
                onBeforeAttempt: vi.fn(),
                onAttemptTelemetry: vi.fn(),
            })),
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V29_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };
        const media = (suffix: string) => ({ media: [{
            selectionId: `profile:${suffix}`,
            kind: 'profile' as const,
            normalizedJpegBase64: '/9j/2Q==',
        }, {
            selectionId: `post:${suffix}`,
            kind: 'feed' as const,
            normalizedJpegBase64: '/9j/2g==',
            postId: `post:${suffix}`,
        }] });

        const [first, second] = await Promise.all([
            runtime.gender(media('first'), scheduledFence),
            runtime.gender(media('second'), scheduledFence),
        ]);

        expect(runGender).not.toHaveBeenCalled();
        expect(runGenderMicrobatch).toHaveBeenCalledTimes(1);
        expect(runGenderMicrobatch.mock.calls[0]![0]).toHaveLength(2);
        expect(schedulerCalls).toHaveLength(1);
        expect(schedulerCalls[0]!.tasks).toHaveLength(1);
        expect(first.operationKey).toBe(second.operationKey);
        expect(first.resultHash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('coalesces duplicate v2.9 gender members before the one durable batch operation', async () => {
        const runGenderMicrobatch = vi.fn(async accounts => accounts.map((account: {
            accountId: string;
            input: GenderTriageInput;
        }) => ({
            accountId: account.accountId,
            source: 'checkpoint' as const,
            result: {
                assessment: {
                    inferredGender: 'female' as const,
                    confidence: 'high' as const,
                    ownerConsistency: 'same_person' as const,
                    evidenceSelectionIds: account.input.media.map(item => item.selectionId),
                },
                routingDecision: 'route_to_feature_analysis' as const,
                routingReason: 'conserve_female_recall' as const,
                analyzedSelectionIds: account.input.media.map(item => item.selectionId),
                v29AccountContext: 'personal' as const,
            },
        })));
        const schedulerCalls: AnalysisV2SchedulerRuntimeOptions<unknown>[] = [];
        const runtime = createDurableAnalysisV2AiStageRuntime({
            runGenderMicrobatch: runGenderMicrobatch as never,
            runScheduler: vi.fn(async (options: AnalysisV2SchedulerRuntimeOptions<unknown>) => {
                schedulerCalls.push(options);
                const completed = await Promise.all(options.tasks.map(async item => ({
                    key: item.key,
                    stage: item.stage,
                    value: await item.run(),
                })));
                return {
                    status: 'completed' as const,
                    completed,
                    remainingKeys: [],
                    recoveryPendingKeys: [],
                    terminalUnavailableKeys: [],
                    continuationDelayMs: 1_000,
                };
            }) as never,
            createSchedulerOperationStore: vi.fn(() => ({
                claim: vi.fn(), commitReady: vi.fn(),
            })) as never,
            createAudit: vi.fn(options => ({
                requestId: options.requestId,
                operationKey: options.resultIdentity.operationKey,
                resultIdentity: options.resultIdentity,
                resultSchema: options.resultSchema,
                prepare: vi.fn(),
                onBeforeAttempt: vi.fn(),
                onAttemptTelemetry: vi.fn(),
            })),
        });
        const scheduledFence = {
            ...fence,
            aiStagePolicyVersion: AI_STAGE_POLICY_V29_VERSION,
            schedulerCapability: 'scheduler-v1' as const,
            handlerDeadlineAtMs: performance.now() + 300_000,
        };
        const duplicateInput: GenderTriageInput = { media: [{
            selectionId: 'profile:duplicate',
            kind: 'profile',
            normalizedJpegBase64: '/9j/2Q==',
        }] };

        const [first, second] = await Promise.all([
            runtime.gender(duplicateInput, scheduledFence),
            runtime.gender(duplicateInput, scheduledFence),
        ]);

        expect(runGenderMicrobatch).toHaveBeenCalledTimes(1);
        expect(runGenderMicrobatch.mock.calls[0]![0]).toHaveLength(1);
        expect(schedulerCalls).toHaveLength(1);
        expect(schedulerCalls[0]!.tasks).toHaveLength(1);
        expect(first.operationKey).toBe(second.operationKey);
        expect(first.resultHash).toBe(second.resultHash);
    });
});
